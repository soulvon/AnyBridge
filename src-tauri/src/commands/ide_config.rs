use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

const PROXY_KEY: &str = "http.proxy";
const STRICT_SSL_KEY: &str = "http.proxyStrictSSL";
const PROXY_VALUE: &str = "http://localhost:7450";

/// 根据目标 IDE 获取 settings.json 路径
fn settings_path(target: &str) -> Option<PathBuf> {
    let ide_name = match target {
        "devin" => "Devin",
        _ => "Windsurf",
    };

    // macOS: VSCode 系 IDE 的配置在 ~/Library/Application Support/{IDE}/User/settings.json
    // dirs::config_dir() 在 macOS 返回 ~/Library/Preferences（错误），
    // 需要用 dirs::data_dir() 返回 ~/Library/Application Support
    #[cfg(target_os = "macos")]
    let mut dir = dirs::data_dir()?;

    // Windows/Linux: dirs::config_dir() 正确
    #[cfg(not(target_os = "macos"))]
    let mut dir = dirs::config_dir()?;

    dir.push(ide_name);
    dir.push("User");
    dir.push("settings.json");
    Some(dir)
}

fn backup_path(settings: &PathBuf) -> PathBuf {
    let mut p = settings.clone();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".into());
    p.set_file_name(format!("{}.byok-bak", name));
    p
}

/// 容错解析（支持注释/尾逗号），返回顶层对象
fn parse_object(raw: &str) -> Result<Map<String, Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value =
        json5::from_str(trimmed).map_err(|e| format!("settings.json 解析失败: {}", e))?;
    match value {
        Value::Object(m) => Ok(m),
        _ => Err("settings.json 顶层不是对象".into()),
    }
}

fn write_object(path: &PathBuf, obj: &Map<String, Value>) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())
}

/// 打补丁：备份原文件（幂等），写入代理配置。
/// 返回是否实际改动了 IDE 配置（用于 UI 提示是否需重启）。
pub fn patch(target: &str) -> Result<bool, String> {
    let Some(settings) = settings_path(target) else {
        return Err(format!("无法定位 {} 配置目录", target));
    };
    if !settings.exists() {
        // IDE 没装或没生成过配置；不创建文件，跳过。
        return Ok(false);
    }

    let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
    let mut obj = parse_object(&raw)?;

    let backup = backup_path(&settings);

    // 已是目标配置则无需改写。但若备份缺失（崩溃/强杀导致备份被删而补丁残留），
    // 必须补建备份，否则停止代理时 restore 会空操作，补丁永远删不掉 → IDE 断网。
    let already = obj.get(PROXY_KEY).and_then(|v| v.as_str()) == Some(PROXY_VALUE)
        && obj.get(STRICT_SSL_KEY) == Some(&Value::Bool(false));
    if already {
        if !backup.exists() {
            // 原始值已被补丁覆盖、无从恢复，备份成「移除这两个键」的状态:
            // 复制当前配置但删掉代理键，作为还原目标。
            let mut orig = obj.clone();
            orig.remove(PROXY_KEY);
            orig.remove(STRICT_SSL_KEY);
            let orig_json =
                serde_json::to_string_pretty(&Value::Object(orig)).map_err(|e| e.to_string())?;
            super::write_atomic(&backup, orig_json.as_bytes())
                .map_err(|e| format!("补建备份失败: {}", e))?;
        }
        return Ok(false);
    }

    // 幂等备份：仅当备份不存在时写入，避免把已打补丁的状态当原始值。
    if !backup.exists() {
        super::write_atomic(&backup, raw.as_bytes()).map_err(|e| format!("备份失败: {}", e))?;
    }

    obj.insert(PROXY_KEY.into(), Value::String(PROXY_VALUE.into()));
    obj.insert(STRICT_SSL_KEY.into(), Value::Bool(false));
    write_object(&settings, &obj)?;
    Ok(true)
}

/// 卸补丁：依据备份还原 http.proxy / http.proxyStrictSSL，再删除备份。
/// 无备份时，直接移除代理相关键（兜底清理，防止代理配置残留导致 IDE 断网）。
/// 幂等。
pub fn restore(target: &str) -> Result<bool, String> {
    let Some(settings) = settings_path(target) else {
        return Ok(false);
    };
    if !settings.exists() {
        return Ok(false);
    }

    let backup = backup_path(&settings);

    if backup.exists() {
        // 有备份：按备份还原，保留其余用户改动。
        let backup_raw = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
        let orig = parse_object(&backup_raw)?;

        let mut current = {
            let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
            parse_object(&raw)?
        };

        for key in [PROXY_KEY, STRICT_SSL_KEY] {
            match orig.get(key) {
                Some(v) => {
                    current.insert(key.into(), v.clone());
                }
                None => {
                    current.remove(key);
                }
            }
        }

        write_object(&settings, &current)?;
        let _ = fs::remove_file(&backup);
        Ok(true)
    } else {
        // 无备份：兜底清理——直接移除代理相关键，防止残留导致 IDE 断网。
        let raw = fs::read_to_string(&settings).map_err(|e| e.to_string())?;
        let mut current = parse_object(&raw)?;

        let had_proxy = current.get(PROXY_KEY).and_then(|v| v.as_str()) == Some(PROXY_VALUE);
        let had_ssl = current.get(STRICT_SSL_KEY) == Some(&Value::Bool(false));

        if !had_proxy && !had_ssl {
            // 配置中没有代理残留，无需操作。
            return Ok(false);
        }

        if had_proxy {
            current.remove(PROXY_KEY);
        }
        if had_ssl {
            current.remove(STRICT_SSL_KEY);
        }

        write_object(&settings, &current)?;
        Ok(true)
    }
}

// ═══════ TAURI COMMANDS ═══════

/// 打补丁（向后兼容：默认 IDE）
#[tauri::command]
pub fn patch_ide_config() -> Result<bool, String> {
    patch("windsurf")
}

/// 打补丁（支持目标 IDE）
#[tauri::command]
pub fn patch_ide_settings(target: String) -> Result<bool, String> {
    patch(&target)
}

/// 卸补丁（向后兼容：默认 IDE）
#[tauri::command]
pub fn restore_ide_config() -> Result<bool, String> {
    restore("windsurf")
}

/// 卸补丁（支持目标 IDE）
#[tauri::command]
pub fn restore_ide_settings(target: String) -> Result<bool, String> {
    restore(&target)
}
