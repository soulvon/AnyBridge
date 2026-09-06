//! Downloads, verifies, extracts, and validates a pinned Deno runtime.
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::{
    asset::{RuntimeAsset, DENO_VERSION},
    runtime::PluginRuntimePhase,
};
use crate::{network, store::Store, Error, Result};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;

pub(super) async fn install(
    root: &Path,
    store: &Store,
    asset: RuntimeAsset,
    cancellation: CancellationToken,
    on_progress: impl Fn(PluginRuntimePhase, u64, Option<u64>),
) -> Result<()> {
    let paths = RuntimePaths::new(root, asset);
    tokio::fs::create_dir_all(&paths.download_dir).await?;
    tokio::fs::create_dir_all(&paths.install_dir).await?;
    remove_if_exists(&paths.archive).await?;
    remove_if_exists(&paths.executable_staging).await?;
    remove_if_exists(&paths.ready_marker).await?;

    let result = download_and_install(store, asset, &paths, &cancellation, &on_progress).await;
    if result.is_err() {
        let _ = remove_if_exists(&paths.archive).await;
        let _ = remove_if_exists(&paths.executable_staging).await;
        let _ = remove_if_exists(&paths.executable).await;
        let _ = remove_if_exists(&paths.ready_marker).await;
    }
    result
}

pub(super) fn runtime_complete(root: &Path, asset: RuntimeAsset) -> bool {
    let paths = RuntimePaths::new(root, asset);
    paths.executable.is_file() && paths.ready_marker.is_file()
}

pub(super) fn runtime_executable(root: &Path, asset: RuntimeAsset) -> PathBuf {
    RuntimePaths::new(root, asset).executable
}

async fn download_and_install(
    store: &Store,
    asset: RuntimeAsset,
    paths: &RuntimePaths,
    cancellation: &CancellationToken,
    on_progress: &impl Fn(PluginRuntimePhase, u64, Option<u64>),
) -> Result<()> {
    ensure_not_cancelled(cancellation)?;
    let client = network::client(store).await?;
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Err(Error::Cancelled),
        response = client
            .get(asset.download_url())
            .timeout(DOWNLOAD_TIMEOUT)
            .send() => response?,
    }
    .error_for_status()?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MAX_ARCHIVE_BYTES) {
        return Err(Error::Config(
            "Deno runtime archive is larger than allowed".into(),
        ));
    }

    on_progress(PluginRuntimePhase::Downloading, 0, total_bytes);
    let mut archive = tokio::fs::File::create(&paths.archive).await?;
    let mut hasher = Sha256::new();
    let mut downloaded_bytes = 0_u64;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        if downloaded_bytes > MAX_ARCHIVE_BYTES {
            return Err(Error::Config(
                "Deno runtime archive is larger than allowed".into(),
            ));
        }
        archive.write_all(&chunk).await?;
        hasher.update(&chunk);
        on_progress(
            PluginRuntimePhase::Downloading,
            downloaded_bytes,
            total_bytes,
        );
    }
    archive.flush().await?;
    archive.sync_all().await?;
    drop(archive);
    ensure_not_cancelled(cancellation)?;

    on_progress(PluginRuntimePhase::Verifying, downloaded_bytes, total_bytes);
    let actual_hash = hex::encode(hasher.finalize());
    if actual_hash != asset.sha256 {
        return Err(Error::Config(format!(
            "Deno runtime checksum mismatch: expected {}, received {actual_hash}",
            asset.sha256
        )));
    }

    on_progress(
        PluginRuntimePhase::Installing,
        downloaded_bytes,
        total_bytes,
    );
    let archive_path = paths.archive.clone();
    let staging_path = paths.executable_staging.clone();
    let executable_name = asset.executable_name();
    tokio::task::spawn_blocking(move || {
        extract_runtime_archive(&archive_path, &staging_path, executable_name)
    })
    .await
    .map_err(|error| Error::Config(format!("Deno extraction task failed: {error}")))??;
    ensure_not_cancelled(cancellation)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(
            &paths.executable_staging,
            std::fs::Permissions::from_mode(0o700),
        )
        .await?;
    }
    remove_if_exists(&paths.executable).await?;
    tokio::fs::rename(&paths.executable_staging, &paths.executable).await?;
    ensure_not_cancelled(cancellation)?;

    on_progress(
        PluginRuntimePhase::Validating,
        downloaded_bytes,
        total_bytes,
    );
    validate_runtime(&paths.executable, cancellation).await?;
    ensure_not_cancelled(cancellation)?;
    tokio::fs::write(&paths.ready_marker, format!("deno {DENO_VERSION}\n")).await?;
    remove_if_exists(&paths.archive).await?;
    tracing::info!(
        version = DENO_VERSION,
        target = asset.target,
        path = %paths.executable.display(),
        "plugin runtime initialized"
    );
    Ok(())
}

struct RuntimePaths {
    download_dir: PathBuf,
    install_dir: PathBuf,
    archive: PathBuf,
    executable: PathBuf,
    executable_staging: PathBuf,
    ready_marker: PathBuf,
}

impl RuntimePaths {
    fn new(root: &Path, asset: RuntimeAsset) -> Self {
        let download_dir = root.join(".downloads");
        let install_dir = root
            .join("deno")
            .join(format!("v{DENO_VERSION}"))
            .join(asset.target);
        let executable = install_dir.join(asset.executable_name());
        Self {
            archive: download_dir.join(format!("{}.part", asset.archive_name())),
            executable_staging: install_dir.join(format!("{}.part", asset.executable_name())),
            ready_marker: install_dir.join(".ready"),
            download_dir,
            install_dir,
            executable,
        }
    }
}

fn extract_runtime_archive(archive: &Path, output: &Path, executable_name: &str) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| Error::Config(format!("invalid Deno runtime archive: {error}")))?;
    let mut executable = archive
        .by_name(executable_name)
        .map_err(|error| Error::Config(format!("Deno executable missing from archive: {error}")))?;
    let mut destination = std::fs::File::create(output)?;
    io::copy(&mut executable, &mut destination)?;
    destination.sync_all()?;
    Ok(())
}

async fn validate_runtime(executable: &Path, cancellation: &CancellationToken) -> Result<()> {
    let mut command = tokio::process::Command::new(executable);
    super::detach_console(&mut command);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::select! {
        _ = cancellation.cancelled() => return Err(Error::Cancelled),
        result = tokio::time::timeout(VALIDATION_TIMEOUT, command.output()) => {
            result.map_err(|_| Error::Config("Deno runtime validation timed out".into()))??
        }
    };
    if !output.status.success() {
        return Err(Error::Config(format!(
            "Deno runtime validation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let expected = format!("deno {DENO_VERSION}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version_line = stdout.lines().next().unwrap_or_default().trim();
    if version_line != expected && !version_line.starts_with(&format!("{expected} ")) {
        return Err(Error::Config(format!(
            "unexpected Deno runtime version: {version_line}"
        )));
    }
    Ok(())
}

fn ensure_not_cancelled(cancellation: &CancellationToken) -> Result<()> {
    if cancellation.is_cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

async fn remove_if_exists(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_versioned_runtime_directory() {
        let root = PathBuf::from("/tmp/plugin-runtime");
        let asset = super::super::asset::RuntimeAsset::for_platform("macos", "aarch64").unwrap();
        let paths = RuntimePaths::new(&root, asset);
        assert_eq!(
            paths.executable,
            root.join("deno")
                .join(format!("v{DENO_VERSION}"))
                .join(asset.target)
                .join("deno")
        );
    }
}
