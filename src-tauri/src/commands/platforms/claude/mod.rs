use crate::commands::config::{ClaudeCodeConfig, Provider};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::common::{
    agent_stash_dir, backup_path, emit_switch_progress, ensure_backup, mask_key, merge_json_object,
    parse_json_object, strip_first_matching_suffix, ClaudeConfigInfo, DriftField, SwitchResult,
};
use super::platform_enum::Platform;

mod fields;
pub(in crate::commands::platforms) use fields::*;

/// 值不返回——记账字段含 AUTH_TOKEN，路径和分类足够定位问题。
pub(crate) fn detect_claude_drift(settings_path: &Path) -> Vec<DriftField> {
    detect_claude_drift_in(&agent_stash_dir(), settings_path)
}


/// 内部实现：显式 dir 参数（测试注入临时目录），与 agent_stash 同款先例。
pub(in crate::commands::platforms) fn detect_claude_drift_in(stash_dir: &Path, settings_path: &Path) -> Vec<DriftField> {
    let entries = match crate::commands::agent_stash::entries_for(stash_dir, &claude_stash_key()) {
            Ok(entries) => entries,
            Err(e) => {
                eprintln!("[agent-stash] 漂移检测读账本失败（视为未知）: {e}");
                return Vec::new();
            }
        };
    if entries.is_empty() {
        return Vec::new();
    }
    let raw = match fs::read_to_string(settings_path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("[agent-stash] 漂移检测读 settings.json 失败（视为未知）: {e}");
            return Vec::new();
        }
    };
    let obj = match parse_json_object(&raw, "settings.json") {
        Ok(obj) => Value::Object(obj),
        Err(e) => {
            eprintln!("[agent-stash] 漂移检测解析 settings.json 失败（视为未知）: {e}");
            return Vec::new();
        }
    };
    entries
        .iter()
        .filter(|entry| {
            let current = match json_value_at(&obj, &entry.path) {
                Some(v) => crate::commands::agent_stash::Stashed::from_json(v),
                None => Some(crate::commands::agent_stash::Stashed::Absent),
            };
            match current {
                Some(current) => current != entry.applied,
                // 键处是对象/数组（记账时被跳过的类型）——无法比对，不算漂移
                None => false,
            }
        })
        .map(|entry| DriftField {
            path: entry.path.join("."),
            kind: drift_kind_of(&entry.path),
        })
        .collect()
}


/// Claude Code env 记账计划（`apply_claude` 将覆盖/删除的全部字段）。
/// `max_retries` 传 model-map enhancement 的值；None 表示本次不写该键。
pub(in crate::commands::platforms) fn claude_env_field_plans(
    env_obj: &Map<String, Value>,
    base: &str,
    token: &str,
    model: &str,
    max_retries: Option<u32>,
) -> Vec<crate::commands::agent_stash::FieldPlan> {
    let cur = |key: &str| -> crate::commands::agent_stash::Stashed {
        env_obj
            .get(key)
            .and_then(crate::commands::agent_stash::Stashed::from_json)
            .unwrap_or(crate::commands::agent_stash::Stashed::Absent)
    };
    let raw_model = model.trim();
    let mut plans: Vec<crate::commands::agent_stash::FieldPlan> = Vec::new();
    let mut push_str = |key: &str, value: String| {
        plans.push(crate::commands::agent_stash::FieldPlan {
            path: vec!["env".to_string(), key.to_string()],
            current: cur(key),
            new: crate::commands::agent_stash::Stashed::Str(value),
        });
    };
    push_str("ANTHROPIC_BASE_URL", base.to_string());
    push_str("ANTHROPIC_AUTH_TOKEN", token.to_string());
    push_str("ANTHROPIC_MODEL", raw_model.to_string());
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
        push_str(model_key, raw_model.to_string());
        push_str(name_key, strip_one_m_marker(raw_model).to_string());
    }
    if let Some(retries) = max_retries {
        push_str("CLAUDE_CODE_MAX_RETRIES", retries.to_string());
    }
    // set_claude_model_env 会删除 SMALL_FAST_MODEL，applied 记 Absent
    plans.push(crate::commands::agent_stash::FieldPlan {
        path: vec!["env".to_string(), "ANTHROPIC_SMALL_FAST_MODEL".to_string()],
        current: cur("ANTHROPIC_SMALL_FAST_MODEL"),
        new: crate::commands::agent_stash::Stashed::Absent,
    });
    plans
}


