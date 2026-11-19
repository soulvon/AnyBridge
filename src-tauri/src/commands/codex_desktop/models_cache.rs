use crate::commands::config::{read_provider_store, ModelCatalogEntry};
use crate::commands::platforms::{
    catalog_entry_has_required_fields, codex_bundled_model_template,
    generate_model_catalog_json, is_codex_bundled_model, read_codex_model_template,
    resolve_codex_model_catalog_entries, CODEX_MODEL_CATALOG_FILENAME,
};
use std::collections::HashSet;
use std::path::PathBuf;
use super::*;
pub(super) fn current_codex_catalog_entries() -> Result<Vec<ModelCatalogEntry>, String> {
    let store = read_provider_store()?;
    let provider_id = store
        .platforms
        .get("codex")
        .map(|s| s.provider_id.clone())
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            "当前未绑定 Codex 供应商配置，无法生成模型目录。请先在「更多平台」切换一次 Codex。"
                .to_string()
        })?;
    let config = store
        .codex_configs
        .iter()
        .find(|c| c.id == provider_id)
        .ok_or_else(|| format!("Codex 配置不存在: {provider_id}"))?;
    config.validate_active_source(&store.providers)?;
    let provider = config.resolve_provider(&store.providers);
    let entries = resolve_codex_model_catalog_entries(&provider);
    if entries.is_empty() {
        return Err(format!(
            "Codex 配置「{}」未提供可用模型（modelCatalog / models / defaultModel 均为空）",
            provider.name
        ));
    }
    Ok(entries)
}

/// 确保 `anybridge-model-catalog.json` 存在；缺失或空时从 provider store 重建。
pub(super) fn ensure_anybridge_catalog_file(dir: &std::path::Path) -> Result<PathBuf, String> {
    let catalog_file = dir.join(CODEX_MODEL_CATALOG_FILENAME);
    let needs_rebuild = match std::fs::read_to_string(&catalog_file) {
        Ok(raw) => {
            let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok();
            match parsed.as_ref().and_then(catalog_models_array) {
                Some(arr) => {
                    // 旧版 AnyBridge 生成的 catalog 可能缺 base_instructions 等
                    // Codex 0.146+ 必填字段，这类文件会让 `codex` 启动直接报
                    // `missing field`，必须重建，不能继续沿用。
                    arr.is_empty()
                        || !arr.iter().any(|m| extract_model_slug(m).is_some())
                        || arr.iter().any(|m| !catalog_entry_has_required_fields(m))
                }
                None => true,
            }
        }
        Err(_) => true,
    };
    if needs_rebuild {
        let entries = current_codex_catalog_entries()?;
        let catalog_json = generate_model_catalog_json(&entries)?;
        std::fs::create_dir_all(dir).map_err(|e| {
            format!("创建 Codex 配置目录失败 ({}): {e}", dir.display())
        })?;
        crate::commands::write_atomic(&catalog_file, catalog_json.as_bytes())?;
    }
    Ok(catalog_file)
}

