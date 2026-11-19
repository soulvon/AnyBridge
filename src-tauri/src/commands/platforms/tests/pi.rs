use super::*;


/// Pi：providers 对象键 —— 托管条目删除、用户条目保留、settings 默认写回。
#[test]
fn pi_field_restore_roundtrip_keeps_user_provider() {
    with_field_restore(true, || {
        let (path, stash) = named_tmp_config("pi-fr", "models.json");
        let settings = path.parent().unwrap().join("settings.json");
        fs::write(
            &path,
            r#"{
  "providers": {
    "user-own": { "name": "User Own", "api": "https://user.example/v1" }
  }
}"#,
        )
        .unwrap();
        fs::write(
            &settings,
            r#"{"defaultProvider": "user-own", "defaultModel": "user-m"}"#,
        )
        .unwrap();

        let p = test_openai_provider();
        write_pi_managed_models_with_stash(&path, &pi_entries_from_provider(&p), &stash)
            .unwrap();
        let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        // Pi 的托管识别靠条目的 `_source == "anybridge"`（键是 vendor 名）
        assert!(
            val["providers"]
                .as_object()
                .unwrap()
                .values()
                .any(|v| v.get("_source").and_then(Value::as_str) == Some("anybridge")),
            "接入后应有 anybridge 托管条目"
        );

        // 字段级还原（models + settings）
        crate::commands::field_restore::restore_json_fields_via_stash(
            &path,
            &pi_stash_key("models.json"),
            &stash,
            "Pi models",
        )
        .unwrap();
        let settings_ok = crate::commands::field_restore::restore_json_fields_via_stash(
            &settings,
            &pi_stash_key("settings.json"),
            &stash,
            "Pi settings",
        )
        .unwrap();
        assert!(settings_ok, "settings 默认指针应有账本并还原");

        let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let providers = val["providers"].as_object().unwrap();
        assert!(
            !providers
                .values()
                .any(|v| v.get("_source").and_then(Value::as_str) == Some("anybridge")),
            "托管条目必须删除"
        );
        assert_eq!(
            providers["user-own"]["name"].as_str(),
            Some("User Own"),
            "用户 provider 必须保留"
        );
        let sv: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            sv["defaultProvider"].as_str(),
            Some("user-own"),
            "默认 provider 必须写回"
        );
        assert_eq!(
            sv["defaultModel"].as_str(),
            Some("user-m"),
            "默认模型必须写回"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    });
}


fn pi_test_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-pi-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}


#[test]
fn pi_endpoint_parts_detects_api_kind() {
    assert_eq!(
        pi_endpoint_parts("https://api.example.com/v1/chat/completions"),
        (
            "https://api.example.com/v1".to_string(),
            PI_API_OPENAI_COMPLETIONS
        )
    );
    assert_eq!(
        pi_endpoint_parts("https://api.example.com/v1/responses/"),
        (
            "https://api.example.com/v1".to_string(),
            PI_API_OPENAI_RESPONSES
        )
    );
    assert_eq!(
        pi_endpoint_parts("https://api.example.com/v1"),
        (
            "https://api.example.com/v1".to_string(),
            PI_API_OPENAI_COMPLETIONS
        )
    );
}


