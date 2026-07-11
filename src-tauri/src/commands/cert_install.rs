// cert_install.rs — 跨平台 CA 证书安装/卸载/状态查询。
//
// 核心策略（Windows 桌面端，95% 用户零弹窗）：
//   1. 优先装到 `Cert:\CurrentUser\Root`（不需要管理员权限，不弹 UAC）
//   2. Electron / Chromium 进程都会读 CurrentUser\Root，99% 桌面 Windows 可用
//   3. 如果 Electron 不认（极少数边角情况），降级到 `LocalMachine\Root`，
//      走 `certutil -addstore Root` + 触发 certutil 自带的 UAC 弹窗
//   4. 用户点"是" → 装到 LM → 完成
//
// 升级路径：
//   旧版 CN = "IDE BYOK Local MITM" / "ide-byok Local CA" → 新版 CN = "AnyBridge Local CA"
//   装新证书后自动调 `cleanup_legacy_cn()` 卸老证书，避免新老并存。

use sha1::Digest;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::commands::system::{CA_COMMON_NAME, LEGACY_CA_COMMON_NAMES};

/// 证书在系统中的安装位置
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaStore {
    /// 装到 LocalMachine\Root（系统级，需要管理员权限）
    LocalMachine,
    /// 装到 CurrentUser\Root（用户级，不需要管理员权限）
    CurrentUser,
    /// 都没装
    None,
}

/// CA 在用户机器上的整体状态（供体检 / UI 使用）
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaStatus {
    pub common_name: String,
    pub cert_file: String,
    pub cert_exists: bool,
    pub key_exists: bool,
    pub san_version: Option<String>, // MITM 证书 SAN 版本标记
    pub san_current: bool,           // 是否包含当前 IDE 兼容所需 SAN
    pub current_user: bool,          // 在 Cert:\CurrentUser\Root
    pub local_machine: bool,         // 在 Cert:\LocalMachine\Root
    pub legacy_residual: bool,       // 老版本 AnyBridge/IDE BYOK 证书残留
    pub thumbprint: Option<String>,  // CA 的 SHA1 指纹
    pub effective_store: CaStore,    // 实际能用的位置
    pub message: String,             // 给人看的总体描述
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
    pub level: String,
}

fn emit_cert_progress(
    app: Option<&AppHandle>,
    stage: &str,
    message: &str,
    percent: u8,
    level: &str,
) {
    eprintln!("[cert_install] {}: {}", stage, message);
    if let Some(app) = app {
        let _ = app.emit(
            "cert-install-progress",
            CertInstallProgress {
                stage: stage.to_string(),
                message: message.to_string(),
                percent: percent.min(100),
                level: level.to_string(),
            },
        );
    }
}

fn cert_paths() -> Result<(PathBuf, PathBuf), String> {
    let certs_dir = crate::commands::config::config_dir_path().join("certs");
    let cert_path = certs_dir.join("server.codeium.com.pem");
    let key_path = certs_dir.join("server.codeium.com-key.pem");
    Ok((cert_path, key_path))
}

fn san_marker_path(cert_path: &Path) -> Result<PathBuf, String> {
    let certs_dir = cert_path
        .parent()
        .ok_or_else(|| format!("证书路径缺少父目录: {}", cert_path.to_string_lossy()))?;
    Ok(certs_dir.join("san-version"))
}

fn read_san_version(cert_path: &Path) -> Option<String> {
    let marker = san_marker_path(cert_path).ok()?;
    let value = std::fs::read_to_string(marker).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_san_current(cert_path: &Path, cert_exists: bool, key_exists: bool) -> bool {
    cert_exists
        && key_exists
        && read_san_version(cert_path)
            .as_deref()
            .map(|version| version == crate::commands::system::mitm_cert_san_version())
            .unwrap_or(false)
}

fn current_user_store_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "CurrentUser\\Root"
    }
    #[cfg(target_os = "macos")]
    {
        "login keychain"
    }
    #[cfg(target_os = "linux")]
    {
        "user CA trust store"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "user trust store"
    }
}

fn local_machine_store_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "LocalMachine\\Root"
    }
    #[cfg(target_os = "macos")]
    {
        "System keychain"
    }
    #[cfg(target_os = "linux")]
    {
        "system CA trust store"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "system trust store"
    }
}

fn admin_prompt_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "UAC"
    }
    #[cfg(target_os = "macos")]
    {
        "administrator authorization"
    }
    #[cfg(target_os = "linux")]
    {
        "pkexec"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "administrator authorization"
    }
}

/// 计算 PEM 证书的 SHA1 Thumbprint。
/// Windows 证书库里的 Thumbprint 是 X.509 DER 的 SHA1，不是 PEM 文本文件 hash。
fn compute_thumbprint(pem_path: &Path) -> Result<String, String> {
    let pem = std::fs::read(pem_path)
        .map_err(|e| format!("读取证书文件失败 {}: {}", pem_path.to_string_lossy(), e))?;
    let der = extract_first_cert_der(&pem)?;
    let digest = sha1::Sha1::digest(&der);
    Ok(hex::encode(digest))
}

/// 从 PEM 字节中提取第一段 CERTIFICATE 块的 DER。
fn extract_first_cert_der(pem: &[u8]) -> Result<Vec<u8>, String> {
    let s = std::str::from_utf8(pem).map_err(|e| format!("证书不是 UTF-8: {}", e))?;
    let mut in_block = false;
    let mut b64 = String::new();
    for line in s.lines() {
        let t = line.trim();
        if t.contains("-----BEGIN CERTIFICATE-----") {
            in_block = true;
            continue;
        }
        if t.contains("-----END CERTIFICATE-----") {
            break;
        }
        if in_block {
            b64.push_str(t);
        }
    }
    if b64.is_empty() {
        return Err("找不到 CERTIFICATE PEM 块".to_string());
    }
    base64_decode(&b64)
}

