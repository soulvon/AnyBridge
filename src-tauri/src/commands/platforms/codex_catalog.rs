use crate::commands::config::{ModelCatalogEntry, Provider};
use serde_json::Value;
use std::collections::HashSet;

use super::codex::{
    codex_home, CODEX_ANYBRIDGE_MANAGED_FLAG, CODEX_LEGACY_ANYBRIDGE_SLUG_PREFIX,
};
use super::model_context::recommend_context_window;


/// 模型目录文件名
pub(crate) const CODEX_MODEL_CATALOG_FILENAME: &str = "anybridge-model-catalog.json";


/// 从 Provider 合成 model_catalog：优先用显式 model_catalog；
/// 为空时回退 models / default_model，避免只配了模型列表却不写 catalog。
pub(crate) fn resolve_codex_model_catalog_entries(p: &Provider) -> Vec<ModelCatalogEntry> {
    if !p.model_catalog.is_empty() {
        return p.model_catalog.clone();
    }
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    let mut push = |model: &str| {
        let m = model.trim();
        if m.is_empty() || !seen.insert(m.to_string()) {
            return;
        }
        entries.push(ModelCatalogEntry {
            model: m.to_string(),
            display_name: None,
            context_window: None,
        });
    };
    for m in &p.models {
        push(m);
    }
    push(&p.default_model);
    entries
}


// ─── Bundled Codex 客户端模型目录（从 cockpit-tools v1.1.4 移植） ──────────
//
// 新版 Codex 客户端（含 GPT-5.6 系列）使用 bundled catalog 提供完整模型定义，
// 不依赖运行时读取 ~/.codex/models_cache.json。旧版客户端仍走 models_cache 逻辑。
pub(in crate::commands::platforms) const CODEX_BUNDLED_CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/codex/codex_client_models.json"
));

pub(in crate::commands::platforms) const CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG: &str = "gpt-5.5";


pub(in crate::commands::platforms) fn codex_bundled_catalog() -> &'static Value {
    static CATALOG: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(CODEX_BUNDLED_CATALOG_JSON)
            .expect("Bundled codex_client_models.json should be valid")
    })
}


/// 从 bundled catalog 提取 model_overrides 中的所有模型 slug（新版模型列表）。
pub(in crate::commands::platforms) fn codex_bundled_model_ids() -> &'static HashSet<String> {
    static IDS: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    IDS.get_or_init(|| {
        codex_bundled_catalog()
            .get("model_overrides")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|m| m.get("slug").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default()
    })
}


/// 判断一个模型 slug 是否在 bundled catalog 的 model_overrides 中（即"新版"模型）。
pub(crate) fn is_codex_bundled_model(slug: &str) -> bool {
    codex_bundled_model_ids()
        .iter()
        .any(|id| id.eq_ignore_ascii_case(slug))
}


/// 从 bundled catalog 查找模型模板。
///
/// 1. 先在 `models` 数组中精确匹配 slug（如 gpt-5.5, gpt-5.4 等已有完整定义的模型）
/// 2. 若未找到，用 gpt-5.5 作为基础模板，再从 `model_overrides` 中查找并合并覆盖字段
///    （如 gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna 等新模型）
/// 3. 若 model_overrides 中也没有，返回 gpt-5.5 模板（is_catalog_model = false）
///
/// 返回 (模型 JSON, 是否为 catalog 中已存在的完整模型定义)。
pub(crate) fn codex_bundled_model_template(model_id: &str) -> (Value, bool) {
    let payload = codex_bundled_catalog();
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .expect("Bundled catalog should include models array");

    // 1. 精确匹配
    if let Some(model) = models.iter().find(|m| {
        m.get("slug")
            .and_then(Value::as_str)
            .is_some_and(|slug| slug.eq_ignore_ascii_case(model_id))
    }) {
        return (model.clone(), true);
    }

    // 2. 用 gpt-5.5 做基础模板，合并 model_overrides
    let default_model = models
        .iter()
        .find(|m| {
            m.get("slug").and_then(Value::as_str) == Some(CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG)
        })
        .cloned()
        .expect("Bundled catalog should include gpt-5.5 template");

    if let Some(model_override) = payload
        .get("model_overrides")
        .and_then(Value::as_array)
        .and_then(|overrides| {
            overrides.iter().find(|m| {
                m.get("slug")
                    .and_then(Value::as_str)
                    .is_some_and(|slug| slug.eq_ignore_ascii_case(model_id))
            })
        })
    {
        let mut model = default_model;
        if let (Some(target), Some(override_obj)) =
            (model.as_object_mut(), model_override.as_object())
        {
            for (key, value) in override_obj {
                target.insert(key.clone(), value.clone());
            }
        }
        return (model, true);
    }

    // 3. 未知模型，返回 gpt-5.5 模板
    (default_model, false)
}


