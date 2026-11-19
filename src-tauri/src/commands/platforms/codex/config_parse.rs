use crate::commands::config::{Provider, ProviderStore};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use toml_edit::{value, DocumentMut, Item, Table};

use super::super::common::{
    mask_key, provider_endpoint_url, strip_first_matching_suffix, toml_item_string, toml_table_bool,
    toml_table_string, url_has_path_segment, CodexConfigInfo,
};


/// Codex config.toml 里的 base_url：永远指向本地 anybridge 的 Codex 专用网关入口（不写上游 URL）。
///
/// 关键设计决策：Codex 客户端只与 anybridge 网关通信，**绝不直连 provider 上游**。
/// 原因：
///   1. 真实 provider 上游 URL + apiKey 存到 `codex-proxy-routes.json`（由 7450 网关查表），
///      避免上游 key 暴露给 Codex 客户端。
///   2. 网关负责 Chat↔Responses 格式转换、retry、token 统计、错误归一。
///   3. 任何 supplier 走网关，统一可观测（统计、debug）。
///
/// provider 的 `apiHost` 不再用作 Codex 直连 URL——它只用作"由 7450 网关 + codex-proxy-routes.json 转发"的上游目标。
pub(in crate::commands::platforms) fn codex_base_url() -> String {
    use crate::commands::config::configured_proxy_ports;
    let port = configured_proxy_ports().api_port;
    format!("http://127.0.0.1:{port}/codex/v1")
}


/// Codex 直连模式的 base_url：必须是 API **根路径**，不能带端点后缀。
///
/// Codex 自己会按 wire_api 拼接端点（openai/codex `ModelProviderInfo`）：
/// `wire_api` 现在只剩 `responses` 一个取值，请求地址固定为 `{base_url}/responses`。
/// 所以 base 若写成 `.../v1/responses`，实际请求会变成 `.../v1/responses/responses` → 404。
///
/// 与 `claude_base_url`（剥 `/v1/messages`）、前端 `codexTargetBaseUrl()` 同源同语义；
/// 供应商 `api_path` 存的是完整端点路径（如 `/v1/chat/completions`），必须在这里剥掉。
pub(in crate::commands::platforms) fn codex_direct_base_url(p: &Provider) -> String {
    let base = strip_first_matching_suffix(
        &provider_endpoint_url(p),
        &["/chat/completions", "/responses"],
    );
    // 剥完只剩裸域名（api_path 为空、"/" 或仅有端点后缀）时补 `/v1`：
    // Codex 会拼成 `{base}/responses`，没有版本段的地址几乎不可能是有效端点。
    if url_has_path_segment(&base) {
        base
    } else {
        format!("{base}/v1")
    }
}


/// Codex 直连模式写入 config.toml 的 bearer。
///
/// `preserve_official_auth=true` 时 Codex 走 auth.json 的 OAuth 凭证，
/// bearer 会被 `apply_codex_provider_auth` 丢弃 —— 此时不该因为缺 Key 阻断切换。
pub(in crate::commands::platforms) fn codex_provider_bearer(p: &Provider) -> Result<Option<String>, String> {
    if p.preserve_official_auth {
        return Ok(None);
    }
    if p.route_through_proxy {
        return codex_bearer_token().map(Some);
    }
    let key = p.api_key.trim();
    if key.is_empty() {
        return Err("Codex 直连供应商缺少 API Key".to_string());
    }
    Ok(Some(key.to_string()))
}


/// Codex config.toml 里的 bearer_token：网关模式写 anybridge 本地网关 key。
///
/// 网关收到请求后用 `validateAuth` 验证该 token（与 byok-config.json 的 LOCAL_PROXY_KEY 比对），
/// 通过后由 7450 网关查 codex-proxy-routes.json 找到真实 provider + 上游 apiKey 转发。
pub(in crate::commands::platforms) fn codex_bearer_token() -> Result<String, String> {
    crate::commands::config::ensure_local_proxy_key()
}


/// 写入 Codex provider 认证字段并清除互斥残留。
///
/// 官方文档 (learn.chatgpt.com config-advanced) 与 openai/codex#16288：
/// `[model_providers.<id>.auth]` / `env_key` / `experimental_bearer_token` / `requires_openai_auth`
/// 不得混用。第三方静态凭证路径：`requires_openai_auth=false` + bearer。
pub(in crate::commands::platforms) fn apply_codex_provider_auth(
    provider_table: &mut Table,
    preserve_official_auth: bool,
    bearer: Option<&str>,
) {
    // 无论哪条路径，都先清掉可能残留的互斥/动态 auth 字段，避免历史手工编辑冲突。
    provider_table.remove("env_key");
    provider_table.remove("env_key_instructions");
    provider_table.remove("auth");

    if preserve_official_auth {
        provider_table["requires_openai_auth"] = value(true);
        provider_table.remove("experimental_bearer_token");
    } else {
        provider_table["requires_openai_auth"] = value(false);
        match bearer {
            Some(token) if !token.trim().is_empty() => {
                provider_table["experimental_bearer_token"] = value(token);
            }
            _ => {
                // 无 bearer 时也必须去掉旧 token，避免 OAuth/apikey 语义漂移。
                provider_table.remove("experimental_bearer_token");
            }
        }
    }
}

