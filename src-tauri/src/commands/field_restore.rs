//! field_restore —— 字段级还原的通用实现（平台无关）。
//!
//! 收敛纪律：各平台的「按账本写回原值」逻辑只有这里一份（对齐坑点
//! `symmetric-path-halved`：成对逻辑收敛到同一函数）。平台差异只体现在
//! ①账本键（StashKey）②受管字段路径 ③跳过集合，不体现在还原语义。
//!
//! 还原语义（与 Claude/OpenCode/Codex 标杆一致）：
//! - 当前值 == applied（还是我写的）→ 写回 original（Absent 则删除该键）
//! - 当前值 != applied（被外部改过）→ 保留用户的值，不还原
//! - 账本无记录 → 返回 Ok(false)，调用方退回旧路径（删托管键/整文件还原）
//! - 保形门控开启时 JSON 走原位编辑；TOML 一律 toml_edit 保形

use super::agent_stash::{self, StashKey, Stashed};
use super::jsonc_edit;
use serde_json::Value as Json;
use std::collections::HashSet;
use std::path::Path;

/// 当前值判定（JSON）：entry.applied 与文件现状比较。
/// Json 文本走结构比较（序无关）；标量走 get_scalar。
fn stashed_now_json(raw_text: &str, entry_applied: &Stashed) -> Stashed {
    match entry_applied {
        Stashed::Json(applied) => {
            if jsonc_edit::raw_text_matches_json(raw_text, applied) {
                Stashed::Json(applied.clone())
            } else {
                // 被外部改过：归档原文本（必不等于 applied）
                Stashed::Json(raw_text.to_string())
            }
        }
        Stashed::Str(applied) => {
            // 字符串值可能在原文里带引号，剥离后比较
            let stripped = raw_text.trim_matches('"');
            if stripped == applied.as_str() {
                Stashed::Str(applied.clone())
            } else {
                Stashed::Str(raw_text.to_string())
            }
        }
        scalar_applied => {
            let parsed: Option<Json> = serde_json::from_str(raw_text).ok();
            parsed
                .as_ref()
                .and_then(Stashed::from_json)
                .filter(|now| now == scalar_applied)
                .unwrap_or_else(|| {
                    parsed
                        .as_ref()
                        .and_then(Stashed::from_json_any)
                        .unwrap_or(Stashed::Absent)
                })
        }
    }
}

/// JSON 配置的字段级还原（通用入口）。
///
/// 受管字段语义由账本决定（路径即字段）；适用于 Claude/OpenCode/ZCode/
/// Buddy/Pi 等一切 JSON 平台。成功后清账。
///
/// 返回 true = 有账本记录并已处理；false = 无记录（调用方退回旧路径）。
pub fn restore_json_fields_via_stash(
    path: &Path,
    key: &StashKey,
    stash_dir: &Path,
    label: &str,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let entries = agent_stash::entries_for(stash_dir, key)?;
    if entries.is_empty() {
        return Ok(false);
    }
    let preserving = jsonc_edit::format_preserving_enabled();

    if preserving {
        let mut text = raw;
        for entry in &entries {
            let segs: Vec<&str> = entry.path.iter().map(String::as_str).collect();
            let now = jsonc_edit::get_raw_text(&text, &segs)
                .map(|current| stashed_now_json(&current, &entry.applied))
                .unwrap_or(Stashed::Absent);
            if now != entry.applied {
                continue; // 被外部改过：保留用户的值
            }
            text = match &entry.original {
                Stashed::Absent => jsonc_edit::remove_key(&text, &segs)?,
                orig => {
                    let v = orig
                        .to_jsonc()
                        .ok_or_else(|| format!("{label} 账本原值无法转换为写入值"))?;
                    jsonc_edit::set_key(&text, &segs, &v)?
                }
            };
        }
        super::write_atomic(path, text.as_bytes())?;
    } else {
        // pretty 路径：parse → 逐字段写回 → pretty
        let obj = super::ide_config::parse_object(&raw)?;
        let mut root = Json::Object(obj);
        for entry in &entries {
            let now = json_value_at(&root, &entry.path)
                .and_then(Stashed::from_json_any)
                .unwrap_or(Stashed::Absent);
            if now != entry.applied {
                continue;
            }
            json_set_value(&mut root, &entry.path, &entry.original)?;
        }
        let obj = match root {
            Json::Object(m) => m,
            _ => unreachable!("字段级还原只改成员，顶层保持对象"),
        };
        let json = serde_json::to_string_pretty(&Json::Object(obj)).map_err(|e| e.to_string())?;
        super::write_atomic(path, json.as_bytes())?;
    }

    if let Err(e) = agent_stash::clear_for(stash_dir, key) {
        eprintln!("[agent-stash] {label} 清账失败: {e}");
    }
    Ok(true)
}

