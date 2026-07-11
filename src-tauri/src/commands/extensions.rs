use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CPA_SUITE_ID: &str = "cpa-suite";
const CPA_PORT: u16 = 8317;
const CPAMP_PORT: u16 = 18317;
const PROBE_TIMEOUT_MS: u64 = 1500;
const GITHUB_TIMEOUT_SECS: u64 = 15;
const MIRROR_SPEED_TEST_TIMEOUT_SECS: u64 = 10;

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
fn default_mirrors() -> Vec<GithubMirror> {
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
fn mirror_config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("AnyBridge");
    p.push("mirrors.json");
    p
}

/// 读取用户自定义镜像配置，与默认镜像合并
fn load_mirrors() -> Vec<GithubMirror> {
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
fn save_user_mirrors(mirrors: &[GithubMirror]) -> Result<(), String> {
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
fn clean_github_url(url: &str) -> String {
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
fn build_mirror_url(original_url: &str, mirror: &GithubMirror) -> String {
    let cleaned = clean_github_url(original_url);
    match mirror.mirror_type.as_str() {
        "prefix" => format!("{}{}", mirror.value, cleaned),
        "domain" => cleaned.replace("github.com", &mirror.value),
        _ => cleaned,
    }
}

/// 并发测速：对每个启用的镜像发起 Range 请求下载 512KB，按耗时排序
async fn speed_test_mirrors(test_url: &str) -> Vec<(GithubMirror, u64)> {
    let mirrors: Vec<GithubMirror> = load_mirrors()
        .into_iter()
        .filter(|m| m.enabled)
        .collect();

    let mut handles = Vec::new();
    for mirror in mirrors {
        let url = build_mirror_url(test_url, &mirror);
        let mirror_clone = mirror.clone();
        handles.push(tokio::spawn(async move {
            let client = match super::apply_system_proxy(reqwest::Client::builder())
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
struct GithubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ComponentInstall {
    dir: PathBuf,
    version: Option<String>,
    source: &'static str,
}

#[derive(Debug, Clone)]
struct HttpProbe {
    status: String,
    http_status: Option<u16>,
    detail: String,
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CpaSettings {
    install_dir: Option<String>,
    /// 是否跟随 AnyBridge 启动。未设置时默认 true。
    #[serde(default = "default_cpa_auto_start")]
    auto_start: bool,
}

impl Default for CpaSettings {
    fn default() -> Self {
        Self {
            install_dir: None,
            auto_start: true,
        }
    }
}

fn default_cpa_auto_start() -> bool {
    true
}

fn cpa_settings_path() -> PathBuf {
    crate::commands::config::config_dir_path()
        .join("extensions")
        .join(CPA_SUITE_ID)
        .join("settings.json")
}

fn default_cpa_install_root() -> PathBuf {
    // 使用 LocalAppData（Windows）/ ~/.local/share（Linux）/ ~/Library/Application Support（macOS）
    // 避免 Roaming 目录同步大体积二进制文件
    let base = dirs::data_local_dir().unwrap_or_else(|| crate::commands::config::config_dir_path());
    base.join("anybridge")
        .join("extensions")
        .join("services")
        .join(CPA_SUITE_ID)
}

fn read_cpa_settings() -> CpaSettings {
    let path = cpa_settings_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(settings) = serde_json::from_str::<CpaSettings>(&content) {
            return settings;
        }
    }
    CpaSettings::default()
}

fn write_cpa_settings(settings: &CpaSettings) -> Result<(), String> {
    let path = cpa_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    super::write_atomic(&path, json.as_bytes())
}

fn current_cpa_install_root() -> PathBuf {
    let settings = read_cpa_settings();
    if let Some(dir) = settings.install_dir {
        let dir = dir.trim();
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    default_cpa_install_root()
}

fn is_cpa_auto_start_enabled() -> bool {
    read_cpa_settings().auto_start
}

fn persist_cpa_install_dir(dir: &Path) -> Result<(), String> {
    let default = default_cpa_install_root();
    let mut settings = read_cpa_settings();
    settings.install_dir = if dir == default.as_path() {
        None
    } else {
        Some(path_text(dir))
    };
    write_cpa_settings(&settings)
}

fn persist_cpa_auto_start(enabled: bool) -> Result<(), String> {
    let mut settings = read_cpa_settings();
    settings.auto_start = enabled;
    write_cpa_settings(&settings)
}

fn resolve_cpa_install_dir(install_dir: Option<String>) -> PathBuf {
    if let Some(dir) = install_dir {
        let dir = dir.trim();
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    current_cpa_install_root()
}

fn find_component_child_dir_with_preferred(
    root: &Path,
    component: &str,
    parser: fn(&Path) -> Option<String>,
    preferred_version: Option<&str>,
) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let predicate: fn(&str) -> bool = match component {
        "cli-proxy-api" => is_cli_proxy_api_dir,
        "cpa-manager-plus" => is_cpamp_dir,
        _ => return None,
    };
    let mut candidates = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() && predicate(&name) {
                Some(path)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    // 指定版本时：只匹配该版本；本目录没有就返回 None（由调用方继续搜其它 root 或回退）
    if let Some(preferred) = preferred_version.map(normalize_version) {
        if !preferred.is_empty() {
            return candidates.into_iter().find(|dir| {
                parser(dir)
                    .map(|v| normalize_version(&v) == preferred)
                    .unwrap_or(false)
            });
        }
    }

    candidates.sort_by(|a, b| {
        let a_version = parser(a)
            .map(|version| numeric_version_parts(&version))
            .unwrap_or_default();
        let b_version = parser(b)
            .map(|version| numeric_version_parts(&version))
            .unwrap_or_default();
        a_version.cmp(&b_version).then_with(|| a.cmp(b))
    });
    candidates.pop()
}

fn is_cli_proxy_api_dir(name: &str) -> bool {
    name.starts_with("CLIProxyAPI_")
}

fn is_cpamp_dir(name: &str) -> bool {
    name.starts_with("cpa-manager-plus")
}

fn parse_cli_version(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    name.strip_prefix("CLIProxyAPI_")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_cpamp_version(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    let value = name
        .strip_prefix("cpa-manager-plus_v")
        .or_else(|| name.strip_prefix("cpa-manager-plus_"))?;
    value
        .split("_windows")
        .next()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn component_search_roots() -> Vec<(PathBuf, &'static str)> {
    let managed = current_cpa_install_root();
    vec![
        (managed.clone(), "AnyBridge 托管目录"),
        (managed.join("versions"), "AnyBridge 托管版本目录"),
    ]
}

/// 从 installed.json 读取当前激活的组件版本（用于多版本并存时的优先选择）
fn read_preferred_component_versions() -> (Option<String>, Option<String>) {
    let path = current_cpa_install_root().join("installed.json");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return (None, None),
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let components = value
        .pointer("/extensions/cpa-suite/components")
        .or_else(|| value.pointer("/components"));
    let cli = components
        .and_then(|c| c.get("cli-proxy-api"))
        .and_then(|c| c.get("version"))
        .and_then(|v| v.as_str())
        .map(normalize_version)
        .filter(|v| !v.is_empty());
    let cpamp = components
        .and_then(|c| c.get("cpa-manager-plus"))
        .and_then(|c| c.get("version"))
        .and_then(|v| v.as_str())
        .map(normalize_version)
        .filter(|v| !v.is_empty());
    (cli, cpamp)
}

fn find_component_install(
    component: &str,
    parser: fn(&Path) -> Option<String>,
) -> Option<ComponentInstall> {
    let (pref_cli, pref_cpamp) = read_preferred_component_versions();
    let preferred = match component {
        "cli-proxy-api" => pref_cli.as_deref(),
        "cpa-manager-plus" => pref_cpamp.as_deref(),
        _ => None,
    };

    // 1) 优先在所有搜索根中找 installed.json 指定的版本
    if preferred.is_some() {
        for (root, source) in component_search_roots() {
            if !root.is_dir() {
                continue;
            }
            if let Some(dir) =
                find_component_child_dir_with_preferred(&root, component, parser, preferred)
            {
                return Some(ComponentInstall {
                    version: parser(&dir),
                    dir,
                    source,
                });
            }
        }
    }

    // 2) 找不到指定版本（或无记录）时，取各搜索根中版本号最大的安装
    for (root, source) in component_search_roots() {
        if !root.is_dir() {
            continue;
        }
        if let Some(dir) =
            find_component_child_dir_with_preferred(&root, component, parser, None)
        {
            return Some(ComponentInstall {
                version: parser(&dir),
                dir,
                source,
            });
        }
    }
    None
}

fn find_component_install_version(
    component: &str,
    parser: fn(&Path) -> Option<String>,
    version: &str,
) -> Option<ComponentInstall> {
    let preferred = normalize_version(version);
    if preferred.is_empty() {
        return None;
    }
    for (root, source) in component_search_roots() {
        if !root.is_dir() {
            continue;
        }
        let found =
            find_component_child_dir_with_preferred(&root, component, parser, Some(&preferred));
        if let Some(dir) = found {
            let parsed = parser(&dir)?;
            if normalize_version(&parsed) == preferred {
                return Some(ComponentInstall {
                    version: Some(parsed),
                    dir,
                    source,
                });
            }
        }
    }
    None
}

fn probe_http_port(port: u16, path: &str, label: &str) -> HttpProbe {
    probe_http_port_with_key(port, path, label, None)
}

fn probe_http_port_with_key(port: u16, path: &str, label: &str, mgmt_key: Option<&str>) -> HttpProbe {
    let timeout = Duration::from_millis(PROBE_TIMEOUT_MS);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(stream) => stream,
        Err(e) => {
            return HttpProbe {
                status: "stopped".into(),
                http_status: None,
                detail: format!("{} 的 {} 端口未监听：{}", label, port, e),
            };
        }
    };

    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let key_header = match mgmt_key {
        Some(k) => format!("X-Management-Key: {}\r\n", k),
        None => String::new(),
    };
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUser-Agent: AnyBridge-Extension-Probe/{}\r\nAccept: */*\r\n{}Connection: close\r\n\r\n",
        path,
        port,
        env!("CARGO_PKG_VERSION"),
        key_header
    );
    if let Err(e) = stream.write_all(request.as_bytes()) {
        return HttpProbe {
            status: "degraded".into(),
            http_status: None,
            detail: format!(
                "{} 的 {} 端口已接受连接，但写入 HTTP 请求失败：{}",
                label, port, e
            ),
        };
    }

    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    if let Err(e) = reader.read_line(&mut first_line) {
        return HttpProbe {
            status: "degraded".into(),
            http_status: None,
            detail: format!(
                "{} 的 {} 端口已接受连接，但读取 HTTP 响应失败：{}",
                label, port, e
            ),
        };
    }

    let http_status = first_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok());

    match http_status {
        Some(code) if code < 500 => HttpProbe {
            status: "running".into(),
            http_status: Some(code),
            detail: format!("{} 返回 HTTP {}", label, code),
        },
        Some(code) => HttpProbe {
            status: "degraded".into(),
            http_status: Some(code),
            detail: format!("{} 返回 HTTP {}", label, code),
        },
        None => HttpProbe {
            status: "degraded".into(),
            http_status: None,
            detail: format!(
                "{} 的 {} 端口有响应，但不是 HTTP 响应：{}",
                label,
                port,
                first_line.trim()
            ),
        },
    }
}

fn component_status(
    id: &str,
    name: &str,
    port: u16,
    health_path: &str,
    install: Option<&ComponentInstall>,
    mgmt_key: Option<&str>,
) -> ExtensionComponentStatus {
    let probe = probe_http_port_with_key(port, health_path, name, mgmt_key);
    ExtensionComponentStatus {
        id: id.into(),
        name: name.into(),
        status: probe.status,
        port: Some(port),
        version: install.and_then(|item| item.version.clone()),
        install_dir: install.map(|item| path_text(&item.dir)),
        health_url: Some(format!("http://127.0.0.1:{}{}", port, health_path)),
        http_status: probe.http_status,
        detail: probe.detail,
    }
}

fn summarize_cpa_version(
    cli: Option<&ComponentInstall>,
    cpamp: Option<&ComponentInstall>,
) -> Option<String> {
    match (
        cli.and_then(|item| item.version.as_deref()),
        cpamp.and_then(|item| item.version.as_deref()),
    ) {
        (Some(cli_version), Some(cpamp_version)) => {
            Some(format!("CPA {} / CPAMP {}", cli_version, cpamp_version))
        }
        (Some(cli_version), None) => Some(format!("CPA {} / CPAMP 版本未知", cli_version)),
        (None, Some(cpamp_version)) => Some(format!("CPA 版本未知 / CPAMP {}", cpamp_version)),
        (None, None) => None,
    }
}

fn scan_cpa_suite() -> ExtensionServiceStatus {
    let cli_install = find_component_install("cli-proxy-api", parse_cli_version);
    let cpamp_install = find_component_install("cpa-manager-plus", parse_cpamp_version);

    // 使用 /healthz 端点检查 CPA，无需管理密钥，避免 IP 封禁风险
    let cli_component = component_status(
        "cli-proxy-api",
        "CLIProxyAPI",
        CPA_PORT,
        "/healthz",
        cli_install.as_ref(),
        None,
    );
    let cpamp_component = component_status(
        "cpa-manager-plus",
        "CPA Manager Plus",
        CPAMP_PORT,
        "/health",
        cpamp_install.as_ref(),
        None,
    );

    let plugin_component = ExtensionComponentStatus {
        id: "cpa-plugins".into(),
        name: "CPA 插件".into(),
        status: "pending".into(),
        port: None,
        version: None,
        install_dir: None,
        health_url: Some(format!(
            "http://127.0.0.1:{}/v0/management/plugin-store",
            CPA_PORT
        )),
        http_status: None,
        detail: "插件库摘要需要接入 CPA 管理密钥后才能读取。".into(),
    };

    let installed = cli_install.is_some() || cpamp_install.is_some();
    let running_count = [&cli_component, &cpamp_component]
        .iter()
        .filter(|component| component.status == "running")
        .count();
    let degraded_count = [&cli_component, &cpamp_component]
        .iter()
        .filter(|component| component.status == "degraded")
        .count();

    let status = if running_count == 2 {
        "running"
    } else if running_count > 0 || degraded_count > 0 {
        "degraded"
    } else if installed {
        "installed"
    } else {
        "not-installed"
    };

    let install_source = cli_install
        .as_ref()
        .or(cpamp_install.as_ref())
        .map(|item| item.source.to_string());
    let install_dir = Some(path_text(&current_cpa_install_root()));

    let mut notes = Vec::new();
    notes.push(format!(
        "AnyBridge 托管目录：{}",
        path_text(&current_cpa_install_root())
    ));
    if !installed && running_count > 0 {
        notes.push(
            "【端口异常】端口有响应，但没有找到已知的本地安装目录。可能是外部进程占用了 8317/18317。"
                .into(),
        );
    }
    if status == "degraded" {
        for component in [&cli_component, &cpamp_component] {
            if component.status == "stopped" {
                notes.push(format!(
                    "【组件未运行】{} 端口 {} 未监听。",
                    component.name,
                    component.port.unwrap_or(0)
                ));
            } else if component.status == "degraded" {
                notes.push(format!(
                    "【健康检查异常】{}：{}",
                    component.name, component.detail
                ));
            }
        }
        if running_count == 1 {
            notes.push(
                "【部分异常】仅一个核心组件在运行，可尝试「重启」或先「停止」再「启动」。".into(),
            );
        }
    }

    let secrets = if installed {
        let root = current_cpa_install_root();
        if root.join("secrets.json").is_file() {
            read_cpa_secrets(&root).ok().map(|s| CpaSecretsInfo {
                admin_key: s.admin_key,
                management_key: s.management_key,
                api_key: s.api_key,
            })
        } else {
            None
        }
    } else {
        None
    };

    ExtensionServiceStatus {
        id: CPA_SUITE_ID.into(),
        name: "CPA 套件".into(),
        status: status.into(),
        installed,
        version: summarize_cpa_version(cli_install.as_ref(), cpamp_install.as_ref()),
        install_source,
        install_dir,
        components: vec![cli_component, cpamp_component, plugin_component],
        notes,
        secrets,
    }
}

fn normalize_version(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

fn numeric_version_parts(version: &str) -> Vec<u32> {
    normalize_version(version)
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> Option<bool> {
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
fn build_github_api_client() -> Result<reqwest::Client, String> {
    let mut builder = super::apply_system_proxy(reqwest::Client::builder())
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
async fn fetch_latest_release_via_web_redirect(repo: &str) -> Result<GithubRelease, String> {
    let client = super::apply_system_proxy(reqwest::Client::builder())
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

async fn fetch_latest_release(repo: &str) -> Result<GithubRelease, String> {
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

#[tauri::command]
pub async fn extension_list_managed_services() -> Result<Vec<ExtensionServiceStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| vec![scan_cpa_suite()])
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn extension_check_cpa_updates() -> Result<CpaUpdateReport, String> {
    let suite = scan_cpa_suite();
    let cli_current = suite
        .components
        .iter()
        .find(|component| component.id == "cli-proxy-api")
        .and_then(|component| component.version.clone());
    let cpamp_current = suite
        .components
        .iter()
        .find(|component| component.id == "cpa-manager-plus")
        .and_then(|component| component.version.clone());

    let (cli_latest, cpamp_latest) = tokio::try_join!(
        fetch_latest_release("router-for-me/CLIProxyAPI"),
        fetch_latest_release("seakee/CPA-Manager-Plus")
    )?;

    let checked_at = chrono::Utc::now().to_rfc3339();
    let cli_latest_version = normalize_version(&cli_latest.tag_name);
    let cpamp_latest_version = normalize_version(&cpamp_latest.tag_name);

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
                update_available: cli_current
                    .as_deref()
                    .and_then(|current| is_newer_version(&cli_latest_version, current)),
                release_url: cli_latest.html_url,
                published_at: cli_latest.published_at,
            },
            ExtensionUpdateComponent {
                id: "cpa-manager-plus".into(),
                name: "CPA Manager Plus".into(),
                repository: "seakee/CPA-Manager-Plus".into(),
                current_version: cpamp_current.clone(),
                latest_version: cpamp_latest_version.clone(),
                update_available: cpamp_current
                    .as_deref()
                    .and_then(|current| is_newer_version(&cpamp_latest_version, current)),
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
struct GithubReleaseListItem {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
}

fn list_local_component_versions(
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

async fn fetch_github_releases(repo: &str, per_page: u32) -> Result<Vec<GithubReleaseListItem>, String> {
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

fn merge_component_versions(
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

fn ensure_cpa_config_for_version(cli_dir: &Path, root: &Path) -> Result<(), String> {
    let secrets = if root.join("secrets.json").is_file() {
        read_cpa_secrets(root)?
    } else {
        return Ok(());
    };
    // 切换版本时强制写入当前 secrets，避免旧版 config.yaml 仍是其它密钥
    write_cpa_config(cli_dir, &secrets.management_key, &secrets.api_key)?;
    Ok(())
}

#[tauri::command]
pub async fn extension_switch_cpa_version(
    cli_version: Option<String>,
    cpamp_version: Option<String>,
    restart: Option<bool>,
) -> Result<ExtensionServiceStatus, String> {
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
    ensure_cpa_config_for_version(&cli_install.dir, &root)?;
    write_installed_json(&root, &target_cli, &target_cpamp)?;

    // silence unused warning for cpamp_install path verification above
    let _ = cpamp_install;

    if should_restart {
        start_cpa_suite_async().await?;
    }

    Ok(scan_cpa_suite())
}

// ═══════ 停止与更新 ═══════

fn local_addr_port(local_addr: &str) -> Option<u16> {
    // 支持 127.0.0.1:8317 / 0.0.0.0:8317 / [::1]:8317 / [::]:8317
    if let Some(rest) = local_addr.strip_prefix('[') {
        let (_host, port) = rest.rsplit_once("]:")?;
        return port.parse().ok();
    }
    local_addr.rsplit_once(':')?.1.parse().ok()
}

fn pid_listening_on_port(port: u16) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        // 注意：不能用 findstr :8317 —— 会误匹配 :18317（子串包含 8317）
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "netstat -ano -p tcp"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = cmd.output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if !line.contains("LISTENING") {
                continue;
            }
            // netstat 列：Proto LocalAddress ForeignAddress State PID
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 {
                continue;
            }
            if local_addr_port(cols[1]) != Some(port) {
                continue;
            }
            if let Ok(pid) = cols[cols.len() - 1].parse::<u32>() {
                return Some(pid);
            }
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        // lsof 优先
        if let Ok(out) = std::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port), "-sTCP:LISTEN"])
            .output()
        {
            if out.status.success() {
                if let Some(pid) = String::from_utf8_lossy(&out.stdout)
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                {
                    return Some(pid);
                }
            }
        }
        // ss 回退：users:(("name",pid=123,fd=4))
        if let Ok(out) = std::process::Command::new("ss")
            .args(["-ltnp", &format!("sport = :{}", port)])
            .output()
        {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if let Some(cap) = regex::Regex::new(r"pid=(\d+)")
                .ok()
                .and_then(|re| re.captures(&text))
            {
                if let Ok(pid) = cap[1].parse::<u32>() {
                    return Some(pid);
                }
            }
        }
        None
    }
}

fn kill_service_by_port(port: u16, label: &str) -> Result<(), String> {
    if let Some(pid) = pid_listening_on_port(port) {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/F", "/PID", &pid.to_string()]);
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let status = cmd
                .status()
                .map_err(|e| format!("无法停止 {} (PID {}): {}", label, pid, e))?;
            if !status.success() {
                return Err(format!("停止 {} (PID {}) 失败。", label, pid));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let status = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status()
                .map_err(|e| format!("无法停止 {} (PID {}): {}", label, pid, e))?;
            if !status.success() {
                return Err(format!("停止 {} (PID {}) 失败。", label, pid));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_stop_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    Ok(scan_cpa_suite())
}

fn read_cpa_secrets(root: &Path) -> Result<CpaSecrets, String> {
    let secrets_file = root.join("secrets.json");
    let content = fs::read_to_string(&secrets_file).map_err(|e| {
        format!(
            "无法读取 secrets.json（{}）：{}。请先完成一键部署，或确认安装目录正确。",
            path_text(&secrets_file),
            e
        )
    })?;
    serde_json::from_str(&content).map_err(|e| format!("解析 secrets.json 失败: {}", e))
}

fn resolve_cpa_secrets_for_start() -> Result<CpaSecrets, String> {
    let root = current_cpa_install_root();
    if root.join("secrets.json").is_file() {
        return read_cpa_secrets(&root);
    }
    // 兼容：secrets 偶发放在组件目录上一级（versions 的父目录）
    if let Some(cli) = find_component_install("cli-proxy-api", parse_cli_version) {
        if let Some(parent) = cli.dir.parent() {
            if parent.join("secrets.json").is_file() {
                return read_cpa_secrets(parent);
            }
            if let Some(grand) = parent.parent() {
                if grand.join("secrets.json").is_file() {
                    return read_cpa_secrets(grand);
                }
            }
        }
    }
    Err(
        "未找到 secrets.json。启动 CPA Manager Plus 需要部署时生成的密钥；请先一键部署，或将 secrets.json 放到托管安装目录。"
            .into(),
    )
}

/// 启动 CPA 套件：先启动 CPA → 等待就绪 → 启动 CPAMP → 等待就绪 → 注入补丁 → 添加供应商
async fn start_cpa_suite_async() -> Result<(), String> {
    let cli_install = find_component_install("cli-proxy-api", parse_cli_version)
        .ok_or_else(|| "未找到 CLIProxyAPI 安装目录，请先部署 CPA 套件。".to_string())?;
    let cpamp_install = find_component_install("cpa-manager-plus", parse_cpamp_version)
        .ok_or_else(|| "未找到 CPA Manager Plus 安装目录，请先部署 CPA 套件。".to_string())?;

    let cli_probe = probe_http_port(CPA_PORT, "/healthz", "CLIProxyAPI");
    let cpamp_probe = probe_http_port(CPAMP_PORT, "/health", "CPA Manager Plus");
    let need_cli = cli_probe.status != "running";
    let need_cpamp = cpamp_probe.status != "running";

    // 始终解析密钥（启动 CPAMP、注入补丁、添加供应商都需要）
    let secrets = resolve_cpa_secrets_for_start()?;

    // 1. 启动 CPA（端口被不健康进程占用时先 kill）
    if need_cli {
        if cli_probe.status == "degraded" {
            let _ = kill_service_by_port(CPA_PORT, "CLIProxyAPI");
            tokio::time::sleep(Duration::from_secs(1)).await;
        } else {
            check_port_available(CPA_PORT, "CLIProxyAPI")?;
        }
        let cpa_exe = find_exe_in_dir(&cli_install.dir, "cli-proxy-api")?;
        tauri::async_runtime::spawn_blocking(move || start_service(&cpa_exe, &cli_install.dir, &[]))
            .await
            .map_err(|e| e.to_string())??;
    }

    // 2. 等待 CPA 就绪（CPAMP 依赖 CPA 作为 upstream，必须先就绪）
    wait_for_http(CPA_PORT, "/healthz", "CLIProxyAPI", 15).await?;

    // 3. 启动 CPAMP（端口被不健康进程占用时先 kill）
    // panelPath/PANEL_PATH 会替换 /management.html 的内容，不会新增 /management-auto.html。
    // 必须先无 PANEL_PATH 启动以拉取内嵌原版，写入补丁后再带 PANEL_PATH 重启。
    let runtime_dir = resolve_cpamp_runtime_dir(&cpamp_install.dir)?;
    write_cpamp_config(&runtime_dir)?;

    if need_cpamp {
        if cpamp_probe.status == "degraded" {
            let _ = kill_service_by_port(CPAMP_PORT, "CPA Manager Plus");
            tokio::time::sleep(Duration::from_secs(1)).await;
        } else {
            check_port_available(CPAMP_PORT, "CPA Manager Plus")?;
        }
        let cpamp_exe = find_exe_in_dir(&cpamp_install.dir, "cpa-manager-plus")?;
        // 首次启动不带 PANEL_PATH，确保能读到内嵌 management.html
        let cpamp_env = vec![
            ("CPA_MANAGER_ADMIN_KEY".into(), secrets.admin_key.clone()),
            ("CPA_UPSTREAM_URL".into(), "http://127.0.0.1:8317".into()),
            ("CPA_MANAGEMENT_KEY".into(), secrets.management_key.clone()),
        ];
        let runtime_start = runtime_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_service(&cpamp_exe, &runtime_start, &cpamp_env)
        })
        .await
        .map_err(|e| e.to_string())??;

        // 4. 等待 CPAMP 就绪
        wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 10).await?;
    }

    // 5. 注入自动登录补丁到 runtime 目录
    let patch_dir = runtime_dir.clone();
    let patch_key = secrets.admin_key.clone();
    tauri::async_runtime::spawn_blocking(move || patch_cpamp_management_html(&patch_dir, &patch_key))
        .await
        .map_err(|e| e.to_string())??;

    // 6. 用 PANEL_PATH 重启 CPAMP，使 /management.html 返回自动登录补丁
    if cpamp_panel_file(&runtime_dir).is_file() {
        let _ = kill_service_by_port(CPAMP_PORT, "CPA Manager Plus");
        tokio::time::sleep(Duration::from_secs(1)).await;
        let cpamp_exe = find_exe_in_dir(&cpamp_install.dir, "cpa-manager-plus")?;
        let cpamp_env = cpamp_env_with_panel(&secrets, &runtime_dir);
        let runtime_start = runtime_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_service(&cpamp_exe, &runtime_start, &cpamp_env)
        })
        .await
        .map_err(|e| e.to_string())??;
        wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 10).await?;
    }

    // 7. 自动添加 CPA 供应商
    let provider_api_key = secrets.api_key.clone();
    tauri::async_runtime::spawn_blocking(move || auto_add_cpa_provider(&provider_api_key))
        .await
        .map_err(|e| e.to_string())??;

    Ok(())
}

#[tauri::command]
pub async fn extension_start_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    start_cpa_suite_async().await?;
    Ok(scan_cpa_suite())
}

fn is_safe_cpa_uninstall_root(root: &Path) -> bool {
    if !root.is_dir() {
        return false;
    }
    root.join("installed.json").is_file() || root.join("versions").is_dir()
}

fn remove_dir_contents(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_file() {
        fs::remove_file(path).map_err(|e| format!("删除文件失败 {}: {}", path.display(), e))?;
        return Ok(());
    }
    fs::remove_dir_all(path).map_err(|e| format!("删除目录失败 {}: {}", path.display(), e))?;
    Ok(())
}

fn uninstall_cpa_suite_files() -> Result<(), String> {
    let root = current_cpa_install_root();
    if !root.exists() {
        // 仍清理自定义 installDir 配置
        let _ = persist_cpa_install_dir(&default_cpa_install_root());
        return Ok(());
    }
    if !is_safe_cpa_uninstall_root(&root) {
        return Err(format!(
            "安装目录 {} 缺少 installed.json 或 versions/，已拒绝删除以防误伤用户目录。请确认路径后手动清理，或重新部署到默认托管目录。",
            path_text(&root)
        ));
    }

    // 优先删 versions 与元数据，最后尝试移除空根目录
    let versions = root.join("versions");
    if versions.exists() {
        remove_dir_contents(&versions)?;
    }
    for name in ["installed.json", "secrets.json"] {
        let file = root.join(name);
        if file.exists() {
            remove_dir_contents(&file)?;
        }
    }
    // 清理根下其它残留（配置、日志等）
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = remove_dir_contents(&path);
        }
    }
    if fs::read_dir(&root).map(|mut it| it.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(&root);
    }

    // 恢复默认安装路径配置
    persist_cpa_install_dir(&default_cpa_install_root())?;
    Ok(())
}

#[tauri::command]
pub async fn extension_uninstall_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    tauri::async_runtime::spawn_blocking(uninstall_cpa_suite_files)
        .await
        .map_err(|e| e.to_string())??;

    // 卸载后移除内置 CPA 供应商
    let _ = tauri::async_runtime::spawn_blocking(remove_cpa_provider)
        .await
        .map_err(|e| e.to_string())?;

    Ok(scan_cpa_suite())
}

#[tauri::command]
pub async fn extension_restart_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(2)).await;

    start_cpa_suite_async().await?;
    Ok(scan_cpa_suite())
}

#[tauri::command]
pub async fn extension_cpa_default_install_dir() -> Result<String, String> {
    Ok(path_text(&default_cpa_install_root()))
}

#[tauri::command]
pub async fn extension_cpa_install_dir() -> Result<String, String> {
    Ok(path_text(&current_cpa_install_root()))
}

#[tauri::command]
pub async fn extension_set_cpa_install_dir(dir: String) -> Result<(), String> {
    if dir.trim().is_empty() {
        return Err("安装目录不能为空。".into());
    }
    let path = PathBuf::from(dir.trim());
    persist_cpa_install_dir(&path)
}

#[tauri::command]
pub async fn extension_cpa_auto_start() -> Result<bool, String> {
    Ok(is_cpa_auto_start_enabled())
}

#[tauri::command]
pub async fn extension_set_cpa_auto_start(enabled: bool) -> Result<bool, String> {
    persist_cpa_auto_start(enabled)?;
    Ok(enabled)
}

/// 应用启动时调用：若已安装且开启跟随启动，则后台拉起 CPA 套件。
pub fn maybe_auto_start_cpa_suite() {
    tauri::async_runtime::spawn(async move {
        let enabled = tauri::async_runtime::spawn_blocking(is_cpa_auto_start_enabled)
            .await
            .unwrap_or(true);
        if !enabled {
            return;
        }
        let suite = match tauri::async_runtime::spawn_blocking(scan_cpa_suite).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[auto-start] 检测 CPA 状态失败: {}", e);
                return;
            }
        };
        if !suite.installed {
            return;
        }
        if suite.status == "running" {
            return;
        }
        match start_cpa_suite_async().await {
            Ok(()) => eprintln!("[auto-start] CPA 套件已跟随启动"),
            Err(e) => eprintln!("[auto-start] CPA 套件启动失败: {}", e),
        }
    });
}

#[tauri::command]
pub async fn extension_update_cpa_suite(
    app: AppHandle,
    install_dir: Option<String>,
) -> Result<ExtensionServiceStatus, String> {
    let report = extension_check_cpa_updates().await?;
    let has_update = report
        .components
        .iter()
        .any(|component| component.update_available == Some(true));
    if !has_update {
        return Err("当前已是最新版本，无需更新。".into());
    }

    emit_deploy_progress(&app, "check", "检查到新版本，准备更新...", 2);
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(2)).await;

    extension_deploy_cpa_suite(app, install_dir).await
}

// ═══════ 部署 ═══════

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployProgress {
    step: String,
    message: String,
    percent: u8,
    is_error: bool,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseWithAssets {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CpaSecrets {
    admin_key: String,
    management_key: String,
    api_key: String,
}

fn emit_deploy_progress(app: &AppHandle, step: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "deploy-progress",
        DeployProgress {
            step: step.into(),
            message: message.into(),
            percent,
            is_error: false,
        },
    );
}

fn build_github_client() -> Result<reqwest::Client, String> {
    let mut builder = super::apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(GITHUB_TIMEOUT_SECS))
        .user_agent(format!(
            "AnyBridge-Extension-Deploy/{}",
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

fn generate_random_key(len: usize) -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

async fn fetch_release_with_assets(repo: &str) -> Result<GithubReleaseWithAssets, String> {
    let client = build_github_client()?;
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub 最新发布包失败 {}：{}", repo, e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "GitHub 最新发布包请求失败 {}：HTTP {}",
            repo, status
        ));
    }
    response
        .json::<GithubReleaseWithAssets>()
        .await
        .map_err(|e| format!("无法解析 GitHub 发布包信息 {}：{}", repo, e))
}

async fn fetch_release_with_assets_by_tag(
    repo: &str,
    tag: &str,
) -> Result<GithubReleaseWithAssets, String> {
    let client = build_github_client()?;
    let tag = tag.trim().trim_start_matches('v').trim_start_matches('V');
    // 先试 tags/vX，再试 tags/X
    let candidates = [
        format!("v{}", tag),
        tag.to_string(),
        format!("V{}", tag),
    ];
    let mut last_err = String::new();
    for tag_name in &candidates {
        let url = format!(
            "https://api.github.com/repos/{}/releases/tags/{}",
            repo, tag_name
        );
        let response = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("请求 GitHub 指定版本失败 {} @ {}：{}", repo, tag_name, e))?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<GithubReleaseWithAssets>()
                .await
                .map_err(|e| format!("无法解析 GitHub 发布包 {} @ {}：{}", repo, tag_name, e));
        }
        last_err = format!("HTTP {}", status);
        if status != 404 {
            break;
        }
    }
    Err(format!(
        "未找到 {} 的发布版本 {}（{}）",
        repo, tag, last_err
    ))
}

fn host_os_tokens() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["windows", "win"]
    }
    #[cfg(target_os = "macos")]
    {
        &["darwin", "macos", "osx", "mac"]
    }
    #[cfg(target_os = "linux")]
    {
        &["linux"]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        &[]
    }
}

fn host_arch_tokens() -> Result<&'static [&'static str], String> {
    #[cfg(target_arch = "x86_64")]
    {
        return Ok(&["amd64", "x86_64", "x64"]);
    }
    #[cfg(target_arch = "aarch64")]
    {
        return Ok(&["arm64", "aarch64"]);
    }
    #[cfg(target_arch = "x86")]
    {
        return Ok(&["386", "i386", "ia32", "win32"]);
    }
    #[allow(unreachable_code)]
    Err("当前一键部署不支持此 CPU 架构。".into())
}

fn is_release_archive_name(name: &str) -> bool {
    let n = name.to_lowercase();
    // 仅声明 extract_archive 实际支持的格式，避免选出 .tar.bz2 后解压失败
    n.ends_with(".zip") || n.ends_with(".tar.gz") || n.ends_with(".tgz")
}

fn asset_matches_host(name: &str, os_tokens: &[&str], arch_tokens: &[&str]) -> bool {
    let n = name.to_lowercase();
    if !is_release_archive_name(&n) {
        return false;
    }
    // 排除明显的其它 OS
    let other_os: &[&str] = match std::env::consts::OS {
        "windows" => &["darwin", "macos", "linux", "freebsd"],
        "macos" => &["windows", "win32", "win64", "linux", "freebsd"],
        "linux" => &["windows", "win32", "win64", "darwin", "macos", "osx"],
        _ => &[],
    };
    if other_os.iter().any(|tok| n.contains(tok)) {
        return false;
    }
    let os_ok = os_tokens.iter().any(|tok| n.contains(tok));
    let arch_ok = arch_tokens.iter().any(|tok| n.contains(tok));
    os_ok && arch_ok
}

/// 在 GitHub release assets 中挑选当前 OS/arch 的安装包（zip / tar.gz）。
fn find_platform_release_asset<'a>(
    assets: &'a [GithubAsset],
    label: &str,
) -> Result<&'a GithubAsset, String> {
    let os_tokens = host_os_tokens();
    if os_tokens.is_empty() {
        return Err(format!("{} 当前操作系统不支持一键部署。", label));
    }
    let arch_tokens = host_arch_tokens()?;

    let candidates: Vec<&GithubAsset> = assets
        .iter()
        .filter(|a| asset_matches_host(&a.name, os_tokens, arch_tokens))
        .collect();

    if candidates.is_empty() {
        let available = assets
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join("、");
        return Err(format!(
            "未在 {} 的 GitHub 发布包中找到匹配当前平台（{} / {}）的安装包。可用资产：{}",
            label,
            std::env::consts::OS,
            std::env::consts::ARCH,
            if available.is_empty() {
                "（无）".into()
            } else {
                available
            }
        ));
    }

    // 优先 zip，其次 tar.gz；同类型取名字更短的（通常是主包而非 source）
    let mut ranked = candidates;
    ranked.sort_by_key(|a| {
        let n = a.name.to_lowercase();
        let ext_rank = if n.ends_with(".zip") {
            0
        } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
            1
        } else {
            2
        };
        (ext_rank, a.name.len())
    });
    ranked
        .into_iter()
        .next()
        .ok_or_else(|| format!("{} 未找到可用安装包", label))
}

/// 从单个 URL 下载文件（带进度回调），返回下载的临时文件路径
async fn download_from_url(
    url: &str,
    tmp: &Path,
    app: &AppHandle,
    base_percent: u8,
    end_percent: u8,
) -> Result<(), String> {
    let client = build_github_client()?;
    let response = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载发布包失败：HTTP {}", status));
    }

    let total = response.content_length();
    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| format!("无法创建临时文件: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|e| format!("下载失败: {}", e))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &data)
            .await
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        downloaded += data.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(400) {
            let (pct, msg) = if let Some(total) = total {
                let p = base_percent
                    + ((downloaded as f64 / total as f64) * (end_percent - base_percent) as f64)
                        as u8;
                (
                    p,
                    format!(
                        "下载中 {:.1} / {:.1} MB",
                        downloaded as f64 / 1_000_000.0,
                        total as f64 / 1_000_000.0
                    ),
                )
            } else {
                (
                    base_percent,
                    format!("下载中 {:.1} MB", downloaded as f64 / 1_000_000.0),
                )
            };
            emit_deploy_progress(app, "download", &msg, pct);
            last_emit = std::time::Instant::now();
        }
    }

    Ok(())
}

/// 带镜像测速 + 轮询回退的下载
async fn download_asset(
    url: &str,
    filename: &str,
    app: &AppHandle,
    base_percent: u8,
    end_percent: u8,
) -> Result<PathBuf, String> {
    let tmp = std::env::temp_dir().join(filename);

    // 1. 测速
    emit_deploy_progress(app, "download", "正在测速，寻找最快下载源...", base_percent);
    let ranked = speed_test_mirrors(url).await;

    if ranked.is_empty() {
        // 没有可用镜像，直接从原始 URL 下载
        download_from_url(url, &tmp, app, base_percent, end_percent).await?;
        return Ok(tmp);
    }

    // 2. 按测速结果依次尝试
    let mut last_err = String::new();
    for (i, (mirror, duration)) in ranked.iter().enumerate() {
        let mirror_url = build_mirror_url(url, mirror);
        let speed_label = if *duration == u64::MAX {
            "未测速".to_string()
        } else {
            format!("{}ms", duration)
        };

        if i == 0 {
            emit_deploy_progress(
                app,
                "download",
                &format!("从 {} 下载...（测速 {}）", mirror.name, speed_label),
                base_percent,
            );
        } else {
            emit_deploy_progress(
                app,
                "download",
                &format!("切换到 {} 重试下载...", mirror.name),
                base_percent,
            );
        }

        match download_from_url(&mirror_url, &tmp, app, base_percent, end_percent).await {
            Ok(()) => return Ok(tmp),
            Err(e) => {
                last_err = e;
                // 清理失败的临时文件
                let _ = tokio::fs::remove_file(&tmp).await;
            }
        }
    }

    Err(format!("所有镜像下载均失败，最后错误: {}", last_err))
}

fn extract_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("无法创建目标目录 {}: {}", target_dir.display(), e))?;

    let name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if name.ends_with(".zip") {
        extract_zip_archive(archive_path, target_dir)?;
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz_archive(archive_path, target_dir)?;
    } else {
        return Err(format!(
            "不支持的安装包格式: {}（需要 .zip 或 .tar.gz）",
            archive_path.display()
        ));
    }

    // 解压成功后删除临时包
    let _ = fs::remove_file(archive_path);
    Ok(())
}

fn extract_zip_archive(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let prefix = target_dir.to_path_buf();
    let file = fs::File::open(zip_path).map_err(|e| format!("无法打开 zip 文件: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无效的 zip 文件: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let name = entry.mangled_name();
        let entry_path = prefix.join(&name);

        if entry.is_dir() {
            fs::create_dir_all(&entry_path).map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = entry_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut outfile = fs::File::create(&entry_path)
                .map_err(|e| format!("创建文件失败 {}: {}", entry_path.display(), e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("写入文件失败 {}: {}", entry_path.display(), e))?;
        }
    }
    Ok(())
}

fn extract_tar_gz_archive(tar_gz_path: &Path, target_dir: &Path) -> Result<(), String> {
    use flate2::read::GzDecoder;

    let file =
        fs::File::open(tar_gz_path).map_err(|e| format!("无法打开 tar.gz 文件: {}", e))?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(target_dir)
        .map_err(|e| format!("解压 tar.gz 失败: {}", e))?;

    // 确保 Unix 可执行位：对解压出的疑似二进制补 0o755
    #[cfg(unix)]
    {
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;
        fn fix_exec(dir: &Path) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    fix_exec(&path);
                    continue;
                }
                if !path.is_file() {
                    continue;
                }
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if name.contains('.') && !name.ends_with(".sh") {
                    continue;
                }
                // 读文件头判断 ELF / Mach-O
                let mut hdr = [0u8; 4];
                if let Ok(mut f) = fs::File::open(&path) {
                    if f.read(&mut hdr).is_ok() {
                        let is_elf = &hdr == b"\x7fELF";
                        let is_macho = hdr == [0xcf, 0xfa, 0xed, 0xfe]
                            || hdr == [0xce, 0xfa, 0xed, 0xfe]
                            || hdr == [0xca, 0xfe, 0xba, 0xbe];
                        if is_elf || is_macho || name.ends_with(".sh") {
                            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
                        }
                    }
                }
            }
        }
        fix_exec(target_dir);
    }

    Ok(())
}

fn find_exe_in_dir(dir: &Path, name_hint: &str) -> Result<PathBuf, String> {
    let hint = name_hint.to_lowercase();
    #[cfg(target_os = "windows")]
    {
        let candidate = dir.join(format!("{}.exe", name_hint));
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let candidate = dir.join(name_hint);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    fn visit(dir: &Path, hint: &str, matches: &mut Vec<PathBuf>) -> Result<(), String> {
        let entries =
            fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}: {}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取目录条目失败：{}", e))?;
            let path = entry.path();
            if path.is_dir() {
                // 跳过常见无关目录
                let dir_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if matches!(
                    dir_name.as_str(),
                    "node_modules" | ".git" | "__macosx" | "docs" | "doc"
                ) {
                    continue;
                }
                visit(&path, hint, matches)?;
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_lowercase();
            #[cfg(target_os = "windows")]
            {
                if file_name == format!("{}.exe", hint)
                    || (file_name.contains(hint) && file_name.ends_with(".exe"))
                {
                    matches.push(path);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let looks_binary_name = file_name == hint
                    || (file_name.starts_with(hint)
                        && !file_name.contains('.')
                        && file_name
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
                let bad_suffix = [
                    ".md", ".json", ".yml", ".yaml", ".txt", ".toml", ".so", ".dylib", ".a",
                    ".o", ".h", ".c", ".go", ".rs", ".js", ".ts", ".map", ".sample", ".sha256",
                    ".sig", ".asc",
                ]
                .iter()
                .any(|s| file_name.ends_with(s));
                if looks_binary_name && !bad_suffix {
                    matches.push(path);
                }
            }
        }
        Ok(())
    }

    let mut matches = Vec::new();
    visit(dir, &hint, &mut matches)?;
    // 精确文件名优先
    matches.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        let exact = if cfg!(windows) {
            name == format!("{}.exe", hint)
        } else {
            name == hint
        };
        (!exact, name.len(), p.to_string_lossy().len())
    });
    matches
        .into_iter()
        .next()
        .ok_or_else(|| format!("在 {} 中未找到 {} 可执行文件", dir.display(), name_hint))
}

/// CPAMP 实际运行目录：可执行文件所在目录（发布包常再套一层平台目录）。
/// 配置、data、panelPath 都必须落在这里，否则 panelPath 不会生效。
fn resolve_cpamp_runtime_dir(install_dir: &Path) -> Result<PathBuf, String> {
    let exe = find_exe_in_dir(install_dir, "cpa-manager-plus")?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("无法解析 CPAMP 运行目录: {}", exe.display()))
}

fn cpamp_panel_file(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("management-auto.html")
}

fn cpamp_env_with_panel(secrets: &CpaSecrets, runtime_dir: &Path) -> Vec<(String, String)> {
    let panel = cpamp_panel_file(runtime_dir);
    vec![
        ("CPA_MANAGER_ADMIN_KEY".into(), secrets.admin_key.clone()),
        ("CPA_UPSTREAM_URL".into(), "http://127.0.0.1:8317".into()),
        ("CPA_MANAGEMENT_KEY".into(), secrets.management_key.clone()),
        // 绝对路径更稳：覆盖内嵌 /management.html，不会新增 /management-auto.html 路由
        ("PANEL_PATH".into(), path_text(&panel)),
    ]
}

fn start_service(
    exe_path: &Path,
    working_dir: &Path,
    env_vars: &[(String, String)],
) -> Result<u32, String> {
    let mut cmd = std::process::Command::new(exe_path);
    cmd.current_dir(working_dir);
    for (key, val) in env_vars {
        cmd.env(key, val);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", exe_path.display(), e))?;
    Ok(child.id())
}

async fn wait_for_http(port: u16, path: &str, label: &str, max_retries: u32) -> Result<(), String> {
    wait_for_http_with_key(port, path, label, max_retries, None).await
}

async fn wait_for_http_with_key(port: u16, path: &str, label: &str, max_retries: u32, mgmt_key: Option<String>) -> Result<(), String> {
    for attempt in 0..max_retries {
        // 首次不等待，后续每次重试间隔 2 秒
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let probe = {
            let path = path.to_string();
            let label = label.to_string();
            let key = mgmt_key.clone();
            tauri::async_runtime::spawn_blocking(move || probe_http_port_with_key(port, &path, &label, key.as_deref()))
                .await
                .map_err(|e| e.to_string())?
        };
        if probe.status == "running" {
            return Ok(());
        }
    }
    Err(format!(
        "{} (端口 {}) 健康检查超时，已等待 {} 秒",
        label,
        port,
        max_retries * 2
    ))
}

fn write_cpa_config(dir: &Path, mgmt_key: &str, api_key: &str) -> Result<(), String> {
    let content = format!(
        "host: \"127.0.0.1\"\n\
         port: 8317\n\
         tls:\n\
         \x20 enable: false\n\
         \x20 cert: \"\"\n\
         \x20 key: \"\"\n\
         remote-management:\n\
         \x20 allow-remote: false\n\
         \x20 secret-key: \"{}\"\n\
         \x20 disable-control-panel: false\n\
         auth-dir: \"auth\"\n\
         api-keys:\n\
         \x20 - \"{}\"\n\
         debug: false\n\
         usage-statistics-enabled: true\n\
         redis-usage-queue-retention-seconds: 300\n\
         request-retry: 1\n\
         proxy-url: \"\"\n\
         quota-exceeded:\n\
         \x20 switch-project: true\n\
         \x20 switch-preview-model: true\n\
         \x20 antigravity-credits: true\n\
         routing:\n\
         \x20 strategy: \"round-robin\"\n\
         \x20 session-affinity: false\n\
         \x20 session-affinity-ttl: \"1h\"\n\
         plugins:\n\
         \x20 enabled: true\n\
         \x20 dir: \"plugins\"\n\
         ws-auth: true\n",
        mgmt_key, api_key
    );
    let target = dir.join("config.yaml");
    fs::write(&target, content).map_err(|e| format!("写入 CPA config.yaml 失败: {}", e))
}

fn write_cpamp_config(dir: &Path) -> Result<(), String> {
    // panelPath 相对路径相对于 CPAMP 运行目录（exe 同目录）
    let json = serde_json::json!({
        "httpAddr": "127.0.0.1:18317",
        "dataDir": "./data",
        "cpaUpstreamUrl": "http://127.0.0.1:8317",
        "panelPath": "management-auto.html"
    });
    let json_str =
        serde_json::to_string_pretty(&json).map_err(|e| format!("序列化 CPAMP 配置失败: {}", e))?;
    let target = dir.join("config.json");
    fs::write(&target, &json_str).map_err(|e| format!("写入 CPAMP config.json 失败: {}", e))
}

/// 获取 CPAMP 管理面板 HTML 并注入自动登录脚本。
/// 写入 runtime_dir/management-auto.html，并通过 PANEL_PATH 覆盖 /management.html。
fn patch_cpamp_management_html(runtime_dir: &Path, admin_key: &str) -> Result<(), String> {
    let patched_path = cpamp_panel_file(runtime_dir);

    // 先删除旧补丁文件，确保能获取到内嵌原版（若 PANEL_PATH 尚未生效）
    let _ = fs::remove_file(&patched_path);

    // 从 CPAMP 获取内嵌的 management.html（带重试，等待 CPAMP HTTP 就绪）
    let url = format!("http://127.0.0.1:{}/management.html", CPAMP_PORT);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let html = {
        let mut last_err = String::new();
        let mut result: Option<String> = None;
        for _ in 0..10 {
            match client.get(&url).send() {
                Ok(resp) => match resp.text() {
                    Ok(text) if !text.is_empty() => {
                        // 若已是补丁页（极少见：上一轮 PANEL_PATH 仍在），不要重复注入
                        if text.contains("ANYBRIDGE_AUTO_LOGIN") {
                            result = Some(text);
                            break;
                        }
                        result = Some(text);
                        break;
                    }
                    Ok(_) => {
                        last_err = "management.html 响应为空".to_string();
                    }
                    Err(e) => last_err = e.to_string(),
                },
                Err(e) => last_err = e.to_string(),
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        match result {
            Some(text) => text,
            None => {
                return Err(format!(
                    "获取 management.html 失败（重试 10 次仍无法连接）: {}",
                    last_err
                ))
            }
        }
    };

    // 已有补丁则直接落盘，保证 runtime 目录有文件供 PANEL_PATH 使用
    if html.contains("ANYBRIDGE_AUTO_LOGIN") {
        fs::write(&patched_path, html.as_bytes())
            .map_err(|e| format!("写入 management-auto.html 失败: {}", e))?;
        return Ok(());
    }

    // 构建自动登录脚本
    let escaped_key = admin_key
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    let inject_script = format!(
        r#"<script>/* ANYBRIDGE_AUTO_LOGIN */(function(){{var K="{}";var B="http://127.0.0.1:{}";try{{if(localStorage.getItem("isLoggedIn")==="true"){{var e=localStorage.getItem("cli-proxy-auth");if(e&&e.indexOf(K)!==-1)return;}}}}catch(e){{}}localStorage.setItem("isLoggedIn","true");localStorage.setItem("apiBase",JSON.stringify(B));localStorage.setItem("managementKey",JSON.stringify(K));localStorage.setItem("cli-proxy-auth",JSON.stringify({{"state":{{"apiBase":B,"managementKey":K,"rememberPassword":true,"serverVersion":null,"serverBuildDate":null,"supportsPlugin":false,"sessionMode":"manager_embedded","sessionPanelBase":B,"connectionStatus":"disconnected","connectionError":null}},"version":0}}));}})();</script>"#,
        escaped_key, CPAMP_PORT
    );

    // 在 <head> 后注入脚本
    let patched_html = if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{}", inject_script), 1)
    } else if html.contains("<html") {
        if let Some(pos) = html.find("<html") {
            if let Some(end) = html[pos..].find('>') {
                let insert_pos = pos + end + 1;
                format!("{}{}{}", &html[..insert_pos], inject_script, &html[insert_pos..])
            } else {
                format!("{}{}", inject_script, html)
            }
        } else {
            format!("{}{}", inject_script, html)
        }
    } else {
        format!("{}{}", inject_script, html)
    };

    fs::write(&patched_path, patched_html.as_bytes())
        .map_err(|e| format!("写入 management-auto.html 失败: {}", e))
}

/// 部署/启动成功后自动将 CPA 添加为内置本地供应商（固定 id，排在 AnyBridge 后由前端处理）。
fn auto_add_cpa_provider(api_key: &str) -> Result<(), String> {
    use crate::commands::config::{
        read_provider_store, write_provider_store, ApiFormat, Provider, ProviderCapabilities,
    };

    let mut store = read_provider_store()?;
    let cpa_host = "http://127.0.0.1:8317";
    let cpa_id = "cpa-local";
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("CPA API Key 为空，无法添加供应商。".into());
    }

    // 已有固定 id：同步 host / key / 路径
    if let Some(existing) = store.providers.iter_mut().find(|p| p.id == cpa_id) {
        existing.name = "CPA".into();
        existing.api_host = cpa_host.into();
        existing.api_key = api_key.to_string();
        if existing.api_path.as_deref().unwrap_or("").trim().is_empty() {
            existing.api_path = Some("/v1".into());
        }
        existing.enabled = true;
        return write_provider_store(&store);
    }

    // 兼容旧版自动添加的 p-cpa-local*：升级为固定 id（不按 host 匹配，避免劫持用户自建供应商）
    if let Some(existing) = store
        .providers
        .iter_mut()
        .find(|p| p.id.starts_with("p-cpa-local"))
    {
        existing.id = cpa_id.into();
        existing.name = "CPA".into();
        existing.api_host = cpa_host.into();
        existing.api_key = api_key.to_string();
        if existing.api_path.as_deref().unwrap_or("").trim().is_empty() {
            existing.api_path = Some("/v1".into());
        }
        existing.enabled = true;
        return write_provider_store(&store);
    }

    let provider = Provider {
        id: cpa_id.into(),
        name: "CPA".into(),
        api_host: cpa_host.into(),
        api_key: api_key.to_string(),
        api_path: Some("/v1".into()),
        default_model: String::new(),
        api_format: ApiFormat::Openai,
        enabled: true,
        models: Vec::new(),
        capabilities: ProviderCapabilities::default(),
        model_caps: std::collections::HashMap::new(),
        unlocks: Default::default(),
        wire_api: String::new(),
        route_through_proxy: true,
        inject_models: true,
        preserve_official_auth: false,
        unify_session_history: true,
        model_catalog: Vec::new(),
        codex_chat_reasoning: None,
        agents_config: None,
        agents: Vec::new(),
    };

    // 尽量插到列表前部（前端仍会把 AnyBridge 置顶、CPA 紧随其后）
    store.providers.insert(0, provider);
    write_provider_store(&store)
}

fn remove_cpa_provider() -> Result<(), String> {
    use crate::commands::config::{read_provider_store, write_provider_store};
    let mut store = read_provider_store()?;
    let before = store.providers.len();
    // 只删系统自动管理的 CPA 条目，不按 host 误删用户自建供应商
    store.providers.retain(|p| p.id != "cpa-local" && !p.id.starts_with("p-cpa-local"));
    if store.providers.len() != before {
        write_provider_store(&store)?;
    }
    Ok(())
}

fn write_secrets(root: &Path, secrets: &CpaSecrets) -> Result<(), String> {
    let json_str =
        serde_json::to_string_pretty(secrets).map_err(|e| format!("序列化 secrets 失败: {}", e))?;
    let target = root.join("secrets.json");
    super::write_atomic(&target, json_str.as_bytes())
        .map_err(|e| format!("写入 secrets.json 失败: {}", e))
}

fn write_installed_json(root: &Path, cpa_ver: &str, cpamp_ver: &str) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("创建目录失败: {}", e))?;
    let json = serde_json::json!({
        "schemaVersion": 1,
        "extensions": {
            "cpa-suite": {
                "enabled": true,
                "components": {
                    "cli-proxy-api": {
                        "version": cpa_ver,
                        "port": 8317,
                        "relativePath": format!("versions/CLIProxyAPI_{}", cpa_ver)
                    },
                    "cpa-manager-plus": {
                        "version": cpamp_ver,
                        "port": 18317,
                        "relativePath": format!("versions/cpa-manager-plus_v{}", cpamp_ver)
                    }
                }
            }
        }
    });
    let json_str = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("序列化 installed.json 失败: {}", e))?;
    super::write_atomic(&root.join("installed.json"), json_str.as_bytes())
        .map_err(|e| format!("写入 installed.json 失败: {}", e))
}

fn check_port_available(port: u16, label: &str) -> Result<(), String> {
    let probe = probe_http_port(port, "/", label);
    if probe.status != "stopped" {
        return Err(format!(
            "端口 {} 已被占用（{}）。请先停止占用该端口的服务再重试。",
            port, probe.detail
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_deploy_cpa_suite(
    app: AppHandle,
    install_dir: Option<String>,
) -> Result<ExtensionServiceStatus, String> {
    let current = scan_cpa_suite();
    if current.status == "running" {
        return Err("CPA 套件已在运行中。如需重新部署，请先停止服务。".into());
    }

    // 1. 检查端口可用性
    emit_deploy_progress(&app, "check", "检查端口可用性...", 2);
    check_port_available(CPA_PORT, "CLIProxyAPI")?;
    check_port_available(CPAMP_PORT, "CPA Manager Plus")?;

    // 2. 获取 GitHub 发布包
    emit_deploy_progress(&app, "fetch", "获取 GitHub 最新发布包...", 5);
    let (cpa_release, cpamp_release) = tokio::try_join!(
        fetch_release_with_assets("router-for-me/CLIProxyAPI"),
        fetch_release_with_assets("seakee/CPA-Manager-Plus")
    )?;

    let cpa_asset = find_platform_release_asset(&cpa_release.assets, "CLIProxyAPI")?;
    let cpamp_asset = find_platform_release_asset(&cpamp_release.assets, "CPA Manager Plus")?;

    let cpa_version = normalize_version(&cpa_release.tag_name);
    let cpamp_version = normalize_version(&cpamp_release.tag_name);

    let size_msg = |size: u64| -> String {
        if size > 1_000_000 {
            format!("{:.1} MB", size as f64 / 1_000_000.0)
        } else {
            format!("{} KB", size / 1000)
        }
    };

    let archive_suffix = |asset_name: &str| -> &str {
        let n = asset_name.to_lowercase();
        if n.ends_with(".tar.gz") {
            "tar.gz"
        } else if n.ends_with(".tgz") {
            "tgz"
        } else if n.ends_with(".zip") {
            "zip"
        } else {
            "bin"
        }
    };

    // 3. 下载 CPA
    emit_deploy_progress(
        &app,
        "download_cpa",
        &format!(
            "下载 CLIProxyAPI {} ({})...",
            cpa_version,
            size_msg(cpa_asset.size)
        ),
        10,
    );
    let cpa_archive = download_asset(
        &cpa_asset.browser_download_url,
        &format!(
            "anybridge_cpa_{}.{}",
            cpa_version,
            archive_suffix(&cpa_asset.name)
        ),
        &app,
        10,
        35,
    )
    .await?;

    // 4. 下载 CPAMP
    emit_deploy_progress(
        &app,
        "download_cpamp",
        &format!(
            "下载 CPA Manager Plus {} ({})...",
            cpamp_version,
            size_msg(cpamp_asset.size)
        ),
        40,
    );
    let cpamp_archive = download_asset(
        &cpamp_asset.browser_download_url,
        &format!(
            "anybridge_cpamp_{}.{}",
            cpamp_version,
            archive_suffix(&cpamp_asset.name)
        ),
        &app,
        40,
        60,
    )
    .await?;

    // 5. 准备目录
    let root = resolve_cpa_install_dir(install_dir);
    let versions = root.join("versions");
    persist_cpa_install_dir(&root)?;
    let cpa_dir = versions.join(format!("CLIProxyAPI_{}", cpa_version));
    let cpamp_dir = versions.join(format!("cpa-manager-plus_v{}", cpamp_version));

    // 6. 解压 CPA
    emit_deploy_progress(&app, "extract_cpa", "解压 CLIProxyAPI...", 65);
    {
        let dir = cpa_dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract_archive(&cpa_archive, &dir))
            .await
            .map_err(|e| e.to_string())??;
    }

    // 7. 解压 CPAMP
    emit_deploy_progress(&app, "extract_cpamp", "解压 CPA Manager Plus...", 70);
    {
        let dir = cpamp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract_archive(&cpamp_archive, &dir))
            .await
            .map_err(|e| e.to_string())??;
    }

    // 8. 生成密钥和配置
    emit_deploy_progress(&app, "config", "生成运行时配置和密钥...", 75);
    let secrets = CpaSecrets {
        admin_key: generate_random_key(24),
        management_key: generate_random_key(24),
        api_key: format!("sk-{}", generate_random_key(32)),
    };

    let cpa_dir_c = cpa_dir.clone();
    let root_c = root.clone();
    let mgmt_key = secrets.management_key.clone();
    let api_key = secrets.api_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_cpa_config(&cpa_dir_c, &mgmt_key, &api_key)?;
        write_secrets(&root_c, &secrets)?;
        write_installed_json(&root_c, &cpa_version, &cpamp_version)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 9. 确认可执行文件存在
    let cpa_exe = {
        let dir = cpa_dir.clone();
        tauri::async_runtime::spawn_blocking(move || find_exe_in_dir(&dir, "cli-proxy-api"))
            .await
            .map_err(|e| e.to_string())??
    };
    let cpamp_exe = {
        let dir = cpamp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || find_exe_in_dir(&dir, "cpa-manager-plus"))
            .await
            .map_err(|e| e.to_string())??
    };
    let cpamp_runtime = cpamp_exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("无法解析 CPAMP 运行目录: {}", cpamp_exe.display()))?;

    // 配置写到 exe 同目录（发布包常再套一层平台目录）
    {
        let runtime = cpamp_runtime.clone();
        tauri::async_runtime::spawn_blocking(move || write_cpamp_config(&runtime))
            .await
            .map_err(|e| e.to_string())??;
    }

    // 10. 启动 CPA
    emit_deploy_progress(&app, "start_cpa", "启动 CLIProxyAPI...", 82);
    let cpa_dir_start = cpa_dir.clone();
    tauri::async_runtime::spawn_blocking(move || start_service(&cpa_exe, &cpa_dir_start, &[]))
        .await
        .map_err(|e| e.to_string())??;

    // 11. 健康检查 CPA（/healthz 无需认证）
    emit_deploy_progress(&app, "health_cpa", "等待 CLIProxyAPI 就绪...", 85);
    wait_for_http(CPA_PORT, "/healthz", "CLIProxyAPI", 15).await?;

    // 12. 启动 CPAMP（先不带 PANEL_PATH，便于拉取内嵌面板）
    emit_deploy_progress(&app, "start_cpamp", "启动 CPA Manager Plus...", 92);
    let secrets_file = root.join("secrets.json");
    let secrets: CpaSecrets = serde_json::from_str(
        &fs::read_to_string(&secrets_file).map_err(|e| format!("无法读取 secrets.json: {}", e))?,
    )
    .map_err(|e| format!("解析 secrets.json 失败: {}", e))?;

    let cpamp_env = vec![
        ("CPA_MANAGER_ADMIN_KEY".into(), secrets.admin_key.clone()),
        ("CPA_UPSTREAM_URL".into(), "http://127.0.0.1:8317".into()),
        ("CPA_MANAGEMENT_KEY".into(), secrets.management_key.clone()),
    ];
    let cpamp_runtime_start = cpamp_runtime.clone();
    let cpamp_exe_start = cpamp_exe.clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_service(&cpamp_exe_start, &cpamp_runtime_start, &cpamp_env)
    })
    .await
    .map_err(|e| e.to_string())??;

    // 13. 健康检查 CPAMP
    emit_deploy_progress(&app, "health_cpamp", "等待 CPA Manager Plus 就绪...", 95);
    wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 10).await?;

    // 14. 注入自动登录补丁，并用 PANEL_PATH 重启以覆盖 /management.html
    emit_deploy_progress(&app, "patch_panel", "注入面板自动登录...", 97);
    let patch_dir = cpamp_runtime.clone();
    let patch_key = secrets.admin_key.clone();
    tauri::async_runtime::spawn_blocking(move || patch_cpamp_management_html(&patch_dir, &patch_key))
        .await
        .map_err(|e| e.to_string())??;

    if cpamp_panel_file(&cpamp_runtime).is_file() {
        emit_deploy_progress(&app, "patch_panel", "应用自动登录面板...", 98);
        kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
        tokio::time::sleep(Duration::from_secs(1)).await;
        let cpamp_env = cpamp_env_with_panel(&secrets, &cpamp_runtime);
        let runtime_restart = cpamp_runtime.clone();
        let exe_restart = cpamp_exe.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_service(&exe_restart, &runtime_restart, &cpamp_env)
        })
        .await
        .map_err(|e| e.to_string())??;
        wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 10).await?;
    }

    // 15. 自动添加 CPA 供应商到 providers.json
    emit_deploy_progress(&app, "add_provider", "添加 CPA 供应商...", 99);
    let provider_api_key = secrets.api_key.clone();
    tauri::async_runtime::spawn_blocking(move || auto_add_cpa_provider(&provider_api_key))
        .await
        .map_err(|e| e.to_string())??;

    emit_deploy_progress(&app, "done", "CPA 套件部署完成！", 100);

    Ok(scan_cpa_suite())
}

