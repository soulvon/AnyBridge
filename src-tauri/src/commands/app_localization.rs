// app_localization.rs — Windsurf / Devin Desktop 界面汉化管理器
//
// 与 Antigravity 桌面端汉化（antigravity_localization.rs）同一套交互逻辑：
//   状态探测 / 一键应用 / 还原官方英文 / 在线词库检查 / 热更新下载。
// 差异只在注入载体：这里的目标是 VS Code 内核的 workbench.html
// （Windsurf 与 Devin Desktop 是同一客户端的两个世代名，机制完全一致）。
//
// 注入设计（与 workbench_inject.rs 的 byok-cards 注入共存，互不覆盖）：
//   - 独立块标记 anybridge-hans-start/end，清理只动自己的块
//   - 独立备份后缀 .hans-origin；首次注入时保存"打汉化前"的 html
//     （彼时可能已含 byok 注入块，还原即回到打汉化前状态，语义正确）
//   - CSP script-src 补 'unsafe-inline'（复用 workbench_inject 的实现）
//   - 同步清空 product.json 完整性校验清单（否则 IDE 弹"安装已损坏"）
//   - 同步加固 NLS 取词函数（第三方中文语言包缺词条会 throw 白屏）
//
// 上游词库：KLFDan0534/windsurf-autoContinue 的 windsurf-localization.js
// （纯浏览器 IIFE，DOM 观察 + 增量翻译，原样注入即可运行）。
// 该仓库无 GitHub Releases，版本标识用 contents API 返回的文件 sha。

