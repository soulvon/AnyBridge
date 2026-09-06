//! Decodes Tool execution responses received from Cursor.
use crate::{
    cursor::{
        protocol::{events, proto::agent::v1 as pb},
        tools::{
            compat, edit,
            runtime::{CursorToolRuntime, ExecStage, PendingExec},
            tool_call_result::{self as result, ToolCompletion},
        },
    },
    model::ToolCall,
    Error, Result,
};

use super::request::edit_write_request;

pub enum ClientExecEvent {
    Delta(Box<pb::AgentServerMessage>),
    Message(Box<pb::AgentServerMessage>),
    Completed(Box<ToolCompletion>),
    Pending,
}

pub async fn client_event(
    message: &pb::ExecClientMessage,
    pending: &CursorToolRuntime,
) -> Result<ClientExecEvent> {
    if pending.is_interrupted(message.id).await {
        if message.message.as_ref().is_some_and(is_terminal) {
            pending.discard_exec(message.id).await;
        }
        return Ok(ClientExecEvent::Pending);
    }
    let call = match pending.exec_call(message.id).await {
        Some(call) => call,
        None if pending.completed_call(message.id).await.is_some() => {
            tracing::warn!(id = message.id, "ignoring duplicate terminal tool response");
            return Ok(ClientExecEvent::Pending);
        }
        None => {
            tracing::warn!(
                id = message.id,
                "ignoring response for unknown tool execution"
            );
            return Ok(ClientExecEvent::Pending);
        }
    };
    let Some(wire_result) = &message.message else {
        return Ok(ClientExecEvent::Pending);
    };
    let pb::exec_client_message::Message::ShellStream(stream) = wire_result else {
        let entry = take(message.id, pending).await?;
        return match entry.stage {
            ExecStage::EditRead => advance_edit(entry, wire_result, pending).await,
            ExecStage::Direct | ExecStage::DynamicMcp(_) | ExecStage::EditWrite(_) => {
                completed(entry, wire_result.clone())
            }
        };
    };
    use pb::shell_stream::Event;
    let event = match &stream.event {
        Some(Event::Stdout(stdout)) => {
            if pending.append_stdout(message.id, &stdout.data).await {
                ClientExecEvent::Delta(Box::new(shell_delta(&call, true, &stdout.data)))
            } else {
                ClientExecEvent::Pending
            }
        }
        Some(Event::Stderr(stderr)) => {
            if pending.append_stderr(message.id, &stderr.data).await {
                ClientExecEvent::Delta(Box::new(shell_delta(&call, false, &stderr.data)))
            } else {
                ClientExecEvent::Pending
            }
        }
        Some(Event::Start(_)) | Some(Event::HookContext(_)) => ClientExecEvent::Pending,
        Some(Event::Exit(exit)) => {
            let entry = take(message.id, pending).await?;
            let result = shell_exit_result(message, exit, &entry.stdout, &entry.stderr);
            completed(entry, pb::exec_client_message::Message::ShellResult(result))?
        }
        Some(Event::Backgrounded(backgrounded)) => {
            let entry = take(message.id, pending).await?;
            let result = shell_backgrounded_result(
                backgrounded,
                &entry.stdout,
                &entry.stderr,
                &entry.context.terminals_folder,
            );
            completed(entry, pb::exec_client_message::Message::ShellResult(result))?
        }
        Some(Event::Rejected(value)) => {
            let result = pb::ShellResult {
                result: Some(pb::shell_result::Result::Rejected(value.clone())),
                ..Default::default()
            };
            complete(
                message.id,
                pending,
                pb::exec_client_message::Message::ShellResult(result),
            )
            .await?
        }
        Some(Event::PermissionDenied(value)) => {
            let result = pb::ShellResult {
                result: Some(pb::shell_result::Result::PermissionDenied(value.clone())),
                ..Default::default()
            };
            complete(
                message.id,
                pending,
                pb::exec_client_message::Message::ShellResult(result),
            )
            .await?
        }
        Some(Event::SandboxUnsupported(value)) => {
            let result = pb::ShellResult {
                result: Some(pb::shell_result::Result::SpawnError(pb::ShellSpawnError {
                    command: value.command.clone(),
                    working_directory: value.working_directory.clone(),
                    error: value.reason.clone(),
                })),
                ..Default::default()
            };
            complete(
                message.id,
                pending,
                pb::exec_client_message::Message::ShellResult(result),
            )
            .await?
        }
        None => ClientExecEvent::Pending,
    };
    Ok(event)
}

