use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// DETACHED_PROCESS: 子进程不继承父进程控制台，也不会创建新控制台。
/// 对 console subsystem 的二进制（如 pkg 打包的 Node.js）也能阻止 CMD 窗口弹出。
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// CREATE_NO_WINDOW: 如果进程没有控制台，不创建新控制台窗口。
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// CREATE_NEW_PROCESS_GROUP: 创建新进程组，避免子进程继承父进程的 Ctrl+C 信号。
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// 自定义子进程包装，提供 kill 能力。
pub struct ManagedChild {
    child: Mutex<std::process::Child>,
}

impl ManagedChild {
    pub fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());

        // Windows release 模式下 sidecar 以 CREATE_NEW_PROCESS_GROUP 启动，
        // std::process::Child::kill() 只调用 TerminateProcess 杀单进程，
        // 无法清理子进程树（pkg 打包的 Node.js 可能 spawn 了子进程）。
        // 使用 taskkill /F /T /PID 可杀整个进程树。
        #[cfg(target_os = "windows")]
        {
            let pid = child.id();
            let out = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            match out {
                Ok(o) if o.status.success() => return Ok(()),
                Ok(o) => {
                    // taskkill 失败（进程可能已退出），尝试 TerminateProcess 兜底
                    eprintln!(
                        "[stop_proxy] taskkill 失败: {}, 尝试 TerminateProcess",
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                }
                Err(e) => {
                    eprintln!(
                        "[stop_proxy] taskkill 执行失败: {}, 尝试 TerminateProcess",
                        e
                    );
                }
            }
        }

        child.kill().map_err(|e| format!("停止失败: {}", e))
    }

    fn try_wait(&self) -> Result<Option<std::process::ExitStatus>, String> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait()
            .map_err(|e| format!("检查进程状态失败: {}", e))
    }
}

#[derive(Default)]
pub struct ProxyState {
    pub child: Mutex<Option<ManagedChild>>,
    /// 占位标志：spawn 是 IO 不能持锁，用它防止 start_proxy 并发时双 spawn（TOCTOU）。
    pub starting: AtomicBool,
    /// 串行化 IDE 配置/注入的还原：stop_proxy 与 Terminated 事件可能并发 restore，
    /// 非原子的读-改-写会互相覆盖，用此锁串行化。
    pub restore_lock: Mutex<()>,
    /// 当前目标 IDE（用于进程退出时的还原）
    pub target_ide: Mutex<String>,
    /// 本轮 sidecar 实际启动时使用的端口；配置热更新后，运行中的进程仍以这里为准。
    ports: Mutex<Option<crate::commands::config::ConfiguredProxyPorts>>,
}

/// 取锁并容忍 poisoning：某线程持锁时 panic 不应让后续所有代理操作永久 panic。
pub fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 还原结果：哪些步骤失败、哪些步骤找不到备份。
#[derive(Serialize, Clone, Default)]
pub struct RestoreReport {
    /// IDE 代理配置还原结果
    pub ide_config: String,
    /// workbench.html 注入还原结果
    pub workbench_inject: String,
    /// Cursor state.vscdb auth/model 恢复结果
    pub cursor_auth: String,
}

impl RestoreReport {
    fn has_warning(&self) -> bool {
        !self.ide_config.starts_with("ok")
            || !self.workbench_inject.starts_with("ok")
            || !self.cursor_auth.starts_with("ok")
    }
}

/// 串行还原 IDE 配置与 workbench 注入（幂等）。
/// 返回还原报告，调用方可据此向用户发出警告。
fn restore_all(state: &ProxyState, target: &str) -> RestoreReport {
    let _guard = lock_or_recover(&state.restore_lock);
    let mut report = RestoreReport::default();

    match crate::commands::ide_config::restore(target) {
        Ok(true) => report.ide_config = "ok".into(),
        Ok(false) => report.ide_config = "未找到备份，IDE 代理配置可能未被还原".into(),
        Err(e) => report.ide_config = format!("还原失败: {}", e),
    }

    if target == "cursor" {
        report.workbench_inject = "ok（Cursor 无需 workbench 注入）".into();
        report.cursor_auth = match crate::commands::cursor_auth::restore_cursor_auth() {
            Ok(true) => "ok".into(),
            Ok(false) => "ok（无需还原）".into(),
            Err(e) => format!("还原失败: {}", e),
        };
    } else {
        report.cursor_auth = "ok（无需 Cursor auth）".into();
        match crate::commands::workbench_inject::restore(target) {
            Ok(true) => report.workbench_inject = "ok".into(),
            Ok(false) => report.workbench_inject = "ok（无需还原）".into(),
            Err(e) => report.workbench_inject = format!("还原失败: {}", e),
        }
    }

    report
}

#[derive(Serialize, Clone)]
pub struct ProxyStatus {
    pub running: bool,
    pub target_ide: String,
    pub api_port: u16,
    pub inference_port: u16,
}

#[derive(Serialize, Clone)]
pub struct LogLine {
    pub level: String,
    pub msg: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPreflightIssue {
    pub level: String,
    pub code: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPreflightReport {
    pub target_ide: String,
    pub ok: bool,
    pub errors: usize,
    pub warnings: usize,
    pub issues: Vec<ProxyPreflightIssue>,
}

/// 体检报告按 8 大类分组（供独立「环境体检」tab 使用）。
/// 分类规则基于 issue.code 前缀：
///   - `path.*` / `ide.*` / `ide_settings.*` / `workbench.*` → 路径
///   - `cert.*` / `certs.*`                                   → 证书
///   - `port.*` / `proxy.health`                              → 端口
///   - `config_dir.*`                                         → 配置
///   - `sidecar.*`                                            → Sidecar
///   - `resources.*`                                          → 资源
///   - `model_map.*` / `ide_models.*`                         → 模型映射
///   - `route.*` / `providers.*`                              → 供应商连通性
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GroupedHealthReport {
    pub target_ide: String,
    pub ok: bool,
    pub generated_at: u64,
    pub totals: HealthTotals,
    pub groups: Vec<HealthGroup>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthTotals {
    pub ok: usize,
    pub warn: usize,
    pub err: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthGroup {
    /// 分类 id（前端 i18n 用）
    pub id: String,
    /// 中文显示名
    pub title: String,
    /// 分类图标 (emoji)
    pub icon: String,
    /// 该分类下所有 issue
    pub issues: Vec<ProxyPreflightIssue>,
    /// 该分类的错误数
    pub errors: usize,
    pub warnings: usize,
    pub oks: usize,
}

fn issue_group_id(code: &str) -> &'static str {
    // 注意顺序：先匹配更具体的前缀，最后兜底到 "other"
    if code.starts_with("cert.") || code.starts_with("certs.") {
        "cert"
    } else if code.starts_with("port.") || code == "proxy.health" {
        "port"
    } else if code.starts_with("sidecar.") {
        "sidecar"
    } else if code.starts_with("resources.") {
        "resources"
    } else if code.starts_with("model_map.") || code.starts_with("ide_models.") {
        "model_map"
    } else if code.starts_with("route.") || code.starts_with("providers.") {
        "providers"
    } else if code.starts_with("config_dir.")
        || code.starts_with("ide_settings.")
        || code.starts_with("workbench.")
        || code.starts_with("ide.")
        || code.starts_with("path.")
    {
        "path"
    } else {
        "other"
    }
}

fn group_meta(id: &str) -> (&'static str, &'static str) {
    match id {
        "path" => ("路径", "📁"),
        "cert" => ("证书", "🔒"),
        "port" => ("端口", "🔌"),
        "sidecar" => ("Sidecar", "⚙️"),
        "resources" => ("资源", "📦"),
        "model_map" => ("模型映射", "🗺️"),
        "providers" => ("供应商连通性", "🌐"),
        _ => ("其他", "❓"),
    }
}

pub fn group_report(report: &ProxyPreflightReport) -> GroupedHealthReport {
    // 用稳定顺序初始化所有分类，避免 UI 渲染闪烁
    let group_order = [
        "path",
        "cert",
        "port",
        "sidecar",
        "resources",
        "model_map",
        "providers",
        "other",
    ];
    let mut groups_map: std::collections::BTreeMap<&str, HealthGroup> =
        std::collections::BTreeMap::new();
    for id in &group_order {
        let (title, icon) = group_meta(id);
        groups_map.insert(
            id,
            HealthGroup {
                id: id.to_string(),
                title: title.to_string(),
                icon: icon.to_string(),
                issues: Vec::new(),
                errors: 0,
                warnings: 0,
                oks: 0,
            },
        );
    }
    for issue in &report.issues {
        let id = issue_group_id(&issue.code);
        let g = groups_map.get_mut(id).expect("group must exist");
        match issue.level.as_str() {
            "err" => g.errors += 1,
            "warn" => g.warnings += 1,
            _ => g.oks += 1,
        }
        g.issues.push(issue.clone());
    }
    let groups: Vec<HealthGroup> = group_order
        .iter()
        .map(|id| groups_map.remove(id).unwrap())
        .collect();
    GroupedHealthReport {
        target_ide: report.target_ide.clone(),
        ok: report.ok,
        generated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        totals: HealthTotals {
            ok: report.issues.iter().filter(|i| i.level == "ok").count(),
            warn: report.warnings,
            err: report.errors,
        },
        groups,
    }
}

fn classify(line: &str) -> String {
    if line.contains('❌')
        || line.contains("Error")
        || line.contains("ERROR")
        || line.contains("[ERR")
    {
        "err".into()
    } else if line.contains('⚠') || line.contains("Warn") || line.contains("WARN") {
        "warn".into()
    } else if line.contains('✅') || line.contains('⚡') || line.contains('→') {
        "ok".into()
    } else {
        "info".into()
    }
}

fn spawn_log_reader<R>(app: AppHandle, pipe: Option<R>)
where
    R: Read + Send + 'static,
{
    let Some(pipe) = pipe else {
        return;
    };
    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines().flatten() {
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                continue;
            }
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: classify(trimmed),
                    msg: trimmed.to_string(),
                },
            );
        }
    });
}

