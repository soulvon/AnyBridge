use serde_json::Value;
use serde_yaml::Value as YamlValue;
use std::fs;
use std::path::{Path, PathBuf};

use super::common::MANAGED_MODELS_STATE_FILE;


// ─── Hermes Agent / DeepSeek Harness（YAML 配置）─────────────────
//
// 两者都写 YAML，但 Hermes 的 config.yaml 是一份上千行、几乎全是文档注释的配置：
// 整体反序列化再序列化会把注释全部丢掉。因此这里只替换受管的顶层键块，
// 文件其余内容（注释、空行、其它配置）逐字保留。

/// Hermes 配置目录：HERMES_HOME > Windows `%LOCALAPPDATA%\hermes` > `~/.hermes`。
pub(crate) fn hermes_config_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("HERMES_HOME") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    if cfg!(target_os = "windows") {
        let local = std::env::var("LOCALAPPDATA")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(dirs::data_local_dir)?;
        return Some(local.join("hermes"));
    }
    Some(dirs::home_dir()?.join(".hermes"))
}


/// DeepSeek Harness home：DSH_HOME > `~/.dsh`。
pub(crate) fn deepseek_harness_home() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("DSH_HOME") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    Some(dirs::home_dir()?.join(".dsh"))
}


/// 顶层键行：无缩进、非注释、非列表项，形如 `key:` 或 `key: value`。
pub(in crate::commands::platforms) fn yaml_is_top_level_key(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let trimmed = line.trim_end();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return false;
    }
    trimmed
        .split_once(':')
        .map(|(key, _)| !key.is_empty())
        .unwrap_or(false)
}


pub(in crate::commands::platforms) fn yaml_is_comment(line: &str) -> bool {
    line.trim_start().starts_with('#')
}


/// 顶层键 `key` 的位置：键行索引 + 块结束位置（不含键行）。
pub(in crate::commands::platforms) fn yaml_top_level_block_range(lines: &[&str], key: &str) -> Option<(usize, usize)> {
    let prefix = format!("{key}:");
    let key_index = lines.iter().position(|l| {
        l.trim_end() == prefix.as_str() || (l.starts_with(&prefix) && yaml_is_top_level_key(l))
    })?;
    let mut end = lines.len();
    for i in (key_index + 1)..lines.len() {
        if yaml_is_top_level_key(lines[i]) {
            end = i;
            break;
        }
    }
    // 尾部空行与"紧贴下一个键"的顶层注释不属于本块，留给下一个键
    while end > key_index + 1 {
        let last = lines[end - 1];
        let top_comment = yaml_is_comment(last) && !last.starts_with(' ') && !last.starts_with('\t');
        if last.trim().is_empty() || top_comment {
            end -= 1;
        } else {
            break;
        }
    }
    Some((key_index, end))
}


pub(in crate::commands::platforms) fn yaml_restore_line_ending(source: &str, rendered: String) -> String {
    if source.contains("\r\n") {
        rendered.replace('\n', "\r\n")
    } else {
        rendered
    }
}


/// 替换（不存在则追加）顶层键块；文件其余内容逐字保留。
pub(in crate::commands::platforms) fn yaml_set_top_level_block(source: &str, key: &str, block: &str) -> String {
    let normalized = source.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let has_block = !block.trim().is_empty();
    let out = if let Some((key_index, end)) = yaml_top_level_block_range(&lines, key) {
        let mut out: Vec<String> = lines[..key_index].iter().map(|l| l.to_string()).collect();
        if has_block {
            // 键行可能带内联值（`custom_providers: []`），统一规范化成单独的键行
            out.push(format!("{key}:"));
            out.push(block.trim_end_matches('\n').to_string());
        }
        out.extend(lines[end..].iter().map(|l| l.to_string()));
        out.join("\n")
    } else {
        let mut out = normalized.trim_end_matches('\n').to_string();
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        if has_block {
            out.push_str(&format!("{key}:\n{block}"));
        }
        out
    };
    yaml_restore_line_ending(source, out)
}


