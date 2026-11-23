use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use super::*;
use super::archive_and_config::*;
use super::cpa_settings_and_scan::*;
use super::github_download::*;

pub(crate) fn normalize_version(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

pub(super) fn numeric_version_parts(version: &str) -> Vec<u32> {
    normalize_version(version)
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

pub(crate) fn is_newer_version(latest: &str, current: &str) -> Option<bool> {
    let latest_parts = numeric_version_parts(latest);
    let current_parts = numeric_version_parts(current);
    if latest_parts.is_empty() || current_parts.is_empty() {
        return None;
    }
    for i in 0..latest_parts.len().max(current_parts.len()) {
        let latest = *latest_parts.get(i).unwrap_or(&0);
        let current = *current_parts.get(i).unwrap_or(&0);
        if latest > current {
            return Some(true);
        }
        if latest < current {
            return Some(false);
        }
    }
    Some(false)
}

/// 构建带可选 GITHUB_TOKEN 的 GitHub 客户端，提升 API 限流阈值。
pub(super) fn build_github_api_client() -> Result<reqwest::Client, String> {
    let mut builder = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(GITHUB_TIMEOUT_SECS))
        .user_agent(format!(
            "AnyBridge-Extension-Updater/{}",
            env!("CARGO_PKG_VERSION")
        ));

    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(auth) = format!("Bearer {}", token).parse() {
            headers.insert(reqwest::header::AUTHORIZATION, auth);
        }
        if let Ok(accept) = "application/vnd.github+json".parse() {
            headers.insert(reqwest::header::ACCEPT, accept);
        }
        builder = builder.default_headers(headers);
    }

    builder.build().map_err(|e| e.to_string())
}

/// 通过 GitHub 网页重定向 URL 获取最新 release 标签，绕过 API 限流。
pub(super) async fn fetch_latest_release_via_web_redirect(repo: &str) -> Result<GithubRelease, String> {
    let client = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(GITHUB_TIMEOUT_SECS))
        .user_agent(format!(
            "AnyBridge-Extension-Updater/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://github.com/{}/releases/latest", repo);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 GitHub 发布页失败 {}：{}", repo, e))?;
    let final_url = response.url().clone();
    let path = final_url.path();
    let tag = path
        .split('/')
        .last()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("无法从 GitHub 重定向 URL 解析 release 标签 {}：{}", repo, path))?;
    Ok(GithubRelease {
        tag_name: tag.to_string(),
        html_url: final_url.to_string(),
        published_at: None,
    })
}

pub(super) async fn fetch_latest_release(repo: &str) -> Result<GithubRelease, String> {
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        match fetch_latest_release_attempt(repo).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                last_err = e;
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(2 * (attempt + 1) as u64)).await;
                }
            }
        }
    }
    Err(last_err)
}

pub(super) async fn fetch_latest_release_attempt(repo: &str) -> Result<GithubRelease, String> {
    let client = build_github_api_client()?;
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 GitHub 最新发布包失败 {}：{}", repo, e))?;
    let status = response.status();
    if status.is_success() {
        return response
            .json::<GithubRelease>()
            .await
            .map_err(|e| format!("无法解析 GitHub 发布包信息 {}：{}", repo, e));
    }

    // 403/429 通常为 API 未认证限流；404 可能是 release 不存在或 API 被限制。使用网页重定向兜底。
    if status == 403 || status == 429 || status == 404 {
        return fetch_latest_release_via_web_redirect(repo).await;
    }

    Err(format!(
        "GitHub 最新发布包请求失败 {}：HTTP {}（未认证 API 请求易被限流，可设置 GITHUB_TOKEN 环境变量提升额度）",
        repo, status
    ))
}

/// 取最新发布版本号：API 优先（带 token 时不受限流），失败再走网页重定向。
/// api.github.com 与 github.com 是两个独立域名，一条路被墙/被证书拦截时另一条通常还能用。
pub(crate) async fn latest_release_tag(repo: &str) -> Result<String, String> {
    match fetch_latest_release(repo).await {
        Ok(release) => Ok(release.tag_name),
        Err(api_err) => match fetch_latest_release_via_web_redirect(repo).await {
            Ok(release) => Ok(release.tag_name),
            Err(web_err) => Err(format!(
                "无法获取 {} 的最新版本号：{}；{}",
                repo,
                api_err.trim_end_matches('。'),
                web_err
            )),
        },
    }
}

