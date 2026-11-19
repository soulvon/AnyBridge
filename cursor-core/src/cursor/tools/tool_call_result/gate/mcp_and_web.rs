use std::collections::BTreeMap;

use crate::cursor::protocol::proto::agent::v1 as pb;

use super::truncate::{truncate_text, truncation_notice, utf8_prefix};
use super::KIB;

pub(super) const MCP_TEXT_LIMIT: usize = 32 * KIB;
const MCP_CONTENT_ITEM_LIMIT: usize = 20;
const MCP_STRUCTURED_LIMIT: usize = 32 * KIB;
const MCP_BINARY_LIMIT: usize = 32 * KIB;
const MCP_RESOURCE_LIMIT: usize = 200;
const MCP_RESOURCE_DESCRIPTION_LIMIT: usize = KIB;
const WEB_FETCH_LIMIT: usize = 32 * KIB;
const WEB_SEARCH_LIMIT: usize = 16 * KIB;
const WEB_SEARCH_TITLE_LIMIT: usize = 512;
const WEB_SEARCH_SNIPPET_LIMIT: usize = 2 * KIB;

pub(super) fn gate_mcp(tool: &mut pb::McpToolCall) {
    let Some(pb::mcp_tool_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    if success.content.iter().any(is_mcp_notice) {
        return;
    }
    let mut notices = Vec::new();
    if structured_json_len(&success.structured_content) > MCP_STRUCTURED_LIMIT {
        let original = structured_json_len(&success.structured_content);
        success.structured_content = truncated_struct(original, MCP_STRUCTURED_LIMIT);
        notices.push(truncation_notice(
            "MCP structured_content",
            MCP_STRUCTURED_LIMIT,
            0,
            original,
        ));
    }
    let original_items = success.content.len();
    if original_items > MCP_CONTENT_ITEM_LIMIT {
        success.content.truncate(MCP_CONTENT_ITEM_LIMIT);
        notices.push(format!(
            "[truncated: MCP content items exceeded {MCP_CONTENT_ITEM_LIMIT} items; showing {MCP_CONTENT_ITEM_LIMIT} of {original_items} items]"
        ));
    }
    let original_text_bytes = success.content.iter().fold(0usize, |total, item| {
        let bytes = match item.content.as_ref() {
            Some(pb::mcp_tool_result_content_item::Content::Text(text)) => text.text.len(),
            _ => 0,
        };
        total.saturating_add(bytes)
    });
    let mut remaining_text = MCP_TEXT_LIMIT;
    let mut text_truncated = false;
    let mut content = Vec::with_capacity(success.content.len() + notices.len());
    for mut item in std::mem::take(&mut success.content) {
        // MCP images are sent to the client as inline binary data. Truncating
        // an encoded image at an arbitrary byte boundary corrupts the image
        // and makes the client's image/screenshot fallback fail. The model
        // receives only the textual MCP summary below, which is bounded by
        // MCP_TEXT_LIMIT, so the image does not need this text-result gate.
        if let Some(pb::mcp_tool_result_content_item::Content::Text(text)) = item.content.as_mut() {
            let original = text.text.clone();
            let next = truncate_text("MCP content item", &original, MCP_TEXT_LIMIT);
            if remaining_text == 0 {
                text_truncated |= !next.is_empty();
                continue;
            }
            text.text = truncate_text("MCP text", &next, remaining_text);
            text_truncated |= text.text != next;
            remaining_text = remaining_text.saturating_sub(text.text.len());
        }
        content.push(item);
    }
    if text_truncated {
        notices.push(truncation_notice(
            "MCP text",
            MCP_TEXT_LIMIT,
            MCP_TEXT_LIMIT.saturating_sub(remaining_text),
            original_text_bytes,
        ));
    }
    content.extend(notices.into_iter().map(mcp_notice));
    success.content = content;
}

fn mcp_notice(text: String) -> pb::McpToolResultContentItem {
    pb::McpToolResultContentItem {
        content: Some(pb::mcp_tool_result_content_item::Content::Text(
            pb::McpTextContent {
                text,
                output_location: None,
            },
        )),
    }
}

pub(super) fn is_mcp_notice(item: &pb::McpToolResultContentItem) -> bool {
    matches!(
        item.content.as_ref(),
        Some(pb::mcp_tool_result_content_item::Content::Text(text))
            if text.text.starts_with("[truncated:")
    )
}

fn structured_json_len(value: &Option<prost_types::Struct>) -> usize {
    value
        .as_ref()
        .and_then(|value| {
            serde_json::to_vec(&serde_json::Value::Object(
                value
                    .fields
                    .iter()
                    .map(|(key, value)| (key.clone(), super::super::prost_json(value)))
                    .collect(),
            ))
            .ok()
        })
        .map_or(0, |value| value.len())
}

fn truncated_struct(original: usize, limit: usize) -> Option<prost_types::Struct> {
    Some(prost_types::Struct {
        fields: BTreeMap::from([
            ("_truncated".into(), prost_bool(true)),
            ("original_json_bytes".into(), prost_number(original as f64)),
            ("limit_bytes".into(), prost_number(limit as f64)),
        ]),
    })
}

fn prost_bool(value: bool) -> prost_types::Value {
    prost_types::Value {
        kind: Some(prost_types::value::Kind::BoolValue(value)),
    }
}

fn prost_number(value: f64) -> prost_types::Value {
    prost_types::Value {
        kind: Some(prost_types::value::Kind::NumberValue(value)),
    }
}

pub(super) fn gate_mcp_resources(tool: &mut pb::ListMcpResourcesToolCall) {
    let Some(pb::list_mcp_resources_exec_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    if success
        .resources
        .iter()
        .any(|resource| resource.uri == "truncated:list-mcp-resources")
    {
        return;
    }
    let original = success.resources.len();
    success.resources.truncate(MCP_RESOURCE_LIMIT);
    for resource in &mut success.resources {
        if let Some(description) = resource.description.as_mut() {
            *description = truncate_text(
                "MCP resource description",
                description,
                MCP_RESOURCE_DESCRIPTION_LIMIT,
            );
        }
    }
    if success.resources.len() < original {
        success
            .resources
            .push(pb::list_mcp_resources_exec_result::McpResource {
                uri: "truncated:list-mcp-resources".into(),
                name: Some("truncated".into()),
                description: Some(truncation_notice(
                    "ListMcpResources",
                    MCP_TEXT_LIMIT,
                    success.resources.len(),
                    original,
                )),
                ..Default::default()
            });
    }
}

pub(super) fn gate_mcp_resource(tool: &mut pb::ReadMcpResourceToolCall) {
    let Some(pb::read_mcp_resource_exec_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    match success.content.as_mut() {
        Some(pb::read_mcp_resource_success::Content::Text(text)) => {
            *text = truncate_text("FetchMcpResource", text, MCP_TEXT_LIMIT);
        }
        Some(pb::read_mcp_resource_success::Content::Blob(blob))
            if blob.len() > MCP_BINARY_LIMIT =>
        {
            let notice =
                truncation_notice("FetchMcpResource blob", MCP_BINARY_LIMIT, 0, blob.len());
            success.content = Some(pb::read_mcp_resource_success::Content::Text(notice));
        }
        _ => {}
    }
}

pub(super) fn gate_mcp_tools(tool: &mut pb::GetMcpToolsToolCall) {
    let Some(pb::get_mcp_tools_agent_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    success.content = truncate_text("GetMcpTools", &success.content, MCP_TEXT_LIMIT);
}

pub(super) fn gate_web_fetch(tool: &mut pb::WebFetchToolCall) {
    let Some(pb::web_fetch_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    success.markdown = truncate_text("WebFetch", &success.markdown, WEB_FETCH_LIMIT);
}

pub(super) fn gate_web_search(tool: &mut pb::WebSearchToolCall) {
    let Some(pb::web_search_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    for reference in &mut success.references {
        reference.title =
            truncate_text("WebSearch title", &reference.title, WEB_SEARCH_TITLE_LIMIT);
        reference.chunk = truncate_text(
            "WebSearch snippet",
            &reference.chunk,
            WEB_SEARCH_SNIPPET_LIMIT,
        );
    }
    let original = web_search_bytes(&success.references);
    while success.references.len() > 1 && web_search_bytes(&success.references) > WEB_SEARCH_LIMIT {
        success.references.pop();
    }
    if original > WEB_SEARCH_LIMIT {
        let total = web_search_bytes(&success.references);
        if let Some(reference) = success.references.last_mut() {
            let other = total.saturating_sub(reference.chunk.len());
            let notice = truncation_notice(
                "WebSearch",
                WEB_SEARCH_LIMIT,
                WEB_SEARCH_LIMIT.saturating_sub(other),
                original,
            );
            let available = WEB_SEARCH_LIMIT.saturating_sub(other + notice.len() + 2);
            reference.chunk = format!(
                "{}\n\n{notice}",
                utf8_prefix(&reference.chunk, available).trim_end_matches('\n')
            );
        }
    }
}

fn web_search_bytes(references: &[pb::WebSearchReference]) -> usize {
    references
        .iter()
        .map(|reference| reference.title.len() + reference.url.len() + reference.chunk.len())
        .sum()
}
