use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub(super) const TLS_REJECTION_RECENT_WINDOW_MS: u64 = 30 * 60 * 1000;
// 只保留当前桌面进程内最近一次明确的 sidecar 拒绝事件，不持久化客户端信息。
pub(super) static LAST_TLS_REJECTION_AT_MS: AtomicU64 = AtomicU64::new(0);

// sidecar 通过 stdout 上报结构化事件的前缀与已知事件名；
// 必须与 sidecar/hybrid-server.js 中的常量保持一致。
pub(super) const SIDECAR_EVENT_PREFIX: &str = "ANYBRIDGE_EVENT:";
pub(super) const TLS_CLIENT_CERT_REJECTED_PAYLOAD: &str = "TLS_CLIENT_CERT_REJECTED";

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// DETACHED_PROCESS: 子进程不继承父进程控制台，也不会创建新控制台。
/// 对 console subsystem 的二进制（如 pkg 打包的 Node.js）也能阻止 CMD 窗口弹出。
#[cfg(target_os = "windows")]
pub(super) const DETACHED_PROCESS: u32 = 0x0000_0008;

/// CREATE_NO_WINDOW: 如果进程没有控制台，不创建新控制台窗口。
#[cfg(target_os = "windows")]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// CREATE_NEW_PROCESS_GROUP: 创建新进程组，避免子进程继承父进程的 Ctrl+C 信号。
#[cfg(target_os = "windows")]
pub(super) const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// 自定义子进程包装，提供 kill 能力。
pub struct ManagedChild {
    pub(super) child: Mutex<std::process::Child>,
    // 网关存活期间持共享锁；只有确认退出并丢弃句柄后，其他进程才能改证书包。
    pub(super) _package_lock: Option<crate::commands::system::MitmPackageLock>,
}

/// 发出终止请求后的等待上限。超时只把未确认状态交回上层，不做二次 kill 或隐式清理。
pub(super) const STOP_CONFIRM_TIMEOUT_MS: u64 = 2000;

/// kill() 的结果：区分「已确认退出」与「信号已发出但未确认」，
/// 让上层决定是清理状态（可安全改证书）还是保留进程状态并如实报错。
pub(crate) enum StopOutcome {
    Exited,
    Pending { pid: u32, waited_ms: u128 },
}

/// stop_managed_proxy 的结果：调用方必须区分「没在跑」「已停」「停了但没确认」三种情况。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StopStatus {
    NotRunning,
    Stopped,
    Unconfirmed { pid: u32, waited_ms: u128 },
}

/// 终止请求已发出但未确认退出时的统一说明；上层再拼接各自上下文，避免各处理论出不同措辞。
pub(super) fn unconfirmed_stop_hint(pid: u32, waited_ms: u128) -> String {
    format!(
        "已请求停止但未确认进程退出（pid={}，等待 {} ms）；进程状态已保留，请勿立即操作证书",
        pid, waited_ms
    )
}

impl ManagedChild {
    /// 已退出视为成功；发出终止请求后仍须确认退出，调用方才能清理状态或修改证书。
    pub fn kill(&self) -> Result<StopOutcome, String> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if child.try_wait().map_err(|e| format!("检查进程状态失败: {}", e))?.is_some() {
            return Ok(StopOutcome::Exited);
        }

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
                Ok(o) if o.status.success() => return Self::wait_for_exit(&mut child),
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

        child.kill().map_err(|e| format!("停止失败: {}", e))?;
        Self::wait_for_exit(&mut child)
    }

    // 窗口仅覆盖终止请求完成后的退出轮询，不含 Windows taskkill 自身执行耗时。
    fn wait_for_exit(child: &mut std::process::Child) -> Result<StopOutcome, String> {
        let pid = child.id();
        let started = Instant::now();
        loop {
            if child.try_wait().map_err(|e| format!("检查进程状态失败: {}", e))?.is_some() {
                return Ok(StopOutcome::Exited);
            }
            let waited_ms = started.elapsed().as_millis();
            if waited_ms >= STOP_CONFIRM_TIMEOUT_MS as u128 {
                // 不隐藏失败也不假装成功：把未确认状态连同 pid 交回上层处理。
                return Ok(StopOutcome::Pending { pid, waited_ms });
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    fn id(&self) -> u32 {
        lock_or_recover(&self.child).id()
    }

    fn try_wait(&self) -> Result<Option<std::process::ExitStatus>, String> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait()
            .map_err(|e| format!("检查进程状态失败: {}", e))
    }
}

/// 仅在桌面管理的网关停止时执行任务；不会主动停网关，也不检测外部启动的 sidecar。
pub(crate) fn with_proxy_stopped<T>(
    app: &AppHandle,
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_proxy_stopped_state(&app.state::<ProxyState>(), task)
}

pub(super) fn with_proxy_stopped_state<T>(
    state: &ProxyState,
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    // 与启动入口共用 child 锁和 starting 标志，避免检查停止状态后又被并发启动。
    let child = lock_or_recover(&state.child);
    if let Some(managed) = child.as_ref() {
        if managed.try_wait()?.is_none() {
            return Err("请先停止网关再操作证书，避免运行中的网关继续使用旧证书".into());
        }
    }
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("网关正在启动或证书任务正在执行，请等待完成后再操作".into());
    }
    struct StartGuard<'a>(&'a AtomicBool);
    impl Drop for StartGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    // 任务期间只保留启动占位，不持有 child 锁；返回错误或 panic 展开时由守卫释放。
    let _guard = StartGuard(&state.starting);
    drop(child);
    task()
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
    pub(super) ports: Mutex<Option<crate::commands::config::ConfiguredProxyPorts>>,
}

