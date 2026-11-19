use crate::commands::config::{read_provider_store, Provider};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use toml_edit::{value, DocumentMut, Item, Table};

use super::codex_agents::{
    apply_codex_agents, cleanup_anybridge_codex_agents, finalize_codex_agents_files,
    CodexAgentsFinalize,
};
use super::codex_catalog::{
    generate_model_catalog_json, resolve_codex_model_catalog_entries, CODEX_MODEL_CATALOG_FILENAME,
};
use super::common::{
    agent_stash_dir, append_switch_warnings, backup_path, emit_switch_progress, ensure_backup,
    toml_item_string, toml_table_bool, toml_top_current, SwitchResult,
};
use super::platform_enum::Platform;
mod config_parse;
pub(in crate::commands::platforms) use config_parse::*;
pub(crate) use config_parse::codex_home;

pub(in crate::commands::platforms) fn codex_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "codex",
        file: "config.toml",
    }
}


/// Codex 顶层标量字段级还原：按账本把未被外部改动的字段写回原值。
///
/// 返回已恢复的键集合（official 逻辑据此跳过对它们的删除/覆盖）。
/// 不清账——official 完成后统一清。
///
/// `skip`：结构性不可恢复的键（诚实跳过，不假装恢复）——
/// - unify 会话历史模式：provider 指针固定为 codex_local_access，model
///   作为它的从属值一并跳过（恢复会指向不存在的 provider 配置）
/// - 两种模式：model_catalog_json 指向的文件内容不可恢复，恢复悬空指针
///   是坏状态，一律跳过
///
/// 语义实现收敛在 `field_restore::restore_toml_scalars_via_stash`。
pub(in crate::commands::platforms) fn restore_codex_top_scalars_via_stash(
    path: &PathBuf,
    stash_dir: &Path,
    skip: &[&str],
) -> Result<std::collections::HashSet<String>, String> {
    crate::commands::field_restore::restore_toml_scalars_via_stash(
        path,
        &codex_stash_key(),
        stash_dir,
        skip,
        "Codex",
    )
}


