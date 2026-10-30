// antigravity_localization.rs — Antigravity 独立桌面端与 IDE 双端深度汉化及热更新管理器
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const CURRENT_EMBEDDED_VERSION: &str = "2.18.1";
const UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/liominsb/Antigravity-Chinese-Localization/master/localize.js";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLocalizationStatus {
    pub target: String,
    pub installed: bool,
    pub localized: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release_name: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalizationOperationResult {
    pub ok: bool,
    pub message: String,
    pub localized: bool,
}

/// asar payload 的真实起点：`8 + 头部声明的 header 总长（bytes[4..8]）`。
///
/// asar 头部是 Chromium pickle 格式：`[4][headerBufLen][4][jsonLen][json][padding]`，
/// Electron 以 `8 + bytes[4..8]` 为 payload 基准（headerBufLen 已含 padding）。
/// 若直接用 `16 + jsonLen` 会把 pickle 的 0..3 字节对齐填充算进 payload，
/// 导致所有文件读取偏移、注入内容混入上一个文件的尾部碎片而语法非法。
/// 注意写回时 `[4..8]`/`[8..12]` 字段必须同步加上 padding（见 asar_padding_len），
/// 否则会出现"声明基准"与"实际布局"错位、客户端启动即崩。
pub(crate) fn asar_payload_start(declared_header_size: usize) -> usize {
    8 + declared_header_size
}

/// header JSON 之后需要补的 pickle 对齐填充字节数（0..3）。
/// 写回时必须同时把 padding 加进 `[4..8]` 与 `[8..12]` 字段。
pub(crate) fn asar_padding_len(json_len: usize) -> usize {
    let raw = 16 + json_len;
    ((raw + 3) & !3) - raw
}

fn cache_dir() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        let p = dir
            .join("AnyBridge")
            .join("localization")
            .join("antigravity");
        let _ = fs::create_dir_all(&p);
        p
    } else {
        PathBuf::from(".antigravity_localization_cache")
    }
}

pub(crate) fn hub_asar_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let p = local
            .join("Programs")
            .join("antigravity")
            .join("resources")
            .join("app.asar");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p = PathBuf::from("/Applications/Antigravity.app/Contents/Resources/app.asar");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir()?;
        let p = home
            .join(".local")
            .join("share")
            .join("antigravity")
            .join("resources")
            .join("app.asar");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}

