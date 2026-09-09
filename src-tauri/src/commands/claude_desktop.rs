// claude_desktop.rs — Claude Desktop 3P Gateway 推理网关配置接管
//
// 职责：
//   - 定位 Claude Desktop 配置文件（Windows: %LOCALAPPDATA%\Claude*; macOS: ~/Library/Application Support/Claude*）
//   - 写入 3P 网关 profile 指向 AnyBridge 本地代理 (http://127.0.0.1:<PORT>/claude-desktop)
//   - 将 Sonnet/Opus/Haiku(+Fable) 角色档位映射为代理模型
//   - 还原为官方 1P 模式
//   - 写入前对 4 处文件快照并在出错时完整回滚

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::config::{configured_proxy_ports, read_config_value};
use super::platforms::SwitchResult;
use super::proxy_routes::{find_route_by_uid, read_routes, ClaudeDesktopBindings};
use super::write_atomic;

pub const PROFILE_ID: &str = "00000000-0000-4000-8000-000000287450";
pub const PROFILE_NAME: &str = "AnyBridge";
pub const CONFIG_FILE: &str = "claude_desktop_config.json";
pub const CONFIG_LIBRARY_DIR: &str = "configLibrary";

pub const CLAUDE_SONNET_ROUTE: &str = "claude-sonnet-5";
pub const CLAUDE_OPUS_ROUTE: &str = "claude-opus-5";
pub const CLAUDE_HAIKU_ROUTE: &str = "claude-haiku-4-5";
pub const CLAUDE_FABLE_ROUTE: &str = "claude-fable-5";

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ClaudeDesktopPaths {
    pub normal_dir: PathBuf,
    pub threep_dir: PathBuf,
    pub normal_config_path: PathBuf,
    pub threep_config_path: PathBuf,
    pub config_library_path: PathBuf,
    pub profile_path: PathBuf,
    pub meta_path: PathBuf,
}

#[derive(Debug, Clone)]
struct FileSnapshot {
    path: PathBuf,
    content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopStatus {
    pub supported: bool,
    pub installed: bool,
    pub managed_by_any_bridge: bool,
    pub deployment_mode: Option<String>,
    pub gateway_url: String,
    pub has_gateway_key: bool,
    pub normal_config_path: String,
    pub threep_config_path: String,
    pub profile_path: String,
    pub meta_path: String,
    pub applied_profile_id: Option<String>,
    pub current_provider_id: Option<String>,
    pub bindings: Option<ClaudeDesktopBindings>,
    pub proxy_running: bool,
}

#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub name: String,
    pub label_override: Option<String>,
    pub supports_1m: bool,
}

pub fn is_supported_platform() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

pub fn current_platform_paths() -> Result<ClaudeDesktopPaths, String> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = windows_local_app_data_dir()
            .ok_or_else(|| "无法定位 Windows LOCALAPPDATA 目录".to_string())?;
        return Ok(windows_paths(&local_app_data));
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
        return Ok(macos_paths(&home));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("Claude Desktop 仅在 Windows 和 macOS 上受支持".to_string())
    }
}

#[cfg(target_os = "windows")]
fn windows_local_app_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir())
}

#[cfg(target_os = "windows")]
fn windows_paths(local_app_data: &Path) -> ClaudeDesktopPaths {
    let normal_dir = pick_windows_claude_dir(local_app_data, false)
        .unwrap_or_else(|| local_app_data.join("Claude"));
    let threep_dir = pick_windows_claude_dir(local_app_data, true)
        .unwrap_or_else(|| local_app_data.join("Claude-3p"));
    paths_from_dirs(normal_dir, threep_dir)
}

#[cfg(target_os = "windows")]
fn pick_windows_claude_dir(local_app_data: &Path, threep: bool) -> Option<PathBuf> {
    let exact_name = if threep { "Claude-3p" } else { "Claude" };
    let exact = local_app_data.join(exact_name);
    if exact.exists() {
        return Some(exact);
    }

    let mut candidates: Vec<PathBuf> = fs::read_dir(local_app_data)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return false;
            };
            let starts = name.to_ascii_lowercase().starts_with("claude");
            let is_threep = name.to_ascii_lowercase().contains("-3p");
            starts && is_threep == threep
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

