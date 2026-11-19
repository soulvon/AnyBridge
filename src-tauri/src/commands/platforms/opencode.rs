use crate::commands::config::{read_provider_store, OpenCodeConfig, Provider, ProviderStore};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::common::{
    agent_stash_dir, backup_path, emit_switch_progress, ensure_backup, mask_key, openai_base_url,
    parse_json_object, SwitchResult, PLATFORM_OPENCODE,
};
use super::platform_enum::Platform;


pub(in crate::commands::platforms) fn read_opencode_live_provider_ids(path: &PathBuf) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let obj = parse_json_object(&raw, "opencode.json")?;
    let Some(provider_obj) = obj.get("provider").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };

    let mut ids: Vec<String> = provider_obj
        .keys()
        .filter(|id| !id.trim().is_empty())
        .cloned()
        .collect();
    ids.sort();
    Ok(ids)
}


pub(in crate::commands::platforms) fn read_opencode_active_model_provider_id(path: &PathBuf) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let obj = parse_json_object(&raw, "opencode.json")?;
    Ok(obj
        .get("model")
        .and_then(Value::as_str)
        .and_then(|model| model.split('/').next())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string))
}


pub(in crate::commands::platforms) fn opencode_model_id(p: &Provider) -> String {
    let model = p.default_model.trim();
    if model.is_empty() {
        "model".to_string()
    } else {
        model.to_string()
    }
}


pub(in crate::commands::platforms) fn opencode_model_ids(p: &Provider) -> Vec<String> {
    let mut out = Vec::new();
    let default_model = opencode_model_id(p);
    out.push(default_model);
    for model in &p.models {
        let id = model.trim();
        if !id.is_empty() && !out.iter().any(|existing| existing == id) {
            out.push(id.to_string());
        }
    }
    out
}


pub(in crate::commands::platforms) fn opencode_provider_entry(p: &Provider) -> Value {
    let provider_name = if p.name.trim().is_empty() {
        "AnyBridge"
    } else {
        p.name.trim()
    };

    let mut models = Map::new();
    for model_id in opencode_model_ids(p) {
        let mut model_meta = Map::new();
        model_meta.insert("name".to_string(), Value::String(model_id.clone()));
        models.insert(model_id, Value::Object(model_meta));
    }

    serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": provider_name,
        "options": {
            "baseURL": openai_base_url(p),
            "apiKey": p.api_key,
        },
        "models": Value::Object(models),
    })
}


pub(in crate::commands::platforms) fn mask_opencode_entry_api_key(entry: &mut Value) {
    if let Some(options) = entry.get_mut("options").and_then(Value::as_object_mut) {
        if let Some(value) = options.get_mut("apiKey") {
            if let Some(masked) = value.as_str().map(mask_key) {
                *value = Value::String(masked);
            }
        }
    }
}


pub(in crate::commands::platforms) fn opencode_settings_from_config_with_providers(
    config: &OpenCodeConfig,
    providers: &[Provider],
    mask_token: bool,
) -> Value {
    let provider = config.resolve_provider(providers);
    if let Some(settings) = config.settings_config.as_ref() {
        let mut out = settings.clone();
        if !config.source_provider_id.trim().is_empty() {
            if let Some(root) = out.as_object_mut() {
                let opts = root
                    .entry("options")
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Some(opts_obj) = opts.as_object_mut() {
                    opts_obj.insert("baseURL".to_string(), Value::String(openai_base_url(&provider)));
                    opts_obj.insert("apiKey".to_string(), Value::String(provider.api_key.clone()));
                }
            }
        }
        if mask_token {
            mask_opencode_entry_api_key(&mut out);
        }
        return out;
    }

    let mut entry = opencode_provider_entry(&provider);
    if mask_token {
        mask_opencode_entry_api_key(&mut entry);
    }
    entry
}


