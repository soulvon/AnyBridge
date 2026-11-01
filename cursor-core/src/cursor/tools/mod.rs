//! Exposes the extensible Cursor Tool system.
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use tokio::sync::Mutex;

pub mod codec;
pub(crate) mod compat;
pub(crate) mod edit;
pub(crate) mod registry;
pub mod runtime;
mod schedule;
pub(crate) mod stream;
mod tool_call_dispatch;
pub(crate) mod tool_call_result;

use crate::{
    model::{CanonicalMessage, MessageContent, Role, ToolCall},
    search::{WebCache, WebFetch, WebSearch},
    store::Store,
    Error, Result,
};

use self::schedule::{DeferredEdit, EditSchedule};
use self::tool_call_result::{ToolCompletion, ToolResultSender};
use super::protocol::proto::agent::v1 as pb;
use runtime::{CursorToolRuntime, ExecContext};

#[derive(Clone)]
pub struct ToolDispatcher {
    runtime: CursorToolRuntime,
    results: ToolResultSender,
    search: WebSearch,
    fetch: WebFetch,
    store: Option<Store>,
    edit_schedule: Arc<Mutex<EditSchedule>>,
}

pub struct DispatchedTool {
    pub messages: Vec<pb::AgentServerMessage>,
    pub completion: Option<ToolCompletion>,
}

pub struct ToolBatchState<'a> {
    pub completed: &'a HashSet<String>,
    pub started: &'a HashSet<String>,
    pub response_text: &'a str,
    pub response_thinking: &'a str,
}

pub enum ClientToolEvent {
    Completed(Box<ToolCompletion>),
    Pending,
}

impl ToolDispatcher {
    pub fn new(runtime: CursorToolRuntime) -> Self {
        let (results, _) = tool_call_result::tool_result_channel();
        Self {
            runtime,
            results,
            search: WebSearch::built_in(),
            fetch: WebFetch::built_in(),
            store: None,
            edit_schedule: Arc::new(Mutex::new(EditSchedule::default())),
        }
    }

    pub fn with_results(
        runtime: CursorToolRuntime,
        results: ToolResultSender,
        store: Store,
        web_cache: WebCache,
    ) -> Self {
        Self {
            runtime,
            results,
            search: WebSearch::managed(store.clone()),
            fetch: WebFetch::managed(store.clone(), web_cache),
            store: Some(store),
            edit_schedule: Arc::new(Mutex::new(EditSchedule::default())),
        }
    }

    pub async fn start_batch(
        &self,
        calls: &[ToolCall],
        state: ToolBatchState<'_>,
        messages: &[CanonicalMessage],
        dynamic_mcp: &BTreeMap<String, pb::McpToolDefinition>,
        context: &ExecContext,
    ) -> Result<Vec<DispatchedTool>> {
        let first_tool_index = current_turn_step_count(messages)
            + usize::from(!state.response_thinking.is_empty())
            + usize::from(!state.response_text.is_empty())
            + 1;
        let mut dispatched = Vec::new();
        for (position, call) in calls.iter().enumerate() {
            if state.completed.contains(&call.call_id) {
                continue;
            }
            let message_index = first_tool_index + position;
            let publish_started = !state.started.contains(&call.call_id);
            if let Some(error) = &call.argument_error {
                dispatched.push(validation_failure(call, error.clone()));
                continue;
            }
            let edit_path = if dynamic_mcp.contains_key(&call.name) {
                None
            } else {
                match edit::execution_path(call) {
                    Ok(path) => path,
                    Err(error) => {
                        dispatched.push(recover_validation_failure(call, error)?);
                        continue;
                    }
                }
            };
            if let Some(path) = edit_path {
                let next = self.edit_schedule.lock().await.start_or_defer(
                    path,
                    DeferredEdit {
                        call: call.clone(),
                        message_index,
                        publish_started,
                        context: context.clone(),
                    },
                );
                let Some(next) = next else {
                    continue;
                };
                let started = self
                    .start(
                        &next.call,
                        next.message_index,
                        next.publish_started,
                        dynamic_mcp,
                        &next.context,
                    )
                    .await;
                dispatched.push(match started {
                    Ok(started) => started,
                    Err(error) => recover_validation_failure(&next.call, error)?,
                });
                continue;
            }
            let started = self
                .start(call, message_index, publish_started, dynamic_mcp, context)
                .await;
            dispatched.push(match started {
                Ok(started) => started,
                Err(error) => recover_validation_failure(call, error)?,
            });
        }
        Ok(dispatched)
    }

