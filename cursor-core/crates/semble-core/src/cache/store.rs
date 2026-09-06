//! Corruption-resistant bincode snapshot loading and atomic replacement.

use std::{fs, io::Write, path::Path};

use crate::{
    index::{IndexSnapshot, LoadedIndex},
    Error, Result,
};

pub fn load_snapshot(path: &Path) -> Result<Option<IndexSnapshot>> {
    let Some(snapshot) = load::<IndexSnapshot>(path)? else {
        return Ok(None);
    };
    snapshot.validate()?;
    Ok(Some(snapshot))
}

pub fn save_snapshot(path: &Path, snapshot: &IndexSnapshot) -> Result<()> {
    snapshot.validate()?;
    save(path, snapshot)
}

pub fn load_runtime(path: &Path) -> Result<Option<LoadedIndex>> {
    let Some(runtime) = load::<LoadedIndex>(path)? else {
        return Ok(None);
    };
    runtime.validate()?;
    Ok(Some(runtime))
}

pub fn save_runtime(path: &Path, runtime: &LoadedIndex) -> Result<()> {
    runtime.validate()?;
    save(path, runtime)
}

fn load<T>(path: &Path) -> Result<Option<T>>
where
    T: serde::de::DeserializeOwned,
{
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| Error::io(path, error))?;
    let (value, consumed): (T, usize) =
        bincode::serde::decode_from_slice(&bytes, bincode::config::standard())
            .map_err(|error| Error::CorruptIndex(error.to_string()))?;
    if consumed != bytes.len() {
        return Err(Error::CorruptIndex("cache has trailing bytes".into()));
    }
    Ok(Some(value))
}

fn save<T>(path: &Path, value: &T) -> Result<()>
where
    T: serde::Serialize,
{
    let parent = path
        .parent()
        .ok_or_else(|| Error::InvalidRequest("snapshot path has no parent".into()))?;
    fs::create_dir_all(parent).map_err(|error| Error::io(parent, error))?;
    let temporary = parent.join(format!(".cache-{}-{}.tmp", std::process::id(), now_nanos()));
    let bytes = bincode::serde::encode_to_vec(value, bincode::config::standard())
        .map_err(|error| Error::Serialization(error.to_string()))?;
    let mut file = fs::File::create(&temporary).map_err(|error| Error::io(&temporary, error))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| Error::io(&temporary, error))?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| Error::io(path, error))?;
    }
    fs::rename(&temporary, path).map_err(|error| Error::io(path, error))
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos())
}

#[cfg(test)]
mod tests {
    use crate::{
        config::INDEX_FORMAT_VERSION, index::IndexedFile, source::FileStamp, Chunk, ContentType,
    };

    use super::*;

    fn snapshot() -> IndexSnapshot {
        IndexSnapshot {
            format_version: INDEX_FORMAT_VERSION,
            source_identity: "source".into(),
            model_id: "test-model".into(),
            dimensions: 2,
            desired_chunk_bytes: 128,
            content: vec![ContentType::Code],
            files: vec![IndexedFile {
                path: "src/lib.rs".into(),
                stamp: FileStamp {
                    modified_ns: 1,
                    size: 4,
                },
                content_type: ContentType::Code,
                chunks: vec![Chunk {
                    file_path: "src/lib.rs".into(),
                    start_line: 1,
                    end_line: 1,
                    language: Some("rust".into()),
                    content: "code".into(),
                }],
                definitions: Vec::new(),
                lexical_documents: vec![crate::index::lexical_document("code")],
                vectors: vec![127, 0],
            }],
        }
    }

    #[test]
    fn snapshots_round_trip_and_reject_trailing_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/index.bin");
        save_snapshot(&path, &snapshot()).unwrap();
        let loaded = load_snapshot(&path).unwrap().unwrap();
        assert!(loaded.files[0].chunks[0].content.is_empty());
        let mut bytes = fs::read(&path).unwrap();
        bytes.push(0xff);
        fs::write(&path, bytes).unwrap();
        assert!(matches!(load_snapshot(&path), Err(Error::CorruptIndex(_))));
    }

    #[test]
    fn runtime_indexes_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/runtime.bin");
        let runtime = LoadedIndex::from_snapshot(snapshot()).unwrap();
        save_runtime(&path, &runtime).unwrap();
        let loaded = load_runtime(&path).unwrap().unwrap();
        assert_eq!(loaded.chunks.len(), 1);
        assert_eq!(loaded.vectors, vec![127, 0]);
        assert!(loaded
            .lexical
            .exact_symbol("missing", &loaded.chunks, 1)
            .is_empty());
    }
}
