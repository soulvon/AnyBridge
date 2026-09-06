//! Dispatches search Tool calls.
//! Cursor tool orchestration for application-owned Semble search.

use crate::{
    cursor::tools::{
        runtime::now_ms,
        tool_call_result::{self as result, ToolResultSender},
    },
    model::ToolCall,
    search,
    store::Store,
    Result,
};

use super::ToolStart;

pub(super) fn start(
    results: &ToolResultSender,
    call: &ToolCall,
    store: Option<Store>,
) -> Result<ToolStart> {
    let tool_name = super::normalized(&call.name);
    let arguments = call.arguments.clone();
    let call = call.clone();
    let results = results.clone();
    let started_at_ms = now_ms();
    tokio::spawn(async move {
        let output = search::execute_semble(&tool_name, arguments, store).await;
        match result::semble(&call, started_at_ms, output) {
            Ok(completion) => results.send(completion),
            Err(error) => results.send_error(error),
        }
    });
    Ok(ToolStart {
        messages: Vec::new(),
        completion: None,
    })
}
