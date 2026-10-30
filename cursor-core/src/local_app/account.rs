//! Integrates local Cursor account state.
use std::path::{Path, PathBuf};

use axum::http::{header, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::json;
use sqlx::{Connection, Row, SqliteConnection};

use crate::{Error, Result};

const EMAIL: &str = "cursor@ai.com";
const SIGN_UP_TYPE: &str = "Google";
const SUBJECT: &str = "cursor-local-user";
const MEMBERSHIP_TYPE: &str = "ultra";
const SUBSCRIPTION_STATUS: &str = "active";

/// 新版 Cursor（3.27+）登录后会把 token 升级成 safe-storage 加密格式；
/// 旧版本解不开这个格式，读到它就等于未登录（`Auth init timeout`），
/// agent 请求根本不会发出。因此这种值不能当作"已有真实登录"来跳过注入。
const SAFE_STORAGE_PREFIX: &str = "cursor-safe-storage";

pub async fn inject_if_missing() -> Result<()> {
    inject_if_missing_at(&state_db_path()?).await
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

async fn inject_if_missing_at(path: &Path) -> Result<()> {
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

    let token = local_token()?;
    let account = sqlx::query("SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = ?")
        .bind("cursorAuth/accessToken")
        .fetch_optional(&mut connection)
        .await?;
    if account.is_some_and(|row| {
        row.try_get::<String, _>("value").is_ok_and(|value| {
            !value.trim().is_empty()
                && value != token
                    && !value.starts_with(SAFE_STORAGE_PREFIX)
        })
    }) {
        return Ok(());
    }

    let values = [
        ("cursorAuth/accessToken", token.as_str()),
        ("cursorAuth/refreshToken", token.as_str()),
        ("cursorAuth/cachedEmail", EMAIL),
        ("cursorAuth/cachedSignUpType", SIGN_UP_TYPE),
        ("cursorAuth/stripeMembershipAuthId", SUBJECT),
        ("cursorAuth/stripeMembershipType", MEMBERSHIP_TYPE),
        ("cursorAuth/stripeSubscriptionStatus", SUBSCRIPTION_STATUS),
    ];
    let mut transaction = connection.begin().await?;
    for (key, value) in values {
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
        "injected local Cursor account"
    );
    Ok(())
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

    #[test]
    fn recognizes_non_empty_official_bearer_tokens() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer official-token".parse().unwrap());
        assert!(has_official_cursor_authorization(&headers));

        headers.insert(header::AUTHORIZATION, "Bearer   ".parse().unwrap());
        assert!(!has_official_cursor_authorization(&headers));
    }

    async fn seeded_db(path: &Path, access_token: &str) {
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
        sqlx::query("INSERT OR REPLACE INTO ItemTable(key, value) VALUES('cursorAuth/accessToken', ?)")
            .bind(access_token)
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
    }

    async fn read_access_token(path: &Path) -> String {
        let options = SqliteConnectOptions::new().filename(path);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        let value: String = sqlx::query(
            "SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .get("value");
        conn.close().await.unwrap();
        value
    }

    /// 升级新版 Cursor 会把 token 升级成 safe-storage 加密格式；降级回旧版本后
    /// 这个格式解不开，若注入逻辑把它当"真实登录"跳过，agent 请求将不会发出。
    #[tokio::test]
    async fn inject_overwrites_incompatible_safe_storage_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        seeded_db(&path, "cursor-safe-storage:v1:written-by-cursor-3-27").await;

        inject_if_missing_at(&path).await.unwrap();

        let value = read_access_token(&path).await;
        assert_eq!(value, local_token().unwrap());
    }

    #[tokio::test]
    async fn inject_is_idempotent_for_local_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        seeded_db(&path, &local_token().unwrap()).await;

        inject_if_missing_at(&path).await.unwrap();

        assert_eq!(read_access_token(&path).await, local_token().unwrap());
    }

    #[tokio::test]
    async fn inject_preserves_real_login_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let real = "eyJhbGciOiJSUzI1NiJ9.real-login-payload.real-signature";
        seeded_db(&path, real).await;

        inject_if_missing_at(&path).await.unwrap();

        assert_eq!(read_access_token(&path).await, real);
    }

    #[tokio::test]
    async fn inject_seeds_missing_account_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        seeded_db(&path, "").await;

        inject_if_missing_at(&path).await.unwrap();

        let options = SqliteConnectOptions::new().filename(path);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        for key in [
            "cursorAuth/accessToken",
            "cursorAuth/refreshToken",
            "cursorAuth/cachedEmail",
            "cursorAuth/cachedSignUpType",
            "cursorAuth/stripeMembershipAuthId",
            "cursorAuth/stripeMembershipType",
            "cursorAuth/stripeSubscriptionStatus",
        ] {
            let value: String = sqlx::query(
                "SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = ?",
            )
            .bind(key)
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .get("value");
            assert!(!value.is_empty(), "{key} should be seeded");
        }
        conn.close().await.unwrap();
    }
}
