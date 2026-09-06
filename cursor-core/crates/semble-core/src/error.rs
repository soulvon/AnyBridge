//! Errors shared by indexing, persistence, model loading, and retrieval.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("source does not exist: {0}")]
    SourceMissing(PathBuf),
    #[error("source is not a directory: {0}")]
    SourceNotDirectory(PathBuf),
    #[error("source path escapes the allowed root: {0}")]
    UnsafePath(PathBuf),
    #[error("unsupported repository URL: {0}")]
    UnsupportedUrl(String),
    #[error("git operation failed: {0}")]
    Git(String),
    #[error("model asset error: {0}")]
    ModelAsset(String),
    #[error("model inference error: {0}")]
    Model(String),
    #[error("index is empty: {0}")]
    EmptyIndex(PathBuf),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("persisted index is incompatible or corrupt: {0}")]
    CorruptIndex(String),
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("serialization error: {0}")]
    Serialization(String),
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
