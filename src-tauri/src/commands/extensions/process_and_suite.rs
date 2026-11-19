use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use super::*;
use super::archive_and_config::*;
use super::cpa_settings_and_scan::*;
use super::deploy_suite::*;
use super::github_download::*;

// ═══════ 停止与更新 ═══════

#[cfg(target_os = "windows")]
pub(super) fn local_addr_port(local_addr: &str) -> Option<u16> {
    // 支持 127.0.0.1:8317 / 0.0.0.0:8317 / [::1]:8317 / [::]:8317
    if let Some(rest) = local_addr.strip_prefix('[') {
        let (_host, port) = rest.rsplit_once("]:")?;
        return port.parse().ok();
    }
    local_addr.rsplit_once(':')?.1.parse().ok()
}

pub(crate) fn pid_listening_on_port(port: u16) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        // 注意：不能用 findstr :8317 —— 会误匹配 :18317（子串包含 8317）
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "netstat -ano -p tcp"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = cmd.output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if !line.contains("LISTENING") {
                continue;
            }
            // netstat 列：Proto LocalAddress ForeignAddress State PID
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 {
                continue;
            }
            if local_addr_port(cols[1]) != Some(port) {
                continue;
            }
            if let Ok(pid) = cols[cols.len() - 1].parse::<u32>() {
                return Some(pid);
            }
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        // lsof 优先
        if let Ok(out) = std::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port), "-sTCP:LISTEN"])
            .output()
        {
            if out.status.success() {
                if let Some(pid) = String::from_utf8_lossy(&out.stdout)
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                {
                    return Some(pid);
                }
            }
        }
        // ss 回退：users:(("name",pid=123,fd=4))
        if let Ok(out) = std::process::Command::new("ss")
            .args(["-ltnp", &format!("sport = :{}", port)])
            .output()
        {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if let Some(cap) = regex::Regex::new(r"pid=(\d+)")
                .ok()
                .and_then(|re| re.captures(&text))
            {
                if let Ok(pid) = cap[1].parse::<u32>() {
                    return Some(pid);
                }
            }
        }
        None
    }
}

