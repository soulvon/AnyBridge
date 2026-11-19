use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

use super::archive_and_config::*;
use super::cpa_settings_and_scan::*;
use super::deploy_suite::{write_installed_json, write_secrets};
use super::github_download::*;
use super::process_and_suite::*;
use super::updates_and_versions::*;
use super::*;

pub(super) fn archive_suffix(asset_name: &str) -> &str {
    let n = asset_name.to_lowercase();
    if n.ends_with(".tar.gz") {
        "tar.gz"
    } else if n.ends_with(".tgz") {
        "tgz"
    } else if n.ends_with(".zip") {
        "zip"
    } else {
        "bin"
    }
}

pub(super) fn size_msg(size: u64) -> String {
    if size > 1_000_000 {
        format!("{:.1} MB", size as f64 / 1_000_000.0)
    } else {
        format!("{} KB", size / 1000)
    }
}

/// 下载并解压指定版本的单个组件（若本地已有则跳过）
pub(super) async fn ensure_component_version_installed(
    app: &AppHandle,
    component: &str,
    version: &str,
    repo: &str,
    dir_name: &str,
    base_percent: u8,
    end_percent: u8,
) -> Result<PathBuf, String> {
    let version = normalize_version(version);
    if let Some(existing) = match component {
        "cli-proxy-api" => find_component_install_version(component, parse_cli_version, &version),
        "cpa-manager-plus" => {
            find_component_install_version(component, parse_cpamp_version, &version)
        }
        _ => None,
    } {
        emit_deploy_progress(
            app,
            "extract",
            &format!("{} {} 已在本地，跳过下载", component, version),
            base_percent,
        );
        return Ok(existing.dir);
    }

    emit_deploy_progress(
        app,
        "fetch",
        &format!("获取 {} {} 发布包...", component, version),
        base_percent,
    );
    let release = fetch_release_with_assets_by_tag(repo, &version).await?;
    let asset = find_platform_release_asset(&release.assets, component)?;
    let resolved_version = normalize_version(&release.tag_name);

    emit_deploy_progress(
        app,
        "download",
        &format!(
            "下载 {} {} ({})...",
            component,
            resolved_version,
            size_msg(asset.size)
        ),
        base_percent.saturating_add(2),
    );
    let archive = download_asset(
        &asset.browser_download_url,
        &format!(
            "anybridge_{}_{}.{}",
            component.replace('-', "_"),
            resolved_version,
            archive_suffix(&asset.name)
        ),
        app,
        base_percent.saturating_add(2),
        end_percent.saturating_sub(5),
    )
    .await?;

    let root = current_cpa_install_root();
    let versions = root.join("versions");
    let target_dir = versions.join(dir_name.replace("{ver}", &resolved_version));
    emit_deploy_progress(
        app,
        "extract",
        &format!("解压 {} {}...", component, resolved_version),
        end_percent.saturating_sub(3),
    );
    {
        let dir = target_dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract_archive(&archive, &dir))
            .await
            .map_err(|e| e.to_string())??;
    }
    Ok(target_dir)
}

