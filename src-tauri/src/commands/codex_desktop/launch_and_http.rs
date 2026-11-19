use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use super::*;

/// 发送一个 GET 请求到 127.0.0.1:port/path，返回完整响应文本（含头）。
///
/// CDP 的 /json 响应不主动关闭连接（keep-alive），read_to_string 会等到
/// 超时才返回 Err。这里改成读到数据就返回：先读到第一个响应字节，再尝试
/// 短暂继续读（40ms 内还有数据就继续拼），没有更多数据就返回已读内容。
pub(super) fn http_get_local(port: u16, path: &str, timeout: Duration) -> Result<String, String> {
    let addrs = local_loopback_addrs(port);
    let mut errors: Vec<String> = Vec::new();
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
            Err(e) => errors.push(format!("{addr}: {e}")),
        }
    }
    Err(connect_error(port, &errors))
}

/// 发送一个 POST 请求（JSON body）到 127.0.0.1:port/path，返回 (status_line, body)。
///
/// body 提取后会解码 chunked transfer encoding（sidecar 的 Node http 在未设
/// Content-Length 时用 chunked）。不解 chunked 会导致 JSON 前出现 chunk size
/// 标记（如 "b4\r\n{...}"），serde 解析失败误判 ok=false。
pub(crate) fn http_post_local(
    port: u16,
    path: &str,
    body: &str,
    timeout: Duration,
) -> Result<(String, String), String> {
    let addrs = local_loopback_addrs(port);
    let mut errors: Vec<String> = Vec::new();
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
            Err(e) => errors.push(format!("{addr}: {e}")),
        }
    }
    Err(connect_error(port, &errors))
}

/// 解码 HTTP chunked transfer encoding。
/// 输入形如 "b4\r\n{json}\r\n0\r\n\r\n"，输出 "{json}"。
/// 解码失败返回原文（让上层解析报错暴露，不静默）。
pub(super) fn decode_chunked(body: &str) -> String {
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
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Serialize)]
pub(super) struct CodexMsixInfo {
    /// AppUserModelId，形如 `OpenAI.Codex_2p2nqsd0c76g0!App`
    aumid: String,
    install_location: String,
    version: String,
}

/// 通过 `Get-AppxPackage -Name OpenAI.Codex` 检测安装信息并推导 AUMID。
/// AUMID = PackageFamilyName + "!App"（与 CodexPlusPlus packaged_app_user_model_id 一致）。
#[cfg(target_os = "windows")]
pub(super) fn find_codex_msix() -> Result<CodexMsixInfo, String> {
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


// ─── kill ────────────────────────────────────────────────────────────

/// PowerShell：判断是否为 Codex Desktop 相关进程。
/// - UI 宿主：ChatGPT.exe（路径/命令行含 OpenAI.Codex），或旧版 Electron 宿主 Codex.exe
/// - 包内 helper：OpenAI.Codex 包下的 resources\codex.exe（app-server）
/// 明确排除：npm CLI、codex-acp、cockpit-codex-adapter 等第三方进程。
///
/// 注意：Win32 进程名大小写不稳定，不能用 -ieq 'Codex.exe' 区分宿主与 app-server。
/// app-server 特征：路径含 \resources\codex.exe，或命令行含 app-server。
///
/// 两轮 Stop-Process：第二轮针对第一轮残留的子进程（部分子进程需等
/// 父进程死后才能退出），再超时则暴露剩余 PID 供诊断。
pub(super) fn kill_codex() -> Result<(), String> {
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
        Err("Codex 桌面控制仅支持 Windows".to_string())
    }
}


// ─── COM 激活启动 ─────────────────────────────────────────────────────

/// 用 ApplicationActivationManager COM 激活 Codex（MSIX），带 CDP 调试参数。
/// 直接 spawn Codex.exe 会绕过 UWP 沙箱 → Statsig 拿不到 userID → "糟糕出错了"。
/// 移植自 CodexPlusPlus launcher.py:202-259（Python ctypes COM 调用），
/// 这里用 PowerShell 晚绑定 COM，避免 Rust 手写 FFI。
#[cfg(target_os = "windows")]
pub(super) fn launch_with_cdp() -> Result<(u32, u16), String> {
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
pub(super) fn launch_with_cdp() -> Result<(u32, u16), String> {
    Err("Codex 桌面控制仅支持 Windows".to_string())
}

/// 普通模式启动 Codex（无 CDP，切回官方用）。
#[cfg(target_os = "windows")]
pub(super) fn launch_plain() -> Result<u32, String> {
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
pub(super) fn launch_plain() -> Result<u32, String> {
    Err("Codex 桌面控制仅支持 Windows".to_string())
}

// ─── CDP 就绪 ─────────────────────────────────────────────────────────
//
// 不再有 poll_cdp_ready：/json 200 ≠ renderer 就绪（实测 launch 后 1s 就 200，
// 但 renderer 要 ~4s 才加载完 __STATSIG__）。就绪判断交给 injectWithRetry——
// inject 自己会重试连 CDP，拿到 page target 并装上 patch 才算就绪，失败则
// 暴露真实原因（ECONNREFUSED / No page target / patch 异常）。

/// watcher 用的慢探测：给足响应时间，避免 renderer 加载中 /json 响应慢被误判为没监听。
#[cfg(target_os = "windows")]
pub(super) fn cdp_listening_slow() -> bool {
    cdp_listening_on_port(current_cdp_port(), Duration::from_secs(2))
}

/// 探测指定端口是否在监听（动态端口用）
#[cfg(target_os = "windows")]
pub(super) fn cdp_listening_on_port(port: u16, timeout: Duration) -> bool {
    match http_get_local(port, "/json", timeout) {
        Ok(_) => true,
        Err(_) => false,
    }
}

// ─── models_cache.json 注入 ───────────────────────────────────────────
