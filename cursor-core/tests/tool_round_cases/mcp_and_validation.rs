use std::collections::{BTreeMap, HashSet};

use cursor_server::{
    cursor::{
        protocol::proto::agent::v1 as pb,
        tools::{codec, runtime::CursorToolRuntime, ClientToolEvent, ToolBatchState, ToolDispatcher},
    },
    model::ToolCall,
    provider::{FinishReason, ModelEvent},
    run::consume_model_cycle,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{call, exec_context, mcp_context};

#[tokio::test]
async fn malformed_provider_tool_json_is_kept_as_a_tool_validation_error() {
    let stream = Box::pin(futures_util::stream::iter(vec![
        Ok(ModelEvent::Start {
            model_call_id: "model-call".into(),
        }),
        Ok(ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call-malformed".into(),
            name: "Read".into(),
        }),
        Ok(ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":".into(),
        }),
        Ok(ModelEvent::ToolCallEnd { index: 0 }),
        Ok(ModelEvent::Done(FinishReason::ToolUse)),
    ]));
    let (events, _receiver) = tokio::sync::mpsc::channel(16);
    let result = consume_model_cycle(stream, &events, &CancellationToken::new())
        .await
        .expect("malformed tool JSON must not fail the model cycle");

    assert_eq!(result.calls.len(), 1);
    assert!(result.calls[0]
        .argument_error
        .as_deref()
        .is_some_and(|message| message.contains("not valid JSON")));
    assert_eq!(result.calls[0].arguments, json!({}));
}

#[test]
fn dynamic_mcp_call_routes_to_the_captured_exec_message() {
    let call = ToolCall {
        index: 0,
        call_id: "mcp-call".into(),
        model_call_id: "model:0".into(),
        name: "mcp_repo_lookup".into(),
        arguments_text: "{\"query\":\"x\"}".into(),
        arguments: json!({"query": "x"}),
        argument_error: None,
    };
    let definition = pb::McpToolDefinition {
        name: "mcp_repo_lookup".into(),
        provider_identifier: "repo".into(),
        tool_name: "lookup".into(),
        description: "lookup".into(),
        input_schema: None,
        input_schema_json: None,
    };
    let message = codec::mcp_request(7, &call, &definition).unwrap();
    let Some(pb::agent_server_message::Message::ExecServerMessage(exec)) = message.message else {
        panic!("expected ExecServerMessage")
    };
    let Some(pb::exec_server_message::Message::McpArgs(args)) = exec.message else {
        panic!("expected McpArgs")
    };
    assert_eq!(exec.exec_id, "mcp-call");
    assert_eq!(args.provider_identifier, "repo");
    assert_eq!(args.tool_name, "lookup");
    assert_eq!(
        args.args["query"].kind,
        Some(prost_types::value::Kind::StringValue("x".into()))
    );
}

