// model_map.rs — 槽位映射表（model-map.json）。
//
// 每个槽位把一个 Windsurf 模型 ID（modelUid）映射到:
//   displayName  下拉框改名（可空，空=显示原始名）
//   enabled      是否将该槽位的 GetChatMessage 路由到第三方
//   targets[]    故障转移链，按顺序尝试 {providerId, model}
//
// sidecar 直接读这份文件 + providers.json 做路由，不再有「激活供应商」概念。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::config::config_dir_path;

fn model_map_path() -> PathBuf {
    config_dir_path().join("model-map.json")
}

fn default_true() -> bool {
    true
}

fn default_slot_display_mode() -> String {
    "all".to_string()
}

fn default_unlock_scope() -> String {
    "all".to_string()
}

fn default_slot_visibility_mode() -> String {
    "mapped".to_string()
}

fn default_enhancement() -> EnhancementConfig {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    /// 目标请求使用的协议。为空时由代理按解锁、目标 path、供应商 path/host 自动识别。
    #[serde(rename = "apiFormat", default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
    /// 目标级 API path。为空时使用供应商默认 path；解锁目标由 unlock.wireApi 接管。
    #[serde(rename = "apiPath", default, skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    /// 目标请求使用哪个供应商解锁模板。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock: Option<String>,
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
    #[serde(rename = "autoRouting", default = "default_true")]
    pub auto_routing: bool,
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
            self_heal: SelfHealConfig::default(),
            image_fallback: true,
            vision_max_tokens: default_vision_max_tokens(),
            vision_context_mode: default_vision_context_mode(),
            vision_context_max_chars: default_vision_context_max_chars(),
            vision_multi_image_mode: default_vision_multi_image_mode(),
            vision_batch_size: default_vision_batch_size(),
            auto_routing: true,
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
    /// 注入槽位目标请求使用的协议。为空时由代理按解锁、目标 path、供应商 path/host 自动识别。
    #[serde(rename = "apiFormat", default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
    /// 注入槽位目标级 API path。为空时使用供应商默认 path；解锁目标由 unlock.wireApi 接管。
    #[serde(rename = "apiPath", default, skip_serializing_if = "Option::is_none")]
    pub api_path: Option<String>,
    /// 注入槽位目标请求使用哪个供应商解锁模板。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock: Option<String>,
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
    /// 代理增强功能开关。默认全开，具体请求链路后续由 sidecar 消费。
    #[serde(default = "default_enhancement")]
    pub enhancement: EnhancementConfig,
    /// 第三方图片理解模型故障转移链。
    #[serde(rename = "visionModels", default)]
    pub vision_models: VisionModels,
    /// 本地代理模型 ID 批量重命名规则(由「模型列表」列头齿轮按钮设置)。
    /// 保存后下次打开弹窗自动回填,避免重复输入造成规则叠加。
    #[serde(rename = "proxyRouteRenameRule", default)]
    pub proxy_route_rename_rule: ProxyRouteRenameRule,
}

/// 本地代理模型 ID 批量重命名规则。
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

/// 预设 3 槽位:已改名的 Grok 槽位 → Claude Opus 4.6/4.7/4.8。targets 留空（显示「未设置」）。
fn default_slots() -> Vec<Slot> {
    let mk = |uid: &str, name: &str| Slot {
        model_uid: uid.into(),
        display_name: name.into(),
        enabled: true,
        supports_images: true,
        use_third_party_vision: false,
        targets: Vec::new(),
    };
    vec![
        mk("MODEL_XAI_GROK_3", "Claude Opus 4.6"),
        mk("MODEL_XAI_GROK_3_MINI_REASONING", "Claude Opus 4.7"),
        mk("MODEL_PRIVATE_4", "Claude Opus 4.8"),
    ]
}

