//! Language-agnostic chunking for unsupported or unparsable source files.

use super::{boundary::merge_adjacent, ChunkBoundary};

pub fn line_boundaries(source: &str, desired: usize) -> Vec<ChunkBoundary> {
    if source.trim().is_empty() {
        return Vec::new();
    }
    let mut offset = 0;
    let boundaries = source
        .split_inclusive('\n')
        .map(|line| {
            let start = offset;
            offset += line.len();
            ChunkBoundary { start, end: offset }
        })
        .collect();
    merge_adjacent(boundaries, desired)
}