use super::antigravity_localization::LocalizationOperationResult;
use super::workbench_inject::{
    clear_product_checksums, ensure_csp_unsafe_inline, patch_nls_tolerant, product_json_path,
    restore_product_json, revert_csp_unsafe_inline, workbench_html_path,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;

const HANS_BLOCK_START: &str = super::workbench_inject::HANS_BLOCK_START;
const HANS_BLOCK_END: &str = "<!-- anybridge-hans-end -->";
const HANS_VERSION_MARKER: &str = "<!-- anybridge-hans-v1 -->";
const HANS_BACKUP_SUFFIX: &str = ".hans-origin";
/// Antigravity IDE 的设置页 / Agent 面板由**独立引导窗口**渲染（实测 1.107.0：
/// out/vs/code/electron-browser/workbench/workbench-jetski-agent.html）。
/// 该窗口是独立渲染进程，只注入主 workbench.html 时，标准菜单（官方语言包）是
/// 中文而设置页全英文。它的 CSP 还没有 'unsafe-inline'，必须一起补。
const AG_IDE_AGENT_WINDOW_HTML: &str = "workbench-jetski-agent.html";
const BYOK_BLOCK_START: &str = "<!-- byok-cards-start -->";
const BYOK_BLOCK_END: &str = "<!-- byok-cards-end -->";

const UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/KLFDan0534/windsurf-autoContinue/main/windsurf-localization.js";
const CURSOR_UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/vibepm666/cursor-localization-zh/main/localization/Core_Dictionary.json";
/// Claude 词典源：yiheng8023/claude-chinese 的 ion 分词库。
/// 选它而不是 good9527 那个（22319 条）的原因：专门对应 ion-dist 渲染层结构，
/// 30678 条且**覆盖新版 Claude 新增的文案 id**（实测设置面板那批 id 覆盖率 5/5，
/// good9527 只有 4/5）。项目活跃、MIT。
const CLAUDE_UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/yiheng8023/claude-chinese/main/dict/ion-zh-CN.json";
const AG_IDE_UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/liominsb/Antigravity-Chinese-Localization/master/localize.js";

/// 中文语言包扩展目录前缀 / 扩展 id（VS Code 官方简体中文语言包）。
const LANG_PACK_DIR_PREFIX: &str = "ms-ceintl.vscode-language-pack-zh-hans";
const LANG_PACK_EXTENSION_ID: &str = "ms-ceintl.vscode-language-pack-zh-hans";

/// 内置基线（离线兜底）：
/// - windsurf-localization-baseline.js / devin-localization-baseline.js：
///   Windsurf/Devin 专用**完整汉化模块**（引擎 + 820/817 条人工词典，源自 Kite
///   windsurf/devin-better.js 的汉化模块，经 v8.x 长期实战打磨）。这两个平台
///   的专有 UI（设置页内容、Cascade/Codebuddy 面板、输入区、Plan/Quota 等）
///   只有这套词典覆盖得全，VS Code 官方语言包只翻核心。
/// - cursor/antigravity-ide：内置引擎模板 + 平台词典 JSON 组装（词典量较小）。
const BASELINE_SCRIPT: &str = include_str!("windsurf-localization-baseline.js");
const DEVIN_BASELINE_SCRIPT: &str = include_str!("devin-localization-baseline.js");
const CURSOR_BASELINE_DICT: &str = include_str!("cursor-dictionary-baseline.json");
const AG_IDE_BASELINE_DICT: &str = include_str!("antigravity-ide-dictionary-baseline.json");

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppLocalizationStatus {
    pub platform: String,
    pub installed: bool,
    pub localized: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub lang_pack_installed: bool,
    pub message: Option<String>,
}

/// 平台元信息：显示名 + 用户数据目录候选名（按优先级）。
/// 候选名同时用于两处推导：%APPDATA%\<name>（VS Code 系标准 user-data-dir，
/// Windsurf 进程 --user-data-dir 实锤）与 ~/.<name>（Codeium 传统的扩展目录位置）。
/// Devin Desktop 由 Windsurf OTA 更名而来，新旧世代名都要探测。
/// claude-desktop 是 Electron 翻译文件覆盖机制，无用户数据目录需求，传空数组。
fn platform_meta(platform: &str) -> Option<(&'static str, &'static [&'static str])> {
    match platform {
        "windsurf" => Some(("Windsurf", &["Windsurf"])),
        "devin" => Some(("Devin Desktop", &["Devin", "Windsurf"])),
        "cursor" => Some(("Cursor", &["Cursor"])),
        "claude-desktop" => Some(("Claude Desktop", &[])),
        "antigravity-ide" => Some(("Antigravity IDE", &["Antigravity IDE", "Antigravity"])),
        _ => None,
    }
}

/// 状态目录（argv.json / languagepacks.json 所在）：VS Code 系标准位置是
/// %APPDATA%\<name>（Windsurf 实测 --user-data-dir 就在此）。
fn ide_state_dir(platform: &str) -> Option<PathBuf> {
    let (_, names) = platform_meta(platform)?;
    if names.is_empty() {
        return None;
    }
    let roaming = dirs::config_dir()?;
    names
        .iter()
        .map(|n| roaming.join(n))
        .find(|p| p.is_dir())
        .or_else(|| names.first().map(|n| roaming.join(n)))
}

/// 扩展目录（extensions/ 所在）。
/// Windsurf 系（Codeium 传统）实测把扩展放在 ~/.<name>/extensions；
/// 其余（Cursor / Antigravity IDE 等标准 VS Code 系）在 %APPDATA%\<name>/extensions。
/// 注意：Cursor 的 ~/.cursor 是 CLI agent 的目录（agents/cli-config/skills），
/// 绝不能把编辑器扩展装到那儿——只有 Windsurf 系才探测 home 位置。
fn ide_extensions_dir(platform: &str) -> Option<PathBuf> {
    let (_, names) = platform_meta(platform)?;
    if names.is_empty() {
        return None;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(roaming) = dirs::config_dir() {
        for n in names {
            candidates.push(roaming.join(n).join("extensions"));
        }
    }
    if platform == "windsurf" || platform == "devin" {
        if let Some(home) = dirs::home_dir() {
            for n in names {
                // home 下是点前缀小写形式（.windsurf / .devin）
                let lower = n.to_lowercase().replace(' ', "-");
                candidates.push(home.join(format!(".{}", lower)).join("extensions"));
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_dir())
        .or_else(|| ide_state_dir(platform).map(|d| d.join("extensions")))
}

fn cache_dir(platform: &str) -> PathBuf {
    let p = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AnyBridge")
        .join("localization")
        .join(platform);
    let _ = fs::create_dir_all(&p);
    p
}

// ---------------------------------------------------------------------------
// 副作用记账（side-effects）
//
// 汉化/接入除了注入块，还有三类「还原英文」时必须回滚的副作用：
//   1. CSP 补的 'unsafe-inline'（注入 inline script 所需）
//   2. argv.json 的 locale=zh-cn（显示语言切换）
//   3. NLS 取词加固（workbench.desktop.main.js，备份/还原在 workbench_inject）
// 审计事故：restore 只剥注入块，三类副作用全部残留——CSP 被永久削弱、
// 文案承诺"还原官方英文原版"却仍是中文界面。
// 记账文件 side-effects.json 记录「我们实际改了什么」，restore 据此精确回滚；
// 用户在两次操作之间手动改过的状态不回滚（见 restore 内的判据）。
// ---------------------------------------------------------------------------

/// locale 记账值：改之前该键不存在
const LOCALE_ABSENT: &str = "__absent__";

/// locale 改前值的记账内容。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LocaleRecord {
    /// 改之前 locale = 该值
    Was(String),
    /// 改之前没有 locale 键
    Absent,
}

fn side_effects_path(platform: &str) -> PathBuf {
    cache_dir(platform).join("side-effects.json")
}

fn read_side_effects(platform: &str) -> Value {
    fs::read_to_string(side_effects_path(platform))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_side_effects(platform: &str, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    write_atomic(&side_effects_path(platform), &text).map_err(|e| e.to_string())
}

/// 记账：某入口 HTML 的 CSP 由我们补过 'unsafe-inline'。
pub(crate) fn record_csp_inserted(platform: &str, file_name: &str) -> Result<(), String> {
    let mut v = read_side_effects(platform);
    v["csp"][file_name] = json!(true);
    write_side_effects(platform, &v)
}

/// 消费记账：该文件的 CSP 插入记录（读出即清除，回滚只做一次）。
pub(crate) fn take_csp_record(platform: &str, file_name: &str) -> Result<bool, String> {
    let mut v = read_side_effects(platform);
    let had = v
        .get("csp")
        .and_then(|c| c.get(file_name))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    if had {
        if let Some(c) = v.get_mut("csp").and_then(|c| c.as_object_mut()) {
            c.remove(file_name);
        }
        write_side_effects(platform, &v)?;
    }
    Ok(had)
}

/// 记账：argv.json 的 locale 改前值。
pub(crate) fn record_locale_previous(
    platform: &str,
    previous: Option<&str>,
) -> Result<(), String> {
    let mut v = read_side_effects(platform);
    v["localePrevious"] = match previous {
        Some(s) => json!(s),
        None => json!(LOCALE_ABSENT),
    };
    write_side_effects(platform, &v)
}

/// 消费记账：argv.json 的 locale 改前值（读出即清除）。
/// None = 没有记账（我们从没改过 locale）。
pub(crate) fn take_locale_record(platform: &str) -> Result<Option<LocaleRecord>, String> {
    let mut v = read_side_effects(platform);
    let Some(rec) = v.get("localePrevious").cloned() else {
        return Ok(None);
    };
    if let Some(obj) = v.as_object_mut() {
        obj.remove("localePrevious");
    }
    write_side_effects(platform, &v)?;
    Ok(Some(match rec.as_str() {
        Some(LOCALE_ABSENT) | None => LocaleRecord::Absent,
        Some(s) => LocaleRecord::Was(s.to_string()),
    }))
}

/// 把 argv.json 的 locale 回滚为记账的改前值（Absent = 删除该键）。
/// JSONC 解析失败返回 None——调用方绝不能用空对象覆盖（pitfalls: argv-json-is-jsonc）。
fn revert_locale_in_argv(raw: &str, record: &LocaleRecord) -> Option<String> {
    let mut doc = parse_jsonc(raw)?;
    if let Some(obj) = doc.as_object_mut() {
        match record {
            LocaleRecord::Was(v) => {
                obj.insert("locale".to_string(), json!(v));
            }
            LocaleRecord::Absent => {
                obj.remove("locale");
            }
        }
    }
    serde_json::to_string_pretty(&doc).ok()
}

/// 上游 raw URL（分平台：windsurf 系是完整脚本，cursor/claude 是词典 JSON，
/// antigravity-ide 是含 dictionary 的 localize.js）。
fn upstream_raw_url(platform: &str) -> Option<&'static str> {
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
fn script_cache_name(platform: &str) -> &'static str {
    match platform {
        "claude-desktop" => "zh-CN.json",
        _ => "dictionary.json",
    }
}

/// 把字符串序列化为合法 JS 字符串字面量（JSON 字符串是 JS 字符串子集；
/// 额外转义 U+2028/2029 防老引擎语法坑）。
fn js_string(s: &str) -> String {
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
fn build_script_from_dictionary(dict_json: &str) -> Option<String> {
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
fn extract_dictionary_from_windsurf_script(source: &str) -> Option<Value> {
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
fn extract_dictionary_from_localize(source: &str) -> Option<Value> {
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
fn baseline_dict(platform: &str) -> Option<&'static str> {
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
fn hans_script(platform: &str) -> String {
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
fn merge_dictionaries(baseline_json: &str, cached_json: &str) -> String {
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
fn hans_script_for_window(platform: &str, aux_window: bool) -> String {
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

fn read_cached_version(platform: &str) -> String {
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

fn read_cached_sha(platform: &str) -> String {
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

/// 从 workbench.html 的 CSP 里提取 script-src 的 nonce 值。
///
/// 为什么必须带它：CSP3 规范规定——**script-src 里出现 nonce 时，'unsafe-inline'
/// 会被浏览器忽略**，只有带匹配 nonce 属性的内联脚本才允许执行。
/// 实测：Devin 的 CSP 是 `script-src 'unsafe-inline' ... 'nonce-0c6a828f1297'`，
/// 我们注入的块没带 nonce → 脚本被 CSP 直接拒绝、一次都没执行（表现为"注入了
/// 但汉化不生效"）；而 Windsurf 的 CSP 没有 nonce、只有 'unsafe-inline' →
/// 同样的注入就能跑。这正是两个平台表现不同的唯一原因。
pub(crate) fn extract_csp_nonce(html: &str) -> Option<String> {
    // 形如：'nonce-0c6a828f1297'
    let re = regex::Regex::new(r"'nonce-([A-Za-z0-9]+)'").ok()?;
    re.captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// workbench.html 是否结构完整（可用于注入）。
///
/// 只能用**结构**判断，绝不能用体积：各发行版体积差异极大且都合法——
/// Windsurf 原厂 300KB+，Devin 原厂只有约 1.7KB（界面靠 workbench.js 加载，
/// html 只是个壳）。而且"被中断的写入残骸"可以是任意大小，与合法小文件
/// 在体积上无法区分（实测踩过：体积阈值把健康的 Devin 判成损坏）。
///
/// 可靠判据是闭合标签：`</body>` 位于文件末尾，写入被中断就一定写不到它。
fn is_valid_workbench(html: &str) -> bool {
    html.contains("</body>")
}

/// 某个界面入口 HTML 的快照位置（AnyBridge 缓存内，与 IDE 安装目录解耦）。
///
/// 为什么需要：同目录的 `.hans-origin` 备份在还原成功后会被删除，一旦写入
/// 过程被强杀留下截断文件，就再也没有回滚源（实测事故：Devin 307KB 被截成
/// 1.7KB，IDE 起不来且无备份）。快照每次 apply 刷新，保存"上一次可用状态"。
///
/// 一个平台可能有多个入口 HTML（Antigravity IDE 的设置页独立成窗口），
/// 快照必须按文件名区分，否则两个文件会互相覆盖，自愈时把 A 的内容写进 B。
/// 目录由调用方传入（生产传 cache_dir，测试传临时目录，绝不写真实用户缓存）。
fn html_snapshot_path(cache_dir: &Path, html_path: &Path) -> PathBuf {
    let name = html_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("workbench.html");
    cache_dir.join(format!("{name}.snapshot.html"))
}

/// Antigravity IDE 需要注入的全部界面入口 HTML。
///
/// 主入口 + 独立引导窗口（`workbench-jetski-agent.html`，见常量注释），
/// 并顺带扫描同目录 `workbench-*.html`：官方再拆新窗口时无需改代码即可覆盖。
/// 其它平台仍只有主 workbench.html（多平台先单平台试点，不扩大到别家）。
fn ag_ide_entry_htmls(primary: &Path) -> Vec<PathBuf> {
    let mut out = vec![primary.to_path_buf()];
    let Some(dir) = primary.parent() else {
        return out;
    };

    let mut extras: Vec<PathBuf> = Vec::new();
    let explicit = dir.join(AG_IDE_AGENT_WINDOW_HTML);
    if explicit.exists() {
        extras.push(explicit);
    }
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            let Some(name) = p.file_name().and_then(|v| v.to_str()) else {
                continue;
            };
            if name == "workbench.html" || !name.starts_with("workbench-") || !name.ends_with(".html")
            {
                continue;
            }
            extras.push(p);
        }
    }
    extras.sort();
    extras.dedup();
    out.extend(extras);
    out
}

/// 平台本次需要注入汉化的全部入口 HTML（空 = 未安装/未定位）。
fn localization_target_htmls(platform: &str) -> Vec<PathBuf> {
    match workbench_html_path(platform) {
        Some(primary) if platform == "antigravity-ide" => ag_ide_entry_htmls(&primary),
        Some(primary) => vec![primary],
        None => Vec::new(),
    }
}

/// 汉化启用标记（保活依据）：apply 成功时写入，restore 成功时删除。
/// IDE 升级会把 html 覆盖回原厂（汉化标记消失），仅靠 html 判断会误判为
/// "用户主动还原"，所以必须有独立的持久化开启标记。
fn enabled_marker_path(platform: &str) -> PathBuf {
    cache_dir(platform).join("enabled.json")
}

pub(crate) fn is_enabled(platform: &str) -> bool {
    enabled_marker_path(platform).exists()
}

fn set_enabled(platform: &str) {
    let meta = json!({
        "platform": platform,
        "enabledAt": chrono::Utc::now().to_rfc3339()
    });
    let _ = fs::write(
        enabled_marker_path(platform),
        meta.to_string().as_bytes(),
    );
}

fn clear_enabled(platform: &str) {
    let _ = fs::remove_file(enabled_marker_path(platform));
}

/// IDE 内置引擎版本：优先 product.json 的 vscodeVersion 字段（Cursor 等发行版
/// 用自己的版本号，如 3.15.6，而内置 VS Code 引擎在 vscodeVersion，如 1.128.0），
/// 回退 version 字段（Windsurf 系的 version 即引擎对齐版本）。
fn engine_version(platform: &str) -> Option<String> {
    product_json_path(platform)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("vscodeVersion")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("version").and_then(|x| x.as_str()))
                .map(|s| s.to_string())
        })
}

/// 已装语言包里是否有与 IDE 引擎 major.minor 匹配的版本。
///
/// 语言包跨引擎版本不兼容（engines.vscode 校验）：引擎 1.110.1 配 1.126.0
/// 的语言包会被 VS Code 拒绝加载，locale 设了也回退英文——装了等于没装。
/// 必须按兼容性判定，不能只看目录存在。
fn compatible_lang_pack_dir(platform: &str) -> Option<PathBuf> {
    let engine = engine_version(platform)?;
    let want: Vec<u32> = engine.split('.').filter_map(|p| p.parse::<u32>().ok()).collect();
    if want.len() < 2 {
        return None;
    }
    let ext_dir = ide_extensions_dir(platform)?;
    let entries = fs::read_dir(&ext_dir).ok()?;
    let mut matched: Option<PathBuf> = None;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(LANG_PACK_DIR_PREFIX) else {
            continue;
        };
        let ver: Vec<u32> = rest
            .trim_start_matches('-')
            .split('.')
            .filter_map(|p| p.parse::<u32>().ok())
            .collect();
        if ver.len() >= 2 && ver[0] == want[0] && ver[1] == want[1] {
            matched = Some(e.path());
        }
    }
    matched
}

/// 读扩展目录的 `.obsolete` 废弃标记 key 集合（小写，用于前缀匹配）。
fn obsolete_keys(ext_dir: &Path) -> Vec<String> {
    let path = ext_dir.join(".obsolete");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    val.as_object()
        .map(|m| m.keys().map(|k| k.to_lowercase()).collect())
        .unwrap_or_default()
}

/// 按扩展 id 找扩展目录（目录名 == id 或以 `id-` 开头，大小写不敏感）。
/// 第三方语言包目录常带后缀（如 `...-zh-hans-0.0.2-universal`），不能只做全等。
fn extension_dir_for_id(ext_dir: &Path, id: &str) -> Option<PathBuf> {
    let id_lower = id.to_lowercase();
    let prefix = format!("{id_lower}-");
    let entries = fs::read_dir(ext_dir).ok()?;
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name == id_lower || name.starts_with(&prefix) {
            return Some(e.path());
        }
    }
    None
}

/// 是否已安装**且实际生效**的中文语言包插件。
///
/// 汉化是两层叠加：①语言包插件（核心 UI：菜单/设置等）+ ②workbench 注入
/// （专有 UI，见 apply_inner）。本函数只判①，且**不限定官方包**——
/// 任意 zh-cn 语言包插件（含功能完整的第三方包）生效都算数。
///
/// 「生效」三条件，缺一视为未生效（apply 会走安装/注册修复）：
/// 1. `translations.vscode` 指向的核心翻译文件存在——这是「能翻核心 UI」的硬证据；
///    旧判据要求必须注册到官方包 id，会把「注册到功能完整的第三方中文包」
///    （实测 openubmc 包覆盖核心 + 100+ 内置扩展、界面全中文）误判为未汉化
/// 2. 条件 2：不在 .obsolete 废弃列表里——扩展扫描器直接跳过被标记的目录，
///    "装了但被标记"等于没装（实测：Devin 重装后注册表重置、官方包被标记废弃）
/// 3. 条件 3：languagepacks.json 的 zh-cn 注册项真实加载——注册的扩展目录存在
///    才算数（不限定官方包 id；第三方完整包同样有效）
fn lang_pack_installed(platform: &str) -> bool {
    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return false;
    };
    let Some(state_dir) = ide_state_dir(platform) else {
        return false;
    };
    let lp_path = state_dir.join("languagepacks.json");
    let Ok(raw) = fs::read_to_string(&lp_path) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(zh) = val.get("zh-cn") else {
        return false;
    };

    // 条件 2：核心翻译文件存在（官方包与完整第三方包都具备）
    let core_translation_ok = zh
        .get("translations")
        .and_then(|t| t.get("vscode"))
        .and_then(|v| v.as_str())
        .map(|p| !p.trim().is_empty() && PathBuf::from(p).exists())
        .unwrap_or(false);
    if !core_translation_ok {
        return false;
    }

    // 条件 3：至少一个注册项真实加载（目录存在 + 未被废弃）
    let obsolete = obsolete_keys(&ext_dir);
    zh.get("extensions")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter().any(|e| {
                let Some(id) = e
                    .get("extensionIdentifier")
                    .and_then(|i| i.get("id"))
                    .and_then(|id| id.as_str())
                else {
                    return false;
                };
                let id_lower = id.to_lowercase();
                if obsolete.iter().any(|k| k.starts_with(&id_lower)) {
                    return false;
                }
                extension_dir_for_id(&ext_dir, id).is_some()
            })
        })
        .unwrap_or(false)
}

/// 原子写：同目录临时文件 + rename，避免写一半崩溃留下截断 HTML。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.hans-tmp", path.to_string_lossy()));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    for i in 0..3u32 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if i == 2 {
                    let _ = fs::remove_file(&tmp);
                    return Err(e.to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    Ok(())
}

/// 移除已存在的汉化注入块（幂等重注入用）。
///
/// 注入格式是 `"\n{块}\n"`（插在 </body> 前），剥离必须把这两个换行一并移除：
/// 只删块本体会让文件比原厂多出空行，逐轮累积——AG IDE 的 product.json
/// 校验和覆盖 workbench.html，还原后原厂哈希一对上就弹「安装似乎损坏」
/// （实测事故 2026-10-31：两个入口 HTML 各累积 +4/+2 个换行）。
fn strip_hans_block(html: &str) -> String {
    strip_injected_block(
        html,
        HANS_BLOCK_START,
        HANS_BLOCK_END,
    )
}

/// 通用注入块剥离：移除 `[START, END]`，并把注入时带入的前导/尾随换行一并吸收。
/// 块前后不是换行（异常态/手工贴入）时按原边界剥离，绝不吞掉正文内容。
pub(crate) fn strip_injected_block(html: &str, start_marker: &str, end_marker: &str) -> String {
    let (Some(s), Some(e)) = (html.find(start_marker), html.find(end_marker)) else {
        return html.to_string();
    };
    let mut begin = s;
    if begin > 0 && html.as_bytes()[begin - 1] == b'\n' {
        begin -= 1;
    }
    let mut stop = e + end_marker.len();
    if stop < html.len() && html.as_bytes()[stop] == b'\n' {
        stop += 1;
    }
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..begin]);
    out.push_str(&html[stop..]);
    out
}

/// 快照自愈/回滚时保住 BYOK 注入块，避免两条链在异常路径上互相踩。
///
/// 场景：先汉化、后接入 BYOK 时，汉化快照生成于 BYOK 注入之前（快照只在
/// 汉化 apply 时刷新），快照里没有 byok 块。若此后文件被截断（强杀/磁盘满）
/// 触发快照自愈，整体覆盖会把 BYOK 块抹掉——界面卡片消失且用户无感知。
///
/// 判据：损坏文件里 start 与 end 标记都在才拼接（截断通常丢尾部，块可能仍完整）；
/// 缺任一标记视为不完整，绝不拼接半截脚本。快照自带宽块时原样返回。
fn snapshot_with_byok_preserved(current: &str, snapshot: &str) -> String {
    if snapshot.contains(BYOK_BLOCK_START) {
        return snapshot.to_string();
    }
    let (Some(s), Some(e)) = (current.find(BYOK_BLOCK_START), current.find(BYOK_BLOCK_END)) else {
        return snapshot.to_string();
    };
    if e < s {
        return snapshot.to_string();
    }
    let block = &current[s..e + BYOK_BLOCK_END.len()];
    let Some(idx) = snapshot.rfind("</body>") else {
        return snapshot.to_string();
    };
    let mut out = String::with_capacity(snapshot.len() + block.len() + 1);
    out.push_str(&snapshot[..idx]);
    out.push_str(block);
    out.push('\n');
    out.push_str(&snapshot[idx..]);
    out
}

// ---------------------------------------------------------------------------
// Claude Desktop（Electron 翻译文件覆盖机制）
//
// 与 VS Code 系的 workbench.html 注入完全不同：Claude 的界面文案在
// app/resources/ion-dist/i18n/en-US.json（渲染层语言文件，扁平 id→英文）。
// 汉化 = 合并覆盖：有译文的 key 写中文，未覆盖的保留英文，原地写回。
// 上游词库 22,000+ 条（1MB），不内置基线，首次 apply 需联网下载并缓存。
// ---------------------------------------------------------------------------

/// 从目录名里提取版本号（"app-1.2.3" → [1,2,3]），用于挑出最新版本目录。
fn parse_version_dir(name: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in name.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            if let Ok(n) = cur.parse::<u32>() {
                out.push(n);
            }
            cur.clear();
        }
    }
    if !cur.is_empty() {
        if let Ok(n) = cur.parse::<u32>() {
            out.push(n);
        }
    }
    out
}

