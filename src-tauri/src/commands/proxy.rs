use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct ProxyState {
    pub child: Mutex<Option<CommandChild>>,
    /// 占位标志：spawn 是 IO 不能持锁，用它防止 start_proxy 并发时双 spawn（TOCTOU）。
    pub starting: AtomicBool,
    /// 串行化 Windsurf 配置/注入的还原：stop_proxy 与 Terminated 事件可能并发 restore，
    /// 非原子的读-改-写会互相覆盖，用此锁串行化。
    pub restore_lock: Mutex<()>,
}

/// 取锁并容忍 poisoning：某线程持锁时 panic 不应让后续所有代理操作永久 panic。
fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 串行还原 Windsurf 配置与 workbench 注入（幂等）。
fn restore_all(state: &ProxyState) {
    let _guard = lock_or_recover(&state.restore_lock);
    let _ = crate::commands::windsurf_config::restore();
    let _ = crate::commands::workbench_inject::restore();
}

#[derive(Serialize, Clone)]
pub struct ProxyStatus {
    pub running: bool,
    pub api_port: u16,
    pub inference_port: u16,
}

#[derive(Serialize, Clone)]
struct LogLine {
    level: String,
    msg: String,
}

fn classify(line: &str) -> String {
    if line.contains('❌') || line.contains("Error") || line.contains("ERROR") || line.contains("[ERR")
    {
        "err".into()
    } else if line.contains('⚠') || line.contains("Warn") || line.contains("WARN") {
        "warn".into()
    } else if line.contains('✅') || line.contains('⚡') || line.contains('→') {
        "ok".into()
    } else {
        "info".into()
    }
}

#[tauri::command]
pub fn get_proxy_status(state: State<ProxyState>) -> ProxyStatus {
    let running = lock_or_recover(&state.child).is_some();
    ProxyStatus {
        running,
        api_port: 7450,
        inference_port: 7451,
    }
}

#[tauri::command]
pub fn start_proxy(app: AppHandle, state: State<ProxyState>) -> Result<bool, String> {
    // TOCTOU 防护：检查"已运行 / 正在启动",并在同一临界区抢占 starting 标志。
    // spawn 是 IO 不能持 child 锁全程，故用 starting 占位避免并发双 spawn。
    {
        let guard = lock_or_recover(&state.child);
        if guard.is_some() {
            return Err("代理已在运行".into());
        }
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("代理正在启动中".into());
        }
    }
    // 从这里到写入 child / 清除 starting 之间任何提前返回都必须清 starting。
    let clear_starting = || state.starting.store(false, Ordering::SeqCst);

    let config_dir = crate::commands::config::config_dir_path();

    let resource_dir = app
        .path()
        .resource_dir()
        .map(|p| p.join("resources"))
        .ok();

    let sidecar_res = app
        .shell()
        .sidecar("ide-byok-proxy");
    let mut sidecar = match sidecar_res {
        Ok(s) => s.env("BYOK_CONFIG_DIR", config_dir.to_string_lossy().to_string()),
        Err(e) => {
            clear_starting();
            return Err(format!("sidecar 未找到: {}", e));
        }
    };

    if let Some(res) = &resource_dir {
        sidecar = sidecar.env("BYOK_RESOURCE_DIR", res.to_string_lossy().to_string());
    }

    let (mut rx, child) = match sidecar.spawn() {
        Ok(v) => v,
        Err(e) => {
            clear_starting();
            return Err(format!("启动失败: {}", e));
        }
    };

    // 写入 child 并清除 starting 标志（启动序列完成）。
    *lock_or_recover(&state.child) = Some(child);
    clear_starting();

    // 打补丁：写入 Windsurf 代理配置（失败不阻断代理启动，仅记日志）。
    let patched = match crate::commands::windsurf_config::patch() {
        Ok(true) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "ok".into(),
                    msg: "✅ 已写入 Windsurf 代理配置，请重启 Windsurf 生效".into(),
                },
            );
            true
        }
        Ok(false) => false,
        Err(e) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("⚠ 写入 Windsurf 配置失败: {}", e),
                },
            );
            false
        }
    };

    // 注入卡片改写脚本到 workbench.html（失败不阻断代理启动，仅记日志）。
    if let Some(res) = &resource_dir {
        let script_path = res.join("byok-cards.js");
        match std::fs::read_to_string(&script_path) {
            Ok(script) => match crate::commands::workbench_inject::inject(&script) {
                Ok(true) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "ok".into(),
                            msg: "✅ 已注入模型卡片改写脚本，请重启 Windsurf 生效".into(),
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

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let _ = app_handle.emit(
                        "proxy-log",
                        LogLine {
                            level: classify(trimmed),
                            msg: trimmed.to_string(),
                        },
                    );
                }
                CommandEvent::Terminated(_) => {
                    if let Some(state) = app_handle.try_state::<ProxyState>() {
                        *lock_or_recover(&state.child) = None;
                        // 崩溃/意外退出也要还原 Windsurf 配置，避免指向死端口。
                        restore_all(&state);
                    }
                    let _ = app_handle.emit("proxy-stopped", ());
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(patched)
}

#[tauri::command]
pub fn stop_proxy(state: State<ProxyState>) -> Result<(), String> {
    let child = lock_or_recover(&state.child).take();
    if let Some(child) = child {
        child.kill().map_err(|e| format!("停止失败: {}", e))?;
        // 还原 Windsurf 配置（幂等且与 Terminated 分支串行化，无备份则空操作）。
        restore_all(&state);
        Ok(())
    } else {
        Err("代理未运行".into())
    }
}

#[tauri::command]
pub async fn get_stats() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("http://127.0.0.1:7450/__byok/stats")
        .send()
        .await
        .map_err(|e| format!("代理未响应: {}", e))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}
