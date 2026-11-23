//! 增强插件（Antigravity Hub 第三方增强项）管理命令。
//!
//! 当前内置管理：`antigravity-context-viewer`。
//! 状态探测直接轻量读取 `app.asar` header 与指定文件片段（毫秒级，不阻塞启动 Node）；
//! 安装器优先使用 `ANYBRIDGE_CONTEXT_VIEWER_DIR`，否则托管在数据目录
//! `AnyBridge/enhance/antigravity-context-viewer`，缺失或更新时复用扩展下载链路从 GitHub 拉取。

use serde::Serialize;
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

const CONTEXT_VIEWER_ID: &str = "antigravity-context-viewer";
const CONTEXT_VIEWER_REPO: &str = "elviscjn-cjn/antigravity-context-viewer";

static LATEST_VERSION_CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn cached_latest_version() -> Option<String> {
    LATEST_VERSION_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn set_cached_latest_version(ver: &str) {
    let norm = normalize_version(ver);
    if norm.is_empty() {
        return;
    }
    let mut slot = LATEST_VERSION_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *slot = Some(norm);
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

fn enhance_installer_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("ANYBRIDGE_CONTEXT_VIEWER_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AnyBridge")
        .join("enhance")
        .join(CONTEXT_VIEWER_ID)
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
        .unwrap_or_else(enhance_installer_dir);
    let installer_version = read_installer_version(&installer_dir);
    let latest_version = cached_latest_version();

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
        detail,
    }
}

