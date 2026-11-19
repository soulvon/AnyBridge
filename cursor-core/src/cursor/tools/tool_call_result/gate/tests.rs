use super::*;
use super::mcp_and_web::{is_mcp_notice, MCP_TEXT_LIMIT};
use super::truncate::truncate_text;

fn grep_tool(matches: Vec<String>) -> pb::tool_call::Tool {
    pb::tool_call::Tool::GrepToolCall(pb::GrepToolCall {
        args: None,
        result: Some(pb::GrepResult {
            result: Some(pb::grep_result::Result::Success(pb::GrepSuccess {
                active_editor_result: Some(pb::GrepUnionResult {
                    result: Some(pb::grep_union_result::Result::Content(
                        pb::GrepContentResult {
                            matches: vec![pb::GrepFileMatch {
                                file: "src/lib.rs".into(),
                                matches: matches
                                    .into_iter()
                                    .enumerate()
                                    .map(|(index, content)| pb::GrepContentMatch {
                                        line_number: index as i32 + 1,
                                        content,
                                        ..Default::default()
                                    })
                                    .collect(),
                            }],
                            ..Default::default()
                        },
                    )),
                }),
                ..Default::default()
            })),
        }),
    })
}

fn mcp_tool(texts: Vec<String>) -> pb::McpToolCall {
    pb::McpToolCall {
        args: None,
        result: Some(pb::McpToolResult {
            result: Some(pb::mcp_tool_result::Result::Success(pb::McpSuccess {
                content: texts
                    .into_iter()
                    .map(|text| pb::McpToolResultContentItem {
                        content: Some(pb::mcp_tool_result_content_item::Content::Text(
                            pb::McpTextContent {
                                text,
                                output_location: None,
                            },
                        )),
                    })
                    .collect(),
                is_error: false,
                structured_content: None,
            })),
        }),
        description: None,
    }
}

#[test]
fn truncate_text_never_exceeds_its_limit() {
    let content = "b".repeat(200);
    for limit in 1..=250 {
        let output = truncate_text("Grep", &content, limit);
        assert!(
            output.len() <= limit,
            "limit {limit} produced {} bytes",
            output.len()
        );
    }
}

#[test]
fn truncate_text_terminates_when_the_notice_length_oscillates() {
    // `limit` values where the notice grows and shrinks with the digit count
    // of the reported byte count, so the fixed point is never reached.
    assert!(truncate_text("Grep", &"b".repeat(200), 78).len() <= 78);
    assert!(truncate_text("Grep", &"b".repeat(200), 170).len() <= 170);
    assert!(truncate_text("MCP text", &"b".repeat(500), 82).len() <= 82);
}

#[test]
fn truncate_text_reports_the_actual_utf8_prefix_size() {
    let content = "😀".repeat(1_000);
    let output = truncate_text("Grep", &content, 81);
    let (kept, notice) = output
        .split_once("\n\n[truncated:")
        .expect("the truncation notice fits");
    assert!(
        notice.contains(&format!("showing {} of", kept.len())),
        "notice must report the actual UTF-8 prefix size: {output}"
    );
    assert!(output.len() <= 81);
}

#[test]
fn mcp_total_text_truncation_always_adds_a_notice() {
    let mut tool = mcp_tool(vec!["a".repeat(MCP_TEXT_LIMIT - 8), "b".repeat(100)]);
    gate_mcp(&mut tool);
    let success = match tool.result.unwrap().result.unwrap() {
        pb::mcp_tool_result::Result::Success(success) => success,
        _ => panic!("expected MCP success"),
    };
    assert_eq!(success.content.len(), 3);
    assert!(is_mcp_notice(success.content.last().unwrap()));
}

#[test]
fn grep_content_gate_survives_a_nearly_exhausted_byte_budget() {
    // 16 matches leave 16 bytes of the 32 KiB content budget, which is less
    // than the truncation notice for the 17th match.
    let mut matches = vec!["a".repeat(2047); 16];
    matches.push("b".repeat(100));
    let mut tool = grep_tool(matches);
    let mut content = String::new();
    tool_completion("Grep", &mut tool, &mut content);
}

#[test]
fn grep_content_gate_terminates_on_an_oscillating_remaining_budget() {
    // The same path, tuned so the remaining budget lands on a `limit` where
    // the truncation notice length oscillates.
    let mut matches = vec!["a".repeat(2043); 15];
    matches.push("a".repeat(2045));
    matches.push("b".repeat(200));
    let mut tool = grep_tool(matches);
    let mut content = String::new();
    tool_completion("Grep", &mut tool, &mut content);
}
