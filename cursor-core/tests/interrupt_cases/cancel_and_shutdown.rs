use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportRegistry},
    model::{
        CanonicalMessage, ConversationId, ModelSpec, Origin, PreparedRun, PromptSpec, Role,
        RunAction, RunId, RunKind,
    },
    provider::{FinishReason, ModelEvent},
    run::{self, CommandResult, CommitCause, RunEngine, RunEvent, RunOutcome, RunPhase},
    store::RunStatus,
};
use prost::Message;

use crate::{client_run, fake_provider, fixtures, kv_ack, runtime_cancel_action, text_response};

#[tokio::test]
async fn finalizing_rejects_late_messages_for_the_next_run() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("finalizing-conversation");
    let base_checkpoint_id = store.ensure_conversation(&conversation_id).await.unwrap();
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "final-call".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("done".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let prepared = PreparedRun {
        run_id: RunId::new("finalizing-run"),
        cursor_request_id: None,
        conversation_id,
        kind: RunKind::Root,
        model: ModelSpec::new("model"),
        prompt: PromptSpec {
            instructions: String::new(),
            tools: Vec::new(),
        },
        initial_messages: Vec::new(),
        action: RunAction::Resume {
            pending_tool_round: None,
        },
        base_checkpoint_id,
    };
    let (port, mut session, handle) = run::channel(prepared.run_id.clone(), 32);
    let cancellation = handle.cancellation();
    let task = tokio::spawn(async move {
        RunEngine::new(store, Arc::new(provider))
            .run(prepared, port, cancellation)
            .await
    });

    loop {
        match session.events.recv().await.unwrap() {
            RunEvent::MessagesCommitted(committed) if committed.cause == CommitCause::FinalTurn => {
                assert_eq!(handle.phase(), RunPhase::Finalizing);
                assert_eq!(
                    handle
                        .insert_messages(
                            "late-event".into(),
                            vec![CanonicalMessage::text(
                                "late-message",
                                Role::User,
                                Origin::Runtime,
                                "late",
                            )],
                        )
                        .await,
                    CommandResult::RunClosing
                );
                committed.barrier.complete(Ok(()));
            }
            RunEvent::Ended(outcome) => {
                assert_eq!(outcome, RunOutcome::Completed);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(task.await.unwrap(), RunOutcome::Completed);
}

#[tokio::test]
async fn break_messages_emits_one_cycle_boundary_before_the_runtime_commit() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("cycle-boundary-conversation");
    let base_checkpoint_id = store.ensure_conversation(&conversation_id).await.unwrap();
    let provider = fake_provider::FakeProvider::default();
    provider.push_pending();
    provider.push(text_response("continued"));
    let prepared = PreparedRun {
        run_id: RunId::new("cycle-boundary-run"),
        cursor_request_id: None,
        conversation_id,
        kind: RunKind::Root,
        model: ModelSpec::new("model"),
        prompt: PromptSpec {
            instructions: String::new(),
            tools: Vec::new(),
        },
        initial_messages: Vec::new(),
        action: RunAction::Resume {
            pending_tool_round: None,
        },
        base_checkpoint_id,
    };
    let (port, mut session, handle) = run::channel(prepared.run_id.clone(), 32);
    let cancellation = handle.cancellation();
    let engine_store = store.clone();
    let engine_provider = provider.clone();
    let engine = tokio::spawn(async move {
        RunEngine::new(engine_store, Arc::new(engine_provider))
            .run(prepared, port, cancellation)
            .await
    });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    while provider.requests().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "first model cycle did not start"
        );
        tokio::task::yield_now().await;
    }
    let mut message = CanonicalMessage::text(
        "cycle-boundary-message",
        Role::User,
        Origin::Runtime,
        "new information",
    );
    message.runtime_event_id = Some("cycle-boundary-event".into());
    let command = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .break_messages("cycle-boundary-event".into(), vec![message])
                .await
        }
    });

    let mut lifecycle = Vec::new();
    loop {
        match session.events.recv().await.unwrap() {
            RunEvent::CycleInterrupted => lifecycle.push("interrupted"),
            RunEvent::MessagesCommitted(committed) => {
                if matches!(committed.cause, CommitCause::RuntimeEvent { .. }) {
                    lifecycle.push("runtime-committed");
                }
                committed.barrier.complete(Ok(()));
            }
            RunEvent::Ended(outcome) => {
                assert_eq!(outcome, RunOutcome::Completed);
                break;
            }
            _ => {}
        }
    }

    assert_eq!(lifecycle, ["interrupted", "runtime-committed"]);
    assert_eq!(command.await.unwrap(), CommandResult::Applied);
    assert_eq!(engine.await.unwrap(), RunOutcome::Completed);
}

