//! On-disk paths derived from source identity and index configuration.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{config::INDEX_FORMAT_VERSION, ContentType};

#[derive(Clone, Debug)]
pub struct CacheLayout {
    pub snapshot: PathBuf,
    pub runtime: PathBuf,
}

impl CacheLayout {
    pub fn new(
        root: &Path,
        source_identity: &str,
        model: &str,
        content: &[ContentType],
        chunk_bytes: usize,
    ) -> Self {
        let source = hex::encode(Sha256::digest(source_identity.as_bytes()));
        let mut signature = format!("{model}:{chunk_bytes}:");
        let mut content = content.to_vec();
        content.sort_by_key(|item| *item as u8);
        for item in content {
            signature.push_str(&format!("{item:?},"));
        }
        let signature = hex::encode(Sha256::digest(signature.as_bytes()));
        let directory = root
            .join(format!("indexes/v{INDEX_FORMAT_VERSION}"))
            .join(source)
            .join(signature);
        Self {
            snapshot: directory.join("index.bin"),
            runtime: directory.join("runtime.bin"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn snapshot_path_tracks_the_index_format_version() {
        let layout = CacheLayout::new(
            Path::new("cache"),
            "source",
            "model",
            &[ContentType::Code],
            750,
        );
        let version = format!("v{INDEX_FORMAT_VERSION}");
        assert!(layout
            .snapshot
            .components()
            .any(|component| component.as_os_str() == OsStr::new(&version)));
        assert_eq!(layout.runtime.file_name(), Some(OsStr::new("runtime.bin")));
        assert_eq!(layout.snapshot.parent(), layout.runtime.parent());
    }
}
