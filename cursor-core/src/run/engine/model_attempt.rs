use tokio_util::sync::CancellationToken;

use crate::{
    model::{CheckpointId, ModelRequest, PreparedRun, Usage},
    run::{
        consume_model_cycle, messages,
        model_retry::{should_retry, MAX_MODEL_RETRIES, MODEL_RETRY_DELAY},
        MessageBatch, ModelCycleResult, RunCommand, RunEvent, RunFailure, RunOutcome, RunPort,
    },
    store::ContextUsageAnchor,
};

use super::helpers::{
    accumulate_usage, client_failure, emit, failure_message, update_context_usage_anchor,
};
use super::RunEngine;

pub(super) enum ModelCycleOutcome {
    Completed {
        cycle: ModelCycleResult,
        pending_insertions: Vec<MessageBatch>,
    },
    RestartModel {
        checkpoint: CheckpointId,
    },
}

impl RunEngine {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn execute_model_cycle(
        &self,
        prepared: &PreparedRun,
        mut checkpoint: CheckpointId,
        client: &mut RunPort,
        cancellation: &CancellationToken,
        provider_call_index: u64,
        request: &ModelRequest,
        context_usage_anchor: &mut Option<ContextUsageAnchor>,
        usage: &mut Option<Usage>,
    ) -> std::result::Result<ModelCycleOutcome, (RunOutcome, Option<Usage>)> {
        let mut retries = 0_u32;
        let mut pending_insertions = Vec::new();
        let cycle = 'attempt: loop {
            let call_id = if retries == 0 {
                format!("{}:{provider_call_index}", prepared.run_id)
            } else {
                format!("{}:{provider_call_index}:retry-{retries}", prepared.run_id)
            };
            let invocation = crate::model::ModelInvocation {
                call_id,
                run_id: prepared.run_id.to_string(),
                conversation_id: prepared.conversation_id.to_string(),
                provider_call_index,
                request: request.clone(),
            };
            let cycle_cancellation = cancellation.child_token();
            let cycle_events = client.events.clone();
            let cycle = consume_model_cycle(
                self.provider.stream(invocation, cycle_cancellation.clone()),
                &cycle_events,
                &cycle_cancellation,
            );
            tokio::pin!(cycle);
            let cycle = loop {
                tokio::select! {
                    biased;
                    command = client.commands.recv() => {
                        let interruption = match command {
                            Some(RunCommand::InsertMessages(insertion)) => {
                                pending_insertions.push(insertion);
                                continue;
                            }
                            Some(RunCommand::BreakMessages(messages)) => messages,
                            Some(RunCommand::Cancel) => {
                                cycle_cancellation.cancel();
                                let _ = cycle.await;
                                let _ = emit(client, RunEvent::CycleInterrupted).await;
                                return Err((RunOutcome::Cancelled, usage.clone()));
                            }
                            Some(RunCommand::ToolResult(_)) => {
                                cycle_cancellation.cancel();
                                let _ = cycle.await;
                                let _ = emit(client, RunEvent::CycleInterrupted).await;
                                return Err((RunOutcome::Failed(RunFailure::Protocol(
                                        "received a tool result while the model was running".into(),
                                    )), usage.clone()));
                            }
                            None => {
                                cycle_cancellation.cancel();
                                let _ = cycle.await;
                                let _ = emit(client, RunEvent::CycleInterrupted).await;
                                return Err((client_failure(), usage.clone()));
                            }
                        };
                        cycle_cancellation.cancel();
                        let interrupted = cycle.await;
                        match interrupted {
                            Ok(cycle) => {
                                if let Some(cycle_usage) = cycle.usage {
                                    update_context_usage_anchor(
                                        context_usage_anchor,
                                        cycle_usage,
                                        request.history.len(),
                                    );
                                    accumulate_usage(usage, cycle_usage);
                                }
                            }
                            Err(failure) => {
                                if let Some(cycle_usage) = failure.usage {
                                    update_context_usage_anchor(
                                        context_usage_anchor,
                                        cycle_usage,
                                        request.history.len(),
                                    );
                                    accumulate_usage(usage, cycle_usage);
                                }
                            }
                        }
                        if emit(client, RunEvent::CycleInterrupted).await.is_err() {
                            return Err((client_failure(), usage.clone()));
                        }
                        checkpoint = match messages::append_batches(
                            &self.store,
                            prepared,
                            client,
                            cancellation,
                            checkpoint,
                            std::mem::take(&mut pending_insertions),
                        )
                        .await
                        {
                            Ok((checkpoint, _)) => checkpoint,
                            Err(outcome) => return Err((outcome, usage.clone())),
                        };
                        checkpoint = match messages::append_batches(
                            &self.store,
                            prepared,
                            client,
                            cancellation,
                            checkpoint,
                            vec![interruption],
                        )
                        .await
                        {
                            Ok((checkpoint, _)) => checkpoint,
                            Err(outcome) => return Err((outcome, usage.clone())),
                        };
                        return Ok(ModelCycleOutcome::RestartModel { checkpoint });
                    }
                    result = &mut cycle => break result,
                }
            };
            match cycle {
                Ok(cycle) => break 'attempt cycle,
                Err(cycle_failure) => {
                    if let Some(cycle_usage) = cycle_failure.usage {
                        update_context_usage_anchor(
                            context_usage_anchor,
                            cycle_usage,
                            request.history.len(),
                        );
                        accumulate_usage(usage, cycle_usage);
                    }
                    if cancellation.is_cancelled() {
                        let _ = emit(client, RunEvent::CycleInterrupted).await;
                        return Err((RunOutcome::Cancelled, usage.clone()));
                    }
                    if !should_retry(&cycle_failure, retries) {
                        return Err((RunOutcome::Failed(cycle_failure.failure), usage.clone()));
                    }
                    retries += 1;
                    let message = failure_message(&cycle_failure.failure);
                    tracing::warn!(
                        provider_call_index,
                        retries,
                        max_retries = MAX_MODEL_RETRIES,
                        delay_ms = MODEL_RETRY_DELAY.as_millis() as u64,
                        %message,
                        checkpoint_id = checkpoint.0,
                        "model attempt failed; retrying from current checkpoint"
                    );
                    if emit(
                        client,
                        RunEvent::ModelAttemptFailed {
                            attempt: retries,
                            message,
                        },
                    )
                    .await
                    .is_err()
                    {
                        return Err((client_failure(), usage.clone()));
                    }

                    let delay = tokio::time::sleep(MODEL_RETRY_DELAY);
                    tokio::pin!(delay);
                    loop {
                        tokio::select! {
                            biased;
                            command = client.commands.recv() => {
                                let interruption = match command {
                                    Some(RunCommand::InsertMessages(insertion)) => {
                                        pending_insertions.push(insertion);
                                        continue;
                                    }
                                    Some(RunCommand::BreakMessages(messages)) => messages,
                                    Some(RunCommand::Cancel) => {
                                        let _ = emit(client, RunEvent::CycleInterrupted).await;
                                        return Err((RunOutcome::Cancelled, usage.clone()));
                                    }
                                    Some(RunCommand::ToolResult(_)) => {
                                        return Err((RunOutcome::Failed(RunFailure::Protocol(
                                                "received a tool result while waiting to retry the model".into(),
                                            )), usage.clone()));
                                    }
                                    None => return Err((client_failure(), usage.clone())),
                                };
                                if emit(client, RunEvent::CycleInterrupted).await.is_err() {
                                    return Err((client_failure(), usage.clone()));
                                }
                                checkpoint = match messages::append_batches(
                                    &self.store,
                                    prepared,
                                    client,
                                    cancellation,
                                    checkpoint,
                                    std::mem::take(&mut pending_insertions),
                                )
                                .await
                                {
                                    Ok((checkpoint, _)) => checkpoint,
                                    Err(outcome) => return Err((outcome, usage.clone())),
                                };
                                checkpoint = match messages::append_batches(
                                    &self.store,
                                    prepared,
                                    client,
                                    cancellation,
                                    checkpoint,
                                    vec![interruption],
                                )
                                .await
                                {
                                    Ok((checkpoint, _)) => checkpoint,
                                    Err(outcome) => return Err((outcome, usage.clone())),
                                };
                                return Ok(ModelCycleOutcome::RestartModel { checkpoint });
                            }
                            _ = cancellation.cancelled() => {
                                let _ = emit(client, RunEvent::CycleInterrupted).await;
                                return Err((RunOutcome::Cancelled, usage.clone()));
                            }
                            _ = &mut delay => break,
                        }
                    }
                }
            }
        };
        if let Some(cycle_usage) = cycle.usage {
            update_context_usage_anchor(
                context_usage_anchor,
                cycle_usage,
                request.history.len(),
            );
            accumulate_usage(usage, cycle_usage);
        }

        Ok(ModelCycleOutcome::Completed {
            cycle,
            pending_insertions,
        })
    }
}
