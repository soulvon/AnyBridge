//! Recursive Tree-sitter boundary selection and public chunk construction.

use tree_sitter::Node;

use crate::{language::parser_for, types::Chunk};

use super::{boundary::merge_adjacent, line_boundaries, ChunkBoundary};

const MAX_DEPTH: usize = 500;
const MIN_CHUNK_BYTES: usize = 50;

pub fn chunk_source(
    source: &str,
    file_path: &str,
    language: Option<&str>,
    desired: usize,
) -> Vec<Chunk> {
    if source.trim().is_empty() {
        return Vec::new();
    }
    let boundaries = language
        .and_then(parser_for)
        .and_then(|mut parser| parser.parse(source, None))
        .map(|tree| merge_adjacent(split_node(tree.root_node(), desired, 0), desired))
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| line_boundaries(source, desired));
    boundaries
        .into_iter()
        .filter_map(|boundary| {
            let content = source.get(boundary.start..boundary.end)?.to_owned();
            let start_line = source[..boundary.start]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count()
                + 1;
            let end_line = start_line + content.lines().count().saturating_sub(1);
            Some(Chunk {
                file_path: file_path.to_owned(),
                start_line,
                end_line,
                language: language.map(str::to_owned),
                content,
            })
        })
        .collect()
}

fn split_node(node: Node<'_>, desired: usize, depth: usize) -> Vec<ChunkBoundary> {
    if node.child_count() == 0
        || depth > MAX_DEPTH
        || node.end_byte().saturating_sub(node.start_byte()) < MIN_CHUNK_BYTES
    {
        return vec![ChunkBoundary {
            start: node.start_byte(),
            end: node.end_byte(),
        }];
    }
    let mut cursor = node.walk();
    let children = node.children(&mut cursor).collect::<Vec<_>>();
    let mut output = Vec::new();
    let mut index = 0;
    while index < children.len() {
        let child = children[index];
        index += 1;
        if child.end_byte().saturating_sub(child.start_byte()) > desired {
            output.extend(split_node(child, desired, depth + 1));
            continue;
        }
        let start = child.start_byte();
        let mut end = child.end_byte();
        while index < children.len() && children[index].end_byte().saturating_sub(start) <= desired
        {
            end = children[index].end_byte();
            index += 1;
        }
        output.push(ChunkBoundary { start, end });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_chunks_keep_paths_lines_and_source_text() {
        let source =
            "fn first() {\n    println!(\"one\");\n}\n\nfn second() {\n    println!(\"two\");\n}\n";
        let chunks = chunk_source(source, "src/lib.rs", Some("rust"), 48);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].file_path, "src/lib.rs");
        assert_eq!(chunks[0].start_line, 1);
        assert!(chunks.iter().any(|chunk| chunk.content.contains("second")));
        assert!(chunks.iter().all(|chunk| !chunk.content.is_empty()));
    }

    #[test]
    fn unsupported_languages_fall_back_to_line_chunks() {
        let source = "alpha beta gamma\ndelta epsilon\nzeta eta theta\n";
        let chunks = chunk_source(source, "notes.unknown", None, 24);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks.last().unwrap().end_line, 3);
    }

    #[test]
    fn multibyte_character_at_a_chunk_boundary_does_not_panic() {
        let source = "// 中文说明。";
        let chunks = chunk_source(source, "src/lib.rs", Some("rust"), 750);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, source);
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks[0].end_line, 1);
    }
}