pub async fn stream_closed(id: u32, pending: &CursorToolRuntime) -> Result<Option<ToolCompletion>> {
    if pending.is_interrupted(id).await {
        pending.discard_exec(id).await;
        return Ok(None);
    }
    let Some(entry) = pending.take_exec(id).await else {
        return Ok(None);
    };
    let error = "Cursor Exec stream closed before returning a terminal result";
    if entry.call.name.eq_ignore_ascii_case("Shell") || entry.call.name.eq_ignore_ascii_case("Bash")
    {
        let command = entry
            .call
            .arguments
            .get("command")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let working_directory = entry
            .call
            .arguments
            .get("working_directory")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        return Ok(Some(result::from_exec(
            entry,
            &pb::exec_client_message::Message::ShellResult(pb::ShellResult {
                result: Some(pb::shell_result::Result::SpawnError(pb::ShellSpawnError {
                    command,
                    working_directory,
                    error: error.into(),
                })),
                ..Default::default()
            }),
        )?));
    }
    let rendered = match &entry.stage {
        ExecStage::DynamicMcp(definition) => {
            Ok(super::render_dynamic_mcp(&entry.call, definition, false))
        }
        _ => super::render_tool_call(&entry.call, false),
    };
    let rendered = match rendered {
        Ok(rendered) => rendered,
        Err(Error::Protocol(message)) => {
            return Ok(Some(compat::failure_with_message(&entry.call, message)));
        }
        Err(Error::Json(error)) => {
            return Ok(Some(compat::failure_with_message(
                &entry.call,
                error.to_string(),
            )));
        }
        Err(error) => return Err(error),
    };
    Ok(Some(ToolCompletion::from_rendered(
        &entry.call,
        entry.started_at_ms,
        error.into(),
        true,
        rendered,
    )?))
}

fn is_terminal(message: &pb::exec_client_message::Message) -> bool {
    use pb::{exec_client_message::Message, shell_stream::Event};

    match message {
        Message::ShellStream(stream) => matches!(
            stream.event.as_ref(),
            Some(Event::Exit(_))
                | Some(Event::Backgrounded(_))
                | Some(Event::Rejected(_))
                | Some(Event::PermissionDenied(_))
                | Some(Event::SandboxUnsupported(_))
        ),
        _ => true,
    }
}

async fn advance_edit(
    entry: PendingExec,
    result: &pb::exec_client_message::Message,
    registry: &CursorToolRuntime,
) -> Result<ClientExecEvent> {
    let read = match result {
        pb::exec_client_message::Message::ReadResult(result)
        | pb::exec_client_message::Message::RedactedReadResult(result) => result,
        _ => {
            let message = format!("expected ReadResult for edit tool {}", entry.call.name);
            return Ok(ClientExecEvent::Completed(Box::new(
                compat::failure_with_message(&entry.call, message),
            )));
        }
    };
    let write = match edit::after_read(&entry.call, read) {
        Ok(write) => write,
        Err(error) => {
            return Ok(ClientExecEvent::Completed(Box::new(result::edit_failure(
                entry, error,
            )?)))
        }
    };
    let id = registry
        .reserve_edit_write(
            &entry.call,
            &entry.context,
            write.clone(),
            entry.started_at_ms,
        )
        .await?;
    Ok(ClientExecEvent::Message(Box::new(edit_write_request(
        id,
        &entry.call,
        &write,
    )?)))
}

async fn complete(
    id: u32,
    pending: &CursorToolRuntime,
    result: pb::exec_client_message::Message,
) -> Result<ClientExecEvent> {
    completed(take(id, pending).await?, result)
}

