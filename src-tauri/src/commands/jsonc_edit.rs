//! jsonc_edit —— JSON/JSONC 保形编辑。
//!
//! 背景：`serde_json::to_string_pretty` 全量重写会丢注释、把键序重排成
//! 字典序（serde_json 未开 preserve_order）。`toml_edit` 证明了对 TOML
//! 保形的正确性；本模块把同样的纪律带给 JSON/JSONC：**只动目标键值对
//! 的文本区间**，注释、键顺序、缩进、CRLF、BOM 全部保留。
//!
//! 失败纪律：定位/解析失败一律报错中止，绝不退回「全量重写」——静默
//! 破坏比报错难查十倍（对齐坑点 `byok-strip-must-keep-hans` 的教训）。
//!
//! 门控：`ANYBRIDGE_FORMAT_PRESERVING_JSON`（默认关闭）。关闭时调用方
//! 走原有 serde_json 路径，行为与旧版本完全一致。
//!
//! 支持范围（够用且可验证）：
//! - 值类型：字符串 / bool / 数字（配置切换场景的全部标量）
//! - set：键已存在 → 原位替换值；键不存在 → 在该层插入（含逐层创建
//!   中间对象）；根文件为空 → 渲染嵌套对象
//! - remove：删除成员并修整逗号（含「最后一个成员」的悬空尾逗号）
//! - get_string：读取字符串值（回显/漂移检测用）

use serde_json::Value as Json;

/// 门控：保形写入是否开启（默认关闭）。
pub fn format_preserving_enabled() -> bool {
    match std::env::var("ANYBRIDGE_FORMAT_PRESERVING_JSON") {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "on"
        }
        Err(_) => false,
    }
}

/// 可写入的值（标量 + 预渲染对象/数组）。
#[derive(Debug, Clone, PartialEq)]
pub enum JsoncValue {
    Str(String),
    Bool(bool),
    Num(f64),
    /// 预渲染的 JSON 文本（对象/数组），原样写入；调用方负责其合法性。
    /// 用于 OpenCode/ZCode 这类「受管字段是整个 provider 对象」的平台。
    Raw(String),
}

impl JsoncValue {
    pub fn render(&self) -> String {
        match self {
            JsoncValue::Str(s) => Json::String(s.clone()).to_string(),
            JsoncValue::Bool(b) => b.to_string(),
            JsoncValue::Num(n) => match serde_json::Number::from_f64(*n) {
                Some(num) => Json::Number(num).to_string(),
                None => "null".to_string(),
            },
            JsoncValue::Raw(text) => text.clone(),
        }
    }

    pub fn from_json(v: &Json) -> Option<Self> {
        match v {
            Json::String(s) => Some(JsoncValue::Str(s.clone())),
            Json::Bool(b) => Some(JsoncValue::Bool(*b)),
            Json::Number(n) => n.as_f64().map(JsoncValue::Num),
            Json::Object(_) | Json::Array(_) => {
                Some(JsoncValue::Raw(v.to_string()))
            }
            _ => None,
        }
    }
}

/// 一个对象成员在原文中的文本区间。
#[derive(Debug, Clone)]
struct MemberOwned {
    key: String,
    key_start: usize,
    value_start: usize,
    value_end: usize,
}

fn is_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// 跳过空白与注释（// 与 /* */），返回下一个有效字符位置。
fn skip_ws_comments(raw: &str, mut i: usize) -> Result<usize, String> {
    let bytes = raw.as_bytes();
    loop {
        // BOM（EF BB BF 三字节）：按字符前缀特判（u8 as char 不等于 U+FEFF）
        if raw[i..].starts_with('\u{feff}') {
            i += '\u{feff}'.len_utf8();
            continue;
        }
        while i < raw.len() && is_ws(bytes[i] as char) {
            i += 1;
        }
        if raw[i..].starts_with("//") {
            i = raw[i..]
                .find('\n')
                .map(|p| i + p + 1)
                .ok_or_else(|| "注释未闭合（到文件尾）".to_string())?;
            continue;
        }
        if raw[i..].starts_with("/*") {
            let end = raw[i + 2..]
                .find("*/")
                .ok_or_else(|| "块注释未闭合".to_string())?;
            i = i + 2 + end + 2;
            continue;
        }
        return Ok(i);
    }
}

