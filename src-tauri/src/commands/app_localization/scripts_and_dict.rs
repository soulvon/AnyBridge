use serde_json::{json, Value};
use std::fs;
use super::*;

pub(super) fn upstream_raw_url(platform: &str) -> Option<&'static str> {
    match platform {
        "windsurf" | "devin" => Some(UPSTREAM_RAW_URL),
        "cursor" => Some(CURSOR_UPSTREAM_RAW_URL),
        "claude-desktop" => Some(CLAUDE_UPSTREAM_RAW_URL),
        "antigravity-ide" => Some(AG_IDE_UPSTREAM_RAW_URL),
        _ => None,
    }
}

/// 热更新缓存文件名：windsurf 系缓存完整脚本，cursor/ag-ide 缓存词典 JSON，
/// claude 缓存翻译文件。
pub(super) fn script_cache_name(platform: &str) -> &'static str {
    match platform {
        "claude-desktop" => "zh-CN.json",
        _ => "dictionary.json",
    }
}

/// 把字符串序列化为合法 JS 字符串字面量（JSON 字符串是 JS 字符串子集；
/// 额外转义 U+2028/2029 防老引擎语法坑）。
pub(super) fn js_string(s: &str) -> String {
    let mut out = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    if out.contains('\u{2028}') || out.contains('\u{2029}') {
        out = out
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
    }
    out
}

/// 从词典 JSON（sections[].entries: [[英, 中], ...]）生成注入脚本：
/// 通用 DOM 翻译引擎（取自 windsurf-localization.js 的运行时，与平台无关）
/// + 平台专属词典。所有字符串经 serde_json 重新序列化，保证语法合法。
pub(super) fn build_script_from_dictionary(dict_json: &str) -> Option<String> {
    let val: Value = serde_json::from_str(dict_json).ok()?;
    let sections = val.get("sections")?.as_array()?;
    let mut pairs: Vec<(String, String)> = Vec::new();
    for section in sections {
        let entries = section.get("entries")?.as_array()?;
        for e in entries {
            let en = e.get(0)?.as_str()?;
            let zh = e.get(1)?.as_str()?;
            if !en.is_empty() && !zh.is_empty() {
                pairs.push((en.to_string(), zh.to_string()));
            }
        }
    }
    if pairs.is_empty() {
        return None;
    }

    // 引擎模板：BASELINE_SCRIPT 的 TRANSLATIONS Map 块整体替换为平台词典，
    // 其余（MutationObserver / TreeWalker / 属性翻译 / 排除选择器）原样保留。
    let start_marker = "const TRANSLATIONS = new Map([";
    let s_idx = BASELINE_SCRIPT.find(start_marker)? + start_marker.len();
    let e_idx = BASELINE_SCRIPT[s_idx..].find("]);")? + s_idx;

    let mut dict_js = String::from("\n");
    for (en, zh) in &pairs {
        dict_js.push_str("\t\t[");
        dict_js.push_str(&js_string(en));
        dict_js.push_str(", ");
        dict_js.push_str(&js_string(zh));
        dict_js.push_str("],\n");
    }
    Some(format!(
        "{}\n{}{}",
        &BASELINE_SCRIPT[..s_idx],
        dict_js,
        &BASELINE_SCRIPT[e_idx..]
    ))
}

/// 从上游 windsurf-localization.js（完整脚本）里抽取 TRANSLATIONS 词典，
/// 转为 sections 词典 JSON。上游完整脚本自带悬浮开关按钮与 800ms 启动延迟，
/// 不再原样注入——只取词典，引擎统一用内置模板。
pub(super) fn extract_dictionary_from_windsurf_script(source: &str) -> Option<Value> {
    let start_marker = "const TRANSLATIONS = new Map([";
    let s = source.find(start_marker)? + start_marker.len();
    let rest = &source[s..];
    let e = rest.find("]);")?;
    let block = &rest[..e];
    let re = regex::Regex::new(r#"'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'"#).ok()?;
    let unescape = |raw: &str| -> String {
        let mut out = String::with_capacity(raw.len());
        let mut chars = raw.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('\'') => out.push('\''),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => {}
            }
        }
        out
    };
    let mut entries = Vec::new();
    for caps in re.captures_iter(block) {
        let key = unescape(&caps[1]);
        let val = unescape(&caps[2]);
        if !key.is_empty() && !val.is_empty() {
            entries.push(json!([key, val]));
        }
    }
    if entries.is_empty() {
        return None;
    }
    Some(json!({
        "sections": [{"id": "windsurf", "title": "Windsurf", "entries": entries}]
    }))
}

