//! Defines normalized provider streaming events.
use crate::model::{ProviderReplayState, Usage};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    Length,
    ToolUse,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    Start {
        model_call_id: String,
    },
    TextStart,
    TextDelta(String),
    TextEnd,
    ThinkingStart,
    ThinkingDelta(String),
    ThinkingEnd,
    ToolCallStart {
        index: usize,
        call_id: String,
        name: String,
    },
    ToolCallArgumentsDelta {
        index: usize,
        delta: String,
    },
    ToolCallEnd {
        index: usize,
    },
    ProviderReplayState(ProviderReplayState),
    Usage(Usage),
    Done(FinishReason),
}

/// Returns whether an event represents the first valid upstream response.
/// Transport markers, replay metadata, usage, completion, and provider heartbeats
/// are intentionally excluded; empty text/reasoning/tool deltas are valid events.
pub fn is_valid_response_event(event: &ModelEvent) -> bool {
    matches!(
        event,
        ModelEvent::TextDelta(_)
            | ModelEvent::ThinkingStart
            | ModelEvent::ThinkingDelta(_)
            | ModelEvent::ThinkingEnd
            | ModelEvent::ToolCallStart { .. }
            | ModelEvent::ToolCallArgumentsDelta { .. }
            | ModelEvent::ToolCallEnd { .. }
    )
}
