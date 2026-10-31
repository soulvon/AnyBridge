use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 本地接管账号的固定标识（与 cursor-core/src/local_app/account.rs 的
/// `EMAIL` / `SUBJECT` 一致）：用来识别「账本丢了，但账号确实还停在接管态」。
const LOCAL_ACCOUNT_EMAIL: &str = "cursor@ai.com";
const LOCAL_ACCOUNT_SUBJECT: &str = "cursor-local-user";

/// 账本目录与文件名必须与 cursor-core 的 `managed_data_dir()` + `LEDGER_FILE_NAME`
/// 完全一致。两侧读同一份账本，否则还原永远读不到接入方写的原值
/// （2026-11-01 事故：这里读 `cursor-state-backup.json`，而该文件全仓库无人写）。
const LEDGER_DIR_NAME: &str = "cursor-core";
const LEDGER_FILE_NAME: &str = "cursor-auth-backup.json";

#[derive(Debug, Deserialize)]
struct AuthLedger {
    #[allow(dead_code)]
    version: u32,
    /// 接入前用户原值（`null` = 当时没有该键）
    original: BTreeMap<String, Option<String>>,
    /// 我们写进去的值，用于判断当前值是否仍属于接管方
    applied: BTreeMap<String, Option<String>>,
}

/// 还原结果三态。绝不允许把「无账本」一律报成成功——
/// 账号被冲掉时那正是唯一可用的告警窗口。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CursorAuthRestore {
    /// 没有账本，且当前不是接管账号 = 无需还原
    NotNeeded,
    /// 没有账本，但账号仍是接管态 = 原值已被覆盖且唯一还原源丢失
    BackupMissing,
    Restored {
        restored: usize,
        kept_user_changes: usize,
    },
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

fn ledger_path() -> PathBuf {
    crate::commands::config::config_dir_path()
        .join(LEDGER_DIR_NAME)
        .join(LEDGER_FILE_NAME)
}

pub(crate) fn restore_cursor_auth() -> Result<CursorAuthRestore, String> {
    restore_cursor_auth_at(&ledger_path(), cursor_state_db_path())
}

fn restore_cursor_auth_at(
    ledger: &Path,
    db: Option<PathBuf>,
) -> Result<CursorAuthRestore, String> {
    if !ledger.exists() {
        return Ok(match db.filter(|path| path.exists()) {
            Some(path) if is_local_account_state(&path)? => CursorAuthRestore::BackupMissing,
            _ => CursorAuthRestore::NotNeeded,
        });
    }
    let db = db.ok_or_else(|| "无法定位 Cursor state.vscdb 路径".to_string())?;
    let connection = open_cursor_db(&db)?;
    restore_from_ledger(&connection, ledger)
}

