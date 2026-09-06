//! Projects streaming Tool arguments to Cursor updates.
use crate::{
    cursor::{
        protocol::{
            json_stream::{JsonStringFields, StringFieldEvent},
            proto::agent::v1 as pb,
        },
        tools::codec as interaction,
    },
    model::ToolCall,
    Result,
};

pub struct ToolCallStream {
    presentation: Presentation,
}

enum Presentation {
    Plain,
    DynamicMcp(pb::McpToolDefinition),
    Edit(EditProjection),
    CreatePlan(CreatePlanProjection),
    Task(TaskProjection),
}

struct EditProjection {
    fields: JsonStringFields,
    path_field: &'static str,
    content_field: &'static str,
    path: String,
    content: NewlineStream,
}

#[derive(Default)]
struct CreatePlanProjection {
    fields: JsonStringFields,
    name: String,
    plan: String,
    overview: String,
}

#[derive(Default)]
struct TaskProjection {
    fields: JsonStringFields,
    description: String,
    prompt: String,
    subagent_type: String,
    model: String,
    resume: String,
    environment: String,
}

impl ToolCallStream {
    pub fn new(name: &str, dynamic_mcp: Option<&pb::McpToolDefinition>) -> Self {
        let presentation = match dynamic_mcp {
            Some(definition) => Presentation::DynamicMcp(definition.clone()),
            None => match normalized(name).as_str() {
                "write" => Presentation::Edit(EditProjection::new("path", "contents")),
                "strreplace" => Presentation::Edit(EditProjection::new("path", "new_string")),
                "editnotebook" => {
                    Presentation::Edit(EditProjection::new("target_notebook", "new_string"))
                }
                "createplan" => Presentation::CreatePlan(CreatePlanProjection::default()),
                "task" => Presentation::Task(TaskProjection::default()),
                _ => Presentation::Plain,
            },
        };
        Self { presentation }
    }

    pub fn arguments_delta(
        &mut self,
        call: &ToolCall,
        raw_delta: &str,
    ) -> Result<Vec<pb::AgentServerMessage>> {
        match &mut self.presentation {
            Presentation::Plain => Ok(vec![interaction::arguments_delta(call, raw_delta)?]),
            Presentation::DynamicMcp(definition) => {
                Ok(vec![interaction::dynamic_mcp_arguments_delta(
                    call, raw_delta, definition,
                )])
            }
            Presentation::Edit(edit) => {
                let mut messages = Vec::new();
                edit.project(call, raw_delta, &mut messages)?;
                Ok(messages)
            }
            Presentation::CreatePlan(plan) => plan.project(call, raw_delta),
            Presentation::Task(task) => task.project(call, raw_delta),
        }
    }
}

impl TaskProjection {
    fn project(&mut self, call: &ToolCall, raw_delta: &str) -> Result<Vec<pb::AgentServerMessage>> {
        let mut description_completed = false;
        for event in self.fields.push(raw_delta)? {
            match event {
                StringFieldEvent::Delta { name, text } => match name.as_str() {
                    "description" => self.description.push_str(&text),
                    "prompt" => self.prompt.push_str(&text),
                    "subagent_type" => self.subagent_type.push_str(&text),
                    "model" => self.model.push_str(&text),
                    "resume" => self.resume.push_str(&text),
                    "environment" => self.environment.push_str(&text),
                    _ => {}
                },
                StringFieldEvent::End { name } if name == "description" => {
                    description_completed = true
                }
                _ => {}
            }
        }
        Ok(description_completed
            .then(|| {
                interaction::task_partial(
                    call,
                    &self.description,
                    &self.prompt,
                    &self.subagent_type,
                    &self.model,
                    &self.resume,
                    &self.environment,
                )
            })
            .into_iter()
            .collect())
    }
}