/// 在 Claude 安装根目录（AnthropicClaude）下挑 ion-dist 目录：
/// 只认 `<版本目录>/resources/app/resources/ion-dist` 结构，并取**版本号最大**的那个。
///
/// 必须挑最新版本：Claude 升级后旧版本目录会残留，若打到旧目录等于没汉化，
/// 且现象是"点了汉化但界面没变"，极难排查。
fn pick_claude_ion_dist(root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    let mut best: Option<(Vec<u32>, PathBuf)> = None;
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir
            .join("resources")
            .join("app")
            .join("resources")
            .join("ion-dist");
        if !candidate.join("index.html").exists() {
            continue;
        }
        // 取不到文件名的条目跳过即可，不能用 `?`：那会放弃整个搜索并丢掉已找到的候选
        let Some(name) = dir.file_name() else {
            continue;
        };
        let ver = parse_version_dir(&name.to_string_lossy());
        if best.as_ref().map(|(bv, _)| ver > *bv).unwrap_or(true) {
            best = Some((ver, candidate));
        }
    }
    best.map(|(_, p)| p)
}

/// Claude Desktop 的 ion-dist 目录（前端资源根）。
/// 官网安装版优先（%LOCALAPPDATA%\AnthropicClaude 最新版本目录），
/// 商店版（MSIX/WindowsApps）通过 Appx 清单定位。
#[cfg(target_os = "windows")]
fn claude_ion_dist_dir() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // 1. 官网安装版：按版本目录精准定位
    if let Some(local) = dirs::data_local_dir() {
        let root = local.join("AnthropicClaude");
        if root.is_dir() {
            if let Some(found) = pick_claude_ion_dist(&root) {
                return Some(found);
            }
        }
    }
    // 2. 商店版：Appx InstallLocation/app/resources/ion-dist
    // 包名用 "*Claude*" 通配符：精确名 'Claude' 在部分机器上匹配不到商店版包。
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-AppxPackage -Name '*Claude*' | Where-Object { $_.InstallLocation } | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
        ])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let install = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !install.is_empty() {
        let p = PathBuf::from(install)
            .join("app")
            .join("resources")
            .join("ion-dist");
        if p.join("index.html").exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn claude_ion_dist_dir() -> Option<PathBuf> {
    // macOS: /Applications/Claude.app/Contents/Resources/app/resources/ion-dist
    let p = PathBuf::from(
        "/Applications/Claude.app/Contents/Resources/app/resources/ion-dist",
    );
    if p.join("index.html").exists() {
        return Some(p);
    }
    None
}

/// 注入标记：index.html 里出现它即视为已汉化（也是 keeper 的判据）。
const CLAUDE_ZH_MARKER: &str = "__anybridgeZh3";
/// Claude 注入的语言 locale。
const CLAUDE_ZH_LOCALE: &str = "zh-Hans";

/// 授权目录/文件的写权限（MSIX 的 WindowsApps 受保护目录）。
/// 目录用 (OI)(CI) 让新建文件继承；文件单独授权才能改写已存在的 index.html。
#[cfg(target_os = "windows")]
fn grant_acl(path: &Path, is_dir: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let hidden = 0x0800_0000;
    let p = path.to_string_lossy().to_string();
    let suffix = if is_dir { ":(OI)(CI)F" } else { ":F" };
    let _ = std::process::Command::new("takeown.exe")
        .args(["/F", &p, "/A"])
        .creation_flags(hidden)
        .status();
    let mut grants = vec!["Administrators".to_string(), "*S-1-5-32-544".to_string()];
    if let Ok(user) = std::env::var("USERNAME") {
        grants.push(user);
    }
    for who in grants {
        let _ = std::process::Command::new("icacls.exe")
            .args([&p, "/grant", &format!("{}{}", who, suffix)])
            .creation_flags(hidden)
            .status();
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn grant_acl(_path: &Path, _is_dir: bool) -> Result<(), String> {
    Ok(())
}

/// 扫描 ion-dist 找语言 store 模块与导出别名。
///
/// Claude 每次升级都会重新混淆打包，模块文件名与导出别名都会变
/// （1.49585 是 shared-3-DO6JrgpN.js / Rd，3.6556 是 shared-52-uHFNjl7C.js / Wp），
/// 所以必须运行时按特征扫描，不能硬编码。
fn detect_claude_store(dist: &Path) -> Option<(String, String)> {
    let assets = dist.join("assets");
    let mut stack = vec![assets];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("js") {
                continue;
            }
            let Ok(src) = fs::read_to_string(&p) else {
                continue;
            };
            // 语言 store 的初始化特征
            if !src.contains("messagesLocale:null") {
                continue;
            }
            let Some((sym, exp)) = extract_store_symbols(&src) else {
                continue;
            };
            let _ = sym;
            let rel = p
                .strip_prefix(dist)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            return Some((rel, exp));
        }
    }
    None
}

/// 从 store 模块源码提取「store 变量符号」与「导出别名」。
/// 形如：`...,Oy=Oi((e,t)=>({messages:{},messagesLocale:null,...` + `export{... Oy as Wp ...}`
fn extract_store_symbols(src: &str) -> Option<(String, String)> {
    let anchor = src.find("messagesLocale:null")?;
    // store 定义形如：`...,js=Dn((e,t)=>({messages:{},messagesLocale:null...`
    // 取 anchor 之前**最靠后**的 `符号=函数((e,t)=>(` 匹配。
    let head = &src[..anchor];
    let re_def = regex::Regex::new(r"([$\w]+)\s*=\s*[$\w]+\s*\(\(e,t\)\s*=>").ok()?;
    let sym = re_def
        .captures_iter(head)
        .last()?
        .get(1)?
        .as_str()
        .to_string();
    let escaped = sym.replace('$', "\\$");
    let re = regex::Regex::new(&format!(
        r"[,{{]\s*{}\s+as\s+([$\w]+)\s*[,}}]",
        escaped
    ))
    .ok()?;
    let exp = re.captures(src)?.get(1)?.as_str().to_string();
    Some((sym, exp))
}

/// 生成注入脚本：声明 zh-Hans 目录（meta 要求 **两段** hash `locale:h1.h2`），
/// 再调 store 的 setLocaleOverride 切语言。
/// 词典已就位于 /i18n/zh-Hans.json，前端按 locale 自行请求，故脚本极小。
fn claude_inject_snippet(store_rel: &str, store_export: &str) -> String {
    format!(
        r#"
<script>
/* AnyBridge Claude 中文注入：声明 zh-Hans 目录（两段 hash）并运行时切换语言。
   词典位于 /i18n/{{locale}}.json，前端自行加载。 marker: {marker} */
(function(){{
  if(window.{marker}) return; window.{marker}=1;
  function declare(){{
    try{{
      var m=document.querySelector('meta[name="i18n-catalogs"]');
      if(!m){{ m=document.createElement('meta'); m.name='i18n-catalogs'; document.head.appendChild(m); }}
      var cur=m.getAttribute('data-i18n-catalogs')||'';
      if(!/(^|,){locale}:/.test(cur)){{
        m.setAttribute('data-i18n-catalogs',(cur?cur+',':'')+'{locale}:1.1');
      }}
    }}catch(e){{}}
  }}
  async function applyZh(){{
    try{{
      declare();
      var mod=await import('/{store_rel}');
      var store=mod['{store_export}'];
      if(!store||typeof store.getState!=='function'){{ console.warn('[anybridge-zh] store missing'); return; }}
      var st=store.getState();
      if(typeof st.setLocaleOverride!=='function'){{ console.warn('[anybridge-zh] api missing'); return; }}
      if(st.localeOverride!=='{locale}'){{ st.setLocaleOverride('{locale}'); }}
      console.info('[anybridge-zh] applied');
    }}catch(e){{ console.warn('[anybridge-zh] failed:', e && (e.message||e)); }}
  }}
  document.addEventListener('DOMContentLoaded',function(){{ declare(); applyZh(); }});
  window.addEventListener('load',function(){{ declare(); applyZh(); }});
  var n=0,t=setInterval(function(){{ declare(); if(n===0||n===10||n===20||n===30) applyZh(); if(++n>50) clearInterval(t); }},300);
}})();
</script>
"#,
        marker = CLAUDE_ZH_MARKER,
        locale = CLAUDE_ZH_LOCALE,
        store_rel = store_rel,
        store_export = store_export,
    )
}

/// 剥离 index.html 里我们注入的脚本（幂等重注入用）。
///
/// 与注入格式互逆：注入片段是 `"\n<script>…</script>\n"`（插在 </head> 前），
/// 剥离必须把这两个换行一并吸掉，否则每轮「注入→剥离」净漏 2 字节
/// （Claude 没有 index.html 完整性校验，泄漏无症状但文件会慢性膨胀）。
fn claude_strip_inject(html: &str) -> String {
    let re = regex::Regex::new(
        r"(?s)\n?<script>\s*/\* AnyBridge Claude 中文注入.*?</script>\n?",
    )
    .unwrap();
    re.replace_all(html, "").to_string()
}

/// 注入（或刷新）index.html 的脚本，返回是否有改动。
fn claude_inject_index(dist: &Path, snippet: &str) -> Result<bool, String> {
    let idx = dist.join("index.html");
    let raw = fs::read_to_string(&idx).map_err(|e| format!("读取 index.html 失败: {e}"))?;
    let cleaned = claude_strip_inject(&raw);
    let injected = if let Some(pos) = cleaned.find("</head>") {
        let mut out = String::with_capacity(cleaned.len() + snippet.len());
        out.push_str(&cleaned[..pos]);
        out.push_str(snippet);
        out.push_str(&cleaned[pos..]);
        out
    } else {
        format!("{cleaned}{snippet}")
    };
    if injected == raw {
        return Ok(false);
    }
    // index.html 是已存在文件，必须单文件授权（目录 inherit 只对新文件生效）
    grant_acl(&idx, false)?;
    fs::write(&idx, injected.as_bytes()).map_err(|e| format!("写入 index.html 失败: {e}"))?;
    Ok(true)
}

/// 写 Claude 的中文词典文件：/i18n/zh-Hans.json 与 /i18n/dynamic/zh-Hans.json。
/// 返回写入的 base 词条数。
fn claude_write_zh_dicts(dist: &Path) -> Result<usize, String> {
    let cache = cache_dir("claude-desktop");
    let dict_path = cache.join(script_cache_name("claude-desktop"));
    let raw = fs::read_to_string(&dict_path).map_err(|_| {
        "本地暂无中文词库，请先点击「检查在线词库更新」下载".to_string()
    })?;
    let va: Value =
        serde_json::from_str(&raw).map_err(|e| format!("词库缓存解析失败: {e}"))?;
    let map = va.as_object().ok_or("词库缓存格式异常（非 JSON 对象）")?;
    if map.is_empty() {
        return Err("词库缓存为空，已中止写入".to_string());
    }

    let i18n = dist.join("i18n");
    let dynamic = i18n.join("dynamic");
    let _ = fs::create_dir_all(&dynamic);
    grant_acl(&i18n, true)?;

    let base_out = serde_json::to_string(&va).map_err(|e| e.to_string())?;
    fs::write(i18n.join(format!("{CLAUDE_ZH_LOCALE}.json")), base_out.as_bytes())
        .map_err(|e| format!("写入 zh-Hans 词典失败: {e}"))?;

    // dynamic 词典：缓存目录里若有 dynamic 就用，否则空对象兜底
    let dyn_src = cache.join("dynamic-zh-CN.json");
    let dyn_out = fs::read_to_string(&dyn_src)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));
    fs::write(
        dynamic.join(format!("{CLAUDE_ZH_LOCALE}.json")),
        serde_json::to_string(&dyn_out).unwrap_or_else(|_| "{}".to_string()).as_bytes(),
    )
    .map_err(|e| format!("写入 dynamic 词典失败: {e}"))?;

    Ok(map.len())
}

