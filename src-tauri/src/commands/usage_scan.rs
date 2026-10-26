// usage_scan.rs — 旁路用量统计（读 agent 自己落盘的会话文件，不依赖网关）。
//
// 为什么需要：走网关的流量由 sidecar 账本统计；配置式直连的客户端（以及网关
// 未启动的时段）不经过网关，只能读客户端自己写的会话日志。这与 ccusage 类工具
// 同一思路：统计器只读文件，不注入、不挂代理，开关不影响客户端使用。
//
// 当前支持：Claude Code（~/.claude/projects/**/*.jsonl，assistant 行带 usage）。
// 增量：按文件记录 byte offset，只解析新增行；文件变小视为被截断，重置 offset 重扫。
// 落盘：<config>/usage-local.json（与 stats.json 分离，互不覆盖）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const INDEX_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceUsage {
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub offset: u64,
    pub mtime_ms: u64,
}

/// CPA 账号维度用量（来自 CLIProxyAPI 套件的 usage.sqlite，只读）。
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpaAccountUsage {
    pub account: String,
    pub provider: String,
    pub requests: u64,
    pub failed: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageIndex {
    pub version: u32,
    pub scanned_at: u64,
    /// day -> model -> usage（文件型来源：claude-code / codex）
    pub days: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// day -> model -> usage（Cursor，来自 cursor-core.db，每次全量重算）
    #[serde(default)]
    pub cursor_days: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// day -> model -> usage（CPA / CLIProxyAPI 套件，按账号日聚合表推导）
    #[serde(default)]
    pub cpa_days: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// CPA 账号维度汇总（全量重算，按消耗排序）
    #[serde(default)]
    pub cpa_accounts: Vec<CpaAccountUsage>,
    /// source id (claude-code / codex / cursor / cpa) -> usage
    pub sources: BTreeMap<String, SourceUsage>,
    /// 文件路径 -> 已读偏移
    pub files: BTreeMap<String, FileState>,
    /// 本轮扫描的问题（读失败/解析失败计数），不静默吞掉
    pub errors: Vec<String>,
}

impl Default for LocalUsageIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            scanned_at: 0,
            days: BTreeMap::new(),
            cursor_days: BTreeMap::new(),
            cpa_days: BTreeMap::new(),
            cpa_accounts: Vec::new(),
            sources: BTreeMap::new(),
            files: BTreeMap::new(),
            errors: Vec::new(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn index_path() -> PathBuf {
    crate::commands::config::config_dir_path().join("usage-local.json")
}

/// 读取已持久化的旁路索引（不存在时返回空索引，而不是报错）。
pub fn load_index() -> LocalUsageIndex {
    let path = index_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return LocalUsageIndex::default();
    };
    match serde_json::from_str::<LocalUsageIndex>(&text) {
        Ok(index) => index,
        Err(e) => {
            // 解析失败：保留原文件不覆盖，返回空索引并记录原因（下次扫描会重建）。
            let mut empty = LocalUsageIndex::default();
            empty.errors.push(format!("usage-local.json 解析失败: {e}"));
            empty
        }
    }
}

fn save_index(index: &LocalUsageIndex) -> Result<(), String> {
    let path = index_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(index).map_err(|e| format!("序列化失败: {e}"))?;
    crate::commands::write_atomic(&path, text.as_bytes()).map_err(|e| format!("写入失败: {e}"))
}

fn day_key(timestamp: &str) -> Option<String> {
    // Claude 的 timestamp 是 ISO8601（2026-09-26T20:37:01.841Z），前 10 位即日期。
    let day = timestamp.get(0..10)?;
    if day.len() == 10 && day.as_bytes()[4] == b'-' {
        Some(day.to_string())
    } else {
        None
    }
}

fn num(value: Option<&serde_json::Value>) -> u64 {
    value.and_then(|v| v.as_u64()).unwrap_or(0)
}

fn accumulate(index: &mut LocalUsageIndex, source: &str, day: &str, model: &str, usage: ModelUsage) {
    let entry = index
        .days
        .entry(day.to_string())
        .or_default()
        .entry(model.to_string())
        .or_default();
    entry.requests += usage.requests;
    entry.input += usage.input;
    entry.output += usage.output;
    entry.cache_read += usage.cache_read;
    entry.cache_write += usage.cache_write;

    let src = index.sources.entry(source.to_string()).or_default();
    src.requests += usage.requests;
    src.input += usage.input;
    src.output += usage.output;
    src.cache_read += usage.cache_read;
    src.cache_write += usage.cache_write;
}

/// 解析一行 Claude Code 会话记录，命中 assistant usage 时返回 (day, model, usage)。
pub fn parse_claude_line(line: &str) -> Option<(String, String, ModelUsage)> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let model = message
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let day = day_key(value.get("timestamp")?.as_str()?)?;

    let input = num(usage.get("input_tokens"));
    let output = num(usage.get("output_tokens"));
    let cache_read = num(usage.get("cache_read_input_tokens"));
    let cache_write = num(usage.get("cache_creation_input_tokens"));
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        // 全 0 的 usage 行（本地合成消息）不计入，避免 requests 虚增。
        return None;
    }
    Some((
        day,
        model,
        ModelUsage {
            requests: 1,
            input,
            output,
            cache_read,
            cache_write,
        },
    ))
}

