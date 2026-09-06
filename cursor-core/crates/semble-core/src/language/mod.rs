//! Language detection and Tree-sitter parser selection.

mod catalog;
mod parser;

pub use catalog::{content_type_for_path, detect_language};
pub use parser::parser_for;
