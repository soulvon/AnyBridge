//! Cached index lifecycle and semantic, lexical, and related-code queries.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

use parking_lot::Mutex;

use crate::{
    embedding::{Embedder, ModelAssets, StaticEmbedder},
    index::{IndexRepository, LoadedIndex},
    source::{canonical_source_root, RemoteRepository},
    ContentType, Error, FindRelatedRequest, IndexStats, Result, SearchRequest, SearchResponse,
    SembleConfig,
};

use super::{
    rerank::{is_symbol_query, rerank},
    rrf,
};


mod scoring;
#[cfg(test)]
mod tests;

use scoring::{
    is_literal_query, prioritize_evidence, quantize_query, quantized_cosine, rank_semantic,
    response, strong_lexical_matches,
};

pub(super) const NATURAL_LANGUAGE_SEMANTIC_WEIGHT: f32 = 0.5;
pub(super) const SYMBOL_SEMANTIC_WEIGHT: f32 = 0.3;


pub struct SearchEngine {
    config: SembleConfig,
    repository: IndexRepository,
}

static EMBEDDERS: LazyLock<Mutex<HashMap<PathBuf, Arc<StaticEmbedder>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

impl SearchEngine {
    pub fn load_default(config: SembleConfig) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|error| Error::ModelAsset(error.to_string()))?;
        Self::load_default_with_client(config, &client)
    }

    pub fn load_default_with_client(
        config: SembleConfig,
        client: &reqwest::blocking::Client,
    ) -> Result<Self> {
        let model_path = ModelAssets::model_path(&config.cache_dir);
        let cached = { EMBEDDERS.lock().get(&model_path).cloned() };
        let embedder = if let Some(embedder) = cached {
            embedder
        } else {
            let assets = ModelAssets::ensure_with_client(&config.cache_dir, client)?;
            let embedder = Arc::new(StaticEmbedder::load(&assets.model, &assets.tokenizer)?);
            EMBEDDERS
                .lock()
                .insert(assets.model.clone(), embedder.clone());
            embedder
        };
        Ok(Self::with_embedder(config, embedder))
    }

    pub fn with_embedder(config: SembleConfig, embedder: Arc<dyn Embedder>) -> Self {
        let repository = IndexRepository::new(config.clone(), embedder);
        Self { config, repository }
    }

    /// Opens a prepared index and incrementally refreshes changed source files.
    pub fn prepare(&self, repo: &Path, content: &[ContentType]) -> Result<IndexStats> {
        let (root, identity) = self.resolve_source(repo)?;
        let content = normalize_content(content);
        let index = self.repository.load_or_build(&root, &identity, &content)?;
        Ok(index_stats(&index))
    }

    /// Rescans source stamps and incrementally refreshes a prepared index.
    pub fn refresh(&self, repo: &Path, content: &[ContentType]) -> Result<IndexStats> {
        let (root, identity) = self.resolve_source(repo)?;
        let content = normalize_content(content);
        let index = self.repository.load_or_build(&root, &identity, &content)?;
        Ok(index_stats(&index))
    }

    pub fn search(&self, request: SearchRequest) -> Result<SearchResponse> {
        validate_query(&request.query, request.top_k)?;
        let (root, identity) = self.resolve_source(&request.repo)?;
        let content = normalize_content(&request.content);
        let index = self
            .repository
            .load_for_search(&root, &identity, &content)?;
        if !request.query.contains(char::is_whitespace) {
            let exact = index
                .lexical
                .exact_symbol(&request.query, &index.chunks, request.top_k);
            if !exact.is_empty() {
                return response(
                    &request.query,
                    exact,
                    &index,
                    &root,
                    request.max_snippet_lines,
                );
            }
        }
        let query_vector = quantize_query(self.encode_query(&index, &request.query)?);
        let candidate_count = request.top_k.saturating_mul(5).max(request.top_k);
        let semantic = rank_semantic(
            &query_vector,
            &index.vectors,
            index.metadata.dimensions,
            candidate_count,
        );
        let lexical = index.bm25.search(&request.query, candidate_count);
        let lexical_ranking = lexical
            .iter()
            .map(|matched| matched.document)
            .collect::<Vec<_>>();
        let symbol_query = is_symbol_query(&request.query);
        let semantic_weight = if symbol_query {
            SYMBOL_SEMANTIC_WEIGHT
        } else {
            NATURAL_LANGUAGE_SEMANTIC_WEIGHT
        };
        let fused = rrf::fuse(&semantic, &lexical_ranking, semantic_weight);
        let definitions = if !symbol_query {
            index
                .lexical
                .inferred_symbols(&request.query, &index.chunks, request.top_k)
        } else {
            Vec::new()
        };
        let strong_lexical = if symbol_query || !is_literal_query(&request.query) {
            Vec::new()
        } else {
            strong_lexical_matches(
                &lexical,
                &index.chunks,
                &request.query,
                &root,
                request.top_k.min(3),
            )?
        };
        let ranked = prioritize_evidence(
            strong_lexical,
            definitions,
            rerank(fused, &index.chunks, &request.query, request.top_k),
            request.top_k,
        );
        response(
            &request.query,
            ranked,
            &index,
            &root,
            request.max_snippet_lines,
        )
    }

    pub fn find_related(&self, request: FindRelatedRequest) -> Result<SearchResponse> {
        if request.line == 0 || request.top_k == 0 {
            return Err(Error::InvalidRequest(
                "line and top_k must be greater than zero".into(),
            ));
        }
        let (root, identity) = self.resolve_source(&request.repo)?;
        let content = normalize_content(&request.content);
        let index = self
            .repository
            .load_for_search(&root, &identity, &content)?;
        let normalized = request.file_path.replace('\\', "/");
        let source = index
            .chunks
            .iter()
            .position(|chunk| {
                chunk.file_path == normalized
                    && chunk.start_line <= request.line
                    && request.line <= chunk.end_line
            })
            .ok_or_else(|| {
                Error::InvalidRequest(format!(
                    "no indexed chunk contains {}:{}",
                    request.file_path, request.line
                ))
            })?;
        let dimensions = index.metadata.dimensions;
        let source_start = source * dimensions;
        let source_vector = &index.vectors[source_start..source_start + dimensions];
        let mut ranked =
            rank_semantic(source_vector, &index.vectors, dimensions, request.top_k + 1)
                .into_iter()
                .filter(|position| *position != source)
                .take(request.top_k)
                .map(|position| {
                    (
                        position,
                        quantized_cosine(
                            source_vector,
                            &index.vectors[position * dimensions..(position + 1) * dimensions],
                        ),
                    )
                })
                .collect::<Vec<_>>();
        ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
        response(
            &format!("Chunks related to {}:{}", request.file_path, request.line),
            ranked,
            &index,
            &root,
            request.max_snippet_lines,
        )
    }

    fn resolve_source(&self, source: &Path) -> Result<(PathBuf, String)> {
        let value = source.to_string_lossy();
        if value.starts_with("https://") || value.starts_with("http://") {
            let remote = RemoteRepository::acquire(&value, &self.config.cache_dir)?;
            Ok((remote.path, remote.identity))
        } else {
            let root = canonical_source_root(source)?;
            let identity = root.to_string_lossy().into_owned();
            Ok((root, identity))
        }
    }

    fn encode_query(&self, _index: &LoadedIndex, query: &str) -> Result<Vec<f32>> {
        self.repository
            .encode(&[query.to_owned()])
            .map(|mut values| values.remove(0))
    }
}

fn validate_query(query: &str, top_k: usize) -> Result<()> {
    if query.trim().is_empty() {
        return Err(Error::InvalidRequest("query must not be empty".into()));
    }
    if top_k == 0 || top_k > 100 {
        return Err(Error::InvalidRequest(
            "top_k must be between 1 and 100".into(),
        ));
    }
    Ok(())
}

fn index_stats(index: &LoadedIndex) -> IndexStats {
    IndexStats {
        file_count: index.metadata.files.len(),
        chunk_count: index.chunks.len(),
        source_bytes: index
            .metadata
            .files
            .iter()
            .map(|file| file.stamp.size)
            .sum(),
        dimensions: index.metadata.dimensions,
    }
}

fn normalize_content(content: &[ContentType]) -> Vec<ContentType> {
    let mut output = if content.is_empty() {
        vec![ContentType::Code]
    } else {
        content.to_vec()
    };
    output.sort_by_key(|item| *item as u8);
    output.dedup();
    output
}
