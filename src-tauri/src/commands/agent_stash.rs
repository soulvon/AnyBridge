//! agent_stash —— 平台配置「原值记账」。
//!
//! 这是配置切换重构的地基：接入（`apply_*`）在覆盖用户字段前，把
//! 「字段原值」与「本次写入值」记入独立文件 `agent-stash.json`；
//! 还原（`restore_*`）在门控开启时按记录**字段级写回**，而不是
//! 整文件覆盖或盲删托管键。
//!
//! 为什么独立文件而不是塞进 `providers.json`：前端 `save_providers`
//! 会把整个 store 整体回传覆盖，记账记在里面随时可能被连带抹掉，
//! 还原时原值变「未知」。
//!
//! 与 magpie（stash.json + applied.json）的差异：我们把两个字段合成
//! 一条 entry（`original` + `applied`），一次读改写完成，减少一半 IO；
//! 语义一致——`original` 只在首次记录（幂等，重复切换不覆盖），
//! `applied` 每次 apply 都刷新，用于还原时判断「是否被外部改过」。
//!
//! 门控纪律：
//! - **记账总是开启**：纯增量写入独立文件，不改变任何现有行为。
//! - **还原行为由 `ANYBRIDGE_FIELD_RESTORE` 控制**，默认关闭——关闭时
//!   还原走旧路径（整文件备份覆盖 / 删托管键），与当前版本完全一致。
//! - 内部函数一律带显式 `dir` 参数（测试注入临时目录），公开包装才读
//!   `config_dir_path()`——与 `declared_apply_with_paths` 同款先例。
//!
//! 失败纪律（对齐坑点 `read-failure-is-unknown`）：
//! - stash 文件解析失败 → 先把坏文件复制为 `.corrupt-<纳秒>` 再报错，
//!   **绝不当作空账本覆盖**；调用方记日志并继续主流程（还原时无记录
//!   自然退回旧路径，不会因记账损坏而阻断切换）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 记账文件名（位于 config_dir 下，与 providers.json 同级）。
const STASH_FILE: &str = "agent-stash.json";

/// 一个字段的取值。`Absent` = 该键原本不存在（还原时应删除），
/// 与 `Str("")`（原值就是空字符串，还原时应写回空串）严格区分。
///
/// 覆盖 JSON 标量三型：env 值是字符串（`Str`）、Claude 的
/// `includeCoAuthoredBy` 是 bool（`Bool`）、数字兜底（`Num`）。
/// `Json` 存对象/数组的序列化文本（与字符串值严格区分），用于
/// OpenCode/ZCode 这类「受管字段是整个 provider 对象」的平台；
/// serde_json 的 Map 是序无关比较，相等判定可靠。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum Stashed {
    #[serde(rename = "absent")]
    Absent,
    #[serde(rename = "str")]
    Str(String),
    #[serde(rename = "bool")]
    Bool(bool),
    #[serde(rename = "num")]
    Num(f64),
    #[serde(rename = "json")]
    Json(String),
}

impl Stashed {
    /// 字符串值便捷构造（测试与调用方共用）。
    #[allow(dead_code, non_snake_case)]
    pub fn s(v: impl Into<String>) -> Self {
        Stashed::Str(v.into())
    }

    /// 从 JSON 标量构造；对象/数组返回 None（标量语义专用）。
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        match v {
            serde_json::Value::String(s) => Some(Stashed::Str(s.clone())),
            serde_json::Value::Bool(b) => Some(Stashed::Bool(*b)),
            serde_json::Value::Number(n) => n.as_f64().map(Stashed::Num),
            _ => None,
        }
    }

    /// 从任意 JSON 值构造：对象/数组 → `Json`（序列化文本），标量 → 对应变体。
    /// 对象级字段（provider entry 等）的记账与判定统一走这里。
    pub fn from_json_any(v: &serde_json::Value) -> Option<Self> {
        match v {
            serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                Some(Stashed::Json(v.to_string()))
            }
            _ => Self::from_json(v),
        }
    }

    /// 转回 JSON 值；Absent → None。Json 文本 parse 失败返回 None（账本损坏）。
    pub fn to_json(&self) -> Option<serde_json::Value> {
        match self {
            Stashed::Absent => None,
            Stashed::Str(s) => Some(serde_json::Value::String(s.clone())),
            Stashed::Bool(b) => Some(serde_json::Value::Bool(*b)),
            Stashed::Num(n) => serde_json::Number::from_f64(*n)
                .map(serde_json::Value::Number),
            Stashed::Json(text) => serde_json::from_str(text).ok(),
        }
    }

    /// 转成 jsonc_edit 写入值；Absent → None。
    pub fn to_jsonc(&self) -> Option<crate::commands::jsonc_edit::JsoncValue> {
        match self {
            Stashed::Absent => None,
            Stashed::Str(s) => Some(crate::commands::jsonc_edit::JsoncValue::Str(s.clone())),
            Stashed::Bool(b) => Some(crate::commands::jsonc_edit::JsoncValue::Bool(*b)),
            Stashed::Num(n) => Some(crate::commands::jsonc_edit::JsoncValue::Num(*n)),
            Stashed::Json(text) => {
                Some(crate::commands::jsonc_edit::JsoncValue::Raw(text.clone()))
            }
        }
    }

    /// 从 jsonc_edit 的标量构造（保形路径共用同一判定逻辑）。
    /// Raw（对象/数组原文本）不经此转换——对象级字段用 raw JSON 字符串比对。
    #[allow(dead_code)]
    pub fn from_jsonc(v: &crate::commands::jsonc_edit::JsoncValue) -> Option<Self> {
        match v {
            crate::commands::jsonc_edit::JsoncValue::Str(s) => Some(Stashed::Str(s.clone())),
            crate::commands::jsonc_edit::JsoncValue::Bool(b) => Some(Stashed::Bool(*b)),
            crate::commands::jsonc_edit::JsoncValue::Num(n) => Some(Stashed::Num(*n)),
            crate::commands::jsonc_edit::JsoncValue::Raw(_) => None,
        }
    }
}

