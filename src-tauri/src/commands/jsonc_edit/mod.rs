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
//! 门控：`ANYBRIDGE_FORMAT_PRESERVING_JSON`（默认开启；显式设为 `0` / `false` / `off` 时关闭）。
//! 关闭时调用方走原有 serde_json 路径，行为与旧版本完全一致。
//!
//! 支持范围（够用且可验证）：
//! - 值类型：字符串 / bool / 数字 / Object / Array / Raw（配置切换全场景覆盖）
//! - set：键已存在 → 原位缩进对齐替换值；键不存在 → 在该层插入（含逐层创建
//!   中间对象）；根文件为空 → 渲染缩进对齐的嵌套对象
//! - remove：删除成员并修整逗号（含「最后一个成员」的悬空尾逗号）
//! - get_string：读取字符串值（回显/漂移检测用）

use serde_json::Value as Json;

/// 门控：保形写入是否开启（默认开启；仅显式 `"0"` / `"false"` / `"off"` / `"no"` 关闭）。
pub fn format_preserving_enabled() -> bool {
    match std::env::var("ANYBRIDGE_FORMAT_PRESERVING_JSON") {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !matches!(v.as_str(), "0" | "false" | "off" | "no")
        }
        Err(_) => true,
    }
}

/// 可写入的值（标量 / Object / Array / 预渲染文本）。
#[derive(Debug, Clone, PartialEq)]
pub enum JsoncValue {
    Str(String),
    Bool(bool),
    Num(f64),
    Object(serde_json::Map<String, Json>),
    Array(Vec<Json>),
    /// 预渲染的 JSON 文本（对象/数组），保留输入或按目标缩进对齐格式化；调用方负责其合法性。
    Raw(String),
}

fn format_json_aligned(
    v: &Json,
    base_indent: &str,
    unit: &str,
    nl: &str,
    multiline: bool,
) -> String {
    if !multiline {
        return v.to_string();
    }
    let pretty = serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string());
    let mut lines = pretty.lines();
    let Some(first) = lines.next() else {
        return pretty;
    };
    let mut out = String::from(first);
    for line in lines {
        out.push_str(nl);
        let trimmed = line.trim_start_matches(' ');
        let level = (line.len() - trimmed.len()) / 2;
        out.push_str(base_indent);
        for _ in 0..level {
            out.push_str(unit);
        }
        out.push_str(trimmed);
    }
    out
}

impl JsoncValue {
    #[allow(dead_code)]
    pub fn render(&self) -> String {
        self.render_aligned("", "  ", "\n", true)
    }

    pub fn render_aligned(
        &self,
        base_indent: &str,
        unit: &str,
        nl: &str,
        multiline: bool,
    ) -> String {
        match self {
            JsoncValue::Str(s) => Json::String(s.clone()).to_string(),
            JsoncValue::Bool(b) => b.to_string(),
            JsoncValue::Num(n) => match serde_json::Number::from_f64(*n) {
                Some(num) => Json::Number(num).to_string(),
                None => "null".to_string(),
            },
            JsoncValue::Object(map) => {
                format_json_aligned(&Json::Object(map.clone()), base_indent, unit, nl, multiline)
            }
            JsoncValue::Array(arr) => {
                format_json_aligned(&Json::Array(arr.clone()), base_indent, unit, nl, multiline)
            }
            JsoncValue::Raw(text) => match serde_json::from_str::<Json>(text) {
                Ok(v @ (Json::Object(_) | Json::Array(_))) => {
                    format_json_aligned(&v, base_indent, unit, nl, multiline)
                }
                _ => text.clone(),
            },
        }
    }

