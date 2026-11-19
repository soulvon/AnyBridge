use serde_json::Value;
use std::time::Instant;
use crate::commands::config::ApiFormat;
use super::*;
use super::requests::*;
use super::scoring_and_reports::*;

pub(super) async fn try_connectivity_once(
    ctx: &mut EvalContext,
    body: &Value,
) -> Result<(JsonCall, EvalProbeResult), EvalProbeResult> {
    let started = Instant::now();
    match call_json(ctx, body.clone()).await {
        Ok(call) => {
            let status = call.status;
            let latency = call.latency_ms;
            let text = call
                .json
                .as_ref()
                .map(|json| extract_text(ctx, json))
                .unwrap_or_default();
            if (200..300).contains(&call.status) && call.json.is_some() && !text.trim().is_empty() {
                let text_kind = call
                    .json
                    .as_ref()
                    .map(|json| extracted_text_kind(&ctx.api_format, json))
                    .unwrap_or("content");
                Ok((
                    call,
                    probe(
                        "P1",
                        "协议连通性",
                        "pass",
                        100.0,
                        12.0,
                        Some(latency),
                        if text_kind == "reasoning" {
                            "最小推理请求成功（仅检测到 reasoning 内容）"
                        } else {
                            "最小推理请求成功"
                        },
                        vec![
                            format!("HTTP {}", status),
                            format!("耗时 {}ms", latency),
                            format!("文本来源: {}", text_kind),
                        ],
                    ),
                ))
            } else if (200..300).contains(&call.status) && call.json.is_some() {
                Ok((
                    call,
                    probe(
                        "P1",
                        "协议连通性",
                        "warn",
                        60.0,
                        12.0,
                        Some(latency),
                        "HTTP 成功但响应文本为空",
                        vec![
                            format!("HTTP {}", status),
                            "接口连通，但 message/content 或 reasoning_content 为空".into(),
                        ],
                    ),
                ))
            } else {
                let (summary, hint) = classify_http_failure(call.status, &call.body_text);
                Err(probe(
                    "P1",
                    "协议连通性",
                    "fail",
                    0.0,
                    12.0,
                    Some(latency),
                    &summary,
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 180),
                        hint,
                    ],
                ))
            }
        }
        Err(e) => {
            let (summary, hint) = classify_network_error(&e);
            Err(probe(
                "P1",
                "协议连通性",
                "fail",
                0.0,
                12.0,
                Some(started.elapsed().as_millis() as u64),
                &summary,
                vec![redact(&ctx.provider, &e), hint],
            ))
        }
    }
}

/// 判断 HTTP 错误是否值得重试（5xx / 429 / 502 / 503 / 504）
pub(super) fn is_retryable_http(probe_result: &EvalProbeResult) -> bool {
    probe_result
        .evidence
        .first()
        .map(|s| {
            let status = s.trim_start_matches("HTTP ").parse::<u16>().unwrap_or(0);
            status == 429 || (500..=504).contains(&status)
        })
        .unwrap_or(false)
}

/// 对 HTTP 响应失败进行分类，返回 (摘要, 排查提示)
pub(super) fn classify_http_failure(status: u16, body: &str) -> (String, String) {
    let summary = match status {
        401 => "认证失败（401 Unauthorized）".into(),
        403 => "访问被拒绝（403 Forbidden）".into(),
        404 => "接口地址不存在（404 Not Found）".into(),
        429 => "请求过于频繁（429 Too Many Requests）".into(),
        500 => "服务端内部错误（500）".into(),
        502 => "网关错误（502 Bad Gateway）".into(),
        503 => "服务暂不可用（503 Service Unavailable）".into(),
        504 => "网关超时（504 Gateway Timeout）".into(),
        s if s >= 400 && s < 500 => format!("客户端错误（HTTP {}）", s),
        s if s >= 500 => format!("服务端错误（HTTP {}）", s),
        s => format!("非标准响应（HTTP {}）", s),
    };
    let hint = match status {
        401 => "请检查 API Key 是否正确、是否已过期".into(),
        403 => "请确认该 API Key 有访问权限，或检查 IP 白名单设置".into(),
        404 => {
            let lower = body.to_ascii_lowercase();
            if lower.contains("unknown endpoint")
                || lower.contains("/v1/messages")
                || lower.contains("/v1/chat/completions")
            {
                "接口路径不存在，常见原因是供应商协议选错；OpenAI 兼容站点通常应使用 OpenAI + /v1/chat/completions".into()
            } else {
                "请检查 API 地址和路径是否正确".into()
            }
        }
        429 => "供应商限流，可稍后重试或降低请求频率".into(),
        502 | 503 | 504 => "供应商服务暂时不可用，请稍后重试".into(),
        _ => {
            let lower = body.to_ascii_lowercase();
            if lower.contains("invalid_api_key") || lower.contains("unauthorized") {
                "响应提示认证失败，请检查 API Key".into()
            } else if lower.contains("model_not_found") || lower.contains("does not exist") {
                "响应提示模型不存在，请确认模型名称".into()
            } else {
                format!("HTTP {} — 请检查供应商配置", status)
            }
        }
    };
    (summary, hint)
}

