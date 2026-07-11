use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

const APP_USER_AGENT: &str = concat!("AnyBridge/", env!("CARGO_PKG_VERSION"));
const APP_CONFIG_DIR_NAME: &str = "anybridge";
const LEGACY_CONFIG_DIR_NAME: &str = "ide-byok";
pub(crate) const DEFAULT_PROXY_PORT: u16 = 7450;
pub(crate) const DEFAULT_INFERENCE_PORT: u16 = 7451;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ConfiguredProxyPorts {
    pub api_port: u16,
    pub inference_port: u16,
}

fn config_base_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
    }

    #[cfg(not(target_os = "macos"))]
    {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
    }
}

fn named_config_dir(name: &str) -> PathBuf {
    config_base_dir().join(name)
}

fn copy_dir_missing(src: &Path, dst: &Path) -> Result<(), String> {
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

fn migrate_legacy_config_dir(new_dir: &Path) {
    let legacy_dir = named_config_dir(LEGACY_CONFIG_DIR_NAME);
    if legacy_dir == new_dir || !legacy_dir.exists() {
        return;
    }
    if let Err(e) = copy_dir_missing(&legacy_dir, new_dir) {
        eprintln!("[config] legacy config migration skipped: {}", e);
    }
}

fn config_dir() -> PathBuf {
    let dir = named_config_dir(APP_CONFIG_DIR_NAME);
    migrate_legacy_config_dir(&dir);
    dir
}

fn config_path() -> PathBuf {
    config_dir().join("byok-config.json")
}

fn providers_path() -> PathBuf {
    config_dir().join("providers.json")
}

pub fn config_dir_path() -> PathBuf {
    config_dir()
}

/// 是否默认启动代理。byok-config.json 里 AUTO_START_PROXY=true 时返回 true，
/// 没设置或解析失败默认 true（用户期望默认启动）。
pub fn is_auto_start_proxy_enabled() -> bool {
    read_config_value("AUTO_START_PROXY")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !(v == "false" || v == "0" || v == "off" || v == "no")
        })
        .unwrap_or(true)
}

fn parse_port(value: Option<&String>, fallback: u16) -> u16 {
    value
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(fallback)
}

fn read_port(values: &BTreeMap<String, String>, keys: &[&str], fallback: u16) -> u16 {
    for key in keys {
        if values.contains_key(*key) {
            return parse_port(values.get(*key), fallback);
        }
    }
    fallback
}

pub(crate) fn configured_proxy_ports() -> ConfiguredProxyPorts {
    let values = load_config().unwrap_or_default();
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
    let mut values = load_config().unwrap_or_default();
    values.insert(key.to_string(), value.to_string());
    save_config(values)
}

// ─── 杂项配置（系统提示词开关等，非供应商字段）────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ByokConfig {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

#[tauri::command]
pub fn load_config() -> Result<BTreeMap<String, String>, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cfg: ByokConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(cfg.values)
}

#[tauri::command]
pub fn save_config(values: BTreeMap<String, String>) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = ByokConfig { values };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    super::write_atomic(&config_path(), json.as_bytes())
}

// ─── 供应商 profile（多套命名配置 + 当前激活指针）──────────────

/// API 协议格式。供应商本身不再拥有全局协议；该类型只用于调用点参数和旧数据兼容。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApiFormat {
    Anthropic,
    Openai,
}

impl Default for ApiFormat {
    fn default() -> Self {
        ApiFormat::Anthropic
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(rename = "apiFormat", default, skip_serializing)]
    pub api_format: ApiFormat,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
    /// 模型级别的能力标记（vision / tools），键为模型 ID。
    #[serde(rename = "modelCaps", default)]
    pub model_caps: HashMap<String, ModelCaps>,
    /// 供应商解锁配置：解锁后可被代理转发链路复用到其他平台。
    #[serde(default, skip_serializing_if = "ProviderUnlocks::is_empty")]
    pub unlocks: ProviderUnlocks,
    /// Codex 专有：wire_api 模式 ("responses" 或 "chat")
    #[serde(rename = "wireApi", default, skip_serializing_if = "String::is_empty")]
    pub wire_api: String,
    /// Codex 专有：是否走本地代理（默认 true）
    #[serde(rename = "routeThroughProxy", default = "default_true")]
    pub route_through_proxy: bool,
    /// Codex 专有：是否 CDP 注入让 Desktop 显示所有模型（默认 true）
    #[serde(rename = "injectModels", default = "default_true")]
    pub inject_models: bool,
    /// Codex 专有：保留官方登录态（requires_openai_auth=true），无需 CDP 注入即可显示官方模型
    #[serde(rename = "preserveOfficialAuth", default)]
    pub preserve_official_auth: bool,
    /// Codex 专有：统一会话历史（切回官方时保留 model_provider 标签）
    #[serde(rename = "unifySessionHistory", default = "default_true")]
    pub unify_session_history: bool,
    /// Codex 专有：自定义模型目录
    #[serde(
        rename = "modelCatalog",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub model_catalog: Vec<ModelCatalogEntry>,
    /// Codex 专有：Chat 模式 reasoning 配置
    #[serde(
        rename = "codexChatReasoning",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_chat_reasoning: Option<CodexChatReasoningConfig>,
    /// Codex 专有：配置级子代理全局调度配置
    #[serde(
        rename = "agentsConfig",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agents_config: Option<AgentsGlobalConfig>,
    /// Codex 专有：配置级子代理定义
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<CodexAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderUnlocks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<ProviderUnlockConfig>,
    #[serde(
        rename = "claudeCode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub claude_code: Option<ProviderUnlockConfig>,
}

