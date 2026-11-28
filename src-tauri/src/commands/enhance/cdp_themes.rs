//! 白色 Antigravity 桌面端 CDP 零改包主题插件管理。
//!
//! 收敛管理：
//! - `antigravity-codex-theme`（`nkjDSLcvanv/antigravity-codex-theme`）
//! - `chuanban-antigravity-theme-patch`（`Anarcadia/chuanban-antigravity-theme-patch`）
//!
//! 两者均走本地 CDP 调试通道实时注入主题与统计，不改 `app.asar`；
//! 两者守护进程互斥，安装任一款前需先卸载已生效的另一款。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::commands::extensions::{
    download_asset_with, is_newer_version, latest_release_tag, normalize_version,
};
use crate::commands::plugin_asset::extract_zip_filtered;
use crate::commands::system::HideWindow;

use super::{
    cached_latest_version, enhance_installer_dir, inspect_hub_asar_context_viewer,
    replace_dir_atomically, set_cached_latest_version, should_keep_archive_entry,
    EnhanceItemStatus,
};

pub const CODEX_THEME_ID: &str = "antigravity-codex-theme";
pub const CHUANBAN_THEME_ID: &str = "chuanban-antigravity-theme-patch";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VersionSource {
    PackageJson,
    CoreManifest,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CdpThemeSpec {
    pub id: &'static str,
    pub repo: &'static str,
    pub description: &'static str,
    pub deploy_dir_name: &'static str,
    pub version_source: VersionSource,
    pub min_node: (u32, u32, u32),
    #[allow(dead_code)]
    pub win_vbs_name: &'static str,
    #[allow(dead_code)]
    pub mac_plists: &'static [&'static str],
    #[allow(dead_code)]
    pub linux_service: &'static str,
    pub supports_without_i18n: bool,
}

pub(crate) const CDP_THEME_SPECS: &[CdpThemeSpec] = &[
    CdpThemeSpec {
        id: CODEX_THEME_ID,
        repo: "nkjDSLcvanv/antigravity-codex-theme",
        description: "不修改安装包，通过本地 CDP 注入 Codex 纯白/炭灰昼夜双主题、原生设置页、中文界面与底部四态会话用量监控。",
        deploy_dir_name: "codex-theme",
        version_source: VersionSource::PackageJson,
        min_node: (22, 13, 0),
        win_vbs_name: "AntigravityCodexThemeDaemon.vbs",
        mac_plists: &["com.antigravity.codex-theme.plist"],
        linux_service: "antigravity-codex-theme.service",
        supports_without_i18n: true,
    },
    CdpThemeSpec {
        id: CHUANBAN_THEME_ID,
        repo: "Anarcadia/chuanban-antigravity-theme-patch",
        description: "不修改安装包，通过本地 CDP 注入莫兰迪与书卷暖纸五段主题、字体排版优化、中英双切与多维 Token 统计面板。",
        deploy_dir_name: "theme-patch",
        version_source: VersionSource::CoreManifest,
        min_node: (22, 0, 0),
        win_vbs_name: "AntigravityThemeDaemon.vbs",
        mac_plists: &[
            "com.antigravity.theme.plist",
            "com.antigravity.customfont.plist",
        ],
        linux_service: "antigravity-theme.service",
        supports_without_i18n: false,
    },
];

pub(crate) fn find_cdp_theme_spec(id: &str) -> Option<&'static CdpThemeSpec> {
    CDP_THEME_SPECS.iter().find(|s| s.id == id)
}

/// 同一宿主下互斥的 CDP 主题插件 ID（收敛委托至 `conflicts` 单一真源）。
pub(crate) fn conflict_peer_ids(id: &str) -> Vec<String> {
    super::conflicts::exclusive_peer_ids(id)
}

pub(crate) fn default_deploy_dir(spec: &CdpThemeSpec) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".gemini").join("antigravity").join(spec.deploy_dir_name))
}

