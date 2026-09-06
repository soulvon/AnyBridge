use std::{
    collections::{BTreeMap, HashMap},
    sync::atomic::Ordering,
    time::Duration,
};

use tokio::sync::mpsc;

use crate::store::{BufferedCursorTraceChunk, Store};

use super::event::{TraceEvent, TRACE_ACTIVE, TRACE_DISABLED};

const MAX_BUFFERED_CHUNKS: usize = 32;
const MAX_BUFFERED_BYTES: usize = 256 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy)]
enum TraceState {
    Active,
    Disabled,
}

#[derive(Default)]
struct ResponseBuffer {
    chunks: Vec<BufferedCursorTraceChunk>,
    bytes: usize,
}

struct BufferedRequest {
    artifact_type: String,
    data: bytes::Bytes,
    metadata: serde_json::Value,
}

#[derive(Default)]
struct RequestOrder {
    next: i64,
    pending: BTreeMap<i64, Vec<BufferedRequest>>,
}

pub(super) async fn run(store: Store, mut receiver: mpsc::Receiver<TraceEvent>) {
    let mut states = HashMap::<String, TraceState>::new();
    let mut buffers = HashMap::<String, ResponseBuffer>::new();
    let mut request_orders = HashMap::<String, RequestOrder>::new();
    let mut interval = tokio::time::interval(FLUSH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            event = receiver.recv() => {
                let Some(event) = event else {
                    flush_all(&store, &mut buffers).await;
                    return;
                };
                process(&store, &mut states, &mut buffers, &mut request_orders, event).await;
            }
            _ = interval.tick() => flush_all(&store, &mut buffers).await,
        }
    }
}

async fn process(
    store: &Store,
    states: &mut HashMap<String, TraceState>,
    buffers: &mut HashMap<String, ResponseBuffer>,
    request_orders: &mut HashMap<String, RequestOrder>,
    event: TraceEvent,
) {
    let request_id = event.request_id().to_owned();
    let finishes_trace = matches!(&event, TraceEvent::Finish { .. });
    match event {
        TraceEvent::Begin {
            request_id,
            activation,
            conversation_id,
            route,
            model_id,
        } => {
            let state = match store
                .start_cursor_trace_if_detailed(
                    &request_id,
                    conversation_id.as_deref(),
                    &route,
                    model_id.as_deref(),
                )
                .await
            {
                Ok(true) => TraceState::Active,
                Ok(false) => TraceState::Disabled,
                Err(error) => {
                    tracing::warn!(%request_id, %error, "failed to start Cursor trace");
                    TraceState::Disabled
                }
            };
            activation.store(
                match state {
                    TraceState::Active => TRACE_ACTIVE,
                    TraceState::Disabled => TRACE_DISABLED,
                },
                Ordering::Release,
            );
            states.insert(request_id, state);
            return;
        }
        TraceEvent::Resume {
            request_id,
            activation,
        } => {
            let state = ensure_state(store, states, &request_id).await;
            activation.store(
                match state {
                    TraceState::Active => TRACE_ACTIVE,
                    TraceState::Disabled => TRACE_DISABLED,
                },
                Ordering::Release,
            );
            return;
        }
        _ => {}
    }

    if !matches!(
        ensure_state(store, states, &request_id).await,
        TraceState::Active
    ) {
        if finishes_trace {
            states.remove(&request_id);
            buffers.remove(&request_id);
            request_orders.remove(&request_id);
        }
        return;
    }

    let result = match event {
        TraceEvent::Request {
            artifact_type,
            data,
            metadata,
            ..
        } => {
            append_request(
                store,
                request_orders,
                &request_id,
                artifact_type,
                data,
                metadata,
            )
            .await
        }
        TraceEvent::Artifact {
            artifact_type,
            source,
            data,
            metadata,
            ..
        } => {
            store
                .append_cursor_trace_artifact(
                    &request_id,
                    &artifact_type,
                    &source,
                    &data,
                    &metadata,
                )
                .await
        }
        TraceEvent::LinkedBlob {
            artifact_type,
            source,
            blob_id,
            metadata,
            ..
        } => {
            store
                .link_cursor_trace_artifact(
                    &request_id,
                    &artifact_type,
                    &source,
                    &blob_id,
                    &metadata,
                )
                .await
        }
        TraceEvent::ResponseStarted { status, .. } => {
            store.start_cursor_trace_response(&request_id, status).await
        }
        TraceEvent::ResponseChunk { source, data, .. } => {
            let buffer = buffers.entry(request_id.clone()).or_default();
            buffer.bytes += data.len();
            buffer
                .chunks
                .push(BufferedCursorTraceChunk::new(&source, &data));
            if buffer.chunks.len() >= MAX_BUFFERED_CHUNKS || buffer.bytes >= MAX_BUFFERED_BYTES {
                flush_one(store, buffers, &request_id).await;
            }
            return;
        }
        TraceEvent::Finish { error, .. } => {
            flush_request_order(store, request_orders, &request_id).await;
            flush_one(store, buffers, &request_id).await;
            store
                .finish_cursor_trace(&request_id, error.as_deref())
                .await
        }
        TraceEvent::Begin { .. } | TraceEvent::Resume { .. } => unreachable!(),
    };
    if let Err(error) = result {
        tracing::warn!(%request_id, %error, "failed to record Cursor trace event");
    }
    if finishes_trace {
        states.remove(&request_id);
        buffers.remove(&request_id);
    }
}