impl ProviderUnlocks {
    pub fn is_empty(&self) -> bool {
        self.codex.is_none() && self.claude_code.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderUnlockConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "unlockedAt")]
    pub unlocked_at: String,
    #[serde(rename = "wireApi")]
    pub wire_api: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAgent {
    pub name: String,
    pub description: String,
    #[serde(rename = "developerInstructions")]
    pub developer_instructions: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(
        rename = "modelReasoningEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub model_reasoning_effort: Option<String>,
    #[serde(
        rename = "sandboxMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sandbox_mode: Option<String>,
    #[serde(
        rename = "nicknameCandidates",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub nickname_candidates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsGlobalConfig {
    #[serde(rename = "maxThreads", default = "default_agent_max_threads")]
    pub max_threads: usize,
    #[serde(rename = "maxDepth", default = "default_agent_max_depth")]
    pub max_depth: usize,
    #[serde(rename = "jobMaxRuntimeSeconds", default = "default_agent_job_timeout")]
    pub job_max_runtime_seconds: u64,
}

fn default_agent_max_threads() -> usize {
    6
}

fn default_agent_max_depth() -> usize {
    1
}

fn default_agent_job_timeout() -> u64 {
    1800
}

impl Default for AgentsGlobalConfig {
    fn default() -> Self {
        Self {
            max_threads: default_agent_max_threads(),
            max_depth: default_agent_max_depth(),
            job_max_runtime_seconds: default_agent_job_timeout(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(
        rename = "sourceProviderId",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub source_provider_id: String,
    #[serde(
        rename = "sourceProviderName",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub source_provider_name: String,
    /// Codex wire_api: "responses" (默认) 或 "chat"。
    /// chat 模式下，本地代理将 Responses 请求转为 Chat Completions 格式发往上游。
    #[serde(rename = "wireApi", default = "default_wire_api")]
    pub wire_api: String,
    /// 是否走本地代理（默认 true）。
    /// 关 = Codex 直接连接供应商原 URL；开 = 走 AnyBridge 本地代理（127.0.0.1:7450）。
    #[serde(rename = "routeThroughProxy", default = "default_true")]
    pub route_through_proxy: bool,
    /// Codex Desktop 注入解锁脚本让所有模型在 picker 显示（默认 true）。
    /// 关 = Desktop 只能切换默认模型；CLI 不受影响。
    #[serde(rename = "injectModels", default = "default_true")]
    pub inject_models: bool,
    /// 保留官方登录态（requires_openai_auth=true），无需 CDP 注入即可显示官方模型。
    /// 仅适用于提供官方模型名的第三方渠道商。
    #[serde(rename = "preserveOfficialAuth", default)]
    pub preserve_official_auth: bool,
    /// 统一会话历史：切回官方配置时保留 model_provider 标签，使官方与第三方会话历史在同一桶中显示。
    #[serde(rename = "unifySessionHistory", default = "default_true")]
    pub unify_session_history: bool,
    /// 自定义模型目录，让 Codex 显示自定义模型列表。
    #[serde(
        rename = "modelCatalog",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub model_catalog: Vec<ModelCatalogEntry>,
    /// Codex Chat 模式的 reasoning 推理参数配置。
    #[serde(
        rename = "codexChatReasoning",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_chat_reasoning: Option<CodexChatReasoningConfig>,
    /// Codex 配置级子代理全局调度配置。
    #[serde(
        rename = "agentsConfig",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agents_config: Option<AgentsGlobalConfig>,
    /// Codex 配置级子代理定义。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<CodexAgent>,
}

fn default_wire_api() -> String {
    "responses".to_string()
}

fn default_true() -> bool {
    true
}

/// 模型目录条目：让 Codex 显示自定义模型列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalogEntry {
    /// 模型 ID（如 "deepseek-v4-flash"）
    pub model: String,
    /// 显示名称（可选，与 model 相同时省略）
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
    /// 上下文窗口大小（可选，默认 128000）
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Option<u64>,
}

/// Codex Chat 模式的 reasoning 推理参数配置。
/// 控制将 Codex Responses 格式的 reasoning.effort 转换为上游 Chat API 期望的参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexChatReasoningConfig {
    /// 是否支持 thinking 参数注入
    #[serde(rename = "supportsThinking", default)]
    pub supports_thinking: Option<bool>,
    /// 是否支持 reasoning_effort 参数
    #[serde(rename = "supportsEffort", default)]
    pub supports_effort: Option<bool>,
    /// thinking 参数名："thinking" / "enable_thinking" / "reasoning_split" / "none"
    #[serde(
        rename = "thinkingParam",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thinking_param: Option<String>,
    /// effort 参数名："reasoning_effort" / "reasoning.effort" / "none"
    #[serde(
        rename = "effortParam",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub effort_param: Option<String>,
    /// effort 值映射模式："passthrough" / "deepseek" / "low_high" / "openrouter"
    #[serde(
        rename = "effortValueMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub effort_value_mode: Option<String>,
    /// reasoning 输出格式："reasoning_content" / "reasoning" / "reasoning_details" / "auto"
    #[serde(
        rename = "outputFormat",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub output_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(
        rename = "settingsConfig",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub settings_config: Option<serde_json::Value>,
    #[serde(
        rename = "sourceProviderId",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub source_provider_id: String,
    #[serde(
        rename = "sourceProviderName",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub source_provider_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(
        rename = "settingsConfig",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub settings_config: Option<serde_json::Value>,
    #[serde(
        rename = "sourceProviderId",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub source_provider_id: String,
    #[serde(
        rename = "sourceProviderName",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub source_provider_name: String,
}

impl From<CodexConfig> for Provider {
    fn from(config: CodexConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: ApiFormat::Openai,
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
            },
            model_caps: HashMap::new(),
            unlocks: ProviderUnlocks::default(),
            wire_api: config.wire_api,
            route_through_proxy: config.route_through_proxy,
            inject_models: config.inject_models,
            preserve_official_auth: config.preserve_official_auth,
            unify_session_history: config.unify_session_history,
            model_catalog: config.model_catalog,
            codex_chat_reasoning: config.codex_chat_reasoning,
            agents_config: config.agents_config,
            agents: config.agents,
        }
    }
}

impl From<OpenCodeConfig> for Provider {
    fn from(config: OpenCodeConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: ApiFormat::Openai,
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
            },
            model_caps: HashMap::new(),
            unlocks: ProviderUnlocks::default(),
            wire_api: String::new(),
            route_through_proxy: true,
            inject_models: true,
            preserve_official_auth: false,
            unify_session_history: true,
            model_catalog: Vec::new(),
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
        }
    }
}

impl From<ClaudeCodeConfig> for Provider {
    fn from(config: ClaudeCodeConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: ApiFormat::Anthropic,
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
            },
            model_caps: HashMap::new(),
            unlocks: ProviderUnlocks::default(),
            wire_api: String::new(),
            route_through_proxy: true,
            inject_models: true,
            preserve_official_auth: false,
            unify_session_history: true,
            model_catalog: Vec::new(),
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
        }
    }
}

