use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use super::{asar_padding_len, asar_payload_start, cache_dir};
pub(crate) fn get_hub_payload() -> String {
    // 热更新层：上游词典覆盖块（若存在且通过自检）先于引擎赋值
    // window.__ANYBRIDGE_HANS_DICT，引擎 IIFE 启动时把它合并进内置 phrases。
    // 旧版/被改坏的缓存直接弃用——preload.js 顶层多一个语法错误 = 客户端起不来。
    // 首行必须是 HUB_PATCH_HEADER：去重截断靠它定位补丁块起点。
    let cached = cache_dir().join("antigravity-hub-dict.js");
    let override_line = fs::read_to_string(&cached)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && is_safe_dict_override(s));

    let mut out = String::from(crate::commands::antigravity_loc_payload::HUB_PATCH_HEADER);
    out.push('\n');
    if let Some(line) = override_line {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(crate::commands::antigravity_loc_payload::HUB_PAYLOAD_JS);
    out
}

/// 覆盖块读时自检：必须是 `window.__ANYBRIDGE_HANS_DICT = {JSON};` 形态。
///
/// 提取端（extract_dictionary_override）用 serde_json 重新序列化，正常必然通过；
/// 这里拦的是历史遗留缓存、手工改动与截断损坏。历史事故：坏块从未被 payload
/// 消费时只是热更新无效，拼进 preload.js 顶层后就是客户端无法启动。
pub(crate) fn is_safe_dict_override(s: &str) -> bool {
    let dict_global = format!("window.{}", crate::commands::antigravity_loc_payload::HUB_DICT_GLOBAL);
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
pub(crate) fn unescape_js(raw: &str) -> String {
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
pub(crate) fn extract_dictionary_override(source: &str) -> Option<(String, usize)> {
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
pub(crate) fn is_hub_localized(asar_path: &Path) -> bool {
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
    code.contains(crate::commands::antigravity_loc_payload::HUB_PATCH_FLAG)
        || code.contains("__antigravityHansInjected")
        || code.contains("Antigravity 2.0 Chinese Localization Engine")
}

pub(crate) fn is_ide_localized(html_path: &Path) -> bool {
    if let Ok(content) = fs::read_to_string(html_path) {
        return content.contains("antigravity-hans-overlay.js")
            || content.contains("__antigravityIdeHansInjected");
    }
    false
}

pub(crate) fn patch_hub_asar(asar_path: &Path) -> Result<(), String> {
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
    let patched = original_code.contains(crate::commands::antigravity_loc_payload::HUB_PATCH_FLAG);
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
        crate::commands::antigravity_loc_payload::HUB_PATCH_HEADER,
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

    crate::commands::write_atomic(asar_path, &final_bytes)
        .map_err(|e| format!("写入汉化补丁失败（请先关闭 Antigravity 客户端后重试）: {e}"))?;
    Ok(())
}

/// 当前 asar 是否已含 BYOK 端点补丁（端点节点里有 jetski.cloudCodeUrl）。
/// 2.32.1 起注入点在 dist/lsDefaults.js，旧版在 dist/languageServer.js，
/// 与 patch_antigravity_hub_asar 共用同一份节点选择规则。
/// 用途见 restore_hub_asar：覆盖前记录，覆盖后把补丁打回去。
pub(crate) fn hub_has_byok_patch(asar_path: &Path) -> bool {
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
    let Some(node_name) = crate::commands::platforms::hub_endpoint_node_name(&header) else {
        return false;
    };
    let Some(ls) = header.pointer(&format!("/files/dist/files/{node_name}")) else {
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

pub(crate) fn restore_hub_asar(asar_path: &Path) -> Result<(), String> {
    // 只从汉化前备份还原。绝不回退到 app.asar.official.bak——那是 BYOK 接入前的
    // 纯净官方版，用它还原会连带抹掉 BYOK 端点补丁，造成接入静默失效。
    let bak_path = asar_path.with_file_name("app.asar.lang.bak");
    if !bak_path.exists() {
        return Err("未找到汉化前备份（可能尚未应用过汉化），无需还原".to_string());
    }
    // 反方向同理：lang.bak 是「汉化前」快照，先汉化后接入时它同样不含 BYOK 补丁。
    // 覆盖前记录接入状态，覆盖后立即把 BYOK 补丁打回去——否则 settings.json 仍指向
    // 本地网关（UI 显示已接入），而 asar 里的端点补丁已被抹掉（实际失效，静默）。
    let byok_present = hub_has_byok_patch(asar_path);
    fs::copy(&bak_path, asar_path).map_err(|e| format!("从备份还原 app.asar 失败: {e}"))?;
    if let Err(e) = fs::remove_file(&bak_path) {
        // 删除失败无实质影响：bak 与刚还原的 asar 同版本，下次 apply 的版本防护仍成立
        eprintln!("[ag-loc] 清理备份失败（忽略）: {e}");
    }
    if byok_present {
        crate::commands::platforms::patch_antigravity_hub_asar(asar_path)?;
    }
    Ok(())
}

