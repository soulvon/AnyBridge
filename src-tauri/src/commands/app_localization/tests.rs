use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use super::*;
use super::claude_desktop_zh::{
    claude_inject_snippet, claude_strip_inject, extract_store_symbols, CLAUDE_ZH_MARKER,
};


#[test]
fn strips_hans_block_and_keeps_other_blocks() {
    let html = "<html><body>\n<!-- byok-cards-start -->\n<script>byok</script>\n<!-- byok-cards-end -->\n<!-- anybridge-hans-start -->\n<script>hans</script>\n<!-- anybridge-hans-end -->\n</body></html>";
    let out = strip_hans_block(html);
    assert!(!out.contains("anybridge-hans-start"));
    assert!(!out.contains("hans"));
    assert!(out.contains("byok-cards-start"));
    assert!(out.contains("byok"));
}

#[test]
fn strip_is_noop_without_block() {
    let html = "<html><body>clean</body></html>";
    assert_eq!(strip_hans_block(html), html);
}

#[test]
fn snapshot_restore_preserves_byok_block() {
    // 快照自愈不能把 BYOK 注入块冲掉（快照可能生成于 BYOK 注入之前）
    let broken = "<html><body><script>hans</script><!-- byok-cards-start -->\n<!-- byok-cards-v1 -->\n<script>byok</script>\n<!-- byok-cards-end -->";
    let snapshot = "<html><body>orig</body></html>";
    let out = snapshot_with_byok_preserved(broken, snapshot);
    assert!(
        out.contains(BYOK_BLOCK_START) && out.contains(BYOK_BLOCK_END),
        "BYOK 块必须保留"
    );
    assert!(out.contains("</body>"), "结构必须完整");
    assert!(
        out.rfind(BYOK_BLOCK_START).unwrap() < out.rfind("</body>").unwrap(),
        "BYOK 块必须写回 body 内"
    );
    // 快照已含 BYOK 块 → 原样返回（不重复拼接）
    let snap_with = "<html><body><!-- byok-cards-start -->x<!-- byok-cards-end --></body></html>";
    assert_eq!(snapshot_with_byok_preserved(broken, snap_with), snap_with);
    // 损坏文件里块不完整（缺 end）→ 绝不拼半截脚本
    let half = "<html><body><!-- byok-cards-start --><script>byok";
    assert_eq!(snapshot_with_byok_preserved(half, snapshot), snapshot);
    // 损坏文件里没有 BYOK 块 → 纯快照
    assert_eq!(snapshot_with_byok_preserved("<html><body>", snapshot), snapshot);
}

#[test]
fn counts_baseline_entries() {
    // 上游快照实测 137 对词条（README 的 300+ 是翻译点口径）。
    let n = count_entries(BASELINE_SCRIPT);
    assert!(n > 100, "基线词库应有 100+ 词条，实际 {}", n);
}

#[test]
fn platform_meta_known_and_unknown() {
    assert!(platform_meta("windsurf").is_some());
    assert!(platform_meta("devin").is_some());
    assert!(platform_meta("cursor").is_some());
    assert!(platform_meta("antigravity-ide").is_some());
    assert!(platform_meta("claude-desktop").is_some());
    assert!(platform_meta("").is_none());
}

#[test]
fn antigravity_ide_meta_does_not_fallback_to_hub_dir() {
    assert_eq!(
        platform_meta("antigravity-ide"),
        Some(("Antigravity IDE", &["Antigravity IDE"][..])),
        "Antigravity IDE 状态目录不得回落到白底桌面端 Antigravity"
    );
}

#[test]
fn builds_cursor_script_from_baseline_dictionary() {
    let script = build_script_from_dictionary(CURSOR_BASELINE_DICT)
        .expect("内置 Cursor 词典应能组装出脚本");
    // 引擎保留（DOM 观察 + 属性翻译）
    assert!(script.contains("MutationObserver"), "应保留通用引擎");
    assert!(script.contains("EXCLUDE_SELECTOR"), "应保留排除选择器");
    // 词典替换为 Cursor 内容
    assert!(script.contains("[\"General\", \"通用\"]"), "应含 Cursor 词条");
    assert!(!script.contains("[\"User Interface\", \"用户界面\"]"), "不应残留 Windsurf 专有词条");
    let n = count_entries(&script);
    assert!(n > 2000, "Cursor 词典应有 2000+ 词条，实际 {}", n);
}

