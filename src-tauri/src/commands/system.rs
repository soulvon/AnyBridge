#[cfg(unix)]
use std::fs::File;
use std::process::Command;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

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
const MITM_CERT_SAN_VERSION: &str = "3";
/// 证书有效期（相对当前时间的天数）。
/// not_before 往前 1 天，容忍客户端与本机之间的时钟偏差；
/// not_after 365 天，远低于 Apple / Chromium 要求的 825 天上限。
const MITM_CERT_NOT_BEFORE_DAYS: i64 = -1;
const MITM_CERT_NOT_AFTER_DAYS: i64 = 365;
/// 证书文件超过这个天数就换新。必须明显小于 NOT_AFTER_DAYS，确保在过期前换掉。
const MITM_CERT_MAX_AGE_DAYS: u64 = 300;

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

fn mitm_cert_validity() -> Result<(time::OffsetDateTime, time::OffsetDateTime), String> {
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

const MITM_DNS_NAMES: &[&str] = &[
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
fn validate_mitm_key_pair(cert_pem: &[u8], key_pem: &[u8]) -> Result<(), String> {
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

fn mitm_san_entries() -> Result<Vec<rcgen::SanType>, String> {
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

fn write_mitm_cert_bundle(certs_dir: &std::path::Path) -> Result<(), String> {
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

#[derive(serde::Deserialize)]
pub struct ExportLogEntry {
    ts: String,
    level: String,
    msg: String,
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "启动代理", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止代理", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;

    let tray = TrayIconBuilder::with_id("main-tray");
    let tray_icon = Image::new(include_bytes!("../../icons/tray-icon.rgba"), 64, 64);
    let tray = tray.icon(tray_icon);
    tray.tooltip("AnyBridge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    // Windows 上先恢复 skip_taskbar + unminimize，配合 CloseRequested 的 minimize 方案。
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_skip_taskbar(false);
                        let _ = w.unminimize();
                        // 短暂置顶绕过 Windows 焦点防盗保护
                        let _ = w.set_always_on_top(true);
                    }
                    let _ = w.show();
                    let _ = w.set_focus();
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_always_on_top(false);
                    }
                }
            }
            "start" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = crate::commands::proxy::start_proxy_service_impl(app);
                });
            }
            "stop" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = crate::commands::proxy::stop_proxy_service_impl(app);
                });
            }
            "quit" => {
                // 退出只停止 AnyBridge sidecar；IDE 是否切到代理由平台页按钮管理。
                let _ = crate::commands::proxy::stop_proxy_service_impl(app.clone());
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_skip_taskbar(false);
                        let _ = w.unminimize();
                        let _ = w.set_always_on_top(true);
                    }
                    let _ = w.show();
                    let _ = w.set_focus();
                    #[cfg(target_os = "windows")]
                    {
                        let _ = w.set_always_on_top(false);
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[tauri::command]
pub fn export_proxy_logs(entries: Vec<ExportLogEntry>) -> Result<String, String> {
    if entries.is_empty() {
        return Err("暂无日志可导出".into());
    }

    let export_dir = crate::commands::config::config_dir_path().join("log-exports");
    std::fs::create_dir_all(&export_dir).map_err(|e| format!("创建日志导出目录失败: {}", e))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = export_dir.join(format!("byok-logs-{}.txt", ts));
    let mut content = String::new();
    for entry in entries {
        content.push_str(&format!(
            "[{}] {} {}\n",
            entry.ts,
            entry.level.to_uppercase(),
            entry.msg
        ));
    }
    std::fs::write(&path, content).map_err(|e| format!("写入日志文件失败: {}", e))?;

    // 清理历史导出：每次导出都是一份完整日志快照（可能数 MB），只保留最近
    // 10 份，防止用户目录 log-exports 无限堆积。
    const MAX_EXPORTS: usize = 10;
    if let Ok(items) = std::fs::read_dir(&export_dir) {
        let mut files: Vec<std::path::PathBuf> = items
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("byok-logs-")
            })
            .map(|entry| entry.path())
            .collect();
        if files.len() > MAX_EXPORTS {
            files.sort_by_key(|p| {
                std::fs::metadata(p)
                    .and_then(|m| m.modified())
                    .map(|t| {
                        t.duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0)
                    })
                    .unwrap_or(0)
            });
            for stale in files.iter().take(files.len() - MAX_EXPORTS) {
                let _ = std::fs::remove_file(stale);
            }
        }
    }

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        if enabled {
            let run_value = format!("\"{}\"", exe);
            let output = Command::new("reg")
                .args([
                    "add",
                    key,
                    "/v",
                    "AnyBridge",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &run_value,
                    "/f",
                ])
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "写入开机自启注册表失败: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        } else {
            for value_name in ["AnyBridge", "IDEBYOK"] {
                let _ = Command::new("reg")
                    .args(["delete", key, "/v", value_name, "/f"])
                    .creation_flags(0x0800_0000)
                    .output();
            }
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let plist_name = "com.anybridge.desktop.plist";
        let plist_path = dirs::home_dir()
            .map(|h| h.join("Library/LaunchAgents").join(plist_name))
            .ok_or("无法获取用户目录")?;

        if enabled {
            let plist_content = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.anybridge.desktop</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>"#,
                exe
            );
            std::fs::write(&plist_path, plist_content)
                .map_err(|e| format!("写入 launchd plist 失败: {}", e))?;
        } else {
            let _ = std::fs::remove_file(&plist_path);
            let _ = std::fs::remove_file(
                dirs::home_dir()
                    .map(|h| h.join("Library/LaunchAgents/com.idebyok.desktop.plist"))
                    .ok_or("无法获取用户目录")?,
            );
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let autostart_dir = dirs::config_dir()
            .map(|d| d.join("autostart"))
            .ok_or("无法获取配置目录")?;
        let desktop_path = autostart_dir.join("anybridge.desktop");

        if enabled {
            std::fs::create_dir_all(&autostart_dir).map_err(|e| e.to_string())?;
            // Desktop Entry Spec: Exec 值中的空格/引号需要转义
            let exec = format!("\"{}\"", exe.replace('\\', "\\\\").replace('"', "\\\""));
            let desktop_content = format!(
                "[Desktop Entry]\nType=Application\nName=AnyBridge\nExec={}\nHidden=false\nX-GNOME-Autostart-enabled=true\n",
                exec
            );
            std::fs::write(&desktop_path, desktop_content)
                .map_err(|e| format!("写入 .desktop 失败: {}", e))?;
        } else {
            let _ = std::fs::remove_file(&desktop_path);
            let _ = std::fs::remove_file(autostart_dir.join("ide-byok.desktop"));
        }
        Ok(())
    }
}

#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        for value_name in ["AnyBridge", "IDEBYOK"] {
            let output = Command::new("reg")
                .args(["query", key, "/v", value_name])
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string())?;
            if output.status.success() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    #[cfg(target_os = "macos")]
    {
        let launch_agents = dirs::home_dir()
            .map(|h| h.join("Library/LaunchAgents"))
            .ok_or("无法获取用户目录")?;
        Ok(launch_agents.join("com.anybridge.desktop.plist").exists()
            || launch_agents.join("com.idebyok.desktop.plist").exists())
    }

    #[cfg(target_os = "linux")]
    {
        let autostart_dir = dirs::config_dir()
            .map(|d| d.join("autostart"))
            .ok_or("无法获取配置目录")?;
        Ok(autostart_dir.join("anybridge.desktop").exists()
            || autostart_dir.join("ide-byok.desktop").exists())
    }
}

#[tauri::command]
pub fn open_config_dir(which: String) -> Result<(), String> {
    let base = crate::commands::config::config_dir_path();
    let target = match which.as_str() {
        "certs" => base.join("certs"),
        _ => base,
    };
    reveal_path_impl(&target)?;
    Ok(())
}

fn expand_user_path(path: &str) -> std::path::PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        return dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(trimmed)
}

/// 弹出系统文件选择对话框。`extensions` 形如 ["json","jsonl","txt"]。取消返回 None。
#[tauri::command]
pub async fn pick_file(
    title: Option<String>,
    extensions: Option<Vec<String>>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let title = title
        .unwrap_or_else(|| "选择文件".into())
        .trim()
        .to_string();
    let default_path = default_path.unwrap_or_default().trim().to_string();
    let extensions: Vec<String> = extensions
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_string())
        .filter(|e| !e.is_empty())
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(&title);
        if !extensions.is_empty() {
            let refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter("支持的文件", &refs);
        }
        if !default_path.is_empty() {
            let p = expand_user_path(&default_path);
            if p.is_dir() {
                dialog = dialog.set_directory(&p);
            } else if let Some(parent) = p.parent() {
                if parent.is_dir() {
                    dialog = dialog.set_directory(parent);
                }
            }
        }
        Ok(dialog.pick_file().map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("文件选择对话框失败: {}", e))?
}

