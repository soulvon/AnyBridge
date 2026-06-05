use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// DETACHED_PROCESS: 子进程不继承父进程控制台，也不会创建新控制台。
/// 对 console subsystem 的二进制（如 pkg 打包的 Node.js）也能阻止 CMD 窗口弹出。
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// CREATE_NO_WINDOW: 如果进程没有控制台，不创建新控制台窗口。
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// CREATE_NEW_PROCESS_GROUP: 创建新进程组，避免子进程继承父进程的 Ctrl+C 信号。
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// 自定义子进程包装，提供 kill 能力。
pub struct ManagedChild {
    child: Mutex<std::process::Child>,
}

impl ManagedChild {
    fn kill(&self) -> Result<(), String> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kill()
            .map_err(|e| format!("停止失败: {}", e))
    }

    fn try_wait(&self) -> Result<Option<std::process::ExitStatus>, String> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait()
            .map_err(|e| format!("检查进程状态失败: {}", e))
    }
}

#[derive(Default)]
pub struct ProxyState {
    pub child: Mutex<Option<ManagedChild>>,
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

/// 解析 sidecar 二进制路径。
/// 与 tauri_plugin_shell 的 relative_command_path 逻辑一致：
/// 基于 current_exe 所在目录查找，文件名不带 target triple 后缀
/// （Tauri 构建脚本会自动将 binaries/ 下带后缀的文件重命名后复制到 exe 旁边）。
fn resolve_sidecar_path() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("当前 exe 路径无父目录")?;

    // 测试模式下 exe 在 deps/ 子目录，需要上一级
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };

    let sidecar_name = "ide-byok-proxy";

    #[cfg(target_os = "windows")]
    let sidecar_file = format!("{}.exe", sidecar_name);
    #[cfg(not(target_os = "windows"))]
    let sidecar_file = sidecar_name.to_string();

    let path = base_dir.join(&sidecar_file);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("sidecar 二进制不存在: {}", path.to_string_lossy()))
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
    {
        let guard = lock_or_recover(&state.child);
        if guard.is_some() {
            return Err("代理已在运行".into());
        }
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("代理正在启动中".into());
        }
    }
    let clear_starting = || state.starting.store(false, Ordering::SeqCst);

    let config_dir = crate::commands::config::config_dir_path();

    let resource_dir = app
        .path()
        .resource_dir()
        .map(|p| p.join("resources"))
        .ok();

    // 解析 sidecar 路径
    let sidecar_path = match resolve_sidecar_path() {
        Ok(p) => p,
        Err(e) => {
            clear_starting();
            return Err(e);
        }
    };

    let mut cmd = std::process::Command::new(&sidecar_path);

    // Windows: 设置进程创建标志，阻止 CMD 窗口弹出
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    cmd.env("BYOK_CONFIG_DIR", config_dir.to_string_lossy().to_string());
    if let Some(res) = &resource_dir {
        cmd.env("BYOK_RESOURCE_DIR", res.to_string_lossy().to_string());
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

    // 写入 child 并清除 starting 标志
    *lock_or_recover(&state.child) = Some(ManagedChild {
        child: Mutex::new(child),
    });
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

    // 启动后台线程：读取 stdout/stderr 并转发为 Tauri 事件
    let app_handle = app.clone();
    std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().flatten() {
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
        }
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().flatten() {
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
        }
    });

    // 启动监控线程：轮询进程退出状态
    let app_handle2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));

        let exited = if let Some(state) = app_handle2.try_state::<ProxyState>() {
            let guard = lock_or_recover(&state.child);
            match guard.as_ref() {
                Some(managed) => managed.try_wait().ok().flatten().is_some(),
                None => true, // child 已被清除
            }
        } else {
            true
        };

        if exited {
            // 进程退出后的清理
            if let Some(state) = app_handle2.try_state::<ProxyState>() {
                *lock_or_recover(&state.child) = None;
                restore_all(&state);
            }
            let _ = app_handle2.emit("proxy-stopped", ());
            break;
        }
    });

    Ok(patched)
}

#[tauri::command]
pub fn stop_proxy(state: State<ProxyState>) -> Result<(), String> {
    let child = lock_or_recover(&state.child).take();
    if let Some(child) = child {
        child.kill()?;
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