pub(in crate::commands::platforms) const CODEX_ANYBRIDGE_MANAGED_FLAG: &str = "anybridge_managed";


/// 解析 Codex 配置目录：优先 `CODEX_HOME`，否则 `~/.codex`。
/// 与官方 Codex CLI 行为一致，避免用户自定义 CODEX_HOME 时写到错误路径。
pub(crate) fn codex_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

pub(in crate::commands::platforms) const CODEX_LEGACY_ANYBRIDGE_SLUG_PREFIX: &str = "anybridge:";

pub(in crate::commands::platforms) const CODEX_RUNTIME_MODEL_PROVIDER_ID: &str = "codex_local_access";

pub(in crate::commands::platforms) const CODEX_LEGACY_MODEL_PROVIDER_ID: &str = "byok";

pub(in crate::commands::platforms) const CODEX_PROXY_ROUTE_SOURCE_PREFIX: &str = "codex:";


pub(in crate::commands::platforms) fn codex_proxy_route_source(provider_id: &str) -> String {
    format!("{CODEX_PROXY_ROUTE_SOURCE_PREFIX}{provider_id}")
}


pub(in crate::commands::platforms) fn codex_proxy_model_ids(provider: &Provider) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |value: &str| {
        let model = value.trim();
        if !model.is_empty() && seen.insert(model.to_string()) {
            out.push(model.to_string());
        }
    };

    push(&provider.default_model);
    for entry in &provider.model_catalog {
        push(&entry.model);
    }
    for model in &provider.models {
        push(model);
    }
    out
}


pub(in crate::commands::platforms) fn codex_proxy_route_display_name(provider: &Provider, model: &str) -> String {
    provider
        .model_catalog
        .iter()
        .find(|entry| entry.model == model)
        .and_then(|entry| entry.display_name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| model.to_string())
}


/// 从供应商的 API 路径推断上游协议；返回 None 表示路径里没带端点信息。
pub(in crate::commands::platforms) fn infer_wire_api_from_api_path(api_path: Option<&str>) -> Option<&'static str> {
    crate::commands::config::infer_wire_api_from_api_path(api_path)
}


/// 切换时按来源供应商重新推断 `wire_api`（只对 `wireApiAuto` 的配置生效）。
/// 返回 None 表示保持原值。
///
/// 前端原本想「从来源供应商继承 wireApi」，但普通供应商在 UI 上没有该输入项、
/// 字段恒为空字符串，继承永远落空、一律回落 "responses"。结果只支持
/// Chat Completions 的上游被网关请求到 `/responses` → 404。
pub(in crate::commands::platforms) fn resolve_codex_auto_wire_api(store: &ProviderStore, config_id: &str) -> Option<String> {
    let config = store.codex_configs.iter().find(|c| c.id == config_id)?;
    if !config.wire_api_auto || config.source_provider_id.trim().is_empty() {
        return None;
    }
    let source = store
        .providers
        .iter()
        .find(|p| p.id == config.source_provider_id)?;
    let explicit = source.wire_api.trim().to_ascii_lowercase();
    if explicit == "chat" || explicit == "responses" {
        return Some(explicit);
    }
    infer_wire_api_from_api_path(source.api_path.as_deref()).map(str::to_string)
}


/// 应用推断结果，并**同步写回 store**，让存量配置不必逐个重新保存也能走对端点。
///
/// 必须写回：sidecar 是从 providers.json 的 `codexConfigs` 直接读 `wireApi` 来决定
/// 要不要做 Responses→Chat 转换的（config-cache.js `transformProviders`）。
/// 只改内存里的 provider，会让路由指向 `/chat/completions` 却不转换请求体 —— 比不修更糟。
///
/// 只影响「本地网关 → 上游」；config.toml 的 wire_api 仍恒为 "responses"。
pub(in crate::commands::platforms) fn apply_codex_auto_wire_api(provider: &mut Provider, store: &mut ProviderStore, config_id: &str) {
    let Some(resolved) = resolve_codex_auto_wire_api(store, config_id) else {
        return;
    };
    provider.wire_api = resolved.clone();
    if let Some(config) = store.codex_configs.iter_mut().find(|c| c.id == config_id) {
        config.wire_api = resolved;
    }
}


