use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use std::process::Command;

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "启动代理", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止代理", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;

    let tray = TrayIconBuilder::with_id("main-tray");
    let tray = match app.default_window_icon() {
        Some(icon) => tray.icon(icon.clone()),
        None => tray,
    };
    tray
        .tooltip("IDE BYOK")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "start" => {
                if let Some(state) = app.try_state::<crate::commands::proxy::ProxyState>() {
                    let _ = crate::commands::proxy::start_proxy(app.clone(), state, None);
                }
            }
            "stop" => {
                if let Some(state) = app.try_state::<crate::commands::proxy::ProxyState>() {
                    let _ = crate::commands::proxy::stop_proxy(app.clone(), state, None);
                }
            }
            "quit" => {
                // 退出前还原 IDE 配置（两个都尝试，幂等）。
                let _ = crate::commands::ide_config::restore("windsurf");
                let _ = crate::commands::ide_config::restore("devin");
                let _ = crate::commands::workbench_inject::restore("windsurf");
                let _ = crate::commands::workbench_inject::restore("devin");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        if enabled {
            Command::new("reg")
                .args(["add", key, "/v", "IDEBYOK", "/t", "REG_SZ", "/d", &exe, "/f"])
                .output()
                .map_err(|e| e.to_string())?;
        } else {
            let _ = Command::new("reg")
                .args(["delete", key, "/v", "IDEBYOK", "/f"])
                .output();
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("仅支持 Windows".into())
    }
}

#[tauri::command]
pub fn open_config_dir(which: String) -> Result<(), String> {
    let base = crate::commands::config::config_dir_path();
    let target = match which.as_str() {
        "certs" => base.join("certs"),
        _ => base,
    };
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn generate_certs() -> Result<String, String> {
    use rcgen::{CertificateParams, DistinguishedName, DnType, SanType};

    let certs_dir = crate::commands::config::config_dir_path().join("certs");
    std::fs::create_dir_all(&certs_dir).map_err(|e| e.to_string())?;

    let cert_path = certs_dir.join("server.codeium.com.pem");
    let key_path = certs_dir.join("server.codeium.com-key.pem");

    if cert_path.exists() && key_path.exists() {
        return Ok("证书已存在".into());
    }

    let mut params = CertificateParams::new(vec![
        "server.self-serve.windsurf.com".to_string(),
        "server.codeium.com".to_string(),
        "localhost".to_string(),
    ])
    .map_err(|e| e.to_string())?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "IDE BYOK Local MITM");
    params.distinguished_name = dn;
    params.subject_alt_names = vec![
        SanType::DnsName("server.self-serve.windsurf.com".try_into().map_err(|_| "bad san")?),
        SanType::DnsName("server.codeium.com".try_into().map_err(|_| "bad san")?),
        SanType::DnsName("localhost".try_into().map_err(|_| "bad san")?),
    ];

    let key_pair = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;

    std::fs::write(&cert_path, cert.pem()).map_err(|e| e.to_string())?;
    std::fs::write(&key_path, key_pair.serialize_pem()).map_err(|e| e.to_string())?;

    Ok(format!("已生成证书到 {}", certs_dir.to_string_lossy()))
}

/// 配置键：缓存上次探测成功的 IDE exe 路径，
/// 也用作用户手动指定路径的入口（设置页可写入此键）。
#[cfg(target_os = "windows")]
const IDE_EXE_KEY: &str = "ideExePath";
#[cfg(target_os = "windows")]
const DEVIN_EXE_KEY: &str = "devinExePath";

/// 根据 target 返回配置键名。
#[cfg(target_os = "windows")]
fn ide_exe_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_EXE_KEY,
        _ => IDE_EXE_KEY,
    }
}

/// 根据 target 返回进程名（Windows）。
#[cfg(target_os = "windows")]
fn ide_process_name(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.exe",
        _ => "Windsurf.exe",
    }
}

/// 根据 target 返回文件夹名（Windsurf/Devin）。
fn ide_dir_name(target: &str) -> &'static str {
    match target {
        "devin" => "Devin",
        _ => "Windsurf",
    }
}

