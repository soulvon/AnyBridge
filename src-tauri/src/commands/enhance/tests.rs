use super::*;
use super::cdp_themes::{
    build_cdp_theme_install_args, build_cdp_theme_status_with_roots, conflict_peer_ids,
    find_cdp_theme_spec, node_meets_min, parse_node_version_output, CHUANBAN_THEME_ID,
    CODEX_THEME_ID,
};
use super::conflicts::{all_conflict_pairs_for_test, apply_conflict_matrix, ConflictLevel};
use super::github_detail::{
    build_raw_base_url, detect_image_mime, extract_markdown_article, extract_page_meta,
    html_has_significant_chinese, is_allowed_enhance_image_url, is_allowed_enhance_repo,
    LOC_UPSTREAM_REPO,
};
use super::native_plugins::{
    build_native_plugin_status_with_root, find_native_plugin_spec, plugin_config_file_under,
    plugin_dir_under, set_plugin_registration_in_config, should_keep_native_plugin_entry,
    USAGE_MONITOR_ID,
};
use crate::commands::antigravity_localization::asar_padding_len;

fn build_test_asar(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut payload = Vec::new();
    let mut root_files = serde_json::Map::new();
    let mut dist_files = serde_json::Map::new();

    for (rel, body) in entries {
        let offset = payload.len();
        payload.extend_from_slice(body.as_bytes());
        let node = serde_json::json!({
            "size": body.len(),
            "offset": offset.to_string(),
            "integrity": {
                "algorithm": "SHA256",
                "hash": "test",
                "blockSize": 4194304,
                "blocks": ["test"]
            }
        });
        if let Some(sub) = rel.strip_prefix("dist/") {
            dist_files.insert(sub.to_string(), node);
        } else {
            root_files.insert((*rel).to_string(), node);
        }
    }
    if !dist_files.is_empty() {
        root_files.insert(
            "dist".to_string(),
            serde_json::json!({ "files": serde_json::Value::Object(dist_files) }),
        );
    }

    let header = serde_json::json!({ "files": serde_json::Value::Object(root_files) });
    let header_json = serde_json::to_string(&header).unwrap();
    let padding = asar_padding_len(header_json.len());
    let mut out = Vec::new();
    out.extend_from_slice(&4u32.to_le_bytes());
    out.extend_from_slice(&((header_json.len() + 8 + padding) as u32).to_le_bytes());
    out.extend_from_slice(&((header_json.len() + 4 + padding) as u32).to_le_bytes());
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(header_json.as_bytes());
    out.extend(std::iter::repeat(0u8).take(padding));
    out.extend_from_slice(&payload);
    out
}

