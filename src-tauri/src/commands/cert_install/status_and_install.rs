use super::*;

// 已执行的系统检查失败时，证书存在也不算有效；未实现检查的平台保留原有存在性判定。
pub(super) fn store_is_effective(current_user: bool, local_machine: bool, system_trusted: Option<bool>) -> bool {
    (current_user || local_machine) && system_trusted != Some(false)
}

// 仅 macOS 接入原生 SSL 策略检查；其他平台返回 None，而不是伪造检查成功。
pub(super) fn system_trust_result(cert_path: &Path) -> Option<Result<(), String>> {
    #[cfg(target_os = "macos")]
    {
        Some(platform::verify_system_trust(cert_path))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cert_path;
        None
    }
}

// ──────────────────────────────────────────────────────────
// 公共 API
// ──────────────────────────────────────────────────────────
pub(super) static CA_STATUS_CACHE: std::sync::Mutex<Option<(std::time::Instant, CaStatus)>> =
    std::sync::Mutex::new(None);
pub(super) static LEGACY_RESIDUAL_CACHE: std::sync::Mutex<Option<(std::time::Instant, bool)>> =
    std::sync::Mutex::new(None);

pub fn invalidate_ca_status_cache() {
    if let Ok(mut g) = CA_STATUS_CACHE.lock() {
        *g = None;
    }
    if let Ok(mut g) = LEGACY_RESIDUAL_CACHE.lock() {
        *g = None;
    }
}

/// 查询 CA 在系统中的安装状态。
pub fn check_ca_status() -> CaStatus {
    // 1. 检查最近缓存（2 秒内直接返回，避免频繁调用如每秒状态轮询或批量保存时重复执行系统检测）
    if let Some(status) = cached_ca_status(&CA_STATUS_CACHE) {
        return status;
    }
    check_ca_status_fresh()
}

// 将缓存判断与系统访问分离，使过期测试不依赖真实钥匙串或系统命令耗时。
pub(super) fn cached_ca_status(
    cache: &std::sync::Mutex<Option<(std::time::Instant, CaStatus)>>,
) -> Option<CaStatus> {
    let guard = cache.lock().ok()?;
    let (time, status) = guard.as_ref()?;
    (time.elapsed() < std::time::Duration::from_secs(2)).then(|| status.clone())
}