#[cfg(target_os = "macos")]
fn macos_paths(home: &Path) -> ClaudeDesktopPaths {
    let app_support = home.join("Library").join("Application Support");
    paths_from_dirs(app_support.join("Claude"), app_support.join("Claude-3p"))
}

pub fn paths_from_dirs(normal_dir: PathBuf, threep_dir: PathBuf) -> ClaudeDesktopPaths {
    let config_library_path = threep_dir.join(CONFIG_LIBRARY_DIR);
    let profile_path = config_library_path.join(format!("{PROFILE_ID}.json"));
    let meta_path = config_library_path.join("_meta.json");

    ClaudeDesktopPaths {
        normal_config_path: normal_dir.join(CONFIG_FILE),
        threep_config_path: threep_dir.join(CONFIG_FILE),
        config_library_path,
        profile_path,
        meta_path,
        normal_dir,
        threep_dir,
    }
}

pub fn gateway_base_url() -> String {
    let port = configured_proxy_ports().api_port;
    format!("http://127.0.0.1:{port}/claude-desktop")
}

pub fn gateway_api_key() -> Result<String, String> {
    read_config_value("LOCAL_PROXY_KEY")
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "AnyBridge 本地代理 key 尚未生成，请启动代理服务或在代理页生成 key 后重试。"
                .to_string()
        })
}

fn read_json_or_empty(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let val = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if val.is_object() {
        Ok(val)
    } else {
        Ok(json!({}))
    }
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(&path.to_path_buf(), text.as_bytes())
}

fn delete_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除文件失败: {e}"))?;
    }
    Ok(())
}

fn snapshot_files(paths: &ClaudeDesktopPaths) -> Result<Vec<FileSnapshot>, String> {
    [
        &paths.normal_config_path,
        &paths.threep_config_path,
        &paths.profile_path,
        &paths.meta_path,
    ]
    .into_iter()
    .map(|path| {
        let content = if path.exists() {
            Some(fs::read(path).map_err(|e| format!("读取文件快照失败: {e}"))?)
        } else {
            None
        };
        Ok(FileSnapshot {
            path: path.clone(),
            content,
        })
    })
    .collect()
}

fn restore_snapshots(snapshots: &[FileSnapshot]) -> Result<(), String> {
    for snapshot in snapshots {
        match &snapshot.content {
            Some(content) => {
                if let Some(parent) = snapshot.path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                write_atomic(&snapshot.path, content)?;
            }
            None => {
                delete_file(&snapshot.path)?;
            }
        }
    }
    Ok(())
}

fn with_rollback<F>(paths: &ClaudeDesktopPaths, op: F) -> Result<(), String>
where
    F: FnOnce(&ClaudeDesktopPaths) -> Result<(), String>,
{
    let snapshots = snapshot_files(paths)?;
    match op(paths) {
        Ok(()) => Ok(()),
        Err(err) => match restore_snapshots(&snapshots) {
            Ok(()) => Err(err),
            Err(rollback_err) => Err(format!("{err}; 自动回滚失败: {rollback_err}")),
        },
    }
}

pub fn build_gateway_profile(
    base_url: &str,
    api_key: &str,
    model_specs: &[ModelSpec],
) -> Value {
    let inference_models: Vec<Value> = model_specs
        .iter()
        .map(|spec| {
            let mut item = json!({ "name": spec.name });
            if let Some(label) = spec.label_override.as_deref() {
                item["labelOverride"] = json!(label);
            }
            if spec.supports_1m {
                item["supports1m"] = json!(true);
            }
            item
        })
        .collect();

    json!({
        "coworkEgressAllowedHosts": ["*"],
        "disableDeploymentModeChooser": true,
        "inferenceGatewayApiKey": api_key,
        "inferenceGatewayAuthScheme": "bearer",
        "inferenceGatewayBaseUrl": base_url,
        "inferenceProvider": "gateway",
        "inferenceModels": inference_models,
    })
}