pub(super) fn kill_service_by_port(port: u16, label: &str) -> Result<(), String> {
    if let Some(pid) = pid_listening_on_port(port) {
        // Phase 1: Graceful termination
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // taskkill without /F sends WM_CLOSE, allowing graceful shutdown
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string()]);
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let _ = cmd.status();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }

        // Wait up to 2s for graceful exit
        let mut still_alive = false;
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(500));
            if pid_listening_on_port(port).is_none() {
                still_alive = false;
                break;
            }
            still_alive = true;
        }

        // Phase 2: Force kill if still alive
        if still_alive {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let mut cmd = std::process::Command::new("taskkill");
                cmd.args(["/F", "/PID", &pid.to_string()]);
                cmd.creation_flags(0x08000000);
                let status = cmd
                    .status()
                    .map_err(|e| format!("无法强制停止 {} (PID {}): {}", label, pid, e))?;
                if !status.success() {
                    return Err(format!("强制停止 {} (PID {}) 失败。", label, pid));
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let status = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .status()
                    .map_err(|e| format!("无法强制停止 {} (PID {}): {}", label, pid, e))?;
                if !status.success() {
                    return Err(format!("强制停止 {} (PID {}) 失败。", label, pid));
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_stop_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    Ok(scan_cpa_suite())
}

pub(super) fn read_cpa_secrets(root: &Path) -> Result<CpaSecrets, String> {
    let secrets_file = root.join("secrets.json");
    let content = fs::read_to_string(&secrets_file).map_err(|e| {
        format!(
            "无法读取 secrets.json（{}）：{}。请先完成一键部署，或确认安装目录正确。",
            path_text(&secrets_file),
            e
        )
    })?;
    serde_json::from_str(&content).map_err(|e| format!("解析 secrets.json 失败: {}", e))
}

pub(super) fn resolve_cpa_secrets_for_start() -> Result<CpaSecrets, String> {
    let root = current_cpa_install_root();
    if root.join("secrets.json").is_file() {
        return read_cpa_secrets(&root);
    }
    // 兼容：secrets 偶发放在组件目录上一级（versions 的父目录）
    if let Some(cli) = find_component_install("cli-proxy-api", parse_cli_version) {
        if let Some(parent) = cli.dir.parent() {
            if parent.join("secrets.json").is_file() {
                return read_cpa_secrets(parent);
            }
            if let Some(grand) = parent.parent() {
                if grand.join("secrets.json").is_file() {
                    return read_cpa_secrets(grand);
                }
            }
        }
    }
    Err(
        "未找到 secrets.json。启动 CPA Manager Plus 需要部署时生成的密钥；请先一键部署，或将 secrets.json 放到托管安装目录。"
            .into(),
    )
}

/// 启动 CPA 套件：先启动 CPA → 等待就绪 → 启动 CPAMP → 等待就绪 → 注入补丁 → 添加供应商
pub(super) async fn start_cpa_suite_async() -> Result<(), String> {
    let cli_install = find_component_install("cli-proxy-api", parse_cli_version)
        .ok_or_else(|| "未找到 CLIProxyAPI 安装目录，请先部署 CPA 套件。".to_string())?;
    let cpamp_install = find_component_install("cpa-manager-plus", parse_cpamp_version)
        .ok_or_else(|| "未找到 CPA Manager Plus 安装目录，请先部署 CPA 套件。".to_string())?;

    let cli_probe = probe_http_port(CPA_PORT, "/healthz", "CLIProxyAPI");
    let cpamp_probe = probe_http_port(CPAMP_PORT, "/health", "CPA Manager Plus");
    let need_cli = cli_probe.status != "running";
    let need_cpamp = cpamp_probe.status != "running";

    // 始终解析密钥（启动 CPAMP、注入补丁、添加供应商都需要）
    let secrets = resolve_cpa_secrets_for_start()?;

    // 启动前同步出站代理到当前活动 config.yaml（跟随系统/自定义）
    let _ = tauri::async_runtime::spawn_blocking(sync_active_cpa_proxy_config)
        .await
        .map_err(|e| e.to_string())?;

    // 1. 启动 CPA（端口被不健康进程占用时先 kill）
    if need_cli {
        if cli_probe.status == "degraded" {
            let _ = kill_service_by_port(CPA_PORT, "CLIProxyAPI");
            tokio::time::sleep(Duration::from_secs(1)).await;
        } else {
            check_port_available(CPA_PORT, "CLIProxyAPI")?;
        }
        let cpa_exe = find_exe_in_dir(&cli_install.dir, "cli-proxy-api")?;
        tauri::async_runtime::spawn_blocking(move || start_service(&cpa_exe, &cli_install.dir, &[]))
            .await
            .map_err(|e| e.to_string())??;
    }

    // 2. 等待 CPA 就绪（CPAMP 依赖 CPA 作为 upstream，必须先就绪）
    wait_for_http(CPA_PORT, "/healthz", "CLIProxyAPI", 30).await?;

    // 3. 启动 CPAMP（端口被不健康进程占用时先 kill）
    // panelPath/PANEL_PATH 会替换 /management.html 的内容，不会新增 /management-auto.html。
    // 必须先无 PANEL_PATH 启动以拉取内嵌原版，写入补丁后再带 PANEL_PATH 重启。
    let runtime_dir = resolve_cpamp_runtime_dir(&cpamp_install.dir)?;
    let root = current_cpa_install_root();
    let shared_data_dir = root.join("cpamp-data");
    migrate_cpamp_data(&runtime_dir, &shared_data_dir)?;
    write_cpamp_config(&runtime_dir, &shared_data_dir)?;

    if need_cpamp {
        if cpamp_probe.status == "degraded" {
            let _ = kill_service_by_port(CPAMP_PORT, "CPA Manager Plus");
            tokio::time::sleep(Duration::from_secs(1)).await;
        } else {
            check_port_available(CPAMP_PORT, "CPA Manager Plus")?;
        }
        let cpamp_exe = find_exe_in_dir(&cpamp_install.dir, "cpa-manager-plus")?;
        // 同步管理员密钥，确保数据库中的凭证与 secrets.json 一致
        let cpamp_exe_reset = cpamp_exe.clone();
        let runtime_dir_reset = runtime_dir.clone();
        let admin_key_reset = secrets.admin_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            reset_cpamp_admin_key(&cpamp_exe_reset, &runtime_dir_reset, &admin_key_reset)
        })
        .await
        .map_err(|e| e.to_string())??;
        // 执行离线派生维护（创建新版本索引、清理旧派生数据，消除「数据库升级维护尚未完成」提示）
        let cpamp_exe_cleanup = cpamp_exe.clone();
        let runtime_dir_cleanup = runtime_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            cleanup_cpamp_derived(&cpamp_exe_cleanup, &runtime_dir_cleanup)
        })
        .await
        .map_err(|e| e.to_string())??;
        // 首次启动不带 PANEL_PATH，确保能读到内嵌 management.html
        let cpamp_env = cpamp_env_base(&secrets, &shared_data_dir);
        let runtime_start = runtime_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_service(&cpamp_exe, &runtime_start, &cpamp_env)
        })
        .await
        .map_err(|e| e.to_string())??;

        // 4. 等待 CPAMP 就绪
        wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 20).await?;
    }

    // 5. 注入自动登录补丁到 runtime 目录
    let patch_dir = runtime_dir.clone();
    let patch_key = secrets.admin_key.clone();
    tauri::async_runtime::spawn_blocking(move || patch_cpamp_management_html(&patch_dir, &patch_key))
        .await
        .map_err(|e| e.to_string())??;

    // 6. 用 PANEL_PATH 重启 CPAMP，使 /management.html 返回自动登录补丁
    if cpamp_panel_file(&runtime_dir).is_file() {
        let _ = kill_service_by_port(CPAMP_PORT, "CPA Manager Plus");
        tokio::time::sleep(Duration::from_secs(1)).await;
        let cpamp_exe = find_exe_in_dir(&cpamp_install.dir, "cpa-manager-plus")?;
        // 再次同步管理员密钥，覆盖首次启动初始化可能生成的 cpamp_... 密钥
        let cpamp_exe_reset = cpamp_exe.clone();
        let runtime_dir_reset = runtime_dir.clone();
        let admin_key_reset = secrets.admin_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            reset_cpamp_admin_key(&cpamp_exe_reset, &runtime_dir_reset, &admin_key_reset)
        })
        .await
        .map_err(|e| e.to_string())??;
        let cpamp_env = cpamp_env_with_panel(&secrets, &runtime_dir, &shared_data_dir);
        let runtime_start = runtime_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_service(&cpamp_exe, &runtime_start, &cpamp_env)
        })
        .await
        .map_err(|e| e.to_string())??;
        wait_for_http(CPAMP_PORT, "/health", "CPA Manager Plus", 20).await?;
    }

    // 7. 自动添加 CPA 供应商
    let provider_api_key = secrets.api_key.clone();
    tauri::async_runtime::spawn_blocking(move || auto_add_cpa_provider(&provider_api_key))
        .await
        .map_err(|e| e.to_string())??;

    Ok(())
}

