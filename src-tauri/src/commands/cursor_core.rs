use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

const DEFAULT_CONTROL_PORT: u16 = 17650;

pub struct CursorCoreChild {
    child: Mutex<std::process::Child>,
}

impl CursorCoreChild {
    fn try_wait(&self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.lock().unwrap_or_else(|e| e.into_inner()).try_wait()
    }

    fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(target_os = "windows")]
        {
            let pid = child.id().to_string();
            let result = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            if result.as_ref().is_ok_and(|output| output.status.success()) {
                return Ok(());
            }
        }
        child.kill().map_err(|error| format!("停止 Cursor Core 失败: {error}"))
    }
}

#[derive(Default)]
pub struct CursorCoreState {
    child: Mutex<Option<CursorCoreChild>>,
    starting: AtomicBool,
    core_revision: Mutex<String>,
    last_sync_at: Mutex<Option<i64>>,
    last_sync_error: Mutex<Option<String>>,
    synced_models: Mutex<usize>,
}

impl CursorCoreState {
    pub fn running(&self) -> bool {
        process_running(self) && tcp_ready(control_port())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorCoreStatus {
    pub running: bool,
    pub control_port: u16,
    pub health_url: String,
    pub configured_models: usize,
    pub synced_models: usize,
    pub config_revision: String,
    pub core_revision: String,
    pub sync_state: String,
    pub last_sync_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub certificate_ready: bool,
    pub certificate_message: String,
    pub available_actions: Vec<String>,
    pub last_error: Option<String>,
    pub migration_notice: Option<String>,
}

fn control_port() -> u16 {
    crate::commands::config::read_config_value("CURSOR_CORE_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_CONTROL_PORT)
}

fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/__byok-api__/healthz")
}

fn tcp_ready(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn cursor_store_stats() -> (usize, String, Option<String>) {
    crate::commands::cursor_models::read_cursor_store()
        .map(|store| {
            let count = store.models.iter().filter(|m| m.enabled).count();
            (count, store.revision, store.migration_notice)
        })
        .unwrap_or((0, String::new(), None))
}

fn process_running(state: &CursorCoreState) -> bool {
    let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
    let running = guard
        .as_ref()
        .is_some_and(|managed| managed.try_wait().ok().flatten().is_none());
    if !running {
        *guard = None;
    }
    running
}

fn status(state: &CursorCoreState, last_error: Option<String>) -> CursorCoreStatus {
    let port = control_port();
    let running = process_running(state) && tcp_ready(port);
    let certificate = crate::commands::cert_install::check_ca_status();
    let certificate_ready = certificate.san_current
        && (certificate.current_user || certificate.local_machine);

    let (configured_models, config_revision, migration_notice) = cursor_store_stats();
    let core_revision = state
        .core_revision
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let last_sync_at = *state
        .last_sync_at
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let last_sync_error = state
        .last_sync_error
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let synced_models = *state
        .synced_models
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let sync_state = if !running {
        if configured_models == 0 {
            "empty".to_string()
        } else {
            "pending".to_string()
        }
    } else if last_sync_error.is_some() {
        "error".to_string()
    } else if config_revision == core_revision && !config_revision.is_empty() {
        "synced".to_string()
    } else {
        "pending".to_string()
    };

    CursorCoreStatus {
        running,
        control_port: port,
        health_url: health_url(port),
        configured_models,
        synced_models,
        config_revision,
        core_revision,
        sync_state,
        last_sync_at,
        last_sync_error,
        certificate_ready,
        certificate_message: certificate.message,
        available_actions: if running {
            vec!["disable".into(), "restart".into(), "sync".into(), "repair".into()]
        } else {
            vec!["enable".into(), "repair".into()]
        },
        last_error,
        migration_notice,
    }
}

fn resolve_binary(_app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("无法定位 AnyBridge 项目根目录")?
            .to_path_buf();
        let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
        let path = root
            .join("cursor-core")
            .join("target")
            .join("debug")
            .join(format!("anybridge-cursor-core{suffix}"));
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "Cursor Core 开发二进制不存在: {}。请先构建 Cursor Core。",
            path.display()
        ));
    }

