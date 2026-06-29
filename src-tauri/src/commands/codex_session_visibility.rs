use chrono::{TimeZone, Utc};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toml_edit::DocumentMut;

const DEFAULT_PROVIDER_ID: &str = "openai";
const STATE_DB_FILE: &str = "state_5.sqlite";
const STATE_DB_SQLITE_DIR: &str = "sqlite";
const CONFIG_FILE_NAME: &str = "config.toml";
const SESSION_INDEX_FILE: &str = "session_index.jsonl";
const SESSION_DIRS: [&str; 2] = ["sessions", "archived_sessions"];
const BACKUP_PREFIX: &str = "backup-";
const BACKUP_SUFFIX: &str = "-session-visibility-repair";
/// 最多保留几个历史备份（学 cockpit：只留 1 份，避免每次切换 2G 撑爆磁盘）。
const MAX_BACKUPS: usize = 1;

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

#[derive(Debug, Clone)]
struct RolloutProviderChange {
    relative_path: PathBuf,
    absolute_path: PathBuf,
    updated_first_line: String,
}

#[derive(Debug, Clone, Copy)]
struct ThreadsTableColumns {
    model_provider: bool,
    has_user_event: bool,
    first_user_message: bool,
    thread_source: bool,
}

#[derive(Debug, Clone)]
struct SqliteThreadIndexRow {
    id: String,
    title: String,
    updated_at: Option<i64>,
}

/// 修复 Codex 历史会话可见性。
///
/// 设计参考 cockpit Quick 模式：
///   - **不改 rollout 文件**：保留各会话原始 model_provider 标记，不破坏
///     供应商间的会话隔离（旧实现把所有 rollout 改成当前 provider，导致
///     切换后用其他工具看不到历史会话）。
///   - **只修 official state db（sqlite）**：更新 model_provider 列让会话在
///     当前供应商下可见，这是 Codex 侧边栏列表的可见性来源。
///   - **备份后清理旧备份**：只保留 MAX_BACKUPS=1 份，避免每次切换 2G 撑爆磁盘。
pub fn repair_default_codex_session_visibility(
    codex_config_path: &Path,
) -> Result<CodexSessionVisibilityRepairSummary, String> {
    let data_dir = codex_config_path
        .parent()
        .ok_or_else(|| format!("无法定位 Codex 配置目录: {}", codex_config_path.display()))?;
    let target_provider = read_target_provider(data_dir)?;
    // 只修 sqlite，不修 rollout（保留会话原始 provider 标记）
    let sqlite_rows_to_update = count_sqlite_rows_to_update(data_dir, &target_provider)?;

    if sqlite_rows_to_update == 0 {
        return Ok(CodexSessionVisibilityRepairSummary {
            target_provider,
            changed_rollout_file_count: 0,
            updated_sqlite_row_count: 0,
            added_session_index_entry_count: 0,
            backup_dir: None,
            message: "历史会话可见性已正常".to_string(),
        });
    }

    // 备份 sqlite（只备份要改的 official state db，不 VACUUM 整个目录）
    let backup_dir = backup_sqlite_only(data_dir, &target_provider)?;
    // 清理旧备份，只留 MAX_BACKUPS 份
    prune_old_backups(data_dir);

    let updated_sqlite_row_count = match update_sqlite_provider(data_dir, &target_provider) {
        Ok(n) => n,
        Err(error) => {
            let restore_result = restore_sqlite_from_backup(data_dir, &backup_dir);
            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "修复 Codex 历史会话可见性失败: {}；自动回滚也失败: {}；备份目录: {}",
                    error,
                    restore_error,
                    backup_dir.display()
                ));
            }
            return Err(format!(
                "修复 Codex 历史会话可见性失败: {}；已自动回滚，备份目录: {}",
                error,
                backup_dir.display()
            ));
        }
    };

    let message = format!(
        "已恢复 {} 条历史会话的可见性",
        updated_sqlite_row_count
    );

    Ok(CodexSessionVisibilityRepairSummary {
        target_provider,
        changed_rollout_file_count: 0,
        updated_sqlite_row_count,
        added_session_index_entry_count: 0,
        backup_dir: Some(backup_dir.to_string_lossy().to_string()),
        message,
    })
}

