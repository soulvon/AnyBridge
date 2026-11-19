use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

use crate::commands::config::configured_proxy_ports;

/// 插件未声明端口、或配置里缺失端口时的兜底端口。
/// 刻意不选 8000：它是大量开发服务器（Django / Flask / 各类前端 dev server）
/// 的默认端口，插件默认占它会跟用户的日常开发撞车。
pub(super) const FALLBACK_PORT: u16 = 18763;

// ═══════════════════════════════════════════════════
// Data types
// ═══════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(rename = "apiVersion")]
    pub api_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub short: Option<String>,
    #[serde(default)]
    pub accent: Option<String>,
    pub description: String,
    pub version: String,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub runtime: serde_json::Value,
    pub health_check: serde_json::Value,
    pub config_schema: Vec<serde_json::Value>,
    pub capabilities: Vec<String>,
    pub panels: Vec<serde_json::Value>,
    pub deploy: serde_json::Value,
    #[serde(default)]
    pub upgrade: Option<serde_json::Value>,
    /// 插件自描述的访问凭证（扩展页卡片「访问凭证」区渲染用）。
    /// 结构由前端约定：[{ subtitle, rows: [{ label, value, copy }] }]，
    /// value 支持 {port} 与 {config.<key>} 占位符，由前端在渲染时填充。
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub credentials: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub plugin_id: String,
    pub state: String,
    pub install_path: Option<String>,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub started_at: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub status: PluginStatus,
}

// ═══════════════════════════════════════════════════
// Plugin manager state
// ═══════════════════════════════════════════════════

/// A running plugin child process. The `Child` handle is kept so the process can be
/// killed and reaped properly; `pid` is mirrored into status.json for cross-restart recovery.
pub struct PluginProcess {
    pub pid: u32,
    pub child: std::process::Child,
}

pub struct PluginState {
    pub processes: std::sync::Mutex<HashMap<String, PluginProcess>>,
}

impl PluginState {
    pub fn new() -> Self {
        Self {
            processes: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl Default for PluginState {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════
// Path helpers
// ═══════════════════════════════════════════════════

pub(super) fn plugins_dir() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("AnyBridge");
    p.push("plugins");
    p
}

pub(super) fn plugin_data_dir(plugin_id: &str) -> PathBuf {
    plugins_dir().join(plugin_id)
}

/// 单个插件日志文件上限：超过即把旧日志改名为 `.1`（保留一份历史）再新建。
/// 子进程一旦拿到句柄就无法中途切分，所以只在启动时判定；不设上限时
/// 长时间运行的插件（打印心跳/请求日志）会把用户磁盘吃满。
pub(super) const PLUGIN_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub(super) fn open_plugin_log(path: &std::path::Path) -> Result<std::fs::File, String> {
    let existing = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if existing > PLUGIN_LOG_MAX_BYTES {
        let mut raw = path.to_path_buf().into_os_string();
        raw.push(".1");
        let backup = PathBuf::from(raw);
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(path, &backup);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())
}

pub(super) fn plugin_status_path(plugin_id: &str) -> PathBuf {
    plugin_data_dir(plugin_id).join("status.json")
}

pub(super) fn plugin_config_path(plugin_id: &str) -> PathBuf {
    plugin_data_dir(plugin_id).join("config.json")
}

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── 供应商自动登记 ─────────────────────────────────────────────────────────
// 插件部署成功后自动登记成本地供应商，省掉用户手动再填一遍 127.0.0.1:端口 + 密钥。
// 这与 CPA 套件的做法一致（extensions.rs 的 auto_add_cpa_provider）。
//
// 只在插件确实产出了 API 密钥时才登记：没有密钥的插件（靠本机访问免鉴权的）
// 无从填 api_key，硬登记出一个供应商反而是坏的。
pub(super) const PLUGIN_PROVIDER_PREFIX: &str = "plugin-";

/// providers.json 由后端直接写盘，而前端 providerStore 只在页面加载时读一次。
/// 任何登记/移除/同步之后都必须发这个事件，否则界面停留在旧快照上，
/// 用户会以为「供应商没加好」（即使配置里已经有了）。
pub(super) const PROVIDERS_CHANGED_EVENT: &str = "providers-changed";

pub(super) fn plugin_provider_id(plugin_id: &str) -> String {
    format!("{}{}", PLUGIN_PROVIDER_PREFIX, plugin_id)
}

pub(super) fn emit_providers_changed(app: &tauri::AppHandle) {
    let _ = app.emit(PROVIDERS_CHANGED_EVENT, serde_json::json!({}));
}

/// 唯一的供应商写入点：部署登记、配置变更、启动对账都收敛到这里，
/// 结构上杜绝「一处改了另一处漏改」。返回是否真的改动了内容。
pub(super) fn upsert_plugin_provider(
    store: &mut crate::commands::config::ProviderStore,
    plugin_id: &str,
    name: &str,
    port: u16,
    api_key: &str,
) -> bool {
    use crate::commands::config::{ApiFormat, Provider, ProviderCapabilities};

    let id = plugin_provider_id(plugin_id);
    let host = format!("http://127.0.0.1:{}", port);
    if let Some(existing) = store.providers.iter_mut().find(|p| p.id == id) {
        let mut changed = false;
        // 显示名只在首次登记时写入；对账/配置同步不得覆盖用户或旧版本留下的名字
        if existing.api_host != host { existing.api_host = host; changed = true; }
        if existing.api_key != api_key { existing.api_key = api_key.to_string(); changed = true; }
        if existing.api_path.as_deref().unwrap_or("").trim().is_empty() {
            existing.api_path = Some("/v1".into());
            changed = true;
        }
        if !existing.enabled { existing.enabled = true; changed = true; }
        return changed;
    }

    let provider = Provider {
        id: id.clone(),
        name: name.to_string(),
        api_host: host,
        api_key: api_key.to_string(),
        api_keys: Vec::new(),
        api_path: Some("/v1".into()),
        default_model: String::new(),
        api_format: Some(ApiFormat::Openai),
        enabled: true,
        models: Vec::new(),
        capabilities: ProviderCapabilities::default(),
        model_caps: HashMap::new(),
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
        context_window: None,
        model_contexts: HashMap::new(),
        subagent_models: HashMap::new(),
    };
    store.providers.insert(0, provider);
    true
}

pub(super) fn auto_add_plugin_provider(
    plugin_id: &str,
    name: &str,
    port: u16,
    api_key: &str,
) -> Result<bool, String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Ok(false);
    }
    let plugin_id = plugin_id.to_string();
    let name = name.to_string();
    crate::commands::store_io::update_provider_store(|store| {
        let changed = upsert_plugin_provider(store, &plugin_id, &name, port, &api_key);
        Ok((changed, changed))
    })
}

pub(super) fn remove_plugin_provider(plugin_id: &str) -> Result<bool, String> {
    let id = plugin_provider_id(plugin_id);
    crate::commands::store_io::update_provider_store(|store| {
        let before = store.providers.len();
        // 只删本插件自动登记的那条，不按 host 误删用户自建供应商
        store.providers.retain(|p| p.id != id);
        let changed = store.providers.len() != before;
        Ok((changed, changed))
    })
}

/// 插件配置（端口/密钥）变更后，把已登记的供应商同步到同一份配置。
pub(super) fn sync_provider_from_config(
    plugin_id: &str,
    config: &serde_json::Value,
) -> Result<bool, String> {
    let installed = config
        .get("installPath")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let api_key = config.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !installed || api_key.is_empty() {
        return Ok(false);
    }
    let port = config
        .get("port")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("插件 {} 配置缺少 port，无法同步供应商", plugin_id))? as u16;
    let name = config
        .get("providerName")
        .and_then(|v| v.as_str())
        .unwrap_or(plugin_id);
    auto_add_plugin_provider(plugin_id, name, port, api_key)
}

