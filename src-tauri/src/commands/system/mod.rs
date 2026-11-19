#[cfg(unix)]
use std::fs::File;
use std::process::Command;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};


#[derive(serde::Deserialize)]
pub struct ExportLogEntry {
    ts: String,
    level: String,
    msg: String,
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "启动网关", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止网关", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;

    let tray = TrayIconBuilder::with_id("main-tray");
    let tray_icon = Image::new(include_bytes!("../../../icons/tray-icon.rgba"), 64, 64);
    let tray = tray.icon(tray_icon);
    tray.tooltip("AnyBridge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    // Windows 上先恢复 skip_taskbar + unminimize，配合 CloseRequested 的 minimize 方案。
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_skip_taskbar(false);
                        let _ = w.unminimize();
                        // 短暂置顶绕过 Windows 焦点防盗保护
                        let _ = w.set_always_on_top(true);
                    }
                    let _ = w.show();
                    let _ = w.set_focus();
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_always_on_top(false);
                    }
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
                // 退出只停止 AnyBridge sidecar；IDE 是否切到网关由平台页按钮管理。
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
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_skip_taskbar(false);
                        let _ = w.unminimize();
                        let _ = w.set_always_on_top(true);
                    }
                    let _ = w.show();
                    let _ = w.set_focus();
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_always_on_top(false);
                    }
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

    // 清理历史导出：每次导出都是一份完整日志快照（可能数 MB），只保留最近
    // 10 份，防止用户目录 log-exports 无限堆积。
    const MAX_EXPORTS: usize = 10;
    if let Ok(items) = std::fs::read_dir(&export_dir) {
        let mut files: Vec<std::path::PathBuf> = items
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("byok-logs-")
            })
            .map(|entry| entry.path())
            .collect();
        if files.len() > MAX_EXPORTS {
            files.sort_by_key(|p| {
                std::fs::metadata(p)
                    .and_then(|m| m.modified())
                    .map(|t| {
                        t.duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0)
                    })
                    .unwrap_or(0)
            });
            for stale in files.iter().take(files.len() - MAX_EXPORTS) {
                let _ = std::fs::remove_file(stale);
            }
        }
    }

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
                .hide_window()
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
                    .hide_window()
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
            let exec = format!("\"{}\"", exe.replace('\\', "\\\\").replace('"', "\\\""));
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
                .hide_window()
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

pub(super) fn expand_user_path(path: &str) -> std::path::PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        return dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(trimmed)
}

/// 弹出系统文件选择对话框。`extensions` 形如 ["json","jsonl","txt"]。取消返回 None。
#[tauri::command]
pub async fn pick_file(
    title: Option<String>,
    extensions: Option<Vec<String>>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let title = title
        .unwrap_or_else(|| "选择文件".into())
        .trim()
        .to_string();
    let default_path = default_path.unwrap_or_default().trim().to_string();
    let extensions: Vec<String> = extensions
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_string())
        .filter(|e| !e.is_empty())
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(&title);
        if !extensions.is_empty() {
            let refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter("支持的文件", &refs);
        }
        if !default_path.is_empty() {
            let p = expand_user_path(&default_path);
            if p.is_dir() {
                dialog = dialog.set_directory(&p);
            } else if let Some(parent) = p.parent() {
                if parent.is_dir() {
                    dialog = dialog.set_directory(parent);
                }
            }
        }
        Ok(dialog.pick_file().map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("文件选择对话框失败: {}", e))?
}

/// 弹出系统文件夹选择对话框。取消返回 None。
#[tauri::command]
pub async fn pick_directory(
    title: Option<String>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let title = title
        .unwrap_or_else(|| "选择文件夹".into())
        .trim()
        .to_string();
    let default_path = default_path.unwrap_or_default().trim().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(&title);
        if !default_path.is_empty() {
            let p = expand_user_path(&default_path);
            if p.is_dir() {
                dialog = dialog.set_directory(&p);
            } else if let Some(parent) = p.parent() {
                if parent.is_dir() {
                    dialog = dialog.set_directory(parent);
                }
            }
        }
        Ok(dialog
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("打开文件夹选择对话框失败: {}", e))?
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = expand_user_path(&path);
    // 文件：打开父目录；目录：直接打开
    let parent = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .ok_or_else(|| "无法获取配置文件所在目录".to_string())?
            .to_path_buf()
    };
    reveal_path_impl(&parent)
}

pub(super) fn reveal_path_impl(target: &std::path::Path) -> Result<(), String> {
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

/// 将单个证书或私钥先写入同目录唯一临时文件，再提交为目标文件（委托统一 `store_io` 原语）。
pub(super) fn write_atomic(path: &std::path::Path, contents: impl AsRef<[u8]>) -> Result<(), String> {
    crate::commands::store_io::write_atomic_private(path, contents.as_ref())
}

// 证书目录可能早已由旧版本创建，写入前仍需收紧目录权限；Windows 不改变既有 ACL。
pub(super) fn restrict_cert_dir_permissions(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)
            .map_err(|e| format!("读取证书目录权限失败 {}: {}", path.to_string_lossy(), e))?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("收紧证书目录权限失败 {}: {}", path.to_string_lossy(), e))?;
    }
    let _ = path;
    Ok(())
}

#[cfg(any(unix, test))]
pub(super) fn write_private_cert_temp(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    crate::commands::store_io::write_private_cert_temp(path, contents)
}

#[cfg(any(unix, test))]
pub(super) fn commit_unix_cert_file(tmp: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    crate::commands::store_io::commit_unix_cert_file(tmp, path)
}


mod certs;
mod ide_paths;
mod process_probe;
mod restart;

pub use certs::*;
pub use ide_paths::*;
pub use process_probe::*;
pub use restart::*;
pub(crate) use restart::HideWindow;

#[cfg(test)]
mod tests;
