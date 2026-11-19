use std::path::Path;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};
use super::*;
use super::health_probes::*;
use super::lifecycle::resolve_sidecar_path;

// 调用方须已持有启动占位；此层只获取证书任务锁，不重复占用 starting。
pub(super) fn run_proxy_preflight(
    target_ide: Option<&str>,
    resource_dir: Option<&Path>,
    scope: RepairScope,
) -> Result<ProxyPreflightReport, String> {
    if scope.repairs_config() {
        // 自动修复与显式证书任务共用互斥；只读体检不占用该锁。
        return crate::commands::cert_install::with_cert_task_lock(|| {
            run_proxy_preflight_inner(target_ide, resource_dir, scope)
        });
    }
    run_proxy_preflight_inner(target_ide, resource_dir, RepairScope::ReadOnly)
}

// 内部实现不获取外层锁，供已持有证书互斥及网关占位的入口复用，避免嵌套获取。
// 证书包与系统信任只由 RepairScope::Certificate 打开；其它范围只修复 IDE 配置。
pub(super) fn run_proxy_preflight_inner(
    target_ide: Option<&str>,
    resource_dir: Option<&Path>,
    scope: RepairScope,
) -> Result<ProxyPreflightReport, String> {
    let target = resolve_target_ide_arg(target_ide)?;
    let mut issues = Vec::new();
    let config_dir = crate::commands::config::config_dir_path();
    let resources_root = resolve_resources_root(resource_dir);
    let ports = configured_ports();
    let proxy_value = crate::commands::ide_config::current_proxy_value();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    check_env_and_certs(
        &config_dir,
        ports,
        scope,
        now_ms,
        &mut issues,
    );
    super::preflight_ide::check_ide_routes_and_ports(
        &target,
        &config_dir,
        resources_root.as_deref(),
        ports,
        &proxy_value,
        scope,
        now_ms,
        &mut issues,
    );

    let errors = issues.iter().filter(|i| i.level == "err").count();
    let warnings = issues.iter().filter(|i| i.level == "warn").count();
    Ok(ProxyPreflightReport {
        target_ide: target,
        ok: errors == 0,
        errors,
        warnings,
        issues,
    })
}


#[allow(dead_code)]
pub(super) fn emit_preflight_report(app: &AppHandle, report: &ProxyPreflightReport) {
    if report.ok {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: format!(
                    "✅ 启动自检通过（目标: {}，警告: {}）",
                    report.target_ide, report.warnings
                ),
            },
        );
    }
    for issue in &report.issues {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: issue.level.clone(),
                msg: format!("启动自检: {}", issue.message),
            },
        );
    }
}

pub fn preflight_proxy_impl(
    app: AppHandle,
    target_ide: Option<String>,
) -> Result<ProxyPreflightReport, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));
    let state = app.state::<ProxyState>();
    // 忙碌时仅只读体检；此快照不是互斥，空闲分支仍需在任务内重新检查并占位。
    let proxy_busy = state.starting.load(Ordering::SeqCst)
        || lock_or_recover(&state.child)
            .as_ref()
            .map(|managed| managed.try_wait().ok().flatten().is_none())
            .unwrap_or(false);
    if proxy_busy {
        return run_proxy_preflight(
            target_ide.as_deref(),
            resource_dir.as_deref(),
            RepairScope::ReadOnly,
        );
    }
    crate::commands::cert_install::with_cert_task_lock(|| {
        with_proxy_stopped(&app, || {
            run_proxy_preflight_inner(
                target_ide.as_deref(),
                resource_dir.as_deref(),
                RepairScope::Certificate,
            )
        })
    })
}

#[tauri::command]
pub async fn preflight_proxy(
    app: AppHandle,
    target_ide: Option<String>,
) -> Result<ProxyPreflightReport, String> {
    tauri::async_runtime::spawn_blocking(move || preflight_proxy_impl(app, target_ide))
        .await
        .map_err(|e| format!("启动自检任务失败: {}", e))?
}

