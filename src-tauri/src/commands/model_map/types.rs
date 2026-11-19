use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn default_true() -> bool {
    true
}
pub(super) fn default_slot_display_mode() -> String {
    "all".to_string()
}
pub(super) fn default_unlock_scope() -> String {
    "all".to_string()
}
pub(super) fn default_slot_visibility_mode() -> String {
    "official".to_string()
}
pub(super) fn default_enhancement() -> EnhancementConfig {
    EnhancementConfig::default()
}
fn default_retry_max_retries() -> u32 {
    5
}
fn default_retry_base_ms() -> u32 {
    600
}
fn default_retry_cap_ms() -> u32 {
    8000
}
fn default_retry_total_seconds() -> u32 {
    60
}
fn default_codex_request_max_retries() -> u32 {
    10
}
fn default_codex_stream_max_retries() -> u32 {
    10
}
fn default_claude_max_retries() -> u32 {
    10
}
fn default_vision_max_tokens() -> u32 {
    2048
}
fn default_vision_context_mode() -> String {
    "current".to_string()
}
fn default_vision_context_max_chars() -> u32 {
    8000
}
fn default_vision_multi_image_mode() -> String {
    "single".to_string()
}
fn default_vision_batch_size() -> u32 {
    3
}

fn default_web_search_max_results() -> u32 {
    5
}

fn default_web_search_max_rounds() -> u32 {
    3
}

fn default_failover_ttfb_seconds() -> u32 {
    120
}

fn default_cooldown_transient_seconds() -> u32 {
    60
}

fn default_cooldown_max_seconds() -> u32 {
    600
}

fn default_cooldown_auth_seconds() -> u32 {
    600
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    /// 目标请求使用的协议。为空时由网关按解锁、目标 path、供应商 path/host 自动识别。
    #[serde(rename = "apiFormat", default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
    /// 目标级 API path。为空时使用供应商默认 path；解锁目标由 unlock.wireApi 接管。
    #[serde(rename = "apiPath", default, skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    /// 目标请求使用哪个供应商解锁模板。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock: Option<String>,
    /// 思考档位覆盖。auto/缺省 = 从 Devin modelUid 解析并转换；其余值按目标族词表钳制后下发。
    #[serde(
        rename = "thinkingEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thinking_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfHealConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub signature: bool,
    #[serde(default = "default_true")]
    pub budget: bool,
    #[serde(default = "default_true")]
    pub media: bool,
}