pub(in crate::commands::platforms) fn opencode_default_model_key(config: &OpenCodeConfig, settings: &Value) -> Result<String, String> {
    let default_model = config.default_model.trim();
    if let Some(models) = settings.get("models").and_then(Value::as_object) {
        if !default_model.is_empty() && models.contains_key(default_model) {
            return Ok(default_model.to_string());
        }
        if let Some(model) = models.keys().find_map(|key| {
            let trimmed = key.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }) {
            return Ok(model);
        }
    }

    if !default_model.is_empty() {
        return Ok(default_model.to_string());
    }

    config
        .models
        .iter()
        .find_map(|model| {
            let trimmed = model.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .ok_or_else(|| "OpenCode 配置缺少默认模型，无法设置当前 model".to_string())
}


pub(in crate::commands::platforms) fn opencode_preview_from_config_with_providers(
    config: &OpenCodeConfig,
    providers: &[Provider],
) -> Value {
    let mut provider_map = Map::new();
    provider_map.insert(
        config.id.clone(),
        opencode_settings_from_config_with_providers(config, providers, true),
    );

    serde_json::json!({
        "opencode.json": {
            "$schema": "https://opencode.ai/config.json",
            "provider": Value::Object(provider_map),
        },
    })
}


pub(in crate::commands::platforms) fn opencode_preview(p: &Provider) -> Value {
    let mut provider_map = Map::new();
    let mut entry = opencode_provider_entry(p);
    mask_opencode_entry_api_key(&mut entry);
    provider_map.insert(p.id.clone(), entry);

    serde_json::json!({
        "opencode.json": {
            "$schema": "https://opencode.ai/config.json",
            "provider": Value::Object(provider_map),
        },
    })
}


pub(in crate::commands::platforms) fn apply_opencode_config_file_with_providers(
    path: &PathBuf,
    config: &OpenCodeConfig,
    providers: &[Provider],
) -> Result<(), String> {
    apply_opencode_config_file_with_providers_and_stash(path, config, providers, &agent_stash_dir())
}


pub(in crate::commands::platforms) fn opencode_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "opencode",
        file: "opencode.json",
    }
}


#[cfg(test)]
pub(in crate::commands::platforms) fn apply_opencode_config_file_with_stash(
    path: &PathBuf,
    config: &OpenCodeConfig,
    stash_dir: &Path,
) -> Result<(), String> {
    apply_opencode_config_file_with_providers_and_stash(path, config, &[], stash_dir)
}

/// OpenCode 接入（带记账）：受管字段 = `provider.<id>` 整对象 + `model` 标量。
/// 记账总是执行（original 幂等）；保形门控开启时走 jsonc_edit 原位编辑。
pub(in crate::commands::platforms) fn apply_opencode_config_file_with_providers_and_stash(
    path: &PathBuf,
    config: &OpenCodeConfig,
    providers: &[Provider],
    stash_dir: &Path,
) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "opencode.json")?;

    obj.entry("$schema")
        .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_string()));

    let settings = opencode_settings_from_config_with_providers(config, providers, false);
    if !settings.is_object() {
        return Err("OpenCode provider 配置 JSON 顶层必须是对象".to_string());
    }
    let model_key = opencode_default_model_key(config, &settings)?;
    let model_value = format!("{}/{}", config.id, model_key);

    // 记账：provider.<id>（对象 → Json 文本）与 model（标量）
    let provider_now = obj
        .get("provider")
        .and_then(|v| v.get(&config.id))
        .cloned();
    let model_now = obj.get("model").and_then(Value::as_str).map(String::from);
    let plans = vec![
        crate::commands::agent_stash::FieldPlan {
            path: vec!["provider".into(), config.id.clone()],
            current: provider_now
                .as_ref()
                .and_then(crate::commands::agent_stash::Stashed::from_json_any)
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
            new: crate::commands::agent_stash::Stashed::Json(settings.to_string()),
        },
        crate::commands::agent_stash::FieldPlan {
            path: vec!["model".into()],
            current: model_now
                .clone()
                .map(crate::commands::agent_stash::Stashed::Str)
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
            new: crate::commands::agent_stash::Stashed::Str(model_value.clone()),
        },
    ];
    if let Err(e) = crate::commands::agent_stash::record_apply(stash_dir, &opencode_stash_key(), &plans) {
        eprintln!("[agent-stash] OpenCode 记账失败（不影响切换）: {e}");
    }

    // 门控：保形写入
    if crate::commands::jsonc_edit::format_preserving_enabled() {
        let mut text = raw.clone();
        let schema_missing = obj.get("$schema").is_none();
        if schema_missing {
            text = crate::commands::jsonc_edit::set_key(
                &text,
                &["$schema"],
                &crate::commands::jsonc_edit::JsoncValue::Str("https://opencode.ai/config.json".into()),
            )?;
        }
        text = crate::commands::jsonc_edit::set_key(
            &text,
            &["provider", config.id.as_str()],
            &crate::commands::jsonc_edit::JsoncValue::Raw(settings.to_string()),
        )?;
        text = crate::commands::jsonc_edit::set_key(
            &text,
            &["model"],
            &crate::commands::jsonc_edit::JsoncValue::Str(model_value),
        )?;
        return crate::commands::write_atomic(path, text.as_bytes());
    }

    let provider_value = obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()));
    let provider_obj = provider_value
        .as_object_mut()
        .ok_or_else(|| "opencode.json 的 provider 字段不是对象".to_string())?;
    provider_obj.insert(config.id.clone(), settings);
    obj.insert("model".to_string(), Value::String(model_value));

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
}


