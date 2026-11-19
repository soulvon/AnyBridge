use super::*;
use serde_yaml::Value as YamlValue;


// ─── Hermes / Harness 块级 YAML 记账+还原 ────────────────────

/// Hermes：custom_providers 块与 model 指针往返；注释保留。
#[test]
fn hermes_block_restore_roundtrip_keeps_user_config() {
    with_field_restore(true, || {
        let (path, stash) = named_tmp_config("hermes-fr", "config.yaml");
        fs::write(
            &path,
            "# Hermes docs\nmodel:\n  # keep\n  default: user-model\n  provider: mine\n  base_url: https://mine.example/v1\nterminal:\n  theme: dark\ncustom_providers:\n  - name: mine\n    base_url: https://mine.example/v1\n",
        )
        .unwrap();
        let entries = vec![serde_json::json!({
            "id": "gpt-5.4", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-h", "enabled": true,
        })];

        write_hermes_managed_models_with_stash(&path, &entries, &stash).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert!(out.contains("# Hermes docs"), "注释必须保留");
        assert!(
            out.contains("CPA"),
            "接入后应有 CPA 托管分组"
        );

        restore_yaml_fields_via_stash(&path, &hermes_stash_key(), &stash, "Hermes").unwrap();

        let out = fs::read_to_string(&path).unwrap();
        assert!(out.contains("# Hermes docs"), "还原后注释必须保留");
        assert!(out.contains("  # keep"), "块内注释必须保留");
        let parsed: YamlValue = serde_yaml::from_str(&out).unwrap();
        let names: Vec<String> = parsed["custom_providers"]
            .as_sequence()
            .map(|s| {
                s.iter()
                    .filter_map(|i| i["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(names, vec!["mine".to_string()], "托管分组删除、用户条目保留");
        assert_eq!(
            parsed["model"]["provider"].as_str(),
            Some("mine"),
            "默认 provider 必须写回"
        );
        assert_eq!(
            parsed["model"]["default"].as_str(),
            Some("user-model"),
            "默认模型必须写回"
        );
        assert_eq!(
            parsed["model"]["base_url"].as_str(),
            Some("https://mine.example/v1"),
            "默认 base_url 必须写回"
        );
        assert_eq!(
            parsed["terminal"]["theme"].as_str(),
            Some("dark"),
            "用户其它配置必须保留"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    });
}


/// Harness：settings 的 llm-pi-ai / agent-default-model 与 credentials 的
/// refs 往返；用户 provider 与其它字段保留。
#[test]
fn harness_block_restore_roundtrip_keeps_user_config() {
    with_field_restore(true, || {
        let (path, stash) = named_tmp_config("harness-fr", "settings.yaml");
        let creds = path.parent().unwrap().join(".credentials.yaml");
        fs::write(
            &path,
            "llm-pi-ai:\n  providers:\n    user-own:\n      displayName: User Own\n      baseURL: https://user.example/v1\ntelemetry:\n  enabled: false\n",
        )
        .unwrap();
        fs::write(&creds, "version: 1\nrefs:\n  USER_KEY: sk-user\n").unwrap();

        let entries = vec![serde_json::json!({
            "id": "gpt-5.4", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-h", "enabled": true,
        })];
        write_harness_managed_models_with_stash(&path, &creds, &entries, &stash).unwrap();

        let out = fs::read_to_string(&path).unwrap();
        assert!(out.contains("anybridge"), "接入后应有 anybridge provider");

        restore_yaml_fields_via_stash(&path, &harness_stash_key(), &stash, "hs").unwrap();
        restore_yaml_fields_via_stash(
            &creds,
            &harness_credentials_stash_key(),
            &stash,
            "hc",
        )
        .unwrap();

        let out = fs::read_to_string(&path).unwrap();
        let parsed: YamlValue = serde_yaml::from_str(&out).unwrap();
        let providers = parsed["llm-pi-ai"]["providers"].as_mapping().unwrap();
        let keys: Vec<String> = providers
            .keys()
            .filter_map(|k| k.as_str().map(str::to_string))
            .collect();
        assert_eq!(keys, vec!["user-own".to_string()], "托管 provider 删除、用户保留");
        assert_eq!(
            parsed["telemetry"]["enabled"].as_bool(),
            Some(false),
            "用户其它顶层配置必须保留"
        );
        let cred_out = fs::read_to_string(&creds).unwrap();
        let cred_parsed: YamlValue = serde_yaml::from_str(&cred_out).unwrap();
        let refs = cred_parsed["refs"].as_mapping().unwrap();
        assert!(refs.contains_key(YamlValue::String("USER_KEY".into())), "用户凭据保留");
        assert!(
            !refs.keys().any(|k| k.as_str().map(|s| s.starts_with("ANYBRIDGE_")).unwrap_or(false)),
            "托管凭据引用必须删除"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    });
}


#[test]
fn yaml_block_edit_preserves_comments_and_other_sections() {
    let source = "# top comment\nmodel:\n  # keep me\n  default: old\n  base_url: https://keep.example/v1\n\n# next section\nterminal:\n  theme: dark\n";
    let out = yaml_set_top_level_block(
        source,
        "custom_providers",
        "  - name: anybridge-test\n    base_url: https://x/v1",
    );
    assert!(out.contains("# top comment"));
    assert!(out.contains("# keep me"));
    assert!(out.contains("# next section"));
    assert!(out.contains("theme: dark"));
    let parsed: YamlValue = serde_yaml::from_str(&out).unwrap();
    assert_eq!(parsed["terminal"]["theme"], YamlValue::String("dark".into()));
    assert_eq!(
        parsed["model"]["base_url"],
        YamlValue::String("https://keep.example/v1".into())
    );
    assert_eq!(
        parsed["custom_providers"][0]["name"],
        YamlValue::String("anybridge-test".into())
    );
}


#[test]
fn yaml_block_edit_replaces_existing_block_without_touching_next_key() {
    let source = "custom_providers:\n  - name: stale\n\n# belongs to model\nmodel:\n  default: old\n";
    let out = yaml_set_top_level_block(source, "custom_providers", "  - name: fresh");
    assert!(!out.contains("stale"));
    assert!(out.contains("- name: fresh"));
    // 下一个键之前的注释仍然保留
    assert!(out.contains("# belongs to model"));
    assert!(out.contains("default: old"));
    // 键不重复、块内容正确
    let parsed: YamlValue = serde_yaml::from_str(&out).unwrap();
    assert_eq!(parsed["custom_providers"].as_sequence().unwrap().len(), 1);
    assert_eq!(
        parsed["custom_providers"][0]["name"],
        YamlValue::String("fresh".into())
    );
}


#[test]
fn yaml_scalar_edit_updates_key_in_place() {
    let source = "model:\n  default: old\n  base_url: https://keep/v1\n";
    let out = yaml_set_scalar_in_block(source, "model", "default", &yaml_scalar("new-model"));
    let parsed: YamlValue = serde_yaml::from_str(&out).unwrap();
    assert_eq!(parsed["model"]["default"], YamlValue::String("new-model".into()));
    assert_eq!(
        parsed["model"]["base_url"],
        YamlValue::String("https://keep/v1".into())
    );
}


#[test]
fn write_hermes_managed_models_keeps_user_config_and_sets_default() {
    let dir = temp_managed_dir("hermes");
    let path = dir.join("config.yaml");
    fs::write(
        &path,
        "# Hermes docs\nmodel:\n  # keep\n  default: old\n  base_url: https://user.example/v1\nterminal:\n  theme: dark\ncustom_providers:\n  - name: mine\n    base_url: https://mine.example/v1\n  - name: anybridge-old-model\n    display_name: CPA\n    base_url: https://stale.example/v1\n    api_key: sk-old\n    api_mode: chat_completions\n    model: old-model\n    models:\n      old-model: {}\n",
    )
    .unwrap();
    let entries = vec![
        serde_json::json!({
            "id": "gpt-5.4", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-h", "maxInputTokens": 200000,
            "supportsImages": true, "supportsReasoning": true, "enabled": true,
        }),
        serde_json::json!({
            "id": "glm-5.2", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-h", "enabled": true,
        }),
        serde_json::json!({
            "id": "off-model", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-h", "enabled": false,
        }),
    ];
    let stash = dir.join("stash");
    write_hermes_managed_models_with_stash(&path, &entries, &stash).unwrap();

    let out = fs::read_to_string(&path).unwrap();
    assert!(out.contains("# Hermes docs"));
    assert!(out.contains("# keep"));
    assert!(out.contains("theme: dark"));
    let parsed: YamlValue = serde_yaml::from_str(&out).unwrap();
    let providers = parsed["custom_providers"].as_sequence().unwrap();
    let names: Vec<String> = providers
        .iter()
        .map(|i| i["name"].as_str().unwrap_or("").to_string())
        .collect();
    // 用户条目保留；旧格式 anybridge-* 条目被替换；同供应商收敛为一个分组条目
    assert!(names.contains(&"mine".to_string()));
    assert!(!names.iter().any(|n| n.starts_with("anybridge")));
    assert_eq!(names.iter().filter(|n| *n == "CPA").count(), 1);
    let cpa = providers
        .iter()
        .find(|i| i["name"].as_str() == Some("CPA"))
        .unwrap();
    assert_eq!(
        cpa["base_url"],
        YamlValue::String("https://api.example.com/v1".into())
    );
    assert_eq!(cpa["model"], YamlValue::String("gpt-5.4".into()));
    assert!(cpa["models"].get("gpt-5.4").is_some());
    assert!(cpa["models"].get("glm-5.2").is_some());
    assert!(cpa.get("display_name").is_none());
    assert!(!out.contains("off-model"));
    assert_eq!(
        parsed["model"]["default"],
        YamlValue::String("gpt-5.4".into())
    );
    assert_eq!(parsed["model"]["provider"], YamlValue::String("CPA".into()));
    let state = managed_read_state(&dir).unwrap();
    let state_ids: Vec<String> = state
        .iter()
        .map(|m| m["id"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(
        state_ids,
        vec!["gpt-5.4".to_string(), "glm-5.2".to_string(), "off-model".to_string()]
    );
    assert!(backup_path(&path).exists());

    // 二次保存：分组条目通过状态快照识别并原位替换，不产生重复
    write_hermes_managed_models_with_stash(&path, &entries, &stash).unwrap();
    let parsed: YamlValue = serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let names: Vec<String> = parsed["custom_providers"]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(names.iter().filter(|n| *n == "CPA").count(), 1);
    assert!(names.contains(&"mine".to_string()));

    let _ = fs::remove_dir_all(&dir);
}


#[test]
fn write_harness_managed_models_writes_settings_and_credentials() {
    let dir = temp_managed_dir("harness");
    let settings_path = dir.join("settings.yaml");
    let credentials_path = dir.join(".credentials.yaml");
    fs::write(
        &credentials_path,
        "version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n",
    )
    .unwrap();
    let entries = vec![
        serde_json::json!({
            "id": "gpt-5.4", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-d", "maxInputTokens": 128000,
            "supportsImages": true, "supportsReasoning": true, "enabled": true,
        }),
        serde_json::json!({
            "id": "glm-5.2", "name": "CPA",
            "url": "https://api.example.com/v1/chat/completions",
            "apiKey": "sk-d", "enabled": true,
        }),
        serde_json::json!({
            "id": "deepseek-v4-flash", "name": "商汤",
            "url": "https://b.example.com/v1/chat/completions",
            "apiKey": "sk-b", "enabled": true,
        }),
    ];
    let stash = dir.join("stash");
    write_harness_managed_models_with_stash(&settings_path, &credentials_path, &entries, &stash)
        .unwrap();

    let parsed: YamlValue =
        serde_yaml::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
    assert_eq!(
        parsed["agent-default-model"]["provider"],
        YamlValue::String("anybridge-CPA".into())
    );
    assert_eq!(
        parsed["agent-default-model"]["model"],
        YamlValue::String("gpt-5.4".into())
    );
    let provider = &parsed["llm-pi-ai"]["providers"]["anybridge-CPA"];
    assert_eq!(provider["displayName"], YamlValue::String("CPA".into()));
    assert_eq!(
        provider["baseURL"],
        YamlValue::String("https://api.example.com/v1".into())
    );
    assert_eq!(
        provider["api"],
        YamlValue::String(PI_API_OPENAI_COMPLETIONS.to_string())
    );
    assert_eq!(
        provider["apiKeyEnv"],
        YamlValue::String("ANYBRIDGE_CPA".into())
    );
    // 同供应商模型收敛进 models 列表，模型行只保留 id + 能力字段（界面按 id 展示）
    let models = provider["models"].as_sequence().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["id"], YamlValue::String("gpt-5.4".into()));
    assert_eq!(models[1]["id"], YamlValue::String("glm-5.2".into()));
    assert!(models[0].get("name").is_none());
    assert_eq!(models[0]["contextWindow"], YamlValue::Number(128000.into()));
    assert_eq!(
        models[0]["input"],
        YamlValue::Sequence(vec![
            YamlValue::String("text".into()),
            YamlValue::String("image".into())
        ])
    );
    // 中文供应商：ascii slug 退化为稳定哈希，仍是合法的环境变量名
    let provider_keys: Vec<String> = parsed["llm-pi-ai"]["providers"]
        .as_mapping()
        .unwrap()
        .keys()
        .filter_map(|k| k.as_str().map(str::to_string))
        .collect();
    assert_eq!(provider_keys.len(), 2);
    let dsh_key = provider_keys
        .iter()
        .find(|k| k.starts_with("anybridge-g") && k.as_str() != "anybridge-CPA")
        .unwrap();
    assert_eq!(
        parsed["llm-pi-ai"]["providers"][dsh_key.as_str()]["displayName"],
        YamlValue::String("商汤".into())
    );

    let creds: YamlValue =
        serde_yaml::from_str(&fs::read_to_string(&credentials_path).unwrap()).unwrap();
    assert_eq!(creds["version"], YamlValue::Number(serde_yaml::Number::from(1)));
    assert_eq!(
        creds["refs"]["ANYBRIDGE_CPA"],
        YamlValue::String("sk-d".into())
    );
    // 用户既有凭据记录保留
    assert!(creds["records"]
        .get("client-connection/browser-session")
        .is_some());

    let _ = fs::remove_dir_all(&dir);
}


#[test]
fn hermes_roundtrip_preserves_model_metadata() {
    // 核心回归：Hermes 的 YAML 格式承载不了能力/输出上限/温度等字段，
    // 必须由状态快照补齐，否则保存后重新加载会静默丢失用户的自定义设置
    let dir = temp_managed_dir("hermes-roundtrip");
    let path = dir.join("config.yaml");
    let entries = vec![serde_json::json!({
        "id": "gpt-5.4", "name": "CPA",
        "url": "https://api.example.com/v1/chat/completions",
        "apiKey": "sk-h", "maxInputTokens": 200000, "maxOutputTokens": 64000,
        "supportsImages": false, "supportsReasoning": true, "temperature": 0.7,
        "enabled": true,
    })];
    let stash = dir.join("stash");
    write_hermes_managed_models_with_stash(&path, &entries, &stash).unwrap();

    let root = parse_yaml_value(&fs::read_to_string(&path).unwrap(), "config.yaml").unwrap();
    let managed_names = hermes_managed_names_from_state(&dir);
    let mut models = hermes_entries_from_config(&root, &managed_names);
    merge_managed_state(&mut models, &dir).unwrap();

    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], "gpt-5.4");
    assert_eq!(models[0]["vendor"], "CPA");
    assert_eq!(models[0]["supportsImages"], false);
    assert_eq!(models[0]["supportsReasoning"], true);
    assert_eq!(models[0]["maxInputTokens"], 200000);
    assert_eq!(models[0]["maxOutputTokens"], 64000);
    assert_eq!(models[0]["temperature"], 0.7);

    // 全部停用：默认模型必须被清理，不能留下指向已删除 provider 的悬空引用
    let disabled_entries = vec![serde_json::json!({
        "id": "gpt-5.4", "name": "CPA",
        "url": "https://api.example.com/v1/chat/completions",
        "apiKey": "sk-h", "enabled": false,
    })];
    write_hermes_managed_models_with_stash(&path, &disabled_entries, &stash).unwrap();
    let root = parse_yaml_value(&fs::read_to_string(&path).unwrap(), "config.yaml").unwrap();
    assert!(root["model"].get("default").is_none());
    assert!(root["model"].get("provider").is_none());
    // 用户的 base_url 与其它段保留
    assert!(root.get("model").is_some());

    let _ = fs::remove_dir_all(&dir);
}


#[test]
fn hermes_and_harness_entries_roundtrip() {
    // 旧格式：name = anybridge-<模型>，靠前缀识别；分组格式：name = 供应商名，靠快照识别
    let root: YamlValue = serde_yaml::from_str(
        "custom_providers:\n  - name: anybridge-gpt-5-4\n    display_name: CPA\n    base_url: https://api.example.com/v1\n    api_key: sk-h\n    api_mode: chat_completions\n    model: gpt-5.4\n    models:\n      gpt-5.4: {}\n  - name: 商汤\n    base_url: https://b.example/v1\n    api_key: sk-b\n    api_mode: chat_completions\n    model: glm-5.2\n    models:\n      glm-5.2: {}\n      kimi-k3: {}\n",
    )
    .unwrap();
    let managed_names: HashSet<String> = ["商汤".to_string()].into_iter().collect();
    let entries = hermes_entries_from_config(&root, &managed_names);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["id"], "gpt-5.4");
    assert_eq!(entries[0]["vendor"], "CPA");
    assert_eq!(
        entries[0]["url"],
        "https://api.example.com/v1/chat/completions"
    );
    assert_eq!(entries[0]["apiKey"], "sk-h");
    assert_eq!(entries[1]["id"], "glm-5.2");
    assert_eq!(entries[1]["vendor"], "商汤");
    assert_eq!(entries[2]["id"], "kimi-k3");
    assert_eq!(entries[2]["vendor"], "商汤");
    // 不在快照且无前缀的用户条目不展开
    let entries = hermes_entries_from_config(&root, &HashSet::new())
        .into_iter()
        .filter(|e| e["vendor"] == "CPA")
        .count();
    assert_eq!(entries, 1);

    let settings: YamlValue = serde_yaml::from_str(
        "llm-pi-ai:\n  providers:\n    anybridge-CPA:\n      displayName: CPA\n      apiKeyEnv: ANYBRIDGE_CPA\n      api: openai-completions\n      baseURL: https://api.example.com/v1\n      models:\n        - id: gpt-5.4\n          input: [text, image]\n          reasoning: true\n          contextWindow: 128000\n        - id: glm-5.2\n          input: [text]\n",
    )
    .unwrap();
    let creds: YamlValue =
        serde_yaml::from_str("version: 1\nrefs:\n  ANYBRIDGE_CPA: sk-d\n").unwrap();
    let entries = harness_entries_from_settings(&settings, &creds);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["id"], "gpt-5.4");
    assert_eq!(entries[0]["vendor"], "CPA");
    assert_eq!(entries[0]["apiKey"], "sk-d");
    assert_eq!(entries[0]["supportsImages"], true);
    assert_eq!(entries[0]["supportsReasoning"], true);
    assert_eq!(entries[0]["maxInputTokens"], 128000);
    assert_eq!(entries[1]["id"], "glm-5.2");
    assert_eq!(entries[1]["vendor"], "CPA");
    assert_eq!(entries[1]["supportsImages"], false);
}
