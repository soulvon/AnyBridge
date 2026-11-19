use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_settings_path(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir()
        .join(format!(
            "anybridge-ide-config-{}-{}-{}",
            std::process::id(),
            unique,
            name
        ))
        .join("Cursor")
        .join("User")
        .join("settings.json")
}

fn read_settings(path: &PathBuf) -> Map<String, Value> {
    let raw = fs::read_to_string(path).unwrap();
    parse_object(&raw).unwrap()
}

#[test]
fn cursor_patch_and_restore_preserve_user_settings() {
    let settings = temp_settings_path("patch-restore");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        r#"{
            "editor.fontSize": 14,
            "http.proxy": "https://corp-proxy.example:8443",
            "http.proxyStrictSSL": true,
            "http.proxySupport": "off",
            "http.experimental.systemCertificatesV2": false,
            "cursor.general.useHttp1": false,
            "cursor.general.disableHttp2": false,
            "http.proxyKerberosServicePrincipal": "https://corp-proxy.example:8443",
            "systemCertificatesV2": true,
            "useHttp1": true,
            "disableHttp2": true
        }"#,
    )
    .unwrap();

    assert_eq!(patch_settings_file("cursor", &settings).unwrap(), true);
    let patched = read_settings(&settings);
    assert_eq!(patched.get("editor.fontSize"), Some(&Value::from(14)));
    assert!(patched
        .get(PROXY_KEY)
        .and_then(|v| v.as_str())
        .map(is_current_proxy_value)
        .unwrap_or(false));
    assert_eq!(patched.get(STRICT_SSL_KEY), Some(&Value::Bool(false)));
    // 必须 override：on 会让系统代理抢在 http.proxy 前面（坑点 cursor-proxy-support-override）
    assert_eq!(
        patched.get(PROXY_SUPPORT_KEY),
        Some(&Value::String("override".into()))
    );
    assert!(cursor_extra_settings_ok(&patched));

    let mut current = patched.clone();
    current.insert("window.zoomLevel".into(), Value::from(1));
    write_object(&settings, &current).unwrap();

    assert_eq!(restore_settings_file("cursor", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert_eq!(restored.get("editor.fontSize"), Some(&Value::from(14)));
    assert_eq!(
        restored.get(PROXY_KEY),
        Some(&Value::String("https://corp-proxy.example:8443".into()))
    );
    assert_eq!(restored.get(STRICT_SSL_KEY), Some(&Value::Bool(true)));
    assert_eq!(
        restored.get(PROXY_SUPPORT_KEY),
        Some(&Value::String("off".into()))
    );
    assert_eq!(restored.get(SYSTEM_CERTS_V2_KEY), Some(&Value::Bool(false)));
    assert_eq!(restored.get(USE_HTTP1_KEY), Some(&Value::Bool(false)));
    assert_eq!(restored.get(DISABLE_HTTP2_KEY), Some(&Value::Bool(false)));
    assert_eq!(
        restored.get(PROXY_KERBEROS_KEY),
        Some(&Value::String("https://corp-proxy.example:8443".into()))
    );
    for key in LEGACY_CURSOR_PROXY_KEYS {
        assert!(
            restored.get(*key).is_none(),
            "expected legacy {} to be removed",
            key
        );
    }
    assert_eq!(restored.get("window.zoomLevel"), Some(&Value::from(1)));
    assert!(!backup_path(&settings).exists());

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn cursor_restore_without_backup_removes_anybridge_proxy_keys() {
    let settings = temp_settings_path("restore-without-backup");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        format!(
            r#"{{
                "editor.fontSize": 13,
                "http.proxy": "{}",
                "http.proxyStrictSSL": false,
                "http.proxySupport": "on",
                "http.experimental.systemCertificatesV2": true,
                "cursor.general.useHttp1": true,
                "cursor.general.disableHttp2": true,
                "http.proxyKerberosServicePrincipal": "{}",
                "systemCertificatesV2": true,
                "useHttp1": true,
                "disableHttp2": true
            }}"#,
            current_proxy_value(),
            current_proxy_value()
        ),
    )
    .unwrap();

    assert_eq!(restore_settings_file("cursor", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert_eq!(restored.get("editor.fontSize"), Some(&Value::from(13)));
    for key in managed_proxy_keys("cursor") {
        assert!(
            restored.get(key).is_none(),
            "expected {} to be removed",
            key
        );
    }
    for key in LEGACY_CURSOR_PROXY_KEYS {
        assert!(
            restored.get(*key).is_none(),
            "expected legacy {} to be removed",
            key
        );
    }

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn cursor_restore_with_existing_backup_removes_legacy_proxy_keys() {
    let settings = temp_settings_path("restore-existing-backup");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        backup_path(&settings),
        r#"{
            "editor.fontSize": 15,
            "http.proxy": "https://corp-proxy.example:8080",
            "http.proxyStrictSSL": true
        }"#,
    )
    .unwrap();
    fs::write(
        &settings,
        format!(
            r#"{{
                "editor.fontSize": 15,
                "http.proxy": "{}",
                "http.proxyStrictSSL": false,
                "http.proxySupport": "on",
                "http.experimental.systemCertificatesV2": true,
                "cursor.general.useHttp1": true,
                "cursor.general.disableHttp2": true,
                "http.proxyKerberosServicePrincipal": "{}",
                "systemCertificatesV2": true,
                "useHttp1": true,
                "disableHttp2": true,
                "window.zoomLevel": 2
            }}"#,
            current_proxy_value(),
            current_proxy_value()
        ),
    )
    .unwrap();

    assert_eq!(restore_settings_file("cursor", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert_eq!(
        restored.get(PROXY_KEY),
        Some(&Value::String("https://corp-proxy.example:8080".into()))
    );
    assert_eq!(restored.get(STRICT_SSL_KEY), Some(&Value::Bool(true)));
    assert!(restored.get(PROXY_SUPPORT_KEY).is_none());
    assert!(restored.get(SYSTEM_CERTS_V2_KEY).is_none());
    assert!(restored.get(USE_HTTP1_KEY).is_none());
    assert!(restored.get(DISABLE_HTTP2_KEY).is_none());
    assert!(restored.get(PROXY_KERBEROS_KEY).is_none());
    for key in LEGACY_CURSOR_PROXY_KEYS {
        assert!(
            restored.get(*key).is_none(),
            "expected legacy {} to be removed",
            key
        );
    }
    assert_eq!(restored.get("window.zoomLevel"), Some(&Value::from(2)));

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn devin_patch_and_restore_compatible_with_old_and_new() {
    let settings = temp_settings_path("devin-compat");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        r#"{
            "editor.fontSize": 14,
            "devin.acp.agentPreferences": {
                "devin-cli": { "model": "swe-1-6-slow" }
            },
            "devin.acp.enabledAgents": {
                "devin-cli": true
            }
        }"#,
    )
    .unwrap();

    assert_eq!(patch_settings_file("devin", &settings).unwrap(), true);
    let patched = read_settings(&settings);
    assert_eq!(patched.get("editor.fontSize"), Some(&Value::from(14)));
    // 兼容旧版：http.proxy 正常写入
    assert!(patched
        .get(PROXY_KEY)
        .and_then(|v| v.as_str())
        .map(is_current_proxy_value)
        .unwrap_or(false));
    assert_eq!(patched.get(STRICT_SSL_KEY), Some(&Value::Bool(false)));
    assert_eq!(
        patched.get(PROXY_SUPPORT_KEY),
        Some(&Value::String(PROXY_SUPPORT_OVERRIDE_VALUE.into()))
    );

    // 兼容新版：devin.acp.agentEnv 注入 devin-cli
    assert!(devin_agent_env_ok(&patched));
    let agent_env = patched.get(DEVIN_AGENT_ENV_KEY).and_then(|v| v.as_object()).unwrap();
    let cli_env = agent_env.get("devin-cli").and_then(|v| v.as_object()).unwrap();
    assert!(cli_env.get("HTTP_PROXY").and_then(|v| v.as_str()).map(is_current_proxy_value).unwrap_or(false));
    assert!(cli_env.get("HTTPS_PROXY").and_then(|v| v.as_str()).map(is_current_proxy_value).unwrap_or(false));
    assert_eq!(
        cli_env.get("NO_PROXY"),
        Some(&Value::String(DEVIN_AGENT_NO_PROXY.into()))
    );
    assert_eq!(
        cli_env.get("SSL_CERT_FILE"),
        Some(&Value::String(devin_cert_path().to_string_lossy().to_string()))
    );
    assert_eq!(cli_env.get("WINDSURF_API_SERVER_URL"), Some(&Value::String("https://server.codeium.com".into())));

    // 用户原有配置未被破坏
    assert!(patched.get("devin.acp.agentPreferences").is_some());

    // 还原
    assert_eq!(restore_settings_file("devin", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert!(restored.get(PROXY_KEY).is_none());
    assert!(restored.get(STRICT_SSL_KEY).is_none());
    assert!(restored.get(PROXY_SUPPORT_KEY).is_none());
    assert!(restored.get(DEVIN_AGENT_ENV_KEY).is_none());
    assert!(restored.get(WINDSURF_AGENT_ENV_KEY).is_none());
    assert_eq!(restored.get("editor.fontSize"), Some(&Value::from(14)));
    assert!(restored.get("devin.acp.agentPreferences").is_some());

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn devin_patch_and_restore_preserves_user_proxy_support() {
    let settings = temp_settings_path("devin-preserve-proxy-support");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        r#"{
            "editor.fontSize": 15,
            "http.proxySupport": "off"
        }"#,
    )
    .unwrap();

    assert_eq!(patch_settings_file("devin", &settings).unwrap(), true);
    let patched = read_settings(&settings);
    assert_eq!(
        patched.get(PROXY_SUPPORT_KEY),
        Some(&Value::String(PROXY_SUPPORT_OVERRIDE_VALUE.into()))
    );

    assert_eq!(restore_settings_file("devin", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert_eq!(
        restored.get(PROXY_SUPPORT_KEY),
        Some(&Value::String("off".into()))
    );
    assert_eq!(restored.get("editor.fontSize"), Some(&Value::from(15)));

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn devin_restore_without_backup_removes_override_proxy_support() {
    let settings = temp_settings_path("devin-restore-no-backup");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let proxy = current_proxy_value();
    let cert = devin_cert_path().to_string_lossy().to_string();
    fs::write(
        &settings,
        serde_json::json!({
            "editor.fontSize": 14,
            "http.proxy": proxy,
            "http.proxyStrictSSL": false,
            "http.proxySupport": "override",
            "devin.acp.preferredAgent": "devin-cli",
            "devin.acp.agentEnv": {
                "devin-cli": {
                    "HTTP_PROXY": current_proxy_value(),
                    "HTTPS_PROXY": current_proxy_value(),
                    "NO_PROXY": DEVIN_AGENT_NO_PROXY,
                    "SSL_CERT_FILE": cert,
                    "WINDSURF_API_SERVER_URL": "https://server.codeium.com"
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    assert_eq!(restore_settings_file("devin", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert!(restored.get(PROXY_KEY).is_none());
    assert!(restored.get(STRICT_SSL_KEY).is_none());
    assert!(restored.get(PROXY_SUPPORT_KEY).is_none());
    assert!(restored.get(DEVIN_AGENT_ENV_KEY).is_none());
    assert_eq!(restored.get("editor.fontSize"), Some(&Value::from(14)));

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn devin_cli_config_patch_and_restore_preserves_other_fields() {
    let root = temp_settings_path("devin-cli-cfg")
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let cli_cfg = root.join("devin").join("config.json");
    fs::create_dir_all(cli_cfg.parent().unwrap()).unwrap();
    fs::write(
        &cli_cfg,
        r#"{
            "version": 1,
            "agent": { "model": "swe-1-6-slow" }
        }"#,
    )
    .unwrap();

    assert_eq!(patch_devin_cli_config_file(&cli_cfg).unwrap(), true);
    let patched = read_settings(&cli_cfg);
    assert_eq!(
        patched.get("process_model"),
        Some(&Value::String("in-process".into()))
    );
    assert_eq!(patched.get("version"), Some(&Value::from(1)));

    // 模拟接入期间用户在 Devin CLI 里修改了其他配置，还原不得覆盖
    let mut with_user_edit = patched.clone();
    with_user_edit.insert("theme_mode".into(), Value::String("dark".into()));
    write_object(&cli_cfg, &with_user_edit).unwrap();

    assert_eq!(restore_devin_cli_config_file(&cli_cfg).unwrap(), true);
    let restored = read_settings(&cli_cfg);
    assert!(restored.get("process_model").is_none());
    assert_eq!(
        restored.get("theme_mode"),
        Some(&Value::String("dark".into()))
    );
    assert_eq!(restored.get("version"), Some(&Value::from(1)));
    assert!(!backup_path(&cli_cfg).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn devin_cli_config_restores_prior_daemon_and_keeps_preexisting_in_process() {
    let root = temp_settings_path("devin-cli-prior")
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let cli_cfg = root.join("devin").join("config.json");
    fs::create_dir_all(cli_cfg.parent().unwrap()).unwrap();

    // 情况 1：用户原本设了 "daemon" → 接入改 "in-process"，还原回 "daemon"
    fs::write(&cli_cfg, r#"{ "process_model": "daemon" }"#).unwrap();
    assert_eq!(patch_devin_cli_config_file(&cli_cfg).unwrap(), true);
    assert_eq!(
        read_settings(&cli_cfg).get("process_model"),
        Some(&Value::String("in-process".into()))
    );
    assert_eq!(restore_devin_cli_config_file(&cli_cfg).unwrap(), true);
    assert_eq!(
        read_settings(&cli_cfg).get("process_model"),
        Some(&Value::String("daemon".into()))
    );

    // 情况 2：用户原本就是 "in-process" → 不建假备份，还原也不删用户的设置
    fs::write(&cli_cfg, r#"{ "process_model": "in-process" }"#).unwrap();
    assert_eq!(patch_devin_cli_config_file(&cli_cfg).unwrap(), false);
    assert!(!backup_path(&cli_cfg).exists());
    assert_eq!(restore_devin_cli_config_file(&cli_cfg).unwrap(), false);
    assert_eq!(
        read_settings(&cli_cfg).get("process_model"),
        Some(&Value::String("in-process".into()))
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn devin_upgrade_from_legacy_patch_without_backup_restores_cleanly() {
    let settings = temp_settings_path("devin-upgrade-no-backup");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let proxy = current_proxy_value();
    let cert = devin_cert_path().to_string_lossy().to_string();
    // 模拟旧版 AnyBridge 已打补丁但无 .byok-bak、且缺少 http.proxySupport: "override" 的情况
    fs::write(
        &settings,
        serde_json::json!({
            "editor.fontSize": 14,
            "http.proxy": proxy,
            "http.proxyStrictSSL": false,
            "devin.acp.preferredAgent": "devin-cli",
            "devin.acp.agentEnv": {
                "devin-cli": {
                    "HTTP_PROXY": current_proxy_value(),
                    "HTTPS_PROXY": current_proxy_value(),
                    "NO_PROXY": DEVIN_AGENT_NO_PROXY,
                    "SSL_CERT_FILE": cert,
                    "WINDSURF_API_SERVER_URL": "https://server.codeium.com"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    assert!(!backup_path(&settings).exists());

    // 升级补丁应补齐 override 且补建去除了网关字段的备份，而不是把旧网关地址写进备份
    assert_eq!(patch_settings_file("devin", &settings).unwrap(), true);
    let upgraded = read_settings(&settings);
    assert_eq!(
        upgraded.get(PROXY_SUPPORT_KEY),
        Some(&Value::String(PROXY_SUPPORT_OVERRIDE_VALUE.into()))
    );

    assert_eq!(restore_settings_file("devin", &settings).unwrap(), true);
    let restored = read_settings(&settings);
    assert!(restored.get(PROXY_KEY).is_none());
    assert!(restored.get(STRICT_SSL_KEY).is_none());
    assert!(restored.get(PROXY_SUPPORT_KEY).is_none());
    assert!(restored.get(DEVIN_AGENT_ENV_KEY).is_none());
    assert!(restored.get(WINDSURF_AGENT_ENV_KEY).is_none());
    assert_eq!(restored.get("editor.fontSize"), Some(&Value::from(14)));

    let _ = fs::remove_dir_all(
        settings
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );
}

#[test]
fn devin_cli_config_invalid_json_reports_devin_config_label() {
    let root = temp_settings_path("devin-cli-bad-json")
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let cli_cfg = root.join("devin").join("config.json");
    fs::create_dir_all(cli_cfg.parent().unwrap()).unwrap();
    fs::write(&cli_cfg, "{ invalid json ::: ").unwrap();

    let err = patch_devin_cli_config_file(&cli_cfg).unwrap_err();
    assert!(
        err.contains("devin config.json"),
        "expected error to mention devin config.json, got: {err}"
    );
    assert!(
        !err.contains("settings.json"),
        "error must not misreport settings.json: {err}"
    );

    let _ = fs::remove_dir_all(root);
}
