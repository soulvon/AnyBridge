use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn config_dir() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("windsurf-byok");
    dir
}

fn config_path() -> PathBuf {
    config_dir().join("byok-config.json")
}

fn providers_path() -> PathBuf {
    config_dir().join("providers.json")
}

pub fn config_dir_path() -> PathBuf {
    config_dir()
}

/// 读取杂项配置中的单个键（探测 Windsurf 路径缓存等内部用途）。
pub(crate) fn read_config_value(key: &str) -> Option<String> {
    let path = config_path();
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let cfg: ByokConfig = serde_json::from_str(&raw).ok()?;
    cfg.values.get(key).cloned()
}

/// 写入杂项配置中的单个键（保留其余键）。失败仅返回 Err，调用方按需忽略。
pub(crate) fn write_config_value(key: &str, value: &str) -> Result<(), String> {
    let mut values = load_config().unwrap_or_default();
    values.insert(key.to_string(), value.to_string());
    save_config(values)
}

// ─── 杂项配置（系统提示词开关等，非供应商字段）────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ByokConfig {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

#[tauri::command]
pub fn load_config() -> Result<BTreeMap<String, String>, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cfg: ByokConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(cfg.values)
}

#[tauri::command]
pub fn save_config(values: BTreeMap<String, String>) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = ByokConfig { values };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    super::write_atomic(&config_path(), json.as_bytes())
}

// ─── 供应商 profile（多套命名配置 + 当前激活指针）──────────────

/// API 协议格式：决定 sidecar 走 Anthropic 还是 OpenAI 转发逻辑
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApiFormat {
    Anthropic,
    Openai,
}

impl Default for ApiFormat {
    fn default() -> Self {
        ApiFormat::Anthropic
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(rename = "apiFormat", default)]
    pub api_format: ApiFormat,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderStore {
    #[serde(default)]
    pub providers: Vec<Provider>,
    // `current`/激活概念已废弃，改用每槽位 targets 故障转移。保留字段仅为兼容旧文件反序列化，不再读写。
    #[serde(default, skip_serializing)]
    pub current: String,
}

fn read_provider_store() -> Result<ProviderStore, String> {
    let path = providers_path();
    if !path.exists() {
        return Ok(ProviderStore::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_provider_store(store: &ProviderStore) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    super::write_atomic(&providers_path(), json.as_bytes())
}

#[tauri::command]
pub fn load_providers() -> Result<ProviderStore, String> {
    read_provider_store()
}

/// 整体保存供应商列表（新增/编辑/删除/排序/启用禁用统一走这里）。
#[tauri::command]
pub fn save_providers(store: ProviderStore) -> Result<(), String> {
    write_provider_store(&store)
}

/// 启用/禁用单个供应商。禁用的供应商在「目标配置」下拉里不出现，路由也会跳过。
#[tauri::command]
pub fn set_provider_enabled(id: String, enabled: bool) -> Result<(), String> {
    let mut store = read_provider_store()?;
    let p = store
        .providers
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("供应商不存在: {}", id))?;
    p.enabled = enabled;
    write_provider_store(&store)
}

/// 把错误信息里出现的 api_key 子串脱敏，避免 key 经错误消息泄入 UI 日志/导出文件。
fn redact(msg: String, secret: &str) -> String {
    if secret.len() >= 6 && msg.contains(secret) {
        msg.replace(secret, "***REDACTED***")
    } else {
        msg
    }
}

#[derive(Debug, Deserialize)]
pub struct TestConnArgs {
    pub host: String,
    pub api_key: String,
    pub path: Option<String>,
    #[serde(default)]
    pub api_format: Option<String>,
}

#[tauri::command]
pub async fn test_connection(args: TestConnArgs) -> Result<String, String> {
    let host = args.host.trim_end_matches('/');
    let host = if host.starts_with("http") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    let fmt = args.api_format.as_deref().unwrap_or("anthropic");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Try /v1/models first, then /models as fallback
    let paths = ["/v1/models", "/models"];
    let mut last_status: u16 = 0;

    for path in &paths {
        let url = format!("{}{}", host, path);
        let mut req = client.get(&url);
        if fmt == "openai" {
            req = req.header("Authorization", format!("Bearer {}", args.api_key));
        } else {
            req = req
                .header("x-api-key", &args.api_key)
                .header("anthropic-version", "2023-06-01");
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return Err(redact(format!("网络错误: {}", e), &args.api_key)),
        };
        let status = resp.status();
        last_status = status.as_u16();

        if status.is_success() {
            return Ok("连通 ✓".to_string());
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("认证失败 (HTTP {})，请检查 API 密钥", status.as_u16()));
        }
        // 404 → try next path
    }

    Err(format!("端点不存在 (HTTP {})，请检查 API 地址", last_status))
}

// ─── 拉取模型列表 ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct FetchModelsArgs {
    pub host: String,
    pub api_key: String,
    #[serde(default)]
    pub api_format: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FetchModelsResult {
    pub models: Vec<String>,
}

#[tauri::command]
pub async fn fetch_models(args: FetchModelsArgs) -> Result<FetchModelsResult, String> {
    let host = args.host.trim_end_matches('/');
    let host = if host.starts_with("http") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let fmt = args.api_format.as_deref().unwrap_or("anthropic");
    // 按协议分发凭证头：OpenAI 用 Bearer，Anthropic 用 x-api-key。
    // 避免把 key 同时塞进两种头发给非预期端点。
    let auth = |req: reqwest::RequestBuilder| {
        if fmt == "openai" {
            req.header("Authorization", format!("Bearer {}", args.api_key))
        } else {
            req.header("x-api-key", &args.api_key)
                .header("anthropic-version", "2023-06-01")
        }
    };

    // Try {host}/v1/models first
    let url1 = format!("{}/v1/models", host);
    let req1 = auth(client.get(&url1));

    let response = req1.send().await;
    let mut resp = match response {
        Ok(r) if r.status().is_success() => Some(r),
        _ => None,
    };

    // If that fails, try {host}/models
    if resp.is_none() {
        let url2 = format!("{}/models", host);
        let req2 = auth(client.get(&url2));
        if let Ok(r) = req2.send().await {
            if r.status().is_success() {
                resp = Some(r);
            }
        }
    }

    let Some(r) = resp else {
        return Err("API请求失败（尝试了 /v1/models 和 /models 都无法连通）".to_string());
    };

    let body: serde_json::Value = r.json().await.map_err(|e| format!("解析失败: {}", e))?;

    let mut models = Vec::new();

    if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    } else if let Some(arr) = body.as_array() {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            } else if let Some(id) = item.as_str() {
                models.push(id.to_string());
            }
        }
    } else if let Some(obj) = body.as_object() {
        for (_k, val) in obj {
            if let Some(arr) = val.as_array() {
                for item in arr {
                    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                        models.push(id.to_string());
                    } else if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        models.push(name.to_string());
                    }
                }
            }
        }
    }

    Ok(FetchModelsResult { models })
}
