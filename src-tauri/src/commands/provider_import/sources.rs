use crate::commands::config::{ApiFormat, ModelCaps};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use super::*;
pub(super) fn scan_cc_switch(candidates: &mut Vec<ImportProviderCandidate>, notices: &mut Vec<String>) {
    let Some(default_path) = dirs::home_dir().map(|p| p.join(".cc-switch").join("cc-switch.db"))
    else {
        notices.push("CC Switch：未找到用户目录".to_string());
        return;
    };

    let mut paths = vec![default_path];
    if let Some(data) = dirs::data_dir() {
        paths.push(data.join("cc-switch").join("cc-switch.db"));
        paths.push(data.join("CC Switch").join("cc-switch.db"));
    }
    if let Some(local) = dirs::data_local_dir() {
        paths.push(local.join("cc-switch").join("cc-switch.db"));
        paths.push(local.join("CC Switch").join("cc-switch.db"));
    }
    add_named_file_matches(&mut paths, "cc-switch.db", 4, 20);

    let paths = existing_unique_paths(paths);
    if paths.is_empty() {
        notices.push("CC Switch：未发现 ~/.cc-switch/cc-switch.db".to_string());
        return;
    };

    let before = candidates.len();
    for path in paths {
        scan_cc_switch_db(&path, candidates, notices);
    }

    let found = candidates.len() - before;
    if found == 0 {
        notices.push("CC Switch：已找到数据库，但没有可直接导入的 Claude/Codex 供应商".to_string());
    }
}

pub(super) fn scan_cc_switch_db(
    path: &Path,
    candidates: &mut Vec<ImportProviderCandidate>,
    notices: &mut Vec<String>,
) {
    let conn = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => conn,
        Err(e) => {
            notices.push(format!("CC Switch：{} 打开失败：{}", path.display(), e));
            return;
        }
    };

    let endpoints = load_cc_switch_endpoints(&conn);
    let mut stmt = match conn.prepare(
        "SELECT id, app_type, name, settings_config FROM providers \
         WHERE app_type IN ('claude', 'codex') ORDER BY app_type, sort_index, name",
    ) {
        Ok(stmt) => stmt,
        Err(e) => {
            notices.push(format!(
                "CC Switch：读取 {} 的 providers 表失败：{}",
                path.display(),
                e
            ));
            return;
        }
    };

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(e) => {
            notices.push(format!(
                "CC Switch：查询 {} 的 providers 表失败：{}",
                path.display(),
                e
            ));
            return;
        }
    };

    for row in rows {
        let Ok((provider_id, app_type, name, settings_config)) = row else {
            continue;
        };
        let settings: Value = match serde_json::from_str(&settings_config) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let source_id = format!("cc-switch:{}:{}", app_type, provider_id);
        let source_path = path.display().to_string();
        let endpoint_urls = endpoints
            .get(&(provider_id.clone(), app_type.clone()))
            .cloned()
            .unwrap_or_default();

        match app_type.as_str() {
            "claude" => add_cc_switch_claude(
                candidates,
                &settings,
                &endpoint_urls,
                &name,
                &source_id,
                &source_path,
            ),
            "codex" => add_cc_switch_codex(
                candidates,
                &settings,
                &endpoint_urls,
                &name,
                &source_id,
                &source_path,
            ),
            _ => {}
        }
    }
}

pub(super) fn add_cc_switch_claude(
    candidates: &mut Vec<ImportProviderCandidate>,
    settings: &Value,
    endpoint_urls: &[String],
    name: &str,
    source_id: &str,
    source_path: &str,
) {
    let env = settings.get("env").unwrap_or(settings);
    let key = string_value(env, "ANTHROPIC_AUTH_TOKEN")
        .or_else(|| string_value(env, "ANTHROPIC_API_KEY"));
    let Some(api_key) = key else {
        return;
    };
    let base = string_value(env, "ANTHROPIC_BASE_URL").or_else(|| endpoint_urls.first().cloned());
    let Some(base_url) = base else {
        return;
    };

    let mut models = Vec::new();
    for key in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_REASONING_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        push_string_value(&mut models, env, key);
    }
    if let Some(model) = string_value(settings, "model") {
        models.push(model);
    }

    let (api_host, api_path) = normalize_endpoint(&base_url, &ApiFormat::Anthropic, None);
    let mut candidate = ImportProviderCandidate {
        id: String::new(),
        source: "CC Switch".to_string(),
        source_id: source_id.to_string(),
        source_path: source_path.to_string(),
        name: name.to_string(),
        api_host,
        api_key,
        api_path,
        default_model: models.first().cloned().unwrap_or_default(),
        api_format: ApiFormat::Anthropic,
        enabled: true,
        models,
        capabilities: import_caps(false, false, false),
        model_caps: HashMap::new(),
        warnings: Vec::new(),
    };
    finalize_candidate(&mut candidate);
    candidates.push(candidate);
}