pub(in crate::commands::platforms) fn codex_proxy_target_api_path(provider: &Provider) -> String {
    let raw = provider
        .api_path
        .as_deref()
        .unwrap_or("/v1")
        .trim()
        .trim_end_matches('/');
    let base = if raw.is_empty() || raw == "/" {
        "/v1"
    } else {
        raw
    };
    let lower = base.to_ascii_lowercase();
    if lower.ends_with("/responses") || lower.ends_with("/chat/completions") {
        return base.to_string();
    }
    if provider.wire_api.trim().eq_ignore_ascii_case("chat") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/responses")
    }
}


pub(in crate::commands::platforms) fn plan_codex_proxy_routes_into(
    mut routes: crate::commands::proxy_routes::ProxyRoutes,
    provider: &Provider,
    source_provider_id: Option<&str>,
) -> Result<crate::commands::proxy_routes::ProxyRoutes, String> {
    let models = codex_proxy_model_ids(provider);
    if models.is_empty() {
        return Err("Codex 代理模式至少需要一个模型，无法生成内置模型路由".to_string());
    }
    let target_api_path = codex_proxy_target_api_path(provider);
    let source_id = source_provider_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();
    let api_keys = crate::commands::proxy_routes::enabled_api_keys(provider);
    routes
        .routes
        .retain(|route| !route.source.starts_with(CODEX_PROXY_ROUTE_SOURCE_PREFIX));

    for model in models {
        if let Some(existing) = routes.routes.iter().find(|route| route.id == model) {
            return Err(format!(
                "Codex 模型「{}」与现有内置模型冲突（source: {}）。请先在「网关 > 模型列表」改名或删除该模型，再切换 Codex。",
                model,
                existing.source
            ));
        }

        routes.routes.push(crate::commands::proxy_routes::ProxyRoute {
            uid: String::new(),
            id: model.clone(),
            display_name: codex_proxy_route_display_name(provider, &model),
            id_from_rename_rule: false,
            enabled: true,
            exposed_formats: vec!["openai".to_string()],
            source: codex_proxy_route_source(&provider.id),
            capabilities: crate::commands::proxy_routes::ProxyRouteCapabilities {
                stream: provider.capabilities.stream,
                tools: provider.capabilities.tools,
                vision: provider.capabilities.vision,
                reasoning: true,
            },
            enhancement: crate::commands::proxy_routes::ProxyRouteEnhancement::default(),
            targets: vec![crate::commands::proxy_routes::ProxyRouteTarget {
                provider_id: provider.id.clone(),
                source_provider_id: source_id.clone(),
                model,
                api_format: "openai".to_string(),
                api_path: target_api_path.clone(),
                unlock: String::new(),
                api_keys: api_keys.clone(),
            }],
        });
    }

    Ok(routes)
}

pub(in crate::commands::platforms) fn plan_codex_proxy_routes(
    provider: &Provider,
    source_provider_id: Option<&str>,
) -> Result<crate::commands::proxy_routes::ProxyRoutes, String> {
    let routes = crate::commands::proxy_routes::read_codex_routes()?;
    plan_codex_proxy_routes_into(routes, provider, source_provider_id)
}


pub(in crate::commands::platforms) fn plan_clear_codex_proxy_routes_into(
    mut routes: crate::commands::proxy_routes::ProxyRoutes,
) -> crate::commands::proxy_routes::ProxyRoutes {
    routes
        .routes
        .retain(|route| !route.source.starts_with(CODEX_PROXY_ROUTE_SOURCE_PREFIX));
    routes
}

pub(in crate::commands::platforms) fn plan_clear_codex_proxy_routes() -> Result<crate::commands::proxy_routes::ProxyRoutes, String> {
    let routes = crate::commands::proxy_routes::read_codex_routes()?;
    Ok(plan_clear_codex_proxy_routes_into(routes))
}


pub(in crate::commands::platforms) struct LegacyGlobalCodexProxyRouteCleanupPlan {
    pub(in crate::commands::platforms) routes: Option<crate::commands::proxy_routes::ProxyRoutes>,
    pub(in crate::commands::platforms) warnings: Vec<String>,
}


pub(in crate::commands::platforms) fn legacy_global_codex_proxy_route_cleanup_warning(action: &str, error: &str) -> String {
    format!(
        "旧版 Codex 全局内置模型路由未清理：{action} proxy-routes.json 失败（{error}）。\
         Codex 现在使用独立 codex-proxy-routes.json，不影响本次 Codex 切换；\
         如需清理旧数据，请先修复「网关 > 模型列表」后重试。"
    )
}


