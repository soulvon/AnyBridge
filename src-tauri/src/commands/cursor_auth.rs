use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const REACTIVE_STORAGE_KEY: &str =
    "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const FAKE_PRO_SESSION_JWT: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLWN1cnNvci1sb2NhbC11c2VyIiwiZW1haWwiOiJjdXJzb3JAYWkuY29tIiwidHlwZSI6InNlc3Npb24iLCJpc3MiOiJjdXJzb3ItY2xpZW50Iiwic2NvcGUiOiJvcGVuaWQgcHJvZmlsZSBlbWFpbCIsImV4cCI6NDA3MDkwODgwMH0.fake-local-state-token";
const FAKE_PRO_EMAIL: &str = "cursor@ai.com";
const AUTH_KEYS: &[&str] = &[
    "cursorAuth/accessToken",
    "cursorAuth/refreshToken",
    "cursorAuth/cachedEmail",
    "cursorAuth/cachedSignUpType",
    "cursorAuth/stripeMembershipType",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorStateBackup {
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
    {
        None
    }
}

fn backup_path() -> PathBuf {
    crate::commands::config::config_dir_path().join("cursor-state-backup.json")
}

pub(crate) fn first_cursor_model_stable_id() -> Result<String, String> {
    let routes = crate::commands::proxy_routes::read_routes()?;
    let route = routes
        .routes
        .iter()
        .find(|route| {
            route.enabled
                && !route.targets.is_empty()
                && route
                    .exposed_formats
                    .iter()
                    .any(|fmt| fmt.eq_ignore_ascii_case("openai"))
        })
        .ok_or_else(|| {
            "未配置可供 Cursor 使用的本地代理模型。请先在「代理 > 模型列表」添加并启用 OpenAI 兼容模型。"
                .to_string()
        })?;
    let mut hasher = Sha256::new();
    hasher.update(format!("byok|{}", route.id).as_bytes());
    let digest = hex::encode(hasher.finalize());
    Ok(digest[..16].to_string())
}

fn open_cursor_db() -> Result<Connection, String> {
    let path =
        cursor_state_db_path().ok_or_else(|| "无法定位 Cursor state.vscdb 路径".to_string())?;
    if !path.exists() {
        return Err(format!(
            "未找到 Cursor state.vscdb: {}。请先启动一次 Cursor 到主界面后再切换。",
            path.to_string_lossy()
        ));
    }
    let conn = Connection::open(&path).map_err(|e| {
        format_sqlite_error(
            &format!("打开 Cursor state.vscdb 失败 ({})", path.to_string_lossy()),
            &e,
        )
    })?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|e| format_sqlite_error("设置 Cursor SQLite busy_timeout 失败", &e))?;
    Ok(conn)
}

fn format_sqlite_error(context: &str, error: &rusqlite::Error) -> String {
    let text = error.to_string();
    if text.contains("database is locked") || text.contains("database table is locked") {
        format!(
            "{}: SQLite 正被 Cursor 占用，请关闭 Cursor 后重试 ({})",
            context, text
        )
    } else {
        format!("{}: {}", context, text)
    }
}

fn query_item(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM ItemTable WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format_sqlite_error(&format!("读取 Cursor ItemTable key 失败: {}", key), &e))
}

fn write_backup_if_missing_at(
    conn: &Connection,
    reactive_storage: Option<String>,
    path: &Path,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Cursor 备份目录失败: {}", e))?;
    }
    let mut auth = BTreeMap::new();
    let mut already_fake = false;
    for key in AUTH_KEYS {
        let value = query_item(conn, key)?;
        if *key == "cursorAuth/accessToken" && value.as_deref() == Some(FAKE_PRO_SESSION_JWT) {
            already_fake = true;
        }
        auth.insert((*key).to_string(), value);
    }
    if already_fake {
        for key in AUTH_KEYS {
            auth.insert((*key).to_string(), None);
        }
    }
    let backup = CursorStateBackup {
        version: 1,
        auth,
        reactive_storage: if already_fake { None } else { reactive_storage },
    };
    let json =
        serde_json::to_vec_pretty(&backup).map_err(|e| format!("序列化 Cursor 备份失败: {}", e))?;
    crate::commands::write_atomic(&path, &json).map_err(|e| format!("写入 Cursor 备份失败: {}", e))
}

fn upsert_item(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ItemTable(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| format_sqlite_error(&format!("写入 Cursor ItemTable key 失败: {}", key), &e))
}