async fn take(id: u32, pending: &CursorToolRuntime) -> Result<PendingExec> {
    pending
        .take_exec(id)
        .await
        .ok_or_else(|| Error::Protocol(format!("unknown terminal Exec id: {id}")))
}

fn completed(
    pending: PendingExec,
    result: pb::exec_client_message::Message,
) -> Result<ClientExecEvent> {
    let call = pending.call.clone();
    let completion = match result::from_exec(pending, &result) {
        Ok(completion) => completion,
        Err(Error::Protocol(message)) => compat::failure_with_message(&call, message),
        Err(Error::Json(error)) => compat::failure_with_message(&call, error.to_string()),
        Err(error) => return Err(error),
    };
    Ok(ClientExecEvent::Completed(Box::new(completion)))
}

fn shell_exit_result(
    message: &pb::ExecClientMessage,
    exit: &pb::ShellStreamExit,
    stdout: &str,
    stderr: &str,
) -> pb::ShellResult {
    let result = if exit.code == 0 && !exit.aborted {
        pb::shell_result::Result::Success(pb::ShellSuccess {
            working_directory: exit.cwd.clone(),
            exit_code: exit.code as i32,
            stdout: stdout.into(),
            stderr: stderr.into(),
            interleaved_output: Some(format!("{stdout}{stderr}")),
            local_execution_time_ms: exit
                .local_execution_time_ms
                .or(message.local_execution_time_ms),
            ..Default::default()
        })
    } else {
        pb::shell_result::Result::Failure(pb::ShellFailure {
            working_directory: exit.cwd.clone(),
            exit_code: exit.code as i32,
            stdout: stdout.into(),
            stderr: stderr.into(),
            interleaved_output: Some(format!("{stdout}{stderr}")),
            abort_reason: exit.abort_reason,
            aborted: exit.aborted,
            local_execution_time_ms: exit
                .local_execution_time_ms
                .or(message.local_execution_time_ms),
            ..Default::default()
        })
    };
    pb::ShellResult {
        result: Some(result),
        is_background: Some(false),
        ..Default::default()
    }
}

fn shell_backgrounded_result(
    backgrounded: &pb::ShellStreamBackgrounded,
    stdout: &str,
    stderr: &str,
    terminals_folder: &str,
) -> pb::ShellResult {
    pb::ShellResult {
        result: Some(pb::shell_result::Result::Success(pb::ShellSuccess {
            command: backgrounded.command.clone(),
            working_directory: backgrounded.working_directory.clone(),
            stdout: stdout.into(),
            stderr: stderr.into(),
            shell_id: Some(backgrounded.shell_id),
            pid: backgrounded.pid,
            ms_to_wait: backgrounded.ms_to_wait,
            background_reason: backgrounded.reason,
            interleaved_output: Some(format!("{stdout}{stderr}")),
            ..Default::default()
        })),
        is_background: Some(true),
        terminals_folder: (!terminals_folder.is_empty()).then(|| terminals_folder.into()),
        pid: backgrounded.pid,
        ..Default::default()
    }
}

fn shell_delta(call: &ToolCall, stdout: bool, content: &str) -> pb::AgentServerMessage {
    let delta = if stdout {
        pb::shell_tool_call_delta::Delta::Stdout(pb::ShellToolCallStdoutDelta {
            content: content.into(),
        })
    } else {
        pb::shell_tool_call_delta::Delta::Stderr(pb::ShellToolCallStderrDelta {
            content: content.into(),
        })
    };
    events::server_interaction(pb::interaction_update::Message::ToolCallDelta(Box::new(
        pb::ToolCallDeltaUpdate {
            call_id: call.call_id.clone(),
            tool_call_delta: Some(Box::new(pb::ToolCallDelta {
                delta: Some(pb::tool_call_delta::Delta::ShellToolCallDelta(
                    pb::ShellToolCallDelta { delta: Some(delta) },
                )),
            })),
            model_call_id: call.model_call_id.clone(),
        },
    )))
}