#[tokio::test]
async fn a_replaced_run_cannot_overwrite_its_cancelled_status() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("conversation");
    let base_checkpoint_id = store.ensure_conversation(&conversation_id).await.unwrap();
    let prepared = |run_id: &str| PreparedRun {
        run_id: RunId::new(run_id),
        cursor_request_id: None,
        conversation_id: conversation_id.clone(),
        kind: RunKind::Root,
        model: ModelSpec::new("model"),
        prompt: PromptSpec {
            instructions: String::new(),
            tools: Vec::new(),
        },
        initial_messages: Vec::new(),
        action: RunAction::Resume {
            pending_tool_round: None,
        },
        base_checkpoint_id,
    };
    let first = prepared("first");
    let second = prepared("second");

    store.claim_run(&first).await.unwrap();
    sqlx::query(
        "INSERT INTO llm_calls(
            call_id, run_id, conversation_id, provider_call_index,
            provider_type, provider_url, request_type, request_url,
            model_id, display_name, status,
            created_at_ms, message_count, tool_count, detailed
         ) VALUES (
            'first:0', 'first', 'conversation', 0,
            'openai-chat', 'https://example.com/v1',
            'openai-chat', 'https://example.com/v1/chat/completions',
            'model', 'Model', 'running',
            unixepoch('subsec') * 1000, 1, 0, 0
         )",
    )
    .execute(store.pool())
    .await
    .unwrap();
    store.claim_run(&second).await.unwrap();
    assert!(!store
        .finish_run(&first.run_id, RunStatus::Completed, None, None,)
        .await
        .unwrap());

    let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE run_id = 'first'")
        .fetch_one(store.pool())
        .await
        .unwrap();
    let active: Option<String> = sqlx::query_scalar(
        "SELECT active_run_id FROM conversations WHERE conversation_id = 'conversation'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(status, "cancelled");
    assert_eq!(active.as_deref(), Some("second"));
    let call: (String, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT status, finished_at_ms, duration_ms FROM llm_calls WHERE call_id = 'first:0'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(call.0, "cancelled");
    assert!(call.1.is_some());
    assert!(call.2.is_some());
}

#[tokio::test]
async fn registry_shutdown_cancels_runs_and_closes_run_sse_outputs() {
    let (_directory, store) = fixtures::temp_store().await;
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(fake_provider::FakeProvider::default()),
        PromptCompiler::new(assets),
    );
    let handle = registry.get_or_create("active-run").await.unwrap();
    let mut output = handle.subscribe();

    registry.shutdown().await;

    let terminal = output.recv().await.expect("canceled EndStream");
    let (flags, payload) = connect::decode_frames(&terminal).unwrap().pop().unwrap();
    assert_eq!(flags, connect::END_STREAM_FLAG);
    let payload: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(payload["error"]["code"], "canceled");
    assert_eq!(output.recv().await, None);
}

#[tokio::test]
async fn client_heartbeat_returns_a_server_protocol_heartbeat() {
    let (_directory, store) = fixtures::temp_store().await;
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(fake_provider::FakeProvider::default()),
        PromptCompiler::new(assets),
    );
    let handle = registry.get_or_create("heartbeat-run").await.unwrap();
    let mut output = handle.subscribe();

    cursor_server::api::cursor::bidi::append(
        &registry,
        cursor_server::api::cursor::bidi::DecodedAppend {
            request_id: "heartbeat-run".into(),
            // A transport heartbeat must not wait for missing application messages.
            seqno: 1,
            message: pb::AgentClientMessage {
                message: Some(pb::agent_client_message::Message::ClientHeartbeat(
                    pb::ClientHeartbeat {},
                )),
            },
        },
        None,
    )
    .await
    .unwrap();

    let frame = tokio::time::timeout(std::time::Duration::from_secs(1), output.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
    let message = pb::AgentServerMessage::decode(payload).unwrap();
    assert!(matches!(
        message.message,
        Some(pb::agent_server_message::Message::InteractionUpdate(
            pb::InteractionUpdate {
                message: Some(pb::interaction_update::Message::Heartbeat(_)),
            }
        ))
    ));

    registry.shutdown().await;
}

#[tokio::test]
async fn runtime_cancel_action_aborts_active_exec_before_canceled_end_stream() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "ignored".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call-1".into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"/tmp/a\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(store, Arc::new(provider), PromptCompiler::new(assets));
    let handle = registry.get_or_create("cancel-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run()),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let exec_id = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(
            flags & connect::END_STREAM_FLAG,
            0,
            "Run ended before Exec: {}",
            String::from_utf8_lossy(&payload)
        );
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => break exec.id,
            _ => {}
        }
    };

    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_cancel_action()),
        })
        .await
        .unwrap();
    let mut saw_abort = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before canceled EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            let json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(json["error"]["code"], "canceled");
            assert!(saw_abort, "ExecServerAbort must precede canceled EndStream");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::ExecServerControlMessage(control)) =
            server.message
        {
            let Some(pb::exec_server_control_message::Message::Abort(abort)) = control.message
            else {
                panic!("expected ExecServerAbort")
            };
            assert_eq!(abort.id, exec_id);
            saw_abort = true;
        }
    }
    assert_eq!(output.recv().await, None);
}

