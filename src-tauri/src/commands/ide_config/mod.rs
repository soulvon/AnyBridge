use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

const PROXY_KEY: &str = "http.proxy";
const STRICT_SSL_KEY: &str = "http.proxyStrictSSL";
const PROXY_SUPPORT_KEY: &str = "http.proxySupport";
const SYSTEM_CERTS_V2_KEY: &str = "http.experimental.systemCertificatesV2";
const USE_HTTP1_KEY: &str = "cursor.general.useHttp1";
const DISABLE_HTTP2_KEY: &str = "cursor.general.disableHttp2";
const PROXY_KERBEROS_KEY: &str = "http.proxyKerberosServicePrincipal";
const LEGACY_CURSOR_PROXY_KEYS: &[&str] = &["systemCertificatesV2", "useHttp1", "disableHttp2"];
const DEVIN_AGENT_ENV_KEY: &str = "devin.acp.agentEnv";
const WINDSURF_AGENT_ENV_KEY: &str = "windsurf.acp.agentEnv";
const DEVIN_PREFERRED_AGENT_KEY: &str = "devin.acp.preferredAgent";
const DEVIN_CLI_PROCESS_MODEL_KEY: &str = "process_model";
const DEVIN_CLI_PROCESS_MODEL_VALUE: &str = "in-process";
// NO_PROXY 排除直连域名：只排除真正需要绕过本地网关的 devin 官方 API 域名。
// 注意：不能把 unleash.codeium.com（feature flag 域名）加入 NO_PROXY，
// 该域名在某些网络环境下直连超时，会导致 devin-cli 启动时
// "remote config revalidation failed: operation timed out" 警告并拖慢 1~2s。
// 走 AnyBridge 内置供应商反而更快（网关有上游翻墙通道）。
const DEVIN_AGENT_NO_PROXY: &str =
    "api.devin.ai,app.devin.ai,static.devin.ai,cli.devin.ai,devin.ai";

/// MITM CA 根证书路径。新版 devin-cli（rustls-native-certs 0.8）在 Windows 上
/// 对 SSL_CERT_FILE 采用「平台证书库 + 该文件」合并语义：带上它可确保
/// server.codeium.com 的 MITM 链受信，同时不影响直连域名的公签校验。
fn devin_cert_path() -> PathBuf {
    crate::commands::config::config_dir_path()
        .join("certs")
        .join("server.codeium.com.pem")
}

fn devin_agent_env_ok(obj: &Map<String, Value>) -> bool {
    let check_map = |key: &str| -> bool {
        let Some(Value::Object(env_map)) = obj.get(key) else {
            return false;
        };
        let Some(Value::Object(cli_env)) = env_map.get("devin-cli") else {
            return false;
        };
        let proxy_ok = cli_env
            .get("HTTP_PROXY")
            .and_then(|v| v.as_str())
            .map(is_current_proxy_value)
            .unwrap_or(false);
        let https_proxy_ok = cli_env
            .get("HTTPS_PROXY")
            .and_then(|v| v.as_str())
            .map(is_current_proxy_value)
            .unwrap_or(false);
        // SSL_CERT_FILE 与 NO_PROXY 必须精确匹配当前配置：旧补丁缺失任一项时，
        // status 应返回未完成，让再次接入自动补齐，而不是误判为已接入。
        let expected_cert = devin_cert_path().to_string_lossy().to_string();
        let cert_ok = cli_env
            .get("SSL_CERT_FILE")
            .and_then(|v| v.as_str())
            .map(|s| s == expected_cert)
            .unwrap_or(false);
        let no_proxy_ok = cli_env
            .get("NO_PROXY")
            .and_then(|v| v.as_str())
            == Some(DEVIN_AGENT_NO_PROXY);
        proxy_ok && https_proxy_ok && cert_ok && no_proxy_ok
    };
    check_map(DEVIN_AGENT_ENV_KEY) || check_map(WINDSURF_AGENT_ENV_KEY)
}

fn devin_settings_ok(obj: &Map<String, Value>) -> bool {
    devin_agent_env_ok(obj)
        && obj.get(PROXY_SUPPORT_KEY).and_then(|v| v.as_str())
            == Some(PROXY_SUPPORT_OVERRIDE_VALUE)
}

pub(crate) fn devin_cli_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        dirs::config_dir().map(|d| d.join("devin").join("config.json"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".config")))?;
        Some(base.join("devin").join("config.json"))
    }
}

