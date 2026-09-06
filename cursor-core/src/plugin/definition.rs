//! Evaluates TypeScript plugin definitions through the host-owned virtual module.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::io::AsyncReadExt;

use super::descriptor::PluginModuleDefinition;
use crate::{config, Error, Result};

const DEFINITION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;
const OUTPUT_PREFIX: &str = "CURSOR_BYOK_PLUGIN_DEFINITION:";

#[derive(Clone)]
pub struct PluginDefinitionLoader {
    sdk_dir: PathBuf,
    import_map: PathBuf,
    collector: PathBuf,
    worker: PathBuf,
    deno_dir: PathBuf,
}

impl PluginDefinitionLoader {
    pub fn managed() -> Result<Self> {
        Self::in_directory(config::managed_data_dir()?.join("plugins/runtime/sdk/v1"))
    }

    #[cfg(test)]
    pub(super) fn for_test(root: &Path) -> Result<Self> {
        Self::in_directory(root.join(".plugin-sdk"))
    }

    fn in_directory(sdk_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&sdk_dir)?;
        std::fs::create_dir_all(sdk_dir.join("protocol"))?;
        let import_map = sdk_dir.join("import-map.json");
        let collector = sdk_dir.join("collect.ts");
        let worker = sdk_dir.join("worker.ts");
        let deno_dir = sdk_dir.join("cache");
        std::fs::create_dir_all(&deno_dir)?;
        let modules = [
            (&import_map, include_str!("sdk/import-map.json")),
            (&collector, include_str!("sdk/collect.ts")),
            (&worker, include_str!("sdk/worker.ts")),
            (&sdk_dir.join("plugin.ts"), include_str!("sdk/plugin.ts")),
            (
                &sdk_dir.join("provider.ts"),
                include_str!("sdk/provider.ts"),
            ),
            (&sdk_dir.join("model.ts"), include_str!("sdk/model.ts")),
            (
                &sdk_dir.join("resource.ts"),
                include_str!("sdk/resource.ts"),
            ),
            (
                &sdk_dir.join("protocol/openai_responses.ts"),
                include_str!("sdk/protocol/openai_responses.ts"),
            ),
            (
                &sdk_dir.join("protocol/openai_chat.ts"),
                include_str!("sdk/protocol/openai_chat.ts"),
            ),
        ];
        for (path, content) in &modules {
            write_if_changed(path, content)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&sdk_dir, std::fs::Permissions::from_mode(0o700))?;
            std::fs::set_permissions(
                sdk_dir.join("protocol"),
                std::fs::Permissions::from_mode(0o700),
            )?;
            std::fs::set_permissions(&deno_dir, std::fs::Permissions::from_mode(0o700))?;
            for (path, _) in &modules {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
        }
        Ok(Self {
            sdk_dir,
            import_map,
            collector,
            worker,
            deno_dir,
        })
    }

    pub fn worker_path(&self) -> &Path {
        &self.worker
    }
    pub fn import_map(&self) -> &Path {
        &self.import_map
    }
    pub fn sdk_dir(&self) -> &Path {
        &self.sdk_dir
    }
    pub fn deno_dir(&self) -> &Path {
        &self.deno_dir
    }

    pub async fn load(
        &self,
        executable: &Path,
        plugin_directory: &Path,
        entry: &Path,
    ) -> Result<PluginModuleDefinition> {
        let entry_url = file_url(entry)?;
        let mut command = tokio::process::Command::new(executable);
        super::detach_console(&mut command);
        command
            .arg("run")
            .arg("--quiet")
            .arg("--no-config")
            .arg("--no-lock")
            .arg("--no-npm")
            .arg("--no-remote")
            .arg("--no-prompt")
            .arg(format!("--allow-read={}", plugin_directory.display()))
            .arg(format!("--allow-read={}", self.sdk_dir.display()))
            .arg(format!("--import-map={}", self.import_map.display()))
            .arg(&self.collector)
            .arg(entry_url.as_str())
            .env("DENO_DIR", &self.deno_dir)
            .env("DENO_NO_UPDATE_CHECK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Config("cannot capture plugin definition output".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Config("cannot capture plugin definition error output".into()))?;
        let (stdout, stderr, status) = tokio::time::timeout(DEFINITION_TIMEOUT, async move {
            let (stdout, stderr, status) =
                tokio::join!(read_limited(stdout), read_limited(stderr), child.wait());
            Ok::<_, Error>((stdout?, stderr?, status?))
        })
        .await
        .map_err(|_| Error::Config("plugin definition evaluation timed out".into()))??;
        if !status.success() {
            return Err(Error::Config(format!(
                "plugin definition evaluation failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            )));
        }
        parse_definition_output(&stdout)
    }
}

pub(super) fn file_url(path: &Path) -> Result<url::Url> {
    url::Url::from_file_path(path).map_err(|_| {
        Error::Config(format!(
            "plugin entry path is not a valid file URL: {}",
            path.display()
        ))
    })
}

async fn read_limited(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(Error::Config(
            "plugin definition output is larger than allowed".into(),
        ));
    }
    Ok(bytes)
}

fn parse_definition_output(output: &[u8]) -> Result<PluginModuleDefinition> {
    let output = String::from_utf8(output.to_vec()).map_err(|error| {
        Error::Config(format!("plugin definition output is not UTF-8: {error}"))
    })?;
    let json = output
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(OUTPUT_PREFIX))
        .ok_or_else(|| Error::Config("plugin definition did not produce a descriptor".into()))?;
    Ok(serde_json::from_str(json)?)
}

pub(super) fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    if std::fs::read(path).is_ok_and(|current| current == content.as_bytes()) {
        return Ok(());
    }
    std::fs::write(path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_descriptor_marker() {
        let output = br#"CURSOR_BYOK_PLUGIN_DEFINITION:{"providers":[{"id":"codex","displayName":"OpenAI Codex","description":null,"providerType":"openai","resourceType":"chatgpt-account","hasModels":true}],"resources":[{"type":"chatgpt-account","displayName":"ChatGPT accounts","add":[{"type":"oauth2.0","id":"chatgpt-device","displayName":"Sign in","description":null}],"import":{"displayName":"Import","description":null,"accept":[".json"],"multiple":true},"canRefresh":true,"canRemove":false}]}"#;
        let descriptor = parse_definition_output(output).unwrap();
        assert_eq!(descriptor.providers[0].id, "codex");
        assert_eq!(
            descriptor.providers[0].resource_type.as_deref(),
            Some("chatgpt-account")
        );
        assert_eq!(descriptor.resources[0].add[0].method_type, "oauth2.0");
        assert!(descriptor.resources[0].import.is_some());
    }
}