pub(crate) fn read_map() -> Result<ModelMap, String> {
    let path = model_map_path();
    if !path.exists() {
        return Ok(ModelMap {
            name_prefix: String::new(),
            label_template: String::new(),
            unlock_scope: default_unlock_scope(),
            slot_display_mode: default_slot_display_mode(),
            slot_visibility_mode: default_slot_visibility_mode(),
            slot_visibility: Vec::new(),
            slots: default_slots(),
            injected: Vec::new(),
            enhancement: default_enhancement(),
            vision_models: VisionModels::default(),
            proxy_route_rename_rule: ProxyRouteRenameRule::default(),
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut map: ModelMap = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // 兼容旧 model-map.json：老版本只有 slotDisplayMode。
    if !raw.contains("\"unlockScope\"") {
        map.unlock_scope = map.slot_display_mode.clone();
    }
    if map.unlock_scope.trim().is_empty() {
        map.unlock_scope = default_unlock_scope();
    }
    if map.slot_display_mode.trim().is_empty() {
        map.slot_display_mode = map.unlock_scope.clone();
    }
    if map.slot_visibility_mode.trim().is_empty() {
        map.slot_visibility_mode = default_slot_visibility_mode();
    }
    Ok(map)
}

fn write_map(map: &ModelMap) -> Result<(), String> {
    let dir = config_dir_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    super::write_atomic(&model_map_path(), json.as_bytes())
}

#[tauri::command]
pub fn load_model_map() -> Result<ModelMap, String> {
    read_map()
}

fn normalize_target_unlock<'a>(value: Option<&'a str>) -> &'a str {
    match value.unwrap_or("").trim() {
        "codex" => "codex",
        "claudeCode" | "claude-code" | "claude_code" => "claudeCode",
        _ => value.unwrap_or("").trim(),
    }
}

fn api_format_for_unlock(unlock: &str) -> Option<&'static str> {
    match unlock {
        "codex" => Some("openai"),
        "claudeCode" => Some("anthropic"),
        _ => None,
    }
}

fn validate_target_route(slot_label: &str, target: &Target) -> Result<(), String> {
    let unlock = normalize_target_unlock(target.unlock.as_deref());
    if !unlock.is_empty() && !matches!(unlock, "codex" | "claudeCode") {
        return Err(format!(
            "槽位 {} 的目标解锁类型必须是 codex 或 claudeCode",
            slot_label
        ));
    }
    let api_format = target.api_format.as_deref().unwrap_or("").trim();
    if api_format.is_empty() || api_format.eq_ignore_ascii_case("auto") {
        return Ok(());
    }
    if !matches!(api_format, "openai" | "anthropic") {
        return Err(format!(
            "槽位 {} 的目标 apiFormat 必须是 openai 或 anthropic",
            slot_label
        ));
    }
    if let Some(expected) = api_format_for_unlock(unlock) {
        if api_format != expected {
            return Err(format!(
                "槽位 {} 的目标 apiFormat={} 与 {} 解锁不匹配",
                slot_label, api_format, unlock
            ));
        }
    }
    Ok(())
}

