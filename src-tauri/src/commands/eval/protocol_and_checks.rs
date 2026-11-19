use serde_json::Value;
use crate::commands::config::{ApiFormat, Provider};
use super::*;
use super::requests::*;
use super::scoring_and_reports::*;

pub(super) fn protocol_gemini_urls(
    provider: &Provider,
    api_format: ApiFormat,
    model: &str,
) -> (String, String) {
    let base = protocol_base_url(provider, api_format);
    let is_vertex = crate::commands::google_gemini::is_vertex_endpoint(
        &provider.api_host,
        provider.api_path.as_deref(),
    );
    let gemini_native_url = if is_vertex || matches!(api_format, ApiFormat::Gemini) {
        api_url(provider, ApiFormat::Gemini, model)
    } else {
        format!(
            "{}/v1beta/models/{}:generateContent",
            base,
            model.trim().strip_prefix("models/").unwrap_or(model.trim())
        )
    };
    let gemini_openai_url = format!("{}{}", base, "/v1beta/openai/chat/completions");
    (gemini_native_url, gemini_openai_url)
}

pub(super) async fn run_protocol_checks(ctx: &mut EvalContext) -> Vec<EvalCheck> {
    let base = protocol_base_url(&ctx.provider, ctx.api_format);
    let primary_key = provider_protocol_key(&ctx.provider, ctx.api_format);
    let (gemini_native_url, gemini_openai_url) =
        protocol_gemini_urls(&ctx.provider, ctx.api_format.clone(), &ctx.model);
    let candidates = vec![
        (
            "openai_chat",
            "OpenAI Chat",
            ApiFormat::Openai,
            format!("{}{}", base, "/v1/chat/completions"),
        ),
        (
            "anthropic_messages",
            "Claude Messages",
            ApiFormat::Anthropic,
            format!("{}{}", base, "/v1/messages"),
        ),
        (
            "gemini_openai",
            "Gemini OpenAI 兼容",
            ApiFormat::Openai,
            gemini_openai_url,
        ),
        (
            "gemini_native",
            "Gemini 原生",
            ApiFormat::Gemini,
            gemini_native_url,
        ),
    ];
    let mut out = Vec::new();
    for (key, label, fmt, url) in candidates {
        let is_primary = key == primary_key;
        let body = protocol_probe_body(&fmt, &ctx.model);
        let check = match send_protocol_json(ctx, &fmt, &url, body).await {
            Ok((status, text)) => {
                let json = serde_json::from_str::<Value>(&text).ok();
                let response_text = json
                    .as_ref()
                    .map(|j| extract_text_by_format(&fmt, j))
                    .unwrap_or_default();
                let ok_status = (200..300).contains(&status);
                let has_text = !response_text.trim().is_empty();
                let mut status_label = if ok_status && has_text {
                    "supported"
                } else if ok_status && json.is_some() {
                    "partial"
                } else {
                    "unsupported"
                };
                if !is_primary && status_label == "unsupported" {
                    status_label = "optional";
                }
                EvalCheck {
                    key: key.into(),
                    label: label.into(),
                    status: status_label.into(),
                    detail: if ok_status && has_text {
                        format!("HTTP {}，响应文本正常", status)
                    } else if !is_primary {
                        format!("可选入口未适配（HTTP {}），不影响当前配置", status)
                    } else if ok_status {
                        format!("HTTP {}，但文本为空或结构不完整", status)
                    } else {
                        format!("HTTP {}", status)
                    },
                    evidence: vec![
                        url.clone(),
                        if is_primary {
                            "role=current".into()
                        } else {
                            "role=optional".into()
                        },
                        snippet(&text, 180),
                    ],
                }
            }
            Err(e) => EvalCheck {
                key: key.into(),
                label: label.into(),
                status: if is_primary {
                    "unsupported"
                } else {
                    "optional"
                }
                .into(),
                detail: if is_primary {
                    "当前入口请求失败".into()
                } else {
                    "可选入口请求失败，不影响当前配置".into()
                },
                evidence: vec![
                    url.clone(),
                    if is_primary {
                        "role=current".into()
                    } else {
                        "role=optional".into()
                    },
                    redact(&ctx.provider, &e),
                ],
            },
        };
        out.push(check);
    }
    out
}

