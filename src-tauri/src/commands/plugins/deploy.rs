use futures_util::StreamExt;
use std::path::Path;
use tauri::Emitter;
use crate::commands::plugin_asset::{self, ReleaseAssetSpec};
use super::*;
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

pub(super) fn emit_deploy_progress(
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

/// 取插件发布包（预编译二进制）：Rust 侧统一走镜像测速下载，进度投递到部署界面。
/// 与 CPA 安装部署同一条链路，插件 adapter 因此不必自己实现下载。
pub(super) async fn prepare_release_asset(
    app: &tauri::AppHandle,
    plugin_id: &str,
    strategy: &str,
    spec: &ReleaseAssetSpec,
    install_path: &str,
    version: Option<&str>,
    force: bool,
) -> Result<String, String> {
    let target = version.unwrap_or("最新版本");
    emit_deploy_progress(
        app,
        plugin_id,
        strategy,
        "download",
        "running",
        // 资产名可能含 {tag}，要在版本解析之后才能展开；这里只报目标版本，
        // 真实文件名由 plugin_asset::install 的进度事件给出。
        &format!("获取发布包（{}）...", target),
        None,
    );

    let progress = |msg: &str, pct: u8| {
        emit_deploy_progress(
            app,
            plugin_id,
            strategy,
            "download",
            "running",
            msg,
            Some(serde_json::json!({ "percent": pct })),
        );
    };

    match plugin_asset::install(plugin_id, spec, Path::new(install_path), version, force, &progress)
        .await
    {
        Ok(installed) => {
            emit_deploy_progress(
                app,
                plugin_id,
                strategy,
                "download",
                "done",
                &format!("发布包已就绪（{}）", installed),
                Some(serde_json::json!({ "percent": 85 })),
            );
            Ok(installed)
        }
        Err(e) => {
            emit_deploy_progress(app, plugin_id, strategy, "download", "error", &e, None);
            Err(e)
        }
    }
}

/// Run one deployment strategy end to end. Returns the sidecar's result object on success.
pub(super) async fn deploy_with_strategy(
    app: &tauri::AppHandle,
    plugin_id: &str,
    strategy: &str,
    install_path: &str,
    existing_config: &serde_json::Value,
    default_port: u16,
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
    // 端口默认值由调用方从插件声明的 configSchema 取来。安装向导在点「安装」前
    // 并不保存配置，所以这里填的就是本次安装真正生效的端口 —— 必须与表单里显示
    // 的默认值同源，否则会出现「表单显示 7863、实际跑 8000」。
    config_values
        .entry("port".to_string())
        .or_insert(serde_json::json!(default_port));

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

    // 端口默认值取自插件自己声明的 configSchema。安装向导在点「安装」前并不保存
    // 配置，所以这里填的就是本次安装真正生效的端口 —— 必须与表单里显示的默认值
    // 同源，否则会出现「表单显示 7863、实际跑 8000」。
    //
    // 兜底值刻意不落 8000：它是大量开发服务器（Django / Flask / 各类前端 dev
    // server）的默认端口，插件默认占它会跟用户的日常开发撞车。
    let default_port = manifest
        .config_schema
        .iter()
        .find(|f| f.get("key").and_then(|k| k.as_str()) == Some("port"))
        .and_then(|f| f.get("default"))
        .and_then(|d| d.as_u64())
        .unwrap_or(FALLBACK_PORT as u64) as u16;

    // Port conflict check before doing any expensive work
    let port = existing_config
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(default_port as u64) as u16;
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

    // 发布包在策略之前统一获取：两种策略装的是同一份二进制，放到这里就不会各写一遍下载。
    // 已就位时（重装 / 续装）直接跳过，不重复下载。
    if let Some(spec) = ReleaseAssetSpec::from_deploy(&manifest.deploy)? {
        let strategy = candidates.first().cloned().unwrap_or_default();
        if let Err(e) =
            prepare_release_asset(&app, &plugin_id, &strategy, &spec, &install_path, None, false)
                .await
        {
            let mut status = read_status(&plugin_id);
            status.state = "error".to_string();
            status.error = Some(e.clone());
            status.updated_at = now_iso();
            let _ = write_status(&status);
            emit_status(&app, &status);
            return Err(e);
        }

        // 卸载重装：把上次卸载前备份的凭证与运行状态放回去，账号不用重新登录
        if let Some(restored) = plugin_asset::restore_latest_backup(&plugin_id, Path::new(&install_path))
        {
            emit_deploy_progress(
                &app,
                &plugin_id,
                &strategy,
                "restore",
                "done",
                &format!("已恢复上次卸载前的数据：{}", restored),
                None,
            );
        }
    }

    let total = candidates.len();
    let mut last_error = String::new();

    for (idx, strat) in candidates.iter().enumerate() {
        match deploy_with_strategy(&app, &plugin_id, strat, &install_path, &existing_config, default_port).await {
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
                    // 以网关实际写入的凭证为准回写缓存。
                    // adapter 可以在 generateConfig 的返回值里回传它真正写进
                    // 插件配置文件的密钥；只要本地缓存与网关用的不是同一把，
                    // 拉取模型列表就会 401，而界面上只看得到「拉取不到模型」。
                    for key in ["apiKey", "adminToken"] {
                        if let Some(v) = result_obj.get(key).and_then(|v| v.as_str()) {
                            obj.insert((*key).to_string(), serde_json::json!(v));
                        }
                    }
                    obj.insert("installPath".to_string(), serde_json::json!(install_path));
                    obj.insert("deployStrategy".to_string(), serde_json::json!(strat));
                    // 记下展示名，启动对账不必再问 sidecar 就能补齐被整体覆盖抹掉的登记
                    obj.insert("providerName".to_string(), serde_json::json!(manifest.name));
                    if !config_path.is_empty() {
                        obj.insert("configPath".to_string(), serde_json::json!(config_path));
                    }
                }
                write_config(&plugin_id, &saved_config)?;

                // 部署成功即登记为本地供应商：没有密钥就不登记（无从填 api_key）
                let api_key = saved_config
                    .get("apiKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let effective_port = saved_config
                    .get("port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(default_port as u64) as u16;
                if !api_key.trim().is_empty() {
                    emit_deploy_progress(
                        &app,
                        &plugin_id,
                        strat,
                        "add-provider",
                        "running",
                        "注册本地供应商...",
                        None,
                    );
                    match auto_add_plugin_provider(&plugin_id, &manifest.name, effective_port, &api_key) {
                        Ok(changed) => {
                            if changed {
                                emit_providers_changed(&app);
                            }
                            emit_deploy_progress(
                                &app,
                                &plugin_id,
                                strat,
                                "add-provider",
                                "done",
                                "本地供应商已注册",
                                None,
                            );
                        }
                        Err(e) => emit_deploy_progress(
                            &app,
                            &plugin_id,
                            strat,
                            "add-provider",
                            "error",
                            &format!("供应商注册失败：{}", e),
                            None,
                        ),
                    }
                }

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

