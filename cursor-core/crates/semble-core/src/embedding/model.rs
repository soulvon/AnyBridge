//! Safetensors-backed mean-pooled and L2-normalized static embedding inference.

use std::{fs, path::Path};

use half::f16;
use rayon::prelude::*;
use safetensors::{tensor::Dtype, SafeTensors};
use tokenizers::Tokenizer;

use crate::{Error, Result};

pub trait Embedder: Send + Sync {
    fn id(&self) -> &str;
    fn dimensions(&self) -> usize;
    fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

pub struct StaticEmbedder {
    tokenizer: Tokenizer,
    embeddings: Vec<f16>,
    rows: usize,
    dimensions: usize,
}

impl StaticEmbedder {
    pub fn load(model: &Path, tokenizer: &Path) -> Result<Self> {
        let bytes = fs::read(model).map_err(|error| Error::io(model, error))?;
        let tensors =
            SafeTensors::deserialize(&bytes).map_err(|error| Error::Model(error.to_string()))?;
        let tensor = tensors
            .tensor("embeddings")
            .map_err(|error| Error::Model(error.to_string()))?;
        if tensor.dtype() != Dtype::F16 || tensor.shape().len() != 2 {
            return Err(Error::Model(
                "embeddings must be a rank-2 F16 tensor".into(),
            ));
        }
        let rows = tensor.shape()[0];
        let dimensions = tensor.shape()[1];
        let embeddings = tensor
            .data()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|value| f16::from_le_bytes(*value))
            .collect();
        let tokenizer =
            Tokenizer::from_file(tokenizer).map_err(|error| Error::Model(error.to_string()))?;
        Ok(Self {
            tokenizer,
            embeddings,
            rows,
            dimensions,
        })
    }

    fn encode_one(&self, text: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, false)
            .map_err(|error| Error::Model(error.to_string()))?;
        let ids = encoding
            .get_ids()
            .iter()
            .copied()
            .filter(|id| *id != 1)
            .take(512)
            .collect::<Vec<_>>();
        let mut output = vec![0.0; self.dimensions];
        let mut count = 0_f32;
        for id in ids {
            let row = id as usize;
            if row >= self.rows {
                continue;
            }
            let start = row * self.dimensions;
            for (slot, value) in output
                .iter_mut()
                .zip(&self.embeddings[start..start + self.dimensions])
            {
                *slot += value.to_f32();
            }
            count += 1.0;
        }
        if count > 0.0 {
            for value in &mut output {
                *value /= count;
            }
        }
        normalize(&mut output);
        Ok(output)
    }
}

impl Embedder for StaticEmbedder {
    fn id(&self) -> &str {
        "minishlab/potion-code-16M-v2"
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }
    fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        texts.par_iter().map(|text| self.encode_one(text)).collect()
    }
}

pub(crate) fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for value in vector {
            *value /= norm;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_produces_unit_vectors_and_keeps_zero_stable() {
        let mut vector = [3.0, 4.0];
        normalize(&mut vector);
        assert!((vector[0] - 0.6).abs() < 0.0001);
        assert!((vector[1] - 0.8).abs() < 0.0001);
        let mut zero = [0.0, 0.0];
        normalize(&mut zero);
        assert_eq!(zero, [0.0, 0.0]);
    }

    #[test]
    fn loads_and_encodes_the_pinned_model_fixture_when_available() {
        let (Some(model), Some(tokenizer)) = (
            std::env::var_os("SEMBLE_TEST_MODEL"),
            std::env::var_os("SEMBLE_TEST_TOKENIZER"),
        ) else {
            return;
        };
        let model = StaticEmbedder::load(Path::new(&model), Path::new(&tokenizer)).unwrap();
        assert_eq!(model.dimensions(), 256);
        let vectors = model
            .encode(&["parse an HTTP response".into(), "create an invoice".into()])
            .unwrap();
        assert_eq!(vectors.len(), 2);
        assert!(vectors.iter().all(|vector| vector.len() == 256));
        assert!(vectors.iter().all(|vector| {
            let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
            (norm - 1.0).abs() < 0.001
        }));
        assert_ne!(vectors[0], vectors[1]);
    }
}
