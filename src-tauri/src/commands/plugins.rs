use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, State};
use futures_util::StreamExt;

use crate::commands::config::configured_proxy_ports;

// ═══════════════════════════════════════════════════
// Data types
// ═══════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(rename = "apiVersion")]
    pub api_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub runtime: serde_json::Value,
    pub health_check: serde_json::Value,
    pub config_schema: Vec<serde_json::Value>,
    pub capabilities: Vec<String>,
    pub panels: Vec<serde_json::Value>,
    pub deploy: serde_json::Value,
    #[serde(default)]
    pub upgrade: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub plugin_id: String,
    pub state: String,
    pub install_path: Option<String>,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub started_at: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub status: PluginStatus,
}

// ═══════════════════════════════════════════════════
// Plugin manager state
// ═══════════════════════════════════════════════════

/// A running plugin child process. The `Child` handle is kept so the process can be
/// killed and reaped properly; `pid` is mirrored into status.json for cross-restart recovery.
pub struct PluginProcess {
    pub pid: u32,
    pub child: std::process::Child,
}

pub struct PluginState {
    pub processes: std::sync::Mutex<HashMap<String, PluginProcess>>,
}

impl PluginState {
    pub fn new() -> Self {
        Self {
            processes: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl Default for PluginState {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════
// Path helpers
// ═══════════════════════════════════════════════════

fn plugins_dir() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("AnyBridge");
    p.push("plugins");
    p
}

fn plugin_data_dir(plugin_id: &str) -> PathBuf {
    plugins_dir().join(plugin_id)
}

fn plugin_status_path(plugin_id: &str) -> PathBuf {
    plugin_data_dir(plugin_id).join("status.json")
}

fn plugin_config_path(plugin_id: &str) -> PathBuf {
    plugin_data_dir(plugin_id).join("config.json")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn read_status(plugin_id: &str) -> PluginStatus {
    let path = plugin_status_path(plugin_id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(status) = serde_json::from_str::<PluginStatus>(&content) {
            return status;
        }
    }
    PluginStatus {
        plugin_id: plugin_id.to_string(),
        state: "unknown".to_string(),
        install_path: None,
        pid: None,
        port: None,
        started_at: None,
        version: None,
        error: None,
        updated_at: now_iso(),
    }
}

fn write_status(status: &PluginStatus) -> Result<(), String> {
    let dir = plugin_data_dir(&status.plugin_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件数据目录失败: {}", e))?;
    let path = plugin_status_path(&status.plugin_id);
    let json = serde_json::to_string_pretty(status).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())
}

fn read_config(plugin_id: &str) -> serde_json::Value {
    let path = plugin_config_path(plugin_id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
            return config;
        }
    }
    serde_json::json!({})
}

fn write_config(plugin_id: &str, config: &serde_json::Value) -> Result<(), String> {
    let dir = plugin_data_dir(plugin_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件数据目录失败: {}", e))?;
    let path = plugin_config_path(plugin_id);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&path, json.as_bytes())
}

// ═══════════════════════════════════════════════════
// Process / port helpers
// ═══════════════════════════════════════════════════

/// Returns true if the TCP port on localhost is already bound by another process.
fn is_port_in_use(port: u16) -> bool {
    // Check both loopback and wildcard bindings — a process on 0.0.0.0 would conflict too
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
        || std::net::TcpListener::bind(("0.0.0.0", port)).is_err()
}

/// Returns true if a process with the given PID is currently alive.
#[cfg(target_os = "windows")]
fn is_pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // tasklist prints "信息: 没有运行的任务..." when no match; a real row contains the PID
            stdout.contains(&format!("\"{}\"", pid))
        }
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn is_pid_alive(pid: u32) -> bool {
    // signal 0 performs error checking without actually sending a signal
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Terminate a process tree by PID.
fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // /T kills the whole tree, /F forces termination when the graceful attempt is ignored
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

// ═══════════════════════════════════════════════════
// Sidecar HTTP helpers
// ═══════════════════════════════════════════════════

fn sidecar_url() -> String {
    let port = configured_proxy_ports().api_port;
    format!("http://127.0.0.1:{}", port)
}

async fn sidecar_get(path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", sidecar_url(), path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Sidecar returned {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

async fn sidecar_post(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    sidecar_post_with_timeout(path, body, std::time::Duration::from_secs(30)).await
}

async fn sidecar_post_with_timeout(path: &str, body: &serde_json::Value, timeout: std::time::Duration) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", sidecar_url(), path);
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Sidecar returned {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════════
// Tauri commands
// ═══════════════════════════════════════════════════

#[tauri::command]
pub async fn plugin_list() -> Result<Vec<PluginInfo>, String> {
    let response = sidecar_get("/internal/plugins/list").await?;
    let manifests: Vec<PluginManifest> = response
        .get("plugins")
        .and_then(|p| serde_json::from_value(p.clone()).ok())
        .unwrap_or_default();

    let mut result = Vec::new();
    for manifest in manifests {
        let status = read_status(&manifest.id);
        result.push(PluginInfo { manifest, status });
    }
    Ok(result)
}

#[tauri::command]
pub async fn plugin_get_manifest(plugin_id: String) -> Result<PluginManifest, String> {
    let body = serde_json::json!({ "pluginId": plugin_id });
    let response = sidecar_post("/internal/plugins/load", &body).await?;
    response
        .get("manifest")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .ok_or_else(|| "Invalid manifest response".to_string())
}

#[tauri::command]
pub async fn plugin_get_status(plugin_id: String) -> Result<PluginStatus, String> {
    Ok(read_status(&plugin_id))
}

#[tauri::command]
pub async fn plugin_get_config(plugin_id: String) -> Result<serde_json::Value, String> {
    Ok(read_config(&plugin_id))
}

#[tauri::command]
pub async fn plugin_set_config(
    plugin_id: String,
    values: serde_json::Value,
) -> Result<(), String> {
    write_config(&plugin_id, &values)?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_adapter_call(
    plugin_id: String,
    method: String,
    args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "pluginId": plugin_id,
        "method": method,
        "args": args
    });
    let response = sidecar_post("/internal/plugins/call", &body).await?;
    if let Some(ok) = response.get("ok").and_then(|v| v.as_bool()) {
        if ok {
            return Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null));
        }
        return Err(response.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown error").to_string());
    }
    Err("Invalid sidecar response".to_string())
}

#[tauri::command]
pub async fn plugin_check_environment(
    plugin_id: String,
    strategy: Option<String>,
) -> Result<serde_json::Value, String> {
    let strat = strategy.unwrap_or_else(|| "source".to_string());
    let body = serde_json::json!({ "pluginId": plugin_id, "strategy": strat });
    // Pass the strategy through so the adapter can report strategy-specific dependencies
    let response = sidecar_post_with_timeout(
        "/internal/plugins/check-environment",
        &body,
        std::time::Duration::from_secs(60),
    )
    .await?;
    Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

fn emit_deploy_progress(
    app: &tauri::AppHandle,
    plugin_id: &str,
    strategy: &str,
    step: &str,
    status: &str,
    message: &str,
    details: Option<serde_json::Value>,
) {
    let _ = app.emit(
        "plugin-deploy-progress",
        serde_json::json!({
            "pluginId": plugin_id,
            "strategy": strategy,
            "step": step,
            "status": status,
            "message": message,
            "details": details,
        }),
    );
}

/// Run one deployment strategy end to end. Returns the sidecar's result object on success.
async fn deploy_with_strategy(
    app: &tauri::AppHandle,
    plugin_id: &str,
    strategy: &str,
    install_path: &str,
    existing_config: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Environment check for this specific strategy
    emit_deploy_progress(
        app,
        plugin_id,
        strategy,
        "check-environment",
        "running",
        &format!("检测环境（{} 策略）...", strategy),
        None,
    );

    let env_result =
        plugin_check_environment(plugin_id.to_string(), Some(strategy.to_string())).await?;
    let ready = env_result.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ready {
        let missing = env_result.get("missing").cloned().unwrap_or(serde_json::Value::Null);
        let names: Vec<String> = missing
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let msg = format!("环境依赖缺失: {}", names.join(", "));
        emit_deploy_progress(
            app,
            plugin_id,
            strategy,
            "check-environment",
            "error",
            &msg,
            Some(missing),
        );
        return Err(msg);
    }

    emit_deploy_progress(
        app,
        plugin_id,
        strategy,
        "check-environment",
        "done",
        "环境检测通过",
        None,
    );

    // 2. Run the step executor in the sidecar
    emit_deploy_progress(
        app,
        plugin_id,
        strategy,
        "deploy",
        "running",
        &format!("执行部署步骤（{}）...", strategy),
        None,
    );

    let mut config_values = serde_json::Map::new();
    if let Some(obj) = existing_config.as_object() {
        for (k, v) in obj {
            if !k.starts_with('_') {
                config_values.insert(k.clone(), v.clone());
            }
        }
    }
    config_values
        .entry("port".to_string())
        .or_insert(serde_json::json!(8000));

    let deploy_body = serde_json::json!({
        "pluginId": plugin_id,
        "strategy": strategy,
        "installPath": install_path,
        "configValues": serde_json::Value::Object(config_values),
    });

    // Stream NDJSON from the sidecar: each line is either a progress event or the final result.
    // We read the HTTP response body chunk-by-chunk and split on newlines so progress events
    // are emitted to the UI in real-time, not buffered until the entire deploy finishes.
    let url = format!("{}{}", sidecar_url(), "/internal/plugins/deploy");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("content-type", "application/json")
        .body(deploy_body.to_string())
        .send()
        .await
        .map_err(|e| format!("Sidecar deploy request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Sidecar deploy returned {}: {}", status, text));
    }

    // Read the NDJSON stream chunk-by-chunk, splitting on newlines
    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    let mut final_result: Option<serde_json::Value> = None;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Reading deploy stream failed: {}", e))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete lines (terminated by \n)
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let evt_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match evt_type {
                "progress" => {
                    let _ = app.emit(
                        "plugin-deploy-progress",
                        serde_json::json!({
                            "pluginId": plugin_id,
                            "strategy": strategy,
                            "step": parsed.get("step").unwrap_or(&serde_json::Value::Null),
                            "title": parsed.get("title").unwrap_or(&serde_json::Value::Null),
                            "status": parsed.get("status").unwrap_or(&serde_json::Value::Null),
                            "message": parsed.get("message").unwrap_or(&serde_json::Value::Null),
                        }),
                    );
                }
                "result" => {
                    final_result = Some(parsed);
                }
                _ => {}
            }
        }
    }

    // Process any remaining data in the buffer (last line without trailing \n)
    let remaining = buf.trim();
    if !remaining.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(remaining) {
            let evt_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if evt_type == "result" {
                final_result = Some(parsed);
            }
        }
    }

