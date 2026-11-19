use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use super::*;

pub(super) fn settings_backup_path(settings: &Path) -> PathBuf {
    let mut p = settings.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".into());
    p.set_file_name(format!("{}.byok-bak", name));
    p
}

pub(super) fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub(super) fn can_connect_local(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok()
}

pub(super) fn wait_for_ports(ports: &[u16], timeout: Duration) -> Vec<u16> {
    let deadline = Instant::now() + timeout;
    let mut missing = ports.to_vec();
    while Instant::now() < deadline && !missing.is_empty() {
        missing.retain(|p| !can_connect_local(*p));
        if !missing.is_empty() {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    missing
}

pub(super) fn configured_ports() -> crate::commands::config::ConfiguredProxyPorts {
    crate::commands::config::configured_proxy_ports()
}

pub(super) fn active_or_configured_ports(state: &ProxyState) -> crate::commands::config::ConfiguredProxyPorts {
    let ports = *lock_or_recover(&state.ports);
    ports.unwrap_or_else(|| configured_ports())
}

pub(super) fn unique_proxy_ports(ports: crate::commands::config::ConfiguredProxyPorts) -> Vec<u16> {
    if ports.api_port == ports.inference_port {
        vec![ports.api_port]
    } else {
        vec![ports.api_port, ports.inference_port]
    }
}

pub(super) fn port_pair_text(ports: crate::commands::config::ConfiguredProxyPorts) -> String {
    format!("{} / {}", ports.api_port, ports.inference_port)
}

#[derive(Debug)]
pub(super) struct ProxyHealthFailure {
    pub(super) message: String,
    pub(super) mitm_related: bool,
}

pub(super) fn probe_byok_stats(port: u16, timeout: Duration) -> Result<(), ProxyHealthFailure> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| ProxyHealthFailure {
            message: format!("无法连接 {}: {}", port, e),
            mitm_related: false,
        })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(b"GET /__byok/stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| ProxyHealthFailure {
            message: format!("发送健康检查失败: {}", e),
            mitm_related: false,
        })?;
    let mut buf = String::new();
    stream
        .read_to_string(&mut buf)
        .map_err(|e| ProxyHealthFailure {
            message: format!("读取健康检查响应失败: {}", e),
            mitm_related: false,
        })?;
    if !buf.starts_with("HTTP/1.1 200") && !buf.starts_with("HTTP/1.0 200") {
        return Err(ProxyHealthFailure {
            message: format!("{} 有响应，但不是 BYOK 健康检查 200", port),
            mitm_related: false,
        });
    }
    if !buf.contains("\"requests\"") || !buf.contains("\"uptimeSec\"") {
        return Err(ProxyHealthFailure {
            message: format!(
                "{} 有响应，但不像 AnyBridge 网关；可能被其它程序占用",
                port
            ),
            mitm_related: false,
        });
    }
    if !buf.contains("\"mitmEnabled\":true") {
        let detail = buf
            .split_once("\r\n\r\n")
            .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok())
            .and_then(|json| json.get("mitmError").and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or_else(|| "sidecar 未报告 MITM enabled".to_string());
        return Err(ProxyHealthFailure {
            message: format!("{} 端口已监听，但 MITM 未启用: {}", port, detail),
            mitm_related: true,
        });
    }
    Ok(())
}

