#[cfg(unix)]
use std::fs::File;
use tauri::AppHandle;
use super::{restrict_cert_dir_permissions, write_atomic};

/// CA 证书 CommonName。当前版本统一使用 "AnyBridge Local CA"，
/// 跟 package.json 的 name 字段对齐，便于在 certmgr 中一眼辨识。
/// 升级路径：旧版用 "Windsurf BYOK Local MITM" / "IDE BYOK Local MITM" / "ide-byok Local CA"，
/// 老证书清理逻辑见 `commands::cert_install::cleanup_legacy_cn`。
pub const CA_COMMON_NAME: &str = "AnyBridge Local CA";

/// 老版本 CA 证书 CommonName（升级时需要清理掉）。
/// 包含历史品牌重命名过程中出现过的全部 CN，避免别人电脑上残留导致 certutil / Electron 信任异常。
pub const LEGACY_CA_COMMON_NAMES: &[&str] = &[
    "Windsurf BYOK Local MITM",
    "IDE BYOK Local MITM",
    "ide-byok Local CA",
    "AnyBridge Local MITM",
];

/// 证书结构版本号。改动证书结构时必须 +1，否则存量机器上那张旧证书不会被重生（改了代码也不生效）。
/// v2 → v3：修掉有效期。此前用 rcgen 默认（1975-01-01 ~ 4096-01-01，2121 年），
/// 违反 Apple / Chromium「TLS 服务器证书有效期 ≤ 825 天」策略，新版客户端直接回
/// TLS alert 42 (bad certificate)，MITM 断开、模型改写不生效。
pub(super) const MITM_CERT_SAN_VERSION: &str = "3";
/// 证书有效期（相对当前时间的天数）。
/// not_before 往前 1 天，容忍客户端与本机之间的时钟偏差；
/// not_after 365 天，远低于 Apple / Chromium 要求的 825 天上限。
pub(super) const MITM_CERT_NOT_BEFORE_DAYS: i64 = -1;
pub(super) const MITM_CERT_NOT_AFTER_DAYS: i64 = 365;
/// 证书文件超过这个天数就换新。必须明显小于 NOT_AFTER_DAYS，确保在过期前换掉。
pub(super) const MITM_CERT_MAX_AGE_DAYS: u64 = 300;

/// rcgen 0.13 的 not_before / not_after 是 time::OffsetDateTime，
/// 默认值是 1975-01-01 ~ 4096-01-01（2121 年）—— 现代客户端按「有效期超限」
/// 直接判定证书不合规（TLS alert 42 bad certificate），必须显式设置。
/// 证书是否需要换新：文件生成时间已超过换证阈值。
/// 证书现在有 365 天有效期，过期后客户端会重新按策略拒绝（跟这次修的问题同一类），
/// 所以用「文件生成时间」做免解析的到期判断：只要用户每 365 天启动过一次就不会拿到过期证书，
/// 久未启动则下次启动自动换新。
pub(crate) fn mitm_certs_need_renewal(certs_dir: &std::path::Path) -> bool {
    let leaf = certs_dir.join(MITM_LEAF_CERT_FILE);
    let modified = match leaf.metadata().and_then(|m| m.modified()) {
        Ok(t) => t,
        // 读不到时间说明文件缺失/异常，交给后面的完整性校验去重生
        Err(_) => return false,
    };
    modified
        .elapsed()
        .map(|d| d.as_secs() >= MITM_CERT_MAX_AGE_DAYS * 24 * 3600)
        // 系统时间早于文件时间（时钟异常）时不据此换新
        .unwrap_or(false)
}

pub(super) fn mitm_cert_validity() -> Result<(time::OffsetDateTime, time::OffsetDateTime), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("系统时间异常，无法生成证书: {}", e))?
        .as_secs() as i64;
    let stamp = |days: i64| {
        time::OffsetDateTime::from_unix_timestamp(now + days * 24 * 3600)
            .map_err(|e| format!("证书有效期计算失败: {}", e))
    };
    Ok((stamp(MITM_CERT_NOT_BEFORE_DAYS)?, stamp(MITM_CERT_NOT_AFTER_DAYS)?))
}

