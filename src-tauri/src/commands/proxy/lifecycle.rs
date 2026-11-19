use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use super::*;
use super::health_probes::*;
use super::preflight_env::{emit_preflight_report, run_proxy_preflight};

pub(super) fn current_target_triple() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("x86_64-pc-windows-msvc");
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some("aarch64-pc-windows-msvc");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("x86_64-apple-darwin");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("aarch64-apple-darwin");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some("x86_64-unknown-linux-gnu");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some("aarch64-unknown-linux-gnu");
    }
    #[allow(unreachable_code)]
    None
}

pub(super) fn sidecar_file_candidates() -> Vec<String> {
    let exe_suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let mut files = vec![
        format!("anybridge-proxy{}", exe_suffix),
        format!("ide-byok-proxy{}", exe_suffix),
    ];
    if let Some(triple) = current_target_triple() {
        files.push(format!("anybridge-proxy-{}{}", triple, exe_suffix));
        files.push(format!("ide-byok-proxy-{}{}", triple, exe_suffix));
    }
    files
}

/// 解析 sidecar 二进制路径。
/// 与 tauri_plugin_shell 的 relative_command_path 逻辑一致：
/// 基于 current_exe 所在目录查找，文件名不带 target triple 后缀
/// （Tauri 构建脚本会自动将 binaries/ 下带后缀的文件重命名后复制到 exe 旁边）。
pub(super) fn resolve_sidecar_path() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("当前 exe 路径无父目录")?;

    // 测试模式下 exe 在 deps/ 子目录，需要上一级
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };

    let sidecar_files = sidecar_file_candidates();
    for sidecar_file in sidecar_files {
        let path = base_dir.join(&sidecar_file);
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "sidecar 二进制不存在: {}",
        base_dir
            .join(&sidecar_file_candidates()[0])
            .to_string_lossy()
    ))
}

#[tauri::command]
pub fn get_proxy_status(state: State<ProxyState>) -> ProxyStatus {
    let mut running = false;
    {
        let guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            // child 存在但进程可能已退出（监控线程尚未清理），用 try_wait 确认
            running = managed.try_wait().ok().flatten().is_none();
        }
    }
    let target_ide = if running {
        lock_or_recover(&state.target_ide).clone()
    } else {
        String::new()
    };
    let ports = if running {
        active_or_configured_ports(&state)
    } else {
        configured_ports()
    };
    ProxyStatus {
        running,
        target_ide,
        api_port: ports.api_port,
        inference_port: ports.inference_port,
    }
}

