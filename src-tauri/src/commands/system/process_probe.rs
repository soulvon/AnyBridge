use std::process::Command;
use super::ide_paths::*;
use super::restart::HideWindow;

// ═══════ IDE DETECTION ═══════

/// Unix 上「按进程名」回退杀进程时允许的名字。
/// 注意：Devin 绝不能把 Windsurf 放进回退列表——路径未命中时 killall Windsurf 会误杀真·Windsurf。
/// Devin 主进程若仍叫 Windsurf，必须靠 unix_ide_pids 的路径过滤命中 PID。
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn unix_ide_fallback_kill_names(target: &str) -> &'static [&'static str] {
    match target {
        "cursor" => {
            #[cfg(target_os = "macos")]
            {
                &["Cursor"]
            }
            #[cfg(target_os = "linux")]
            {
                &["cursor", "Cursor"]
            }
        }
        "devin" => {
            #[cfg(target_os = "macos")]
            {
                &["Devin"]
            }
            #[cfg(target_os = "linux")]
            {
                &["devin", "Devin"]
            }
        }
        _ => {
            #[cfg(target_os = "macos")]
            {
                &["Windsurf"]
            }
            #[cfg(target_os = "linux")]
            {
                &["windsurf", "Windsurf"]
            }
        }
    }
}

/// pgrep 回退探测用的进程名（可比 kill 回退更宽，但仍避免 Devin↔Windsurf 互误）。
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn unix_ide_process_names(target: &str) -> &'static [&'static str] {
    match target {
        "cursor" => unix_ide_fallback_kill_names("cursor"),
        "devin" => {
            #[cfg(target_os = "macos")]
            {
                // 探测可以包含 Windsurf，但 is_ide_running 里对 windsurf 名会 continue 跳过
                &["Devin"]
            }
            #[cfg(target_os = "linux")]
            {
                &["devin", "Devin"]
            }
        }
        _ => unix_ide_fallback_kill_names("windsurf"),
    }
}

/// 返回匹配目标 IDE 的 PID 列表（Unix）。
/// Devin 用安装路径/`devin` 路径片段过滤，避免误杀 Windsurf。
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn unix_ide_pids(target: &str) -> Vec<u32> {
    use std::collections::HashSet;

    let mut pids = HashSet::new();
    let install_hint = match target {
        "devin" => find_ide_app_or_bin_path("devin")
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "devin".into()),
        "cursor" => find_ide_app_or_bin_path("cursor")
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "cursor".into()),
        _ => find_ide_app_or_bin_path("windsurf")
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "windsurf".into()),
    };

    // ps 输出：PID COMMAND
    let out = Command::new("ps")
        .args(["-ax", "-o", "pid=,command="])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(pid_str) = parts.next() else {
            continue;
        };
        let Some(cmd) = parts.next() else { continue };
        let Ok(pid) = pid_str.trim().parse::<u32>() else {
            continue;
        };
        let cmd_l = cmd.to_lowercase();

        let matched = match target {
            "cursor" => {
                // 收紧：避免匹配任意含 cursor 的路径（如文档、其它工具）
                cmd_l.contains("cursor.app/")
                    || cmd_l.contains("cursor.app ")
                    || cmd_l.contains("/cursor.app")
                    || cmd_l.contains("/cursor/")
                    || cmd_l.ends_with("/cursor")
                    || cmd_l.contains("/cursor ")
            }
            "devin" => {
                // 排除 Windsurf 扩展里的 devin 子进程
                if cmd_l.contains("extensions/windsurf/devin")
                    || cmd_l.contains("extensions\\windsurf\\devin")
                {
                    false
                } else if !install_hint.is_empty()
                    && install_hint != "devin"
                    && cmd_l.contains(&install_hint)
                {
                    // 已探测到安装路径时，优先按安装路径匹配（覆盖主进程名为 Windsurf）
                    true
                } else {
                    cmd_l.contains("devin.app/")
                        || cmd_l.contains("devin.app ")
                        || cmd_l.contains("/devin.app")
                        || cmd_l.contains("/devin/")
                        || cmd_l.ends_with("/devin")
                        || cmd_l.contains("/devin ")
                }
            }
            _ => {
                // Windsurf：命中 windsurf，但排除 Devin 安装路径
                let looks_devin = cmd_l.contains("devin.app")
                    || cmd_l.contains("/devin/")
                    || cmd_l.contains("/devin ")
                    || cmd_l.ends_with("/devin")
                    || (cmd_l.contains("devin")
                        && !cmd_l.contains("extensions/windsurf/devin")
                        && !cmd_l.contains("extensions\\windsurf\\devin"));
                if looks_devin {
                    false
                } else if !install_hint.is_empty()
                    && install_hint != "windsurf"
                    && cmd_l.contains(&install_hint)
                {
                    true
                } else {
                    cmd_l.contains("windsurf.app/")
                        || cmd_l.contains("windsurf.app ")
                        || cmd_l.contains("/windsurf.app")
                        || cmd_l.contains("/windsurf/")
                        || cmd_l.ends_with("/windsurf")
                        || cmd_l.contains("/windsurf ")
                }
            }
        };
        if matched {
            pids.insert(pid);
        }
    }
    pids.into_iter().collect()
}

