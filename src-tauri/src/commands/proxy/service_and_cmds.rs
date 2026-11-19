use serde::Serialize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use super::*;
use super::commands_and_cleanup::kill_sidecar_process;
use super::health_probes::*;

pub fn start_proxy_service_impl(app: AppHandle) -> Result<bool, String> {
    start_proxy_service_impl_with_repair(app, true)
}

pub(super) fn start_proxy_service_impl_with_repair(
    app: AppHandle,
    allow_runtime_repair: bool,
) -> Result<bool, String> {
    let state = app.state::<ProxyState>();

    {
        let mut guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            if managed.try_wait().ok().flatten().is_none() {
                return Err("网关已在运行".into());
            }
            *guard = None;
        }
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("网关正在启动中".into());
        }
    }
    let clear_starting = || state.starting.store(false, Ordering::SeqCst);
    // 从启动校验一直持锁到 child 退出，防止另一个桌面实例在网关运行中轮换 CA。
    let package_lock = match crate::commands::system::acquire_mitm_package_lock(
        &crate::commands::config::config_dir_path().join("certs"),
        false,
    ) {
        Ok(lock) => lock,
        Err(error) => {
            clear_starting();
            return Err(error);
        }
    };

    let config_dir = crate::commands::config::config_dir_path();
    let ports = configured_ports();
    let cert_path = config_dir.join("certs").join("server.codeium.com.pem");
    // 后台启动同样记录运行目录和端口，便于与 UI 手动启动的日志区分。
    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: format!(
                "后台网关启动诊断: config_dir={} api_port={} inference_port={}",
                config_dir.display(),
                ports.api_port,
                ports.inference_port,
            ),
        },
    );
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));

    // 启动前只检查现有证书材料；信任变更不在此路径修改钥匙串或弹出管理员授权。
    // 受管网关从校验到退出持有共享包锁，阻止其他桌面实例并发修改证书。
    let mitm_result = crate::commands::cert_install::with_cert_task_lock(ensure_proxy_mitm_ready);
    let mitm_report = match mitm_result {
        Ok(report) => report,
        Err(e) => {
            clear_starting();
            let msg = format!("网关服务未启动：MITM 前置条件不满足: {}", e);
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "err".into(),
                    msg: msg.clone(),
                },
            );
            return Err(msg);
        }
    };
    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "ok".into(),
            msg: format!("✅ MITM 前置检查通过: {}", mitm_report.message),
        },
    );

    kill_sidecar_process();

    // 解析 sidecar 启动方式(dev 模式跑源码 node,release 模式跑 pkg exe)
    let mut cmd = {
        #[cfg(debug_assertions)]
        {
            let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let sidecar_dir = manifest_dir.parent().unwrap().join("sidecar");
            if !sidecar_dir.join("proxy-entry.js").exists() {
                clear_starting();
                return Err(format!(
                    "dev 模式找不到 sidecar 源码: {}",
                    sidecar_dir.display()
                ));
            }
            let mut c = std::process::Command::new("node");
            c.current_dir(&sidecar_dir);
            c.arg("proxy-entry.js");
            #[cfg(target_os = "windows")]
            c.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            c
        }
        #[cfg(not(debug_assertions))]
        {
            let sidecar_path = match resolve_sidecar_path() {
                Ok(p) => p,
                Err(e) => {
                    clear_starting();
                    return Err(e);
                }
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&sidecar_path) {
                    let mut permissions = metadata.permissions();
                    let mode = permissions.mode();
                    if mode & 0o111 != 0o111 {
                        permissions.set_mode(mode | 0o755);
                        let _ = std::fs::set_permissions(&sidecar_path, permissions);
                    }
                }
            }
            let c = std::process::Command::new(&sidecar_path);
            #[cfg(target_os = "windows")]
            let mut c = c;
            #[cfg(target_os = "windows")]
            c.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            c
        }
    };

    cmd.env("BYOK_CONFIG_DIR", config_dir.to_string_lossy().to_string());
    cmd.env("API_PORT", ports.api_port.to_string());
    cmd.env("INFERENCE_PORT", ports.inference_port.to_string());
    if let Some(res) = &resource_dir {
        cmd.env("BYOK_RESOURCE_DIR", res.to_string_lossy().to_string());
    }
    if let Some(pdir) = resolve_plugins_dir(resource_dir.as_deref()) {
        cmd.env("ANYBRIDGE_PLUGINS_DIR", pdir.to_string_lossy().to_string());
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            clear_starting();
            return Err(format!("启动失败: {}", e));
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // 记录本轮进程身份，后续监控及健康检查失败只能处理这一个进程。
    let proxy_pid = child.id();
    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: format!("后台 sidecar 已创建: pid={} api_port={}", proxy_pid, ports.api_port),
        },
    );

    *lock_or_recover(&state.child) = Some(ManagedChild {
        child: Mutex::new(child),
        _package_lock: package_lock,
    });
    *lock_or_recover(&state.target_ide) = String::new();
    *lock_or_recover(&state.ports) = Some(ports);
    clear_starting();

    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: format!(
                "网关服务启动中；配置目录: {}{}",
                config_dir.to_string_lossy(),
                resource_dir
                    .as_ref()
                    .map(|p| format!("；资源目录: {}", p.to_string_lossy()))
                    .unwrap_or_default()
            ),
        },
    );

    spawn_log_reader(app.clone(), stdout);
    spawn_log_reader(app.clone(), stderr);

    let app_handle2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));

        let exit_status = if let Some(state) = app_handle2.try_state::<ProxyState>() {
            let mut guard = lock_or_recover(&state.child);
            let status = match guard.as_ref() {
                Some(managed) if managed.id() == proxy_pid => managed.try_wait().ok().flatten(),
                _ => break,
            };
            // 身份检查与退出清理在同一 child 锁内，旧监控不能清掉新一轮网关。
            if status.is_some() {
                *guard = None;
                *lock_or_recover(&state.target_ide) = String::new();
                *lock_or_recover(&state.ports) = None;
            }
            status
        } else {
            break;
        };

        if let Some(status) = exit_status {
            let _ = app_handle2.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("网关进程已退出（{}）", format_exit_status(&status)),
                },
            );
            let _ = app_handle2.emit("proxy-stopped", ());
            break;
        }
    });

    let expected_ports = unique_proxy_ports(ports);
    let missing_ports = wait_for_ports(&expected_ports, Duration::from_secs(5));
    let health_error = if missing_ports.contains(&ports.api_port) {
        Some(ProxyHealthFailure {
            message: format!(
                "网关主端口 {} 未监听，本地网关入口不可用",
                ports.api_port
            ),
            mitm_related: false,
        })
    } else {
        match probe_byok_stats(ports.api_port, Duration::from_secs(2)) {
            Err(failure) => Some(failure),
            Ok(()) => probe_mitm_tls(ports.api_port, &cert_path, Duration::from_secs(5))
                .map_err(mitm_tls_failure)
                .err(),
        }
    };

    if let Some(failure) = health_error {
        let stop = stop_managed_proxy(&state, Some(proxy_pid))
            .map_err(|e| format!("网关服务自检失败: {}；未能确认本轮网关停止: {}", failure.message, e))?;
        if let StopStatus::Unconfirmed { pid, waited_ms } = stop {
            return Err(format!(
                "网关服务自检失败: {}；{}",
                failure.message,
                unconfirmed_stop_hint(pid, waited_ms)
            ));
        }
        if failure.mitm_related && allow_runtime_repair {
            // 运行时“修复”不改证书或信任，只在停机后复核现有状态并最多尝试一次重启。
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!(
                        "MITM/TLS 实链路自检失败，正在只读复核证书材料与系统信任并仅重启一次: {}",
                        failure.message
                    ),
                },
            );
            // spawn 后 starting 已释放，修复必须重新占位；闭包结束释放两层保护，重启再走正常检查。
            match crate::commands::cert_install::with_cert_task_lock(|| {
                with_proxy_stopped(&app, || ensure_proxy_mitm_ready_once())
            }) {
                Ok(report) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "info".into(),
                            msg: format!("MITM 证书材料与系统信任复核通过，正在重新启动网关: {}", report),
                        },
                    );
                    return start_proxy_service_impl_with_repair(app, false);
                }
                Err(repair_error) => {
                    let msg = format!(
                        "网关服务启动失败: {}；MITM 证书材料或系统信任复核未通过: {}。请到「环境检测」显式处理证书或授权",
                        failure.message, repair_error
                    );
                    let _ = app.emit("proxy-stopped", ());
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "err".into(),
                            msg: msg.clone(),
                        },
                    );
                    return Err(msg);
                }
            }
        }
        let msg = format!("网关服务启动失败: {}", failure.message);
        let _ = app.emit("proxy-stopped", ());
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "err".into(),
                msg: msg.clone(),
            },
        );
        return Err(msg);
    }

    if missing_ports.is_empty() {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: format!("✅ 网关服务健康检查通过: {}", port_pair_text(ports)),
            },
        );
    } else {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "warn".into(),
                msg: format!(
                    "⚠ 网关主服务已就绪，但以下辅助端口暂未监听: {}",
                    missing_ports
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            },
        );
    }

    Ok(true)
}