/// 增量扫描单文件：从 offset 读到文件尾，按行解析。
pub fn scan_file(index: &mut LocalUsageIndex, source: &str, path: &Path) -> Result<(), String> {
    let key = path.to_string_lossy().to_string();
    let meta = fs::metadata(path).map_err(|e| format!("stat {key}: {e}"))?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut offset = index.files.get(&key).map(|s| s.offset).unwrap_or(0);
    if offset > size {
        // 文件被截断/替换：从头重扫（可能重复计数，但宁可统计完整也不静默丢数据）。
        offset = 0;
    }
    if offset == size && index.files.get(&key).map(|s| s.mtime_ms) == Some(mtime_ms) {
        return Ok(()); // 无变化
    }

    let file = fs::File::open(path).map_err(|e| format!("open {key}: {e}"))?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {key}: {e}"))?;

    let mut consumed = offset;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| format!("read {key}: {e}"))?;
        if read == 0 {
            break;
        }
        // 只消费以换行结尾的完整行；末尾半行留到下次（offset 不前进）。
        if !line.ends_with('\n') {
            break;
        }
        consumed += read as u64;
        if let Some((day, model, usage)) = parse_claude_line(&line) {
            accumulate(index, source, &day, &model, usage);
        }
    }

    index.files.insert(key, FileState { offset: consumed, mtime_ms });
    Ok(())
}

