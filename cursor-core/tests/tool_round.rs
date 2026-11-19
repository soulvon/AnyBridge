//! Verifies Tool dispatch, completion gating, and result continuation.
#[path = "support/fake_provider.rs"]
pub(crate) mod fake_provider;
#[path = "support/fixtures.rs"]
pub(crate) mod fixtures;

mod tool_round_cases;

use cursor_server::{
    cursor::{protocol::proto::agent::v1 as pb, tools::runtime::ExecContext},
    model::ToolCall,
    provider::{FinishReason, ModelEvent},
};
use serde_json::json;

pub(crate) fn call(id: &str, name: &str) -> ToolCall {
    ToolCall {
        index: 0,
        call_id: id.into(),
        model_call_id: "model:0".into(),
        name: name.into(),
        arguments_text: "{}".into(),
        arguments: json!({}),
        argument_error: None,
    }
}

pub(crate) fn exec_context() -> ExecContext {
    ExecContext {
        conversation_id: "conversation".into(),
        root_conversation_id: "conversation".into(),
        default_subagent_model: "model".into(),
        subagent_model: None,
        terminals_folder: "/tmp/terminals".into(),
        admin_command_denylist: Vec::new(),
        allow_subagents: true,
        subagents_disabled: false,
        mcp_routes: std::collections::HashMap::new(),
    }
}

pub(crate) fn mcp_context(server: &str, provider: &str, tool: &str) -> ExecContext {
    let mut context = exec_context();
    context.mcp_routes.insert(
        (server.into(), tool.into()),
        cursor_server::cursor::tools::runtime::McpRoute {
            name: format!("{server}-{tool}"),
            provider_identifier: provider.into(),
            tool_name: tool.into(),
            description: "fixture MCP tool".into(),
        },
    );
    context
}


pub(crate) fn tool_call_response(call_id: &str) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: format!("model-{call_id}"),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: call_id.into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"/tmp/large.txt\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]
}

pub(crate) fn text_events(text: &str) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: format!("model-{text}"),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta(text.into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]
}

pub(crate) fn client_run_for_model(
    conversation_id: &str,
    run_id: &str,
    model_id: &str,
) -> pb::AgentClientMessage {
    let user = pb::UserMessage {
        text: "read it".into(),
        message_id: "user".into(),
        mode: pb::AgentMode::Agent as i32,
        ..Default::default()
    };
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(user),
                            request_context: Some(pb::RequestContext::default()),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some(conversation_id.into()),
                run_id: Some(run_id.into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: model_id.into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

/// A provider that reuses a tool call id across two rounds of the same run
/// must not wedge the run. `ToolDispatcher::start_batch` skips any call whose
/// id is already in `ToolBatchState::completed`, and that set is never cleared
/// for the lifetime of the run, so the skipped call produced no completion and
/// `tool_round::execute` waited forever for a result that could never arrive.

pub(crate) fn client_run() -> pb::AgentClientMessage {
    let user = pb::UserMessage {
        text: "read it".into(),
        message_id: "user".into(),
        mode: pb::AgentMode::Agent as i32,
        ..Default::default()
    };
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(user),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("tool-conversation".into()),
                run_id: Some("tool-request".into()),
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