/// 弹出系统文件夹选择对话框。取消返回 None。
#[tauri::command]
pub async fn pick_directory(
    title: Option<String>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let title = title
        .unwrap_or_else(|| "选择文件夹".into())
        .trim()
        .to_string();
    let default_path = default_path.unwrap_or_default().trim().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(&title);
        if !default_path.is_empty() {
            let p = expand_user_path(&default_path);
            if p.is_dir() {
                dialog = dialog.set_directory(&p);
            } else if let Some(parent) = p.parent() {
                if parent.is_dir() {
                    dialog = dialog.set_directory(parent);
                }
            }
        }
        Ok(dialog
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("打开文件夹选择对话框失败: {}", e))?
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = expand_user_path(&path);
    // 文件：打开父目录；目录：直接打开
    let parent = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .ok_or_else(|| "无法获取配置文件所在目录".to_string())?
            .to_path_buf()
    };
    reveal_path_impl(&parent)
}

fn reveal_path_impl(target: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 将单个证书或私钥先写入同目录临时文件，再提交为目标文件。
/// 这里只保证单文件替换的原子性，不保证 CA、私钥、叶子证书和版本标记整体事务一致。
fn write_atomic(path: &std::path::Path, contents: impl AsRef<[u8]>) -> Result<(), String> {
    // 临时文件必须与目标文件位于同一目录，Unix/macOS 才能通过 rename 原子替换目标。
    let parent = path
        .parent()
        .ok_or_else(|| format!("证书路径缺少父目录: {}", path.to_string_lossy()))?;
    std::fs::create_dir_all(parent).map_err(|e| {
        format!(
            "无法创建目录 {} ({})。请检查写权限/杀软拦截",
            parent.to_string_lossy(),
            e
        )
    })?;

    // 目录权限由证书包写入入口统一收紧（prepare_mitm_candidate / ensure_mitm_certs_in_dir），
    // 这里逐文件不再重复 chmod，避免同一次提交里反复修改目录属性。

    // 进程号和纳秒时间戳降低并发任务或崩溃残留造成的临时文件名冲突。
    // 下层仍使用 create_new，最终保证不覆盖同名文件或符号链接。
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("cert"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));

    // 写入、刷盘或失败清理的底层错误由 write_private_cert_temp 保留；这里补充临时路径。
    write_private_cert_temp(&tmp, contents.as_ref()).map_err(|e| {
        format!(
            "写入临时文件失败 {} ({})。请检查磁盘空间、写权限或同名残留；不会覆盖已有临时文件",
            tmp.to_string_lossy(),
            e
        )
    })?;

    // Unix 的同目录 rename 可原子覆盖；失败时不能通过删除旧目标来掩盖错误。
    #[cfg(unix)]
    return commit_unix_cert_file(&tmp, path);

    // Windows 上 rename 不能覆盖已存在目标；先尝试 rename，失败则 remove+rename 再回退 copy。
    #[cfg(not(unix))]
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
            match std::fs::rename(&tmp, path) {
                Ok(()) => Ok(()),
                Err(e2) => {
                    // 最后回退：直接覆盖写目标（不如 rename 原子，但比失败好）
                    let copy_result = std::fs::copy(&tmp, path);
                    let _ = std::fs::remove_file(&tmp);
                    match copy_result {
                        Ok(_) => Ok(()),
                        Err(e3) => Err(format!(
                            "原子写入证书失败 {} (rename: {}; retry: {}; copy: {})",
                            path.to_string_lossy(),
                            rename_err,
                            e2,
                            e3
                        )),
                    }
                }
            }
        }
    }
}

// 证书目录可能早已由旧版本创建，写入前仍需收紧目录权限；Windows 不改变既有 ACL。
fn restrict_cert_dir_permissions(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)
            .map_err(|e| format!("读取证书目录权限失败 {}: {}", path.to_string_lossy(), e))?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("收紧证书目录权限失败 {}: {}", path.to_string_lossy(), e))?;
    }
    let _ = path;
    Ok(())
}

// 独占创建拒绝已有文件（含符号链接），避免截断残留或跟随链接写到其他位置。
// Unix 从创建时即使用 0600，rename 后仍保持私有权限；不修改已有文件的权限或内容。
fn write_private_cert_temp(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let write_result = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        // 写入中途失败时临时文件可能包含部分私钥；清理失败也必须显式返回，不能静默遗留。
        return match std::fs::remove_file(path) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(std::io::Error::new(
                error.kind(),
                format!("{}；清理临时证书文件失败: {}", error, cleanup_error),
            )),
        };
    }
    Ok(())
}

// 失败时保留目标及临时文件，避免二次删除/复制扩大故障；此处只保证单文件替换。
#[cfg(any(unix, test))]
fn commit_unix_cert_file(tmp: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    std::fs::rename(tmp, path).map_err(|error| format!(
        "原子写入证书失败 {} ({})；未删除原目标，临时文件保留于 {}",
        path.to_string_lossy(), error, tmp.to_string_lossy()
    ))
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
/// 本入口不获取证书任务锁或代理启动占位，调用方须保证桌面进程内互斥且代理已停止。
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

/// 只读校验代理启动所需的现有证书包；后台路径不能隐式生成、轮换或续期证书。
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
fn validate_existing_mitm_package_in_dir(
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

// 只读检测候选目录，阻止代理复用或信任安装使用可能正在生成/提交的证书包。
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
                "发现候选证书目录 {}，可能有证书生成/提交仍在进行或曾中断；代理未启动。等待相关操作结束后重试；若目录持续存在，请人工核查，程序不会自动删除",
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
fn commit_mitm_package<F>(
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
fn prepare_mitm_candidate(
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
        // 提交仍逐文件执行；写入错误触发内存快照恢复，但崩溃、信任/代理失败不在恢复范围。
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
fn ensure_mitm_certs_in_dir(
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
    // 提交写入错误会尝试快照恢复；崩溃及后续信任安装/代理失败不属于该恢复边界。

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
            "现有证书包离线校验失败，未自动替换证书。请检查系统时间和证书包，停止代理后显式处理: {}", e
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

/// 与安装/卸载共用任务锁，并在生成及信任安装期间阻止桌面代理启动。
/// 超时只结束等待，阻塞任务实际退出前仍保留保护；不主动停止运行中的代理。
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
/// 本函数不获取进程内证书任务锁或代理启动占位，调用方负责这些保护。
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

/// 配置键：缓存上次探测成功的 IDE exe 路径，
/// 也用作用户手动指定路径的入口（设置页可写入此键）。
#[cfg(target_os = "windows")]
const IDE_EXE_KEY: &str = "ideExePath";
#[cfg(target_os = "windows")]
const DEVIN_EXE_KEY: &str = "devinExePath";
#[cfg(target_os = "windows")]
const CURSOR_EXE_KEY: &str = "cursorExePath";
#[cfg(target_os = "windows")]
const ANTIGRAVITY_EXE_KEY: &str = "antigravityExePath";
#[cfg(target_os = "windows")]
const ANTIGRAVITY_IDE_EXE_KEY: &str = "antigravityIdeExePath";
#[cfg(target_os = "macos")]
const WINDSURF_APP_KEY: &str = "windsurfAppPath";
#[cfg(target_os = "macos")]
const DEVIN_APP_KEY: &str = "devinAppPath";
#[cfg(target_os = "macos")]
const CURSOR_APP_KEY: &str = "cursorAppPath";
#[cfg(target_os = "macos")]
const ANTIGRAVITY_APP_KEY: &str = "antigravityAppPath";
#[cfg(target_os = "macos")]
const ANTIGRAVITY_IDE_APP_KEY: &str = "antigravityIdeAppPath";
#[cfg(target_os = "linux")]
const WINDSURF_BIN_KEY: &str = "windsurfBinPath";
#[cfg(target_os = "linux")]
const DEVIN_BIN_KEY: &str = "devinBinPath";
#[cfg(target_os = "linux")]
const CURSOR_BIN_KEY: &str = "cursorBinPath";
#[cfg(target_os = "linux")]
const ANTIGRAVITY_BIN_KEY: &str = "antigravityBinPath";
#[cfg(target_os = "linux")]
const ANTIGRAVITY_IDE_BIN_KEY: &str = "antigravityIdeBinPath";

/// 根据 target 返回配置键名。
#[cfg(target_os = "windows")]
fn ide_exe_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_EXE_KEY,
        "cursor" => CURSOR_EXE_KEY,
        "antigravity-ide" => ANTIGRAVITY_IDE_EXE_KEY,
        "antigravity" => ANTIGRAVITY_EXE_KEY,
        _ => IDE_EXE_KEY,
    }
}

#[cfg(target_os = "macos")]
fn ide_app_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_APP_KEY,
        "cursor" => CURSOR_APP_KEY,
        "antigravity-ide" => ANTIGRAVITY_IDE_APP_KEY,
        "antigravity" => ANTIGRAVITY_APP_KEY,
        _ => WINDSURF_APP_KEY,
    }
}

#[cfg(target_os = "linux")]
fn ide_bin_key(target: &str) -> &'static str {
    match target {
        "devin" => DEVIN_BIN_KEY,
        "cursor" => CURSOR_BIN_KEY,
        "antigravity-ide" => ANTIGRAVITY_IDE_BIN_KEY,
        "antigravity" => ANTIGRAVITY_BIN_KEY,
        _ => WINDSURF_BIN_KEY,
    }
}

