//! Integrates local Cursor account state.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use axum::http::{header, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Connection, Row, SqliteConnection};

use crate::{config::managed_data_dir, Error, Result};

const EMAIL: &str = "cursor@ai.com";
const SIGN_UP_TYPE: &str = "Google";
const SUBJECT: &str = "cursor-local-user";
const MEMBERSHIP_TYPE: &str = "ultra";
const SUBSCRIPTION_STATUS: &str = "active";

/// 新版 Cursor（3.27+）登录后会把 token 升级成 safe-storage 加密格式；
/// 旧版本解不开这个格式，读到它就等于未登录（`Auth init timeout`），
/// agent 请求根本不会发出。因此这种值不能当作"已有真实登录"来跳过注入。
///
/// 注意：新版 Cursor 的**真实登录**也是这个格式，所以覆盖它等于换掉用户账号。
/// 覆盖前必须把原值写进账本（`write_ledger`），还原时逐键写回——判据无法区分
/// "降级残留"与"新版真实登录"，只有账本能让这次覆盖变成可逆操作。
const SAFE_STORAGE_PREFIX: &str = "cursor-safe-storage";

/// 注入会覆盖的账号键。账本、写入、还原必须共用这一份清单，
/// 任何一处漏键都会让还原后的账号处于半覆盖状态。
const ACCOUNT_KEYS: [&str; 7] = [
    "cursorAuth/accessToken",
    "cursorAuth/refreshToken",
    "cursorAuth/cachedEmail",
    "cursorAuth/cachedSignUpType",
    "cursorAuth/stripeMembershipAuthId",
    "cursorAuth/stripeMembershipType",
    "cursorAuth/stripeSubscriptionStatus",
];

/// 账号接管账本（src-tauri 的还原路径读同一份文件，文件名不得单方面修改）。
///
/// - `original`：接入前用户的原值，**只在首次接管时记录**（`null` = 当时没有这个键）
/// - `applied`：我们写进去的值，还原时用来判断"当前值是否仍属于我们"
const LEDGER_FILE_NAME: &str = "cursor-auth-backup.json";

#[derive(Debug, Serialize, Deserialize)]
struct AuthLedger {
    version: u32,
    original: BTreeMap<String, Option<String>>,
    applied: BTreeMap<String, Option<String>>,
}

/// 还原结果。必须区分「从未接管过」与「真的写回了原值」，
/// 不允许把"账本缺失"当成成功——那正是账号被冲后无从还原的形态。
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// 没有账本 = 从未覆盖过用户账号
    NotBackedUp,
    Restored {
        restored: usize,
        kept_user_changes: usize,
    },
}

pub async fn inject_if_missing() -> Result<()> {
    inject_if_missing_at(&state_db_path()?, &ledger_path()?).await
}

/// 关闭接管时把账号状态写回用户原值（对称于 [`inject_if_missing`]）。
pub async fn restore_if_backed_up() -> Result<RestoreOutcome> {
    restore_at(&state_db_path()?, &ledger_path()?).await
}

fn state_db_path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    match std::env::consts::OS {
        "macos" => {
            Ok(home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb"))
        }
        "windows" => Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Cursor/User/globalStorage/state.vscdb")),
        "linux" => Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("Cursor/User/globalStorage/state.vscdb")),
        platform => Err(Error::Config(format!(
            "Cursor account injection is unsupported on {platform}"
        ))),
    }
}

fn ledger_path() -> Result<PathBuf> {
    Ok(managed_data_dir()?.join(LEDGER_FILE_NAME))
}

async fn connect(path: &Path) -> Result<SqliteConnection> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    )
    .execute(&mut connection)
    .await?;
    Ok(connection)
}

async fn select_value(
    connection: &mut SqliteConnection,
    key: &str,
) -> Result<Option<String>> {
    let row = sqlx::query("SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = ?")
        .bind(key)
        .fetch_optional(connection)
        .await?;
    match row {
        Some(row) => Ok(row.try_get::<Option<String>, _>("value")?),
        None => Ok(None),
    }
}