    pub(crate) async fn continue_after(&self, call_id: &str) -> Result<Option<DispatchedTool>> {
        let next = self.edit_schedule.lock().await.complete(call_id)?;
        let Some(next) = next else {
            return Ok(None);
        };
        match self
            .start(
                &next.call,
                next.message_index,
                next.publish_started,
                &BTreeMap::new(),
                &next.context,
            )
            .await
        {
            Ok(started) => Ok(Some(started)),
            Err(error) => recover_validation_failure(&next.call, error).map(Some),
        }
    }

    pub async fn interrupt_for_message(&self) -> Vec<u32> {
        self.edit_schedule.lock().await.clear();
        self.runtime.interrupt_for_message().await
    }

    async fn start(
        &self,
        call: &ToolCall,
        message_index: usize,
        publish_started: bool,
        dynamic_mcp: &BTreeMap<String, pb::McpToolDefinition>,
        context: &ExecContext,
    ) -> Result<DispatchedTool> {
        let call = context.prepare_call(call)?;
        let mut messages = if publish_started {
            vec![codec::tool_started(&call, dynamic_mcp.get(&call.name))?]
        } else {
            Vec::new()
        };
        let started = tool_call_dispatch::start(
            &self.runtime,
            &self.results,
            &call,
            message_index,
            dynamic_mcp,
            context,
            self.store.as_ref(),
        )
        .await?;
        messages.extend(started.messages);
        Ok(DispatchedTool {
            messages,
            completion: started.completion,
        })
    }

    pub async fn interaction_response(
        &self,
        response: &pb::InteractionResponse,
    ) -> Result<ClientToolEvent> {
        if self.runtime.is_interrupted(response.id).await {
            return Ok(ClientToolEvent::Pending);
        }
        let pending = match self.runtime.take_interaction(response.id).await {
            Some(pending) => pending,
            None if self.runtime.completed_call(response.id).await.is_some() => {
                tracing::warn!(
                    id = response.id,
                    "ignoring duplicate terminal interaction response"
                );
                return Ok(ClientToolEvent::Pending);
            }
            None => {
                tracing::warn!(
                    id = response.id,
                    "ignoring response for unknown interaction"
                );
                return Ok(ClientToolEvent::Pending);
            }
        };
        let call = pending.call.clone();
        let continuation = match tool_call_dispatch::resume_interaction(
            &self.results,
            &self.search,
            &self.fetch,
            pending,
            response,
        )
        .await
        {
            Ok(continuation) => continuation,
            Err(Error::Protocol(message)) => {
                return Ok(ClientToolEvent::Completed(Box::new(
                    compat::failure_with_message(&call, message),
                )));
            }
            Err(Error::Json(error)) => {
                return Ok(ClientToolEvent::Completed(Box::new(
                    compat::failure_with_message(&call, error.to_string()),
                )));
            }
            Err(error) => return Err(error),
        };
        Ok(match continuation {
            tool_call_dispatch::InteractionContinuation::Completed(completion) => {
                ClientToolEvent::Completed(completion)
            }
            tool_call_dispatch::InteractionContinuation::Pending => ClientToolEvent::Pending,
        })
    }

