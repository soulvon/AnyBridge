//! Implements local application control endpoints.
use axum::{extract::State, Json};
use serde::Deserialize;
use std::path::PathBuf;

use crate::{
    local_app::{CursorHarnessStatus, SetEnabled},
    Result,
};

use super::ControlService;

#[derive(Deserialize)]
pub struct SyncRoutesInput {
    pub routes_path: PathBuf,
    #[serde(default)]
    pub cursor_models_path: Option<PathBuf>,
    pub gateway_url: String,
}

pub async fn sync_routes(
    State(service): State<ControlService>,
    Json(input): Json<SyncRoutesInput>,
) -> Result<Json<Vec<crate::model::ModelConfig>>> {
    let key = std::env::var("ANYBRIDGE_LOCAL_PROXY_KEY")
        .map_err(|_| crate::Error::Config("AnyBridge local gateway key is unavailable".into()))?;
    Ok(Json(
        crate::anybridge::sync_routes_to_store(
            service.store(),
            &input.routes_path,
            input.cursor_models_path.as_deref(),
            &input.gateway_url,
            &key,
        )
        .await?,
    ))
}

pub async fn status(State(service): State<ControlService>) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().status().await?))
}

pub async fn initialize_ca(
    State(service): State<ControlService>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().initialize_ca().await?))
}

pub async fn set_enabled(
    State(service): State<ControlService>,
    Json(input): Json<SetEnabled>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(
        service.cursor_harness().set_enabled(input.enabled).await?,
    ))
}
