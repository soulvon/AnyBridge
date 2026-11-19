use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::types::ApiFormat;
use super::{read_provider_store, APP_USER_AGENT};

/// 把错误信息里出现的 api_key 子串及 JSON 凭据私钥脱敏，避免 key 经错误消息泄入 UI 日志/导出文件。
pub(super) fn redact(msg: String, secret: &str) -> String {
    let stage1 = crate::commands::google_gemini::redact_credential(&msg, secret);
    if secret.len() >= 6 && stage1.contains(secret) {
        stage1.replace(secret, "***REDACTED***")
    } else {
        stage1
    }
}

pub(super) fn clean_api_path(path: Option<&str>) -> String {
    let raw = path.unwrap_or_default().trim();
    if raw.is_empty() || raw == "/" {
        return String::new();
    }
    format!("/{}", raw.trim_start_matches('/').trim_end_matches('/'))
}

pub(super) fn is_official_dashscope_host(host: &str) -> bool {
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

pub(super) fn normalize_openai_api_path(host: &str, path: Option<&str>) -> String {
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
        let host_lower = host.trim().trim_end_matches('/').to_ascii_lowercase();
        if host_lower.ends_with("/openai") {
            return "/chat/completions".to_string();
        }
        return "/v1/chat/completions".to_string();
    }
    if lower.ends_with("/v1") || lower.ends_with("/openai") {
        return format!("{}/chat/completions", path);
    }
    path
}

pub(super) fn normalize_anthropic_api_path(path: Option<&str>) -> String {
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

pub(super) fn is_deepseek_anthropic_endpoint(host: &str, path: Option<&str>) -> bool {
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

pub(super) fn apply_anthropic_auth(
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
    /// 端到端耗时（毫秒）：从发请求到拿到成功响应，含可能的 gzip 重试
    #[serde(rename = "latencyMs")]
    pub latency_ms: u64,
    /// 探测到的能力标记
    pub capabilities: TestCapabilities,
}

#[derive(Debug, Serialize, Default)]
pub struct TestCapabilities {
    pub gzip: bool,
    pub vision: bool,
    pub tools: bool,
}

#[derive(Debug, Deserialize)]
pub struct TestVisionArgs {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    #[serde(rename = "apiFormat")]
    pub api_format: String,
    #[serde(rename = "imageBase64")]
    pub image_base64: String,
}

#[derive(Debug, Serialize)]
pub struct TestVisionResult {
    pub ok: bool,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub text: String,
    pub error: Option<String>,
}

pub(super) fn elapsed_ms(started: std::time::Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

pub(super) fn snippet(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(max_chars).collect();
    if trimmed.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

pub(super) fn content_text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.trim().to_string();
    }
    let Some(arr) = value.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.pointer("/text/value").and_then(Value::as_str))
                .or_else(|| part.get("content").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn normalize_gemini_api_path(
    host: &str,
    api_path: Option<&str>,
    model: &str,
) -> String {
    crate::commands::google_gemini::normalize_gemini_api_path(host, api_path, model)
}

pub(super) fn extract_vision_text(fmt: &ApiFormat, json: &Value) -> String {
    match fmt {
        ApiFormat::Openai => {
            if let Some(s) = json.get("output_text").and_then(Value::as_str) {
                return s.trim().to_string();
            }
            let choice_text = json
                .pointer("/choices/0/message/content")
                .map(content_text)
                .unwrap_or_default();
            if !choice_text.trim().is_empty() {
                return choice_text;
            }
            json.get("output")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| item.get("content").map(content_text).unwrap_or_default())
                        .filter(|s| !s.trim().is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }
        ApiFormat::Anthropic => json.get("content").map(content_text).unwrap_or_default(),
        ApiFormat::Gemini => crate::commands::google_gemini::extract_gemini_parts_text(json)
            .trim()
            .to_string(),
    }
}

pub(super) fn regex_match(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

pub(super) fn vision_missing_reason(text: &str) -> Option<&'static str> {
    let lower = text.trim().to_ascii_lowercase();
    if regex_match(
        r#"(?m)^\s*["""「」']?(?:我)?不能看到图片["""「」']?[。.!！]?\s*$"#,
        text,
    ) {
        return Some("模型明确回答不能看到图片");
    }
    let phrases = [
        "image_missing",
        "can't see",
        "cannot see",
        "can't view",
        "cannot view",
        "unable to see",
        "unable to view",
        "don't see",
        "do not see",
        "didn't receive",
        "did not receive",
        "no image",
        "not see an image",
        "without an image",
        "无法看到",
        "没看到",
        "没有看到",
        "看不到",
        "无法查看",
        "不能查看",
        "未看到",
        "没有收到",
        "没有上传",
        "如果您能上传",
        "您提到的图片",
    ];
    if phrases.iter().any(|phrase| lower.contains(phrase)) {
        Some("模型回复表示没有收到图片")
    } else {
        None
    }
}

pub(super) fn vision_seen_answer_ok(text: &str) -> bool {
    regex_match(
        r#"(?m)^\s*["""「」']?(?:我)?能看到图片["""「」']?[。.!！,，]?\s*(?:$|图片内容|内容)"#,
        text,
    )
}

pub(super) fn vision_content_hit_count(text: &str) -> usize {
    [
        r"(?i)\bRED\b|红色|红",
        r"(?i)\bBLUE\b|蓝色|蓝",
        r"(?i)\bGREEN\b|绿色|绿",
        r"\b42\b",
        r"\b17\b",
        r"\b0?9\b",
    ]
    .iter()
    .filter(|pattern| regex_match(pattern, text))
    .count()
}

pub(super) fn strip_think_blocks(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(open) = lower.find("<think>") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..open]);
        let after_open = open + "<think>".len();
        let after = &rest[after_open..];
        let after_lower = after.to_ascii_lowercase();
        let Some(close) = after_lower.find("</think>") else {
            break;
        };
        rest = &after[close + "</think>".len()..];
    }
    out.trim().to_string()
}