/// 整体保存槽位表（增删改/排序/改 targets 统一走这里）。
/// 校验:
///   槽位: modelUid 不可重复
///   注入项: modelUid 不可与槽位重复; modelUid+label 不可空
#[tauri::command]
pub fn save_model_map(map: ModelMap) -> Result<(), String> {
    if !matches!(
        map.unlock_scope.as_str(),
        "all" | "common" | "configured" | "claude" | "gpt" | "gemini" | "code"
    ) {
        return Err("模型槽位解锁范围必须是 all/common/configured/claude/gpt/gemini/code".into());
    }
    if !matches!(
        map.slot_display_mode.as_str(),
        "all" | "common" | "configured" | "claude" | "gpt" | "gemini" | "code"
    ) {
        return Err(
            "模型槽位兼容显示策略必须是 all/common/configured/claude/gpt/gemini/code".into(),
        );
    }
    if !matches!(
        map.slot_visibility_mode.as_str(),
        "mapped" | "official" | "all"
    ) {
        return Err("槽位显示策略必须是 mapped/official/all".into());
    }
    let mut seen_visibility = std::collections::HashSet::new();
    for item in &map.slot_visibility {
        if item.model_uid.trim().is_empty() {
            return Err("槽位显示 modelUid 不能为空".into());
        }
        if !seen_visibility.insert(item.model_uid.clone()) {
            return Err(format!("槽位显示 modelUid 重复: {}", item.model_uid));
        }
    }

    let mut seen = std::collections::HashSet::new();
    for slot in &map.slots {
        if slot.model_uid.trim().is_empty() {
            return Err("槽位 modelUid 不能为空".into());
        }
        if !seen.insert(slot.model_uid.clone()) {
            return Err(format!("槽位 modelUid 重复: {}", slot.model_uid));
        }
        for target in &slot.targets {
            validate_target_route(&slot.model_uid, target)?;
        }
    }
    // 注入项校验
    let mut seen_inj = std::collections::HashSet::new();
    for inj in &map.injected {
        if inj.model_uid.trim().is_empty() {
            return Err("模型槽位 modelUid 不能为空".into());
        }
        if inj.label.trim().is_empty() {
            return Err("模型槽位 label 不能为空".into());
        }
        if seen.contains(&inj.model_uid) {
            return Err(format!("模型槽位 modelUid 与槽位重复: {}", inj.model_uid));
        }
        if !seen_inj.insert(inj.model_uid.clone()) {
            return Err(format!("模型槽位 modelUid 重复: {}", inj.model_uid));
        }
    }
    write_map(&map)
}

