use super::*;
use crate::commands::proxy_routes::{
    sync_provider_api_keys_at, ProxyRoute, ProxyRouteCapabilities, ProxyRouteEnhancement,
    ProxyRouteTarget, ProxyRoutes,
};
use crate::commands::store_io::update_proxy_routes_at;

fn build_live_provider(id: &str, host: &str, key: &str, pool: Vec<(&str, bool)>) -> Provider {
    let api_keys: Vec<serde_json::Value> = pool
        .into_iter()
        .map(|(k, en)| serde_json::json!({ "key": k, "enabled": en }))
        .collect();
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": format!("Provider-{id}"),
        "apiHost": host,
        "apiKey": key,
        "apiKeys": api_keys,
        "defaultModel": "gpt-5",
        "models": ["gpt-5", "claude-sonnet-4-5"],
        "enabled": true,
        "capabilities": { "text": true, "vision": true, "tools": true, "stream": true }
    }))
    .unwrap()
}

#[test]
fn resolve_platform_config_enforces_live_source_and_blocks_disabled_providers() {
    let mut active_src = build_live_provider(
        "src-active",
        "https://live.example.com",
        "sk-live",
        vec![("sk-live", true)],
    );
    let mut disabled_src = active_src.clone();
    disabled_src.id = "src-disabled".to_string();
    disabled_src.name = "DisabledSource".to_string();
    disabled_src.enabled = false;

    let mut direct_disabled = active_src.clone();
    direct_disabled.id = "direct-disabled".to_string();
    direct_disabled.name = "DirectDisabled".to_string();
    direct_disabled.enabled = false;

    let store = ProviderStore {
        providers: vec![active_src.clone(), disabled_src, direct_disabled],
        claude_code_configs: vec![
            serde_json::from_value(serde_json::json!({
                "id": "cc-ok",
                "name": "CC OK",
                "apiHost": "https://stale.example",
                "apiKey": "sk-stale",
                "defaultModel": "claude-sonnet-4-5",
                "sourceProviderId": "src-active"
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "id": "cc-dis",
                "name": "CC Disabled",
                "apiHost": "https://stale.example",
                "apiKey": "sk-stale",
                "defaultModel": "claude-sonnet-4-5",
                "sourceProviderId": "src-disabled"
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "id": "cc-miss",
                "name": "CC Missing",
                "apiHost": "https://stale.example",
                "apiKey": "sk-stale",
                "defaultModel": "claude-sonnet-4-5",
                "sourceProviderId": "not-found"
            }))
            .unwrap(),
        ],
        opencode_configs: vec![serde_json::from_value(serde_json::json!({
            "id": "oc-dis",
            "name": "OC Disabled",
            "apiHost": "https://stale.example",
            "apiKey": "sk-stale",
            "defaultModel": "gpt-5",
            "sourceProviderId": "src-disabled"
        }))
        .unwrap()],
        ..Default::default()
    };

    let resolved = resolve_platform_config(&Platform::ClaudeCode, &store, "cc-ok").unwrap();
    assert_eq!(resolved.api_host, "https://live.example.com");
    assert_eq!(resolved.api_key, "sk-live");

    let err_bound_disabled =
        resolve_platform_config(&Platform::ClaudeCode, &store, "cc-dis").unwrap_err();
    assert!(err_bound_disabled.contains("已禁用"));

    let err_bound_missing =
        resolve_platform_config(&Platform::ClaudeCode, &store, "cc-miss").unwrap_err();
    assert!(err_bound_missing.contains("不存在"));

    let err_opencode_disabled =
        resolve_platform_config(&Platform::OpenCode, &store, "oc-dis").unwrap_err();
    assert!(err_opencode_disabled.contains("已禁用"));

    let err_direct_disabled =
        resolve_platform_config(&Platform::Pi, &store, "direct-disabled").unwrap_err();
    assert!(err_direct_disabled.contains("已禁用"));

    active_src.enabled = true;
    assert!(active_src.enabled);
}

