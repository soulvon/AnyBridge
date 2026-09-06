//! Synchronizes content-addressed blobs with Cursor.
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::sync::{oneshot, Mutex};

use crate::{
    cursor::protocol::proto::agent::v1 as pb,
    cursor::services::observability::CursorTraceRecorder,
    cursor::transport::TransportHandle,
    store::{BlobEdge, BlobId, Store},
    Error, Result,
};

type BlobSetSender = oneshot::Sender<Result<()>>;

const SET_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const GET_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct BlobSynchronizer {
    inner: Arc<Inner>,
}

struct Inner {
    request_id: String,
    store: Store,
    handle: TransportHandle,
    next_id: AtomicU32,
    set_requests: Mutex<HashMap<u32, PendingSet>>,
    acked_blobs: Mutex<HashSet<BlobId>>,
    get_requests: Mutex<HashMap<u32, PendingGet>>,
}

struct PendingSet {
    blob_id: BlobId,
    sent_at: std::time::Instant,
    result: BlobSetSender,
}

struct PendingGet {
    blob_id: BlobId,
    result: oneshot::Sender<Result<Option<Vec<u8>>>>,
}

impl BlobSynchronizer {
    pub fn new(request_id: String, store: Store, handle: TransportHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                request_id,
                store,
                handle,
                next_id: AtomicU32::new(1),
                set_requests: Mutex::new(HashMap::new()),
                acked_blobs: Mutex::new(HashSet::new()),
                get_requests: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn request_id(&self) -> &str {
        &self.inner.request_id
    }

    pub(crate) fn trace(&self) -> Option<&CursorTraceRecorder> {
        self.inner.handle.trace()
    }

    pub async fn persist(&self, data: &[u8], edges: &[BlobEdge]) -> Result<BlobId> {
        let id = self.inner.store.put_blob(data, edges).await?;
        let result = self.ensure_set(&id, data).await;
        if let Some(trace) = self.inner.handle.trace() {
            trace.linked_blob(
                "blob_set",
                "byok_server",
                &id,
                serde_json::json!({
                    "byte_count": data.len(),
                    "status": if result.is_ok() { "acknowledged" } else { "error" },
                    "error": result.as_ref().err().map(ToString::to_string),
                    "edges": edges.iter().map(|edge| serde_json::json!({
                        "child_blob_id": edge.child.to_base64(),
                        "field_name": edge.field_name,
                    })).collect::<Vec<_>>(),
                }),
            );
        }
        result?;
        Ok(id)
    }

    async fn ensure_set(&self, blob_id: &BlobId, data: &[u8]) -> Result<()> {
        if self.inner.acked_blobs.lock().await.contains(blob_id) {
            return Ok(());
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.set_requests.lock().await.insert(
            id,
            PendingSet {
                blob_id: blob_id.clone(),
                sent_at: std::time::Instant::now(),
                result: sender,
            },
        );
        if let Err(error) = self.inner.handle.emit(&pb::AgentServerMessage {
            ttft_breakdown: None,
            message: Some(pb::agent_server_message::Message::KvServerMessage(
                pb::KvServerMessage {
                    id,
                    span_context: None,
                    message: Some(pb::kv_server_message::Message::SetBlobArgs(
                        pb::SetBlobArgs {
                            blob_id: blob_id.as_bytes().to_vec(),
                            blob_data: data.to_vec(),
                        },
                    )),
                },
            )),
        }) {
            self.inner.set_requests.lock().await.remove(&id);
            return Err(error);
        }
        let cancellation = self.inner.handle.disconnect_token();
        let result = tokio::select! {
            result = receiver => result.map_err(|_| Error::Protocol("KV SET response channel closed".into()))?,
            _ = cancellation.cancelled() => Err(Error::Cancelled),
            _ = tokio::time::sleep(SET_TIMEOUT) => Err(Error::Protocol(format!("KV SET timed out: {}", blob_id.to_base64()))),
        };
        if result.is_err() {
            self.inner.set_requests.lock().await.remove(&id);
        }
        result
    }

    pub async fn get(&self, blob_id: &BlobId) -> Result<Option<Vec<u8>>> {
        if let Some(data) = self.inner.store.get_blob(blob_id).await? {
            if let Some(trace) = self.inner.handle.trace() {
                trace.linked_blob(
                    "blob_get",
                    "byok_server",
                    blob_id,
                    serde_json::json!({
                        "byte_count": data.len(),
                        "source": "local_store",
                        "status": "found",
                    }),
                );
            }
            return Ok(Some(data));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.get_requests.lock().await.insert(
            id,
            PendingGet {
                blob_id: blob_id.clone(),
                result: sender,
            },
        );
        self.inner.handle.emit(&pb::AgentServerMessage {
            ttft_breakdown: None,
            message: Some(pb::agent_server_message::Message::KvServerMessage(
                pb::KvServerMessage {
                    id,
                    span_context: None,
                    message: Some(pb::kv_server_message::Message::GetBlobArgs(
                        pb::GetBlobArgs {
                            blob_id: blob_id.as_bytes().to_vec(),
                        },
                    )),
                },
            )),
        })?;
        let cancellation = self.inner.handle.disconnect_token();
        let result = tokio::select! {
            result = receiver => result.map_err(|_| Error::Protocol("KV GET response channel closed".into()))?,
            _ = cancellation.cancelled() => Err(Error::Cancelled),
            _ = tokio::time::sleep(GET_TIMEOUT) => Err(Error::Protocol(format!("KV GET timed out: {}", blob_id.to_base64()))),
        };
        if result.is_err() {
            self.inner.get_requests.lock().await.remove(&id);
        }
        if let Some(trace) = self.inner.handle.trace() {
            match &result {
                Ok(Some(data)) => {
                    trace.linked_blob(
                        "blob_get",
                        "cursor_client",
                        blob_id,
                        serde_json::json!({
                            "byte_count": data.len(),
                            "source": "cursor_client",
                            "status": "found",
                        }),
                    );
                }
                Ok(None) => {
                    trace.artifact(
                        "blob_get",
                        "cursor_client",
                        &[],
                        serde_json::json!({
                            "blob_id": blob_id.to_base64(),
                            "status": "missing",
                        }),
                    );
                }
                Err(error) => {
                    trace.artifact(
                        "blob_get",
                        "cursor_client",
                        &[],
                        serde_json::json!({
                            "blob_id": blob_id.to_base64(),
                            "status": "error",
                            "error": error.to_string(),
                        }),
                    );
                }
            }
        }
        result
    }

    pub async fn cache_received(&self, blob_id: &BlobId, data: &[u8]) -> Result<()> {
        let actual = BlobId::digest(data);
        if actual != *blob_id {
            return Err(Error::Protocol(format!(
                "received Blob hash mismatch: expected {}, got {}",
                blob_id.to_base64(),
                actual.to_base64()
            )));
        }
        self.inner.store.put_blob(data, &[]).await?;
        Ok(())
    }

    pub async fn handle_client(&self, message: pb::KvClientMessage) -> Result<()> {
        match message.message {
            Some(pb::kv_client_message::Message::SetBlobResult(result)) => {
                if let Some(pending) = self.inner.set_requests.lock().await.remove(&message.id) {
                    if let Some(error) = result.error {
                        tracing::error!(
                            request_id = self.request_id(),
                            kv_id = message.id,
                            blob_id = pending.blob_id.to_base64(),
                            error = error.message,
                            "Cursor rejected Blob SET"
                        );
                        let _ = pending.result.send(Err(Error::Protocol(format!(
                            "KV SET {}: {}",
                            pending.blob_id.to_base64(),
                            error.message
                        ))));
                    } else {
                        tracing::debug!(
                            request_id = self.request_id(),
                            kv_id = message.id,
                            blob_id = pending.blob_id.to_base64(),
                            elapsed_ms = pending.sent_at.elapsed().as_millis(),
                            "Cursor acknowledged Blob SET"
                        );
                        self.inner.acked_blobs.lock().await.insert(pending.blob_id);
                        let _ = pending.result.send(Ok(()));
                    }
                } else {
                    tracing::warn!(
                        request_id = self.request_id(),
                        kv_id = message.id,
                        "unknown Cursor Blob SET acknowledgement"
                    );
                }
            }
            Some(pb::kv_client_message::Message::GetBlobResult(result)) => {
                if let Some(pending) = self.inner.get_requests.lock().await.remove(&message.id) {
                    let value = if let Some(error) = result.error {
                        Err(Error::Protocol(format!("KV GET: {}", error.message)))
                    } else if let Some(data) = result.blob_data {
                        let actual = BlobId::digest(&data);
                        if actual != pending.blob_id {
                            Err(Error::Protocol(format!(
                                "KV GET Blob hash mismatch: expected {}, got {}",
                                pending.blob_id.to_base64(),
                                actual.to_base64()
                            )))
                        } else {
                            self.inner.store.put_blob(&data, &[]).await?;
                            Ok(Some(data))
                        }
                    } else {
                        Ok(None)
                    };
                    let _ = pending.result.send(value);
                } else {
                    tracing::warn!(
                        request_id = self.request_id(),
                        kv_id = message.id,
                        "unknown Cursor Blob GET response"
                    );
                }
            }
            None => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_timeout_allows_slow_cursor_acknowledgements() {
        assert_eq!(SET_TIMEOUT, Duration::from_secs(30 * 60));
    }

    #[test]
    fn get_timeout_allows_slow_cursor_responses() {
        assert_eq!(GET_TIMEOUT, Duration::from_secs(10 * 60));
    }
}
