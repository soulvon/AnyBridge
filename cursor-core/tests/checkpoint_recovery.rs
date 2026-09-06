//! Verifies Conversation recovery and resumable checkpoint state.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{collections::HashSet, sync::Arc};

use cursor_server::{
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::{connect, proto::agent::v1 as pb},
        TransportCommand, TransportRegistry,
    },
    model::ToolRoundId,
    provider::{FinishReason, ModelEvent},
    store::{BlobEdge, BlobId},
};
use prost::Message;

#[tokio::test]
async fn v0_1_5_beta_1_schema_upgrades_to_checkpoints_without_losing_rows() {
    use std::borrow::Cow;

    use sqlx::{
        migrate::Migrator,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };

    static ALL_MIGRATIONS: Migrator = sqlx::migrate!("./migrations");

    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("upgrade.db");
    let database_url = format!("sqlite://{}", database_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    // v0.1.5-beta.1 shipped migrations 0001 through 0004.
    let v0_1_5_beta_1 = Migrator {
        migrations: Cow::Owned(ALL_MIGRATIONS.iter().take(4).cloned().collect()),
        ..Migrator::DEFAULT
    };
    v0_1_5_beta_1.run(&pool).await.unwrap();

    sqlx::query(
        "INSERT INTO conversations(conversation_id, updated_at_ms)
         VALUES ('upgrade-conversation', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_revisions(
            conversation_id, parent_revision_id, state_digest, created_at_ms
         ) VALUES ('upgrade-conversation', NULL, zeroblob(32), 2)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let revision_id: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE conversations SET current_revision_id = ? WHERE conversation_id = 'upgrade-conversation'",
    )
    .bind(revision_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO messages(
            conversation_id, message_id, role, origin, payload_json, created_at_ms
         ) VALUES ('upgrade-conversation', 'message-1', 'user', 'user', '{}', 3)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO revision_messages(revision_id, ordinal, conversation_id, message_id)
         VALUES (?, 0, 'upgrade-conversation', 'message-1')",
    )
    .bind(revision_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runs(
            run_id, conversation_id, base_revision_id, head_revision_id, run_kind, status,
            created_at_ms, updated_at_ms
         ) VALUES ('upgrade-run', 'upgrade-conversation', ?, ?, 'root', 'completed', 4, 4)",
    )
    .bind(revision_id)
    .bind(revision_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tool_rounds(
            round_id, run_id, base_revision_id, assistant_json, status, created_at_ms, updated_at_ms
         ) VALUES ('upgrade-round', 'upgrade-run', ?, '{}', 'settled', 5, 5)",
    )
    .bind(revision_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tool_round_calls(
            round_id, call_index, call_id, model_call_id, name, arguments_json, status,
            committed_revision_id
         ) VALUES ('upgrade-round', 0, 'upgrade-call', 'model-call', 'Read', '{}', 'completed', ?)",
    )
    .bind(revision_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO input_anchors(conversation_id, input_id, base_revision_id, created_at_ms)
         VALUES ('upgrade-conversation', 'input-1', ?, 6)",
    )
    .bind(revision_id)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let upgraded = cursor_server::store::Store::connect(&database_url)
        .await
        .unwrap();
    let current: i64 = sqlx::query_scalar(
        "SELECT current_checkpoint_id FROM conversations
         WHERE conversation_id = 'upgrade-conversation'",
    )
    .fetch_one(upgraded.pool())
    .await
    .unwrap();
    let linked_messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM checkpoint_messages WHERE checkpoint_id = ?")
            .bind(revision_id)
            .fetch_one(upgraded.pool())
            .await
            .unwrap();
    let run_checkpoints: (i64, i64) = sqlx::query_as(
        "SELECT base_checkpoint_id, head_checkpoint_id FROM runs WHERE run_id = 'upgrade-run'",
    )
    .fetch_one(upgraded.pool())
    .await
    .unwrap();
    let round_checkpoint: i64 = sqlx::query_scalar(
        "SELECT base_checkpoint_id FROM tool_rounds WHERE round_id = 'upgrade-round'",
    )
    .fetch_one(upgraded.pool())
    .await
    .unwrap();
    let committed_checkpoint: i64 = sqlx::query_scalar(
        "SELECT committed_checkpoint_id FROM tool_round_calls WHERE call_id = 'upgrade-call'",
    )
    .fetch_one(upgraded.pool())
    .await
    .unwrap();
    let anchor_checkpoint: i64 = sqlx::query_scalar(
        "SELECT base_checkpoint_id FROM input_anchors WHERE input_id = 'input-1'",
    )
    .fetch_one(upgraded.pool())
    .await
    .unwrap();

    assert_eq!(current, revision_id);
    assert_eq!(linked_messages, 1);
    assert_eq!(run_checkpoints, (revision_id, revision_id));
    assert_eq!(round_checkpoint, revision_id);
    assert_eq!(committed_checkpoint, revision_id);
    assert_eq!(anchor_checkpoint, revision_id);
}

#[tokio::test]
async fn checkpoint_dependencies_are_content_addressed_without_a_persistent_stream_outbox() {
    let (_directory, store) = fixtures::temp_store().await;
    let child = store.put_blob(b"message", &[]).await.unwrap();
    let root = store
        .put_blob(
            b"checkpoint",
            &[BlobEdge {
                child: child.clone(),
                field_name: "turns[0]".into(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(root, BlobId::digest(b"checkpoint"));
    assert_eq!(store.get_blob(&child).await.unwrap().unwrap(), b"message");
    let closure = store
        .blob_closure(std::slice::from_ref(&root))
        .await
        .unwrap();
    assert!(closure.contains(&root));
    assert!(closure.contains(&child));

    let outbox: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'outbox'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(outbox, 0);
}

#[tokio::test]
async fn eligible_pending_checkpoint_resumes_tools_before_the_next_model_call() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model-1".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "read-1".into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"/tmp/a\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model-2".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("resumed".into()),
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
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );

    let first = registry.get_or_create("first-run").await.unwrap();
    let mut first_output = first.subscribe();
    first
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(start_request()),
        })
        .await
        .unwrap();
    let mut first_seqno = 1;
    let mut sent_blob_ids = HashSet::new();
    let staged = loop {
        let server = next_message(&mut first_output).await;
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                if let Some(pb::kv_server_message::Message::SetBlobArgs(args)) = &kv.message {
                    sent_blob_ids.insert(args.blob_id.clone());
                }
                acknowledge(&first, &mut first_seqno, kv.id).await;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state))
                if state.pending_tool_calls.len() == 1 =>
            {
                break state;
            }
            _ => {}
        }
    };
    assert!(
        !sent_blob_ids.contains(
            BlobId::digest(&staged.encode_to_vec())
                .as_bytes()
                .as_slice()
        ),
        "ConversationStateStructure is inline and must not be sent as a Blob"
    );
    let staged_started_at_ms =
        serde_json::from_str::<serde_json::Value>(staged.pending_tool_calls.first().unwrap())
            .unwrap()["providerOptions"]["cursor"]["pendingToolCallStartedAtMs"]
            .as_u64()
            .unwrap();
    assert_eq!(provider.requests().len(), 1);
    first.disconnect().await;

    let resumed = registry.get_or_create("resumed-run").await.unwrap();
    let mut resumed_output = resumed.subscribe();
    let mut resumed_checkpoints = Vec::new();
    let mut resumed_set_blob_ids = HashSet::new();
    resumed
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(resume_request(staged.clone())),
        })
        .await
        .unwrap();
    let mut resumed_seqno = 1;
    let exec_id = loop {
        let server = next_message(&mut resumed_output).await;
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                if let Some(pb::kv_server_message::Message::SetBlobArgs(args)) = &kv.message {
                    resumed_set_blob_ids.insert(args.blob_id.clone());
                }
                acknowledge(&resumed, &mut resumed_seqno, kv.id).await;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                resumed_checkpoints.push(state);
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => break exec.id,
            _ => {}
        }
    };
    assert_eq!(
        provider.requests().len(),
        1,
        "resume must execute the pending batch before calling the model"
    );
    let resumed_run_id = store
        .active_run_for_cursor_request("resumed-run")
        .await
        .unwrap()
        .unwrap();
    let resumed_round = store
        .tool_round(&ToolRoundId::new(format!(
            "{}:round:resume",
            resumed_run_id.as_str()
        )))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resumed_round.created_at_ms, staged_started_at_ms);
    resumed
        .command(TransportCommand::Append {
            seqno: resumed_seqno,
            message: Box::new(read_result(exec_id)),
        })
        .await
        .unwrap();
    resumed_seqno += 1;

    let mut saw_settled_barrier_blob = false;
    let mut saw_settled_checkpoint = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), resumed_output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                if let Some(pb::kv_server_message::Message::SetBlobArgs(args)) = &kv.message {
                    resumed_set_blob_ids.insert(args.blob_id.clone());
                }
                if !saw_settled_barrier_blob {
                    assert_eq!(
                        provider.requests().len(),
                        1,
                        "the next model call must wait for the settled Blob barrier"
                    );
                    saw_settled_barrier_blob = true;
                }
                acknowledge(&resumed, &mut resumed_seqno, kv.id).await;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                if state.pending_tool_calls.is_empty() {
                    saw_settled_checkpoint = true;
                }
                resumed_checkpoints.push(state);
            }
            Some(pb::agent_server_message::Message::InteractionUpdate(update))
                if matches!(
                    update.message,
                    Some(pb::interaction_update::Message::TextDelta(_))
                ) =>
            {
                assert!(
                    saw_settled_checkpoint,
                    "the next model round must not become visible before settled checkpoint"
                );
            }
            _ => {}
        }
    }
    assert!(saw_settled_barrier_blob);
    assert!(saw_settled_checkpoint);
    assert!(staged
        .root_prompt_messages_json
        .iter()
        .all(|id| !resumed_set_blob_ids.contains(id)));
    assert_eq!(provider.requests().len(), 2);
    assert!(resumed_checkpoints
        .last()
        .unwrap()
        .read_paths
        .iter()
        .any(|path| path == "/tmp/a"));

    let mut previous_steps = Vec::new();
    let mut saw_completed_read = false;
    for state in resumed_checkpoints {
        let Some(turn_id) = state.turns.last() else {
            continue;
        };
        let turn = pb::ConversationTurnStructure::decode(
            store
                .get_blob(&BlobId::from_bytes(turn_id).unwrap())
                .await
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        let pb::conversation_turn_structure::Turn::AgentConversationTurn(turn) = turn.turn.unwrap()
        else {
            panic!("expected agent turn");
        };
        assert!(turn.steps.len() >= previous_steps.len());
        assert_eq!(
            previous_steps,
            turn.steps[..previous_steps.len()],
            "published Step BlobIDs must be an immutable prefix"
        );
        previous_steps = turn.steps.clone();
        for step_id in &turn.steps {
            let step = pb::ConversationStep::decode(
                store
                    .get_blob(&BlobId::from_bytes(step_id).unwrap())
                    .await
                    .unwrap()
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
            if let Some(pb::conversation_step::Message::ToolCall(call)) = step.message {
                if call.tool_call_id.as_deref() == Some("read-1") {
                    assert!(call.started_at_ms.is_some());
                    assert!(call.completed_at_ms.is_some());
                    saw_completed_read = true;
                }
            }
        }
    }
    assert!(
        saw_completed_read,
        "settled Turn must keep the typed result"
    );
}

#[tokio::test]
async fn recovery_rejects_a_kv_get_payload_whose_hash_does_not_match_the_blob_id() {
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
    let handle = registry.get_or_create("bad-blob-run").await.unwrap();
    let mut output = handle.subscribe();
    let expected = BlobId::digest(b"expected");
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(resume_request(pb::ConversationStateStructure {
                root_prompt_messages_json: vec![expected.as_bytes().to_vec()],
                mode: Some(pb::AgentMode::Agent as i32),
                ..Default::default()
            })),
        })
        .await
        .unwrap();

    let get_id = loop {
        let server = next_message(&mut output).await;
        if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = server.message {
            if matches!(
                kv.message,
                Some(pb::kv_server_message::Message::GetBlobArgs(_))
            ) {
                break kv.id;
            }
        }
    };
    handle
        .command(TransportCommand::Append {
            seqno: 1,
            message: Box::new(pb::AgentClientMessage {
                message: Some(pb::agent_client_message::Message::KvClientMessage(
                    pb::KvClientMessage {
                        id: get_id,
                        message: Some(pb::kv_client_message::Message::GetBlobResult(
                            pb::GetBlobResult {
                                blob_data: Some(b"corrupt".to_vec()),
                                error: None,
                            },
                        )),
                    },
                )),
            }),
        })
        .await
        .unwrap();

    let error = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        }
    };
    assert_eq!(error["error"]["code"], "invalid_argument");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Blob hash mismatch"));
}

