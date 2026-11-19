use super::*;
use super::service_and_cmds::stop_managed_proxy;
use std::sync::{atomic::Ordering, Mutex};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// 不使用 sleep，验证已过截止时间立即失败，避免依赖调度速度的测试。
#[test]
fn probe_deadline_rejects_expired_budget() {
    let expired = std::time::Instant::now();
    assert_eq!(super::probe_time_remaining(expired).unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    let future = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let remaining = super::probe_time_remaining(future).unwrap();
    assert!(remaining > std::time::Duration::ZERO);
    assert!(remaining <= std::time::Duration::from_secs(60));
}

// 端口探测必须反映真实监听状态：用于判定「网关服务是否可直接复用」，
// 探错会导致把正在供流的 sidecar 误杀重启（或反之漏启动）。
#[test]
fn proxy_port_probe_reflects_listener_state() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(super::proxy_port_listening(port), "监听中的端口应探测为可达");
    drop(listener);
    let mut released = false;
    for _ in 0..50 {
        if !super::proxy_port_listening(port) {
            released = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(released, "端口已释放，探测仍返回可达（判据把历史状态当现状）");
}

// 使用内存分段模拟 TCP 分包，确保头后的 TLS 字节仍留给握手层。
#[test]
fn connect_header_handles_fragments_and_rejects_invalid_responses() {
    use std::io::Read;
    let mut input = (&b"HTTP/1.1 2"[..]).chain(&b"00 OK\r\nX: test\r\n\r\nTLS"[..]);
    assert!(super::read_connect_response(&mut input).is_ok());
    let mut remaining = String::new();
    input.read_to_string(&mut remaining).unwrap();
    assert_eq!(remaining, "TLS");
    for response in ["HTTP/1.1 2000 Bad\r\n\r\n", "HTTP/1.1 407 Auth\r\n\r\n", "HTTP/1.1 200 OK\r\n"] {
        assert!(super::read_connect_response(&mut response.as_bytes()).is_err());
    }
    assert!(super::read_connect_response(&mut vec![b'x'; 8193].as_slice()).is_err());
}

// 仅验证指纹比较，不模拟 TLS 链验证或访问系统证书库。
#[test]
fn runtime_leaf_must_match_disk_leaf() {
    assert!(super::verify_runtime_leaf(b"same DER", b"same DER").is_ok());
    assert!(super::verify_runtime_leaf(b"old DER", b"new DER")
        .unwrap_err().contains("指纹不一致"));
}

// 即使断言失败也尝试结束测试子进程；这些测试不启动实际 sidecar 或修改信任库。
struct TestProxy(ProxyState);

impl Drop for TestProxy {
    fn drop(&mut self) {
        if let Some(child) = lock_or_recover(&self.0.child).take() {
            let _ = child.kill();
        }
    }
}

#[test]
fn proxy_stop_checks_process_identity_and_waits_before_releasing_state() {
    let proxy = TestProxy(ProxyState::default());
    #[cfg(target_os = "windows")]
    let child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
        .creation_flags(super::CREATE_NO_WINDOW)
        .spawn()
        .expect("spawn test process");
    #[cfg(not(target_os = "windows"))]
    let child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .expect("spawn test process");
    let pid = child.id();
    *lock_or_recover(&proxy.0.child) = Some(ManagedChild {
        child: Mutex::new(child),
        _package_lock: None,
    });
    assert!(with_proxy_stopped_state(&proxy.0, || Ok(())).is_err());
    assert!(stop_managed_proxy(&proxy.0, Some(pid.wrapping_add(1))).is_err());
    assert!(lock_or_recover(&proxy.0.child).as_ref().unwrap().try_wait().unwrap().is_none());
    assert_eq!(
        stop_managed_proxy(&proxy.0, Some(pid)).unwrap(),
        StopStatus::Stopped
    );
    assert!(lock_or_recover(&proxy.0.child).is_none());
    assert_eq!(with_proxy_stopped_state(&proxy.0, || Ok(42)).unwrap(), 42);
    assert_eq!(
        stop_managed_proxy(&proxy.0, Some(pid)).unwrap(),
        StopStatus::NotRunning
    );
}

// 未确认退出只能如实报告 pid 与等待时长，不得出现「已停止」这类成功措辞。
#[test]
fn unconfirmed_stop_reports_pid_without_claiming_success() {
    let hint = unconfirmed_stop_hint(4321, 2000);
    assert!(hint.contains("4321"));
    assert!(hint.contains("2000"));
    assert!(!hint.contains("已停止"));
}

#[cfg(unix)]
#[test]
fn managed_proxy_holds_package_lock_until_confirmed_exit() {
    let root = std::env::temp_dir().join(format!(
        "anybridge-proxy-lock-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let certs_dir = root.join("certs");
    std::fs::create_dir_all(&certs_dir).unwrap();
    let package_lock = crate::commands::system::acquire_mitm_package_lock(&certs_dir, false)
        .unwrap();
    let proxy = TestProxy(ProxyState::default());
    let child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .expect("spawn test process");
    let pid = child.id();
    *lock_or_recover(&proxy.0.child) = Some(ManagedChild {
        child: Mutex::new(child),
        _package_lock: package_lock,
    });

    assert!(crate::commands::system::acquire_mitm_package_lock(&certs_dir, true).is_err());
    assert_eq!(
        stop_managed_proxy(&proxy.0, Some(pid)).unwrap(),
        StopStatus::Stopped
    );
    let write_lock = crate::commands::system::acquire_mitm_package_lock(&certs_dir, true);
    assert!(write_lock.is_ok(), "confirmed child exit must release the shared package lock");
    drop(write_lock);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn stopped_proxy_reserves_startup_until_certificate_task_returns() {
    let state = ProxyState::default();
    let result: Result<(), String> = with_proxy_stopped_state(&state, || {
        assert!(state.starting.load(Ordering::SeqCst));
        assert!(with_proxy_stopped_state(&state, || Ok(())).is_err());
        assert!(state.starting.load(Ordering::SeqCst));
        Err("certificate task failed".into())
    });
    assert_eq!(result.unwrap_err(), "certificate task failed");
    assert!(!state.starting.load(Ordering::SeqCst));
    assert_eq!(with_proxy_stopped_state(&state, || Ok(42)).unwrap(), 42);
    assert!(!state.starting.load(Ordering::SeqCst));
}

// 模拟 spawn 后占位已释放的前提，只验证再次占位；不替代完整启动/重试集成测试。
#[test]
fn runtime_repair_reacquires_released_startup_reservation() {
    let state = ProxyState::default();
    state.starting.store(true, Ordering::SeqCst);
    state.starting.store(false, Ordering::SeqCst);
    assert_eq!(with_proxy_stopped_state(&state, || {
        assert!(state.starting.load(Ordering::SeqCst));
        assert!(with_proxy_stopped_state(&state, || Ok(())).is_err());
        Ok(42)
    }).unwrap(), 42);
    assert!(!state.starting.load(Ordering::SeqCst));
}

#[test]
fn busy_proxy_does_not_execute_certificate_task_or_release_owner_flag() {
    let state = ProxyState::default();
    state.starting.store(true, Ordering::SeqCst);
    let result = with_proxy_stopped_state(&state, || -> Result<(), String> {
        panic!("certificate task must not execute while startup is reserved")
    });
    assert!(result.is_err());
    assert!(state.starting.load(Ordering::SeqCst));
}

#[test]
fn panicking_certificate_task_releases_startup_reservation() {
    let state = ProxyState::default();
    let result = std::panic::catch_unwind(|| {
        let _ = with_proxy_stopped_state(&state, || -> Result<(), String> {
            panic!("certificate task panicked")
        });
    });
    assert!(result.is_err());
    assert!(!state.starting.load(Ordering::SeqCst));
}

// 只读体检不得修复任何东西；IDE 配置修复不得触碰证书；只有显式体检允许动证书包。
#[test]
fn repair_scope_separates_config_from_certificate_mutations() {
    let read_only = RepairScope::ReadOnly;
    assert!(!read_only.repairs_config());
    assert!(!read_only.repairs_certificate());

    let ide_config = RepairScope::IdeConfig;
    assert!(ide_config.repairs_config());
    assert!(!ide_config.repairs_certificate());

    let certificate = RepairScope::Certificate;
    assert!(certificate.repairs_config());
    assert!(certificate.repairs_certificate());
}

#[test]
fn recent_tls_rejection_is_independent_and_expires() {
    let now = 2_000_000;
    let issue = super::recent_tls_rejection_issue(now, now - 60_000).unwrap();
    assert_eq!(issue.code, "cert.tls_client_rejection_recent");
    assert_eq!(issue.level, "err");
    assert!(issue.message.contains("客户端身份未知"));
    assert!(super::recent_tls_rejection_issue(now, now - 30 * 60 * 1000 - 1).is_none());
    assert!(super::recent_tls_rejection_issue(now, now + 1).is_none());
    assert!(super::recent_tls_rejection_issue(now, 0).is_none());
}

// 哨兵事件是 sidecar 与桌面之间的隐式契约；改名不同步必须立刻在日志里暴露，不能静默失效。
#[test]
fn sidecar_event_lines_are_classified_and_unknown_events_are_reported() {
    let rejected = sidecar_log_line("ANYBRIDGE_EVENT:TLS_CLIENT_CERT_REJECTED");
    assert_eq!(rejected.level, "err");
    assert!(rejected.msg.contains("TLS 客户端拒绝"));

    let unknown = sidecar_log_line("ANYBRIDGE_EVENT:SOMETHING_NEW");
    assert_eq!(unknown.level, "warn");
    assert!(unknown.msg.contains("SOMETHING_NEW"));
    assert!(unknown.msg.contains("未生效"));

    let plain = sidecar_log_line("request → upstream");
    assert_eq!(plain.level, "ok");
    assert_eq!(plain.msg, "request → upstream");
}

#[test]
fn certificate_failures_are_not_successful_routes() {
    assert_eq!(classify("MITM TLS error: alert bad certificate"), "err");
    assert_eq!(classify("客户端拒绝了 MITM 证书 → 请检查信任"), "err");
    assert_eq!(classify("CONNECT error → upstream: closed"), "err");
    assert_eq!(classify("request → upstream"), "ok");
    assert_eq!(classify("errors=0"), "info");
}
