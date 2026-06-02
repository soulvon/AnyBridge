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
    #[serde(default)]
    pub targets: Vec<Target>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelMap {
    #[serde(default)]
    pub slots: Vec<Slot>,
}

/// 预设 3 槽位:已改名的 Grok 槽位 → Claude Opus 4.6/4.7/4.8。targets 留空（显示「未设置」）。
fn default_slots() -> Vec<Slot> {
    let mk = |uid: &str, name: &str| Slot {
        model_uid: uid.into(),
        display_name: name.into(),
        enabled: true,
        targets: Vec::new(),
    };
    vec![
        mk("MODEL_XAI_GROK_3", "Claude Opus 4.6"),
        mk("MODEL_XAI_GROK_3_MINI_REASONING", "Claude Opus 4.7"),
        mk("MODEL_PRIVATE_4", "Claude Opus 4.8"),
    ]
}

fn read_map() -> Result<ModelMap, String> {
    let path = model_map_path();
    if !path.exists() {
        return Ok(ModelMap { slots: default_slots() });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
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
/// 校验:modelUid 不可重复。
#[tauri::command]
pub fn save_model_map(map: ModelMap) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for slot in &map.slots {
        if slot.model_uid.trim().is_empty() {
            return Err("槽位 modelUid 不能为空".into());
        }
        if !seen.insert(slot.model_uid.clone()) {
            return Err(format!("槽位 modelUid 重复: {}", slot.model_uid));
        }
    }
    write_map(&map)
}

/// 启动代理前校验:扫描启用的槽位，若 targets 为空、或引用了不存在/未启用的供应商，
/// 返回问题描述列表（空列表 = 通过，可启动）。前端据此阻止带病启动。
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
    Ok(problems)
}
