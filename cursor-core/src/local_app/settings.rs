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
/// `proxySupport` 必须用 `override`：`on` 的语义是"使用代理设置"，
/// 在系统代理（Clash 等）存在时 Cursor 可能优先走系统代理而不是我们的
/// `http.proxy`，流量绕开 MITM 且无任何日志（2026-10-30 实测 7897 死端口事故）。
/// `override` 强制 `http.proxy` 覆盖系统代理，请求必定进 MITM。
const MANAGED_PROXY_SUPPORT: &str = "override";

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

/// 指向本机回环的代理地址只可能来自上一次接管的残留
/// （每次接管都会随机挑一个本地端口），不能当成用户原值。
fn is_loopback_proxy(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<reqwest::Url>().ok())
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"))
}

fn save_backup(settings: &BTreeMap<String, Value>) -> Result<()> {
    let path = backup_path()?;
    if path.exists() {
        return Ok(());
    }
    let mut values = BTreeMap::new();
    for key in KEYS.into_iter().chain(std::iter::once(NO_PROXY_KEY)) {
        let mut value = settings.get(key).cloned();
        // 上次接管若没清理干净（进程被杀、崩溃），settings 里会留着指向已死端口
        // 的 http.proxy。把它当用户原值备份下去，还原时就会把死端口写回去，
        // Cursor 随后所有请求都打到那个端口（2026-11-01 实测：还原后网络全挂）。
        if matches!(key, "http.proxy" | "http.proxyKerberosServicePrincipal")
            && is_loopback_proxy(value.as_ref())
        {
            value = None;
        }
        values.insert(key.to_string(), value);
    }
    let data = serde_json::to_vec_pretty(&SettingsBackup { version: 1, values })?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data)?;
    Ok(())
}

fn write_proxy_settings_body(proxy_url: &str, settings: &mut BTreeMap<String, Value>) {
    settings.remove(NO_PROXY_KEY);
    settings.insert(KEYS[0].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[1].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[2].into(), Value::String(MANAGED_PROXY_SUPPORT.into()));
    settings.insert(KEYS[3].into(), Value::Bool(true));
    settings.insert(KEYS[4].into(), Value::Bool(true));
}

pub fn write_proxy_settings(proxy_url: &str) -> Result<()> {
    let mut settings = read()?;
    save_backup(&settings)?;
    write_proxy_settings_body(proxy_url, &mut settings);
    write(&settings)
}

pub fn clear_proxy_settings() -> Result<()> {
    let backup = backup_path()?;
    let mut settings = read()?;
    if backup.exists() {
        let saved: SettingsBackup = serde_json::from_slice(&fs::read(&backup)?)?;
        for (key, value) in saved.values {
            // 老账本可能把上一次接管的回环端口记成了用户原值，还原时不能写回去
            let value = match value {
                Some(value)
                    if matches!(key.as_str(), "http.proxy" | "http.proxyKerberosServicePrincipal")
                        && is_loopback_proxy(Some(&value)) =>
                {
                    None
                }
                other => other,
            };
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
        && settings.get(KEYS[2]) == Some(&Value::String(MANAGED_PROXY_SUPPORT.into()))
        && settings.get(KEYS[3]) == Some(&Value::Bool(true))
        && settings.get(KEYS[4]) == Some(&Value::Bool(true)))
}

/// 启动时清理上一次接管残留的代理设置。
///
/// 判据不能只看 `proxySupport == override`：接管被强杀、或者上一次还原走了
/// 老逻辑时，settings 里会留下 `http.proxy` 指向一个已经死掉的随机端口，
/// 而 `proxySupport` 可能已经被还原成用户原值（`on`/`off`）。只要满足
/// 「proxy 指向本机回环」且「带我们的任何特征（override 或 systemCertificatesV2）」，
/// 就视为残留并清理，否则 Cursor 会一直把请求打到死端口。
pub fn clear_stale_managed_settings() -> Result<()> {
    let settings = read()?;
    let loopback = is_loopback_proxy(settings.get(KEYS[0]))
        || is_loopback_proxy(settings.get(KEYS[1]));
    let carries_our_mark = settings.get(KEYS[2]) == Some(&Value::String(MANAGED_PROXY_SUPPORT.into()))
        || settings.get(KEYS[3]) == Some(&Value::Bool(true))
        || settings.get(KEYS[4]) == Some(&Value::Bool(true));
    if loopback && carries_our_mark {
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

    /// 上一次接管被强杀时会留下指向死端口的 http.proxy；它不能进备份，
    /// 否则还原后 Cursor 会把所有请求打到那个端口（2026-11-01 实测网络全挂）。
    #[test]
    fn backup_skips_loopback_proxy_left_over_from_a_previous_takeover() {
        let leftover = Value::String("http://127.0.0.1:34613".into());
        // 回环端口被识别为残留，还原时按「无此键」删除，而不是写回死端口
        assert!(is_loopback_proxy(Some(&leftover)));
        assert!(!is_loopback_proxy(None));
    }

    /// 用户自己配的代理必须原样保留，不能被当成残留。
    #[test]
    fn user_configured_proxy_is_not_treated_as_leftover() {
        assert!(!is_loopback_proxy(Some(&Value::String(
            "http://user-proxy:8080".into()
        ))));
    }
}