fn open_cursor_db(path: &Path) -> Result<Connection, String> {
    if !path.exists() {
        return Err(format!("未找到 Cursor state.vscdb: {}", path.to_string_lossy()));
    }
    let connection = Connection::open(path)
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

fn select_item(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut statement = connection
        .prepare("SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = ?1")
        .map_err(|error| format_sqlite_error("读取 Cursor ItemTable 失败", &error))?;
    let mut rows = statement
        .query(params![key])
        .map_err(|error| format_sqlite_error("读取 Cursor ItemTable 失败", &error))?;
    match rows
        .next()
        .map_err(|error| format_sqlite_error("读取 Cursor ItemTable 失败", &error))?
    {
        Some(row) => Ok(Some(
            row.get::<_, String>(0)
                .map_err(|error| format_sqlite_error("解析 Cursor ItemTable 值失败", &error))?,
        )),
        None => Ok(None),
    }
}

fn upsert_item(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO ItemTable(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|error| format_sqlite_error("写回 Cursor ItemTable 失败", &error))
}

/// 当前 vscdb 是否仍是我们注入的本地账号（无账本时用来判断"备份是否丢失"）。
fn is_local_account_state(path: &Path) -> Result<bool, String> {
    let connection = open_cursor_db(path)?;
    let email = select_item(&connection, "cursorAuth/cachedEmail")?;
    let subject = select_item(&connection, "cursorAuth/stripeMembershipAuthId")?;
    Ok(
        email.as_deref() == Some(LOCAL_ACCOUNT_EMAIL)
            && subject.as_deref() == Some(LOCAL_ACCOUNT_SUBJECT),
    )
}

fn restore_from_ledger(
    connection: &Connection,
    ledger: &Path,
) -> Result<CursorAuthRestore, String> {
    let record: AuthLedger = serde_json::from_slice(
        &std::fs::read(ledger).map_err(|error| format!("读取 Cursor 账号账本失败: {error}"))?,
    )
    .map_err(|error| format!("Cursor 账号账本损坏（{}）: {error}", ledger.display()))?;

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format_sqlite_error("开始 Cursor 账号还原事务失败", &error))?;
    let mut restored = 0usize;
    let mut kept_user_changes = 0usize;
    for (key, original) in &record.original {
        let applied = record.applied.get(key).cloned().flatten();
        let current = select_item(&transaction, key)?;
        // 当前值不再是我们写的那份 = 用户接管期间自己改过（重新登录/换会员），
        // 保留用户改动，绝不拿旧快照覆盖回去。
        if current != applied {
            kept_user_changes += 1;
            continue;
        }
        match original {
            Some(value) => upsert_item(&transaction, key, value)?,
            None => {
                transaction
                    .execute("DELETE FROM ItemTable WHERE key = ?1", params![key])
                    .map_err(|error| format_sqlite_error("删除 Cursor 账号键失败", &error))?;
            }
        }
        restored += 1;
    }
    transaction
        .commit()
        .map_err(|error| format_sqlite_error("提交 Cursor 账号还原事务失败", &error))?;
    std::fs::remove_file(ledger)
        .map_err(|error| format!("删除 Cursor 账号账本失败: {error}"))?;
    Ok(CursorAuthRestore::Restored {
        restored,
        kept_user_changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "anybridge-cursor-auth-{name}-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_db(path: &Path, values: &[(&str, &str)]) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
            )
            .unwrap();
        for (key, value) in values {
            upsert_item(&connection, key, value).unwrap();
        }
    }

    fn write_ledger(
        path: &Path,
        original: &[(&str, &str)],
        applied: &[(&str, &str)],
    ) {
        let to_map = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(key, value)| (key.to_string(), Some(value.to_string())))
                .collect::<BTreeMap<_, _>>()
        };
        let record = serde_json::json!({
            "version": 1,
            "original": to_map(original),
            "applied": to_map(applied),
        });
        std::fs::write(path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    }

    /// 事故复刻：账本里必须有接入前的真 token，还原时逐键写回，
    /// 且接管期间被用户改过的键保留用户值。
    #[test]
    fn restore_writes_back_original_and_keeps_user_changes() {
        let dir = temp_dir("roundtrip");
        let db = dir.join("state.vscdb");
        let ledger = dir.join(LEDGER_FILE_NAME);
        seed_db(
            &db,
            &[
                ("cursorAuth/accessToken", "local-token"),
                ("cursorAuth/cachedEmail", "relogin@example.com"),
                ("cursorAuth/stripeMembershipAuthId", LOCAL_ACCOUNT_SUBJECT),
                ("cursorAuth/stripeMembershipType", "ultra"),
            ],
        );
        write_ledger(
            &ledger,
            &[
                ("cursorAuth/accessToken", "cursor-safe-storage:v1:real-access"),
                ("cursorAuth/cachedEmail", "brother@example.com"),
                ("cursorAuth/stripeMembershipAuthId", "auth0|real-user"),
                ("cursorAuth/stripeMembershipType", "pro_plus"),
            ],
            &[
                ("cursorAuth/accessToken", "local-token"),
                ("cursorAuth/cachedEmail", LOCAL_ACCOUNT_EMAIL),
                ("cursorAuth/stripeMembershipAuthId", LOCAL_ACCOUNT_SUBJECT),
                ("cursorAuth/stripeMembershipType", "ultra"),
            ],
        );

        let outcome = restore_cursor_auth_at(&ledger, Some(db.clone())).unwrap();
        assert_eq!(
            outcome,
            CursorAuthRestore::Restored {
                restored: 3,
                kept_user_changes: 1
            }
        );

        let connection = open_cursor_db(&db).unwrap();
        assert_eq!(
            select_item(&connection, "cursorAuth/accessToken")
                .unwrap()
                .as_deref(),
            Some("cursor-safe-storage:v1:real-access")
        );
        assert_eq!(
            select_item(&connection, "cursorAuth/stripeMembershipAuthId")
                .unwrap()
                .as_deref(),
            Some("auth0|real-user")
        );
        assert_eq!(
            select_item(&connection, "cursorAuth/cachedEmail")
                .unwrap()
                .as_deref(),
            Some("relogin@example.com"),
            "用户接管期间的改动必须保留"
        );
        assert!(!ledger.exists(), "还原成功后账本必须删除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 账本丢失但账号仍是接管态：必须报 BackupMissing，不能报"无需还原"。
    #[test]
    fn missing_ledger_reports_backup_missing_when_account_still_local() {
        let dir = temp_dir("missing-ledger-local");
        let db = dir.join("state.vscdb");
        let ledger = dir.join(LEDGER_FILE_NAME);
        seed_db(
            &db,
            &[
                ("cursorAuth/cachedEmail", LOCAL_ACCOUNT_EMAIL),
                ("cursorAuth/stripeMembershipAuthId", LOCAL_ACCOUNT_SUBJECT),
            ],
        );

        assert_eq!(
            restore_cursor_auth_at(&ledger, Some(db)).unwrap(),
            CursorAuthRestore::BackupMissing
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_ledger_on_real_login_is_not_needed() {
        let dir = temp_dir("missing-ledger-real");
        let db = dir.join("state.vscdb");
        let ledger = dir.join(LEDGER_FILE_NAME);
        seed_db(
            &db,
            &[
                ("cursorAuth/cachedEmail", "brother@example.com"),
                ("cursorAuth/stripeMembershipAuthId", "auth0|real-user"),
            ],
        );

        assert_eq!(
            restore_cursor_auth_at(&ledger, Some(db)).unwrap(),
            CursorAuthRestore::NotNeeded
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
