#[cfg(target_os = "windows")]
use super::restart::HideWindow;
use super::process_probe::detect_target_ide;

/// 配置键：缓存上次探测成功的 IDE exe 路径，
/// 也用作用户手动指定路径的入口（设置页可写入此键）。
#[cfg(target_os = "windows")]
pub(super) const IDE_EXE_KEY: &str = "ideExePath";
#[cfg(target_os = "windows")]
pub(super) const DEVIN_EXE_KEY: &str = "devinExePath";
#[cfg(target_os = "windows")]
pub(super) const CURSOR_EXE_KEY: &str = "cursorExePath";
#[cfg(target_os = "windows")]
pub(super) const ANTIGRAVITY_EXE_KEY: &str = "antigravityExePath";
#[cfg(target_os = "windows")]
pub(super) const ANTIGRAVITY_IDE_EXE_KEY: &str = "antigravityIdeExePath";
#[cfg(target_os = "windows")]
pub(super) const CLAUDE_EXE_KEY: &str = "claudeExePath";
#[cfg(target_os = "macos")]
pub(super) const WINDSURF_APP_KEY: &str = "windsurfAppPath";
#[cfg(target_os = "macos")]
pub(super) const DEVIN_APP_KEY: &str = "devinAppPath";
#[cfg(target_os = "macos")]
pub(super) const CURSOR_APP_KEY: &str = "cursorAppPath";
#[cfg(target_os = "macos")]
pub(super) const ANTIGRAVITY_APP_KEY: &str = "antigravityAppPath";
#[cfg(target_os = "macos")]
pub(super) const ANTIGRAVITY_IDE_APP_KEY: &str = "antigravityIdeAppPath";
#[cfg(target_os = "macos")]
pub(super) const CLAUDE_APP_KEY: &str = "claudeAppPath";
#[cfg(target_os = "linux")]
pub(super) const WINDSURF_BIN_KEY: &str = "windsurfBinPath";
#[cfg(target_os = "linux")]
pub(super) const DEVIN_BIN_KEY: &str = "devinBinPath";
#[cfg(target_os = "linux")]
pub(super) const CURSOR_BIN_KEY: &str = "cursorBinPath";
#[cfg(target_os = "linux")]
pub(super) const ANTIGRAVITY_BIN_KEY: &str = "antigravityBinPath";
#[cfg(target_os = "linux")]
pub(super) const ANTIGRAVITY_IDE_BIN_KEY: &str = "antigravityIdeBinPath";
#[cfg(target_os = "linux")]
pub(super) const CLAUDE_BIN_KEY: &str = "claudeBinPath";

/// 根据 target 返回配置键名。
#[cfg(target_os = "windows")]
pub(super) fn ide_exe_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_EXE_KEY,
        "cursor" => CURSOR_EXE_KEY,
        "antigravity-ide" => ANTIGRAVITY_IDE_EXE_KEY,
        "antigravity" => ANTIGRAVITY_EXE_KEY,
        // 必须独立 key：落到默认分支会读到 Windsurf 的缓存路径，
        // 重启 Claude 时就会误杀 Windsurf（实测事故）
        "claude-desktop" | "claude" => CLAUDE_EXE_KEY,
        _ => IDE_EXE_KEY,
    }
}

#[cfg(target_os = "macos")]
pub(super) fn ide_app_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_APP_KEY,
        "cursor" => CURSOR_APP_KEY,
        "antigravity-ide" => ANTIGRAVITY_IDE_APP_KEY,
        "antigravity" => ANTIGRAVITY_APP_KEY,
        "claude-desktop" | "claude" => CLAUDE_APP_KEY,
        _ => WINDSURF_APP_KEY,
    }
}

#[cfg(target_os = "linux")]
pub(super) fn ide_bin_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_BIN_KEY,
        "cursor" => CURSOR_BIN_KEY,
        "antigravity-ide" => ANTIGRAVITY_IDE_BIN_KEY,
        "antigravity" => ANTIGRAVITY_BIN_KEY,
        "claude-desktop" | "claude" => CLAUDE_BIN_KEY,
        _ => WINDSURF_BIN_KEY,
    }
}