/// 把 settings_obj 中将被合并覆盖的叶子路径收集为记账计划
/// （与 `merge_json_object` 的深合并语义对齐：双方都是对象才递归；
/// 整体替换的对象无法用标量记账，跳过——还原走旧路径兜底）。
pub(in crate::commands::platforms) fn collect_claude_leaf_plans(
    current: &Map<String, Value>,
    incoming: &Map<String, Value>,
    prefix: &mut Vec<String>,
    plans: &mut Vec<crate::commands::agent_stash::FieldPlan>,
) {
    for (key, incoming_value) in incoming {
        prefix.push(key.clone());
        match incoming_value {
            Value::Object(nested) => {
                if let Some(Value::Object(cur_nested)) = current.get(key) {
                    collect_claude_leaf_plans(cur_nested, nested, prefix, plans);
                }
            }
            scalar => {
                if let Some(new_stashed) = crate::commands::agent_stash::Stashed::from_json(scalar) {
                    let current_stashed = current
                        .get(key)
                        .and_then(crate::commands::agent_stash::Stashed::from_json)
                        .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
                    plans.push(crate::commands::agent_stash::FieldPlan {
                        path: prefix.clone(),
                        current: current_stashed,
                        new: new_stashed,
                    });
                }
            }
        }
        prefix.pop();
    }
}


/// 把 settings 的标量叶子 flatten 成 (路径, 值) 列表（保形写入用）。
/// 遇到对象/数组叶子报错——保形路径只处理标量，诚实失败优先于静默破坏。
pub(in crate::commands::platforms) fn flatten_settings_scalars(
    incoming: &Map<String, Value>,
    prefix: &mut Vec<String>,
    out: &mut Vec<(Vec<String>, crate::commands::jsonc_edit::JsoncValue)>,
) -> Result<(), String> {
    for (key, value) in incoming {
        prefix.push(key.clone());
        match value {
            Value::Object(nested) => flatten_settings_scalars(nested, prefix, out)?,
            scalar => {
                let v = crate::commands::jsonc_edit::JsoncValue::from_json(scalar).ok_or_else(|| {
                    format!(
                        "settings 字段 {key} 不是标量，保形写入不支持；\
                         可关闭 ANYBRIDGE_FORMAT_PRESERVING_JSON 走旧路径"
                    )
                })?;
                out.push((prefix.clone(), v));
            }
        }
        prefix.pop();
    }
    Ok(())
}


/// 字段级还原 Claude Code settings.json（统一入口，保形门控内聚）。
///
/// - 账本无记录 → Ok(false)，调用方退回旧路径
/// - 保形门控开启（ANYBRIDGE_FORMAT_PRESERVING_JSON）→ 在原文本上逐字段
///   set/remove，注释、键序、缩进、CRLF、BOM 全保留
/// - 门控关闭 → parse 后逐字段写回再 pretty（与旧版输出格式一致）
/// - 成功后清账（失败不阻断，残留账本下次还原时因 applied 不符自然保守）
///
/// 失败语义：账本损坏/读文件失败 → Err，调用方退回整文件还原旧路径。
/// 语义实现收敛在 `field_restore::restore_json_fields_via_stash`（全平台一份）。
pub(in crate::commands::platforms) fn restore_claude_fields_via_stash(path: &PathBuf, stash_dir: &Path) -> Result<bool, String> {
    crate::commands::field_restore::restore_json_fields_via_stash(
        path,
        &claude_stash_key(),
        stash_dir,
        "Claude Code",
    )
}