/// 从上游 localize.js（Node 程序）抽取 dictionary 字面量，转为 sections 词典 JSON。
/// 上游脚本含 require/fs 不能直接注入浏览器，只抽词典（与 Antigravity 桌面端
/// 汉化模块同一思路，字符串经重新序列化保证语法合法）。
pub(super) fn extract_dictionary_from_localize(source: &str) -> Option<Value> {
    let start = source.find("const dictionary = {")?;
    let rest = &source[start..];
    let end = rest.find("\n};")?;
    let block = &rest[..end];
    let re = regex::Regex::new(r#""((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)""#).ok()?;
    let unescape = |s: &str| -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => {}
            }
        }
        out
    };
    let mut entries = Vec::new();
    for caps in re.captures_iter(block) {
        let key = unescape(&caps[1]);
        let val = unescape(&caps[2]);
        if !key.is_empty() && !val.is_empty() {
            entries.push(json!([key, val]));
        }
    }
    if entries.is_empty() {
        return None;
    }
    Some(json!({
        "sections": [{"id": "antigravity", "title": "Antigravity", "entries": entries}]
    }))
}

/// 平台基线词典（cursor/antigravity-ide 用内置引擎模板组装）。
/// windsurf/devin 不走此路——它们用内嵌的完整汉化模块（引擎+词典一体，
/// 词典量 800+ 且覆盖专有 UI，上游停更的词库反而是倒退）。
pub(super) fn baseline_dict(platform: &str) -> Option<&'static str> {
    match platform {
        "cursor" => Some(CURSOR_BASELINE_DICT),
        "antigravity-ide" => Some(AG_IDE_BASELINE_DICT),
        _ => None,
    }
}

/// 汉化脚本内容。
///
/// Windsurf/Devin：直接内嵌**完整汉化模块**（引擎 + 800+ 条人工词典一体）。
/// 这两个平台的专有 UI 词条只有这套词典覆盖得全（VS Code 官方语言包只翻核心，
/// 上游 good9527 词库已停更且不含专有 UI），故不走"词典热更新替换"路径——
/// 否则用户点更新后拿到的是覆盖更少的上游词典，反而倒退。
///
/// Cursor/Antigravity IDE：内置引擎模板 + 平台词典组装（词典量较小，
/// 保留热更新能力：有缓存词典用缓存的，否则用内置基线）。
pub(super) fn hans_script(platform: &str) -> String {
    match platform {
        "windsurf" => return BASELINE_SCRIPT.to_string(),
        "devin" => return DEVIN_BASELINE_SCRIPT.to_string(),
        _ => {}
    }
    let Some(baseline) = baseline_dict(platform) else {
        return BASELINE_SCRIPT.to_string();
    };
    let cached = cache_dir(platform).join(script_cache_name(platform));
    let dict = match fs::read_to_string(&cached).ok().filter(|s| !s.trim().is_empty()) {
        // 必须与内置基线**合并**，不能整体替代：缓存是完整快照，直接替代会把
        // 后来新增的内置词条吞掉（实测：设置页新加的 15 条在更新过词库的机器上不生效）。
        Some(c) => merge_dictionaries(baseline, &c),
        None => baseline.to_string(),
    };
    build_script_from_dictionary(&dict)
        .unwrap_or_else(|| build_script_from_dictionary(baseline).unwrap_or_default())
}