fn collect_jsonl(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// CPA（CLIProxyAPI 套件）用量库位置：<LocalAppData>/anybridge/extensions/services/cpa-suite/cpamp-data/usage.sqlite
fn cpa_usage_db_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    let path = base
        .join("anybridge")
        .join("extensions")
        .join("services")
        .join("cpa-suite")
        .join("cpamp-data")
        .join("usage.sqlite");
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// 从 CPA 的账号日聚合表读取用量（只读、全量重算、幂等）。
///
/// 用聚合表而不是 usage_events 明细：CPA 自己的 rollup 已按 天×账号×模型 折好，
/// 1.9GB 明细库不必逐行扫描。账号名取 auth_label_snapshot → account_snapshot → unknown。
pub fn scan_cpa_db_at(index: &mut LocalUsageIndex, path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 CPA usage.sqlite 失败: {e}"))?;

    let mut days: BTreeMap<String, BTreeMap<String, ModelUsage>> = BTreeMap::new();
    let mut by_account: BTreeMap<(String, String), CpaAccountUsage> = BTreeMap::new();
    let mut total = SourceUsage::default();

    {
        let mut stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m-%d', bucket_ms/1000, 'unixepoch') AS day, \
                        COALESCE(NULLIF(model, ''), 'unknown') AS model, \
                        COALESCE(NULLIF(auth_label_snapshot, ''), NULLIF(account_snapshot, ''), 'unknown') AS account, \
                        COALESCE(NULLIF(provider, ''), 'unknown') AS provider, \
                        SUM(calls), SUM(failed), \
                        SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)), \
                        SUM(COALESCE(cache_read_tokens, 0)), SUM(COALESCE(cache_creation_tokens, 0)) \
                 FROM usage_monitoring_account_daily_rollups_v1 \
                 GROUP BY day, model, account, provider",
            )
            .map_err(|e| format!("准备 CPA 查询失败: {e}"))?;
        let mut rows = stmt.query([]).map_err(|e| format!("执行 CPA 查询失败: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("读取 CPA 行失败: {e}"))? {
            let day: String = row.get(0).map_err(|e| format!("day: {e}"))?;
            let model: String = row.get(1).map_err(|e| format!("model: {e}"))?;
            let account: String = row.get(2).map_err(|e| format!("account: {e}"))?;
            let provider: String = row.get(3).map_err(|e| format!("provider: {e}"))?;
            let calls = row.get::<_, i64>(4).unwrap_or(0).max(0) as u64;
            let failed = row.get::<_, i64>(5).unwrap_or(0).max(0) as u64;
            let input = row.get::<_, i64>(6).unwrap_or(0).max(0) as u64;
            let output = row.get::<_, i64>(7).unwrap_or(0).max(0) as u64;
            let cache_read = row.get::<_, i64>(8).unwrap_or(0).max(0) as u64;
            let cache_write = row.get::<_, i64>(9).unwrap_or(0).max(0) as u64;

            let entry = days
                .entry(day)
                .or_default()
                .entry(model)
                .or_default();
            entry.requests += calls;
            entry.input += input;
            entry.output += output;
            entry.cache_read += cache_read;
            entry.cache_write += cache_write;

            let acc = by_account
                .entry((account.clone(), provider.clone()))
                .or_insert_with(|| CpaAccountUsage {
                    account,
                    provider,
                    ..Default::default()
                });
            acc.requests += calls;
            acc.failed += failed;
            acc.input += input;
            acc.output += output;
            acc.cache_read += cache_read;
            acc.cache_write += cache_write;

            total.requests += calls;
            total.input += input;
            total.output += output;
            total.cache_read += cache_read;
            total.cache_write += cache_write;
        }
    }

    if total.requests > 0 {
        index.sources.insert("cpa".to_string(), total);
    } else {
        index.sources.remove("cpa");
    }
    let mut accounts: Vec<CpaAccountUsage> = by_account.into_values().collect();
    // 消耗大的排前面，前端直接截断展示。
    accounts.sort_by(|a, b| {
        let ta = a.input + a.output;
        let tb = b.input + b.output;
        tb.cmp(&ta)
    });
    index.cpa_days = days;
    index.cpa_accounts = accounts;
    Ok(())
}

/// 从 cursor-core.db 的 llm_calls 表全量重算 Cursor 侧用量。
/// 只读打开，不写客户端数据库；每次覆盖 cursor_days，天然幂等。
pub fn scan_cursor_db_at(index: &mut LocalUsageIndex, path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 cursor-core.db 失败: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch') AS day, \
                    COALESCE(NULLIF(display_name, ''), model_id, 'unknown') AS model, \
                    COUNT(*), \
                    SUM(COALESCE(input_tokens, 0)), \
                    SUM(COALESCE(output_tokens, 0)), \
                    SUM(COALESCE(cache_read_tokens, 0)), \
                    SUM(COALESCE(cache_write_tokens, 0)) \
             FROM llm_calls WHERE created_at_ms > 0 GROUP BY day, model",
        )
        .map_err(|e| format!("准备查询失败: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("执行查询失败: {e}"))?;

    let mut days: BTreeMap<String, BTreeMap<String, ModelUsage>> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(|e| format!("读取行失败: {e}"))? {
        let day: String = row.get(0).map_err(|e| format!("day 字段: {e}"))?;
        let model: String = row.get(1).map_err(|e| format!("model 字段: {e}"))?;
        let usage = ModelUsage {
            requests: row.get::<_, i64>(2).unwrap_or(0) as u64,
            input: row.get::<_, i64>(3).unwrap_or(0) as u64,
            output: row.get::<_, i64>(4).unwrap_or(0) as u64,
            cache_read: row.get::<_, i64>(5).unwrap_or(0) as u64,
            cache_write: row.get::<_, i64>(6).unwrap_or(0) as u64,
        };
        days.entry(day).or_default().insert(model, usage);
    }

    // 汇总到 sources["cursor"]（从重算结果推导，不累加历史值）。
    let mut total = SourceUsage::default();
    for models in days.values() {
        for usage in models.values() {
            total.requests += usage.requests;
            total.input += usage.input;
            total.output += usage.output;
            total.cache_read += usage.cache_read;
            total.cache_write += usage.cache_write;
        }
    }
    if total.requests > 0 {
        index.sources.insert("cursor".to_string(), total);
    } else {
        index.sources.remove("cursor");
    }
    index.cursor_days = days;
    Ok(())
}

/// 扫描所有已支持的旁路数据源并持久化索引。
pub fn scan_all_sync() -> Result<LocalUsageIndex, String> {
    let mut index = load_index();
    index.errors.clear();

    if let Some(home) = home_dir() {
        let claude_root = home.join(".claude").join("projects");
        if claude_root.is_dir() {
            let mut files = Vec::new();
            collect_jsonl(&claude_root, &mut files, 0);
            for file in files {
                if let Err(e) = scan_file(&mut index, "claude-code", &file) {
                    index.errors.push(e);
                }
            }
        }
    }

    // Cursor：直接读 cursor-core 自己的调用账本（只读、全量重算、幂等）。
    let cursor_db = crate::commands::config::config_dir_path()
        .join("cursor-core")
        .join("cursor-core.db");
    if let Err(e) = scan_cursor_db_at(&mut index, &cursor_db) {
        index.errors.push(e);
    }

    // CPA（CLIProxyAPI 套件）：读它自己的账号日聚合，补上账号维度。
    if let Some(cpa_db) = cpa_usage_db_path() {
        if let Err(e) = scan_cpa_db_at(&mut index, &cpa_db) {
            index.errors.push(e);
        }
    }

    index.version = INDEX_VERSION;
    index.scanned_at = now_ms();
    save_index(&index)?;
    Ok(index)
}

#[tauri::command]
pub async fn scan_local_usage() -> Result<LocalUsageIndex, String> {
    // 文件遍历属于阻塞 IO，必须离开主线程（Tauri 同步命令会冻结 UI）。
    tauri::async_runtime::spawn_blocking(scan_all_sync)
        .await
        .map_err(|e| format!("扫描任务失败: {e}"))?
}

#[tauri::command]
pub fn get_local_usage() -> Result<LocalUsageIndex, String> {
    Ok(load_index())
}

/// 读取 sidecar 落盘的 stats.json 历史（按天，最近 N 天）。
/// 只读文件，不改写：sidecar 是该文件的唯一写入方。
#[tauri::command]
pub fn get_stats_history(days: Option<u32>) -> Result<serde_json::Value, String> {
    let path = crate::commands::config::config_dir_path().join("stats.json");
    let limit = days.unwrap_or(30).clamp(1, 366) as usize;
    if !path.is_file() {
        return Ok(serde_json::json!({ "days": [] }));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 stats.json 失败: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("stats.json 解析失败: {e}"))?;
    let empty = serde_json::Map::new();
    let days_obj = parsed
        .get("days")
        .and_then(|d| d.as_object())
        .unwrap_or(&empty);
    let mut keys: Vec<&String> = days_obj.keys().collect();
    keys.sort();
    let mut out: Vec<serde_json::Value> = keys
        .iter()
        .rev()
        .take(limit)
        .filter_map(|key| days_obj.get(*key).cloned())
        .collect();
    out.reverse();
    Ok(serde_json::json!({ "days": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_lines(path: &Path, lines: &[&str]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    fn claude_line(ts: &str, model: &str, input: u64, output: u64, cache_read: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    #[test]
    fn parses_assistant_usage_and_skips_other_lines() {
        let hit = claude_line("2026-09-26T20:37:01.841Z", "claude-sonnet-4", 100, 20, 30);
        let (day, model, usage) = parse_claude_line(&hit).expect("assistant 行应命中");
        assert_eq!(day, "2026-09-26");
        assert_eq!(model, "claude-sonnet-4");
        assert_eq!(usage.input, 100);
        assert_eq!(usage.output, 20);
        assert_eq!(usage.cache_read, 30);

        let queue = r#"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-08-16T03:38:16.607Z"}"#;
        assert!(parse_claude_line(queue).is_none());
    }

    #[test]
    fn all_zero_usage_is_not_counted() {
        let line = claude_line("2026-09-26T20:37:01.841Z", "<synthetic>", 0, 0, 0);
        assert!(parse_claude_line(&line).is_none());
    }

    #[test]
    fn scan_is_incremental_and_idempotent() {
        let tmp = std::env::temp_dir().join(format!("anybridge-usage-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let file = tmp.join("project-a").join("session-1.jsonl");
        write_lines(
            &file,
            &[
                claude_line("2026-09-26T10:00:00.000Z", "claude-sonnet-4", 100, 20, 0).as_str(),
                claude_line("2026-09-26T10:01:00.000Z", "claude-sonnet-4", 50, 5, 10).as_str(),
            ],
        );

        let mut index = LocalUsageIndex::default();
        scan_file(&mut index, "claude-code", &file).unwrap();
        let day = index.days.get("2026-09-26").expect("应有当天聚合");
        let usage = day.get("claude-sonnet-4").expect("应有模型聚合");
        assert_eq!(usage.requests, 2);
        assert_eq!(usage.input, 150);
        assert_eq!(usage.output, 25);
        assert_eq!(usage.cache_read, 10);
        assert_eq!(index.sources.get("claude-code").unwrap().requests, 2);

        // 二次扫描：文件未变，不应重复计数
        scan_file(&mut index, "claude-code", &file).unwrap();
        assert_eq!(index.days["2026-09-26"]["claude-sonnet-4"].requests, 2);

        // 追加一行：只新增这一条
        let mut content = fs::read_to_string(&file).unwrap();
        content.push_str(&claude_line("2026-09-27T10:00:00.000Z", "claude-sonnet-4", 7, 3, 0));
        content.push('\n');
        fs::write(&file, content).unwrap();
        scan_file(&mut index, "claude-code", &file).unwrap();
        assert_eq!(index.days["2026-09-26"]["claude-sonnet-4"].requests, 2);
        assert_eq!(index.days["2026-09-27"]["claude-sonnet-4"].requests, 1);
        assert_eq!(index.sources["claude-code"].requests, 3);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cursor_db_aggregation_is_recomputed_not_accumulated() {
        let tmp = std::env::temp_dir().join(format!("anybridge-usage-cursor-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let db = tmp.join("cursor-core.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE llm_calls (
                    created_at_ms INTEGER, display_name TEXT, model_id TEXT,
                    input_tokens INTEGER, output_tokens INTEGER,
                    cache_read_tokens INTEGER, cache_write_tokens INTEGER
                );
                INSERT INTO llm_calls VALUES
                    (1793000000000, 'claude-sonnet-4', 'm1', 100, 20, 30, 0),
                    (1793000000001, 'claude-sonnet-4', 'm1', 50, 5, 0, 0),
                    (1793100000000, 'gpt-5', 'm2', 10, 2, 0, 4);",
            )
            .unwrap();
        }

        let mut index = LocalUsageIndex::default();
        scan_cursor_db_at(&mut index, &db).unwrap();
        assert_eq!(index.sources["cursor"].requests, 3);
        let total_days: usize = index.cursor_days.values().map(|m| m.values().count()).sum();
        assert_eq!(total_days, 2);

        // 二次扫描应重算（结果相同），不能翻倍
        scan_cursor_db_at(&mut index, &db).unwrap();
        assert_eq!(index.sources["cursor"].requests, 3);
        assert_eq!(index.cursor_days.len(), 2);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cpa_account_rollups_aggregate_and_stay_idempotent() {
        let tmp = std::env::temp_dir().join(format!("anybridge-usage-cpa-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let db = tmp.join("usage.sqlite");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE usage_monitoring_account_daily_rollups_v1 (
                    bucket_ms INTEGER, model TEXT, auth_label_snapshot TEXT, account_snapshot TEXT,
                    provider TEXT, calls INTEGER, failed INTEGER, input_tokens INTEGER,
                    output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER
                );
                INSERT INTO usage_monitoring_account_daily_rollups_v1 VALUES
                    (1793000000000, 'claude-sonnet-4', 'acc-a', 'a@x.com', 'claude', 10, 1, 1000, 100, 500, 0),
                    (1793000000000, 'claude-sonnet-4', 'acc-b', 'b@x.com', 'claude', 2, 0, 50, 5, 0, 0),
                    (1793100000000, 'gemini-3.8-flash-high', 'acc-a', 'a@x.com', 'gemini', 3, 0, 9, 3, 0, 2);",
            )
            .unwrap();
        }

        let mut index = LocalUsageIndex::default();
        scan_cpa_db_at(&mut index, &db).unwrap();
        assert_eq!(index.sources["cpa"].requests, 15);
        assert_eq!(index.cpa_days.len(), 2);
        assert_eq!(index.cpa_accounts.len(), 3);
        // 按 tokens 排序：acc-a('claude') 1100 > acc-a('gemini') 12 > acc-b 55? —— 断言消耗最大的在最前
        let top = &index.cpa_accounts[0];
        assert_eq!(top.account, "acc-a");
        assert_eq!(top.requests, 10);

        // 幂等：二次扫描结果不变
        scan_cpa_db_at(&mut index, &db).unwrap();
        assert_eq!(index.sources["cpa"].requests, 15);
        assert_eq!(index.cpa_accounts.len(), 3);

        let _ = fs::remove_dir_all(&tmp);
    }
}
