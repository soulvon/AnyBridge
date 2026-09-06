//! Converts MCP completions into Tool results.
//! Canonical failures produced before an MCP request reaches the Cursor client.

use crate::{
    cursor::{protocol::proto::agent::v1 as pb, tools::codec},
    model::{ToolCall, ToolResult},
    Result,
};

use super::{now_ms, ToolCompletion};

pub(crate) fn failure(call: &ToolCall, error: String) -> Result<ToolCompletion> {
    let server = call
        .arguments
        .get("server")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let tool_name = call
        .arguments
        .get("toolName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let arguments = call
        .arguments
        .get("arguments")
        .and_then(serde_json::Value::as_object)
        .map(codec::json_object_to_prost)
        .unwrap_or_default();
    Ok(ToolCompletion::new(
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
                name: format!("{server}-{tool_name}"),
                args: arguments,
                tool_call_id: call.call_id.clone(),
                provider_identifier: server.into(),
                tool_name: tool_name.into(),
                server_identifier: server.into(),
                ..Default::default()
            }),
            result: Some(pb::McpToolResult {
                result: Some(pb::mcp_tool_result::Result::Error(pb::McpToolError {
                    error,
                    read_tool_def_reminder: String::new(),
                })),
            }),
            description: call
                .arguments
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        }),
    ))
}
