use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::config_dir_path;

pub(crate) fn proxy_routes_path() -> PathBuf {
    config_dir_path().join("proxy-routes.json")
}

fn codex_proxy_routes_path() -> PathBuf {
    config_dir_path().join("codex-proxy-routes.json")
}

fn default_version() -> u32 {
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

pub(crate) fn read_routes_from(path: PathBuf) -> Result<ProxyRoutes, String> {
    if !path.exists() {
        return Ok(empty_routes());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut routes: ProxyRoutes = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if routes.version == 0 {
        routes.version = default_version();
    }
    let had_missing_uid = routes.routes.iter().any(|r| r.uid.trim().is_empty());
    normalize_routes(&mut routes);
    validate_routes(&routes)?;
    if had_missing_uid && path.exists() {
        let _ = write_routes_to(path, &routes);
    }
    Ok(routes)
}

pub(crate) fn read_routes() -> Result<ProxyRoutes, String> {
    read_routes_from(proxy_routes_path())
}

pub(crate) fn read_codex_routes() -> Result<ProxyRoutes, String> {
    read_routes_from(codex_proxy_routes_path())
}

pub fn normalize_routes(routes: &mut ProxyRoutes) {
    routes.default_model_id.clear();
    for route in &mut routes.routes {
        route.id = route.id.trim().to_string();
        if route.uid.trim().is_empty() {
            route.uid = generate_route_uid(route);
        } else {
            route.uid = route.uid.trim().to_string();
        }
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
            target.unlock = match target.unlock.trim() {
                "claude-code" | "claude_code" => "claudeCode".to_string(),
                other => other.to_string(),
            };
            target.api_keys = target
                .api_keys
                .iter()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
                .collect();
        }
    }
    if let Some(cd) = routes.claude_desktop.as_mut() {
        cd.sonnet = cd.sonnet.trim().to_string();
        cd.opus = cd.opus.trim().to_string();
        cd.haiku = cd.haiku.trim().to_string();
        cd.fable = cd.fable.trim().to_string();
        cd.sonnet_name = cd.sonnet_name.trim().to_string();
        cd.opus_name = cd.opus_name.trim().to_string();
        cd.haiku_name = cd.haiku_name.trim().to_string();
        cd.fable_name = cd.fable_name.trim().to_string();
    }
}

pub fn find_route_by_uid<'a>(routes: &'a ProxyRoutes, uid: &str) -> Option<&'a ProxyRoute> {
    let clean = uid.trim();
    if clean.is_empty() {
        return None;
    }
    routes.routes.iter().find(|r| r.uid == clean)
}

#[allow(dead_code)]
pub fn find_route_by_id<'a>(routes: &'a ProxyRoutes, id: &str) -> Option<&'a ProxyRoute> {
    let clean = id.trim();
    if clean.is_empty() {
        return None;
    }
    routes.routes.iter().find(|r| r.id == clean)
}

pub fn find_route_by_target<'a>(
    routes: &'a ProxyRoutes,
    provider_id: &str,
    model: &str,
) -> Option<&'a ProxyRoute> {
    let p = provider_id.trim();
    let m = model.trim();
    if p.is_empty() || m.is_empty() {
        return None;
    }
    routes.routes.iter().find(|r| {
        r.targets
            .iter()
            .any(|t| t.provider_id == p && t.model == m)
    })
}

fn validate_routes(routes: &ProxyRoutes) -> Result<(), String> {
    let mut seen_ids = HashSet::new();
    let mut seen_uids = HashSet::new();
    for route in &routes.routes {
        if route.id.trim().is_empty() {
            return Err("本地代理模型 ID 不能为空".into());
        }
        if !seen_ids.insert(route.id.clone()) {
            return Err(format!("本地代理模型 ID 重复: {}", route.id));
        }
        if !route.uid.trim().is_empty() && !seen_uids.insert(route.uid.clone()) {
            return Err(format!("本地代理模型 UID 重复: {}", route.uid));
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
                && !matches!(
                    target.api_format.as_str(),
                    "openai" | "anthropic" | "gemini"
                )
            {
                return Err(format!(
                    "模型 {} 的目标 apiFormat 必须是 openai、anthropic、gemini 或留空自动",
                    route.id
                ));
            }
            if !target.unlock.is_empty()
                && !matches!(target.unlock.as_str(), "codex" | "claudeCode")
            {
                return Err(format!(
                    "模型 {} 的目标解锁类型必须是 codex、claudeCode 或留空",
                    route.id
                ));
            }
            if target.unlock == "codex"
                && !target.api_format.is_empty()
                && target.api_format != "openai"
            {
                return Err(format!(
                    "模型 {} 的 Codex 解锁目标必须使用 openai 协议或留空自动",
                    route.id
                ));
            }
            if target.unlock == "claudeCode"
                && !target.api_format.is_empty()
                && target.api_format != "anthropic"
            {
                return Err(format!(
                    "模型 {} 的 Claude Code 解锁目标必须使用 anthropic 协议或留空自动",
                    route.id
                ));
            }
        }
    }
    Ok(())
}

