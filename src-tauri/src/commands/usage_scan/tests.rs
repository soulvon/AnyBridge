use super::*;
use std::path::Path;

fn write_lines(path: &Path, lines: &[&str]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, lines.join("\n") + "\n").unwrap();
}

fn claude_line(ts: &str, model: &str, input: u64, output: u64, cache_read: u64) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"{ts}","message":{{"model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":0}}}}}}"#
    )
}

/// 日期键按**本地日**算，断言不能写死 `2026-09-26`（换台机器/时区就红）。
/// 这里用同一个转换函数推期望值，只验证「解析链路把时间戳传对了」。
fn local_day_of(iso: &str) -> String {
    day_key(iso).expect("时间戳应可解析")
}

#[test]
fn parses_assistant_usage_and_skips_other_lines() {
    let ts = "2026-09-26T20:37:01.841Z";
    let hit = claude_line(ts, "claude-sonnet-4", 100, 20, 30);
    let (day, model, usage) = parse_claude_line(&hit).expect("assistant 行应命中");
    assert_eq!(day, local_day_of(ts));
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
    let day1 = local_day_of("2026-09-26T10:00:00.000Z");
    let day = index.days.get(&day1).expect("应有当天聚合");
    let usage = day.get("claude-sonnet-4").expect("应有模型聚合");
    assert_eq!(usage.requests, 2);
    assert_eq!(usage.input, 150);
    assert_eq!(usage.output, 25);
    assert_eq!(usage.cache_read, 10);
    assert_eq!(index.sources.get("claude-code").unwrap().requests, 2);

    // 二次扫描：文件未变，不应重复计数
    scan_file(&mut index, "claude-code", &file).unwrap();
    assert_eq!(index.days[&day1]["claude-sonnet-4"].requests, 2);

    // 追加一行：只新增这一条
    let ts2 = "2026-09-27T10:00:00.000Z";
    let day2 = local_day_of(ts2);
    let mut content = fs::read_to_string(&file).unwrap();
    content.push_str(&claude_line(ts2, "claude-sonnet-4", 7, 3, 0));
    content.push('\n');
    fs::write(&file, content).unwrap();
    scan_file(&mut index, "claude-code", &file).unwrap();
    assert_eq!(index.days[&day1]["claude-sonnet-4"].requests, 2);
    assert_eq!(index.days[&day2]["claude-sonnet-4"].requests, 1);
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

#[test]
fn pi_usage_parses_arrays_and_strips_provider_prefix() {
    let tmp = std::env::temp_dir().join(format!("anybridge-usage-pi-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let log = tmp.join("usage.jsonl");

    // 1767225600000 = 2026-01-01T00:00:00Z，1767312000000 = 次日
    let lines = [
        // 经 CPA 转发：CPA 账本已记，不进 pi 的总量，只进去重留痕
        r#"[1767225600000,"sess-a","/w","CPA/gemini-3.8-flash-high",1000,100,50,0,1100,0]"#,
        r#"[1767225700000,"sess-a","/w","CPA/gemini-3.8-flash-high",200,20,0,0,220,0]"#,
        // local 是本地模型，独立用量
        r#"[1767312000000,"sess-b","/w","local/glm-5.3",10,2,0,0,12,0]"#,
        r#"not-json"#,
        r#"{"not":"an array"}"#,
    ];
    fs::write(&log, lines.join("\n") + "\n").unwrap();

    let mut index = LocalUsageIndex::default();
    scan_pi_usage_at(&mut index, &log).unwrap();

    // 只有 local 那条计入总量；模型名前缀被去掉，与网关侧同名对齐
    // 日期键是本地日，期望值同样由转换函数推出，避免绑死时区
    let local_day = day_key_from_ms(1767312000000).unwrap();
    let day2 = &index.pi_days[&local_day]["glm-5.3"];
    assert_eq!(day2.requests, 1);
    assert_eq!(day2.input, 10);
    assert_eq!(index.sources["pi"].requests, 1);
    assert_eq!(index.sources["pi"].input, 10);

    // CPA 前缀的两条被识别为重复，只留痕不计量
    let dup = &index.overlapped["pi"];
    assert_eq!(dup.requests, 2);
    assert_eq!(dup.input, 1200);
    assert_eq!(dup.output, 120);
    assert_eq!(dup.cache_read, 50);

    // 全量重算：再扫一次不得翻倍
    scan_pi_usage_at(&mut index, &log).unwrap();
    assert_eq!(index.sources["pi"].requests, 1);
    assert_eq!(index.overlapped["pi"].requests, 2);
    assert_eq!(index.pi_days.len(), 1);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn overlap_ledger_recognises_own_ledgers_only() {
    assert_eq!(overlap_ledger("AnyBridge-35222063"), Some("gateway"));
    assert_eq!(overlap_ledger("anybridge"), Some("gateway"));
    assert_eq!(overlap_ledger("CPA"), Some("cpa"));
    assert_eq!(overlap_ledger("cpa"), Some("cpa"));
    // 外部供应商与本地模型不能被误判成我们自己的账本
    assert_eq!(overlap_ledger("anyrouter"), None);
    assert_eq!(overlap_ledger("local"), None);
    assert_eq!(overlap_ledger("account:zai-start-plan"), None);
    assert_eq!(overlap_ledger(""), None);
}

#[test]
fn zcode_model_usage_aggregates_by_day_and_is_idempotent() {
    let tmp = std::env::temp_dir().join(format!("anybridge-usage-zcode-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let db = tmp.join("db.sqlite");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE model_usage (
                started_at INTEGER, model_id TEXT, provider_id TEXT,
                input_tokens INTEGER, output_tokens INTEGER,
                cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER
            );
            INSERT INTO model_usage VALUES
                (1767225600000, 'gemini-3.8-flash-high', 'account:zai-start-plan', 1000, 100, 500, 0),
                (1767225700000, 'gemini-3.8-flash-high', 'account:zai-start-plan', 500, 50, 0, 0),
                (1767225800000, 'gemini-3.8-flash-high', 'AnyBridge-35222063', 9999, 9999, 0, 0),
                (1767312000000, 'GLM-5.3-Flash', 'account:bigmodel-start-plan', 10, 2, 0, 4),
                (0, 'skipped-bad-row', '', 999, 999, 999, 999);",
        )
        .unwrap();
    }

    let mut index = LocalUsageIndex::default();
    scan_zcode_db_at(&mut index, &db).unwrap();

    // started_at=0 被过滤；AnyBridge 那条已由网关统计，不计量
    assert_eq!(index.sources["zcode"].requests, 3);
    assert_eq!(index.sources["zcode"].input, 1510);
    assert_eq!(index.zcode_days.len(), 2);
    let day1 = day_key_from_ms(1767225600000).unwrap();
    assert_eq!(index.zcode_days[&day1]["gemini-3.8-flash-high"].requests, 2);
    assert_eq!(index.overlapped["zcode"].requests, 1);
    assert_eq!(index.overlapped["zcode"].input, 9999);

    scan_zcode_db_at(&mut index, &db).unwrap();
    assert_eq!(index.sources["zcode"].requests, 3);
    assert_eq!(index.overlapped["zcode"].requests, 1);

    let _ = fs::remove_dir_all(&tmp);
}