pub(super) const MITM_DNS_NAMES: &[&str] = &[
    "server.self-serve.windsurf.com",
    "server.codeium.com",
    "api2.cursor.sh",
    "authentication.cursor.sh",
    "prod.authentication.cursor.sh",
    "localhost",
];

pub(crate) fn mitm_cert_san_version() -> &'static str {
    MITM_CERT_SAN_VERSION
}

pub(crate) fn mitm_dns_names() -> &'static [&'static str] {
    MITM_DNS_NAMES
}

pub(crate) fn validate_mitm_cert_files(
    cert_path: &std::path::Path,
    key_path: &std::path::Path,
) -> Result<(), String> {
    let cert_pem = std::fs::read(cert_path)
        .map_err(|e| format!("读取 MITM 证书失败 {}: {}", cert_path.to_string_lossy(), e))?;
    let key_pem = std::fs::read(key_path)
        .map_err(|e| format!("读取 MITM 私钥失败 {}: {}", key_path.to_string_lossy(), e))?;
    validate_mitm_key_pair(&cert_pem, &key_pem)?;
    let mut identity_pem = cert_pem;
    identity_pem.extend_from_slice(b"\n");
    identity_pem.extend_from_slice(&key_pem);
    reqwest::Identity::from_pem(&identity_pem)
        .map_err(|e| format!("MITM 证书/私钥解析或匹配失败: {}", e))?;
    Ok(())
}

// Identity 解析不作为密钥匹配的保证；显式比较首张证书与私钥的公钥，无法确认也拒绝。
// 这里不校验签名链、证书角色、SAN 或系统信任；使用局部 provider，不改变全局 TLS 配置。
pub(super) fn validate_mitm_key_pair(cert_pem: &[u8], key_pem: &[u8]) -> Result<(), String> {
    use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
    let certificates = CertificateDer::pem_slice_iter(cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("MITM 证书解析失败: {}", e))?;
    let key = PrivateKeyDer::from_pem_slice(key_pem)
        .map_err(|e| format!("MITM 私钥解析失败: {}", e))?;
    let provider = rustls::crypto::ring::default_provider();
    let certified = rustls::sign::CertifiedKey::from_der(certificates, key, &provider)
        .map_err(|e| format!("MITM 证书/私钥校验失败: {}", e))?;
    certified.keys_match().map_err(|e| format!("MITM 证书/私钥不匹配或无法确认: {}", e))
}

/// MITM 叶子证书文件名（hybrid-server 实际向客户端呈现的证书 + CA 链）。
/// 信任根仍是 `server.codeium.com.pem`（装入系统证书库、probe 以此为 root）。
pub(crate) const MITM_LEAF_CERT_FILE: &str = "mitm-leaf.pem";
pub(crate) const MITM_LEAF_KEY_FILE: &str = "mitm-leaf-key.pem";