/// 取锁并容忍 poisoning：某线程持锁时 panic 不应让后续所有网关操作永久 panic。
pub fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 还原结果：哪些步骤失败、哪些步骤找不到备份。
#[derive(Serialize, Clone, Default)]
pub struct RestoreReport {
    /// IDE 网关配置还原结果
    pub ide_config: String,
    /// workbench.html 注入还原结果
    pub workbench_inject: String,
    /// Cursor state.vscdb auth/model 恢复结果
    pub cursor_auth: String,
}

impl RestoreReport {
    pub(super) fn has_warning(&self) -> bool {
        !self.ide_config.starts_with("ok")
            || !self.workbench_inject.starts_with("ok")
            || !self.cursor_auth.starts_with("ok")
    }
}

/// 串行还原 IDE 配置与 workbench 注入（幂等）。
/// 返回还原报告，调用方可据此向用户发出警告。
pub(super) fn restore_all(state: &ProxyState, target: &str) -> RestoreReport {
    let _guard = lock_or_recover(&state.restore_lock);
    let mut report = RestoreReport::default();

    match crate::commands::ide_config::restore(target) {
        Ok(true) => report.ide_config = "ok".into(),
        Ok(false) => report.ide_config = "未找到备份，IDE 网关配置可能未被还原".into(),
        Err(e) => report.ide_config = format!("还原失败: {}", e),
    }

    if target == "cursor" {
        report.workbench_inject = "ok（Cursor 无需 workbench 注入）".into();
        report.cursor_auth =
            match crate::commands::cursor_auth::restore_cursor_auth() {
                Ok(crate::commands::cursor_auth::CursorAuthRestore::Restored {
                    restored,
                    kept_user_changes,
                }) => {
                    if kept_user_changes > 0 {
                        format!(
                            "ok（已写回 {restored} 项账号键，保留接管期间的 {kept_user_changes} 项改动）"
                        )
                    } else {
                        format!("ok（已写回 {restored} 项账号键）")
                    }
                }
                Ok(crate::commands::cursor_auth::CursorAuthRestore::NotNeeded) => {
                    "ok（无需还原）".into()
                }
                // 账本丢失 + 账号仍是接管态：唯一还原源已没了，必须让用户知道。
                Ok(crate::commands::cursor_auth::CursorAuthRestore::BackupMissing) => {
                    "账号备份缺失：Cursor 里仍是本地接管账号，请在 Cursor 中退出登录后重新登录恢复原账号"
                        .into()
                }
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

pub(super) fn issue_group_id(code: &str) -> &'static str {
    // 注意顺序：先匹配更具体的前缀，最后兜底到 "other"
    if code.starts_with("cert.") || code.starts_with("certs.") {
        "cert"
    } else if code.starts_with("takeover.") {
        "takeover"
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

pub(super) fn group_meta(id: &str) -> (&'static str, &'static str) {
    match id {
        "path" => ("路径", "📁"),
        "cert" => ("证书", "🔒"),
        "takeover" => ("接管状态", "🔗"),
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
        "takeover",
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

// TLS/CONNECT 拒绝优先于箭头等成功标记，避免含恢复指引的错误行被误标为成功。
pub(crate) fn classify(line: &str) -> String {
    if line.contains('❌')
        || line.contains("Error")
        || line.contains("ERROR")
        || line.contains("[ERR")
        || line.to_ascii_lowercase().contains("tls error:")
        || line.to_ascii_lowercase().contains("connect error")
        || line.contains("客户端拒绝了 MITM 证书")
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


pub(super) fn format_exit_status(status: &std::process::ExitStatus) -> String {
    let mut parts = Vec::new();
    if let Some(code) = status.code() {
        if code < 0 || code > 255 {
            parts.push(format!("退出码: {} (0x{:08X})", code, code as u32));
        } else {
            parts.push(format!("退出码: {}", code));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            let note = match sig {
                5 => {
                    if cfg!(target_os = "macos") {
                        " (SIGTRAP - macOS 上常见于 Hardened Runtime 下 sidecar 缺少 \
                         allow-jit entitlement，V8 无法申请 JIT 内存)"
                    } else {
                        " (SIGTRAP - 断点/陷阱指令，常见于 V8 断言失败或调试中断)"
                    }
                }
                9 => " (SIGKILL - 常见于 macOS 签名损坏或被系统强杀)",
                11 => " (SIGSEGV - 内存段错误)",
                6 => " (SIGABRT - 进程异常中止)",
                15 => " (SIGTERM - 终止信号)",
                _ => "",
            };
            parts.push(format!("终止信号: {}{}", sig, note));
        }
    }
    if parts.is_empty() {
        "未知状态".into()
    } else {
        parts.join(", ")
    }
}

/// 把一行 sidecar 输出转换为 UI 日志行，并识别其中的结构化事件。
/// 抽成纯入口是为了让协议变更能被单元测试覆盖，而不是只能靠线上排查发现。
pub(super) fn sidecar_log_line(trimmed: &str) -> LogLine {
    match trimmed.strip_prefix(SIDECAR_EVENT_PREFIX) {
        Some(payload) if payload == TLS_CLIENT_CERT_REJECTED_PAYLOAD => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            if now_ms > 0 {
                LAST_TLS_REJECTION_AT_MS.store(now_ms, Ordering::Relaxed);
            }
            LogLine {
                level: "err".into(),
                msg: "近期检测到 TLS 客户端拒绝或未能验证网关证书（未识别客户端身份）".into(),
            }
        }
        // 未知事件必须显式告警：否则协议一旦漂移，相关检查会无声失效。
        Some(payload) => {
            eprintln!(
                "[proxy] sidecar 上报了未识别的事件: {}{}",
                SIDECAR_EVENT_PREFIX, payload
            );
            LogLine {
                level: "warn".into(),
                msg: format!(
                    "未识别的 sidecar 事件 {}{}，该检查未生效，请升级应用",
                    SIDECAR_EVENT_PREFIX, payload
                ),
            }
        }
        None => LogLine {
            level: classify(trimmed),
            msg: trimmed.to_string(),
        },
    }
}

pub(super) fn spawn_log_reader<R>(app: AppHandle, pipe: Option<R>)
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
            let _ = app.emit("proxy-log", sidecar_log_line(trimmed));
        }
    });
}

pub(super) fn resolve_target_ide_arg(target_ide: Option<&str>) -> Result<String, String> {
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

/// 预检允许修复的范围。
/// 证书包与系统信任只允许显式体检改动；网关启动预检即使修复 IDE 配置也必须只读证书。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RepairScope {
    /// 只读体检，不修改任何文件或系统状态
    ReadOnly,
    /// 可修复 IDE 侧配置，但不触碰证书包与系统信任
    IdeConfig,
    /// 用户显式发起的体检：允许重写证书包并尝试用户级信任安装
    Certificate,
}

impl RepairScope {
    /// 是否允许修复 IDE 配置等无害项
    pub(super) fn repairs_config(self) -> bool {
        !matches!(self, RepairScope::ReadOnly)
    }

    /// 是否允许生成证书包或修改系统信任
    fn repairs_certificate(self) -> bool {
        matches!(self, RepairScope::Certificate)
    }
}

pub(super) fn push_issue(
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

// 事件只在本桌面进程内有效；墙钟回退或事件超出窗口时不显示为近期问题。
pub(super) fn recent_tls_rejection_issue(now_ms: u64, last_seen_ms: u64) -> Option<ProxyPreflightIssue> {
    if last_seen_ms == 0
        || now_ms < last_seen_ms
        || now_ms.saturating_sub(last_seen_ms) > TLS_REJECTION_RECENT_WINDOW_MS
    {
        return None;
    }
    Some(ProxyPreflightIssue {
        level: "err".into(),
        code: "cert.tls_client_rejection_recent".into(),
        message: format!(
            "最近 30 分钟内检测到 TLS 客户端拒绝或未能验证网关证书（{} 分钟前）；客户端身份未知。请先核对当前 CA 信任状态，并完全重启网关和 IDE。",
            now_ms.saturating_sub(last_seen_ms) / 60_000
        ),
    })
}


mod commands_and_cleanup;
mod health_probes;
mod lifecycle;
mod preflight_env;
mod preflight_ide;
mod service_and_cmds;

pub use commands_and_cleanup::*;
pub use health_probes::*;
pub use lifecycle::*;
pub use preflight_env::*;
pub use service_and_cmds::*;

#[cfg(test)]
#[path = "log_tests.rs"]
mod log_classification_tests;
