use crate::commands::config::Provider;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use super::common::{
    agent_stash_dir, ensure_backup, ensure_parent_dir, openai_base_url, parse_json_object,
    short_hash, strip_first_matching_suffix,
};
use super::model_context::recommend_context_window;
use super::platform_enum::Platform;
use super::zcode_sync::{
    sync_zcode_personal_config, zcode_personal_config_path, zcode_sync_models_from_provider,
};

pub(in crate::commands::platforms) const ZCODE_PROVIDER_ID: &str = "AnyBridge";


pub(in crate::commands::platforms) fn zcode_model_id(p: &Provider) -> String {
    let model = p.default_model.trim();
    if model.is_empty() {
        "model".to_string()
    } else {
        model.to_string()
    }
}


pub(in crate::commands::platforms) fn zcode_provider_entry(p: &Provider, api_key: &str) -> Value {
    let model_id = zcode_model_id(p);
    let provider_name = if p.name.trim().is_empty() {
        "AnyBridge"
    } else {
        p.name.trim()
    };
    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();
    let supports_images = p.capabilities.vision || caps.vision;
    let input_modalities = if supports_images {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };
    let context = recommend_context_window(&model_id);

    let mut model_meta = Map::new();
    model_meta.insert(
        "limit".to_string(),
        serde_json::json!({
            "context": context,
        }),
    );
    model_meta.insert(
        "modalities".to_string(),
        serde_json::json!({
            "input": input_modalities,
            "output": ["text"],
        }),
    );

    let mut models = Map::new();
    models.insert(model_id, Value::Object(model_meta));

    serde_json::json!({
        "name": provider_name,
        "kind": "openai-compatible",
        "options": {
            "apiKey": api_key,
            "baseURL": zcode_base_url_from_provider(p),
            "apiKeyRequired": true,
        },
        "source": "custom",
        "models": Value::Object(models),
    })
}


pub(in crate::commands::platforms) fn zcode_preview(p: &Provider, api_key: &str) -> Value {
    let mut provider_map = Map::new();
    provider_map.insert(
        ZCODE_PROVIDER_ID.to_string(),
        zcode_provider_entry(p, api_key),
    );

    serde_json::json!({
        "v2/config.json": {
            "provider": Value::Object(provider_map.clone()),
        },
        "cli/config.json": {
            "provider": Value::Object(provider_map),
        },
    })
}


pub(in crate::commands::platforms) fn zcode_stash_key(file: &'static str) -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "zcode",
        file,
    }
}


/// ZCode 接入（带记账）：受管字段 = 将被 retain 删除的全部托管 provider
/// 条目（对象级，`provider.<id>`）+ 本次写入的 `provider.AnyBridge`。
/// `stash_key`：主配置与 cli 配置的文件名不同，账本键由调用方区分。
pub(in crate::commands::platforms) fn apply_zcode_config_file_with_stash(
    path: &PathBuf,
    p: &Provider,
    stash_key: &crate::commands::agent_stash::StashKey,
    stash_dir: &Path,
) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "config.json")?;

    obj.entry("$schema")
        .or_insert_with(|| Value::String("https://zcode.z.ai/config.json".to_string()));

    let provider_value = obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()));
    let provider_obj = provider_value
        .as_object_mut()
        .ok_or_else(|| "config.json 的 provider 字段不是对象".to_string())?;

    // 记账：所有将被 retain 删除的托管条目 + 本次写入条目（original 幂等）
    let mut plans = Vec::new();
    let managed_ids: Vec<String> = provider_obj
        .iter()
        .filter(|(id, entry)| zcode_is_managed_provider(id, entry))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &managed_ids {
        let current = provider_obj
            .get(id)
            .cloned()
            .and_then(|v| crate::commands::agent_stash::Stashed::from_json_any(&v))
            .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
        plans.push(crate::commands::agent_stash::FieldPlan {
            path: vec!["provider".into(), id.clone()],
            current,
            new: if *id == ZCODE_PROVIDER_ID {
                crate::commands::agent_stash::Stashed::Json(zcode_provider_entry(p, &p.api_key).to_string())
            } else {
                // 历史变体条目：本次会被删除
                crate::commands::agent_stash::Stashed::Absent
            },
        });
    }
    if !managed_ids.contains(&ZCODE_PROVIDER_ID.to_string()) {
        plans.push(crate::commands::agent_stash::FieldPlan {
            path: vec!["provider".into(), ZCODE_PROVIDER_ID.to_string()],
            current: crate::commands::agent_stash::Stashed::Absent,
            new: crate::commands::agent_stash::Stashed::Json(zcode_provider_entry(p, &p.api_key).to_string()),
        });
    }
    if let Err(e) = crate::commands::agent_stash::record_apply(stash_dir, stash_key, &plans) {
        eprintln!("[agent-stash] ZCode 记账失败（不影响切换）: {e}");
    }

    // 门控：保形写入
    if crate::commands::jsonc_edit::format_preserving_enabled() {
        let mut text = raw.clone();
        let schema_missing = obj.get("$schema").is_none();
        if schema_missing {
            text = crate::commands::jsonc_edit::set_key(
                &text,
                &["$schema"],
                &crate::commands::jsonc_edit::JsoncValue::Str("https://zcode.z.ai/config.json".into()),
            )?;
        }
        for id in &managed_ids {
            text = crate::commands::jsonc_edit::remove_key(&text, &["provider", id.as_str()])?;
        }
        text = crate::commands::jsonc_edit::set_key(
            &text,
            &["provider", ZCODE_PROVIDER_ID],
            &crate::commands::jsonc_edit::JsoncValue::Raw(zcode_provider_entry(p, &p.api_key).to_string()),
        )?;
        return crate::commands::write_atomic(path, text.as_bytes());
    }

    provider_obj.retain(|provider_id, provider| !zcode_is_managed_provider(provider_id, provider));
    provider_obj.insert(
        ZCODE_PROVIDER_ID.to_string(),
        zcode_provider_entry(p, &p.api_key),
    );

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
}


