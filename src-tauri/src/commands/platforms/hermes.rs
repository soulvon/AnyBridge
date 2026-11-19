use crate::commands::config::Provider;
use serde_json::Value;
use serde_yaml::Value as YamlValue;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::common::{agent_stash_dir, ensure_backup, ensure_parent_dir, mask_key};
use super::pi::{
    pi_endpoint_parts, pi_entries_from_provider, pi_entry_enabled, PI_API_OPENAI_RESPONSES,
};
use super::yaml_block::{
    entry_string, managed_read_state, managed_write_state, parse_yaml_value, yaml_block_for_value,
    yaml_block_text, yaml_remove_scalar_in_block, yaml_scalar, yaml_set_scalar_in_block,
    yaml_set_top_level_block,
};

/// Hermes custom_providers 中由 AnyBridge 写入的条目前缀。
pub(in crate::commands::platforms) const HERMES_PROVIDER_PREFIX: &str = "anybridge";


/// 供应商 → 通用表格条目（Hermes / Harness 与 Pi 共用同一套条目格式）。
pub(in crate::commands::platforms) fn hermes_entries_from_provider(p: &Provider) -> Vec<Value> {
    pi_entries_from_provider(p)
}


// ─── Hermes Agent ───────────────────────────────────────────────
//
// 写法与 Pi 对齐：按供应商分组，每个供应商一个 custom_providers 条目，
// name = 供应商显示名（Hermes 模型选择器直接展示该名称），全部模型收敛进
// models 映射，首条模型作为该条目默认模型，首条启用供应商设为全局默认。
// 受管条目识别：旧格式的 anybridge- 前缀 + 状态快照里记录过的供应商名
// （Hermes 的 custom_providers 是社区格式，不承载 AnyBridge 标记字段）。

pub(in crate::commands::platforms) fn hermes_is_managed_provider(name: &str) -> bool {
    name == HERMES_PROVIDER_PREFIX
        || name.starts_with(&format!("{HERMES_PROVIDER_PREFIX}-"))
}


/// 状态快照里出现过的供应商名（这些名字的 custom_providers 条目都归 AnyBridge 管）。
/// 注意必须在 managed_write_state 覆盖快照之前调用。
pub(in crate::commands::platforms) fn hermes_managed_names_from_state(dir: &Path) -> HashSet<String> {
    managed_read_state(dir)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            entry
                .get("vendor")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| entry.get("name").and_then(Value::as_str).map(str::trim))
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .collect()
}


/// 条目是否属于 AnyBridge 受管（旧 anybridge- 前缀，或供应商名在快照中）。
pub(in crate::commands::platforms) fn hermes_entry_is_managed(name: &str, managed_names: &HashSet<String>) -> bool {
    hermes_is_managed_provider(name) || managed_names.contains(name)
}


#[derive(Clone)]
pub(in crate::commands::platforms) struct HermesGroup {
    /// 供应商显示名，写入 custom_providers.name（Hermes 选择器展示用）
    pub(in crate::commands::platforms) name: String,
    pub(in crate::commands::platforms) base_url: String,
    pub(in crate::commands::platforms) api_mode: &'static str,
    pub(in crate::commands::platforms) api_key: String,
    /// 该供应商下的全部模型 ID（保序去重）
    pub(in crate::commands::platforms) models: Vec<String>,
}