fn write_deployment_mode(path: &Path, mode: &str) -> Result<(), String> {
    let mut value = read_json_or_empty(path)?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("deploymentMode".to_string(), Value::String(mode.to_string()));
    }
    write_json_file(path, &value)
}

fn remove_enterprise_config(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut value = read_json_or_empty(path)?;
    let Some(obj) = value.as_object_mut() else {
        return Ok(());
    };
    if let Some(enterprise) = obj.get_mut("enterpriseConfig").and_then(Value::as_object_mut) {
        for key in [
            "disableDeploymentModeChooser",
            "inferenceGatewayApiKey",
            "inferenceGatewayAuthScheme",
            "inferenceGatewayBaseUrl",
            "inferenceProvider",
        ] {
            enterprise.remove(key);
        }
        if enterprise.is_empty() {
            obj.remove("enterpriseConfig");
        }
        write_json_file(path, &value)?;
    }
    Ok(())
}

fn write_meta(path: &Path, applied_profile_id: Option<&str>) -> Result<(), String> {
    let mut value = read_json_or_empty(path)?;
    let obj = value.as_object_mut().expect("always object");
    let mut entries = obj
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(PROFILE_ID));

    match applied_profile_id {
        Some(id) => {
            entries.push(json!({
                "id": PROFILE_ID,
                "name": PROFILE_NAME
            }));
            obj.insert("appliedId".to_string(), Value::String(id.to_string()));
        }
        None => {
            let should_clear_applied = obj
                .get("appliedId")
                .and_then(Value::as_str)
                .is_some_and(|id| id == PROFILE_ID);
            if should_clear_applied {
                if let Some(next_id) = entries
                    .iter()
                    .find_map(|entry| entry.get("id").and_then(Value::as_str))
                {
                    obj.insert("appliedId".to_string(), Value::String(next_id.to_string()));
                } else {
                    obj.remove("appliedId");
                }
            }
        }
    }

    obj.insert("entries".to_string(), Value::Array(entries));
    write_json_file(path, &value)
}

fn is_one_m_candidate(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.contains("[1m]") || lower.contains("-1m") || lower.ends_with("1m")
}

