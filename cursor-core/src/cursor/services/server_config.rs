//! Keeps Cursor Agent traffic on the endpoint selected with `agent -e`.
use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
};
use prost::Message;

use crate::Result;

/// 0 = 不干预（沿用客户端默认）。
///
/// 曾经下发 `1`（force all disabled）把客户端按在 HTTP/1.1 上。Cursor 3.27 在该
/// 模式下会切到 InferenceService 两段式（RunInferenceSSE + BidiAppend），其请求体
/// 是全新的 RunInferenceRunRequest 布局，事件流是 InferenceStreamResponse 协议，
/// 与 agent.v1 的 AgentRunRequest / AgentServerMessage 完全不兼容，BYOK 侧按旧
/// 结构解析会连续报 `invalid wire type`（2026-11-01 实测）。不干预后客户端走
/// h2 + agent.v1.RunSSE，那是本实现完整支撑的链路。
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
    fn forces_agent_cli_to_use_the_selected_legacy_endpoint() {
        let config = server_config();
        assert_eq!(config.http2_config, HTTP2_CONFIG_UNSPECIFIED);
        assert_eq!(config.cli_sandbox_default_enabled, Some(true));
    }
}