fn should_keep_archive_entry(rel: &Path) -> bool {
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

fn replace_dir_atomically(staging: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建增强插件目录失败 {}：{e}", parent.display()))?;
    }
    let backup = target.with_file_name(format!("{}-bak-{}", CONTEXT_VIEWER_ID, std::process::id()));
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    let moved_old = if target.exists() {
        fs::rename(target, &backup).map_err(|e| format!("准备更新安装器目录失败：{e}"))?;
        true
    } else {
        false
    };
    match fs::rename(staging, target) {
        Ok(()) => {
            if moved_old {
                let _ = fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(e) => {
            if moved_old {
                let _ = fs::rename(&backup, target);
            }
            Err(format!("写入增强插件安装器失败：{e}"))
        }
    }
}

async fn ensure_context_viewer_installer(
    force_download: bool,
) -> Result<(PathBuf, Option<String>), String> {
    let dir = enhance_installer_dir();
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
        replace_dir_atomically(&staging, &dir)
    })();

    let _ = fs::remove_file(&archive_path);
    if extract_res.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    extract_res?;

    let ver = read_installer_version(&dir).unwrap_or_else(|| normalize_version(&clean_tag));
    set_cached_latest_version(&ver);
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
    tauri::async_runtime::spawn_blocking(|| vec![build_context_viewer_status(None, None)])
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_antigravity_enhance_update(id: String) -> Result<EnhanceUpdateInfo, String> {
    if id != CONTEXT_VIEWER_ID {
        return Err(format!("暂不支持该增强项：{id}"));
    }
    let tag = latest_release_tag(CONTEXT_VIEWER_REPO).await?;
    let latest = normalize_version(&tag);
    if latest.is_empty() {
        return Err("上游版本号为空".to_string());
    }
    set_cached_latest_version(&latest);

    let (current_version, installer_version) = tauri::async_runtime::spawn_blocking(|| {
        let status = build_context_viewer_status(None, None);
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
    if id != CONTEXT_VIEWER_ID {
        return Err(format!("暂不支持该增强项：{id}"));
    }

    let local_dir = enhance_installer_dir();
    let has_cli = local_dir.join("cli.js").is_file();
    let local_ver = read_installer_version(&local_dir);
    let cached_newer = match (cached_latest_version(), local_ver.as_deref()) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::antigravity_localization::asar_padding_len;

    fn build_test_asar(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut payload = Vec::new();
        let mut root_files = serde_json::Map::new();
        let mut dist_files = serde_json::Map::new();

        for (rel, body) in entries {
            let offset = payload.len();
            payload.extend_from_slice(body.as_bytes());
            let node = serde_json::json!({
                "size": body.len(),
                "offset": offset.to_string(),
                "integrity": {
                    "algorithm": "SHA256",
                    "hash": "test",
                    "blockSize": 4194304,
                    "blocks": ["test"]
                }
            });
            if let Some(sub) = rel.strip_prefix("dist/") {
                dist_files.insert(sub.to_string(), node);
            } else {
                root_files.insert((*rel).to_string(), node);
            }
        }
        if !dist_files.is_empty() {
            root_files.insert(
                "dist".to_string(),
                serde_json::json!({ "files": serde_json::Value::Object(dist_files) }),
            );
        }

        let header = serde_json::json!({ "files": serde_json::Value::Object(root_files) });
        let header_json = serde_json::to_string(&header).unwrap();
        let padding = asar_padding_len(header_json.len());
        let mut out = Vec::new();
        out.extend_from_slice(&4u32.to_le_bytes());
        out.extend_from_slice(&((header_json.len() + 8 + padding) as u32).to_le_bytes());
        out.extend_from_slice(&((header_json.len() + 4 + padding) as u32).to_le_bytes());
        out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
        out.extend_from_slice(header_json.as_bytes());
        out.extend(std::iter::repeat(0u8).take(padding));
        out.extend_from_slice(&payload);
        out
    }

    #[test]
    fn inspect_hub_asar_detects_clean_and_patched_states() {
        let dir = std::env::temp_dir().join("anybridge-test-enhance-probe");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let asar = dir.join("app.asar");

        let clean = build_test_asar(&[
            ("package.json", r#"{"version":"2.34.0"}"#),
            ("dist/utils.js", "function createWindow() {}"),
        ]);
        fs::write(&asar, &clean).unwrap();
        let probe_clean = inspect_hub_asar_context_viewer(&asar).unwrap();
        assert!(!probe_clean.installed);
        assert_eq!(probe_clean.disk_version, None);
        assert_eq!(probe_clean.host_version.as_deref(), Some("2.34.0"));

        let patched = build_test_asar(&[
            ("package.json", r#"{"version":"2.34.0"}"#),
            ("dist/utils.js", "installContextMeter(win);"),
            ("dist/meter-manifest.json", r#"{"version":"0.8.10"}"#),
        ]);
        fs::write(&asar, &patched).unwrap();
        let probe_patched = inspect_hub_asar_context_viewer(&asar).unwrap();
        assert!(probe_patched.installed);
        assert_eq!(probe_patched.disk_version.as_deref(), Some("0.8.10"));
        assert_eq!(probe_patched.host_version.as_deref(), Some("2.34.0"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_stays_compatible_even_without_local_installer() {
        let dir = std::env::temp_dir().join("anybridge-test-enhance-status");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let asar = dir.join("app.asar");
        let missing_installer = dir.join("missing-installer");

        let clean = build_test_asar(&[
            ("package.json", r#"{"version":"2.34.0"}"#),
            ("dist/utils.js", "function createWindow() {}"),
        ]);
        fs::write(&asar, &clean).unwrap();

        let status = build_context_viewer_status(Some(&asar), Some(&missing_installer));
        assert_eq!(status.name, "antigravity-context-viewer");
        assert!(status.host_installed);
        assert!(status.compatible, "仅缺本地安装器时应保持可安装，不得误标为不兼容");
        assert!(!status.installed);
        assert_eq!(status.host_version.as_deref(), Some("2.34.0"));
        assert_eq!(status.installer_version, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_filter_skips_demo_media_and_keeps_runtime_files() {
        assert!(!should_keep_archive_entry(Path::new("assets/demo.mp4")));
        assert!(!should_keep_archive_entry(Path::new("docs/preview.gif")));
        assert!(!should_keep_archive_entry(Path::new(".github/workflows/ci.yml")));
        assert!(should_keep_archive_entry(Path::new("cli.js")));
        assert!(should_keep_archive_entry(Path::new("src/main.js")));
    }

    #[test]
    fn restore_hub_patches_reapplies_lost_localization_when_previously_localized() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "anybridge-test-enhance-loc-sym-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let asar = dir.join("app.asar");

        let clean = build_test_asar(&[
            ("package.json", r#"{"version":"2.34.0"}"#),
            ("dist/preload.js", "console.log('preload base');"),
            ("dist/utils.js", "function createWindow() {}"),
        ]);
        fs::write(&asar, &clean).unwrap();

        // 1. 原客户端已汉化，生成 app.asar.lang.bak
        patch_hub_asar(&asar).expect("初始汉化应成功");
        assert!(is_hub_localized(&asar));

        // 2. 模拟安装/更新增强插件重写 app.asar 后汉化标记丢失
        fs::write(&asar, &clean).unwrap();
        assert!(!is_hub_localized(&asar));

        // 3. 对称补回丢失的汉化补丁
        restore_hub_patches_if_lost(&asar, false, true).expect("应自动补回汉化补丁");
        assert!(is_hub_localized(&asar), "安装或重装增强插件后必须保留已有汉化");

        // 4. 原本未汉化时不得误打补丁
        fs::write(&asar, &clean).unwrap();
        restore_hub_patches_if_lost(&asar, false, false).expect("未汉化时应保持原状");
        assert!(!is_hub_localized(&asar));

        let _ = fs::remove_dir_all(&dir);
    }
}
