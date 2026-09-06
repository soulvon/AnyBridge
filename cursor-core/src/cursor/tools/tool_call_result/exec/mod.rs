//! Coordinates command execution Tool results.
mod output;
mod render;

use crate::{
    cursor::{protocol::proto::agent::v1 as pb, tools::codec as interaction},
    model::ToolResult,
    Error, Result,
};

use super::{gate, mcp_state, ReadImage, ToolCompletion};
use crate::cursor::tools::{
    edit,
    runtime::{ExecStage, PendingExec},
};

pub(crate) fn from_exec(
    pending: PendingExec,
    wire_result: &pb::exec_client_message::Message,
) -> Result<ToolCompletion> {
    use pb::{exec_client_message::Message, tool_call::Tool};
    let mut gated_shell = matches!(
        wire_result,
        Message::ShellResult(_) | Message::MiniSweAgentBashResult(_)
    )
    .then(|| wire_result.clone());
    if let Some(message) = gated_shell.as_mut() {
        gate::exec_message(message);
    }
    let wire_result = gated_shell.as_ref().unwrap_or(wire_result);
    if let Message::McpStateExecResult(result) = wire_result {
        return mcp_state::complete(pending, result);
    }
    let call = &pending.call;
    let read_image = read_image(wire_result);
    let (mut content, is_error) = output::output(wire_result, call)?;
    if let Some(image) = &read_image {
        content = format!("Read image file: {}", image.path);
    }
    let mut rendered = match &pending.stage {
        ExecStage::DynamicMcp(definition) => {
            interaction::render_dynamic_mcp(call, definition, false)
        }
        _ => interaction::render_tool_call(call, false)?,
    };
    match (rendered.tool.as_mut(), wire_result) {
        (Some(Tool::ShellToolCall(tool)), Message::ShellResult(result))
        | (Some(Tool::ShellToolCall(tool)), Message::MiniSweAgentBashResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::DeleteToolCall(tool)), Message::DeleteResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::GrepToolCall(tool)), Message::GrepResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::GlobToolCall(tool)), Message::GrepResult(result)) => {
            tool.result = Some(render::glob(result)?);
        }
        (Some(Tool::ReadToolCall(tool)), Message::ReadResult(result))
        | (Some(Tool::ReadToolCall(tool)), Message::RedactedReadResult(result)) => {
            tool.result = Some(render::read(result, call)?);
        }
        (Some(Tool::ReadLintsToolCall(tool)), Message::DiagnosticsResult(result)) => {
            tool.result = Some(render::diagnostics(result)?);
        }
        (Some(Tool::McpToolCall(tool)), Message::McpResult(result)) => {
            tool.result = Some(render::mcp(result)?);
        }
        (Some(Tool::ReadMcpResourceToolCall(tool)), Message::ReadMcpResourceExecResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::TaskToolCall(tool)), Message::SubagentResult(result)) => {
            tool.result = Some(render::task(result, call, pending.started_at_ms)?);
        }
        (Some(Tool::EditToolCall(tool)), Message::WriteResult(result)) => {
            tool.result = Some(match (&pending.stage, result.result.as_ref()) {
                (ExecStage::EditWrite(write), Some(pb::write_result::Result::Success(success))) => {
                    edit::success(success.path.clone(), write)
                }
                _ => render::write(result)?,
            });
        }
        _ => {
            return Err(Error::Protocol(format!(
                "unexpected Exec result for tool {}",
                call.name
            )));
        }
    }
    let tool = rendered.tool.ok_or_else(|| {
        Error::Protocol(format!("tool {} has no Cursor representation", call.name))
    })?;
    Ok(ToolCompletion::new(
        call,
        pending.started_at_ms,
        ToolResult {
            call_id: call.call_id.clone(),
            content,
            is_error,
            image: None,
        },
        tool,
    )
    .with_read_image(read_image))
}

fn read_image(message: &pb::exec_client_message::Message) -> Option<ReadImage> {
    use pb::{exec_client_message::Message, read_result::Result, read_success::Output};
    let result = match message {
        Message::ReadResult(result) | Message::RedactedReadResult(result) => result,
        _ => return None,
    };
    let Result::Success(success) = result.result.as_ref()? else {
        return None;
    };
    let Output::Data(data) = success.output.as_ref()? else {
        return None;
    };
    Some(ReadImage {
        mime_type: image_mime_type(data)?.into(),
        data: data.clone(),
        path: success.path.clone(),
    })
}

fn image_mime_type(data: &[u8]) -> Option<&'static str> {
    let reader = image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    match format {
        image::ImageFormat::Png => Some("image/png"),
        image::ImageFormat::Jpeg => Some("image/jpeg"),
        image::ImageFormat::Gif => Some("image/gif"),
        image::ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

pub(crate) fn edit_failure(pending: PendingExec, error: String) -> Result<ToolCompletion> {
    let call = &pending.call;
    let mut rendered = interaction::render_tool_call(call, false)?;
    let Some(pb::tool_call::Tool::EditToolCall(mut tool)) = rendered.tool.take() else {
        return Err(Error::Protocol(format!(
            "{} is not an edit tool",
            call.name
        )));
    };
    tool.result = Some(edit::failure(edit::path(call)?, error.clone()));
    Ok(ToolCompletion::new(
        call,
        pending.started_at_ms,
        ToolResult {
            call_id: call.call_id.clone(),
            content: error,
            is_error: true,
            image: None,
        },
        pb::tool_call::Tool::EditToolCall(tool),
    ))
}
