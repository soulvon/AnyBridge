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
    pub fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());

        // Windows release 模式下 sidecar 以 CREATE_NEW_PROCESS_GROUP 启动，
        // std::process::Child::kill() 只调用 TerminateProcess 杀单进程，
        // 无法清理子进程树（pkg 打包的 Node.js 可能 spawn 了子进程）。
        // 使用 taskkill /F /T /PID 可杀整个进程树。
        #[cfg(target_os = "windows")]
        {
            let pid = child.id();
            let out = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            match out {
                Ok(o) if o.status.success() => return Ok(()),
                Ok(o) => {
                    // taskkill 失败（进程可能已退出），尝试 TerminateProcess 兜底
                    eprintln!(
                        "[stop_proxy] taskkill 失败: {}, 尝试 TerminateProcess",
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                }
                Err(e) => {
                    eprintln!(
                        "[stop_proxy] taskkill 执行失败: {}, 尝试 TerminateProcess",
                        e
                    );
                }
            }
        }

        child.kill().map_err(|e| format!("停止失败: {}", e))
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
    /// 串行化 IDE 配置/注入的还原：stop_proxy 与 Terminated 事件可能并发 restore，
    /// 非原子的读-改-写会互相覆盖，用此锁串行化。
    pub restore_lock: Mutex<()>,
    /// 当前目标 IDE（用于进程退出时的还原）
    pub target_ide: Mutex<String>,
}

/// 取锁并容忍 poisoning：某线程持锁时 panic 不应让后续所有代理操作永久 panic。
pub fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 还原结果：哪些步骤失败、哪些步骤找不到备份。
#[derive(Serialize, Clone, Default)]
pub struct RestoreReport {
    /// IDE 代理配置还原结果
    pub ide_config: String,
    /// workbench.html 注入还原结果
    pub workbench_inject: String,
}

impl RestoreReport {
    fn has_warning(&self) -> bool {
        self.ide_config != "ok" || self.workbench_inject != "ok"
    }
}

/// 串行还原 IDE 配置与 workbench 注入（幂等）。
/// 返回还原报告，调用方可据此向用户发出警告。
fn restore_all(state: &ProxyState, target: &str) -> RestoreReport {
    let _guard = lock_or_recover(&state.restore_lock);
    let mut report = RestoreReport::default();

    match crate::commands::ide_config::restore(target) {
        Ok(true) => report.ide_config = "ok".into(),
        Ok(false) => report.ide_config = "未找到备份，IDE 代理配置可能未被还原".into(),
        Err(e) => report.ide_config = format!("还原失败: {}", e),
    }

    match crate::commands::workbench_inject::restore(target) {
        Ok(true) => report.workbench_inject = "ok".into(),
        Ok(false) => report.workbench_inject = "ok（无需还原）".into(),
        Err(e) => report.workbench_inject = format!("还原失败: {}", e),
    }

    report
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
    if line.contains('❌')
        || line.contains("Error")
        || line.contains("ERROR")
        || line.contains("[ERR")
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
    let mut running = false;
    {
        let guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            // child 存在但进程可能已退出（监控线程尚未清理），用 try_wait 确认
            running = managed.try_wait().ok().flatten().is_none();
        }
    }
    ProxyStatus {
        running,
        api_port: 7450,
        inference_port: 7451,
    }
}

