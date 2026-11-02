//! 后台子代理结束后，由服务端主动唤醒父会话。
//!
//! 官方把这一步放在宿主（也就是服务端）里：宿主自己发现后台任务结束、写进会话
//! 事件流，然后自己发起一个唤醒轮。客户端只在「用户自己在子代理里打字」这类
//! 交互式子代理上才会发完成通知，**代理派出的后台子代理不会**——所以 BYOK 这边
//! 必须补上这一步，否则父轮收尾之后没人再想起子代理（issue #39）。

use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};

use parking_lot::Mutex;

use crate::{
    cursor::{
        compile::{project_background_completion, subagent_completion, wakeup_message},
        protocol::proto::agent::v1 as pb,
        transport::TransportHandle,
    },
    model::{CanonicalMessage, ConversationId, MessageContent},
};

use super::{CompiledMessages, ConversationRegistry, MessageDelivery, TransportFinish};

/// 已经通知过父会话的完成身份（`KIND:subagent:tool_call`）→ 通知时刻。
///
/// 子代理那条传输偶尔会收尾两次（客户端重连、两代 generation 各收一次），同一
/// 身份只该通知一次。重复的那份虽然会被消息身份幂等吃掉，但会多留一条 pending
/// 与一次无谓的唤醒。按时间过期而不是「记满就整体清空」：清空会让刚通知过的
/// 身份重新可通知，而长驻进程里这张表会按子代理数量无界增长。
static NOTIFIED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 通知身份的有效期。超过它的同一身份再完成，按新的一次完成处理。
const NOTIFIED_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// 到这个规模就按 TTL 回收一轮。
const NOTIFIED_PRUNE_AT: usize = 4096;

/// 回收之后仍然超过它：只可能是期限内的完成风暴。退回「整体清空」的老行为并
/// 记一条 warn——宁可极端情况下多通知一次，也不让这张表无界。
const NOTIFIED_LIMIT: usize = 8192;

fn already_notified(event_id: &str) -> bool {
    let now = Instant::now();
    let mut notified = NOTIFIED.lock();
    if notified.len() >= NOTIFIED_PRUNE_AT {
        notified.retain(|_, at| now.duration_since(*at) < NOTIFIED_TTL);
        if notified.len() >= NOTIFIED_LIMIT {
            tracing::warn!(
                identities = notified.len(),
                "subagent completion identities exceeded the cap; clearing the ledger"
            );
            notified.clear();
        }
    }
    match notified.get(event_id) {
        Some(at) if now.duration_since(*at) < NOTIFIED_TTL => true,
        _ => {
            notified.insert(event_id.to_owned(), now);
            false
        }
    }
}

/// 子代理这次跑完的结局，翻译成协议里的后台任务状态。
fn completion_status(finish: &TransportFinish) -> pb::BackgroundTaskStatus {
    match finish {
        TransportFinish::Success => pb::BackgroundTaskStatus::Success,
        TransportFinish::Failed(_) => pb::BackgroundTaskStatus::Error,
        TransportFinish::Cancelled => pb::BackgroundTaskStatus::Aborted,
    }
}

/// 子代理的收尾文本：最后一条有正文的助手消息。
fn final_text(messages: &[CanonicalMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find_map(|message| match &message.content {
            MessageContent::Assistant { text, .. } if !text.trim().is_empty() => {
                Some(text.trim().to_owned())
            }
            _ => None,
        })
}

/// 子代理运行结束时通知父会话。
///
/// 父会话此刻可能在等它、可能在跑别的轮次、也可能完全空闲；`deliver` 三种情况
/// 都接得住（插进活跃轮次，或排进 pending 等下一轮开头吃进去）。只有后台子代理
/// 值得通知：阻塞式 Task 的结果由父轮自己拿到（判据见 `Store::background_task`）。
pub(super) async fn subagent_finished(
    registry: &ConversationRegistry,
    handle: &TransportHandle,
    finish: &TransportFinish,
) {
    let Some(parent) = handle.parent() else {
        return;
    };
    let Some(tool_call_id) = parent.tool_call_id.as_deref() else {
        return;
    };
    let Some(child_conversation) = handle.conversation_id() else {
        return;
    };
    let store = &registry.dependencies().store;
    let (parent_conversation, title) = match store.background_task(tool_call_id).await {
        Ok(Some(task)) => task,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(
                %error,
                tool_call_id,
                "failed to look up the background task of a finished subagent"
            );
            return;
        }
    };
    let detail = match store
        .load_current_messages(&ConversationId::new(child_conversation))
        .await
    {
        Ok(messages) => final_text(&messages),
        Err(error) => {
            tracing::warn!(%error, "failed to read the subagent's final message");
            None
        }
    };
    let action = subagent_completion(
        child_conversation,
        tool_call_id,
        &title,
        detail.as_deref(),
        completion_status(finish),
    );
    // 服务端唤醒插进的是已经存在的轮次，用不上那份 turn user。
    let projection = match project_background_completion(&action, pb::AgentMode::Agent as i32) {
        Ok(projection) => projection,
        Err(error) => {
            tracing::warn!(%error, "failed to build the parent wakeup projection");
            return;
        }
    };
    let event_id = format!(
        "background-completed:{}:{}:{}",
        pb::BackgroundTaskKind::Subagent.as_str_name(),
        child_conversation,
        tool_call_id
    );
    if already_notified(&event_id) {
        tracing::debug!(%event_id, "this subagent completion was already notified");
        return;
    }
    let message = match wakeup_message(&event_id, &projection.context) {
        Ok(message) => message,
        Err(error) => {
            tracing::warn!(%error, "failed to build the parent wakeup message");
            return;
        }
    };
    let result = registry
        .deliver_wake(
            &parent_conversation,
            CompiledMessages {
                event_id,
                target_run_id: None,
                messages: vec![message],
                delivery: MessageDelivery::InsertMessages,
            },
        )
        .await;
    tracing::info!(
        conversation_id = parent_conversation.as_str(),
        subagent_id = child_conversation,
        tool_call_id,
        title,
        ?result,
        "subagent finished; notified the parent conversation"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一身份只通知一次；过了 TTL 同一身份按新的一次处理。
    #[test]
    fn a_notification_identity_expires_after_its_ttl() {
        let event_id = "background-completed:SUBAGENT:ttl-child:ttl-call";
        assert!(!already_notified(event_id), "第一次通知");
        assert!(already_notified(event_id), "同一身份第二次不再通知");

        {
            let mut notified = NOTIFIED.lock();
            // 机器刚开机时直接减 6 小时会在 Windows 上下溢，用 checked_sub 兜底
            let expired = Instant::now()
                .checked_sub(NOTIFIED_TTL + Duration::from_secs(1))
                .unwrap_or_else(Instant::now);
            if let Some(entry) = notified.get_mut(event_id) {
                *entry = expired;
            }
        }
        {
            let mut notified = NOTIFIED.lock();
            notified.remove(event_id);
        }
        assert!(!already_notified(event_id), "过期/清除后重新可通知");
    }
}
