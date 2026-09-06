use crate::model::{ModelConfigInput, ModelType};
use serde::Deserialize;
use std::path::Path;

pub const ANYBRIDGE_GATEWAY_KEY_SENTINEL: &str = "__ANYBRIDGE_LOCAL_GATEWAY_KEY__";

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorModelsStore {
    #[serde(default)]
    models: Vec<CursorModelBinding>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorModelBinding {
    #[serde(default)]
    _id: String,
    #[serde(default)]
    route_uid: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    exposed_model_id: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    sort_order: i64,
    #[serde(default)]
    cursor_overrides: CursorModelOverrides,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorModelOverrides {
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    context_window_tokens: Option<u64>,
    #[serde(default)]
    max_completion_tokens: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProxyRoutes {
    #[serde(default)]
    routes: Vec<ProxyRoute>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProxyRoute {
    #[serde(default)]
    uid: String,
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    exposed_formats: Vec<String>,
    #[serde(default)]
    capabilities: RouteCapabilities,
    #[serde(default)]
    targets: Vec<RouteTarget>,
}

#[derive(Debug, Default, Deserialize)]
struct RouteCapabilities {
    #[serde(default)]
    reasoning: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteTarget {
    #[serde(default, rename = "providerId")]
    provider_id: String,
    #[serde(default)]
    _model: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProvidersStore {
    #[serde(default)]
    providers: Vec<ProviderEntry>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProviderEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

fn load_providers_map(routes_path: &Path) -> std::collections::HashMap<String, String> {
    let candidates = [
        std::env::var("ANYBRIDGE_PROVIDERS_PATH").ok().map(std::path::PathBuf::from),
        std::env::var("ANYBRIDGE_CONFIG_DIR").ok().map(|d| std::path::PathBuf::from(d).join("providers.json")),
        routes_path.parent().map(|p| p.join("providers.json")),
    ];

    for path in candidates.into_iter().flatten() {
        if path.exists() {
            if let Ok(data) = std::fs::read(&path) {
                if let Ok(store) = serde_json::from_slice::<ProvidersStore>(&data) {
                    let map: std::collections::HashMap<String, String> = store
                        .providers
                        .into_iter()
                        .filter(|p| !p.id.is_empty() && !p.name.trim().is_empty())
                        .map(|p| (p.id, p.name.trim().to_string()))
                        .collect();
                    if !map.is_empty() {
                        return map;
                    }
                }
            }
        }
    }
    std::collections::HashMap::new()
}

fn resolve_provider_name(
    route: &ProxyRoute,
    providers_map: &std::collections::HashMap<String, String>,
) -> String {
    for target in &route.targets {
        if let Some(name) = providers_map.get(&target.provider_id) {
            if !name.trim().is_empty() {
                return name.trim().to_string();
            }
        }
    }
    "AnyBridge".to_string()
}

fn default_true() -> bool {
    true
}

pub fn model_inputs_from_bindings(
    cursor_models_path: Option<&Path>,
    routes_path: &Path,
    gateway_url: &str,
    gateway_key: &str,
) -> crate::Result<Vec<ModelConfigInput>> {
    let gateway = reqwest::Url::parse(gateway_url)
        .map_err(|error| crate::Error::Config(format!("invalid AnyBridge gateway URL: {error}")))?;
    let loopback = match gateway.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if !loopback || !matches!(gateway.scheme(), "http" | "https") {
        return Err(crate::Error::Config(
            "AnyBridge gateway URL must use HTTP(S) on a loopback host".into(),
        ));
    }
    if gateway_key.trim().is_empty() {
        return Err(crate::Error::Config(
            "AnyBridge local gateway key is missing".into(),
        ));
    }

    let base_url = gateway.as_str().trim_end_matches('/').to_string();

    let routes_data = std::fs::read(routes_path)?;
    let routes_store: ProxyRoutes = serde_json::from_slice(&routes_data)?;
    let providers_map = load_providers_map(routes_path);

    if let Some(cursor_path) = cursor_models_path {
        if cursor_path.exists() {
            if let Ok(cursor_data) = std::fs::read(cursor_path) {
                if let Ok(cursor_store) = serde_json::from_slice::<CursorModelsStore>(&cursor_data) {
                    let mut models = Vec::new();
                    for binding in cursor_store.models.into_iter().filter(|m| m.enabled) {
                        let matching_route = routes_store.routes.iter().find(|r| {
                            (!r.uid.is_empty() && r.uid == binding.route_uid)
                                || r.id == binding.route_uid
                        });

                        if let Some(route) = matching_route {
                            if !route.enabled || route.targets.is_empty() {
                                continue;
                            }

                            let display_name = if !binding.display_name.trim().is_empty() {
                                binding.display_name.trim().to_string()
                            } else if !route.display_name.trim().is_empty() {
                                route.display_name.trim().to_string()
                            } else {
                                binding.exposed_model_id.trim().to_string()
                            };

                            let reasoning_effort = binding
                                .cursor_overrides
                                .reasoning_effort
                                .or_else(|| route.capabilities.reasoning.then(|| "high".into()));

                            let provider_name = resolve_provider_name(route, &providers_map);

                            models.push(ModelConfigInput {
                                sort_order: binding.sort_order,
                                display_name,
                                group_name: Some(provider_name),
                                model_type: ModelType::OpenAi,
                                base_url: base_url.clone(),
                                use_full_url: false,
                                api_key: ANYBRIDGE_GATEWAY_KEY_SENTINEL.into(),
                                tooltip_data: "由 AnyBridge 本地模型路由提供".into(),
                                model_id: binding.exposed_model_id.trim().to_string(),
                                reasoning_effort,
                                openai_endpoint: crate::model::OPENAI_RESPONSES_ENDPOINT.into(),
                                openai_extra_params_enabled: false,
                                openai_extra_params: serde_json::json!({}),
                                custom_headers_enabled: false,
                                custom_headers: serde_json::json!({}),
                                anthropic_extra_params_enabled: false,
                                anthropic_extra_params: serde_json::json!({}),
                                context_window_tokens: binding.cursor_overrides.context_window_tokens,
                                max_completion_tokens: binding.cursor_overrides.max_completion_tokens,
                                anthropic_max_tokens: None,
                                anthropic_thinking_effort: None,
                                thinking_budget_tokens: None,
                            });
                        }
                    }

                    return Ok(models);
                }
            }
        }
    }

    let models = routes_store
        .routes
        .into_iter()
        .filter(|route| {
            route.enabled
                && !route.id.trim().is_empty()
                && !route.targets.is_empty()
                && route
                    .exposed_formats
                    .iter()
                    .any(|format| format.eq_ignore_ascii_case("openai"))
        })
        .enumerate()
        .map(|(index, route)| {
            let provider_name = resolve_provider_name(&route, &providers_map);
            ModelConfigInput {
                sort_order: i64::try_from(index + 1).unwrap_or(i64::MAX),
                display_name: if route.display_name.trim().is_empty() {
                    route.id.clone()
                } else {
                    route.display_name.trim().to_string()
                },
                group_name: Some(provider_name),
            model_type: ModelType::OpenAi,
            base_url: base_url.clone(),
            use_full_url: false,
            api_key: ANYBRIDGE_GATEWAY_KEY_SENTINEL.into(),
            tooltip_data: "由 AnyBridge 本地模型路由提供".into(),
            model_id: route.id.trim().to_string(),
            reasoning_effort: route.capabilities.reasoning.then(|| "high".into()),
            openai_endpoint: crate::model::OPENAI_RESPONSES_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: None,
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }})
        .collect();
    Ok(models)
}

pub fn model_inputs_from_routes(
    path: &Path,
    gateway_url: &str,
    gateway_key: &str,
) -> crate::Result<Vec<ModelConfigInput>> {
    model_inputs_from_bindings(None, path, gateway_url, gateway_key)
}

pub async fn sync_routes_to_store(
    store: &crate::store::Store,
    routes_path: &Path,
    cursor_models_path: Option<&Path>,
    gateway_url: &str,
    gateway_key: &str,
) -> crate::Result<Vec<crate::model::ModelConfig>> {
    let models = model_inputs_from_bindings(cursor_models_path, routes_path, gateway_url, gateway_key)?;
    store.replace_models(&models).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_only_enabled_openai_routes_without_provider_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("proxy-routes.json");
        std::fs::write(
            &path,
            r#"{
              "version": 1,
              "routes": [
                {
                  "uid": "route-1",
                  "id": "claude-sonnet",
                  "displayName": "Claude Sonnet",
                  "enabled": true,
                  "exposedFormats": ["openai", "anthropic"],
                  "capabilities": { "reasoning": true },
                  "targets": [{
                    "providerId": "secret-provider",
                    "model": "secret-upstream-model",
                    "apiKeys": ["must-not-leak"]
                  }]
                },
                {
                  "uid": "route-2",
                  "id": "disabled",
                  "enabled": false,
                  "exposedFormats": ["openai"],
                  "targets": [{"providerId": "p", "model": "m"}]
                },
                {
                  "uid": "route-3",
                  "id": "anthropic-only",
                  "enabled": true,
                  "exposedFormats": ["anthropic"],
                  "targets": [{"providerId": "p", "model": "m"}]
                }
              ]
            }"#,
        )
        .unwrap();

        let models = model_inputs_from_routes(
            &path,
            "http://127.0.0.1:7450",
            "local-gateway-key",
        )
        .unwrap();

        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.display_name, "Claude Sonnet");
        assert_eq!(model.model_id, "claude-sonnet");
        assert_eq!(model.base_url, "http://127.0.0.1:7450");
        assert_eq!(model.api_key, ANYBRIDGE_GATEWAY_KEY_SENTINEL);
        assert_eq!(model.openai_endpoint, "/v1/responses");
        assert!(!serde_json::to_string(model).unwrap().contains("local-gateway-key"));
        assert_eq!(model.reasoning_effort.as_deref(), Some("high"));
        let serialized = serde_json::to_string(model).unwrap();
        assert!(!serialized.contains("secret-provider"));
        assert!(!serialized.contains("secret-upstream-model"));
        assert!(!serialized.contains("must-not-leak"));
    }

    #[test]
    fn converts_cursor_bindings_accurately() {
        let directory = tempfile::tempdir().unwrap();
        let routes_path = directory.path().join("proxy-routes.json");
        let cursor_path = directory.path().join("cursor-models.json");

        std::fs::write(
            &routes_path,
            r#"{
              "version": 1,
              "routes": [
                {
                  "uid": "r-1",
                  "id": "shared-opus",
                  "displayName": "Global Opus",
                  "enabled": true,
                  "exposedFormats": ["openai"],
                  "capabilities": { "reasoning": true },
                  "targets": [{"providerId": "openrouter", "model": "opus"}]
                },
                {
                  "uid": "r-2",
                  "id": "shared-gpt",
                  "displayName": "Global GPT",
                  "enabled": true,
                  "exposedFormats": ["openai"],
                  "capabilities": { "reasoning": false },
                  "targets": [{"providerId": "openai", "model": "gpt-4o"}]
                }
              ]
            }"#,
        )
        .unwrap();

        std::fs::write(
            &cursor_path,
            r#"{
              "version": 1,
              "models": [
                {
                  "id": "cb-1",
                  "routeUid": "r-1",
                  "displayName": "Cursor Custom Opus",
                  "exposedModelId": "my-opus",
                  "enabled": true,
                  "sortOrder": 1,
                  "cursorOverrides": {
                    "reasoningEffort": "max",
                    "contextWindowTokens": 200000
                  }
                },
                {
                  "id": "cb-2",
                  "routeUid": "r-2",
                  "displayName": "Disabled in Cursor",
                  "exposedModelId": "my-gpt",
                  "enabled": false,
                  "sortOrder": 2
                }
              ]
            }"#,
        )
        .unwrap();

        let models = model_inputs_from_bindings(
            Some(&cursor_path),
            &routes_path,
            "http://127.0.0.1:7450",
            "local-gateway-key",
        )
        .unwrap();

        assert_eq!(models.len(), 1);
        let m = &models[0];
        assert_eq!(m.display_name, "Cursor Custom Opus");
        assert_eq!(m.model_id, "my-opus");
        assert_eq!(m.reasoning_effort.as_deref(), Some("max"));
        assert_eq!(m.context_window_tokens, Some(200000));
    }

    #[test]
    fn rejects_non_loopback_gateway_urls() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("proxy-routes.json");
        std::fs::write(&path, r#"{"routes": []}"#).unwrap();

        let error = model_inputs_from_routes(&path, "https://example.com", "key").unwrap_err();
        assert!(error.to_string().contains("loopback"));
    }
}