pub(in crate::commands::platforms) fn claude_settings_from_config_with_providers(
    config: &ClaudeCodeConfig,
    providers: &[Provider],
    mask_token: bool,
) -> Value {
    let provider = config.resolve_provider(providers);
    let live_base = claude_base_url(&provider);
    let live_key = provider.api_key.clone();

    if let Some(settings) = config.settings_config.as_ref() {
        let mut out = settings.clone();
        normalize_claude_settings_model_env(&mut out, &config.default_model);
        if !config.source_provider_id.trim().is_empty() {
            if let Some(root) = out.as_object_mut() {
                if root.contains_key("apiKey") {
                    root.insert("apiKey".to_string(), Value::String(live_key.clone()));
                }
                let env_val = root
                    .entry("env")
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Some(env_obj) = env_val.as_object_mut() {
                    env_obj.insert("ANTHROPIC_BASE_URL".to_string(), Value::String(live_base));
                    env_obj.insert(
                        "ANTHROPIC_AUTH_TOKEN".to_string(),
                        Value::String(live_key.clone()),
                    );
                }
            }
        }
        if mask_token {
            if let Some(value) = out.get_mut("apiKey") {
                if let Some(masked) = value.as_str().map(mask_key) {
                    *value = Value::String(masked);
                }
            }
            if let Some(env) = out.get_mut("env").and_then(Value::as_object_mut) {
                for key in CLAUDE_AUTH_ENV_KEYS {
                    if let Some(value) = env.get_mut(*key) {
                        if let Some(masked) = value.as_str().map(mask_key) {
                            *value = Value::String(masked);
                        }
                    }
                }
            }
        }
        return out;
    }

    let base = live_base;
    let is_anyrouter = base.to_ascii_lowercase().contains("anyrouter")
        || config.name.to_ascii_lowercase().contains("anyrouter");
    let raw_model = provider.default_model.trim();
    let model = if is_anyrouter && is_claude_model(raw_model) {
        if !raw_model.ends_with("[1m]") && !raw_model.ends_with("[1M]") && !raw_model.is_empty() {
            format!("{raw_model}[1m]")
        } else {
            raw_model.to_string()
        }
    } else {
        strip_one_m_marker(raw_model).to_string()
    };
    let display_name = strip_one_m_marker(&model);
    let token = if mask_token {
        mask_key(&provider.api_key)
    } else {
        provider.api_key.clone()
    };

    serde_json::json!({
        "$schema": "https://json.schemastore.org/claude-code-settings.json",
        "includeCoAuthoredBy": false,
        "env": {
            "ANTHROPIC_BASE_URL": base,
            "ANTHROPIC_AUTH_TOKEN": token,
            "ANTHROPIC_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": display_name,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": display_name,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": display_name,
            "ANTHROPIC_DEFAULT_FABLE_MODEL": model,
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": display_name,
        },
        "permissions": {},
        "hooks": {},
        "mcpServers": {},
    })
}


pub(in crate::commands::platforms) fn apply_claude_config_file_with_providers(
    path: &PathBuf,
    config: &ClaudeCodeConfig,
    providers: &[Provider],
) -> Result<(), String> {
    apply_claude_config_file_with_providers_and_stash(path, config, providers, &agent_stash_dir())
}


#[cfg(test)]
pub(in crate::commands::platforms) fn apply_claude_config_file_with_stash(
    path: &PathBuf,
    config: &ClaudeCodeConfig,
    stash_dir: &Path,
) -> Result<(), String> {
    apply_claude_config_file_with_providers_and_stash(path, config, &[], stash_dir)
}