pub(super) fn probe_mitm_tls(
    port: u16,
    cert_path: &std::path::Path,
    timeout: Duration,
) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::sync::Arc;

    // 不用 reqwest 走代理：reqwest 对「HTTPS 经 HTTP 代理」的连接不会正确应用
    // add_root_certificate 的自定义根证书（实测直连可验证、经代理报 UnknownIssuer）。
    // 这里手动建立 CONNECT 隧道 + rustls TLS 握手，直接用磁盘上的 CA 校验叶子证书，
    // 既严格验证证书链，又真实覆盖 CONNECT→MITM→mitm-health 全链路。
    let pem = std::fs::read_to_string(cert_path)
        .map_err(|e| format!("读取 MITM 证书用于 TLS 探针失败: {}", e))?;
    let der = pem_cert_der(&pem)
        .ok_or_else(|| "TLS 探针未在 PEM 中找到证书块".to_string())?;
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(der))
        .map_err(|e| format!("TLS 探针加载 MITM 根证书失败: {}", e))?;
    // 确保进程已安装 ring provider（reqwest 可能尚未初始化）。重复安装返回 Err，忽略即可。
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();

    // ---------------------------------
    // 1. 连接网关并发送 CONNECT，建立到 MITM 主机的隧道
    // ---------------------------------
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    // 网络各阶段共享同一预算；文件读取和本地证书计算不属于可中断网络 I/O。
    let deadline = Instant::now().checked_add(timeout)
        .ok_or_else(|| "TLS 探针超时参数过大".to_string())?;
    let socket = TcpStream::connect_timeout(&addr, probe_time_remaining(deadline).map_err(|e| e.to_string())?)
        .map_err(|e| format!("CONNECT/TLS 探针连接网关失败: {}", e))?;
    let mut tcp = ProbeSocket { socket, deadline };
    tcp.write_all(
        b"CONNECT server.codeium.com:443 HTTP/1.1\r\nHost: server.codeium.com:443\r\n\r\n",
    )
    .map_err(|e| format!("CONNECT/TLS 握手失败: 发送 CONNECT 失败: {}", e))?;
    read_connect_response(&mut tcp)?;

    // ---------------------------------
    // 2.在隧道上做 rustls TLS 握手（严格校验：叶子证书必须由磁盘 CA 签发）
    // ---------------------------------
    let server_name = "server.codeium.com"
        .try_into()
        .map_err(|_| "CONNECT/TLS 握手失败: 服务器名无效".to_string())?;
    let mut conn = rustls::ClientConnection::new(Arc::new(config), server_name)
        .map_err(|e| format!("CONNECT/TLS 握手失败: {}", e))?;

    // 完成严格握手后核对实际叶子；同一个 CA 签发的旧叶子也不能冒充当前磁盘包。
    while conn.is_handshaking() {
        conn.complete_io(&mut tcp)
            .map_err(|e| format!("CONNECT/TLS 握手失败: {}", e))?;
    }
    let peer = conn.peer_certificates().and_then(|chain| chain.first())
        .ok_or_else(|| "TLS 探针未获得运行态叶子证书".to_string())?;
    let leaf_path = cert_path.with_file_name(crate::commands::system::MITM_LEAF_CERT_FILE);
    let leaf_pem = std::fs::read_to_string(&leaf_path)
        .map_err(|e| format!("读取磁盘叶子证书失败: {}", e))?;
    let disk_leaf = pem_cert_der(&leaf_pem)
        .ok_or_else(|| "磁盘叶子证书 PEM 无效".to_string())?;
    verify_runtime_leaf(peer.as_ref(), &disk_leaf)?;
    let mut tls = rustls::Stream::new(&mut conn, &mut tcp);

    // ---------------------------------
    // 3. 发送 mitm-health 请求并读取响应
    // ---------------------------------
    tls.write_all(
        b"GET /__byok/mitm-health HTTP/1.1\r\nHost: server.codeium.com\r\nConnection: close\r\n\r\n",
    )
    .map_err(|e| format!("CONNECT/TLS 握手失败: {}", e))?;
    let mut response = String::new();
    // 健康响应应很小；额外读一个字节区分达到上限和超限，禁止无界分配。
    tls.take(65537).read_to_string(&mut response)
        .map_err(|e| format!("CONNECT/TLS 握手失败: {}", e))?;
    if response.len() > 65536 {
        return Err("MITM TLS 探针响应超过 64 KiB".into());
    }
    probe_time_remaining(deadline).map_err(|e| e.to_string())?;

    // ---------------------------------
    // 4. 校验响应：200 + ok:true + source:mitm + upstream:server.codeium.com
    // ---------------------------------
    let status_ok = response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200");
    let body = response.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    let json = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|e| format!("MITM TLS 探针响应不是 JSON ({}): {}", e, body))?;
    if !status_ok
        || json.get("ok") != Some(&serde_json::Value::Bool(true))
        || json.get("source").and_then(|v| v.as_str()) != Some("mitm")
        || json.get("upstream").and_then(|v| v.as_str()) != Some("server.codeium.com")
    {
        return Err(format!("TLS 已连接但未进入 MITM: body={}", body));
    }
    Ok(())
}

// 每次实际 socket I/O 都更新剩余预算，覆盖 rustls complete_io 内部的多次读写。
// 不使用后台计时线程；超时错误沿原探针失败路径传播，socket 随栈退出关闭。
pub(super) struct ProbeSocket {
    pub(super) socket: TcpStream,
    pub(super) deadline: Instant,
}

pub(super) fn probe_time_remaining(deadline: Instant) -> std::io::Result<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "TLS 探针网络总预算已耗尽"))
}

impl Read for ProbeSocket {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.socket.set_read_timeout(Some(probe_time_remaining(self.deadline)?))?;
        self.socket.read(buf)
    }
}

impl Write for ProbeSocket {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.socket.set_write_timeout(Some(probe_time_remaining(self.deadline)?))?;
        self.socket.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.socket.set_write_timeout(Some(probe_time_remaining(self.deadline)?))?;
        self.socket.flush()
    }
}