pub(super) fn provider_protocol_key(provider: &Provider, api_format: ApiFormat) -> &'static str {
    match api_format {
        ApiFormat::Anthropic => "anthropic_messages",
        ApiFormat::Gemini => "gemini_native",
        ApiFormat::Openai => {
            let endpoint = format!(
                "{} {}",
                provider.api_host.to_ascii_lowercase(),
                provider
                    .api_path
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
            );
            if endpoint.contains("/v1beta/openai/chat/completions") {
                "gemini_openai"
            } else {
                "openai_chat"
            }
        }
    }
}

pub(super) fn protocol_probe_body(fmt: &ApiFormat, model: &str) -> Value {
    match fmt {
        ApiFormat::Openai => serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "max_tokens": 16,
            "temperature": 0,
            "stream": false
        }),
        ApiFormat::Anthropic => serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "max_tokens": 16,
            "temperature": 0,
            "stream": false
        }),
        ApiFormat::Gemini => serde_json::json!({
            "contents": [{"role": "user", "parts": [{"text": "Reply with exactly: OK"}]}],
            "generationConfig": {
                "maxOutputTokens": 512,
                "temperature": 0
            }
        }),
    }
}

pub(super) fn protocol_base_url(provider: &Provider, api_format: ApiFormat) -> String {
    let host = provider.api_host.trim().trim_end_matches('/');
    let host = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    let normalized_anthropic_path;
    let path = match api_format {
        ApiFormat::Anthropic => {
            normalized_anthropic_path = normalize_anthropic_api_path(provider.api_path.as_deref());
            normalized_anthropic_path.as_str()
        }
        ApiFormat::Openai => provider.api_path.as_deref().unwrap_or_default(),
        ApiFormat::Gemini => provider.api_path.as_deref().unwrap_or_default(),
    };
    let known_suffixes = [
        "/v1/chat/completions",
        "/v1beta/openai/chat/completions",
        "/v1beta/openai",
        "/openai",
        "/v1/messages",
        "/v1beta",
        "/v1",
    ];
    for suffix in known_suffixes {
        if path.ends_with(suffix) {
            let keep = path.trim_end_matches(suffix).trim_end_matches('/');
            return format!("{}{}", host, keep);
        }
        if host.ends_with(suffix) {
            return host
                .trim_end_matches(suffix)
                .trim_end_matches('/')
                .to_string();
        }
    }
    host
}

pub(super) async fn apply_eval_auth_headers(
    client: &reqwest::Client,
    req: reqwest::RequestBuilder,
    fmt: &ApiFormat,
    provider: &Provider,
    url: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    match fmt {
        ApiFormat::Openai => Ok(req.header("Authorization", format!("Bearer {}", provider.api_key))),
        ApiFormat::Gemini => {
            crate::commands::google_gemini::apply_gemini_auth(client, req, &provider.api_key).await
        }
        ApiFormat::Anthropic => {
            let req = req.header("anthropic-version", "2023-06-01");
            if is_deepseek_anthropic_provider(provider)
                || url.map_or(false, is_deepseek_anthropic_url)
            {
                Ok(req.header("Authorization", format!("Bearer {}", provider.api_key)))
            } else {
                Ok(req.header("x-api-key", &provider.api_key))
            }
        }
    }
}

pub(super) fn gzip_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}