pub(super) fn add_cc_switch_codex(
    candidates: &mut Vec<ImportProviderCandidate>,
    settings: &Value,
    endpoint_urls: &[String],
    name: &str,
    source_id: &str,
    source_path: &str,
) {
    let config = settings
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let auth = settings.get("auth").unwrap_or(&Value::Null);
    let api_key = string_value(auth, "OPENAI_API_KEY")
        .or_else(|| toml_string_value(config, "experimental_bearer_token"))
        .or_else(|| toml_string_value(config, "OPENAI_API_KEY"));
    let Some(api_key) = api_key else {
        return;
    };

    let model = toml_string_value(config, "model").unwrap_or_else(|| "gpt-5".to_string());
    let provider_name = toml_string_value(config, "model_provider").unwrap_or_default();
    let (base_url, wire_api) = if provider_name == "openai" {
        (
            "https://api.openai.com".to_string(),
            Some("responses".to_string()),
        )
    } else {
        let section = if provider_name.is_empty() {
            None
        } else {
            Some(format!("model_providers.{}", provider_name))
        };
        let base = section
            .as_deref()
            .and_then(|s| toml_section_string_value(config, s, "base_url"))
            .or_else(|| toml_string_value(config, "base_url"))
            .or_else(|| endpoint_urls.first().cloned())
            .unwrap_or_else(|| "https://api.openai.com".to_string());
        let wire = section
            .as_deref()
            .and_then(|s| toml_section_string_value(config, s, "wire_api"))
            .or_else(|| toml_string_value(config, "wire_api"))
            .or_else(|| {
                if base.to_lowercase().contains("/responses") {
                    Some("responses".to_string())
                } else {
                    None
                }
            });
        (base, wire)
    };

    let (api_host, api_path) =
        normalize_endpoint(&base_url, &ApiFormat::Openai, wire_api.as_deref());
    let mut candidate = ImportProviderCandidate {
        id: String::new(),
        source: "CC Switch".to_string(),
        source_id: source_id.to_string(),
        source_path: source_path.to_string(),
        name: name.to_string(),
        api_host,
        api_key,
        api_path,
        default_model: model.clone(),
        api_format: ApiFormat::Openai,
        enabled: true,
        models: vec![model],
        capabilities: import_caps(false, false, false),
        model_caps: HashMap::new(),
        warnings: Vec::new(),
    };
    finalize_candidate(&mut candidate);
    candidates.push(candidate);
}

pub(super) fn load_cc_switch_endpoints(conn: &Connection) -> HashMap<(String, String), Vec<String>> {
    let mut map: HashMap<(String, String), Vec<String>> = HashMap::new();
    let Ok(mut stmt) =
        conn.prepare("SELECT provider_id, app_type, url FROM provider_endpoints ORDER BY id")
    else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return map;
    };
    for row in rows.flatten() {
        let (provider_id, app_type, url) = row;
        map.entry((provider_id, app_type)).or_default().push(url);
    }
    map
}

