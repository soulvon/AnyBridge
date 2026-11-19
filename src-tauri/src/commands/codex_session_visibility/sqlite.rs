use rusqlite::Connection;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::now_epoch_millis;

#[cfg(test)]
pub(super) const STATE_DB_FILE: &str = "state_5.sqlite";
#[cfg(not(test))]
const STATE_DB_FILE: &str = "state_5.sqlite";
const STATE_DB_SQLITE_DIR: &str = "sqlite";
const BACKUP_PREFIX: &str = "backup-";
const BACKUP_SUFFIX: &str = "-session-visibility-repair";
/// 最多保留几个历史备份（学 cockpit：只留 1 份，避免每次切换撑爆磁盘）。
const MAX_BACKUPS: usize = 1;

#[derive(Debug, Clone, Copy)]
struct ThreadsTableColumns {
    model_provider: bool,
    has_user_event: bool,
    first_user_message: bool,
    thread_source: bool,
}

pub(super) fn count_sqlite_rows_to_update(
    data_dir: &Path,
    target_provider: &str,
) -> Result<usize, String> {
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
            "打开会话数据库失败 ({}): {}",
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

pub(super) fn update_sqlite_provider(
    data_dir: &Path,
    target_provider: &str,
) -> Result<usize, String> {
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
            "打开会话数据库失败 ({}): {}",
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
pub(super) fn backup_sqlite_only(data_dir: &Path, _target_provider: &str) -> Result<PathBuf, String> {
    let backup_dir = data_dir.join(format!(
        "{}{}{}",
        BACKUP_PREFIX,
        now_epoch_millis(),
        BACKUP_SUFFIX
    ));
    // 同名目录已存在（同毫秒连续修复，或上次失败回滚后保留）时先清掉，
    // 避免 VACUUM INTO 因目标已存在而报错，也防止目录内旧文件混入本次备份。
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("创建备份目录失败 ({}): {}", backup_dir.display(), error))?;
    backup_sqlite_database(data_dir, &backup_dir)?;
    Ok(backup_dir)
}

/// 清理旧备份目录，只保留最近 MAX_BACKUPS 份。
pub(super) fn prune_old_backups(data_dir: &Path) {
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
pub(super) fn restore_sqlite_from_backup(data_dir: &Path, backup_dir: &Path) -> Result<(), String> {
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
                "备份前打开会话数据库失败 ({}): {}",
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
                    "备份会话数据库失败 ({} -> {}): {}",
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
            "会话数据库被占用，请退出 Codex 后重试 ({}): {}",
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