/// 根据 target 返回可执行文件名（Windows），用于默认安装位置拼接。
/// 注意：Devin 的安装目录下可执行文件叫 Devin.exe，但运行时主进程名仍为 Windsurf.exe。
#[cfg(target_os = "windows")]
pub(super) fn ide_exe_filename(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.exe",
        "cursor" => "Cursor.exe",
        "antigravity-ide" => "Antigravity IDE.exe",
        "antigravity" => "Antigravity.exe",
        "claude-desktop" | "claude" => "Claude.exe",
        _ => "Windsurf.exe",
    }
}

#[cfg(target_os = "macos")]
pub(super) fn ide_app_filename(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.app",
        "cursor" => "Cursor.app",
        "antigravity-ide" => "Antigravity IDE.app",
        "antigravity" => "Antigravity.app",
        "claude-desktop" | "claude" => "Claude.app",
        _ => "Windsurf.app",
    }
}

#[cfg(target_os = "linux")]
pub(super) fn ide_bin_filename(target: &str) -> &'static str {
    match target {
        "devin" => "devin",
        "cursor" => "cursor",
        "antigravity-ide" => "antigravity-ide",
        "antigravity" => "antigravity",
        _ => "windsurf",
    }
}

/// 根据 target 返回文件夹名（Windsurf/Devin/Antigravity IDE/antigravity）。
pub(super) fn ide_dir_name(target: &str) -> &'static str {
    match target {
        "devin" => "Devin",
        "cursor" => "Cursor",
        "antigravity-ide" => "Antigravity IDE",
        "antigravity" => "antigravity",
        "claude-desktop" | "claude" => "Claude",
        _ => "Windsurf",
    }
}

#[cfg(target_os = "macos")]
pub(super) fn is_ide_app_for_target(target: &str, path: &std::path::Path) -> bool {
    path.exists()
        && path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(ide_app_filename(target)))
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub(super) fn is_ide_bin_for_target(target: &str, path: &std::path::Path) -> bool {
    path.exists()
        && path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(ide_bin_filename(target)))
            .unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub(super) fn path_has_component(path: &std::path::Path, name: &str) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(name))
}

#[cfg(target_os = "windows")]
pub(super) fn is_cli_subprocess_path(path: &std::path::Path) -> bool {
    let s = path.to_string_lossy().replace('/', "\\").to_lowercase();
    s.contains("\\extensions\\windsurf\\devin\\") && s.contains("\\bin\\")
}

#[cfg(target_os = "windows")]
pub(super) fn is_ide_exe_for_target(target: &str, path: &std::path::Path) -> bool {
    if !path.exists() || is_cli_subprocess_path(path) {
        return false;
    }
    let Some(file_name) = path.file_name().map(|n| n.to_string_lossy()) else {
        return false;
    };
    let in_devin_dir = path_has_component(path, "Devin");
    match target {
        // Devin 的 Electron 主进程在部分版本里仍叫 Windsurf.exe，所以目录也要参与判断。
        "devin" => {
            file_name.eq_ignore_ascii_case("Devin.exe")
                || (file_name.eq_ignore_ascii_case("Windsurf.exe") && in_devin_dir)
        }
        "cursor" => file_name.eq_ignore_ascii_case("Cursor.exe"),
        "antigravity-ide" => file_name.eq_ignore_ascii_case("Antigravity IDE.exe"),
        "antigravity" => file_name.eq_ignore_ascii_case("Antigravity.exe"),
        "claude-desktop" | "claude" => file_name.eq_ignore_ascii_case("Claude.exe"),
        _ => file_name.eq_ignore_ascii_case("Windsurf.exe") && !in_devin_dir,
    }
}

#[cfg(target_os = "windows")]
pub(super) fn windows_drive_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let p = std::path::PathBuf::from(root);
        if p.exists() {
            roots.push(p);
        }
    }
    roots
}

#[cfg(target_os = "windows")]
pub(super) fn common_ide_candidates(target: &str) -> Vec<std::path::PathBuf> {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    let exe_name = ide_exe_filename(target);
    let dir_name = ide_dir_name(target);
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();

    let mut push = |p: PathBuf| {
        let key = p.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            out.push(p);
        }
    };

    if let Some(local) = dirs::data_local_dir() {
        push(local.join("Programs").join(dir_name).join(exe_name));
        // Claude 官网版装在 %LOCALAPPDATA%\AnthropicClaude 下的最新 app-x.x.x 目录
        if target == "claude-desktop" || target == "claude" {
            let claude_root = local.join("AnthropicClaude");
            if let Ok(entries) = std::fs::read_dir(&claude_root) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        push(p.join("Claude.exe"));
                        push(p.join("app").join("Claude.exe"));
                    }
                }
            }
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            push(PathBuf::from(pf).join(dir_name).join(exe_name));
        }
    }
    for root in windows_drive_roots() {
        push(root.join("Program Files").join(dir_name).join(exe_name));
        push(
            root.join("Program Files (x86)")
                .join(dir_name)
                .join(exe_name),
        );
        push(root.join("Programs").join(dir_name).join(exe_name));
        push(root.join("Program").join(dir_name).join(exe_name));
        push(root.join(dir_name).join(exe_name));
    }

    out
}

