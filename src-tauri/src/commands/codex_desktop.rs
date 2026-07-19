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

use crate::commands::config::{configured_proxy_ports, read_provider_store, ModelCatalogEntry};
use crate::commands::platforms::{
    codex_bundled_model_template, codex_home, generate_model_catalog_json, is_codex_bundled_model,
    read_codex_model_template, resolve_codex_model_catalog_entries, CODEX_MODEL_CATALOG_FILENAME,
};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CDP_PORT: u16 = 9229;

/// 记录当前 Codex 实际使用的 CDP 端口（可能为动态端口）。
/// launch_with_cdp 时写入，watcher 和 injection check 读取。
/// 0 表示尚未启动过 CDP 模式，回退到 CDP_PORT。
static ACTIVE_CDP_PORT: AtomicU16 = AtomicU16::new(0);

fn current_cdp_port() -> u16 {
    let p = ACTIVE_CDP_PORT.load(Ordering::Relaxed);
    if p == 0 { CDP_PORT } else { p }
}

fn set_active_cdp_port(port: u16) {
    ACTIVE_CDP_PORT.store(port, Ordering::Relaxed);
}

/// 找一个可用的 CDP 端口：优先 9229，被占就让 OS 分配。
/// 解决 Codex kill 后 9229 socket 残留导致新实例 bind 失败的问题。
/// 学 CodexPlusPlus 的 select_windows_loopback_port：靠 TcpListener::bind 检测。
fn select_available_cdp_port() -> u16 {
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
fn cdp_launch_args(port: u16) -> String {
    format!(
        "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1 --remote-allow-origins=http://127.0.0.1:{port}"
    )
}
/// models_cache.json 中 AnyBridge 注入项的标记字段名（布尔），用于幂等替换/清理。
/// slug 本身保持原始模型名（与 catalog / proxy-routes / CDP 注入一致），不加前缀。
const ANYBRIDGE_MANAGED_FLAG: &str = "anybridge_managed";
/// 旧版 slug 前缀（已废弃）。仅用于兼容清理历史残留的带前缀条目。
const LEGACY_ANYBRIDGE_SLUG_PREFIX: &str = "anybridge:";

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

fn codex_config_dir() -> Option<PathBuf> {
    codex_home()
}

/// 运行一段 PowerShell 脚本，返回 stdout（去掉首尾空白）。
/// 失败返回 stderr。
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
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

#[cfg(not(target_os = "windows"))]
fn run_powershell(_script: &str) -> Result<String, String> {
    Err("Codex Desktop CDP 注入仅支持 Windows".to_string())
}

// ─── 原始 HTTP 探测（绕过系统代理，§4.17）──────────────────────────────
// reqwest 在本 crate 用了 default-features=false + rustls，没有 blocking feature。
// 这里直接用 TcpStream 发原始 HTTP，模式照搬 proxy.rs:441-460 probe_byok_stats。

/// 发送一个 GET 请求到 127.0.0.1:port/path，返回完整响应文本（含头）。
///
/// CDP 的 /json 响应不主动关闭连接（keep-alive），read_to_string 会等到
/// 超时才返回 Err。这里改成读到数据就返回：先读到第一个响应字节，再尝试
/// 短暂继续读（40ms 内还有数据就继续拼），没有更多数据就返回已读内容。
fn http_get_local(port: u16, path: &str, timeout: Duration) -> Result<String, String> {
    let addrs = [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
    ];
    let mut last_err = String::new();
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, timeout) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                stream
                    .write_all(
                        format!(
                            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .map_err(|e| format!("发送请求失败: {e}"))?;
                let mut buf = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096];
                    match stream.read(&mut chunk) {
                        Ok(0) => break, // 连接关闭
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            // 已有数据，短暂等待看是否还有更多（避免 keep-alive 挂死）
                            stream
                                .set_read_timeout(Some(Duration::from_millis(40)))
                                .ok();
                        }
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            break
                        }
                        Err(e) => return Err(format!("读取响应失败: {e}")),
                    }
                }
                return Ok(String::from_utf8_lossy(&buf).to_string());
            }
            Err(e) => last_err = format!("{addr}: {e}"),
        }
    }
    Err(format!("无法连接 {port}: {last_err}"))
}

/// 发送一个 POST 请求（JSON body）到 127.0.0.1:port/path，返回 (status_line, body)。
///
/// body 提取后会解码 chunked transfer encoding（sidecar 的 Node http 在未设
/// Content-Length 时用 chunked）。不解 chunked 会导致 JSON 前出现 chunk size
/// 标记（如 "b4\r\n{...}"），serde 解析失败误判 ok=false。
fn http_post_local(
    port: u16,
    path: &str,
    body: &str,
    timeout: Duration,
) -> Result<(String, String), String> {
    let addrs = [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
    ];
    let mut last_err = String::new();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, timeout) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                stream
                    .write_all(request.as_bytes())
                    .map_err(|e| format!("发送请求失败: {e}"))?;
                let mut buf = String::new();
                stream
                    .read_to_string(&mut buf)
                    .map_err(|e| format!("读取响应失败: {e}"))?;
                let (status, rest) = buf
                    .split_once("\r\n")
                    .map(|(s, r)| (s.to_string(), r.to_string()))
                    .unwrap_or((buf.clone(), String::new()));
                let (headers, body) = rest
                    .split_once("\r\n\r\n")
                    .map(|(h, b)| (h.to_string(), b.to_string()))
                    .unwrap_or((String::new(), String::new()));
                // chunked 解码：body 形如 "b4\r\n{json}\r\n0\r\n\r\n"
                let body = if headers
                    .to_ascii_lowercase()
                    .contains("transfer-encoding: chunked")
                {
                    decode_chunked(&body)
                } else {
                    body
                };
                return Ok((status, body));
            }
            Err(e) => last_err = format!("{addr}: {e}"),
        }
    }
    Err(format!("无法连接 {port}: {last_err}"))
}