fn resolve_target_ide_arg(target_ide: Option<&str>) -> Result<String, String> {
    match target_ide {
        Some("auto") => {
            let detected = crate::commands::system::detect_target_ide();
            if detected != "windsurf" && detected != "devin" {
                Ok("windsurf".into())
            } else {
                Ok(detected)
            }
        }
        None => {
            if let Some(saved) = crate::commands::config::read_config_value("target_ide") {
                if saved == "windsurf" || saved == "devin" || saved == "cursor" {
                    return Ok(saved);
                }
            }
            let detected = crate::commands::system::detect_target_ide();
            if detected != "windsurf" && detected != "devin" {
                Ok("windsurf".into())
            } else {
                Ok(detected)
            }
        }
        Some(t) if t == "windsurf" || t == "devin" || t == "cursor" => Ok(t.to_string()),
        Some(t) => Err(format!(
            "不支持的目标 IDE: {}（仅 windsurf/devin/cursor/auto）",
            t
        )),
    }
}

fn push_issue(
    issues: &mut Vec<ProxyPreflightIssue>,
    level: &str,
    code: &str,
    message: impl Into<String>,
) {
    issues.push(ProxyPreflightIssue {
        level: level.into(),
        code: code.into(),
        message: message.into(),
    });
}

fn settings_backup_path(settings: &Path) -> PathBuf {
    let mut p = settings.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".into());
    p.set_file_name(format!("{}.byok-bak", name));
    p
}

fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn can_connect_local(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok()
}

fn wait_for_ports(ports: &[u16], timeout: Duration) -> Vec<u16> {
    let deadline = Instant::now() + timeout;
    let mut missing = ports.to_vec();
    while Instant::now() < deadline && !missing.is_empty() {
        missing.retain(|p| !can_connect_local(*p));
        if !missing.is_empty() {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    missing
}

fn configured_ports() -> crate::commands::config::ConfiguredProxyPorts {
    crate::commands::config::configured_proxy_ports()
}

fn active_or_configured_ports(state: &ProxyState) -> crate::commands::config::ConfiguredProxyPorts {
    let ports = *lock_or_recover(&state.ports);
    ports.unwrap_or_else(|| configured_ports())
}

fn unique_proxy_ports(ports: crate::commands::config::ConfiguredProxyPorts) -> Vec<u16> {
    if ports.api_port == ports.inference_port {
        vec![ports.api_port]
    } else {
        vec![ports.api_port, ports.inference_port]
    }
}

fn port_pair_text(ports: crate::commands::config::ConfiguredProxyPorts) -> String {
    format!("{} / {}", ports.api_port, ports.inference_port)
}

#[derive(Debug)]
struct ProxyHealthFailure {
    message: String,
    mitm_related: bool,
}

fn probe_byok_stats(port: u16, timeout: Duration) -> Result<(), ProxyHealthFailure> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| ProxyHealthFailure {
            message: format!("无法连接 {}: {}", port, e),
            mitm_related: false,
        })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(b"GET /__byok/stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| ProxyHealthFailure {
            message: format!("发送健康检查失败: {}", e),
            mitm_related: false,
        })?;
    let mut buf = String::new();
    stream
        .read_to_string(&mut buf)
        .map_err(|e| ProxyHealthFailure {
            message: format!("读取健康检查响应失败: {}", e),
            mitm_related: false,
        })?;
    if !buf.starts_with("HTTP/1.1 200") && !buf.starts_with("HTTP/1.0 200") {
        return Err(ProxyHealthFailure {
            message: format!("{} 有响应，但不是 BYOK 健康检查 200", port),
            mitm_related: false,
        });
    }
    if !buf.contains("\"requests\"") || !buf.contains("\"uptimeSec\"") {
        return Err(ProxyHealthFailure {
            message: format!(
                "{} 有响应，但不像 AnyBridge 代理；可能被其它程序占用",
                port
            ),
            mitm_related: false,
        });
    }
    if !buf.contains("\"mitmEnabled\":true") {
        let detail = buf
            .split_once("\r\n\r\n")
            .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok())
            .and_then(|json| json.get("mitmError").and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or_else(|| "sidecar 未报告 MITM enabled".to_string());
        return Err(ProxyHealthFailure {
            message: format!("{} 端口已监听，但 MITM 未启用: {}", port, detail),
            mitm_related: true,
        });
    }
    Ok(())
}

fn probe_mitm_tls(
    port: u16,
    cert_path: &std::path::Path,
    timeout: Duration,
) -> Result<(), String> {
    let cert_pem = std::fs::read(cert_path)
        .map_err(|e| format!("读取 MITM 证书用于 TLS 探针失败: {}", e))?;
    let root = reqwest::Certificate::from_pem(&cert_pem)
        .map_err(|e| format!("TLS 探针加载 MITM 根证书失败: {}", e))?;
    let proxy = reqwest::Proxy::http(format!("http://127.0.0.1:{}", port))
        .map_err(|e| format!("TLS 探针创建代理失败: {}", e))?;
    let client = reqwest::blocking::Client::builder()
        .proxy(proxy)
        .add_root_certificate(root)
        .tls_built_in_root_certs(false)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("TLS 探针客户端初始化失败: {}", e))?;
    let response = client
        .get("https://server.codeium.com/__byok/mitm-health")
        .send()
        .map_err(|e| format!("CONNECT/TLS 握手失败: {}", e))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("读取 MITM TLS 探针响应失败: {}", e))?;
    let json = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("MITM TLS 探针响应不是 JSON ({}): {}", e, body))?;
    if status != reqwest::StatusCode::OK
        || json.get("ok") != Some(&serde_json::Value::Bool(true))
        || json.get("source").and_then(|v| v.as_str()) != Some("mitm")
        || json.get("upstream").and_then(|v| v.as_str()) != Some("server.codeium.com")
    {
        return Err(format!(
            "TLS 已连接但未进入 MITM: HTTP {} body={}",
            status, body
        ));
    }
    Ok(())
}

fn mitm_tls_failure(message: String) -> ProxyHealthFailure {
    ProxyHealthFailure {
        message,
        mitm_related: true,
    }
}

struct MitmReadyReport {
    message: String,
    admin_prompted: bool,
}

fn ensure_proxy_mitm_ready_once(
    force_regenerate: bool,
    allow_admin: bool,
) -> Result<String, String> {
    let (certs_dir, generated) =
        crate::commands::system::ensure_mitm_certs_ex(force_regenerate)?;
    let cert_path = certs_dir.join("server.codeium.com.pem");
    let key_path = certs_dir.join("server.codeium.com-key.pem");
    crate::commands::system::validate_mitm_cert_files(&cert_path, &key_path)?;
    let install_message = if allow_admin {
        crate::commands::cert_install::install_ca_with_options(
            false,
            force_regenerate || generated,
        )
    } else {
        crate::commands::cert_install::install_ca_user_only(
            false,
            force_regenerate || generated,
        )
    }
    .map_err(|e| {
        if allow_admin {
            format!("MITM CA 管理员安装失败: {}", e)
        } else {
            format!("MITM CA 未能安装到当前用户根证书库: {}", e)
        }
    })?;
    let status = crate::commands::cert_install::check_ca_status();
    if matches!(status.effective_store, crate::commands::cert_install::CaStore::None) {
        return Err(format!(
            "MITM CA 安装后仍未在信任库中找到当前证书指纹。{}",
            install_message
        ));
    }
    Ok(format!(
        "证书目录={}；Thumbprint={}；信任库={:?}",
        certs_dir.to_string_lossy(),
        status.thumbprint.as_deref().unwrap_or("unknown"),
        status.effective_store
    ))
}

fn ensure_proxy_mitm_ready(allow_admin: bool) -> Result<MitmReadyReport, String> {
    match ensure_proxy_mitm_ready_once(false, false) {
        Ok(message) => Ok(MitmReadyReport {
            message,
            admin_prompted: false,
        }),
        Err(first_error) => match ensure_proxy_mitm_ready_once(true, false) {
            Ok(message) => Ok(MitmReadyReport {
                message: format!("自动修复后通过（首次原因: {}）；{}", first_error, message),
                admin_prompted: false,
            }),
            Err(repair_error) if allow_admin => match ensure_proxy_mitm_ready_once(false, true) {
                Ok(message) => Ok(MitmReadyReport {
                    message: format!(
                        "已通过一次管理员授权修复（自动修复原因: {}；重装原因: {}）；{}",
                        first_error, repair_error, message
                    ),
                    admin_prompted: true,
                }),
                Err(admin_error) => Err(format!(
                    "首次自检失败: {}；自动清理并重装失败: {}；管理员安装失败: {}",
                    first_error, repair_error, admin_error
                )),
            },
            Err(repair_error) => Err(format!(
                "首次自检失败: {}；自动清理并重装失败: {}；本次启动已请求过一次管理员授权，不再重复弹窗",
                first_error, repair_error
            )),
        },
    }
}

fn check_provider_route(
    issues: &mut Vec<ProxyPreflightIssue>,
    label: &str,
    provider_id: &str,
    model_override: Option<&str>,
    store: &crate::commands::config::ProviderStore,
) -> bool {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        push_issue(
            issues,
            "err",
            "route.provider_empty",
            format!("「{}」未选择目标供应商", label),
        );
        return false;
    }

    let Some(provider) = store.providers.iter().find(|p| p.id == provider_id) else {
        push_issue(
            issues,
            "err",
            "route.provider_missing",
            format!("「{}」引用了不存在的供应商: {}", label, provider_id),
        );
        return false;
    };

    let mut ok = true;
    if provider.enabled == false {
        push_issue(
            issues,
            "err",
            "route.provider_disabled",
            format!("「{}」引用的供应商「{}」已禁用", label, provider.name),
        );
        ok = false;
    }
    if provider.api_host.trim().is_empty() {
        push_issue(
            issues,
            "err",
            "route.provider_host_empty",
            format!("供应商「{}」未填写 API Host", provider.name),
        );
        ok = false;
    }
    if provider.api_key.trim().is_empty() {
        push_issue(
            issues,
            "err",
            "route.provider_key_empty",
            format!("供应商「{}」未填写 API Key", provider.name),
        );
        ok = false;
    }

    let override_model = model_override.unwrap_or("").trim();
    let effective_model = if override_model.is_empty() {
        provider.default_model.trim()
    } else {
        override_model
    };
    if effective_model.is_empty() {
        push_issue(
            issues,
            "err",
            "route.model_empty",
            format!(
                "「{}」未填写目标模型，请在模型列表里选择明确的上游模型",
                label
            ),
        );
        ok = false;
    }
    ok
}

