use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;
use super::*;
use super::archive_and_config::*;
use super::cpa_install_and_mirrors::{archive_suffix, size_msg};
use super::cpa_settings_and_scan::*;
use super::github_download::*;
use super::process_and_suite::*;
use super::updates_and_versions::*;

/// 部署/启动成功后自动将 CPA 添加为内置本地供应商（固定 id，排在 AnyBridge 后由前端处理）。
pub(super) fn auto_add_cpa_provider(api_key: &str) -> Result<(), String> {
    use crate::commands::config::{ApiFormat, Provider, ProviderCapabilities};

    let cpa_host = "http://127.0.0.1:8317";
    let cpa_id = "cpa-local";
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("CPA API Key 为空，无法添加供应商。".into());
    }

    crate::commands::store_io::update_provider_store(|store| {
        // 已有固定 id：同步 host / key / 路径
        if let Some(existing) = store.providers.iter_mut().find(|p| p.id == cpa_id) {
            existing.name = "CPA".into();
            existing.api_host = cpa_host.into();
            existing.api_key = api_key;
            if existing.api_path.as_deref().unwrap_or("").trim().is_empty() {
                existing.api_path = Some("/v1".into());
            }
            existing.enabled = true;
            return Ok((true, ()));
        }

        // 兼容旧版自动添加的 p-cpa-local*：升级为固定 id（不按 host 匹配，避免劫持用户自建供应商）
        if let Some(existing) = store
            .providers
            .iter_mut()
            .find(|p| p.id.starts_with("p-cpa-local"))
        {
            existing.id = cpa_id.into();
            existing.name = "CPA".into();
            existing.api_host = cpa_host.into();
            existing.api_key = api_key;
            if existing.api_path.as_deref().unwrap_or("").trim().is_empty() {
                existing.api_path = Some("/v1".into());
            }
            existing.enabled = true;
            return Ok((true, ()));
        }

        let provider = Provider {
            id: cpa_id.into(),
            name: "CPA".into(),
            api_host: cpa_host.into(),
            api_key,
            api_keys: Vec::new(),
            api_path: Some("/v1".into()),
            default_model: String::new(),
            api_format: Some(ApiFormat::Openai),
            enabled: true,
            models: Vec::new(),
            capabilities: ProviderCapabilities::default(),
            model_caps: std::collections::HashMap::new(),
            unlocks: Default::default(),
            wire_api: String::new(),
            route_through_proxy: true,
            inject_models: true,
            preserve_official_auth: false,
            unify_session_history: true,
            model_catalog: Vec::new(),
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
            context_window: None,
            model_contexts: HashMap::new(),
            subagent_models: HashMap::new(),
        };

        // 尽量插到列表前部（前端仍会把 AnyBridge 置顶、CPA 紧随其后）
        store.providers.insert(0, provider);
        Ok((true, ()))
    })
}

pub(super) fn remove_cpa_provider() -> Result<(), String> {
    crate::commands::store_io::update_provider_store(|store| {
        let before = store.providers.len();
        // 只删系统自动管理的 CPA 条目，不按 host 误删用户自建供应商
        store
            .providers
            .retain(|p| p.id != "cpa-local" && !p.id.starts_with("p-cpa-local"));
        Ok((store.providers.len() != before, ()))
    })
}

pub(super) fn write_secrets(root: &Path, secrets: &CpaSecrets) -> Result<(), String> {
    let json_str =
        serde_json::to_string_pretty(secrets).map_err(|e| format!("序列化 secrets 失败: {}", e))?;
    let target = root.join("secrets.json");
    crate::commands::write_atomic(&target, json_str.as_bytes())
        .map_err(|e| format!("写入 secrets.json 失败: {}", e))
}

pub(super) fn write_installed_json(root: &Path, cpa_ver: &str, cpamp_ver: &str) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("创建目录失败: {}", e))?;
    let json = serde_json::json!({
        "schemaVersion": 1,
        "extensions": {
            "cpa-suite": {
                "enabled": true,
                "components": {
                    "cli-proxy-api": {
                        "version": cpa_ver,
                        "port": 8317,
                        "relativePath": format!("versions/CLIProxyAPI_{}", cpa_ver)
                    },
                    "cpa-manager-plus": {
                        "version": cpamp_ver,
                        "port": 18317,
                        "relativePath": format!("versions/cpa-manager-plus_v{}", cpamp_ver)
                    }
                }
            }
        }
    });
    let json_str = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("序列化 installed.json 失败: {}", e))?;
    crate::commands::write_atomic(&root.join("installed.json"), json_str.as_bytes())
        .map_err(|e| format!("写入 installed.json 失败: {}", e))
}

