use super::*;

use std::collections::BTreeSet;

/// 回归：Claude 必须用自己的配置 key / 文件名 / 目录名。
/// 落到默认分支会读到 Windsurf 的缓存路径，重启 Claude 时误杀 Windsurf（实测事故）。
#[cfg(target_os = "windows")]
#[test]
fn claude_never_falls_back_to_windsurf() {
    for target in ["claude-desktop", "claude"] {
        assert_eq!(ide_exe_key(target), CLAUDE_EXE_KEY, "{target} 必须用独立 key");
        assert_ne!(ide_exe_key(target), IDE_EXE_KEY, "{target} 不得落到 Windsurf key");
        assert_eq!(ide_exe_filename(target), "Claude.exe");
        assert_eq!(ide_dir_name(target), "Claude");
    }
}

/// 回归：各平台的 key 必须互不相同，避免互相读到对方的缓存路径。
#[cfg(target_os = "windows")]
#[test]
fn ide_keys_are_distinct_per_target() {
    let keys = [
        ide_exe_key("windsurf"),
        ide_exe_key("devin"),
        ide_exe_key("cursor"),
        ide_exe_key("antigravity"),
        ide_exe_key("antigravity-ide"),
        ide_exe_key("claude-desktop"),
    ];
    let unique: BTreeSet<&str> = keys.iter().copied().collect();
    assert_eq!(unique.len(), keys.len(), "各平台 key 必须互不相同: {keys:?}");
}

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

#[test]
fn bundled_devin_cli_path_points_to_windsurf_devin_bin() {
    #[cfg(target_os = "windows")]
    {
        let exe = std::path::Path::new(r"C:\Program Files\Devin\Devin.exe");
        let cli = bundled_devin_cli_path(exe).unwrap();
        assert_eq!(
            cli,
            std::path::PathBuf::from(
                r"C:\Program Files\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe"
            )
        );
    }
    #[cfg(target_os = "macos")]
    {
        let app = std::path::Path::new("/Applications/Devin.app");
        let cli = bundled_devin_cli_path(app).unwrap();
        assert_eq!(
            cli,
            std::path::PathBuf::from(
                "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"
            )
        );
    }
    #[cfg(target_os = "linux")]
    {
        let bin = std::path::Path::new("/opt/devin/devin");
        let cli = bundled_devin_cli_path(bin).unwrap();
        assert_eq!(
            cli,
            std::path::PathBuf::from(
                "/opt/devin/resources/app/extensions/windsurf/devin/bin/devin"
            )
        );
    }
}

#[test]
fn run_command_with_timeout_kills_slow_process_within_budget() {
    let start = std::time::Instant::now();
    #[cfg(target_os = "windows")]
    let mut slow_cmd = {
        let mut c = std::process::Command::new("ping");
        c.args(["-n", "10", "127.0.0.1"]).hide_window();
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut slow_cmd = {
        let mut c = std::process::Command::new("sleep");
        c.arg("10");
        c
    };
    let finished = run_command_with_timeout(&mut slow_cmd, std::time::Duration::from_millis(250));
    let elapsed = start.elapsed();
    assert!(!finished, "slow process should time out and be killed");
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "timeout cleanup took too long: {elapsed:?}"
    );

    #[cfg(target_os = "windows")]
    let mut fast_cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "exit", "0"]).hide_window();
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut fast_cmd = std::process::Command::new("true");
    assert!(
        run_command_with_timeout(&mut fast_cmd, std::time::Duration::from_secs(2)),
        "fast process should finish within timeout"
    );
}

#[test]
fn antigravity_ide_restart_args_preserve_or_enable_cdp_port() {
    // 1. 汉化已开启且未传 extra_args：重启必须自动附带调试端口，防止设置页与 Agent 面板退回全英文
    assert_eq!(
        super::restart::merge_antigravity_ide_cdp_args(&[], true, None, 9444),
        vec!["--remote-debugging-port=9444".to_string()]
    );
    // 2. 汉化未开启但重启前已带 CDP 端口（如用户快捷方式/Kite 开启）：必须保留原端口
    assert_eq!(
        super::restart::merge_antigravity_ide_cdp_args(&[], false, Some(9333), 9444),
        vec!["--remote-debugging-port=9333".to_string()]
    );
    // 3. 汉化未开启且原本未开 CDP：不强加调试端口
    assert!(
        super::restart::merge_antigravity_ide_cdp_args(&[], false, None, 9333).is_empty()
    );
    // 4. 调用方已显式传入 --remote-debugging-port 时不重复追加
    let explicit = vec!["--remote-debugging-port=9555".to_string()];
    assert_eq!(
        super::restart::merge_antigravity_ide_cdp_args(&explicit, true, Some(9333), 9444),
        explicit
    );
}

#[test]
fn restart_cdp_command_uses_preferred_launch_port_helper() {
    assert_eq!(
        super::restart::build_cdp_restart_args(9444),
        vec!["--remote-debugging-port=9444".to_string()]
    );
    let src = include_str!("restart.rs");
    assert!(
        !src.contains("let port = crate::commands::antigravity_cdp::CDP_PORT;"),
        "restart_antigravity_ide_with_cdp 不得写死 CDP_PORT，应走 preferred_launch_port()"
    );
}
