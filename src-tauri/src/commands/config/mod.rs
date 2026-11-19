use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

mod conversions;
mod probe_conn;
mod probe_vision;
mod types;

pub use probe_conn::*;
pub use probe_vision::*;
pub(crate) use conversions::infer_wire_api_from_api_path;
pub use types::*;

pub(super) const APP_USER_AGENT: &str = concat!("AnyBridge/", env!("CARGO_PKG_VERSION"));
pub(super) const APP_CONFIG_DIR_NAME: &str = "anybridge";
pub(super) const LEGACY_CONFIG_DIR_NAME: &str = "ide-byok";
pub(crate) const DEFAULT_PROXY_PORT: u16 = 7450;
pub(crate) const DEFAULT_INFERENCE_PORT: u16 = 7451;
/// Antigravity 专用 HTTPS 端点端口（与 sidecar hybrid-server.js 的
/// ANTIGRAVITY_HTTPS_PORT 严格对齐）。LS 对明文 HTTP 端点会隐藏
/// boost / teamwork-preview 等高级命令，必须以 https://localhost 接入。
pub(crate) const DEFAULT_ANTIGRAVITY_HTTPS_PORT: u16 = 7452;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ConfiguredProxyPorts {
    pub api_port: u16,
    pub inference_port: u16,
    pub antigravity_https_port: u16,
}