fn json_value_at<'a>(root: &'a Json, path: &[String]) -> Option<&'a Json> {
    let mut cur = root;
    for seg in path {
        cur = cur.get(seg)?;
    }
    Some(cur)
}

/// JSON 数组按 `id` 字段的字段级还原（Buddy/Pi 的 models.json 形态）。
///
/// 账本 path 约定：`[数组字段名, 条目id]`（如 `["models", "deepseek-chat"]`）。
/// 数组无法按稳定键寻址，因此按条目的 `id` 字段匹配。
///
/// - 当前数组中同 id 条目 == applied（结构比较）→ original 是 Json 则替换
///   该条目；Absent 则从数组移除
/// - 同 id 条目 != applied（用户改过/删过）→ 不动
/// - 数组字段本身不存在 → 视为 Absent（无条目可还原时幂等）
pub fn restore_json_array_by_id_via_stash(
    path: &Path,
    key: &StashKey,
    stash_dir: &Path,
    label: &str,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let entries = agent_stash::entries_for(stash_dir, key)?;
    if entries.is_empty() {
        return Ok(false);
    }

    let mut obj = super::ide_config::parse_object(&raw)?;
    for entry in &entries {
        // path 约定：[数组字段, 条目id]
        let Some(array_field) = entry.path.first() else {
            continue;
        };
        let Some(item_id) = entry.path.get(1) else {
            continue;
        };
        let Some(array) = obj.get_mut(array_field).and_then(Json::as_array_mut) else {
            continue; // 数组不存在：无条目可还原（幂等）
        };
        // 当前值：数组中同 id 条目
        let pos = array
            .iter()
            .position(|item| item.get("id").and_then(Json::as_str) == Some(item_id.as_str()));
        let now = pos
            .and_then(|i| array.get(i))
            .map(|item| Stashed::Json(item.to_string()))
            .unwrap_or(Stashed::Absent);
        if now != entry.applied {
            continue; // 被外部改过：保留用户的值
        }
        match &entry.original {
            Stashed::Absent => {
                if let Some(i) = pos {
                    array.remove(i);
                }
            }
            orig => {
                let replacement = match orig.to_json() {
                    Some(v) => v,
                    None => continue,
                };
                match pos {
                    Some(i) => {
                        array[i] = replacement;
                    }
                    None => {
                        // 用户删掉了条目但 original 存在：恢复到数组尾
                        array.push(replacement);
                    }
                }
            }
        }
    }

    let json = serde_json::to_string_pretty(&Json::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())?;
    if let Err(e) = agent_stash::clear_for(stash_dir, key) {
        eprintln!("[agent-stash] {label} 清账失败: {e}");
    }
    Ok(true)
}

/// 按账本值写回 JSON 路径（original=Absent → 删除；否则写回）。
/// 中间层不存在则创建（与 apply 的合并语义一致）。
fn json_set_value(root: &mut Json, path: &[String], stashed: &Stashed) -> Result<(), String> {
    let Some((last, parents)) = path.split_last() else {
        return Err("记账路径为空".to_string());
    };
    let mut cur = root;
    for seg in parents {
        if !cur.is_object() {
            return Err(format!("路径段 {seg} 处不是对象，无法写回"));
        }
        let obj = cur.as_object_mut().expect("已判定为 object");
        cur = obj
            .entry(seg.clone())
            .or_insert_with(|| Json::Object(serde_json::Map::new()));
    }
    let obj = cur
        .as_object_mut()
        .ok_or_else(|| format!("路径段 {last} 处不是对象，无法写回"))?;
    match stashed.to_json() {
        Some(v) => {
            obj.insert(last.clone(), v);
        }
        None => {
            obj.remove(last);
        }
    }
    Ok(())
}

