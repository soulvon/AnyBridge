use std::collections::HashSet;

use tokio_util::sync::CancellationToken;

use crate::{
    model::{
        CanonicalMessage, CheckpointId, MessageContent, Origin, PreparedRun, Role, Usage,
    },
    run::{
        compaction, consume_model_cycle, messages, CommitBarrier, CommitCause, MessageBatch,
        MessagesCommitted, ModelCycleResult, RunCommand, RunEvent, RunFailure, RunOutcome,
        RunPort,
    },
};

use super::helpers::{client_failure, context_usage_snapshot, emit, wait_for_state_ready};
use super::RunEngine;

impl RunEngine {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn finish_explicit_compaction(
        &self,
        prepared: &PreparedRun,
        mut checkpoint: CheckpointId,
        client: &mut RunPort,
        cancellation: &CancellationToken,
        cycle: ModelCycleResult,
        pending_insertions: Vec<MessageBatch>,
        usage: Option<Usage>,
    ) -> (RunOutcome, Option<Usage>) {
        if !cycle.calls.is_empty() {
            return (
                RunOutcome::Failed(RunFailure::Protocol(
                    "compaction model returned tool calls".into(),
                )),
                usage,
            );
        }
        let summary = cycle.text.trim().to_string();
        if summary.is_empty() {
            return (
                RunOutcome::Failed(RunFailure::Protocol(
                    "compaction model returned an empty summary".into(),
                )),
                usage,
            );
        }
        let event_id = format!("summary:{}", prepared.run_id);
        let summary_message = CanonicalMessage {
            message_id: format!("runtime:{event_id}"),
            role: Role::User,
            origin: Origin::Runtime,
            content: MessageContent::Parts {
                parts: vec![crate::model::ContentPart::Text {
                    text: format!(
                        "<conversation_summary>\n{summary}\n</conversation_summary>"
                    ),
                }],
            },
            runtime_event_id: Some(event_id),
        };
        checkpoint = match self
            .store
            .replace_checkpoint(
                &prepared.conversation_id,
                &prepared.run_id,
                checkpoint,
                &[summary_message],
            )
            .await
        {
            Ok(checkpoint) => checkpoint,
            Err(error) => return (RunOutcome::Failed(error.into()), usage),
        };
        if !pending_insertions.is_empty() {
            checkpoint = match messages::append_batches(
                &self.store,
                prepared,
                client,
                cancellation,
                checkpoint,
                pending_insertions,
            )
            .await
            {
                Ok((next, _)) => next,
                Err(outcome) => return (outcome, usage),
            };
        }
        client.phase.begin_finalizing();
        let closing_insertions = match messages::drain_accepted(client) {
            Ok(insertions) => insertions,
            Err(outcome) => return (outcome, usage),
        };
        if !closing_insertions.is_empty() {
            checkpoint = match messages::append_batches(
                &self.store,
                prepared,
                client,
                cancellation,
                checkpoint,
                closing_insertions,
            )
            .await
            {
                Ok((next, _)) => next,
                Err(outcome) => return (outcome, usage),
            };
        }
        let (barrier, ready) = CommitBarrier::before_continue();
        if emit(
            client,
            RunEvent::MessagesCommitted(MessagesCommitted {
                checkpoint_id: checkpoint,
                tool_round_version: 0,
                cause: CommitCause::Compaction { summary },
                barrier,
            }),
        )
        .await
        .is_err()
        {
            return (client_failure(), usage);
        }
        if let Err(outcome) = wait_for_state_ready(ready, cancellation).await {
            return (outcome, usage);
        }
        return (RunOutcome::Completed, usage);

    }