fn load_cached_ide_model_uids(
    config_dir: &Path,
) -> Result<Option<(HashSet<String>, String, Option<u64>)>, String> {
    let path = config_dir.join("ide-models.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 ide-models.json 失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析 ide-models.json 失败: {}", e))?;
    let source = json
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("captured")
        .to_string();
    let captured_at = json.get("capturedAt").and_then(|v| v.as_u64());
    let mut uids = HashSet::new();
    if let Some(models) = json.get("models").and_then(|v| v.as_array()) {
        for item in models {
            if let Some(uid) = item.get("modelUid").and_then(|v| v.as_str()) {
                if !uid.trim().is_empty() {
                    uids.insert(uid.to_string());
                }
            }
        }
    }
    Ok(Some((uids, source, captured_at)))
}

fn resolve_resources_root(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let dir = resource_dir?;
    if dir.join("byok-cards.js").exists() || dir.join("sidecar").exists() {
        return Some(dir.to_path_buf());
    }
    let nested = dir.join("resources");
    if nested.join("byok-cards.js").exists() || nested.join("sidecar").exists() {
        return Some(nested);
    }
    Some(dir.to_path_buf())
}

fn run_proxy_preflight(
    target_ide: Option<&str>,
    resource_dir: Option<&Path>,
    repair: bool,
) -> Result<ProxyPreflightReport, String> {
    let target = resolve_target_ide_arg(target_ide)?;
    let mut issues = Vec::new();
    let config_dir = crate::commands::config::config_dir_path();
    let resources_root = resolve_resources_root(resource_dir);
    let ports = configured_ports();
    let proxy_value = crate::commands::ide_config::current_proxy_value();
    if ports.api_port == ports.inference_port {
        push_issue(
            &mut issues,
            "err",
            "port.same",
            format!(
                "API 服务端口和推理服务端口不能相同（当前都是 {}）",
                ports.api_port
            ),
        );
    }

    match std::fs::create_dir_all(&config_dir) {
        Ok(()) => {
            let probe = config_dir.join(".byok-write-test");
            match std::fs::write(&probe, b"ok") {
                Ok(()) => {
                    let _ = std::fs::remove_file(&probe);
                }
                Err(e) => push_issue(
                    &mut issues,
                    "err",
                    "config_dir.not_writable",
                    format!("配置目录不可写: {} ({})", config_dir.to_string_lossy(), e),
                ),
            }
        }
        Err(e) => push_issue(
            &mut issues,
            "err",
            "config_dir.create_failed",
            format!("无法创建配置目录: {} ({})", config_dir.to_string_lossy(), e),
        ),
    }

    if let Err(e) = resolve_sidecar_path() {
        push_issue(&mut issues, "err", "sidecar.missing", e);
    }

    let cert_dir = config_dir.join("certs");
    let cert_path = cert_dir.join("server.codeium.com.pem");
    let key_path = cert_dir.join("server.codeium.com-key.pem");
    let san_marker_path = cert_dir.join("san-version");
    let mut cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let mut key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let mut san_ok = std::fs::read_to_string(&san_marker_path)
        .map(|s| s.trim() == crate::commands::system::mitm_cert_san_version())
        .unwrap_or(false);
    let mut cert_contents_ok = cert_ok
        && key_ok
        && crate::commands::system::validate_mitm_cert_files(&cert_path, &key_path).is_ok();
    if !cert_ok || !key_ok || !cert_contents_ok {
        if repair {
            // 只生成 PEM，不走完整 install（避免 UAC 卡启动/体检）
            match crate::commands::system::ensure_mitm_certs() {
                Ok((dir, generated)) => {
                    cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                    key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                    san_ok = std::fs::read_to_string(&san_marker_path)
                        .map(|s| s.trim() == crate::commands::system::mitm_cert_san_version())
                        .unwrap_or(false);
                    cert_contents_ok = cert_ok
                        && key_ok
                        && crate::commands::system::validate_mitm_cert_files(
                            &cert_path,
                            &key_path,
                        )
                        .is_ok();
                    if cert_ok && key_ok && san_ok && cert_contents_ok {
                        let msg = if generated {
                            format!("已自动生成 MITM 证书到 {}", dir.to_string_lossy())
                        } else {
                            format!("MITM 证书已就绪 ({})", dir.to_string_lossy())
                        };
                        push_issue(&mut issues, "ok", "certs.auto_generated", msg);
                    } else {
                        push_issue(
                            &mut issues,
                            "err",
                            "certs.generate_incomplete",
                            "已尝试自动生成 MITM 证书，但证书内容仍无效或文件不完整。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                        );
                    }
                }
                Err(e) => push_issue(
                    &mut issues,
                    "err",
                    "certs.generate_failed",
                    format!(
                        "自动生成 MITM 证书失败: {}。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                        e
                    ),
                ),
            }
        } else {
            push_issue(
                &mut issues,
                "err",
                "certs.missing",
                format!(
                    "MITM 证书缺失、为空或内容无效；点击「安装证书」会自动生成并安装，也可以点击「生成证书」单独生成（文件: {}, {}）",
                    cert_path.to_string_lossy(),
                    key_path.to_string_lossy()
                ),
            );
        }
    } else if !san_ok {
        if repair {
            match crate::commands::system::ensure_mitm_certs_ex(true) {
                Ok((dir, _)) => {
                    san_ok = std::fs::read_to_string(&san_marker_path)
                        .map(|s| s.trim() == crate::commands::system::mitm_cert_san_version())
                        .unwrap_or(false);
                    if san_ok {
                        push_issue(
                            &mut issues,
                            "ok",
                            "certs.san_regenerated",
                            format!("已按当前 SAN 版本重新生成 MITM 证书 ({})", dir.to_string_lossy()),
                        );
                    } else {
                        push_issue(
                            &mut issues,
                            "err",
                            "certs.san_regenerate_failed",
                            "已尝试重新生成 MITM 证书，但 SAN 标记仍不是当前版本。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                        );
                    }
                }
                Err(e) => push_issue(
                    &mut issues,
                    "err",
                    "certs.san_generate_failed",
                    format!(
                        "MITM 证书缺少 Cursor 所需 SAN，且自动重新生成失败: {}。请在「平台 > 设置 > 环境检测」点击「生成证书」",
                        e
                    ),
                ),
            }
        } else {
            push_issue(
                &mut issues,
                "warn",
                "certs.san_outdated",
                "MITM 证书缺少 Cursor 所需 SAN；点击「生成证书」或「安装证书」会重新生成。",
            );
        }
    }

    // 证书信任状态检查（升级路径：用户在装了 BYOK 但没装证书的机器上会卡这里）
    // repair=true 时只做「用户级静默安装」，绝不弹 UAC。
    // 需要管理员安装时，留给用户在「环境检测」点「安装证书」。
    let mut ca_status = crate::commands::cert_install::check_ca_status();
    if repair {
        if matches!(
            ca_status.effective_store,
            crate::commands::cert_install::CaStore::None
        ) && (ca_status.cert_exists || cert_ok)
        {
            match crate::commands::cert_install::install_ca_user_only(false, false) {
                Ok(msg) => {
                    ca_status = crate::commands::cert_install::check_ca_status();
                    if !matches!(
                        ca_status.effective_store,
                        crate::commands::cert_install::CaStore::None
                    ) {
                        push_issue(
                            &mut issues,
                            "ok",
                            "cert.auto_installed",
                            format!("已自动安装 CA 到用户信任库。{}", msg),
                        );
                    } else {
                        push_issue(
                            &mut issues,
                            "err",
                            "cert.auto_install_incomplete",
                            format!(
                                "已尝试静默安装 CA，但用户信任库仍未找到当前指纹。请点「安装证书」（可能需要管理员）。{}",
                                msg
                            ),
                        );
                    }
                }
                Err(e) => push_issue(
                    &mut issues,
                    "err",
                    "cert.auto_install_failed",
                    format!(
                        "自动静默安装 CA 失败: {}。请在「平台 > 设置 > 环境检测」点「安装证书」或「清理并重装」",
                        e
                    ),
                ),
            }
        }
        if ca_status.legacy_residual {
            match crate::commands::cert_install::cleanup_legacy_cn() {
                Ok(msg) => {
                    ca_status = crate::commands::cert_install::check_ca_status();
                    if !ca_status.legacy_residual {
                        push_issue(
                            &mut issues,
                            "ok",
                            "cert.legacy_cleaned",
                            format!("已自动清理老版本 CA 残留。{}", msg),
                        );
                    } else {
                        push_issue(
                            &mut issues,
                            "warn",
                            "cert.legacy_cleanup_partial",
                            format!(
                                "已尝试清理老证书，但仍有残留（可能需要管理员权限）: {}",
                                msg
                            ),
                        );
                    }
                }
                Err(e) => push_issue(
                    &mut issues,
                    "warn",
                    "cert.legacy_cleanup_failed",
                    format!("自动清理老证书失败: {}", e),
                ),
            }
        }
    }
    match ca_status.effective_store {
        crate::commands::cert_install::CaStore::CurrentUser => {
            push_issue(
                &mut issues,
                "ok",
                "cert.trust_current_user",
                format!(
                    "当前 CA 证书已装到 CurrentUser\\Root（无需管理员权限）。{}",
                    ca_status
                        .thumbprint
                        .as_deref()
                        .map(|t| format!("Thumbprint: {}", t))
                        .unwrap_or_default()
                ),
            );
        }
        crate::commands::cert_install::CaStore::LocalMachine => {
            push_issue(
                &mut issues,
                "ok",
                "cert.trust_local_machine",
                format!(
                    "当前 CA 证书已装到 LocalMachine\\Root（系统级）。{}",
                    ca_status
                        .thumbprint
                        .as_deref()
                        .map(|t| format!("Thumbprint: {}", t))
                        .unwrap_or_default()
                ),
            );
        }
        crate::commands::cert_install::CaStore::None => {
            // 证书文件存在但没装到系统 → 提示用户一键安装（无管理员弹窗或 UAC 一次）
            if ca_status.cert_exists {
                push_issue(
                    &mut issues,
                    "err",
                    "cert.not_trusted",
                    "当前 CA 证书已生成但未安装到系统根证书库。点「安装证书」可装到 CurrentUser\\Root（无需管理员），失败才弹 UAC；若仍异常请点「清理并重装」".to_string(),
                );
            }
            // cert_exists=false 已经在上面 certs.missing 提示过了
        }
    }
    if ca_status.legacy_residual {
        push_issue(
            &mut issues,
            "warn",
            "cert.legacy_residual",
            format!(
                "检测到老版本 CA \"{}\" 残留。建议点「清理老证书」或「清理并重装」",
                crate::commands::system::LEGACY_CA_COMMON_NAMES.join("\" / \"")
            ),
        );
    }

    let ide_label = match target.as_str() {
        "devin" => "Devin",
        "cursor" => "Cursor",
        _ => "Windsurf",
    };
    let ide_exe_path = crate::commands::system::detect_ide_path(Some(target.clone()));
    let settings_display = crate::commands::ide_config::settings_path(&target)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "未定位".into());
    push_issue(
        &mut issues,
        "ok",
        "ide.target",
        format!(
            "目标 IDE: {}；配置文件: {}；程序路径: {}",
            ide_label,
            settings_display,
            ide_exe_path.clone().unwrap_or_else(|| "未定位".into())
        ),
    );
    if target != "cursor" {
        let other_target = if target == "devin" {
            "windsurf"
        } else {
            "devin"
        };
        let other_label = if other_target == "devin" {
            "Devin"
        } else {
            "Windsurf"
        };
        if !crate::commands::system::is_ide_running(target.clone())
            && crate::commands::system::is_ide_running(other_target.into())
        {
            push_issue(
                &mut issues,
                "warn",
                "ide.target_mismatch",
                format!(
                    "当前选择的是 {}，但检测到正在运行的是 {}。如果你实际使用 {}，请先切换顶部 IDE 选择器再启动代理",
                    ide_label, other_label, other_label
                ),
            );
        }
    }

    let settings_candidate = match crate::commands::ide_config::settings_path(&target) {
        Some(settings) if settings.exists() => Some(settings),
        Some(settings) if repair => {
            if ide_exe_path.is_some() {
                match crate::commands::ide_config::ensure_settings_file(&target) {
                    Ok((path, true)) => {
                        push_issue(
                            &mut issues,
                            "ok",
                            "ide_settings.auto_created",
                            format!(
                                "已自动创建 {} settings.json: {}",
                                ide_label,
                                path.to_string_lossy()
                            ),
                        );
                        Some(path)
                    }
                    Ok((path, false)) => Some(path),
                    Err(e) => {
                        push_issue(
                            &mut issues,
                            "err",
                            "ide_settings.create_failed",
                            format!("自动创建 {} settings.json 失败: {}", ide_label, e),
                        );
                        Some(settings)
                    }
                }
            } else {
                Some(settings)
            }
        }
        other => other,
    };
    match settings_candidate {
        Some(settings) if settings.exists() => {
            if settings
                .metadata()
                .map(|m| m.permissions().readonly())
                .unwrap_or(false)
            {
                push_issue(
                    &mut issues,
                    "err",
                    "ide_settings.readonly",
                    format!("{} settings.json 是只读文件，无法写入代理配置", ide_label),
                );
            }
            match std::fs::read_to_string(&settings) {
                Ok(raw) => match crate::commands::ide_config::parse_object(&raw) {
                    Ok(obj) => {
                        let proxy = obj.get("http.proxy").and_then(|v| v.as_str()).unwrap_or("");
                        let strict_ssl = obj.get("http.proxyStrictSSL");
                        if !proxy.is_empty() && !crate::commands::ide_config::is_current_proxy_value(proxy) {
                            push_issue(
                                &mut issues,
                                "warn",
                                "ide_settings.other_proxy",
                                format!(
                                    "{} 当前已有 http.proxy={}，切换到代理时会备份并改写为 AnyBridge 代理（{}）",
                                    ide_label, proxy, proxy_value
                                ),
                            );
                        }
                        if crate::commands::ide_config::is_current_proxy_value(proxy)
                            && strict_ssl != Some(&serde_json::Value::Bool(false))
                        {
                            if repair {
                                match crate::commands::ide_config::patch(&target) {
                                    Ok(_) => push_issue(
                                        &mut issues,
                                        "ok",
                                        "ide_settings.strict_ssl_fixed",
                                        format!("已自动修正 {} http.proxyStrictSSL 为 false", ide_label),
                                    ),
                                    Err(e) => push_issue(
                                        &mut issues,
                                        "err",
                                        "ide_settings.strict_ssl_fix_failed",
                                        format!("自动修正 {} http.proxyStrictSSL 失败: {}", ide_label, e),
                                    ),
                                }
                            } else {
                                push_issue(
                                    &mut issues,
                                    "warn",
                                    "ide_settings.strict_ssl",
                                    format!(
                                        "{} 已指向 AnyBridge 代理，但 http.proxyStrictSSL 不是 false，切换到代理时会修正",
                                        ide_label
                                    ),
                                );
                            }
                        }
                        let backup = settings_backup_path(&settings);
                        if backup.exists() && !crate::commands::ide_config::is_current_proxy_value(proxy) {
                            push_issue(
                                &mut issues,
                                "warn",
                                "ide_settings.backup_exists",
                                format!(
                                    "{} 存在旧备份文件，将沿用它做还原直连时的还原基准",
                                    backup.to_string_lossy()
                                ),
                            );
                        }
                    }
                    Err(e) => push_issue(
                        &mut issues,
                        "err",
                        "ide_settings.parse_failed",
                        format!("{} settings.json 解析失败: {}", ide_label, e),
                    ),
                },
                Err(e) => push_issue(
                    &mut issues,
                    "err",
                    "ide_settings.read_failed",
                    format!("读取 {} settings.json 失败: {}", ide_label, e),
                ),
            }
        }
        Some(settings) => push_issue(
            &mut issues,
            "err",
            "ide_settings.missing",
            format!(
                "未找到 {} settings.json: {}。请先启动一次 {}，或在「平台 > 设置」手动指定 IDE 路径后再切换到代理",
                ide_label,
                settings.to_string_lossy(),
                ide_label
            ),
        ),
        None => push_issue(
            &mut issues,
            "err",
            "ide_settings.path_failed",
            format!("无法定位 {} 配置目录", ide_label),
        ),
    }

    if crate::commands::system::is_ide_running(target.clone()) {
        push_issue(
            &mut issues,
            "warn",
            "ide.running",
            format!(
                "{} 正在运行；启动后必须重启 IDE 才能加载代理配置和模型改写",
                ide_label
            ),
        );
    }

    if target == "cursor" {
        match crate::commands::cursor_auth::cursor_state_db_path() {
            Some(path) if path.exists() => push_issue(
                &mut issues,
                "ok",
                "cursor.state_db",
                format!("Cursor state.vscdb 已定位: {}", path.to_string_lossy()),
            ),
            Some(path) => push_issue(
                &mut issues,
                "err",
                "cursor.state_db_missing",
                format!(
                    "未找到 Cursor state.vscdb: {}。请先启动一次 Cursor 到主界面后再切换",
                    path.to_string_lossy()
                ),
            ),
            None => push_issue(
                &mut issues,
                "err",
                "cursor.state_db_path_failed",
                "无法定位 Cursor state.vscdb 路径",
            ),
        }
        match crate::commands::cursor_auth::first_cursor_model_stable_id() {
            Ok(model) => push_issue(
                &mut issues,
                "ok",
                "cursor.model_pin",
                format!("Cursor 默认 BYOK 模型可写入: {}", model),
            ),
            Err(e) => push_issue(&mut issues, "err", "cursor.model_pin_failed", e),
        }
        push_issue(
            &mut issues,
            "ok",
            "workbench.skipped",
            "Cursor 接入不需要 workbench.html 模型卡片注入",
        );
    } else {
        match crate::commands::workbench_inject::workbench_html_path(&target) {
            Some(path) => {
                if std::fs::OpenOptions::new().write(true).open(&path).is_err() {
                    push_issue(
                        &mut issues,
                        "warn",
                        "workbench.not_writable",
                        format!(
                            "无法写入 workbench.html，模型卡片视觉改写可能失败: {}",
                            path.to_string_lossy()
                        ),
                    );
                }
            }
            None => push_issue(
                &mut issues,
                "warn",
                "workbench.missing",
                format!(
                    "未定位到 {} workbench.html，模型卡片视觉改写脚本可能无法注入",
                    ide_label
                ),
            ),
        }

        if let Some(res) = resources_root.as_deref() {
            let script = res.join("byok-cards.js");
            if !script.exists() {
                push_issue(
                    &mut issues,
                    "warn",
                    "resources.cards_missing",
                    format!("未找到 byok-cards.js 资源: {}", script.to_string_lossy()),
                );
            }
        }
    }

    let store = match crate::commands::config::read_provider_store() {
        Ok(store) => store,
        Err(e) => {
            push_issue(
                &mut issues,
                "err",
                "providers.read_failed",
                format!("读取供应商配置失败: {}", e),
            );
            crate::commands::config::ProviderStore::default()
        }
    };
    if store.providers.is_empty() {
        push_issue(
            &mut issues,
            "err",
            "providers.empty",
            "尚未配置任何供应商，代理没有可路由的 BYOK 目标",
        );
    }

    let map = match crate::commands::model_map::read_map() {
        Ok(map) => map,
        Err(e) => {
            push_issue(
                &mut issues,
                "err",
                "model_map.read_failed",
                format!("读取模型映射失败: {}", e),
            );
            crate::commands::model_map::ModelMap::default()
        }
    };

    let mut seen_uids = HashSet::new();
    let mut routed_count = 0usize;
    let name_prefix = map.name_prefix.trim();

    for slot in &map.slots {
        let uid = slot.model_uid.trim();
        let label = if slot.display_name.trim().is_empty() {
            uid.to_string()
        } else {
            slot.display_name.trim().to_string()
        };
        if uid.is_empty() {
            push_issue(
                &mut issues,
                "err",
                "model_map.slot_uid_empty",
                "存在空 modelUid 的映射槽位",
            );
            continue;
        }
        if !seen_uids.insert(uid.to_string()) {
            push_issue(
                &mut issues,
                "err",
                "model_map.uid_duplicate",
                format!("modelUid 重复: {}", uid),
            );
        }
        if !slot.enabled {
            continue;
        }
        if slot.targets.is_empty() {
            push_issue(
                &mut issues,
                "err",
                "model_map.slot_target_empty",
                format!("「{}」已启用但未配置目标供应商", label),
            );
            continue;
        }
        if slot.display_name.trim().is_empty() && name_prefix.is_empty() {
            push_issue(
                &mut issues,
                "warn",
                "model_map.slot_no_visible_name",
                format!(
                    "「{}」未设置显示名或全局前缀，IDE 下拉框仍会显示原始 Windsurf 名称",
                    uid
                ),
            );
        }
        for target in &slot.targets {
            if check_provider_route(
                &mut issues,
                &label,
                &target.provider_id,
                Some(&target.model),
                &store,
            ) {
                routed_count += 1;
            }
        }
    }

    for inj in &map.injected {
        let uid = inj.model_uid.trim();
        if uid.is_empty() {
            push_issue(
                &mut issues,
                "err",
                "model_map.inject_uid_empty",
                "存在空 modelUid 的模型槽位",
            );
            continue;
        }
        if !seen_uids.insert(uid.to_string()) {
            push_issue(
                &mut issues,
                "err",
                "model_map.uid_duplicate",
                format!("modelUid 重复: {}", uid),
            );
        }

        let provider_id = inj.provider_id.as_deref().unwrap_or("").trim();
        if provider_id.is_empty() {
            push_issue(
                &mut issues,
                "warn",
                "model_map.inject_unconfigured",
                format!(
                    "模型槽位「{}」尚未配置供应商，可能会显示但无法调用",
                    inj.label
                ),
            );
            continue;
        }
        if inj.model.as_deref().unwrap_or("").trim().is_empty() {
            push_issue(
                &mut issues,
                "err",
                "model_map.inject_model_empty",
                format!("模型槽位「{}」已选供应商但 model 为空", inj.label),
            );
        }
        if check_provider_route(
            &mut issues,
            &format!("模型槽位「{}」", inj.label),
            provider_id,
            inj.model.as_deref(),
            &store,
        ) {
            routed_count += 1;
        }
    }

    if routed_count == 0 {
        push_issue(
            &mut issues,
            "err",
            "model_map.no_route",
            "没有任何可用模型：请至少给一个启用槽位配置供应商和目标模型",
        );
    }

    match load_cached_ide_model_uids(&config_dir) {
        Ok(Some((cached_uids, source, captured_at))) => {
            if cached_uids.is_empty() {
                push_issue(
                    &mut issues,
                    "warn",
                    "ide_models.empty_cache",
                    "ide-models.json 里没有模型条目，无法判断映射槽位是否会出现在 IDE 下拉框",
                );
            } else {
                if source != "captured" {
                    push_issue(
                        &mut issues,
                        "warn",
                        "ide_models.not_proxy_captured",
                        format!(
                            "ide-models.json 来源为 {}，不一定等于 IDE 实际下拉框；如模型不可见，请启动代理后重启 IDE 并打开一次模型选择器",
                            source
                        ),
                    );
                }
                if let Some(ts) = captured_at {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if now.saturating_sub(ts) > 7 * 24 * 60 * 60 * 1000 {
                        push_issue(
                            &mut issues,
                            "warn",
                            "ide_models.stale_cache",
                            "最近抓取的 IDE 模型清单已超过 7 天，建议启动代理后重启 IDE 重新抓取",
                        );
                    }
                }
                for slot in map
                    .slots
                    .iter()
                    .filter(|s| s.enabled && !s.targets.is_empty())
                {
                    if !cached_uids.contains(&slot.model_uid) {
                        push_issue(
                            &mut issues,
                            "warn",
                            "ide_models.slot_not_seen",
                            format!(
                                "最近抓到的 IDE 模型清单里没有「{}」，这个映射可能不会出现在下拉框",
                                slot.model_uid
                            ),
                        );
                    }
                }
                for inj in map
                    .injected
                    .iter()
                    .filter(|i| i.provider_id.as_deref().unwrap_or("").trim().len() > 0)
                {
                    if !cached_uids.contains(&inj.model_uid) {
                        push_issue(
                            &mut issues,
                            "warn",
                            "ide_models.inject_not_seen",
                            format!(
                                "最近抓到的 IDE 模型清单里没有模型槽位「{}」({})，可能需要先更新/重新抓取 IDE 模型列表",
                                inj.label, inj.model_uid
                            ),
                        );
                    }
                }
            }
        }
        Ok(None) => push_issue(
            &mut issues,
            "warn",
            "ide_models.cache_missing",
            "尚未抓取 IDE 模型清单；首次启动后请重启 IDE 并打开模型选择器，代理会记录真实可见模型",
        ),
        Err(e) => push_issue(&mut issues, "warn", "ide_models.cache_read_failed", e),
    }

    for port in unique_proxy_ports(ports) {
        if !is_port_free(port) {
            if repair {
                kill_sidecar_process();
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            if !is_port_free(port) {
                push_issue(
                    &mut issues,
                    if repair { "err" } else { "warn" },
                    "port.occupied",
                    format!(
                        "端口 {} 已被占用，自动回收旧代理后仍不可用；请关闭占用该端口的进程后重试",
                        port
                    ),
                );
            } else {
                push_issue(
                    &mut issues,
                    "ok",
                    "port.recovered",
                    format!("端口 {} 已自动回收并恢复可用", port),
                );
            }
        }
    }

    let errors = issues.iter().filter(|i| i.level == "err").count();
    let warnings = issues.iter().filter(|i| i.level == "warn").count();
    Ok(ProxyPreflightReport {
        target_ide: target,
        ok: errors == 0,
        errors,
        warnings,
        issues,
    })
}

#[allow(dead_code)]
fn emit_preflight_report(app: &AppHandle, report: &ProxyPreflightReport) {
    if report.ok {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: format!(
                    "✅ 启动自检通过（目标: {}，警告: {}）",
                    report.target_ide, report.warnings
                ),
            },
        );
    }
    for issue in &report.issues {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: issue.level.clone(),
                msg: format!("启动自检: {}", issue.message),
            },
        );
    }
}

