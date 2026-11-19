use std::fs;

use super::scoring::is_literal_query;
use super::*;

struct KeywordEmbedder;

impl Embedder for KeywordEmbedder {
    fn id(&self) -> &str {
        "keyword-v1"
    }
    fn dimensions(&self) -> usize {
        3
    }
    fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts
            .iter()
            .map(|text| {
                let text = text.to_ascii_lowercase();
                let mut vector = vec![
                    usize::from(text.contains("auth")) as f32,
                    usize::from(text.contains("invoice")) as f32,
                    usize::from(text.contains("parse")) as f32,
                ];
                let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
                if norm > 0.0 {
                    vector.iter_mut().for_each(|value| *value /= norm);
                }
                vector
            })
            .collect())
    }
}

fn fixture() -> (tempfile::TempDir, tempfile::TempDir, SearchEngine) {
    let source = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    fs::create_dir_all(source.path().join("src")).unwrap();
    fs::write(
        source.path().join("src/auth.rs"),
        "pub fn authenticate_request() {\n    verify_token();\n}\n",
    )
    .unwrap();
    fs::write(
        source.path().join("src/billing.rs"),
        "pub fn create_invoice() {\n    charge_customer();\n}\n",
    )
    .unwrap();
    let engine =
        SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));
    (source, cache, engine)
}

#[test]
fn hybrid_search_returns_locations_and_bounded_snippets() {
    let (source, _cache, engine) = fixture();
    let response = engine
        .search(SearchRequest {
            query: "authenticate request".into(),
            repo: source.path().into(),
            top_k: 1,
            max_snippet_lines: Some(1),
            content: vec![ContentType::Code],
        })
        .unwrap();
    assert_eq!(response.results[0].file_path, "src/auth.rs");
    assert_eq!(
        response.results[0].content.as_deref(),
        Some("pub fn authenticate_request() {")
    );
}

#[test]
fn bm25_recovers_lexical_matches_when_semantic_scores_are_tied() {
    let (source, _cache, engine) = fixture();
    fs::write(
        source.path().join("src/tracing.rs"),
        "pub fn write_record() {\n    let description = \"quasar chronicle telemetry durable\";\n}\n",
    )
    .unwrap();

    let response = engine
        .search(SearchRequest {
            query: "quasar chronicle telemetry durable".into(),
            repo: source.path().into(),
            top_k: 1,
            max_snippet_lines: Some(0),
            content: vec![ContentType::Code],
        })
        .unwrap();

    assert_eq!(response.results[0].file_path, "src/tracing.rs");
}

#[test]
fn complete_multi_term_matches_rank_ahead_of_inferred_definitions() {
    let (source, cache, engine) = fixture();
    fs::write(
        source.path().join("src/definitions.rs"),
        "pub fn quasar_chronicle() {}\npub fn telemetry_durable() {}\n",
    )
    .unwrap();
    fs::write(
        source.path().join("src/literal.rs"),
        "pub fn diagnostic() {\n    let message = \"quasar chronicle telemetry durable\";\n}\n",
    )
    .unwrap();
    engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    drop(engine);
    let engine =
        SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));

    let response = engine
        .search(SearchRequest {
            query: "quasar chronicle telemetry durable".into(),
            repo: source.path().into(),
            top_k: 5,
            max_snippet_lines: Some(0),
            content: vec![ContentType::Code],
        })
        .unwrap();

    assert_eq!(response.results[0].file_path, "src/literal.rs");
    assert!(response
        .results
        .iter()
        .any(|result| result.file_path == "src/definitions.rs"));
}

#[test]
fn prepare_reports_the_persisted_index_shape() {
    let (source, _cache, engine) = fixture();
    let stats = engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    assert_eq!(stats.file_count, 2);
    assert_eq!(stats.chunk_count, 2);
    assert!(stats.source_bytes > 0);
    assert_eq!(stats.dimensions, 3);
}

#[test]
fn disk_loaded_indexes_read_result_snippets_from_source() {
    let (source, cache, engine) = fixture();
    engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    drop(engine);
    let reloaded =
        SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));
    let response = reloaded
        .search(SearchRequest {
            query: "authenticate request".into(),
            repo: source.path().into(),
            top_k: 1,
            max_snippet_lines: Some(1),
            content: vec![ContentType::Code],
        })
        .unwrap();
    assert_eq!(
        response.results[0].content.as_deref(),
        Some("pub fn authenticate_request() {")
    );
}

