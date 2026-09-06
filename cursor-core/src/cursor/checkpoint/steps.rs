//! Buffers Conversation steps that have not yet been persisted.
use std::time::Duration;

use crate::cursor::{protocol::proto::agent::v1 as pb, tools::tool_call_result::ToolCompletion};

#[derive(Default)]
pub struct PendingSteps {
    pub steps: Vec<pb::ConversationStep>,
    pub read_paths: Vec<String>,
}

#[derive(Default)]
pub struct StepBuffer {
    steps: Vec<pb::ConversationStep>,
    read_paths: Vec<String>,
    text: String,
    thinking: String,
}

impl StepBuffer {
    pub fn text_delta(&mut self, delta: &str) {
        self.text.push_str(delta);
    }

    pub fn finish_text(&mut self) {
        if self.text.is_empty() {
            return;
        }
        self.steps.push(pb::ConversationStep {
            message: Some(pb::conversation_step::Message::AssistantMessage(
                pb::AssistantMessage {
                    text: std::mem::take(&mut self.text),
                },
            )),
        });
    }

    pub fn thinking_delta(&mut self, delta: &str) {
        self.thinking.push_str(delta);
    }

    pub fn finish_thinking(&mut self, duration: Duration) {
        if self.thinking.is_empty() {
            return;
        }
        self.steps.push(pb::ConversationStep {
            message: Some(pb::conversation_step::Message::ThinkingMessage(
                pb::ThinkingMessage {
                    text: std::mem::take(&mut self.thinking),
                    duration_ms: duration.as_millis().min(u32::MAX as u128) as u32,
                },
            )),
        });
    }

    pub fn tool_completed(&mut self, completion: &ToolCompletion) {
        if let Some(pb::tool_call::Tool::ReadToolCall(read)) = &completion.tool_call().tool {
            if matches!(
                read.result
                    .as_ref()
                    .and_then(|result| result.result.as_ref()),
                Some(pb::read_tool_result::Result::Success(_))
            ) {
                if let Some(path) = read.args.as_ref().map(|args| &args.path) {
                    if !path.is_empty() && !self.read_paths.contains(path) {
                        self.read_paths.push(path.clone());
                    }
                }
            }
        }
        self.steps.push(pb::ConversationStep {
            message: Some(pb::conversation_step::Message::ToolCall(
                completion.tool_call().clone(),
            )),
        });
    }

    pub fn finish_model_attempt(&mut self) {
        self.finish_text();
        self.finish_thinking(Duration::ZERO);
    }

    pub fn discard_model_output(&mut self) {
        self.text.clear();
        self.thinking.clear();
        self.steps.retain(|step| {
            !matches!(
                step.message,
                Some(
                    pb::conversation_step::Message::AssistantMessage(_)
                        | pb::conversation_step::Message::ThinkingMessage(_)
                )
            )
        });
    }

    pub fn take(&mut self) -> PendingSteps {
        PendingSteps {
            steps: std::mem::take(&mut self.steps),
            read_paths: std::mem::take(&mut self.read_paths),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_attempt_output_is_retained_for_the_next_checkpoint() {
        let mut buffer = StepBuffer::default();
        buffer.text_delta("partial answer");
        buffer.thinking_delta("partial reasoning");

        buffer.finish_model_attempt();

        let steps = buffer.take().steps;
        assert_eq!(steps.len(), 2);
        assert!(matches!(
            &steps[0].message,
            Some(pb::conversation_step::Message::AssistantMessage(message))
                if message.text == "partial answer"
        ));
        assert!(matches!(
            &steps[1].message,
            Some(pb::conversation_step::Message::ThinkingMessage(message))
                if message.text == "partial reasoning"
        ));
    }

    #[test]
    fn interrupted_model_output_is_not_persisted_as_checkpoint_steps() {
        let mut buffer = StepBuffer::default();
        buffer.text_delta("partial answer");
        buffer.finish_text();
        buffer.thinking_delta("partial reasoning");
        buffer.finish_thinking(Duration::from_millis(25));

        buffer.discard_model_output();

        assert!(buffer.take().steps.is_empty());
    }
}
