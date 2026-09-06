use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::Duration};

const REACTIVE_STORAGE_KEY: &str =
    "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCursorStateBackup {
    #[allow(dead_code)]
    version: u32,
    auth: BTreeMap<String, Option<String>>,
    reactive_storage: Option<String>,
}

pub(crate) fn cursor_state_db_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return dirs::config_dir().map(|dir| {
            dir.join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb")
        });
    }
    #[cfg(target_os = "macos")]
    {
        return dirs::data_dir().map(|dir| {
            dir.join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb")
        });
    }
    #[cfg(target_os = "linux")]
    {
        return dirs::config_dir().map(|dir| {
            dir.join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb")
        });
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    None
}

fn backup_path() -> PathBuf {
    crate::commands::config::config_dir_path().join("cursor-state-backup.json")
}

fn open_cursor_db() -> Result<Connection, String> {
    let path = cursor_state_db_path().ok_or_else(|| "无法定位 Cursor state.vscdb 路径".to_string())?;
    if !path.exists() {
        return Err(format!("未找到 Cursor state.vscdb: {}", path.to_string_lossy()));
    }
    let connection = Connection::open(&path)
        .map_err(|error| format_sqlite_error("打开 Cursor state.vscdb 失败", &error))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format_sqlite_error("设置 Cursor SQLite busy_timeout 失败", &error))?;
    Ok(connection)
}

fn format_sqlite_error(context: &str, error: &rusqlite::Error) -> String {
    let text = error.to_string();
    if text.contains("database is locked") || text.contains("database table is locked") {
        format!("{context}: SQLite 正被 Cursor 占用，请关闭 Cursor 后重试 ({text})")
    } else {
        format!("{context}: {text}")
    }
}

fn upsert_item(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO ItemTable(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|error| format_sqlite_error("恢复 Cursor ItemTable 失败", &error))
}

pub(crate) fn restore_cursor_auth() -> Result<bool, String> {
    let path = backup_path();
    if !path.exists() {
        return Ok(false);
    }
    let connection = open_cursor_db()?;
    restore_legacy_backup(&connection, &path)
}

fn restore_legacy_backup(connection: &Connection, path: &Path) -> Result<bool, String> {
    let backup: LegacyCursorStateBackup = serde_json::from_slice(
        &std::fs::read(path).map_err(|error| format!("读取 Cursor 旧版备份失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Cursor 旧版备份失败: {error}"))?;

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format_sqlite_error("开始 Cursor 恢复事务失败", &error))?;
    for (key, value) in backup.auth {
        match value {
            Some(value) => upsert_item(&transaction, &key, &value)?,
            None => {
                transaction
                    .execute("DELETE FROM ItemTable WHERE key = ?1", params![key])
                    .map_err(|error| format_sqlite_error("删除旧版 Cursor auth key 失败", &error))?;
            }
        }
    }
    if let Some(reactive_storage) = backup.reactive_storage {
        let _: Value = serde_json::from_str(&reactive_storage)
            .map_err(|error| format!("旧版 Cursor reactiveStorage 备份无效: {error}"))?;
        upsert_item(&transaction, REACTIVE_STORAGE_KEY, &reactive_storage)?;
    }
    transaction
        .commit()
        .map_err(|error| format_sqlite_error("提交 Cursor 恢复事务失败", &error))?;
    std::fs::remove_file(path).map_err(|error| format!("删除 Cursor 旧版备份失败: {error}"))?;
    Ok(true)
}