pub fn preflight_proxy_impl(
    app: AppHandle,
    target_ide: Option<String>,
) -> Result<ProxyPreflightReport, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));
    let proxy_running = app
        .try_state::<ProxyState>()
        .and_then(|state| {
            lock_or_recover(&state.child)
                .as_ref()
                .map(|managed| managed.try_wait().ok().flatten().is_none())
        })
        .unwrap_or(false);
    run_proxy_preflight(
        target_ide.as_deref(),
        resource_dir.as_deref(),
        !proxy_running,
    )
}

#[tauri::command]
pub async fn preflight_proxy(
    app: AppHandle,
    target_ide: Option<String>,
) -> Result<ProxyPreflightReport, String> {
    tauri::async_runtime::spawn_blocking(move || preflight_proxy_impl(app, target_ide))
        .await
        .map_err(|e| format!("启动自检任务失败: {}", e))?
}

/// 环境体检（带分组）— 供独立「环境体检」tab 使用。
/// 复用 preflight_proxy_impl 的检查逻辑，结果按 8 大类分组，方便 UI 卡片化展示。
#[tauri::command]
pub async fn healthcheck_grouped(
    app: AppHandle,
    target_ide: Option<String>,
) -> Result<GroupedHealthReport, String> {
    // 体检本身可能多次调 certutil；必须离 runtime 线程，并设总超时，避免 UI 永久 pending。
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let report = preflight_proxy_impl(app, target_ide)?;
        Ok::<GroupedHealthReport, String>(group_report(&report))
    });
    match tokio::time::timeout(std::time::Duration::from_secs(90), handle).await {
        Ok(join) => join.map_err(|e| format!("环境检测任务失败: {}", e))?,
        Err(_) => Err(
            "环境检测超时（90s）。可能 certutil/证书操作被杀软拦截。请重试，或到「环境检测」单独点「安装证书」"
                .into(),
        ),
    }
}