#[tauri::command]
pub async fn extension_install_cpa_version(
    app: AppHandle,
    cli_version: Option<String>,
    cpamp_version: Option<String>,
    restart: Option<bool>,
) -> Result<ExtensionServiceStatus, String> {
    let _guard = cpa_deploy_lock().lock().await;
    let (pref_cli, pref_cpamp) = read_preferred_component_versions();
    let target_cli = cli_version
        .as_deref()
        .map(normalize_version)
        .filter(|v| !v.is_empty())
        .or(pref_cli.clone())
        .or_else(|| {
            find_component_install("cli-proxy-api", parse_cli_version).and_then(|i| i.version)
        });
    let target_cpamp = cpamp_version
        .as_deref()
        .map(normalize_version)
        .filter(|v| !v.is_empty())
        .or(pref_cpamp.clone())
        .or_else(|| {
            find_component_install("cpa-manager-plus", parse_cpamp_version).and_then(|i| i.version)
        });

    let target_cli =
        target_cli.ok_or_else(|| "请指定要安装的 CLIProxyAPI 版本。".to_string())?;
    let target_cpamp =
        target_cpamp.ok_or_else(|| "请指定要安装的 CPA Manager Plus 版本。".to_string())?;

    let was_running = {
        let suite = scan_cpa_suite();
        suite.status == "running" || suite.status == "degraded"
    };
    let should_restart = restart.unwrap_or(true);

    if was_running {
        emit_deploy_progress(&app, "check", "停止当前服务以安装指定版本...", 2);
        kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
        kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let root = current_cpa_install_root();
    fs::create_dir_all(root.join("versions")).map_err(|e| format!("创建 versions 目录失败: {}", e))?;
    persist_cpa_install_dir(&root)?;

    let cpa_dir = ensure_component_version_installed(
        &app,
        "cli-proxy-api",
        &target_cli,
        "router-for-me/CLIProxyAPI",
        "CLIProxyAPI_{ver}",
        8,
        45,
    )
    .await?;

    let cpamp_dir = ensure_component_version_installed(
        &app,
        "cpa-manager-plus",
        &target_cpamp,
        "seakee/CPA-Manager-Plus",
        "cpa-manager-plus_v{ver}",
        48,
        78,
    )
    .await?;

    emit_deploy_progress(&app, "config", "写入版本元数据与配置...", 82);

    // 保留已有 secrets；若无则生成（与首次部署一致）
    let secrets = if root.join("secrets.json").is_file() {
        read_cpa_secrets(&root)?
    } else {
        let s = CpaSecrets {
            admin_key: generate_random_key(24),
            management_key: generate_random_key(24),
            api_key: format!("sk-{}", generate_random_key(32)),
        };
        write_secrets(&root, &s)?;
        s
    };

    // 记录旧版本安装目录（installed.json 尚未更新）：auth/ 与 plugins/ 需迁移到
    // 新版本目录，plugins 配置段需在重写 config.yaml 时保留，
    // 否则安装/切换版本后插件文件虽在、启用状态却被模板抹掉，需用户手工重新启用。
    let old_cli_dir = find_component_install("cli-proxy-api", parse_cli_version).map(|c| c.dir);
    if let Some(old) = &old_cli_dir {
        // 同版本重装时 old == new，自拷既无意义，Windows 上还可能因文件自复制失败
        if old != &cpa_dir {
            copy_dir_contents(&old.join("auth"), &cpa_dir.join("auth"))?;
            copy_dir_contents(&old.join("plugins"), &cpa_dir.join("plugins"))?;
        }
    }
    let old_config = old_cli_dir.as_ref().map(|d| d.join("config.yaml"));
    write_cpa_config(
        &cpa_dir,
        &secrets.management_key,
        &secrets.api_key,
        old_config.as_deref(),
    )?;
    write_installed_json(&root, &target_cli, &target_cpamp)?;

    // 写入 CPAMP 配置，dataDir 指向共享数据目录
    let cpamp_runtime = {
        let dir = cpamp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || resolve_cpamp_runtime_dir(&dir))
            .await
            .map_err(|e| e.to_string())??
    };
    let shared_data_dir = root.join("cpamp-data");
    let runtime_for_migrate = cpamp_runtime.clone();
    let shared_data_for_migrate = shared_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        migrate_cpamp_data(&runtime_for_migrate, &shared_data_for_migrate)
    })
    .await
    .map_err(|e| e.to_string())??;
    let runtime_for_config = cpamp_runtime.clone();
    let shared_data_for_config = shared_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_cpamp_config(&runtime_for_config, &shared_data_for_config)
    })
    .await
    .map_err(|e| e.to_string())??;

    if should_restart {
        emit_deploy_progress(&app, "start", "启动选定版本...", 88);
        start_cpa_suite_async().await?;
        emit_deploy_progress(&app, "done", "版本安装并切换完成！", 100);
    } else {
        emit_deploy_progress(&app, "done", "版本已安装，未自动启动。", 100);
    }

    Ok(scan_cpa_suite())
}

// ═══════ 镜像源管理命令 ═══════

/// 测速结果项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSpeedResult {
    pub id: String,
    pub name: String,
    pub duration_ms: u64,
    pub success: bool,
}

#[tauri::command]
pub async fn extension_list_mirrors() -> Result<Vec<GithubMirror>, String> {
    Ok(load_mirrors())
}

#[tauri::command]
pub async fn extension_save_mirrors(mirrors: Vec<GithubMirror>) -> Result<(), String> {
    save_user_mirrors(&mirrors)
}

#[tauri::command]
pub async fn extension_speed_test_mirrors() -> Result<Vec<MirrorSpeedResult>, String> {
    // 使用一个稳定的 GitHub 仓库做测速（releases/latest 会 302 重定向，测的是真实延迟）
    let test_url = "https://github.com/git/git/releases/latest";
    let ranked = speed_test_mirrors(&test_url).await;
    Ok(ranked
        .into_iter()
        .map(|(m, d)| MirrorSpeedResult {
            id: m.id,
            name: m.name,
            duration_ms: d,
            success: d != u64::MAX,
        })
        .collect())
}
