use crate::commands::config::Provider;
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

use super::super::common::{
    first_json_string, json_string_candidates, mask_key, parse_json_object, provider_endpoint_url,
    strip_first_matching_suffix, ClaudeConfigInfo, PLATFORM_CLAUDE_CODE,
};

pub(in crate::commands::platforms) const CLAUDE_MODEL_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
];

pub(in crate::commands::platforms) const CLAUDE_AUTH_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
];

pub(in crate::commands::platforms) const CLAUDE_MANAGED_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "CLAUDE_CODE_MAX_RETRIES",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
];


pub(in crate::commands::platforms) fn claude_base_url(p: &Provider) -> String {
    strip_first_matching_suffix(
        &provider_endpoint_url(p),
        &["/v1/messages", "/messages", "/v1"],
    )
}


pub(in crate::commands::platforms) fn strip_one_m_marker(model: &str) -> &str {
    let trimmed = model.trim();
    if let Some(stripped) = trimmed
        .strip_suffix("[1m]")
        .or_else(|| trimmed.strip_suffix("[1M]"))
    {
        stripped.trim()
    } else {
        trimmed
    }
}


pub(in crate::commands::platforms) fn is_claude_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("claude")
}


pub(in crate::commands::platforms) fn ensure_one_m_marker_if_needed(model: &str, is_anyrouter: bool) -> String {
    let trimmed = model.trim();
    if is_anyrouter && is_claude_model(trimmed) {
        if trimmed.ends_with("[1m]") || trimmed.ends_with("[1M]") {
            trimmed.to_string()
        } else if !trimmed.is_empty() {
            format!("{trimmed}[1m]")
        } else {
            String::new()
        }
    } else {
        strip_one_m_marker(trimmed).to_string()
    }
}


pub(in crate::commands::platforms) fn set_claude_model_env(env: &mut Map<String, Value>, model: &str) {
    let raw_model = model.trim();
    let display_name = strip_one_m_marker(raw_model);
    env.insert(
        "ANTHROPIC_MODEL".to_string(),
        Value::String(raw_model.to_string()),
    );
    for (model_key, name_key) in [
        (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        ),
        (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        ),
        (
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
        ),
        (
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
        ),
    ] {
        env.insert(model_key.to_string(), Value::String(raw_model.to_string()));
        env.insert(
            name_key.to_string(),
            Value::String(display_name.to_string()),
        );
    }
    env.remove("ANTHROPIC_SMALL_FAST_MODEL");
}


pub(in crate::commands::platforms) fn clone_claude_env_string(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}


pub(in crate::commands::platforms) fn set_claude_env_if_missing(env: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if env.get(key).and_then(Value::as_str).is_some() {
        return;
    }
    if let Some(value) = value {
        env.insert(key.to_string(), Value::String(value));
    }
}