pub(super) fn scan_cockpit_tools(candidates: &mut Vec<ImportProviderCandidate>, notices: &mut Vec<String>) {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(
            home.join(".antigravity_cockpit")
                .join("codex_model_providers.json"),
        );
    }
    if let Some(data) = dirs::data_dir() {
        paths.push(
            data.join(".antigravity_cockpit")
                .join("codex_model_providers.json"),
        );
    }
    if let Some(local) = dirs::data_local_dir() {
        paths.push(
            local
                .join("cockpit-tools")
                .join("codex_model_providers.json"),
        );
        paths.push(
            local
                .join("Cockpit Tools")
                .join("codex_model_providers.json"),
        );
    }
    add_named_file_matches(&mut paths, "codex_model_providers.json", 5, 30);

    let paths = existing_unique_paths(paths);
    if paths.is_empty() {
        notices.push("Cockpit Tools：未发现 codex_model_providers.json".to_string());
        return;
    }

    let before = candidates.len();
    for path in paths {
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) => {
                notices.push(format!(
                    "Cockpit Tools：读取 {} 失败：{}",
                    path.display(),
                    e
                ));
                continue;
            }
        };
        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(e) => {
                notices.push(format!(
                    "Cockpit Tools：解析 {} 失败：{}",
                    path.display(),
                    e
                ));
                continue;
            }
        };
        let Some(items) = parsed.as_array() else {
            notices.push(format!("Cockpit Tools：{} 不是供应商数组", path.display()));
            continue;
        };

        for (idx, item) in items.iter().enumerate() {
            let name = string_value(item, "name").unwrap_or_else(|| format!("Cockpit {}", idx + 1));
            let Some(base_url) = string_value(item, "baseUrl") else {
                continue;
            };
            let wire_api = string_value(item, "wireApi");
            let supports_vision = item
                .get("supportsVision")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let model = string_value(item, "model").unwrap_or_default();
            let mut keys = api_key_entries(item.get("apiKeys").unwrap_or(&Value::Null));
            if keys.is_empty() {
                if let Some(key) = string_value(item, "apiKeyUrl") {
                    keys.push(("默认密钥".to_string(), key));
                }
            }

            for (key_idx, (key_label, api_key)) in keys.into_iter().enumerate() {
                if api_key.trim().is_empty() {
                    continue;
                }
                let (api_host, api_path) =
                    normalize_endpoint(&base_url, &ApiFormat::Openai, wire_api.as_deref());
                let source_raw_id = string_value(item, "id").unwrap_or_else(|| idx.to_string());
                let display_name = if key_idx == 0 {
                    name.clone()
                } else {
                    format!("{} - {}", name, key_label)
                };
                let mut candidate = ImportProviderCandidate {
                    id: String::new(),
                    source: "Cockpit Tools".to_string(),
                    source_id: format!("cockpit:{}:{}", source_raw_id, key_idx),
                    source_path: path.display().to_string(),
                    name: display_name,
                    api_host,
                    api_key,
                    api_path,
                    default_model: model.clone(),
                    api_format: ApiFormat::Openai,
                    enabled: true,
                    models: if model.trim().is_empty() {
                        Vec::new()
                    } else {
                        vec![model.clone()]
                    },
                    capabilities: import_caps(supports_vision, false, false),
                    model_caps: HashMap::new(),
                    warnings: Vec::new(),
                };
                finalize_candidate(&mut candidate);
                candidates.push(candidate);
            }
        }
    }

    let found = candidates.len() - before;
    if found == 0 {
        notices.push("Cockpit Tools：已找到配置文件，但没有可直接导入的 Codex 供应商".to_string());
    }
}

pub(super) fn scan_cherry_studio(candidates: &mut Vec<ImportProviderCandidate>, notices: &mut Vec<String>) {
    let mut paths = Vec::new();
    if let Some(data) = dirs::data_dir() {
        paths.push(data.join("CherryStudio").join("cherrystudio.sqlite"));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".cherrystudio").join("cherrystudio.sqlite"));
    }
    if let Some(local) = dirs::data_local_dir() {
        paths.push(local.join("CherryStudio").join("cherrystudio.sqlite"));
    }
    add_named_file_matches(&mut paths, "cherrystudio.sqlite", 5, 30);

    let paths = existing_unique_paths(paths);
    let before = candidates.len();
    for path in &paths {
        scan_cherry_sqlite(&path, candidates, notices);
    }

    let local_storage_paths = cherry_local_storage_leveldb_paths();
    for path in &local_storage_paths {
        scan_cherry_local_storage(path, candidates, notices);
    }

    let found = candidates.len() - before;
    if found == 0 {
        if paths.is_empty() && local_storage_paths.is_empty() {
            notices.push(
                "Cherry Studio：未发现 cherrystudio.sqlite 或 Local Storage/leveldb".to_string(),
            );
        } else {
            notices.push("Cherry Studio：已找到本地数据，但没有可直接导入的供应商".to_string());
        }
    }
}

