use crate::commands::config::Provider;
use serde_json::Value;
use serde_yaml::Value as YamlValue;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::common::{agent_stash_dir, ensure_backup, ensure_parent_dir, mask_key};
use super::pi::{
    pi_endpoint_parts, pi_entries_from_provider, pi_entry_enabled, pi_positive_u64,
    PI_API_OPENAI_COMPLETIONS, PI_API_OPENAI_RESPONSES,
};
use super::yaml_block::{
    entry_bool, entry_string, managed_write_state, parse_yaml_value, yaml_block_for_value,
    yaml_block_text, yaml_set_top_level_block, yaml_set_top_level_scalar,
};

/// DeepSeek Harness settings.yaml（llm-pi-ai.providers）中受管 provider 的前缀。
pub(in crate::commands::platforms) const HARNESS_PROVIDER_PREFIX: &str = "anybridge";

/// DeepSeek Harness 凭据引用名前缀（写入 .credentials.yaml 的 refs）。
pub(in crate::commands::platforms) const HARNESS_CREDENTIAL_PREFIX: &str = "ANYBRIDGE";


pub(in crate::commands::platforms) fn harness_entries_from_provider(p: &Provider) -> Vec<Value> {
    pi_entries_from_provider(p)
}


// ─── DeepSeek Harness ───────────────────────────────────────────
//
// 写法与 Pi/Hermes 对齐：按供应商分组，每个供应商一个 providers 键
// （anybridge-<供应商 slug>，保留前缀以便识别受管条目），displayName =
// 供应商显示名（DSH 界面展示用），全部模型收敛进 models 列表（每行只写
// id 与能力字段，界面按 id 展示模型名）。密钥仍存 .credentials.yaml 的
// refs，provider 内用 apiKeyEnv 引用。

/// 供应商 → ascii 安全的 id 片段：非法字符折叠为 -；纯非 ascii（如中文）
/// 供应商名用 FNV-1a 稳定哈希，保证 apiKeyEnv 始终是合法环境变量名。
pub(in crate::commands::platforms) fn harness_vendor_slug(vendor: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in vendor.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in vendor.trim().as_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        format!("g{hash:08x}")
    } else {
        slug
    }
}


pub(in crate::commands::platforms) fn harness_provider_id(vendor: &str) -> String {
    format!("{HARNESS_PROVIDER_PREFIX}-{}", harness_vendor_slug(vendor))
}


/// 凭据引用名：provider 里存 apiKeyEnv，密钥本体在 .credentials.yaml 的 refs 里。
/// 从最终的 provider id 派生，保证与条目一一对应（slug 碰撞加后缀后也不重复）。
pub(in crate::commands::platforms) fn harness_credential_env(provider_id: &str) -> String {
    let tail = provider_id
        .strip_prefix(&format!("{HARNESS_PROVIDER_PREFIX}-"))
        .unwrap_or(provider_id);
    format!(
        "{HARNESS_CREDENTIAL_PREFIX}_{}",
        tail.to_ascii_uppercase().replace('-', "_")
    )
}


pub(in crate::commands::platforms) fn harness_is_managed_provider(id: &str) -> bool {
    id == HARNESS_PROVIDER_PREFIX
        || id.starts_with(&format!("{HARNESS_PROVIDER_PREFIX}-"))
}


#[derive(Clone)]
pub(in crate::commands::platforms) struct HarnessGroup {
    /// 供应商显示名，写入 displayName（DSH 界面展示用）
    pub(in crate::commands::platforms) name: String,
    pub(in crate::commands::platforms) base_url: String,
    pub(in crate::commands::platforms) api: &'static str,
    pub(in crate::commands::platforms) api_key: String,
    /// 该供应商下的全部模型（含能力字段，保序去重）
    pub(in crate::commands::platforms) models: Vec<YamlValue>,
}


