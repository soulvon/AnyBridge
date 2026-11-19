// codex_desktop.rs
//
// Codex Desktop (Electron / MSIX) 进程生命周期 + CDP 调试模式管理。
//
// 职责（按用户选择：Rust 管生命周期 / sidecar 管 CDP 注入）：
//   - 检测 Codex MSIX 安装信息（Get-AppxPackage）
//   - kill Codex Desktop 宿主（ChatGPT.exe / 旧版 Codex.exe）及其包内子进程
//   - COM 激活 ApplicationActivationManager 带 --remote-debugging-port 启动
//   - 轮询 CDP /json 就绪
//   - 写 / 清理 ~/.codex/models_cache.json 注入项
//   - 通过 sidecar /__byok/codex-cdp/inject 注入 6 点补丁
//   - 常驻 watcher：检测到 Desktop UI 在跑但无 CDP 时自动接管
//
// 仅支持 Windows。macOS/Linux 返回友好错误。
//
// 参考：CodexPlusPlus launcher.py (COM 激活 + kill)、app_paths.py (MSIX 检测)、
//       CC-Switch spec §4.11-4.20 (CDP + models_cache 注入)。
//
// 进程识别注意（2026-07）：
//   新版 Codex Desktop 宿主进程名是 ChatGPT.exe（路径含 OpenAI.Codex），
//   包内 app-server 仍叫 codex.exe。不能再用「任意 codex.exe」判断 Desktop 在跑，
//   否则 CLI / 残留 app-server / 第三方 adapter 会误触发 watcher 接管并弹窗。

use crate::commands::config::{configured_proxy_ports, read_provider_store};
use crate::commands::platforms::codex_home;
use serde::Serialize;
use std::net::SocketAddr;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;
// Instant 仅用于 Windows Codex watcher 的冷却与超时计时。
#[cfg(target_os = "windows")]
use std::time::Instant;
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
pub(super) const CDP_PORT: u16 = 9229;

// ─── 注入失败的用户可见主句 ────────────────────────────────────────────
// 契约：`message` 第一行是给用户看的固定句（整句作为 key 收录在
// ui/assets/i18n/en-US.js，`npm run check:i18n` 会拦漏翻），第二行起是
// `详情：…` 技术原因。前端只展示首行，详情进日志面板，避免把 os error
// 直接砸给用户（issue #38）。

/// 网关服务不可用（未启动 / 启动失败 / 端口不通）——注入前置检查失败。
pub(super) const MSG_PROXY_UNAVAILABLE: &str =
    "本地网关服务不可用，已跳过模型注入。请检查网关服务后重试。";
/// 注入请求发出去了但 sidecar 回报失败。
pub(super) const MSG_INJECT_FAILED: &str =
    "Codex 已启动，但模型注入未完成。请稍后重试或查看日志。";
/// CDP 调试端口在超时窗口内没起来。
#[cfg(target_os = "windows")]
pub(super) const MSG_CDP_NOT_READY: &str =
    "Codex 未在预期时间内就绪，已跳过模型注入。请稍后重试。";

/// 记录当前 Codex 实际使用的 CDP 端口（可能为动态端口）。
/// launch_with_cdp 时写入，watcher 和 injection check 读取。
/// 0 表示尚未启动过 CDP 模式，回退到 CDP_PORT。
#[cfg(target_os = "windows")]
pub(super) static ACTIVE_CDP_PORT: AtomicU16 = AtomicU16::new(0);

#[cfg(target_os = "windows")]
pub(super) fn current_cdp_port() -> u16 {
    let p = ACTIVE_CDP_PORT.load(Ordering::Relaxed);
    if p == 0 { CDP_PORT } else { p }
}

#[cfg(target_os = "windows")]
pub(super) fn set_active_cdp_port(port: u16) {
    ACTIVE_CDP_PORT.store(port, Ordering::Relaxed);
}

