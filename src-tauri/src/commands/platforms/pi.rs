use crate::commands::config::Provider;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::buddy::{codebuddy_chat_url, codebuddy_supports_reasoning};
use super::common::{
    agent_stash_dir, ensure_backup, ensure_parent_dir, mask_key, parse_json_object,
    provider_endpoint_url,
};
use super::model_context::{recommend_context_window, recommend_max_output_tokens};
use super::platform_enum::Platform;
use super::yaml_block::{managed_read_state, managed_write_state};

/// Pi models.json 中由 AnyBridge 写入的 provider 统一前缀（`anybridge-<模型 id>`），
/// 加载 / 覆盖 / 还原只操作这些条目，用户手写的 provider（如 local）原样保留。
pub(in crate::commands::platforms) const PI_PROVIDER_PREFIX: &str = "anybridge";

/// Pi 内建 API 实现名（OpenAI 兼容协议）。
pub(in crate::commands::platforms) const PI_API_OPENAI_COMPLETIONS: &str = "openai-completions";

pub(in crate::commands::platforms) const PI_API_OPENAI_RESPONSES: &str = "openai-responses";


// ─── Pi（Pi Coding Agent）─────────────────────────────────────────
//
// 按照与 ZCode 一致的逻辑：按供应商（vendor + baseURL + api + apiKey）分组写入
// ~/.pi/agent/models.json 的 providers，同一供应商的所有模型归入同一个 provider。
// 这样在 Pi 终端与 PiDeck 桌面客户端中，模型选择器会按供应商折叠分组，
// 不再出现每个模型单独占一个分组（1 模型）的割裂情况。
//
// 规则：
// 1. 同一 vendor + baseURL + apiKey 的模型聚合到同一个 provider 条目；
// 2. provider 的 key 优先使用供应商名称（如 "商汤"、"CPA"、"黑与白Grok"），
//    若为空或通用名称则回落为 "AnyBridge"；
// 3. 每一个由 AnyBridge 写入的 provider 对象都带有 `"_source": "anybridge"` 标记；
// 4. 用户手写的 provider（如 local）未带该标记且不以 anybridge- 开头，绝不触碰；
// 5. 首条启用的模型写入 settings.json 的 defaultProvider / defaultModel；
// 6. 停用条目存入 anybridge-models-state.json，随时可重新启用。

