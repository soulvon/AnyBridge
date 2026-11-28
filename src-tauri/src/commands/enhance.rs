//! 增强插件（Antigravity 桌面端社区增强项）管理命令。
//!
//! 当前内置管理：
//! - `antigravity-context-viewer`（修改 `app.asar`，注入顶栏看板与内置汉化）
//! - `antigravity-usage-monitor`（Antigravity 原生插件，零改包提供实时速率、上下文与配额面板）
//! - `antigravity-codex-theme`（本地 CDP 通道注入 Codex 昼夜双主题与四态用量）
//! - `chuanban-antigravity-theme-patch`（本地 CDP 通道注入莫兰迪/暖纸五段主题与统计面板）
//!
//! 状态探测直接轻量读取文件与 `app.asar` header（毫秒级，不阻塞启动 Node）；
//! 安装器托管在数据目录 `AnyBridge/enhance/<id>`，缺失或更新时复用扩展下载链路从 GitHub 拉取。

mod cdp_themes;
mod conflicts;
mod github_detail;
mod native_plugins;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use super::antigravity_localization::{
    hub_asar_path, hub_has_byok_patch, invalidate_status_cache, is_hub_localized, patch_hub_asar,
    read_asar_header, read_asar_node_text,
};
use super::extensions::{
    download_asset_with, is_newer_version, latest_release_tag, normalize_version,
};
use super::platforms::patch_antigravity_hub_asar;
use super::plugin_asset::extract_zip_filtered;
use super::system::HideWindow;

use cdp_themes::{
    build_cdp_theme_status, find_cdp_theme_spec, has_active_hub_cdp_theme, install_cdp_theme,
    uninstall_cdp_theme, CDP_THEME_SPECS,
};
use conflicts::{apply_conflict_matrix, EnhanceConflict};
use github_detail::{
    fetch_enhance_github_detail, fetch_enhance_github_image, EnhanceGithubDetail,
};
use native_plugins::{
    build_native_plugin_status, find_native_plugin_spec, has_active_native_cdp_plugin,
    install_native_plugin, uninstall_native_plugin, NATIVE_PLUGIN_SPECS,
};

/// 供 IDE 重启链路复用：若白色 Antigravity 装了任一依赖本地调试通道的增强插件，重启时保留 `--remote-debugging-port=0`。
pub(crate) fn has_active_hub_cdp_consumer() -> bool {
    has_active_hub_cdp_theme() || has_active_native_cdp_plugin()
}

const CONTEXT_VIEWER_ID: &str = "antigravity-context-viewer";
const CONTEXT_VIEWER_REPO: &str = "elviscjn-cjn/antigravity-context-viewer";

static LATEST_VERSION_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub(super) fn cached_latest_version(id: &str) -> Option<String> {
    LATEST_VERSION_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
}

