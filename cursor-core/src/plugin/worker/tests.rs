use std::collections::HashSet;

use crate::{
    model::{NewLlmCall, ProviderType},
    provider::{CallRecorder, FinishReason},
    store::Store,
};

use super::*;
use super::host::{recorded_network_request, HostContext};

async fn recorder(detailed: bool, call_id: &str) -> (tempfile::TempDir, Store, CallRecorder) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        directory.path().join("test.db").display()
    ))
    .await
    .unwrap();
    store.set_detailed_logging(detailed).await.unwrap();
    let recorder = CallRecorder::start(
        store.clone(),
        NewLlmCall {
            call_id: call_id.into(),
            run_id: "run".into(),
            conversation_id: "conversation".into(),
            provider_call_index: 0,
            model_hash: "plugin:test/provider/model".into(),
            provider_type: ProviderType::Plugin,
            provider_url: "plugin://test/provider".into(),
            request_type: ProviderType::Plugin,
            request_url: "plugin://test/provider".into(),
            model_id: "model".into(),
            display_name: "Model".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        },
    )
    .await
    .unwrap();
    (directory, store, recorder)
}

fn network_params() -> serde_json::Value {
    serde_json::json!({
        "url": "https://example.com/v1/responses",
        "method": "POST",
        "headers": {
            "Authorization": "Bearer secret",
            "X-Api-Key": "secret-key",
            "Cookie": "session=secret",
            "content-type": "application/json",
            "x-client-request-id": "request-1"
        },
        "body": "{\"model\":\"test\",\"stream\":true}"
    })
}

async fn host_with_recorder(store: Store, recorder: CallRecorder) -> HostContext {
    let invocations = Arc::new(Mutex::new(HashMap::new()));
    invocations.lock().await.insert(
        "invocation".into(),
        Arc::new(InvocationState {
            cancellation: CancellationToken::new(),
            recorder: Some(recorder),
            recorder_claimed: AtomicBool::new(false),
        }),
    );
    HostContext {
        plugin_id: "test".into(),
        network_hosts: Arc::new(HashSet::from(["example.com".into()])),
        store,
        invocations,
        streams: Arc::new(Mutex::new(HashMap::new())),
    }
}

#[test]
fn recorded_plugin_request_omits_sensitive_headers() {
    let (headers, body) = recorded_network_request(&network_params()).unwrap();

    assert_eq!(
        headers,
        serde_json::json!({
            "content-type": "application/json",
            "x-client-request-id": "request-1"
        })
    );
    assert_eq!(body, serde_json::json!({ "model": "test", "stream": true }));
}

#[tokio::test]
async fn detailed_plugin_network_recording_persists_request_and_raw_response() {
    let (_directory, store, recorder) = recorder(true, "detailed-plugin").await;
    let host = host_with_recorder(store.clone(), recorder.clone()).await;
    let params = network_params();
    let (_, _, first_recorder) = host.request("invocation", &params).await.unwrap();
    let (_, _, second_recorder) = host.request("invocation", &params).await.unwrap();
    let (_, body) = recorded_network_request(&params).unwrap();

    assert!(first_recorder.is_some());
    assert!(second_recorder.is_none());
    recorder.response_headers(200).await.unwrap();
    recorder
        .response_chunk(b"data: {\"type\":\"response.created\"}\n\n")
        .await
        .unwrap();
    recorder.response_chunk(b"data: [DONE]\n\n").await.unwrap();
    recorder.completed(FinishReason::Stop).await.unwrap();

    let request = store
        .llm_call_request("detailed-plugin")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        request.headers,
        serde_json::json!({
            "content-type": "application/json",
            "x-client-request-id": "request-1"
        })
    );
    assert_eq!(request.body, body);
    let chunks = store.llm_call_chunks("detailed-plugin").await.unwrap();
    let expected_response = "data: {\"type\":\"response.created\"}\n\ndata: [DONE]\n\n";
    assert_eq!(chunks.len(), 2);
    assert_eq!(
        chunks
            .iter()
            .map(|chunk| chunk.data.as_str())
            .collect::<String>(),
        expected_response
    );
    let summary = store.llm_call("detailed-plugin").await.unwrap().unwrap();
    assert_eq!(summary.http_status, Some(200));
    assert_eq!(summary.stream_event_count, 2);
    assert_eq!(summary.response_bytes, expected_response.len() as i64);
    assert!(summary.detailed);
}

#[tokio::test]
async fn standard_plugin_network_recording_keeps_metrics_without_payloads() {
    let (_directory, store, recorder) = recorder(false, "standard-plugin").await;
    let host = host_with_recorder(store.clone(), recorder.clone()).await;
    let params = network_params();
    let (_, body) = recorded_network_request(&params).unwrap();
    let request_bytes = serde_json::to_string(&body).unwrap().len() as i64;
    let response = b"data: [DONE]\n\n";

    let (_, _, observed) = host.request("invocation", &params).await.unwrap();
    assert!(observed.is_some());
    recorder.response_headers(204).await.unwrap();
    recorder.response_chunk(response).await.unwrap();
    recorder.completed(FinishReason::Stop).await.unwrap();

    assert!(store
        .llm_call_request("standard-plugin")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .llm_call_chunks("standard-plugin")
        .await
        .unwrap()
        .is_empty());
    let summary = store.llm_call("standard-plugin").await.unwrap().unwrap();
    assert_eq!(summary.http_status, Some(204));
    assert_eq!(summary.request_bytes, Some(request_bytes));
    assert_eq!(summary.response_bytes, response.len() as i64);
    assert_eq!(summary.stream_event_count, 1);
    assert!(!summary.detailed);
}