impl CreatePlanProjection {
    fn project(&mut self, call: &ToolCall, raw_delta: &str) -> Result<Vec<pb::AgentServerMessage>> {
        let mut completed_field = false;
        for event in self.fields.push(raw_delta)? {
            match event {
                StringFieldEvent::Delta { name, text } => match name.as_str() {
                    "name" => self.name.push_str(&text),
                    "plan" => self.plan.push_str(&text),
                    "overview" => self.overview.push_str(&text),
                    _ => {}
                },
                StringFieldEvent::End { name }
                    if matches!(name.as_str(), "name" | "plan" | "overview") =>
                {
                    completed_field = true
                }
                _ => {}
            }
        }
        Ok(completed_field
            .then(|| interaction::create_plan_partial(call, &self.name, &self.plan, &self.overview))
            .into_iter()
            .collect())
    }
}

impl EditProjection {
    fn new(path_field: &'static str, content_field: &'static str) -> Self {
        Self {
            fields: JsonStringFields::default(),
            path_field,
            content_field,
            path: String::new(),
            content: NewlineStream::default(),
        }
    }

    fn project(
        &mut self,
        call: &ToolCall,
        raw_delta: &str,
        messages: &mut Vec<pb::AgentServerMessage>,
    ) -> Result<()> {
        for event in self.fields.push(raw_delta)? {
            match event {
                StringFieldEvent::Delta { name, text } if name == self.path_field => {
                    self.path.push_str(&text)
                }
                StringFieldEvent::End { name } if name == self.path_field => {
                    messages.push(interaction::edit_path_partial(call, &self.path));
                }
                StringFieldEvent::Delta { name, text } if name == self.content_field => {
                    let content = self.content.push(&text, false);
                    if !content.is_empty() {
                        messages.push(interaction::edit_content_delta(call, content));
                    }
                }
                StringFieldEvent::End { name } if name == self.content_field => {
                    let content = self.content.push("", true);
                    if !content.is_empty() {
                        messages.push(interaction::edit_content_delta(call, content));
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct NewlineStream {
    pending_cr: bool,
}

impl NewlineStream {
    fn push(&mut self, text: &str, finished: bool) -> String {
        let mut output = String::with_capacity(text.len());
        for character in text.chars() {
            if self.pending_cr {
                output.push('\n');
                self.pending_cr = false;
                if character == '\n' {
                    continue;
                }
            }
            if character == '\r' {
                self.pending_cr = true;
            } else {
                output.push(character);
            }
        }
        if finished && self.pending_cr {
            output.push('\n');
            self.pending_cr = false;
        }
        output
    }
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_call(arguments_text: &str) -> ToolCall {
        ToolCall {
            index: 0,
            call_id: "task-1".into(),
            model_call_id: "model-1".into(),
            name: "Task".into(),
            arguments_text: arguments_text.into(),
            arguments: serde_json::Value::Null,
            argument_error: None,
        }
    }

    #[test]
    fn task_description_projects_a_visible_partial_card_before_execution() {
        let mut stream = ToolCallStream::new("Task", None);
        let first = r#"{"description":"Review K10"#;
        assert!(stream
            .arguments_delta(&task_call(first), first)
            .unwrap()
            .is_empty());

        let closing = "\",";
        let messages = stream
            .arguments_delta(&task_call(&format!("{first}{closing}")), closing)
            .unwrap();
        assert_eq!(messages.len(), 1);
        let Some(pb::agent_server_message::Message::InteractionUpdate(update)) =
            messages[0].message.as_ref()
        else {
            panic!("expected interaction update")
        };
        let Some(pb::interaction_update::Message::PartialToolCall(partial)) =
            update.message.as_ref()
        else {
            panic!("expected partial tool call")
        };
        let tool_call = partial.tool_call.as_ref().expect("expected tool call");
        assert_eq!(tool_call.started_at_ms, None);
        let Some(pb::tool_call::Tool::TaskToolCall(task)) = tool_call.tool.as_ref() else {
            panic!("expected Task tool call")
        };
        let args = task.args.as_ref().expect("expected partial Task args");
        assert_eq!(args.description, "Review K10");
        assert_eq!(args.prompt, "");
    }
}