    #[cfg(not(debug_assertions))]
    {
        let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
        let exe_dir = std::env::current_exe()
            .map_err(|error| format!("读取程序目录失败: {error}"))?
            .parent()
            .ok_or("程序路径缺少父目录")?
            .to_path_buf();
        let candidates = [
            exe_dir.join(format!("anybridge-cursor-core{suffix}")),
            _app.path()
                .resource_dir()
                .map_err(|error| format!("读取资源目录失败: {error}"))?
                .join(format!("anybridge-cursor-core{suffix}")),
        ];
        candidates
            .into_iter()
            .find(|path| path.exists())
            .ok_or_else(|| "安装包缺少 anybridge-cursor-core 二进制".into())
    }
}

fn ensure_proxy_running(app: &AppHandle) -> Result<(), String> {
    let proxy = app.state::<crate::commands::proxy::ProxyState>();
    if !crate::commands::proxy::get_proxy_status(proxy).running {
        crate::commands::proxy::start_proxy_service_impl(app.clone())?;
    }
    Ok(())
}

fn start_impl(app: AppHandle, state: &CursorCoreState) -> Result<(), String> {
    if process_running(state) {
        return Ok(());
    }
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("Cursor Core 正在启动".into());
    }
    let result = (|| {
        let certificate = crate::commands::cert_install::check_ca_status();
        if !certificate.san_current || !(certificate.current_user || certificate.local_machine) {
            return Err(format!("AnyBridge CA 尚未就绪: {}", certificate.message));
        }
        ensure_proxy_running(&app)?;
        let key = crate::commands::config::read_config_value("LOCAL_PROXY_KEY")
            .filter(|value| !value.trim().is_empty())
            .ok_or("AnyBridge 本地代理 Key 尚未生成")?;
        let config_dir = crate::commands::config::config_dir_path();
        let routes = config_dir.join("proxy-routes.json");
        let cursor_models = config_dir.join("cursor-models.json");
        let providers = config_dir.join("providers.json");
        if !routes.exists() {
            return Err("尚未配置可供 Cursor 使用的代理模型".into());
        }
        let port = control_port();
        let proxy_port = crate::commands::proxy::get_proxy_status(
            app.state::<crate::commands::proxy::ProxyState>(),
        )
        .api_port;
        let binary = resolve_binary(&app)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(metadata) = std::fs::metadata(&binary) {
                let mut permissions = metadata.permissions();
                let mode = permissions.mode();
                if mode & 0o111 != 0o111 {
                    permissions.set_mode(mode | 0o755);
                    let _ = std::fs::set_permissions(&binary, permissions);
                }
            }
        }
        let mut command = Command::new(&binary);
        command
            .env("ANYBRIDGE_CONFIG_DIR", &config_dir)
            .env("ANYBRIDGE_ROUTES_PATH", &routes)
            .env("ANYBRIDGE_CURSOR_MODELS_PATH", &cursor_models)
            .env("ANYBRIDGE_PROVIDERS_PATH", &providers)
            .env("ANYBRIDGE_GATEWAY_URL", format!("http://127.0.0.1:{proxy_port}"))
            .env("ANYBRIDGE_LOCAL_PROXY_KEY", key)
            .env("ANYBRIDGE_CURSOR_LISTEN_ADDR", format!("127.0.0.1:{port}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        let child = command
            .spawn()
            .map_err(|error| format!("启动 Cursor Core 失败: {error}"))?;
        *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(CursorCoreChild {
            child: Mutex::new(child),
        });
        for _ in 0..30 {
            if tcp_ready(port) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = stop_impl(state);
        Err("Cursor Core 启动超时".into())
    })();
    state.starting.store(false, Ordering::SeqCst);
    result
}

fn stop_impl(state: &CursorCoreState) -> Result<(), String> {
    let child = state.child.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(child) = child {
        child.kill()?;
    }
    Ok(())
}

async fn core_request(
    port: u16,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.request(method, format!("http://127.0.0.1:{port}{path}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!(
            "Cursor Core 返回 {status}: {}",
            response.text().await.unwrap_or_default()
        ))
    }
}

pub fn get_status_impl(state: &CursorCoreState) -> CursorCoreStatus {
    status(state, None)
}

