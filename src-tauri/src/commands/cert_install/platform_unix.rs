#[cfg(any(target_os = "macos", target_os = "linux", test))]
use super::*;

// 交互上下文不可用不等于用户取消；保留系统原始错误，只为该情况补充恢复指引。
#[cfg(any(target_os = "macos", test))]
pub(super) fn macos_trust_error(error: &str, cert_path: &Path) -> String {
    if error.to_ascii_lowercase().contains("no user interaction was possible") {
        format!("macOS 无法显示证书信任授权界面。请在本地登录的桌面会话中打开「钥匙串访问」，核对并导入公开 CA {}，按系统提示授权 SSL 信任；不要导入私钥，也不要反复重生证书。受管设备请联系管理员。原始错误: {}", cert_path.display(), error)
    } else {
        error.to_string()
    }
}

#[cfg(target_os = "macos")]
mod impl_1 {
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

    /// 使用系统信任锚验证磁盘叶子证书；不验证运行中网关或 IDE 自带的信任库。
    pub fn verify_system_trust(cert_path: &Path) -> Result<(), String> {
        let leaf = cert_path.with_file_name(crate::commands::system::MITM_LEAF_CERT_FILE);
        // 多个 -c 按叶子、颁发者顺序提供链；不用 -r 强制信任本地 CA，-L 禁止联网补链。
        let mut child = Command::new("/usr/bin/security")
            .args(["verify-cert", "-p", "ssl", "-s", "server.codeium.com", "-L", "-c"])
            .arg(&leaf)
            .arg("-c")
            .arg(cert_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("无法启动 macOS SSL 信任验证: {}", e))?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => return Err(format!("macOS SSL 信任验证未通过 ({})，请检查当前 CA 信任、叶子证书链、主机名和有效期", status)),
                Ok(None) if started.elapsed() < std::time::Duration::from_secs(5) => {
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
                result => {
                    // 超时或等待失败均按未通过处理，并尝试终止、回收只读验证子进程。
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(match result {
                        Err(e) => format!("等待 macOS SSL 信任验证失败: {}", e),
                        _ => "macOS SSL 信任验证超时（5s），未判定为可信".into(),
                    });
                }
            }
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

    pub fn query_ca_store_status(
        thumbprint: Option<&str>,
        common_name: &str,
        legacy_cns: &[&str],
    ) -> (bool, bool, bool) {
        let current_user = thumbprint
            .map(|t| is_thumbprint_in_store(t, true))
            .unwrap_or_else(|| is_in_store(common_name, true));
        let local_machine = thumbprint
            .map(|t| is_thumbprint_in_store(t, false))
            .unwrap_or_else(|| is_in_store(common_name, false));
        let legacy_residual = legacy_cns
            .iter()
            .any(|cn| is_in_store(cn, true) || is_in_store(cn, false));
        (current_user, local_machine, legacy_residual)
    }

    pub fn install_current_user(cert_path: &Path) -> Result<(), String> {
        let kc = login_keychain()?;
        // 用户级安装不能带 `-d`；该参数会写入管理员信任设置并触发管理员授权。
        // 这里仅指定登录钥匙串，仍可能因钥匙串策略要求交互授权。
        run_security(
            &["add-trusted-cert", "-r", "trustRoot", "-k"],
            &[&kc, cert_path],
        )?;
        Ok(())
    }

    /// 仅由用户显式安装入口调用；网关后台不得调用该系统级提权路径。
    pub fn install_local_machine_via_uac(cert_path: &Path) -> Result<(), String> {
        let command = format!(
            "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain {}",
            shell_quote(&cert_path.to_string_lossy())
        );
        // 提权成功不保证信任设置具备交互上下文；失败时不绕过授权，也不自动轮换 CA。
        run_admin_shell(&command).map_err(|error| macos_trust_error(&error, cert_path))
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
#[cfg(target_os = "macos")]
pub(super) use impl_1::*;

#[cfg(target_os = "linux")]
mod impl_2 {
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

    pub fn query_ca_store_status(
        thumbprint: Option<&str>,
        common_name: &str,
        legacy_cns: &[&str],
    ) -> (bool, bool, bool) {
        let current_user = thumbprint
            .map(|t| is_thumbprint_in_store(t, true))
            .unwrap_or_else(|| is_in_store(common_name, true));
        let local_machine = thumbprint
            .map(|t| is_thumbprint_in_store(t, false))
            .unwrap_or_else(|| is_in_store(common_name, false));
        let legacy_residual = legacy_cns
            .iter()
            .any(|cn| is_in_store(cn, true) || is_in_store(cn, false));
        (current_user, local_machine, legacy_residual)
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
                "install -D -m 0644 {} {} && update-ca-certificates",
                cert_q,
                shell_quote(&anchor.to_string_lossy())
            );
            return run_pkexec_script(&script);
        }

        // Arch Linux / Manjaro:
        // 在 Arch/Manjaro 上通常同时有 update-ca-trust 和 trust，但系统 anchors 路径是 /etc/ca-certificates/trust-source/anchors
        let arch_anchor_dir = Path::new("/etc/ca-certificates/trust-source/anchors");
        if arch_anchor_dir.is_dir()
            || (!Path::new("/etc/pki/ca-trust/source/anchors").is_dir() && command_exists("trust"))
        {
            let arch_anchor = arch_anchor_dir.join("anybridge-local-ca.crt");
            let update_cmd = if command_exists("update-ca-trust") {
                "update-ca-trust extract"
            } else {
                "trust extract-compat"
            };
            let script = format!(
                "install -D -m 0644 {} {} && {}",
                cert_q,
                shell_quote(&arch_anchor.to_string_lossy()),
                update_cmd
            );
            return run_pkexec_script(&script);
        }

        // Fedora/RHEL/CentOS: update-ca-trust
        if command_exists("update-ca-trust") || Path::new("/etc/pki/ca-trust/source/anchors").is_dir() {
            let pki = PathBuf::from("/etc/pki/ca-trust/source/anchors/anybridge-local-ca.crt");
            let script = format!(
                "install -D -m 0644 {} {} && update-ca-trust extract",
                cert_q,
                shell_quote(&pki.to_string_lossy())
            );
            return run_pkexec_script(&script);
        }

        // Generic Arch fallback with trust
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
#[cfg(target_os = "linux")]
pub(super) use impl_2::*;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod impl_3 {
    use super::*;
    pub fn is_in_store(_cn: &str, _current_user_only: bool) -> bool {
        false
    }
    pub fn is_thumbprint_in_store(_thumbprint: &str, _current_user_only: bool) -> bool {
        false
    }
    pub fn query_ca_store_status(
        _thumbprint: Option<&str>,
        _common_name: &str,
        _legacy_cns: &[&str],
    ) -> (bool, bool, bool) {
        (false, false, false)
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
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(super) use impl_3::*;
