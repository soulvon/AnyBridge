use std::collections::{BTreeMap, HashMap, HashSet};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use prost::Message;
use tokio::sync::oneshot;

use crate::{
    cursor::{
        checkpoint::{
            worker::{CheckpointJob, CheckpointKind, CheckpointWorker, FinalCheckpoints},
            StepBuffer,
        },
        protocol::events,
        protocol::proto::agent::v1 as pb,
        tools::{codec, stream::ToolCallStream, tool_call_result::ToolCompletion},
        transport::TransportHandle,
    },
    model::{ToolCall, ToolRoundId, Usage},
    run::{CommitCause, MessagesCommitted, RunFailure, RunOutcome},
    store::ToolRoundStatus,
    Error, Result,
};

use super::super::TransportFinish;
use super::{ConversationOutput, RunFinish};

pub(super) struct CommittedStateContext<'a> {
    pub(super) worker: &'a mut CheckpointWorker,
    pub(super) calls: &'a mut BTreeMap<usize, ToolCall>,
    pub(super) streams: &'a mut BTreeMap<usize, ToolCallStream>,
    pub(super) completions: &'a mut HashMap<String, ToolCompletion>,
    pub(super) completed: &'a mut HashSet<String>,
    pub(super) response_text: &'a mut String,
    pub(super) response_thinking: &'a mut String,
    pub(super) active_round: &'a mut Option<ToolRoundId>,
    pub(super) active_tool_calls: &'a mut HashSet<String>,
    pub(super) interrupted_rounds: &'a mut HashSet<ToolRoundId>,
    pub(super) final_checkpoint: &'a mut Option<FinalCheckpoints>,
    pub(super) compaction_checkpoint: &'a mut Option<pb::ConversationStateStructure>,
    pub(super) context_tokens: &'a mut Option<u64>,
    pub(super) presentation: &'a mut StepBuffer,
}

