// cert_install.rs — 跨平台 CA 证书安装/卸载/状态查询。
//
// 核心策略（Windows 桌面端，95% 用户零弹窗）；macOS 的信任变更必须由显式桌面操作授权：
//   1. 优先装到 `Cert:\CurrentUser\Root`（不需要管理员权限，不弹 UAC）
//   2. Electron / Chromium 进程都会读 CurrentUser\Root，99% 桌面 Windows 可用
//   3. 如果 Electron 不认（极少数边角情况），降级到 `LocalMachine\Root`，
//      走 `certutil -addstore Root` + 触发 certutil 自带的 UAC 弹窗
//   4. 用户点"是" → 装到 LM → 完成
//
// 升级路径：
//   旧版 CN = "Windsurf BYOK Local MITM" / "IDE BYOK Local MITM" / "ide-byok Local CA"
//     → 新版 CN = "AnyBridge Local CA"
//   装新证书前自动 `cleanup_legacy_cn()` + 清理同 CN 旧指纹，避免新老并存。
//   「清理并重装」：force 重生 PEM + 重装信任库，适用于别人机器上证书乱/不匹配。

use sha1::Digest;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::commands::system::{CA_COMMON_NAME, LEGACY_CA_COMMON_NAMES};

/// 普通 certutil 调用超时（秒）。避免 verifystore/addstore 卡死导致 UI「Step is still running」。
#[cfg(target_os = "windows")]
const CERTUTIL_CMD_TIMEOUT_SECS: u64 = 20;
/// 显式安装/卸载整条任务超时（秒）。UAC 等待算在内。
const CERT_TASK_TIMEOUT_SECS: u64 = 120;

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
    /// macOS SSL 策略检查结果；None 表示未执行（平台不支持或材料缺失），不代表已信任。
    pub system_trusted: Option<bool>,
    /// 系统信任检查失败或超时的原因，与证书是否存在于存储中分开报告。
    pub trust_error: Option<String>,
    /// Node 系客户端（Antigravity IDE 的 CloudCode 请求）是否已信任本地 CA。
    /// 系统证书库可信不代表这一项可信：判据独立覆盖 NODE_EXTRA_CA_CERTS。
    pub node_trusted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
    pub level: String,
    /// 后端生成的任务 ID，用于关联日志、错误和进度。
    pub operation_id: Option<String>,
    /// 调用方提供的 UI 请求 ID，用于丢弃其他请求或已结束请求的迟到事件。
    pub request_id: Option<String>,
}

// 深层同步证书函数无需逐层传 ID；任务线程入口绑定上下文，供后续进度事件读取。
#[derive(Clone)]
struct CertOperationContext {
    operation_id: String,
    request_id: Option<String>,
}

thread_local! {
    // 进度产生于同步调用链；按工作线程隔离，避免并发任务串用彼此的 ID。
    static CERT_OPERATION_CONTEXT: std::cell::RefCell<Option<CertOperationContext>> = const { std::cell::RefCell::new(None) };
}

struct CertOperationContextGuard(Option<CertOperationContext>);

impl CertOperationContextGuard {
    // 保存并恢复旧值，以支持嵌套锁调用和 panic 展开时不泄漏到后续操作。
    fn set(operation_id: &str, request_id: Option<String>) -> Self {
        let previous = CERT_OPERATION_CONTEXT.with(|context| {
            context.replace(Some(CertOperationContext {
                operation_id: operation_id.to_string(),
                request_id,
            }))
        });
        Self(previous)
    }
}

impl Drop for CertOperationContextGuard {
    // 无论正常返回还是栈展开，都恢复进入作用域前的线程上下文。
    fn drop(&mut self) {
        CERT_OPERATION_CONTEXT.with(|context| {
            context.replace(self.0.take());
        });
    }
}

// 复制当前上下文后立即释放 RefCell 借用，避免事件发送期间持有线程本地借用。
fn current_cert_operation_context() -> Option<CertOperationContext> {
    CERT_OPERATION_CONTEXT.with(|context| context.borrow().clone())
}

// 深层同步流程统一走此入口，从当前任务上下文补齐关联 ID。
fn emit_cert_progress(
    app: Option<&AppHandle>,
    stage: &str,
    message: &str,
    percent: u8,
    level: &str,
) {
    emit_cert_progress_for_operation(
        app,
        stage,
        message,
        percent,
        level,
        current_cert_operation_context(),
    );
}

// 启动/结束事件可显式给出上下文；常规进度由 emit_cert_progress 读取线程本地上下文。
fn emit_cert_progress_for_operation(
    app: Option<&AppHandle>,
    stage: &str,
    message: &str,
    percent: u8,
    level: &str,
    context: Option<CertOperationContext>,
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
                operation_id: context.as_ref().map(|context| context.operation_id.clone()),
                request_id: context.and_then(|context| context.request_id),
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

// ──────────────────────────────────────────────────────────
// Node 系客户端 CA 信任（NODE_EXTRA_CA_CERTS）
//
// Antigravity IDE 的 CloudCode 请求走 Node TLS 栈：它只读进程启动时
// 的 NODE_EXTRA_CA_CERTS，不读 Electron/Chromium 使用的系统证书存储。
// 7452 HTTPS 端点由本地 CA 签发，仅把 CA 装进 Root 存储会让 IDE 报
// "self signed certificate in certificate chain"，模型目录拿不到注入模型。
// 证书安装必须同时对齐该变量，卸载时按账本还原用户原值。
// ──────────────────────────────────────────────────────────

/// NODE_EXTRA_CA_CERTS 只接受单个 PEM 文件：把用户原有内容与本地 CA 合并。
/// 幂等：已包含本地 CA 时原样返回，不重复追加。
fn node_ca_bundle_content(existing: &[u8], ca_pem: &[u8]) -> Vec<u8> {
    if node_ca_pem_contains(existing, ca_pem) {
        return existing.to_vec();
    }
    let mut out = existing.to_vec();
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(ca_pem);
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    out
}

fn node_ca_pem_contains(haystack: &[u8], ca_pem: &[u8]) -> bool {
    let needle = String::from_utf8_lossy(ca_pem).trim().to_string();
    !needle.is_empty() && String::from_utf8_lossy(haystack).contains(&needle)
}

fn node_ca_file_contains(path: &Path, ca_pem: &[u8]) -> bool {
    std::fs::read(path).map_or(false, |bytes| node_ca_pem_contains(&bytes, ca_pem))
}

#[cfg(target_os = "windows")]
const NODE_EXTRA_CA_CERTS_KEY: &str = "NODE_EXTRA_CA_CERTS";
#[cfg(target_os = "windows")]
const NODE_CA_BUNDLE_FILE: &str = "node-extra-ca-bundle.pem";
#[cfg(target_os = "windows")]
const NODE_CA_LEDGER_FILE: &str = "node-extra-ca-original.txt";

#[cfg(target_os = "windows")]
fn node_ca_registry(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("reg 执行失败: {e}"))
}

