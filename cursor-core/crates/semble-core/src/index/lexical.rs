//! Compact inverted lexical index and definition-aware symbol lookup.

use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::Chunk;

use super::{IndexedDefinition, IndexedFile};

static DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:(?:export|default|async|declare|public|private|protected|static|pub(?:\([^)]*\))?)\s+)*(?:function|fn|def|class|struct|enum|trait|interface|type|record|module|namespace|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .expect("static declaration regex")
});

static BINDING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:(?:export|default|declare|public|private|protected|static|pub(?:\([^)]*\))?)\s+)*(?:const|let|var|static)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=",
    )
    .expect("static binding regex")
});

pub fn tokenize(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_alphabetic() && bytes[index] != b'_' {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
        {
            index += 1;
        }
        output.extend(split_identifier(&text[start..index]));
    }
    output
}

fn split_identifier(token: &str) -> Vec<String> {
    let lower = token.to_ascii_lowercase();
    let mut parts = Vec::new();
    if token.contains('_') {
        parts.extend(
            lower
                .split('_')
                .filter(|part| !part.is_empty())
                .map(str::to_owned),
        );
    } else {
        let chars = token.char_indices().collect::<Vec<_>>();
        let mut start = 0;
        for index in 1..chars.len() {
            let previous = chars[index - 1].1;
            let current = chars[index].1;
            let next = chars.get(index + 1).map(|item| item.1);
            if (previous.is_ascii_lowercase() && current.is_ascii_uppercase())
                || (previous.is_ascii_uppercase()
                    && current.is_ascii_uppercase()
                    && next.is_some_and(|value| value.is_ascii_lowercase()))
            {
                parts.push(token[start..chars[index].0].to_ascii_lowercase());
                start = chars[index].0;
            }
        }
        if start > 0 {
            parts.push(token[start..].to_ascii_lowercase());
        }
    }
    if parts.len() >= 2 {
        std::iter::once(lower).chain(parts).collect()
    } else {
        vec![lower]
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Definition {
    symbol: String,
    parts: Vec<String>,
    chunk: usize,
    implementation: bool,
}

#[derive(Deserialize, Serialize)]
pub struct SymbolIndex {
    definitions: Vec<Definition>,
    definitions_by_symbol: HashMap<String, Vec<usize>>,
}

impl SymbolIndex {
    pub fn from_files(files: &mut [IndexedFile]) -> Self {
        let mut definitions = Vec::new();
        let mut definitions_by_symbol = HashMap::<String, Vec<usize>>::new();
        let mut chunk_offset = 0;
        for file in files {
            for indexed in std::mem::take(&mut file.definitions) {
                let parts = symbol_parts(&indexed.symbol);
                let mut symbol = indexed.symbol;
                symbol.make_ascii_lowercase();
                let position = definitions.len();
                definitions.push(Definition {
                    symbol: symbol.clone(),
                    parts,
                    chunk: chunk_offset + indexed.chunk,
                    implementation: indexed.implementation,
                });
                definitions_by_symbol
                    .entry(symbol)
                    .or_default()
                    .push(position);
            }
            chunk_offset += file.chunks.len();
        }
        Self {
            definitions,
            definitions_by_symbol,
        }
    }

    pub fn exact_symbol(&self, query: &str, chunks: &[Chunk], limit: usize) -> Vec<(usize, f32)> {
        let symbol = query
            .rsplit([':', '.', '>'])
            .find(|part| !part.is_empty())
            .unwrap_or(query)
            .trim()
            .to_ascii_lowercase();
        self.rank_symbol(&symbol, chunks, limit)
    }

    pub fn inferred_symbols(
        &self,
        query: &str,
        chunks: &[Chunk],
        limit: usize,
    ) -> Vec<(usize, f32)> {
        let raw_terms = tokenize(query).into_iter().collect::<HashSet<_>>();
        let mut query_terms = raw_terms
            .iter()
            .map(|term| normalize_term(term))
            .collect::<HashSet<_>>();
        if query_terms.contains("update") {
            query_terms.insert("set".into());
        }
        let mut symbols = HashMap::<&str, f32>::new();
        for definition in &self.definitions {
            let meaningful = definition
                .parts
                .iter()
                .filter(|part| !is_generic_symbol_part(part))
                .collect::<Vec<_>>();
            let matched = meaningful
                .iter()
                .filter(|part| query_terms.contains(&normalize_term(part)))
                .count();
            let exact = definition.parts.len() > 1 && raw_terms.contains(&definition.symbol);
            let qualifies = exact
                || (meaningful.len() == 1 && matched == 1)
                || (meaningful.len() >= 2 && matched == meaningful.len())
                || (meaningful.len() >= 3 && matched >= 2);
            if !qualifies {
                continue;
            }
            let coverage = matched as f32 / meaningful.len().max(1) as f32;
            let unmatched = meaningful.len().saturating_sub(matched) as f32;
            let action_match = meaningful.iter().any(|part| {
                let normalized = normalize_term(part);
                query_terms.contains(&normalized) && is_action_symbol_part(&normalized)
            });
            let score = if exact { 1.0 } else { 0.0 } + coverage * 5.0 + matched as f32 * 2.0
                - unmatched * 3.0
                - meaningful.len() as f32 * 0.1
                + if action_match { 2.0 } else { 0.0 };
            symbols
                .entry(&definition.symbol)
                .and_modify(|current| *current = current.max(score))
                .or_insert(score);
        }
        let mut symbols = symbols.into_iter().collect::<Vec<_>>();
        symbols.sort_by(|left, right| right.1.total_cmp(&left.1).then_with(|| left.0.cmp(right.0)));
        symbols.truncate(limit.min(6));
        let mut output = Vec::new();
        for (symbol, symbol_score) in symbols {
            for (chunk, source_score) in self.rank_symbol(symbol, chunks, 1) {
                let path_matches = tokenize(&chunks[chunk].file_path)
                    .into_iter()
                    .map(|term| normalize_term(&term))
                    .collect::<HashSet<_>>()
                    .intersection(&query_terms)
                    .count();
                let source_weight = source_priority(&chunks[chunk].file_path, symbol).min(1.0);
                if source_weight < 0.5 {
                    continue;
                }
                output.push((
                    chunk,
                    (symbol_score * 10.0 + path_matches as f32 * 2.0) * source_weight
                        + source_score,
                ));
            }
        }
        output.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| left.0.cmp(&right.0))
        });
        output.dedup_by_key(|item| item.0);
        output.truncate(limit);
        output
    }

    fn rank_symbol(&self, symbol: &str, chunks: &[Chunk], limit: usize) -> Vec<(usize, f32)> {
        let mut output = self
            .definitions_by_symbol
            .get(symbol)
            .into_iter()
            .flatten()
            .map(|&position| {
                let definition = &self.definitions[position];
                let chunk = &chunks[definition.chunk];
                let score = (1.0 + if definition.implementation { 0.5 } else { 0.0 })
                    * source_priority(&chunk.file_path, symbol);
                (definition.chunk, score)
            })
            .collect::<Vec<_>>();
        output.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| chunks[left.0].file_path.cmp(&chunks[right.0].file_path))
                .then_with(|| chunks[right.0].start_line.cmp(&chunks[left.0].start_line))
        });
        output.dedup_by_key(|item| item.0);
        output.truncate(limit);
        output
    }

    pub(crate) fn validate(&self, chunks: usize) -> bool {
        if self
            .definitions
            .iter()
            .any(|definition| definition.chunk >= chunks)
        {
            return false;
        }
        let mut seen = vec![false; self.definitions.len()];
        for (symbol, positions) in &self.definitions_by_symbol {
            for &position in positions {
                let Some(definition) = self.definitions.get(position) else {
                    return false;
                };
                if definition.symbol != *symbol || std::mem::replace(&mut seen[position], true) {
                    return false;
                }
            }
        }
        seen.into_iter().all(|value| value)
    }
}