pub(in crate::commands::platforms) fn zcode_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    Ok(home.join(".zcode").join("v2").join("config.json"))
}


pub(in crate::commands::platforms) fn zcode_cli_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    Ok(home.join(".zcode").join("cli").join("config.json"))
}


/// 读取 provider_config.json 的个人模型规则，提取 (providerId, modelId) → (档位 values, map)。
/// 用于 load 回读：让 AnyBridge 编辑框能回显用户在 ZCode 内或上次同步配置的思考档位。
pub(in crate::commands::platforms) fn zcode_personal_reasoning_lookup() -> HashMap<(String, String), (Vec<String>, Option<String>)> {
    let mut lookup = HashMap::new();
    let Ok(path) = zcode_personal_config_path() else {
        return lookup;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return lookup;
    };
    let Ok(value) = json5::from_str::<Value>(&raw) else {
        return lookup;
    };
    let Some(rules) = value
        .get("config")
        .and_then(|c| c.get("modelConfigRules"))
        .and_then(|m| m.get("providerModelRules"))
        .and_then(Value::as_array)
    else {
        return lookup;
    };
    for rule in rules {
        let Some(provider_id) = rule.get("providerId").and_then(Value::as_str) else {
            continue;
        };
        let Some(model_id) = rule.get("modelId").and_then(Value::as_str) else {
            continue;
        };
        let Some(level_cfg) = rule
            .get("config")
            .and_then(|c| c.get("optionSpecs"))
            .and_then(|o| o.get("reasoningLevel"))
        else {
            continue;
        };
        let values: Vec<String> = level_cfg
            .get("values")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if values.is_empty() {
            continue;
        }
        let map = level_cfg
            .get("map")
            .and_then(Value::as_str)
            .map(str::to_string);
        lookup.insert(
            (provider_id.to_string(), model_id.to_string()),
            (values, map),
        );
    }
    lookup
}


