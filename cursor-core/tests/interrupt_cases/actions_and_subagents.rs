use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportRegistry},
    provider::{FinishReason, ModelEvent},
};
use prost::Message;

use crate::{
    acknowledge_kv, client_run_for, drain_successfully, fake_provider, fixtures, kv_ack,
    runtime_cancel_subagent, runtime_injection_for, runtime_unsupported_action, subagent_aborted,
    text_response,
};

#[tokio::test]
async fn stale_context_injection_is_rejected_without_failing_the_active_run() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    let release = provider.push_gated(vec![
        ModelEvent::Start {
            model_call_id: "active-cycle".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("active run completed".into()),
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
    let handle = registry.get_or_create("active-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "active-request",
                "stale-injection-conversation",
            )),
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
            message: Box::new(runtime_injection_for("stale-injection", "replaced-request")),
        })
        .await
        .unwrap();
    append_seqno += 1;
    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_injection_for("stale-injection", "replaced-request")),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let mut rejection_count = 0;
    let mut released = false;
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
        let rejected = match server.message {
            Some(pb::agent_server_message::Message::InteractionUpdate(pb::InteractionUpdate {
                message:
                    Some(pb::interaction_update::Message::ContextInjectionState(
                        pb::ContextInjectionStateUpdate {
                            injection_id,
                            state:
                                Some(pb::ContextInjectionState {
                                    state:
                                        Some(pb::context_injection_state::State::Rejected(rejected)),
                                }),
                        },
                    )),
                ..
            })) if injection_id == "stale-injection" => {
                assert_eq!(
                    rejected.reason,
                    "InjectContextAction expected run replaced-request, active run is active-request"
                );
                true
            }
            _ => false,
        };
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        if rejected {
            rejection_count += 1;
            if !released {
                released = true;
                release.notify_one();
            }
        }
    }

    assert!(released, "stale injection was not rejected");
    assert_eq!(rejection_count, 1);
    assert_eq!(provider.requests().len(), 1);
}

#[tokio::test]
async fn unsupported_runtime_action_is_ignored_without_failing_the_active_run() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    let release = provider.push_gated(text_response("active run completed"));
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
        .get_or_create("unsupported-action-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "unsupported-action-request",
                "unsupported-action-conversation",
            )),
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
            message: Box::new(runtime_unsupported_action()),
        })
        .await
        .unwrap();
    append_seqno += 1;
    tokio::task::yield_now().await;
    release.notify_one();

    drain_successfully(&handle, &mut output, &mut append_seqno).await;
    assert_eq!(provider.requests().len(), 1);
}

#[tokio::test]
async fn cancel_subagent_action_aborts_the_target_task_and_keeps_the_parent_running() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "task-cycle".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "task-call".into(),
            name: "Task".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: serde_json::json!({
                "description": "Inspect protocol",
                "prompt": "Inspect the protocol",
                "subagent_type": "generalPurpose",
                "run_in_background": false
            })
            .to_string(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "continued".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("continued after subagent cancellation".into()),
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
    let handle = registry
        .get_or_create("cancel-subagent-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "cancel-subagent-request",
                "cancel-subagent-conversation",
            )),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let exec_id = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Task exec");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(flags & connect::END_STREAM_FLAG, 0);
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
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                let Some(pb::exec_server_message::Message::SubagentArgs(args)) = exec.message
                else {
                    continue;
                };
                assert_eq!(args.tool_call_id, "task-call");
                break exec.id;
            }
            _ => {}
        }
    };

    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_cancel_subagent("task-call")),
        })
        .await
        .unwrap();
    append_seqno += 1;

    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Task abort");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(flags & connect::END_STREAM_FLAG, 0);
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::ExecServerControlMessage(control)) => {
                let Some(pb::exec_server_control_message::Message::Abort(abort)) = control.message
                else {
                    continue;
                };
                assert_eq!(abort.id, exec_id);
                break;
            }
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
            _ => {}
        }
    }

    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(subagent_aborted(exec_id)),
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
            Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                    saw_continued |= delta.text.contains("continued after subagent cancellation");
                }
            }
            _ => {}
        }
    }

    assert!(saw_continued);
    assert_eq!(provider.requests().len(), 2);
}

