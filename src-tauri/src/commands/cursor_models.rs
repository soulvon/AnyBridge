use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

use super::config::config_dir_path;
use super::proxy_routes::{
    find_route_by_target, find_route_by_uid, generate_route_uid, read_routes, write_routes,
    ProxyRoute, ProxyRouteCapabilities, ProxyRouteEnhancement, ProxyRouteTarget,
};

static CONFIG_MUTEX: Mutex<()> = Mutex::new(());

fn cursor_models_path() -> PathBuf {
    config_dir_path().join("cursor-models.json")
}

fn default_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_auto() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelsStore {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub revision: String,
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

    store.revision = calculate_revision(&store.models);
}

#[allow(dead_code)]
fn empty_cursor_store() -> CursorModelsStore {
    let mut s = CursorModelsStore {
        version: default_version(),
        revision: String::new(),
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
                });
                idx += 1;
            }
        }
        let count = models.len();
        let mut store = CursorModelsStore {
            version: default_version(),
            revision: String::new(),
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
        });
    }

    items.sort_by_key(|item| item.sort_order);
    items
}

#[tauri::command]
pub fn cursor_list_models() -> Result<Vec<CursorModelItem>, String> {
    let store = read_cursor_store()?;
    let routes = read_routes()?;
    let providers_store = super::config::read_provider_store()?;
    Ok(build_cursor_model_items(
        &store,
        &routes,
        &providers_store,
    ))
}

