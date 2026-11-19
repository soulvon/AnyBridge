use serde_json::Value;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use crate::commands::config::{ApiFormat, Provider};
use super::*;

pub(super) fn extract_text(ctx: &EvalContext, json: &Value) -> String {
    extract_text_by_format(&ctx.api_format, json)
}

pub(super) fn extract_text_by_format(fmt: &ApiFormat, json: &Value) -> String {
    match fmt {
        ApiFormat::Openai => json
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                json.pointer("/choices/0/message/content")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|part| {
                                part.get("text")
                                    .and_then(Value::as_str)
                                    .or_else(|| part.pointer("/text/value").and_then(Value::as_str))
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .or_else(|| {
                json.pointer("/choices/0/message/reasoning_content")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .or_else(|| {
                json.pointer("/choices/0/message/reasoning")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_default(),
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
        ApiFormat::Gemini => crate::commands::google_gemini::extract_gemini_parts_text(json),
    }
}

pub(super) fn extracted_text_kind(fmt: &ApiFormat, json: &Value) -> &'static str {
    match fmt {
        ApiFormat::Openai => {
            if json
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
                || json
                    .pointer("/choices/0/message/content")
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
            {
                "content"
            } else if json
                .pointer("/choices/0/message/reasoning_content")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
                || json
                    .pointer("/choices/0/message/reasoning")
                    .and_then(Value::as_str)
                    .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
            {
                "reasoning"
            } else {
                "none"
            }
        }
        ApiFormat::Anthropic => "content",
        ApiFormat::Gemini => "content",
    }
}

pub(super) fn extract_reported_model(_fmt: &ApiFormat, json: &Value) -> Option<String> {
    json.get("model")
        .and_then(Value::as_str)
        .or_else(|| json.pointer("/message/model").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

pub(super) fn remember_reported_model(ctx: &mut EvalContext, model: Option<String>) {
    if ctx.reported_model.is_some() {
        return;
    }
    if let Some(model) = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
    {
        ctx.reported_model = Some(model);
    }
}

pub(super) fn model_relation(requested: &str, reported: Option<&str>) -> &'static str {
    let Some(reported) = reported.map(str::trim).filter(|s| !s.is_empty()) else {
        return "unknown";
    };
    let req = normalize_model_name(requested);
    let rep = normalize_model_name(reported);
    if req == rep {
        return "exact";
    }
    if req.contains(&rep) || rep.contains(&req) {
        return "alias";
    }
    if model_family(&req) == model_family(&rep) && model_family(&req) != "unknown" {
        return "same_family";
    }
    "different"
}

pub(super) fn normalize_model_name(name: &str) -> String {
    name.to_ascii_lowercase().replace('_', "-").replace(' ', "")
}

pub(super) fn model_family(name: &str) -> &'static str {
    if name.contains("claude") {
        "claude"
    } else if name.contains("gpt")
        || name.starts_with("o1-")
        || name.starts_with("o3-")
        || name.starts_with("o4-")
    {
        "openai"
    } else if name.contains("gemini") {
        "gemini"
    } else if name.contains("deepseek") {
        "deepseek"
    } else if name.contains("qwen") || name.contains("qwq") || name.contains("qvq") {
        "qwen"
    } else if name.contains("llama") {
        "llama"
    } else if name.contains("grok") {
        "grok"
    } else if name.contains("mistral") || name.contains("codestral") {
        "mistral"
    } else if name.contains("glm") {
        "glm"
    } else if name.contains("kimi") || name.contains("moonshot") {
        "kimi"
    } else {
        "unknown"
    }
}

pub(super) fn parse_json_from_text(text: &str) -> Option<Value> {
    let mut s = text.trim();
    if s.starts_with("```") {
        s = s.trim_start_matches("```").trim();
        if let Some(rest) = s.strip_prefix("json") {
            s = rest.trim();
        }
        if let Some(idx) = s.rfind("```") {
            s = s[..idx].trim();
        }
    }
    serde_json::from_str::<Value>(s).ok().or_else(|| {
        let start = s.find('{')?;
        let end = s.rfind('}')?;
        if end <= start {
            return None;
        }
        serde_json::from_str::<Value>(&s[start..=end]).ok()
    })
}

pub(super) fn tool_score(ctx: &EvalContext, json: &Value, city: &str) -> (f64, Vec<String>) {
    let mut evidence = Vec::new();
    let mut score = 0.0;
    match ctx.api_format {
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
        ApiFormat::Gemini => {
            let parts = json.pointer("/candidates/0/content/parts").and_then(Value::as_array);
            let tool = parts.and_then(|arr| {
                arr.iter().find(|b| b.get("functionCall").is_some() || b.get("function_call").is_some())
            });
            if tool.is_some() {
                score += 25.0;
                evidence.push("functionCall part present".into());
            }
            let call = tool.and_then(|b| b.get("functionCall").or_else(|| b.get("function_call")));
            let name = call.and_then(|v| v.get("name")).and_then(Value::as_str).unwrap_or("");
            if name == "get_weather" {
                score += 25.0;
            }
            evidence.push(format!(
                "tool_name={}",
                if name.is_empty() { "(missing)" } else { name }
            ));
            let args = call.and_then(|v| v.get("args")).cloned().unwrap_or(Value::Null);
            if args.is_object() {
                score += 25.0;
            }
            let args_str = serde_json::to_string(&args).unwrap_or_default();
            if args_str.contains(city) {
                score += 25.0;
            }
            evidence.push(format!("arguments={}", snippet(&args_str, 120)));
        }
    }
    (score, evidence)
}

pub(super) fn usage_has_numbers_openai(json: &Value) -> bool {
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

pub(super) fn usage_has_numbers_anthropic(json: &Value) -> bool {
    json.pointer("/usage/input_tokens")
        .and_then(Value::as_u64)
        .is_some()
        || json
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64)
            .is_some()
}

pub(super) fn input_tokens(fmt: &ApiFormat, json: &Value) -> Option<u64> {
    match fmt {
        ApiFormat::Openai => json.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        ApiFormat::Anthropic => json.pointer("/usage/input_tokens").and_then(Value::as_u64),
        ApiFormat::Gemini => json
            .pointer("/usageMetadata/promptTokenCount")
            .or_else(|| json.pointer("/usage_metadata/prompt_token_count"))
            .and_then(Value::as_u64),
    }
}

pub(super) fn add_usage(summary: &mut EvalUsageSummary, fmt: &ApiFormat, json: &Value) {
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
        ApiFormat::Gemini => {
            summary.input_tokens += json
                .pointer("/usageMetadata/promptTokenCount")
                .or_else(|| json.pointer("/usage_metadata/prompt_token_count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            summary.output_tokens += json
                .pointer("/usageMetadata/candidatesTokenCount")
                .or_else(|| json.pointer("/usage_metadata/candidates_token_count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
        }
    }
}


pub(super) fn skip_probe(id: &str, name: &str, weight: f64, summary: &str) -> EvalProbeResult {
    probe(id, name, "skip", 0.0, weight, None, summary, Vec::new())
}

pub(super) fn normalize_selected_checks(selected: &[String]) -> Vec<String> {
    selected
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub(super) fn check_selected(ctx: &EvalContext, id: &str) -> bool {
    ctx.selected_checks
        .iter()
        .any(|s| s == &id.to_ascii_uppercase())
}

pub(super) fn total_probe_count(ctx: &EvalContext) -> u32 {
    let mut total = 4_u32; // P1/P2/P3/P7 are required setup and identity checks.
    for id in ["P4", "P5", "P6", "P12", "P13", "P14", "P10"] {
        if check_selected(ctx, id) {
            total += 1;
        }
    }
    if ctx.standard_mode {
        for id in ["P8", "P9", "P11"] {
            if check_selected(ctx, id) {
                total += 1;
            }
        }
    }
    total
}

pub(super) fn push_selected_skip(
    app: &tauri::AppHandle,
    report_id: &str,
    ctx: &EvalContext,
    probes: &mut Vec<EvalProbeResult>,
    completed: &mut u32,
    total: u32,
    id: &str,
    name: &str,
    weight: f64,
) {
    if check_selected(ctx, id) {
        let p = skip_probe(id, name, weight, "协议不可用，跳过");
        push_probe(app, report_id, probes, p, completed, total);
    }
}

pub(super) fn push_probe(
    app: &tauri::AppHandle,
    report_id: &str,
    probes: &mut Vec<EvalProbeResult>,
    probe: EvalProbeResult,
    completed: &mut u32,
    total: u32,
) {
    *completed += 1;
    emit_eval_progress(app, report_id, *completed, total, "probe", Some(&probe));
    probes.push(probe);
}

pub(super) fn emit_eval_progress(
    app: &tauri::AppHandle,
    report_id: &str,
    completed: u32,
    total: u32,
    phase: &str,
    probe: Option<&EvalProbeResult>,
) {
    let payload = EvalProgressEvent {
        report_id: report_id.to_string(),
        completed,
        total,
        phase: phase.to_string(),
        probe_id: probe.map(|p| p.id.clone()).unwrap_or_default(),
        probe_name: probe.map(|p| p.name.clone()).unwrap_or_default(),
        status: probe.map(|p| p.status.clone()).unwrap_or_default(),
        score: probe.map(|p| p.score).unwrap_or(0.0),
    };
    let _ = app.emit("provider-eval-progress", payload);
}

pub(super) fn probe(
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

pub(super) fn status_from_score(score: f64) -> &'static str {
    if score >= 90.0 {
        "pass"
    } else if score >= 60.0 {
        "warn"
    } else {
        "fail"
    }
}

pub(super) fn final_score(probes: &[EvalProbeResult], caps: &[EvalCap]) -> f64 {
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

pub(super) fn risk_level(score: f64) -> &'static str {
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

pub(super) fn verdict(score: f64, caps: &[EvalCap]) -> String {
    if caps.iter().any(|c| c.rule == "protocol_offline") {
        "协议不可用，无法完成检测（请查看诊断结论中的排查提示）".into()
    } else if score >= 85.0 {
        "低风险：协议、能力与响应形态基本正常".into()
    } else if score >= 70.0 {
        "可用但需观察：存在轻微异常或证据不足".into()
    } else if score >= 50.0 {
        "可疑：存在协议偏差、能力缺失或响应不稳定".into()
    } else if score >= 30.0 {
        "高风险：关键探针失败，疑似协议偏差、降级或字段伪造".into()
    } else {
        "不建议使用：协议不可用或高度疑似非目标模型".into()
    }
}

pub(super) fn reports_path() -> std::path::PathBuf {
    config::config_dir_path().join("eval-runs.json")
}

pub(super) fn read_reports() -> Result<Vec<EvalReport>, String> {
    let path = reports_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub(super) fn write_reports(reports: &[EvalReport]) -> Result<(), String> {
    let path = reports_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(reports).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())
}

pub(super) fn save_report(report: EvalReport) -> Result<(), String> {
    let mut reports = read_reports().unwrap_or_default();
    reports.retain(|r| r.id != report.id);
    reports.insert(0, report);
    if reports.len() > REPORT_LIMIT {
        reports.truncate(REPORT_LIMIT);
    }
    write_reports(&reports)
}

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(super) fn snippet(s: &str, max: usize) -> String {
    let mut out = s.replace('\n', " ").replace('\r', " ");
    if out.chars().count() > max {
        out = out.chars().take(max).collect::<String>();
        out.push_str("...");
    }
    out
}

pub(super) fn redact(provider: &Provider, msg: &str) -> String {
    let key = provider.api_key.as_str();
    if key.len() >= 6 && msg.contains(key) {
        msg.replace(key, "***REDACTED***")
    } else {
        msg.to_string()
    }
}

