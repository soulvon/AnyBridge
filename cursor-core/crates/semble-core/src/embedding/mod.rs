//! Model2Vec-compatible static token embeddings and managed model assets.

mod assets;
mod model;

pub use assets::ModelAssets;
pub use model::{Embedder, StaticEmbedder};