/// 解析 sidecar 二进制路径。
/// 与 tauri_plugin_shell 的 relative_command_path 逻辑一致：
/// 基于 current_exe 所在目录查找，文件名不带 target triple 后缀
/// （Tauri 构建脚本会自动将 binaries/ 下带后缀的文件重命名后复制到 exe 旁边）。
fn current_target_triple() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("x86_64-pc-windows-msvc");
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some("aarch64-pc-windows-msvc");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("x86_64-apple-darwin");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("aarch64-apple-darwin");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some("x86_64-unknown-linux-gnu");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some("aarch64-unknown-linux-gnu");
    }
    #[allow(unreachable_code)]
    None
}

fn sidecar_file_candidates() -> Vec<String> {
    let exe_suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let mut files = vec![
        format!("anybridge-proxy{}", exe_suffix),
        format!("ide-byok-proxy{}", exe_suffix),
    ];
    if let Some(triple) = current_target_triple() {
        files.push(format!("anybridge-proxy-{}{}", triple, exe_suffix));
        files.push(format!("ide-byok-proxy-{}{}", triple, exe_suffix));
    }
    files
}

fn resolve_sidecar_path() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("当前 exe 路径无父目录")?;

    // 测试模式下 exe 在 deps/ 子目录，需要上一级
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };

    let sidecar_files = sidecar_file_candidates();
    for sidecar_file in sidecar_files {
        let path = base_dir.join(&sidecar_file);
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "sidecar 二进制不存在: {}",
        base_dir
            .join(&sidecar_file_candidates()[0])
            .to_string_lossy()
    ))
}