/// 单个模型的能力标记
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCaps {
    #[serde(default = "default_true")]
    pub vision: bool,
    #[serde(default = "default_true")]
    pub tools: bool,
}

impl Default for ModelCaps {
    fn default() -> Self {
        Self {
            vision: true,
            tools: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    #[serde(default = "default_true")]
    pub text: bool,
    #[serde(default = "default_true")]
    pub stream: bool,
    #[serde(default = "default_true")]
    pub vision: bool,
    #[serde(default = "default_true")]
    pub tools: bool,
    /// gzip 压缩请求体：绕过中转站 Cloudflare WAF 对明文 body 的命令注入检测。
    /// 默认关闭（One-Hub 等不支持 gzip 的端点会 400）。
    #[serde(default)]
    pub gzip: bool,
}

impl Default for ProviderCapabilities {
    fn default() -> Self {
        Self {
            text: true,
            stream: true,
            vision: true,
            tools: true,
            gzip: false,
        }
    }
}

/// 「更多平台」每个平台的接管状态：记录当前应用了哪个供应商。
/// key 为平台 id（"claude-code" | "codex"），随 providers.json 持久化。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlatformState {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "appliedAt", default)]
    pub applied_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderStore {
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// Codex 专用配置。它们不是供应商，只是基于某个 OpenAI 供应商生成/编辑的 Codex 写入配置。
    #[serde(
        rename = "codexConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub codex_configs: Vec<CodexConfig>,
    /// OpenCode 专用配置。它们不是供应商，只是基于某个 OpenAI 供应商生成/编辑的 OpenCode live provider。
    #[serde(
        rename = "opencodeConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub opencode_configs: Vec<OpenCodeConfig>,
    /// Claude Code 专用配置。它们不是供应商，只是基于某个 Anthropic 供应商生成/编辑的写入配置。
    #[serde(
        rename = "claudeCodeConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub claude_code_configs: Vec<ClaudeCodeConfig>,
    // `current`/激活概念已废弃，改用每槽位 targets 故障转移。保留字段仅为兼容旧文件反序列化，不再读写。
    #[serde(default, skip_serializing)]
    #[allow(dead_code)]
    pub current: String,
    /// 「更多平台」状态：claude-code / codex 各自当前应用的供应商。空时不写入文件，向后兼容旧 providers.json。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub platforms: BTreeMap<String, PlatformState>,
}

pub(crate) fn read_provider_store() -> Result<ProviderStore, String> {
    let path = providers_path();
    if !path.exists() {
        return Ok(ProviderStore::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut store: ProviderStore =
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;

    // 迁移之前错误混入 providers 的 Codex 配置。优先识别 meta.codexConfig；
    // 对已被 Rust 旧结构丢掉 meta 的记录，再识别本功能生成的 codex-<timestamp>-* ID。
    if let Some(raw_providers) = value.get("providers").and_then(|v| v.as_array()) {
        let mut migrated_ids = std::collections::BTreeSet::new();
        let mut migrated_configs = Vec::new();
        for raw_provider in raw_providers {
            let id = raw_provider
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let meta_codex = raw_provider
                .get("meta")
                .and_then(|m| m.get("codexConfig"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let generated_codex_id = id
                .strip_prefix("codex-")
                .and_then(|rest| rest.chars().next())
                .map(|ch| ch.is_ascii_digit())
                .unwrap_or(false);
            if !meta_codex && !generated_codex_id {
                continue;
            }

            let mut config: CodexConfig =
                serde_json::from_value(raw_provider.clone()).map_err(|e| e.to_string())?;
            if config.source_provider_id.is_empty() {
                config.source_provider_id = raw_provider
                    .get("meta")
                    .and_then(|m| m.get("sourceProviderId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
            }
            migrated_ids.insert(id.to_string());
            migrated_configs.push(config);
        }

        if !migrated_ids.is_empty() {
            store.providers.retain(|p| !migrated_ids.contains(&p.id));
            for config in migrated_configs {
                if !store.codex_configs.iter().any(|c| c.id == config.id) {
                    store.codex_configs.push(config);
                }
            }
        }
    }

    Ok(store)
}

pub(crate) fn write_provider_store(store: &ProviderStore) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    super::write_atomic(&providers_path(), json.as_bytes())
}

#[tauri::command]
pub fn load_providers() -> Result<ProviderStore, String> {
    read_provider_store()
}

/// 整体保存供应商列表（新增/编辑/删除/排序/启用禁用统一走这里）。
#[tauri::command]
pub fn save_providers(store: ProviderStore) -> Result<(), String> {
    write_provider_store(&store)
}

/// 启用/禁用单个供应商。禁用的供应商在「目标配置」下拉里不出现，路由也会跳过。
#[tauri::command]
pub fn set_provider_enabled(id: String, enabled: bool) -> Result<(), String> {
    let mut store = read_provider_store()?;
    let p = store
        .providers
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("供应商不存在: {}", id))?;
    p.enabled = enabled;
    write_provider_store(&store)
}

fn provider_unlock_config(kind: &str) -> Result<ProviderUnlockConfig, String> {
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

fn normalize_provider_unlock_kind(kind: &str) -> Result<&'static str, String> {
    match kind.trim() {
        "codex" | "Codex" => Ok("codex"),
        "claudeCode" | "claude-code" | "claude_code" | "ClaudeCode" => Ok("claudeCode"),
        other => Err(format!("不支持的解锁类型: {}", other)),
    }
}

/// 设置供应商解锁项。解锁后，代理转发链路可以复用对应平台的请求模板。
#[tauri::command]
pub fn set_provider_unlock(
    provider_id: String,
    kind: String,
    enabled: bool,
) -> Result<Provider, String> {
    let kind = normalize_provider_unlock_kind(&kind)?;
    let mut store = read_provider_store()?;
    let updated = {
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

        provider.clone()
    };

    write_provider_store(&store)?;
    Ok(updated)
}
/// 把错误信息里出现的 api_key 子串脱敏，避免 key 经错误消息泄入 UI 日志/导出文件。
fn redact(msg: String, secret: &str) -> String {
    if secret.len() >= 6 && msg.contains(secret) {
        msg.replace(secret, "***REDACTED***")
    } else {
        msg
    }
}

fn clean_api_path(path: Option<&str>) -> String {
    let raw = path.unwrap_or_default().trim();
    if raw.is_empty() || raw == "/" {
        return String::new();
    }
    format!("/{}", raw.trim_start_matches('/').trim_end_matches('/'))
}

fn is_official_dashscope_host(host: &str) -> bool {
    let hostname = reqwest::Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            host.trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    matches!(
        hostname.as_str(),
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com"
    )
}

fn normalize_openai_api_path(host: &str, path: Option<&str>) -> String {
    let path = clean_api_path(path);
    let lower = path.to_ascii_lowercase();

    if is_official_dashscope_host(host) {
        if lower.ends_with("/compatible-mode/v1/chat/completions")
            || lower.ends_with("/compatible-mode/v1/responses")
        {
            return path;
        }
        if lower == "/v1/chat/completions" || lower == "/api/v1/chat/completions" {
            return "/compatible-mode/v1/chat/completions".to_string();
        }
        if lower == "/v1/responses" || lower == "/api/v1/responses" {
            return "/compatible-mode/v1/responses".to_string();
        }
        if path.is_empty()
            || lower == "/v1"
            || lower == "/api/v1"
            || lower == "/compatible-mode"
            || lower == "/compatible-mode/v1"
        {
            return "/compatible-mode/v1/chat/completions".to_string();
        }
        if lower.ends_with("/compatible-mode/v1") {
            return format!("{}/chat/completions", path);
        }
        if lower.ends_with("/compatible-mode") {
            return format!("{}/v1/chat/completions", path);
        }
    }

    if lower.ends_with("/chat/completions") || lower.ends_with("/responses") {
        return path;
    }
    if path.is_empty() {
        return "/v1/chat/completions".to_string();
    }
    if lower.ends_with("/v1") {
        return format!("{}/chat/completions", path);
    }
    path
}

fn normalize_anthropic_api_path(path: Option<&str>) -> String {
    let path = clean_api_path(path);
    let lower = path.to_ascii_lowercase();
    if path.is_empty() {
        return "/v1/messages".to_string();
    }
    if lower.ends_with("/messages") {
        return path;
    }
    if lower.ends_with("/v1") {
        return format!("{}/messages", path);
    }
    format!("{}/v1/messages", path)
}

fn is_deepseek_anthropic_endpoint(host: &str, path: Option<&str>) -> bool {
    let hostname = reqwest::Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            host.trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    hostname == "api.deepseek.com"
        && normalize_anthropic_api_path(path)
            .to_ascii_lowercase()
            .starts_with("/anthropic/")
}

fn apply_anthropic_auth(
    req: reqwest::RequestBuilder,
    api_key: &str,
    host: &str,
    path: Option<&str>,
) -> reqwest::RequestBuilder {
    let req = req.header("anthropic-version", "2023-06-01");
    if is_deepseek_anthropic_endpoint(host, path) {
        req.header("Authorization", format!("Bearer {}", api_key))
    } else {
        req.header("x-api-key", api_key)
    }
}

#[derive(Debug, Deserialize)]
pub struct TestConnArgs {
    pub host: String,
    pub api_key: String,
    pub path: Option<String>,
    #[serde(default)]
    pub api_format: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TestConnResult {
    /// 显示给用户的状态文本
    pub message: String,
    /// 探测到的能力标记
    pub capabilities: TestCapabilities,
}

#[derive(Debug, Serialize, Default)]
pub struct TestCapabilities {
    pub gzip: bool,
    pub vision: bool,
    pub tools: bool,
}

#[derive(Debug, Deserialize)]
pub struct TestVisionArgs {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    #[serde(rename = "apiFormat")]
    pub api_format: String,
    #[serde(rename = "imageBase64")]
    pub image_base64: String,
}

#[derive(Debug, Serialize)]
pub struct TestVisionResult {
    pub ok: bool,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub text: String,
    pub error: Option<String>,
}

fn elapsed_ms(started: std::time::Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn snippet(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(max_chars).collect();
    if trimmed.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn content_text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.trim().to_string();
    }
    let Some(arr) = value.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.pointer("/text/value").and_then(Value::as_str))
                .or_else(|| part.get("content").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_vision_text(fmt: &ApiFormat, json: &Value) -> String {
    match fmt {
        ApiFormat::Openai => {
            if let Some(s) = json.get("output_text").and_then(Value::as_str) {
                return s.trim().to_string();
            }
            let choice_text = json
                .pointer("/choices/0/message/content")
                .map(content_text)
                .unwrap_or_default();
            if !choice_text.trim().is_empty() {
                return choice_text;
            }
            json.get("output")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| item.get("content").map(content_text).unwrap_or_default())
                        .filter(|s| !s.trim().is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }
        ApiFormat::Anthropic => json.get("content").map(content_text).unwrap_or_default(),
    }
}

fn regex_match(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

fn vision_missing_reason(text: &str) -> Option<&'static str> {
    let lower = text.trim().to_ascii_lowercase();
    if regex_match(
        r#"(?m)^\s*["“”「」']?(?:我)?不能看到图片["“”「」']?[。.!！]?\s*$"#,
        text,
    ) {
        return Some("模型明确回答不能看到图片");
    }
    let phrases = [
        "image_missing",
        "can't see",
        "cannot see",
        "can't view",
        "cannot view",
        "unable to see",
        "unable to view",
        "don't see",
        "do not see",
        "didn't receive",
        "did not receive",
        "no image",
        "not see an image",
        "without an image",
        "无法看到",
        "没看到",
        "没有看到",
        "看不到",
        "无法查看",
        "不能查看",
        "未看到",
        "没有收到",
        "没有上传",
        "如果您能上传",
        "您提到的图片",
    ];
    if phrases.iter().any(|phrase| lower.contains(phrase)) {
        Some("模型回复表示没有收到图片")
    } else {
        None
    }
}

fn vision_seen_answer_ok(text: &str) -> bool {
    regex_match(
        r#"(?m)^\s*["“”「」']?(?:我)?能看到图片["“”「」']?[。.!！,，]?\s*(?:$|图片内容|内容)"#,
        text,
    )
}

fn vision_content_hit_count(text: &str) -> usize {
    [
        r"(?i)\bRED\b|红色|红",
        r"(?i)\bBLUE\b|蓝色|蓝",
        r"(?i)\bGREEN\b|绿色|绿",
        r"\b42\b",
        r"\b17\b",
        r"\b0?9\b",
    ]
    .iter()
    .filter(|pattern| regex_match(pattern, text))
    .count()
}

fn strip_think_blocks(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(open) = lower.find("<think>") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..open]);
        let after_open = open + "<think>".len();
        let after = &rest[after_open..];
        let after_lower = after.to_ascii_lowercase();
        let Some(close) = after_lower.find("</think>") else {
            break;
        };
        rest = &after[close + "</think>".len()..];
    }
    out.trim().to_string()
}

fn vision_body(
    fmt: &ApiFormat,
    uses_openai_responses: bool,
    model: &str,
    image_b64: &str,
) -> Value {
    let data_url = format!("data:image/png;base64,{}", image_b64);
    let prompt = "请判断你是否真的看到了图片。严格按两行回答：\n第一行只能回答「能看到图片」或「不能看到图片」。\n第二行以「图片内容：」开头，描述图片里的文字和文字颜色。不要猜测；如果图片不可见，第二行写原因。";
    if matches!(fmt, ApiFormat::Openai) && uses_openai_responses {
        serde_json::json!({
            "model": model,
            "input": [{"role": "user", "content": [
                {"type": "input_image", "image_url": data_url},
                {"type": "input_text", "text": prompt}
            ]}],
            "max_output_tokens": 1024,
            "temperature": 0,
            "stream": false
        })
    } else if matches!(fmt, ApiFormat::Openai) {
        serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt}
            ]}],
            "max_tokens": 1024,
            "temperature": 0,
            "stream": false
        })
    } else {
        serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                {"type": "text", "text": prompt}
            ]}],
            "max_tokens": 1024,
            "temperature": 0,
            "stream": false
        })
    }
}

