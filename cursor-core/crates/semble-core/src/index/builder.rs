//! Incremental index builder that reuses unchanged chunks and embeddings.

use std::{
    collections::HashMap,
    fs,
    num::NonZeroUsize,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use lru::LruCache;
use parking_lot::Mutex;

use crate::{
    cache::{load_runtime, load_snapshot, save_runtime, save_snapshot, CacheLayout},
    chunk::chunk_source,
    config::{SembleConfig, INDEX_FORMAT_VERSION},
    embedding::Embedder,
    index::extract_definitions,
    language::detect_language,
    source::discover_files,
    ContentType, Error, Result,
};

use super::{lexical_document, IndexSnapshot, IndexedFile, LoadedIndex};

pub struct IndexRepository {
    config: SembleConfig,
    embedder: Arc<dyn Embedder>,
    build_lock: Mutex<()>,
    loaded: Mutex<LruCache<std::path::PathBuf, CachedIndex>>,
}

const SEARCH_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

struct CachedIndex {
    index: Arc<LoadedIndex>,
    checked_at: Instant,
}

impl IndexRepository {
    pub fn new(config: SembleConfig, embedder: Arc<dyn Embedder>) -> Self {
        Self {
            config,
            embedder,
            build_lock: Mutex::new(()),
            loaded: Mutex::new(LruCache::new(
                NonZeroUsize::new(10).expect("non-zero cache size"),
            )),
        }
    }

    pub fn load_or_build(
        &self,
        root: &Path,
        identity: &str,
        content: &[ContentType],
    ) -> Result<Arc<LoadedIndex>> {
        let layout = CacheLayout::new(
            &self.config.cache_dir,
            identity,
            self.embedder.id(),
            content,
            self.config.desired_chunk_bytes,
        );
        let files = discover_files(root, content, self.config.max_file_bytes)?;
        if files.is_empty() {
            return Err(Error::EmptyIndex(root.to_path_buf()));
        }
        if let Some(index) = self.checked_if_unchanged(&layout.snapshot, &files) {
            return Ok(index);
        }
        let _guard = self.build_lock.lock();
        if let Some(index) = self.checked_if_unchanged(&layout.snapshot, &files) {
            return Ok(index);
        }
        let runtime = load_runtime(&layout.runtime)
            .ok()
            .flatten()
            .filter(|runtime| {
                runtime.metadata.source_identity == identity
                    && runtime.metadata.model_id == self.embedder.id()
                    && runtime.metadata.desired_chunk_bytes == self.config.desired_chunk_bytes
                    && runtime.metadata.content == content
                    && unchanged_loaded(&files, &runtime.metadata.files)
            });
        if let Some(runtime) = runtime {
            let loaded = Arc::new(runtime);
            self.store_loaded(layout.snapshot, loaded.clone());
            return Ok(loaded);
        }
        let previous = load_snapshot(&layout.snapshot)
            .ok()
            .flatten()
            .filter(|snapshot| {
                snapshot.source_identity == identity
                    && snapshot.model_id == self.embedder.id()
                    && snapshot.desired_chunk_bytes == self.config.desired_chunk_bytes
                    && snapshot.content == content
            });
        let snapshot_is_current = previous.as_ref().is_some_and(|snapshot| {
            let stamps = snapshot
                .files
                .iter()
                .map(|file| (file.path.as_str(), file.stamp))
                .collect::<HashMap<_, _>>();
            files.len() == snapshot.files.len()
                && files
                    .iter()
                    .all(|file| stamps.get(file.relative_path.as_str()) == Some(&file.stamp))
        });
        if snapshot_is_current {
            let snapshot = previous.expect("current snapshot exists");
            let loaded = Arc::new(LoadedIndex::from_snapshot(snapshot)?);
            save_runtime(&layout.runtime, &loaded)?;
            self.store_loaded(layout.snapshot, loaded.clone());
            return Ok(loaded);
        }
        let mut old = previous
            .map(|snapshot| {
                snapshot
                    .files
                    .into_iter()
                    .map(|file| (file.path.clone(), file))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut indexed = Vec::new();
        for file in files {
            if let Some(cached) = old
                .remove(&file.relative_path)
                .filter(|cached| cached.stamp == file.stamp)
            {
                indexed.push(cached);
                continue;
            }
            let bytes = fs::read(&file.absolute_path)
                .map_err(|error| Error::io(&file.absolute_path, error))?;
            if bytes.iter().take(8192).any(|byte| *byte == 0) {
                continue;
            }
            let source = String::from_utf8_lossy(&bytes);
            let language = detect_language(&file.absolute_path);
            let chunks = chunk_source(
                &source,
                &file.relative_path,
                language,
                self.config.desired_chunk_bytes,
            );
            if chunks.is_empty() {
                continue;
            }
            let texts = chunks
                .iter()
                .map(|chunk| chunk.content.clone())
                .collect::<Vec<_>>();
            let vectors =
                quantize_vectors(self.embedder.encode(&texts)?, self.embedder.dimensions())?;
            let lexical_documents = chunks
                .iter()
                .map(|chunk| lexical_document(&chunk.content))
                .collect();
            indexed.push(IndexedFile {
                path: file.relative_path,
                stamp: file.stamp,
                content_type: file.content_type,
                definitions: extract_definitions(&chunks),
                lexical_documents,
                chunks,
                vectors,
            });
        }
        if indexed.is_empty() {
            return Err(Error::EmptyIndex(root.to_path_buf()));
        }
        let snapshot = IndexSnapshot {
            format_version: INDEX_FORMAT_VERSION,
            source_identity: identity.to_owned(),
            model_id: self.embedder.id().to_owned(),
            dimensions: self.embedder.dimensions(),
            desired_chunk_bytes: self.config.desired_chunk_bytes,
            content: content.to_vec(),
            files: indexed,
        };
        save_snapshot(&layout.snapshot, &snapshot)?;
        let loaded = Arc::new(LoadedIndex::from_snapshot(snapshot)?);
        save_runtime(&layout.runtime, &loaded)?;
        self.store_loaded(layout.snapshot, loaded.clone());
        Ok(loaded)
    }

    /// Returns a recently checked in-memory index, refreshing stale entries first.
    pub fn load_for_search(
        &self,
        root: &Path,
        identity: &str,
        content: &[ContentType],
    ) -> Result<Arc<LoadedIndex>> {
        let layout = CacheLayout::new(
            &self.config.cache_dir,
            identity,
            self.embedder.id(),
            content,
            self.config.desired_chunk_bytes,
        );
        if let Some(index) = self
            .loaded
            .lock()
            .get(&layout.snapshot)
            .filter(|cached| cached.checked_at.elapsed() < SEARCH_REFRESH_INTERVAL)
            .map(|cached| cached.index.clone())
        {
            return Ok(index);
        }
        self.load_or_build(root, identity, content)
    }

    fn store_loaded(&self, snapshot: std::path::PathBuf, index: Arc<LoadedIndex>) {
        self.loaded.lock().put(
            snapshot,
            CachedIndex {
                index,
                checked_at: Instant::now(),
            },
        );
    }

    fn checked_if_unchanged(
        &self,
        snapshot: &Path,
        files: &[crate::source::SourceFile],
    ) -> Option<Arc<LoadedIndex>> {
        let mut loaded = self.loaded.lock();
        let cached = loaded.get_mut(snapshot)?;
        if unchanged_loaded(files, &cached.index.metadata.files) {
            cached.checked_at = Instant::now();
            Some(cached.index.clone())
        } else {
            None
        }
    }

    pub(crate) fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embedder.encode(texts)
    }
}

fn quantize_vectors(vectors: Vec<Vec<f32>>, dimensions: usize) -> Result<Vec<i8>> {
    if vectors.iter().any(|vector| vector.len() != dimensions) {
        return Err(Error::CorruptIndex(
            "embedder returned an invalid vector shape".into(),
        ));
    }
    Ok(vectors
        .into_iter()
        .flatten()
        .map(|value| (value.clamp(-1.0, 1.0) * 127.0).round() as i8)
        .collect())
}

fn unchanged_loaded(files: &[crate::source::SourceFile], indexed: &[super::LoadedFile]) -> bool {
    if files.len() != indexed.len() {
        return false;
    }
    let stamps = indexed
        .iter()
        .map(|file| (file.path.as_str(), file.stamp))
        .collect::<HashMap<_, _>>();
    files
        .iter()
        .all(|file| stamps.get(file.relative_path.as_str()) == Some(&file.stamp))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct CountingEmbedder(AtomicUsize);

    impl Embedder for CountingEmbedder {
        fn id(&self) -> &str {
            "counting-v1"
        }
        fn dimensions(&self) -> usize {
            2
        }
        fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            self.0.fetch_add(texts.len(), Ordering::SeqCst);
            Ok(texts
                .iter()
                .map(|text| vec![text.len() as f32, 1.0])
                .collect())
        }
    }

    #[test]
    fn unchanged_files_reuse_persisted_chunks_and_vectors() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(
            source.path().join("lib.rs"),
            "pub fn one() { println!(\"one\"); }\n",
        )
        .unwrap();
        let embedder = Arc::new(CountingEmbedder(AtomicUsize::new(0)));
        let repository = IndexRepository::new(SembleConfig::new(cache.path()), embedder.clone());

        let first = repository
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        let encoded = embedder.0.load(Ordering::SeqCst);
        assert!(encoded > 0);
        let second = repository
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        assert_eq!(embedder.0.load(Ordering::SeqCst), encoded);
        assert_eq!(first.chunks.len(), second.chunks.len());

        fs::write(
            source.path().join("lib.rs"),
            "pub fn two() { println!(\"changed and longer\"); }\n",
        )
        .unwrap();
        let changed = repository
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        assert!(embedder.0.load(Ordering::SeqCst) > encoded);
        assert!(changed
            .chunks
            .iter()
            .any(|chunk| chunk.content.contains("two")));
    }

    #[test]
    fn a_new_repository_instance_loads_the_same_disk_snapshot() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("lib.rs"), "pub fn persisted() {}\n").unwrap();
        let first_embedder = Arc::new(CountingEmbedder(AtomicUsize::new(0)));
        IndexRepository::new(SembleConfig::new(cache.path()), first_embedder)
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        let second_embedder = Arc::new(CountingEmbedder(AtomicUsize::new(0)));
        let loaded = IndexRepository::new(SembleConfig::new(cache.path()), second_embedder.clone())
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        assert_eq!(second_embedder.0.load(Ordering::SeqCst), 0);
        assert_eq!(loaded.chunks[0].file_path, "lib.rs");
    }

    #[test]
    fn a_new_repository_refreshes_changed_source_instead_of_using_stale_runtime_cache() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("lib.rs"), "pub fn before() {}\n").unwrap();
        IndexRepository::new(
            SembleConfig::new(cache.path()),
            Arc::new(CountingEmbedder(AtomicUsize::new(0))),
        )
        .load_or_build(source.path(), "fixture", &[ContentType::Code])
        .unwrap();

        fs::write(
            source.path().join("lib.rs"),
            "pub fn after() { println!(\"changed and longer\"); }\n",
        )
        .unwrap();
        let embedder = Arc::new(CountingEmbedder(AtomicUsize::new(0)));
        let loaded = IndexRepository::new(SembleConfig::new(cache.path()), embedder.clone())
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();

        assert!(embedder.0.load(Ordering::SeqCst) > 0);
        assert!(loaded.chunks[0].content.contains("after"));
    }

    #[test]
    fn search_cache_refreshes_after_the_fixed_interval() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("lib.rs"), "pub fn before() {}\n").unwrap();
        let repository = IndexRepository::new(
            SembleConfig::new(cache.path()),
            Arc::new(CountingEmbedder(AtomicUsize::new(0))),
        );
        repository
            .load_or_build(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        fs::write(source.path().join("lib.rs"), "pub fn after() {}\n").unwrap();

        let cached = repository
            .load_for_search(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        assert!(cached.chunks[0].content.contains("before"));

        for (_, cached) in repository.loaded.lock().iter_mut() {
            cached.checked_at = Instant::now() - SEARCH_REFRESH_INTERVAL;
        }
        let refreshed = repository
            .load_for_search(source.path(), "fixture", &[ContentType::Code])
            .unwrap();
        assert!(refreshed.chunks[0].content.contains("after"));
    }
}
