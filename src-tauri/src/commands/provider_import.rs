use super::config::{
    read_provider_store, write_provider_store, ApiFormat, ModelCaps, Provider,
    ProviderCapabilities, ProviderStore,
};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProviderCandidate {
    pub id: String,
    pub source: String,
    pub source_id: String,
    pub source_path: String,
    pub name: String,
    pub api_host: String,
    pub api_key: String,
    pub api_path: Option<String>,
    pub default_model: String,
    pub api_format: ApiFormat,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
    #[serde(rename = "modelCaps", default)]
    pub model_caps: HashMap<String, ModelCaps>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanResult {
    pub candidates: Vec<ImportProviderCandidate>,
    pub notices: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProvidersResult {
    pub imported: usize,
    pub skipped: usize,
    pub store: ProviderStore,
    pub messages: Vec<String>,
}

#[tauri::command]
pub fn scan_importable_providers(sources: Option<Vec<String>>) -> Result<ImportScanResult, String> {
    let mut candidates = Vec::new();
    let mut notices = Vec::new();
    let selected_sources = selected_import_sources(sources);

    if selected_sources.contains("cc-switch") {
        scan_cc_switch(&mut candidates, &mut notices);
    }
    if selected_sources.contains("cockpit-tools") {
        scan_cockpit_tools(&mut candidates, &mut notices);
    }
    if selected_sources.contains("cherry-studio") {
        scan_cherry_studio(&mut candidates, &mut notices);
    }

    let mut seen = HashSet::new();
    candidates.retain(|c| seen.insert(candidate_signature(c)));
    candidates.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.api_host.cmp(&b.api_host))
    });

    Ok(ImportScanResult {
        candidates,
        notices,
    })
}

fn selected_import_sources(sources: Option<Vec<String>>) -> HashSet<String> {
    const ALL: [&str; 3] = ["cc-switch", "cockpit-tools", "cherry-studio"];
    let selected: HashSet<String> = sources
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| ALL.contains(&s.as_str()))
        .collect();
    if selected.is_empty() {
        ALL.into_iter().map(str::to_string).collect()
    } else {
        selected
    }
}

#[tauri::command]
pub fn import_providers(
    candidates: Vec<ImportProviderCandidate>,
) -> Result<ImportProvidersResult, String> {
    let mut store = read_provider_store()?;
    let mut imported = 0;
    let mut skipped = 0;
    let mut messages = Vec::new();

    for candidate in candidates {
        if candidate.api_host.trim().is_empty() || candidate.api_key.trim().is_empty() {
            skipped += 1;
            messages.push(format!("跳过 {}：缺少 API 地址或密钥", candidate.name));
            continue;
        }
        if provider_exists(&store, &candidate) {
            skipped += 1;
            messages.push(format!(
                "跳过 {}：已存在相同地址和密钥的供应商",
                candidate.name
            ));
            continue;
        }

        let provider = Provider {
            id: unique_provider_id(&store, &candidate.id),
            name: unique_provider_name(&store, &candidate.name),
            api_host: candidate.api_host.trim_end_matches('/').to_string(),
            api_key: candidate.api_key,
            api_path: candidate.api_path.filter(|p| !p.trim().is_empty()),
            default_model: candidate.default_model,
            api_format: candidate.api_format,
            enabled: true,
            models: unique_strings(candidate.models),
            capabilities: normalize_caps(candidate.capabilities),
            model_caps: candidate.model_caps,
        };
        store.providers.push(provider);
        imported += 1;
    }

    write_provider_store(&store)?;

    Ok(ImportProvidersResult {
        imported,
        skipped,
        store,
        messages,
    })
}