pub(in crate::commands::platforms) fn zcode_model_item(
    provider_id: &str,
    provider: &Value,
    model_id: &str,
    model: &Value,
    reasoning_lookup: &HashMap<(String, String), (Vec<String>, Option<String>)>,
) -> Value {
    let provider_name = provider
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Custom");
    let options = provider.get("options").and_then(Value::as_object);
    let base_url = options
        .and_then(|o| o.get("baseURL").or_else(|| o.get("baseUrl")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let api_key = options
        .and_then(|o| o.get("apiKey"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let display_name = model
        .get("name")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{provider_name} · {model_id}"));
    let input_modalities = model
        .get("modalities")
        .and_then(|m| m.get("input"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let supports_images = input_modalities.iter().any(|v| v.as_str() == Some("image"));
    let supports_reasoning = zcode_model_supports_reasoning(model);
    let max_input_tokens = model
        .get("limit")
        .and_then(|m| m.get("context"))
        .and_then(Value::as_u64);
    let max_output_tokens = model
        .get("limit")
        .and_then(|m| m.get("output"))
        .and_then(Value::as_u64);

    let mut item = serde_json::json!({
        "id": model_id,
        "name": display_name,
        "vendor": provider_name,
        "url": zcode_normalize_base_url(base_url),
        "apiKey": api_key,
        "providerId": provider_id,
        "supportsToolCall": false,
        "supportsImages": supports_images,
        "supportsReasoning": supports_reasoning,
    });
    if let Some(obj) = item.as_object_mut() {
        if let Some(value) = max_input_tokens {
            obj.insert("maxInputTokens".to_string(), serde_json::json!(value));
        }
        if let Some(value) = max_output_tokens {
            obj.insert("maxOutputTokens".to_string(), serde_json::json!(value));
        }
        if let Some((values, map)) =
            reasoning_lookup.get(&(provider_id.to_string(), model_id.to_string()))
        {
            obj.insert("reasoningLevels".to_string(), serde_json::json!(values));
            if let Some(map) = map {
                obj.insert("reasoningLevelMap".to_string(), serde_json::json!(map));
            }
        }
    }
    item
}


pub(in crate::commands::platforms) fn load_zcode_models() -> Result<serde_json::Value, String> {
    let path = zcode_config_path()?;
    let fallback = zcode_cli_config_path()?;
    let read_path = if path.exists() {
        path.clone()
    } else {
        fallback
    };
    if !read_path.exists() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": path.to_string_lossy().to_string(),
            "_configScope": "user",
        }));
    }

    let raw = fs::read_to_string(&read_path).map_err(|e| format!("读取失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": read_path.to_string_lossy().to_string(),
            "_configScope": "user",
        }));
    }

    let value: Value = json5::from_str(&raw).map_err(|e| format!("解析失败: {e}"))?;
    let mut models = Vec::new();
    let mut available = Vec::new();
    let reasoning_lookup = zcode_personal_reasoning_lookup();
    if let Some(providers) = value.get("provider").and_then(Value::as_object) {
        for (provider_id, provider) in providers {
            let kind = provider
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if kind != "openai-compatible" {
                continue;
            }
            let source = provider
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if source == "builtin" || provider_id.starts_with("builtin:") {
                continue;
            }
            if let Some(provider_models) = provider.get("models").and_then(Value::as_object) {
                for (model_id, model) in provider_models {
                    available.push(model_id.clone());
                    models.push(zcode_model_item(
                        provider_id,
                        provider,
                        model_id,
                        model,
                        &reasoning_lookup,
                    ));
                }
            }
        }
    }

    Ok(serde_json::json!({
        "models": models,
        "availableModels": available,
        "_configPath": read_path.to_string_lossy().to_string(),
        "_configScope": "user",
    }))
}


pub(in crate::commands::platforms) fn zcode_provider_id_from_model(model: &Value, _index: usize) -> String {
    if let Some(provider_id) = model.get("providerId").and_then(Value::as_str) {
        if !zcode_provider_id_needs_migration(provider_id, model) {
            return provider_id.to_string();
        }
    }
    // 按 vendor + baseURL 分组：同一供应商的所有模型归入同一个 provider。
    // providerId 不能拼接 apiKey，避免把密钥泄漏进配置键名。
    let vendor = model
        .get("vendor")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("custom");
    let url = model.get("url").and_then(Value::as_str).unwrap_or_default();
    let base_url = zcode_normalize_base_url(url);
    let composite = format!("{vendor}|{base_url}");
    format!("AnyBridge-{}", short_hash(&composite))
}


pub(in crate::commands::platforms) fn zcode_model_meta_from_model(model: &Value) -> (String, Value) {
    let model_id = model
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("model")
        .to_string();
    let display_name = model
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&model_id);
    let supports_images = model
        .get("supportsImages")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let supports_reasoning = model
        .get("supportsReasoning")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let input = if supports_images {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };
    let max_input = model
        .get("maxInputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| recommend_context_window(&model_id));
    let mut meta = serde_json::json!({
        "name": display_name,
        "limit": { "context": max_input },
        "modalities": {
            "input": input,
            "output": ["text"],
        },
    });
    if let Some(max_output) = model.get("maxOutputTokens").and_then(Value::as_u64) {
        if let Some(limit) = meta.get_mut("limit").and_then(Value::as_object_mut) {
            limit.insert("output".to_string(), serde_json::json!(max_output));
        }
    }
    if supports_reasoning {
        if let Some(obj) = meta.as_object_mut() {
            obj.insert(
                "reasoning".to_string(),
                serde_json::json!({
                    "enabled": true,
                    "variants": ["enabled", "off"],
                    "defaultVariant": "enabled",
                }),
            );
        }
    }
    (model_id, meta)
}


