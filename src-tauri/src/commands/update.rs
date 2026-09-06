use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::Updater;
use tauri_plugin_updater::UpdaterExt;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const PENDING_UPDATE_NOTES_FILE: &str = "pending_update_notes.json";
const VERSION_LINE_RESET_TARGET: &str = "0.1.0";

#[tauri::command]
pub fn get_app_version() -> String {
    CURRENT_VERSION.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub last_check_time: u64,
    pub check_interval_hours: u64,
    pub auto_install: bool,
    pub last_run_version: String,
    pub remind_on_update: bool,
    pub skipped_version: String,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            last_check_time: 0,
            check_interval_hours: 1,
            auto_install: false,
            last_run_version: String::new(),
            remind_on_update: true,
            skipped_version: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionJumpInfo {
    pub previous_version: String,
    pub current_version: String,
    pub release_notes: String,
    pub release_notes_zh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingUpdateNotes {
    pub version: String,
    #[serde(default)]
    pub release_notes: String,
    #[serde(default)]
    pub release_notes_zh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub version_line_reset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressPayload {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percentage: Option<f64>,
}

fn settings_path() -> PathBuf {
    crate::commands::config::config_dir_path().join("update_settings.json")
}

fn pending_update_notes_path() -> PathBuf {
    crate::commands::config::config_dir_path().join(PENDING_UPDATE_NOTES_FILE)
}

fn quarantine_corrupt_file(path: &std::path::Path, err: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let corrupt_name = format!("{}.corrupt.{}", path.to_string_lossy(), now);
    let corrupt_path = PathBuf::from(corrupt_name);
    eprintln!(
        "[Updater] File {:?} corrupted ({}), quarantining to {:?}",
        path, err, corrupt_path
    );
    let _ = fs::rename(path, corrupt_path);
}

fn load_pending_update_notes() -> Result<Option<PendingUpdateNotes>, String> {
    let path = pending_update_notes_path();
    if !path.exists() {
        return Ok(None);
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Updater] Failed to read pending notes: {}", e);
            return Ok(None);
        }
    };
    match serde_json::from_str::<PendingUpdateNotes>(&content) {
        Ok(pending) => Ok(Some(pending)),
        Err(e) => {
            quarantine_corrupt_file(&path, &e.to_string());
            Ok(None)
        }
    }
}

fn remove_pending_update_notes_file() {
    let path = pending_update_notes_path();
    if path.exists() {
        let _ = fs::remove_file(path);
    }
}

/// Compare two semantic versions (e.g., "1.0.1" vs "1.0.0")
/// Returns true if first > second
fn compare_versions(latest: &str, current: &str) -> bool {
    let parse_version =
        |v: &str| -> Vec<u32> { v.split('.').filter_map(|s| s.parse::<u32>().ok()).collect() };

    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);

    for i in 0..latest_parts.len().max(current_parts.len()) {
        let latest_part = latest_parts.get(i).unwrap_or(&0);
        let current_part = current_parts.get(i).unwrap_or(&0);

        if latest_part > current_part {
            return true;
        } else if latest_part < current_part {
            return false;
        }
    }

    false
}

fn version_major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse::<u32>().ok()
}

fn is_version_line_reset_update(current: &str, candidate: &str) -> bool {
    candidate == VERSION_LINE_RESET_TARGET && version_major(current).is_some_and(|major| major >= 1)
}

fn updater_with_version_reset(app: &AppHandle) -> Result<Updater, String> {
    app.updater_builder()
        .version_comparator(|current, release| {
            let current_version = current.to_string();
            let release_version = release.version.to_string();
            release.version > current
                || is_version_line_reset_update(&current_version, &release_version)
        })
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_update_settings() -> Result<UpdateSettings, String> {
    let path = settings_path();
    if !path.exists() {
        return Ok(UpdateSettings::default());
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Updater] Failed to read update settings: {}", e);
            return Ok(UpdateSettings::default());
        }
    };
    match serde_json::from_str::<UpdateSettings>(&content) {
        Ok(settings) => Ok(settings),
        Err(e) => {
            quarantine_corrupt_file(&path, &e.to_string());
            Ok(UpdateSettings::default())
        }
    }
}

#[tauri::command]
pub fn patch_update_settings(
    auto_check: Option<bool>,
    check_interval_hours: Option<u64>,
    auto_install: Option<bool>,
    last_run_version: Option<String>,
    remind_on_update: Option<bool>,
    skipped_version: Option<String>,
) -> Result<UpdateSettings, String> {
    let mut settings = get_update_settings()?;
    if let Some(value) = auto_check {
        settings.auto_check = value;
    }
    if let Some(value) = check_interval_hours {
        settings.check_interval_hours = value;
    }
    if let Some(value) = auto_install {
        settings.auto_install = value;
    }
    if let Some(value) = last_run_version {
        settings.last_run_version = value;
    }
    if let Some(value) = remind_on_update {
        settings.remind_on_update = value;
    }
    if let Some(value) = skipped_version {
        settings.skipped_version = value;
    }
    save_update_settings(settings.clone())?;
    Ok(settings)
}