fn inject_fake_pro_user(conn: &Connection) -> Result<(), String> {
    for (key, value) in [
        ("cursorAuth/accessToken", FAKE_PRO_SESSION_JWT),
        ("cursorAuth/refreshToken", FAKE_PRO_SESSION_JWT),
        ("cursorAuth/cachedEmail", FAKE_PRO_EMAIL),
        ("cursorAuth/cachedSignUpType", "Auth"),
        ("cursorAuth/stripeMembershipType", "pro"),
    ] {
        upsert_item(conn, key, value)?;
    }
    Ok(())
}

fn object_entry<'a>(
    map: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if !map.contains_key(key) {
        map.insert(key.to_string(), Value::Object(Map::new()));
    }
    match map.get_mut(key) {
        Some(Value::Object(obj)) => Ok(obj),
        _ => Err(format!("Cursor reactiveStorage 字段不是对象: {}", key)),
    }
}

fn rewrite_ai_settings(root: &mut Map<String, Value>, stable_id: &str) -> Result<(), String> {
    let ai = object_entry(root, "aiSettings")?;
    {
        let model_config = object_entry(ai, "modelConfig")?;
        for feature in [
            "cmd-k",
            "composer",
            "composer-ensemble",
            "plan-execution",
            "spec",
            "deep-search",
            "quick-agent",
        ] {
            let selected_models = if feature == "composer" {
                json!([{ "modelId": stable_id, "parameters": [] }])
            } else {
                Value::Null
            };
            model_config.insert(
                feature.to_string(),
                json!({
                    "modelName": stable_id,
                    "maxMode": false,
                    "selectedModels": selected_models
                }),
            );
        }
        model_config
            .entry("background-composer".to_string())
            .or_insert_with(|| {
                json!({
                    "modelName": "default",
                    "maxMode": true,
                    "selectedModels": null
                })
            });
    }

    ai.insert("modelOverrideEnabled".to_string(), json!([]));
    ai.insert("modelsWithNoDefaultSwitch".to_string(), json!([stable_id]));
    ai.insert(
        "modelDefaultSwitchOnNewChat".to_string(),
        Value::Bool(false),
    );
    let previous = object_entry(ai, "previousModelBeforeDefault")?;
    for feature in [
        "cmd-k",
        "composer",
        "composer-ensemble",
        "plan-execution",
        "spec",
        "deep-search",
        "quick-agent",
    ] {
        previous.insert(feature.to_string(), Value::String(stable_id.to_string()));
    }
    Ok(())
}

fn rewrite_feature_model_configs(
    root: &mut Map<String, Value>,
    stable_id: &str,
) -> Result<(), String> {
    let fmc = object_entry(root, "featureModelConfigs")?;
    for (name, with_best_of_n) in [
        ("composer", true),
        ("cmdK", false),
        ("backgroundComposer", true),
        ("planExecution", false),
    ] {
        let best_of_n = if with_best_of_n {
            json!([stable_id])
        } else {
            json!([])
        };
        fmc.insert(
            name.to_string(),
            json!({
                "defaultModel": stable_id,
                "fallbackModels": [stable_id],
                "bestOfNDefaultModels": best_of_n
            }),
        );
    }
    for name in ["spec", "deepSearch", "quickAgent"] {
        fmc.insert(
            name.to_string(),
            json!({
                "defaultModel": stable_id,
                "fallbackModels": [],
                "bestOfNDefaultModels": []
            }),
        );
    }
    Ok(())
}

fn rewrite_reactive_storage(raw: &str, stable_id: &str) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|e| format!("解析 Cursor reactiveStorage JSON 失败: {}", e))?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| "Cursor reactiveStorage 顶层不是对象".to_string())?;
    rewrite_ai_settings(root, stable_id)?;
    rewrite_feature_model_configs(root, stable_id)?;
    serde_json::to_string(&value)
        .map_err(|e| format!("序列化 Cursor reactiveStorage JSON 失败: {}", e))
}

fn force_model_selection(
    conn: &Connection,
    stable_id: &str,
    raw_reactive: &str,
) -> Result<(), String> {
    let next = rewrite_reactive_storage(raw_reactive, stable_id)?;
    conn.execute(
        "UPDATE ItemTable SET value = ?1 WHERE key = ?2",
        params![next, REACTIVE_STORAGE_KEY],
    )
    .map_err(|e| format_sqlite_error("写入 Cursor reactiveStorage 失败", &e))?;
    Ok(())
}

pub(crate) fn apply_cursor_auth_and_model() -> Result<String, String> {
    let stable_id = first_cursor_model_stable_id()?;
    let conn = open_cursor_db()?;
    apply_cursor_auth_and_model_to_conn(&conn, &stable_id, &backup_path())
}