/// 读取 AnyBridge catalog（缺失时从当前 Codex 配置重建），
/// 提取需要注入到 models_cache.json 的模型列表。
pub(super) fn read_anybridge_catalog_models() -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位 Codex 配置目录（CODEX_HOME / ~/.codex）".to_string());
    };
    let catalog_file = ensure_anybridge_catalog_file(&dir)?;
    let raw = std::fs::read_to_string(&catalog_file)
        .map_err(|e| format!("读取 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let models: Vec<serde_json::Value> = catalog_models_array(&parsed)
        .map(|a| {
            a.iter()
                .filter(|m| extract_model_slug(m).is_some())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err(format!(
            "Codex 模型目录没有可注入模型: {}",
            catalog_file.display()
        ));
    }
    Ok(models)
}

pub(super) fn catalog_models_array(parsed: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    if parsed.is_array() {
        parsed.as_array()
    } else {
        parsed.get("models").and_then(|m| m.as_array())
    }
}

pub(super) fn extract_model_slug(model: &serde_json::Value) -> Option<String> {
    model
        .get("slug")
        .and_then(|s| s.as_str())
        .or_else(|| model.get("model").and_then(|s| s.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

pub(super) fn read_anybridge_catalog_slugs_if_present() -> Result<HashSet<String>, String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位用户主目录".to_string());
    };
    let catalog_file = dir.join("anybridge-model-catalog.json");
    if !catalog_file.exists() {
        return Ok(HashSet::new());
    }
    let raw = std::fs::read_to_string(&catalog_file)
        .map_err(|e| format!("读取 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let models = catalog_models_array(&parsed)
        .ok_or_else(|| format!("Codex 模型目录缺少 models 数组: {}", catalog_file.display()))?;
    Ok(models.iter().filter_map(extract_model_slug).collect())
}

/// models_cache.json 不存在时返回 Err（不静默退化，debug-first 原则）。
/// 实际数据来自 read_codex_model_template() 复用官方 gpt-5.5 模板。
pub(super) fn empty_models_cache() -> serde_json::Value {
    serde_json::json!({
        "fetched_at": "",
        "etag": "",
        "models": []
    })
}

/// 把 AnyBridge catalog 中的自定义模型注入 ~/.codex/models_cache.json。
///
/// 治本方案：复用 `platforms::read_codex_model_template()` 拿到的官方 gpt-5.5
/// 完整条目作为模板，对每个自定义模型做 deep-clone 后只覆盖 6 个字段
/// （slug / display_name / description / context_window / max_context_window /
/// 其它全从官方模板继承，包含 base_instructions / model_messages / comp_hash
/// / input_modalities 等 26+ 字段），保证 Codex Desktop 启动时不会因字段
/// 不全而丢弃注入项。
///
/// 幂等 + 防污染：先删除旧的 AnyBridge 注入项（按 `anybridge_managed` 标记，
/// 兼容清理旧版 `anybridge:` 前缀残留，以及命中本次注入集合的同名条目——
/// 后者用于清掉历史上 JS `prePatchModelsCache` 写入的无前缀残留），再插入。
/// slug 保持原始模型名（不加前缀），保证与 catalog / proxy-routes / CDP 注入一致。
pub(super) fn write_models_cache() -> Result<(), String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位用户主目录".to_string());
    };
    let cache_path = dir.join("models_cache.json");
    let models = read_anybridge_catalog_models()?;

    // 读取现有 cache（不存在用空结构，fetched_at/etag 后续按需补）
    let raw = std::fs::read_to_string(&cache_path).unwrap_or_default();
    let mut cache: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| empty_models_cache());
    if !cache.is_object() {
        cache = empty_models_cache();
    }

    // 确保 cache.models 是数组
    let root = cache
        .as_object_mut()
        .expect("cache root must be an object");
    if !root.get("models").map(|m| m.is_array()).unwrap_or(false) {
        root.insert("models".to_string(), serde_json::json!([]));
    }
    let arr = root
        .get_mut("models")
        .and_then(|m| m.as_array_mut())
        .expect("cache.models must be an array");

    // 模板优先级：
    //   1) platforms::read_codex_model_template()
    //      — models_cache 官方条目优先，缺失时回退内嵌 gpt-5.5
    //   2) 当前 cache 中第一个非 AnyBridge 注入的条目
    let template = read_codex_model_template().or_else(|| {
        arr.iter()
            .find(|m| {
                // 排除我们自己的注入项（标记 / 旧前缀残留），只挑真正的官方条目做模板
                if m.get(ANYBRIDGE_MANAGED_FLAG)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    return false;
                }
                let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
                !slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX) && !slug.is_empty()
            })
            .cloned()
    });

    let template = template.ok_or_else(|| {
        format!(
            "无法解析 Codex 模型模板：{} 与内嵌 gpt-5.5 均不可用。",
            cache_path.display()
        )
    })?;

    // 本次要注入的原始 slug 集合（用于清掉 JS prePatchModelsCache 历史写入的同名无前缀残留）。
    let inject_slugs: std::collections::HashSet<String> = models
        .iter()
        .filter_map(|m| {
            m.get("slug")
                .and_then(|s| s.as_str())
                .or_else(|| m.get("model").and_then(|s| s.as_str()))
                .map(|s| s.to_string())
        })
        .collect();

    // 移除旧的 AnyBridge 注入项：
    //   1) 带 anybridge_managed 标记（当前方案）
    //   2) slug 以 "anybridge:" 开头（旧前缀方案残留，兼容清理）
    //   3) slug 命中本次注入集合（JS prePatchModelsCache 历史写入的同名无前缀条目）
    arr.retain(|m| {
        if m.get(ANYBRIDGE_MANAGED_FLAG)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return false;
        }
        let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
        if slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX) {
            return false;
        }
        !inject_slugs.contains(slug)
    });

    // 注入每个自定义模型
    for (i, entry) in models.iter().enumerate() {
        let slug = entry
            .get("slug")
            .and_then(|s| s.as_str())
            .or_else(|| entry.get("model").and_then(|s| s.as_str()))
            .unwrap_or("")
            .to_string();
        if slug.is_empty() {
            continue;
        }
        let display = entry
            .get("display_name")
            .and_then(|s| s.as_str())
            .unwrap_or(&slug)
            .to_string();

        let mut model_obj = if is_codex_bundled_model(&slug) {
            // ── 新版逻辑：使用 bundled catalog 完整定义 ──
            let (mut model, _) = codex_bundled_model_template(&slug);
            let obj = model
                .as_object_mut()
                .expect("Bundled model template should be a JSON object");
            obj["priority"] = serde_json::json!(1000 + i);
            if !display.is_empty() && display != slug {
                obj["display_name"] = serde_json::json!(display);
            }
            if let Some(ctx_val) = entry.get("context_window").and_then(|c| c.as_u64()) {
                obj["context_window"] = serde_json::json!(ctx_val);
                obj["max_context_window"] = serde_json::json!(ctx_val);
            }
            obj.insert("supported_in_api".to_string(), serde_json::Value::Bool(true));
            if !obj.contains_key("visibility") {
                obj.insert("visibility".to_string(), serde_json::Value::String("list".to_string()));
            }
            model
        } else {
            // ── 旧版逻辑：从 models_cache.json 的 gpt-5.5 模板 deep-clone ──
            let ctx_default = template
                .get("context_window")
                .and_then(|c| c.as_u64())
                .unwrap_or(128000);
            let ctx = entry
                .get("context_window")
                .and_then(|c| c.as_u64())
                .unwrap_or(ctx_default);
            let mut obj = template.clone();
            obj["slug"] = serde_json::json!(slug);
            obj["display_name"] = serde_json::json!(display);
            obj["description"] = serde_json::json!(display);
            obj["context_window"] = serde_json::json!(ctx);
            obj["max_context_window"] = serde_json::json!(ctx);
            obj["priority"] = serde_json::json!(1000 + i);
            obj
        };

        // slug 必须与 anybridge-model-catalog.json / proxy-routes / CDP 注入完全一致
        // （原始模型名，不加任何前缀）。否则用户在 Desktop 选中后，Codex 发给本地网关的
        // model 名对不上路由表，resolveProxyModel 直接报"模型不在内置模型列表中"。
        // 幂等清理改用独立标记字段 anybridge_managed（Codex 读 models_cache 时忽略未知字段，已验证）。
        model_obj["slug"] = serde_json::json!(slug);
        model_obj[ANYBRIDGE_MANAGED_FLAG] = serde_json::json!(true);
        arr.push(model_obj);
    }

    let out = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&cache_path, out.as_bytes())
}

/// 清理 ~/.codex/models_cache.json 中的 AnyBridge 注入项（切回官方用）。
pub(crate) fn clean_models_cache() -> Result<(), String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位用户主目录".to_string());
    };
    let cache_path = dir.join("models_cache.json");
    let Ok(raw) = std::fs::read_to_string(&cache_path) else {
        return Ok(()); // 不存在，无需清理
    };
    let mut cache = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 Codex 模型缓存失败 ({}): {e}", cache_path.display()))?;
    let catalog_slugs = read_anybridge_catalog_slugs_if_present()?;
    let arr = cache
        .get_mut("models")
        .and_then(|m| m.as_array_mut())
        .ok_or_else(|| format!("Codex 模型缓存缺少 models 数组: {}", cache_path.display()))?;
    let before = arr.len();
    arr.retain(|m| {
        if m.get(ANYBRIDGE_MANAGED_FLAG)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return false;
        }
        let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
        if slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX) {
            return false;
        }
        !catalog_slugs.contains(slug)
    });
    if arr.len() != before {
        let out = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
        crate::commands::write_atomic(&cache_path, out.as_bytes())?;
    }
    Ok(())
}

// ─── 通过 sidecar 注入 CDP 补丁 ────────────────────────────────────────
