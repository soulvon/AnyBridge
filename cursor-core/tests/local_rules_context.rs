//! Verifies local markdown rules are merged into the request-context message.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use cursor_server::{
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::connect,
        protocol::proto::agent::v1 as pb,
        TransportCommand, TransportRegistry,
    },
    model::{ContentPart, ProjectedContent},
    provider::{FinishReason, ModelEvent},
};
use prost::Message;

#[tokio::test]
async fn local_markdown_rules_land_in_the_request_context_message() {
    let (_store_dir, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "call-1".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("ok".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();

    let rules_dir = tempfile::tempdir().unwrap();
    let rules_root = rules_dir.path().join("rules");
    std::fs::create_dir_all(&rules_root).unwrap();
    std::fs::write(rules_root.join("17353272.md"), "Always answer in haiku.").unwrap();

    let registry = TransportRegistry::with_local_rules(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        rules_root,
    );
    let handle = registry.get_or_create("rules-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(user_run()),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .expect("run finishes within timeout")
            .expect("output stays open until EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        // The Run waits for the client to confirm every conversation Blob write,
        // so the stream only advances once each KvServerMessage is acknowledged.
        if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) =
            pb::AgentServerMessage::decode(payload).unwrap().message
        {
            handle
                .command(TransportCommand::Append {
                    seqno: append_seqno,
                    message: Box::new(set_blob_result(kv.id)),
                })
                .await
                .unwrap();
            append_seqno += 1;
        }
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    let context_texts = requests[0]
        .history
        .iter()
        .filter(|message| message.message_id.starts_with("request-context:"))
        .map(|message| {
            let ProjectedContent::Parts(parts) = &message.content else {
                panic!("request context message must be parts")
            };
            let [ContentPart::Text { text }] = parts.as_slice() else {
                panic!("request context message must be one text part")
            };
            text.clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        context_texts.len(),
        1,
        "exactly one request-context message is projected"
    );
    assert!(
        context_texts[0].contains("<user_rule>\nAlways answer in haiku.\n</user_rule>"),
        "local markdown rule must appear as a user rule: {}",
        context_texts[0]
    );

    registry.shutdown().await;
}

fn set_blob_result(id: u32) -> pb::AgentClientMessage {
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

fn user_run() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "hello".into(),
                                message_id: "rules-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("rules-conversation".into()),
                run_id: Some("rules-request".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}