pub async fn sync_routes_impl(state: &CursorCoreState) -> Result<CursorCoreStatus, String> {
    if !process_running(state) {
        return Ok(status(state, None));
    }
    let config_dir = crate::commands::config::config_dir_path();
    let proxy_port = crate::commands::config::configured_proxy_ports().api_port;
    let (count, rev, _) = cursor_store_stats();

    let res = core_request(
        control_port(),
        reqwest::Method::POST,
        "/__byok-api__/api/harness/cursor/routes/sync",
        Some(serde_json::json!({
            "routes_path": config_dir.join("proxy-routes.json"),
            "cursor_models_path": config_dir.join("cursor-models.json"),
            "gateway_url": format!("http://127.0.0.1:{proxy_port}")
        })),
    )
    .await;

    let now_ms = chrono::Utc::now().timestamp_millis();
    match res {
        Ok(_) => {
            *state.core_revision.lock().unwrap_or_else(|e| e.into_inner()) = rev;
            *state.last_sync_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(now_ms);
            *state.last_sync_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.synced_models.lock().unwrap_or_else(|e| e.into_inner()) = count;
            Ok(status(state, None))
        }
        Err(e) => {
            *state.last_sync_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
            Ok(status(state, Some(e)))
        }
    }
}

#[tauri::command]
pub fn cursor_get_status(state: State<CursorCoreState>) -> CursorCoreStatus {
    get_status_impl(state.inner())
}

#[tauri::command]
pub async fn cursor_enable(app: AppHandle) -> Result<CursorCoreStatus, String> {
    let app_for_start = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_start.state::<CursorCoreState>();
        start_impl(app_for_start.clone(), state.inner())
    })
    .await
    .map_err(|error| error.to_string())??;
    core_request(control_port(), reqwest::Method::PUT, "/__byok-api__/api/harness/cursor/enabled", Some(serde_json::json!({"enabled": true}))).await?;
    let state = app.state::<CursorCoreState>();
    let _ = sync_routes_impl(state.inner()).await;
    Ok(status(state.inner(), None))
}

#[tauri::command]
pub async fn cursor_sync_routes(state: State<'_, CursorCoreState>) -> Result<CursorCoreStatus, String> {
    sync_routes_impl(state.inner()).await
}

#[tauri::command]
pub async fn cursor_disable(state: State<'_, CursorCoreState>) -> Result<CursorCoreStatus, String> {
    if process_running(state.inner()) {
        let _ = core_request(control_port(), reqwest::Method::PUT, "/__byok-api__/api/harness/cursor/enabled", Some(serde_json::json!({"enabled": false}))).await;
    }
    stop_impl(state.inner())?;
    Ok(status(state.inner(), None))
}

#[tauri::command]
pub async fn cursor_restart(app: AppHandle, state: State<'_, CursorCoreState>) -> Result<CursorCoreStatus, String> {
    if process_running(state.inner()) {
        let _ = core_request(control_port(), reqwest::Method::PUT, "/__byok-api__/api/harness/cursor/enabled", Some(serde_json::json!({"enabled": false}))).await;
    }
    stop_impl(state.inner())?;
    cursor_enable(app).await
}

#[tauri::command]
pub fn cursor_preflight(app: AppHandle, state: State<CursorCoreState>) -> Result<CursorCoreStatus, String> {
    resolve_binary(&app)?;
    let (count, _, _) = cursor_store_stats();
    if count == 0 {
        return Err("至少需要一个启用的 Cursor 代理模型".into());
    }
    crate::commands::config::read_config_value("LOCAL_PROXY_KEY")
        .filter(|value| !value.trim().is_empty())
        .ok_or("AnyBridge 本地代理 Key 尚未生成")?;
    let certificate = crate::commands::cert_install::check_ca_status();
    if !certificate.san_current || !(certificate.current_user || certificate.local_machine) {
        return Err(format!("AnyBridge CA 尚未就绪: {}", certificate.message));
    }
    Ok(status(state.inner(), None))
}

pub fn stop_on_exit(state: &CursorCoreState) {
    if process_running(state) {
        let _ = tauri::async_runtime::block_on(core_request(
            control_port(),
            reqwest::Method::PUT,
            "/__byok-api__/api/harness/cursor/enabled",
            Some(serde_json::json!({"enabled": false})),
        ));
    }
    let _ = stop_impl(state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopped_status_offers_enable_and_repair() {
        let state = CursorCoreState::default();
        let status = status(&state, None);
        assert!(!status.running);
        assert_eq!(status.control_port, 17650);
        assert!(status.available_actions.contains(&"enable".to_string()));
        assert!(status.available_actions.contains(&"repair".to_string()));
    }
}