#[tauri::command]
pub fn get_proxy_status(state: State<ProxyState>) -> ProxyStatus {
    let mut running = false;
    {
        let guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            // child 存在但进程可能已退出（监控线程尚未清理），用 try_wait 确认
            running = managed.try_wait().ok().flatten().is_none();
        }
    }
    let target_ide = if running {
        lock_or_recover(&state.target_ide).clone()
    } else {
        String::new()
    };
    let ports = if running {
        active_or_configured_ports(&state)
    } else {
        configured_ports()
    };
    ProxyStatus {
        running,
        target_ide,
        api_port: ports.api_port,
        inference_port: ports.inference_port,
    }
}

#[allow(dead_code)]
pub fn start_proxy_impl(
    app: AppHandle,
    target_ide: Option<String>,
    skip_preflight: bool,
) -> Result<bool, String> {
    let state = app.state::<ProxyState>();

    // TOCTOU 防护：检查"已运行 / 正在启动",并在同一临界区抢占 starting 标志。
    // 注意：child 存在不代表进程还活着，需 try_wait 确认（进程意外退出但监控线程尚未清理时）。
    {
        let guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            if managed.try_wait().ok().flatten().is_none() {
                // 进程仍在运行
                return Err("代理已在运行".into());
            }
            // 进程已退出但 child 未清理，先清理再允许启动
            drop(guard);
            *lock_or_recover(&state.child) = None;
        }
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("代理正在启动中".into());
        }
    }
    let clear_starting = || state.starting.store(false, Ordering::SeqCst);

    // 解析目标 IDE（auto 模式需实际检测），校验只允许 windsurf/devin。
    let target = match resolve_target_ide_arg(target_ide.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            clear_starting();
            return Err(e);
        }
    };

    let config_dir = crate::commands::config::config_dir_path();
    let ports = configured_ports();

    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));

    // 再清一次孤儿 sidecar，处理上一轮异常退出但主应用仍在的情况。
    kill_sidecar_process();

    if !skip_preflight {
        let preflight = match run_proxy_preflight(Some(&target), resource_dir.as_deref(), true) {
            Ok(r) => r,
            Err(e) => {
                clear_starting();
                return Err(e);
            }
        };
        emit_preflight_report(&app, &preflight);
        if !preflight.ok {
            clear_starting();
            let first = preflight
                .issues
                .iter()
                .find(|i| i.level == "err")
                .map(|i| i.message.clone())
                .unwrap_or_else(|| "存在启动自检错误".into());
            return Err(format!("启动自检未通过: {}", first));
        }
    }

    // 解析 sidecar 启动方式
    // dev 模式 (debug_assertions): 直接 node 跑源码 sidecar,改 js 立即生效,免去每次打包 exe
    // release 模式: spawn pkg 打包的 anybridge-proxy.exe
    let mut cmd = {
        #[cfg(debug_assertions)]
        {
            let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let sidecar_dir = manifest_dir.parent().unwrap().join("sidecar");
            if !sidecar_dir.join("proxy-entry.js").exists() {
                clear_starting();
                return Err(format!(
                    "dev 模式找不到 sidecar 源码: {}",
                    sidecar_dir.display()
                ));
            }
            let mut c = std::process::Command::new("node");
            c.current_dir(&sidecar_dir);
            c.arg("proxy-entry.js");
            // Windows: 设置进程创建标志，阻止 CMD 窗口弹出
            #[cfg(target_os = "windows")]
            c.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            c
        }
        #[cfg(not(debug_assertions))]
        {
            let sidecar_path = match resolve_sidecar_path() {
                Ok(p) => p,
                Err(e) => {
                    clear_starting();
                    return Err(e);
                }
            };
            let mut c = std::process::Command::new(&sidecar_path);
            // Windows: 设置进程创建标志，阻止 CMD 窗口弹出
            #[cfg(target_os = "windows")]
            c.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            c
        }
    };

    cmd.env("BYOK_CONFIG_DIR", config_dir.to_string_lossy().to_string());
    cmd.env("API_PORT", ports.api_port.to_string());
    cmd.env("INFERENCE_PORT", ports.inference_port.to_string());
    if let Some(res) = &resource_dir {
        cmd.env("BYOK_RESOURCE_DIR", res.to_string_lossy().to_string());
    }

    // 捕获 stdout/stderr 用于日志转发
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            clear_starting();
            return Err(format!("启动失败: {}", e));
        }
    };

    // 在写入 state 之前取出管道（避免锁竞争）
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 写入 child 并清除 starting 标志
    *lock_or_recover(&state.child) = Some(ManagedChild {
        child: Mutex::new(child),
    });
    *lock_or_recover(&state.target_ide) = target.clone();
    *lock_or_recover(&state.ports) = Some(ports);
    clear_starting();

    // 打补丁：写入 IDE 代理配置（失败不阻断代理启动，仅记日志）。
    let ide_label = if target_ide.as_deref() == Some("auto") {
        format!("自动检测→{}", target)
    } else {
        target.clone()
    };
    let patched = match crate::commands::ide_config::patch(&target) {
        Ok(true) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "ok".into(),
                    msg: format!("✅ 已写入 {} 代理配置，请重启 IDE 生效", ide_label),
                },
            );
            true
        }
        Ok(false) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "info".into(),
                    msg: format!(
                        "{} 代理配置已存在，若模型仍是原样请重启 IDE 并确认当前目标 IDE 正确",
                        ide_label
                    ),
                },
            );
            false
        }
        Err(e) => {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("⚠ 写入 {} 配置失败: {}", ide_label, e),
                },
            );
            false
        }
    };

    // 注入卡片改写脚本到 workbench.html（失败不阻断代理启动，仅记日志）。
    if target == "cursor" {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "info".into(),
                msg: "Cursor 接入不需要 workbench.html 模型卡片注入".into(),
            },
        );
    } else if let Some(res) = &resource_dir {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "info".into(),
                msg: format!(
                    "代理配置目录: {}；资源目录: {}",
                    config_dir.to_string_lossy(),
                    res.to_string_lossy()
                ),
            },
        );
        let script_path = res.join("byok-cards.js");
        match std::fs::read_to_string(&script_path) {
            Ok(script) => match crate::commands::workbench_inject::inject(&script, &target) {
                Ok(true) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "ok".into(),
                            msg: format!("✅ 已注入模型卡片改写脚本，请重启 {} 生效", ide_label),
                        },
                    );
                }
                Ok(false) => {}
                Err(e) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "warn".into(),
                            msg: format!("⚠ 注入卡片脚本失败: {}", e),
                        },
                    );
                }
            },
            Err(e) => {
                let _ = app.emit(
                    "proxy-log",
                    LogLine {
                        level: "warn".into(),
                        msg: format!("⚠ 读取 byok-cards.js 失败: {}", e),
                    },
                );
            }
        }
    }

    // stdout/stderr 必须并行读取。sidecar 长期运行，stdout 不会 EOF；
    // 若串行读取，stderr 管道填满后会反向阻塞代理进程。
    spawn_log_reader(app.clone(), stdout);
    spawn_log_reader(app.clone(), stderr);

    // 启动监控线程：轮询进程退出状态
    let app_handle2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));

        let exited = if let Some(state) = app_handle2.try_state::<ProxyState>() {
            let guard = lock_or_recover(&state.child);
            match guard.as_ref() {
                Some(managed) => managed.try_wait().ok().flatten().is_some(),
                // child 为 None 说明 stop_proxy 已 take 走了 child 并负责清理，
                // 这里直接退出循环，不再误判为进程退出。
                None => {
                    break;
                }
            }
        } else {
            break;
        };

        if exited {
            // 进程真正退出后的清理
            if let Some(state) = app_handle2.try_state::<ProxyState>() {
                *lock_or_recover(&state.child) = None;
                let target = lock_or_recover(&state.target_ide).clone();
                // 清除 target_ide
                *lock_or_recover(&state.target_ide) = String::new();
                *lock_or_recover(&state.ports) = None;
                if target.is_empty()
                    || (target != "windsurf" && target != "devin" && target != "cursor")
                {
                    eprintln!("[monitor] target_ide 异常: '{}', 跳过还原", target);
                } else {
                    let report = restore_all(&state, &target);
                    if report.has_warning() {
                        let mut warnings = Vec::new();
                        if !report.ide_config.starts_with("ok") {
                            warnings.push(report.ide_config.clone());
                        }
                        if !report.workbench_inject.starts_with("ok") {
                            warnings.push(report.workbench_inject.clone());
                        }
                        if !report.cursor_auth.starts_with("ok") {
                            warnings.push(report.cursor_auth.clone());
                        }
                        let _ = app_handle2.emit(
                            "proxy-log",
                            LogLine {
                                level: "warn".into(),
                                msg: format!("⚠ 还原警告: {}", warnings.join("；")),
                            },
                        );
                    }
                }
            }
            let _ = app_handle2.emit("proxy-stopped", ());
            break;
        }
    });

    let expected_ports = unique_proxy_ports(ports);
    let missing_ports = wait_for_ports(&expected_ports, Duration::from_secs(5));
    let health_error = if missing_ports.contains(&ports.api_port) {
        Some(format!(
            "代理主端口 {} 未监听，IDE 无法接入 AnyBridge 代理",
            ports.api_port
        ))
    } else {
        probe_byok_stats(ports.api_port, Duration::from_secs(2))
            .map_err(|failure| failure.message)
            .err()
    };

    if let Some(e) = health_error {
        let child = lock_or_recover(&state.child).take();
        if let Some(child) = child {
            let _ = child.kill();
        }
        let report = restore_all(&state, &target);
        *lock_or_recover(&state.target_ide) = String::new();
        *lock_or_recover(&state.ports) = None;
        let _ = app.emit("proxy-stopped", ());
        let mut msg = format!("代理启动失败: {}", e);
        if report.has_warning() {
            msg.push_str(&format!(
                "；自动回滚时有警告: IDE配置={}, 卡片注入={}, Cursor状态={}",
                report.ide_config, report.workbench_inject, report.cursor_auth
            ));
        }
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "err".into(),
                msg: msg.clone(),
            },
        );
        return Err(msg);
    }

    if missing_ports.is_empty() {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: format!("✅ 代理健康检查通过: {}", port_pair_text(ports)),
            },
        );
    } else {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "warn".into(),
                msg: format!(
                    "⚠ 代理主服务已就绪，但以下辅助端口暂未监听: {}",
                    missing_ports
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            },
        );
    }

    Ok(patched)
}