/// 极简 base64 解码（只用于解码 X.509 DER）。
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8; 128] = &{
        let mut t = [255u8; 128];
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0;
        while i < alphabet.len() {
            t[alphabet[i] as usize] = i as u8;
            i += 1;
        }
        t
    };
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &c in bytes {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' || c == b'\t' {
            continue;
        }
        if c >= 128 {
            return Err("非 base64 字符".into());
        }
        let v = T[c as usize];
        if v == 255 {
            return Err(format!("非法 base64 字符: {}", c as char));
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1u32 << bits) - 1;
        }
    }
    Ok(out)
}

// ──────────────────────────────────────────────────────────
// Windows 实现：CurrentUser\Root 优先，失败 UAC 兜底
// ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CERTUTIL_WAIT_TIMEOUT_MS: u32 = 120_000;

    fn certutil_path() -> PathBuf {
        let system_root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let path = system_root.join("System32").join("certutil.exe");
        if path.exists() {
            path
        } else {
            PathBuf::from("certutil.exe")
        }
    }

    /// 检查指定 CommonName 的证书是否在指定 store 里。
    /// `current_user_only=true` 时只查 CurrentUser\Root，否则查 LocalMachine\Root。
    pub fn is_in_store(cn: &str, current_user_only: bool) -> bool {
        // certutil 区分 user / machine store 的方式：加 `-user` 前缀
        // 仅查 CurrentUser，不加则查 LocalMachine（certutil 默认行为）。
        let mut args: Vec<&str> = vec!["-verifystore", "Root", cn];
        if current_user_only {
            args.insert(0, "-user");
        }
        Command::new(certutil_path())
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn is_thumbprint_in_store(thumbprint: &str, current_user_only: bool) -> bool {
        let normalized: String = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect();
        if normalized.len() != 40 {
            return false;
        }
        let mut args: Vec<&str> = vec!["-verifystore", "Root", normalized.as_str()];
        if current_user_only {
            args.insert(0, "-user");
        }
        Command::new(certutil_path())
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 把 PEM 装到 CurrentUser\Root（不需要管理员权限）。
    /// 用 certutil -user -addstore 强制走 user store，避免被任何机器策略拦截。
    pub fn install_current_user(cert_path: &Path) -> Result<(), String> {
        let out = Command::new(certutil_path())
            .args([
                "-f",
                "-user",
                "-addstore",
                "Root",
                &cert_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("certutil 启动失败: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "装到 CurrentUser\\Root 失败: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }

    fn run_certutil_via_uac(param_str: &str, action_label: &str) -> Result<(), String> {
        use std::ffi::OsStr;
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
        };

        let certutil = certutil_path();
        let verb = OsStr::new("runas")
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<u16>>();
        let file = certutil
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<u16>>();
        let params = OsStr::new(&param_str)
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<u16>>();
        let directory = certutil.parent().map(|p| {
            p.as_os_str()
                .encode_wide()
                .chain(once(0))
                .collect::<Vec<u16>>()
        });

        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.hwnd = HWND::default();
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        if let Some(ref dir) = directory {
            info.lpDirectory = dir.as_ptr();
        }
        info.nShow = 1; // SW_SHOWNORMAL

        eprintln!(
            "[cert_install] ShellExecuteExW runas: file={}, params={}",
            certutil.display(),
            param_str
        );
        let ok = unsafe { ShellExecuteExW(&mut info) };
        if ok == 0 {
            // ShellExecuteExW 失败 —— 常见错误码:
            //   0x80070005 拒绝访问（用户拒了 UAC 或 GPO 拦截）
            //   0x800704C7 文件未找到
            //   0x80070002 文件未找到
            let err = std::io::Error::last_os_error();
            let code = err.raw_os_error().unwrap_or(0) as u32;
            eprintln!(
                "[cert_install] ShellExecuteExW 失败: code=0x{:08X}, msg={}",
                code, err
            );
            // 用 errno 文本判断
            return Err(format!(
                "调起 UAC 失败（code=0x{:08X}）。可能你取消了授权或被组策略拦截了 elevate 请求: {}",
                code, err
            ));
        }

        let h_process = info.hProcess;
        if h_process.is_null() {
            // 启动成功但没拿到句柄 —— 罕见，但当作成功处理（用户至少点了"是"）
            eprintln!("[cert_install] ShellExecuteExW 成功但未返回进程句柄");
            return Ok(());
        }

        eprintln!("[cert_install] UAC 已确认，等待 certutil 退出...");
        // 等待子进程退出
        unsafe {
            let wait_result = windows_sys::Win32::System::Threading::WaitForSingleObject(
                h_process as _,
                CERTUTIL_WAIT_TIMEOUT_MS,
            );
            if wait_result == 0x0000_0102 {
                windows_sys::Win32::Foundation::CloseHandle(h_process as _);
                return Err(format!(
                    "certutil {}等待超时。可能 UAC 弹窗被隐藏，或 certutil 正在等待交互确认",
                    action_label
                ));
            }
            if wait_result == 0xFFFF_FFFF {
                let err = std::io::Error::last_os_error();
                windows_sys::Win32::Foundation::CloseHandle(h_process as _);
                return Err(format!("等待 certutil 退出失败: {}", err));
            }
            let mut exit_code: u32 = 0;
            let get_ok = windows_sys::Win32::System::Threading::GetExitCodeProcess(
                h_process as _,
                &mut exit_code,
            );
            windows_sys::Win32::Foundation::CloseHandle(h_process as _);
            if get_ok == 0 {
                return Err("certutil 进程已结束但无法读取退出码".to_string());
            }
            if exit_code != 0 {
                eprintln!("[cert_install] certutil 非零退出: exit_code={}", exit_code);
                return Err(format!(
                    "certutil {}失败（exit code: {}）。如果你拒了 UAC 授权，请重试",
                    action_label, exit_code
                ));
            }
        }
        eprintln!("[cert_install] certutil {}完成", action_label);
        Ok(())
    }

    /// 把 PEM 装到 LocalMachine\Root（需要管理员权限）。
    ///
    /// 关键点：Rust 的 `std::process::Command` 走 `CreateProcess`，**不会**自动触发 UAC
    /// 弹窗（因为 `anybridge.exe` 的 manifest 是 asInvoker，无 requestedExecutionLevel）。
    /// 必须用 `ShellExecuteExW` + `runas` 动词，Windows 看到这个动词会主动拉起 consent UI。
    /// 返回值是 (exit_code, stderr)；让上层判断用户是点了"否"还是其它失败。
    pub fn install_local_machine_via_uac(cert_path: &Path) -> Result<(), String> {
        // certutil 解析: certutil -f -addstore Root <path>
        // 把空格 / 路径安全地包起来，避免 "Program Files" 之类含空格路径被切碎
        let param_str = format!("-f -addstore Root \"{}\"", cert_path.display());
        run_certutil_via_uac(&param_str, "安装")
    }

    pub fn uninstall_local_machine_thumbprint_via_uac(thumbprint: &str) -> Result<(), String> {
        let normalized: String = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect();
        if normalized.len() != 40 {
            return Err("证书指纹格式异常，无法卸载".to_string());
        }
        let param_str = format!("-delstore Root \"{}\"", normalized);
        run_certutil_via_uac(&param_str, "卸载")
    }

    /// 从指定 store 卸载指定 CommonName 的证书。
    /// `current_user=true` 时走 user store，否则走 machine store（需 admin）。
    pub fn uninstall_from_store(cn: &str, current_user: bool) -> Result<(), String> {
        let mut args: Vec<&str> = vec!["-delstore", "Root", cn];
        if current_user {
            args.insert(0, "-user");
        }
        let out = Command::new(certutil_path())
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("certutil 启动失败: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "卸载 CA '{}' 失败: {}",
                cn,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }

    pub fn uninstall_thumbprint_from_store(
        thumbprint: &str,
        current_user: bool,
    ) -> Result<(), String> {
        let normalized: String = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect();
        if normalized.len() != 40 {
            return Err("证书指纹格式异常，无法卸载".to_string());
        }
        let mut args: Vec<&str> = vec!["-delstore", "Root", normalized.as_str()];
        if current_user {
            args.insert(0, "-user");
        }
        let out = Command::new(certutil_path())
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("certutil 启动失败: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "按 Thumbprint 卸载 CA '{}' 失败: {}",
                normalized,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn login_keychain() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or("无法获取用户目录")?;
        let modern = home
            .join("Library")
            .join("Keychains")
            .join("login.keychain-db");
        if modern.exists() {
            return Ok(modern);
        }
        Ok(home
            .join("Library")
            .join("Keychains")
            .join("login.keychain"))
    }

    fn system_keychain() -> PathBuf {
        PathBuf::from("/Library/Keychains/System.keychain")
    }

    fn keychain(current_user_only: bool) -> Result<PathBuf, String> {
        if current_user_only {
            login_keychain()
        } else {
            Ok(system_keychain())
        }
    }

    fn command_text(out: std::process::Output) -> String {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if stderr.is_empty() {
            stdout
        } else {
            stderr
        }
    }

    fn run_security(args: &[&str], path_args: &[&Path]) -> Result<String, String> {
        let mut command = Command::new("security");
        command.args(args);
        for path in path_args {
            command.arg(path);
        }
        let out = command
            .output()
            .map_err(|e| format!("security 启动失败: {}", e))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(command_text(out))
        }
    }

    fn apple_script_string(value: &str) -> String {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn run_admin_shell(command: &str) -> Result<(), String> {
        let script = format!(
            "do shell script {} with administrator privileges",
            apple_script_string(command)
        );
        let out = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("osascript 启动失败: {}", e))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(command_text(out))
        }
    }

    pub fn is_in_store(_cn: &str, _current_user_only: bool) -> bool {
        let Ok(kc) = keychain(_current_user_only) else {
            return false;
        };
        Command::new("security")
            .args(["find-certificate", "-c", _cn])
            .arg(kc)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn is_thumbprint_in_store(thumbprint: &str, current_user_only: bool) -> bool {
        let Ok(kc) = keychain(current_user_only) else {
            return false;
        };
        let normalized = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>()
            .to_ascii_uppercase();
        if normalized.len() != 40 {
            return false;
        }
        let out = Command::new("security")
            .args(["find-certificate", "-a", "-Z"])
            .arg(kc)
            .output();
        match out {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .to_ascii_uppercase()
                .contains(&normalized),
            _ => false,
        }
    }

    pub fn install_current_user(cert_path: &Path) -> Result<(), String> {
        let kc = login_keychain()?;
        run_security(
            &["add-trusted-cert", "-d", "-r", "trustRoot", "-k"],
            &[&kc, cert_path],
        )?;
        Ok(())
    }

    pub fn install_local_machine_via_uac(cert_path: &Path) -> Result<(), String> {
        let command = format!(
            "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain {}",
            shell_quote(&cert_path.to_string_lossy())
        );
        run_admin_shell(&command)
    }

    pub fn uninstall_from_store(cn: &str, current_user: bool) -> Result<(), String> {
        let kc = keychain(current_user)?;
        if current_user {
            run_security(&["delete-certificate", "-c", cn], &[&kc])?;
        } else {
            let command = format!(
                "security delete-certificate -c {} {}",
                shell_quote(cn),
                shell_quote(&kc.to_string_lossy())
            );
            run_admin_shell(&command)?;
        }
        Ok(())
    }

    pub fn uninstall_local_machine_thumbprint_via_uac(thumbprint: &str) -> Result<(), String> {
        let normalized = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>();
        if normalized.len() != 40 {
            return Err("证书指纹格式异常，无法卸载".to_string());
        }
        let command = format!(
            "security delete-certificate -Z {} /Library/Keychains/System.keychain",
            shell_quote(&normalized)
        );
        run_admin_shell(&command)
    }
    pub fn uninstall_thumbprint_from_store(
        thumbprint: &str,
        current_user: bool,
    ) -> Result<(), String> {
        let normalized = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>();
        if normalized.len() != 40 {
            return Err("证书指纹格式异常，无法卸载".to_string());
        }
        let kc = keychain(current_user)?;
        if current_user {
            run_security(&["delete-certificate", "-Z", &normalized], &[&kc])?;
        } else {
            let command = format!(
                "security delete-certificate -Z {} {}",
                shell_quote(&normalized),
                shell_quote(&kc.to_string_lossy())
            );
            run_admin_shell(&command)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    fn user_anchor_path() -> Result<PathBuf, String> {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))
            .ok_or("无法获取用户数据目录")?;
        Ok(base.join("ca-certificates").join("anybridge-local-ca.crt"))
    }

    fn system_anchor_path() -> PathBuf {
        // Debian/Ubuntu 默认路径（历史兼容）
        PathBuf::from("/usr/local/share/ca-certificates/anybridge-local-ca.crt")
    }

    /// 各发行版可能写入的系统 CA 落盘路径（探测/卸载时都要扫）。
    fn system_anchor_candidates() -> Vec<PathBuf> {
        vec![
            PathBuf::from("/usr/local/share/ca-certificates/anybridge-local-ca.crt"),
            PathBuf::from("/etc/pki/ca-trust/source/anchors/anybridge-local-ca.crt"),
            PathBuf::from("/etc/ca-certificates/trust-source/anchors/anybridge-local-ca.crt"),
            PathBuf::from("/usr/share/ca-certificates/anybridge-local-ca.crt"),
        ]
    }

    fn find_existing_system_anchor() -> Option<PathBuf> {
        system_anchor_candidates().into_iter().find(|p| p.exists())
    }

    fn command_text(out: std::process::Output) -> String {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if stderr.is_empty() {
            stdout
        } else {
            stderr
        }
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn command_exists(name: &str) -> bool {
        Command::new("sh")
            .args(["-c", &format!("command -v {} >/dev/null 2>&1", name)])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn require_command(name: &str, hint: &str) -> Result<(), String> {
        if command_exists(name) {
            Ok(())
        } else {
            Err(format!("缺少 Linux CA 安装工具 `{}`。{}", name, hint))
        }
    }

    fn cert_matches_thumbprint(path: &Path, thumbprint: &str) -> bool {
        let normalized = thumbprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>()
            .to_ascii_lowercase();
        if normalized.len() != 40 || !path.exists() {
            return false;
        }
        compute_thumbprint(path)
            .map(|t| t.eq_ignore_ascii_case(&normalized))
            .unwrap_or(false)
    }

    fn cert_matches_cn(path: &Path, cn: &str) -> bool {
        if !path.exists() {
            return false;
        }
        let out = Command::new("openssl")
            .args(["x509", "-in"])
            .arg(path)
            .args(["-noout", "-subject"])
            .output();
        match out {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).contains(cn),
            _ => false,
        }
    }

    fn run_pkexec_script(script: &str) -> Result<(), String> {
        require_command(
            "pkexec",
            "请安装 polkit/pkexec，或改用发行版提供的证书信任管理方式后重试。",
        )?;
        let out = Command::new("pkexec")
            .args(["sh", "-c", script])
            .output()
            .map_err(|e| format!("pkexec 启动失败: {}", e))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(command_text(out))
        }
    }

    pub fn is_in_store(cn: &str, current_user_only: bool) -> bool {
        if current_user_only {
            let path = match user_anchor_path() {
                Ok(p) => p,
                Err(_) => return false,
            };
            return cert_matches_cn(&path, cn);
        }
        system_anchor_candidates()
            .iter()
            .any(|path| cert_matches_cn(path, cn))
    }

    pub fn is_thumbprint_in_store(thumbprint: &str, current_user_only: bool) -> bool {
        if current_user_only {
            let path = match user_anchor_path() {
                Ok(p) => p,
                Err(_) => return false,
            };
            return cert_matches_thumbprint(&path, thumbprint);
        }
        system_anchor_candidates()
            .iter()
            .any(|path| cert_matches_thumbprint(path, thumbprint))
    }

    pub fn install_current_user(cert_path: &Path) -> Result<(), String> {
        require_command(
            "trust",
            "请安装 p11-kit/trust 工具；Debian/Ubuntu 通常是 p11-kit，Fedora/RHEL 通常随 p11-kit 提供。",
        )?;
        let anchor = user_anchor_path()?;
        if let Some(parent) = anchor.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建用户证书目录失败: {}", e))?;
        }
        let out = Command::new("trust")
            .args(["anchor", "--user"])
            .arg(cert_path)
            .output()
            .map_err(|e| format!("trust 启动失败: {}", e))?;
        if !out.status.success() {
            return Err(format!("trust anchor --user 失败: {}", command_text(out)));
        }
        std::fs::copy(cert_path, &anchor)
            .map_err(|e| format!("记录用户级 CA 证书失败 {}: {}", anchor.to_string_lossy(), e))?;
        Ok(())
    }

    pub fn install_local_machine_via_uac(cert_path: &Path) -> Result<(), String> {
        require_command(
            "install",
            "缺少 coreutils install 命令，无法复制系统级 CA 文件。",
        )?;
        let cert_q = shell_quote(&cert_path.to_string_lossy());

        // Debian/Ubuntu: update-ca-certificates
        if command_exists("update-ca-certificates") {
            let anchor = system_anchor_path();
            let script = format!(
                "install -m 0644 {} {} && update-ca-certificates",
                cert_q,
                shell_quote(&anchor.to_string_lossy())
            );
            return run_pkexec_script(&script);
        }

        // Fedora/RHEL/CentOS: update-ca-trust
        if command_exists("update-ca-trust") {
            let pki = PathBuf::from("/etc/pki/ca-trust/source/anchors/anybridge-local-ca.crt");
            let script = format!(
                "install -m 0644 {} {} && update-ca-trust extract",
                cert_q,
                shell_quote(&pki.to_string_lossy())
            );
            return run_pkexec_script(&script);
        }

        // Arch: trust extract-compat after placing in /etc/ca-certificates/trust-source/anchors
        if command_exists("trust") {
            let arch_anchor = PathBuf::from(
                "/etc/ca-certificates/trust-source/anchors/anybridge-local-ca.crt",
            );
            let script = format!(
                "install -D -m 0644 {} {} && trust extract-compat",
                cert_q,
                shell_quote(&arch_anchor.to_string_lossy())
            );
            return run_pkexec_script(&script);
        }

        Err(
            "未找到系统 CA 更新工具。请安装 update-ca-certificates（Debian/Ubuntu）、update-ca-trust（Fedora/RHEL）或 p11-kit trust（Arch）后重试。"
                .into(),
        )
    }

    pub fn uninstall_from_store(_cn: &str, current_user: bool) -> Result<(), String> {
        if current_user {
            let anchor = user_anchor_path()?;
            if anchor.exists() {
                let _ = Command::new("trust")
                    .args(["anchor", "--remove", "--user"])
                    .arg(&anchor)
                    .output();
                std::fs::remove_file(&anchor)
                    .map_err(|e| format!("删除用户级 CA 证书失败: {}", e))?;
            }
            Ok(())
        } else {
            uninstall_local_machine_thumbprint_via_uac("")
        }
    }

    pub fn uninstall_local_machine_thumbprint_via_uac(_thumbprint: &str) -> Result<(), String> {
        let rm_paths = system_anchor_candidates()
            .iter()
            .map(|p| format!("rm -f {}", shell_quote(&p.to_string_lossy())))
            .collect::<Vec<_>>()
            .join(" && ");

        if command_exists("update-ca-certificates") {
            let script = format!("{rm_paths} && update-ca-certificates");
            return run_pkexec_script(&script);
        }
        if command_exists("update-ca-trust") {
            let script = format!("{rm_paths} && update-ca-trust extract");
            return run_pkexec_script(&script);
        }
        if command_exists("trust") {
            let script = format!("{rm_paths} && trust extract-compat");
            return run_pkexec_script(&script);
        }

        // 至少删掉已知落盘文件
        if find_existing_system_anchor().is_some() {
            return run_pkexec_script(&rm_paths);
        }
        Ok(())
    }

    pub fn uninstall_thumbprint_from_store(
        _thumbprint: &str,
        current_user: bool,
    ) -> Result<(), String> {
        uninstall_from_store(CA_COMMON_NAME, current_user)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;
    pub fn is_in_store(_cn: &str, _current_user_only: bool) -> bool {
        false
    }
    pub fn is_thumbprint_in_store(_thumbprint: &str, _current_user_only: bool) -> bool {
        false
    }
    pub fn install_current_user(_cert_path: &Path) -> Result<(), String> {
        Err("当前平台暂不支持自动安装 CA 证书".to_string())
    }
    pub fn install_local_machine_via_uac(_cert_path: &Path) -> Result<(), String> {
        Err("当前平台暂不支持自动安装 CA 证书".to_string())
    }
    pub fn uninstall_from_store(_cn: &str, _current_user: bool) -> Result<(), String> {
        Err("当前平台暂不支持".to_string())
    }
    pub fn uninstall_local_machine_thumbprint_via_uac(_thumbprint: &str) -> Result<(), String> {
        Err("当前平台暂不支持".to_string())
    }
    pub fn uninstall_thumbprint_from_store(
        _thumbprint: &str,
        _current_user: bool,
    ) -> Result<(), String> {
        Err("当前平台暂不支持".to_string())
    }
}

// ──────────────────────────────────────────────────────────
// 公共 API
// ──────────────────────────────────────────────────────────

/// 查询 CA 在系统中的安装状态。
pub fn check_ca_status() -> CaStatus {
    let (cert_path, key_path) = cert_paths().unwrap_or_else(|_| {
        (
            PathBuf::from("certs/server.codeium.com.pem"),
            PathBuf::from("certs/server.codeium.com-key.pem"),
        )
    });
    let cert_exists = cert_path.exists();
    let key_exists = key_path.exists();
    let san_version = read_san_version(&cert_path);
    let san_current = is_san_current(&cert_path, cert_exists, key_exists);

    let thumbprint = if cert_exists {
        compute_thumbprint(&cert_path).ok()
    } else {
        None
    };
    let current_user = thumbprint
        .as_deref()
        .map(|t| platform::is_thumbprint_in_store(t, true))
        .unwrap_or_else(|| platform::is_in_store(CA_COMMON_NAME, true));
    let local_machine = thumbprint
        .as_deref()
        .map(|t| platform::is_thumbprint_in_store(t, false))
        .unwrap_or_else(|| platform::is_in_store(CA_COMMON_NAME, false));
    let legacy_residual = LEGACY_CA_COMMON_NAMES
        .iter()
        .any(|cn| platform::is_in_store(cn, true) || platform::is_in_store(cn, false));

    let effective_store = if current_user || local_machine {
        if current_user {
            CaStore::CurrentUser
        } else {
            CaStore::LocalMachine
        }
    } else {
        CaStore::None
    };

    let message = if cert_exists && key_exists && !san_current {
        format!(
            "MITM 证书缺少 Cursor 所需 SAN（当前标记: {}，需要: {}）；点击「生成 MITM 证书」或「安装证书」会重新生成",
            san_version.as_deref().unwrap_or("missing"),
            crate::commands::system::mitm_cert_san_version()
        )
    } else {
        match effective_store {
            CaStore::CurrentUser => format!(
                "当前 CA 证书已装到 {}（无需管理员权限），IDE 可信",
                current_user_store_label()
            ),
            CaStore::LocalMachine => format!(
                "当前 CA 证书已装到 {}（系统级，IDE 可信）",
                local_machine_store_label()
            ),
            CaStore::None => {
                if !cert_exists {
                    "证书文件未生成；点击「安装证书」会自动生成并安装".to_string()
                } else {
                    "当前 CA 证书尚未安装到系统根证书库，IDE 会拒绝连接".to_string()
                }
            }
        }
    };

    CaStatus {
        common_name: CA_COMMON_NAME.to_string(),
        cert_file: cert_path.to_string_lossy().to_string(),
        cert_exists,
        key_exists,
        san_version,
        san_current,
        current_user,
        local_machine,
        legacy_residual,
        thumbprint,
        effective_store,
        message,
    }
}

/// 一键安装 CA：先尝试 CurrentUser\Root（零弹窗），失败才走 UAC 兜底。
/// 升级路径会自动清理老证书。
pub fn install_ca() -> Result<String, String> {
    install_ca_impl(None)
}

fn install_ca_impl(app: Option<AppHandle>) -> Result<String, String> {
    eprintln!("[cert_install] install_ca: start");
    emit_cert_progress(app.as_ref(), "start", "开始安装 CA 证书", 5, "info");
    let (cert_path, key_path) = cert_paths()?;

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let san_current = is_san_current(&cert_path, cert_ok, key_ok);
    let auto_generate_msg = if !cert_ok || !key_ok || !san_current {
        let reason = if !cert_ok || !key_ok {
            "证书文件缺失或为空，正在自动生成 MITM 证书"
        } else {
            "MITM 证书缺少 Cursor 所需 SAN，正在重新生成"
        };
        emit_cert_progress(app.as_ref(), "auto_generate", reason, 8, "info");
        let (certs_dir, generated) = crate::commands::system::ensure_mitm_certs()
            .map_err(|e| format!("自动生成证书失败: {}", e))?;
        Some(if generated {
            format!("已自动生成证书到 {}", certs_dir.to_string_lossy())
        } else {
            "证书文件已存在".to_string()
        })
    } else {
        None
    };

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let san_current = is_san_current(&cert_path, cert_ok, key_ok);
    if !cert_ok || !key_ok || !san_current {
        return Err(format!(
            "证书文件自动生成后仍不完整或 SAN 标记未更新: {}, {} (san_current={})",
            cert_path.to_string_lossy(),
            key_path.to_string_lossy(),
            san_current
        ));
    }
    let thumbprint =
        compute_thumbprint(&cert_path).map_err(|e| format!("证书指纹计算失败: {}", e))?;
    emit_cert_progress(
        app.as_ref(),
        "check_file",
        &format!("证书文件已找到，Thumbprint: {}", thumbprint),
        12,
        "info",
    );

    // 清理老证书（不影响新证书安装）
    emit_cert_progress(app.as_ref(), "cleanup", "正在清理旧版残留证书", 20, "info");
    let _ = cleanup_legacy_cn();
    eprintln!("[cert_install] install_ca: legacy cleanup done");

    // 阶段 1：先试 CurrentUser\Root（零弹窗，95% 用户走到这里就完事了）
    // 调试 UAC 时可设置 ANYBRIDGE_FORCE_UAC_CERT_INSTALL=1 强制跳过本阶段。
    // 旧变量保留兼容，方便复用历史调试脚本。
    if std::env::var_os("ANYBRIDGE_FORCE_UAC_CERT_INSTALL").is_none()
        && std::env::var_os("IDE_BYOK_FORCE_UAC_CERT_INSTALL").is_none()
    {
        emit_cert_progress(
            app.as_ref(),
            "current_user",
            &format!(
                "正在安装到 {}（无需管理员权限）",
                current_user_store_label()
            ),
            35,
            "info",
        );
        match platform::install_current_user(&cert_path) {
            Ok(()) => {
                // 二次验证：实际查一下 CurrentUser\Root 确认装上了
                // certutil -user -addstore 在某些 GPO 限制下会静默失败。
                // 这里必须用当前证书文件的 Thumbprint 验证，不能用 CN；
                // 升级用户可能还持有旧 CN 的证书文件。
                emit_cert_progress(
                    app.as_ref(),
                    "verify_current_user",
                    "正在验证 CurrentUser\\Root 中的证书指纹",
                    55,
                    "info",
                );
                if platform::is_thumbprint_in_store(&thumbprint, true) {
                    eprintln!(
                        "[cert_install] install_ca: installed to {}",
                        current_user_store_label()
                    );
                    emit_cert_progress(
                        app.as_ref(),
                        "done",
                        &format!("CA 证书已安装到 {}", current_user_store_label()),
                        100,
                        "ok",
                    );
                    let install_msg = format!(
                        "CA 已安装到 {}（无需管理员权限）。Thumbprint: {}",
                        current_user_store_label(),
                        thumbprint
                    );
                    return Ok(match auto_generate_msg {
                        Some(prefix) => format!("{}\n{}", prefix, install_msg),
                        None => install_msg,
                    });
                }
                // 装完查不到，说明 GPO 拦截了，降级
            }
            Err(e) => {
                eprintln!(
                    "[cert_install] {} 失败: {}，继续请求 {}",
                    current_user_store_label(),
                    e,
                    admin_prompt_label()
                );
            }
        }
    } else {
        eprintln!(
            "[cert_install] install_ca: force admin cert install is set, skip {}",
            current_user_store_label()
        );
    }

    // 阶段 2：管理员授权，装到系统级根证书库。
    eprintln!(
        "[cert_install] install_ca: install to {} via {}",
        local_machine_store_label(),
        admin_prompt_label()
    );
    emit_cert_progress(
        app.as_ref(),
        "admin",
        &format!(
            "{} 验证未通过，正在请求 {} 授权安装到 {}",
            current_user_store_label(),
            admin_prompt_label(),
            local_machine_store_label()
        ),
        65,
        "warn",
    );
    platform::install_local_machine_via_uac(&cert_path)?;
    emit_cert_progress(
        app.as_ref(),
        "verify_local_machine",
        "UAC 安装完成，正在验证 LocalMachine\\Root 中的证书指纹",
        90,
        "info",
    );
    if !platform::is_thumbprint_in_store(&thumbprint, false) {
        emit_cert_progress(
            app.as_ref(),
            "error",
            &format!(
                "安装命令已退出但未在 {} 查到同一证书指纹",
                local_machine_store_label()
            ),
            100,
            "err",
        );
        return Err(format!(
            "安装命令已返回成功，但 {} 未查到当前证书 Thumbprint: {}",
            local_machine_store_label(),
            thumbprint
        ));
    }
    emit_cert_progress(
        app.as_ref(),
        "done",
        &format!("CA 证书已安装到 {}", local_machine_store_label()),
        100,
        "ok",
    );
    let install_msg = format!(
        "CA 已通过 {} 授权安装到 {}。Thumbprint: {}",
        admin_prompt_label(),
        local_machine_store_label(),
        thumbprint
    );
    Ok(match auto_generate_msg {
        Some(prefix) => format!("{}\n{}", prefix, install_msg),
        None => install_msg,
    })
}

/// 一键卸载 CA：两个 store 都尝试，幂等。
#[allow(dead_code)]
pub fn uninstall_ca() -> Result<String, String> {
    uninstall_ca_impl(None)
}

fn uninstall_ca_impl(app: Option<AppHandle>) -> Result<String, String> {
    emit_cert_progress(
        app.as_ref(),
        "uninstall_start",
        "开始卸载 CA 证书",
        5,
        "warn",
    );
    let mut removed = Vec::new();
    let current_thumbprint = cert_paths()
        .ok()
        .and_then(|(cert_path, _)| compute_thumbprint(&cert_path).ok());

    // CurrentUser 卸
    emit_cert_progress(
        app.as_ref(),
        "uninstall_current_user",
        &format!("正在检查并卸载 {} 中的证书", current_user_store_label()),
        25,
        "info",
    );
    if current_thumbprint
        .as_deref()
        .map(|t| platform::is_thumbprint_in_store(t, true))
        .unwrap_or_else(|| platform::is_in_store(CA_COMMON_NAME, true))
    {
        if let Some(t) = current_thumbprint.as_deref() {
            platform::uninstall_thumbprint_from_store(t, true)?;
        } else {
            platform::uninstall_from_store(CA_COMMON_NAME, true)?;
        }
        removed.push(current_user_store_label());
    }
    // LocalMachine 卸（需要 admin，触发 UAC 弹窗）
    emit_cert_progress(
        app.as_ref(),
        "uninstall_local_machine",
        &format!("正在检查 {} 中的证书", local_machine_store_label()),
        55,
        "info",
    );
    if current_thumbprint
        .as_deref()
        .map(|t| platform::is_thumbprint_in_store(t, false))
        .unwrap_or_else(|| platform::is_in_store(CA_COMMON_NAME, false))
    {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_uac",
            &format!(
                "检测到系统级证书，正在请求 {} 授权卸载",
                admin_prompt_label()
            ),
            70,
            "warn",
        );
        let uninstall_result = if let Some(t) = current_thumbprint.as_deref() {
            platform::uninstall_local_machine_thumbprint_via_uac(t)
        } else {
            platform::uninstall_from_store(CA_COMMON_NAME, false)
        };
        match uninstall_result {
            Ok(()) => removed.push(local_machine_store_label()),
            Err(e) => eprintln!("[cert_install] 卸 LocalMachine 失败: {}", e),
        }
    }

    if let Some(t) = current_thumbprint.as_deref() {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_verify",
            "正在验证证书是否已从系统证书库移除",
            90,
            "info",
        );
        let still_current_user = platform::is_thumbprint_in_store(t, true);
        let still_local_machine = platform::is_thumbprint_in_store(t, false);
        if still_current_user || still_local_machine {
            emit_cert_progress(
                app.as_ref(),
                "uninstall_error",
                "证书仍残留在系统证书库中",
                100,
                "err",
            );
            return Err(format!(
                "证书仍残留在: {}{}",
                if still_current_user {
                    current_user_store_label()
                } else {
                    ""
                },
                if still_local_machine {
                    local_machine_store_label()
                } else {
                    ""
                }
            ));
        }
    }

    // 顺手卸老证书
    let _ = cleanup_legacy_cn();

    if removed.is_empty() {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_done",
            "当前 CA 证书不在系统证书库，无需卸载",
            100,
            "ok",
        );
        Ok(format!(
            "CA \"{}\" 不在系统证书库，无需卸载",
            CA_COMMON_NAME
        ))
    } else {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_done",
            &format!("CA 证书已从 {} 卸载", removed.join(" + ")),
            100,
            "ok",
        );
        Ok(format!("CA 已从 {} 卸载", removed.join(" + ")))
    }
}