/// 配置方案路径的 Claude Code 写入。`stash_dir` 显式注入（测试用临时目录）。
/// 记账总是执行（纯增量）；记账失败不阻断切换。
pub(in crate::commands::platforms) fn apply_claude_config_file_with_providers_and_stash(
    path: &PathBuf,
    config: &ClaudeCodeConfig,
    providers: &[Provider],
    stash_dir: &Path,
) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = crate::commands::ide_config::parse_object(&raw)?;
    let settings = claude_settings_from_config_with_providers(config, providers, false);
    let settings_obj = settings
        .as_object()
        .ok_or_else(|| "Claude Code 配置 JSON 顶层必须是对象".to_string())?;

    // 记账：把将被合并覆盖的叶子路径记下来（original 幂等）
    let mut plans = Vec::new();
    collect_claude_leaf_plans(&obj, settings_obj, &mut Vec::new(), &mut plans);
    if !plans.is_empty() {
        if let Err(e) = crate::commands::agent_stash::record_apply(stash_dir, &claude_stash_key(), &plans) {
            eprintln!("[agent-stash] Claude Code 记账失败（不影响切换）: {e}");
        }
    }

    // 门控：保形写入（settings 的标量叶子逐个原位替换；对象叶子不支持，
    // 报错并提示关闭门控——诚实失败优先于静默破坏）
    if crate::commands::jsonc_edit::format_preserving_enabled() {
        let mut ops = Vec::new();
        flatten_settings_scalars(settings_obj, &mut Vec::new(), &mut ops)?;
        let mut text = raw.clone();
        for (leaf_path, value) in &ops {
            let segs: Vec<&str> = leaf_path.iter().map(String::as_str).collect();
            text = crate::commands::jsonc_edit::set_key(&text, &segs, value)?;
        }
        return crate::commands::write_atomic(path, text.as_bytes());
    }

    merge_json_object(&mut obj, settings_obj);
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
}


pub(in crate::commands::platforms) fn claude_compare_base_url(value: &str) -> String {
    strip_first_matching_suffix(
        value.trim().trim_end_matches('/'),
        &["/v1/messages", "/messages", "/v1"],
    )
    .trim_end_matches('/')
    .to_ascii_lowercase()
}


pub(in crate::commands::platforms) fn claude_provider_matches_config(config: &ClaudeConfigInfo, provider: &Provider) -> bool {
    let Some(current_base) = config.base_url.as_deref() else {
        return false;
    };
    let target_base = claude_compare_base_url(&claude_base_url(provider));
    let current_base = claude_compare_base_url(current_base);
    let same_base = !target_base.is_empty() && target_base == current_base;
    let provider_model = provider.default_model.trim();
    let same_model = provider_model.is_empty()
        || config.model_candidates.is_empty()
        || config
            .model_candidates
            .iter()
            .any(|model| model == provider_model);

    same_base && same_model
}

/// spawn_blocking 内部实现（勿直接在主线程调用）
pub(in crate::commands::platforms) fn restore_claude_official_config_sync(app: &AppHandle) -> Result<SwitchResult, String>{
    let plat = Platform::ClaudeCode;
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
    emit_switch_progress(&app, plat.id(), "writing", "正在写入官方配置…");
    plat.apply_claude_official(&path)?;

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
        message: "已切回 Claude Code 官方配置，重启 Claude Code 后生效".to_string(),
        config_path,
        backup_path: backup,
    })
}

impl Platform {

    pub(in crate::commands::platforms) fn apply_claude(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        self.apply_claude_with_stash(path, p, &agent_stash_dir())
    }


    /// 接入 Claude Code（供应商直连）。`stash_dir` 显式注入（测试用临时目录）。
    /// 记账总是执行（纯增量）；记账失败不阻断切换。
    pub(in crate::commands::platforms) fn apply_claude_with_stash(
        &self,
        path: &PathBuf,
        p: &Provider,
        stash_dir: &Path,
    ) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        // 复用 ide_config 的 json5 容错解析（支持注释/尾逗号）。
        let mut obj = crate::commands::ide_config::parse_object(&raw)?;

        let env = obj
            .entry("env")
            .or_insert_with(|| Value::Object(Map::new()));
        let env_obj = env
            .as_object_mut()
            .ok_or_else(|| "settings.json 的 env 字段不是对象".to_string())?;

        let base = claude_base_url(p);
        let model = p.default_model.trim().to_string();

        // ── Claude Code 原生重试配置：从 model-map.json enhancement 读取 ──
        let enhancement = crate::commands::model_map::read_map()
            .map(|m| m.enhancement)
            .unwrap_or_default();