fn scan_cc_switch(candidates: &mut Vec<ImportProviderCandidate>, notices: &mut Vec<String>) {
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

fn scan_cc_switch_db(
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

fn add_cc_switch_claude(
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

fn add_cc_switch_codex(
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

fn load_cc_switch_endpoints(conn: &Connection) -> HashMap<(String, String), Vec<String>> {
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

fn scan_cockpit_tools(candidates: &mut Vec<ImportProviderCandidate>, notices: &mut Vec<String>) {
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
            let model = string_value(item, "model").unwrap_or_else(|| "gpt-5".to_string());
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
                    models: vec![model.clone()],
                    capabilities: import_caps(supports_vision, false, false),
                    model_caps: HashMap::new(),
                    warnings: vec!["源配置未提供模型列表，默认模型可在导入后编辑".to_string()],
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

fn scan_cherry_studio(candidates: &mut Vec<ImportProviderCandidate>, notices: &mut Vec<String>) {
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
    if paths.is_empty() {
        notices.push(
            "Cherry Studio：未发现 cherrystudio.sqlite；当前安装可能仍使用旧版 IndexedDB，暂未自动解析"
                .to_string(),
        );
        return;
    }

    let before = candidates.len();
    for path in paths {
        scan_cherry_sqlite(&path, candidates, notices);
    }
    let found = candidates.len() - before;
    if found == 0 {
        notices.push("Cherry Studio：已找到数据库，但没有可直接导入的供应商".to_string());
    }
}

fn scan_cherry_sqlite(
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
        let mut models: Vec<String> = imported_models.iter().map(|m| m.model_id.clone()).collect();
        if models.is_empty() {
            models.push(match api_format {
                ApiFormat::Anthropic => "claude-sonnet-4-5".to_string(),
                ApiFormat::Openai => "gpt-5".to_string(),
            });
        }
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

#[derive(Debug, Clone)]
struct CherryModelInfo {
    model_id: String,
    vision: bool,
    tools: bool,
}

fn load_cherry_models(conn: &Connection) -> HashMap<String, Vec<CherryModelInfo>> {
    let mut map: HashMap<String, Vec<CherryModelInfo>> = HashMap::new();
    if table_exists(conn, "user_model").ok() != Some(true) {
        return map;
    }
    let Ok(mut stmt) = conn.prepare(
        r#"SELECT "providerId", "modelId", "capabilities", "inputModalities",
                  "endpointTypes", "supportsStreaming", "isEnabled", "isHidden"
           FROM user_model
           ORDER BY "order_key", "modelId""#,
    ) else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5).unwrap_or(1),
            row.get::<_, i64>(6).unwrap_or(1),
            row.get::<_, i64>(7).unwrap_or(0),
        ))
    }) else {
        return map;
    };

    for row in rows.flatten() {
        let (
            provider_id,
            model_id,
            capabilities_raw,
            input_modalities_raw,
            endpoint_types_raw,
            _supports_streaming,
            is_enabled,
            is_hidden,
        ) = row;
        if is_enabled == 0 || is_hidden != 0 || model_id.trim().is_empty() {
            continue;
        }
        let capabilities = parse_json_optional(capabilities_raw.as_deref());
        let input_modalities = parse_json_optional(input_modalities_raw.as_deref());
        let endpoint_types = parse_json_optional(endpoint_types_raw.as_deref());
        let vision = recursive_string_contains(&capabilities, "vision")
            || recursive_string_contains(&capabilities, "image")
            || recursive_string_contains(&input_modalities, "vision")
            || recursive_string_contains(&input_modalities, "image");
        let tools = recursive_string_contains(&capabilities, "tool")
            || recursive_string_contains(&capabilities, "function")
            || recursive_string_contains(&endpoint_types, "tool");
        map.entry(provider_id).or_default().push(CherryModelInfo {
            model_id,
            vision,
            tools,
        });
    }
    map
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn parse_json_optional(raw: Option<&str>) -> Value {
    raw.and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}

fn api_key_entries(value: &Value) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    match value {
        Value::Array(items) => {
            for (idx, item) in items.iter().enumerate() {
                if let Some(enabled) = item.get("isEnabled").and_then(Value::as_bool) {
                    if !enabled {
                        continue;
                    }
                }
                if let Some(key) = item.as_str().map(str::to_string).or_else(|| {
                    string_value(item, "apiKey")
                        .or_else(|| string_value(item, "key"))
                        .or_else(|| string_value(item, "value"))
                }) {
                    if key.trim().is_empty() {
                        continue;
                    }
                    let label = string_value(item, "name")
                        .or_else(|| string_value(item, "label"))
                        .unwrap_or_else(|| format!("密钥 {}", idx + 1));
                    entries.push((label, key));
                }
            }
        }
        Value::String(key) if !key.trim().is_empty() => {
            entries.push(("默认密钥".to_string(), key.clone()));
        }
        _ => {}
    }
    entries
}

fn cherry_endpoint_url(
    endpoint_configs: &Value,
    default_chat_endpoint: Option<&str>,
) -> Option<String> {
    if let (Some(default_key), Some(obj)) = (default_chat_endpoint, endpoint_configs.as_object()) {
        if let Some(value) = obj.get(default_key) {
            if let Some(url) = recursive_find_url(value) {
                return Some(url);
            }
        }
    }
    recursive_find_url(endpoint_configs)
}

fn recursive_find_url(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if looks_like_url(trimmed) {
                Some(trimmed.to_string())
            } else {
                None
            }
        }
        Value::Array(items) => items.iter().find_map(recursive_find_url),
        Value::Object(map) => {
            for key in [
                "baseUrl", "base_url", "apiHost", "api_host", "url", "endpoint",
            ] {
                if let Some(s) = map.get(key).and_then(Value::as_str) {
                    if looks_like_url(s) {
                        return Some(s.trim().to_string());
                    }
                }
            }
            map.values().find_map(recursive_find_url)
        }
        _ => None,
    }
}

