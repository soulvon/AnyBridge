use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use super::*;

pub(super) fn cpa_settings_path() -> PathBuf {
    crate::commands::config::config_dir_path()
        .join("extensions")
        .join(CPA_SUITE_ID)
        .join("settings.json")
}

pub(super) fn default_cpa_install_root() -> PathBuf {
    // 使用 LocalAppData（Windows）/ ~/.local/share（Linux）/ ~/Library/Application Support（macOS）
    // 避免 Roaming 目录同步大体积二进制文件
    let base = dirs::data_local_dir().unwrap_or_else(|| crate::commands::config::config_dir_path());
    base.join("anybridge")
        .join("extensions")
        .join("services")
        .join(CPA_SUITE_ID)
}

pub(super) fn read_cpa_settings() -> CpaSettings {
    let path = cpa_settings_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(settings) = serde_json::from_str::<CpaSettings>(&content) {
            return settings;
        }
    }
    CpaSettings::default()
}

pub(super) fn write_cpa_settings(settings: &CpaSettings) -> Result<(), String> {
    let path = cpa_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())
}

pub(super) fn current_cpa_install_root() -> PathBuf {
    let settings = read_cpa_settings();
    if let Some(dir) = settings.install_dir {
        let dir = dir.trim();
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    default_cpa_install_root()
}

pub(super) fn is_cpa_auto_start_enabled() -> bool {
    read_cpa_settings().auto_start
}

pub(super) fn persist_cpa_install_dir(dir: &Path) -> Result<(), String> {
    let default = default_cpa_install_root();
    let mut settings = read_cpa_settings();
    settings.install_dir = if dir == default.as_path() {
        None
    } else {
        Some(path_text(dir))
    };
    write_cpa_settings(&settings)
}

pub(super) fn persist_cpa_auto_start(enabled: bool) -> Result<(), String> {
    let mut settings = read_cpa_settings();
    settings.auto_start = enabled;
    write_cpa_settings(&settings)
}

pub(super) fn normalize_cpa_proxy_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let lower = value.to_ascii_lowercase();
    if lower == "direct" || lower == "none" || lower == "off" {
        return Ok(String::new());
    }
    let with_scheme = if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{}", value)
    };
    let lower_scheme = with_scheme.to_ascii_lowercase();
    if !(lower_scheme.starts_with("http://")
        || lower_scheme.starts_with("https://")
        || lower_scheme.starts_with("socks5://")
        || lower_scheme.starts_with("socks5h://"))
    {
        return Err(
            "代理地址仅支持 http://、https://、socks5:// 或 socks5h:// 协议".into(),
        );
    }
    // 粗校验：scheme 后至少要有 host
    let rest = with_scheme.splitn(2, "://").nth(1).unwrap_or("").trim();
    if rest.is_empty() || rest.starts_with('/') {
        return Err("代理地址缺少主机名，例如 http://127.0.0.1:7890".into());
    }
    Ok(with_scheme)
}

pub(super) fn resolve_cpa_proxy_url(settings: &CpaSettings) -> Result<String, String> {
    match settings.proxy_mode {
        CpaProxyMode::Off => Ok(String::new()),
        CpaProxyMode::System => Ok(crate::commands::windows_user_proxy_url().unwrap_or_default()),
        CpaProxyMode::Custom => {
            let raw = settings
                .custom_proxy_url
                .as_deref()
                .unwrap_or("")
                .trim();
            if raw.is_empty() {
                return Err("自定义代理模式下请填写代理地址".into());
            }
            normalize_cpa_proxy_url(raw)
        }
    }
}

pub(super) fn yaml_escape_double_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

pub(super) fn active_cpa_config_path() -> Option<PathBuf> {
    find_component_install("cli-proxy-api", parse_cli_version).map(|item| item.dir.join("config.yaml"))
}

pub(super) fn read_cpa_config_proxy_url(config_path: &Path) -> Option<String> {
    let content = fs::read_to_string(config_path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("proxy-url:") {
            let value = rest.trim();
            if value.is_empty() || value == "\"\"" || value == "''" {
                return Some(String::new());
            }
            if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
                || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            {
                return Some(value[1..value.len() - 1].to_string());
            }
            return Some(value.to_string());
        }
    }
    None
}

pub(super) fn set_cpa_config_proxy_url(config_path: &Path, proxy_url: &str) -> Result<(), String> {
    if !config_path.is_file() {
        return Err(format!("CPA 配置不存在: {}", config_path.display()));
    }
    let content =
        fs::read_to_string(config_path).map_err(|e| format!("读取 CPA config.yaml 失败: {}", e))?;
    let escaped = yaml_escape_double_quoted(proxy_url);
    let replacement = format!("proxy-url: \"{}\"", escaped);
    let mut replaced = false;
    let mut lines: Vec<String> = content
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("proxy-url:") {
                replaced = true;
                let indent_len = line.len() - trimmed.len();
                format!("{}{}", &line[..indent_len], replacement)
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push(replacement);
    }
    let mut out = lines.join("\n");
    if content.ends_with('\n') {
        out.push('\n');
    }
    crate::commands::write_atomic(config_path, out.as_bytes())
        .map_err(|e| format!("写入 CPA config.yaml 失败: {}", e))
}