    pub fn from_json(v: &Json) -> Option<Self> {
        match v {
            Json::String(s) => Some(JsoncValue::Str(s.clone())),
            Json::Bool(b) => Some(JsoncValue::Bool(*b)),
            Json::Number(n) => n.as_f64().map(JsoncValue::Num),
            Json::Object(map) => Some(JsoncValue::Object(map.clone())),
            Json::Array(arr) => Some(JsoncValue::Array(arr.clone())),
            Json::Null => None,
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

/// 渲染缩进对齐的嵌套对象（逐层创建中间层时用）。
fn render_nested_aligned(
    path: &[&str],
    value: &JsoncValue,
    base_indent: &str,
    unit: &str,
    nl: &str,
    multiline: bool,
) -> String {
    if path.is_empty() {
        return value.render_aligned(base_indent, unit, nl, multiline);
    }
    if !multiline {
        let mut out = value.render_aligned(base_indent, unit, nl, false);
        for key in path.iter().rev() {
            out = format!("{{ {}: {} }}", Json::String((*key).to_string()), out);
        }
        return out;
    }
    let key_indent = format!("{base_indent}{unit}");
    let inner = if path.len() == 1 {
        value.render_aligned(&key_indent, unit, nl, true)
    } else {
        render_nested_aligned(&path[1..], value, &key_indent, unit, nl, true)
    };
    format!(
        "{{{nl}{key_indent}{}: {inner}{nl}{base_indent}}}",
        Json::String(path[0].to_string())
    )
}

/// 定位后执行插入（键不存在）。
fn insert_member(
    raw: &str,
    located: &Located,
    remaining_path: &[&str],
    value: &JsoncValue,
) -> Result<String, String> {
    let key = remaining_path
        .first()
        .ok_or_else(|| "插入路径为空".to_string())?;
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

    let (multiline, insert_at, prefix, suffix) = if members.is_empty() {
        let between = &raw[located.obj_start + 1..located.obj_end];
        let multiline = between.contains('\n') || raw.contains('\n');
        if multiline {
            (
                true,
                located.obj_start + 1,
                format!("{nl}{child_indent}"),
                format!("{nl}{parent_indent}"),
            )
        } else {
            (false, located.obj_start + 1, " ".to_string(), " ".to_string())
        }
    } else {
        let last = members.last().expect("members 非空");
        let tail = &raw[last.value_end..located.obj_end];
        let tail_first = skip_ws_comments(tail, 0).unwrap_or(tail.len());
        let has_comma = tail[tail_first..].starts_with(',');
        let multiline = tail.contains('\n') || tail_first > 0 || raw.contains('\n');
        if has_comma {
            if multiline {
                (
                    true,
                    located.obj_end,
                    child_indent.clone(),
                    format!("{nl}{parent_indent}"),
                )
            } else {
                (false, located.obj_end, " ".to_string(), " ".to_string())
            }
        } else if multiline {
            (
                true,
                last.value_end,
                format!(",{nl}{child_indent}"),
                String::new(),
            )
        } else {
            (false, last.value_end, ", ".to_string(), " ".to_string())
        }
    };

    let rendered_leaf = match remaining_path.len() {
        1 => value.render_aligned(&child_indent, &unit, nl, multiline),
        _ => render_nested_aligned(&remaining_path[1..], value, &child_indent, &unit, nl, multiline),
    };
    let entry = format!("{}: {}", Json::String(key.to_string()), rendered_leaf);
    let text = format!("{prefix}{entry}{suffix}");

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
        // 空文件：渲染缩进对齐的嵌套对象
        let mut out = render_nested_aligned(path, value, "", "  ", "\n", true);
        out.push('\n');
        return Ok(out);
    }
    let located = locate(raw, path)?;
    match located.member {
        Some(m) => {
            let nl = line_ending(raw);
            let unit = detect_indent_unit(raw);
            let line_start = raw[..m.key_start].rfind('\n').map(|p| p + 1).unwrap_or(0);
            let member_indent: String = raw[line_start..m.key_start]
                .chars()
                .take_while(|c| c.is_whitespace() && *c != '\n' && *c != '\r')
                .collect();
            let multiline = raw.contains('\n');
            let rendered = value.render_aligned(&member_indent, &unit, nl, multiline);
            let mut out = String::with_capacity(raw.len() + rendered.len());
            out.push_str(&raw[..m.value_start]);
            out.push_str(&rendered);
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
mod tests;