#[tauri::command]
pub async fn extension_list_managed_services() -> Result<Vec<ExtensionServiceStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| vec![scan_cpa_suite()])
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn extension_check_cpa_updates() -> Result<CpaUpdateReport, String> {
    let cli_install = find_component_install("cli-proxy-api", parse_cli_version);
    let cpamp_install = find_component_install("cpa-manager-plus", parse_cpamp_version);
    let cli_current = cli_install.as_ref().and_then(|c| c.version.clone());
    let cpamp_current = cpamp_install.as_ref().and_then(|c| c.version.clone());

    let (cli_latest, cpamp_latest) = tokio::try_join!(
        fetch_latest_release("router-for-me/CLIProxyAPI"),
        fetch_latest_release("seakee/CPA-Manager-Plus")
    )?;

    let checked_at = chrono::Utc::now().to_rfc3339();
    let cli_latest_version = normalize_version(&cli_latest.tag_name);
    let cpamp_latest_version = normalize_version(&cpamp_latest.tag_name);

    // 已安装但版本无法识别时视为可更新，避免误报"已是最新版本"
    let cli_update_available = match cli_current.as_deref() {
        Some(current) => is_newer_version(&cli_latest_version, current).unwrap_or(true),
        None => cli_install.is_some(),
    };
    let cpamp_update_available = match cpamp_current.as_deref() {
        Some(current) => is_newer_version(&cpamp_latest_version, current).unwrap_or(true),
        None => cpamp_install.is_some(),
    };

    Ok(CpaUpdateReport {
        id: CPA_SUITE_ID.into(),
        checked_at,
        components: vec![
            ExtensionUpdateComponent {
                id: "cli-proxy-api".into(),
                name: "CLIProxyAPI".into(),
                repository: "router-for-me/CLIProxyAPI".into(),
                current_version: cli_current.clone(),
                latest_version: cli_latest_version.clone(),
                update_available: Some(cli_update_available),
                release_url: cli_latest.html_url,
                published_at: cli_latest.published_at,
            },
            ExtensionUpdateComponent {
                id: "cpa-manager-plus".into(),
                name: "CPA Manager Plus".into(),
                repository: "seakee/CPA-Manager-Plus".into(),
                current_version: cpamp_current.clone(),
                latest_version: cpamp_latest_version.clone(),
                update_available: Some(cpamp_update_available),
                release_url: cpamp_latest.html_url,
                published_at: cpamp_latest.published_at,
            },
        ],
    })
}

