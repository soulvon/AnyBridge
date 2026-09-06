//! Applies Ignore, InsertMessages, and BreakMessages delivery semantics.

use crate::{model::RunId, run::CommandResult};

pub use crate::cursor::compile::{CompiledMessages, MessageDelivery};

pub fn target_result(target: Option<&RunId>, current: &RunId) -> Option<CommandResult> {
    target
        .filter(|target| *target != current)
        .map(|_| CommandResult::StaleTarget)
}