/// 平台配置根目录（与 sidecar lib/config-dir.js 的 appConfigDir 严格对齐）：
///   Windows: %APPDATA%   macOS: ~/Library/Application Support   Linux: $XDG_CONFIG_HOME 或 ~/.config
///
/// dirs 只有在 HOME / APPDATA / XDG_CONFIG_HOME 全部拿不到时才返回 None，
/// 此时逐级退回用户主目录下的标准位置。这里刻意不优先退回当前工作目录：
/// 桌面应用的 cwd 由启动方式决定（Windows 从开始菜单启动是安装目录，macOS 从 Finder 启动是 /），
/// 配置写到那里会表现为「保存成功却再也找不到」，还会污染系统目录。
/// 最后一环的 "." 只有连主目录都拿不到时才可能命中，那时已无可靠落点。
pub(super) fn config_base_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join("Library").join("Application Support")))
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    #[cfg(not(target_os = "macos"))]
    {
        dirs::config_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

pub(super) fn named_config_dir(name: &str) -> PathBuf {
    config_base_dir().join(name)
}

pub(super) fn copy_dir_missing(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| format!("创建配置目录失败: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取旧配置目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取旧配置项失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if dst_path.exists() {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取旧配置项类型失败: {}", e))?;
        if file_type.is_dir() {
            copy_dir_missing(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "迁移配置文件失败: {} -> {} ({})",
                    src_path.to_string_lossy(),
                    dst_path.to_string_lossy(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

pub(super) fn migrate_legacy_config_dir(new_dir: &Path) {
    let legacy_dir = named_config_dir(LEGACY_CONFIG_DIR_NAME);
    if legacy_dir == new_dir || !legacy_dir.exists() {
        return;
    }
    if let Err(e) = copy_dir_missing(&legacy_dir, new_dir) {
        eprintln!("[config] legacy config migration skipped: {}", e);
    }
}

pub(super) fn parse_byok_config_dir_override(raw: Option<&str>) -> Option<PathBuf> {
    raw.map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(PathBuf::from)
}

pub(super) fn resolve_config_dir_with_override(
    raw: Option<&str>,
    default_dir: &Path,
) -> (PathBuf, bool) {
    if let Some(dir) = parse_byok_config_dir_override(raw) {
        return (dir, true);
    }
    (default_dir.to_path_buf(), false)
}

fn byok_config_dir_override() -> Option<PathBuf> {
    let raw = std::env::var("BYOK_CONFIG_DIR").ok();
    parse_byok_config_dir_override(raw.as_deref())
}

pub(super) fn config_dir() -> PathBuf {
    let raw = std::env::var("BYOK_CONFIG_DIR").ok();
    let default_dir = named_config_dir(APP_CONFIG_DIR_NAME);
    let (dir, overridden) = resolve_config_dir_with_override(raw.as_deref(), &default_dir);
    if !overridden {
        migrate_legacy_config_dir(&dir);
    }
    dir
}

pub(super) fn config_path() -> PathBuf {
    config_dir().join("byok-config.json")
}

pub(crate) fn providers_path() -> PathBuf {
    config_dir().join("providers.json")
}

pub fn config_dir_path() -> PathBuf {
    config_dir()
}

/// 是否默认启动网关。byok-config.json 里 AUTO_START_PROXY=true 时返回 true，
/// 没设置或解析失败默认 true（用户期望默认启动）。
pub fn is_auto_start_proxy_enabled() -> bool {
    read_config_value("AUTO_START_PROXY")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !(v == "false" || v == "0" || v == "off" || v == "no")
        })
        .unwrap_or(true)
}

pub(super) fn parse_port(value: Option<&String>, fallback: u16) -> u16 {
    value
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(fallback)
}

pub(super) fn read_port(values: &BTreeMap<String, String>, keys: &[&str], fallback: u16) -> u16 {
    for key in keys {
        if values.contains_key(*key) {
            return parse_port(values.get(*key), fallback);
        }
    }
    fallback
}

pub(crate) fn configured_proxy_ports() -> ConfiguredProxyPorts {
    let values = load_config_sync().unwrap_or_default();
    ConfiguredProxyPorts {
        api_port: read_port(
            &values,
            &["PROXY_PORT", "LOCAL_PROXY_PORT"],
            DEFAULT_PROXY_PORT,
        ),
        inference_port: read_port(
            &values,
            &["INFERENCE_PORT", "LOCAL_INFERENCE_PORT"],
            DEFAULT_INFERENCE_PORT,
        ),
        antigravity_https_port: std::env::var("ANTIGRAVITY_HTTPS_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|&p| p >= 1)
            .unwrap_or(DEFAULT_ANTIGRAVITY_HTTPS_PORT),
    }
}

/// 读取杂项配置中的单个键（探测 Windsurf 路径缓存等内部用途）。
pub(crate) fn read_config_value(key: &str) -> Option<String> {
    let path = config_path();
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let cfg: ByokConfig = serde_json::from_str(&raw).ok()?;
    cfg.values.get(key).cloned()
}

/// 写入杂项配置中的单个键（保留其余键）。失败仅返回 Err，调用方按需忽略。
pub(crate) fn write_config_value(key: &str, value: &str) -> Result<(), String> {
    let path = config_path();
    crate::commands::store_io::with_file_lock(&path, || {
        let mut values = load_config_sync_unlocked().unwrap_or_default();
        values.insert(key.to_string(), value.to_string());
        save_config_sync_unlocked(values)
    })
}

// ─── 杂项配置（系统提示词开关等，非供应商字段）────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ByokConfig {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

fn load_config_from_unlocked(path: &Path) -> Result<BTreeMap<String, String>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let cfg: ByokConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(cfg.values)
}

fn save_config_to_unlocked(path: &Path, values: BTreeMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let cfg = ByokConfig { values };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
}

fn load_config_sync_unlocked() -> Result<BTreeMap<String, String>, String> {
    load_config_from_unlocked(&config_path())
}

fn save_config_sync_unlocked(values: BTreeMap<String, String>) -> Result<(), String> {
    save_config_to_unlocked(&config_path(), values)
}

fn generate_random_hex_key(prefix: &str) -> String {
    let mut bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
}

/// 在指定配置文件中确保 `LOCAL_PROXY_KEY` 已存在（进程内 Mutex + 跨进程 `.lock` 文件锁保护）。
/// 若已存在非空值则直接返回；否则用 `OsRng` 生成 `byok-<48hex>` 并经 `write_atomic` 落盘（保留其它字段）。
pub(crate) fn ensure_local_proxy_key_at(config_file: &Path) -> Result<String, String> {
    crate::commands::store_io::with_file_lock(config_file, || {
        let mut values = load_config_from_unlocked(config_file)?;
        if let Some(existing) = values
            .get("LOCAL_PROXY_KEY")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            return Ok(existing.to_string());
        }
        let key = generate_random_hex_key("byok-");
        values.insert("LOCAL_PROXY_KEY".to_string(), key.clone());
        save_config_to_unlocked(config_file, values)?;
        Ok(key)
    })
}

/// 确保本地网关鉴权密钥 `LOCAL_PROXY_KEY` 可用（唯一权威入口）。
///
/// - 若设置了非空 `BYOK_CONFIG_DIR`：在沙箱配置目录内调用 `ensure_local_proxy_key_at(&config_path())`；
/// - 单测未设置 `BYOK_CONFIG_DIR`：通过 `OnceLock` 返回进程内稳定随机 `byok-test-<hex>`，
///   既避免读取宿主机真实 `%APPDATA%/anybridge`，也防止并发修改进程环境引发竞态；
/// - 生产环境未设置覆盖目录：调用 `ensure_local_proxy_key_at(&config_path())` 按需生成并落盘。
pub(crate) fn ensure_local_proxy_key() -> Result<String, String> {
    if byok_config_dir_override().is_some() {
        return ensure_local_proxy_key_at(&config_path());
    }

    #[cfg(test)]
    {
        static TEST_KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        Ok(TEST_KEY
            .get_or_init(|| generate_random_hex_key("byok-test-"))
            .clone())
    }

    #[cfg(not(test))]
    {
        ensure_local_proxy_key_at(&config_path())
    }
}

pub(crate) fn load_config_sync() -> Result<BTreeMap<String, String>, String> {
    crate::commands::store_io::with_file_lock(&config_path(), load_config_sync_unlocked)
}

pub(crate) fn save_config_sync(values: BTreeMap<String, String>) -> Result<(), String> {
    crate::commands::store_io::with_file_lock(&config_path(), || save_config_sync_unlocked(values))
}

#[tauri::command]
pub async fn load_config() -> Result<BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(load_config_sync)
        .await
        .map_err(|e| format!("读取配置任务失败: {e}"))?
}

