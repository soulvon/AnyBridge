use crate::commands::config::{Provider, ProviderStore};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use toml_edit::{DocumentMut, Item, Table};

use super::buddy::codebuddy_chat_url;
use super::grok::grok_sanitize_key;
use super::platform_enum::Platform;


pub(in crate::commands::platforms) const PLATFORM_ANTIGRAVITY: &str = "antigravity";

pub(in crate::commands::platforms) const PLATFORM_ANTIGRAVITY_IDE: &str = "antigravity-ide";

pub(in crate::commands::platforms) const PLATFORM_CLAUDE_CODE: &str = "claude-code";

pub(in crate::commands::platforms) const PLATFORM_CLAUDE_DESKTOP: &str = "claude-desktop";

pub(in crate::commands::platforms) const PLATFORM_CODEX: &str = "codex";

pub(in crate::commands::platforms) const PLATFORM_CODEBUDDY: &str = "codebuddy";

pub(in crate::commands::platforms) const PLATFORM_GROK: &str = "grok";

pub(in crate::commands::platforms) const PLATFORM_OPENCODE: &str = "opencode";

pub(in crate::commands::platforms) const PLATFORM_WORKBUDDY: &str = "workbuddy";

pub(in crate::commands::platforms) const PLATFORM_ZCODE: &str = "zcode";

pub(in crate::commands::platforms) const PLATFORM_PI: &str = "pi";

pub(in crate::commands::platforms) const PLATFORM_HERMES: &str = "hermes";

pub(in crate::commands::platforms) const PLATFORM_DEEPSEEK_HARNESS: &str = "deepseek-harness";

/// AnyBridge 在 Pi 目录下维护的「已停用条目」状态文件。
/// Pi 的 provider/model 没有 enabled 概念，停用的条目写进这里而不是 models.json，
/// 这样 Pi 里不再出现，AnyBridge 表格里的停用状态也持久保留。
/// 受管平台的表格状态文件（客户端不读取它）：保存完整条目快照。
/// 用途有二：还原停用条目；补齐客户端配置格式承载不了的字段（如 Hermes 的能力/输出上限）。
pub(in crate::commands::platforms) const MANAGED_MODELS_STATE_FILE: &str = "anybridge-models-state.json";

pub(in crate::commands::platforms) const ABSENT_BACKUP_SENTINEL: &[u8] = b"__IDE_BYOK_ORIGINAL_FILE_ABSENT__\n";


// ─── 切换进度事件 ──────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub(in crate::commands::platforms) struct SwitchProgressPayload {
    pub(in crate::commands::platforms) platform: String,
    pub(in crate::commands::platforms) step: String,
    pub(in crate::commands::platforms) message: String,
}


pub(crate) fn emit_switch_progress(app: &AppHandle, platform: &str, step: &str, message: &str) {
    let _ = app.emit(
        "platform-switch-progress",
        SwitchProgressPayload {
            platform: platform.to_string(),
            step: step.to_string(),
            message: message.to_string(),
        },
    );
}


// ─── 返回给前端的结构 ──────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct PlatformInfo {
    /// 已安装版本（CLI 跑 --version / GUI 读 product.json）；
    /// None = 未安装或版本未知（读失败=未知，不编造）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// npm 包名（有 CLI spec 的平台才有，用于「检查更新」）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npm_package: Option<String>,
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub vendor: String,
    /// 该平台需要的协议格式："anthropic"（Claude Code）/ "openai"（Codex）
    #[serde(rename = "requiredApiFormat")]
    pub required_api_format: String,
    /// 是否检测到工具（配置目录存在）
    pub installed: bool,
    #[serde(rename = "configPath")]
    pub config_path: String,
    #[serde(rename = "backupExists")]
    pub backup_exists: bool,
    #[serde(rename = "currentProviderId")]
    pub current_provider_id: Option<String>,
    #[serde(rename = "currentProviderName")]
    pub current_provider_name: Option<String>,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
    #[serde(rename = "appliedAt")]
    pub applied_at: Option<String>,
    #[serde(rename = "liveProviderIds")]
    pub live_provider_ids: Vec<String>,
    #[serde(rename = "codexConfig")]
    pub codex_config: Option<CodexConfigInfo>,
    #[serde(rename = "claudeConfig")]
    pub claude_config: Option<ClaudeConfigInfo>,
    #[serde(rename = "antigravityConfig")]
    pub antigravity_config: Option<AntigravityConfigInfo>,
    /// 配置漂移（Drift）：记账中「我最后写入的值」≠ 配置文件现值的字段。
    /// 空 = 无漂移**或**无法判定（未记账/读失败=未知，前端不显示即不误报）。
    #[serde(rename = "driftedFields", default, skip_serializing_if = "Vec::is_empty")]
    pub drifted_fields: Vec<DriftField>,
    /// 检测/读取过程中的错误（如配置解析失败）
    pub error: Option<String>,
}