/// 表格条目 → 供应商分组（按 名称+base_url+api_mode+apiKey 聚合，与 Pi 一致）。
pub(in crate::commands::platforms) fn hermes_build_groups(entries: &[Value]) -> Result<Vec<HermesGroup>, String> {
    let mut groups: Vec<HermesGroup> = Vec::new();
    for entry in entries {
        if !pi_entry_enabled(entry) {
            continue;
        }
        let model_id = entry_string(entry, "id");
        if model_id.is_empty() {
            continue;
        }
        let url = entry_string(entry, "url");
        if url.is_empty() {
            return Err(format!("模型 {model_id} 缺少接口地址"));
        }
        let (base_url, api) = pi_endpoint_parts(&url);
        let api_mode = if api == PI_API_OPENAI_RESPONSES {
            "codex_responses"
        } else {
            "chat_completions"
        };
        let api_key = entry_string(entry, "apiKey");
        // 供应商名：vendor 优先，缺失时回落 name（外部导入/旧数据可能只有 name）
        let name = entry
            .get("vendor")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "user" && *s != "custom")
            .or_else(|| {
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != "user" && *s != "custom")
            })
            .unwrap_or("AnyBridge")
            .to_string();
        if let Some(g) = groups.iter_mut().find(|g| {
            g.name == name && g.base_url == base_url && g.api_mode == api_mode && g.api_key == api_key
        }) {
            if !g.models.contains(&model_id) {
                g.models.push(model_id);
            }
        } else {
            groups.push(HermesGroup {
                name,
                base_url,
                api_mode,
                api_key,
                models: vec![model_id],
            });
        }
    }
    Ok(groups)
}


/// 分组 → Hermes custom_providers 条目（apiKey 可打码用于预览）。
pub(in crate::commands::platforms) fn hermes_group_entry(group: &HermesGroup, mask: bool) -> YamlValue {
    let mut provider = serde_yaml::Mapping::new();
    provider.insert(
        YamlValue::String("name".to_string()),
        YamlValue::String(group.name.clone()),
    );
    provider.insert(
        YamlValue::String("base_url".to_string()),
        YamlValue::String(group.base_url.clone()),
    );
    if !group.api_key.is_empty() {
        let key = if mask {
            mask_key(&group.api_key)
        } else {
            group.api_key.clone()
        };
        provider.insert(YamlValue::String("api_key".to_string()), YamlValue::String(key));
    }
    provider.insert(
        YamlValue::String("api_mode".to_string()),
        YamlValue::String(group.api_mode.to_string()),
    );
    // 首条模型作为该供应商的默认模型
    if let Some(first) = group.models.first() {
        provider.insert(
            YamlValue::String("model".to_string()),
            YamlValue::String(first.clone()),
        );
    }
    let mut models = serde_yaml::Mapping::new();
    for model_id in &group.models {
        models.insert(
            YamlValue::String(model_id.clone()),
            YamlValue::Mapping(serde_yaml::Mapping::new()),
        );
    }
    provider.insert(YamlValue::String("models".to_string()), YamlValue::Mapping(models));
    YamlValue::Mapping(provider)
}


/// Hermes config.yaml → 表格条目（只展开受管 provider，每个模型一行）。
pub(in crate::commands::platforms) fn hermes_entries_from_config(root: &YamlValue, managed_names: &HashSet<String>) -> Vec<Value> {
    let Some(providers) = root
        .get("custom_providers")
        .and_then(YamlValue::as_sequence)
    else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for item in providers {
        let Some(name) = item
            .get("name")
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if !hermes_entry_is_managed(name, managed_names) {
            continue;
        }
        // 旧格式（name=anybridge-<模型>）的供应商名记录在 display_name 兜底字段
        let vendor = if hermes_is_managed_provider(name) {
            item.get("display_name")
                .and_then(YamlValue::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(name)
        } else {
            name
        };
        let base_url = item
            .get("base_url")
            .and_then(YamlValue::as_str)
            .unwrap_or("");
        let api_mode = item
            .get("api_mode")
            .and_then(YamlValue::as_str)
            .unwrap_or("chat_completions");
        let url = if api_mode == "codex_responses" {
            format!("{}/responses", base_url.trim_end_matches('/'))
        } else {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        };
        let api_key = item.get("api_key").and_then(YamlValue::as_str).unwrap_or("");
        let mut model_ids: Vec<String> = Vec::new();
        if let Some(models) = item.get("models").and_then(YamlValue::as_mapping) {
            for key in models.keys() {
                if let Some(id) = key.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    model_ids.push(id.to_string());
                }
            }
        }
        if model_ids.is_empty() {
            if let Some(id) = item.get("model").and_then(YamlValue::as_str) {
                model_ids.push(id.to_string());
            }
        }
        for model_id in model_ids {
            entries.push(serde_json::json!({
                "id": model_id,
                "name": vendor,
                "vendor": vendor,
                "url": url,
                "apiKey": api_key,
                // Hermes 的条目格式不承载能力/上限字段，交给状态快照补齐
                // （此处硬编码会以"配置已有键"的名义挡住快照合并）
                "enabled": true,
            }));
        }
    }
    entries
}