fn archive_suffix(asset_name: &str) -> &str {
    let n = asset_name.to_lowercase();
    if n.ends_with(".tar.gz") {
        "tar.gz"
    } else if n.ends_with(".tgz") {
        "tgz"
    } else if n.ends_with(".zip") {
        "zip"
    } else {
        "bin"
    }
}

fn size_msg(size: u64) -> String {
    if size > 1_000_000 {
        format!("{:.1} MB", size as f64 / 1_000_000.0)
    } else {
        format!("{} KB", size / 1000)
    }
}

/// 下载并解压指定版本的单个组件（若本地已有则跳过）
async fn ensure_component_version_installed(
    app: &AppHandle,
    component: &str,
    version: &str,
    repo: &str,
    dir_name: &str,
    base_percent: u8,
    end_percent: u8,
) -> Result<PathBuf, String> {
    let version = normalize_version(version);
    if let Some(existing) = match component {
        "cli-proxy-api" => find_component_install_version(component, parse_cli_version, &version),
        "cpa-manager-plus" => {
            find_component_install_version(component, parse_cpamp_version, &version)
        }
        _ => None,
    } {
        emit_deploy_progress(
            app,
            "extract",
            &format!("{} {} 已在本地，跳过下载", component, version),
            base_percent,
        );
        return Ok(existing.dir);
    }

    emit_deploy_progress(
        app,
        "fetch",
        &format!("获取 {} {} 发布包...", component, version),
        base_percent,
    );
    let release = fetch_release_with_assets_by_tag(repo, &version).await?;
    let asset = find_platform_release_asset(&release.assets, component)?;
    let resolved_version = normalize_version(&release.tag_name);

    emit_deploy_progress(
        app,
        "download",
        &format!(
            "下载 {} {} ({})...",
            component,
            resolved_version,
            size_msg(asset.size)
        ),
        base_percent.saturating_add(2),
    );
    let archive = download_asset(
        &asset.browser_download_url,
        &format!(
            "anybridge_{}_{}.{}",
            component.replace('-', "_"),
            resolved_version,
            archive_suffix(&asset.name)
        ),
        app,
        base_percent.saturating_add(2),
        end_percent.saturating_sub(5),
    )
    .await?;

    let root = current_cpa_install_root();
    let versions = root.join("versions");
    let target_dir = versions.join(dir_name.replace("{ver}", &resolved_version));
    emit_deploy_progress(
        app,
        "extract",
        &format!("解压 {} {}...", component, resolved_version),
        end_percent.saturating_sub(3),
    );
    {
        let dir = target_dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract_archive(&archive, &dir))
            .await
            .map_err(|e| e.to_string())??;
    }
    Ok(target_dir)
}