pub(super) fn mitm_san_entries() -> Result<Vec<rcgen::SanType>, String> {
    mitm_dns_names()
        .iter()
        .map(|name| {
            Ok(rcgen::SanType::DnsName(
                (*name)
                    .try_into()
                    .map_err(|_| format!("bad san: {}", name))?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()
}

pub(super) fn write_mitm_cert_bundle(certs_dir: &std::path::Path) -> Result<(), String> {
    use rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
        IsCa, KeyUsagePurpose,
    };

    let ca_cert_path = certs_dir.join("server.codeium.com.pem");
    let ca_key_path = certs_dir.join("server.codeium.com-key.pem");
    let leaf_cert_path = certs_dir.join(MITM_LEAF_CERT_FILE);
    let leaf_key_path = certs_dir.join(MITM_LEAF_KEY_FILE);
    let san_marker_path = certs_dir.join("san-version");

    let san_names: Vec<String> = mitm_dns_names().iter().map(|n| (*n).to_string()).collect();
    let san_entries = mitm_san_entries()?;
    let (not_before, not_after) = mitm_cert_validity()?;

    // ── CA 信任根：装入系统证书库，客户端（含 rustls probe）以此为 root。
    // 标记 IsCa + keyCertSign；保留 SAN 以兼容既有 san-version 校验逻辑。
    let mut ca_params = CertificateParams::new(san_names.clone()).map_err(|e| e.to_string())?;
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(DnType::CommonName, CA_COMMON_NAME);
    ca_params.distinguished_name = ca_dn;
    ca_params.not_before = not_before;
    ca_params.not_after = not_after;
    // 带上 SKI/AKI：严格校验（含 openssl -x509_strict）要求链条可定位签发者
    ca_params.use_authority_key_identifier_extension = true;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];
    ca_params.subject_alt_names = san_entries.clone();
    let ca_key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let ca_cert = ca_params.self_signed(&ca_key).map_err(|e| e.to_string())?;

    // ── 叶子证书：hybrid-server 实际呈现；由 CA 签发、非 CA、带 ServerAuth EKU。
    // 严格 TLS 客户端（rustls/webpki）拒绝「CA 证书当作服务器证书」(CaUsedAsEndEntity)，
    // 因此必须由 CA 签发一张独立的 end-entity 叶子证书。
    let mut leaf_params = CertificateParams::new(san_names).map_err(|e| e.to_string())?;
    let mut leaf_dn = DistinguishedName::new();
    leaf_dn.push(DnType::CommonName, "AnyBridge MITM Leaf");
    leaf_params.distinguished_name = leaf_dn;
    leaf_params.not_before = not_before;
    leaf_params.not_after = not_after;
    leaf_params.use_authority_key_identifier_extension = true;
    leaf_params.is_ca = IsCa::NoCa;
    leaf_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf_params.subject_alt_names = san_entries;
    let leaf_key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|e| e.to_string())?;

    // 叶子 + CA 链一并写出，hybrid-server 呈现完整链（leaf 在前）。
    let mut leaf_chain_pem = leaf_cert.pem();
    leaf_chain_pem.push_str(&ca_cert.pem());

    write_atomic(&ca_cert_path, ca_cert.pem())?;
    write_atomic(&ca_key_path, ca_key.serialize_pem())?;
    write_atomic(&leaf_cert_path, leaf_chain_pem)?;
    write_atomic(&leaf_key_path, leaf_key.serialize_pem())?;
    write_atomic(
        &san_marker_path,
        format!("{version}\n", version = MITM_CERT_SAN_VERSION),
    )?;
    validate_mitm_cert_files(&ca_cert_path, &ca_key_path)?;
    validate_mitm_cert_files(&leaf_cert_path, &leaf_key_path)
}

#[cfg(test)]
pub(crate) fn write_mitm_cert_bundle_for_test(certs_dir: &std::path::Path) -> Result<(), String> {
    write_mitm_cert_bundle(certs_dir)
}


/// 确保 MITM 证书文件存在且 SAN 版本当前。
/// 强制生成由 ensure_mitm_certs_ex(true) 提供，不预先删除旧文件。
/// 返回 (certs_dir, newly_generated)。
pub fn ensure_mitm_certs() -> Result<(std::path::PathBuf, bool), String> {
    ensure_mitm_certs_ex(false)
}

/// 在当前应用配置的 certs 目录准备 CA、私钥、叶子证书链及 SAN 版本标记，不安装系统信任。
/// `force=false` 时复用通过完整性、版本及文件年龄检查的证书包，否则重新生成；
/// `force=true` 时跳过复用，但不预删旧文件，避免生成阶段失败就丢失原包。
/// 返回 `(证书目录, 是否新生成)`；逐文件写入失败会尝试以内存快照恢复，不能覆盖进程崩溃。
/// 本入口不获取证书任务锁或网关启动占位，调用方须保证桌面进程内互斥且网关已停止。
/// Unix 上另以配置目录锁文件串行化独立进程的证书包校验和提交。
/// 委托目录级实现并传入实际生成函数，使测试可使用隔离目录和故障注入。
pub fn ensure_mitm_certs_ex(force: bool) -> Result<(std::path::PathBuf, bool), String> {
    let certs_dir = crate::commands::config::config_dir_path().join("certs");
    let _package_lock = acquire_mitm_package_lock(&certs_dir, true)?;
    ensure_mitm_certs_ex_unlocked(force)
}

// 调用方须持有包独占锁；供需要把证书提交与后续信任操作纳入同一临界区的流程复用。
pub(crate) fn ensure_mitm_certs_ex_unlocked(
    force: bool,
) -> Result<(std::path::PathBuf, bool), String> {
    ensure_mitm_certs_in_dir(
        crate::commands::config::config_dir_path().join("certs"),
        force,
        write_mitm_cert_bundle,
    )
}

/// 只读校验网关启动所需的现有证书包；后台路径不能隐式生成、轮换或续期证书。
pub(crate) fn validate_existing_mitm_package() -> Result<std::path::PathBuf, String> {
    let certs_dir = crate::commands::config::config_dir_path().join("certs");
    let _package_lock = acquire_mitm_package_lock(&certs_dir, false)?;
    validate_existing_mitm_package_in_dir(certs_dir)
}

// 信任安装/卸载与证书写入共享独占锁，避免两个桌面实例交错修改包和信任状态。
pub(crate) fn acquire_mitm_package_write_lock(
) -> Result<Option<MitmPackageLock>, String> {
    acquire_mitm_package_lock(
        &crate::commands::config::config_dir_path().join("certs"),
        true,
    )
}

// 文件描述符持有期间锁保持有效；Drop 解锁，进程异常退出时由内核释放。
#[cfg(unix)]
pub(crate) struct MitmPackageLock(File);

#[cfg(not(unix))]
pub(crate) struct MitmPackageLock;

#[cfg(unix)]
impl Drop for MitmPackageLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); }
    }
}

