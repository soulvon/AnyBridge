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
}

impl RestoreReport {
    fn has_warning(&self) -> bool {
        self.ide_config != "ok" || self.workbench_inject != "ok"
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

    match crate::commands::workbench_inject::restore(target) {
        Ok(true) => report.workbench_inject = "ok".into(),
        Ok(false) => report.workbench_inject = "ok（无需还原）".into(),
        Err(e) => report.workbench_inject = format!("还原失败: {}", e),
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
struct LogLine {
    level: String,
    msg: String,
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
                if saved == "windsurf" || saved == "devin" {
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
        Some(t) if t == "windsurf" || t == "devin" => Ok(t.to_string()),
        Some(t) => Err(format!("不支持的目标 IDE: {}（仅 windsurf/devin/auto）", t)),
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

fn probe_byok_stats(timeout: Duration) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 7450));
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("无法连接 7450: {}", e))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(b"GET /__byok/stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| format!("发送健康检查失败: {}", e))?;
    let mut buf = String::new();
    stream
        .read_to_string(&mut buf)
        .map_err(|e| format!("读取健康检查响应失败: {}", e))?;
    if !buf.starts_with("HTTP/1.1 200") && !buf.starts_with("HTTP/1.0 200") {
        return Err("7450 有响应，但不是 BYOK 健康检查 200".into());
    }
    if !buf.contains("\"requests\"") || !buf.contains("\"uptimeSec\"") {
        return Err("7450 有响应，但不像 AnyBridge 代理；可能被其它程序占用".into());
    }
    Ok(())
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
                "「{}」未填写目标模型，且供应商「{}」也没有默认模型",
                label, provider.name
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
    let mut cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let mut key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    if !cert_ok || !key_ok {
        if repair {
            match crate::commands::system::generate_certs() {
                Ok(msg) => {
                    cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                    key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                    if cert_ok && key_ok {
                        push_issue(&mut issues, "ok", "certs.auto_generated", msg);
                    } else {
                        push_issue(
                            &mut issues,
                            "err",
                            "certs.generate_incomplete",
                            "已尝试自动生成 MITM 证书，但证书文件仍不完整。请到「设置 > IDE 接入」重新生成证书",
                        );
                    }
                }
                Err(e) => push_issue(
                    &mut issues,
                    "err",
                    "certs.generate_failed",
                    format!(
                        "自动生成 MITM 证书失败: {}。请到「设置 > IDE 接入」手动生成",
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
                    "MITM 证书不完整，请先在「设置 > IDE 接入」生成证书（缺少或为空: {}, {}）",
                    cert_path.to_string_lossy(),
                    key_path.to_string_lossy()
                ),
            );
        }
    }

    // 证书信任状态检查（升级路径：用户在装了 BYOK 但没装证书的机器上会卡这里）
    // 之前这里完全没做检查，导致 Devin/Windsurf 拿到 BYOK 伪证书时直接走 bad
    // certificate 流程产生 30+ 条 SSL alert 42 错误。增加此检查后，体检报告
    // 会直接告诉用户「证书未装到系统」并引导一键安装。
    let ca_status = crate::commands::cert_install::check_ca_status();
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
                    "当前 CA 证书已生成但未安装到系统根证书库。点「环境体检」中的「一键安装证书」可自动装到 CurrentUser\\Root（无需管理员权限），失败才弹 UAC".to_string(),
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
                "检测到老版本 CA \"{}\" 残留。建议点「环境体检 > 清理老证书」卸掉",
                crate::commands::system::LEGACY_CA_COMMON_NAMES.join("\" / \"")
            ),
        );
    }