pub(super) fn set_cached_latest_version(id: &str, ver: &str) {
    let norm = normalize_version(ver);
    if norm.is_empty() {
        return;
    }
    let mut slot = LATEST_VERSION_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    slot.insert(id.to_string(), norm);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceItemStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repo: String,
    pub installed: bool,
    pub version: Option<String>,
    pub installer_version: Option<String>,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub host_installed: bool,
    pub host_version: Option<String>,
    pub compatible: bool,
    #[serde(default)]
    pub conflicts_with: Vec<String>,
    #[serde(default)]
    pub conflicts: Vec<EnhanceConflict>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceUpdateInfo {
    pub id: String,
    pub current_version: Option<String>,
    pub installer_version: Option<String>,
    pub latest_version: String,
    pub has_update: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AsarContextViewerProbe {
    pub installed: bool,
    pub disk_version: Option<String>,
    pub host_version: Option<String>,
}

pub(super) fn enhance_installer_dir(id: &str) -> PathBuf {
    if id == CONTEXT_VIEWER_ID {
        if let Ok(raw) = std::env::var("ANYBRIDGE_CONTEXT_VIEWER_DIR") {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AnyBridge")
        .join("enhance")
        .join(id)
}

fn read_installer_version(dir: &Path) -> Option<String> {
    if !dir.join("cli.js").is_file() {
        return None;
    }
    let raw = fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(normalize_version)
        .filter(|s| !s.is_empty())
}

pub(crate) fn inspect_hub_asar_context_viewer(
    asar_path: &Path,
) -> Result<AsarContextViewerProbe, String> {
    let mut file = fs::File::open(asar_path).map_err(|e| format!("读取 app.asar 失败：{e}"))?;
    let (_, payload_start, header) = read_asar_header(&mut file)?;

    let host_version = read_asar_node_text(&mut file, &header, payload_start, &["package.json"])
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(str::to_string));

    let utils_ok = read_asar_node_text(&mut file, &header, payload_start, &["dist", "utils.js"])
        .map(|s| {
            s.contains("installContextMeter(")
                || s.contains("Antigravity Context Meter utils Injection Start")
        })
        .unwrap_or(false);

    let disk_version = if utils_ok {
        read_asar_node_text(
            &mut file,
            &header,
            payload_start,
            &["dist", "meter-manifest.json"],
        )
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("version")
                .or_else(|| v.get("meterVersion"))
                .and_then(|s| s.as_str())
                .map(normalize_version)
                .filter(|s| !s.is_empty())
        })
    } else {
        None
    };

    Ok(AsarContextViewerProbe {
        installed: utils_ok,
        disk_version,
        host_version,
    })
}

fn build_context_viewer_status(
    asar_override: Option<&Path>,
    dir_override: Option<&Path>,
) -> EnhanceItemStatus {
    let installer_dir = dir_override
        .map(PathBuf::from)
        .unwrap_or_else(|| enhance_installer_dir(CONTEXT_VIEWER_ID));
    let installer_version = read_installer_version(&installer_dir);
    let latest_version = cached_latest_version(CONTEXT_VIEWER_ID);

    let asar_path = asar_override.map(PathBuf::from).or_else(hub_asar_path);
    let mut installed = false;
    let mut disk_version: Option<String> = None;
    let mut host_version: Option<String> = None;
    let mut host_installed = false;
    let mut compatible = false;
    let mut detail = String::new();

    if let Some(asar) = asar_path {
        host_installed = true;
        match inspect_hub_asar_context_viewer(&asar) {
            Ok(probe) => {
                installed = probe.installed;
                disk_version = probe.disk_version;
                host_version = probe.host_version;
                compatible = true;
            }
            Err(err) => {
                detail = err;
            }
        }
    } else {
        detail = "未检测到 Antigravity 桌面端安装目录。".to_string();
    }

    let effective_ver = if installed {
        disk_version.clone().or_else(|| installer_version.clone())
    } else {
        installer_version.clone()
    };
    let compare_base = if installed {
        disk_version.as_deref()
    } else {
        installer_version.as_deref()
    };
    let has_update = match (latest_version.as_deref(), compare_base) {
        (Some(latest), Some(cur)) => is_newer_version(latest, cur).unwrap_or(false),
        _ => false,
    };

    EnhanceItemStatus {
        id: CONTEXT_VIEWER_ID.to_string(),
        name: CONTEXT_VIEWER_ID.to_string(),
        description: "在 Antigravity 顶栏注入实时上下文与 Token 用量看板，内置官方界面汉化切换、多账号配额隔离、热切号与请求时间线。".to_string(),
        repo: CONTEXT_VIEWER_REPO.to_string(),
        installed,
        version: effective_ver,
        installer_version,
        latest_version,
        has_update,
        host_installed,
        host_version,
        compatible,
        conflicts_with: Vec::new(),
        conflicts: Vec::new(),
        detail,
    }
}

pub(super) fn should_keep_archive_entry(rel: &Path) -> bool {
    let first = rel
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .unwrap_or("");
    if matches!(
        first.to_ascii_lowercase().as_str(),
        "assets" | ".github" | "__pycache__"
    ) {
        return false;
    }
    if let Some(ext) = rel.extension().and_then(|e| e.to_str()) {
        if matches!(
            ext.to_ascii_lowercase().as_str(),
            "mp4" | "gif" | "mov" | "webm" | "avi"
        ) {
            return false;
        }
    }
    true
}

fn is_transient_win_fs_error(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    matches!(err.raw_os_error(), Some(5 | 32 | 33 | 145))
}

fn should_fallback_to_dir_sync(err: &std::io::Error) -> bool {
    is_transient_win_fs_error(err)
        || matches!(err.kind(), std::io::ErrorKind::CrossesDevices)
        || matches!(err.raw_os_error(), Some(17))
}

const RENAME_BACKOFF_MS: &[u64] = &[50, 100];
const IO_BACKOFF_MS: &[u64] = &[100, 150, 250, 400, 600, 800, 1000, 1200];

fn retry_transient_fs<T, F>(delays: &[u64], mut op: F) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    let mut attempt = 0usize;
    loop {
        match op() {
            Ok(val) => return Ok(val),
            Err(err) if attempt < delays.len() && is_transient_win_fs_error(&err) => {
                std::thread::sleep(std::time::Duration::from_millis(delays[attempt]));
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

fn clear_readonly_attr(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

pub(super) fn remove_dir_with_retry(dir: &Path) -> Result<(), String> {
    retry_transient_fs(IO_BACKOFF_MS, || match fs::symlink_metadata(dir) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
        Ok(_) => fs::remove_dir_all(dir),
    })
    .map_err(|e| format!("清理目录失败 {}：{e}", dir.display()))
}

fn remove_file_with_retry(file: &Path) -> Result<(), String> {
    retry_transient_fs(IO_BACKOFF_MS, || {
        clear_readonly_attr(file);
        match fs::remove_file(file) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            res => res,
        }
    })
    .map_err(|e| format!("清理旧文件失败 {}：{e}", file.display()))
}

fn copy_file_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目标子目录失败 {}：{e}", parent.display()))?;
    }
    retry_transient_fs(IO_BACKOFF_MS, || {
        clear_readonly_attr(dst);
        fs::copy(src, dst).map(|_| ())
    })
    .map_err(|e| format!("写入增强插件文件失败 {}：{e}", dst.display()))
}

fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("创建目标目录失败 {}：{e}", dst.display()))?;
    let entries = fs::read_dir(src)
        .map_err(|e| format!("读取临时目录失败 {}：{e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("遍历临时目录失败 {}：{e}", src.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败 {}：{e}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let src_child = entry.path();
        let dst_child = dst.join(entry.file_name());
        if file_type.is_dir() {
            if dst_child.is_file() {
                remove_file_with_retry(&dst_child)?;
            }
            copy_dir_contents(&src_child, &dst_child)?;
        } else {
            if dst_child.is_dir() {
                remove_dir_with_retry(&dst_child)?;
            }
            copy_file_with_retry(&src_child, &dst_child)?;
        }
    }
    Ok(())
}