/// 解码 HTTP chunked transfer encoding。
/// 输入形如 "b4\r\n{json}\r\n0\r\n\r\n"，输出 "{json}"。
/// 解码失败返回原文（让上层解析报错暴露，不静默）。
fn decode_chunked(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let (size_line, after) = match rest.split_once("\r\n") {
            Some(p) => p,
            None => break,
        };
        let size =
            usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0").trim(), 16)
                .unwrap_or(0);
        if size == 0 {
            break;
        }
        if after.len() < size {
            break;
        }
        out.push_str(&after[..size]);
        // 跳过 size 字节后的 \r\n
        rest = if after.len() >= size + 2 {
            &after[size + 2..]
        } else {
            ""
        };
    }
    if out.is_empty() {
        body.to_string()
    } else {
        out
    }
}

// ─── MSIX 检测 ────────────────────────────────────────────────────────

/// MSIX 安装信息。
#[derive(Debug, Clone, Serialize)]
struct CodexMsixInfo {
    /// AppUserModelId，形如 `OpenAI.Codex_2p2nqsd0c76g0!App`
    aumid: String,
    install_location: String,
    version: String,
}

/// 通过 `Get-AppxPackage -Name OpenAI.Codex` 检测安装信息并推导 AUMID。
/// AUMID = PackageFamilyName + "!App"（与 CodexPlusPlus packaged_app_user_model_id 一致）。
#[cfg(target_os = "windows")]
fn find_codex_msix() -> Result<CodexMsixInfo, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
$pkg = Get-AppxPackage -Name 'OpenAI.Codex'
if (-not $pkg) { Write-Output 'NOT_FOUND'; exit 0 }
$obj = @{
    PackageFamilyName = $pkg.PackageFamilyName
    InstallLocation   = $pkg.InstallLocation
    Version           = $pkg.Version.ToString()
}
$obj | ConvertTo-Json -Compress
"#;
    let raw = run_powershell(script)?;
    if raw == "NOT_FOUND" || raw.is_empty() {
        return Err("未检测到已安装的 Codex Desktop（OpenAI.Codex）".to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析 Get-AppxPackage 结果失败: {e}"))?;
    let family = parsed
        .get("PackageFamilyName")
        .and_then(|v| v.as_str())
        .ok_or("Get-AppxPackage 缺少 PackageFamilyName")?;
    let install_location = parsed
        .get("InstallLocation")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = parsed
        .get("Version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(CodexMsixInfo {
        aumid: format!("{family}!App"),
        install_location,
        version,
    })
}

#[cfg(not(target_os = "windows"))]
fn find_codex_msix() -> Result<CodexMsixInfo, String> {
    Err("Codex Desktop CDP 注入仅支持 Windows".to_string())
}

// ─── kill ────────────────────────────────────────────────────────────

