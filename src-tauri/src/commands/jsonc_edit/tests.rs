use super::*;

const COMMENTED: &str = r#"{
  // 用户注释：这些配置手动维护
  "theme": "dark",
  "env": {
/* 块注释 */
"ANTHROPIC_BASE_URL": "https://corp.example",
"OTHER_KEY": "keep",
  },
  "includeCoAuthoredBy": true,
}"#;

#[test]
fn set_existing_key_replaces_value_only() {
    let out = set_key(
        COMMENTED,
        &["env", "ANTHROPIC_BASE_URL"],
        &JsoncValue::Str("http://127.0.0.1:8317".into()),
    )
    .unwrap();
    assert!(out.contains("// 用户注释"), "注释必须保留");
    assert!(out.contains("/* 块注释 */"), "块注释必须保留");
    assert!(out.contains("\"ANTHROPIC_BASE_URL\": \"http://127.0.0.1:8317\""));
    assert!(out.contains("\"OTHER_KEY\": \"keep\""), "其它键必须保留");
    assert!(out.contains("\"theme\": \"dark\""), "键顺序与其它成员保留");
    // 逗号结构仍然合法（尾逗号是 JSONC 合法扩展，解析应通过）
    let parsed = parse_lenient(&out);
    assert_eq!(
        parsed["env"]["ANTHROPIC_BASE_URL"],
        "http://127.0.0.1:8317"
    );
}

fn parse_lenient(raw: &str) -> Json {
    // 测试辅助：剥注释与尾逗号后解析（等价 json5 宽松语义的简化版）
    let mut clean = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i..].starts_with("//") {
            while i < raw.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if raw[i..].starts_with("/*") {
            i += raw[i + 2..].find("*/").unwrap() + 4;
            continue;
        }
        if bytes[i] == b'"' {
            let end = scan_string(raw, i).unwrap();
            clean.push_str(&raw[i..end]);
            i = end;
            continue;
        }
        clean.push(bytes[i] as char);
        i += 1;
    }
    // 去尾逗号：}, 前
    let mut out = String::with_capacity(clean.len());
    let chars: Vec<char> = clean.chars().collect();
    for (idx, c) in chars.iter().enumerate() {
        if *c == ',' {
            let rest: String = chars[idx + 1..].iter().collect();
            if rest.trim_start().starts_with('}') || rest.trim_start().starts_with(']') {
                continue;
            }
        }
        out.push(*c);
    }
    serde_json::from_str(&out).unwrap()
}

#[test]
fn set_missing_key_inserts_into_existing_object() {
    let out = set_key(
        COMMENTED,
        &["env", "NEW_MODEL"],
        &JsoncValue::Str("claude-x".into()),
    )
    .unwrap();
    assert!(out.contains("\"NEW_MODEL\": \"claude-x\""));
    assert!(out.contains("// 用户注释"));
    let parsed = parse_lenient(&out);
    assert_eq!(parsed["env"]["NEW_MODEL"], "claude-x");
    assert_eq!(parsed["env"]["OTHER_KEY"], "keep");
}

#[test]
fn set_creates_missing_intermediate_object() {
    let raw = "{\n  \"a\": 1\n}";
    let out = set_key(
        raw,
        &["env", "ANTHROPIC_BASE_URL"],
        &JsoncValue::Str("http://x".into()),
    )
    .unwrap();
    assert!(out.contains("\"a\": 1"), "既有键保留");
    let parsed = parse_lenient(&out);
    assert_eq!(parsed["env"]["ANTHROPIC_BASE_URL"], "http://x");
}

#[test]
fn set_on_empty_file_renders_nested_object() {
    let out = set_key(
        "",
        &["env", "ANTHROPIC_BASE_URL"],
        &JsoncValue::Str("http://x".into()),
    )
    .unwrap();
    let parsed: Json = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(parsed["env"]["ANTHROPIC_BASE_URL"], "http://x");
}

