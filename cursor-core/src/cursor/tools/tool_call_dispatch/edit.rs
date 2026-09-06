//! Dispatches edit Tool calls.
//! Hidden read phase for file editing tools.

use crate::{model::ToolCall, Result};

use super::ToolStart;
use crate::cursor::tools::{
    codec,
    runtime::{CursorToolRuntime, ExecContext},
};

pub(super) async fn start(
    runtime: &CursorToolRuntime,
    call: &ToolCall,
    context: &ExecContext,
) -> Result<ToolStart> {
    let id = runtime.reserve_edit_read(call, context).await?;
    Ok(ToolStart {
        messages: vec![codec::edit_read_request(id, call)?],
        completion: None,
    })
}
