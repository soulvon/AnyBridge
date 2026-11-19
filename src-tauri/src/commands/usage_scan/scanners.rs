use chrono::{Local, TimeZone};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use super::{accumulate, day_key, num, CpaAccountUsage, FileState, LocalUsageIndex, ModelUsage, SourceUsage};
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

pub fn collect_jsonl(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
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

pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// CPA（CLIProxyAPI 套件）用量库位置：<LocalAppData>/anybridge/extensions/services/cpa-suite/cpamp-data/usage.sqlite
pub fn cpa_usage_db_path() -> Option<PathBuf> {
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
                "SELECT strftime('%Y-%m-%d', bucket_ms/1000, 'unixepoch', 'localtime') AS day, \
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
            "SELECT strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', 'localtime') AS day, \
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

/// 用户可以开关采集的旁路来源（网关账本由 sidecar 写，不在此列）。

pub fn pi_usage_path() -> Option<PathBuf> {
    let path = home_dir()?
        .join(".pi")
        .join("agent")
        .join("analytics")
        .join("usage.jsonl");
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// zcode 用量库：<home>/.zcode/cli/db/db.sqlite
pub fn zcode_db_path() -> Option<PathBuf> {
    let path = home_dir()?
        .join(".zcode")
        .join("cli")
        .join("db")
        .join("db.sqlite");
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// 毫秒时间戳 → 本地日期键（`YYYY-MM-DD`），与 SQL 侧的 `'localtime'` 口径一致。
pub fn day_key_from_ms(ms: u64) -> Option<String> {
    let dt = Local.timestamp_millis_opt(ms as i64).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
}

/// pi 的模型名带来源前缀（`CPA/gemini-3.8-flash-high`、`local/...`），
/// 去掉前缀才能与网关侧模型名对齐到同一行排行。
pub fn strip_model_prefix(model: &str) -> &str {
    match model.split_once('/') {
        Some((_, rest)) if !rest.trim().is_empty() => rest.trim(),
        _ => model.trim(),
    }
}

/// 客户端记录的上游标识若指向我们自己的账本，这条请求就已经被计过一次了。
///
/// 返回覆盖它的账本名（用于向用户解释），`None` 表示这是独立用量。
/// 例：zcode 的 `AnyBridge-35222063`、pi 的 `CPA/...` 前缀。
pub fn overlap_ledger(via: &str) -> Option<&'static str> {
    let v = via.trim().to_ascii_lowercase();
    if v.is_empty() {
        return None;
    }
    if v.starts_with("anybridge") {
        return Some("gateway");
    }
    if v == "cpa" || v.starts_with("cpa-") || v.starts_with("cpa_") {
        return Some("cpa");
    }
    None
}

/// 把一条记录计入「重复量」账，返回其账本名。
pub fn add_overlap(
    overlapped: &mut BTreeMap<String, SourceUsage>,
    source: &str,
    usage: &ModelUsage,
) {
    let entry = overlapped.entry(source.to_string()).or_default();
    entry.requests += usage.requests;
    entry.input += usage.input;
    entry.output += usage.output;
    entry.cache_read += usage.cache_read;
    entry.cache_write += usage.cache_write;
}

/// 读 pi 的 analytics/usage.jsonl。每行一个 JSON 数组：
/// `[ts_ms, session, workspace, model, input, output, cache_read, cache_write, total, ?]`
///
/// 全量重算而不是增量：文件只有几百 KB、增长慢，重算远比维护偏移可靠——
/// 偏移一旦与天级汇总不同步，就是永久少算一段且没有任何报错。
pub fn scan_pi_usage_at(index: &mut LocalUsageIndex, path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取 pi usage.jsonl 失败: {e}"))?;

    let mut days: BTreeMap<String, BTreeMap<String, ModelUsage>> = BTreeMap::new();
    let mut total = SourceUsage::default();
    // 全量重算：先清掉本来源上一轮的去重留痕，避免累积
    index.overlapped.remove("pi");

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(arr) = value.as_array() else { continue };
        if arr.len() < 6 {
            continue;
        }

        let Some(ts) = arr.first().and_then(|v| v.as_u64()) else {
            continue;
        };
        let Some(day) = day_key_from_ms(ts) else { continue };

        let raw_model = arr.get(3).and_then(|v| v.as_str()).unwrap_or("");
        let model = strip_model_prefix(raw_model);
        if model.is_empty() {
            continue;
        }
        // 前缀即上游：`CPA/...`、`AnyBridge/...` 已被对应账本记过，不重复计
        let via = raw_model.split_once('/').map(|(p, _)| p).unwrap_or("");

        let num = |i: usize| -> u64 { arr.get(i).and_then(|v| v.as_u64()).unwrap_or(0) };
        let usage = ModelUsage {
            requests: 1,
            input: num(4),
            output: num(5),
            cache_read: num(6),
            cache_write: num(7),
        };

        if overlap_ledger(via).is_some() {
            add_overlap(&mut index.overlapped, "pi", &usage);
            continue;
        }

        let entry = days
            .entry(day)
            .or_default()
            .entry(model.to_string())
            .or_default();
        entry.requests += usage.requests;
        entry.input += usage.input;
        entry.output += usage.output;
        entry.cache_read += usage.cache_read;
        entry.cache_write += usage.cache_write;

        total.requests += usage.requests;
        total.input += usage.input;
        total.output += usage.output;
        total.cache_read += usage.cache_read;
        total.cache_write += usage.cache_write;
    }

    if total.requests > 0 {
        index.sources.insert("pi".to_string(), total);
    } else {
        index.sources.remove("pi");
    }
    index.pi_days = days;
    Ok(())
}

/// 读 zcode 的 model_usage（天 × 模型聚合，只读、全量重算、幂等）。
pub fn scan_zcode_db_at(index: &mut LocalUsageIndex, path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 zcode db.sqlite 失败: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime') AS day, \
                    COALESCE(NULLIF(model_id, ''), 'unknown') AS model, \
                    COALESCE(provider_id, '') AS provider, \
                    COUNT(*), \
                    SUM(COALESCE(input_tokens, 0)), \
                    SUM(COALESCE(output_tokens, 0)), \
                    SUM(COALESCE(cache_read_input_tokens, 0)), \
                    SUM(COALESCE(cache_creation_input_tokens, 0)) \
             FROM model_usage WHERE started_at > 0 GROUP BY day, model, provider",
        )
        .map_err(|e| format!("准备 zcode 查询失败: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("执行 zcode 查询失败: {e}"))?;

    let mut days: BTreeMap<String, BTreeMap<String, ModelUsage>> = BTreeMap::new();
    let mut total = SourceUsage::default();
    // 全量重算：先清掉本来源上一轮的去重留痕，避免累积
    index.overlapped.remove("zcode");
    while let Some(row) = rows.next().map_err(|e| format!("读取 zcode 行失败: {e}"))? {
        let day: String = row.get(0).map_err(|e| format!("zcode day: {e}"))?;
        let model: String = row.get(1).map_err(|e| format!("zcode model: {e}"))?;
        let provider: String = row.get(2).map_err(|e| format!("zcode provider: {e}"))?;
        let usage = ModelUsage {
            requests: row.get::<_, i64>(3).unwrap_or(0).max(0) as u64,
            input: row.get::<_, i64>(4).unwrap_or(0).max(0) as u64,
            output: row.get::<_, i64>(5).unwrap_or(0).max(0) as u64,
            cache_read: row.get::<_, i64>(6).unwrap_or(0).max(0) as u64,
            cache_write: row.get::<_, i64>(7).unwrap_or(0).max(0) as u64,
        };

        // provider_id 形如 `AnyBridge-35222063` 说明这次调用走了我们自己的网关，
        // 网关账本已经记过一次，不能再加到总量里。
        if overlap_ledger(&provider).is_some() {
            add_overlap(&mut index.overlapped, "zcode", &usage);
            continue;
        }

        total.requests += usage.requests;
        total.input += usage.input;
        total.output += usage.output;
        total.cache_read += usage.cache_read;
        total.cache_write += usage.cache_write;
        days.entry(day).or_default().insert(model, usage);
    }

    if total.requests > 0 {
        index.sources.insert("zcode".to_string(), total);
    } else {
        index.sources.remove("zcode");
    }
    index.zcode_days = days;
    Ok(())
}