/// 绕过应用层状态缓存并回填新结果，供启动及安装后复验使用；不清除操作系统自身缓存。
pub(crate) fn check_ca_status_fresh() -> CaStatus {
    let (cert_path, key_path) = cert_paths().unwrap_or_else(|_| {
        (
            PathBuf::from("certs/server.codeium.com.pem"),
            PathBuf::from("certs/server.codeium.com-key.pem"),
        )
    });
    let cert_exists = cert_path.exists();
    let key_exists = key_path.exists();
    let san_version = read_san_version(&cert_path);
    let san_current = is_san_current(&cert_path, cert_exists, key_exists);

    let thumbprint = if cert_exists {
        compute_thumbprint(&cert_path).ok()
    } else {
        None
    };

    // 没有当前磁盘证书时，只能报告残留，不能按 CN 将其他证书认作当前 CA。
    let (current_user, local_machine, legacy_residual) = if thumbprint.is_some() {
        platform::query_ca_store_status(
            thumbprint.as_deref(),
            CA_COMMON_NAME,
            LEGACY_CA_COMMON_NAMES,
        )
    } else {
        let legacy_residual = LEGACY_CA_COMMON_NAMES
            .iter()
            .any(|cn| platform::is_in_store(cn, true) || platform::is_in_store(cn, false));
        (false, false, legacy_residual)
    };

    // 证书材料缺失时不运行 macOS SSL 子进程，避免用“验证失败”掩盖“文件未生成”。
    let trust_result = if cert_exists && key_exists {
        system_trust_result(&cert_path)
    } else {
        None
    };
    let system_trusted = trust_result.as_ref().map(Result::is_ok);
    let trust_error = trust_result.and_then(Result::err);
    let effective_store = if cert_exists && key_exists && san_current
        && store_is_effective(current_user, local_machine, system_trusted)
    {
        if current_user {
            CaStore::CurrentUser
        } else {
            CaStore::LocalMachine
        }
    } else {
        CaStore::None
    };

    // 优先报告缺失材料和原始信任错误；存储位置不能证明 IDE 使用的信任库已接受该链。
    let message = if !cert_exists || !key_exists {
        "证书材料缺失；请先停止网关，在环境检测中生成证书，再显式安装信任".to_string()
    } else if let Some(error) = &trust_error {
        error.clone()
    } else if cert_exists && key_exists && !san_current {
        format!(
            "MITM 证书缺少当前 SAN 或证书材料无效（当前标记: {}，需要: {}）；请先停止网关，生成证书后显式安装信任",
            san_version.as_deref().unwrap_or("missing"),
            crate::commands::system::mitm_cert_san_version()
        )
    } else {
        match effective_store {
            CaStore::CurrentUser => format!(
                "当前 CA 证书存在于 {}；证书存在不代表 IDE 已信任，请验证实际 TLS 请求",
                current_user_store_label()
            ),
            CaStore::LocalMachine => format!(
                "当前 CA 证书存在于 {}（系统级）；仍需验证系统信任和 IDE 实际 TLS 请求",
                local_machine_store_label()
            ),
            CaStore::None => "当前 CA 证书未完成系统信任；请显式安装信任并验证 IDE 实际 TLS 请求".to_string(),
        }
    };

    // 系统证书库可信只是 Electron/Chromium 那条链；Node TLS 栈需单独判据。
    let node_trusted = node_ca_trust_ready();
    let message = if node_trusted {
        message
    } else {
        format!("{message}；Node 客户端（Antigravity IDE 的 CloudCode 请求）尚未信任本地 CA，请在环境检测安装证书并重启 IDE")
    };

    let res = CaStatus {
        common_name: CA_COMMON_NAME.to_string(),
        cert_file: cert_path.to_string_lossy().to_string(),
        cert_exists,
        key_exists,
        san_version,
        san_current,
        current_user,
        local_machine,
        legacy_residual,
        thumbprint,
        effective_store,
        message,
        system_trusted,
        trust_error,
        node_trusted,
    };

    if let Ok(mut guard) = CA_STATUS_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), res.clone()));
    }

    res
}

/// 显式安装 CA：Windows 当前策略直接请求系统级授权；用户级尝试由 install_ca_user_only 提供。
/// macOS 只修复当前有效证书包的信任，不轮换 CA 或自动清理旧根。
/// 此底层入口不获取任务锁或网关占位，桌面调用方须在外层提供保护。
#[allow(dead_code)]
pub fn install_ca() -> Result<String, String> {
    install_ca_with_options(false, false)
}

/// 仅尝试用户级信任库，不请求管理员授权；供网关启动/体检的保守修复路径使用。
/// Windows 用户级安装仍可能显示系统安全确认，但不会进入提权路径。
#[allow(dead_code)]
pub fn install_ca_user_only(
    force_regenerate: bool,
    prefer_fresh_install: bool,
) -> Result<String, String> {
    install_ca_impl(None, force_regenerate, prefer_fresh_install, false)
}

/// `force_regenerate`：Windows/其他平台删除 PEM 并重生后再安装（「清理并重装」）；
/// macOS 分支保留当前有效证书包，不在授权失败前覆盖证书。
/// `prefer_fresh_install`：安装前先清掉当前 CN 下不匹配的旧指纹（防止同名多证书乱）。
#[allow(dead_code)]
pub fn install_ca_with_options(
    force_regenerate: bool,
    prefer_fresh_install: bool,
) -> Result<String, String> {
    install_ca_impl(None, force_regenerate, prefer_fresh_install, true)
}