// 锁文件留在配置目录，不能 unlink：已打开旧 inode 的进程与新建路径会形成两把锁。
#[cfg(unix)]
pub(crate) fn acquire_mitm_package_lock(
    certs_dir: &std::path::Path,
    exclusive: bool,
) -> Result<Option<MitmPackageLock>, String> {
    use std::os::fd::AsRawFd;
    // PermissionsExt 为锁文件收紧到仅当前用户可读写提供 set_mode。
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let lock_root = certs_dir.parent().unwrap_or(certs_dir);
    if exclusive {
        std::fs::create_dir_all(lock_root)
            .map_err(|error| format!("无法创建证书锁目录: {}", error))?;
    }
    let lock_path = lock_root.join(".mitm-cert-package.lock");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&lock_path)
        .map_err(|error| format!("打开证书包互斥锁失败: {}", error))?;
    let metadata = file.metadata()
        .map_err(|error| format!("检查证书包互斥锁失败: {}", error))?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err("证书包互斥路径必须是单链接普通文件".into());
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o600);
    file.set_permissions(permissions)
        .map_err(|error| format!("收紧证书包互斥锁权限失败: {}", error))?;
    let operation = (if exclusive { libc::LOCK_EX } else { libc::LOCK_SH }) | libc::LOCK_NB;
    if unsafe { libc::flock(file.as_raw_fd(), operation) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Err("另一个进程正在校验或修改 MITM 证书包，请稍后重试".into());
        }
        return Err(format!("获取证书包互斥锁失败: {}", error));
    }
    Ok(Some(MitmPackageLock(file)))
}

#[cfg(not(unix))]
pub(crate) fn acquire_mitm_package_lock(
    _certs_dir: &std::path::Path,
    _exclusive: bool,
) -> Result<Option<MitmPackageLock>, String> {
    Ok(None)
}

