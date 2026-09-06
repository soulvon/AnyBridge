//! Maintains stable append-only Cursor root messages.
use crate::{cursor::checkpoint::messages, model::CanonicalMessage, store::BlobId, Error, Result};

use super::CheckpointBuilder;

#[derive(Clone)]
pub(super) struct RootFrontier {
    pub(super) ids: Vec<BlobId>,
    pub(super) generated: Vec<Vec<u8>>,
    pub(super) base_count: usize,
}

impl CheckpointBuilder {
    pub(super) async fn project_roots(
        &mut self,
        messages: &[CanonicalMessage],
    ) -> Result<Vec<BlobId>> {
        let wire_messages = messages::stable_messages(&self.instructions, messages, &self.model)?;
        self.ensure_roots()?;
        let replacement = self
            .roots
            .as_ref()
            .and_then(|roots| changed_system_root(roots, &wire_messages));
        if let Some(message) = replacement {
            let id = self.sync.persist(&message, &[]).await?;
            self.roots
                .as_mut()
                .ok_or_else(|| Error::Protocol("Cursor root frontier was not initialized".into()))?
                .ids[0] = id;
        }
        let roots = self
            .roots
            .as_mut()
            .ok_or_else(|| Error::Protocol("Cursor root frontier was not initialized".into()))?;
        if wire_messages.len() < roots.ids.len() {
            return Err(Error::Protocol(format!(
                "Cursor stable history shrank from {} to {} roots",
                roots.ids.len(),
                wire_messages.len()
            )));
        }
        for (index, expected) in roots.generated.iter().enumerate() {
            let wire_index = roots.base_count + index;
            if wire_messages.get(wire_index) != Some(expected) {
                return Err(Error::Protocol(format!(
                    "Cursor stable root changed at index {wire_index}"
                )));
            }
        }
        for message in wire_messages.iter().skip(roots.ids.len()) {
            roots.ids.push(self.sync.persist(message, &[]).await?);
            roots.generated.push(message.clone());
        }
        Ok(roots.ids.clone())
    }

    fn ensure_roots(&mut self) -> Result<()> {
        if self.roots.is_some() {
            return Ok(());
        }
        let ids = self
            .base
            .root_prompt_messages_json
            .iter()
            .map(|id| BlobId::from_bytes(id))
            .collect::<Result<Vec<_>>>()?;
        self.roots = Some(RootFrontier {
            base_count: ids.len(),
            ids,
            generated: Vec::new(),
        });
        Ok(())
    }

    pub(super) async fn replace_roots(
        &mut self,
        messages: &[CanonicalMessage],
    ) -> Result<Vec<BlobId>> {
        let wire_messages = messages::stable_messages(&self.instructions, messages, &self.model)?;
        self.ensure_roots()?;
        let previous_system = self
            .roots
            .as_ref()
            .and_then(|roots| roots.ids.first())
            .cloned();
        let mut ids = Vec::with_capacity(wire_messages.len());
        for (index, message) in wire_messages.iter().enumerate() {
            if index == 0
                && previous_system
                    .as_ref()
                    .is_some_and(|id| *id == BlobId::digest(message))
            {
                ids.push(previous_system.clone().expect("checked system root"));
            } else {
                ids.push(self.sync.persist(message, &[]).await?);
            }
        }
        self.roots = Some(RootFrontier {
            base_count: ids.len(),
            ids: ids.clone(),
            generated: Vec::new(),
        });
        Ok(ids)
    }
}

fn changed_system_root(roots: &RootFrontier, messages: &[Vec<u8>]) -> Option<Vec<u8>> {
    roots
        .ids
        .first()
        .zip(messages.first())
        .filter(|(current, message)| **current != BlobId::digest(message))
        .map(|(_, message)| message.clone())
}
