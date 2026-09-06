//! Public search engine, Reciprocal Rank Fusion, and code-aware reranking.

mod engine;
mod rerank;
mod rrf;

pub use engine::SearchEngine;