#[tauri::command]
pub async fn save_config(values: BTreeMap<String, String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_config_sync(values))
        .await
        .map_err(|e| format!("保存配置任务失败: {e}"))?
}

pub(crate) fn read_provider_store() -> Result<ProviderStore, String> {
    crate::commands::store_io::read_provider_store_at(&providers_path())
}

/// 收敛「当前密钥」与「密钥池」的一致性。
///
/// 所有写入路径（保存、启停、导入、迁移）都经过 `write_provider_store`，
/// 一致性只在这一处收敛——前端整体覆盖 `save_providers` 时不会留下
/// 「apiKey 不在池里」这种自相矛盾的状态。
///
/// 规则：
/// 1. 空 key 与重复项剔除；
/// 2. 当前 `api_key` 非空时，保证它在池里且排第一（当前生效项优先）；
/// 3. `api_key` 为空而入池里有启用项时，用第一个启用项补上；
/// 4. 池里全是停用项时不动 `api_key`——用户可能只是临时停用，不要替他挑。
pub(crate) fn normalize_provider_api_keys(store: &mut ProviderStore) {
    for provider in &mut store.providers {
        let current = provider.api_key.trim().to_string();
        let mut seen = std::collections::HashSet::new();
        let mut kept: Vec<ProviderApiKey> = Vec::new();

        if !current.is_empty() {
            seen.insert(current.clone());
            kept.push(ProviderApiKey {
                id: String::new(),
                label: String::new(),
                key: current.clone(),
                enabled: true,
            });
        }

        for entry in provider.api_keys.drain(..) {
            let key = entry.key.trim().to_string();
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            kept.push(ProviderApiKey { key, ..entry });
        }

        if current.is_empty() {
            if let Some(idx) = kept.iter().position(|entry| entry.enabled) {
                provider.api_key = kept[idx].key.clone();
                // 它已经是当前生效密钥，池里不再留重复项
                kept.remove(idx);
            }
        }

        // 补齐稳定 id：前端列表靠它做 DOM 复用，空 id 会让删除按钮错位。
        for (idx, entry) in kept.iter_mut().enumerate() {
            if entry.id.trim().is_empty() {
                entry.id = format!("key-{}", idx + 1);
            }
        }

        provider.api_keys = kept;
    }
}

#[tauri::command]
pub async fn load_providers() -> Result<ProviderStore, String> {
    tauri::async_runtime::spawn_blocking(read_provider_store)
        .await
        .map_err(|e| format!("读取供应商配置任务失败: {e}"))?
}