    let deploy_result = final_result.ok_or("Deploy stream ended without result")?;
    let result_obj = deploy_result.get("result").cloned().unwrap_or(serde_json::Value::Null);

    let success = deploy_result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        let error_msg = deploy_result
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| {
                result_obj
                    .get("results")
                    .and_then(|r| r.as_array())
                    .and_then(|arr| {
                        arr.iter().find_map(|item| {
                            if item.get("status").and_then(|s| s.as_str()) == Some("failed") {
                                let title =
                                    item.get("title").and_then(|t| t.as_str()).unwrap_or("未知步骤");
                                let detail = item
                                    .get("stderr")
                                    .and_then(|s| s.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                    .or_else(|| item.get("message").and_then(|m| m.as_str()))
                                    .unwrap_or("命令执行失败");
                                Some(format!("步骤「{}」失败: {}", title, detail.trim()))
                            } else {
                                None
                            }
                        })
                    })
            })
            .unwrap_or_else(|| "部署失败（未知原因）".to_string());

        emit_deploy_progress(app, plugin_id, strategy, "deploy", "error", &error_msg, None);
        return Err(error_msg);
    }

    Ok(result_obj)
}

#[tauri::command]
pub async fn plugin_deploy(
    app: tauri::AppHandle,
    plugin_id: String,
    strategy: Option<String>,
    install_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let manifest = plugin_get_manifest(plugin_id.clone()).await?;
    let existing_config = read_config(&plugin_id);

    // Candidate strategies: an explicit request pins one, otherwise walk the manifest
    // list in order and fall through to the next when one fails (design doc §8.2/8.3).
    let candidates: Vec<String> = match strategy {
        Some(s) => vec![s],
        None => {
            let declared: Vec<String> = manifest
                .deploy
                .get("strategies")
                .and_then(|s| serde_json::from_value(s.clone()).ok())
                .unwrap_or_default();
            if declared.is_empty() {
                vec!["source".to_string()]
            } else {
                declared
            }
        }
    };

    // Determine install path
    let install_path = install_path
        .or_else(|| {
            existing_config
                .get("installPath")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| {
            let mut p = plugin_data_dir(&plugin_id);
            p.push("install");
            p.to_string_lossy().to_string()
        });

    // Port conflict check before doing any expensive work
    let port = existing_config
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(8000) as u16;
    if is_port_in_use(port) {
        let msg = format!("端口 {} 已被占用，请先在配置中更换端口再安装", port);
        emit_deploy_progress(&app, &plugin_id, "", "port-check", "error", &msg, None);
        return Err(msg);
    }

    // Mark as deploying
    let mut status = read_status(&plugin_id);
    status.state = "deploying".to_string();
    status.install_path = Some(install_path.clone());
    status.error = None;
    status.updated_at = now_iso();
    write_status(&status)?;
    emit_status(&app, &status);

    let total = candidates.len();
    let mut last_error = String::new();

    for (idx, strat) in candidates.iter().enumerate() {
        match deploy_with_strategy(&app, &plugin_id, strat, &install_path, &existing_config).await {
            Ok(result_obj) => {
                // Persist config values (secrets, install path, generated config file path)
                let config_values = result_obj
                    .get("configValues")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let config_path = result_obj
                    .get("configPath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let mut saved_config = existing_config.clone();
                if !saved_config.is_object() {
                    saved_config = serde_json::json!({});
                }
                if let Some(obj) = saved_config.as_object_mut() {
                    if let Some(cv) = config_values.as_object() {
                        for (k, v) in cv {
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                    obj.insert("installPath".to_string(), serde_json::json!(install_path));
                    obj.insert("deployStrategy".to_string(), serde_json::json!(strat));
                    if !config_path.is_empty() {
                        obj.insert("configPath".to_string(), serde_json::json!(config_path));
                    }
                }
                write_config(&plugin_id, &saved_config)?;

                emit_deploy_progress(
                    &app,
                    &plugin_id,
                    strat,
                    "deploy-done",
                    "done",
                    "部署完成",
                    None,
                );

                let mut status = read_status(&plugin_id);
                status.state = "installed".to_string();
                status.install_path = Some(install_path.clone());
                status.port = Some(port);
                status.version = Some(manifest.version.clone());
                status.error = None;
                status.updated_at = now_iso();
                write_status(&status)?;
                emit_status(&app, &status);

                return Ok(result_obj);
            }
            Err(e) => {
                last_error = e;
                if idx + 1 < total {
                    let next = &candidates[idx + 1];
                    emit_deploy_progress(
                        &app,
                        &plugin_id,
                        strat,
                        "fallback",
                        "running",
                        &format!("{} 策略失败，降级尝试 {} 策略...", strat, next),
                        None,
                    );
                }
            }
        }
    }

    let mut status = read_status(&plugin_id);
    status.state = "error".to_string();
    status.error = Some(last_error.clone());
    status.updated_at = now_iso();
    write_status(&status)?;
    emit_status(&app, &status);

    Err(last_error)
}

#[tauri::command]
pub async fn plugin_start(
    app: tauri::AppHandle,
    state: State<'_, PluginState>,
    plugin_id: String,
) -> Result<(), String> {
    let manifest = plugin_get_manifest(plugin_id.clone()).await?;
    let config = read_config(&plugin_id);

    // Resolve variables
    let install_path = config
        .get("installPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if install_path.is_empty() {
        return Err("插件尚未安装，缺少 installPath".to_string());
    }

    let port = config
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(8000) as u16;

    // Reject a start that would collide with an already-bound port. If our own plugin
    // process is still alive we surface that instead of a generic conflict message.
    if is_port_in_use(port) {
        let existing = read_status(&plugin_id);
        if let Some(pid) = existing.pid {
            if is_pid_alive(pid) {
                return Err(format!("插件已在运行中 (PID {}, 端口 {})", pid, port));
            }
        }
        return Err(format!("端口 {} 已被其他程序占用，请在配置中更换端口", port));
    }

    // Get start command from adapter
    let start_info = plugin_adapter_call(
        plugin_id.clone(),
        "prepareStart".to_string(),
        vec![serde_json::json!(install_path), config.clone()],
    )
    .await?;

    let command = start_info
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or("adapter prepareStart() did not return command")?;
    let args: Vec<String> = start_info
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let cwd = start_info
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(install_path);

    // Start the process
    let mut cmd = std::process::Command::new(command);
    cmd.args(&args);
    cmd.current_dir(cwd);

    // Env: manifest runtime.env first, then adapter-supplied overrides
    if let Some(env) = manifest.runtime.get("env").and_then(|e| e.as_object()) {
        for (k, v) in env {
            if let Some(val) = v.as_str() {
                cmd.env(k, val);
            }
        }
    }
    if let Some(env) = start_info.get("env").and_then(|e| e.as_object()) {
        for (k, v) in env {
            if let Some(val) = v.as_str() {
                cmd.env(k, val);
            }
        }
    }

    // Redirect stdout/stderr to log files
    let log_dir = plugin_data_dir(&plugin_id);
    fs::create_dir_all(&log_dir).map_err(|e| format!("创建插件日志目录失败: {}", e))?;
    let stdout_path = log_dir.join("stdout.log");
    let stderr_path = log_dir.join("stderr.log");
    let stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .map_err(|e| e.to_string())?;
    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|e| e.to_string())?;
    cmd.stdout(std::process::Stdio::from(stdout));
    cmd.stderr(std::process::Stdio::from(stderr));

    // On Windows, hide the console window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("启动插件进程失败: {}", e))?;
    let pid = child.id();

    // Keep the Child handle so the process can be killed and reaped later
    {
        let mut processes = state.processes.lock().unwrap();
        processes.insert(plugin_id.clone(), PluginProcess { pid, child });
    }

    // Update status → starting
    let mut status = read_status(&plugin_id);
    status.state = "starting".to_string();
    status.install_path = Some(install_path.to_string());
    status.pid = Some(pid);
    status.port = Some(port);
    status.started_at = Some(now_iso());
    status.error = None;
    status.updated_at = now_iso();
    write_status(&status)?;
    emit_status(&app, &status);

    // Drive starting → running (or error) in the background via health checks
    spawn_health_monitor(app, plugin_id, manifest, port, pid);

    Ok(())
}

/// Polls the plugin's health endpoint until it turns healthy (→ running) or gives up (→ error),
/// then keeps monitoring so a crash or hang is reflected in status.json.
fn spawn_health_monitor(
    app: tauri::AppHandle,
    plugin_id: String,
    manifest: PluginManifest,
    port: u16,
    pid: u32,
) {
    let hc = manifest.health_check.clone();
    let interval = hc.get("intervalSeconds").and_then(|v| v.as_u64()).unwrap_or(30).max(1);
    let healthy_threshold = hc.get("healthyThreshold").and_then(|v| v.as_u64()).unwrap_or(2).max(1);
    let unhealthy_threshold = hc.get("unhealthyThreshold").and_then(|v| v.as_u64()).unwrap_or(3).max(1);
    // Startup polls faster than the steady-state interval so the UI flips to "running" quickly
    let startup_deadline = std::time::Duration::from_secs(120);

    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut consecutive_ok = 0u64;
        let mut consecutive_fail = 0u64;
        let mut reached_running = false;

        loop {
            // Bail out if the plugin was stopped/uninstalled or another PID took over
            let current = read_status(&plugin_id);
            if current.pid != Some(pid) || current.state == "stopped" || current.state == "unknown" {
                return;
            }

            if !is_pid_alive(pid) {
                let mut s = read_status(&plugin_id);
                s.state = "error".to_string();
                s.error = Some("插件进程意外退出".to_string());
                s.pid = None;
                s.updated_at = now_iso();
                let _ = write_status(&s);
                emit_status(&app, &s);
                return;
            }

            let health = do_health_check(&plugin_id, &manifest, port).await;
            let ok = health.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

            if ok {
                consecutive_fail = 0;
                consecutive_ok += 1;
                if !reached_running && consecutive_ok >= healthy_threshold {
                    reached_running = true;
                    let mut s = read_status(&plugin_id);
                    s.state = "running".to_string();
                    s.error = None;
                    s.updated_at = now_iso();
                    let _ = write_status(&s);
                    emit_status(&app, &s);
                }
            } else {
                consecutive_ok = 0;
                consecutive_fail += 1;
                // Before reaching running we only fail after the startup window elapses —
                // a compile-heavy service can take a while to bind its port.
                let give_up = if reached_running {
                    consecutive_fail >= unhealthy_threshold
                } else {
                    started.elapsed() > startup_deadline
                };
                if give_up {
                    let mut s = read_status(&plugin_id);
                    s.state = "error".to_string();
                    s.error = Some(
                        health
                            .get("detail")
                            .and_then(|v| v.as_str())
                            .unwrap_or("健康检查失败")
                            .to_string(),
                    );
                    s.updated_at = now_iso();
                    let _ = write_status(&s);
                    emit_status(&app, &s);
                    return;
                }
            }

            let sleep_secs = if reached_running { interval } else { 2 };
            tokio::time::sleep(std::time::Duration::from_secs(sleep_secs)).await;
        }
    });
}

fn emit_status(app: &tauri::AppHandle, status: &PluginStatus) {
    let _ = app.emit("plugin-status-changed", status);
}

/// Single health probe, shared by the Tauri command and the background monitor.
async fn do_health_check(plugin_id: &str, manifest: &PluginManifest, port: u16) -> serde_json::Value {
    let check_type = manifest
        .health_check
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("http");

    // custom → delegate to adapter.healthCheck()
    if check_type == "custom" {
        let config = read_config(plugin_id);
        return match plugin_adapter_call(
            plugin_id.to_string(),
            "healthCheck".to_string(),
            vec![serde_json::json!(port), config],
        )
        .await
        {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "ok": false, "detail": e }),
        };
    }

    // tcp / process → no HTTP endpoint to probe
    if check_type == "tcp" || check_type == "process" {
        let alive = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(3),
        )
        .is_ok();
        return serde_json::json!({ "ok": alive });
    }

    let health_url = manifest
        .health_check
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("http://127.0.0.1:{port}/healthz")
        .replace("{port}", &port.to_string())
        .replace("{config.port}", &port.to_string());

    let timeout_secs = manifest
        .health_check
        .get("timeoutSeconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(3);
    let expect_status = manifest
        .health_check
        .get("expectStatus")
        .and_then(|v| v.as_u64())
        .unwrap_or(200) as u16;

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
    {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "detail": e.to_string() }),
    };

    let start = std::time::Instant::now();
    match client.get(&health_url).send().await {
        Ok(res) => {
            let latency = start.elapsed().as_millis();
            let code = res.status().as_u16();
            serde_json::json!({
                "ok": code == expect_status,
                "latency": latency,
                "status": code,
                "checkedAt": now_iso()
            })
        }
        Err(e) => serde_json::json!({ "ok": false, "detail": e.to_string(), "checkedAt": now_iso() }),
    }
}

