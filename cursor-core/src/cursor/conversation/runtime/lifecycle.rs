use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cursor::{
        checkpoint::CheckpointBuilder,
        compile,
        protocol::proto::agent::v1 as pb,
        services::{blob_sync::BlobSynchronizer, context_sync::RequestContextSynchronizer},
        tools::{
            codec,
            runtime::CursorToolRuntime,
            tool_call_result::{tool_result_channel, ToolResultReceiver},
            ToolDispatcher,
        },
        transport::TransportHandle,
    },
    run::{CommandResult, RunEngine},
};

use super::super::{
    CompiledMessages, ConversationDependencies, ConversationOutput, ConversationOutputDependencies,
    ConversationRegistry, MessageDelivery, RunFinish, TransportCommand, TransportFinish,
};
use super::{FinishGeneration, RunGeneration};

#[allow(clippy::too_many_arguments)]
pub(super) async fn start_generation(
    registry: &ConversationRegistry,
    handle: &TransportHandle,
    dependencies: &ConversationDependencies,
    blob_sync: &BlobSynchronizer,
    context_sync: &RequestContextSynchronizer,
    tool_runtime_factory: &CursorToolRuntime,
    current: &mut Option<RunGeneration>,
    next_generation: &mut u64,
    request: pb::AgentRunRequest,
) {
    let previous_finished = if let Some(previous) = current.take() {
        previous.superseded.cancel();
        if let Some(run) = previous.run.lock().clone() {
            run.cancel();
        }
        for id in previous.tool_runtime.interrupt_for_run_replacement().await {
            let _ = handle.emit(&codec::abort(id));
        }
        Some(previous.finished.clone())
    } else {
        None
    };
    let (results, result_receiver) = tool_result_channel();
    let (runtime_actions, runtime_action_receiver) =
        mpsc::unbounded_channel::<compile::RuntimeAction>();
    let tool_runtime = tool_runtime_factory.next_run();
    let tools = ToolDispatcher::with_results(
        tool_runtime.clone(),
        results.clone(),
        dependencies.store.clone(),
        dependencies.web_cache.clone(),
    );
    let generation = RunGeneration {
        id: *next_generation,
        request: request.clone(),
        superseded: CancellationToken::new(),
        finished: CancellationToken::new(),
        run: Arc::new(parking_lot::Mutex::new(None)),
        results,
        runtime_actions,
        tool_runtime,
        tools,
    };
    *next_generation = next_generation.saturating_add(1);
    *current = Some(generation.clone());
    spawn_run_request(
        registry.clone(),
        handle.clone(),
        request,
        dependencies.clone(),
        blob_sync.clone(),
        context_sync.clone(),
        generation,
        previous_finished,
        result_receiver,
        runtime_action_receiver,
    );
}

pub(super) async fn finish_pending(
    registry: &ConversationRegistry,
    handle: &TransportHandle,
    current: &Option<RunGeneration>,
    pending: Option<(u64, TransportFinish)>,
) {
    let Some((generation, finish)) = pending else {
        return;
    };
    if current
        .as_ref()
        .is_some_and(|current| current.id == generation)
    {
        // 先把子代理自己这条流收干净（用户看到它结束），再通知父会话——
        // 父会话那边可能在忙，通知慢一步不该拖着子代理不收尾。
        finish_transport(handle, &finish);
        super::super::subagents::subagent_finished(registry, handle, &finish).await;
    }
}