pub(crate) fn parse_node_version_output(raw: &str) -> Option<(u32, u32, u32)> {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    let mut parts = cleaned.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let patch_raw = parts.next().unwrap_or("0");
    let patch_digits: String = patch_raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    let patch = if patch_digits.is_empty() {
        0
    } else {
        patch_digits.parse::<u32>().unwrap_or(0)
    };
    Some((major, minor, patch))
}

pub(crate) fn node_meets_min(ver: (u32, u32, u32), min: (u32, u32, u32)) -> bool {
    ver >= min
}

pub(super) fn ensure_node_version_at_least(min: (u32, u32, u32)) -> Result<(u32, u32, u32), String> {
    let mut cmd = Command::new("node");
    cmd.arg("-v")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .hide_window();
    let out = cmd.output().map_err(|e| {
        format!(
            "未检测到可用 Node.js（{e}）。该插件要求 Node.js >= {}.{}.{}。",
            min.0, min.1, min.2
        )
    })?;
    if !out.status.success() {
        return Err(format!(
            "检查 Node.js 版本失败，请确认已安装 Node.js >= {}.{}.{}。",
            min.0, min.1, min.2
        ));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let ver = parse_node_version_output(&raw).ok_or_else(|| {
        format!(
            "无法解析 Node.js 版本 `{}`，请确认已安装 Node.js >= {}.{}.{}。",
            raw.trim(),
            min.0,
            min.1,
            min.2
        )
    })?;
    if !node_meets_min(ver, min) {
        return Err(format!(
            "当前 Node.js 版本为 v{}.{}.{}，该插件要求 >= {}.{}.{}，请升级 Node.js 后重试。",
            ver.0, ver.1, ver.2, min.0, min.1, min.2
        ));
    }
    Ok(ver)
}

pub(crate) fn read_cdp_theme_version(dir: &Path, source: VersionSource) -> Option<String> {
    if !dir.join("install.mjs").is_file() || !dir.join("core").join("daemon.mjs").is_file() {
        return None;
    }
    let ver_file = match source {
        VersionSource::PackageJson => dir.join("package.json"),
        VersionSource::CoreManifest => dir.join("core").join("manifest.json"),
    };
    let raw = fs::read_to_string(ver_file).ok()?;
    let json: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(normalize_version)
        .filter(|s| !s.is_empty())
}

pub(crate) fn user_config_enabled(deploy_dir: &Path) -> bool {
    let cfg_path = deploy_dir.join("user").join("config.json");
    let Ok(raw) = fs::read_to_string(cfg_path) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
    else {
        return true;
    };
    json.get("enabled").and_then(|v| v.as_bool()) != Some(false)
}

/// 检查对应操作系统的守护进程注册文件是否在位，避免卸载残留目录误判为“已安装”。
pub(crate) fn service_registration_present_with_roots(
    spec: &CdpThemeSpec,
    deploy_dir: &Path,
    home_dir: Option<&Path>,
    roaming_dir: Option<&Path>,
) -> bool {
    #[cfg(target_os = "windows")]
    {
        let _ = home_dir;
        if deploy_dir.join(spec.win_vbs_name).is_file() {
            return true;
        }
        return roaming_dir
            .map(|r| {
                r.join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("Startup")
                    .join(spec.win_vbs_name)
                    .is_file()
            })
            .unwrap_or(false);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (deploy_dir, roaming_dir);
        let Some(home) = home_dir else {
            return false;
        };
        let agents_dir = home.join("Library").join("LaunchAgents");
        return spec
            .mac_plists
            .iter()
            .any(|plist| agents_dir.join(plist).is_file());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (deploy_dir, roaming_dir);
        let Some(home) = home_dir else {
            return false;
        };
        return home
            .join(".config")
            .join("systemd")
            .join("user")
            .join(spec.linux_service)
            .is_file();
    }
}

pub(crate) fn is_cdp_theme_installed_at(
    spec: &CdpThemeSpec,
    deploy_dir: &Path,
    home_dir: Option<&Path>,
    roaming_dir: Option<&Path>,
) -> bool {
    deploy_dir.join("core").join("daemon.mjs").is_file()
        && user_config_enabled(deploy_dir)
        && service_registration_present_with_roots(spec, deploy_dir, home_dir, roaming_dir)
}

fn is_spec_installed_live(spec: &CdpThemeSpec) -> bool {
    let Some(deploy_dir) = default_deploy_dir(spec) else {
        return false;
    };
    let home = dirs::home_dir();
    let roaming = dirs::config_dir();
    is_cdp_theme_installed_at(spec, &deploy_dir, home.as_deref(), roaming.as_deref())
}

/// 供 IDE 重启链路复用：若白色 Antigravity 装了任一 CDP 主题，重启时保留 `--remote-debugging-port=0`。
pub(crate) fn has_active_hub_cdp_theme() -> bool {
    CDP_THEME_SPECS.iter().any(is_spec_installed_live)
}

pub(crate) fn build_cdp_theme_install_args(
    spec: &CdpThemeSpec,
    context_viewer_installed: bool,
) -> Vec<&'static str> {
    if spec.supports_without_i18n && context_viewer_installed {
        vec!["install", "--without", "i18n"]
    } else {
        vec!["install"]
    }
}

