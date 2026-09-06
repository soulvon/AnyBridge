//! Verified, atomic download and reuse of the tokenizer and embedding matrix.

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::{Error, Result};

const MODEL_URL: &str =
    "https://huggingface.co/minishlab/potion-code-16M-v2/resolve/main/model.safetensors";
const TOKENIZER_URL: &str =
    "https://huggingface.co/minishlab/potion-code-16M-v2/resolve/main/tokenizer.json";
const MODEL_SHA256: &str = "75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c";
const TOKENIZER_SHA256: &str = "107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45";

#[derive(Clone, Debug)]
pub struct ModelAssets {
    pub model: PathBuf,
    pub tokenizer: PathBuf,
}

impl ModelAssets {
    pub fn model_path(cache_root: &Path) -> PathBuf {
        cache_root.join("models/potion-code-16M-v2/model.safetensors")
    }

    pub fn ensure(cache_root: &Path) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|error| Error::ModelAsset(error.to_string()))?;
        Self::ensure_with_client(cache_root, &client)
    }

    pub fn ensure_with_client(
        cache_root: &Path,
        client: &reqwest::blocking::Client,
    ) -> Result<Self> {
        let directory = cache_root.join("models/potion-code-16M-v2");
        fs::create_dir_all(&directory).map_err(|error| Error::io(&directory, error))?;
        let model = Self::model_path(cache_root);
        let tokenizer = directory.join("tokenizer.json");
        ensure_asset(client, &model, MODEL_URL, MODEL_SHA256)?;
        ensure_asset(client, &tokenizer, TOKENIZER_URL, TOKENIZER_SHA256)?;
        Ok(Self { model, tokenizer })
    }
}

fn ensure_asset(
    client: &reqwest::blocking::Client,
    path: &Path,
    url: &str,
    expected: &str,
) -> Result<()> {
    if path.is_file() && digest(path)? == expected {
        return Ok(());
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| Error::ModelAsset(format!("download {url}: {error}")))?;
    let bytes = response
        .bytes()
        .map_err(|error| Error::ModelAsset(error.to_string()))?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        return Err(Error::ModelAsset(format!(
            "checksum mismatch for {url}: expected {expected}, got {actual}"
        )));
    }
    let mut file = fs::File::create(&temporary).map_err(|error| Error::io(&temporary, error))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| Error::io(&temporary, error))?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| Error::io(path, error))?;
    }
    fs::rename(&temporary, path).map_err(|error| Error::io(path, error))
}

fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|error| Error::io(path, error))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| Error::io(path, error))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}