fn mark_model_vision(provider_id: &str, model: &str) -> Result<(), String> {
    let mut store = read_provider_store()?;
    let Some(provider) = store.providers.iter_mut().find(|p| p.id == provider_id) else {
        return Ok(());
    };
    provider
        .model_caps
        .entry(model.to_string())
        .or_default()
        .vision = true;
    write_provider_store(&store)
}

fn parse_api_format_arg(value: &str) -> Result<ApiFormat, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "openai" => Ok(ApiFormat::Openai),
        "anthropic" => Ok(ApiFormat::Anthropic),
        "" => Err("本次调用必须明确选择协议(openai 或 anthropic)".to_string()),
        other => Err(format!("未知协议: {}", other)),
    }
}

#[tauri::command]
pub async fn test_vision(args: TestVisionArgs) -> Result<TestVisionResult, String> {
    let provider_id = args.provider_id.trim();
    let model = args.model.trim();
    let api_format = parse_api_format_arg(&args.api_format)?;
    let mut image_b64 = args.image_base64.trim();
    if let Some((_, data)) = image_b64.split_once(',') {
        image_b64 = data.trim();
    }
    if provider_id.is_empty() {
        return Err("供应商不能为空".to_string());
    }
    if model.is_empty() {
        return Err("模型不能为空".to_string());
    }
    if image_b64.is_empty() {
        return Err("测试图片不能为空".to_string());
    }

    let store = read_provider_store()?;
    let provider = store
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .cloned()
        .ok_or_else(|| format!("供应商不存在: {}", provider_id))?;
    if provider.enabled == false {
        return Err(format!("供应商已禁用: {}", provider.name));
    }

    let host = provider.api_host.trim_end_matches('/');
    let host = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    let chat_path = match api_format {
        ApiFormat::Openai => normalize_openai_api_path(&host, provider.api_path.as_deref()),
        ApiFormat::Anthropic => normalize_anthropic_api_path(provider.api_path.as_deref()),
    };
    let uses_openai_responses =
        api_format == ApiFormat::Openai && chat_path.to_ascii_lowercase().contains("/responses");
    let url = format!("{}{}", host, chat_path);
    let body = vision_body(&api_format, uses_openai_responses, model, image_b64);
    let mut body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;

    let client = super::apply_system_proxy(
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)),
    )
    .build()
    .map_err(|e| e.to_string())?;

    let started = std::time::Instant::now();
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", APP_USER_AGENT);
    req = match api_format {
        ApiFormat::Openai => req.header("Authorization", format!("Bearer {}", provider.api_key)),
        ApiFormat::Anthropic => {
            apply_anthropic_auth(req, &provider.api_key, &host, provider.api_path.as_deref())
        }
    };
    if provider.capabilities.gzip {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&body_bytes).map_err(|e| e.to_string())?;
        body_bytes = encoder.finish().map_err(|e| e.to_string())?;
        req = req.header("Content-Encoding", "gzip");
    }

    let resp = match req.body(body_bytes).send().await {
        Ok(resp) => resp,
        Err(e) => {
            return Ok(TestVisionResult {
                ok: false,
                duration_ms: elapsed_ms(started),
                text: String::new(),
                error: Some(redact(format!("网络错误: {}", e), &provider.api_key)),
            });
        }
    };
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    let duration_ms = elapsed_ms(started);
    if !status.is_success() {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: String::new(),
            error: Some(redact(
                format!("HTTP {}: {}", status.as_u16(), snippet(&body_text, 240)),
                &provider.api_key,
            )),
        });
    }

    let json: Value = match serde_json::from_str(&body_text) {
        Ok(json) => json,
        Err(e) => {
            return Ok(TestVisionResult {
                ok: false,
                duration_ms,
                text: String::new(),
                error: Some(format!("解析响应失败: {}", e)),
            });
        }
    };
    let raw_text = extract_vision_text(&api_format, &json);
    let text = strip_think_blocks(&raw_text);
    let text = if text.trim().is_empty() {
        if raw_text.to_ascii_lowercase().contains("<think>") {
            return Ok(TestVisionResult {
                ok: false,
                duration_ms,
                text: snippet(&raw_text, 240),
                error: Some(format!(
                    "模型只返回了推理内容，未输出最终图片判断：{}",
                    snippet(&raw_text, 180)
                )),
            });
        }
        raw_text.trim().to_string()
    } else {
        text
    };
    if text.trim().is_empty() {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: String::new(),
            error: Some("模型返回为空，未确认图片理解能力".to_string()),
        });
    }
    if let Some(reason) = vision_missing_reason(&text) {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: snippet(&text, 240),
            error: Some(format!("{}：{}", reason, snippet(&text, 180))),
        });
    }
    if !vision_seen_answer_ok(&text) {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: snippet(&text, 240),
            error: Some(format!(
                "模型没有按要求回答「能看到图片」：{}",
                snippet(&text, 180)
            )),
        });
    }
    let content_hits = vision_content_hit_count(&text);
    if content_hits < 3 {
        return Ok(TestVisionResult {
            ok: false,
            duration_ms,
            text: snippet(&text, 240),
            error: Some(format!(
                "模型没有描述出测试图中的颜色/文字特征：{}",
                snippet(&text, 180)
            )),
        });
    }

    if let Err(e) = mark_model_vision(provider_id, model) {
        eprintln!("[config] mark model vision skipped: {}", e);
    }
    Ok(TestVisionResult {
        ok: true,
        duration_ms,
        text: snippet(&text, 240),
        error: None,
    })
}

