//! Keeps Cursor Agent traffic on the endpoint selected with `agent -e`.
use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
};
use prost::Message;

use crate::Result;

/// 0 = 不干预（沿用客户端默认）。
///
/// 曾经下发 `1`（force all disabled）把客户端按在 HTTP/1.1 上，代价是 Cursor 3.27
/// 会把 `AgentRunRequest.conversation_state` 降级成「会话 UUID 引用」形态，
/// 字段布局随之变化，BYOK 侧按完整结构解析会连续报 `invalid wire type`
/// （summary → mcp_tools 一路漂移，2026-11-01 实测）。保持 h2 才能收到完整结构。
const HTTP2_CONFIG_UNSPECIFIED: i32 = 0;

#[derive(Clone, PartialEq, Message)]
struct ServerConfigResponse {
    #[prost(string, tag = "6")]
    config_version: String,
    #[prost(int32, tag = "7")]
    http2_config: i32,
    #[prost(bool, optional, tag = "28")]
    cli_sandbox_default_enabled: Option<bool>,
}

pub async fn get() -> Result<Response<Body>> {
    let payload = server_config().encode_to_vec();
    let mut response = Response::new(Body::from(payload));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/proto"),
    );
    Ok(response)
}

fn server_config() -> ServerConfigResponse {
    ServerConfigResponse {
        config_version: "cursor_byok_local_agent_v1".into(),
        http2_config: HTTP2_CONFIG_UNSPECIFIED,
        cli_sandbox_default_enabled: Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// 必须保持 h2 默认：强制关闭会让 Cursor 3.27 降级 conversation_state 形态，
    /// 导致 BYOK 侧连续解码失败（2026-11-01 实测 summary → mcp_tools 漂移）。
    fn keeps_http2_enabled_for_full_conversation_state() {
        let config = server_config();
        assert_eq!(config.http2_config, HTTP2_CONFIG_UNSPECIFIED);
        assert_eq!(config.cli_sandbox_default_enabled, Some(true));
    }
}