fn prune_stale_entries(staging: &Path, target: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(target) {
        Ok(rd) => rd,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("读取目标目录失败 {}：{err}", target.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("遍历目标目录失败 {}：{e}", target.display()))?;
        let name = entry.file_name();
        let staging_child = staging.join(&name);
        let target_child = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取目标项类型失败 {}：{e}", target_child.display()))?;
        if !staging_child.exists() {
            if file_type.is_dir() {
                remove_dir_with_retry(&target_child)?;
            } else {
                remove_file_with_retry(&target_child)?;
            }
        } else if file_type.is_dir() && staging_child.is_dir() {
            prune_stale_entries(&staging_child, &target_child)?;
        }
    }
    Ok(())
}

// Windows 上运行中的 Antigravity（language_server）或杀软实时监控插件目录时，
// MoveFileExW 整目录重命名会持续返回 os error 5；退化为目录树文件级同步可绕开整目录句柄锁定。
fn sync_dir_from_staging(staging: &Path, target: &Path) -> Result<(), String> {
    let existed_before = target.exists();
    if let Err(err) = copy_dir_contents(staging, target) {
        if !existed_before {
            let _ = remove_dir_with_retry(target);
        }
        return Err(err);
    }
    if existed_before {
        prune_stale_entries(staging, target)?;
    }
    let _ = remove_dir_with_retry(staging);
    Ok(())
}