#[test]
fn pi_build_providers_map_groups_models_by_vendor() {
    let entries = vec![
        serde_json::json!({
            "id": "deepseek-v4-flash",
            "name": "deepseek-v4-flash",
            "vendor": "商汤",
            "url": "https://token.sensenova.cn/v1/chat/completions",
            "apiKey": "sk-sensenova",
            "maxInputTokens": 1000000,
            "maxOutputTokens": 64000,
            "supportsImages": true,
            "supportsReasoning": true,
            "enabled": true,
        }),
        serde_json::json!({
            "id": "deepseek-v4-pro",
            "name": "deepseek-v4-pro",
            "vendor": "商汤",
            "url": "https://token.sensenova.cn/v1/chat/completions",
            "apiKey": "sk-sensenova",
            "maxInputTokens": 1000000,
            "maxOutputTokens": 64000,
            "supportsImages": true,
            "supportsReasoning": true,
            "enabled": true,
        }),
        serde_json::json!({
            "id": "gemini-3.8-flash-high",
            "name": "Gemini 3.8 Flash High",
            "vendor": "CPA",
            "url": "http://127.0.0.1:8317/v1/chat/completions",
            "apiKey": "sk-cpa",
            "enabled": true,
        }),
    ];
    let (providers, default_pair) =
        pi_build_providers_map(&entries, &Map::new(), false).unwrap();
    // 应该只有两个 provider：商汤（2 个模型）和 CPA（1 个模型）
    assert_eq!(providers.len(), 2);
    assert!(providers.contains_key("商汤"));
    assert!(providers.contains_key("CPA"));

    let sensenova = &providers["商汤"];
    assert_eq!(sensenova["baseUrl"], "https://token.sensenova.cn/v1");
    assert_eq!(sensenova["api"], PI_API_OPENAI_COMPLETIONS);
    assert_eq!(sensenova["_source"], "anybridge");
    let models = sensenova["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["id"], "deepseek-v4-flash");
    assert_eq!(models[1]["id"], "deepseek-v4-pro");

    let cpa = &providers["CPA"];
    assert_eq!(cpa["baseUrl"], "http://127.0.0.1:8317/v1");
    assert_eq!(cpa["models"].as_array().unwrap().len(), 1);

    assert_eq!(
        default_pair,
        Some(("商汤".to_string(), "deepseek-v4-flash".to_string()))
    );
}


#[test]
fn write_pi_managed_models_preserves_user_providers_and_sets_default() {
    let dir = pi_test_dir("write-managed");
    let models_path = dir.join("models.json");
    fs::write(
        &models_path,
        r#"{
  "providers": {
    "local": { "baseUrl": "http://127.0.0.1:8317/v1", "api": "openai-completions", "apiKey": "sk-local", "models": [{"id": "keep-me"}] },
    "anybridge-old": { "baseUrl": "https://stale.example.com/v1", "api": "openai-completions", "apiKey": "old", "models": [{"id": "stale"}] }
  }
}"#,
    )
    .unwrap();
    fs::write(
        dir.join("settings.json"),
        r#"{"theme":"dark","defaultProvider":"local","defaultModel":"keep-me","packages":["npm:pi-tracker"]}"#,
    )
    .unwrap();

    let entries = vec![
        serde_json::json!({
            "id": "gpt-5.4", "name": "gpt-5.4", "vendor": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-a", "maxInputTokens": 128000, "maxOutputTokens": 16384,
            "supportsImages": true, "supportsReasoning": true, "enabled": true,
        }),
        serde_json::json!({
            "id": "disabled-model", "name": "disabled-model", "vendor": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-a", "enabled": false,
        }),
    ];
    let stash = dir.join("stash");
    write_pi_managed_models_with_stash(&models_path, &entries, &stash).unwrap();

    let val: Value = serde_json::from_str(&fs::read_to_string(&models_path).unwrap()).unwrap();
    let providers = val["providers"].as_object().unwrap();
    // 用户手写 provider 原样保留，旧的托管条目被清掉
    assert!(providers.contains_key("local"));
    assert!(!providers.contains_key("anybridge-old"));
    // CPA 作为分组 provider 写入
    assert!(providers.contains_key("CPA"));
    assert_eq!(providers["CPA"]["models"][0]["id"], "gpt-5.4");
    // 停用条目不出现在 models.json
    assert_eq!(providers["CPA"]["models"].as_array().unwrap().len(), 1);

    // 状态文件保存完整条目快照（含启用的），供表格恢复停用状态与补齐字段
    let state: Value =
        serde_json::from_str(&fs::read_to_string(dir.join(MANAGED_MODELS_STATE_FILE)).unwrap())
            .unwrap();
    let state_ids: Vec<String> = state["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(
        state_ids,
        vec!["gpt-5.4".to_string(), "disabled-model".to_string()]
    );

    // settings.json：只改默认模型，其余设置保留
    let settings: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["defaultProvider"], "CPA");
    assert_eq!(settings["defaultModel"], "gpt-5.4");
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["packages"][0], "npm:pi-tracker");

    // 备份生成（还原按钮依赖）
    assert!(backup_path(&models_path).exists());

    let _ = fs::remove_dir_all(&dir);
}


#[test]
fn pi_entries_from_provider_map_roundtrips_fields() {
    let provider: Map<String, Value> = serde_json::from_value(serde_json::json!({
        "baseUrl": "http://127.0.0.1:7450/v1",
        "api": "openai-completions",
        "apiKey": "sk-lp",
        "models": [{
            "id": "any-model", "name": "AnyBridge 内置供应商", "reasoning": true,
            "contextWindow": 200000, "maxTokens": 32000, "input": ["text", "image"]
        }]
    }))
    .unwrap();
    let entries = pi_entries_from_provider_map("AnyBridge 内置供应商", &provider);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], "any-model");
    assert_eq!(entries[0]["name"], "AnyBridge 内置供应商");
    assert_eq!(entries[0]["vendor"], "AnyBridge 内置供应商");
    assert_eq!(entries[0]["url"], "http://127.0.0.1:7450/v1/chat/completions");
    assert_eq!(entries[0]["maxInputTokens"], 200000);
    assert_eq!(entries[0]["maxOutputTokens"], 32000);
    assert_eq!(entries[0]["supportsImages"], true);
    assert_eq!(entries[0]["supportsReasoning"], true);
    assert_eq!(entries[0]["enabled"], true);
}


#[test]
fn write_pi_managed_models_disambiguates_colliding_provider_ids() {
    let dir = pi_test_dir("slug-collision");
    let models_path = dir.join("models.json");
    let entries = vec![
        serde_json::json!({
            "id": "m1", "name": "m1", "vendor": "商汤",
            "url": "https://a.example.com/v1/chat/completions",
            "apiKey": "sk-a", "enabled": true,
        }),
        serde_json::json!({
            "id": "m2", "name": "m2", "vendor": "商汤",
            // 相同 vendor 但不同 URL，应作为不同 provider 分组消歧
            "url": "https://b.example.com/v1/chat/completions",
            "apiKey": "sk-b", "enabled": true,
        }),
    ];
    let stash = dir.join("stash");
    write_pi_managed_models_with_stash(&models_path, &entries, &stash).unwrap();

    let val: Value = serde_json::from_str(&fs::read_to_string(&models_path).unwrap()).unwrap();
    let providers = val["providers"].as_object().unwrap();
    assert!(providers.contains_key("商汤"));
    assert!(providers.contains_key("商汤-2"));

    let settings: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["defaultProvider"], "商汤");
    assert_eq!(settings["defaultModel"], "m1");

    let _ = fs::remove_dir_all(&dir);
}
