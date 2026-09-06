//! Stable cache keys plus atomic, versioned index snapshot persistence.

mod layout;
mod store;

pub use layout::CacheLayout;
pub use store::{load_runtime, load_snapshot, save_runtime, save_snapshot};
