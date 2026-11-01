//! Renders command execution output for Cursor.
use serde_json::Value;

use crate::{cursor::protocol::proto::agent::v1 as pb, model::ToolCall, Error, Result};

pub(super) fn read(result: &pb::ReadResult, call: &ToolCall) -> Result<pb::ReadToolResult> {
    use pb::{read_result::Result as Input, read_tool_result::Result as Output};
    let result = match result.result.as_ref() {
        Some(Input::Success(success)) => Output::Success(pb::ReadToolSuccess {
            is_empty: match success.output.as_ref() {
                Some(pb::read_success::Output::Content(content)) => content.is_empty(),
                Some(pb::read_success::Output::Data(data)) => data.is_empty(),
                None => true,
            },
            exceeded_limit: success.truncated,
            total_lines: success.total_lines.max(0) as u32,
            file_size: success.file_size.max(0).min(u32::MAX as i64) as u32,
            path: success.path.clone(),
            read_range: read_range(call),
            include_line_numbers: call
                .arguments
                .get("include_line_numbers")
                .and_then(Value::as_bool),
            output: success.output.as_ref().map(|output| match output {
                pb::read_success::Output::Content(content) => {
                    pb::read_tool_success::Output::Content(content.clone())
                }
                pb::read_success::Output::Data(data) => {
                    pb::read_tool_success::Output::Data(data.clone())
                }
            }),
            ..Default::default()
        }),
        Some(Input::Error(value)) => error_read(&value.error),
        Some(Input::Rejected(value)) => error_read(&value.reason),
        Some(Input::FileNotFound(value)) => error_read(&format!("file not found: {}", value.path)),
        Some(Input::PermissionDenied(value)) => {
            error_read(&format!("permission denied: {}", value.path))
        }
        Some(Input::InvalidFile(value)) => error_read(&value.reason),
        None => return Err(missing("read")),
    };
    Ok(pb::ReadToolResult {
        result: Some(result),
    })
}

fn error_read(message: &str) -> pb::read_tool_result::Result {
    pb::read_tool_result::Result::Error(pb::ReadToolError {
        error_message: message.into(),
    })
}

fn read_range(call: &ToolCall) -> Option<pb::ReadRange> {
    let start_line = call
        .arguments
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let limit = call
        .arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as u32)?;
    Some(pb::ReadRange {
        start_line,
        end_line: start_line.saturating_add(limit),
    })
}

pub(super) fn write(result: &pb::WriteResult) -> Result<pb::EditResult> {
    use pb::{edit_result::Result as Output, write_result::Result as Input};
    let result = match result.result.as_ref() {
        Some(Input::Success(success)) => Output::Success(pb::EditSuccess {
            path: success.path.clone(),
            after_full_file_content: success.file_content_after_write.clone().unwrap_or_default(),
            ..Default::default()
        }),
        Some(Input::PermissionDenied(value)) => {
            Output::WritePermissionDenied(pb::EditWritePermissionDenied {
                path: value.path.clone(),
                error: value.error.clone(),
                is_readonly: value.is_readonly,
            })
        }
        Some(Input::NoSpace(value)) => edit_error(&value.path, "no space left"),
        Some(Input::Error(value)) => edit_error(&value.path, &value.error),
        Some(Input::Rejected(value)) => Output::Rejected(pb::EditRejected {
            path: value.path.clone(),
            reason: value.reason.clone(),
        }),
        None => return Err(missing("write")),
    };
    Ok(pb::EditResult {
        result: Some(result),
    })
}

fn edit_error(path: &str, message: &str) -> pb::edit_result::Result {
    pb::edit_result::Result::Error(pb::EditError {
        path: path.into(),
        error: message.into(),
        model_visible_error: Some(message.into()),
    })
}

