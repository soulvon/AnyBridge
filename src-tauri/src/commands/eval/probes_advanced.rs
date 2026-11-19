use serde_json::Value;
use std::time::Instant;
use crate::commands::config::ApiFormat;
use super::*;
use super::requests::*;
use super::scoring_and_reports::*;

pub(super) async fn probe_stream_integrity(ctx: &mut EvalContext) -> EvalProbeResult {
    let started = Instant::now();
    let body = chat_body(
        ctx,
        "Count from 1 to 5, one number per word.",
        true,
        96,
        None,
    );
    match call_stream(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P5",
                    "流完整性",
                    "fail",
                    0.0,
                    8.0,
                    Some(call.latency_ms),
                    "流式请求返回非成功状态",
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 160),
                    ],
                );
            }
            let mut score = 0.0;
            let mut evidence = Vec::new();
            evidence.push(format!("HTTP {}", call.status));
            let ct_ok = call
                .content_type
                .to_ascii_lowercase()
                .contains("text/event-stream");
            let event_count = sse_data_event_count(&call.body_text);
            let text = stream_text(&call.body_text);
            let done = stream_has_done(&call.body_text, &ctx.api_format);
            if ct_ok || event_count > 0 {
                score += 20.0;
            }
            evidence.push(format!(
                "content-type: {}",
                if call.content_type.is_empty() {
                    "(empty)"
                } else {
                    &call.content_type
                }
            ));
            evidence.push(format!("sse_events: {}", event_count));
            if event_count >= 2 {
                score += 20.0;
            } else if event_count == 1 {
                score += 10.0;
            }
            evidence.push(format!("network_chunks: {}", call.chunk_count));
            if call.first_byte_ms.map(|ms| ms < 15_000).unwrap_or(false) {
                score += 20.0;
            } else if call.first_byte_ms.map(|ms| ms < 45_000).unwrap_or(false) {
                score += 10.0;
            }
            evidence.push(format!(
                "first_byte: {}ms",
                call.first_byte_ms.unwrap_or(call.latency_ms)
            ));
            if done {
                score += 20.0;
            } else if event_count > 0 && !text.trim().is_empty() {
                score += 10.0;
            }
            evidence.push(format!("done_signal: {}", done));
            if !text.trim().is_empty() {
                score += 20.0;
            }
            evidence.push(format!("文本摘要: {}", snippet(&text, 100)));
            probe(
                "P5",
                "流完整性",
                status_from_score(score),
                score,
                8.0,
                Some(call.latency_ms),
                &format!("SSE 完整性 {:.0}%", score),
                evidence,
            )
        }
        Err(e) => probe(
            "P5",
            "流完整性",
            "error",
            0.0,
            8.0,
            Some(started.elapsed().as_millis() as u64),
            "流式请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

pub(super) async fn probe_tool_calling(ctx: &mut EvalContext) -> EvalProbeResult {
    let city = format!("byok-city-{}", now_millis());
    let tool_body = tool_body(ctx, &city);
    let started = Instant::now();
    match call_json(ctx, tool_body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P6",
                    "工具调用",
                    "fail",
                    0.0,
                    10.0,
                    Some(call.latency_ms),
                    "工具请求返回非成功状态",
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 160),
                    ],
                );
            }
            let Some(json) = call.json.as_ref() else {
                return probe(
                    "P6",
                    "工具调用",
                    "fail",
                    0.0,
                    10.0,
                    Some(call.latency_ms),
                    "响应不是 JSON",
                    vec![snippet(&call.body_text, 160)],
                );
            };
            let (score, evidence) = tool_score(ctx, json, &city);
            probe(
                "P6",
                "工具调用",
                status_from_score(score),
                score,
                10.0,
                Some(call.latency_ms),
                &format!("工具调用校验 {:.0}%", score),
                evidence,
            )
        }
        Err(e) => probe(
            "P6",
            "工具调用",
            "error",
            0.0,
            10.0,
            Some(started.elapsed().as_millis() as u64),
            "工具请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

pub(super) async fn probe_vision_understanding(ctx: &mut EvalContext) -> EvalProbeResult {
    let started = Instant::now();
    let body = vision_body(ctx);
    match call_json(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P12",
                    "图片理解",
                    "fail",
                    0.0,
                    8.0,
                    Some(call.latency_ms),
                    "图片请求返回非成功状态",
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
                .unwrap_or_default()
                .to_ascii_lowercase();
            let mut score = 0.0;
            let mut evidence = vec![format!("HTTP {}", call.status)];
            if call.json.is_some() {
                score += 25.0;
                evidence.push("json ✓".into());
            } else {
                evidence.push("json ×".into());
            }
            let saw_image_words = [
                "red", "square", "image", "picture", "png", "红", "方", "图片",
            ]
            .iter()
            .any(|w| text.contains(w));
            if saw_image_words {
                score += 55.0;
            }
            evidence.push(format!("vision_hint={}", saw_image_words));
            if !text.trim().is_empty() {
                score += 20.0;
            }
            evidence.push(format!("响应摘要: {}", snippet(&text, 140)));
            probe(
                "P12",
                "图片理解",
                status_from_score(score),
                score,
                8.0,
                Some(call.latency_ms),
                &format!("图片输入响应校验 {:.0}%", score),
                evidence,
            )
        }
        Err(e) => probe(
            "P12",
            "图片理解",
            "error",
            0.0,
            8.0,
            Some(started.elapsed().as_millis() as u64),
            "图片请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

pub(super) async fn probe_protocol_compatibility(ctx: &mut EvalContext) -> EvalProbeResult {
    let started = Instant::now();
    let checks = run_protocol_checks(ctx).await;
    ctx.protocol_checks = checks.clone();
    let primary_key = provider_protocol_key(&ctx.provider, ctx.api_format);
    let primary = checks.iter().find(|c| c.key == primary_key);
    let score = match primary.map(|c| c.status.as_str()) {
        Some("supported") => 100.0,
        Some("partial") => 75.0,
        Some("unsupported") => 0.0,
        _ => 0.0,
    };
    let evidence = checks
        .iter()
        .map(|c| format!("{}: {} · {}", c.label, c.status, c.detail))
        .collect::<Vec<_>>();
    let optional_supported = checks
        .iter()
        .filter(|c| c.key != primary_key && matches!(c.status.as_str(), "supported" | "partial"))
        .count();
    let optional_total = checks.iter().filter(|c| c.key != primary_key).count();
    let summary = primary
        .map(|c| {
            format!(
                "当前入口：{}；可选入口 {}/{} 可用",
                c.detail, optional_supported, optional_total
            )
        })
        .unwrap_or_else(|| "未找到当前配置入口".into());
    probe(
        "P13",
        "调用方式兼容",
        status_from_score(score),
        score,
        6.0,
        Some(started.elapsed().as_millis() as u64),
        &summary,
        evidence,
    )
}

pub(super) async fn probe_prompt_injection(ctx: &mut EvalContext) -> EvalProbeResult {
    let canary = format!("BYOK_SYS_CANARY_{}", now_millis());
    let body = prompt_injection_body(ctx, &canary);
    let started = Instant::now();
    match call_json(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P14",
                    "提示词注入",
                    "fail",
                    0.0,
                    8.0,
                    Some(call.latency_ms),
                    "注入探针返回非成功状态",
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
            let lower = text.to_ascii_lowercase();
            let leaked_canary = text.contains(&canary);
            let leaked_system = has_prompt_leak_hint(&text);
            let leaked_relay = has_relay_wrapper_hint(&text);
            let script_hint = has_script_injection_hint(&text);
            let refused = lower.contains("safe")
                || lower.contains("can't")
                || lower.contains("cannot")
                || lower.contains("unable")
                || lower.contains("不能")
                || lower.contains("无法")
                || lower.contains("不可以");
            let score = if leaked_canary || script_hint {
                0.0
            } else if leaked_relay {
                20.0
            } else if leaked_system {
                35.0
            } else if refused {
                100.0
            } else if text.trim().is_empty() {
                55.0
            } else {
                82.0
            };
            let summary = if leaked_canary {
                "高风险：本次防泄漏 canary 被泄漏"
            } else if script_hint {
                "高风险：响应疑似包含脚本/HTML 注入片段"
            } else if leaked_relay {
                "高风险：疑似泄漏中转站包装提示词或路由规则"
            } else if leaked_system {
                "疑似泄漏系统提示词或隐藏指令"
            } else if refused {
                "未发现中转提示词泄漏，且明确拒绝"
            } else {
                "未发现中转提示词泄漏，但拒绝信号不明确"
            };
            probe(
                "P14",
                "提示词注入",
                status_from_score(score),
                score,
                8.0,
                Some(call.latency_ms),
                summary,
                vec![
                    format!("HTTP {}", call.status),
                    format!("canary_leaked={}", leaked_canary),
                    format!("system_leak_hint={}", leaked_system),
                    format!("relay_wrapper_hint={}", leaked_relay),
                    format!("script_hint={}", script_hint),
                    format!("refusal_hint={}", refused),
                    format!("响应摘要: {}", snippet(&text, 180)),
                ],
            )
        }
        Err(e) => probe(
            "P14",
            "提示词注入",
            "error",
            0.0,
            8.0,
            Some(started.elapsed().as_millis() as u64),
            "注入探针请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

pub(super) async fn probe_performance(ctx: &mut EvalContext) -> EvalProbeResult {
    let mut latencies = Vec::new();
    let mut failures = 0usize;
    let started = Instant::now();
    for i in 0..3 {
        let prompt = format!("Reply with the number {} only.", i + 1);
        let body = chat_body(ctx, &prompt, false, 32, None);
        match call_json(ctx, body).await {
            Ok(call) if (200..300).contains(&call.status) => latencies.push(call.latency_ms as f64),
            _ => failures += 1,
        }
    }
    let avg = if latencies.is_empty() {
        0.0
    } else {
        latencies.iter().sum::<f64>() / latencies.len() as f64
    };
    let cv = if latencies.len() < 2 || avg <= 0.0 {
        0.0
    } else {
        let var = latencies.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / latencies.len() as f64;
        var.sqrt() / avg
    };
    let mut score = 100.0 - failures as f64 * 35.0;
    if avg > 12_000.0 {
        score -= 25.0;
    } else if avg > 6_000.0 {
        score -= 12.0;
    }
    if cv > 0.8 {
        score -= 20.0;
    } else if cv > 0.45 {
        score -= 10.0;
    }
    score = score.clamp(0.0, 100.0);
    if avg > 0.0 {
        ctx.metrics.avg_latency_ms = Some((avg * 10.0).round() / 10.0);
        ctx.metrics.latency_cv = Some((cv * 100.0).round() / 100.0);
    }
    probe(
        "P10",
        "性能稳定性",
        status_from_score(score),
        score,
        10.0,
        Some(started.elapsed().as_millis() as u64),
        &format!("3 次短请求，失败 {} 次", failures),
        vec![
            format!("avg={:.0}ms", avg),
            format!("cv={:.2}", cv),
            format!("samples={}", latencies.len()),
        ],
    )
}

pub(super) async fn probe_token_injection(ctx: &mut EvalContext) -> EvalProbeResult {
    let started = Instant::now();
    let body = chat_body(ctx, "ping", false, 16, None);
    match call_json(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P8",
                    "Token 注入粗测",
                    "fail",
                    0.0,
                    7.0,
                    Some(call.latency_ms),
                    "Token 探针返回非成功状态",
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 160),
                    ],
                );
            }
            let input_tokens = call
                .json
                .as_ref()
                .and_then(|j| input_tokens(&ctx.api_format, j))
                .unwrap_or(0);
            let score = if input_tokens == 0 {
                70.0
            } else if input_tokens <= 80 {
                100.0
            } else if input_tokens <= 180 {
                70.0
            } else if input_tokens <= 400 {
                40.0
            } else {
                0.0
            };
            probe(
                "P8",
                "Token 注入粗测",
                status_from_score(score),
                score,
                7.0,
                Some(call.latency_ms),
                &format!("短 prompt 输入 token={}", input_tokens),
                vec![
                    "prompt=ping".into(),
                    format!("input_tokens={}", input_tokens),
                ],
            )
        }
        Err(e) => probe(
            "P8",
            "Token 注入粗测",
            "error",
            0.0,
            7.0,
            Some(started.elapsed().as_millis() as u64),
            "请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

pub(super) async fn probe_json_mode(ctx: &mut EvalContext) -> EvalProbeResult {
    let nonce = format!("json_{}", now_millis());
    let prompt = format!(
        "Return only a compact JSON object with keys ok and nonce. Use ok=true and nonce=\"{}\".",
        nonce
    );
    let extra = match ctx.api_format {
        ApiFormat::Openai => Some(serde_json::json!({
            "response_format": {"type": "json_object"}
        })),
        ApiFormat::Anthropic => None,
        ApiFormat::Gemini => Some(serde_json::json!({
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        })),
    };
    let body = chat_body(ctx, &prompt, false, 128, extra);
    let started = Instant::now();
    match call_json(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P9",
                    "JSON 模式",
                    "fail",
                    0.0,
                    7.0,
                    Some(call.latency_ms),
                    "JSON 模式请求返回非成功状态",
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
            let parsed = parse_json_from_text(&text);
            let score = match parsed.as_ref() {
                Some(v)
                    if v.get("ok").and_then(Value::as_bool) == Some(true)
                        && v.get("nonce").and_then(Value::as_str) == Some(nonce.as_str()) =>
                {
                    100.0
                }
                Some(v) if v.get("nonce").and_then(Value::as_str) == Some(nonce.as_str()) => 82.0,
                Some(_) => 68.0,
                None if text.contains(&nonce) => 45.0,
                None => 0.0,
            };
            probe(
                "P9",
                "JSON 模式",
                status_from_score(score),
                score,
                7.0,
                Some(call.latency_ms),
                if parsed.is_some() {
                    "JSON 可解析"
                } else {
                    "JSON 不可解析"
                },
                vec![
                    format!("nonce={}", nonce),
                    format!("响应摘要: {}", snippet(&text, 160)),
                ],
            )
        }
        Err(e) => probe(
            "P9",
            "JSON 模式",
            "error",
            0.0,
            7.0,
            Some(started.elapsed().as_millis() as u64),
            "请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

pub(super) async fn probe_output_throughput(ctx: &mut EvalContext) -> EvalProbeResult {
    let prompt = "Write a single paragraph of about 140 short English words about deterministic API benchmarking. Do not use bullets, markdown, or code.";
    let extra = match ctx.api_format {
        ApiFormat::Openai => Some(serde_json::json!({
            "stream_options": {"include_usage": true}
        })),
        ApiFormat::Anthropic => None,
        ApiFormat::Gemini => None,
    };
    let body = chat_body(ctx, prompt, true, 260, extra);
    let started = Instant::now();
    match call_stream(ctx, body).await {
        Ok(call) => {
            if !(200..300).contains(&call.status) {
                return probe(
                    "P11",
                    "输出吞吐",
                    "fail",
                    0.0,
                    8.0,
                    Some(call.latency_ms),
                    "吞吐请求返回非成功状态",
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 160),
                    ],
                );
            }
            let text = stream_text(&call.body_text);
            let tokens = stream_output_tokens(&ctx.api_format, &call.body_text)
                .unwrap_or_else(|| estimate_tokens(&text));
            let ttft = call.first_byte_ms.unwrap_or(call.latency_ms);
            let generation_ms = call.latency_ms.saturating_sub(ttft).max(1);
            let tps = tokens as f64 / (generation_ms as f64 / 1000.0);
            let tps = (tps * 10.0).round() / 10.0;
            ctx.metrics.ttft_ms = Some(ttft);
            ctx.metrics.tokens_per_second = Some(tps);
            ctx.metrics.throughput_tokens = Some(tokens);
            ctx.metrics.generation_ms = Some(generation_ms);
            ctx.metrics.stream_chunk_count = Some(call.chunk_count as u32);

            let score = if tps >= 60.0 {
                100.0
            } else if tps >= 35.0 {
                88.0
            } else if tps >= 18.0 {
                72.0
            } else if tps >= 8.0 {
                55.0
            } else {
                35.0
            };
            probe(
                "P11",
                "输出吞吐",
                status_from_score(score),
                score,
                8.0,
                Some(call.latency_ms),
                &format!("输出吞吐 {:.1} token/s", tps),
                vec![
                    format!("tokens={}", tokens),
                    format!("ttft={}ms", ttft),
                    format!("generation={}ms", generation_ms),
                    format!("chunks={}", call.chunk_count),
                    format!("文本摘要: {}", snippet(&text, 120)),
                ],
            )
        }
        Err(e) => probe(
            "P11",
            "输出吞吐",
            "error",
            0.0,
            8.0,
            Some(started.elapsed().as_millis() as u64),
            "流式吞吐请求失败",
            vec![redact(&ctx.provider, &e)],
        ),
    }
}