impl Default for SelfHealConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            signature: true,
            budget: true,
            media: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhancementConfig {
    #[serde(default = "default_true")]
    pub retry: bool,
    #[serde(rename = "retryMaxRetries", default = "default_retry_max_retries")]
    pub retry_max_retries: u32,
    #[serde(rename = "retryBaseMs", default = "default_retry_base_ms")]
    pub retry_base_ms: u32,
    #[serde(rename = "retryCapMs", default = "default_retry_cap_ms")]
    pub retry_cap_ms: u32,
    #[serde(rename = "retryTotalSeconds", default = "default_retry_total_seconds")]
    pub retry_total_seconds: u32,
    #[serde(
        rename = "codexRequestMaxRetries",
        default = "default_codex_request_max_retries"
    )]
    pub codex_request_max_retries: u32,
    #[serde(
        rename = "codexStreamMaxRetries",
        default = "default_codex_stream_max_retries"
    )]
    pub codex_stream_max_retries: u32,
    #[serde(rename = "claudeMaxRetries", default = "default_claude_max_retries")]
    pub claude_max_retries: u32,
    #[serde(rename = "selfHeal", default)]
    pub self_heal: SelfHealConfig,
    #[serde(rename = "imageFallback", default = "default_true")]
    pub image_fallback: bool,
    #[serde(rename = "visionMaxTokens", default = "default_vision_max_tokens")]
    pub vision_max_tokens: u32,
    #[serde(rename = "visionContextMode", default = "default_vision_context_mode")]
    pub vision_context_mode: String,
    #[serde(
        rename = "visionContextMaxChars",
        default = "default_vision_context_max_chars"
    )]
    pub vision_context_max_chars: u32,
    #[serde(
        rename = "visionMultiImageMode",
        default = "default_vision_multi_image_mode"
    )]
    pub vision_multi_image_mode: String,
    #[serde(rename = "visionBatchSize", default = "default_vision_batch_size")]
    pub vision_batch_size: u32,
    #[serde(rename = "webSearchEnabled", default)]
    pub web_search_enabled: bool,
    #[serde(
        rename = "webSearchMaxResults",
        default = "default_web_search_max_results"
    )]
    pub web_search_max_results: u32,
    #[serde(
        rename = "webSearchMaxRounds",
        default = "default_web_search_max_rounds"
    )]
    pub web_search_max_rounds: u32,
    #[serde(rename = "autoRouting", default = "default_true")]
    pub auto_routing: bool,
    /// 上游首字节超时（秒）。超时即判定该目标失败并切换下一个目标。
    #[serde(
        rename = "failoverTtfbSeconds",
        default = "default_failover_ttfb_seconds"
    )]
    pub failover_ttfb_seconds: u32,
    /// 失败目标冷却总开关。关闭后失败不再跳过该目标。
    #[serde(rename = "cooldownEnabled", default = "default_true")]
    pub cooldown_enabled: bool,
    /// 瞬时错误（5xx / 超时 / 网络）的首次冷却秒数，反复失败按 2 倍递增。
    #[serde(
        rename = "cooldownTransientSeconds",
        default = "default_cooldown_transient_seconds"
    )]
    pub cooldown_transient_seconds: u32,
    /// 冷却时长上限（秒）。
    #[serde(rename = "cooldownMaxSeconds", default = "default_cooldown_max_seconds")]
    pub cooldown_max_seconds: u32,
    /// 鉴权/权限/模型不可用类错误的冷却秒数，一次失败即按此值冷却。
    #[serde(rename = "cooldownAuthSeconds", default = "default_cooldown_auth_seconds")]
    pub cooldown_auth_seconds: u32,
    #[serde(rename = "unlockModels", default = "default_true")]
    pub unlock_models: bool,
    #[serde(rename = "systemPromptPrefix", default)]
    pub system_prompt_prefix: String,
    #[serde(rename = "systemPromptPrefixEnabled", default)]
    pub system_prompt_prefix_enabled: bool,
    #[serde(rename = "customHeaders", default)]
    pub custom_headers: Vec<HeaderPair>,
    #[serde(rename = "customHeadersEnabled", default)]
    pub custom_headers_enabled: bool,
    #[serde(rename = "responseHeaders", default)]
    pub response_headers: Vec<HeaderPair>,
    #[serde(rename = "paramOverrides", default)]
    pub param_overrides: HashMap<String, serde_json::Value>,
    #[serde(rename = "paramOverridesEnabled", default)]
    pub param_overrides_enabled: bool,
    #[serde(rename = "toolFilterMode", default)]
    pub tool_filter_mode: String,
    #[serde(rename = "toolFilterList", default)]
    pub tool_filter_list: Vec<String>,
    #[serde(rename = "forceToolChoice", default)]
    pub force_tool_choice: String,
    #[serde(rename = "toolFilterEnabled", default)]
    pub tool_filter_enabled: bool,
    #[serde(rename = "rateLimitRpm", default)]
    pub rate_limit_rpm: u32,
    #[serde(rename = "rateLimitEnabled", default)]
    pub rate_limit_enabled: bool,
    #[serde(rename = "requestLogging", default)]
    pub request_logging: bool,
}

