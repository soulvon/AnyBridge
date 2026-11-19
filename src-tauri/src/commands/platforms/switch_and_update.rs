use crate::commands::config::{read_provider_store, PlatformState};
use std::fs;
use tauri::AppHandle;

use super::claude::apply_claude_config_file_with_providers;
use super::codex::{
    apply_codex_auto_wire_api, legacy_global_codex_proxy_route_cleanup_warning,
    plan_clear_codex_proxy_routes, plan_clear_codex_proxy_routes_into,
    plan_clear_legacy_global_codex_proxy_routes, plan_codex_proxy_routes,
    plan_codex_proxy_routes_into, repair_codex_session_visibility_message,
};
use super::common::{
    append_switch_warnings, backup_path, emit_switch_progress, ensure_backup, now_epoch_secs,
    resolve_platform_config, PlatformUpdateInfo, SwitchResult,
};
use super::detect::invalidate_detect_cache;
use super::opencode::apply_opencode_config_file_with_providers;
use super::platform_enum::Platform;


/// 同平台更新互斥：连点/多入口触发会让两个 npm install 同时改同一个全局目录，
/// 轻则竞态失败，重则把安装写坏。按平台 id 加在途集合。
pub(in crate::commands::platforms) static UPDATE_INFLIGHT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();


pub(in crate::commands::platforms) fn update_inflight_set() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    UPDATE_INFLIGHT.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}


/// 锁中毒不致命：取回内部数据继续用，避免一次 panic 后整块功能永久不可用。
pub(in crate::commands::platforms) fn begin_update(id: &str) -> Result<(), String> {
    let mut guard = update_inflight_set()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.insert(id.to_string()) {
        return Err(format!("{id} 正在更新中，请等待本次完成"));
    }
    Ok(())
}


pub(in crate::commands::platforms) fn end_update(id: &str) {
    if let Ok(mut guard) = update_inflight_set().lock() {
        guard.remove(id);
    }
}


