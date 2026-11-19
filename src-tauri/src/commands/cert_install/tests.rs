use super::*;
use super::platform_unix::macos_trust_error;

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