// 独立目录参数便于在临时目录测试；此函数只读取和校验，不创建目录或修复文件。
pub(super) fn validate_existing_mitm_package_in_dir(
    certs_dir: std::path::PathBuf,
) -> Result<std::path::PathBuf, String> {
    reject_interrupted_mitm_candidates(&certs_dir)?;
    let ca_cert = certs_dir.join("server.codeium.com.pem");
    let ca_key = certs_dir.join("server.codeium.com-key.pem");
    let leaf_cert = certs_dir.join(MITM_LEAF_CERT_FILE);
    let leaf_key = certs_dir.join(MITM_LEAF_KEY_FILE);
    let san_marker = certs_dir.join("san-version");

    // 先分别校验 CA/叶子公私钥，再校验版本、签名链和有效期，整个过程不修改证书包。
    validate_mitm_cert_files(&ca_cert, &ca_key)
        .map_err(|error| format!("现有 MITM CA 无效: {}", error))?;
    validate_mitm_cert_files(&leaf_cert, &leaf_key)
        .map_err(|error| format!("现有 MITM 叶子证书无效: {}", error))?;
    let marker = std::fs::read_to_string(&san_marker)
        .map_err(|error| format!("读取现有证书 SAN 版本失败: {}", error))?;
    if marker.trim() != MITM_CERT_SAN_VERSION {
        return Err(format!(
            "现有证书 SAN 版本过期（当前要求 {}），请在环境检测中显式生成/重装证书",
            MITM_CERT_SAN_VERSION
        ));
    }
    validate_mitm_candidate_chain(&certs_dir)
        .map_err(|error| format!("现有 MITM 证书链无效: {}", error))?;
    if mitm_certs_need_renewal(&certs_dir) {
        return Err("现有 MITM 证书已到续期窗口，请在环境检测中显式生成/重装证书".into());
    }
    Ok(certs_dir)
}