/// 读取 Codex 模型 deep-clone 模板。
///
/// Codex CLI 对模型目录做严格 schema 校验（30+ 字段：base_instructions、
/// model_messages、supports_reasoning_summaries、comp_hash、input_modalities…），
/// 任何缺字段都会导致 `codex exec` 启动时报 "missing field `xxx`"。
///
/// 优先级：
/// 1. `~/.codex/models_cache.json` 中的官方条目（Codex 首次运行后生成，字段最新）
/// 2. 编译期内嵌 `codex_client_models.json` 的 gpt-5.5 完整定义
///    —— 覆盖新机器尚未启动过 Codex、缓存文件不存在的场景。
pub(crate) fn read_codex_model_template() -> Option<serde_json::Value> {
    if let Some(path) = codex_home().map(|d| d.join("models_cache.json")) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(models) = parsed.get("models").and_then(Value::as_array) {
                    let catalog_slugs = read_codex_catalog_slugs_for_template();
                    let found = models
                        .iter()
                        .find(|m| {
                            is_codex_official_template_candidate(m, &catalog_slugs, true, true)
                        })
                        .or_else(|| {
                            models.iter().find(|m| {
                                is_codex_official_template_candidate(m, &catalog_slugs, true, false)
                            })
                        })
                        .or_else(|| {
                            models.iter().find(|m| {
                                is_codex_official_template_candidate(m, &catalog_slugs, false, true)
                            })
                        })
                        .or_else(|| {
                            models.iter().find(|m| {
                                is_codex_official_template_candidate(
                                    m,
                                    &catalog_slugs,
                                    false,
                                    false,
                                )
                            })
                        })
                        .cloned();
                    if found.is_some() {
                        return found;
                    }
                }
            }
        }
    }

    // 新机 / 缓存缺失 / 仅有 AnyBridge 注入项：回退到内嵌 gpt-5.5 完整模板
    let (template, _) = codex_bundled_model_template(CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG);
    Some(template)
}


pub(in crate::commands::platforms) fn read_codex_catalog_slugs_for_template() -> HashSet<String> {
    let Some(dir) = codex_home() else {
        return HashSet::new();
    };
    let path = dir.join(CODEX_MODEL_CATALOG_FILENAME);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return HashSet::new();
    };
    let arr = if parsed.is_array() {
        parsed.as_array()
    } else {
        parsed.get("models").and_then(|m| m.as_array())
    };
    arr.map(|items| {
        items
            .iter()
            .filter_map(|m| {
                m.get("slug")
                    .and_then(Value::as_str)
                    .or_else(|| m.get("model").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
            })
            .collect()
    })
    .unwrap_or_default()
}


pub(in crate::commands::platforms) fn is_codex_official_template_candidate(
    model: &serde_json::Value,
    catalog_slugs: &HashSet<String>,
    prefer_openai_slug: bool,
    skip_catalog_slug: bool,
) -> bool {
    if model
        .get(CODEX_ANYBRIDGE_MANAGED_FLAG)
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    // 旧版 Codex 写入的 models_cache 条目没有 base_instructions。Codex 0.146+ 对
    // model catalog 做严格 schema 校验，拿这类条目当模板 deep-clone 会产出
    // `missing field base_instructions` 的 catalog，直接排除。
    if !has_base_instructions(model) {
        return false;
    }
    let slug = model
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if slug.is_empty() || slug.starts_with(CODEX_LEGACY_ANYBRIDGE_SLUG_PREFIX) {
        return false;
    }
    if skip_catalog_slug && catalog_slugs.contains(slug) {
        return false;
    }
    !prefer_openai_slug || slug.starts_with("gpt-")
}