/// 环境体检（带分组）— 供独立「环境体检」tab 使用。
/// 复用 preflight_proxy_impl 的检查逻辑，结果按 8 大类分组，方便 UI 卡片化展示。
#[tauri::command]
pub async fn healthcheck_grouped(
    app: AppHandle,
    target_ide: Option<String>,
) -> Result<GroupedHealthReport, String> {
    // 体检本身可能多次调 certutil；必须离 runtime 线程，并设总超时，避免 UI 永久 pending。
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let report = preflight_proxy_impl(app, target_ide)?;
        Ok::<GroupedHealthReport, String>(group_report(&report))
    });
    match tokio::time::timeout(std::time::Duration::from_secs(90), handle).await {
        Ok(join) => join.map_err(|e| format!("环境检测任务失败: {}", e))?,
        Err(_) => Err(
            "环境检测超时（90s）。可能 certutil/证书操作被杀软拦截。请重试，或到「环境检测」单独点「安装证书」"
                .into(),
        ),
    }
}

pub(super) fn check_env_and_certs(
    config_dir: &Path,
    ports: crate::commands::config::ConfiguredProxyPorts,
    scope: RepairScope,
    now_ms: u64,
    issues: &mut Vec<ProxyPreflightIssue>,
) {
    let mut package_repair_failed = false;
    let _ = now_ms;
    if ports.api_port == ports.inference_port {
        push_issue(
            issues,
            "err",
            "port.same",
            format!(
                "API 服务端口和推理服务端口不能相同（当前都是 {}）",
                ports.api_port
            ),
        );
    }

    match std::fs::create_dir_all(&config_dir) {
        Ok(()) => {
            let probe = config_dir.join(".byok-write-test");
            match std::fs::write(&probe, b"ok") {
                Ok(()) => {
                    let _ = std::fs::remove_file(&probe);
                }
                Err(e) => push_issue(
                    issues,
                    "err",
                    "config_dir.not_writable",
                    format!("配置目录不可写: {} ({})", config_dir.to_string_lossy(), e),
                ),
            }
        }
        Err(e) => push_issue(
            issues,
            "err",
            "config_dir.create_failed",
            format!("无法创建配置目录: {} ({})", config_dir.to_string_lossy(), e),
        ),
    }

    if let Err(e) = resolve_sidecar_path() {
        push_issue(issues, "err", "sidecar.missing", e);
    }

    let cert_dir = config_dir.join("certs");
    let cert_path = cert_dir.join("server.codeium.com.pem");
    let key_path = cert_dir.join("server.codeium.com-key.pem");
    let leaf_path = cert_dir.join(crate::commands::system::MITM_LEAF_CERT_FILE);
    let leaf_key_path = cert_dir.join(crate::commands::system::MITM_LEAF_KEY_FILE);
    let san_marker_path = cert_dir.join("san-version");
    let mut cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let mut key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let mut san_ok = std::fs::read_to_string(&san_marker_path)
        .map(|s| s.trim() == crate::commands::system::mitm_cert_san_version())
        .unwrap_or(false);
    // 证书被重生（SAN 版本升级 / 临近到期）后密钥也换了，信任库里那张同 CN 的旧证书已经对不上，
    // 必须连带重装，否则"正在用的人"升级后反而连不上（旧指纹验不了新链）。
    let mut cert_regenerated = false;
    let mut cert_contents_ok = cert_ok
        && key_ok
        && crate::commands::system::validate_mitm_cert_files(&cert_path, &key_path).is_ok();
    // 叶子证书（hybrid-server 实际呈现）也必须存在且有效；旧版升级时可能缺失。
    let mut leaf_ok = leaf_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && leaf_key_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && crate::commands::system::validate_mitm_cert_files(&leaf_path, &leaf_key_path).is_ok();
    if !cert_ok || !key_ok || !cert_contents_ok || !leaf_ok {
        if scope.repairs_certificate() {
            // 只生成 PEM，不走完整 install（避免授权交互卡住启动/体检）
            match crate::commands::system::ensure_mitm_certs() {
                Ok((dir, generated)) => {
                    cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                    key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                    san_ok = std::fs::read_to_string(&san_marker_path)
                        .map(|s| s.trim() == crate::commands::system::mitm_cert_san_version())
                        .unwrap_or(false);
                    cert_contents_ok = cert_ok
                        && key_ok
                        && crate::commands::system::validate_mitm_cert_files(
                            &cert_path,
                            &key_path,
                        )
                        .is_ok();
                    leaf_ok = leaf_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
                        && leaf_key_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
                        && crate::commands::system::validate_mitm_cert_files(
                            &leaf_path,
                            &leaf_key_path,
                        )
                        .is_ok();
                    if cert_ok && key_ok && san_ok && cert_contents_ok && leaf_ok {
                        let msg = if generated {
                            format!("已自动生成 MITM 证书到 {}", dir.to_string_lossy())
                        } else {
                            format!("MITM 证书已就绪 ({})", dir.to_string_lossy())
                        };
                        push_issue(issues, "ok", "certs.auto_generated", msg);
                    } else {
                        package_repair_failed = true;
                        push_issue(
                            issues,
                            "err",
                            "certs.generate_incomplete",
                            "已尝试自动生成 MITM 证书，但证书内容仍无效或文件不完整。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                        );
                    }
                }
                Err(e) => {
                    package_repair_failed = true;
                    push_issue(
                        issues,
                        "err",
                        "certs.generate_failed",
                        format!(
                            "自动生成 MITM 证书失败: {}。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                            e
                        ),
                    );
                }
            }
        } else {
            push_issue(
                issues,
                "err",
                "certs.missing",
                format!(
                    "MITM 证书缺失、为空或内容无效；请先点击「生成证书」，再点击「安装证书」完成当前平台信任设置（文件: {}, {}）",
                    cert_path.to_string_lossy(),
                    key_path.to_string_lossy()
                ),
            );
        }
    } else if !san_ok || crate::commands::system::mitm_certs_need_renewal(&cert_dir) {
        if scope.repairs_certificate() {
            match crate::commands::system::ensure_mitm_certs_ex(true) {
                Ok((dir, _)) => {
                    san_ok = std::fs::read_to_string(&san_marker_path)
                        .map(|s| s.trim() == crate::commands::system::mitm_cert_san_version())
                        .unwrap_or(false);
                    if san_ok {
                        cert_regenerated = true;
                        push_issue(
                            issues,
                            "ok",
                            "certs.san_regenerated",
                            format!("已按当前 SAN 版本重新生成 MITM 证书 ({})", dir.to_string_lossy()),
                        );
                    } else {
                        package_repair_failed = true;
                        push_issue(
                            issues,
                            "err",
                            "certs.san_regenerate_failed",
                            "已尝试重新生成 MITM 证书，但 SAN 标记仍不是当前版本。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                        );
                    }
                }
                Err(e) => {
                    package_repair_failed = true;
                    push_issue(
                        issues,
                        "err",
                        "certs.san_generate_failed",
                        format!(
                            "MITM 证书缺少 Cursor 所需 SAN，且自动重新生成失败: {}。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                            e
                        ),
                    );
                }
            }
        } else {
            push_issue(
                issues,
                "warn",
                "certs.san_outdated",
                "MITM 证书缺少 Cursor 所需 SAN；点击「生成证书」或「安装证书」会重新生成。",
            );
        }
    }

    // 修复路径读取新鲜信任状态；只有显式环境体检允许无提权用户级修复，系统级信任仍须显式安装。
    let mut ca_status = if scope.repairs_config() {
        crate::commands::cert_install::check_ca_status_fresh()
    } else {
        crate::commands::cert_install::check_ca_status()
    };
    if scope.repairs_certificate() && !package_repair_failed {
        // 证书刚被重生过（SAN 版本升级）时也必须重装：信任库里同 CN 的旧指纹已经验不了新链。
        // prefer_fresh_install 会先清掉同 CN 下不匹配的旧指纹，避免同名多证书打架。
        if (cert_regenerated
            || matches!(
                ca_status.effective_store,
                crate::commands::cert_install::CaStore::None
            ))
            && (ca_status.cert_exists || cert_ok)
        {
            // 启动/体检修复只能尝试用户级、非提权安装；系统级信任必须由用户显式操作。
            match crate::commands::cert_install::install_ca_user_only(false, cert_regenerated) {
                Ok(msg) => {
                    ca_status = crate::commands::cert_install::check_ca_status_fresh();
                    if !matches!(
                        ca_status.effective_store,
                        crate::commands::cert_install::CaStore::None
                    ) {
                        push_issue(
                            issues,
                            "ok",
                            "cert.auto_installed",
                            format!("已自动安装 CA 到系统信任库。{}", msg),
                        );
                    } else {
                        push_issue(
                            issues,
                            "err",
                            "cert.auto_install_incomplete",
                            format!(
                                "已尝试安装 CA，但系统信任库仍未找到当前指纹。请点「安装证书」或「清理并重装」。{}",
                                msg
                            ),
                        );
                    }
                }
                Err(e) => push_issue(
                    issues,
                    "err",
                    "cert.auto_install_failed",
                    format!(
                        "自动安装 CA 失败: {}。请在「平台 > 设置 > 环境检测」点「安装证书」或「清理并重装」",
                        e
                    ),
                ),
            }
        }
        // macOS 清理旧根可能请求管理员授权；后台只报告残留，由用户显式清理。
        if !package_repair_failed && ca_status.legacy_residual && cfg!(target_os = "windows") {
            match crate::commands::cert_install::cleanup_legacy_cn() {
                Ok(msg) => {
                    ca_status = crate::commands::cert_install::check_ca_status_fresh();
                    if !ca_status.legacy_residual {
                        push_issue(
                            issues,
                            "ok",
                            "cert.legacy_cleaned",
                            format!("已自动清理老版本 CA 残留。{}", msg),
                        );
                    } else {
                        push_issue(
                            issues,
                            "warn",
                            "cert.legacy_cleanup_partial",
                            format!(
                                "已尝试清理老证书，但仍有残留（可能需要系统授权）: {}",
                                msg
                            ),
                        );
                    }
                }
                Err(e) => push_issue(
                    issues,
                    "warn",
                    "cert.legacy_cleanup_failed",
                    format!("自动清理老证书失败: {}", e),
                ),
            }
        }
    }
    // 独立报告系统信任错误，避免被证书存在性检查或通用“未安装”提示掩盖。
    if let Some(error) = &ca_status.trust_error {
        push_issue(issues, "err", "cert.system_trust_failed", error.clone());
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    if let Some(issue) = recent_tls_rejection_issue(
        now_ms,
        LAST_TLS_REJECTION_AT_MS.load(Ordering::Relaxed),
    ) {
        issues.push(issue);
    }
    match ca_status.effective_store {
        crate::commands::cert_install::CaStore::CurrentUser => {
            push_issue(
                issues,
                "ok",
                "cert.trust_current_user",
                format!(
                    "当前 CA 证书已装到 {}。{}",
                    crate::commands::cert_install::current_user_store_label(),
                    ca_status
                        .thumbprint
                        .as_deref()
                        .map(|t| format!("Thumbprint: {}", t))
                        .unwrap_or_default()
                ),
            );
        }
        crate::commands::cert_install::CaStore::LocalMachine => {
            push_issue(
                issues,
                "ok",
                "cert.trust_local_machine",
                format!(
                    "当前 CA 证书已装到 {}（系统级）。{}",
                    crate::commands::cert_install::local_machine_store_label(),
                    ca_status
                        .thumbprint
                        .as_deref()
                        .map(|t| format!("Thumbprint: {}", t))
                        .unwrap_or_default()
                ),
            );
        }
        crate::commands::cert_install::CaStore::None => {
            // 证书文件存在但未完成系统信任 → 提示用户显式授权安装
            if ca_status.cert_exists {
                push_issue(
                    issues,
                    "err",
                    "cert.not_trusted",
                    format!(
                        "当前 CA 证书已生成但未完成系统信任。点「安装证书」执行显式授权；若仍异常请查看具体错误，不要反复重生证书"
                    ),
                );
            }
            // cert_exists=false 已经在上面 certs.missing 提示过了
        }
    }
    if ca_status.legacy_residual {
        push_issue(
            issues,
            "warn",
            "cert.legacy_residual",
            format!(
                "检测到老版本 CA \"{}\" 残留。建议点「清理老证书」或「清理并重装」",
                crate::commands::system::LEGACY_CA_COMMON_NAMES.join("\" / \"")
            ),
        );
    }

}
