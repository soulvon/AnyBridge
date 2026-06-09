// model_map.rs — 槽位映射表（model-map.json）。
//
// 每个槽位把一个 Windsurf 模型 ID（modelUid）映射到:
//   displayName  下拉框改名（可空，空=显示原始名）
//   enabled      是否劫持该槽位的 GetChatMessage 转发到第三方
//   targets[]    故障转移链，按顺序尝试 {providerId, model}
//
// sidecar 直接读这份文件 + providers.json 做路由，不再有「激活供应商」概念。

use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
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
    #[serde(default)]
    pub targets: Vec<Target>,
}

/// 模型槽位管理项：解锁 Windsurf 灰色不可选模型（如 Claude Opus 4.8、SWE-1.6）。
/// 与 Slot 区别：Slot 劫持 Windsurf 已可选的 modelUid（保持 field22 不动 + 改名 label）；
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
    /// 解锁后该模型是否允许发送图片。默认 true。
    #[serde(rename = "supportsImages", default = "default_true")]
    pub supports_images: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelMap {
    /// 全局显示名前缀,如 "(BYOK)"。拼接后显示为 "{prefix} {displayName}"。
    /// 适用于所有已劫持模型(无论是否自定义了 displayName)。注入项不使用此前缀(自带 "(BYOK)")。
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
    #[serde(default)]
    pub slots: Vec<Slot>,
    /// 注入项列表:解锁 Windsurf 灰色不可选模型。详见 spec/08。
    #[serde(default)]
    pub injected: Vec<InjectedSlot>,
}

/// 预设 3 槽位:已改名的 Grok 槽位 → Claude Opus 4.6/4.7/4.8。targets 留空（显示「未设置」）。
fn default_slots() -> Vec<Slot> {
    let mk = |uid: &str, name: &str| Slot {
        model_uid: uid.into(),
        display_name: name.into(),
        enabled: true,
        supports_images: true,
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
            slots: default_slots(),
            injected: Vec::new(),
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

/// 整体保存槽位表（增删改/排序/改 targets 统一走这里）。
/// 校验:
///   槽位: modelUid 不可重复
///   注入项: modelUid 不可与槽位重复; modelUid+label 不可空; model 字段（一旦设了 providerId）必填
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
        return Err("模型槽位兼容显示策略必须是 all/common/configured/claude/gpt/gemini/code".into());
    }

    let mut seen = std::collections::HashSet::new();
    for slot in &map.slots {
        if slot.model_uid.trim().is_empty() {
            return Err("槽位 modelUid 不能为空".into());
        }
        if !seen.insert(slot.model_uid.clone()) {
            return Err(format!("槽位 modelUid 重复: {}", slot.model_uid));
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
        // 一旦配了 providerId，就必须填 model（BYOK 供应商端实际 API ID）
        if let Some(pid) = &inj.provider_id {
            if !pid.is_empty() {
                if inj.model.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(format!(
                        "模型槽位「{}」已选供应商但未填模型名（model 字段必填）",
                        inj.label
                    ));
                }
            }
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
                _ => {}
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
    }

    Ok(problems)
}