#[test]
fn claude_and_opencode_settings_config_override_stale_connection_with_live_source() {
    let live_source = build_live_provider(
        "src-1",
        "https://new-gateway.example.com",
        "sk-new-live-token",
        vec![("sk-new-live-token", true)],
    );
    let providers = vec![live_source];

    // 1. ClaudeCodeConfig 带陈旧 settingsConfig（包含旧 URL/Token、旧顶层 apiKey 与用户自定义 hooks）
    let claude_cfg: ClaudeCodeConfig = serde_json::from_value(serde_json::json!({
        "id": "cc-bound",
        "name": "CC Bound",
        "apiHost": "https://old-snapshot.example",
        "apiKey": "sk-old-snapshot",
        "defaultModel": "claude-sonnet-4-5",
        "sourceProviderId": "src-1",
        "settingsConfig": {
            "apiKey": "sk-old-snapshot",
            "env": {
                "ANTHROPIC_BASE_URL": "https://old-snapshot.example/anthropic",
                "ANTHROPIC_AUTH_TOKEN": "sk-old-snapshot",
                "CUSTOM_KEEP_ENV": "preserve-me"
            },
            "hooks": { "PreToolUse": [] }
        }
    }))
    .unwrap();

    let (cc_path, cc_stash) = named_tmp_config("ssot-claude", "settings.json");
    fs::write(&cc_path, "{}").unwrap();
    apply_claude_config_file_with_providers_and_stash(&cc_path, &claude_cfg, &providers, &cc_stash)
        .unwrap();
    let cc_written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cc_path).unwrap()).unwrap();
    assert_eq!(
        cc_written["env"]["ANTHROPIC_BASE_URL"].as_str(),
        Some("https://new-gateway.example.com")
    );
    assert_eq!(
        cc_written["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
        Some("sk-new-live-token")
    );
    assert_eq!(cc_written["apiKey"].as_str(), Some("sk-new-live-token"));
    assert_eq!(
        cc_written["env"]["CUSTOM_KEEP_ENV"].as_str(),
        Some("preserve-me")
    );
    assert!(cc_written["hooks"]["PreToolUse"].is_array());
    let _ = fs::remove_dir_all(cc_path.parent().unwrap());

    // 2. OpenCodeConfig 带陈旧 settingsConfig（包含旧 options.baseURL/apiKey 与自定义 models）
    let opencode_cfg: OpenCodeConfig = serde_json::from_value(serde_json::json!({
        "id": "oc-bound",
        "name": "OC Bound",
        "apiHost": "https://old-oc.example",
        "apiKey": "sk-old-oc",
        "defaultModel": "gpt-5",
        "sourceProviderId": "src-1",
        "settingsConfig": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": "https://old-oc.example/v1",
                "apiKey": "sk-old-oc",
                "timeout": 45000
            },
            "models": {
                "gpt-5": { "name": "GPT-5 Keep" }
            }
        }
    }))
    .unwrap();

    let (oc_path, oc_stash) = named_tmp_config("ssot-opencode", "opencode.json");
    fs::write(&oc_path, r#"{ "$schema": "https://opencode.ai/config.json" }"#).unwrap();
    apply_opencode_config_file_with_providers_and_stash(
        &oc_path,
        &opencode_cfg,
        &providers,
        &oc_stash,
    )
    .unwrap();
    let oc_written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&oc_path).unwrap()).unwrap();
    let entry = &oc_written["provider"]["oc-bound"];
    assert_eq!(
        entry["options"]["baseURL"].as_str(),
        Some("https://new-gateway.example.com/v1")
    );
    assert_eq!(
        entry["options"]["apiKey"].as_str(),
        Some("sk-new-live-token")
    );
    assert_eq!(entry["options"]["timeout"].as_i64(), Some(45000));
    assert_eq!(entry["models"]["gpt-5"]["name"].as_str(), Some("GPT-5 Keep"));
    let _ = fs::remove_dir_all(oc_path.parent().unwrap());
}