impl ConversationOutput {
    pub(super) async fn handle_committed_state(
        &mut self,
        state: MessagesCommitted,
        ctx: CommittedStateContext<'_>,
    ) -> Result<()> {
        let CommittedStateContext {
            worker,
            calls,
            streams,
            completions,
            completed,
            response_text,
            response_thinking,
            active_round,
            active_tool_calls,
            interrupted_rounds,
            final_checkpoint,
            compaction_checkpoint,
            context_tokens,
            presentation,
        } = ctx;
        if matches!(&state.cause, CommitCause::RuntimeEvent { .. }) {
            response_text.clear();
            response_thinking.clear();
            calls.clear();
            streams.clear();
        }
        if let CommitCause::RuntimeEvent { event_id } = &state.cause {
            // Injections key `pending_injections` by their raw
            // injection id and commit under `inject-context:{id}`,
            // while runtime user messages key it by (and commit
            // under) the full `user-message:{id}` event id. Strip
            // the injection prefix when present and otherwise use
            // the event id verbatim so both are cleared and emit
            // their delivered/appended events.
            let injection_id = event_id
                .strip_prefix("inject-context:")
                .unwrap_or(event_id.as_str());
            if let Some(pending) = self.pending_injections.remove(injection_id) {
                let delivered_at_ms = crate::cursor::tools::runtime::now_ms()
                    .min(i64::MAX as u64)
                    as i64;
                self.handle.emit(&events::context_injection_delivered(
                    injection_id.to_owned(),
                    pending.delivery_batch_id.clone(),
                    delivered_at_ms,
                ))?;
                if let Some(user_message) = pending.user_message {
                    self.handle
                        .emit(&events::user_message_appended(user_message))?;
                }
            }
        }
        if let CommitCause::ToolRoundStarted(round_id) = &state.cause {
            *active_round = Some(round_id.clone());
        }
        let mut tool_round_settled = false;
        if let CommitCause::ToolResult {
            call_id,
            interrupted,
        } = &state.cause
        {
            let snapshot = self
                .store
                .tool_round(active_round.as_ref().ok_or_else(|| {
                    Error::Protocol("tool commit has no active round".into())
                })?)
                .await?
                .ok_or_else(|| {
                    Error::Store("active tool round disappeared".into())
                })?;
            let call = snapshot
                .calls
                .iter()
                .find(|call| call.call_id == *call_id)
                .ok_or_else(|| {
                    Error::Protocol(format!(
                        "committed call is absent from tool round: {call_id}"
                    ))
                })?;
            if !interrupted {
                let completion = completions.remove(call_id).ok_or_else(|| {
                    Error::Protocol(format!(
                        "core committed a tool result without typed Cursor state: {call_id}"
                    ))
                })?;
                self.handle
                    .emit(&codec::tool_completed(call, &completion))?;
                presentation.tool_completed(&completion);
            }
            completed.insert(call_id.clone());
            tool_round_settled = snapshot.status == ToolRoundStatus::Settled;
        }
        let final_turn = state.cause == CommitCause::FinalTurn;
        if let CommitCause::Compaction { summary } = &state.cause {
            if !state.barrier.is_required() {
                return Err(Error::Protocol(
                    "compaction state has no completion barrier".into(),
                ));
            }
            let (sender, receiver) = oneshot::channel();
            worker
                .jobs
                .send(CheckpointJob {
                    kind: CheckpointKind::Compaction {
                        checkpoint_id: state.checkpoint_id,
                        summary: summary.clone(),
                        result: sender,
                    },
                    presentation: presentation.take(),
                    context_tokens: None,
                    ready: None,
                })
                .await
                .map_err(|_| Error::Protocol("checkpoint worker closed".into()))?;
            match receiver
                .await
                .map_err(|_| Error::Protocol("checkpoint worker stopped".into()))?
            {
                Ok(checkpoint) => {
                    *context_tokens = checkpoint_context_tokens(&checkpoint);
                    *compaction_checkpoint = Some(checkpoint);
                    state.barrier.complete(Ok(()));
                }
                Err(error) => {
                    state.barrier.complete(Err(error.to_string()));
                    return Err(error);
                }
            }
            return Ok(());
        }
        if final_turn {
            if !state.barrier.is_required() {
                return Err(Error::Protocol(
                    "final state has no completion barrier".into(),
                ));
            }
            let (sender, receiver) = oneshot::channel();
            worker
                .jobs
                .send(CheckpointJob {
                    kind: CheckpointKind::Final {
                        checkpoint_id: state.checkpoint_id,
                        result: sender,
                    },
                    presentation: presentation.take(),
                    context_tokens: *context_tokens,
                    ready: None,
                })
                .await
                .map_err(|_| Error::Protocol("checkpoint worker closed".into()))?;
            match receiver
                .await
                .map_err(|_| Error::Protocol("checkpoint worker stopped".into()))?
            {
                Ok(checkpoints) => {
                    *final_checkpoint = Some(checkpoints);
                    state.barrier.complete(Ok(()));
                }
                Err(error) => {
                    state.barrier.complete(Err(error.to_string()));
                    return Err(error);
                }
            }
        } else if let CommitCause::ToolRoundStarted(round_id) = &state.cause {
            worker
                .jobs
                .send(CheckpointJob {
                    kind: CheckpointKind::ToolStarted {
                        round_id: round_id.clone(),
                        stable_checkpoint_id: state.checkpoint_id,
                    },
                    presentation: presentation.take(),
                    context_tokens: *context_tokens,
                    ready: None,
                })
                .await
                .map_err(|_| Error::Protocol("checkpoint worker closed".into()))?;
        } else if tool_round_settled {
            if !state.barrier.is_required() {
                return Err(Error::Protocol(
                    "settled tool round has no completion barrier".into(),
                ));
            }
            let (ready, published) = oneshot::channel();
            worker
                .jobs
                .send(CheckpointJob {
                    kind: CheckpointKind::ToolSettled(state.checkpoint_id),
                    presentation: presentation.take(),
                    context_tokens: *context_tokens,
                    ready: Some(ready),
                })
                .await
                .map_err(|_| Error::Protocol("checkpoint worker closed".into()))?;
            let result = published
                .await
                .map_err(|_| Error::Protocol("checkpoint worker stopped".into()))?
                .map_err(Error::Protocol);
            match result {
                Ok(()) => state.barrier.complete(Ok(())),
                Err(error) => {
                    state.barrier.complete(Err(error.to_string()));
                    return Err(error);
                }
            }
            if let Some(round_id) = active_round.take() {
                interrupted_rounds.remove(&round_id);
            }
            active_tool_calls.clear();
            self.tool_runtime.clear_completed().await;
        } else if !matches!(&state.cause, CommitCause::ToolResult { .. })
            && active_round.is_some()
        {
            let round_id = active_round.clone().ok_or_else(|| {
                Error::Protocol("active tool round disappeared".into())
            })?;
            worker
                .jobs
                .send(CheckpointJob {
                    kind: CheckpointKind::ToolStarted {
                        round_id,
                        stable_checkpoint_id: state.checkpoint_id,
                    },
                    presentation: presentation.take(),
                    context_tokens: *context_tokens,
                    ready: None,
                })
                .await
                .map_err(|_| Error::Protocol("checkpoint worker closed".into()))?;
        } else if !matches!(&state.cause, CommitCause::ToolResult { .. }) {
            let requires_ready = state.barrier.is_required();
            let (ready, published) = oneshot::channel();
            worker
                .jobs
                .send(CheckpointJob {
                    kind: CheckpointKind::Settled(state.checkpoint_id),
                    presentation: presentation.take(),
                    context_tokens: *context_tokens,
                    ready: requires_ready.then_some(ready),
                })
                .await
                .map_err(|_| Error::Protocol("checkpoint worker closed".into()))?;
            if requires_ready {
                let result = published
                    .await
                    .map_err(|_| {
                        Error::Protocol("checkpoint worker stopped".into())
                    })?
                    .map_err(Error::Protocol);
                match result {
                    Ok(()) => state.barrier.complete(Ok(())),
                    Err(error) => {
                        state.barrier.complete(Err(error.to_string()));
                        return Err(error);
                    }
                }
            }
        }

        Ok(())
    }