/// 探测 IDE 安装路径（Windows），支持 Windsurf 和 Devin。
#[cfg(target_os = "windows")]
pub(crate) fn find_ide_exe(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    use std::process::Command;

    let key = ide_exe_key(target);

    // 1. 配置缓存 / 用户手动指定
    //    注意：Devin 的缓存路径需排除 CLI 子进程路径（extensions/windsurf/devin/bin），
    //    旧版可能缓存了错误的 CLI 路径，此处做校验并清除。
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if is_ide_exe_for_target(target, &p) {
            return Some(p);
        }
        if p.exists() {
            // 清除错误缓存，继续探测。旧版可能把 Devin CLI 子进程或另一个 IDE 的路径写进来。
            let _ = crate::commands::config::write_config_value(key, "");
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    // 2. 常见安装位置（纯文件系统检查，毫秒级）。放在 PowerShell 探测之前，
    //    覆盖默认安装与自定义盘符（含 Program\ 单数目录），避免每次接入都冷启动 PowerShell。
    for p in common_ide_candidates(target) {
        if is_ide_exe_for_target(target, &p) {
            return cache_and_return(p);
        }
    }

    // 3. 运行中进程的真实路径（仅在常见位置未命中时兜底，冷启动 PowerShell 较慢）。
    // Devin 的主进程名仍为 Windsurf.exe，需通过路径过滤区分；
    // Windsurf 的主进程也是 Windsurf.exe，无需额外过滤。
    let ps_query = if target == "devin" {
        // Devin: 同时查找 Windsurf.exe（来自 Devin 目录）和 Devin.exe 进程
        format!(
            r#"$hit = $null; $hit = Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -match '[\\/]devin[\\/]' -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1 -ExpandProperty Path; if (-not $hit) {{ $hit = Get-Process Devin -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1 -ExpandProperty Path }}; if ($hit) {{ Write-Output $hit }}"#
        )
    } else if target == "cursor" {
        format!(
            r#"Get-Process Cursor -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"#
        )
    } else if target == "antigravity-ide" {
        format!(
            r#"Get-Process 'Antigravity IDE' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"#
        )
    } else if target == "antigravity" {
        format!(
            r#"Get-Process Antigravity -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'Antigravity IDE' }} | Select-Object -First 1 -ExpandProperty Path"#
        )
    } else if target == "claude-desktop" || target == "claude" {
        format!(
            r#"$hit = Get-Process Claude -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; if (-not $hit) {{ $appx = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if ($appx -and $appx.InstallLocation) {{ $c = Join-Path $appx.InstallLocation 'app\Claude.exe'; if (Test-Path $c) {{ $hit = $c }} }} }}; if ($hit) {{ Write-Output $hit }}"#
        )
    } else {
        format!(
            r#"Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch '[\\/]devin[\\/]' }} | Select-Object -First 1 -ExpandProperty Path"#
        )
    };
    if let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_query])
        .hide_window()
        .output()
    {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            // Devin 的运行进程是 Windsurf.exe，但安装路径应返回 Devin.exe
            let p = PathBuf::from(&path);
            if is_ide_exe_for_target(target, &p) {
                if target == "devin" {
                    // 从 Windsurf.exe 的路径推出 Devin.exe（同目录或上级）
                    if let Some(parent) = p.parent() {
                        let devin_exe = parent.join("Devin.exe");
                        if is_ide_exe_for_target(target, &devin_exe) {
                            return cache_and_return(devin_exe);
                        }
                    }
                    // fallback: 直接返回找到的路径（至少能用于重启）
                    return cache_and_return(p);
                }
                return cache_and_return(p);
            }
        }
    }

    // 4. 注册表卸载项（兜底，冷启动 PowerShell 较慢）
    if let Some(p) = find_ide_exe_from_registry(target) {
        if p.exists() {
            return cache_and_return(p);
        }
    }

    None
}

