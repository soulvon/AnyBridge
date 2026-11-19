use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{connect, proto::agent::v1 as pb},
    cursor::{TransportCommand, TransportRegistry},
};
use prost::Message;

use crate::{
    acknowledge_kv, assert_transport_remains_open, client_run_for, fake_provider, fixtures,
    runtime_user_message, text_response, tool_response, wait_for_turn_ended,
};

#[tokio::test]
async fn queued_user_message_after_turn_ended_starts_the_next_turn() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(text_response("first turn"));
    provider.push(text_response("queued turn"));
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
    let handle = registry.get_or_create("queued-after-turn").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "queued-after-turn",
                "queued-after-turn-conversation",
            )),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    wait_for_turn_ended(&handle, &mut output, &mut append_seqno).await;
    assert_transport_remains_open(&handle, &mut output, &mut append_seqno).await;

    cursor_server::api::cursor::bidi::append(
        &registry,
        cursor_server::api::cursor::bidi::DecodedAppend {
            request_id: "queued-after-turn".into(),
            seqno: append_seqno,
            message: runtime_user_message(),
        },
        None,
    )
    .await
    .unwrap();
    append_seqno += 1;

    let mut text = String::new();
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("queued turn closed without EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::InteractionUpdate(update)) = server.message {
            if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                text.push_str(&delta.text);
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }

    assert!(text.contains("queued turn"));
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        &requests[1].history[..requests[0].history.len()],
        requests[0].history.as_slice(),
        "queued continuation must preserve the first provider request as a prefix"
    );
    let history = serde_json::to_string(&requests[1].history).unwrap();
    assert!(history.contains("queued follow-up"));
}

#[tokio::test]
async fn runtime_user_message_action_interrupts_and_continues_with_new_message() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push_pending();
    provider.push(text_response("continued after user interruption"));
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
        .get_or_create("user-message-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "user-message-request",
                "user-message-conversation",
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
            let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
            if flags & connect::END_STREAM_FLAG != 0 {
                panic!("initial run ended: {}", String::from_utf8_lossy(&payload));
            }
            acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        }
    }
    handle
        .command(TransportCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_user_message()),
        })
        .await
        .unwrap();

    let mut saw_continued = false;
    let mut append_seqno = append_seqno + 1;
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
                saw_continued |= delta.text.contains("continued after user interruption");
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }
    assert!(saw_continued);
    assert_eq!(provider.requests().len(), 2);
    let history = serde_json::to_string(&provider.requests()[1].history).unwrap();
    assert!(history.contains("queued follow-up"));
}

#[tokio::test]
async fn runtime_user_message_reports_delivered_and_appended() {
    // A runtime user message is queued into `pending_injections` under a
    // `user-message:{id}` key, but the commit correlation only handled the
    // `inject-context:` prefix, so the entry was never cleared: the client
    // never saw Delivered/UserMessageAppended and every later tool round was
    // detached (a hang). This asserts the full delivery sequence.
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push_pending();
    provider.push(text_response("continued after user interruption"));
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
        .get_or_create("user-message-events-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "user-message-events-request",
                "user-message-events-conversation",
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
            message: Box::new(runtime_user_message()),
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
                    assert_eq!(update.injection_id, "user-message:queued-user");
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
                    assert_eq!(user.message_id, "queued-user");
                    assert_eq!(user.text, "queued follow-up");
                    protocol_events.push("user_message_appended");
                }
                Some(pb::interaction_update::Message::TextDelta(update))
                    if update.text.contains("continued after user interruption") =>
                {
                    protocol_events.push("continued_output");
                }
                _ => {}
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }

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
async fn tool_call_with_empty_arguments_does_not_fail_the_run() {
    // A tool call that carries no arguments streams no argument text. Parsing it
    // as JSON must yield an empty object (as the model cycle already does), not
    // fail the run with `EOF while parsing a value`.
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(tool_response("call-1", "UpdateCurrentStep", ""));
    provider.push(text_response("done after empty-argument tool"));
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
    let handle = registry.get_or_create("empty-args-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "empty-args-request",
                "empty-args-conversation",
            )),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let mut saw_done = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before successful EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(
                payload.as_ref(),
                b"{}",
                "run failed: {}",
                String::from_utf8_lossy(&payload)
            );
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::InteractionUpdate(update)) = server.message {
            if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                saw_done |= delta.text.contains("done after empty-argument tool");
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }
    assert!(saw_done);
    assert_eq!(provider.requests().len(), 2);
}

