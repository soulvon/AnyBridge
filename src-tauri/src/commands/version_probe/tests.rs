use super::*;

/// 回归：无 GUI 探测源的平台（pi/hermes 等）不得从 find_ide_exe 的
/// 默认分支（= Windsurf）拿到版本。实测曾让 Pi/Hermes 页显示
/// Windsurf 的 v1.110.1。
///
/// 注意：以下平台已有自己的版本源，不在本测试列表：
/// - claude-desktop：Appx 安装目录名（Claude_3.6556.2.0_x64__xxx）
/// - workbuddy / zcode：运行进程的 resources/app.asar 内 package.json
#[test]
fn gui_probe_returns_none_for_platforms_without_source() {
    // codebuddy 已改为桌面 IDE 版本源（gui_exe_prefix → 安装目录
    // resources/app/package.json，实测 1.106.1），不在本列表；
    // workbuddy / zcode 也有源（Electron asar），只是进程未运行时为 None
    for id in ["pi", "hermes", "deepseek-harness"] {
        assert_eq!(
            installed_gui_version(id),
            None,
            "{id} 无 GUI 探测源，不应返回版本"
        );
    }
}

/// npm shim 直读：bin 位于 node_modules 树内（含 Windows .cmd shim 与
/// 双层 node_modules 布局）时从包内 package.json 拿版本；非 shim 路径
/// （原生安装，如 ~/.codex/bin）返回 None 回退跑 --version。
#[test]
fn npm_shim_version_reads_package_json() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-shim-{nanos}"));

    // 标准布局：<prefix>/node_modules/.bin/foo.cmd → <prefix>/node_modules/@scope/foo
    let bin = dir.join("node_modules").join(".bin").join("foo.cmd");
    std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
    let pkg_dir = dir.join("node_modules").join("@scope").join("foo");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("package.json"),
        r#"{"name":"@scope/foo","version":"2.5.1"}"#,
    )
    .unwrap();
    assert_eq!(
        npm_shim_version(&bin, "@scope/foo").as_deref(),
        Some("2.5.1"),
        "shim 布局应直读包版本"
    );

    // 非 shim（原生安装）：路径无 node_modules 祖先 → None
    let native = dir.join("codex").join("bin").join("codex.exe");
    std::fs::create_dir_all(native.parent().unwrap()).unwrap();
    assert!(
        npm_shim_version(&native, "@scope/foo").is_none(),
        "原生安装路径不得误读 npm 包版本"
    );

    // 双层布局：prefix 即 node_modules → 包在 node_modules/<pkg> 再下一层
    let outer = dir.join("outer").join("node_modules").join(".bin").join("bar.cmd");
    std::fs::create_dir_all(outer.parent().unwrap()).unwrap();
    let nested = dir.join("outer").join("node_modules").join("node_modules").join("bar");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(
        nested.join("package.json"),
        r#"{"version":"0.9.0"}"#,
    )
    .unwrap();
    assert_eq!(
        npm_shim_version(&outer, "bar").as_deref(),
        Some("0.9.0"),
        "双层 node_modules 布局也应命中"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 本机诊断：官方版本通道（grok 这类无 npm 包的平台）
#[tokio::test]
#[ignore]
async fn debug_channel_latest() {
    let urls = [
        "https://x.ai/cli/stable",
        "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
    ];
    println!("grok channel latest = {:?}", channel_latest_version(&urls).await);
}

/// 本机诊断：npm 一键安装/更新能力探针 + npm 实际定位
#[test]
#[ignore]
fn debug_install_capability() {
    println!("npm_install_capability = {}", npm_install_capability());
    println!("find_tool(npm)   = {:?}", find_tool("npm"));
    println!("find_tool(codex) = {:?}", find_tool("codex"));
    println!("npm prefix       = {:?}", npm_global_prefix());
}

/// 本机诊断（cargo test --lib debug_gui_versions -- --ignored --nocapture）
#[test]
#[ignore]
fn debug_gui_versions() {
    for id in [
        "windsurf",
        "devin",
        "cursor",
        "claude-desktop",
        "antigravity",
        "antigravity-ide",
        "workbuddy",
        "zcode",
    ] {
        println!("{id} => {:?}", installed_gui_version(id));
    }
}

/// 产品版本取值：`version` 在这些 fork 里是引擎版本，必须优先专有字段
/// （用户对照「关于」对话框实测：Windsurf 2.3.15 / Devin 3.11.216 /
///  Antigravity IDE 2.5.5，而 version 分别是 1.110.1 / 1.126.0 / 1.107.0）
#[test]
fn product_version_prefers_vendor_field() {
    let windsurf: serde_json::Value =
        serde_json::from_str(r#"{"version":"1.110.1","windsurfVersion":"2.3.15"}"#).unwrap();
    assert_eq!(product_version_from_json(&windsurf).as_deref(), Some("2.3.15"));

    let devin: serde_json::Value =
        serde_json::from_str(r#"{"version":"1.126.0","windsurfVersion":"3.11.216"}"#).unwrap();
    assert_eq!(product_version_from_json(&devin).as_deref(), Some("3.11.216"));

    let ag_ide: serde_json::Value =
        serde_json::from_str(r#"{"version":"1.107.0","ideVersion":"2.5.5"}"#).unwrap();
    assert_eq!(product_version_from_json(&ag_ide).as_deref(), Some("2.5.5"));

    // Cursor：version 就是产品版本，vscodeVersion 才是引擎
    let cursor: serde_json::Value =
        serde_json::from_str(r#"{"version":"3.15.6","vscodeVersion":"1.128.0"}"#).unwrap();
    assert_eq!(product_version_from_json(&cursor).as_deref(), Some("3.15.6"));

    // version == vscodeVersion → 只是引擎版本，不冒充
    let engine_only: serde_json::Value =
        serde_json::from_str(r#"{"version":"1.128.0","vscodeVersion":"1.128.0"}"#).unwrap();
    assert_eq!(product_version_from_json(&engine_only), None);
}

/// semver 对比的基本语义
#[test]
fn is_newer_semantics() {
    assert!(is_newer("2.0.0", "1.9.9"));
    assert!(is_newer("0.184.0", "0.163.0"));
    assert!(!is_newer("1.0.0", "1.0.0"));
    assert!(!is_newer("1.0.0", "2.0.0"));
    // 预发布视为较旧（实用语义）：beta 版 latest 不打扰正式版用户
    assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
}
