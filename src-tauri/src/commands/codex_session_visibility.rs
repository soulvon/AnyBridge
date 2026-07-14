use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toml_edit::DocumentMut;

const DEFAULT_PROVIDER_ID: &str = "openai";
const STATE_DB_FILE: &str = "state_5.sqlite";
const STATE_DB_SQLITE_DIR: &str = "sqlite";
const CONFIG_FILE_NAME: &str = "config.toml";
const BACKUP_PREFIX: &str = "backup-";
const BACKUP_SUFFIX: &str = "-session-visibility-repair";
/// 最多保留几个历史备份（学 cockpit：只留 1 份，避免每次切换撑爆磁盘）。
const MAX_BACKUPS: usize = 1;
const SESSION_DIR_NAMES: [&str; 2] = ["sessions", "archived_sessions"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionVisibilityRepairSummary {
    pub target_provider: String,
    pub changed_rollout_file_count: usize,
    pub updated_sqlite_row_count: usize,
    pub added_session_index_entry_count: usize,
    pub backup_dir: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
struct ThreadsTableColumns {
    model_provider: bool,
    has_user_event: bool,
    first_user_message: bool,
    thread_source: bool,
}

/// 修复 Codex 历史会话可见性。
///
/// Codex Desktop 侧边栏按 `threads.model_provider == config.model_provider` 过滤。
/// 仅改 sqlite 不够：重启后 Codex 会从 rollout 的 `session_meta.model_provider`
/// 重新索引，把 sqlite 写回旧 provider（常见为 `openai`），历史再次消失。
///
/// 因此本修复会：
///   - 改 rollout / archived_sessions 中的 model_provider 元数据
///   - 改 official state db（sqlite）的 threads.model_provider 与可见性字段
///   - 备份 sqlite；失败时回滚 sqlite
pub fn repair_default_codex_session_visibility(
    codex_config_path: &Path,
) -> Result<CodexSessionVisibilityRepairSummary, String> {
    let data_dir = codex_config_path
        .parent()
        .ok_or_else(|| format!("无法定位 Codex 配置目录: {}", codex_config_path.display()))?;
    let target_provider = read_target_provider(data_dir)?;
    let sqlite_rows_to_update = count_sqlite_rows_to_update(data_dir, &target_provider)?;
    let rollout_files_to_update = count_rollout_files_to_update(data_dir, &target_provider)?;

    if sqlite_rows_to_update == 0 && rollout_files_to_update == 0 {
        return Ok(CodexSessionVisibilityRepairSummary {
            target_provider,
            changed_rollout_file_count: 0,
            updated_sqlite_row_count: 0,
            added_session_index_entry_count: 0,
            backup_dir: None,
            message: "历史会话可见性已正常".to_string(),
        });
    }

    let backup_dir = backup_sqlite_only(data_dir, &target_provider)?;
    prune_old_backups(data_dir);

    let changed_rollout_file_count = match update_rollout_providers(data_dir, &target_provider) {
        Ok(n) => n,
        Err(error) => {
            let restore_result = restore_sqlite_from_backup(data_dir, &backup_dir);
            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "修复 Codex 历史会话可见性失败（rollout）: {}；自动回滚也失败: {}；备份目录: {}",
                    error,
                    restore_error,
                    backup_dir.display()
                ));
            }
            return Err(format!(
                "修复 Codex 历史会话可见性失败（rollout）: {}；已自动回滚 sqlite，备份目录: {}",
                error,
                backup_dir.display()
            ));
        }
    };

    let updated_sqlite_row_count = match update_sqlite_provider(data_dir, &target_provider) {
        Ok(n) => n,
        Err(error) => {
            let restore_result = restore_sqlite_from_backup(data_dir, &backup_dir);
            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "修复 Codex 历史会话可见性失败（sqlite）: {}；自动回滚也失败: {}；备份目录: {}",
                    error,
                    restore_error,
                    backup_dir.display()
                ));
            }
            return Err(format!(
                "修复 Codex 历史会话可见性失败（sqlite）: {}；已自动回滚，备份目录: {}",
                error,
                backup_dir.display()
            ));
        }
    };

    let message = format!(
        "已恢复历史会话可见性（sqlite {} 条，rollout {} 个文件）",
        updated_sqlite_row_count, changed_rollout_file_count
    );

    Ok(CodexSessionVisibilityRepairSummary {
        target_provider,
        changed_rollout_file_count,
        updated_sqlite_row_count,
        added_session_index_entry_count: 0,
        backup_dir: Some(backup_dir.to_string_lossy().to_string()),
        message,
    })
}