/// PowerShell：判断是否为 Codex Desktop 相关进程。
/// - UI 宿主：ChatGPT.exe（路径/命令行含 OpenAI.Codex），或旧版 Electron 宿主 Codex.exe
/// - 包内 helper：OpenAI.Codex 包下的 resources\codex.exe（app-server）
/// 明确排除：npm CLI、codex-acp、cockpit-codex-adapter 等第三方进程。
///
/// 注意：Win32 进程名大小写不稳定，不能用 -ieq 'Codex.exe' 区分宿主与 app-server。
/// app-server 特征：路径含 \resources\codex.exe，或命令行含 app-server。
#[cfg(target_os = "windows")]
const PS_CODEX_DESKTOP_PROCESS_FILTER: &str = r#"
function Test-CodexDesktopProcess($proc, [switch]$UiHostOnly) {
  if (-not $proc) { return $false }
  $name = [string]$proc.Name
  $path = if ($proc.ExecutablePath) { [string]$proc.ExecutablePath } else { '' }
  $cmd = if ($proc.CommandLine) { [string]$proc.CommandLine } else { '' }
  $blob = "$path $cmd"
  $isOpenAiCodexPkg = $blob -match 'OpenAI\.Codex'

  # 新版 Desktop 宿主：ChatGPT.exe（MSIX 包 OpenAI.Codex）
  if ($name -ieq 'ChatGPT.exe' -and $isOpenAiCodexPkg) { return $true }

  # Codex.exe / codex.exe：可能是旧版宿主，也可能是包内 app-server helper
  if ($name -ieq 'Codex.exe' -or $name -ieq 'codex.exe') {
    $isAppServerHelper = ($path -match '(?i)[\\/]resources[\\/]codex\.exe') -or ($cmd -match '(?i)app-server')
    if ($isAppServerHelper) {
      # 仅 kill/残留检测需要 helper；watcher 的「是否在跑」绝不能认 helper
      return (-not $UiHostOnly) -and $isOpenAiCodexPkg
    }
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
/// 部分子进程需等父进程死后才能退出），再超时则暴露剩余 PID 供诊断。
fn kill_codex() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 两轮 Stop-Process：第二轮针对第一轮残留的子进程（需等父进程死后才能退）
        for _ in 0..2 {
            let script = format!(
                r#"{filter}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {{
  Test-CodexDesktopProcess $_
}} | ForEach-Object {{
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}}
"#,
                filter = PS_CODEX_DESKTOP_PROCESS_FILTER
            );
            run_powershell(&script)?;
            // 只等进程归零。9229 端口 TIME_WAIT 残留是 OS 正常状态，
            // launch_with_cdp 启动的新进程可复用同一端口（OS SO_REUSEADDR 行为）。
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if !codex_desktop_processes_present() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        // 进程都退不掉，暴露剩余 PID
        let pids = remaining_codex_pids();
        Err(format!(
            "Codex 旧进程未能在 16s 内退出。残留 PID: {}。请手动结束这些进程后重试切换。",
            if pids.is_empty() {
                "无（异常状态）".to_string()
            } else {
                pids
            }
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Codex Desktop CDP 注入仅支持 Windows".to_string())
    }
}


// ─── COM 激活启动 ─────────────────────────────────────────────────────

/// 用 ApplicationActivationManager COM 激活 Codex（MSIX），带 CDP 调试参数。
/// 直接 spawn Codex.exe 会绕过 UWP 沙箱 → Statsig 拿不到 userID → "糟糕出错了"。
/// 移植自 CodexPlusPlus launcher.py:202-259（Python ctypes COM 调用），
/// 这里用 PowerShell 晚绑定 COM，避免 Rust 手写 FFI。
#[cfg(target_os = "windows")]
pub fn launch_with_cdp() -> Result<(u32, u16), String> {
    let port = select_available_cdp_port();
    let msix = find_codex_msix()?;
    let aumid = msix.aumid;
    // 用内联 C# + Add-Type 调 COM vtable。[ComImport] 类不能 New-Object，
    // 必须走 IUnknown vtable（CoCreateInstance + IID_PPV_ARGS）。
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
if (-not ('IApplicationActivationManager' -as [type])) {{
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {{
    [PreserveSig]
    uint ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}}
public class CodexLauncher {{
    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);
    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid iid, out IntPtr ppv);
    [DllImport("ole32.dll")]
    static extern void CoUninitialize();
    [DllImport("ole32.dll")]
    static extern int CoInitializeSecurity(
        IntPtr pSecDesc, int cAuthSvc, IntPtr asAuthSvc, IntPtr pReserved1, int level, int impers, IntPtr pAuthList, int cbCapabilities, IntPtr pReserved3);

    public static uint Launch(string aumid, string args) {{
        CoInitializeEx(IntPtr.Zero, 2);  // COINIT_APARTMENTTHREADED
        Guid clsid = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
        Guid iid   = new Guid("2e941141-7f97-4756-ba1d-9decde894a3d");
        IntPtr punk = IntPtr.Zero;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out punk);  // CLSCTX_INPROC_SERVER=1
        if (hr < 0) throw new Exception("CoCreateInstance HRESULT: 0x" + hr.ToString("X8"));
        try {{
            var mgr = (IApplicationActivationManager)Marshal.GetObjectForIUnknown(punk);
            uint pid;
            hr = (int)mgr.ActivateApplication(aumid, args, 0, out pid);
            if (hr != 0) throw new Exception("ActivateApplication HRESULT: 0x" + hr.ToString("X8"));
            return pid;
        }} finally {{
            Marshal.Release(punk);
        }}
    }}
}}
'@
}}
[CodexLauncher]::Launch('{aumid}', '{args}')
"#,
        aumid = aumid,
        args = cdp_launch_args(port)
    );
    let raw = run_powershell(&script)?;
    let pid: u32 = raw
        .trim()
        .parse()
        .map_err(|e| format!("COM 激活返回的 PID 解析失败: {e} (raw={raw})"))?;
    set_active_cdp_port(port);
    Ok((pid, port))
}

#[cfg(not(target_os = "windows"))]
fn launch_with_cdp() -> Result<(u32, u16), String> {
    Err("Codex Desktop CDP 注入仅支持 Windows".to_string())
}

