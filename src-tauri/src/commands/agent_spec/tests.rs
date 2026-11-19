use super::*;

/// 路径模板解析
#[test]
fn resolves_home_template() {
    let p = resolve_path_template("~/.fake-agent").expect("应可解析");
    assert!(p.is_absolute());
    assert!(p.ends_with(".fake-agent"));
}

/// 不可解析的模板返回 None（不猜路径）
#[test]
fn rejects_unresolvable_template() {
    assert!(resolve_path_template("relative/path").is_none());
    assert!(resolve_path_template("%__ANYBRIDGE_NOT_SET__%/x").is_none());
}

/// 本机诊断：自更新 / 桌面 IDE 声明
#[test]
#[ignore]
fn debug_self_update() {
    for id in ["claude-code", "codex", "codebuddy"] {
        let sp = find(id).unwrap();
        println!(
            "{}: self_update={:?} bin={:?} npm={:?} gui_prefix={:?}",
            id,
            sp.self_update.map(|x| x.subcommand),
            sp.bin,
            sp.npm_package,
            sp.gui_exe_prefix
        );
    }
}

/// 本机诊断：打印注册表（cargo test --lib debug_registry -- --ignored --nocapture）
#[test]
#[ignore]
fn debug_registry() {
    for e in list_registry() {
        println!(
            "{} | {} | installed={} | has_page={} | {}",
            e.id, e.name, e.installed, e.has_page, e.config_path
        );
    }
}

/// 注册表必须合法（社区 PR 的第一道门）
#[test]
fn registry_is_valid() {
    validate_registry().expect("注册表应通过校验");
}

/// 13 个内置平台全部在表中（元数据单一真源的完整性）
#[test]
fn all_builtin_platforms_registered() {
    for id in [
        "antigravity",
        "antigravity-ide",
        "claude-code",
        "claude-desktop",
        "codex",
        "codebuddy",
        "grok",
        "opencode",
        "workbuddy",
        "zcode",
        "pi",
        "hermes",
        "deepseek-harness",
    ] {
        assert!(find(id).is_some(), "缺少内置平台声明: {id}");
    }
}

/// 元数据快照：13 个平台的关键字段**硬编码期望值**。
/// 迁移后 Platform 读表，两边同源会自证——所以这里用独立快照，
/// 防止有人误改声明（改错立刻红）。
#[test]
fn metadata_snapshot() {
    let expected: &[(&str, &str, &str, &str, &str, Option<&str>, Option<&str>)] = &[
        ("windsurf", "Windsurf", "Codeium", "openai", "settings.json", None, None),
        ("devin", "Devin", "Codeium", "openai", "settings.json", None, None),
        ("cursor", "Cursor", "Anysphere", "openai", "settings.json", None, None),
        ("antigravity", "Antigravity", "Google", "gemini", "settings.json", None, None),
        ("antigravity-ide", "Antigravity IDE", "Google", "gemini", "settings.json", None, None),
        ("claude-code", "Claude Code", "Anthropic", "anthropic", "settings.json", Some("claude"), Some("@anthropic-ai/claude-code")),
        ("claude-desktop", "Claude Desktop", "Anthropic", "anthropic", "", None, None),
        ("codex", "Codex", "OpenAI", "openai", "config.toml", Some("codex"), Some("@openai/codex")),
        // CodeBuddy 是**桌面 IDE**（实测 IDE 1.106.1 vs CLI 2.171.0）：
        // 版本读安装目录，不用同名 CLI，也不引导 npm 更新
        ("codebuddy", "CodeBuddy", "Tencent Cloud", "openai", "models.json", None, None),
        // grok：npm 上无 xAI 官方包（@vibe-kit/grok-cli 是第三方，0.0.34
        // 与本机官方 CLI 1.0.30 不是一个产品）→ npm 置 None，走 grok update
        ("grok", "Grok", "xAI", "openai", "config.toml", Some("grok"), None),
        ("opencode", "OpenCode", "OpenCode", "openai", "opencode.json", Some("opencode"), Some("opencode-ai")),
        ("workbuddy", "WorkBuddy", "Tencent Cloud", "openai", "models.json", None, None),
        ("zcode", "ZCode", "Z.AI", "openai", "config.json", None, None),
        ("pi", "Pi", "Earendil Works", "openai", "models.json", Some("pi"), Some("@earendil-works/pi-coding-agent")),
        ("hermes", "Hermes", "Nous Research", "openai", "config.yaml", Some("hermes"), None),
        ("deepseek-harness", "DeepSeek Harness", "DeepSeek", "openai", "settings.yaml", Some("dsh"), Some("@deepseek-ai/dsh")),
    ];
    for (id, name, vendor, api, file_tail, bin, npm) in expected.iter().copied() {
        let spec = find(id).unwrap_or_else(|| panic!("缺少声明: {id}"));
        assert_eq!(spec.name, name, "{id} 名称被改动");
        assert_eq!(spec.vendor, vendor, "{id} 厂商被改动");
        assert_eq!(spec.api_format, api, "{id} API 格式被改动");
        assert_eq!(spec.bin, bin, "{id} CLI 命令名被改动");
        assert_eq!(spec.npm_package, npm, "{id} npm 包名被改动");
        if !file_tail.is_empty() {
            let path = spec.resolve_config_path().expect("配置路径应可解析");
            let shown = path.to_string_lossy();
            // 声明了多候选文件名时（OpenCode 同时支持 opencode.json / .jsonc），
            // 解析结果命中任一即可；断言只认单一文件名会把合法安装判成失败。
            let mut accepted: Vec<String> = vec![file_tail.to_string()];
            if let FileSource::Candidates(list) = spec.config_file {
                accepted.extend(list.iter().map(|v| v.to_string()));
            }
            assert!(
                accepted.iter().any(|f| shown.ends_with(f.as_str())),
                "{id} 配置文件应为 {accepted:?} 之一，实际 {shown}"
            );
        }
    }
}