/// OpenCode 字段级还原（统一入口，保形门控内聚）。
///
/// 受管字段语义：
/// - `provider.<id>`：对象级——original=Json 文本 → 写回原对象；Absent → 删除
/// - `model`：标量——original=Str → 写回；Absent → 删除
/// - 当前值 != applied（被外部改过）→ 保留用户的值不还原
///
/// 语义实现收敛在 `field_restore::restore_json_fields_via_stash`（全平台一份）。
/// 返回 true = 有账本记录并已处理（随后清账）；false = 无记录。
pub(in crate::commands::platforms) fn restore_opencode_fields_via_stash(path: &PathBuf, stash_dir: &Path) -> Result<bool, String> {
    crate::commands::field_restore::restore_json_fields_via_stash(
        path,
        &opencode_stash_key(),
        stash_dir,
        "OpenCode",
    )
}


/// OpenCode 切回官方（带门控）：字段级还原优先，无记录退回删托管键旧语义。
pub(in crate::commands::platforms) fn apply_opencode_official_with_stash(
    path: &PathBuf,
    store: &ProviderStore,
    stash_dir: &Path,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 opencode.json 失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut obj = parse_json_object(&raw, "opencode.json")?;

    // 门控开启：优先字段级还原（写回原值/保留用户改动；保形内聚）
    if crate::commands::agent_stash::field_restore_enabled() {
        match restore_opencode_fields_via_stash(path, stash_dir) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(e) => {
                eprintln!("[agent-stash] OpenCode 字段级还原失败，退回删托管键: {e}");
            }
        }
    }

    let mut managed_ids: Vec<String> = store
        .opencode_configs
        .iter()
        .map(|c| c.id.clone())
        .collect();
    managed_ids.push(PLATFORM_OPENCODE.to_string());
    managed_ids.push("anybridge-local-proxy".to_string());
    managed_ids.push("anybridge-local-proxy-opencode".to_string());

    if let Some(providers) = obj.get_mut("provider").and_then(Value::as_object_mut) {
        for id in &managed_ids {
            providers.remove(id);
        }
    }

    let current_model = obj.get("model").and_then(Value::as_str);
    if let Some(m) = current_model {
        let provider_prefix = m.split('/').next().unwrap_or("").trim();
        if managed_ids.iter().any(|id| id == provider_prefix) {
            obj.remove("model");
        }
    }

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
}

/// spawn_blocking 内部实现（勿直接在主线程调用）
pub(in crate::commands::platforms) fn restore_opencode_official_config_sync(app: &AppHandle) -> Result<SwitchResult, String>{
    let plat = Platform::OpenCode;
    let store = read_provider_store()?;
    emit_switch_progress(&app, plat.id(), "backup", "正在备份当前配置…");
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    if path.exists() {
        ensure_backup(&path)?;
    }
    emit_switch_progress(&app, plat.id(), "writing", "正在恢复官方 Zen / Go 配置…");
    plat.apply_opencode_official(&path, &store)?;

    emit_switch_progress(&app, plat.id(), "saving", "正在清除接管记录…");
    let _ = crate::commands::store_io::update_provider_store(|store| {
        let changed = store.platforms.remove(plat.id()).is_some();
        Ok((changed, ()))
    });

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    emit_switch_progress(&app, plat.id(), "done", "已切回官方配置");
    Ok(SwitchResult {
        ok: true,
        message: "已切回 OpenCode 官方配置 (Zen / Go)，重启或新建会话后生效".to_string(),
        config_path,
        backup_path: backup,
    })
}

impl Platform {

    pub(in crate::commands::platforms) fn apply_opencode(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let mut obj = parse_json_object(&raw, "opencode.json")?;

        obj.entry("$schema")
            .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_string()));

        let provider_value = obj
            .entry("provider")
            .or_insert_with(|| Value::Object(Map::new()));
        let provider_obj = provider_value
            .as_object_mut()
            .ok_or_else(|| "opencode.json 的 provider 字段不是对象".to_string())?;
        provider_obj.insert(p.id.clone(), opencode_provider_entry(p));

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        crate::commands::write_atomic(path, json.as_bytes())
    }


    pub(in crate::commands::platforms) fn apply_opencode_official(&self, path: &PathBuf, store: &ProviderStore) -> Result<(), String> {
        apply_opencode_official_with_stash(path, store, &agent_stash_dir())
    }

}
