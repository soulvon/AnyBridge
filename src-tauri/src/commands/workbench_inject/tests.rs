use super::*;

#[test]
fn byok_strip_roundtrip_is_byte_exact() {
    let original = "<html><body>\n<div>workbench</div>\n</body>\n\n<!-- Startup -->\n";
    let injection = format!(
        "\n{start}\n{ver}\n{open}\n{script}\n</script>\n{end}\n",
        start = BYOK_BLOCK_START,
        ver = BYOK_VERSION_MARKER,
        open = "<script>",
        script = "console.log('byok')",
        end = BYOK_BLOCK_END,
    );

    let mut cur = original.to_string();
    for round in 0..3 {
        let injected = cur.replace("</body>", &format!("{injection}</body>"));
        cur = strip_byok_block(&injected);
        assert_eq!(
            cur, original,
            "第 {} 轮 BYOK 注入/剥离后必须逐字节回到原样",
            round + 1
        );
    }
}

#[test]
fn align_content_converges_leaked_newlines() {
    // 模拟存量泄漏：pristine + 每轮 2 个换行 × 2 轮 = +4
    let pristine = "<html><body>\n<div>workbench</div>\n</body>\n</html>";
    let want = content_hash_b64(pristine);
    let leaked = pristine.replace("</body>", "\n\n\n\n</body>");

    let aligned = align_content_with_checksum(&leaked, &want).expect("应能收敛到原厂字节");
    assert_eq!(aligned, pristine, "对齐后必须逐字节等于原厂内容");

    // 差异不是换行（真实内容被改）：绝不盲改，如实放弃
    let broken = pristine.replace("workbench", "changed");
    assert!(align_content_with_checksum(&broken, &want).is_none());
}

#[test]
fn csp_unsafe_inline_revert_is_exact_inverse() {
    // ensure 的插入必须能被 revert 精确撤销——否则"还原英文"会永久削弱 CSP
    let html = "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'self';\" />";
    let (patched, inserted) = ensure_csp_unsafe_inline(html);
    assert!(inserted, "无 'unsafe-inline' 时必须实际插入");
    assert_eq!(revert_csp_unsafe_inline(&patched), html, "revert 必须精确还原原字节");

    // 原厂自带 'unsafe-inline'（缩进与我们插入的不同）：不得插入、回滚不得动它
    let own = "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src\n\t\t\t'unsafe-inline'\n\t\t\t'self';\" />";
    let (p2, inserted2) = ensure_csp_unsafe_inline(own);
    assert!(!inserted2, "原厂已带 'unsafe-inline' 时不得重复插入");
    assert_eq!(revert_csp_unsafe_inline(&p2), own, "回滚绝不能误删原厂自带的放行");
}

#[test]
fn strips_byok_block_and_keeps_hans_block() {
    // 还原 BYOK 只剥自己的块：汉化注入块必须原样保留（备份覆盖会抹掉它）
    let html = "<html><body>\n<!-- byok-cards-start -->\n<!-- byok-cards-v1 -->\n<script>byok</script>\n<!-- byok-cards-end -->\n<!-- anybridge-hans-start -->\n<script>hans</script>\n<!-- anybridge-hans-end -->\n</body></html>";
    let out = strip_byok_block(html);
    assert!(!out.contains("byok-cards-start"), "BYOK 块必须移除");
    assert!(!out.contains("byok"));
    assert!(out.contains(HANS_BLOCK_START), "汉化块必须保留");
    assert!(out.contains("hans"));
    assert!(out.contains("</body>"), "结构必须完整");
    // 反向：只有汉化块时 strip byok 是 noop
    let only_hans = "<html><body><!-- anybridge-hans-start --><script>hans</script><!-- anybridge-hans-end --></body></html>";
    assert_eq!(strip_byok_block(only_hans), only_hans);
}

/// 把定位到的 checksums 对象替换成 {}，返回处理后的完整内容。
fn cleared(content: &str) -> Option<String> {
    let (s, e) = find_checksums_object(content)?;
    Some(format!("{}{{}}{}", &content[..s], &content[e..]))
}