/// Claude 的用户配置文件（config.json，含 locale 字段）。
fn claude_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Claude").join("config.json"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().map(|h| {
            h.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("config.json")
        })
    }
}

/// 把 config.json 的 locale 设为指定值（幂等），返回是否有改动。
/// Claude 升级会重写该文件，因此每次 apply 都要重设。
fn claude_set_locale(locale: &str, restore: bool) -> Result<bool, String> {
    let Some(cfg) = claude_config_path() else {
        return Ok(false);
    };
    if !cfg.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&cfg).map_err(|e| format!("读取 config.json 失败: {e}"))?;
    let mut doc: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // 解析失败绝不覆盖用户配置
        Err(_) => return Err("Claude config.json 解析失败，已跳过语言设置".to_string()),
    };
    let cur = doc.get("locale").and_then(|v| v.as_str()).unwrap_or("");
    let target = if restore { "en-US" } else { locale };
    if cur == target {
        return Ok(false);
    }
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("locale".to_string(), json!(target));
    }
    // 备份一次原始配置，便于排查
    let bak = cfg.with_extension("json.anybridge-bak");
    if !bak.exists() {
        let _ = fs::write(&bak, raw.as_bytes());
    }
    fs::write(&cfg, serde_json::to_string_pretty(&doc).unwrap_or(raw).as_bytes())
        .map_err(|e| format!("写入 config.json 失败: {e}"))?;
    Ok(true)
}

/// Claude 是否已汉化：index.html 里有我们的注入标记且 zh-Hans 词典就位。
/// 用注入标记而不是"中文字符数"，因为升级会覆盖整个目录，标记随之消失。
fn is_claude_localized() -> bool {
    let Some(dist) = claude_ion_dist_dir() else {
        return false;
    };
    let Ok(html) = fs::read_to_string(dist.join("index.html")) else {
        return false;
    };
    if !html.contains(CLAUDE_ZH_MARKER) {
        return false;
    }
    dist.join("i18n")
        .join(format!("{CLAUDE_ZH_LOCALE}.json"))
        .exists()
}

/// 已汉化 = **每一个**入口 HTML 都带汉化块。
///
/// 只看主 workbench.html 会把"菜单中文、设置页仍英文"的半汉化状态误报成
/// 已完成（Antigravity IDE 的设置页入口独立成窗口，实测事故）。keeper 也靠
/// 这个判定决定是否重注入，判据必须覆盖完整生效链。
fn is_localized(platform: &str) -> bool {
    if platform == "claude-desktop" {
        return is_claude_localized();
    }
    let targets = localization_target_htmls(platform);
    !targets.is_empty()
        && targets.iter().all(|p| {
            fs::read_to_string(p)
                .map(|html| html.contains(HANS_BLOCK_START))
                .unwrap_or(false)
        })
}

/// 客户端是否已安装（分平台：VS Code 系看 workbench.html，Claude 看语言文件）。
/// build_status 与保活 keeper 必须共用同一判定，否则会出现"状态显示已安装
/// 但 keeper 永远不重注入"的偏差（Claude 没有 workbench.html）。
fn is_installed(platform: &str) -> bool {
    // 不支持的平台一律未安装：未知 target 会落到 find_ide_exe 的默认分支
    // （当成 Windsurf 探测），不拦掉会把别人的安装误判成自己的。
    if platform_meta(platform).is_none() {
        return false;
    }
    if platform == "claude-desktop" {
        claude_ion_dist_dir().is_some()
    } else {
        workbench_html_path(platform).is_some()
    }
}

/// 统计脚本词条数。兼容两种序列化风格：
/// 上游原版脚本用单引号（`\t\t['en', 'zh'],`），词典组装生成的用双引号。
fn count_entries(script: &str) -> usize {
    let re = regex::Regex::new(r#"(?m)^\s*\[["']"#).unwrap();
    re.find_iter(script).count()
}

/// 解析 JSONC（VS Code 系 argv.json 是带 // 注释的模板）。
/// 剥掉行/块注释后再按标准 JSON 解析；解析失败返回 None，调用方绝不覆盖原文件。
fn parse_jsonc(raw: &str) -> Option<Value> {
    let no_block = regex::Regex::new(r"/\*[\s\S]*?\*/")
        .unwrap()
        .replace_all(raw, "");
    let no_line = regex::Regex::new(r"(?m)^\s*//.*$")
        .unwrap()
        .replace_all(&no_block, "");
    serde_json::from_str(&no_line).ok()
}

/// 已装中文语言包时把显示语言切到 zh-cn（argv.json，幂等）。
/// 语言包没装时不动——此时 overlay 只汉化专有界面，
/// 标准菜单仍走官方英文，由 UI 提示用户去扩展市场安装语言包。
fn ensure_locale_zh_cn(platform: &str) -> Result<bool, String> {
    if !lang_pack_installed(platform) {
        return Ok(false);
    }
    // argv.json 必须落在 user-data-dir 根（%APPDATA%\<name>）——
    // Electron 启动器只读这个位置。Windsurf 的 user-data-dir 与扩展目录
    // 是分裂的（扩展在 ~/.<name>/extensions），写错地方 locale 完全无效。
    let Some(state) = ide_state_dir(platform) else {
        return Ok(false);
    };
    let argv_path = state.join("argv.json");
    // argv.json 是 JSONC：解析失败时绝不用空对象覆盖，避免丢用户原有配置
    let mut doc: Value = if argv_path.exists() {
        let raw = fs::read_to_string(&argv_path).map_err(|e| e.to_string())?;
        match parse_jsonc(&raw) {
            Some(v) => v,
            None => return Err("argv.json 解析失败（非 JSONC），已跳过语言切换以免覆盖你的配置".to_string()),
        }
    } else {
        json!({})
    };
    if doc.get("locale").and_then(|v| v.as_str()) == Some("zh-cn") {
        return Ok(false);
    }
    // 记账改前值：还原时据此精确回滚（键不存在 = 还原时删除该键）
    let previous = doc.get("locale").and_then(|v| v.as_str()).map(|s| s.to_string());
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("locale".to_string(), json!("zh-cn"));
    }
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_atomic(&argv_path, &text)?;
    record_locale_previous(platform, previous.as_deref())?;
    Ok(true)
}

/// 解压 VSIX 的 extension/ 目录到目标扩展目录（带 zip-slip 防护）。
fn unzip_extension(zip_path: &Path, target: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 VSIX 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 VSIX 失败: {e}"))?;
    // 第一遍：整包校验。任何条目不可净化即整体拒绝——
    // 否则正常条目先落盘、恶意条目才报错，会留下半截安装目录。
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("读取 VSIX 条目失败: {e}"))?;
        if entry.enclosed_name().is_none() {
            return Err("VSIX 内含非法路径（疑似路径穿越），已中止安装".to_string());
        }
    }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 VSIX 条目失败: {e}"))?;
        // enclosed_name 是 zip crate 官方的防穿越姿势：剔除 .. 与绝对路径组件，
        // 任何条目都被圈在 target 内。
        let safe_name = entry
            .enclosed_name()
            .ok_or_else(|| "VSIX 内含非法路径".to_string())?;
        let name = safe_name.to_string_lossy().to_string();
        let Some(rel) = name.strip_prefix("extension/") else {
            continue; // 只安装 extension/ 内容，忽略元数据
        };
        if rel.is_empty() {
            continue;
        }
        let out_path = target.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压写入失败: {e}"))?;
    }
    Ok(())
}

