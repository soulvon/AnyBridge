//! 白色 Antigravity 2.0 原生插件管理（`~/.gemini/config/plugins/<name>`）。
//!
//! 当前内置管理：
//! - `antigravity-usage-monitor`（`yuhuan-dev/antigravity-usage-monitor`）
//!
//! 原生插件不修改客户端安装包（`app.asar`），解压至 `~/.gemini/config/plugins/<plugin_dir_name>`
//! 并在 `~/.gemini/config/config.json` 的 `plugins` 字段注册启用；卸载时对称移除目录与启用项，
//! 保留 `~/.gemini/antigravity/sidecar_data/<plugin_dir_name>/` 中的历史数据。

use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::extensions::{
    download_asset_with, is_newer_version, latest_release_tag, normalize_version,
};
use crate::commands::plugin_asset::extract_zip_filtered;

use super::cdp_themes::ensure_node_version_at_least;
use super::{
    cached_latest_version, replace_dir_atomically, set_cached_latest_version, EnhanceItemStatus,
};

pub const USAGE_MONITOR_ID: &str = "antigravity-usage-monitor";

#[derive(Debug, Clone, Copy)]
pub(crate) struct NativePluginSpec {
    pub id: &'static str,
    pub plugin_dir_name: &'static str,
    pub repo: &'static str,
    pub release_asset: &'static str,
    pub description: &'static str,
    pub min_node: (u32, u32, u32),
    pub uses_hub_cdp: bool,
}

pub(crate) const NATIVE_PLUGIN_SPECS: &[NativePluginSpec] = &[NativePluginSpec {
    id: USAGE_MONITOR_ID,
    plugin_dir_name: "usage-monitor",
    repo: "yuhuan-dev/antigravity-usage-monitor",
    release_asset: "usage-monitor.zip",
    description: "Antigravity 原生用量与速率监控插件，零改包提供顶栏/侧边栏实时速率、TTFT、10 类上下文构成、配额池监控与历史报表。",
    min_node: (22, 0, 0),
    uses_hub_cdp: true,
}];

pub(crate) fn find_native_plugin_spec(id: &str) -> Option<&'static NativePluginSpec> {
    NATIVE_PLUGIN_SPECS.iter().find(|s| s.id == id)
}

pub(crate) fn default_gemini_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".gemini").join("config"))
}

pub(crate) fn plugin_dir_under(config_dir: &Path, spec: &NativePluginSpec) -> PathBuf {
    config_dir.join("plugins").join(spec.plugin_dir_name)
}

pub(crate) fn plugin_config_file_under(config_dir: &Path) -> PathBuf {
    config_dir.join("config.json")
}

