//! Loads and validates process-level server configuration.
use std::{env, fs, net::SocketAddr, path::PathBuf, time::Duration};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::{Error, Result};

const DATA_DIR_NAME: &str = "cursor-core";
const DATABASE_FILE_NAME: &str = "cursor-core.db";
const V0049_DATA_DIR_NAME: &str = ".cursor-local-assistant-v2";
const V0049_CONFIG_FILE_NAME: &str = "config.yaml";
const DEFAULT_PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub fn managed_data_dir() -> Result<PathBuf> {
    let data_dir = if let Some(root) = env::var_os("ANYBRIDGE_CONFIG_DIR") {
        PathBuf::from(root).join(DATA_DIR_NAME)
    } else {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| Error::Config("cannot resolve user config directory".into()))?;
        config_dir.join("anybridge").join(DATA_DIR_NAME)
    };
    fs::create_dir_all(&data_dir)?;
    #[cfg(unix)]
    fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700))?;
    Ok(data_dir)
}

pub fn v0049_config_path() -> Result<PathBuf> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    Ok(home_dir
        .join(V0049_DATA_DIR_NAME)
        .join(V0049_CONFIG_FILE_NAME))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
}

#[derive(Clone)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub request_url: String,
    pub api_key: String,
    pub custom_headers: reqwest::header::HeaderMap,
    pub max_output_tokens: Option<u64>,
    pub request_timeout: Duration,
    pub allowed_body_fields: Option<std::collections::HashSet<String>>,
}

#[derive(Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub database_url: String,
    pub provider_request_timeout: Duration,
    pub provider_stream_idle_timeout: Duration,
    pub console: Option<ConsoleSource>,
    pub use_persisted_ports: bool,
    pub anybridge_routes_path: Option<PathBuf>,
    pub anybridge_cursor_models_path: Option<PathBuf>,
    pub anybridge_gateway_url: Option<String>,
    pub anybridge_gateway_key: Option<String>,
    /// 面向用户的应用版本;桌面壳会覆盖为自身版本,用于插件 minAppVersion 门控。
    pub app_version: String,
}

#[derive(Clone)]
pub enum ConsoleSource {
    Directory(PathBuf),
    Proxy(url::Url),
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let listen_addr = env::var("ANYBRIDGE_CURSOR_LISTEN_ADDR")
            .or_else(|_| env::var("CURSOR_LISTEN_ADDR"))
            .unwrap_or_else(|_| "127.0.0.1:17650".into())
            .parse()
            .map_err(|error| Error::Config(format!("invalid CURSOR_LISTEN_ADDR: {error}")))?;
        let request_timeout = match env::var("CURSOR_PROVIDER_TIMEOUT_SECONDS") {
            Ok(value) => Duration::from_secs(value.parse().map_err(|error| {
                Error::Config(format!("invalid CURSOR_PROVIDER_TIMEOUT_SECONDS: {error}"))
            })?),
            Err(env::VarError::NotPresent) => DEFAULT_PROVIDER_REQUEST_TIMEOUT,
            Err(error) => {
                return Err(Error::Config(format!(
                    "invalid CURSOR_PROVIDER_TIMEOUT_SECONDS: {error}"
                )))
            }
        };
        let console_dir = env::var_os("CURSOR_CONSOLE_DIR").map(PathBuf::from);
        let console_proxy = env::var("CURSOR_CONSOLE_PROXY")
            .ok()
            .map(|value| {
                value.parse().map_err(|error| {
                    Error::Config(format!("invalid CURSOR_CONSOLE_PROXY: {error}"))
                })
            })
            .transpose()?;
        let console = match (console_dir, console_proxy) {
            (Some(_), Some(_)) => {
                return Err(Error::Config(
                    "CURSOR_CONSOLE_DIR and CURSOR_CONSOLE_PROXY cannot both be set".into(),
                ))
            }
            (Some(directory), None) => Some(ConsoleSource::Directory(directory)),
            (None, Some(proxy)) => Some(ConsoleSource::Proxy(proxy)),
            (None, None) => None,
        };
        let anybridge_routes_path = env::var_os("ANYBRIDGE_ROUTES_PATH").map(PathBuf::from);
        let anybridge_cursor_models_path = env::var_os("ANYBRIDGE_CURSOR_MODELS_PATH").map(PathBuf::from);
        let anybridge_gateway_url = env::var("ANYBRIDGE_GATEWAY_URL").ok();
        let anybridge_gateway_key = env::var("ANYBRIDGE_LOCAL_PROXY_KEY").ok();
        if anybridge_routes_path.is_some()
            && (anybridge_gateway_url.is_none() || anybridge_gateway_key.is_none())
        {
            return Err(Error::Config(
                "ANYBRIDGE_GATEWAY_URL and ANYBRIDGE_LOCAL_PROXY_KEY are required with ANYBRIDGE_ROUTES_PATH".into(),
            ));
        }
        Ok(Self {
            listen_addr,
            database_url: database_url_from_env()?,
            provider_request_timeout: request_timeout,
            provider_stream_idle_timeout: DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT,
            console,
            use_persisted_ports: false,
            anybridge_routes_path,
            anybridge_cursor_models_path,
            anybridge_gateway_url,
            anybridge_gateway_key,
            app_version: env!("CARGO_PKG_VERSION").into(),
        })
    }

    pub fn desktop() -> Result<Self> {
        Ok(Self {
            listen_addr: "127.0.0.1:0"
                .parse()
                .expect("desktop listen address is static"),
            database_url: default_database_url()?,
            provider_request_timeout: DEFAULT_PROVIDER_REQUEST_TIMEOUT,
            provider_stream_idle_timeout: DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT,
            console: None,
            use_persisted_ports: true,
            anybridge_routes_path: None,
            anybridge_cursor_models_path: None,
            anybridge_gateway_url: None,
            anybridge_gateway_key: None,
            app_version: env!("CARGO_PKG_VERSION").into(),
        })
    }
}

fn database_url_from_env() -> Result<String> {
    match env::var("CURSOR_DATABASE_URL") {
        Ok(database_url) => Ok(database_url),
        Err(env::VarError::NotPresent) => default_database_url(),
        Err(error) => Err(Error::Config(format!(
            "invalid CURSOR_DATABASE_URL: {error}"
        ))),
    }
}

fn default_database_url() -> Result<String> {
    let data_dir = managed_data_dir()?;
    database_url_for_dir(&data_dir)
}

fn database_url_for_dir(data_dir: &std::path::Path) -> Result<String> {
    let database_path = data_dir.join(DATABASE_FILE_NAME);
    let database_path = database_path
        .to_str()
        .ok_or_else(|| Error::Config("database path is not valid UTF-8".into()))?;
    Ok(format!("sqlite://{database_path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_timeout_defaults_match_runtime_boundaries() {
        assert_eq!(
            DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT,
            Duration::from_secs(30 * 60)
        );
        assert_eq!(
            DEFAULT_PROVIDER_REQUEST_TIMEOUT,
            Duration::from_secs(60 * 60)
        );
    }
}