/// 一处配置漂移。借鉴 magpie applied.go 的 Drift，但只带 path + kind，
/// **不带值**——记账字段含 AUTH_TOKEN，把值送到前端会泄露 key 到 UI。
#[derive(Debug, Clone, Serialize)]
pub struct DriftField {
    /// JSON 路径（点号拼接，如 "env.ANTHROPIC_BASE_URL"）
    pub path: String,
    /// 漂移分类（由字段语义推断，仅用于前端文案）：
    /// "unwired"（接入地址被改走）/ "replaced"（模型被改回）/ "changed"（其它）
    pub kind: &'static str,
}


#[derive(Serialize, Clone)]
pub struct AntigravityConfigInfo {
    #[serde(rename = "cloudCodeUrl")]
    pub cloud_code_url: Option<String>,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
    #[serde(rename = "isOfficial")]
    pub is_official: bool,
}


#[derive(Serialize, Clone)]
pub struct ClaudeConfigInfo {
    pub model: Option<String>,
    #[serde(skip)]
    pub model_candidates: Vec<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "hasAuthToken")]
    pub has_auth_token: bool,
    #[serde(rename = "authTokenMasked")]
    pub auth_token_masked: Option<String>,
    #[serde(rename = "isOfficial")]
    pub is_official: bool,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
}


#[derive(Serialize, Clone)]
pub struct CodexConfigInfo {
    pub model: Option<String>,
    #[serde(rename = "modelProviderId")]
    pub model_provider_id: Option<String>,
    #[serde(rename = "providerName")]
    pub provider_name: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "wireApi")]
    pub wire_api: Option<String>,
    #[serde(rename = "hasBearerToken")]
    pub has_bearer_token: bool,
    #[serde(rename = "bearerTokenMasked")]
    pub bearer_token_masked: Option<String>,
    #[serde(rename = "bearerToken")]
    pub bearer_token: Option<String>,
    #[serde(rename = "isOfficial")]
    pub is_official: bool,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
}


#[derive(Serialize)]
pub struct SwitchResult {
    pub ok: bool,
    pub message: String,
    #[serde(rename = "configPath")]
    pub config_path: String,
    #[serde(rename = "backupPath")]
    pub backup_path: String,
}


pub(in crate::commands::platforms) fn backup_path(path: &PathBuf) -> PathBuf {
    let mut bak = path.clone();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    bak.set_file_name(format!("{name}.byok-bak"));
    bak
}


/// 幂等备份：原文件存在则复制原文件；原文件不存在则写入缺失标记，
/// 这样还原时能删除由 AnyBridge 首次创建的配置文件。
pub(in crate::commands::platforms) fn ensure_backup(path: &PathBuf) -> Result<(), String> {
    let bak = backup_path(path);
    if bak.exists() {
        return Ok(());
    }
    let content = if path.exists() {
        fs::read(path).map_err(|e| e.to_string())?
    } else {
        ABSENT_BACKUP_SENTINEL.to_vec()
    };
    crate::commands::write_atomic(&bak, &content).map_err(|e| format!("备份失败: {e}"))
}