/// 已不存在的插件留下的 plugin-* 供应商（纯函数，便于单测钉死）。
pub(super) fn orphan_plugin_provider_ids(
    provider_ids: &[String],
    valid_plugin_ids: &std::collections::HashSet<String>,
) -> Vec<String> {
    provider_ids
        .iter()
        .filter(|id| id.starts_with(PLUGIN_PROVIDER_PREFIX))
        .filter(|id| !valid_plugin_ids.contains(id.trim_start_matches(PLUGIN_PROVIDER_PREFIX)))
        .cloned()
        .collect()
}

pub(super) fn read_status(plugin_id: &str) -> PluginStatus {
    let path = plugin_status_path(plugin_id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(status) = serde_json::from_str::<PluginStatus>(&content) {
            return status;
        }
    }
    PluginStatus {
        plugin_id: plugin_id.to_string(),
        state: "unknown".to_string(),
        install_path: None,
        pid: None,
        port: None,
        started_at: None,
        version: None,
        error: None,
        updated_at: now_iso(),
    }
}

pub(super) fn write_status(status: &PluginStatus) -> Result<(), String> {
    let dir = plugin_data_dir(&status.plugin_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件数据目录失败: {}", e))?;
    let path = plugin_status_path(&status.plugin_id);
    let json = serde_json::to_string_pretty(status).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())
}

pub(super) fn read_config(plugin_id: &str) -> serde_json::Value {
    let path = plugin_config_path(plugin_id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
            return config;
        }
    }
    serde_json::json!({})
}

pub(super) fn write_config(plugin_id: &str, config: &serde_json::Value) -> Result<(), String> {
    let dir = plugin_data_dir(plugin_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件数据目录失败: {}", e))?;
    let path = plugin_config_path(plugin_id);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())
}

// ═══════════════════════════════════════════════════
// Process / port helpers
// ═══════════════════════════════════════════════════

/// Returns true if the TCP port on localhost is already bound by another process.
pub(super) fn is_port_in_use(port: u16) -> bool {
    // Check both loopback and wildcard bindings — a process on 0.0.0.0 would conflict too
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
        || std::net::TcpListener::bind(("0.0.0.0", port)).is_err()
}