fn read_target_provider(data_dir: &Path) -> Result<String, String> {
    let config_path = data_dir.join(CONFIG_FILE_NAME);
    if !config_path.exists() {
        return Ok(DEFAULT_PROVIDER_ID.to_string());
    }
    let raw = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "读取 config.toml 失败 ({}): {}",
            config_path.display(),
            error
        )
    })?;
    if raw.trim().is_empty() {
        return Ok(DEFAULT_PROVIDER_ID.to_string());
    }
    let doc = raw.parse::<DocumentMut>().map_err(|error| {
        format!(
            "解析 config.toml 失败 ({}): {}",
            config_path.display(),
            error
        )
    })?;
    Ok(doc
        .get("model_provider")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROVIDER_ID)
        .to_string())
}

fn count_sqlite_rows_to_update(data_dir: &Path, target_provider: &str) -> Result<usize, String> {
    let mut total = 0usize;
    for db_path in existing_state_db_paths(data_dir) {
        total += count_sqlite_rows_to_update_in_db(&db_path, target_provider)?;
    }
    Ok(total)
}

fn count_sqlite_rows_to_update_in_db(
    db_path: &Path,
    target_provider: &str,
) -> Result<usize, String> {
    if !db_path.exists() {
        return Ok(0);
    }
    let connection = Connection::open(db_path).map_err(|error| {
        format!(
            "打开 state_5.sqlite 失败 ({}): {}",
            db_path.display(),
            error
        )
    })?;
    let Some(columns) = read_threads_table_columns(&connection)? else {
        return Ok(0);
    };
    let Some(where_clause) = build_threads_repair_where_clause(columns) else {
        return Ok(0);
    };
    let sql = format!("SELECT COUNT(*) FROM threads WHERE {where_clause}");
    let count = if columns.model_provider {
        connection.query_row(&sql, [target_provider], |row| row.get::<usize, i64>(0))
    } else {
        connection.query_row(&sql, [], |row| row.get::<usize, i64>(0))
    }
    .map_err(|error| {
        format!(
            "统计 SQLite 会话可见性差异失败 ({}): {}",
            db_path.display(),
            error
        )
    })?;
    Ok(count.max(0) as usize)
}

fn update_sqlite_provider(data_dir: &Path, target_provider: &str) -> Result<usize, String> {
    let mut total = 0usize;
    for db_path in existing_state_db_paths(data_dir) {
        total += update_sqlite_provider_in_db(&db_path, target_provider)?;
    }
    Ok(total)
}

fn update_sqlite_provider_in_db(db_path: &Path, target_provider: &str) -> Result<usize, String> {
    if !db_path.exists() {
        return Ok(0);
    }
    let mut connection = Connection::open(db_path).map_err(|error| {
        format!(
            "打开 state_5.sqlite 失败 ({}): {}",
            db_path.display(),
            error
        )
    })?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|error| {
            format!(
                "设置 SQLite busy_timeout 失败 ({}): {}",
                db_path.display(),
                error
            )
        })?;
    let Some(columns) = read_threads_table_columns(&connection)? else {
        return Ok(0);
    };
    let Some(where_clause) = build_threads_repair_where_clause(columns) else {
        return Ok(0);
    };
    let set_clause = build_threads_repair_set_clause(columns);
    let transaction = connection
        .transaction()
        .map_err(|error| format_sqlite_write_error(db_path, &error))?;
    let sql = format!("UPDATE threads SET {set_clause} WHERE {where_clause}");
    let updated_rows = if columns.model_provider {
        transaction.execute(&sql, [target_provider])
    } else {
        transaction.execute(&sql, [])
    }
    .map_err(|error| format_sqlite_write_error(db_path, &error))?;
    transaction
        .commit()
        .map_err(|error| format_sqlite_write_error(db_path, &error))?;
    Ok(updated_rows)
}

