use std::collections::HashSet;

use super::{
    codex_proxy_routes_path, default_exposed_formats, default_source, generate_route_uid,
    proxy_routes_path, ProxyRoute, ProxyRoutes,
};
use crate::commands::{config::Provider, store_io};

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

pub(crate) fn validate_routes(routes: &ProxyRoutes) -> Result<(), String> {
    let mut seen_ids = HashSet::new();
    let mut seen_uids = HashSet::new();
    for route in &routes.routes {
        if route.id.trim().is_empty() {
            return Err("内置模型 ID 不能为空".into());
        }
        if !seen_ids.insert(route.id.clone()) {
            return Err(format!("内置模型 ID 重复: {}", route.id));
        }
        if !route.uid.trim().is_empty() && !seen_uids.insert(route.uid.clone()) {
            return Err(format!("内置模型 UID 重复: {}", route.uid));
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

pub(crate) fn enabled_api_keys(provider: &Provider) -> Vec<String> {
    provider
        .api_keys
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect()
}

fn sync_routes_api_keys(routes: &mut ProxyRoutes, providers: &[Provider]) -> usize {
    let mut changed = 0usize;
    for route in &mut routes.routes {
        for target in &mut route.targets {
            let source_id = target.source_provider_id.trim();
            let provider = if !source_id.is_empty() {
                providers
                    .iter()
                    .find(|p| p.id == source_id)
                    .or_else(|| providers.iter().find(|p| p.id == target.provider_id))
            } else {
                providers.iter().find(|p| p.id == target.provider_id)
            };
            let Some(provider) = provider else {
                continue;
            };
            let keys = enabled_api_keys(provider);
            if keys.is_empty() || target.api_keys == keys {
                continue;
            }
            target.api_keys = keys;
            changed += 1;
        }
    }
    changed
}

/// 把供应商的多密钥池同步到引用它的路由目标（同时刷新全局路由与 Codex 独立路由）。
///
/// 供应商池是「这家供应商有哪些可用密钥」的唯一真源：
/// - 池非空 → 覆盖路由目标上的 `apiKeys`，让 sidecar 的请求级轮换拿得到；
/// - 池为空 → 不动路由，避免把用户在路由编辑器里单独配置的密钥清掉。
///
/// 返回被更新的目标数量，供调用方记录。
pub(crate) fn sync_provider_api_keys_at(
    global_path: &std::path::Path,
    codex_path: &std::path::Path,
    providers: &[Provider],
) -> Result<usize, String> {
    if providers.is_empty() {
        return Ok(0);
    }
    let global_changed = store_io::update_proxy_routes_at(global_path, |routes| {
        let changed = sync_routes_api_keys(routes, providers);
        Ok((changed > 0, changed))
    })?;
    let codex_changed = if codex_path.exists() {
        store_io::update_proxy_routes_at(codex_path, |routes| {
            let changed = sync_routes_api_keys(routes, providers);
            Ok((changed > 0, changed))
        })?
    } else {
        0
    };
    Ok(global_changed + codex_changed)
}

pub(crate) fn sync_provider_api_keys(providers: &[Provider]) -> Result<usize, String> {
    sync_provider_api_keys_at(&proxy_routes_path(), &codex_proxy_routes_path(), providers)
}

/// 抢救：去重、丢掉没有 ID 的条目、把没有上游目标的条目停用（而不是删除，保留用户配置），
/// 并清掉非法的接口格式/解锁组合，保证结果一定能过 validate_routes。
pub(super) fn salvage_routes(routes: &mut ProxyRoutes) -> (usize, usize) {
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
