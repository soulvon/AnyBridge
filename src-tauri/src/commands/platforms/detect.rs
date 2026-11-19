use crate::commands::config::read_provider_store;

use super::antigravity::read_antigravity_config_info;
use super::claude::{claude_provider_matches_config, detect_claude_drift, read_claude_config_info};
use super::codex::read_codex_config_info;
use super::common::{DriftField, PlatformInfo};
use super::grok::{grok_sanitize_key, read_grok_config_info};
use super::opencode::{read_opencode_active_model_provider_id, read_opencode_live_provider_ids};
use super::platform_enum::Platform;


// ═══════ TAURI COMMANDS ═══════

/// 检测所有支持的平台：安装状态 + 当前接管的供应商 + 备份是否存在。
///
/// 缓存失效策略（借鉴 magpie filememo）：按**输入文件指纹**（每个平台
/// 配置文件及其备份、providers.json 的 mtime+size）失效，而不是时间
/// TTL——磁盘没变就绝不重扫（旧实现 3 秒 TTL 下每次进 tab 都全扫
/// 13 平台，其中 Claude Desktop 每次 spawn PowerShell 1-3 秒）。
/// 外部改了配置文件 → 指纹变 → 自动重扫，漂移检测也随之刷新。
pub(in crate::commands::platforms) static DETECT_CACHE: std::sync::Mutex<Option<(String, Vec<PlatformInfo>)>> =
    std::sync::Mutex::new(None);


/// 任何改变平台接管状态的操作（接入/还原/汉化）之后都必须调用，
/// 否则指纹缓存会让随后的 detect_platforms 返回过期状态
///（如 Claude Desktop 的 Appx 状态无文件指纹，只能靠它强制失效）。
pub(crate) fn invalidate_detect_cache() {
    if let Ok(mut cache) = DETECT_CACHE.lock() {
        *cache = None;
    }
}


/// 检测输入指纹：所有会影响 detect_platforms_sync 结果的文件快照。
/// stat 十几个文件是微秒级 metadata 调用，比 spawn PowerShell 便宜几个量级。
pub(in crate::commands::platforms) fn detect_fingerprint() -> String {
    let mut fp = String::new();
    let mut stamp = |label: &str, path: Option<std::path::PathBuf>| {
        let Some(path) = path else { return };
        match std::fs::metadata(&path) {
            Ok(meta) => {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                fp.push_str(&format!("{label}:{}:{}:{};", path.display(), meta.len(), mtime));
            }
            // 文件不存在也是一种状态（未安装/已删除），一并进指纹
            Err(_) => fp.push_str(&format!("{label}:{}:absent;", path.display())),
        }
    };
    stamp("store", Some(crate::commands::config::providers_path()));
    for plat in ALL_PLATFORMS {
        let config = plat.config_path();
        stamp(plat.id(), config.clone());
        // 备份文件存在性进指纹（backupExists 展示给用户）
        if let Some(cfg) = &config {
            let mut bak = cfg.clone();
            bak.as_mut_os_string().push(".byok-bak");
            stamp("bak", Some(bak));
        }
    }
    fp
}


/// 全量检测的平台清单：detect_platforms_sync（扫描）与 detect_fingerprint
///（指纹）共用同一份——新增平台只改这一处，杜绝两份清单漂移。
pub(in crate::commands::platforms) const ALL_PLATFORMS: [Platform; 13] = [
    Platform::Antigravity,
    Platform::AntigravityIde,
    Platform::ClaudeCode,
    Platform::ClaudeDesktop,
    Platform::Codex,
    Platform::CodeBuddy,
    Platform::Grok,
    Platform::OpenCode,
    Platform::WorkBuddy,
    Platform::ZCode,
    Platform::Pi,
    Platform::Hermes,
    Platform::DeepSeekHarness,
];