fn count_rollout_files_to_update(data_dir: &Path, target_provider: &str) -> Result<usize, String> {
    let mut total = 0usize;
    for path in iter_rollout_files(data_dir)? {
        if rollout_file_needs_provider_update(&path, target_provider)? {
            total += 1;
        }
    }
    Ok(total)
}

fn update_rollout_providers(data_dir: &Path, target_provider: &str) -> Result<usize, String> {
    let mut changed = 0usize;
    for path in iter_rollout_files(data_dir)? {
        if update_rollout_file_provider(&path, target_provider)? {
            changed += 1;
        }
    }
    Ok(changed)
}

fn iter_rollout_files(data_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for dir_name in SESSION_DIR_NAMES {
        let root = data_dir.join(dir_name);
        if !root.exists() {
            continue;
        }
        collect_jsonl_files(&root, &mut files)?;
    }
    Ok(files)
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|error| format!("读取会话目录失败 ({}): {}", dir.display(), error))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("读取会话目录条目失败 ({}): {}", dir.display(), error))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取会话文件类型失败 ({}): {}", path.display(), error))?;
        if file_type.is_dir() {
            collect_jsonl_files(&path, out)?;
            continue;
        }
        if file_type.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        {
            out.push(path);
        }
    }
    Ok(())
}

fn rollout_file_needs_provider_update(path: &Path, target_provider: &str) -> Result<bool, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("打开 rollout 失败 ({}): {}", path.display(), error))?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line =
            line.map_err(|error| format!("读取 rollout 失败 ({}): {}", path.display(), error))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<JsonValue>(trimmed) else {
            continue;
        };
        if patch_json_model_provider(&mut value, target_provider) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn update_rollout_file_provider(path: &Path, target_provider: &str) -> Result<bool, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("打开 rollout 失败 ({}): {}", path.display(), error))?;
    let reader = BufReader::new(file);
    let mut rewritten_lines = Vec::new();
    let mut changed = false;

    for line in reader.lines() {
        let line =
            line.map_err(|error| format!("读取 rollout 失败 ({}): {}", path.display(), error))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            rewritten_lines.push(String::new());
            continue;
        }
        match serde_json::from_str::<JsonValue>(trimmed) {
            Ok(mut value) => {
                if patch_json_model_provider(&mut value, target_provider) {
                    changed = true;
                    rewritten_lines.push(
                        serde_json::to_string(&value).map_err(|error| {
                            format!("序列化 rollout 失败 ({}): {}", path.display(), error)
                        })?,
                    );
                } else {
                    rewritten_lines.push(trimmed.to_string());
                }
            }
            Err(_) => rewritten_lines.push(line),
        }
    }

    if !changed {
        return Ok(false);
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("rollout.jsonl"),
        now_epoch_millis()
    ));
    {
        let mut out = fs::File::create(&temp_path).map_err(|error| {
            format!(
                "创建临时 rollout 失败 ({}): {}",
                temp_path.display(),
                error
            )
        })?;
        for (idx, line) in rewritten_lines.iter().enumerate() {
            if idx > 0 {
                out.write_all(b"\n").map_err(|error| {
                    format!("写入临时 rollout 失败 ({}): {}", temp_path.display(), error)
                })?;
            }
            out.write_all(line.as_bytes()).map_err(|error| {
                format!("写入临时 rollout 失败 ({}): {}", temp_path.display(), error)
            })?;
        }
        if !rewritten_lines.is_empty() {
            out.write_all(b"\n").map_err(|error| {
                format!("写入临时 rollout 失败 ({}): {}", temp_path.display(), error)
            })?;
        }
        out.sync_all().map_err(|error| {
            format!("同步临时 rollout 失败 ({}): {}", temp_path.display(), error)
        })?;
    }

    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "替换 rollout 失败 ({} -> {}): {}",
            temp_path.display(),
            path.display(),
            error
        )
    })?;
    Ok(true)
}

