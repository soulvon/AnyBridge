// Windows 证书存储实现（仅在 #[cfg(target_os = "windows")] 下由 mod.rs 引入）。

use super::*;
use std::collections::HashSet;
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// UAC 子进程最长等待（ms）。不能无限等，否则 UI 会一直 Step is still running。
const CERTUTIL_WAIT_TIMEOUT_MS: u32 = 90_000;

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

/// 带超时运行 certutil；超时 kill 子进程，避免体检/安装步骤永久卡死。
fn run_certutil(args: &[&str]) -> Result<std::process::Output, String> {
    use std::io::Read;

    let mut child = Command::new(certutil_path())
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("certutil 启动失败: {}", e))?;

    // 后台读管道，避免输出塞满 pipe 导致子进程写阻塞、父进程等退出的死锁。
    let stdout_handle = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });

    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(CERTUTIL_CMD_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "certutil 超时（{}s）: {}",
                        CERTUTIL_CMD_TIMEOUT_SECS,
                        args.join(" ")
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Err(e) => return Err(format!("等待 certutil 失败: {}", e)),
        }
    };

    let stdout = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[allow(dead_code)]
fn certutil_success(args: &[&str]) -> bool {
    run_certutil(args)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_thumbprint_in_registry(thumbprint_hex: &str, current_user: bool) -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RegCloseKey, RegOpenKeyExW, KEY_READ,
    };
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;

    let subkey = format!(r"Software\Microsoft\SystemCertificates\Root\Certificates\{thumbprint_hex}");
    let wide_key: Vec<u16> = OsStr::new(&subkey).encode_wide().chain(std::iter::once(0)).collect();
    let root_hkey = if current_user {
        HKEY_CURRENT_USER
    } else {
        HKEY_LOCAL_MACHINE
    };

    let mut hkey = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(root_hkey, wide_key.as_ptr(), 0, KEY_READ, &mut hkey)
    };
    if status == ERROR_SUCCESS {
        unsafe { RegCloseKey(hkey); }
        true
    } else {
        false
    }
}

struct StoreCerts {
    thumbprints: HashSet<String>,
    names: HashSet<String>,
}

fn read_root_store_certs(current_user: bool) -> StoreCerts {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Cryptography::{
        CertOpenStore, CertCloseStore, CertEnumCertificatesInStore, CertGetNameStringW,
        CertGetCertificateContextProperty,
        CERT_STORE_PROV_SYSTEM_W, CERT_SYSTEM_STORE_CURRENT_USER, CERT_SYSTEM_STORE_LOCAL_MACHINE,
        CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_STORE_READONLY_FLAG, CERT_SHA1_HASH_PROP_ID,
    };

    let mut thumbprints = HashSet::new();
    let mut names = HashSet::new();

    let store_name: Vec<u16> = OsStr::new("Root")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let flags = CERT_STORE_READONLY_FLAG
        | if current_user {
            CERT_SYSTEM_STORE_CURRENT_USER
        } else {
            CERT_SYSTEM_STORE_LOCAL_MACHINE
        };

    let h_store = unsafe {
        CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W as _,
            0,
            0,
            flags,
            store_name.as_ptr() as _,
        )
    };

    if h_store.is_null() {
        return StoreCerts { thumbprints, names };
    }

    let mut p_ctx = std::ptr::null();
    let mut name_buf = [0u16; 256];
    let mut hash_buf = [0u8; 20];

    loop {
        p_ctx = unsafe { CertEnumCertificatesInStore(h_store, p_ctx) };
        if p_ctx.is_null() {
            break;
        }

        // 获取 CN/简单显示名
        let len = unsafe {
            CertGetNameStringW(
                p_ctx,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                0,
                std::ptr::null(),
                name_buf.as_mut_ptr(),
                name_buf.len() as u32,
            )
        };
        if len > 1 {
            let name = String::from_utf16_lossy(&name_buf[..(len as usize - 1)]);
            names.insert(name.to_lowercase());
        }

        // 获取 SHA1 Hash
        let mut hash_size = hash_buf.len() as u32;
        let ok = unsafe {
            CertGetCertificateContextProperty(
                p_ctx,
                CERT_SHA1_HASH_PROP_ID,
                hash_buf.as_mut_ptr() as _,
                &mut hash_size,
            )
        };
        if ok != 0 && hash_size == 20 {
            let hex_str = hex::encode_upper(&hash_buf);
            thumbprints.insert(hex_str);
        }
    }

    unsafe {
        CertCloseStore(h_store, 0);
    }

    StoreCerts { thumbprints, names }
}