#[test]
fn generated_script_is_valid_js_string_literals() {
    // 生成的脚本里所有字符串字面量必须是双引号且无裸换行（防注入语法错误）
    let script = build_script_from_dictionary(CURSOR_BASELINE_DICT).unwrap();
    for (i, line) in script.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("[\"") {
            assert!(
                t.matches('"').count() >= 4,
                "第 {} 行条目格式异常: {}", i, t
            );
        }
    }
}

#[test]
fn rejects_malformed_dictionary() {
    assert!(build_script_from_dictionary("{}").is_none());
    assert!(build_script_from_dictionary("{\"sections\": []}").is_none());
    assert!(build_script_from_dictionary("not json").is_none());
}

#[test]
fn claude_inject_snippet_declares_two_segment_meta() {
    // 前端解析 meta 的正则只认两段 hash：locale:h1.h2。
    // 写成三段（历史 bug）条目会被静默丢弃 → 语言白名单没有 zh-Hans → 界面不生效。
    let s = claude_inject_snippet("assets/v1/x.js", "Wp");
    assert!(s.contains("zh-Hans:1.1"), "meta 条目必须是两段 hash");
    assert!(!s.contains("zh-Hans:1.1.1"), "不得写成三段");
    assert!(s.contains("mod['Wp']"), "必须按扫描到的导出别名取 store");
    assert!(s.contains(CLAUDE_ZH_MARKER), "必须带注入标记供 keeper 判定");
    assert!(s.contains("setLocaleOverride"), "必须调语言切换 API");
}

#[test]
fn claude_strip_inject_removes_script_only() {
    let injected = format!(
        "<html><head>{}</head><body>app</body></html>",
        claude_inject_snippet("assets/v1/x.js", "Wp")
    );
    let stripped = claude_strip_inject(&injected);
    assert!(!stripped.contains(CLAUDE_ZH_MARKER), "注入脚本必须被剥离");
    assert!(stripped.contains("<body>app</body>"), "页面原有内容必须保留");
    // 未注入的页面剥离后应完全不变（幂等）
    let clean = "<html><head></head><body>app</body></html>";
    assert_eq!(claude_strip_inject(clean), clean);
}

#[test]
fn extract_store_symbols_handles_minified_export() {
    // 真实形态：store 变量在逗号后定义，导出用 `X as Y` 起别名
    let src = r#"var As=Object.keys(Ts),js=Dn((e,t)=>({messages:{},messagesLocale:null,gates:[],setLocaleOverride:t=>e({localeOverride:t})}));export{tk as $,js as Rd,a_ as $a}"#;
    let (sym, exp) = extract_store_symbols(src).expect("应能提取");
    assert_eq!(sym, "js");
    assert_eq!(exp, "Rd");
    // 无导出别名的模块视为无效（不能瞎猜）
    assert!(extract_store_symbols("var x=Dn((e,t)=>({messages:{},messagesLocale:null}))").is_none());
}

#[test]
fn extracts_dictionary_from_localize_js() {
    // 内置基线就是从该格式抽取而来，反向验证基线自身
    let dict = extract_dictionary_from_localize(
        r#"const dictionary = {
	"File": "文件",
	"Open Folder": "打开文件夹",
	"Esc": "\"quoted\"",
};
module.exports = {};"#,
    )
    .expect("应能抽取");
    let entries = dict["sections"][0]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0], json!(["File", "文件"]));
    assert_eq!(entries[2], json!(["Esc", "\"quoted\""]));
    // 结构异常输入
    assert!(extract_dictionary_from_localize("no dictionary here").is_none());
    assert!(extract_dictionary_from_localize("const dictionary = {\n\"a\": \"b\",\n").is_none());
}