#[tokio::test]
async fn dynamic_mcp_uses_one_definition_for_stream_ui_exec_and_result() {
    let definition = pb::McpToolDefinition {
        name: "cursor-ide-browser-browser_navigate".into(),
        provider_identifier: "cursor-ide-browser".into(),
        tool_name: "browser_navigate".into(),
        description: "Navigate the browser".into(),
        ..Default::default()
    };
    let definitions = BTreeMap::from([(definition.name.clone(), definition.clone())]);
    let event = cursor_server::provider::ModelEvent::ToolCallStart {
        index: 0,
        call_id: "browser-call".into(),
        name: definition.name.clone(),
    };
    let partial =
        cursor_server::cursor::protocol::events::response_event(&event, "model:0", &definitions)
            .unwrap()
            .unwrap();
    let Some(pb::agent_server_message::Message::InteractionUpdate(update)) = partial.message else {
        panic!("expected interaction update")
    };
    let Some(pb::interaction_update::Message::PartialToolCall(partial)) = update.message else {
        panic!("expected partial tool call")
    };
    let partial = partial.tool_call.unwrap();
    assert_eq!(partial.started_at_ms, None);
    let Some(pb::tool_call::Tool::McpToolCall(tool)) = partial.tool else {
        panic!("expected MCP placeholder")
    };
    assert_eq!(tool.args.unwrap().tool_name, "browser_navigate");

    let runtime = CursorToolRuntime::default();
    let dispatcher = ToolDispatcher::new(runtime.clone());
    let mut invocation = call("browser-call", &definition.name);
    invocation.arguments = json!({"url": "https://example.com"});
    let dispatched = dispatcher
        .start_batch(
            &[invocation],
            ToolBatchState {
                completed: &HashSet::new(),
                started: &HashSet::new(),
                response_text: "",
                response_thinking: "",
            },
            &[],
            &definitions,
            &exec_context(),
        )
        .await
        .unwrap();
    assert_eq!(dispatched[0].messages.len(), 2);
    let Some(pb::agent_server_message::Message::InteractionUpdate(update)) =
        dispatched[0].messages[0].message.as_ref()
    else {
        panic!("expected tool-start interaction")
    };
    let Some(pb::interaction_update::Message::ToolCallStarted(started)) = update.message.as_ref()
    else {
        panic!("expected tool-start message")
    };
    assert!(started.tool_call.as_ref().unwrap().started_at_ms.is_some());
    let Some(pb::agent_server_message::Message::ExecServerMessage(exec)) =
        dispatched[0].messages[1].message.as_ref()
    else {
        panic!("expected MCP Exec")
    };
    let event = codec::client_event(
        &pb::ExecClientMessage {
            id: exec.id,
            message: Some(pb::exec_client_message::Message::McpResult(pb::McpResult {
                result: Some(pb::mcp_result::Result::Success(pb::McpSuccess {
                    content: vec![pb::McpToolResultContentItem {
                        content: Some(pb::mcp_tool_result_content_item::Content::Text(
                            pb::McpTextContent {
                                text: "navigated".into(),
                                output_location: None,
                            },
                        )),
                    }],
                    is_error: false,
                    structured_content: None,
                })),
            })),
            ..Default::default()
        },
        &runtime,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Completed(completion) = event else {
        panic!("expected completed MCP result")
    };
    let Some(pb::tool_call::Tool::McpToolCall(tool)) = &completion.tool_call().tool else {
        panic!("expected rendered MCP result")
    };
    assert_eq!(tool.args.as_ref().unwrap().name, definition.name);
    assert!(tool.result.is_some());
}

#[tokio::test]
async fn call_mcp_tool_uses_the_request_descriptor_and_returns_client_errors_to_the_model() {
    let runtime = CursorToolRuntime::default();
    let dispatcher = ToolDispatcher::new(runtime.clone());
    let completed = HashSet::new();
    let started = HashSet::new();
    let mut invocation = call("call-mcp", "CallMcpTool");
    invocation.arguments = json!({
        "server": "plugin-browser-use-browser-use",
        "toolName": "browser_exec",
        "description": "run browser code",
        "arguments": {"code": "print('ok')"}
    });
    let requests = dispatcher
        .start_batch(
            &[invocation],
            ToolBatchState {
                completed: &completed,
                started: &started,
                response_text: "",
                response_thinking: "",
            },
            &[],
            &BTreeMap::new(),
            &mcp_context(
                "plugin-browser-use-browser-use",
                "browser-use",
                "browser_exec",
            ),
        )
        .await
        .unwrap();
    let Some(pb::agent_server_message::Message::ExecServerMessage(exec)) =
        requests[0].messages[1].message.as_ref()
    else {
        panic!("expected MCP Exec")
    };
    let Some(pb::exec_server_message::Message::McpArgs(args)) = exec.message.as_ref() else {
        panic!("expected McpArgs")
    };
    assert_eq!(args.name, "plugin-browser-use-browser-use-browser_exec");
    assert_eq!(args.provider_identifier, "browser-use");
    assert_eq!(args.tool_name, "browser_exec");
    assert_eq!(args.server_identifier, "plugin-browser-use-browser-use");
    assert_eq!(
        args.args["code"].kind,
        Some(prost_types::value::Kind::StringValue("print('ok')".into()))
    );

    let event = codec::client_event(
        &pb::ExecClientMessage {
            id: exec.id,
            message: Some(pb::exec_client_message::Message::McpResult(pb::McpResult {
                result: Some(pb::mcp_result::Result::Error(pb::McpError {
                    error: "invalid browser arguments".into(),
                })),
            })),
            ..Default::default()
        },
        &runtime,
    )
    .await
    .unwrap();
    let codec::ClientExecEvent::Completed(completion) = event else {
        panic!("expected MCP completion")
    };
    assert_eq!(completion.result().content, "invalid browser arguments");
    assert!(completion.result().is_error);
}

#[tokio::test]
async fn mcp_auth_uses_the_cursor_auth_interaction_without_a_tool_definition() {
    let runtime = CursorToolRuntime::default();
    let dispatcher = ToolDispatcher::new(runtime.clone());
    let completed = HashSet::new();
    let started = HashSet::new();
    let mut auth = call("auth-gmail", "CallMcpTool");
    auth.arguments = json!({
        "server": "plugin-gmail-gmail",
        "toolName": "mcp_auth",
        "arguments": {}
    });
    let request = dispatcher
        .start_batch(
            &[auth],
            ToolBatchState {
                completed: &completed,
                started: &started,
                response_text: "",
                response_thinking: "",
            },
            &[],
            &BTreeMap::new(),
            &exec_context(),
        )
        .await
        .unwrap();
    let Some(pb::agent_server_message::Message::InteractionQuery(query)) =
        request[0].messages[1].message.as_ref()
    else {
        panic!("expected MCP auth interaction")
    };
    let Some(pb::interaction_query::Query::McpAuthRequestQuery(auth)) = query.query.as_ref() else {
        panic!("expected MCP auth query")
    };
    let args = auth.args.as_ref().unwrap();
    assert_eq!(args.server_identifier, "plugin-gmail-gmail");
    assert_eq!(args.tool_call_id, "auth-gmail");

    let event = dispatcher
        .interaction_response(&pb::InteractionResponse {
            id: query.id,
            result: Some(pb::interaction_response::Result::McpAuthRequestResponse(
                pb::McpAuthRequestResponse {
                    result: Some(pb::mcp_auth_request_response::Result::Approved(
                        pb::mcp_auth_request_response::Approved {},
                    )),
                },
            )),
        })
        .await
        .unwrap();
    let ClientToolEvent::Completed(completion) = event else {
        panic!("expected MCP auth completion")
    };
    let Some(pb::tool_call::Tool::McpAuthToolCall(auth)) = &completion.tool_call().tool else {
        panic!("expected MCP auth tool call")
    };
    assert!(matches!(
        auth.result.as_ref().and_then(|result| result.result.as_ref()),
        Some(pb::mcp_auth_result::Result::Success(success))
            if success.server_identifier == "plugin-gmail-gmail"
    ));
}

#[tokio::test]
async fn unknown_mcp_descriptor_returns_a_tool_error_without_client_discovery() {
    let dispatcher = ToolDispatcher::new(CursorToolRuntime::default());
    let completed = HashSet::new();
    let started = HashSet::new();
    let mut invocation = call("call-fast-context", "CallMcpTool");
    invocation.arguments = json!({
        "server": "fast-context",
        "toolName": "fast_context_search",
        "arguments": {"query": "MCP dispatch"}
    });
    let dispatched = dispatcher
        .start_batch(
            &[invocation],
            ToolBatchState {
                completed: &completed,
                started: &started,
                response_text: "",
                response_thinking: "",
            },
            &[],
            &BTreeMap::new(),
            &exec_context(),
        )
        .await
        .unwrap();
    assert_eq!(dispatched[0].messages.len(), 1);
    let completion = dispatched[0]
        .completion
        .as_ref()
        .expect("missing descriptor should complete as a tool error");
    assert!(completion.result().is_error);
    assert!(completion.result().content.contains("descriptor not found"));
}

#[tokio::test]
async fn invalid_tool_arguments_complete_as_tool_errors() {
    let dispatcher = ToolDispatcher::new(CursorToolRuntime::default());
    let completed = HashSet::new();
    let started = HashSet::new();
    let state = || ToolBatchState {
        completed: &completed,
        started: &started,
        response_text: "",
        response_thinking: "",
    };

    let mut malformed = call("call-malformed", "Read");
    malformed.argument_error = Some("Read arguments are not valid JSON".into());
    let mut missing = call("call-missing", "Shell");
    missing.arguments = json!({"description": "missing command"});
    let mut wrong_type = call("call-type", "Shell");
    wrong_type.arguments = json!({"command": 42});
    let mut invalid_timeout = call("call-timeout", "Shell");
    invalid_timeout.arguments = json!({"command": "pwd", "block_until_ms": -1});

    for (invocation, expected) in [
        (malformed, "not valid JSON"),
        (missing, "missing command"),
        (wrong_type, "missing command"),
        (invalid_timeout, "out of range"),
    ] {
        let dispatched = dispatcher
            .start_batch(
                &[invocation],
                state(),
                &[],
                &BTreeMap::new(),
                &exec_context(),
            )
            .await
            .unwrap();
        let completion = dispatched[0]
            .completion
            .as_ref()
            .expect("invalid arguments must complete as a tool error");
        assert!(completion.result().is_error);
        assert!(completion.result().content.contains(expected));
    }
}

