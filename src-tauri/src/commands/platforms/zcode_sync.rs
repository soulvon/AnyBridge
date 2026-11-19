use crate::commands::config::Provider;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::common::{ensure_backup, ensure_parent_dir, parse_json_object};
use super::model_context::recommend_context_window;
use super::zcode::{
    zcode_base_url_from_provider, zcode_model_id, zcode_normalize_base_url,
    zcode_provider_id_from_model, ZCODE_PROVIDER_ID,
};


pub(in crate::commands::platforms) fn zcode_personal_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    Ok(home.join(".zcode").join("v2").join("provider_config.json"))
}


/// provider_config.json 里属于 AnyBridge 托管的 providerId 判定。
pub(in crate::commands::platforms) fn zcode_personal_is_managed_id(provider_id: &str) -> bool {
    provider_id == ZCODE_PROVIDER_ID
        || provider_id.starts_with("AnyBridge-")
        || provider_id.starts_with("anybridge")
        || provider_id.starts_with("ide-byok")
}


pub(in crate::commands::platforms) fn zcode_obj_mut<'a>(
    value: &'a mut Value,
    err: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    value.as_object_mut().ok_or_else(|| err.to_string())
}


pub(in crate::commands::platforms) fn zcode_arr_mut<'a>(value: &'a mut Value, err: &str) -> Result<&'a mut Vec<Value>, String> {
    value.as_array_mut().ok_or_else(|| err.to_string())
}


/// 从 Provider 构造同步 provider_config.json 所需的模型列表
/// （与 apply_zcode 写 config.json 的口径一致：仅默认模型）。
pub(in crate::commands::platforms) fn zcode_sync_models_from_provider(p: &Provider) -> Vec<Value> {
    let model_id = zcode_model_id(p);
    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();
    let supports_images = p.capabilities.vision || caps.vision;
    let vendor = if p.name.trim().is_empty() {
        "AnyBridge"
    } else {
        p.name.trim()
    };
    vec![serde_json::json!({
        "id": model_id,
        "name": vendor,
        "vendor": vendor,
        "url": zcode_base_url_from_provider(p),
        "apiKey": p.api_key,
        "supportsImages": supports_images,
        "maxInputTokens": recommend_context_window(&model_id),
    })]
}


/// ZCode v0.21+ 运行时只读个人配置 `~/.zcode/v2/provider_config.json`；
/// `config.json` 仅为首次启动的 legacy 导入源，且导入只迁移 contextWindow、
/// 会丢弃 modalities（图片支持）等能力字段，导致模型在 ZCode 内默认
/// `inputFormat.supportsImage=false`（图片理解被禁用）。
///
/// 这里把 AnyBridge 管理的供应商与模型能力同步进该文件：
///   - providerRules：按 `AnyBridge-{hash(vendor|baseURL)}` upsert，保留 enabled 等未知字段；
///   - providerModelRules：为每个模型写入 contextWindow / inputFormat.supportsImage /
///     maxOutputTokens.max，并保留用户在 ZCode 内手动勾选的 supportsVideo /
///     supportsPdf / supportsNativeWebSearch 等字段；
///   - 清理已删除模型的残留托管规则，其余供应商原样保留。
///
/// ZCode 对该文件有约 1s 的轮询监听，外部修改会被自动加载；legacy 导入
/// 只在文件不存在时触发，不会覆盖我们的同步结果。
pub(in crate::commands::platforms) fn sync_zcode_personal_config(models: &[Value]) -> Result<(), String> {
    let path = zcode_personal_config_path()?;
    sync_zcode_personal_config_at(&path, models)
}