pub(super) fn diagnostics(result: &pb::DiagnosticsResult) -> Result<pb::ReadLintsToolResult> {
    use pb::{diagnostics_result::Result as Input, read_lints_tool_result::Result as Output};
    let result = match result.result.as_ref() {
        Some(Input::Success(success)) => {
            let diagnostics = success
                .diagnostics
                .iter()
                .map(|diagnostic| pb::DiagnosticItem {
                    severity: diagnostic.severity,
                    range: diagnostic.range.as_ref().map(|range| pb::DiagnosticRange {
                        start: range.start,
                        end: range.end,
                    }),
                    message: diagnostic.message.clone(),
                    source: diagnostic.source.clone(),
                    code: diagnostic.code.clone(),
                    is_stale: diagnostic.is_stale,
                })
                .collect::<Vec<_>>();
            Output::Success(pb::ReadLintsToolSuccess {
                file_diagnostics: vec![pb::FileDiagnostics {
                    path: success.path.clone(),
                    diagnostics_count: diagnostics.len() as i32,
                    diagnostics,
                }],
                total_files: 1,
                total_diagnostics: success.total_diagnostics,
            })
        }
        Some(Input::Error(value)) => lint_error(&value.error),
        Some(Input::Rejected(value)) => lint_error(&value.reason),
        Some(Input::FileNotFound(value)) => lint_error(&format!("file not found: {}", value.path)),
        Some(Input::PermissionDenied(value)) => {
            lint_error(&format!("permission denied: {}", value.path))
        }
        None => return Err(missing("diagnostics")),
    };
    Ok(pb::ReadLintsToolResult {
        result: Some(result),
    })
}

fn lint_error(message: &str) -> pb::read_lints_tool_result::Result {
    pb::read_lints_tool_result::Result::Error(pb::ReadLintsToolError {
        error_message: message.into(),
    })
}

pub(super) fn mcp(result: &pb::McpResult) -> Result<pb::McpToolResult> {
    use pb::{mcp_result::Result as Input, mcp_tool_result::Result as Output};
    let result = match result.result.as_ref() {
        Some(Input::Success(value)) => Output::Success(value.clone()),
        Some(Input::Error(value)) => mcp_error(&value.error),
        Some(Input::Rejected(value)) => Output::Rejected(value.clone()),
        Some(Input::PermissionDenied(value)) => Output::PermissionDenied(value.clone()),
        Some(Input::ToolNotFound(value)) => {
            mcp_error(&format!("MCP tool not found: {}", value.name))
        }
        Some(Input::ServerNotFound(value)) => {
            mcp_error(&format!("MCP server not found: {}", value.name))
        }
        Some(Input::Approved(_)) => {
            return Err(Error::Protocol("MCP approval is not terminal".into()))
        }
        None => return Err(missing("MCP")),
    };
    Ok(pb::McpToolResult {
        result: Some(result),
    })
}

fn mcp_error(message: &str) -> pb::mcp_tool_result::Result {
    pb::mcp_tool_result::Result::Error(pb::McpToolError {
        error: message.into(),
        read_tool_def_reminder: String::new(),
    })
}

pub(super) fn task(
    result: &pb::SubagentResult,
    call: &crate::model::ToolCall,
    started_at_ms: u64,
) -> Result<pb::TaskResult> {
    task_inner(result, call, started_at_ms, false)
}

/// 后台子代理已由客户端结算完成（回传了最终结论）：即使原始 Task 调用带了
/// `run_in_background`，结果也必须标记为「已完成」。否则客户端会一直把它
/// 当后台运行中，父对话停在 Stopped（issue #39）。
pub(super) fn task_finished(
    result: &pb::SubagentResult,
    call: &crate::model::ToolCall,
    started_at_ms: u64,
) -> Result<pb::TaskResult> {
    task_inner(result, call, started_at_ms, true)
}

fn task_inner(
    result: &pb::SubagentResult,
    call: &crate::model::ToolCall,
    started_at_ms: u64,
    finished: bool,
) -> Result<pb::TaskResult> {
    use pb::{subagent_result::Result as Input, task_result::Result as Output};
    let result = match result.result.as_ref() {
        Some(Input::Success(value)) => {
            let is_background = !finished
                && (value.background_reason
                    != pb::SubagentBackgroundReason::Unspecified as i32
                    || call
                        .arguments
                        .get("run_in_background")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true));
            Output::Success(pb::TaskSuccess {
                agent_id: Some(value.agent_id.clone()),
                is_background,
                duration_ms: Some(
                    crate::cursor::tools::runtime::now_ms().saturating_sub(started_at_ms),
                ),
                result_suffix: value.final_message.clone(),
                background_reason: value.background_reason,
                transcript_path: value.transcript_path.clone(),
                ..Default::default()
            })
        }
        Some(Input::Error(value)) => Output::Error(pb::TaskError {
            error: value.error.clone(),
        }),
        None => return Err(missing("subagent")),
    };
    Ok(pb::TaskResult {
        result: Some(result),
    })
}