pub(super) fn vision_body(
    fmt: &ApiFormat,
    uses_openai_responses: bool,
    model: &str,
    image_b64: &str,
) -> Value {
    let data_url = format!("data:image/png;base64,{}", image_b64);
    let prompt = "请判断你是否真的看到了图片。严格按两行回答：\n第一行只能回答「能看到图片」或「不能看到图片」。\n第二行以「图片内容：」开头，描述图片里的文字和文字颜色。不要猜测；如果图片不可见，第二行写原因。";
    if matches!(fmt, ApiFormat::Openai) && uses_openai_responses {
        serde_json::json!({
            "model": model,
            "input": [{"role": "user", "content": [
                {"type": "input_image", "image_url": data_url},
                {"type": "input_text", "text": prompt}
            ]}],
            "max_output_tokens": 1024,
            "temperature": 0,
            "stream": false
        })
    } else if matches!(fmt, ApiFormat::Openai) {
        serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt}
            ]}],
            "max_tokens": 1024,
            "temperature": 0,
            "stream": false
        })
    } else if matches!(fmt, ApiFormat::Gemini) {
        serde_json::json!({
            "contents": [{
                "role": "user",
                "parts": [
                    { "inlineData": { "mimeType": "image/png", "data": image_b64 } },
                    { "text": prompt }
                ]
            }],
            "generationConfig": {
                "maxOutputTokens": 1024,
                "temperature": 0
            }
        })
    } else {
        serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                {"type": "text", "text": prompt}
            ]}],
            "max_tokens": 1024,
            "temperature": 0,
            "stream": false
        })
    }
}

pub(super) fn mark_model_vision(provider_id: &str, model: &str) -> Result<(), String> {
    crate::commands::store_io::update_provider_store(|store| {
        let Some(provider) = store.providers.iter_mut().find(|p| p.id == provider_id) else {
            return Ok((false, ()));
        };
        provider
            .model_caps
            .entry(model.to_string())
            .or_default()
            .vision = true;
        Ok((true, ()))
    })
}

pub(super) fn parse_api_format_arg(value: &str) -> Result<ApiFormat, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "openai" => Ok(ApiFormat::Openai),
        "anthropic" => Ok(ApiFormat::Anthropic),
        "gemini" => Ok(ApiFormat::Gemini),
        "" => Err("本次调用必须明确选择协议(openai, anthropic 或 gemini)".to_string()),
        other => Err(format!("未知协议: {}", other)),
    }
}

