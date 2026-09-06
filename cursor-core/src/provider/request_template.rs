//! Renders per-invocation placeholders in user-configured provider request values.

const SESSION_ID_PLACEHOLDER: &str = "{{SessionId}}";

pub(super) fn render_json_strings(
    value: &serde_json::Value,
    conversation_id: &str,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(value.replace(SESSION_ID_PLACEHOLDER, conversation_id))
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .iter()
                .map(|value| render_json_strings(value, conversation_id))
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(name, value)| (name.clone(), render_json_strings(value, conversation_id)))
                .collect(),
        ),
        value => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_session_id_in_nested_json_string_values() {
        let template = serde_json::json!({
            "session": "{{SessionId}}",
            "nested": {
                "label": "conversation={{SessionId}}/{{SessionId}}",
                "values": ["{{SessionId}}", 42, true, null]
            }
        });

        assert_eq!(
            render_json_strings(&template, "cursor-conversation-id"),
            serde_json::json!({
                "session": "cursor-conversation-id",
                "nested": {
                    "label": "conversation=cursor-conversation-id/cursor-conversation-id",
                    "values": ["cursor-conversation-id", 42, true, null]
                }
            })
        );
    }

    #[test]
    fn leaves_json_property_names_and_unrelated_strings_unchanged() {
        let template = serde_json::json!({
            "{{SessionId}}": "literal",
            "other": "{{sessionId}}"
        });

        assert_eq!(
            render_json_strings(&template, "cursor-conversation-id"),
            template
        );
    }
}