pub fn extract_definitions(chunks: &[Chunk]) -> Vec<IndexedDefinition> {
    let mut definitions = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        for captures in DECLARATION
            .captures_iter(&chunk.content)
            .chain(BINDING.captures_iter(&chunk.content))
        {
            let Some(matched) = captures.get(1) else {
                continue;
            };
            definitions.push(IndexedDefinition {
                symbol: matched.as_str().to_owned(),
                chunk: index,
                implementation: chunk.content[matched.end()..]
                    .lines()
                    .take(12)
                    .any(|line| line.contains('{') || line.trim_end().ends_with("=>")),
            });
        }
    }
    definitions
}

fn symbol_parts(symbol: &str) -> Vec<String> {
    let mut values = split_identifier(symbol);
    if values.len() > 1 {
        values.remove(0);
    }
    values
        .into_iter()
        .map(|part| normalize_term(&part))
        .collect()
}

fn normalize_term(term: &str) -> String {
    let lower = term.to_ascii_lowercase();
    match lower.as_str() {
        "application" | "applications" => "app".into(),
        "listener" | "listeners" | "listening" => "listen".into(),
        "rendered" | "rendering" => "render".into(),
        "hydrated" | "hydrating" => "hydrate".into(),
        "compiled" | "compiling" => "compile".into(),
        "parsed" | "parsing" => "parse".into(),
        "called" | "calling" => "call".into(),
        "cancelled" | "cancelling" | "cancellation" => "cancel".into(),
        "dispatched" | "dispatching" => "dispatch".into(),
        "interrupted" | "interrupting" | "interruption" => "interrupt".into(),
        "started" | "starting" => "start".into(),
        _ if lower.len() > 4 && lower.ends_with('s') => lower[..lower.len() - 1].into(),
        _ => lower,
    }
}

fn is_action_symbol_part(part: &str) -> bool {
    matches!(
        part,
        "build"
            | "call"
            | "cancel"
            | "commit"
            | "compile"
            | "create"
            | "define"
            | "dispatch"
            | "find"
            | "handle"
            | "hydrate"
            | "interrupt"
            | "listen"
            | "load"
            | "mount"
            | "parse"
            | "patch"
            | "persist"
            | "read"
            | "reconcile"
            | "record"
            | "register"
            | "render"
            | "save"
            | "schedule"
            | "search"
            | "send"
            | "set"
            | "start"
            | "store"
            | "update"
            | "watch"
            | "write"
    )
}