#[cfg(target_os = "macos")]
pub(super) fn find_ide_app_or_bin_path(target: &str) -> Option<std::path::PathBuf> {
    find_ide_app(target)
}

#[cfg(target_os = "linux")]
pub(super) fn find_ide_app_or_bin_path(target: &str) -> Option<std::path::PathBuf> {
    find_ide_bin(target)
}

/// async + spawn_blocking：内部 spawn PowerShell/pgrep 子进程（秒级），
/// 同步 command 在主线程执行会阻塞 UI。
#[tauri::command]
pub async fn is_ide_running(name: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || is_ide_running_sync(name))
        .await
        .unwrap_or(false)
}

/// 同步实现：后端重启等待循环 / 诊断 / detect_target_ide 在同步上下文调用。
pub(crate) fn is_ide_running_sync(name: String) -> bool {
    let n = if name == "auto" {
        detect_target_ide()
    } else {
        name
    };
    #[cfg(target_os = "windows")]
    {
        // Devin 的主进程名仍为 Windsurf.exe，需通过路径过滤区分：
        // - Devin: 查找 Windsurf.exe 进程中 Path 包含 devin 目录的
        // - Windsurf: 查找 Windsurf.exe 进程中 Path 不含 devin 目录的
        let ps_query = if n == "devin" {
            // Devin: 同时查找 Windsurf.exe（来自 Devin 目录）和 Devin.exe 进程
            format!(
                r#"$hit = Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -match '[\\/]devin[\\/]' -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1; if (-not $hit) {{ $hit = Get-Process Devin -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1 }}; $hit"#
            )
        } else if n == "cursor" {
            format!(r#"Get-Process Cursor -ErrorAction SilentlyContinue | Select-Object -First 1"#)
        } else if n == "antigravity-ide" {
            format!(
                r#"Get-Process 'Antigravity IDE' -ErrorAction SilentlyContinue | Select-Object -First 1"#
            )
        } else if n == "antigravity" {
            format!(
                r#"Get-Process Antigravity -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'Antigravity IDE' }} | Select-Object -First 1"#
            )
        } else if n == "claude-desktop" || n == "claude" {
            format!(
                r#"Get-Process Claude -ErrorAction SilentlyContinue | Select-Object -First 1"#
            )
        } else {
            format!(
                r#"Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch '[\\/]devin[\\/]' }} | Select-Object -First 1"#
            )
        };
        if let Ok(out) = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_query])
            .hide_window()
            .output()
        {
            !out.stdout.is_empty()
        } else {
            false
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if !unix_ide_pids(&n).is_empty() {
            return true;
        }
        // 回退：按进程名 pgrep（兼容 ps 不可用的环境）
        for process_name in unix_ide_process_names(&n) {
            if let Ok(out) = Command::new("pgrep").args(["-x", process_name]).output() {
                if !out.stdout.is_empty() {
                    // Devin 回退命中 Windsurf 时，尽量用路径再确认
                    if n == "devin" && process_name.eq_ignore_ascii_case("windsurf") {
                        continue;
                    }
                    if n == "windsurf" && process_name.eq_ignore_ascii_case("devin") {
                        continue;
                    }
                    return true;
                }
            }
        }
        false
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[tauri::command]
pub fn detect_target_ide() -> String {
    let windsurf_running = is_ide_running_sync("windsurf".into());
    let devin_running = is_ide_running_sync("devin".into());
    let cursor_running = is_ide_running_sync("cursor".into());

    // 优先选择正在运行的 IDE
    if windsurf_running && !devin_running && !cursor_running {
        return "windsurf".into();
    }
    if devin_running && !windsurf_running && !cursor_running {
        return "devin".into();
    }
    if cursor_running && !windsurf_running && !devin_running {
        return "cursor".into();
    }

    // 两个都在运行或都不在运行，检查哪个有网关配置
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;
        let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));

        // 检查 Windsurf 的 settings.json 是否有 http.proxy
        let windsurf_settings = config_dir.join("Windsurf/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&windsurf_settings) {
            if content.contains("\"http.proxy\"") {
                return "windsurf".into();
            }
        }

        // 检查 Devin 的 settings.json 是否有 http.proxy
        let devin_settings = config_dir.join("Devin/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&devin_settings) {
            if content.contains("\"http.proxy\"") {
                return "devin".into();
            }
        }

        let cursor_settings = config_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    // macOS/Linux 同样检查网关配置
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        // macOS: Windsurf/Devin 配置在 ~/Library/Application Support/
        let support_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));

        let windsurf_settings = support_dir.join("Windsurf/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&windsurf_settings) {
            if content.contains("\"http.proxy\"") {
                return "windsurf".into();
            }
        }

        let devin_settings = support_dir.join("Devin/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&devin_settings) {
            if content.contains("\"http.proxy\"") {
                return "devin".into();
            }
        }

        let cursor_settings = support_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::path::PathBuf;
        let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));

        // Linux: Windsurf/Devin 配置在 ~/.config/
        let windsurf_settings = config_dir.join("Windsurf/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&windsurf_settings) {
            if content.contains("\"http.proxy\"") {
                return "windsurf".into();
            }
        }

        let devin_settings = config_dir.join("Devin/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&devin_settings) {
            if content.contains("\"http.proxy\"") {
                return "devin".into();
            }
        }

        let cursor_settings = config_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    // 都没有网关配置，检查哪个安装了。默认优先 Windsurf，避免双安装机器误接入 Devin。
    #[cfg(target_os = "windows")]
    {
        if find_ide_exe("windsurf").is_some() {
            return "windsurf".into();
        }
        if find_ide_exe("devin").is_some() {
            return "devin".into();
        }
        if find_ide_exe("cursor").is_some() {
            return "cursor".into();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if find_ide_app("windsurf").is_some() {
            return "windsurf".into();
        }
        if find_ide_app("devin").is_some() {
            return "devin".into();
        }
        if find_ide_app("cursor").is_some() {
            return "cursor".into();
        }
    }
    #[cfg(target_os = "linux")]
    {
        if find_ide_bin("windsurf").is_some() {
            return "windsurf".into();
        }
        if find_ide_bin("devin").is_some() {
            return "devin".into();
        }
        if find_ide_bin("cursor").is_some() {
            return "cursor".into();
        }
    }

    // 都没安装，默认返回 windsurf
    "windsurf".into()
}

