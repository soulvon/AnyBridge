use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{config::managed_data_dir, Error, Result};

const NO_PROXY_KEY: &str = "http.noProxy";
const KEYS: [&str; 5] = [
    "http.proxy",
    "http.proxyKerberosServicePrincipal",
    "http.proxySupport",
    "cursor.general.disableHttp2",
    "http.experimental.systemCertificatesV2",
];

#[derive(Debug, Serialize, Deserialize)]
struct SettingsBackup {
    version: u32,
    values: BTreeMap<String, Option<Value>>,
}

fn path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    match std::env::consts::OS {
        "macos" => Ok(home.join("Library/Application Support/Cursor/User/settings.json")),
        "windows" => Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Cursor/User/settings.json")),
        "linux" => Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("Cursor/User/settings.json")),
        platform => Err(Error::Config(format!(
            "Cursor settings are unsupported on {platform}"
        ))),
    }
}

fn backup_path() -> Result<PathBuf> {
    Ok(managed_data_dir()?.join("cursor-settings-backup.json"))
}

fn read_from(path: &Path) -> Result<BTreeMap<String, Value>> {
    let data = match fs::read_to_string(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    if data.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    json5::from_str(&data)
        .map_err(|error| Error::Config(format!("parse Cursor settings JSONC: {error}")))
}

fn read() -> Result<BTreeMap<String, Value>> {
    read_from(&path()?)
}

fn write_to(path: &Path, settings: &BTreeMap<String, Value>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(settings)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, [data.as_slice(), b"\n"].concat())?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp, path)?;
    Ok(())
}

fn write(settings: &BTreeMap<String, Value>) -> Result<()> {
    write_to(&path()?, settings)
}

fn save_backup(settings: &BTreeMap<String, Value>) -> Result<()> {
    let path = backup_path()?;
    if path.exists() {
        return Ok(());
    }
    let mut values = BTreeMap::new();
    for key in KEYS.into_iter().chain(std::iter::once(NO_PROXY_KEY)) {
        values.insert(key.to_string(), settings.get(key).cloned());
    }
    let data = serde_json::to_vec_pretty(&SettingsBackup { version: 1, values })?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data)?;
    Ok(())
}

pub fn write_proxy_settings(proxy_url: &str) -> Result<()> {
    let mut settings = read()?;
    save_backup(&settings)?;
    settings.remove(NO_PROXY_KEY);
    settings.insert(KEYS[0].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[1].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[2].into(), Value::String("on".into()));
    settings.insert(KEYS[3].into(), Value::Bool(true));
    settings.insert(KEYS[4].into(), Value::Bool(true));
    write(&settings)
}

pub fn clear_proxy_settings() -> Result<()> {
    let backup = backup_path()?;
    let mut settings = read()?;
    if backup.exists() {
        let saved: SettingsBackup = serde_json::from_slice(&fs::read(&backup)?)?;
        for (key, value) in saved.values {
            match value {
                Some(value) => { settings.insert(key, value); }
                None => { settings.remove(&key); }
            }
        }
        write(&settings)?;
        fs::remove_file(backup)?;
        return Ok(());
    }
    for key in KEYS {
        settings.remove(key);
    }
    write(&settings)
}

pub fn settings_match(proxy_url: &str) -> Result<bool> {
    let settings = read()?;
    Ok(settings.get(KEYS[0]) == Some(&Value::String(proxy_url.into()))
        && settings.get(KEYS[1]) == Some(&Value::String(proxy_url.into()))
        && settings.get(KEYS[2]) == Some(&Value::String("on".into()))
        && settings.get(KEYS[3]) == Some(&Value::Bool(true))
        && settings.get(KEYS[4]) == Some(&Value::Bool(true)))
}

pub fn clear_stale_managed_settings() -> Result<()> {
    let settings = read()?;
    let managed_signature = settings.get(KEYS[2]) == Some(&Value::String("on".into()))
        && settings.get(KEYS[3]) == Some(&Value::Bool(true))
        && settings.get(KEYS[4]) == Some(&Value::Bool(true));
    let loopback = settings
        .get(KEYS[0])
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<reqwest::Url>().ok())
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"));
    if managed_signature && loopback {
        clear_proxy_settings()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_round_trip_preserves_unrelated_and_managed_user_settings() {
        let directory = tempfile::tempdir().unwrap();
        let settings_path = directory.path().join("settings.json");
        let backup_path = directory.path().join("backup.json");
        let mut original = BTreeMap::new();
        original.insert("editor.fontSize".into(), Value::from(15));
        original.insert("http.proxy".into(), Value::String("http://user-proxy:8080".into()));
        original.insert(NO_PROXY_KEY.into(), Value::String("localhost".into()));
        write_to(&settings_path, &original).unwrap();

        let mut current = read_from(&settings_path).unwrap();
        let mut values = BTreeMap::new();
        for key in KEYS.into_iter().chain(std::iter::once(NO_PROXY_KEY)) {
            values.insert(key.to_string(), current.get(key).cloned());
        }
        fs::write(&backup_path, serde_json::to_vec(&SettingsBackup { version: 1, values }).unwrap()).unwrap();
        current.remove(NO_PROXY_KEY);
        current.insert("http.proxy".into(), Value::String("http://127.0.0.1:1234".into()));
        write_to(&settings_path, &current).unwrap();

        let saved: SettingsBackup = serde_json::from_slice(&fs::read(&backup_path).unwrap()).unwrap();
        let mut restored = read_from(&settings_path).unwrap();
        for (key, value) in saved.values {
            match value {
                Some(value) => { restored.insert(key, value); }
                None => { restored.remove(&key); }
            }
        }
        write_to(&settings_path, &restored).unwrap();

        assert_eq!(read_from(&settings_path).unwrap(), original);
    }
}
