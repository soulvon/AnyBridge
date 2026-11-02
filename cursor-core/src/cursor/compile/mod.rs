//! Compiles Cursor requests and actions into provider-independent Run inputs.

mod action;
mod break_messages;
mod context;
mod images;
mod insert_messages;
mod model;
mod run;

pub use action::*;
pub(crate) use break_messages::{
    compile_injection, compile_user_message_action, wakeup_message, RuntimeAction,
};
pub(crate) use insert_messages::{project as project_background_completion, subagent_completion};
pub use run::*;
