use std::sync::{atomic::AtomicU8, Arc};

use bytes::Bytes;

use crate::store::BlobId;

pub(super) const TRACE_UNKNOWN: u8 = 0;
pub(super) const TRACE_ACTIVE: u8 = 1;
pub(super) const TRACE_DISABLED: u8 = 2;

pub(super) enum TraceEvent {
    Begin {
        request_id: String,
        activation: Arc<AtomicU8>,
        conversation_id: Option<String>,
        route: String,
        model_id: Option<String>,
    },
    Resume {
        request_id: String,
        activation: Arc<AtomicU8>,
    },
    Request {
        request_id: String,
        artifact_type: String,
        data: Bytes,
        metadata: serde_json::Value,
    },
    Artifact {
        request_id: String,
        artifact_type: String,
        source: String,
        data: Bytes,
        metadata: serde_json::Value,
    },
    LinkedBlob {
        request_id: String,
        artifact_type: String,
        source: String,
        blob_id: BlobId,
        metadata: serde_json::Value,
    },
    ResponseStarted {
        request_id: String,
        status: u16,
    },
    ResponseChunk {
        request_id: String,
        source: String,
        data: Bytes,
    },
    Finish {
        request_id: String,
        error: Option<String>,
    },
}

impl TraceEvent {
    pub(super) fn request_id(&self) -> &str {
        match self {
            Self::Begin { request_id, .. }
            | Self::Resume { request_id, .. }
            | Self::Request { request_id, .. }
            | Self::Artifact { request_id, .. }
            | Self::LinkedBlob { request_id, .. }
            | Self::ResponseStarted { request_id, .. }
            | Self::ResponseChunk { request_id, .. }
            | Self::Finish { request_id, .. } => request_id,
        }
    }
}
