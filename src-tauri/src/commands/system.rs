use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

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
                    let _ = crate::commands::proxy::start_proxy(app.clone(), state);
                }
            }
            "stop" => {
                if let Some(state) = app.try_state::<crate::commands::proxy::ProxyState>() {
                    let _ = crate::commands::proxy::stop_proxy(state);
                }
            }
            "quit" => {
                // 退出前还原 Windsurf 配置。
                let _ = crate::commands::windsurf_config::restore();
                let _ = crate::commands::workbench_inject::restore();
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
                .args(["add", key, "/v", "WindsurfBYOK", "/t", "REG_SZ", "/d", &exe, "/f"])
                .output()
                .map_err(|e| e.to_string())?;
        } else {
            let _ = Command::new("reg")
                .args(["delete", key, "/v", "WindsurfBYOK", "/f"])
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

/// 配置键：缓存上次探测成功的 Windsurf.exe 路径，
/// 也用作用户手动指定路径的入口（设置页可写入此键）。
#[cfg(target_os = "windows")]
const WINDSURF_EXE_KEY: &str = "windsurfExePath";

/// 探测 Windsurf 安装路径（Windows）。
///
/// 探测顺序（任一命中即停，且会把结果回写配置缓存）：
///   1. 配置缓存 / 用户手动指定路径（不受运行状态、安装盘符影响）
///   2. 运行中进程的真实可执行路径
///   3. 常见默认安装位置
///   4. 注册表卸载项（覆盖自定义盘符安装，如装在 E:\）
#[cfg(target_os = "windows")]
pub(crate) fn find_windsurf_exe() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    use std::process::Command;

    // 1. 配置缓存 / 用户手动指定：最高优先，绕过所有自动探测。
    if let Some(cached) = crate::commands::config::read_config_value(WINDSURF_EXE_KEY) {
        let p = PathBuf::from(&cached);
        if p.exists() {
            return Some(p);
        }
    }

    // 命中后回写缓存，下次即使 Windsurf 未运行也能直接命中。
    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(
            WINDSURF_EXE_KEY,
            &p.to_string_lossy(),
        );
        Some(p)
    };

    // 2. 运行中进程的真实路径（最可靠，不受自定义安装目录影响）。
    if let Ok(out) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-Process Windsurf -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
        ])
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

    // 3. 常见默认安装位置。
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join("Programs").join("Windsurf").join("Windsurf.exe");
        if p.exists() {
            return cache_and_return(p);
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            let p = PathBuf::from(pf).join("Windsurf").join("Windsurf.exe");
            if p.exists() {
                return cache_and_return(p);
            }
        }
    }

    // 4. 注册表卸载项：Windsurf 安装器写在 HKCU/HKLM 的 Uninstall 下，
    //    InstallLocation 指向安装根目录，覆盖装在非默认盘符（E:\ 等）的情况。
    if let Some(p) = find_windsurf_exe_from_registry() {
        if p.exists() {
            return cache_and_return(p);
        }
    }

    None
}

/// 从注册表卸载项探测 Windsurf 安装目录。
/// 遍历 HKCU/HKLM 的 Uninstall 项，匹配 DisplayName 含 "Windsurf" 的条目，
/// 取其 InstallLocation 拼出 Windsurf.exe。
#[cfg(target_os = "windows")]
fn find_windsurf_exe_from_registry() -> Option<std::path::PathBuf> {
    use std::process::Command;

    // 一次 PowerShell 查询三处常见 Uninstall 根，输出首个匹配的 InstallLocation。
    let script = r#"
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($r in $roots) {
  $hit = Get-ItemProperty $r -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*Windsurf*' -and $_.InstallLocation } |
    Select-Object -First 1 -ExpandProperty InstallLocation
  if ($hit) { Write-Output $hit; break }
}
"#;

    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .ok()?;
    let loc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if loc.is_empty() {
        return None;
    }
    let exe = std::path::PathBuf::from(loc).join("Windsurf.exe");
    if exe.exists() {
        Some(exe)
    } else {
        None
    }
}