pub(super) fn scan_cherry_sqlite(
    path: &Path,
    candidates: &mut Vec<ImportProviderCandidate>,
    notices: &mut Vec<String>,
) {
    let conn = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => conn,
        Err(e) => {
            notices.push(format!("Cherry Studio：数据库打开失败：{}", e));
            return;
        }
    };

    let Ok(has_provider_table) = table_exists(&conn, "user_provider") else {
        notices.push("Cherry Studio：检查 user_provider 表失败".to_string());
        return;
    };
    if !has_provider_table {
        notices.push("Cherry Studio：数据库内没有 user_provider 表".to_string());
        return;
    }

    let model_map = load_cherry_models(&conn);
    let mut stmt = match conn.prepare(
        r#"SELECT "providerId", "presetProviderId", "name", "endpoint_configs",
                  "defaultChatEndpoint", "apiKeys", "api_features", "isEnabled"
           FROM user_provider"#,
    ) {
        Ok(stmt) => stmt,
        Err(e) => {
            notices.push(format!("Cherry Studio：读取 user_provider 失败：{}", e));
            return;
        }
    };

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, i64>(7).unwrap_or(1),
        ))
    }) {
        Ok(rows) => rows,
        Err(e) => {
            notices.push(format!("Cherry Studio：查询 user_provider 失败：{}", e));
            return;
        }
    };

    for row in rows.flatten() {
        let (
            provider_id,
            preset_provider_id,
            name,
            endpoint_configs_raw,
            default_chat_endpoint,
            api_keys_raw,
            api_features_raw,
            is_enabled,
        ) = row;
        if is_enabled == 0 {
            continue;
        }
        let endpoint_configs = parse_json_optional(endpoint_configs_raw.as_deref());
        let Some(base_url) =
            cherry_endpoint_url(&endpoint_configs, default_chat_endpoint.as_deref())
        else {
            continue;
        };
        let keys = api_key_entries(&parse_json_optional(api_keys_raw.as_deref()));
        if keys.is_empty() {
            continue;
        }

        let provider_hint = format!(
            "{} {} {}",
            provider_id,
            preset_provider_id.clone().unwrap_or_default(),
            name
        )
        .to_lowercase();
        let api_format = if provider_hint.contains("anthropic") || provider_hint.contains("claude")
        {
            ApiFormat::Anthropic
        } else {
            ApiFormat::Openai
        };
        let wire_api = if recursive_string_contains(&endpoint_configs, "responses")
            || recursive_string_contains(
                &parse_json_optional(api_features_raw.as_deref()),
                "responses",
            ) {
            Some("responses")
        } else {
            None
        };
        let (api_host, api_path) = normalize_endpoint(&base_url, &api_format, wire_api);

        let imported_models = model_map.get(&provider_id).cloned().unwrap_or_default();
        let models: Vec<String> = imported_models.iter().map(|m| m.model_id.clone()).collect();
        let vision = imported_models.iter().any(|m| m.vision);
        let tools = imported_models.iter().any(|m| m.tools);
        let mut model_caps = HashMap::new();
        for model in &imported_models {
            if model.vision || model.tools {
                model_caps.insert(
                    model.model_id.clone(),
                    ModelCaps {
                        vision: model.vision,
                        tools: model.tools,
                    },
                );
            }
        }

        for (key_idx, (key_label, api_key)) in keys.into_iter().enumerate() {
            let display_name = if key_idx == 0 {
                name.clone()
            } else {
                format!("{} - {}", name, key_label)
            };
            let mut candidate = ImportProviderCandidate {
                id: String::new(),
                source: "Cherry Studio".to_string(),
                source_id: format!("cherry:{}:{}", provider_id, key_idx),
                source_path: path.display().to_string(),
                name: display_name,
                api_host: api_host.clone(),
                api_key,
                api_path: api_path.clone(),
                default_model: models.first().cloned().unwrap_or_default(),
                api_format: api_format.clone(),
                enabled: true,
                models: models.clone(),
                capabilities: import_caps(vision, tools, false),
                model_caps: model_caps.clone(),
                warnings: Vec::new(),
            };
            finalize_candidate(&mut candidate);
            candidates.push(candidate);
        }
    }
}

pub(super) fn cherry_local_storage_leveldb_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(data) = dirs::data_dir() {
        paths.push(
            data.join("CherryStudio")
                .join("Local Storage")
                .join("leveldb"),
        );
    }
    if let Some(local) = dirs::data_local_dir() {
        paths.push(
            local
                .join("CherryStudio")
                .join("Local Storage")
                .join("leveldb"),
        );
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(
            home.join(".cherrystudio")
                .join("Local Storage")
                .join("leveldb"),
        );
    }
    existing_unique_dirs(paths)
}

pub(super) fn scan_cherry_local_storage(
    leveldb_dir: &Path,
    candidates: &mut Vec<ImportProviderCandidate>,
    notices: &mut Vec<String>,
) {
    let mut files = match fs::read_dir(leveldb_dir) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("log") || ext.eq_ignore_ascii_case("ldb"))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>(),
        Err(e) => {
            notices.push(format!("Cherry Studio：读取 Local Storage 目录失败：{}", e));
            return;
        }
    };
    files.sort();

    let mut latest: Option<(PathBuf, Value)> = None;
    for path in files {
        match fs::read(&path) {
            Ok(bytes) => {
                let roots = match path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.to_ascii_lowercase())
                    .as_deref()
                {
                    Some("ldb") => cherry_persist_roots_from_leveldb_table(&bytes),
                    _ => cherry_persist_roots_from_leveldb_log(&bytes),
                };
                for root in roots {
                    latest = Some((path.clone(), root));
                }
            }
            Err(e) => notices.push(format!(
                "Cherry Studio：读取 Local Storage 文件 {} 失败：{}",
                path.display(),
                e
            )),
        }
    }

    if let Some((source_path, root)) = latest {
        scan_cherry_persisted_root(&source_path, &root, candidates);
    }
}