/// 保留原生插件所需的 `assets/logo.svg`，仅过滤 CI 元数据与无关视频文件。
pub(crate) fn should_keep_native_plugin_entry(rel: &Path) -> bool {
    let first = rel
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .unwrap_or("");
    if matches!(
        first.to_ascii_lowercase().as_str(),
        ".github" | "__pycache__" | ".git"
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

pub(crate) fn validate_native_plugin_tree(dir: &Path) -> Result<(), String> {
    if !dir.join("plugin.json").is_file() || !dir.join("mcp_config.json").is_file() {
        return Err("下载的插件包结构异常，缺少 plugin.json 或 mcp_config.json".to_string());
    }
    if !dir.join("sidecars").join("panel").join("app.js").is_file() {
        return Err("下载的插件包结构异常，缺少 sidecars/panel/app.js".to_string());
    }
    Ok(())
}

pub(crate) fn read_native_plugin_version(dir: &Path) -> Option<String> {
    if validate_native_plugin_tree(dir).is_err() {
        return None;
    }
    let raw = fs::read_to_string(dir.join("plugin.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(normalize_version)
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativePluginEnableState {
    Enabled,
    Disabled,
    NotRegistered,
}

/// 检查 `~/.gemini/config/config.json` 中该插件的注册与启用状态。
pub(crate) fn read_plugin_enable_state(
    config_file: &Path,
    plugin_name: &str,
) -> NativePluginEnableState {
    let Ok(raw) = fs::read_to_string(config_file) else {
        return NativePluginEnableState::NotRegistered;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
    else {
        return NativePluginEnableState::NotRegistered;
    };
    let Some(entry) = json.get("plugins").and_then(|p| p.get(plugin_name)) else {
        return NativePluginEnableState::NotRegistered;
    };
    match entry.get("enabled").and_then(|v| v.as_bool()) {
        Some(false) => NativePluginEnableState::Disabled,
        _ => NativePluginEnableState::Enabled,
    }
}

/// 完整生效链判据：插件文件树完整 **且** 在 `config.json` 中处于已注册未禁用状态。
pub(crate) fn is_native_plugin_installed_at(
    spec: &NativePluginSpec,
    config_dir: &Path,
) -> (bool, Option<String>, NativePluginEnableState) {
    let dir = plugin_dir_under(config_dir, spec);
    let version = read_native_plugin_version(&dir);
    if version.is_none() {
        return (false, None, NativePluginEnableState::NotRegistered);
    }
    let enable_state =
        read_plugin_enable_state(&plugin_config_file_under(config_dir), spec.plugin_dir_name);
    let installed = enable_state == NativePluginEnableState::Enabled;
    (installed, version, enable_state)
}

pub(crate) fn has_active_native_cdp_plugin() -> bool {
    let Some(cfg_dir) = default_gemini_config_dir() else {
        return false;
    };
    NATIVE_PLUGIN_SPECS
        .iter()
        .filter(|s| s.uses_hub_cdp)
        .any(|s| is_native_plugin_installed_at(s, &cfg_dir).0)
}

/// 原子更新 `~/.gemini/config/config.json` 中的 `plugins[plugin_name]`（原位保留全部其他配置）。
/// 若现有 `config.json` 损坏无法解析，显式拒绝覆盖，避免丢失用户设置。
pub(crate) fn set_plugin_registration_in_config(
    config_file: &Path,
    plugin_name: &str,
    enable: bool,
) -> Result<(), String> {
    let mut root: serde_json::Value = if config_file.is_file() {
        let raw = fs::read_to_string(config_file)
            .map_err(|e| format!("读取 {} 失败：{e}", config_file.display()))?;
        let trimmed = raw.trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(trimmed).map_err(|e| {
                format!(
                    "{} 不是合法 JSON，为避免覆盖现有配置已中止写入：{e}",
                    config_file.display()
                )
            })?
        }
    } else if !enable {
        return Ok(());
    } else {
        serde_json::json!({})
    };

    let root_obj = root.as_object_mut().ok_or_else(|| {
        format!(
            "{} 根节点不是 JSON 对象，已中止写入。",
            config_file.display()
        )
    })?;

    if enable {
        let plugins_val = root_obj
            .entry("plugins")
            .or_insert_with(|| serde_json::json!({}));
        let plugins_obj = plugins_val.as_object_mut().ok_or_else(|| {
            format!(
                "{} 中 plugins 字段不是 JSON 对象，已中止写入。",
                config_file.display()
            )
        })?;
        let entry = plugins_obj
            .entry(plugin_name.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(entry_obj) = entry.as_object_mut() {
            entry_obj.insert("enabled".to_string(), serde_json::Value::Bool(true));
        } else {
            *entry = serde_json::json!({ "enabled": true });
        }
    } else if let Some(plugins_obj) = root_obj.get_mut("plugins").and_then(|v| v.as_object_mut()) {
        plugins_obj.remove(plugin_name);
    }

    if let Some(parent) = config_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败 {}：{e}", parent.display()))?;
    }
    let formatted = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("序列化 Antigravity 插件配置失败：{e}"))?;
    let tmp = config_file.with_file_name(format!(
        ".config.json.tmp-{}",
        std::process::id()
    ));
    fs::write(&tmp, format!("{formatted}\n"))
        .map_err(|e| format!("写入临时配置失败：{e}"))?;
    if let Err(e) = fs::rename(&tmp, config_file) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换配置文件失败 {}：{e}", config_file.display()));
    }
    Ok(())
}

pub(crate) fn build_native_plugin_status_with_root(
    spec: &NativePluginSpec,
    host_installed: bool,
    host_version: Option<String>,
    config_dir_override: Option<&Path>,
) -> EnhanceItemStatus {
    let config_dir = config_dir_override
        .map(PathBuf::from)
        .or_else(default_gemini_config_dir);
    let (installed, disk_version, enable_state) = config_dir
        .as_deref()
        .map(|d| is_native_plugin_installed_at(spec, d))
        .unwrap_or((false, None, NativePluginEnableState::NotRegistered));

    let latest_version = cached_latest_version(spec.id);
    let has_update = match (latest_version.as_deref(), disk_version.as_deref()) {
        (Some(latest), Some(cur)) => is_newer_version(latest, cur).unwrap_or(false),
        _ => false,
    };

    let detail = if !host_installed {
        "未检测到 Antigravity 桌面端安装目录。".to_string()
    } else if !installed && disk_version.is_some() {
        match enable_state {
            NativePluginEnableState::Disabled => {
                "检测到插件目录已存在但在 Antigravity 中已禁用，点击一键安装可重新启用。".to_string()
            }
            NativePluginEnableState::NotRegistered => {
                "检测到插件目录已存在但尚未在 Antigravity 注册启用，点击一键安装可自动启用。".to_string()
            }
            NativePluginEnableState::Enabled => String::new(),
        }
    } else {
        String::new()
    };

    EnhanceItemStatus {
        id: spec.id.to_string(),
        name: spec.id.to_string(),
        description: spec.description.to_string(),
        repo: spec.repo.to_string(),
        installed,
        version: disk_version.clone(),
        installer_version: disk_version,
        latest_version,
        has_update,
        host_installed,
        host_version,
        compatible: host_installed,
        conflicts_with: Vec::new(),
        conflicts: Vec::new(),
        detail,
    }
}

pub(crate) fn build_native_plugin_status(
    spec: &NativePluginSpec,
    host_installed: bool,
    host_version: Option<String>,
) -> EnhanceItemStatus {
    build_native_plugin_status_with_root(spec, host_installed, host_version, None)
}

async fn download_native_plugin_archive(
    spec: &NativePluginSpec,
    tag: &str,
) -> Result<PathBuf, String> {
    let noop_progress = |_: &str, _: u8| {};
    let asset_url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        spec.repo, tag, spec.release_asset
    );
    let asset_name = format!("anybridge_{}_{}.zip", spec.id, tag);
    if let Ok(path) = download_asset_with(&asset_url, &asset_name, &noop_progress, 10, 85).await {
        return Ok(path);
    }
    let fallback_url = format!(
        "https://github.com/{}/archive/refs/tags/{}.zip",
        spec.repo, tag
    );
    let fallback_name = format!("anybridge_{}_{}_src.zip", spec.id, tag);
    download_asset_with(&fallback_url, &fallback_name, &noop_progress, 10, 85).await
}

pub(crate) async fn install_native_plugin(
    spec: &'static NativePluginSpec,
    force_update: bool,
) -> Result<String, String> {
    ensure_node_version_at_least(spec.min_node)?;

    let cfg_dir = default_gemini_config_dir()
        .ok_or_else(|| "无法定位用户主目录，无法安装 Antigravity 原生插件。".to_string())?;
    let target_dir = plugin_dir_under(&cfg_dir, spec);
    let current_ver = read_native_plugin_version(&target_dir);
    let cached_newer = match (cached_latest_version(spec.id), current_ver.as_deref()) {
        (Some(latest), Some(cur)) => is_newer_version(&latest, cur) == Some(true),
        _ => false,
    };
    let need_download = force_update || current_ver.is_none() || cached_newer;

    let downloaded = if need_download {
        let tag = latest_release_tag(spec.repo).await?;
        let clean_tag = tag.trim().to_string();
        if clean_tag.is_empty() {
            return Err(format!("未能获取 {} 的最新版本号", spec.id));
        }
        let archive_path = download_native_plugin_archive(spec, &clean_tag).await?;
        Some((archive_path, clean_tag))
    } else {
        None
    };

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::commands::inject_lock();
        if super::hub_asar_path().is_none() {
            if let Some((ref archive, _)) = downloaded {
                let _ = fs::remove_file(archive);
            }
            return Err("未检测到 Antigravity 桌面端安装目录，请先安装客户端。".to_string());
        }

        let mut logs: Vec<String> = Vec::new();
        if let Some((archive_path, clean_tag)) = downloaded {
            // 暂存目录放在 cfg_dir 下（plugins/ 之外），避免解压中途触发 Antigravity 热监听锁定子目录
            let staging = cfg_dir.join(format!(
                ".{}-staging-{}",
                spec.plugin_dir_name,
                std::process::id()
            ));
            if staging.exists() {
                let _ = super::remove_dir_with_retry(&staging);
            }

            let extract_res = (|| -> Result<(), String> {
                fs::create_dir_all(&staging)
                    .map_err(|e| format!("创建临时解压目录失败 {}：{e}", staging.display()))?;
                extract_zip_filtered(
                    &archive_path,
                    &staging,
                    1,
                    should_keep_native_plugin_entry,
                )?;
                if validate_native_plugin_tree(&staging).is_err() {
                    let _ = super::remove_dir_with_retry(&staging);
                    fs::create_dir_all(&staging)
                        .map_err(|e| format!("重建临时解压目录失败 {}：{e}", staging.display()))?;
                    extract_zip_filtered(
                        &archive_path,
                        &staging,
                        0,
                        should_keep_native_plugin_entry,
                    )?;
                    validate_native_plugin_tree(&staging)?;
                }
                replace_dir_atomically(spec.plugin_dir_name, &staging, &target_dir).map_err(|e| {
                    format!("{e}。若 Antigravity 正在运行并占用插件文件，请先完全关闭客户端后重试。")
                })
            })();

            let _ = fs::remove_file(&archive_path);
            if extract_res.is_err() {
                let _ = fs::remove_dir_all(&staging);
            }
            extract_res?;

            let ver = read_native_plugin_version(&target_dir)
                .unwrap_or_else(|| normalize_version(&clean_tag));
            set_cached_latest_version(spec.id, &ver);
            logs.push(format!(
                "已部署 {} v{} 到 {}",
                spec.id,
                ver,
                target_dir.display()
            ));
        }

        set_plugin_registration_in_config(
            &plugin_config_file_under(&cfg_dir),
            spec.plugin_dir_name,
            true,
        )?;
        logs.push(format!(
            "已在 Antigravity 插件配置中启用 {}（重启客户端后自动生效）。",
            spec.plugin_dir_name
        ));
        Ok(logs.join("\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn uninstall_native_plugin(
    spec: &'static NativePluginSpec,
) -> Result<String, String> {
    let cfg_dir = default_gemini_config_dir()
        .ok_or_else(|| "无法定位用户主目录，无法卸载 Antigravity 原生插件。".to_string())?;
    let target_dir = plugin_dir_under(&cfg_dir, spec);

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::commands::inject_lock();
        if target_dir.exists() {
            super::remove_dir_with_retry(&target_dir).map_err(|e| {
                format!("{e}。若 Antigravity 正在运行并占用插件文件，请先完全关闭客户端后重试。")
            })?;
        }
        set_plugin_registration_in_config(
            &plugin_config_file_under(&cfg_dir),
            spec.plugin_dir_name,
            false,
        )?;
        Ok(format!(
            "已移除 {} 并取消插件启用注册（~/.gemini/antigravity/sidecar_data/{} 历史用量数据已保留）。",
            spec.id, spec.plugin_dir_name
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