/// 尝试从 user store 按 CN 卸载当前产品 CA（无需管理员）。
/// 用于「同 CN 旧指纹」清理：重生后旧证书还在库里时先卸掉再装新的。
pub(super) fn cleanup_stale_current_user_cn(keep_thumbprint: &str) -> String {
    // 当前指纹已在库里 → 无需清
    if platform::is_thumbprint_in_store(keep_thumbprint, true) {
        return String::new();
    }
    // CN 存在但指纹不匹配 → 是旧轮证书，卸掉
    if !platform::is_in_store(CA_COMMON_NAME, true) {
        return String::new();
    }
    match platform::uninstall_from_store(CA_COMMON_NAME, true) {
        Ok(()) => format!(
            "已清除 {} 中同名旧 CA \"{}\"\n",
            current_user_store_label(),
            CA_COMMON_NAME
        ),
        Err(e) => {
            eprintln!(
                "[cert_install] cleanup stale CurrentUser CN failed: {}",
                e
            );
            String::new()
        }
    }
}

// 公共入口取得独占包锁；已由组合流程持锁时改走下层函数，避免 flock 重入自冲突。
pub(super) fn install_ca_impl(
    app: Option<AppHandle>,
    force_regenerate: bool,
    prefer_fresh_install: bool,
    allow_admin: bool,
) -> Result<String, String> {
    let _package_lock = crate::commands::system::acquire_mitm_package_write_lock()?;
    let result = install_ca_impl_with_package_lock(app, force_regenerate, prefer_fresh_install, allow_admin);
    // 证书装进系统信任库只覆盖 Electron/Chromium；Node TLS 栈要单独对齐。
    // 所有显式安装入口都经过这里，与卸载入口成对。
    if result.is_ok() {
        #[cfg(target_os = "windows")]
        ensure_node_ca_trust()?;
    }
    result
}

