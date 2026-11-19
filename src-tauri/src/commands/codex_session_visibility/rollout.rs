use serde_json::Value as JsonValue;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use super::now_epoch_millis;

const SESSION_DIR_NAMES: [&str; 2] = ["sessions", "archived_sessions"];

pub(super) fn count_rollout_files_to_update(
    data_dir: &Path,
    target_provider: &str,
) -> Result<usize, String> {
    let mut total = 0usize;
    for path in iter_rollout_files(data_dir)? {
        if rollout_file_needs_provider_update(&path, target_provider)? {
            total += 1;
        }
    }
    Ok(total)
}

pub(super) fn update_rollout_providers(
    data_dir: &Path,
    target_provider: &str,
) -> Result<usize, String> {
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
