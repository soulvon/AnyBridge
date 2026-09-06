//! Reciprocal Rank Fusion of independently ranked semantic and lexical candidates.

use std::collections::HashMap;

const RRF_K: f32 = 60.0;

pub fn fuse(semantic: &[usize], lexical: &[usize], alpha: f32) -> HashMap<usize, f32> {
    let mut scores = HashMap::new();
    for (rank, index) in semantic.iter().enumerate() {
        *scores.entry(*index).or_insert(0.0) += alpha / (RRF_K + rank as f32 + 1.0);
    }
    for (rank, index) in lexical.iter().enumerate() {
        *scores.entry(*index).or_insert(0.0) += (1.0 - alpha) / (RRF_K + rank as f32 + 1.0);
    }
    scores
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewards_items_present_in_both_lists() {
        let scores = fuse(&[1, 2], &[2, 3], 0.5);
        assert!(scores[&2] > scores[&1]);
        assert!(scores[&2] > scores[&3]);
    }
}
