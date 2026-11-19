use crate::{
    cursor::{
        compile,
        protocol::proto::agent::v1 as pb,
        services::{blob_sync::BlobSynchronizer, context_sync::RequestContextSynchronizer},
        tools::{codec, compat, runtime::CursorToolRuntime, ClientToolEvent},
        transport::{OrderedInbox, TransportHandle},
    },
    run::RunPhase,
};

use super::super::{ConversationDependencies, ConversationRegistry, TransportFinish};
use super::lifecycle::start_generation;
use super::RunGeneration;

pub(super) enum AppendOutcome {
    Continue,
    TerminateTask,
}

pub(super) struct AppendContext<'a> {
    pub(super) registry: &'a ConversationRegistry,
    pub(super) handle: &'a TransportHandle,
    pub(super) dependencies: &'a ConversationDependencies,
    pub(super) blob_sync: &'a BlobSynchronizer,
    pub(super) context_sync: &'a RequestContextSynchronizer,
    pub(super) tool_runtime_factory: &'a CursorToolRuntime,
    pub(super) inbox: &'a mut OrderedInbox<pb::AgentClientMessage>,
    pub(super) current: &'a mut Option<RunGeneration>,
    pub(super) next_generation: &'a mut u64,
    pub(super) pending_finish: &'a mut Option<(u64, TransportFinish)>,
    pub(super) draining: &'a mut bool,
    pub(super) waiting_for_action: &'a mut bool,
}