/// 本地回环端口是否有进程在监听。
///
/// 用真实 TCP 连通性判断，而不是只看托管 child：sidecar 可能由上一轮进程或
/// 外部手工启动，child 句柄丢失但端口仍在服务。若按 child 状态误判为「未运行」
/// 再去 start_proxy_service_impl，会 kill 掉正在给其它客户端供流的 sidecar。
pub(crate) fn proxy_port_listening(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// 确保本地网关服务可用：端口已监听直接返回，未监听则拉起并复检。
///
/// **单一入口**：Cursor Core 启动、Codex Desktop CDP 注入等「必须依赖 sidecar」的链路
/// 一律调用本函数，禁止各自再复制一份「探测 + 启动」逻辑。
/// 事故背景（坑点 codex-inject-requires-proxy）：Codex 侧曾漏掉前置检查，网关服务
/// 未运行时直接向 7450 发注入请求，用户只看到 `os error 10061`，且客户端已被先 kill 重启。
pub(crate) fn ensure_proxy_service_ready(app: &AppHandle) -> Result<(), String> {
    let ports = configured_ports();
    if proxy_port_listening(ports.api_port) {
        return Ok(());
    }
    if get_proxy_status(app.state::<ProxyState>()).running {
        // 进程活着但端口不通：不能在这里重启（可能正处于 MITM 自检），如实报错交上层引导。
        return Err(format!(
            "本地网关服务进程在运行，但端口 {} 不可达",
            ports.api_port
        ));
    }
    start_proxy_service_impl(app.clone())?;
    if proxy_port_listening(ports.api_port) {
        Ok(())
    } else {
        Err(format!("本地网关服务启动后端口 {} 仍不可达", ports.api_port))
    }
}

#[allow(dead_code)]
pub fn start_proxy_impl(
    app: AppHandle,
    target_ide: Option<String>,
    skip_preflight: bool,
) -> Result<bool, String> {
    let state = app.state::<ProxyState>();

    // TOCTOU 防护：检查"已运行 / 正在启动",并在同一临界区抢占 starting 标志。
    // 注意：child 存在不代表进程还活着，需 try_wait 确认（进程意外退出但监控线程尚未清理时）。
    {
        let mut guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            if managed.try_wait().ok().flatten().is_none() {
                // 进程仍在运行
                return Err("网关已在运行".into());
            }
            // 进程已退出但 child 未清理，先清理再允许启动
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

    // 解析目标 IDE（auto 模式需实际检测），校验只允许 windsurf/devin。
    let target = match resolve_target_ide_arg(target_ide.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            clear_starting();
            return Err(e);
        }
    };

    let config_dir = crate::commands::config::config_dir_path();
    let ports = configured_ports();
    // 记录用户请求值和解析结果，便于区分自动检测/保存配置导致的目标 IDE 偏差。
    let requested_target = target_ide.as_deref().unwrap_or("saved/auto");
    let settings_path = crate::commands::ide_config::settings_path(&target);
    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: format!(
                "网关启动诊断: requested_target={} resolved_target={} settings={} api_port={} inference_port={}",
                requested_target,
                target,
                settings_path
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "unresolved".into()),
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

    // 再清一次孤儿 sidecar，处理上一轮异常退出但主应用仍在的情况。
    kill_sidecar_process();

    if !skip_preflight {
        // 启动预检可修复 IDE 配置等项目，但证书包和系统信任必须只读检查。
        let preflight = match run_proxy_preflight(
            Some(&target),
            resource_dir.as_deref(),
            RepairScope::IdeConfig,
        ) {
            Ok(r) => r,
            Err(e) => {
                clear_starting();
                return Err(e);
            }
        };
        emit_preflight_report(&app, &preflight);
        if !preflight.ok {
            clear_starting();
            let first = preflight
                .issues
                .iter()
                .find(|i| i.level == "err")
                .map(|i| i.message.clone())
                .unwrap_or_else(|| "存在启动自检错误".into());
            return Err(format!("启动自检未通过: {}", first));
        }
    }

    // 解析 sidecar 启动方式
    // dev 模式 (debug_assertions): 直接 node 跑源码 sidecar,改 js 立即生效,免去每次打包 exe
    // release 模式: spawn pkg 打包的 anybridge-proxy.exe
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
            // Windows: 设置进程创建标志，阻止 CMD 窗口弹出
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
            // 仅 Windows 的 creation_flags 需要可变 Command；Unix 保持不可变以避免平台警告。
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

    // 捕获 stdout/stderr 用于日志转发
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            clear_starting();
            return Err(format!("启动失败: {}", e));
        }
    };

    // 在写入 state 之前取出管道（避免锁竞争）
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // 记录本轮进程身份，后续监控及健康检查失败只能处理这一个进程。
    let proxy_pid = child.id();

    // 写入 child 并清除 starting 标志
    *lock_or_recover(&state.child) = Some(ManagedChild {
        child: Mutex::new(child),
        _package_lock: package_lock,
    });
    *lock_or_recover(&state.target_ide) = target.clone();
    *lock_or_recover(&state.ports) = Some(ports);
    clear_starting();

    // 打补丁：写入 IDE 网关配置（失败不阻断网关启动，仅记日志）。
    let ide_label = if target_ide.as_deref() == Some("auto") {
        format!("自动检测→{}", target)
    } else {
        target.clone()
    };
    let patched = match crate::commands::ide_config::patch(&target) {
        Ok(true) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "ok".into(),
                    msg: format!("✅ 已写入 {} 网关配置，请重启 IDE 生效", ide_label),
                },
            );
            true
        }
        Ok(false) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "info".into(),
                    msg: format!(
                        "{} 网关配置已存在，若模型仍是原样请重启 IDE 并确认当前目标 IDE 正确",
                        ide_label
                    ),
                },
            );
            false
        }
        Err(e) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("⚠ 写入 {} 配置失败: {}", ide_label, e),
                },
            );
            false
        }
    };
    // 回读落盘配置，确认网关地址和 Devin 专用设置确实写入目标 IDE 的 settings 文件。
    match crate::commands::ide_config::status(&target) {
        Ok(status) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: if status.patched { "info" } else { "warn" }.into(),
                    msg: format!(
                        "IDE 配置复核: target={} patched={} proxy={} settings={}",
                        target,
                        status.patched,
                        status.proxy_value,
                        status.settings_path,
                    ),
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("IDE 配置复核失败: target={} error={}", target, error),
                },
            );
        }
    }

    // 注入卡片改写脚本到 workbench.html（失败不阻断网关启动，仅记日志）。
    if target == "cursor" {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "info".into(),
                msg: "Cursor 接入不需要 workbench.html 模型卡片注入".into(),
            },
        );
    } else if let Some(res) = &resource_dir {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "info".into(),
                msg: format!(
                    "网关配置目录: {}；资源目录: {}",
                    config_dir.to_string_lossy(),
                    res.to_string_lossy()
                ),
            },
        );
        let script_path = res.join("byok-cards.js");
        match std::fs::read_to_string(&script_path) {
            Ok(script) => match crate::commands::workbench_inject::inject(&script, &target) {
                Ok(true) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "ok".into(),
                            msg: format!("✅ 已注入模型卡片改写脚本，请重启 {} 生效", ide_label),
                        },
                    );
                }
                Ok(false) => {}
                Err(e) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "warn".into(),
                            msg: format!("⚠ 注入卡片脚本失败: {}", e),
                        },
                    );
                }
            },
            Err(e) => {
                let _ = app.emit(
                    "proxy-log",
                    LogLine {
                        level: "warn".into(),
                        msg: format!("⚠ 读取 byok-cards.js 失败: {}", e),
                    },
                );
            }
        }
    }

    // stdout/stderr 必须并行读取。sidecar 长期运行，stdout 不会 EOF；
    // 若串行读取，stderr 管道填满后会反向阻塞网关进程。
    spawn_log_reader(app.clone(), stdout);
    spawn_log_reader(app.clone(), stderr);

    // 启动监控线程：轮询进程退出状态
    let app_handle2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));

        let exit_status = if let Some(state) = app_handle2.try_state::<ProxyState>() {
            let guard = lock_or_recover(&state.child);
            match guard.as_ref() {
                Some(managed) if managed.id() == proxy_pid => managed.try_wait().ok().flatten(),
                Some(_) => break,
                // child 为 None 说明 stop_proxy 已 take 走了 child 并负责清理，
                // 这里直接退出循环，不再误判为进程退出。
                None => {
                    break;
                }
            }
        } else {
            break;
        };

        if let Some(status) = exit_status {
            // 进程真正退出后的清理
            if let Some(state) = app_handle2.try_state::<ProxyState>() {
                let mut guard = lock_or_recover(&state.child);
                // 轮询与清理之间可能已经重启，持锁复核身份后才允许清除状态和还原 IDE。
                if guard.as_ref().map(ManagedChild::id) != Some(proxy_pid) {
                    break;
                }
                *guard = None;
                let target = lock_or_recover(&state.target_ide).clone();
                // 清除 target_ide
                *lock_or_recover(&state.target_ide) = String::new();
                *lock_or_recover(&state.ports) = None;
                if target.is_empty()
                    || (target != "windsurf" && target != "devin" && target != "cursor")
                {
                    eprintln!("[monitor] target_ide 异常: '{}', 跳过还原", target);
                } else {
                    let report = restore_all(&state, &target);
                    if report.has_warning() {
                        let mut warnings = Vec::new();
                        if !report.ide_config.starts_with("ok") {
                            warnings.push(report.ide_config.clone());
                        }
                        if !report.workbench_inject.starts_with("ok") {
                            warnings.push(report.workbench_inject.clone());
                        }
                        if !report.cursor_auth.starts_with("ok") {
                            warnings.push(report.cursor_auth.clone());
                        }
                        let _ = app_handle2.emit(
                            "proxy-log",
                            LogLine {
                                level: "warn".into(),
                                msg: format!("⚠ 还原警告: {}", warnings.join("；")),
                            },
                        );
                    }
                }
            }
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
        Some(format!(
            "网关主端口 {} 未监听，IDE 无法接入 AnyBridge 网关",
            ports.api_port
        ))
    } else {
        probe_byok_stats(ports.api_port, Duration::from_secs(2))
            .map_err(|failure| failure.message)
            .err()
    };

    if let Some(e) = health_error {
        let stop = stop_managed_proxy(&state, Some(proxy_pid))
            .map_err(|stop_error| format!("网关自检失败: {}；未能确认本轮网关停止: {}", e, stop_error))?;
        if let StopStatus::Unconfirmed { pid, waited_ms } = stop {
            return Err(format!(
                "网关自检失败: {}；{}",
                e,
                unconfirmed_stop_hint(pid, waited_ms)
            ));
        }
        let report = restore_all(&state, &target);
        *lock_or_recover(&state.target_ide) = String::new();
        *lock_or_recover(&state.ports) = None;
        let _ = app.emit("proxy-stopped", ());
        let mut msg = format!("网关启动失败: {}", e);
        if report.has_warning() {
            msg.push_str(&format!(
                "；自动回滚时有警告: IDE配置={}, 卡片注入={}, Cursor状态={}",
                report.ide_config, report.workbench_inject, report.cursor_auth
            ));
        }
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "err".into(),
                msg: msg.clone(),
            },
        );
        return Err(msg);
    }

    // 本地健康检查只证明 sidecar 可用；真实 IDE 接管需等待模型状态请求心跳。
    if missing_ports.is_empty() {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: format!(
                    "✅ 网关健康检查通过: target={} pid={} {}；IDE 请求心跳将在收到 Devin/Windsurf 模型状态请求后更新",
                    target,
                    proxy_pid,
                    port_pair_text(ports),
                ),
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

    Ok(patched)
}