pub(in crate::commands::platforms) fn ensure_parent_dir(path: &PathBuf) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("配置路径无父目录".to_string());
    };
    fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))
}


pub(in crate::commands::platforms) fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除 {} 失败: {e}", path.display())),
    }
}


pub(in crate::commands::platforms) fn remove_backup_if_exists(path: &PathBuf) -> Result<(), String> {
    remove_file_if_exists(&backup_path(path))
}


pub(in crate::commands::platforms) fn restore_one_file(path: &PathBuf) -> Result<bool, String> {
    let bak = backup_path(path);
    if !bak.exists() {
        return Ok(false);
    }
    let content = fs::read(&bak).map_err(|e| e.to_string())?;
    if content == ABSENT_BACKUP_SENTINEL {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_file(&bak);
        return Ok(true);
    }
    ensure_parent_dir(path)?;
    crate::commands::write_atomic(path, &content)?;
    let _ = fs::remove_file(&bak);
    Ok(true)
}


pub(in crate::commands::platforms) fn parse_json_object(raw: &str, label: &str) -> Result<Map<String, Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = json5::from_str(trimmed).map_err(|e| format!("{label} 解析失败: {e}"))?;
    match value {
        Value::Object(m) => Ok(m),
        _ => Err(format!("{label} 顶层不是对象")),
    }
}


pub(in crate::commands::platforms) fn app_data_dir(name: &str) -> Option<PathBuf> {
    let mut dir = dirs::data_dir()?;
    dir.push(name);
    Some(dir)
}


pub(in crate::commands::platforms) fn vscode_like_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir()
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::config_dir()
    }
}


pub(in crate::commands::platforms) fn now_epoch_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}


pub(in crate::commands::platforms) fn resolve_platform_config(
    plat: &Platform,
    store: &ProviderStore,
    id: &str,
) -> Result<Provider, String> {
    if matches!(plat, Platform::Antigravity | Platform::AntigravityIde) {
        if let Some(config) = store
            .antigravity_configs
            .iter()
            .find(|config| config.id == id)
        {
            config.validate_active_source(&store.providers)?;
            return Ok(config.resolve_provider(&store.providers));
        }
    }

    if matches!(plat, Platform::ClaudeCode) {
        let config = store
            .claude_code_configs
            .iter()
            .find(|config| config.id == id)
            .ok_or_else(|| format!("Claude Code 配置不存在: {id}"))?;
        config.validate_active_source(&store.providers)?;
        return Ok(config.resolve_provider(&store.providers));
    }

    if matches!(plat, Platform::Codex) {
        let config = store
            .codex_configs
            .iter()
            .find(|config| config.id == id)
            .ok_or_else(|| format!("Codex 配置不存在: {id}"))?;
        config.validate_active_source(&store.providers)?;
        return Ok(config.resolve_provider(&store.providers));
    }

    if matches!(plat, Platform::OpenCode) {
        let config = store
            .opencode_configs
            .iter()
            .find(|config| config.id == id)
            .ok_or_else(|| format!("OpenCode 配置不存在: {id}"))?;
        config.validate_active_source(&store.providers)?;
        return Ok(config.resolve_provider(&store.providers));
    }

    if matches!(plat, Platform::Grok) {
        if let Some(config) = store
            .grok_configs
            .iter()
            .find(|config| config.id == id || grok_sanitize_key(&config.id) == id)
        {
            config.validate_active_source(&store.providers)?;
            return Ok(config.resolve_provider(&store.providers));
        }
    }

    if matches!(plat, Platform::ClaudeDesktop) {
        if let Some(config) = store
            .claude_desktop_configs
            .iter()
            .find(|config| config.id == id)
        {
            config.validate_active_source(&store.providers)?;
            return Ok(config.resolve_provider(&store.providers));
        }
    }

    let p = store
        .providers
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("供应商不存在: {id}"))?;
    if !p.enabled {
        return Err(format!("供应商「{}」已禁用，请先启用后再接入", p.name));
    }
    Ok(p)
}