/// 递归改写 JSON 中所有 string 类型的 `model_provider` 字段。
fn patch_json_model_provider(value: &mut JsonValue, target_provider: &str) -> bool {
    match value {
        JsonValue::Object(map) => {
            let mut changed = false;
            if let Some(JsonValue::String(existing)) = map.get("model_provider") {
                if existing != target_provider {
                    map.insert(
                        "model_provider".to_string(),
                        JsonValue::String(target_provider.to_string()),
                    );
                    changed = true;
                }
            }
            for nested in map.values_mut() {
                if patch_json_model_provider(nested, target_provider) {
                    changed = true;
                }
            }
            changed
        }
        JsonValue::Array(items) => {
            let mut changed = false;
            for item in items {
                if patch_json_model_provider(item, target_provider) {
                    changed = true;
                }
            }
            changed
        }
        _ => false,
    }
}

fn read_table_column_names(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = match connection.prepare("PRAGMA table_info(threads)") {
        Ok(statement) => statement,
        Err(error) if is_missing_threads_table_error(&error) => return Ok(HashSet::new()),
        Err(error) => return Err(format!("读取 SQLite threads 表结构失败: {}", error)),
    };
    let rows = statement
        .query_map([], |row| row.get::<usize, String>(1))
        .map_err(|error| format!("读取 SQLite threads 表结构失败: {}", error))?;
    let mut names = HashSet::new();
    for row in rows {
        names.insert(row.map_err(|error| format!("读取 SQLite threads 表结构失败: {}", error))?);
    }
    Ok(names)
}

fn read_threads_table_columns(
    connection: &Connection,
) -> Result<Option<ThreadsTableColumns>, String> {
    let names = read_table_column_names(connection)?;
    if names.is_empty() {
        return Ok(None);
    }
    Ok(Some(ThreadsTableColumns {
        model_provider: names.contains("model_provider"),
        has_user_event: names.contains("has_user_event"),
        first_user_message: names.contains("first_user_message"),
        thread_source: names.contains("thread_source"),
    }))
}

fn build_threads_repair_where_clause(columns: ThreadsTableColumns) -> Option<String> {
    let mut predicates = Vec::new();
    if columns.model_provider {
        predicates.push("COALESCE(model_provider, '') <> ?1");
    }
    if columns.has_user_event && columns.first_user_message {
        predicates
            .push("(COALESCE(first_user_message, '') <> '' AND COALESCE(has_user_event, 0) <> 1)");
    }
    if columns.thread_source && columns.first_user_message {
        predicates
            .push("(COALESCE(first_user_message, '') <> '' AND COALESCE(thread_source, '') = '')");
    }
    if predicates.is_empty() {
        None
    } else {
        Some(predicates.join(" OR "))
    }
}

fn build_threads_repair_set_clause(columns: ThreadsTableColumns) -> String {
    let mut assignments = Vec::new();
    if columns.model_provider {
        assignments.push("model_provider = ?1");
    }
    if columns.has_user_event && columns.first_user_message {
        assignments.push(
            "has_user_event = CASE WHEN COALESCE(first_user_message, '') <> '' THEN 1 ELSE has_user_event END",
        );
    }
    if columns.thread_source && columns.first_user_message {
        assignments.push(
            "thread_source = CASE WHEN COALESCE(thread_source, '') = '' AND COALESCE(first_user_message, '') <> '' THEN 'user' ELSE thread_source END",
        );
    }
    assignments.join(", ")
}

fn state_db_relative_paths() -> [PathBuf; 2] {
    [
        PathBuf::from(STATE_DB_FILE),
        PathBuf::from(STATE_DB_SQLITE_DIR).join(STATE_DB_FILE),
    ]
}

fn existing_state_db_relative_paths(data_dir: &Path) -> Vec<PathBuf> {
    state_db_relative_paths()
        .into_iter()
        .filter(|relative_path| data_dir.join(relative_path).exists())
        .collect()
}