    pub(super) async fn auto_compact(
        &self,
        prepared: &PreparedRun,
        checkpoint: CheckpointId,
        messages: &[CanonicalMessage],
        client: &mut RunPort,
        cancellation: &CancellationToken,
    ) -> std::result::Result<(CheckpointId, Option<Usage>), RunOutcome> {
        let current_ids = prepared
            .initial_messages
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<HashSet<_>>();
        let (compactable, retained_request_context) =
            compaction::partition(messages, &current_ids);
        if compactable.is_empty() {
            let projected = crate::model::project_messages(messages)
                .map_err(|error| RunOutcome::Failed(error.into()))?;
            let message = compaction::validate_compacted(prepared, &projected)
                .err()
                .unwrap_or_else(|| {
                    "context overflow after compaction: no conversation history can be compacted"
                        .into()
                });
            return Err(RunOutcome::Failed(RunFailure::Protocol(message)));
        }

        emit(client, RunEvent::AutoCompactionStarted)
            .await
            .map_err(|_| client_failure())?;
        let provider_call_index = self
            .store
            .begin_provider_call(&prepared.run_id)
            .await
            .map_err(|error| RunOutcome::Failed(error.into()))?;
        let history = crate::model::project_messages(&compactable)
            .map_err(|error| RunOutcome::Failed(error.into()))?;
        let mut model = prepared.model.clone();
        model.max_output_tokens = Some(compaction::OUTPUT_TOKENS);
        model.reasoning.enabled = false;
        model.reasoning.effort = None;
        let invocation = crate::model::ModelInvocation {
            call_id: format!("{}:{provider_call_index}", prepared.run_id),
            run_id: prepared.run_id.to_string(),
            conversation_id: prepared.conversation_id.to_string(),
            provider_call_index,
            request: crate::model::ModelRequest {
                prompt: crate::model::PromptSpec {
                    instructions: compaction::INSTRUCTIONS.into(),
                    tools: Vec::new(),
                },
                model,
                history,
            },
        };
        let cycle_cancellation = cancellation.child_token();
        let (silent_events, mut discarded_events) = tokio::sync::mpsc::channel(256);
        let drain = tokio::spawn(async move { while discarded_events.recv().await.is_some() {} });
        let mut pending_insertions = Vec::new();
        let mut break_messages = None;
        let cycle = {
            let cycle = consume_model_cycle(
                self.provider.stream(invocation, cycle_cancellation.clone()),
                &silent_events,
                &cycle_cancellation,
            );
            tokio::pin!(cycle);
            loop {
                tokio::select! {
                    biased;
                    command = client.commands.recv() => match command {
                        Some(RunCommand::InsertMessages(insertion)) => {
                            pending_insertions.push(insertion);
                        }
                        Some(RunCommand::BreakMessages(messages)) => {
                            cycle_cancellation.cancel();
                            break_messages = Some(messages);
                            break cycle.await;
                        }
                        Some(RunCommand::Cancel) => {
                            cycle_cancellation.cancel();
                            let _ = cycle.await;
                            return Err(RunOutcome::Cancelled);
                        }
                        Some(RunCommand::ToolResult(_)) => {
                            cycle_cancellation.cancel();
                            let _ = cycle.await;
                            return Err(RunOutcome::Failed(RunFailure::Protocol(
                                "received a tool result while automatic compaction was running".into(),
                            )));
                        }
                        None => {
                            cycle_cancellation.cancel();
                            let _ = cycle.await;
                            return Err(client_failure());
                        }
                    },
                    result = &mut cycle => break result,
                }
            }
        };
        drop(silent_events);
        let _ = drain.await;
        let (summary, compaction_usage) = match (break_messages.is_some(), cycle) {
            (true, Ok(cycle)) => (
                compaction::fallback_summary(&compactable),
                cycle.usage,
            ),
            (true, Err(failure)) => (
                compaction::fallback_summary(&compactable),
                failure.usage,
            ),
            (false, Ok(cycle)) if cycle.calls.is_empty() && !cycle.text.trim().is_empty() => {
                (cycle.text.trim().to_string(), cycle.usage)
            }
            (false, Ok(cycle)) => {
                tracing::warn!("automatic compaction returned no usable summary; using fallback");
                (
                    compaction::fallback_summary(&compactable),
                    cycle.usage,
                )
            }
            (false, Err(failure)) => {
                tracing::warn!(error = ?failure.failure, "automatic compaction model failed; using fallback");
                (
                    compaction::fallback_summary(&compactable),
                    failure.usage,
                )
            }
        };
        let event_id = format!("summary:auto:{}:{provider_call_index}", prepared.run_id);
        let summary_message = CanonicalMessage {
            message_id: format!("runtime:{event_id}"),
            role: Role::User,
            origin: Origin::Runtime,
            content: MessageContent::Parts {
                parts: vec![crate::model::ContentPart::Text {
                    text: format!("<conversation_summary>\n{summary}\n</conversation_summary>"),
                }],
            },
            runtime_event_id: Some(event_id),
        };
        let mut replacement = retained_request_context.into_iter().collect::<Vec<_>>();
        replacement.push(summary_message);
        replacement.extend(prepared.initial_messages.iter().cloned());
        let projected_replacement = crate::model::project_messages(&replacement)
            .map_err(|error| RunOutcome::Failed(error.into()))?;
        compaction::validate_compacted(prepared, &projected_replacement)
            .map_err(|message| RunOutcome::Failed(RunFailure::Protocol(message)))?;
        let mut checkpoint = self
            .store
            .replace_checkpoint(
                &prepared.conversation_id,
                &prepared.run_id,
                checkpoint,
                &replacement,
            )
            .await
            .map_err(|error| RunOutcome::Failed(error.into()))?;
        let (barrier, ready) = CommitBarrier::before_continue();
        emit(
            client,
            RunEvent::MessagesCommitted(MessagesCommitted {
                checkpoint_id: checkpoint,
                tool_round_version: 0,
                cause: CommitCause::Compaction { summary },
                barrier,
            }),
        )
        .await
        .map_err(|_| client_failure())?;
        wait_for_state_ready(ready, cancellation).await?;
        emit(client, RunEvent::AutoCompactionCompleted)
            .await
            .map_err(|_| client_failure())?;
        emit(client, RunEvent::UsageSnapshot(context_usage_snapshot(0)))
            .await
            .map_err(|_| client_failure())?;
        checkpoint = messages::append_batches(
            &self.store,
            prepared,
            client,
            cancellation,
            checkpoint,
            pending_insertions,
        )
        .await?
        .0;
        if let Some(messages) = break_messages {
            checkpoint = messages::append_batches(
                &self.store,
                prepared,
                client,
                cancellation,
                checkpoint,
                vec![messages],
            )
            .await?
            .0;
        }
        Ok((checkpoint, compaction_usage))
    }
}