/// 从注册表卸载项探测 IDE 安装目录（支持 Windsurf 和 Devin）。
#[cfg(target_os = "windows")]
pub(super) fn find_ide_exe_from_registry(target: &str) -> Option<std::path::PathBuf> {
    use std::process::Command;

    let display_pattern = format!("*{}*", ide_dir_name(target));
    let exe_name = ide_exe_filename(target);

    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$exeName = '{}'
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$candidates = New-Object System.Collections.Generic.List[string]
function Add-Candidate([string]$p) {{
  if (-not $p) {{ return }}
  $s = $p.Trim()
  if (-not $s) {{ return }}
  if ($s.StartsWith('"')) {{
    $m = [regex]::Match($s, '^"([^"]+)"')
    if ($m.Success) {{ $s = $m.Groups[1].Value }}
  }} else {{
    $m = [regex]::Match($s, '^[A-Za-z]:\\.+?\.exe')
    if ($m.Success) {{ $s = $m.Value }}
  }}
  $s = $s.Trim('"').Trim()
  if ($s) {{ $candidates.Add($s) }}
  try {{
    $parent = Split-Path -Parent $s
    if ($parent) {{ $candidates.Add((Join-Path $parent $exeName)) }}
  }} catch {{}}
}}
foreach ($r in $roots) {{
  Get-ItemProperty $r -ErrorAction SilentlyContinue |
    Where-Object {{ $_.DisplayName -like '{}' }} |
    ForEach-Object {{
      if ($_.InstallLocation) {{
        Add-Candidate (Join-Path $_.InstallLocation $exeName)
        Add-Candidate $_.InstallLocation
      }}
      Add-Candidate $_.DisplayIcon
      Add-Candidate $_.UninstallString
      Add-Candidate $_.QuietUninstallString
    }}
}}
$appPathRoots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
)
foreach ($r in $appPathRoots) {{
  $item = Get-ItemProperty $r -ErrorAction SilentlyContinue
  if ($item) {{ Add-Candidate $item.'(default)'; Add-Candidate $item.Path }}
}}
$candidates | Where-Object {{ $_ }} | Select-Object -Unique
"#,
        exe_name, display_pattern
    );

    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .hide_window()
        .output()
        .ok()?;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let candidate = line.trim().trim_matches('"');
        if candidate.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(candidate);
        if is_ide_exe_for_target(target, &p) {
            return Some(p);
        }
    }
    None
}

/// 探测 IDE .app 路径（macOS），支持 Windsurf 和 Devin。
#[cfg(target_os = "macos")]
pub(crate) fn find_ide_app(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let key = ide_app_key(target);
    let app_name = ide_app_filename(target);
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if is_ide_app_for_target(target, &p) {
            return Some(p);
        }
        if p.exists() {
            let _ = crate::commands::config::write_config_value(key, "");
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    // 系统级安装
    let system = PathBuf::from(format!("/Applications/{}", app_name));
    if system.exists() {
        return cache_and_return(system);
    }
    // 用户级安装
    if let Some(home) = dirs::home_dir() {
        let user = home.join("Applications").join(app_name);
        if user.exists() {
            return cache_and_return(user);
        }
    }
    None
}

/// 探测 IDE 可执行文件（Linux），支持 Windsurf / Devin / Cursor。
#[cfg(target_os = "linux")]
pub(crate) fn find_ide_bin(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let key = ide_bin_key(target);
    let dir_name = ide_dir_name(target);
    let bin_name = ide_bin_filename(target);
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if is_ide_bin_for_target(target, &p) {
            return Some(p);
        }
        if p.exists() {
            let _ = crate::commands::config::write_config_value(key, "");
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    let lower = dir_name.to_lowercase();
    let mut candidates = vec![
        format!("/usr/share/{}/{}", lower, bin_name),
        format!("/usr/share/{}/bin/{}", lower, bin_name),
        format!("/usr/bin/{}", bin_name),
        format!("/opt/{}/{}", dir_name, bin_name),
        format!("/opt/{}/{}", lower, bin_name),
        format!("/opt/{}/bin/{}", dir_name, bin_name),
        format!("/opt/{}/bin/{}", lower, bin_name),
        format!("/snap/bin/{}", bin_name),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".local")
                .join("bin")
                .join(bin_name)
                .to_string_lossy()
                .into_owned(),
        );
        candidates.push(
            home.join(".local")
                .join("share")
                .join(&lower)
                .join(bin_name)
                .to_string_lossy()
                .into_owned(),
        );
        candidates.push(
            home.join(".local")
                .join("share")
                .join(&lower)
                .join("bin")
                .join(bin_name)
                .to_string_lossy()
                .into_owned(),
        );
    }
    // which 回退（PATH 上的真实安装）
    if let Ok(out) = Command::new("sh")
        .args(["-c", &format!("command -v {} 2>/dev/null", bin_name)])
        .output()
    {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                candidates.push(path);
            }
        }
    }

    for c in candidates {
        let p = PathBuf::from(&c);
        if p.exists() && is_ide_bin_for_target(target, &p) {
            return cache_and_return(p);
        }
    }
    None
}