    /// 后台子代理结算：客户端回传 `BackgroundTaskCompletion` 时，用它把仍在等待的
    /// Task exec 结算掉。缺了这步父 run 会一直停在「已派发子代理」，客户端随后
    /// 把它显示成 Stopped（issue #39）。
    pub async fn settle_background_tasks(
        &self,
        completions: &[pb::BackgroundTaskCompletion],
    ) -> Result<Vec<ToolCompletion>> {
        let mut settled = Vec::new();
        for completion in completions {
            let status = completion.status;
            let terminal = status == pb::BackgroundTaskStatus::Success as i32
                || status == pb::BackgroundTaskStatus::Error as i32
                || status == pb::BackgroundTaskStatus::Aborted as i32;
            if !terminal {
                continue;
            }
            let Some(tool_call_id) = completion
                .tool_call_id
                .as_deref()
                .filter(|id| !id.is_empty())
            else {
                tracing::warn!(status, "background task completion without tool_call_id");
                continue;
            };
            let Some(pending) = self.take_pending_task(tool_call_id).await else {
                tracing::info!(
                    tool_call_id,
                    status,
                    "background task completion without a pending Task exec"
                );
                continue;
            };
            let text = completion
                .detail
                .clone()
                .filter(|text| !text.is_empty())
                .or_else(|| Some(completion.title.clone()))
                .unwrap_or_default();
            let message = if status == pb::BackgroundTaskStatus::Success as i32 {
                pb::exec_client_message::Message::SubagentResult(pb::SubagentResult {
                    result: Some(pb::subagent_result::Result::Success(pb::SubagentSuccess {
                        agent_id: completion.subagent_id.clone().unwrap_or_default(),
                        final_message: Some(text),
                        tool_call_count: 0,
                        background_reason: pb::SubagentBackgroundReason::Unspecified as i32,
                        transcript_path: None,
                    })),
                })
            } else {
                pb::exec_client_message::Message::SubagentResult(pb::SubagentResult {
                    result: Some(pb::subagent_result::Result::Error(pb::SubagentError {
                        agent_id: completion.subagent_id.clone(),
                        error: text,
                    })),
                })
            };
            settled.push(tool_call_result::from_exec_settled(pending, &message)?);
        }
        Ok(settled)
    }

    /// `BackgroundSubagentAction` 只带 tool_call_id、没有结论正文：命中挂起 Task 时
    /// 明确按「已结束但未回传结论」结算，避免父 run 永久等待。
    pub async fn settle_background_subagent(
        &self,
        tool_call_id: &str,
    ) -> Result<Option<ToolCompletion>> {
        let Some(pending) = self.take_pending_task(tool_call_id).await else {
            return Ok(None);
        };
        let message = pb::exec_client_message::Message::SubagentResult(pb::SubagentResult {
            result: Some(pb::subagent_result::Result::Success(pb::SubagentSuccess {
                // 这条 Action 只有 tool_call_id：派生一个稳定 id，
                // 保证客户端能把结果关联回这条 Task。
                agent_id: format!("subagent-{tool_call_id}"),
                final_message: Some(
                    "子代理已结束，但客户端没有回传结论正文（AnyBridge 已按完成结算）。".into(),
                ),
                tool_call_count: 0,
                background_reason: pb::SubagentBackgroundReason::Unspecified as i32,
                transcript_path: None,
            })),
        });
        Ok(Some(tool_call_result::from_exec_settled(pending, &message)?))
    }

    async fn take_pending_task(&self, tool_call_id: &str) -> Option<runtime::PendingExec> {
        let id = self.runtime.running_task_exec_id(tool_call_id).await?;
        self.runtime.take_exec(id).await
    }
}

fn validation_failure(call: &ToolCall, message: String) -> DispatchedTool {
    DispatchedTool {
        messages: Vec::new(),
        completion: Some(compat::failure_with_message(call, message)),
    }
}

fn recover_validation_failure(call: &ToolCall, error: Error) -> Result<DispatchedTool> {
    match error {
        Error::Protocol(message) => Ok(validation_failure(call, message)),
        Error::Json(error) => Ok(validation_failure(call, error.to_string())),
        error => Err(error),
    }
}

