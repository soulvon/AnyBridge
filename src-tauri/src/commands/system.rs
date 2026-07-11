use std::process::Command;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// CA 证书 CommonName。当前版本统一使用 "AnyBridge Local CA"，
/// 跟 package.json 的 name 字段对齐，便于在 certmgr 中一眼辨识。
/// 升级路径：旧版用 "IDE BYOK Local MITM" / "ide-byok Local CA"，
/// 老证书清理逻辑见 `commands::cert_install::cleanup_legacy_cn`。
pub const CA_COMMON_NAME: &str = "AnyBridge Local CA";

/// 老版本 CA 证书 CommonName（升级时需要清理掉）。
pub const LEGACY_CA_COMMON_NAMES: &[&str] = &["IDE BYOK Local MITM", "ide-byok Local CA"];

const MITM_CERT_SAN_VERSION: &str = "2";
const MITM_DNS_NAMES: &[&str] = &[
    "server.self-serve.windsurf.com",
    "server.codeium.com",
    "api2.cursor.sh",
    "authentication.cursor.sh",
    "prod.authentication.cursor.sh",
    "localhost",
];

pub(crate) fn mitm_cert_san_version() -> &'static str {
    MITM_CERT_SAN_VERSION
}

pub(crate) fn mitm_dns_names() -> &'static [&'static str] {
    MITM_DNS_NAMES
}

#[derive(serde::Deserialize)]
pub struct ExportLogEntry {
    ts: String,
    level: String,
    msg: String,
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "启动代理", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止代理", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;

    let tray = TrayIconBuilder::with_id("main-tray");
    let tray_icon = Image::new(include_bytes!("../../icons/tray-icon.rgba"), 64, 64);
    let tray = tray.icon(tray_icon);
    tray.tooltip("AnyBridge")
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
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = crate::commands::proxy::start_proxy_service_impl(app);
                });
            }
            "stop" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = crate::commands::proxy::stop_proxy_service_impl(app);
                });
            }
            "quit" => {
                // 退出只停止 AnyBridge sidecar；IDE 是否切到代理由平台页按钮管理。
                let _ = crate::commands::proxy::stop_proxy_service_impl(app.clone());
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
pub fn export_proxy_logs(entries: Vec<ExportLogEntry>) -> Result<String, String> {
    if entries.is_empty() {
        return Err("暂无日志可导出".into());
    }

    let export_dir = crate::commands::config::config_dir_path().join("log-exports");
    std::fs::create_dir_all(&export_dir).map_err(|e| format!("创建日志导出目录失败: {}", e))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = export_dir.join(format!("byok-logs-{}.txt", ts));
    let mut content = String::new();
    for entry in entries {
        content.push_str(&format!(
            "[{}] {} {}\n",
            entry.ts,
            entry.level.to_uppercase(),
            entry.msg
        ));
    }
    std::fs::write(&path, content).map_err(|e| format!("写入日志文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
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
            let run_value = format!("\"{}\"", exe);
            let output = Command::new("reg")
                .args([
                    "add",
                    key,
                    "/v",
                    "AnyBridge",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &run_value,
                    "/f",
                ])
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "写入开机自启注册表失败: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        } else {
            for value_name in ["AnyBridge", "IDEBYOK"] {
                let _ = Command::new("reg")
                    .args(["delete", key, "/v", value_name, "/f"])
                    .creation_flags(0x0800_0000)
                    .output();
            }
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let plist_name = "com.anybridge.desktop.plist";
        let plist_path = dirs::home_dir()
            .map(|h| h.join("Library/LaunchAgents").join(plist_name))
            .ok_or("无法获取用户目录")?;

        if enabled {
            let plist_content = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.anybridge.desktop</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>"#,
                exe
            );
            std::fs::write(&plist_path, plist_content)
                .map_err(|e| format!("写入 launchd plist 失败: {}", e))?;
        } else {
            let _ = std::fs::remove_file(&plist_path);
            let _ = std::fs::remove_file(
                dirs::home_dir()
                    .map(|h| h.join("Library/LaunchAgents/com.idebyok.desktop.plist"))
                    .ok_or("无法获取用户目录")?,
            );
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let autostart_dir = dirs::config_dir()
            .map(|d| d.join("autostart"))
            .ok_or("无法获取配置目录")?;
        let desktop_path = autostart_dir.join("anybridge.desktop");

        if enabled {
            std::fs::create_dir_all(&autostart_dir).map_err(|e| e.to_string())?;
            // Desktop Entry Spec: Exec 值中的空格/引号需要转义
            let exec = format!(
                "\"{}\"",
                exe.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let desktop_content = format!(
                "[Desktop Entry]\nType=Application\nName=AnyBridge\nExec={}\nHidden=false\nX-GNOME-Autostart-enabled=true\n",
                exec
            );
            std::fs::write(&desktop_path, desktop_content)
                .map_err(|e| format!("写入 .desktop 失败: {}", e))?;
        } else {
            let _ = std::fs::remove_file(&desktop_path);
            let _ = std::fs::remove_file(autostart_dir.join("ide-byok.desktop"));
        }
        Ok(())
    }
}

#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        for value_name in ["AnyBridge", "IDEBYOK"] {
            let output = Command::new("reg")
                .args(["query", key, "/v", value_name])
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string())?;
            if output.status.success() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    #[cfg(target_os = "macos")]
    {
        let launch_agents = dirs::home_dir()
            .map(|h| h.join("Library/LaunchAgents"))
            .ok_or("无法获取用户目录")?;
        Ok(launch_agents.join("com.anybridge.desktop.plist").exists()
            || launch_agents.join("com.idebyok.desktop.plist").exists())
    }

    #[cfg(target_os = "linux")]
    {
        let autostart_dir = dirs::config_dir()
            .map(|d| d.join("autostart"))
            .ok_or("无法获取配置目录")?;
        Ok(autostart_dir.join("anybridge.desktop").exists()
            || autostart_dir.join("ide-byok.desktop").exists())
    }
}

#[tauri::command]
pub fn open_config_dir(which: String) -> Result<(), String> {
    let base = crate::commands::config::config_dir_path();
    let target = match which.as_str() {
        "certs" => base.join("certs"),
        _ => base,
    };
    reveal_path_impl(&target)?;
    Ok(())
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path);
    let parent = target
        .parent()
        .ok_or_else(|| "无法获取配置文件所在目录".to_string())?
        .to_path_buf();
    reveal_path_impl(&parent)
}

