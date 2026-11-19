//! Verifies BreakMessages, cancellation, shutdown, and Finalizing races.
#[path = "support/fake_provider.rs"]
pub(crate) mod fake_provider;
#[path = "support/fixtures.rs"]
pub(crate) mod fixtures;

mod interrupt_cases;

use bytes::Bytes;
use cursor_server::{
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportRegistry},
    model::Usage,
    provider::{FinishReason, ModelEvent},
};
use prost::Message;

pub(crate) fn client_run() -> pb::AgentClientMessage {
    client_run_for("cancel-request", "cancel-conversation")
}

pub(crate) fn client_run_for(request_id: &str, conversation_id: &str) -> pb::AgentClientMessage {
    client_run_for_model(request_id, conversation_id, "test-model")
}

pub(crate) fn client_run_for_model(
    request_id: &str,
    conversation_id: &str,
    model_id: &str,
) -> pb::AgentClientMessage {
    client_run_for_model_with_state(request_id, conversation_id, model_id, None)
}

pub(crate) fn client_run_for_model_with_state(
    request_id: &str,
    conversation_id: &str,
    model_id: &str,
    state: Option<pb::ConversationStateStructure>,
) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "read".into(),
                                message_id: "cancel-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some(conversation_id.into()),
                run_id: Some(request_id.into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: model_id.into(),
                    ..Default::default()
                }),
                conversation_state: state,
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn text_response(text: &str) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: format!("call-{text}"),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta(text.into()),
        ModelEvent::TextEnd,
        ModelEvent::Usage(Usage {
            input_tokens: Some(1),
            context_input_tokens: Some(1),
            output_tokens: Some(1),
            total_tokens: Some(2),
            ..Default::default()
        }),
        ModelEvent::Done(FinishReason::Stop),
    ]
}

pub(crate) fn tool_response(call_id: &str, name: &str, arguments: &str) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: format!("call-{call_id}"),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: call_id.into(),
            name: name.into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: arguments.into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]
}

pub(crate) async fn wait_for_exec(
    handle: &cursor_server::cursor::TransportHandle,
    output: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    append_seqno: &mut i64,
    tool: &str,
) -> u32 {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Exec");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(flags & connect::END_STREAM_FLAG, 0);
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::ExecServerMessage(exec)) = server.message {
            let matches = match exec.message.as_ref() {
                Some(pb::exec_server_message::Message::ReadArgs(_)) => tool == "Read",
                Some(pb::exec_server_message::Message::SubagentArgs(_)) => tool == "Task",
                _ => false,
            };
            if matches {
                return exec.id;
            }
        }
        acknowledge_kv(handle, append_seqno, &frame).await;
    }
}

pub(crate) async fn drain_successfully(
    handle: &cursor_server::cursor::TransportHandle,
    output: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    append_seqno: &mut i64,
) {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before successful EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            return;
        }
        acknowledge_kv(handle, append_seqno, &frame).await;
    }
}

pub(crate) fn read_success(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientMessage(
            pb::ExecClientMessage {
                id,
                message: Some(pb::exec_client_message::Message::ReadResult(
                    pb::ReadResult {
                        result: Some(pb::read_result::Result::Success(pb::ReadSuccess {
                            path: "/tmp/a".into(),
                            total_lines: 1,
                            file_size: 1,
                            output: Some(pb::read_success::Output::Content("late".into())),
                            ..Default::default()
                        })),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn subagent_success(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientMessage(
            pb::ExecClientMessage {
                id,
                message: Some(pb::exec_client_message::Message::SubagentResult(
                    pb::SubagentResult {
                        result: Some(pb::subagent_result::Result::Success(pb::SubagentSuccess {
                            agent_id: "detached-child".into(),
                            ..Default::default()
                        })),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) async fn run_to_end(
    registry: &TransportRegistry,
    request_id: &str,
    request: pb::AgentClientMessage,
) -> pb::ConversationStateStructure {
    let handle = registry.get_or_create(request_id).await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(request),
        })
        .await
        .unwrap();
    let mut append_seqno = 1;
    let mut state = None;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before EndStream");
        let (flags, _) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            return state.expect("Run ended without a checkpoint");
        }
        let (_, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(update)) =
            server.message
        {
            state = Some(update);
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }
}

pub(crate) async fn wait_for_turn_ended(
    handle: &cursor_server::cursor::TransportHandle,
    output: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    append_seqno: &mut i64,
) {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before turnEnded");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(flags & connect::END_STREAM_FLAG, 0);
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        let turn_ended = matches!(
            server.message,
            Some(pb::agent_server_message::Message::InteractionUpdate(
                pb::InteractionUpdate {
                    message: Some(pb::interaction_update::Message::TurnEnded(_)),
                }
            ))
        );
        acknowledge_kv(handle, append_seqno, &frame).await;
        if turn_ended {
            return;
        }
    }
}

pub(crate) async fn assert_transport_remains_open(
    handle: &cursor_server::cursor::TransportHandle,
    output: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    append_seqno: &mut i64,
) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(frame)) = tokio::time::timeout(remaining, output.recv()).await else {
            return;
        };
        let (flags, _) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(
            flags & connect::END_STREAM_FLAG,
            0,
            "turnEnded closed the transport before the queued action arrived"
        );
        acknowledge_kv(handle, append_seqno, &frame).await;
    }
}

pub(crate) async fn acknowledge_kv(
    handle: &cursor_server::cursor::TransportHandle,
    append_seqno: &mut i64,
    frame: &[u8],
) {
    let (flags, payload) = connect::decode_frames(frame).unwrap().pop().unwrap();
    if flags & connect::END_STREAM_FLAG != 0 {
        return;
    }
    let server = pb::AgentServerMessage::decode(payload).unwrap();
    if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = server.message {
        handle
            .command(TransportCommand::Append {
                seqno: *append_seqno,
                message: Box::new(kv_ack(kv.id)),
            })
            .await
            .unwrap();
        *append_seqno += 1;
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

pub(crate) fn runtime_cancel_action() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::CancelAction(
                    pb::CancelAction::default(),
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn runtime_unsupported_action() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::ResumeAction(
                    pb::ResumeAction::default(),
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn runtime_user_message() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::UserMessageAction(
                    pb::UserMessageAction {
                        user_message: Some(pb::UserMessage {
                            text: "queued follow-up".into(),
                            message_id: "queued-user".into(),
                            mode: pb::AgentMode::Agent as i32,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn runtime_injection() -> pb::AgentClientMessage {
    runtime_injection_for("injection-1", "inject-request")
}

pub(crate) fn runtime_injection_for(injection_id: &str, expected_run_id: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::InjectContextAction(
                    pb::InjectContextAction {
                        injection_id: injection_id.into(),
                        expected_run_id: expected_run_id.into(),
                        payload: Some(pb::inject_context_action::Payload::UserContext(
                            pb::UserContextInjection {
                                user_message: Some(pb::UserMessage {
                                    text: "injected follow-up".into(),
                                    message_id: "injected-user".into(),
                                    ..Default::default()
                                }),
                                request_context: Some(Default::default()),
                            },
                        )),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn runtime_cancel_subagent(tool_call_id: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::CancelSubagentAction(
                    pb::CancelSubagentAction {
                        subagent_id: tool_call_id.into(),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn subagent_aborted(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientMessage(
            pb::ExecClientMessage {
                id,
                message: Some(pb::exec_client_message::Message::SubagentResult(
                    pb::SubagentResult {
                        result: Some(pb::subagent_result::Result::Error(pb::SubagentError {
                            agent_id: None,
                            error: "Subagent was aborted by the user".into(),
                        })),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}
