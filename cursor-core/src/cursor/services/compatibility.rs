use axum::{
    body::Body,
    extract::{Extension, Request},
    http::Response,
};

use crate::{
    api::cursor::proxy::{self, CursorProxy},
    Result,
};

pub async fn available_docs(
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    forward(&proxy, request).await
}

pub async fn effective_user_plugins(
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    forward(&proxy, request).await
}

pub async fn user_privacy_mode(
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    forward(&proxy, request).await
}

pub async fn update_conversation_metadata(
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    forward(&proxy, request).await
}

async fn forward(proxy: &CursorProxy, request: Request<Body>) -> Result<Response<Body>> {
    proxy::forward(Extension(proxy.clone()), request).await
}