pub(crate) fn build_cdp_theme_status_with_roots(
    spec: &CdpThemeSpec,
    host_installed: bool,
    host_version: Option<String>,
    deploy_override: Option<&Path>,
    installer_override: Option<&Path>,
    home_override: Option<&Path>,
    roaming_override: Option<&Path>,
) -> EnhanceItemStatus {
    let installer_dir = installer_override
        .map(PathBuf::from)
        .unwrap_or_else(|| enhance_installer_dir(spec.id));
    let deploy_dir = deploy_override
        .map(PathBuf::from)
        .or_else(|| default_deploy_dir(spec));
    let installer_version = read_cdp_theme_version(&installer_dir, spec.version_source);
    let deploy_version = deploy_dir
        .as_deref()
        .and_then(|d| read_cdp_theme_version(d, spec.version_source));
    let installed = deploy_dir
        .as_deref()
        .map(|d| is_cdp_theme_installed_at(spec, d, home_override, roaming_override))
        .unwrap_or(false);

    let latest_version = cached_latest_version(spec.id);
    let effective_ver = if installed {
        deploy_version.clone().or_else(|| installer_version.clone())
    } else {
        installer_version.clone()
    };
    let compare_base = if installed {
        deploy_version.as_deref().or(installer_version.as_deref())
    } else {
        installer_version.as_deref()
    };
    let has_update = match (latest_version.as_deref(), compare_base) {
        (Some(latest), Some(cur)) => is_newer_version(latest, cur).unwrap_or(false),
        _ => false,
    };

    let detail = if !host_installed {
        "未检测到 Antigravity 桌面端安装目录。".to_string()
    } else {
        String::new()
    };

    EnhanceItemStatus {
        id: spec.id.to_string(),
        name: spec.id.to_string(),
        description: spec.description.to_string(),
        repo: spec.repo.to_string(),
        installed,
        version: effective_ver,
        installer_version,
        latest_version,
        has_update,
        host_installed,
        host_version,
        compatible: host_installed,
        conflicts_with: conflict_peer_ids(spec.id),
        conflicts: Vec::new(),
        detail,
    }
}

pub(crate) fn build_cdp_theme_status(
    spec: &CdpThemeSpec,
    host_installed: bool,
    host_version: Option<String>,
) -> EnhanceItemStatus {
    let home = dirs::home_dir();
    let roaming = dirs::config_dir();
    build_cdp_theme_status_with_roots(
        spec,
        host_installed,
        host_version,
        None,
        None,
        home.as_deref(),
        roaming.as_deref(),
    )
}