fn devin_cli_config_ok_at(cli_cfg: &PathBuf) -> bool {
    let Ok(raw) = fs::read_to_string(cli_cfg) else {
        return false;
    };
    let Ok(obj) = parse_object_with_label(&raw, "devin config.json") else {
        return false;
    };
    obj.get(DEVIN_CLI_PROCESS_MODEL_KEY)
        .and_then(|v| v.as_str())
        == Some(DEVIN_CLI_PROCESS_MODEL_VALUE)
}

/// 接入 Devin CLI `config.json`：写入 `"process_model": "in-process"`，
/// 防止新版 `devin.exe` 默认拉起后台 daemon 从而绕过 `devin.acp.agentEnv` 与 `http.proxy`。
fn patch_devin_cli_config_file(cli_cfg: &PathBuf) -> Result<bool, String> {
    let backup = backup_path(cli_cfg);
    let raw = if cli_cfg.exists() {
        fs::read_to_string(cli_cfg).map_err(|e| e.to_string())?
    } else {
        let Some(parent) = cli_cfg.parent() else {
            return Err("devin config.json 路径无父目录".into());
        };
        fs::create_dir_all(parent).map_err(|e| format!("创建 Devin CLI 配置目录失败: {e}"))?;
        "{}\n".to_string()
    };
    let mut obj = parse_object_with_label(&raw, "devin config.json")?;
    if obj
        .get(DEVIN_CLI_PROCESS_MODEL_KEY)
        .and_then(|v| v.as_str())
        == Some(DEVIN_CLI_PROCESS_MODEL_VALUE)
    {
        return Ok(false);
    }
    if !backup.exists() {
        super::write_atomic(&backup, raw.as_bytes()).map_err(|e| format!("备份失败: {e}"))?;
    }
    obj.insert(
        DEVIN_CLI_PROCESS_MODEL_KEY.into(),
        Value::String(DEVIN_CLI_PROCESS_MODEL_VALUE.into()),
    );
    write_object(cli_cfg, &obj)?;
    Ok(true)
}

/// 对称还原 Devin CLI `config.json` 的 `process_model` 字段，保留其余用户改动。
/// 无备份时不做破坏性删除（避免误删用户原本手动写的 `"in-process"`）。
fn restore_devin_cli_config_file(cli_cfg: &PathBuf) -> Result<bool, String> {
    let backup = backup_path(cli_cfg);
    if !cli_cfg.exists() {
        let _ = fs::remove_file(&backup);
        return Ok(false);
    }
    if !backup.exists() {
        return Ok(false);
    }
    let backup_raw = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
    let orig = parse_object_with_label(&backup_raw, "devin config.json 备份")?;
    let raw = fs::read_to_string(cli_cfg).map_err(|e| e.to_string())?;
    let mut current = parse_object_with_label(&raw, "devin config.json")?;
    match orig.get(DEVIN_CLI_PROCESS_MODEL_KEY) {
        Some(v) => {
            current.insert(DEVIN_CLI_PROCESS_MODEL_KEY.into(), v.clone());
        }
        None => {
            current.remove(DEVIN_CLI_PROCESS_MODEL_KEY);
        }
    }
    write_object(cli_cfg, &current)?;
    let _ = fs::remove_file(&backup);
    Ok(true)
}