    pub(super) async fn handle_ended(
        &mut self,
        outcome: RunOutcome,
        worker: &mut CheckpointWorker,
        mut final_checkpoint: Option<FinalCheckpoints>,
        mut compaction_checkpoint: Option<pb::ConversationStateStructure>,
        turn_usage: Option<Usage>,
    ) -> Result<RunFinish> {
        if self.superseded.is_cancelled() {
            worker.abort();
            self.abort_execs().await;
            return Ok(RunFinish::Transport(TransportFinish::Cancelled));
        }
        return match outcome {
            RunOutcome::Completed => {
                if self.context.compacting {
                    let checkpoint =
                        compaction_checkpoint.take().ok_or_else(|| {
                            Error::Protocol(
                                "Completed compaction without checkpoint".into(),
                            )
                        })?;
                    self.handle.emit(&events::summary_completed())?;
                    self.handle.emit(&events::turn_ended(turn_usage))?;
                    for _ in 0..3 {
                        self.checkpoint.publish(&self.handle, &checkpoint).await?;
                    }
                    return Ok(RunFinish::TurnCompleted);
                }
                let checkpoints = final_checkpoint.take().ok_or_else(|| {
                    Error::Protocol("Completed without final state".into())
                })?;
                self.handle.emit(&events::turn_ended(turn_usage))?;
                self.checkpoint
                    .publish(&self.handle, &checkpoints.staged)
                    .await?;
                self.checkpoint
                    .publish(&self.handle, &checkpoints.settled)
                    .await?;
                self.handle.emit(&pb::AgentServerMessage {
                    ttft_breakdown: None,
                    message: Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(checkpoints.settled)),
                })?;
                Ok(RunFinish::TurnCompleted)
            }
            RunOutcome::Cancelled => {
                worker.abort();
                self.abort_execs().await;
                Ok(RunFinish::Transport(TransportFinish::Cancelled))
            }
            RunOutcome::Failed(failure) => {
                worker.abort();
                self.abort_execs().await;
                Ok(RunFinish::Transport(TransportFinish::Failed(cursor_error(
                    failure,
                ))))
            }
        };

    }
}

