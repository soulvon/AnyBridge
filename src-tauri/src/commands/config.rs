use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;

fn config_dir() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("ide-byok");
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
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
    /// 模型级别的能力标记（vision / tools），键为模型 ID。
    #[serde(rename = "modelCaps", default)]
    pub model_caps: HashMap<String, ModelCaps>,
}

/// 单个模型的能力标记
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelCaps {
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub tools: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderCapabilities {
    #[serde(default = "default_true")]
    pub text: bool,
    #[serde(default = "default_true")]
    pub stream: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub tools: bool,
    /// gzip 压缩请求体：绕过中转站 Cloudflare WAF 对明文 body 的命令注入检测。
    /// 默认关闭（One-Hub 等不支持 gzip 的端点会 400）。
    #[serde(default)]
    pub gzip: bool,
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
    #[allow(dead_code)]
    pub current: String,
}

pub(crate) fn read_provider_store() -> Result<ProviderStore, String> {
    let path = providers_path();
    if !path.exists() {
        return Ok(ProviderStore::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub(crate) fn write_provider_store(store: &ProviderStore) -> Result<(), String> {
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

fn clean_api_path(path: Option<&str>) -> String {
    let raw = path.unwrap_or_default().trim();
    if raw.is_empty() || raw == "/" {
        return String::new();
    }
    format!(
        "/{}",
        raw.trim_start_matches('/').trim_end_matches('/')
    )
}

fn is_official_dashscope_host(host: &str) -> bool {
    let hostname = reqwest::Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            host.trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    matches!(
        hostname.as_str(),
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com"
    )
}

fn normalize_openai_api_path(host: &str, path: Option<&str>) -> String {
    let path = clean_api_path(path);
    let lower = path.to_ascii_lowercase();

    if is_official_dashscope_host(host) {
        if lower.ends_with("/compatible-mode/v1/chat/completions")
            || lower.ends_with("/compatible-mode/v1/responses")
        {
            return path;
        }
        if lower == "/v1/chat/completions" || lower == "/api/v1/chat/completions" {
            return "/compatible-mode/v1/chat/completions".to_string();
        }
        if lower == "/v1/responses" || lower == "/api/v1/responses" {
            return "/compatible-mode/v1/responses".to_string();
        }
        if path.is_empty()
            || lower == "/v1"
            || lower == "/api/v1"
            || lower == "/compatible-mode"
            || lower == "/compatible-mode/v1"
        {
            return "/compatible-mode/v1/chat/completions".to_string();
        }
        if lower.ends_with("/compatible-mode/v1") {
            return format!("{}/chat/completions", path);
        }
        if lower.ends_with("/compatible-mode") {
            return format!("{}/v1/chat/completions", path);
        }
    }

    if lower.ends_with("/chat/completions") || lower.ends_with("/responses") {
        return path;
    }
    if path.is_empty() {
        return "/v1/chat/completions".to_string();
    }
    if lower.ends_with("/v1") {
        return format!("{}/chat/completions", path);
    }
    path
}

fn normalize_anthropic_api_path(path: Option<&str>) -> String {
    let path = clean_api_path(path);
    let lower = path.to_ascii_lowercase();
    if path.is_empty() {
        return "/v1/messages".to_string();
    }
    if lower.ends_with("/messages") {
        return path;
    }
    if lower.ends_with("/v1") {
        return format!("{}/messages", path);
    }
    format!("{}/v1/messages", path)
}

fn is_deepseek_anthropic_endpoint(host: &str, path: Option<&str>) -> bool {
    let hostname = reqwest::Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            host.trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    hostname == "api.deepseek.com"
        && normalize_anthropic_api_path(path)
            .to_ascii_lowercase()
            .starts_with("/anthropic/")
}

fn apply_anthropic_auth(
    req: reqwest::RequestBuilder,
    api_key: &str,
    host: &str,
    path: Option<&str>,
) -> reqwest::RequestBuilder {
    let req = req.header("anthropic-version", "2023-06-01");
    if is_deepseek_anthropic_endpoint(host, path) {
        req.header("Authorization", format!("Bearer {}", api_key))
    } else {
        req.header("x-api-key", api_key)
    }
}

#[derive(Debug, Deserialize)]
pub struct TestConnArgs {
    pub host: String,
    pub api_key: String,
    pub path: Option<String>,
    #[serde(default)]
    pub api_format: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TestConnResult {
    /// 显示给用户的状态文本
    pub message: String,
    /// 探测到的能力标记
    pub capabilities: TestCapabilities,
}

#[derive(Debug, Serialize, Default)]
pub struct TestCapabilities {
    pub gzip: bool,
    pub vision: bool,
    pub tools: bool,
}

#[tauri::command]
pub async fn test_connection(args: TestConnArgs) -> Result<TestConnResult, String> {
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

    // ── Step 1: 快速连通检查 (/v1/models) ──
    // 注意：很多中转站（One-Hub + Cloudflare）会屏蔽 /v1/models 返回 403，
    // 但 /v1/chat/completions 是正常的。所以 403 不阻断，只标记 models_ok。
    let model_paths = ["/v1/models", "/models"];
    let mut models_ok = false;

    for path in &model_paths {
        let url = format!("{}{}", host, path);
        let mut req = client.get(&url);
        if fmt == "openai" {
            req = req.header("Authorization", format!("Bearer {}", args.api_key));
        } else {
            req = apply_anthropic_auth(req, &args.api_key, &host, args.path.as_deref());
        }
        match req.send().await {
            Ok(r) => {
                let s = r.status().as_u16();
                if r.status().is_success() {
                    models_ok = true;
                    break;
                }
                if s == 403 {
                    // Cloudflare WAF 或供应商屏蔽，不阻断后续
                }
                // 401 也不阻断，交给 chat 测试最终验证
            }
            Err(_) => {
                // 网络错误也不阻断，chat 测试会再试
            }
        }
    }

    // ── Step 2: Chat 探测（发送 "今天几号" 验证实际调用能力）──
    let chat_path = if fmt == "openai" {
        normalize_openai_api_path(&host, args.path.as_deref())
    } else {
        normalize_anthropic_api_path(args.path.as_deref())
    };
    let uses_openai_responses =
        fmt == "openai" && chat_path.to_ascii_lowercase().contains("/responses");

    let test_model = args.model.as_deref().unwrap_or("gpt-3.5-turbo");
    let (chat_body, auth_header, auth_value) = if fmt == "openai" && uses_openai_responses {
        let body = serde_json::json!({
            "model": test_model,
            "input": [{"role": "user", "content": "今天几号"}],
            "max_output_tokens": 32,
            "stream": false
        });
        (
            serde_json::to_vec(&body).unwrap(),
            "Authorization".to_string(),
            format!("Bearer {}", args.api_key),
        )
    } else if fmt == "openai" {
        let body = serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "今天几号"}],
            "max_tokens": 32,
            "stream": false
        });
        (
            serde_json::to_vec(&body).unwrap(),
            "Authorization".to_string(),
            format!("Bearer {}", args.api_key),
        )
    } else {
        let body = serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "今天几号"}],
            "max_tokens": 32,
            "stream": false
        });
        let (auth_header, auth_value) = if is_deepseek_anthropic_endpoint(&host, Some(&chat_path)) {
            (
                "Authorization".to_string(),
                format!("Bearer {}", args.api_key),
            )
        } else {
            ("x-api-key".to_string(), args.api_key.clone())
        };
        (serde_json::to_vec(&body).unwrap(), auth_header, auth_value)
    };

    let chat_url = format!("{}{}", host, chat_path);

    // 128x128 PNG: some upstreams reject tiny 1x1 images even when vision works.
    const VISION_TEST_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABpklEQVR4nO3SMRHDUBBDwcAxiIAwYoNI/bk4IFTc6GYL1a/Qfq77+yY74cb7T7YTbrr/GT9gug8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsBNA/YFpv/zAtA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBOAPUHpv3yA9M+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwHUH5j2yw9M+wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwEcN2/N9kJN95/sp1w030AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2Aqg/MO2XH5j2AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2Amg/sC0X35g2gcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAngPoD0375gWkfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAlQD+DY7JjtGCazMAAAAASUVORK5CYII=";

    // 发送请求的闭包：根据 use_gzip 决定是否压缩
    let send_req = |body: Vec<u8>, use_gzip: bool| {
        let mut req = client
            .post(&chat_url)
            .header("Content-Type", "application/json")
            .header(&auth_header, &auth_value)
            .body(body);
        if use_gzip {
            req = req.header("Content-Encoding", "gzip");
        }
        if fmt != "openai" {
            req = req.header("anthropic-version", "2023-06-01");
        }
        req
    };

    // 先发明文请求
    let plain_resp = send_req(chat_body.clone(), false).send().await;

    let need_gzip = match plain_resp {
        Ok(r) if r.status().is_success() => false,
        Ok(r) => {
            let status = r.status().as_u16();
            let _err_body = r.text().await.unwrap_or_default();

            // 401 = 真正的认证失败
            if status == 401 {
                return Err("认证失败 (HTTP 401)，请检查 API 密钥".to_string());
            }

            // 400/403/其他 → 尝试 gzip（可能是 WAF 拦截明文 body）
            use flate2::write::GzEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&chat_body).map_err(|e| e.to_string())?;
            let gz_body = encoder.finish().map_err(|e| e.to_string())?;

            match send_req(gz_body, true).send().await {
                Ok(r) if r.status().is_success() => true,
                Ok(r) => {
                    let gz_status = r.status().as_u16();
                    if gz_status == 401 || gz_status == 403 {
                        return Err(format!("认证失败 (HTTP {})，请检查 API 密钥", gz_status));
                    }
                    let gz_body = r.text().await.unwrap_or_default();
                    let gz_snippet: String = gz_body.chars().take(200).collect();
                    return Err(format!(
                        "Chat 失败: 明文 HTTP {} / Gzip HTTP {}: {}",
                        status, gz_status, gz_snippet
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "Chat 明文 HTTP {}，Gzip 网络错误: {}",
                        status,
                        redact(e.to_string(), &args.api_key)
                    ));
                }
            }
        }
        Err(e) => return Err(redact(format!("Chat 网络错误: {}", e), &args.api_key)),
    };

    // ── Step 3: 能力探测（Vision / Tools）──────────────────────
    // 构建不同格式的测试 body
    let (vision_body, tools_body) = if fmt == "openai" && uses_openai_responses {
        let v = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "describe"},
                {"type": "input_image", "image_url": format!("data:image/png;base64,{}", VISION_TEST_PNG_B64)}
            ]}],
            "max_output_tokens": 16,
            "stream": false
        })).unwrap();
        let t = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "input": [{"role": "user", "content": "Add 1 and 2"}],
            "tools": [{"type": "function",
                "name": "add",
                "description": "Add two numbers",
                "parameters": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}
                }, "required": ["a", "b"]}
            }],
            "max_output_tokens": 64,
            "stream": false
        }))
        .unwrap();
        (v, t)
    } else if fmt == "openai" {
        let v = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "describe"},
                {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{}", VISION_TEST_PNG_B64)}}
            ]}],
            "max_tokens": 16,
            "stream": false
        })).unwrap();
        let t = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "Add 1 and 2"}],
            "tools": [{"type": "function", "function": {
                "name": "add",
                "description": "Add two numbers",
                "parameters": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}
                }, "required": ["a", "b"]}
            }}],
            "max_tokens": 64,
            "stream": false
        }))
        .unwrap();
        (v, t)
    } else {
        let v = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "describe"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": VISION_TEST_PNG_B64}}
            ]}],
            "max_tokens": 16,
            "stream": false
        })).unwrap();
        let t = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "Add 1 and 2"}],
            "tools": [{"name": "add", "description": "Add two numbers",
                "input_schema": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}
                }, "required": ["a", "b"]}
            }],
            "max_tokens": 64,
            "stream": false
        }))
        .unwrap();
        (v, t)
    };

    let mut caps = TestCapabilities {
        gzip: need_gzip,
        vision: false,
        tools: false,
    };

    // Vision 探测
    match send_req(vision_body, need_gzip).send().await {
        Ok(r) if r.status().is_success() => caps.vision = true,
        Ok(r) => {
            let _ = r.text().await;
        }
        Err(_) => {}
    }

    // Tools 探测
    match send_req(tools_body, need_gzip).send().await {
        Ok(r) if r.status().is_success() => caps.tools = true,
        Ok(r) => {
            let _ = r.text().await;
        }
        Err(_) => {}
    }

    // 组装结果
    let mut parts = vec![];
    if models_ok {
        parts.push("连通 ✓".to_string());
    }
    parts.push("Chat ✓".to_string());
    if caps.vision {
        parts.push("Vision ✓".to_string());
    }
    if caps.tools {
        parts.push("Tools ✓".to_string());
    }
    if need_gzip {
        parts.push("(需 Gzip)".to_string());
    }
    let msg = parts.join(" ");

    Ok(TestConnResult {
        message: msg,
        capabilities: caps,
    })
}

