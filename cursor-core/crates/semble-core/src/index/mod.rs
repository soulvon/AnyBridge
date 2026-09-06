//! Incremental persisted index construction and in-memory searchable snapshots.

mod bm25;
mod builder;
mod lexical;
mod snapshot;

pub(crate) use bm25::{lexical_document, Bm25Index, Bm25Match};
pub use builder::IndexRepository;
pub use lexical::{extract_definitions, tokenize, SymbolIndex};
pub use snapshot::{
    IndexSnapshot, IndexedDefinition, IndexedFile, IndexedLexicalDocument, IndexedTermFrequency,
    LoadedFile, LoadedIndex, LoadedMetadata,
};
