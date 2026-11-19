use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::{TransportParent, TransportRegistry},
    provider::{FinishReason, ModelEvent},
};

use crate::{
    assert_run_starts_without_parent_dependency, fake_provider, fixtures, run_to_terminal,
    subagent_run, wait_until_idle,
};

#[tokio::test]
async fn parent_request_does_not_need_to_resolve_to_an_active_run() {
    assert_run_starts_without_parent_dependency(
        "finished-parent-request",
        Some(TransportParent {
            request_id: Some("already-finished-parent".into()),
            tool_call_id: Some("original-tool-call".into()),
        }),
        None,
    )
    .await;
}

#[tokio::test]
async fn subagent_type_does_not_require_parent_metadata() {
    assert_run_starts_without_parent_dependency(
        "parentless-subagent-request",
        None,
        Some("generalPurpose"),
    )
    .await;
}


#[tokio::test]
async fn subagent_run_without_message_id_starts_and_completes() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "subagent-model-call".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("subagent finished".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    // 只带父工具调用 ID：Cursor 这两个头是分别发的，只出现一个也是合法请求。
    let terminal = run_to_terminal(
        &registry,
        "windows-subagent",
        Some(TransportParent {
            request_id: None,
            tool_call_id: Some("parent-task-call".into()),
        }),
        subagent_run("explore the repository", "windows-subagent-conversation"),
    )
    .await;

    assert!(terminal.get("error").is_none(), "{terminal}");
    assert_eq!(provider.requests().len(), 1);
    let row: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT run_kind, parent_run_id, parent_tool_call_id FROM runs WHERE cursor_request_id = ?",
    )
    .bind("windows-subagent")
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(row, ("root".into(), None, None));
}

/// 同一条无 `message_id` 的 kickoff 换 request id 重试时要幂等；内容不同则各自成一条。
#[tokio::test]
async fn subagent_retries_without_message_id_stay_idempotent() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    let completed = || {
        vec![
            ModelEvent::Start {
                model_call_id: "retry-model-call".into(),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta("done".into()),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]
    };
    provider.push(completed());
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let conversation = "synthetic-retry-conversation";

    // 第一次尝试，以及客户端换了 request id 的重试：同一条无 id 消息要落到同一个运行时事件。
    let first = run_to_terminal(
        &registry,
        "synthetic-retry-a",
        None,
        subagent_run("same subagent task", conversation),
    )
    .await;
    assert!(first.get("error").is_none(), "{first}");
    wait_until_idle(store.pool(), conversation).await;
    provider.push(completed());
    let retry = run_to_terminal(
        &registry,
        "synthetic-retry-b",
        None,
        subagent_run("same subagent task", conversation),
    )
    .await;
    assert!(retry.get("error").is_none(), "{retry}");
    wait_until_idle(store.pool(), conversation).await;

    // 同一会话里内容不同的无 id 消息保有自己的身份，不会并进上一条。
    provider.push(completed());
    let other = run_to_terminal(
        &registry,
        "synthetic-retry-c",
        None,
        subagent_run("a different subagent task", conversation),
    )
    .await;
    assert!(other.get("error").is_none(), "{other}");

    let runtime_messages: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages
         WHERE conversation_id = ? AND message_id LIKE 'runtime:%'",
    )
    .bind(conversation)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(runtime_messages, 2);
}