pub(in crate::commands::platforms) fn hermes_preview_value(entries: &[Value]) -> Result<YamlValue, String> {
    let groups = hermes_build_groups(entries)?;
    let providers: Vec<YamlValue> = groups.iter().map(|g| hermes_group_entry(g, true)).collect();
    let mut model = serde_yaml::Mapping::new();
    if let Some(first) = groups.first() {
        if let Some(model_id) = first.models.first() {
            model.insert(
                YamlValue::String("default".to_string()),
                YamlValue::String(model_id.clone()),
            );
            model.insert(
                YamlValue::String("provider".to_string()),
                YamlValue::String(first.name.clone()),
            );
            model.insert(
                YamlValue::String("base_url".to_string()),
                YamlValue::String(first.base_url.clone()),
            );
        }
    }
    let mut root = serde_yaml::Mapping::new();
    root.insert(
        YamlValue::String("custom_providers".to_string()),
        YamlValue::Sequence(providers),
    );
    root.insert(YamlValue::String("model".to_string()), YamlValue::Mapping(model));
    Ok(YamlValue::Mapping(root))
}


/// 写入 Hermes：custom_providers 全量替换受管条目（按供应商分组）+ model 段设置默认模型。
pub(in crate::commands::platforms) fn write_hermes_managed_models(path: &PathBuf, entries: &[Value]) -> Result<(), String> {
    write_hermes_managed_models_with_stash(path, entries, &agent_stash_dir())
}