/// 根据 target 返回可执行文件名（Windows），用于默认安装位置拼接。
/// 注意：Devin 的安装目录下可执行文件叫 Devin.exe，但运行时主进程名仍为 Windsurf.exe。
#[cfg(target_os = "windows")]
fn ide_exe_filename(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.exe",
        "cursor" => "Cursor.exe",
        "antigravity-ide" => "Antigravity IDE.exe",
        "antigravity" => "Antigravity.exe",
        "claude-desktop" | "claude" => "Claude.exe",
        _ => "Windsurf.exe",
    }
}

#[cfg(target_os = "macos")]
fn ide_app_filename(target: &str) -> &'static str {
    match target {
        "devin" => "Devin.app",
        "cursor" => "Cursor.app",
        "antigravity-ide" => "Antigravity IDE.app",
        "antigravity" => "Antigravity.app",
        "claude-desktop" | "claude" => "Claude.app",
        _ => "Windsurf.app",
    }
}

#[cfg(target_os = "linux")]
fn ide_bin_filename(target: &str) -> &'static str {
    match target {
        "devin" => "devin",
        "cursor" => "cursor",
        "antigravity-ide" => "antigravity-ide",
        "antigravity" => "antigravity",
        _ => "windsurf",
    }
}

/// 根据 target 返回文件夹名（Windsurf/Devin/Antigravity IDE/antigravity）。
fn ide_dir_name(target: &str) -> &'static str {
    match target {
        "devin" => "Devin",
        "cursor" => "Cursor",
        "antigravity-ide" => "Antigravity IDE",
        "antigravity" => "antigravity",
        "claude-desktop" | "claude" => "Claude",
        _ => "Windsurf",
    }
}

#[cfg(target_os = "macos")]
fn is_ide_app_for_target(target: &str, path: &std::path::Path) -> bool {
    path.exists()
        && path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(ide_app_filename(target)))
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn is_ide_bin_for_target(target: &str, path: &std::path::Path) -> bool {
    path.exists()
        && path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(ide_bin_filename(target)))
            .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn path_has_component(path: &std::path::Path, name: &str) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(name))
}

#[cfg(target_os = "windows")]
fn is_cli_subprocess_path(path: &std::path::Path) -> bool {
    let s = path.to_string_lossy().replace('/', "\\").to_lowercase();
    s.contains("\\extensions\\windsurf\\devin\\") && s.contains("\\bin\\")
}

#[cfg(target_os = "windows")]
fn is_ide_exe_for_target(target: &str, path: &std::path::Path) -> bool {
    if !path.exists() || is_cli_subprocess_path(path) {
        return false;
    }
    let Some(file_name) = path.file_name().map(|n| n.to_string_lossy()) else {
        return false;
    };
    let in_devin_dir = path_has_component(path, "Devin");
    match target {
        // Devin 的 Electron 主进程在部分版本里仍叫 Windsurf.exe，所以目录也要参与判断。
        "devin" => {
            file_name.eq_ignore_ascii_case("Devin.exe")
                || (file_name.eq_ignore_ascii_case("Windsurf.exe") && in_devin_dir)
        }
        "cursor" => file_name.eq_ignore_ascii_case("Cursor.exe"),
        "antigravity-ide" => file_name.eq_ignore_ascii_case("Antigravity IDE.exe"),
        "antigravity" => file_name.eq_ignore_ascii_case("Antigravity.exe"),
        _ => file_name.eq_ignore_ascii_case("Windsurf.exe") && !in_devin_dir,
    }
}

#[cfg(target_os = "windows")]
fn windows_drive_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let p = std::path::PathBuf::from(root);
        if p.exists() {
            roots.push(p);
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn common_ide_candidates(target: &str) -> Vec<std::path::PathBuf> {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    let exe_name = ide_exe_filename(target);
    let dir_name = ide_dir_name(target);
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();

    let mut push = |p: PathBuf| {
        let key = p.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            out.push(p);
        }
    };

    if let Some(local) = dirs::data_local_dir() {
        push(local.join("Programs").join(dir_name).join(exe_name));
        // Claude 官网版装在 %LOCALAPPDATA%\AnthropicClaude 下的最新 app-x.x.x 目录
        if target == "claude-desktop" || target == "claude" {
            let claude_root = local.join("AnthropicClaude");
            if let Ok(entries) = std::fs::read_dir(&claude_root) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        push(p.join("Claude.exe"));
                        push(p.join("app").join("Claude.exe"));
                    }
                }
            }
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            push(PathBuf::from(pf).join(dir_name).join(exe_name));
        }
    }
    for root in windows_drive_roots() {
        push(root.join("Program Files").join(dir_name).join(exe_name));
        push(
            root.join("Program Files (x86)")
                .join(dir_name)
                .join(exe_name),
        );
        push(root.join("Programs").join(dir_name).join(exe_name));
        push(root.join("Program").join(dir_name).join(exe_name));
        push(root.join(dir_name).join(exe_name));
    }

    out
}

/// 探测 IDE 安装路径（Windows），支持 Windsurf 和 Devin。
#[cfg(target_os = "windows")]
pub(crate) fn find_ide_exe(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    use std::process::Command;

    let key = ide_exe_key(target);

    // 1. 配置缓存 / 用户手动指定
    //    注意：Devin 的缓存路径需排除 CLI 子进程路径（extensions/windsurf/devin/bin），
    //    旧版可能缓存了错误的 CLI 路径，此处做校验并清除。
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if is_ide_exe_for_target(target, &p) {
            return Some(p);
        }
        if p.exists() {
            // 清除错误缓存，继续探测。旧版可能把 Devin CLI 子进程或另一个 IDE 的路径写进来。
            let _ = crate::commands::config::write_config_value(key, "");
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    // 2. 常见安装位置（纯文件系统检查，毫秒级）。放在 PowerShell 探测之前，
    //    覆盖默认安装与自定义盘符（含 Program\ 单数目录），避免每次接入都冷启动 PowerShell。
    for p in common_ide_candidates(target) {
        if is_ide_exe_for_target(target, &p) {
            return cache_and_return(p);
        }
    }

    // 3. 运行中进程的真实路径（仅在常见位置未命中时兜底，冷启动 PowerShell 较慢）。
    // Devin 的主进程名仍为 Windsurf.exe，需通过路径过滤区分；
    // Windsurf 的主进程也是 Windsurf.exe，无需额外过滤。
    let ps_query = if target == "devin" {
        // Devin: 同时查找 Windsurf.exe（来自 Devin 目录）和 Devin.exe 进程
        format!(
            r#"$hit = $null; $hit = Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -match '[\\/]devin[\\/]' -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1 -ExpandProperty Path; if (-not $hit) {{ $hit = Get-Process Devin -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1 -ExpandProperty Path }}; if ($hit) {{ Write-Output $hit }}"#
        )
    } else if target == "cursor" {
        format!(
            r#"Get-Process Cursor -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"#
        )
    } else if target == "antigravity-ide" {
        format!(
            r#"Get-Process 'Antigravity IDE' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"#
        )
    } else if target == "antigravity" {
        format!(
            r#"Get-Process Antigravity -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'Antigravity IDE' }} | Select-Object -First 1 -ExpandProperty Path"#
        )
    } else if target == "claude-desktop" || target == "claude" {
        format!(
            r#"$hit = Get-Process Claude -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; if (-not $hit) {{ $appx = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if ($appx -and $appx.InstallLocation) {{ $c = Join-Path $appx.InstallLocation 'app\Claude.exe'; if (Test-Path $c) {{ $hit = $c }} }} }}; if ($hit) {{ Write-Output $hit }}"#
        )
    } else {
        format!(
            r#"Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch '[\\/]devin[\\/]' }} | Select-Object -First 1 -ExpandProperty Path"#
        )
    };
    if let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_query])
        .creation_flags(0x0800_0000)
        .output()
    {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            // Devin 的运行进程是 Windsurf.exe，但安装路径应返回 Devin.exe
            let p = PathBuf::from(&path);
            if is_ide_exe_for_target(target, &p) {
                if target == "devin" {
                    // 从 Windsurf.exe 的路径推出 Devin.exe（同目录或上级）
                    if let Some(parent) = p.parent() {
                        let devin_exe = parent.join("Devin.exe");
                        if is_ide_exe_for_target(target, &devin_exe) {
                            return cache_and_return(devin_exe);
                        }
                    }
                    // fallback: 直接返回找到的路径（至少能用于重启）
                    return cache_and_return(p);
                }
                return cache_and_return(p);
            }
        }
    }

    // 4. 注册表卸载项（兜底，冷启动 PowerShell 较慢）
    if let Some(p) = find_ide_exe_from_registry(target) {
        if p.exists() {
            return cache_and_return(p);
        }
    }

    None
}

