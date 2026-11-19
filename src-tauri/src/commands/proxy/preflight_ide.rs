use std::collections::HashSet;
use std::path::Path;
use super::*;
use super::health_probes::*;
use super::commands_and_cleanup::kill_sidecar_process;

pub(super) fn check_ide_routes_and_ports(
    target: &str,
    config_dir: &Path,
    resources_root: Option<&Path>,
    ports: crate::commands::config::ConfiguredProxyPorts,
    proxy_value: &str,
    scope: RepairScope,
    now_ms: u64,
    issues: &mut Vec<ProxyPreflightIssue>,
) {
    let _ = now_ms;
    let ide_label = match target {
        "devin" => "Devin",
        "cursor" => "Cursor",
        _ => "Windsurf",
    };
    let ide_exe_path = crate::commands::system::detect_ide_path(Some(target.to_string()));
    let settings_display = crate::commands::ide_config::settings_path(&target)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "未定位".into());
    push_issue(
        issues,
        "ok",
        "ide.target",
        format!(
            "目标 IDE: {}；配置文件: {}；程序路径: {}",
            ide_label,
            settings_display,
            ide_exe_path.clone().unwrap_or_else(|| "未定位".into())
        ),
    );
    if target != "cursor" {
        let other_target = if target == "devin" {
            "windsurf"
        } else {
            "devin"
        };
        let other_label = if other_target == "devin" {
            "Devin"
        } else {
            "Windsurf"
        };
        if !crate::commands::system::is_ide_running_sync(target.to_string())
            && crate::commands::system::is_ide_running_sync(other_target.into())
        {
            push_issue(
                issues,
                "warn",
                "ide.target_mismatch",
                format!(
                    "当前选择的是 {}，但检测到正在运行的是 {}。如果你实际使用 {}，请先切换顶部 IDE 选择器再启动网关",
                    ide_label, other_label, other_label
                ),
            );
        }
    }

    let settings_candidate = match crate::commands::ide_config::settings_path(&target) {
        Some(settings) if settings.exists() => Some(settings),
        Some(settings) if scope.repairs_config() => {
            if ide_exe_path.is_some() {
                match crate::commands::ide_config::ensure_settings_file(&target) {
                    Ok((path, true)) => {
                        push_issue(
                            issues,
                            "ok",
                            "ide_settings.auto_created",
                            format!(
                                "已自动创建 {} settings.json: {}",
                                ide_label,
                                path.to_string_lossy()
                            ),
                        );
                        Some(path)
                    }
                    Ok((path, false)) => Some(path),
                    Err(e) => {
                        push_issue(
                            issues,
                            "err",
                            "ide_settings.create_failed",
                            format!("自动创建 {} settings.json 失败: {}", ide_label, e),
                        );
                        Some(settings)
                    }
                }
            } else {
                Some(settings)
            }
        }
        other => other,
    };
    match settings_candidate {
        Some(settings) if settings.exists() => {
            if settings
                .metadata()
                .map(|m| m.permissions().readonly())
                .unwrap_or(false)
            {
                push_issue(
                    issues,
                    "err",
                    "ide_settings.readonly",
                    format!("{} settings.json 是只读文件，无法写入网关接入配置", ide_label),
                );
            }
            match std::fs::read_to_string(&settings) {
                Ok(raw) => match crate::commands::ide_config::parse_object(&raw) {
                    Ok(obj) => {
                        let proxy = obj.get("http.proxy").and_then(|v| v.as_str()).unwrap_or("");
                        let strict_ssl = obj.get("http.proxyStrictSSL");
                        if !proxy.is_empty() && !crate::commands::ide_config::is_current_proxy_value(proxy) {
                            push_issue(
                                issues,
                                "warn",
                                "ide_settings.other_proxy",
                                format!(
                                    "{} 当前已有 http.proxy={}，切换到网关时会备份并改写为 AnyBridge 网关（{}）",
                                    ide_label, proxy, proxy_value
                                ),
                            );
                        }
                        if crate::commands::ide_config::is_current_proxy_value(proxy)
                            && strict_ssl != Some(&serde_json::Value::Bool(false))
                        {
                            if scope.repairs_config() {
                                match crate::commands::ide_config::patch(&target) {
                                    Ok(_) => push_issue(
                                        issues,
                                        "ok",
                                        "ide_settings.strict_ssl_fixed",
                                        format!("已自动修正 {} http.proxyStrictSSL 为 false", ide_label),
                                    ),
                                    Err(e) => push_issue(
                                        issues,
                                        "err",
                                        "ide_settings.strict_ssl_fix_failed",
                                        format!("自动修正 {} http.proxyStrictSSL 失败: {}", ide_label, e),
                                    ),
                                }
                            } else {
                                push_issue(
                                    issues,
                                    "warn",
                                    "ide_settings.strict_ssl",
                                    format!(
                                        "{} 已指向 AnyBridge 网关，但 http.proxyStrictSSL 不是 false，切换到网关时会修正",
                                        ide_label
                                    ),
                                );
                            }
                        }
                        let backup = settings_backup_path(&settings);
                        if backup.exists() && !crate::commands::ide_config::is_current_proxy_value(proxy) {
                            push_issue(
                                issues,
                                "warn",
                                "ide_settings.backup_exists",
                                format!(
                                    "{} 存在旧备份文件，将沿用它做还原直连时的还原基准",
                                    backup.to_string_lossy()
                                ),
                            );
                        }
                    }
                    Err(e) => push_issue(
                        issues,
                        "err",
                        "ide_settings.parse_failed",
                        format!("{} settings.json 解析失败: {}", ide_label, e),
                    ),
                },
                Err(e) => push_issue(
                    issues,
                    "err",
                    "ide_settings.read_failed",
                    format!("读取 {} settings.json 失败: {}", ide_label, e),
                ),
            }
        }
        Some(settings) => push_issue(
            issues,
            "err",
            "ide_settings.missing",
            format!(
                "未找到 {} settings.json: {}。请先启动一次 {}，或在「平台 > 设置」手动指定 IDE 路径后再切换到网关",
                ide_label,
                settings.to_string_lossy(),
                ide_label
            ),
        ),
        None => push_issue(
            issues,
            "err",
            "ide_settings.path_failed",
            format!("无法定位 {} 配置目录", ide_label),
        ),
    }

    if crate::commands::system::is_ide_running_sync(target.to_string()) {
        push_issue(
            issues,
            "warn",
            "ide.running",
            format!(
                "{} 正在运行；启动后必须重启 IDE 才能加载网关配置和模型改写",
                ide_label
            ),
        );
    }

    if target == "cursor" {
        match crate::commands::cursor_auth::cursor_state_db_path() {
            Some(path) if path.exists() => push_issue(
                issues,
                "ok",
                "cursor.state_db",
                format!("Cursor state.vscdb 已定位: {}", path.to_string_lossy()),
            ),
            Some(path) => push_issue(
                issues,
                "err",
                "cursor.state_db_missing",
                format!(
                    "未找到 Cursor state.vscdb: {}。请先启动一次 Cursor 到主界面后再切换",
                    path.to_string_lossy()
                ),
            ),
            None => push_issue(
                issues,
                "err",
                "cursor.state_db_path_failed",
                "无法定位 Cursor state.vscdb 路径",
            ),
        }
        let cursor_models = crate::commands::proxy_routes::read_routes()
            .map(|routes| {
                routes.routes
                    .into_iter()
                    .filter(|route| {
                        route.enabled
                            && !route.targets.is_empty()
                            && route
                                .exposed_formats
                                .iter()
                                .any(|format| format.eq_ignore_ascii_case("openai"))
                    })
                    .count()
            })
            .unwrap_or(0);
        if cursor_models > 0 {
            push_issue(
                issues,
                "ok",
                "cursor.models",
                format!("Cursor Core 可同步 {} 个本地模型", cursor_models),
            );
        } else {
            push_issue(
                issues,
                "err",
                "cursor.models_missing",
                "未配置可供 Cursor Core 使用的 OpenAI 格式模型",
            );
        }
        push_issue(
            issues,
            "ok",
            "workbench.skipped",
            "Cursor 接入不需要 workbench.html 模型卡片注入",
        );
    } else {
        match crate::commands::workbench_inject::workbench_html_path(&target) {
            Some(path) => {
                if std::fs::OpenOptions::new().write(true).open(&path).is_err() {
                    push_issue(
                        issues,
                        "warn",
                        "workbench.not_writable",
                        format!(
                            "无法写入 workbench.html，模型卡片视觉改写可能失败: {}",
                            path.to_string_lossy()
                        ),
                    );
                }
            }
            None => push_issue(
                issues,
                "warn",
                "workbench.missing",
                format!(
                    "未定位到 {} workbench.html，模型卡片视觉改写脚本可能无法注入",
                    ide_label
                ),
            ),
        }

        if let Some(res) = resources_root.as_deref() {
            let script = res.join("byok-cards.js");
            if !script.exists() {
                push_issue(
                    issues,
                    "warn",
                    "resources.cards_missing",
                    format!("未找到 byok-cards.js 资源: {}", script.to_string_lossy()),
                );
            }
        }
    }

    let store = match crate::commands::config::read_provider_store() {
        Ok(store) => store,
        Err(e) => {
            push_issue(
                issues,
                "err",
                "providers.read_failed",
                format!("读取供应商配置失败: {}", e),
            );
            crate::commands::config::ProviderStore::default()
        }
    };
    if store.providers.is_empty() {
        push_issue(
            issues,
            "err",
            "providers.empty",
            "尚未配置任何供应商，网关没有可路由的 BYOK 目标",
        );
    }

    let map = match crate::commands::model_map::read_map() {
        Ok(map) => map,
        Err(e) => {
            push_issue(
                issues,
                "err",
                "model_map.read_failed",
                format!("读取模型映射失败: {}", e),
            );
            crate::commands::model_map::ModelMap::default()
        }
    };

    let mut seen_uids = HashSet::new();
    let mut routed_count = 0usize;
    let name_prefix = map.name_prefix.trim();

    for slot in &map.slots {
        let uid = slot.model_uid.trim();
        let label = if slot.display_name.trim().is_empty() {
            uid.to_string()
        } else {
            slot.display_name.trim().to_string()
        };
        if uid.is_empty() {
            push_issue(
                issues,
                "err",
                "model_map.slot_uid_empty",
                "存在空 modelUid 的映射槽位",
            );
            continue;
        }
        if !seen_uids.insert(uid.to_string()) {
            push_issue(
                issues,
                "err",
                "model_map.uid_duplicate",
                format!("modelUid 重复: {}", uid),
            );
        }
        if !slot.enabled {
            continue;
        }
        if slot.targets.is_empty() {
            push_issue(
                issues,
                "err",
                "model_map.slot_target_empty",
                format!("「{}」已启用但未配置目标供应商", label),
            );
            continue;
        }
        if slot.display_name.trim().is_empty() && name_prefix.is_empty() {
            push_issue(
                issues,
                "warn",
                "model_map.slot_no_visible_name",
                format!(
                    "「{}」未设置显示名或全局前缀，IDE 下拉框仍会显示原始 Windsurf 名称",
                    uid
                ),
            );
        }
        for target in &slot.targets {
            if check_provider_route(
                issues,
                &label,
                &target.provider_id,
                Some(&target.model),
                &store,
            ) {
                routed_count += 1;
            }
        }
    }

    for inj in &map.injected {
        let uid = inj.model_uid.trim();
        if uid.is_empty() {
            push_issue(
                issues,
                "err",
                "model_map.inject_uid_empty",
                "存在空 modelUid 的模型槽位",
            );
            continue;
        }
        if !seen_uids.insert(uid.to_string()) {
            push_issue(
                issues,
                "err",
                "model_map.uid_duplicate",
                format!("modelUid 重复: {}", uid),
            );
        }

        let provider_id = inj.provider_id.as_deref().unwrap_or("").trim();
        if provider_id.is_empty() {
            push_issue(
                issues,
                "warn",
                "model_map.inject_unconfigured",
                format!(
                    "模型槽位「{}」尚未配置供应商，可能会显示但无法调用",
                    inj.label
                ),
            );
            continue;
        }
        if inj.model.as_deref().unwrap_or("").trim().is_empty() {
            push_issue(
                issues,
                "err",
                "model_map.inject_model_empty",
                format!("模型槽位「{}」已选供应商但 model 为空", inj.label),
            );
        }
        if check_provider_route(
            issues,
            &format!("模型槽位「{}」", inj.label),
            provider_id,
            inj.model.as_deref(),
            &store,
        ) {
            routed_count += 1;
        }
    }

    if routed_count == 0 {
        push_issue(
            issues,
            "err",
            "model_map.no_route",
            "没有任何可用模型：请至少给一个启用槽位配置供应商和目标模型",
        );
    }

    match load_cached_ide_model_uids(&config_dir) {
        Ok(Some((cached_uids, source, captured_at))) => {
            if cached_uids.is_empty() {
                push_issue(
                    issues,
                    "warn",
                    "ide_models.empty_cache",
                    "缓存的 IDE 模型清单为空，无法判断映射槽位是否会出现在 IDE 下拉框。请启动网关后重启 IDE 并打开一次模型选择器",
                );
            } else {
                if source != "captured" {
                    push_issue(
                        issues,
                        "warn",
                        "ide_models.not_proxy_captured",
                        format!(
                            "缓存的 IDE 模型清单来源为 {}（非网关实时抓取），不一定等于 IDE 实际下拉框；如模型不可见，请启动网关后重启 IDE 并打开一次模型选择器",
                            source
                        ),
                    );
                }
                if let Some(ts) = captured_at {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if now.saturating_sub(ts) > 7 * 24 * 60 * 60 * 1000 {
                        push_issue(
                            issues,
                            "warn",
                            "ide_models.stale_cache",
                            "最近抓取的 IDE 模型清单已超过 7 天，建议启动网关后重启 IDE 重新抓取",
                        );
                    }
                }
                for slot in map
                    .slots
                    .iter()
                    .filter(|s| s.enabled && !s.targets.is_empty())
                {
                    if !cached_uids.contains(&slot.model_uid) {
                        push_issue(
                            issues,
                            "warn",
                            "ide_models.slot_not_seen",
                            format!(
                                "最近抓到的 IDE 模型清单里没有「{}」，这个映射可能不会出现在下拉框",
                                slot.model_uid
                            ),
                        );
                    }
                }
                for inj in map
                    .injected
                    .iter()
                    .filter(|i| i.provider_id.as_deref().unwrap_or("").trim().len() > 0)
                {
                    if !cached_uids.contains(&inj.model_uid) {
                        push_issue(
                            issues,
                            "warn",
                            "ide_models.inject_not_seen",
                            format!(
                                "最近抓到的 IDE 模型清单里没有模型槽位「{}」({})，可能需要先更新/重新抓取 IDE 模型列表",
                                inj.label, inj.model_uid
                            ),
                        );
                    }
                }
            }
        }
        Ok(None) => push_issue(
            issues,
            "warn",
            "ide_models.cache_missing",
            "尚未抓取 IDE 模型清单；首次启动后请重启 IDE 并打开模型选择器，网关会记录真实可见模型",
        ),
        Err(e) => push_issue(issues, "warn", "ide_models.cache_read_failed", e),
    }

    // ─── 接管心跳：IDE 的流量到底有没有进网关 ───
    // 判据不是「配置写了没」而是「网关有没有收到该 IDE 的模型请求」。
    // 这一条是模型下拉框会不会被改写的唯一可靠依据，也是用户「配了却看不到模型」的根因所在。
    let target_label = match target {
        "devin" => "Devin",
        "cursor" => "Cursor",
        _ => "Windsurf",
    };
    // 心跳只覆盖 MITM/hybrid 通道（Windsurf / Devin）。Cursor 走 cursor-core 独立通道、
    // Antigravity 走自己的端点，都不经过这个网关，套用心跳会误报「接管未生效」。
    let takeover_supported = matches!(target, "devin" | "windsurf");
    if !takeover_supported {
        // 不做判定，也不产生误导性提示
    } else if !is_port_free(ports.api_port) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        match read_takeover_state(&config_dir) {
            Ok(Some(state)) => {
                let since_start = state
                    .proxy_started_at
                    .map(|ts| now_ms.saturating_sub(ts))
                    .unwrap_or(TAKEOVER_WARMUP_MS);
                match state.last_ide_request_at {
                    Some(ts) if now_ms.saturating_sub(ts) <= TAKEOVER_FRESH_WINDOW_MS => {
                        push_issue(
                            issues,
                            "ok",
                            "takeover.active",
                            format!(
                                "IDE 接管已生效：{} 秒前收到 {} 的模型请求，模型下拉框会被改写。",
                                now_ms.saturating_sub(ts) / 1000,
                                target_label
                            ),
                        );
                    }
                    _ if since_start < TAKEOVER_WARMUP_MS => {
                        push_issue(
                            issues,
                            "warn",
                            "takeover.waiting",
                            format!(
                                "网关刚启动，还在等待 {} 的模型请求。请重启 {} 并打开一次模型选择器。",
                                target_label, target_label
                            ),
                        );
                    }
                    other => {
                        let detail = match other {
                            Some(ts) => format!(
                                "（最后一次是 {} 分钟前）",
                                now_ms.saturating_sub(ts) / 60000
                            ),
                            None => String::new(),
                        };
                        push_issue(
                            issues,
                            "err",
                            "takeover.not_active",
                            format!(
                                "IDE 接管未生效{}：网关启动后没有收到 {} 的模型请求，模型下拉框不会被改写。原因几乎都是 {} 在写入网关接入配置之后没有重启（macOS 必须 Cmd+Q 完全退出，关窗口不算）。请在「平台 > 设置 > 环境检测」点「重启 IDE」。",
                                detail, target_label, target_label
                            ),
                        );
                    }
                }
            }
            Ok(None) => push_issue(
                issues,
                "err",
                "takeover.no_state",
                format!(
                    "网关正在运行，但还没有任何接管记录。请重启 {} 让网关配置生效，然后打开一次模型选择器。",
                    target_label
                ),
            ),
            Err(e) => push_issue(issues, "err", "takeover.state_read_failed", e),
        }
    } else {
        push_issue(
            issues,
            "warn",
            "takeover.proxy_stopped",
            "网关未运行，无法判断 IDE 是否已接管。请先启动网关，再重启 IDE。",
        );
    }

    for port in unique_proxy_ports(ports) {
        if !is_port_free(port) {
            if scope.repairs_config() {
                kill_sidecar_process();
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            if !is_port_free(port) {
                push_issue(
                    issues,
                    if scope.repairs_config() { "err" } else { "warn" },
                    "port.occupied",
                    format!(
                        "端口 {} 已被占用，自动回收旧网关后仍不可用；请关闭占用该端口的进程后重试",
                        port
                    ),
                );
            } else {
                push_issue(
                    issues,
                    "ok",
                    "port.recovered",
                    format!("端口 {} 已自动回收并恢复可用", port),
                );
            }
        }
    }

}