fn reveal_path_impl(target: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn ensure_mitm_certs() -> Result<(std::path::PathBuf, bool), String> {
    use rcgen::{CertificateParams, DistinguishedName, DnType, SanType};

    let certs_dir = crate::commands::config::config_dir_path().join("certs");
    std::fs::create_dir_all(&certs_dir).map_err(|e| e.to_string())?;

    let cert_path = certs_dir.join("server.codeium.com.pem");
    let key_path = certs_dir.join("server.codeium.com-key.pem");
    let san_marker_path = certs_dir.join("san-version");

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let san_ok = std::fs::read_to_string(&san_marker_path)
        .map(|s| s.trim() == MITM_CERT_SAN_VERSION)
        .unwrap_or(false);
    let already_complete = cert_ok && key_ok && san_ok;

    if !already_complete {
        let mut params = CertificateParams::new(
            mitm_dns_names()
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<String>>(),
        )
        .map_err(|e| e.to_string())?;
        // CommonName 跟项目产品名 (tauri.conf.json productName="AnyBridge") 对齐，
        // 便于在 certmgr 中一眼辨识。
        // 升级路径: 旧版 "IDE BYOK Local MITM" / "ide-byok Local CA" → 新版 "AnyBridge Local CA",
        // 老证书清理逻辑见 cert_install::cleanup_legacy_cn。
        // 说明: rcgen 0.13 的 DnType 不一定有 OrganizationName 变体, 这里只设
        // CommonName (X.509 Subject 最显眼的字段), 配合 SAN 就能保证 Electron
        // 进程的 TLS 校验通过。

        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, CA_COMMON_NAME);
        params.distinguished_name = dn;
        params.subject_alt_names = mitm_dns_names()
            .iter()
            .map(|name| {
                Ok(SanType::DnsName(
                    (*name)
                        .try_into()
                        .map_err(|_| format!("bad san: {}", name))?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let key_pair = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;

        std::fs::write(&cert_path, cert.pem()).map_err(|e| e.to_string())?;
        std::fs::write(&key_path, key_pair.serialize_pem()).map_err(|e| e.to_string())?;
        std::fs::write(&san_marker_path, format!("{}\n", MITM_CERT_SAN_VERSION))
            .map_err(|e| e.to_string())?;
    }

    Ok((certs_dir, !already_complete))
}

#[tauri::command]
pub fn generate_certs() -> Result<String, String> {
    let (certs_dir, generated) = ensure_mitm_certs()?;

    // 生成完（或已存在）自动调一次证书安装：
    // - 首次装会触发 CurrentUser\Root 路径（零弹窗）
    // - 已装会快速返回幂等
    // 注意：这里只装证书，不返回错误——证书生成本身已成功，证书安装失败
    // 也不影响 MITM 代理运行（仅影响 IDE 是否信任），由用户在「环境体检」
    // 里查看具体状态。
    match crate::commands::cert_install::install_ca() {
        Ok(install_msg) => {
            let gen_msg = if generated {
                format!("已生成证书到 {}", certs_dir.to_string_lossy())
            } else {
                format!("证书已存在 ({})", certs_dir.to_string_lossy())
            };
            Ok(format!("{}\n{}", gen_msg, install_msg))
        }
        Err(e) => {
            // 证书安装失败不影响证书生成结果，但要让用户知道
            let gen_msg = if generated {
                "已生成证书"
            } else {
                "证书已存在"
            };
            Ok(format!(
                "{}。⚠ 证书安装到系统根证书库失败: {}。请在「平台 > 设置 > 环境检测」点击「安装证书」",
                gen_msg, e
            ))
        }
    }
}

/// 配置键：缓存上次探测成功的 IDE exe 路径，
/// 也用作用户手动指定路径的入口（设置页可写入此键）。
#[cfg(target_os = "windows")]
const IDE_EXE_KEY: &str = "ideExePath";
#[cfg(target_os = "windows")]
const DEVIN_EXE_KEY: &str = "devinExePath";
#[cfg(target_os = "windows")]
const CURSOR_EXE_KEY: &str = "cursorExePath";
#[cfg(target_os = "macos")]
const WINDSURF_APP_KEY: &str = "windsurfAppPath";
#[cfg(target_os = "macos")]
const DEVIN_APP_KEY: &str = "devinAppPath";
#[cfg(target_os = "macos")]
const CURSOR_APP_KEY: &str = "cursorAppPath";
#[cfg(target_os = "linux")]
const WINDSURF_BIN_KEY: &str = "windsurfBinPath";
#[cfg(target_os = "linux")]
const DEVIN_BIN_KEY: &str = "devinBinPath";
#[cfg(target_os = "linux")]
const CURSOR_BIN_KEY: &str = "cursorBinPath";

/// 根据 target 返回配置键名。
#[cfg(target_os = "windows")]
fn ide_exe_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_EXE_KEY,
        "cursor" => CURSOR_EXE_KEY,
        _ => IDE_EXE_KEY,
    }
}

#[cfg(target_os = "macos")]
fn ide_app_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_APP_KEY,
        "cursor" => CURSOR_APP_KEY,
        _ => WINDSURF_APP_KEY,
    }
}