/// 损坏判据必须是"结构完整性"，不能是"体积够大"：
/// Devin 原厂 workbench.html 只有约 1.7KB（合法），Windsurf 300KB+，
/// 而中断残骸可以是任意大小——体积无法区分，只有 </body> 能。
/// CSP nonce：script-src 出现 nonce 时 'unsafe-inline' 被忽略，
/// 注入块必须带同名 nonce 才能执行（Devin 有、Windsurf 没有——这是两平台
/// 汉化表现不同的唯一原因）。
#[test]
fn extracts_csp_nonce_from_script_src() {
    let devin_like = r#"<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'self' 'unsafe-eval' blob: 'nonce-0c6a828f1297'; style-src 'self' 'unsafe-inline';">"#;
    assert_eq!(extract_csp_nonce(devin_like).as_deref(), Some("0c6a828f1297"));
    // 无 nonce 的（Windsurf 形态）→ 返回 None，注入退回无 nonce 标签
    let windsurf_like = r#"content="script-src 'self' 'unsafe-eval' blob: 'unsafe-inline';""#;
    assert_eq!(extract_csp_nonce(windsurf_like), None);
    assert_eq!(extract_csp_nonce("no csp here"), None);
}

#[test]
fn small_but_valid_workbench_is_accepted() {
    // Devin 形态：极小但结构完整 → 必须接受
    let devin_like = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script src=\"workbench.js\"></script></body></html>";
    assert!(is_valid_workbench(devin_like), "小而完整的 workbench 必须被接受（{} 字节）", devin_like.len());
    // Windsurf 形态：大而完整 → 接受
    let windsurf_like = format!("<html><head>{}</head><body>app</body></html>", "x".repeat(1000));
    assert!(is_valid_workbench(&windsurf_like));
    // 真正损坏：缺闭合标签（写入被中断）→ 拒绝
    let truncated = "<!DOCTYPE html><html><head><meta http-equiv=\"Content-Security-Policy\"";
    assert!(!is_valid_workbench(truncated), "截断样本（缺 </body>）必须被拒");
    assert!(!is_valid_workbench(""), "空文件必须被拒");
    assert!(!is_valid_workbench("<html><body>unclosed"), "未闭合必须被拒");
}

#[test]
fn windsurf_baseline_module_is_complete() {
    // Windsurf/Devin 用内嵌完整汉化模块（引擎 + 词典一体）：必须带齐引擎四件套
    // 与三类词典，且词条量是人工打磨级别（800+，不是 137 条的小词典）。
    for (name, script) in [
        ("windsurf", BASELINE_SCRIPT),
        ("devin", DEVIN_BASELINE_SCRIPT),
    ] {
        assert!(script.contains("MutationObserver"), "{name} 应有实时观察引擎");
        assert!(script.contains("const TRANSLATIONS = new Map(["), "{name} 应有静态词典");
        assert!(script.contains("const REGEX_TRANSLATIONS"), "{name} 应有正则词典");
        assert!(script.contains("const SOFT_TRANSLATIONS"), "{name} 应有软翻译");
        assert!(script.contains("const EXCLUDE_SELECTOR"), "{name} 应有防误伤排除区");
        assert!(script.contains("function scanAndTranslate"), "{name} 应有全量扫描");
        assert!(script.contains("function startLocalizationObserver"), "{name} 应有观察启动");
        assert!(script.contains("function revertLocalization"), "{name} 应支持还原");
        assert!(script.contains("anybridgeLocStart"), "{name} 应有启动入口");
        assert!(!script.contains("createToggleButton"), "{name} 不得含上游悬浮按钮");
        let n = count_entries(script);
        assert!(n > 500, "{name} 词典应 500+ 词条，实际 {}", n);
    }
    // 平台内容差异：Devin 版有 Devin 专有条目（两者词典各自独立演化）
    assert!(BASELINE_SCRIPT.contains("Windsurf"));
    assert!(DEVIN_BASELINE_SCRIPT.contains("Devin"));
}

#[test]
fn extracts_dictionary_from_windsurf_script() {
    // 用内置基线脚本反向验证抽取（完整模块的 TRANSLATIONS 可被抽回词典 JSON）
    let dict = extract_dictionary_from_windsurf_script(BASELINE_SCRIPT)
        .expect("应能从脚本抽取词典");
    let entries = dict["sections"][0]["entries"].as_array().unwrap();
    assert!(entries.len() > 500, "完整模块应抽出 500+ 词条，实际 {}", entries.len());
    assert_eq!(entries[0], json!(["User Interface", "用户界面"]));
    // 结构异常
    assert!(extract_dictionary_from_windsurf_script("no translations here").is_none());
    assert!(extract_dictionary_from_windsurf_script("const TRANSLATIONS = new Map([").is_none());
}

