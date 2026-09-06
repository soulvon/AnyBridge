//! Transport-independent code indexing, persistence, and hybrid retrieval.

pub mod cache;
pub mod chunk;
pub mod config;
pub mod embedding;
pub mod error;
pub mod index;
pub mod language;
pub mod search;
pub mod source;
pub mod types;

pub use config::SembleConfig;
pub use embedding::{Embedder, StaticEmbedder};
pub use error::{Error, Result};
pub use search::SearchEngine;
pub use types::{
    Chunk, ContentType, FindRelatedRequest, IndexStats, SearchRequest, SearchResponse, SearchResult,
};
