//! Schedules background Tool work.
use std::collections::{HashMap, VecDeque};

use crate::{model::ToolCall, Error, Result};

use super::runtime::ExecContext;

#[derive(Default)]
pub(super) struct EditSchedule {
    paths: HashMap<String, EditPathQueue>,
    active_paths: HashMap<String, String>,
}

struct EditPathQueue {
    active_call_id: String,
    waiting: VecDeque<DeferredEdit>,
}

pub(super) struct DeferredEdit {
    pub call: ToolCall,
    pub message_index: usize,
    pub publish_started: bool,
    pub context: ExecContext,
}

impl EditSchedule {
    pub fn clear(&mut self) {
        self.paths.clear();
        self.active_paths.clear();
    }

    pub fn start_or_defer(&mut self, path: String, edit: DeferredEdit) -> Option<DeferredEdit> {
        if let Some(queue) = self.paths.get_mut(&path) {
            queue.waiting.push_back(edit);
            return None;
        }
        self.active_paths
            .insert(edit.call.call_id.clone(), path.clone());
        self.paths.insert(
            path,
            EditPathQueue {
                active_call_id: edit.call.call_id.clone(),
                waiting: VecDeque::new(),
            },
        );
        Some(edit)
    }

    pub fn complete(&mut self, call_id: &str) -> Result<Option<DeferredEdit>> {
        let Some(path) = self.active_paths.remove(call_id) else {
            return Ok(None);
        };
        let queue = self.paths.get_mut(&path).ok_or_else(|| {
            Error::Protocol(format!("active edit path disappeared for call {call_id}"))
        })?;
        if queue.active_call_id != call_id {
            return Err(Error::Protocol(format!(
                "edit path is active for {}, not {call_id}",
                queue.active_call_id
            )));
        }
        match queue.waiting.pop_front() {
            Some(next) => {
                queue.active_call_id = next.call.call_id.clone();
                self.active_paths.insert(next.call.call_id.clone(), path);
                Ok(Some(next))
            }
            None => {
                self.paths.remove(&path);
                Ok(None)
            }
        }
    }
}
