//! Defines canonical append-only Conversation Messages.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ToolImageReference, ToolRoundId};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Prompt,
    User,
    Runtime,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolCallContent {
    pub index: usize,
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolResultContent {
    pub call_id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ToolImageReference>,
    #[serde(skip)]
    pub provider_parts: Vec<ContentPart>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ProviderReplayState {
    pub provider_kind: String,
    pub value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    Image {
        mime_type: String,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageContent {
    Parts {
        parts: Vec<ContentPart>,
    },
    Assistant {
        text: String,
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_round_id: Option<ToolRoundId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replay_state: Option<ProviderReplayState>,
        tool_calls: Vec<ToolCallContent>,
    },
    ToolResult(ToolResultContent),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CanonicalMessage {
    pub message_id: String,
    pub role: Role,
    pub origin: Origin,
    pub content: MessageContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_event_id: Option<String>,
}

impl CanonicalMessage {
    pub fn text(
        message_id: impl Into<String>,
        role: Role,
        origin: Origin,
        text: impl Into<String>,
    ) -> Self {
        Self {
            message_id: message_id.into(),
            role,
            origin,
            content: MessageContent::Parts {
                parts: vec![ContentPart::Text { text: text.into() }],
            },
            runtime_event_id: None,
        }
    }

    pub fn parts(
        message_id: impl Into<String>,
        role: Role,
        origin: Origin,
        parts: Vec<ContentPart>,
    ) -> Self {
        Self {
            message_id: message_id.into(),
            role,
            origin,
            content: MessageContent::Parts { parts },
            runtime_event_id: None,
        }
    }
}

mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(data: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(data))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        STANDARD.decode(encoded).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeEvent {
    pub event_id: String,
    pub text: String,
}

impl RuntimeEvent {
    pub fn into_message(self) -> CanonicalMessage {
        CanonicalMessage {
            message_id: format!("runtime:{}", self.event_id),
            role: Role::User,
            origin: Origin::Runtime,
            content: MessageContent::Parts {
                parts: vec![ContentPart::Text { text: self.text }],
            },
            runtime_event_id: Some(self.event_id),
        }
    }
}