pub(in crate::commands::platforms) fn pi_is_managed_provider(provider_id: &str, provider: &Value) -> bool {
    let source = provider
        .get("_source")
        .or_else(|| provider.get("source"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    source == "anybridge"
        || source == "ide-byok"
        || provider_id == PI_PROVIDER_PREFIX
        || provider_id.starts_with(&format!("{PI_PROVIDER_PREFIX}-"))
        || provider_id.starts_with("AnyBridge-")
}


pub(in crate::commands::platforms) fn pi_is_managed_provider_id(dir: &Path, provider_id: &str) -> bool {
    if provider_id == PI_PROVIDER_PREFIX
        || provider_id.starts_with(&format!("{PI_PROVIDER_PREFIX}-"))
        || provider_id.starts_with("AnyBridge-")
    {
        return true;
    }
    let models_path = dir.join("models.json");
    if let Ok(raw) = fs::read_to_string(&models_path) {
        if let Ok(obj) = serde_json::from_str::<Value>(&raw) {
            if let Some(prov) = obj.get("providers").and_then(|p| p.get(provider_id)) {
                return pi_is_managed_provider(provider_id, prov);
            }
        }
    }
    false
}


pub(in crate::commands::platforms) fn pi_entry_enabled(entry: &Value) -> bool {
    entry
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}


pub(in crate::commands::platforms) fn pi_positive_u64(value: Option<&Value>) -> Option<u64> {
    let n = value?.as_f64()?;
    if n > 0.0 {
        Some(n as u64)
    } else {
        None
    }
}


/// 完整端点 URL → Pi 的 (baseUrl, api)：
/// 以 /responses 结尾走 openai-responses，否则按 chat completions 处理。
pub(in crate::commands::platforms) fn pi_endpoint_parts(url: &str) -> (String, &'static str) {
    let trimmed = url.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    if let Some(base) = lower.strip_suffix("/responses") {
        let base = trimmed[..base.len()].trim_end_matches('/').to_string();
        (base, PI_API_OPENAI_RESPONSES)
    } else if let Some(base) = lower.strip_suffix("/chat/completions") {
        let base = trimmed[..base.len()].trim_end_matches('/').to_string();
        (base, PI_API_OPENAI_COMPLETIONS)
    } else {
        (trimmed.to_string(), PI_API_OPENAI_COMPLETIONS)
    }
}


/// Pi 的 (baseUrl, api) → 表格展示用完整端点 URL。
pub(in crate::commands::platforms) fn pi_full_endpoint(base_url: &str, api: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if api == PI_API_OPENAI_RESPONSES {
        format!("{base}/responses")
    } else {
        format!("{base}/chat/completions")
    }
}


pub(in crate::commands::platforms) struct PiGroupBuilder {
    pub(in crate::commands::platforms) vendor: String,
    pub(in crate::commands::platforms) base_url: String,
    pub(in crate::commands::platforms) api: &'static str,
    pub(in crate::commands::platforms) api_key: String,
    pub(in crate::commands::platforms) models: Vec<Value>,
}


/// 将表格条目列表构建为 Pi 的 providers 映射（按 vendor+baseUrl+api+apiKey 分组）。
/// `mask` 为 true 时 apiKey 脱敏（预览用）。
pub(in crate::commands::platforms) fn pi_build_providers_map(
    entries: &[Value],
    existing_unmanaged: &Map<String, Value>,
    mask: bool,
) -> Result<(Map<String, Value>, Option<(String, String)>), String> {
    let mut groups: Vec<PiGroupBuilder> = Vec::new();

    for entry in entries {
        if !pi_entry_enabled(entry) {
            continue;
        }
        let model_id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if model_id.is_empty() {
            continue;
        }
        let url = entry
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if url.is_empty() {
            return Err(format!("模型 {model_id} 缺少接口地址"));
        }
        let (base_url, api) = pi_endpoint_parts(&url);
        let api_key = entry
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let vendor = entry
            .get("vendor")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "user" && *s != "custom")
            .unwrap_or("AnyBridge")
            .to_string();

        let display_name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != vendor)
            .unwrap_or(&model_id)
            .to_string();
        let supports_images = entry
            .get("supportsImages")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supports_reasoning = entry
            .get("supportsReasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut model_obj = Map::new();
        model_obj.insert("id".to_string(), Value::String(model_id.clone()));
        if display_name != model_id {
            model_obj.insert("name".to_string(), Value::String(display_name));
        }
        if supports_reasoning {
            model_obj.insert("reasoning".to_string(), Value::Bool(true));
        }
        if let Some(ctx) = pi_positive_u64(entry.get("maxInputTokens")) {
            model_obj.insert("contextWindow".to_string(), serde_json::json!(ctx));
        }
        if let Some(max_out) = pi_positive_u64(entry.get("maxOutputTokens")) {
            model_obj.insert("maxTokens".to_string(), serde_json::json!(max_out));
        }
        let input = if supports_images {
            vec![Value::String("text".to_string()), Value::String("image".to_string())]
        } else {
            vec![Value::String("text".to_string())]
        };
        model_obj.insert("input".to_string(), Value::Array(input));
        if let Some(temperature) = entry.get("temperature").and_then(Value::as_f64) {
            model_obj.insert(
                "samplingParams".to_string(),
                serde_json::json!({ "temperature": temperature }),
            );
        }

        if let Some(g) = groups.iter_mut().find(|g| {
            g.vendor == vendor && g.base_url == base_url && g.api == api && g.api_key == api_key
        }) {
            if !g.models.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(&model_id)) {
                g.models.push(Value::Object(model_obj));
            }
        } else {
            groups.push(PiGroupBuilder {
                vendor,
                base_url,
                api,
                api_key,
                models: vec![Value::Object(model_obj)],
            });
        }
    }

    let mut used_ids: HashSet<String> = existing_unmanaged.keys().cloned().collect();
    let mut providers = Map::new();
    let mut default_pair: Option<(String, String)> = None;

    for group in groups {
        let candidate = if group.vendor.trim().is_empty() {
            "AnyBridge".to_string()
        } else {
            group.vendor.clone()
        };
        let mut provider_id = candidate.clone();
        if used_ids.contains(&provider_id) {
            let mut suffix = 2;
            while used_ids.contains(&format!("{candidate}-{suffix}")) {
                suffix += 1;
            }
            provider_id = format!("{candidate}-{suffix}");
        }
        used_ids.insert(provider_id.clone());

        if default_pair.is_none() {
            if let Some(first_m) = group.models.first() {
                if let Some(mid) = first_m.get("id").and_then(Value::as_str) {
                    default_pair = Some((provider_id.clone(), mid.to_string()));
                }
            }
        }

        let mut prov = Map::new();
        prov.insert("baseUrl".to_string(), Value::String(group.base_url));
        prov.insert("api".to_string(), Value::String(group.api.to_string()));
        if !group.api_key.is_empty() {
            let key_val = if mask {
                mask_key(&group.api_key)
            } else {
                group.api_key
            };
            prov.insert("apiKey".to_string(), Value::String(key_val));
        }
        prov.insert("_source".to_string(), Value::String("anybridge".to_string()));
        prov.insert("models".to_string(), Value::Array(group.models));

        providers.insert(provider_id, Value::Object(prov));
    }

    Ok((providers, default_pair))
}


