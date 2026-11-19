//! Owns the current Run and coordinates the Conversation lifecycle.
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cursor::{
        compile,
        protocol::proto::agent::v1 as pb,
        services::{blob_sync::BlobSynchronizer, context_sync::RequestContextSynchronizer},
        tools::{
            codec, runtime::CursorToolRuntime, tool_call_result::ToolResultSender, ToolDispatcher,
        },
        transport::{OrderedInbox, TransportHandle},
    },
    run::{RunHandle, RunPhase},
};

use super::{ConversationRegistry, RunFinish, TransportCommand, TransportFinish};


mod actions;
mod lifecycle;
#[cfg(test)]
mod tests;

use actions::{handle_appended_messages, AppendContext, AppendOutcome};
use lifecycle::finish_pending;

pub struct ConversationRuntime;

const CONTINUATION_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone)]
pub(super) struct RunGeneration {
    pub(super) id: u64,
    pub(super) request: pb::AgentRunRequest,
    pub(super) superseded: CancellationToken,
    pub(super) finished: CancellationToken,
    pub(super) run: Arc<parking_lot::Mutex<Option<RunHandle>>>,
    pub(super) results: ToolResultSender,
    pub(super) runtime_actions: mpsc::UnboundedSender<compile::RuntimeAction>,
    pub(super) tool_runtime: CursorToolRuntime,
    pub(super) tools: ToolDispatcher,
}

pub(super) struct FinishGeneration(pub(super) CancellationToken);

struct TransportActorGuard(TransportHandle);

impl Drop for TransportActorGuard {
    fn drop(&mut self) {
        self.0.close_transport();
    }
}

impl Drop for FinishGeneration {
    fn drop(&mut self) {
        self.0.cancel();
    }
}


impl ConversationRuntime {
    pub(crate) fn spawn(
        registry: ConversationRegistry,
        handle: TransportHandle,
        mut receiver: mpsc::Receiver<TransportCommand>,
    ) {
        tokio::spawn(async move {
            let _actor_guard = TransportActorGuard(handle.clone());
            let dependencies = registry.dependencies().clone();
            let blob_sync = BlobSynchronizer::new(
                handle.request_id().into(),
                dependencies.store.clone(),
                handle.clone(),
            );
            let mut inbox = OrderedInbox::starting_at(0);
            let tool_runtime_factory = CursorToolRuntime::default();
            let context_sync =
                RequestContextSynchronizer::new(handle.clone(), dependencies.store.clone());
            let mut current = None::<RunGeneration>;
            let mut next_generation = 1_u64;
            let mut pending_finish = None::<(u64, TransportFinish)>;
            let mut draining = false;
            let mut waiting_for_action = false;
            loop {
                let command = if draining {
                    if !handle.admissions_drained() {
                        tokio::select! {
                            command = receiver.recv() => match command {
                                Some(command) => command,
                                None => {
                                    finish_pending(
                                        &registry,
                                        &handle,
                                        &current,
                                        pending_finish.take(),
                                    )
                                    .await;
                                    break;
                                }
                            },
                            _ = handle.wait_admissions_drained() => continue,
                        }
                    } else {
                        handle.mark_draining();
                        match receiver.try_recv() {
                            Ok(command) => command,
                            Err(mpsc::error::TryRecvError::Empty)
                            | Err(mpsc::error::TryRecvError::Disconnected) => {
                                finish_pending(
                                    &registry,
                                    &handle,
                                    &current,
                                    pending_finish.take(),
                                )
                                .await;
                                break;
                            }
                        }
                    }
                } else if waiting_for_action {
                    tokio::select! {
                        command = receiver.recv() => match command {
                            Some(command) => command,
                            None => {
                                handle.mark_disconnected();
                                super::finish_success(&handle);
                                break;
                            }
                        },
                        _ = tokio::time::sleep(CONTINUATION_IDLE_TIMEOUT) => {
                            let Some(generation) = current.as_ref() else {
                                super::finish_success(&handle);
                                break;
                            };
                            handle.begin_close();
                            pending_finish = Some((generation.id, TransportFinish::Success));
                            draining = true;
                            waiting_for_action = false;
                            continue;
                        }
                    }
                } else {
                    match receiver.recv().await {
                        Some(command) => command,
                        None => {
                            handle.mark_disconnected();
                            if let Some(generation) = current.as_ref() {
                                generation.superseded.cancel();
                                if let Some(run) = generation.run.lock().clone() {
                                    run.cancel();
                                }
                            }
                            super::finish_cancelled(&handle).ok();
                            break;
                        }
                    }
                };
                match command {
                    TransportCommand::Disconnect => {
                        handle.mark_disconnected();
                        if let Some(generation) = current.as_ref() {
                            generation.superseded.cancel();
                            if let Some(run) = generation.run.lock().clone() {
                                run.cancel();
                            }
                            for id in generation.tool_runtime.drain_running().await {
                                let _ = handle.emit(&codec::abort(id));
                            }
                        }
                        let turn_completed = waiting_for_action
                            || current.as_ref().is_some_and(|generation| {
                                generation
                                    .run
                                    .lock()
                                    .as_ref()
                                    .is_none_or(|run| run.phase() != RunPhase::Running)
                            });
                        if turn_completed {
                            super::finish_success(&handle);
                        } else {
                            super::finish_cancelled(&handle).ok();
                        }
                        break;
                    }
                    TransportCommand::RunFinished { generation, finish } => {
                        if current
                            .as_ref()
                            .is_none_or(|current| current.id != generation)
                        {
                            continue;
                        }
                        match finish {
                            RunFinish::TurnCompleted => {
                                pending_finish = None;
                                draining = false;
                                waiting_for_action = true;
                            }
                            RunFinish::Transport(finish) => {
                                waiting_for_action = false;
                                handle.begin_close();
                                pending_finish = Some((generation, finish));
                                draining = true;
                            }
                        }
                    }
                    TransportCommand::Append { seqno, message } => {
                        let outcome = handle_appended_messages(
                            seqno,
                            *message,
                            AppendContext {
                                registry: &registry,
                                handle: &handle,
                                dependencies: &dependencies,
                                blob_sync: &blob_sync,
                                context_sync: &context_sync,
                                tool_runtime_factory: &tool_runtime_factory,
                                inbox: &mut inbox,
                                current: &mut current,
                                next_generation: &mut next_generation,
                                pending_finish: &mut pending_finish,
                                draining: &mut draining,
                                waiting_for_action: &mut waiting_for_action,
                            },
                        )
                        .await;
                        if matches!(outcome, AppendOutcome::TerminateTask) {
                            return;
                        }
                    }
                }
            }
        });
    }
}