/// 规范化 URL：补 https://，去尾部斜杠。
pub(in crate::commands::platforms) fn normalize_url(url: &str) -> String {
    let raw = url.trim();
    let raw = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    raw.trim_end_matches('/').to_string()
}


pub(in crate::commands::platforms) fn provider_endpoint_url(p: &Provider) -> String {
    let base = normalize_url(&p.api_host);
    let Some(path) = p.api_path.as_deref() else {
        return base;
    };
    let path = path.trim();
    if path.is_empty() || path == "/" {
        return base;
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
    .trim_end_matches('/')
    .to_string()
}


pub(in crate::commands::platforms) fn strip_suffix_case_insensitive(value: &str, suffix: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if lower.ends_with(suffix) {
        let keep_len = value.len().saturating_sub(suffix.len());
        Some(value[..keep_len].trim_end_matches('/').to_string())
    } else {
        None
    }
}


pub(in crate::commands::platforms) fn strip_first_matching_suffix(value: &str, suffixes: &[&str]) -> String {
    for suffix in suffixes {
        if let Some(stripped) = strip_suffix_case_insensitive(value, suffix) {
            return stripped;
        }
    }
    value.to_string()
}


/// Claude Code 的 base_url：Claude Code 会自动加 /v1/messages，base 不应带 /v1。
/// 声明式注入用的 base URL：去掉 /v1、/messages 等端点后缀，
/// 供 CLI 的 *_BASE_URL 变量使用（如 GOOGLE_GEMINI_BASE_URL）。
pub(crate) fn declared_base_url(p: &Provider) -> String {
    strip_first_matching_suffix(
        &provider_endpoint_url(p),
        &["/v1/messages", "/messages", "/v1"],
    )
}


/// URL 是否带非空路径段（`normalize_url` 已保证有 scheme 且去掉尾斜杠）。
pub(in crate::commands::platforms) fn url_has_path_segment(url: &str) -> bool {
    match url.split_once("://") {
        Some((_, rest)) => rest.contains('/'),
        None => url.contains('/'),
    }
}


pub(in crate::commands::platforms) fn append_switch_warnings(message: &mut String, warnings: &[String]) {
    if warnings.is_empty() {
        return;
    }
    message.push_str("\n\n提示：");
    for warning in warnings {
        message.push_str("\n- ");
        message.push_str(warning);
    }
}


pub(in crate::commands::platforms) fn toml_item_string(item: &Item) -> Option<String> {
    item.as_value()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}


pub(in crate::commands::platforms) fn toml_table_string(table: &Table, key: &str) -> Option<String> {
    table.get(key).and_then(toml_item_string)
}


pub(in crate::commands::platforms) fn toml_table_bool(table: &Table, key: &str) -> bool {
    table
        .get(key)
        .and_then(Item::as_value)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}


pub(in crate::commands::platforms) fn json_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}


pub(in crate::commands::platforms) fn first_json_string(map: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let map = map?;
    keys.iter().find_map(|key| json_string(map, key))
}


pub(in crate::commands::platforms) fn json_string_candidates(map: Option<&Map<String, Value>>, keys: &[&str]) -> Vec<String> {
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in keys {
        if let Some(value) = json_string(map, key) {
            if !out.iter().any(|existing| existing == &value) {
                out.push(value);
            }
        }
    }
    out
}


pub(in crate::commands::platforms) fn agent_stash_dir() -> PathBuf {
    #[cfg(test)]
    {
        panic!("测试禁止调用 agent_stash_dir() 读写宿主机真实 agent-stash.json，请改用 *_with_stash 传入临时目录");
    }
    #[cfg(not(test))]
    {
        crate::commands::config::config_dir_path()
    }
}


pub(in crate::commands::platforms) fn merge_json_object(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, source_value) in source {
        match (target.get_mut(key), source_value) {
            (Some(Value::Object(target_obj)), Value::Object(source_obj)) => {
                merge_json_object(target_obj, source_obj);
            }
            _ => {
                target.insert(key.clone(), source_value.clone());
            }
        }
    }
}