/// 找一个可用的 CDP 端口：优先 9229，被占就让 OS 分配。
/// 解决 Codex kill 后 9229 socket 残留导致新实例 bind 失败的问题。
/// 学 CodexPlusPlus 的 select_windows_loopback_port：靠 TcpListener::bind 检测。
#[cfg(target_os = "windows")]
pub(super) fn select_available_cdp_port() -> u16 {
    // 先试 9229
    if std::net::TcpListener::bind(("127.0.0.1", CDP_PORT)).is_ok() {
        return CDP_PORT;
    }
    // 9229 被占 → 让 OS 分配一个随机可用端口
    match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener.local_addr().map(|a| a.port()).unwrap_or(CDP_PORT),
        Err(_) => CDP_PORT,
    }
}

/// 构造 CDP 启动参数（动态端口）
#[cfg(target_os = "windows")]
pub(super) fn cdp_launch_args(port: u16) -> String {
    format!(
        "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1 --remote-allow-origins=http://127.0.0.1:{port}"
    )
}
/// models_cache.json 中 AnyBridge 注入项的标记字段名（布尔），用于幂等替换/清理。
/// slug 本身保持原始模型名（与 catalog / proxy-routes / CDP 注入一致），不加前缀。
pub(super) const ANYBRIDGE_MANAGED_FLAG: &str = "anybridge_managed";
/// 旧版 slug 前缀（已废弃）。仅用于兼容清理历史残留的带前缀条目。
pub(super) const LEGACY_ANYBRIDGE_SLUG_PREFIX: &str = "anybridge:";

