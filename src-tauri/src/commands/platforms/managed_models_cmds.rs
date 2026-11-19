use crate::commands::config::read_provider_store;
use serde_json::Value;
use serde_yaml::Value as YamlValue;
use std::fs;

use super::buddy::{
    attach_codebuddy_config_meta, codebuddy_chat_url, codebuddy_config_path_for_scope,
    codebuddy_load_candidate, codebuddy_supports_reasoning,
};
use super::common::{ensure_backup, parse_json_object, ProviderModelItem, ProviderModelsEntry, PLATFORM_ZCODE};
use super::deepseek_harness::{harness_entries_from_settings, write_harness_managed_models};
use super::hermes::{
    hermes_entries_from_config, hermes_managed_names_from_state, write_hermes_managed_models,
};
use super::pi::{
    merge_managed_state, pi_entries_from_provider_map, pi_is_managed_provider,
    write_pi_managed_models,
};
use super::platform_enum::Platform;
use super::yaml_block::parse_yaml_value;
use super::zcode::{
    load_zcode_models, write_zcode_models_to_path, zcode_cli_config_path, zcode_config_path,
};
use super::zcode_sync::sync_zcode_personal_config;

/// 读取 CodeBuddy models.json 的完整内容。
#[tauri::command]
pub fn load_codebuddy_models(platform: String) -> Result<serde_json::Value, String> {
    if platform == PLATFORM_ZCODE {
        return load_zcode_models();
    }

    let (path, scope) = codebuddy_load_candidate(&platform)?;
    if !path.exists() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": path.to_string_lossy().to_string(),
            "_configScope": scope,
        }));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": path.to_string_lossy().to_string(),
            "_configScope": scope,
        }));
    }
    let value: serde_json::Value = json5::from_str(&raw).map_err(|e| format!("解析失败: {e}"))?;
    Ok(attach_codebuddy_config_meta(value, &path, scope))
}

