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
pub(super) const CERTUTIL_CMD_TIMEOUT_SECS: u64 = 20;
/// 显式安装/卸载整条任务超时（秒）。UAC 等待算在内。
pub(super) const CERT_TASK_TIMEOUT_SECS: u64 = 120;

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
pub(super) struct CertOperationContext {
    operation_id: String,
    request_id: Option<String>,
}

thread_local! {
    // 进度产生于同步调用链；按工作线程隔离，避免并发任务串用彼此的 ID。
    static CERT_OPERATION_CONTEXT: std::cell::RefCell<Option<CertOperationContext>> = const { std::cell::RefCell::new(None) };
}

pub(super) struct CertOperationContextGuard(Option<CertOperationContext>);

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
pub(super) fn current_cert_operation_context() -> Option<CertOperationContext> {
    CERT_OPERATION_CONTEXT.with(|context| context.borrow().clone())
}

// 深层同步流程统一走此入口，从当前任务上下文补齐关联 ID。
pub(super) fn emit_cert_progress(
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
pub(super) fn emit_cert_progress_for_operation(
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

pub(super) fn cert_paths() -> Result<(PathBuf, PathBuf), String> {
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
pub(super) fn node_ca_bundle_content(existing: &[u8], ca_pem: &[u8]) -> Vec<u8> {
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

pub(super) fn node_ca_pem_contains(haystack: &[u8], ca_pem: &[u8]) -> bool {
    let needle = String::from_utf8_lossy(ca_pem).trim().to_string();
    !needle.is_empty() && String::from_utf8_lossy(haystack).contains(&needle)
}

pub(super) fn node_ca_file_contains(path: &Path, ca_pem: &[u8]) -> bool {
    std::fs::read(path).map_or(false, |bytes| node_ca_pem_contains(&bytes, ca_pem))
}

#[cfg(target_os = "windows")]
pub(super) const NODE_EXTRA_CA_CERTS_KEY: &str = "NODE_EXTRA_CA_CERTS";
#[cfg(target_os = "windows")]
pub(super) const NODE_CA_BUNDLE_FILE: &str = "node-extra-ca-bundle.pem";
#[cfg(target_os = "windows")]
pub(super) const NODE_CA_LEDGER_FILE: &str = "node-extra-ca-original.txt";

#[cfg(target_os = "windows")]
pub(super) fn node_ca_registry(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("reg 执行失败: {e}"))
}

#[cfg(target_os = "windows")]
pub(super) fn read_node_ca_env() -> Result<Option<String>, String> {
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
pub(super) fn write_node_ca_env(value: &str) -> Result<(), String> {
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
pub(super) fn delete_node_ca_env() -> Result<(), String> {
    // 置空而不是 reg delete：同样需要广播，且 Node 会忽略空的 CA 路径。
    // 账本为空即表示原本无此变量，置空等价于恢复原状。
    write_node_ca_env("")
}

/// bundle 与账本放在配置根目录，不进 certs 包，避免干扰证书包完整性校验。
#[cfg(target_os = "windows")]
pub(super) fn node_ca_ledger_paths() -> (PathBuf, PathBuf) {
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

pub(super) fn san_marker_path(cert_path: &Path) -> Result<PathBuf, String> {
    let certs_dir = cert_path
        .parent()
        .ok_or_else(|| format!("证书路径缺少父目录: {}", cert_path.to_string_lossy()))?;
    Ok(certs_dir.join("san-version"))
}

pub(super) fn read_san_version(cert_path: &Path) -> Option<String> {
    let marker = san_marker_path(cert_path).ok()?;
    let value = std::fs::read_to_string(marker).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn is_san_current(cert_path: &Path, cert_exists: bool, key_exists: bool) -> bool {
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

pub(super) fn admin_prompt_label() -> &'static str {
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
pub(super) fn manual_install_hint(cert_path: &Path) -> String {
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
pub(super) fn compute_thumbprint(pem_path: &Path) -> Result<String, String> {
    let pem = std::fs::read(pem_path)
        .map_err(|e| format!("读取证书文件失败 {}: {}", pem_path.to_string_lossy(), e))?;
    let der = extract_first_cert_der(&pem)?;
    let digest = sha1::Sha1::digest(&der);
    Ok(hex::encode(digest))
}

/// 从 PEM 字节中提取第一段 CERTIFICATE 块的 DER。
pub(super) fn extract_first_cert_der(pem: &[u8]) -> Result<Vec<u8>, String> {
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
pub(super) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
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


#[cfg(target_os = "windows")]
#[path = "platform_win.rs"]
mod platform;

mod platform_unix;
#[cfg(not(target_os = "windows"))]
use platform_unix as platform;

mod commands;
mod status_and_install;
pub use commands::*;
pub use status_and_install::*;

#[cfg(test)]
mod tests;