pub(crate) fn ide_workbench_html_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let p = local
            .join("Programs")
            .join("Antigravity IDE")
            .join("resources")
            .join("app")
            .join("out")
            .join("vs")
            .join("code")
            .join("electron-browser")
            .join("workbench")
            .join("workbench.html");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p = PathBuf::from("/Applications/Antigravity IDE.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        let p = PathBuf::from("/usr/share/antigravity-ide/resources/app/out/vs/code/electron-browser/workbench/workbench.html");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}

pub(crate) fn ide_product_json_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let p = local
            .join("Programs")
            .join("Antigravity IDE")
            .join("resources")
            .join("app")
            .join("product.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p =
            PathBuf::from("/Applications/Antigravity IDE.app/Contents/Resources/app/product.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        let p = PathBuf::from("/usr/share/antigravity-ide/resources/app/product.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}

fn read_cached_version() -> String {
    let meta_path = cache_dir().join("metadata.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(v) = val.get("version").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    CURRENT_EMBEDDED_VERSION.to_string()
}

/// 本地缓存的词库内容指纹（metadata.json 的 sha 字段）。
/// 空 = 从未同步过（还在跑内置基线）→ 视为有更新。
fn read_cached_sha() -> String {
    let meta_path = cache_dir().join("metadata.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(v) = val.get("sha").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    String::new()
}

fn get_hub_payload() -> String {
    // 热更新层：上游词典覆盖块（若存在且通过自检）先于引擎赋值
    // window.__ANYBRIDGE_HANS_DICT，引擎 IIFE 启动时把它合并进内置 phrases。
    // 旧版/被改坏的缓存直接弃用——preload.js 顶层多一个语法错误 = 客户端起不来。
    // 首行必须是 HUB_PATCH_HEADER：去重截断靠它定位补丁块起点。
    let cached = cache_dir().join("antigravity-hub-dict.js");
    let override_line = fs::read_to_string(&cached)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && is_safe_dict_override(s));

    let mut out = String::from(super::antigravity_loc_payload::HUB_PATCH_HEADER);
    out.push('\n');
    if let Some(line) = override_line {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(super::antigravity_loc_payload::HUB_PAYLOAD_JS);
    out
}

/// 覆盖块读时自检：必须是 `window.__ANYBRIDGE_HANS_DICT = {JSON};` 形态。
///
/// 提取端（extract_dictionary_override）用 serde_json 重新序列化，正常必然通过；
/// 这里拦的是历史遗留缓存、手工改动与截断损坏。历史事故：坏块从未被 payload
/// 消费时只是热更新无效，拼进 preload.js 顶层后就是客户端无法启动。
fn is_safe_dict_override(s: &str) -> bool {
    let dict_global = format!("window.{}", super::antigravity_loc_payload::HUB_DICT_GLOBAL);
    let Some(rest) = s.strip_prefix(&dict_global) else {
        return false;
    };
    let rest = rest.trim_start();
    let Some(rest) = rest.strip_prefix('=') else {
        return false;
    };
    let Some(body) = rest.trim().strip_suffix(';') else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(body.trim())
        .map(|v| v.is_object())
        .unwrap_or(false)
}

/// 将 JS 字符串字面量内容（不含外层引号）还原为真实字符串。
fn unescape_js(raw: &str) -> String {
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
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// 从上游 localize.js 源码中抽取汉化词典，重新序列化为绝对合法的 JS 赋值语句。
///
/// 上游脚本是 Node 程序（含 require/fs），不能直接注入浏览器 preload，因此只抽取其中的
/// 词典字面量。所有条目经 serde_json 重新序列化，保证产物是 100% 合法的 JS 对象字面量，
/// 绝不会因上游格式变化导致注入的语法错误使客户端崩溃。
fn extract_dictionary_override(source: &str) -> Option<(String, usize)> {
    let start = source.find("const dictionary = {")?;
    let rest = &source[start..];
    let end = rest.find("\n};")?;
    let block = &rest[..end];

    let re = regex::Regex::new(r#""((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)""#).ok()?;
    let mut map = serde_json::Map::new();
    for caps in re.captures_iter(block) {
        let key = unescape_js(&caps[1]);
        let val = unescape_js(&caps[2]);
        if !key.is_empty() && !val.is_empty() {
            map.insert(key, serde_json::Value::String(val));
        }
    }
    let count = map.len();
    if count == 0 {
        return None;
    }
    let json = serde_json::to_string(&serde_json::Value::Object(map)).ok()?;
    Some((format!("window.__ANYBRIDGE_HANS_DICT = {};", json), count))
}

/// 检测 Hub 是否已汉化：只读 asar 的 header 区与 preload.js 段，不读全文件。
/// 曾经 fs::read 整个 4.5MB asar：Windows Defender 实时扫描 + serde 解析 header
/// 合计几百毫秒，且调用方是同步命令会占住 Tauri 主线程，点按钮观感"卡半天"。
fn is_hub_localized(asar_path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(asar_path) else {
        return false;
    };
    // pickle 头 16 字节：[4][headerBufLen][4][jsonLen]...
    let mut head = [0u8; 16];
    if file.read_exact(&mut head).is_err() {
        return false;
    }
    let json_size = u32::from_le_bytes(head[12..16].try_into().unwrap()) as usize;
    let declared_header_size = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
    let payload_start = asar_payload_start(declared_header_size);
    // 只读 header JSON（asar 全部文件条目，几百 KB），跳过 4.5MB payload
    let mut header_bytes = vec![0u8; json_size];
    if file.read_exact(&mut header_bytes).is_err() {
        return false;
    }
    let Ok(header_str) = std::str::from_utf8(&header_bytes) else {
        return false;
    };
    let Ok(header) = serde_json::from_str::<Value>(header_str) else {
        return false;
    };

    let Some(preload_node) = header
        .get("files")
        .and_then(|f| f.get("dist"))
        .and_then(|d| d.get("files"))
        .and_then(|f| f.get("preload.js"))
    else {
        return false;
    };

    let offset: usize = preload_node
        .get("offset")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let size: usize = preload_node
        .get("size")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    if size == 0 {
        return false;
    }
    // seek 到 preload.js 段，只读这一段
    if file
        .seek(SeekFrom::Start((payload_start + offset) as u64))
        .is_err()
    {
        return false;
    }
    let mut code_bytes = vec![0u8; size];
    if file.read_exact(&mut code_bytes).is_err() {
        return false;
    }
    let Ok(code) = std::str::from_utf8(&code_bytes) else {
        return false;
    };
    // 当前代 payload 的运行时标记（常量与 payload 同源，见 antigravity_loc_payload）；
    // 两个历史引擎字面量保留为兼容判据——老版本 AnyBridge 打的补丁没有新标记，
    // 漏判会让用户重复 apply、旧补丁叠加。去重锚点同样兼容这三代（见 patch_hub_asar）。
    code.contains(super::antigravity_loc_payload::HUB_PATCH_FLAG)
        || code.contains("__antigravityHansInjected")
        || code.contains("Antigravity 2.0 Chinese Localization Engine")
}

fn is_ide_localized(html_path: &Path) -> bool {
    if let Ok(content) = fs::read_to_string(html_path) {
        return content.contains("antigravity-hans-overlay.js")
            || content.contains("__antigravityIdeHansInjected");
    }
    false
}

fn patch_hub_asar(asar_path: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let _t0 = std::time::Instant::now();

    // ── 轻量读：只读 header + preload.js 段（几 MB）。构造期望内容后与现值
    //    比对，一致（重复点「一键汉化」且词库/引擎未变）则跳过几百 MB 的
    //    asar 全量重写——原先每次都读写整个文件，是点击后卡顿数秒的主因。
    let mut f = fs::File::open(asar_path).map_err(|e| format!("读取 app.asar 失败: {e}"))?;
    let mut head16 = [0u8; 16];
    f.read_exact(&mut head16).map_err(|e| format!("读取 asar 头失败: {e}"))?;
    let json_size = u32::from_le_bytes(head16[12..16].try_into().unwrap()) as usize;
    if json_size == 0 || json_size > 64 * 1024 * 1024 {
        return Err("app.asar header 大小异常".to_string());
    }

    let mut header_bytes = vec![0u8; 16 + json_size];
    f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    f.read_exact(&mut header_bytes).map_err(|e| format!("读取 asar header 失败: {e}"))?;
    let header_str = std::str::from_utf8(&header_bytes[16..])
        .map_err(|e| format!("解析 header UTF-8 失败: {e}"))?;
    let mut header: Value =
        serde_json::from_str(header_str).map_err(|e| format!("解析 header JSON 失败: {e}"))?;

    let preload_node = header
        .get_mut("files")
        .and_then(|f| f.get_mut("dist"))
        .and_then(|d| d.get_mut("files"))
        .and_then(|f| f.get_mut("preload.js"))
        .and_then(|n| n.as_object_mut())
        .ok_or_else(|| "未在 app.asar 中找到 dist/preload.js".to_string())?;

    let offset: usize = preload_node
        .get("offset")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let size: usize = preload_node
        .get("size")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let declared_header_size = u32::from_le_bytes(head16[4..8].try_into().unwrap()) as usize;
    let payload_start = asar_payload_start(declared_header_size);
    if size == 0 || size > 256 * 1024 * 1024 {
        return Err("preload.js 段大小异常".to_string());
    }

    f.seek(SeekFrom::Start((payload_start + offset) as u64))
        .map_err(|e| e.to_string())?;
    let mut preload_buf = vec![0u8; size];
    f.read_exact(&mut preload_buf).map_err(|e| format!("读取 preload.js 失败: {e}"))?;
    let original_code =
        std::str::from_utf8(&preload_buf).map_err(|e| format!("解析 preload.js 失败: {e}"))?.to_string();
    drop(f);

    // ── 备份策略（版本防护，与 workbench_inject 的 product.json 备份同思路）──
    // 原厂态（首次汉化，或官方升级覆盖后的新版原厂）一律刷新备份，确保
    // app.asar.lang.bak 与当前安装严格一致——否则升级后点"还原"会把新版
    // 客户端覆盖成旧版。已汉化态则要求备份必须存在，缺失如实报错：
    // 旧实现 let _ = 静默吞掉 copy 失败 = 永久失去还原源。
    let patched = original_code.contains(super::antigravity_loc_payload::HUB_PATCH_FLAG);
    let bak_path = asar_path.with_file_name("app.asar.lang.bak");
    if !patched {
        fs::copy(asar_path, &bak_path).map_err(|e| {
            format!(
                "备份 app.asar 失败（不备份就打补丁将无法还原，请先关闭 Antigravity 后重试）: {e}"
            )
        })?;
    } else if !bak_path.exists() {
        return Err(
            "检测到已汉化但缺少 app.asar.lang.bak 备份，无法安全更新补丁；请先重装 Antigravity 恢复原厂后再试"
                .to_string(),
        );
    }

    // ── 去重截断：从最早出现的补丁块锚点处截掉旧补丁，再追加新补丁 ──
    // 三代引擎的锚点都保留：老版本 AnyBridge 打的旧补丁也要能被剥掉，
    // 否则新旧引擎叠加会双重翻译。
    let anchors: [&str; 3] = [
        super::antigravity_loc_payload::HUB_PATCH_HEADER,
        "// Antigravity 2.0 Chinese Localization Engine",
        "// Antigravity Chinese Localization Engine",
    ];
    let clean_base = anchors
        .iter()
        .filter_map(|a| original_code.find(a))
        .min()
        .map(|idx| original_code[..idx].trim_end().to_string())
        .unwrap_or_else(|| original_code.clone());

    let new_code = format!("{}\n\n{}\n", clean_base, get_hub_payload().trim());
    eprintln!("[ag-loc] patch: 轻量读+构造耗时 {:?}", _t0.elapsed());

    // 幂等：内容一致 → 跳过几百 MB 的 asar 全量重写
    if original_code == new_code {
        
        eprintln!("[ag-loc] patch: 内容一致跳过写回");
        return Ok(());
    }

    // 内容有变（首次 / 词库更新 / 引擎升级）→ 全量读 asar 改 header 后写回
    let bytes = fs::read(asar_path).map_err(|e| format!("读取 app.asar 失败: {e}"))?;
    if bytes.len() < 16 + json_size {
        return Err("app.asar header 大小异常".to_string());
    }
    let header_str = std::str::from_utf8(&bytes[16..16 + json_size])
        .map_err(|e| format!("解析 header UTF-8 失败: {e}"))?;
    let mut header: Value =
        serde_json::from_str(header_str).map_err(|e| format!("解析 header JSON 失败: {e}"))?;
    let preload_node = header
        .get_mut("files")
        .and_then(|f| f.get_mut("dist"))
        .and_then(|d| d.get_mut("files"))
        .and_then(|f| f.get_mut("preload.js"))
        .and_then(|n| n.as_object_mut())
        .ok_or_else(|| "未在 app.asar 中找到 dist/preload.js".to_string())?;
    let new_code_bytes = new_code.as_bytes();
    let old_payload = &bytes[payload_start..];
    let new_offset = old_payload.len();

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(new_code_bytes);
    let hash_hex = hex::encode(hasher.finalize());

    preload_node.insert("offset".to_string(), json!(new_offset.to_string()));
    preload_node.insert("size".to_string(), json!(new_code_bytes.len()));
    preload_node.insert(
        "integrity".to_string(),
        json!({
            "algorithm": "SHA256",
            "hash": hash_hex.clone(),
            "blockSize": 4194304,
            "blocks": [hash_hex]
        }),
    );

    let new_header_json = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    let new_header_bytes = new_header_json.as_bytes();
    let new_json_size = new_header_bytes.len() as u32;

    // header 之后必须补 0..3 字节填充到 4 字节对齐：Electron 从
    // align4(16 + header_size) 起算 payload，不补则所有文件整体错位、客户端崩溃。
    let padding_len = asar_padding_len(new_header_bytes.len());
    let mut final_bytes = Vec::with_capacity(
        16 + new_header_bytes.len() + padding_len + old_payload.len() + new_code_bytes.len(),
    );
    // pickle 尺寸字段必须包含 padding：Electron 以 8 + bytes[4..8] 定位 payload
    final_bytes.extend_from_slice(&4u32.to_le_bytes());
    final_bytes.extend_from_slice(&((new_json_size as usize + 8 + padding_len) as u32).to_le_bytes());
    final_bytes.extend_from_slice(&((new_json_size as usize + 4 + padding_len) as u32).to_le_bytes());
    final_bytes.extend_from_slice(&new_json_size.to_le_bytes());
    final_bytes.extend_from_slice(new_header_bytes);
    final_bytes.extend_from_slice(&vec![0u8; padding_len]);
    final_bytes.extend_from_slice(old_payload);
    final_bytes.extend_from_slice(new_code_bytes);

    fs::write(asar_path, final_bytes)
        .map_err(|e| format!("写入汉化补丁失败（请先关闭 Antigravity 客户端后重试）: {e}"))?;
    Ok(())
}

/// 当前 asar 是否已含 BYOK 端点补丁（languageServer.js 里有 jetski.cloudCodeUrl）。
/// 用途见 restore_hub_asar：覆盖前记录，覆盖后把补丁打回去。
fn hub_has_byok_patch(asar_path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(asar_path) else {
        return false;
    };
    let mut head16 = [0u8; 16];
    if f.read_exact(&mut head16).is_err() {
        return false;
    }
    let json_size = u32::from_le_bytes(head16[12..16].try_into().unwrap()) as usize;
    if json_size == 0 || json_size > 64 * 1024 * 1024 {
        return false;
    }
    let mut header_bytes = vec![0u8; 16 + json_size];
    if f.seek(SeekFrom::Start(0)).is_err() || f.read_exact(&mut header_bytes).is_err() {
        return false;
    }
    let Ok(header_str) = std::str::from_utf8(&header_bytes[16..]) else {
        return false;
    };
    let Ok(header) = serde_json::from_str::<Value>(header_str) else {
        return false;
    };
    let Some(ls) = header.pointer("/files/dist/files/languageServer.js") else {
        return false;
    };
    let offset: usize = ls
        .get("offset")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let size: usize = ls.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    if size == 0 || size > 256 * 1024 * 1024 {
        return false;
    }
    let declared = u32::from_le_bytes(head16[4..8].try_into().unwrap()) as usize;
    let payload_start = asar_payload_start(declared);
    if f.seek(SeekFrom::Start((payload_start + offset) as u64)).is_err() {
        return false;
    }
    let mut buf = vec![0u8; size];
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    std::str::from_utf8(&buf)
        .map(|c| c.contains("jetski.cloudCodeUrl"))
        .unwrap_or(false)
}

fn restore_hub_asar(asar_path: &Path) -> Result<(), String> {
    // 只从汉化前备份还原。绝不回退到 app.asar.official.bak——那是 BYOK 接入前的
    // 纯净官方版，用它还原会连带抹掉 BYOK 端点补丁，造成接入静默失效。
    let bak_path = asar_path.with_file_name("app.asar.lang.bak");
    if !bak_path.exists() {
        return Err("未找到汉化前备份（可能尚未应用过汉化），无需还原".to_string());
    }
    // 反方向同理：lang.bak 是「汉化前」快照，先汉化后接入时它同样不含 BYOK 补丁。
    // 覆盖前记录接入状态，覆盖后立即把 BYOK 补丁打回去——否则 settings.json 仍指向
    // 本地代理（UI 显示已接入），而 asar 里的端点补丁已被抹掉（实际失效，静默）。
    let byok_present = hub_has_byok_patch(asar_path);
    fs::copy(&bak_path, asar_path).map_err(|e| format!("从备份还原 app.asar 失败: {e}"))?;
    if let Err(e) = fs::remove_file(&bak_path) {
        // 删除失败无实质影响：bak 与刚还原的 asar 同版本，下次 apply 的版本防护仍成立
        eprintln!("[ag-loc] 清理备份失败（忽略）: {e}");
    }
    if byok_present {
        super::platforms::patch_antigravity_hub_asar(asar_path)?;
    }
    Ok(())
}

fn restore_ide_workbench(html_path: &Path, product_json: &Path) -> Result<(), String> {
    let bak_path = html_path.with_file_name("workbench.html.lang.bak");
    if bak_path.exists() {
        let _ = fs::copy(&bak_path, html_path);
        let _ = fs::remove_file(&bak_path);
    } else if let Ok(html) = fs::read_to_string(html_path) {
        let cleaned = html.replace("<script src=\"antigravity-hans-overlay.js\"></script>", "");
        let _ = fs::write(html_path, cleaned.as_bytes());
    }

    let workbench_dir = html_path.parent();
    if let Some(dir) = workbench_dir {
        let overlay = dir.join("antigravity-hans-overlay.js");
        if overlay.exists() {
            let _ = fs::remove_file(overlay);
        }
    }

    let prod_bak = product_json.with_file_name("product.json.lang.bak");
    if prod_bak.exists() {
        let _ = fs::copy(&prod_bak, product_json);
        let _ = fs::remove_file(&prod_bak);
    }
    Ok(())
}

/// 状态查询结果缓存：界面会在页面加载、打开面板、apply/restore 后反复查状态，
/// 每次都读 asar/磁盘太浪费。3 秒 TTL 足够覆盖连续查询，apply/restore 主动失效。
static STATUS_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<(std::time::Instant, AntigravityLocalizationStatus)>>,
> = std::sync::OnceLock::new();
const STATUS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3);

fn invalidate_status_cache() {
    if let Some(m) = STATUS_CACHE.get() {
        if let Ok(mut slot) = m.lock() {
            *slot = None;
        }
    }
}

fn build_antigravity_status(target: &str) -> AntigravityLocalizationStatus {
    let is_ide = target == "antigravity-ide";
    let (installed, localized) = if is_ide {
        if let Some(html) = ide_workbench_html_path() {
            (true, is_ide_localized(&html))
        } else {
            (false, false)
        }
    } else {
        if let Some(asar) = hub_asar_path() {
            (true, is_hub_localized(&asar))
        } else {
            (false, false)
        }
    };

    AntigravityLocalizationStatus {
        target: target.to_string(),
        installed,
        localized,
        current_version: read_cached_version(),
        latest_version: None,
        has_update: false,
        release_name: None,
        release_url: None,
        published_at: None,
        message: None,
    }
}

#[tauri::command]
pub async fn get_antigravity_localization_status(
    target: String,
) -> Result<AntigravityLocalizationStatus, String> {
    // 异步 + spawn_blocking：磁盘读绝不占 Tauri 主线程（否则点按钮观感卡顿）
    tauri::async_runtime::spawn_blocking(move || {
        let cache = STATUS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
        {
            let slot = cache.lock().unwrap();
            if let Some((ts, st)) = slot.as_ref() {
                if ts.elapsed() < STATUS_CACHE_TTL && st.target == target {
                    return Ok(st.clone());
                }
            }
        }
        let st = build_antigravity_status(&target);
        if let Ok(mut slot) = cache.lock() {
            *slot = Some((std::time::Instant::now(), st.clone()));
        }
        Ok(st)
    })
    .await
    .map_err(|e| format!("状态查询任务失败: {}", e))?
}

/// async + spawn_blocking：patch_hub_asar 是重文件 IO（读改写 asar 包），
/// 同步 command 在 Tauri 主线程执行会冻结 UI。
#[tauri::command]
pub async fn apply_antigravity_localization(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_antigravity_localization_sync(target))
        .await
        .map_err(|e| format!("汉化任务执行失败: {e}"))?
}

fn apply_antigravity_localization_sync(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    let _t0 = std::time::Instant::now();
    eprintln!("[ag-loc] apply sync 开始");
    let is_ide = target == "antigravity-ide";
    let plat_name = if is_ide {
        "Antigravity IDE"
    } else {
        "Antigravity"
    };

    if is_ide {
        // IDE 界面汉化已移除：它需要改写 IDE 安装包资源并清空校验和，
        // 官方升级后会失效甚至影响启动，风险高于收益。
        // 还原能力保留（见 restore_antigravity_localization），用于清理历史汉化。
        return Err(
            "Antigravity IDE 的界面汉化功能已移除。如需清理历史汉化，请点击「还原官方英文」"
                .to_string(),
        );
    }

    // 持全局注入锁：BYOK 接入（platforms::apply_antigravity_with_stash）同样会
    // 全量重写这个 app.asar，两边不互斥就是典型 lost update（后写方用旧 bytes
    // 覆盖前一个的补丁）。
    let _guard = super::inject_lock();
    let asar_path = hub_asar_path()
        .ok_or_else(|| "未找到 Antigravity 桌面端安装目录，请先安装该应用".to_string())?;
    patch_hub_asar(&asar_path)?;
    invalidate_status_cache();

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!("{} 汉化已应用成功，重启客户端后生效", plat_name),
        localized: true,
    })
}

/// async + spawn_blocking：restore_hub_asar / restore_ide_workbench 是重文件 IO。
#[tauri::command]
pub async fn restore_antigravity_localization(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_antigravity_localization_sync(target))
        .await
        .map_err(|e| format!("还原任务执行失败: {e}"))?
}

fn restore_antigravity_localization_sync(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    // 持全局注入锁：与汉化 apply、BYOK 接入/还原互斥（同上，app.asar / workbench
    // 都是"全量读改写"，必须串行）。
    let _guard = super::inject_lock();
    let is_ide = target == "antigravity-ide";
    let plat_name = if is_ide {
        "Antigravity IDE"
    } else {
        "Antigravity"
    };

    if is_ide {
        let html_path = ide_workbench_html_path()
            .ok_or_else(|| "未找到 Antigravity IDE 安装目录".to_string())?;
        let product_json = ide_product_json_path()
            .unwrap_or_else(|| html_path.parent().unwrap().join("product.json"));
        restore_ide_workbench(&html_path, &product_json)?;
    } else {
        let asar_path =
            hub_asar_path().ok_or_else(|| "未找到 Antigravity 桌面端安装目录".to_string())?;
        restore_hub_asar(&asar_path)?;
    }
    invalidate_status_cache();

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!("{} 已还原为官方英文原版，重启客户端后生效", plat_name),
        localized: false,
    })
}