impl Default for EnhancementConfig {
    fn default() -> Self {
        Self {
            retry: true,
            retry_max_retries: default_retry_max_retries(),
            retry_base_ms: default_retry_base_ms(),
            retry_cap_ms: default_retry_cap_ms(),
            retry_total_seconds: default_retry_total_seconds(),
            codex_request_max_retries: default_codex_request_max_retries(),
            codex_stream_max_retries: default_codex_stream_max_retries(),
            claude_max_retries: default_claude_max_retries(),
            self_heal: SelfHealConfig::default(),
            image_fallback: true,
            vision_max_tokens: default_vision_max_tokens(),
            vision_context_mode: default_vision_context_mode(),
            vision_context_max_chars: default_vision_context_max_chars(),
            vision_multi_image_mode: default_vision_multi_image_mode(),
            vision_batch_size: default_vision_batch_size(),
            web_search_enabled: false,
            web_search_max_results: default_web_search_max_results(),
            web_search_max_rounds: default_web_search_max_rounds(),
            auto_routing: true,
            failover_ttfb_seconds: default_failover_ttfb_seconds(),
            cooldown_enabled: true,
            cooldown_transient_seconds: default_cooldown_transient_seconds(),
            cooldown_max_seconds: default_cooldown_max_seconds(),
            cooldown_auth_seconds: default_cooldown_auth_seconds(),
            unlock_models: true,
            system_prompt_prefix: String::new(),
            system_prompt_prefix_enabled: false,
            custom_headers: Vec::new(),
            custom_headers_enabled: false,
            response_headers: Vec::new(),
            param_overrides: HashMap::new(),
            param_overrides_enabled: false,
            tool_filter_mode: String::new(),
            tool_filter_list: Vec::new(),
            force_tool_choice: String::new(),
            tool_filter_enabled: false,
            rate_limit_rpm: 0,
            rate_limit_enabled: false,
            request_logging: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisionModels {
    #[serde(rename = "imageModels", default)]
    pub image_models: Vec<VisionModelTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionModelTarget {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    #[serde(rename = "apiFormat")]
    pub api_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SearchModels {
    #[serde(rename = "searchSources", default)]
    pub search_sources: Vec<SearchSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub engine: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: String,
    #[serde(rename = "apiHost", default)]
    pub api_host: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Slot {
    #[serde(rename = "modelUid")]
    pub model_uid: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 解锁后该模型是否允许发送图片。由 BYOK 槽位配置决定（应与所选服务商能力一致），
    /// sidecar 据此改写 GetUserStatus 里的 supports_images 字段。默认 true。
    #[serde(rename = "supportsImages", default = "default_true")]
    pub supports_images: bool,
    /// 是否对该槽位启用用户配置的第三方图片理解降级链。默认关闭。
    #[serde(rename = "useThirdPartyVision", default)]
    pub use_third_party_vision: bool,
    /// 覆盖 GetUserStatus 下发的上下文窗口（token）。None = 使用 windsurf-catalog / 上游原值。
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub targets: Vec<Target>,
}

/// 模型槽位管理项：解锁 Windsurf 灰色不可选模型（如 Claude Opus 4.8、SWE-1.6）。
/// 与 Slot 区别：Slot 路由 Windsurf 已可选的 modelUid（保持 field22 不动 + 改名 label）；
/// InjectedSlot 是 Windsurf 原本不可选（disabled=true）的模型，解锁后注入到下拉框。
///
/// 注入项 field22(modelUid) = 真实 modelUid（一对一，不共用骨架），由 sidecar catalog 提供；
/// label = Windsurf 真实 label（用于改写显示名），providerId 可空（空 = 未配置 → 报清晰错误）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InjectedSlot {
    /// Windsurf 真实 label（如 "Claude Opus 4.8"）。注入到下拉框时改写为 "(BYOK) {label} (...)"。
    pub label: String,
    /// Windsurf 真实 modelUid（一对一原则，禁止共用骨架）。
    #[serde(rename = "modelUid")]
    pub model_uid: String,
    /// BYOK 供应商端实际 API ID。无值时为 None（GUI 用户必须手动填，否则该模型无法调用）。
    /// 必填校验放在 save_model_map 阶段。
    #[serde(default)]
    pub model: Option<String>,
    /// BYOK 供应商 ID。无值或引用不存在 = 未配置（弹窗里显示"(未配置)"）。
    #[serde(rename = "providerId", default)]
    pub provider_id: Option<String>,
    /// 注入槽位目标请求使用的协议。为空时由网关按解锁、目标 path、供应商 path/host 自动识别。
    #[serde(rename = "apiFormat", default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
    /// 注入槽位目标级 API path。为空时使用供应商默认 path；解锁目标由 unlock.wireApi 接管。
    #[serde(rename = "apiPath", default, skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    /// 注入槽位目标请求使用哪个供应商解锁模板。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock: Option<String>,
    /// 思考档位覆盖。auto/缺省 = 从 modelUid/label 解析并转换；其余值按目标族词表钳制后下发。
    #[serde(
        rename = "thinkingEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thinking_effort: Option<String>,
    /// 解锁后该模型是否允许发送图片。默认 true。
    #[serde(rename = "supportsImages", default = "default_true")]
    pub supports_images: bool,
}

/// 单模型槽位显示开关。slotVisibilityMode 是快速预设；这里记录用户逐项微调后的覆盖值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotVisibility {
    #[serde(rename = "modelUid")]
    pub model_uid: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelMap {
    /// 全局显示名前缀,如 "(BYOK)"。拼接后显示为 "{prefix} {displayName}"。
    /// 适用于所有已路由模型(无论是否自定义了 displayName)。注入项不使用此前缀(自带 "(BYOK)")。
    #[serde(rename = "namePrefix", default)]
    pub name_prefix: String,
    /// 显示模板,留空则用默认 "{prefix} {label} ({provider})"。
    /// 支持占位符:{prefix} {label} {provider} {apiModel}。
    /// 兄弟硬性规则:模板含 {provider} 且无 provider → 渲染为「未设置」。
    #[serde(rename = "labelTemplate", default)]
    pub label_template: String,
    /// 是否在显示名中展示原始槽位 ID 前缀（如 uid>...）。
    #[serde(rename = "showSlotUid", default)]
    pub show_slot_uid: bool,
    /// 是否在模型名后追加实际生效的思考档位（如 -high、-medium）。
    #[serde(rename = "showThinkingEffort", default)]
    pub show_thinking_effort: bool,
    /// 是否在模型名旁标注配置的上下文窗口（如 [1M]、[200K]）。
    #[serde(rename = "showContextWindow", default)]
    pub show_context_window: bool,
    /// 模型槽位解锁范围：all/common/configured/claude/gpt/gemini/code。
    /// all 默认全量解锁；common 只解锁常用模型族；configured 仅解锁已显式配置项。
    #[serde(rename = "unlockScope", default = "default_unlock_scope")]
    pub unlock_scope: String,
    /// 旧字段，保留用于兼容旧配置和旧前端。新逻辑使用 unlockScope。
    #[serde(rename = "slotDisplayMode", default = "default_slot_display_mode")]
    pub slot_display_mode: String,
    /// 槽位显示策略：mapped=只显示已映射；official=已映射+官方；all=完整槽位列表。
    /// 这是槽位管理里的产品概念，不等同于 unlockScope。
    #[serde(
        rename = "slotVisibilityMode",
        default = "default_slot_visibility_mode"
    )]
    pub slot_visibility_mode: String,
    /// 单模型显示覆盖。未出现在这里的模型按 slotVisibilityMode 推导。
    #[serde(rename = "slotVisibility", default)]
    pub slot_visibility: Vec<SlotVisibility>,
    #[serde(default)]
    pub slots: Vec<Slot>,
    /// 注入项列表:解锁 Windsurf 灰色不可选模型。详见 spec/08。
    #[serde(default)]
    pub injected: Vec<InjectedSlot>,
    /// 网关增强功能开关。默认全开，具体请求链路后续由 sidecar 消费。
    #[serde(default = "default_enhancement")]
    pub enhancement: EnhancementConfig,
    /// 第三方图片理解模型故障转移链。
    #[serde(rename = "visionModels", default)]
    pub vision_models: VisionModels,
    /// 联网搜索源故障转移链。
    #[serde(rename = "searchModels", default)]
    pub search_models: SearchModels,
    /// 内置模型 ID 批量重命名规则(由「模型列表」列头齿轮按钮设置)。
    /// 保存后下次打开弹窗自动回填,避免重复输入造成规则叠加。
    #[serde(rename = "proxyRouteRenameRule", default)]
    pub proxy_route_rename_rule: ProxyRouteRenameRule,
}

/// 内置模型 ID 批量重命名规则。
///  - mode: "simple" = 用 prefix/model/suffix 拼; "custom" = 用 template 模板
///  - prefix/suffix: 简单模式下的前后缀(可空,支持中文/特殊字符/emoji,可含占位符 {provider})
///  - template: 高级模式下的完整模板,支持 {prefix} {model} {provider} {suffix}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyRouteRenameRule {
    #[serde(default = "default_rename_enabled", rename = "enabled")]
    pub enabled: bool,
    #[serde(default, rename = "mode")]
    pub mode: String,
    #[serde(default, rename = "prefix")]
    pub prefix: String,
    #[serde(default, rename = "suffix")]
    pub suffix: String,
    #[serde(default, rename = "template")]
    pub template: String,
}

fn default_rename_enabled() -> bool {
    true
}

impl Default for ProxyRouteRenameRule {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: String::new(),
            prefix: String::new(),
            suffix: String::new(),
            template: String::new(),
        }
    }
}