/// 从 `i`（应指向 '"'）扫描一个完整 JSON 字符串，返回结束位置（引号后）。
fn scan_string(raw: &str, mut i: usize) -> Result<usize, String> {
    let bytes = raw.as_bytes();
    if bytes[i] != b'"' {
        return Err("期望字符串起点".to_string());
    }
    i += 1;
    while i < raw.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err("字符串未闭合".to_string())
}

/// 跳过一个完整值（字符串/对象/数组/标量），返回结束位置。
fn skip_value(raw: &str, i: usize) -> Result<usize, String> {
    let bytes = raw.as_bytes();
    match bytes[i] {
        b'"' => scan_string(raw, i),
        b'{' => skip_balanced(raw, i, b'{', b'}'),
        b'[' => skip_balanced(raw, i, b'[', b']'),
        _ => {
            let mut j = i;
            while j < raw.len() {
                let c = bytes[j];
                if c.is_ascii_alphanumeric() || c == b'+' || c == b'-' || c == b'.' {
                    j += 1;
                } else {
                    break;
                }
            }
            if j == i {
                return Err(format!("无法识别的值起点: {}", &raw[i..(i + 4).min(raw.len())]));
            }
            Ok(j)
        }
    }
}

/// 括号配平扫描（跳过字符串与注释），`i` 应指向 `open`。
fn skip_balanced(raw: &str, mut i: usize, open: u8, close: u8) -> Result<usize, String> {
    let bytes = raw.as_bytes();
    let mut depth = 0usize;
    while i < raw.len() {
        match bytes[i] {
            b'"' => {
                i = scan_string(raw, i)?;
                continue;
            }
            _ if raw[i..].starts_with("//") || raw[i..].starts_with("/*") => {
                i = skip_ws_comments(raw, i)?;
                continue;
            }
            c if c == open => depth += 1,
            c if c == close => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err("括号未闭合".to_string())
}

/// 扫描一个对象（`obj_start` 指向 '{'）的全部成员与结束位置。
fn scan_members(
    raw: &str,
    obj_start: usize,
) -> Result<(Vec<MemberOwned>, usize), String> {
    let bytes = raw.as_bytes();
    if bytes[obj_start] != b'{' {
        return Err("期望对象起点 '{'".to_string());
    }
    let mut members = Vec::new();
    let mut i = skip_ws_comments(raw, obj_start + 1)?;
    loop {
        if i >= raw.len() {
            return Err("对象未闭合".to_string());
        }
        if bytes[i] == b'}' {
            return Ok((members, i));
        }
        if bytes[i] == b',' {
            i = skip_ws_comments(raw, i + 1)?;
            continue;
        }
        // 键名
        if bytes[i] != b'"' {
            return Err(format!("对象成员键名必须是字符串，见到 '{}'", bytes[i] as char));
        }
        let key_start = i;
        let key_end = scan_string(raw, i)?;
        let key_json = &raw[key_start..key_end];
        let key: String = serde_json::from_str(key_json)
            .map_err(|e| format!("键名解析失败 {key_json}: {e}"))?;
        i = skip_ws_comments(raw, key_end)?;
        if i >= raw.len() || bytes[i] != b':' {
            return Err(format!("键 {key} 后缺少 ':'"));
        }
        i = skip_ws_comments(raw, i + 1)?;
        let value_start = i;
        let value_end = skip_value(raw, i)?;
        members.push(MemberOwned {
            key,
            key_start,
            value_start,
            value_end,
        });
        i = skip_ws_comments(raw, value_end)?;
    }
}

/// 在 `path` 上定位：返回 (每层定位信息)。最终层缺失键时返回其父层信息。
#[derive(Debug)]
struct Located {
    /// 最终层对象的 '{' 位置
    obj_start: usize,
    /// 最终层对象的 '}' 位置
    obj_end: usize,
    /// 目标键的成员（None = 键不存在）
    member: Option<MemberOwned>,
    /// 路径中第一个缺失/非对象的层（从 0 起），其余层全部命中对象
    missing_at: Option<usize>,
}

fn locate(raw: &str, path: &[&str]) -> Result<Located, String> {
    let bytes = raw.as_bytes();
    let i = skip_ws_comments(raw, 0)?;
    if i >= raw.len() || bytes[i] != b'{' {
        return Err("顶层不是 JSON 对象".to_string());
    }
    let mut obj_start = i;
    for (depth, key) in path.iter().enumerate() {
        let (members, obj_end) = scan_members(raw, obj_start)?;
        let member = members.iter().find(|m| m.key == *key).cloned();
        let last = depth == path.len() - 1;
        match member {
            Some(m) if last => {
                return Ok(Located {
                    obj_start,
                    obj_end,
                    member: Some(m),
                    missing_at: None,
                });
            }
            Some(m) => {
                // 下钻：值必须是对象
                let vi = skip_ws_comments(raw, m.value_start)?;
                if bytes[vi] != b'{' {
                    return Err(format!(
                        "路径段 {}（{}）的值不是对象，无法继续下钻",
                        depth + 1,
                        key
                    ));
                }
                obj_start = vi;
            }
            None => {
                return Ok(Located {
                    obj_start,
                    obj_end,
                    member: None,
                    missing_at: Some(depth),
                });
            }
        }
    }
    unreachable!("path 非空由调用方保证");
}

/// 探测缩进单位：文件里第一个换行后的前导空白（tab 或空格串），默认两个空格。
fn detect_indent_unit(raw: &str) -> String {
    if let Some(nl) = raw.find('\n') {
        let after = &raw[nl + 1..];
        let spaces: String = after
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        if !spaces.is_empty() {
            return spaces;
        }
    }
    "  ".to_string()
}

fn line_ending(raw: &str) -> &'static str {
    if raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// 渲染嵌套对象（逐层创建中间层时用），如 ["a","b"] + value → {"a":{"b":value}}
fn render_nested(path: &[&str], value: &JsoncValue) -> String {
    let inner = value.render();
    let mut out = inner;
    for key in path.iter().rev() {
        out = format!("{{ {}: {} }}", Json::String((*key).to_string()), out);
    }
    out
}

/// 定位后执行插入（键不存在）。
fn insert_member(
    raw: &str,
    located: &Located,
    remaining_path: &[&str],
    value: &JsoncValue,
) -> Result<String, String> {
    let bytes = raw.as_bytes();
    // 语义：在 located.obj 内插入键 remaining[0]，其值为
    // render_nested(remaining[1..], value)（多出的路径渲染为嵌套中间对象）
    let key = remaining_path
        .first()
        .ok_or_else(|| "插入路径为空".to_string())?;
    let rendered_leaf = match remaining_path.len() {
        1 => value.render(),
        _ => render_nested(&remaining_path[1..], value),
    };
    let _ = bytes;
    let (members, _) = scan_members(raw, located.obj_start)?;
    let nl = line_ending(raw);
    let unit = detect_indent_unit(raw);
    // 父层（'{' 所在行）的缩进：行首到第一个非空白字符
    let line_start = raw[..located.obj_start]
        .rfind('\n')
        .map(|p| p + 1)
        .unwrap_or(0);
    let parent_indent: String = raw[line_start..located.obj_start]
        .chars()
        .take_while(|c| c.is_whitespace() && *c != '\n' && *c != '\r')
        .collect();
    let child_indent = format!("{parent_indent}{unit}");

    // Json::String 序列化自带引号，不要再包一层
    let entry = format!("{}: {}", Json::String(key.to_string()), rendered_leaf);

    if members.is_empty() {
        // 空对象：{'{','}' 之间只有空白/注释
        let between = &raw[located.obj_start + 1..located.obj_end];
        let multiline = between.contains('\n');
        let insert_at = located.obj_start + 1;
        let text = if multiline {
            format!("{nl}{child_indent}{entry}{nl}{parent_indent}")
        } else {
            format!(" {entry} ")
        };
        let mut out = String::with_capacity(raw.len() + text.len());
        out.push_str(&raw[..insert_at]);
        out.push_str(&text);
        out.push_str(&raw[insert_at..]);
        return Ok(out);
    }

    let last = members.last().expect("members 非空");
    // 最后一个成员之后、'}' 之前是否存在逗号
    let tail = &raw[last.value_end..located.obj_end];
    let tail_first = skip_ws_comments(tail, 0).unwrap_or(tail.len());
    let has_comma = tail[tail_first..].starts_with(',');
    let multiline = tail.contains('\n') || tail_first > 0;

    let (insert_at, text) = if has_comma {
        // 尾逗号已存在：'}' 紧前插入新成员
        (
            located.obj_end,
            if multiline {
                format!("{child_indent}{entry}{nl}{parent_indent}")
            } else {
                format!(" {entry} ")
            },
        )
    } else {
        // 无尾逗号：上一个成员后补逗号再插入
        (
            last.value_end,
            if multiline {
                format!(",{nl}{child_indent}{entry}")
            } else {
                format!(", {entry} ")
            },
        )
    };
    let mut out = String::with_capacity(raw.len() + text.len());
    out.push_str(&raw[..insert_at]);
    out.push_str(&text);
    out.push_str(&raw[insert_at..]);
    Ok(out)
}

/// 保形写入：`path` 定位到的键替换/创建为 `value`。
/// 失败报错，不回退全量重写。
pub fn set_key(raw: &str, path: &[&str], value: &JsoncValue) -> Result<String, String> {
    if path.is_empty() {
        return Err("set_key 路径不能为空".to_string());
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // 空文件：渲染嵌套对象
        let mut out = render_nested(path, value);
        out.push('\n');
        return Ok(out);
    }
    let located = locate(raw, path)?;
    match located.member {
        Some(m) => {
            let mut out = String::with_capacity(raw.len());
            out.push_str(&raw[..m.value_start]);
            out.push_str(&value.render());
            out.push_str(&raw[m.value_end..]);
            Ok(out)
        }
        None => {
            let missing = located.missing_at.expect("member 为 None 时必有 missing_at");
            let (consume, remaining): (usize, &[&str]) = if missing == path.len() - 1 {
                // 最后一层缺键：在其父层插入；remaining 空表示插入的键就是 path 最后一层
                // 这里统一为「在 missing 层插入其键名」，因此 remaining 取 path[missing..]
                (missing, &path[missing..])
            } else {
                (missing, &path[missing..])
            };
            let _ = consume;
            // missing 层所在的父对象 = 重新定位 path[..missing] 的对象区间。
            // locate 只返回最终层信息，这里对前缀重放定位。
            let prefix_obj = locate_prefix(raw, &path[..missing])?;
            insert_member(raw, &prefix_obj, remaining, value)
        }
    }
}

/// 定位 path 前缀指向的对象（全部命中且为对象）。
fn locate_prefix(raw: &str, path: &[&str]) -> Result<Located, String> {
    if path.is_empty() {
        let i = skip_ws_comments(raw, 0)?;
        let (members, obj_end) = scan_members(raw, i)?;
        return Ok(Located {
            obj_start: i,
            obj_end,
            member: members.first().cloned(),
            missing_at: None,
        });
    }
    let bytes = raw.as_bytes();
    let i = skip_ws_comments(raw, 0)?;
    if i >= raw.len() || bytes[i] != b'{' {
        return Err("顶层不是 JSON 对象".to_string());
    }
    let mut obj_start = i;
    for key in path {
        let (members, _obj_end) = scan_members(raw, obj_start)?;
        match members.iter().find(|m| m.key == *key) {
            Some(m) => {
                let vi = skip_ws_comments(raw, m.value_start)?;
                if bytes[vi] != b'{' {
                    return Err(format!("前缀路径段 {key} 的值不是对象"));
                }
                obj_start = vi;
            }
            None => return Err(format!("前缀路径段 {key} 不存在")),
        }
    }
    let (members, obj_end) = scan_members(raw, obj_start)?;
    Ok(Located {
        obj_start,
        obj_end,
        member: members.first().cloned(),
        missing_at: None,
    })
}

/// 保形删除：删除 `path` 定位到的成员并修整逗号。
/// 键不存在 → 原样返回（幂等）。
///
/// 逗号修整规则：
/// - 被删成员不是最后一个 → 连同它后面的成员分隔逗号一起删
/// - 被删成员是最后一个 → 吃掉行首缩进、向前修掉前一个成员留下的
///   尾逗号，并吃掉它自己后面的尾逗号（若有），保证剩余文本是合法 JSON
pub fn remove_key(raw: &str, path: &[&str]) -> Result<String, String> {
    if path.is_empty() {
        return Err("remove_key 路径不能为空".to_string());
    }
    if raw.trim().is_empty() {
        return Ok(raw.to_string());
    }
    let located = locate(raw, path)?;
    let Some(member) = located.member else {
        return Ok(raw.to_string());
    };
    let bytes = raw.as_bytes();
    let after = skip_ws_comments(raw, member.value_end)?;
    // 是否最后一个成员：其后（跳过 ws/注释，允许一个尾逗号）是 '}'
    let is_last = if after < raw.len() && bytes[after] == b',' {
        let after_comma = skip_ws_comments(raw, after + 1)?;
        after_comma < raw.len() && bytes[after_comma] == b'}'
    } else {
        after < raw.len() && bytes[after] == b'}'
    };

    let (remove_start, mut remove_end) = if is_last {
        let mut start = member.key_start;
        // 吃掉被删成员所在行的行首缩进（该行将整体消失）
        let line_start = raw[..start].rfind('\n').map(|p| p + 1).unwrap_or(0);
        if raw[line_start..start].trim().is_empty() {
            start = line_start;
        }
        // 向前修掉前一个成员留下的尾逗号（与被删成员之间只隔空白/换行）
        let before = &raw[..start];
        if let Some(comma) = before.rfind(',') {
            let between = &raw[comma + 1..start];
            if between.trim().is_empty() {
                (comma, member.value_end)
            } else {
                (start, member.value_end)
            }
        } else {
            (start, member.value_end)
        }
    } else {
        // 非最后成员：连同后面的分隔逗号一起删
        (member.key_start, after + 1)
    };
    // 最后成员场景：被删成员自己的尾逗号（其后直接 '}'）也要吃掉
    if is_last {
        let a = skip_ws_comments(raw, remove_end)?;
        if a < raw.len() && bytes[a] == b',' {
            remove_end = a + 1;
        }
    }
    Ok(format!("{}{}", &raw[..remove_start], &raw[remove_end..]))
}

/// 读取字符串值（用于回显/漂移检测）。值不是字符串或键不存在 → None。
#[allow(dead_code)]
pub fn get_string(raw: &str, path: &[&str]) -> Option<String> {
    if path.is_empty() || raw.trim().is_empty() {
        return None;
    }
    let located = locate(raw, path).ok()?;
    let member = located.member?;
    let text = raw[member.value_start..member.value_end].trim();
    if !text.starts_with('"') {
        return None;
    }
    serde_json::from_str::<String>(text).ok()
}

/// 读取目标值的原文本（对象/数组/标量通吃，trim 后返回）。
/// 用于「对象级受管字段」的当前值判定（如 OpenCode 的 provider.<id>）。
#[allow(dead_code)]
pub fn get_raw_text(raw: &str, path: &[&str]) -> Option<String> {
    if path.is_empty() || raw.trim().is_empty() {
        return None;
    }
    let located = locate(raw, path).ok()?;
    let member = located.member?;
    Some(raw[member.value_start..member.value_end].trim().to_string())
}

/// 判定当前值文本与 applied 存的 JSON 是否结构相等（序无关）。
#[allow(dead_code)]
pub fn raw_text_matches_json(current_raw: &str, applied_json: &str) -> bool {
    match (
        serde_json::from_str::<Json>(current_raw),
        serde_json::from_str::<Json>(applied_json),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 读取标量值（保形判定「当前值」用；工具箱 API，各平台按需取用）。
#[allow(dead_code)]
pub fn get_scalar(raw: &str, path: &[&str]) -> Option<JsoncValue> {
    if path.is_empty() || raw.trim().is_empty() {
        return None;
    }
    let located = locate(raw, path).ok()?;
    let member = located.member?;
    let text = raw[member.value_start..member.value_end].trim();
    let v: Json = serde_json::from_str(text).ok()?;
    JsoncValue::from_json(&v)
}

#[cfg(test)]
mod tests {
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
}
