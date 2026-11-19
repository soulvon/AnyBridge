// platforms — 「更多平台」：直接接管 Claude Code / Codex / CodeBuddy / OpenCode / ZCode 等 API 端点。

use crate::commands::config::read_provider_store;
use serde_json::Value;
use std::fs;
use tauri::AppHandle;

use antigravity::restore_antigravity_official_config_sync;
use claude::{
    claude_settings_from_config_with_providers, restore_claude_official_config_sync,
};
use codex::restore_codex_official_config_sync;
use common::{backup_path, ensure_backup, parse_json_object, resolve_platform_config};
use detect::{detect_fingerprint, detect_platforms_sync, DETECT_CACHE};
use grok::restore_grok_official_config_sync;
use opencode::{
    opencode_preview_from_config_with_providers, restore_opencode_official_config_sync,
};
use switch_and_update::{
    begin_update, end_update, restore_platform_sync, switch_platform_sync,
    update_platform_agent_inner,
};


mod common;
mod pi;
mod hermes;
mod deepseek_harness;
mod claude;
mod zcode;
mod platform_enum;
mod buddy;
mod yaml_block;
mod antigravity;
mod antigravity_patch;
mod codex;
mod codex_catalog;
mod codex_agents;
mod opencode;
mod grok;
mod model_context;
mod zcode_sync;
mod detect;
mod switch_and_update;
mod platform_preview;
mod platform_restore;
mod managed_models_cmds;

#[cfg(test)]
mod prelude {
    #![allow(unused_imports)]
    pub(super) use super::common::*;
    pub(super) use super::pi::*;
    pub(super) use super::hermes::*;
    pub(super) use super::deepseek_harness::*;
    pub(super) use super::claude::*;
    pub(super) use super::zcode::*;
    pub(super) use super::platform_enum::*;
    pub(super) use super::buddy::*;
    pub(super) use super::yaml_block::*;
    pub(super) use super::antigravity::*;
    pub(super) use super::antigravity_patch::*;
    pub(super) use super::codex::*;
    pub(super) use super::codex_catalog::*;
    pub(super) use super::codex_agents::*;
    pub(super) use super::opencode::*;
    pub(super) use super::grok::*;
    pub(super) use super::model_context::*;
    pub(super) use super::zcode_sync::*;
    pub(super) use super::detect::*;
    pub(super) use super::switch_and_update::*;
    pub(super) use super::platform_preview::*;
    pub(super) use super::platform_restore::*;
}

pub use antigravity_patch::spawn_antigravity_endpoint_keeper;
pub use common::{PlatformInfo, PlatformUpdateInfo, SwitchResult};
pub use managed_models_cmds::*;
pub(crate) use antigravity::{antigravity_hub_config_dir, antigravity_ide_config_dir};
pub(crate) use antigravity_patch::{
    antigravity_hub_asar_candidates, hub_endpoint_node_name, patch_antigravity_hub_asar,
};
pub(crate) use codex::codex_home;
pub(crate) use codex_catalog::{
    catalog_entry_has_required_fields, codex_bundled_model_template, generate_model_catalog_json,
    is_codex_bundled_model, read_codex_model_template, resolve_codex_model_catalog_entries,
    CODEX_MODEL_CATALOG_FILENAME,
};
pub(crate) use common::{declared_base_url, emit_switch_progress};
pub(crate) use detect::invalidate_detect_cache;
pub(crate) use platform_enum::Platform;
pub(crate) use yaml_block::{deepseek_harness_home, hermes_config_dir};

#[cfg(test)]
use prelude::*;


#[tauri::command]
pub async fn detect_platforms(force: Option<bool>) -> Result<Vec<PlatformInfo>, String> {
    let force = force.unwrap_or(false);
    if !force {
        let fp = detect_fingerprint();
        let cache = DETECT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((cached_fp, list)) = cache.as_ref() {
            if *cached_fp == fp {
                return Ok(list.clone());
            }
        }
    }
    let result = tauri::async_runtime::spawn_blocking(detect_platforms_sync)
        .await
        .map_err(|e| format!("检测平台状态任务执行失败: {e}"))?;
    if let Ok(list) = &result {
        // 以扫描完成时刻的指纹入库：扫描期间文件又变了也不亏——
        // 下次进来指纹对不上，会重扫一次拿到最新状态
        let fp = detect_fingerprint();
        let mut cache = DETECT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        *cache = Some((fp, list.clone()));
    }
    result
}


