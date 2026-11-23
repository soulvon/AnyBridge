use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// API 协议格式。供应商本身不再拥有全局协议；该类型只用于调用点参数和旧数据兼容。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApiFormat {
    Anthropic,
    Openai,
    Gemini,
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
    /// 多把密钥的候选池。`apiKey` 始终是「当前生效」的那把：
    /// - 走本地网关时，整池交给路由按请求轮换；
    /// - 不走网关时，由用户在编辑页手动切换当前密钥。
    #[serde(rename = "apiKeys", default, skip_serializing_if = "Vec::is_empty")]
    pub api_keys: Vec<ProviderApiKey>,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(rename = "apiFormat", default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<ApiFormat>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
    /// 模型级别的能力标记（vision / tools），键为模型 ID。
    #[serde(rename = "modelCaps", default)]
    pub model_caps: HashMap<String, ModelCaps>,
    /// 供应商解锁配置：解锁后可被网关转发链路复用到其他平台。
    #[serde(default, skip_serializing_if = "ProviderUnlocks::is_empty")]
    pub unlocks: ProviderUnlocks,
    /// Codex 专有：wire_api 模式 ("responses" 或 "chat")
    #[serde(rename = "wireApi", default, skip_serializing_if = "String::is_empty")]
    pub wire_api: String,
    /// Codex 专有：是否走本地网关（默认 true）
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
    /// Grok 专有：模型上下文窗口（token），写入 ~/.grok/config.toml 的 context_window。
    /// 不写时 Grok 一律按 200,000 处理，会导致小上下文模型永远不会触发自动压缩。
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Option<u32>,
    /// Grok 专有：每个注册模型各自的上下文窗口（token），键为模型 ID。
    /// 一次注册多个模型时，各模型上下文往往不同，逐模型记录才不会让小上下文模型溢出。
    #[serde(
        rename = "modelContexts",
        default,
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub model_contexts: HashMap<String, u32>,
    /// Grok 专有：子代理模型覆盖，键为子代理类型名（explore / plan / general-purpose …），
    /// 值为模型段 key。留空的类型继承主会话模型（Grok 默认行为）。
    #[serde(
        rename = "subagentModels",
        default,
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub subagent_models: HashMap<String, String>,
}

/// 供应商的一把候选密钥。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderApiKey {
    /// 前端列表的稳定标识，写入时由核心补齐（key-1、key-2 …）。
    #[serde(default)]
    pub id: String,
    /// 展示名（如「账号 A」），留空时前端按序号显示。
    #[serde(default)]
    pub label: String,
    pub key: String,
    /// 停用的密钥不参与轮换，也不会被选为当前密钥。
    #[serde(default = "default_true")]
    pub enabled: bool,
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
    #[serde(rename = "unlockedAt", default)]
    pub unlocked_at: String,
    #[serde(rename = "wireApi", default)]
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

pub(super) fn default_agent_max_threads() -> usize {
    6
}

pub(super) fn default_agent_max_depth() -> usize {
    1
}

pub(super) fn default_agent_job_timeout() -> u64 {
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
    /// chat 模式下，本地网关将 Responses 请求转为 Chat Completions 格式发往上游。
    ///
    /// 注意：这是 **AnyBridge 内部字段**，只决定「本地网关 → 上游」用哪个端点，
    /// 不会写进 config.toml —— Codex 的 `wire_api` 恒为 "responses"
    /// （openai/codex 已删除 `WireApi::Chat`，写 "chat" 会让 Codex 启动即崩）。
    #[serde(rename = "wireApi", default = "default_wire_api")]
    pub wire_api: String,
    /// `wire_api` 是否由来源供应商的 API 路径自动推断（默认 true）。
    ///
    /// true = 每次保存都按来源供应商重新推断，供应商换端点时自动跟随；
    /// false = 用户在 UI 上显式选定，推断不再覆盖。
    /// 默认 true 让存量配置（历史上一律被写成 "responses"）在重新保存时自愈。
    #[serde(rename = "wireApiAuto", default = "default_true")]
    pub wire_api_auto: bool,
    /// 是否走本地网关（默认 true）。
    /// 关 = Codex 直接连接供应商原 URL；开 = 走 AnyBridge 内置供应商（127.0.0.1:7450）。
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

pub(super) fn default_wire_api() -> String {
    "responses".to_string()
}

pub(super) fn default_true() -> bool {
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
pub struct ClaudeDesktopConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "apiHost", default, skip_serializing_if = "String::is_empty")]
    pub api_host: String,
    #[serde(rename = "apiKey", default, skip_serializing_if = "String::is_empty")]
    pub api_key: String,
    #[serde(rename = "apiPath", skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(rename = "sonnetModel", default, skip_serializing_if = "String::is_empty")]
    pub sonnet_model: String,
    #[serde(rename = "opusModel", default, skip_serializing_if = "String::is_empty")]
    pub opus_model: String,
    #[serde(rename = "haikuModel", default, skip_serializing_if = "String::is_empty")]
    pub haiku_model: String,
    #[serde(rename = "fableModel", default, skip_serializing_if = "String::is_empty")]
    pub fable_model: String,
    #[serde(rename = "sonnetName", default, skip_serializing_if = "String::is_empty")]
    pub sonnet_name: String,
    #[serde(rename = "opusName", default, skip_serializing_if = "String::is_empty")]
    pub opus_name: String,
    #[serde(rename = "haikuName", default, skip_serializing_if = "String::is_empty")]
    pub haiku_name: String,
    #[serde(rename = "fableName", default, skip_serializing_if = "String::is_empty")]
    pub fable_name: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrokConfig {
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
        rename = "apiBackend",
        default = "default_grok_backend",
        skip_serializing_if = "String::is_empty"
    )]
    pub api_backend: String,
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
    /// 上下文窗口（token）。写入 ~/.grok/config.toml 的 context_window，
    /// 决定 Grok 何时触发自动压缩；留空会让 Grok 按 200,000 处理。
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Option<u32>,
    /// 每个注册模型各自的上下文窗口（token），键为模型 ID。
    #[serde(
        rename = "modelContexts",
        default,
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub model_contexts: HashMap<String, u32>,
    /// 子代理模型覆盖，键为子代理类型名（explore / plan / general-purpose …），
    /// 值为模型段 key。留空的类型继承主会话模型（Grok 默认行为）。
    #[serde(
        rename = "subagentModels",
        default,
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub subagent_models: HashMap<String, String>,
}