/// 从注册表卸载项探测 IDE 安装目录（支持 Windsurf 和 Devin）。
#[cfg(target_os = "windows")]
fn find_ide_exe_from_registry(target: &str) -> Option<std::path::PathBuf> {
    use std::process::Command;

    let display_pattern = format!("*{}*", ide_dir_name(target));
    let exe_name = ide_exe_filename(target);

    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$exeName = '{}'
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$candidates = New-Object System.Collections.Generic.List[string]
function Add-Candidate([string]$p) {{
  if (-not $p) {{ return }}
  $s = $p.Trim()
  if (-not $s) {{ return }}
  if ($s.StartsWith('"')) {{
    $m = [regex]::Match($s, '^"([^"]+)"')
    if ($m.Success) {{ $s = $m.Groups[1].Value }}
  }} else {{
    $m = [regex]::Match($s, '^[A-Za-z]:\\.+?\.exe')
    if ($m.Success) {{ $s = $m.Value }}
  }}
  $s = $s.Trim('"').Trim()
  if ($s) {{ $candidates.Add($s) }}
  try {{
    $parent = Split-Path -Parent $s
    if ($parent) {{ $candidates.Add((Join-Path $parent $exeName)) }}
  }} catch {{}}
}}
foreach ($r in $roots) {{
  Get-ItemProperty $r -ErrorAction SilentlyContinue |
    Where-Object {{ $_.DisplayName -like '{}' }} |
    ForEach-Object {{
      if ($_.InstallLocation) {{
        Add-Candidate (Join-Path $_.InstallLocation $exeName)
        Add-Candidate $_.InstallLocation
      }}
      Add-Candidate $_.DisplayIcon
      Add-Candidate $_.UninstallString
      Add-Candidate $_.QuietUninstallString
    }}
}}
$appPathRoots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
)
foreach ($r in $appPathRoots) {{
  $item = Get-ItemProperty $r -ErrorAction SilentlyContinue
  if ($item) {{ Add-Candidate $item.'(default)'; Add-Candidate $item.Path }}
}}
$candidates | Where-Object {{ $_ }} | Select-Object -Unique
"#,
        exe_name, display_pattern
    );

    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let candidate = line.trim().trim_matches('"');
        if candidate.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(candidate);
        if is_ide_exe_for_target(target, &p) {
            return Some(p);
        }
    }
    None
}

/// 探测 IDE .app 路径（macOS），支持 Windsurf 和 Devin。
#[cfg(target_os = "macos")]
pub(crate) fn find_ide_app(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let key = ide_app_key(target);
    let app_name = ide_app_filename(target);
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if is_ide_app_for_target(target, &p) {
            return Some(p);
        }
        if p.exists() {
            let _ = crate::commands::config::write_config_value(key, "");
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    // 系统级安装
    let system = PathBuf::from(format!("/Applications/{}", app_name));
    if system.exists() {
        return cache_and_return(system);
    }
    // 用户级安装
    if let Some(home) = dirs::home_dir() {
        let user = home.join("Applications").join(app_name);
        if user.exists() {
            return cache_and_return(user);
        }
    }
    None
}

/// 探测 IDE 可执行文件（Linux），支持 Windsurf / Devin / Cursor。
#[cfg(target_os = "linux")]
pub(crate) fn find_ide_bin(target: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let key = ide_bin_key(target);
    let dir_name = ide_dir_name(target);
    let bin_name = ide_bin_filename(target);
    if let Some(cached) = crate::commands::config::read_config_value(key) {
        let p = PathBuf::from(&cached);
        if is_ide_bin_for_target(target, &p) {
            return Some(p);
        }
        if p.exists() {
            let _ = crate::commands::config::write_config_value(key, "");
        }
    }

    let cache_and_return = |p: PathBuf| -> Option<PathBuf> {
        let _ = crate::commands::config::write_config_value(key, &p.to_string_lossy());
        Some(p)
    };

    let lower = dir_name.to_lowercase();
    let mut candidates = vec![
        format!("/usr/share/{}/{}", lower, bin_name),
        format!("/usr/share/{}/bin/{}", lower, bin_name),
        format!("/usr/bin/{}", bin_name),
        format!("/opt/{}/{}", dir_name, bin_name),
        format!("/opt/{}/{}", lower, bin_name),
        format!("/opt/{}/bin/{}", dir_name, bin_name),
        format!("/opt/{}/bin/{}", lower, bin_name),
        format!("/snap/bin/{}", bin_name),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".local")
                .join("bin")
                .join(bin_name)
                .to_string_lossy()
                .into_owned(),
        );
        candidates.push(
            home.join(".local")
                .join("share")
                .join(&lower)
                .join(bin_name)
                .to_string_lossy()
                .into_owned(),
        );
        candidates.push(
            home.join(".local")
                .join("share")
                .join(&lower)
                .join("bin")
                .join(bin_name)
                .to_string_lossy()
                .into_owned(),
        );
    }
    // which 回退（PATH 上的真实安装）
    if let Ok(out) = Command::new("sh")
        .args(["-c", &format!("command -v {} 2>/dev/null", bin_name)])
        .output()
    {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                candidates.push(path);
            }
        }
    }

    for c in candidates {
        let p = PathBuf::from(&c);
        if p.exists() && is_ide_bin_for_target(target, &p) {
            return cache_and_return(p);
        }
    }
    None
}

/// 探测并返回当前定位到的 IDE exe 路径（设置页展示用）。
/// 返回 None 表示自动探测失败，需用户手动指定。
#[tauri::command]
pub fn detect_ide_path(target: Option<String>) -> Option<String> {
    let t = match target.as_deref() {
        Some("auto") | None => detect_target_ide(),
        Some(s) => s.to_string(),
    };
    #[cfg(target_os = "windows")]
    {
        find_ide_exe(&t).map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        find_ide_app(&t).map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(target_os = "linux")]
    {
        find_ide_bin(&t).map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = t;
        None
    }
}

/// 向后兼容
#[tauri::command]
pub fn detect_windsurf_path() -> Option<String> {
    detect_ide_path(Some("windsurf".into()))
}

/// 手动设置 IDE exe 路径（自动探测失败时的兜底，写入配置缓存）。
/// 校验路径存在且文件名是 Windsurf.exe、Devin.exe 或 Cursor.exe。
#[tauri::command]
pub fn set_ide_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_ide_exe = p
            .file_name()
            .map(|n| {
                n.eq_ignore_ascii_case("Windsurf.exe")
                    || n.eq_ignore_ascii_case("Devin.exe")
                    || n.eq_ignore_ascii_case("Cursor.exe")
            })
            .unwrap_or(false);
        if !is_ide_exe {
            return Err("请指向 Windsurf.exe、Devin.exe 或 Cursor.exe".into());
        }
        // 根据文件名 + 目录判断是哪个 IDE，写入对应配置键。
        // Devin 的部分进程仍叫 Windsurf.exe，不能只看文件名。
        let key = if is_ide_exe_for_target("cursor", &p) {
            CURSOR_EXE_KEY
        } else if is_ide_exe_for_target("devin", &p) {
            DEVIN_EXE_KEY
        } else {
            IDE_EXE_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }
    #[cfg(target_os = "macos")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_ide_app = p
            .file_name()
            .map(|n| {
                n.eq_ignore_ascii_case("Windsurf.app")
                    || n.eq_ignore_ascii_case("Devin.app")
                    || n.eq_ignore_ascii_case("Cursor.app")
            })
            .unwrap_or(false);
        if !is_ide_app {
            return Err("请指向 Windsurf.app、Devin.app 或 Cursor.app".into());
        }
        let key = if is_ide_app_for_target("cursor", &p) {
            CURSOR_APP_KEY
        } else if is_ide_app_for_target("devin", &p) {
            DEVIN_APP_KEY
        } else {
            WINDSURF_APP_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }

    #[cfg(target_os = "linux")]
    {
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            return Err("路径不存在".into());
        }
        let is_ide_bin = p
            .file_name()
            .map(|n| {
                n.eq_ignore_ascii_case("windsurf")
                    || n.eq_ignore_ascii_case("devin")
                    || n.eq_ignore_ascii_case("cursor")
            })
            .unwrap_or(false);
        if !is_ide_bin {
            return Err("请指向 windsurf、devin 或 cursor 可执行文件".into());
        }
        let key = if is_ide_bin_for_target("cursor", &p) {
            CURSOR_BIN_KEY
        } else if is_ide_bin_for_target("devin", &p) {
            DEVIN_BIN_KEY
        } else {
            WINDSURF_BIN_KEY
        };
        crate::commands::config::write_config_value(key, &path)
    }
}

/// 向后兼容
#[tauri::command]
pub fn set_windsurf_path(path: String) -> Result<(), String> {
    set_ide_path(path)
}

