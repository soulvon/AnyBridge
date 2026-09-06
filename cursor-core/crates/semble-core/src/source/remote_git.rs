//! Restricted HTTPS Git acquisition for explicitly requested remote repositories.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use sha2::{Digest, Sha256};
use url::Url;

use crate::{Error, Result};

pub struct RemoteRepository {
    pub path: PathBuf,
    pub identity: String,
}

impl RemoteRepository {
    pub fn acquire(url: &str, cache_root: &Path) -> Result<Self> {
        let parsed = Url::parse(url).map_err(|_| Error::UnsupportedUrl(url.to_owned()))?;
        if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
            return Err(Error::UnsupportedUrl(url.to_owned()));
        }
        let key = hex::encode(Sha256::digest(url.as_bytes()));
        let repos = cache_root.join("repos");
        std::fs::create_dir_all(&repos).map_err(|error| Error::io(&repos, error))?;
        let path = repos.join(key);
        if !path.join(".git").is_dir() {
            let temporary =
                repos.join(format!(".clone-{}-{}", std::process::id(), random_suffix()));
            let result = Command::new("git")
                .args(["clone", "--depth", "1", "--", url])
                .arg(&temporary)
                .stdin(Stdio::null())
                .output()
                .map_err(|error| Error::Git(error.to_string()))?;
            if !result.status.success() {
                let _ = std::fs::remove_dir_all(&temporary);
                return Err(Error::Git(
                    String::from_utf8_lossy(&result.stderr).trim().to_owned(),
                ));
            }
            std::fs::rename(&temporary, &path).map_err(|error| Error::io(&path, error))?;
        }
        let output = Command::new("git")
            .args(["-C"])
            .arg(&path)
            .args(["rev-parse", "HEAD"])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| Error::Git(error.to_string()))?;
        if !output.status.success() {
            return Err(Error::Git(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        let revision = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        Ok(Self {
            path,
            identity: format!("{url}@{revision}"),
        })
    }
}

fn random_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_sources_reject_non_http_urls_before_git_runs() {
        let directory = tempfile::tempdir().unwrap();
        assert!(matches!(
            RemoteRepository::acquire("file:///tmp/repository", directory.path()),
            Err(Error::UnsupportedUrl(_))
        ));
        assert!(matches!(
            RemoteRepository::acquire("git@github.com:owner/repo.git", directory.path()),
            Err(Error::UnsupportedUrl(_))
        ));
    }
}
