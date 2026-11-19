use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportRegistry},
    model::{MessageContent, ModelConfigInput, ModelType, ProjectedContent, OPENAI_CHAT_ENDPOINT},
    provider::{FinishReason, ModelEvent},
};
use prost::Message;
use serde_json::json;

use crate::{
    client_run, client_run_for_model, fake_provider, fixtures, kv_ack, text_events,
    tool_call_response,
};

#[tokio::test]
async fn one_run_can_auto_compact_again_after_more_tool_output() {
    let (_directory, store) = fixtures::temp_store().await;
    let model = store
        .create_model(&ModelConfigInput {
            sort_order: 0,
            display_name: "Repeated compaction".into(),
            group_name: None,
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "test-key".into(),
            tooltip_data: "Repeated compaction".into(),
            model_id: "repeated-compaction-model".into(),
            reasoning_effort: None,
            openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: json!({}),
            custom_headers_enabled: false,
            custom_headers: json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: json!({}),
            context_window_tokens: Some(25_000),
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        })
        .await
        .unwrap();
    let provider = fake_provider::FakeProvider::default();
    provider.push(tool_call_response("repeat-call-1"));
    provider.push(text_events("first summary"));
    provider.push(tool_call_response("repeat-call-2"));
    provider.push(text_events("second summary"));
    provider.push(text_events("done"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry
        .get_or_create("repeated-compaction-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for_model(
                "repeated-compaction-conversation",
                "repeated-compaction-request",
                &model.model_hash,
            )),
        })
        .await
        .unwrap();
    let mut seqno = 1;
    let oversized = format!("HEAD{}TAIL", "x".repeat(4 * 1024 * 1024));
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                let exec_id = exec.id;
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: exec_id,
                                    exec_id: String::new(),
                                    message: Some(pb::exec_client_message::Message::ReadResult(
                                        pb::ReadResult {
                                            result: Some(pb::read_result::Result::Success(
                                                pb::ReadSuccess {
                                                    path: "/tmp/large.txt".into(),
                                                    total_lines: 1,
                                                    file_size: oversized.len() as i64,
                                                    output: Some(
                                                        pb::read_success::Output::Content(
                                                            oversized.clone(),
                                                        ),
                                                    ),
                                                    ..Default::default()
                                                },
                                            )),
                                        },
                                    )),
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(
                                pb::agent_client_message::Message::ExecClientControlMessage(
                                    pb::ExecClientControlMessage {
                                        message: Some(
                                            pb::exec_client_control_message::Message::StreamClose(
                                                pb::ExecClientStreamClose { id: exec_id },
                                            ),
                                        ),
                                    },
                                ),
                            ),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            _ => {}
        }
    }

    let requests = provider.requests();
    let shapes = requests
        .iter()
        .map(|request| {
            (
                request.prompt.tools.len(),
                request.history.len(),
                request
                    .history
                    .iter()
                    .filter_map(|message| match &message.content {
                        ProjectedContent::ToolResult(result) => Some(result.content.len()),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 5, "provider requests: {shapes:?}");
    assert!(!requests[0].prompt.tools.is_empty());
    assert!(requests[1].prompt.tools.is_empty());
    assert!(!requests[2].prompt.tools.is_empty());
    assert!(requests[3].prompt.tools.is_empty());
    assert!(!requests[4].prompt.tools.is_empty());
}

#[tokio::test]
async fn provider_tool_use_waits_for_client_result_then_calls_provider_again() {
    let (directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "ignored".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call-1".into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"/tmp/a\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "ignored".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("done".into()),
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
    let handle = registry.get_or_create("tool-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run()),
        })
        .await
        .unwrap();
    let mut seqno = 1;
    let mut saw_exec = false;
    let mut saw_typed_completion = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&payload).unwrap(),
                json!({})
            );
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                saw_exec = true;
                let exec_id = exec.id;
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: exec_id,
                                    exec_id: String::new(),
                                    message: Some(pb::exec_client_message::Message::ReadResult(
                                        pb::ReadResult {
                                            result: Some(pb::read_result::Result::Success(
                                                pb::ReadSuccess {
                                                    path: "/tmp/a".into(),
                                                    total_lines: 1,
                                                    file_size: 1,
                                                    output: Some(
                                                        pb::read_success::Output::Content(
                                                            "x".into(),
                                                        ),
                                                    ),
                                                    ..Default::default()
                                                },
                                            )),
                                        },
                                    )),
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(
                                pb::agent_client_message::Message::ExecClientControlMessage(
                                    pb::ExecClientControlMessage {
                                        message: Some(
                                            pb::exec_client_control_message::Message::StreamClose(
                                                pb::ExecClientStreamClose { id: exec_id },
                                            ),
                                        ),
                                    },
                                ),
                            ),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                if let Some(pb::interaction_update::Message::ToolCallCompleted(completed)) =
                    update.message
                {
                    let tool_call = completed.tool_call.expect("completed ToolCall");
                    assert!(tool_call.started_at_ms.unwrap_or_default() > 1);
                    assert!(tool_call.completed_at_ms.unwrap_or_default() > 1);
                    assert!(tool_call.completed_at_ms >= tool_call.started_at_ms);
                    let Some(pb::tool_call::Tool::ReadToolCall(read)) = tool_call.tool else {
                        panic!("expected completed ReadToolCall")
                    };
                    let result = read.result.expect("typed ReadToolResult");
                    assert!(matches!(
                        result.result,
                        Some(pb::read_tool_result::Result::Success(_))
                    ));
                    saw_typed_completion = true;
                }
            }
            _ => {}
        }
    }
    assert!(saw_exec);
    assert!(saw_typed_completion);
    assert_eq!(provider.requests().len(), 2);
    let database = sqlx::SqlitePool::connect(&format!(
        "sqlite://{}",
        directory.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let provider_call_index: i64 =
        sqlx::query_scalar("SELECT provider_call_index FROM runs WHERE cursor_request_id = ?")
            .bind("tool-request")
            .fetch_one(&database)
            .await
            .unwrap();
    assert_eq!(provider_call_index, 1);
    let messages = store
        .load_current_messages(&cursor_server::model::ConversationId::new(
            "tool-conversation",
        ))
        .await
        .unwrap();
    let result_position = messages
        .iter()
        .position(|message| matches!(message.content, MessageContent::ToolResult(_)))
        .expect("tool result persisted");
    let MessageContent::Assistant { tool_calls, .. } = &messages[result_position - 1].content
    else {
        panic!("tool result must immediately follow its assistant tool call")
    };
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].call_id, "call-1");
}