#[test]
fn codex_routes_track_source_provider_id_and_sync_refreshes_both_files() {
    let dir = temp_managed_dir("codex-routes-sync");
    let global_path = dir.join("proxy-routes.json");
    let codex_path = dir.join("codex-proxy-routes.json");

    let initial_source = build_live_provider(
        "src-main",
        "https://api.example.com",
        "sk-1",
        vec![("sk-1", true), ("sk-2", true), ("sk-disabled", false)],
    );
    let mut resolved = initial_source.clone();
    resolved.id = "codex-cfg-1".to_string();

    let planned = plan_codex_proxy_routes_into(
        ProxyRoutes::default(),
        &resolved,
        Some("src-main"),
    )
    .unwrap();
    assert_eq!(planned.routes.len(), 2);
    for route in &planned.routes {
        assert_eq!(route.targets[0].provider_id, "codex-cfg-1");
        assert_eq!(route.targets[0].source_provider_id, "src-main");
        assert_eq!(route.targets[0].api_keys, vec!["sk-1", "sk-2"]);
    }

    update_proxy_routes_at(&codex_path, |r| {
        *r = planned.clone();
        Ok((true, ()))
    })
    .unwrap();
    update_proxy_routes_at(&global_path, |r| {
        r.routes.push(ProxyRoute {
            uid: "r-global".into(),
            id: "gpt-5".into(),
            display_name: "gpt-5".into(),
            id_from_rename_rule: false,
            enabled: true,
            exposed_formats: vec!["openai".into()],
            source: "manual".into(),
            capabilities: ProxyRouteCapabilities::default(),
            enhancement: ProxyRouteEnhancement::default(),
            targets: vec![ProxyRouteTarget {
                provider_id: "src-main".into(),
                source_provider_id: String::new(),
                model: "gpt-5".into(),
                api_format: "openai".into(),
                api_path: String::new(),
                unlock: String::new(),
                api_keys: vec!["sk-1".into()],
            }],
        });
        Ok((true, ()))
    })
    .unwrap();

    // 主供应商密钥池新增 sk-3、停用 sk-1 后，必须同时同步 proxy-routes.json 与 codex-proxy-routes.json
    let updated_source = build_live_provider(
        "src-main",
        "https://api.example.com",
        "sk-2",
        vec![("sk-2", true), ("sk-3", true), ("sk-1", false)],
    );
    let updated_count =
        sync_provider_api_keys_at(&global_path, &codex_path, &[updated_source]).unwrap();
    assert_eq!(updated_count, 3, "全局 1 个 target + Codex 2 个 target 均应刷新");

    let global_after: ProxyRoutes =
        serde_json::from_str(&fs::read_to_string(&global_path).unwrap()).unwrap();
    let codex_after: ProxyRoutes =
        serde_json::from_str(&fs::read_to_string(&codex_path).unwrap()).unwrap();
    assert_eq!(
        global_after.routes[0].targets[0].api_keys,
        vec!["sk-2", "sk-3"]
    );
    for route in &codex_after.routes {
        assert_eq!(route.targets[0].api_keys, vec!["sk-2", "sk-3"]);
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn preserving_and_field_restore_gates_default_enabled_when_unset() {
    with_gates(None, None, || {
        std::env::remove_var("ANYBRIDGE_FORMAT_PRESERVING_JSON");
        std::env::remove_var("ANYBRIDGE_FIELD_RESTORE");
        assert!(
            crate::commands::jsonc_edit::format_preserving_enabled(),
            "ANYBRIDGE_FORMAT_PRESERVING_JSON 未设置时默认应为 true"
        );
        assert!(
            crate::commands::agent_stash::field_restore_enabled(),
            "ANYBRIDGE_FIELD_RESTORE 未设置时默认应为 true"
        );
    });
    with_gates(Some(false), Some(false), || {
        assert!(!crate::commands::jsonc_edit::format_preserving_enabled());
        assert!(!crate::commands::agent_stash::field_restore_enabled());
    });
}
