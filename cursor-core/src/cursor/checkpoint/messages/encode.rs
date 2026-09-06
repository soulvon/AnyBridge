//! Encodes canonical Messages into stable Cursor checkpoint message data.
use std::collections::HashSet;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};

use crate::{
    model::{
        project_messages, CanonicalMessage, ContentPart, ProjectedContent, ProjectedMessage, Role,
        ToolCall, ToolCallContent, ToolRoundAssistant,
    },
    Error, Result,
};

use super::REPLAY_ENVELOPE_PREFIX;

pub fn stable_messages(
    instructions: &str,
    messages: &[CanonicalMessage],
    model: &str,
) -> Result<Vec<Vec<u8>>> {
    let mut projected = project_messages(messages)?;
    if !instructions.is_empty() {
        projected.insert(
            0,
            ProjectedMessage {
                message_id: "system".into(),
                role: Role::System,
                content: ProjectedContent::Parts(vec![ContentPart::Text {
                    text: instructions.into(),
                }]),
            },
        );
    }
    projected
        .iter()
        .map(|message| serde_json::to_vec(&wire_message(message, model, None)?).map_err(Into::into))
        .collect::<std::result::Result<_, _>>()
}

pub fn staged_tool_round(
    assistant: &ToolRoundAssistant,
    calls: &[ToolCall],
    model: &str,
    allowed_tools: &[String],
    dynamic_tools: &HashSet<String>,
    started_at_ms: u64,
) -> Result<String> {
    let message = ProjectedMessage {
        message_id: assistant.model_call_id.clone(),
        role: Role::Assistant,
        content: ProjectedContent::Assistant {
            text: assistant.text.clone(),
            thinking: assistant.thinking.clone(),
            replay_state: assistant.replay_state.clone(),
            calls: calls
                .iter()
                .map(|call| ToolCallContent {
                    index: call.index,
                    call_id: call.call_id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                })
                .collect(),
        },
    };
    Ok(serde_json::to_string(&wire_message(
        &message,
        model,
        Some(PendingContext {
            allowed_tools,
            dynamic_tools,
            started_at_ms,
            tool_calls: Some(calls),
        }),
    )?)?)
}

pub fn staged_final(
    message: &CanonicalMessage,
    model: &str,
    allowed_tools: &[String],
    dynamic_tools: &HashSet<String>,
    started_at_ms: u64,
) -> Result<String> {
    let projected = project_messages(std::slice::from_ref(message))?;
    let assistant = projected
        .first()
        .filter(|message| message.role == Role::Assistant)
        .ok_or_else(|| {
            Error::Protocol("final checkpoint stage is not an assistant message".into())
        })?;
    Ok(serde_json::to_string(&wire_message(
        assistant,
        model,
        Some(PendingContext {
            allowed_tools,
            dynamic_tools,
            started_at_ms,
            tool_calls: None,
        }),
    )?)?)
}

#[derive(Clone, Copy)]
pub(super) struct PendingContext<'a> {
    allowed_tools: &'a [String],
    dynamic_tools: &'a HashSet<String>,
    started_at_ms: u64,
    tool_calls: Option<&'a [ToolCall]>,
}