// 只读检测候选目录，阻止网关复用或信任安装使用可能正在生成/提交的证书包。
// 残留也可能属于其他进程；不自动删除候选目录或恢复文件，避免破坏并发操作。
pub(crate) fn reject_interrupted_mitm_candidates(certs_dir: &std::path::Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(certs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取证书目录失败，拒绝使用现有证书包: {}", error)),
    };

    for entry in entries {
        let entry = entry.map_err(|error| format!("检查证书目录失败，拒绝使用现有证书包: {}", error))?;
        if entry.file_name().to_string_lossy().starts_with(".candidate-") {
            return Err(format!(
                "发现候选证书目录 {}，可能有证书生成/提交仍在进行或曾中断；网关未启动。等待相关操作结束后重试；若目录持续存在，请人工核查，程序不会自动删除",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

// 仅离线验证候选链，不安装或读取系统信任；根来自候选 CA 而非链中任意证书。
// WebPKI 校验叶子有效期、服务端用途和签名链；信任锚本身的有效期/自签名需另行检查。
pub(crate) fn validate_mitm_candidate_chain(dir: &std::path::Path) -> Result<(), String> {
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{pem::PemObject, CertificateDer, ServerName, UnixTime};
    let read_chain = |name: &str| -> Result<Vec<CertificateDer<'static>>, String> {
        let pem = std::fs::read(dir.join(name)).map_err(|e| e.to_string())?;
        CertificateDer::pem_slice_iter(&pem).collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    };
    let ca = read_chain("server.codeium.com.pem")?;
    if ca.len() != 1 {
        return Err("候选 CA 必须恰好包含一张证书".into());
    }
    let chain = read_chain(MITM_LEAF_CERT_FILE)?;
    if chain.len() != 2 || chain[1] != ca[0] {
        return Err("候选叶子链必须为叶子证书加当前候选 CA".into());
    }
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca[0].clone()).map_err(|e| e.to_string())?;
    let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
        std::sync::Arc::new(roots),
        std::sync::Arc::new(rustls::crypto::ring::default_provider()),
    ).build().map_err(|e| e.to_string())?;
    let now = UnixTime::now();
    for hostname in mitm_dns_names() {
        let name = ServerName::try_from(*hostname).map_err(|e| e.to_string())?;
        verifier.verify_server_cert(&chain[0], &[], &name, &[], now)
            .map_err(|e| format!("候选 TLS 证书链校验失败（{}）: {}", hostname, e))?;
    }
    Ok(())
}

// 在逐文件提交前保存完整快照；提交失败时逆序恢复，避免 CA、私钥和叶子文件混合。
// 这是进程内故障恢复，不等同于跨进程崩溃安全的事务；恢复失败必须停机报告。
pub(super) fn commit_mitm_package<F>(
    certs_dir: &std::path::Path,
    files: &[&str],
    contents: &[Vec<u8>],
    mut write_file: F,
) -> Result<(), String>
where
    F: FnMut(&std::path::Path, &[u8]) -> Result<(), String>,
{
    if files.len() != contents.len() {
        return Err("证书包文件与内容数量不一致，未提交".into());
    }
    let snapshot = files.iter().map(|name| {
        let path = certs_dir.join(name);
        // 不把符号链接或目录当成可恢复的普通文件；在首次提交前拒绝异常目标。
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(format!("证书目标不是普通文件，未提交: {}", path.display()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("读取证书目标失败 {}: {}", path.display(), error)),
        }
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("读取证书包快照失败 {}: {}", path.display(), error)),
        }
    }).collect::<Result<Vec<_>, _>>()?;

    let mut committed = 0usize;
    for (name, content) in files.iter().zip(contents) {
        if let Err(error) = write_file(&certs_dir.join(name), content) {
            let mut rollback_errors = Vec::new();
            // 写入返回错误时目标也可能已被改动，因此连失败的当前文件一起恢复。
            for (rollback_name, previous) in files[..=committed].iter().zip(&snapshot[..=committed]).rev() {
                let path = certs_dir.join(rollback_name);
                let result = match previous {
                    Some(bytes) => write_file(&path, bytes),
                    None => match std::fs::remove_file(&path) {
                        Ok(()) => Ok(()),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                        Err(e) => Err(e.to_string()),
                    },
                };
                if let Err(rollback_error) = result {
                    rollback_errors.push(format!("{}: {}", path.display(), rollback_error));
                }
            }
            return if rollback_errors.is_empty() {
                Err(format!("证书包提交失败，已恢复原包: {}", error))
            } else {
                Err(format!("证书包提交失败且恢复失败，当前状态不确定，请停机并人工恢复: {}; {}", error, rollback_errors.join("; ")))
            };
        }
        committed += 1;
    }
    Ok(())
}

