use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::config_dir_path;

mod normalize_and_sync;

pub use normalize_and_sync::{find_route_by_target, find_route_by_uid, normalize_routes};
#[allow(unused_imports)]
pub use normalize_and_sync::find_route_by_id;
pub(crate) use normalize_and_sync::{sync_provider_api_keys, validate_routes};
#[allow(unused_imports)]
pub(crate) use normalize_and_sync::{enabled_api_keys, sync_provider_api_keys_at};

use normalize_and_sync::salvage_routes;

pub(crate) fn proxy_routes_path() -> PathBuf {
    config_dir_path().join("proxy-routes.json")
}

pub(crate) fn codex_proxy_routes_path() -> PathBuf {
    config_dir_path().join("codex-proxy-routes.json")
}

pub(crate) fn default_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_exposed_formats() -> Vec<String> {
    vec!["openai".into(), "anthropic".into(), "gemini".into()]
}

fn default_source() -> String {
    "manual".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopBindings {
    #[serde(default)]
    pub sonnet: String,
    #[serde(default)]
    pub opus: String,
    #[serde(default)]
    pub haiku: String,
    #[serde(default)]
    pub fable: String,
    #[serde(default)]
    pub sonnet_name: String,
    #[serde(default)]
    pub opus_name: String,
    #[serde(default)]
    pub haiku_name: String,
    #[serde(default)]
    pub fable_name: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_desktop: Option<ClaudeDesktopBindings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoute {
    #[serde(default)]
    pub uid: String,
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub id_from_rename_rule: bool,
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_provider_id: String,
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

pub fn generate_route_uid(route: &ProxyRoute) -> String {
    let mut hasher = Sha256::new();
    hasher.update(route.id.trim().as_bytes());
    for target in &route.targets {
        hasher.update(target.provider_id.trim().as_bytes());
        hasher.update(target.model.trim().as_bytes());
    }
    let digest = hex::encode(hasher.finalize());
    format!("route-{}", &digest[..16])
}

fn empty_routes() -> ProxyRoutes {
    ProxyRoutes {
        version: default_version(),
        default_model_id: String::new(),
        routes: Vec::new(),
        claude_desktop: None,
    }
}

pub(crate) fn read_routes_from_unlocked(path: &std::path::Path) -> Result<ProxyRoutes, String> {
    if !path.exists() {
        return Ok(empty_routes());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut routes: ProxyRoutes = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if routes.version == 0 {
        routes.version = default_version();
    }
    let had_missing_uid = routes.routes.iter().any(|r| r.uid.trim().is_empty());
    normalize_routes(&mut routes);
    validate_routes(&routes)?;
    if had_missing_uid && path.exists() {
        let _ = write_routes_to_unlocked(path, &routes);
    }
    Ok(routes)
}

pub(crate) fn read_routes_from(path: PathBuf) -> Result<ProxyRoutes, String> {
    super::store_io::with_file_lock(&path, || read_routes_from_unlocked(&path))
}

pub(crate) fn read_routes() -> Result<ProxyRoutes, String> {
    read_routes_from(proxy_routes_path())
}

pub(crate) fn read_codex_routes() -> Result<ProxyRoutes, String> {
    read_routes_from(codex_proxy_routes_path())
}

pub(crate) fn write_routes_to_unlocked(
    path: &std::path::Path,
    routes: &ProxyRoutes,
) -> Result<(), String> {
    let dir = config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let json = serde_json::to_string_pretty(routes).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())
}

fn write_routes_to(path: PathBuf, routes: &ProxyRoutes) -> Result<(), String> {
    super::store_io::with_file_lock(&path, || write_routes_to_unlocked(&path, routes))
}

pub(crate) fn write_routes(routes: &ProxyRoutes) -> Result<(), String> {
    write_routes_to(proxy_routes_path(), routes)
}

#[tauri::command]
pub async fn load_proxy_routes() -> Result<ProxyRoutes, String> {
    tauri::async_runtime::spawn_blocking(read_routes)
        .await
        .map_err(|e| format!("读取路由配置任务失败: {e}"))?
}

#[tauri::command]
pub async fn save_proxy_routes(mut store: ProxyRoutes) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        store.version = default_version();
        normalize_routes(&mut store);
        validate_routes(&store)?;
        super::store_io::update_proxy_routes(|routes| {
            *routes = store;
            Ok((true, ()))
        })
    })
    .await
    .map_err(|e| format!("保存路由配置任务失败: {e}"))?
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoutesRepairReport {
    /// 隔离备份出来的原文件路径（原本就没有文件时为空）
    pub backup_path: String,
    /// 抢救下来并保留的模型条数
    pub kept: usize,
    /// 被丢弃或停用的模型条数
    pub fixed: usize,
    /// 修复方式说明，直接展示给用户
    pub message: String,
}

/// 自我修复：路由文件损坏或校验不过时，先把原文件隔离备份（绝不丢用户原始数据），
/// 再尽量抢救出可用条目重写。用于把"加载失败 → 保存被拦"自动解开，而不是弹错误框烦用户。
#[tauri::command]
pub async fn repair_proxy_routes() -> Result<ProxyRoutesRepairReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = proxy_routes_path();
        super::store_io::with_file_lock(&path, || {
            let mut report = ProxyRoutesRepairReport::default();

            if !path.exists() {
                write_routes_to_unlocked(&path, &empty_routes())?;
                report.message = "配置文件不存在，已重建空列表".to_string();
                return Ok(report);
            }

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let backup = PathBuf::from(format!("{}.corrupt.{}", path.to_string_lossy(), now));
            fs::copy(&path, &backup)
                .map_err(|e| format!("备份损坏的内置模型路由配置失败: {}", e))?;
            report.backup_path = backup.to_string_lossy().to_string();

            let parsed = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<ProxyRoutes>(&raw).ok());

            let mut routes = match parsed {
                Some(routes) => routes,
                None => {
                    write_routes_to_unlocked(&path, &empty_routes())?;
                    report.message = "原配置文件无法解析，已重建为空列表".to_string();
                    return Ok(report);
                }
            };

            let (kept, fixed) = salvage_routes(&mut routes);
            report.kept = kept;
            report.fixed = fixed;
            if routes.version == 0 {
                routes.version = default_version();
            }
            normalize_routes(&mut routes);
            validate_routes(&routes).map_err(|e| format!("修复后的配置仍不合法: {}", e))?;
            write_routes_to_unlocked(&path, &routes)?;
            report.message = format!("已恢复 {} 个模型，停用或丢弃 {} 个无效条目", kept, fixed);
            Ok(report)
        })
    })
    .await
    .map_err(|e| format!("修复路由配置任务失败: {e}"))?
}

#[tauri::command]
pub async fn load_claude_desktop_bindings() -> Result<Option<ClaudeDesktopBindings>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let routes = read_routes()?;
        Ok(routes.claude_desktop)
    })
    .await
    .map_err(|e| format!("读取 Claude Desktop 绑定任务失败: {e}"))?
}

#[tauri::command]
pub async fn save_claude_desktop_bindings(bindings: ClaudeDesktopBindings) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::store_io::update_proxy_routes(|store| {
            store.claude_desktop = Some(bindings);
            Ok((true, ()))
        })
    })
    .await
    .map_err(|e| format!("保存 Claude Desktop 绑定任务失败: {e}"))?
}

#[cfg(test)]
mod tests;