/// 探测 IDE 安装路径（Windows），支持 Windsurf 和 Devin。
#[cfg(target_os = "windows")]
pub(crate) fn find_ide_exe(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    use std::process::Command;

    let key = ide_exe_key(target);
    let proc_name = ide_process_name(target);
    let dir_name = ide_dir_name(target);

    // 1. 配置缓存 / 用户手动指定
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if p.exists() {
            return Some(p);
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    // 2. 运行中进程的真实路径
    // 注意：Get-Process Devin 会同时匹配 Devin.exe（IDE 主进程）和 devin.exe（CLI 子进程），
    // 需过滤 Path 确保只取 IDE 主进程（路径含程序安装目录，不含 extensions/windsurf/devin/bin）
    let ps_query = format!(
        r#"Get-Process {} -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin[/\\]bin' }} | Select-Object -First 1 -ExpandProperty Path"#,
        proc_name.trim_end_matches(".exe")
    );
    if let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_query])
        .output()
    {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            let p = PathBuf::from(&path);
            if p.exists() {
                return cache_and_return(p);
            }
        }
    }

    // 3. 常见默认安装位置
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join("Programs").join(dir_name).join(proc_name);
        if p.exists() {
            return cache_and_return(p);
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            let p = PathBuf::from(pf).join(dir_name).join(proc_name);
            if p.exists() {
                return cache_and_return(p);
            }
        }
    }

    // 4. 注册表卸载项
    if let Some(p) = find_ide_exe_from_registry(target) {
        if p.exists() {
            return cache_and_return(p);
        }
    }

    None
}

/// 从注册表卸载项探测 IDE 安装目录（支持 Windsurf 和 Devin）。
#[cfg(target_os = "windows")]
fn find_ide_exe_from_registry(target: &str) -> Option<std::path::PathBuf> {
    use std::process::Command;

    let display_pattern = format!("*{}*", ide_dir_name(target));
    let proc_name = ide_process_name(target);

    let script = format!(r#"
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($r in $roots) {{
  $hit = Get-ItemProperty $r -ErrorAction SilentlyContinue |
    Where-Object {{ $_.DisplayName -like '{}' -and $_.InstallLocation }} |
    Select-Object -First 1 -ExpandProperty InstallLocation
  if ($hit) {{ Write-Output $hit; break }}
}}
"#, display_pattern);

    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    let loc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if loc.is_empty() {
        return None;
    }
    let exe = std::path::PathBuf::from(loc).join(proc_name);
    if exe.exists() {
        Some(exe)
    } else {
        None
    }
}

/// 探测 IDE .app 路径（macOS），支持 Windsurf 和 Devin。
#[cfg(target_os = "macos")]
pub(crate) fn find_ide_app(target: &str) -> Option<std::path::PathBuf> {
    let app_name = match target {
        "devin" => "Devin.app",
        _ => "Windsurf.app",
    };
    // 系统级安装
    let system = std::path::PathBuf::from(format!("/Applications/{}", app_name));
    if system.exists() {
        return Some(system);
    }
    // 用户级安装
    if let Some(home) = dirs::home_dir() {
        let user = home.join("Applications").join(app_name);
        if user.exists() {
            return Some(user);
        }
    }
    None
}

/// 探测 IDE 可执行文件（Linux），支持 Windsurf 和 Devin。
#[cfg(target_os = "linux")]
pub(crate) fn find_ide_bin(target: &str) -> Option<std::path::PathBuf> {
    let (dir_name, bin_name) = match target {
        "devin" => ("Devin", "devin"),
        _ => ("Windsurf", "windsurf"),
    };
    let candidates = [
        format!("/usr/share/{}/{}", dir_name.to_lowercase(), bin_name),
        format!("/usr/bin/{}", bin_name),
        format!("/opt/{}/{}", dir_name, bin_name),
        format!("/snap/bin/{}", bin_name),
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(&c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 探测并返回当前定位到的 IDE exe 路径（设置页展示用）。
/// 返回 None 表示自动探测失败，需用户手动指定。
#[tauri::command]
pub fn detect_ide_path(target: Option<String>) -> Option<String> {
    let t = target.unwrap_or_else(|| "windsurf".into());
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
/// 校验路径存在且文件名是 Windsurf.exe 或 Devin.exe。
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
            })
            .unwrap_or(false);
        if !is_ide_exe {
            return Err("请指向 Windsurf.exe 或 Devin.exe".into());
        }
        // 根据文件名判断是哪个 IDE，写入对应配置键
        let key = if p.file_name().map(|n| n.eq_ignore_ascii_case("Devin.exe")).unwrap_or(false) {
            DEVIN_EXE_KEY
        } else {
            IDE_EXE_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("仅 Windows 支持手动指定路径".into())
    }
}

/// 向后兼容
#[tauri::command]
pub fn set_windsurf_path(path: String) -> Result<(), String> {
    set_ide_path(path)
}

/// 强杀并重启 IDE，使写入的代理配置生效。
/// 注意：强杀会丢失未保存的工作，调用方需先提示用户保存。
#[tauri::command]
pub fn restart_ide(target: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let exe = find_ide_exe(&target)
            .ok_or_else(|| format!("未找到 {} 安装位置，请手动重启", ide_dir_name(&target)))?;
        let proc_name = ide_process_name(&target);

        let _ = Command::new("taskkill")
            .args(["/IM", proc_name, "/F"])
            .output();

        std::thread::sleep(std::time::Duration::from_millis(800));

        Command::new(&exe)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&target), e))?;

        Ok(format!("已重启 {}", ide_dir_name(&target)))
    }

    #[cfg(target_os = "macos")]
    {
        let app = find_ide_app(&target)
            .ok_or_else(|| format!("未找到 {}.app，请手动重启", ide_dir_name(&target)))?;
        let proc_name = match target.as_str() {
            "devin" => "Devin",
            _ => "Windsurf",
        };

        let _ = Command::new("pkill").args(["-x", proc_name]).output();

        std::thread::sleep(std::time::Duration::from_millis(800));

        Command::new("open")
            .args(["-a"])
            .arg(&app)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&target), e))?;

        Ok(format!("已重启 {}", ide_dir_name(&target)))
    }

    #[cfg(target_os = "linux")]
    {
        let bin = find_ide_bin(&target)
            .ok_or_else(|| format!("未找到 {} 可执行文件，请手动重启", ide_dir_name(&target)))?;
        let proc_name = match target.as_str() {
            "devin" => "devin",
            _ => "windsurf",
        };

        let _ = Command::new("pkill").args(["-x", proc_name]).output();

        std::thread::sleep(std::time::Duration::from_millis(800));

        Command::new(&bin)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&target), e))?;

        Ok(format!("已重启 {}", ide_dir_name(&target)))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = target;
        Err("当前平台不支持自动重启 IDE".into())
    }
}

