use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::{AppHandle, State};
use super::{
    build_cursor_model_items, default_auto, default_bracket_left, default_bracket_right,
    default_provider_tag_style, normalize_cursor_store, read_cursor_store, write_cursor_store,
    CursorAddModelsRequest, CursorAddModelsResult, CursorCapabilityOverrides,
    CursorModelBinding, CursorModelItem, CursorModelOverrides, CursorMutationResult,
    CursorProviderModelItem, CursorProviderModelsEntry, CursorUpdateModelPayload, CONFIG_MUTEX,
};
use crate::commands::proxy_routes::{find_route_by_uid, generate_route_uid, read_routes, write_routes, ProxyRoute, ProxyRouteCapabilities, ProxyRouteEnhancement, find_route_by_target, ProxyRouteTarget};
#[tauri::command]
pub fn cursor_list_models() -> Result<Vec<CursorModelItem>, String> {
    let store = read_cursor_store()?;
    let routes = read_routes()?;
    let providers_store = crate::commands::config::read_provider_store()?;
    Ok(build_cursor_model_items(
        &store,
        &routes,
        &providers_store,
    ))
}

#[tauri::command]
pub fn cursor_list_provider_models() -> Result<Vec<CursorProviderModelsEntry>, String> {
    let raw_entries = crate::commands::platforms::list_provider_models()?;
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

async fn sync_or_get_status(core_state: &crate::commands::cursor_core::CursorCoreState) -> crate::commands::cursor_core::CursorCoreStatus {
    if core_state.running() {
        crate::commands::cursor_core::sync_routes_impl(core_state)
            .await
            .unwrap_or_else(|_| crate::commands::cursor_core::get_status_impl(core_state))
    } else {
        crate::commands::cursor_core::get_status_impl(core_state)
    }
}

#[tauri::command]
pub async fn cursor_add_models(
    _app: AppHandle,
    req: CursorAddModelsRequest,
    core_state: State<'_, crate::commands::cursor_core::CursorCoreState>,
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
                        ..Default::default()
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
                    ..Default::default()
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
            use_third_party_vision: false,
        });

        added_count += 1;
    }

    normalize_cursor_store(&mut cursor_store);
    crate::commands::proxy_routes::normalize_routes(&mut routes);

    // Atomic multi-file write
    write_routes(&routes)?;
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    // Attempt auto sync if Core is running
    let sync_status = sync_or_get_status(core_state.inner()).await;

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
    core_state: State<'_, crate::commands::cursor_core::CursorCoreState>,
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
    if let Some(use_tpv) = payload.use_third_party_vision {
        target.use_third_party_vision = use_tpv;
        let route_uid = target.route_uid.clone();
        crate::commands::store_io::update_proxy_routes(|routes| {
            if let Some(route) = routes.routes.iter_mut().find(|r| r.uid == route_uid) {
                route.enhancement.third_party_vision = use_tpv;
                Ok((true, ()))
            } else {
                Ok((false, ()))
            }
        })?;
    }

    normalize_cursor_store(&mut cursor_store);
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    let sync_status = sync_or_get_status(core_state.inner()).await;

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

#[tauri::command]
pub async fn cursor_set_models_third_party_vision(
    _app: AppHandle,
    ids: Vec<String>,
    enabled: bool,
    core_state: State<'_, crate::commands::cursor_core::CursorCoreState>,
) -> Result<CursorMutationResult, String> {
    let _guard = CONFIG_MUTEX
        .lock()
        .map_err(|e| format!("配置锁获取失败: {e}"))?;

    let mut cursor_store = read_cursor_store()?;
    let id_set: HashSet<String> = ids.into_iter().collect();
    let mut affected_route_uids = HashSet::new();

    for m in &mut cursor_store.models {
        if id_set.contains(&m.id) {
            m.use_third_party_vision = enabled;
            affected_route_uids.insert(m.route_uid.clone());
        }
    }

    crate::commands::store_io::update_proxy_routes(|routes| {
        let mut route_modified = false;
        for route in &mut routes.routes {
            if affected_route_uids.contains(&route.uid) {
                route.enhancement.third_party_vision = enabled;
                route_modified = true;
            }
        }
        Ok((route_modified, ()))
    })?;

    normalize_cursor_store(&mut cursor_store);
    write_cursor_store(&cursor_store)?;
    drop(_guard);

    let sync_status = sync_or_get_status(core_state.inner()).await;

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

#[tauri::command]
pub async fn cursor_remove_models(
    _app: AppHandle,
    ids: Vec<String>,
    core_state: State<'_, crate::commands::cursor_core::CursorCoreState>,
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

    let sync_status = sync_or_get_status(core_state.inner()).await;

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
    core_state: State<'_, crate::commands::cursor_core::CursorCoreState>,
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

    let sync_status = sync_or_get_status(core_state.inner()).await;

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderTagConfig {
    pub style: String,
    pub bracket_left: String,
    pub bracket_right: String,
}

#[tauri::command]
pub fn cursor_get_provider_tag_style() -> Result<CursorProviderTagConfig, String> {
    let store = read_cursor_store()?;
    let style = store.provider_tag_style.trim().to_lowercase();
    let valid_styles = ["prefix", "suffix", "badge", "none"];
    let final_style = if valid_styles.contains(&style.as_str()) {
        style
    } else {
        default_provider_tag_style()
    };
    let empty_both = store.provider_bracket_left.is_empty() && store.provider_bracket_right.is_empty();
    let bracket_left = if empty_both {
        default_bracket_left()
    } else {
        store.provider_bracket_left
    };
    let bracket_right = if empty_both {
        default_bracket_right()
    } else {
        store.provider_bracket_right
    };
    Ok(CursorProviderTagConfig {
        style: final_style,
        bracket_left,
        bracket_right,
    })
}

#[tauri::command]
pub async fn cursor_set_provider_tag_style(
    style: String,
    bracket_left: Option<String>,
    bracket_right: Option<String>,
    core_state: tauri::State<'_, crate::commands::cursor_core::CursorCoreState>,
) -> Result<CursorMutationResult, String> {
    let _guard = CONFIG_MUTEX.lock().map_err(|e| e.to_string())?;
    let mut store = read_cursor_store()?;
    let valid_styles = ["prefix", "suffix", "badge", "none"];
    let style = style.trim().to_lowercase();
    if !valid_styles.contains(&style.as_str()) {
        return Err(format!("未知的展示模式: {style}，可选值为 prefix、suffix、badge、none"));
    }

    store.provider_tag_style = style;
    if let Some(bl) = bracket_left {
        store.provider_bracket_left = bl;
    }
    if let Some(br) = bracket_right {
        store.provider_bracket_right = br;
    }
    normalize_cursor_store(&mut store);
    write_cursor_store(&store)?;
    drop(_guard);

    let sync_status = sync_or_get_status(core_state.inner()).await;

    Ok(CursorMutationResult {
        success: true,
        sync_status,
    })
}