fn repair_codex_session_visibility(
    data_dir: &Path,
    target_provider: &str,
    rollout_changes: &[RolloutProviderChange],
    update_sqlite: bool,
    reconcile_session_index: bool,
) -> Result<(usize, usize), String> {
    let updated_sqlite_rows = if update_sqlite {
        update_sqlite_provider(data_dir, target_provider)?
    } else {
        0
    };
    for change in rollout_changes {
        rewrite_rollout_provider(change)?;
    }
    let added_session_index_entries = if reconcile_session_index {
        reconcile_session_index_from_sqlite(data_dir)?
    } else {
        0
    };
    Ok((updated_sqlite_rows, added_session_index_entries))
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

fn collect_rollout_provider_changes(
    data_dir: &Path,
    target_provider: &str,
) -> Result<Vec<RolloutProviderChange>, String> {
    let mut changes = Vec::new();
    for dir_name in SESSION_DIRS {
        let root_dir = data_dir.join(dir_name);
        if !root_dir.exists() {
            continue;
        }
        for rollout_path in list_rollout_files(&root_dir)? {
            let Some((first_line, _separator)) = read_first_line(&rollout_path)? else {
                continue;
            };
            let Some(mut parsed) = parse_session_meta_record(&first_line) else {
                continue;
            };
            let current_provider = parsed["payload"]
                .get("model_provider")
                .and_then(Value::as_str)
                .unwrap_or("");
            if current_provider == target_provider {
                continue;
            }
            let Some(payload) = parsed.get_mut("payload").and_then(Value::as_object_mut) else {
                continue;
            };
            payload.insert(
                "model_provider".to_string(),
                Value::String(target_provider.to_string()),
            );
            let updated_first_line = serde_json::to_string(&parsed)
                .map_err(|error| format!("序列化 session_meta 失败: {}", error))?;
            let relative_path = rollout_path
                .strip_prefix(data_dir)
                .map_err(|_| format!("无法计算 rollout 相对路径: {}", rollout_path.display()))?
                .to_path_buf();
            changes.push(RolloutProviderChange {
                relative_path,
                absolute_path: rollout_path,
                updated_first_line,
            });
        }
    }
    changes.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(changes)
}

fn list_rollout_files(root_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut result = Vec::new();
    for entry in fs::read_dir(root_dir)
        .map_err(|error| format!("读取目录失败 ({}): {}", root_dir.display(), error))?
    {
        let entry =
            entry.map_err(|error| format!("读取目录项失败 ({}): {}", root_dir.display(), error))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取文件类型失败 ({}): {}", path.display(), error))?;
        if file_type.is_dir() {
            result.extend(list_rollout_files(&path)?);
        } else if file_type.is_file() {
            let file_name = path
                .file_name()
                .and_then(|item| item.to_str())
                .unwrap_or_default();
            if file_name.starts_with("rollout-") && file_name.ends_with(".jsonl") {
                result.push(path);
            }
        }
    }
    result.sort();
    Ok(result)
}

fn read_first_line(path: &Path) -> Result<Option<(String, String)>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("打开 rollout 文件失败 ({}): {}", path.display(), error))?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let bytes_read = reader
        .read_until(b'\n', &mut buffer)
        .map_err(|error| format!("读取 rollout 首行失败 ({}): {}", path.display(), error))?;
    if bytes_read == 0 {
        return Ok(None);
    }
    let (line_bytes, separator) = if buffer.ends_with(b"\r\n") {
        (&buffer[..buffer.len() - 2], "\r\n")
    } else if buffer.ends_with(b"\n") {
        (&buffer[..buffer.len() - 1], "\n")
    } else {
        (&buffer[..], "")
    };
    let line = String::from_utf8(line_bytes.to_vec()).map_err(|error| {
        format!(
            "解析 rollout 首行 UTF-8 失败 ({}): {}",
            path.display(),
            error
        )
    })?;
    Ok(Some((line, separator.to_string())))
}

fn parse_session_meta_record(first_line: &str) -> Option<Value> {
    if first_line.trim().is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(first_line).ok()?;
    if parsed.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    if !parsed.get("payload").is_some_and(Value::is_object) {
        return None;
    }
    Some(parsed)
}

fn read_session_index_map(root_dir: &Path) -> Result<HashMap<String, Value>, String> {
    let path = root_dir.join(SESSION_INDEX_FILE);
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "读取 session_index.jsonl 失败 ({}): {}",
            path.display(),
            error
        )
    })?;
    let mut entries = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        entries.insert(id.to_string(), entry);
    }
    Ok(entries)
}

fn count_missing_session_index_entries(data_dir: &Path) -> Result<usize, String> {
    let session_index_map = read_session_index_map(data_dir)?;
    let rows = load_sqlite_thread_index_rows(data_dir)?;
    Ok(rows
        .iter()
        .filter(|row| !session_index_map.contains_key(&row.id))
        .count())
}