#[tauri::command]
pub async fn check_platform_update(platform: String) -> Result<PlatformUpdateInfo, String> {
    // 三套体系都支持：
    // - Platform enum 的 13 平台（CLI 探测 --version / GUI 读 product.json）
    // - ide_proxy 体系的 windsurf/devin/cursor（GUI 探测 product.json）
    // - Agent 声明表新增的 agent（spec-only：CLI 探测 + 声明式安装证据）
    let (plat_id, npm_package, install_evidence) = match Platform::from_id(&platform) {
        Some(p) => (
            p.id().to_string(),
            crate::commands::version_probe::cli_spec(p.id())
                .and_then(|s| s.npm_package.map(|x| x.to_string())),
            p.detect_installed(),
        ),
        None if crate::commands::version_probe::gui_product(&platform).is_some() => {
            // windsurf/devin/cursor：settings.json 存在 = 有安装证据
            let evidence = crate::commands::ide_config::settings_path(&platform)
                .map(|p| p.exists())
                .unwrap_or(false);
            (platform.clone(), None, evidence)
        }
        None => {
            let spec = crate::commands::agent_spec::find(&platform)
                .ok_or_else(|| format!("未知平台: {platform}"))?;
            (
                spec.id.to_string(),
                spec.npm_package.map(|p| p.to_string()),
                spec.detect_installed(),
            )
        }
    };

    let current = {
        let pid = plat_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::version_probe::installed_version(&pid)
        })
        .await
        .map_err(|e| format!("版本探测任务执行失败: {e}"))?
    };

    // 三态语义（坑点库 read-failure-is-unknown）：
    // installed = 有安装证据（配置目录/文件存在），与版本探测是否成功无关；
    // 版本探测失败 = 已安装但版本未知，绝不当「未安装」。
    let installed = install_evidence || current.is_some();

    // GUI 平台（Windsurf/Devin/Cursor/Antigravity）没有 npm 包名，latest
    // 当前返回 None（未知）；官网 release feed 等有真实需求再接入。
    let latest = if current.is_some() {
        match npm_package.as_deref() {
            Some(pkg) => crate::commands::version_probe::npm_latest_version(pkg).await,
            // 没有 npm 包（如 grok 官方 CLI）→ 走官方版本通道
            None => match crate::commands::agent_spec::find(&plat_id).and_then(|s| s.latest_channel) {
                Some(urls) => crate::commands::version_probe::channel_latest_version(urls).await,
                None => None,
            },
        }
    } else {
        None
    };

    let has_update = match (&latest, &current) {
        (Some(l), Some(c)) => crate::commands::version_probe::is_newer(l, c),
        _ => false,
    };

    // 一键安装/更新的能力位：有 npm 包 + 环境可写（探针缓存 5 分钟）
    let can_auto_update =
        npm_package.is_some() && crate::commands::version_probe::npm_install_capability();
    // 官方自更新能力（与平台 id 绑定；先取值避免 plat_id 被 move 后借用）
    let has_self_update = crate::commands::agent_spec::find(&plat_id)
        .map(|s| s.self_update.is_some())
        .unwrap_or(false);

    Ok(PlatformUpdateInfo {
        platform: plat_id,
        installed,
        current_version: current,
        latest_version: latest,
        has_update,
        npm_package,
        has_self_update,
        can_auto_update,
        updated_from: None,
        outcome: "unchanged",
    })
}


/// 一键更新平台 CLI（走官方 npm 命令 + 更新后验证），返回更新后的状态。
/// 仅支持有 npm 包的 CLI 平台；GUI 客户端（Windsurf/Devin/Cursor/Antigravity）
/// 的更新走官网下载，暂不在此实现。
#[tauri::command]
pub async fn update_platform_agent(platform: String) -> Result<PlatformUpdateInfo, String> {
    // 互斥在外层：无论内部从哪个出口返回都解锁，不会漏（连点也不会并发装）
    begin_update(&platform)?;
    let result = update_platform_agent_inner(platform.clone()).await;
    end_update(&platform);
    result
}


/// 预览将写入目标平台的配置片段（token 脱敏），供 UI 做 diff 展示。
#[tauri::command]
pub async fn preview_platform_switch(
    platform: String,
    provider_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || preview_platform_switch_sync(&platform, &provider_id))
        .await
        .map_err(|e| format!("预览平台配置任务失败: {e}"))?
}