// ─── 拉取模型列表 ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct FetchModelsArgs {
    pub host: String,
    pub api_key: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub api_format: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FetchModelsResult {
    pub models: Vec<String>,
    /// 实际命中并成功返回模型列表所用的协议（anthropic / openai）
    pub api_format: String,
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
    let chat_path = if fmt == "openai" {
        normalize_openai_api_path(&host, args.path.as_deref())
    } else {
        normalize_anthropic_api_path(args.path.as_deref())
    };
    // 按协议分发凭证头；DeepSeek 的 Anthropic 兼容入口使用 Bearer。
    // 避免把 key 同时塞进两种头发给非预期端点。
    let auth = |req: reqwest::RequestBuilder| {
        if fmt == "openai" {
            req.header("Authorization", format!("Bearer {}", args.api_key))
        } else {
            apply_anthropic_auth(req, &args.api_key, &host, Some(&chat_path))
        }
    };

    let lower_path = chat_path.to_ascii_lowercase();
    let base_path = if lower_path.ends_with("/chat/completions") {
        chat_path.trim_end_matches("/chat/completions").to_string()
    } else if lower_path.ends_with("/responses") {
        chat_path.trim_end_matches("/responses").to_string()
    } else if lower_path.ends_with("/messages") {
        chat_path.trim_end_matches("/messages").to_string()
    } else {
        String::new()
    };
    let mut model_paths = Vec::new();
    if !base_path.is_empty() {
        model_paths.push(format!("{}/models", base_path.trim_end_matches('/')));
    }
    model_paths.push("/v1/models".to_string());
    model_paths.push("/models".to_string());
    model_paths.dedup();

    let mut resp = None;
    for path in model_paths {
        let url = format!("{}{}", host, path);
        let req = auth(client.get(&url));
        if let Ok(r) = req.send().await {
            if r.status().is_success() {
                resp = Some(r);
                break;
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

    Ok(FetchModelsResult {
        models,
        api_format: fmt.to_string(),
    })
}
