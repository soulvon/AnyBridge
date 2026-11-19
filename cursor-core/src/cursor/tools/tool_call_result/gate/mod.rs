//! Correlates Tool completion events and gates final result delivery.
use crate::{cursor::protocol::proto::agent::v1 as pb, model::limit_tool_result_text};


mod mcp_and_web;
mod truncate;
#[cfg(test)]
mod tests;

use mcp_and_web::{
    gate_mcp, gate_mcp_resource, gate_mcp_resources, gate_mcp_tools, gate_web_fetch,
    gate_web_search,
};
use truncate::{truncate_edges, truncate_text, truncation_notice};

pub(super) const KIB: usize = 1024;
const READ_CONTENT_LIMIT: usize = 64 * KIB;
const READ_BINARY_LIMIT: usize = 32 * KIB;
const SHELL_STREAM_LIMIT: usize = 16 * KIB;
const SHELL_INTERLEAVED_LIMIT: usize = 32 * KIB;
const GREP_CONTENT_LIMIT: usize = 32 * KIB;
const GREP_MATCH_LIMIT: usize = 2 * KIB;
const GREP_MATCHES_PER_FILE: usize = 100;
const GREP_TOTAL_MATCHES: usize = 300;
const GREP_LIST_LIMIT: usize = 300;
const GLOB_FILE_LIMIT: usize = 200;
const EDIT_RESULT_LIMIT: usize = 32 * KIB;
const PATCH_EDIT_RESULT_LIMIT: usize = 4 * KIB;

pub(super) fn tool_completion(
    tool_name: &str,
    tool: &mut pb::tool_call::Tool,
    content: &mut String,
) {
    use pb::tool_call::Tool;

    match tool {
        Tool::ShellToolCall(tool) => gate_shell(tool),
        Tool::GrepToolCall(tool) => gate_grep(tool),
        Tool::GlobToolCall(tool) => gate_glob(tool),
        Tool::ReadToolCall(tool) => gate_read(tool),
        Tool::EditToolCall(tool) => gate_edit(tool_name, tool),
        Tool::McpToolCall(tool) => gate_mcp(tool),
        Tool::ListMcpResourcesToolCall(tool) => gate_mcp_resources(tool),
        Tool::ReadMcpResourceToolCall(tool) => gate_mcp_resource(tool),
        Tool::GetMcpToolsToolCall(tool) => gate_mcp_tools(tool),
        Tool::WebFetchToolCall(tool) => gate_web_fetch(tool),
        Tool::WebSearchToolCall(tool) => gate_web_search(tool),
        Tool::GenerateImageToolCall(tool) => gate_generate_image(tool),
        _ => {}
    }
    *content = limit_tool_result_text(tool_name, content);
}

pub(super) fn exec_message(message: &mut pb::exec_client_message::Message) {
    use pb::exec_client_message::Message;
    match message {
        Message::ShellResult(result) | Message::MiniSweAgentBashResult(result) => {
            gate_shell_result(result)
        }
        _ => {}
    }
}

fn gate_shell(tool: &mut pb::ShellToolCall) {
    if let Some(result) = tool.result.as_mut() {
        gate_shell_result(result);
    }
}

fn gate_shell_result(result: &mut pb::ShellResult) {
    use pb::shell_result::Result;
    match result.result.as_mut() {
        Some(Result::Success(success)) => {
            success.stdout = truncate_edges("Shell stdout", &success.stdout, SHELL_STREAM_LIMIT);
            success.stderr = truncate_edges("Shell stderr", &success.stderr, SHELL_STREAM_LIMIT);
            if let Some(interleaved) = success.interleaved_output.as_mut() {
                *interleaved = truncate_edges(
                    "Shell interleaved output",
                    interleaved,
                    SHELL_INTERLEAVED_LIMIT,
                );
            }
        }
        Some(Result::Failure(failure)) => {
            failure.stdout = truncate_edges("Shell stdout", &failure.stdout, SHELL_STREAM_LIMIT);
            failure.stderr = truncate_edges("Shell stderr", &failure.stderr, SHELL_STREAM_LIMIT);
            if let Some(interleaved) = failure.interleaved_output.as_mut() {
                *interleaved = truncate_edges(
                    "Shell interleaved output",
                    interleaved,
                    SHELL_INTERLEAVED_LIMIT,
                );
            }
        }
        _ => {}
    }
}