/// 整体保存供应商列表（新增/编辑/删除/排序/启用禁用统一走这里）。
#[tauri::command]
pub async fn save_providers(mut store: ProviderStore) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 先收敛一次，后续同步路由要用到补齐后的池（写盘时内部还会再收敛一次，幂等）
        normalize_provider_api_keys(&mut store);
        let synced_providers = crate::commands::store_io::update_provider_store(|current| {
            *current = store;
            Ok((true, current.providers.clone()))
        })?;

        // 多密钥池 → 内置模型路由目标：在释放 providers.json 锁后再同步，避免嵌套锁。
        match crate::commands::proxy_routes::sync_provider_api_keys(&synced_providers) {
            Ok(0) => {}
            Ok(count) => eprintln!("[providers] 已同步多密钥池到 {count} 个路由目标"),
            Err(err) => eprintln!("[providers] 同步多密钥池到内置模型路由失败: {err}"),
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("保存供应商配置任务失败: {e}"))?
}

/// 启用/禁用单个供应商。禁用的供应商在「目标配置」下拉里不出现，路由也会跳过。
#[tauri::command]
pub async fn set_provider_enabled(id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::commands::store_io::update_provider_store(|store| {
            let p = store
                .providers
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("供应商不存在: {}", id))?;
            p.enabled = enabled;
            Ok((true, ()))
        })
    })
    .await
    .map_err(|e| format!("更新供应商启用状态任务失败: {e}"))?
}

pub(super) fn provider_unlock_config(kind: &str) -> Result<ProviderUnlockConfig, String> {
    let now = chrono::Utc::now().to_rfc3339();
    match kind {
        "codex" => Ok(ProviderUnlockConfig {
            enabled: true,
            unlocked_at: now,
            wire_api: "/v1/responses".to_string(),
            include: Some(serde_json::json!(["reasoning.encrypted_content"])),
        }),
        "claudeCode" => Ok(ProviderUnlockConfig {
            enabled: true,
            unlocked_at: now,
            wire_api: "/v1/messages?beta=true".to_string(),
            include: None,
        }),
        _ => Err(format!("不支持的解锁类型: {}", kind)),
    }
}

pub(super) fn normalize_provider_unlock_kind(kind: &str) -> Result<&'static str, String> {
    match kind.trim() {
        "codex" | "Codex" => Ok("codex"),
        "claudeCode" | "claude-code" | "claude_code" | "ClaudeCode" => Ok("claudeCode"),
        other => Err(format!("不支持的解锁类型: {}", other)),
    }
}

/// 设置供应商解锁项。解锁后，网关转发链路可以复用对应平台的请求模板。
#[tauri::command]
pub async fn set_provider_unlock(
    provider_id: String,
    kind: String,
    enabled: bool,
) -> Result<Provider, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = normalize_provider_unlock_kind(&kind)?;
        crate::commands::store_io::update_provider_store(|store| {
            let provider = store
                .providers
                .iter_mut()
                .find(|p| p.id == provider_id)
                .ok_or_else(|| format!("供应商不存在: {}", provider_id))?;

            if enabled {
                let config = provider_unlock_config(kind)?;
                match kind {
                    "codex" => provider.unlocks.codex = Some(config),
                    "claudeCode" => provider.unlocks.claude_code = Some(config),
                    _ => unreachable!(),
                }
            } else {
                match kind {
                    "codex" => provider.unlocks.codex = None,
                    "claudeCode" => provider.unlocks.claude_code = None,
                    _ => unreachable!(),
                }
            }

            Ok((true, provider.clone()))
        })
    })
    .await
    .map_err(|e| format!("更新供应商解锁状态任务失败: {e}"))?
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod fetch_models_probe {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn probe_multi2api_models() {
        let key = std::env::var("PROBE_KEY").unwrap_or_default();
        for fmt in ["anthropic", "openai", "gemini"] {
            let args = FetchModelsArgs {
                host: "http://127.0.0.1:7863".into(),
                api_key: key.clone(),
                path: Some("/v1".into()),
                api_format: Some(fmt.into()),
            };
            match fetch_models(args).await {
                Ok(r) => println!("[{fmt}] ok, {} models, first={:?}", r.models.len(), r.models.first()),
                Err(e) => println!("[{fmt}] ERR: {}", e),
            }
        }
    }
}
