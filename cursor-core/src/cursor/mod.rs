//! Exposes the Cursor protocol adapter and its conversation runtime.

pub mod checkpoint;
pub mod compile;
pub mod conversation;
pub mod prompting;
pub mod protocol;
pub mod services;
pub mod tools;
pub mod transport;

pub use conversation::TransportCommand;
pub use transport::{TransportHandle, TransportParent, TransportRegistry, TransportRoute};