#[tauri::command]
pub async fn check_antigravity_localization_update() -> Result<AntigravityLocalizationStatus, String>
{
    // 不再打 api.github.com releases API：未认证限额 60 次/小时按出口 IP 计，
    // Clash 共享节点必被耗尽（实测 HTTP 403）。改为 raw 直下上游 localize.js
    // 后做内容哈希比对——raw 是 CDN 不设限，镜像兜底见 fetch_github_content。
    let content = super::fetch_github_content(UPSTREAM_RAW_URL, 30).await?;
    let remote_sha = super::content_sha256(&content);
    let current = read_cached_version();
    let has_update = read_cached_sha() != remote_sha;

    Ok(AntigravityLocalizationStatus {
        target: "antigravity".to_string(),
        installed: true,
        localized: true,
        current_version: current,
        latest_version: Some(remote_sha[..8.min(remote_sha.len())].to_string()),
        has_update,
        release_name: None,
        release_url: None,
        published_at: None,
        message: None,
    })
}

#[tauri::command]
pub async fn download_antigravity_localization_update(
) -> Result<LocalizationOperationResult, String> {
    // 直接下载 raw（镜像兜底），不再先调 check——那会白下载一次。
    let content = super::fetch_github_content(UPSTREAM_RAW_URL, 60).await?;
    let remote_sha = super::content_sha256(&content);

    let (override_js, count) = extract_dictionary_override(&content).ok_or_else(|| {
        "上游脚本结构变化，未能解析出汉化词典（已保留内置离线词库不受影响）".to_string()
    })?;
    // 写盘前自检：坏覆盖块拼进 preload.js 顶层 = 客户端起不来，宁可拒绝更新
    if !is_safe_dict_override(&override_js) {
        return Err(
            "上游词库覆盖块未通过自检（非预期格式），已保留现有词库不受影响".to_string(),
        );
    }

    fs::write(
        cache_dir().join("antigravity-hub-dict.js"),
        override_js.as_bytes(),
    )
    .map_err(|e| format!("写入热更新词库缓存失败: {e}"))?;
    let meta_json = json!({
        "version": remote_sha[..8.min(remote_sha.len())],
        "sha": remote_sha,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "entries": count
    });
    fs::write(
        cache_dir().join("metadata.json"),
        meta_json.to_string().as_bytes(),
    )
    .map_err(|e| format!("写入词库版本记录失败: {e}"))?;

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!(
            "已同步上游最新汉化词库（{} 条词条），请重新应用汉化生效",
            count
        ),
        localized: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个最小合法 asar：header 声明 dist/preload.js 位于 payload 偏移 0。
    /// 字节布局与 patch_hub_asar 写回的完全一致（pickle 四段 + padding + payload）。
    fn fake_asar(preload_code: &str) -> Vec<u8> {
        let header = serde_json::json!({
            "files": { "dist": { "files": { "preload.js": {
                "size": preload_code.len(),
                "offset": "0",
                "integrity": {
                    "algorithm": "SHA256",
                    "hash": "test",
                    "blockSize": 4194304,
                    "blocks": ["test"]
                }
            }}}}
        });
        let header_json = serde_json::to_string(&header).unwrap();
        let padding = asar_padding_len(header_json.len());
        let mut out = Vec::new();
        out.extend_from_slice(&4u32.to_le_bytes());
        out.extend_from_slice(&((header_json.len() + 8 + padding) as u32).to_le_bytes());
        out.extend_from_slice(&((header_json.len() + 4 + padding) as u32).to_le_bytes());
        out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
        out.extend_from_slice(header_json.as_bytes());
        out.extend(std::iter::repeat(0u8).take(padding));
        out.extend_from_slice(preload_code.as_bytes());
        out
    }

    #[test]
    fn hub_marker_and_payload_stay_in_sync() {
        // 状态判据、去重锚点、备份判定引用 payload 模块的同一常量；
        // payload 改了标记而判据没跟上，必须在这里红（历史事故：三处字面量失配）。
        let payload = crate::commands::antigravity_loc_payload::HUB_PAYLOAD_JS;
        assert!(payload.contains(&format!(
            "window.{} = true",
            crate::commands::antigravity_loc_payload::HUB_PATCH_FLAG
        )));
    }

    #[test]
    fn hub_dict_override_gate() {
        // 覆盖块形态门：合法 JSON 赋值放行，缺分号/截断/形态不对一律拒绝
        assert!(is_safe_dict_override(
            "window.__ANYBRIDGE_HANS_DICT = {\"A\":\"甲\"};"
        ));
        assert!(!is_safe_dict_override(
            "window.__ANYBRIDGE_HANS_DICT = {\"A\":\"甲\"}"
        ));
        assert!(!is_safe_dict_override(
            "window.__ANYBRIDGE_HANS_DICT = {\"A\":\"甲\""
        ));
        assert!(!is_safe_dict_override("const dictionary = {};"));
        assert!(!is_safe_dict_override(""));
    }

    #[test]
    fn hub_patch_idempotent_backup_and_roundtrip() {
        let dir = std::env::temp_dir().join("anybridge-test-hub-asar");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let asar = dir.join("app.asar");

        // 1. 首次汉化：状态判定为已汉化；重复 apply 幂等（文件不再增长）
        fs::write(&asar, fake_asar("console.log('official v1');")).unwrap();
        patch_hub_asar(&asar).expect("首次 apply 应成功");
        assert!(is_hub_localized(&asar), "打完补丁状态必须是已汉化");
        let len_after_first = fs::metadata(&asar).unwrap().len();
        patch_hub_asar(&asar).expect("重复 apply 应成功");
        assert_eq!(
            fs::metadata(&asar).unwrap().len(),
            len_after_first,
            "幂等：内容一致不得重写（旧实现锚点失配导致每次追加、asar 持续膨胀）"
        );

        // 2. 模拟官方升级：asar 变回新版原厂 → apply 必须把备份刷新为新版
        let upgraded = fake_asar("console.log('official v2');");
        fs::write(&asar, &upgraded).unwrap();
        patch_hub_asar(&asar).expect("升级后 apply 应成功");
        let bak = dir.join("app.asar.lang.bak");
        assert_eq!(
            fs::read(&bak).unwrap(),
            upgraded,
            "备份必须刷新为升级后的原厂内容（旧实现永不刷新，还原会把新版覆盖成旧版）"
        );

        // 3. round-trip：还原后 asar 逐字节等于升级后的原厂版
        restore_hub_asar(&asar).expect("还原应成功");
        assert_eq!(fs::read(&asar).unwrap(), upgraded, "还原必须精确回到原厂字节");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hub_patch_without_backup_fails_loud() {
        let dir = std::env::temp_dir().join("anybridge-test-hub-asar-nobak");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let asar = dir.join("app.asar");
        fs::write(&asar, fake_asar("console.log('v');")).unwrap();
        patch_hub_asar(&asar).unwrap();
        fs::remove_file(asar.with_file_name("app.asar.lang.bak")).unwrap();
        let err = patch_hub_asar(&asar).unwrap_err();
        assert!(
            err.contains("备份"),
            "已汉化但缺备份必须报错而不是静默继续（旧实现 let _ = 吞掉备份失败）: {err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
