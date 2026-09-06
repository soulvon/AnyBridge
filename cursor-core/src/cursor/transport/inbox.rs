//! Orders Bidi messages by append sequence number.

use std::collections::BTreeMap;

pub struct OrderedInbox<T> {
    next: i64,
    pending: BTreeMap<i64, T>,
}

impl<T> OrderedInbox<T> {
    pub fn starting_at(next: i64) -> Self {
        Self {
            next,
            pending: BTreeMap::new(),
        }
    }

    pub fn push(&mut self, seqno: i64, value: T) -> Vec<(i64, T)> {
        if seqno < self.next || self.pending.contains_key(&seqno) {
            return Vec::new();
        }
        self.pending.insert(seqno, value);
        let mut ready = Vec::new();
        while let Some(value) = self.pending.remove(&self.next) {
            ready.push((self.next, value));
            self.next = self.next.saturating_add(1);
        }
        ready
    }
}
