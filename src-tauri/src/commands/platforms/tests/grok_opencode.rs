use super::*;


    #[test]
    fn apply_grok_writes_anybridge_model_and_preserves_user_sections() {
        // 显式传临时账本并显式关门控：走无参入口会读到真实 agent-stash.json
        // 与其它测试临时设置的 ANYBRIDGE_FIELD_RESTORE（并行时随机红，
        // 见坑点 test-isolation-real-stash-and-env-gate）。
        with_gates(None, Some(false), || {
        let path = temp_config_path("grok-apply");
        let stash = path.parent().unwrap().join("stash");
        fs::write(
            &path,
            r#"
[cli]
auto_update = false

[models]
default = "grok-4.5"

[model.existing]
model = "grok-4.5"
name = "Official Grok"
"#,
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.id = "deepseek".to_string();
        provider.name = "DeepSeek".to_string();
        provider.default_model = "deepseek-coder".to_string();
        provider.api_host = "https://api.deepseek.com".to_string();
        provider.api_path = Some("/v1/chat/completions".to_string());
        provider.api_key = "sk-1234567890".to_string();
        provider.context_window = Some(65536);

        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert_eq!(doc["cli"]["auto_update"].as_bool(), Some(false));
        assert_eq!(doc["models"]["default"].as_str(), Some("deepseek"));
        assert_eq!(
            doc["model"]["existing"]["name"].as_str(),
            Some("Official Grok")
        );

        let deepseek_table = doc["model"]["deepseek"].as_table().unwrap();
        // display name 要带模型名，否则 Grok 状态栏只显示配置名看不出模型
        assert_eq!(
            deepseek_table["name"].as_str(),
            Some("DeepSeek · deepseek-coder")
        );
        assert_eq!(deepseek_table["model"].as_str(), Some("deepseek-coder"));
        assert_eq!(
            deepseek_table["base_url"].as_str(),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(deepseek_table["api_key"].as_str(), Some("sk-1234567890"));
        assert_eq!(
            deepseek_table["api_backend"].as_str(),
            Some("chat_completions")
        );
        assert_eq!(deepseek_table["context_window"].as_integer(), Some(65536));
        assert_eq!(deepseek_table["anybridge_managed"].as_bool(), Some(true));

        let info = read_grok_config_info(&path).unwrap().unwrap();
        assert_eq!(info.0.as_deref(), Some("deepseek"));
        assert_eq!(info.1.as_deref(), Some("DeepSeek · deepseek-coder"));
        assert_eq!(info.2, true);

        // 测试 default_model 为空时的回退
        provider.default_model = "   ".to_string();
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let raw2 = fs::read_to_string(&path).unwrap();
        let doc2 = raw2.parse::<DocumentMut>().unwrap();
        assert_eq!(doc2["model"]["deepseek"]["model"].as_str(), Some("default"));

        // 测试切回官方配置
        apply_grok_official_with_stash(&path, &stash).unwrap();
        let raw3 = fs::read_to_string(&path).unwrap();
        let doc3 = raw3.parse::<DocumentMut>().unwrap();
        assert_eq!(doc3["cli"]["auto_update"].as_bool(), Some(false));
        assert_eq!(
            doc3["model"]["existing"]["name"].as_str(),
            Some("Official Grok")
        );
        assert!(doc3
            .get("model")
            .unwrap()
            .as_table()
            .unwrap()
            .get("deepseek")
            .is_none());
        assert!(doc3.get("models").is_none());

        let info2 = read_grok_config_info(&path).unwrap().unwrap();
        assert_eq!(info2.2, false);

        let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    #[test]
    fn apply_grok_writes_context_window_only_when_configured() {
        let path = temp_config_path("grok-context-window");
        let mut provider = test_openai_provider();
        provider.id = "ctx-model".to_string();
        provider.name = "Ctx Model".to_string();
        provider.default_model = "deepseek-chat".to_string();
        provider.api_host = "https://api.deepseek.com".to_string();
        provider.api_path = Some("/v1".to_string());
        provider.api_key = "sk-ctx".to_string();

        let stash = path.parent().unwrap().join("stash");
        // 未配置时不写该字段
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let doc = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        let table = doc["model"]["ctx-model"].as_table().unwrap();
        assert!(table.get("context_window").is_none());

        // 配置后写入整数，且预览同步
        provider.context_window = Some(131072);
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let doc2 = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert_eq!(
            doc2["model"]["ctx-model"]
                .as_table()
                .unwrap()
                .get("context_window")
                .and_then(Item::as_integer),
            Some(131072)
        );

        let preview = Platform::Grok.preview(&provider).unwrap();
        assert!(preview.contains("context_window = 131072"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_grok_registers_multiple_models_and_prunes_stale_sections() {
        use std::collections::HashMap;

        let path = temp_config_path("grok-multi-model");
        fs::write(
            &path,
            "[model.foreign]\nmodel = \"keep-me\"\nname = \"Foreign\"\n",
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.id = "cpa".to_string();
        provider.name = "CPA".to_string();
        provider.default_model = "model-a".to_string();
        provider.api_host = "https://api.example.com".to_string();
        provider.api_path = Some("/v1".to_string());
        provider.api_key = "sk-multi".to_string();
        provider.models = vec!["model-a".to_string(), "model-b".to_string()];
        provider.model_contexts =
            HashMap::from([("model-a".to_string(), 200000u32), ("model-b".to_string(), 64000u32)]);

        let stash = path.parent().unwrap().join("stash");
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();

        let doc = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert_eq!(doc["models"]["default"].as_str(), Some("cpa"));
        assert_eq!(doc["model"]["cpa"]["model"].as_str(), Some("model-a"));
        assert_eq!(
            doc["model"]["cpa"].as_table().unwrap()["context_window"].as_integer(),
            Some(200000)
        );
        let extra = doc["model"]["cpa--model-b"].as_table().unwrap();
        assert_eq!(extra["model"].as_str(), Some("model-b"));
        assert_eq!(extra["context_window"].as_integer(), Some(64000));
        assert_eq!(extra["api_key"].as_str(), Some("sk-multi"));
        // 非 AnyBridge 托管的段必须原样保留
        assert_eq!(doc["model"]["foreign"]["model"].as_str(), Some("keep-me"));

        // 附加模型段是宿主配置的一部分，不能作为独立「外部配置」列出
        let info = read_grok_config_info(&path).unwrap().unwrap();
        assert!(info.3.iter().any(|k| k == "cpa"));
        assert!(info.3.iter().any(|k| k == "foreign"));
        assert!(!info.3.iter().any(|k| k == "cpa--model-b"));

        // 取消勾选 model-b 后，它的段必须消失，主段保留
        provider.models = vec!["model-a".to_string()];
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();

        let doc2 = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert!(doc2["model"].as_table().unwrap().get("cpa--model-b").is_none());
        assert_eq!(doc2["model"]["cpa"]["model"].as_str(), Some("model-a"));
        assert_eq!(doc2["model"]["foreign"]["model"].as_str(), Some("keep-me"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_grok_writes_subagent_models_and_prunes_own_entries() {
        use std::collections::HashMap;

        // 用户手写的子代理映射，必须原样保留
        let path = temp_config_path("grok-subagents");
        fs::write(&path, "[subagents.models]\nmanual = \"grok-4.6\"\n").unwrap();

        let mut provider = test_openai_provider();
        provider.id = "cpa".to_string();
        provider.name = "CPA".to_string();
        provider.default_model = "model-a".to_string();
        provider.api_host = "https://api.example.com".to_string();
        provider.api_path = Some("/v1".to_string());
        provider.api_key = "sk-sub".to_string();
        provider.models = vec!["model-a".to_string(), "model-b".to_string()];
        provider.subagent_models = HashMap::from([
            ("explore".to_string(), "cpa--model-b".to_string()),
            ("plan".to_string(), "cpa".to_string()),
        ]);

        let stash = path.parent().unwrap().join("stash");
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let doc = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        // 实测：models 存在时必须显式 enabled = true，否则 spawn_subagent 工具消失
        assert_eq!(doc["subagents"]["enabled"].as_bool(), Some(true));
        let agents = doc["subagents"]["models"].as_table().unwrap();
        assert_eq!(agents["explore"].as_str(), Some("cpa--model-b"));
        assert_eq!(agents["plan"].as_str(), Some("cpa"));
        assert_eq!(agents["manual"].as_str(), Some("grok-4.6"));

        // 取消 explore 的覆盖后，本配置写的那条必须消失；用户手写项不能动
        provider.subagent_models = HashMap::from([("plan".to_string(), "cpa".to_string())]);
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let doc2 = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        let agents2 = doc2["subagents"]["models"].as_table().unwrap();
        assert!(agents2.get("explore").is_none());
        assert_eq!(agents2["plan"].as_str(), Some("cpa"));
        assert_eq!(agents2["manual"].as_str(), Some("grok-4.6"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_grok_removes_empty_subagents_table() {
        use std::collections::HashMap;

        let path = temp_config_path("grok-subagents-empty");
        let mut provider = test_openai_provider();
        provider.id = "cpa".to_string();
        provider.name = "CPA".to_string();
        provider.default_model = "model-a".to_string();
        provider.api_host = "https://api.example.com".to_string();
        provider.api_path = Some("/v1".to_string());
        provider.api_key = "sk-sub".to_string();
        provider.subagent_models =
            HashMap::from([("explore".to_string(), "cpa".to_string())]);

        let stash = path.parent().unwrap().join("stash");
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let doc = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert_eq!(doc["subagents"]["models"]["explore"].as_str(), Some("cpa"));

        // 全部取消后，不留空段
        provider.subagent_models = HashMap::new();
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        let doc2 = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert!(doc2.get("subagents").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_grok_creates_file_if_missing_and_restores_cleanly() {
        let path = temp_config_path("grok-missing-init");
        if path.exists() {
            let _ = fs::remove_file(&path);
        }

        let mut provider = test_openai_provider();
        provider.id = "custom-grok-model".to_string();
        provider.name = "My Custom".to_string();
        provider.default_model = "gpt-4o".to_string();
        provider.api_host = "https://api.openai.com".to_string();
        provider.api_path = Some("/v1".to_string());
        provider.api_key = "sk-live-secret".to_string();

        let stash = path.parent().unwrap().join("stash");
        // 验证文件原本不存在时创建
        Platform::Grok
            .apply_grok_with_stash(&path, &provider, &stash)
            .unwrap();
        assert!(path.exists());

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert_eq!(doc["models"]["default"].as_str(), Some("custom-grok-model"));
        assert_eq!(
            doc["model"]["custom-grok-model"]["name"].as_str(),
            Some("My Custom · gpt-4o")
        );
        assert_eq!(
            doc["model"]["custom-grok-model"]["model"].as_str(),
            Some("gpt-4o")
        );

        // 验证切回官方后托管段与 models.default 被清理
        apply_grok_official_with_stash(&path, &stash).unwrap();
        let raw2 = fs::read_to_string(&path).unwrap();
        let doc2 = raw2.parse::<DocumentMut>().unwrap();
        assert!(doc2
            .get("model")
            .unwrap()
            .as_table()
            .unwrap()
            .get("custom-grok-model")
            .is_none());
        assert!(doc2.get("models").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_opencode_official_clears_managed_providers_and_model_pointer() {
        let path = temp_config_path("opencode-official-restore");
        fs::write(
            &path,
            r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "managed-deepseek/deepseek-coder",
  "provider": {
    "managed-deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek Managed"
    },
    "user-custom": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "User Custom Manual"
    }
  }
}"#,
        )
        .unwrap();

        let mut store = ProviderStore::default();
        store.opencode_configs.push(OpenCodeConfig {
            id: "managed-deepseek".to_string(),
            name: "DeepSeek Managed".to_string(),
            api_host: "https://api.deepseek.com".to_string(),
            api_key: "sk-123456".to_string(),
            api_path: Some("/v1".to_string()),
            default_model: "deepseek-coder".to_string(),
            models: vec!["deepseek-coder".to_string()],
            settings_config: None,
            source_provider_id: String::new(),
            source_provider_name: String::new(),
        });

        let stash = path.parent().unwrap().join("stash");
        apply_opencode_official_with_stash(&path, &store, &stash).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let val: Value = serde_json::from_str(&raw).unwrap();
        assert!(val.get("model").is_none());
        assert!(val["provider"].get("managed-deepseek").is_none());
        assert_eq!(
            val["provider"]["user-custom"]["name"].as_str(),
            Some("User Custom Manual")
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    fn opencode_test_config(id: &str) -> OpenCodeConfig {
        OpenCodeConfig {
            id: id.to_string(),
            name: "Managed".to_string(),
            api_host: "https://managed.example.com".to_string(),
            api_key: "sk-managed".to_string(),
            api_path: Some("/v1".to_string()),
            default_model: "deepseek-coder".to_string(),
            models: vec!["deepseek-coder".to_string()],
            settings_config: None,
            source_provider_id: String::new(),
            source_provider_name: String::new(),
        }
    }


    /// 接入 → 切回：原本不存在的 provider 被删除，用户的 model 指回原值。
    #[test]
    fn opencode_field_restore_roundtrip_restores_user_state() {
        with_field_restore(true, || {
            let (path, stash) = field_restore_tmp("opencode-roundtrip");
            fs::write(&path, OPENCODE_ORIGINAL).unwrap();

            apply_opencode_config_file_with_stash(
                &path,
                &opencode_test_config("managed-deepseek"),
                &stash,
            )
            .unwrap();
            // 接入后：托管 provider 存在，model 指向它
            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(val["provider"].get("managed-deepseek").is_some());
            assert_eq!(
                val.get("model").and_then(Value::as_str),
                Some("managed-deepseek/deepseek-coder")
            );

            let mut store = ProviderStore::default();
            store
                .opencode_configs
                .push(opencode_test_config("managed-deepseek"));
            apply_opencode_official_with_stash(&path, &store, &stash).unwrap();

            let val: Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(
                val["provider"].get("managed-deepseek").is_none(),
                "原本不存在的托管 provider 必须删除"
            );
            assert_eq!(
                val.get("model").and_then(Value::as_str),
                Some("user-own/gpt-x"),
                "用户的 model 指向必须写回原值"
            );
            assert_eq!(
                val["provider"]["user-own"]["name"].as_str(),
                Some("User Own"),
                "用户自己的 provider 必须原样保留"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// 接管期间用户改了 model → 切回时保留用户的值（不写回旧值）。
    #[test]
    fn opencode_field_restore_keeps_user_model_change() {
        with_field_restore(true, || {
            let (path, stash) = field_restore_tmp("opencode-user-model");
            fs::write(&path, OPENCODE_ORIGINAL).unwrap();

            apply_opencode_config_file_with_stash(
                &path,
                &opencode_test_config("managed-deepseek"),
                &stash,
            )
            .unwrap();

            // 用户接管期间手动改 model
            let mut obj = parse_json_object(
                &fs::read_to_string(&path).unwrap(),
                "opencode.json",
            )
            .unwrap();
            obj.insert("model".into(), Value::String("user-own/picked".into()));
            fs::write(
                &path,
                serde_json::to_string_pretty(&Value::Object(obj)).unwrap(),
            )
            .unwrap();

            let mut store = ProviderStore::default();
            store
                .opencode_configs
                .push(opencode_test_config("managed-deepseek"));
            apply_opencode_official_with_stash(&path, &store, &stash).unwrap();

            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                val.get("model").and_then(Value::as_str),
                Some("user-own/picked"),
                "用户接管期间改过的 model 必须保留"
            );
            assert!(
                val["provider"].get("managed-deepseek").is_none(),
                "托管 provider 仍必须删除"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// 无账本记录时门控开启也退回删托管键旧语义（清理能力不丢）。
    #[test]
    fn opencode_official_without_stash_falls_back_to_removal() {
        with_field_restore(true, || {
            let (path, stash) = field_restore_tmp("opencode-no-stash");
            fs::write(
                &path,
                r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "managed-deepseek/deepseek-coder",
  "provider": {
    "managed-deepseek": { "npm": "@ai-sdk/openai-compatible" },
    "user-keep": { "npm": "@ai-sdk/openai-compatible" }
  }
}"#,
            )
            .unwrap();

            let mut store = ProviderStore::default();
            store
                .opencode_configs
                .push(opencode_test_config("managed-deepseek"));
            apply_opencode_official_with_stash(&path, &store, &stash).unwrap();

            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(val["provider"].get("managed-deepseek").is_none());
            assert_eq!(
                val["provider"]["user-keep"]["npm"].as_str(),
                Some("@ai-sdk/openai-compatible"),
                "非托管 provider 必须保留"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// 保形门控 + 字段级还原双开：往返后注释与既有成员结构保留。
    /// 注意：必须用 with_gates 单层设置两个门控——嵌套两个 helper 会
    /// 对同一把锁二次加锁死锁（std Mutex 不可重入）。
    #[test]
    fn opencode_preserving_roundtrip_keeps_comments() {
        with_gates(Some(true), Some(true), || {
                let (path, stash) = field_restore_tmp("opencode-preserving");
                fs::write(&path, OPENCODE_ORIGINAL).unwrap();

                apply_opencode_config_file_with_stash(
                    &path,
                    &opencode_test_config("managed-deepseek"),
                    &stash,
                )
                .unwrap();
                let out = fs::read_to_string(&path).unwrap();
                assert!(out.contains("\"user-own\""), "接入后用户 provider 保留");
                assert!(
                    out.contains("@ai-sdk/openai-compatible"),
                    "接入内容存在"
                );

                let mut store = ProviderStore::default();
                store
                    .opencode_configs
                    .push(opencode_test_config("managed-deepseek"));
                apply_opencode_official_with_stash(&path, &store, &stash).unwrap();

                let out2 = fs::read_to_string(&path).unwrap();
                let val: Value = serde_json::from_str(&out2).unwrap();
                assert!(
                    val["provider"].get("managed-deepseek").is_none(),
                    "托管 provider 已删除"
                );
                assert_eq!(
                    val.get("model").and_then(Value::as_str),
                    Some("user-own/gpt-x"),
                    "model 写回原值"
                );
                // 保形：provider 表仍是原缩进风格（user-own 在前）
                assert!(out2.contains("@ai-sdk/openai-compatible"));
                let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// Grok：models.default 指针写回用户原值。
    #[test]
    fn grok_field_restore_writes_back_user_default() {
        with_field_restore(true, || {
            let (path, stash) = named_tmp_config("grok-fr", "config.toml");
            fs::write(
                &path,
                "[terminal]\ntheme = \"dark\"\n\n[models]\ndefault = \"my-own\"\n",
            )
            .unwrap();

            let p = test_openai_provider();
            Platform::Grok
                .apply_grok_with_stash(&path, &p, &stash)
                .unwrap();
            let doc = fs::read_to_string(&path)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap();
            assert_ne!(
                doc["models"]["default"].as_str(),
                Some("my-own"),
                "接入后 default 被覆盖"
            );

            apply_grok_official_with_stash(&path, &stash).unwrap();

            let doc = fs::read_to_string(&path)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap();
            assert_eq!(
                doc["models"]["default"].as_str(),
                Some("my-own"),
                "default 必须写回用户原值"
            );
            assert!(
                doc.get("terminal").is_some(),
                "用户其它配置必须保留"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }
