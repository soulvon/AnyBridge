// codex_desktop.rs
//
// Codex Desktop (Electron / MSIX) 进程生命周期 + CDP 调试模式管理。
//
// 职责（按用户选择：Rust 管生命周期 / sidecar 管 CDP 注入）：
//   - 检测 Codex MSIX 安装信息（Get-AppxPackage）
//   - kill Codex.exe（Stop-Process）
//   - COM 激活 ApplicationActivationManager 带 --remote-debugging-port 启动
//   - 轮询 CDP /json 就绪
//   - 写 / 清理 ~/.codex/models_cache.json 注入项
//   - 通过 sidecar /__byok/codex-cdp/inject 注入 6 点补丁
//   - 常驻 watcher：检测到 Codex 在跑但无 CDP 时自动接管
//
// 仅支持 Windows。macOS/Linux 返回友好错误。
//
// 参考：CodexPlusPlus launcher.py (COM 激活 + kill)、app_paths.py (MSIX 检测)、
//       CC-Switch spec §4.11-4.20 (CDP + models_cache 注入)。

use crate::commands::config::{configured_proxy_ports, read_provider_store};
use crate::commands::platforms::read_codex_model_template;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CDP_PORT: u16 = 9229;
const CDP_LAUNCH_ARGS: &str =
    "--remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229";
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
    dirs::home_dir().map(|h| h.join(".codex"))
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
fn http_get_local(port: u16, path: &str, timeout: Duration) -> Result<String, String> {
    // Try IPv4 first, then IPv6 (Codex may bind to either)
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
                    .write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes())
                    .map_err(|e| format!("发送请求失败: {e}"))?;
                let mut buf = String::new();
                stream
                    .read_to_string(&mut buf)
                    .map_err(|e| format!("读取响应失败: {e}"))?;
                return Ok(buf);
            }
            Err(e) => last_err = format!("{addr}: {e}"),
        }
    }
    Err(format!("无法连接 {port}: {last_err}"))
}

/// 发送一个 POST 请求（JSON body）到 127.0.0.1:port/path，返回 (status_line, body)。
fn http_post_local(port: u16, path: &str, body: &str, timeout: Duration) -> Result<(String, String), String> {
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
                let body = rest
                    .split_once("\r\n\r\n")
                    .map(|(_, b)| b.to_string())
                    .unwrap_or_default();
                return Ok((status, body));
            }
            Err(e) => last_err = format!("{addr}: {e}"),
        }
    }
    Err(format!("无法连接 {port}: {last_err}"))
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

/// 杀掉所有 Codex.exe / codex.exe 进程。
/// 移植自 CodexPlusPlus launcher.py:348-366。
fn kill_codex() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"Get-CimInstance Win32_Process -Filter "Name='Codex.exe' OR Name='codex.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"#;
        // 即使没有进程也返回成功
        let _ = run_powershell(script);
        // 给一点时间让句柄释放
        std::thread::sleep(Duration::from_millis(800));
        Ok(())
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
fn launch_with_cdp() -> Result<u32, String> {
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
        args = CDP_LAUNCH_ARGS
    );
    let raw = run_powershell(&script)?;
    let pid: u32 = raw
        .trim()
        .parse()
        .map_err(|e| format!("COM 激活返回的 PID 解析失败: {e} (raw={raw})"))?;
    Ok(pid)
}

#[cfg(not(target_os = "windows"))]
fn launch_with_cdp() -> Result<u32, String> {
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

// ─── CDP 就绪轮询 ─────────────────────────────────────────────────────

/// 轮询 CDP /json，最多等 ~60s（Electron 应用启动较慢）。
fn poll_cdp_ready() -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last_err = String::new();
    while Instant::now() < deadline {
        match http_get_local(CDP_PORT, "/json", Duration::from_secs(3)) {
            Ok(buf) if buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200") => {
                return Ok(());
            }
            Ok(buf) => last_err = buf.lines().next().unwrap_or("unknown").to_string(),
            Err(e) => last_err = e,
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    Err(format!("CDP /json 在 60s 内未就绪: {last_err}"))
}

/// 探测 CDP 是否可达（watcher 用，不阻塞太久）。
fn cdp_reachable() -> bool {
    match http_get_local(CDP_PORT, "/json", Duration::from_millis(800)) {
        Ok(buf) => buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200"),
        Err(_) => false,
    }
}

// ─── models_cache.json 注入 ───────────────────────────────────────────

/// 读取 AnyBridge catalog 文件（~/.codex/anybridge-model-catalog.json），
/// 提取需要注入到 models_cache.json 的模型 slug 列表。
fn read_anybridge_catalog_models() -> Vec<serde_json::Value> {
    let Some(dir) = codex_config_dir() else {
        return vec![];
    };
    let catalog_file = dir.join("anybridge-model-catalog.json");
    let Ok(raw) = std::fs::read_to_string(&catalog_file) else {
        return vec![];
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return vec![];
    };
    let models_arr = if parsed.is_array() {
        parsed.as_array()
    } else {
        parsed.get("models").and_then(|m| m.as_array())
    };
    models_arr.map(|a| a.iter().cloned().collect()).unwrap_or_default()
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
    let models = read_anybridge_catalog_models();
    if models.is_empty() {
        return Ok(()); // 无自定义模型，不写
    }

    // 读取现有 cache（不存在用空结构，fetched_at/etag 后续按需补）
    let raw = std::fs::read_to_string(&cache_path).unwrap_or_default();
    let mut cache: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| empty_models_cache());

    // 确保 cache.models 是数组
    if !cache.get("models").map(|m| m.is_array()).unwrap_or(false) {
        cache["models"] = serde_json::json!([]);
    }
    let arr = cache["models"].as_array_mut().unwrap();

    // 优先复用 platforms.rs 的官方模板（治本：读 models_cache.json 第一个条目）
    // 兜底：cache 自身第一个真正的官方条目（排除我们自己的注入项；不静默——下面会校验并返回 Err）
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
        "无法读取 Codex 官方模型模板：~/.codex/models_cache.json 不存在且 cache 为空。\n\
         请先启动一次 Codex Desktop / CLI 让其生成 models_cache.json，再切换供应商。"
            .to_string()
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
        let ctx_default = template
            .get("context_window")
            .and_then(|c| c.as_u64())
            .unwrap_or(128000);
        let ctx = entry
            .get("context_window")
            .and_then(|c| c.as_u64())
            .unwrap_or(ctx_default);

        let mut model_obj = template.clone();
        // slug 必须与 anybridge-model-catalog.json / proxy-routes / CDP 注入完全一致
        // （原始模型名，不加任何前缀）。否则用户在 Desktop 选中后，Codex 发给本地代理的
        // model 名对不上路由表，resolveProxyModel 直接报"模型不在本地代理模型列表中"。
        // 幂等清理改用独立标记字段 anybridge_managed（Codex 读 models_cache 时忽略未知字段，已验证）。
        model_obj["slug"] = serde_json::json!(slug);
        model_obj["display_name"] = serde_json::json!(display);
        model_obj["description"] = serde_json::json!(display);
        model_obj["context_window"] = serde_json::json!(ctx);
        model_obj["max_context_window"] = serde_json::json!(ctx);
        model_obj["priority"] = serde_json::json!(1000 + i);
        model_obj[ANYBRIDGE_MANAGED_FLAG] = serde_json::json!(true);
        arr.push(model_obj);
    }

    let out = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&cache_path, out.as_bytes())
}

/// 清理 ~/.codex/models_cache.json 中的 AnyBridge 注入项（切回官方用）。
fn clean_models_cache() -> Result<(), String> {
    let Some(dir) = codex_config_dir() else {
        return Ok(());
    };
    let cache_path = dir.join("models_cache.json");
    let Ok(raw) = std::fs::read_to_string(&cache_path) else {
        return Ok(()); // 不存在，无需清理
    };
    let Ok(mut cache) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(()); // 损坏，不动
    };
    if let Some(arr) = cache.get_mut("models").and_then(|m| m.as_array_mut()) {
        let before = arr.len();
        arr.retain(|m| {
            if m.get(ANYBRIDGE_MANAGED_FLAG)
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                return false;
            }
            let slug = m.get("slug").and_then(|s| s.as_str()).unwrap_or("");
            !slug.starts_with(LEGACY_ANYBRIDGE_SLUG_PREFIX)
        });
        if arr.len() != before {
            let out = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
            crate::commands::write_atomic(&cache_path, out.as_bytes())?;
        }
    }
    Ok(())
}

// ─── 通过 sidecar 注入 CDP 补丁 ────────────────────────────────────────

/// POST sidecar /__byok/codex-cdp/inject 触发 6 点补丁注入。
fn inject_via_sidecar() -> Result<String, String> {
    let ports = configured_proxy_ports();
    let port = ports.api_port;
    let body = serde_json::json!({ "port": CDP_PORT }).to_string();
    let (status, text) = http_post_local(port, "/__byok/codex-cdp/inject", &body, Duration::from_secs(15))?;
    if status.contains("200") {
        let parsed: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::json!({"ok": false}));
        let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        let msg = parsed
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("注入完成")
            .to_string();
        if ok {
            Ok(msg)
        } else {
            Err(format!("sidecar 注入返回失败: {msg}"))
        }
    } else {
        Err(format!("sidecar 注入 {status}: {text}"))
    }
}

/// POST sidecar /__byok/codex-cdp/check 检测注入标记是否存在。
fn sidecar_injection_present() -> bool {
    let ports = configured_proxy_ports();
    let body = serde_json::json!({ "port": CDP_PORT }).to_string();
    match http_post_local(ports.api_port, "/__byok/codex-cdp/check", &body, Duration::from_secs(3)) {
        Ok((status, text)) if status.contains("200") => {
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("injected").and_then(|i| i.as_bool()))
                .unwrap_or(false)
        }
        _ => false,
    }
}

// ─── Codex.exe 是否在跑 ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn codex_running() -> bool {
    let script = r#"(Get-CimInstance Win32_Process -Filter "Name='Codex.exe' OR Name='codex.exe'" -ErrorAction SilentlyContinue | Measure-Object).Count"#;
    match run_powershell(script) {
        Ok(s) => s.trim().parse::<u32>().unwrap_or(0) > 0,
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn codex_running() -> bool {
    false
}

// ─── 主命令：重启 Codex Desktop ───────────────────────────────────────

/// 判断当前 Codex 是否处于"自定义供应商"态（watcher + managed 启动前判断用）。
fn codex_is_managed_state() -> bool {
    match read_provider_store() {
        Ok(store) => store
            .platforms
            .get("codex")
            .map(|s| !s.provider_id.is_empty())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 内部编排：managed=true → 注入 models_cache + kill + CDP 启动 + 轮询 + sidecar 注入。
/// managed=false → 清理 models_cache + kill + 普通启动。
fn restart_codex_desktop_impl(managed: bool) -> CodexDesktopResult {
    if managed {
        // 1. 写 models_cache.json
        if let Err(e) = write_models_cache() {
            eprintln!("[codex-desktop] write_models_cache 警告: {e}");
            // 继续执行——cache 写入失败不致命
        }
        // 2. kill
        if let Err(e) = kill_codex() {
            return CodexDesktopResult {
                ok: false,
                message: format!("停止 Codex 失败: {e}"),
                managed,
                pid: None,
            };
        }
        // 3. COM 激活带 CDP
        let pid = match launch_with_cdp() {
            Ok(p) => p,
            Err(e) => {
                return CodexDesktopResult {
                    ok: false,
                    message: format!("启动 Codex Desktop (CDP) 失败: {e}"),
                    managed,
                    pid: None,
                }
            }
        };
        // 4. 轮询 CDP 就绪
        if let Err(e) = poll_cdp_ready() {
            return CodexDesktopResult {
                ok: false,
                message: format!("Codex 已启动 (PID {pid})，但 CDP 未就绪: {e}"),
                managed,
                pid: Some(pid),
            };
        }
        // 5. 通过 sidecar 注入补丁
        match inject_via_sidecar() {
            Ok(msg) => CodexDesktopResult {
                ok: true,
                message: format!("已重启 Codex 桌面版并注入自定义模型 ({msg})"),
                managed,
                pid: Some(pid),
            },
            Err(e) => CodexDesktopResult {
                ok: true,
                message: format!("Codex 已重启 (PID {pid})，但模型注入未完成: {e}"),
                managed,
                pid: Some(pid),
            },
        }
    } else {
        // 清理注入项
        if let Err(e) = clean_models_cache() {
            eprintln!("[codex-desktop] clean_models_cache 警告: {e}");
        }
        if let Err(e) = kill_codex() {
            return CodexDesktopResult {
                ok: false,
                message: format!("停止 Codex 失败: {e}"),
                managed,
                pid: None,
            };
        }
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

/// Tauri 命令：重启 Codex Desktop。
/// managed=true → 自定义供应商模式（CDP + 注入）；
/// managed=false → 官方模式（普通启动，清理注入）。
#[tauri::command]
pub fn restart_codex_desktop(managed: bool) -> CodexDesktopResult {
    restart_codex_desktop_impl(managed)
}

// ─── 常驻 watcher ────────────────────────────────────────────────────

/// watcher 单次循环逻辑。
/// 启动常驻 watcher 后台任务。
/// 在 lib.rs setup 闭包里 spawn 一次。
/// 当前禁用：原计划在「Codex 在跑+无 CDP」时自动接管，但 Electron 启动慢于
/// 轮询周期导致 kill+launch 死循环，桌面版模型选择器一直显示官方。
/// 临时关闭 watchdog，改为完全依赖 UI 上的 `restart_codex_desktop` 触发接管。
#[allow(dead_code)]
pub fn spawn_codex_desktop_watcher(_app: AppHandle) {
    // 完全空跑：不再 spawn 任何后台任务。
}

#[allow(dead_code)]
fn run_watcher_tick(cooldown_until: &mut Option<Instant>) {
    if !codex_is_managed_state() {
        *cooldown_until = None;
        return;
    }
    if !codex_running() {
        *cooldown_until = None;
        return;
    }
    if cdp_reachable() {
        *cooldown_until = None;
        if !sidecar_injection_present() {
            if let Err(e) = inject_via_sidecar() {
                eprintln!("[codex-desktop watcher] 补注入失败: {e}");
            } else {
                eprintln!("[codex-desktop watcher] 已补注入自定义模型");
            }
        }
        return;
    }
    // 在跑但 CDP 不通 → 接管
    eprintln!("[codex-desktop watcher] 检测到 Codex 未以 CDP 模式运行，接管中…");
    let result = restart_codex_desktop_impl(true);
    if result.ok {
        eprintln!("[codex-desktop watcher] 接管完成: {}", result.message);
        *cooldown_until = None;
    } else {
        eprintln!("[codex-desktop watcher] 接管失败: {}", result.message);
        // 冷却 30s，避免热循环
        *cooldown_until = Some(Instant::now() + Duration::from_secs(30));
    }
}
