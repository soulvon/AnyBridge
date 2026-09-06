//! Commits runtime messages once and acknowledges their delivery result.

use tokio_util::sync::CancellationToken;

use crate::{
    model::{CanonicalMessage, CheckpointId, PreparedRun},
    store::Store,
};

use super::{
    engine::{client_failure, emit, wait_for_state_ready},
    CommandResult, CommitBarrier, CommitCause, MessageBatch, MessagesCommitted, RunCommand,
    RunEvent, RunFailure, RunOutcome, RunPort,
};

pub(super) async fn append_batches(
    store: &Store,
    prepared: &PreparedRun,
    client: &mut RunPort,
    cancellation: &CancellationToken,
    mut checkpoint: CheckpointId,
    batches: Vec<MessageBatch>,
) -> Result<(CheckpointId, bool), RunOutcome> {
    let mut inserted_any = false;
    for batch in batches {
        let mut batch_inserted = false;
        for message in batch.messages {
            let (next, inserted) =
                append_one(store, prepared, client, cancellation, checkpoint, message).await?;
            checkpoint = next;
            inserted_any |= inserted;
            batch_inserted |= inserted;
        }
        let _ = batch.result.send(if batch_inserted {
            CommandResult::Applied
        } else {
            CommandResult::Duplicate
        });
    }
    Ok((checkpoint, inserted_any))
}

pub(super) fn drain_accepted(client: &mut RunPort) -> Result<Vec<MessageBatch>, RunOutcome> {
    let mut messages = Vec::new();
    loop {
        match client.commands.try_recv() {
            Ok(RunCommand::InsertMessages(batch) | RunCommand::BreakMessages(batch)) => {
                messages.push(batch);
            }
            Ok(RunCommand::Cancel) => return Err(RunOutcome::Cancelled),
            Ok(RunCommand::ToolResult(_)) => {}
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => return Ok(messages),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                return Err(client_failure())
            }
        }
    }
}

async fn append_one(
    store: &Store,
    prepared: &PreparedRun,
    client: &mut RunPort,
    cancellation: &CancellationToken,
    checkpoint: CheckpointId,
    message: CanonicalMessage,
) -> Result<(CheckpointId, bool), RunOutcome> {
    let event_id = message.runtime_event_id.clone().ok_or_else(|| {
        RunOutcome::Failed(RunFailure::Protocol(
            "runtime message has no event identity".into(),
        ))
    })?;
    let (checkpoint, inserted) = store
        .append_message_once(
            &prepared.conversation_id,
            &prepared.run_id,
            checkpoint,
            &message,
        )
        .await
        .map_err(|error| RunOutcome::Failed(error.into()))?;
    if !inserted {
        return Ok((checkpoint, false));
    }
    let (barrier, ready) = CommitBarrier::before_continue();
    emit(
        client,
        RunEvent::MessagesCommitted(MessagesCommitted {
            checkpoint_id: checkpoint,
            tool_round_version: 0,
            cause: CommitCause::RuntimeEvent { event_id },
            barrier,
        }),
    )
    .await
    .map_err(|_| client_failure())?;
    wait_for_state_ready(ready, cancellation).await?;
    Ok((checkpoint, true))
}