#[tauri::command]
pub async fn extension_start_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    start_cpa_suite_async().await?;
    Ok(scan_cpa_suite())
}

pub(super) fn is_safe_cpa_uninstall_root(root: &Path) -> bool {
    if !root.is_dir() {
        return false;
    }
    root.join("installed.json").is_file() || root.join("versions").is_dir()
}

pub(super) fn remove_dir_contents(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_file() {
        fs::remove_file(path).map_err(|e| format!("删除文件失败 {}: {}", path.display(), e))?;
        return Ok(());
    }
    fs::remove_dir_all(path).map_err(|e| format!("删除目录失败 {}: {}", path.display(), e))?;
    Ok(())
}

pub(super) fn uninstall_cpa_suite_files() -> Result<(), String> {
    let root = current_cpa_install_root();
    if !root.exists() {
        // 仍清理自定义 installDir 配置
        let _ = persist_cpa_install_dir(&default_cpa_install_root());
        return Ok(());
    }
    if !is_safe_cpa_uninstall_root(&root) {
        return Err(format!(
            "安装目录 {} 缺少 installed.json 或 versions/，已拒绝删除以防误伤用户目录。请确认路径后手动清理，或重新部署到默认托管目录。",
            path_text(&root)
        ));
    }

    // 优先删 versions 与元数据，最后尝试移除空根目录
    let versions = root.join("versions");
    if versions.exists() {
        remove_dir_contents(&versions)?;
    }
    for name in ["installed.json", "secrets.json"] {
        let file = root.join(name);
        if file.exists() {
            remove_dir_contents(&file)?;
        }
    }
    // 清理根下其它残留（配置、日志等）
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = remove_dir_contents(&path);
        }
    }
    if fs::read_dir(&root).map(|mut it| it.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(&root);
    }

    // 恢复默认安装路径配置
    persist_cpa_install_dir(&default_cpa_install_root())?;
    Ok(())
}

#[tauri::command]
pub async fn extension_uninstall_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    tauri::async_runtime::spawn_blocking(uninstall_cpa_suite_files)
        .await
        .map_err(|e| e.to_string())??;

    // 卸载后移除内置 CPA 供应商
    let _ = tauri::async_runtime::spawn_blocking(remove_cpa_provider)
        .await
        .map_err(|e| e.to_string())?;

    Ok(scan_cpa_suite())
}

#[tauri::command]
pub async fn extension_restart_cpa_suite() -> Result<ExtensionServiceStatus, String> {
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;
    tokio::time::sleep(Duration::from_secs(2)).await;

    start_cpa_suite_async().await?;
    Ok(scan_cpa_suite())
}

