//! Code-aware Tree-sitter chunking with a deterministic line-based fallback.

mod boundary;
mod line_fallback;
mod tree_sitter;

pub use boundary::ChunkBoundary;
pub use line_fallback::line_boundaries;
pub use tree_sitter::chunk_source;
