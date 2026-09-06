//! Converts unsupported or retired Tool forms into safe Cursor representations.
use crate::{
    cursor::protocol::proto::agent::v1 as pb,
    model::{ToolCall, ToolResult},
};

use super::{codec, runtime::now_ms, tool_call_result::ToolCompletion};

// Unknown/retired tools use a generic Cursor MCP card only as a wire/UI
// representation; they are never dispatched to an MCP server.
const COMPAT_PROVIDER: &str = "cursor-byok-compat";

pub(crate) fn placeholder(name: &str, call_id: &str) -> pb::ToolCall {
    pb::ToolCall {
        hook_additional_contexts: Vec::new(),
        tool_call_id: Some(call_id.into()),
        started_at_ms: None,
        completed_at_ms: None,
        tool: Some(pb::tool_call::Tool::McpToolCall(pb::McpToolCall {
            args: Some(pb::McpArgs {
                name: name.into(),
                tool_call_id: call_id.into(),
                provider_identifier: COMPAT_PROVIDER.into(),
                tool_name: name.into(),
                server_identifier: COMPAT_PROVIDER.into(),
                ..Default::default()
            }),
            result: None,
            description: Some("Unavailable legacy or unsupported tool".into()),
        })),
    }
}

pub(crate) fn render(call: &ToolCall, completed: bool) -> pb::ToolCall {
    let mut output = placeholder(&call.name, &call.call_id);
    let timestamp = now_ms();
    output.started_at_ms = Some(timestamp);
    output.completed_at_ms = completed.then_some(timestamp);
    if let Some(pb::tool_call::Tool::McpToolCall(tool)) = output.tool.as_mut() {
        if let Some(args) = tool.args.as_mut() {
            args.args = call
                .arguments
                .as_object()
                .map(codec::json_object_to_prost)
                .unwrap_or_default();
        }
    }
    output
}

pub(crate) fn failure(call: &ToolCall) -> ToolCompletion {
    failure_with_message(call, failure_message(&call.name))
}

pub(crate) fn failure_with_message(call: &ToolCall, error: String) -> ToolCompletion {
    let arguments = call
        .arguments
        .as_object()
        .map(codec::json_object_to_prost)
        .unwrap_or_default();
    ToolCompletion::new(
        call,
        now_ms(),
        ToolResult {
            call_id: call.call_id.clone(),
            content: error.clone(),
            is_error: true,
            image: None,
        },
        pb::tool_call::Tool::McpToolCall(pb::McpToolCall {
            args: Some(pb::McpArgs {
                name: call.name.clone(),
                args: arguments,
                tool_call_id: call.call_id.clone(),
                provider_identifier: COMPAT_PROVIDER.into(),
                tool_name: call.name.clone(),
                server_identifier: COMPAT_PROVIDER.into(),
                ..Default::default()
            }),
            result: Some(pb::McpToolResult {
                result: Some(pb::mcp_tool_result::Result::Error(pb::McpToolError {
                    error,
                    read_tool_def_reminder: String::new(),
                })),
            }),
            description: Some("Unavailable legacy or unsupported tool".into()),
        }),
    )
}

fn failure_message(name: &str) -> String {
    if normalized(name) == "awaitshell" {
        return "Tool \"AwaitShell\" is no longer available in this Cursor BYOK version. The model emitted a tool name that is not part of the current advertised tool set. Treat the tool call as failed and continue using only tools advertised in the current prompt; for background shell work, use the current Shell/background completion flow.".into();
    }
    format!(
        "Tool \"{name}\" is not available in this Cursor BYOK version. The model emitted a tool name that is not part of the current advertised tool set. Treat the tool call as failed and continue using a tool advertised in the current prompt."
    )
}

fn normalized(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