fn load_sqlite_thread_index_rows(data_dir: &Path) -> Result<Vec<SqliteThreadIndexRow>, String> {
    let mut result = Vec::new();
    let mut seen_ids = HashSet::new();
    for db_path in existing_state_db_paths(data_dir) {
        let rows = load_sqlite_thread_index_rows_from_db(&db_path)?;
        for row in rows {
            if seen_ids.insert(row.id.clone()) {
                result.push(row);
            }
        }
    }
    result.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(result)
}

fn load_sqlite_thread_index_rows_from_db(
    db_path: &Path,
) -> Result<Vec<SqliteThreadIndexRow>, String> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open(&db_path).map_err(|error| {
        format!(
            "打开 state_5.sqlite 失败 ({}): {}",
            db_path.display(),
            error
        )
    })?;
    let names = read_table_column_names(&connection)?;
    if !names.contains("id") {
        return Ok(Vec::new());
    }
    let title_expr = if names.contains("title") {
        "COALESCE(title, '')"
    } else {
        "''"
    };
    let updated_at_expr = if names.contains("updated_at") {
        "updated_at"
    } else {
        "NULL"
    };
    let order_expr = if names.contains("updated_at") {
        "updated_at DESC"
    } else {
        "id ASC"
    };
    let sql =
        format!("SELECT id, {title_expr}, {updated_at_expr} FROM threads ORDER BY {order_expr}");
    let mut statement = connection.prepare(&sql).map_err(|error| {
        format!(
            "准备 SQLite 会话索引查询失败 ({}): {}",
            db_path.display(),
            error
        )
    })?;
    let mapped = statement
        .query_map([], |row| {
            Ok(SqliteThreadIndexRow {
                id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|error| {
            format!(
                "查询 SQLite 会话索引行失败 ({}): {}",
                db_path.display(),
                error
            )
        })?;
    let mut result = Vec::new();
    for row in mapped {
        result.push(row.map_err(|error| {
            format!(
                "读取 SQLite 会话索引行失败 ({}): {}",
                db_path.display(),
                error
            )
        })?);
    }
    Ok(result)
}

fn reconcile_session_index_from_sqlite(data_dir: &Path) -> Result<usize, String> {
    let session_index_map = read_session_index_map(data_dir)?;
    let rows = load_sqlite_thread_index_rows(data_dir)?;
    let missing_rows: Vec<&SqliteThreadIndexRow> = rows
        .iter()
        .filter(|row| !session_index_map.contains_key(&row.id))
        .collect();
    if missing_rows.is_empty() {
        return Ok(0);
    }

    let path = data_dir.join(SESSION_INDEX_FILE);
    let mut lines = if path.exists() {
        fs::read_to_string(&path)
            .map_err(|error| {
                format!(
                    "读取 session_index.jsonl 失败 ({}): {}",
                    path.display(),
                    error
                )
            })?
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    for row in &missing_rows {
        let line = serde_json::to_string(&json!({
            "id": row.id,
            "thread_name": if row.title.trim().is_empty() { "Untitled" } else { row.title.as_str() },
            "updated_at": format_thread_updated_at_iso(row.updated_at),
        }))
        .map_err(|error| format!("序列化 session_index 条目失败: {}", error))?;
        lines.push(line);
    }
    let mut output = lines.join("\n");
    output.push('\n');
    write_bytes_atomic(&path, output.as_bytes())?;
    Ok(missing_rows.len())
}

fn format_thread_updated_at_iso(updated_at: Option<i64>) -> String {
    let seconds = updated_at.unwrap_or_else(now_epoch_secs);
    Utc.timestamp_opt(seconds, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
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
    let connection = Connection::open(&db_path).map_err(|error| {
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
    let mut connection = Connection::open(&db_path).map_err(|error| {
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
        .map_err(|error| format_sqlite_write_error(&db_path, &error))?;
    let sql = format!("UPDATE threads SET {set_clause} WHERE {where_clause}");
    let updated_rows = if columns.model_provider {
        transaction.execute(&sql, [target_provider])
    } else {
        transaction.execute(&sql, [])
    }
    .map_err(|error| format_sqlite_write_error(&db_path, &error))?;
    transaction
        .commit()
        .map_err(|error| format_sqlite_write_error(&db_path, &error))?;
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

fn rewrite_rollout_provider(change: &RolloutProviderChange) -> Result<(), String> {
    let original_modified_at = read_modified_time(&change.absolute_path);
    let bytes = fs::read(&change.absolute_path).map_err(|error| {
        format!(
            "读取 rollout 文件失败 ({}): {}",
            change.absolute_path.display(),
            error
        )
    })?;
    let (offset, separator) = detect_first_line_boundary(&bytes);
    let mut next_bytes = Vec::with_capacity(change.updated_first_line.len() + bytes.len());
    next_bytes.extend_from_slice(change.updated_first_line.as_bytes());
    next_bytes.extend_from_slice(separator.as_bytes());
    next_bytes.extend_from_slice(&bytes[offset..]);
    write_bytes_atomic(&change.absolute_path, &next_bytes)?;
    restore_modified_time(&change.absolute_path, original_modified_at)
}

fn detect_first_line_boundary(bytes: &[u8]) -> (usize, &'static str) {
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                return (index + 1, "\r\n");
            }
            return (index + 1, "\n");
        }
    }
    (bytes.len(), "")
}

fn write_bytes_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败 ({}): {}", parent.display(), error))?;
    }
    let temp_path = path.with_extension(format!(
        "session-visibility-tmp-{}-{}",
        std::process::id(),
        now_epoch_millis()
    ));
    fs::write(&temp_path, content)
        .map_err(|error| format!("写入临时文件失败 ({}): {}", temp_path.display(), error))?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("替换文件失败 ({}): {}", path.display(), error));
    }
    Ok(())
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

/// 只备份 sqlite（official state db），不备份 rollout/session_index。
/// rollout 不再修改，无需备份；session_index 不再补写，也无需备份。
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
/// 学 cockpit 的 prune_session_visibility_repair_backups。
fn prune_old_backups(data_dir: &Path) {
    let entries = match fs::read_dir(data_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut backups: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() { continue }
        let file_name = entry.file_name();
        let name = match file_name.to_str() { Some(n) => n.to_string(), None => continue };
        // 匹配 backup-{timestamp}-session-visibility-repair
        if !name.starts_with(BACKUP_PREFIX) || !name.ends_with(BACKUP_SUFFIX) { continue }
        let timestamp = &name[BACKUP_PREFIX.len()..name.len() - BACKUP_SUFFIX.len()];
        backups.push((timestamp.to_string(), entry.path()));
    }
    if backups.len() <= MAX_BACKUPS { return }
    // 按 timestamp 降序，保留前 MAX_BACKUPS 份，删旧的
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in backups.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_dir_all(&path);
    }
}

/// 从备份恢复 sqlite（修复失败时回滚用）。
fn restore_sqlite_from_backup(data_dir: &Path, backup_dir: &Path) -> Result<(), String> {
    for relative_path in existing_state_db_relative_paths(data_dir) {
        let backup_db = backup_dir.join("files").join(&relative_path);
        if !backup_db.exists() { continue }
        let target = data_dir.join(&relative_path);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(&backup_db, &target).map_err(|error| {
            format!("恢复 SQLite 失败 ({} -> {}): {}", backup_db.display(), target.display(), error)
        })?;
    }
    Ok(())
}

fn backup_codex_session_visibility_files(
    data_dir: &Path,
    rollout_changes: &[RolloutProviderChange],
    include_sqlite: bool,
    include_session_index: bool,
    target_provider: &str,
) -> Result<PathBuf, String> {
    let backup_dir = data_dir.join(format!(
        "{}{}{}",
        BACKUP_PREFIX,
        now_epoch_millis(),
        BACKUP_SUFFIX
    ));
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("创建备份目录失败 ({}): {}", backup_dir.display(), error))?;

    let mut backed_up_files = Vec::new();
    for change in rollout_changes {
        let target = backup_dir.join("files").join(&change.relative_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "创建 rollout 备份目录失败 ({}): {}",
                    parent.display(),
                    error
                )
            })?;
        }
        fs::copy(&change.absolute_path, &target).map_err(|error| {
            format!(
                "备份 rollout 文件失败 ({} -> {}): {}",
                change.absolute_path.display(),
                target.display(),
                error
            )
        })?;
        restore_modified_time(&target, read_modified_time(&change.absolute_path))?;
        backed_up_files.push(change.relative_path.to_string_lossy().to_string());
    }

    let sqlite_backup_created = if include_sqlite {
        backup_sqlite_database(data_dir, &backup_dir)?
    } else {
        false
    };
    let mut session_index_backup_created = false;
    if include_session_index {
        let source = data_dir.join(SESSION_INDEX_FILE);
        if source.exists() {
            let target = backup_dir.join("files").join(SESSION_INDEX_FILE);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "创建 session_index 备份目录失败 ({}): {}",
                        parent.display(),
                        error
                    )
                })?;
            }
            fs::copy(&source, &target).map_err(|error| {
                format!(
                    "备份 session_index.jsonl 失败 ({} -> {}): {}",
                    source.display(),
                    target.display(),
                    error
                )
            })?;
            session_index_backup_created = true;
        }
    }

    let manifest = json!({
        "instanceRoot": data_dir,
        "targetProvider": target_provider,
        "createdAt": now_epoch_secs(),
        "hasSqliteBackup": sqlite_backup_created,
        "hasSessionIndexBackup": session_index_backup_created,
        "rolloutFiles": backed_up_files,
    });
    fs::write(
        backup_dir.join("manifest.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest)
                .map_err(|error| format!("序列化可见性修复备份清单失败: {}", error))?
        ),
    )
    .map_err(|error| {
        format!(
            "写入可见性修复备份清单失败 ({}): {}",
            backup_dir.display(),
            error
        )
    })?;
    Ok(backup_dir)
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

