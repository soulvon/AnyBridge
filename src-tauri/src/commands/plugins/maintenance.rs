use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;
use crate::commands::extensions;
use crate::commands::plugin_asset::ReleaseAssetSpec;
use super::*;
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
    let port = config
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(FALLBACK_PORT as u64) as u16;

    // status.json 里的 pid 可能缺失或过期（例如服务是在 AnyBridge 之外被启动的），
    // plugin_stop 杀不到它。按监听端口把进程找出来杀掉 —— 否则 Windows 上被锁住的
    // exe 会让目录删不掉，卸载变成"假成功"，卡片以「已停止」复活。
    if let Some(pid) = extensions::pid_listening_on_port(port) {
        kill_pid(pid);
    }
    for _ in 0..20 {
        if !is_port_in_use(port) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // 删除目录：进程刚死时句柄释放有延迟，给一个有限的等待窗口；
    // 窗口内仍删不掉就如实报错 —— 绝不返回"已成功卸载"却留下一地残骸。
    let remove_dir_with_retry = |dir: &Path| -> Result<(), String> {
        let mut last_err = String::new();
        for attempt in 0..10u32 {
            match fs::remove_dir_all(dir) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < 9 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }
        }
        Err(format!(
            "无法删除 {}：{}。请确认插件服务已停止（可能被其它程序占用）后重试。",
            dir.display(),
            last_err
        ))
    };

    if !install_path.is_empty() {
        let _ = adapter_call(
            &plugin_id,
            "prepareUninstall",
            vec![serde_json::json!(install_path), config.clone()],
        )
        .await;

        // Delete install directory
        remove_dir_with_retry(Path::new(install_path))?;
    }

    // Delete data directory
    let data_dir = plugin_data_dir(&plugin_id);
    remove_dir_with_retry(&data_dir)?;

    // 一并撤掉部署时自动登记的供应商，避免留下一条指向已删服务的死条目
    match remove_plugin_provider(&plugin_id) {
        Ok(true) => emit_providers_changed(&app),
        Ok(false) => {}
        Err(e) => eprintln!("[plugins] 移除插件供应商失败 {}: {}", plugin_id, e),
    }

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

