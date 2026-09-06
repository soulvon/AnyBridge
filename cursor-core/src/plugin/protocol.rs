//! Defines newline-delimited messages exchanged with a plugin worker.
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMessage<'a> {
    Request {
        id: &'a str,
        method: &'a str,
        params: &'a serde_json::Value,
    },
    Cancel {
        id: &'a str,
    },
    HostResult {
        id: &'a str,
        result: &'a serde_json::Value,
    },
    HostError {
        id: &'a str,
        error: &'a str,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerMessage {
    Result {
        id: String,
        #[serde(default)]
        result: serde_json::Value,
        #[serde(default)]
        error: Option<String>,
    },
    /// 流式请求(provider.invoke)在最终 Result 之前发出的模型事件。
    Event {
        id: String,
        event: serde_json::Value,
    },
    HostCall {
        id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiplexed_host_call_and_events() {
        let message: WorkerMessage = serde_json::from_value(serde_json::json!({
            "type": "host_call",
            "id": "host-2",
            "requestId": "request-1",
            "method": "network.fetch",
            "params": { "url": "https://example.com" }
        }))
        .unwrap();
        match message {
            WorkerMessage::HostCall {
                id,
                request_id,
                method,
                ..
            } => {
                assert_eq!(id, "host-2");
                assert_eq!(request_id, "request-1");
                assert_eq!(method, "network.fetch");
            }
            _ => panic!("expected host call"),
        }

        let message: WorkerMessage = serde_json::from_value(serde_json::json!({
            "type": "event",
            "id": "request-1",
            "event": { "type": "text-delta", "text": "hi" }
        }))
        .unwrap();
        match message {
            WorkerMessage::Event { id, event } => {
                assert_eq!(id, "request-1");
                assert_eq!(event["type"], "text-delta");
            }
            _ => panic!("expected event"),
        }
    }
}
