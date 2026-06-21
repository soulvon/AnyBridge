use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use super::config::config_dir_path;
use super::model_map;

fn proxy_routes_path() -> PathBuf {
    config_dir_path().join("proxy-routes.json")
}

fn default_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_exposed_formats() -> Vec<String> {
    vec!["openai".into(), "anthropic".into()]
}

fn default_source() -> String {
    "manual".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoutes {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub default_model_id: String,
    #[serde(default)]
    pub routes: Vec<ProxyRoute>,
    #[serde(default, skip_serializing)]
    pub compat_from_model_map: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoute {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_exposed_formats")]
    pub exposed_formats: Vec<String>,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub capabilities: ProxyRouteCapabilities,
    #[serde(default)]
    pub enhancement: ProxyRouteEnhancement,
    #[serde(default)]
    pub targets: Vec<ProxyRouteTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteCapabilities {
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteEnhancement {
    #[serde(default = "default_true")]
    pub retry: bool,
    #[serde(default = "default_true")]
    pub auto_routing: bool,
    #[serde(default)]
    pub third_party_vision: bool,
}

impl Default for ProxyRouteEnhancement {
    fn default() -> Self {
        Self {
            retry: true,
            auto_routing: true,
            third_party_vision: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteTarget {
    pub provider_id: String,
    pub model: String,
    pub api_format: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub unlock: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoutesImportResult {
    pub store: ProxyRoutes,
    pub imported: usize,
    pub skipped: usize,
}

pub(crate) fn read_routes() -> Result<ProxyRoutes, String> {
    let path = proxy_routes_path();
    if !path.exists() {
        return Ok(ProxyRoutes {
            version: default_version(),
            default_model_id: String::new(),
            routes: Vec::new(),
            compat_from_model_map: true,
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut routes: ProxyRoutes = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if routes.version == 0 {
        routes.version = default_version();
    }
    normalize_routes(&mut routes);
    validate_routes(&routes)?;
    Ok(routes)
}

fn normalize_routes(routes: &mut ProxyRoutes) {
    for route in &mut routes.routes {
        route.id = route.id.trim().to_string();
        route.display_name = route.display_name.trim().to_string();
        route.source = route.source.trim().to_string();
        if route.source.is_empty() {
            route.source = default_source();
        }
        route.exposed_formats = route
            .exposed_formats
            .iter()
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        for target in &mut route.targets {
            target.provider_id = target.provider_id.trim().to_string();
            target.model = target.model.trim().to_string();
            target.api_format = target.api_format.trim().to_string();
            target.api_path = target.api_path.trim().to_string();
            target.unlock = target.unlock.trim().to_string();
        }
    }
}

fn validate_routes(routes: &ProxyRoutes) -> Result<(), String> {
    let mut seen = HashSet::new();
    for route in &routes.routes {
        if route.id.trim().is_empty() {
            return Err("本地代理模型路由 ID 不能为空".into());
        }
        if !seen.insert(route.id.clone()) {
            return Err(format!("本地代理模型路由 ID 重复: {}", route.id));
        }
        if route.exposed_formats.is_empty() {
            return Err(format!("模型路由 {} 至少需要暴露一个入口", route.id));
        }
        for fmt in &route.exposed_formats {
            if !matches!(fmt.as_str(), "openai" | "anthropic") {
                return Err(format!(
                    "模型路由 {} 的暴露入口必须是 openai 或 anthropic",
                    route.id
                ));
            }
        }
        if route.enabled && route.targets.is_empty() {
            return Err(format!("模型路由 {} 已启用但没有目标", route.id));
        }
        for target in &route.targets {
            if target.provider_id.trim().is_empty() {
                return Err(format!("模型路由 {} 的目标供应商不能为空", route.id));
            }
            if target.model.trim().is_empty() {
                return Err(format!("模型路由 {} 的目标模型不能为空", route.id));
            }
            if !matches!(target.api_format.as_str(), "openai" | "anthropic") {
                return Err(format!(
                    "模型路由 {} 的目标 apiFormat 必须是 openai 或 anthropic",
                    route.id
                ));
            }
        }
    }
    if !routes.default_model_id.trim().is_empty()
        && !routes
            .routes
            .iter()
            .any(|route| route.id == routes.default_model_id && route.enabled)
    {
        return Err(format!(
            "默认模型路由不存在或未启用: {}",
            routes.default_model_id
        ));
    }
    Ok(())
}

fn write_routes(routes: &ProxyRoutes) -> Result<(), String> {
    let dir = config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(routes).map_err(|e| e.to_string())?;
    super::write_atomic(&proxy_routes_path(), json.as_bytes())
}

fn imported_api_format(api_format: Option<&String>, unlock: Option<&String>) -> String {
    let fmt = api_format.map(|v| v.trim()).unwrap_or("");
    if matches!(fmt, "openai" | "anthropic") {
        return fmt.to_string();
    }
    match unlock.map(|v| v.trim()).unwrap_or("") {
        "codex" => "openai".into(),
        "claudeCode" | "claude-code" | "claude_code" => "anthropic".into(),
        _ => String::new(),
    }
}

#[tauri::command]
pub fn load_proxy_routes() -> Result<ProxyRoutes, String> {
    read_routes()
}

#[tauri::command]
pub fn save_proxy_routes(mut store: ProxyRoutes) -> Result<(), String> {
    store.version = default_version();
    normalize_routes(&mut store);
    validate_routes(&store)?;
    write_routes(&store)
}

fn route_from_slot(slot: &model_map::Slot) -> Option<ProxyRoute> {
    if slot.enabled == false || slot.targets.is_empty() {
        return None;
    }
    let targets = slot
        .targets
        .iter()
        .map(|target| ProxyRouteTarget {
            provider_id: target.provider_id.clone(),
            model: target.model.clone(),
            api_format: imported_api_format(target.api_format.as_ref(), target.unlock.as_ref()),
            api_path: target.api_path.clone().unwrap_or_default(),
            unlock: target.unlock.clone().unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    Some(ProxyRoute {
        id: slot.model_uid.clone(),
        display_name: if slot.display_name.trim().is_empty() {
            slot.model_uid.clone()
        } else {
            slot.display_name.clone()
        },
        enabled: true,
        exposed_formats: default_exposed_formats(),
        source: "imported:model-map".into(),
        capabilities: ProxyRouteCapabilities {
            stream: true,
            tools: false,
            vision: slot.supports_images,
            reasoning: false,
        },
        enhancement: ProxyRouteEnhancement {
            retry: true,
            auto_routing: true,
            third_party_vision: slot.use_third_party_vision,
        },
        targets,
    })
}

fn route_from_injected(item: &model_map::InjectedSlot) -> Option<ProxyRoute> {
    let provider_id = item.provider_id.as_deref().unwrap_or("").trim();
    let model = item.model.as_deref().unwrap_or("").trim();
    if provider_id.is_empty() || model.is_empty() {
        return None;
    }
    Some(ProxyRoute {
        id: item.model_uid.clone(),
        display_name: item.label.clone(),
        enabled: true,
        exposed_formats: default_exposed_formats(),
        source: "imported:model-map".into(),
        capabilities: ProxyRouteCapabilities {
            stream: true,
            tools: false,
            vision: item.supports_images,
            reasoning: false,
        },
        enhancement: ProxyRouteEnhancement::default(),
        targets: vec![ProxyRouteTarget {
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            api_format: imported_api_format(item.api_format.as_ref(), item.unlock.as_ref()),
            api_path: item.api_path.clone().unwrap_or_default(),
            unlock: item.unlock.clone().unwrap_or_default(),
        }],
    })
}

#[tauri::command]
pub fn import_proxy_routes_from_model_map() -> Result<ProxyRoutesImportResult, String> {
    let map = model_map::read_map()?;
    let mut store = read_routes()?;
    store.compat_from_model_map = false;
    let mut seen = store
        .routes
        .iter()
        .map(|route| route.id.clone())
        .collect::<HashSet<_>>();
    let mut imported = 0usize;
    let mut skipped = 0usize;

    for slot in &map.slots {
        let Some(route) = route_from_slot(slot) else {
            continue;
        };
        if seen.insert(route.id.clone()) {
            store.routes.push(route);
            imported += 1;
        } else {
            skipped += 1;
        }
    }

    for item in &map.injected {
        let Some(route) = route_from_injected(item) else {
            continue;
        };
        if seen.insert(route.id.clone()) {
            store.routes.push(route);
            imported += 1;
        } else {
            skipped += 1;
        }
    }

    if store.default_model_id.trim().is_empty() {
        if let Some(first) = store.routes.iter().find(|route| route.enabled) {
            store.default_model_id = first.id.clone();
        }
    }
    normalize_routes(&mut store);
    validate_routes(&store)?;
    write_routes(&store)?;
    Ok(ProxyRoutesImportResult {
        store,
        imported,
        skipped,
    })
}
