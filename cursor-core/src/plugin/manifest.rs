//! Defines and validates the static filesystem plugin manifest.
use std::{collections::HashSet, path::Path};

use regex::Regex;
use serde::Deserialize;

use crate::{Error, Result};

pub const PLUGIN_API_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub api_version: u32,
    pub id: String,
    pub name: String,
    /// 插件自身版本;内置插件预装时以它为缓存键决定是否重新落盘。
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    /// 插件要求的最低应用版本;应用过旧时插件被忽略。
    #[serde(default)]
    pub min_app_version: Option<String>,
    pub icon: String,
    pub entry: String,
    #[serde(default)]
    pub permissions: PluginPermissions,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPermissions {
    #[serde(default)]
    pub network: Vec<String>,
}

impl PluginManifest {
    pub fn validate(&self, directory: &Path) -> Result<()> {
        if self.api_version != PLUGIN_API_VERSION {
            return Err(Error::Config(format!(
                "plugin '{}' uses unsupported API version {}",
                self.id, self.api_version
            )));
        }
        validate_id(&self.id, "plugin id")?;
        required(&self.name, "plugin name")?;
        parse_version(&self.version)
            .ok_or_else(|| Error::Config(format!("invalid plugin version: {}", self.version)))?;
        if let Some(minimum) = &self.min_app_version {
            parse_version(minimum)
                .ok_or_else(|| Error::Config(format!("invalid plugin minAppVersion: {minimum}")))?;
        }
        validate_entry_path(directory, &self.entry)?;
        validate_asset_path(directory, &self.icon)?;
        let mut hosts = HashSet::new();
        for host in &self.permissions.network {
            validate_network_host(host)?;
            if !hosts.insert(host.to_ascii_lowercase()) {
                return Err(Error::Config(format!(
                    "plugin '{}' contains duplicate network host '{host}'",
                    self.id
                )));
            }
        }
        Ok(())
    }
}

/// 解析 semver 的核心三段(忽略预发布/构建后缀),格式非法返回 None。
pub(super) fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let core = value.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

pub(super) fn version_at_least(actual: &str, minimum: &str) -> bool {
    match (parse_version(actual), parse_version(minimum)) {
        (Some(actual), Some(minimum)) => actual >= minimum,
        _ => false,
    }
}

pub(super) fn validate_id(value: &str, label: &str) -> Result<()> {
    static ID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let expression = ID.get_or_init(|| Regex::new(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$").unwrap());
    if expression.is_match(value) {
        Ok(())
    } else {
        Err(Error::Config(format!("invalid {label}: {value}")))
    }
}

fn validate_network_host(value: &str) -> Result<()> {
    if value.is_empty()
        || value.contains('/')
        || value.contains(':')
        || value.starts_with('.')
        || value.ends_with('.')
    {
        return Err(Error::Config(format!(
            "invalid plugin network host: {value}"
        )));
    }
    let parsed = url::Url::parse(&format!("https://{value}")).map_err(|error| {
        Error::Config(format!("invalid plugin network host '{value}': {error}"))
    })?;
    if parsed.host_str() != Some(value) {
        return Err(Error::Config(format!(
            "invalid plugin network host: {value}"
        )));
    }
    Ok(())
}

fn required<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        Err(Error::Config(format!("{label} is required")))
    } else {
        Ok(value)
    }
}

fn validate_entry_path(directory: &Path, value: &str) -> Result<()> {
    let path = Path::new(value);
    if !is_safe_relative_path(path) {
        return Err(Error::Config(format!("invalid plugin entry path: {value}")));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "js" | "mjs" | "ts" | "mts") {
        return Err(Error::Config(format!(
            "unsupported plugin entry format: {value}"
        )));
    }
    let entry = directory.join(path);
    if !entry.is_file() {
        return Err(Error::Config(format!(
            "plugin entry does not exist: {value}"
        )));
    }
    let root = directory.canonicalize()?;
    let entry = entry.canonicalize()?;
    if !entry.starts_with(root) {
        return Err(Error::Config(format!(
            "plugin entry escapes its directory: {value}"
        )));
    }
    Ok(())
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && !path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
}

fn validate_asset_path(directory: &Path, value: &str) -> Result<()> {
    let path = Path::new(value);
    if !is_safe_relative_path(path) {
        return Err(Error::Config(format!("invalid plugin asset path: {value}")));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "svg" | "png" | "webp") {
        return Err(Error::Config(format!(
            "unsupported plugin icon format: {value}"
        )));
    }
    if !directory.join(path).is_file() {
        return Err(Error::Config(format!(
            "plugin icon does not exist: {value}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_urls_in_network_host_allowlist() {
        assert!(validate_network_host("https://example.com").is_err());
        assert!(validate_network_host("example.com:443").is_err());
        assert!(validate_network_host("example.com").is_ok());
    }

    #[test]
    fn compares_semver_cores_and_ignores_prerelease_suffixes() {
        assert_eq!(parse_version("0.1.5-beta.1"), Some((0, 1, 5)));
        assert_eq!(parse_version("1.2"), None);
        assert!(version_at_least("0.1.5-beta.1", "0.1.5"));
        assert!(version_at_least("0.2.0", "0.1.9"));
        assert!(!version_at_least("0.1.4", "0.1.5"));
        assert!(!version_at_least("bogus", "0.1.0"));
    }
}