pub fn start_proxy_service_impl(app: AppHandle) -> Result<bool, String> {
    start_proxy_service_impl_with_repair(app, true, false)
}

fn start_proxy_service_impl_with_repair(
    app: AppHandle,
    allow_runtime_repair: bool,
    admin_already_prompted: bool,
) -> Result<bool, String> {
    let state = app.state::<ProxyState>();

    {
        let guard = lock_or_recover(&state.child);
        if let Some(managed) = guard.as_ref() {
            if managed.try_wait().ok().flatten().is_none() {
                return Err("代理已在运行".into());
            }
            drop(guard);
            *lock_or_recover(&state.child) = None;
        }
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("代理正在启动中".into());
        }
    }
    let clear_starting = || state.starting.store(false, Ordering::SeqCst);

    let config_dir = crate::commands::config::config_dir_path();
    let ports = configured_ports();
    let cert_path = config_dir.join("certs").join("server.codeium.com.pem");
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));

    let mitm_report = match ensure_proxy_mitm_ready(!admin_already_prompted) {
        Ok(report) => report,
        Err(e) => {
            clear_starting();
            let msg = format!("代理服务未启动：MITM 前置条件不满足: {}", e);
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "err".into(),
                    msg: msg.clone(),
                },
            );
            return Err(msg);
        }
    };
    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "ok".into(),
            msg: format!("✅ MITM 前置检查通过: {}", mitm_report.message),
        },
    );
    let admin_prompted = admin_already_prompted || mitm_report.admin_prompted;

    kill_sidecar_process();

    // 解析 sidecar 启动方式(dev 模式跑源码 node,release 模式跑 pkg exe)
    let mut cmd = {
        #[cfg(debug_assertions)]
        {
            let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let sidecar_dir = manifest_dir.parent().unwrap().join("sidecar");
            if !sidecar_dir.join("proxy-entry.js").exists() {
                clear_starting();
                return Err(format!(
                    "dev 模式找不到 sidecar 源码: {}",
                    sidecar_dir.display()
                ));
            }
            let mut c = std::process::Command::new("node");
            c.current_dir(&sidecar_dir);
            c.arg("proxy-entry.js");
            #[cfg(target_os = "windows")]
            c.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            c
        }
        #[cfg(not(debug_assertions))]
        {
            let sidecar_path = match resolve_sidecar_path() {
                Ok(p) => p,
                Err(e) => {
                    clear_starting();
                    return Err(e);
                }
            };
            let mut c = std::process::Command::new(&sidecar_path);
            #[cfg(target_os = "windows")]
            c.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            c
        }
    };

    cmd.env("BYOK_CONFIG_DIR", config_dir.to_string_lossy().to_string());
    cmd.env("API_PORT", ports.api_port.to_string());
    cmd.env("INFERENCE_PORT", ports.inference_port.to_string());
    if let Some(res) = &resource_dir {
        cmd.env("BYOK_RESOURCE_DIR", res.to_string_lossy().to_string());
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            clear_starting();
            return Err(format!("启动失败: {}", e));
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    *lock_or_recover(&state.child) = Some(ManagedChild {
        child: Mutex::new(child),
    });
    *lock_or_recover(&state.target_ide) = String::new();
    *lock_or_recover(&state.ports) = Some(ports);
    clear_starting();

    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: format!(
                "代理服务启动中；配置目录: {}{}",
                config_dir.to_string_lossy(),
                resource_dir
                    .as_ref()
                    .map(|p| format!("；资源目录: {}", p.to_string_lossy()))
                    .unwrap_or_default()
            ),
        },
    );

    spawn_log_reader(app.clone(), stdout);
    spawn_log_reader(app.clone(), stderr);

    let app_handle2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));

        let exited = if let Some(state) = app_handle2.try_state::<ProxyState>() {
            let guard = lock_or_recover(&state.child);
            match guard.as_ref() {
                Some(managed) => managed.try_wait().ok().flatten().is_some(),
                None => break,
            }
        } else {
            break;
        };

        if exited {
            if let Some(state) = app_handle2.try_state::<ProxyState>() {
                *lock_or_recover(&state.child) = None;
                *lock_or_recover(&state.target_ide) = String::new();
                *lock_or_recover(&state.ports) = None;
            }
            let _ = app_handle2.emit("proxy-stopped", ());
            break;
        }
    });

    let expected_ports = unique_proxy_ports(ports);
    let missing_ports = wait_for_ports(&expected_ports, Duration::from_secs(5));
    let health_error = if missing_ports.contains(&ports.api_port) {
        Some(ProxyHealthFailure {
            message: format!(
                "代理主端口 {} 未监听，本地代理入口不可用",
                ports.api_port
            ),
            mitm_related: false,
        })
    } else {
        match probe_byok_stats(ports.api_port, Duration::from_secs(2)) {
            Err(failure) => Some(failure),
            Ok(()) => probe_mitm_tls(ports.api_port, &cert_path, Duration::from_secs(5))
                .map_err(mitm_tls_failure)
                .err(),
        }
    };

    if let Some(failure) = health_error {
        let child = lock_or_recover(&state.child).take();
        if let Some(child) = child {
            let _ = child.kill();
        }
        *lock_or_recover(&state.target_ide) = String::new();
        *lock_or_recover(&state.ports) = None;
        if failure.mitm_related && allow_runtime_repair {
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!(
                        "MITM/TLS 实链路自检失败，正在强制重生证书并仅重启一次: {}",
                        failure.message
                    ),
                },
            );
            let repair_result = match ensure_proxy_mitm_ready_once(true, false) {
                Ok(report) => Ok((report, false)),
                Err(user_error) if admin_prompted => Err(format!(
                    "当前用户静默修复失败: {}；本次启动已请求过一次管理员授权，不再重复弹窗",
                    user_error
                )),
                Err(user_error) => ensure_proxy_mitm_ready_once(false, true)
                    .map(|report| (report, true))
                    .map_err(|admin_error| {
                        format!(
                            "当前用户静默修复失败: {}；管理员修复失败: {}",
                            user_error, admin_error
                        )
                    }),
            };
            match repair_result {
                Ok((report, repair_admin_prompted)) => {
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "ok".into(),
                            msg: format!("MITM 证书已修复，正在重新启动代理: {}", report),
                        },
                    );
                    return start_proxy_service_impl_with_repair(
                        app,
                        false,
                        admin_prompted || repair_admin_prompted,
                    );
                }
                Err(repair_error) => {
                    let msg = format!(
                        "代理服务启动失败: {}；MITM 自动修复失败: {}",
                        failure.message, repair_error
                    );
                    let _ = app.emit("proxy-stopped", ());
                    let _ = app.emit(
                        "proxy-log",
                        LogLine {
                            level: "err".into(),
                            msg: msg.clone(),
                        },
                    );
                    return Err(msg);
                }
            }
        }
        let msg = format!("代理服务启动失败: {}", failure.message);
        let _ = app.emit("proxy-stopped", ());
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "err".into(),
                msg: msg.clone(),
            },
        );
        return Err(msg);
    }

    if missing_ports.is_empty() {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: format!("✅ 代理服务健康检查通过: {}", port_pair_text(ports)),
            },
        );
    } else {
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "warn".into(),
                msg: format!(
                    "⚠ 代理主服务已就绪，但以下辅助端口暂未监听: {}",
                    missing_ports
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            },
        );
    }

    Ok(true)
}

