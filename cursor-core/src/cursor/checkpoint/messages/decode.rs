//! Decodes Cursor checkpoint message data into canonical Messages.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

use crate::{
    model::{
        CanonicalMessage, ContentPart, MessageContent, Origin, RecoveredToolRound, Role, ToolCall,
        ToolCallContent, ToolResultContent, ToolRoundAssistant, ToolRoundId,
    },
    store::BlobId,
    Error, Result,
};

use super::REPLAY_ENVELOPE_PREFIX;

pub fn decode(data: &[u8], internal_id: String) -> Result<CanonicalMessage> {
    let value: Value = serde_json::from_slice(data)?;
    let role = match required_string(&value, "role")? {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        role => {
            return Err(Error::Protocol(format!(
                "unknown Cursor message role: {role}"
            )))
        }
    };
    let wire_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let is_request_context = role == Role::User && wire_id.starts_with("request-context:");
    let is_prompt_context =
        is_request_context || role == Role::User && wire_id.starts_with("selected-context:");
    let origin = match role {
        Role::System => Origin::Prompt,
        Role::Assistant => Origin::Assistant,
        Role::Tool => Origin::Tool,
        Role::User if wire_id.starts_with("runtime:") => Origin::Runtime,
        Role::User if is_prompt_context => Origin::Prompt,
        Role::User => Origin::User,
    };
    let runtime_event_id = wire_id.strip_prefix("runtime:").map(str::to_string);
    let content = match role {
        Role::Assistant => decode_assistant(&value, &internal_id)?,
        Role::Tool => MessageContent::ToolResult(decode_tool_result(&value)?),
        _ => decode_text(&value)?,
    };
    let message_id = if runtime_event_id.is_some() || is_request_context {
        wire_id
    } else {
        internal_id
    };
    Ok(CanonicalMessage {
        message_id,
        role,
        origin,
        content,
        runtime_event_id,
    })
}

pub fn decode_pending(value: &str) -> Result<RecoveredToolRound> {
    let wire: Value = serde_json::from_str(value)?;
    let started_at_ms = wire
        .pointer("/providerOptions/cursor/pendingToolCallStartedAtMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            Error::Protocol("Cursor pending assistant is missing pendingToolCallStartedAtMs".into())
        })?;
    let internal_id = format!(
        "cursor-pending:{}",
        BlobId::digest(value.as_bytes()).to_base64()
    );
    let message = decode(value.as_bytes(), internal_id.clone())?;
    let MessageContent::Assistant {
        text,
        thinking,
        tool_round_id: _,
        replay_state,
        tool_calls,
    } = message.content
    else {
        return Err(Error::Protocol(
            "Cursor pending message is not an assistant message".into(),
        ));
    };
    if tool_calls.is_empty() {
        return Err(Error::Protocol(
            "Cursor resume contains a pending assistant without tool calls".into(),
        ));
    }
    let model_call_id = wire
        .pointer("/providerOptions/cursor/modelProviderMessageId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&internal_id)
        .to_string();
    let calls = tool_calls
        .into_iter()
        .enumerate()
        .map(|(index, call)| {
            let argument_error = wire
                .pointer("/providerOptions/cursor/pendingToolExecutionContracts")
                .and_then(|contracts| contracts.get(&call.call_id))
                .and_then(|contract| contract.get("argumentError"))
                .and_then(Value::as_str)
                .map(str::to_string);
            Ok(ToolCall {
                index,
                call_id: call.call_id,
                model_call_id: model_call_id.clone(),
                name: call.name,
                arguments_text: serde_json::to_string(&call.arguments)?,
                arguments: call.arguments,
                argument_error,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RecoveredToolRound {
        assistant: ToolRoundAssistant {
            text,
            thinking,
            model_call_id,
            replay_state,
        },
        calls,
        started_at_ms,
    })
}

fn decode_text(value: &Value) -> Result<MessageContent> {
    let content = value.get("content").unwrap_or(&Value::Null);
    if let Some(text) = content.as_str() {
        return Ok(MessageContent::Parts {
            parts: vec![ContentPart::Text { text: text.into() }],
        });
    }
    let parts = content
        .as_array()
        .ok_or_else(|| Error::Protocol("Cursor message content is not an array".into()))?
        .iter()
        .map(|part| match part.get("type").and_then(Value::as_str) {
            Some("text") => Ok(ContentPart::Text {
                text: required_string(part, "text")?.into(),
            }),
            Some("image") => {
                let mime_type = required_string(part, "mimeType")?;
                let encoded = required_string(part, "image")?;
                Ok(ContentPart::Image {
                    mime_type: mime_type.into(),
                    data: STANDARD.decode(encoded).map_err(|error| {
                        Error::Protocol(format!("invalid Cursor image base64: {error}"))
                    })?,
                })
            }
            Some(kind) => Err(Error::Protocol(format!(
                "unsupported Cursor message content part: {kind}"
            ))),
            None => Err(Error::Protocol(
                "Cursor message content part is missing type".into(),
            )),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(MessageContent::Parts { parts })
}

fn decode_assistant(value: &Value, internal_id: &str) -> Result<MessageContent> {
    let mut text = String::new();
    let mut thinking = String::new();
    let mut calls = Vec::new();
    let mut replay_state = None;
    for part in value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                text.push_str(part.get("text").and_then(Value::as_str).unwrap_or_default())
            }
            Some("reasoning") => {
                thinking.push_str(part.get("text").and_then(Value::as_str).unwrap_or_default());
                if let Some(signature) = part.get("signature").and_then(Value::as_str) {
                    if replay_state.is_some() {
                        return Err(Error::Protocol(
                            "Cursor assistant has multiple reasoning signatures".into(),
                        ));
                    }
                    replay_state = Some(decode_replay_state(signature)?);
                }
            }
            Some("tool-call") => calls.push(ToolCallContent {
                index: calls.len(),
                call_id: required_string(part, "toolCallId")?.into(),
                name: required_string(part, "toolName")?.into(),
                arguments: part.get("args").cloned().unwrap_or(Value::Null),
            }),
            _ => {}
        }
    }
    Ok(MessageContent::Assistant {
        text,
        thinking,
        tool_round_id: (!calls.is_empty())
            .then(|| ToolRoundId::new(format!("{internal_id}:tool-round"))),
        replay_state,
        tool_calls: calls,
    })
}

fn decode_replay_state(signature: &str) -> Result<crate::model::ProviderReplayState> {
    let Some(encoded) = signature.strip_prefix(REPLAY_ENVELOPE_PREFIX) else {
        return Ok(crate::model::ProviderReplayState {
            provider_kind: "cursor_opaque".into(),
            value: Value::String(signature.into()),
        });
    };
    let bytes = STANDARD.decode(encoded).map_err(|error| {
        Error::Protocol(format!(
            "invalid Cursor BYOK replay envelope base64: {error}"
        ))
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|error| Error::Protocol(format!("invalid Cursor BYOK replay envelope: {error}")))
}

fn decode_tool_result(value: &Value) -> Result<ToolResultContent> {
    let part = value
        .get("content")
        .and_then(Value::as_array)
        .and_then(|parts| parts.first())
        .ok_or_else(|| Error::Protocol("Cursor tool message has no result part".into()))?;
    Ok(ToolResultContent {
        call_id: required_string(part, "toolCallId")?.into(),
        name: required_string(part, "toolName")?.into(),
        content: part
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        is_error: part
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        image: None,
        provider_parts: Vec::new(),
    })
}

fn required_string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Protocol(format!("Cursor message is missing {name}")))
}
