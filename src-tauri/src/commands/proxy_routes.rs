use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use super::config::config_dir_path;

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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
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
    #[serde(default)]
    pub preserve_extra_params: bool,
    #[serde(default = "default_true")]
    pub raw_provider_errors: bool,
    /// 系统提示词前缀，注入到请求的 system prompt 之前
    #[serde(default)]
    pub system_prompt_prefix: String,
    /// 自定义请求头，注入到上游请求
    #[serde(default)]
    pub custom_headers: Vec<HeaderPair>,
    /// 自定义响应头，注入到返回给客户端的响应
    #[serde(default)]
    pub response_headers: Vec<HeaderPair>,
    /// 请求参数覆盖，合并到上游请求体
    #[serde(default)]
    pub param_overrides: HashMap<String, serde_json::Value>,
    /// 工具过滤模式："" / "allow" / "deny"
    #[serde(default)]
    pub tool_filter_mode: String,
    /// 工具过滤名单
    #[serde(default)]
    pub tool_filter_list: Vec<String>,
    /// 强制 tool_choice（"" = 不覆盖）
    #[serde(default)]
    pub force_tool_choice: String,
    /// 每分钟请求数限制（0 = 不限制）
    #[serde(default)]
    pub rate_limit_rpm: u32,
    /// 是否记录请求/响应日志到文件
    #[serde(default)]
    pub request_logging: bool,
}

impl Default for ProxyRouteEnhancement {
    fn default() -> Self {
        Self {
            retry: true,
            auto_routing: true,
            third_party_vision: false,
            preserve_extra_params: false,
            raw_provider_errors: true,
            system_prompt_prefix: String::new(),
            custom_headers: Vec::new(),
            response_headers: Vec::new(),
            param_overrides: HashMap::new(),
            tool_filter_mode: String::new(),
            tool_filter_list: Vec::new(),
            force_tool_choice: String::new(),
            rate_limit_rpm: 0,
            request_logging: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteTarget {
    pub provider_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_format: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub unlock: String,
    /// 可选：覆盖供应商 API Key 的密钥列表，多个时轮换使用
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub api_keys: Vec<String>,
}

pub(crate) fn read_routes() -> Result<ProxyRoutes, String> {
    let path = proxy_routes_path();
    if !path.exists() {
        return Ok(ProxyRoutes {
            version: default_version(),
            default_model_id: String::new(),
            routes: Vec::new(),
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
    routes.default_model_id.clear();
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
        if route.exposed_formats.is_empty() {
            route.exposed_formats = default_exposed_formats();
        }
        for target in &mut route.targets {
            target.provider_id = target.provider_id.trim().to_string();
            target.model = target.model.trim().to_string();
            target.api_format = target.api_format.trim().to_string();
            if target.api_format == "auto" {
                target.api_format.clear();
            }
            target.api_path = target.api_path.trim().to_string();
            target.unlock = target.unlock.trim().to_string();
            target.api_keys = target
                .api_keys
                .iter()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
                .collect();
        }
    }
}

fn validate_routes(routes: &ProxyRoutes) -> Result<(), String> {
    let mut seen = HashSet::new();
    for route in &routes.routes {
        if route.id.trim().is_empty() {
            return Err("本地代理模型 ID 不能为空".into());
        }
        if !seen.insert(route.id.clone()) {
            return Err(format!("本地代理模型 ID 重复: {}", route.id));
        }
        for fmt in &route.exposed_formats {
            if !matches!(fmt.as_str(), "openai" | "anthropic" | "gemini") {
                return Err(format!(
                    "模型 {} 的接口兼容格式必须是 openai、anthropic 或 gemini",
                    route.id
                ));
            }
        }
        if route.enabled && route.targets.is_empty() {
            return Err(format!("模型 {} 已启用但没有上游目标", route.id));
        }
        for target in &route.targets {
            if target.provider_id.trim().is_empty() {
                return Err(format!("模型 {} 的目标供应商不能为空", route.id));
            }
            if target.model.trim().is_empty() {
                return Err(format!("模型 {} 的上游模型不能为空", route.id));
            }
            if !target.api_format.is_empty()
                && !matches!(target.api_format.as_str(), "openai" | "anthropic" | "gemini")
            {
                return Err(format!(
                    "模型 {} 的目标 apiFormat 必须是 openai、anthropic、gemini 或留空自动",
                    route.id
                ));
            }
        }
    }
    Ok(())
}

fn write_routes(routes: &ProxyRoutes) -> Result<(), String> {
    let dir = config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(routes).map_err(|e| e.to_string())?;
    super::write_atomic(&proxy_routes_path(), json.as_bytes())
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