fn patch_devin_agent_env(obj: &mut Map<String, Value>, proxy_value: &str) {
    let cert_str = devin_cert_path().to_string_lossy().to_string();
    for key in [DEVIN_AGENT_ENV_KEY, WINDSURF_AGENT_ENV_KEY] {
        let env_obj = match obj.remove(key) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let mut new_env_obj = env_obj;
        let mut cli_obj = match new_env_obj.remove("devin-cli") {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        cli_obj.insert("HTTP_PROXY".into(), Value::String(proxy_value.to_string()));
        cli_obj.insert("HTTPS_PROXY".into(), Value::String(proxy_value.to_string()));
        // 辅助域名（feature flag / 云端 web / 下载）直连，不走本地网关：
        // 新版 devin-cli authenticate 时会并发刷新这些域名，超时上限仅 2s，
        // 全部挤过网关会触发 "ZDR status refresh timed out on auth" 导致接入失败。
        cli_obj.insert("NO_PROXY".into(), Value::String(DEVIN_AGENT_NO_PROXY.into()));
        if !cert_str.is_empty() {
            cli_obj.insert("SSL_CERT_FILE".into(), Value::String(cert_str.clone()));
        }
        cli_obj.insert(
            "WINDSURF_API_SERVER_URL".into(),
            Value::String("https://server.codeium.com".to_string()),
        );
        new_env_obj.insert("devin-cli".into(), Value::Object(cli_obj));
        obj.insert(key.into(), Value::Object(new_env_obj));
    }
}

fn remove_devin_agent_env(obj: &mut Map<String, Value>) {
    for key in [DEVIN_AGENT_ENV_KEY, WINDSURF_AGENT_ENV_KEY] {
        let Some(Value::Object(mut env_obj)) = obj.remove(key) else {
            continue;
        };
        if let Some(Value::Object(mut cli_obj)) = env_obj.remove("devin-cli") {
            cli_obj.remove("HTTP_PROXY");
            cli_obj.remove("HTTPS_PROXY");
            cli_obj.remove("NO_PROXY");
            cli_obj.remove("SSL_CERT_FILE");
            cli_obj.remove("WINDSURF_API_SERVER_URL");
            if !cli_obj.is_empty() {
                env_obj.insert("devin-cli".into(), Value::Object(cli_obj));
            }
        }
        if !env_obj.is_empty() {
            obj.insert(key.into(), Value::Object(env_obj));
        }
    }
}
fn configured_proxy_port() -> u16 {
    crate::commands::config::configured_proxy_ports().api_port
}

pub(crate) fn proxy_value_for_port(port: u16) -> String {
    format!("http://localhost:{}", port)
}

pub(crate) fn current_proxy_value() -> String {
    proxy_value_for_port(configured_proxy_port())
}

pub(crate) fn is_current_proxy_value(value: &str) -> bool {
    let port = configured_proxy_port();
    value == proxy_value_for_port(port) || value == format!("http://127.0.0.1:{}", port)
}

fn is_known_anybridge_proxy_value(value: &str) -> bool {
    is_current_proxy_value(value)
        || value == proxy_value_for_port(crate::commands::config::DEFAULT_PROXY_PORT)
        || value
            == format!(
                "http://127.0.0.1:{}",
                crate::commands::config::DEFAULT_PROXY_PORT
            )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeProxyStatus {
    pub target: String,
    pub patched: bool,
    pub proxy_value: String,
    pub strict_ssl: Option<bool>,
    pub settings_path: String,
    /// 客户端版本（读 product.json，注册表定位安装目录）；
    /// None = 未安装或版本未知（读失败=未知，不编造）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// 根据目标 IDE 获取 settings.json 路径
pub(crate) fn settings_path(target: &str) -> Option<PathBuf> {
    let ide_name = match target {
        "devin" => "Devin",
        "cursor" => "Cursor",
        _ => "Windsurf",
    };

    // macOS: VSCode 系 IDE 的配置在 ~/Library/Application Support/{IDE}/User/settings.json
    // dirs::config_dir() 在 macOS 返回 ~/Library/Preferences（错误），
    // 需要用 dirs::data_dir() 返回 ~/Library/Application Support
    #[cfg(target_os = "macos")]
    let mut dir = dirs::data_dir()?;

    // Windows/Linux: dirs::config_dir() 正确
    #[cfg(not(target_os = "macos"))]
    let mut dir = dirs::config_dir()?;

    dir.push(ide_name);
    dir.push("User");
    dir.push("settings.json");
    Some(dir)
}

fn managed_proxy_keys(target: &str) -> Vec<&'static str> {
    let mut keys = vec![PROXY_KEY, STRICT_SSL_KEY];
    if target == "cursor" {
        keys.extend([
            PROXY_SUPPORT_KEY,
            SYSTEM_CERTS_V2_KEY,
            USE_HTTP1_KEY,
            DISABLE_HTTP2_KEY,
            PROXY_KERBEROS_KEY,
        ]);
    } else if target == "devin" {
        keys.extend([
            PROXY_SUPPORT_KEY,
            DEVIN_AGENT_ENV_KEY,
            WINDSURF_AGENT_ENV_KEY,
            DEVIN_PREFERRED_AGENT_KEY,
        ]);
    }
    keys
}

/// 与 cursor-core/src/local_app/settings.rs 的 MANAGED_PROXY_SUPPORT 必须一致：
/// `on` 的语义是"使用代理设置"，系统代理存在时会绕开我们的 http.proxy；
/// `override` 才强制走本地网关（坑点 cursor-proxy-support-override）。
const PROXY_SUPPORT_OVERRIDE_VALUE: &str = "override";

fn cursor_extra_settings_ok(obj: &Map<String, Value>) -> bool {
    // 不强制 useHttp1：cursor-core 接入路径只写 disableHttp2，
    // 强判 useHttp1 会让"已接入"显示成未接入。
    obj.get(PROXY_SUPPORT_KEY).and_then(|v| v.as_str()) == Some(PROXY_SUPPORT_OVERRIDE_VALUE)
        && obj.get(SYSTEM_CERTS_V2_KEY) == Some(&Value::Bool(true))
        && obj.get(DISABLE_HTTP2_KEY) == Some(&Value::Bool(true))
        && obj
            .get(PROXY_KERBEROS_KEY)
            .and_then(|v| v.as_str())
            .map(is_current_proxy_value)
            .unwrap_or(false)
}

fn remove_cursor_proxy_keys(obj: &mut Map<String, Value>) {
    for key in managed_proxy_keys("cursor")
        .into_iter()
        .chain(LEGACY_CURSOR_PROXY_KEYS.iter().copied())
    {
        obj.remove(key);
    }
}

fn strip_managed_proxy_for_backup(target: &str, obj: &Map<String, Value>) -> Map<String, Value> {
    let mut orig = obj.clone();
    if target == "cursor" {
        remove_cursor_proxy_keys(&mut orig);
    } else if target == "devin" {
        for key in managed_proxy_keys(target) {
            orig.remove(key);
        }
        remove_devin_agent_env(&mut orig);
    } else {
        for key in managed_proxy_keys(target) {
            orig.remove(key);
        }
    }
    orig
}

fn write_stripped_backup(
    target: &str,
    obj: &Map<String, Value>,
    backup: &PathBuf,
) -> Result<(), String> {
    let orig = strip_managed_proxy_for_backup(target, obj);
    let orig_json =
        serde_json::to_string_pretty(&Value::Object(orig)).map_err(|e| e.to_string())?;
    super::write_atomic(backup, orig_json.as_bytes()).map_err(|e| format!("补建备份失败: {}", e))
}

fn backup_path(settings: &PathBuf) -> PathBuf {
    let mut p = settings.clone();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".into());
    p.set_file_name(format!("{}.byok-bak", name));
    p
}

/// 按给定配置文件标签容错解析 JSON/JSONC，返回顶层对象
fn parse_object_with_label(raw: &str, label: &str) -> Result<Map<String, Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = json5::from_str(trimmed).map_err(|e| format!("{label} 解析失败: {e}"))?;
    match value {
        Value::Object(m) => Ok(m),
        _ => Err(format!("{label} 顶层不是对象")),
    }
}

/// 容错解析（支持注释/尾逗号），返回顶层对象
pub(crate) fn parse_object(raw: &str) -> Result<Map<String, Value>, String> {
    parse_object_with_label(raw, "settings.json")
}

fn write_object(path: &PathBuf, obj: &Map<String, Value>) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())
}