/// Codex 切回官方（带门控）：先按账本恢复顶层标量原值，再执行官方化清理
/// （对已恢复的键跳过删除，避免把用户原值又抹掉）。
pub(in crate::commands::platforms) fn apply_codex_official_with_stash(
    path: &PathBuf,
    unify_session_history: bool,
    stash_dir: &Path,
) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut doc = raw
        .parse::<DocumentMut>()
        .map_err(|e| format!("config.toml 解析失败: {e}"))?;

    // 门控开启：字段级恢复（toml_edit 保形；当前值 != applied 的键不动）。
    // skip 语义见 restore_codex_top_scalars_via_stash：unify 模式下 provider
    // 指针与其从属的 model 结构性不可恢复；catalog 指针一律跳过。
    let mut restored: std::collections::HashSet<String> = std::collections::HashSet::new();
    if crate::commands::agent_stash::field_restore_enabled() && path.exists() {
        let skip: &[&str] = if unify_session_history {
            &["model_provider", "model", "model_catalog_json"]
        } else {
            &["model_catalog_json"]
        };
        match restore_codex_top_scalars_via_stash(path, stash_dir, skip) {
            Ok(keys) => restored = keys,
            Err(e) => {
                eprintln!("[agent-stash] Codex 字段级还原失败，退回删托管键: {e}");
            }
        }
        // 重新读取（restore 可能已改写文件）
        let raw2 = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        doc = raw2
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml 解析失败: {e}"))?;
    }
    let restored = &restored;

    if unify_session_history {
        // 统一会话历史模式：保留 model_provider = codex_local_access，
        // 配置 provider 使用官方 OAuth 认证（requires_openai_auth=true），
        // 不设 base_url（Codex 回落到官方端点），不写 bearer_token。
        // 这样官方会话和第三方会话都在 codex_local_access 桶中。
        doc["model_provider"] = value(CODEX_RUNTIME_MODEL_PROVIDER_ID);
        // 移除第三方模型指针（让 Codex 使用官方默认模型）；已按账本恢复的键跳过
        if !restored.contains("model") {
            doc.as_table_mut().remove("model");
        }
        if !restored.contains("model_catalog_json") {
            doc.as_table_mut().remove("model_catalog_json");
        }

        if let Some(catalog_dir) = path.parent() {
            let _ = fs::remove_file(catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME));
        }

        let providers = doc
            .entry("model_providers")
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| "config.toml 的 model_providers 不是表".to_string())?;
        providers.set_implicit(true);
        providers.remove(CODEX_LEGACY_MODEL_PROVIDER_ID);

        let provider_table = providers
            .entry(CODEX_RUNTIME_MODEL_PROVIDER_ID)
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| {
                format!(
                    "config.toml 的 model_providers.{CODEX_RUNTIME_MODEL_PROVIDER_ID} 不是表"
                )
            })?;
        provider_table["name"] = value("OpenAI 官方");
        provider_table["wire_api"] = value("responses");
        provider_table.remove("base_url");
        apply_codex_provider_auth(provider_table, true, None);
        provider_table[CODEX_ANYBRIDGE_MANAGED_FLAG] = value(true);

        // ── Codex 原生重试配置：统一会话历史模式也写入 ──
        let enhancement = crate::commands::model_map::read_map()
            .map(|m| m.enhancement)
            .unwrap_or_default();
        provider_table["request_max_retries"] =
            value(enhancement.codex_request_max_retries as i64);
        provider_table["stream_max_retries"] =
            value(enhancement.codex_stream_max_retries as i64);
    } else {
        // 原有行为：OpenAI Official uses Codex's built-in provider and auth.json login.
        // Keep common settings, but remove the active third-party pointer.
        // 已按账本恢复用户原值的键跳过删除。
        if !restored.contains("model") {
            doc.as_table_mut().remove("model");
        }
        if !restored.contains("model_provider") {
            doc.as_table_mut().remove("model_provider");
        }
        if !restored.contains("model_catalog_json") {
            doc.as_table_mut().remove("model_catalog_json");
        }

        // 删除可能存在的模型目录文件
        if let Some(catalog_dir) = path.parent() {
            let _ = fs::remove_file(catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME));
        }

        let providers_empty = doc["model_providers"]
            .as_table_mut()
            .map(|providers| {
                providers.remove(CODEX_LEGACY_MODEL_PROVIDER_ID);
                let should_remove_runtime = providers
                    .get(CODEX_RUNTIME_MODEL_PROVIDER_ID)
                    .and_then(Item::as_table)
                    .map(|table| toml_table_bool(table, CODEX_ANYBRIDGE_MANAGED_FLAG))
                    .unwrap_or(false);
                if should_remove_runtime {
                    providers.remove(CODEX_RUNTIME_MODEL_PROVIDER_ID);
                }
                providers.is_empty()
            })
            .unwrap_or(false);
        if providers_empty {
            doc.as_table_mut().remove("model_providers");
        }
    }

    let agents_finalize =
        CodexAgentsFinalize::cleanup_only(cleanup_anybridge_codex_agents(path, &mut doc)?);

    crate::commands::write_atomic(path, doc.to_string().as_bytes())?;
    let agents_result = finalize_codex_agents_files(path, agents_finalize);
    if let Err(e) = crate::commands::agent_stash::clear_for(stash_dir, &codex_stash_key()) {
        eprintln!("[agent-stash] Codex 清账失败: {e}");
    }
    agents_result
}