fn apply_cursor_auth_and_model_to_conn(
    conn: &Connection,
    stable_id: &str,
    backup_path: &Path,
) -> Result<String, String> {
    let raw_reactive = query_item(&conn, REACTIVE_STORAGE_KEY)?.ok_or_else(|| {
        "Cursor reactiveStorage 尚未初始化。请先启动一次 Cursor 到主界面后再切换。".to_string()
    })?;
    write_backup_if_missing_at(&conn, Some(raw_reactive.clone()), backup_path)?;
    inject_fake_pro_user(&conn)?;
    force_model_selection(&conn, &stable_id, &raw_reactive)?;
    Ok(format!("ok（模型 {}）", stable_id))
}

pub(crate) fn restore_cursor_auth() -> Result<bool, String> {
    let path = backup_path();
    if !path.exists() {
        return Ok(false);
    }
    let conn = open_cursor_db()?;
    restore_cursor_auth_from_backup(&conn, &path)
}

fn restore_cursor_auth_from_backup(conn: &Connection, path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read(&path).map_err(|e| format!("读取 Cursor 备份失败: {}", e))?;
    let backup: CursorStateBackup =
        serde_json::from_slice(&raw).map_err(|e| format!("解析 Cursor 备份失败: {}", e))?;
    for (key, value) in backup.auth {
        match value {
            Some(v) => upsert_item(&conn, &key, &v)?,
            None => {
                conn.execute("DELETE FROM ItemTable WHERE key = ?1", params![key])
                    .map_err(|e| format_sqlite_error("删除 Cursor auth key 失败", &e))?;
            }
        }
    }
    if let Some(reactive) = backup.reactive_storage {
        upsert_item(conn, REACTIVE_STORAGE_KEY, &reactive)?;
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除 Cursor 备份失败: {}", e))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_backup_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "anybridge-cursor-auth-{}-{}-{}",
                std::process::id(),
                unique,
                name
            ))
            .join("cursor-state-backup.json")
    }

    fn memory_cursor_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn
    }

    fn put_item(conn: &Connection, key: &str, value: &str) {
        conn.execute(
            "INSERT INTO ItemTable(key,value) VALUES(?1,?2)",
            params![key, value],
        )
        .unwrap();
    }

    #[test]
    fn rewrite_reactive_storage_pins_cursor_models() {
        let raw = r#"{
            "aiSettings": {
                "modelConfig": {
                    "composer": {
                        "modelName": "old-composer",
                        "maxMode": true,
                        "selectedModels": [{ "modelId": "old-composer", "parameters": [] }]
                    }
                },
                "modelOverrideEnabled": ["old"]
            },
            "featureModelConfigs": {
                "composer": {
                    "defaultModel": "old-composer",
                    "fallbackModels": ["old-composer"],
                    "bestOfNDefaultModels": ["old-composer"]
                }
            },
            "unrelated": { "keep": true }
        }"#;

        let next = rewrite_reactive_storage(raw, "stable-byok-id").unwrap();
        let value: Value = serde_json::from_str(&next).unwrap();

        assert_eq!(
            value["aiSettings"]["modelConfig"]["composer"]["modelName"],
            "stable-byok-id"
        );
        assert_eq!(
            value["aiSettings"]["modelConfig"]["composer"]["maxMode"],
            false
        );
        assert_eq!(
            value["aiSettings"]["modelConfig"]["composer"]["selectedModels"][0]["modelId"],
            "stable-byok-id"
        );
        assert_eq!(
            value["aiSettings"]["modelConfig"]["cmd-k"]["modelName"],
            "stable-byok-id"
        );
        assert_eq!(
            value["aiSettings"]["previousModelBeforeDefault"]["plan-execution"],
            "stable-byok-id"
        );
        assert_eq!(
            value["aiSettings"]["modelsWithNoDefaultSwitch"][0],
            "stable-byok-id"
        );
        assert_eq!(
            value["featureModelConfigs"]["composer"]["defaultModel"],
            "stable-byok-id"
        );
        assert_eq!(
            value["featureModelConfigs"]["composer"]["fallbackModels"][0],
            "stable-byok-id"
        );
        assert_eq!(
            value["featureModelConfigs"]["cmdK"]["bestOfNDefaultModels"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(value["unrelated"]["keep"], true);
    }

    #[test]
    fn rewrite_reactive_storage_rejects_invalid_shapes() {
        let err = rewrite_reactive_storage("[]", "stable-byok-id").unwrap_err();
        assert!(err.contains("顶层不是对象"));

        let err = rewrite_reactive_storage(r#"{"aiSettings":[]}"#, "stable-byok-id").unwrap_err();
        assert!(err.contains("字段不是对象: aiSettings"));
    }

    #[test]
    fn apply_and_restore_cursor_auth_round_trips_state_db_values() {
        let conn = memory_cursor_db();
        let backup = temp_backup_path("round-trip");
        let original_reactive =
            r#"{"aiSettings":{"modelConfig":{}},"featureModelConfigs":{},"keep":true}"#;
        put_item(&conn, REACTIVE_STORAGE_KEY, original_reactive);
        put_item(&conn, "cursorAuth/accessToken", "real-access-token");
        put_item(&conn, "cursorAuth/cachedEmail", "real@example.com");
        put_item(&conn, "unrelated", "keep-me");

        let msg = apply_cursor_auth_and_model_to_conn(&conn, "stable-byok-id", &backup).unwrap();
        assert_eq!(msg, "ok（模型 stable-byok-id）");
        assert!(backup.exists());
        assert_eq!(
            query_item(&conn, "cursorAuth/accessToken")
                .unwrap()
                .as_deref(),
            Some(FAKE_PRO_SESSION_JWT)
        );
        assert_eq!(
            query_item(&conn, "cursorAuth/refreshToken")
                .unwrap()
                .as_deref(),
            Some(FAKE_PRO_SESSION_JWT)
        );
        assert_eq!(
            query_item(&conn, "cursorAuth/cachedEmail")
                .unwrap()
                .as_deref(),
            Some(FAKE_PRO_EMAIL)
        );
        assert_eq!(
            query_item(&conn, "cursorAuth/cachedSignUpType")
                .unwrap()
                .as_deref(),
            Some("Auth")
        );
        assert_eq!(
            query_item(&conn, "cursorAuth/stripeMembershipType")
                .unwrap()
                .as_deref(),
            Some("pro")
        );
        assert_eq!(
            query_item(&conn, "unrelated").unwrap().as_deref(),
            Some("keep-me")
        );
        let pinned_raw = query_item(&conn, REACTIVE_STORAGE_KEY).unwrap().unwrap();
        let pinned: Value = serde_json::from_str(&pinned_raw).unwrap();
        assert_eq!(
            pinned["aiSettings"]["modelConfig"]["composer"]["modelName"],
            "stable-byok-id"
        );

        assert_eq!(
            restore_cursor_auth_from_backup(&conn, &backup).unwrap(),
            true
        );
        assert!(!backup.exists());
        assert_eq!(
            query_item(&conn, "cursorAuth/accessToken")
                .unwrap()
                .as_deref(),
            Some("real-access-token")
        );
        assert_eq!(
            query_item(&conn, "cursorAuth/cachedEmail")
                .unwrap()
                .as_deref(),
            Some("real@example.com")
        );
        assert_eq!(query_item(&conn, "cursorAuth/refreshToken").unwrap(), None);
        assert_eq!(
            query_item(&conn, "cursorAuth/cachedSignUpType").unwrap(),
            None
        );
        assert_eq!(
            query_item(&conn, "cursorAuth/stripeMembershipType").unwrap(),
            None
        );
        assert_eq!(
            query_item(&conn, REACTIVE_STORAGE_KEY).unwrap().as_deref(),
            Some(original_reactive)
        );
        assert_eq!(
            query_item(&conn, "unrelated").unwrap().as_deref(),
            Some("keep-me")
        );

        let _ = std::fs::remove_dir_all(backup.parent().unwrap());
    }

    #[test]
    fn backup_does_not_treat_existing_fake_cursor_auth_as_user_state() {
        let conn = memory_cursor_db();
        let backup = temp_backup_path("already-fake");
        put_item(
            &conn,
            REACTIVE_STORAGE_KEY,
            r#"{"aiSettings":{},"featureModelConfigs":{}}"#,
        );
        put_item(&conn, "cursorAuth/accessToken", FAKE_PRO_SESSION_JWT);
        put_item(&conn, "cursorAuth/refreshToken", FAKE_PRO_SESSION_JWT);

        write_backup_if_missing_at(&conn, Some("reactive".into()), &backup).unwrap();
        let raw = std::fs::read(&backup).unwrap();
        let saved: CursorStateBackup = serde_json::from_slice(&raw).unwrap();
        assert!(saved.reactive_storage.is_none());
        for key in AUTH_KEYS {
            assert_eq!(saved.auth.get(*key), Some(&None));
        }

        let _ = std::fs::remove_dir_all(backup.parent().unwrap());
    }
}