#[test]
fn locates_top_level_checksums() {
    let content = r#"{"nameShort":"Devin","checksums":{"vs/a.js":"h1","vs/b.js":"h2"},"version":"1.0"}"#;
    let (s, e) = find_checksums_object(content).expect("应定位到顶层 checksums");
    assert_eq!(&content[s..e], r#"{"vs/a.js":"h1","vs/b.js":"h2"}"#);

    let out = cleared(content).unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["checksums"], serde_json::json!({}));
    assert_eq!(v["nameShort"], "Devin");
    assert_eq!(v["version"], "1.0");
}

#[test]
fn ignores_nested_checksums() {
    let content = r#"{"nested":{"checksums":{"x":"inner"}},"checksums":{"vs/a.js":"outer"}}"#;
    let (s, e) = find_checksums_object(content).unwrap();
    assert_eq!(&content[s..e], r#"{"vs/a.js":"outer"}"#);
}

#[test]
fn string_value_named_checksums_is_not_a_key() {
    // 顶层某个值恰好是字符串 "checksums" 时，不能被当成键，否则会误清空下一个对象。
    let content = r#"{"tip":"checksums","other":{"checksums":{"x":"inner"}}}"#;
    assert!(find_checksums_object(content).is_none());
}

#[test]
fn returns_none_without_checksums_object() {
    assert!(find_checksums_object(r#"{"checksums":null}"#).is_none());
    assert!(find_checksums_object(r#"{"nameShort":"Devin"}"#).is_none());
    assert!(find_checksums_object("not json at all").is_none());
}

#[test]
fn handles_escapes_and_braces_in_values() {
    let content = r#"{"note":"he said \"{}\" ok","checksums":{"vs/a.js":"h"}}"#;
    let (s, e) = find_checksums_object(content).unwrap();
    assert_eq!(&content[s..e], r#"{"vs/a.js":"h"}"#);

    let out = cleared(content).unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["note"], "he said \"{}\" ok");
}

// ── NLS 容错加固 ──────────────────────────────────────────

#[test]
fn replaces_single_nls_throw() {
    let content = r#"function lAo(r,i){let e=tit()?.[r];if(typeof e!="string"){if(typeof i=="string")return i;throw new Error(`!!! NLS MISSING: ${r} !!!`)}return e}"#;
    let (out, count) = replace_nls_throws(content).expect("应替换成功");
    assert_eq!(count, 1);
    assert!(!out.contains("NLS MISSING"), "替换后不应残留 NLS MISSING");
    assert!(out.contains("return \"\""), "应包含 return \"\"");
    // 函数其余部分不变
    assert!(out.contains("function lAo(r,i)"));
    assert!(out.contains("return e}"));
}

#[test]
fn replaces_multiple_nls_throws() {
    let content = "a throw new Error(`!!! NLS MISSING: ${x} !!!`) b throw new Error(`!!! NLS MISSING: ${y} !!!`) c";
    let (out, count) = replace_nls_throws(content).expect("应替换成功");
    assert_eq!(count, 2);
    assert_eq!(out.matches("NLS MISSING").count(), 0);
    assert_eq!(out.matches("return \"\"").count(), 2);
}

#[test]
fn returns_none_when_no_nls_throw() {
    assert!(replace_nls_throws("no nls here").is_none());
    assert!(replace_nls_throws("").is_none());
}

#[test]
fn idempotent_after_patch() {
    let content = r#"throw new Error(`!!! NLS MISSING: ${r} !!!`)"#;
    let (patched, _) = replace_nls_throws(content).unwrap();
    // 修补后再跑一次应无匹配
    assert!(replace_nls_throws(&patched).is_none());
}

#[test]
fn handles_different_variable_names() {
    // 不同版本 minified 变量名不同，确保都能匹配
    let content = "throw new Error(`!!! NLS MISSING: ${messageId} !!!`)";
    let (out, _) = replace_nls_throws(content).unwrap();
    assert!(!out.contains("NLS MISSING"));
}