pub(crate) fn install_ca_impl_with_package_lock(
    app: Option<AppHandle>,
    force_regenerate: bool,
    prefer_fresh_install: bool,
    allow_admin: bool,
) -> Result<String, String> {
    invalidate_ca_status_cache();
    eprintln!(
        "[cert_install] install_ca: start force={} fresh={} allow_admin={}",
        force_regenerate, prefer_fresh_install, allow_admin
    );
    emit_cert_progress(
        app.as_ref(),
        "start",
        if force_regenerate {
            "开始清理并重装 CA 证书"
        } else {
            "开始安装 CA 证书"
        },
        5,
        "info",
    );
    let (cert_path, key_path) = cert_paths()?;
    let certs_dir = cert_path.parent().ok_or("CA 路径缺少父目录")?;
    // 候选目录可能属于仍在运行的生成任务；包状态不确定时不修改系统信任，也不自动清理现场。
    crate::commands::system::reject_interrupted_mitm_candidates(certs_dir)?;

    // macOS 的重装入口只修复当前包的信任，不执行 force_regenerate 或旧根清理。
    // 避免授权失败前已覆盖磁盘证书，导致网关内存、磁盘与钥匙串使用不同证书。
    if cfg!(target_os = "macos") {
        let leaf_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_CERT_FILE);
        let leaf_key = cert_path.with_file_name(crate::commands::system::MITM_LEAF_KEY_FILE);
        if is_san_current(&cert_path, cert_path.exists(), key_path.exists())
            && crate::commands::system::validate_mitm_cert_files(&leaf_path, &leaf_key).is_ok()
        {
            // CA 文件存在也不代表配套私钥正确；在任何系统信任探测或授权前验证公私钥匹配。
            crate::commands::system::validate_mitm_cert_files(&cert_path, &key_path)
                .map_err(|e| format!("macOS CA 证书包校验失败，未请求信任授权: {}", e))?;
            // 授权前先验证磁盘链，避免为错误链申请信任；失败不轮换文件或修改钥匙串。
            let certs_dir = cert_path.parent().ok_or("CA 路径缺少父目录")?;
            crate::commands::system::validate_mitm_candidate_chain(certs_dir)
                .map_err(|e| format!("macOS 证书包离线校验失败，未请求信任授权: {}", e))?;

            if system_trust_result(&cert_path).is_some_and(|result| result.is_ok()) {
                return Ok("macOS SSL 信任验证已通过，无需重装或轮换证书；请验证 IDE 实际请求".into());
            }

            if !allow_admin {
                return Err("macOS 信任变更需要显式授权，请在环境检测中点击安装证书；后台不会修改钥匙串".into());
            }
            emit_cert_progress(app.as_ref(), "admin", "正在修复现有 CA 的系统信任，不轮换证书；请在 macOS 系统授权界面确认", 65, "warn");
            platform::install_local_machine_via_uac(&cert_path)?;
            invalidate_ca_status_cache();

            // 命令退出成功不等于可信：当前指纹入库与系统 SSL 链验证必须分别通过。
            let thumbprint = compute_thumbprint(&cert_path)?;
            if !platform::is_thumbprint_in_store(&thumbprint, false) {
                return Err("安装命令已退出，但 System keychain 未找到当前 CA 指纹".into());
            }
            if let Some(result) = system_trust_result(&cert_path) {
                result?;
            }

            return Ok("现有 CA 信任安装及 macOS SSL 验证已完成，未轮换证书；请重新运行环境检测并验证 IDE 实际请求".into());
        }

        return Err("macOS 当前证书包缺失或无效。请先停止网关，在环境检测中生成证书，再显式安装信任；本次未覆盖证书或清理钥匙串".into());
    }

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let leaf_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_CERT_FILE);
    let leaf_key_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_KEY_FILE);
    // 此处仅按文件存在性决定是否补齐旧包；补齐后还会单独校验叶子证书、私钥及签名链。
    let leaf_ok = leaf_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && leaf_key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let san_current = is_san_current(&cert_path, cert_ok, key_ok);
    let need_generate = force_regenerate || !cert_ok || !key_ok || !leaf_ok || !san_current;
    let auto_generate_msg = if need_generate {
        let reason = if force_regenerate {
            "正在强制重新生成 MITM 证书"
        } else if !cert_ok || !key_ok || !leaf_ok {
            "证书包文件缺失或为空，正在自动生成 MITM 证书"
        } else {
            "MITM 证书缺少 Cursor 所需 SAN，正在重新生成"
        };
        emit_cert_progress(app.as_ref(), "auto_generate", reason, 8, "info");
        let (certs_dir, generated) =
            crate::commands::system::ensure_mitm_certs_ex_unlocked(force_regenerate)
                .map_err(|e| format!("自动生成证书失败: {}", e))?;
        Some(if generated {
            format!("已自动生成证书到 {}", certs_dir.to_string_lossy())
        } else {
            "证书文件已存在".to_string()
        })
    } else {
        None
    };

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    // 文件存在不代表证书包可用；安装前再次确认叶子证书与私钥有效且匹配。
    let leaf_ok = leaf_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && leaf_key_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && crate::commands::system::validate_mitm_cert_files(&leaf_path, &leaf_key_path).is_ok();
    let san_current = is_san_current(&cert_path, cert_ok, key_ok);
    if !cert_ok || !key_ok || !leaf_ok || !san_current {
        return Err(format!(
            "证书文件自动生成后仍不完整或 SAN 标记未更新: {}, {} (leaf_ok={}, san_current={})",
            cert_path.to_string_lossy(),
            key_path.to_string_lossy(),
            leaf_ok,
            san_current
        ));
    }
    // 所有平台都必须先验证叶子到当前 CA 的离线链，防止仅凭 CA 文件存在就写入系统信任。
    crate::commands::system::validate_mitm_candidate_chain(
        cert_path.parent().ok_or("CA 路径缺少父目录")?,
    )
    .map_err(|e| format!("证书包离线校验失败，未执行信任安装: {}", e))?;
    let thumbprint =
        compute_thumbprint(&cert_path).map_err(|e| format!("证书指纹计算失败: {}", e))?;
    emit_cert_progress(
        app.as_ref(),
        "check_file",
        &format!("证书文件已找到，Thumbprint: {}", thumbprint),
        12,
        "info",
    );

    // 已安装且指纹一致、非 force → 幂等返回（避免重复弹 UAC）
    if !force_regenerate && !prefer_fresh_install {
        let already_user = platform::is_thumbprint_in_store(&thumbprint, true);
        let already_machine = platform::is_thumbprint_in_store(&thumbprint, false);
        if already_user || already_machine {
            let store = if already_user {
                current_user_store_label()
            } else {
                local_machine_store_label()
            };
            // 仍尝试清理 legacy，不影响成功路径
            // 非 Windows 的后台路径不能顺带调用可能提权的旧根清理。
            if allow_admin || cfg!(target_os = "windows") {
                let _ = cleanup_legacy_cn();
            }
            let msg = format!(
                "CA 已在 {}（无需重装）。Thumbprint: {}",
                store, thumbprint
            );
            emit_cert_progress(app.as_ref(), "done", &msg, 100, "ok");
            return Ok(match auto_generate_msg {
                Some(prefix) => format!("{prefix}\n{msg}"),
                None => msg,
            });
        }
    }

    // 清理老 CN + 同 CN 旧指纹（不影响新证书安装）
    emit_cert_progress(app.as_ref(), "cleanup", "正在清理旧版/残留证书", 20, "info");
    let mut cleanup_notes = String::new();
    // 非 Windows 的后台路径不能顺带调用可能提权的旧根清理。
    if allow_admin || cfg!(target_os = "windows") {
        if let Ok(legacy_msg) = cleanup_legacy_cn() {
            if legacy_msg != "无老证书残留" {
                cleanup_notes.push_str(&legacy_msg);
            }
        }
    }
    if force_regenerate || prefer_fresh_install || need_generate {
        cleanup_notes.push_str(&cleanup_stale_current_user_cn(&thumbprint));
    }
    eprintln!("[cert_install] install_ca: cleanup done");

    // 阶段 1：仅 allow_admin=false（纯静默/修复路径）才先试 CurrentUser\Root。
    // allow_admin=true 时跳过 CurrentUser，直接走阶段 2 提权装 LocalMachine\Root——
    // 因为 CurrentUser 安装会触发 Windows「安全警告」弹窗，而提权进程装 LocalMachine\Root
    // 不会弹该警告（UAC 提权本身就是授权门槛），实现「自动提权 + 静默无感」。
    // 调试 UAC 时可设置 ANYBRIDGE_FORCE_UAC_CERT_INSTALL=1 强制跳过本阶段。
    let force_admin = std::env::var_os("ANYBRIDGE_FORCE_UAC_CERT_INSTALL").is_some()
        || std::env::var_os("IDE_BYOK_FORCE_UAC_CERT_INSTALL").is_some();
    // macOS：用户级（login keychain）既不需要管理员密码，也不会弹「安全警告」，
    // 所以即使允许提权也应先试用户级，失败再提权 —— 多数用户因此根本不用输管理员密码。
    // Windows 相反：CurrentUser 安装会弹「安全警告」，允许提权时直接走 UAC 更干净。
    #[cfg(target_os = "macos")]
    let try_user_first = !force_admin;
    #[cfg(not(target_os = "macos"))]
    let try_user_first = !allow_admin && !force_admin;

    if try_user_first {
        emit_cert_progress(
            app.as_ref(),
            "current_user",
            &format!(
                "正在安装到 {}（无需管理员权限）",
                current_user_store_label()
            ),
            35,
            "info",
        );
        match platform::install_current_user(&cert_path) {
            Ok(()) => {
                // 必须用当前证书文件的 Thumbprint 验证，不能用 CN
                emit_cert_progress(
                    app.as_ref(),
                    "verify_current_user",
                    &format!("正在验证 {} 中的证书指纹", current_user_store_label()),
                    55,
                    "info",
                );
                if platform::is_thumbprint_in_store(&thumbprint, true) {
                    eprintln!(
                        "[cert_install] install_ca: installed to {}",
                        current_user_store_label()
                    );
                    emit_cert_progress(
                        app.as_ref(),
                        "done",
                        &format!("CA 证书已安装到 {}", current_user_store_label()),
                        100,
                        "ok",
                    );
                    let install_msg = format!(
                        "CA 已安装到 {}（无需管理员权限）。Thumbprint: {}",
                        current_user_store_label(),
                        thumbprint
                    );
                    let body = if cleanup_notes.is_empty() {
                        install_msg
                    } else {
                        format!("{cleanup_notes}{install_msg}")
                    };
                    return Ok(match auto_generate_msg {
                        Some(prefix) => format!("{prefix}\n{body}"),
                        None => body,
                    });
                }
                // 装完查不到，说明 GPO 拦截了，降级
            }
            Err(e) => {
                eprintln!(
                    "[cert_install] {} 失败: {}，继续请求 {}",
                    current_user_store_label(),
                    e,
                    admin_prompt_label()
                );
            }
        }
    } else {
        eprintln!(
            "[cert_install] install_ca: force admin cert install is set, skip {}",
            current_user_store_label()
        );
    }

    // 静默/修复路径：不弹 UAC。让用户在体检里点「安装证书」显式操作。
    if !allow_admin {
        let msg = format!(
            "已尝试安装到 {}，但验证未通过（可能被组策略拦截）。请在「环境检测」点「安装证书」或「清理并重装」（可能需要 {}）。Thumbprint: {}",
            current_user_store_label(),
            admin_prompt_label(),
            thumbprint
        );
        emit_cert_progress(app.as_ref(), "need_admin", &msg, 100, "warn");
        let body = if cleanup_notes.is_empty() {
            msg
        } else {
            format!("{cleanup_notes}{msg}")
        };
        return Err(match auto_generate_msg {
            Some(prefix) => format!("{prefix}\n{body}"),
            None => body,
        });
    }

    // 阶段 2：仅用户显式触发时请求管理员授权，装到系统级根证书库。
    // 网关启动和后台体检不应进入此分支，避免隐藏或不可交互的授权弹窗。
    eprintln!(
        "[cert_install] install_ca: install to {} via {}",
        local_machine_store_label(),
        admin_prompt_label()
    );
    emit_cert_progress(
        app.as_ref(),
        "admin",
        &format!(
            "正在请求 {} 授权安装到 {}，请按系统提示确认。授权窗口可能被其它窗口挡住或出现在另一个桌面；若未显示，请切换到本地登录的桌面会话。",
            admin_prompt_label(),
            local_machine_store_label()
        ),
        65,
        "warn",
    );
    if let Err(e) = platform::install_local_machine_via_uac(&cert_path) {
        emit_cert_progress(
            app.as_ref(),
            "error",
            "授权未完成，证书尚未装入系统信任库",
            100,
            "err",
        );
        return Err(format!(
            "{}授权未完成：{}\n\n当前状态：证书文件已{}，但系统信任库里没有它，IDE 会拒绝 MITM 证书（表现为模型列表/对话报 bad certificate）。\n\n请二选一：\n1）重新点「安装证书」或「清理并重装」，这次留意系统弹窗并输入密码；\n2）手动安装：\n{}\n\n完成后请完全退出 IDE（macOS 用 Cmd+Q）再打开。",
            admin_prompt_label(),
            e,
            if force_regenerate { "重新生成" } else { "生成" },
            manual_install_hint(&cert_path)
        ));
    }
    emit_cert_progress(
        app.as_ref(),
        "verify_local_machine",
        &format!("授权完成，正在验证 {} 中的证书指纹", local_machine_store_label()),
        90,
        "info",
    );
    if !platform::is_thumbprint_in_store(&thumbprint, false) {
        emit_cert_progress(
            app.as_ref(),
            "error",
            &format!(
                "安装命令已退出但未在 {} 查到同一证书指纹",
                local_machine_store_label()
            ),
            100,
            "err",
        );
        return Err(format!(
            "安装命令已返回成功，但 {} 未查到当前证书 Thumbprint: {}",
            local_machine_store_label(),
            thumbprint
        ));
    }
    emit_cert_progress(
        app.as_ref(),
        "done",
        &format!("CA 证书已安装到 {}", local_machine_store_label()),
        100,
        "ok",
    );
    let install_msg = format!(
        "CA 已通过 {} 授权安装到 {}。Thumbprint: {}",
        admin_prompt_label(),
        local_machine_store_label(),
        thumbprint
    );
    let body = if cleanup_notes.is_empty() {
        install_msg
    } else {
        format!("{cleanup_notes}{install_msg}")
    };
    Ok(match auto_generate_msg {
        Some(prefix) => format!("{prefix}\n{body}"),
        None => body,
    })
}