#[tauri::command]
pub async fn extension_cpa_default_install_dir() -> Result<String, String> {
    Ok(path_text(&default_cpa_install_root()))
}

#[tauri::command]
pub async fn extension_cpa_install_dir() -> Result<String, String> {
    Ok(path_text(&current_cpa_install_root()))
}

#[tauri::command]
pub async fn extension_set_cpa_install_dir(dir: String) -> Result<(), String> {
    if dir.trim().is_empty() {
        return Err("安装目录不能为空。".into());
    }
    let path = PathBuf::from(dir.trim());
    persist_cpa_install_dir(&path)
}

#[tauri::command]
pub async fn extension_cpa_auto_start() -> Result<bool, String> {
    Ok(is_cpa_auto_start_enabled())
}

#[tauri::command]
pub async fn extension_set_cpa_auto_start(enabled: bool) -> Result<bool, String> {
    persist_cpa_auto_start(enabled)?;
    Ok(enabled)
}

#[tauri::command]
pub async fn extension_cpa_proxy_settings() -> Result<CpaProxySettingsView, String> {
    tauri::async_runtime::spawn_blocking(build_cpa_proxy_settings_view)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extension_set_cpa_proxy_settings(
    mode: String,
    custom_url: Option<String>,
) -> Result<CpaProxySettingsView, String> {
    let mode = CpaProxyMode::parse(&mode)?;
    tauri::async_runtime::spawn_blocking(move || {
        persist_cpa_proxy_settings(mode, custom_url)?;
        let mut view = build_cpa_proxy_settings_view()?;
        // config.yaml 已更新，但运行中的 CLIProxyAPI 需重启后才会加载新 proxy-url
        if view.suite_running {
            view.needs_restart = true;
        }
        Ok(view)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 应用启动时调用：若已安装且开启跟随启动，则后台拉起 CPA 套件。
pub fn maybe_auto_start_cpa_suite() {
    tauri::async_runtime::spawn(async move {
        let enabled = tauri::async_runtime::spawn_blocking(is_cpa_auto_start_enabled)
            .await
            .unwrap_or(false);
        if !enabled {
            return;
        }
        let suite = match tauri::async_runtime::spawn_blocking(scan_cpa_suite).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[auto-start] 检测 CPA 状态失败: {}", e);
                return;
            }
        };
        if !suite.installed {
            return;
        }
        if suite.status == "running" {
            return;
        }
        match start_cpa_suite_async().await {
            Ok(()) => eprintln!("[auto-start] CPA 套件已跟随启动"),
            Err(e) => eprintln!("[auto-start] CPA 套件启动失败: {}", e),
        }
    });
}

#[tauri::command]
pub async fn extension_update_cpa_suite(
    app: AppHandle,
    install_dir: Option<String>,
) -> Result<ExtensionServiceStatus, String> {
    let _guard = cpa_deploy_lock().lock().await;
    let report = extension_check_cpa_updates().await?;
    let has_update = report
        .components
        .iter()
        .any(|component| component.update_available == Some(true));
    if !has_update {
        return Err("当前已是最新版本，无需更新。".into());
    }

    emit_deploy_progress(&app, "check", "检查到新版本，准备更新...", 2);
    kill_service_by_port(CPA_PORT, "CLIProxyAPI")?;
    kill_service_by_port(CPAMP_PORT, "CPA Manager Plus")?;

    // 等待端口释放（最多重试 10 次，每次 2 秒）
    let mut ports_released = false;
    for i in 0..10u32 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let cli_probe = probe_http_port(CPA_PORT, "/", "CLIProxyAPI");
        let cpamp_probe = probe_http_port(CPAMP_PORT, "/", "CPA Manager Plus");
        if cli_probe.status == "stopped" && cpamp_probe.status == "stopped" {
            ports_released = true;
            break;
        }
        emit_deploy_progress(
            &app,
            "check",
            &format!("等待服务停止...({}/10)", i + 1),
            2,
        );
    }
    if !ports_released {
        // 尝试恢复旧服务
        let _ = start_cpa_suite_async().await;
        return Err("更新失败：服务停止后端口未释放，请稍后重试。".into());
    }

    match deploy_cpa_suite_inner(app.clone(), install_dir).await {
        Ok(result) => Ok(result),
        Err(e) => {
            // 更新失败，尝试恢复旧服务
            emit_deploy_progress(&app, "rollback", "更新失败，尝试恢复旧服务...", 0);
            if let Err(restart_err) = start_cpa_suite_async().await {
                return Err(format!(
                    "更新失败: {}\n恢复旧服务也失败: {}",
                    e, restart_err
                ));
            }
            Err(format!("更新失败: {}（旧服务已恢复）", e))
        }
    }
}