/// 普通模式启动 Codex（无 CDP，切回官方用）。
#[cfg(target_os = "windows")]
fn launch_plain() -> Result<u32, String> {
    let msix = find_codex_msix()?;
    let aumid = msix.aumid;
    // 同 launch_with_cdp：[ComImport] 类不能 New-Object，走 CoCreateInstance。
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
if (-not ('IApplicationActivationManager' -as [type])) {{
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {{
    [PreserveSig]
    uint ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}}
public class CodexLauncher {{
    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);
    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid iid, out IntPtr ppv);
    [DllImport("ole32.dll")]
    static extern void CoUninitialize();

    public static uint Launch(string aumid, string args) {{
        CoInitializeEx(IntPtr.Zero, 2);
        Guid clsid = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
        Guid iid   = new Guid("2e941141-7f97-4756-ba1d-9decde894a3d");
        IntPtr punk = IntPtr.Zero;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out punk);
        if (hr < 0) throw new Exception("CoCreateInstance HRESULT: 0x" + hr.ToString("X8"));
        try {{
            var mgr = (IApplicationActivationManager)Marshal.GetObjectForIUnknown(punk);
            uint pid;
            hr = (int)mgr.ActivateApplication(aumid, args, 0, out pid);
            if (hr != 0) throw new Exception("ActivateApplication HRESULT: 0x" + hr.ToString("X8"));
            return pid;
        }} finally {{
            Marshal.Release(punk);
        }}
    }}
}}
'@
}}
[CodexLauncher]::Launch('{aumid}', '')
"#,
        aumid = aumid
    );
    let raw = run_powershell(&script)?;
    let pid: u32 = raw
        .trim()
        .parse()
        .map_err(|e| format!("COM 激活返回的 PID 解析失败: {e} (raw={raw})"))?;
    Ok(pid)
}

#[cfg(not(target_os = "windows"))]
fn launch_plain() -> Result<u32, String> {
    Err("Codex Desktop CDP 注入仅支持 Windows".to_string())
}

// ─── CDP 就绪 ─────────────────────────────────────────────────────────
//
// 不再有 poll_cdp_ready：/json 200 ≠ renderer 就绪（实测 launch 后 1s 就 200，
// 但 renderer 要 ~4s 才加载完 __STATSIG__）。就绪判断交给 injectWithRetry——
// inject 自己会重试连 CDP，拿到 page target 并装上 patch 才算就绪，失败则
// 暴露真实原因（ECONNREFUSED / No page target / patch 异常）。

/// watcher 用的慢探测：给足响应时间，避免 renderer 加载中 /json 响应慢被误判为没监听。
fn cdp_listening_slow() -> bool {
    cdp_listening_on_port(current_cdp_port(), Duration::from_secs(2))
}

/// 探测指定端口是否在监听（动态端口用）
fn cdp_listening_on_port(port: u16, timeout: Duration) -> bool {
    match http_get_local(port, "/json", timeout) {
        Ok(_) => true,
        Err(_) => false,
    }
}

// ─── models_cache.json 注入 ───────────────────────────────────────────

/// 从当前 Codex 平台绑定的配置合成 catalog 条目。
fn current_codex_catalog_entries() -> Result<Vec<ModelCatalogEntry>, String> {
    let store = read_provider_store()?;
    let provider_id = store
        .platforms
        .get("codex")
        .map(|s| s.provider_id.clone())
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            "当前未绑定 Codex 供应商配置，无法生成模型目录。请先在「更多平台」切换一次 Codex。"
                .to_string()
        })?;
    let provider = store
        .codex_configs
        .iter()
        .find(|c| c.id == provider_id)
        .cloned()
        .map(crate::commands::config::Provider::from)
        .ok_or_else(|| format!("Codex 配置不存在: {provider_id}"))?;
    let entries = resolve_codex_model_catalog_entries(&provider);
    if entries.is_empty() {
        return Err(format!(
            "Codex 配置「{}」未提供可用模型（modelCatalog / models / defaultModel 均为空）",
            provider.name
        ));
    }
    Ok(entries)
}

/// 确保 `anybridge-model-catalog.json` 存在；缺失或空时从 provider store 重建。
fn ensure_anybridge_catalog_file(dir: &std::path::Path) -> Result<PathBuf, String> {
    let catalog_file = dir.join(CODEX_MODEL_CATALOG_FILENAME);
    let needs_rebuild = match std::fs::read_to_string(&catalog_file) {
        Ok(raw) => {
            let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok();
            match parsed.as_ref().and_then(catalog_models_array) {
                Some(arr) => !arr.iter().any(|m| extract_model_slug(m).is_some()),
                None => true,
            }
        }
        Err(_) => true,
    };
    if needs_rebuild {
        let entries = current_codex_catalog_entries()?;
        let catalog_json = generate_model_catalog_json(&entries)?;
        std::fs::create_dir_all(dir).map_err(|e| {
            format!("创建 Codex 配置目录失败 ({}): {e}", dir.display())
        })?;
        crate::commands::write_atomic(&catalog_file, catalog_json.as_bytes())?;
    }
    Ok(catalog_file)
}

