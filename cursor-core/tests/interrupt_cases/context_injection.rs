use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportRegistry},
    model::{ModelConfigInput, ModelType, OPENAI_CHAT_ENDPOINT},
    provider::{FinishReason, ModelEvent},
};
use prost::Message;

use crate::{
    acknowledge_kv, client_run_for, client_run_for_model, client_run_for_model_with_state,
    drain_successfully, fake_provider, fixtures, read_success, run_to_end, runtime_injection,
    runtime_injection_for, subagent_success, text_response, tool_response, wait_for_exec,
};

#[tokio::test]
async fn injected_user_context_restarts_only_the_active_model_cycle() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push_pending();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "continued".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("continued after injection".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry.get_or_create("inject-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for("inject-request", "inject-conversation")),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while provider.requests().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "provider did not start"
        );
        if let Ok(Some(frame)) =
            tokio::time::timeout(std::time::Duration::from_millis(20), output.recv()).await
        {
            acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        }
    }
    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_injection()),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let mut protocol_events = Vec::new();
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before successful EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::InteractionUpdate(update)) = server.message {
            match update.message {
                Some(pb::interaction_update::Message::ContextInjectionState(update)) => {
                    assert_eq!(update.injection_id, "injection-1");
                    match update.state.and_then(|state| state.state) {
                        Some(pb::context_injection_state::State::Queued(_)) => {
                            protocol_events.push("queued")
                        }
                        Some(pb::context_injection_state::State::Delivered(delivered)) => {
                            assert!(!delivered.delivery_batch_id.is_empty());
                            assert!(delivered.delivered_at_ms > 0);
                            protocol_events.push("delivered");
                        }
                        _ => {}
                    }
                }
                Some(pb::interaction_update::Message::UserMessageAppended(update)) => {
                    let user = update.user_message.expect("appended user message");
                    assert_eq!(user.message_id, "injected-user");
                    assert_eq!(user.text, "injected follow-up");
                    protocol_events.push("user_message_appended");
                }
                Some(pb::interaction_update::Message::TextDelta(update))
                    if update.text.contains("continued after injection") =>
                {
                    protocol_events.push("continued_output");
                }
                _ => {}
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let continued_history = serde_json::to_string(&requests[1].history).unwrap();
    assert!(continued_history.contains("injected follow-up"));
    assert_eq!(
        protocol_events,
        [
            "queued",
            "delivered",
            "user_message_appended",
            "continued_output"
        ]
    );
}

#[tokio::test]
async fn injected_user_context_aborts_pending_tools_and_ignores_late_results() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(tool_response("call-1", "Read", "{\"path\":\"/tmp/a\"}"));
    let release = provider.push_gated(text_response("continued after tool interruption"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry
        .get_or_create("interrupt-tool-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "interrupt-tool-request",
                "interrupt-tool-conversation",
            )),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let exec_id = wait_for_exec(&handle, &mut output, &mut append_seqno, "Read").await;
    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_injection_for(
                "tool-injection",
                "interrupt-tool-request",
            )),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let mut saw_abort = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while provider.requests().len() < 2 || !saw_abort {
        assert!(
            tokio::time::Instant::now() < deadline,
            "root model did not restart after tool interruption"
        );
        if let Ok(Some(frame)) =
            tokio::time::timeout(std::time::Duration::from_millis(20), output.recv()).await
        {
            let (_, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
            let server = pb::AgentServerMessage::decode(payload).unwrap();
            if let Some(pb::agent_server_message::Message::ExecServerControlMessage(control)) =
                server.message
            {
                if let Some(pb::exec_server_control_message::Message::Abort(abort)) =
                    control.message
                {
                    assert_eq!(abort.id, exec_id);
                    saw_abort = true;
                }
            }
            acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        }
    }

    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(read_success(exec_id)),
        })
        .await
        .unwrap();
    append_seqno += 1;
    release.notify_one();

    drain_successfully(&handle, &mut output, &mut append_seqno).await;

    let requests = provider.requests();
    assert_eq!(
        requests[0].history,
        requests[1].history[..requests[0].history.len()]
    );
    let history = serde_json::to_string(&requests[1].history).unwrap();
    let interrupted = history
        .find("Tool execution was interrupted by a newer user message.")
        .expect("interrupted tool result missing from provider history");
    let injected = history
        .find("injected follow-up")
        .expect("injected message missing from provider history");
    assert!(interrupted < injected);
}

