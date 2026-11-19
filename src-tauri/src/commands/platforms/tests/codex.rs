use super::*;


    /// Codex 0.146+ 对 model catalog 做严格 schema 校验：任何条目缺
    /// `base_instructions` 等字段都会让 `codex` 启动直接失败。旧版 models_cache
    /// 模板没有这些字段，生成时必须由 bundled 模板补齐。
    #[test]
    fn generated_catalog_entries_satisfy_codex_required_fields() {
        let entries = vec![
            crate::commands::config::ModelCatalogEntry {
                model: "gpt-5-codex".to_string(),
                display_name: None,
                context_window: None,
            },
            crate::commands::config::ModelCatalogEntry {
                model: "claude-sonnet-4-5-20250929".to_string(),
                display_name: None,
                context_window: None,
            },
        ];
        let raw = generate_model_catalog_json(&entries).expect("catalog should be generated");
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let models = parsed["models"].as_array().unwrap();
        assert_eq!(models.len(), entries.len());
        for model in models {
            assert!(
                has_base_instructions(model),
                "missing base_instructions: {}",
                model["slug"]
            );
            assert!(
                model.get("supports_reasoning_summaries").is_some(),
                "missing supports_reasoning_summaries: {}",
                model["slug"]
            );
            assert!(
                model.get("model_messages").is_some(),
                "missing model_messages: {}",
                model["slug"]
            );
        }
    }


    /// 旧版 models_cache 模板缺 `base_instructions`（或写成 null）时，
    /// deep-clone 出来的条目必须被补齐，且不能覆盖已有字段。
    #[test]
    fn backfill_repairs_legacy_template_without_base_instructions() {
        let mut model = serde_json::json!({
            "slug": "claude-sonnet-4-5-20250929",
            "display_name": "Claude Sonnet 4.5",
            "base_instructions": null
        });
        backfill_model_fields_from_bundled(&mut model);
        assert!(has_base_instructions(&model));
        assert_eq!(model["slug"], "claude-sonnet-4-5-20250929");
        assert_eq!(model["display_name"], "Claude Sonnet 4.5");
        assert!(model.get("supports_reasoning_summaries").is_some());
    }


    /// 旧 catalog 的过期判定必须能抓到 schema 缺字段，否则 AnyBridge 不会重建。
    #[test]
    fn catalog_entry_required_field_check_detects_stale_schema() {
        let entries = vec![crate::commands::config::ModelCatalogEntry {
            model: "gpt-5-codex".to_string(),
            display_name: None,
            context_window: None,
        }];
        let raw = generate_model_catalog_json(&entries).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let model = parsed["models"][0].clone();
        assert!(catalog_entry_has_required_fields(&model));

        let mut stale = model.clone();
        stale
            .as_object_mut()
            .unwrap()
            .remove("base_instructions");
        assert!(!catalog_entry_has_required_fields(&stale));

        let mut nulled = model.clone();
        nulled["base_instructions"] = Value::Null;
        assert!(!catalog_entry_has_required_fields(&nulled));
    }


    #[test]
    fn codex_proxy_target_api_path_matches_wire_api() {
        let mut provider = test_openai_provider();
        provider.api_path = Some("/v1".to_string());
        provider.wire_api = "responses".to_string();
        assert_eq!(codex_proxy_target_api_path(&provider), "/v1/responses");

        provider.wire_api = "chat".to_string();
        assert_eq!(
            codex_proxy_target_api_path(&provider),
            "/v1/chat/completions"
        );

        provider.api_path = Some("/custom/responses".to_string());
        provider.wire_api = "chat".to_string();
        assert_eq!(codex_proxy_target_api_path(&provider), "/custom/responses");
    }


    fn test_proxy_route(id: &str, source: &str) -> crate::commands::proxy_routes::ProxyRoute {
        crate::commands::proxy_routes::ProxyRoute {
            id: id.to_string(),
            display_name: id.to_string(),
            enabled: true,
            exposed_formats: vec!["openai".to_string()],
            source: source.to_string(),
            targets: vec![crate::commands::proxy_routes::ProxyRouteTarget {
                provider_id: "provider-1".to_string(),
                model: id.to_string(),
                api_format: "openai".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }


    #[test]
    fn legacy_global_codex_cleanup_read_error_warns_without_blocking() {
        let plan = plan_clear_legacy_global_codex_proxy_routes_from(Err("bad json".to_string()));

        assert!(plan.routes.is_none());
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("读取 proxy-routes.json 失败"));
        assert!(plan.warnings[0].contains("不影响本次 Codex 切换"));
    }


    #[test]
    fn legacy_global_codex_cleanup_removes_only_old_codex_routes() {
        let plan = plan_clear_legacy_global_codex_proxy_routes_from(Ok(
            crate::commands::proxy_routes::ProxyRoutes {
                version: 1,
                default_model_id: String::new(),
                routes: vec![
                    test_proxy_route("deepseek-v4-flash", "codex:deepseek"),
                    test_proxy_route("manual-model", "manual"),
                ],
                claude_desktop: None,
            },
        ));

        assert!(plan.warnings.is_empty());
        let routes = plan.routes.expect("旧版 codex:* route 应触发清理写回");
        assert_eq!(routes.routes.len(), 1);
        assert_eq!(routes.routes[0].id, "manual-model");
        assert_eq!(routes.routes[0].source, "manual");
    }


    #[test]
    fn apply_codex_preserves_unrelated_toml_sections() {
        let path = temp_config_path("codex-preserve");
        fs::write(
            &path,
            r#"
model = "old-model"
model_provider = "old"

[mcp_servers.docs]
command = "node"

[projects."E:/project/demo"]
trust_level = "trusted"

[model_providers.old]
base_url = "https://old.example.com/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        let provider = test_openai_provider();
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let expected_codex_base = codex_base_url();
        let expected_codex_bearer = codex_bearer_token().unwrap();
        assert_eq!(doc["model"].as_str(), Some("gpt-test"));
        assert_eq!(
            doc["model_provider"].as_str(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["base_url"].as_str(),
            Some(expected_codex_base.as_str())
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["experimental_bearer_token"]
                .as_str(),
            Some(expected_codex_bearer.as_str())
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["requires_openai_auth"]
                .as_bool(),
            Some(false)
        );
        assert!(doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap()
            .get("env_key")
            .is_none());
        assert!(doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap()
            .get("auth")
            .is_none());
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID][CODEX_ANYBRIDGE_MANAGED_FLAG]
                .as_bool(),
            Some(true)
        );
        assert_eq!(
            doc["model_providers"]["old"]["base_url"].as_str(),
            Some("https://old.example.com/v1")
        );
        assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("node"));
        assert_eq!(
            doc["projects"]["E:/project/demo"]["trust_level"].as_str(),
            Some("trusted")
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn codex_apply_restore_contract_is_idempotent_and_preserves_user_edits() {
        let path = temp_config_path("codex-contract");
        let initial = r#"
model = "old-model"
model_provider = "old"

[mcp_servers.docs]
command = "node"

[projects."E:/project/demo"]
trust_level = "trusted"

[model_providers.old]
base_url = "https://old.example.com/v1"
wire_api = "responses"
"#;
        fs::write(&path, initial).unwrap();

        let stash = path.parent().unwrap().join("stash");
        let provider = test_openai_provider();
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();
        let first = fs::read_to_string(&path).unwrap();

        // 重复接入必须幂等：不能重复注入、不能改变无关区块的顺序或内容。
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();
        let second = fs::read_to_string(&path).unwrap();
        assert_eq!(first, second, "重复 apply_codex 必须产出完全一致的配置");

        // 用户在两次同步之间手动改的项目配置必须被下一次同步保留。
        let edited = first.replace("trust_level = \"trusted\"", "trust_level = \"untrusted\"");
        assert_ne!(edited, first);
        fs::write(&path, &edited).unwrap();
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();
        let after_user_edit = fs::read_to_string(&path).unwrap();
        assert!(after_user_edit.contains("trust_level = \"untrusted\""));
        assert!(after_user_edit.contains("[mcp_servers.docs]"));
        assert!(after_user_edit.contains("https://old.example.com/v1"));

        // 切回官方只撤销 AnyBridge 托管状态，仍然不能吞掉用户配置。
        apply_codex_official_with_stash(&path, true, &stash).unwrap();
        let after_restore = fs::read_to_string(&path).unwrap();
        let doc = after_restore.parse::<DocumentMut>().unwrap();
        assert_eq!(
            doc["projects"]["E:/project/demo"]["trust_level"].as_str(),
            Some("untrusted")
        );
        assert_eq!(
            doc["mcp_servers"]["docs"]["command"].as_str(),
            Some("node")
        );
        assert_eq!(
            doc["model_providers"]["old"]["base_url"].as_str(),
            Some("https://old.example.com/v1")
        );
        assert!(doc.get("model").is_none());
        let managed = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();
        assert_eq!(
            managed.get("requires_openai_auth").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(managed.get("experimental_bearer_token").is_none());
        assert!(managed.get("base_url").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_clears_conflicting_oauth_and_bearer_fields() {
        let path = temp_config_path("codex-auth-conflict");
        fs::write(
            &path,
            r#"
model = "stale-model"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
experimental_bearer_token = "sk-stale-conflict"
anybridge_managed = true

[model_providers.codex_local_access.auth]
command = "echo"
args = ["token"]
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        let provider = test_openai_provider();
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let provider = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();
        let expected_codex_bearer = codex_bearer_token().unwrap();

        assert_eq!(
            provider
                .get("requires_openai_auth")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            provider
                .get("experimental_bearer_token")
                .and_then(|v| v.as_str()),
            Some(expected_codex_bearer.as_str())
        );
        assert!(provider.get("env_key").is_none());
        assert!(provider.get("auth").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_agents_preserves_user_roles_and_replaces_managed_roles() {
        let path = temp_config_path("codex-agents");
        let dir = path.parent().unwrap().join(CODEX_ANYBRIDGE_AGENTS_DIRNAME);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old-agent.toml"), "name = \"old-agent\"\n").unwrap();
        fs::write(
            dir.join(CODEX_ANYBRIDGE_AGENTS_MANIFEST),
            r#"{
  "version": 1,
  "roles": ["old-agent"],
  "files": ["old-agent.toml"],
  "managedGlobal": {
    "max_threads": 6,
    "max_depth": 1,
    "job_max_runtime_seconds": 1800
  }
}"#,
        )
        .unwrap();
        fs::write(
            &path,
            r#"
model = "old-model"

[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 1800

[agents.old-agent]
description = "old managed"
config_file = "./anybridge-agents/old-agent.toml"

[agents.manual]
description = "user managed"
config_file = "./agents/manual.toml"
"#,
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        provider.agents_config = Some(AgentsGlobalConfig {
            max_threads: 4,
            max_depth: 1,
            job_max_runtime_seconds: 900,
        });
        provider.agents = vec![CodexAgent {
            name: "code-reviewer".to_string(),
            description: "Review code for correctness.".to_string(),
            developer_instructions: "Prioritize bugs and missing tests.".to_string(),
            model: "gpt-test".to_string(),
            model_reasoning_effort: Some("high".to_string()),
            sandbox_mode: Some("read-only".to_string()),
            nickname_candidates: vec!["Atlas".to_string()],
        }];

        let stash = path.parent().unwrap().join("stash");
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let agents = doc["agents"].as_table().unwrap();
        assert!(agents.get("old-agent").is_none());
        assert_eq!(
            agents["manual"]["config_file"].as_str(),
            Some("./agents/manual.toml")
        );
        assert_eq!(
            agents["code-reviewer"]["config_file"].as_str(),
            Some("./anybridge-agents/code-reviewer.toml")
        );
        assert_eq!(agents["max_threads"].as_integer(), Some(4));
        assert!(!dir.join("old-agent.toml").exists());
        let agent_raw = fs::read_to_string(dir.join("code-reviewer.toml")).unwrap();
        assert!(agent_raw.contains("developer_instructions"));
        assert!(agent_raw.contains("model_reasoning_effort = \"high\""));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_agents_rejects_invalid_global_config_before_cleanup() {
        let path = temp_config_path("codex-agents-invalid-global");
        let dir = path.parent().unwrap().join(CODEX_ANYBRIDGE_AGENTS_DIRNAME);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old-agent.toml"), "name = \"old-agent\"\n").unwrap();
        fs::write(
            dir.join(CODEX_ANYBRIDGE_AGENTS_MANIFEST),
            r#"{
  "version": 1,
  "roles": ["old-agent"],
  "files": ["old-agent.toml"],
  "managedGlobal": {
    "max_threads": 6,
    "max_depth": 1,
    "job_max_runtime_seconds": 1800
  }
}"#,
        )
        .unwrap();
        fs::write(
            &path,
            r#"
[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 1800

[agents.old-agent]
description = "old managed"
config_file = "./anybridge-agents/old-agent.toml"
"#,
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        provider.agents_config = Some(AgentsGlobalConfig {
            max_threads: 0,
            max_depth: 1,
            job_max_runtime_seconds: 900,
        });
        provider.agents = vec![CodexAgent {
            name: "code-reviewer".to_string(),
            description: "Review code for correctness.".to_string(),
            developer_instructions: "Prioritize bugs and missing tests.".to_string(),
            model: "gpt-test".to_string(),
            model_reasoning_effort: Some("high".to_string()),
            sandbox_mode: Some("read-only".to_string()),
            nickname_candidates: vec!["Atlas".to_string()],
        }];

        let stash = path.parent().unwrap().join("stash");
        let err = Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap_err();
        assert!(err.contains("maxThreads"));
        assert!(dir.join("old-agent.toml").exists());
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("[agents.old-agent]"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_codex_removes_service_tier_when_switching_to_third_party() {
        let path = temp_config_path("codex-remove-service-tier");
        fs::write(
            &path,
            r#"
model = "gpt-5.6-sol"
model_provider = "openai"
service_tier = "default"

[model_providers.openai]
name = "OpenAI"
"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        let provider = test_openai_provider();
        Platform::Codex
            .apply_codex_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(
            doc.get("service_tier").is_none(),
            "service_tier should be removed when switching to third-party provider"
        );
        assert_eq!(
            doc["model_provider"].as_str(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn codex_direct_base_url_strips_endpoint_suffix_and_keeps_api_root() {
        let mut provider = test_openai_provider();

        // 端点后缀必须剥掉：Codex 会自行拼接 "/responses"。
        provider.api_path = Some("/v1/responses".to_string());
        assert_eq!(codex_direct_base_url(&provider), "https://example.com/v1");
        provider.api_path = Some("/v1/chat/completions".to_string());
        assert_eq!(codex_direct_base_url(&provider), "https://example.com/v1");
        provider.api_path = Some("/V1/Chat/Completions".to_string());
        assert_eq!(codex_direct_base_url(&provider), "https://example.com/V1");

        // 已经是根路径的原样保留，非 /v1 的自定义根路径不得被改写。
        provider.api_path = Some("/v1".to_string());
        assert_eq!(codex_direct_base_url(&provider), "https://example.com/v1");
        provider.api_path = Some("/zen/go/v1".to_string());
        assert_eq!(
            codex_direct_base_url(&provider),
            "https://example.com/zen/go/v1"
        );
        provider.api_path = Some("/api/v2".to_string());
        assert_eq!(
            codex_direct_base_url(&provider),
            "https://example.com/api/v2"
        );

        // 空路径不能产生 "https://host/" —— 否则 Codex 拼成 "https://host//responses"。
        for empty in [None, Some(String::new()), Some("/".to_string())] {
            provider.api_path = empty;
            assert_eq!(codex_direct_base_url(&provider), "https://example.com/v1");
        }

        // 裸域名补 scheme，尾部斜杠不残留。
        provider.api_host = "example.com/".to_string();
        provider.api_path = Some("/v1/responses/".to_string());
        assert_eq!(codex_direct_base_url(&provider), "https://example.com/v1");
    }


    #[test]
    fn infer_wire_api_from_api_path_reads_endpoint_suffix() {
        assert_eq!(
            infer_wire_api_from_api_path(Some("/v1/chat/completions")),
            Some("chat")
        );
        assert_eq!(
            infer_wire_api_from_api_path(Some("/V1/Chat/Completions/")),
            Some("chat")
        );
        assert_eq!(
            infer_wire_api_from_api_path(Some("/v1/responses")),
            Some("responses")
        );
        // 路径里没有端点信息时不瞎猜，交给调用方保留原值。
        assert_eq!(infer_wire_api_from_api_path(Some("/v1")), None);
        assert_eq!(infer_wire_api_from_api_path(Some("")), None);
        assert_eq!(infer_wire_api_from_api_path(None), None);
    }
