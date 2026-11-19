use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use super::*;
use super::service_and_cmds::{
    restore_ide_direct_impl, start_proxy_service_impl, stop_proxy_service_impl,
    switch_ide_to_proxy_impl, IdeProxyModeReport,
};

#[tauri::command]
pub async fn start_proxy(
    app: AppHandle,
    _target_ide: Option<String>,
    _skip_preflight: Option<bool>,
) -> Result<bool, String> {
    // 兼容旧前端命令名，但语义已经收敛为“只启动本地网关”。
    // IDE 切换必须走 switch_ide_to_proxy，避免全局开关隐式改写 IDE 配置。
    tauri::async_runtime::spawn_blocking(move || start_proxy_service_impl(app))
        .await
        .map_err(|e| format!("启动网关服务任务失败: {e}"))?
}

#[allow(dead_code)]
pub fn stop_proxy_impl(
    app: AppHandle,
    _target_ide: Option<String>,
) -> Result<RestoreReport, String> {
    let state = app.state::<ProxyState>();
    let mut child_guard = lock_or_recover(&state.child);
    if let Some(child) = child_guard.as_ref() {
        // 先确认进程已退出，再释放句柄或还原 IDE，避免代理仍运行时状态已被误报为停止。
        match child.kill()? {
            StopOutcome::Exited => {}
            StopOutcome::Pending { pid, waited_ms } => {
                // 进程还活着就还原 IDE 配置会立刻被运行中的网关重新改写，这里如实报错。
                return Err(format!(
                    "{}；IDE 配置未还原，请稍后重试停止网关",
                    unconfirmed_stop_hint(pid, waited_ms)
                ));
            }
        }
        // 还原 IDE 配置：使用 start_proxy 时保存的 target_ide，
        // 而非重新检测或参数传入值——确保还原目标与打补丁时一致。
        let target = lock_or_recover(&state.target_ide).clone();
        *child_guard = None;
        *lock_or_recover(&state.target_ide) = String::new();
        *lock_or_recover(&state.ports) = None;
        if target.is_empty() || (target != "windsurf" && target != "devin" && target != "cursor") {
            eprintln!("[stop_proxy] target_ide 异常: '{}', 跳过还原", target);
            let _ = app.emit("proxy-stopped", ());
            return Ok(RestoreReport::default());
        }
        let report = restore_all(&state, &target);

        // 如果还原有警告，通过事件通知前端（同时返回值也携带报告）。
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
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("⚠ 还原警告: {}", warnings.join("；")),
                },
            );
        }

        // 通知前端代理已停止（与监控线程的 proxy-stopped 对齐）
        let _ = app.emit("proxy-stopped", ());

        Ok(report)
    } else {
        Err("网关未运行".into())
    }
}

#[tauri::command]
pub async fn stop_proxy(
    app: AppHandle,
    _target_ide: Option<String>,
) -> Result<RestoreReport, String> {
    // 兼容旧前端命令名，但停止全局代理时不再还原 IDE 配置。
    // IDE 还原必须走 restore_ide_direct，由用户在平台页显式触发。
    tauri::async_runtime::spawn_blocking(move || {
        stop_proxy_service_impl(app)?;
        Ok(RestoreReport::default())
    })
    .await
    .map_err(|e| format!("停止网关服务任务失败: {e}"))?
}

#[tauri::command]
pub async fn start_proxy_service(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || start_proxy_service_impl(app))
        .await
        .map_err(|e| format!("启动网关服务任务失败: {e}"))?
}

#[tauri::command]
pub async fn stop_proxy_service(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_proxy_service_impl(app))
        .await
        .map_err(|e| format!("停止网关服务任务失败: {e}"))?
}

#[tauri::command]
pub async fn restart_proxy_service(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match stop_proxy_service_impl(app.clone()) {
            Ok(()) => {}
            Err(e) if e == "网关未运行" => {}
            Err(e) => return Err(e),
        }
        start_proxy_service_impl(app)
    })
    .await
    .map_err(|e| format!("重启网关服务任务失败: {e}"))?
}

#[tauri::command]
pub async fn switch_ide_to_proxy(
    app: AppHandle,
    target: String,
) -> Result<IdeProxyModeReport, String> {
    tauri::async_runtime::spawn_blocking(move || switch_ide_to_proxy_impl(app, target))
        .await
        .map_err(|e| format!("切换 IDE 到代理任务失败: {e}"))?
}

#[tauri::command]
pub async fn restore_ide_direct(app: AppHandle, target: String) -> Result<RestoreReport, String> {
    tauri::async_runtime::spawn_blocking(move || restore_ide_direct_impl(app, target))
        .await
        .map_err(|e| format!("还原 IDE 直连任务失败: {e}"))?
}

