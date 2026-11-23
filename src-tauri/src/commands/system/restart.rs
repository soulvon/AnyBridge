use std::process::Command;
use super::ide_paths::*;
use super::process_probe::*;

/// 沙箱兼容标记：记录某平台因 Chromium 沙箱初始化失败而需要 --no-sandbox 启动。
/// 存储于应用数据目录的 sandbox_compat.json，按平台 ID 记录布尔值。
#[cfg(target_os = "windows")]
pub(super) fn sandbox_compat_flag(platform: &str) -> bool {
    if let Some(dir) = dirs::data_dir() {
        let p = dir.join("AnyBridge").join("sandbox_compat.json");
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                return v.get(platform).and_then(|x| x.as_bool()).unwrap_or(false);
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
pub(super) fn set_sandbox_compat_flag(platform: &str, enabled: bool) {
    if let Some(dir) = dirs::data_dir() {
        let dir = dir.join("AnyBridge");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("sandbox_compat.json");
        let mut obj = std::fs::read_to_string(&p)
            .ok()
            .and_then(|raw| {
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw).ok()
            })
            .unwrap_or_default();
        obj.insert(platform.to_string(), serde_json::Value::Bool(enabled));
        let _ = std::fs::write(&p, serde_json::to_string(&obj).unwrap_or_default());
    }
}

/// 按 `.app` 安装路径直接扫描进程 PID（macOS）。
///
/// 刻意不复用 `unix_ide_pids` 的启发式匹配：Devin 的主进程可能仍叫 Windsurf，
/// 启发式匹配一旦漏判，会同时漏掉「杀进程」和「是否已退出」两件事，
/// 于是出现"进程没死却判定成功、open -a 只是激活已运行实例"的假重启。
/// 这里只认安装路径，命中即算该 IDE 的进程（含 Electron 的 helper 子进程）。
#[cfg(target_os = "macos")]
pub(super) fn macos_running_pids_for(app: &std::path::Path) -> Vec<u32> {
    let needle = app.to_string_lossy().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let Ok(out) = Command::new("ps").args(["-ax", "-o", "pid=,command="]).output() else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let (Some(pid_str), Some(cmd)) = (parts.next(), parts.next()) else {
            continue;
        };
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            if cmd.to_lowercase().contains(&needle) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// 跨平台「隐藏控制台窗口」抽象：Windows 用 CREATE_NO_WINDOW，
/// 其它平台 no-op。替代直接调链条上的 `creation_flags`（Windows 专属
/// 扩展 trait，未守卫会导致 mac/linux 编译失败）。
pub(crate) trait HideWindow {
    fn hide_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl HideWindow for std::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }
}

#[cfg(not(windows))]
impl HideWindow for std::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        self
    }
}