fn strip_one_m_marker_str(s: &str) -> String {
    let trimmed = s.trim();
    if let Some(stripped) = trimmed.strip_suffix("[1m]").or_else(|| trimmed.strip_suffix("[1M]")) {
        stripped.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_model_specs(bindings: &ClaudeDesktopBindings) -> Result<Vec<ModelSpec>, String> {
    let routes = read_routes()?;
    let mut specs = Vec::new();

    let resolve_one = |route_ref: &str, default_name: &str| -> Result<ModelSpec, String> {
        let clean = route_ref.trim();
        if clean.is_empty() {
            return Err(format!("Claude Desktop {default_name} 角色尚未绑定代理模型"));
        }
        let route = find_route_by_uid(&routes, clean)
            .or_else(|| routes.routes.iter().find(|r| r.id == clean))
            .ok_or_else(|| format!("绑定的代理模型不存在: {clean}"))?;
        if !route.enabled {
            return Err(format!("绑定的代理模型已禁用: {}", route.id));
        }
        if route.targets.is_empty() {
            return Err(format!("绑定的代理模型没有上游目标: {}", route.id));
        }
        let is_1m = is_one_m_candidate(&route.id)
            || is_one_m_candidate(&route.display_name)
            || route.targets.iter().any(|t| is_one_m_candidate(&t.model));
        let raw_label = if !route.display_name.is_empty() {
            &route.display_name
        } else {
            &route.id
        };
        let label = strip_one_m_marker_str(raw_label);
        Ok(ModelSpec {
            name: default_name.to_string(),
            label_override: Some(label),
            supports_1m: is_1m,
        })
    };

    specs.push(resolve_one(&bindings.sonnet, CLAUDE_SONNET_ROUTE)?);
    specs.push(resolve_one(&bindings.opus, CLAUDE_OPUS_ROUTE)?);
    specs.push(resolve_one(&bindings.haiku, CLAUDE_HAIKU_ROUTE)?);

    if !bindings.fable.trim().is_empty() {
        specs.push(resolve_one(&bindings.fable, CLAUDE_FABLE_ROUTE)?);
    }

    Ok(specs)
}

pub fn apply_claude_desktop_sync(
    bindings_opt: Option<ClaudeDesktopBindings>,
) -> Result<SwitchResult, String> {
    let paths = current_platform_paths()?;
    let mut routes = read_routes()?;

    let bindings = if let Some(b) = bindings_opt {
        routes.claude_desktop = Some(b.clone());
        super::proxy_routes::save_proxy_routes(routes)?;
        b
    } else {
        routes
            .claude_desktop
            .clone()
            .ok_or_else(|| "尚未配置 Claude Desktop 角色档位绑定，请在设置中选择模型".to_string())?
    };

    let model_specs = resolve_model_specs(&bindings)?;
    let base_url = gateway_base_url();
    let api_key = gateway_api_key()?;
    let profile = build_gateway_profile(&base_url, &api_key, &model_specs);

    with_rollback(&paths, |p| {
        write_deployment_mode(&p.normal_config_path, "3p")?;
        write_deployment_mode(&p.threep_config_path, "3p")?;
        write_json_file(&p.profile_path, &profile)?;
        write_meta(&p.meta_path, Some(PROFILE_ID))?;
        Ok(())
    })?;

    Ok(SwitchResult {
        ok: true,
        message: "Claude Desktop 已切换到本地路由模式，重启 Claude Desktop 后生效"
            .to_string(),
        config_path: paths.threep_config_path.to_string_lossy().to_string(),
        backup_path: paths.profile_path.to_string_lossy().to_string(),
    })
}

pub fn restore_claude_desktop_sync() -> Result<SwitchResult, String> {
    let paths = current_platform_paths()?;

    with_rollback(&paths, |p| {
        write_deployment_mode(&p.normal_config_path, "1p")?;
        write_deployment_mode(&p.threep_config_path, "1p")?;
        remove_enterprise_config(&p.threep_config_path)?;
        delete_file(&p.profile_path)?;
        write_meta(&p.meta_path, None)?;
        Ok(())
    })?;

    Ok(SwitchResult {
        ok: true,
        message: "已切回 Claude Desktop 官方默认配置，重启 Claude Desktop 后生效".to_string(),
        config_path: paths.threep_config_path.to_string_lossy().to_string(),
        backup_path: String::new(),
    })
}

pub fn get_status_sync() -> Result<ClaudeDesktopStatus, String> {
    if !is_supported_platform() {
        return Ok(ClaudeDesktopStatus {
            supported: false,
            installed: false,
            managed_by_any_bridge: false,
            deployment_mode: None,
            gateway_url: gateway_base_url(),
            has_gateway_key: gateway_api_key().is_ok(),
            normal_config_path: String::new(),
            threep_config_path: String::new(),
            profile_path: String::new(),
            meta_path: String::new(),
            applied_profile_id: None,
            current_provider_id: None,
            bindings: None,
            proxy_running: false,
        });
    }

    let paths = current_platform_paths()?;
    let installed = paths.normal_dir.exists() || paths.threep_dir.exists();
    let meta_val = read_json_or_empty(&paths.meta_path).unwrap_or_else(|_| json!({}));
    let applied_id = meta_val
        .get("appliedId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let managed_by_any_bridge = applied_id.as_deref() == Some(PROFILE_ID);

    let threep_cfg = read_json_or_empty(&paths.threep_config_path).unwrap_or_else(|_| json!({}));
    let deployment_mode = threep_cfg
        .get("deploymentMode")
        .and_then(Value::as_str)
        .map(str::to_string);

    let routes = read_routes().unwrap_or_default();
    let bindings = routes.claude_desktop;

    let store = super::config::read_provider_store().ok();
    let current_provider_id = store.as_ref().and_then(|s| {
        s.platforms
            .get("claude-desktop")
            .map(|p| p.provider_id.clone())
    });

    let port = configured_proxy_ports().api_port;
    let proxy_running = std::net::TcpListener::bind(("127.0.0.1", port)).is_err();

    Ok(ClaudeDesktopStatus {
        supported: true,
        installed,
        managed_by_any_bridge,
        deployment_mode,
        gateway_url: gateway_base_url(),
        has_gateway_key: gateway_api_key().is_ok(),
        normal_config_path: paths.normal_config_path.to_string_lossy().to_string(),
        threep_config_path: paths.threep_config_path.to_string_lossy().to_string(),
        profile_path: paths.profile_path.to_string_lossy().to_string(),
        meta_path: paths.meta_path.to_string_lossy().to_string(),
        applied_profile_id: applied_id,
        current_provider_id,
        bindings,
        proxy_running,
    })
}

// ═══════ TAURI COMMANDS ═══════

#[tauri::command]
pub fn get_claude_desktop_status() -> Result<ClaudeDesktopStatus, String> {
    get_status_sync()
}

#[tauri::command]
pub fn apply_claude_desktop(
    bindings: Option<ClaudeDesktopBindings>,
) -> Result<SwitchResult, String> {
    apply_claude_desktop_sync(bindings)
}

#[tauri::command]
pub fn restore_claude_desktop() -> Result<SwitchResult, String> {
    restore_claude_desktop_sync()
}

#[tauri::command]
pub fn preview_claude_desktop(
    bindings: Option<ClaudeDesktopBindings>,
) -> Result<String, String> {
    let routes = read_routes()?;
    let b = bindings.or(routes.claude_desktop).ok_or_else(|| {
        "尚未配置 Claude Desktop 角色档位绑定，请选择模型".to_string()
    })?;
    let model_specs = resolve_model_specs(&b)?;
    let base_url = gateway_base_url();
    let api_key = gateway_api_key().unwrap_or_else(|_| "abk-local-xxx".to_string());
    let profile = build_gateway_profile(&base_url, &api_key, &model_specs);
    serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-cd-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_build_gateway_profile() {
        let specs = vec![
            ModelSpec {
                name: CLAUDE_SONNET_ROUTE.to_string(),
                label_override: Some("Kimi K2.7".to_string()),
                supports_1m: true,
            },
            ModelSpec {
                name: CLAUDE_OPUS_ROUTE.to_string(),
                label_override: Some("GLM-5.1".to_string()),
                supports_1m: false,
            },
            ModelSpec {
                name: CLAUDE_HAIKU_ROUTE.to_string(),
                label_override: Some("DeepSeek V4".to_string()),
                supports_1m: false,
            },
        ];
        let p = build_gateway_profile("http://127.0.0.1:7450/claude-desktop", "abk-test", &specs);
        assert_eq!(p["inferenceProvider"], "gateway");
        assert_eq!(p["inferenceGatewayApiKey"], "abk-test");
        assert_eq!(p["inferenceModels"][0]["name"], "claude-sonnet-5");
        assert_eq!(p["inferenceModels"][0]["labelOverride"], "Kimi K2.7");
    }

    #[test]
    fn test_write_and_restore_meta() {
        let dir = temp_test_dir("meta");
        let meta_path = dir.join("_meta.json");

        write_meta(&meta_path, Some(PROFILE_ID)).unwrap();
        let val = read_json_or_empty(&meta_path).unwrap();
        assert_eq!(val["appliedId"], PROFILE_ID);
        assert_eq!(val["entries"][0]["id"], PROFILE_ID);

        write_meta(&meta_path, None).unwrap();
        let val2 = read_json_or_empty(&meta_path).unwrap();
        assert!(val2.get("appliedId").is_none());
        assert_eq!(val2["entries"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }
}