fn preview_platform_switch_sync(platform: &str, provider_id: &str) -> Result<String, String> {
    let plat = Platform::from_id(platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    let store = read_provider_store()?;
    if matches!(plat, Platform::ClaudeDesktop) {
        let bindings = if let Some(cfg) = store
            .claude_desktop_configs
            .iter()
            .find(|c| c.id == provider_id)
        {
            cfg.validate_active_source(&store.providers)?;
            Some(crate::commands::proxy_routes::ClaudeDesktopBindings {
                sonnet: cfg.sonnet_model.clone(),
                opus: cfg.opus_model.clone(),
                haiku: cfg.haiku_model.clone(),
                fable: cfg.fable_model.clone(),
                sonnet_name: cfg.sonnet_name.clone(),
                opus_name: cfg.opus_name.clone(),
                haiku_name: cfg.haiku_name.clone(),
                fable_name: cfg.fable_name.clone(),
            })
        } else {
            None
        };
        return crate::commands::claude_desktop::preview_claude_desktop(bindings);
    }
    if matches!(plat, Platform::ClaudeCode) {
        let config = store
            .claude_code_configs
            .iter()
            .find(|config| config.id == provider_id)
            .ok_or_else(|| format!("Claude Code 配置不存在: {provider_id}"))?;
        config.validate_active_source(&store.providers)?;
        return serde_json::to_string_pretty(&claude_settings_from_config_with_providers(
            config,
            &store.providers,
            true,
        ))
        .map_err(|e| e.to_string());
    }
    if matches!(plat, Platform::OpenCode) {
        let config = store
            .opencode_configs
            .iter()
            .find(|config| config.id == provider_id)
            .ok_or_else(|| format!("OpenCode 配置不存在: {provider_id}"))?;
        config.validate_active_source(&store.providers)?;
        return serde_json::to_string_pretty(&opencode_preview_from_config_with_providers(
            config,
            &store.providers,
        ))
        .map_err(|e| e.to_string());
    }
    let provider = resolve_platform_config(&plat, &store, provider_id)?;
    plat.preview(&provider)
}


/// 切换平台供应商：备份 + 写入配置文件，并记录到 providerStore.platforms。
#[tauri::command]
pub async fn switch_platform(
    app: AppHandle,
    platform: String,
    provider_id: String,
) -> Result<SwitchResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        switch_platform_sync(&app, &platform, &provider_id)
    })
    .await
    .map_err(|e| format!("切换平台任务执行失败: {e}"))?;
    if result.is_ok() {
        invalidate_detect_cache();
    }
    result
}


/// 从 OpenCode live 配置移除一个 provider entry；不删除 AnyBridge 保存的 OpenCode 配置方案。
#[tauri::command]
pub async fn remove_opencode_config_from_live(provider_id: String) -> Result<SwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || remove_opencode_config_from_live_sync(&provider_id))
        .await
        .map_err(|e| format!("移除 OpenCode 配置任务失败: {e}"))?
}

fn remove_opencode_config_from_live_sync(provider_id: &str) -> Result<SwitchResult, String> {
    let plat = Platform::OpenCode;
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    if path.exists() {
        ensure_backup(&path)?;
    }

    let raw = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "opencode.json")?;
    if let Some(providers) = obj.get_mut("provider").and_then(Value::as_object_mut) {
        providers.remove(provider_id);
    }
    let cleared_current_model = obj
        .get("model")
        .and_then(Value::as_str)
        .map(|model| model.starts_with(&format!("{provider_id}/")))
        .unwrap_or(false);
    if cleared_current_model {
        obj.remove("model");
    }

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())?;

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    Ok(SwitchResult {
        ok: true,
        message: if cleared_current_model {
            format!(
                "已从 OpenCode live 配置移除「{}」，并清除指向它的当前 model",
                provider_id
            )
        } else {
            format!("已从 OpenCode live 配置移除「{}」", provider_id)
        },
        config_path,
        backup_path: backup,
    })
}