    let ide_label = if target == "devin" {
        "Devin"
    } else {
        "Windsurf"
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
                        if !proxy.is_empty() && proxy != "http://localhost:7450" {
                            push_issue(
                                &mut issues,
                                "warn",
                                "ide_settings.other_proxy",
                                format!(
                                    "{} 当前已有 http.proxy={}，启动时会备份并改写为 AnyBridge 代理",
                                    ide_label, proxy
                                ),
                            );
                        }
                        if proxy == "http://localhost:7450"
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
                                        "{} 已指向 AnyBridge 代理，但 http.proxyStrictSSL 不是 false，启动时会修正",
                                        ide_label
                                    ),
                                );
                            }
                        }
                        let backup = settings_backup_path(&settings);
                        if backup.exists() && proxy != "http://localhost:7450" {
                            push_issue(
                                &mut issues,
                                "warn",
                                "ide_settings.backup_exists",
                                format!(
                                    "{} 存在旧备份文件，将沿用它做停止代理时的还原基准",
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
                "未找到 {} settings.json: {}。请先启动一次 {}，或在「设置 > IDE 接入」手动指定 IDE 路径后再启动代理",
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
            "没有任何可用模型路由：请至少给一个启用槽位配置供应商和模型",
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

    for port in [7450u16, 7451u16] {
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
    let report = preflight_proxy_impl(app.clone(), target_ide)?;
    Ok(group_report(&report))
}

/// 解析 sidecar 二进制路径。
/// 与 tauri_plugin_shell 的 relative_command_path 逻辑一致：
/// 基于 current_exe 所在目录查找，文件名不带 target triple 后缀
/// （Tauri 构建脚本会自动将 binaries/ 下带后缀的文件重命名后复制到 exe 旁边）。
fn resolve_sidecar_path() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("当前 exe 路径无父目录")?;

    // 测试模式下 exe 在 deps/ 子目录，需要上一级
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };

    #[cfg(target_os = "windows")]
    let sidecar_files = ["anybridge-proxy.exe", "ide-byok-proxy.exe"];
    #[cfg(not(target_os = "windows"))]
    let sidecar_files = ["anybridge-proxy", "ide-byok-proxy"];

    for sidecar_file in sidecar_files {
        let path = base_dir.join(sidecar_file);
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "sidecar 二进制不存在: {}",
        base_dir.join(sidecar_files[0]).to_string_lossy()
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
    ProxyStatus {
        running,
        target_ide,
        api_port: 7450,
        inference_port: 7451,
    }
}

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

    // 解析 sidecar 路径
    let sidecar_path = match resolve_sidecar_path() {
        Ok(p) => p,
        Err(e) => {
            clear_starting();
            return Err(e);
        }
    };

    let mut cmd = std::process::Command::new(&sidecar_path);

    // Windows: 设置进程创建标志，阻止 CMD 窗口弹出
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    cmd.env("BYOK_CONFIG_DIR", config_dir.to_string_lossy().to_string());
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
    if let Some(res) = &resource_dir {
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
                if target.is_empty() || (target != "windsurf" && target != "devin") {
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

    let missing_ports = wait_for_ports(&[7450, 7451], Duration::from_secs(5));
    let health_error = if missing_ports.contains(&7450) {
        Some("代理主端口 7450 未监听，IDE 无法接入 AnyBridge 代理".to_string())
    } else {
        probe_byok_stats(Duration::from_secs(2)).err()
    };

    if let Some(e) = health_error {
        let child = lock_or_recover(&state.child).take();
        if let Some(child) = child {
            let _ = child.kill();
        }
        let report = restore_all(&state, &target);
        *lock_or_recover(&state.target_ide) = String::new();
        let _ = app.emit("proxy-stopped", ());
        let mut msg = format!("代理启动失败: {}", e);
        if report.has_warning() {
            msg.push_str(&format!(
                "；自动回滚时有警告: IDE配置={}, 卡片注入={}",
                report.ide_config, report.workbench_inject
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
                msg: "✅ 代理健康检查通过: 7450 / 7451".into(),
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

#[tauri::command]
pub async fn start_proxy(
    app: AppHandle,
    target_ide: Option<String>,
    skip_preflight: Option<bool>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_proxy_impl(app, target_ide, skip_preflight.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("启动代理任务失败: {}", e))?
}

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
        if target.is_empty() || (target != "windsurf" && target != "devin") {
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
    target_ide: Option<String>,
) -> Result<RestoreReport, String> {
    tauri::async_runtime::spawn_blocking(move || stop_proxy_impl(app, target_ide))
        .await
        .map_err(|e| format!("停止代理任务失败: {}", e))?
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
    }

    #[cfg(not(target_os = "windows"))]
    {
        for process_name in ["anybridge-proxy", "ide-byok-proxy"] {
            let _ = std::process::Command::new("pkill")
                .args(["-f", process_name])
                .output();
        }
    }
}

#[tauri::command]
pub async fn get_stats() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("http://127.0.0.1:7450/__byok/stats")
        .send()
        .await
        .map_err(|e| format!("代理未响应: {}", e))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}
