//! Restores Conversation Messages and pending Tool state from a checkpoint.
use crate::{
    cursor::{checkpoint::messages, protocol::proto::agent::v1 as pb},
    model::CanonicalMessage,
    store::BlobId,
    Error, Result,
};

use super::CheckpointBuilder;

impl CheckpointBuilder {
    pub async fn import_prefetched(&self, blobs: &[pb::PreFetchedBlob]) -> Result<()> {
        for blob in blobs {
            let expected = BlobId::from_bytes(&blob.id)?;
            let actual = self.store.put_blob(&blob.value, &[]).await?;
            if expected != actual {
                return Err(Error::Protocol(format!(
                    "prefetched Blob hash mismatch: {}",
                    expected.to_base64()
                )));
            }
        }
        Ok(())
    }

    pub async fn hydrate_messages(
        &self,
        state: Option<&pb::ConversationStateStructure>,
    ) -> Result<Vec<CanonicalMessage>> {
        let mut messages = Vec::new();
        let Some(state) = state else {
            return Ok(messages);
        };
        for (ordinal, raw_id) in state.root_prompt_messages_json.iter().enumerate() {
            let id = BlobId::from_bytes(raw_id)?;
            let Some(data) = self.sync.get(&id).await? else {
                return Err(Error::Protocol(format!(
                    "missing message Blob {}",
                    id.to_base64()
                )));
            };
            messages.push(messages::decode(
                &data,
                format!("cursor-root:{}:{ordinal}", id.to_base64()),
            )?);
        }
        Ok(messages)
    }
}