pub(in crate::commands::platforms) async fn update_platform_agent_inner(platform: String) -> Result<PlatformUpdateInfo, String> {
    let resolved_id = Platform::from_id(&platform)
        .map(|p| p.id().to_string())
        .unwrap_or_else(|| platform.clone());

    // 更新前基线：回滚与「是否真的前进」的判据都靠它（探测自带 10s 超时）
    let before = {
        let id = resolved_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::version_probe::installed_version(&id)
        })
        .await
        .map_err(|e| format!("版本探测任务执行失败: {e}"))?
    };

    // ① 官方自更新命令优先（如 `claude update`）。
    //
    // 原因（实测）：claude 同时存在官方安装器版（~/.local/bin/claude.exe，
    // PATH 优先）与 npm 全局版。只跑 npm install -g 升级的是另一份，验证时
    // 读到的仍是官方版旧版本，于是误报「更新失败」。官方命令知道自己是哪种
    // 安装方式，交给它最可靠。
    if let Some(spec) = crate::commands::agent_spec::find(&resolved_id) {
        if let Some(su) = spec.self_update {
            if let Some(bin) = spec.bin {
                let id_for_update = resolved_id.clone();
                let args: Vec<&str> = su.subcommand.to_vec();
                // 失败提示里给用户可手动执行的命令（args 稍后被闭包 move，先算好）
                let official_cmd = format!("{} {}", bin, args.join(" "));
                let env: Vec<(String, String)> = su
                    .env
                    .map(|pairs| {
                        pairs
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                tauri::async_runtime::spawn_blocking(move || {
                    let env_refs: Vec<(&str, &str)> =
                        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                    crate::commands::version_probe::run_self_update_sync(
                        bin,
                        &args,
                        if env_refs.is_empty() { None } else { Some(&env_refs) },
                        &id_for_update,
                    )
                })
                .await
                .map_err(|e| format!("更新任务执行失败: {e}"))??;

                crate::commands::version_probe::invalidate_version_cache(&resolved_id);
                let current_version = crate::commands::version_probe::installed_version(&resolved_id);
                // latest 复测与 check_platform_update 同源：npm 包走 registry，
                // 无 npm 包的自更新平台（grok 官方 CLI）走官方版本通道——
                // 否则 latest 恒 None → has_update 恒 false，更新完成后
                // 前端无从判断「已是最新」，按钮状态收不了尾
                let latest_version = match spec.npm_package {
                    Some(pkg) => crate::commands::version_probe::npm_latest_version(pkg).await,
                    None => match spec.latest_channel {
                        Some(urls) => crate::commands::version_probe::channel_latest_version(urls).await,
                        None => None,
                    },
                };
                let has_update = match (&latest_version, &current_version) {
                    (Some(l), Some(c)) => crate::commands::version_probe::is_newer(l, c),
                    _ => false,
                };
                // 硬校验：官方命令退出 0 ≠ 更新成功。
                // ① 二进制必须还能启动（下到一半的二进制会让 CLI 直接不可用）
                // ② 版本不得倒退（比更新前更旧 = 异常，必须报出来）
                if !crate::commands::version_probe::cli_binary_runs(&resolved_id) {
                    return Err(format!(
                        "官方更新命令已执行，但 {bin} 无法启动（二进制可能损坏）。请到终端重跑：{official_cmd}"
                    ));
                }
                if let (Some(b), Some(c)) = (&before, &current_version) {
                    if crate::commands::version_probe::is_newer(b, c) {
                        return Err(format!(
                            "更新后版本倒退：v{b} → v{c}（异常）。请到终端重跑：{official_cmd}"
                        ));
                    }
                }
                let outcome = if current_version.as_deref() != before.as_deref() {
                    "upgraded"
                } else {
                    "unchanged"
                };
                invalidate_detect_cache();
                return Ok(PlatformUpdateInfo {
                    platform: resolved_id,
                    installed: current_version.is_some(),
                    current_version,
                    latest_version,
                    has_update,
                    npm_package: spec.npm_package.map(|p| p.to_string()),
                    has_self_update: true,
                    can_auto_update: true,
                    updated_from: before,
                    outcome,
                });
            }
        }
    }

    // ② 回退：npm 全局安装（内置平台与声明表新增的 agent 都支持）
    let (plat_id, npm_package) = match Platform::from_id(&platform) {
        Some(plat) => {
            let pkg = crate::commands::version_probe::cli_spec(plat.id())
                .and_then(|s| s.npm_package.map(|p| p.to_string()))
                .ok_or_else(|| format!("{} 暂不支持在线更新", plat.display_name()))?;
            (plat.id().to_string(), pkg)
        }
        None => {
            let spec = crate::commands::agent_spec::find(&platform)
                .ok_or_else(|| format!("{platform} 为 GUI 客户端，暂不支持在线更新（请从官网下载新版）"))?;
            let pkg = spec
                .npm_package
                .map(|p| p.to_string())
                .ok_or_else(|| format!("{} 暂不支持在线更新", spec.name))?;
            (spec.id.to_string(), pkg)
        }
    };

    // 1. 查最新版本（async，主协程）
    let target_version = crate::commands::version_probe::npm_latest_version(&npm_package)
        .await
        .ok_or_else(|| "无法获取最新版本号（网络不可达），请稍后重试".to_string())?;

    // 2. 执行更新（sync 重活 → spawn_blocking）
    let pkg_for_update = npm_package.clone();
    let plat_id_for_update = plat_id.clone();
    let target_for_update = target_version.clone();
    let update_result = tauri::async_runtime::spawn_blocking(move || {
        crate::commands::version_probe::update_npm_package_sync(
            &pkg_for_update,
            &plat_id_for_update,
            &target_for_update,
        )
    })
    .await
    .map_err(|e| format!("更新任务执行失败: {e}"))?;

    // 硬校验失败（版本没到位 / 二进制起不来）→ 回滚到更新前版本：
    // 更新不能把 CLI 变成不可用，最坏情况是「停在原来的版本」
    if let Err(update_err) = update_result {
        let Some(prev) = before.clone() else {
            return Err(format!(
                "{update_err}（无原版本可回滚，请手动执行：npm install -g {npm_package}@{target_version}）"
            ));
        };
        let rb_pkg = npm_package.clone();
        let rb_id = plat_id.clone();
        let rb_ver = prev.clone();
        let rolled = tauri::async_runtime::spawn_blocking(move || {
            crate::commands::version_probe::update_npm_package_sync(&rb_pkg, &rb_id, &rb_ver)
        })
        .await
        .map_err(|e| format!("回滚任务执行失败: {e}"))?;
        crate::commands::version_probe::invalidate_version_cache(&plat_id);
        if rolled.is_ok() && crate::commands::version_probe::cli_binary_runs(&plat_id) {
            let restored = crate::commands::version_probe::installed_version(&plat_id);
            let latest_version = crate::commands::version_probe::npm_latest_version(&npm_package).await;
            let has_update = match (&latest_version, &restored) {
                (Some(l), Some(c)) => crate::commands::version_probe::is_newer(l, c),
                _ => false,
            };
            invalidate_detect_cache();
            let can_auto_update = crate::commands::version_probe::npm_install_capability();
            let has_self_update = crate::commands::agent_spec::find(&plat_id)
                .map(|s| s.self_update.is_some())
                .unwrap_or(false);
            return Ok(PlatformUpdateInfo {
                platform: plat_id,
                installed: restored.is_some(),
                current_version: restored,
                latest_version,
                has_update,
                npm_package: Some(npm_package),
                has_self_update,
                can_auto_update,
                updated_from: Some(prev),
                outcome: "rolled_back",
            });
        }
        return Err(format!(
            "{update_err}；回滚到 v{prev} 也未成功，请手动执行：npm install -g {npm_package}@{prev}"
        ));
    }

    // 3. 验证 + 组装结果（latest 缓存仍是刚才查的，直接复用）
    crate::commands::version_probe::invalidate_version_cache(&plat_id);
    let current_version = crate::commands::version_probe::installed_version(&plat_id);
    let latest_version = crate::commands::version_probe::npm_latest_version(&npm_package).await;
    let has_update = match (&latest_version, &current_version) {
        (Some(l), Some(c)) => crate::commands::version_probe::is_newer(l, c),
        _ => false,
    };
    let outcome = if current_version.as_deref() != before.as_deref() {
        "upgraded"
    } else {
        "unchanged"
    };

    invalidate_detect_cache();
    let can_auto_update = crate::commands::version_probe::npm_install_capability();
    let has_self_update = crate::commands::agent_spec::find(&plat_id)
        .map(|s| s.self_update.is_some())
        .unwrap_or(false);
    Ok(PlatformUpdateInfo {
        platform: plat_id,
        installed: current_version.is_some(),
        current_version,
        latest_version,
        has_update,
        npm_package: Some(npm_package),
        has_self_update,
        can_auto_update,
        updated_from: before,
        outcome,
    })
}


pub(in crate::commands::platforms) fn switch_platform_sync(
    app: &AppHandle,
    platform: &str,
    provider_id: &str,
) -> Result<SwitchResult, String> {
    let plat = Platform::from_id(platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    if matches!(plat, Platform::ClaudeDesktop) {
        emit_switch_progress(
            app,
            plat.id(),
            "writing",
            "正在写入 Claude Desktop 路由配置…",
        );
        let store = read_provider_store()?;
        let bindings = if let Some(cfg) = store
            .claude_desktop_configs
            .iter()
            .find(|c| c.id == provider_id)
        {
            cfg.validate_active_source(&store.providers)?;
            Some(crate::commands::proxy_routes::ClaudeDesktopBindings {
                sonnet: cfg.sonnet_model.clone(),
                opus: cfg.opus_model.clone(),
                haiku: cfg.haiku_model.clone(),
                fable: cfg.fable_model.clone(),
                sonnet_name: cfg.sonnet_name.clone(),
                opus_name: cfg.opus_name.clone(),
                haiku_name: cfg.haiku_name.clone(),
                fable_name: cfg.fable_name.clone(),
            })
        } else {
            None
        };
        let res = crate::commands::claude_desktop::apply_claude_desktop_sync(bindings)?;
        let plat_key = plat.id().to_string();
        let prov_id = provider_id.to_string();
        crate::commands::store_io::update_provider_store(|store| {
            store.platforms.insert(
                plat_key,
                PlatformState {
                    provider_id: prov_id,
                    applied_at: now_epoch_secs(),
                },
            );
            Ok((true, ()))
        })?;
        emit_switch_progress(app, plat.id(), "done", "切换完成");
        return Ok(res);
    }
    emit_switch_progress(app, plat.id(), "reading", "正在读取供应商配置…");
    let mut store = read_provider_store()?;

    if matches!(plat, Platform::ClaudeCode) {
        let config = store
            .claude_code_configs
            .iter()
            .find(|config| config.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("Claude Code 配置不存在: {provider_id}"))?;
        config.validate_active_source(&store.providers)?;
        let path = plat
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;
        emit_switch_progress(app, plat.id(), "backup", "正在备份原配置文件…");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        ensure_backup(&path)?;
        emit_switch_progress(app, plat.id(), "writing", "正在写入 Claude Code 配置…");
        apply_claude_config_file_with_providers(&path, &config, &store.providers)?;

        let config_path = path.to_string_lossy().to_string();
        let backup = backup_path(&path).to_string_lossy().to_string();
        emit_switch_progress(app, plat.id(), "saving", "正在保存接管状态…");
        let plat_key = plat.id().to_string();
        let cfg_id = config.id.clone();
        crate::commands::store_io::update_provider_store(|s| {
            s.platforms.insert(
                plat_key,
                PlatformState {
                    provider_id: cfg_id,
                    applied_at: now_epoch_secs(),
                },
            );
            Ok((true, ()))
        })?;
        emit_switch_progress(app, plat.id(), "done", "切换完成");

        return Ok(SwitchResult {
            ok: true,
            message: format!(
                "已将 Claude Code 切换到「{}」，重启 Claude Code 后生效",
                config.name
            ),
            config_path,
            backup_path: backup,
        });
    }

    if matches!(plat, Platform::OpenCode) {
        let config = store
            .opencode_configs
            .iter()
            .find(|config| config.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("OpenCode 配置不存在: {provider_id}"))?;
        config.validate_active_source(&store.providers)?;
        let path = plat
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;
        emit_switch_progress(app, plat.id(), "backup", "正在备份原配置文件…");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        ensure_backup(&path)?;
        emit_switch_progress(app, plat.id(), "writing", "正在写入 OpenCode 配置…");
        apply_opencode_config_file_with_providers(&path, &config, &store.providers)?;

        let config_path = path.to_string_lossy().to_string();
        let backup = backup_path(&path).to_string_lossy().to_string();
        emit_switch_progress(app, plat.id(), "saving", "正在保存接管状态…");
        let plat_key = plat.id().to_string();
        let cfg_id = config.id.clone();
        crate::commands::store_io::update_provider_store(|s| {
            s.platforms.insert(
                plat_key,
                PlatformState {
                    provider_id: cfg_id,
                    applied_at: now_epoch_secs(),
                },
            );
            Ok((true, ()))
        })?;
        emit_switch_progress(app, plat.id(), "done", "设置完成");

        return Ok(SwitchResult {
            ok: true,
            message: format!(
                "已将 OpenCode 配置「{}」加入 live provider 列表，并设为当前 model，新会话或重启 OpenCode 后生效",
                config.name
            ),
            config_path,
            backup_path: backup,
        });
    }

    emit_switch_progress(app, plat.id(), "resolving", "正在解析供应商信息…");
    let mut provider = resolve_platform_config(&plat, &store, provider_id)?;
    let mut codex_wire_api_updated: Option<String> = None;
    let codex_source_id = if matches!(plat, Platform::Codex) {
        let before = store
            .codex_configs
            .iter()
            .find(|c| c.id == provider_id)
            .map(|c| c.wire_api.clone());
        apply_codex_auto_wire_api(&mut provider, &mut store, provider_id);
        let after = store
            .codex_configs
            .iter()
            .find(|c| c.id == provider_id)
            .map(|c| c.wire_api.clone());
        if after != before {
            codex_wire_api_updated = after;
        }
        store
            .codex_configs
            .iter()
            .find(|c| c.id == provider_id)
            .map(|c| c.source_provider_id.clone())
            .filter(|id| !id.trim().is_empty())
    } else {
        None
    };
    let planned_codex_routes = if matches!(plat, Platform::Codex) {
        emit_switch_progress(app, plat.id(), "routing", "正在校验 Codex 内置模型路由…");
        Some(if provider.route_through_proxy {
            plan_codex_proxy_routes(&provider, codex_source_id.as_deref())?
        } else {
            plan_clear_codex_proxy_routes()?
        })
    } else {
        None
    };
    let (planned_legacy_global_codex_routes, mut codex_cleanup_warnings) =
        if matches!(plat, Platform::Codex) {
            let plan = plan_clear_legacy_global_codex_proxy_routes();
            for warning in &plan.warnings {
                emit_switch_progress(app, plat.id(), "warning", warning);
            }
            (plan.routes, plan.warnings)
        } else {
            (None, Vec::new())
        };

    emit_switch_progress(app, plat.id(), "backup", "正在备份原配置文件…");
    let path = plat.apply(&provider)?;
    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();

    if planned_codex_routes.is_some() {
        emit_switch_progress(app, plat.id(), "routing", "正在写入 Codex 内置模型路由…");
        crate::commands::store_io::update_codex_proxy_routes(|cur| {
            let next = if provider.route_through_proxy {
                plan_codex_proxy_routes_into(
                    std::mem::take(cur),
                    &provider,
                    codex_source_id.as_deref(),
                )?
            } else {
                plan_clear_codex_proxy_routes_into(std::mem::take(cur))
            };
            *cur = next;
            Ok((true, ()))
        })?;
    }
    if let Some(routes) = planned_legacy_global_codex_routes.as_ref() {
        emit_switch_progress(
            app,
            plat.id(),
            "routing",
            "正在清理旧版 Codex 全局内置模型路由…",
        );
        if let Err(e) = crate::commands::proxy_routes::write_routes(routes) {
            let warning = legacy_global_codex_proxy_route_cleanup_warning("写入", &e);
            emit_switch_progress(app, plat.id(), "warning", &warning);
            codex_cleanup_warnings.push(warning);
        }
    }

    emit_switch_progress(app, plat.id(), "saving", "正在保存接管状态…");
    let plat_key = plat.id().to_string();
    let prov_id = provider.id.clone();
    let cfg_id = provider_id.to_string();
    crate::commands::store_io::update_provider_store(|s| {
        if let Some(wire) = codex_wire_api_updated {
            if let Some(c) = s.codex_configs.iter_mut().find(|c| c.id == cfg_id) {
                c.wire_api = wire;
            }
        }
        s.platforms.insert(
            plat_key,
            PlatformState {
                provider_id: prov_id,
                applied_at: now_epoch_secs(),
            },
        );
        Ok((true, ()))
    })?;

    let mut message = format!(
        "已将 {} 切换到「{}」，重启 {} 后生效",
        plat.display_name(),
        provider.name,
        plat.display_name()
    );
    if matches!(plat, Platform::Codex) {
        message.push_str(&repair_codex_session_visibility_message(&path));
        append_switch_warnings(&mut message, &codex_cleanup_warnings);
    }

    emit_switch_progress(app, plat.id(), "done", "切换完成");
    Ok(SwitchResult {
        ok: true,
        message,
        config_path,
        backup_path: backup,
    })
}


pub(in crate::commands::platforms) fn restore_platform_sync(app: &AppHandle, platform: &str) -> Result<bool, String> {
    let plat = Platform::from_id(platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    emit_switch_progress(app, plat.id(), "backup", "正在从备份还原配置…");
    let restored = plat.restore()?;

    emit_switch_progress(app, plat.id(), "saving", "正在清除接管记录…");
    // 无论是否有备份，都清除接管记录（接管状态以备份为准）。
    let _ = crate::commands::store_io::update_provider_store(|store| {
        let changed = store.platforms.remove(plat.id()).is_some();
        Ok((changed, ()))
    });
    invalidate_detect_cache();
    emit_switch_progress(app, plat.id(), "done", "还原完成");
    Ok(restored)
}