/// 启动代理前校验:扫描启用的槽位 + 已配置 providerId 的模型槽位管理项，若 targets/配置为空、
/// 或引用了不存在/未启用的供应商，返回问题描述列表（空列表 = 通过，可启动）。前端据此阻止带病启动。
#[tauri::command]
pub fn validate_model_map() -> Result<Vec<String>, String> {
    use super::config::load_providers;
    let map = read_map()?;
    let store = load_providers()?;
    let mut problems = Vec::new();

    for slot in &map.slots {
        if !slot.enabled {
            continue;
        }
        let label = if slot.display_name.is_empty() {
            slot.model_uid.clone()
        } else {
            slot.display_name.clone()
        };
        if slot.targets.is_empty() {
            problems.push(format!("「{}」已启用但未配置目标供应商", label));
            continue;
        }
        for t in &slot.targets {
            match store.providers.iter().find(|p| p.id == t.provider_id) {
                None => problems.push(format!("「{}」引用了不存在的供应商", label)),
                Some(p) if !p.enabled => {
                    problems.push(format!("「{}」引用的供应商「{}」已禁用", label, p.name))
                }
                Some(p) => {
                    if let Err(err) = validate_target_route(&label, t) {
                        problems.push(err);
                        continue;
                    }
                    let unlock = normalize_target_unlock(t.unlock.as_deref());
                    if unlock == "codex" {
                        let enabled = p.unlocks.codex.as_ref().map(|u| u.enabled).unwrap_or(false);
                        if !enabled {
                            problems.push(format!(
                                "「{}」要求 Codex 解锁，但供应商「{}」未开启 Codex 解锁",
                                label, p.name
                            ));
                        }
                    } else if unlock == "claudeCode" {
                        let enabled = p
                            .unlocks
                            .claude_code
                            .as_ref()
                            .map(|u| u.enabled)
                            .unwrap_or(false);
                        if !enabled {
                            problems.push(format!(
                                "「{}」要求 Claude Code 解锁，但供应商「{}」未开启 Claude Code 解锁",
                                label, p.name
                            ));
                        }
                    } else if !unlock.is_empty() {
                        problems.push(format!("「{}」配置了未知解锁类型 {}", label, unlock));
                    }
                }
            }
        }
    }

    // 注入项校验：只对"已配 providerId"的注入项报错（空 = 用户尚未配置，安静通过）
    for inj in &map.injected {
        let Some(pid) = &inj.provider_id else {
            continue;
        };
        if pid.is_empty() {
            continue;
        }
        match store.providers.iter().find(|p| p.id == *pid) {
            None => problems.push(format!("模型槽位「{}」引用了不存在的供应商", inj.label)),
            Some(p) if !p.enabled => problems.push(format!(
                "模型槽位「{}」引用的供应商「{}」已禁用",
                inj.label, p.name
            )),
            _ => {}
        }
        if inj.model.as_deref().unwrap_or("").trim().is_empty() {
            problems.push(format!("模型槽位「{}」已选供应商但 model 为空", inj.label));
        }
        let target = Target {
            provider_id: pid.clone(),
            model: inj.model.clone().unwrap_or_default(),
            api_format: inj.api_format.clone(),
            api_path: inj.api_path.clone(),
            unlock: inj.unlock.clone(),
        };
        if let Err(err) = validate_target_route(&inj.label, &target) {
            problems.push(err);
            continue;
        }
        if let Some(p) = store.providers.iter().find(|p| p.id == *pid) {
            let unlock = normalize_target_unlock(inj.unlock.as_deref());
            if unlock == "codex" {
                let enabled = p.unlocks.codex.as_ref().map(|u| u.enabled).unwrap_or(false);
                if !enabled {
                    problems.push(format!(
                        "模型槽位「{}」要求 Codex 解锁，但供应商「{}」未开启 Codex 解锁",
                        inj.label, p.name
                    ));
                }
            } else if unlock == "claudeCode" {
                let enabled = p
                    .unlocks
                    .claude_code
                    .as_ref()
                    .map(|u| u.enabled)
                    .unwrap_or(false);
                if !enabled {
                    problems.push(format!(
                        "模型槽位「{}」要求 Claude Code 解锁，但供应商「{}」未开启 Claude Code 解锁",
                        inj.label, p.name
                    ));
                }
            }
        }
    }

    Ok(problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enhancement_config_round_trips_advanced_proxy_fields() {
        let raw = r#"{
            "systemPromptPrefix": "prefix",
            "systemPromptPrefixEnabled": true,
            "customHeaders": [{"key": "x-test", "value": "1"}],
            "customHeadersEnabled": true,
            "responseHeaders": [{"key": "x-response", "value": "2"}],
            "paramOverrides": {"max_tokens": 4096, "temperature": 0},
            "paramOverridesEnabled": true,
            "toolFilterMode": "allow",
            "toolFilterList": ["read_file"],
            "forceToolChoice": "auto",
            "toolFilterEnabled": true,
            "rateLimitRpm": 12,
            "rateLimitEnabled": true,
            "requestLogging": true,
            "unlockModels": false
        }"#;

        let cfg: EnhancementConfig = serde_json::from_str(raw).unwrap();
        assert!(cfg.system_prompt_prefix_enabled);
        assert!(cfg.custom_headers_enabled);
        assert!(cfg.param_overrides_enabled);
        assert!(cfg.tool_filter_enabled);
        assert!(cfg.rate_limit_enabled);
        assert!(cfg.request_logging);
        assert!(!cfg.unlock_models);
        assert_eq!(cfg.custom_headers[0].key, "x-test");
        assert_eq!(cfg.response_headers[0].value, "2");
        assert_eq!(cfg.param_overrides["max_tokens"], serde_json::json!(4096));

        let value = serde_json::to_value(&cfg).unwrap();
        assert_eq!(value["systemPromptPrefixEnabled"], serde_json::json!(true));
        assert_eq!(
            value["customHeaders"][0]["key"],
            serde_json::json!("x-test")
        );
        assert_eq!(value["paramOverrides"]["temperature"], serde_json::json!(0));
        assert_eq!(value["unlockModels"], serde_json::json!(false));
    }
}
