//! Converts search completions into Tool results.
//! Cursor MCP-card rendering for direct Semble Agent tools.

use serde_json::Value;

use crate::{
    cursor::protocol::proto::agent::v1 as pb,
    model::{ToolCall, ToolResult},
    Result,
};

use super::ToolCompletion;

const PROVIDER_IDENTIFIER: &str = "builtin-semble";

pub(crate) fn complete(
    call: &ToolCall,
    started_at_ms: u64,
    output: std::result::Result<Value, String>,
) -> Result<ToolCompletion> {
    use pb::{mcp_tool_result::Result as McpResult, tool_call::Tool};

    let (tool_name, fallback_description) = match normalized(&call.name).as_str() {
        "semblesearch" => ("search", "Search the codebase"),
        "semblefindrelated" => ("find_related", "Find related code"),
        _ => (call.name.as_str(), "Search the codebase"),
    };
    let description = call
        .arguments
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_description)
        .to_owned();
    let arguments = call
        .arguments
        .as_object()
        .map(|arguments| {
            let mut arguments = arguments.clone();
            arguments.remove("description");
            crate::cursor::tools::codec::json_object_to_prost(&arguments)
        })
        .unwrap_or_default();
    let (content, is_error, result) = match output {
        Ok(value) => {
            let content = serde_json::to_string_pretty(&value)?;
            let structured_content = value.as_object().map(|value| prost_types::Struct {
                fields: crate::cursor::tools::codec::json_object_to_prost(value)
                    .into_iter()
                    .collect(),
            });
            (
                content.clone(),
                false,
                McpResult::Success(pb::McpSuccess {
                    content: vec![pb::McpToolResultContentItem {
                        content: Some(pb::mcp_tool_result_content_item::Content::Text(
                            pb::McpTextContent {
                                text: content,
                                output_location: None,
                            },
                        )),
                    }],
                    is_error: false,
                    structured_content,
                }),
            )
        }
        Err(error) => (
            error.clone(),
            true,
            McpResult::Error(pb::McpToolError {
                error,
                read_tool_def_reminder: String::new(),
            }),
        ),
    };
    Ok(ToolCompletion::new(
        call,
        started_at_ms,
        ToolResult {
            call_id: call.call_id.clone(),
            content,
            is_error,
            image: None,
        },
        Tool::McpToolCall(pb::McpToolCall {
            args: Some(pb::McpArgs {
                name: tool_name.into(),
                args: arguments,
                tool_call_id: call.call_id.clone(),
                provider_identifier: PROVIDER_IDENTIFIER.into(),
                tool_name: tool_name.into(),
                server_identifier: PROVIDER_IDENTIFIER.into(),
                ..Default::default()
            }),
            result: Some(pb::McpToolResult {
                result: Some(result),
            }),
            description: Some(description),
        }),
    ))
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