/// 表格条目 → 供应商分组（按 名称+baseURL+api+apiKey 聚合，与 Pi/Hermes 一致）。
pub(in crate::commands::platforms) fn harness_build_groups(entries: &[Value]) -> Result<Vec<HarnessGroup>, String> {
    let mut groups: Vec<HarnessGroup> = Vec::new();
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

        let mut model = serde_yaml::Mapping::new();
        model.insert(
            YamlValue::String("id".to_string()),
            YamlValue::String(model_id.clone()),
        );
        if entry_bool(entry, "supportsReasoning") {
            model.insert(
                YamlValue::String("reasoning".to_string()),
                YamlValue::Bool(true),
            );
        }
        if let Some(ctx) = pi_positive_u64(entry.get("maxInputTokens")) {
            model.insert(
                YamlValue::String("contextWindow".to_string()),
                YamlValue::Number(ctx.into()),
            );
        }
        let input = if entry_bool(entry, "supportsImages") {
            vec![
                YamlValue::String("text".to_string()),
                YamlValue::String("image".to_string()),
            ]
        } else {
            vec![YamlValue::String("text".to_string())]
        };
        model.insert(YamlValue::String("input".to_string()), YamlValue::Sequence(input));

        if let Some(g) = groups.iter_mut().find(|g| {
            g.name == name && g.base_url == base_url && g.api == api && g.api_key == api_key
        }) {
            let duplicate = g
                .models
                .iter()
                .any(|m| m.get("id").and_then(YamlValue::as_str) == Some(model_id.as_str()));
            if !duplicate {
                g.models.push(YamlValue::Mapping(model));
            }
        } else {
            groups.push(HarnessGroup {
                name,
                base_url,
                api,
                api_key,
                models: vec![YamlValue::Mapping(model)],
            });
        }
    }
    Ok(groups)
}


/// 分组 → Harness provider（含凭据引用名与密钥；`mask` 用于预览）。
/// provider_id 由调用方保证唯一（slug 可能撞名），凭据引用名随之一致。
pub(in crate::commands::platforms) fn harness_group_provider_entry(
    group: &HarnessGroup,
    provider_id: &str,
    mask: bool,
) -> (YamlValue, String, String) {
    let env = harness_credential_env(provider_id);
    let mut provider = serde_yaml::Mapping::new();
    provider.insert(
        YamlValue::String("displayName".to_string()),
        YamlValue::String(group.name.clone()),
    );
    provider.insert(
        YamlValue::String("apiKeyEnv".to_string()),
        YamlValue::String(env.clone()),
    );
    provider.insert(
        YamlValue::String("api".to_string()),
        YamlValue::String(group.api.to_string()),
    );
    provider.insert(
        YamlValue::String("baseURL".to_string()),
        YamlValue::String(group.base_url.clone()),
    );
    provider.insert(
        YamlValue::String("models".to_string()),
        YamlValue::Sequence(group.models.clone()),
    );
    (
        YamlValue::Mapping(provider),
        env,
        if mask {
            mask_key(&group.api_key)
        } else {
            group.api_key.clone()
        },
    )
}


/// Harness settings.yaml + credentials → 表格条目。
pub(in crate::commands::platforms) fn harness_entries_from_settings(
    settings: &YamlValue,
    credentials: &YamlValue,
) -> Vec<Value> {
    let refs = credentials
        .get("refs")
        .and_then(YamlValue::as_mapping)
        .cloned()
        .unwrap_or_default();
    let Some(providers) = settings
        .get("llm-pi-ai")
        .and_then(|v| v.get("providers"))
        .and_then(YamlValue::as_mapping)
    else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for (key, value) in providers {
        let Some(id) = key.as_str() else { continue };
        if !harness_is_managed_provider(id) {
            continue;
        }
        let Some(models) = value.get("models").and_then(YamlValue::as_sequence) else {
            continue;
        };
        let display_name = value
            .get("displayName")
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let base_url = value
            .get("baseURL")
            .and_then(YamlValue::as_str)
            .unwrap_or("")
            .to_string();
        let api = value
            .get("api")
            .and_then(YamlValue::as_str)
            .unwrap_or(PI_API_OPENAI_COMPLETIONS);
        let url = if api == PI_API_OPENAI_RESPONSES {
            format!("{}/responses", base_url.trim_end_matches('/'))
        } else {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        };
        let api_key = value
            .get("apiKeyEnv")
            .and_then(YamlValue::as_str)
            .and_then(|env| refs.get(YamlValue::String(env.to_string())))
            .and_then(YamlValue::as_str)
            .unwrap_or("")
            .to_string();
        // 每个模型展开为一行；模型名按 id 展示，供应商名统一取 displayName
        for model in models {
            let Some(model_id) = model.get("id").and_then(YamlValue::as_str) else {
                continue;
            };
            let supports_images = model
                .get("input")
                .and_then(YamlValue::as_sequence)
                .map(|list| list.iter().any(|v| v.as_str() == Some("image")))
                .unwrap_or(false);
            let mut entry = serde_json::json!({
                "id": model_id,
                "name": display_name,
                "vendor": display_name,
                "url": url,
                "apiKey": api_key,
                "supportsImages": supports_images,
                "supportsReasoning": model.get("reasoning").and_then(YamlValue::as_bool).unwrap_or(false),
                "enabled": true,
            });
            if let Some(ctx) = model.get("contextWindow").and_then(YamlValue::as_u64) {
                entry["maxInputTokens"] = serde_json::json!(ctx);
            }
            entries.push(entry);
        }
    }
    entries
}