fn validate_theme_installer_tree(dir: &Path, spec: &CdpThemeSpec) -> Result<(), String> {
    if !dir.join("install.mjs").is_file() || !dir.join("core").join("daemon.mjs").is_file() {
        return Err("下载的源码包结构异常，缺少 install.mjs 或 core/daemon.mjs".to_string());
    }
    let ver_ok = match spec.version_source {
        VersionSource::PackageJson => dir.join("package.json").is_file(),
        VersionSource::CoreManifest => dir.join("core").join("manifest.json").is_file(),
    };
    if !ver_ok {
        return Err("下载的源码包结构异常，缺少版本清单文件".to_string());
    }
    Ok(())
}

pub(crate) async fn ensure_cdp_theme_installer(
    spec: &CdpThemeSpec,
    force_download: bool,
) -> Result<(PathBuf, Option<String>), String> {
    let dir = enhance_installer_dir(spec.id);
    if !force_download && validate_theme_installer_tree(&dir, spec).is_ok() {
        return Ok((dir, None));
    }

    let tag = latest_release_tag(spec.repo).await?;
    let clean_tag = tag.trim().to_string();
    if clean_tag.is_empty() {
        return Err(format!("未能获取 {} 的最新版本号", spec.id));
    }
    let archive_url = format!(
        "https://github.com/{}/archive/refs/tags/{}.zip",
        spec.repo, clean_tag
    );
    let filename = format!("anybridge_{}_{}.zip", spec.id, clean_tag);
    let noop_progress = |_: &str, _: u8| {};
    let archive_path =
        download_asset_with(&archive_url, &filename, &noop_progress, 10, 90).await?;

    let parent = dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let staging = parent.join(format!(".{}-staging-{}", spec.id, std::process::id()));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }

    let extract_res = (|| -> Result<(), String> {
        fs::create_dir_all(&staging)
            .map_err(|e| format!("创建临时解压目录失败 {}：{e}", staging.display()))?;
        extract_zip_filtered(&archive_path, &staging, 1, should_keep_archive_entry)?;
        validate_theme_installer_tree(&staging, spec)?;
        replace_dir_atomically(spec.id, &staging, &dir)
    })();

    let _ = fs::remove_file(&archive_path);
    if extract_res.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    extract_res?;

    let ver = read_cdp_theme_version(&dir, spec.version_source)
        .unwrap_or_else(|| normalize_version(&clean_tag));
    set_cached_latest_version(spec.id, &ver);
    Ok((dir, Some(ver)))
}

