// antigravity_localization.rs — Antigravity 独立桌面端与 IDE 双端深度汉化及热更新管理器
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const CURRENT_EMBEDDED_VERSION: &str = "2.18.1";
const GITHUB_REPO_API: &str =
    "https://api.github.com/repos/liominsb/Antigravity-Chinese-Localization/releases/latest";

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

fn get_hub_payload() -> String {
    // 热更新层：上游词典覆盖块（若存在）优先于内置基线词典合并生效
    let cached = cache_dir().join("antigravity-hub-dict.js");
    if let Ok(override_block) = fs::read_to_string(&cached) {
        if !override_block.trim().is_empty() {
            return format!(
                "{}\n{}",
                override_block.trim(),
                super::antigravity_loc_payload::HUB_LOCALIZATION_JS
            );
        }
    }
    super::antigravity_loc_payload::HUB_LOCALIZATION_JS.to_string()
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

fn is_hub_localized(asar_path: &Path) -> bool {
    let Ok(bytes) = fs::read(asar_path) else {
        return false;
    };
    if bytes.len() < 16 {
        return false;
    }
    let json_size = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if bytes.len() < 16 + json_size {
        return false;
    }
    let Ok(header_str) = std::str::from_utf8(&bytes[16..16 + json_size]) else {
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
    let declared_header_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let payload_start = asar_payload_start(declared_header_size);
    if bytes.len() < payload_start + offset + size {
        return false;
    }

    let Ok(code) =
        std::str::from_utf8(&bytes[payload_start + offset..payload_start + offset + size])
    else {
        return false;
    };
    code.contains("__antigravityHansInjected")
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
    let bytes = fs::read(asar_path).map_err(|e| format!("读取 app.asar 失败: {e}"))?;
    if bytes.len() < 16 {
        return Err("app.asar 文件大小异常".to_string());
    }
    let json_size = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
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

    let offset: usize = preload_node
        .get("offset")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let size: usize = preload_node
        .get("size")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let declared_header_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let payload_start = asar_payload_start(declared_header_size);
    if bytes.len() < payload_start + offset + size {
        return Err("app.asar payload 越界".to_string());
    }

    let original_code =
        std::str::from_utf8(&bytes[payload_start + offset..payload_start + offset + size])
            .map_err(|e| format!("解析 preload.js 失败: {e}"))?;

    // 保留初次纯净原版备份
    let bak_path = asar_path.with_file_name("app.asar.lang.bak");
    if !bak_path.exists() && !original_code.contains("__antigravityHansInjected") {
        let _ = fs::copy(asar_path, &bak_path);
    }

    // 截断旧汉化块并追加新汉化代码
    let clean_base = if let Some(idx) =
        original_code.find("// Antigravity Chinese Localization Engine")
    {
        original_code[..idx].trim_end()
    } else if let Some(idx) = original_code.find("// Antigravity 2.0 Chinese Localization Engine") {
        original_code[..idx].trim_end()
    } else {
        original_code
    };

    let new_code = format!("{}\n\n{}\n", clean_base, get_hub_payload().trim());
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

fn restore_hub_asar(asar_path: &Path) -> Result<(), String> {
    // 只从汉化前备份还原。绝不回退到 app.asar.official.bak——那是 BYOK 接入前的
    // 纯净官方版，用它还原会连带抹掉 BYOK 端点补丁，造成接入静默失效。
    let bak_path = asar_path.with_file_name("app.asar.lang.bak");
    if !bak_path.exists() {
        return Err("未找到汉化前备份（可能尚未应用过汉化），无需还原".to_string());
    }
    fs::copy(&bak_path, asar_path).map_err(|e| format!("从备份还原 app.asar 失败: {e}"))?;
    let _ = fs::remove_file(&bak_path);
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

#[tauri::command]
pub fn get_antigravity_localization_status(target: String) -> AntigravityLocalizationStatus {
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
        target,
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
pub fn apply_antigravity_localization(
    target: String,
) -> Result<LocalizationOperationResult, String> {
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

    let asar_path = hub_asar_path()
        .ok_or_else(|| "未找到 Antigravity 桌面端安装目录，请先安装该应用".to_string())?;
    patch_hub_asar(&asar_path)?;

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!("{} 汉化补丁已应用成功，重启客户端后生效", plat_name),
        localized: true,
    })
}

#[tauri::command]
pub fn restore_antigravity_localization(
    target: String,
) -> Result<LocalizationOperationResult, String> {
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

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!("{} 已还原为官方英文原版，重启客户端后生效", plat_name),
        localized: false,
    })
}

#[tauri::command]
pub async fn check_antigravity_localization_update() -> Result<AntigravityLocalizationStatus, String>
{
    let client = reqwest::Client::builder()
        .user_agent("AnyBridge-Desktop-Client")
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(GITHUB_REPO_API)
        .send()
        .await
        .map_err(|e| format!("检查在线汉化更新失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 响应异常: HTTP {}", resp.status()));
    }

    let val = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    let tag = val
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let clean_tag = tag.trim_start_matches(|c| c == 'v' || c == 'V').to_string();
    let current = read_cached_version();
    let has_update = !clean_tag.is_empty() && clean_tag != current;

    Ok(AntigravityLocalizationStatus {
        target: "antigravity".to_string(),
        installed: true,
        localized: true,
        current_version: current,
        latest_version: Some(clean_tag),
        has_update,
        release_name: val
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        release_url: val
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        published_at: val
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        message: None,
    })
}

#[tauri::command]
pub async fn download_antigravity_localization_update(
) -> Result<LocalizationOperationResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("AnyBridge-Desktop-Client")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let check = check_antigravity_localization_update().await?;
    let latest_ver = check
        .latest_version
        .unwrap_or_else(|| CURRENT_EMBEDDED_VERSION.to_string());

    let script_url = "https://raw.githubusercontent.com/liominsb/Antigravity-Chinese-Localization/master/localize.js";
    let resp = client
        .get(script_url)
        .send()
        .await
        .map_err(|e| format!("下载上游汉化脚本失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载上游汉化脚本失败: HTTP {}", resp.status()));
    }
    let code = resp
        .text()
        .await
        .map_err(|e| format!("读取上游汉化脚本失败: {e}"))?;

    let (override_js, count) = extract_dictionary_override(&code).ok_or_else(|| {
        "上游脚本结构变化，未能解析出汉化词典（已保留内置离线词库不受影响）".to_string()
    })?;

    fs::write(
        cache_dir().join("antigravity-hub-dict.js"),
        override_js.as_bytes(),
    )
    .map_err(|e| format!("写入热更新词库缓存失败: {e}"))?;
    let meta_json = json!({
        "version": latest_ver,
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
            "已同步上游最新汉化词库 v{}（{} 条词条），请重新应用汉化生效",
            latest_ver, count
        ),
        localized: true,
    })
}
