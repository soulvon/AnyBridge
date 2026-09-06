//! Public request, result, source, chunk, and persisted-index data types.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    #[default]
    Code,
    Docs,
    Config,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Chunk {
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub language: Option<String>,
    /// Source text is runtime-only; persisted indexes reload it on demand for returned snippets.
    #[serde(skip, default)]
    pub content: String,
}

#[derive(Clone, Debug)]
pub struct SearchRequest {
    pub query: String,
    pub repo: PathBuf,
    pub top_k: usize,
    pub max_snippet_lines: Option<usize>,
    pub content: Vec<ContentType>,
}

impl SearchRequest {
    pub fn new(query: impl Into<String>, repo: impl Into<PathBuf>) -> Self {
        Self {
            query: query.into(),
            repo: repo.into(),
            top_k: 5,
            max_snippet_lines: Some(10),
            content: vec![ContentType::Code],
        }
    }
}

#[derive(Clone, Debug)]
pub struct FindRelatedRequest {
    pub repo: PathBuf,
    pub file_path: String,
    pub line: usize,
    pub top_k: usize,
    pub max_snippet_lines: Option<usize>,
    pub content: Vec<ContentType>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SearchResult {
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<SearchResult>,
}

/// Summary of a prepared repository index, independent of its storage format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IndexStats {
    pub file_count: usize,
    pub chunk_count: usize,
    pub source_bytes: u64,
    pub dimensions: usize,
}

pub(crate) fn snippet(content: &str, lines: Option<usize>) -> Option<String> {
    match lines {
        Some(0) => None,
        Some(limit) => Some(content.lines().take(limit).collect::<Vec<_>>().join("\n")),
        None => Some(content.to_owned()),
    }
}
