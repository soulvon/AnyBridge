//! Canonical path validation that keeps indexing inside an allowed source root.

use std::path::{Path, PathBuf};

use crate::{Error, Result};

pub fn canonical_source_root(path: &Path) -> Result<PathBuf> {
    if !path.exists() {
        return Err(Error::SourceMissing(path.to_path_buf()));
    }
    if !path.is_dir() {
        return Err(Error::SourceNotDirectory(path.to_path_buf()));
    }
    path.canonicalize().map_err(|error| Error::io(path, error))
}
