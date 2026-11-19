use serde::{Deserialize, Serialize};
use super::probe_vision::*;
use super::{read_provider_store, APP_USER_AGENT};

/// 按 host + key 在 providers.json 里找到对应供应商，返回它自己配置的模型。
/// 供「测试连接没指定模型」时使用，保证测的就是该供应商真实会用的模型。
pub(super) fn provider_model_for_probe(host: &str, api_key: &str) -> Option<String> {
    let store = read_provider_store().ok()?;
    let host_norm = host.trim_end_matches('/').to_ascii_lowercase();
    let key_norm = api_key.trim();
    for p in &store.providers {
        if p.enabled == false {
            continue;
        }
        let p_host = p.api_host.trim_end_matches('/').to_ascii_lowercase();
        if !host_norm.is_empty() && !p_host.is_empty() && p_host != host_norm {
            continue;
        }
        if !key_norm.is_empty() && !p.api_key.trim().is_empty() && p.api_key.trim() != key_norm {
            continue;
        }
        let default = p.default_model.trim();
        if !default.is_empty() {
            return Some(default.to_string());
        }
        let first = p.models.iter().map(|m| m.trim()).find(|m| !m.is_empty())?;
        return Some(first.to_string());
    }
    None
}

/// 响应体是否是标准 JSON 错误（业务拒绝），用于区分「上游业务错误」和「WAF 拦截」。
pub(super) fn is_json_api_error(body: &str) -> bool {
    let text = body.trim();
    if text.is_empty() || text.starts_with('<') {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(text).is_ok()
}

/// 探针请求的输出上限。OpenAI Responses 语义要求 `max_output_tokens >= 16`，部分
/// 严格上游（CPA 等把 chat 的 `max_tokens` 映射成 Responses 后做同值校验）会 400
/// 拒绝更小的值，把正常渠道测成假阴性（issue #42）。探针只验连通与鉴权，取最小合法值。
pub(super) const PROBE_MAX_TOKENS: u64 = 16;

/// 探针请求体唯一构造点（openai responses / openai chat / anthropic / gemini 四路对称收敛）。
pub(super) fn probe_request_body(fmt: &str, uses_openai_responses: bool, model: &str) -> serde_json::Value {
    if fmt == "gemini" {
        serde_json::json!({
            "contents": [{"role": "user", "parts": [{"text": "hi"}]}]
        })
    } else if fmt == "openai" && uses_openai_responses {
        serde_json::json!({
            "model": model,
            "input": [{"role": "user", "content": "hi"}],
            "max_output_tokens": PROBE_MAX_TOKENS,
            "stream": false
        })
    } else {
        // openai chat 与 anthropic 都吃 max_tokens
        serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": PROBE_MAX_TOKENS,
            "stream": false
        })
    }
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

    let client = crate::commands::apply_system_proxy(
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(12)),
    )
    .build()
    .map_err(|e| e.to_string())?;

    // ── Chat 连通性探测（发送极简消息验证实际调用能力与延迟）──
    // 模型名策略（按顺序）：
    //   1) 调用方明确给了且非空白 → 用它；
    //   2) 没给 → 按 host + key 去 providers.json 找到该供应商，用它自己配置的模型；
    //   3) 该供应商压根没有模型 → 直接报错，不发请求。
    // 绝不硬编码 gpt-4o-mini / claude-3-haiku 这类"通用模型名"兜底：只卖国模的中转站
    // 根本没有这些模型，会把一个正常的渠道测成 "Invalid model id: gpt-4o-mini"（假阴性）。
    let requested_model = args
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string);

    let test_model: String = match requested_model {
        Some(model) => model,
        None => match provider_model_for_probe(&host, &args.api_key) {
            Some(model) => model,
            None => {
                return Err(
                    "这个供应商还没有配置任何模型，请先在编辑弹窗里添加或拉取模型，再测试连接。"
                        .to_string(),
                )
            }
        },
    };
    let test_model = test_model.as_str();

    let (resolved_host, chat_path) = if fmt == "openai" {
        (
            host.clone(),
            normalize_openai_api_path(&host, args.path.as_deref()),
        )
    } else if fmt == "gemini" {
        crate::commands::google_gemini::resolve_gemini_endpoint(
            &host,
            args.path.as_deref(),
            test_model,
            &args.api_key,
        )
    } else {
        (
            host.clone(),
            normalize_anthropic_api_path(args.path.as_deref()),
        )
    };
    let uses_openai_responses =
        fmt == "openai" && chat_path.to_ascii_lowercase().contains("/responses");

    let (chat_body, auth_header, auth_value) = if fmt == "gemini" {
        let body = probe_request_body(fmt, uses_openai_responses, test_model);
        let (h, v) =
            crate::commands::google_gemini::resolve_gemini_auth_header_pair(&client, &args.api_key).await?;
        (serde_json::to_vec(&body).unwrap(), h, v)
    } else if fmt == "openai" && uses_openai_responses {
        let body = probe_request_body(fmt, uses_openai_responses, test_model);
        (
            serde_json::to_vec(&body).unwrap(),
            "Authorization".to_string(),
            format!("Bearer {}", args.api_key),
        )
    } else if fmt == "openai" {
        let body = probe_request_body(fmt, uses_openai_responses, test_model);
        (
            serde_json::to_vec(&body).unwrap(),
            "Authorization".to_string(),
            format!("Bearer {}", args.api_key),
        )
    } else {
        let body = probe_request_body(fmt, uses_openai_responses, test_model);
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

    let chat_url = format!("{}{}", resolved_host, chat_path);
    // 失败时把"用哪个模型、打到哪个地址"一起报出来，否则上游一句
    // "Invalid model id: " 之类的话根本没法判断是模型名错了还是链路错了。
    let test_hint = format!(
        "（本次测试模型：{}；目标地址：{}；协议：{}）",
        test_model, chat_url, fmt
    );

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
        if fmt == "anthropic" {
            req = req.header("anthropic-version", "2023-06-01");
        }
        req
    };

    let start = std::time::Instant::now();

    // 先发明文请求
    let plain_resp = send_req(chat_body.clone(), false).send().await;

    let need_gzip = match plain_resp {
        Ok(r) if r.status().is_success() => false,
        Ok(r) => {
            let status = r.status().as_u16();
            let err_body = r.text().await.unwrap_or_default();

            // 401 = 真正的认证失败
            if status == 401 {
                return Err(format!("认证失败 (HTTP 401)，请检查 API 密钥{}", test_hint));
            }

            // 只有「像 WAF 拦明文 body」才值得用 gzip 重发：403/406 且响应不是标准 JSON 错误
            // （空响应 / HTML 拦截页 / 纯文本）。
            // 像 {"error":{"message":"Invalid model id"}} 这种明确的业务错误再试一次毫无意义：
            // 既白花一次请求，还会把报错拼成 "HTTP 403 / Gzip HTTP 400" 这种天书。
            let looks_like_waf_block =
                (status == 403 || status == 406) && !is_json_api_error(&err_body);
            if !looks_like_waf_block {
                return Err(format!(
                    "上游返回错误：HTTP {}：{}{}",
                    status,
                    redact(snippet(&err_body, 200), &args.api_key),
                    test_hint
                ));
            }

            // 疑似 WAF 拦截 → 尝试用 gzip 重发（探测该渠道是否必须压缩提交）
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
                        return Err(format!(
                            "认证失败 (HTTP {})，请检查 API 密钥{}",
                            gz_status, test_hint
                        ));
                    }
                    let gz_body = r.text().await.unwrap_or_default();
                    let gz_snippet: String = gz_body.chars().take(200).collect();
                    return Err(format!(
                        "上游返回错误：明文 HTTP {}，Gzip 重发仍失败 HTTP {}：{}{}",
                        status, gz_status, gz_snippet, test_hint
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "明文 HTTP {}，Gzip 重发网络错误: {}{}",
                        status,
                        redact(e.to_string(), &args.api_key),
                        test_hint
                    ));
                }
            }
        }
        Err(e) => {
            return Err(redact(
                format!("网络错误: {}{}", e, test_hint),
                &args.api_key,
            ))
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let msg = if need_gzip {
        format!("连通 ({}ms, 需Gzip)", duration_ms)
    } else {
        format!("连通 ({}ms)", duration_ms)
    };

    Ok(TestConnResult {
        message: msg,
        latency_ms: duration_ms,
        capabilities: TestCapabilities {
            gzip: need_gzip,
            vision: false,
            tools: false,
        },
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

pub(super) const MODEL_FETCH_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

pub(super) fn path_ends_with_version_segment(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or_default();
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

pub(super) fn strip_model_fetch_compat_suffix(path: &str) -> Option<&str> {
    MODEL_FETCH_COMPAT_SUFFIXES
        .iter()
        .find_map(|suffix| path.strip_suffix(suffix))
}

pub(super) fn build_fetch_model_url(host: &str, fmt: &str, path: &str) -> String {
    if fmt == "gemini" {
        let (origin, _) = crate::commands::google_gemini::host_scheme_and_origin(host);
        let base = if origin.is_empty() {
            host.trim_end_matches('/').to_string()
        } else {
            origin
        };
        return format!("{}{}", base, path);
    }
    format!("{}{}", host.trim_end_matches('/'), path)
}

#[tauri::command]
pub async fn fetch_models(args: FetchModelsArgs) -> Result<FetchModelsResult, String> {
    let host = args.host.trim_end_matches('/');
    let host = if host.starts_with("http") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };

    let client = crate::commands::apply_system_proxy(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(8))
            .user_agent(APP_USER_AGENT),
    )
    .build()
    .map_err(|e| e.to_string())?;

    let fmt = args.api_format.as_deref().unwrap_or("anthropic");
    let chat_path = if fmt == "openai" {
        normalize_openai_api_path(&host, args.path.as_deref())
    } else if fmt == "gemini" {
        normalize_gemini_api_path(&host, args.path.as_deref(), "gemini-2.5-flash")
    } else {
        normalize_anthropic_api_path(args.path.as_deref())
    };
    // Vertex AI 没有模型列表接口（Express Key 也不支持），直接返回明确指引：
    // 否则会对不存在的列表路径打 404，把上游 HTML 报错页丢给用户。
    if fmt == "gemini" && crate::commands::google_gemini::is_vertex_endpoint(&host, Some(&chat_path)) {
        return Err("Google Vertex AI 不支持在线拉取模型列表：模型已在模板中预置，也可在编辑页底部手动添加模型 ID".to_string());
    }
    let gemini_auth = if fmt == "gemini" {
        Some(crate::commands::google_gemini::resolve_gemini_auth_header_pair(&client, &args.api_key).await?)
    } else {
        None
    };
    // 按协议分发凭证头；DeepSeek 的 Anthropic 兼容入口使用 Bearer。
    // 避免把 key 同时塞进两种头发给非预期端点。
    let auth = |req: reqwest::RequestBuilder| {
        if let Some((ref h, ref v)) = gemini_auth {
            req.header(h.as_str(), v.as_str())
        } else if fmt == "openai" {
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
    if fmt == "gemini" {
        model_paths.extend(crate::commands::google_gemini::build_gemini_model_list_paths(
            &host,
            args.path.as_deref(),
        ));
    } else if !base_path.is_empty() {
        model_paths.push(format!("{}/models", base_path.trim_end_matches('/')));
    } else if fmt == "openai" && !chat_path.is_empty() {
        let openai_base = chat_path.trim_end_matches('/');
        if lower_path.ends_with("/models") {
            model_paths.push(openai_base.to_string());
        } else if path_ends_with_version_segment(openai_base) {
            model_paths.push(format!("{}/models", openai_base));
            if !openai_base.ends_with("/v1") {
                model_paths.push(format!("{}/v1/models", openai_base));
            }
        } else {
            model_paths.push(format!("{}/v1/models", openai_base));
        }

        if let Some(stripped) = strip_model_fetch_compat_suffix(openai_base) {
            let stripped = stripped.trim_end_matches('/');
            if !stripped.is_empty() {
                model_paths.push(format!("{}/v1/models", stripped));
                model_paths.push(format!("{}/models", stripped));
            }
        }
    }
    model_paths.push("/v1/models".to_string());
    model_paths.push("/models".to_string());
    model_paths.dedup();

    let mut resp = None;
    let mut attempts = Vec::new();
    eprintln!(
        "[fetch_models] host={} fmt={} key_len={} paths={:?}",
        host,
        fmt,
        args.api_key.len(),
        model_paths
    );
    for path in model_paths {
        let url = build_fetch_model_url(&host, fmt, &path);
        let req = auth(client.get(&url).header("Accept", "application/json"));
        match req.send().await {
            Ok(r) if r.status().is_success() => {
                eprintln!("[fetch_models] {} -> HTTP {} (成功)", path, r.status());
                resp = Some(r);
                break;
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(180).collect();
                if snippet.trim().is_empty() {
                    attempts.push(format!("{}: HTTP {}", path, status.as_u16()));
                } else {
                    attempts.push(format!(
                        "{}: HTTP {} {}",
                        path,
                        status.as_u16(),
                        snippet.replace(char::is_whitespace, " ")
                    ));
                }
            }
            Err(e) => {
                attempts.push(format!(
                    "{}: 网络错误 {}",
                    path,
                    redact(e.to_string(), &args.api_key)
                ));
            }
        }
    }

    let Some(r) = resp else {
        let detail = if attempts.is_empty() {
            "没有收到任何响应".to_string()
        } else {
            attempts.join("；")
        };
        // 本机网关拉不到时，把最常见也最容易误判的两个原因直接说清楚：
        // 服务没起（端口无人监听，网关层把连接失败转成 502/网络错误）、
        // 或者本地供应商里填的密钥与插件网关当前用的不是同一把（401）。
        let is_local = host.contains("127.0.0.1")
            || host.contains("localhost")
            || host.contains("[::1]")
            || host.contains("0.0.0.0");
        let hint = if !is_local {
            String::new()
        } else if attempts
            .iter()
            .any(|a| a.contains("401") || a.to_ascii_lowercase().contains("invalid_api_key"))
        {
            "。网关返回 401：本地供应商里填的 API 密钥与插件网关当前使用的不是同一把，请到「扩展中心」重新生成插件配置并保存供应商".to_string()
        } else {
            "。本地地址拉取失败通常是插件服务未启动，请先到「扩展中心」启动对应插件后再试".to_string()
        };
        eprintln!("[fetch_models] 全部失败: {}", detail);
        return Err(format!("模型列表拉取失败：{}{}", detail, hint));
    };

    let body: serde_json::Value = r.json().await.map_err(|e| format!("解析失败: {}", e))?;

    let mut models = Vec::new();

    let clean_model_name = |s: &str| -> String {
        s.trim().strip_prefix("models/").unwrap_or(s.trim()).to_string()
    };

    if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(clean_model_name(id));
            }
        }
    } else if let Some(arr) = body.as_array() {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(clean_model_name(id));
            } else if let Some(id) = item.as_str() {
                models.push(clean_model_name(id));
            }
        }
    } else if fmt == "gemini" && body.get("models").and_then(|v| v.as_array()).is_some() {
        let arr = body.get("models").and_then(|v| v.as_array()).unwrap();
        let mut gen_models = Vec::new();
        let mut fallback_models = Vec::new();
        for item in arr {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("id").and_then(|v| v.as_str()));
            let Some(name) = name else { continue };
            let cleaned = clean_model_name(name);
            if cleaned.is_empty() {
                continue;
            }
            fallback_models.push(cleaned.clone());
            let supports_generate = item
                .get("supportedGenerationMethods")
                .and_then(|v| v.as_array())
                .map(|methods| {
                    methods.is_empty()
                        || methods
                            .iter()
                            .any(|m| m.as_str() == Some("generateContent"))
                })
                .unwrap_or(true);
            if supports_generate {
                gen_models.push(cleaned);
            }
        }
        models = if !gen_models.is_empty() {
            gen_models
        } else {
            fallback_models
        };
    } else if let Some(obj) = body.as_object() {
        for (_k, val) in obj {
            if let Some(arr) = val.as_array() {
                for item in arr {
                    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                        models.push(clean_model_name(id));
                    } else if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        models.push(clean_model_name(name));
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