/// 将当前设置解析出的代理写入活动版本 config.yaml（若已安装）。
pub(super) fn sync_active_cpa_proxy_config() -> Result<(Option<PathBuf>, String), String> {
    let settings = read_cpa_settings();
    let proxy_url = resolve_cpa_proxy_url(&settings)?;
    let Some(config_path) = active_cpa_config_path() else {
        return Ok((None, proxy_url));
    };
    set_cpa_config_proxy_url(&config_path, &proxy_url)?;
    Ok((Some(config_path), proxy_url))
}

pub(super) fn is_cpa_suite_running() -> bool {
    let cli = probe_http_port(CPA_PORT, "/healthz", "CLIProxyAPI");
    let cpamp = probe_http_port(CPAMP_PORT, "/health", "CPA Manager Plus");
    cli.status == "running" || cpamp.status == "running"
}

pub(super) fn build_cpa_proxy_settings_view() -> Result<CpaProxySettingsView, String> {
    let settings = read_cpa_settings();
    let system_url = crate::commands::windows_user_proxy_url();
    let effective_url = resolve_cpa_proxy_url(&settings)?;
    let config_path = active_cpa_config_path();
    let applied_url = config_path
        .as_ref()
        .and_then(|p| read_cpa_config_proxy_url(p));
    let suite_running = is_cpa_suite_running();
    let needs_restart = suite_running
        && applied_url
            .as_ref()
            .map(|applied| applied != &effective_url)
            .unwrap_or(true);
    Ok(CpaProxySettingsView {
        mode: settings.proxy_mode.as_str().to_string(),
        custom_url: settings.custom_proxy_url.unwrap_or_default(),
        system_url,
        effective_url,
        applied_url,
        config_path: config_path.map(|p| path_text(&p)),
        needs_restart,
        suite_running,
    })
}

pub(super) fn persist_cpa_proxy_settings(mode: CpaProxyMode, custom_url: Option<String>) -> Result<(), String> {
    let mut settings = read_cpa_settings();
    settings.proxy_mode = mode;
    settings.custom_proxy_url = match custom_url {
        Some(raw) => {
            let normalized = normalize_cpa_proxy_url(&raw)?;
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
        None => settings.custom_proxy_url.take().and_then(|s| {
            normalize_cpa_proxy_url(&s)
                .ok()
                .filter(|v| !v.is_empty())
        }),
    };
    // custom 模式必须能解析出有效 URL
    let _ = resolve_cpa_proxy_url(&settings)?;
    write_cpa_settings(&settings)?;
    let _ = sync_active_cpa_proxy_config()?;
    Ok(())
}

pub(super) fn resolve_cpa_install_dir(install_dir: Option<String>) -> PathBuf {
    if let Some(dir) = install_dir {
        let dir = dir.trim();
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    current_cpa_install_root()
}

pub(super) fn find_component_child_dir_with_preferred(
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

pub(super) fn is_cli_proxy_api_dir(name: &str) -> bool {
    name.starts_with("CLIProxyAPI_")
}

pub(super) fn is_cpamp_dir(name: &str) -> bool {
    name.starts_with("cpa-manager-plus")
}

pub(super) fn parse_cli_version(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    name.strip_prefix("CLIProxyAPI_")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn parse_cpamp_version(path: &Path) -> Option<String> {
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

pub(super) fn component_search_roots() -> Vec<(PathBuf, &'static str)> {
    let managed = current_cpa_install_root();
    vec![
        (managed.clone(), "AnyBridge 托管目录"),
        (managed.join("versions"), "AnyBridge 托管版本目录"),
    ]
}

/// 从 installed.json 读取当前激活的组件版本（用于多版本并存时的优先选择）
pub(super) fn read_preferred_component_versions() -> (Option<String>, Option<String>) {
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

pub(super) fn find_component_install(
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

pub(super) fn find_component_install_version(
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

pub(super) fn probe_http_port(port: u16, path: &str, label: &str) -> HttpProbe {
    probe_http_port_with_key(port, path, label, None)
}

pub(super) fn probe_http_port_with_key(port: u16, path: &str, label: &str, mgmt_key: Option<&str>) -> HttpProbe {
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

pub(super) fn component_status(
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

pub(super) fn summarize_cpa_version(
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

pub(super) fn scan_cpa_suite() -> ExtensionServiceStatus {
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