/// 从 Open VSX 下载并安装 VS Code 官方简体中文语言包（VS Code 系平台通用）。
/// 语言包版本号与 VS Code 引擎对齐（如 1.106.x 语言包配 1.106.x 引擎），
/// 必须按 IDE 的 major.minor 精确匹配，跨版本装了不生效甚至报引擎不兼容。
/// 返回 Ok(true) 表示发生了安装；已装返回 Ok(false)。
/// 从 extensions.json 移除指定扩展 id 的登记条目。
/// VS Code 按登记表 + 目录扫描双源加载扩展：只隔离/替换目录而不清登记，
/// 登记条目会指向不存在的目录，扩展面板报 "Unable to read file" 无法清除。
fn unregister_extension(platform: &str, extension_id: &str) {
    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return;
    };
    let path = ext_dir.join("extensions.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(arr) = val.as_array() else {
        return;
    };
    let kept: Vec<Value> = arr
        .iter()
        .filter(|item| {
            item.get("identifier")
                .and_then(|i| i.get("id"))
                .and_then(|id| id.as_str())
                != Some(extension_id)
        })
        .cloned()
        .collect();
    if kept.len() != arr.len() {
        let _ = fs::write(&path, serde_json::to_string_pretty(&kept).unwrap_or_default());
    }
}

/// 从 .obsolete 移除指定扩展 id 的废弃标记。
/// VS Code 扩展扫描器启动时读这个文件：目录名在 obsolete 列表里的扩展直接跳过——
/// 手动放置的语言包若被标记（卸载残留/扫描异常），目录和 package.json 都合法
/// 也不会被加载，现象是"装了但扩展面板看不到"。
fn clear_obsolete_mark(platform: &str, extension_id: &str) {
    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return;
    };
    let path = ext_dir.join(".obsolete");
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, Value>>(&raw) else {
        return;
    };
    let keys: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with(extension_id))
        .cloned()
        .collect();
    for k in keys {
        map.remove(&k);
    }
    let _ = fs::write(&path, serde_json::to_string(&map).unwrap_or_default());
}

