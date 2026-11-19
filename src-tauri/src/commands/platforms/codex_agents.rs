use crate::commands::config::{AgentsGlobalConfig, Provider};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{value, Array, DocumentMut, Item, Table};

use super::codex::codex_home;

pub(in crate::commands::platforms) const CODEX_ANYBRIDGE_AGENTS_DIRNAME: &str = "anybridge-agents";

pub(in crate::commands::platforms) const CODEX_ANYBRIDGE_AGENTS_MANIFEST: &str = "manifest.json";


#[derive(Debug, Serialize, serde::Deserialize, Default)]
pub(in crate::commands::platforms) struct CodexAgentsManifest {
    pub(in crate::commands::platforms) version: u32,
    #[serde(default)]
    pub(in crate::commands::platforms) roles: Vec<String>,
    #[serde(default)]
    pub(in crate::commands::platforms) files: Vec<String>,
    #[serde(rename = "managedGlobal", default)]
    pub(in crate::commands::platforms) managed_global: BTreeMap<String, u64>,
}


pub(in crate::commands::platforms) struct PreparedCodexAgent {
    pub(in crate::commands::platforms) name: String,
    pub(in crate::commands::platforms) filename: String,
    pub(in crate::commands::platforms) role_description: String,
    pub(in crate::commands::platforms) nickname_candidates: Vec<String>,
    pub(in crate::commands::platforms) toml: String,
}


#[derive(Default)]
pub(in crate::commands::platforms) struct CodexAgentsFinalize {
    pub(in crate::commands::platforms) files_to_remove: Vec<String>,
    pub(in crate::commands::platforms) keep_files: HashSet<String>,
    pub(in crate::commands::platforms) manifest_json: Option<String>,
}


impl CodexAgentsFinalize {
    pub(in crate::commands::platforms) fn cleanup_only(files_to_remove: Vec<String>) -> Self {
        Self {
            files_to_remove,
            keep_files: HashSet::new(),
            manifest_json: None,
        }
    }
}


pub(in crate::commands::platforms) fn codex_agents_dir(config_path: &Path) -> PathBuf {
    let base = config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .or_else(codex_home)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(CODEX_ANYBRIDGE_AGENTS_DIRNAME)
}


pub(in crate::commands::platforms) fn codex_agents_manifest_path(config_path: &Path) -> PathBuf {
    codex_agents_dir(config_path).join(CODEX_ANYBRIDGE_AGENTS_MANIFEST)
}


pub(in crate::commands::platforms) fn is_valid_codex_agent_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}


pub(in crate::commands::platforms) fn is_reserved_codex_agent_name(name: &str) -> bool {
    matches!(name, "default" | "worker" | "explorer")
}


pub(in crate::commands::platforms) fn is_valid_codex_nickname(value: &str) -> bool {
    !value.trim().is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-' || b == b'_')
}


pub(in crate::commands::platforms) fn codex_agent_model_set(provider: &Provider) -> HashSet<String> {
    let mut models = HashSet::new();
    if !provider.default_model.trim().is_empty() {
        models.insert(provider.default_model.trim().to_string());
    }
    for model in &provider.models {
        if !model.trim().is_empty() {
            models.insert(model.trim().to_string());
        }
    }
    for entry in &provider.model_catalog {
        if !entry.model.trim().is_empty() {
            models.insert(entry.model.trim().to_string());
        }
    }
    models
}


pub(in crate::commands::platforms) fn toml_string_array(values: &[String]) -> Item {
    let mut arr = Array::default();
    for value in values {
        arr.push(value.as_str());
    }
    value(arr)
}


