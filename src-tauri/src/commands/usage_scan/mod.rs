// usage_scan.rs — 旁路用量统计（读 agent 自己落盘的会话文件，不依赖网关）。
//
// 为什么需要：走网关的流量由 sidecar 账本统计；配置式直连的客户端（以及网关
// 未启动的时段）不经过网关，只能读客户端自己写的会话日志。这与 ccusage 类工具
// 同一思路：统计器只读文件，不注入、不挂代理，开关不影响客户端使用。
//
// 当前支持：
//   claude-code  ~/.claude/projects/**/*.jsonl（增量，按 byte offset）
//   cursor       <config>/cursor-core/cursor-core.db（全量重算）
//   cpa          <LocalAppData>/.../cpa-suite/cpamp-data/usage.sqlite（全量重算）
//   pi           ~/.pi/agent/analytics/usage.jsonl（全量重算）
//   zcode        ~/.zcode/cli/db/db.sqlite 的 model_usage（全量重算）
// 落盘：<config>/usage-local.json（与 stats.json 分离，互不覆盖）。

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;

use std::path::PathBuf;

/// 索引格式版本。日期口径变更时必须递增：旧桶按老口径分天，
/// 与新桶混在一起会把同一天算两遍（如 UTC 日 + 本地日各一份）。
/// v2：日键从 UTC 改为本地日。
const INDEX_VERSION: u32 = 2;

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
    /// day -> model -> usage（pi，读它自己的 analytics/usage.jsonl，全量重算）
    #[serde(default)]
    pub pi_days: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// day -> model -> usage（zcode，读 cli/db/db.sqlite 的 model_usage，全量重算）
    #[serde(default)]
    pub zcode_days: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// source id -> 已被其它账本统计、因此未计入的用量（去重留痕）
    ///
    /// 客户端经自己的代理转发时，同一请求会同时出现在客户端日志和网关/CPA 账本里。
    /// 这里按上游标识剔除重复部分，并把剔除量留档给 UI 显示，避免「总量悄悄变小」。
    #[serde(default)]
    pub overlapped: BTreeMap<String, SourceUsage>,
    /// source id (claude-code / codex / cursor / cpa / pi / zcode) -> usage
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
            pi_days: BTreeMap::new(),
            zcode_days: BTreeMap::new(),
            overlapped: BTreeMap::new(),
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
        Ok(index) if index.version == INDEX_VERSION => index,
        // 旧口径的数据必须丢弃重建：日键口径变了（UTC → 本地日），
        // 留着旧桶会把同一天按两种口径各算一遍。清空后下次扫描全量重算。
        Ok(_) => LocalUsageIndex::default(),
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