fn install_language_pack(platform: &str) -> Result<bool, String> {
    if lang_pack_installed(platform) {
        return Ok(false);
    }
    let Some(engine) = engine_version(platform) else {
        return Err("无法读取 IDE 引擎版本，请在扩展市场手动安装语言包".to_string());
    };
    let want: Vec<u32> = engine.split('.').filter_map(|p| p.parse::<u32>().ok()).collect();

    // 清理不兼容的旧语言包（如引擎 1.110.1 配了 1.126.0）：对当前引擎无效，
    // 留着会让 VS Code 的语言包选择器选中它导致界面回退英文。
    // 重命名为点前缀目录（VS Code 忽略隐藏目录），不直接删用户文件。
    if let Some(ext_dir) = ide_extensions_dir(platform) {
        if let Ok(entries) = fs::read_dir(&ext_dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.starts_with(LANG_PACK_DIR_PREFIX) {
                    continue;
                }
                let ver: Vec<u32> = name
                    .strip_prefix(LANG_PACK_DIR_PREFIX)
                    .unwrap_or("")
                    .trim_start_matches('-')
                    .split('.')
                    .filter_map(|p| p.parse::<u32>().ok())
                    .collect();
                let compatible = ver.len() >= 2 && want.len() >= 2
                    && ver[0] == want[0] && ver[1] == want[1];
                if !compatible {
                    let renamed = e.path().with_file_name(format!(".incompatible-{}", name));
                    let _ = fs::rename(e.path(), &renamed);
                }
            }
        }
        // 登记表同步：移除该 id 的全部条目，否则登记指向已隔离的目录，
        // 扩展面板持续报 "Unable to read file"（重装 IDE 都消不掉）。
        unregister_extension(platform, LANG_PACK_EXTENSION_ID);
    }

    // apply 是同步命令，语言包下载用 blocking 客户端；
    // apply_system_proxy 只接受异步 ClientBuilder，这里手动接入系统代理
    // （apply_system_proxy 内部同样只读 WinINET 注册表代理）。
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent("AnyBridge-Desktop-Client")
        .timeout(std::time::Duration::from_secs(60));
    if let Some(proxy_url) = super::windows_user_proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let ext_api = "https://open-vsx.org/api/ms-ceintl/vscode-language-pack-zh-hans";
    let val: Value = client
        .get(ext_api)
        .send()
        .map_err(|e| format!("请求 Open VSX 失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Open VSX 响应异常: {e}"))?
        .json()
        .map_err(|e| format!("解析 Open VSX 响应失败: {e}"))?;
    let all = val
        .get("allVersions")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "Open VSX 响应缺少 allVersions".to_string())?;

    // 选与 IDE 引擎 major.minor 一致的最大版本
    let mut pick: Option<(String, Vec<u32>)> = None;
    for key in all.keys() {
        let ver: Vec<u32> = key.split('.').filter_map(|p| p.parse::<u32>().ok()).collect();
        if ver.len() >= 2 && want.len() >= 2 && ver[0] == want[0] && ver[1] == want[1] {
            if pick.as_ref().map(|(_, pv)| ver > *pv).unwrap_or(true) {
                pick = Some((key.clone(), ver));
            }
        }
    }
    let Some((version, _)) = pick else {
        return Err(format!(
            "Open VSX 上没有与 IDE 引擎 {engine} 匹配的中文语言包版本，请在扩展市场手动安装"
        ));
    };

    // 拿该版本详情 → VSIX 下载地址
    let detail: Value = client
        .get(format!("{}/{}", ext_api, version))
        .send()
        .map_err(|e| format!("请求语言包详情失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("语言包详情响应异常: {e}"))?
        .json()
        .map_err(|e| format!("解析语言包详情失败: {e}"))?;
    let vsix_url = detail
        .get("files")
        .and_then(|f| f.get("download"))
        .and_then(|d| d.as_str())
        .ok_or_else(|| "Open VSX 响应缺少 VSIX 下载地址".to_string())?
        .to_string();

    let cache = cache_dir(platform);
    let vsix_path = cache.join("language-pack.vsix");
    let bytes = client
        .get(&vsix_url)
        .send()
        .map_err(|e| format!("下载语言包 VSIX 失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("语言包 VSIX 下载异常: {e}"))?
        .bytes()
        .map_err(|e| format!("读取语言包 VSIX 失败: {e}"))?;
    fs::write(&vsix_path, &bytes).map_err(|e| format!("保存 VSIX 失败: {e}"))?;

    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return Err("未找到 IDE 扩展目录，无法安装语言包".to_string());
    };
    let target = ext_dir
        .join(format!("ms-ceintl.vscode-language-pack-zh-hans-{version}"));
    let _ = fs::remove_dir_all(&target); // 旧半截安装清理
    unzip_extension(&vsix_path, &target)?;
    let _ = fs::remove_file(&vsix_path);
    // 解压成功还不够：.obsolete 里若有该 id 的废弃标记，VS Code 扫描器会跳过加载，
    // 必须清掉（卸载残留/扫描异常都可能留下标记）。
    clear_obsolete_mark(platform, LANG_PACK_EXTENSION_ID);
    // 注册到 languagepacks.json（VS Code 1.90+ 语言包解析机制）：启动时 IDE 按
    // 此文件把 locale 映射到语言包扩展，不注册 = 装了也不生效。
    register_language_pack(platform, &version);
    Ok(true)
}

/// 转成 IDE languagepacks.json 里的路径格式（小写盘符 + 反斜杠）。
fn to_ide_path(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('/', "\\");
    if s.len() > 1 && s.as_bytes()[1] == b':' {
        s = s[..1].to_lowercase() + &s[1..];
    }
    s
}

/// 在 languagepacks.json 注册语言包（user-data-dir 下）。
///
/// 必须写 IDE 自己会生成的**完整结构**（{locale: {hash, extensions, translations, label}}）：
/// NLS 在主进程最早阶段读这个文件，简化格式（{id: version}）会被 IDE 启动后
/// 重写成完整结构——但那时 UI 已用英文初始化完，于是要重启两次才见中文。
/// 提前写好完整结构，第一次启动的 NLS 就能拿到中文，一次重启生效。
fn register_language_pack(platform: &str, version: &str) {
    let Some(state) = ide_state_dir(platform) else {
        return;
    };
    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return;
    };
    let pack_dir = ext_dir.join(format!("{}-{}", LANG_PACK_DIR_PREFIX, version));
    // 语言包的 localizations 声明（languageId / label / translations 映射来源）
    let pkg: Value = fs::read_to_string(pack_dir.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let Some(loc) = pkg
        .get("contributes")
        .and_then(|c| c.get("localizations"))
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
    else {
        return;
    };
    let Some(language_id) = loc.get("languageId").and_then(|v| v.as_str()) else {
        return;
    };
    let label = loc
        .get("localizedLanguageName")
        .and_then(|v| v.as_str())
        .unwrap_or(language_id);

    // translations: {扩展id: 翻译文件绝对路径}（IDE 格式：小写盘符 + 反斜杠）
    let mut translations = serde_json::Map::new();
    if let Some(items) = loc.get("translations").and_then(|t| t.as_array()) {
        for item in items {
            let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(rel) = item.get("path").and_then(|v| v.as_str()) else {
                continue;
            };
            let abs = pack_dir.join(rel.trim_start_matches("./"));
            translations.insert(id.to_string(), json!(to_ide_path(&abs)));
        }
    }

    let path = state.join("languagepacks.json");
    // hash 算法实测复刻：IDE 用 md5(扩展id + 版本)（无分隔符直接拼接）。
    // 自己算出 IDE 认可的 hash，从零注册也能一次启动生效——
    // hash 不匹配时 IDE 会重算重写，而重写发生在 NLS 初始化之后，就要重启两次。
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(LANG_PACK_EXTENSION_ID.as_bytes());
    hasher.update(version.as_bytes());
    let hash = hex::encode(hasher.finalize());

    let mut doc: serde_json::Map<String, Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    doc.insert(
        language_id.to_string(),
        json!({
            "hash": hash,
            "extensions": [{
                "extensionIdentifier": {"id": LANG_PACK_EXTENSION_ID, "uuid": LANG_PACK_EXTENSION_ID},
                "version": version,
            }],
            "translations": Value::Object(translations),
            "label": label,
        }),
    );
    let _ = fs::write(&path, serde_json::to_string(&doc).unwrap_or_default());
}

/// 已安装（与引擎兼容）的语言包版本号，从目录名提取。
fn installed_lang_pack_version(platform: &str) -> Option<String> {
    let dir = compatible_lang_pack_dir(platform)?;
    let name = dir.file_name()?.to_string_lossy().to_string();
    let rest = name.strip_prefix(LANG_PACK_DIR_PREFIX)?;
    Some(rest.trim_start_matches('-').to_string())
}

/// `elevate`：是否允许在权限不足时弹一次性 UAC 自动授权。
/// 界面操作（命令）传 true；keeper 等后台场景传 false——失败静默跳过下周期重试。
///
/// 锁纪律：本函数是**外部入口**，负责拿 inject_lock；真正的注入逻辑在
/// `apply_inner`（**不加锁**，假定调用方已持锁）。这样 keeper 才能在持锁
/// 状态下调用注入而不触发 std::sync::Mutex 的不可重入死锁
/// （实测事故：keeper 持锁 → 调 apply → apply 再加锁 → 同线程死锁，
/// 并把用户的汉化请求一起堵死）。
fn apply(platform: &str, elevate: bool) -> Result<LocalizationOperationResult, String> {
    if platform == "claude-desktop" {
        // claude 没有语言包网络段，全程持锁：它改的是 index.html/i18n/config.json，
        // 与 keeper/BYOK 互斥（此前在锁外裸奔，审计发现）。
        let _guard = super::inject_lock();
        return apply_claude(elevate);
    }
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;

    // 语言包策略：已装 → 直接切显示语言；未装 → 默认自动从 Open VSX 安装与
    // IDE 引擎匹配的版本（用户要求默认设置好，不让用户手动去扩展市场）。
    // 安装/切换失败不阻断汉化本体，但必须如实写进消息，绝不静默吞掉。
    // 语言包安装走网络（Open VSX + VSIX 下载），绝不在注入锁内做——
    // 否则 keeper 会被几分钟的网络超时挡住。语言包操作与 html 注入互不相干。
    let mut lang_note: Option<String> = None;
    // 无论已装还是本次安装，都清一次 obsolete 标记（目录合法但被标记 =
    // VS Code 扫描器跳过，实测踩中）。
    clear_obsolete_mark(platform, LANG_PACK_EXTENSION_ID);
    // 只在「当前还没有生效中的中文包」时才注册官方包：
    // 用户已装并生效了第三方中文包（如 openubmc）时不抢注册，避免覆盖用户选择
    if !lang_pack_installed(platform) {
        if let Some(ver) = installed_lang_pack_version(platform) {
            register_language_pack(platform, &ver);
        }
    }
    if !lang_pack_installed(platform) {
        lang_note = match install_language_pack(platform) {
            Ok(true) => Some("；已自动安装官方简体中文语言包".to_string()),
            Ok(false) => None,
            Err(e) => Some(format!("；语言包自动安装失败：{e}")),
        };
    }

    // 注入段持全局锁：与 BYOK 接入/还原、保活 keeper 互斥，
    // 防并发读-改-写互相覆盖（详见 commands::inject_lock 注释）。
    let _guard = super::inject_lock();
    apply_inner(platform, &display, &lang_note)
}

/// 注入段实现（**调用方必须已持有 inject_lock**，见 apply 的锁纪律说明）。
fn apply_inner(
    platform: &str,
    display: &str,
    lang_note: &Option<String>,
) -> Result<LocalizationOperationResult, String> {
    // 入口可能不止一个：Antigravity IDE 的设置页/Agent 面板由独立引导窗口
    // （workbench-jetski-agent.html）渲染，只注入 workbench.html 时它仍全英文。
    // 必须全部注入；任何一个失败都如实报错，绝不谎报"已汉化"。
    let targets = localization_target_htmls(platform);
    if targets.is_empty() {
        return Err(format!(
            "未定位到 {} 的 workbench.html（请先安装并运行一次 {} 后重试）",
            display, display
        ));
    }

    let mut entries = 0usize;
    let mut injected: Vec<String> = Vec::new();
    for html_path in &targets {
        match inject_hans_into(platform, display, html_path) {
            Ok(n) => {
                entries = entries.max(n);
                injected.push(
                    html_path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or("workbench.html")
                        .to_string(),
                );
            }
            Err(e) => {
                let done = if injected.is_empty() {
                    "无".to_string()
                } else {
                    injected.join("、")
                };
                return Err(format!("{e}（本次已注入：{done}，其余入口请重试）"));
            }
        }
    }
    set_enabled(platform);
    invalidate_status_cache();

    // 改写 html 后必须清空完整性校验清单，否则 IDE 每次启动弹"安装已损坏"。
    clear_product_checksums(platform)?;
    // 第三方中文语言包缺词条时 NLS 取词函数会 throw 导致白屏，必须加固。
    patch_nls_tolerant(platform)?;
    // （语言包的清理/安装/注册已在锁外完成，见函数开头；lang_note 已带结果）
    let locale_note = match ensure_locale_zh_cn(platform) {
        Ok(true) => Some("；显示语言已切换为简体中文".to_string()),
        Ok(false) => None,
        Err(e) => Some(format!("；显示语言切换失败：{}", e)),
    };

    let mut message = format!(
        "{} 汉化已应用成功（{} 条词条），重启客户端后生效",
        display, entries
    );
    if let Some(note) = locale_note.or(lang_note.clone()) {
        message.push_str(&note);
    } else if !lang_pack_installed(platform) {
        message.push_str(
            "；未检测到官方中文语言包，标准菜单暂为英文，可在扩展市场搜索 Chinese (Simplified) 安装",
        );
    }

    Ok(LocalizationOperationResult {
        ok: true,
        message,
        localized: true,
    })
}

/// 单个界面入口 HTML 的汉化注入（幂等），返回注入的词条数。
///
/// 抽成独立函数的原因：主 workbench.html 与设置页的引导窗口 HTML 必须走
/// **完全相同**的一套纪律（快照自愈、原厂备份、CSP 补 'unsafe-inline'、
/// nonce 继承、写后校验、失败回滚）。各写一份必然漏改其中一处。
fn inject_hans_into(
    platform: &str,
    display: &str,
    html_path: &Path,
) -> Result<usize, String> {
    inject_hans_into_with_cache(&cache_dir(platform), platform, display, html_path)
}

/// 注入实现。`cache` 由调用方传入：生产用 cache_dir，测试用临时目录，
/// 避免单测把快照写进真实用户缓存（否则损坏自愈会拿测试夹具覆盖真文件）。
fn inject_hans_into_with_cache(
    cache: &Path,
    platform: &str,
    display: &str,
    html_path: &Path,
) -> Result<usize, String> {
    let file_name = html_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("workbench.html");
    let html = fs::read_to_string(html_path)
        .map_err(|e| format!("读取 {file_name} 失败: {e}"))?;

    // 防御零：读到疑似损坏（缺 </body>）→ 用快照自愈。
    // 事故背景：apply 写入过程中用户强杀 AnyBridge，文件系统留下截断的
    // workbench.html（实测 307KB 被截成 1.7KB），IDE 直接起不来，
    // 而同目录备份已被上次还原删除 —— 无快照就彻底救不回来。
    let snapshot = html_snapshot_path(cache, html_path);
    if !is_valid_workbench(&html) {
        if let Ok(s) = fs::read_to_string(&snapshot) {
            if s.len() > html.len() && s.contains("</body>") {
                // 自愈不能把 BYOK 注入块一起冲掉（快照可能生成于 BYOK 注入之前）
                let restored = snapshot_with_byok_preserved(&html, &s);
                let _ = write_atomic(html_path, &restored);
                return Err(format!(
                    "检测到 {} 的 {file_name} 异常（可能被中断的写入截断），已从快照自动恢复，请重新点击汉化",
                    display
                ));
            }
        }
        return Err(format!(
            "{} 的 {file_name} 内容异常（{} 字节），已中止以避免进一步损坏。请重装 {} 后重试",
            display,
            html.len(),
            display
        ));
    }
    // 快照：无论当前是否原厂态都保存"上一次可用状态"，供中断后自愈。
    let _ = fs::write(&snapshot, html.as_bytes());

    // 备份：当前 html 无汉化标记 = 原厂态（首次注入，或 IDE 升级覆盖后的新版原厂），
    // 一律刷新备份以严格对齐当前安装版本。
    // 若只在"备份不存在"时才写，keeper 在升级后重注入时备份仍是旧版本 html，
    // 用户后续点还原会把旧版本覆盖回新版安装，造成 workbench 版本错配。
    // （还原成功后备份会被删除，因此这里不会误刷新。）
    let backup = PathBuf::from(format!("{}{}", html_path.to_string_lossy(), HANS_BACKUP_SUFFIX));
    if !html.contains(HANS_BLOCK_START) {
        fs::write(&backup, &html).map_err(|e| format!("备份 {file_name} 失败: {e}"))?;
    }

    let stripped = strip_hans_block(&html);
    let (with_csp, csp_inserted) = ensure_csp_unsafe_inline(&stripped);
    if csp_inserted {
        // 记账：还原时据此精确移除这行 CSP 放行（原厂自带的不能误删）
        record_csp_inserted(platform, file_name)?;
    }
    // 非主入口 = 辅助窗口（Antigravity IDE 的设置页/Agent 面板）：脚本首行置标记，
    // 引擎据此跳过"等 workbench 根节点 + 隐藏首屏"，否则会白屏等到 6 秒超时。
    let script = hans_script_for_window(platform, file_name != "workbench.html");
    let entries = count_entries(&script);
    // CSP 有 nonce 时内联脚本必须带同名 nonce 才能执行（详见 extract_csp_nonce 注释）
    let open_tag = match extract_csp_nonce(&html) {
        Some(n) => format!("<script nonce=\"{}\">", n),
        None => "<script>".to_string(),
    };
    let block = format!(
        "\n{start}\n{ver}\n{open}\n{script}\n</script>\n{end}\n",
        start = HANS_BLOCK_START,
        ver = HANS_VERSION_MARKER,
        open = open_tag,
        script = script,
        end = HANS_BLOCK_END,
    );

    let Some(body_idx) = with_csp.rfind("</body>") else {
        return Err(format!("{file_name} 缺少 </body>，无法注入"));
    };
    let mut new_html = String::with_capacity(with_csp.len() + block.len());
    new_html.push_str(&with_csp[..body_idx]);
    new_html.push_str(&block);
    new_html.push_str(&with_csp[body_idx..]);
    write_atomic(html_path, &new_html).map_err(|e| format!("写入 {file_name} 失败: {e}"))?;

    // 写后校验：确认真的写进去了且结构完整。写入被中断（强杀/磁盘满）时
    // 文件可能只有一部分，不校验就当成功会给用户留一个起不来的 IDE。
    let written_ok = fs::read_to_string(html_path)
        .ok()
        .map(|v| v.contains(HANS_BLOCK_START) && v.contains("</body>") && v.len() >= html.len())
        .unwrap_or(false);
    if !written_ok {
        // 回滚到快照（上次可用状态），宁可回到英文界面也不能白屏。
        // 同样要保住 BYOK 块：回滚是异常路径，不能顺手把另一条链的注入也抹掉
        if let Ok(s) = fs::read_to_string(&snapshot) {
            let current = fs::read_to_string(html_path).unwrap_or_default();
            let restored = snapshot_with_byok_preserved(&current, &s);
            let _ = write_atomic(html_path, &restored);
        }
        return Err(format!(
            "汉化写入后校验失败（{} 的 {file_name} 异常），已从快照恢复，请重启客户端后重试",
            display
        ));
    }
    Ok(entries)
}

fn restore(platform: &str, elevate: bool) -> Result<LocalizationOperationResult, String> {
    if platform == "claude-desktop" {
        // 与 apply 对称：claude 还原也全程持锁（此前在锁外裸奔，审计发现）
        let _guard = super::inject_lock();
        return restore_claude(elevate);
    }
    // 持全局注入锁：与 BYOK 接入/还原、保活 keeper 互斥，
    // 防并发读-改-写互相覆盖（详见 commands::inject_lock 注释）。
    let _guard = super::inject_lock();
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;

    // 与 apply 完全对称：每个被注入过的入口 HTML 都要剥离汉化块。
    // 只还原主 workbench.html 会把设置页入口留在汉化态，形成半还原的脏状态。
    let targets = localization_target_htmls(platform);
    if targets.is_empty() {
        return Err(format!("未定位到 {} 的 workbench.html", display));
    }

    // 还原一律走「剥离自己的汉化块」，绝不用备份整体覆盖：
    // 备份是"打汉化前"的快照，若用户是先汉化、后一键接入，备份里没有 BYOK 注入块，
    // 整体覆盖会把 BYOK 的 byok-cards 块一并抹掉，导致接入静默失效
    // （antigravity_localization.rs 里同一个坑早有记载：绝不回退到接入前的纯净版）。
    let mut changed = false;
    for html_path in &targets {
        let file_name = html_path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("workbench.html");
        let backup = PathBuf::from(format!("{}{}", html_path.to_string_lossy(), HANS_BACKUP_SUFFIX));
        let html = fs::read_to_string(html_path).map_err(|e| e.to_string())?;

        if html.contains(HANS_BLOCK_START) {
            if !html.contains(HANS_BLOCK_END) {
                // 块标记不完整（写入被中断或遭外部改写）：如实报错，不做危险的整体覆盖，
                // 备份保留供用户手动还原。
                return Err(format!(
                    "{} 的 {file_name} 汉化块标记不完整，无法安全还原。请重装客户端，或用备份 {} 手动覆盖",
                    display,
                    backup.display()
                ));
            }
            let mut cleaned = strip_hans_block(&html);
            // 副作用回滚①：CSP 的 'unsafe-inline'。仅当记账确认是我们插的、
            // 且该文件已无 BYOK 块（BYOK 的 inline script 还需要它执行）才移除。
            if !cleaned.contains(BYOK_BLOCK_START)
                && take_csp_record(platform, file_name).unwrap_or(false)
            {
                cleaned = revert_csp_unsafe_inline(&cleaned);
            }
            write_atomic(html_path, &cleaned)
                .map_err(|e| format!("还原 {file_name} 失败: {e}"))?;
            changed = true;
            invalidate_status_cache();
        }
        // 备份的存在价值只到还原为止；剥离成功后即清理，避免下次 apply 误用旧版本。
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
    }

    // product.json 校验清单：仅当 byok 注入块也不在时才会去还原
    // （byok 还在用则必须保留清空状态，否则它那边弹"安装已损坏"）。
    let mut warning = String::new();
    let byok_present = targets.iter().any(|p| {
        fs::read_to_string(p)
            .map(|h| h.contains(BYOK_BLOCK_START))
            .unwrap_or(false)
    });
    if !byok_present {
        if let Err(e) = restore_product_json(platform) {
            warning = format!("；完整性校验清单还原失败：{e}（重装 IDE 可恢复）");
        }
        // 副作用回滚②：NLS 取词加固。BYOK 同样依赖它，仅在无 byok 块时还原；
        // restore_nls 自带版本防护（IDE 升级后旧备份不会覆盖新版文件）。
        match super::workbench_inject::restore_nls(platform) {
            Ok(true) => changed = true,
            Ok(false) => {}
            Err(e) => {
                let nls_warning = format!("；NLS 原厂文件还原失败：{e}");
                warning.push_str(&nls_warning);
            }
        }
        // 副作用回滚④：原厂对齐自愈——校验和已回填，按原厂哈希收敛历史泄漏的换行
        // （strip 修好前的每一轮注入/剥离都漏 2 个换行，累积在存量安装上）
        for html_path in &targets {
            let content = match fs::read_to_string(html_path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.contains(HANS_BLOCK_START) || content.contains(BYOK_BLOCK_START) {
                continue;
            }
            match super::workbench_inject::align_workbench_with_checksum(platform, html_path, &content)
            {
                Ok(Some(aligned)) => {
                    write_atomic(html_path, &aligned)
                        .map_err(|e| format!("原厂对齐失败: {e}"))?;
                    changed = true;
                }
                Ok(None) => {}
                Err(e) => warning.push_str(&format!("；{e}")),
            }
        }
    }

    // 副作用回滚③：显示语言。仅当当前仍是我们写的 zh-cn 才回滚——
    // 用户中途手动改过 locale 的（值 != zh-cn）保留用户选择，绝不覆盖。
    let locale_note = match take_locale_record(platform) {
        Ok(Some(record)) => {
            let reverted = ide_state_dir(platform).and_then(|state| {
                let argv_path = state.join("argv.json");
                let raw = fs::read_to_string(&argv_path).ok()?;
                let current_is_ours = parse_jsonc(&raw)
                    .and_then(|d| d.get("locale").and_then(|v| v.as_str()).map(String::from))
                    .as_deref()
                    == Some("zh-cn");
                if !current_is_ours {
                    return None;
                }
                let new_text = revert_locale_in_argv(&raw, &record)?;
                write_atomic(&argv_path, &new_text).ok()?;
                Some(true)
            });
            match reverted {
                Some(true) => Some("；显示语言已还原为改前设置".to_string()),
                _ => None,
            }
        }
        Ok(None) => None,
        Err(e) => Some(format!("；显示语言回滚失败：{e}")),
    };
    if let Some(note) = locale_note {
        changed = true;
        warning.push_str(&note);
    }

    // 还原成功（或本就未汉化）才清除启用标记，避免异常路径丢掉保活
    clear_enabled(platform);

    Ok(LocalizationOperationResult {
        ok: true,
        message: if changed || !warning.is_empty() {
            format!("{} 已还原为官方英文原版，重启客户端后生效{}", display, warning)
        } else {
            format!("{} 当前未应用汉化，无需还原", display)
        },
        localized: false,
    })
}

/// Claude Desktop 汉化（i18n 目录注入方案，实测可行）：
/// 1. 定位 ion-dist（Claude 升级会换新目录，每次重新定位）
/// 2. 授权目录与 index.html（MSIX 受保护目录需要 takeown + icacls）
/// 3. 写 /i18n/zh-Hans.json + /i18n/dynamic/zh-Hans.json（词典来自热更新缓存）
/// 4. 扫描语言 store 模块与导出别名（版本相关，绝不硬编码）
/// 5. 注入 index.html：声明 zh-Hans 目录（meta 两段 hash）+ setLocaleOverride
/// 6. config.json locale=zh-Hans
///
/// 注意：改 en-US.json 是无效路线——react-intl 的默认语言直接用组件内联的
/// defaultMessage，根本不读 en-US.json；且前端只认 meta 里声明过的 locale。
fn apply_claude(elevate: bool) -> Result<LocalizationOperationResult, String> {
    let _ = elevate; // 授权走 grant_acl（静默，必要时由系统弹 UAC）
    let dist = claude_ion_dist_dir().ok_or_else(|| {
        "未定位到 Claude Desktop 的界面资源（ion-dist）。请先安装并运行一次 Claude Desktop"
            .to_string()
    })?;

    // 1. 授权：ion-dist 与其 i18n 目录（新装/升级后的目录没有写权限）
    grant_acl(&dist, true)?;
    grant_acl(&dist.join("i18n"), true)?;
    // 授权后仍不可写 = 非管理员运行且 ACL 未授权，给出可操作的指引而不是裸错误
    if fs::OpenOptions::new()
        .write(true)
        .open(dist.join("index.html"))
        .is_err()
    {
        return Err(
            "无权限写入 Claude 安装目录（微软商店版位于受保护目录）。请以管理员身份运行 AnyBridge 后重试，或改用官网安装版"
                .to_string(),
        );
    }

    // 2. 写词典
    let entries = claude_write_zh_dicts(&dist)?;

    // 3. 扫描 store 模块（版本变化时文件名/导出别名都会变）
    let (store_rel, store_export) = detect_claude_store(&dist).ok_or_else(|| {
        "未能定位 Claude 的语言运行时模块（版本可能已变更）。已保留词典，请反馈该问题".to_string()
    })?;

    // 4. 注入 index.html
    let snippet = claude_inject_snippet(&store_rel, &store_export);
    claude_inject_index(&dist, &snippet)?;

    // 5. 切语言（config.json）
    let locale_changed = claude_set_locale(CLAUDE_ZH_LOCALE, false)?;

    // 6. 校验：index.html 必须真的带上了标记
    let html = fs::read_to_string(dist.join("index.html"))
        .map_err(|e| format!("写入后读取 index.html 失败: {e}"))?;
    if !html.contains(CLAUDE_ZH_MARKER) {
        return Err("注入校验失败：index.html 未包含汉化标记".to_string());
    }

    set_enabled("claude-desktop");
    invalidate_status_cache();

    let mut message = format!("Claude Desktop 汉化已应用成功（{} 条词条）", entries);
    if locale_changed {
        message.push_str("，显示语言已切换为简体中文");
    }
    message.push_str("，重启客户端后生效");
    Ok(LocalizationOperationResult {
        ok: true,
        message,
        localized: true,
    })
}

/// Claude Desktop 还原：剥离 index.html 注入、删除 zh-Hans 词典、locale 恢复 en-US。
fn restore_claude(elevate: bool) -> Result<LocalizationOperationResult, String> {
    let _ = elevate;
    let dist = claude_ion_dist_dir()
        .ok_or_else(|| "未定位到 Claude Desktop 的界面资源".to_string())?;

    let idx = dist.join("index.html");
    let mut changed = false;
    if let Ok(html) = fs::read_to_string(&idx) {
        let stripped = claude_strip_inject(&html);
        if stripped != html {
            grant_acl(&idx, false)?;
            fs::write(&idx, stripped.as_bytes())
                .map_err(|e| format!("还原 index.html 失败: {e}"))?;
            changed = true;
        }
    }
    // 删掉我们放的词典（Claude 自己的语言文件不碰）
    for p in [
        dist.join("i18n").join(format!("{CLAUDE_ZH_LOCALE}.json")),
        dist.join("i18n").join("dynamic").join(format!("{CLAUDE_ZH_LOCALE}.json")),
    ] {
        if p.exists() {
            grant_acl(&p, false)?;
            if fs::remove_file(&p).is_ok() {
                changed = true;
            }
        }
    }
    if claude_set_locale("en-US", true)? {
        changed = true;
    }
    clear_enabled("claude-desktop");
    invalidate_status_cache();

    Ok(LocalizationOperationResult {
        ok: true,
        message: if changed {
            "Claude Desktop 已还原为官方英文原版，重启客户端后生效".to_string()
        } else {
            "Claude Desktop 当前未应用汉化，无需还原".to_string()
        },
        localized: false,
    })
}

// ---------------------------------------------------------------------------
// 保活 keeper（对齐 Kite 扩展的 ensureEnhancement 效果，但不装扩展）
//
// Windsurf/Devin 升级会用原厂 html 覆盖我们的注入（汉化标记消失）。
// AnyBridge 运行时每 10 分钟轻量检测一次：用户开启过汉化（enabled 标记在）、
// 当前 html 却无汉化标记 → 自动重注入。IDE 运行中文件被锁时本次跳过，
// 下个周期重试，不影响用户正常使用。
// ---------------------------------------------------------------------------

const KEEPER_FIRST_DELAY: Duration = Duration::from_secs(60);
const KEEPER_INTERVAL: Duration = Duration::from_secs(600);
const KEEPER_PLATFORMS: [&str; 5] = [
    "windsurf",
    "devin",
    "cursor",
    "claude-desktop",
    "antigravity-ide",
];

pub fn spawn_localization_keeper(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(KEEPER_FIRST_DELAY);
        loop {
            for platform in KEEPER_PLATFORMS {
                keeper_tick(&app, platform);
            }
            std::thread::sleep(KEEPER_INTERVAL);
        }
    });
}

/// keeper 单平台判定：是否需要自动重注入。
/// `enabled` 由调用方从启用标记读取后传入（纯函数，便于单测，也避免
/// 并行测试之间通过共享标记文件互相干扰）。
fn keeper_should_reinject(platform: &str, enabled: bool) -> bool {
    // 不支持的平台一律不管（未知 target 会落到 find_ide_exe 的默认分支，必须拦掉）
    if platform_meta(platform).is_none() {
        return false;
    }
    // 未开启过汉化 → 不管
    if !enabled {
        return false;
    }
    // 汉化标记还在 → 活着
    if is_localized(platform) {
        return false;
    }
    // 客户端未安装 → 无可注入（Claude 走语言文件判定，不能只看 workbench.html）
    is_installed(platform)
}

fn keeper_tick(app: &tauri::AppHandle, platform: &str) {
    // 判定 + 重注入全程持锁：若判定在锁外，用户可能在判定后、注入前点了还原，
    // 而 keeper 手里是旧的"需重注入"结论 → 块被写回"复活"。
    // 注意：持锁后只能调 apply_inner（apply 会再次加锁 → 不可重入死锁，实测事故）。
    let _guard = super::inject_lock();
    if !keeper_should_reinject(platform, is_enabled(platform)) {
        return;
    }
    // 被 IDE 升级覆盖 → 重注入（apply 幂等；IDE 运行中文件被锁则 Err，下周期重试）。
    // elevate=false：keeper 是后台线程，权限不足时绝不去弹 UAC，静默等下周期。
    let display = platform_meta(platform).map(|m| m.0).unwrap_or(platform);
    // claude 走 i18n 目录注入链：apply_inner 是 workbench 注入，对 claude 必然
    // 报"未定位到 workbench.html"（此前每 10 分钟一条错误日志，keeper 名存实亡）。
    // 两者都是无锁版，本函数已持锁。
    let result = if platform == "claude-desktop" {
        apply_claude(false)
    } else {
        apply_inner(platform, &display, &None)
    };
    match result {
        Ok(_) => {
            eprintln!("[loc-keeper] {} 汉化被客户端升级覆盖，已自动重注入", display);
            let _ = app.emit(
                "proxy-log",
                super::proxy::LogLine {
                    level: "ok".into(),
                    msg: format!(
                        "{} 汉化被客户端升级覆盖，已自动重注入，重启客户端后生效",
                        display
                    ),
                },
            );
        }
        Err(e) => {
            // 多为 IDE 运行中文件被锁，静默跳过等下个周期，不打扰用户
            eprintln!("[loc-keeper] {} 自动重注入跳过: {}", display, e);
        }
    }
}

fn build_status(platform: &str) -> Result<AppLocalizationStatus, String> {
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;
    let installed = is_installed(platform);
    // vscode 系：中文语言包是否已装；claude：词典是否已在本地缓存（首次需联网下载）
    let lang_pack = if platform == "claude-desktop" {
        cache_dir(platform).join(script_cache_name(platform)).exists()
    } else {
        lang_pack_installed(platform)
    };
    Ok(AppLocalizationStatus {
        platform: platform.to_string(),
        installed,
        localized: is_localized(platform),
        current_version: read_cached_version(platform),
        latest_version: None,
        has_update: false,
        lang_pack_installed: lang_pack,
        message: Some(display.to_string()),
    })
}

/// 内容哈希（版本标识）：同一内容哈希必然相同，与上游 commit sha 解耦。
fn content_sha256(content: &str) -> String {
    super::content_sha256(content)
}

/// 拉取上游词库原文：raw 直下（CDN，无 API 限流）+ 镜像兜底，
/// 具体实现见 commands::fetch_github_content。
async fn fetch_upstream_content(platform: &str) -> Result<String, String> {
    let raw_url = upstream_raw_url(platform)
        .ok_or_else(|| format!("不支持的平台: {}", platform))?;
    super::fetch_github_content(raw_url, 30).await
}

/// 状态缓存：界面在页面加载、打开面板、apply/restore 后会反复查询，
/// 每次都读 workbench.html（数 MB）+ IDE 路径探测链，3 秒 TTL 覆盖连续查询，
/// apply/restore 主动失效。
static STATUS_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<(std::time::Instant, AppLocalizationStatus)>>,
> = std::sync::OnceLock::new();
const STATUS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3);