fn restore_codex_session_visibility_backup(
    data_dir: &Path,
    backup_dir: &Path,
    include_sqlite: bool,
) -> Result<(), String> {
    if include_sqlite {
        remove_backed_up_sqlite_sidecars(data_dir, backup_dir)?;
    }
    let files_root = backup_dir.join("files");
    if files_root.exists() {
        restore_directory_contents(&files_root, data_dir)?;
    }
    if include_sqlite {
        remove_backed_up_sqlite_sidecars(data_dir, backup_dir)?;
    }
    Ok(())
}

fn remove_backed_up_sqlite_sidecars(data_dir: &Path, backup_dir: &Path) -> Result<(), String> {
    let files_root = backup_dir.join("files");
    for relative_path in state_db_relative_paths() {
        if files_root.join(&relative_path).exists() {
            remove_sqlite_sidecar_files(&data_dir.join(relative_path))?;
        }
    }
    Ok(())
}

fn restore_directory_contents(source_root: &Path, target_root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source_root)
        .map_err(|error| format!("读取备份目录失败 ({}): {}", source_root.display(), error))?
    {
        let entry = entry.map_err(|error| {
            format!("读取备份目录项失败 ({}): {}", source_root.display(), error)
        })?;
        let source_path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "读取备份文件类型失败 ({}): {}",
                source_path.display(),
                error
            )
        })?;
        let relative = source_path
            .strip_prefix(source_root)
            .map_err(|_| format!("无法计算备份相对路径: {}", source_path.display()))?;
        let target_path = target_root.join(relative);
        if file_type.is_dir() {
            fs::create_dir_all(&target_path).map_err(|error| {
                format!("创建恢复目录失败 ({}): {}", target_path.display(), error)
            })?;
            restore_directory_contents(&source_path, &target_path)?;
            continue;
        }
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建恢复父目录失败 ({}): {}", parent.display(), error))?;
        }
        fs::copy(&source_path, &target_path).map_err(|error| {
            format!(
                "恢复备份文件失败 ({} -> {}): {}",
                source_path.display(),
                target_path.display(),
                error
            )
        })?;
        restore_modified_time(&target_path, read_modified_time(&source_path))?;
    }
    Ok(())
}

fn sqlite_sidecar_paths(db_path: &Path) -> Vec<PathBuf> {
    let raw = db_path.to_string_lossy();
    vec![
        PathBuf::from(format!("{}-wal", raw)),
        PathBuf::from(format!("{}-shm", raw)),
    ]
}

fn remove_sqlite_sidecar_files(db_path: &Path) -> Result<(), String> {
    for path in sqlite_sidecar_paths(db_path) {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "清理 SQLite sidecar 文件失败 ({}): {}",
                    path.display(),
                    error
                ));
            }
        }
    }
    Ok(())
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

fn read_modified_time(path: &Path) -> Option<SystemTime> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

fn restore_modified_time(path: &Path, modified_at: Option<SystemTime>) -> Result<(), String> {
    let Some(modified_at) = modified_at else {
        return Ok(());
    };
    let file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| format!("打开文件以恢复修改时间失败 ({}): {}", path.display(), error))?;
    file.set_modified(modified_at)
        .map_err(|error| format!("恢复文件修改时间失败 ({}): {}", path.display(), error))
}

fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
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
        fs::remove_dir_all(data_dir).unwrap();
    }
}