pub(super) fn finish_transport(handle: &TransportHandle, finish: &TransportFinish) {
    match finish {
        TransportFinish::Success => super::super::finish_success(handle),
        TransportFinish::Failed(error) => {
            let _ = super::super::finish_failed(handle, error);
        }
        TransportFinish::Cancelled => {
            let _ = super::super::finish_cancelled(handle);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_run_request(
    registry: ConversationRegistry,
    handle: TransportHandle,
    request: pb::AgentRunRequest,
    dependencies: ConversationDependencies,
    blob_sync: BlobSynchronizer,
    context_sync: RequestContextSynchronizer,
    generation: RunGeneration,
    previous_finished: Option<CancellationToken>,
    results: ToolResultReceiver,
    runtime_actions: mpsc::UnboundedReceiver<compile::RuntimeAction>,
) {
    tokio::spawn(async move {
        let _finished = FinishGeneration(generation.finished.clone());
        if let Some(previous_finished) = previous_finished {
            tokio::select! {
                biased;
                _ = generation.superseded.cancelled() => return,
                _ = previous_finished.cancelled() => {}
            }
        }
        if generation.superseded.is_cancelled() {
            return;
        }

        let mut checkpoint = CheckpointBuilder::new(
            dependencies.store.clone(),
            blob_sync.clone(),
            handle
                .parent()
                .and_then(|parent| parent.tool_call_id.clone()),
            request.conversation_state.clone(),
        );
        let prepared = tokio::select! {
            biased;
            _ = generation.superseded.cancelled() => return,
            prepared = compile::prepare(
                handle.request_id(),
                &request,
                compile::PrepareDependencies {
                    compiler: &dependencies.compiler,
                    store: &dependencies.store,
                    checkpoint: &checkpoint,
                    blob_sync: &blob_sync,
                    context_sync: &context_sync,
                    local_rules_dir: dependencies.local_rules_dir.as_deref(),
                    parent: handle.parent(),
                },
            ) => prepared,
        };
        let (mut prepared, context) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                if generation.superseded.is_cancelled() {
                    return;
                }
                tracing::error!(
                    request_id = handle.request_id(),
                    %error,
                    "failed to prepare Cursor Run"
                );
                let _ = handle
                    .command(TransportCommand::RunFinished {
                        generation: generation.id,
                        finish: RunFinish::Transport(TransportFinish::Failed(error)),
                    })
                    .await;
                return;
            }
        };
        checkpoint.configure(
            prepared.model.model_id.clone(),
            prepared.model.context_window_tokens,
            context.checkpoint_prompt.instructions.clone(),
            context.checkpoint_prompt.tools.clone(),
            context.dynamic_tools.keys().cloned().collect(),
            context.turn_user.clone(),
        );
        if context.background_completion {
            let event_id = prepared
                .initial_messages
                .first()
                .and_then(|message| message.runtime_event_id.clone())
                .unwrap_or_else(|| format!("background:{}", prepared.run_id));
            match registry
                .deliver(
                    &prepared.conversation_id,
                    CompiledMessages {
                        event_id,
                        target_run_id: None,
                        messages: prepared.initial_messages.clone(),
                        delivery: MessageDelivery::InsertMessages,
                    },
                )
                .await
            {
                CommandResult::Applied | CommandResult::Duplicate => {
                    if !generation.superseded.is_cancelled() {
                        let _ = handle
                            .command(TransportCommand::RunFinished {
                                generation: generation.id,
                                finish: RunFinish::Transport(TransportFinish::Success),
                            })
                            .await;
                    }
                    return;
                }
                CommandResult::RunClosing => {
                    prepared.initial_messages.clear();
                    tokio::select! {
                        biased;
                        _ = generation.superseded.cancelled() => return,
                        _ = registry.wait_until_idle(&prepared.conversation_id) => {}
                    }
                    if let Ok(checkpoint) = dependencies
                        .store
                        .ensure_conversation(&prepared.conversation_id)
                        .await
                    {
                        prepared.base_checkpoint_id = checkpoint;
                    }
                }
                CommandResult::RunEnded => {
                    prepared.initial_messages.clear();
                }
                CommandResult::StaleTarget => {
                    if !generation.superseded.is_cancelled() {
                        let _ = handle
                            .command(TransportCommand::RunFinished {
                                generation: generation.id,
                                finish: RunFinish::Transport(TransportFinish::Success),
                            })
                            .await;
                    }
                    return;
                }
            }
        }
        let pending = registry.take_pending(&prepared.conversation_id).await;
        if !pending.is_empty() {
            let mut messages = pending
                .into_iter()
                .flat_map(|pending| pending.messages)
                .collect::<Vec<_>>();
            messages.extend(prepared.initial_messages);
            prepared.initial_messages = messages;
            if let Ok(checkpoint) = dependencies
                .store
                .ensure_conversation(&prepared.conversation_id)
                .await
            {
                prepared.base_checkpoint_id = checkpoint;
            }
        }
        if generation.superseded.is_cancelled() {
            return;
        }

        let run_id = prepared.run_id.clone();
        let conversation_id = prepared.conversation_id.clone();
        let (port, core, run_handle) = crate::run::channel(run_id.clone(), 256);
        *generation.run.lock() = Some(run_handle.clone());
        if generation.superseded.is_cancelled() {
            run_handle.cancel();
            *generation.run.lock() = None;
            return;
        }
        registry
            .activate(conversation_id.clone(), run_id.clone(), run_handle.clone())
            .await;
        let cancellation = run_handle.cancellation();
        let engine = RunEngine::new(dependencies.store.clone(), dependencies.provider.clone());
        let core_run = tokio::spawn(async move { engine.run(prepared, port, cancellation).await });
        let output = ConversationOutput::new(
            handle.clone(),
            dependencies.store.clone(),
            context,
            core,
            run_handle,
            registry.clone(),
            ConversationOutputDependencies {
                superseded: generation.superseded.clone(),
                tools: generation.tools.clone(),
                results,
                runtime_actions,
                compiler: dependencies.compiler.clone(),
                blob_sync,
                checkpoint,
                tool_runtime: generation.tool_runtime.clone(),
            },
        );
        let finish = match output.run().await {
            Ok(finish) => finish,
            Err(error) => {
                if generation.superseded.is_cancelled() {
                    RunFinish::Transport(TransportFinish::Cancelled)
                } else {
                    tracing::error!(
                        request_id = handle.request_id(),
                        %error,
                        "Cursor session failed"
                    );
                    RunFinish::Transport(TransportFinish::Failed(error))
                }
            }
        };
        let _ = core_run.await;
        registry.release(&conversation_id, &run_id).await;
        if generation
            .run
            .lock()
            .as_ref()
            .is_some_and(|run| run.run_id() == &run_id)
        {
            *generation.run.lock() = None;
        }
        if !generation.superseded.is_cancelled() {
            let _ = handle
                .command(TransportCommand::RunFinished {
                    generation: generation.id,
                    finish,
                })
                .await;
        }
    });
}
