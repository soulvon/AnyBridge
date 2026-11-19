//! Projects Run events to live Cursor output and checkpoint steps.
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cursor::{
        checkpoint::StepBuffer,
        checkpoint::{
            worker::{CheckpointWorker, FinalCheckpoints},
            CheckpointBuilder,
        },
        compile::{CursorRunContext, RuntimeAction},
        prompting::PromptCompiler,
        protocol::events,
        protocol::proto::agent::v1 as pb,
        services::blob_sync::BlobSynchronizer,
        tools::{
            codec, compat,
            runtime::CursorToolRuntime,
            stream::ToolCallStream,
            tool_call_result::{ToolCompletion, ToolResultReceiver},
            ToolBatchState, ToolDispatcher,
        },
    },
    model::{ToolCall, ToolRoundId, Usage},
    run::{RunEvent, RunHandle, RunSession},
    store::Store,
    Error, Result,
};

use super::{ConversationRegistry, RunFinish, TransportFinish};
use crate::cursor::transport::TransportHandle;

mod commits;
mod injections;
#[cfg(test)]
mod tests;

pub(crate) use commits::{finish_cancelled, finish_failed, finish_success};
use commits::CommittedStateContext;
use injections::PendingInjection;

pub struct ConversationOutput {
    pub(super) handle: TransportHandle,
    pub(super) store: Store,
    pub(super) context: CursorRunContext,
    pub(super) core: RunSession,
    pub(super) run: RunHandle,
    pub(super) registry: ConversationRegistry,
    pub(super) tools: ToolDispatcher,
    pub(super) results: ToolResultReceiver,
    pub(super) checkpoint: CheckpointBuilder,
    pub(super) tool_runtime: CursorToolRuntime,
    pub(super) runtime_actions: mpsc::UnboundedReceiver<RuntimeAction>,
    compiler: PromptCompiler,
    blob_sync: BlobSynchronizer,
    pub(in crate::cursor::conversation::output) injection_ids: HashSet<String>,
    pub(in crate::cursor::conversation::output) pending_injections: HashMap<String, PendingInjection>,
    pub(super) superseded: CancellationToken,
}

pub(crate) struct ConversationOutputDependencies {
    pub superseded: CancellationToken,
    pub tools: ToolDispatcher,
    pub results: ToolResultReceiver,
    pub checkpoint: CheckpointBuilder,
    pub tool_runtime: CursorToolRuntime,
    pub runtime_actions: mpsc::UnboundedReceiver<RuntimeAction>,
    pub compiler: PromptCompiler,
    pub blob_sync: BlobSynchronizer,
}

impl ConversationOutput {
    pub(crate) fn new(
        handle: TransportHandle,
        store: Store,
        context: CursorRunContext,
        core: RunSession,
        run: RunHandle,
        registry: ConversationRegistry,
        runtime: ConversationOutputDependencies,
    ) -> Self {
        Self {
            handle,
            store,
            context,
            core,
            run,
            registry,
            tools: runtime.tools,
            results: runtime.results,
            checkpoint: runtime.checkpoint,
            tool_runtime: runtime.tool_runtime,
            runtime_actions: runtime.runtime_actions,
            compiler: runtime.compiler,
            blob_sync: runtime.blob_sync,
            injection_ids: HashSet::new(),
            pending_injections: HashMap::new(),
            superseded: runtime.superseded,
        }
    }

    pub async fn run(mut self) -> Result<RunFinish> {
        let result = self.run_inner().await;
        if let Err(error) = &result {
            if !self.superseded.is_cancelled() {
                self.abort_execs().await;
                let (category, summary) = match error {
                    Error::Provider(_) | Error::Http(_) => ("provider", error.to_string()),
                    Error::Store(_) | Error::Database(_) | Error::Migration(_) => {
                        ("store", error.to_string())
                    }
                    _ => (
                        "protocol",
                        match error {
                            Error::Protocol(message) => message.clone(),
                            _ => error.to_string(),
                        },
                    ),
                };
                let _ = self
                    .store
                    .finish_run(
                        self.run.run_id(),
                        crate::store::RunStatus::Failed,
                        None,
                        Some((category, summary.as_str())),
                    )
                    .await;
                self.run.cancel();
            }
        }
        result
    }