#[tokio::test]
async fn duplicate_tool_call_id_across_rounds_does_not_wedge_the_run() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    for _ in 0..2 {
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: "ignored".into(),
            },
            ModelEvent::ToolCallStart {
                index: 0,
                call_id: "call-1".into(),
                name: "Read".into(),
            },
            ModelEvent::ToolCallArgumentsDelta {
                index: 0,
                delta: "{\"path\":\"/tmp/a\"}".into(),
            },
            ModelEvent::ToolCallEnd { index: 0 },
            ModelEvent::Done(FinishReason::ToolUse),
        ]);
    }
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "ignored".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("done".into()),
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
    let handle = registry.get_or_create("tool-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run()),
        })
        .await
        .unwrap();
    let mut seqno = 1;
    let mut execs = 0;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), output.recv())
            .await
            .expect("run must not hang on a reused tool call id")
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                execs += 1;
                let exec_id = exec.id;
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: exec_id,
                                    exec_id: String::new(),
                                    message: Some(pb::exec_client_message::Message::ReadResult(
                                        pb::ReadResult {
                                            result: Some(pb::read_result::Result::Success(
                                                pb::ReadSuccess {
                                                    path: "/tmp/a".into(),
                                                    total_lines: 1,
                                                    file_size: 1,
                                                    output: Some(
                                                        pb::read_success::Output::Content(
                                                            "x".into(),
                                                        ),
                                                    ),
                                                    ..Default::default()
                                                },
                                            )),
                                        },
                                    )),
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(
                                pb::agent_client_message::Message::ExecClientControlMessage(
                                    pb::ExecClientControlMessage {
                                        message: Some(
                                            pb::exec_client_control_message::Message::StreamClose(
                                                pb::ExecClientStreamClose { id: exec_id },
                                            ),
                                        ),
                                    },
                                ),
                            ),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            _ => {}
        }
    }
    // Both rounds have to reach the client, and the run has to get far enough
    // to ask the provider a third time and finish.
    assert_eq!(execs, 2);
    assert_eq!(provider.requests().len(), 3);
}

