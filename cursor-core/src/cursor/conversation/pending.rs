//! Stores messages waiting across Run lifecycle boundaries.

use std::collections::{HashSet, VecDeque};

use super::CompiledMessages;

#[derive(Default)]
pub struct PendingMessages {
    queued: VecDeque<CompiledMessages>,
    event_ids: HashSet<String>,
}

impl PendingMessages {
    pub fn push(&mut self, messages: CompiledMessages) -> bool {
        if !self.event_ids.insert(messages.event_id.clone()) {
            return false;
        }
        self.queued.push_back(messages);
        true
    }

    pub fn drain(&mut self) -> impl Iterator<Item = CompiledMessages> + '_ {
        self.event_ids.clear();
        self.queued.drain(..)
    }
}