/// 从 Devin 安装路径（Windows exe / macOS .app / Linux bin）推算内置 `devin` CLI 路径。
pub(super) fn bundled_devin_cli_path(ide_path: &std::path::Path) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(
            ide_path
                .join("Contents")
                .join("Resources")
                .join("app")
                .join("extensions")
                .join("windsurf")
                .join("devin")
                .join("bin")
                .join("devin"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        ide_path.parent().map(|dir| {
            dir.join("resources")
                .join("app")
                .join("extensions")
                .join("windsurf")
                .join("devin")
                .join("bin")
                .join("devin.exe")
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        ide_path.parent().map(|dir| {
            dir.join("resources")
                .join("app")
                .join("extensions")
                .join("windsurf")
                .join("devin")
                .join("bin")
                .join("devin")
        })
    }
}

fn devin_daemon_process_present() -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq devin.exe", "/FO", "CSV", "/NH"])
            .hide_window()
            .output()
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .to_ascii_lowercase()
                    .contains("devin.exe")
            })
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("pgrep")
            .args(["-f", "devin.*daemon"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
}

/// 带硬超时的子进程执行：避免 `devin daemon stop` 等辅助命令在断网或卡死时阻塞重启流程。
pub(super) fn run_command_with_timeout(cmd: &mut Command, timeout: std::time::Duration) -> bool {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// 若新版 Devin CLI 后台 daemon 仍在运行，通知其优雅退出，避免重开 IDE 后继续复用旧代理环境。
fn stop_devin_daemon_if_running(ide_path: &std::path::Path) {
    let Some(cli) = bundled_devin_cli_path(ide_path) else {
        return;
    };
    if !cli.exists() || !devin_daemon_process_present() {
        return;
    }
    let mut cmd = Command::new(&cli);
    cmd.args(["daemon", "stop", "--force"]).hide_window();
    let _ = run_command_with_timeout(&mut cmd, std::time::Duration::from_secs(4));
}

/// 合并 Antigravity IDE 重启时的 `--remote-debugging-port` 参数：
/// 若已显式传入 `--remote-debugging-port` 则保持不变；
/// 否则当汉化已开启或重启前已启用调试端口时，自动保留/补上调试端口，
/// 避免设置页与 Agent 面板失去 CDP 注入通道。
pub(crate) fn merge_antigravity_ide_cdp_args(
    extra_args: &[String],
    loc_enabled: bool,
    prev_port: Option<u16>,
    fallback_port: u16,
) -> Vec<String> {
    let mut out = extra_args.to_vec();
    let has_port_arg = out.iter().any(|a| {
        a == "--remote-debugging-port" || a.starts_with("--remote-debugging-port=")
    });
    if !has_port_arg && (loc_enabled || prev_port.is_some()) {
        let port = prev_port.unwrap_or(fallback_port);
        out.push(format!("--remote-debugging-port={port}"));
    }
    out
}

pub(super) fn restart_ide_impl(target: String, extra_args: Vec<String>) -> Result<String, String> {
    let t = if target == "auto" {
        detect_target_ide()
    } else {
        target
    };
    // 非 Windows 平台暂不支持附加启动参数；显式消费变量，避免 mac/linux 编译告警。
    let _ = &extra_args;
    #[cfg(target_os = "windows")]
    {
        // 收集 taskkill 失败原因（拒绝访问等），最终报错时附带给用户，便于自助定位。
        let mut kill_report = String::new();
        let exe = find_ide_exe(&t)
            .ok_or_else(|| format!("未找到 {} 安装位置，请手动重启", ide_dir_name(&t)))?;

        // 在杀进程前读取当前活跃的 CDP 端口与汉化开启态，确保普通重启也保留调试端口。
        let effective_extra_args: Vec<String> = if t == "antigravity-ide" {
            let prev_port = if crate::commands::antigravity_cdp::probe().is_ok() {
                Some(crate::commands::antigravity_cdp::active_port())
            } else {
                None
            };
            let loc_enabled = crate::commands::app_localization::is_enabled("antigravity-ide");
            let fallback_port = crate::commands::antigravity_cdp::preferred_launch_port();
            merge_antigravity_ide_cdp_args(&extra_args, loc_enabled, prev_port, fallback_port)
        } else {
            extra_args.clone()
        };

        // Devin 的主进程名仍为 Windsurf.exe，需通过路径过滤只杀来自 Devin 安装目录的进程；
        // Windsurf 则直接杀所有 Windsurf.exe 进程。
        if t == "devin" {
            // 获取 Devin 安装目录，用于路径过滤
            let install_dir = exe
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            if install_dir.is_empty() {
                return Err("无法确定 Devin 安装目录，请手动重启".into());
            }
            // PID 筛选与 is_ide_running 的判定保持同源（路径含 devin 目录名，
            // 排除 Windsurf 的 devin 扩展插件目录），并叠加安装目录前缀精确匹配
            // 取并集。此前只按 find_ide_exe 父目录前缀精确匹配，重装/自定义安装
            // 路径后与实际运行进程目录错位，会出现"一个都没杀到，检测却仍命中"
            // 的稳定误报"进程未能终止"。
            let pid_script = format!(
                r#"$dir = '{dir}'; $seen = @{{}}; foreach ($name in @('Windsurf','Devin')) {{ Get-Process $name -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and ($_.Path.StartsWith($dir, 'CurrentCultureIgnoreCase') -or ($_.Path -match '[\\/]devin[\\/]' -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin')) }} | ForEach-Object {{ if (-not $seen.ContainsKey($_.Id)) {{ $seen[$_.Id] = $true; $_.Id }} }} }}"#,
                dir = install_dir.replace('\'', "''")
            );
            // 最多 3 轮：枚举 PID → 强杀 → 等 1s 复查。子进程可能在父进程死后
            // 才陆续退出，单轮枚举 + 单次等待偶有漏杀。
            for _round in 0..3 {
                let mut pids: Vec<String> = Vec::new();
                if let Ok(out) = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &pid_script])
                    .hide_window()
                    .output()
                {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        let pid = line.trim();
                        if !pid.is_empty() {
                            pids.push(pid.to_string());
                        }
                    }
                }
                if pids.is_empty() {
                    break;
                }
                for pid in &pids {
                    if let Ok(out) = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", pid])
                        .hide_window()
                        .output()
                    {
                        if !out.status.success() {
                            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                            if !stderr.is_empty() {
                                kill_report = stderr;
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if !is_ide_running_sync(t.clone()) {
                    break;
                }
            }
            stop_devin_daemon_if_running(&exe);
        } else {
            let image = if t == "cursor" {
                "Cursor.exe"
            } else if t == "antigravity-ide" {
                "Antigravity IDE.exe"
            } else if t == "antigravity" {
                "Antigravity.exe"
            } else if t == "claude-desktop" || t == "claude" {
                "Claude.exe"
            } else {
                "Windsurf.exe"
            };
            // 用 taskkill /F /T /IM 杀整个进程树（含 renderer/GPU 子进程）
            if let Ok(out) = Command::new("taskkill")
                .args(["/IM", image, "/F", "/T"])
                .hide_window()
                .output()
            {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    if !stderr.is_empty() {
                        kill_report = stderr;
                    }
                }
            }
        }

        // 等待进程退出（验证是否真的杀死了）。
        // cursor / antigravity / antigravity-ide / claude 的映像名全局唯一，用 tasklist 按映像名
        // 轮询（单次 ~100ms）；不要逐轮冷启动 PowerShell（单次 1~3s，12 轮会让重启
        // 卡 15~40s，用户以为死机）。windsurf/devin 因映像名共用必须走路径过滤，保持原判。
        let unique_image = match t.as_str() {
            "cursor" => Some("Cursor.exe"),
            "antigravity-ide" => Some("Antigravity IDE.exe"),
            "antigravity" => Some("Antigravity.exe"),
            "claude-desktop" | "claude" => Some("Claude.exe"),
            _ => None,
        };
        let mut dead = false;
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let running = if let Some(image) = unique_image {
                Command::new("tasklist")
                    .args([
                        "/FI",
                        &format!("IMAGENAME eq {}", image),
                        "/FO",
                        "CSV",
                        "/NH",
                    ])
                    .hide_window()
                    .output()
                    .map(|out| String::from_utf8_lossy(&out.stdout).contains(image))
                    .unwrap_or(false)
            } else {
                is_ide_running_sync(t.clone())
            };
            if !running {
                dead = true;
                break;
            }
        }
        if !dead {
            let hint = if kill_report.is_empty() {
                String::new()
            } else {
                format!("（kill 输出：{}）", kill_report)
            };
            return Err(format!(
                "{} 进程未能终止，请手动关闭后重试{}",
                ide_dir_name(&t),
                hint
            ));
        }

        // 启动新 IDE 进程（hide_window() 在 Windows 上等价 CREATE_NO_WINDOW，
        // 防止 CMD 窗口弹出；其它平台 no-op）
        let is_claude = t == "claude-desktop" || t == "claude";
        let is_msix_claude = is_claude && exe.to_string_lossy().contains("WindowsApps");

        if is_msix_claude {
            // 商店版 Claude 必须通过 shell:AppsFolder 激活，不能直接 CreateProcess
            let _ = Command::new("explorer.exe")
                .arg("shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude")
                .hide_window()
                .spawn()
                .map_err(|e| format!("启动 Claude 失败: {e}"))?;
            return Ok(format!("已重启 {}", ide_dir_name(&t)));
        }

        let spawn_client = |args: &[&str]| -> Result<std::process::Child, String> {
            Command::new(&exe)
                .env_remove("ELECTRON_RUN_AS_NODE")
                .args(args)
                .args(&effective_extra_args)
                .hide_window()
                .spawn()
                .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))
        };

        // 沙箱兜底：部分 Windows 机器上 Chromium 沙箱初始化失败，表现为启动后数秒内
        // 静默退出（ExitCode 0x80000003），官方原版同样复现，与我们的补丁无关。
        // 实测崩溃可晚至启动后约 5 秒，因此观察窗口取 6 秒；一旦确认崩溃，
        // 记住该平台需要兼容模式，之后重启直接带 --no-sandbox，不再重复等待。
        if sandbox_compat_flag(&t) {
            spawn_client(&["--no-sandbox"])?;
            return Ok(format!("已重启 {}（兼容模式）", ide_dir_name(&t)));
        }

        let mut child = spawn_client(&[])?;
        let mut exited_early = false;
        for _ in 0..24 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited_early = true;
                    break;
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
        if exited_early {
            set_sandbox_compat_flag(&t, true);
            spawn_client(&["--no-sandbox"])?;
            return Ok(format!(
                "已重启 {}（检测到沙箱启动失败，已自动改用兼容模式并记住该设置）",
                ide_dir_name(&t)
            ));
        }

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(target_os = "macos")]
    {
        let app = find_ide_app(&t)
            .ok_or_else(|| format!("未找到 {}.app，请手动重启", ide_dir_name(&t)))?;

        let was_running = !macos_running_pids_for(&app).is_empty();

        if was_running {
            // 最多 3 轮：Electron 的 helper 子进程可能在主进程死后才陆续退出。
            for round in 0..3 {
                let pids = macos_running_pids_for(&app);
                if pids.is_empty() {
                    break;
                }
                for pid in pids {
                    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                }
                if round == 0 {
                    // 兜底再按安全进程名清一次（Devin 只 killall "Devin"，绝不误杀 Windsurf）
                    for name in unix_ide_fallback_kill_names(&t) {
                        let _ = Command::new("killall").args([name]).output();
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }

            // 真实验证：按 .app 路径复查必须清零。绝不用会漏判的启发式判定，
            // 否则 open -a 只是 activate 已运行的实例，界面却报"已重启"。
            let mut dead = false;
            for _ in 0..8 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if macos_running_pids_for(&app).is_empty() {
                    dead = true;
                    break;
                }
            }
            if !dead {
                let remaining = macos_running_pids_for(&app);
                return Err(format!(
                    "{} 进程未能终止（仍有 {} 个进程：{}），请手动退出后重试",
                    ide_dir_name(&t),
                    remaining.len(),
                    remaining
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }

        if t == "devin" {
            stop_devin_daemon_if_running(&app);
        }

        Command::new("open")
            .args(["-a"])
            .arg(&app)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))?;

        // 拉起后复查：确实出现了新进程，才算真的重启成功。
        let mut launched = false;
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !macos_running_pids_for(&app).is_empty() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err(format!(
                "{} 已退出但未能重新拉起，请手动打开 {}",
                ide_dir_name(&t),
                app.display()
            ));
        }

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(target_os = "linux")]
    {
        let bin = find_ide_bin(&t)
            .ok_or_else(|| format!("未找到 {} 可执行文件，请手动重启", ide_dir_name(&t)))?;

        let pids = unix_ide_pids(&t);
        if pids.is_empty() {
            for name in unix_ide_fallback_kill_names(&t) {
                let _ = Command::new("pkill").args(["-x", name]).output();
            }
            // Devin 主进程可能不叫 devin：仅按路径/包名子串兜底，避免 -f windsurf 误杀
            if t == "devin" {
                let _ = Command::new("pkill")
                    .args(["-f", "[/ ][Dd]evin([/ .]|$)"])
                    .output();
            }
        } else {
            for pid in pids {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
        }

        // 等待进程退出，最多 3 秒
        let mut dead = false;
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !is_ide_running_sync(t.clone()) {
                dead = true;
                break;
            }
        }
        if !dead {
            return Err(format!(
                "{} 进程未能终止，请手动关闭后重试",
                ide_dir_name(&t)
            ));
        }

        if t == "devin" {
            stop_devin_daemon_if_running(&bin);
        }

        Command::new(&bin)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))?;

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = t;
        Err("当前平台不支持自动重启 IDE".into())
    }
}