#[tauri::command]
pub async fn test_connection(args: TestConnArgs) -> Result<TestConnResult, String> {
    let host = args.host.trim_end_matches('/');
    let host = if host.starts_with("http") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    let fmt = args.api_format.as_deref().unwrap_or("anthropic");

    let client = super::apply_system_proxy(
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)),
    )
    .build()
    .map_err(|e| e.to_string())?;

    // ── Step 1: 快速连通检查 (/v1/models) ──
    // 注意：很多中转站（One-Hub + Cloudflare）会屏蔽 /v1/models 返回 403，
    // 但 /v1/chat/completions 是正常的。所以 403 不阻断，只标记 models_ok。
    let model_paths = ["/v1/models", "/models"];
    let mut models_ok = false;

    for path in &model_paths {
        let url = format!("{}{}", host, path);
        let mut req = client.get(&url);
        if fmt == "openai" {
            req = req.header("Authorization", format!("Bearer {}", args.api_key));
        } else {
            req = apply_anthropic_auth(req, &args.api_key, &host, args.path.as_deref());
        }
        match req.send().await {
            Ok(r) => {
                let s = r.status().as_u16();
                if r.status().is_success() {
                    models_ok = true;
                    break;
                }
                if s == 403 {
                    // Cloudflare WAF 或供应商屏蔽，不阻断后续
                }
                // 401 也不阻断，交给 chat 测试最终验证
            }
            Err(_) => {
                // 网络错误也不阻断，chat 测试会再试
            }
        }
    }

    // ── Step 2: Chat 探测（发送 "今天几号" 验证实际调用能力）──
    let chat_path = if fmt == "openai" {
        normalize_openai_api_path(&host, args.path.as_deref())
    } else {
        normalize_anthropic_api_path(args.path.as_deref())
    };
    let uses_openai_responses =
        fmt == "openai" && chat_path.to_ascii_lowercase().contains("/responses");

    let test_model = args.model.as_deref().unwrap_or("gpt-3.5-turbo");
    let (chat_body, auth_header, auth_value) = if fmt == "openai" && uses_openai_responses {
        let body = serde_json::json!({
            "model": test_model,
            "input": [{"role": "user", "content": "今天几号"}],
            "max_output_tokens": 32,
            "stream": false
        });
        (
            serde_json::to_vec(&body).unwrap(),
            "Authorization".to_string(),
            format!("Bearer {}", args.api_key),
        )
    } else if fmt == "openai" {
        let body = serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "今天几号"}],
            "max_tokens": 32,
            "stream": false
        });
        (
            serde_json::to_vec(&body).unwrap(),
            "Authorization".to_string(),
            format!("Bearer {}", args.api_key),
        )
    } else {
        let body = serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "今天几号"}],
            "max_tokens": 32,
            "stream": false
        });
        let (auth_header, auth_value) = if is_deepseek_anthropic_endpoint(&host, Some(&chat_path)) {
            (
                "Authorization".to_string(),
                format!("Bearer {}", args.api_key),
            )
        } else {
            ("x-api-key".to_string(), args.api_key.clone())
        };
        (serde_json::to_vec(&body).unwrap(), auth_header, auth_value)
    };

    let chat_url = format!("{}{}", host, chat_path);

    // 128x128 PNG: some upstreams reject tiny 1x1 images even when vision works.
    const VISION_TEST_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABpklEQVR4nO3SMRHDUBBDwcAxiIAwYoNI/bk4IFTc6GYL1a/Qfq77+yY74cb7T7YTbrr/GT9gug8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsBNA/YFpv/zAtA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBOAPUHpv3yA9M+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwHUH5j2yw9M+wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwEcN2/N9kJN95/sp1w030AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2Aqg/MO2XH5j2AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2Amg/sC0X35g2gcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAngPoD0375gWkfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAlQD+DY7JjtGCazMAAAAASUVORK5CYII=";

    // 发送请求的闭包：根据 use_gzip 决定是否压缩
    let send_req = |body: Vec<u8>, use_gzip: bool| {
        let mut req = client
            .post(&chat_url)
            .header("Content-Type", "application/json")
            .header(&auth_header, &auth_value)
            .body(body);
        if use_gzip {
            req = req.header("Content-Encoding", "gzip");
        }
        if fmt != "openai" {
            req = req.header("anthropic-version", "2023-06-01");
        }
        req
    };

    // 先发明文请求
    let plain_resp = send_req(chat_body.clone(), false).send().await;

    let need_gzip = match plain_resp {
        Ok(r) if r.status().is_success() => false,
        Ok(r) => {
            let status = r.status().as_u16();
            let _err_body = r.text().await.unwrap_or_default();

            // 401 = 真正的认证失败
            if status == 401 {
                return Err("认证失败 (HTTP 401)，请检查 API 密钥".to_string());
            }

            // 400/403/其他 → 尝试 gzip（可能是 WAF 拦截明文 body）
            use flate2::write::GzEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&chat_body).map_err(|e| e.to_string())?;
            let gz_body = encoder.finish().map_err(|e| e.to_string())?;

            match send_req(gz_body, true).send().await {
                Ok(r) if r.status().is_success() => true,
                Ok(r) => {
                    let gz_status = r.status().as_u16();
                    if gz_status == 401 || gz_status == 403 {
                        return Err(format!("认证失败 (HTTP {})，请检查 API 密钥", gz_status));
                    }
                    let gz_body = r.text().await.unwrap_or_default();
                    let gz_snippet: String = gz_body.chars().take(200).collect();
                    return Err(format!(
                        "Chat 失败: 明文 HTTP {} / Gzip HTTP {}: {}",
                        status, gz_status, gz_snippet
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "Chat 明文 HTTP {}，Gzip 网络错误: {}",
                        status,
                        redact(e.to_string(), &args.api_key)
                    ));
                }
            }
        }
        Err(e) => return Err(redact(format!("Chat 网络错误: {}", e), &args.api_key)),
    };

    // ── Step 3: 能力探测（Vision / Tools）──────────────────────
    // 构建不同格式的测试 body
    let (vision_body, tools_body) = if fmt == "openai" && uses_openai_responses {
        let v = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "describe"},
                {"type": "input_image", "image_url": format!("data:image/png;base64,{}", VISION_TEST_PNG_B64)}
            ]}],
            "max_output_tokens": 16,
            "stream": false
        })).unwrap();
        let t = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "input": [{"role": "user", "content": "Add 1 and 2"}],
            "tools": [{"type": "function",
                "name": "add",
                "description": "Add two numbers",
                "parameters": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}
                }, "required": ["a", "b"]}
            }],
            "max_output_tokens": 64,
            "stream": false
        }))
        .unwrap();
        (v, t)
    } else if fmt == "openai" {
        let v = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "describe"},
                {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{}", VISION_TEST_PNG_B64)}}
            ]}],
            "max_tokens": 16,
            "stream": false
        })).unwrap();
        let t = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "Add 1 and 2"}],
            "tools": [{"type": "function", "function": {
                "name": "add",
                "description": "Add two numbers",
                "parameters": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}
                }, "required": ["a", "b"]}
            }}],
            "max_tokens": 64,
            "stream": false
        }))
        .unwrap();
        (v, t)
    } else {
        let v = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "describe"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": VISION_TEST_PNG_B64}}
            ]}],
            "max_tokens": 16,
            "stream": false
        })).unwrap();
        let t = serde_json::to_vec(&serde_json::json!({
            "model": test_model,
            "messages": [{"role": "user", "content": "Add 1 and 2"}],
            "tools": [{"name": "add", "description": "Add two numbers",
                "input_schema": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}
                }, "required": ["a", "b"]}
            }],
            "max_tokens": 64,
            "stream": false
        }))
        .unwrap();
        (v, t)
    };

    let mut caps = TestCapabilities {
        gzip: need_gzip,
        vision: false,
        tools: false,
    };

    // Vision 探测
    match send_req(vision_body, need_gzip).send().await {
        Ok(r) if r.status().is_success() => caps.vision = true,
        Ok(r) => {
            let _ = r.text().await;
        }
        Err(_) => {}
    }

    // Tools 探测
    match send_req(tools_body, need_gzip).send().await {
        Ok(r) if r.status().is_success() => caps.tools = true,
        Ok(r) => {
            let _ = r.text().await;
        }
        Err(_) => {}
    }

    // 组装结果
    let mut parts = vec![];
    if models_ok {
        parts.push("连通 ✓".to_string());
    }
    parts.push("Chat ✓".to_string());
    if caps.vision {
        parts.push("Vision ✓".to_string());
    }
    if caps.tools {
        parts.push("Tools ✓".to_string());
    }
    if need_gzip {
        parts.push("(需 Gzip)".to_string());
    }
    let msg = parts.join(" ");

    Ok(TestConnResult {
        message: msg,
        capabilities: caps,
    })
}