/// ISO8601 时间戳 → **本地日**键。
///
/// 不能直接截前 10 位：那是 UTC 日。本地 00:00–08:00（UTC+8）时 UTC 还停在前一天，
/// 截取会把这段流量记到昨天，导致「今日」在这些时段恒为 0。
pub(super) fn day_key(timestamp: &str) -> Option<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
    Some(parsed.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

pub(super) fn num(value: Option<&serde_json::Value>) -> u64 {
    value.and_then(|v| v.as_u64()).unwrap_or(0)
}

pub(super) fn accumulate(index: &mut LocalUsageIndex, source: &str, day: &str, model: &str, usage: ModelUsage) {
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

pub mod scanners;

pub use scanners::*;

pub const TOGGLEABLE_SOURCES: [&str; 5] = ["claude-code", "cursor", "cpa", "pi", "zcode"];

/// 读取被禁用采集的来源列表：config 里 `STATS_DISABLED_SOURCES`，逗号分隔。
fn disabled_sources() -> Vec<String> {
    crate::commands::config::read_config_value("STATS_DISABLED_SOURCES")
        .map(|raw| {
            raw.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn is_disabled(disabled: &[String], id: &str) -> bool {
    disabled.iter().any(|d| d == id)
}

/// 本机真实存在、可被采集的旁路来源。
fn available_sources() -> Vec<String> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        if home.join(".claude").join("projects").is_dir() {
            out.push("claude-code".to_string());
        }
    }
    let cursor_db = crate::commands::config::config_dir_path()
        .join("cursor-core")
        .join("cursor-core.db");
    if cursor_db.is_file() {
        out.push("cursor".to_string());
    }
    if cpa_usage_db_path().is_some() {
        out.push("cpa".to_string());
    }
    if pi_usage_path().is_some() {
        out.push("pi".to_string());
    }
    if zcode_db_path().is_some() {
        out.push("zcode".to_string());
    }
    out
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatsSettings {
    /// 被用户关掉采集的来源
    pub disabled_sources: Vec<String>,
    /// 本机存在、支持采集的来源（UI 只列这些）
    pub available_sources: Vec<String>,
}

#[tauri::command]
pub fn get_stats_settings() -> Result<StatsSettings, String> {
    Ok(StatsSettings {
        disabled_sources: disabled_sources(),
        available_sources: available_sources(),
    })
}

/// 写入采集开关。只接受已知来源 id，避免把脏值写进配置。
#[tauri::command]
pub fn set_stats_settings(disabled_sources: Vec<String>) -> Result<StatsSettings, String> {
    let cleaned: Vec<String> = disabled_sources
        .into_iter()
        .filter(|s| TOGGLEABLE_SOURCES.contains(&s.as_str()))
        .collect();
    crate::commands::config::write_config_value(
        "STATS_DISABLED_SOURCES",
        &cleaned.join(","),
    )?;
    get_stats_settings()
}

/// pi（PiDeck）用量日志：<home>/.pi/agent/analytics/usage.jsonl

pub fn scan_all_sync() -> Result<LocalUsageIndex, String> {
    let mut index = load_index();
    index.errors.clear();
    let disabled = disabled_sources();

    if is_disabled(&disabled, "claude-code") {
        // 关闭采集：清数据与读取偏移。偏移必须一起清，否则重新开启时会从旧 offset
        // 继续读，而天级汇总已被清空——数字会永久少一段。
        index.days.clear();
        index.files.clear();
        index.sources.remove("claude-code");
    } else if let Some(home) = home_dir() {
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
    if is_disabled(&disabled, "cursor") {
        index.cursor_days.clear();
        index.sources.remove("cursor");
    } else {
        let cursor_db = crate::commands::config::config_dir_path()
            .join("cursor-core")
            .join("cursor-core.db");
        if let Err(e) = scan_cursor_db_at(&mut index, &cursor_db) {
            index.errors.push(e);
        }
    }

    // CPA（CLIProxyAPI 套件）：读它自己的账号日聚合，补上账号维度。
    // 热插拔：若未安装或文件不存在，静默清空旧的 CPA 聚合缓存，不报错。
    if is_disabled(&disabled, "cpa") {
        index.cpa_days.clear();
        index.cpa_accounts.clear();
        index.sources.remove("cpa");
    } else if let Some(cpa_db) = cpa_usage_db_path() {
        if let Err(e) = scan_cpa_db_at(&mut index, &cpa_db) {
            index.errors.push(e);
        }
    } else {
        index.cpa_days.clear();
        index.cpa_accounts.clear();
        index.sources.remove("cpa");
    }

    // pi：读它自己的 analytics/usage.jsonl（全量重算）。
    if is_disabled(&disabled, "pi") {
        index.pi_days.clear();
        index.sources.remove("pi");
    } else if let Some(pi_log) = pi_usage_path() {
        if let Err(e) = scan_pi_usage_at(&mut index, &pi_log) {
            index.errors.push(e);
        }
    } else {
        index.pi_days.clear();
        index.sources.remove("pi");
    }

    // zcode：读 cli/db/db.sqlite 的 model_usage（只读、全量重算）。
    if is_disabled(&disabled, "zcode") {
        index.zcode_days.clear();
        index.sources.remove("zcode");
    } else if let Some(zcode_db) = zcode_db_path() {
        if let Err(e) = scan_zcode_db_at(&mut index, &zcode_db) {
            index.errors.push(e);
        }
    } else {
        index.zcode_days.clear();
        index.sources.remove("zcode");
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
mod tests;