pub(in crate::commands::platforms) fn prepare_codex_agents(provider: &Provider) -> Result<Vec<PreparedCodexAgent>, String> {
    let models = codex_agent_model_set(provider);
    let mut seen = HashSet::new();
    let mut prepared = Vec::new();

    for agent in &provider.agents {
        let name = agent.name.trim();
        if !is_valid_codex_agent_name(name) {
            return Err(format!(
                "Codex 子代理名称「{}」无效：必须匹配 ^[a-z][a-z0-9-]{{0,63}}$",
                agent.name
            ));
        }
        if is_reserved_codex_agent_name(name) {
            return Err(format!(
                "Codex 子代理名称「{}」是内置名称，AnyBridge 当前版本不允许覆盖。",
                name
            ));
        }
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(format!("Codex 子代理名称重复: {name}"));
        }

        let description = agent.description.trim();
        if description.is_empty() {
            return Err(format!("Codex 子代理「{name}」缺少 description"));
        }
        let developer_instructions = agent.developer_instructions.trim();
        if developer_instructions.is_empty() {
            return Err(format!("Codex 子代理「{name}」缺少 developerInstructions"));
        }

        let model = agent.model.trim();
        if !model.is_empty() && !models.contains(model) {
            return Err(format!(
                "Codex 子代理「{name}」引用的模型「{model}」不在当前配置模型列表中"
            ));
        }

        if let Some(effort) = agent
            .model_reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !matches!(effort, "low" | "medium" | "high") {
                return Err(format!(
                    "Codex 子代理「{name}」的 modelReasoningEffort 无效: {effort}"
                ));
            }
        }

        if let Some(sandbox) = agent
            .sandbox_mode
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !matches!(
                sandbox,
                "read-only" | "workspace-write" | "danger-full-access"
            ) {
                return Err(format!(
                    "Codex 子代理「{name}」的 sandboxMode 无效: {sandbox}"
                ));
            }
        }

        let mut nickname_seen = HashSet::new();
        let mut nicknames = Vec::new();
        for raw in &agent.nickname_candidates {
            let nickname = raw.trim();
            if nickname.is_empty() {
                continue;
            }
            if !is_valid_codex_nickname(nickname) {
                return Err(format!(
                    "Codex 子代理「{name}」的昵称「{nickname}」无效：仅允许 ASCII 字母、数字、空格、连字符和下划线"
                ));
            }
            if !nickname_seen.insert(nickname.to_ascii_lowercase()) {
                return Err(format!("Codex 子代理「{name}」的昵称重复: {nickname}"));
            }
            nicknames.push(nickname.to_string());
        }

        let mut agent_doc = DocumentMut::new();
        agent_doc["name"] = value(name);
        agent_doc["description"] = value(description);
        agent_doc["developer_instructions"] = value(developer_instructions);
        if !model.is_empty() {
            agent_doc["model"] = value(model);
        }
        if let Some(effort) = agent
            .model_reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            agent_doc["model_reasoning_effort"] = value(effort);
        }
        if let Some(sandbox) = agent
            .sandbox_mode
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            agent_doc["sandbox_mode"] = value(sandbox);
        }
        if !nicknames.is_empty() {
            agent_doc["nickname_candidates"] = toml_string_array(&nicknames);
        }

        prepared.push(PreparedCodexAgent {
            name: name.to_string(),
            filename: format!("{name}.toml"),
            role_description: description.to_string(),
            nickname_candidates: nicknames,
            toml: agent_doc.to_string(),
        });
    }

    Ok(prepared)
}


pub(in crate::commands::platforms) fn codex_agents_global_config(provider: &Provider) -> Result<AgentsGlobalConfig, String> {
    let global = provider.agents_config.clone().unwrap_or_default();
    if global.max_threads == 0 {
        return Err("Codex 子代理全局配置 maxThreads 必须大于 0".to_string());
    }
    if global.max_depth == 0 {
        return Err("Codex 子代理全局配置 maxDepth 必须大于 0".to_string());
    }
    if global.job_max_runtime_seconds == 0 {
        return Err("Codex 子代理全局配置 jobMaxRuntimeSeconds 必须大于 0".to_string());
    }
    Ok(global)
}


pub(in crate::commands::platforms) fn normalize_codex_agent_config_file(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}


pub(in crate::commands::platforms) fn is_anybridge_agent_config_file(value: &str) -> bool {
    normalize_codex_agent_config_file(value).starts_with("anybridge-agents/")
}


pub(in crate::commands::platforms) fn read_codex_agents_manifest(config_path: &Path) -> Option<CodexAgentsManifest> {
    let manifest_path = codex_agents_manifest_path(config_path);
    let raw = fs::read_to_string(manifest_path).ok()?;
    serde_json::from_str(&raw).ok()
}


pub(in crate::commands::platforms) fn toml_item_u64(item: Option<&Item>) -> Option<u64> {
    item.and_then(Item::as_value)
        .and_then(|v| v.as_integer())
        .and_then(|v| u64::try_from(v).ok())
}


pub(in crate::commands::platforms) fn push_codex_cleanup_file(files: &mut Vec<String>, seen: &mut HashSet<String>, file: &str) {
    let Some(name) = Path::new(file).file_name().and_then(|s| s.to_str()) else {
        return;
    };
    if seen.insert(name.to_string()) {
        files.push(name.to_string());
    }
}


