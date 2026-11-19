//! Verifies unique persisted and streamed terminal outcomes.
#[path = "support/fake_provider.rs"]
pub(crate) mod fake_provider;
#[path = "support/fixtures.rs"]
pub(crate) mod fixtures;

mod error_lifecycle_cases;

use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportParent, TransportRegistry},
    provider::{FinishReason, ModelEvent},
};
use prost::Message;

pub(crate) async fn assert_run_starts_without_parent_dependency(
    request_id: &str,
    parent: Option<TransportParent>,
    subagent_type_name: Option<&str>,
) {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "independent-model-call".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("continued independently".into()),
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
    let mut message = protocol_client_run("continue", "independent-user");
    let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message.as_mut()
    else {
        unreachable!()
    };
    request.conversation_id = Some(format!("{request_id}-conversation"));
    request.subagent_type_name = subagent_type_name.map(str::to_owned);

    let terminal_json = run_to_terminal(&registry, request_id, parent, message).await;

    assert!(terminal_json.get("error").is_none(), "{terminal_json}");
    assert_eq!(provider.requests().len(), 1);
    let row: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT run_kind, parent_run_id, parent_tool_call_id FROM runs WHERE cursor_request_id = ?",
    )
    .bind(request_id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(row, ("root".into(), None, None));
}

/// 把一条客户端消息送进传输层并等到 EndStream，返回终态 JSON。
///
/// 断言"这次请求有没有被准入、跑没跑完"的测试都走它，帧循环只留这一份。
pub(crate) async fn run_to_terminal(
    registry: &TransportRegistry,
    request_id: &str,
    parent: Option<TransportParent>,
    message: pb::AgentClientMessage,
) -> serde_json::Value {
    let handle = registry.get_or_create(request_id).await.unwrap();
    if let Some(parent) = parent {
        handle.set_parent(parent).unwrap();
    }
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(message),
        })
        .await
        .unwrap();

    let mut seqno = 1;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = server.message {
            handle
                .command(TransportCommand::Append {
                    seqno,
                    message: Box::new(kv_ack(kv.id)),
                })
                .await
                .unwrap();
            seqno += 1;
        }
    }
}

/// Windows Cursor 的子代理 kickoff 不带 `message_id`（macOS 客户端会填）。
pub(crate) fn subagent_run(text: &str, conversation_id: &str) -> pb::AgentClientMessage {
    let mut message = protocol_client_run(text, "");
    let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message.as_mut()
    else {
        unreachable!()
    };
    request.conversation_id = Some(conversation_id.into());
    request.subagent_type_name = Some("generalPurpose".into());
    message
}

/// 等该会话没有活跃 run：重试幂等的断言必须等上一轮结束再做。
pub(crate) async fn wait_until_idle(pool: &sqlx::SqlitePool, conversation_id: &str) {
    for _ in 0..50 {
        let active: Option<String> =
            sqlx::query_scalar("SELECT active_run_id FROM conversations WHERE conversation_id = ?")
                .bind(conversation_id)
                .fetch_optional(pool)
                .await
                .unwrap()
                .flatten();
        if active.is_none() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("conversation {conversation_id} never became idle");
}

/// Windows 子代理启动消息没有 `message_id`：不能因此拒绝请求。
///
/// 修复前这条路径返回 `Cursor user message action has no message_id`，客户端表现为
/// 子代理永远停在「Planning next moves」——主对话照常，只有子代理起不来。

pub(crate) fn client_run() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "hello".into(),
                                message_id: "failed-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("failed-conversation".into()),
                run_id: Some("failed-request".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn protocol_client_run(text: &str, message_id: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: text.into(),
                                message_id: message_id.into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("protocol-failed-conversation".into()),
                run_id: Some("protocol-failed-request".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn kv_ack(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::KvClientMessage(
            pb::KvClientMessage {
                id,
                message: Some(pb::kv_client_message::Message::SetBlobResult(
                    pb::SetBlobResult { error: None },
                )),
            },
        )),
    }
}