// 候选目录独占创建，Unix 从创建时即为 0700；不会复用或清理其他任务的目录。
pub(super) fn prepare_mitm_candidate(
    certs_dir: &std::path::Path,
    write_bundle: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<(), String> {
    restrict_cert_dir_permissions(certs_dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let candidate = certs_dir.join(format!(".candidate-{}-{stamp}", std::process::id()));
    // mode() 只在 Unix 存在；Windows 上 builder 不需要可变绑定。
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }

    builder.create(&candidate).map_err(|e| format!("创建候选证书目录失败: {}", e))?;
    let result: Result<(), String> = (|| {
        write_bundle(&candidate)?;
        validate_mitm_cert_files(&candidate.join("server.codeium.com.pem"), &candidate.join("server.codeium.com-key.pem"))?;
        validate_mitm_cert_files(&candidate.join(MITM_LEAF_CERT_FILE), &candidate.join(MITM_LEAF_KEY_FILE))?;
        validate_mitm_candidate_chain(&candidate)?;
        let marker = std::fs::read_to_string(candidate.join("san-version")).map_err(|e| e.to_string())?;
        if marker.trim() != MITM_CERT_SAN_VERSION {
            return Err("候选证书 SAN 版本标记无效".into());
        }

        // 先读齐整个候选包，任何生成、校验或读取错误都不会修改当前包。
        // 提交仍逐文件执行；写入错误触发内存快照恢复，但崩溃、信任/网关失败不在恢复范围。
        let files = ["server.codeium.com.pem", "server.codeium.com-key.pem",
            MITM_LEAF_CERT_FILE, MITM_LEAF_KEY_FILE, "san-version"];
        let contents = files.iter().map(|name| {
            std::fs::read(candidate.join(name)).map_err(|e| e.to_string())
        }).collect::<Result<Vec<_>, _>>()?;
        commit_mitm_package(certs_dir, &files, &contents, |path, bytes| write_atomic(path, bytes))
    })();

    // 只清理本次成功创建的候选目录；清理失败显式报告，私钥不能静默遗留。
    match (result, std::fs::remove_dir_all(&candidate)) {
        (result, Ok(())) => result,
        (result, Err(error)) => Err(format!("{}；候选目录清理失败 {}: {}（可能含私钥，请勿上传）",
            result.err().unwrap_or_else(|| "证书文件已提交".into()), candidate.display(), error)),
    }
}

// 注入生成步骤以隔离测试目录及失败路径；不触碰真实配置目录或系统信任库。
pub(super) fn ensure_mitm_certs_in_dir(
    certs_dir: std::path::PathBuf,
    force: bool,
    write_bundle: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<(std::path::PathBuf, bool), String> {
    std::fs::create_dir_all(&certs_dir).map_err(|e| {
        format!(
            "无法创建证书目录 {} ({})。请检查用户配置目录写权限",
            certs_dir.to_string_lossy(),
            e
        )
    })?;
    reject_interrupted_mitm_candidates(&certs_dir)?;

    let cert_path = certs_dir.join("server.codeium.com.pem");
    let key_path = certs_dir.join("server.codeium.com-key.pem");
    let leaf_cert_path = certs_dir.join(MITM_LEAF_CERT_FILE);
    let leaf_key_path = certs_dir.join(MITM_LEAF_KEY_FILE);
    let san_marker_path = certs_dir.join("san-version");

    // force 只跳过复用判断，不预删旧包；候选生成失败不会改变当前包。
    // 提交写入错误会尝试快照恢复；崩溃及后续信任安装/网关失败不属于该恢复边界。

    let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let leaf_ok = leaf_cert_path
        .metadata()
        .map(|m| m.len() > 0)
        .unwrap_or(false)
        && leaf_key_path
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false)
        && validate_mitm_cert_files(&leaf_cert_path, &leaf_key_path).is_ok();
    let san_ok = std::fs::read_to_string(&san_marker_path)
        .map(|s| s.trim() == MITM_CERT_SAN_VERSION)
        .unwrap_or(false);
    let contents_ok = cert_ok && key_ok && validate_mitm_cert_files(&cert_path, &key_path).is_ok();

    // 证书现在有有效期（365 天），到期后客户端会重新按策略拒绝 → 必须提前换新。
    // 用「文件生成时间」判断是否该换（阈值 300 天 < 365 天有效期），无需额外 X.509 解析依赖：
    // 只要用户每 365 天启动过一次，就不会拿到过期证书；久未启动则下次启动自动换新。
    let fresh_enough = !mitm_certs_need_renewal(&certs_dir);

    // CA 与叶子证书必须成对且完整；任一空/缺/版本过期/内容无效/快到期都重生。
    // 旧版只有 CA-as-leaf 单文件（无 mitm-leaf.pem）→ leaf_ok=false → 自动补齐叶子证书。
    // 对可解析旧包也验证实际链和域名；失败只报错，不因新校验失败静默轮换 CA。
    if !force && contents_ok && san_ok && leaf_ok {
        validate_mitm_candidate_chain(&certs_dir).map_err(|e| format!(
            "现有证书包离线校验失败，未自动替换证书。请检查系统时间和证书包，停止网关后显式处理: {}", e
        ))?;
    }
    let already_complete = !force && contents_ok && san_ok && leaf_ok && fresh_enough;

    if !already_complete {
        // 生成 CA 信任根 + 由其签发的 end-entity 叶子证书。
        // 严格 TLS 客户端（rustls/webpki）拒绝 CA 证书当作服务器证书，故叶子必须独立。
        prepare_mitm_candidate(&certs_dir, write_bundle)?;

        // 回读校验：避免磁盘满/权限问题导致「写入成功但文件为空」
        let cert_ok = cert_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
        let key_ok = key_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
        let leaf_ok = leaf_cert_path
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false)
            && leaf_key_path
                .metadata()
                .map(|m| m.len() > 0)
                .unwrap_or(false);
        let san_ok = std::fs::read_to_string(&san_marker_path)
            .map(|s| s.trim() == MITM_CERT_SAN_VERSION)
            .unwrap_or(false);

        // 提交后再次从当前路径读链，避免只验证候选目录却漏掉目标包不一致。
        let contents_result = validate_mitm_cert_files(&cert_path, &key_path)
            .and_then(|()| validate_mitm_cert_files(&leaf_cert_path, &leaf_key_path))
            .and_then(|()| validate_mitm_candidate_chain(&certs_dir));

        if !cert_ok || !key_ok || !leaf_ok || !san_ok || contents_result.is_err() {
            return Err(format!(
                "证书写入后校验失败: cert_ok={} key_ok={} leaf_ok={} san_ok={} contents={} dir={}",
                cert_ok,
                key_ok,
                leaf_ok,
                san_ok,
                contents_result.err().unwrap_or_else(|| "ok".to_string()),
                certs_dir.to_string_lossy()
            ));
        }
    }

    Ok((certs_dir, !already_complete))
}