fn write_routes_to(path: PathBuf, routes: &ProxyRoutes) -> Result<(), String> {
    let dir = config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(routes).map_err(|e| e.to_string())?;
    super::write_atomic(&path, json.as_bytes())
}

pub(crate) fn write_routes(routes: &ProxyRoutes) -> Result<(), String> {
    write_routes_to(proxy_routes_path(), routes)
}

pub(crate) fn write_codex_routes(routes: &ProxyRoutes) -> Result<(), String> {
    write_routes_to(codex_proxy_routes_path(), routes)
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

/// 把供应商的多密钥池同步到引用它的路由目标。
///
/// 供应商池是「这家供应商有哪些可用密钥」的唯一真源：
/// - 池非空 → 覆盖路由目标上的 `apiKeys`，让 sidecar 的请求级轮换拿得到；
/// - 池为空 → 不动路由，避免把用户在路由编辑器里单独配置的密钥清掉。
///
/// 返回被更新的目标数量，供调用方记录。
pub(crate) fn sync_provider_api_keys(providers: &[super::config::Provider]) -> Result<usize, String> {
    if providers.is_empty() {
        return Ok(0);
    }
    let mut routes = read_routes()?;
    let mut changed = 0usize;
    for route in &mut routes.routes {
        for target in &mut route.targets {
            let Some(provider) = providers.iter().find(|p| p.id == target.provider_id) else {
                continue;
            };
            let keys: Vec<String> = provider
                .api_keys
                .iter()
                .filter(|entry| entry.enabled)
                .map(|entry| entry.key.trim().to_string())
                .filter(|key| !key.is_empty())
                .collect();
            if keys.is_empty() || target.api_keys == keys {
                continue;
            }
            target.api_keys = keys;
            changed += 1;
        }
    }
    if changed > 0 {
        write_routes(&routes)?;
    }
    Ok(changed)
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

/// 抢救：去重、丢掉没有 ID 的条目、把没有上游目标的条目停用（而不是删除，保留用户配置），
/// 并清掉非法的接口格式/解锁组合，保证结果一定能过 validate_routes。
fn salvage_routes(routes: &mut ProxyRoutes) -> (usize, usize) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut kept = 0usize;
    let mut fixed = 0usize;
    let mut out = Vec::with_capacity(routes.routes.len());
    for mut route in std::mem::take(&mut routes.routes) {
        let id = route.id.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            fixed += 1;
            continue;
        }
        // 历史 uid 可能重复，清空后由 normalize_routes 按 id+目标重新生成
        route.uid.clear();
        for target in &mut route.targets {
            if !matches!(
                target.api_format.as_str(),
                "" | "openai" | "anthropic" | "gemini"
            ) {
                target.api_format.clear();
                fixed += 1;
            }
            if !matches!(target.unlock.as_str(), "" | "codex" | "claudeCode") {
                target.unlock.clear();
                fixed += 1;
            }
            if target.unlock == "codex" && target.api_format == "anthropic" {
                target.api_format.clear();
                fixed += 1;
            }
            if target.unlock == "claudeCode" && target.api_format == "openai" {
                target.api_format.clear();
                fixed += 1;
            }
        }
        route
            .targets
            .retain(|t| !t.provider_id.trim().is_empty() && !t.model.trim().is_empty());
        if route.enabled && route.targets.is_empty() {
            route.enabled = false;
            fixed += 1;
        }
        if route
            .exposed_formats
            .iter()
            .any(|f| !matches!(f.as_str(), "openai" | "anthropic" | "gemini"))
        {
            route
                .exposed_formats
                .retain(|f| matches!(f.as_str(), "openai" | "anthropic" | "gemini"));
            fixed += 1;
        }
        out.push(route);
        kept += 1;
    }
    routes.routes = out;
    (kept, fixed)
}