#[tauri::command]
pub async fn test_vision(args: TestVisionArgs) -> Result<TestVisionResult, String> {
    let provider_id = args.provider_id.trim();
    let model = args.model.trim();
    let api_format = parse_api_format_arg(&args.api_format)?;
    let mut image_b64 = args.image_base64.trim();
    if let Some((_, data)) = image_b64.split_once(',') {
        image_b64 = data.trim();
    }
    if provider_id.is_empty() {
        return Err("供应商不能为空".to_string());
    }
    if model.is_empty() {
        return Err("模型不能为空".to_string());
    }
    if image_b64.is_empty() {
        return Err("测试图片不能为空".to_string());
    }

    let store = read_provider_store()?;
    let provider = store
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .cloned()
        .ok_or_else(|| format!("供应商不存在: {}", provider_id))?;
    if provider.enabled == false {
        return Err(format!("供应商已禁用: {}", provider.name));
    }

    let host = provider.api_host.trim_end_matches('/');
    let host = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    let (resolved_host, chat_path) = match api_format {
        ApiFormat::Openai => (
            host.clone(),
            normalize_openai_api_path(&host, provider.api_path.as_deref()),
        ),
        ApiFormat::Anthropic => (
            host.clone(),
            normalize_anthropic_api_path(provider.api_path.as_deref()),
        ),
        ApiFormat::Gemini => crate::commands::google_gemini::resolve_gemini_endpoint(
            &host,
            provider.api_path.as_deref(),
            model,
            &provider.api_key,
        ),
    };
    let uses_openai_responses =
        api_format == ApiFormat::Openai && chat_path.to_ascii_lowercase().contains("/responses");
    let url = format!("{}{}", resolved_host, chat_path);
    let body = vision_body(&api_format, uses_openai_responses, model, image_b64);
    let mut body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;

    let client = crate::commands::apply_system_proxy(
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)),
    )
    .build()
    .map_err(|e| e.to_string())?;

    let started = std::time::Instant::now();
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", APP_USER_AGENT);
    req = match api_format {
        ApiFormat::Openai => req.header("Authorization", format!("Bearer {}", provider.api_key)),
        ApiFormat::Gemini => {
            crate::commands::google_gemini::apply_gemini_auth(&client, req, &provider.api_key).await?
        }
        ApiFormat::Anthropic => {
            apply_anthropic_auth(req, &provider.api_key, &host, provider.api_path.as_deref())
        }
    };
    if provider.capabilities.gzip {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&body_bytes).map_err(|e| e.to_string())?;
        body_bytes = encoder.finish().map_err(|e| e.to_string())?;
        req = req.header("Content-Encoding", "gzip");
    }

    let resp = match req.body(body_bytes).send().await {
        Ok(resp) => resp,
        Err(e) => {
            return Ok(TestVisionResult {
                ok: false,
                duration_ms: elapsed_ms(started),
                text: String::new(),
                error: Some(redact(format!("网络错误: {}", e), &provider.api_key)),
            });
        }
    };
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    let duration_ms = elapsed_ms(started);
    if !status.is_success() {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: String::new(),
            error: Some(redact(
                format!("HTTP {}: {}", status.as_u16(), snippet(&body_text, 240)),
                &provider.api_key,
            )),
        });
    }

    let json: Value = match serde_json::from_str(&body_text) {
        Ok(json) => json,
        Err(e) => {
            return Ok(TestVisionResult {
                ok: false,
                duration_ms,
                text: String::new(),
                error: Some(format!("解析响应失败: {}", e)),
            });
        }
    };
    let raw_text = extract_vision_text(&api_format, &json);
    let text = strip_think_blocks(&raw_text);
    let text = if text.trim().is_empty() {
        if raw_text.to_ascii_lowercase().contains("<think>") {
            return Ok(TestVisionResult {
                ok: false,
                duration_ms,
                text: snippet(&raw_text, 240),
                error: Some(format!(
                    "模型只返回了推理内容，未输出最终图片判断：{}",
                    snippet(&raw_text, 180)
                )),
            });
        }
        raw_text.trim().to_string()
    } else {
        text
    };
    if text.trim().is_empty() {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: String::new(),
            error: Some("模型返回为空，未确认图片理解能力".to_string()),
        });
    }
    if let Some(reason) = vision_missing_reason(&text) {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: snippet(&text, 240),
            error: Some(format!("{}：{}", reason, snippet(&text, 180))),
        });
    }
    if !vision_seen_answer_ok(&text) {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: snippet(&text, 240),
            error: Some(format!(
                "模型没有按要求回答「能看到图片」：{}",
                snippet(&text, 180)
            )),
        });
    }
    let content_hits = vision_content_hit_count(&text);
    if content_hits < 3 {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: snippet(&text, 240),
            error: Some(format!(
                "模型没有描述出测试图中的颜色/文字特征：{}",
                snippet(&text, 180)
            )),
        });
    }

    if let Err(e) = mark_model_vision(provider_id, model) {
        eprintln!("[config] mark model vision skipped: {}", e);
    }
    Ok(TestVisionResult {
        ok: true,
        duration_ms,
        text: snippet(&text, 240),
        error: None,
    })
}