/// 确保 settings.json 存在。VS Code 系 IDE 会接受预先创建的 User/settings.json，
/// 这样首次安装但尚未生成配置文件的用户也能一键启动网关。
pub(crate) fn ensure_settings_file(target: &str) -> Result<(PathBuf, bool), String> {
    let Some(settings) = settings_path(target) else {
        return Err(format!("无法定位 {} 配置目录", target));
    };
    let created = ensure_settings_path(&settings)?;
    Ok((settings, created))
}

fn ensure_settings_path(settings: &PathBuf) -> Result<bool, String> {
    if settings.exists() {
        return Ok(false);
    }
    let Some(parent) = settings.parent() else {
        return Err("settings.json 路径无父目录".into());
    };
    fs::create_dir_all(parent).map_err(|e| format!("创建 IDE 配置目录失败: {}", e))?;
    super::write_atomic(&settings, b"{}\n")
        .map_err(|e| format!("创建 settings.json 失败: {}", e))?;
    Ok(true)
}

/// 打补丁：备份原文件（幂等），写入网关接入配置。
/// 返回是否实际改动了 IDE 配置（用于 UI 提示是否需重启）。
pub fn patch(target: &str) -> Result<bool, String> {
    let (settings, _) = ensure_settings_file(target)?;
    let changed_settings = patch_settings_file(target, &settings)?;
    let changed_cli = if target == "devin" {
        if let Some(cli_cfg) = devin_cli_config_path() {
            patch_devin_cli_config_file(&cli_cfg)?
        } else {
            false
        }
    } else {
        false
    };
    Ok(changed_settings || changed_cli)
}