fn invalidate_status_cache() {
    if let Some(m) = STATUS_CACHE.get() {
        if let Ok(mut slot) = m.lock() {
            *slot = None;
        }
    }
}

#[tauri::command]
pub async fn get_app_localization_status(
    platform: String,
) -> Result<AppLocalizationStatus, String> {
    // 异步 + spawn_blocking：读 workbench.html 与 IDE 探测链绝不占 Tauri 主线程
    // （同步命令在主线程执行，点按钮会观感卡顿）
    tauri::async_runtime::spawn_blocking(move || {
        let cache = STATUS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
        {
            let slot = cache.lock().unwrap();
            if let Some((ts, st)) = slot.as_ref() {
                if ts.elapsed() < STATUS_CACHE_TTL && st.platform == platform {
                    return Ok(st.clone());
                }
            }
        }
        let st = build_status(&platform)?;
        if let Ok(mut slot) = cache.lock() {
            *slot = Some((std::time::Instant::now(), st.clone()));
        }
        Ok(st)
    })
    .await
    .map_err(|e| format!("状态查询任务失败: {}", e))?
}

/// 必须是 async + spawn_blocking：同步 command 在 Tauri 主线程执行，
/// apply 里的语言包网络请求（60s 超时）/文件 IO 会把整个 UI 冻住
/// （实测事故：点汉化后界面卡死，鼠标转圈）。
#[tauri::command]
pub async fn apply_app_localization(
    platform: String,
) -> Result<LocalizationOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply(&platform, true))
        .await
        .map_err(|e| format!("汉化任务失败: {}", e))?
}

