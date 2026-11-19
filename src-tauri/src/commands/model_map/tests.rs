use super::*;

#[test]
fn enhancement_config_round_trips_advanced_proxy_fields() {
    let raw = r#"{
        "systemPromptPrefix": "prefix",
        "systemPromptPrefixEnabled": true,
        "customHeaders": [{"key": "x-test", "value": "1"}],
        "customHeadersEnabled": true,
        "responseHeaders": [{"key": "x-response", "value": "2"}],
        "paramOverrides": {"max_tokens": 4096, "temperature": 0},
        "paramOverridesEnabled": true,
        "toolFilterMode": "allow",
        "toolFilterList": ["read_file"],
        "forceToolChoice": "auto",
        "toolFilterEnabled": true,
        "rateLimitRpm": 12,
        "rateLimitEnabled": true,
        "requestLogging": true,
        "unlockModels": false
    }"#;

    let cfg: EnhancementConfig = serde_json::from_str(raw).unwrap();
    assert!(cfg.system_prompt_prefix_enabled);
    assert!(cfg.custom_headers_enabled);
    assert!(cfg.param_overrides_enabled);
    assert!(cfg.tool_filter_enabled);
    assert!(cfg.rate_limit_enabled);
    assert!(cfg.request_logging);
    assert!(!cfg.unlock_models);
    assert_eq!(cfg.custom_headers[0].key, "x-test");
    assert_eq!(cfg.response_headers[0].value, "2");
    assert_eq!(cfg.param_overrides["max_tokens"], serde_json::json!(4096));

    let value = serde_json::to_value(&cfg).unwrap();
    assert_eq!(value["systemPromptPrefixEnabled"], serde_json::json!(true));
    assert_eq!(
        value["customHeaders"][0]["key"],
        serde_json::json!("x-test")
    );
    assert_eq!(value["paramOverrides"]["temperature"], serde_json::json!(0));
    assert_eq!(value["unlockModels"], serde_json::json!(false));
}