/// 记账可注入版。受管字段（块级账本，Stashed::Str 存规范化块文本）：
/// - `custom_providers` 顶层块
/// - `model.default` / `model.provider` / `model.base_url` 块内标量
pub(in crate::commands::platforms) fn write_hermes_managed_models_with_stash(
    path: &PathBuf,
    entries: &[Value],
    stash_dir: &Path,
) -> Result<(), String> {
    ensure_parent_dir(path)?;
    ensure_backup(path)?;
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| format!("读取 Hermes config.yaml 失败: {e}"))?
    } else {
        String::new()
    };
    let root = parse_yaml_value(&raw, "config.yaml")?;

    // 受管识别必须用“旧状态”快照，且先读后写（函数末尾的 managed_write_state 会覆盖它）
    let dir = path
        .parent()
        .ok_or_else(|| "Hermes 配置路径无父目录".to_string())?;
    let managed_names = hermes_managed_names_from_state(dir);

    // 用户手写的 provider 原样保留
    let mut retained: Vec<YamlValue> = Vec::new();
    if let Some(list) = root.get("custom_providers").and_then(YamlValue::as_sequence) {
        for item in list {
            let name = item.get("name").and_then(YamlValue::as_str).unwrap_or("");
            if hermes_entry_is_managed(name, &managed_names) {
                continue;
            }
            retained.push(item.clone());
        }
    }

    let groups = hermes_build_groups(entries)?;
    let mut used: HashSet<String> = retained
        .iter()
        .filter_map(|item| {
            item.get("name")
                .and_then(YamlValue::as_str)
                .map(str::to_string)
        })
        .collect();
    let mut default_pair: Option<(String, String, String)> = None;
    for group in &groups {
        // 与用户条目重名的供应商：追加后缀保证唯一
        let mut provider_name = group.name.clone();
        if used.contains(&provider_name) {
            let mut suffix = 2;
            while used.contains(&format!("{provider_name}-{suffix}")) {
                suffix += 1;
            }
            provider_name = format!("{provider_name}-{suffix}");
        }
        used.insert(provider_name.clone());
        let renamed = HermesGroup {
            name: provider_name.clone(),
            ..group.clone()
        };
        if default_pair.is_none() {
            if let Some(model_id) = renamed.models.first() {
                default_pair = Some((provider_name, model_id.clone(), renamed.base_url.clone()));
            }
        }
        retained.push(hermes_group_entry(&renamed, false));
    }

    let providers_block = yaml_block_for_value(&YamlValue::Sequence(retained), 2)?;

    // 记账（块级）：custom_providers 块 + model 块内三个标量
    {
        let mut plans = vec![crate::commands::agent_stash::FieldPlan {
            path: vec!["custom_providers".into()],
            current: yaml_block_text(&root, "custom_providers")
                .map(crate::commands::agent_stash::Stashed::Str)
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
            new: crate::commands::agent_stash::Stashed::Str(providers_block.clone()),
        }];
        for key in ["default", "provider", "base_url"] {
            let cur = root
                .get("model")
                .and_then(|m| m.get(key))
                .and_then(YamlValue::as_str)
                .map(|s| crate::commands::agent_stash::Stashed::Str(s.to_string()))
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
            let new = match (key, &default_pair) {
                ("default", Some((_, model_id, _))) => {
                    crate::commands::agent_stash::Stashed::Str(model_id.clone())
                }
                ("provider", Some((provider_name, _, _))) => {
                    crate::commands::agent_stash::Stashed::Str(provider_name.clone())
                }
                ("base_url", Some((_, _, base_url))) => {
                    crate::commands::agent_stash::Stashed::Str(base_url.clone())
                }
                // 清空路径：这三个标量会被删除
                _ => crate::commands::agent_stash::Stashed::Absent,
            };
            plans.push(crate::commands::agent_stash::FieldPlan {
                path: vec!["model".into(), key.to_string()],
                current: cur,
                new,
            });
        }
        if let Err(e) =
            crate::commands::agent_stash::record_apply(stash_dir, &hermes_stash_key(), &plans)
        {
            eprintln!("[agent-stash] Hermes 记账失败（不影响切换）: {e}");
        }
    }

    let mut next = yaml_set_top_level_block(&raw, "custom_providers", &providers_block);
    if let Some((provider_name, model_id, base_url)) = default_pair {
        next = yaml_set_scalar_in_block(&next, "model", "default", &yaml_scalar(&model_id));
        next = yaml_set_scalar_in_block(&next, "model", "provider", &yaml_scalar(&provider_name));
        next = yaml_set_scalar_in_block(&next, "model", "base_url", &yaml_scalar(&base_url));
    } else {
        // 全部停用/清空时，之前写入的默认模型会指向已删除的 provider，必须清掉
        let provider_points_to_managed = root
            .get("model")
            .and_then(|m| m.get("provider"))
            .and_then(YamlValue::as_str)
            .map(|p| hermes_entry_is_managed(p, &managed_names))
            .unwrap_or(false);
        if provider_points_to_managed {
            next = yaml_remove_scalar_in_block(&next, "model", "provider");
            next = yaml_remove_scalar_in_block(&next, "model", "default");
        }
    }
    // 落盘前验证语法，避免写入损坏用户配置
    parse_yaml_value(&next, "config.yaml")?;
    crate::commands::write_atomic(path, next.as_bytes())?;

    // 完整快照：还原停用条目，并补齐 Hermes 格式承载不了的字段
    managed_write_state(dir, entries)
}


pub(in crate::commands::platforms) fn hermes_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "hermes",
        file: "config.yaml",
    }
}