fn looks_like_url(value: &str) -> bool {
    let v = value.trim().to_lowercase();
    v.starts_with("http://")
        || v.starts_with("https://")
        || v.starts_with("localhost:")
        || v.starts_with("127.0.0.1:")
        || v.starts_with("[::1]:")
}

fn recursive_string_contains(value: &Value, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    match value {
        Value::String(s) => s.to_lowercase().contains(&needle),
        Value::Array(items) => items.iter().any(|v| recursive_string_contains(v, &needle)),
        Value::Object(map) => map.iter().any(|(k, v)| {
            k.to_lowercase().contains(&needle) || recursive_string_contains(v, &needle)
        }),
        _ => false,
    }
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn push_string_value(out: &mut Vec<String>, value: &Value, key: &str) {
    if let Some(v) = string_value(value, key) {
        out.push(v);
    }
}

fn toml_string_value(config: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"(?m)^\s*{}\s*=\s*["']([^"']+)["']"#, regex::escape(key));
    Regex::new(&pattern)
        .ok()?
        .captures(config)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

fn toml_section_string_value(config: &str, section: &str, key: &str) -> Option<String> {
    let normalized_target = normalize_toml_section(section);
    let mut in_section = false;
    let mut body = String::new();

    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let current = trimmed.trim_start_matches('[').trim_end_matches(']');
            let normalized = normalize_toml_section(current);
            if in_section && normalized != normalized_target {
                break;
            }
            in_section = normalized == normalized_target;
            continue;
        }
        if in_section {
            body.push_str(line);
            body.push('\n');
        }
    }

    if body.is_empty() {
        None
    } else {
        toml_string_value(&body, key)
    }
}

fn normalize_toml_section(section: &str) -> String {
    section
        .split('.')
        .map(|part| part.trim().trim_matches('"').trim_matches('\''))
        .collect::<Vec<_>>()
        .join(".")
}

fn is_official_dashscope_host(host: &str) -> bool {
    let hostname = reqwest::Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            host.trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    matches!(
        hostname.as_str(),
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com"
    )
}

