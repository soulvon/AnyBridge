// model_map — 槽位映射表（model-map.json）。
//
// 每个槽位把一个 Windsurf 模型 ID（modelUid）映射到:
//   displayName  下拉框改名（可空，空=显示原始名）
//   enabled      是否将该槽位的 GetChatMessage 路由到第三方
//   targets[]    故障转移链，按顺序尝试 {providerId, model}
//
// sidecar 直接读这份文件 + providers.json 做路由，不再有「激活供应商」概念。

use std::fs;
use std::path::PathBuf;

use super::config::config_dir_path;

mod types;
pub use types::*;

fn model_map_path() -> PathBuf {
    config_dir_path().join("model-map.json")
}

/// 预设 3 槽位:已改名的 Grok 槽位 → Claude Opus 4.6/4.7/4.8。targets 留空（显示「未设置」）。
fn default_slots() -> Vec<Slot> {
    let mk = |uid: &str, name: &str| Slot {
        model_uid: uid.into(),
        display_name: name.into(),
        enabled: true,
        supports_images: true,
        use_third_party_vision: false,
        context_window: None,
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
            show_slot_uid: false,
            show_thinking_effort: false,
            show_context_window: false,
            unlock_scope: default_unlock_scope(),
            slot_display_mode: default_slot_display_mode(),
            slot_visibility_mode: default_slot_visibility_mode(),
            slot_visibility: Vec::new(),
            slots: default_slots(),
            injected: Vec::new(),
            enhancement: default_enhancement(),
            vision_models: VisionModels::default(),
            search_models: SearchModels::default(),
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

    // 不根据槽位名或模型名自动改写 unlock/apiFormat；这些字段属于用户/供应商配置。
    // 运行时由 provider-pool 根据供应商是否启用对应解锁决定是否附加解锁参数。

    Ok(map)
}

fn write_map(map: &ModelMap) -> Result<(), String> {
    let target = model_map_path();
    super::store_io::with_file_lock(&target, || {
        let dir = config_dir_path();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if target.exists() {
            if let Ok(raw) = fs::read_to_string(&target) {
                if let Ok(old_map) = serde_json::from_str::<ModelMap>(&raw) {
                    if !old_map.slots.is_empty() {
                        let backup = dir.join("model-map.json.bak");
                        let _ = super::write_atomic(&backup, raw.as_bytes());
                    }
                }
            }
        }
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        super::write_atomic(&target, json.as_bytes())
    })
}

#[tauri::command]
pub async fn load_model_map() -> Result<ModelMap, String> {
    tauri::async_runtime::spawn_blocking(read_map)
        .await
        .map_err(|e| format!("读取模型映射任务失败: {e}"))?
}

/// 整体保存槽位表（增删改/排序/改 targets 统一走这里）。
/// 校验:
///   槽位: modelUid 不可重复
///   注入项: modelUid 不可与槽位重复; modelUid+label 不可空
#[tauri::command]
pub async fn save_model_map(map: ModelMap) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_model_map_sync(map))
        .await
        .map_err(|e| format!("保存模型映射任务失败: {e}"))?
}

fn save_model_map_sync(map: ModelMap) -> Result<(), String> {
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
    let mut map = map;
    for slot in &mut map.slots {
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
    }
    write_map(&map)?;

    // 异步通知 sidecar 清除 unlockModels 内存缓存，不阻塞保存响应
    super::store_io::notify_sidecar_invalidate_models_async();

    Ok(())
}

/// 启动网关前校验:扫描启用的槽位 + 已配置 providerId 的模型槽位管理项，若 targets/配置为空、
/// 或引用了不存在/未启用的供应商，返回问题描述列表（空列表 = 通过，可启动）。前端据此阻止带病启动。
#[tauri::command]
pub async fn validate_model_map() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let map = read_map()?;
        let store = super::config::read_provider_store()?;
        validate_model_map_with(&map, &store)
    })
    .await
    .map_err(|e| format!("校验模型映射任务失败: {e}"))?
}

fn validate_model_map_with(
    map: &ModelMap,
    store: &super::config::ProviderStore,
) -> Result<Vec<String>, String> {
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
                Some(_p) => {}
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

#[cfg(test)]
mod tests;
