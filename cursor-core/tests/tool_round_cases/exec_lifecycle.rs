use cursor_server::cursor::{
    protocol::proto::agent::v1 as pb,
    tools::{codec, runtime::CursorToolRuntime},
};
use serde_json::json;

use crate::{call, exec_context};

#[tokio::test]
async fn shell_uses_background_timeout_and_preserves_stream_identity() {
    let mut shell = call("call-shell", "Shell");
    shell.arguments = json!({
        "command": "python3 -m http.server 8000",
        "working_directory": "/tmp/project",
        "block_until_ms": 3000,
        "description": "Start HTTP server"
    });
    let context = exec_context();
    let request = codec::request(7, &shell, &context).unwrap();
    let Some(pb::agent_server_message::Message::ExecServerMessage(request)) = request.message
    else {
        panic!("expected ExecServerMessage")
    };
    assert_eq!(request.accept_hook_additional_contexts, Some(true));
    let Some(pb::exec_server_message::Message::ShellStreamArgs(args)) = request.message else {
        panic!("expected ShellArgs")
    };
    assert_eq!(args.timeout, 3000);
    assert_eq!(
        args.timeout_behavior,
        pb::TimeoutBehavior::Background as i32
    );
    assert_eq!(args.hard_timeout, Some(86_400_000));
    assert_eq!(args.description.as_deref(), Some("Start HTTP server"));
    assert!(args.close_stdin);
    assert_eq!(args.conversation_id.as_deref(), Some("conversation"));
    assert_eq!(args.file_output_threshold_bytes, Some(40_000));
    assert_eq!(args.simple_commands, ["python3 -m http.server 8000"]);
    let parsing = args.parsing_result.as_ref().unwrap();
    assert!(!parsing.parsing_failed);
    assert_eq!(parsing.executable_commands.len(), 1);
    let executable = &parsing.executable_commands[0];
    assert_eq!(executable.name, "python3");
    assert_eq!(executable.full_text, "python3 -m http.server 8000");
    assert_eq!(
        executable
            .args
            .iter()
            .map(|argument| (argument.r#type.as_str(), argument.value.as_str()))
            .collect::<Vec<_>>(),
        [("word", "-m"), ("word", "http.server"), ("word", "8000")]
    );

    let rendered = cursor_server::cursor::tools::codec::render_tool_call(&shell, false).unwrap();
    let Some(pb::tool_call::Tool::ShellToolCall(rendered)) = rendered.tool else {
        panic!("expected rendered ShellToolCall")
    };
    assert_eq!(rendered.description.as_deref(), Some("Start HTTP server"));
    assert_eq!(
        rendered.args.and_then(|args| args.description),
        Some("Start HTTP server".into())
    );

    let pending = CursorToolRuntime::default();
    let id = pending.reserve_exec(&shell, &context).await.unwrap();
    let delta = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: Some(pb::exec_client_message::Message::ShellStream(
                pb::ShellStream {
                    event: Some(pb::shell_stream::Event::Stdout(pb::ShellStreamStdout {
                        data: "Serving HTTP on port 8000\n".into(),
                    })),
                },
            )),
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Delta(delta) = delta else {
        panic!("expected Shell stdout delta")
    };
    let Some(pb::agent_server_message::Message::InteractionUpdate(delta)) = delta.message else {
        panic!("expected InteractionUpdate")
    };
    let Some(pb::interaction_update::Message::ToolCallDelta(delta)) = delta.message else {
        panic!("expected ToolCallDelta")
    };
    assert_eq!(delta.call_id, "call-shell");
    assert_eq!(delta.model_call_id, "model:0");
    let Some(pb::tool_call_delta::Delta::ShellToolCallDelta(shell_delta)) =
        delta.tool_call_delta.and_then(|delta| delta.delta)
    else {
        panic!("expected ShellToolCallDelta")
    };
    let Some(pb::shell_tool_call_delta::Delta::Stdout(stdout)) = shell_delta.delta else {
        panic!("expected stdout")
    };
    assert_eq!(stdout.content, "Serving HTTP on port 8000\n");

    let completion = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: Some(pb::exec_client_message::Message::ShellStream(
                pb::ShellStream {
                    event: Some(pb::shell_stream::Event::Backgrounded(
                        pb::ShellStreamBackgrounded {
                            shell_id: 42,
                            command: "python3 -m http.server 8000".into(),
                            working_directory: "/tmp/project".into(),
                            pid: Some(1234),
                            ms_to_wait: Some(3000),
                            reason: Some(pb::ShellBackgroundReason::Timeout as i32),
                        },
                    )),
                },
            )),
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Completed(completion) = completion else {
        panic!("expected background completion")
    };
    assert_eq!(
        completion.result().content,
        (
            "shell running in background shell_id=42 pid=1234 terminals_folder=/tmp/terminals\nServing HTTP on port 8000\n"
        )
    );
    let Some(pb::tool_call::Tool::ShellToolCall(tool)) = &completion.tool_call().tool else {
        panic!("expected ShellToolCall")
    };
    let result = tool.result.as_ref().expect("background ShellResult");
    assert_eq!(result.is_background, Some(true));
    assert_eq!(result.terminals_folder.as_deref(), Some("/tmp/terminals"));
    assert_eq!(result.pid, Some(1234));
    assert!(
        pending.drain_running().await.is_empty(),
        "a backgrounded Shell is no longer an abortable Run Exec"
    );
}

#[tokio::test]
async fn exec_ids_are_monotonic_and_released_ids_are_not_reused() {
    let pending = CursorToolRuntime::default();
    let first = pending
        .reserve_exec(&call("call-1", "Read"), &exec_context())
        .await
        .unwrap();
    assert_eq!(first, 1);
    assert_eq!(
        pending.exec_call(first).await.map(|call| call.call_id),
        Some("call-1".into())
    );
    pending.discard_exec(first).await;
    assert!(pending.exec_call(first).await.is_none());

    let second = pending
        .reserve_exec(&call("call-2", "Read"), &exec_context())
        .await
        .unwrap();
    assert_eq!(second, 2, "released Exec ids must not be reused in one Run");

    let interaction = pending
        .reserve_interaction(&call("call-3", "AskQuestion"))
        .await
        .unwrap();
    assert_eq!(
        interaction, 3,
        "Exec and Interaction share one wire-id space"
    );
}

#[tokio::test]
async fn empty_exec_client_message_is_not_a_terminal_result() {
    let pending = CursorToolRuntime::default();
    let id = pending
        .reserve_exec(&call("call-1", "Read"), &exec_context())
        .await
        .unwrap();
    let event = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: None,
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    assert!(matches!(event, codec::ClientExecEvent::Pending));
    assert_eq!(
        pending.exec_call(id).await.map(|call| call.call_id),
        Some("call-1".into())
    );
}

#[tokio::test]
async fn exec_stream_close_without_a_terminal_result_becomes_a_tool_error() {
    let pending = CursorToolRuntime::default();
    let mut shell = call("call-1", "Shell");
    shell.arguments = json!({"command": "git status"});
    let id = pending.reserve_exec(&shell, &exec_context()).await.unwrap();

    let completion = codec::stream_closed(id, &pending)
        .await
        .unwrap()
        .expect("a running Exec should complete when its stream closes");

    assert_eq!(completion.result().call_id, "call-1");
    assert!(completion.result().is_error);
    assert_eq!(
        completion.result().content,
        "Cursor Exec stream closed before returning a terminal result"
    );
    let Some(pb::tool_call::Tool::ShellToolCall(shell)) = &completion.tool_call().tool else {
        panic!("expected typed Shell completion")
    };
    assert!(matches!(
        shell.result.as_ref().and_then(|result| result.result.as_ref()),
        Some(pb::shell_result::Result::SpawnError(error))
            if error.error == "Cursor Exec stream closed before returning a terminal result"
    ));
    assert!(pending.exec_call(id).await.is_none());
    assert!(codec::stream_closed(id, &pending).await.unwrap().is_none());
}

#[tokio::test]
async fn tool_success_is_not_inferred_from_debug_text() {
    let pending = CursorToolRuntime::default();
    let mut write = call("call-1", "Write");
    write.arguments = json!({"path": "/tmp/a", "contents": "x"});
    let id = pending.reserve_exec(&write, &exec_context()).await.unwrap();
    let event = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: Some(pb::exec_client_message::Message::WriteResult(
                pb::WriteResult {
                    result: Some(pb::write_result::Result::Success(pb::WriteSuccess {
                        path: "/tmp/a".into(),
                        file_content_after_write: Some("enum Error { Example }".into()),
                        ..Default::default()
                    })),
                },
            )),
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Completed(completion) = event else {
        panic!("expected terminal write result")
    };
    assert!(!completion.result().is_error);
    assert!(matches!(
        completion.tool_call().tool,
        Some(pb::tool_call::Tool::EditToolCall(_))
    ));
}

#[tokio::test]
async fn new_task_result_exposes_the_subagent_name_and_id_to_the_model() {
    let pending = CursorToolRuntime::default();
    let mut task = call("call-task", "Task");
    task.arguments = json!({
        "description": "Analyze game logic",
        "prompt": "Inspect the game",
        "run_in_background": true,
        "subagent_type": "generalPurpose"
    });
    let id = pending.reserve_exec(&task, &exec_context()).await.unwrap();
    let event = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: Some(pb::exec_client_message::Message::SubagentResult(
                pb::SubagentResult {
                    result: Some(pb::subagent_result::Result::Success(pb::SubagentSuccess {
                        agent_id: "child-id".into(),
                        ..Default::default()
                    })),
                },
            )),
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Completed(completion) = event else {
        panic!("expected terminal Task result")
    };

    assert_eq!(
        completion.result().content,
        "Subagent name: Analyze game logic\nSubagent ID: child-id"
    );
    let Some(pb::tool_call::Tool::TaskToolCall(tool)) = &completion.tool_call().tool else {
        panic!("expected TaskToolCall")
    };
    let Some(pb::task_result::Result::Success(success)) = tool
        .result
        .as_ref()
        .and_then(|result| result.result.as_ref())
    else {
        panic!("expected typed Task success")
    };
    assert_eq!(success.agent_id.as_deref(), Some("child-id"));
}

#[tokio::test]
async fn an_exec_result_must_match_the_reserved_tool() {
    let pending = CursorToolRuntime::default();
    let id = pending
        .reserve_exec(&call("call-1", "Read"), &exec_context())
        .await
        .unwrap();
    let result = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: Some(pb::exec_client_message::Message::WriteResult(
                pb::WriteResult {
                    result: Some(pb::write_result::Result::Success(pb::WriteSuccess {
                        path: "/tmp/a".into(),
                        ..Default::default()
                    })),
                },
            )),
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Completed(completion) = result else {
        panic!("mismatched result must complete as a tool error")
    };
    assert!(completion.result().is_error);
    assert!(completion
        .result()
        .content
        .contains("unexpected Exec result for tool Read"));
    assert!(pending.exec_call(id).await.is_none());
    assert_eq!(pending.completed_call(id).await.as_deref(), Some("call-1"));
    let duplicate = codec::client_event(
        &pb::ExecClientMessage {
            id,
            message: None,
            ..Default::default()
        },
        &pending,
    )
    .await
    .unwrap();
    assert!(matches!(duplicate, codec::ClientExecEvent::Pending));
}

#[tokio::test]
async fn unknown_exec_id_is_ignored() {
    let result = codec::client_event(
        &pb::ExecClientMessage {
            id: 999,
            message: Some(pb::exec_client_message::Message::ReadResult(
                pb::ReadResult::default(),
            )),
            ..Default::default()
        },
        &CursorToolRuntime::default(),
    )
    .await
    .unwrap();
    assert!(matches!(result, codec::ClientExecEvent::Pending));
}