pub(super) async fn handle_appended_messages(
    seqno: i64,
    message: pb::AgentClientMessage,
    ctx: AppendContext<'_>,
) -> AppendOutcome {
    let AppendContext {
        registry,
        handle,
        dependencies,
        blob_sync,
        context_sync,
        tool_runtime_factory,
        inbox,
        current,
        next_generation,
        pending_finish,
        draining,
        waiting_for_action,
    } = ctx;
    for (_seqno, message) in inbox.push(seqno, message) {
        {
            match message.message {
                Some(pb::agent_client_message::Message::RunRequest(
                    request,
                )) => {
                    *waiting_for_action = false;
                    if *draining {
                        handle.reopen();
                        *draining = false;
                        *pending_finish = None;
                    }
                    if let Some(conversation_id) =
                        request.conversation_id.as_deref()
                    {
                        if let Err(error) =
                            handle.set_conversation_id(conversation_id)
                        {
                            tracing::error!(
                                request_id = handle.request_id(),
                                %error,
                                "invalid Cursor conversation id"
                            );
                            let _ = super::super::finish_failed(&handle, &error);
                            return AppendOutcome::TerminateTask;
                        }
                    }
                    start_generation(
                        registry,
                        handle,
                        dependencies,
                        blob_sync,
                        context_sync,
                        tool_runtime_factory,
                        current,
                        next_generation,
                        request,
                    )
                    .await;
                }
                Some(pb::agent_client_message::Message::ExecClientMessage(
                    message,
                )) => {
                    if context_sync.handle_client(&message).await {
                        continue;
                    }
                    let Some(generation) = current.as_ref() else {
                        continue;
                    };
                    match codec::client_event(
                        &message,
                        &generation.tool_runtime,
                    )
                    .await
                    {
                        Ok(codec::ClientExecEvent::Delta(message)) => {
                            let _ = handle.emit(&message);
                        }
                        Ok(codec::ClientExecEvent::Message(message)) => {
                            let _ = handle.emit(&message);
                        }
                        Ok(codec::ClientExecEvent::Completed(result)) => {
                            generation.results.send(*result)
                        }
                        Ok(codec::ClientExecEvent::Pending) => {}
                        Err(error) => generation.results.send_error(error),
                    }
                }
                Some(
                    pb::agent_client_message::Message::ExecClientControlMessage(
                        message,
                    ),
                ) => {
                    use pb::exec_client_control_message::Message;
                    match message.message {
                        Some(Message::StreamClose(close)) => {
                            if context_sync.handle_stream_close(close.id).await
                            {
                                continue;
                            }
                            let Some(generation) = current.as_ref() else {
                                continue;
                            };
                            match codec::stream_closed(
                                close.id,
                                &generation.tool_runtime,
                            )
                            .await
                            {
                                Ok(Some(completion)) => {
                                    generation.results.send(completion)
                                }
                                Ok(None) => {}
                                Err(error) => {
                                    generation.results.send_error(error)
                                }
                            }
                        }
                        Some(Message::Throw(throw)) => {
                            if context_sync
                                .handle_throw(
                                    throw.id,
                                    format!(
                                        "Cursor request context failed: {}",
                                        throw.error
                                    ),
                                )
                                .await
                            {
                                continue;
                            }
                            let Some(generation) = current.as_ref() else {
                                continue;
                            };
                            if generation
                                .tool_runtime
                                .is_interrupted(throw.id)
                                .await
                            {
                                generation
                                    .tool_runtime
                                    .discard_exec(throw.id)
                                    .await;
                                continue;
                            }
                            match generation
                                .tool_runtime
                                .take_exec(throw.id)
                                .await
                            {
                                Some(pending) => generation.results.send(
                                    compat::failure_with_message(
                                        &pending.call,
                                        format!(
                                            "Exec {} failed: {}",
                                            pending.call.call_id, throw.error
                                        ),
                                    ),
                                ),
                                None => tracing::warn!(
                                    id = throw.id,
                                    "ignoring failure for unknown tool execution"
                                ),
                            }
                        }
                        Some(Message::Heartbeat(_)) | None => {}
                    }
                }
                Some(
                    pb::agent_client_message::Message::InteractionResponse(
                        message,
                    ),
                ) => {
                    let Some(generation) = current.as_ref() else {
                        continue;
                    };
                    match generation.tools.interaction_response(&message).await
                    {
                        Ok(ClientToolEvent::Completed(completion)) => {
                            generation.results.send(*completion)
                        }
                        Ok(ClientToolEvent::Pending) => {}
                        Err(error) => generation.results.send_error(error),
                    }
                }
                Some(pb::agent_client_message::Message::KvClientMessage(
                    message,
                )) => {
                    let _ = blob_sync.handle_client(message).await;
                }
                // TODO: ConversationAction has two different delivery paths that
                // must not be conflated:
                //
                // 1. AgentRunRequest.action starts/resumes a Run. compile::prepare
                //    currently consumes UserMessageAction,
                //    BackgroundTaskCompletionAction, SummarizeAction and
                //    ExecutePlanAction. ResumeAction only works indirectly through
                //    the absence of a new runtime event and still needs an explicit
                //    implementation that consumes ResumeAction.request_context.
                // 2. AgentClientMessage::ConversationAction arrives while a Bidi Run
                //    is already active and needs a runtime dispatcher here. Supporting
                //    an Action in compile::prepare does not mean this path supports it.
                //
                // Cursor 3.16 sends a queued follow-up as InjectContextAction.
                // It targets expected_run_id and asks the active Run to yield to the
                // queued message. The session owns this path because interruption must
                // abort active execs and publish a recoverable checkpoint before the
                // old Run ends. It must not be reduced to handle.cancel() here.
                //
                // The remaining unimplemented Action variants are
                // ShellCommandAction, StartPlanAction,
                // AsyncAskQuestionCompletionAction, BackgroundShellAction,
                // BackgroundSubagentAction,
                // SubscriptionNotificationAction and GoalContinuationAction.
                // Variants whose wire behavior is not captured yet need evidence
                // before assigning semantics. Every unsupported runtime Action must
                // return an explicit Protocol Error rather than falling through silently.
                Some(
                    pb::agent_client_message::Message::ConversationAction(
                        conversation_action,
                    ),
                ) => match conversation_action.action.clone() {
                    Some(
                        pb::conversation_action::Action::UserMessageAction(
                            action,
                        ),
                    ) => {
                        let delivered_to_active_run =
                            current.as_ref().is_some_and(|generation| {
                                generation.run.lock().as_ref().is_some_and(
                                    |run| run.phase() == RunPhase::Running,
                                ) && generation
                                    .runtime_actions
                                    .send(compile::RuntimeAction::UserMessage(
                                        action.clone(),
                                    ))
                                    .is_ok()
                            });
                        if delivered_to_active_run {
                            continue;
                        }
                        let Some(previous) = current.as_ref() else {
                            continue;
                        };
                        let mut request = previous.request.clone();
                        request.action = Some(conversation_action);
                        request.conversation_state = None;
                        request.pre_fetched_blobs.clear();
                        *waiting_for_action = false;
                        start_generation(
                            &registry,
                            &handle,
                            &dependencies,
                            &blob_sync,
                            &context_sync,
                            &tool_runtime_factory,
                            current,
                            next_generation,
                            request,
                        )
                        .await;
                    }
                    Some(pb::conversation_action::Action::CancelAction(_)) => {
                        if let Some(generation) = current.as_ref() {
                            if let Some(run) = generation.run.lock().clone() {
                                run.cancel();
                            }
                            for id in
                                generation.tool_runtime.drain_running().await
                            {
                                let _ = handle.emit(&codec::abort(id));
                            }
                        }
                    }
                    Some(
                        pb::conversation_action::Action::InjectContextAction(
                            action,
                        ),
                    ) => {
                        let Some(generation) = current.as_ref() else {
                            continue;
                        };
                        if generation
                            .runtime_actions
                            .send(compile::RuntimeAction::Inject(action))
                            .is_err()
                        {
                            generation.results.send_error(crate::Error::Protocol(
                                "InjectContextAction arrived without an active Run"
                                    .into(),
                            ));
                        }
                    }
                    Some(
                        pb::conversation_action::Action::CancelSubagentAction(
                            action,
                        ),
                    ) => {
                        if let Some(generation) = current.as_ref() {
                            if let Some(id) = generation
                                .tool_runtime
                                .running_task_exec_id(&action.subagent_id)
                                .await
                            {
                                let _ = handle.emit(&codec::abort(id));
                            }
                        }
                    }
                    Some(action) => {
                        tracing::warn!(
                            request_id = handle.request_id(),
                            action = runtime_action_name(&action),
                            "ignoring unsupported runtime ConversationAction"
                        );
                    }
                    None => {
                        if let Some(generation) = current.as_ref() {
                            generation.results.send_error(
                                crate::Error::Protocol(
                                    "runtime ConversationAction has no action"
                                        .into(),
                                ),
                            );
                        }
                    }
                },
                _ => {}
            }
        }
    }

    AppendOutcome::Continue
}

pub(super) fn runtime_action_name(action: &pb::conversation_action::Action) -> &'static str {
    use pb::conversation_action::Action;

    match action {
        Action::UserMessageAction(_) => "UserMessageAction",
        Action::ResumeAction(_) => "ResumeAction",
        Action::CancelAction(_) => "CancelAction",
        Action::SummarizeAction(_) => "SummarizeAction",
        Action::ShellCommandAction(_) => "ShellCommandAction",
        Action::StartPlanAction(_) => "StartPlanAction",
        Action::ExecutePlanAction(_) => "ExecutePlanAction",
        Action::AsyncAskQuestionCompletionAction(_) => "AsyncAskQuestionCompletionAction",
        Action::CancelSubagentAction(_) => "CancelSubagentAction",
        Action::BackgroundTaskCompletionAction(_) => "BackgroundTaskCompletionAction",
        Action::BackgroundShellAction(_) => "BackgroundShellAction",
        Action::BackgroundSubagentAction(_) => "BackgroundSubagentAction",
        Action::SubscriptionNotificationAction(_) => "SubscriptionNotificationAction",
        Action::GoalContinuationAction(_) => "GoalContinuationAction",
        Action::InjectContextAction(_) => "InjectContextAction",
    }
}