/// 读取 AnyBridge catalog（缺失时从当前 Codex 配置重建），
/// 提取需要注入到 models_cache.json 的模型列表。
fn read_anybridge_catalog_models() -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位 Codex 配置目录（CODEX_HOME / ~/.codex）".to_string());
    };
    let catalog_file = ensure_anybridge_catalog_file(&dir)?;
    let raw = std::fs::read_to_string(&catalog_file)
        .map_err(|e| format!("读取 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let models: Vec<serde_json::Value> = catalog_models_array(&parsed)
        .map(|a| {
            a.iter()
                .filter(|m| extract_model_slug(m).is_some())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err(format!(
            "Codex 模型目录没有可注入模型: {}",
            catalog_file.display()
        ));
    }
    Ok(models)
}

fn catalog_models_array(parsed: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    if parsed.is_array() {
        parsed.as_array()
    } else {
        parsed.get("models").and_then(|m| m.as_array())
    }
}

fn extract_model_slug(model: &serde_json::Value) -> Option<String> {
    model
        .get("slug")
        .and_then(|s| s.as_str())
        .or_else(|| model.get("model").and_then(|s| s.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn read_anybridge_catalog_slugs_if_present() -> Result<HashSet<String>, String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位用户主目录".to_string());
    };
    let catalog_file = dir.join("anybridge-model-catalog.json");
    if !catalog_file.exists() {
        return Ok(HashSet::new());
    }
    let raw = std::fs::read_to_string(&catalog_file)
        .map_err(|e| format!("读取 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 Codex 模型目录失败 ({}): {e}", catalog_file.display()))?;
    let models = catalog_models_array(&parsed)
        .ok_or_else(|| format!("Codex 模型目录缺少 models 数组: {}", catalog_file.display()))?;
    Ok(models.iter().filter_map(extract_model_slug).collect())
}

/// models_cache.json 不存在时返回 Err（不静默退化，debug-first 原则）。
/// 实际数据来自 read_codex_model_template() 复用官方 gpt-5.5 模板。
fn empty_models_cache() -> serde_json::Value {
    serde_json::json!({
        "fetched_at": "",
        "etag": "",
        "models": []
    })
}

/// 把 AnyBridge catalog 中的自定义模型注入 ~/.codex/models_cache.json。
///
/// 治本方案：复用 `platforms::read_codex_model_template()` 拿到的官方 gpt-5.5
/// 完整条目作为模板，对每个自定义模型做 deep-clone 后只覆盖 6 个字段
/// （slug / display_name / description / context_window / max_context_window /
/// 其它全从官方模板继承，包含 base_instructions / model_messages / comp_hash
/// / input_modalities 等 26+ 字段），保证 Codex Desktop 启动时不会因字段
/// 不全而丢弃注入项。
///
/// 幂等 + 防污染：先删除旧的 AnyBridge 注入项（按 `anybridge_managed` 标记，
/// 兼容清理旧版 `anybridge:` 前缀残留，以及命中本次注入集合的同名条目——
/// 后者用于清掉历史上 JS `prePatchModelsCache` 写入的无前缀残留），再插入。
/// slug 保持原始模型名（不加前缀），保证与 catalog / proxy-routes / CDP 注入一致。
fn write_models_cache() -> Result<(), String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位用户主目录".to_string());
    };
    let cache_path = dir.join("models_cache.json");
    let models = read_anybridge_catalog_models()?;

    // 读取现有 cache（不存在用空结构，fetched_at/etag 后续按需补）
    let raw = std::fs::read_to_string(&cache_path).unwrap_or_default();
    let mut cache: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| empty_models_cache());

    // 确保 cache.models 是数组
    if !cache.get("models").map(|m| m.is_array()).unwrap_or(false) {
        cache["models"] = serde_json::json!([]);
    }
    let arr = cache["models"].as_array_mut().unwrap();

    // 模板优先级：
    //   1) platforms::read_codex_model_template()
    //      — models_cache 官方条目优先，缺失时回退内嵌 gpt-5.5
    //   2) 当前 cache 中第一个非 AnyBridge 注入的条目
    let template = read_codex_model_template().or_else(|| {
        arr.iter()
            .find(|m| {
                // 排除我们自己的注入项（标记 / 旧前缀残留），只挑真正的官方条目做模板
                if m.get(ANYBRIDGE_MANAGED_FLAG)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    return false;
                }
                let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
                !slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX) && !slug.is_empty()
            })
            .cloned()
    });

    let template = template.ok_or_else(|| {
        format!(
            "无法解析 Codex 模型模板：{} 与内嵌 gpt-5.5 均不可用。",
            cache_path.display()
        )
    })?;

    // 本次要注入的原始 slug 集合（用于清掉 JS prePatchModelsCache 历史写入的同名无前缀残留）。
    let inject_slugs: std::collections::HashSet<String> = models
        .iter()
        .filter_map(|m| {
            m.get("slug")
                .and_then(|s| s.as_str())
                .or_else(|| m.get("model").and_then(|s| s.as_str()))
                .map(|s| s.to_string())
        })
        .collect();

    // 移除旧的 AnyBridge 注入项：
    //   1) 带 anybridge_managed 标记（当前方案）
    //   2) slug 以 "anybridge:" 开头（旧前缀方案残留，兼容清理）
    //   3) slug 命中本次注入集合（JS prePatchModelsCache 历史写入的同名无前缀条目）
    arr.retain(|m| {
        if m.get(ANYBRIDGE_MANAGED_FLAG)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return false;
        }
        let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
        if slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX) {
            return false;
        }
        !inject_slugs.contains(slug)
    });

    // 注入每个自定义模型
    for (i, entry) in models.iter().enumerate() {
        let slug = entry
            .get("slug")
            .and_then(|s| s.as_str())
            .or_else(|| entry.get("model").and_then(|s| s.as_str()))
            .unwrap_or("")
            .to_string();
        if slug.is_empty() {
            continue;
        }
        let display = entry
            .get("display_name")
            .and_then(|s| s.as_str())
            .unwrap_or(&slug)
            .to_string();

        let mut model_obj = if is_codex_bundled_model(&slug) {
            // ── 新版逻辑：使用 bundled catalog 完整定义 ──
            let (mut model, _) = codex_bundled_model_template(&slug);
            let obj = model
                .as_object_mut()
                .expect("Bundled model template should be a JSON object");
            obj["priority"] = serde_json::json!(1000 + i);
            if !display.is_empty() && display != slug {
                obj["display_name"] = serde_json::json!(display);
            }
            if let Some(ctx_val) = entry.get("context_window").and_then(|c| c.as_u64()) {
                obj["context_window"] = serde_json::json!(ctx_val);
                obj["max_context_window"] = serde_json::json!(ctx_val);
            }
            obj.insert("supported_in_api".to_string(), serde_json::Value::Bool(true));
            if !obj.contains_key("visibility") {
                obj.insert("visibility".to_string(), serde_json::Value::String("list".to_string()));
            }
            model
        } else {
            // ── 旧版逻辑：从 models_cache.json 的 gpt-5.5 模板 deep-clone ──
            let ctx_default = template
                .get("context_window")
                .and_then(|c| c.as_u64())
                .unwrap_or(128000);
            let ctx = entry
                .get("context_window")
                .and_then(|c| c.as_u64())
                .unwrap_or(ctx_default);
            let mut obj = template.clone();
            obj["slug"] = serde_json::json!(slug);
            obj["display_name"] = serde_json::json!(display);
            obj["description"] = serde_json::json!(display);
            obj["context_window"] = serde_json::json!(ctx);
            obj["max_context_window"] = serde_json::json!(ctx);
            obj["priority"] = serde_json::json!(1000 + i);
            obj
        };

        // slug 必须与 anybridge-model-catalog.json / proxy-routes / CDP 注入完全一致
        // （原始模型名，不加任何前缀）。否则用户在 Desktop 选中后，Codex 发给本地代理的
        // model 名对不上路由表，resolveProxyModel 直接报"模型不在本地代理模型列表中"。
        // 幂等清理改用独立标记字段 anybridge_managed（Codex 读 models_cache 时忽略未知字段，已验证）。
        model_obj["slug"] = serde_json::json!(slug);
        model_obj[ANYBRIDGE_MANAGED_FLAG] = serde_json::json!(true);
        arr.push(model_obj);
    }

    let out = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&cache_path, out.as_bytes())
}