#[tauri::command]
pub fn should_check_updates() -> Result<bool, String> {
    let settings = get_update_settings()?;
    if !settings.auto_check {
        return Ok(false);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let interval_secs = settings.check_interval_hours.max(1) * 3600;
    Ok(now.saturating_sub(settings.last_check_time) >= interval_secs)
}

#[tauri::command]
pub fn update_log(level: String, message: String) -> Result<(), String> {
    let lvl = level.trim().to_lowercase();
    let msg = message.trim();
    if msg.is_empty() {
        return Ok(());
    }
    match lvl.as_str() {
        "error" => eprintln!("[Updater][ERROR] {}", msg),
        "warn" | "warning" => eprintln!("[Updater][WARN] {}", msg),
        _ => eprintln!("[Updater][INFO] {}", msg),
    }
    Ok(())
}

#[tauri::command]
pub fn save_update_settings(settings: UpdateSettings) -> Result<(), String> {
    let dir = crate::commands::config::config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    super::write_atomic(&settings_path(), json.as_bytes())
}

#[tauri::command]
pub fn save_pending_update_notes(
    version: String,
    release_notes: String,
    release_notes_zh: String,
) -> Result<(), String> {
    let dir = crate::commands::config::config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let payload = PendingUpdateNotes {
        version: version.trim().to_string(),
        release_notes,
        release_notes_zh,
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    super::write_atomic(&pending_update_notes_path(), json.as_bytes())
}

#[tauri::command]
pub fn check_version_jump() -> Result<Option<VersionJumpInfo>, String> {
    let mut settings = get_update_settings()?;
    let current = CURRENT_VERSION.to_string();

    if settings.last_run_version.is_empty() || settings.last_run_version == current {
        if settings.last_run_version != current {
            settings.last_run_version = current;
            save_update_settings(settings)?;
        }
        return Ok(None);
    }

    let previous = settings.last_run_version.clone();

    if !compare_versions(&current, &previous) && !is_version_line_reset_update(&previous, &current)
    {
        settings.last_run_version = current;
        save_update_settings(settings)?;
        return Ok(None);
    }

    let mut release_notes = String::new();
    let mut release_notes_zh = String::new();

    if let Ok(Some(pending)) = load_pending_update_notes() {
        if pending.version == current {
            release_notes = pending.release_notes;
            release_notes_zh = pending.release_notes_zh;
            remove_pending_update_notes_file();
        } else if compare_versions(&current, &pending.version)
            || is_version_line_reset_update(&pending.version, &current)
        {
            remove_pending_update_notes_file();
        }
    }

    settings.last_run_version = current.clone();
    save_update_settings(settings)?;

    Ok(Some(VersionJumpInfo {
        previous_version: previous,
        current_version: current,
        release_notes,
        release_notes_zh,
    }))
}

#[tauri::command]
pub fn update_last_check_time() -> Result<(), String> {
    let mut settings = get_update_settings()?;
    settings.last_check_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    save_update_settings(settings)
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = updater_with_version_reset(&app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    if let Some(update) = update {
        let version_line_reset = is_version_line_reset_update(CURRENT_VERSION, &update.version);
        Ok(Some(UpdateInfo {
            version: update.version,
            date: update.date.map(|d| d.to_string()),
            body: update.body,
            version_line_reset,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle, relaunch: bool) -> Result<(), String> {
    let updater = updater_with_version_reset(&app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    if let Some(update) = update {
        let version = update.version.clone();
        let body = update.body.clone().unwrap_or_default();

        // 提前保存更新日志，确保 Windows 下安装程序退出老进程前已写入
        let _ = save_pending_update_notes(version.clone(), body.clone(), body.clone());

        crate::commands::proxy::stop_sidecar_for_update(app.clone())?;

        let app_clone1 = app.clone();
        let app_clone2 = app.clone();
        let mut downloaded = 0;

        update
            .download_and_install(
                move |chunk_length, total_length| {
                    downloaded += chunk_length as u64;
                    let percentage =
                        total_length.map(|total| (downloaded as f64 / total as f64) * 100.0);

                    let _ = app_clone1.emit(
                        "update-download-progress",
                        DownloadProgressPayload {
                            downloaded,
                            total: total_length.map(|t| t as u64),
                            percentage,
                        },
                    );
                },
                move || {
                    let _ = app_clone2.emit("update-download-complete", ());
                },
            )
            .await
            .map_err(|e| e.to_string())?;

        // macOS/Linux 平台非即时退出场景：如需立即重启则调用 restart
        if relaunch {
            app.restart();
        }

        Ok(())
    } else {
        Err("No update available".to_string())
    }
}

/// 重启应用程序（用于更新包就绪后的立即重启生效）
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// 打开下载页面（浏览器）
#[tauri::command]
pub fn open_download_page() -> Result<(), String> {
    let url = "https://github.com/soulvon/AnyBridge/releases/latest";
    open_url_internal(url)
}

/// 用系统默认浏览器打开指定 URL
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_url_internal(&url)
}

fn open_url_internal(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {}", e))?;
    }
    Ok(())
}