/// 强杀并重启 IDE，使写入的网关配置生效。
/// 注意：强杀会丢失未保存的工作，调用方需先提示用户保存。
#[tauri::command]
pub async fn restart_ide(target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || restart_ide_impl(target, Vec::new()))
        .await
        .map_err(|e| format!("重启 IDE 任务失败: {}", e))?
}

/// 构建以 CDP 调试模式启动 Antigravity IDE 的参数列表（便于全平台复用与单测锁定）。
pub(super) fn build_cdp_restart_args(port: u16) -> Vec<String> {
    vec![format!("--remote-debugging-port={port}")]
}

/// 以「汉化模式」重启 Antigravity IDE：附加 `--remote-debugging-port`。
///
/// 设置页 / Agent 面板由本地 Web 应用渲染（跨源 iframe + 资源编译进 agy.exe），
/// 文件注入够不到，只能靠调试端口做运行期注入。注意：强杀会丢失未保存的工作，
/// UI 必须先向用户说明再调用。
#[tauri::command]
pub async fn restart_antigravity_ide_with_cdp() -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("深度汉化（CDP 注入）当前仅支持 Windows".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            // 与 Antigravity Kite 共存：Kite 会自己给快捷方式追加
            // --remote-debugging-port 并重启 IDE。若调试端口已就绪，
            // 直接复用并补注入即可，绝不抢重启权（强杀会打断 Kite 的
            // 无感切号，还会清掉它刚写入的登录态）。
            let cdp = crate::commands::antigravity_cdp::probe();
            if cdp.is_ok() {
                let port = crate::commands::antigravity_cdp::active_port();
                let injected = crate::commands::antigravity_cdp::inject_once().unwrap_or(0);
                return Ok(format!(
                    "调试端口 {port} 已就绪，已直接补注入 {injected} 个界面（未重启 IDE）"
                ));
            }
            let port = crate::commands::antigravity_cdp::preferred_launch_port();
            restart_ide_impl(
                "antigravity-ide".to_string(),
                build_cdp_restart_args(port),
            )
            .map(|msg| format!("{msg}（已启用深度汉化，调试端口 {port}）"))
        })
        .await
        .map_err(|e| format!("重启 Antigravity IDE 任务失败: {e}"))?
    }
}
