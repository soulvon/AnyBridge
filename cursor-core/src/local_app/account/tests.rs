use std::collections::BTreeMap;
use std::path::Path;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};

use super::*;

pub(super) async fn open(path: &Path) -> SqliteConnection {
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

pub(super) async fn seed(path: &Path, values: &[(&str, &str)]) {
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

pub(super) async fn read(path: &Path, key: &str) -> Option<String> {
    let options = SqliteConnectOptions::new().filename(path);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    let value = select_value(&mut conn, key).await.unwrap();
    conn.close().await.unwrap();
    value
}

/// 混合模式：真实登录（含 3.27 的 safe-storage 加密 token）必须原样保留，
/// 不注入本地账号（2026-11-15 恢复；解锁靠门禁与 MITM 接管，与账号无关）。
#[tokio::test]
async fn real_login_is_kept_in_hybrid_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.vscdb");
    let ledger = dir.path().join(LEDGER_FILE_NAME);
    let real = "cursor-safe-storage:v1:written-by-cursor-3-27";
    seed(&path, &[("cursorAuth/accessToken", real), ("cursorAuth/cachedEmail", "me@example.com")]).await;

    inject_if_missing_at(&path, &ledger).await.unwrap();

    let kept = read(&path, "cursorAuth/accessToken").await;
    assert_eq!(kept.as_deref(), Some(real), "真实 token 必须原样保留");
    assert!(!ledger.exists(), "未注入就不该落账本");
}

/// 错位快照（token 与资料键分属两个账号，账号切换扩展残留）→ 跳过注入、
/// 不落账本，保留现状。把错位快照当「用户原值」还原，会让用户看到别人的号
/// （2026-11-15 真机事故）。
#[tokio::test]
async fn inconsistent_profile_snapshot_skips_injection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.vscdb");
    let ledger = dir.path().join(LEDGER_FILE_NAME);
    let token = "cursor-safe-storage:v1:token-belongs-to-google-account";
    // token 属 Google 号，但资料键全部是另一个 GitHub 号的——典型切换残留
    seed(
        &path,
        &[
            ("cursorAuth/accessToken", token),
            ("cursorAuth/cachedEmail", "859456603@qq.com"),
            ("cursorAuth/cachedSignUpType", "Github"),
            ("cursorAuth/stripeMembershipAuthId", "google-oauth2|user_01JNS5QZQTF7NZGEKT35949CMH"),
            ("cursorAuth/stripeMembershipType", "ultra"),
            ("cursorAuth/stripeSubscriptionStatus", "active"),
        ],
    )
    .await;

    inject_if_missing_at(&path, &ledger).await.unwrap();

    assert_eq!(
        read(&path, "cursorAuth/accessToken").await.as_deref(),
        Some(token),
        "错位快照下 token 必须原样保留"
    );
    assert_eq!(
        read(&path, "cursorAuth/cachedEmail").await.as_deref(),
        Some("859456603@qq.com"),
        "错位快照下资料键不得被本地账号覆盖"
    );
    assert!(!ledger.exists(), "错位快照不得落账本（还原时会固化错误状态）");
}

/// 错位判定纯函数：登录方式前缀与 sign-up 类型互相矛盾、或已登录却无邮箱，
/// 都算错位；未登录与资料齐全的正常快照不算。
#[test]
fn snapshot_profile_is_inconsistent_detects_mixed_identity() {
    let map = |pairs: &[(&str, &str)]| -> BTreeMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), Some(v.to_string())))
            .collect()
    };
    // Google 号的 token 资料键却写着 Github —— 切换残留，错位
    let mixed = map(&[
        ("cursorAuth/accessToken", "any-real-token"),
        ("cursorAuth/cachedEmail", "859456603@qq.com"),
        ("cursorAuth/cachedSignUpType", "Github"),
        ("cursorAuth/stripeMembershipAuthId", "google-oauth2|user_01JNS5QZ"),
    ]);
    assert!(snapshot_profile_is_inconsistent(&mixed));
    // 已登录但没有缓存邮箱 —— 资料块损坏，错位
    let no_email = map(&[
        ("cursorAuth/accessToken", "any-real-token"),
        ("cursorAuth/cachedSignUpType", "Google"),
        ("cursorAuth/stripeMembershipAuthId", "google-oauth2|user_01JNS5QZ"),
    ]);
    assert!(snapshot_profile_is_inconsistent(&no_email));
    // 资料齐全且前后一致 —— 正常
    let consistent = map(&[
        ("cursorAuth/accessToken", "any-real-token"),
        ("cursorAuth/cachedEmail", "859456603@qq.com"),
        ("cursorAuth/cachedSignUpType", "Github"),
        ("cursorAuth/stripeMembershipAuthId", "github|user_01J7T36Z"),
    ]);
    assert!(!snapshot_profile_is_inconsistent(&consistent));
    // 未登录（token 为空）不参与判定
    let logged_out = map(&[("cursorAuth/accessToken", ""), ("cursorAuth/cachedEmail", "")]);
    assert!(!snapshot_profile_is_inconsistent(&logged_out));
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