#[test]
fn set_preserves_bool_and_order() {
    let out = set_key(COMMENTED, &["includeCoAuthoredBy"], &JsoncValue::Bool(false))
        .unwrap();
    assert!(out.contains("\"includeCoAuthoredBy\": false"));
    assert!(out.contains("\"includeCoAuthoredBy\": true") == false);
    assert!(out.contains("// 用户注释"));
}

#[test]
fn remove_member_and_fix_trailing_comma() {
    // 删除最后一个成员（前面有尾逗号）→ 前后逗号都修整，剩余是合法 JSON
    let raw = "{\n  \"a\": 1,\n  \"b\": 2,\n}";
    let out = remove_key(raw, &["b"]).unwrap();
    let parsed: Json = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(parsed["a"], 1);
    assert!(parsed.get("b").is_none());
    // 删除中间成员（后面有逗号）→ 连逗号一起删；前成员成为最后成员，
    // 其原有的尾逗号风格保留（JSONC 合法）
    let out2 = remove_key(raw, &["a"]).unwrap();
    let parsed2 = parse_lenient(&out2);
    assert_eq!(parsed2["b"], 2);
    assert!(parsed2.get("a").is_none());
}

#[test]
fn remove_missing_key_is_noop() {
    assert_eq!(remove_key(COMMENTED, &["env", "NOT_THERE"]).unwrap(), COMMENTED);
}

#[test]
fn crlf_and_bom_preserved() {
    let raw = "\u{feff}{\r\n  \"a\": \"old\",\r\n  // comment\r\n  \"b\": 2\r\n}";
    let out = set_key(raw, &["a"], &JsoncValue::Str("new".into())).unwrap();
    assert!(out.starts_with("\u{feff}"), "BOM 必须保留");
    assert!(out.contains("\r\n"), "CRLF 必须保留");
    assert!(out.contains("// comment"));
    assert!(out.contains("\"a\": \"new\""));
}

#[test]
fn string_and_comment_content_do_not_confuse_scanner() {
    let raw = r#"{
  "trap": "fake } key { // not comment",
  "real": "old"
}"#;
    let out = set_key(raw, &["real"], &JsoncValue::Str("new".into())).unwrap();
    assert!(out.contains("fake } key { // not comment"), "字符串内容不能被破坏");
    assert!(out.contains("\"real\": \"new\""));
    let raw2 = r#"{
  // "decoy": "comment value"
  "real": "old"
}"#;
    let out2 = set_key(raw2, &["real"], &JsoncValue::Str("new".into())).unwrap();
    assert!(out2.contains("// \"decoy\": \"comment value\""));
}

#[test]
fn invalid_json_is_rejected_not_rewritten() {
    let err = set_key("{ broken", &["a"], &JsoncValue::Str("x".into()));
    assert!(err.is_err(), "非法输入必须报错");
}

#[test]
fn get_string_reads_nested_value() {
    assert_eq!(
        get_string(COMMENTED, &["env", "ANTHROPIC_BASE_URL"]),
        Some("https://corp.example".to_string())
    );
    assert_eq!(get_string(COMMENTED, &["env", "MISSING"]), None);
    assert_eq!(get_string("", &["a"]), None);
}

#[test]
fn raw_object_value_roundtrip() {
    let raw = r#"{
  // 注释
  "provider": {
"user-own": { "npm": "@ai-sdk/x" }
  }
}"#;
    // 写入对象值（Raw）
    let out = set_key(
        raw,
        &["provider", "managed-deepseek"],
        &JsoncValue::Raw(r#"{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:8317/v1"}}"#.into()),
    )
    .unwrap();
    assert!(out.contains("// 注释"), "注释必须保留");
    assert!(out.contains("\"user-own\""), "既有成员必须保留");
    // 读回原文本并验证结构相等
    let text = get_raw_text(&out, &["provider", "managed-deepseek"]).unwrap();
    assert!(raw_text_matches_json(
        &text,
        r#"{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:8317/v1"}}"#
    ));
    // 删除对象成员
    let out2 = remove_key(&out, &["provider", "managed-deepseek"]).unwrap();
    assert!(get_raw_text(&out2, &["provider", "managed-deepseek"]).is_none());
    assert!(out2.contains("\"user-own\""));
    assert!(out2.contains("// 注释"));
}