/// Returns true if a process with the given PID is currently alive.
#[cfg(target_os = "windows")]
pub(super) fn is_pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // tasklist prints "信息: 没有运行的任务..." when no match; a real row contains the PID
            stdout.contains(&format!("\"{}\"", pid))
        }
        Err(_) => false,
    }
}

/// 获取指定 PID 的可执行文件路径。进程已退出、无权限或查询失败时返回 None。
#[cfg(target_os = "windows")]
pub(super) fn process_exe_path(pid: u32) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {} -ErrorAction SilentlyContinue).Path", pid),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn process_exe_path(pid: u32) -> Option<String> {
    let path = std::fs::read_link(format!("/proc/{}/exe", pid)).ok()?;
    Some(path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn is_pid_alive(pid: u32) -> bool {
    // signal 0 performs error checking without actually sending a signal
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Terminate a process tree by PID.
pub(super) fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // /T kills the whole tree, /F forces termination when the graceful attempt is ignored
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

// ═══════════════════════════════════════════════════
// Sidecar HTTP helpers
// ═══════════════════════════════════════════════════

pub(super) fn sidecar_url() -> String {
    let port = configured_proxy_ports().api_port;
    format!("http://127.0.0.1:{}", port)
}

pub(super) async fn sidecar_get(path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", sidecar_url(), path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Sidecar returned {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub(super) async fn sidecar_post(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    sidecar_post_with_timeout(path, body, std::time::Duration::from_secs(30)).await
}

pub(super) async fn sidecar_post_with_timeout(path: &str, body: &serde_json::Value, timeout: std::time::Duration) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", sidecar_url(), path);
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Sidecar returned {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════════
// Tauri commands
// ═══════════════════════════════════════════════════


pub mod deploy;
pub mod lifecycle;
pub mod maintenance;
pub use deploy::*;
pub use lifecycle::*;
pub use maintenance::*;

fn reconcile_plugin_providers_inner() -> Result<(bool, Vec<String>), String> {
    use std::collections::HashSet;

    let entries = match fs::read_dir(plugins_dir()) {
        Ok(e) => e,
        Err(_) => return Ok((false, Vec::new())),
    };

    struct ScannedPlugin {
        id: String,
        config_name: Option<String>,
        port: u16,
        api_key: String,
    }

    let mut scanned = Vec::new();
    let mut valid = HashSet::new();
    let mut listening = Vec::new();

    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let config = read_config(&id);
        let installed = config
            .get("installPath")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty());
        let api_key = config
            .get("apiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !installed || api_key.is_empty() {
            continue;
        }
        let port = match config.get("port").and_then(|v| v.as_u64()) {
            Some(p) => p as u16,
            None => {
                eprintln!("[plugins] {} 配置缺少 port，跳过供应商对账", id);
                continue;
            }
        };
        valid.insert(id.clone());
        let config_name = config
            .get("providerName")
            .and_then(|v| v.as_str())
            .map(String::from);
        if is_port_in_use(port) {
            listening.push(id.clone());
        }
        scanned.push(ScannedPlugin {
            id,
            config_name,
            port,
            api_key,
        });
    }

    let changed = crate::commands::store_io::update_provider_store(|store| {
        let mut changed = false;
        for item in &scanned {
            let managed_id = plugin_provider_id(&item.id);
            let existing_name = store
                .providers
                .iter()
                .find(|p| p.id == managed_id)
                .map(|p| p.name.clone());
            let name = item
                .config_name
                .clone()
                .or(existing_name)
                .unwrap_or_else(|| item.id.clone());
            if upsert_plugin_provider(store, &item.id, &name, item.port, &item.api_key) {
                changed = true;
            }
        }

        // 插件已卸载、数据被清掉时，撤掉指向死服务的托管供应商。
        let provider_ids: Vec<String> = store.providers.iter().map(|p| p.id.clone()).collect();
        let orphans = orphan_plugin_provider_ids(&provider_ids, &valid);
        if !orphans.is_empty() {
            store.providers.retain(|p| !orphans.contains(&p.id));
            changed = true;
        }
        Ok((changed, changed))
    })?;

    Ok((changed, listening))
}

/// AnyBridge 启动时对账一次：补齐被整体覆盖抹掉的登记、清掉孤立条目，
/// 并对仍在监听的网关补一次模型目录。热插拔不依赖用户手点刷新。
pub fn reconcile_plugin_providers(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        match reconcile_plugin_providers_inner() {
            Ok((changed, listening)) => {
                if changed {
                    emit_providers_changed(&app);
                }
                for id in listening {
                    spawn_models_sync_when_ready(app.clone(), id);
                }
            }
            Err(e) => eprintln!("[plugins] 供应商对账失败: {}", e),
        }
    });
}


#[cfg(test)]
#[path = "tests.rs"]
mod provider_hotplug_tests;

