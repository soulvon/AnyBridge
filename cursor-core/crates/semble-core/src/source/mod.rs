//! Source discovery, ignore handling, path safety, and remote Git acquisition.

mod local;
mod remote_git;
mod security;

pub use local::{discover_files, FileStamp, SourceFile};
pub use remote_git::RemoteRepository;
pub use security::canonical_source_root;