/// 从备份还原平台配置（回到 AnyBridge 接管前的状态），并清除接管记录。
///
/// async + spawn_blocking：plat.restore() 含 asar 补丁等重文件 IO，
/// 同步 command 在 Tauri 主线程执行会冻结整个 UI（与汉化卡死同款问题）。
#[tauri::command]
pub async fn restore_platform(app: AppHandle, platform: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || restore_platform_sync(&app, &platform))
        .await
        .map_err(|e| format!("还原平台任务执行失败: {e}"))?
}


/// 切回 Antigravity 官方环境：清理 AnyBridge 写入的 jetski.cloudCodeUrl 及环境变量，保留其他设置。
/// async + spawn_blocking：备份/写配置是重文件 IO，同步会冻结 UI（同 restore_platform）。
#[tauri::command]
pub async fn restore_antigravity_official_config(
    app: AppHandle,
    platform: Option<String>,
) -> Result<SwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        restore_antigravity_official_config_sync(&app, platform.as_deref())
    })
    .await
    .map_err(|e| format!("还原 Antigravity 任务执行失败: {e}"))?
}


/// 切回 Claude Code 官方环境：清理 AnyBridge 写入的 ANTHROPIC_* env 字段，保留其他设置。
#[tauri::command]
/// async + spawn_blocking：备份 + 写配置是文件 IO，同步 command 在主线程
/// 执行会阻塞 UI。与 restore_codex_official_config / restore_platform 对称。
pub async fn restore_claude_official_config(app: AppHandle) -> Result<SwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_claude_official_config_sync(&app))
        .await
        .map_err(|e| format!("还原任务执行失败: {e}"))?
}


/// 切回 Grok 官方环境：清理 AnyBridge 写入的 [models].default 及 [model.<id>] 托管字段。
#[tauri::command]
/// async + spawn_blocking：备份 + 写配置是文件 IO，同步 command 在主线程
/// 执行会阻塞 UI。与 restore_codex_official_config / restore_platform 对称。
pub async fn restore_grok_official_config(app: AppHandle) -> Result<SwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_grok_official_config_sync(&app))
        .await
        .map_err(|e| format!("还原任务执行失败: {e}"))?
}


/// 切回 OpenCode 官方环境 (Zen / Go)：清理 AnyBridge 写入的托管 provider 与 model 指向。
#[tauri::command]
/// async + spawn_blocking：备份 + 写配置是文件 IO，同步 command 在主线程
/// 执行会阻塞 UI。与 restore_codex_official_config / restore_platform 对称。
pub async fn restore_opencode_official_config(app: AppHandle) -> Result<SwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_opencode_official_config_sync(&app))
        .await
        .map_err(|e| format!("还原任务执行失败: {e}"))?
}


/// 切回 Codex 官方 OpenAI 配置：不依赖 .byok-bak，不修改 auth.json。
#[tauri::command]
pub async fn restore_codex_official_config(app: AppHandle) -> Result<SwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_codex_official_config_sync(&app))
        .await
        .map_err(|e| format!("切回官方配置任务执行失败: {e}"))?
}


/// 手动修复 Codex 历史会话可见性：对齐当前 config.toml 的 model_provider 与本地会话索引。
#[tauri::command]
pub fn repair_codex_session_visibility(
) -> Result<crate::commands::codex_session_visibility::CodexSessionVisibilityRepairSummary, String> {
    let path = Platform::Codex
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    crate::commands::codex_session_visibility::repair_default_codex_session_visibility(&path)
}


/// 读取指定平台在本地磁盘上的真实完整配置文件内容（原样读取，保留所有空行、注释与嵌套结构）。
#[tauri::command]
pub async fn read_platform_config_file(platform: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
        let path = plat
            .config_path()
            .ok_or_else(|| "无法定位该平台配置路径".to_string())?;
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| format!("读取配置文件失败: {e}"))
    })
    .await
    .map_err(|e| format!("读取配置文件任务失败: {e}"))?
}


/// 将编辑修改后的文本内容原样写回本地磁盘的真实配置文件（自动安全备份 + 原子写入）。
#[tauri::command]
pub async fn write_platform_config_file(platform: String, content: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
        let path = plat
            .config_path()
            .ok_or_else(|| "无法定位该平台配置路径".to_string())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        if path.exists() {
            let _ = ensure_backup(&path);
        }
        crate::commands::write_atomic(&path, content.as_bytes())
            .map_err(|e| format!("写入配置文件失败: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("写入配置文件任务失败: {e}"))?
}


#[cfg(test)]
mod tests;