pub(super) fn replace_dir_atomically(id: &str, staging: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建增强插件目录失败 {}：{e}", parent.display()))?;
    }
    let backup = target.with_file_name(format!("{id}-bak-{}", std::process::id()));
    if backup.exists() {
        let _ = remove_dir_with_retry(&backup);
    }
    let moved_old = if target.exists() {
        match retry_transient_fs(RENAME_BACKOFF_MS, || fs::rename(target, &backup)) {
            Ok(()) => true,
            Err(err) if should_fallback_to_dir_sync(&err) => {
                return sync_dir_from_staging(staging, target);
            }
            Err(err) => return Err(format!("准备更新安装器目录失败：{err}")),
        }
    } else {
        false
    };
    match retry_transient_fs(RENAME_BACKOFF_MS, || fs::rename(staging, target)) {
        Ok(()) => {
            if moved_old {
                let _ = remove_dir_with_retry(&backup);
            }
            Ok(())
        }
        Err(e) if should_fallback_to_dir_sync(&e) => {
            let sync_res = sync_dir_from_staging(staging, target);
            if sync_res.is_ok() {
                if moved_old {
                    let _ = remove_dir_with_retry(&backup);
                }
                Ok(())
            } else {
                if moved_old && fs::rename(&backup, target).is_err() {
                    let _ = sync_dir_from_staging(&backup, target);
                }
                sync_res
            }
        }
        Err(e) => {
            if moved_old {
                let _ = retry_transient_fs(RENAME_BACKOFF_MS, || fs::rename(&backup, target));
            }
            Err(format!("写入增强插件安装器失败：{e}"))
        }
    }
}

async fn ensure_context_viewer_installer(
    force_download: bool,
) -> Result<(PathBuf, Option<String>), String> {
    let dir = enhance_installer_dir(CONTEXT_VIEWER_ID);
    if !force_download && dir.join("cli.js").is_file() {
        return Ok((dir, None));
    }

    let tag = latest_release_tag(CONTEXT_VIEWER_REPO).await?;
    let clean_tag = tag.trim().to_string();
    if clean_tag.is_empty() {
        return Err("未能获取上下文看板的最新版本号".to_string());
    }
    let archive_url = format!(
        "https://github.com/{}/archive/refs/tags/{}.zip",
        CONTEXT_VIEWER_REPO, clean_tag
    );
    let filename = format!("anybridge_{}_{}.zip", CONTEXT_VIEWER_ID, clean_tag);
    let noop_progress = |_: &str, _: u8| {};
    let archive_path =
        download_asset_with(&archive_url, &filename, &noop_progress, 10, 90).await?;

    let parent = dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let staging = parent.join(format!(
        ".{}-staging-{}",
        CONTEXT_VIEWER_ID,
        std::process::id()
    ));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }

    let extract_res = (|| -> Result<(), String> {
        fs::create_dir_all(&staging)
            .map_err(|e| format!("创建临时解压目录失败 {}：{e}", staging.display()))?;
        extract_zip_filtered(&archive_path, &staging, 1, should_keep_archive_entry)?;
        if !staging.join("cli.js").is_file() || !staging.join("package.json").is_file() {
            return Err("下载的源码包结构异常，缺少 cli.js 或 package.json".to_string());
        }
        replace_dir_atomically(CONTEXT_VIEWER_ID, &staging, &dir)
    })();

    let _ = fs::remove_file(&archive_path);
    if extract_res.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    extract_res?;

    let ver = read_installer_version(&dir).unwrap_or_else(|| normalize_version(&clean_tag));
    set_cached_latest_version(CONTEXT_VIEWER_ID, &ver);
    Ok((dir, Some(ver)))
}

