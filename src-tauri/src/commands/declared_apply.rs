//! 声明式 agent 的接入/还原（`AgentSpec` 里 `inject` 的运行时实现）。
//!
//! 目标：新 agent 在声明里写清「endpoint / api_key / model 各写到哪里」，
//! 就能一键接入——不需要为每个 agent 写一段 Rust。
//!
//! 目前支持两类落点（覆盖绝大多数 CLI）：
//! - `InjectTarget::Env { key }` → dotenv 文件（如 `~/.gemini/.env`）
//! - `InjectTarget::Json { pointer }` → JSON 配置文件（JSON Pointer 写入）
//!
//! 安全与可回滚：
//! - 首次写入前备份到 `<file>.anybridge-bak`（幂等，保留接管前原始状态）
//! - 还原 = 备份存在则写回；原先不存在则删除文件
//! - 写入走 `write_atomic`（临时文件 + rename）

use super::agent_spec::{AgentSpec, InjectTarget};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 本次接入要写入的三个值。
pub struct InjectPlan<'a> {
    pub endpoint: &'a str,
    pub api_key: &'a str,
    pub model: Option<&'a str>,
}

fn bak_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".anybridge-bak");
    PathBuf::from(s)
}

/// 幂等备份：仅当备份不存在时创建；原文件不存在则写入「原不存在」标记。
fn ensure_backup(path: &Path) -> Result<(), String> {
    let bak = bak_path(path);
    if bak.exists() {
        return Ok(());
    }
    let content = if path.exists() {
        std::fs::read(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?
    } else {
        b"__ANYBRIDGE_ABSENT__".to_vec()
    };
    super::write_atomic(&bak, &content).map_err(|e| format!("备份失败: {e}"))
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    super::write_atomic(path, content).map_err(|e| format!("写入 {} 失败: {e}", path.display()))
}

/// 写 dotenv：保留其它行与注释，替换同名 key，缺则追加。
pub fn upsert_env(content: &str, key: &str, value: &str) -> String {
    let mut out = String::new();
    let mut found = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('#') {
            if let Some((k, _)) = trimmed.split_once('=') {
                if k.trim() == key {
                    out.push_str(&format!("{key}={value}\n"));
                    found = true;
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if !found {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("{key}={value}\n"));
    }
    out
}

/// 从 dotenv 读 key 的值。
pub fn get_env(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == key {
                return Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    None
}

/// JSON Pointer 写入（`/model/name`；中间层不存在则创建对象）。
pub fn set_json_pointer(root: &mut Value, pointer: &str, value: &str) -> Result<(), String> {
    let segs: Vec<&str> = pointer.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return Err("JSON Pointer 不能为空".to_string());
    }
    let mut cur = root;
    for (i, seg) in segs.iter().enumerate() {
        let last = i == segs.len() - 1;
        if last {
            cur[seg] = Value::String(value.to_string());
            return Ok(());
        }
        if !cur[seg].is_object() {
            cur[seg] = Value::Object(serde_json::Map::new());
        }
        cur = cur.get_mut(seg).ok_or("JSON Pointer 写入失败")?;
    }
    Ok(())
}

/// 按声明写入该 agent 的 endpoint / api_key / model。返回改动过的文件路径。
pub fn apply_declared(spec: &AgentSpec, plan: &InjectPlan) -> Result<Vec<PathBuf>, String> {
    let dir = spec
        .resolve_config_dir()
        .ok_or_else(|| "无法解析配置目录".to_string())?;
    let cfg = spec.resolve_config_path();
    apply_declared_with_paths(spec, &dir, cfg.as_deref(), plan)
}

/// 路径显式版本（单测用临时目录，不碰真实配置）。
pub fn apply_declared_with_paths(
    spec: &AgentSpec,
    dir: &Path,
    config_path: Option<&Path>,
    plan: &InjectPlan,
) -> Result<Vec<PathBuf>, String> {
    let inject = spec
        .inject
        .ok_or_else(|| format!("{} 尚未声明接入方式（inject）", spec.name))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;

    let mut touched = Vec::new();

    // ① endpoint / api_key → dotenv（同文件一次写完，避免读改写三次）
    let env_targets: Vec<(&str, &str)> = [
        (inject.endpoint, plan.endpoint),
        (inject.api_key, plan.api_key),
    ]
    .into_iter()
    .filter_map(|(t, v)| match t {
        Some(InjectTarget::Env { key }) => Some((key, v)),
        _ => None,
    })
    .collect();

    if !env_targets.is_empty() {
        let env_path = dir.join(inject.env_file);
        ensure_backup(&env_path)?;
        let mut content = std::fs::read_to_string(&env_path).unwrap_or_default();
        for (key, val) in env_targets {
            content = upsert_env(&content, key, val);
        }
        write_atomic(&env_path, content.as_bytes())?;
        touched.push(env_path);
    }

    // ② model（以及可能的 JSON 型 endpoint/key） → JSON 配置文件
    let json_targets: Vec<(&str, &str)> = [
        (inject.model, plan.model.unwrap_or("")),
        (inject.endpoint, plan.endpoint),
        (inject.api_key, plan.api_key),
    ]
    .into_iter()
    .filter_map(|(t, v)| match t {
        Some(InjectTarget::Json { pointer }) if !v.is_empty() => Some((pointer, v)),
        _ => None,
    })
    .collect();

    if !json_targets.is_empty() {
        let cfg = config_path
            .ok_or_else(|| "无法解析配置文件路径".to_string())?
            .to_path_buf();
        ensure_backup(&cfg)?;
        let raw = std::fs::read_to_string(&cfg).unwrap_or_else(|_| "{}".to_string());
        let mut root: Value = if raw.trim().is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_str(&raw)
                .map_err(|e| format!("配置文件不是合法 JSON（{}）: {e}", cfg.display()))?
        };
        for (pointer, value) in json_targets {
            set_json_pointer(&mut root, pointer, value)?;
        }
        let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        write_atomic(&cfg, pretty.as_bytes())?;
        touched.push(cfg);
    }

    if touched.is_empty() {
        return Err(format!("{} 的 inject 声明没有可写字段", spec.name));
    }
    Ok(touched)
}

/// 还原：备份存在则写回；备份标记「原不存在」则删除文件。
pub fn restore_declared(spec: &AgentSpec) -> Result<(), String> {
    let dir = spec
        .resolve_config_dir()
        .ok_or_else(|| "无法解析配置目录".to_string())?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = spec.resolve_config_path() {
        candidates.push(p);
    }
    if spec.inject.is_some() {
        candidates.push(dir.join(spec.inject.map(|i| i.env_file).unwrap_or(".env")));
    }

    let mut restored = 0;
    for path in candidates {
        let bak = bak_path(&path);
        if !bak.exists() {
            continue;
        }
        let content = std::fs::read(&bak).map_err(|e| format!("读取备份失败: {e}"))?;
        if content == b"__ANYBRIDGE_ABSENT__" {
            let _ = std::fs::remove_file(&path);
        } else {
            write_atomic(&path, &content)?;
        }
        let _ = std::fs::remove_file(&bak);
        restored += 1;
    }
    if restored == 0 {
        return Err(format!("{} 没有可还原的备份", spec.name));
    }
    Ok(())
}

// ─── Tauri 命令 ───

/// 声明式接入：按 `AgentSpec.inject` 写入 endpoint / api_key / model。
/// 返回被改动的文件列表（供前端提示与「查看配置」）。
#[tauri::command]
pub fn apply_declared_agent(
    platform: String,
    endpoint: String,
    api_key: String,
    model: Option<String>,
) -> Result<Vec<String>, String> {
    let spec = super::agent_spec::find(&platform)
        .ok_or_else(|| format!("未声明的 agent: {platform}"))?;
    let touched = apply_declared(
        spec,
        &InjectPlan {
            endpoint: &endpoint,
            api_key: &api_key,
            model: model.as_deref(),
        },
    )?;
    Ok(touched
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// 声明式还原：从 `.anybridge-bak` 恢复（备份标记「原不存在」则删除）。
#[tauri::command]
pub fn restore_declared_agent(platform: String) -> Result<(), String> {
    let spec = super::agent_spec::find(&platform)
        .ok_or_else(|| format!("未声明的 agent: {platform}"))?;
    restore_declared(spec)
}

/// 一键接入（声明式平台）。
///
/// `provider_id` 指定用哪个供应商；不传则取第一个已启用且有 key 的
/// （保持「零配置可用」，同时允许用户主动选择）。
#[tauri::command]
pub fn apply_declared_platform(
    platform: String,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let spec = super::agent_spec::find(&platform)
        .ok_or_else(|| format!("未声明的 agent: {platform}"))?;
    let store = super::config::read_provider_store()?;
    let p = match provider_id.as_deref() {
        Some(id) if !id.is_empty() => store
            .providers
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("供应商不存在: {id}"))?,
        _ => store
            .providers
            .iter()
            .find(|p| p.enabled && !p.api_key.trim().is_empty())
            .ok_or_else(|| "没有可用的供应商：请先在「供应商」页添加并启用一个".to_string())?,
    };

    let endpoint = super::platforms::declared_base_url(p);
    // 模型优先用前端选择的值（用户可切换），否则用供应商默认模型
    let chosen = model
        .as_deref()
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| p.default_model.trim());
    let touched = apply_declared(
        spec,
        &InjectPlan {
            endpoint: &endpoint,
            api_key: &p.api_key,
            model: if chosen.is_empty() { None } else { Some(chosen) },
        },
    )?;

    let files: Vec<String> = touched
        .iter()
        .map(|x| x.to_string_lossy().to_string())
        .collect();
    Ok(format!(
        "已接入 {}（供应商：{}）→ 写入 {}",
        spec.name,
        p.name,
        files.join("、")
    ))
}

/// 停止接入（声明式平台）：从备份还原。
#[tauri::command]
pub fn restore_declared_platform(platform: String) -> Result<String, String> {
    let spec = super::agent_spec::find(&platform)
        .ok_or_else(|| format!("未声明的 agent: {platform}"))?;
    restore_declared(spec)?;
    Ok(format!("已还原 {} 的配置", spec.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_upsert_replaces_and_appends() {
        let src = "# comment\nFOO=1\nGOOGLE_GEMINI_BASE_URL=old\n";
        let out = upsert_env(src, "GOOGLE_GEMINI_BASE_URL", "http://127.0.0.1:8317");
        assert!(out.contains("# comment"), "注释必须保留");
        assert!(out.contains("FOO=1"), "其它键必须保留");
        assert!(out.contains("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8317"));
        assert_eq!(out.matches("GOOGLE_GEMINI_BASE_URL=").count(), 1, "不能重复");

        let out2 = upsert_env(src, "GEMINI_API_KEY", "sk-x");
        assert!(out2.contains("GEMINI_API_KEY=sk-x"), "缺则追加");
    }

    #[test]
    fn env_get_reads_value() {
        let src = "A=1\nGEMINI_API_KEY=\"sk-abc\"\n";
        assert_eq!(get_env(src, "GEMINI_API_KEY").as_deref(), Some("sk-abc"));
        assert_eq!(get_env(src, "MISSING"), None);
    }

    #[test]
    fn json_pointer_creates_nested() {
        let mut v: Value = serde_json::from_str(r#"{"a":1}"#).unwrap();
        set_json_pointer(&mut v, "/model/name", "gemini-3-pro").unwrap();
        assert_eq!(v["model"]["name"], "gemini-3-pro");
        assert_eq!(v["a"], 1, "其它字段必须保留");
    }

    #[test]
    fn json_pointer_overwrites_scalar_branch() {
        let mut v: Value = serde_json::from_str(r#"{"model":"old"}"#).unwrap();
        set_json_pointer(&mut v, "/model/name", "x").unwrap();
        assert_eq!(v["model"]["name"], "x");
    }

    /// 端到端：临时目录里走完 备份 → 写入 → 还原（不碰真实配置）
    #[test]
    fn apply_then_restore_roundtrip_in_temp_dir() {
        let spec = super::super::agent_spec::find("gemini-cli").expect("gemini-cli 应已声明");
        let dir = std::env::temp_dir().join(format!("anybridge-declared-{}", std::process::id()));
        let cfg = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        // 原文件存在，用于验证「备份 → 还原」字节级一致
        let original = r#"{"keep":true,"model":{"name":"old"}}"#;
        std::fs::write(&cfg, original).unwrap();

        let plan = InjectPlan {
            endpoint: "http://127.0.0.1:8317",
            api_key: "sk-test",
            model: Some("gemini-3-pro"),
        };
        let touched =
            apply_declared_with_paths(spec, &dir, Some(&cfg), &plan).expect("apply 应成功");
        assert!(touched.len() >= 2, "应写入 .env 与 settings.json");

        // .env 已写入两个键
        let env = std::fs::read_to_string(dir.join(".env")).unwrap();
        assert_eq!(
            get_env(&env, "GOOGLE_GEMINI_BASE_URL").as_deref(),
            Some("http://127.0.0.1:8317")
        );
        assert_eq!(get_env(&env, "GEMINI_API_KEY").as_deref(), Some("sk-test"));

        // settings.json 的 model.name 已更新，其它字段保留
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["model"]["name"], "gemini-3-pro");
        assert_eq!(v["keep"], true);

        // 还原：settings.json 回到原始内容；.env 原先不存在 → 被删除
        restore_paths(&dir, Some(&cfg), ".env").expect("restore 应成功");
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), original);
        assert!(!dir.join(".env").exists(), "原不存在的 .env 应被删除");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 还原的路径显式版本（单测用）；生产走 restore_declared
    fn restore_paths(dir: &Path, config_path: Option<&Path>, env_file: &str) -> Result<(), String> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(p) = config_path {
            candidates.push(p.to_path_buf());
        }
        candidates.push(dir.join(env_file));
        for path in candidates {
            let bak = bak_path(&path);
            if !bak.exists() {
                continue;
            }
            let content = std::fs::read(&bak).map_err(|e| e.to_string())?;
            if content == b"__ANYBRIDGE_ABSENT__" {
                let _ = std::fs::remove_file(&path);
            } else {
                write_atomic(&path, &content)?;
            }
            let _ = std::fs::remove_file(&bak);
        }
        Ok(())
    }
}