pub(in crate::commands::platforms) fn harness_preview_value(entries: &[Value]) -> Result<YamlValue, String> {
    let groups = harness_build_groups(entries)?;
    let mut providers = serde_yaml::Mapping::new();
    let mut refs = serde_yaml::Mapping::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut default_pair: Option<(String, String)> = None;
    for group in &groups {
        // 先唯一化 id，再按最终 id 构造条目与凭据引用名，避免 slug 撞名覆盖
        let base_id = harness_provider_id(&group.name);
        let mut provider_id = base_id.clone();
        if used.contains(&provider_id) {
            let mut suffix = 2;
            while used.contains(&format!("{provider_id}-{suffix}")) {
                suffix += 1;
            }
            provider_id = format!("{provider_id}-{suffix}");
        }
        used.insert(provider_id.clone());
        let (provider, env, api_key) = harness_group_provider_entry(group, &provider_id, true);
        if default_pair.is_none() {
            if let Some(first) = group.models.first() {
                if let Some(model_id) = first.get("id").and_then(YamlValue::as_str) {
                    default_pair = Some((provider_id.clone(), model_id.to_string()));
                }
            }
        }
        refs.insert(YamlValue::String(env), YamlValue::String(api_key));
        providers.insert(YamlValue::String(provider_id), provider);
    }
    let mut llm = serde_yaml::Mapping::new();
    llm.insert(
        YamlValue::String("providers".to_string()),
        YamlValue::Mapping(providers),
    );
    let mut selection = serde_yaml::Mapping::new();
    if let Some((provider_id, model_id)) = default_pair {
        selection.insert(
            YamlValue::String("provider".to_string()),
            YamlValue::String(provider_id),
        );
        selection.insert(
            YamlValue::String("model".to_string()),
            YamlValue::String(model_id),
        );
    }
    let mut root = serde_yaml::Mapping::new();
    root.insert(YamlValue::String("llm-pi-ai".to_string()), YamlValue::Mapping(llm));
    root.insert(
        YamlValue::String("agent-default-model".to_string()),
        YamlValue::Mapping(selection),
    );
    root.insert(YamlValue::String(".credentials refs".to_string()), YamlValue::Mapping(refs));
    Ok(YamlValue::Mapping(root))
}


pub(in crate::commands::platforms) fn harness_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "deepseek-harness",
        file: "settings.yaml",
    }
}


pub(in crate::commands::platforms) fn harness_credentials_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "deepseek-harness",
        file: ".credentials.yaml",
    }
}


/// 写入 DeepSeek Harness：settings.yaml（providers + 默认模型）+ .credentials.yaml（refs）。
pub(in crate::commands::platforms) fn write_harness_managed_models(
    settings_path: &PathBuf,
    credentials_path: &PathBuf,
    entries: &[Value],
) -> Result<(), String> {
    write_harness_managed_models_with_stash(
        settings_path,
        credentials_path,
        entries,
        &agent_stash_dir(),
    )
}