fn start_request() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "read".into(),
                                message_id: "user-1".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("conversation".into()),
                run_id: Some("first-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn resume_request(state: pb::ConversationStateStructure) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::ResumeAction(
                        pb::ResumeAction::default(),
                    )),
                    ..Default::default()
                }),
                conversation_state: Some(state),
                conversation_id: Some("conversation".into()),
                run_id: Some("resumed-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn read_result(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientMessage(
            pb::ExecClientMessage {
                id,
                message: Some(pb::exec_client_message::Message::ReadResult(
                    pb::ReadResult {
                        result: Some(pb::read_result::Result::Success(pb::ReadSuccess {
                            path: "/tmp/a".into(),
                            output: Some(pb::read_success::Output::Content("value".into())),
                            ..Default::default()
                        })),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

async fn next_message(
    output: &mut tokio::sync::mpsc::UnboundedReceiver<bytes::Bytes>,
) -> pb::AgentServerMessage {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
        .await
        .unwrap()
        .unwrap();
    let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
    assert_eq!(
        flags & connect::END_STREAM_FLAG,
        0,
        "unexpected EndStream: {}",
        String::from_utf8_lossy(&payload)
    );
    pb::AgentServerMessage::decode(payload).unwrap()
}

async fn acknowledge(handle: &cursor_server::cursor::TransportHandle, seqno: &mut i64, id: u32) {
    handle
        .command(TransportCommand::Append {
            seqno: *seqno,
            message: Box::new(pb::AgentClientMessage {
                message: Some(pb::agent_client_message::Message::KvClientMessage(
                    pb::KvClientMessage {
                        id,
                        message: Some(pb::kv_client_message::Message::SetBlobResult(
                            pb::SetBlobResult { error: None },
                        )),
                    },
                )),
            }),
        })
        .await
        .unwrap();
    *seqno += 1;
}