pub(in crate::commands::platforms) fn restore_codex_official_config_sync(app: &AppHandle) -> Result<SwitchResult, String> {
    let plat = Platform::Codex;
    let store = read_provider_store()?;
    emit_switch_progress(app, plat.id(), "backup", "正在备份当前配置…");
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    ensure_backup(&path)?;
    crate::commands::codex_desktop::clean_models_cache()?;
    emit_switch_progress(app, plat.id(), "routing", "正在清理 Codex 内置模型路由…");
    let _ = plan_clear_codex_proxy_routes()?;
    let legacy_cleanup_plan = plan_clear_legacy_global_codex_proxy_routes();
    let mut codex_cleanup_warnings = legacy_cleanup_plan.warnings;
    for warning in &codex_cleanup_warnings {
        emit_switch_progress(app, plat.id(), "warning", warning);
    }
    emit_switch_progress(app, plat.id(), "writing", "正在写入官方配置…");
    // 查找当前活跃的 Codex 配置，读取其 unify_session_history 标志（默认 true）
    let unify_session_history = store
        .platforms
        .get(plat.id())
        .and_then(|state| {
            store
                .codex_configs
                .iter()
                .find(|c| c.id == state.provider_id)
        })
        .map(|c| c.unify_session_history)
        .unwrap_or(true);
    plat.apply_codex_official(&path, unify_session_history)?;
    crate::commands::store_io::update_codex_proxy_routes(|cur| {
        *cur = plan_clear_codex_proxy_routes_into(std::mem::take(cur));
        Ok((true, ()))
    })?;
    if let Some(routes) = legacy_cleanup_plan.routes.as_ref() {
        if let Err(e) = crate::commands::proxy_routes::write_routes(routes) {
            let warning = legacy_global_codex_proxy_route_cleanup_warning("写入", &e);
            emit_switch_progress(app, plat.id(), "warning", &warning);
            codex_cleanup_warnings.push(warning);
        }
    }

    emit_switch_progress(app, plat.id(), "saving", "正在清除接管记录…");
    let _ = crate::commands::store_io::update_provider_store(|store| {
        let changed = store.platforms.remove(plat.id()).is_some();
        Ok((changed, ()))
    });

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    let mut message = "已切回 Codex 官方 OpenAI 配置，重启 Codex 后生效".to_string();
    message.push_str(&repair_codex_session_visibility_message(&path));
    append_switch_warnings(&mut message, &codex_cleanup_warnings);
    emit_switch_progress(app, plat.id(), "done", "已切回官方配置");
    Ok(SwitchResult {
        ok: true,
        message,
        config_path,
        backup_path: backup,
    })
}


pub(in crate::commands::platforms) fn repair_codex_session_visibility_message(path: &Path) -> String {
    match crate::commands::codex_session_visibility::repair_default_codex_session_visibility(path) {
        Ok(summary) => {
            // 没有改动时不追加冗余信息
            if summary.updated_sqlite_row_count == 0 {
                String::new()
            } else {
                format!("。{}", summary.message)
            }
        }
        Err(error) => format!(
            "。但恢复历史会话可见性失败：{}。配置已写入，可关闭 Codex 后重试切换",
            error
        ),
    }
}

impl Platform {

    pub(in crate::commands::platforms) fn apply_codex(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        self.apply_codex_with_stash(path, p, &agent_stash_dir())
    }


    /// 记账可注入版（测试用临时目录隔离；生产走 agent_stash_dir()）。
    pub(in crate::commands::platforms) fn apply_codex_with_stash(
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
        // toml_edit 保留式编辑：只改我们的字段，mcp_servers/desktop/projects 等原样保留。
        let mut doc = raw
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml 解析失败: {e}"))?;

        let base = if p.route_through_proxy {
            codex_base_url()
        } else {
            // 直连供应商：写供应商的 API 根路径（不写 localhost 网关地址）
            codex_direct_base_url(p)
        };
        let bearer = codex_provider_bearer(p)?;
        let model = p.default_model.trim();

        // 记账：apply 将覆盖/删除的顶层标量（original 幂等，总是执行）
        {
            let catalog_pointer = doc
                .get("model_catalog_json")
                .and_then(toml_item_string);
            let plans = vec![
                crate::commands::agent_stash::FieldPlan {
                    path: vec!["model".into()],
                    current: toml_top_current(&doc, "model"),
                    new: if model.is_empty() {
                        crate::commands::agent_stash::Stashed::Absent
                    } else {
                        crate::commands::agent_stash::Stashed::Str(model.to_string())
                    },
                },
                crate::commands::agent_stash::FieldPlan {
                    path: vec!["model_provider".into()],
                    current: toml_top_current(&doc, "model_provider"),
                    new: crate::commands::agent_stash::Stashed::Str(
                        CODEX_RUNTIME_MODEL_PROVIDER_ID.to_string(),
                    ),
                },
                crate::commands::agent_stash::FieldPlan {
                    path: vec!["service_tier".into()],
                    current: toml_top_current(&doc, "service_tier"),
                    // 第三方 API 不支持 service_tier，接入即删除
                    new: crate::commands::agent_stash::Stashed::Absent,
                },
                crate::commands::agent_stash::FieldPlan {
                    path: vec!["model_catalog_json".into()],
                    current: catalog_pointer
                        .map(crate::commands::agent_stash::Stashed::Str)
                        .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
                    new: if resolve_codex_model_catalog_entries(p).is_empty() {
                        crate::commands::agent_stash::Stashed::Absent
                    } else {
                        crate::commands::agent_stash::Stashed::Str(CODEX_MODEL_CATALOG_FILENAME.to_string())
                    },
                },
            ];
            if let Err(e) =
                crate::commands::agent_stash::record_apply(stash_dir, &codex_stash_key(), &plans)
            {
                eprintln!("[agent-stash] Codex 记账失败（不影响切换）: {e}");
            }
        }

        if !model.is_empty() {
            doc["model"] = value(model);
        }
        doc["model_provider"] = value(CODEX_RUNTIME_MODEL_PROVIDER_ID);

        // service_tier 是 OpenAI 官方专属字段（Pro/Fast 等计费层级），
        // 第三方 API 不支持此参数，残留会导致 Codex 请求被拒、无法对话。
        doc.as_table_mut().remove("service_tier");

        // 确保 [model_providers] 是表，再写入统一的 Codex local access 子表。
        let providers = doc
            .entry("model_providers")
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| "config.toml 的 model_providers 不是表".to_string())?;
        // 让 [model_providers] 表头在已有子表时不重复输出。
        providers.set_implicit(true);
        // 清理 AnyBridge 旧版 provider id，避免 byok/codex_local_access 并存导致历史过滤混乱。
        providers.remove(CODEX_LEGACY_MODEL_PROVIDER_ID);