#[test]
fn disk_loaded_indexes_retain_bm25_search() {
    let (source, cache, engine) = fixture();
    fs::write(
        source.path().join("src/tracing.rs"),
        "pub fn write_record() {\n    let description = \"quasar chronicle telemetry durable\";\n}\n",
    )
    .unwrap();
    engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    drop(engine);
    let reloaded =
        SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));

    let response = reloaded
        .search(SearchRequest {
            query: "quasar chronicle telemetry durable".into(),
            repo: source.path().into(),
            top_k: 1,
            max_snippet_lines: Some(0),
            content: vec![ContentType::Code],
        })
        .unwrap();

    assert_eq!(response.results[0].file_path, "src/tracing.rs");
}

#[test]
fn explicit_refresh_makes_modified_files_searchable_during_the_cache_window() {
    let (source, _cache, engine) = fixture();
    engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    fs::write(
        source.path().join("src/auth.rs"),
        "pub fn parse_request() {\n    parse_payload();\n    validate_fields();\n}\n",
    )
    .unwrap();

    let stale = engine
        .search(SearchRequest {
            query: "parse_request".into(),
            repo: source.path().into(),
            top_k: 1,
            max_snippet_lines: Some(3),
            content: vec![ContentType::Code],
        })
        .unwrap();
    assert!(!stale.results[0]
        .content
        .as_deref()
        .unwrap_or_default()
        .contains("parse_request"));

    engine.refresh(source.path(), &[ContentType::Code]).unwrap();
    let response = engine
        .search(SearchRequest {
            query: "parse_request".into(),
            repo: source.path().into(),
            top_k: 1,
            max_snippet_lines: Some(0),
            content: vec![ContentType::Code],
        })
        .unwrap();

    assert_eq!(response.results[0].file_path, "src/auth.rs");
    assert!(response.results[0].score >= 1.0);
}

#[test]
fn explicit_refresh_makes_new_files_available_to_related_search() {
    let (source, _cache, engine) = fixture();
    engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    fs::write(
        source.path().join("src/parser.rs"),
        "pub fn parse_document() {\n    parse_payload();\n}\n",
    )
    .unwrap();
    engine.refresh(source.path(), &[ContentType::Code]).unwrap();

    let response = engine
        .find_related(FindRelatedRequest {
            repo: source.path().into(),
            file_path: "src/parser.rs".into(),
            line: 1,
            top_k: 1,
            max_snippet_lines: Some(0),
            content: vec![ContentType::Code],
        })
        .unwrap();

    assert_eq!(response.results.len(), 1);
    assert_ne!(response.results[0].file_path, "src/parser.rs");
}

#[test]
fn prepare_removes_deleted_files_from_the_index() {
    let (source, _cache, engine) = fixture();
    engine.prepare(source.path(), &[ContentType::Code]).unwrap();
    fs::remove_file(source.path().join("src/auth.rs")).unwrap();

    let stats = engine.prepare(source.path(), &[ContentType::Code]).unwrap();

    assert_eq!(stats.file_count, 1);
    assert_eq!(stats.chunk_count, 1);
}

#[test]
fn related_search_excludes_the_source_chunk() {
    let (source, _cache, engine) = fixture();
    let response = engine
        .find_related(FindRelatedRequest {
            repo: source.path().into(),
            file_path: "src/auth.rs".into(),
            line: 1,
            top_k: 1,
            max_snippet_lines: Some(2),
            content: vec![ContentType::Code],
        })
        .unwrap();
    assert_eq!(response.results.len(), 1);
    assert_ne!(response.results[0].file_path, "src/auth.rs");
}

#[test]
fn invalid_queries_fail_before_indexing() {
    let (_source, _cache, engine) = fixture();
    let request = SearchRequest::new("", "/missing");
    assert!(matches!(
        engine.search(request),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn distinguishes_literal_fragments_from_behavior_queries() {
    assert!(is_literal_query("Semble Code Search"));
    assert!(is_literal_query(
        "MCP tool not found server not found permission denied"
    ));
    assert!(!is_literal_query(
        "dispatch built-in MCP tool calls to the registered server implementation"
    ));
    assert!(!is_literal_query("create a concurrent React DOM root"));
}