pub(in crate::commands::platforms) fn normalize_claude_settings_model_env(settings: &mut Value, fallback_model: &str) {
    let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) else {
        return;
    };

    let base_url = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .unwrap_or("");
    let is_anyrouter = base_url.to_ascii_lowercase().contains("anyrouter");

    let fallback = {
        let fallback_model = fallback_model.trim();
        if fallback_model.is_empty() {
            None
        } else {
            Some(ensure_one_m_marker_if_needed(fallback_model, is_anyrouter))
        }
    };
    let primary = clone_claude_env_string(env, "ANTHROPIC_MODEL")
        .map(|m| ensure_one_m_marker_if_needed(&m, is_anyrouter))
        .or_else(|| fallback.clone());
    set_claude_env_if_missing(env, "ANTHROPIC_MODEL", primary.clone());

    let small_fast = clone_claude_env_string(env, "ANTHROPIC_SMALL_FAST_MODEL");
    let haiku = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"))
        .or_else(|| small_fast.clone())
        .or_else(|| primary.clone())
        .map(|m| ensure_one_m_marker_if_needed(&m, is_anyrouter));
    let sonnet = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"))
        .or_else(|| primary.clone())
        .or_else(|| small_fast.clone())
        .map(|m| ensure_one_m_marker_if_needed(&m, is_anyrouter));
    let opus = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_OPUS_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"))
        .or_else(|| primary.clone())
        .or_else(|| small_fast.clone())
        .map(|m| ensure_one_m_marker_if_needed(&m, is_anyrouter));
    let fable = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_FABLE_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"))
        .or_else(|| primary.clone())
        .or_else(|| opus.clone())
        .map(|m| ensure_one_m_marker_if_needed(&m, is_anyrouter));

    let haiku_name = haiku.as_deref().map(strip_one_m_marker).map(str::to_string);
    let sonnet_name = sonnet
        .as_deref()
        .map(strip_one_m_marker)
        .map(str::to_string);
    let opus_name = opus.as_deref().map(strip_one_m_marker).map(str::to_string);
    let fable_name = fable.as_deref().map(strip_one_m_marker).map(str::to_string);

    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL", haiku);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", haiku_name);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_SONNET_MODEL", sonnet);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", sonnet_name);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", opus);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", opus_name);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_FABLE_MODEL", fable);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", fable_name);

    if is_anyrouter {
        for key in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            if let Some(val) = env.get(key).and_then(Value::as_str) {
                if is_claude_model(val) {
                    if !val.ends_with("[1m]") && !val.ends_with("[1M]") && !val.trim().is_empty() {
                        let upgraded = format!("{}[1m]", val.trim());
                        env.insert(key.to_string(), Value::String(upgraded));
                    }
                } else {
                    let stripped = strip_one_m_marker(val);
                    env.insert(key.to_string(), Value::String(stripped.to_string()));
                }
            }
        }
        for name_key in [
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
        ] {
            if let Some(val) = env.get(name_key).and_then(Value::as_str) {
                let stripped = strip_one_m_marker(val);
                env.insert(name_key.to_string(), Value::String(stripped.to_string()));
            }
        }
    }

    env.remove("ANTHROPIC_SMALL_FAST_MODEL");

    if is_anyrouter {
        if let Some(model_val) = settings.get_mut("model") {
            if let Some(s) = model_val.as_str() {
                if is_claude_model(s) {
                    if !s.ends_with("[1m]") && !s.ends_with("[1M]") && !s.trim().is_empty() {
                        *model_val = Value::String(format!("{}[1m]", s.trim()));
                    }
                } else {
                    let stripped = strip_one_m_marker(s);
                    *model_val = Value::String(stripped.to_string());
                }
            }
        }
    }
}


pub(in crate::commands::platforms) fn read_claude_config_info(path: &PathBuf) -> Result<Option<ClaudeConfigInfo>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some(ClaudeConfigInfo {
            model: None,
            model_candidates: Vec::new(),
            base_url: None,
            has_auth_token: false,
            auth_token_masked: None,
            is_official: true,
            managed_by_any_bridge: false,
        }));
    }

    let obj = parse_json_object(&raw, "settings.json")?;
    let env = obj.get("env").and_then(Value::as_object);
    let base_url = first_json_string(env, &["ANTHROPIC_BASE_URL"]);
    let auth_token = first_json_string(env, CLAUDE_AUTH_ENV_KEYS);
    let model_candidates = json_string_candidates(env, CLAUDE_MODEL_ENV_KEYS);
    let model = model_candidates.first().cloned();
    let has_auth_token = auth_token.is_some();
    let is_official = base_url.is_none() && auth_token.is_none();

    Ok(Some(ClaudeConfigInfo {
        model,
        model_candidates,
        base_url,
        has_auth_token,
        auth_token_masked: auth_token.as_deref().map(mask_key),
        is_official,
        managed_by_any_bridge: false,
    }))
}


// ─── 字段级记账与还原（配置切换重构 2026-10-26） ─────────────────
//
// 记账（apply 时总是执行，纯增量、无行为变化）：把「覆盖前原值 original」
// 与「本次写入值 applied」记入独立账本 agent-stash.json。记账失败只影响
// 字段级还原能力，绝不阻断切换主流程。
//
// 还原（门控 ANYBRIDGE_FIELD_RESTORE，默认关闭）：关闭时一切还原路径与
// 旧版本完全一致（整文件备份覆盖 / 删托管键）。开启后按记录逐字段写回
// 原值，被外部改过的字段保留用户改动；无记录时退回「删托管键」旧语义。

pub(in crate::commands::platforms) fn claude_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: PLATFORM_CLAUDE_CODE,
        file: "settings.json",
    }
}


/// 按路径段读 JSON 值。
pub(in crate::commands::platforms) fn json_value_at<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut cur = root;
    for seg in path {
        cur = cur.get(seg)?;
    }
    Some(cur)
}


/// 漂移分类（借鉴 magpie applied.go 的 Drift kind，由字段语义推断）：
/// 接入地址被改走 → "unwired"；模型被改回/换掉 → "replaced"；其余 → "changed"。
pub(in crate::commands::platforms) fn drift_kind_of(path: &[String]) -> &'static str {
    let last = path.last().map(|s| s.as_str()).unwrap_or_default();
    if last.contains("BASE_URL") {
        "unwired"
    } else if last.contains("MODEL") {
        "replaced"
    } else {
        "changed"
    }
}