#[test]
fn raw_text_matches_json_is_order_insensitive() {
    assert!(raw_text_matches_json(
        r#"{ "b": 1, "a": 2 }"#,
        r#"{"a":2,"b":1}"#
    ));
    assert!(!raw_text_matches_json(r#"{ "a": 2 }"#, r#"{"a":3}"#));
    assert!(!raw_text_matches_json("not json", r#"{"a":3}"#));
}

#[test]
fn object_and_array_insert_aligns_four_space_indent_and_keeps_comments() {
    let raw = r#"{
    // 顶部注释
    "env": {
        "KEEP": "v1"
    }
}"#;
    let obj_map = serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "options": {
            "baseURL": "http://127.0.0.1:8317/v1",
            "models": [
                "gpt-5",
                { "id": "o3", "enabled": true }
            ]
        }
    })
    .as_object()
    .unwrap()
    .clone();
    let obj = JsoncValue::Object(obj_map);
    let out = set_key(raw, &["provider", "managed"], &obj).unwrap();
    assert!(out.contains("// 顶部注释"), "顶层注释不得丢失");
    assert!(out.contains("\"KEEP\": \"v1\""), "兄弟子树不得丢失");
    assert!(
        out.contains("\n    \"provider\": {\n        \"managed\": {"),
        "新增 4 空格缩进的对象层级应对齐: {out}"
    );
    assert!(
        out.contains("            \"npm\": \"@ai-sdk/openai-compatible\","),
        "嵌套对象字段应逐级对齐 4 空格: {out}"
    );
    let cleaned = out
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let parsed: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
    assert_eq!(parsed["provider"]["managed"]["options"]["models"][0], "gpt-5");
    assert_eq!(
        parsed["provider"]["managed"]["options"]["models"][1]["enabled"],
        true
    );
}

#[test]
fn object_and_array_replace_subtree_keeps_siblings_and_roundtrips() {
    let raw = r#"{
  // 保留用户注释
  "items": [
    "old-1",
    "old-2"
  ],
  "provider": {
    "user": { "apiKey": "keep" },
    "target": {
      "options": { "baseURL": "https://old.example" }
    }
  }
}"#;
    let updated_arr = JsoncValue::Array(vec![serde_json::json!("new-1"), serde_json::json!(42)]);
    let out1 = set_key(raw, &["items"], &updated_arr).unwrap();
    let updated_obj_map = serde_json::json!({
        "options": { "baseURL": "https://new.example/v1" }
    })
    .as_object()
    .unwrap()
    .clone();
    let out2 = set_key(&out1, &["provider", "target"], &JsoncValue::Object(updated_obj_map)).unwrap();
    assert!(out2.contains("// 保留用户注释"));
    assert!(out2.contains("\"user\": { \"apiKey\": \"keep\" }"));
    let target_raw = get_raw_text(&out2, &["provider", "target"]).unwrap();
    assert!(raw_text_matches_json(
        &target_raw,
        r#"{"options":{"baseURL":"https://new.example/v1"}}"#
    ));
    let items_raw = get_raw_text(&out2, &["items"]).unwrap();
    assert!(raw_text_matches_json(&items_raw, r#"["new-1",42]"#));
}

#[test]
fn jsonc_render_returns_valid_json_for_nested_object_and_array() {
    let val_map = serde_json::json!({
        "name": "demo",
        "tags": ["a", null]
    })
    .as_object()
    .unwrap()
    .clone();
    let val = JsoncValue::Object(val_map);
    let rendered = val.render();
    let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert_eq!(parsed["name"], "demo");
    assert_eq!(parsed["tags"][1], serde_json::Value::Null);
}
