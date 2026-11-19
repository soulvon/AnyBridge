use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::{
    index::{tokenize, Bm25Match, LoadedIndex},
    types::snippet,
    Error, Result, SearchResponse, SearchResult,
};

use super::super::rerank::path_penalty;

pub(super) fn strong_lexical_matches(
    lexical: &[Bm25Match],
    chunks: &[crate::Chunk],
    query: &str,
    root: &Path,
    limit: usize,
) -> Result<Vec<(usize, f32)>> {
    let query_terms = tokenize(query).into_iter().collect::<HashSet<_>>();
    if query_terms.len() < 2 || lexical.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let top_score = lexical[0].score.max(f32::EPSILON);
    let mut files = HashMap::<String, String>::new();
    let mut strong = Vec::new();
    for matched in lexical {
        let score_ratio = matched.score / top_score;
        let phrase = if matched.coverage >= 0.5 {
            let content = indexed_chunk_text(&chunks[matched.document], root, &mut files)?;
            if path_penalty(&chunks[matched.document].file_path) < 0.5
                || content.trim_start().starts_with("#[cfg(test)]")
            {
                continue;
            }
            contains_normalized_phrase(query, &content)
        } else {
            false
        };
        if !phrase && (matched.coverage < 0.8 || score_ratio < 0.7) {
            continue;
        }
        let strength = (score_ratio + matched.coverage + if phrase { 2.0 } else { 0.0 })
            * path_penalty(&chunks[matched.document].file_path);
        strong.push((matched.document, strength));
    }
    strong.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| chunks[left.0].file_path.cmp(&chunks[right.0].file_path))
            .then_with(|| chunks[left.0].start_line.cmp(&chunks[right.0].start_line))
    });
    strong.truncate(limit);
    Ok(strong)
}

pub(super) fn is_literal_query(query: &str) -> bool {
    let lower = query.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if [
        "not found",
        "permission denied",
        "access denied",
        "unauthorized",
        "forbidden",
        "invalid argument",
        "missing ",
        "failed to",
        "panic",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower
            .chars()
            .any(|character| matches!(character, '`' | '"' | '\'' | '{' | '}' | '='))
    {
        return true;
    }
    let terms = lower.split_whitespace().collect::<Vec<_>>();
    if !(2..=8).contains(&terms.len()) {
        return false;
    }
    let natural_connectors = [
        "a", "an", "and", "as", "at", "by", "for", "from", "how", "in", "into", "is", "of", "on",
        "the", "to", "using", "when", "where", "while", "with",
    ];
    let behavior_verbs = [
        "build",
        "call",
        "compile",
        "create",
        "define",
        "dispatch",
        "find",
        "handle",
        "hydrate",
        "implement",
        "load",
        "parse",
        "persist",
        "read",
        "record",
        "register",
        "render",
        "save",
        "schedule",
        "search",
        "send",
        "store",
        "update",
        "watch",
        "write",
    ];
    !terms.iter().any(|term| natural_connectors.contains(term))
        && !behavior_verbs.contains(&terms[0])
}

fn indexed_chunk_text(
    chunk: &crate::Chunk,
    root: &Path,
    files: &mut HashMap<String, String>,
) -> Result<String> {
    if !chunk.content.is_empty() {
        return Ok(chunk.content.clone());
    }
    if !files.contains_key(&chunk.file_path) {
        let path = root.join(&chunk.file_path);
        let source = std::fs::read_to_string(&path).map_err(|error| Error::io(&path, error))?;
        files.insert(chunk.file_path.clone(), source);
    }
    Ok(files[&chunk.file_path]
        .lines()
        .skip(chunk.start_line.saturating_sub(1))
        .take(chunk.end_line.saturating_sub(chunk.start_line) + 1)
        .collect::<Vec<_>>()
        .join("\n"))
}

fn contains_normalized_phrase(query: &str, content: &str) -> bool {
    let phrase = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let source = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    !phrase.is_empty() && source.contains(&phrase)
}

pub(super) fn prioritize_evidence(
    strong_lexical: Vec<(usize, f32)>,
    definitions: Vec<(usize, f32)>,
    ranked: Vec<(usize, f32)>,
    top_k: usize,
) -> Vec<(usize, f32)> {
    let mut output = strong_lexical;
    for candidate in definitions.into_iter().chain(ranked) {
        if !output.iter().any(|existing| existing.0 == candidate.0) {
            output.push(candidate);
        }
    }
    output.truncate(top_k);
    output
}

pub(super) fn rank_semantic(query: &[i8], vectors: &[i8], dimensions: usize, limit: usize) -> Vec<usize> {
    let scores = vectors
        .chunks_exact(dimensions)
        .map(|vector| quantized_dot(query, vector))
        .collect::<Vec<_>>();
    rank_scores(&scores, limit, false)
}

fn rank_scores(scores: &[f32], limit: usize, exclude_zero: bool) -> Vec<usize> {
    let mut indices = (0..scores.len())
        .filter(|index| !exclude_zero || scores[*index] > 0.0)
        .collect::<Vec<_>>();
    indices.sort_by(|left, right| {
        scores[*right]
            .total_cmp(&scores[*left])
            .then_with(|| left.cmp(right))
    });
    indices.truncate(limit.min(indices.len()));
    indices
}

fn quantized_dot(left: &[i8], right: &[i8]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| i32::from(*left) * i32::from(*right))
        .sum::<i32>() as f32
}

pub(super) fn quantized_cosine(left: &[i8], right: &[i8]) -> f32 {
    quantized_dot(left, right) / (127.0 * 127.0)
}

pub(super) fn quantize_query(vector: Vec<f32>) -> Vec<i8> {
    vector
        .into_iter()
        .map(|value| (value.clamp(-1.0, 1.0) * 127.0).round() as i8)
        .collect()
}

pub(super) fn response(
    query: &str,
    ranked: Vec<(usize, f32)>,
    index: &LoadedIndex,
    root: &Path,
    max_lines: Option<usize>,
) -> Result<SearchResponse> {
    Ok(SearchResponse {
        query: query.to_owned(),
        results: ranked
            .into_iter()
            .map(|(position, score)| {
                let chunk = &index.chunks[position];
                Ok(SearchResult {
                    file_path: chunk.file_path.clone(),
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    score,
                    content: chunk_content(root, chunk, max_lines)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    })
}

fn chunk_content(
    root: &Path,
    chunk: &crate::Chunk,
    lines: Option<usize>,
) -> Result<Option<String>> {
    if lines == Some(0) {
        return Ok(None);
    }
    if !chunk.content.is_empty() {
        return Ok(snippet(&chunk.content, lines));
    }
    let path = root.join(&chunk.file_path);
    let source = std::fs::read_to_string(&path).map_err(|error| Error::io(&path, error))?;
    let available = chunk.end_line.saturating_sub(chunk.start_line) + 1;
    let limit = lines.unwrap_or(available).min(available);
    Ok(Some(
        source
            .lines()
            .skip(chunk.start_line.saturating_sub(1))
            .take(limit)
            .collect::<Vec<_>>()
            .join("\n"),
    ))
}