fn run_node(dir: &Path, args: &[&str]) -> Result<(bool, String), String> {
    let mut command = Command::new("node");
    command
        .arg("cli.js")
        .args(args)
        .current_dir(dir)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .hide_window();
    let output = command
        .output()
        .map_err(|e| format!("启动 Node.js 失败：{e}。请确认已安装 Node.js 22+ 并在 PATH 中。"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.trim().is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    Ok((output.status.success(), text))
}

#[tauri::command]
pub async fn get_antigravity_enhance_status() -> Result<Vec<EnhanceItemStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let viewer = build_context_viewer_status(None, None);
        let mut items = Vec::with_capacity(1 + NATIVE_PLUGIN_SPECS.len() + CDP_THEME_SPECS.len());
        let host_installed = viewer.host_installed;
        let host_version = viewer.host_version.clone();
        items.push(viewer);
        for spec in NATIVE_PLUGIN_SPECS {
            items.push(build_native_plugin_status(
                spec,
                host_installed,
                host_version.clone(),
            ));
        }
        for spec in CDP_THEME_SPECS {
            items.push(build_cdp_theme_status(
                spec,
                host_installed,
                host_version.clone(),
            ));
        }
        apply_conflict_matrix(&mut items);
        items
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_antigravity_enhance_update(id: String) -> Result<EnhanceUpdateInfo, String> {
    let repo = if id == CONTEXT_VIEWER_ID {
        CONTEXT_VIEWER_REPO
    } else if let Some(spec) = find_native_plugin_spec(&id) {
        spec.repo
    } else if let Some(spec) = find_cdp_theme_spec(&id) {
        spec.repo
    } else {
        return Err(format!("暂不支持该增强项：{id}"));
    };

    let tag = latest_release_tag(repo).await?;
    let latest = normalize_version(&tag);
    if latest.is_empty() {
        return Err("上游版本号为空".to_string());
    }
    set_cached_latest_version(&id, &latest);

    let id_clone = id.clone();
    let (current_version, installer_version) = tauri::async_runtime::spawn_blocking(move || {
        let status = if id_clone == CONTEXT_VIEWER_ID {
            build_context_viewer_status(None, None)
        } else if let Some(spec) = find_native_plugin_spec(&id_clone) {
            build_native_plugin_status(spec, hub_asar_path().is_some(), None)
        } else {
            let spec = find_cdp_theme_spec(&id_clone).unwrap();
            build_cdp_theme_status(spec, hub_asar_path().is_some(), None)
        };
        let cur = if status.installed {
            status.version.clone()
        } else {
            None
        };
        (cur, status.installer_version)
    })
    .await
    .map_err(|e| e.to_string())?;

    let baseline = current_version.as_deref().or(installer_version.as_deref());
    let has_update = baseline
        .and_then(|cur| is_newer_version(&latest, cur))
        .unwrap_or(false);

    Ok(EnhanceUpdateInfo {
        id,
        current_version,
        installer_version,
        latest_version: latest,
        has_update,
    })
}

/// 在外部增强插件安装或卸载重写 `app.asar` 后，对称补回原本存在的 BYOK 端点与汉化补丁，
/// 防止第三方安装/还原链路静默抹掉既有接入或中文补丁。
fn restore_hub_patches_if_lost(
    asar: &Path,
    byok_present: bool,
    hans_present: bool,
) -> Result<(), String> {
    if byok_present && !hub_has_byok_patch(asar) {
        patch_antigravity_hub_asar(asar)?;
    }
    if hans_present && !is_hub_localized(asar) {
        patch_hub_asar(asar)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn install_antigravity_enhance(
    id: String,
    force_update: Option<bool>,
) -> Result<String, String> {
    if let Some(spec) = find_native_plugin_spec(&id) {
        return install_native_plugin(spec, force_update.unwrap_or(false)).await;
    }
    if let Some(spec) = find_cdp_theme_spec(&id) {
        return install_cdp_theme(spec, force_update.unwrap_or(false)).await;
    }
    if id != CONTEXT_VIEWER_ID {
        return Err(format!("暂不支持该增强项：{id}"));
    }

    let local_dir = enhance_installer_dir(CONTEXT_VIEWER_ID);
    let has_cli = local_dir.join("cli.js").is_file();
    let local_ver = read_installer_version(&local_dir);
    let cached_newer = match (
        cached_latest_version(CONTEXT_VIEWER_ID),
        local_ver.as_deref(),
    ) {
        (Some(latest), Some(cur)) => is_newer_version(&latest, cur) == Some(true),
        _ => false,
    };
    let need_download = force_update.unwrap_or(false) || !has_cli || cached_newer;
    let (dir, downloaded_ver) = ensure_context_viewer_installer(need_download).await?;

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::inject_lock();
        let asar = hub_asar_path()
            .ok_or_else(|| "未检测到 Antigravity 桌面端安装目录，请先安装客户端。".to_string())?;
        let byok_present = hub_has_byok_patch(&asar);
        let hans_present = is_hub_localized(&asar);
        let asar_arg = asar.to_string_lossy().to_string();

        let (ok, text) = run_node(&dir, &["install", "--path", &asar_arg])?;
        if !ok {
            return Err(if text.trim().is_empty() {
                "安装执行失败，且没有输出。若 Antigravity 正在运行，请先完全退出后重试。".to_string()
            } else {
                text
            });
        }

        restore_hub_patches_if_lost(&asar, byok_present, hans_present)?;
        invalidate_status_cache();

        if let Some(ver) = downloaded_ver {
            Ok(format!("已拉取上下文看板 v{ver}\n{}", text.trim()))
        } else {
            Ok(text)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn uninstall_antigravity_enhance(id: String) -> Result<String, String> {
    if let Some(spec) = find_native_plugin_spec(&id) {
        return uninstall_native_plugin(spec).await;
    }
    if let Some(spec) = find_cdp_theme_spec(&id) {
        return uninstall_cdp_theme(spec).await;
    }
    if id != CONTEXT_VIEWER_ID {
        return Err(format!("暂不支持该增强项：{id}"));
    }

    let (dir, _) = ensure_context_viewer_installer(false).await?;

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::inject_lock();
        let asar = hub_asar_path()
            .ok_or_else(|| "未检测到 Antigravity 桌面端安装目录，请先安装客户端。".to_string())?;
        let byok_present = hub_has_byok_patch(&asar);
        let hans_present = is_hub_localized(&asar);
        let asar_arg = asar.to_string_lossy().to_string();

        let (ok, text) = run_node(&dir, &["restore", "--path", &asar_arg])?;
        if !ok {
            return Err(if text.trim().is_empty() {
                "卸载执行失败，且没有输出。若 Antigravity 正在运行，请先完全退出后重试。".to_string()
            } else {
                text
            });
        }

        restore_hub_patches_if_lost(&asar, byok_present, hans_present)?;
        invalidate_status_cache();
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_enhance_github_detail(
    repo: String,
    force_refresh: Option<bool>,
) -> Result<EnhanceGithubDetail, String> {
    fetch_enhance_github_detail(repo, force_refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn get_enhance_github_image(url: String) -> Result<String, String> {
    fetch_enhance_github_image(url).await
}