fn current_turn_step_count(messages: &[CanonicalMessage]) -> usize {
    let turn_start = messages
        .iter()
        .rposition(|message| message.role == Role::User)
        .map_or(0, |position| position + 1);
    messages[turn_start..]
        .iter()
        .map(|message| match &message.content {
            MessageContent::Assistant {
                text,
                thinking,
                tool_calls,
                ..
            } => {
                usize::from(!thinking.is_empty()) + usize::from(!text.is_empty()) + tool_calls.len()
            }
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task_call(call_id: &str) -> ToolCall {
        ToolCall {
            index: 0,
            call_id: call_id.into(),
            model_call_id: "model-call".into(),
            name: "Task".into(),
            arguments_text: "{}".into(),
            arguments: json!({
                "run_in_background": true,
                "subagent_type": "generalPurpose",
                "description": "do work",
                "model": "m",
                "prompt": "p"
            }),
            argument_error: None,
        }
    }

    fn dispatcher() -> ToolDispatcher {
        ToolDispatcher::new(CursorToolRuntime::default())
    }

    fn subagent_context() -> ExecContext {
        ExecContext {
            default_subagent_model: "m".into(),
            ..Default::default()
        }
    }

    fn background_task(tool_call_id: &str, detail: &str) -> pb::BackgroundTaskCompletion {
        pb::BackgroundTaskCompletion {
            task_id: "task-1".into(),
            status: pb::BackgroundTaskStatus::Success as i32,
            title: "子代理".into(),
            detail: Some(detail.into()),
            tool_call_id: Some(tool_call_id.into()),
            subagent_id: Some("agent-1".into()),
            ..Default::default()
        }
    }

    fn task_is_background(completion: &ToolCompletion) -> bool {
        match completion.tool_call().tool.as_ref() {
            Some(pb::tool_call::Tool::TaskToolCall(task)) => {
                match task.result.as_ref().and_then(|result| result.result.as_ref()) {
                    Some(pb::task_result::Result::Success(success)) => success.is_background,
                    other => panic!("expected task success, got {other:?}"),
                }
            }
            other => panic!("expected TaskToolCall, got {other:?}"),
        }
    }

    /// 客户端回传后台子代理结论时，挂起的 Task 必须结算成「已完成 + 带结论」，
    /// 否则父对话一直停在 Stopped（issue #39）。
    #[tokio::test]
    async fn background_task_completion_settles_pending_task() {
        let dispatcher = dispatcher();
        dispatcher
            .runtime
            .reserve_exec(&task_call("call-1"), &subagent_context())
            .await
            .unwrap();

        let settled = dispatcher
            .settle_background_tasks(&[background_task("call-1", "子代理的结论")])
            .await
            .expect("settle 不应报错");

        assert_eq!(settled.len(), 1, "挂起的 Task 必须被结算");
        assert!(!task_is_background(&settled[0]), "结算后不能再标记后台运行中");
        assert!(settled[0].result().content.contains("子代理的结论"));
        assert!(
            dispatcher
                .settle_background_tasks(&[background_task("call-1", "x")])
                .await
                .expect("duplicate settle 不应报错")
                .is_empty(),
            "重复通知不得二次结算"
        );
    }

    /// BackgroundSubagentAction 只有 tool_call_id，也必须能解除等待，不能静默丢弃。
    #[tokio::test]
    async fn background_subagent_action_settles_pending_task() {
        let dispatcher = dispatcher();
        dispatcher
            .runtime
            .reserve_exec(&task_call("call-2"), &subagent_context())
            .await
            .unwrap();

        let settled = dispatcher
            .settle_background_subagent("call-2")
            .await
            .expect("settle 不应报错")
            .expect("挂起的 Task 应被结算");
        assert!(!task_is_background(&settled));
        assert!(
            dispatcher
                .settle_background_subagent("call-2")
                .await
                .expect("duplicate settle 不应报错")
                .is_none(),
            "重复通知不得二次结算"
        );
    }

    /// 非终结状态（进度上报）不得结算，避免把还在跑的子代理标成完成。
    #[tokio::test]
    async fn progress_completion_does_not_settle_task() {
        let dispatcher = dispatcher();
        dispatcher
            .runtime
            .reserve_exec(&task_call("call-3"), &subagent_context())
            .await
            .unwrap();

        let mut progress = background_task("call-3", "50%");
        progress.status = pb::BackgroundTaskStatus::Unspecified as i32;
        assert!(dispatcher
            .settle_background_tasks(&[progress])
            .await
            .expect("progress 不应报错")
            .is_empty());
    }
}
