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

use crate::commands::antigravity_localization::LocalizationOperationResult;
use crate::commands::workbench_inject::{
    clear_product_checksums, ensure_csp_unsafe_inline, patch_nls_tolerant, product_json_path,
    restore_product_json, revert_csp_unsafe_inline, workbench_html_path,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub(super) const HANS_BLOCK_START: &str = crate::commands::workbench_inject::HANS_BLOCK_START;
pub(super) const HANS_BLOCK_END: &str = "<!-- anybridge-hans-end -->";
pub(super) const HANS_VERSION_MARKER: &str = "<!-- anybridge-hans-v1 -->";
pub(super) const HANS_BACKUP_SUFFIX: &str = ".hans-origin";
/// Antigravity IDE 的设置页 / Agent 面板由**独立引导窗口**渲染（实测 1.107.0：
/// out/vs/code/electron-browser/workbench/workbench-jetski-agent.html）。
/// 该窗口是独立渲染进程，只注入主 workbench.html 时，标准菜单（官方语言包）是
/// 中文而设置页全英文。它的 CSP 还没有 'unsafe-inline'，必须一起补。
pub(super) const AG_IDE_AGENT_WINDOW_HTML: &str = "workbench-jetski-agent.html";
pub(super) const BYOK_BLOCK_START: &str = "<!-- byok-cards-start -->";
pub(super) const BYOK_BLOCK_END: &str = "<!-- byok-cards-end -->";

pub(super) const UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/KLFDan0534/windsurf-autoContinue/main/windsurf-localization.js";
pub(super) const CURSOR_UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/vibepm666/cursor-localization-zh/main/localization/Core_Dictionary.json";
/// Claude 词典源：yiheng8023/claude-chinese 的 ion 分词库。
/// 选它而不是 good9527 那个（22319 条）的原因：专门对应 ion-dist 渲染层结构，
/// 30678 条且**覆盖新版 Claude 新增的文案 id**（实测设置面板那批 id 覆盖率 5/5，
/// good9527 只有 4/5）。项目活跃、MIT。
pub(super) const CLAUDE_UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/yiheng8023/claude-chinese/main/dict/ion-zh-CN.json";
pub(super) const AG_IDE_UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/liominsb/Antigravity-Chinese-Localization/master/localize.js";

/// 中文语言包扩展目录前缀 / 扩展 id（VS Code 官方简体中文语言包）。
pub(super) const LANG_PACK_DIR_PREFIX: &str = "ms-ceintl.vscode-language-pack-zh-hans";
pub(super) const LANG_PACK_EXTENSION_ID: &str = "ms-ceintl.vscode-language-pack-zh-hans";

/// 内置基线（离线兜底）：
/// - windsurf-localization-baseline.js / devin-localization-baseline.js：
///   Windsurf/Devin 专用**完整汉化模块**（引擎 + 820/817 条人工词典，源自 Kite
///   windsurf/devin-better.js 的汉化模块，经 v8.x 长期实战打磨）。这两个平台
///   的专有 UI（设置页内容、Cascade/Codebuddy 面板、输入区、Plan/Quota 等）
///   只有这套词典覆盖得全，VS Code 官方语言包只翻核心。
/// - cursor/antigravity-ide：内置引擎模板 + 平台词典 JSON 组装（词典量较小）。
pub(super) const BASELINE_SCRIPT: &str = include_str!("../windsurf-localization-baseline.js");
pub(super) const DEVIN_BASELINE_SCRIPT: &str = include_str!("../devin-localization-baseline.js");
pub(super) const CURSOR_BASELINE_DICT: &str = include_str!("../cursor-dictionary-baseline.json");
pub(super) const AG_IDE_BASELINE_DICT: &str = include_str!("../antigravity-ide-dictionary-baseline.json");

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
pub(super) fn platform_meta(platform: &str) -> Option<(&'static str, &'static [&'static str])> {
    match platform {
        "windsurf" => Some(("Windsurf", &["Windsurf"])),
        "devin" => Some(("Devin Desktop", &["Devin", "Windsurf"])),
        "cursor" => Some(("Cursor", &["Cursor"])),
        "claude-desktop" => Some(("Claude Desktop", &[])),
        "antigravity-ide" => Some(("Antigravity IDE", &["Antigravity IDE"])),
        _ => None,
    }
}

/// 状态目录（argv.json / languagepacks.json 所在）：VS Code 系标准位置是
/// %APPDATA%\<name>（Windsurf 实测 --user-data-dir 就在此）。
pub(super) fn ide_state_dir(platform: &str) -> Option<PathBuf> {
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

/// 与安装目录隔离的 home 点目录（Codeium 传统扩展目录以及 Antigravity IDE 的
/// `dataFolderName: .antigravity-ide`，Electron 主进程从此读取 extensions 与 argv.json）。
pub(super) fn ide_home_dot_dir(platform: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match platform {
        "windsurf" => Some(home.join(".windsurf")),
        "devin" => {
            let d = home.join(".devin");
            if d.is_dir() || !home.join(".windsurf").is_dir() {
                Some(d)
            } else {
                Some(home.join(".windsurf"))
            }
        }
        "antigravity-ide" => Some(home.join(".antigravity-ide")),
        _ => None,
    }
}

/// argv.json 路径：VS Code 主进程按 `VSCODE_PORTABLE` → `~/<dataFolderName>/argv.json`
/// 解析显示语言 `locale`（实测 Antigravity IDE 在 `~/.antigravity-ide/argv.json`，
/// 与 `%APPDATA%/Antigravity IDE` 下的 `languagepacks.json` 分离）。
/// 注意：Cursor 的 `~/.cursor` 是 CLI agent 目录，仅当已存在 `argv.json` 时兼容读取，不主动创建。
pub(super) fn ide_argv_path(platform: &str) -> Option<PathBuf> {
    if let Some(portable) = std::env::var_os("VSCODE_PORTABLE") {
        if !portable.is_empty() {
            let p = PathBuf::from(&portable);
            if p.is_dir() {
                return Some(p.join("argv.json"));
            }
        }
    }
    if let Some(dot) = ide_home_dot_dir(platform) {
        return Some(dot.join("argv.json"));
    }
    if platform == "cursor" {
        if let Some(home) = dirs::home_dir() {
            let home_argv = home.join(".cursor").join("argv.json");
            if home_argv.exists() {
                return Some(home_argv);
            }
        }
    }
    ide_state_dir(platform).map(|d| d.join("argv.json"))
}

/// 扩展目录（extensions/ 所在）。
/// Windsurf 系（Codeium 传统）与 Antigravity IDE（`dataFolderName: .antigravity-ide`）
/// 均将扩展放在 `~/.<name>/extensions`；其余默认在 `%APPDATA%/<name>/extensions`。
/// 注意：Cursor 的 `~/.cursor` 是 CLI agent 目录，绝不把编辑器扩展装到那儿。
pub(super) fn ide_extensions_dir(platform: &str) -> Option<PathBuf> {
    let (_, names) = platform_meta(platform)?;
    if names.is_empty() {
        return None;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dot) = ide_home_dot_dir(platform) {
        candidates.push(dot.join("extensions"));
    }
    if let Some(roaming) = dirs::config_dir() {
        for n in names {
            candidates.push(roaming.join(n).join("extensions"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_dir())
        .or_else(|| ide_home_dot_dir(platform).map(|d| d.join("extensions")))
        .or_else(|| ide_state_dir(platform).map(|d| d.join("extensions")))
}

pub(super) fn cache_dir(platform: &str) -> PathBuf {
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
pub(super) const LOCALE_ABSENT: &str = "__absent__";

/// locale 改前值的记账内容。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LocaleRecord {
    /// 改之前 locale = 该值
    Was(String),
    /// 改之前没有 locale 键
    Absent,
}

pub(super) fn side_effects_path(platform: &str) -> PathBuf {
    cache_dir(platform).join("side-effects.json")
}

pub(super) fn read_side_effects(platform: &str) -> Value {
    fs::read_to_string(side_effects_path(platform))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

pub(super) fn write_side_effects(platform: &str, v: &Value) -> Result<(), String> {
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
pub(super) fn revert_locale_in_argv(raw: &str, record: &LocaleRecord) -> Option<String> {
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

mod apply_and_keeper;
mod claude_desktop_zh;
mod lang_pack;
mod scripts_and_dict;
mod workbench_checks;

use apply_and_keeper::*;
use lang_pack::*;
use scripts_and_dict::*;
use workbench_checks::*;

pub use apply_and_keeper::spawn_localization_keeper;
pub(crate) use scripts_and_dict::hans_script_for_cdp;
pub(crate) use workbench_checks::{extract_csp_nonce, is_enabled, strip_injected_block};

pub(super) fn build_status(platform: &str) -> Result<AppLocalizationStatus, String> {
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
pub(super) fn content_sha256(content: &str) -> String {
    crate::commands::content_sha256(content)
}

/// 拉取上游词库原文：raw 直下（CDN，无 API 限流）+ 镜像兜底，
/// 具体实现见 commands::fetch_github_content。
pub(super) async fn fetch_upstream_content(platform: &str) -> Result<String, String> {
    let raw_url = upstream_raw_url(platform)
        .ok_or_else(|| format!("不支持的平台: {}", platform))?;
    crate::commands::fetch_github_content(raw_url, 30).await
}

/// 状态缓存：界面在页面加载、打开面板、apply/restore 后会反复查询，
/// 每次都读 workbench.html（数 MB）+ IDE 路径探测链，3 秒 TTL 覆盖连续查询，
/// apply/restore 主动失效。
pub(super) static STATUS_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<(std::time::Instant, AppLocalizationStatus)>>,
> = std::sync::OnceLock::new();
pub(super) const STATUS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3);

pub(super) fn invalidate_status_cache() {
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
            let slot = cache.lock().unwrap_or_else(|e| e.into_inner());
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
mod tests;
#[cfg(test)]
mod lang_pack_tests;
