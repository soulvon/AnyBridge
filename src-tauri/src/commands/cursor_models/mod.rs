use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use super::config::config_dir_path;
use super::proxy_routes::{
    find_route_by_uid,
};

pub(super) static CONFIG_MUTEX: Mutex<()> = Mutex::new(());

fn cursor_models_path() -> PathBuf {
    config_dir_path().join("cursor-models.json")
}

fn default_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

pub(super) fn default_auto() -> String {
    "auto".to_string()
}

pub(super) fn default_provider_tag_style() -> String {
    "badge".to_string()
}

pub(super) fn default_bracket_left() -> String {
    "[".to_string()
}

pub(super) fn default_bracket_right() -> String {
    "]".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelsStore {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub revision: String,
    #[serde(default = "default_provider_tag_style")]
    pub provider_tag_style: String,
    #[serde(default = "default_bracket_left")]
    pub provider_bracket_left: String,
    #[serde(default = "default_bracket_right")]
    pub provider_bracket_right: String,
    #[serde(default)]
    pub migration_version: u32,
    #[serde(default)]
    pub migration_notice: Option<String>,
    #[serde(default)]
    pub models: Vec<CursorModelBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelBinding {
    pub id: String,
    pub route_uid: String,
    pub display_name: String,
    pub exposed_model_id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "default_auto")]
    pub capability_policy: String,
    #[serde(default)]
    pub capability_overrides: CursorCapabilityOverrides,
    #[serde(default)]
    pub cursor_overrides: CursorModelOverrides,
    #[serde(default)]
    pub use_third_party_vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorCapabilityOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelItemCapabilities {
    pub stream: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelItem {
    pub id: String,
    pub route_uid: String,
    pub display_name: String,
    pub exposed_model_id: String,
    pub enabled: bool,
    pub sort_order: i64,
    pub provider_id: String,
    pub provider_name: String,
    pub upstream_model: String,
    pub capabilities: CursorModelItemCapabilities,
    pub overrides: CursorModelOverrides,
    pub route_missing: bool,
    pub use_third_party_vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderModelItem {
    pub id: String,
    pub name: String,
    pub supports_tool_call: bool,
    pub supports_images: bool,
    pub supports_reasoning: bool,
    pub already_added: bool,
    pub binding_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderModelsEntry {
    pub provider_id: String,
    pub provider_name: String,
    pub models: Vec<CursorProviderModelItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAddModelPayload {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAddModelsRequest {
    pub models: Vec<CursorAddModelPayload>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUpdateModelPayload {
    pub id: String,
    pub display_name: Option<String>,
    pub exposed_model_id: Option<String>,
    pub route_uid: Option<String>,
    pub enabled: Option<bool>,
    pub sort_order: Option<i64>,
    pub overrides: Option<CursorModelOverrides>,
    pub use_third_party_vision: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAddModelsResult {
    pub added_count: usize,
    pub skipped_count: usize,
    pub sync_status: super::cursor_core::CursorCoreStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorMutationResult {
    pub success: bool,
    pub sync_status: super::cursor_core::CursorCoreStatus,
}

pub fn calculate_revision(models: &[CursorModelBinding]) -> String {
    let mut hasher = Sha256::new();
    for m in models {
        hasher.update(m.id.as_bytes());
        hasher.update(m.route_uid.as_bytes());
        hasher.update(m.display_name.as_bytes());
        hasher.update(m.exposed_model_id.as_bytes());
        hasher.update(if m.enabled { b"1" } else { b"0" });
        hasher.update(if m.use_third_party_vision { b"1" } else { b"0" });
        hasher.update(m.sort_order.to_le_bytes());
        if let Some(r) = &m.cursor_overrides.reasoning_effort {
            hasher.update(r.as_bytes());
        }
        if let Some(c) = m.cursor_overrides.context_window_tokens {
            hasher.update(c.to_le_bytes());
        }
        if let Some(m) = m.cursor_overrides.max_completion_tokens {
            hasher.update(m.to_le_bytes());
        }
    }
    hex::encode(hasher.finalize())
}

pub fn normalize_cursor_store(store: &mut CursorModelsStore) {
    store.version = default_version();
    let mut seen_ids = HashSet::new();
    let mut seen_exposed = HashSet::new();

    store.models.retain_mut(|m| {
        m.id = m.id.trim().to_string();
        m.route_uid = m.route_uid.trim().to_string();
        m.display_name = m.display_name.trim().to_string();
        m.exposed_model_id = m.exposed_model_id.trim().to_string();

        if m.id.is_empty() || m.route_uid.is_empty() || m.exposed_model_id.is_empty() {
            return false;
        }
        if !seen_ids.insert(m.id.clone()) {
            return false;
        }
        if !seen_exposed.insert(m.exposed_model_id.clone()) {
            // Deduplicate exposed model ID by appending suffix
            let mut counter = 2;
            let base = m.exposed_model_id.clone();
            loop {
                let candidate = format!("{base}-{counter}");
                if seen_exposed.insert(candidate.clone()) {
                    m.exposed_model_id = candidate;
                    break;
                }
                counter += 1;
            }
        }
        if m.display_name.is_empty() {
            m.display_name = m.exposed_model_id.clone();
        }
        true
    });

    let valid_styles = ["prefix", "suffix", "badge", "none"];
    if !valid_styles.contains(&store.provider_tag_style.as_str()) {
        store.provider_tag_style = default_provider_tag_style();
    }

    if store.provider_bracket_left.is_empty() && store.provider_bracket_right.is_empty() {
        store.provider_bracket_left = default_bracket_left();
        store.provider_bracket_right = default_bracket_right();
    }

    store.revision = calculate_revision(&store.models);
}

#[allow(dead_code)]
fn empty_cursor_store() -> CursorModelsStore {
    let mut s = CursorModelsStore {
        version: default_version(),
        revision: String::new(),
        provider_tag_style: default_provider_tag_style(),
        provider_bracket_left: default_bracket_left(),
        provider_bracket_right: default_bracket_right(),
        migration_version: 1,
        migration_notice: None,
        models: Vec::new(),
    };
    s.revision = calculate_revision(&s.models);
    s
}

pub fn read_cursor_store_with_routes(
    cursor_path: PathBuf,
    routes_path: PathBuf,
) -> Result<CursorModelsStore, String> {
    if !cursor_path.exists() {
        // Initial migration from existing proxy routes
        let routes = super::proxy_routes::read_routes_from(routes_path)?;
        let mut models = Vec::new();
        let mut idx = 1;
        for route in routes.routes {
            if route.enabled
                && !route.targets.is_empty()
                && route
                    .exposed_formats
                    .iter()
                    .any(|f| f.eq_ignore_ascii_case("openai"))
            {
                let name = if route.display_name.trim().is_empty() {
                    route.id.clone()
                } else {
                    route.display_name.clone()
                };
                models.push(CursorModelBinding {
                    id: format!("cursor-{}", route.uid),
                    route_uid: route.uid.clone(),
                    display_name: name,
                    exposed_model_id: route.id.clone(),
                    enabled: route.enabled,
                    sort_order: idx,
                    capability_policy: default_auto(),
                    capability_overrides: CursorCapabilityOverrides::default(),
                    cursor_overrides: CursorModelOverrides::default(),
                    use_third_party_vision: false,
                });
                idx += 1;
            }
        }
        let count = models.len();
        let mut store = CursorModelsStore {
            version: default_version(),
            revision: String::new(),
            provider_tag_style: default_provider_tag_style(),
            provider_bracket_left: default_bracket_left(),
            provider_bracket_right: default_bracket_right(),
            migration_version: 1,
            migration_notice: if count > 0 {
                Some(format!("已自动导入 {count} 个已有模型到 Cursor"))
            } else {
                None
            },
            models,
        };
        normalize_cursor_store(&mut store);
        let _ = write_cursor_store_to(cursor_path, &store);
        return Ok(store);
    }

    let raw = fs::read_to_string(&cursor_path).map_err(|e| e.to_string())?;
    let mut store: CursorModelsStore = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    normalize_cursor_store(&mut store);
    Ok(store)
}

pub fn read_cursor_store_from(path: PathBuf) -> Result<CursorModelsStore, String> {
    read_cursor_store_with_routes(path, super::proxy_routes::proxy_routes_path())
}

pub fn write_cursor_store_to(path: PathBuf, store: &CursorModelsStore) -> Result<(), String> {
    let dir = config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    super::write_atomic(&path, json.as_bytes())
}

pub fn read_cursor_store() -> Result<CursorModelsStore, String> {
    read_cursor_store_from(cursor_models_path())
}

pub fn write_cursor_store(store: &CursorModelsStore) -> Result<(), String> {
    write_cursor_store_to(cursor_models_path(), store)
}

pub fn build_cursor_model_items(
    store: &CursorModelsStore,
    routes: &super::proxy_routes::ProxyRoutes,
    providers_store: &super::config::ProviderStore,
) -> Vec<CursorModelItem> {
    let mut items = Vec::new();
    for binding in &store.models {
        let route = find_route_by_uid(routes, &binding.route_uid);
        let first_target = route.and_then(|r| r.targets.first());
        let provider_id = first_target
            .map(|t| t.provider_id.clone())
            .unwrap_or_default();
        let upstream_model = first_target.map(|t| t.model.clone()).unwrap_or_default();

        let provider_name = providers_store
            .providers
            .iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| provider_id.clone());

        let capabilities = CursorModelItemCapabilities {
            stream: binding
                .capability_overrides
                .stream
                .unwrap_or_else(|| route.map(|r| r.capabilities.stream).unwrap_or(true)),
            tools: binding
                .capability_overrides
                .tools
                .unwrap_or_else(|| route.map(|r| r.capabilities.tools).unwrap_or(true)),
            vision: binding
                .capability_overrides
                .vision
                .unwrap_or_else(|| route.map(|r| r.capabilities.vision).unwrap_or(false)),
            reasoning: binding
                .capability_overrides
                .reasoning
                .unwrap_or_else(|| route.map(|r| r.capabilities.reasoning).unwrap_or(false)),
        };

        let use_third_party_vision = binding.use_third_party_vision
            || route.map(|r| r.enhancement.third_party_vision).unwrap_or(false);

        items.push(CursorModelItem {
            id: binding.id.clone(),
            route_uid: binding.route_uid.clone(),
            display_name: binding.display_name.clone(),
            exposed_model_id: binding.exposed_model_id.clone(),
            enabled: binding.enabled,
            sort_order: binding.sort_order,
            provider_id,
            provider_name,
            upstream_model,
            capabilities,
            overrides: binding.cursor_overrides.clone(),
            route_missing: route.is_none(),
            use_third_party_vision,
        });
    }

    items.sort_by_key(|item| item.sort_order);
    items
}


pub mod commands;
pub use commands::*;

#[cfg(test)]
mod tests;
