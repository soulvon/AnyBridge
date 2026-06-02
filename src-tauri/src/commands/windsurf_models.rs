// windsurf_models.rs — Windsurf 模型清单：内置静态表 + 登录后从云端更新。
//
// 默认用内置静态表（覆盖主流模型，带干净显示名），无需登录。
// 用户在设置页「更新模型列表」时才登录 Windsurf 账户，从 GetUserStatus 拉取最新
// clientModelConfigs（含官方 label），合并/覆盖内置表后持久化到 windsurf-models.json。

use serde::{Deserialize, Serialize};
use std::fs;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindsurfModel {
    /// Windsurf 内部 enum，如 MODEL_PRIVATE_2
    pub id: String,
    /// 干净显示名，如 "Claude Sonnet 4.5"
    pub name: String,
    /// 厂商：anthropic / openai / google / xai / windsurf / other
    pub provider: String,
    /// 是否常用主流（UI 默认展示，其余折叠进搜索）
    #[serde(default)]
    pub common: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelList {
    pub models: Vec<WindsurfModel>,
    /// 来源：builtin / updated
    pub source: String,
    /// 更新时间（ISO 字符串），内置为空
    #[serde(default)]
    pub updated_at: String,
}

fn m(id: &str, name: &str, provider: &str, common: bool) -> WindsurfModel {
    WindsurfModel { id: id.into(), name: name.into(), provider: provider.into(), common }
}

/// 内置静态表：日常默认使用。基于实测 GetUserStatus + UID_PROTO_MAP 整理，
/// 主流对话模型标 common=true，其余（含 effort 变体、内部代号）common=false 供搜索。
pub fn builtin_models() -> Vec<WindsurfModel> {
    vec![
        // ── Anthropic Claude（主流） ──
        m("MODEL_PRIVATE_2", "Claude Sonnet 4.5", "anthropic", true),
        m("MODEL_PRIVATE_3", "Claude Sonnet 4.5 Thinking", "anthropic", true),
        m("MODEL_CLAUDE_4_5_OPUS", "Claude Opus 4.5", "anthropic", true),
        m("MODEL_CLAUDE_4_5_OPUS_THINKING", "Claude Opus 4.5 Thinking", "anthropic", true),
        m("MODEL_CLAUDE_4_SONNET", "Claude Sonnet 4", "anthropic", true),
        m("MODEL_CLAUDE_4_SONNET_THINKING", "Claude Sonnet 4 Thinking", "anthropic", true),
        m("MODEL_CLAUDE_4_OPUS", "Claude Opus 4", "anthropic", false),
        m("MODEL_CLAUDE_4_OPUS_THINKING", "Claude Opus 4 Thinking", "anthropic", false),
        m("MODEL_CLAUDE_4_1_OPUS", "Claude Opus 4.1", "anthropic", false),
        m("MODEL_CLAUDE_4_1_OPUS_THINKING", "Claude Opus 4.1 Thinking", "anthropic", false),
        m("MODEL_PRIVATE_11", "Claude Haiku 4.5", "anthropic", true),
        m("MODEL_CLAUDE_3_7_SONNET", "Claude 3.7 Sonnet", "anthropic", false),
        m("MODEL_CLAUDE_3_7_SONNET_THINKING", "Claude 3.7 Sonnet Thinking", "anthropic", false),
        m("MODEL_CLAUDE_3_5_SONNET", "Claude 3.5 Sonnet", "anthropic", false),
        m("MODEL_CLAUDE_3_5_HAIKU_20241022", "Claude 3.5 Haiku", "anthropic", false),
        // BYOK 变体
        m("MODEL_CLAUDE_4_SONNET_BYOK", "Claude Sonnet 4 (BYOK)", "anthropic", false),
        m("MODEL_CLAUDE_4_SONNET_THINKING_BYOK", "Claude Sonnet 4 Thinking (BYOK)", "anthropic", false),
        m("MODEL_CLAUDE_4_OPUS_BYOK", "Claude Opus 4 (BYOK)", "anthropic", false),
        m("MODEL_CLAUDE_4_OPUS_THINKING_BYOK", "Claude Opus 4 Thinking (BYOK)", "anthropic", false),
        m("MODEL_CLAUDE_3_7_SONNET_BYOK", "Claude 3.7 Sonnet (BYOK)", "anthropic", false),
        m("MODEL_CLAUDE_3_7_SONNET_THINKING_BYOK", "Claude 3.7 Sonnet Thinking (BYOK)", "anthropic", false),
        m("MODEL_CLAUDE_3_5_SONNET_BYOK", "Claude 3.5 Sonnet (BYOK)", "anthropic", false),

        // ── OpenAI GPT / O 系列 ──
        m("MODEL_PRIVATE_6", "GPT-5 Low Thinking", "openai", true),
        m("MODEL_PRIVATE_7", "GPT-5 Medium Thinking", "openai", true),
        m("MODEL_PRIVATE_8", "GPT-5 High Thinking", "openai", true),
        m("MODEL_PRIVATE_5", "GPT-5-Codex", "openai", true),
        m("MODEL_PRIVATE_12", "GPT-5.1", "openai", true),
        m("MODEL_CHAT_GPT_5_CODEX", "GPT-5 Codex", "openai", false),
        m("MODEL_CHAT_GPT_5_MINIMAL", "GPT-5 Minimal", "openai", false),
        m("MODEL_GPT_5_NANO", "GPT-5 Nano", "openai", false),
        m("MODEL_GPT_5_1_CODEX_LOW", "GPT-5.1 Codex Low", "openai", false),
        m("MODEL_GPT_5_1_CODEX_MINI_LOW", "GPT-5.1 Codex Mini Low", "openai", false),
        m("MODEL_GPT_5_1_CODEX_MAX_LOW", "GPT-5.1 Codex Max Low", "openai", false),
        m("MODEL_GPT_5_1_CODEX_MAX_MEDIUM", "GPT-5.1 Codex Max Medium", "openai", false),
        m("MODEL_GPT_5_1_CODEX_MAX_HIGH", "GPT-5.1 Codex Max High", "openai", false),
        m("MODEL_CHAT_GPT_4O_2024_08_06", "GPT-4o", "openai", true),
        m("MODEL_CHAT_GPT_4O_MINI_2024_07_18", "GPT-4o mini", "openai", false),
        m("MODEL_CHAT_GPT_4_1_2025_04_14", "GPT-4.1", "openai", false),
        m("MODEL_CHAT_GPT_4_1_MINI_2025_04_14", "GPT-4.1 mini", "openai", false),
        m("MODEL_GPT_OSS_120B", "GPT-OSS 120B", "openai", false),
        m("MODEL_CHAT_O3", "o3", "openai", false),
        m("MODEL_CHAT_O3_HIGH", "o3 High", "openai", false),

        // ── Google Gemini ──
        m("MODEL_GOOGLE_GEMINI_2_5_PRO", "Gemini 2.5 Pro", "google", true),
        m("MODEL_GOOGLE_GEMINI_2_5_FLASH", "Gemini 2.5 Flash", "google", true),
        m("MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING", "Gemini 2.5 Flash Thinking", "google", false),
        m("MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL", "Gemini 3.0 Flash Minimal", "google", false),
        m("MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW", "Gemini 3.0 Flash Low", "google", false),
        m("MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM", "Gemini 3.0 Flash", "google", true),
        m("MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH", "Gemini 3.0 Flash High", "google", false),

        // ── xAI Grok ──
        m("MODEL_PRIVATE_4", "Grok Code Fast 1", "xai", true),
        m("MODEL_XAI_GROK_3", "Grok 3", "xai", false),
        m("MODEL_XAI_GROK_3_MINI_REASONING", "Grok 3 mini Thinking", "xai", false),

        // ── 其他厂商 ──
        m("MODEL_KIMI_K2", "Kimi K2", "other", false),
        m("MODEL_MINIMAX_M2_1", "MiniMax M2", "other", false),
        m("MODEL_GLM_4_7", "GLM-4.7", "other", false),

        // ── Windsurf 自研 ──
        m("MODEL_SWE_1_5", "SWE-1.5", "windsurf", true),
        m("MODEL_SWE_1_5_SLOW", "SWE-1.5 (Slow)", "windsurf", false),
        m("MODEL_CHAT_11121", "Windsurf Fast", "windsurf", false),
    ]
}

// ─── 抓取的真实清单（windsurf-models.json）─────────────────────
// 代理拦截 GetUserStatus 时 dump 的 [{modelUid, label}]，是「原始名下拉框」的首选数据源。

#[derive(Debug, Deserialize)]
struct CapturedEntry {
    #[serde(rename = "modelUid")]
    model_uid: String,
    label: String,
}

#[derive(Debug, Deserialize)]
struct CapturedFile {
    #[serde(default)]
    models: Vec<CapturedEntry>,
}

/// 返回「原始名下拉框」用的模型清单:优先 captured（真实抓到的），其次内置静态表。
/// 跳过 tokenizer 占位脏数据（label 形如 https://...）。返回 [{id, label}]。
#[tauri::command]
pub fn list_windsurf_models() -> Result<Vec<WindsurfModel>, String> {
    let path = super::config::config_dir_path().join("windsurf-models.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<CapturedFile>(&raw) {
            let mut seen = std::collections::HashSet::new();
            let models: Vec<WindsurfModel> = parsed
                .models
                .into_iter()
                .filter(|e| !e.label.starts_with("http"))
                .filter(|e| seen.insert(e.model_uid.clone()))
                .map(|e| WindsurfModel {
                    id: e.model_uid,
                    name: e.label,
                    provider: String::new(),
                    common: false,
                })
                .collect();
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }
    Ok(builtin_models())
}