/// 对网络层错误进行分类，返回 (摘要, 排查提示)
pub(super) fn classify_network_error(e: &str) -> (String, String) {
    let lower = e.to_ascii_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        (
            "连接超时".into(),
            "请检查网络连接，或确认 API 地址是否可达".into(),
        )
    } else if lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("name resolution")
    {
        (
            "DNS 解析失败".into(),
            "请检查 API 域名是否正确，以及网络 DNS 设置".into(),
        )
    } else if lower.contains("connection refused") {
        (
            "连接被拒绝".into(),
            "目标服务器拒绝连接，请确认 API 地址和端口是否正确".into(),
        )
    } else if lower.contains("tls") || lower.contains("ssl") || lower.contains("certificate") {
        (
            "TLS/SSL 证书错误".into(),
            "HTTPS 证书验证失败，请检查证书或代理设置".into(),
        )
    } else if lower.contains("proxy") {
        ("代理连接失败".into(), "请检查系统代理设置是否正确".into())
    } else {
        ("网络连接失败".into(), "请检查网络连接是否正常".into())
    }
}

pub(super) async fn probe_connectivity_with_retries(
    ctx: &mut EvalContext,
    body: &Value,
) -> Result<(JsonCall, EvalProbeResult), EvalProbeResult> {
    let max_retries = 2u32;

    for attempt in 0..=max_retries {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        match try_connectivity_once(ctx, body).await {
            Ok(result) => return Ok(result),
            Err(p) => {
                // 仅在首次尝试且错误可重试时继续重试
                if attempt < max_retries && is_retryable_http(&p) {
                    continue;
                }
                // 网络错误（非 HTTP 响应）也重试
                if attempt < max_retries
                    && p.evidence
                        .first()
                        .map(|s| !s.starts_with("HTTP "))
                        .unwrap_or(false)
                {
                    continue;
                }
                // 添加重试信息到 evidence
                let mut final_probe = p;
                if attempt > 0 {
                    final_probe.evidence.push(format!("已重试 {} 次", attempt));
                }
                return Err(final_probe);
            }
        }
    }
    // 不可达
    unreachable!()
}

/// 带重试的连通性探针。协议由本次评测请求显式指定；失败时直接暴露。
pub(super) async fn probe_connectivity(
    ctx: &mut EvalContext,
) -> Result<(JsonCall, EvalProbeResult), EvalProbeResult> {
    let body = chat_body(ctx, "Reply with exactly: OK", false, 64, None);
    probe_connectivity_with_retries(ctx, &body).await
}

