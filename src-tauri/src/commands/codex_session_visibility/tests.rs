use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

use super::sqlite::STATE_DB_FILE;
use super::*;

fn make_temp_dir(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "{}-{}-{}",
        prefix,
        std::process::id(),
        now_epoch_millis()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn rollout_repair_updates_model_provider() {
    let data_dir = make_temp_dir("anybridge-codex-rollout-provider-test");
    fs::write(
        data_dir.join(CONFIG_FILE_NAME),
        "model_provider = \"byok\"\n",
    )
    .unwrap();
    let rollout_dir = data_dir.join("sessions").join("2026").join("06").join("18");
    fs::create_dir_all(&rollout_dir).unwrap();
    let rollout_path = rollout_dir.join("rollout-test.jsonl");
    fs::write(
        &rollout_path,
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\",\"model_provider\":\"openai\"}}\n{\"type\":\"event\"}\n",
    )
    .unwrap();

    let summary =
        repair_default_codex_session_visibility(&data_dir.join(CONFIG_FILE_NAME)).unwrap();

    assert_eq!(summary.changed_rollout_file_count, 1);
    let content = fs::read_to_string(rollout_path).unwrap();
    assert!(content.contains("\"model_provider\":\"byok\""));
    assert!(!content.contains("\"model_provider\":\"openai\""));
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn sqlite_repair_updates_provider_and_visibility_flags() {
    let data_dir = make_temp_dir("anybridge-codex-sqlite-provider-test");
    fs::write(
        data_dir.join(CONFIG_FILE_NAME),
        "model_provider = \"byok\"\n",
    )
    .unwrap();
    let db_path = data_dir.join(STATE_DB_FILE);
    let connection = Connection::open(&db_path).unwrap();
    connection
        .execute(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                model_provider TEXT,
                has_user_event INTEGER,
                first_user_message TEXT,
                thread_source TEXT
            )",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO threads (id, model_provider, has_user_event, first_user_message, thread_source)
             VALUES ('t1', 'openai', 0, 'hello', '')",
            [],
        )
        .unwrap();
    drop(connection);

    let summary =
        repair_default_codex_session_visibility(&data_dir.join(CONFIG_FILE_NAME)).unwrap();

    assert_eq!(summary.updated_sqlite_row_count, 1);
    let connection = Connection::open(&db_path).unwrap();
    let row = connection
        .query_row(
            "SELECT model_provider, has_user_event, thread_source FROM threads WHERE id = 't1'",
            [],
            |row| {
                Ok((
                    row.get::<usize, String>(0)?,
                    row.get::<usize, i64>(1)?,
                    row.get::<usize, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(row, ("byok".to_string(), 1, "user".to_string()));
    drop(connection);
    fs::remove_dir_all(data_dir).unwrap();
}
