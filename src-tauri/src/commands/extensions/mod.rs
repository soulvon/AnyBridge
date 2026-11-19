use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(super) const CPA_SUITE_ID: &str = "cpa-suite";
pub(super) const CPA_PORT: u16 = 8317;
pub(super) const CPAMP_PORT: u16 = 18317;
pub(super) const PROBE_TIMEOUT_MS: u64 = 1500;
pub(super) const GITHUB_TIMEOUT_SECS: u64 = 15;
pub(super) const MIRROR_SPEED_TEST_TIMEOUT_SECS: u64 = 10;

// ═══════ GitHub 加速镜像源 ═══════

/// 镜像类型：prefix = 前缀代理, domain = 域名替换
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMirror {
    pub id: String,
    pub name: String,
    /// "prefix" 或 "domain"
    #[serde(rename = "type")]
    pub mirror_type: String,
    pub value: String,
    pub enabled: bool,
    /// 是否为用户自定义
    pub is_user: bool,
}

/// 默认 GitHub 加速镜像列表（按经验测速排序）
pub(super) fn default_mirrors() -> Vec<GithubMirror> {
    vec![
        GithubMirror { id: "gh-proxy".into(), name: "gh-proxy.com".into(), mirror_type: "prefix".into(), value: "https://gh-proxy.com/".into(), enabled: true, is_user: false },
        GithubMirror { id: "ghproxy".into(), name: "ghproxy.net".into(), mirror_type: "prefix".into(), value: "https://ghproxy.net/".into(), enabled: true, is_user: false },
        GithubMirror { id: "ghfast".into(), name: "ghfast.top".into(), mirror_type: "prefix".into(), value: "https://ghfast.top/".into(), enabled: true, is_user: false },
        GithubMirror { id: "ghps".into(), name: "ghps.cc".into(), mirror_type: "prefix".into(), value: "https://ghps.cc/".into(), enabled: true, is_user: false },
        GithubMirror { id: "bgithub".into(), name: "bgithub".into(), mirror_type: "domain".into(), value: "bgithub.xyz".into(), enabled: true, is_user: false },
        GithubMirror { id: "github".into(), name: "GitHub 原始".into(), mirror_type: "domain".into(), value: "github.com".into(), enabled: true, is_user: false },
    ]
}

/// 镜像配置文件路径
pub(super) fn mirror_config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("AnyBridge");
    p.push("mirrors.json");
    p
}

/// 读取用户自定义镜像配置，与默认镜像合并
pub(super) fn load_mirrors() -> Vec<GithubMirror> {
    let mut result = default_mirrors();
    let config_path = mirror_config_path();
    if let Ok(content) = fs::read_to_string(&config_path) {
        if let Ok(user_mirrors) = serde_json::from_str::<Vec<GithubMirror>>(&content) {
            for um in user_mirrors {
                if let Some(existing) = result.iter_mut().find(|m| m.id == um.id) {
                    *existing = um.clone();
                    existing.is_user = false; // 默认镜像即使用户改了也算非自定义
                } else {
                    result.push(um);
                }
            }
        }
    }
    result
}

/// 保存用户镜像配置
pub(super) fn save_user_mirrors(mirrors: &[GithubMirror]) -> Result<(), String> {
    let path = mirror_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建镜像配置目录失败: {}", e))?;
    }
    let json = serde_json::to_string_pretty(mirrors)
        .map_err(|e| format!("序列化镜像配置失败: {}", e))?;
    fs::write(&path, json.as_bytes())
        .map_err(|e| format!("写入镜像配置失败: {}", e))
}

/// 将 GitHub URL 还原为原始 URL（去除镜像前缀/域名替换）
pub(super) fn clean_github_url(url: &str) -> String {
    let mut cleaned = url.to_string();
    let mirrors = load_mirrors();
    // 还原域名替换
    for mirror in &mirrors {
        if mirror.mirror_type == "domain" && mirror.value != "github.com" {
            cleaned = cleaned.replace(&mirror.value, "github.com");
        }
    }
    // 去除前缀代理
    for mirror in &mirrors {
        if mirror.mirror_type == "prefix" && cleaned.starts_with(&mirror.value) {
            cleaned = cleaned[mirror.value.len()..].to_string();
        }
    }
    cleaned
}

/// 构建镜像下载 URL
pub(super) fn build_mirror_url(original_url: &str, mirror: &GithubMirror) -> String {
    let cleaned = clean_github_url(original_url);
    match mirror.mirror_type.as_str() {
        "prefix" => format!("{}{}", mirror.value, cleaned),
        "domain" => cleaned.replace("github.com", &mirror.value),
        _ => cleaned,
    }
}

