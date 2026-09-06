//! Classifies Cursor actions and selects their message delivery behavior.

use crate::{
    cursor::protocol::proto::agent::v1 as pb,
    model::{CanonicalMessage, RunId},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageDelivery {
    Ignore,
    InsertMessages,
    BreakMessages,
}

#[derive(Clone, Debug)]
pub struct CompiledMessages {
    pub event_id: String,
    pub target_run_id: Option<RunId>,
    pub messages: Vec<CanonicalMessage>,
    pub delivery: MessageDelivery,
}

impl CompiledMessages {
    pub fn ignored(event_id: impl Into<String>) -> Self {
        Self {
            event_id: event_id.into(),
            target_run_id: None,
            messages: Vec::new(),
            delivery: MessageDelivery::Ignore,
        }
    }
}

pub fn delivery(action: &pb::conversation_action::Action) -> MessageDelivery {
    use pb::conversation_action::Action;
    match action {
        Action::BackgroundTaskCompletionAction(_)
        | Action::BackgroundShellAction(_)
        | Action::BackgroundSubagentAction(_)
        | Action::AsyncAskQuestionCompletionAction(_)
        | Action::SubscriptionNotificationAction(_)
        | Action::GoalContinuationAction(_) => MessageDelivery::InsertMessages,
        Action::UserMessageAction(_) | Action::InjectContextAction(_) => {
            MessageDelivery::BreakMessages
        }
        Action::CancelAction(_)
        | Action::CancelSubagentAction(_)
        | Action::ResumeAction(_)
        | Action::SummarizeAction(_)
        | Action::ShellCommandAction(_)
        | Action::StartPlanAction(_)
        | Action::ExecutePlanAction(_) => MessageDelivery::Ignore,
    }
}
