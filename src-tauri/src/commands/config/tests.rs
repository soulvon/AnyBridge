use super::probe_conn::*;
use super::*;


#[test]
fn json_api_errors_must_not_be_treated_as_waf_blocks() {
    // 业务错误：上游明确拒绝了某个模型/参数 → 不该再用 gzip 重试一次
    assert!(is_json_api_error(r#"{"error":{"message":"Invalid model id: "}}"#));
    assert!(is_json_api_error(r#"{"error":{"message":"no such model"}}"#));
    assert!(is_json_api_error(r#"{"message":"insufficient balance"}"#));
}

#[test]
fn empty_or_html_responses_look_like_waf_blocks() {
    // 空响应 / HTML 拦截页 / 纯文本：才值得用 gzip 重发探测
    assert!(!is_json_api_error(""));
    assert!(!is_json_api_error("   "));
    assert!(!is_json_api_error("<html><body><h1>403 Forbidden</h1></body></html>"));
    assert!(!is_json_api_error("Forbidden"));
}

#[test]
fn probe_body_output_limit_meets_openai_minimum_16() {
    // issue #42：探针输出上限低于 16 时，严格上游（CPA → Responses 校验）直接 400，
    // 正常渠道被测成「连接失败」。四个协议分支都必须取 OpenAI 最小合法值。
    for (fmt, uses_responses) in [
        ("openai", true),
        ("openai", false),
        ("anthropic", false),
        ("gemini", false),
    ] {
        let body = probe_request_body(fmt, uses_responses, "gpt-6.1-sol");
        if fmt == "gemini" {
            assert!(
                body.get("max_output_tokens").is_none() && body.get("max_tokens").is_none(),
                "gemini 探针不设输出上限"
            );
            continue;
        }
        let limit = body
            .get("max_output_tokens")
            .or_else(|| body.get("max_tokens"))
            .expect("探针体必须带输出上限")
            .as_u64()
            .expect("输出上限必须是整数");
        assert!(
            limit >= 16,
            "{fmt} (uses_responses={uses_responses}) 探针上限 {limit} 低于 OpenAI 最小 16"
        );
    }
    // responses 分支必须用 max_output_tokens 键名，chat/anthropic 分支用 max_tokens
    assert!(probe_request_body("openai", true, "m").get("max_output_tokens").is_some());
    assert!(probe_request_body("openai", false, "m").get("max_tokens").is_some());
    assert!(probe_request_body("anthropic", false, "m").get("max_tokens").is_some());
}

fn store_with_api_keys(api_key: &str, pool: serde_json::Value) -> ProviderStore {
    serde_json::from_value(serde_json::json!({
        "providers": [{
            "id": "p1",
            "name": "测试供应商",
            "apiHost": "https://api.example.com",
            "apiKey": api_key,
            "defaultModel": "m1",
            "apiKeys": pool
        }]
    }))
    .expect("测试构造的供应商 JSON 必须可反序列化")
}

#[test]
fn normalize_provider_api_keys_puts_current_first_and_dedupes() {
    // 当前密钥已在池里重复 → 只保留一条并排第一；空 key 剔除
    let mut store = store_with_api_keys(
        "sk-a",
        serde_json::json!([
            { "label": "备选", "key": "sk-b", "enabled": true },
            { "label": "重复", "key": "sk-a", "enabled": true },
            { "label": "空", "key": "   ", "enabled": true }
        ]),
    );
    normalize_provider_api_keys(&mut store);

    let provider = &store.providers[0];
    assert_eq!(provider.api_keys.len(), 2);
    assert_eq!(provider.api_keys[0].key, "sk-a");
    assert_eq!(provider.api_keys[0].id, "key-1");
    assert_eq!(provider.api_keys[1].key, "sk-b");
    assert_eq!(provider.api_keys[1].id, "key-2");
    assert_eq!(provider.api_key, "sk-a");
}

#[test]
fn normalize_provider_api_keys_fills_empty_current_from_first_enabled() {
    // 当前密钥为空、池里有启用项 → 用第一个启用项补上
    let mut store = store_with_api_keys(
        "",
        serde_json::json!([
            { "key": "sk-off", "enabled": false },
            { "key": "sk-on", "enabled": true }
        ]),
    );
    normalize_provider_api_keys(&mut store);

    let provider = &store.providers[0];
    assert_eq!(provider.api_key, "sk-on");
    // 被选为当前的那把不再留在池里，下一次编辑不会看到重复项
    assert_eq!(provider.api_keys.len(), 1);
    assert_eq!(provider.api_keys[0].key, "sk-off");
}

#[test]
fn normalize_provider_api_keys_keeps_current_when_all_disabled() {
    // 池里全被停用 → 不替用户挑，当前密钥保持不变
    let mut store = store_with_api_keys(
        "sk-current",
        serde_json::json!([
            { "key": "sk-off1", "enabled": false },
            { "key": "sk-off2", "enabled": false }
        ]),
    );
    normalize_provider_api_keys(&mut store);

    let provider = &store.providers[0];
    assert_eq!(provider.api_key, "sk-current");
    assert_eq!(provider.api_keys.len(), 3);
    assert!(provider.api_keys.iter().all(|entry| entry.id.starts_with("key-")));
}

#[test]
fn antigravity_config_resolves_ai_studio_and_vertex_without_false_openai_fallback() {
    let ai_studio: AntigravityConfig = serde_json::from_value(serde_json::json!({
        "id": "ag-aistudio",
        "name": "gemini-2.5-pro",
        "apiHost": "https://generativelanguage.googleapis.com",
        "apiKey": "AIza-test",
        "defaultModel": "gemini-2.5-pro",
        "apiFormat": "openai"
    }))
    .unwrap();
    assert_eq!(ai_studio.resolved_api_format(), ApiFormat::Gemini);

    let vertex: AntigravityConfig = serde_json::from_value(serde_json::json!({
        "id": "ag-vertex",
        "name": "gemini-3.8-flash",
        "apiHost": "https://aiplatform.googleapis.com",
        "apiPath": "/v1/projects/p/locations/global/publishers/google/models",
        "apiKey": "ya29.tok",
        "defaultModel": "gemini-3.8-flash"
    }))
    .unwrap();
    assert_eq!(vertex.resolved_api_format(), ApiFormat::Gemini);

    let openai_compat: AntigravityConfig = serde_json::from_value(serde_json::json!({
        "id": "ag-openai",
        "name": "gemini-2.5-pro",
        "apiHost": "https://generativelanguage.googleapis.com",
        "apiPath": "/v1beta/openai/chat/completions",
        "apiKey": "AIza-test",
        "defaultModel": "gemini-2.5-pro",
        "apiFormat": "openai"
    }))
    .unwrap();
    assert_eq!(openai_compat.resolved_api_format(), ApiFormat::Openai);
}

#[test]
fn antigravity_config_resolves_live_source_provider_over_stale_snapshot() {
    let mut store: ProviderStore = serde_json::from_value(serde_json::json!({
        "providers": [{
            "id": "prov-live",
            "name": "Live Google",
            "apiHost": "https://aiplatform.googleapis.com",
            "apiPath": "/v1/projects/p/locations/global/publishers/google/models",
            "apiKey": "ya29.live",
            "apiFormat": "gemini",
            "defaultModel": "gemini-2.5-pro",
            "capabilities": { "tools": true, "vision": true },
            "unlocks": { "claudeCode": { "enabled": true } }
        }],
        "antigravityConfigs": [
            {
                "id": "ag-trimmed",
                "name": "gemini-2.5-pro",
                "defaultModel": "gemini-2.5-pro",
                "models": ["gemini-2.5-pro"],
                "sourceProviderId": "prov-live"
            },
            {
                "id": "ag-stale-snapshot",
                "name": "gemini-2.5-pro",
                "apiHost": "https://stale.example.com",
                "apiPath": "/v1/chat/completions",
                "apiKey": "sk-stale",
                "apiFormat": "openai",
                "defaultModel": "gemini-2.5-pro",
                "sourceProviderId": "prov-live"
            }
        ]
    }))
    .unwrap();

    let trimmed = store.antigravity_configs[0].resolve_provider(&store.providers);
    assert_eq!(trimmed.api_host, "https://aiplatform.googleapis.com");
    assert_eq!(
        trimmed.api_path.as_deref(),
        Some("/v1/projects/p/locations/global/publishers/google/models")
    );
    assert_eq!(trimmed.api_key, "ya29.live");
    assert_eq!(trimmed.api_format, Some(ApiFormat::Gemini));
    assert!(trimmed.capabilities.tools);
    assert!(trimmed.capabilities.vision);
    assert!(trimmed.unlocks.claude_code.as_ref().map(|u| u.enabled).unwrap_or(false));

    let stale = store.antigravity_configs[1].resolve_provider(&store.providers);
    assert_eq!(stale.api_host, "https://aiplatform.googleapis.com");
    assert_eq!(stale.api_key, "ya29.live");
    assert_eq!(stale.api_format, Some(ApiFormat::Gemini));

    // 非官方原生端点时允许 apiFormatOverride 生效
    store.providers[0].api_host = "https://relay.example.com".to_string();
    store.providers[0].api_path = Some("/v1".to_string());
    store.providers[0].api_format = Some(ApiFormat::Openai);
    store.antigravity_configs[0].api_format_override = Some("anthropic".to_string());
    let overridden = store.antigravity_configs[0].resolve_provider(&store.providers);
    assert_eq!(overridden.api_format, Some(ApiFormat::Anthropic));
}

#[test]
fn fetch_models_gemini_url_does_not_duplicate_embedded_host_path() {
    let official_host = "https://generativelanguage.googleapis.com/v1beta";
    let paths = crate::commands::google_gemini::build_gemini_model_list_paths(official_host, None);
    let urls: Vec<String> = paths
        .iter()
        .map(|p| build_fetch_model_url(official_host, "gemini", p))
        .collect();
    assert!(
        !urls.iter().any(|u| u.contains("/v1beta/v1beta")),
        "Gemini fetch_models 不得把 host 内嵌 /v1beta 重复拼接: {:?}",
        urls
    );
    assert_eq!(
        urls.first().map(String::as_str),
        Some("https://generativelanguage.googleapis.com/v1beta/models")
    );

    let relay_host = "https://relay.example.com/custom";
    let relay_paths = crate::commands::google_gemini::build_gemini_model_list_paths(relay_host, None);
    let relay_urls: Vec<String> = relay_paths
        .iter()
        .map(|p| build_fetch_model_url(relay_host, "gemini", p))
        .collect();
    assert!(
        !relay_urls.iter().any(|u| u.contains("/custom/custom")),
        "Gemini fetch_models 不得把代理内嵌路径 /custom 重复拼接: {:?}",
        relay_urls
    );
    assert_eq!(
        relay_urls.first().map(String::as_str),
        Some("https://relay.example.com/custom/v1beta/models")
    );
}

#[test]
fn resolve_provider_live_inherits_across_all_six_platform_configs() {
    let mut live_source: Provider = serde_json::from_value(serde_json::json!({
        "id": "src-live",
        "name": "Live Main",
        "apiHost": "https://live-upstream.example.com",
        "apiPath": "/v1/chat/completions",
        "apiKey": "sk-live-primary",
        "apiKeys": [
            { "key": "sk-live-primary", "enabled": true },
            { "key": "sk-live-backup", "enabled": true },
            { "key": "sk-live-disabled", "enabled": false }
        ],
        "defaultModel": "fallback-model",
        "apiFormat": "openai",
        "enabled": true,
        "capabilities": { "text": true, "vision": true, "tools": true, "stream": true },
        "modelCaps": { "gpt-5": { "vision": true } },
        "unlocks": { "claudeCode": { "enabled": true } }
    }))
    .unwrap();

    let ag_cfg: AntigravityConfig = serde_json::from_value(serde_json::json!({
        "id": "ag-1",
        "name": "gemini-2.5-pro",
        "apiHost": "https://stale-ag.example",
        "apiKey": "sk-stale",
        "defaultModel": "gemini-2.5-pro",
        "models": ["gemini-2.5-pro"],
        "sourceProviderId": "src-live",
        "apiFormat": "anthropic",
        "apiFormatOverride": "anthropic"
    }))
    .unwrap();
    let codex_cfg: CodexConfig = serde_json::from_value(serde_json::json!({
        "id": "codex-1",
        "name": "Codex",
        "apiHost": "https://stale-codex.example",
        "apiKey": "sk-stale",
        "defaultModel": "gpt-5",
        "models": ["gpt-5"],
        "sourceProviderId": "src-live",
        "wireApi": "responses",
        "wireApiAuto": true
    }))
    .unwrap();
    let claude_cfg: ClaudeCodeConfig = serde_json::from_value(serde_json::json!({
        "id": "cc-1",
        "name": "Claude",
        "apiHost": "https://stale-cc.example",
        "apiKey": "sk-stale",
        "defaultModel": "claude-sonnet-4-5",
        "models": ["claude-sonnet-4-5"],
        "sourceProviderId": "src-live"
    }))
    .unwrap();
    let opencode_cfg: OpenCodeConfig = serde_json::from_value(serde_json::json!({
        "id": "oc-1",
        "name": "OpenCode",
        "apiHost": "https://stale-oc.example",
        "apiKey": "sk-stale",
        "defaultModel": "gpt-5",
        "models": ["gpt-5"],
        "sourceProviderId": "src-live"
    }))
    .unwrap();
    let grok_cfg: GrokConfig = serde_json::from_value(serde_json::json!({
        "id": "grok-1",
        "name": "Grok",
        "apiHost": "https://stale-grok.example",
        "apiKey": "sk-stale",
        "defaultModel": "grok-3",
        "models": ["grok-3"],
        "sourceProviderId": "src-live"
    }))
    .unwrap();
    let desktop_cfg: ClaudeDesktopConfig = serde_json::from_value(serde_json::json!({
        "id": "cd-1",
        "name": "Claude Desktop",
        "apiHost": "https://stale-cd.example",
        "apiKey": "sk-stale",
        "sourceProviderId": "src-live"
    }))
    .unwrap();

    let providers = vec![live_source.clone()];
    assert!(ag_cfg.validate_active_source(&providers).is_ok());
    assert!(codex_cfg.validate_active_source(&providers).is_ok());
    assert!(claude_cfg.validate_active_source(&providers).is_ok());
    assert!(opencode_cfg.validate_active_source(&providers).is_ok());
    assert!(grok_cfg.validate_active_source(&providers).is_ok());
    assert!(desktop_cfg.validate_active_source(&providers).is_ok());

    for (label, resolved) in [
        ("antigravity", ag_cfg.resolve_provider(&providers)),
        ("codex", codex_cfg.resolve_provider(&providers)),
        ("claude-code", claude_cfg.resolve_provider(&providers)),
        ("opencode", opencode_cfg.resolve_provider(&providers)),
        ("grok", grok_cfg.resolve_provider(&providers)),
        ("claude-desktop", desktop_cfg.resolve_provider(&providers)),
    ] {
        assert_eq!(resolved.api_host, "https://live-upstream.example.com", "{label}");
        assert_eq!(resolved.api_path.as_deref(), Some("/v1/chat/completions"), "{label}");
        assert_eq!(resolved.api_key, "sk-live-primary", "{label}");
        assert_eq!(resolved.api_keys.len(), 3, "{label} 应继承完整密钥池");
        assert!(resolved.enabled, "{label}");
        assert!(resolved.capabilities.vision && resolved.capabilities.tools, "{label}");
        assert!(resolved.model_caps.contains_key("gpt-5"), "{label}");
        assert!(resolved.unlocks.claude_code.as_ref().is_some_and(|u| u.enabled), "{label}");
    }

    // Codex wire_api_auto 应随主供应商 apiPath 动态推断
    assert_eq!(codex_cfg.resolve_provider(&providers).wire_api, "chat");
    live_source.api_path = Some("/v1/responses".to_string());
    assert_eq!(codex_cfg.resolve_provider(&[live_source.clone()]).wire_api, "responses");

    // Antigravity: 中转站尊重 override；Google 原生端点锁定 Gemini
    assert_eq!(ag_cfg.resolve_provider(&providers).api_format, Some(ApiFormat::Anthropic));
    live_source.api_host = "https://generativelanguage.googleapis.com".to_string();
    live_source.api_path = Some("/v1beta".to_string());
    assert_eq!(ag_cfg.resolve_provider(&[live_source]).api_format, Some(ApiFormat::Gemini));
}

#[test]
fn resolve_provider_blocks_missing_or_disabled_source_without_fallback() {
    let mut disabled_src: Provider = serde_json::from_value(serde_json::json!({
        "id": "src-1",
        "name": "Primary",
        "apiHost": "https://primary.example",
        "apiKey": "sk-primary",
        "defaultModel": "gpt-5",
        "enabled": false
    }))
    .unwrap();
    let ag: AntigravityConfig = serde_json::from_value(serde_json::json!({
        "id": "ag", "name": "AG", "apiHost": "https://stale", "apiKey": "sk-stale",
        "defaultModel": "gemini-2.5-pro", "sourceProviderId": "src-1"
    })).unwrap();
    let codex: CodexConfig = serde_json::from_value(serde_json::json!({
        "id": "cx", "name": "CX", "apiHost": "https://stale", "apiKey": "sk-stale",
        "defaultModel": "gpt-5", "sourceProviderId": "src-1"
    })).unwrap();
    let claude: ClaudeCodeConfig = serde_json::from_value(serde_json::json!({
        "id": "cc", "name": "CC", "apiHost": "https://stale", "apiKey": "sk-stale",
        "defaultModel": "claude-sonnet-4-5", "sourceProviderId": "src-1"
    })).unwrap();
    let opencode: OpenCodeConfig = serde_json::from_value(serde_json::json!({
        "id": "oc", "name": "OC", "apiHost": "https://stale", "apiKey": "sk-stale",
        "defaultModel": "gpt-5", "sourceProviderId": "src-1"
    })).unwrap();
    let grok: GrokConfig = serde_json::from_value(serde_json::json!({
        "id": "gk", "name": "GK", "apiHost": "https://stale", "apiKey": "sk-stale",
        "defaultModel": "grok-3", "sourceProviderId": "src-1"
    })).unwrap();
    let desktop: ClaudeDesktopConfig = serde_json::from_value(serde_json::json!({
        "id": "cd", "name": "CD", "apiHost": "https://stale", "apiKey": "sk-stale",
        "sourceProviderId": "src-1"
    })).unwrap();

    // 1. 源供应商已禁用：validate 阻断且 resolve 返回 enabled = false
    let disabled_list = vec![disabled_src.clone()];
    for (name, res, resolved) in [
        ("ag", ag.validate_active_source(&disabled_list), ag.resolve_provider(&disabled_list)),
        ("cx", codex.validate_active_source(&disabled_list), codex.resolve_provider(&disabled_list)),
        ("cc", claude.validate_active_source(&disabled_list), claude.resolve_provider(&disabled_list)),
        ("oc", opencode.validate_active_source(&disabled_list), opencode.resolve_provider(&disabled_list)),
        ("gk", grok.validate_active_source(&disabled_list), grok.resolve_provider(&disabled_list)),
        ("cd", desktop.validate_active_source(&disabled_list), desktop.resolve_provider(&disabled_list)),
    ] {
        let err = res.expect_err(&format!("{name} 禁用源应报错"));
        assert!(err.contains("已禁用"), "{name}: {err}");
        assert!(!resolved.enabled, "{name} resolve_provider 必须保持 enabled=false");
    }

    // 2. 源供应商不存在（已被删除）：validate 报错且绝不静默启用旧快照
    disabled_src.id = "other-id".to_string();
    disabled_src.enabled = true;
    let missing_list = vec![disabled_src];
    for (name, res, resolved) in [
        ("ag", ag.validate_active_source(&missing_list), ag.resolve_provider(&missing_list)),
        ("cx", codex.validate_active_source(&missing_list), codex.resolve_provider(&missing_list)),
        ("cc", claude.validate_active_source(&missing_list), claude.resolve_provider(&missing_list)),
        ("oc", opencode.validate_active_source(&missing_list), opencode.resolve_provider(&missing_list)),
        ("gk", grok.validate_active_source(&missing_list), grok.resolve_provider(&missing_list)),
        ("cd", desktop.validate_active_source(&missing_list), desktop.resolve_provider(&missing_list)),
    ] {
        let err = res.expect_err(&format!("{name} 缺失源应报错"));
        assert!(err.contains("不存在"), "{name}: {err}");
        assert!(!resolved.enabled, "{name} 找不到源供应商时禁止静默回退为 enabled=true");
        assert_eq!(resolved.api_host, "https://stale", "{name} 未找回时不能串用其它供应商");
    }
}

struct TempConfigDirGuard(PathBuf);

impl TempConfigDirGuard {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "anybridge-config-{tag}-{}-{nanos}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempConfigDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_valid_generated_byok_key(key: &str) {
    assert!(key.starts_with("byok-"), "生成密钥必须带 byok- 前缀: {key}");
    assert!(
        !key.starts_with("byok-test-"),
        "落盘密钥不得使用测试占位前缀: {key}"
    );
    let hex_part = &key["byok-".len()..];
    assert_eq!(hex_part.len(), 48, "24 字节随机 hex 应为 48 字符: {key}");
    assert!(
        hex_part.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        "密钥后缀必须是小写 hex: {key}"
    );
}

#[test]
fn ensure_local_proxy_key_at_generates_byok_key_idempotently_and_creates_parents() {
    let dir = TempConfigDirGuard::new("key-create");
    let config_file = dir.path().join("nested").join("sub").join("byok-config.json");
    assert!(!config_file.exists());

    let first = ensure_local_proxy_key_at(&config_file).expect("首次生成密钥应成功");
    assert_valid_generated_byok_key(&first);
    assert!(config_file.exists(), "应原子写入配置文件");

    let raw = fs::read_to_string(&config_file).unwrap();
    let saved: ByokConfig = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        saved.values.get("LOCAL_PROXY_KEY").map(String::as_str),
        Some(first.as_str())
    );

    let second = ensure_local_proxy_key_at(&config_file).expect("二次读取密钥应成功");
    assert_eq!(second, first, "重复调用 ensure_local_proxy_key_at 必须幂等");
}

#[test]
fn ensure_local_proxy_key_at_preserves_other_fields_and_existing_key() {
    let dir = TempConfigDirGuard::new("key-preserve");

    // 1. 已有其它字段、缺少 LOCAL_PROXY_KEY：补齐密钥且完整保留原字段
    let missing_key_file = dir.path().join("missing-key.json");
    fs::write(
        &missing_key_file,
        serde_json::to_string_pretty(&serde_json::json!({
            "values": {
                "PROXY_PORT": "17450",
                "AUTO_START_PROXY": "false",
                "target_ide": "windsurf"
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let generated = ensure_local_proxy_key_at(&missing_key_file).unwrap();
    assert_valid_generated_byok_key(&generated);
    let saved: ByokConfig =
        serde_json::from_str(&fs::read_to_string(&missing_key_file).unwrap()).unwrap();
    assert_eq!(saved.values.get("PROXY_PORT").map(String::as_str), Some("17450"));
    assert_eq!(
        saved.values.get("AUTO_START_PROXY").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        saved.values.get("target_ide").map(String::as_str),
        Some("windsurf")
    );
    assert_eq!(
        saved.values.get("LOCAL_PROXY_KEY").map(String::as_str),
        Some(generated.as_str())
    );

    // 2. 已存在非空 LOCAL_PROXY_KEY：原样返回，不改写
    let existing_key_file = dir.path().join("existing-key.json");
    let before = serde_json::to_string_pretty(&serde_json::json!({
        "values": {
            "LOCAL_PROXY_KEY": "custom-existing-key",
            "PROXY_PORT": "17451"
        }
    }))
    .unwrap();
    fs::write(&existing_key_file, &before).unwrap();
    let returned = ensure_local_proxy_key_at(&existing_key_file).unwrap();
    assert_eq!(returned, "custom-existing-key");
    assert_eq!(fs::read_to_string(&existing_key_file).unwrap(), before);

    // 3. LOCAL_PROXY_KEY 为空白字符串：重新生成并保留其它字段
    let blank_key_file = dir.path().join("blank-key.json");
    fs::write(
        &blank_key_file,
        serde_json::to_string_pretty(&serde_json::json!({
            "values": {
                "LOCAL_PROXY_KEY": "   ",
                "PROXY_PORT": "17452"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let regenerated = ensure_local_proxy_key_at(&blank_key_file).unwrap();
    assert_valid_generated_byok_key(&regenerated);
    let saved_blank: ByokConfig =
        serde_json::from_str(&fs::read_to_string(&blank_key_file).unwrap()).unwrap();
    assert_eq!(
        saved_blank.values.get("PROXY_PORT").map(String::as_str),
        Some("17452")
    );
}

#[test]
fn ensure_local_proxy_key_at_rejects_corrupt_json_without_overwriting() {
    let dir = TempConfigDirGuard::new("key-corrupt");
    let config_file = dir.path().join("corrupt.json");
    fs::write(&config_file, "{not-valid-json").unwrap();

    let err = ensure_local_proxy_key_at(&config_file).unwrap_err();
    assert!(!err.is_empty());
    assert_eq!(fs::read_to_string(&config_file).unwrap(), "{not-valid-json");
}

#[test]
fn ensure_local_proxy_key_is_nonempty_and_stable() {
    let k1 = ensure_local_proxy_key().expect("应返回可用本地网关密钥");
    let k2 = ensure_local_proxy_key().expect("重复调用应稳定返回同一密钥");
    assert!(!k1.trim().is_empty());
    assert_eq!(k1, k2);
}

#[test]
fn config_dir_respects_byok_config_dir_and_ignores_blank() {
    let dir = TempConfigDirGuard::new("env-dir");
    let custom_dir = dir.path().join("isolated-config");
    let default_dir = named_config_dir(APP_CONFIG_DIR_NAME);

    let padded = format!("  {}  ", custom_dir.display());
    assert_eq!(
        resolve_config_dir_with_override(Some(padded.as_str()), &default_dir),
        (custom_dir, true)
    );
    assert_eq!(
        resolve_config_dir_with_override(Some("   \t "), &default_dir),
        (default_dir.clone(), false)
    );
    assert_eq!(
        resolve_config_dir_with_override(None, &default_dir),
        (default_dir, false)
    );
}