pub(in crate::commands::platforms) fn plan_clear_legacy_global_codex_proxy_routes_from(
    routes: Result<crate::commands::proxy_routes::ProxyRoutes, String>,
) -> LegacyGlobalCodexProxyRouteCleanupPlan {
    let mut routes = match routes {
        Ok(routes) => routes,
        Err(e) => {
            return LegacyGlobalCodexProxyRouteCleanupPlan {
                routes: None,
                warnings: vec![legacy_global_codex_proxy_route_cleanup_warning("读取", &e)],
            }
        }
    };
    let before = routes.routes.len();
    routes
        .routes
        .retain(|route| !route.source.starts_with(CODEX_PROXY_ROUTE_SOURCE_PREFIX));
    if routes.routes.len() == before {
        LegacyGlobalCodexProxyRouteCleanupPlan {
            routes: None,
            warnings: Vec::new(),
        }
    } else {
        LegacyGlobalCodexProxyRouteCleanupPlan {
            routes: Some(routes),
            warnings: Vec::new(),
        }
    }
}


pub(in crate::commands::platforms) fn plan_clear_legacy_global_codex_proxy_routes() -> LegacyGlobalCodexProxyRouteCleanupPlan {
    plan_clear_legacy_global_codex_proxy_routes_from(crate::commands::proxy_routes::read_routes())
}


pub(in crate::commands::platforms) fn read_codex_config_info(path: &PathBuf) -> Result<Option<CodexConfigInfo>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some(CodexConfigInfo {
            model: None,
            model_provider_id: None,
            provider_name: Some("OpenAI 官方".to_string()),
            base_url: None,
            wire_api: Some("responses".to_string()),
            has_bearer_token: false,
            bearer_token_masked: None,
            bearer_token: None,
            is_official: true,
            managed_by_any_bridge: false,
        }));
    }

    let doc = raw
        .parse::<DocumentMut>()
        .map_err(|e| format!("config.toml 解析失败: {e}"))?;

    let model = doc.get("model").and_then(toml_item_string);
    let model_provider_id = doc.get("model_provider").and_then(toml_item_string);

    let provider_table = model_provider_id.as_ref().and_then(|provider_id| {
        doc.get("model_providers")
            .and_then(Item::as_table)
            .and_then(|providers| providers.get(provider_id))
            .and_then(Item::as_table)
    });

    let provider_name = provider_table.and_then(|table| toml_table_string(table, "name"));
    let base_url = provider_table.and_then(|table| toml_table_string(table, "base_url"));
    let wire_api = provider_table.and_then(|table| toml_table_string(table, "wire_api"));
    let bearer_token = provider_table
        .and_then(|table| toml_table_string(table, "experimental_bearer_token"))
        .filter(|token| !token.trim().is_empty());
    let has_bearer_token = bearer_token.is_some();
    let bearer_token_masked = bearer_token.as_deref().map(mask_key);
    let model_provider_normalized = model_provider_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let requires_openai_auth = provider_table
        .map(|table| toml_table_bool(table, "requires_openai_auth"))
        .unwrap_or(false);
    // 统一会话历史下的官方模式：model_provider 固定为 codex_local_access，
    // 但 provider 走 OAuth、无 base_url/token，语义上仍是官方。
    let is_unified_official = model_provider_normalized == CODEX_RUNTIME_MODEL_PROVIDER_ID
        && requires_openai_auth
        && base_url.is_none()
        && !has_bearer_token;
    let is_builtin_or_named_official = model_provider_normalized.is_empty()
        || model_provider_normalized == "openai"
        || (provider_table
            .and_then(|table| toml_table_string(table, "name"))
            .map(|name| {
                let trimmed = name.trim();
                trimmed.eq_ignore_ascii_case("openai") || trimmed == "OpenAI 官方"
            })
            .unwrap_or(false)
            && base_url.is_none()
            && !has_bearer_token);
    let is_official = is_builtin_or_named_official || is_unified_official;
    let managed_by_any_bridge = model_provider_id.as_deref()
        == Some(CODEX_LEGACY_MODEL_PROVIDER_ID)
        || provider_table
            .map(|table| toml_table_bool(table, CODEX_ANYBRIDGE_MANAGED_FLAG))
            .unwrap_or(false);

    Ok(Some(CodexConfigInfo {
        model,
        model_provider_id,
        provider_name,
        base_url,
        wire_api,
        has_bearer_token,
        bearer_token_masked,
        bearer_token,
        is_official,
        managed_by_any_bridge,
    }))
}