/// 合并「内置基线」与「热更新缓存」词典：基线打底，缓存同名词条覆盖，缓存独有词条追加。
///
/// 任何一侧解析失败都不编造：解析不出条目就退回另一侧（绝不让注入脚本变空）。
pub(super) fn merge_dictionaries(baseline_json: &str, cached_json: &str) -> String {
    fn collect(v: &Value, out: &mut Vec<(String, String)>) {
        let Some(sections) = v.get("sections").and_then(|s| s.as_array()) else {
            return;
        };
        for section in sections {
            let Some(entries) = section.get("entries").and_then(|e| e.as_array()) else {
                continue;
            };
            for entry in entries {
                let (Some(en), Some(zh)) = (
                    entry.get(0).and_then(|x| x.as_str()),
                    entry.get(1).and_then(|x| x.as_str()),
                ) else {
                    continue;
                };
                if en.is_empty() || zh.is_empty() {
                    continue;
                }
                out.push((en.to_string(), zh.to_string()));
            }
        }
    }

    let mut baseline_pairs = Vec::new();
    let mut cached_pairs = Vec::new();
    if let Ok(v) = serde_json::from_str::<Value>(baseline_json) {
        collect(&v, &mut baseline_pairs);
    }
    if let Ok(v) = serde_json::from_str::<Value>(cached_json) {
        collect(&v, &mut cached_pairs);
    }
    if baseline_pairs.is_empty() {
        return cached_json.to_string();
    }
    if cached_pairs.is_empty() {
        return baseline_json.to_string();
    }

    let cached_map: std::collections::HashMap<&str, &str> = cached_pairs
        .iter()
        .map(|(en, zh)| (en.as_str(), zh.as_str()))
        .collect();
    let mut merged: Vec<(String, String)> = Vec::with_capacity(baseline_pairs.len() + cached_pairs.len());
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (en, zh) in &baseline_pairs {
        let translated = cached_map.get(en.as_str()).copied().unwrap_or(zh.as_str());
        merged.push((en.clone(), translated.to_string()));
        used.insert(en.clone());
    }
    for (en, zh) in &cached_pairs {
        if used.insert(en.clone()) {
            merged.push((en.clone(), zh.clone()));
        }
    }

    let entries: Vec<Value> = merged
        .into_iter()
        .map(|(en, zh)| json!([en, zh]))
        .collect();
    json!({ "sections": [{ "id": "merged", "title": "merged", "entries": entries }] }).to_string()
}

/// 注入到某个入口窗口的脚本。
///
/// `aux_window` = 非主 workbench 窗口（Antigravity IDE 的设置页独立成窗口）。
/// 引擎在该模式下跳过"等根节点 + 隐藏首屏"，否则没有 .monaco-workbench 的
/// 窗口会一直隐藏到 6 秒超时——汉化好了却先白屏 6 秒。
pub(super) fn hans_script_for_window(platform: &str, aux_window: bool) -> String {
    let script = hans_script(platform);
    if aux_window {
        format!("window.__anybridgeHansAuxWindow = true;\n{script}")
    } else {
        script
    }
}

/// CDP 注入用脚本（Antigravity IDE 设置页 / Agent 面板）。
///
/// 除了辅助窗口标记，还必须带**幂等守卫**：keeper 每 4 秒巡检一次，
/// 没有守卫就会反复 new MutationObserver，内存与重复翻译都会累积。
pub(crate) fn hans_script_for_cdp() -> String {
    let engine = hans_script_for_window("antigravity-ide", true);
    format!(
        "(function(){{if(window.__anybridgeCdpHans)return 'skip';window.__anybridgeCdpHans=true;{engine}}})();"
    )
}

pub(super) fn read_cached_version(platform: &str) -> String {
    // Windsurf/Devin 用内嵌完整词典（无热更新缓存）：显示真实词条数，
    // 比 "builtin" 对用户有意义（面板上直接看到"内置 3300+ 条"）。
    if platform == "windsurf" || platform == "devin" {
        let script = if platform == "devin" { DEVIN_BASELINE_SCRIPT } else { BASELINE_SCRIPT };
        return format!("内置 {} 条", count_entries(script));
    }
    let meta_path = cache_dir(platform).join("metadata.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(v) = val.get("version").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    "baseline".to_string()
}

pub(super) fn read_cached_sha(platform: &str) -> String {
    let meta_path = cache_dir(platform).join("metadata.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(v) = val.get("sha").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    String::new()
}