/// 记账可注入版。受管字段（块级账本）：
/// - settings.yaml：`llm-pi-ai` 块、`agent-default-model` 块
/// - .credentials.yaml：`refs` 块（独立账本键）
pub(in crate::commands::platforms) fn write_harness_managed_models_with_stash(
    settings_path: &PathBuf,
    credentials_path: &PathBuf,
    entries: &[Value],
    stash_dir: &Path,
) -> Result<(), String> {
    ensure_parent_dir(settings_path)?;
    ensure_backup(settings_path)?;
    ensure_backup(credentials_path)?;

    let settings_raw = if settings_path.exists() {
        fs::read_to_string(settings_path)
            .map_err(|e| format!("读取 DeepSeek Harness settings.yaml 失败: {e}"))?
    } else {
        String::new()
    };
    let credentials_raw = if credentials_path.exists() {
        fs::read_to_string(credentials_path)
            .map_err(|e| format!("读取 DeepSeek Harness 凭据失败: {e}"))?
    } else {
        String::new()
    };
    let settings_root = parse_yaml_value(&settings_raw, "settings.yaml")?;
    let credentials_root = parse_yaml_value(&credentials_raw, ".credentials.yaml")?;

    // llm-pi-ai 以原 mapping 为基底：providers 之外的兄弟字段（用户自己的配置）原样保留
    let mut llm = settings_root
        .get("llm-pi-ai")
        .and_then(YamlValue::as_mapping)
        .cloned()
        .unwrap_or_default();
    // 保留用户手写的 provider 与非受管凭据引用
    let mut providers = serde_yaml::Mapping::new();
    if let Some(existing) = settings_root
        .get("llm-pi-ai")
        .and_then(|v| v.get("providers"))
        .and_then(YamlValue::as_mapping)
    {
        for (key, value) in existing {
            if key
                .as_str()
                .map(harness_is_managed_provider)
                .unwrap_or(false)
            {
                continue;
            }
            providers.insert(key.clone(), value.clone());
        }
    }
    let mut refs = serde_yaml::Mapping::new();
    if let Some(existing) = credentials_root.get("refs").and_then(YamlValue::as_mapping) {
        for (key, value) in existing {
            let is_managed = key
                .as_str()
                .map(|env| env.starts_with(&format!("{HARNESS_CREDENTIAL_PREFIX}_")))
                .unwrap_or(false);
            if is_managed {
                continue;
            }
            refs.insert(key.clone(), value.clone());
        }
    }

    let mut used: HashSet<String> = providers
        .keys()
        .filter_map(|k| k.as_str().map(str::to_string))
        .collect();
    let mut default_pair: Option<(String, String)> = None;
    for group in &harness_build_groups(entries)? {
        // 先唯一化 id，再按最终 id 构造条目与凭据引用名，避免 slug 撞名覆盖
        let base_id = harness_provider_id(&group.name);
        let mut provider_id = base_id.clone();
        if used.contains(&provider_id) {
            let mut suffix = 2;
            while used.contains(&format!("{provider_id}-{suffix}")) {
                suffix += 1;
            }
            provider_id = format!("{provider_id}-{suffix}");
        }
        used.insert(provider_id.clone());
        let (provider, env, api_key) = harness_group_provider_entry(group, &provider_id, false);
        if !api_key.is_empty() {
            refs.insert(YamlValue::String(env), YamlValue::String(api_key));
        }
        if default_pair.is_none() {
            if let Some(first) = group.models.first() {
                if let Some(model_id) = first.get("id").and_then(YamlValue::as_str) {
                    default_pair = Some((provider_id.clone(), model_id.to_string()));
                }
            }
        }
        providers.insert(YamlValue::String(provider_id), provider);
    }

    llm.insert(
        YamlValue::String("providers".to_string()),
        YamlValue::Mapping(providers),
    );
    let llm_block = yaml_block_for_value(&YamlValue::Mapping(llm), 2)?;
    // 记账（块级）：llm-pi-ai 块 + agent-default-model 块 + credentials 的 refs 块
    {
        let selection_block = default_pair.as_ref().map(|(pid, mid)| {
            let mut selection = serde_yaml::Mapping::new();
            selection.insert(
                YamlValue::String("provider".to_string()),
                YamlValue::String(pid.clone()),
            );
            selection.insert(
                YamlValue::String("model".to_string()),
                YamlValue::String(mid.clone()),
            );
            yaml_block_for_value(&YamlValue::Mapping(selection), 2)
        });
        let new_default_block = match selection_block {
            Some(Ok(block)) => crate::commands::agent_stash::Stashed::Str(block),
            _ => crate::commands::agent_stash::Stashed::Absent,
        };
        let plans = vec![
            crate::commands::agent_stash::FieldPlan {
                path: vec!["llm-pi-ai".into()],
                current: yaml_block_text(&settings_root, "llm-pi-ai")
                    .map(crate::commands::agent_stash::Stashed::Str)
                    .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
                new: crate::commands::agent_stash::Stashed::Str(llm_block.clone()),
            },
            crate::commands::agent_stash::FieldPlan {
                path: vec!["agent-default-model".into()],
                current: yaml_block_text(&settings_root, "agent-default-model")
                    .map(crate::commands::agent_stash::Stashed::Str)
                    .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
                new: new_default_block,
            },
        ];
        if let Err(e) =
            crate::commands::agent_stash::record_apply(stash_dir, &harness_stash_key(), &plans)
        {
            eprintln!("[agent-stash] Harness settings 记账失败（不影响切换）: {e}");
        }
        // credentials：refs 块
        let new_refs = yaml_block_for_value(&YamlValue::Mapping(refs.clone()), 2)?;
        let cred_plans = vec![crate::commands::agent_stash::FieldPlan {
            path: vec!["refs".into()],
            current: yaml_block_text(&credentials_root, "refs")
                .map(crate::commands::agent_stash::Stashed::Str)
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
            new: crate::commands::agent_stash::Stashed::Str(new_refs),
        }];
        if let Err(e) = crate::commands::agent_stash::record_apply(
            stash_dir,
            &harness_credentials_stash_key(),
            &cred_plans,
        ) {
            eprintln!("[agent-stash] Harness credentials 记账失败（不影响切换）: {e}");
        }
    }

    let mut next = yaml_set_top_level_block(&settings_raw, "llm-pi-ai", &llm_block);
    if let Some((provider_id, model_id)) = default_pair {
        let mut selection = serde_yaml::Mapping::new();
        selection.insert(
            YamlValue::String("provider".to_string()),
            YamlValue::String(provider_id),
        );
        selection.insert(
            YamlValue::String("model".to_string()),
            YamlValue::String(model_id),
        );
        let block = yaml_block_for_value(&YamlValue::Mapping(selection), 2)?;
        next = yaml_set_top_level_block(&next, "agent-default-model", &block);
    } else {
        // 全部停用/清空时，之前写入的默认模型会指向已删除的 provider，必须清掉
        let provider_points_to_managed = settings_root
            .get("agent-default-model")
            .and_then(|m| m.get("provider"))
            .and_then(YamlValue::as_str)
            .map(harness_is_managed_provider)
            .unwrap_or(false);
        if provider_points_to_managed {
            next = yaml_set_top_level_block(&next, "agent-default-model", "");
        }
    }
    parse_yaml_value(&next, "settings.yaml")?;

    // 凭据文件：保留 records 与其它引用，只重写受管 refs。
    // 先写凭据再写 settings：settings 引用的 apiKeyEnv 一定已经存在
    let mut credentials_next = yaml_set_top_level_block(
        &credentials_raw,
        "refs",
        &yaml_block_for_value(&YamlValue::Mapping(refs), 2)?,
    );
    if credentials_root.get("version").is_none() {
        // DSH 会拒绝缺少 version 的凭据文件
        credentials_next = yaml_set_top_level_scalar(&credentials_next, "version", "1");
    }
    parse_yaml_value(&credentials_next, ".credentials.yaml")?;
    crate::commands::write_atomic(credentials_path, credentials_next.as_bytes())?;
    crate::commands::write_atomic(settings_path, next.as_bytes())?;

    let dir = settings_path
        .parent()
        .ok_or_else(|| "DeepSeek Harness 配置路径无父目录".to_string())?;
    // 完整快照：还原停用条目，并补齐 Harness 格式承载不了的字段
    managed_write_state(dir, entries)
}