pub(in crate::commands::platforms) fn sync_zcode_personal_config_at(path: &Path, models: &[Value]) -> Result<(), String> {
    let path_buf = path.to_path_buf();
    ensure_parent_dir(&path_buf)?;
    ensure_backup(&path_buf)?;

    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| format!("读取 provider_config.json 失败: {e}"))?
    } else {
        String::new()
    };
    let mut root: Map<String, Value> = if raw.trim().is_empty() {
        serde_json::json!({
            "schemaVersion": 1,
            "config": {
                "providerConfigRules": {
                    "providerRules": []
                },
                "modelConfigRules": {
                    "providerModelRules": [],
                    "manualProviderModelRules": []
                }
            }
        })
        .as_object()
        .cloned()
        .expect("静态 JSON 字面量必为对象")
    } else {
        parse_json_object(&raw, "provider_config.json")?
    };

    let config = zcode_obj_mut(
        root.entry("config")
            .or_insert_with(|| Value::Object(Map::new())),
        "provider_config.json 的 config 字段不是对象",
    )?;

    // ── 按 vendor|baseURL 分组，providerId 与 config.json 的 provider 键一致 ──
    let mut groups: BTreeMap<String, (String, String, String, Vec<(String, &Value)>)> =
        BTreeMap::new();
    for model in models {
        let model_id = model
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if model_id.is_empty() {
            continue;
        }
        let provider_id = zcode_provider_id_from_model(model, 0);
        let vendor = model
            .get("vendor")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Custom")
            .to_string();
        let base_url =
            zcode_normalize_base_url(model.get("url").and_then(Value::as_str).unwrap_or_default());
        let api_key = model
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        groups
            .entry(provider_id)
            .or_insert_with(|| (vendor, base_url, api_key, Vec::new()))
            .3
            .push((model_id, model));
    }

    let current_provider_ids: HashSet<String> = groups.keys().cloned().collect();
    let mut current_pairs: HashSet<(String, String)> = HashSet::new();
    for (provider_id, (_, _, _, group_models)) in &groups {
        for (model_id, _) in group_models {
            current_pairs.insert((provider_id.clone(), model_id.clone()));
        }
    }

    // ── providerRules：移除失效托管规则，再 upsert 当前规则 ──
    let provider_rules_cfg = zcode_obj_mut(
        config
            .entry("providerConfigRules")
            .or_insert_with(|| Value::Object(Map::new())),
        "provider_config.json 的 providerConfigRules 字段不是对象",
    )?;
    let provider_rules = zcode_arr_mut(
        provider_rules_cfg
            .entry("providerRules")
            .or_insert_with(|| Value::Array(Vec::new())),
        "provider_config.json 的 providerRules 字段不是数组",
    )?;
    provider_rules.retain(|rule| {
        let id = rule
            .get("providerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        !(zcode_personal_is_managed_id(id) && !current_provider_ids.contains(id))
    });
    for (provider_id, (vendor, base_url, api_key, group_models)) in &groups {
        let model_ids: Vec<String> = group_models.iter().map(|(id, _)| id.clone()).collect();
        let existing = provider_rules
            .iter()
            .position(|rule| rule.get("providerId").and_then(Value::as_str) == Some(provider_id));
        let rule = match existing {
            Some(index) => &mut provider_rules[index],
            None => {
                provider_rules.push(serde_json::json!({ "providerId": provider_id }));
                provider_rules.last_mut().expect("刚 push 的元素必存在")
            }
        };
        let rule_obj = zcode_obj_mut(rule, "providerRules 条目不是对象")?;
        rule_obj.insert("providerName".to_string(), serde_json::json!(vendor));
        let cfg = zcode_obj_mut(
            rule_obj
                .entry("config")
                .or_insert_with(|| Value::Object(Map::new())),
            "providerRules 条目的 config 不是对象",
        )?;
        cfg.insert(
            "group".to_string(),
            Value::String("standard-personal".to_string()),
        );
        let access = zcode_obj_mut(
            cfg.entry("access")
                .or_insert_with(|| Value::Object(Map::new())),
            "providerRules 的 access 不是对象",
        )?;
        access.insert("type".to_string(), Value::String("api-key".to_string()));
        access.insert("apiKey".to_string(), serde_json::json!(api_key));
        let api = zcode_obj_mut(
            cfg.entry("api")
                .or_insert_with(|| Value::Object(Map::new())),
            "providerRules 的 api 不是对象",
        )?;
        api.insert(
            "type".to_string(),
            Value::String("openai-chat-completions".to_string()),
        );
        api.insert("baseUrl".to_string(), serde_json::json!(base_url));
        cfg.insert("personalModelIds".to_string(), serde_json::json!(model_ids));
        cfg.insert("modelOrder".to_string(), serde_json::json!(model_ids));
    }

    // ── providerModelRules：清理失效规则，再逐模型 upsert 能力字段 ──
    let model_rules_cfg = zcode_obj_mut(
        config
            .entry("modelConfigRules")
            .or_insert_with(|| Value::Object(Map::new())),
        "provider_config.json 的 modelConfigRules 字段不是对象",
    )?;
    let model_rules = zcode_arr_mut(
        model_rules_cfg
            .entry("providerModelRules")
            .or_insert_with(|| Value::Array(Vec::new())),
        "provider_config.json 的 providerModelRules 字段不是数组",
    )?;
    model_rules.retain(|rule| {
        let provider_id = rule
            .get("providerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !zcode_personal_is_managed_id(provider_id) {
            return true;
        }
        let model_id = rule
            .get("modelId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        current_pairs.contains(&(provider_id.to_string(), model_id.to_string()))
    });
    for (provider_id, (_, _, _, group_models)) in &groups {
        for (model_id, model) in group_models {
            let supports_images = model
                .get("supportsImages")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let context_window = model
                .get("maxInputTokens")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| recommend_context_window(model_id));
            let max_output = model.get("maxOutputTokens").and_then(Value::as_u64);

            let existing = model_rules.iter().position(|rule| {
                rule.get("providerId").and_then(Value::as_str) == Some(provider_id)
                    && rule.get("modelId").and_then(Value::as_str) == Some(model_id)
            });
            let rule = match existing {
                Some(index) => &mut model_rules[index],
                None => {
                    model_rules.push(serde_json::json!({
                        "providerId": provider_id,
                        "modelId": model_id,
                        "config": {},
                    }));
                    model_rules.last_mut().expect("刚 push 的元素必存在")
                }
            };
            let rule_obj = zcode_obj_mut(rule, "providerModelRules 条目不是对象")?;
            let cfg = zcode_obj_mut(
                rule_obj
                    .entry("config")
                    .or_insert_with(|| Value::Object(Map::new())),
                "providerModelRules 条目的 config 不是对象",
            )?;
            let props = zcode_obj_mut(
                cfg.entry("properties")
                    .or_insert_with(|| Value::Object(Map::new())),
                "providerModelRules 的 properties 不是对象",
            )?;
            props.insert(
                "contextWindow".to_string(),
                serde_json::json!(context_window),
            );
            // 只管理 supportsImage；保留用户在 ZCode 内手动勾选的 supportsVideo / supportsPdf
            let input_format = zcode_obj_mut(
                props
                    .entry("inputFormat")
                    .or_insert_with(|| Value::Object(Map::new())),
                "providerModelRules 的 inputFormat 不是对象",
            )?;
            input_format.insert(
                "supportsImage".to_string(),
                serde_json::json!(supports_images),
            );

            // 思考档位：AnyBridge 全权管理 optionSpecs.reasoningLevel。
            // values 非空 → 写入（选中值由 ZCode 透传为 reasoning_effort）；空 → 移除恢复内置默认。
            // map 由条目字段 reasoningLevelMap 提供：空 = 移除（回落 ZCode 内置 "{}"，即值透传）。
            let reasoning_levels: Vec<String> = model
                .get("reasoningLevels")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let reasoning_map = model
                .get("reasoningLevelMap")
                .and_then(Value::as_str)
                .map(str::to_string);
            if !reasoning_levels.is_empty() || reasoning_map.is_some() || max_output.is_some() {
                let specs = zcode_obj_mut(
                    cfg.entry("optionSpecs")
                        .or_insert_with(|| Value::Object(Map::new())),
                    "providerModelRules 的 optionSpecs 不是对象",
                )?;
                if let Some(max_output) = max_output {
                    let max_tokens = zcode_obj_mut(
                        specs
                            .entry("maxOutputTokens")
                            .or_insert_with(|| Value::Object(Map::new())),
                        "providerModelRules 的 maxOutputTokens 不是对象",
                    )?;
                    max_tokens.insert("max".to_string(), serde_json::json!(max_output));
                }
                if reasoning_levels.is_empty() {
                    specs.remove("reasoningLevel");
                } else {
                    let level_cfg = zcode_obj_mut(
                        specs
                            .entry("reasoningLevel")
                            .or_insert_with(|| Value::Object(Map::new())),
                        "providerModelRules 的 reasoningLevel 不是对象",
                    )?;
                    level_cfg.insert("values".to_string(), serde_json::json!(reasoning_levels));
                    match reasoning_map.as_deref().map(str::trim) {
                        Some(map) if !map.is_empty() => {
                            level_cfg.insert("map".to_string(), Value::String(map.to_string()));
                        }
                        _ => {
                            level_cfg.remove("map");
                        }
                    }
                }
            }
        }
    }

    let json = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("写入 provider_config.json 失败: {e}"))
}