/// 一次 apply 的字段计划：路径、apply 前现值、本次写入值。
///
/// - `current`：调用方从刚解析的配置里读出的现值（Absent = 无此键）
/// - `new`：本次要写入的值（Absent = 本次会删除它，如 SMALL_FAST_MODEL）
#[derive(Debug, Clone)]
pub struct FieldPlan {
    /// JSON 路径段，如 ["env", "ANTHROPIC_BASE_URL"]
    pub path: Vec<String>,
    pub current: Stashed,
    pub new: Stashed,
}

/// 一条记账记录：原值 + 我最后一次写入的值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashEntry {
    /// 权威路径（key 里点号拼接仅供人读，段名含点时以此为准）
    pub path: Vec<String>,
    pub original: Stashed,
    pub applied: Stashed,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StashFile {
    version: u32,
    entries: BTreeMap<String, StashEntry>,
}

/// 记账目标：平台 + 配置文件名（同一平台可能写多个文件）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StashKey {
    pub platform: &'static str,
    pub file: &'static str,
}

impl StashKey {
    fn index_prefix(&self) -> String {
        format!("{}|{}|", self.platform, self.file)
    }
}

static STASH_LOCK: Mutex<()> = Mutex::new(());

fn stash_path_in(dir: &Path) -> PathBuf {
    dir.join(STASH_FILE)
}

fn dotted(path: &[String]) -> String {
    path.join(".")
}

/// 读取整个账本。文件不存在 → 空账本；解析失败 → 复制坏文件为
/// `.corrupt-<纳秒>` 后返回 Err（调用方决定如何保守降级）。
fn load_in(dir: &Path) -> Result<StashFile, String> {
    let path = stash_path_in(dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StashFile {
                version: 1,
                entries: BTreeMap::new(),
            })
        }
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(StashFile {
            version: 1,
            entries: BTreeMap::new(),
        });
    }
    match serde_json::from_str::<StashFile>(&raw) {
        Ok(file) => Ok(file),
        Err(e) => {
            // 读失败 = 未知：先把坏文件留底再报错，绝不覆盖
            let kept = path.with_extension(format!(
                "corrupt-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
            ));
            let _ = std::fs::copy(&path, &kept);
            Err(format!(
                "agent-stash.json 解析失败（已留底 {}）：{e}",
                kept.display()
            ))
        }
    }
}

fn save_in(dir: &Path, file: &StashFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建记账目录失败: {e}"))?;
    #[cfg(unix)]
    {
        // 账本含用户原 key（original），unix 上收紧到 0600；
        // WriteAtomic 保留既有 mode，首次先建一个空文件定好权限。
        use std::os::unix::fs::OpenOptionsExt;
        let path = stash_path_in(dir);
        if !path.exists() {
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path);
        }
    }
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    super::write_atomic(&stash_path_in(dir), json.as_bytes())
}

/// 记录一次 apply：对每个字段，`original` 只在首次记录（幂等），
/// `applied` 每次刷新为本次写入值。
///
/// 记账失败只影响「能否字段级还原」，不影响切换本身——调用方应记
/// 日志后继续主流程，不得因记账失败中止切换。
pub fn record_apply(dir: &Path, key: &StashKey, plans: &[FieldPlan]) -> Result<(), String> {
    if plans.is_empty() {
        return Ok(());
    }
    let _guard = STASH_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = load_in(dir)?;
    let prefix = key.index_prefix();
    for plan in plans {
        let idx = format!("{}{}", prefix, dotted(&plan.path));
        let entry = file.entries.entry(idx).or_insert_with(|| StashEntry {
            path: plan.path.clone(),
            original: plan.current.clone(),
            applied: plan.new.clone(),
        });
        // original 幂等：重复切换（第二次 apply 时 current 已是我们写的值）
        // 不覆盖首次记录的原值
        entry.applied = plan.new.clone();
    }
    save_in(dir, &file)
}