/// 清理 ~/.codex/models_cache.json 中的 AnyBridge 注入项（切回官方用）。
pub(crate) fn clean_models_cache() -> Result<(), String> {
    let Some(dir) = codex_config_dir() else {
        return Err("无法定位用户主目录".to_string());
    };
    let cache_path = dir.join("models_cache.json");
    let Ok(raw) = std::fs::read_to_string(&cache_path) else {
        return Ok(()); // 不存在，无需清理
    };
    let mut cache = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 Codex 模型缓存失败 ({}): {e}", cache_path.display()))?;
    let catalog_slugs = read_anybridge_catalog_slugs_if_present()?;
    let arr = cache
        .get_mut("models")
        .and_then(|m| m.as_array_mut())
        .ok_or_else(|| format!("Codex 模型缓存缺少 models 数组: {}", cache_path.display()))?;
    let before = arr.len();
    arr.retain(|m| {
        if m.get(ANYBRIDGE_MANAGED_FLAG)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return false;
        }
        let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
        if slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX) {
            return false;
        }
        !catalog_slugs.contains(slug)
    });
    if arr.len() != before {
        let out = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
        crate::commands::write_atomic(&cache_path, out.as_bytes())?;
    }
    Ok(())
}

// ─── 通过 sidecar 注入 CDP 补丁 ────────────────────────────────────────

/// POST sidecar /__byok/codex-cdp/inject 触发 6 点补丁注入。
fn inject_via_sidecar() -> Result<String, String> {
    inject_via_sidecar_on_port(current_cdp_port())
}