// expected_pid 防止旧启动任务停止后来启动的网关；kill 失败时保留句柄及关联状态。
// child 锁覆盖确认退出与状态清理，不会先公布“已停止”再尝试终止进程。
pub(super) fn stop_managed_proxy(state: &ProxyState, expected_pid: Option<u32>) -> Result<StopStatus, String> {
    let mut guard = lock_or_recover(&state.child);
    let Some(child) = guard.as_ref() else {
        return Ok(StopStatus::NotRunning);
    };
    if expected_pid.is_some_and(|pid| pid != child.id()) {
        return Err("代理进程已更换，本次停止操作未执行".into());
    }
    match child.kill()? {
        StopOutcome::Exited => {}
        // 进程未确认退出时必须保留 child：清理后会把「仍在运行」误报成「已停止」。
        StopOutcome::Pending { pid, waited_ms } => {
            return Ok(StopStatus::Unconfirmed { pid, waited_ms })
        }
    }
    *guard = None;
    *lock_or_recover(&state.target_ide) = String::new();
    *lock_or_recover(&state.ports) = None;
    Ok(StopStatus::Stopped)
}

pub fn stop_proxy_service_impl(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ProxyState>();
    match stop_managed_proxy(&state, None)? {
        StopStatus::Stopped => {
            let _ = app.emit("proxy-stopped", ());
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "ok".into(),
                    msg: "网关服务已停止，平台配置未改动".into(),
                },
            );
            Ok(())
        }
        StopStatus::NotRunning => Err("网关未运行".into()),
        StopStatus::Unconfirmed { pid, waited_ms } => Err(format!(
            "{}；请稍后重试",
            unconfirmed_stop_hint(pid, waited_ms)
        )),
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IdeProxyModeReport {
    pub ide_config: String,
    pub workbench_inject: String,
    pub cursor_auth: String,
}