fn cursor_error(failure: RunFailure) -> Error {
    match failure {
        RunFailure::Protocol(message) => Error::Protocol(message),
        RunFailure::Provider(message) => Error::Provider(message),
        RunFailure::Store(message) => Error::Store(message),
        RunFailure::Client(message) => Error::Protocol(message),
    }
}

pub(crate) fn finish_success(handle: &TransportHandle) {
    handle.emit_frame(crate::cursor::protocol::connect::encode_end_stream());
    handle.close_output();
}

pub(crate) fn finish_failed(handle: &TransportHandle, error: &Error) -> Result<()> {
    use crate::cursor::protocol::connect::{
        encode_end_stream, encode_error_end_stream, ConnectCode, ConnectErrorDetail,
        ConnectStreamError,
    };
    use crate::cursor::protocol::proto::aiserver::v1 as ai;

    let plain = |code, message| ConnectStreamError {
        code,
        message,
        details: Vec::new(),
    };
    let stream_error = match error {
        Error::Provider(_) | Error::Http(_) => {
            let detail = ai::ErrorDetails {
                error: ai::error_details::Error::ProviderError as i32,
                details: Some(ai::CustomErrorDetails {
                    title: "Provider Error".into(),
                    detail: error.to_string(),
                    allow_command_links_potentially_unsafe_please_only_use_for_handwritten_trusted_markdown: Some(true),
                    is_retryable: Some(true),
                    show_request_id: Some(true),
                    should_show_immediate_error: Some(false),
                }),
                is_expected: Some(true),
            };
            ConnectStreamError {
                code: ConnectCode::Unavailable,
                message: error.to_string(),
                details: vec![ConnectErrorDetail {
                    type_name: "aiserver.v1.ErrorDetails".into(),
                    value: STANDARD_NO_PAD.encode(detail.encode_to_vec()),
                }],
            }
        }
        Error::Protocol(message) => plain(ConnectCode::InvalidArgument, message.clone()),
        Error::Decode(_) | Error::Json(_) => plain(ConnectCode::InvalidArgument, error.to_string()),
        Error::RunNotFound(_) => plain(ConnectCode::NotFound, error.to_string()),
        Error::Cancelled => plain(ConnectCode::Canceled, error.to_string()),
        _ => plain(ConnectCode::Internal, error.to_string()),
    };
    handle
        .emit_frame(encode_error_end_stream(&stream_error).unwrap_or_else(|_| encode_end_stream()));
    handle.close_output();
    Ok(())
}

pub(crate) fn finish_cancelled(handle: &TransportHandle) -> Result<()> {
    use crate::cursor::protocol::connect::{
        encode_end_stream, encode_error_end_stream, ConnectCode, ConnectStreamError,
    };
    let error = ConnectStreamError {
        code: ConnectCode::Canceled,
        message: "run was cancelled".into(),
        details: Vec::new(),
    };
    handle.emit_frame(encode_error_end_stream(&error).unwrap_or_else(|_| encode_end_stream()));
    handle.close_output();
    Ok(())
}

pub(super) fn checkpoint_context_tokens(checkpoint: &pb::ConversationStateStructure) -> Option<u64> {
    checkpoint
        .token_details
        .as_ref()
        .map(|details| u64::from(details.used_tokens))
}
