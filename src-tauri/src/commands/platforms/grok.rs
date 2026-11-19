use crate::commands::config::Provider;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use toml_edit::{value, DocumentMut, Item, Table};

use super::common::{
    agent_stash_dir, backup_path, emit_switch_progress, ensure_backup, openai_base_url,
    toml_item_string, SwitchResult,
};
use super::platform_enum::Platform;


pub(in crate::commands::platforms) fn grok_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "grok",
        file: "config.toml",
    }
}


/// Grok 切回官方（带门控）：先按账本恢复 `[models].default` 原值，
/// 再执行托管表清理（对已恢复的 default 跳过删除，避免把用户原值抹掉）。
pub(in crate::commands::platforms) fn apply_grok_official_with_stash(path: &PathBuf, stash_dir: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 Grok 配置文件失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut doc = raw
        .parse::<DocumentMut>()
        .map_err(|e| format!("解析 Grok config.toml 失败: {e}"))?;

    // 门控开启：字段级恢复 models.default（toml_edit 保形）
    let mut default_restored = false;
    if crate::commands::agent_stash::field_restore_enabled() {
        match crate::commands::field_restore::restore_toml_scalars_via_stash(
            path,
            &grok_stash_key(),
            stash_dir,
            &[],
            "Grok",
        ) {
            Ok(keys) => default_restored = keys.contains("models.default"),
            Err(e) => {
                eprintln!("[agent-stash] Grok 字段级还原失败，退回删托管键: {e}");
            }
        }
        // 重新读取（restore 可能已改写文件）
        let raw2 = fs::read_to_string(path).map_err(|e| format!("读取 Grok 配置文件失败: {e}"))?;
        doc = raw2
            .parse::<DocumentMut>()
            .map_err(|e| format!("解析 Grok config.toml 失败: {e}"))?;
    }

    let current_default = doc
        .get("models")
        .and_then(Item::as_table_like)
        .and_then(|t| t.get("default"))
        .and_then(toml_item_string);

    let mut keys_to_remove = Vec::new();
    if let Some(model_table) = doc.get("model").and_then(Item::as_table_like) {
        for (key, val) in model_table.iter() {
            if let Some(table) = val.as_table_like() {
                let is_managed = table
                    .get("anybridge_managed")
                    .and_then(Item::as_bool)
                    .unwrap_or(false);
                if is_managed || key == "anybridge" {
                    keys_to_remove.push(key.to_string());
                }
            }
        }
    }

    if let Some(model_table) = doc.get_mut("model").and_then(Item::as_table_like_mut) {
        for key in &keys_to_remove {
            model_table.remove(key);
        }
    }

    // 已按账本恢复用户原 default 的跳过删除（避免把原值又抹掉）
    if !default_restored {
        if let Some(def) = current_default {
            if keys_to_remove.contains(&def) || def == "anybridge" {
                if let Some(models_table) =
                    doc.get_mut("models").and_then(Item::as_table_like_mut)
                {
                    models_table.remove("default");
                }
            }
        }
    }
    if doc
        .get("models")
        .and_then(Item::as_table_like)
        .is_some_and(|t| t.is_empty())
    {
        doc.remove("models");
    }

    crate::commands::write_atomic(path, doc.to_string().as_bytes())?;
    if let Err(e) = crate::commands::agent_stash::clear_for(stash_dir, &grok_stash_key()) {
        eprintln!("[agent-stash] Grok 清账失败: {e}");
    }
    Ok(())
}


pub(in crate::commands::platforms) fn grok_sanitize_key(key: &str) -> String {
    let s: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        "anybridge".to_string()
    } else {
        trimmed.to_string()
    }
}


/// 取某个注册模型的上下文窗口：优先逐模型表，回退到配置级值。
pub(in crate::commands::platforms) fn grok_model_context(p: &Provider, model: &str) -> Option<u32> {
    p.model_contexts.get(model).copied().or(p.context_window)
}


pub(in crate::commands::platforms) fn read_grok_config_info(
    path: &PathBuf,
) -> Result<Option<(Option<String>, Option<String>, bool, Vec<String>)>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some((None, None, false, Vec::new())));
    }
    let doc = match raw.parse::<DocumentMut>() {
        Ok(doc) => doc,
        Err(e) => return Err(format!("Grok config.toml 解析失败: {e}")),
    };
    let default_model = doc
        .get("models")
        .and_then(Item::as_table_like)
        .and_then(|t| t.get("default"))
        .and_then(toml_item_string);

    let mut live_ids = Vec::new();
    if let Some(model_table) = doc.get("model").and_then(Item::as_table_like) {
        for (key, val) in model_table.iter() {
            // AnyBridge 注册的附加模型段（<配置key>--<模型名>）属于宿主配置的一部分，
            // 不是可独立切换的配置，不能当成「外部写入」列出来。
            let managed = val
                .as_table_like()
                .and_then(|t| t.get("anybridge_managed"))
                .and_then(Item::as_bool)
                .unwrap_or(false);
            if managed && key.contains("--") {
                continue;
            }
            live_ids.push(key.to_string());
        }
    }

    let (provider_name, is_managed) = if let Some(ref def_id) = default_model {
        let entry = doc
            .get("model")
            .and_then(Item::as_table_like)
            .and_then(|t| t.get(def_id))
            .and_then(Item::as_table_like);
        let name = entry.and_then(|t| t.get("name")).and_then(toml_item_string);
        let managed = entry
            .and_then(|t| t.get("anybridge_managed"))
            .and_then(Item::as_bool)
            .unwrap_or(def_id == "anybridge");
        (name, managed)
    } else {
        (None, false)
    };

    Ok(Some((default_model, provider_name, is_managed, live_ids)))
}