pub(super) fn wire_message(
    message: &ProjectedMessage,
    model: &str,
    pending: Option<PendingContext<'_>>,
) -> Result<Value> {
    let mut root = Map::new();
    root.insert(
        "role".into(),
        Value::String(role_name(&message.role).into()),
    );
    root.insert("content".into(), wire_content(&message.content, model)?);
    root.insert("id".into(), Value::String(wire_message_id(message)));
    if let ProjectedContent::Assistant { calls, .. } = &message.content {
        let mut cursor = Map::new();
        if let Some(pending) = pending {
            cursor.insert(
                "pendingToolCallStartedAtMs".into(),
                json!(pending.started_at_ms),
            );
            cursor.insert(
                "pendingToolExecutionContracts".into(),
                Value::Object(
                    calls
                        .iter()
                        .map(|call| {
                            let mut contract = json!({
                                "toolCallId": call.call_id,
                                "outerToolName": call.name,
                                "toolIdentifier": tool_identifier(&call.name, pending.dynamic_tools),
                                "isDynamic": pending.dynamic_tools.contains(&call.name),
                                "allowedToolNames": pending.allowed_tools,
                            });
                            if let Some(error) = pending
                                .tool_calls
                                .and_then(|calls| {
                                    calls.iter().find(|candidate| candidate.call_id == call.call_id)
                                })
                                .and_then(|call| call.argument_error.as_deref())
                            {
                                contract["argumentError"] = Value::String(error.into());
                            }
                            (call.call_id.clone(), contract)
                        })
                        .collect(),
                ),
            );
        }
        if !cursor.is_empty() {
            root.insert("providerOptions".into(), json!({"cursor": cursor}));
        }
    }
    Ok(Value::Object(root))
}

fn tool_identifier(name: &str, dynamic_tools: &HashSet<String>) -> String {
    if dynamic_tools.contains(name) {
        return name.into();
    }
    match name {
        "CallMcpTool" | "SembleSearch" | "SembleFindRelated" => "MCP".into(),
        "CreatePlan" => "CREATE_PLAN_V2".into(),
        "UpdateCurrentStep" => "COMMUNICATE_UPDATE".into(),
        _ => name
            .chars()
            .enumerate()
            .fold(String::new(), |mut value, (index, character)| {
                if index > 0 && character.is_ascii_uppercase() {
                    value.push('_');
                }
                value.push(character.to_ascii_uppercase());
                value
            }),
    }
}

fn wire_message_id(message: &ProjectedMessage) -> String {
    match &message.content {
        ProjectedContent::Assistant { .. } => "1".into(),
        ProjectedContent::ToolResult(result) => result.call_id.clone(),
        ProjectedContent::Parts(_) => message.message_id.clone(),
    }
}

fn wire_content(content: &ProjectedContent, model: &str) -> Result<Value> {
    Ok(match content {
        ProjectedContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    ContentPart::Text { text } => json!({"type":"text", "text":text}),
                    ContentPart::Image { mime_type, data } => json!({
                        "type":"image",
                        "image": STANDARD.encode(data),
                        "mimeType": mime_type,
                    }),
                })
                .collect(),
        ),
        ProjectedContent::Assistant {
            text,
            thinking,
            replay_state,
            calls,
        } => {
            let mut parts = Vec::new();
            if !thinking.is_empty() || replay_state.is_some() {
                let mut reasoning = json!({
                    "type": "reasoning",
                    "text": thinking,
                    "providerOptions": {"cursor": {"modelName": model}},
                });
                if let Some(replay_state) = replay_state {
                    reasoning["signature"] = Value::String(encode_replay_state(replay_state)?);
                }
                parts.push(reasoning);
            }
            if !text.is_empty() {
                parts.push(json!({"type":"text", "text":text}));
            }
            parts.extend(calls.iter().map(|call| {
                json!({
                    "type": "tool-call",
                    "toolCallId": call.call_id,
                    "toolName": call.name,
                    "args": call.arguments,
                })
            }));
            Value::Array(parts)
        }
        ProjectedContent::ToolResult(result) => json!([{
            "type": "tool-result",
            "toolCallId": result.call_id,
            "toolName": result.name,
            "result": result.content,
            "experimental_content": [{"type":"text", "text":result.content}],
            "isError": result.is_error,
        }]),
    })
}

fn encode_replay_state(replay_state: &crate::model::ProviderReplayState) -> Result<String> {
    if replay_state.provider_kind == "cursor_opaque" {
        return replay_state
            .value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| Error::Protocol("Cursor opaque replay state is not a string".into()));
    }
    Ok(format!(
        "{REPLAY_ENVELOPE_PREFIX}{}",
        STANDARD.encode(serde_json::to_vec(replay_state)?)
    ))
}

fn role_name(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}
