use serde_json::json;
use std::fs;
use super::*;

#[test]
fn antigravity_ide_uses_home_dot_dir_for_extensions_and_argv() {
    let dot = ide_home_dot_dir("antigravity-ide")
        .expect("Antigravity IDE 必须映射到 home 下的 .antigravity-ide 目录");
    assert_eq!(
        dot.file_name().and_then(|n| n.to_str()),
        Some(".antigravity-ide")
    );
    let argv = ide_argv_path("antigravity-ide").expect("必须定位到 argv.json");
    assert_eq!(argv.file_name().and_then(|n| n.to_str()), Some("argv.json"));
    assert_eq!(
        argv.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()),
        Some(".antigravity-ide"),
        "Antigravity IDE 的 argv.json 必须在 ~/.antigravity-ide 下（Electron 主进程从此读取 locale）"
    );
    // Cursor 的 ~/.cursor 是 CLI 目录，绝对不能映射进去
    assert!(ide_home_dot_dir("cursor").is_none());

    // 若本机 ~/.antigravity-ide/extensions 存在而 %APPDATA%\Antigravity IDE\extensions 不存在，
    // ide_extensions_dir 必须命中前者而不是后者
    if let (Some(home), Some(roaming)) = (dirs::home_dir(), dirs::config_dir()) {
        let home_ext = home.join(".antigravity-ide").join("extensions");
        let appdata_ext = roaming.join("Antigravity IDE").join("extensions");
        if home_ext.is_dir() && !appdata_ext.is_dir() {
            assert_eq!(ide_extensions_dir("antigravity-ide"), Some(home_ext));
        }
    }
}

#[test]
fn compatible_version_accepts_previous_minor_and_universal_suffix() {
    // 真实事故：IDE 1.107.0 引擎，Open VSX 上只有 1.105.0 / 1.106.0 / 1.108.0（缺 1.107.x）
    let picked = pick_compatible_lang_pack_version(["1.105.0", "1.106.0", "1.108.0"], "1.107.0");
    assert_eq!(
        picked.as_deref(),
        Some("1.106.0"),
        "1.107.x 缺失时必须向下兼容选用 1.106.0，并跳过高于引擎的 1.108.0"
    );

    // 若同时存在同 minor 版本，优先同 minor 最大 patch
    assert_eq!(
        pick_compatible_lang_pack_version(["1.106.0", "1.107.2", "1.108.0"], "1.107.0").as_deref(),
        Some("1.107.2")
    );

    // 落后超过 5 个 minor 或跨大版本不兼容
    assert_eq!(
        pick_compatible_lang_pack_version(["1.90.0", "2.0.0"], "1.107.0"),
        None
    );

    // 支持带 -universal 后缀的扩展目录名解析
    let parsed = parse_semver_prefix("1.106.0-universal");
    assert_eq!(parsed, Some((1, 106, 0)));
    assert!(is_lang_pack_compatible((1, 106, 0), (1, 107, 0)));
    assert!(!is_lang_pack_compatible((1, 108, 0), (1, 107, 0)));
}

#[test]
fn register_language_pack_at_handles_universal_dir_and_exact_md5() {
    let dir = std::env::temp_dir().join(format!("anybridge-test-lp-reg-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let state_dir = dir.join("state");
    let pack_dir = dir
        .join("extensions")
        .join("ms-ceintl.vscode-language-pack-zh-hans-1.106.0-universal");
    fs::create_dir_all(&state_dir).unwrap();
    fs::create_dir_all(pack_dir.join("translations")).unwrap();
    fs::write(
        pack_dir.join("translations").join("main.i18n.json"),
        "{}",
    )
    .unwrap();
    fs::write(
        pack_dir.join("package.json"),
        json!({
            "name": "vscode-language-pack-zh-hans",
            "version": "1.106.0",
            "contributes": {
                "localizations": [{
                    "languageId": "zh-cn",
                    "localizedLanguageName": "中文(简体)",
                    "translations": [
                        { "id": "vscode", "path": "./translations/main.i18n.json" }
                    ]
                }]
            }
        })
        .to_string(),
    )
    .unwrap();

    register_language_pack_at(&state_dir, &pack_dir);

    let lp_raw = fs::read_to_string(state_dir.join("languagepacks.json"))
        .expect("应生成 languagepacks.json");
    let lp: serde_json::Value = serde_json::from_str(&lp_raw).unwrap();
    let zh = &lp["zh-cn"];
    assert_eq!(
        zh["extensions"][0]["version"],
        json!("1.106.0"),
        "注册版本必须取 package.json 的 1.106.0，不能带上 -universal 后缀"
    );
    // md5("ms-ceintl.vscode-language-pack-zh-hans1.106.0") == "44d34997269017485f39551ab23a5dc5"
    // （不能拼入 "-universal" 后缀，否则会算出 190362adff000c4993f2894f9d9227e0）
    assert_eq!(
        zh["hash"],
        json!("44d34997269017485f39551ab23a5dc5"),
        "hash 必须与官方扩展 id + 真实版本 md5 一致"
    );
    let vscode_path = zh["translations"]["vscode"].as_str().unwrap();
    assert!(
        vscode_path.contains("1.106.0-universal") && vscode_path.ends_with("main.i18n.json"),
        "translations.vscode 必须指向 -universal 真实目录，实际: {vscode_path}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn workbench_ready_check_uses_text_content_not_inner_text() {
    // 事故：首屏设置了 document.documentElement.style.visibility = 'hidden'，
    // 按 HTML 规范隐藏元素的 innerText 恒返回 ""（长度 0），导致 _abWaitReady 死等 6 秒超时！
    for (name, script) in [
        ("windsurf", BASELINE_SCRIPT.to_string()),
        ("devin", DEVIN_BASELINE_SCRIPT.to_string()),
        ("antigravity-ide", hans_script("antigravity-ide")),
    ] {
        assert!(
            !script.contains("document.body.innerText"),
            "{name} 的 _abWaitReady 不得在 visibility:hidden 下读 innerText（恒返回空串导致 6 秒白屏）"
        );
        assert!(
            script.contains("rootEl.textContent"),
            "{name} 的 _abWaitReady 必须用 rootEl.textContent 判断内容是否渲染完成"
        );
    }
}

