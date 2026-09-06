//! User-independent configuration and fixed index format parameters.

use std::path::PathBuf;

/// Current persisted snapshot format. Incompatible changes must bump this value.
pub const INDEX_FORMAT_VERSION: u32 = 7;

/// Search and persistence settings shared by every indexed repository.
#[derive(Clone, Debug)]
pub struct SembleConfig {
    pub cache_dir: PathBuf,
    pub desired_chunk_bytes: usize,
    pub max_file_bytes: u64,
}

impl SembleConfig {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            cache_dir: cache_dir.into(),
            desired_chunk_bytes: 750,
            max_file_bytes: 1_000_000,
        }
    }
}

impl Default for SembleConfig {
    fn default() -> Self {
        let root = std::env::var_os("SEMBLE_CACHE_LOCATION")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| dirs::home_dir().map(|home| home.join(".cursor-byok-v3/cache/semble")))
            .unwrap_or_else(|| PathBuf::from(".cursor-byok-v3/cache/semble"));
        Self::new(root)
    }
}