pub(super) fn probe_response_structure(ctx: &EvalContext, call: &JsonCall) -> EvalProbeResult {
    let Some(json) = call.json.as_ref() else {
        return probe(
            "P2",
            "响应结构",
            "fail",
            0.0,
            8.0,
            Some(call.latency_ms),
            "响应不是 JSON",
            vec![snippet(&call.body_text, 180)],
        );
    };
    let mut checks = Vec::new();
    let mut passed = 0.0;
    let total;
    match ctx.api_format {
        ApiFormat::Openai => {
            total = 6.0;
            add_check(
                &mut checks,
                &mut passed,
                json.get("id").and_then(Value::as_str).is_some(),
                "id",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("object").and_then(Value::as_str).is_some(),
                "object",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("model").and_then(Value::as_str).is_some(),
                "model",
            );
            if uses_openai_responses(ctx) {
                add_check(
                    &mut checks,
                    &mut passed,
                    json.get("output")
                        .and_then(|o| o.as_array())
                        .map_or(false, |arr| {
                            arr.iter().any(|item| {
                                item.get("type").and_then(Value::as_str) == Some("message")
                            })
                        })
                        || json.get("output_text").and_then(Value::as_str).is_some(),
                    "response output",
                );
            } else {
                let msg = json.pointer("/choices/0/message");
                add_check(
                    &mut checks,
                    &mut passed,
                    msg.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant"),
                    "assistant role",
                );
            }
            add_check(
                &mut checks,
                &mut passed,
                extract_text(ctx, json).trim().len() > 0,
                "content",
            );
            add_check(
                &mut checks,
                &mut passed,
                usage_has_numbers_openai(json),
                "usage",
            );
        }
        ApiFormat::Anthropic => {
            total = 6.0;
            add_check(
                &mut checks,
                &mut passed,
                json.get("id").and_then(Value::as_str).is_some(),
                "id",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("type").and_then(Value::as_str) == Some("message"),
                "type=message",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("role").and_then(Value::as_str) == Some("assistant"),
                "assistant role",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("model").and_then(Value::as_str).is_some(),
                "model",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("content").and_then(Value::as_array).is_some(),
                "content blocks",
            );
            add_check(
                &mut checks,
                &mut passed,
                usage_has_numbers_anthropic(json),
                "usage",
            );
        }
        ApiFormat::Gemini => {
            total = 5.0;
            let candidates = json.get("candidates").and_then(Value::as_array);
            add_check(
                &mut checks,
                &mut passed,
                candidates.map_or(false, |c| !c.is_empty()),
                "candidates",
            );
            let role = json.pointer("/candidates/0/content/role").and_then(Value::as_str);
            add_check(
                &mut checks,
                &mut passed,
                role == Some("model"),
                "model role",
            );
            let parts = json.pointer("/candidates/0/content/parts").and_then(Value::as_array);
            add_check(
                &mut checks,
                &mut passed,
                parts.map_or(false, |p| !p.is_empty()),
                "content parts",
            );
            add_check(
                &mut checks,
                &mut passed,
                extract_text(ctx, json).trim().len() > 0,
                "text content",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("usageMetadata").or_else(|| json.get("usage_metadata")).is_some(),
                "usageMetadata",
            );
        }
    }
    let score = (passed / total) * 100.0;
    let status = status_from_score(score);
    probe(
        "P2",
        "响应结构",
        status,
        score,
        8.0,
        Some(call.latency_ms),
        &format!("结构覆盖率 {:.0}%", score),
        checks,
    )
}

pub(super) fn probe_response_signature(ctx: &EvalContext, call: &JsonCall) -> EvalProbeResult {
    let Some(json) = call.json.as_ref() else {
        return probe(
            "P3",
            "响应签名",
            "fail",
            0.0,
            8.0,
            Some(call.latency_ms),
            "响应不是 JSON",
            vec![],
        );
    };
    let mut checks = Vec::new();
    let mut passed = 0.0;
    let total;
    match ctx.api_format {
        ApiFormat::Openai => {
            total = 5.0;
            let id = json.get("id").and_then(Value::as_str).unwrap_or("");
            add_check(
                &mut checks,
                &mut passed,
                !id.trim().is_empty(),
                "id present",
            );
            let obj = json.get("object").and_then(Value::as_str).unwrap_or("");
            let object_ok = if uses_openai_responses(ctx) {
                obj == "response" || obj.contains("response")
            } else {
                obj.contains("chat.completion") || obj.contains("completion")
            };
            add_check(&mut checks, &mut passed, object_ok, "object literal");
            if uses_openai_responses(ctx) {
                let status = json.get("status").and_then(Value::as_str).unwrap_or("");
                add_check(
                    &mut checks,
                    &mut passed,
                    matches!(status, "completed" | "incomplete" | "failed" | ""),
                    "status enum",
                );
            } else {
                let finish = json
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                add_check(
                    &mut checks,
                    &mut passed,
                    matches!(
                        finish,
                        "stop" | "length" | "tool_calls" | "content_filter" | ""
                    ),
                    "finish_reason enum",
                );
            }
            add_check(
                &mut checks,
                &mut passed,
                json.get("model").and_then(Value::as_str).is_some(),
                "model field",
            );
            add_check(
                &mut checks,
                &mut passed,
                usage_has_numbers_openai(json),
                "integer usage",
            );
        }
        ApiFormat::Anthropic => {
            total = 5.0;
            let id = json.get("id").and_then(Value::as_str).unwrap_or("");
            add_check(
                &mut checks,
                &mut passed,
                id.starts_with("msg_"),
                "Anthropic msg_ id",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("type").and_then(Value::as_str) == Some("message"),
                "type literal",
            );
            let stop = json
                .get("stop_reason")
                .and_then(Value::as_str)
                .unwrap_or("");
            add_check(
                &mut checks,
                &mut passed,
                matches!(
                    stop,
                    "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | ""
                ),
                "stop_reason enum",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("model").and_then(Value::as_str).is_some(),
                "model field",
            );
            add_check(
                &mut checks,
                &mut passed,
                usage_has_numbers_anthropic(json),
                "integer usage",
            );
        }
        ApiFormat::Gemini => {
            total = 4.0;
            let finish = json
                .pointer("/candidates/0/finishReason")
                .or_else(|| json.pointer("/candidates/0/finish_reason"))
                .and_then(Value::as_str)
                .unwrap_or("");
            add_check(
                &mut checks,
                &mut passed,
                matches!(
                    finish,
                    "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER" | ""
                ),
                "finishReason enum",
            );
            let role = json.pointer("/candidates/0/content/role").and_then(Value::as_str);
            add_check(
                &mut checks,
                &mut passed,
                role == Some("model"),
                "content role=model",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.pointer("/candidates/0/content/parts").and_then(Value::as_array).is_some(),
                "parts array",
            );
            add_check(
                &mut checks,
                &mut passed,
                json.get("usageMetadata").or_else(|| json.get("usage_metadata")).is_some(),
                "usageMetadata object",
            );
        }
    }
    let score = (passed / total) * 100.0;
    probe(
        "P3",
        "响应签名",
        status_from_score(score),
        score,
        8.0,
        Some(call.latency_ms),
        &format!("签名字段通过 {}/{}", passed as u32, total as u32),
        checks,
    )
}