async fn append_request(
    store: &Store,
    request_orders: &mut HashMap<String, RequestOrder>,
    request_id: &str,
    artifact_type: String,
    data: bytes::Bytes,
    metadata: serde_json::Value,
) -> crate::Result<()> {
    let append_seqno = metadata
        .get("append_seqno")
        .and_then(serde_json::Value::as_i64);
    let ordered = artifact_type == "bidi_request"
        && metadata
            .get("accepted")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && metadata
            .get("route_outcome")
            .and_then(serde_json::Value::as_str)
            == Some("local");
    let Some(append_seqno) = append_seqno.filter(|_| ordered) else {
        return store
            .append_cursor_trace_request(
                request_id,
                &artifact_type,
                "cursor_client",
                &data,
                &metadata,
            )
            .await;
    };

    let request = BufferedRequest {
        artifact_type,
        data,
        metadata,
    };
    let order = request_orders.entry(request_id.to_owned()).or_default();
    if append_seqno < order.next {
        return store
            .append_cursor_trace_request(
                request_id,
                &request.artifact_type,
                "cursor_client",
                &request.data,
                &request.metadata,
            )
            .await;
    }
    order.pending.entry(append_seqno).or_default().push(request);
    while let Some(requests) = order.pending.remove(&order.next) {
        for request in requests {
            store
                .append_cursor_trace_request(
                    request_id,
                    &request.artifact_type,
                    "cursor_client",
                    &request.data,
                    &request.metadata,
                )
                .await?;
        }
        order.next = order.next.saturating_add(1);
    }
    Ok(())
}

async fn flush_request_order(
    store: &Store,
    request_orders: &mut HashMap<String, RequestOrder>,
    request_id: &str,
) {
    let Some(order) = request_orders.remove(request_id) else {
        return;
    };
    for requests in order.pending.into_values() {
        for request in requests {
            if let Err(error) = store
                .append_cursor_trace_request(
                    request_id,
                    &request.artifact_type,
                    "cursor_client",
                    &request.data,
                    &request.metadata,
                )
                .await
            {
                tracing::warn!(%request_id, %error, "failed to flush ordered Cursor request trace");
            }
        }
    }
}

async fn ensure_state(
    store: &Store,
    states: &mut HashMap<String, TraceState>,
    request_id: &str,
) -> TraceState {
    if let Some(state) = states.get(request_id).copied() {
        return state;
    }
    let state = match store.cursor_trace_exists(request_id).await {
        Ok(true) => TraceState::Active,
        Ok(false) => TraceState::Disabled,
        Err(error) => {
            tracing::warn!(%request_id, %error, "failed to resume Cursor trace");
            TraceState::Disabled
        }
    };
    states.insert(request_id.to_owned(), state);
    state
}

async fn flush_one(store: &Store, buffers: &mut HashMap<String, ResponseBuffer>, request_id: &str) {
    let Some(mut buffer) = buffers.remove(request_id) else {
        return;
    };
    if let Err(error) = store
        .add_cursor_trace_response_chunks(request_id, &buffer.chunks)
        .await
    {
        tracing::warn!(%request_id, %error, "failed to flush Cursor response chunks");
        buffer.bytes = buffer.chunks.iter().map(|chunk| chunk.data.len()).sum();
        buffers.insert(request_id.to_owned(), buffer);
    }
}

async fn flush_all(store: &Store, buffers: &mut HashMap<String, ResponseBuffer>) {
    let request_ids = buffers.keys().cloned().collect::<Vec<_>>();
    for request_id in request_ids {
        flush_one(store, buffers, &request_id).await;
    }
}
