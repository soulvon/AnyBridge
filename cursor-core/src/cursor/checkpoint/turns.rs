//! Projects buffered steps into Cursor Conversation turns.
use prost::Message;

use crate::{
    cursor::{checkpoint::PendingSteps, protocol::proto::agent::v1 as pb},
    store::{BlobEdge, BlobId},
    Error, Result,
};

use super::CheckpointBuilder;

#[derive(Clone)]
pub(super) struct TurnFrontier {
    pub(super) preceding: Vec<BlobId>,
    pub(super) current_id: Option<BlobId>,
    pub(super) current: pb::AgentConversationTurnStructure,
}

impl CheckpointBuilder {
    pub(super) async fn project_turns(
        &mut self,
        mode: i32,
        presentation: &PendingSteps,
    ) -> Result<Vec<BlobId>> {
        self.ensure_turn(mode).await?;
        let Some(turn) = self.turn.as_mut() else {
            return self
                .base
                .turns
                .iter()
                .map(|id| BlobId::from_bytes(id))
                .collect();
        };
        let changed = !presentation.steps.is_empty();
        for step in &presentation.steps {
            let mut encoded = Vec::new();
            step.encode(&mut encoded)?;
            let id = self.sync.persist(&encoded, &[]).await?;
            turn.current.steps.push(id.as_bytes().to_vec());
        }
        if changed || turn.current_id.is_none() {
            let wrapper = pb::ConversationTurnStructure {
                turn: Some(
                    pb::conversation_turn_structure::Turn::AgentConversationTurn(
                        turn.current.clone(),
                    ),
                ),
            };
            let mut encoded = Vec::new();
            wrapper.encode(&mut encoded)?;
            let mut edges = Vec::with_capacity(turn.current.steps.len() + 1);
            edges.push(BlobEdge {
                child: BlobId::from_bytes(&turn.current.user_message)?,
                field_name: "agent_conversation_turn.user_message".into(),
            });
            for (index, raw_id) in turn.current.steps.iter().enumerate() {
                edges.push(BlobEdge {
                    child: BlobId::from_bytes(raw_id)?,
                    field_name: format!("agent_conversation_turn.steps[{index}]"),
                });
            }
            turn.current_id = Some(self.sync.persist(&encoded, &edges).await?);
        }
        let mut ids = turn.preceding.clone();
        ids.push(
            turn.current_id
                .clone()
                .ok_or_else(|| Error::Protocol("Cursor current Turn has no BlobID".into()))?,
        );
        Ok(ids)
    }

    async fn ensure_turn(&mut self, mode: i32) -> Result<()> {
        if self.turns_initialized {
            return Ok(());
        }
        self.turns_initialized = true;
        let base_ids = self
            .base
            .turns
            .iter()
            .map(|id| BlobId::from_bytes(id))
            .collect::<Result<Vec<_>>>()?;
        if let Some(mut user) = self.turn_user.clone() {
            user.mode = mode;
            let mut encoded = Vec::new();
            user.encode(&mut encoded)?;
            let user_id = self.sync.persist(&encoded, &[]).await?;
            self.turn = Some(TurnFrontier {
                preceding: base_ids,
                current_id: None,
                current: pb::AgentConversationTurnStructure {
                    user_message: user_id.as_bytes().to_vec(),
                    steps: Vec::new(),
                    request_id: Some(self.sync.request_id().into()),
                    encrypted_model: None,
                    dynamic_tool_count: None,
                    send_message_step_indices: Vec::new(),
                },
            });
            return Ok(());
        }
        let Some((current_id, preceding)) = base_ids.split_last() else {
            return Ok(());
        };
        let data = self.sync.get(current_id).await?.ok_or_else(|| {
            Error::Protocol(format!(
                "missing current Turn Blob {}",
                current_id.to_base64()
            ))
        })?;
        let wrapper = pb::ConversationTurnStructure::decode(data.as_slice())?;
        let Some(pb::conversation_turn_structure::Turn::AgentConversationTurn(current)) =
            wrapper.turn
        else {
            return Err(Error::Protocol(
                "current Cursor Turn is not an agent conversation turn".into(),
            ));
        };
        self.turn = Some(TurnFrontier {
            preceding: preceding.to_vec(),
            current_id: Some(current_id.clone()),
            current,
        });
        Ok(())
    }
}