/// 清理老版本 CN 的证书残留。
/// 升级 AnyBridge 时自动调，避免新老并存导致 certutil 行为不确定。
/// 两个 store 都查（CurrentUser + LocalMachine），因为老版本
/// 经常用 certutil -addstore Root 装到 LM。
pub fn cleanup_legacy_cn() -> Result<String, String> {
    let mut msg = String::new();

    for cn in LEGACY_CA_COMMON_NAMES {
        // CurrentUser 先卸（不需要管理员）
        if platform::is_in_store(cn, true) {
            if let Ok(()) = platform::uninstall_from_store(cn, true) {
                msg.push_str(&format!("已清理老 CA \"{}\"（CurrentUser）\n", cn));
            }
        }

        // LocalMachine 也查（老版本经常装到 LM）
        if platform::is_in_store(cn, false) {
            // LM 卸需要 admin，会触发 UAC 弹窗，失败用户拒绝也无所谓
            match platform::uninstall_from_store(cn, false) {
                Ok(()) => msg.push_str(&format!("已清理老 CA \"{}\"（LocalMachine）\n", cn)),
                Err(_) => {
                    // 用户拒绝 UAC 也没关系，老证书不会影响新证书使用
                }
            }
        }
    }

    Ok(if msg.is_empty() {
        "无老证书残留".to_string()
    } else {
        msg
    })
}

