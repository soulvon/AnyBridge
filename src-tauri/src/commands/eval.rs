use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::config::{self, ApiFormat, Provider};

const REPORT_LIMIT: usize = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvalMode {
    Quick,
    Standard,
}

impl Default for EvalMode {
    fn default() -> Self {
        Self::Quick
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequest {
    pub provider_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: EvalMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReport {
    pub id: String,
    pub created_at: i64,
    pub provider_id: String,
    pub provider_name: String,
    pub api_format: String,
    pub model: String,
    pub mode: String,
    pub score: f64,
    pub risk_level: String,
    pub verdict: String,
    pub caps: Vec<EvalCap>,
    pub probes: Vec<EvalProbeResult>,
    pub usage: EvalUsageSummary,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCap {
    pub rule: String,
    pub cap_value: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalProbeResult {
    pub id: String,
    pub name: String,
    pub status: String,
    pub score: f64,
    pub weight: f64,
    pub latency_ms: Option<u64>,
    pub summary: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvalUsageSummary {
    pub request_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

struct EvalContext {
    provider: Provider,
    model: String,
    client: reqwest::Client,
    usage: EvalUsageSummary,
}

struct JsonCall {
    status: u16,
    latency_ms: u64,
    body_text: String,
    json: Option<Value>,
}

struct StreamCall {
    status: u16,
    latency_ms: u64,
    first_byte_ms: Option<u64>,
    content_type: String,
    chunk_count: usize,
    body_text: String,
}

#[tauri::command]
pub async fn run_provider_eval(request: EvalRequest) -> Result<EvalReport, String> {
    let started = Instant::now();
    let provider = find_provider(&request.provider_id)?;
    if !provider.enabled {
        return Err(format!("供应商已禁用: {}", provider.name));
    }
    let model = request
        .model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| provider.default_model.clone());
    if model.trim().is_empty() {
        return Err("供应商未配置默认模型，请先选择一个模型".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let mut ctx = EvalContext {
        provider,
        model,
        client,
        usage: EvalUsageSummary::default(),
    };

    let mut probes = Vec::new();
    let mut caps = Vec::new();

    let setup = probe_connectivity(&mut ctx).await;
    let setup_ok = setup
        .as_ref()
        .map(|(_, p)| p.status == "pass" || p.status == "warn")
        .unwrap_or(false);

    match setup {
        Ok((call, p1)) => {
            probes.push(p1);
            let p2 = probe_response_structure(&ctx, &call);
            if p2.status == "fail" && p2.score <= 25.0 {
                caps.push(EvalCap {
                    rule: "response_schema_broken".into(),
                    cap_value: 40.0,
                    reason: "响应结构严重缺失，协议层与官方格式不兼容".into(),
                });
            }
            probes.push(p2);

            let p3 = probe_response_signature(&ctx, &call);
            if p3.status == "fail" && p3.score <= 45.0 {
                caps.push(EvalCap {
                    rule: "response_signature_invalid".into(),
                    cap_value: 40.0,
                    reason: "关键响应签名字段不合规，疑似逆向中转或字段伪造".into(),
                });
            }
            probes.push(p3);
        }
        Err(p) => {
            caps.push(EvalCap {
                rule: "protocol_offline".into(),
                cap_value: 0.0,
                reason: "协议连通性失败，无法完成后续模型评测".into(),
            });
            probes.push(p);
        }
    }

    if setup_ok {
        probes.push(probe_canary(&mut ctx).await);
        probes.push(probe_stream_integrity(&mut ctx).await);
        probes.push(probe_tool_calling(&mut ctx).await);
        probes.push(probe_performance(&mut ctx).await);

        if matches!(request.mode, EvalMode::Standard) {
            let p = probe_token_injection(&mut ctx).await;
            if p.status == "fail" && p.score <= 40.0 {
                caps.push(EvalCap {
                    rule: "token_injection_suspect".into(),
                    cap_value: 60.0,
                    reason: "极短请求的输入 token 明显异常，疑似隐藏 prompt 注入或路由包装".into(),
                });
            }
            probes.push(p);
        }
    } else {
        probes.push(skip_probe("P4", "内容 Canary", 8.0, "协议不可用，跳过"));
        probes.push(skip_probe("P5", "流完整性", 8.0, "协议不可用，跳过"));
        probes.push(skip_probe("P6", "工具调用", 10.0, "协议不可用，跳过"));
        probes.push(skip_probe("P10", "性能稳定性", 10.0, "协议不可用，跳过"));
    }

    let score = final_score(&probes, &caps);
    let risk_level = risk_level(score).to_string();
    let verdict = verdict(score, &caps);
    let mode = match request.mode {
        EvalMode::Quick => "quick",
        EvalMode::Standard => "standard",
    }
    .to_string();

    let report = EvalReport {
        id: format!("eval-{}", now_millis()),
        created_at: now_millis(),
        provider_id: ctx.provider.id.clone(),
        provider_name: ctx.provider.name.clone(),
        api_format: api_format_str(&ctx.provider.api_format).to_string(),
        model: ctx.model.clone(),
        mode,
        score,
        risk_level,
        verdict,
        caps,
        probes,
        usage: ctx.usage,
        duration_ms: started.elapsed().as_millis() as u64,
    };

    save_report(report.clone())?;
    Ok(report)
}

#[tauri::command]
pub fn list_eval_reports() -> Result<Vec<EvalReport>, String> {
    read_reports()
}

#[tauri::command]
pub fn delete_eval_report(id: String) -> Result<Vec<EvalReport>, String> {
    let mut reports = read_reports()?;
    reports.retain(|r| r.id != id);
    write_reports(&reports)?;
    Ok(reports)
}

async fn probe_connectivity(
    ctx: &mut EvalContext,
) -> Result<(JsonCall, EvalProbeResult), EvalProbeResult> {
    let started = Instant::now();
    let body = chat_body(ctx, "Reply with exactly: OK", false, 64, None);
    match call_json(ctx, body).await {
        Ok(call) => {
            let status = call.status;
            let latency = call.latency_ms;
            if (200..300).contains(&call.status)
                && call.json.is_some()
                && extract_text(ctx, call.json.as_ref().unwrap()).trim().len() > 0
            {
                Ok((
                    call,
                    probe(
                        "P1",
                        "协议连通性",
                        "pass",
                        100.0,
                        12.0,
                        Some(latency),
                        "最小推理请求成功",
                        vec![format!("HTTP {}", status), format!("耗时 {}ms", latency)],
                    ),
                ))
            } else {
                Err(probe(
                    "P1",
                    "协议连通性",
                    "fail",
                    0.0,
                    12.0,
                    Some(latency),
                    "最小推理请求失败",
                    vec![
                        format!("HTTP {}", call.status),
                        snippet(&call.body_text, 180),
                    ],
                ))
            }
        }
        Err(e) => Err(probe(
            "P1",
            "协议连通性",
            "fail",
            0.0,
            12.0,
            Some(started.elapsed().as_millis() as u64),
            "请求失败",
            vec![redact(&ctx.provider, &e)],
        )),
    }
}

fn probe_response_structure(ctx: &EvalContext, call: &JsonCall) -> EvalProbeResult {
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
    match ctx.provider.api_format {
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
            let msg = json.pointer("/choices/0/message");
            add_check(
                &mut checks,
                &mut passed,
                msg.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant"),
                "assistant role",
            );
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

fn probe_response_signature(ctx: &EvalContext, call: &JsonCall) -> EvalProbeResult {
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
    match ctx.provider.api_format {
        ApiFormat::Openai => {
            total = 5.0;
            let id = json.get("id").and_then(Value::as_str).unwrap_or("");
            add_check(
                &mut checks,
                &mut passed,
                id.starts_with("chatcmpl-") || id.starts_with("cmpl-"),
                "OpenAI id prefix",
            );
            let obj = json.get("object").and_then(Value::as_str).unwrap_or("");
            add_check(
                &mut checks,
                &mut passed,
                obj.contains("chat.completion") || obj.contains("completion"),
                "object literal",
            );
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
            add_check(
                &mut checks,
                &mut passed,
                model_echo_ok(json.get("model").and_then(Value::as_str), &ctx.model),
                "model echo",
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
                model_echo_ok(json.get("model").and_then(Value::as_str), &ctx.model),
                "model echo",
            );
            add_check(
                &mut checks,
                &mut passed,
                usage_has_numbers_anthropic(json),
                "integer usage",
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

async fn probe_canary(ctx: &mut EvalContext) -> EvalProbeResult {
    let nonce = format!("BYOK_CANARY_{}", now_millis());
    let prompt = format!(
        "Return this token exactly once and do not add commentary: {}",
        nonce
    );
    let started = Instant::now();
    let body = chat_body(ctx, &prompt, false, 96, None);
    match call_json(ctx, body).await {
        Ok(call) => {
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

async fn probe_stream_integrity(ctx: &mut EvalContext) -> EvalProbeResult {
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
            if ct_ok {
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
            if call.chunk_count >= 2 {
                score += 20.0;
            }
            evidence.push(format!("chunks: {}", call.chunk_count));
            if call.first_byte_ms.map(|ms| ms < 15_000).unwrap_or(false) {
                score += 20.0;
            }
            evidence.push(format!(
                "first_byte: {}ms",
                call.first_byte_ms.unwrap_or(call.latency_ms)
            ));
            if stream_has_done(&call.body_text, &ctx.provider.api_format) {
                score += 20.0;
            }
            evidence.push(format!(
                "done_signal: {}",
                stream_has_done(&call.body_text, &ctx.provider.api_format)
            ));
            if stream_text(&call.body_text).trim().len() > 0 {
                score += 20.0;
            }
            evidence.push(format!(
                "文本摘要: {}",
                snippet(&stream_text(&call.body_text), 100)
            ));
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

async fn probe_tool_calling(ctx: &mut EvalContext) -> EvalProbeResult {
    let city = format!("byok-city-{}", now_millis());
    let tool_body = tool_body(ctx, &city);
    let started = Instant::now();
    match call_json(ctx, tool_body).await {
        Ok(call) => {
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

async fn probe_performance(ctx: &mut EvalContext) -> EvalProbeResult {
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

async fn probe_token_injection(ctx: &mut EvalContext) -> EvalProbeResult {
    let started = Instant::now();
    let body = chat_body(ctx, "ping", false, 16, None);
    match call_json(ctx, body).await {
        Ok(call) => {
            let input_tokens = call
                .json
                .as_ref()
                .and_then(|j| input_tokens(&ctx.provider.api_format, j))
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

fn find_provider(id: &str) -> Result<Provider, String> {
    let store = config::load_providers()?;
    store
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("供应商不存在: {}", id))
}

fn api_format_str(fmt: &ApiFormat) -> &'static str {
    match fmt {
        ApiFormat::Anthropic => "anthropic",
        ApiFormat::Openai => "openai",
    }
}

fn api_url(provider: &Provider) -> String {
    let host = provider.api_host.trim().trim_end_matches('/');
    let host = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    let default_path = match provider.api_format {
        ApiFormat::Openai => "/v1/chat/completions",
        ApiFormat::Anthropic => "/v1/messages",
    };
    let path = provider
        .api_path
        .as_deref()
        .filter(|p| !p.trim().is_empty() && *p != "/")
        .unwrap_or(default_path);
    format!("{}{}", host, path)
}

fn chat_body(
    ctx: &EvalContext,
    prompt: &str,
    stream: bool,
    max_tokens: u32,
    extra: Option<Value>,
) -> Value {
    match ctx.provider.api_format {
        ApiFormat::Openai => {
            let mut body = serde_json::json!({
                "model": ctx.model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0,
                "stream": stream
            });
            if let Some(extra) = extra {
                merge_json(&mut body, extra);
            }
            body
        }
        ApiFormat::Anthropic => {
            let mut body = serde_json::json!({
                "model": ctx.model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0,
                "stream": stream
            });
            if let Some(extra) = extra {
                merge_json(&mut body, extra);
            }
            body
        }
    }
}

fn tool_body(ctx: &EvalContext, city: &str) -> Value {
    let prompt = format!(
        "Use the get_weather tool for city '{}'. Do not answer in text.",
        city
    );
    match ctx.provider.api_format {
        ApiFormat::Openai => chat_body(
            ctx,
            &prompt,
            false,
            128,
            Some(serde_json::json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get weather for a city.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "city": {"type": "string"}
                            },
                            "required": ["city"],
                            "additionalProperties": false
                        }
                    }
                }],
                "tool_choice": {"type": "function", "function": {"name": "get_weather"}}
            })),
        ),
        ApiFormat::Anthropic => chat_body(
            ctx,
            &prompt,
            false,
            128,
            Some(serde_json::json!({
                "tools": [{
                    "name": "get_weather",
                    "description": "Get weather for a city.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "city": {"type": "string"}
                        },
                        "required": ["city"]
                    }
                }],
                "tool_choice": {"type": "tool", "name": "get_weather"}
            })),
        ),
    }
}

fn merge_json(base: &mut Value, extra: Value) {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
}

async fn call_json(ctx: &mut EvalContext, body: Value) -> Result<JsonCall, String> {
    let started = Instant::now();
    ctx.usage.request_count += 1;
    let text = send_json(ctx, body).await?;
    let latency_ms = started.elapsed().as_millis() as u64;
    let status = text.0;
    let body_text = text.1;
    let json = serde_json::from_str::<Value>(&body_text).ok();
    if let Some(json) = json.as_ref() {
        add_usage(&mut ctx.usage, &ctx.provider.api_format, json);
    }
    Ok(JsonCall {
        status,
        latency_ms,
        body_text,
        json,
    })
}

async fn call_stream(ctx: &mut EvalContext, body: Value) -> Result<StreamCall, String> {
    let started = Instant::now();
    ctx.usage.request_count += 1;
    let mut body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let use_gzip = ctx.provider.capabilities.gzip;
    let mut req = ctx
        .client
        .post(api_url(&ctx.provider))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");
    req = auth_headers(req, &ctx.provider);
    if use_gzip {
        body_bytes = gzip_bytes(&body_bytes)?;
        req = req.header("Content-Encoding", "gzip");
    }
    let mut res = req
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut body_text = String::new();
    let mut first_byte_ms = None;
    let mut chunk_count = 0usize;
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                if first_byte_ms.is_none() {
                    first_byte_ms = Some(started.elapsed().as_millis() as u64);
                }
                chunk_count += 1;
                body_text.push_str(&String::from_utf8_lossy(&chunk));
            }
            Ok(None) => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(StreamCall {
        status,
        latency_ms: started.elapsed().as_millis() as u64,
        first_byte_ms,
        content_type,
        chunk_count,
        body_text,
    })
}

async fn send_json(ctx: &EvalContext, body: Value) -> Result<(u16, String), String> {
    let mut body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let use_gzip = ctx.provider.capabilities.gzip;
    let mut req = ctx
        .client
        .post(api_url(&ctx.provider))
        .header("Content-Type", "application/json");
    req = auth_headers(req, &ctx.provider);
    if use_gzip {
        body_bytes = gzip_bytes(&body_bytes)?;
        req = req.header("Content-Encoding", "gzip");
    }
    let res = req
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn auth_headers(req: reqwest::RequestBuilder, provider: &Provider) -> reqwest::RequestBuilder {
    match provider.api_format {
        ApiFormat::Openai => req.header("Authorization", format!("Bearer {}", provider.api_key)),
        ApiFormat::Anthropic => req
            .header("x-api-key", &provider.api_key)
            .header("anthropic-version", "2023-06-01"),
    }
}

fn gzip_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn extract_text(ctx: &EvalContext, json: &Value) -> String {
    match ctx.provider.api_format {
        ApiFormat::Openai => json
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        ApiFormat::Anthropic => json
            .get("content")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| {
                        if b.get("type").and_then(Value::as_str) == Some("text") {
                            b.get("text").and_then(Value::as_str)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
    }
}

fn tool_score(ctx: &EvalContext, json: &Value, city: &str) -> (f64, Vec<String>) {
    let mut evidence = Vec::new();
    let mut score = 0.0;
    match ctx.provider.api_format {
        ApiFormat::Openai => {
            let calls = json
                .pointer("/choices/0/message/tool_calls")
                .and_then(Value::as_array);
            if calls.map(|a| !a.is_empty()).unwrap_or(false) {
                score += 25.0;
                evidence.push("tool_calls present".into());
            }
            let first = calls.and_then(|a| a.first());
            let name = first
                .and_then(|v| v.pointer("/function/name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if name == "get_weather" {
                score += 25.0;
            }
            evidence.push(format!(
                "tool_name={}",
                if name.is_empty() { "(missing)" } else { name }
            ));
            let args = first
                .and_then(|v| v.pointer("/function/arguments"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if serde_json::from_str::<Value>(args).is_ok() {
                score += 25.0;
            }
            if args.contains(city) {
                score += 25.0;
            }
            evidence.push(format!("arguments={}", snippet(args, 120)));
        }
        ApiFormat::Anthropic => {
            let blocks = json.get("content").and_then(Value::as_array);
            let tool = blocks.and_then(|arr| {
                arr.iter()
                    .find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
            });
            if tool.is_some() {
                score += 25.0;
                evidence.push("tool_use block present".into());
            }
            let name = tool
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if name == "get_weather" {
                score += 25.0;
            }
            evidence.push(format!(
                "tool_name={}",
                if name.is_empty() { "(missing)" } else { name }
            ));
            let input = tool
                .and_then(|v| v.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            if input.is_object() {
                score += 25.0;
            }
            if input.to_string().contains(city) {
                score += 25.0;
            }
            evidence.push(format!("input={}", snippet(&input.to_string(), 120)));
        }
    }
    (score, evidence)
}

fn usage_has_numbers_openai(json: &Value) -> bool {
    json.pointer("/usage/prompt_tokens")
        .and_then(Value::as_u64)
        .is_some()
        || json
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64)
            .is_some()
        || json
            .pointer("/usage/total_tokens")
            .and_then(Value::as_u64)
            .is_some()
}

fn usage_has_numbers_anthropic(json: &Value) -> bool {
    json.pointer("/usage/input_tokens")
        .and_then(Value::as_u64)
        .is_some()
        || json
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64)
            .is_some()
}

fn input_tokens(fmt: &ApiFormat, json: &Value) -> Option<u64> {
    match fmt {
        ApiFormat::Openai => json.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        ApiFormat::Anthropic => json.pointer("/usage/input_tokens").and_then(Value::as_u64),
    }
}

fn add_usage(summary: &mut EvalUsageSummary, fmt: &ApiFormat, json: &Value) {
    match fmt {
        ApiFormat::Openai => {
            summary.input_tokens += json
                .pointer("/usage/prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            summary.output_tokens += json
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
        }
        ApiFormat::Anthropic => {
            summary.input_tokens += json
                .pointer("/usage/input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            summary.output_tokens += json
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
        }
    }
}

fn model_echo_ok(echo: Option<&str>, expected: &str) -> bool {
    let Some(echo) = echo else {
        return false;
    };
    if echo == expected {
        return true;
    }
    let e = echo.to_ascii_lowercase();
    let x = expected.to_ascii_lowercase();
    e.contains(&x) || x.contains(&e)
}

fn add_check(evidence: &mut Vec<String>, passed: &mut f64, ok: bool, label: &str) {
    if ok {
        *passed += 1.0;
        evidence.push(format!("{} ✓", label));
    } else {
        evidence.push(format!("{} ×", label));
    }
}

fn stream_has_done(body: &str, fmt: &ApiFormat) -> bool {
    match fmt {
        ApiFormat::Openai => body.contains("[DONE]"),
        ApiFormat::Anthropic => {
            body.contains("message_stop") || body.contains("\"type\":\"message_stop\"")
        }
    }
}

fn stream_text(body: &str) -> String {
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
        }
    }
    out
}

fn skip_probe(id: &str, name: &str, weight: f64, summary: &str) -> EvalProbeResult {
    probe(id, name, "skip", 0.0, weight, None, summary, Vec::new())
}

fn probe(
    id: &str,
    name: &str,
    status: &str,
    score: f64,
    weight: f64,
    latency_ms: Option<u64>,
    summary: &str,
    evidence: Vec<String>,
) -> EvalProbeResult {
    EvalProbeResult {
        id: id.into(),
        name: name.into(),
        status: status.into(),
        score: (score * 10.0).round() / 10.0,
        weight,
        latency_ms,
        summary: summary.into(),
        evidence,
    }
}

fn status_from_score(score: f64) -> &'static str {
    if score >= 90.0 {
        "pass"
    } else if score >= 60.0 {
        "warn"
    } else {
        "fail"
    }
}

fn final_score(probes: &[EvalProbeResult], caps: &[EvalCap]) -> f64 {
    let mut sum = 0.0;
    let mut weight = 0.0;
    for p in probes {
        if p.status == "skip" {
            continue;
        }
        sum += p.score * p.weight;
        weight += p.weight;
    }
    let mut score = if weight <= 0.0 { 0.0 } else { sum / weight };
    for cap in caps {
        score = score.min(cap.cap_value);
    }
    (score * 10.0).round() / 10.0
}

fn risk_level(score: f64) -> &'static str {
    if score >= 85.0 {
        "low"
    } else if score >= 70.0 {
        "medium-low"
    } else if score >= 50.0 {
        "medium"
    } else if score >= 30.0 {
        "high"
    } else {
        "critical"
    }
}

fn verdict(score: f64, caps: &[EvalCap]) -> String {
    if caps.iter().any(|c| c.cap_value <= 0.0) {
        "协议不可用，无法完成评测".into()
    } else if score >= 85.0 {
        "低风险：协议、能力与响应形态基本正常".into()
    } else if score >= 70.0 {
        "可用但需观察：存在轻微异常或证据不足".into()
    } else if score >= 50.0 {
        "可疑：存在协议偏差、能力缺失或响应不稳定".into()
    } else if score >= 30.0 {
        "高风险：关键探针失败，疑似逆向、降级或字段伪造".into()
    } else {
        "不建议使用：协议不可用或高度疑似非目标模型".into()
    }
}

fn reports_path() -> std::path::PathBuf {
    config::config_dir_path().join("eval-runs.json")
}

fn read_reports() -> Result<Vec<EvalReport>, String> {
    let path = reports_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_reports(reports: &[EvalReport]) -> Result<(), String> {
    let path = reports_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(reports).map_err(|e| e.to_string())?;
    super::write_atomic(&path, json.as_bytes())
}

fn save_report(report: EvalReport) -> Result<(), String> {
    let mut reports = read_reports().unwrap_or_default();
    reports.retain(|r| r.id != report.id);
    reports.insert(0, report);
    if reports.len() > REPORT_LIMIT {
        reports.truncate(REPORT_LIMIT);
    }
    write_reports(&reports)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn snippet(s: &str, max: usize) -> String {
    let mut out = s.replace('\n', " ").replace('\r', " ");
    if out.chars().count() > max {
        out = out.chars().take(max).collect::<String>();
        out.push_str("...");
    }
    out
}

fn redact(provider: &Provider, msg: &str) -> String {
    let key = provider.api_key.as_str();
    if key.len() >= 6 && msg.contains(key) {
        msg.replace(key, "***REDACTED***")
    } else {
        msg.to_string()
    }
}
