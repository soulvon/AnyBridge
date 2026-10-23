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
    restore_product_json, workbench_html_path,
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
const BYOK_BLOCK_START: &str = "<!-- byok-cards-start -->";

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
/// - windsurf-localization-baseline.js：通用引擎（DOM 观察 + 增量翻译，已去除
///   上游自带的悬浮开关按钮与 800ms 启动延迟）
/// - 各平台词典 JSON：windsurf/cursor/antigravity-ide 均为「内置引擎 + 平台词典」组装
const BASELINE_SCRIPT: &str = include_str!("windsurf-localization-baseline.js");
const WINDSURF_BASELINE_DICT: &str = include_str!("windsurf-dictionary-baseline.json");
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

/// 平台基线词典（windsurf/devin/cursor/antigravity-ide 共用同一引擎模板组装）。
fn baseline_dict(platform: &str) -> Option<&'static str> {
    match platform {
        "windsurf" | "devin" => Some(WINDSURF_BASELINE_DICT),
        "cursor" => Some(CURSOR_BASELINE_DICT),
        "antigravity-ide" => Some(AG_IDE_BASELINE_DICT),
        _ => None,
    }
}

/// 汉化脚本内容：热更新缓存的词典 JSON 与内置引擎模板组装；无缓存用内置基线词典。
/// 统一组装路径的好处：引擎始终是内置的可控版本（无上游悬浮按钮/启动延迟），
/// 词典跟着上游热更新走。
fn hans_script(platform: &str) -> String {
    let Some(baseline) = baseline_dict(platform) else {
        return BASELINE_SCRIPT.to_string();
    };
    let cached = cache_dir(platform).join(script_cache_name(platform));
    let dict = fs::read_to_string(&cached)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| baseline.to_string());
    build_script_from_dictionary(&dict)
        .unwrap_or_else(|| build_script_from_dictionary(baseline).unwrap_or_default())
}

