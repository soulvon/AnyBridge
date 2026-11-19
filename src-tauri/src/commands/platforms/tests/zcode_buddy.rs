use super::*;


    #[test]
    fn test_model_context_presets_resolution() {
        assert_eq!(
            resolve_model_context_preset("step-5-preview"),
            (1_048_576, 131_072)
        );
        assert_eq!(
            resolve_model_context_preset("step-5"),
            (1_048_576, 131_072)
        );
        assert_eq!(
            resolve_model_context_preset("step-3.7-flash"),
            (262_144, 65_536)
        );
        assert_eq!(
            resolve_model_context_preset("claude-haiku-5-5"),
            (1_000_000, 128_000)
        );
        assert_eq!(
            resolve_model_context_preset("gemini-4-argon"),
            (1_048_576, 65_536)
        );
        assert_eq!(
            resolve_model_context_preset("mistral-large-4"),
            (1_048_576, 131_072)
        );
        assert_eq!(
            resolve_model_context_preset("nemotron-3.5-super-vl"),
            (1_048_576, 65_536)
        );
        assert_eq!(
            resolve_model_context_preset("deepseek-v4.1-flash-1017"),
            (1_048_576, 384_000)
        );
        assert_eq!(
            resolve_model_context_preset("unknown-custom-model-xyz"),
            (256_000, 16_384)
        );
    }


    /// ZCode：托管 provider 删除，用户 provider 原样保留。
    #[test]
    fn zcode_field_restore_roundtrip_keeps_user_provider() {
        with_field_restore(true, || {
            let (path, stash) = named_tmp_config("zcode-fr", "config.json");
            fs::write(
                &path,
                r#"{
  "$schema": "https://zcode.z.ai/config.json",
  "provider": {
    "Acme": { "type": "openai", "name": "Acme" }
  }
}"#,
            )
            .unwrap();

            let p = test_openai_provider();
            apply_zcode_config_file_with_stash(
                &path,
                &p,
                &zcode_stash_key("config.json"),
                &stash,
            )
            .unwrap();
            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(val["provider"].get(ZCODE_PROVIDER_ID).is_some());

            crate::commands::field_restore::restore_json_fields_via_stash(
                &path,
                &zcode_stash_key("config.json"),
                &stash,
                "ZCode",
            )
            .unwrap();

            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(
                val["provider"].get(ZCODE_PROVIDER_ID).is_none(),
                "托管 provider 必须删除"
            );
            assert_eq!(
                val["provider"]["Acme"]["name"].as_str(),
                Some("Acme"),
                "用户 provider 必须保留"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// Buddy：models 数组按 id —— 托管条目删除、用户条目保留。
    #[test]
    fn buddy_field_restore_roundtrip_keeps_user_models() {
        with_field_restore(true, || {
            let (path, stash) = named_tmp_config("buddy-fr", "models.json");
            fs::write(
                &path,
                r#"{
  "models": [
    { "id": "user-model", "name": "User Own", "vendor": "user" }
  ]
}"#,
            )
            .unwrap();

            let p = test_openai_provider();
            apply_buddy_models_json_with_stash(&path, &p, false, &stash).unwrap();
            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(
                val["models"].as_array().unwrap().len() >= 2,
                "接入后应有托管条目"
            );

            restore_buddy_fields_via_stash(&path, "codebuddy", &stash).unwrap();

            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let arr = val["models"].as_array().unwrap();
            assert_eq!(arr.len(), 1, "托管条目必须删除，仅剩用户条目");
            assert_eq!(arr[0]["id"].as_str(), Some("user-model"));
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    fn zcode_sync_test_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("provider_config.json")
    }


    fn zcode_sync_model(id: &str, vendor: &str, url: &str, supports_images: bool) -> Value {
        serde_json::json!({
            "id": id,
            "name": vendor,
            "vendor": vendor,
            "url": url,
            "apiKey": "sk-test",
            "providerId": "AnyBridge-35222063",
            "supportsImages": supports_images,
            "maxInputTokens": 1000000,
            "maxOutputTokens": 65536,
        })
    }


    #[test]
    fn zcode_sync_writes_image_support_into_personal_config() {
        let path = zcode_sync_test_path("zc-sync-fresh");
        let models = vec![zcode_sync_model(
            "gemini-3.8-flash-high",
            "CPA",
            "http://127.0.0.1:8317/v1",
            true,
        )];
        sync_zcode_personal_config_at(&path, &models).unwrap();

        let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let provider_id = val["config"]["providerConfigRules"]["providerRules"][0]["providerId"]
            .as_str()
            .unwrap();
        assert!(provider_id.starts_with("AnyBridge-"));
        let rules = &val["config"]["modelConfigRules"]["providerModelRules"];
        assert_eq!(rules.as_array().unwrap().len(), 1);
        assert_eq!(rules[0]["modelId"], "gemini-3.8-flash-high");
        assert_eq!(
            rules[0]["config"]["properties"]["inputFormat"]["supportsImage"],
            true
        );
        assert_eq!(rules[0]["config"]["properties"]["contextWindow"], 1000000);
        assert_eq!(
            rules[0]["config"]["optionSpecs"]["maxOutputTokens"]["max"],
            65536
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn zcode_sync_preserves_manual_modality_fields_and_other_providers() {
        let path = zcode_sync_test_path("zc-sync-merge");
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "AnyBridge-35222063",
          "providerName": "CPA",
          "enabled": false,
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "sk-old" },
            "api": { "type": "openai-chat-completions", "baseUrl": "http://127.0.0.1:8317/v1" },
            "personalModelIds": ["gemini-3.8-flash-high"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [
        {
          "providerId": "AnyBridge-35222063",
          "modelId": "gemini-3.8-flash-high",
          "config": {
            "properties": {
              "contextWindow": 999,
              "inputFormat": { "supportsImage": false, "supportsVideo": true, "supportsPdf": true },
              "supportsNativeWebSearch": true
            }
          }
        },
        {
          "providerId": "user-own",
          "modelId": "glm-4.7",
          "config": { "properties": { "inputFormat": { "supportsImage": true } } }
        }
      ],
      "manualProviderModelRules": []
    }
  }
}"#,
        )
        .unwrap();

        let models = vec![zcode_sync_model(
            "gemini-3.8-flash-high",
            "CPA",
            "http://127.0.0.1:8317/v1",
            true,
        )];
        sync_zcode_personal_config_at(&path, &models).unwrap();

        let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let rule = &val["config"]["modelConfigRules"]["providerModelRules"][0];
        // AnyBridge 管理的字段被更新
        assert_eq!(rule["config"]["properties"]["contextWindow"], 1000000);
        assert_eq!(
            rule["config"]["properties"]["inputFormat"]["supportsImage"],
            true
        );
        // 用户手动勾选的字段被保留
        assert_eq!(
            rule["config"]["properties"]["inputFormat"]["supportsVideo"],
            true
        );
        assert_eq!(
            rule["config"]["properties"]["inputFormat"]["supportsPdf"],
            true
        );
        assert_eq!(
            rule["config"]["properties"]["supportsNativeWebSearch"],
            true
        );
        // provider 级未知字段（enabled）保留，apiKey 更新
        let provider_rule = &val["config"]["providerConfigRules"]["providerRules"][0];
        assert_eq!(provider_rule["enabled"], false);
        assert_eq!(provider_rule["config"]["access"]["apiKey"], "sk-test");
        // 其它供应商规则原样保留
        let other = &val["config"]["modelConfigRules"]["providerModelRules"][1];
        assert_eq!(other["providerId"], "user-own");
        assert_eq!(
            other["config"]["properties"]["inputFormat"]["supportsImage"],
            true
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn zcode_sync_writes_and_clears_reasoning_levels() {
        let path = zcode_sync_test_path("zc-sync-levels");
        // 预置：模型已有旧档位（含 map），验证覆盖与清除语义
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": { "providerRules": [] },
    "modelConfigRules": {
      "providerModelRules": [
        {
          "providerId": "AnyBridge-35222063",
          "modelId": "gpt-5.6-luna",
          "config": { "optionSpecs": { "reasoningLevel": { "values": ["disabled"], "map": "{}" } } }
        },
        {
          "providerId": "AnyBridge-35222063",
          "modelId": "gemini-3.8-flash-high",
          "config": { "optionSpecs": { "reasoningLevel": { "values": ["enabled"], "map": "{}" } } }
        }
      ],
      "manualProviderModelRules": []
    }
  }
}"#,
        )
        .unwrap();

        let models = vec![
            {
                let mut m =
                    zcode_sync_model("gpt-5.6-luna", "CPA", "http://127.0.0.1:8317/v1", true);
                m["reasoningLevels"] =
                    serde_json::json!(["none", "low", "medium", "high", "xhigh", "max"]);
                m["reasoningLevelMap"] = serde_json::json!("{}");
                m
            },
            // gemini 不配档位：预置的 reasoningLevel 应被移除（恢复内置默认）
            zcode_sync_model(
                "gemini-3.8-flash-high",
                "CPA",
                "http://127.0.0.1:8317/v1",
                true,
            ),
        ];
        sync_zcode_personal_config_at(&path, &models).unwrap();

        let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let rules = val["config"]["modelConfigRules"]["providerModelRules"]
            .as_array()
            .unwrap();
        let luna = rules
            .iter()
            .find(|r| r["modelId"] == "gpt-5.6-luna")
            .unwrap();
        assert_eq!(
            luna["config"]["optionSpecs"]["reasoningLevel"]["values"],
            serde_json::json!(["none", "low", "medium", "high", "xhigh", "max"])
        );
        assert_eq!(luna["config"]["optionSpecs"]["reasoningLevel"]["map"], "{}");
        let gemini = rules
            .iter()
            .find(|r| r["modelId"] == "gemini-3.8-flash-high")
            .unwrap();
        assert!(gemini["config"]["optionSpecs"]
            .get("reasoningLevel")
            .is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn zcode_sync_removes_stale_models_and_disables_image() {
        let path = zcode_sync_test_path("zc-sync-stale");
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": { "providerRules": [] },
    "modelConfigRules": {
      "providerModelRules": [
        {
          "providerId": "AnyBridge-stalehash",
          "modelId": "removed-model",
          "config": { "properties": { "contextWindow": 123 } }
        }
      ],
      "manualProviderModelRules": []
    }
  }
}"#,
        )
        .unwrap();

        let models = vec![zcode_sync_model(
            "gemini-3.1-pro-low",
            "CPA",
            "http://127.0.0.1:8317/v1",
            false,
        )];
        sync_zcode_personal_config_at(&path, &models).unwrap();

        let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let rules = val["config"]["modelConfigRules"]["providerModelRules"]
            .as_array()
            .unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0]["modelId"], "gemini-3.1-pro-low");
        // 无 vision 能力时显式关闭图片输入
        assert_eq!(
            rules[0]["config"]["properties"]["inputFormat"]["supportsImage"],
            false
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