pub(in crate::commands::platforms) fn detect_platforms_sync() -> Result<Vec<PlatformInfo>, String> {
    let store = read_provider_store().unwrap_or_default();
    let mut out = Vec::with_capacity(ALL_PLATFORMS.len());

    for plat in ALL_PLATFORMS {
        let config_path_buf = plat.config_path();
        let config_path = config_path_buf
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let backup_exists = plat.backup_exists();

        let state = store.platforms.get(plat.id());
        let mut current_provider_id = state.map(|s| s.provider_id.clone());
        let mut applied_at = state.map(|s| s.applied_at.clone());
        let mut current_provider_name = current_provider_id.as_ref().and_then(|pid| {
            if matches!(plat, Platform::Antigravity | Platform::AntigravityIde) {
                store
                    .antigravity_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
                    .or_else(|| {
                        store
                            .providers
                            .iter()
                            .find(|p| &p.id == pid)
                            .map(|p| p.name.clone())
                    })
            } else if matches!(plat, Platform::ClaudeCode) {
                store
                    .claude_code_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
            } else if matches!(plat, Platform::Codex) {
                store
                    .codex_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
            } else if matches!(plat, Platform::OpenCode) {
                store
                    .opencode_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
            } else if matches!(plat, Platform::Grok) {
                store
                    .grok_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
                    .or_else(|| {
                        store
                            .providers
                            .iter()
                            .find(|p| &p.id == pid)
                            .map(|p| p.name.clone())
                    })
            } else {
                store
                    .providers
                    .iter()
                    .find(|p| &p.id == pid)
                    .map(|p| p.name.clone())
            }
        });
        let mut managed_by_any_bridge = state.is_some();
        let mut drifted_fields: Vec<DriftField> = Vec::new();
        let mut claude_config = None;
        let mut codex_config = None;
        let mut antigravity_config = None;
        let mut live_provider_ids = Vec::new();
        let mut error = None;

        if matches!(plat, Platform::ClaudeDesktop) {
            match crate::commands::claude_desktop::get_status_sync() {
                Ok(cd_status) => {
                    managed_by_any_bridge = cd_status.managed_by_any_bridge;
                    if managed_by_any_bridge {
                        let active_id = cd_status
                            .current_provider_id
                            .unwrap_or_else(|| "claude-desktop-default-proxy".to_string());
                        let cfg_name = store
                            .claude_desktop_configs
                            .iter()
                            .find(|c| c.id == active_id)
                            .map(|c| c.name.clone())
                            .unwrap_or_else(|| "AnyBridge 本地路由".to_string());
                        current_provider_id = Some(active_id);
                        current_provider_name = Some(cfg_name);
                    } else if cd_status.installed {
                        current_provider_id = Some("anthropic-official".to_string());
                        current_provider_name = Some("Anthropic 官方 (1P)".to_string());
                        applied_at = None;
                    } else {
                        current_provider_id = None;
                        current_provider_name = None;
                        applied_at = None;
                    }
                }
                Err(e) => {
                    error = Some(e);
                }
            }
        } else if matches!(plat, Platform::ClaudeCode) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_claude_config_info(path) {
                    Ok(Some(mut info)) => {
                        if info.is_official {
                            current_provider_id = Some("anthropic-official".to_string());
                            current_provider_name = Some("Anthropic 官方".to_string());
                            managed_by_any_bridge = false;
                            applied_at = None;
                        } else {
                            let matched_config = store.claude_code_configs.iter().find(|config| {
                                let provider = config.resolve_provider(&store.providers);
                                claude_provider_matches_config(&info, &provider)
                            });
                            let state_matches = state
                                .and_then(|s| {
                                    store.claude_code_configs.iter().find(|config| {
                                        if config.id != s.provider_id {
                                            return false;
                                        }
                                        let provider = config.resolve_provider(&store.providers);
                                        claude_provider_matches_config(&info, &provider)
                                    })
                                })
                                .is_some();

                            if state_matches {
                                managed_by_any_bridge = true;
                                current_provider_id = state.map(|s| s.provider_id.clone());
                                current_provider_name =
                                    current_provider_id.as_ref().and_then(|pid| {
                                        store
                                            .claude_code_configs
                                            .iter()
                                            .find(|config| &config.id == pid)
                                            .map(|config| config.name.clone())
                                    });
                            } else {
                                managed_by_any_bridge = false;
                                applied_at = None;
                                current_provider_id = matched_config
                                    .map(|config| config.id.clone())
                                    .or_else(|| info.base_url.clone());
                                current_provider_name = matched_config
                                    .map(|config| config.name.clone())
                                    .or_else(|| Some("外部配置".to_string()));
                            }
                        }
                        info.managed_by_any_bridge = managed_by_any_bridge;
                        claude_config = Some(info);
                        // 漂移检测：只在接管中（有记录且状态匹配）比对才有意义——
                        // 未接管时字段本来就该是原值，报漂移只会误导
                        if managed_by_any_bridge && state.is_some() {
                            drifted_fields = detect_claude_drift(path);
                        }
                    }
                    Ok(None) => {
                        managed_by_any_bridge = false;
                        applied_at = None;
                        current_provider_id = Some("anthropic-official".to_string());
                        current_provider_name = Some("Anthropic 官方".to_string());
                    }
                    Err(e) => {
                        error = Some(e);
                    }
                }
            }
        } else if matches!(plat, Platform::Codex) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_codex_config_info(path) {
                    Ok(info) => {
                        if let Some(info) = info {
                            if info.is_official {
                                current_provider_id = Some("openai-official".to_string());
                                current_provider_name = Some("OpenAI 官方".to_string());
                            } else {
                                current_provider_id = if info.managed_by_any_bridge {
                                    state
                                        .map(|s| s.provider_id.clone())
                                        .or_else(|| info.model_provider_id.clone())
                                } else {
                                    info.model_provider_id.clone()
                                };
                                current_provider_name = info.provider_name.clone().or_else(|| {
                                    current_provider_id.as_ref().and_then(|pid| {
                                        store
                                            .codex_configs
                                            .iter()
                                            .find(|config| &config.id == pid)
                                            .map(|config| config.name.clone())
                                    })
                                });
                            }
                            managed_by_any_bridge = info.managed_by_any_bridge;
                            if !managed_by_any_bridge {
                                applied_at = None;
                            }
                            codex_config = Some(info);
                        }
                    }
                    Err(e) => {
                        error = Some(e);
                    }
                }
            }
        } else if matches!(plat, Platform::Antigravity | Platform::AntigravityIde) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_antigravity_config_info(path) {
                    Ok(Some(info)) => {
                        if info.is_official {
                            current_provider_id = Some("google-official".to_string());
                            current_provider_name = Some("Google 官方直连".to_string());
                            managed_by_any_bridge = false;
                            applied_at = None;
                        } else {
                            managed_by_any_bridge = info.managed_by_any_bridge;
                            if managed_by_any_bridge && current_provider_name.is_none() {
                                current_provider_name = Some("AnyBridge 内置供应商".to_string());
                            }
                        }
                        antigravity_config = Some(info);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error = Some(e);
                    }
                }
            }
        } else if matches!(plat, Platform::OpenCode) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_opencode_live_provider_ids(path) {
                    Ok(ids) => {
                        live_provider_ids = ids;
                        let active_provider_id =
                            read_opencode_active_model_provider_id(path).ok().flatten();
                        current_provider_id = active_provider_id.or_else(|| {
                            if live_provider_ids.len() == 1 {
                                live_provider_ids.first().cloned()
                            } else {
                                None
                            }
                        });
                        managed_by_any_bridge = live_provider_ids
                            .iter()
                            .any(|id| store.opencode_configs.iter().any(|config| &config.id == id));
                        applied_at = None;
                        current_provider_name = current_provider_id.as_ref().and_then(|pid| {
                            store
                                .opencode_configs
                                .iter()
                                .find(|config| &config.id == pid)
                                .map(|config| config.name.clone())
                                .or_else(|| Some(pid.clone()))
                        });
                        if current_provider_name.is_none() && !live_provider_ids.is_empty() {
                            current_provider_name =
                                Some(format!("已加入 {} 个配置", live_provider_ids.len()));
                        }
                    }
                    Err(e) => {
                        managed_by_any_bridge = false;
                        applied_at = None;
                        error = Some(e);
                    }
                }
            }
        } else if matches!(plat, Platform::Grok) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_grok_config_info(path) {
                    Ok(Some((default_id, name, is_managed, live_ids))) => {
                        live_provider_ids = live_ids;
                        if let Some(def_id) = default_id {
                            let matched_config = store
                                .grok_configs
                                .iter()
                                .find(|c| c.id == def_id || grok_sanitize_key(&c.id) == def_id);
                            if let Some(cfg) = matched_config {
                                current_provider_id = Some(cfg.id.clone());
                                current_provider_name = Some(cfg.name.clone());
                                managed_by_any_bridge = true;
                            } else {
                                current_provider_id = Some(def_id.clone());
                                current_provider_name = name.or_else(|| Some(def_id.clone()));
                                managed_by_any_bridge = is_managed
                                    || state
                                        .as_ref()
                                        .map(|s| {
                                            s.provider_id == def_id
                                                || grok_sanitize_key(&s.provider_id) == def_id
                                        })
                                        .unwrap_or(false);
                            }
                        } else if state.is_none() {
                            managed_by_any_bridge = false;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error = Some(e);
                    }
                }
            }
        }

        // 版本探测：CLI 跑 --version（缓存 10 分钟）/ GUI 读 product.json。
        // 未安装的平台跳过探测（省子进程开销）；读失败 = None（版本未知）。
        let installed = plat.detect_installed();
        let (version, npm_package) = if installed {
            (
                crate::commands::version_probe::installed_version(plat.id()),
                crate::commands::version_probe::cli_spec(plat.id())
                    .and_then(|s| s.npm_package.map(|p| p.to_string())),
            )
        } else {
            (None, None)
        };

        out.push(PlatformInfo {
            id: plat.id().to_string(),
            display_name: plat.display_name().to_string(),
            vendor: plat.vendor().to_string(),
            required_api_format: plat.required_api_format().to_string(),
            installed,
            version,
            npm_package,
            config_path,
            backup_exists,
            current_provider_id,
            current_provider_name,
            managed_by_any_bridge,
            applied_at,
            live_provider_ids,
            codex_config,
            claude_config,
            antigravity_config,
            drifted_fields,
            error,
        });
    }
    Ok(out)
}