/// 沙箱兼容标记：记录某平台因 Chromium 沙箱初始化失败而需要 --no-sandbox 启动。
/// 存储于应用数据目录的 sandbox_compat.json，按平台 ID 记录布尔值。
#[cfg(target_os = "windows")]
fn sandbox_compat_flag(platform: &str) -> bool {
    if let Some(dir) = dirs::data_dir() {
        let p = dir.join("AnyBridge").join("sandbox_compat.json");
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                return v.get(platform).and_then(|x| x.as_bool()).unwrap_or(false);
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn set_sandbox_compat_flag(platform: &str, enabled: bool) {
    if let Some(dir) = dirs::data_dir() {
        let dir = dir.join("AnyBridge");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("sandbox_compat.json");
        let mut obj = std::fs::read_to_string(&p)
            .ok()
            .and_then(|raw| {
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw).ok()
            })
            .unwrap_or_default();
        obj.insert(platform.to_string(), serde_json::Value::Bool(enabled));
        let _ = std::fs::write(&p, serde_json::to_string(&obj).unwrap_or_default());
    }
}

/// 按 `.app` 安装路径直接扫描进程 PID（macOS）。
///
/// 刻意不复用 `unix_ide_pids` 的启发式匹配：Devin 的主进程可能仍叫 Windsurf，
/// 启发式匹配一旦漏判，会同时漏掉「杀进程」和「是否已退出」两件事，
/// 于是出现"进程没死却判定成功、open -a 只是激活已运行实例"的假重启。
/// 这里只认安装路径，命中即算该 IDE 的进程（含 Electron 的 helper 子进程）。
#[cfg(target_os = "macos")]
fn macos_running_pids_for(app: &std::path::Path) -> Vec<u32> {
    let needle = app.to_string_lossy().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let Ok(out) = Command::new("ps").args(["-ax", "-o", "pid=,command="]).output() else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let (Some(pid_str), Some(cmd)) = (parts.next(), parts.next()) else {
            continue;
        };
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            if cmd.to_lowercase().contains(&needle) {
                pids.push(pid);
            }
        }
    }
    pids
}

fn restart_ide_impl(target: String) -> Result<String, String> {
    let t = if target == "auto" {
        detect_target_ide()
    } else {
        target
    };
    #[cfg(target_os = "windows")]
    {
        // 收集 taskkill 失败原因（拒绝访问等），最终报错时附带给用户，便于自助定位。
        let mut kill_report = String::new();
        let exe = find_ide_exe(&t)
            .ok_or_else(|| format!("未找到 {} 安装位置，请手动重启", ide_dir_name(&t)))?;

        // Devin 的主进程名仍为 Windsurf.exe，需通过路径过滤只杀来自 Devin 安装目录的进程；
        // Windsurf 则直接杀所有 Windsurf.exe 进程。
        if t == "devin" {
            // 获取 Devin 安装目录，用于路径过滤
            let install_dir = exe
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            if install_dir.is_empty() {
                return Err("无法确定 Devin 安装目录，请手动重启".into());
            }
            // PID 筛选与 is_ide_running 的判定保持同源（路径含 devin 目录名，
            // 排除 Windsurf 的 devin 扩展插件目录），并叠加安装目录前缀精确匹配
            // 取并集。此前只按 find_ide_exe 父目录前缀精确匹配，重装/自定义安装
            // 路径后与实际运行进程目录错位，会出现"一个都没杀到，检测却仍命中"
            // 的稳定误报"进程未能终止"。
            let pid_script = format!(
                r#"$dir = '{dir}'; $seen = @{{}}; foreach ($name in @('Windsurf','Devin')) {{ Get-Process $name -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and ($_.Path.StartsWith($dir, 'CurrentCultureIgnoreCase') -or ($_.Path -match '[\\/]devin[\\/]' -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin')) }} | ForEach-Object {{ if (-not $seen.ContainsKey($_.Id)) {{ $seen[$_.Id] = $true; $_.Id }} }} }}"#,
                dir = install_dir.replace('\'', "''")
            );
            // 最多 3 轮：枚举 PID → 强杀 → 等 1s 复查。子进程可能在父进程死后
            // 才陆续退出，单轮枚举 + 单次等待偶有漏杀。
            for _round in 0..3 {
                let mut pids: Vec<String> = Vec::new();
                if let Ok(out) = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &pid_script])
                    .creation_flags(0x0800_0000)
                    .output()
                {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        let pid = line.trim();
                        if !pid.is_empty() {
                            pids.push(pid.to_string());
                        }
                    }
                }
                if pids.is_empty() {
                    break;
                }
                for pid in &pids {
                    if let Ok(out) = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", pid])
                        .creation_flags(0x0800_0000)
                        .output()
                    {
                        if !out.status.success() {
                            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                            if !stderr.is_empty() {
                                kill_report = stderr;
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if !is_ide_running(t.clone()) {
                    break;
                }
            }
        } else {
            let image = if t == "cursor" {
                "Cursor.exe"
            } else if t == "antigravity-ide" {
                "Antigravity IDE.exe"
            } else if t == "antigravity" {
                "Antigravity.exe"
            } else if t == "claude-desktop" || t == "claude" {
                "Claude.exe"
            } else {
                "Windsurf.exe"
            };
            // 用 taskkill /F /T /IM 杀整个进程树（含 renderer/GPU 子进程）
            if let Ok(out) = Command::new("taskkill")
                .args(["/IM", image, "/F", "/T"])
                .creation_flags(0x0800_0000)
                .output()
            {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    if !stderr.is_empty() {
                        kill_report = stderr;
                    }
                }
            }
        }

        // 等待进程退出（验证是否真的杀死了）。
        // cursor / antigravity / antigravity-ide / claude 的映像名全局唯一，用 tasklist 按映像名
        // 轮询（单次 ~100ms）；不要逐轮冷启动 PowerShell（单次 1~3s，12 轮会让重启
        // 卡 15~40s，用户以为死机）。windsurf/devin 因映像名共用必须走路径过滤，保持原判。
        let unique_image = match t.as_str() {
            "cursor" => Some("Cursor.exe"),
            "antigravity-ide" => Some("Antigravity IDE.exe"),
            "antigravity" => Some("Antigravity.exe"),
            "claude-desktop" | "claude" => Some("Claude.exe"),
            _ => None,
        };
        let mut dead = false;
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let running = if let Some(image) = unique_image {
                Command::new("tasklist")
                    .args([
                        "/FI",
                        &format!("IMAGENAME eq {}", image),
                        "/FO",
                        "CSV",
                        "/NH",
                    ])
                    .creation_flags(0x0800_0000)
                    .output()
                    .map(|out| String::from_utf8_lossy(&out.stdout).contains(image))
                    .unwrap_or(false)
            } else {
                is_ide_running(t.clone())
            };
            if !running {
                dead = true;
                break;
            }
        }
        if !dead {
            let hint = if kill_report.is_empty() {
                String::new()
            } else {
                format!("（kill 输出：{}）", kill_report)
            };
            return Err(format!(
                "{} 进程未能终止，请手动关闭后重试{}",
                ide_dir_name(&t),
                hint
            ));
        }

        // 启动新 IDE 进程，设置 CREATE_NO_WINDOW 防止 CMD 窗口弹出
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let is_claude = t == "claude-desktop" || t == "claude";
        let is_msix_claude = is_claude && exe.to_string_lossy().contains("WindowsApps");

        if is_msix_claude {
            // 商店版 Claude 必须通过 shell:AppsFolder 激活，不能直接 CreateProcess
            let _ = Command::new("explorer.exe")
                .arg("shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("启动 Claude 失败: {e}"))?;
            return Ok(format!("已重启 {}", ide_dir_name(&t)));
        }

        let spawn_client = |args: &[&str]| -> Result<std::process::Child, String> {
            Command::new(&exe)
                .args(args)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))
        };

        // 沙箱兜底：部分 Windows 机器上 Chromium 沙箱初始化失败，表现为启动后数秒内
        // 静默退出（ExitCode 0x80000003），官方原版同样复现，与我们的补丁无关。
        // 实测崩溃可晚至启动后约 5 秒，因此观察窗口取 6 秒；一旦确认崩溃，
        // 记住该平台需要兼容模式，之后重启直接带 --no-sandbox，不再重复等待。
        if sandbox_compat_flag(&t) {
            spawn_client(&["--no-sandbox"])?;
            return Ok(format!("已重启 {}（兼容模式）", ide_dir_name(&t)));
        }

        let mut child = spawn_client(&[])?;
        let mut exited_early = false;
        for _ in 0..24 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited_early = true;
                    break;
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
        if exited_early {
            set_sandbox_compat_flag(&t, true);
            spawn_client(&["--no-sandbox"])?;
            return Ok(format!(
                "已重启 {}（检测到沙箱启动失败，已自动改用兼容模式并记住该设置）",
                ide_dir_name(&t)
            ));
        }

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(target_os = "macos")]
    {
        let app = find_ide_app(&t)
            .ok_or_else(|| format!("未找到 {}.app，请手动重启", ide_dir_name(&t)))?;

        let was_running = !macos_running_pids_for(&app).is_empty();

        if was_running {
            // 最多 3 轮：Electron 的 helper 子进程可能在主进程死后才陆续退出。
            for round in 0..3 {
                let pids = macos_running_pids_for(&app);
                if pids.is_empty() {
                    break;
                }
                for pid in pids {
                    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                }
                if round == 0 {
                    // 兜底再按安全进程名清一次（Devin 只 killall "Devin"，绝不误杀 Windsurf）
                    for name in unix_ide_fallback_kill_names(&t) {
                        let _ = Command::new("killall").args([name]).output();
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }

            // 真实验证：按 .app 路径复查必须清零。绝不用会漏判的启发式判定，
            // 否则 open -a 只是 activate 已运行的实例，界面却报"已重启"。
            let mut dead = false;
            for _ in 0..8 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if macos_running_pids_for(&app).is_empty() {
                    dead = true;
                    break;
                }
            }
            if !dead {
                let remaining = macos_running_pids_for(&app);
                return Err(format!(
                    "{} 进程未能终止（仍有 {} 个进程：{}），请手动退出后重试",
                    ide_dir_name(&t),
                    remaining.len(),
                    remaining
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }

        Command::new("open")
            .args(["-a"])
            .arg(&app)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))?;

        // 拉起后复查：确实出现了新进程，才算真的重启成功。
        let mut launched = false;
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !macos_running_pids_for(&app).is_empty() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err(format!(
                "{} 已退出但未能重新拉起，请手动打开 {}",
                ide_dir_name(&t),
                app.display()
            ));
        }

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(target_os = "linux")]
    {
        let bin = find_ide_bin(&t)
            .ok_or_else(|| format!("未找到 {} 可执行文件，请手动重启", ide_dir_name(&t)))?;

        let pids = unix_ide_pids(&t);
        if pids.is_empty() {
            for name in unix_ide_fallback_kill_names(&t) {
                let _ = Command::new("pkill").args(["-x", name]).output();
            }
            // Devin 主进程可能不叫 devin：仅按路径/包名子串兜底，避免 -f windsurf 误杀
            if t == "devin" {
                let _ = Command::new("pkill")
                    .args(["-f", "[/ ][Dd]evin([/ .]|$)"])
                    .output();
            }
        } else {
            for pid in pids {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
        }

        // 等待进程退出，最多 3 秒
        let mut dead = false;
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !is_ide_running(t.clone()) {
                dead = true;
                break;
            }
        }
        if !dead {
            return Err(format!(
                "{} 进程未能终止，请手动关闭后重试",
                ide_dir_name(&t)
            ));
        }

        Command::new(&bin)
            .spawn()
            .map_err(|e| format!("重启 {} 失败: {}", ide_dir_name(&t), e))?;

        Ok(format!("已重启 {}", ide_dir_name(&t)))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = t;
        Err("当前平台不支持自动重启 IDE".into())
    }
}