/// spawn_blocking 内部实现（勿直接在主线程调用）
pub(in crate::commands::platforms) fn restore_grok_official_config_sync(app: &AppHandle) -> Result<SwitchResult, String>{
    let plat = Platform::Grok;
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
    emit_switch_progress(&app, plat.id(), "writing", "正在恢复官方配置…");
    plat.apply_grok_official(&path)?;

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
        message: "已切回 Grok 官方配置，重启终端 grok 生效".to_string(),
        config_path,
        backup_path: backup,
    })
}

impl Platform {

    pub(in crate::commands::platforms) fn apply_grok(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        self.apply_grok_with_stash(path, p, &agent_stash_dir())
    }


    /// 记账可注入版（测试隔离；生产走 agent_stash_dir()）。
    /// 本轮记账范围：`[models].default` 指针（最常被覆盖丢失的用户原值）。
    /// `[model.<id>]` 托管表不在记账范围——official 按 anybridge_managed
    /// flag 保守删除，用户自写同名表不受影响。
    pub(in crate::commands::platforms) fn apply_grok_with_stash(
        &self,
        path: &PathBuf,
        p: &Provider,
        stash_dir: &Path,
    ) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| format!("读取 Grok 配置文件失败: {e}"))?
        } else {
            String::new()
        };
        let mut doc = if raw.trim().is_empty() {
            DocumentMut::new()
        } else {
            raw.parse::<DocumentMut>()
                .map_err(|e| format!("解析 Grok config.toml 失败: {e}"))?
        };

        let section_key = grok_sanitize_key(&p.id);

        // 记账：models.default 指针（original 幂等）
        {
            let current_default = doc
                .get("models")
                .and_then(Item::as_table_like)
                .and_then(|t| t.get("default"))
                .and_then(toml_item_string);
            let plans = vec![crate::commands::agent_stash::FieldPlan {
                path: vec!["models".into(), "default".into()],
                current: current_default
                    .map(crate::commands::agent_stash::Stashed::Str)
                    .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
                new: crate::commands::agent_stash::Stashed::Str(section_key.clone()),
            }];
            if let Err(e) =
                crate::commands::agent_stash::record_apply(stash_dir, &grok_stash_key(), &plans)
            {
                eprintln!("[agent-stash] Grok 记账失败（不影响切换）: {e}");
            }
        }

        if !doc.contains_key("models") {
            doc.insert("models", Item::Table(Table::new()));
        }
        let models_table = doc["models"]
            .as_table_like_mut()
            .ok_or_else(|| "Grok config.toml 中的 models 不是 table".to_string())?;
        models_table.insert("default", value(&section_key));

        if !doc.contains_key("model") {
            doc.insert("model", Item::Table(Table::new()));
        }

        // 本配置上次写入的段（主段 + 附加模型段）先清掉，
        // 否则取消勾选的模型会作为幽灵段留在 config.toml 里，Grok 仍会列出它们。
        let stale_prefix = format!("{section_key}--");
        let mut stale_keys = Vec::new();
        if let Some(existing) = doc.get("model").and_then(Item::as_table_like) {
            for (key, val) in existing.iter() {
                if key != section_key && !key.starts_with(&stale_prefix) {
                    continue;
                }
                let managed = val
                    .as_table_like()
                    .and_then(|t| t.get("anybridge_managed"))
                    .and_then(Item::as_bool)
                    .unwrap_or(false);
                if managed {
                    stale_keys.push(key.to_string());
                }
            }
        }
        if let Some(existing) = doc.get_mut("model").and_then(Item::as_table_like_mut) {
            for key in &stale_keys {
                existing.remove(key);
            }
        }

        let model_table = doc["model"]
            .as_table_like_mut()
            .ok_or_else(|| "Grok config.toml 中的 model 不是 table".to_string())?;

        let raw_model = p.default_model.trim();
        let model_val = if raw_model.is_empty() {
            "default"
        } else {
            raw_model
        };
        let backend = if !p.wire_api.trim().is_empty() {
            p.wire_api.trim()
        } else {
            "chat_completions"
        };
        let base_url = openai_base_url(p);

        // 附加模型：同一供应商下注册多个模型，可在 Grok 里用 /model 或 Ctrl+M 切换。
        // 主模型单独占 section_key，保持与旧版配置兼容。
        let mut extra_models: Vec<&str> = Vec::new();
        for candidate in &p.models {
            let id = candidate.trim();
            if id.is_empty() || id == model_val || extra_models.contains(&id) {
                continue;
            }
            extra_models.push(id);
        }

        let mut entry = Table::new();
        // Grok 在状态栏 / 模型选择器里显示的是 name（display name）而不是 model id，
        // 只写配置名会让人看不出当前跑的是哪个模型，所以统一带上模型名。
        entry.insert("name", value(&format!("{} · {}", p.name, model_val)));
        entry.insert("model", value(model_val));
        entry.insert("base_url", value(base_url.as_str()));
        entry.insert("api_key", value(&p.api_key));
        entry.insert("api_backend", value(backend));
        // Grok 只认显式值：不写 context_window 时它一律按 200,000 处理，
        // 小上下文模型永远不会触发自动压缩，最终在 SSE 流里溢出并被判定为可重试错误。
        if let Some(ctx) = grok_model_context(p, model_val) {
            entry.insert("context_window", value(i64::from(ctx)));
        }
        entry.insert("anybridge_managed", value(true));

        model_table.insert(&section_key, Item::Table(entry));

        for id in extra_models {
            let mut extra = Table::new();
            extra.insert("name", value(format!("{} · {}", p.name, id).as_str()));
            extra.insert("model", value(id));
            extra.insert("base_url", value(base_url.as_str()));
            extra.insert("api_key", value(&p.api_key));
            extra.insert("api_backend", value(backend));
            if let Some(ctx) = grok_model_context(p, id) {
                extra.insert("context_window", value(i64::from(ctx)));
            }
            extra.insert("anybridge_managed", value(true));
            model_table.insert(
                &format!("{section_key}--{}", grok_sanitize_key(id)),
                Item::Table(extra),
            );
        }

        // 子代理模型覆盖：只给用户显式指定过的类型写项，其余类型 Grok 自动继承主会话模型。
        // 清理策略：仅移除「值指向本配置模型段」的项，用户手写指向内置模型的项一律不动。
        let own_prefix = format!("{section_key}--");
        let mut stale_agents = Vec::new();
        if let Some(sub) = doc.get("subagents").and_then(Item::as_table_like) {
            if let Some(agent_models) = sub.get("models").and_then(Item::as_table_like) {
                for (agent, val) in agent_models.iter() {
                    let target = val.as_str().unwrap_or_default();
                    if target == section_key || target.starts_with(&own_prefix) {
                        stale_agents.push(agent.to_string());
                    }
                }
            }
        }
        if !stale_agents.is_empty() {
            if let Some(agent_models) = doc
                .get_mut("subagents")
                .and_then(Item::as_table_like_mut)
                .and_then(|t| t.get_mut("models"))
                .and_then(Item::as_table_like_mut)
            {
                for agent in &stale_agents {
                    agent_models.remove(agent);
                }
            }
        }

        if !p.subagent_models.is_empty() {
            if !doc.contains_key("subagents") {
                doc.insert("subagents", Item::Table(Table::new()));
            }
            let sub_table = doc["subagents"]
                .as_table_like_mut()
                .ok_or_else(|| "Grok config.toml 中的 subagents 不是 table".to_string())?;
            // 实测（1.0.30）：只写 [subagents.models] 而不显式 enabled = true 时，
            // spawn_subagent 工具会从工具列表里消失，子代理功能整体失效。
            sub_table.insert("enabled", value(true));
            if !sub_table.contains_key("models") {
                sub_table.insert("models", Item::Table(Table::new()));
            }
            let agent_models = sub_table
                .get_mut("models")
                .and_then(Item::as_table_like_mut)
                .ok_or_else(|| "Grok config.toml 中的 subagents.models 不是 table".to_string())?;
            for (agent, model_key) in &p.subagent_models {
                let agent_name = agent.trim();
                let target = model_key.trim();
                if agent_name.is_empty() || target.is_empty() {
                    continue;
                }
                agent_models.insert(agent_name, value(target));
            }
        }

        // 清空后的空表顺手移除：models 空时把 AnyBridge 写的 enabled/models 一并清掉，
        // subagents 由此为空才整体移除（用户手写的 toggle/roles/personas 不受影响）。
        let mut drop_subagents = false;
        if let Some(sub) = doc.get_mut("subagents").and_then(Item::as_table_like_mut) {
            let models_empty = sub
                .get("models")
                .and_then(Item::as_table_like)
                .map(|t| t.is_empty())
                .unwrap_or(true);
            if models_empty {
                sub.remove("models");
                sub.remove("enabled");
                drop_subagents = sub.is_empty();
            }
        }
        if drop_subagents {
            doc.remove("subagents");
        }

        crate::commands::write_atomic(path, doc.to_string().as_bytes())
    }


    pub(in crate::commands::platforms) fn apply_grok_official(&self, path: &PathBuf) -> Result<(), String> {
        apply_grok_official_with_stash(path, &agent_stash_dir())
    }

}
