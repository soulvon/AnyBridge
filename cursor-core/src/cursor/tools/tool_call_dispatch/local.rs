//! Dispatches server-local Tool calls.
//! Synchronous local tool dispatch.

use crate::{model::ToolCall, Result};

use super::ToolStart;
use crate::cursor::tools::tool_call_result as result;

pub(super) fn start(call: &ToolCall, message_index: usize) -> Result<ToolStart> {
    Ok(ToolStart {
        messages: Vec::new(),
        completion: Some(result::local(call, message_index)?),
    })
}

pub(super) fn subagents_disabled(call: &ToolCall) -> Result<ToolStart> {
    Ok(ToolStart {
        messages: Vec::new(),
        completion: Some(result::subagents_disabled(call)?),
    })
}
