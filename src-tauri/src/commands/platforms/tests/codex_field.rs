use super::*;


    #[test]
    fn apply_codex_official_strips_bearer_when_enabling_oauth() {
        let path = temp_config_path("codex-oauth-from-conflict");
        fs::write(
            &path,
            r#"
model = "third-party"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "OPENAI_API_KEY"
experimental_bearer_token = "sk-test-removed"
anybridge_managed = true
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        apply_codex_official_with_stash(&path, true, &stash).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let provider = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();

        assert_eq!(
            provider
                .get("requires_openai_auth")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(provider.get("experimental_bearer_token").is_none());
        assert!(provider.get("env_key").is_none());
        assert!(provider.get("auth").is_none());
        assert!(provider.get("base_url").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_direct_provider_writes_provider_api_key() {
        let path = temp_config_path("codex-direct");
        fs::write(
            &path,
            r#"
model = "old-model"

[model_providers.old]
base_url = "https://old.example.com/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert_eq!(
            doc["model_provider"].as_str(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        // api_path 是 "/v1/responses"，但 base_url 必须是根路径：
        // Codex 自己会拼 "/responses"，带后缀会请求到 ".../v1/responses/responses"。
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["base_url"].as_str(),
            Some("https://example.com/v1")
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["experimental_bearer_token"]
                .as_str(),
            Some("sk-test-secret")
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 构造一份 Codex 配置：`extra` 用于追加字段（如 `,"wireApiAuto":false`）。
    fn test_codex_config(source_id: &str, extra: &str) -> crate::commands::config::CodexConfig {
        serde_json::from_str(&format!(
            r#"{{"id":"cfg-1","name":"Cfg","apiHost":"https://example.com","apiKey":"sk-x","defaultModel":"gpt-5","sourceProviderId":"{source_id}","wireApi":"responses"{extra}}}"#
        ))
        .unwrap()
    }


    /// 非 unify 切回：model / model_provider / service_tier 全部写回用户原值。
    /// 全程用临时 stash（apply 与 official 必须同一本账，且不得碰真实账本）。
    #[test]
    fn codex_field_restore_writes_back_user_scalars_non_unify() {
        with_field_restore(true, || {
            let (path, stash) = field_restore_tmp_toml("non-unify");
            fs::write(&path, CODEX_USER_ORIGINAL).unwrap();

            Platform::Codex
                .apply_codex_with_stash(&path, &test_openai_provider(), &stash)
                .unwrap();
            let doc = fs::read_to_string(&path)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap();
            assert_eq!(
                doc.get("model").and_then(toml_item_string).as_deref(),
                Some("gpt-test"),
                "接入后 model 被覆盖"
            );
            assert_eq!(
                doc.get("model_provider")
                    .and_then(toml_item_string)
                    .as_deref(),
                Some(CODEX_RUNTIME_MODEL_PROVIDER_ID),
                "接入后 model_provider 被覆盖"
            );
            assert!(
                doc.get("service_tier").is_none(),
                "接入后 service_tier 被删除"
            );

            apply_codex_official_with_stash(&path, false, &stash).unwrap();

            let doc = fs::read_to_string(&path)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap();
            assert_eq!(
                doc.get("model").and_then(toml_item_string).as_deref(),
                Some("my-model"),
                "model 必须写回原值"
            );
            assert_eq!(
                doc.get("model_provider")
                    .and_then(toml_item_string)
                    .as_deref(),
                Some("my-provider"),
                "model_provider 必须写回原值"
            );
            assert_eq!(
                doc.get("service_tier")
                    .and_then(toml_item_string)
                    .as_deref(),
                Some("pro"),
                "service_tier 必须写回原值"
            );
            assert!(
                doc.get("model_providers")
                    .and_then(|i| i.get("my-provider"))
                    .is_some(),
                "用户自己的 provider 表必须原样保留"
            );
            assert!(
                doc.get("model_providers")
                    .and_then(|i| i.get(CODEX_RUNTIME_MODEL_PROVIDER_ID))
                    .is_none(),
                "托管 provider 表必须删除"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// unify 切回：provider 指针与其从属的 model 结构性不可恢复（诚实跳过），
    /// service_tier 照常恢复。
    #[test]
    fn codex_unify_skips_dependent_scalars_and_restores_service_tier() {
        with_field_restore(true, || {
            let (path, stash) = field_restore_tmp_toml("unify");
            fs::write(&path, CODEX_USER_ORIGINAL).unwrap();

            Platform::Codex
                .apply_codex_with_stash(&path, &test_openai_provider(), &stash)
                .unwrap();
            apply_codex_official_with_stash(&path, true, &stash).unwrap();

            let doc = fs::read_to_string(&path)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap();
            assert_eq!(
                doc.get("model_provider")
                    .and_then(toml_item_string)
                    .as_deref(),
                Some(CODEX_RUNTIME_MODEL_PROVIDER_ID),
                "unify 模式 provider 指针固定（结构性不可恢复）"
            );
            assert!(
                doc.get("model").is_none(),
                "unify 模式 model 作为 provider 从属值一并跳过恢复"
            );
            assert_eq!(
                doc.get("service_tier")
                    .and_then(toml_item_string)
                    .as_deref(),
                Some("pro"),
                "service_tier 与 provider 无关，必须恢复"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// 无账本记录时门控开启也退回删托管键旧语义（清理能力不丢）。
    #[test]
    fn codex_official_without_stash_falls_back_to_removal() {
        with_field_restore(true, || {
            let (path, stash) = field_restore_tmp_toml("no-stash");
            fs::write(
                &path,
                r#"model = "third-party-model"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "Third"
base_url = "https://third.example.com/v1"
anybridge_managed = true
"#,
            )
            .unwrap();

            apply_codex_official_with_stash(&path, false, &stash).unwrap();

            let doc = fs::read_to_string(&path)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap();
            assert!(doc.get("model").is_none(), "无账本时 model 必须删除");
            assert!(
                doc.get("model_provider").is_none(),
                "无账本时 model_provider 必须删除"
            );
            assert!(
                doc.get("model_providers")
                    .and_then(|i| i.get(CODEX_RUNTIME_MODEL_PROVIDER_ID))
                    .is_none(),
                "managed provider 表必须删除"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    #[test]
    fn apply_codex_auto_wire_api_heals_legacy_configs_from_source_path() {
        // 存量配置：wireApi 被历史前端一律写成 "responses"，且完全没有 wireApiAuto 字段。
        let config = test_codex_config("prov-chat", "");
        assert!(
            config.wire_api_auto,
            "缺少 wireApiAuto 的存量配置必须默认视为自动推断，否则修复对存量不生效"
        );

        let mut store = test_store_with_chat_source(config);
        let mut provider = test_openai_provider();
        provider.wire_api = "responses".to_string();
        apply_codex_auto_wire_api(&mut provider, &mut store, "cfg-1");
        assert_eq!(
            provider.wire_api, "chat",
            "来源只支持 Chat Completions 时，代理必须请求 /chat/completions"
        );
        // 必须写回 store：sidecar 从 providers.json 的 codexConfigs 读 wireApi
        // 决定要不要做 Responses→Chat 转换。只改内存会让路由打到 /chat/completions
        // 却仍发 Responses 格式的请求体 —— 比不修更糟。
        assert_eq!(
            store.codex_configs[0].wire_api, "chat",
            "推断结果必须持久化，否则 sidecar 仍按 responses 处理请求体"
        );
    }


    #[test]
    fn apply_codex_auto_wire_api_respects_explicit_user_choice() {
        let config = test_codex_config("prov-chat", r#","wireApiAuto":false"#);
        let mut store = test_store_with_chat_source(config);
        let mut provider = test_openai_provider();
        provider.wire_api = "responses".to_string();
        apply_codex_auto_wire_api(&mut provider, &mut store, "cfg-1");
        assert_eq!(
            provider.wire_api, "responses",
            "用户在 UI 上显式选定后，推断不得覆盖"
        );
        assert_eq!(store.codex_configs[0].wire_api, "responses");
    }


    #[test]
    fn apply_codex_auto_wire_api_keeps_value_when_source_is_unknown() {
        // 来源供应商已被删除 / 从未记录来源：保持原值，不做任何猜测。
        for source_id in ["prov-missing", ""] {
            let config = test_codex_config(source_id, "");
            let mut store = test_store_with_chat_source(config);
            let mut provider = test_openai_provider();
            provider.wire_api = "responses".to_string();
            apply_codex_auto_wire_api(&mut provider, &mut store, "cfg-1");
            assert_eq!(provider.wire_api, "responses");
            assert_eq!(store.codex_configs[0].wire_api, "responses");
        }

        // 配置 id 对不上时同样不改。
        let config = test_codex_config("prov-chat", "");
        let mut store = test_store_with_chat_source(config);
        let mut provider = test_openai_provider();
        provider.wire_api = "responses".to_string();
        apply_codex_auto_wire_api(&mut provider, &mut store, "cfg-unknown");
        assert_eq!(provider.wire_api, "responses");
    }


    #[test]
    fn apply_codex_direct_with_official_auth_does_not_require_api_key() {
        let path = temp_config_path("codex-direct-oauth-no-key");

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        provider.preserve_official_auth = true;
        provider.api_key = String::new();
        let stash = path.parent().unwrap().join("stash");
        // preserve_official_auth 下 bearer 本就会被丢弃，不该因为缺 Key 阻断切换。
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let provider_table = &doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID];
        assert_eq!(provider_table["requires_openai_auth"].as_bool(), Some(true));
        assert!(
            provider_table.get("experimental_bearer_token").is_none(),
            "OAuth 模式不得写入 bearer"
        );
        assert_eq!(
            provider_table["base_url"].as_str(),
            Some("https://example.com/v1")
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_direct_without_official_auth_still_requires_api_key() {
        let path = temp_config_path("codex-direct-missing-key");

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        provider.api_key = "   ".to_string();
        let stash = path.parent().unwrap().join("stash");
        let err = Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap_err();
        assert!(err.contains("缺少 API Key"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn read_codex_config_info_uses_only_active_provider() {
        let path = temp_config_path("codex-active");
        fs::write(
            &path,
            r#"
model = "gpt-5.5"
model_provider = "codex_local_access"

[model_providers.byok]
name = "AnyBridge stale"
base_url = "https://stale.example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-stale"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert_eq!(info.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(
            info.model_provider_id.as_deref(),
            Some("codex_local_access")
        );
        assert_eq!(info.provider_name.as_deref(), Some("AnyRouter"));
        assert_eq!(info.base_url.as_deref(), Some("https://anyrouter.top/v1"));
        assert_eq!(info.wire_api.as_deref(), Some("responses"));
        assert!(!info.has_bearer_token);
        assert!(!info.managed_by_any_bridge);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn read_codex_config_info_marks_byok_as_managed() {
        let path = temp_config_path("codex-byok");
        fs::write(
            &path,
            r#"
model = "gpt-test"
model_provider = "byok"

[model_providers.byok]
name = "Test Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test-secret"
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert_eq!(info.model_provider_id.as_deref(), Some("byok"));
        assert_eq!(info.provider_name.as_deref(), Some("Test Provider"));
        assert!(info.has_bearer_token);
        assert!(!info.is_official);
        assert!(info.managed_by_any_bridge);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn read_codex_config_info_marks_anybridge_local_access_as_managed() {
        let path = temp_config_path("codex-managed-local-access");
        fs::write(
            &path,
            r#"
model = "gpt-test"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test-secret"
anybridge_managed = true
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert_eq!(
            info.model_provider_id.as_deref(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert_eq!(info.provider_name.as_deref(), Some("AnyRouter"));
        assert!(info.managed_by_any_bridge);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn read_codex_config_info_without_provider_is_official() {
        let path = temp_config_path("codex-official");
        fs::write(
            &path,
            r#"
[mcp_servers.docs]
command = "node"
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert!(info.is_official);
        assert!(!info.managed_by_any_bridge);
        assert_eq!(info.model_provider_id, None);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn read_codex_config_info_unified_official_is_official() {
        let path = temp_config_path("codex-unified-official");
        fs::write(
            &path,
            r#"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "OpenAI 官方"
wire_api = "responses"
requires_openai_auth = true
anybridge_managed = true
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert!(info.is_official);
        assert!(info.managed_by_any_bridge);
        assert_eq!(
            info.model_provider_id.as_deref(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert!(info.base_url.is_none());
        assert!(!info.has_bearer_token);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_official_with_unify_keeps_codex_local_access_bucket() {
        let path = temp_config_path("codex-restore-unify-official");
        fs::write(
            &path,
            r#"
model = "third-party-model"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyBridge"
base_url = "http://127.0.0.1:7450/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test"
anybridge_managed = true
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        apply_codex_official_with_stash(&path, true, &stash).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(doc.get("model").is_none());
        assert_eq!(
            doc.get("model_provider").and_then(|item| item.as_str()),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        let provider = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();
        assert_eq!(
            provider.get("name").and_then(|v| v.as_str()),
            Some("OpenAI 官方")
        );
        assert_eq!(
            provider
                .get("requires_openai_auth")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(provider.get("base_url").is_none());
        assert!(provider.get("experimental_bearer_token").is_none());
        assert_eq!(
            provider
                .get(CODEX_ANYBRIDGE_MANAGED_FLAG)
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert!(info.is_official);
        assert!(info.managed_by_any_bridge);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_official_removes_active_byok_but_preserves_common_config() {
        let path = temp_config_path("codex-restore-official");
        fs::write(
            &path,
            r#"
model = "third-party-model"
model_provider = "byok"

[mcp_servers.docs]
command = "node"

[model_providers.byok]
name = "AnyBridge"
base_url = "https://example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        apply_codex_official_with_stash(&path, false, &stash).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(doc.get("model").is_none());
        assert!(doc.get("model_provider").is_none());
        assert!(doc["model_providers"]
            .as_table()
            .unwrap()
            .get("byok")
            .is_none());
        assert_eq!(
            doc["model_providers"]["codex_local_access"]["base_url"].as_str(),
            Some("https://anyrouter.top/v1")
        );
        assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("node"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_official_removes_anybridge_managed_local_access() {
        // 显式关门控并串行化：其它测试并行把 ANYBRIDGE_FIELD_RESTORE 设为 1 时，
        // 本测试会误走字段级还原分支而随机红（坑点 test-isolation-real-stash-and-env-gate）。
        with_gates(None, Some(false), || {
            let path = temp_config_path("codex-restore-managed-local-access");
            fs::write(
                &path,
                r#"
model = "third-party-model"
model_provider = "codex_local_access"

[mcp_servers.docs]
command = "node"

[model_providers.codex_local_access]
name = "AnyBridge"
base_url = "http://127.0.0.1:7450/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test"
anybridge_managed = true

[model_providers.manual]
name = "Manual"
base_url = "https://manual.example.com/v1"
wire_api = "responses"
"#,
            )
            .unwrap();

            let stash = path.parent().unwrap().join("stash");
            apply_codex_official_with_stash(&path, false, &stash).unwrap();

            let raw = fs::read_to_string(&path).unwrap();
            let doc = raw.parse::<DocumentMut>().unwrap();
            assert!(doc.get("model").is_none());
            assert!(doc.get("model_provider").is_none());
            assert!(doc["model_providers"]
                .as_table()
                .unwrap()
                .get(CODEX_RUNTIME_MODEL_PROVIDER_ID)
                .is_none());
            assert_eq!(
                doc["model_providers"]["manual"]["base_url"].as_str(),
                Some("https://manual.example.com/v1")
            );
            assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("node"));

            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }
