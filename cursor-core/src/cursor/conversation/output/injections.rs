use std::collections::{HashMap, HashSet};

use crate::{
    cursor::{
        compile::{compile_injection, compile_user_message_action},
        protocol::events,
        protocol::proto::agent::v1 as pb,
        tools::{codec, tool_call_result::ToolCompletion},
    },
    model::{ConversationId, ToolRoundId},
    run::CommandResult,
    Error, Result,
};

use super::super::{CompiledMessages, MessageDelivery};
use super::ConversationOutput;

pub(super) struct PendingInjection {
    pub(super) user_message: Option<pb::UserMessage>,
    pub(super) delivery_batch_id: String,
}

pub(super) struct InjectionState<'a> {
    pub(super) active_round: Option<&'a ToolRoundId>,
    pub(super) active_tool_calls: &'a HashSet<String>,
    completions: &'a HashMap<String, ToolCompletion>,
    pub(super) interrupted_rounds: &'a mut HashSet<ToolRoundId>,
    pub(super) interrupted_tool_calls: &'a mut HashSet<String>,
}

impl ConversationOutput {
    pub(super) async fn forward_completion(
        &self,
        mut completion: ToolCompletion,
        completions: &mut HashMap<String, ToolCompletion>,
        interrupted_tool_calls: &HashSet<String>,
    ) -> Result<Option<ToolCompletion>> {
        if interrupted_tool_calls.contains(&completion.result().call_id) {
            return Ok(None);
        }
        if let Some(image) = completion.take_read_image() {
            let blob_id = self.store.put_blob(&image.data, &[]).await?;
            completion.persist_read_image(&blob_id, &image)?;
        }
        let result = completion.result();
        if result.call_id.is_empty() {
            return Err(Error::Protocol("tool result call_id is empty".into()));
        }
        if completions.contains_key(&result.call_id) {
            return Err(Error::Protocol(format!(
                "duplicate tool result call_id: {}",
                result.call_id
            )));
        }
        if !accept_tool_completion(
            self.run.tool_result(result.clone()).await,
            &self.context.request_id,
            self.run.run_id().as_str(),
            &result.call_id,
        )? {
            return Ok(None);
        }
        completions.insert(result.call_id.clone(), completion.clone());
        let Some(dispatched) = self.tools.continue_after(&result.call_id).await? else {
            return Ok(None);
        };
        for message in dispatched.messages {
            self.handle.emit(&message)?;
        }
        Ok(dispatched.completion)
    }

    pub(super) async fn forward_user_message(
        &mut self,
        action: pb::UserMessageAction,
        active_round: Option<&ToolRoundId>,
        active_tool_calls: &HashSet<String>,
        completions: &HashMap<String, ToolCompletion>,
        interrupted_rounds: &mut HashSet<ToolRoundId>,
        interrupted_tool_calls: &mut HashSet<String>,
    ) -> Result<()> {
        let user_message = action.user_message.clone().ok_or_else(|| {
            Error::Protocol("Cursor user message action has no UserMessage".into())
        })?;
        let injection_id = format!("user-message:{}", user_message.message_id);
        let message = compile_user_message_action(
            &action,
            self.context.mode,
            &self.compiler,
            &self.blob_sync,
        )
        .await?;
        self.queue_injection(
            injection_id,
            Some(user_message),
            message,
            InjectionState {
                active_round,
                active_tool_calls,
                completions,
                interrupted_rounds,
                interrupted_tool_calls,
            },
        )
        .await
    }

    pub(super) async fn forward_injection(
        &mut self,
        action: pb::InjectContextAction,
        active_round: Option<&ToolRoundId>,
        active_tool_calls: &HashSet<String>,
        completions: &HashMap<String, ToolCompletion>,
        interrupted_rounds: &mut HashSet<ToolRoundId>,
        interrupted_tool_calls: &mut HashSet<String>,
    ) -> Result<()> {
        if action.injection_id.is_empty() {
            return Err(Error::Protocol(
                "InjectContextAction has no injection_id".into(),
            ));
        }
        if self.injection_ids.contains(&action.injection_id) {
            return Ok(());
        }
        if action.expected_run_id != self.context.request_id {
            let reason = format!(
                "InjectContextAction expected run {}, active run is {}",
                action.expected_run_id, self.context.request_id
            );
            self.handle.emit(&events::context_injection_rejected(
                action.injection_id.clone(),
                reason,
            ))?;
            self.injection_ids.insert(action.injection_id);
            return Ok(());
        }
        let user_message = match action.payload.as_ref() {
            Some(pb::inject_context_action::Payload::UserContext(context)) => {
                context.user_message.clone()
            }
            _ => None,
        };
        let message =
            compile_injection(&action, self.context.mode, &self.compiler, &self.blob_sync).await?;
        self.queue_injection(
            action.injection_id,
            user_message,
            message,
            InjectionState {
                active_round,
                active_tool_calls,
                completions,
                interrupted_rounds,
                interrupted_tool_calls,
            },
        )
        .await
    }

    pub(super) async fn queue_injection(
        &mut self,
        injection_id: String,
        user_message: Option<pb::UserMessage>,
        message: crate::model::CanonicalMessage,
        state: InjectionState<'_>,
    ) -> Result<()> {
        let delivery_batch_id = injection_id.clone();
        self.injection_ids.insert(injection_id.clone());
        self.pending_injections.insert(
            injection_id.clone(),
            PendingInjection {
                user_message,
                delivery_batch_id,
            },
        );
        self.handle
            .emit(&events::context_injection_queued(injection_id.clone()))?;
        state.interrupted_tool_calls.extend(
            state
                .active_tool_calls
                .iter()
                .filter(|call_id| !state.completions.contains_key(*call_id))
                .cloned(),
        );
        if let Some(round_id) = state.active_round {
            state.interrupted_rounds.insert(round_id.clone());
        }
        self.interrupt_execs().await;
        let event_id = message
            .runtime_event_id
            .clone()
            .ok_or_else(|| Error::Protocol("runtime message has no event identity".into()))?;
        let registry = self.registry.clone();
        let conversation_id = ConversationId::new(&self.context.exec.conversation_id);
        tokio::spawn(async move {
            let _ = registry
                .deliver(
                    &conversation_id,
                    CompiledMessages {
                        event_id,
                        target_run_id: None,
                        messages: vec![message],
                        delivery: MessageDelivery::BreakMessages,
                    },
                )
                .await;
        });
        Ok(())
    }

    pub(super) async fn interrupt_execs(&self) {
        for id in self.tools.interrupt_for_message().await {
            let _ = self.handle.emit(&codec::abort(id));
        }
    }
}

pub(super) fn accept_tool_completion(
    delivery: CommandResult,
    request_id: &str,
    run_id: &str,
    call_id: &str,
) -> Result<bool> {
    match delivery {
        CommandResult::Applied | CommandResult::Duplicate => Ok(true),
        CommandResult::RunClosing | CommandResult::RunEnded => {
            tracing::warn!(
                request_id,
                run_id,
                call_id,
                ?delivery,
                "ignoring ToolCompletion delivered after Run stopped accepting results"
            );
            Ok(false)
        }
        CommandResult::StaleTarget => Err(Error::RunNotFound(request_id.into())),
    }
}