// CONNECT 头可能跨多个 TCP 包；逐字节读取到空行，不吞掉属于后续 TLS 的字节。
// 8 KiB 限制约束内存和读取次数；网络读取仍使用调用方的 socket 超时。
pub(super) fn read_connect_response(reader: &mut impl Read) -> Result<(), String> {
    let mut head = Vec::new();
    while head.len() < 8192 {
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte)
            .map_err(|e| format!("读取 CONNECT 响应头失败: {}", e))?;
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            let text = std::str::from_utf8(&head)
                .map_err(|_| "CONNECT 响应头编码无效".to_string())?;
            let mut status = text.lines().next().unwrap_or("").split_whitespace();
            if matches!(status.next(), Some("HTTP/1.1") | Some("HTTP/1.0"))
                && status.next() == Some("200") {
                return Ok(());
            }
            // 不回显远端响应头，避免网关认证等敏感字段进入日志。
            return Err("CONNECT 隧道未返回 HTTP 200".into());
        }
    }
    Err("CONNECT 响应头超过 8 KiB 或缺少结束空行".into())
}

// 只记录公开证书指纹，不记录 PEM 或私钥；一致性检查不能替代上面的严格 TLS 链验证。
pub(super) fn verify_runtime_leaf(runtime: &[u8], disk: &[u8]) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let runtime_hash = hex::encode(Sha256::digest(runtime));
    let disk_hash = hex::encode(Sha256::digest(disk));
    if runtime_hash != disk_hash {
        return Err(format!("运行态/磁盘叶子证书指纹不一致，TLS 探针未通过: runtime={} disk={}", runtime_hash, disk_hash));
    }
    Ok(())
}

/// 从 PEM 文本提取第一个证书块并 base64 解码为 DER。
pub(super) fn pem_cert_der(pem: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let start = pem.find(BEGIN)?;
    let after = &pem[start + BEGIN.len()..];
    let end = after.find(END)?;
    let b64: String = after[..end].chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

pub(super) fn mitm_tls_failure(message: String) -> ProxyHealthFailure {
    ProxyHealthFailure {
        message,
        mitm_related: true,
    }
}

pub(super) struct MitmReadyReport {
    pub(super) message: String,
}

/// 网关启动路径只读验证现有包和系统信任；证书生成/轮换必须由显式操作发起。
/// 管理员安装只允许用户在「环境检测」显式点击；后台启动不能依赖交互授权。
pub(super) fn ensure_proxy_mitm_ready_once() -> Result<String, String> {
    // 先确认磁盘包完整，再按其 CA 指纹检查系统信任，避免校验另一份证书材料。
    let certs_dir = crate::commands::system::validate_existing_mitm_package()?;
    // 网关启动属于后台路径：只检查当前 CA 是否已经可信，不自动弹出 macOS
    // 管理员授权。信任变更必须由环境检测中的显式用户操作完成。
    let status = crate::commands::cert_install::check_ca_status_fresh();
    if matches!(status.effective_store, crate::commands::cert_install::CaStore::None) {
        let reason = status
            .trust_error
            .as_deref()
            .unwrap_or("当前证书指纹未通过系统信任检查");
        return Err(format!(
            "MITM CA 尚未完成系统信任验证: {}。请到「环境检测」手动安装证书并完成授权",
            reason
        ));
    }
    // 存量用户升级后 CA 已装好但 Node 信任变量缺失：网关启动时幂等补齐。
    // 写用户级环境变量不需要交互授权，失败必须暴露，不能让 IDE 静默回落官方模型。
    #[cfg(target_os = "windows")]
    crate::commands::cert_install::ensure_node_ca_trust()?;

    Ok(format!(
        "证书目录={}；Thumbprint={}；信任库={}",
        certs_dir.to_string_lossy(),
        status.thumbprint.as_deref().unwrap_or("unknown"),
        crate::commands::cert_install::store_label(status.effective_store)
    ))
}

pub(super) fn ensure_proxy_mitm_ready() -> Result<MitmReadyReport, String> {
    ensure_proxy_mitm_ready_once()
        .map(|message| MitmReadyReport { message })
        .map_err(|error| format!(
            "{}。后台启动未修改证书包或系统信任；如需生成、轮换或授权，请到「环境检测」显式操作",
            error
        ))
}

pub(super) fn check_provider_route(
    issues: &mut Vec<ProxyPreflightIssue>,
    label: &str,
    provider_id: &str,
    model_override: Option<&str>,
    store: &crate::commands::config::ProviderStore,
) -> bool {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        push_issue(
            issues,
            "err",
            "route.provider_empty",
            format!("「{}」未选择目标供应商", label),
        );
        return false;
    }

    let Some(provider) = store.providers.iter().find(|p| p.id == provider_id) else {
        push_issue(
            issues,
            "err",
            "route.provider_missing",
            format!("「{}」引用了不存在的供应商: {}", label, provider_id),
        );
        return false;
    };

    let mut ok = true;
    if provider.enabled == false {
        push_issue(
            issues,
            "err",
            "route.provider_disabled",
            format!("「{}」引用的供应商「{}」已禁用", label, provider.name),
        );
        ok = false;
    }
    if provider.api_host.trim().is_empty() {
        push_issue(
            issues,
            "err",
            "route.provider_host_empty",
            format!("供应商「{}」未填写 API Host", provider.name),
        );
        ok = false;
    }
    if provider.api_key.trim().is_empty() {
        push_issue(
            issues,
            "err",
            "route.provider_key_empty",
            format!("供应商「{}」未填写 API Key", provider.name),
        );
        ok = false;
    }

    let override_model = model_override.unwrap_or("").trim();
    let effective_model = if override_model.is_empty() {
        provider.default_model.trim()
    } else {
        override_model
    };
    if effective_model.is_empty() {
        push_issue(
            issues,
            "err",
            "route.model_empty",
            format!(
                "「{}」未填写目标模型，请在模型列表里选择明确的上游模型",
                label
            ),
        );
        ok = false;
    }
    ok
}