#[cfg(target_os = "windows")]
fn read_node_ca_env() -> Result<Option<String>, String> {
    let out = node_ca_registry(&["query", "HKCU\\Environment", "/v", NODE_EXTRA_CA_CERTS_KEY])?;
    if !out.status.success() {
        return Ok(None);
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if line.contains(NODE_EXTRA_CA_CERTS_KEY) {
            if let Some((_, value)) = line.split_once("REG_SZ") {
                let value = value.trim();
                if !value.is_empty() {
                    return Ok(Some(value.to_string()));
                }
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "windows")]
fn write_node_ca_env(value: &str) -> Result<(), String> {
    // 必须用 setx：它会广播 WM_SETTINGCHANGE，让 Explorer 刷新环境块。
    // 直接 reg add 不广播，用户从桌面/终端手动启动的 IDE 读不到新变量。
    use std::os::windows::process::CommandExt;
    let out = Command::new("setx")
        .args([NODE_EXTRA_CA_CERTS_KEY, value])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("setx 执行失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "写入 {} 失败: {}",
            NODE_EXTRA_CA_CERTS_KEY,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(target_os = "windows")]
fn delete_node_ca_env() -> Result<(), String> {
    // 置空而不是 reg delete：同样需要广播，且 Node 会忽略空的 CA 路径。
    // 账本为空即表示原本无此变量，置空等价于恢复原状。
    write_node_ca_env("")
}

/// bundle 与账本放在配置根目录，不进 certs 包，避免干扰证书包完整性校验。
#[cfg(target_os = "windows")]
fn node_ca_ledger_paths() -> (PathBuf, PathBuf) {
    let base = crate::commands::config::config_dir_path();
    (base.join(NODE_CA_BUNDLE_FILE), base.join(NODE_CA_LEDGER_FILE))
}

/// 证书安装 / 网关启动共用：幂等对齐 NODE_EXTRA_CA_CERTS。
/// 用户原有值合并进 bundle，绝不覆盖；账本只在首次接管时写入。
#[cfg(target_os = "windows")]
pub fn ensure_node_ca_trust() -> Result<(), String> {
    let (ca_path, _) = cert_paths()?;
    let ca_pem = std::fs::read(&ca_path).map_err(|e| format!("读取本地 CA 失败: {e}"))?;
    let (bundle_path, ledger_path) = node_ca_ledger_paths();
    let current = read_node_ca_env()?;

    if let Some(path) = current.as_deref() {
        if node_ca_file_contains(Path::new(path), &ca_pem) {
            return Ok(());
        }
    }

    let original = current.unwrap_or_default();
    let existing_pem = if original.is_empty() {
        Vec::new()
    } else {
        std::fs::read(Path::new(&original)).map_err(|e| format!(
            "原有 {} 指向的文件无法读取（{}），未覆盖用户配置",
            NODE_EXTRA_CA_CERTS_KEY, e
        ))?
    };

    if !ledger_path.exists() {
        std::fs::write(&ledger_path, original.as_bytes())
            .map_err(|e| format!("写入 Node CA 信任账本失败: {e}"))?;
    }
    std::fs::write(&bundle_path, node_ca_bundle_content(&existing_pem, &ca_pem))
        .map_err(|e| format!("写入 Node CA bundle 失败: {e}"))?;
    write_node_ca_env(&bundle_path.to_string_lossy())
}

/// 卸载对称：只在我们仍持有该变量时按账本还原；用户改过就原样保留。
#[cfg(target_os = "windows")]
pub fn restore_node_ca_trust() -> Result<(), String> {
    let (bundle_path, ledger_path) = node_ca_ledger_paths();
    let current = read_node_ca_env()?;
    let Some(current_value) = current else {
        let _ = std::fs::remove_file(&bundle_path);
        let _ = std::fs::remove_file(&ledger_path);
        return Ok(());
    };
    // 产品只写 bundle 路径；用户自己把变量指向 CA 文件不算我们持有，必须原样保留。
    let held_by_us = PathBuf::from(&current_value) == bundle_path;
    if !held_by_us {
        return Ok(());
    }
    let original = std::fs::read_to_string(&ledger_path).map_err(|e| format!(
        "Node CA 信任账本缺失，无法安全还原 {}（当前值: {}）: {}",
        NODE_EXTRA_CA_CERTS_KEY, current_value, e
    ))?;
    if original.is_empty() {
        delete_node_ca_env()?;
    } else {
        write_node_ca_env(&original)?;
    }
    let _ = std::fs::remove_file(&bundle_path);
    let _ = std::fs::remove_file(&ledger_path);
    Ok(())
}

/// 判据：读失败一律视为未就绪，绝不当作已信任。
pub fn node_ca_trust_ready() -> bool {
    #[cfg(target_os = "windows")]
    {
        let Ok((ca_path, _)) = cert_paths() else { return false };
        let Ok(ca_pem) = std::fs::read(&ca_path) else { return false };
        matches!(read_node_ca_env(), Ok(Some(path)) if node_ca_file_contains(Path::new(&path), &ca_pem))
    }
    #[cfg(not(target_os = "windows"))]
    {
        true // 该平台未启用 7452 自签端点信任路径，不参与 Windows 判据
    }
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
        && crate::commands::system::validate_mitm_cert_files(
            cert_path,
            &cert_path
                .parent()
                .map(|dir| dir.join("server.codeium.com-key.pem"))
                .unwrap_or_else(|| PathBuf::from("server.codeium.com-key.pem")),
        )
        .is_ok()
        && read_san_version(cert_path)
            .as_deref()
            .map(|version| version == crate::commands::system::mitm_cert_san_version())
            .unwrap_or(false)
}

pub(crate) fn current_user_store_label() -> &'static str {
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

pub(crate) fn local_machine_store_label() -> &'static str {
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

/// 按实际生效的信任库返回**当前平台**的称呼。
///
/// 早期实现直接 Debug 打印 `CaStore` 枚举（或硬编码 `LocalMachine\Root`），
/// 导致 macOS / Linux 用户看到 Windows 专属字样，误以为证书装错了位置。
pub(crate) fn store_label(store: CaStore) -> &'static str {
    match store {
        CaStore::CurrentUser => current_user_store_label(),
        CaStore::LocalMachine => local_machine_store_label(),
        CaStore::None => "未安装",
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

/// 提权失败时给用户的「自助安装指引」。
///
/// 提权被拒（用户没看到系统弹窗 / 取消 / 无交互会话）时，只回一句原始错误毫无用处：
/// 用户不知道下一步做什么。这里按平台给出可直接复制的命令。
fn manual_install_hint(cert_path: &Path) -> String {
    let p = cert_path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        let q = p.replace('\'', "'\\''");
        format!(
            "方式 A（推荐）：在「钥匙串访问」里双击 {p}，找到「AnyBridge Local CA」→ 双击 → 展开「信任」→ 「使用此证书时」选「始终信任」。\n\
             方式 B：终端执行\n  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '{q}'"
        )
    }
    #[cfg(target_os = "windows")]
    {
        format!(
            "以管理员身份打开 PowerShell 执行：\n  certutil -addstore Root \"{}\"",
            p
        )
    }
    #[cfg(target_os = "linux")]
    {
        let q = p.replace('\'', "'\\''");
        format!(
            "终端执行：\n  sudo cp '{q}' /usr/local/share/ca-certificates/anybridge-local-ca.crt && sudo update-ca-certificates"
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        format!("请把 {} 手动加入系统信任库", p)
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
}

// 交互上下文不可用不等于用户取消；保留系统原始错误，只为该情况补充恢复指引。
#[cfg(any(target_os = "macos", test))]
fn macos_trust_error(error: &str, cert_path: &Path) -> String {
    if error.to_ascii_lowercase().contains("no user interaction was possible") {
        format!("macOS 无法显示证书信任授权界面。请在本地登录的桌面会话中打开「钥匙串访问」，核对并导入公开 CA {}，按系统提示授权 SSL 信任；不要导入私钥，也不要反复重生证书。受管设备请联系管理员。原始错误: {}", cert_path.display(), error)
    } else {
        error.to_string()
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

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
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

// 已执行的系统检查失败时，证书存在也不算有效；未实现检查的平台保留原有存在性判定。
fn store_is_effective(current_user: bool, local_machine: bool, system_trusted: Option<bool>) -> bool {
    (current_user || local_machine) && system_trusted != Some(false)
}

// 仅 macOS 接入原生 SSL 策略检查；其他平台返回 None，而不是伪造检查成功。
fn system_trust_result(cert_path: &Path) -> Option<Result<(), String>> {
    #[cfg(target_os = "macos")]
    {
        Some(platform::verify_system_trust(cert_path))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cert_path;
        None
    }
}

// ──────────────────────────────────────────────────────────
// 公共 API
// ──────────────────────────────────────────────────────────
static CA_STATUS_CACHE: std::sync::Mutex<Option<(std::time::Instant, CaStatus)>> =
    std::sync::Mutex::new(None);
static LEGACY_RESIDUAL_CACHE: std::sync::Mutex<Option<(std::time::Instant, bool)>> =
    std::sync::Mutex::new(None);

pub fn invalidate_ca_status_cache() {
    if let Ok(mut g) = CA_STATUS_CACHE.lock() {
        *g = None;
    }
    if let Ok(mut g) = LEGACY_RESIDUAL_CACHE.lock() {
        *g = None;
    }
}

/// 查询 CA 在系统中的安装状态。
pub fn check_ca_status() -> CaStatus {
    // 1. 检查最近缓存（2 秒内直接返回，避免频繁调用如每秒状态轮询或批量保存时重复执行系统检测）
    if let Some(status) = cached_ca_status(&CA_STATUS_CACHE) {
        return status;
    }
    check_ca_status_fresh()
}

// 将缓存判断与系统访问分离，使过期测试不依赖真实钥匙串或系统命令耗时。
fn cached_ca_status(
    cache: &std::sync::Mutex<Option<(std::time::Instant, CaStatus)>>,
) -> Option<CaStatus> {
    let guard = cache.lock().ok()?;
    let (time, status) = guard.as_ref()?;
    (time.elapsed() < std::time::Duration::from_secs(2)).then(|| status.clone())
}

/// 绕过应用层状态缓存并回填新结果，供启动及安装后复验使用；不清除操作系统自身缓存。
pub(crate) fn check_ca_status_fresh() -> CaStatus {
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

    // 没有当前磁盘证书时，只能报告残留，不能按 CN 将其他证书认作当前 CA。
    let (current_user, local_machine, legacy_residual) = if thumbprint.is_some() {
        platform::query_ca_store_status(
            thumbprint.as_deref(),
            CA_COMMON_NAME,
            LEGACY_CA_COMMON_NAMES,
        )
    } else {
        let legacy_residual = LEGACY_CA_COMMON_NAMES
            .iter()
            .any(|cn| platform::is_in_store(cn, true) || platform::is_in_store(cn, false));
        (false, false, legacy_residual)
    };

    // 证书材料缺失时不运行 macOS SSL 子进程，避免用“验证失败”掩盖“文件未生成”。
    let trust_result = if cert_exists && key_exists {
        system_trust_result(&cert_path)
    } else {
        None
    };
    let system_trusted = trust_result.as_ref().map(Result::is_ok);
    let trust_error = trust_result.and_then(Result::err);
    let effective_store = if cert_exists && key_exists && san_current
        && store_is_effective(current_user, local_machine, system_trusted)
    {
        if current_user {
            CaStore::CurrentUser
        } else {
            CaStore::LocalMachine
        }
    } else {
        CaStore::None
    };

    // 优先报告缺失材料和原始信任错误；存储位置不能证明 IDE 使用的信任库已接受该链。
    let message = if !cert_exists || !key_exists {
        "证书材料缺失；请先停止网关，在环境检测中生成证书，再显式安装信任".to_string()
    } else if let Some(error) = &trust_error {
        error.clone()
    } else if cert_exists && key_exists && !san_current {
        format!(
            "MITM 证书缺少当前 SAN 或证书材料无效（当前标记: {}，需要: {}）；请先停止网关，生成证书后显式安装信任",
            san_version.as_deref().unwrap_or("missing"),
            crate::commands::system::mitm_cert_san_version()
        )
    } else {
        match effective_store {
            CaStore::CurrentUser => format!(
                "当前 CA 证书存在于 {}；证书存在不代表 IDE 已信任，请验证实际 TLS 请求",
                current_user_store_label()
            ),
            CaStore::LocalMachine => format!(
                "当前 CA 证书存在于 {}（系统级）；仍需验证系统信任和 IDE 实际 TLS 请求",
                local_machine_store_label()
            ),
            CaStore::None => "当前 CA 证书未完成系统信任；请显式安装信任并验证 IDE 实际 TLS 请求".to_string(),
        }
    };

    // 系统证书库可信只是 Electron/Chromium 那条链；Node TLS 栈需单独判据。
    let node_trusted = node_ca_trust_ready();
    let message = if node_trusted {
        message
    } else {
        format!("{message}；Node 客户端（Antigravity IDE 的 CloudCode 请求）尚未信任本地 CA，请在环境检测安装证书并重启 IDE")
    };

    let res = CaStatus {
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
        system_trusted,
        trust_error,
        node_trusted,
    };

    if let Ok(mut guard) = CA_STATUS_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), res.clone()));
    }

    res
}

/// 显式安装 CA：Windows 当前策略直接请求系统级授权；用户级尝试由 install_ca_user_only 提供。
/// macOS 只修复当前有效证书包的信任，不轮换 CA 或自动清理旧根。
/// 此底层入口不获取任务锁或网关占位，桌面调用方须在外层提供保护。
#[allow(dead_code)]
pub fn install_ca() -> Result<String, String> {
    install_ca_with_options(false, false)
}

/// 仅尝试用户级信任库，不请求管理员授权；供网关启动/体检的保守修复路径使用。
/// Windows 用户级安装仍可能显示系统安全确认，但不会进入提权路径。
#[allow(dead_code)]
pub fn install_ca_user_only(
    force_regenerate: bool,
    prefer_fresh_install: bool,
) -> Result<String, String> {
    install_ca_impl(None, force_regenerate, prefer_fresh_install, false)
}

/// `force_regenerate`：Windows/其他平台删除 PEM 并重生后再安装（「清理并重装」）；
/// macOS 分支保留当前有效证书包，不在授权失败前覆盖证书。
/// `prefer_fresh_install`：安装前先清掉当前 CN 下不匹配的旧指纹（防止同名多证书乱）。
#[allow(dead_code)]
pub fn install_ca_with_options(
    force_regenerate: bool,
    prefer_fresh_install: bool,
) -> Result<String, String> {
    install_ca_impl(None, force_regenerate, prefer_fresh_install, true)
}

/// 尝试从 user store 按 CN 卸载当前产品 CA（无需管理员）。
/// 用于「同 CN 旧指纹」清理：重生后旧证书还在库里时先卸掉再装新的。
fn cleanup_stale_current_user_cn(keep_thumbprint: &str) -> String {
    // 当前指纹已在库里 → 无需清
    if platform::is_thumbprint_in_store(keep_thumbprint, true) {
        return String::new();
    }
    // CN 存在但指纹不匹配 → 是旧轮证书，卸掉
    if !platform::is_in_store(CA_COMMON_NAME, true) {
        return String::new();
    }
    match platform::uninstall_from_store(CA_COMMON_NAME, true) {
        Ok(()) => format!(
            "已清除 {} 中同名旧 CA \"{}\"\n",
            current_user_store_label(),
            CA_COMMON_NAME
        ),
        Err(e) => {
            eprintln!(
                "[cert_install] cleanup stale CurrentUser CN failed: {}",
                e
            );
            String::new()
        }
    }
}

// 公共入口取得独占包锁；已由组合流程持锁时改走下层函数，避免 flock 重入自冲突。
fn install_ca_impl(
    app: Option<AppHandle>,
    force_regenerate: bool,
    prefer_fresh_install: bool,
    allow_admin: bool,
) -> Result<String, String> {
    let _package_lock = crate::commands::system::acquire_mitm_package_write_lock()?;
    let result = install_ca_impl_with_package_lock(app, force_regenerate, prefer_fresh_install, allow_admin);
    // 证书装进系统信任库只覆盖 Electron/Chromium；Node TLS 栈要单独对齐。
    // 所有显式安装入口都经过这里，与卸载入口成对。
    if result.is_ok() {
        #[cfg(target_os = "windows")]
        ensure_node_ca_trust()?;
    }
    result
}

pub(crate) fn install_ca_impl_with_package_lock(
    app: Option<AppHandle>,
    force_regenerate: bool,
    prefer_fresh_install: bool,
    allow_admin: bool,
) -> Result<String, String> {
    invalidate_ca_status_cache();
    eprintln!(
        "[cert_install] install_ca: start force={} fresh={} allow_admin={}",
        force_regenerate, prefer_fresh_install, allow_admin
    );
    emit_cert_progress(
        app.as_ref(),
        "start",
        if force_regenerate {
            "开始清理并重装 CA 证书"
        } else {
            "开始安装 CA 证书"
        },
        5,
        "info",
    );
    let (cert_path, key_path) = cert_paths()?;
    let certs_dir = cert_path.parent().ok_or("CA 路径缺少父目录")?;
    // 候选目录可能属于仍在运行的生成任务；包状态不确定时不修改系统信任，也不自动清理现场。
    crate::commands::system::reject_interrupted_mitm_candidates(certs_dir)?;

    // macOS 的重装入口只修复当前包的信任，不执行 force_regenerate 或旧根清理。
    // 避免授权失败前已覆盖磁盘证书，导致网关内存、磁盘与钥匙串使用不同证书。
    if cfg!(target_os = "macos") {
        let leaf_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_CERT_FILE);
        let leaf_key = cert_path.with_file_name(crate::commands::system::MITM_LEAF_KEY_FILE);
        if is_san_current(&cert_path, cert_path.exists(), key_path.exists())
            && crate::commands::system::validate_mitm_cert_files(&leaf_path, &leaf_key).is_ok()
        {
            // CA 文件存在也不代表配套私钥正确；在任何系统信任探测或授权前验证公私钥匹配。
            crate::commands::system::validate_mitm_cert_files(&cert_path, &key_path)
                .map_err(|e| format!("macOS CA 证书包校验失败，未请求信任授权: {}", e))?;
            // 授权前先验证磁盘链，避免为错误链申请信任；失败不轮换文件或修改钥匙串。
            let certs_dir = cert_path.parent().ok_or("CA 路径缺少父目录")?;
            crate::commands::system::validate_mitm_candidate_chain(certs_dir)
                .map_err(|e| format!("macOS 证书包离线校验失败，未请求信任授权: {}", e))?;

            if system_trust_result(&cert_path).is_some_and(|result| result.is_ok()) {
                return Ok("macOS SSL 信任验证已通过，无需重装或轮换证书；请验证 IDE 实际请求".into());
            }

            if !allow_admin {
                return Err("macOS 信任变更需要显式授权，请在环境检测中点击安装证书；后台不会修改钥匙串".into());
            }
            emit_cert_progress(app.as_ref(), "admin", "正在修复现有 CA 的系统信任，不轮换证书；请在 macOS 系统授权界面确认", 65, "warn");
            platform::install_local_machine_via_uac(&cert_path)?;
            invalidate_ca_status_cache();

            // 命令退出成功不等于可信：当前指纹入库与系统 SSL 链验证必须分别通过。
            let thumbprint = compute_thumbprint(&cert_path)?;
            if !platform::is_thumbprint_in_store(&thumbprint, false) {
                return Err("安装命令已退出，但 System keychain 未找到当前 CA 指纹".into());
            }
            if let Some(result) = system_trust_result(&cert_path) {
                result?;
            }

            return Ok("现有 CA 信任安装及 macOS SSL 验证已完成，未轮换证书；请重新运行环境检测并验证 IDE 实际请求".into());
        }

        return Err("macOS 当前证书包缺失或无效。请先停止网关，在环境检测中生成证书，再显式安装信任；本次未覆盖证书或清理钥匙串".into());
    }

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let leaf_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_CERT_FILE);
    let leaf_key_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_KEY_FILE);
    // 此处仅按文件存在性决定是否补齐旧包；补齐后还会单独校验叶子证书、私钥及签名链。
    let leaf_ok = leaf_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && leaf_key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let san_current = is_san_current(&cert_path, cert_ok, key_ok);
    let need_generate = force_regenerate || !cert_ok || !key_ok || !leaf_ok || !san_current;
    let auto_generate_msg = if need_generate {
        let reason = if force_regenerate {
            "正在强制重新生成 MITM 证书"
        } else if !cert_ok || !key_ok || !leaf_ok {
            "证书包文件缺失或为空，正在自动生成 MITM 证书"
        } else {
            "MITM 证书缺少 Cursor 所需 SAN，正在重新生成"
        };
        emit_cert_progress(app.as_ref(), "auto_generate", reason, 8, "info");
        let (certs_dir, generated) =
            crate::commands::system::ensure_mitm_certs_ex_unlocked(force_regenerate)
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
    // 文件存在不代表证书包可用；安装前再次确认叶子证书与私钥有效且匹配。
    let leaf_ok = leaf_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && leaf_key_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
        && crate::commands::system::validate_mitm_cert_files(&leaf_path, &leaf_key_path).is_ok();
    let san_current = is_san_current(&cert_path, cert_ok, key_ok);
    if !cert_ok || !key_ok || !leaf_ok || !san_current {
        return Err(format!(
            "证书文件自动生成后仍不完整或 SAN 标记未更新: {}, {} (leaf_ok={}, san_current={})",
            cert_path.to_string_lossy(),
            key_path.to_string_lossy(),
            leaf_ok,
            san_current
        ));
    }
    // 所有平台都必须先验证叶子到当前 CA 的离线链，防止仅凭 CA 文件存在就写入系统信任。
    crate::commands::system::validate_mitm_candidate_chain(
        cert_path.parent().ok_or("CA 路径缺少父目录")?,
    )
    .map_err(|e| format!("证书包离线校验失败，未执行信任安装: {}", e))?;
    let thumbprint =
        compute_thumbprint(&cert_path).map_err(|e| format!("证书指纹计算失败: {}", e))?;
    emit_cert_progress(
        app.as_ref(),
        "check_file",
        &format!("证书文件已找到，Thumbprint: {}", thumbprint),
        12,
        "info",
    );

    // 已安装且指纹一致、非 force → 幂等返回（避免重复弹 UAC）
    if !force_regenerate && !prefer_fresh_install {
        let already_user = platform::is_thumbprint_in_store(&thumbprint, true);
        let already_machine = platform::is_thumbprint_in_store(&thumbprint, false);
        if already_user || already_machine {
            let store = if already_user {
                current_user_store_label()
            } else {
                local_machine_store_label()
            };
            // 仍尝试清理 legacy，不影响成功路径
            // 非 Windows 的后台路径不能顺带调用可能提权的旧根清理。
            if allow_admin || cfg!(target_os = "windows") {
                let _ = cleanup_legacy_cn();
            }
            let msg = format!(
                "CA 已在 {}（无需重装）。Thumbprint: {}",
                store, thumbprint
            );
            emit_cert_progress(app.as_ref(), "done", &msg, 100, "ok");
            return Ok(match auto_generate_msg {
                Some(prefix) => format!("{prefix}\n{msg}"),
                None => msg,
            });
        }
    }

    // 清理老 CN + 同 CN 旧指纹（不影响新证书安装）
    emit_cert_progress(app.as_ref(), "cleanup", "正在清理旧版/残留证书", 20, "info");
    let mut cleanup_notes = String::new();
    // 非 Windows 的后台路径不能顺带调用可能提权的旧根清理。
    if allow_admin || cfg!(target_os = "windows") {
        if let Ok(legacy_msg) = cleanup_legacy_cn() {
            if legacy_msg != "无老证书残留" {
                cleanup_notes.push_str(&legacy_msg);
            }
        }
    }
    if force_regenerate || prefer_fresh_install || need_generate {
        cleanup_notes.push_str(&cleanup_stale_current_user_cn(&thumbprint));
    }
    eprintln!("[cert_install] install_ca: cleanup done");

    // 阶段 1：仅 allow_admin=false（纯静默/修复路径）才先试 CurrentUser\Root。
    // allow_admin=true 时跳过 CurrentUser，直接走阶段 2 提权装 LocalMachine\Root——
    // 因为 CurrentUser 安装会触发 Windows「安全警告」弹窗，而提权进程装 LocalMachine\Root
    // 不会弹该警告（UAC 提权本身就是授权门槛），实现「自动提权 + 静默无感」。
    // 调试 UAC 时可设置 ANYBRIDGE_FORCE_UAC_CERT_INSTALL=1 强制跳过本阶段。
    let force_admin = std::env::var_os("ANYBRIDGE_FORCE_UAC_CERT_INSTALL").is_some()
        || std::env::var_os("IDE_BYOK_FORCE_UAC_CERT_INSTALL").is_some();
    // macOS：用户级（login keychain）既不需要管理员密码，也不会弹「安全警告」，
    // 所以即使允许提权也应先试用户级，失败再提权 —— 多数用户因此根本不用输管理员密码。
    // Windows 相反：CurrentUser 安装会弹「安全警告」，允许提权时直接走 UAC 更干净。
    #[cfg(target_os = "macos")]
    let try_user_first = !force_admin;
    #[cfg(not(target_os = "macos"))]
    let try_user_first = !allow_admin && !force_admin;

    if try_user_first {
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
                // 必须用当前证书文件的 Thumbprint 验证，不能用 CN
                emit_cert_progress(
                    app.as_ref(),
                    "verify_current_user",
                    &format!("正在验证 {} 中的证书指纹", current_user_store_label()),
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
                    let body = if cleanup_notes.is_empty() {
                        install_msg
                    } else {
                        format!("{cleanup_notes}{install_msg}")
                    };
                    return Ok(match auto_generate_msg {
                        Some(prefix) => format!("{prefix}\n{body}"),
                        None => body,
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

    // 静默/修复路径：不弹 UAC。让用户在体检里点「安装证书」显式操作。
    if !allow_admin {
        let msg = format!(
            "已尝试安装到 {}，但验证未通过（可能被组策略拦截）。请在「环境检测」点「安装证书」或「清理并重装」（可能需要 {}）。Thumbprint: {}",
            current_user_store_label(),
            admin_prompt_label(),
            thumbprint
        );
        emit_cert_progress(app.as_ref(), "need_admin", &msg, 100, "warn");
        let body = if cleanup_notes.is_empty() {
            msg
        } else {
            format!("{cleanup_notes}{msg}")
        };
        return Err(match auto_generate_msg {
            Some(prefix) => format!("{prefix}\n{body}"),
            None => body,
        });
    }

    // 阶段 2：仅用户显式触发时请求管理员授权，装到系统级根证书库。
    // 网关启动和后台体检不应进入此分支，避免隐藏或不可交互的授权弹窗。
    eprintln!(
        "[cert_install] install_ca: install to {} via {}",
        local_machine_store_label(),
        admin_prompt_label()
    );
    emit_cert_progress(
        app.as_ref(),
        "admin",
        &format!(
            "正在请求 {} 授权安装到 {}，请按系统提示确认。授权窗口可能被其它窗口挡住或出现在另一个桌面；若未显示，请切换到本地登录的桌面会话。",
            admin_prompt_label(),
            local_machine_store_label()
        ),
        65,
        "warn",
    );
    if let Err(e) = platform::install_local_machine_via_uac(&cert_path) {
        emit_cert_progress(
            app.as_ref(),
            "error",
            "授权未完成，证书尚未装入系统信任库",
            100,
            "err",
        );
        return Err(format!(
            "{}授权未完成：{}\n\n当前状态：证书文件已{}，但系统信任库里没有它，IDE 会拒绝 MITM 证书（表现为模型列表/对话报 bad certificate）。\n\n请二选一：\n1）重新点「安装证书」或「清理并重装」，这次留意系统弹窗并输入密码；\n2）手动安装：\n{}\n\n完成后请完全退出 IDE（macOS 用 Cmd+Q）再打开。",
            admin_prompt_label(),
            e,
            if force_regenerate { "重新生成" } else { "生成" },
            manual_install_hint(&cert_path)
        ));
    }
    emit_cert_progress(
        app.as_ref(),
        "verify_local_machine",
        &format!("授权完成，正在验证 {} 中的证书指纹", local_machine_store_label()),
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
    let body = if cleanup_notes.is_empty() {
        install_msg
    } else {
        format!("{cleanup_notes}{install_msg}")
    };
    Ok(match auto_generate_msg {
        Some(prefix) => format!("{prefix}\n{body}"),
        None => body,
    })
}

/// 一键卸载 CA：两个 store 都尝试，幂等。
#[allow(dead_code)]
pub fn uninstall_ca() -> Result<String, String> {
    uninstall_ca_impl(None)
}

// 卸载可能修改当前 CA 信任；与安装和证书轮换共享同一跨进程独占锁。
fn uninstall_ca_impl(app: Option<AppHandle>) -> Result<String, String> {
    let _package_lock = crate::commands::system::acquire_mitm_package_write_lock()?;
    uninstall_ca_impl_with_package_lock(app)
}

fn uninstall_ca_impl_with_package_lock(app: Option<AppHandle>) -> Result<String, String> {
    invalidate_ca_status_cache();
    emit_cert_progress(
        app.as_ref(),
        "uninstall_start",
        "开始卸载 CA 证书",
        5,
        "warn",
    );
    let mut removed = Vec::new();

    // macOS 缺少确切指纹时停止，不把当前 CA 卸载扩大为同名证书删除。
    let current_thumbprint = if cfg!(target_os = "macos") {
        let (cert_path, _) = cert_paths()?;
        Some(compute_thumbprint(&cert_path).map_err(|e| format!(
            "无法确认待卸载 CA 指纹，未修改钥匙串；请在钥匙串访问中核对证书后手动处理: {}", e
        ))?)
    } else {
        cert_paths().ok().and_then(|(cert_path, _)| compute_thumbprint(&cert_path).ok())
    };

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
    // macOS 卸载只针对当前确切指纹；旧根需要独立确认，不随当前 CA 卸载一起删除。
    if !cfg!(target_os = "macos") {
        let _ = cleanup_legacy_cn();
    }

    // 与 install_ca_impl 对称：按账本还原 NODE_EXTRA_CA_CERTS，保留用户改动。
    #[cfg(target_os = "windows")]
    restore_node_ca_trust()?;

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
    // macOS 目前没有按确切指纹枚举并逐项确认的清理流程；拒绝按 CN 批量删除，
    // 防止误删企业管理证书、其他安装来源的根证书或用户明确保留的旧根。
    if cfg!(target_os = "macos") {
        return Err(
            "macOS 旧根清理需要用户逐项确认确切指纹；当前未执行任何钥匙串删除，请在钥匙串访问中手动核对".into(),
        );
    }

    invalidate_ca_status_cache();
    let mut msg = String::new();

    for cn in LEGACY_CA_COMMON_NAMES {
        // CurrentUser 先卸（不需要管理员）
        if platform::is_in_store(cn, true) {
            if let Ok(()) = platform::uninstall_from_store(cn, true) {
                msg.push_str(&format!("已清理老 CA \"{}\"（CurrentUser）\n", cn));
            }
        }

        // LocalMachine：仅检测/尝试非提权 delstore（无 UAC）。
        // 不能在 cleanup_legacy 里弹 UAC，否则体检修复会卡死。
        if platform::is_in_store(cn, false) {
            match platform::uninstall_from_store(cn, false) {
                Ok(()) => msg.push_str(&format!("已清理老 CA \"{}\"（LocalMachine）\n", cn)),
                Err(_) => {
                    msg.push_str(&format!(
                        "检测到老 CA \"{}\"（LocalMachine），需要管理员权限才能清理；不影响当前用户级证书\n",
                        cn
                    ));
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

/// 串行化经此入口提交的证书任务；直接调用底层函数不受此保护。
static CERT_TASK_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// 正常返回、错误返回及 panic 展开时都失效缓存并释放占位，不把失败前的状态留给后续轮询。
struct CertTaskGuard {
    operation_id: String,
}

// 时间戳、进程号和进程内序号仅用于诊断关联，不承载密钥或授权凭据。
fn next_cert_operation_id() -> String {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos();
    format!("cert-{}-{stamp}-{sequence}", std::process::id())
}

impl Drop for CertTaskGuard {
    fn drop(&mut self) {
        // 守卫释放只表示底层任务结束，错误或 panic 路径也会经过这里，不代表操作成功。
        eprintln!("[cert_install][{}] task_finished", self.operation_id);
        invalidate_ca_status_cache();
        CERT_TASK_RUNNING.store(
            false,
            std::sync::atomic::Ordering::Release,
        );
    }
}

// 非阻塞获取：并发及嵌套调用直接报忙，不排队等待系统授权，避免重复弹窗或自锁。
fn acquire_cert_task() -> Result<CertTaskGuard, String> {
    if CERT_TASK_RUNNING
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return Err("另一个证书任务仍在执行，请等待完成后再操作".into());
    }
    let operation_id = next_cert_operation_id();
    eprintln!("[cert_install][{}] task_started", operation_id);
    Ok(CertTaskGuard { operation_id })
}

/// 为同步体检/启动路径复用同一证书互斥，避免自动修复与显式操作并发。
// 同步自动修复也绑定后端操作 ID；没有 UI 请求时 request_id 保持为空。
pub(crate) fn with_cert_task_lock<T>(
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let guard = acquire_cert_task()?;
    let _operation_context = CertOperationContextGuard::set(&guard.operation_id, None);
    task().map_err(|error| format!("{} [操作 ID: {}]", error, guard.operation_id))
}

pub(crate) async fn run_cert_task(
    label: &'static str,
    app: Option<AppHandle>,
    request_id: Option<String>,
    task: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    // 外层超时不会取消已运行的阻塞任务；将守卫移入任务，实际结束后才允许下一次操作。
    let guard = acquire_cert_task()?;

    // 外层等待与阻塞任务共享同一个 ID；超时后守卫仍由阻塞任务持有。
    let operation_id = guard.operation_id.clone();

    // request ID 仅用于 UI 事件关联，限制格式和长度，避免任意调用方数据进入事件/日志。
    let request_id = request_id.filter(|id| id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let task_operation_id = operation_id.clone();
    let task_request_id = request_id.clone();

    // 先发起始事件，让前端在任何深层进度到达前建立本次请求与后端操作的关联。
    emit_cert_progress_for_operation(app.as_ref(), "start", label, 0, "info", Some(CertOperationContext {
        operation_id: operation_id.clone(),
        request_id: request_id.clone(),
    }));

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        // 线程本地状态不能跨 spawn_blocking 自动继承，必须在实际工作的线程重新绑定。
        let _operation_context = CertOperationContextGuard::set(&task_operation_id, task_request_id);
        task()
    });

    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(CERT_TASK_TIMEOUT_SECS),
        handle,
    )
    .await
    {
        Ok(Ok(task_result)) => task_result.map_err(|error| format!("{} [操作 ID: {}]", error, operation_id)),
        Ok(Err(error)) => Err(format!("{}任务失败: {} [操作 ID: {}]", label, error, operation_id)),
        Err(_) => Err(format!(
            "{}超时（{}s）。系统授权或证书操作尚未返回；底层任务可能仍在执行，请勿重复操作，先检查系统授权界面 [操作 ID: {}]",
            label, CERT_TASK_TIMEOUT_SECS, operation_id
        )),
    };
    // 统一在包装层发最终错误事件，涵盖任务错误、JoinError 和外层超时。
    if let Err(error) = &result {
        emit_cert_progress_for_operation(
            app.as_ref(),
            "error",
            error,
            100,
            "err",
            Some(CertOperationContext { operation_id, request_id }),
        );
    }
    result
}

// 先占证书任务、再检查并占用网关启动位；检查覆盖整个安装过程，不只保护文件生成。
// request_id 只用于把前端进度事件归回发起它的 UI 调用。
#[tauri::command]
pub async fn cert_install(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    let progress_app = app.clone();
    run_cert_task("CA 安装", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, || {
            install_ca_impl(Some(progress_app), false, false, true)
        })
    })
    .await
}

/// 停止状态下按平台策略重装；macOS 只修复现有有效包的信任，不执行强制轮换。
/// request_id 用于将本次 UI 请求与进度事件关联。
#[tauri::command]
pub async fn cert_reinstall_clean(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    let progress_app = app.clone();
    run_cert_task("CA 清理并重装", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, || {
            install_ca_impl(Some(progress_app), true, true, true)
        })
    })
    .await
}

// 卸载也需保持网关停止，避免运行中的 TLS 链突然失去信任；失败由前端按错误展示。
// request_id 用于将本次 UI 请求与进度事件关联。
#[tauri::command]
pub async fn cert_uninstall(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    let progress_app = app.clone();
    run_cert_task("CA 卸载", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, || {
            uninstall_ca_impl(Some(progress_app))
        })
    })
    .await
}

// 清理可能涉及系统授权，只从显式操作执行；与其他证书任务共享互斥及网关停止约束。
// request_id 用于将本次 UI 请求与进度事件关联。
#[tauri::command]
pub async fn cert_cleanup_legacy(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    run_cert_task("老证书清理", Some(app), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, cleanup_legacy_cn)
    })
    .await
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

    // 验证嵌套任务退出后恢复外层 ID，且最终清空上下文；不触碰系统证书库。
    #[test]
    fn certificate_operation_context_is_scoped_and_restored() {
        assert!(current_cert_operation_context().is_none());
        {
            let _context = CertOperationContextGuard::set("operation-a", Some("request-a".into()));
            let context = current_cert_operation_context().expect("operation context");
            assert_eq!(context.operation_id, "operation-a");
            assert_eq!(context.request_id.as_deref(), Some("request-a"));
            {
                let _nested = CertOperationContextGuard::set("operation-b", None);
                let nested = current_cert_operation_context().expect("nested operation context");
                assert_eq!(nested.operation_id, "operation-b");
            }
            assert_eq!(current_cert_operation_context().unwrap().operation_id, "operation-a");
        }
        assert!(current_cert_operation_context().is_none());
    }

    #[test]
    fn certificate_operation_ids_are_distinct() {
        let ids: std::collections::HashSet<_> = (0..1000)
            .map(|_| next_cert_operation_id()).collect();
        assert_eq!(ids.len(), 1000);
        assert!(ids.iter().all(|id| id.starts_with(&format!("cert-{}-", std::process::id()))));
    }

    // 覆盖跨线程/嵌套拒绝，以及错误和 panic 展开后的释放；不操作真实证书库。
    #[test]
    fn certificate_task_lock_rejects_overlap_and_releases_on_error_or_panic() {
        let result: Result<(), String> = with_cert_task_lock(|| {
            assert!(with_cert_task_lock(|| Ok(())).is_err());
            std::thread::spawn(|| {
                assert!(with_cert_task_lock(|| Ok(())).is_err());
            }).join().unwrap();
            Err("certificate task failed".into())
        });
        assert!(result.unwrap_err().starts_with("certificate task failed [操作 ID: cert-"));
        assert_eq!(with_cert_task_lock(|| Ok(42)).unwrap(), 42);
        let result = std::panic::catch_unwind(|| {
            let _ = with_cert_task_lock(|| -> Result<(), String> {
                panic!("certificate task panicked")
            });
        });
        assert!(result.is_err());
        assert!(with_cert_task_lock(|| Ok(())).is_ok());
    }

    #[test]
    fn installed_certificate_requires_successful_system_trust_when_checked() {
        assert!(!store_is_effective(true, false, Some(false)));
        assert!(!store_is_effective(false, true, Some(false)));
        assert!(!store_is_effective(false, false, Some(true)));
        assert!(store_is_effective(true, false, Some(true)));
        assert!(store_is_effective(false, true, Some(true)));
        assert!(store_is_effective(true, false, None));
        assert!(!store_is_effective(false, false, None));
    }

    #[test]
    fn macos_interaction_error_preserves_reason_and_recovery() {
        let raw = "SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible. (1)";
        let message = macos_trust_error(raw, Path::new("/tmp/Any Bridge/ca.pem"));
        assert!(message.contains(raw));
        assert!(message.contains("钥匙串访问"));
        assert!(message.contains("/tmp/Any Bridge/ca.pem"));
        assert!(!message.contains("你取消"));
        assert!(!message.contains("UAC"));
        assert_eq!(macos_trust_error("other failure", Path::new("ca.pem")), "other failure");
    }

    #[test]
    fn san_marker_requires_current_version_and_cert_files() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let cert_path = dir.join("server.codeium.com.pem");
        let key_path = dir.join("server.codeium.com-key.pem");
        let marker_path = san_marker_path(&cert_path).expect("marker path");

        assert_eq!(read_san_version(&cert_path), None);
        assert!(!is_san_current(&cert_path, true, true));

        crate::commands::system::write_mitm_cert_bundle_for_test(&dir)
            .expect("generate test MITM certificate");
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

        std::fs::write(&key_path, "not a private key").expect("corrupt key");
        assert!(!is_san_current(&cert_path, true, true));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // 使用独立缓存验证 TTL 与错误保留，不对真实系统检测耗时作不稳定的性能断言。
    #[test]
    fn ca_status_cache_expires_without_accessing_system_stores() {
        let cache = std::sync::Mutex::new(None);
        assert!(cached_ca_status(&cache).is_none());
        let status = CaStatus {
            common_name: CA_COMMON_NAME.into(),
            cert_file: "certs/server.codeium.com.pem".into(),
            cert_exists: true,
            key_exists: true,
            san_version: Some(crate::commands::system::mitm_cert_san_version().into()),
            san_current: true,
            current_user: true,
            local_machine: false,
            legacy_residual: false,
            thumbprint: Some("test-thumbprint".into()),
            effective_store: CaStore::None,
            message: "system trust failed".into(),
            system_trusted: Some(false),
            trust_error: Some("system trust failed".into()),
            node_trusted: true,
        };
        *cache.lock().unwrap() = Some((std::time::Instant::now(), status.clone()));
        let cached = cached_ca_status(&cache).expect("recent status is cached");
        assert_eq!(cached.cert_file, status.cert_file);
        assert_eq!(cached.system_trusted, Some(false));
        assert_eq!(cached.trust_error, status.trust_error);
        *cache.lock().unwrap() = Some((
            std::time::Instant::now() - std::time::Duration::from_secs(3),
            status,
        ));
        assert!(cached_ca_status(&cache).is_none());
    }

    #[test]
    fn node_ca_bundle_preserves_user_ca() {
        let user = b"-----BEGIN CERTIFICATE-----\nUSERCA\n-----END CERTIFICATE-----\n";
        let ca = b"-----BEGIN CERTIFICATE-----\nANYBRIDGECA\n-----END CERTIFICATE-----\n";
        let merged = node_ca_bundle_content(user, ca);
        let text = String::from_utf8(merged.clone()).expect("bundle is utf8");
        assert!(text.contains("USERCA"), "用户原有 CA 必须保留");
        assert_eq!(text.matches("ANYBRIDGECA").count(), 1, "本地 CA 只追加一次");
        assert_eq!(node_ca_bundle_content(&merged, ca), merged, "重复对齐不得重复追加");
        assert!(node_ca_pem_contains(&merged, ca));
    }

    #[test]
    fn node_ca_trust_judges_by_file_content_not_path() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).expect("temp dir");
        let ca = b"-----BEGIN CERTIFICATE-----\nANYBRIDGECA\n-----END CERTIFICATE-----\n";
        let bundle = dir.join("bundle.pem");
        std::fs::write(&bundle, b"other").expect("write");
        assert!(!node_ca_file_contains(&bundle, ca));
        std::fs::write(&bundle, ca).expect("write");
        assert!(node_ca_file_contains(&bundle, ca));
        assert!(!node_ca_file_contains(&dir.join("missing.pem"), ca));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
