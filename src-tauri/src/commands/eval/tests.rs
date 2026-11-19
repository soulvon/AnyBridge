use super::*;


fn test_provider(host: &str, path: Option<&str>, key: &str) -> Provider {
    serde_json::from_value(serde_json::json!({
        "id": "test",
        "name": "Test",
        "apiHost": host,
        "apiKey": key,
        "apiPath": path,
        "defaultModel": "gemini-2.5-pro"
    }))
    .expect("construct test Provider")
}

#[test]
fn gemini_stream_url_and_sse_parsers_extract_non_thought_text_usage_and_model() {
    let p = test_provider(
        "https://aiplatform.googleapis.com",
        Some("/v1/publishers/google/models"),
        "AQ.test-key",
    );
    assert_eq!(
        api_stream_url(&p, ApiFormat::Gemini, "gemini-2.5-pro"),
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
    );

    let sse_body = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"reasoning\",\"thought\":true}]}}],\"modelVersion\":\"gemini-2.5-pro-001\"}\n\n",
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"1 2 3\"}]}}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":7}}\n\n"
    );
    assert_eq!(stream_text(sse_body), "1 2 3");
    assert_eq!(stream_output_tokens(&ApiFormat::Gemini, sse_body), Some(7));
    assert_eq!(
        stream_reported_model(sse_body).as_deref(),
        Some("gemini-2.5-pro-001")
    );
}

#[test]
fn openai_compat_ai_studio_base_url_and_path_normalize_cleanly() {
    let p = test_provider(
        "https://generativelanguage.googleapis.com/v1beta/openai",
        None,
        "AIza-test",
    );
    assert_eq!(
        api_url(&p, ApiFormat::Openai, "gemini-2.5-pro"),
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
    assert_eq!(
        protocol_base_url(&p, ApiFormat::Openai),
        "https://generativelanguage.googleapis.com"
    );
}

#[test]
fn gemini_protocol_checks_preserve_custom_gemini_path() {
    let custom_prefix = test_provider(
        "https://relay.example.com",
        Some("/custom-gemini/proxy"),
        "AIza-test",
    );
    let (native_url, _) =
        protocol_gemini_urls(&custom_prefix, ApiFormat::Gemini, "gemini-2.5-pro");
    assert_eq!(
        native_url,
        "https://relay.example.com/custom-gemini/proxy/v1beta/models/gemini-2.5-pro:generateContent"
    );

    let v1_model_path = test_provider(
        "https://relay.example.com",
        Some("/custom-gemini/v1/models"),
        "AIza-test",
    );
    let (v1_native_url, _) =
        protocol_gemini_urls(&v1_model_path, ApiFormat::Gemini, "gemini-2.5-pro");
    assert_eq!(
        v1_native_url,
        "https://relay.example.com/custom-gemini/v1/models/gemini-2.5-pro:generateContent"
    );
}