/// 读取某平台某配置文件的全部记录。
pub fn entries_for(dir: &Path, key: &StashKey) -> Result<Vec<StashEntry>, String> {
    let _guard = STASH_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let file = load_in(dir)?;
    let prefix = key.index_prefix();
    Ok(file
        .entries
        .iter()
        .filter(|(idx, _)| idx.starts_with(&prefix))
        .map(|(_, entry)| entry.clone())
        .collect())
}

/// 还原完成后清除该平台该文件的记录（只清自己，不动其它平台）。
pub fn clear_for(dir: &Path, key: &StashKey) -> Result<(), String> {
    let _guard = STASH_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = load_in(dir)?;
    let prefix = key.index_prefix();
    let before = file.entries.len();
    file.entries.retain(|idx, _| !idx.starts_with(&prefix));
    if file.entries.len() == before {
        return Ok(());
    }
    save_in(dir, &file)
}

/// 门控：字段级还原是否开启。默认关闭——关闭时所有还原路径与
/// 旧版本行为完全一致（整文件备份覆盖 / 删托管键）。
pub fn field_restore_enabled() -> bool {
    match std::env::var("ANYBRIDGE_FIELD_RESTORE") {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "on"
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "anybridge-stash-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn key() -> StashKey {
        StashKey {
            platform: "claude-code",
            file: "settings.json",
        }
    }

    fn plan(path: &[&str], current: Stashed, new: Stashed) -> FieldPlan {
        FieldPlan {
            path: path.iter().map(|s| s.to_string()).collect(),
            current,
            new,
        }
    }

    #[test]
    fn original_recorded_once_across_reapplies() {
        let dir = tmp_dir("reapply");
        // 第一次接入：原值 corp
        record_apply(
            &dir,
            &key(),
            &[plan(
                &["env", "ANTHROPIC_BASE_URL"],
                Stashed::s("https://corp.example"),
                Stashed::s("http://127.0.0.1:8317"),
            )],
        )
        .unwrap();
        // 第二次切换到另一供应商：current 已是我们写的值，original 不得覆盖
        record_apply(
            &dir,
            &key(),
            &[plan(
                &["env", "ANTHROPIC_BASE_URL"],
                Stashed::s("http://127.0.0.1:8317"),
                Stashed::s("https://other.example"),
            )],
        )
        .unwrap();
        let entries = entries_for(&dir, &key()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original, Stashed::s("https://corp.example"));
        assert_eq!(entries[0].applied, Stashed::s("https://other.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_and_empty_string_distinct() {
        let dir = tmp_dir("absent-empty");
        record_apply(
            &dir,
            &key(),
            &[
                // 原本无此键
                plan(&["env", "NEW_KEY"], Stashed::Absent, Stashed::s("x")),
                // 原值就是空字符串
                plan(
                    &["env", "EMPTY_KEY"],
                    Stashed::s(""),
                    Stashed::s("x"),
                ),
            ],
        )
        .unwrap();
        let entries = entries_for(&dir, &key()).unwrap();
        let by_dotted = |p: &str| {
            entries
                .iter()
                .find(|e| e.path.join(".") == p)
                .unwrap()
                .original
                .clone()
        };
        assert_eq!(by_dotted("env.NEW_KEY"), Stashed::Absent);
        assert_eq!(by_dotted("env.EMPTY_KEY"), Stashed::s(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_only_matching_platform_file() {
        let dir = tmp_dir("clear");
        record_apply(
            &dir,
            &key(),
            &[plan(&["env", "A"], Stashed::Absent, Stashed::s("1"))],
        )
        .unwrap();
        record_apply(
            &dir,
            &StashKey {
                platform: "opencode",
                file: "opencode.json",
            },
            &[plan(&["model"], Stashed::Absent, Stashed::s("m"))],
        )
        .unwrap();
        clear_for(&dir, &key()).unwrap();
        assert!(entries_for(&dir, &key()).unwrap().is_empty());
        assert_eq!(entries_for(&dir, &StashKey { platform: "opencode", file: "opencode.json" }).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_kept_not_overwritten() {
        let dir = tmp_dir("corrupt");
        let path = stash_path_in(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ not json !!!").unwrap();
        let err = record_apply(
            &dir,
            &key(),
            &[plan(&["env", "A"], Stashed::Absent, Stashed::s("1"))],
        )
        .unwrap_err();
        assert!(err.contains("解析失败"), "应报解析错误: {err}");
        // 坏文件原样保留
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json !!!");
        // 有留底
        let kept: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(kept.len(), 1, "应留底一份坏文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_reads_as_empty_ledger() {
        let dir = tmp_dir("empty-ledger");
        assert!(entries_for(&dir, &key()).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