#[tauri::command]
pub async fn plugin_stop(
    app: tauri::AppHandle,
    state: State<'_, PluginState>,
    plugin_id: String,
) -> Result<(), String> {
    // 1. Try adapter prepareStop (e.g. Docker needs `docker compose down` not PID kill)
    let config = read_config(&plugin_id);
    let install_path = config.get("installPath").and_then(|v| v.as_str()).unwrap_or("");
    let stop_info = if !install_path.is_empty() {
        plugin_adapter_call(
            plugin_id.clone(),
            "prepareStop".to_string(),
            vec![serde_json::json!(install_path), config.clone()],
        )
        .await
        .ok()
        .filter(|v| !v.is_null())
    } else {
        None
    };

    if let Some(stop) = stop_info {
        // Adapter returned a stop command — execute it
        if let Some(command) = stop.get("command").and_then(|v| v.as_str()) {
            let args: Vec<String> = stop
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let cwd = stop.get("cwd").and_then(|v| v.as_str());
            let mut cmd = std::process::Command::new(command);
            cmd.args(&args);
            if let Some(cwd) = cwd {
                cmd.current_dir(cwd);
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = cmd.output(); // wait for it to finish
        }
    }

    // 2. Also kill the tracked child process / PID (covers source strategy and cleanup)
    let tracked = {
        let mut processes = state.processes.lock().unwrap();
        processes.remove(&plugin_id)
    };

    let pid = match tracked {
        Some(mut p) => {
            // On Windows, kill_pid (taskkill /T /F) already terminates the whole tree.
            // On Unix, send SIGTERM first for graceful shutdown, then SIGKILL as fallback.
            kill_pid(p.pid);
            #[cfg(not(target_os = "windows"))]
            {
                let _ = p.child.kill();
            }
            let _ = p.child.wait(); // reap to avoid zombie on unix
            Some(p.pid)
        }
        None => {
            let recorded = read_status(&plugin_id).pid;
            if let Some(pid) = recorded {
                if is_pid_alive(pid) {
                    kill_pid(pid);
                }
            }
            recorded
        }
    };
    let _ = pid;

    // Update status
    let mut status = read_status(&plugin_id);
    status.state = "stopped".to_string();
    status.pid = None;
    status.error = None;
    status.updated_at = now_iso();
    write_status(&status)?;
    emit_status(&app, &status);

    Ok(())
}

#[tauri::command]
pub async fn plugin_restart(
    app: tauri::AppHandle,
    state: State<'_, PluginState>,
    plugin_id: String,
) -> Result<(), String> {
    plugin_stop(app.clone(), state.clone(), plugin_id.clone()).await?;

    // Poll for port release instead of a fixed 1s sleep — TCP TIME_WAIT can take longer
    let port = read_config(&plugin_id).get("port").and_then(|v| v.as_u64()).unwrap_or(8000) as u16;
    for _ in 0..30 {
        if !is_port_in_use(port) { break; }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    plugin_start(app, state, plugin_id).await
}

#[tauri::command]
pub async fn plugin_health_check(plugin_id: String) -> Result<serde_json::Value, String> {
    let config = read_config(&plugin_id);
    let port = config
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(8000) as u16;

    let manifest = plugin_get_manifest(plugin_id.clone()).await?;
    Ok(do_health_check(&plugin_id, &manifest, port).await)
}

/// Reconcile persisted plugin state with reality at AnyBridge startup (design doc §15.4).
/// running → PID alive? keep : mark stopped. deploying → error (interrupted). stopping → force stop.
#[tauri::command]
pub async fn plugin_restore_state(app: tauri::AppHandle) -> Result<Vec<PluginStatus>, String> {
    let dir = plugins_dir();
    let mut restored = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(restored), // no plugin data yet
    };

    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let plugin_id = entry.file_name().to_string_lossy().to_string();
        let mut status = read_status(&plugin_id);
        let mut changed = false;

        match status.state.as_str() {
            "running" | "starting" => match status.pid {
                Some(pid) if is_pid_alive(pid) => { /* survived, keep as-is */ }
                _ => {
                    status.state = "stopped".to_string();
                    status.pid = None;
                    changed = true;
                }
            },
            "deploying" => {
                status.state = "error".to_string();
                status.error = Some("部署被中断（AnyBridge 已重启）".to_string());
                changed = true;
            }
            "stopping" => {
                if let Some(pid) = status.pid {
                    if is_pid_alive(pid) {
                        kill_pid(pid);
                    }
                }
                status.state = "stopped".to_string();
                status.pid = None;
                changed = true;
            }
            _ => {}
        }

        if changed {
            status.updated_at = now_iso();
            let _ = write_status(&status);
            emit_status(&app, &status);
        }
        restored.push(status);
    }

    Ok(restored)
}