pub(super) fn check_port_available(port: u16, label: &str) -> Result<(), String> {
    let probe = probe_http_port(port, "/", label);
    if probe.status != "stopped" {
        return Err(format!(
            "端口 {} 已被占用（{}）。请先停止占用该端口的服务再重试。",
            port, probe.detail
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_deploy_cpa_suite(
    app: AppHandle,
    install_dir: Option<String>,
) -> Result<ExtensionServiceStatus, String> {
    let _guard = cpa_deploy_lock().lock().await;
    deploy_cpa_suite_inner(app, install_dir).await
}

/// 实际部署逻辑。调用方需自行持有 cpa_deploy_lock()。
pub(super) async fn deploy_cpa_suite_inner(
    app: AppHandle,
    install_dir: Option<String>,
) -> Result<ExtensionServiceStatus, String> {
    let current = scan_cpa_suite();
    if current.status == "running" {
        return Err("CPA 套件已在运行中。如需重新部署，请先停止服务。".into());
    }

    // 1. 检查端口可用性
    emit_deploy_progress(&app, "check", "检查端口可用性...", 2);
    check_port_available(CPA_PORT, "CLIProxyAPI")?;
    check_port_available(CPAMP_PORT, "CPA Manager Plus")?;

    // 2. 获取 GitHub 发布包
    emit_deploy_progress(&app, "fetch", "获取 GitHub 最新发布包...", 5);
    let (cpa_release, cpamp_release) = tokio::try_join!(
        fetch_release_with_assets("router-for-me/CLIProxyAPI"),
        fetch_release_with_assets("seakee/CPA-Manager-Plus")
    )?;

    let cpa_asset = find_platform_release_asset(&cpa_release.assets, "CLIProxyAPI")?;
    let cpamp_asset = find_platform_release_asset(&cpamp_release.assets, "CPA Manager Plus")?;

    let cpa_version = normalize_version(&cpa_release.tag_name);
    let cpamp_version = normalize_version(&cpamp_release.tag_name);

    // 3. 准备目录（提前到下载前，用于检测本地已有目标版本，跳过重复下载）
    let root = resolve_cpa_install_dir(install_dir);
    let versions = root.join("versions");
    persist_cpa_install_dir(&root)?;
    let cpa_dir = versions.join(format!("CLIProxyAPI_{}", cpa_version));
    let cpamp_dir = versions.join(format!("cpa-manager-plus_v{}", cpamp_version));

    // 4. 记录旧版本安装目录，用于后续数据迁移
    let old_cli_dir = find_component_install("cli-proxy-api", parse_cli_version)
        .map(|c| c.dir);

    // 5. 下载 CPA（目标版本已在本地则跳过，避免更新未变更组件时重复下载）
    let cpa_archive = if find_exe_in_dir(&cpa_dir, "cli-proxy-api").is_ok() {
        emit_deploy_progress(
            &app,
            "download_cpa",
            &format!("CLIProxyAPI {} 已在本地，跳过下载", cpa_version),
            10,
        );
        None
    } else {
        emit_deploy_progress(
            &app,
            "download_cpa",
            &format!(
                "下载 CLIProxyAPI {} ({})...",
                cpa_version,
                size_msg(cpa_asset.size)
            ),
            10,
        );
        Some(
            download_asset(
                &cpa_asset.browser_download_url,
                &format!(
                    "anybridge_cpa_{}.{}",
                    cpa_version,
                    archive_suffix(&cpa_asset.name)
                ),
                &app,
                10,
                35,
            )
            .await?,
        )
    };

    // 6. 下载 CPAMP（同上）
    let cpamp_archive = if find_exe_in_dir(&cpamp_dir, "cpa-manager-plus").is_ok() {
        emit_deploy_progress(
            &app,
            "download_cpamp",
            &format!("CPA Manager Plus {} 已在本地，跳过下载", cpamp_version),
            40,
        );
        None
    } else {
        emit_deploy_progress(
            &app,
            "download_cpamp",
            &format!(
                "下载 CPA Manager Plus {} ({})...",
                cpamp_version,
                size_msg(cpamp_asset.size)
            ),
            40,
        );
        Some(
            download_asset(
                &cpamp_asset.browser_download_url,
                &format!(
                    "anybridge_cpamp_{}.{}",
                    cpamp_version,
                    archive_suffix(&cpamp_asset.name)
                ),
                &app,
                40,
                60,
            )
            .await?,
        )
    };

    // 7. 解压 CPA
    if let Some(archive) = &cpa_archive {
        emit_deploy_progress(&app, "extract_cpa", "解压 CLIProxyAPI...", 65);
        let dir = cpa_dir.clone();
        let archive = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let res = extract_archive(&archive, &dir);
            let _ = fs::remove_file(&archive);
            res
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    // 8. 解压 CPAMP
    if let Some(archive) = &cpamp_archive {
        emit_deploy_progress(&app, "extract_cpamp", "解压 CPA Manager Plus...", 70);
        let dir = cpamp_dir.clone();
        let archive = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let res = extract_archive(&archive, &dir);
            let _ = fs::remove_file(&archive);
            res
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    // 8.5. 迁移旧版本 auth/ 和 plugins/ 到新版本目录，保留用户配置
    // 同版本重装时 old == new，自拷既无意义，Windows 上还可能因文件自复制失败。
    if let Some(old) = &old_cli_dir {
        if old != &cpa_dir {
            let old_cli = old.clone();
            let new_cli = cpa_dir.clone();
            tauri::async_runtime::spawn_blocking(move || {
                copy_dir_contents(&old_cli.join("auth"), &new_cli.join("auth"))?;
                copy_dir_contents(&old_cli.join("plugins"), &new_cli.join("plugins"))?;
                Ok::<_, String>(())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
    }

    // 8. 生成密钥和配置（已存在则复用，避免每次更新丢失密钥）
    emit_deploy_progress(&app, "config", "生成运行时配置和密钥...", 75);
    let secrets = {
        let existing = root.join("secrets.json");
        if existing.is_file() {
            match fs::read_to_string(&existing)
                .ok()
                .and_then(|c| serde_json::from_str::<CpaSecrets>(&c).ok())
            {
                Some(s) => s,
                None => CpaSecrets {
                    admin_key: generate_random_key(24),
                    management_key: generate_random_key(24),
                    api_key: format!("sk-{}", generate_random_key(32)),
                },
            }
        } else {
            CpaSecrets {
                admin_key: generate_random_key(24),
                management_key: generate_random_key(24),
                api_key: format!("sk-{}", generate_random_key(32)),
            }
        }
    };

    let cpa_dir_c = cpa_dir.clone();
    let root_c = root.clone();
    // 保留旧版本 config.yaml 的 plugins 段（目录迁移已由上方 8.5 步完成）
    let old_config = old_cli_dir.as_ref().map(|d| d.join("config.yaml"));
    let mgmt_key = secrets.management_key.clone();
    let api_key = secrets.api_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_cpa_config(&cpa_dir_c, &mgmt_key, &api_key, old_config.as_deref())?;
        write_secrets(&root_c, &secrets)?;
        write_installed_json(&root_c, &cpa_version, &cpamp_version)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 9. 确认可执行文件存在
    let cpa_exe = {
        let dir = cpa_dir.clone();
        tauri::async_runtime::spawn_blocking(move || find_exe_in_dir(&dir, "cli-proxy-api"))
            .await
            .map_err(|e| e.to_string())??
    };
    let cpamp_exe = {
        let dir = cpamp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || find_exe_in_dir(&dir, "cpa-manager-plus"))
            .await
            .map_err(|e| e.to_string())??
    };
    let cpamp_runtime = cpamp_exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("无法解析 CPAMP 运行目录: {}", cpamp_exe.display()))?;

    // 配置写到 exe 同目录（发布包常再套一层平台目录）
    // dataDir 指向共享数据目录，确保更新后数据不丢失
    {
        let runtime = cpamp_runtime.clone();
        let shared_data = root.join("cpamp-data");
        // 迁移旧版本 data/ 到共享目录（仅首次）
        let runtime_for_migrate = cpamp_runtime.clone();
        let shared_data_for_migrate = shared_data.clone();
        tauri::async_runtime::spawn_blocking(move || {
            migrate_cpamp_data(&runtime_for_migrate, &shared_data_for_migrate)
        })
        .await
        .map_err(|e| e.to_string())??;
        tauri::async_runtime::spawn_blocking(move || write_cpamp_config(&runtime, &shared_data))
            .await
            .map_err(|e| e.to_string())??;
    }

    // 10. 启动 CPA
    emit_deploy_progress(&app, "start_cpa", "启动 CLIProxyAPI...", 82);
    let cpa_dir_start = cpa_dir.clone();
    tauri::async_runtime::spawn_blocking(move || start_service(&cpa_exe, &cpa_dir_start, &[]))
        .await
        .map_err(|e| e.to_string())??;

    // 11. 健康检查 CPA（/healthz 无需认证）
    emit_deploy_progress(&app, "health_cpa", "等待 CLIProxyAPI 就绪...", 85);
    wait_for_http(CPA_PORT, "/healthz", "CLIProxyAPI", 30).await?;

    // 12. 启动 CPAMP（先不带 PANEL_PATH，便于拉取内嵌面板）
    emit_deploy_progress(&app, "start_cpamp", "启动 CPA Manager Plus...", 92);
    let secrets_file = root.join("secrets.json");
    let secrets: CpaSecrets = serde_json::from_str(
        &fs::read_to_string(&secrets_file).map_err(|e| format!("无法读取 secrets.json: {}", e))?,
    )
    .map_err(|e| format!("解析 secrets.json 失败: {}", e))?;

    let shared_data_dir = root.join("cpamp-data");
    let cpamp_env = cpamp_env_base(&secrets, &shared_data_dir);
    // 同步管理员密钥（同版本重装时 DB 可能已存在）
    let cpamp_exe_reset = cpamp_exe.clone();
    let cpamp_runtime_reset = cpamp_runtime.clone();
    let admin_key_reset = secrets.admin_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reset_cpamp_admin_key(&cpamp_exe_reset, &cpamp_runtime_reset, &admin_key_reset)
    })
    .await
    .map_err(|e| e.to_string())??;
    // 执行离线派生维护（创建新版本索引、清理旧派生数据，消除「数据库升级维护尚未完成」提示）
    let cpamp_exe_cleanup = cpamp_exe.clone();
    let cpamp_runtime_cleanup = cpamp_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_cpamp_derived(&cpamp_exe_cleanup, &cpamp_runtime_cleanup)
    })
    .await
    .map_err(|e| e.to_string())??;
    let cpamp_runtime_start = cpamp_runtime.clone();
    let cpamp_exe_start = cpamp_exe.clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_service(&cpamp_exe_start, &cpamp_runtime_start, &cpamp_env)
    })
    .await
    .map_err(|e| e.to_string())??;

    // 13. 健康检查 CPAMP
    emit_deploy_progress(&app, "health_cpamp", "等待 CPA Manager Plus 就绪...", 95);
    wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 20).await?;

    // 14. 注入自动登录补丁，并用 PANEL_PATH 重启以覆盖 /management.html
    emit_deploy_progress(&app, "patch_panel", "注入面板自动登录...", 97);
    let patch_dir = cpamp_runtime.clone();
    let patch_key = secrets.admin_key.clone();
    tauri::async_runtime::spawn_blocking(move || patch_cpamp_management_html(&patch_dir, &patch_key))
        .await
        .map_err(|e| e.to_string())??;

    if cpamp_panel_file(&cpamp_runtime).is_file() {
        emit_deploy_progress(&app, "patch_panel", "应用自动登录面板...", 98);
        kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
        tokio::time::sleep(Duration::from_secs(1)).await;
        // 同步管理员密钥，确保数据库中保存的与 secrets.json 一致
        let cpamp_runtime_reset = cpamp_runtime.clone();
        let cpamp_exe_reset = cpamp_exe.clone();
        let admin_key_reset = secrets.admin_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            reset_cpamp_admin_key(&cpamp_exe_reset, &cpamp_runtime_reset, &admin_key_reset)
        })
        .await
        .map_err(|e| e.to_string())??;
        let cpamp_env = cpamp_env_with_panel(&secrets, &cpamp_runtime, &root.join("cpamp-data"));
        let runtime_restart = cpamp_runtime.clone();
        let exe_restart = cpamp_exe.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_service(&exe_restart, &runtime_restart, &cpamp_env)
        })
        .await
        .map_err(|e| e.to_string())??;
        wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 20).await?;
    }

    // 15. 自动添加 CPA 供应商到 providers.json
    emit_deploy_progress(&app, "add_provider", "添加 CPA 供应商...", 99);
    let provider_api_key = secrets.api_key.clone();
    tauri::async_runtime::spawn_blocking(move || auto_add_cpa_provider(&provider_api_key))
        .await
        .map_err(|e| e.to_string())??;

    emit_deploy_progress(&app, "done", "CPA 套件部署完成！", 100);

    Ok(scan_cpa_suite())
}