/// 与安装/卸载共用任务锁，并在生成及信任安装期间阻止桌面网关启动。
/// 超时只结束等待，阻塞任务实际退出前仍保留保护；不主动停止运行中的网关。
#[tauri::command]
pub async fn generate_certs(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    // 与其他健康页证书动作共用包装器，使进度事件能关联同一个 UI 请求和后端操作。
    crate::commands::cert_install::run_cert_task("证书生成", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&app, || generate_certs_ex(false))
    }).await
}

/// 生成（或强制重生）MITM 证书，并尝试安装到当前平台的系统信任库。
/// Unix 上的包写锁覆盖证书提交和信任安装，避免独立桌面实例在两步之间轮换 CA。
/// 信任安装失败会作为错误返回；已写入的证书文件不会被误报为完整成功。
/// 本函数不获取进程内证书任务锁或网关启动占位，调用方负责这些保护。
pub fn generate_certs_ex(force: bool) -> Result<String, String> {
    let certs_dir = crate::commands::config::config_dir_path().join("certs");
    let _package_lock = acquire_mitm_package_lock(&certs_dir, true)?;
    let (certs_dir, generated) = ensure_mitm_certs_ex_unlocked(force)?;

    // 生成入口是用户显式操作，允许当前平台的信任安装流程请求必要授权；
    // 具体平台实现负责保留原始授权错误，不在后台绕过系统安全边界。
    match crate::commands::cert_install::install_ca_impl_with_package_lock(
        None,
        false,
        force || generated,
        true,
    ) {
        Ok(install_msg) => {
            // 证书生成/重装同样要把 Node TLS 栈的信任对齐，否则升级后仍是假接入。
            #[cfg(target_os = "windows")]
            crate::commands::cert_install::ensure_node_ca_trust()?;
            let gen_msg = if generated {
                format!("已生成证书到 {}", certs_dir.to_string_lossy())
            } else {
                format!("证书已存在 ({})", certs_dir.to_string_lossy())
            };
            Ok(format!("{gen_msg}\n{install_msg}"))
        }
        Err(e) => {
            let gen_msg = if generated {
                format!("已生成证书到 {}", certs_dir.to_string_lossy())
            } else {
                format!("证书文件已就绪 ({})", certs_dir.to_string_lossy())
            };
            Err(format!(
                "{}，但系统信任安装未完成: {}。请在「平台 > 设置 > 环境检测」点「安装证书」；不要反复重生证书",
                gen_msg, e
            ))
        }
    }
}