pub(in crate::commands::platforms) fn write_zcode_models_to_path(path: &PathBuf, models: &[Value]) -> Result<(), String> {
    ensure_parent_dir(path)?;
    ensure_backup(path)?;
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "config.json")?;
    obj.entry("$schema")
        .or_insert_with(|| Value::String("https://zcode.z.ai/config.json".to_string()));

    let mut provider_obj = obj
        .remove("provider")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    provider_obj.retain(|provider_id, provider| {
        let source = provider
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        (source == "builtin" || provider_id.starts_with("builtin:"))
            && !zcode_is_managed_provider(provider_id, provider)
    });

    let mut groups: BTreeMap<String, (String, String, String, Map<String, Value>)> =
        BTreeMap::new();
    for (index, model) in models.iter().enumerate() {
        let model_id = model.get("id").and_then(Value::as_str).unwrap_or_default();
        if model_id.trim().is_empty() {
            continue;
        }
        let provider_id = zcode_provider_id_from_model(model, index);
        let vendor = model
            .get("vendor")
            .and_then(Value::as_str)
            .unwrap_or("Custom")
            .to_string();
        let url = model
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let base_url = zcode_normalize_base_url(&url);
        let api_key = model
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let (model_id, meta) = zcode_model_meta_from_model(model);
        groups
            .entry(provider_id)
            .or_insert_with(|| (vendor, base_url, api_key, Map::new()))
            .3
            .insert(model_id, meta);
    }

    for (provider_id, (vendor, url, api_key, model_map)) in groups {
        provider_obj.insert(
            provider_id,
            serde_json::json!({
                "name": vendor,
                "kind": "openai-compatible",
                "options": {
                    "apiKey": api_key,
                    "baseURL": url,
                    "apiKeyRequired": true,
                },
                "source": "custom",
                "models": Value::Object(model_map),
            }),
        );
    }

    obj.insert("provider".to_string(), Value::Object(provider_obj));
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes()).map_err(|e| format!("写入失败: {e}"))
}


pub(in crate::commands::platforms) fn zcode_normalize_base_url(value: &str) -> String {
    strip_first_matching_suffix(
        value.trim().trim_end_matches('/'),
        &["/chat/completions", "/responses"],
    )
    .trim_end_matches('/')
    .to_string()
}


pub(in crate::commands::platforms) fn zcode_base_url_from_provider(p: &Provider) -> String {
    zcode_normalize_base_url(&openai_base_url(p))
}


pub(in crate::commands::platforms) fn zcode_model_supports_reasoning(model: &Value) -> bool {
    match model.get("reasoning") {
        Some(Value::Bool(value)) => *value,
        Some(Value::Object(obj)) => obj.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        _ => false,
    }
}


pub(in crate::commands::platforms) fn zcode_provider_id_needs_migration(provider_id: &str, model: &Value) -> bool {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return true;
    }
    let api_key = model
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !api_key.is_empty() && provider_id.contains(api_key) {
        return true;
    }
    provider_id == ZCODE_PROVIDER_ID
        || provider_id.contains("://")
        || provider_id.contains('/')
        || provider_id.contains('\\')
}


pub(in crate::commands::platforms) fn zcode_is_managed_provider(provider_id: &str, provider: &Value) -> bool {
    if provider_id.starts_with("builtin:") {
        return false;
    }
    let source = provider
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    source == "anybridge"
        || source == "ide-byok"
        || provider_id == ZCODE_PROVIDER_ID
        || provider_id.starts_with("AnyBridge-")
        || provider_id.starts_with("anybridge")
        || provider_id.starts_with("ide-byok")
}

impl Platform {

    pub(in crate::commands::platforms) fn apply_zcode(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let stash_dir = agent_stash_dir();
        apply_zcode_config_file_with_stash(path, p, &zcode_stash_key("config.json"), &stash_dir)?;

        if let Some(cli_path) = self.zcode_cli_config_path() {
            ensure_parent_dir(&cli_path)?;
            ensure_backup(&cli_path)?;
            // cli 配置是独立文件，账本键按文件名区分（original 幂等按键隔离）
            apply_zcode_config_file_with_stash(
                &cli_path,
                p,
                &zcode_stash_key("cli/config.json"),
                &stash_dir,
            )?;
        }

        sync_zcode_personal_config(&zcode_sync_models_from_provider(p))?;
        Ok(())
    }

}