/// models.json 里受管 provider → 表格条目。
pub(in crate::commands::platforms) fn pi_entries_from_provider_map(provider_id: &str, provider: &Map<String, Value>) -> Vec<Value> {
    let base_url = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("");
    let api = provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or(PI_API_OPENAI_COMPLETIONS);
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let url = pi_full_endpoint(base_url, api);
    let vendor = provider_id.to_string();
    let models = provider
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    models
        .iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str)?.trim().to_string();
            if id.is_empty() {
                return None;
            }
            let name = m
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id.as_str())
                .to_string();
            let supports_images = m
                .get("input")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().any(|v| v.as_str() == Some("image")))
                .unwrap_or(false);
            let supports_reasoning = m
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let temperature = m
                .get("samplingParams")
                .and_then(|sp| sp.get("temperature"))
                .and_then(Value::as_f64);
            let mut entry = serde_json::json!({
                "id": id,
                "name": name,
                "vendor": vendor,
                "url": url,
                "apiKey": api_key,
                "supportsToolCall": true,
                "supportsImages": supports_images,
                "supportsReasoning": supports_reasoning,
                "enabled": true,
            });
            if let Some(ctx) = pi_positive_u64(m.get("contextWindow")) {
                entry["maxInputTokens"] = serde_json::json!(ctx);
            }
            if let Some(max_out) = pi_positive_u64(m.get("maxTokens")) {
                entry["maxOutputTokens"] = serde_json::json!(max_out);
            }
            if let Some(t) = temperature {
                entry["temperature"] = serde_json::json!(t);
            }
            Some(entry)
        })
        .collect()
}


