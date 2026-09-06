//! Defines Run identity, preparation, and action types.
use serde::{Deserialize, Serialize};

use super::{
    CanonicalMessage, CheckpointId, ConversationId, ModelSpec, PromptSpec, RunId, ToolCall,
    ToolRoundAssistant,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SubagentKind {
    GeneralPurpose,
    Named(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum RunKind {
    Root,
    Subagent {
        parent_run_id: RunId,
        parent_tool_call_id: String,
        kind: SubagentKind,
        background: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SubagentModelOverride {
    Explicit(ModelSpec),
    Inherit,
    Disabled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum RunAction {
    Start,
    Compact,
    Resume {
        pending_tool_round: Option<RecoveredToolRound>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecoveredToolRound {
    pub assistant: ToolRoundAssistant,
    pub calls: Vec<ToolCall>,
    pub started_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PreparedRun {
    pub run_id: RunId,
    pub cursor_request_id: Option<String>,
    pub conversation_id: ConversationId,
    pub kind: RunKind,
    pub model: ModelSpec,
    pub prompt: PromptSpec,
    pub initial_messages: Vec<CanonicalMessage>,
    pub action: RunAction,
    pub base_checkpoint_id: CheckpointId,
}
