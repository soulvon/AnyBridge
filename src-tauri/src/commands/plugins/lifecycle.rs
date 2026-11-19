use std::fs;
use tauri::{Emitter, State};
use crate::commands::extensions;
use crate::commands::plugin_asset::ReleaseAssetSpec;
use super::*;
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
    app: tauri::AppHandle,
    plugin_id: String,
    values: serde_json::Value,
) -> Result<(), String> {
    write_config(&plugin_id, &values)?;
    // 端口/密钥是供应商地址与凭证的唯一来源：配置一改就同步，
    // 否则卡片还指着旧端口，界面上只看得到「连不上」却查不出原因。
    match sync_provider_from_config(&plugin_id, &values) {
        Ok(true) => emit_providers_changed(&app),
        Ok(false) => {}
        Err(e) => eprintln!("[plugins] 插件配置变更同步供应商失败 {}: {}", plugin_id, e),
    }
    Ok(())
}

/// 把调用转给 sidecar 里的 adapter（内部用，不带 UI 拦截逻辑）。
pub(super) async fn adapter_call(
    plugin_id: &str,
    method: &str,
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
pub async fn plugin_adapter_call(
    app: tauri::AppHandle,
    state: State<'_, PluginState>,
    plugin_id: String,
    method: String,
    args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    // 版本切换要换掉可执行文件：和「更新」一样由 Rust 下载（镜像测速 + 系统代理），
    // 不落到 sidecar 里用 curl 直连 —— 那是本机代理/企业网环境下失败率最高的做法。
    if method == "switchVersion" {
        let manifest = plugin_get_manifest(plugin_id.clone()).await?;
        if let Some(spec) = ReleaseAssetSpec::from_deploy(&manifest.deploy)? {
            let version = args
                .get(1)
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "请输入目标版本号，例如 v1.8.0".to_string())?;
            let install_path = read_config(&plugin_id)
                .get("installPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if install_path.is_empty() {
                return Err("插件尚未安装，缺少 installPath".to_string());
            }

            // 运行中的进程占着 exe，Windows 上无法覆盖：先停、换完再按原状态拉起来
            let was_running = matches!(read_status(&plugin_id).state.as_str(), "running" | "starting");
            if was_running {
                let _ = plugin_stop(app.clone(), state.clone(), plugin_id.clone()).await;
            }
            let installed = match prepare_release_asset(
                &app,
                &plugin_id,
                "adapter",
                &spec,
                &install_path,
                Some(&version),
                true,
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    // 换版本失败：旧二进制还在，先把服务按原样拉回去，别让插件停在停止态
                    if was_running {
                        let _ = plugin_start(app.clone(), state.clone(), plugin_id.clone()).await;
                    }
                    return Err(e);
                }
            };
            if was_running {
                let _ = plugin_start(app.clone(), state, plugin_id.clone()).await;
            }
            return Ok(serde_json::json!({
                "version": installed,
                "message": if was_running {
                    format!("已切换到 {}，服务已按新版本启动", installed)
                } else {
                    format!("已切换到 {}，下次启动生效", installed)
                },
            }));
        }
    }

    adapter_call(&plugin_id, &method, args).await
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
        .unwrap_or(FALLBACK_PORT as u64) as u16;

    // Reject a start that would collide with an already-bound port. If our own plugin
    // process is still alive we surface that instead of a generic conflict message.
    if is_port_in_use(port) {
        let existing = read_status(&plugin_id);
        if let Some(pid) = existing.pid {
            if is_pid_alive(pid) {
                return Err(format!("插件已在运行中 (PID {}, 端口 {})", pid, port));
            }
        }

        // status.json 里没有 pid 或 pid 已死，但端口仍被占 —— 典型场景是
        // AnyBridge 上次异常退出没来得及杀子进程，或服务曾在 AnyBridge 之外被启动。
        // 这种「游离进程」如果不处理，UI 显示已停止、点启动永远撞端口，用户只能去
        // 任务管理器里找。占用者若是本插件自己安装目录下的服务进程，就接管：
        // 杀掉它再正常启动；是别的程序占端口则维持原有报错，绝不越界乱杀。
        if let Some(pid) = extensions::pid_listening_on_port(port) {
            if let Some(exe) = process_exe_path(pid) {
                let exe_norm = exe.to_ascii_lowercase().replace('\\', "/");
                let inst_norm = install_path.to_ascii_lowercase().replace('\\', "/");
                if exe_norm.starts_with(inst_norm.trim_end_matches('/')) {
                    kill_pid(pid);
                    for _ in 0..20 {
                        if !is_port_in_use(port) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
        }

        if is_port_in_use(port) {
            return Err(format!("端口 {} 已被其他程序占用，请在配置中更换端口", port));
        }
    }

    // Get start command from adapter
    let start_info = adapter_call(
        &plugin_id,
        "prepareStart",
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
    let stdout = open_plugin_log(&stdout_path)?;
    let stderr = open_plugin_log(&stderr_path)?;
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
        let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
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

    // 网关就绪后把模型目录写回供应商卡片：热插拔不该让用户手填模型。
    spawn_models_sync_when_ready(app.clone(), plugin_id.clone());
    // Drive starting → running (or error) in the background via health checks
    spawn_health_monitor(app, plugin_id, manifest, port, pid);

    Ok(())
}

/// Polls the plugin's health endpoint until it turns healthy (→ running) or gives up (→ error),
/// then keeps monitoring so a crash or hang is reflected in status.json.
pub(super) fn spawn_health_monitor(
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

pub(super) fn emit_status(app: &tauri::AppHandle, status: &PluginStatus) {
    let _ = app.emit("plugin-status-changed", status);
}

/// Single health probe, shared by the Tauri command and the background monitor.
pub(super) async fn do_health_check(plugin_id: &str, manifest: &PluginManifest, port: u16) -> serde_json::Value {
    let check_type = manifest
        .health_check
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("http");

    // custom → delegate to adapter.healthCheck()
    if check_type == "custom" {
        let config = read_config(plugin_id);
        return match adapter_call(
            plugin_id,
            "healthCheck",
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
        adapter_call(
            &plugin_id,
            "prepareStop",
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
        let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
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
    let port = read_config(&plugin_id).get("port").and_then(|v| v.as_u64()).unwrap_or(FALLBACK_PORT as u64) as u16;
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
        .unwrap_or(FALLBACK_PORT as u64) as u16;

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