#[tokio::test]
async fn injected_user_context_detaches_subagents_without_cancelling_them() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(tool_response(
        "task-call",
        "Task",
        &serde_json::json!({
            "description": "Inspect protocol",
            "prompt": "Inspect the protocol",
            "subagent_type": "generalPurpose",
            "run_in_background": false
        })
        .to_string(),
    ));
    let release = provider.push_gated(text_response("continued while subagent runs"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry
        .get_or_create("detach-subagent-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "detach-subagent-request",
                "detach-subagent-conversation",
            )),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let exec_id = wait_for_exec(&handle, &mut output, &mut append_seqno, "Task").await;
    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_injection_for(
                "subagent-injection",
                "detach-subagent-request",
            )),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while provider.requests().len() < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "root model did not restart while subagent remained active"
        );
        if let Ok(Some(frame)) =
            tokio::time::timeout(std::time::Duration::from_millis(20), output.recv()).await
        {
            let (_, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
            let server = pb::AgentServerMessage::decode(payload).unwrap();
            if let Some(pb::agent_server_message::Message::ExecServerControlMessage(control)) =
                server.message
            {
                if let Some(pb::exec_server_control_message::Message::Abort(abort)) =
                    control.message
                {
                    assert_ne!(abort.id, exec_id, "Task must not be aborted by injection");
                }
            }
            acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        }
    }

    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(subagent_success(exec_id)),
        })
        .await
        .unwrap();
    append_seqno += 1;
    release.notify_one();

    drain_successfully(&handle, &mut output, &mut append_seqno).await;

    let history = serde_json::to_string(&provider.requests()[1].history).unwrap();
    assert!(history.contains("Tool execution was interrupted by a newer user message."));
    assert!(history.contains("injected follow-up"));
}

#[tokio::test]
async fn injected_user_context_interrupts_automatic_compaction() {
    let (_directory, store) = fixtures::temp_store().await;
    let model = store
        .create_model(&ModelConfigInput {
            sort_order: 0,
            display_name: "Test Model".into(),
            group_name: None,
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "test-key".into(),
            tooltip_data: "Test Model".into(),
            model_id: "test-model".into(),
            reasoning_effort: None,
            openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: Some(100_000),
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        })
        .await
        .unwrap();
    let provider = fake_provider::FakeProvider::default();
    let seed_answer = "x".repeat(400_000);
    provider.push(text_response(&seed_answer));
    provider.push_pending();
    provider.push(text_response("continued after compacting injection"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );

    run_to_end(
        &registry,
        "seed-request",
        client_run_for_model(
            "seed-request",
            "compaction-injection-conversation",
            &model.model_hash,
        ),
    )
    .await;

    let handle = registry
        .get_or_create("inject-during-compaction")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    let mut compacting_request = client_run_for_model_with_state(
        "inject-during-compaction",
        "compaction-injection-conversation",
        &model.model_hash,
        None,
    );
    let Some(pb::agent_client_message::Message::RunRequest(request)) =
        compacting_request.message.as_mut()
    else {
        panic!("expected RunRequest")
    };
    request.requested_model.as_mut().unwrap().parameters.push(
        pb::requested_model::ModelParameterValue {
            id: "context".into(),
            value: "100000".into(),
        },
    );
    let Some(pb::conversation_action::Action::UserMessageAction(action)) = request
        .action
        .as_mut()
        .and_then(|action| action.action.as_mut())
    else {
        panic!("expected UserMessageAction")
    };
    action.user_message.as_mut().unwrap().message_id = "compaction-user".into();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(compacting_request),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while provider.requests().len() < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "automatic compaction did not start"
        );
        if let Ok(Some(frame)) =
            tokio::time::timeout(std::time::Duration::from_millis(20), output.recv()).await
        {
            acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        }
    }
    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_injection_for(
                "compaction-injection",
                "inject-during-compaction",
            )),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let mut saw_continued = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before successful EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::InteractionUpdate(update)) = server.message {
            if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                saw_continued |= delta.text.contains("continued after compacting injection");
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    assert!(
        requests[1]
            .prompt
            .instructions
            .starts_with("Summarize the conversation for the next model turn."),
        "second request was not compaction: instructions={:?}, history={:?}",
        requests[1].prompt.instructions,
        requests[1].history
    );
    assert!(!serde_json::to_string(&requests[1].history)
        .unwrap()
        .contains("injected follow-up"));
    assert!(serde_json::to_string(&requests[2].history)
        .unwrap()
        .contains("injected follow-up"));
    assert!(saw_continued);
}

