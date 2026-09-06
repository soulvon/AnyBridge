//! Extension and special-filename catalog for code, documentation, and configuration.

use std::path::Path;

use crate::ContentType;

pub fn detect_language(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "rs" => "rust",
        "py" | "pyi" | "pyw" => "python",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "sh" | "bash" => "bash",
        "lua" => "lua",
        "ex" | "exs" => "elixir",
        "dart" => "dart",
        "sql" => "sql",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "json" | "json5" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "markdown" | "rst" | "adoc" => "markdown",
        _ => return None,
    })
}

pub fn content_type_for_path(path: &Path) -> Option<ContentType> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "cargo.toml"
            | "pyproject.toml"
            | "package.json"
            | "tsconfig.json"
            | "dockerfile"
            | "makefile"
            | ".gitignore"
            | ".sembleignore"
    ) {
        return Some(ContentType::Config);
    }
    let language = detect_language(path)?;
    if language == "markdown" {
        Some(ContentType::Docs)
    } else if matches!(language, "json" | "yaml" | "toml") {
        Some(ContentType::Config)
    } else {
        Some(ContentType::Code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_code_docs_and_configuration() {
        assert_eq!(
            content_type_for_path(Path::new("src/main.rs")),
            Some(ContentType::Code)
        );
        assert_eq!(
            content_type_for_path(Path::new("README.md")),
            Some(ContentType::Docs)
        );
        assert_eq!(
            content_type_for_path(Path::new("Cargo.toml")),
            Some(ContentType::Config)
        );
        assert_eq!(content_type_for_path(Path::new("image.png")), None);
    }
}