pub(super) fn glob(result: &pb::GrepResult) -> Result<pb::GlobToolResult> {
    use pb::{glob_tool_result::Result as Output, grep_result::Result as Input};
    let result = match result.result.as_ref() {
        Some(Input::Success(success)) => {
            let files = success
                .active_editor_result
                .iter()
                .chain(success.workspace_results.values())
                .find_map(|result| match result.result.as_ref() {
                    Some(pb::grep_union_result::Result::Files(files)) => Some(files),
                    _ => None,
                });
            Output::Success(pb::GlobToolSuccess {
                pattern: success.pattern.clone(),
                path: success.path.clone(),
                files: files.map(|value| value.files.clone()).unwrap_or_default(),
                total_files: files.map_or(0, |value| value.total_files),
                client_truncated: files.is_some_and(|value| value.client_truncated),
                ripgrep_truncated: files.is_some_and(|value| value.ripgrep_truncated),
            })
        }
        Some(Input::Error(value)) => Output::Error(pb::GlobToolError {
            error: value.error.clone(),
        }),
        None => return Err(missing("glob")),
    };
    Ok(pb::GlobToolResult {
        result: Some(result),
    })
}

fn missing(name: &str) -> Error {
    Error::Protocol(format!("{name} returned no result"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task_call(run_in_background: bool) -> crate::model::ToolCall {
        crate::model::ToolCall {
            index: 0,
            call_id: "call-1".into(),
            model_call_id: "model-call-1".into(),
            name: "Task".into(),
            arguments_text: "{}".into(),
            arguments: json!({
                "run_in_background": run_in_background,
                "model": "some-model",
                "prompt": "do work",
            }),
            argument_error: None,
        }
    }

    fn subagent_result(message: &str) -> pb::SubagentResult {
        pb::SubagentResult {
            result: Some(pb::subagent_result::Result::Success(pb::SubagentSuccess {
                agent_id: "agent-1".into(),
                final_message: Some(message.into()),
                tool_call_count: 0,
                background_reason: pb::SubagentBackgroundReason::Unspecified as i32,
                transcript_path: None,
            })),
        }
    }

    fn is_background(result: &pb::TaskResult) -> bool {
        match result.result.as_ref() {
            Some(pb::task_result::Result::Success(success)) => success.is_background,
            other => panic!("expected task success, got {other:?}"),
        }
    }

    /// 未结算的后台 Task 保持"后台运行中"；客户端回传完成后必须标记为已完成，
    /// 否则父对话会一直停在 Stopped（issue #39）。
    #[test]
    fn settled_task_result_is_not_background() {
        let call = task_call(true);
        let result = subagent_result("子代理完成的结论");

        assert!(
            is_background(&task(&result, &call, 0).unwrap()),
            "未结算时仍是后台运行中"
        );
        assert!(
            !is_background(&task_finished(&result, &call, 0).unwrap()),
            "结算后必须标记完成，且结论要带出来"
        );
        let finished = task_finished(&result, &call, 0).unwrap();
        match finished.result.as_ref() {
            Some(pb::task_result::Result::Success(success)) => {
                assert_eq!(success.result_suffix.as_deref(), Some("子代理完成的结论"));
            }
            other => panic!("expected success, got {other:?}"),
        }
    }

    /// 前台 Task 结算后同样不能带后台标记。
    #[test]
    fn finished_foreground_task_stays_foreground() {
        let call = task_call(false);
        let result = subagent_result("done");
        assert!(!is_background(&task_finished(&result, &call, 0).unwrap()));
    }
}