/// 保存 CodeBuddy / WorkBuddy models.json（原子写 + 自动备份）。
///
/// `available_models` 参数保留以兼容前端调用，但**刻意不写入磁盘**。
/// 客户端对 `availableModels` 字符串数组做 SmartMerge 时是整表替换；
/// 若只含自定义模型 id，随后 AvailableModelsFilter 会把官方模型全部过滤掉。
#[tauri::command]
pub fn save_codebuddy_models(
    platform: String,
    models: Vec<serde_json::Value>,
    available_models: Vec<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let _ = available_models; // 兼容旧前端参数；勿写回 models.json

    if platform == PLATFORM_ZCODE {
        let path = zcode_config_path()?;
        write_zcode_models_to_path(&path, &models)?;
        let cli_path = zcode_cli_config_path()?;
        write_zcode_models_to_path(&cli_path, &models)?;
        sync_zcode_personal_config(&models)?;
        return Ok(path.to_string_lossy().to_string());
    }

    let path = codebuddy_config_path_for_scope(&platform, scope.as_deref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    ensure_backup(&path)?;

    let payload = serde_json::json!({
        "models": models,
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {e}"))?;
    crate::commands::write_atomic(&path, json.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取 Pi 受管模型：models.json 里 anybridge-* provider + 停用状态文件合并。
#[tauri::command]
pub fn load_pi_models() -> Result<serde_json::Value, String> {
    let plat = Platform::Pi;
    let path = plat.config_path().ok_or("无法定位 Pi 配置路径")?;
    let dir = plat.config_dir().ok_or("无法定位 Pi 配置目录")?;

    let mut models: Vec<serde_json::Value> = Vec::new();
    if path.exists() {
        let raw =
            fs::read_to_string(&path).map_err(|e| format!("读取 Pi models.json 失败: {e}"))?;
        let obj = parse_json_object(&raw, "models.json")?;
        if let Some(providers) = obj.get("providers").and_then(Value::as_object) {
            for (provider_id, provider) in providers {
                if !pi_is_managed_provider(provider_id, provider) {
                    continue;
                }
                if let Some(map) = provider.as_object() {
                    models.extend(pi_entries_from_provider_map(provider_id, map));
                }
            }
        }
    }

    merge_managed_state(&mut models, &dir)?;

    Ok(serde_json::json!({
        "models": models,
        "availableModels": [],
        "_configPath": path.to_string_lossy().to_string(),
        "_configScope": "user",
        "_settingsPath": plat
            .pi_settings_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }))
}

/// 保存 Pi 模型表格：写 models.json（受管条目全量替换）+ settings.json 默认模型。
#[tauri::command]
pub fn save_pi_models(
    models: Vec<serde_json::Value>,
    available_models: Vec<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let _ = available_models; // Pi 没有可用模型白名单概念；保留参数与其他平台命令同构
    let _ = scope; // Pi 只支持用户级配置
    let path = Platform::Pi
        .config_path()
        .ok_or("无法定位 Pi 配置路径")?;
    write_pi_managed_models(&path, &models)?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取 Hermes 受管模型：config.yaml 的 custom_providers + 停用状态文件。
#[tauri::command]
pub fn load_hermes_models() -> Result<serde_json::Value, String> {
    let plat = Platform::Hermes;
    let path = plat.config_path().ok_or("无法定位 Hermes 配置路径")?;
    let dir = plat.config_dir().ok_or("无法定位 Hermes 配置目录")?;
    let root = if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("读取 Hermes config.yaml 失败: {e}"))?;
        parse_yaml_value(&raw, "config.yaml")?
    } else {
        YamlValue::Mapping(serde_yaml::Mapping::new())
    };
    let managed_names = hermes_managed_names_from_state(&dir);
    let mut models = hermes_entries_from_config(&root, &managed_names);
    merge_managed_state(&mut models, &dir)?;
    Ok(serde_json::json!({
        "models": models,
        "availableModels": [],
        "_configPath": path.to_string_lossy().to_string(),
        "_configScope": "user",
    }))
}

/// 保存 Hermes 模型表格：写 custom_providers 与默认模型。
#[tauri::command]
pub fn save_hermes_models(
    models: Vec<serde_json::Value>,
    available_models: Vec<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let _ = available_models; // Hermes 没有可用模型白名单概念
    let _ = scope; // Hermes 只支持用户级配置
    let path = Platform::Hermes
        .config_path()
        .ok_or("无法定位 Hermes 配置路径")?;
    write_hermes_managed_models(&path, &models)?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取 DeepSeek Harness 受管模型：settings.yaml 的 llm-pi-ai.providers
/// 与 .credentials.yaml 的 refs 共同还原条目。
#[tauri::command]
pub fn load_deepseek_harness_models() -> Result<serde_json::Value, String> {
    let plat = Platform::DeepSeekHarness;
    let path = plat
        .config_path()
        .ok_or("无法定位 DeepSeek Harness 配置路径")?;
    let credentials_path = plat
        .deepseek_harness_credentials_path()
        .ok_or("无法定位 DeepSeek Harness 凭据路径")?;
    let dir = plat
        .config_dir()
        .ok_or("无法定位 DeepSeek Harness 配置目录")?;

    let settings = if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("读取 DeepSeek Harness settings.yaml 失败: {e}"))?;
        parse_yaml_value(&raw, "settings.yaml")?
    } else {
        YamlValue::Mapping(serde_yaml::Mapping::new())
    };
    let credentials = if credentials_path.exists() {
        let raw = fs::read_to_string(&credentials_path)
            .map_err(|e| format!("读取 DeepSeek Harness 凭据失败: {e}"))?;
        parse_yaml_value(&raw, ".credentials.yaml")?
    } else {
        YamlValue::Mapping(serde_yaml::Mapping::new())
    };

    let mut models = harness_entries_from_settings(&settings, &credentials);
    merge_managed_state(&mut models, &dir)?;
    Ok(serde_json::json!({
        "models": models,
        "availableModels": [],
        "_configPath": path.to_string_lossy().to_string(),
        "_configScope": "user",
        "_credentialsPath": credentials_path.to_string_lossy().to_string(),
    }))
}

/// 保存 DeepSeek Harness 模型表格：写 settings.yaml 与 .credentials.yaml。
#[tauri::command]
pub fn save_deepseek_harness_models(
    models: Vec<serde_json::Value>,
    available_models: Vec<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let _ = available_models; // Harness 没有可用模型白名单概念
    let _ = scope; // Harness 只支持用户级配置
    let plat = Platform::DeepSeekHarness;
    let path = plat
        .config_path()
        .ok_or("无法定位 DeepSeek Harness 配置路径")?;
    let credentials_path = plat
        .deepseek_harness_credentials_path()
        .ok_or("无法定位 DeepSeek Harness 凭据路径")?;
    write_harness_managed_models(&path, &credentials_path, &models)?;
    Ok(path.to_string_lossy().to_string())
}

/// 返回所有供应商及其真实模型列表，供平台和本地网关的「从供应商添加」使用。
#[tauri::command]
pub fn list_provider_models() -> Result<Vec<ProviderModelsEntry>, String> {
    let store = read_provider_store()?;
    let mut out = Vec::new();
    for p in &store.providers {
        if p.enabled == false {
            continue;
        }
        let model_ids = p.models.clone();
        let models: Vec<ProviderModelItem> = model_ids
            .iter()
            .map(|m| {
                let caps = p.model_caps.get(m).cloned().unwrap_or_default();
                ProviderModelItem {
                    id: m.clone(),
                    name: m.clone(),
                    supports_tool_call: p.capabilities.tools || caps.tools,
                    supports_images: p.capabilities.vision || caps.vision,
                    supports_reasoning: codebuddy_supports_reasoning(m),
                }
            })
            .collect();
        out.push(ProviderModelsEntry {
            provider_id: p.id.clone(),
            provider_name: p.name.clone(),
            models,
            api_host: p.api_host.clone(),
            api_key: p.api_key.clone(),
            api_path: p.api_path.clone(),
            chat_url: codebuddy_chat_url(p),
            api_format: p.resolved_api_format_str().to_string(),
        });
    }
    Ok(out)
}