fn gate_read(tool: &mut pb::ReadToolCall) {
    let Some(pb::read_tool_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    let Some(output) = success.output.as_mut() else {
        return;
    };
    match output {
        pb::read_tool_success::Output::Content(value) => {
            let next = truncate_text("Read", value, READ_CONTENT_LIMIT);
            if next != *value {
                *value = next;
                success.exceeded_limit = true;
            }
        }
        pb::read_tool_success::Output::Data(value) if value.len() > READ_BINARY_LIMIT => {
            let notice = truncation_notice("Read binary data", READ_BINARY_LIMIT, 0, value.len());
            success.output = Some(pb::read_tool_success::Output::Content(notice));
            success.exceeded_limit = true;
        }
        _ => {}
    }
}

fn gate_glob(tool: &mut pb::GlobToolCall) {
    let Some(pb::glob_tool_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    let original = success.files.len();
    if original <= GLOB_FILE_LIMIT {
        if success.total_files <= 0 {
            success.total_files = original as i32;
        }
        return;
    }
    success.files.truncate(GLOB_FILE_LIMIT);
    success.total_files = success.total_files.max(original as i32);
    success.client_truncated = true;
}

fn gate_grep(tool: &mut pb::GrepToolCall) {
    let Some(pb::grep_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    let mut budget = GrepBudget {
        content_bytes: GREP_CONTENT_LIMIT,
        matches: GREP_TOTAL_MATCHES,
    };
    let mut workspace_names = success
        .workspace_results
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    workspace_names.sort_unstable();
    for name in workspace_names {
        if let Some(result) = success.workspace_results.get_mut(&name) {
            gate_grep_union(result, &mut budget);
        }
    }
    if let Some(result) = success.active_editor_result.as_mut() {
        gate_grep_union(result, &mut budget);
    }
}

struct GrepBudget {
    content_bytes: usize,
    matches: usize,
}

fn gate_grep_union(result: &mut pb::GrepUnionResult, budget: &mut GrepBudget) {
    use pb::grep_union_result::Result;
    match result.result.as_mut() {
        Some(Result::Content(content)) => gate_grep_content(content, budget),
        Some(Result::Files(files)) => {
            let original = files.files.len();
            if original > GREP_LIST_LIMIT {
                files.files.truncate(GREP_LIST_LIMIT);
                files.client_truncated = true;
            }
            if files.total_files <= 0 {
                files.total_files = original as i32;
            }
        }
        Some(Result::Count(counts)) => {
            let original = counts.counts.len();
            if original > GREP_LIST_LIMIT {
                counts.counts.truncate(GREP_LIST_LIMIT);
                counts.client_truncated = true;
            }
            if counts.total_files <= 0 {
                counts.total_files = original as i32;
            }
        }
        None => {}
    }
}

fn gate_grep_content(content: &mut pb::GrepContentResult, budget: &mut GrepBudget) {
    if content
        .matches
        .iter()
        .flat_map(|file| &file.matches)
        .any(is_grep_notice)
    {
        return;
    }
    let original_bytes = grep_content_bytes(&content.matches);
    let original_files = content.matches.len();
    let mut truncated = false;
    let mut files = Vec::with_capacity(original_files);

    for file in &content.matches {
        if budget.matches == 0 || budget.content_bytes == 0 {
            truncated = true;
            break;
        }
        let mut next = pb::GrepFileMatch {
            file: file.file.clone(),
            matches: Vec::new(),
        };
        for matched in &file.matches {
            if is_grep_notice(matched) {
                next.matches.push(matched.clone());
                continue;
            }
            if next.matches.len() >= GREP_MATCHES_PER_FILE
                || budget.matches == 0
                || budget.content_bytes == 0
            {
                truncated = true;
                break;
            }
            let mut next_match = matched.clone();
            let original = next_match.content.clone();
            next_match.content = truncate_text("Grep match", &original, GREP_MATCH_LIMIT);
            if next_match.content != original {
                next_match.content_truncated = true;
                truncated = true;
            }
            if next_match.content.len() > budget.content_bytes {
                next_match.content =
                    truncate_text("Grep", &next_match.content, budget.content_bytes);
                next_match.content_truncated = true;
                truncated = true;
            }
            if next_match.content.trim().is_empty() {
                truncated = true;
                break;
            }
            budget.content_bytes = budget
                .content_bytes
                .saturating_sub(next_match.content.len());
            budget.matches -= 1;
            next.matches.push(next_match);
        }
        if next.matches.len() < file.matches.len() {
            truncated = true;
        }
        if !next.matches.is_empty() {
            files.push(next);
        }
    }
    if files.len() < original_files {
        truncated = true;
    }
    if truncated {
        content.client_truncated = true;
        add_grep_notice(&mut files, original_bytes);
    }
    content.matches = files;
}

fn add_grep_notice(files: &mut Vec<pb::GrepFileMatch>, original_bytes: usize) {
    if files
        .iter()
        .flat_map(|file| &file.matches)
        .any(is_grep_notice)
    {
        return;
    }
    loop {
        let used = grep_content_bytes(files);
        let notice = truncation_notice("Grep", GREP_CONTENT_LIMIT, used, original_bytes);
        if used.saturating_add(notice.len()) <= GREP_CONTENT_LIMIT {
            let matched = pb::GrepContentMatch {
                line_number: 0,
                content: notice,
                content_truncated: true,
                is_context_line: true,
            };
            if let Some(file) = files.last_mut() {
                file.matches.push(matched);
            } else {
                files.push(pb::GrepFileMatch {
                    file: "[truncated]".into(),
                    matches: vec![matched],
                });
            }
            return;
        }
        let Some(file) = files.last_mut() else {
            return;
        };
        file.matches.pop();
        if file.matches.is_empty() {
            files.pop();
        }
    }
}

fn is_grep_notice(matched: &pb::GrepContentMatch) -> bool {
    matched.line_number == 0
        && matched.content_truncated
        && matched
            .content
            .starts_with("[truncated: Grep result exceeded")
}

fn grep_content_bytes(files: &[pb::GrepFileMatch]) -> usize {
    files
        .iter()
        .flat_map(|file| &file.matches)
        .map(|matched| matched.content.len())
        .sum()
}

fn gate_edit(tool_name: &str, tool: &mut pb::EditToolCall) {
    let Some(pb::edit_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    let limit = match tool_name.trim() {
        "PatchEdit" | "PatchEditLines" | "PatchEditSpan" | "StrReplace" => PATCH_EDIT_RESULT_LIMIT,
        _ => EDIT_RESULT_LIMIT,
    };
    if let Some(diff) = success.diff_string.as_mut() {
        *diff = truncate_text(tool_name, diff, limit);
        success.before_full_file_content = None;
        success.after_full_file_content.clear();
    } else {
        success.before_full_file_content = None;
        success.after_full_file_content =
            truncate_text(tool_name, &success.after_full_file_content, limit);
    }
}

fn gate_generate_image(tool: &mut pb::GenerateImageToolCall) {
    let Some(pb::generate_image_result::Result::Success(success)) = tool
        .result
        .as_mut()
        .and_then(|result| result.result.as_mut())
    else {
        return;
    };
    if !success.image_data.trim().is_empty()
        && !success
            .image_data
            .starts_with("[base64 image data omitted from replay; bytes=")
    {
        let original = success.image_data.trim().len();
        success.image_data = format!("[base64 image data omitted from replay; bytes={original}]");
    }
}