#[tauri::command]
pub async fn plugin_uninstall(
    app: tauri::AppHandle,
    state: State<'_, PluginState>,
    plugin_id: String,
) -> Result<(), String> {
    // Stop if running — best-effort, don't let a dead PID block uninstall
    let _ = plugin_stop(app.clone(), state, plugin_id.clone()).await;

    // Call adapter prepareUninstall
    let config = read_config(&plugin_id);
    let install_path = config
        .get("installPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !install_path.is_empty() {
        let _ = plugin_adapter_call(
            plugin_id.clone(),
            "prepareUninstall".to_string(),
            vec![serde_json::json!(install_path), config.clone()],
        )
        .await;

        // Delete install directory
        let _ = fs::remove_dir_all(install_path);
    }

    // Delete data directory
    let data_dir = plugin_data_dir(&plugin_id);
    let _ = fs::remove_dir_all(&data_dir);

    let status = PluginStatus {
        plugin_id: plugin_id.clone(),
        state: "unknown".to_string(),
        install_path: None,
        pid: None,
        port: None,
        started_at: None,
        version: None,
        error: None,
        updated_at: now_iso(),
    };
    emit_status(&app, &status);

    Ok(())
}

/// Read the tail of a plugin's captured stdout/stderr. Used by the built-in logs panel
/// when the adapter's getLogs() returns null (i.e. the plugin has no log API of its own).
#[tauri::command]
pub async fn plugin_read_logs(plugin_id: String, lines: Option<usize>) -> Result<serde_json::Value, String> {
    let limit = lines.unwrap_or(300).clamp(1, 5000);
    let dir = plugin_data_dir(&plugin_id);

    let tail = |path: PathBuf| -> Vec<String> {
        match fs::read_to_string(&path) {
            Ok(content) => {
                let all: Vec<&str> = content.lines().collect();
                let start = all.len().saturating_sub(limit);
                all[start..].iter().map(|s| s.to_string()).collect()
            }
            Err(_) => Vec::new(),
        }
    };

    Ok(serde_json::json!({
        "stdout": tail(dir.join("stdout.log")),
        "stderr": tail(dir.join("stderr.log")),
    }))
}

#[tauri::command]
pub async fn plugin_generate_config(
    plugin_id: String,
    install_path: String,
) -> Result<String, String> {
    let config = read_config(&plugin_id);
    let result = plugin_adapter_call(
        plugin_id.clone(),
        "generateConfig".to_string(),
        vec![config.clone(), serde_json::json!(install_path)],
    )
    .await?;

    let config_path = result
        .get("configPath")
        .and_then(|v| v.as_str())
        .ok_or("adapter generateConfig() did not return configPath")?;

    // Store installPath in config
    let mut updated_config = config;
    if let Some(obj) = updated_config.as_object_mut() {
        obj.insert("installPath".to_string(), serde_json::json!(install_path));
    }
    write_config(&plugin_id, &updated_config)?;

    Ok(config_path.to_string())
}