pub(super) fn default_grok_backend() -> String {
    "chat_completions".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntigravityConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "apiHost", default)]
    pub api_host: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: String,
    #[serde(rename = "apiPath", default, skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    #[serde(rename = "defaultModel", default)]
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
    /// 目标 API 格式："openai" / "anthropic" / "gemini"（空则由端点或源供应商推断）
    #[serde(rename = "apiFormat", default)]
    pub api_format: String,
    /// 可选协议覆写：当绑定了 sourceProviderId 但该模型需单独指定协议时生效
    #[serde(
        rename = "apiFormatOverride",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub api_format_override: Option<String>,
    /// 上下文压缩窗口阈值（token），默认 262144 (256K)
    #[serde(rename = "contextWindow", default = "default_antigravity_context_window")]
    pub context_window: u64,
    /// 是否注入到 Antigravity 下拉菜单中（默认 true）
    #[serde(rename = "injectModels", default = "default_true")]
    pub inject_models: bool,
    /// 是否启用第三方图片理解
    #[serde(rename = "useThirdPartyVision", default)]
    pub use_third_party_vision: bool,
    /// 自定义模型目录
    #[serde(
        rename = "modelCatalog",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub model_catalog: Vec<ModelCatalogEntry>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

pub(super) fn default_antigravity_context_window() -> u64 {
    262144
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
    /// Grok 专用配置。它们不是供应商，只是基于某个 OpenAI 供应商生成/编辑的 Grok custom model 配置。
    #[serde(
        rename = "grokConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub grok_configs: Vec<GrokConfig>,
    /// Claude Code 专用配置。它们不是供应商，只是基于某个 Anthropic 供应商生成/编辑的写入配置。
    #[serde(
        rename = "claudeCodeConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub claude_code_configs: Vec<ClaudeCodeConfig>,
    /// Claude Desktop 专用配置。用于管理 3P 网关与各角色档位映射。
    #[serde(
        rename = "claudeDesktopConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub claude_desktop_configs: Vec<ClaudeDesktopConfig>,
    /// Antigravity 专用配置。用于管理 Google Antigravity 的模型路由与上下文策略。
    #[serde(
        rename = "antigravityConfigs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub antigravity_configs: Vec<AntigravityConfig>,
    /// Antigravity 运行模式："pure"（纯 BYOK 模式）或 "hybrid"（混合模式：官方+自建）。
    #[serde(
        rename = "antigravityMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub antigravity_mode: Option<String>,
    /// Antigravity 全局默认上下文压缩阈值（token），默认 262144 (256K)。
    #[serde(
        rename = "antigravityContextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub antigravity_context_window: Option<u64>,
    /// Antigravity 是否开启官方配额健康伪装（None 或 true 表示开启，false 表示关闭）。
    #[serde(
        rename = "antigravityMockCredits",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub antigravity_mock_credits: Option<bool>,
    // `current`/激活概念已废弃，改用每槽位 targets 故障转移。保留字段仅为兼容旧文件反序列化，不再读写。
    #[serde(default, skip_serializing)]
    #[allow(dead_code)]
    pub current: String,
    /// 「更多平台」状态：claude-code / codex 各自当前应用的供应商。空时不写入文件，向后兼容旧 providers.json。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub platforms: BTreeMap<String, PlatformState>,
}