    async fn run_inner(&mut self) -> Result<RunFinish> {
        if self.context.compacting {
            self.handle.emit(&events::summary_started())?;
        }
        let mut worker = CheckpointWorker::spawn(
            self.store.clone(),
            self.checkpoint.clone(),
            self.handle.clone(),
            self.context.mode,
        );
        let mut checkpoint_worker_open = true;
        let mut calls = BTreeMap::<usize, ToolCall>::new();
        let mut streams = BTreeMap::<usize, ToolCallStream>::new();
        let mut completions = HashMap::<String, ToolCompletion>::new();
        let mut completed = HashSet::<String>::new();
        let mut completed_round = None::<ToolRoundId>;
        let mut response_text = String::new();
        let mut response_thinking = String::new();
        let mut active_round = None::<ToolRoundId>;
        let mut active_tool_calls = HashSet::<String>::new();
        let mut interrupted_rounds = HashSet::<ToolRoundId>::new();
        let mut interrupted_tool_calls = HashSet::<String>::new();
        let mut final_checkpoint = None::<FinalCheckpoints>;
        let mut compaction_checkpoint = None::<pb::ConversationStateStructure>;
        let mut turn_usage = None::<Usage>;
        let mut context_tokens = None::<u64>;
        let mut ready = VecDeque::new();
        let mut presentation = StepBuffer::default();

        loop {
            if self.superseded.is_cancelled() {
                worker.abort();
                self.abort_execs().await;
                return Ok(RunFinish::Transport(TransportFinish::Cancelled));
            }
            let input = if let Ok(action) = self.runtime_actions.try_recv() {
                Input::RuntimeAction(Some(Box::new(action)))
            } else if let Some(completion) = ready.pop_front() {
                Input::Completion(completion)
            } else {
                tokio::select! {
                    biased;
                    _ = self.superseded.cancelled() => {
                        worker.abort();
                        self.abort_execs().await;
                        return Ok(RunFinish::Transport(TransportFinish::Cancelled));
                    }
                    action = self.runtime_actions.recv() => Input::RuntimeAction(action.map(Box::new)),
                    event = self.core.events.recv() => Input::Event(event),
                    completion = self.results.recv() => Input::CompletionResult(completion),
                    failure = worker.failures.recv(), if checkpoint_worker_open => Input::CheckpointFailure(failure),
                }
            };
            match input {
                Input::CheckpointFailure(Some(error)) => return Err(error),
                Input::CheckpointFailure(None) => {
                    checkpoint_worker_open = false;
                }
                Input::Completion(completion) => {
                    if let Some(completion) = self
                        .forward_completion(completion, &mut completions, &interrupted_tool_calls)
                        .await?
                    {
                        ready.push_back(completion);
                    }
                }
                Input::CompletionResult(Some(result)) => {
                    if let Some(completion) = self
                        .forward_completion(result?, &mut completions, &interrupted_tool_calls)
                        .await?
                    {
                        ready.push_back(completion);
                    }
                }
                Input::CompletionResult(None) => {
                    return Err(Error::Protocol("tool result channel closed".into()));
                }
                Input::RuntimeAction(Some(action)) => match *action {
                    RuntimeAction::Inject(action) => {
                        self.forward_injection(
                            action,
                            active_round.as_ref(),
                            &active_tool_calls,
                            &completions,
                            &mut interrupted_rounds,
                            &mut interrupted_tool_calls,
                        )
                        .await?;
                    }
                    RuntimeAction::UserMessage(action) => {
                        self.forward_user_message(
                            action,
                            active_round.as_ref(),
                            &active_tool_calls,
                            &completions,
                            &mut interrupted_rounds,
                            &mut interrupted_tool_calls,
                        )
                        .await?;
                    }
                },
                Input::RuntimeAction(None) => {
                    return Err(Error::Protocol("runtime action channel closed".into()));
                }
                Input::Event(None) => {
                    worker.abort();
                    return Err(Error::Protocol("core event channel closed".into()));
                }
                Input::Event(Some(event)) => match event {
                    RunEvent::AutoCompactionStarted => {
                        self.handle.emit(&events::summary_started())?;
                    }
                    RunEvent::AutoCompactionCompleted => {
                        self.handle.emit(&events::summary_completed())?;
                    }
                    RunEvent::CycleInterrupted => {
                        response_text.clear();
                        response_thinking.clear();
                        calls.clear();
                        streams.clear();
                        presentation.discard_model_output();
                    }
                    RunEvent::ModelAttemptFailed { attempt, message } => {
                        tracing::warn!(
                            run_id = %self.run.run_id(),
                            attempt,
                            %message,
                            "retrying model call from current checkpoint"
                        );
                        presentation.finish_model_attempt();
                        for call in calls.values_mut() {
                            if call.arguments.is_null() {
                                call.arguments = serde_json::from_str(&call.arguments_text)
                                    .unwrap_or_else(|_| serde_json::json!({}));
                            }
                            let completion = compat::failure_with_message(
                                call,
                                format!("Model attempt failed before tool completion: {message}"),
                            );
                            self.handle
                                .emit(&codec::tool_completed(call, &completion))?;
                            presentation.tool_completed(&completion);
                        }
                        response_text.clear();
                        response_thinking.clear();
                        calls.clear();
                        streams.clear();
                    }
                    RunEvent::TextStart => {}
                    RunEvent::TextEnd => {
                        if !self.context.compacting {
                            presentation.finish_text();
                        }
                    }
                    RunEvent::TextDelta(delta) => {
                        response_text.push_str(&delta);
                        if self.context.compacting {
                            self.handle.emit(&events::summary_delta(delta))?;
                        } else {
                            presentation.text_delta(&delta);
                            self.emit_model_event(
                                crate::provider::ModelEvent::TextDelta(delta),
                                "",
                            )?;
                        }
                    }
                    RunEvent::ThinkingStart => {}
                    RunEvent::ThinkingDelta(delta) => {
                        response_thinking.push_str(&delta);
                        if !self.context.compacting {
                            presentation.thinking_delta(&delta);
                            self.emit_model_event(
                                crate::provider::ModelEvent::ThinkingDelta(delta),
                                "",
                            )?;
                        }
                    }
                    RunEvent::ThinkingEnd { duration } => {
                        if !self.context.compacting {
                            presentation.finish_thinking(duration);
                            self.handle.emit(&events::thinking_completed(duration))?;
                        }
                    }
                    RunEvent::ToolCallStart {
                        index,
                        call_id,
                        name,
                        model_call_id,
                    } => {
                        let call = ToolCall {
                            index,
                            call_id: call_id.clone(),
                            model_call_id: model_call_id.clone(),
                            name: name.clone(),
                            arguments_text: String::new(),
                            arguments: serde_json::Value::Null,
                            argument_error: None,
                        };
                        self.emit_model_event(
                            crate::provider::ModelEvent::ToolCallStart {
                                index,
                                call_id,
                                name: name.clone(),
                            },
                            &model_call_id,
                        )?;
                        streams.insert(
                            index,
                            ToolCallStream::new(&name, self.context.dynamic_tools.get(&name)),
                        );
                        calls.insert(index, call);
                    }
                    RunEvent::ToolCallArgumentsDelta { index, delta } => {
                        let call = calls.get_mut(&index).ok_or_else(|| {
                            Error::Protocol(format!("unknown streaming tool index: {index}"))
                        })?;
                        call.arguments_text.push_str(&delta);
                        let stream = streams.get_mut(&index).ok_or_else(|| {
                            Error::Protocol(format!("missing Cursor tool stream: {index}"))
                        })?;
                        match stream.arguments_delta(call, &delta) {
                            Ok(messages) => {
                                for message in messages {
                                    self.handle.emit(&message)?;
                                }
                            }
                            Err(Error::Protocol(message)) => {
                                tracing::warn!(
                                    call_id = %call.call_id,
                                    %message,
                                    "ignoring invalid streaming tool arguments until completion"
                                );
                            }
                            Err(Error::Json(error)) => {
                                tracing::warn!(
                                    call_id = %call.call_id,
                                    %error,
                                    "ignoring invalid streaming tool arguments until completion"
                                );
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    RunEvent::ToolCallEnd { index } => {
                        let call = calls.get_mut(&index).ok_or_else(|| {
                            Error::Protocol(format!("unknown completed tool index: {index}"))
                        })?;
                        // A tool call with no arguments streams no argument text.
                        // Treat empty text as an empty object, matching the model
                        // cycle, instead of failing the run on `from_str("")`.
                        call.arguments = if call.arguments_text.trim().is_empty() {
                            serde_json::json!({})
                        } else {
                            serde_json::from_str(&call.arguments_text)
                                .unwrap_or_else(|_| serde_json::json!({}))
                        };
                    }
                    RunEvent::UsageSnapshot(usage) => {
                        if !self.context.compacting {
                            if let Some(output_tokens) = usage.output_tokens {
                                self.handle.emit(&events::token_delta(output_tokens))?;
                            }
                            context_tokens = usage.context_input_tokens;
                        }
                    }
                    RunEvent::Usage(usage) => {
                        if !self.context.compacting {
                            if let Some(output_tokens) = usage.output_tokens {
                                self.handle.emit(&events::token_delta(output_tokens))?;
                            }
                        }
                        if !self.context.compacting {
                            context_tokens = usage.context_input_tokens;
                        }
                        match &mut turn_usage {
                            Some(total) => *total += usage,
                            None => turn_usage = Some(usage),
                        }
                    }
                    RunEvent::ExecuteToolRound {
                        round_id,
                        calls: round_calls,
                    } => {
                        // `completed` exists so that replaying ExecuteToolRound for a round
                        // does not dispatch a call this round already committed. Tool call ids
                        // are only unique *within* a round -- the schema says as much with
                        // `UNIQUE (round_id, call_id)` -- so an id retained from an earlier
                        // round would make start_batch skip a fresh call, and tool_round wait
                        // forever for a result nothing will ever produce.
                        if completed_round.as_ref() != Some(&round_id) {
                            completed.clear();
                            completed_round = Some(round_id.clone());
                        }
                        active_round = Some(round_id.clone());
                        active_tool_calls = round_calls
                            .iter()
                            .map(|call| call.call_id.clone())
                            .collect();
                        // Runtime actions are deliberately prioritized over core events. An
                        // injection can therefore be observed before the already-queued
                        // ToolRoundStarted event reaches this session. In that case the
                        // accepted injection is still pending delivery and this round must be
                        // detached without starting any root tools.
                        if interrupted_rounds.contains(&round_id)
                            || !self.pending_injections.is_empty()
                        {
                            interrupted_rounds.insert(round_id.clone());
                            interrupted_tool_calls.extend(active_tool_calls.iter().cloned());
                            continue;
                        }
                        for dispatched in self
                            .tools
                            .start_batch(
                                &round_calls,
                                ToolBatchState {
                                    completed: &completed,
                                    started: &HashSet::new(),
                                    response_text: &response_text,
                                    response_thinking: &response_thinking,
                                },
                                &self
                                    .store
                                    .load_current_messages(&crate::model::ConversationId::new(
                                        &self.context.exec.conversation_id,
                                    ))
                                    .await?,
                                &self.context.dynamic_tools,
                                &self.context.exec,
                            )
                            .await?
                        {
                            for message in dispatched.messages {
                                self.handle.emit(&message)?;
                            }
                            if let Some(completion) = dispatched.completion {
                                ready.push_back(completion);
                            }
                        }
                        response_text.clear();
                        response_thinking.clear();
                        calls.clear();
                        streams.clear();
                    }
                    RunEvent::MessagesCommitted(state) => {
                        self.handle_committed_state(
                            state,
                            CommittedStateContext {
                                worker: &mut worker,
                                calls: &mut calls,
                                streams: &mut streams,
                                completions: &mut completions,
                                completed: &mut completed,
                                response_text: &mut response_text,
                                response_thinking: &mut response_thinking,
                                active_round: &mut active_round,
                                active_tool_calls: &mut active_tool_calls,
                                interrupted_rounds: &mut interrupted_rounds,
                                final_checkpoint: &mut final_checkpoint,
                                compaction_checkpoint: &mut compaction_checkpoint,
                                context_tokens: &mut context_tokens,
                                presentation: &mut presentation,
                            },
                        )
                        .await?;
                    }
                    RunEvent::Ended(outcome) => {
                        return self
                            .handle_ended(
                                outcome,
                                &mut worker,
                                final_checkpoint,
                                compaction_checkpoint,
                                turn_usage,
                            )
                            .await;
                    }
                },
            }
        }
    }

    pub(super) async fn abort_execs(&self) {
        for id in self.tool_runtime.drain_running().await {
            let _ = self.handle.emit(&codec::abort(id));
        }
    }

    fn emit_model_event(
        &self,
        event: crate::provider::ModelEvent,
        model_call_id: &str,
    ) -> Result<()> {
        if let Some(message) =
            events::response_event(&event, model_call_id, &self.context.dynamic_tools)?
        {
            self.handle.emit(&message)?;
        }
        Ok(())
    }
}

enum Input {
    Event(Option<RunEvent>),
    Completion(ToolCompletion),
    CompletionResult(Option<Result<ToolCompletion>>),
    RuntimeAction(Option<Box<RuntimeAction>>),
    CheckpointFailure(Option<Error>),
}