fn run_installer_cli(work_dir: &Path, args: &[&str]) -> Result<(bool, String), String> {
    let mut command = Command::new("node");
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg("install.mjs")
        .args(args)
        .current_dir(work_dir)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .hide_window();
    let output = command.output().map_err(|e| {
        format!("启动 Node.js 失败：{e}。请确认已安装 Node.js >= 22 并在 PATH 中。")
    })?;
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

fn resolve_existing_installer_dir(spec: &CdpThemeSpec) -> Option<PathBuf> {
    if let Some(deploy) = default_deploy_dir(spec) {
        if deploy.join("install.mjs").is_file() {
            return Some(deploy);
        }
    }
    let cached = enhance_installer_dir(spec.id);
    if cached.join("install.mjs").is_file() {
        return Some(cached);
    }
    None
}

fn run_uninstall_without_lock(
    spec: &CdpThemeSpec,
    fallback_dir: Option<&Path>,
) -> Result<String, String> {
    let deploy_dir = default_deploy_dir(spec).ok_or_else(|| "无法定位用户主目录".to_string())?;
    let cli_dir = if deploy_dir.join("install.mjs").is_file() {
        deploy_dir.clone()
    } else if let Some(fb) = fallback_dir {
        fb.to_path_buf()
    } else {
        let cached = enhance_installer_dir(spec.id);
        if cached.join("install.mjs").is_file() {
            cached
        } else {
            return Err(format!("未找到 {} 的卸载脚本 install.mjs", spec.id));
        }
    };
    let target_str = deploy_dir.to_string_lossy().to_string();
    let (ok, text) = run_installer_cli(&cli_dir, &["uninstall", "--target-dir", &target_str])?;
    if !ok {
        return Err(if text.trim().is_empty() {
            format!("卸载 {} 失败，未返回输出。", spec.id)
        } else {
            text
        });
    }
    Ok(text)
}

pub(crate) async fn install_cdp_theme(
    spec: &'static CdpThemeSpec,
    force_update: bool,
) -> Result<String, String> {
    ensure_node_version_at_least(spec.min_node)?;

    let local_dir = enhance_installer_dir(spec.id);
    let has_cli = validate_theme_installer_tree(&local_dir, spec).is_ok();
    let local_ver = read_cdp_theme_version(&local_dir, spec.version_source);
    let cached_newer = match (cached_latest_version(spec.id), local_ver.as_deref()) {
        (Some(latest), Some(cur)) => is_newer_version(&latest, cur) == Some(true),
        _ => false,
    };
    let need_download = force_update || !has_cli || cached_newer;
    let (dir, downloaded_ver) = ensure_cdp_theme_installer(spec, need_download).await?;

    // 在持有 inject_lock 之前预备互斥插件的卸载器（如已安装但意外缺少本地 install.mjs），避免持锁后再做异步下载。
    let mut peer_fallback_dirs: Vec<(CdpThemeSpec, Option<PathBuf>)> = Vec::new();
    for peer_id in conflict_peer_ids(spec.id) {
        if let Some(peer) = find_cdp_theme_spec(&peer_id) {
            if is_spec_installed_live(peer) {
                let fb = if resolve_existing_installer_dir(peer).is_none() {
                    Some(ensure_cdp_theme_installer(peer, false).await?.0)
                } else {
                    None
                };
                peer_fallback_dirs.push((*peer, fb));
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::commands::inject_lock();
        let asar = super::hub_asar_path()
            .ok_or_else(|| "未检测到 Antigravity 桌面端安装目录，请先安装客户端。".to_string())?;
        let viewer_installed = inspect_hub_asar_context_viewer(&asar)
            .map(|p| p.installed)
            .unwrap_or(false);

        let mut logs: Vec<String> = Vec::new();
        for (peer, fb) in peer_fallback_dirs {
            if is_spec_installed_live(&peer) {
                run_uninstall_without_lock(&peer, fb.as_deref())
                    .map_err(|e| format!("无法自动卸载互斥插件 {}：{e}", peer.id))?;
                logs.push(format!("已自动卸载互斥插件：{}", peer.id));
            }
        }

        let install_args = build_cdp_theme_install_args(spec, viewer_installed);
        let skipped_i18n = install_args.contains(&"--without");
        let (ok, text) = run_installer_cli(&dir, &install_args)?;
        if !ok {
            return Err(if text.trim().is_empty() {
                format!("安装 {} 执行失败，且没有输出。", spec.id)
            } else {
                text
            });
        }

        if let Some(ver) = downloaded_ver {
            logs.push(format!("已拉取 {} v{ver}", spec.id));
        }
        if !text.trim().is_empty() {
            logs.push(text.trim().to_string());
        }
        if skipped_i18n {
            logs.push(
                "检测到已安装 antigravity-context-viewer，已跳过重复汉化模块（可在客户端设置页随时开启）。"
                    .to_string(),
            );
        }
        Ok(logs.join("\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn uninstall_cdp_theme(spec: &'static CdpThemeSpec) -> Result<String, String> {
    let fallback_dir = if resolve_existing_installer_dir(spec).is_some() {
        None
    } else {
        Some(ensure_cdp_theme_installer(spec, false).await?.0)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::commands::inject_lock();
        run_uninstall_without_lock(spec, fallback_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
