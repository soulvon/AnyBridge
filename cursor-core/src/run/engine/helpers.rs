use crate::{
    model::Usage,
    run::{RunEvent, RunFailure, RunOutcome, RunPort},
    store::{ContextUsageAnchor, Store},
    Result,
};
use tokio_util::sync::CancellationToken;

pub(super) async fn hydrate_tool_images(
    store: &Store,
    messages: &mut [crate::model::ProjectedMessage],
) -> crate::Result<()> {
    use crate::{
        model::{ContentPart, ProjectedContent},
        store::BlobId,
        Error,
    };

    for message in messages {
        let ProjectedContent::ToolResult(result) = &mut message.content else {
            continue;
        };
        let Some(image) = &result.image else {
            continue;
        };
        let id = BlobId::from_base64(&image.blob_id)?;
        let data = store.get_blob(&id).await?.ok_or_else(|| {
            Error::Protocol(format!("Read image Blob is missing: {}", image.blob_id))
        })?;
        result.provider_parts = vec![
            ContentPart::Text {
                text: result.content.clone(),
            },
            ContentPart::Image {
                mime_type: image.mime_type.clone(),
                data,
            },
        ];
    }
    Ok(())
}

pub(super) fn context_usage_snapshot(tokens: u64) -> Usage {
    Usage {
        input_tokens: Some(tokens),
        context_input_tokens: Some(tokens),
        output_tokens: Some(0),
        total_tokens: Some(tokens),
        cache_read_tokens: Some(0),
        cache_write_tokens: Some(0),
        reasoning_tokens: Some(0),
    }
}

pub(super) fn update_context_usage_anchor(
    anchor: &mut Option<ContextUsageAnchor>,
    usage: Usage,
    message_count: usize,
) {
    if let Some(context_input_tokens) = usage.context_input_tokens {
        *anchor = Some(ContextUsageAnchor {
            context_input_tokens,
            message_count,
        });
    }
}

pub(super) fn accumulate_usage(total: &mut Option<Usage>, usage: Usage) {
    match total {
        Some(total) => *total += usage,
        None => *total = Some(usage),
    }
}

pub(in crate::run) async fn wait_for_state_ready(
    ready: tokio::sync::oneshot::Receiver<std::result::Result<(), String>>,
    cancellation: &CancellationToken,
) -> std::result::Result<(), RunOutcome> {
    let result = tokio::select! {
        biased;
        result = ready => result,
        _ = cancellation.cancelled() => return Err(RunOutcome::Cancelled),
    };
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(RunOutcome::Failed(RunFailure::Client(error))),
        Err(_) => Err(client_failure()),
    }
}

pub(in crate::run) async fn emit(client: &RunPort, event: RunEvent) -> Result<(), ()> {
    client.events.send(event).await.map_err(|_| ())
}

pub(in crate::run) fn client_failure() -> RunOutcome {
    RunOutcome::Failed(RunFailure::Client("client event channel closed".into()))
}

pub(super) fn failure_message(failure: &RunFailure) -> String {
    match failure {
        RunFailure::Protocol(message)
        | RunFailure::Provider(message)
        | RunFailure::Store(message)
        | RunFailure::Client(message) => message.clone(),
    }
}