/// 在顶层键 `section` 的块内设置标量键（保留块内其它内容与注释）。
pub(in crate::commands::platforms) fn yaml_set_scalar_in_block(source: &str, section: &str, key: &str, value: &str) -> String {
    let normalized = source.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let Some((key_index, end)) = yaml_top_level_block_range(&lines, section) else {
        return yaml_set_top_level_block(source, section, &format!("  {key}: {value}"));
    };
    let prefix = format!("  {key}:");
    let mut out: Vec<String> = Vec::new();
    let mut replaced = false;
    for (i, line) in lines.iter().enumerate() {
        if i > key_index && i < end && !replaced && line.trim_end().starts_with(&prefix) {
            out.push(format!("  {key}: {value}"));
            replaced = true;
            continue;
        }
        out.push(line.to_string());
    }
    if !replaced {
        out.insert(end, format!("  {key}: {value}"));
    }
    yaml_restore_line_ending(source, out.join("\n"))
}


/// 顶层标量键（如 credentials 的 version）。
pub(in crate::commands::platforms) fn yaml_set_top_level_scalar(source: &str, key: &str, value: &str) -> String {
    let normalized = source.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let prefix = format!("{key}:");
    let mut out: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in &lines {
        if !replaced && line.trim_end().starts_with(&prefix) && yaml_is_top_level_key(line) {
            out.push(format!("{key}: {value}"));
            replaced = true;
            continue;
        }
        out.push(line.to_string());
    }
    if !replaced {
        out.insert(0, format!("{key}: {value}"));
    }
    yaml_restore_line_ending(source, out.join("\n"))
}


/// 删除顶层键 `section` 块内的标量键（保留块内其它内容与注释）。
pub(in crate::commands::platforms) fn yaml_remove_scalar_in_block(source: &str, section: &str, key: &str) -> String {
    let normalized = source.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let Some((key_index, end)) = yaml_top_level_block_range(&lines, section) else {
        return source.to_string();
    };
    let prefix = format!("  {key}:");
    let mut out: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i > key_index && i < end && line.trim_end().starts_with(&prefix) {
            continue;
        }
        out.push(line.to_string());
    }
    yaml_restore_line_ending(source, out.join("\n"))
}


// ─── YAML 块级账本还原（Hermes / DeepSeek Harness）──────────────
//
// 这两个平台的写入器是**块级保形**（整块文本替换，注释逐字保留），
// 因此还原也走块级文本语义：账本用 Stashed::Str 存规范化块文本，
// 还原时把「当前块文本」与 applied 比较——完全一致才写回 original
// （用户接管期间动过该块则整块跳过，绝不覆盖）。这是与 JSON/TOML
// 标量语义并列的第三种账本语义，故放在 YAML 辅助函数所在的本模块。

/// 提取 `key` 顶层块的规范化文本（不存在 → None）。
pub(in crate::commands::platforms) fn yaml_block_text(root: &YamlValue, key: &str) -> Option<String> {
    let value = root.get(key)?;
    if value.is_null() {
        return None;
    }
    yaml_block_for_value(value, 2).ok()
}


