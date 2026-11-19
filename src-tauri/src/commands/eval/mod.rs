use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::time::Instant;

use crate::commands::config::{self, ApiFormat, Provider};

pub(super) const REPORT_LIMIT: usize = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvalMode {
    Quick,
    Standard,
}

impl Default for EvalMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequest {
    pub provider_id: String,
    pub api_format: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: EvalMode,
    #[serde(default)]
    pub selected_checks: Vec<String>,
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
    #[serde(default)]
    pub reported_model: Option<String>,
    pub mode: String,
    pub score: f64,
    pub risk_level: String,
    pub verdict: String,
    pub caps: Vec<EvalCap>,
    pub probes: Vec<EvalProbeResult>,
    #[serde(default)]
    pub capability_checks: Vec<EvalCheck>,
    #[serde(default)]
    pub protocol_checks: Vec<EvalCheck>,
    pub usage: EvalUsageSummary,
    #[serde(default)]
    pub metrics: EvalMetrics,
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
pub struct EvalCheck {
    pub key: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalProgressEvent {
    pub report_id: String,
    pub completed: u32,
    pub total: u32,
    pub phase: String,
    pub probe_id: String,
    pub probe_name: String,
    pub status: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvalUsageSummary {
    pub request_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvalMetrics {
    #[serde(default)]
    pub model_relation: String,
    #[serde(default)]
    pub ttft_ms: Option<u64>,
    #[serde(default)]
    pub tokens_per_second: Option<f64>,
    #[serde(default)]
    pub throughput_tokens: Option<u64>,
    #[serde(default)]
    pub generation_ms: Option<u64>,
    #[serde(default)]
    pub stream_chunk_count: Option<u32>,
    #[serde(default)]
    pub avg_latency_ms: Option<f64>,
    #[serde(default)]
    pub latency_cv: Option<f64>,
}

pub(super) struct EvalContext {
    pub(super) provider: Provider,
    pub(super) api_format: ApiFormat,
    pub(super) model: String,
    pub(super) client: reqwest::Client,
    pub(super) usage: EvalUsageSummary,
    pub(super) reported_model: Option<String>,
    pub(super) metrics: EvalMetrics,
    pub(super) protocol_checks: Vec<EvalCheck>,
    pub(super) selected_checks: Vec<String>,
    pub(super) standard_mode: bool,
}

impl EvalContext {
    fn reported_model(&self) -> Option<String> {
        self.reported_model.clone()
    }
}

pub(super) struct JsonCall {
    pub(super) status: u16,
    pub(super) latency_ms: u64,
    pub(super) body_text: String,
    pub(super) json: Option<Value>,
}

pub(super) struct StreamCall {
    pub(super) status: u16,
    pub(super) latency_ms: u64,
    pub(super) first_byte_ms: Option<u64>,
    pub(super) content_type: String,
    pub(super) chunk_count: usize,
    pub(super) body_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OpenAiEndpoint {
    Chat,
    Responses,
    GeminiOpenai,
}

#[tauri::command]
pub async fn run_provider_eval(
    app: tauri::AppHandle,
    request: EvalRequest,
) -> Result<EvalReport, String> {
    let started = Instant::now();
    let report_id = format!("eval-{}", now_millis());
    let mut provider = find_provider(&request.provider_id)?;
    if !provider.enabled {
        return Err(format!("供应商已禁用: {}", provider.name));
    }
    let eval_api_format = parse_eval_api_format(&request.api_format)?;
    provider.api_format = Some(eval_api_format);
    let model = request
        .model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| provider.default_model.clone());
    if model.trim().is_empty() {
        return Err("供应商未配置默认模型，请先选择一个模型".into());
    }

    let client = crate::commands::apply_system_proxy(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .connect_timeout(std::time::Duration::from_secs(12)),
    )
    .build()
    .map_err(|e| e.to_string())?;

    let mut ctx = EvalContext {
        provider,
        api_format: eval_api_format,
        model,
        client,
        usage: EvalUsageSummary::default(),
        reported_model: None,
        metrics: EvalMetrics::default(),
        protocol_checks: Vec::new(),
        selected_checks: normalize_selected_checks(&request.selected_checks),
        standard_mode: matches!(request.mode, EvalMode::Standard),
    };

    let mut probes = Vec::new();
    let mut caps = Vec::new();
    let total = total_probe_count(&ctx);
    let mut completed = 0_u32;

    emit_eval_progress(&app, &report_id, completed, total, "started", None);

    let setup = probe_connectivity(&mut ctx).await;
    let setup_ok = setup
        .as_ref()
        .map(|(_, p)| p.status == "pass" || p.status == "warn")
        .unwrap_or(false);

    match setup {
        Ok((call, p1)) => {
            push_probe(&app, &report_id, &mut probes, p1, &mut completed, total);
            let p2 = probe_response_structure(&ctx, &call);
            if p2.status == "fail" && p2.score <= 25.0 {
                caps.push(EvalCap {
                    rule: "response_schema_broken".into(),
                    cap_value: 40.0,
                    reason: "响应结构严重缺失，协议层与官方格式不兼容".into(),
                });
            }
            push_probe(&app, &report_id, &mut probes, p2, &mut completed, total);

            let p3 = probe_response_signature(&ctx, &call);
            if p3.status == "fail" && p3.score <= 45.0 {
                caps.push(EvalCap {
                    rule: "response_signature_invalid".into(),
                    cap_value: 40.0,
                    reason: "关键响应签名字段不合规，疑似非预期中转或字段伪造".into(),
                });
            }
            push_probe(&app, &report_id, &mut probes, p3, &mut completed, total);

            let p7 = probe_model_echo(&mut ctx, &call);
            push_probe(&app, &report_id, &mut probes, p7, &mut completed, total);
        }
        Err(p) => {
            caps.push(EvalCap {
                rule: "protocol_offline".into(),
                cap_value: 10.0,
                reason: format!("协议连通性失败（{}），后续探针已跳过", p.summary),
            });
            push_probe(&app, &report_id, &mut probes, p, &mut completed, total);
            let p7 = skip_probe("P7", "模型回显", 8.0, "协议不可用，跳过");
            push_probe(&app, &report_id, &mut probes, p7, &mut completed, total);
        }
    }

    if setup_ok {
        if check_selected(&ctx, "P4") {
            let p4 = probe_canary(&mut ctx).await;
            push_probe(&app, &report_id, &mut probes, p4, &mut completed, total);
        }
        if check_selected(&ctx, "P5") {
            let p5 = probe_stream_integrity(&mut ctx).await;
            push_probe(&app, &report_id, &mut probes, p5, &mut completed, total);
        }
        if check_selected(&ctx, "P6") {
            let p6 = probe_tool_calling(&mut ctx).await;
            push_probe(&app, &report_id, &mut probes, p6, &mut completed, total);
        }
        if check_selected(&ctx, "P12") {
            let p12 = probe_vision_understanding(&mut ctx).await;
            push_probe(&app, &report_id, &mut probes, p12, &mut completed, total);
        }
        if check_selected(&ctx, "P13") {
            let p13 = probe_protocol_compatibility(&mut ctx).await;
            push_probe(&app, &report_id, &mut probes, p13, &mut completed, total);
        }
        if check_selected(&ctx, "P14") {
            let p14 = probe_prompt_injection(&mut ctx).await;
            if p14.status == "fail" && p14.score <= 40.0 {
                caps.push(EvalCap {
                    rule: "prompt_injection_leak".into(),
                    cap_value: 55.0,
                    reason: "提示词注入探针疑似套出系统提示词或隐藏 canary".into(),
                });
            }
            push_probe(&app, &report_id, &mut probes, p14, &mut completed, total);
        }
        if check_selected(&ctx, "P10") {
            let p10 = probe_performance(&mut ctx).await;
            push_probe(&app, &report_id, &mut probes, p10, &mut completed, total);
        }

        if matches!(request.mode, EvalMode::Standard) {
            if check_selected(&ctx, "P8") {
                let p = probe_token_injection(&mut ctx).await;
                if p.status == "fail" && p.score <= 40.0 {
                    caps.push(EvalCap {
                        rule: "token_injection_suspect".into(),
                        cap_value: 60.0,
                        reason: "极短请求的输入 token 明显异常，疑似隐藏 prompt 注入或路由包装"
                            .into(),
                    });
                }
                push_probe(&app, &report_id, &mut probes, p, &mut completed, total);
            }
            if check_selected(&ctx, "P9") {
                let p9 = probe_json_mode(&mut ctx).await;
                push_probe(&app, &report_id, &mut probes, p9, &mut completed, total);
            }
            if check_selected(&ctx, "P11") {
                let p11 = probe_output_throughput(&mut ctx).await;
                push_probe(&app, &report_id, &mut probes, p11, &mut completed, total);
            }
        }
    } else {
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P4",
            "内容 Canary",
            8.0,
        );
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P5",
            "流完整性",
            8.0,
        );
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P6",
            "工具调用",
            10.0,
        );
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P12",
            "图片理解",
            8.0,
        );
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P13",
            "调用方式兼容",
            6.0,
        );
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P14",
            "提示词注入",
            8.0,
        );
        push_selected_skip(
            &app,
            &report_id,
            &ctx,
            &mut probes,
            &mut completed,
            total,
            "P10",
            "性能稳定性",
            10.0,
        );
        if matches!(request.mode, EvalMode::Standard) {
            push_selected_skip(
                &app,
                &report_id,
                &ctx,
                &mut probes,
                &mut completed,
                total,
                "P8",
                "Token 注入粗测",
                7.0,
            );
            push_selected_skip(
                &app,
                &report_id,
                &ctx,
                &mut probes,
                &mut completed,
                total,
                "P9",
                "JSON 模式",
                7.0,
            );
            push_selected_skip(
                &app,
                &report_id,
                &ctx,
                &mut probes,
                &mut completed,
                total,
                "P11",
                "输出吞吐",
                8.0,
            );
        }
    }

    let reported_model = ctx.reported_model();
    ctx.metrics.model_relation = model_relation(&ctx.model, reported_model.as_deref()).to_string();
    let metrics = ctx.metrics.clone();
    let capability_checks = build_capability_checks(&ctx, &probes);
    let protocol_checks = build_protocol_checks(&ctx, &probes);
    let score = final_score(&probes, &caps);
    let risk_level = risk_level(score).to_string();
    let verdict = verdict(score, &caps);
    let mode = match request.mode {
        EvalMode::Quick => "quick",
        EvalMode::Standard => "standard",
    }
    .to_string();

    let report = EvalReport {
        id: report_id.clone(),
        created_at: now_millis(),
        provider_id: ctx.provider.id.clone(),
        provider_name: ctx.provider.name.clone(),
        api_format: api_format_str(&ctx.api_format).to_string(),
        model: ctx.model.clone(),
        reported_model,
        mode,
        score,
        risk_level,
        verdict,
        caps,
        probes,
        capability_checks,
        protocol_checks,
        usage: ctx.usage,
        metrics,
        duration_ms: started.elapsed().as_millis() as u64,
    };

    save_report(report.clone())?;
    emit_eval_progress(&app, &report_id, total, total, "finished", None);
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

/// 单次连通性尝试，返回 Ok(成功) 或 Err(失败探针结果)

mod probes_advanced;
mod probes_basic;
mod protocol_and_checks;
mod requests;
mod scoring_and_reports;

use probes_advanced::*;
use probes_basic::*;
use protocol_and_checks::*;
use requests::*;
use scoring_and_reports::*;

#[cfg(test)]
mod tests;