pub(super) fn load_cached_ide_model_uids(
    config_dir: &Path,
) -> Result<Option<(HashSet<String>, String, Option<u64>)>, String> {
    let path = config_dir.join("ide-models.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 ide-models.json 失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析 ide-models.json 失败: {}", e))?;
    let source = json
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("captured")
        .to_string();
    let captured_at = json.get("capturedAt").and_then(|v| v.as_u64());
    let mut uids = HashSet::new();
    if let Some(models) = json.get("models").and_then(|v| v.as_array()) {
        for item in models {
            if let Some(uid) = item.get("modelUid").and_then(|v| v.as_str()) {
                if !uid.trim().is_empty() {
                    uids.insert(uid.to_string());
                }
            }
        }
    }
    Ok(Some((uids, source, captured_at)))
}

pub(super) fn resolve_resources_root(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let dir = resource_dir?;
    if dir.join("byok-cards.js").exists() || dir.join("sidecar").exists() {
        return Some(dir.to_path_buf());
    }
    let nested = dir.join("resources");
    if nested.join("byok-cards.js").exists() || nested.join("sidecar").exists() {
        return Some(nested);
    }
    Some(dir.to_path_buf())
}

/// Locate the bundled plugin definitions directory (plugin.json + adapter.js + deploy.md).
/// dev: <crate>/resources/plugins — release: <resource_root>/plugins
pub(super) fn resolve_plugins_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("plugins");
        if dev_dir.exists() {
            return Some(dev_dir);
        }
    }
    let root = resolve_resources_root(resource_dir)?;
    let packaged = root.join("plugins");
    if packaged.exists() {
        return Some(packaged);
    }
    None
}

/// 接管心跳状态文件（sidecar 写、Rust 只读）。
///
/// 「IDE 接管是否真的生效」的唯一可靠判据 = 网关最近有没有收到目标 IDE 的模型请求。
/// 配置是否已写入（patched）**不代表生效**：IDE 只在启动时读取网关配置，
/// 写入后不重启就一直走直连，模型下拉框永远不会被改写。
pub(super) const TAKEOVER_STATE_FILE: &str = "anybridge-takeover-state.json";

/// 心跳新鲜窗口：IDE 打开后会持续发 GetUserStatus 心跳（秒级），
/// 超过这个时间没收到请求即可判定「流量没进网关」。
pub(super) const TAKEOVER_FRESH_WINDOW_MS: u64 = 10 * 60 * 1000;

/// 网关刚启动的观察窗口：此时还没收到请求属正常，避免刚启动就误报。
pub(super) const TAKEOVER_WARMUP_MS: u64 = 90 * 1000;

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverState {
    #[serde(default)]
    pub proxy_started_at: Option<u64>,
    #[serde(default)]
    pub last_ide_request_at: Option<u64>,
    #[serde(default)]
    pub last_capture_at: Option<u64>,
    #[serde(default)]
    pub capture_source: Option<String>,
    #[serde(default)]
    pub capture_host: Option<String>,
}

pub(crate) fn read_takeover_state(config_dir: &Path) -> Result<Option<TakeoverState>, String> {
    let path = config_dir.join(TAKEOVER_STATE_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取接管状态失败: {}", e))?;
    let parsed = serde_json::from_str::<TakeoverState>(&raw)
        .map_err(|e| format!("解析 {} 失败: {}", TAKEOVER_STATE_FILE, e))?;
    Ok(Some(parsed))
}

#[tauri::command]
pub fn get_takeover_state() -> Result<Option<TakeoverState>, String> {
    read_takeover_state(&crate::commands::config::config_dir_path())
}