/// YAML 块级/块内标量的字段级还原（通用入口）。
///
/// - `path.len()==1`：顶层块（文本比较 + `yaml_set_top_level_block` 写回；
///   original=Absent → 写空块即删除该键）
/// - `path.len()==2`：块内标量（`yaml_set_scalar_in_block` /
///   `yaml_remove_scalar_in_block` 写回）
pub(in crate::commands::platforms) fn restore_yaml_fields_via_stash(
    path: &PathBuf,
    stash_key: &crate::commands::agent_stash::StashKey,
    stash_dir: &Path,
    label: &str,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let entries = crate::commands::agent_stash::entries_for(stash_dir, stash_key)?;
    if entries.is_empty() {
        return Ok(false);
    }
    let root = parse_yaml_value(&raw, label)?;
    let mut next = raw.clone();
    let mut changed = false;

    for entry in &entries {
        match entry.path.len() {
            1 => {
                // 顶层块：文本级比较与写回
                let key = &entry.path[0];
                let now = yaml_block_text(&root, key)
                    .map(crate::commands::agent_stash::Stashed::Str)
                    .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
                if now != entry.applied {
                    continue; // 用户动过该块：整块跳过，绝不覆盖
                }
                match &entry.original {
                    crate::commands::agent_stash::Stashed::Absent => {
                        next = yaml_set_top_level_block(&next, key, "");
                    }
                    crate::commands::agent_stash::Stashed::Str(block) => {
                        next = yaml_set_top_level_block(&next, key, block);
                    }
                    _ => continue,
                }
                changed = true;
            }
            2 => {
                // 块内标量
                let block = &entry.path[0];
                let key = &entry.path[1];
                let now = root
                    .get(block)
                    .and_then(|b| b.get(key))
                    .and_then(YamlValue::as_str)
                    .map(|s| crate::commands::agent_stash::Stashed::Str(s.to_string()))
                    .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
                if now != entry.applied {
                    continue;
                }
                match &entry.original {
                    crate::commands::agent_stash::Stashed::Absent => {
                        next = yaml_remove_scalar_in_block(&next, block, key);
                    }
                    crate::commands::agent_stash::Stashed::Str(v) => {
                        next = yaml_set_scalar_in_block(&next, block, key, &yaml_scalar(v));
                    }
                    _ => continue,
                }
                changed = true;
            }
            _ => {}
        }
    }

    if !changed {
        // 无任何可还原字段（全部被用户改过）：不清账——留给下一次判断
        return Ok(true);
    }
    parse_yaml_value(&next, label)?;
    crate::commands::write_atomic(path, next.as_bytes())?;
    if let Err(e) = crate::commands::agent_stash::clear_for(stash_dir, stash_key) {
        eprintln!("[agent-stash] {label} 清账失败: {e}");
    }
    Ok(true)
}


/// 渲染为合法 YAML 标量（必要时自动加引号）。
pub(in crate::commands::platforms) fn yaml_scalar(value: &str) -> String {
    let rendered = serde_yaml::to_string(&YamlValue::String(value.to_string()))
        .unwrap_or_else(|_| format!("'{value}'"));
    rendered
        .trim()
        .trim_start_matches("---")
        .trim()
        .to_string()
}


pub(in crate::commands::platforms) fn parse_yaml_value(raw: &str, label: &str) -> Result<YamlValue, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(YamlValue::Mapping(serde_yaml::Mapping::new()));
    }
    serde_yaml::from_str(trimmed).map_err(|e| format!("解析 {label} 失败: {e}"))
}


/// 把一个 YAML 值渲染成缩进后的块文本（不含键行）。
pub(in crate::commands::platforms) fn yaml_block_for_value(value: &YamlValue, indent: usize) -> Result<String, String> {
    let rendered = serde_yaml::to_string(value).map_err(|e| format!("生成 YAML 失败: {e}"))?;
    let body = rendered.strip_prefix("---\n").unwrap_or(&rendered);
    let pad = " ".repeat(indent);
    Ok(body
        .trim_end()
        .lines()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else {
                format!("{pad}{l}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n"))
}


/// 写入完整条目快照（含停用条目）。
pub(in crate::commands::platforms) fn managed_write_state(dir: &Path, entries: &[Value]) -> Result<(), String> {
    let path = dir.join(MANAGED_MODELS_STATE_FILE);
    if entries.is_empty() {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let payload = serde_json::json!({ "models": entries });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, format!("{text}\n").as_bytes())
}


pub(in crate::commands::platforms) fn managed_read_state(dir: &Path) -> Result<Vec<Value>, String> {
    let path = dir.join(MANAGED_MODELS_STATE_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取模型状态文件失败: {e}"))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("模型状态文件损坏（{e}），请检查 {path:?}"))?;
    Ok(value
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}


pub(in crate::commands::platforms) fn entry_string(entry: &Value, key: &str) -> String {
    entry
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}


pub(in crate::commands::platforms) fn entry_bool(entry: &Value, key: &str) -> bool {
    entry.get(key).and_then(Value::as_bool).unwrap_or(false)
}