/// 强杀所有 AnyBridge sidecar 孤儿进程（启动时 / 升级前调用）。
/// 与 ManagedChild::kill() 不同：这里不依赖 state 里记录的 PID，
/// 而是按进程名全盘扫描，确保上一轮崩溃或异常退出后残留的 sidecar 不会锁住 exe 文件。
pub fn kill_sidecar_process() {
    #[cfg(target_os = "windows")]
    {
        for process_name in ["anybridge-proxy.exe", "ide-byok-proxy.exe"] {
            let out = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/IM", process_name])
                .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    eprintln!("[cleanup] 已清理孤儿 sidecar 进程: {}", process_name);
                }
                Ok(_) => {
                    // 进程不存在（taskkill 返回错误码 128），属正常情况
                }
                Err(e) => {
                    eprintln!("[cleanup] taskkill 执行失败: {}", e);
                }
            }
        }
        // dev 模式:额外清理跑 sidecar/proxy-entry.js 的 node 进程
        // (release 模式这步是多余的,因为 node 进程由 exe 启动,exe 退出时 node 也会退出)
        #[cfg(debug_assertions)]
        {
            // wmic 在 Win11 已弃用，改用 PowerShell Get-CimInstance
            let ps_script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Select-Object ProcessId, CommandLine |
  ForEach-Object { "$($_.ProcessId),$($_.CommandLine)" }
"#;
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
                .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                .output();
            if let Ok(o) = out {
                if o.status.success() {
                    let text = String::from_utf8_lossy(&o.stdout);
                    for line in text.lines() {
                        let line = line.trim();
                        if line.is_empty() { continue; }
                        // 格式: "PID,CommandLine"
                        if line.contains("proxy-entry.js")
                            || line.contains("sidecar\\hybrid-server.js")
                        {
                            // 提 ProcessId (第一个逗号前)
                            if let Some(pid_str) = line.split(',').next() {
                                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                                    let _ = std::process::Command::new("taskkill")
                                        .args(["/F", "/T", "/PID", &pid.to_string()])
                                        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                                        .output();
                                    eprintln!(
                                        "[cleanup] 已清理 dev 模式 sidecar node 进程: PID {}",
                                        pid
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for process_name in ["anybridge-proxy", "ide-byok-proxy"] {
            let _ = std::process::Command::new("pkill")
                .args(["-f", process_name])
                .output();
        }

        #[cfg(debug_assertions)]
        {
            for script_name in [
                "sidecar/proxy-entry.js",
                "sidecar/hybrid-server.js",
                "sidecar/inference-proxy.js",
            ] {
                let _ = std::process::Command::new("pkill")
                    .args(["-f", script_name])
                    .output();
            }
        }
    }
}

pub fn stop_sidecar_for_update(app: AppHandle) -> Result<(), String> {
    match stop_proxy_service_impl(app.clone()) {
        Ok(()) => {}
        Err(e) if e == "网关未运行" => {}
        Err(e) => return Err(format!("停止网关服务失败，无法继续安装更新: {}", e)),
    }

    kill_sidecar_process();
    std::thread::sleep(Duration::from_millis(1000));

    let leftovers = running_sidecar_process_names();
    if !leftovers.is_empty() {
        return Err(format!(
            "更新前无法停止后台代理进程: {}。请退出 AnyBridge 后重试，或手动结束这些进程。",
            leftovers.join(", ")
        ));
    }

    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: "更新安装前已暂停本地网关服务".into(),
        },
    );
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn running_sidecar_process_names() -> Vec<String> {
    let mut running = Vec::new();
    for process_name in ["anybridge-proxy.exe", "ide-byok-proxy.exe"] {
        let output = std::process::Command::new("tasklist")
            .args([
                "/FI",
                &format!("IMAGENAME eq {}", process_name),
                "/FO",
                "CSV",
                "/NH",
            ])
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .output();
        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if stdout.contains(&process_name.to_lowercase()) {
                running.push(process_name.to_string());
            }
        }
    }
    running
}

#[cfg(not(target_os = "windows"))]
pub(super) fn running_sidecar_process_names() -> Vec<String> {
    let mut running = Vec::new();
    for process_name in ["anybridge-proxy", "ide-byok-proxy"] {
        let output = std::process::Command::new("pgrep")
            .args(["-x", process_name])
            .output();
        if output.is_ok_and(|output| output.status.success()) {
            running.push(process_name.to_string());
        }
    }
    running
}

#[tauri::command]
pub async fn get_stats(state: State<'_, ProxyState>) -> Result<serde_json::Value, String> {
    let port = active_or_configured_ports(state.inner()).api_port;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://127.0.0.1:{}/__byok/stats", port))
        .send()
        .await
        .map_err(|e| format!("代理未响应: {}", e))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}