/// 强杀并重启 IDE，使写入的代理配置生效。
/// 注意：强杀会丢失未保存的工作，调用方需先提示用户保存。
#[tauri::command]
pub async fn restart_ide(target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || restart_ide_impl(target))
        .await
        .map_err(|e| format!("重启 IDE 任务失败: {}", e))?
}

// ═══════ IDE DETECTION ═══════

/// Unix 上「按进程名」回退杀进程时允许的名字。
/// 注意：Devin 绝不能把 Windsurf 放进回退列表——路径未命中时 killall Windsurf 会误杀真·Windsurf。
/// Devin 主进程若仍叫 Windsurf，必须靠 unix_ide_pids 的路径过滤命中 PID。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_ide_fallback_kill_names(target: &str) -> &'static [&'static str] {
    match target {
        "cursor" => {
            #[cfg(target_os = "macos")]
            {
                &["Cursor"]
            }
            #[cfg(target_os = "linux")]
            {
                &["cursor", "Cursor"]
            }
        }
        "devin" => {
            #[cfg(target_os = "macos")]
            {
                &["Devin"]
            }
            #[cfg(target_os = "linux")]
            {
                &["devin", "Devin"]
            }
        }
        _ => {
            #[cfg(target_os = "macos")]
            {
                &["Windsurf"]
            }
            #[cfg(target_os = "linux")]
            {
                &["windsurf", "Windsurf"]
            }
        }
    }
}

/// pgrep 回退探测用的进程名（可比 kill 回退更宽，但仍避免 Devin↔Windsurf 互误）。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_ide_process_names(target: &str) -> &'static [&'static str] {
    match target {
        "cursor" => unix_ide_fallback_kill_names("cursor"),
        "devin" => {
            #[cfg(target_os = "macos")]
            {
                // 探测可以包含 Windsurf，但 is_ide_running 里对 windsurf 名会 continue 跳过
                &["Devin"]
            }
            #[cfg(target_os = "linux")]
            {
                &["devin", "Devin"]
            }
        }
        _ => unix_ide_fallback_kill_names("windsurf"),
    }
}

/// 返回匹配目标 IDE 的 PID 列表（Unix）。
/// Devin 用安装路径/`devin` 路径片段过滤，避免误杀 Windsurf。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_ide_pids(target: &str) -> Vec<u32> {
    use std::collections::HashSet;

    let mut pids = HashSet::new();
    let install_hint = match target {
        "devin" => find_ide_app_or_bin_path("devin")
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "devin".into()),
        "cursor" => find_ide_app_or_bin_path("cursor")
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "cursor".into()),
        _ => find_ide_app_or_bin_path("windsurf")
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "windsurf".into()),
    };

    // ps 输出：PID COMMAND
    let out = Command::new("ps")
        .args(["-ax", "-o", "pid=,command="])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(pid_str) = parts.next() else {
            continue;
        };
        let Some(cmd) = parts.next() else { continue };
        let Ok(pid) = pid_str.trim().parse::<u32>() else {
            continue;
        };
        let cmd_l = cmd.to_lowercase();

        let matched = match target {
            "cursor" => {
                // 收紧：避免匹配任意含 cursor 的路径（如文档、其它工具）
                cmd_l.contains("cursor.app/")
                    || cmd_l.contains("cursor.app ")
                    || cmd_l.contains("/cursor.app")
                    || cmd_l.contains("/cursor/")
                    || cmd_l.ends_with("/cursor")
                    || cmd_l.contains("/cursor ")
            }
            "devin" => {
                // 排除 Windsurf 扩展里的 devin 子进程
                if cmd_l.contains("extensions/windsurf/devin")
                    || cmd_l.contains("extensions\\windsurf\\devin")
                {
                    false
                } else if !install_hint.is_empty()
                    && install_hint != "devin"
                    && cmd_l.contains(&install_hint)
                {
                    // 已探测到安装路径时，优先按安装路径匹配（覆盖主进程名为 Windsurf）
                    true
                } else {
                    cmd_l.contains("devin.app/")
                        || cmd_l.contains("devin.app ")
                        || cmd_l.contains("/devin.app")
                        || cmd_l.contains("/devin/")
                        || cmd_l.ends_with("/devin")
                        || cmd_l.contains("/devin ")
                }
            }
            _ => {
                // Windsurf：命中 windsurf，但排除 Devin 安装路径
                let looks_devin = cmd_l.contains("devin.app")
                    || cmd_l.contains("/devin/")
                    || cmd_l.contains("/devin ")
                    || cmd_l.ends_with("/devin")
                    || (cmd_l.contains("devin")
                        && !cmd_l.contains("extensions/windsurf/devin")
                        && !cmd_l.contains("extensions\\windsurf\\devin"));
                if looks_devin {
                    false
                } else if !install_hint.is_empty()
                    && install_hint != "windsurf"
                    && cmd_l.contains(&install_hint)
                {
                    true
                } else {
                    cmd_l.contains("windsurf.app/")
                        || cmd_l.contains("windsurf.app ")
                        || cmd_l.contains("/windsurf.app")
                        || cmd_l.contains("/windsurf/")
                        || cmd_l.ends_with("/windsurf")
                        || cmd_l.contains("/windsurf ")
                }
            }
        };
        if matched {
            pids.insert(pid);
        }
    }
    pids.into_iter().collect()
}

#[cfg(target_os = "macos")]
fn find_ide_app_or_bin_path(target: &str) -> Option<std::path::PathBuf> {
    find_ide_app(target)
}

#[cfg(target_os = "linux")]
fn find_ide_app_or_bin_path(target: &str) -> Option<std::path::PathBuf> {
    find_ide_bin(target)
}

