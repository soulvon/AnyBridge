//! Keeps Cursor Agent traffic on the endpoint selected with `agent -e`.
use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
};
use prost::Message;

use crate::Result;

const HTTP2_CONFIG_FORCE_ALL_DISABLED: i32 = 1;

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
        http2_config: HTTP2_CONFIG_FORCE_ALL_DISABLED,
        cli_sandbox_default_enabled: Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forces_agent_cli_to_use_the_selected_legacy_endpoint() {
        let config = server_config();
        assert_eq!(config.http2_config, HTTP2_CONFIG_FORCE_ALL_DISABLED);
        assert_eq!(config.cli_sandbox_default_enabled, Some(true));
    }
}
