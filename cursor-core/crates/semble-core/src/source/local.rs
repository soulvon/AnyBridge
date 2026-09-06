//! Deterministic local file discovery with gitignore and Semble exclusions.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    time::UNIX_EPOCH,
};

use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};

use crate::{language::content_type_for_path, ContentType, Error, Result};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    ".venv",
    "venv",
    ".tox",
    "__pycache__",
    ".next",
    "dist",
    "build",
    ".cache",
    ".semble",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileStamp {
    pub modified_ns: u128,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct SourceFile {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub stamp: FileStamp,
    pub content_type: ContentType,
}

pub fn discover_files(
    root: &Path,
    selected: &[ContentType],
    max_bytes: u64,
) -> Result<Vec<SourceFile>> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .add_custom_ignore_filename(".sembleignore")
        .filter_entry(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| {
                    !entry.file_type().is_some_and(|kind| kind.is_dir())
                        || !IGNORED_DIRS.contains(&name)
                })
                .unwrap_or(true)
        });
    let (sender, receiver) = mpsc::channel();
    builder.build_parallel().run(|| {
        let sender = sender.clone();
        Box::new(move |entry| {
            let result = entry
                .map_err(|error| Error::InvalidRequest(error.to_string()))
                .and_then(|entry| source_file(root, selected, max_bytes, entry));
            let _ = sender.send(result);
            WalkState::Continue
        })
    });
    drop(sender);
    let mut files = Vec::new();
    for result in receiver {
        if let Some(file) = result? {
            files.push(file);
        }
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn source_file(
    root: &Path,
    selected: &[ContentType],
    max_bytes: u64,
    entry: ignore::DirEntry,
) -> Result<Option<SourceFile>> {
    if !entry.file_type().is_some_and(|kind| kind.is_file()) {
        return Ok(None);
    }
    let path = entry.path();
    let Some(content_type) = content_type_for_path(path) else {
        return Ok(None);
    };
    if !selected.contains(&content_type) {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(|error| Error::io(path, error))?;
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Ok(None);
    }
    let relative_path = path
        .strip_prefix(root)
        .map_err(|_| Error::UnsafePath(path.to_path_buf()))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Ok(Some(SourceFile {
        absolute_path: path.to_path_buf(),
        relative_path: relative_path.to_string_lossy().replace('\\', "/"),
        stamp: FileStamp {
            modified_ns,
            size: metadata.len(),
        },
        content_type,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_obeys_content_scope_and_ignore_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("src")).unwrap();
        fs::create_dir_all(directory.path().join("target")).unwrap();
        fs::write(directory.path().join("src/lib.rs"), "pub fn visible() {}\n").unwrap();
        fs::write(
            directory.path().join("src/ignored.rs"),
            "pub fn ignored() {}\n",
        )
        .unwrap();
        fs::write(directory.path().join("README.md"), "# docs\n").unwrap();
        fs::write(
            directory.path().join("target/generated.rs"),
            "fn generated() {}\n",
        )
        .unwrap();
        fs::write(directory.path().join(".sembleignore"), "src/ignored.rs\n").unwrap();

        let code = discover_files(directory.path(), &[ContentType::Code], 1024).unwrap();
        assert_eq!(
            code.iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/lib.rs"]
        );
        let docs = discover_files(directory.path(), &[ContentType::Docs], 1024).unwrap();
        assert_eq!(docs[0].relative_path, "README.md");
    }

    #[test]
    fn discovery_skips_empty_and_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("empty.rs"), "").unwrap();
        fs::write(directory.path().join("large.rs"), "0123456789").unwrap();
        assert!(discover_files(directory.path(), &[ContentType::Code], 5)
            .unwrap()
            .is_empty());
    }
}