pub fn switch_ide_to_proxy_impl(
    app: AppHandle,
    target: String,
) -> Result<IdeProxyModeReport, String> {
    if target != "windsurf" && target != "devin" && target != "cursor" {
        return Err(format!("暂不支持的 IDE: {}", target));
    }
    let mut report = IdeProxyModeReport::default();

    if target == "cursor" {
        return Err(
            "Cursor 已迁移到独立 Cursor Core，请使用 cursor_enable；旧入口已停用且不会再改写账号状态。"
                .into(),
        );
    }

    report.cursor_auth = "ok（无需 Cursor auth）".into();
    report.ide_config = match crate::commands::ide_config::patch(&target) {
        Ok(true) => "updated".into(),
        Ok(false) => "ok".into(),
        Err(e) => return Err(format!("写入 IDE 网关配置失败: {}", e)),
    };

    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));
    report.workbench_inject = if let Some(res) = resource_dir {
        let script_path = res.join("byok-cards.js");
        match std::fs::read_to_string(&script_path) {
            Ok(script) => match crate::commands::workbench_inject::inject(&script, &target) {
                Ok(true) => "updated".into(),
                Ok(false) => "ok".into(),
                Err(e) => format!("warn: {}", e),
            },
            Err(e) => format!("warn: 读取 byok-cards.js 失败: {}", e),
        }
    } else {
        "warn: 资源目录不可用".into()
    };

    Ok(report)
}

pub fn restore_ide_direct_impl(app: AppHandle, target: String) -> Result<RestoreReport, String> {
    if target != "windsurf" && target != "devin" && target != "cursor" {
        return Err(format!("暂不支持的 IDE: {}", target));
    }
    let state = app.state::<ProxyState>();
    Ok(restore_all(&state, &target))
}
