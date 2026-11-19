use super::*;
use super::builder::CLI_LOCAL_MODEL_API_KEY;
use crate::model::{ModelType, OPENAI_CHAT_ENDPOINT};

fn model() -> ModelConfig {
    ModelConfig {
        model_hash: "local-model-hash".into(),
        sort_order: 0,
        display_name: "Local Model".into(),
        group_name: None,
        model_type: ModelType::OpenAi,
        base_url: "https://provider.example/v1/chat/completions".into(),
        use_full_url: true,
        api_key: "provider-secret".into(),
        tooltip_data: "Local Model".into(),
        model_id: "upstream-model".into(),
        reasoning_effort: None,
        openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
        openai_extra_params_enabled: false,
        openai_extra_params: serde_json::json!({}),
        custom_headers_enabled: false,
        custom_headers: serde_json::json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: serde_json::json!({}),
        context_window_tokens: None,
        max_completion_tokens: None,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
        created_at_ms: 0,
        updated_at_ms: 0,
    }
}

#[test]
fn cli_model_details_use_local_routing_credentials() {
    let details = usable_model(&model());
    assert_eq!(details.model_id, "local-model-hash");
    assert_eq!(details.display_name, "Local Model");
    let agent::model_details::Credentials::ApiKeyCredentials(credentials) =
        details.credentials.expect("API credentials")
    else {
        panic!("expected API key credentials");
    };
    assert_eq!(credentials.api_key, CLI_LOCAL_MODEL_API_KEY);
    assert_eq!(credentials.base_url, None);
    assert_ne!(credentials.api_key, "provider-secret");
}

#[test]
fn cli_plugin_model_details_use_local_routing_credentials() {
    let details = usable_plugin_model(&PluginModelDescriptor {
        id: "plugin:test/provider/model".into(),
        plugin_id: "plugin:test".into(),
        plugin_name: "Test Plugin".into(),
        provider_id: "provider".into(),
        model_id: "model".into(),
        display_name: "Plugin Model".into(),
        description: None,
        icon: String::new(),
        provider_type: "test".into(),
        max_output_tokens: None,
        images: false,
        enabled: true,
    });
    assert_eq!(details.model_id, "plugin:test/provider/model");
    let agent::model_details::Credentials::ApiKeyCredentials(credentials) =
        details.credentials.expect("API credentials")
    else {
        panic!("expected API key credentials");
    };
    assert_eq!(credentials.api_key, CLI_LOCAL_MODEL_API_KEY);
    assert_eq!(credentials.base_url, None);
}

#[test]
fn cli_default_responses_use_the_local_model_hash() {
    let models = vec![model()];
    let details = default_model_details(&models, &[]).expect("default model");
    assert_eq!(details.model_id, "local-model-hash");

    let response = default_model_response(&models, &[]);
    assert_eq!(response.model, "local-model-hash");
    assert_eq!(response.thinking_model, "local-model-hash");

    let nudge = default_model_nudge_response(&models, &[]);
    assert_eq!(
        nudge.models_with_no_default_switch,
        vec!["local-model-hash"]
    );
}