#[tauri::command]
pub async fn restore_app_localization(
    platform: String,
) -> Result<LocalizationOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore(&platform, true))
        .await
        .map_err(|e| format!("还原任务失败: {}", e))?
}

#[tauri::command]
pub async fn check_app_localization_update(
    platform: String,
) -> Result<AppLocalizationStatus, String> {
    platform_meta(&platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;
    let mut status = build_status(&platform)?;

    // Windsurf/Devin 用内嵌的完整汉化模块（820 条人工词典，持续随版本发布更新），
    // 上游词库已停更且不含专有 UI 词条——检查只会拿到更差的词典，直接告知已最新。
    if platform == "windsurf" || platform == "devin" {
        status.latest_version = Some("builtin".to_string());
        status.has_update = false;
        return Ok(status);
    }

    let content = fetch_upstream_content(&platform).await?;
    let remote_sha = content_sha256(&content);
    let local_sha = read_cached_sha(&platform);
    status.latest_version = Some(remote_sha[..8.min(remote_sha.len())].to_string());
    // 本地无缓存记录（内置基线或旧版 metadata）→ 视为有更新；有记录按内容哈希比对
    status.has_update = local_sha.is_empty() || local_sha != remote_sha;
    Ok(status)
}

#[tauri::command]
pub async fn download_app_localization_update(
    platform: String,
) -> Result<LocalizationOperationResult, String> {
    platform_meta(&platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;
    // 同 check：这两个平台用内置完整模块，不下载上游（下载了也不会被注入使用）
    if platform == "windsurf" || platform == "devin" {
        return Ok(LocalizationOperationResult {
            ok: true,
            message: format!(
                "{} 使用内置完整词典（800+ 条，覆盖专有界面），已是最新，无需下载",
                platform_meta(&platform).map(|m| m.0).unwrap_or(&platform)
            ),
            localized: is_localized(&platform),
        });
    }
    let content = fetch_upstream_content(&platform).await?;
    let remote_sha = content_sha256(&content);

    // 分平台校验与缓存内容：全部归一化为「词典 JSON」缓存，注入时与内置引擎组装。
    // windsurf/devin = 从上游完整脚本抽 TRANSLATIONS；cursor = 词典直存；
    // ag-ide = 从 localize.js 抽 dictionary；claude = 翻译文件 JSON。
    let (cache_content, entries) = if platform == "cursor" {
        match build_script_from_dictionary(&content) {
            Some(script) => (content.clone(), count_entries(&script)),
            None => {
                return Err(
                    "上游词典结构变化（未能解析出词条），已保留内置离线词库不受影响".to_string(),
                )
            }
        }
    } else if platform == "windsurf" || platform == "devin" {
        if !content.contains("const TRANSLATIONS = new Map([") {
            return Err(
                "上游脚本结构变化（未找到 TRANSLATIONS 词典），已保留内置离线词库不受影响"
                    .to_string(),
            );
        }
        match extract_dictionary_from_windsurf_script(&content) {
            Some(dict) => {
                let n = dict
                    .get("sections")
                    .and_then(|s| s.as_array())
                    .and_then(|a| a.first())
                    .and_then(|s| s.get("entries"))
                    .and_then(|e| e.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                if n == 0 {
                    return Err(
                        "上游脚本未解析出词条，已保留内置离线词库不受影响".to_string(),
                    );
                }
                (serde_json::to_string(&dict).unwrap_or_default(), n)
            }
            None => {
                return Err(
                    "上游脚本词典抽取失败，已保留内置离线词库不受影响".to_string(),
                )
            }
        }
    } else if platform == "antigravity-ide" {
        if !content.contains("const dictionary = {") {
            return Err(
                "上游脚本结构变化（未找到 dictionary 词典），已保留内置离线词库不受影响"
                    .to_string(),
            );
        }
        match extract_dictionary_from_localize(&content) {
            Some(dict) => {
                let n = dict
                    .get("sections")
                    .and_then(|s| s.as_array())
                    .and_then(|a| a.first())
                    .and_then(|s| s.get("entries"))
                    .and_then(|e| e.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                if n == 0 {
                    return Err(
                        "上游脚本未解析出词条，已保留内置离线词库不受影响".to_string(),
                    );
                }
                (serde_json::to_string(&dict).unwrap_or_default(), n)
            }
            None => {
                return Err(
                    "上游脚本词典抽取失败，已保留内置离线词库不受影响".to_string(),
                )
            }
        }
    } else if platform == "claude-desktop" {
        match serde_json::from_str::<Value>(&content) {
            Ok(val) => match val.as_object() {
                Some(map) if map.len() > 10_000 => (content.clone(), map.len()),
                _ => {
                    return Err(
                        "上游词典结构变化（词条量不足），已保留本地缓存不受影响".to_string(),
                    )
                }
            },
            Err(_) => {
                return Err("上游词典不是合法 JSON，已保留本地缓存不受影响".to_string())
            }
        }
    } else {
        return Err(format!("不支持的平台: {}", platform));
    };
    if entries == 0 {
        return Err("上游内容未解析出词条，已保留内置离线词库不受影响".to_string());
    }

    fs::write(
        cache_dir(&platform).join(script_cache_name(&platform)),
        cache_content.as_bytes(),
    )
    .map_err(|e| format!("写入热更新词库缓存失败: {e}"))?;
    let meta = json!({
        "version": remote_sha[..8.min(remote_sha.len())],
        "sha": remote_sha,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "entries": entries
    });
    fs::write(
        cache_dir(&platform).join("metadata.json"),
        meta.to_string().as_bytes(),
    )
    .map_err(|e| format!("写入词库版本记录失败: {e}"))?;

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!(
            "已同步上游最新汉化词库（{} 条词条），请重新应用汉化生效",
            entries
        ),
        localized: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let candidates = super::super::extensions::mirror_candidates(original);
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
            to_ide_path(Path::new("C:/Users/admin/.windsurf/extensions/p/translations/main.i18n.json")),
            "c:\\Users\\admin\\.windsurf\\extensions\\p\\translations\\main.i18n.json"
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
}