pub(super) fn build_capability_checks(ctx: &EvalContext, probes: &[EvalProbeResult]) -> Vec<EvalCheck> {
    let probe = |id: &str| probes.iter().find(|p| p.id == id);
    let status_from_probe = |p: Option<&EvalProbeResult>| match p.map(|p| p.status.as_str()) {
        Some("pass") => "supported",
        Some("warn") => "partial",
        Some("fail") | Some("error") => "unsupported",
        Some("skip") | None => "unknown",
        _ => "unknown",
    };
    let detail_from_probe = |p: Option<&EvalProbeResult>| {
        p.map(|p| p.summary.clone())
            .unwrap_or_else(|| "未检测".into())
    };
    let evidence_from_probe =
        |p: Option<&EvalProbeResult>| p.map(|p| p.evidence.clone()).unwrap_or_default();
    let usage_supported = ctx.usage.input_tokens > 0 || ctx.usage.output_tokens > 0;
    let reasoning_seen = probes.iter().any(|p| {
        p.evidence
            .iter()
            .any(|e| e.to_ascii_lowercase().contains("reasoning"))
    });
    let mut checks = vec![
        EvalCheck {
            key: "text".into(),
            label: "文本生成".into(),
            status: status_from_probe(probe("P1")).into(),
            detail: detail_from_probe(probe("P1")),
            evidence: evidence_from_probe(probe("P1")),
        },
        EvalCheck {
            key: "stream".into(),
            label: "流式传输".into(),
            status: status_from_probe(probe("P5")).into(),
            detail: detail_from_probe(probe("P5")),
            evidence: evidence_from_probe(probe("P5")),
        },
        EvalCheck {
            key: "tools".into(),
            label: "工具调用".into(),
            status: status_from_probe(probe("P6")).into(),
            detail: detail_from_probe(probe("P6")),
            evidence: evidence_from_probe(probe("P6")),
        },
        EvalCheck {
            key: "vision".into(),
            label: "图片理解".into(),
            status: status_from_probe(probe("P12")).into(),
            detail: detail_from_probe(probe("P12")),
            evidence: evidence_from_probe(probe("P12")),
        },
        EvalCheck {
            key: "json".into(),
            label: "JSON 输出".into(),
            status: status_from_probe(probe("P9")).into(),
            detail: detail_from_probe(probe("P9")),
            evidence: evidence_from_probe(probe("P9")),
        },
        EvalCheck {
            key: "usage".into(),
            label: "Token 计量".into(),
            status: if usage_supported {
                "supported"
            } else {
                "unknown"
            }
            .into(),
            detail: format!(
                "input={} / output={}",
                ctx.usage.input_tokens, ctx.usage.output_tokens
            ),
            evidence: vec![format!("request_count={}", ctx.usage.request_count)],
        },
        EvalCheck {
            key: "model_id".into(),
            label: "模型回显".into(),
            status: status_from_probe(probe("P7")).into(),
            detail: detail_from_probe(probe("P7")),
            evidence: evidence_from_probe(probe("P7")),
        },
        EvalCheck {
            key: "prompt_injection".into(),
            label: "注入防护".into(),
            status: match probe("P14").map(|p| p.status.as_str()) {
                Some("pass") => "supported",
                Some("warn") => "partial",
                Some("fail") | Some("error") => "unsupported",
                Some("skip") | None => "unknown",
                _ => "unknown",
            }
            .into(),
            detail: detail_from_probe(probe("P14")),
            evidence: evidence_from_probe(probe("P14")),
        },
    ];
    checks.push(EvalCheck {
        key: "reasoning".into(),
        label: "Reasoning 内容".into(),
        status: if reasoning_seen {
            "supported"
        } else {
            "unknown"
        }
        .into(),
        detail: if reasoning_seen {
            "响应中检测到 reasoning 字段".into()
        } else {
            "未在本次检测中发现 reasoning 字段".into()
        },
        evidence: Vec::new(),
    });
    checks
}

pub(super) fn build_protocol_checks(ctx: &EvalContext, probes: &[EvalProbeResult]) -> Vec<EvalCheck> {
    if !ctx.protocol_checks.is_empty() {
        return ctx.protocol_checks.clone();
    }
    let current = match ctx.api_format {
        ApiFormat::Openai => ("openai_chat", "OpenAI Chat"),
        ApiFormat::Anthropic => ("anthropic_messages", "Claude Messages"),
        ApiFormat::Gemini => ("gemini_native", "Gemini Native"),
    };
    let p1 = probes.iter().find(|p| p.id == "P1");
    vec![EvalCheck {
        key: current.0.into(),
        label: current.1.into(),
        status: match p1.map(|p| p.status.as_str()) {
            Some("pass") => "supported",
            Some("warn") => "partial",
            Some("fail") | Some("error") => "unsupported",
            _ => "unknown",
        }
        .into(),
        detail: p1
            .map(|p| p.summary.clone())
            .unwrap_or_else(|| "未检测".into()),
        evidence: p1.map(|p| p.evidence.clone()).unwrap_or_default(),
    }]
}

pub(super) fn has_prompt_leak_hint(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("system prompt")
        || lower.contains("developer message")
        || lower.contains("hidden instruction")
        || lower.contains("initial instruction")
        || lower.contains("系统提示")
        || lower.contains("开发者消息")
        || lower.contains("隐藏指令")
        || lower.contains("初始指令")
}