/// 模型条目是否带 Codex 严格 schema 要求的 `base_instructions`（非空字符串）。
pub(crate) fn has_base_instructions(model: &Value) -> bool {
    model
        .get("base_instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|s| !s.is_empty())
}


/// catalog 条目是否覆盖 bundled 模板的全部字段（Codex 严格 schema 校验用）。
///
/// `base_instructions` 额外要求非空字符串；其余字段只要求键存在。这样 Codex
/// 后续版本再新增必填字段时，只要 bundled 模板同步更新，旧 catalog 会自动判定
/// 为过期并重建，而不是继续沿用。
pub(crate) fn catalog_entry_has_required_fields(model: &Value) -> bool {
    if !has_base_instructions(model) {
        return false;
    }
    let Some(obj) = model.as_object() else {
        return false;
    };
    let (template, _) = codex_bundled_model_template(CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG);
    let Some(template_obj) = template.as_object() else {
        return true;
    };
    template_obj.keys().all(|key| obj.contains_key(key))
}


/// 用 bundled gpt-5.5 的完整定义补齐模型条目缺失的字段（不覆盖已有值）。
///
/// Codex 0.146+ 把 `base_instructions` 等字段列为必填，而旧版 `models_cache.json`
/// 模板没有这些字段。deep-clone 旧模板会产出让 `codex` 启动即报
/// `missing field` 的 catalog，因此所有生成路径统一在这里兜底。
pub(in crate::commands::platforms) fn backfill_model_fields_from_bundled(model: &mut Value) {
    let (template, _) = codex_bundled_model_template(CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG);
    let (Some(template_obj), Some(obj)) = (template.as_object(), model.as_object_mut()) else {
        return;
    };
    for (key, value) in template_obj {
        // 键缺失或为 null 都视为缺失：旧版 models_cache 里出现过
        // `"base_instructions": null` 这类占位写法。
        let needs_fill = matches!(obj.get(key), None | Some(Value::Null));
        if needs_fill {
            obj.insert(key.clone(), value.clone());
        }
    }
}


/// 生成 Codex 模型目录 JSON 内容。
///
/// **新版逻辑（cockpit-tools v1.1.4 移植）**：如果模型 slug 在 bundled catalog 的
/// `model_overrides` 中（如 gpt-5.6-sol/terra/luna），直接使用 bundled catalog 的完整
/// 模型定义（含 supported_reasoning_levels、service_tiers、multi_agent_version 等），
/// 不依赖运行时 `~/.codex/models_cache.json`。
///
/// **旧版逻辑（保持兼容）**：如果模型 slug 不在 bundled catalog 中（用户自定义模型或
/// 旧版 Codex 模型），优先从 `~/.codex/models_cache.json` 读取官方条目作为模板；
/// 缓存不存在时回退到内嵌 gpt-5.5，deep-clone 后只覆盖 6 个字段：slug, display_name,
/// description, context_window, max_context_window, priority。其余 26+ 字段从模板继承。
pub(crate) fn generate_model_catalog_json(entries: &[ModelCatalogEntry]) -> Result<String, String> {
    // 旧版模板：仅在存在非 bundled 模型时才需要模板（缓存优先，bundled 兜底）
    let has_legacy_models = entries.iter().any(|e| !is_codex_bundled_model(&e.model));
    let legacy_template: Option<serde_json::Value> = if has_legacy_models {
        Some(read_codex_model_template().ok_or_else(|| {
            "无法解析 Codex 模型模板（models_cache 与内嵌 gpt-5.5 均不可用）".to_string()
        })?)
    } else {
        None
    };

    let models: Vec<serde_json::Value> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let mut entry_model = if is_codex_bundled_model(&e.model) {
                // ── 新版逻辑：使用 bundled catalog 完整定义 ──
                let (mut model, _) = codex_bundled_model_template(&e.model);
                let obj = model
                    .as_object_mut()
                    .expect("Bundled model template should be a JSON object");

                obj["priority"] = serde_json::json!(1000 + i);

                if let Some(dn) = &e.display_name {
                    if !dn.is_empty() {
                        obj["display_name"] = serde_json::json!(dn);
                    }
                }
                if let Some(ctx) = e.context_window {
                    obj["context_window"] = serde_json::json!(ctx);
                    obj["max_context_window"] = serde_json::json!(ctx);
                }

                obj.insert("supported_in_api".to_string(), Value::Bool(true));
                if !obj.contains_key("visibility") {
                    obj.insert("visibility".to_string(), Value::String("list".to_string()));
                }

                model
            } else {
                // ── 旧版逻辑：从 models_cache.json 模板 deep-clone ──
                let mut obj = legacy_template
                    .clone()
                    .expect("legacy_template verified above for non-bundled models");
                let display_name = e.display_name.as_deref().unwrap_or(e.model.as_str());
                let ctx = e
                    .context_window
                    .unwrap_or_else(|| recommend_context_window(&e.model));
                obj["slug"] = serde_json::json!(e.model);
                obj["display_name"] = serde_json::json!(display_name);
                obj["description"] = serde_json::json!(display_name);
                obj["context_window"] = serde_json::json!(ctx);
                obj["max_context_window"] = serde_json::json!(ctx);
                obj["priority"] = serde_json::json!(1000 + i);
                // 白名单要求（spec CC-Switch 调研 4.11，2026-06-26 验证）：
                // 每个条目必须 visibility="list" + supported_in_api=true，否则模型不显示/不可调用。
                // 模板克隆来的 visibility 是 "hide"，会被 Codex 的模型白名单过滤掉（显示为"自定义"），必须覆盖。
                obj["visibility"] = serde_json::json!("list");
                obj["supported_in_api"] = serde_json::json!(true);
                obj
            };
            // 旧模板即便被选为模板，也可能缺 Codex 0.146+ 的必填字段，统一补齐。
            backfill_model_fields_from_bundled(&mut entry_model);
            entry_model
        })
        .collect();

    let catalog = serde_json::json!({ "models": models });
    serde_json::to_string_pretty(&catalog).map_err(|e| format!("catalog 序列化失败: {e}"))
}