#[tauri::command]
pub fn cursor_list_provider_models() -> Result<Vec<CursorProviderModelsEntry>, String> {
    let raw_entries = super::platforms::list_provider_models()?;
    let cursor_store = read_cursor_store().unwrap_or_default();
    let routes = read_routes().unwrap_or_default();

    let mut out = Vec::new();
    for entry in raw_entries {
        let mut models = Vec::new();
        let is_local_proxy = entry.provider_id == "anybridge-local-proxy" || entry.provider_id == "anybridge";
        for m in entry.models {
            let matching_binding = cursor_store.models.iter().find(|b| {
                if let Some(route) = find_route_by_uid(&routes, &b.route_uid) {
                    if is_local_proxy {
                        route.id == m.id
                    } else {
                        route
                            .targets
                            .iter()
                            .any(|t| t.provider_id == entry.provider_id && t.model == m.id)
                    }
                } else {
                    false
                }
            });

            models.push(CursorProviderModelItem {
                id: m.id,
                name: m.name,
                supports_tool_call: m.supports_tool_call,
                supports_images: m.supports_images,
                supports_reasoning: m.supports_reasoning,
                already_added: matching_binding.is_some(),
                binding_id: matching_binding.map(|b| b.id.clone()),
            });
        }

        out.push(CursorProviderModelsEntry {
            provider_id: entry.provider_id,
            provider_name: entry.provider_name,
            models,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn cursor_add_models(
    _app: AppHandle,
    req: CursorAddModelsRequest,
    core_state: State<'_, super::cursor_core::CursorCoreState>,
) -> Result<CursorAddModelsResult, String> {
    let _guard = CONFIG_MUTEX
        .lock()
        .map_err(|e| format!("配置锁获取失败: {e}"))?;

    let mut cursor_store = read_cursor_store()?;
    let mut routes = read_routes()?;

    let mut added_count = 0;
    let mut skipped_count = 0;

    let existing_exposed_ids: HashSet<String> = cursor_store
        .models
        .iter()
        .map(|m| m.exposed_model_id.clone())
        .collect();

    for payload in req.models {
        let provider_id = payload.provider_id.trim();
        let model_id = payload.model_id.trim();
        if provider_id.is_empty() || model_id.is_empty() {
            skipped_count += 1;
            continue;
        }

        let is_local_proxy = provider_id == "anybridge-local-proxy" || provider_id == "anybridge";

        // Check if binding already exists for this provider & model
        let already_bound = cursor_store.models.iter().any(|b| {
            if let Some(r) = find_route_by_uid(&routes, &b.route_uid) {
                if is_local_proxy {
                    r.id == model_id
                } else {
                    r.targets
                        .iter()
                        .any(|t| t.provider_id == provider_id && t.model == model_id)
                }
            } else {
                false
            }
        });

        if already_bound {
            skipped_count += 1;
            continue;
        }

        // Find or create shared ProxyRoute
        let route_uid = if let Some(existing_route) =
            find_route_by_target(&routes, provider_id, model_id)
        {
            existing_route.uid.clone()
        } else if is_local_proxy {
            if let Some(existing_route) = routes.routes.iter().find(|r| r.id == model_id) {
                existing_route.uid.clone()
            } else {
                let new_route = ProxyRoute {
                    uid: String::new(),
                    id: model_id.to_string(),
                    display_name: model_id.to_string(),
                    id_from_rename_rule: false,
                    enabled: true,
                    exposed_formats: vec!["openai".to_string(), "anthropic".to_string()],
                    source: "manual".to_string(),
                    capabilities: ProxyRouteCapabilities {
                        stream: true,
                        tools: true,
                        vision: true,
                        reasoning: true,
                    },
                    enhancement: ProxyRouteEnhancement::default(),
                    targets: vec![ProxyRouteTarget {
                        provider_id: provider_id.to_string(),
                        model: model_id.to_string(),
                        api_format: String::new(),
                        api_path: String::new(),
                        unlock: String::new(),
                        api_keys: Vec::new(),
                    }],
                };
                let uid = generate_route_uid(&new_route);
                let mut new_route = new_route;
                new_route.uid = uid.clone();
                routes.routes.push(new_route);
                uid
            }
        } else {
            let new_route = ProxyRoute {
                uid: String::new(),
                id: model_id.to_string(),
                display_name: model_id.to_string(),
                id_from_rename_rule: false,
                enabled: true,
                exposed_formats: vec!["openai".to_string(), "anthropic".to_string()],
                source: "manual".to_string(),
                capabilities: ProxyRouteCapabilities {
                    stream: true,
                    tools: true,
                    vision: true,
                    reasoning: true,
                },
                enhancement: ProxyRouteEnhancement::default(),
                targets: vec![ProxyRouteTarget {
                    provider_id: provider_id.to_string(),
                    model: model_id.to_string(),
                    api_format: String::new(),
                    api_path: String::new(),
                    unlock: String::new(),
                    api_keys: Vec::new(),
                }],
            };
            let uid = generate_route_uid(&new_route);
            let mut new_route = new_route;
            new_route.uid = uid.clone();
            routes.routes.push(new_route);
            uid
        };

        // Determine exposed model ID and display name
        let mut base_exposed = model_id.to_string();
        if existing_exposed_ids.contains(&base_exposed)
            || cursor_store
                .models
                .iter()
                .any(|m| m.exposed_model_id == base_exposed)
        {
            let mut counter = 2;
            loop {
                let candidate = format!("{model_id}-{counter}");
                if !existing_exposed_ids.contains(&candidate)
                    && !cursor_store
                        .models
                        .iter()
                        .any(|m| m.exposed_model_id == candidate)
                {
                    base_exposed = candidate;
                    break;
                }
                counter += 1;
            }
        }

        let mut display_name = model_id.to_string();
        if let Some(prefix) = req.prefix.as_deref() {
            if !prefix.trim().is_empty() {
                display_name = format!("{} {}", prefix.trim(), display_name);
            }
        }
        if let Some(suffix) = req.suffix.as_deref() {
            if !suffix.trim().is_empty() {
                display_name = format!("{} {}", display_name, suffix.trim());
            }
        }

        let next_sort = (cursor_store.models.len() + 1) as i64;
        let binding_id = format!("cursor-{route_uid}");

        cursor_store.models.push(CursorModelBinding {
            id: binding_id,
            route_uid,
            display_name,
            exposed_model_id: base_exposed,
            enabled: true,
            sort_order: next_sort,
            capability_policy: default_auto(),
            capability_overrides: CursorCapabilityOverrides::default(),
            cursor_overrides: CursorModelOverrides::default(),
        });

        added_count += 1;
    }

    normalize_cursor_store(&mut cursor_store);
    super::proxy_routes::normalize_routes(&mut routes);

    // Atomic multi-file write
    write_routes(&routes)?;
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    // Attempt auto sync if Core is running
    let sync_status = if core_state.running() {
        let _ = super::cursor_core::sync_routes_impl(core_state.inner()).await;
        super::cursor_core::get_status_impl(core_state.inner())
    } else {
        super::cursor_core::get_status_impl(core_state.inner())
    };

    Ok(CursorAddModelsResult {
        added_count,
        skipped_count,
        sync_status,
    })
}

#[tauri::command]
pub async fn cursor_update_model(
    _app: AppHandle,
    payload: CursorUpdateModelPayload,
    core_state: State<'_, super::cursor_core::CursorCoreState>,
) -> Result<CursorMutationResult, String> {
    let _guard = CONFIG_MUTEX
        .lock()
        .map_err(|e| format!("配置锁获取失败: {e}"))?;

    let mut cursor_store = read_cursor_store()?;
    let target = cursor_store
        .models
        .iter_mut()
        .find(|m| m.id == payload.id)
        .ok_or_else(|| format!("未找到 Cursor 模型: {}", payload.id))?;

    if let Some(display_name) = payload.display_name {
        target.display_name = display_name.trim().to_string();
    }
    if let Some(exposed_model_id) = payload.exposed_model_id {
        let clean = exposed_model_id.trim().to_string();
        if !clean.is_empty() {
            target.exposed_model_id = clean;
        }
    }
    if let Some(route_uid) = payload.route_uid {
        let clean = route_uid.trim().to_string();
        if !clean.is_empty() {
            target.route_uid = clean;
        }
    }
    if let Some(enabled) = payload.enabled {
        target.enabled = enabled;
    }
    if let Some(sort_order) = payload.sort_order {
        target.sort_order = sort_order;
    }
    if let Some(overrides) = payload.overrides {
        target.cursor_overrides = overrides;
    }

    normalize_cursor_store(&mut cursor_store);
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    let sync_status = if core_state.running() {
        let _ = super::cursor_core::sync_routes_impl(core_state.inner()).await;
        super::cursor_core::get_status_impl(core_state.inner())
    } else {
        super::cursor_core::get_status_impl(core_state.inner())
    };

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

#[tauri::command]
pub async fn cursor_remove_models(
    _app: AppHandle,
    ids: Vec<String>,
    core_state: State<'_, super::cursor_core::CursorCoreState>,
) -> Result<CursorMutationResult, String> {
    let _guard = CONFIG_MUTEX
        .lock()
        .map_err(|e| format!("配置锁获取失败: {e}"))?;

    let mut cursor_store = read_cursor_store()?;
    let id_set: HashSet<String> = ids.into_iter().collect();

    cursor_store.models.retain(|m| !id_set.contains(&m.id));
    normalize_cursor_store(&mut cursor_store);
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    let sync_status = if core_state.running() {
        let _ = super::cursor_core::sync_routes_impl(core_state.inner()).await;
        super::cursor_core::get_status_impl(core_state.inner())
    } else {
        super::cursor_core::get_status_impl(core_state.inner())
    };

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

#[tauri::command]
pub async fn cursor_set_models_enabled(
    _app: AppHandle,
    ids: Vec<String>,
    enabled: bool,
    core_state: State<'_, super::cursor_core::CursorCoreState>,
) -> Result<CursorMutationResult, String> {
    let _guard = CONFIG_MUTEX
        .lock()
        .map_err(|e| format!("配置锁获取失败: {e}"))?;

    let mut cursor_store = read_cursor_store()?;
    let id_set: HashSet<String> = ids.into_iter().collect();

    for m in &mut cursor_store.models {
        if id_set.contains(&m.id) {
            m.enabled = enabled;
        }
    }

    normalize_cursor_store(&mut cursor_store);
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    let sync_status = if core_state.running() {
        let _ = super::cursor_core::sync_routes_impl(core_state.inner()).await;
        super::cursor_core::get_status_impl(core_state.inner())
    } else {
        super::cursor_core::get_status_impl(core_state.inner())
    };

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_has_stable_revision() {
        let mut store = empty_cursor_store();
        assert_eq!(store.version, 1);
        assert!(!store.revision.is_empty());
        let rev1 = store.revision.clone();
        normalize_cursor_store(&mut store);
        assert_eq!(store.revision, rev1);
    }

    #[test]
    fn migration_imports_only_openai_enabled_routes() {
        let unique_id = format!("cursor-test-{}", rand::random::<u64>());
        let dir = std::env::temp_dir().join(unique_id);
        fs::create_dir_all(&dir).unwrap();
        let routes_path = dir.join("proxy-routes.json");
        let cursor_path = dir.join("cursor-models.json");

        let routes_json = r#"{
            "version": 1,
            "routes": [
                {
                    "uid": "route-1",
                    "id": "gpt-4o",
                    "displayName": "GPT 4o Main",
                    "enabled": true,
                    "exposedFormats": ["openai"],
                    "targets": [{"providerId": "openai", "model": "gpt-4o"}]
                },
                {
                    "uid": "route-2",
                    "id": "claude-haiku",
                    "displayName": "Haiku Anthropic Only",
                    "enabled": true,
                    "exposedFormats": ["anthropic"],
                    "targets": [{"providerId": "anthropic", "model": "claude-haiku"}]
                },
                {
                    "uid": "route-3",
                    "id": "disabled-model",
                    "displayName": "Disabled",
                    "enabled": false,
                    "exposedFormats": ["openai"],
                    "targets": [{"providerId": "openai", "model": "disabled"}]
                }
            ]
        }"#;
        fs::write(&routes_path, routes_json).unwrap();

        let store = read_cursor_store_with_routes(cursor_path.clone(), routes_path.clone()).unwrap();
        assert_eq!(store.models.len(), 1);
        assert_eq!(store.models[0].route_uid, "route-1");
        assert_eq!(store.models[0].display_name, "GPT 4o Main");
        assert_eq!(store.models[0].exposed_model_id, "gpt-4o");
        assert!(store.migration_notice.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_binding_preserves_shared_route() {
        let mut store = CursorModelsStore::default();
        store.models.push(CursorModelBinding {
            id: "cursor-1".into(),
            route_uid: "route-shared".into(),
            display_name: "Test".into(),
            exposed_model_id: "test".into(),
            enabled: true,
            ..Default::default()
        });

        store.models.retain(|m| m.id != "cursor-1");
        assert!(store.models.is_empty());
    }
}