        let provider_table = providers
            .entry(CODEX_RUNTIME_MODEL_PROVIDER_ID)
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| {
                format!("config.toml 的 model_providers.{CODEX_RUNTIME_MODEL_PROVIDER_ID} 不是表")
            })?;
        provider_table["name"] = value(p.name.clone());
        provider_table["base_url"] = value(base);
        // wire_api 恒为 "responses"：openai/codex 已删除 `WireApi::Chat`，
        // 写 "chat" 会让 Codex 反序列化 config.toml 失败、启动即崩
        // （错误提示指向 openai/codex discussions/7782）。
        // 因此只支持 Chat Completions 的上游必须走网关模式，由本地网关按
        // provider 的 wireApi 做 Responses→Chat 转换 —— 那是内部字段，不写进这里。
        provider_table["wire_api"] = value("responses");
        // Auth 互斥（官方文档 / openai/codex#16288）：
        // - OpenAI OAuth：requires_openai_auth=true，禁止 experimental_bearer_token / env_key / .auth
        // - 第三方静态凭证：requires_openai_auth=false + experimental_bearer_token（或 env_key）
        // 残留冲突会导致 Codex 读 auth.json.refresh_token，apikey 模式下 refresh_token 为空。
        apply_codex_provider_auth(provider_table, p.preserve_official_auth, bearer.as_deref());
        provider_table[CODEX_ANYBRIDGE_MANAGED_FLAG] = value(true);

        // ── Codex 原生重试配置：从 model-map.json enhancement 读取 ──
        let enhancement = crate::commands::model_map::read_map()
            .map(|m| m.enhancement)
            .unwrap_or_default();
        provider_table["request_max_retries"] = value(enhancement.codex_request_max_retries as i64);
        provider_table["stream_max_retries"] = value(enhancement.codex_stream_max_retries as i64);

        // ── 模型目录：让 Codex 显示自定义模型列表 ──
        // catalog 目录必须与 config.toml 同目录；禁止回退到进程 CWD。
        let catalog_dir = path.parent().ok_or_else(|| {
            format!(
                "无法定位 Codex 配置目录（config 路径异常）: {}",
                path.display()
            )
        })?;
        let catalog_entries = resolve_codex_model_catalog_entries(p);
        if !catalog_entries.is_empty() {
            let catalog_json = generate_model_catalog_json(&catalog_entries)?;
            let catalog_path = catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME);
            crate::commands::write_atomic(&catalog_path, catalog_json.as_bytes())?;
            doc["model_catalog_json"] = value(CODEX_MODEL_CATALOG_FILENAME);
        } else {
            doc.as_table_mut().remove("model_catalog_json");
            let _ = fs::remove_file(catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME));
        }

        let agents_finalize = apply_codex_agents(path, &mut doc, p)?;

        crate::commands::write_atomic(path, doc.to_string().as_bytes())?;
        finalize_codex_agents_files(path, agents_finalize)
    }


    pub(in crate::commands::platforms) fn apply_codex_official(
        &self,
        path: &PathBuf,
        unify_session_history: bool,
    ) -> Result<(), String> {
        apply_codex_official_with_stash(path, unify_session_history, &agent_stash_dir())
    }

}