fn patch_settings_file(target: &str, settings: &PathBuf) -> Result<bool, String> {
    ensure_settings_path(settings)?;

    let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
    let mut obj = parse_object(&raw)?;

    let backup = backup_path(&settings);

    // 已是目标配置则无需改写。但若备份缺失（崩溃/强杀导致备份被删而补丁残留），
    // 必须补建备份，否则还原直连时 restore 会空操作，补丁永远删不掉 → IDE 断网。
    let proxy_value = current_proxy_value();
    let already = obj
        .get(PROXY_KEY)
        .and_then(|v| v.as_str())
        .map(is_current_proxy_value)
        .unwrap_or(false)
        && obj.get(STRICT_SSL_KEY) == Some(&Value::Bool(false))
        && (target != "cursor" || cursor_extra_settings_ok(&obj))
        && (target != "devin" || devin_settings_ok(&obj));
    if already {
        if !backup.exists() {
            // 原始值已被补丁覆盖、无从恢复，备份成「移除受管网关键」的状态，作为还原目标。
            write_stripped_backup(target, &obj, &backup)?;
        }
        return Ok(false);
    }

    // 幂等备份：仅当备份不存在时写入；若当前已是已知网关地址（如无备份的旧补丁升级），
    // 则先剥离受管网关字段再写备份，避免把网关地址当成用户原值导致还原残留。
    if !backup.exists() {
        let proxy_is_anybridge = obj
            .get(PROXY_KEY)
            .and_then(|v| v.as_str())
            .map(is_known_anybridge_proxy_value)
            .unwrap_or(false);
        if proxy_is_anybridge {
            write_stripped_backup(target, &obj, &backup)?;
        } else {
            super::write_atomic(&backup, raw.as_bytes()).map_err(|e| format!("备份失败: {}", e))?;
        }
    }

    obj.insert(PROXY_KEY.into(), Value::String(proxy_value.clone()));
    obj.insert(STRICT_SSL_KEY.into(), Value::Bool(false));
    if target == "cursor" {
        obj.insert(
            PROXY_SUPPORT_KEY.into(),
            Value::String(PROXY_SUPPORT_OVERRIDE_VALUE.into()),
        );
        obj.insert(SYSTEM_CERTS_V2_KEY.into(), Value::Bool(true));
        obj.insert(USE_HTTP1_KEY.into(), Value::Bool(true));
        obj.insert(DISABLE_HTTP2_KEY.into(), Value::Bool(true));
        obj.insert(PROXY_KERBEROS_KEY.into(), Value::String(proxy_value));
        for key in LEGACY_CURSOR_PROXY_KEYS {
            obj.remove(*key);
        }
    } else if target == "devin" {
        obj.insert(
            PROXY_SUPPORT_KEY.into(),
            Value::String(PROXY_SUPPORT_OVERRIDE_VALUE.into()),
        );
        patch_devin_agent_env(&mut obj, &proxy_value);
        // 首次接入时锁定默认 Agent 为 Devin Local，防止新版 ACP Registry
        // 5s 超时导致前端回退到其他 Agent（qoder/claude 等）再切回来的抖动。
        // 只在用户尚未自行设置时写入；已有值则尊重用户选择不覆盖。
        if !obj.contains_key(DEVIN_PREFERRED_AGENT_KEY) {
            obj.insert(
                DEVIN_PREFERRED_AGENT_KEY.into(),
                Value::String("devin-cli".into()),
            );
        }
    }
    write_object(&settings, &obj)?;
    Ok(true)
}

/// 卸补丁：依据备份还原 http.proxy / http.proxyStrictSSL，再删除备份。
/// 无备份时，直接移除网关相关键（兜底清理，防止网关配置残留导致 IDE 断网）。
/// 幂等。
pub fn restore(target: &str) -> Result<bool, String> {
    let restored_settings = match settings_path(target) {
        Some(settings) => restore_settings_file(target, &settings)?,
        None => false,
    };
    let restored_cli = if target == "devin" {
        if let Some(cli_cfg) = devin_cli_config_path() {
            restore_devin_cli_config_file(&cli_cfg)?
        } else {
            false
        }
    } else {
        false
    };
    Ok(restored_settings || restored_cli)
}