/// 探测并返回当前定位到的 IDE exe 路径（设置页展示用）。
/// 返回 None 表示自动探测失败，需用户手动指定。
#[tauri::command]
pub fn detect_ide_path(target: Option<String>) -> Option<String> {
    let t = match target.as_deref() {
        Some("auto") | None => detect_target_ide(),
        Some(s) => s.to_string(),
    };
    #[cfg(target_os = "windows")]
    {
        find_ide_exe(&t).map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        find_ide_app(&t).map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "linux")]
    {
        find_ide_bin(&t).map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = t;
        None
    }
}

/// 向后兼容
#[tauri::command]
pub fn detect_windsurf_path() -> Option<String> {
    detect_ide_path(Some("windsurf".into()))
}

/// 手动设置 IDE exe 路径（自动探测失败时的兜底，写入配置缓存）。
/// 校验路径存在且文件名是 Windsurf.exe、Devin.exe 或 Cursor.exe。
#[tauri::command]
pub fn set_ide_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_ide_exe = p
            .file_name()
            .map(|n| {
                n.eq_ignore_ascii_case("Windsurf.exe")
                    || n.eq_ignore_ascii_case("Devin.exe")
                    || n.eq_ignore_ascii_case("Cursor.exe")
            })
            .unwrap_or(false);
        if !is_ide_exe {
            return Err("请指向 Windsurf.exe、Devin.exe 或 Cursor.exe".into());
        }
        // 根据文件名 + 目录判断是哪个 IDE，写入对应配置键。
        // Devin 的部分进程仍叫 Windsurf.exe，不能只看文件名。
        let key = if is_ide_exe_for_target("cursor", &p) {
            CURSOR_EXE_KEY
        } else if is_ide_exe_for_target("devin", &p) {
            DEVIN_EXE_KEY
        } else {
            IDE_EXE_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }
    #[cfg(target_os = "macos")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_ide_app = p
            .file_name()
            .map(|n| {
                n.eq_ignore_ascii_case("Windsurf.app")
                    || n.eq_ignore_ascii_case("Devin.app")
                    || n.eq_ignore_ascii_case("Cursor.app")
            })
            .unwrap_or(false);
        if !is_ide_app {
            return Err("请指向 Windsurf.app、Devin.app 或 Cursor.app".into());
        }
        let key = if is_ide_app_for_target("cursor", &p) {
            CURSOR_APP_KEY
        } else if is_ide_app_for_target("devin", &p) {
            DEVIN_APP_KEY
        } else {
            WINDSURF_APP_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }

    #[cfg(target_os = "linux")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_ide_bin = p
            .file_name()
            .map(|n| {
                n.eq_ignore_ascii_case("windsurf")
                    || n.eq_ignore_ascii_case("devin")
                    || n.eq_ignore_ascii_case("cursor")
            })
            .unwrap_or(false);
        if !is_ide_bin {
            return Err("请指向 windsurf、devin 或 cursor 可执行文件".into());
        }
        let key = if is_ide_bin_for_target("cursor", &p) {
            CURSOR_BIN_KEY
        } else if is_ide_bin_for_target("devin", &p) {
            DEVIN_BIN_KEY
        } else {
            WINDSURF_BIN_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }
}

/// 向后兼容
#[tauri::command]
pub fn set_windsurf_path(path: String) -> Result<(), String> {
    set_ide_path(path)
}