/// 检查指定 CommonName 的证书是否在指定 store 里。
/// `current_user_only=true` 时只查 CurrentUser\Root，否则查 LocalMachine\Root。
pub fn is_in_store(cn: &str, current_user_only: bool) -> bool {
    let certs = read_root_store_certs(current_user_only);
    certs.names.contains(&cn.to_lowercase())
}

pub fn is_thumbprint_in_store(thumbprint: &str, current_user_only: bool) -> bool {
    let normalized: String = thumbprint
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect::<String>()
        .to_uppercase();
    if normalized.len() != 40 {
        return false;
    }
    // 优先尝试通过 Windows 注册表快速查找，避免每次都打开证书存储或启动进程
    if is_thumbprint_in_registry(&normalized, current_user_only) {
        return true;
    }
    let certs = read_root_store_certs(current_user_only);
    certs.thumbprints.contains(&normalized)
}

pub fn query_ca_store_status(
    thumbprint: Option<&str>,
    common_name: &str,
    legacy_cns: &[&str],
) -> (bool, bool, bool) {
    let normalized_tp = thumbprint.map(|t| {
        t.chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>()
            .to_uppercase()
    });

    let cn_lower = common_name.to_lowercase();
    let legacy_lowers: Vec<String> = legacy_cns.iter().map(|s| s.to_lowercase()).collect();

    // 快速注册表检测
    let cu_reg = normalized_tp
        .as_deref()
        .map(|t| is_thumbprint_in_registry(t, true))
        .unwrap_or(false);
    let lm_reg = normalized_tp
        .as_deref()
        .map(|t| is_thumbprint_in_registry(t, false))
        .unwrap_or(false);

    // 一次性读取 user 与 machine 证书库，避免为每个名字或指纹反复打开存储
    let cu_certs = read_root_store_certs(true);
    let lm_certs = read_root_store_certs(false);

    let current_user = cu_reg
        || normalized_tp
            .as_deref()
            .map(|t| cu_certs.thumbprints.contains(t))
            .unwrap_or(false)
        || cu_certs.names.contains(&cn_lower);

    let local_machine = lm_reg
        || normalized_tp
            .as_deref()
            .map(|t| lm_certs.thumbprints.contains(t))
            .unwrap_or(false)
        || lm_certs.names.contains(&cn_lower);

    let legacy_residual = legacy_lowers.iter().any(|cn| {
        cu_certs.names.contains(cn) || lm_certs.names.contains(cn)
    });

    (current_user, local_machine, legacy_residual)
}

/// 把 PEM 装到 CurrentUser\Root（不需要管理员权限）。
/// 用 certutil -user -addstore 强制走 user store，避免被任何机器策略拦截。
pub fn install_current_user(cert_path: &Path) -> Result<(), String> {
    let path = cert_path.to_string_lossy();
    let out = run_certutil(&["-f", "-user", "-addstore", "Root", path.as_ref()])?;
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
    // LocalMachine delstore 无提权会失败；显式 UAC 路径用 uninstall_local_machine_*_via_uac。
    // 这里不走 ShellExecute，避免后台 cleanup 意外弹 UAC。
    let out = if current_user {
        run_certutil(&["-user", "-delstore", "Root", cn])?
    } else {
        run_certutil(&["-delstore", "Root", cn])?
    };
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
    let out = if current_user {
        run_certutil(&["-user", "-delstore", "Root", normalized.as_str()])?
    } else {
        run_certutil(&["-delstore", "Root", normalized.as_str()])?
    };
    if !out.status.success() {
        return Err(format!(
            "按 Thumbprint 卸载 CA '{}' 失败: {}",
            normalized,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}