#[tauri::command]
pub async fn plugin_check_update(plugin_id: String) -> Result<serde_json::Value, String> {
    let config = read_config(&plugin_id);
    let install_path = config
        .get("installPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // 声明了发布包规格的插件由 Rust 直接对 GitHub 判版本：
    // 不再让 sidecar 用 curl 走一遍（curl 的 CA 包与本机代理常见证书冲突）。
    if !install_path.is_empty() {
        let manifest = plugin_get_manifest(plugin_id.clone()).await?;
        if let Some(spec) = ReleaseAssetSpec::from_deploy(&manifest.deploy)? {
            let latest = extensions::latest_release_tag(&spec.repo)
                .await
                .map_err(|e| format!("检查更新失败：{}", e))?;
            let current = spec.installed_version(Path::new(install_path));
            return Ok(match current {
                None => serde_json::json!({
                    "hasUpdate": true,
                    "currentVersion": "",
                    "latestVersion": latest,
                    "message": format!("本地未记录版本，建议更新到 {}", latest),
                }),
                Some(v) if v == latest => serde_json::json!({
                    "hasUpdate": false,
                    "currentVersion": v,
                    "latestVersion": latest,
                    "message": format!("已是最新版本（{}）", latest),
                }),
                Some(v) => serde_json::json!({
                    "hasUpdate": true,
                    "currentVersion": v,
                    "latestVersion": latest,
                    "message": format!("发现新版本（{} → {}）", v, latest),
                }),
            });
        }
    }

    let body = serde_json::json!({
        "pluginId": plugin_id,
        "installPath": install_path,
    });
    let response = sidecar_post_with_timeout(
        "/internal/plugins/check-update",
        &body,
        std::time::Duration::from_secs(15),
    )
    .await?;
    Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn plugin_upgrade(
    app: tauri::AppHandle,
    state: State<'_, PluginState>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let config = read_config(&plugin_id);
    let install_path = config
        .get("installPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if install_path.is_empty() {
        return Err("插件未安装或未记录安装路径".to_string());
    }

    // 1. 如果正在运行，优雅停止
    let status_before = read_status(&plugin_id);
    let was_running = status_before.state == "running" || status_before.state == "starting";
    if was_running {
        let _ = plugin_stop(app.clone(), state.clone(), plugin_id.clone()).await;
    }

    // 2. 先换二进制：Rust 走镜像测速下载，与 CPA 安装部署同一条链路
    let manifest = plugin_get_manifest(plugin_id.clone()).await?;
    if let Some(spec) = ReleaseAssetSpec::from_deploy(&manifest.deploy)? {
        if let Err(e) =
            prepare_release_asset(&app, &plugin_id, "adapter", &spec, install_path, None, true).await
        {
            // 二进制没换成功：旧版本还在磁盘上，把服务拉回去，别让用户以为插件坏了
            if was_running {
                let _ = plugin_start(app.clone(), state.clone(), plugin_id.clone()).await;
            }
            return Err(format!("更新失败：{}", e));
        }
    }

    // 3. 调用 sidecar 收尾（adapter 自己声明的更新动作）
    let body = serde_json::json!({
        "pluginId": plugin_id,
        "installPath": install_path,
        "configValues": config,
    });
    let response = sidecar_post_with_timeout(
        "/internal/plugins/upgrade",
        &body,
        std::time::Duration::from_secs(300),
    )
    .await?;
    let ok = response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let err_msg = response
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("更新失败");
        return Err(err_msg.to_string());
    }

    // 3. 更新状态并发送通知
    let mut status = read_status(&plugin_id);
    status.updated_at = now_iso();
    write_status(&status)?;
    emit_status(&app, &status);

    // 4. 若此前处于运行中，重新启动
    if was_running {
        let _ = plugin_start(app.clone(), state, plugin_id).await;
    }

    Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
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
    let result = adapter_call(
        &plugin_id,
        "generateConfig",
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

// ═══════════════════════════════════════════════════════════════════
// 插件 ↔ 供应商 热插拔：模型同步与启动对账
// ═══════════════════════════════════════════════════════════════════

/// 从网关的 /v1/models 拉目录写回供应商卡片。复用 config::fetch_models，
/// 不另写一条下载/鉴权链路。失败明确返回，由调用方决定是否重排。
pub async fn sync_plugin_provider_models(
    app: &tauri::AppHandle,
    plugin_id: &str,
) -> Result<usize, String> {
    use crate::commands::config::{self, FetchModelsArgs};

    let config = read_config(plugin_id);
    let api_key = config
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err(format!("插件 {} 没有 API 密钥，无法拉取模型", plugin_id));
    }
    let port = config
        .get("port")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("插件 {} 配置缺少 port，无法拉取模型", plugin_id))? as u16;

    let fetched = config::fetch_models(FetchModelsArgs {
        host: format!("http://127.0.0.1:{}", port),
        api_key,
        path: Some("/v1".into()),
        api_format: Some("openai".into()),
    })
    .await?;
    if fetched.models.is_empty() {
        return Err(format!("插件 {} 的网关返回了空模型目录", plugin_id));
    }

    let id = plugin_provider_id(plugin_id);
    let models = fetched.models;
    crate::commands::store_io::update_provider_store(|store| {
        let provider = store
            .providers
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("供应商 {} 尚未登记，无法写入模型", id))?;
        provider.models = models.clone();
        if provider.default_model.trim().is_empty() {
            provider.default_model = models[0].clone();
        }
        Ok((true, ()))
    })?;
    emit_providers_changed(app);
    Ok(models.len())
}

/// 网关进程起来到 /v1/models 可用之间有预热窗口（WAA Worker 等）。
/// 这里只等待就绪，最多 60 秒；超时明确报错，不伪造成功、不静默吞掉。
pub(super) fn spawn_models_sync_when_ready(app: tauri::AppHandle, plugin_id: String) {
    tauri::async_runtime::spawn(async move {
        for attempt in 0..12u32 {
            match sync_plugin_provider_models(&app, &plugin_id).await {
                Ok(n) => {
                    eprintln!("[plugins] {} 供应商模型已同步 {} 个", plugin_id, n);
                    return;
                }
                Err(e) => {
                    if attempt == 11 {
                        eprintln!(
                            "[plugins] {} 供应商模型同步失败（已等待 60s）: {}",
                            plugin_id, e
                        );
                        return;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