pub(in crate::commands::platforms) fn cleanup_anybridge_codex_agents(
    config_path: &Path,
    doc: &mut DocumentMut,
) -> Result<Vec<String>, String> {
    let manifest = read_codex_agents_manifest(config_path);
    let manifest_roles: HashSet<String> = manifest
        .as_ref()
        .map(|m| m.roles.iter().cloned().collect())
        .unwrap_or_default();
    let mut files_to_remove = Vec::new();
    let mut seen_files = HashSet::new();

    let mut remove_agents_table = false;
    if let Some(agents_table) = doc["agents"].as_table_mut() {
        let roles_to_remove: Vec<String> = agents_table
            .iter()
            .filter_map(|(name, item)| {
                let role_table = item.as_table()?;
                let managed_file = role_table
                    .get("config_file")
                    .and_then(Item::as_str)
                    .map(is_anybridge_agent_config_file)
                    .unwrap_or(false);
                if managed_file || manifest_roles.contains(name) {
                    Some(name.to_string())
                } else {
                    None
                }
            })
            .collect();
        for role in roles_to_remove {
            agents_table.remove(&role);
        }

        if let Some(manifest) = manifest.as_ref() {
            for (key, previous) in &manifest.managed_global {
                if toml_item_u64(agents_table.get(key)) == Some(*previous) {
                    agents_table.remove(key);
                }
            }
        }

        remove_agents_table = agents_table.iter().next().is_none();
    }
    if remove_agents_table {
        doc.as_table_mut().remove("agents");
    }

    let agents_dir = codex_agents_dir(config_path);
    if agents_dir.exists() {
        if let Some(manifest) = manifest.as_ref() {
            for file in &manifest.files {
                push_codex_cleanup_file(&mut files_to_remove, &mut seen_files, file);
            }
        } else if let Ok(entries) = fs::read_dir(&agents_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("toml") {
                    if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                        push_codex_cleanup_file(&mut files_to_remove, &mut seen_files, name);
                    }
                }
            }
        }
    }

    Ok(files_to_remove)
}


pub(in crate::commands::platforms) fn finalize_codex_agents_files(
    config_path: &Path,
    finalize: CodexAgentsFinalize,
) -> Result<(), String> {
    let agents_dir = codex_agents_dir(config_path);
    if let Some(manifest_json) = finalize.manifest_json {
        fs::create_dir_all(&agents_dir).map_err(|e| format!("创建 Codex 子代理目录失败: {e}"))?;
        crate::commands::write_atomic(
            &codex_agents_manifest_path(config_path),
            manifest_json.as_bytes(),
        )?;
    } else {
        let _ = fs::remove_file(codex_agents_manifest_path(config_path));
    }

    for file in finalize.files_to_remove {
        if finalize.keep_files.contains(&file) {
            continue;
        }
        let _ = fs::remove_file(agents_dir.join(file));
    }
    let _ = fs::remove_dir(&agents_dir);

    Ok(())
}


pub(in crate::commands::platforms) fn apply_codex_agents(
    config_path: &Path,
    doc: &mut DocumentMut,
    provider: &Provider,
) -> Result<CodexAgentsFinalize, String> {
    let prepared = prepare_codex_agents(provider)?;
    let global = if prepared.is_empty() {
        None
    } else {
        Some(codex_agents_global_config(provider)?)
    };
    let files_to_remove = cleanup_anybridge_codex_agents(config_path, doc)?;

    if prepared.is_empty() {
        return Ok(CodexAgentsFinalize::cleanup_only(files_to_remove));
    }

    let agents_dir = codex_agents_dir(config_path);
    fs::create_dir_all(&agents_dir).map_err(|e| format!("创建 Codex 子代理目录失败: {e}"))?;

    for agent in &prepared {
        crate::commands::write_atomic(&agents_dir.join(&agent.filename), agent.toml.as_bytes())?;
    }

    let global = global.expect("prepared agents require global config");
    let agents_table = doc
        .entry("agents")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| "config.toml 的 agents 字段不是表".to_string())?;
    agents_table["max_threads"] = value(global.max_threads as i64);
    agents_table["max_depth"] = value(global.max_depth as i64);
    agents_table["job_max_runtime_seconds"] = value(global.job_max_runtime_seconds as i64);

    for agent in &prepared {
        let role_table = agents_table
            .entry(&agent.name)
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| format!("config.toml 的 agents.{} 不是表", agent.name))?;
        role_table["description"] = value(agent.role_description.clone());
        role_table["config_file"] = value(format!(
            "./{CODEX_ANYBRIDGE_AGENTS_DIRNAME}/{}",
            agent.filename
        ));
        if agent.nickname_candidates.is_empty() {
            role_table.remove("nickname_candidates");
        } else {
            role_table["nickname_candidates"] = toml_string_array(&agent.nickname_candidates);
        }
    }

    let mut managed_global = BTreeMap::new();
    managed_global.insert("max_threads".to_string(), global.max_threads as u64);
    managed_global.insert("max_depth".to_string(), global.max_depth as u64);
    managed_global.insert(
        "job_max_runtime_seconds".to_string(),
        global.job_max_runtime_seconds,
    );
    let manifest = CodexAgentsManifest {
        version: 1,
        roles: prepared.iter().map(|a| a.name.clone()).collect(),
        files: prepared.iter().map(|a| a.filename.clone()).collect(),
        managed_global,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Codex 子代理 manifest 序列化失败: {e}"))?;

    Ok(CodexAgentsFinalize {
        files_to_remove,
        keep_files: prepared.iter().map(|a| a.filename.clone()).collect(),
        manifest_json: Some(manifest_json),
    })
}