        // 记账：覆盖前记录原值（original 幂等）与本次写入值（applied）。
        let plans = claude_env_field_plans(
            env_obj,
            &base,
            &p.api_key,
            &model,
            Some(enhancement.claude_max_retries),
        );
        if let Err(e) = crate::commands::agent_stash::record_apply(stash_dir, &claude_stash_key(), &plans) {
            eprintln!("[agent-stash] Claude Code 记账失败（不影响切换）: {e}");
        }

        // 门控：保形写入（在原文本上逐字段替换，注释/键序/缩进/CRLF/BOM 全保留）
        if crate::commands::jsonc_edit::format_preserving_enabled() {
            let mut text = raw.clone();
            let set_env = |text: &mut String, key: &str, val: String| -> Result<(), String> {
                *text = crate::commands::jsonc_edit::set_key(
                    text,
                    &["env", key],
                    &crate::commands::jsonc_edit::JsoncValue::Str(val),
                )?;
                Ok(())
            };
            set_env(&mut text, "ANTHROPIC_BASE_URL", base.clone())?;
            set_env(&mut text, "ANTHROPIC_AUTH_TOKEN", p.api_key.clone())?;
            set_env(&mut text, "ANTHROPIC_MODEL", model.clone())?;
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
                set_env(&mut text, model_key, model.clone())?;
                set_env(&mut text, name_key, strip_one_m_marker(&model).to_string())?;
            }
            set_env(
                &mut text,
                "CLAUDE_CODE_MAX_RETRIES",
                enhancement.claude_max_retries.to_string(),
            )?;
            text = crate::commands::jsonc_edit::remove_key(
                &text,
                &["env", "ANTHROPIC_SMALL_FAST_MODEL"],
            )?;
            return crate::commands::write_atomic(path, text.as_bytes());
        }

        env_obj.insert("ANTHROPIC_BASE_URL".into(), Value::String(base));
        env_obj.insert(
            "ANTHROPIC_AUTH_TOKEN".into(),
            Value::String(p.api_key.clone()),
        );
        set_claude_model_env(env_obj, &model);
        env_obj.insert(
            "CLAUDE_CODE_MAX_RETRIES".into(),
            Value::String(enhancement.claude_max_retries.to_string()),
        );

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        crate::commands::write_atomic(path, json.as_bytes())
    }


    /// 切回官方（字段级还原门控见 agent_stash::field_restore_enabled）。
    pub(in crate::commands::platforms) fn apply_claude_official(&self, path: &PathBuf) -> Result<(), String> {
        self.apply_claude_official_with_stash(
            path,
            crate::commands::agent_stash::field_restore_enabled(),
            &agent_stash_dir(),
        )
    }


    /// 切回官方核心实现。`field_restore` 显式传入（测试注入，生产读门控）。
    pub(in crate::commands::platforms) fn apply_claude_official_with_stash(
        &self,
        path: &PathBuf,
        field_restore: bool,
        stash_dir: &Path,
    ) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }

        let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            return Ok(());
        }

        let mut obj = crate::commands::ide_config::parse_object(&raw)?;

        // 门控开启：优先字段级还原（写回原值，保留用户在接管期间的改动；
        // 保形门控内聚在统一入口里，注释/键序随之保留）。
        if field_restore {
            match restore_claude_fields_via_stash(path, stash_dir) {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(e) => {
                    eprintln!("[agent-stash] Claude Code 字段级还原失败，退回删托管键: {e}");
                }
            }
            // 无记账记录（或还原失败）→ 退回「删托管键」旧语义
        }

        let remove_env = if let Some(env) = obj.get_mut("env").and_then(Value::as_object_mut) {
            for key in CLAUDE_MANAGED_ENV_KEYS {
                env.remove(*key);
            }
            env.is_empty()
        } else {
            false
        };

        if remove_env {
            obj.remove("env");
        }

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        crate::commands::write_atomic(path, json.as_bytes())
    }

}