async fn read_account_values(
    connection: &mut SqliteConnection,
) -> Result<BTreeMap<String, Option<String>>> {
    let mut values = BTreeMap::new();
    for key in ACCOUNT_KEYS {
        values.insert(key.to_string(), select_value(connection, key).await?);
    }
    Ok(values)
}

/// 我们即将写入的账号值。键集合只有 [`ACCOUNT_KEYS`] 一处定义。
fn applied_values(token: &str) -> BTreeMap<String, Option<String>> {
    ACCOUNT_KEYS
        .into_iter()
        .map(|key| {
            let value = match key {
                "cursorAuth/accessToken" | "cursorAuth/refreshToken" => token.to_string(),
                "cursorAuth/cachedEmail" => EMAIL.to_string(),
                "cursorAuth/cachedSignUpType" => SIGN_UP_TYPE.to_string(),
                "cursorAuth/stripeMembershipAuthId" => SUBJECT.to_string(),
                "cursorAuth/stripeMembershipType" => MEMBERSHIP_TYPE.to_string(),
                _ => SUBSCRIPTION_STATUS.to_string(),
            };
            (key.to_string(), Some(value))
        })
        .collect()
}

/// 读账本。文件不存在 = 从未接管；存在但解析失败 = 状态未知，必须报错，
/// 绝不能当成"没有账本"继续（否则会静默失去唯一还原源）。
async fn read_ledger(path: &Path) -> Result<Option<AuthLedger>> {
    match tokio::fs::read(path).await {
        Ok(data) => serde_json::from_slice(&data).map(Some).map_err(|error| {
            Error::Config(format!(
                "Cursor 账号账本损坏，无法确认原账号状态（{}）: {error}",
                path.display()
            ))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// 覆盖前落账本。已有账本时保留首次记录的 `original`，只刷新 `applied`，
/// 这样多轮接入不会把"我们自己的假账号"记成用户原值。
async fn write_ledger(
    path: &Path,
    original: &BTreeMap<String, Option<String>>,
    applied: &BTreeMap<String, Option<String>>,
) -> Result<()> {
    let record = match read_ledger(path).await? {
        Some(mut record) => {
            record.applied = applied.clone();
            record
        }
        None => AuthLedger {
            version: 1,
            original: original.clone(),
            applied: applied.clone(),
        },
    };
    let data = serde_json::to_vec_pretty(&record)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp = path.with_extension("json.tmp");
    tokio::fs::write(&temp, data).await?;
    if tokio::fs::try_exists(path).await? {
        tokio::fs::remove_file(path).await?;
    }
    tokio::fs::rename(&temp, path).await?;
    Ok(())
}

/// 非空、非本地 token、非 safe-storage = 用户自己的真实登录，保留不动。
fn keeps_existing_login(value: &str, token: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value != token && !value.starts_with(SAFE_STORAGE_PREFIX)
}

async fn inject_if_missing_at(db_path: &Path, ledger: &Path) -> Result<()> {
    let mut connection = connect(db_path).await?;

    let token = local_token()?;
    let current = read_account_values(&mut connection).await?;
    if current
        .get("cursorAuth/accessToken")
        .and_then(Option::as_deref)
        .is_some_and(|value| keeps_existing_login(value, &token))
    {
        return Ok(());
    }

    let applied = applied_values(&token);
    // 覆盖前必须先把原值落盘：写账本失败就拒绝注入。
    // 宁可免登录不生效，也不能再出现"账号被冲掉且无处可还原"。
    write_ledger(ledger, &current, &applied).await?;

    let mut transaction = connection.begin().await?;
    for (key, value) in &applied {
        let value = value.as_deref().unwrap_or_default();
        sqlx::query("INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)")
            .bind(key)
            .bind(value)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    tracing::info!(
        email = EMAIL,
        subject = SUBJECT,
        ledger = %ledger.display(),
        "injected local Cursor account (original values recorded in ledger)"
    );
    Ok(())
}

async fn restore_at(db_path: &Path, ledger: &Path) -> Result<RestoreOutcome> {
    let Some(record) = read_ledger(ledger).await? else {
        return Ok(RestoreOutcome::NotBackedUp);
    };
    if !db_path.exists() {
        return Err(Error::Config(format!(
            "未找到 Cursor state.vscdb，账号原值无法写回: {}",
            db_path.display()
        )));
    }

    let mut connection = connect(db_path).await?;
    let mut transaction = connection.begin().await?;
    let mut restored = 0usize;
    let mut kept_user_changes = 0usize;
    for (key, original) in &record.original {
        let applied = record.applied.get(key).cloned().flatten();
        let current = select_value(&mut *transaction, key).await?;
        // 当前值不再是我们写的那份 = 用户接管期间自己改过（重新登录/换会员），
        // 保留用户改动，绝不拿旧快照覆盖回去。
        if current != applied {
            kept_user_changes += 1;
            continue;
        }
        match original {
            Some(value) => {
                sqlx::query("INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)")
                    .bind(key)
                    .bind(value)
                    .execute(&mut *transaction)
                    .await?;
            }
            None => {
                sqlx::query("DELETE FROM ItemTable WHERE key = ?")
                    .bind(key)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        restored += 1;
    }
    transaction.commit().await?;
    tokio::fs::remove_file(ledger).await?;
    tracing::info!(
        restored,
        kept_user_changes,
        "restored Cursor account state from ledger"
    );
    Ok(RestoreOutcome::Restored {
        restored,
        kept_user_changes,
    })
}

pub(crate) fn is_local_cursor_authorization(authorization: &str) -> bool {
    authorization
        .strip_prefix("Bearer ")
        .is_some_and(is_local_cursor_token)
}

fn is_local_cursor_token(token: &str) -> bool {
    local_token().is_ok_and(|local| local == token)
}

pub(super) fn local_token() -> Result<String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
        "sub": SUBJECT,
        "email": EMAIL,
        "type": "session",
        "iss": "cursor-client",
        "scope": "openid profile email",
        "exp": 4070908800_u64
    }))?);
    Ok(format!("{header}.{payload}.{SUBJECT}"))
}

#[allow(dead_code)]
pub(crate) fn has_official_cursor_authorization(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| !token.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqliteConnectOptions;

    async fn open(path: &Path) -> SqliteConnection {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    async fn seed(path: &Path, values: &[(&str, &str)]) {
        let mut conn = open(path).await;
        for (key, value) in values {
            sqlx::query("INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)")
                .bind(*key)
                .bind(*value)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        conn.close().await.unwrap();
    }

    async fn read(path: &Path, key: &str) -> Option<String> {
        let options = SqliteConnectOptions::new().filename(path);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        let value = select_value(&mut conn, key).await.unwrap();
        conn.close().await.unwrap();
        value
    }

    async fn seeded_db(path: &Path, access_token: &str) {
        seed(path, &[("cursorAuth/accessToken", access_token)]).await;
    }

    #[test]
    fn recognizes_non_empty_official_bearer_tokens() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer official-token".parse().unwrap());
        assert!(has_official_cursor_authorization(&headers));

        headers.insert(header::AUTHORIZATION, "Bearer   ".parse().unwrap());
        assert!(!has_official_cursor_authorization(&headers));
    }

    /// 升级新版 Cursor 会把 token 升级成 safe-storage 加密格式；降级回旧版本后
    /// 这个格式解不开，若注入逻辑把它当"真实登录"跳过，agent 请求将不会发出。
    #[tokio::test]
    async fn inject_overwrites_incompatible_safe_storage_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        seeded_db(&path, "cursor-safe-storage:v1:written-by-cursor-3-27").await;

        inject_if_missing_at(&path, &ledger).await.unwrap();

        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.unwrap(),
            local_token().unwrap()
        );
    }

    #[tokio::test]
    async fn inject_is_idempotent_for_local_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        seeded_db(&path, &local_token().unwrap()).await;

        inject_if_missing_at(&path, &ledger).await.unwrap();

        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.unwrap(),
            local_token().unwrap()
        );
    }

    #[tokio::test]
    async fn inject_preserves_real_login_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        let real = "eyJhbGciOiJSUzI1NiJ9.real-login-payload.real-signature";
        seeded_db(&path, real).await;

        inject_if_missing_at(&path, &ledger).await.unwrap();

        assert_eq!(read(&path, "cursorAuth/accessToken").await.unwrap(), real);
        assert!(!ledger.exists(), "保留真实登录时不应落账本");
    }

    #[tokio::test]
    async fn inject_seeds_missing_account_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        seeded_db(&path, "").await;

        inject_if_missing_at(&path, &ledger).await.unwrap();

        for key in ACCOUNT_KEYS {
            let value = read(&path, key).await;
            assert!(
                value.as_deref().is_some_and(|value| !value.is_empty()),
                "{key} should be seeded"
            );
        }
    }

    /// 事故复刻：3.27 真实登录是 safe-storage 格式，注入覆盖后必须能完整还原，
    /// 这是"账号被冲掉且还原失败"的唯一数据保障。
    #[tokio::test]
    async fn inject_and_restore_roundtrip_restores_original_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        let original = [
            (
                "cursorAuth/accessToken",
                "cursor-safe-storage:v1:real-access-token-blob",
            ),
            (
                "cursorAuth/refreshToken",
                "cursor-safe-storage:v1:real-refresh-token-blob",
            ),
            ("cursorAuth/cachedEmail", "brother@example.com"),
            ("cursorAuth/cachedSignUpType", "Github"),
            ("cursorAuth/stripeMembershipAuthId", "auth0|real-user"),
            ("cursorAuth/stripeMembershipType", "pro_plus"),
            ("cursorAuth/stripeSubscriptionStatus", "active"),
        ];
        seed(&path, &original).await;

        inject_if_missing_at(&path, &ledger).await.unwrap();
        assert!(ledger.exists(), "覆盖前必须落账本");
        assert_eq!(
            read(&path, "cursorAuth/cachedEmail").await.unwrap(),
            EMAIL
        );

        let outcome = restore_at(&path, &ledger).await.unwrap();
        assert_eq!(
            outcome,
            RestoreOutcome::Restored {
                restored: original.len(),
                kept_user_changes: 0
            }
        );
        for (key, value) in original {
            assert_eq!(read(&path, key).await.as_deref(), Some(value), "{key} 必须写回原值");
        }
        assert!(!ledger.exists(), "还原成功后账本必须删除");
    }

    /// 接管期间用户自己重新登录了（当前值 != 我们写的值），还原必须让位于用户改动。
    #[tokio::test]
    async fn restore_keeps_user_changes_made_after_injection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        seeded_db(&path, "cursor-safe-storage:v1:old-login").await;

        inject_if_missing_at(&path, &ledger).await.unwrap();
        seed(&path, &[("cursorAuth/cachedEmail", "relogin@example.com")]).await;

        let outcome = restore_at(&path, &ledger).await.unwrap();
        assert_eq!(
            outcome,
            RestoreOutcome::Restored {
                restored: ACCOUNT_KEYS.len() - 1,
                kept_user_changes: 1
            }
        );
        assert_eq!(
            read(&path, "cursorAuth/cachedEmail").await.as_deref(),
            Some("relogin@example.com"),
            "用户接管期间的改动必须保留"
        );
        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.as_deref(),
            Some("cursor-safe-storage:v1:old-login")
        );
    }

    /// 账本写不进去时宁可拒绝注入，也不能不可逆覆盖用户账号。
    #[tokio::test]
    async fn injection_is_refused_when_ledger_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let ledger = blocked.join("ledger.json");
        let original = "cursor-safe-storage:v1:must-survive";
        seeded_db(&path, original).await;

        assert!(inject_if_missing_at(&path, &ledger).await.is_err());
        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.as_deref(),
            Some(original),
            "账本失败时不得改动账号数据"
        );
    }

    /// 没有账本 = 从未接管，必须明确报告，而不是假装还原成功。
    #[tokio::test]
    async fn restore_without_ledger_reports_not_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join("ledger.json");
        seeded_db(&path, "cursor-safe-storage:v1:untouched").await;

        assert_eq!(
            restore_at(&path, &ledger).await.unwrap(),
            RestoreOutcome::NotBackedUp
        );
    }
}