fn normalize_endpoint(
    base_url: &str,
    api_format: &ApiFormat,
    wire_api: Option<&str>,
) -> (String, Option<String>) {
    let mut raw = base_url.trim().trim_end_matches('/').to_string();
    if !raw.starts_with("http://") && !raw.starts_with("https://") {
        raw = format!("https://{}", raw);
    }

    if let Ok(url) = reqwest::Url::parse(&raw) {
        let host = match url.port() {
            Some(port) => format!(
                "{}://{}:{}",
                url.scheme(),
                url.host_str().unwrap_or_default(),
                port
            ),
            None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
        };
        let path = url.path().trim_end_matches('/').to_string();
        let lower_path = path.to_lowercase();
        let is_responses = wire_api
            .map(|v| v.eq_ignore_ascii_case("responses"))
            .unwrap_or_else(|| lower_path.contains("/responses"));

        let api_path = match api_format {
            ApiFormat::Anthropic => {
                if lower_path.is_empty() || lower_path == "/" {
                    "/v1/messages".to_string()
                } else if lower_path.ends_with("/messages") {
                    path
                } else if lower_path.ends_with("/v1") {
                    format!("{}/messages", path)
                } else {
                    format!("{}/v1/messages", path)
                }
            }
            ApiFormat::Openai => {
                if is_official_dashscope_host(&host) {
                    if lower_path.ends_with("/compatible-mode/v1/responses")
                        || lower_path.ends_with("/compatible-mode/v1/chat/completions")
                    {
                        path
                    } else if lower_path == "/v1/chat/completions"
                        || lower_path == "/api/v1/chat/completions"
                    {
                        "/compatible-mode/v1/chat/completions".to_string()
                    } else if lower_path == "/v1/responses" || lower_path == "/api/v1/responses" {
                        "/compatible-mode/v1/responses".to_string()
                    } else if lower_path.is_empty()
                        || lower_path == "/"
                        || lower_path == "/v1"
                        || lower_path == "/api/v1"
                        || lower_path == "/compatible-mode"
                        || lower_path == "/compatible-mode/v1"
                    {
                        "/compatible-mode/v1/chat/completions".to_string()
                    } else if lower_path.ends_with("/compatible-mode/v1") {
                        format!("{}/chat/completions", path)
                    } else if lower_path.ends_with("/compatible-mode") {
                        format!("{}/v1/chat/completions", path)
                    } else if lower_path.ends_with("/responses") || lower_path.ends_with("/chat/completions") {
                        path
                    } else {
                        "/compatible-mode/v1/chat/completions".to_string()
                    }
                } else if lower_path.ends_with("/responses") || lower_path.ends_with("/chat/completions") {
                    path
                } else if is_responses {
                    if lower_path.is_empty() || lower_path == "/" {
                        "/v1/responses".to_string()
                    } else if lower_path.ends_with("/v1") {
                        format!("{}/responses", path)
                    } else {
                        "/v1/responses".to_string()
                    }
                } else if lower_path.ends_with("/v1") {
                    format!("{}/chat/completions", path)
                } else {
                    "/v1/chat/completions".to_string()
                }
            }
        };

        (host, Some(api_path))
    } else {
        let api_path = match api_format {
            ApiFormat::Anthropic => "/v1/messages",
            ApiFormat::Openai => {
                if wire_api
                    .map(|v| v.eq_ignore_ascii_case("responses"))
                    .unwrap_or(false)
                {
                    "/v1/responses"
                } else {
                    "/v1/chat/completions"
                }
            }
        };
        (raw, Some(api_path.to_string()))
    }
}

fn finalize_candidate(candidate: &mut ImportProviderCandidate) {
    candidate.api_host = candidate.api_host.trim_end_matches('/').to_string();
    candidate.models = unique_strings(candidate.models.clone());
    if candidate.default_model.trim().is_empty() {
        candidate.default_model = match candidate.api_format {
            ApiFormat::Anthropic => "claude-sonnet-4-5".to_string(),
            ApiFormat::Openai => "gpt-5".to_string(),
        };
        candidate
            .warnings
            .push("源配置未提供默认模型，已写入可编辑的兜底模型".to_string());
    }
    if !candidate.models.contains(&candidate.default_model) {
        candidate.models.insert(0, candidate.default_model.clone());
    }
    candidate.capabilities = normalize_caps(candidate.capabilities.clone());
    candidate.id = make_candidate_id(candidate);
}

fn import_caps(vision: bool, tools: bool, gzip: bool) -> ProviderCapabilities {
    ProviderCapabilities {
        text: true,
        stream: true,
        vision,
        tools,
        gzip,
    }
}

fn normalize_caps(mut caps: ProviderCapabilities) -> ProviderCapabilities {
    caps.text = true;
    caps.stream = true;
    caps
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        let key = value.to_lowercase();
        if seen.insert(key) {
            out.push(value);
        }
    }
    out
}