#[cfg(target_os = "linux")]
fn ide_bin_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_BIN_KEY,
        "cursor" => CURSOR_BIN_KEY,
        _ => WINDSURF_BIN_KEY,
    }
}

/// 根据 target 返回可执行文件名（Windows），用于默认安装位置拼接。
/// 注意：Devin 的安装目录下可执行文件叫 Devin.exe，但运行时主进程名仍为 Windsurf.exe。
#[cfg(target_os = "windows")]
fn ide_exe_filename(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.exe",
        "cursor" => "Cursor.exe",
        _ => "Windsurf.exe",
    }
}

#[cfg(target_os = "macos")]
fn ide_app_filename(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.app",
        "cursor" => "Cursor.app",
        _ => "Windsurf.app",
    }
}

#[cfg(target_os = "linux")]
fn ide_bin_filename(target: &str) -> &'static str {
    match target {
        "devin" => "devin",
        "cursor" => "cursor",
        _ => "windsurf",
    }
}

/// 根据 target 返回文件夹名（Windsurf/Devin）。
fn ide_dir_name(target: &str) -> &'static str {
    match target {
        "devin" => "Devin",
        "cursor" => "Cursor",
        _ => "Windsurf",
    }
}

#[cfg(target_os = "macos")]
fn is_ide_app_for_target(target: &str, path: &std::path::Path) -> bool {
    path.exists()
        && path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(ide_app_filename(target)))
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn is_ide_bin_for_target(target: &str, path: &std::path::Path) -> bool {
    path.exists()
        && path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(ide_bin_filename(target)))
            .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn path_has_component(path: &std::path::Path, name: &str) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(name))
}