pub fn stop_proxy_service_impl(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ProxyState>();
    let child = lock_or_recover(&state.child).take();
    if let Some(child) = child {
        if let Err(e) = child.kill() {
            eprintln!("[stop_proxy_service] kill 失败（进程可能已退出）: {}", e);
        }
        *lock_or_recover(&state.target_ide) = String::new();
        *lock_or_recover(&state.ports) = None;
        let _ = app.emit("proxy-stopped", ());
        let _ = app.emit(
            "proxy-log",
            LogLine {
                level: "ok".into(),
                msg: "代理服务已停止，平台配置未改动".into(),
            },
        );
        Ok(())
    } else {
        Err("代理未运行".into())
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IdeProxyModeReport {
    pub ide_config: String,
    pub workbench_inject: String,
    pub cursor_auth: String,
}

pub fn switch_ide_to_proxy_impl(
    app: AppHandle,
    target: String,
) -> Result<IdeProxyModeReport, String> {
    if target != "windsurf" && target != "devin" && target != "cursor" {
        return Err(format!("暂不支持的 IDE: {}", target));
    }
    let mut report = IdeProxyModeReport::default();

    if target == "cursor" {
        report.cursor_auth = crate::commands::cursor_auth::apply_cursor_auth_and_model()
            .map_err(|e| format!("写入 Cursor BYOK auth/model 失败: {}", e))?;
        report.ide_config = match crate::commands::ide_config::patch(&target) {
            Ok(true) => "updated".into(),
            Ok(false) => "ok".into(),
            Err(e) => {
                let _ = crate::commands::cursor_auth::restore_cursor_auth();
                return Err(format!("写入 Cursor 代理配置失败: {}", e));
            }
        };
        report.workbench_inject = "ok（Cursor 无需 workbench 注入）".into();
        return Ok(report);
    }

    report.cursor_auth = "ok（无需 Cursor auth）".into();
    report.ide_config = match crate::commands::ide_config::patch(&target) {
        Ok(true) => "updated".into(),
        Ok(false) => "ok".into(),
        Err(e) => return Err(format!("写入 IDE 代理配置失败: {}", e)),
    };

    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| resolve_resources_root(Some(&p)));
    report.workbench_inject = if let Some(res) = resource_dir {
        let script_path = res.join("byok-cards.js");
        match std::fs::read_to_string(&script_path) {
            Ok(script) => match crate::commands::workbench_inject::inject(&script, &target) {
                Ok(true) => "updated".into(),
                Ok(false) => "ok".into(),
                Err(e) => format!("warn: {}", e),
            },
            Err(e) => format!("warn: 读取 byok-cards.js 失败: {}", e),
        }
    } else {
        "warn: 资源目录不可用".into()
    };

    Ok(report)
}

pub fn restore_ide_direct_impl(app: AppHandle, target: String) -> Result<RestoreReport, String> {
    if target != "windsurf" && target != "devin" && target != "cursor" {
        return Err(format!("暂不支持的 IDE: {}", target));
    }
    let state = app.state::<ProxyState>();
    Ok(restore_all(&state, &target))
}
#[tauri::command]
pub async fn start_proxy(
    app: AppHandle,
    _target_ide: Option<String>,
    _skip_preflight: Option<bool>,
) -> Result<bool, String> {
    // 兼容旧前端命令名，但语义已经收敛为“只启动全局代理服务”。
    // IDE 切换必须走 switch_ide_to_proxy，避免全局开关隐式改写 IDE 配置。
    tauri::async_runtime::spawn_blocking(move || start_proxy_service_impl(app))
        .await
        .map_err(|e| format!("启动代理服务任务失败: {}", e))?
}

#[allow(dead_code)]
pub fn stop_proxy_impl(
    app: AppHandle,
    _target_ide: Option<String>,
) -> Result<RestoreReport, String> {
    let state = app.state::<ProxyState>();
    let child = lock_or_recover(&state.child).take();
    if let Some(child) = child {
        // 无论 kill 是否成功，都必须还原配置；kill 失败仅记日志不阻断。
        if let Err(e) = child.kill() {
            eprintln!("[stop_proxy] kill 失败（进程可能已退出）: {}", e);
        }
        // 还原 IDE 配置：使用 start_proxy 时保存的 target_ide，
        // 而非重新检测或参数传入值——确保还原目标与打补丁时一致。
        let target = lock_or_recover(&state.target_ide).clone();
        // 清除 target_ide，防止残留旧值被后续误用
        *lock_or_recover(&state.target_ide) = String::new();
        *lock_or_recover(&state.ports) = None;
        if target.is_empty() || (target != "windsurf" && target != "devin" && target != "cursor") {
            eprintln!("[stop_proxy] target_ide 异常: '{}', 跳过还原", target);
            let _ = app.emit("proxy-stopped", ());
            return Ok(RestoreReport::default());
        }
        let report = restore_all(&state, &target);

        // 如果还原有警告，通过事件通知前端（同时返回值也携带报告）。
        if report.has_warning() {
            let mut warnings = Vec::new();
            if !report.ide_config.starts_with("ok") {
                warnings.push(report.ide_config.clone());
            }
            if !report.workbench_inject.starts_with("ok") {
                warnings.push(report.workbench_inject.clone());
            }
            if !report.cursor_auth.starts_with("ok") {
                warnings.push(report.cursor_auth.clone());
            }
            let _ = app.emit(
                "proxy-log",
                LogLine {
                    level: "warn".into(),
                    msg: format!("⚠ 还原警告: {}", warnings.join("；")),
                },
            );
        }

        // 通知前端代理已停止（与监控线程的 proxy-stopped 对齐）
        let _ = app.emit("proxy-stopped", ());

        Ok(report)
    } else {
        Err("代理未运行".into())
    }
}

#[tauri::command]
pub async fn stop_proxy(
    app: AppHandle,
    _target_ide: Option<String>,
) -> Result<RestoreReport, String> {
    // 兼容旧前端命令名，但停止全局代理时不再还原 IDE 配置。
    // IDE 还原必须走 restore_ide_direct，由用户在平台页显式触发。
    tauri::async_runtime::spawn_blocking(move || {
        stop_proxy_service_impl(app)?;
        Ok(RestoreReport::default())
    })
    .await
    .map_err(|e| format!("停止代理服务任务失败: {}", e))?
}

#[tauri::command]
pub async fn start_proxy_service(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || start_proxy_service_impl(app))
        .await
        .map_err(|e| format!("启动代理服务任务失败: {}", e))?
}

#[tauri::command]
pub async fn stop_proxy_service(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_proxy_service_impl(app))
        .await
        .map_err(|e| format!("停止代理服务任务失败: {}", e))?
}

#[tauri::command]
pub async fn restart_proxy_service(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match stop_proxy_service_impl(app.clone()) {
            Ok(()) => {}
            Err(e) if e == "代理未运行" => {}
            Err(e) => return Err(e),
        }
        start_proxy_service_impl(app)
    })
    .await
    .map_err(|e| format!("重启代理服务任务失败: {}", e))?
}

#[tauri::command]
pub async fn switch_ide_to_proxy(
    app: AppHandle,
    target: String,
) -> Result<IdeProxyModeReport, String> {
    tauri::async_runtime::spawn_blocking(move || switch_ide_to_proxy_impl(app, target))
        .await
        .map_err(|e| format!("切换 IDE 到代理任务失败: {}", e))?
}

#[tauri::command]
pub async fn restore_ide_direct(app: AppHandle, target: String) -> Result<RestoreReport, String> {
    tauri::async_runtime::spawn_blocking(move || restore_ide_direct_impl(app, target))
        .await
        .map_err(|e| format!("还原 IDE 直连任务失败: {}", e))?
}
/// 强杀所有 AnyBridge sidecar 孤儿进程（启动时 / 升级前调用）。
/// 与 ManagedChild::kill() 不同：这里不依赖 state 里记录的 PID，
/// 而是按进程名全盘扫描，确保上一轮崩溃或异常退出后残留的 sidecar 不会锁住 exe 文件。
pub fn kill_sidecar_process() {
    #[cfg(target_os = "windows")]
    {
        for process_name in ["anybridge-proxy.exe", "ide-byok-proxy.exe"] {
            let out = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/IM", process_name])
                .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    eprintln!("[cleanup] 已清理孤儿 sidecar 进程: {}", process_name);
                }
                Ok(_) => {
                    // 进程不存在（taskkill 返回错误码 128），属正常情况
                }
                Err(e) => {
                    eprintln!("[cleanup] taskkill 执行失败: {}", e);
                }
            }
        }
        // dev 模式:额外清理跑 sidecar/proxy-entry.js 的 node 进程
        // (release 模式这步是多余的,因为 node 进程由 exe 启动,exe 退出时 node 也会退出)
        #[cfg(debug_assertions)]
        {
            // wmic 在 Win11 已弃用，改用 PowerShell Get-CimInstance
            let ps_script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Select-Object ProcessId, CommandLine |
  ForEach-Object { "$($_.ProcessId),$($_.CommandLine)" }
"#;
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
                .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                .output();
            if let Ok(o) = out {
                if o.status.success() {
                    let text = String::from_utf8_lossy(&o.stdout);
                    for line in text.lines() {
                        let line = line.trim();
                        if line.is_empty() { continue; }
                        // 格式: "PID,CommandLine"
                        if line.contains("proxy-entry.js")
                            || line.contains("sidecar\\hybrid-server.js")
                        {
                            // 提 ProcessId (第一个逗号前)
                            if let Some(pid_str) = line.split(',').next() {
                                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                                    let _ = std::process::Command::new("taskkill")
                                        .args(["/F", "/T", "/PID", &pid.to_string()])
                                        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                                        .output();
                                    eprintln!(
                                        "[cleanup] 已清理 dev 模式 sidecar node 进程: PID {}",
                                        pid
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for process_name in ["anybridge-proxy", "ide-byok-proxy"] {
            let _ = std::process::Command::new("pkill")
                .args(["-f", process_name])
                .output();
        }

        #[cfg(debug_assertions)]
        {
            for script_name in [
                "sidecar/proxy-entry.js",
                "sidecar/hybrid-server.js",
                "sidecar/inference-proxy.js",
            ] {
                let _ = std::process::Command::new("pkill")
                    .args(["-f", script_name])
                    .output();
            }
        }
    }
}

pub fn stop_sidecar_for_update(app: AppHandle) -> Result<(), String> {
    match stop_proxy_service_impl(app.clone()) {
        Ok(()) => {}
        Err(e) if e == "代理未运行" => {}
        Err(e) => return Err(format!("停止代理服务失败，无法继续安装更新: {}", e)),
    }

    kill_sidecar_process();
    std::thread::sleep(Duration::from_millis(1000));

    let leftovers = running_sidecar_process_names();
    if !leftovers.is_empty() {
        return Err(format!(
            "更新前无法停止后台代理进程: {}。请退出 AnyBridge 后重试，或手动结束这些进程。",
            leftovers.join(", ")
        ));
    }

    let _ = app.emit(
        "proxy-log",
        LogLine {
            level: "info".into(),
            msg: "更新安装前已暂停本地代理服务".into(),
        },
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn running_sidecar_process_names() -> Vec<String> {
    let mut running = Vec::new();
    for process_name in ["anybridge-proxy.exe", "ide-byok-proxy.exe"] {
        let output = std::process::Command::new("tasklist")
            .args([
                "/FI",
                &format!("IMAGENAME eq {}", process_name),
                "/FO",
                "CSV",
                "/NH",
            ])
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .output();
        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if stdout.contains(&process_name.to_lowercase()) {
                running.push(process_name.to_string());
            }
        }
    }
    running
}

#[cfg(not(target_os = "windows"))]
fn running_sidecar_process_names() -> Vec<String> {
    let mut running = Vec::new();
    for process_name in ["anybridge-proxy", "ide-byok-proxy"] {
        let output = std::process::Command::new("pgrep")
            .args(["-x", process_name])
            .output();
        if output.is_ok_and(|output| output.status.success()) {
            running.push(process_name.to_string());
        }
    }
    running
}

#[tauri::command]
pub async fn get_stats(state: State<'_, ProxyState>) -> Result<serde_json::Value, String> {
    let port = active_or_configured_ports(state.inner()).api_port;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://127.0.0.1:{}/__byok/stats", port))
        .send()
        .await
        .map_err(|e| format!("代理未响应: {}", e))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}