fn is_generic_symbol_part(part: &str) -> bool {
    matches!(
        part,
        "all" | "api" | "base" | "impl" | "internal" | "of" | "on" | "the" | "to"
    )
}

fn source_priority(path: &str, symbol: &str) -> f32 {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let mut score = 1.0;
    if normalized.contains("/src/") {
        score += 0.35;
    }
    let parts = normalized.split('/').collect::<Vec<_>>();
    if let Some(packages) = parts.iter().position(|part| *part == "packages") {
        if parts
            .get(packages + 1)
            .is_some_and(|package| !package.contains('-'))
        {
            score += 1.0;
        }
    }
    if normalized
        .rsplit('/')
        .next()
        .and_then(|file| file.rsplit_once('.').map(|(stem, _)| stem))
        .is_some_and(|stem| stem == symbol || stem.ends_with(symbol))
    {
        score += 0.4;
    }
    if normalized.split('/').any(|part| {
        matches!(
            part,
            "test" | "tests" | "__tests__" | "fixtures" | "examples" | "benchmarks"
        )
    }) || normalized.contains(".test.")
        || normalized.contains(".spec.")
        || normalized.contains("dts-test")
    {
        score *= 0.08;
    }
    if normalized
        .split('/')
        .any(|part| matches!(part, "playground" | "demo" | "demos"))
    {
        score *= 0.2;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(path: &str, content: &str) -> Chunk {
        Chunk {
            file_path: path.into(),
            start_line: 1,
            end_line: 1,
            language: Some("typescript".into()),
            content: content.into(),
        }
    }

    #[test]
    fn tokenizer_preserves_and_splits_common_identifiers() {
        assert_eq!(
            tokenize("HTTPResponse parse_request"),
            vec![
                "httpresponse",
                "http",
                "response",
                "parse_request",
                "parse",
                "request"
            ]
        );
    }

    #[test]
    fn exact_symbol_prefers_implementations_and_non_test_sources() {
        let chunks = [
            chunk("tests/useState.test.ts", "function useState() {}"),
            chunk("src/hooks.ts", "export function useState<T>(value: T)\n"),
            chunk(
                "src/hooks.ts",
                "export function useState(value: unknown) { return value }",
            ),
        ];
        let index = SymbolIndex::from_files(&mut [IndexedFile {
            path: "fixture.ts".into(),
            stamp: crate::source::FileStamp {
                modified_ns: 1,
                size: 1,
            },
            content_type: crate::ContentType::Code,
            definitions: extract_definitions(&chunks),
            lexical_documents: chunks
                .iter()
                .map(|chunk| super::super::lexical_document(&chunk.content))
                .collect(),
            chunks: chunks.to_vec(),
            vectors: vec![0; chunks.len()],
        }]);
        assert_eq!(index.exact_symbol("useState", &chunks, 3)[0].0, 2);
    }

    #[test]
    fn natural_queries_identify_composite_definitions() {
        let chunks = [
            chunk(
                "src/renderer.ts",
                "const patchKeyedChildren = () => { longestIncreasingSubsequence() }",
            ),
            chunk("src/other.ts", "function unrelated() {}"),
        ];
        let index = SymbolIndex::from_files(&mut [IndexedFile {
            path: "fixture.ts".into(),
            stamp: crate::source::FileStamp {
                modified_ns: 1,
                size: 1,
            },
            content_type: crate::ContentType::Code,
            definitions: extract_definitions(&chunks),
            lexical_documents: chunks
                .iter()
                .map(|chunk| super::super::lexical_document(&chunk.content))
                .collect(),
            chunks: chunks.to_vec(),
            vectors: vec![0; chunks.len()],
        }]);
        assert_eq!(
            index.inferred_symbols(
                "diff keyed children using the longest increasing subsequence",
                &chunks,
                5,
            )[0]
            .0,
            0
        );
    }

    #[test]
    fn natural_queries_prefer_symbols_that_match_behavior_words() {
        let chunks = [
            chunk("src/runtime.rs", "fn mcp_tool() {}"),
            chunk("src/runtime.rs", "fn built_in() {}"),
            chunk("src/dispatch.rs", "fn call_tool() {}"),
            chunk("tests/dispatch.rs", "fn dispatch_call_tool() {}"),
        ];
        let index = SymbolIndex::from_files(&mut [IndexedFile {
            path: "fixture.ts".into(),
            stamp: crate::source::FileStamp {
                modified_ns: 1,
                size: 1,
            },
            content_type: crate::ContentType::Code,
            definitions: extract_definitions(&chunks),
            lexical_documents: chunks
                .iter()
                .map(|chunk| super::super::lexical_document(&chunk.content))
                .collect(),
            chunks: chunks.to_vec(),
            vectors: vec![0; chunks.len()],
        }]);

        assert_eq!(
            index.inferred_symbols(
                "dispatch built-in MCP tool calls to the registered server implementation",
                &chunks,
                5,
            )[0]
            .0,
            2
        );
    }
}
