use super::*;

#[test]
fn infers_ai_studio_and_vertex_correctly_without_hijacking_claude_or_openai() {
    assert_eq!(
        infer_api_format_from_endpoint("https://generativelanguage.googleapis.com", None),
        Some("gemini")
    );
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://aiplatform.googleapis.com",
            Some("/v1/publishers/google/models")
        ),
        Some("gemini")
    );
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://us-central1-aiplatform.googleapis.com",
            Some("/v1/projects/p/locations/us-central1/publishers/google/models")
        ),
        Some("gemini")
    );
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://aiplatform.us.rep.googleapis.com",
            Some("/v1/projects/p/locations/us/publishers/google/models")
        ),
        Some("gemini")
    );
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://us-central1-aiplatform.googleapis.com",
            Some("/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4:rawPredict")
        ),
        Some("anthropic")
    );
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://aiplatform.googleapis.com",
            Some("/v1/projects/p/locations/global/endpoints/openapi/chat/completions")
        ),
        Some("openai")
    );
}

#[test]
fn normalizes_vertex_and_ai_studio_paths_without_corrupting_v1() {
    assert_eq!(
        normalize_gemini_api_path("https://generativelanguage.googleapis.com", None, "gemini-2.5-pro"),
        "/v1beta/models/gemini-2.5-pro:generateContent"
    );
    assert_eq!(
        normalize_gemini_api_path("https://aiplatform.googleapis.com", Some("/v1/publishers/google/models"), "gemini-3.8-flash"),
        "/v1/publishers/google/models/gemini-3.8-flash:generateContent"
    );
    assert_eq!(
        normalize_gemini_api_path(
            "https://aiplatform.googleapis.com",
            Some("/v1/projects/demo-proj/locations/us-central1"),
            "gemini-2.5-flash"
        ),
        "/v1/projects/demo-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent"
    );
    assert_eq!(
        normalize_gemini_api_path("https://aiplatform.googleapis.com", Some("/v1"), "gemini-3.8-flash"),
        "/v1/publishers/google/models/gemini-3.8-flash:generateContent"
    );
    // 兼容普通 Gemini 代理把 /v1 改成 /v1beta
    assert_eq!(
        normalize_gemini_api_path("http://127.0.0.1:8317", Some("/v1"), "gemini-2.5-pro"),
        "/v1beta/models/gemini-2.5-pro:generateContent"
    );
}

#[test]
fn resolves_vertex_regional_hosts_for_oauth_while_preserving_express_host() {
    let (host_express, path_express) = resolve_gemini_endpoint(
        "https://aiplatform.googleapis.com",
        Some("/v1/publishers/google/models"),
        "gemini-3.8-flash",
        "AQ.Ab8RN6ExpressKey",
    );
    assert_eq!(host_express, "https://aiplatform.googleapis.com");
    assert_eq!(path_express, "/v1/publishers/google/models/gemini-3.8-flash:generateContent");

    let (host_regional, path_regional) = resolve_gemini_endpoint(
        "https://aiplatform.googleapis.com",
        Some("/v1/projects/my-gcp/locations/us-central1/publishers/google/models"),
        "gemini-2.5-pro",
        "ya29.oauth-access-token",
    );
    assert_eq!(host_regional, "https://us-central1-aiplatform.googleapis.com");
    assert_eq!(
        path_regional,
        "/v1/projects/my-gcp/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent"
    );

    let (host_us, _) = resolve_gemini_endpoint(
        "https://aiplatform.googleapis.com",
        Some("/v1/projects/my-gcp/locations/us/publishers/google/models"),
        "gemini-2.5-pro",
        "ya29.oauth-access-token",
    );
    assert_eq!(host_us, "https://aiplatform.us.rep.googleapis.com");
}

#[test]
fn extract_project_id_and_fill_template_from_service_account_json() {
    let sa = concat!(
        r#"{"type":"service_account","project_id":"demo-gcp-42","client_email":"sa@demo-gcp-42.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE "#,
        r#"KEY-----\nAAAA\n-----END PRIVATE KEY-----"}"#
    );
    let (host, path) = resolve_gemini_endpoint(
        "https://aiplatform.googleapis.com",
        Some("/v1/projects/{project}/locations/global/publishers/google/models"),
        "gemini-3.8-flash",
        sa,
    );
    assert_eq!(host, "https://aiplatform.googleapis.com");
    assert_eq!(path, "/v1/projects/demo-gcp-42/locations/global/publishers/google/models/gemini-3.8-flash:generateContent");

    let (host_doc, path_doc) = resolve_gemini_endpoint(
        "https://us-central1-aiplatform.googleapis.com",
        Some("/publishers/google/models"),
        "gemini-2.5-pro",
        sa,
    );
    assert_eq!(host_doc, "https://us-central1-aiplatform.googleapis.com");
    assert_eq!(
        path_doc,
        "/v1/projects/demo-gcp-42/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent"
    );
}

#[test]
fn resolve_gemini_endpoint_preserves_host_prefix_without_double_joining() {
    let (host_prefix, path_prefix) = resolve_gemini_endpoint(
        "https://proxy.example.com/prefix",
        Some("/v1/publishers/google/models"),
        "gemini-3.8-flash",
        "AQ.express-key",
    );
    assert_eq!(host_prefix, "https://proxy.example.com");
    assert_eq!(path_prefix, "/prefix/v1/publishers/google/models/gemini-3.8-flash:generateContent");

    let (host_v1, path_v1) = resolve_gemini_endpoint(
        "https://proxy.example.com/v1",
        Some("/v1beta/models"),
        "gemini-2.5-pro",
        "AIza-test",
    );
    assert_eq!(host_v1, "https://proxy.example.com");
    assert_eq!(path_v1, "/v1/v1beta/models/gemini-2.5-pro:generateContent");
}

#[test]
fn ai_studio_openai_without_trailing_slash_and_regional_vertex_v1_resolve_accurately() {
    assert!(!is_official_google_gemini_native_only_endpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai",
        None
    ));
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://generativelanguage.googleapis.com/v1beta/openai",
            None
        ),
        Some("openai")
    );
    assert_eq!(
        infer_api_format_from_endpoint(
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            None
        ),
        Some("openai")
    );
    assert!(is_aiplatform_host("us-central1-aiplatform.googleapis.com"));
    assert!(is_vertex_endpoint("https://us-central1-aiplatform.googleapis.com", Some("/v1")));

    let sa = r#"{"type":"service_account","project_id":"std-proj-9","client_email":"sa@std-proj-9.iam.gserviceaccount.com","private_key":"dummy"}"#;
    let (reg_host, reg_stream) = resolve_gemini_endpoint_for_action(
        "https://us-central1-aiplatform.googleapis.com",
        Some("/v1"),
        "gemini-2.5-flash",
        sa,
        "streamGenerateContent",
    );
    assert_eq!(reg_host, "https://us-central1-aiplatform.googleapis.com");
    assert_eq!(
        reg_stream,
        "/v1/projects/std-proj-9/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
}

#[test]
fn extract_gemini_parts_text_skips_thought_parts_and_keeps_answer() {
    let json = serde_json::json!({
        "candidates": [{
            "content": {
                "parts": [
                    { "text": "internal thought", "thought": true },
                    { "text": "OK" }
                ]
            }
        }]
    });
    assert_eq!(extract_gemini_parts_text(&json), "OK");
}