// ──────────────────────────────────────────────────────────
// Tauri Commands（暴露给前端）
// ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn cert_check_status() -> CaStatus {
    check_ca_status()
}

async fn run_cert_task(
    label: &'static str,
    task: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    let handle = tauri::async_runtime::spawn_blocking(task);
    match tokio::time::timeout(std::time::Duration::from_secs(180), handle).await {
        Ok(result) => result.map_err(|e| format!("{}任务失败: {}", label, e))?,
        Err(_) => Err(format!(
            "{}超时。可能 UAC 弹窗被系统隐藏、用户未确认，或系统策略拦截了提权请求",
            label
        )),
    }
}

#[tauri::command]
pub async fn cert_install(app: AppHandle) -> Result<String, String> {
    let progress_app = app.clone();
    let result = run_cert_task("CA 安装", move || install_ca_impl(Some(progress_app))).await;
    if let Err(e) = &result {
        emit_cert_progress(
            Some(&app),
            "error",
            &format!("CA 证书安装失败: {}", e),
            100,
            "err",
        );
    }
    result
}

#[tauri::command]
pub async fn cert_uninstall(app: AppHandle) -> Result<String, String> {
    let progress_app = app.clone();
    let result = run_cert_task("CA 卸载", move || uninstall_ca_impl(Some(progress_app))).await;
    if let Err(e) = &result {
        emit_cert_progress(
            Some(&app),
            "uninstall_error",
            &format!("CA 证书卸载失败: {}", e),
            100,
            "err",
        );
    }
    result
}

#[tauri::command]
pub async fn cert_cleanup_legacy() -> Result<String, String> {
    run_cert_task("老证书清理", cleanup_legacy_cn).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "anybridge-cert-install-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn san_marker_requires_current_version_and_cert_files() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let cert_path = dir.join("server.codeium.com.pem");
        let marker_path = san_marker_path(&cert_path).expect("marker path");

        assert_eq!(read_san_version(&cert_path), None);
        assert!(!is_san_current(&cert_path, true, true));

        std::fs::write(&marker_path, "1\n").expect("write old marker");
        assert_eq!(read_san_version(&cert_path).as_deref(), Some("1"));
        assert!(!is_san_current(&cert_path, true, true));

        std::fs::write(
            &marker_path,
            format!("{}\n", crate::commands::system::mitm_cert_san_version()),
        )
        .expect("write current marker");
        assert!(is_san_current(&cert_path, true, true));
        assert!(!is_san_current(&cert_path, false, true));
        assert!(!is_san_current(&cert_path, true, false));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
