//! 解析 `AgentRunRequest.conversation_state` 的两种线上形态。
//!
//! Cursor 3.27 在强制 HTTP/1.1 时（`cursor.general.disableHttp2` 或服务端
//! `http2_config = FORCE_ALL_DISABLED`）会把这个字段降级成「36 字节会话 UUID
//! 引用」，此时完整状态由客户端自己的本地库维护；HTTP/2 下才是完整的
//! `ConversationStateStructure`。
//!
//! 旧实现在 proto 里直接声明成 message，一旦客户端降级就整轮报
//! `invalid wire type`（2026-11-01 实测：同一个 Cursor 3.27.22，去掉
//! disableHttp2 立即恢复正常）。所以这里统一按 bytes 收，再按形态分派。
use prost::Message as _;

use crate::{cursor::protocol::proto::agent::v1 as pb, Error, Result};

/// 解析完整状态；引用形态返回 `None`（状态需由本地 checkpoint 提供）。
pub fn decode(request: &pb::AgentRunRequest) -> Result<Option<pb::ConversationStateStructure>> {
    let Some(raw) = request.conversation_state.as_deref() else {
        return Ok(None);
    };
    if raw.is_empty() || reference(raw).is_some() {
        return Ok(None);
    }
    pb::ConversationStateStructure::decode(raw)
        .map(Some)
        .map_err(|error| Error::Protocol(format!("invalid conversation_state: {error}")))
}

/// 引用形态：36 字节 ASCII UUID（`c6cfb091-1df4-4b9b-883b-28136bf819e4`）。
pub fn reference(raw: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(raw).ok()?;
    let shaped = text.len() == 36 && text.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    shaped.then_some(text)
}

/// 会话标识：优先 `conversation_id` 字段，其次引用形态里的 UUID。
pub fn conversation_id(request: &pb::AgentRunRequest) -> Option<String> {
    request
        .conversation_id
        .clone()
        .filter(|id| !id.is_empty())
        .or_else(|| {
            request
                .conversation_state
                .as_deref()
                .and_then(reference)
                .map(str::to_owned)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(state: Option<&[u8]>) -> pb::AgentRunRequest {
        pb::AgentRunRequest {
            conversation_state: state.map(<[u8]>::to_vec),
            ..Default::default()
        }
    }

    /// 降级形态必须被识别成引用，而不是拿去当 protobuf 解（那会报 wire type 错）。
    #[test]
    fn uuid_reference_is_not_decoded_as_structure() {
        let uuid = b"c6cfb091-1df4-4b9b-883b-28136bf819e4";
        assert_eq!(reference(uuid), Some("c6cfb091-1df4-4b9b-883b-28136bf819e4"));
        assert!(decode(&request(Some(uuid))).unwrap().is_none());
        assert_eq!(
            conversation_id(&request(Some(uuid))).as_deref(),
            Some("c6cfb091-1df4-4b9b-883b-28136bf819e4")
        );
    }

    /// 完整结构仍要能解出 mode / pending_tool_calls 等字段。
    #[test]
    fn full_structure_still_decodes() {
        let state = pb::ConversationStateStructure {
            mode: Some(pb::AgentMode::Agent as i32),
            pending_tool_calls: vec!["pending-1".into()],
            ..Default::default()
        };
        let raw = state.encode_to_vec();
        let decoded = decode(&request(Some(&raw))).unwrap().expect("structure");
        assert_eq!(decoded.mode, Some(pb::AgentMode::Agent as i32));
        assert_eq!(decoded.pending_tool_calls, vec!["pending-1".to_string()]);
    }

    /// 空字段等价于「没有状态」。
    #[test]
    fn empty_state_is_none() {
        assert!(decode(&request(None)).unwrap().is_none());
        assert!(decode(&request(Some(b""))).unwrap().is_none());
    }
}
