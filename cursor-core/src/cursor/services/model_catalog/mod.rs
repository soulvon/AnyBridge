//! Publishes the configured model catalog to Cursor.
use axum::{
    body::{Body, Bytes},
    extract::{Extension, State},
    http::{header, HeaderValue, Request, Response, StatusCode},
};
use bytes::{BufMut, BytesMut};
use prost::Message;

use crate::{
    api::cursor::proxy::{self, CursorProxy},
    cursor::{protocol::proto::agent::v1 as agent, transport::TransportRegistry},
    model::ModelConfig,
    plugin::PluginModelDescriptor,
    Error, Result,
};


mod builder;
mod proto;
#[cfg(test)]
mod tests;

use builder::{available_model, available_plugin_model, usable_model, usable_plugin_model};
use proto::{
    AvailableModelsAddition, DefaultModelNudgeDataResponse, DefaultModelResponse,
    UsableModelsAddition,
};

pub async fn available_models(
    State(registry): State<TransportRegistry>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let plugin_models = match registry.plugins() {
        Some(plugins) => plugins.configured_models().await,
        None => Vec::new(),
    };
    tracing::info!(
        model_count = models.len(),
        plugin_model_count = plugin_models.len(),
        "appending BYOK models to Cursor AvailableModels"
    );
    let mut available_models = models.iter().map(available_model).collect::<Vec<_>>();
    available_models.extend(plugin_models.iter().map(available_plugin_model));
    let local = AvailableModelsAddition {
        model_names: models
            .iter()
            .map(|model| model.model_hash.clone())
            .chain(plugin_models.iter().map(|model| model.id.clone()))
            .collect(),
        models: available_models,
    }
    .encode_to_vec();
    match proxy::forward_buffered(&proxy, request).await {
        Ok(upstream) => merge_response(upstream, local),
        Err(error) => {
            tracing::warn!(%error, "Cursor AvailableModels upstream unavailable; using local catalog");
            Ok(local_response(local))
        }
    }
}

pub async fn usable_models(
    State(registry): State<TransportRegistry>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let plugin_models = match registry.plugins() {
        Some(plugins) => plugins.configured_models().await,
        None => Vec::new(),
    };
    tracing::info!(
        model_count = models.len(),
        plugin_model_count = plugin_models.len(),
        "appending BYOK models to Cursor GetUsableModels"
    );
    let local = UsableModelsAddition {
        models: models
            .iter()
            .map(usable_model)
            .chain(plugin_models.iter().map(usable_plugin_model))
            .collect(),
    }
    .encode_to_vec();
    match proxy::forward_buffered(&proxy, request).await {
        Ok(upstream) => merge_response(upstream, local),
        Err(error) => {
            tracing::warn!(%error, "Cursor GetUsableModels upstream unavailable; using local catalog");
            Ok(local_response(local))
        }
    }
}

pub async fn default_model_for_cli(
    State(registry): State<TransportRegistry>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let plugin_models = configured_plugin_models(&registry).await;
    Ok(local_response(
        agent::GetDefaultModelForCliResponse {
            model: default_model_details(&models, &plugin_models),
        }
        .encode_to_vec(),
    ))
}

pub async fn default_model(State(registry): State<TransportRegistry>) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let plugin_models = configured_plugin_models(&registry).await;
    Ok(local_response(
        default_model_response(&models, &plugin_models).encode_to_vec(),
    ))
}

pub async fn default_model_nudge(
    State(registry): State<TransportRegistry>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let plugin_models = configured_plugin_models(&registry).await;
    Ok(local_response(
        default_model_nudge_response(&models, &plugin_models).encode_to_vec(),
    ))
}

async fn configured_plugin_models(registry: &TransportRegistry) -> Vec<PluginModelDescriptor> {
    match registry.plugins() {
        Some(plugins) => plugins.configured_models().await,
        None => Vec::new(),
    }
}

fn default_model_details(
    models: &[ModelConfig],
    plugin_models: &[PluginModelDescriptor],
) -> Option<agent::ModelDetails> {
    models
        .first()
        .map(usable_model)
        .or_else(|| plugin_models.first().map(usable_plugin_model))
}

fn default_model_id<'a>(
    models: &'a [ModelConfig],
    plugin_models: &'a [PluginModelDescriptor],
) -> &'a str {
    models
        .first()
        .map(|model| model.model_hash.as_str())
        .or_else(|| plugin_models.first().map(|model| model.id.as_str()))
        .unwrap_or_default()
}

fn default_model_response(
    models: &[ModelConfig],
    plugin_models: &[PluginModelDescriptor],
) -> DefaultModelResponse {
    let model = default_model_id(models, plugin_models).to_owned();
    DefaultModelResponse {
        thinking_model: model.clone(),
        model,
        max_mode: false,
        next_default_set_date: String::new(),
    }
}

fn default_model_nudge_response(
    models: &[ModelConfig],
    plugin_models: &[PluginModelDescriptor],
) -> DefaultModelNudgeDataResponse {
    DefaultModelNudgeDataResponse {
        nudge_date: "0".into(),
        should_default_switch_on_new_chat: false,
        models_with_no_default_switch: models
            .iter()
            .map(|model| model.model_hash.clone())
            .chain(plugin_models.iter().map(|model| model.id.clone()))
            .collect(),
        conversion_model_override: String::new(),
    }
}

fn merge_response(upstream: proxy::BufferedResponse, extra: Vec<u8>) -> Result<Response<Body>> {
    if !upstream.status.is_success() {
        tracing::warn!(status = %upstream.status, "Cursor model catalog upstream rejected request; using local catalog");
        return Ok(local_response(extra));
    }
    let (framed, payload) = unary_payload(&upstream.body)?;
    let body = if framed {
        let mut merged = BytesMut::with_capacity(5 + payload.len() + extra.len());
        merged.put_u8(0);
        merged.put_u32((payload.len() + extra.len()) as u32);
        merged.extend_from_slice(payload);
        merged.extend_from_slice(&extra);
        merged.freeze()
    } else {
        let mut merged = BytesMut::with_capacity(payload.len() + extra.len());
        merged.extend_from_slice(payload);
        merged.extend_from_slice(&extra);
        merged.freeze()
    };
    Ok(upstream.with_body(body))
}

fn local_response(body: Vec<u8>) -> Response<Body> {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/proto"),
    );
    response
}

fn unary_payload(body: &Bytes) -> Result<(bool, &[u8])> {
    if body.len() < 5 {
        return Ok((false, body));
    }
    let flags = body[0];
    let length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]) as usize;
    if length != body.len() - 5 {
        return Ok((false, body));
    }
    if flags != 0 {
        return Err(Error::Protocol(format!(
            "cannot merge compressed or terminal model catalog frame: flags={flags}"
        )));
    }
    Ok((true, &body[5..]))
}
