//! Integrates local Cursor account state.
//!
//! 账号策略（混合模式，2026-11-01 定稿）：
//! - **已登录**（任何非空、非本地 token，含 Cursor 3.27 的 safe-storage 加密格式）：
//!   一律保留用户自己的号，一个字都不改。解锁靠 MITM 接管推理请求，跟账号无关。
//! - **未登录**：注入本地账号让 BYOK 可用（免登录），注入前把原值落进账本，
//!   关闭接管时逐键写回。
//!
//! 历史教训：曾把 safe-storage 当作「旧版解不开的残留」直接覆盖，3.27 的真实登录
//! 被冲掉且无从还原（issue 侧 2026-11-01）。判据不能靠 token 格式猜登录态。
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

/// 注入会覆盖的账号键。账本、写入、还原必须共用这一份清单。
const ACCOUNT_KEYS: [&str; 7] = [
    "cursorAuth/accessToken",
    "cursorAuth/refreshToken",
    "cursorAuth/cachedEmail",
    "cursorAuth/cachedSignUpType",
    "cursorAuth/stripeMembershipAuthId",
    "cursorAuth/stripeMembershipType",
    "cursorAuth/stripeSubscriptionStatus",
];

/// 账号账本（src-tauri 的还原路径读同一份文件，文件名不得单方面修改）。
/// `original` 只在首次注入时记录（null = 当时没有该键）；`applied` 是我们写入的值，
/// 还原时用来判断当前值是否仍属于注入态。
const LEDGER_FILE_NAME: &str = "cursor-auth-backup.json";

#[derive(Debug, Serialize, Deserialize)]
struct AuthLedger {
    #[allow(dead_code)]
    version: u32,
    original: BTreeMap<String, Option<String>>,
    applied: BTreeMap<String, Option<String>>,
}

/// 还原结果：必须区分「从未注入过」与「真的写回了原值」。
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    NotBackedUp,
    Restored {
        restored: usize,
        kept_user_changes: usize,
    },
}

/// 未登录时注入本地账号（BYOK 免登录）；已登录时原样保留、什么都不写。
pub async fn inject_if_missing() -> Result<()> {
    inject_if_missing_at(&state_db_path()?, &ledger_path()?).await
}

/// 关闭接管时把账号写回注入前的原值（对称于 [`inject_if_missing`]）。
pub async fn restore_if_backed_up() -> Result<RestoreOutcome> {
    restore_at(&state_db_path()?, &ledger_path()?).await
}

/// 清掉 Cursor 自己缓存的「强制 HTTP/1.1」标记。
///
/// Cursor 冷启动时先读 `cursorai/serverConfig` 缓存决定 transport 模式，之后才去
/// 拉实时配置。缓存里若留着 `http2Config: HTTP2_CONFIG_FORCE_ALL_DISABLED`，
/// 客户端会进 http1_sse（InferenceService 两段式 + InferenceStreamResponse 事件流），
/// 本实现不支持那条链路，表现为发消息必报 `Server error`；而且要等 10 分钟轮询
/// 到新配置才会重建 transport（2026-11-02 实测）。
///
/// 这里在接入时把该字段删掉，让客户端回到默认的 h2 / agent.v1.RunSSE 链路。
/// 写库失败不视为致命错误：Cursor 正在运行时数据库可能被占用，等用户重启客户端
/// 或者轮询生效即可。
pub async fn clear_cached_http2_force() -> Result<()> {
    clear_cached_http2_force_at(&state_db_path()?).await
}

async fn clear_cached_http2_force_at(db_path: &Path) -> Result<()> {
    const KEY: &str = "cursorai/serverConfig";
    // 只连已存在的库：不能因为路径不对就凭空造一个空 state.vscdb
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false);
    let mut connection = match SqliteConnection::connect_with(&options).await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(%error, "cannot open Cursor state db to clear the http2 cache");
            return Ok(());
        }
    };
    let Some(raw) = select_value(&mut connection, KEY).await? else {
        return Ok(());
    };
    let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(());
    };
    let Some(object) = config.as_object_mut() else {
        return Ok(());
    };
    if object.remove("http2Config").is_none() {
        return Ok(());
    }
    sqlx::query("UPDATE ItemTable SET value = ? WHERE key = ?")
        .bind(config.to_string())
        .bind(KEY)
        .execute(&mut connection)
        .await?;
    tracing::info!("cleared Cursor's cached FORCE_ALL_DISABLED http2 flag");
    Ok(())
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

