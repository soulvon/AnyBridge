use super::*;


    #[test]
    fn upsert_models_json_entry_keeps_user_settings_for_same_provider() {
        let mut obj = models_json_obj(
            r#"{
              "models": [{
                "id": "grok-4.7", "name": "黑与白Grok", "vendor": "user",
                "url": "https://ai.hybgzs.com/v1/chat/completions", "apiKey": "k1",
                "maxInputTokens": 500000, "maxOutputTokens": 32000,
                "temperature": 0.3, "modelId": "grok-4.7", "onlyReasoning": true,
                "reasoning": { "supportedEfforts": ["high"], "canDisableThinking": false, "summary": "auto" }
              }]
            }"#,
        );
        let new_model = serde_json::json!({
            "id": "grok-4.7", "name": "黑与白Grok", "vendor": "user",
            "url": "https://ai.hybgzs.com/v1/chat/completions", "apiKey": "k1",
            "maxInputTokens": 500000, "maxOutputTokens": 64000,
            "supportsToolCall": true
        });
        upsert_models_json_entry(&mut obj, "grok-4.7", new_model).unwrap();

        let entry = &obj.get("models").unwrap().as_array().unwrap()[0];
        // 供应商字段照常写入
        assert_eq!(entry["supportsToolCall"], true);
        // 用户手工下调的输出上限不被推荐值覆盖
        assert_eq!(entry["maxOutputTokens"], 32000);
        // 用户个性化字段保留
        assert_eq!(entry["temperature"], 0.3);
        assert_eq!(entry["modelId"], "grok-4.7");
        assert_eq!(entry["reasoning"]["supportedEfforts"][0], "high");
        // 思考开关与思考档位同属用户配置，供应商重新应用时整体搬过来
        assert_eq!(entry["onlyReasoning"], true);
        assert_eq!(entry["reasoning"]["canDisableThinking"], false);
        assert_eq!(entry["reasoning"]["summary"], "auto");
    }


    #[test]
    fn upsert_models_json_entry_replaces_entry_when_provider_changes() {
        let mut obj = models_json_obj(
            r#"{
              "models": [{
                "id": "grok-4.7", "name": "旧供应商", "vendor": "user",
                "url": "https://old.example.com/v1/chat/completions", "apiKey": "old-key",
                "maxInputTokens": 500000, "maxOutputTokens": 32000,
                "temperature": 0.3, "reasoning": { "supportedEfforts": ["high"] }
              }]
            }"#,
        );
        let new_model = serde_json::json!({
            "id": "grok-4.7", "name": "新供应商", "vendor": "user",
            "url": "https://new.example.com/v1/chat/completions", "apiKey": "new-key",
            "maxInputTokens": 500000, "maxOutputTokens": 64000,
            "supportsToolCall": true
        });
        upsert_models_json_entry(&mut obj, "grok-4.7", new_model).unwrap();

        let entry = &obj.get("models").unwrap().as_array().unwrap()[0];
        assert_eq!(entry["name"], "新供应商");
        assert_eq!(entry["apiKey"], "new-key");
        assert_eq!(entry["maxOutputTokens"], 64000);
        // 换供应商后不继承旧模型的个性化配置
        assert!(entry.get("temperature").is_none());
        assert!(entry.get("reasoning").is_none());
    }


    #[test]
    fn apply_claude_writes_complete_model_env_and_preserves_settings() {
        let path = temp_json_path("claude-apply");
        fs::write(
            &path,
            r#"{
  "language": "zh-CN",
  "permissions": { "allow": ["Bash"] },
  "hooks": { "PostToolUse": [] },
  "env": {
    "ANTHROPIC_SMALL_FAST_MODEL": "legacy-fast",
    "MCP_TIMEOUT": "120000"
  }
}"#,
        )
        .unwrap();

        let stash = path.parent().unwrap().join("stash");
        Platform::ClaudeCode
            .apply_claude_with_stash(&path, &test_claude_provider(), &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
            Some("https://anthropic.example.com")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
            Some("sk-ant-test-secret")
        );
        for key in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
        ] {
            assert_eq!(
                env.get(key).and_then(Value::as_str),
                Some("claude-test-model"),
                "{key} should be written"
            );
        }
        assert!(env.get("ANTHROPIC_SMALL_FAST_MODEL").is_none());
        assert_eq!(
            env.get("MCP_TIMEOUT").and_then(Value::as_str),
            Some("120000")
        );
        assert_eq!(value.get("language").and_then(Value::as_str), Some("zh-CN"));
        assert!(value.get("permissions").is_some());
        assert!(value.get("hooks").is_some());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn apply_claude_config_file_normalizes_old_saved_settings_config() {
        let path = temp_json_path("claude-settings-config");
        fs::write(
            &path,
            r#"{
  "env": {
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "stale-fable",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "stale-fable"
  },
  "permissions": { "allow": ["Read"] }
}"#,
        )
        .unwrap();

        let config = ClaudeCodeConfig {
            id: "claude-config-1".to_string(),
            name: "Saved Claude".to_string(),
            api_host: "https://saved.example.com".to_string(),
            api_key: "sk-saved".to_string(),
            api_path: None,
            default_model: "claude-saved-model".to_string(),
            models: Vec::new(),
            settings_config: Some(serde_json::json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://saved.example.com",
                    "ANTHROPIC_AUTH_TOKEN": "sk-saved",
                    "ANTHROPIC_MODEL": "claude-saved-model"
                }
            })),
            source_provider_id: String::new(),
            source_provider_name: String::new(),
        };

        let stash = path.parent().unwrap().join("stash");
        apply_claude_config_file_with_stash(&path, &config, &stash).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_FABLE_MODEL")
                .and_then(Value::as_str),
            Some("claude-saved-model")
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME")
                .and_then(Value::as_str),
            Some("claude-saved-model")
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME")
                .and_then(Value::as_str),
            Some("claude-saved-model")
        );
        assert!(value.get("permissions").is_some());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 用户自己改过的字段在字段级还原时必须保留（当前值 != applied）。
    #[test]
    fn field_restore_keeps_user_edits_made_while_wired() {
        let (path, stash) = field_restore_tmp("keep-user-edits");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();
        let plat = Platform::ClaudeCode;

        // 接入
        plat.apply_claude_with_stash(&path, &test_claude_provider(), &stash)
            .unwrap();

        // 接管期间用户手动改了 ANTHROPIC_MODEL
        let mut obj =
            crate::commands::ide_config::parse_object(&fs::read_to_string(&path).unwrap())
                .unwrap();
        obj["env"]["ANTHROPIC_MODEL"] = Value::String("user-picked".into());
        fs::write(
            &path,
            serde_json::to_string_pretty(&Value::Object(obj)).unwrap(),
        )
        .unwrap();

        // 切回官方（字段级）
        plat.apply_claude_official_with_stash(&path, true, &stash)
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
            Some("https://corp.example"),
            "未被用户改动的字段必须写回原值"
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
            Some("sk-user-original"),
            "未被用户改动的字段必须写回原值"
        );
        assert_eq!(
            env.get("ANTHROPIC_MODEL").and_then(Value::as_str),
            Some("user-picked"),
            "用户在接管期间改过的字段必须保留"
        );
        assert!(
            value.get("permissions").is_some(),
            "非托管字段必须原样保留"
        );

        // 清账完成
        let stash_key = claude_stash_key();
        assert!(crate::commands::agent_stash::entries_for(&stash, &stash_key)
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 无记账记录时，门控开启也必须退回「删托管键」旧语义（不能丢清理能力）。
    #[test]
    fn field_restore_without_stash_falls_back_to_removal() {
        let (path, stash) = field_restore_tmp("no-stash");
        fs::write(
            &path,
            r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "https://third.example",
    "ANTHROPIC_AUTH_TOKEN": "sk-token",
    "OTHER_KEY": "keep-me"
  }
}"#,
        )
        .unwrap();
        let plat = Platform::ClaudeCode;
        plat.apply_claude_official_with_stash(&path, true, &stash)
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert!(env.get("ANTHROPIC_BASE_URL").is_none(), "托管键必须清除");
        assert!(env.get("ANTHROPIC_AUTH_TOKEN").is_none(), "托管键必须清除");
        assert_eq!(
            env.get("OTHER_KEY").and_then(Value::as_str),
            Some("keep-me"),
            "非托管键必须保留"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 门控关闭（默认）时行为与旧版完全一致：删托管键、保留其它。
    #[test]
    fn gate_off_keeps_legacy_removal_semantics() {
        let (path, stash) = field_restore_tmp("gate-off");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();
        let plat = Platform::ClaudeCode;
        plat.apply_claude_with_stash(&path, &test_claude_provider(), &stash)
            .unwrap();
        plat.apply_claude_official_with_stash(&path, false, &stash)
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        // 旧语义：env 清空后整个 env 对象被移除（FIELD_RESTORE_ORIGINAL 的
        // env 只含托管键）；门控关闭时不写回任何原值
        assert!(
            value.get("env").is_none(),
            "env 只含托管键且全被删除时，旧语义必须整体移除 env"
        );
        assert!(value.get("permissions").is_some());
        // 记账仍在（记账与还原行为解耦）
        assert!(
            !crate::commands::agent_stash::entries_for(&stash, &claude_stash_key())
                .unwrap()
                .is_empty()
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 供应商直连接入：original 只记首次，重复切换不覆盖（配合字段级还原）。
    #[test]
    fn supplier_apply_records_original_once_and_restore_writes_it_back() {
        let (path, stash) = field_restore_tmp("apply-restore-roundtrip");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();
        let plat = Platform::ClaudeCode;

        // 第一次接入（原值 corp）
        plat.apply_claude_with_stash(&path, &test_claude_provider(), &stash)
            .unwrap();
        // 第二次切换到另一供应商（current 已是 anybridge 值）
        let mut provider2 = test_claude_provider();
        provider2.api_host = "https://other.example.com".into();
        provider2.default_model = "other-model".into();
        plat.apply_claude_with_stash(&path, &provider2, &stash)
            .unwrap();

        // original 必须保持 corp（不被第二次覆盖）
        let entries = crate::commands::agent_stash::entries_for(&stash, &claude_stash_key())
            .unwrap();
        let base_entry = entries
            .iter()
            .find(|e| e.path.join(".") == "env.ANTHROPIC_BASE_URL")
            .expect("必须有 BASE_URL 记账");
        assert_eq!(
            base_entry.original,
            crate::commands::agent_stash::Stashed::s("https://corp.example")
        );
        assert_eq!(
            base_entry.applied,
            crate::commands::agent_stash::Stashed::s("https://other.example.com")
        );

        // 字段级还原
        plat.apply_claude_official_with_stash(&path, true, &stash)
            .unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
            Some("https://corp.example"),
            "两次切换后仍必须回到最初原值"
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
            Some("sk-user-original")
        );
        // SMALL_FAST_MODEL 原本存在，接入时被删，还原时必须写回
        assert_eq!(
            env.get("ANTHROPIC_SMALL_FAST_MODEL").and_then(Value::as_str),
            Some("claude-haiku-old"),
            "接入时被删除的键必须按 original 写回"
        );
        assert!(
            value.get("permissions").is_some(),
            "非托管字段必须原样保留"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    // ── Drift（配置漂移检测）行为测试 ─────────────────────────────

    /// 外部改走 BASE_URL → 检出 drift 且分类为 unwired；未动 → 无漂移。
    #[test]
    fn drift_detected_when_external_changes_base_url() {
        let (path, stash) = field_restore_tmp("drift-unwired");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();
        let plat = Platform::ClaudeCode;
        plat.apply_claude_with_stash(&path, &test_claude_provider(), &stash)
            .unwrap();

        // 未被改动：无漂移
        assert!(
            detect_claude_drift_in(&stash, &path).is_empty(),
            "apply 后没人动配置，不能报漂移"
        );

        // 外部把 BASE_URL 改走（如用户手填了另一家中转站）
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["env"]["ANTHROPIC_BASE_URL"] = Value::String("https://rival.example".into());
        fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();

        let drift = detect_claude_drift_in(&stash, &path);
        assert_eq!(drift.len(), 1, "只动了 BASE_URL 一处: {drift:?}");
        assert_eq!(drift[0].path, "env.ANTHROPIC_BASE_URL");
        assert_eq!(drift[0].kind, "unwired");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 模型被外部改回 → kind=replaced；键被外部删除（改回 absent）同样算漂移。
    #[test]
    fn drift_catches_replaced_model_and_removed_key() {
        let (path, stash) = field_restore_tmp("drift-replaced");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();
        let plat = Platform::ClaudeCode;
        plat.apply_claude_with_stash(&path, &test_claude_provider(), &stash)
            .unwrap();

        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["env"]["ANTHROPIC_MODEL"] = Value::String("claude-official-model".into());
        // applied 时 AUTH_TOKEN 被写入；外部把整个键删掉 = 改回 absent
        value["env"].as_object_mut().unwrap().remove("ANTHROPIC_AUTH_TOKEN");
        fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();

        let drift = detect_claude_drift_in(&stash, &path);
        let by_path = |p: &str| {
            drift
                .iter()
                .find(|d| d.path == p)
                .unwrap_or_else(|| panic!("必须检出 {p} 的漂移: {drift:?}"))
        };
        assert_eq!(by_path("env.ANTHROPIC_MODEL").kind, "replaced");
        assert_eq!(by_path("env.ANTHROPIC_AUTH_TOKEN").kind, "changed");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 从未接管（空账本）→ 不报漂移（无记账无从比对，属「未知」而非「无漂移」，
    /// 前端对空列表不渲染，不伪装成否定结论）。
    #[test]
    fn drift_without_ledger_is_unknown_not_negative() {
        let (path, stash) = field_restore_tmp("drift-empty");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();
        assert!(detect_claude_drift_in(&stash, &path).is_empty());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// DriftField 序列化只含 path + kind——记账字段含 AUTH_TOKEN，
    /// 值一旦进结构就会泄露到 UI（结构性防泄露，锁死字段集）。
    #[test]
    fn drift_field_never_carries_values() {
        let field = DriftField {
            path: "env.ANTHROPIC_AUTH_TOKEN".into(),
            kind: "changed",
        };
        let json = serde_json::to_value(&field).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["kind", "path"], "DriftField 严禁携带值字段");
    }


    /// 记账与写入同一事务：apply 后立即字段级还原 = 字节级回到原文件内容
    /// （托管字段子集）。配置方案路径（settings_config）同验。
    #[test]
    fn config_file_apply_then_field_restore_roundtrip() {
        let (path, stash) = field_restore_tmp("config-roundtrip");
        fs::write(&path, FIELD_RESTORE_ORIGINAL).unwrap();

        let config = ClaudeCodeConfig {
            id: "claude-config-rt".to_string(),
            name: "RT Claude".to_string(),
            api_host: "https://saved.example.com".to_string(),
            api_key: "sk-saved".to_string(),
            api_path: None,
            default_model: "claude-saved-model".to_string(),
            models: Vec::new(),
            settings_config: Some(serde_json::json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://saved.example.com",
                    "ANTHROPIC_AUTH_TOKEN": "sk-saved",
                    "ANTHROPIC_MODEL": "claude-saved-model"
                }
            })),
            source_provider_id: String::new(),
            source_provider_name: String::new(),
        };
        apply_claude_config_file_with_stash(&path, &config, &stash).unwrap();

        Platform::ClaudeCode
            .apply_claude_official_with_stash(&path, true, &stash)
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
            Some("https://corp.example")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
            Some("sk-user-original")
        );
        assert!(
            value.get("permissions").is_some(),
            "settings_config 之外的顶层字段必须保留"
        );
        assert!(
            crate::commands::agent_stash::entries_for(&stash, &claude_stash_key())
                .unwrap()
                .is_empty(),
            "还原后必须清账"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    /// 门控开启：接入后注释、键顺序、既有键全部保留，仅目标值变化。
    #[test]
    fn format_preserving_apply_keeps_comments_and_order() {
        with_preserving_json(true, || {
            let (path, stash) = field_restore_tmp("preserving-apply");
            fs::write(&path, PRESERVING_ORIGINAL).unwrap();
            Platform::ClaudeCode
                .apply_claude_with_stash(&path, &test_claude_provider(), &stash)
                .unwrap();

            let out = fs::read_to_string(&path).unwrap();
            assert!(out.contains("// 我的注释"), "注释必须保留");
            assert!(out.contains("\"CUSTOM\": \"keep\""), "既有键必须保留");
            let base_pos = out.find("ANTHROPIC_BASE_URL").unwrap();
            let custom_pos = out.find("\"CUSTOM\"").unwrap();
            assert!(base_pos < custom_pos, "键顺序必须保持原样");
            // 保形输出含注释，必须用 json5 容错解析
            let obj = crate::commands::ide_config::parse_object(&out).unwrap();
            let env = obj.get("env").and_then(Value::as_object).unwrap();
            assert_eq!(
                env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
                Some("https://anthropic.example.com"),
                "目标值必须更新"
            );
            assert_eq!(
                env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
                Some("sk-ant-test-secret")
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// 门控开启：接入 → 切回官方 往返，注释保留 + 原值逐字段写回。
    #[test]
    fn format_preserving_restore_roundtrip_keeps_comments() {
        with_preserving_json(true, || {
            let (path, stash) = field_restore_tmp("preserving-roundtrip");
            fs::write(&path, PRESERVING_ORIGINAL).unwrap();
            let plat = Platform::ClaudeCode;
            plat.apply_claude_with_stash(&path, &test_claude_provider(), &stash)
                .unwrap();
            plat.apply_claude_official_with_stash(&path, true, &stash)
                .unwrap();

            let out = fs::read_to_string(&path).unwrap();
            assert!(out.contains("// 我的注释"), "往返后注释必须保留");
            let obj = crate::commands::ide_config::parse_object(&out).unwrap();
            let env = obj.get("env").and_then(Value::as_object).unwrap();
            assert_eq!(
                env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
                Some("https://corp.example"),
                "原值必须写回"
            );
            assert_eq!(
                env.get("CUSTOM").and_then(Value::as_str),
                Some("keep"),
                "非托管键必须保留"
            );
            // ANTHROPIC_MODEL 系列接入时新建、还原时应删除（original=Absent）
            assert!(
                env.get("ANTHROPIC_MODEL").is_none(),
                "原本不存在的键必须删除"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    #[test]
    fn restore_claude_official_removes_all_managed_env_fields() {
        let path = temp_json_path("claude-restore");
        fs::write(
            &path,
            r#"{
  "language": "zh-CN",
  "env": {
    "ANTHROPIC_BASE_URL": "https://third-party.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-token",
    "ANTHROPIC_API_KEY": "sk-api",
    "OPENROUTER_API_KEY": "sk-openrouter",
    "GOOGLE_API_KEY": "sk-google",
    "ANTHROPIC_MODEL": "claude-third-party",
    "ANTHROPIC_REASONING_MODEL": "claude-reasoning",
    "ANTHROPIC_SMALL_FAST_MODEL": "legacy-fast",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "claude-haiku",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "claude-sonnet",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "claude-opus",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "claude-fable",
    "MCP_TIMEOUT": "120000"
  }
}"#,
        )
        .unwrap();

        // 显式 field_restore=false + 隔离 stash：本测试锁定「删托管键」旧语义。
        // 不能走无参 apply_claude_official——它读真实 stash 与进程级门控 env，
        // 并行测试的 env 泄漏会让本测试意外走字段级路径（隔离纪律）。
        let stash = temp_json_path("claude-restore-stash").parent().unwrap().join("stash");
        Platform::ClaudeCode
            .apply_claude_official_with_stash(&path, false, &stash)
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        for key in CLAUDE_MANAGED_ENV_KEYS {
            assert!(env.get(*key).is_none(), "{key} should be removed");
        }
        assert_eq!(
            env.get("MCP_TIMEOUT").and_then(Value::as_str),
            Some("120000")
        );
        assert_eq!(value.get("language").and_then(Value::as_str), Some("zh-CN"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }


    #[test]
    fn claude_provider_match_uses_all_model_candidates() {
        let provider = test_claude_provider();
        let info = ClaudeConfigInfo {
            model: Some("stale-primary".to_string()),
            model_candidates: vec!["stale-primary".to_string(), "claude-test-model".to_string()],
            base_url: Some("https://anthropic.example.com/v1/messages".to_string()),
            has_auth_token: true,
            auth_token_masked: Some("sk-...cret".to_string()),
            is_official: false,
            managed_by_any_bridge: false,
        };

        assert!(claude_provider_matches_config(&info, &provider));
    }