// Hermes / DeepSeek Harness 的记账与还原待下一轮：两者是块级保形 YAML
// （整块文本替换），需专门的块级账本语义，不在本轮半成品上线。

/// TOML 顶层标量的当前值（字符串化；不存在/非字符串 → Absent）。
pub(in crate::commands::platforms) fn toml_top_current(doc: &DocumentMut, key: &str) -> crate::commands::agent_stash::Stashed {
    doc.get(key)
        .and_then(toml_item_string)
        .map(crate::commands::agent_stash::Stashed::Str)
        .unwrap_or(crate::commands::agent_stash::Stashed::Absent)
}


pub(in crate::commands::platforms) fn split_url_origin_path(input: &str) -> Option<(String, String, String)> {
    let url = reqwest::Url::parse(input).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let mut origin = format!("{}://{}", url.scheme(), url.host_str()?);
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    let path = url.path().trim_end_matches('/').to_string();
    Some((origin, host, path))
}


pub(in crate::commands::platforms) fn openai_base_url(p: &Provider) -> String {
    strip_first_matching_suffix(&codebuddy_chat_url(p), &["/chat/completions"])
}


pub(in crate::commands::platforms) fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hex::encode(hasher.finalize());
    digest[..12].to_string()
}


/// token 脱敏：保留前 6 后 4，中间用 *** 代替。
pub(in crate::commands::platforms) fn mask_key(k: &str) -> String {
    let k = k.trim();
    if k.len() <= 12 {
        return "***".into();
    }
    format!("{}***{}", &k[..6], &k[k.len() - 4..])
}


/// TOML 字符串值转义（用于预览片段里的 name）。
pub(in crate::commands::platforms) fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}


/// 单平台更新检查：已装版本 + npm 最新版本 + 是否有新版。
/// 借鉴 magpie cliupdate.go：已装版本走缓存（10 分钟），latest 走 npm
/// registry（6 小时缓存）；读失败 = None（未知），绝不编造。
#[derive(serde::Serialize)]
pub struct PlatformUpdateInfo {
    pub platform: String,
    pub installed: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub npm_package: Option<String>,
    /// 是否有官方自更新命令（claude update / grok update / hermes update…）。
    /// 无 npm 包但支持官方命令的平台（grok/hermes）靠它显示更新入口。
    pub has_self_update: bool,
    /// 环境是否允许一键安装/更新（npm 可用 + 全局前缀免提权可写）。
    /// false 时前端不展示按钮，只显示「未安装」/纯版本号。
    pub can_auto_update: bool,
    /// 更新前版本（仅 update_platform_agent 返回时非 None）：
    /// UI 用它展示「v1.3.0 → v1.4.0」或回滚后「已回到 v1.3.0」。
    pub updated_from: Option<String>,
    /// 硬校验产出的更新结论：
    /// - "unchanged"：未执行更新（check 场景），或执行了但版本没变（仍可用）
    /// - "upgraded"：版本真的前进了
    /// - "rolled_back"：更新后校验未通过，已回滚到原版本
    pub outcome: &'static str,
}


// ─── CodeBuddy 自定义模型管理命令 ────────────────────────────

#[derive(Serialize)]
pub struct ProviderModelItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "supportsToolCall")]
    pub supports_tool_call: bool,
    #[serde(rename = "supportsImages")]
    pub supports_images: bool,
    #[serde(rename = "supportsReasoning")]
    pub supports_reasoning: bool,
}


#[derive(Serialize)]
pub struct ProviderModelsEntry {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "providerName")]
    pub provider_name: String,
    pub models: Vec<ProviderModelItem>,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath")]
    pub api_path: Option<String>,
    #[serde(rename = "chatUrl")]
    pub chat_url: String,
    #[serde(rename = "apiFormat")]
    pub api_format: String,
}