#[test]
fn unzip_extension_blocks_path_traversal() {
    use std::io::Write;
    let dir = std::env::temp_dir().join("anybridge-test-vsix");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let zip_path = dir.join("evil.vsix");
    let target = dir.join("ext");
    fs::create_dir_all(&target).unwrap();

    let file = fs::File::create(&zip_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    zip.add_directory("extension/sub", options).unwrap();
    zip.start_file("extension/package.json", options).unwrap();
    zip.write_all(b"{}").unwrap();
    // 恶意条目：试图逃出目标目录
    zip.start_file("extension/../../evil.txt", options).unwrap();
    zip.write_all(b"evil").unwrap();
    zip.finish().unwrap();

    // 恶意条目 → 整包拒绝：不出逃、不写入任何内容
    let result = unzip_extension(&zip_path, &target);
    assert!(result.is_err(), "含穿越条目的 VSIX 应被整体拒绝");
    assert!(!dir.join("evil.txt").exists(), "不得写出目标目录之外");
    assert!(
        fs::read_dir(&target).map(|mut d| d.next().is_none()).unwrap_or(true),
        "整体拒绝时不得向目标目录写入任何内容"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ag_ide_entry_htmls_covers_agent_window() {
    // 事故（2026-10-30，IDE 1.107.0）：设置页由独立引导窗口
    // workbench-jetski-agent.html 渲染，只注入 workbench.html 时菜单中文、
    // 设置页仍全英文。入口发现必须把同目录 workbench-*.html 一起纳入。
    let dir = std::env::temp_dir().join("anybridge-test-ag-ide-entries");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let primary = dir.join("workbench.html");
    fs::write(&primary, "<html><body></body></html>").unwrap();
    fs::write(dir.join(AG_IDE_AGENT_WINDOW_HTML), "<html><body></body></html>").unwrap();
    fs::write(dir.join("workbench-future-window.html"), "<html><body></body></html>").unwrap();
    fs::write(dir.join("unrelated.html"), "<html></html>").unwrap();

    let targets = ag_ide_entry_htmls(&primary);
    let names: Vec<String> = targets
        .iter()
        .filter_map(|p| p.file_name().and_then(|v| v.to_str()).map(|s| s.to_string()))
        .collect();
    assert_eq!(names[0], "workbench.html", "主入口必须排第一");
    assert!(
        names.iter().any(|n| n == AG_IDE_AGENT_WINDOW_HTML),
        "必须覆盖设置页入口，实际: {names:?}"
    );
    assert!(
        names.iter().any(|n| n == "workbench-future-window.html"),
        "同目录 workbench-*.html 应自动纳入，实际: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n == "unrelated.html"),
        "不得注入无关 html"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn agent_window_csp_gets_unsafe_inline_without_nonce() {
    // 设置页入口的 CSP 是 script-src 'self' 'unsafe-eval' blob:；
    // 既无 'unsafe-inline' 也无 nonce —— 内联脚本会被 CSP 直接拒绝执行
    // （表现为"注入了但设置页没变"），必须补 'unsafe-inline'。
    let html = r#"<html><head><meta http-equiv="Content-Security-Policy" content="
        script-src
            'self'
            'unsafe-eval'
            blob:
        ;
    " /></head><body></body></html>"#;
    assert_eq!(extract_csp_nonce(html), None, "该窗口没有 nonce");
    let (patched, inserted) = ensure_csp_unsafe_inline(html);
    assert!(inserted, "无 'unsafe-inline' 时必须实际插入");
    assert!(
        patched.contains("'unsafe-inline'"),
        "必须补上 'unsafe-inline'，否则注入的内联脚本不执行"
    );
}

#[test]
fn injection_covers_main_and_agent_window() {
    // 行为门禁：真实跑一遍注入管线，锁住「两个入口都注入 + 设置页补
    // 'unsafe-inline' + 辅助窗口打标记 + 重复注入幂等」。
    // 只断言常量存在守不住这类回归（常量还在、apply 只注入主文件也能过）。
    let dir = std::env::temp_dir().join("anybridge-test-ag-inject");
    let _ = fs::remove_dir_all(&dir);
    let cache = dir.join("cache");
    fs::create_dir_all(&cache).unwrap();

    let main = dir.join("workbench.html");
    fs::write(
        &main,
        r#"<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc123' 'self';" /></head><body></body></html>"#,
    )
    .unwrap();
    let aux = dir.join(AG_IDE_AGENT_WINDOW_HTML);
    fs::write(
        &aux,
        r#"<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-eval' blob:;" /></head><body></body></html>"#,
    )
    .unwrap();

    for p in [&main, &aux] {
        inject_hans_into_with_cache(&cache, "antigravity-ide", "Antigravity IDE", p)
            .expect("注入应成功");
    }

    let main_html = fs::read_to_string(&main).unwrap();
    assert!(main_html.contains(HANS_BLOCK_START), "主入口必须有汉化块");
    assert!(
        main_html.contains("nonce=\"abc123\""),
        "主入口必须继承 CSP nonce"
    );
    assert!(
        !main_html.contains("__anybridgeHansAuxWindow = true;"),
        "主入口不得打辅助窗口标记"
    );

    let aux_html = fs::read_to_string(&aux).unwrap();
    assert!(aux_html.contains(HANS_BLOCK_START), "设置页入口必须有汉化块");
    assert!(
        aux_html.contains("'unsafe-inline'"),
        "设置页 CSP 必须补 'unsafe-inline'"
    );
    assert!(
        aux_html.contains("__anybridgeHansAuxWindow = true;"),
        "设置页入口必须打辅助窗口标记"
    );

    // 幂等：重复注入不得出现两个块
    inject_hans_into_with_cache(&cache, "antigravity-ide", "Antigravity IDE", &aux).unwrap();
    let again = fs::read_to_string(&aux).unwrap();
    assert_eq!(again.matches(HANS_BLOCK_START).count(), 1, "重复注入必须幂等");
    assert!(again.contains("</body>"), "结构必须完整");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn hans_strip_roundtrip_is_byte_exact() {
    // 注入/剥离必须互为精确逆操作：历史上 strip 只删块本体，
    // 注入自带的两个换行逐轮泄漏，还原后原厂校验和揭穿 → 「安装似乎损坏」
    let original = "<html><head></head>\n<body>\n<div>workbench</div>\n</body>\n\n<!-- Startup -->\n<script src=\"./workbench.js\"></script>\n</html>";
    let injection = format!(
        "\n{start}\n{ver}\n{open}\n{script}\n</script>\n{end}\n",
        start = HANS_BLOCK_START,
        ver = HANS_VERSION_MARKER,
        open = "<script>",
        script = "console.log('engine')",
        end = HANS_BLOCK_END,
    );

    let mut cur = original.to_string();
    for round in 0..3 {
        let injected = cur.replace("</body>", &format!("{injection}</body>"));
        cur = strip_hans_block(&injected);
        assert_eq!(
            cur, original,
            "第 {} 轮注入/剥离后必须逐字节回到原样（不得累积换行）",
            round + 1
        );
    }
}

#[test]
fn claude_strip_roundtrip_is_byte_exact() {
    let snippet = claude_inject_snippet("i18n/zh-Hans.json", "zhCatalogs");
    let original = "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"></head>\n<body><div id=\"app\"></div></body></html>";

    // 与 claude_inject_index 同样的注入位置与方式（</head> 前）
    let injected = original.replace("</head>", &format!("{snippet}</head>"));
    let cleaned = claude_strip_inject(&injected);
    assert_eq!(cleaned, original, "剥离必须逐字节还原（含注入片段自带换行）");

    // 重复注入/剥离多轮不得膨胀
    let mut cur = original.to_string();
    for _ in 0..3 {
        let injected = cur.replace("</head>", &format!("{snippet}</head>"));
        cur = claude_strip_inject(&injected);
    }
    assert_eq!(cur, original, "多轮注入/剥离不得累积字节");
}

#[test]
fn locale_revert_restores_previous_value_or_removes_key() {
    // argv.json 是 JSONC：回滚必须保形（注释/其余键全保留），绝不能空对象覆盖
    let raw = "{\n  // 用户注释\n  \"locale\": \"zh-cn\",\n  \"disable-hardware-acceleration\": false\n}";

    let out = revert_locale_in_argv(raw, &LocaleRecord::Was("en".into())).unwrap();
    let doc: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(doc["locale"], json!("en"), "必须回到改前值");
    assert!(
        doc.get("disable-hardware-acceleration").is_some(),
        "其余键必须保留"
    );

    let out = revert_locale_in_argv(raw, &LocaleRecord::Absent).unwrap();
    let doc: Value = serde_json::from_str(&out).unwrap();
    assert!(doc.get("locale").is_none(), "改前无键则删除该键");
    assert!(doc.get("disable-hardware-acceleration").is_some());

    // JSONC 解析失败必须返回 None：宁可不动也不能覆盖用户配置
    assert_eq!(revert_locale_in_argv("not json{", &LocaleRecord::Absent), None);
}

#[test]
fn aux_window_script_marks_flag_and_engine_honors_it() {
    // 辅助窗口（设置页）没有 .monaco-workbench 根节点，若沿用主窗口的
    // "隐藏首屏 + 等根节点"逻辑会白屏到 6 秒超时。脚本必须打标记，
    // 引擎必须保留读取标记的分支。
    assert!(
        BASELINE_SCRIPT.contains("__anybridgeHansAuxWindow"),
        "引擎必须保留辅助窗口快速启动分支"
    );
    let main = hans_script_for_window("antigravity-ide", false);
    assert!(
        !main.contains("__anybridgeHansAuxWindow = true;"),
        "主窗口不得设置辅助窗口标记"
    );
    let aux = hans_script_for_window("antigravity-ide", true);
    assert!(
        aux.starts_with("window.__anybridgeHansAuxWindow = true;"),
        "辅助窗口脚本首行必须置标记"
    );
    assert!(aux.contains("MutationObserver"), "引擎本体必须保留");
    assert_eq!(
        count_entries(&aux),
        count_entries(&main),
        "标记行不得影响词条统计（面板显示会失真）"
    );
}

#[test]
fn cached_dictionary_merges_with_baseline() {
    // 缓存词典是完整快照：直接替代基线会吞掉后来新增的内置词条
    // （实测：设置页新加的 15 条在更新过词库的机器上完全不生效）。
    let base = r#"{"sections":[{"id":"a","title":"a","entries":[["A","甲"],["B","乙"]]}]}"#;
    let cached = r#"{"sections":[{"id":"a","title":"a","entries":[["B","乙2"],["C","丙"]]}]}"#;
    let merged = merge_dictionaries(base, cached);
    let v: Value = serde_json::from_str(&merged).unwrap();
    let entries = v["sections"][0]["entries"].as_array().unwrap();
    let mut map = std::collections::HashMap::new();
    for e in entries {
        map.insert(
            e[0].as_str().unwrap().to_string(),
            e[1].as_str().unwrap().to_string(),
        );
    }
    assert_eq!(map.get("A").map(String::as_str), Some("甲"), "基线新增词条必须保留");
    assert_eq!(map.get("B").map(String::as_str), Some("乙2"), "缓存同名词条必须覆盖基线");
    assert_eq!(map.get("C").map(String::as_str), Some("丙"), "缓存独有词条必须保留");
    // 两侧都损坏时绝不产出空词典：退回可用的那一侧
    assert_eq!(merge_dictionaries("", cached), cached);
    assert_eq!(merge_dictionaries(base, "not json"), base);
}

#[test]
fn ag_ide_baseline_dictionary_is_usable() {
    let script = build_script_from_dictionary(AG_IDE_BASELINE_DICT)
        .expect("AG IDE 基线词典应能组装出脚本");
    assert!(script.contains("MutationObserver"), "应保留通用引擎");
    assert!(script.contains("[\"File\", \"文件\"]"), "应含 AG 词条");
    let n = count_entries(&script);
    assert!(n > 2000, "AG IDE 词典应 2000+ 词条，实际 {}", n);
}

#[test]
fn restore_strips_hans_block_and_keeps_byok() {
    // 还原必须只剥离汉化块，保留 BYOK 注入块（备份覆盖会抹掉 byok → 接入失效）。
    // 这里直接验证 strip 语义：含两个块时只去掉 ours。
    let html = "<html><body>\n<!-- byok-cards-start -->\n<script>byok</script>\n<!-- byok-cards-end -->\n<!-- anybridge-hans-start -->\n<script>hans</script>\n<!-- anybridge-hans-end -->\n</body></html>";
    let cleaned = strip_hans_block(html);
    assert!(cleaned.contains("byok-cards-start"), "BYOK 块必须保留");
    assert!(cleaned.contains("byok"));
    assert!(!cleaned.contains("anybridge-hans-start"), "汉化块必须移除");
    assert!(cleaned.contains("</body>"), "结构必须完整");
}

#[test]
fn restore_reports_incomplete_hans_block() {
    // 块标记不完整时不能做危险的整体覆盖：调用方据此报错并保留备份
    let html = "<html><body><!-- anybridge-hans-start --><script>x</script></body></html>";
    assert!(html.contains(HANS_BLOCK_START));
    assert!(!html.contains(HANS_BLOCK_END), "缺少结束标记 = 异常态");
    assert_eq!(strip_hans_block(html), html, "异常态下 strip 应原样返回");
}

#[test]
fn parses_version_dir() {
    assert_eq!(parse_version_dir("app-1.2.3"), vec![1, 2, 3]);
    assert_eq!(parse_version_dir("app-2.0.10"), vec![2, 0, 10]);
    assert_eq!(parse_version_dir("resources"), Vec::<u32>::new());
}

#[test]
fn picks_latest_claude_version_dir() {
    // Claude 升级后旧版本目录残留：必须选版本号最大的，否则等于没汉化
    let root = std::env::temp_dir().join("anybridge-test-claude-pick");
    let _ = fs::remove_dir_all(&root);
    let layout = |ver: &str| {
        root.join(ver)
            .join("resources")
            .join("app")
            .join("resources")
            .join("ion-dist")
    };
    for ver in ["app-1.0.0", "app-2.3.1", "app-1.9.9"] {
        let dir = layout(ver);
        fs::create_dir_all(&dir).unwrap();
        // 只认含 index.html 的目录（ion-dist 的判定依据）
        fs::write(dir.join("index.html"), "<html></html>").unwrap();
    }
    let picked = pick_claude_ion_dist(&root).expect("应定位到 ion-dist");
    assert!(
        picked.to_string_lossy().contains("app-2.3.1"),
        "应选最新版本目录，实际: {}",
        picked.display()
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn is_installed_uses_platform_specific_path() {
    // claude 与 vscode 系判定来源不同，但 keeper 与 status 必须共用同一结果
    for p in ["cursor", "windsurf", "devin"] {
        assert_eq!(is_installed(p), workbench_html_path(p).is_some());
    }
    // 未知平台一律未安装
    assert!(!is_installed("nope"));
}

#[test]
fn mirror_candidates_keeps_original_first() {
    let original = "https://raw.githubusercontent.com/a/b/main/c.js";
    let candidates = crate::commands::extensions::mirror_candidates(original);
    assert_eq!(candidates[0], original, "原始 URL 必须排第一");
    // 默认镜像里的 ghfast/ghps 是前缀型，对 raw URL 应产生改写候选
    assert!(
        candidates.iter().any(|u| u.starts_with("https://ghfast.top/")),
        "应包含 ghfast 前缀镜像: {:?}",
        candidates
    );
    // 无重复、无空串
    assert!(candidates.iter().all(|u| !u.is_empty()));
    assert_eq!(candidates.len(), candidates.iter().collect::<std::collections::HashSet<_>>().len());
}

#[test]
fn engine_version_prefers_vscode_version_field() {
    // 假 product.json：version 是发行版号（Cursor 3.15.6），vscodeVersion 是引擎号（1.128.0）
    let dir = std::env::temp_dir().join("anybridge-test-engine-ver");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("product.json"),
        r#"{"version":"3.15.6","vscodeVersion":"1.128.0"}"#,
    )
    .unwrap();
    let val: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("product.json")).unwrap()).unwrap();
    let engine = val
        .get("vscodeVersion")
        .and_then(|x| x.as_str())
        .or_else(|| val.get("version").and_then(|x| x.as_str()))
        .map(|s| s.to_string());
    assert_eq!(engine.as_deref(), Some("1.128.0"), "应优先取 vscodeVersion");
    // 无 vscodeVersion 时回退 version（Windsurf 系行为）
    let val2: Value = serde_json::from_str(r#"{"version":"1.110.1"}"#).unwrap();
    let engine2 = val2
        .get("vscodeVersion")
        .and_then(|x| x.as_str())
        .or_else(|| val2.get("version").and_then(|x| x.as_str()))
        .map(|s| s.to_string());
    assert_eq!(engine2.as_deref(), Some("1.110.1"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn claude_io_paths_are_relative_safe() {
    // 注入脚本里的 store 路径必须是相对 ion-dist 根的 URL 路径（以 / 开头），
    // 且不能带反斜杠——Windows 路径直接拼进 import() 会让前端 404。
    let rel = "assets/v1/shared-52-uHFNjl7C.js";
    let s = claude_inject_snippet(rel, "Wp");
    assert!(s.contains("import('/assets/v1/shared-52-uHFNjl7C.js')"), "路径应为根相对 URL");
    assert!(!s.contains("import('/assets\\\\"), "不得出现反斜杠路径");
}

#[test]
fn to_ide_path_lowercases_drive_and_uses_backslash() {
    // IDE languagepacks.json 的路径格式：小写盘符 + 反斜杠
    assert_eq!(
        to_ide_path(Path::new("C:/Users/test/.windsurf/extensions/p/translations/main.i18n.json")),
        "c:\\Users\\test\\.windsurf\\extensions\\p\\translations\\main.i18n.json"
    );
    assert_eq!(to_ide_path(Path::new("relative/path.json")), "relative\\path.json");
}

#[test]
fn parses_jsonc_argv() {
    // VS Code  argv.json 是带注释的 JSONC
    let raw = "// comment\n{\n\t// \"disable-hardware-acceleration\": true,\n\t\"enable-crash-reporter\": true,\n\t\"locale\": \"en\"\n}";
    let v = parse_jsonc(raw).expect("JSONC 应可解析");
    assert_eq!(v["enable-crash-reporter"], json!(true));
    assert_eq!(v["locale"], json!("en"));
    // 注释行里的键不应被解析进来
    assert!(v.get("disable-hardware-acceleration").is_none());
    assert!(parse_jsonc("not json").is_none());
}

#[test]
fn enabled_marker_lifecycle() {
    let platform = "windsurf";
    let path = enabled_marker_path(platform);
    // 保留测试前状态，避免误删用户已开启的保活标记
    let backup = if path.exists() {
        fs::read(&path).ok()
    } else {
        None
    };
    clear_enabled(platform);
    assert!(!is_enabled(platform));
    set_enabled(platform);
    assert!(is_enabled(platform));
    clear_enabled(platform);
    assert!(!is_enabled(platform));
    match backup {
        Some(bytes) => {
            let _ = fs::write(&path, bytes);
        }
        None => {
            let _ = fs::remove_file(&path);
        }
    }
}

#[test]
fn keeper_skips_when_not_enabled_or_alive() {
    // 纯函数语义：未开启 → 不重注入（与安装状态无关）
    assert!(!keeper_should_reinject("windsurf", false));
    // 开启了：已汉化（标记在）→ 不重注入；未汉化且已安装 → 重注入；未安装 → 不重注入
    if workbench_html_path("windsurf").is_some() && !is_localized("windsurf") {
        assert!(keeper_should_reinject("windsurf", true));
    } else {
        assert!(!keeper_should_reinject("windsurf", true));
    }
    // 不支持的平台一律不重注入
    assert!(!keeper_should_reinject("cursor-not-exist", true));
}