fn existing_state_db_paths(data_dir: &Path) -> Vec<PathBuf> {
    existing_state_db_relative_paths(data_dir)
        .into_iter()
        .map(|relative_path| data_dir.join(relative_path))
        .collect()
}

/// 只备份 sqlite（official state db）。
fn backup_sqlite_only(data_dir: &Path, _target_provider: &str) -> Result<PathBuf, String> {
    let backup_dir = data_dir.join(format!(
        "{}{}{}",
        BACKUP_PREFIX,
        now_epoch_millis(),
        BACKUP_SUFFIX
    ));
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("创建备份目录失败 ({}): {}", backup_dir.display(), error))?;
    backup_sqlite_database(data_dir, &backup_dir)?;
    Ok(backup_dir)
}

/// 清理旧备份目录，只保留最近 MAX_BACKUPS 份。
fn prune_old_backups(data_dir: &Path) {
    let entries = match fs::read_dir(data_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut backups: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let file_name = entry.file_name();
        let name = match file_name.to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.starts_with(BACKUP_PREFIX) || !name.ends_with(BACKUP_SUFFIX) {
            continue;
        }
        let timestamp = &name[BACKUP_PREFIX.len()..name.len() - BACKUP_SUFFIX.len()];
        backups.push((timestamp.to_string(), entry.path()));
    }
    if backups.len() <= MAX_BACKUPS {
        return;
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in backups.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_dir_all(&path);
    }
}

/// 从备份恢复 sqlite（修复失败时回滚用）。
fn restore_sqlite_from_backup(data_dir: &Path, backup_dir: &Path) -> Result<(), String> {
    for relative_path in existing_state_db_relative_paths(data_dir) {
        let backup_db = backup_dir.join("files").join(&relative_path);
        if !backup_db.exists() {
            continue;
        }
        let target = data_dir.join(&relative_path);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(&backup_db, &target).map_err(|error| {
            format!(
                "恢复 SQLite 失败 ({} -> {}): {}",
                backup_db.display(),
                target.display(),
                error
            )
        })?;
    }
    Ok(())
}

fn backup_sqlite_database(data_dir: &Path, backup_dir: &Path) -> Result<bool, String> {
    let relative_paths = existing_state_db_relative_paths(data_dir);
    if relative_paths.is_empty() {
        return Ok(false);
    }
    for relative_path in relative_paths {
        let db_path = data_dir.join(&relative_path);
        let backup_db_path = backup_dir.join("files").join(&relative_path);
        if let Some(parent) = backup_db_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建 SQLite 备份目录失败 ({}): {}", parent.display(), error)
            })?;
        }
        let connection = Connection::open(&db_path).map_err(|error| {
            format!(
                "打开 state_5.sqlite 以创建一致备份失败 ({}): {}",
                db_path.display(),
                error
            )
        })?;
        connection
            .busy_timeout(Duration::from_secs(3))
            .map_err(|error| {
                format!(
                    "设置 SQLite 备份 busy_timeout 失败 ({}): {}",
                    db_path.display(),
                    error
                )
            })?;
        let backup_target = backup_db_path.to_string_lossy().to_string();
        connection
            .execute("VACUUM main INTO ?1", [backup_target.as_str()])
            .map_err(|error| {
                format!(
                    "备份 state_5.sqlite 失败 ({} -> {}): {}",
                    db_path.display(),
                    backup_db_path.display(),
                    error
                )
            })?;
    }
    Ok(true)
}

fn is_missing_threads_table_error(error: &rusqlite::Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("no such table: threads")
}

fn format_sqlite_write_error(path: &Path, error: &rusqlite::Error) -> String {
    let message = error.to_string();
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("database is locked") || lowered.contains("database busy") {
        return format!(
            "state_5.sqlite 当前被占用，请关闭 Codex / Codex App 后重试 ({}): {}",
            path.display(),
            message
        );
    }
    format!(
        "更新 SQLite 会话可见性失败 ({}): {}",
        path.display(),
        message
    )
}

fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
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
}