#[tauri::command]
pub fn is_ide_running(name: String) -> bool {
    let n = if name == "auto" {
        detect_target_ide()
    } else {
        name
    };
    #[cfg(target_os = "windows")]
    {
        // Devin 的主进程名仍为 Windsurf.exe，需通过路径过滤区分：
        // - Devin: 查找 Windsurf.exe 进程中 Path 包含 devin 目录的
        // - Windsurf: 查找 Windsurf.exe 进程中 Path 不含 devin 目录的
        let ps_query = if n == "devin" {
            // Devin: 同时查找 Windsurf.exe（来自 Devin 目录）和 Devin.exe 进程
            format!(
                r#"$hit = Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -match '[\\/]devin[\\/]' -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1; if (-not $hit) {{ $hit = Get-Process Devin -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'extensions[/\\]windsurf[/\\]devin' }} | Select-Object -First 1 }}; $hit"#
            )
        } else if n == "cursor" {
            format!(r#"Get-Process Cursor -ErrorAction SilentlyContinue | Select-Object -First 1"#)
        } else if n == "antigravity-ide" {
            format!(
                r#"Get-Process 'Antigravity IDE' -ErrorAction SilentlyContinue | Select-Object -First 1"#
            )
        } else if n == "antigravity" {
            format!(
                r#"Get-Process Antigravity -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch 'Antigravity IDE' }} | Select-Object -First 1"#
            )
        } else if n == "claude-desktop" || n == "claude" {
            format!(
                r#"Get-Process Claude -ErrorAction SilentlyContinue | Select-Object -First 1"#
            )
        } else {
            format!(
                r#"Get-Process Windsurf -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path -notmatch '[\\/]devin[\\/]' }} | Select-Object -First 1"#
            )
        };
        if let Ok(out) = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_query])
            .creation_flags(0x0800_0000)
            .output()
        {
            !out.stdout.is_empty()
        } else {
            false
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if !unix_ide_pids(&n).is_empty() {
            return true;
        }
        // 回退：按进程名 pgrep（兼容 ps 不可用的环境）
        for process_name in unix_ide_process_names(&n) {
            if let Ok(out) = Command::new("pgrep").args(["-x", process_name]).output() {
                if !out.stdout.is_empty() {
                    // Devin 回退命中 Windsurf 时，尽量用路径再确认
                    if n == "devin" && process_name.eq_ignore_ascii_case("windsurf") {
                        continue;
                    }
                    if n == "windsurf" && process_name.eq_ignore_ascii_case("devin") {
                        continue;
                    }
                    return true;
                }
            }
        }
        false
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[tauri::command]
pub fn detect_target_ide() -> String {
    let windsurf_running = is_ide_running("windsurf".into());
    let devin_running = is_ide_running("devin".into());
    let cursor_running = is_ide_running("cursor".into());

    // 优先选择正在运行的 IDE
    if windsurf_running && !devin_running && !cursor_running {
        return "windsurf".into();
    }
    if devin_running && !windsurf_running && !cursor_running {
        return "devin".into();
    }
    if cursor_running && !windsurf_running && !devin_running {
        return "cursor".into();
    }

    // 两个都在运行或都不在运行，检查哪个有代理配置
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;
        let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));

        // 检查 Windsurf 的 settings.json 是否有 http.proxy
        let windsurf_settings = config_dir.join("Windsurf/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&windsurf_settings) {
            if content.contains("\"http.proxy\"") {
                return "windsurf".into();
            }
        }

        // 检查 Devin 的 settings.json 是否有 http.proxy
        let devin_settings = config_dir.join("Devin/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&devin_settings) {
            if content.contains("\"http.proxy\"") {
                return "devin".into();
            }
        }

        let cursor_settings = config_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    // macOS/Linux 同样检查代理配置
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        // macOS: Windsurf/Devin 配置在 ~/Library/Application Support/
        let support_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));

        let windsurf_settings = support_dir.join("Windsurf/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&windsurf_settings) {
            if content.contains("\"http.proxy\"") {
                return "windsurf".into();
            }
        }

        let devin_settings = support_dir.join("Devin/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&devin_settings) {
            if content.contains("\"http.proxy\"") {
                return "devin".into();
            }
        }

        let cursor_settings = support_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::path::PathBuf;
        let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));

        // Linux: Windsurf/Devin 配置在 ~/.config/
        let windsurf_settings = config_dir.join("Windsurf/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&windsurf_settings) {
            if content.contains("\"http.proxy\"") {
                return "windsurf".into();
            }
        }

        let devin_settings = config_dir.join("Devin/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&devin_settings) {
            if content.contains("\"http.proxy\"") {
                return "devin".into();
            }
        }

        let cursor_settings = config_dir.join("Cursor/User/settings.json");
        if let Ok(content) = std::fs::read_to_string(&cursor_settings) {
            if content.contains("\"http.proxy\"") {
                return "cursor".into();
            }
        }
    }

    // 都没有代理配置，检查哪个安装了。默认优先 Windsurf，避免双安装机器误接入 Devin。
    #[cfg(target_os = "windows")]
    {
        if find_ide_exe("windsurf").is_some() {
            return "windsurf".into();
        }
        if find_ide_exe("devin").is_some() {
            return "devin".into();
        }
        if find_ide_exe("cursor").is_some() {
            return "cursor".into();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if find_ide_app("windsurf").is_some() {
            return "windsurf".into();
        }
        if find_ide_app("devin").is_some() {
            return "devin".into();
        }
        if find_ide_app("cursor").is_some() {
            return "cursor".into();
        }
    }
    #[cfg(target_os = "linux")]
    {
        if find_ide_bin("windsurf").is_some() {
            return "windsurf".into();
        }
        if find_ide_bin("devin").is_some() {
            return "devin".into();
        }
        if find_ide_bin("cursor").is_some() {
            return "cursor".into();
        }
    }

    // 都没安装，默认返回 windsurf
    "windsurf".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    // 每项证书测试使用独立临时目录，避免并发测试读写同一路径。
    fn unique_temp_dir() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "anybridge-system-test-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn mitm_dns_names_include_cursor_hosts_without_duplicates() {
        let names = mitm_dns_names();
        let unique = names.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(unique.len(), names.len(), "MITM SAN list has duplicates");

        for expected in [
            "server.self-serve.windsurf.com",
            "server.codeium.com",
            "api2.cursor.sh",
            "authentication.cursor.sh",
            "prod.authentication.cursor.sh",
            "localhost",
        ] {
            assert!(
                unique.contains(expected),
                "MITM SAN list is missing {}",
                expected
            );
        }
        assert_eq!(MITM_CERT_SAN_VERSION, "3");
    }

    #[cfg(unix)]
    #[test]
    fn package_lock_allows_shared_readers_and_rejects_writers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_temp_dir();
        let certs_dir = dir.join("certs");
        std::fs::create_dir_all(&certs_dir).unwrap();
        let read_lock = acquire_mitm_package_lock(&certs_dir, false).unwrap();
        let second_reader = acquire_mitm_package_lock(&certs_dir, false).unwrap();
        let writer = acquire_mitm_package_lock(&certs_dir, true);
        assert!(writer.is_err());
        drop(second_reader);
        drop(read_lock);
        let writer = acquire_mitm_package_lock(&certs_dir, true).unwrap();
        let mode = std::fs::metadata(dir.join(".mitm-cert-package.lock"))
            .unwrap().permissions().mode();
        drop(writer);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn certificate_directory_permissions_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-cert-dir-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let mut permissions = std::fs::metadata(&dir).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&dir, permissions).unwrap();
        restrict_cert_dir_permissions(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn private_cert_temp_write_failure_does_not_leave_partial_file() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-private-cleanup-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let temp = dir.join("missing-parent").join("key.tmp");
        // 父目录不存在，稳定触发创建失败且不依赖权限环境；不会产生临时文件。
        let result = write_private_cert_temp(&temp, b"private-key");
        let exists = temp.exists();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(result.is_err());
        assert!(!exists, "临时私钥写入失败后不能留下部分文件");
    }

    #[test]
    fn private_cert_temp_refuses_existing_file() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-private-temp-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let temp = dir.join("key.tmp");
        write_private_cert_temp(&temp, b"original").unwrap();
        let result = write_private_cert_temp(&temp, b"replacement");
        let actual = std::fs::read(&temp).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(actual, b"original");
    }

    #[cfg(unix)]
    #[test]
    fn private_cert_temp_rejects_symlink_and_has_private_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-private-link-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("key.pem");
        write_private_cert_temp(&target, b"original").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        let link = dir.join("key.tmp");
        symlink(&target, &link).unwrap();
        let result = write_private_cert_temp(&link, b"replacement");
        let actual = std::fs::read(&target).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(result.is_err());
        assert_eq!(actual, b"original");
        assert_eq!(mode & 0o077, 0, "私钥不能授予组或其他用户访问权限");
    }

    #[test]
    fn failed_unix_commit_preserves_existing_target() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-commit-failure-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("certificate.pem");
        std::fs::write(&target, b"original").unwrap();
        // 缺失源文件可稳定模拟 rename 失败，不依赖权限设置或以管理员身份运行与否。
        let result = commit_unix_cert_file(&dir.join("missing.tmp"), &target);
        let preserved = std::fs::read(&target).ok();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(result.is_err());
        assert_eq!(preserved.as_deref(), Some(b"original".as_slice()));
    }

    #[cfg(unix)]
    #[test]
    fn unix_atomic_write_replaces_existing_target() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-commit-success-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("certificate.pem");
        std::fs::write(&target, b"original").unwrap();
        let result = write_atomic(&target, b"replacement");
        let actual = std::fs::read(&target).ok();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(result.is_ok());
        assert_eq!(actual.as_deref(), Some(b"replacement".as_slice()));
    }

    #[test]
    fn forced_generation_failure_preserves_existing_bundle() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-force-failure-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let files = ["server.codeium.com.pem", "server.codeium.com-key.pem",
            MITM_LEAF_CERT_FILE, MITM_LEAF_KEY_FILE, "san-version"];
        for name in files {
            std::fs::write(dir.join(name), format!("original-{name}")).unwrap();
        }
        // 模拟写出部分候选私钥后失败，验证当前包不受影响且候选目录被清理。
        let result = ensure_mitm_certs_in_dir(dir.clone(), true, |candidate| {
            assert_ne!(candidate, dir.as_path());
            write_atomic(&candidate.join("server.codeium.com-key.pem"), b"partial-key")?;
            Err("generation failed".into())
        });
        assert_eq!(result.unwrap_err(), "generation failed");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), files.len());
        let preserved = files.iter().all(|name| {
            std::fs::read(dir.join(name)).ok() == Some(format!("original-{name}").into_bytes())
        });
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(preserved, "生成失败不能预先删除旧证书包");
    }

    #[test]
    fn certificate_key_pair_rejects_valid_but_unrelated_key() {
        let key = rcgen::KeyPair::generate().unwrap();
        let other_key = rcgen::KeyPair::generate().unwrap();
        let params = rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap();
        let cert = params.self_signed(&key).unwrap().pem();
        assert!(validate_mitm_key_pair(cert.as_bytes(), key.serialize_pem().as_bytes()).is_ok());
        assert!(validate_mitm_key_pair(cert.as_bytes(), other_key.serialize_pem().as_bytes()).is_err());
        assert!(validate_mitm_key_pair(b"", key.serialize_pem().as_bytes()).is_err());
    }

    #[test]
    fn candidate_chain_rejects_unrelated_ca() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-chain-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        write_mitm_cert_bundle(&dir).unwrap();
        assert!(validate_mitm_candidate_chain(&dir).is_ok());
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let wrong_ca = params.self_signed(&key).unwrap().pem();
        write_atomic(&dir.join("server.codeium.com.pem"), &wrong_ca).unwrap();
        assert!(validate_mitm_candidate_chain(&dir).is_err());
        // 将链尾也换成同一个错误根，确保不是仅靠 PEM 链尾相等判断通过。
        use rustls::pki_types::{pem::PemObject, CertificateDer};
        let pem = std::fs::read(dir.join(MITM_LEAF_CERT_FILE)).unwrap();
        let leaf = CertificateDer::from_pem_slice(&pem).unwrap();
        use base64::Engine;
        let leaf_pem = format!("-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n{}",
            base64::engine::general_purpose::STANDARD.encode(leaf.as_ref()), wrong_ca);
        write_atomic(&dir.join(MITM_LEAF_CERT_FILE), leaf_pem).unwrap();
        assert!(validate_mitm_candidate_chain(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mixed_existing_bundle_is_rejected_without_rotation() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-mixed-{}-{stamp}", std::process::id()));
        let other = dir.join("other");
        std::fs::create_dir_all(&other).unwrap();
        write_mitm_cert_bundle(&dir).unwrap();
        write_mitm_cert_bundle(&other).unwrap();
        // 每对密钥均有效，但叶子来自另一套 CA，模拟逐文件提交中断的混合包。
        for name in [MITM_LEAF_CERT_FILE, MITM_LEAF_KEY_FILE] {
            write_atomic(&dir.join(name), std::fs::read(other.join(name)).unwrap()).unwrap();
        }
        let ca_before = std::fs::read(dir.join("server.codeium.com.pem")).unwrap();
        let leaf_before = std::fs::read(dir.join(MITM_LEAF_CERT_FILE)).unwrap();
        let result = ensure_mitm_certs_in_dir(dir.clone(), false, |_| {
            panic!("链校验失败不得触发自动轮换");
        });
        assert!(result.unwrap_err().contains("未自动替换证书"));
        assert_eq!(std::fs::read(dir.join("server.codeium.com.pem")).unwrap(), ca_before);
        assert_eq!(std::fs::read(dir.join(MITM_LEAF_CERT_FILE)).unwrap(), leaf_before);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 注入写后报错，覆盖失败目标也须恢复、原本不存在的文件须移除；不接触真实证书库。
    #[test]
    fn package_commit_restores_existing_and_absent_files() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-rollback-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        for failure in 0..3 {
            write_atomic(&dir.join("old"), b"original").unwrap();
            let mut calls = 0;
            let result = commit_mitm_package(&dir, &["old", "new", "last"],
                &[b"changed".to_vec(), b"new".to_vec(), b"last".to_vec()], |path, bytes| {
                    write_atomic(path, bytes)?;
                    let fail = calls == failure;
                    calls += 1;
                    if fail { Err("injected commit failure".into()) } else { Ok(()) }
                });
            assert!(result.unwrap_err().contains("已恢复原包"));
            assert_eq!(std::fs::read(dir.join("old")).unwrap(), b"original");
            assert!(!dir.join("new").exists());
            assert!(!dir.join("last").exists());
        }
        let result = commit_mitm_package(&dir, &["old"], &[b"changed".to_vec()], |_, _| {
            Err("injected persistent failure".into())
        });
        assert!(result.unwrap_err().contains("当前状态不确定"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn candidate_bundle_commits_and_is_cleaned_up() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-candidate-{}-{stamp}", std::process::id()));
        let result = ensure_mitm_certs_in_dir(dir.clone(), true, write_mitm_cert_bundle);
        assert!(result.unwrap().1);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 5);
        assert!(!ensure_mitm_certs_in_dir(dir.clone(), false, |_| {
            panic!("有效证书包应该复用");
        }).unwrap().1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 候选目录可能对应仍在运行的其他生成任务；只读校验保留目录并拒绝并行复用。
    #[test]
    fn candidate_directory_blocks_background_validation_without_cleanup() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let candidate = dir.join(".candidate-123-456");
        std::fs::create_dir(&candidate).unwrap();
        std::fs::write(candidate.join("server.codeium.com-key.pem"), b"private-key-fragment").unwrap();

        let result = validate_existing_mitm_package_in_dir(dir.clone());
        let blocked = result.is_err_and(|error| error.contains("候选证书目录"));
        let preserved = std::fs::read(candidate.join("server.codeium.com-key.pem"))
            .is_ok_and(|bytes| bytes == b"private-key-fragment");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(blocked, "残留候选目录必须阻止后台复用");
        assert!(preserved, "只读检查不得删除候选私钥片段");
    }

    // 候选目录存在时，显式生成也必须停止，避免在不确定包状态上继续轮换。
    #[test]
    fn candidate_directory_blocks_generation_without_cleanup() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let candidate = dir.join(".candidate-123-456");
        std::fs::create_dir(&candidate).unwrap();
        std::fs::write(candidate.join("server.codeium.com-key.pem"), b"private-key-fragment").unwrap();

        let result = ensure_mitm_certs_in_dir(dir.clone(), true, |_| {
            panic!("候选目录存在时不能调用生成器");
        });
        let blocked = result.is_err_and(|error| error.contains("候选证书目录"));
        let preserved = std::fs::read(candidate.join("server.codeium.com-key.pem"))
            .is_ok_and(|bytes| bytes == b"private-key-fragment");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(blocked, "候选目录必须阻止新生成");
        assert!(preserved, "拒绝生成时不得删除候选内容");
    }

    // 空目录应只返回错误且保持为空，避免后台校验退化为隐式生成。
    #[test]
    fn background_package_validation_never_generates_or_changes_files() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let result = validate_existing_mitm_package_in_dir(dir.clone());
        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 仅在临时目录生成测试证书；不访问系统信任库或真实用户配置。
    #[test]
    fn background_package_validation_accepts_only_a_current_complete_bundle() {
        let dir = unique_temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        write_mitm_cert_bundle(&dir).unwrap();
        assert_eq!(validate_existing_mitm_package_in_dir(dir.clone()).unwrap(), dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // SAN 版本过旧时后台只能拒绝；不能趁校验失败悄悄轮换当前受信任的 CA。
    #[test]
    fn stale_san_marker_is_rejected_without_changing_the_package() {
        let dir = unique_temp_dir();
        std::fs::create_dir(&dir).unwrap();
        write_mitm_cert_bundle(&dir).unwrap();
        std::fs::write(dir.join("san-version"), "stale").unwrap();
        let names = [
            "server.codeium.com.pem",
            "server.codeium.com-key.pem",
            MITM_LEAF_CERT_FILE,
            MITM_LEAF_KEY_FILE,
            "san-version",
        ];
        let before = names
            .iter()
            .map(|name| (*name, std::fs::read(dir.join(name)).unwrap()))
            .collect::<Vec<_>>();

        let result = validate_existing_mitm_package_in_dir(dir.clone());
        let after = names
            .iter()
            .map(|name| std::fs::read(dir.join(name)).map(|bytes| (*name, bytes)))
            .collect::<Result<Vec<_>, _>>();
        std::fs::remove_dir_all(&dir).unwrap();

        assert!(result.unwrap_err().contains("SAN 版本过期"));
        assert_eq!(after.unwrap(), before);
    }

    #[test]
    fn freshly_generated_certs_do_not_need_renewal() {
        let dir = unique_temp_dir();
        std::fs::create_dir(&dir).unwrap();
        write_mitm_cert_bundle_for_test(&dir).unwrap();
        let needs_renewal = mitm_certs_need_renewal(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            !needs_renewal,
            "刚生成的证书不能被判定为需要换新，否则每次启动都会重装信任库"
        );
    }

    #[test]
    fn mitm_cert_validity_stays_within_the_825_day_client_limit() {
        // Apple / Chromium 硬性要求 TLS 服务器证书有效期 ≤ 825 天，超了会被判
        // bad certificate（TLS alert 42）。rcgen 默认给的是 1975→4096（2121 年）。
        let validity_days = (MITM_CERT_NOT_AFTER_DAYS - MITM_CERT_NOT_BEFORE_DAYS) as i64;
        assert!(
            validity_days > 0 && validity_days <= 825,
            "证书有效期必须在 825 天以内，当前 {validity_days} 天",
        );
    }
}