/// POST sidecar /__byok/codex-cdp/inject，指定 CDP 端口（动态端口用）。
fn inject_via_sidecar_on_port(cdp_port: u16) -> Result<String, String> {
    let ports = configured_proxy_ports();
    let port = ports.api_port;
    let body = serde_json::json!({ "port": cdp_port }).to_string();
    let (status, text) = http_post_local(
        port,
        "/__byok/codex-cdp/inject",
        &body,
        Duration::from_secs(25),
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
fn sidecar_injection_present() -> bool {
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
fn codex_running() -> bool {
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

#[cfg(not(target_os = "windows"))]
fn codex_running() -> bool {
    false
}

/// Desktop 相关进程是否仍在（UI 宿主 + 包内 helper）。kill 等待用。
#[cfg(target_os = "windows")]
fn codex_desktop_processes_present() -> bool {
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
fn remaining_codex_pids() -> String {
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

#[cfg(not(target_os = "windows"))]
fn remaining_codex_pids() -> String {
    String::new()
}


// ─── 主命令：重启 Codex Desktop ───────────────────────────────────────

/// 当前 Codex 配置是否需要 CDP 注入。
/// 读 providerStore → 找当前 codex 配置 → inject_models && !preserve_official_auth。
/// 与前端 `needInject = !preserveAuth && injectModels !== false` 保持一致：
/// preserveOfficialAuth=true 时 watcher 不得接管 / 补注入（保留官方登录模式）。
fn codex_needs_cdp_injection() -> bool {
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
fn needs_cdp(inject_models: bool) -> bool {
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
            progress("starting", "正在以调试模式启动 Codex…");
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
            progress("injecting", "正在等待 Codex 渲染进程就绪并注入…");
            match inject_via_sidecar_on_port(cdp_port) {
                Ok(_msg) => CodexDesktopResult {
                    ok: true,
                    message: "已重启 Codex 并解锁第三方模型".to_string(),
                    managed,
                    pid: Some(pid),
                },
                Err(e) => CodexDesktopResult {
                    ok: false,
                    message: format!("Codex 已启动 (PID {pid})，但模型注入未完成: {e}"),
                    managed,
                    pid: Some(pid),
                },
            }
        } else {
            // inject_models=false：可能是关闭注入，或 preserveOfficialAuth 折算后的不注入。
            progress("starting", "正在重启 Codex（不进行模型注入）…");
            match launch_plain() {
                Ok(pid) => CodexDesktopResult {
                    ok: true,
                    message: "已重启 Codex（未进行模型注入）".to_string(),
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
        progress("starting", "正在启动 Codex（官方模式）…");
        match launch_plain() {
            Ok(pid) => CodexDesktopResult {
                ok: true,
                message: "已重启 Codex 桌面版（官方模式）".to_string(),
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
    restart_codex_desktop_impl(Some(&app), managed, &model, inject_models).await
}

/// Tauri 命令：手动启动 Codex。
/// injectModels=true → 走 CDP 启动 + 注入（用户从 AnyBridge 启动永远带 CDP，
/// watcher 不再需要接管）。injectModels=false → 普通启动，不碰 CDP。
/// Codex 没在跑时直接启动（不 kill）；在跑时提示"已在运行"（不重复 kill）。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn start_codex_with_cdp(inject_models: Option<bool>) -> CodexDesktopResult {
    let inject_models = inject_models.unwrap_or(true);
    if codex_running() {
        return CodexDesktopResult {
            ok: true,
            message: "Codex 已在运行".to_string(),
            managed: false,
            pid: None,
        };
    }
    if inject_models {
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
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if cdp_listening_on_port(cdp_port, Duration::from_millis(500)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        if !cdp_listening_on_port(cdp_port, Duration::from_millis(500)) {
            return CodexDesktopResult {
                ok: false,
                message: format!("Codex 已启动 (PID {pid})，但 {cdp_port} 在 15s 内未就绪"),
                managed: false,
                pid: Some(pid),
            };
        }
        return match inject_via_sidecar_on_port(cdp_port) {
            Ok(_) => CodexDesktopResult {
                ok: true,
                message: "已启动 Codex（带 CDP）并解锁第三方模型".to_string(),
                managed: false,
                pid: Some(pid),
            },
            Err(e) => CodexDesktopResult {
                ok: false,
                message: format!("Codex 已启动 (PID {pid})，但注入失败: {e}"),
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
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn start_codex_with_cdp(_inject_models: Option<bool>) -> CodexDesktopResult {
    CodexDesktopResult {
        ok: false,
        message: "Codex Desktop 启动仅支持 Windows".to_string(),
        managed: false,
        pid: None,
    }
}

// ─── 常驻 watcher（spec/31）────────────────────────────────────────────
//
// 检测 Codex Desktop UI 在跑但没注入（用户手动重开 / 页面刷新 patch 丢失），自动接管：
//   - 9229 通但 patch 没 → 直接补 inject（不 kill）
//   - 9229 不通 → kill + launch_with_cdp + inject
// 冷却退避避免死循环：成功 15s，失败 30s。随 AnyBridge 运行，不独立常驻。
//
// 硬约束：只在 Desktop UI 宿主（ChatGPT.exe/OpenAI.Codex 或旧版 Codex.exe）在跑时工作。
// 绝不因孤立的 codex.exe app-server / CLI / 第三方 adapter 去 launch Desktop。

/// 启动常驻 watcher 后台线程。在 lib.rs setup 闭包里调一次。
/// 仅 Windows 有意义（Codex Desktop MSIX + CDP）；其它平台直接 no-op。
pub fn spawn_codex_desktop_watcher(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(move || {
            watch_loop(app);
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "windows")]
const WATCHER_INTERVAL: Duration = Duration::from_secs(3);
/// 启动宽限期：AnyBridge 启动后这段时间内 watcher 只做非破坏性操作（补注入），
/// 不做 takeover（kill + 重启），避免「打开 AnyBridge → Codex 被杀重启」的体验。
#[cfg(target_os = "windows")]
const WATCHER_STARTUP_GRACE: Duration = Duration::from_secs(15);
/// takeover 成功后冷却：防止接管刚完成的 Codex 在 renderer 加载期间被误判重新接管。
/// 之前 30s 太长，用户重开 Codex 后要等冷却到期才检测，体感慢。http_get_local
/// 修了 keep-alive 误判后，5s 足够 Codex 稳定。
#[cfg(target_os = "windows")]
const WATCHER_COOLDOWN_AFTER_SUCCESS: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const WATCHER_COOLDOWN_AFTER_FAILURE: Duration = Duration::from_secs(30);

/// watcher 主循环：每 3 秒检查一次。
#[cfg(target_os = "windows")]
fn watch_loop(app: AppHandle) {
    let mut cooldown_until: Option<Instant> = None;
    let started_at = Instant::now();
    loop {
        run_watcher_tick(&app, &mut cooldown_until, started_at);
        std::thread::sleep(WATCHER_INTERVAL);
    }
}

/// 单次检查逻辑。
/// watcher 只在 codex_needs_cdp_injection() 为 true 时工作：
/// injectModels=true 且 preserveOfficialAuth=false。
/// 否则整条 CDP 流程不触发——不检测 CDP、不接管、不补注入。
/// 且必须确认 Desktop UI 宿主在跑；仅有 app-server/CLI 不算。
/// 启动宽限期内（WATCHER_STARTUP_GRACE）不做 takeover，避免打开 AnyBridge 就杀 Codex。
#[cfg(target_os = "windows")]
fn run_watcher_tick(app: &AppHandle, cooldown_until: &mut Option<Instant>, started_at: Instant) {
    if !codex_needs_cdp_injection() {
        *cooldown_until = None;
        return;
    }
    // Desktop UI 没在跑，不接管（绝不凭空 launch）
    if !codex_running() {
        *cooldown_until = None;
        return;
    }
    // 冷却期，不接管
    if let Some(until) = *cooldown_until {
        if Instant::now() < until {
            return;
        }
        eprintln!("[codex-desktop watcher] 冷却到期，恢复检测");
        *cooldown_until = None;
    }

    if cdp_listening_slow() {
        // CDP 通 → 检查 patch 是否在
        if sidecar_injection_present() {
            return; // 一切正常
        }
        // patch 没了 → 直接补 inject（不 kill）
        crate::commands::platforms::emit_switch_progress(
            app,
            "codex",
            "injecting",
            "正在自动补注入…",
        );
        match inject_via_sidecar() {
            Ok(_) => {
                eprintln!("[codex-desktop watcher] 已补注入自定义模型");
                *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_SUCCESS);
            }
            Err(e) => {
                eprintln!("[codex-desktop watcher] 补注入失败: {e}");
                *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_FAILURE);
            }
        }
        return;
    }

    // CDP 不通（用户手动重开 Desktop，没带 CDP）→ takeover
    // 启动宽限期内跳过 takeover，避免打开 AnyBridge 就自动杀重启 Codex
    if Instant::now() - started_at < WATCHER_STARTUP_GRACE {
        eprintln!("[codex-desktop watcher] 启动宽限期内，跳过 takeover");
        return;
    }
    eprintln!("[codex-desktop watcher] 检测到 Codex Desktop 未以 CDP 模式运行，自动接管…");
    let ok = takeover(app);
    if ok {
        eprintln!(
            "[codex-desktop watcher] 接管完成，设冷却 {}s",
            WATCHER_COOLDOWN_AFTER_SUCCESS.as_secs()
        );
        *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_SUCCESS);
    } else {
        eprintln!(
            "[codex-desktop watcher] 接管失败，退避 {}s",
            WATCHER_COOLDOWN_AFTER_FAILURE.as_secs()
        );
        *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_FAILURE);
    }
}


/// 接管：kill + 等 AppX 复位 + launch_with_cdp + 等CDP起来。
/// inject 后台异步做（不阻塞 watcher），学 CodexPlusPlus 的 launcher 模式。
#[cfg(target_os = "windows")]
fn takeover(app: &AppHandle) -> bool {
    crate::commands::platforms::emit_switch_progress(
        app,
        "codex",
        "stopping",
        "正在自动停止 Codex…",
    );
    if let Err(e) = kill_codex() {
        eprintln!("[codex-desktop watcher] takeover kill 失败: {e}");
        return false;
    }
    // MSIX 应用 kill 后 AppX 状态需要复位，不等就 launch 可能失败（学 CodexPlusPlus）
    std::thread::sleep(Duration::from_millis(1500));
    crate::commands::platforms::emit_switch_progress(
        app,
        "codex",
        "starting",
        "正在以调试模式重启 Codex…",
    );
    let (_pid, cdp_port) = match launch_with_cdp() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[codex-desktop watcher] takeover launch 失败: {e}");
            return false;
        }
    };
    // 只等 CDP 端口起来（最多 15s），不等 inject 完成
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if cdp_listening_on_port(cdp_port, Duration::from_millis(500)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    if !cdp_listening_on_port(cdp_port, Duration::from_millis(500)) {
        eprintln!("[codex-desktop watcher] takeover: {cdp_port} 在 15s 内未就绪");
        return false;
    }
    // inject 后台异步做，不阻塞 watcher（学 CodexPlusPlus launcher 异步 inject）
    let app_clone = app.clone();
    std::thread::spawn(move || {
        crate::commands::platforms::emit_switch_progress(
            &app_clone,
            "codex",
            "injecting",
            "正在注入自定义模型…",
        );
        match inject_via_sidecar_on_port(cdp_port) {
            Ok(_) => eprintln!("[codex-desktop watcher] 后台注入完成"),
            Err(e) => eprintln!("[codex-desktop watcher] 后台注入失败: {e}"),
        }
    });
    true
}