// ─── 拉取模型列表 ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct FetchModelsArgs {
    pub host: String,
    pub api_key: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub api_format: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FetchModelsResult {
    pub models: Vec<String>,
    /// 实际命中并成功返回模型列表所用的协议（anthropic / openai）
    pub api_format: String,
}

const MODEL_FETCH_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

fn path_ends_with_version_segment(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or_default();
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn strip_model_fetch_compat_suffix(path: &str) -> Option<&str> {
    MODEL_FETCH_COMPAT_SUFFIXES
        .iter()
        .find_map(|suffix| path.strip_suffix(suffix))
}

#[tauri::command]
pub async fn fetch_models(args: FetchModelsArgs) -> Result<FetchModelsResult, String> {
    let host = args.host.trim_end_matches('/');
    let host = if host.starts_with("http") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };

    let client = super::apply_system_proxy(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(8))
            .user_agent(APP_USER_AGENT),
    )
    .build()
    .map_err(|e| e.to_string())?;

    let fmt = args.api_format.as_deref().unwrap_or("anthropic");
    let chat_path = if fmt == "openai" {
        normalize_openai_api_path(&host, args.path.as_deref())
    } else {
        normalize_anthropic_api_path(args.path.as_deref())
    };
    // 按协议分发凭证头；DeepSeek 的 Anthropic 兼容入口使用 Bearer。
    // 避免把 key 同时塞进两种头发给非预期端点。
    let auth = |req: reqwest::RequestBuilder| {
        if fmt == "openai" {
            req.header("Authorization", format!("Bearer {}", args.api_key))
        } else {
            apply_anthropic_auth(req, &args.api_key, &host, Some(&chat_path))
        }
    };

    let lower_path = chat_path.to_ascii_lowercase();
    let base_path = if lower_path.ends_with("/chat/completions") {
        chat_path.trim_end_matches("/chat/completions").to_string()
    } else if lower_path.ends_with("/responses") {
        chat_path.trim_end_matches("/responses").to_string()
    } else if lower_path.ends_with("/messages") {
        chat_path.trim_end_matches("/messages").to_string()
    } else {
        String::new()
    };
    let mut model_paths = Vec::new();
    if !base_path.is_empty() {
        model_paths.push(format!("{}/models", base_path.trim_end_matches('/')));
    } else if fmt == "openai" && !chat_path.is_empty() {
        let openai_base = chat_path.trim_end_matches('/');
        if lower_path.ends_with("/models") {
            model_paths.push(openai_base.to_string());
        } else if path_ends_with_version_segment(openai_base) {
            model_paths.push(format!("{}/models", openai_base));
            if !openai_base.ends_with("/v1") {
                model_paths.push(format!("{}/v1/models", openai_base));
            }
        } else {
            model_paths.push(format!("{}/v1/models", openai_base));
        }

        if let Some(stripped) = strip_model_fetch_compat_suffix(openai_base) {
            let stripped = stripped.trim_end_matches('/');
            if !stripped.is_empty() {
                model_paths.push(format!("{}/v1/models", stripped));
                model_paths.push(format!("{}/models", stripped));
            }
        }
    }
    model_paths.push("/v1/models".to_string());
    model_paths.push("/models".to_string());
    model_paths.dedup();

    let mut resp = None;
    let mut attempts = Vec::new();
    for path in model_paths {
        let url = format!("{}{}", host, path);
        let req = auth(client.get(&url).header("Accept", "application/json"));
        match req.send().await {
            Ok(r) if r.status().is_success() => {
                resp = Some(r);
                break;
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(180).collect();
                if snippet.trim().is_empty() {
                    attempts.push(format!("{}: HTTP {}", path, status.as_u16()));
                } else {
                    attempts.push(format!(
                        "{}: HTTP {} {}",
                        path,
                        status.as_u16(),
                        snippet.replace(char::is_whitespace, " ")
                    ));
                }
            }
            Err(e) => {
                attempts.push(format!(
                    "{}: 网络错误 {}",
                    path,
                    redact(e.to_string(), &args.api_key)
                ));
            }
        }
    }

    let Some(r) = resp else {
        let detail = if attempts.is_empty() {
            "没有收到任何响应".to_string()
        } else {
            attempts.join("；")
        };
        return Err(format!("模型列表拉取失败：{}", detail));
    };

    let body: serde_json::Value = r.json().await.map_err(|e| format!("解析失败: {}", e))?;

    let mut models = Vec::new();

    if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    } else if let Some(arr) = body.as_array() {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            } else if let Some(id) = item.as_str() {
                models.push(id.to_string());
            }
        }
    } else if let Some(obj) = body.as_object() {
        for (_k, val) in obj {
            if let Some(arr) = val.as_array() {
                for item in arr {
                    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                        models.push(id.to_string());
                    } else if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        models.push(name.to_string());
                    }
                }
            }
        }
    }

    Ok(FetchModelsResult {
        models,
        api_format: fmt.to_string(),
    })
}