fn read_cached_version(platform: &str) -> String {
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

/// 汉化启用标记（保活依据）：apply 成功时写入，restore 成功时删除。
/// IDE 升级会把 html 覆盖回原厂（汉化标记消失），仅靠 html 判断会误判为
/// "用户主动还原"，所以必须有独立的持久化开启标记。
fn enabled_marker_path(platform: &str) -> PathBuf {
    cache_dir(platform).join("enabled.json")
}

fn is_enabled(platform: &str) -> bool {
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

/// 语言包相关（extensions/ 目录所在）统一走 ide_extensions_dir；
/// locale 开关（argv.json）与语言包注册（languagepacks.json）走 ide_state_dir。
fn user_data_dir(platform: &str) -> Option<PathBuf> {
    ide_extensions_dir(platform)
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
    let ud = user_data_dir(platform)?;
    let entries = fs::read_dir(ud.join("extensions")).ok()?;
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

/// 是否已安装与当前引擎兼容的 VS Code 官方简体中文语言包。
fn lang_pack_installed(platform: &str) -> bool {
    compatible_lang_pack_dir(platform).is_some()
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
fn strip_hans_block(html: &str) -> String {
    let (Some(s), Some(e)) = (html.find(HANS_BLOCK_START), html.find(HANS_BLOCK_END)) else {
        return html.to_string();
    };
    let end = e + HANS_BLOCK_END.len();
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..s]);
    out.push_str(&html[end..]);
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

/// 在 Claude 安装根目录（AnthropicClaude）下挑语言文件：
/// 只认 `<版本目录>/resources/app/resources/ion-dist/i18n/en-US.json` 结构，
/// 并取**版本号最大**的那个。
///
/// 必须挑最新版本：Claude 升级后旧版本目录会残留，若打到旧目录等于没汉化，
/// 且现象是"点了汉化但界面没变"，极难排查。
fn pick_claude_i18n(root: &Path) -> Option<PathBuf> {
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
            .join("ion-dist")
            .join("i18n")
            .join("en-US.json");
        if !candidate.exists() {
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

/// Claude Desktop 的 en-US.json 路径。
/// 优先官网安装版（%LOCALAPPDATA%\AnthropicClaude 下最新版本目录），
/// 结构不匹配时退化为限深递归；商店版（MSIX/WindowsApps）通过 Appx 清单定位。
#[cfg(target_os = "windows")]
fn claude_i18n_path() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // 1. 官网安装版：按版本目录精准定位
    if let Some(local) = dirs::data_local_dir() {
        let root = local.join("AnthropicClaude");
        if root.is_dir() {
            if let Some(found) = pick_claude_i18n(&root) {
                return Some(found);
            }
            // 结构不符合预期（版本布局变更）时兜底递归，限深避免全盘扫描
            if let Some(found) = find_file_recursive(&root, "en-US.json", 6) {
                return Some(found);
            }
        }
    }
    // 2. 商店版：Appx InstallLocation/app/resources/ion-dist/i18n/en-US.json
    // 包名用 "*Claude*" 通配符（对齐上游 Find-ClaudeI18nFile）：精确名 'Claude'
    // 在部分机器上匹配不到商店版包。
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
            .join("ion-dist")
            .join("i18n")
            .join("en-US.json");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn claude_i18n_path() -> Option<PathBuf> {
    // macOS: /Applications/Claude.app/Contents/Resources/app/resources/ion-dist/i18n/en-US.json
    let p = PathBuf::from(
        "/Applications/Claude.app/Contents/Resources/app/resources/ion-dist/i18n/en-US.json",
    );
    if p.exists() {
        return Some(p);
    }
    None
}

/// 限深递归查找文件（避免全盘扫描）。
fn find_file_recursive(root: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    fn walk(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && p.file_name().map(|n| n == name).unwrap_or(false) {
                return Some(p);
            }
            if depth > 0 && p.is_dir() {
                if let Some(found) = walk(&p, name, depth - 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(root, name, max_depth)
}

/// Claude 是否已汉化：en-US.json 里中文字符超过阈值即视为已覆盖
/// （与上游 doctor 的诊断判据一致：>500 个中文字符）。
fn is_claude_localized() -> bool {
    let Some(path) = claude_i18n_path() else {
        return false;
    };
    match fs::read_to_string(&path) {
        Ok(content) => content
            .chars()
            .filter(|c| ('\u{4e00}'..='\u{9fa5}').contains(c))
            .count()
            > 500,
        Err(_) => false,
    }
}

fn is_localized(platform: &str) -> bool {
    if platform == "claude-desktop" {
        return is_claude_localized();
    }
    if let Some(path) = workbench_html_path(platform) {
        if let Ok(html) = fs::read_to_string(&path) {
            return html.contains(HANS_BLOCK_START);
        }
    }
    false
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
        claude_i18n_path().is_some()
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
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("locale".to_string(), json!("zh-cn"));
    }
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_atomic(&argv_path, &text)?;
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
    let Some(ud) = user_data_dir(platform) else {
        return;
    };
    let path = ud.join("extensions").join("extensions.json");
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
    let Some(ud) = user_data_dir(platform) else {
        return;
    };
    let path = ud.join("extensions").join(".obsolete");
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
    if let Some(ud) = user_data_dir(platform) {
        if let Ok(entries) = fs::read_dir(ud.join("extensions")) {
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

    let Some(ud) = user_data_dir(platform) else {
        return Err("未找到 IDE 用户数据目录，无法安装语言包".to_string());
    };
    let target = ud
        .join("extensions")
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
fn apply(platform: &str, elevate: bool) -> Result<LocalizationOperationResult, String> {
    if platform == "claude-desktop" {
        return apply_claude(elevate);
    }
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;

    // 语言包策略：已装 → 直接切显示语言；未装 → 默认自动从 Open VSX 安装与
    // IDE 引擎匹配的版本（用户要求默认设置好，不让用户手动去扩展市场）。
    // 安装/切换失败不阻断汉化本体，但必须如实写进消息，绝不静默吞掉。
    // 语言包安装走网络（Open VSX + VSIX 下载），绝不在注入锁内做——
    // 否则 keeper 会被几分钟的网络超时挡住。语言包操作与 html 注入互不相干。
    let mut lang_note: Option<String> = None;
    // 无论已装还是本次安装，都清一次 obsolete 标记 + 补注册 languagepacks.json：
    // 目录合法但被标记 = VS Code 扫描器跳过；没注册 = 装了也不生效（实测双双踩中）
    clear_obsolete_mark(platform, LANG_PACK_EXTENSION_ID);
    if let Some(ver) = installed_lang_pack_version(platform) {
        register_language_pack(platform, &ver);
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

    let html_path = workbench_html_path(platform).ok_or_else(|| {
        format!(
            "未定位到 {} 的 workbench.html（请先安装并运行一次 {} 后重试）",
            display, display
        )
    })?;
    let html = fs::read_to_string(&html_path).map_err(|e| format!("读取 workbench.html 失败: {e}"))?;

    // 备份：当前 html 无汉化标记 = 原厂态（首次注入，或 IDE 升级覆盖后的新版原厂），
    // 一律刷新备份以严格对齐当前安装版本。
    // 若只在"备份不存在"时才写，keeper 在升级后重注入时备份仍是旧版本 html，
    // 用户后续点还原会把旧版本覆盖回新版安装，造成 workbench 版本错配。
    // （还原成功后备份会被删除，因此这里不会误刷新。）
    let backup = PathBuf::from(format!("{}{}", html_path.to_string_lossy(), HANS_BACKUP_SUFFIX));
    if !html.contains(HANS_BLOCK_START) {
        fs::write(&backup, &html).map_err(|e| format!("备份 workbench.html 失败: {e}"))?;
    }

    let stripped = strip_hans_block(&html);
    let with_csp = ensure_csp_unsafe_inline(&stripped);
    let script = hans_script(platform);
    let entries = count_entries(&script);
    let block = format!(
        "\n{start}\n{ver}\n<script>\n{script}\n</script>\n{end}\n",
        start = HANS_BLOCK_START,
        ver = HANS_VERSION_MARKER,
        script = script,
        end = HANS_BLOCK_END,
    );

    let Some(body_idx) = with_csp.rfind("</body>") else {
        return Err("workbench.html 缺少 </body>，无法注入".to_string());
    };
    let mut new_html = String::with_capacity(with_csp.len() + block.len());
    new_html.push_str(&with_csp[..body_idx]);
    new_html.push_str(&block);
    new_html.push_str(&with_csp[body_idx..]);
    write_atomic(&html_path, &new_html).map_err(|e| format!("写入 workbench.html 失败: {e}"))?;
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
        "{} 汉化补丁已应用成功（{} 条词条），重启客户端后生效",
        display, entries
    );
    if let Some(note) = locale_note.or(lang_note) {
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

fn restore(platform: &str, elevate: bool) -> Result<LocalizationOperationResult, String> {
    if platform == "claude-desktop" {
        return restore_claude(elevate);
    }
    // 持全局注入锁：与 BYOK 接入/还原、保活 keeper 互斥，
    // 防并发读-改-写互相覆盖（详见 commands::inject_lock 注释）。
    let _guard = super::inject_lock();
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;

    let html_path = workbench_html_path(platform)
        .ok_or_else(|| format!("未定位到 {} 的 workbench.html", display))?;
    let backup = PathBuf::from(format!("{}{}", html_path.to_string_lossy(), HANS_BACKUP_SUFFIX));
    let html = fs::read_to_string(&html_path).map_err(|e| e.to_string())?;

    // 还原一律走「剥离自己的汉化块」，绝不用备份整体覆盖：
    // 备份是"打汉化前"的快照，若用户是先汉化、后一键接入，备份里没有 BYOK 注入块，
    // 整体覆盖会把 BYOK 的 byok-cards 块一并抹掉，导致接入静默失效
    // （antigravity_localization.rs 里同一个坑早有记载：绝不回退到接入前的纯净版）。
    let mut changed = false;
    if html.contains(HANS_BLOCK_START) {
        if !html.contains(HANS_BLOCK_END) {
            // 块标记不完整（写入被中断或遭外部改写）：如实报错，不做危险的整体覆盖，
            // 备份保留供用户手动还原。
            return Err(format!(
                "{} 的汉化块标记不完整，无法安全还原。请重装客户端，或用备份 {} 手动覆盖",
                display,
                backup.display()
            ));
        }
        let cleaned = strip_hans_block(&html);
        write_atomic(&html_path, &cleaned).map_err(|e| format!("还原 workbench.html 失败: {e}"))?;
        changed = true;
        invalidate_status_cache();
    }
    // 备份的存在价值只到还原为止；剥离成功后即清理，避免下次 apply 误用旧版本。
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }

    // product.json 校验清单：仅当 byok 注入块也不在时才会去还原
    // （byok 还在用则必须保留清空状态，否则它那边弹"安装已损坏"）。
    let mut warning = String::new();
    if let Ok(html) = fs::read_to_string(&html_path) {
        if !html.contains(BYOK_BLOCK_START) {
            if let Err(e) = restore_product_json(platform) {
                warning = format!("；完整性校验清单还原失败：{e}（重装 IDE 可恢复）");
            }
        }
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

/// 合并词典：有译文的 key 写中文，其余保留英文。返回 (合并后 JSON, 翻译条数)。
/// 纯函数，便于单测；对已汉化文件重复执行也幂等（中文 value 不在译文里时保留）。
///
/// 关键：**追加**词典中存在但 en-US.json 没有的 id。Claude 用 react-intl，
/// 语言文件是「id → 文案」的覆盖集——新版 Claude 新增的文案 id（如设置面板
/// 7JGu5oG/Uu）不在旧 en-US.json 里，词典有译文但不追加就永远查不到（显示英文）。
/// react-intl 只查自己认识的 id，多写的条目无副作用。
fn merge_i18n(
    en_json: &str,
    zh_map: &serde_json::Map<String, Value>,
) -> Result<(String, usize), String> {
    let en: Value =
        serde_json::from_str(en_json).map_err(|e| format!("en-US.json 解析失败: {e}"))?;
    let en_map = en.as_object().ok_or("en-US.json 格式异常（非 JSON 对象）")?;
    // 空对象/空输入一律拒绝：否则合并结果也是空，写回即把语言文件清空
    if en_map.is_empty() || en_json.trim().is_empty() {
        return Err("en-US.json 内容为空，拒绝合并（保护原语言文件）".to_string());
    }
    let mut merged = serde_json::Map::new();
    let mut translated = 0usize;
    // 第一轮：en 已有的 key——有译文写中文，未覆盖保留英文
    for (k, v) in en_map {
        match zh_map.get(k).and_then(|z| z.as_str()) {
            Some(zh_val) if !zh_val.is_empty() => {
                merged.insert(k.clone(), json!(zh_val));
                translated += 1;
            }
            _ => {
                merged.insert(k.clone(), v.clone());
            }
        }
    }
    // 第二轮：词典里有、en 没有的新 id——追加，覆盖新版 Claude 的新增文案
    for (k, v) in zh_map {
        if merged.contains_key(k) {
            continue;
        }
        if let Some(zh_val) = v.as_str() {
            if !zh_val.is_empty() {
                merged.insert(k.clone(), json!(zh_val));
                translated += 1;
            }
        }
    }
    let out = serde_json::to_string(&Value::Object(merged)).map_err(|e| e.to_string())?;
    Ok((out, translated))
}

/// Claude Desktop 汉化：合并覆盖 en-US.json（有译文的 key 写中文，其余保留英文）。
/// 词库 22,000 条 / 1MB 不内置基线，首次需先「检查在线词库更新」下载到本地缓存。
/// 确保语言文件可写。
///
/// 直接写失败时（微软商店版 MSIX 的语言文件在 WindowsApps 受保护目录），
/// 按上游 Claude-Desktop-Chinese 项目的方案授权：takeown 接管所有权 +
/// icacls 给管理员组和当前用户完全控制权（只改这一个文件的 ACL，最小侵入）。
///
/// 授权需要管理员权限，分两轮：
/// 1. 静默执行——AnyBridge 已是管理员时直接成功，无任何感知；
/// 2. `allow_uac=true` 时走一次性 UAC 提权执行同批命令（弹一次 UAC 点"是"即可，
///    不重启 AnyBridge）；keeper 等后台场景传 false——失败了就静默跳过下周期重试，
///    绝不突然弹 UAC 吓用户。
/// 授权一次后长期有效（Claude 更新会重置，届时再走一次）。
#[cfg(target_os = "windows")]
fn ensure_writable_file(path: &Path, allow_uac: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let writable = || fs::OpenOptions::new().read(true).write(true).open(path).is_ok();
    if writable() {
        return Ok(());
    }
    let p = path.to_string_lossy().to_string();
    let hidden = 0x0800_0000; // CREATE_NO_WINDOW
    // 第一轮：静默授权（AnyBridge 已是管理员时成功）。
    // 参数格式对齐上游 install.ps1 的 Ensure-WritableFile：
    // takeown /F <file> /A；icacls /grant "*S-1-5-32-544:F"；icacls /grant "<user>:(F)"
    // （本机实测 /grant Administrators:F + <user>:F 也可用，两种格式都跑一遍最稳）
    let _ = std::process::Command::new("takeown.exe")
        .args(["/F", &p, "/A"])
        .creation_flags(hidden)
        .status();
    for grant in ["*S-1-5-32-544:F", "Administrators:F"] {
        let _ = std::process::Command::new("icacls.exe")
            .args([&p, "/grant", grant])
            .creation_flags(hidden)
            .status();
    }
    if let Ok(user) = std::env::var("USERNAME") {
        for grant in [format!("{}:(F)", user), format!("{}:F", user)] {
            let _ = std::process::Command::new("icacls.exe")
                .args([&p, "/grant", &grant])
                .creation_flags(hidden)
                .status();
        }
    }
    if writable() {
        return Ok(());
    }
    // 第二轮：一次性 UAC 提权执行同批授权命令（Start-Process -Verb RunAs -Wait）
    if allow_uac {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "Administrators".to_string());
        let inner = format!(
            "takeown /F \"{}\" /A; icacls \"{}\" /grant Administrators:F; icacls \"{}\" /grant \"{}\":F",
            p, p, p, user
        );
        let outer = format!(
            "Start-Process powershell -ArgumentList '-NoProfile','-Command','{}' -Verb RunAs -Wait",
            inner.replace('\'', "''")
        );
        let ok = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer])
            .creation_flags(hidden)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok && writable() {
            return Ok(());
        }
        return Err(
            "语言文件授权未完成（UAC 可能被取消）。微软商店版位于受保护目录：请重新点击汉化并在 UAC 弹窗点【是】，或改用官网安装版".to_string(),
        );
    }
    Err(format!(
        "语言文件不可写，且当前不允许自动提权。微软商店版位于受保护目录，首次汉化需授权（请从界面手动触发）"
    ))
}

#[cfg(not(target_os = "windows"))]
fn ensure_writable_file(path: &Path, _allow_uac: bool) -> Result<(), String> {
    match fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("语言文件不可写（{}）", e)),
    }
}

fn apply_claude(elevate: bool) -> Result<LocalizationOperationResult, String> {
    let i18n_path = claude_i18n_path().ok_or_else(|| {
        "未定位到 Claude Desktop 的语言文件（请先安装并运行一次 Claude Desktop）".to_string()
    })?;

    // 可写性预检 + 自动授权（商店版 MSIX 受保护目录，上游同款方案）
    ensure_writable_file(&i18n_path, elevate)?;

    let cache = cache_dir("claude-desktop");
    let dict_path = cache.join(script_cache_name("claude-desktop"));
    if !dict_path.exists() {
        return Err(
            "本地暂无中文词库，请先点击「检查在线词库更新」下载（22,000+ 条，约 1MB）".to_string(),
        );
    }
    let zh_str = fs::read_to_string(&dict_path).map_err(|e| format!("读取词库缓存失败: {e}"))?;
    let zh: Value = serde_json::from_str(&zh_str).map_err(|e| format!("词库缓存解析失败: {e}"))?;
    let zh_map = zh.as_object().ok_or("词库缓存格式异常（非 JSON 对象）")?;

    let en_str = fs::read_to_string(&i18n_path).map_err(|e| format!("读取 en-US.json 失败: {e}"))?;

    // 备份原版（仅首次；还原后再应用时备份已在，保留不动）
    let backup = cache.join("en-US-original.json");
    if !backup.exists() {
        fs::write(&backup, en_str.as_bytes())
            .map_err(|e| format!("备份原版语言文件失败: {e}"))?;
    }

    // 合并：有译文写中文，未覆盖保留英文（对已汉化文件重复执行也幂等）
    let (out, translated) = merge_i18n(&en_str, zh_map)?;
    // 防御一：合并结果为空/无 key 时绝不写（空文件会让全部文案 fallback 英文，
    // 且原版内容已丢失——实测踩过：0 字节的 en-US.json 让界面半英半中）
    if serde_json::from_str::<Value>(&out)
        .ok()
        .and_then(|v| v.as_object().map(|m| m.len()))
        .unwrap_or(0)
        == 0
    {
        return Err("合并结果为空，已中止写入以保护原语言文件".to_string());
    }
    // 写入策略对齐上游 install.ps1：
    // 1) 直接写文件内容（只依赖文件 ACL，商店版授权后可行）
    // 2) 失败则写临时文件 + Copy 覆盖兜底（Copy 也只动文件内容）
    // 3) 最多重试 5 次，间隔递增——运行中的 Claude 可能短暂持有文件
    // 绝不能用 write_atomic（tmp + rename）：WindowsApps 目录是 TrustedInstaller
    // 拥有，rename 替换需要目录级删除权限，单文件授权了照样拒绝访问（os error 5）。
    let tmp_path = cache_dir("claude-desktop").join("en-US-patched.json");
    let mut last_err = String::new();
    let mut written = false;
    for i in 1..=5u32 {
        match fs::write(&i18n_path, out.as_bytes()) {
            Ok(_) => {
                written = true;
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                if fs::write(&tmp_path, out.as_bytes()).is_ok()
                    && fs::copy(&tmp_path, &i18n_path).is_ok()
                {
                    written = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(300 * i as u64));
            }
        }
    }
    let _ = fs::remove_file(&tmp_path);
    if !written {
        return Err(format!("写入语言文件失败: {}", last_err));
    }
    // 防御二：写后读回校验。运行中的 Claude 可能持有该文件（mmap/锁），
    // 直接写有截断风险——读回确认非空且可解析，否则从备份恢复原版并如实报错。
    let verify_ok = fs::read_to_string(&i18n_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().map(|m| !m.is_empty()))
        .unwrap_or(false);
    if !verify_ok {
        if let Ok(orig) = fs::read_to_string(&backup) {
            let _ = fs::write(&i18n_path, orig.as_bytes());
        }
        return Err("写入后校验失败（语言文件异常），已从备份恢复原版，请重启客户端后重试".to_string());
    }
    set_enabled("claude-desktop");
    invalidate_status_cache();

    // 总条数 = 语言文件原文的 key 数（合并前后一致）
    let en_total = serde_json::from_str::<Value>(&en_str)
        .ok()
        .and_then(|v| v.as_object().map(|m| m.len()))
        .unwrap_or(0);

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!(
            "Claude Desktop 汉化已应用（{}/{} 条文案），重启客户端后生效",
            translated, en_total
        ),
        localized: true,
    })
}

/// Claude Desktop 还原：从备份整体覆盖 en-US.json。
fn restore_claude(elevate: bool) -> Result<LocalizationOperationResult, String> {
    let i18n_path = claude_i18n_path()
        .ok_or_else(|| "未定位到 Claude Desktop 的语言文件".to_string())?;
    // 还原同样要写文件：商店版授权一次后 ACL 已生效，这里幂等确认一次
    ensure_writable_file(&i18n_path, elevate)?;
    let backup = cache_dir("claude-desktop").join("en-US-original.json");

    let mut changed = false;
    if backup.exists() {
        let orig = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
        // 同 apply：直接写内容（WindowsApps 目录不允许 rename 替换）
        fs::write(&i18n_path, orig.as_bytes()).map_err(|e| format!("还原语言文件失败: {e}"))?;
        let _ = fs::remove_file(&backup);
        changed = true;
        invalidate_status_cache();
    } else if is_claude_localized() {
        // 已汉化但备份丢失：无从得知原版内容，如实上报而不是假装还原成功
        return Err(
            "未找到汉化前备份，无法还原。重装 Claude Desktop 可恢复官方英文".to_string(),
        );
    }
    clear_enabled("claude-desktop");

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
    let _guard = super::inject_lock();
    if !keeper_should_reinject(platform, is_enabled(platform)) {
        return;
    }
    // 被 IDE 升级覆盖 → 重注入（apply 幂等；IDE 运行中文件被锁则 Err，下周期重试）。
    // elevate=false：keeper 是后台线程，权限不足时绝不去弹 UAC，静默等下周期。
    let display = platform_meta(platform).map(|m| m.0).unwrap_or(platform);
    match apply(platform, false) {
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

#[tauri::command]
pub fn apply_app_localization(platform: String) -> Result<LocalizationOperationResult, String> {
    apply(&platform, true)
}

#[tauri::command]
pub fn restore_app_localization(platform: String) -> Result<LocalizationOperationResult, String> {
    restore(&platform, true)
}

#[tauri::command]
pub async fn check_app_localization_update(
    platform: String,
) -> Result<AppLocalizationStatus, String> {
    platform_meta(&platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;
    let mut status = build_status(&platform)?;

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
    fn merges_i18n_with_translation_and_fallback() {
        let en = r#"{"k1":"Settings","k2":"Unknown Key","k3":""}"#;
        let mut zh = serde_json::Map::new();
        zh.insert("k1".to_string(), json!("设置"));
        // k2 无译文 → 保留英文；k3 译文为空 → 保留英文
        zh.insert("k3".to_string(), json!(""));
        // new-id 是新版 Claude 新增的文案 id（en-US.json 里没有）→ 应追加
        zh.insert("new-id".to_string(), json!("新界面文案"));
        let (out, translated) = merge_i18n(en, &zh).expect("合并应成功");
        assert_eq!(translated, 2, "k1 翻译 + new-id 追加");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["k1"], json!("设置"));
        assert_eq!(v["k2"], json!("Unknown Key"));
        assert_eq!(v["k3"], json!(""));
        assert_eq!(v["new-id"], json!("新界面文案"), "新 id 应被追加");
        // 幂等：对已合并结果再跑一次不劣化
        let (out2, t2) = merge_i18n(&out, &zh).unwrap();
        assert_eq!(t2, 2);
        let v2: Value = serde_json::from_str(&out2).unwrap();
        assert_eq!(v2["k1"], json!("设置"));
        assert_eq!(v2["new-id"], json!("新界面文案"));
    }

    #[test]
    fn merge_i18n_rejects_non_object() {
        let zh = serde_json::Map::new();
        assert!(merge_i18n("[1,2,3]", &zh).is_err());
        assert!(merge_i18n("not json", &zh).is_err());
        // 空对象/空串必须拒绝：否则写回会把语言文件清空（实测事故）
        assert!(merge_i18n("{}", &zh).is_err());
        assert!(merge_i18n("", &zh).is_err());
        assert!(merge_i18n("   ", &zh).is_err());
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

    #[test]
    fn windsurf_baseline_dictionary_is_usable() {
        let script = build_script_from_dictionary(WINDSURF_BASELINE_DICT)
            .expect("Windsurf 基线词典应能组装出脚本");
        assert!(script.contains("MutationObserver"), "应保留通用引擎");
        assert!(!script.contains("createToggleButton"), "引擎不应含上游悬浮按钮");
        assert!(!script.contains("setTimeout(init, 800)"), "不应有 800ms 启动延迟");
        let n = count_entries(&script);
        assert!(n > 100, "Windsurf 词典应 100+ 词条，实际 {}", n);
    }

    #[test]
    fn extracts_dictionary_from_windsurf_script() {
        // 用内置基线脚本反向验证抽取（基线即从该格式抽得）
        let dict = extract_dictionary_from_windsurf_script(BASELINE_SCRIPT)
            .expect("应能从脚本抽取词典");
        let entries = dict["sections"][0]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 137, "应抽出 137 条词条");
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
                .join("i18n")
        };
        for ver in ["app-1.0.0", "app-2.3.1", "app-1.9.9"] {
            let dir = layout(ver);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("en-US.json"), "{}").unwrap();
        }
        let picked = pick_claude_i18n(&root).expect("应定位到语言文件");
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
        assert!(!is_installed("claude-desktop") || claude_i18n_path().is_some());
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
    fn ensure_writable_file_ok_for_normal_file() {
        // 普通可写文件：直接放行，不进授权分支
        let dir = std::env::temp_dir().join("anybridge-test-writable");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("en-US.json");
        fs::write(&f, "{}").unwrap();
        ensure_writable_file(&f, false).expect("普通文件应可写");
        // 不存在的文件：授权后仍失败（但不应 panic）
        assert!(ensure_writable_file(&dir.join("nonexistent.json"), false).is_err());
        let _ = fs::remove_dir_all(&dir);
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