/// TOML 标量的字段级还原（通用入口；Codex/Grok 共用）。
///
/// 支持**任意深度**的标量路径（如 Codex 的 `model`、Grok 的
/// `models.default`）；表/数组不在还原范围（条目级表由各平台 official
/// 的 managed-flag 删除语义兜底）。返回已恢复键的「点分路径」集合
/// （调用方据此跳过删除）。不清账——由调用方完成后统一清。
/// `skip`：点分路径（结构性不可恢复的键，诚实跳过）。
pub fn restore_toml_scalars_via_stash(
    path: &Path,
    key: &StashKey,
    stash_dir: &Path,
    skip: &[&str],
    label: &str,
) -> Result<HashSet<String>, String> {
    let mut restored = HashSet::new();
    if !path.exists() {
        return Ok(restored);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(restored);
    }
    let entries = agent_stash::entries_for(stash_dir, key)?;
    if entries.is_empty() {
        return Ok(restored);
    }

    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("{label} config 解析失败: {e}"))?;
    for entry in &entries {
        let dotted = entry.path.join(".");
        if skip.contains(&dotted.as_str()) {
            continue;
        }
        // 当前值：沿路径读标量（字符串化）；任何一段缺失/非标量 → Absent
        let current = toml_scalar_at(&doc, &entry.path);
        if current != entry.applied {
            continue; // 被外部改过：保留用户的值
        }
        match &entry.original {
            Stashed::Absent => {
                toml_remove_at(&mut doc, &entry.path)?;
            }
            Stashed::Str(v) => {
                toml_set_scalar(&mut doc, &entry.path, v)?;
            }
            _ => continue, // 表/数组不在此还原范围
        }
        restored.insert(dotted);
    }
    super::write_atomic(path, doc.to_string().as_bytes())?;
    let _ = label;
    Ok(restored)
}

/// 沿路径读 TOML 标量（仅字符串；深层路径逐段下钻表）。
fn toml_scalar_at(doc: &toml_edit::DocumentMut, path: &[String]) -> Stashed {
    let Some((last, parents)) = path.split_last() else {
        return Stashed::Absent;
    };
    let mut cur = doc.as_table();
    for seg in parents {
        match cur.get(seg).and_then(|i| i.as_table()) {
            Some(t) => cur = t,
            None => return Stashed::Absent,
        }
    }
    cur.get(last)
        .and_then(toml_item_string)
        .map(Stashed::Str)
        .unwrap_or(Stashed::Absent)
}

/// 沿路径写 TOML 标量（中间表缺失则报错——不凭空造结构）。
fn toml_set_scalar(
    doc: &mut toml_edit::DocumentMut,
    path: &[String],
    v: &str,
) -> Result<(), String> {
    let Some((last, parents)) = path.split_last() else {
        return Err("记账路径为空".to_string());
    };
    let mut cur = doc.as_table_mut();
    for seg in parents {
        cur = cur
            .get_mut(seg)
            .and_then(|i| i.as_table_mut())
            .ok_or_else(|| format!("路径段 {seg} 处不是表，无法写回"))?;
    }
    cur.insert(last, toml_edit::value(v));
    Ok(())
}

/// 沿路径删除 TOML 键（父表不存在视为已删除）。
fn toml_remove_at(doc: &mut toml_edit::DocumentMut, path: &[String]) -> Result<(), String> {
    let Some((last, parents)) = path.split_last() else {
        return Err("记账路径为空".to_string());
    };
    let mut cur = doc.as_table_mut();
    for seg in parents {
        match cur.get_mut(seg).and_then(|i| i.as_table_mut()) {
            Some(t) => cur = t,
            None => return Ok(()),
        }
    }
    cur.remove(last);
    Ok(())
}

/// TOML Item 的字符串化（String 值提取；其它类型 None）。
fn toml_item_string(item: &toml_edit::Item) -> Option<String> {
    item.as_str().map(|s| s.to_string())
}