pub(super) fn has_relay_wrapper_hint(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let hints = [
        "relay",
        "proxy",
        "gateway",
        "router",
        "route",
        "channel",
        "upstream",
        "base_url",
        "api_base",
        "api key",
        "one-api",
        "new-api",
        "中转",
        "转发",
        "网关",
        "路由",
        "渠道",
        "上游",
        "模型映射",
        "供应商",
    ];
    let hit_count = hints.iter().filter(|h| lower.contains(**h)).count();
    hit_count >= 2 && has_prompt_leak_hint(text)
}

pub(super) fn has_script_injection_hint(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("</script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onclick=")
        || lower.contains("<iframe")
        || lower.contains("document.cookie")
        || lower.contains("localstorage")
}

pub(super) fn add_check(evidence: &mut Vec<String>, passed: &mut f64, ok: bool, label: &str) {
    if ok {
        *passed += 1.0;
        evidence.push(format!("{} ✓", label));
    } else {
        evidence.push(format!("{} ×", label));
    }
}

pub(super) fn stream_has_done(body: &str, fmt: &ApiFormat) -> bool {
    match fmt {
        ApiFormat::Openai => {
            body.contains("[DONE]")
                || body.contains("response.completed")
                || body.contains("\"type\":\"done\"")
                || body.contains("\"type\":\"response.completed\"")
        }
        ApiFormat::Anthropic => {
            body.contains("message_stop") || body.contains("\"type\":\"message_stop\"")
        }
        ApiFormat::Gemini => {
            body.contains("finishReason") || body.contains("finish_reason") || body.contains("STOP")
        }
    }
}

pub(super) fn sse_data_event_count(body: &str) -> usize {
    body.lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with("data:") {
                return None;
            }
            let data = line.trim_start_matches("data:").trim();
            (!data.is_empty() && data != "[DONE]").then_some(())
        })
        .count()
}

pub(super) fn stream_text(body: &str) -> String {
    let mut out = String::new();
    for line in body.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let data = line.trim_start_matches("data:").trim();
        if data == "[DONE]" {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            if let Some(s) = v
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
            {
                out.push_str(s);
            }
            if let Some(s) = v
                .pointer("/choices/0/delta/reasoning_content")
                .and_then(Value::as_str)
            {
                out.push_str(s);
            }
            if let Some(s) = v
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
            {
                out.push_str(s);
            }
            if let Some(s) = v.get("delta").and_then(Value::as_str) {
                out.push_str(s);
            }
            if let Some(s) = v
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
            {
                out.push_str(s);
            }
            if let Some(s) = v
                .get("content_block")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
            {
                out.push_str(s);
            }
            let gemini_chunk = crate::commands::google_gemini::extract_gemini_non_thought_text(&v);
            if !gemini_chunk.is_empty() {
                out.push_str(&gemini_chunk);
            }
        }
    }
    out
}

pub(super) fn stream_output_tokens(_fmt: &ApiFormat, body: &str) -> Option<u64> {
    let mut best = None;
    for line in body.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let data = line.trim_start_matches("data:").trim();
        if data == "[DONE]" {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        let candidate = v
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64)
            .or_else(|| v.pointer("/usage/output_tokens").and_then(Value::as_u64))
            .or_else(|| {
                v.pointer("/message/usage/output_tokens")
                    .and_then(Value::as_u64)
            })
            .or_else(|| {
                v.pointer("/usageMetadata/candidatesTokenCount")
                    .and_then(Value::as_u64)
            })
            .or_else(|| {
                v.pointer("/usage_metadata/candidates_token_count")
                    .and_then(Value::as_u64)
            });
        if let Some(tokens) = candidate {
            best = Some(best.map(|b: u64| b.max(tokens)).unwrap_or(tokens));
        }
    }
    best
}

pub(super) fn stream_reported_model(body: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let data = line.trim_start_matches("data:").trim();
        if data == "[DONE]" {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(model) = v
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| v.pointer("/message/model").and_then(Value::as_str))
            .or_else(|| v.get("modelVersion").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(model.to_string());
        }
    }
    None
}

pub(super) fn estimate_tokens(text: &str) -> u64 {
    let chars = text.chars().filter(|c| !c.is_whitespace()).count() as u64;
    let words = text.split_whitespace().count() as u64;
    words.max((chars + 3) / 4).max(1)
}