/// 供应商（providerStore 条目）→ Pi 表格条目（用于「从供应商切换」与预览）。
pub(in crate::commands::platforms) fn pi_entries_from_provider(p: &Provider) -> Vec<Value> {
    let endpoint = provider_endpoint_url(p);
    let full_url = if endpoint.to_ascii_lowercase().ends_with("/responses") {
        endpoint
    } else {
        codebuddy_chat_url(p)
    };
    let mut ids: Vec<String> = Vec::new();
    let default_model = p.default_model.trim().to_string();
    if !default_model.is_empty() {
        ids.push(default_model);
    }
    for m in &p.models {
        let id = m.trim().to_string();
        if !id.is_empty() && !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids.into_iter()
        .map(|id| {
            let caps = p.model_caps.get(id.trim()).cloned().unwrap_or_default();
            serde_json::json!({
                "id": id.clone(),
                "name": id,
                "vendor": p.name,
                "url": full_url,
                "apiKey": p.api_key,
                "maxInputTokens": recommend_context_window(id.trim()),
                "maxOutputTokens": recommend_max_output_tokens(id.trim()),
                "supportsToolCall": p.capabilities.tools || caps.tools,
                "supportsImages": p.capabilities.vision || caps.vision,
                "supportsReasoning": codebuddy_supports_reasoning(id.trim()),
                "enabled": true,
            })
        })
        .collect()
}


/// 预览：将写入的 providers 片段（apiKey 脱敏）+ 默认模型。
pub(in crate::commands::platforms) fn pi_preview_value(entries: &[Value]) -> Result<Value, String> {
    let (providers, default_pair) = pi_build_providers_map(entries, &Map::new(), true)?;
    let (default_provider, default_model) = match default_pair {
        Some((p, m)) => (Value::String(p), Value::String(m)),
        None => (Value::Null, Value::Null),
    };
    Ok(serde_json::json!({
        "defaultProvider": default_provider,
        "defaultModel": default_model,
        "providers": Value::Object(providers),
    }))
}


/// 把状态快照合并进表格数据：
/// 客户端配置解析出的条目为基底，缺失的字段用快照补齐（客户端格式承载不了的字段），
/// 快照里独有的条目即停用条目，原样追加。
pub(in crate::commands::platforms) fn merge_managed_state(models: &mut Vec<Value>, dir: &Path) -> Result<(), String> {
    let saved = managed_read_state(dir)?;
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    for entry in &saved {
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            by_id.insert(id.to_string(), entry);
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    for entry in models.iter_mut() {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        seen.insert(id.clone());
        let Some(saved_entry) = by_id.get(&id) else {
            continue;
        };
        let Some(saved_obj) = saved_entry.as_object() else {
            continue;
        };
        if let Some(obj) = entry.as_object_mut() {
            for (key, value) in saved_obj {
                // 客户端配置已有的键以配置为准，只补齐配置里不存在的字段
                if !obj.contains_key(key) {
                    obj.insert(key.clone(), value.clone());
                }
            }
        }
    }

    for entry in &saved {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() || seen.contains(&id) {
            continue;
        }
        seen.insert(id);
        models.push(entry.clone());
    }
    Ok(())
}


/// 更新 Pi settings.json 的默认模型（只改这两个键，其余配置原样保留）。
pub(in crate::commands::platforms) fn pi_update_settings_default(
    dir: &Path,
    provider_id: &str,
    model_id: &str,
) -> Result<(), String> {
    let path = dir.join("settings.json");
    ensure_backup(&path)?;
    let raw = if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!("读取 Pi settings.json 失败: {e}"))?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "settings.json")?;
    obj.insert(
        "defaultProvider".to_string(),
        Value::String(provider_id.to_string()),
    );
    obj.insert("defaultModel".to_string(), Value::String(model_id.to_string()));
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, format!("{json}\n").as_bytes())
}


/// 全部停用/清空后，清掉指向受管 provider 的默认模型（避免 Pi 启动即报错）。
pub(in crate::commands::platforms) fn pi_clear_settings_default(dir: &Path) -> Result<(), String> {
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取 Pi settings.json 失败: {e}"))?;
    let mut obj = parse_json_object(&raw, "settings.json")?;
    let Some(prov_id) = obj.get("defaultProvider").and_then(Value::as_str) else {
        return Ok(());
    };
    if !pi_is_managed_provider_id(dir, prov_id) {
        return Ok(());
    }
    ensure_backup(&path)?;
    obj.remove("defaultProvider");
    obj.remove("defaultModel");
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, format!("{json}\n").as_bytes())
}


/// 写入 Pi models.json：全量替换受管 provider（按供应商聚合），
/// 停用条目移入状态文件（Pi 侧不再出现），首条启用条目设为默认模型。
pub(in crate::commands::platforms) fn write_pi_managed_models(models_path: &PathBuf, entries: &[Value]) -> Result<(), String> {
    write_pi_managed_models_with_stash(models_path, entries, &agent_stash_dir())
}