async fn select_value(connection: &mut SqliteConnection, key: &str) -> Result<Option<String>> {
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

/// 读账本。文件不存在 = 从未注入；存在但解析失败 = 状态未知，必须报错，
/// 不能当成「没有账本」继续（否则会静默失去唯一还原源）。
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

/// 注入前落账本。已有账本时保留首次记录的 `original`，只刷新 `applied`，
/// 这样多轮接入不会把本地账号记成用户原值。
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

/// 已有任何非空、非本地 token = 用户自己的登录态，一律保留。
///
/// **不要**再按 token 格式猜（safe-storage 是 Cursor 3.27 的真实登录格式，
/// 曾经把它当「降级残留」覆盖，直接把用户账号冲掉且无从还原）。
fn keeps_existing_login(value: &str, token: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value != token
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
        // 混合模式：用户已登录，账号一概不动。
        return Ok(());
    }

    let applied = applied_values(&token);
    // 覆盖前必须先把原值落盘：写账本失败就拒绝注入。
    // 宁可免登录不生效，也不能出现「账号被冲掉且无处可还原」。
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
        "injected local Cursor account for logged-out user (original values recorded)"
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
    tracing::info!(restored, kept_user_changes, "restored Cursor account state");
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

    /// 混合模式核心：任何真实登录（含 Cursor 3.27 的 safe-storage 加密格式）
    /// 都必须原样保留，一个键都不许改。
    #[tokio::test]
    async fn keeps_real_login_including_safe_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        for token in [
            "eyJhbGciOiJSUzI1NiJ9.real-login-payload.real-signature",
            "cursor-safe-storage:v1:written-by-cursor-3-27",
        ] {
            seed(&path, &[("cursorAuth/accessToken", token)]).await;
            inject_if_missing_at(&path, &ledger).await.unwrap();
            assert_eq!(
                read(&path, "cursorAuth/accessToken").await.as_deref(),
                Some(token),
                "已有登录不得被覆盖"
            );
            assert!(!ledger.exists(), "保留登录时不应落账本");
        }
    }

    /// 未登录（accessToken 缺失/空）→ 注入本地账号，让 BYOK 免登录可用。
    #[tokio::test]
    async fn injects_local_account_when_logged_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        seed(&path, &[("cursorAuth/accessToken", "")]).await;

        inject_if_missing_at(&path, &ledger).await.unwrap();

        for key in ACCOUNT_KEYS {
            let value = read(&path, key).await;
            assert!(
                value.as_deref().is_some_and(|value| !value.is_empty()),
                "{key} should be seeded"
            );
        }
        assert!(ledger.exists(), "注入前必须落账本");
    }

    #[tokio::test]
    async fn inject_is_idempotent_for_local_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        seed(&path, &[("cursorAuth/accessToken", &local_token().unwrap())]).await;

        inject_if_missing_at(&path, &ledger).await.unwrap();

        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.unwrap(),
            local_token().unwrap()
        );
        assert!(ledger.exists(), "本地账号仍属于注入态，账本必须存在");
    }

    /// 账本写不进去时宁可拒绝注入，也不能不可逆覆盖。
    #[tokio::test]
    async fn injection_is_refused_when_ledger_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let ledger = blocked.join(LEDGER_FILE_NAME);
        seed(&path, &[("cursorAuth/accessToken", "")]).await;

        assert!(inject_if_missing_at(&path, &ledger).await.is_err());
        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.as_deref(),
            Some(""),
            "账本失败时不得改动账号数据"
        );
    }

    /// 注入后关闭接管：逐键写回注入前的原值（未登录用户回到未登录态）。
    #[tokio::test]
    async fn inject_and_restore_roundtrip_restores_logged_out_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        seed(&path, &[("cursorAuth/accessToken", "")]).await;

        inject_if_missing_at(&path, &ledger).await.unwrap();
        assert_eq!(
            read(&path, "cursorAuth/cachedEmail").await.as_deref(),
            Some(EMAIL)
        );

        let outcome = restore_at(&path, &ledger).await.unwrap();
        assert_eq!(
            outcome,
            RestoreOutcome::Restored {
                restored: ACCOUNT_KEYS.len(),
                kept_user_changes: 0
            }
        );
        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.as_deref(),
            Some(""),
            "未登录用户还原后回到未登录态"
        );
        assert!(!ledger.exists());
    }

    /// 注入期间用户自己登录了（当前值 != applied）：保留用户改动。
    #[tokio::test]
    async fn restore_keeps_user_changes_made_after_injection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        seed(&path, &[("cursorAuth/accessToken", "")]).await;

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
            "用户注入期间的登录必须保留"
        );
    }

    /// 没有账本 = 从未注入，必须明确报告而不是假装还原成功。
    #[tokio::test]
    async fn restore_without_ledger_reports_not_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        seed(&path, &[("cursorAuth/accessToken", "real-token")]).await;

        assert_eq!(
            restore_at(&path, &ledger).await.unwrap(),
            RestoreOutcome::NotBackedUp
        );
    }

    /// 客户端缓存里的「强制 h1」标记必须能被清掉，其它配置项保持原样。
    #[tokio::test]
    async fn clears_cached_http2_flag_without_touching_other_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let payload = serde_json::json!({
            "configVersion": "v1",
            "http2Config": "HTTP2_CONFIG_FORCE_ALL_DISABLED",
            "keepMe": 42,
        })
        .to_string();
        seed(&path, &[("cursorai/serverConfig", &payload)]).await;

        clear_cached_http2_force_at(&path).await.unwrap();

        let raw = read(&path, "cursorai/serverConfig").await.unwrap();
        let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(config.get("http2Config").is_none(), "h1 标记必须被清掉");
        assert_eq!(config.get("keepMe").and_then(|v| v.as_i64()), Some(42));
        assert_eq!(
            config.get("configVersion").and_then(|v| v.as_str()),
            Some("v1")
        );
    }

    /// 没有该键时保持幂等，不报错。
    #[tokio::test]
    async fn clearing_cached_http2_flag_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let payload = serde_json::json!({ "configVersion": "v1" }).to_string();
        seed(&path, &[("cursorai/serverConfig", &payload)]).await;
        clear_cached_http2_force_at(&path).await.unwrap();
        clear_cached_http2_force_at(&path).await.unwrap();
        assert!(read(&path, "cursorai/serverConfig").await.is_some());
    }
}