// ═══════ 版本列表 / 切换 / 安装指定版本 ═══════

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaVersionEntry {
    pub version: String,
    pub installed: bool,
    pub active: bool,
    pub install_dir: Option<String>,
    pub published_at: Option<String>,
    pub release_url: Option<String>,
    pub prerelease: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaComponentVersionInfo {
    pub id: String,
    pub name: String,
    pub repository: String,
    pub current_version: Option<String>,
    pub versions: Vec<CpaVersionEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaVersionCatalog {
    pub id: String,
    pub components: Vec<CpaComponentVersionInfo>,
    pub checked_at: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct GithubReleaseListItem {
    pub(super) tag_name: String,
    pub(super) html_url: String,
    published_at: Option<String>,
    #[serde(default)]
    pub(super) prerelease: bool,
}

pub(super) fn list_local_component_versions(
    component: &str,
    parser: fn(&Path) -> Option<String>,
) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (root, _) in component_search_roots() {
        if !root.is_dir() {
            continue;
        }
        let predicate: fn(&str) -> bool = match component {
            "cli-proxy-api" => is_cli_proxy_api_dir,
            "cpa-manager-plus" => is_cpamp_dir,
            _ => continue,
        };
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !predicate(&name) {
                continue;
            }
            if let Some(version) = parser(&path) {
                let key = normalize_version(&version);
                if key.is_empty() || !seen.insert(key.clone()) {
                    continue;
                }
                out.push((key, path));
            }
        }
    }
    out.sort_by(|a, b| {
        numeric_version_parts(&b.0)
            .cmp(&numeric_version_parts(&a.0))
            .then_with(|| b.0.cmp(&a.0))
    });
    out
}

pub(super) async fn fetch_github_releases(repo: &str, per_page: u32) -> Result<Vec<GithubReleaseListItem>, String> {
    let client = build_github_api_client()?;
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page={}",
        repo, per_page
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 GitHub releases 列表失败 {}：{}", repo, e))?;
    let status = response.status();
    if status.is_success() {
        return response
            .json::<Vec<GithubReleaseListItem>>()
            .await
            .map_err(|e| format!("无法解析 GitHub releases 列表 {}：{}", repo, e));
    }
    // 限流或失败时退回 latest
    if status == 403 || status == 429 || status == 404 {
        let latest = fetch_latest_release(repo).await?;
        return Ok(vec![GithubReleaseListItem {
            tag_name: latest.tag_name,
            html_url: latest.html_url,
            published_at: latest.published_at,
            prerelease: false,
        }]);
    }
    Err(format!(
        "GitHub releases 列表请求失败 {}：HTTP {}",
        repo, status
    ))
}

pub(super) fn merge_component_versions(
    id: &str,
    name: &str,
    repository: &str,
    current: Option<String>,
    local: Vec<(String, PathBuf)>,
    remote: Vec<GithubReleaseListItem>,
) -> CpaComponentVersionInfo {
    let active = current.as_ref().map(|v| normalize_version(v));
    let mut by_version: std::collections::BTreeMap<String, CpaVersionEntry> =
        std::collections::BTreeMap::new();

    for (version, dir) in local {
        let key = normalize_version(&version);
        by_version.insert(
            key.clone(),
            CpaVersionEntry {
                version: key.clone(),
                installed: true,
                active: active.as_ref() == Some(&key),
                install_dir: Some(path_text(&dir)),
                published_at: None,
                release_url: None,
                prerelease: None,
            },
        );
    }

    for item in remote {
        let key = normalize_version(&item.tag_name);
        if key.is_empty() {
            continue;
        }
        if let Some(existing) = by_version.get_mut(&key) {
            if existing.published_at.is_none() {
                existing.published_at = item.published_at.clone();
            }
            if existing.release_url.is_none() {
                existing.release_url = Some(item.html_url.clone());
            }
            existing.prerelease = Some(item.prerelease);
        } else {
            by_version.insert(
                key.clone(),
                CpaVersionEntry {
                    version: key,
                    installed: false,
                    active: false,
                    install_dir: None,
                    published_at: item.published_at,
                    release_url: Some(item.html_url),
                    prerelease: Some(item.prerelease),
                },
            );
        }
    }

    let mut versions: Vec<CpaVersionEntry> = by_version.into_values().collect();
    versions.sort_by(|a, b| {
        numeric_version_parts(&b.version)
            .cmp(&numeric_version_parts(&a.version))
            .then_with(|| b.version.cmp(&a.version))
    });
    // 确保 active 标记与 current 一致
    if let Some(ref act) = active {
        for entry in &mut versions {
            entry.active = normalize_version(&entry.version) == *act;
        }
    }

    CpaComponentVersionInfo {
        id: id.into(),
        name: name.into(),
        repository: repository.into(),
        current_version: current,
        versions,
    }
}

#[tauri::command]
pub async fn extension_list_cpa_versions() -> Result<CpaVersionCatalog, String> {
    let suite = scan_cpa_suite();
    let cli_current = suite
        .components
        .iter()
        .find(|c| c.id == "cli-proxy-api")
        .and_then(|c| c.version.clone());
    let cpamp_current = suite
        .components
        .iter()
        .find(|c| c.id == "cpa-manager-plus")
        .and_then(|c| c.version.clone());

    let local_cli =
        tauri::async_runtime::spawn_blocking(|| list_local_component_versions("cli-proxy-api", parse_cli_version))
            .await
            .map_err(|e| e.to_string())?;
    let local_cpamp = tauri::async_runtime::spawn_blocking(|| {
        list_local_component_versions("cpa-manager-plus", parse_cpamp_version)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (cli_remote, cpamp_remote) = tokio::join!(
        fetch_github_releases("router-for-me/CLIProxyAPI", 30),
        fetch_github_releases("seakee/CPA-Manager-Plus", 30)
    );
    let cli_remote = cli_remote.unwrap_or_default();
    let cpamp_remote = cpamp_remote.unwrap_or_default();

    Ok(CpaVersionCatalog {
        id: CPA_SUITE_ID.into(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        components: vec![
            merge_component_versions(
                "cli-proxy-api",
                "CLIProxyAPI",
                "router-for-me/CLIProxyAPI",
                cli_current,
                local_cli,
                cli_remote,
            ),
            merge_component_versions(
                "cpa-manager-plus",
                "CPA Manager Plus",
                "seakee/CPA-Manager-Plus",
                cpamp_current,
                local_cpamp,
                cpamp_remote,
            ),
        ],
    })
}

pub(super) fn ensure_cpa_config_for_version(
    cli_dir: &Path,
    root: &Path,
    old_config: Option<&Path>,
) -> Result<(), String> {
    let secrets = if root.join("secrets.json").is_file() {
        read_cpa_secrets(root)?
    } else {
        return Ok(());
    };
    // 切换版本时强制写入当前 secrets，避免旧版 config.yaml 仍是其它密钥
    write_cpa_config(cli_dir, &secrets.management_key, &secrets.api_key, old_config)?;
    Ok(())
}

#[tauri::command]
pub async fn extension_switch_cpa_version(
    cli_version: Option<String>,
    cpamp_version: Option<String>,
    restart: Option<bool>,
) -> Result<ExtensionServiceStatus, String> {
    let _guard = cpa_deploy_lock().lock().await;
    let (pref_cli, pref_cpamp) = read_preferred_component_versions();
    let target_cli = cli_version
        .as_deref()
        .map(normalize_version)
        .filter(|v| !v.is_empty())
        .or(pref_cli)
        .or_else(|| {
            find_component_install("cli-proxy-api", parse_cli_version).and_then(|i| i.version)
        })
        .ok_or_else(|| "未指定 CLIProxyAPI 版本，且本地无可用安装。".to_string())?;
    let target_cpamp = cpamp_version
        .as_deref()
        .map(normalize_version)
        .filter(|v| !v.is_empty())
        .or(pref_cpamp)
        .or_else(|| {
            find_component_install("cpa-manager-plus", parse_cpamp_version).and_then(|i| i.version)
        })
        .ok_or_else(|| "未指定 CPA Manager Plus 版本，且本地无可用安装。".to_string())?;

    let cli_install =
        find_component_install_version("cli-proxy-api", parse_cli_version, &target_cli)
            .ok_or_else(|| {
                format!(
                    "本地未安装 CLIProxyAPI {}。请先「安装该版本」或从版本列表中选择已安装版本。",
                    target_cli
                )
            })?;
    let cpamp_install =
        find_component_install_version("cpa-manager-plus", parse_cpamp_version, &target_cpamp)
            .ok_or_else(|| {
                format!(
                    "本地未安装 CPA Manager Plus {}。请先「安装该版本」或从版本列表中选择已安装版本。",
                    target_cpamp
                )
            })?;

    let was_running = {
        let suite = scan_cpa_suite();
        suite.status == "running" || suite.status == "degraded"
    };
    let should_restart = restart.unwrap_or(was_running);

    if was_running || should_restart {
        kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
        kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let root = current_cpa_install_root();
    // 记录旧版本安装目录（此时 installed.json 仍指向旧版本）：auth/ 与 plugins/
    // 需迁移到新版本目录，plugins 配置段需在重写 config.yaml 时保留，
    // 否则升级/切换后插件文件虽在、启用状态却被模板抹掉，需用户手工重新启用。
    let old_cli_dir = find_component_install("cli-proxy-api", parse_cli_version).map(|c| c.dir);
    if let Some(old) = &old_cli_dir {
        // 同版本时 old == new，自拷既无意义，Windows 上还可能因文件自复制失败
        if old != &cli_install.dir {
            copy_dir_contents(&old.join("auth"), &cli_install.dir.join("auth"))?;
            copy_dir_contents(&old.join("plugins"), &cli_install.dir.join("plugins"))?;
        }
    }
    let old_config = old_cli_dir.as_ref().map(|d| d.join("config.yaml"));
    ensure_cpa_config_for_version(&cli_install.dir, &root, old_config.as_deref())?;
    write_installed_json(&root, &target_cli, &target_cpamp)?;

    // 写入 CPAMP 配置并迁移数据到共享目录
    let cpamp_runtime = {
        let dir = cpamp_install.dir.clone();
        tauri::async_runtime::spawn_blocking(move || resolve_cpamp_runtime_dir(&dir))
            .await
            .map_err(|e| e.to_string())??
    };
    let shared_data_dir = root.join("cpamp-data");
    let runtime_for_migrate = cpamp_runtime.clone();
    let shared_data_for_migrate = shared_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        migrate_cpamp_data(&runtime_for_migrate, &shared_data_for_migrate)
    })
    .await
    .map_err(|e| e.to_string())??;
    let runtime_for_config = cpamp_runtime.clone();
    let shared_data_for_config = shared_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_cpamp_config(&runtime_for_config, &shared_data_for_config)
    })
    .await
    .map_err(|e| e.to_string())??;

    if should_restart {
        start_cpa_suite_async().await?;
    }

    Ok(scan_cpa_suite())
}