// ═══════ IDE DETECTION ═══════

#[tauri::command]
pub fn is_ide_running(name: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        let process_name = match name.as_str() {
            "windsurf" => "Windsurf",
            "devin" => "Devin",
            _ => return false,
        };
        // Devin 特殊处理：Get-Process Devin 会匹配 devin.exe（CLI 子进程），
        // 需过滤 Path 排除 extensions/windsurf/devin/bin 下的 CLI
        let ps_query = if name == "devin" {
            format!(
                r#"Get-Process {} -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin[/\\]bin' }} | Select-Object -First 1"#,
                process_name
            )
        } else {
            format!(
                "Get-Process {} -ErrorAction SilentlyContinue | Select-Object -First 1",
                process_name
            )
        };
        if let Ok(out) = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_query])
            .output()
        {
            !out.stdout.is_empty()
        } else {
            false
        }
    }

    #[cfg(target_os = "macos")]
    {
        let process_name = match name.as_str() {
            "windsurf" => "Windsurf",
            "devin" => "Devin",
            _ => return false,
        };
        if let Ok(out) = Command::new("pgrep")
            .args(["-x", process_name])
            .output()
        {
            !out.stdout.is_empty()
        } else {
            false
        }
    }

    #[cfg(target_os = "linux")]
    {
        let process_name = match name.as_str() {
            "windsurf" => "windsurf",
            "devin" => "devin",
            _ => return false,
        };
        if let Ok(out) = Command::new("pgrep")
            .args(["-x", process_name])
            .output()
        {
            !out.stdout.is_empty()
        } else {
            false
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[tauri::command]
pub fn detect_target_ide() -> String {
    let windsurf_running = is_ide_running("windsurf".into());
    let devin_running = is_ide_running("devin".into());

    // 优先选择正在运行的 IDE
    if windsurf_running && !devin_running {
        return "windsurf".into();
    }
    if devin_running && !windsurf_running {
        return "devin".into();
    }

    // 两个都在运行或都不在运行，检查哪个有代理配置
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
    }

    // 默认返回 windsurf
    "windsurf".into()
}