#[tauri::command]
pub async fn extension_install_cpa_version(
    app: AppHandle,
    cli_version: Option<String>,
    cpamp_version: Option<String>,
    restart: Option<bool>,
) -> Result<ExtensionServiceStatus, String> {
    let (pref_cli, pref_cpamp) = read_preferred_component_versions();
    let target_cli = cli_version
        .as_deref()
        .map(normalize_version)
        .filter(|v| !v.is_empty())
        .or(pref_cli.clone())
        .or_else(|| {
            find_component_install("cli-proxy-api", parse_cli_version).and_then(|i| i.version)
        });
    let target_cpamp = cpamp_version
        .as_deref()
        .map(normalize_version)
        .filter(|v| !v.is_empty())
        .or(pref_cpamp.clone())
        .or_else(|| {
            find_component_install("cpa-manager-plus", parse_cpamp_version).and_then(|i| i.version)
        });

    let target_cli =
        target_cli.ok_or_else(|| "请指定要安装的 CLIProxyAPI 版本。".to_string())?;
    let target_cpamp =
        target_cpamp.ok_or_else(|| "请指定要安装的 CPA Manager Plus 版本。".to_string())?;

    let was_running = {
        let suite = scan_cpa_suite();
        suite.status == "running" || suite.status == "degraded"
    };
    let should_restart = restart.unwrap_or(true);

    if was_running {
        emit_deploy_progress(&app, "check", "停止当前服务以安装指定版本...", 2);
        kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
        kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let root = current_cpa_install_root();
    fs::create_dir_all(root.join("versions")).map_err(|e| format!("创建 versions 目录失败: {}", e))?;
    persist_cpa_install_dir(&root)?;

    let cpa_dir = ensure_component_version_installed(
        &app,
        "cli-proxy-api",
        &target_cli,
        "router-for-me/CLIProxyAPI",
        "CLIProxyAPI_{ver}",
        8,
        45,
    )
    .await?;

    let cpamp_dir = ensure_component_version_installed(
        &app,
        "cpa-manager-plus",
        &target_cpamp,
        "seakee/CPA-Manager-Plus",
        "cpa-manager-plus_v{ver}",
        48,
        78,
    )
    .await?;

    emit_deploy_progress(&app, "config", "写入版本元数据与配置...", 82);

    // 保留已有 secrets；若无则生成（与首次部署一致）
    let secrets = if root.join("secrets.json").is_file() {
        read_cpa_secrets(&root)?
    } else {
        let s = CpaSecrets {
            admin_key: generate_random_key(24),
            management_key: generate_random_key(24),
            api_key: format!("sk-{}", generate_random_key(32)),
        };
        write_secrets(&root, &s)?;
        s
    };

    write_cpa_config(&cpa_dir, &secrets.management_key, &secrets.api_key)?;
    write_installed_json(&root, &target_cli, &target_cpamp)?;
    let _ = cpamp_dir;

    if should_restart {
        emit_deploy_progress(&app, "start", "启动选定版本...", 88);
        start_cpa_suite_async().await?;
        emit_deploy_progress(&app, "done", "版本安装并切换完成！", 100);
    } else {
        emit_deploy_progress(&app, "done", "版本已安装，未自动启动。", 100);
    }

    Ok(scan_cpa_suite())
}

// ═══════ 镜像源管理命令 ═══════

/// 测速结果项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSpeedResult {
    pub id: String,
    pub name: String,
    pub duration_ms: u64,
    pub success: bool,
}

#[tauri::command]
pub async fn extension_list_mirrors() -> Result<Vec<GithubMirror>, String> {
    Ok(load_mirrors())
}

#[tauri::command]
pub async fn extension_save_mirrors(mirrors: Vec<GithubMirror>) -> Result<(), String> {
    save_user_mirrors(&mirrors)
}

#[tauri::command]
pub async fn extension_speed_test_mirrors() -> Result<Vec<MirrorSpeedResult>, String> {
    // 使用一个稳定的 GitHub 仓库做测速（releases/latest 会 302 重定向，测的是真实延迟）
    let test_url = "https://github.com/git/git/releases/latest";
    let ranked = speed_test_mirrors(&test_url).await;
    Ok(ranked
        .into_iter()
        .map(|(m, d)| MirrorSpeedResult {
            id: m.id,
            name: m.name,
            duration_ms: d,
            success: d != u64::MAX,
        })
        .collect())
}