pub(super) fn probe_model_echo(ctx: &mut EvalContext, call: &JsonCall) -> EvalProbeResult {
    let reported = call
        .json
        .as_ref()
        .and_then(|json| extract_reported_model(&ctx.api_format, json));
    remember_reported_model(ctx, reported.clone());

    let relation = model_relation(&ctx.model, reported.as_deref());
    let score = match relation {
        "exact" => 100.0,
        "alias" => 92.0,
        "same_family" => 82.0,
        "different" => 65.0,
        _ => 35.0,
    };
    let summary = match reported.as_deref() {
        Some(model) => format!("响应 model 字段: {}", model),
        None => "响应中未发现 model 字段".to_string(),
    };
    let relation_label = match relation {
        "exact" => "完全一致",
        "alias" => "别名/包含关系",
        "same_family" => "同模型族",
        "different" => "不同模型名",
        _ => "未知",
    };
    probe(
        "P7",
        "模型回显",
        status_from_score(score),
        score,
        8.0,
        Some(call.latency_ms),
        &summary,
        vec![
            format!("requested_model={}", ctx.model),
            format!(
                "reported_model={}",
                reported.unwrap_or_else(|| "(missing)".into())
            ),
            format!("relation={}", relation_label),
        ],
    )
}

pub(super) async fn probe_canary(ctx: &mut EvalContext) -> EvalProbeResult {
    let nonce = format!("BYOK_CANARY_{}", now_millis());
    let prompt = format!(
        "Return this token exactly once and do not add commentary: {}",
        nonce
    );
    let started = Instant::now();
    let body = chat_body(ctx, &prompt, false, 96, None);
    match call_json(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P4",
                    "内容 Canary",
                    "fail",
                    0.0,
                    8.0,
                    Some(call.latency_ms),
                    "Canary 请求返回非成功状态",
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 160),
                    ],
                );
            }
            let text = call
                .json
                .as_ref()
                .map(|j| extract_text(ctx, j))
                .unwrap_or_default();
            let score = if text.contains(&nonce) {
                100.0
            } else if nonce
                .split('_')
                .any(|part| part.len() > 5 && text.contains(part))
            {
                60.0
            } else {
                0.0
            };
            probe(
                "P4",
                "内容 Canary",
                status_from_score(score),
                score,
                8.0,
                Some(call.latency_ms),
                if score >= 100.0 {
                    "nonce 完整回显"
                } else {
                    "nonce 未完整回显"
                },
                vec![
                    format!("nonce={}", nonce),
                    format!("响应摘要: {}", snippet(&text, 120)),
                ],
            )
        }
        Err(e) => probe(
            "P4",
            "内容 Canary",
            "error",
            0.0,
            8.0,
            Some(started.elapsed().as_millis() as u64),
            "请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