#[cfg(target_os = "windows")]
fn is_cli_subprocess_path(path: &std::path::Path) -> bool {
    let s = path.to_string_lossy().replace('/', "\\").to_lowercase();
    s.contains("\\extensions\\windsurf\\devin\\") && s.contains("\\bin\\")
}

#[cfg(target_os = "windows")]
fn is_ide_exe_for_target(target: &str, path: &std::path::Path) -> bool {
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
        _ => file_name.eq_ignore_ascii_case("Windsurf.exe") && !in_devin_dir,
    }
}

#[cfg(target_os = "windows")]
fn windows_drive_roots() -> Vec<std::path::PathBuf> {
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
fn common_ide_candidates(target: &str) -> Vec<std::path::PathBuf> {
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

    // 2. 运行中进程的真实路径
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
    } else {
        format!(
            r#"Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch '[\\/]devin[\\/]' }} | Select-Object -First 1 -ExpandProperty Path"#
        )
    };
    if let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_query])
        .creation_flags(0x0800_0000)
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

    // 3. 常见安装位置。除系统盘外，也扫描 D:/E: 等盘的浅层 Program Files。
    for p in common_ide_candidates(target) {
        if is_ide_exe_for_target(target, &p) {
            return cache_and_return(p);
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
        .creation_flags(0x0800_0000)
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

fn restart_ide_impl(target: String) -> Result<String, String> {
    let t = if target == "auto" {
        detect_target_ide()
    } else {
        target
    };
    #[cfg(target_os = "windows")]
    {
        let exe = find_ide_exe(&t)
            .ok_or_else(|| format!("未找到 {} 安装位置，请手动重启", ide_dir_name(&t)))?;

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
            // PowerShell 仅负责筛选出目标 PID（按安装目录路径过滤，同时覆盖
            // Windsurf.exe 和 Devin.exe 两个主进程名）。实际 kill 在 Rust 侧用
            // taskkill /F /T 完成——避免在 PowerShell 内 `& taskkill` spawn 外部
            // 子进程，每个进程都会弹一个 CMD 窗口。
            let pid_script = format!(
                r#"$dir = '{}'; foreach ($name in @('Windsurf','Devin')) {{ Get-Process $name -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path.StartsWith($dir, 'CurrentCultureIgnoreCase') }} | ForEach-Object {{ $_.Id }} }}"#,
                install_dir.replace('\'', "''")
            );
            if let Ok(out) = Command::new("powershell")
                .args(["-NoProfile", "-Command", &pid_script])
                .creation_flags(0x0800_0000)
                .output()
            {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    let pid = line.trim();
                    if pid.is_empty() {
                        continue;
                    }
                    let _ = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", pid])
                        .creation_flags(0x0800_0000)
                        .output();
                }
            }
        } else {
            let image = if t == "cursor" {
                "Cursor.exe"
            } else {
                "Windsurf.exe"
            };
            // 用 taskkill /F /T /IM 杀整个进程树（含 renderer/GPU 子进程）
            let _ = Command::new("taskkill")
                .args(["/IM", image, "/F", "/T"])
                .creation_flags(0x0800_0000)
                .output();
        }

        // 等待进程退出，最多 3 秒（验证是否真的杀死了）
        let mut dead = false;
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !is_ide_running(t.clone()) {
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

        // 启动新 IDE 进程，设置 CREATE_NO_WINDOW 防止 CMD 窗口弹出
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new(&exe)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))?;

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(target_os = "macos")]
    {
        let app = find_ide_app(&t)
            .ok_or_else(|| format!("未找到 {}.app，请手动重启", ide_dir_name(&t)))?;

        // 优先按路径过滤后的 PID 杀（覆盖 Devin 主进程仍叫 Windsurf 的情况）。
        // 回退 killall 仅用安全进程名，绝不因 Devin 去 killall Windsurf。
        let pids = unix_ide_pids(&t);
        if pids.is_empty() {
            for name in unix_ide_fallback_kill_names(&t) {
                let _ = Command::new("killall").args([name]).output();
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
            if !is_ide_running(t.clone()) {
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

        Command::new("open")
            .args(["-a"])
            .arg(&app)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))?;

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
            if !is_ide_running(t.clone()) {
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

/// 强杀并重启 IDE，使写入的代理配置生效。
/// 注意：强杀会丢失未保存的工作，调用方需先提示用户保存。
#[tauri::command]
pub async fn restart_ide(target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || restart_ide_impl(target))
        .await
        .map_err(|e| format!("重启 IDE 任务失败: {}", e))?
}

// ═══════ IDE DETECTION ═══════

/// Unix 上「按进程名」回退杀进程时允许的名字。
/// 注意：Devin 绝不能把 Windsurf 放进回退列表——路径未命中时 killall Windsurf 会误杀真·Windsurf。
/// Devin 主进程若仍叫 Windsurf，必须靠 unix_ide_pids 的路径过滤命中 PID。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_ide_fallback_kill_names(target: &str) -> &'static [&'static str] {
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
fn unix_ide_process_names(target: &str) -> &'static [&'static str] {
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
fn unix_ide_pids(target: &str) -> Vec<u32> {
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
        let Some(pid_str) = parts.next() else { continue };
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
fn find_ide_app_or_bin_path(target: &str) -> Option<std::path::PathBuf> {
    find_ide_app(target)
}

#[cfg(target_os = "linux")]
fn find_ide_app_or_bin_path(target: &str) -> Option<std::path::PathBuf> {
    find_ide_bin(target)
}

#[tauri::command]
pub fn is_ide_running(name: String) -> bool {
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
        } else {
            format!(
                r#"Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch '[\\/]devin[\\/]' }} | Select-Object -First 1"#
            )
        };
        if let Ok(out) = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_query])
            .creation_flags(0x0800_0000)
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
    let windsurf_running = is_ide_running("windsurf".into());
    let devin_running = is_ide_running("devin".into());
    let cursor_running = is_ide_running("cursor".into());

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

        let cursor_settings = config_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    // macOS/Linux 同样检查代理配置
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
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

    // 都没有代理配置，检查哪个安装了。默认优先 Windsurf，避免双安装机器误接入 Devin。
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn mitm_dns_names_include_cursor_hosts_without_duplicates() {
        let names = mitm_dns_names();
        let unique = names.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(unique.len(), names.len(), "MITM SAN list has duplicates");

        for expected in [
            "server.self-serve.windsurf.com",
            "server.codeium.com",
            "api2.cursor.sh",
            "authentication.cursor.sh",
            "prod.authentication.cursor.sh",
            "localhost",
        ] {
            assert!(
                unique.contains(expected),
                "MITM SAN list is missing {}",
                expected
            );
        }
        assert_eq!(MITM_CERT_SAN_VERSION, "2");
    }
}