#[derive(Debug, Serialize, Clone)]
pub struct CodexDesktopResult {
    pub ok: bool,
    pub message: String,
    #[serde(rename = "managed")]
    pub managed: bool,
    #[serde(rename = "pid", skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

// ─── helpers ──────────────────────────────────────────────────────────

pub(super) fn codex_config_dir() -> Option<PathBuf> {
    codex_home()
}

/// 运行一段 PowerShell 脚本，返回 stdout（去掉首尾空白）。
/// 失败返回 stderr。
#[cfg(target_os = "windows")]
pub(super) fn run_powershell(script: &str) -> Result<String, String> {
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("PowerShell 执行失败: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

// ─── 原始 HTTP 探测（绕过系统代理，§4.17）──────────────────────────────
// reqwest 在本 crate 用了 default-features=false + rustls，没有 blocking feature。
// 这里直接用 TcpStream 发原始 HTTP，模式照搬 proxy.rs:441-460 probe_byok_stats。

/// 本机回环探测的两个候选地址：IPv4 优先，IPv6 兜底。
pub(super) fn local_loopback_addrs(port: u16) -> [SocketAddr; 2] {
    [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
    ]
}

/// 两个回环地址都连不上时的错误文本。
///
/// 必须保留**每个**地址的失败原因。只留最后一个会把真实原因（IPv4 被拒）盖掉，
/// 让人误判成 IPv6 问题——issue #38 现场就是被这行误导的。
pub(super) fn connect_error(port: u16, errors: &[String]) -> String {
    format!("无法连接 {port}：{}", errors.join("；"))
}

/// PowerShell：判断是否为 Codex Desktop 相关进程（宿主 / app-server / 排除 CLI）。
#[cfg(target_os = "windows")]
pub(super) const PS_CODEX_DESKTOP_PROCESS_FILTER: &str = r#"
function Test-CodexDesktopProcess($proc, [switch]$UiHostOnly) {
  if (-not $proc) { return $false }
  $name = [string]$proc.Name
  $path = if ($proc.ExecutablePath) { [string]$proc.ExecutablePath } else { '' }
  $cmd = if ($proc.CommandLine) { [string]$proc.CommandLine } else { '' }
  $blob = "$path $cmd"
  $isOpenAiCodexPkg = $blob -match 'OpenAI\.Codex'

  # 新版 Desktop 宿主：ChatGPT.exe（MSIX 包 OpenAI.Codex）
  if ($name -ieq 'ChatGPT.exe' -and $isOpenAiCodexPkg) { return $true }

  # Codex.exe / codex.exe：可能是旧版宿主，也可能是包内 app-server helper，还可能是 CLI
  if ($name -ieq 'Codex.exe' -or $name -ieq 'codex.exe') {
    $isAppServerHelper = ($path -match '(?i)[\\/]resources[\\/]codex\.exe') -or ($cmd -match '(?i)app-server')
    if ($isAppServerHelper) {
      # 仅 kill/残留检测需要 helper；watcher 的「是否在跑」绝不能认 helper
      return (-not $UiHostOnly) -and $isOpenAiCodexPkg
    }
    # CLI（npm 全局包 vendor/bin、node_modules）与 cargo 构建产物：
    # 这些目录不会出现 Desktop 宿主，认成宿主会杀掉用户正在跑的 CLI 会话，
    # 还会让「启动 Codex」永远返回「已在运行」（2026-10 实测复现）。
    $isCliLike = ($path -match '(?i)[\\/]node_modules[\\/]') `
      -or ($path -match '(?i)[\\/]vendor[\\/][^\\/]+[\\/]bin[\\/]codex\.exe') `
      -or ($path -match '(?i)[\\/]target[\\/](debug|release)[\\/]') `
      -or ($path -match '(?i)[\\/]\.cargo[\\/]bin[\\/]')
    if ($isCliLike -and -not $isOpenAiCodexPkg) { return $false }
    # 旧版 Desktop 宿主（Electron 主进程）
    return $true
  }
  return $false
}
"#;

/// 杀掉 Codex Desktop 宿主及其包内子进程，并确认退出。
///
/// 必须覆盖 ChatGPT.exe（新版宿主）与旧版 Codex.exe；同时清理包内 codex.exe。
/// 不碰 CLI / ACP / 第三方 adapter。
///
/// Stop-Process 不吞错；超时后再次尝试（MSIX 多进程结构下，

mod launch_and_http;
mod models_cache;
mod watcher;
pub(crate) use launch_and_http::http_post_local;
pub(crate) use models_cache::clean_models_cache;
pub use watcher::spawn_codex_desktop_watcher;
use launch_and_http::*;
use models_cache::*;

pub(super) fn ensure_injection_backend(app: Option<&AppHandle>) -> Result<(), String> {
    let app = app.ok_or("缺少应用句柄，无法确认本地网关服务状态")?;
    crate::commands::proxy::ensure_proxy_service_ready(app)
}

/// POST sidecar /__byok/codex-cdp/inject 触发 6 点补丁注入。
#[cfg(target_os = "windows")]
pub(super) fn inject_via_sidecar() -> Result<String, String> {
    inject_via_sidecar_on_port(current_cdp_port())
}

/// POST sidecar /__byok/codex-cdp/inject，指定 CDP 端口（动态端口用）。
pub(super) fn inject_via_sidecar_on_port(cdp_port: u16) -> Result<String, String> {
    let ports = configured_proxy_ports();
    let port = ports.api_port;
    let body = serde_json::json!({ "port": cdp_port }).to_string();
    let (status, text) = http_post_local(
        port,
        "/__byok/codex-cdp/inject",
        &body,
        Duration::from_secs(28),
    )?;
    if status.contains("200") {
        let parsed: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::json!({"ok": false}));
        let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        let msg = parsed
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if ok {
            Ok(msg)
        } else {
            // ok=false 时 message 可能为空，补充原始响应便于定位，不伪造"注入完成"
            Err(format!(
                "sidecar 注入返回失败: {}",
                if msg.is_empty() {
                    format!("ok=false, body={text}")
                } else {
                    msg
                }
            ))
        }
    } else {
        Err(format!("sidecar 注入 {status}: {text}"))
    }
}

/// POST sidecar /__byok/codex-cdp/check 检测注入标记是否存在。
#[cfg(target_os = "windows")]
pub(super) fn sidecar_injection_present() -> bool {
    let ports = configured_proxy_ports();
    let body = serde_json::json!({ "port": current_cdp_port() }).to_string();
    match http_post_local(
        ports.api_port,
        "/__byok/codex-cdp/check",
        &body,
        Duration::from_secs(3),
    ) {
        Ok((status, text)) if status.contains("200") => {
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("injected").and_then(|i| i.as_bool()))
                .unwrap_or(false)
        }
        _ => false,
    }
}

// ─── Codex Desktop 进程检测 ───────────────────────────────────────────

/// Desktop UI 宿主是否在跑。
/// 只认 ChatGPT.exe（OpenAI.Codex）或旧版 Codex.exe，不认包内 app-server / CLI。
/// watcher 与「已在运行」判断必须用这个，避免冷启动误接管。
#[cfg(target_os = "windows")]
pub(super) fn codex_running() -> bool {
    let script = format!(
        r#"{filter}
@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {{
  Test-CodexDesktopProcess $_ -UiHostOnly
}}).Count
"#,
        filter = PS_CODEX_DESKTOP_PROCESS_FILTER
    );
    match run_powershell(&script) {
        Ok(s) => s.trim().parse::<u32>().unwrap_or(0) > 0,
        Err(_) => false,
    }
}

/// Desktop 相关进程是否仍在（UI 宿主 + 包内 helper）。kill 等待用。
#[cfg(target_os = "windows")]
pub(super) fn codex_desktop_processes_present() -> bool {
    let script = format!(
        r#"{filter}
@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {{
  Test-CodexDesktopProcess $_
}}).Count
"#,
        filter = PS_CODEX_DESKTOP_PROCESS_FILTER
    );
    match run_powershell(&script) {
        Ok(s) => s.trim().parse::<u32>().unwrap_or(0) > 0,
        Err(_) => false,
    }
}

/// 列出仍存活的 Codex Desktop 相关进程 PID（kill 超时时用于诊断）
#[cfg(target_os = "windows")]
pub(super) fn remaining_codex_pids() -> String {
    let script = format!(
        r#"{filter}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {{
  Test-CodexDesktopProcess $_
}} | Select-Object -ExpandProperty ProcessId
"#,
        filter = PS_CODEX_DESKTOP_PROCESS_FILTER
    );
    match run_powershell(&script) {
        Ok(s) => s
            .lines()
            .filter(|l| l.trim().parse::<u32>().is_ok())
            .collect::<Vec<_>>()
            .join(","),
        Err(_) => String::new(),
    }
}

// ─── 主命令：重启 Codex Desktop ───────────────────────────────────────

/// 当前 Codex 配置是否需要 CDP 注入。
/// 读 providerStore → 找当前 codex 配置 → inject_models && !preserve_official_auth。
/// 与前端 `needInject = !preserveAuth && injectModels !== false` 保持一致：
/// preserveOfficialAuth=true 时 watcher 不得接管 / 补注入（保留官方登录模式）。
#[cfg(target_os = "windows")]
pub(super) fn codex_needs_cdp_injection() -> bool {
    let store = match read_provider_store() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let provider_id = match store.platforms.get("codex").map(|s| s.provider_id.as_str()) {
        Some(id) if !id.is_empty() => id,
        _ => return false,
    };
    store
        .codex_configs
        .iter()
        .find(|c| c.id == provider_id)
        .map(|c| c.inject_models && !c.preserve_official_auth)
        .unwrap_or(false)
}

/// CDP 注入是否需要。
/// 前端已把 preserveOfficialAuth 折算进 inject_models 参数：
/// true = kill + launch_cdp + inject；false = kill + launch_plain。
pub(super) fn needs_cdp(inject_models: bool) -> bool {
    inject_models
}

/// 内部编排（async，不阻塞 UI 主线程）：
///   managed=true  → 写 models_cache + kill + (inject_models=true→launch_with_cdp+inject；
///                   inject_models=false→launch_plain)
///   managed=false → 清 models_cache + kill + launch_plain
///
/// 就绪判断不用 poll /json（/json 200 ≠ renderer 就绪）。CDP 路径由
/// injectWithRetry 自带 renderer 就绪重试，拿到 page target 并装上 patch 才算成功。
/// 前端已把 preserveOfficialAuth 折算进 inject_models 参数。
async fn restart_codex_desktop_impl(
    app: Option<&AppHandle>,
    managed: bool,
    _model: &str,
    inject_models: bool,
) -> CodexDesktopResult {
    let progress = |step: &str, msg: &str| {
        if let Some(app) = app {
            crate::commands::platforms::emit_switch_progress(app, "codex", step, msg);
        }
    };
    if managed {
        // 0. 注入前置：先确认本地网关服务可用，再动用户的客户端。
        //    顺序不能反 —— 网关没起来时注入必然失败，先 kill 只会白重启一次窗口，
        //    还会把 Codex 配置留在「指向一个不存在的网关」的半成品状态。
        if needs_cdp(inject_models) {
            progress("preflight", "正在检查本地网关…");
            if let Err(e) = ensure_injection_backend(app) {
                return CodexDesktopResult {
                    ok: false,
                    message: format!("{MSG_PROXY_UNAVAILABLE}\n详情：{e}"),
                    managed,
                    pid: None,
                };
            }
        }

        // 1. 写 models_cache.json
        progress("models", "正在写入模型缓存…");
        if let Err(e) = write_models_cache() {
            return CodexDesktopResult {
                ok: false,
                message: format!("写入 Codex 模型缓存失败: {e}"),
                managed,
                pid: None,
            };
        }

        // 2. kill + 确认退出
        progress("stopping", "正在停止 Codex…");
        if let Err(e) = kill_codex() {
            return CodexDesktopResult {
                ok: false,
                message: format!("停止 Codex 失败: {e}"),
                managed,
                pid: None,
            };
        }

        // 3. 按 inject_models 分流（前端已折算 preserveOfficialAuth）
        if needs_cdp(inject_models) {
            progress("starting", "正在启动 Codex…");
            let (pid, cdp_port) = match launch_with_cdp() {
                Ok(v) => v,
                Err(e) => {
                    return CodexDesktopResult {
                        ok: false,
                        message: format!("启动 Codex Desktop (CDP) 失败: {e}"),
                        managed,
                        pid: None,
                    }
                }
            };
            progress("injecting", "正在注入模型…");
            match inject_via_sidecar_on_port(cdp_port) {
                Ok(_msg) => CodexDesktopResult {
                    ok: true,
                    message: "已重启 Codex 并解锁模型".to_string(),
                    managed,
                    pid: Some(pid),
                },
                Err(e) => CodexDesktopResult {
                    ok: false,
                    message: format!("{MSG_INJECT_FAILED}\n详情：PID {pid}；{e}"),
                    managed,
                    pid: Some(pid),
                },
            }
        } else {
            // inject_models=false：可能是关闭注入，或 preserveOfficialAuth 折算后的不注入。
            progress("starting", "正在重启 Codex…");
            match launch_plain() {
                Ok(pid) => CodexDesktopResult {
                    ok: true,
                    message: "已重启 Codex".to_string(),
                    managed,
                    pid: Some(pid),
                },
                Err(e) => CodexDesktopResult {
                    ok: false,
                    message: format!("启动 Codex Desktop 失败: {e}"),
                    managed,
                    pid: None,
                },
            }
        }
    } else {
        // 清理注入项
        progress("cleaning", "正在清理注入项…");
        if let Err(e) = clean_models_cache() {
            return CodexDesktopResult {
                ok: false,
                message: format!("清理 Codex 模型缓存失败: {e}"),
                managed,
                pid: None,
            };
        }
        progress("stopping", "正在停止 Codex…");
        if let Err(e) = kill_codex() {
            return CodexDesktopResult {
                ok: false,
                message: format!("停止 Codex 失败: {e}"),
                managed,
                pid: None,
            };
        }
        progress("starting", "正在启动 Codex…");
        match launch_plain() {
            Ok(pid) => CodexDesktopResult {
                ok: true,
                message: "已重启 Codex（官方登录）".to_string(),
                managed,
                pid: Some(pid),
            },
            Err(e) => CodexDesktopResult {
                ok: false,
                message: format!("启动 Codex Desktop 失败: {e}"),
                managed,
                pid: None,
            },
        }
    }
}

/// Tauri 命令：重启 Codex Desktop（async，不阻塞 UI 主线程）。
/// managed=true  → 自定义供应商模式（由 inject_models 决定 CDP+注入 或 launch_plain）
/// managed=false → 官方模式（普通启动，清理注入）
/// model = 切换的目标模型名（保留字段；CDP 分流不再按模型名判断）
/// inject_models = 是否启用桌面版 CDP 注入（前端已折算 preserveOfficialAuth；false 时永不 CDP）
#[tauri::command]
pub async fn restart_codex_desktop(
    app: AppHandle,
    managed: bool,
    model: Option<String>,
    inject_models: Option<bool>,
) -> CodexDesktopResult {
    let model = model.unwrap_or_default();
    let inject_models = inject_models.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(restart_codex_desktop_impl(Some(&app), managed, &model, inject_models))
    })
    .await
    .unwrap_or_else(|e| CodexDesktopResult {
        ok: false,
        message: format!("重启 Codex Desktop 任务执行异常: {e}"),
        managed,
        pid: None,
    })
}

/// Tauri 命令：手动启动 Codex。
/// injectModels=true → 走 CDP 启动 + 注入（用户从 AnyBridge 启动永远带 CDP，
/// watcher 不再需要接管）。injectModels=false → 普通启动，不碰 CDP。
/// Codex 没在跑时直接启动（不 kill）；在跑时提示"已在运行"（不重复 kill）。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn start_codex_with_cdp(
    app: AppHandle,
    inject_models: Option<bool>,
) -> CodexDesktopResult {
    let inject_models = inject_models.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        if codex_running() {
            return CodexDesktopResult {
                ok: true,
                message: "Codex 已在运行".to_string(),
                managed: false,
                pid: None,
            };
        }
        if inject_models {
            // 注入前置：网关不可用就别把 Codex 拉起来（否则起来也没模型可用于是白启一次）。
            if let Err(e) = ensure_injection_backend(Some(&app)) {
                return CodexDesktopResult {
                    ok: false,
                    message: format!("{MSG_PROXY_UNAVAILABLE}\n详情：{e}"),
                    managed: false,
                    pid: None,
                };
            }
            // 带 CDP 启动 + 注入
            let (pid, cdp_port) = match launch_with_cdp() {
                Ok(v) => v,
                Err(e) => {
                    return CodexDesktopResult {
                        ok: false,
                        message: format!("启动 Codex (CDP) 失败: {e}"),
                        managed: false,
                        pid: None,
                    }
                }
            };
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                if cdp_listening_on_port(cdp_port, Duration::from_millis(500)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            if !cdp_listening_on_port(cdp_port, Duration::from_millis(500)) {
                return CodexDesktopResult {
                    ok: false,
                    message: format!("{MSG_CDP_NOT_READY}\n详情：PID {pid}；{cdp_port} 未监听"),
                    managed: false,
                    pid: Some(pid),
                };
            }
            return match inject_via_sidecar_on_port(cdp_port) {
                Ok(_) => CodexDesktopResult {
                    ok: true,
                    message: "已启动 Codex 并解锁模型".to_string(),
                    managed: false,
                    pid: Some(pid),
                },
                Err(e) => CodexDesktopResult {
                    ok: false,
                    message: format!("{MSG_INJECT_FAILED}\n详情：PID {pid}；{e}"),
                    managed: false,
                    pid: Some(pid),
                },
            };
        }
        // 普通启动（不 CDP、不注入）
        match launch_plain() {
            Ok(pid) => CodexDesktopResult {
                ok: true,
                message: "已启动 Codex".to_string(),
                managed: false,
                pid: Some(pid),
            },
            Err(e) => CodexDesktopResult {
                ok: false,
                message: format!("启动 Codex 失败: {e}"),
                managed: false,
                pid: None,
            },
        }
    })
    .await
    .unwrap_or_else(|e| CodexDesktopResult {
        ok: false,
        message: format!("启动 Codex 任务执行异常: {e}"),
        managed: false,
        pid: None,
    })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn start_codex_with_cdp(
    _app: AppHandle,
    _inject_models: Option<bool>,
) -> CodexDesktopResult {
    CodexDesktopResult {
        ok: false,
        message: "Codex Desktop 启动仅支持 Windows".to_string(),
        managed: false,
        pid: None,
    }
}

// ─── 常驻 watcher（spec/31）────────────────────────────────────────────
//
// 检测 Codex Desktop UI 在跑但没注入（页面刷新 patch 丢失），自动补注入：
//   - CDP 通但 patch 没 → 直接补 inject（不 kill）
//   - CDP 不通 → 只通知用户从 AnyBridge 启动，不自动 kill + 重启
// 冷却退避避免频繁操作：成功 5s，失败 30s。随 AnyBridge 运行，不独立常驻。
//
// 硬约束：只在 Desktop UI 宿主（ChatGPT.exe/OpenAI.Codex 或旧版 Codex.exe）在跑时工作。
// 绝不因孤立的 codex.exe app-server / CLI / 第三方 adapter 去 launch Desktop。


#[cfg(test)]
mod tests;