/// 生成下载候选清单：原始 URL 优先，其后是各启用镜像的改写 URL（去重）。
/// 供其他模块（如汉化词库更新）复用扩展体系的镜像配置——
/// 用户在扩展页加的镜像这里自动生效。
pub(crate) fn mirror_candidates(original_url: &str) -> Vec<String> {
    let mut out = vec![original_url.to_string()];
    for m in load_mirrors() {
        if !m.enabled {
            continue;
        }
        let candidate = build_mirror_url(original_url, &m);
        if candidate != original_url && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// 并发测速：对每个启用的镜像发起 Range 请求下载 512KB，按耗时排序
pub(super) async fn speed_test_mirrors(test_url: &str) -> Vec<(GithubMirror, u64)> {
    let mirrors: Vec<GithubMirror> = load_mirrors()
        .into_iter()
        .filter(|m| m.enabled)
        .collect();

    let mut handles = Vec::new();
    for mirror in mirrors {
        let url = build_mirror_url(test_url, &mirror);
        let mirror_clone = mirror.clone();
        handles.push(tokio::spawn(async move {
            let client = match crate::commands::apply_system_proxy(reqwest::Client::builder())
                .timeout(Duration::from_secs(MIRROR_SPEED_TEST_TIMEOUT_SECS))
                .build()
            {
                Ok(c) => c,
                Err(_) => return (mirror_clone, u64::MAX),
            };
            let start = std::time::Instant::now();
            let resp = match client
                .get(&url)
                .header("Range", "bytes=0-524287") // 512KB
                .header("User-Agent", format!("AnyBridge/{}", env!("CARGO_PKG_VERSION")))
                .send()
                .await
            {
                Ok(r) => r,
                Err(_) => return (mirror_clone, u64::MAX),
            };
            // 200 或 206 都算成功
            if !resp.status().is_success() && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return (mirror_clone, u64::MAX);
            }
            // 尝试读取少量数据确认可用
            match resp.bytes().await {
                Ok(bytes) if !bytes.is_empty() => (mirror_clone, start.elapsed().as_millis() as u64),
                _ => (mirror_clone, u64::MAX),
            }
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok((mirror, duration)) = handle.await {
            results.push((mirror, duration));
        }
    }
    // 按耗时升序排序（u64::MAX 排最后）
    results.sort_by_key(|(_, d)| *d);
    results
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionComponentStatus {
    pub id: String,
    pub name: String,
    pub status: String,
    pub port: Option<u16>,
    pub version: Option<String>,
    pub install_dir: Option<String>,
    pub health_url: Option<String>,
    pub http_status: Option<u16>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionServiceStatus {
    pub id: String,
    pub name: String,
    pub status: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_source: Option<String>,
    pub install_dir: Option<String>,
    pub components: Vec<ExtensionComponentStatus>,
    pub notes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<CpaSecretsInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaSecretsInfo {
    pub admin_key: String,
    pub management_key: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdateComponent {
    pub id: String,
    pub name: String,
    pub repository: String,
    pub current_version: Option<String>,
    pub latest_version: String,
    pub update_available: Option<bool>,
    pub release_url: String,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaUpdateReport {
    pub id: String,
    pub checked_at: String,
    pub components: Vec<ExtensionUpdateComponent>,
}

#[derive(Debug, Deserialize)]
pub(super) struct GithubRelease {
    pub(super) tag_name: String,
    pub(super) html_url: String,
    published_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ComponentInstall {
    pub(super) dir: PathBuf,
    pub(super) version: Option<String>,
    pub(super) source: &'static str,
}

#[derive(Debug, Clone)]
pub(super) struct HttpProbe {
    pub(super) status: String,
    pub(super) http_status: Option<u16>,
    pub(super) detail: String,
}

pub(super) fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum CpaProxyMode {
    /// 跟随 Windows 系统代理（ProxyEnable + ProxyServer）
    System,
    /// 使用 custom_proxy_url
    Custom,
    /// 不走代理（直连）
    Off,
}

impl Default for CpaProxyMode {
    fn default() -> Self {
        CpaProxyMode::System
    }
}

impl CpaProxyMode {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            CpaProxyMode::System => "system",
            CpaProxyMode::Custom => "custom",
            CpaProxyMode::Off => "off",
        }
    }

    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "system" | "auto" | "follow" => Ok(CpaProxyMode::System),
            "custom" | "manual" => Ok(CpaProxyMode::Custom),
            "off" | "none" | "direct" | "disabled" => Ok(CpaProxyMode::Off),
            other => Err(format!(
                "不支持的代理模式: {} （可用 system / custom / off）",
                other
            )),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CpaSettings {
    pub(super) install_dir: Option<String>,
    /// 是否跟随 AnyBridge 启动。未设置时默认 true。
    #[serde(default = "default_cpa_auto_start")]
    pub(super) auto_start: bool,
    /// CPA 出站代理模式：system | custom | off，默认跟随系统代理。
    #[serde(default)]
    pub(super) proxy_mode: CpaProxyMode,
    /// custom 模式下的代理 URL（http/https/socks5）
    #[serde(default)]
    pub(super) custom_proxy_url: Option<String>,
}

impl Default for CpaSettings {
    fn default() -> Self {
        Self {
            install_dir: None,
            auto_start: true,
            proxy_mode: CpaProxyMode::System,
            custom_proxy_url: None,
        }
    }
}

pub(super) fn default_cpa_auto_start() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaProxySettingsView {
    pub mode: String,
    pub custom_url: String,
    pub system_url: Option<String>,
    pub effective_url: String,
    pub applied_url: Option<String>,
    pub config_path: Option<String>,
    pub needs_restart: bool,
    pub suite_running: bool,
}


mod archive_and_config;
mod cpa_install_and_mirrors;
mod cpa_settings_and_scan;
mod deploy_suite;
mod github_download;
mod process_and_suite;
mod updates_and_versions;

pub use cpa_install_and_mirrors::*;
pub use deploy_suite::*;
pub(crate) use github_download::{download_asset_with, resolve_release_asset, DownloadProgress};
pub use process_and_suite::*;
pub use updates_and_versions::*;

#[cfg(test)]
#[path = "tests.rs"]
mod plugins_preserve_tests;