fn restore_settings_file(target: &str, settings: &PathBuf) -> Result<bool, String> {
    if !settings.exists() {
        return Ok(false);
    }

    let backup = backup_path(&settings);

    if backup.exists() {
        // 有备份：按备份还原，保留其余用户改动。
        let backup_raw = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
        let orig = parse_object(&backup_raw)?;

        let mut current = {
            let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
            parse_object(&raw)?
        };

        for key in managed_proxy_keys(target) {
            match orig.get(key) {
                Some(v) => {
                    current.insert(key.into(), v.clone());
                }
                None => {
                    current.remove(key);
                }
            }
        }
        if target == "cursor" {
            for key in LEGACY_CURSOR_PROXY_KEYS {
                current.remove(*key);
            }
        }

        write_object(&settings, &current)?;
        let _ = fs::remove_file(&backup);
        Ok(true)
    } else {
        // 无备份：兜底清理——直接移除网关相关键，防止残留导致 IDE 断网。
        let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
        let mut current = parse_object(&raw)?;

        let had_proxy = current
            .get(PROXY_KEY)
            .and_then(|v| v.as_str())
            .map(is_known_anybridge_proxy_value)
            .unwrap_or(false);
        let had_ssl = current.get(STRICT_SSL_KEY) == Some(&Value::Bool(false));
        let had_devin_env = target == "devin"
            && (devin_agent_env_ok(&current)
                || current.get(PROXY_SUPPORT_KEY).and_then(|v| v.as_str())
                    == Some(PROXY_SUPPORT_OVERRIDE_VALUE));

        if !had_proxy && !had_ssl && !had_devin_env {
            // 配置中没有网关残留，无需操作。
            return Ok(false);
        }

        if had_proxy {
            current.remove(PROXY_KEY);
        }
        if had_ssl {
            current.remove(STRICT_SSL_KEY);
        }
        if target == "cursor" {
            remove_cursor_proxy_keys(&mut current);
        } else if target == "devin" {
            if current.get(PROXY_SUPPORT_KEY).and_then(|v| v.as_str())
                == Some(PROXY_SUPPORT_OVERRIDE_VALUE)
            {
                current.remove(PROXY_SUPPORT_KEY);
            }
            remove_devin_agent_env(&mut current);
        }

        write_object(&settings, &current)?;
        Ok(true)
    }
}

pub fn status(target: &str) -> Result<IdeProxyStatus, String> {
    let Some(settings) = settings_path(target) else {
        return Ok(IdeProxyStatus {
            target: target.to_string(),
            patched: false,
            proxy_value: String::new(),
            strict_ssl: None,
            settings_path: String::new(),
            version: None,
        });
    };
    if !settings.exists() {
        return Ok(IdeProxyStatus {
            target: target.to_string(),
            patched: false,
            proxy_value: String::new(),
            strict_ssl: None,
            settings_path: settings.to_string_lossy().to_string(),
            version: None,
        });
    }
    let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
    let obj = parse_object(&raw)?;
    let proxy_value = obj
        .get(PROXY_KEY)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let strict_ssl = obj.get(STRICT_SSL_KEY).and_then(|v| v.as_bool());
    Ok(IdeProxyStatus {
        target: target.to_string(),
        patched: is_current_proxy_value(&proxy_value)
            && strict_ssl == Some(false)
            && (target != "cursor" || cursor_extra_settings_ok(&obj))
            && (target != "devin"
                || (devin_settings_ok(&obj)
                    && devin_cli_config_path()
                        .as_ref()
                        .map(devin_cli_config_ok_at)
                        .unwrap_or(false))),
        proxy_value,
        strict_ssl,
        settings_path: settings.to_string_lossy().to_string(),
        version: super::version_probe::installed_gui_version(target),
    })
}
// ═══════ TAURI COMMANDS ═══════

/// 打补丁（向后兼容：默认 IDE）
#[tauri::command]
pub fn patch_ide_config() -> Result<bool, String> {
    patch("windsurf")
}

/// 打补丁（支持目标 IDE）
#[tauri::command]
pub fn patch_ide_settings(target: String) -> Result<bool, String> {
    patch(&target)
}

/// 卸补丁（向后兼容：默认 IDE）
#[tauri::command]
pub fn restore_ide_config() -> Result<bool, String> {
    restore("windsurf")
}

/// 卸补丁（支持目标 IDE）
#[tauri::command]
pub fn restore_ide_settings(target: String) -> Result<bool, String> {
    restore(&target)
}
/// async + spawn_blocking：status() 读 settings.json 并做进程探测，同步会阻塞 UI。
#[tauri::command]
pub async fn get_ide_proxy_status(target: String) -> Result<IdeProxyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&target))
        .await
        .map_err(|e| format!("状态查询任务执行失败: {e}"))?
}

#[cfg(test)]
mod tests;