fn candidate_signature(candidate: &ImportProviderCandidate) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        match candidate.api_format {
            ApiFormat::Anthropic => "anthropic",
            ApiFormat::Openai => "openai",
        },
        candidate.api_host.trim_end_matches('/').to_lowercase(),
        candidate
            .api_path
            .clone()
            .unwrap_or_default()
            .to_lowercase(),
        candidate.api_key,
        candidate.default_model.to_lowercase()
    )
}

fn make_candidate_id(candidate: &ImportProviderCandidate) -> String {
    let mut hasher = Sha256::new();
    hasher.update(candidate.source.as_bytes());
    hasher.update(b"\n");
    hasher.update(candidate.source_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(candidate_signature(candidate).as_bytes());
    let digest = hex::encode(hasher.finalize());
    let source = candidate
        .source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    format!("{}-{}", source, &digest[..16])
}

fn provider_exists(store: &ProviderStore, candidate: &ImportProviderCandidate) -> bool {
    store.providers.iter().any(|provider| {
        provider.api_format == candidate.api_format
            && provider
                .api_host
                .trim_end_matches('/')
                .eq_ignore_ascii_case(candidate.api_host.trim_end_matches('/'))
            && provider
                .api_path
                .as_deref()
                .unwrap_or_default()
                .eq_ignore_ascii_case(candidate.api_path.as_deref().unwrap_or_default())
            && provider.api_key == candidate.api_key
    })
}

fn unique_provider_id(store: &ProviderStore, candidate_id: &str) -> String {
    let base = format!("p-import-{}", candidate_id);
    if !store.providers.iter().any(|p| p.id == base) {
        return base;
    }
    for idx in 2..1000 {
        let next = format!("{}-{}", base, idx);
        if !store.providers.iter().any(|p| p.id == next) {
            return next;
        }
    }
    format!("{}-{}", base, store.providers.len() + 1)
}

fn unique_provider_name(store: &ProviderStore, name: &str) -> String {
    let base = name.trim();
    if !store.providers.iter().any(|p| p.name == base) {
        return base.to_string();
    }
    for idx in 2..1000 {
        let next = format!("{} ({})", base, idx);
        if !store.providers.iter().any(|p| p.name == next) {
            return next;
        }
    }
    format!("{} ({})", base, store.providers.len() + 1)
}

fn add_named_file_matches(
    paths: &mut Vec<PathBuf>,
    file_name: &str,
    max_depth: usize,
    max_results: usize,
) {
    let mut found = Vec::new();
    for root in common_config_roots() {
        find_named_files(&root, file_name, max_depth, max_results, &mut found);
        if found.len() >= max_results {
            break;
        }
    }
    paths.extend(found);
}

fn common_config_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data) = dirs::data_dir() {
        roots.push(data);
    }
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local);
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".config"));
        roots.push(home.join("AppData").join("Roaming"));
        roots.push(home.join("AppData").join("Local"));
    }
    existing_unique_dirs(roots)
}

fn find_named_files(
    root: &Path,
    file_name: &str,
    max_depth: usize,
    max_results: usize,
    out: &mut Vec<PathBuf>,
) {
    if max_depth == 0 || out.len() >= max_results || !root.is_dir() {
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= max_results {
            break;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case(file_name))
                .unwrap_or(false)
            {
                out.push(path);
            }
        } else if file_type.is_dir() && should_descend_config_dir(&path) {
            find_named_files(&path, file_name, max_depth - 1, max_results, out);
        }
    }
}

fn should_descend_config_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "cache"
            | "code cache"
            | "gpucache"
            | "crashpad"
            | "logs"
            | "log"
            | "temp"
            | "tmp"
            | "node_modules"
            | "target"
            | ".git"
    )
}

fn existing_unique_dirs(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if !path.is_dir() {
            continue;
        }
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_lowercase();
        if seen.insert(key) {
            out.push(path);
        }
    }
    out
}

fn existing_unique_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if !path.exists() {
            continue;
        }
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_lowercase();
        if seen.insert(key) {
            out.push(path);
        }
    }
    out
}