fn temp_test_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{tag}-{}-{stamp}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_service_marker(
    spec: &cdp_themes::CdpThemeSpec,
    deploy_dir: &Path,
    home_dir: &Path,
) {
    #[cfg(target_os = "windows")]
    {
        let _ = home_dir;
        fs::write(deploy_dir.join(spec.win_vbs_name), "vbs").unwrap();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = deploy_dir;
        let agents = home_dir.join("Library").join("LaunchAgents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(agents.join(spec.mac_plists[0]), "plist").unwrap();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = deploy_dir;
        let unit = home_dir.join(".config").join("systemd").join("user");
        fs::create_dir_all(&unit).unwrap();
        fs::write(unit.join(spec.linux_service), "service").unwrap();
    }
}

#[test]
fn inspect_hub_asar_detects_clean_and_patched_states() {
    let dir = temp_test_dir("anybridge-test-enhance-probe");
    let asar = dir.join("app.asar");

    let clean = build_test_asar(&[
        ("package.json", r#"{"version":"2.34.0"}"#),
        ("dist/utils.js", "function createWindow() {}"),
    ]);
    fs::write(&asar, &clean).unwrap();
    let probe_clean = inspect_hub_asar_context_viewer(&asar).unwrap();
    assert!(!probe_clean.installed);
    assert_eq!(probe_clean.disk_version, None);
    assert_eq!(probe_clean.host_version.as_deref(), Some("2.34.0"));

    let patched = build_test_asar(&[
        ("package.json", r#"{"version":"2.34.0"}"#),
        ("dist/utils.js", "installContextMeter(win);"),
        ("dist/meter-manifest.json", r#"{"version":"0.8.10"}"#),
    ]);
    fs::write(&asar, &patched).unwrap();
    let probe_patched = inspect_hub_asar_context_viewer(&asar).unwrap();
    assert!(probe_patched.installed);
    assert_eq!(probe_patched.disk_version.as_deref(), Some("0.8.10"));
    assert_eq!(probe_patched.host_version.as_deref(), Some("2.34.0"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn status_stays_compatible_even_without_local_installer() {
    let dir = temp_test_dir("anybridge-test-enhance-status");
    let asar = dir.join("app.asar");
    let missing_installer = dir.join("missing-installer");

    let clean = build_test_asar(&[
        ("package.json", r#"{"version":"2.34.0"}"#),
        ("dist/utils.js", "function createWindow() {}"),
    ]);
    fs::write(&asar, &clean).unwrap();

    let status = build_context_viewer_status(Some(&asar), Some(&missing_installer));
    assert_eq!(status.name, "antigravity-context-viewer");
    assert!(status.host_installed);
    assert!(status.compatible, "仅缺本地安装器时应保持可安装，不得误标为不兼容");
    assert!(!status.installed);
    assert_eq!(status.host_version.as_deref(), Some("2.34.0"));
    assert_eq!(status.installer_version, None);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn archive_filter_skips_demo_media_and_keeps_runtime_files() {
    assert!(!should_keep_archive_entry(Path::new("assets/demo.mp4")));
    assert!(!should_keep_archive_entry(Path::new("docs/preview.gif")));
    assert!(!should_keep_archive_entry(Path::new(
        ".github/workflows/ci.yml"
    )));
    assert!(should_keep_archive_entry(Path::new("cli.js")));
    assert!(should_keep_archive_entry(Path::new("src/main.js")));
    assert!(should_keep_archive_entry(Path::new("core/daemon.mjs")));
    assert!(should_keep_archive_entry(Path::new("core/manifest.json")));
}

#[test]
fn restore_hub_patches_reapplies_lost_localization_when_previously_localized() {
    let dir = temp_test_dir("anybridge-test-enhance-loc-sym");
    let asar = dir.join("app.asar");

    let clean = build_test_asar(&[
        ("package.json", r#"{"version":"2.34.0"}"#),
        ("dist/preload.js", "console.log('preload base');"),
        ("dist/utils.js", "function createWindow() {}"),
    ]);
    fs::write(&asar, &clean).unwrap();

    patch_hub_asar(&asar).expect("初始汉化应成功");
    assert!(is_hub_localized(&asar));

    fs::write(&asar, &clean).unwrap();
    assert!(!is_hub_localized(&asar));

    restore_hub_patches_if_lost(&asar, false, true).expect("应自动补回汉化补丁");
    assert!(is_hub_localized(&asar), "安装或重装增强插件后必须保留已有汉化");

    fs::write(&asar, &clean).unwrap();
    restore_hub_patches_if_lost(&asar, false, false).expect("未汉化时应保持原状");
    assert!(!is_hub_localized(&asar));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cdp_theme_status_requires_complete_effective_chain() {
    let root = temp_test_dir("anybridge-test-cdp-theme-status");
    let home = root.join("home");
    let roaming = root.join("roaming");
    let inst_missing = root.join("missing-installer");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&roaming).unwrap();

    // 1. codex-theme：仅残留 core/daemon.mjs 但无系统自启文件 -> 不得判为已安装
    let codex = find_cdp_theme_spec(CODEX_THEME_ID).unwrap();
    let codex_deploy = root.join("codex-theme");
    fs::create_dir_all(codex_deploy.join("core")).unwrap();
    fs::create_dir_all(codex_deploy.join("user")).unwrap();
    fs::write(codex_deploy.join("install.mjs"), "//").unwrap();
    fs::write(codex_deploy.join("package.json"), r#"{"version":"1.3.1"}"#).unwrap();
    fs::write(codex_deploy.join("core").join("daemon.mjs"), "//").unwrap();
    fs::write(codex_deploy.join("user").join("config.json"), r#"{"enabled":true}"#).unwrap();

    let st_no_service = build_cdp_theme_status_with_roots(
        codex,
        true,
        Some("2.34.0".into()),
        Some(&codex_deploy),
        Some(&inst_missing),
        Some(&home),
        Some(&roaming),
    );
    assert!(
        !st_no_service.installed,
        "卸载后仅剩部署目录但无系统自启注册物时不得误判为已安装"
    );

    // 2. 补齐服务注册物，但 user/config.json disabled -> 仍不算生效
    write_service_marker(codex, &codex_deploy, &home);
    fs::write(
        codex_deploy.join("user").join("config.json"),
        "\u{feff}{\"enabled\":false}",
    )
    .unwrap();
    let st_disabled = build_cdp_theme_status_with_roots(
        codex,
        true,
        Some("2.34.0".into()),
        Some(&codex_deploy),
        Some(&inst_missing),
        Some(&home),
        Some(&roaming),
    );
    assert!(!st_disabled.installed, "enabled=false 时不得判为已安装");

    // 3. 完整生效链 -> 已安装且读出 package.json 版本 1.3.1
    fs::write(
        codex_deploy.join("user").join("config.json"),
        r#"{"enabled":true}"#,
    )
    .unwrap();
    let st_ok = build_cdp_theme_status_with_roots(
        codex,
        true,
        Some("2.34.0".into()),
        Some(&codex_deploy),
        Some(&inst_missing),
        Some(&home),
        Some(&roaming),
    );
    assert!(st_ok.installed);
    assert_eq!(st_ok.version.as_deref(), Some("1.3.1"));
    assert_eq!(st_ok.conflicts_with, vec![CHUANBAN_THEME_ID.to_string()]);

    // 4. chuanban：仓库无 package.json，版本必须从 core/manifest.json 读取
    let chuanban = find_cdp_theme_spec(CHUANBAN_THEME_ID).unwrap();
    let cb_deploy = root.join("theme-patch");
    fs::create_dir_all(cb_deploy.join("core")).unwrap();
    fs::create_dir_all(cb_deploy.join("user")).unwrap();
    fs::write(cb_deploy.join("install.mjs"), "//").unwrap();
    fs::write(cb_deploy.join("core").join("daemon.mjs"), "//").unwrap();
    fs::write(
        cb_deploy.join("core").join("manifest.json"),
        r#"{"version":"6.0.1"}"#,
    )
    .unwrap();
    fs::write(cb_deploy.join("user").join("config.json"), r#"{"enabled":true}"#).unwrap();
    write_service_marker(chuanban, &cb_deploy, &home);

    let st_cb = build_cdp_theme_status_with_roots(
        chuanban,
        true,
        Some("2.34.0".into()),
        Some(&cb_deploy),
        Some(&inst_missing),
        Some(&home),
        Some(&roaming),
    );
    assert!(st_cb.installed);
    assert_eq!(st_cb.version.as_deref(), Some("6.0.1"));
    assert_eq!(st_cb.conflicts_with, vec![CODEX_THEME_ID.to_string()]);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn node_version_parser_and_minimum_gate() {
    assert_eq!(parse_node_version_output("v22.13.0\n"), Some((22, 13, 0)));
    assert_eq!(parse_node_version_output("23.1.2-nightly"), Some((23, 1, 2)));
    assert_eq!(parse_node_version_output("bad"), None);

    assert!(node_meets_min((22, 13, 0), (22, 13, 0)));
    assert!(node_meets_min((24, 0, 0), (22, 13, 0)));
    assert!(!node_meets_min((22, 12, 9), (22, 13, 0)));
    assert!(!node_meets_min((20, 18, 0), (22, 0, 0)));
    assert!(node_meets_min((22, 0, 0), (22, 0, 0)));
}

#[test]
fn cdp_theme_install_args_skip_i18n_when_context_viewer_present() {
    let codex = find_cdp_theme_spec(CODEX_THEME_ID).unwrap();
    let chuanban = find_cdp_theme_spec(CHUANBAN_THEME_ID).unwrap();

    assert_eq!(
        build_cdp_theme_install_args(codex, true),
        vec!["install", "--without", "i18n"]
    );
    assert_eq!(build_cdp_theme_install_args(codex, false), vec!["install"]);
    assert_eq!(
        build_cdp_theme_install_args(chuanban, true),
        vec!["install"]
    );
}

#[test]
fn cdp_theme_conflict_peers_are_symmetric() {
    assert_eq!(
        conflict_peer_ids(CODEX_THEME_ID),
        vec![CHUANBAN_THEME_ID.to_string()]
    );
    assert_eq!(
        conflict_peer_ids(CHUANBAN_THEME_ID),
        vec![CODEX_THEME_ID.to_string()]
    );
    assert!(conflict_peer_ids(CONTEXT_VIEWER_ID).is_empty());
    assert!(conflict_peer_ids(USAGE_MONITOR_ID).is_empty());
}

#[test]
fn native_plugin_status_requires_complete_effective_chain() {
    let root = temp_test_dir("anybridge-test-native-plugin");
    let cfg_dir = root.join(".gemini").join("config");
    let spec = find_native_plugin_spec(USAGE_MONITOR_ID).unwrap();
    let plugin_dir = plugin_dir_under(&cfg_dir, spec);
    let cfg_file = plugin_config_file_under(&cfg_dir);

    // 1. 仅存在文件树但 config.json 未注册 -> 不得判为已安装
    fs::create_dir_all(plugin_dir.join("sidecars").join("panel")).unwrap();
    fs::write(plugin_dir.join("plugin.json"), r#"{"version":"1.5.5"}"#).unwrap();
    fs::write(plugin_dir.join("mcp_config.json"), "{}").unwrap();
    fs::write(plugin_dir.join("sidecars").join("panel").join("app.js"), "//").unwrap();

    let st_unregistered = build_native_plugin_status_with_root(
        spec,
        true,
        Some("2.34.0".into()),
        Some(&cfg_dir),
    );
    assert!(!st_unregistered.installed, "未在 config.json 注册启用时不得判为已安装");
    assert_eq!(st_unregistered.version.as_deref(), Some("1.5.5"));
    assert!(!st_unregistered.detail.is_empty());

    // 2. config.json 显式 enabled=false -> 仍不算生效
    fs::write(
        &cfg_file,
        r#"{"plugins":{"usage-monitor":{"enabled":false}}}"#,
    )
    .unwrap();
    let st_disabled = build_native_plugin_status_with_root(
        spec,
        true,
        Some("2.34.0".into()),
        Some(&cfg_dir),
    );
    assert!(!st_disabled.installed, "enabled=false 时不得判为已安装");

    // 3. 启用且文件树完整 -> 判为已安装并读出 1.5.5
    set_plugin_registration_in_config(&cfg_file, spec.plugin_dir_name, true).unwrap();
    let st_enabled = build_native_plugin_status_with_root(
        spec,
        true,
        Some("2.34.0".into()),
        Some(&cfg_dir),
    );
    assert!(st_enabled.installed);
    assert_eq!(st_enabled.version.as_deref(), Some("1.5.5"));
    assert!(st_enabled.detail.is_empty());

    // 4. 缺失核心运行时文件 sidecars/panel/app.js -> 判为未安装
    fs::remove_file(plugin_dir.join("sidecars").join("panel").join("app.js")).unwrap();
    let st_broken = build_native_plugin_status_with_root(
        spec,
        true,
        Some("2.34.0".into()),
        Some(&cfg_dir),
    );
    assert!(!st_broken.installed);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn native_plugin_config_registration_preserves_other_fields_and_rejects_corrupt_json() {
    let root = temp_test_dir("anybridge-test-native-cfg");
    let cfg_file = root.join("config.json");
    fs::write(
        &cfg_file,
        r#"{"plugins":{"chrome-devtools-plugin":{"enabled":true}},"userSettings":{"themeMode":"THEME_MODE_LIGHT"}}"#,
    )
    .unwrap();

    // 启用并保留其他插件与用户设置
    set_plugin_registration_in_config(&cfg_file, "usage-monitor", true).unwrap();
    let after_enable: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cfg_file).unwrap()).unwrap();
    assert_eq!(after_enable["plugins"]["usage-monitor"]["enabled"], true);
    assert_eq!(
        after_enable["plugins"]["chrome-devtools-plugin"]["enabled"],
        true
    );
    assert_eq!(after_enable["userSettings"]["themeMode"], "THEME_MODE_LIGHT");

    // 卸载仅删 usage-monitor，保留其他所有字段
    set_plugin_registration_in_config(&cfg_file, "usage-monitor", false).unwrap();
    let after_disable: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cfg_file).unwrap()).unwrap();
    assert!(after_disable["plugins"].get("usage-monitor").is_none());
    assert_eq!(
        after_disable["plugins"]["chrome-devtools-plugin"]["enabled"],
        true
    );
    assert_eq!(after_disable["userSettings"]["themeMode"], "THEME_MODE_LIGHT");

    // 损坏 JSON 拒绝覆写
    fs::write(&cfg_file, "{ invalid json").unwrap();
    let err = set_plugin_registration_in_config(&cfg_file, "usage-monitor", true);
    assert!(err.is_err(), "损坏的 config.json 必须显式报错而不得静默覆写");
    assert_eq!(fs::read_to_string(&cfg_file).unwrap(), "{ invalid json");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn native_plugin_archive_filter_keeps_logo_svg_and_skips_videos() {
    assert!(should_keep_native_plugin_entry(Path::new("assets/logo.svg")));
    assert!(should_keep_native_plugin_entry(Path::new("plugin.json")));
    assert!(should_keep_native_plugin_entry(Path::new(
        "sidecars/panel/app.js"
    )));
    assert!(!should_keep_native_plugin_entry(Path::new(
        ".github/workflows/ci.yml"
    )));
    assert!(!should_keep_native_plugin_entry(Path::new(
        "assets/demo.mp4"
    )));
}

#[test]
fn conflict_matrix_is_symmetric_and_marks_active_entries() {
    let pairs = all_conflict_pairs_for_test();
    for (subject, peer, level) in &pairs {
        assert!(
            pairs
                .iter()
                .any(|(s, p, l)| s == peer && p == subject && l == level),
            "冲突规则缺少反向对称声明: {subject} -> {peer} ({level:?})"
        );
    }

    let make_stub = |id: &str, installed: bool| EnhanceItemStatus {
        id: id.to_string(),
        name: id.to_string(),
        description: String::new(),
        repo: String::new(),
        installed,
        version: None,
        installer_version: None,
        latest_version: None,
        has_update: false,
        host_installed: true,
        host_version: Some("2.34.0".into()),
        compatible: true,
        conflicts_with: Vec::new(),
        conflicts: Vec::new(),
        detail: String::new(),
    };
    let mut items = vec![
        make_stub(CONTEXT_VIEWER_ID, true),
        make_stub(USAGE_MONITOR_ID, false),
        make_stub(CODEX_THEME_ID, true),
        make_stub(CHUANBAN_THEME_ID, false),
    ];
    apply_conflict_matrix(&mut items);

    let usage = items.iter().find(|i| i.id == USAGE_MONITOR_ID).unwrap();
    assert!(usage.conflicts_with.is_empty());
    assert!(usage.conflicts.iter().any(|c| c.peer_id == CONTEXT_VIEWER_ID
        && c.level == ConflictLevel::Overlap
        && c.active));
    assert!(usage.conflicts.iter().any(|c| c.peer_id == CODEX_THEME_ID
        && c.level == ConflictLevel::Overlap
        && c.active));
    assert!(usage.conflicts.iter().any(|c| c.peer_id == CHUANBAN_THEME_ID
        && c.level == ConflictLevel::Overlap
        && !c.active));

    let chuanban = items.iter().find(|i| i.id == CHUANBAN_THEME_ID).unwrap();
    assert_eq!(chuanban.conflicts_with, vec![CODEX_THEME_ID.to_string()]);
    assert!(chuanban.conflicts.iter().any(|c| c.peer_id == CODEX_THEME_ID
        && c.level == ConflictLevel::Exclusive
        && c.active));
    assert!(chuanban.conflicts.iter().any(|c| c.peer_id == CONTEXT_VIEWER_ID
        && c.level == ConflictLevel::Overlap
        && c.active));
}

#[test]
fn github_detail_whitelist_allows_registered_repos_and_rejects_arbitrary_ones() {
    assert!(is_allowed_enhance_repo(CONTEXT_VIEWER_REPO));
    assert!(is_allowed_enhance_repo(LOC_UPSTREAM_REPO));
    assert!(is_allowed_enhance_repo("yuhuan-dev/antigravity-usage-monitor"));
    assert!(is_allowed_enhance_repo("nkjDSLcvanv/antigravity-codex-theme"));
    assert!(is_allowed_enhance_repo(
        "Anarcadia/chuanban-antigravity-theme-patch"
    ));
    assert!(!is_allowed_enhance_repo("evil/arbitrary-repo"));
    assert!(!is_allowed_enhance_repo(""));
    assert_eq!(
        build_raw_base_url("yuhuan-dev/antigravity-usage-monitor", "main"),
        "https://raw.githubusercontent.com/yuhuan-dev/antigravity-usage-monitor/main"
    );
}

#[test]
fn github_image_proxy_whitelist_and_html_extractors_work() {
    assert!(is_allowed_enhance_image_url(
        "https://raw.githubusercontent.com/nkjDSLcvanv/antigravity-codex-theme/main/assets/demo.png"
    ));
    assert!(is_allowed_enhance_image_url(
        "https://img.shields.io/static/v1?label=Node.js&message=%3E%3D%2022.13.0"
    ));
    assert!(is_allowed_enhance_image_url(
        "https://camo.githubusercontent.com/abc123/6874747073"
    ));
    assert!(is_allowed_enhance_image_url(
        "https://github.com/user-attachments/assets/e27c7621-b605-4fdf-9bc3-4fc12da85484"
    ));
    assert!(!is_allowed_enhance_image_url("http://raw.githubusercontent.com/a/b.png"));
    assert!(!is_allowed_enhance_image_url("https://127.0.0.1/secret.png"));
    assert!(!is_allowed_enhance_image_url("https://evil.example.com/a.png"));
    assert!(!is_allowed_enhance_image_url("https://img.shields.io@evil.com/a.png"));
    assert!(!is_allowed_enhance_image_url("https://img.shields.io:8443/a.png"));

    let sample_html = r#"<html><head><meta name="description" content="Codex 主题插件 &amp; 工具 - a/b"></head><body data-default-branch="main"><a href="/a/b/stargazers"><strong>1.2k</strong></a><a href="/a/b/blob/main/LICENSE">MIT license</a><article class="markdown-body entry-content"><div align="center"><h1>Title</h1><article>nested</article></div></article></body></html>"#;
    let article = extract_markdown_article(sample_html).expect("应提取出完整 markdown-body");
    assert!(article.contains("<h1>Title</h1>"));
    assert!(article.contains("<article>nested</article>"));
    let meta = extract_page_meta(sample_html, "a/b");
    assert_eq!(meta.default_branch.as_deref(), Some("main"));
    assert_eq!(meta.description.as_deref(), Some("Codex 主题插件 & 工具"));
    assert_eq!(meta.stars, Some(1200));
    assert_eq!(meta.license.as_deref(), Some("MIT"));

    assert!(html_has_significant_chinese("Google Antigravity 的 Codex 昼夜主题、自定义字体、模型额度、中文界面与实时会话统计插件"));
    assert!(!html_has_significant_chinese("<h1>English Only README</h1><p>Hello world</p>"));

    assert_eq!(
        detect_image_mime(Some("image/svg+xml; charset=utf-8"), b"<svg></svg>", "https://img.shields.io/a"),
        Some("image/svg+xml")
    );
    assert_eq!(
        detect_image_mime(Some("application/octet-stream"), b"\x89PNG\r\n\x1a\nrest", "https://raw.githubusercontent.com/a"),
        Some("image/png")
    );
    assert_eq!(
        detect_image_mime(Some("text/html"), b"<html>not image</html>", "https://github.com/a"),
        None
    );
}

#[test]
fn replace_dir_atomically_and_dir_sync_handle_fresh_reinstall_readonly_and_stale_prune() {
    let root = temp_test_dir("anybridge-test-replace-dir");
    let staging1 = root.join(".staging-1");
    let target = root.join("plugins").join("usage-monitor");

    fs::create_dir_all(staging1.join("sidecars").join("panel")).unwrap();
    fs::write(staging1.join("plugin.json"), r#"{"version":"1.5.5"}"#).unwrap();
    fs::write(staging1.join("obsolete.txt"), "old-only").unwrap();
    fs::create_dir_all(staging1.join("old-dir")).unwrap();
    fs::write(staging1.join("old-dir").join("stale.js"), "//").unwrap();
    fs::write(
        staging1.join("sidecars").join("panel").join("app.js"),
        "v1",
    )
    .unwrap();
    fs::create_dir_all(staging1.join("shape-flip")).unwrap();
    fs::write(staging1.join("shape-flip").join("nested.txt"), "dir").unwrap();

    // 1. 全新部署
    replace_dir_atomically("usage-monitor", &staging1, &target).expect("全新部署应成功");
    assert!(!staging1.exists(), "staging 应被消费或清理");
    assert_eq!(
        fs::read_to_string(target.join("plugin.json")).unwrap(),
        r#"{"version":"1.5.5"}"#
    );
    assert!(target.join("obsolete.txt").is_file());

    // 将目标内部分文件设为只读，验证 Windows 同步降级路径仍能覆写并清掉过时文件/目录
    let mut perms = fs::metadata(target.join("plugin.json")).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(target.join("plugin.json"), perms).unwrap();

    // 2. 直接验证 sync_dir_from_staging 兜底链路（模拟 Windows os error 5 / 跨卷 EXDEV 回退）
    let staging2 = root.join(".staging-2");
    fs::create_dir_all(staging2.join("sidecars").join("panel")).unwrap();
    fs::write(staging2.join("plugin.json"), r#"{"version":"1.5.6"}"#).unwrap();
    fs::write(
        staging2.join("sidecars").join("panel").join("app.js"),
        "v2",
    )
    .unwrap();
    fs::write(staging2.join("shape-flip"), "now-a-file").unwrap();

    sync_dir_from_staging(&staging2, &target).expect("目录树同步兜底应能覆写只读文件并清理旧项");
    assert!(!staging2.exists(), "同步后应清理 staging");
    assert_eq!(
        fs::read_to_string(target.join("plugin.json")).unwrap(),
        r#"{"version":"1.5.6"}"#
    );
    assert_eq!(
        fs::read_to_string(target.join("sidecars").join("panel").join("app.js")).unwrap(),
        "v2"
    );
    assert!(!target.join("obsolete.txt").exists(), "过时文件应被清理");
    assert!(!target.join("old-dir").exists(), "过时目录应被清理");
    assert!(target.join("shape-flip").is_file(), "同名目录改为文件应正常切换");

    // 3. 验证 uninstall 清理可重复执行
    remove_dir_with_retry(&target).expect("卸载清理目录应成功");
    assert!(!target.exists());
    remove_dir_with_retry(&target).expect("重复清理不存在目录应保持幂等");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn native_plugin_zip_staging_and_reinstall_roundtrip_outside_plugins_dir() {
    use std::io::Write;
    let root = temp_test_dir("anybridge-test-native-zip-roundtrip");
    let cfg_dir = root.join(".gemini").join("config");
    fs::create_dir_all(&cfg_dir).unwrap();
    let spec = find_native_plugin_spec(USAGE_MONITOR_ID).unwrap();

    let zip_path = root.join("usage-monitor.zip");
    {
        let file = fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in [
            ("usage-monitor/plugin.json", r#"{"name":"usage-monitor","version":"1.5.6"}"#),
            ("usage-monitor/mcp_config.json", "{}"),
            ("usage-monitor/assets/logo.svg", "<svg/>"),
            ("usage-monitor/sidecars/panel/app.js", "console.log('ok');"),
            ("usage-monitor/assets/demo.mp4", "ignored-video"),
            ("usage-monitor/.github/workflows/ci.yml", "ignored-ci"),
        ] {
            zw.start_file(name, opts).unwrap();
            zw.write_all(body.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }

    let staging = cfg_dir.join(format!(".{}-staging-test", spec.plugin_dir_name));
    fs::create_dir_all(&staging).unwrap();
    crate::commands::plugin_asset::extract_zip_filtered(
        &zip_path,
        &staging,
        1,
        should_keep_native_plugin_entry,
    )
    .unwrap();
    super::native_plugins::validate_native_plugin_tree(&staging).unwrap();
    assert!(!cfg_dir.join("plugins").exists(), "校验通过前不应污染 plugins 目录");

    let target = plugin_dir_under(&cfg_dir, spec);
    replace_dir_atomically(spec.plugin_dir_name, &staging, &target).unwrap();
    set_plugin_registration_in_config(&plugin_config_file_under(&cfg_dir), spec.plugin_dir_name, true)
        .unwrap();

    let st = build_native_plugin_status_with_root(spec, true, Some("2.35.2".into()), Some(&cfg_dir));
    assert!(st.installed);
    assert_eq!(st.version.as_deref(), Some("1.5.6"));
    assert!(target.join("assets").join("logo.svg").is_file());
    assert!(!target.join("assets").join("demo.mp4").exists());

    // 对称卸载后状态归零
    remove_dir_with_retry(&target).unwrap();
    set_plugin_registration_in_config(&plugin_config_file_under(&cfg_dir), spec.plugin_dir_name, false)
        .unwrap();
    let st_after = build_native_plugin_status_with_root(spec, true, Some("2.35.2".into()), Some(&cfg_dir));
    assert!(!st_after.installed);
    assert_eq!(st_after.version, None);

    let _ = fs::remove_dir_all(&root);
}