/// 探测 Windsurf.app 路径（macOS）。
#[cfg(target_os = "macos")]
pub(crate) fn find_windsurf_app() -> Option<std::path::PathBuf> {
    // 系统级安装
    let system = std::path::PathBuf::from("/Applications/Windsurf.app");
    if system.exists() {
        return Some(system);
    }
    // 用户级安装：~/Applications/Windsurf.app
    if let Some(home) = dirs::home_dir() {
        let user = home.join("Applications").join("Windsurf.app");
        if user.exists() {
            return Some(user);
        }
    }
    None
}

/// 探测 windsurf 可执行文件（Linux）。
#[cfg(target_os = "linux")]
pub(crate) fn find_windsurf_bin() -> Option<std::path::PathBuf> {
    let candidates = [
        "/usr/share/windsurf/windsurf",
        "/usr/bin/windsurf",
        "/opt/Windsurf/windsurf",
        "/snap/bin/windsurf",
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 探测并返回当前定位到的 Windsurf.exe 路径（设置页展示用）。
/// 返回 None 表示自动探测失败，需用户手动指定。
#[tauri::command]
pub fn detect_windsurf_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        find_windsurf_exe().map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        find_windsurf_app().map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "linux")]
    {
        find_windsurf_bin().map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// 手动设置 Windsurf.exe 路径（自动探测失败时的兜底，写入配置缓存）。
/// 校验路径存在且文件名是 Windsurf.exe，避免写入错误路径导致后续误判。
#[tauri::command]
pub fn set_windsurf_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_exe = p
            .file_name()
            .map(|n| n.eq_ignore_ascii_case("Windsurf.exe"))
            .unwrap_or(false);
        if !is_exe {
            return Err("请指向 Windsurf.exe".into());
        }
        crate::commands::config::write_config_value(WINDSURF_EXE_KEY, &path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("仅 Windows 支持手动指定路径".into())
    }
}

/// 强杀并重启 Windsurf，使写入的代理配置生效。
/// 注意：强杀会丢失未保存的工作，调用方需先提示用户保存。
#[tauri::command]
pub fn restart_windsurf() -> Result<String, String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        let exe = find_windsurf_exe()
            .ok_or("未找到 Windsurf 安装位置，请手动重启 Windsurf")?;

        // 强杀所有 Windsurf 进程；未运行时 taskkill 返回非零，忽略错误。
        let _ = Command::new("taskkill")
            .args(["/IM", "Windsurf.exe", "/F"])
            .output();

        // 稍等进程退出释放文件锁，再重新拉起。
        std::thread::sleep(std::time::Duration::from_millis(800));

        Command::new(&exe)
            .spawn()
            .map_err(|e| format!("重启 Windsurf 失败: {}", e))?;

        Ok("已重启 Windsurf".into())
    }

    #[cfg(target_os = "macos")]
    {
        let app = find_windsurf_app()
            .ok_or("未找到 Windsurf.app，请手动重启 Windsurf")?;

        // 按可执行名精确匹配杀进程；未运行时返回非零，忽略。
        let _ = Command::new("pkill").args(["-x", "Windsurf"]).output();

        std::thread::sleep(std::time::Duration::from_millis(800));

        // open -a 通过 LaunchServices 重新打开 .app 包。
        Command::new("open")
            .args(["-a"])
            .arg(&app)
            .spawn()
            .map_err(|e| format!("重启 Windsurf 失败: {}", e))?;

        Ok("已重启 Windsurf".into())
    }

    #[cfg(target_os = "linux")]
    {
        let bin = find_windsurf_bin()
            .ok_or("未找到 windsurf 可执行文件，请手动重启 Windsurf")?;

        // 精确匹配可执行名，避免误杀路径含 "windsurf" 的本应用自身。
        let _ = Command::new("pkill").args(["-x", "windsurf"]).output();

        std::thread::sleep(std::time::Duration::from_millis(800));

        Command::new(&bin)
            .spawn()
            .map_err(|e| format!("重启 Windsurf 失败: {}", e))?;

        Ok("已重启 Windsurf".into())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("当前平台不支持自动重启 Windsurf".into())
    }
}