/// 记账可注入版。受管字段：
/// - models.json 的 `providers.<id>`（全部受管条目，对象级 Json）
/// - settings.json 的 `defaultProvider` / `defaultModel`（标量）
pub(in crate::commands::platforms) fn write_pi_managed_models_with_stash(
    models_path: &PathBuf,
    entries: &[Value],
    stash_dir: &Path,
) -> Result<(), String> {
    ensure_parent_dir(models_path)?;
    ensure_backup(models_path)?;

    let raw = if models_path.exists() {
        fs::read_to_string(models_path).map_err(|e| format!("读取 Pi models.json 失败: {e}"))?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "models.json")?;

    let mut unmanaged = obj
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    unmanaged.retain(|key, val| !pi_is_managed_provider(key, val));

    let (managed_providers, default_pair) = pi_build_providers_map(entries, &unmanaged, false)?;

    // 记账：将被替换/删除的全部受管条目 + 本次写入条目（original 幂等）
    {
        let mut existing_managed: Vec<String> = obj
            .get("providers")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter(|(k, v)| pi_is_managed_provider(k, v))
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();
        existing_managed.sort();

        let mut plans: Vec<crate::commands::agent_stash::FieldPlan> = Vec::new();
        for id in &existing_managed {
            let current = obj
                .get("providers")
                .and_then(|p| p.get(id))
                .cloned()
                .and_then(|v| crate::commands::agent_stash::Stashed::from_json_any(&v))
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
            let applied = match managed_providers.get(id) {
                Some(v) => crate::commands::agent_stash::Stashed::Json(v.to_string()),
                None => crate::commands::agent_stash::Stashed::Absent, // 本次被替换集合剔除
            };
            plans.push(crate::commands::agent_stash::FieldPlan {
                path: vec!["providers".into(), id.clone()],
                current,
                new: applied,
            });
        }
        // 本次新增的条目（existing 里没有的）
        for (k, v) in &managed_providers {
            if existing_managed.contains(k) {
                continue;
            }
            plans.push(crate::commands::agent_stash::FieldPlan {
                path: vec!["providers".into(), k.clone()],
                current: crate::commands::agent_stash::Stashed::Absent,
                new: crate::commands::agent_stash::Stashed::Json(v.to_string()),
            });
        }
        if let Err(e) = crate::commands::agent_stash::record_apply(stash_dir, &pi_stash_key("models.json"), &plans)
        {
            eprintln!("[agent-stash] Pi models.json 记账失败（不影响切换）: {e}");
        }

        // settings 默认模型指针记账（defaultProvider / defaultModel）
        let settings_path = models_path.parent().map(|d| d.join("settings.json"));
        let (cur_provider, cur_model) = settings_path
            .as_deref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|raw| parse_json_object(&raw, "settings.json").ok())
            .map(|o| {
                (
                    o.get("defaultProvider").and_then(Value::as_str).map(String::from),
                    o.get("defaultModel").and_then(Value::as_str).map(String::from),
                )
            })
            .unwrap_or((None, None));
        if let Some((np, nm)) = &default_pair {
            let sp = vec![
                crate::commands::agent_stash::FieldPlan {
                    path: vec!["defaultProvider".into()],
                    current: cur_provider
                        .map(crate::commands::agent_stash::Stashed::Str)
                        .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
                    new: crate::commands::agent_stash::Stashed::Str(np.clone()),
                },
                crate::commands::agent_stash::FieldPlan {
                    path: vec!["defaultModel".into()],
                    current: cur_model
                        .map(crate::commands::agent_stash::Stashed::Str)
                        .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
                    new: crate::commands::agent_stash::Stashed::Str(nm.clone()),
                },
            ];
            if let Err(e) =
                crate::commands::agent_stash::record_apply(stash_dir, &pi_stash_key("settings.json"), &sp)
            {
                eprintln!("[agent-stash] Pi settings.json 记账失败（不影响切换）: {e}");
            }
        }
    }

    let mut final_providers = unmanaged;
    for (k, v) in managed_providers {
        final_providers.insert(k, v);
    }

    obj.insert("providers".to_string(), Value::Object(final_providers));
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(models_path, format!("{json}\n").as_bytes())?;

    let dir = models_path
        .parent()
        .ok_or_else(|| "Pi 配置路径无父目录".to_string())?;
    // 完整快照：还原停用条目，并补齐客户端配置承载不了的字段
    managed_write_state(dir, entries)?;

    if let Some((provider_id, model_id)) = default_pair {
        pi_update_settings_default(dir, &provider_id, &model_id)?;
    } else {
        // 全部停用/清空时，之前写入的默认模型会指向已删除的 provider，必须清掉
        pi_clear_settings_default(dir)?;
    }
    Ok(())
}


pub(in crate::commands::platforms) fn pi_stash_key(file: &'static str) -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "pi",
        file,
    }
}

impl Platform {

    /// Pi：把供应商的模型写成 models.json 里的 `anybridge-<模型 id>` provider，
    /// 并把首条模型设为 Pi 默认模型（settings.json）。
    pub(in crate::commands::platforms) fn apply_pi(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let entries = pi_entries_from_provider(p);
        write_pi_managed_models(path, &entries)
    }

}