/// 自我修复：路由文件损坏或校验不过时，先把原文件隔离备份（绝不丢用户原始数据），
/// 再尽量抢救出可用条目重写。用于把"加载失败 → 保存被拦"自动解开，而不是弹错误框烦用户。
#[tauri::command]
pub fn repair_proxy_routes() -> Result<ProxyRoutesRepairReport, String> {
    let path = proxy_routes_path();
    let mut report = ProxyRoutesRepairReport::default();

    if !path.exists() {
        write_routes(&empty_routes())?;
        report.message = "配置文件不存在，已重建空列表".to_string();
        return Ok(report);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup = PathBuf::from(format!("{}.corrupt.{}", path.to_string_lossy(), now));
    fs::copy(&path, &backup).map_err(|e| format!("备份损坏的代理路由配置失败: {}", e))?;
    report.backup_path = backup.to_string_lossy().to_string();

    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ProxyRoutes>(&raw).ok());

    let mut routes = match parsed {
        Some(routes) => routes,
        None => {
            write_routes(&empty_routes())?;
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
    write_routes(&routes)?;
    report.message = format!("已恢复 {} 个模型，停用或丢弃 {} 个无效条目", kept, fixed);
    Ok(report)
}

#[tauri::command]
pub fn load_claude_desktop_bindings() -> Result<Option<ClaudeDesktopBindings>, String> {
    let routes = read_routes()?;
    Ok(routes.claude_desktop)
}

#[tauri::command]
pub fn save_claude_desktop_bindings(bindings: ClaudeDesktopBindings) -> Result<(), String> {
    let mut store = read_routes()?;
    store.claude_desktop = Some(bindings);
    normalize_routes(&mut store);
    validate_routes(&store)?;
    write_routes(&store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_routes_receive_deterministic_uid() {
        let mut routes = ProxyRoutes {
            version: 1,
            default_model_id: String::new(),
            routes: vec![ProxyRoute {
                id: "gpt-4o".into(),
                targets: vec![ProxyRouteTarget {
                    provider_id: "openai".into(),
                    model: "gpt-4o-2024-08-06".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            claude_desktop: None,
        };

        normalize_routes(&mut routes);
        assert!(!routes.routes[0].uid.is_empty());
        assert!(routes.routes[0].uid.starts_with("route-"));

        let first_uid = routes.routes[0].uid.clone();
        routes.routes[0].uid = String::new();
        normalize_routes(&mut routes);
        assert_eq!(routes.routes[0].uid, first_uid);
    }

    #[test]
    fn existing_uid_is_preserved_even_when_id_renamed() {
        let mut routes = ProxyRoutes {
            version: 1,
            default_model_id: String::new(),
            routes: vec![ProxyRoute {
                uid: "route-custom-12345".into(),
                id: "gpt-4o-renamed".into(),
                targets: vec![ProxyRouteTarget {
                    provider_id: "openai".into(),
                    model: "gpt-4o".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            claude_desktop: None,
        };

        normalize_routes(&mut routes);
        assert_eq!(routes.routes[0].uid, "route-custom-12345");
    }

    #[test]
    fn different_targets_produce_different_uids() {
        let r1 = ProxyRoute {
            id: "model-a".into(),
            targets: vec![ProxyRouteTarget {
                provider_id: "p1".into(),
                model: "m1".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let r2 = ProxyRoute {
            id: "model-a".into(),
            targets: vec![ProxyRouteTarget {
                provider_id: "p2".into(),
                model: "m1".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_ne!(generate_route_uid(&r1), generate_route_uid(&r2));
    }

    #[test]
    fn claude_desktop_bindings_roundtrip() {
        let mut routes = ProxyRoutes {
            version: 1,
            default_model_id: String::new(),
            routes: vec![],
            claude_desktop: Some(ClaudeDesktopBindings {
                sonnet: " route-sonnet ".into(),
                opus: "route-opus".into(),
                haiku: " route-haiku ".into(),
                fable: String::new(),
                sonnet_name: " Kimi K2.7 ".into(),
                opus_name: "GLM-5.1".into(),
                haiku_name: " DeepSeek V4 ".into(),
                fable_name: String::new(),
            }),
        };
        normalize_routes(&mut routes);
        let cd = routes.claude_desktop.as_ref().unwrap();
        assert_eq!(cd.sonnet, "route-sonnet");
        assert_eq!(cd.haiku, "route-haiku");
        assert_eq!(cd.fable, "");
        assert_eq!(cd.sonnet_name, "Kimi K2.7");
        assert_eq!(cd.haiku_name, "DeepSeek V4");
    }
}