#[tauri::command]
pub fn start_proxy(
    app: AppHandle,
    state: State<ProxyState>,
    target_ide: Option<String>,
) -> Result<bool, String> {
    // TOCTOU 防护：检查"已运行 / 正在启动",并在同一临界区抢占 starting 标志。
    // 注意：child 存在不代表进程还活着，需 try_wait 确认（进程意外退出但监控线程尚未清理时）。
    {
        let guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            if managed.try_wait().ok().flatten().is_none() {
                // 进程仍在运行
                return Err("代理已在运行".into());
            }
            // 进程已退出但 child 未清理，先清理再允许启动
            drop(guard);
            *lock_or_recover(&state.child) = None;
        }
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("代理正在启动中".into());
        }
    }
    let clear_starting = || state.starting.store(false, Ordering::SeqCst);

    let config_dir = crate::commands::config::config_dir_path();

    let resource_dir = app.path().resource_dir().map(|p| p.join("resources")).ok();

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

    // 解析目标 IDE（auto 模式需实际检测），校验只允许 windsurf/devin
    let target = match target_ide.as_deref() {
        Some("auto") | None => {
            // 自动检测：优先运行中的 IDE，其次默认 windsurf
            let detected = crate::commands::system::detect_target_ide();
            if detected != "windsurf" && detected != "devin" {
                "windsurf".into()
            } else {
                detected
            }
        }
        Some(t) if t == "windsurf" || t == "devin" => t.to_string(),
        Some(t) => {
            clear_starting();
            return Err(format!("不支持的目标 IDE: {}（仅 windsurf/devin/auto）", t));
        }
    };

    // 写入 child 并清除 starting 标志
    *lock_or_recover(&state.child) = Some(ManagedChild {
        child: Mutex::new(child),
    });
    *lock_or_recover(&state.target_ide) = target.clone();
    clear_starting();

    // 打补丁：写入 IDE 代理配置（失败不阻断代理启动，仅记日志）。
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
                    msg: format!("✅ 已写入 {} 代理配置，请重启 IDE 生效", ide_label),
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
                    msg: format!("⚠ 写入 {} 配置失败: {}", ide_label, e),
                },
            );
            false
        }
    };

    // 注入卡片改写脚本到 workbench.html（失败不阻断代理启动，仅记日志）。
    if let Some(res) = &resource_dir {
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
                // child 为 None 说明 stop_proxy 已 take 走了 child 并负责清理，
                // 这里直接退出循环，不再误判为进程退出。
                None => {
                    break;
                }
            }
        } else {
            break;
        };

        if exited {
            // 进程真正退出后的清理
            if let Some(state) = app_handle2.try_state::<ProxyState>() {
                *lock_or_recover(&state.child) = None;
                let target = lock_or_recover(&state.target_ide).clone();
                // 清除 target_ide
                *lock_or_recover(&state.target_ide) = String::new();
                if target.is_empty() || (target != "windsurf" && target != "devin") {
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
            let _ = app_handle2.emit("proxy-stopped", ());
            break;
        }
    });

    Ok(patched)
}

#[tauri::command]
pub fn stop_proxy(
    app: AppHandle,
    state: State<ProxyState>,
    _target_ide: Option<String>,
) -> Result<RestoreReport, String> {
    let child = lock_or_recover(&state.child).take();
    if let Some(child) = child {
        // 无论 kill 是否成功，都必须还原配置；kill 失败仅记日志不阻断。
        if let Err(e) = child.kill() {
            eprintln!("[stop_proxy] kill 失败（进程可能已退出）: {}", e);
        }
        // 还原 IDE 配置：使用 start_proxy 时保存的 target_ide，
        // 而非重新检测或参数传入值——确保还原目标与打补丁时一致。
        let target = lock_or_recover(&state.target_ide).clone();
        // 清除 target_ide，防止残留旧值被后续误用
        *lock_or_recover(&state.target_ide) = String::new();
        if target.is_empty() || (target != "windsurf" && target != "devin") {
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
        Err("代理未运行".into())
    }
}

/// 强杀所有名为 ide-byok-proxy 的孤儿进程（启动时 / 升级前调用）。
/// 与 ManagedChild::kill() 不同：这里不依赖 state 里记录的 PID，
/// 而是按进程名全盘扫描，确保上一轮崩溃或异常退出后残留的 sidecar 不会锁住 exe 文件。
pub fn kill_sidecar_process() {
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/IM", "ide-byok-proxy.exe"])
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .output();
        match out {
            Ok(o) if o.status.success() => {
                eprintln!("[cleanup] 已清理孤儿 sidecar 进程");
            }
            Ok(_) => {
                // 进程不存在（taskkill 返回错误码 128），属正常情况
            }
            Err(e) => {
                eprintln!("[cleanup] taskkill 执行失败: {}", e);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "ide-byok-proxy"])
            .output();
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
