//! Records Cursor request traces without blocking request or runtime paths.

mod event;
mod worker;

use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};

use bytes::Bytes;
use tokio::sync::mpsc;

use crate::store::{BlobId, Store};

use event::{TraceEvent, TRACE_DISABLED, TRACE_UNKNOWN};

const TRACE_QUEUE_CAPACITY: usize = 512;

#[derive(Clone)]
pub struct CursorTraceService {
    sender: mpsc::Sender<TraceEvent>,
}

impl CursorTraceService {
    pub fn new(store: Store) -> Self {
        let (sender, receiver) = mpsc::channel(TRACE_QUEUE_CAPACITY);
        tokio::spawn(worker::run(store, receiver));
        Self { sender }
    }

    pub fn recorder(&self, request_id: &str) -> CursorTraceRecorder {
        CursorTraceRecorder {
            request_id: Arc::from(request_id),
            sender: self.sender.clone(),
            finished: Arc::new(AtomicBool::new(false)),
            activation: Arc::new(AtomicU8::new(TRACE_UNKNOWN)),
        }
    }
}

#[derive(Clone)]
pub struct CursorTraceRecorder {
    request_id: Arc<str>,
    sender: mpsc::Sender<TraceEvent>,
    finished: Arc<AtomicBool>,
    activation: Arc<AtomicU8>,
}

impl CursorTraceRecorder {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn begin(&self, conversation_id: Option<&str>, route: &str, model_id: Option<&str>) {
        self.send_control(TraceEvent::Begin {
            request_id: self.request_id.to_string(),
            activation: self.activation.clone(),
            conversation_id: conversation_id.map(str::to_owned),
            route: route.to_owned(),
            model_id: model_id.map(str::to_owned),
        });
    }

    pub fn resume(&self) {
        self.send_control(TraceEvent::Resume {
            request_id: self.request_id.to_string(),
            activation: self.activation.clone(),
        });
    }

    pub fn request(&self, artifact_type: &str, data: Bytes, metadata: serde_json::Value) {
        self.send(TraceEvent::Request {
            request_id: self.request_id.to_string(),
            artifact_type: artifact_type.to_owned(),
            data,
            metadata,
        });
    }

    pub fn artifact(
        &self,
        artifact_type: &str,
        source: &str,
        data: &[u8],
        metadata: serde_json::Value,
    ) {
        self.send(TraceEvent::Artifact {
            request_id: self.request_id.to_string(),
            artifact_type: artifact_type.to_owned(),
            source: source.to_owned(),
            data: Bytes::copy_from_slice(data),
            metadata,
        });
    }

    pub fn linked_blob(
        &self,
        artifact_type: &str,
        source: &str,
        blob_id: &BlobId,
        metadata: serde_json::Value,
    ) {
        self.send(TraceEvent::LinkedBlob {
            request_id: self.request_id.to_string(),
            artifact_type: artifact_type.to_owned(),
            source: source.to_owned(),
            blob_id: blob_id.clone(),
            metadata,
        });
    }

    pub fn response_started(&self, status: u16) {
        self.send(TraceEvent::ResponseStarted {
            request_id: self.request_id.to_string(),
            status,
        });
    }

    pub fn response_chunk(&self, source: &str, data: Bytes) {
        if self.finished.load(Ordering::Acquire) {
            return;
        }
        self.send(TraceEvent::ResponseChunk {
            request_id: self.request_id.to_string(),
            source: source.to_owned(),
            data,
        });
    }

    pub fn finish(&self, error: Option<&str>) {
        if self.finished.swap(true, Ordering::AcqRel) {
            return;
        }
        self.send_control(TraceEvent::Finish {
            request_id: self.request_id.to_string(),
            error: error.map(str::to_owned),
        });
    }

    fn send(&self, event: TraceEvent) {
        if self.activation.load(Ordering::Acquire) == TRACE_DISABLED {
            return;
        }
        self.send_control(event);
    }

    fn send_control(&self, event: TraceEvent) {
        if let Err(error) = self.sender.try_send(event) {
            tracing::warn!(
                request_id = %self.request_id,
                %error,
                "dropping Cursor trace event"
            );
        }
    }
}
