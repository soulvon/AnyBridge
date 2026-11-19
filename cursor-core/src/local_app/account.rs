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
    let target = path.to_path_buf();
    tokio::task::spawn_blocking(move || crate::fs_atomic::write_atomic(&target, &data))
        .await
        .map_err(|e| Error::Config(format!("write auth ledger task failed: {e}")))??;
    Ok(())
}

/// 是否保留当前登录态、跳过注入。
///
/// 混合模式（2026-11-15 恢复 2f6e3d2f 语义）：任何非空、非本地 token 都保留，
/// 含 Cursor 3.27+ 的 safe-storage 加密登录。解锁靠门禁强制摁回 RunSSE
/// （haxsd PR #9 同款方案）+ 模型清单注入 + MITM 接管，与账号无关。
/// 此前「保留真实登录会被拦在 Unknown model ID」的结论是 3.27 时代没有门禁
/// 方案时得出的（2026-11-02 实测），3.29.15 上两轮对话实测不再复现。
///
/// 只有未登录（token 缺失/空/已是本地账号）才注入本地账号，注入前落账本；
/// 关闭接管时按账本还原（restore_at 保留，兼容旧版本注入过的现场）。
fn keeps_existing_login(value: &str, token: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value != token
}

/// 资料键与登录方式互相矛盾（账号切换扩展残留的典型特征）时，返回 true。
///
/// 判据（全部明文可读，无需解密 token）：
/// - `stripeMembershipAuthId` 的登录方式前缀（github| / google-oauth2|）必须与
///   `cachedSignUpType`（Github / Google）一致；写的是哪个号，前缀就该是哪种。
/// - 已登录（accessToken 非空）时 `cachedEmail` 不能为空。
///
/// 2026-11-15 真机事故：接管快照落在「token 属 Google 号、资料键属 GitHub 号」的
/// 错位状态上，还原后用户看到别人的账号。错位快照一律视为不可信——跳过注入、
/// 不落账本，保留现状让客户端自行更新（错位状态下 token 仍是有效的官方登录，
/// 保留即可；资料键只是缓存显示，不影响鉴权）。
fn snapshot_profile_is_inconsistent(current: &BTreeMap<String, Option<String>>) -> bool {
    let value = |key: &str| -> String {
        current
            .get(key)
            .and_then(Option::as_deref)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let access = value("cursorAuth/accessToken");
    if access.is_empty() {
        return false;
    }
    // 我们自己注入的本地号现场（幂等重注）不属于错位
    if is_local_cursor_token(&access) {
        return false;
    }
    let email = value("cursorAuth/cachedEmail");
    if email.is_empty() {
        return true;
    }
    let signup = value("cursorAuth/cachedSignUpType");
    let stripe = value("cursorAuth/stripeMembershipAuthId");
    let expected_signup = if let Some(rest) = stripe.strip_prefix("github|") {
        (!rest.is_empty()).then_some("Github")
    } else if let Some(rest) = stripe.strip_prefix("google-oauth2|") {
        (!rest.is_empty()).then_some("Google")
    } else if stripe.is_empty() {
        None
    } else {
        Some(signup.as_str())
    };
    match expected_signup {
        Some(expected) => signup != expected,
        None => false,
    }
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
    if snapshot_profile_is_inconsistent(&current) {
        // 快照错位（token 与资料键分属两个账号，多为账号切换扩展残留）。
        // 把它落账本等于固化错误：还原时会原样写回，用户看到的仍是别人的号。
        // 错位状态下 token 仍是有效官方登录，保留现状即可，不需要免登录。
        tracing::warn!(
            email = %current.get("cursorAuth/cachedEmail").and_then(Option::as_deref).unwrap_or(""),
            signup = %current.get("cursorAuth/cachedSignUpType").and_then(Option::as_deref).unwrap_or(""),
            stripe = %current.get("cursorAuth/stripeMembershipAuthId").and_then(Option::as_deref).unwrap_or(""),
            "账号快照资料键与登录方式错位，跳过免登录注入且不落账本（保留现状）"
        );
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
    // 存量账本也可能是错位快照（账号切换扩展残留）：原样写回会固化别人的登录态
    // （2026-11-15 真机事故）。校验不过就整段跳过，账本保留供人工排查。
    if snapshot_profile_is_inconsistent(&record.original) {
        tracing::warn!(
            email = %record.original.get("cursorAuth/cachedEmail").and_then(Option::as_deref).unwrap_or(""),
            signup = %record.original.get("cursorAuth/cachedSignUpType").and_then(Option::as_deref).unwrap_or(""),
            stripe = %record.original.get("cursorAuth/stripeMembershipAuthId").and_then(Option::as_deref).unwrap_or(""),
            "账本原值资料键与登录方式错位，跳过还原以免固化错误账号（账本保留）"
        );
        return Ok(RestoreOutcome::Restored {
            restored: 0,
            kept_user_changes: 0,
        });
    }
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
        // 判断「当前值是否还属于我们注入的那个本地账号」。
        //
        // Cursor 在使用中会自动刷新 token（把我们注入的本地 token 换成新签发的
        // JWT），于是 current != applied 是常态，而不是「用户改过」的证据。
        // 之前就因为这个误判跳过了还原，导致关闭接入后真实账号永久丢失
        // （2026-11-02 实测）。真正的判据是：库里缓存的邮箱是否仍是本地账号。
        if current != applied
            && !still_injected_account(&mut *transaction, &record.applied).await?
        {
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
    // 还原账号后清理会员失效标记：该标记残留会让客户端在下次启动时把登录态
    // 清成登出（2026-11-15 真机事故：账号数据其实还原成功，仅因这个残留键
    // 被当成「会员失效」，整个登录被客户端自己清空）。账本 original 里没有
    // 这个键（注入清单只有 7 键），所以原样还原不会带回来，删除是安全的。
    sqlx::query("DELETE FROM ItemTable WHERE key = 'cursorAuth/hasInvalidatedMembershipForUnifiedSemanticsV2'")
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    tokio::fs::remove_file(ledger).await?;
    tracing::info!(restored, kept_user_changes, "restored Cursor account state");
    Ok(RestoreOutcome::Restored {
        restored,
        kept_user_changes,
    })
}

/// 库里当前登录态是否仍是我们注入的那个本地账号。
///
/// Cursor 会把注入的本地 token 刷新成新签发的 JWT，所以「token 变了」不代表
/// 用户重新登录了别的号。用缓存邮箱识别身份才是可靠的：只要它还是本地账号的
/// 邮箱，关闭接管就必须按账本还原，否则用户的真实登录会永久丢失。
async fn still_injected_account(
    connection: &mut SqliteConnection,
    applied: &BTreeMap<String, Option<String>>,
) -> Result<bool> {
    let Some(Some(expected)) = applied.get("cursorAuth/cachedEmail") else {
        return Ok(false);
    };
    let current = select_value(connection, "cursorAuth/cachedEmail").await?;
    Ok(current.as_deref() == Some(expected.as_str()))
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
#[path = "account/tests.rs"]
mod extra_tests;

#[cfg(test)]
mod tests {
    use super::extra_tests::{read, seed};
    use super::*;

    /// 关键回归（旧版本注入过的现场）：Cursor 会把注入的本地 token 刷新成新 JWT，
    /// 此时「当前值 ≠ 注入值」但身份仍是本地账号，按旧账本还原必须照常执行，
    /// 否则用户真实登录永久丢失（2026-11-02 事故）。还原逻辑保留以兼容存量现场。
    #[tokio::test]
    async fn restores_real_login_from_legacy_ledger_even_after_token_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        let real = "cursor-safe-storage:v1:real-user-token";
        // 模拟旧版本注入过的现场：账本已落、库里是本地账号，且 token 已被刷新
        let ledger_json = serde_json::json!({
            "version": 1,
            "original": {
                "cursorAuth/accessToken": real,
                "cursorAuth/cachedEmail": "me@example.com"
            },
            "applied": {
                "cursorAuth/accessToken": "eyJhbGciOiJIUzI1NiJ9.local-injected-by-old-build",
                "cursorAuth/cachedEmail": EMAIL
            }
        });
        tokio::fs::write(&ledger, ledger_json.to_string()).await.unwrap();
        seed(
            &path,
            &[
                ("cursorAuth/accessToken", "eyJhbGciOiJIUzI1NiJ9.refreshed-by-cursor.signature"),
                ("cursorAuth/cachedEmail", EMAIL),
            ],
        )
        .await;

        let outcome = restore_at(&path, &ledger).await.unwrap();
        assert!(
            matches!(outcome, RestoreOutcome::Restored { .. }),
            "刷新过的本地 token 也必须触发还原，实际: {outcome:?}"
        );
        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.as_deref(),
            Some(real),
            "真实登录必须写回"
        );
        assert!(!ledger.exists(), "还原后账本应删除");
        // 还原后不得残留会员失效标记，否则客户端下次启动会把登录态清空
        assert_eq!(read(&path, "cursorAuth/hasInvalidatedMembershipForUnifiedSemanticsV2").await, None);
    }

    /// 存量错位账本在关闭接入时不得写回，否则固化别人的登录态。
    #[tokio::test]
    async fn restore_skips_inconsistent_legacy_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let ledger = dir.path().join(LEDGER_FILE_NAME);
        let ledger_json = serde_json::json!({
            "version": 1,
            "original": {
                "cursorAuth/accessToken": "cursor-safe-storage:v1:token-of-google-account",
                "cursorAuth/cachedEmail": "859456603@qq.com",
                "cursorAuth/cachedSignUpType": "Github",
                "cursorAuth/stripeMembershipAuthId": "google-oauth2|user_01JNS5QZ"
            },
            "applied": {
                "cursorAuth/accessToken": EMAIL,
                "cursorAuth/cachedEmail": EMAIL
            }
        });
        tokio::fs::write(&ledger, ledger_json.to_string()).await.unwrap();
        seed(
            &path,
            &[("cursorAuth/accessToken", EMAIL), ("cursorAuth/cachedEmail", EMAIL)],
        )
        .await;

        let outcome = restore_at(&path, &ledger).await.unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored { restored: 0, .. }));
        assert_eq!(
            read(&path, "cursorAuth/accessToken").await.as_deref(),
            Some(EMAIL),
            "错位账本不得写回，当前登录态必须保留"
        );
        assert!(ledger.exists(), "账本保留供人工排查");
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
}
