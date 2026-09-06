//! Byte boundaries used while partitioning source files into retrievable chunks.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkBoundary {
    pub start: usize,
    pub end: usize,
}

pub(crate) fn merge_adjacent(boundaries: Vec<ChunkBoundary>, desired: usize) -> Vec<ChunkBoundary> {
    let mut input = boundaries.into_iter();
    let Some(mut current) = input.next() else {
        return Vec::new();
    };
    let mut output = Vec::new();
    for next in input {
        if next.end.saturating_sub(current.start) <= desired {
            current.end = next.end;
        } else {
            output.push(current);
            current = next;
        }
    }
    output.push(current);
    output
}
