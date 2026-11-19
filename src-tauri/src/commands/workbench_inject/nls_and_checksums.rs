use std::fs;
use std::path::PathBuf;
use super::{ide_app_dir, product_json_path, workbench_html_path, write_atomic, BACKUP_SUFFIX, BYOK_BLOCK_START, NLS_BACKUP_SUFFIX};
pub(super) fn workbench_main_js_path(target: &str) -> Option<PathBuf> {
    let p = ide_app_dir(target)?.join("out")
        .join("vs")
        .join("workbench")
        .join("workbench.desktop.main.js");
    if p.exists() { Some(p) } else { None }
}

// ---------------------------------------------------------------------------
// NLS 容错加固（防语言包缺词条白屏）
//
// 背景：Devin/Windsurf 的国际化取词函数在语言包缺失词条时会直接
//   throw new Error(`!!! NLS MISSING: ${id} !!!`)
// 导致整个渲染进程崩溃白屏。典型触发场景：用户装了第三方中文包，
// IDE 升级后新增了系统词条，但旧语言包没有对应翻译。
//
// 修复：把 throw 替换为 return ""，缺失时优雅降级为空文本而不是崩溃。
// IDE 升级后 workbench.desktop.main.js 会被覆盖回原厂版本（throw 恢复），
// 下次注入时自动重新加固，无需用户手动干预。
// ---------------------------------------------------------------------------

/// 将 JS 源码中所有 NLS MISSING throw 替换为安全返回。
/// 返回 (新内容, 替换次数)；无匹配返回 None。
pub(super) fn replace_nls_throws(content: &str) -> Option<(String, usize)> {
    const MARKER: &str = "!!! NLS MISSING: ";
    const THROW_PREFIX: &str = "throw new Error(`";
    const THROW_SUFFIX: &str = "`)";

    let mut result = content.to_string();
    let mut count = 0usize;

    loop {
        let marker_pos = match result.find(MARKER) {
            Some(pos) => pos,
            None => break,
        };
        // 从 marker 向前找 throw 语句开头
        let throw_start = match result[..marker_pos].rfind(THROW_PREFIX) {
            Some(pos) => pos,
            None => break,
        };
        // 从 marker 向后找模板闭合反引号 + Error() 闭合括号
        let throw_end = match result[marker_pos..].find(THROW_SUFFIX) {
            Some(pos) => marker_pos + pos + THROW_SUFFIX.len(),
            None => break,
        };
        result = format!("{}return \"\"{}", &result[..throw_start], &result[throw_end..]);
        count += 1;
    }

    if count > 0 { Some((result, count)) } else { None }
}

/// 接入网关时加固 NLS 取词函数（幂等：已修补或无匹配则跳过）。
/// 汉化模块同样调用：装了第三方中文语言包后缺词条会 throw 白屏，这是必要防护。
/// 返回 Ok(true) 表示发生了修改。
pub fn patch_nls_tolerant(target: &str) -> Result<bool, String> {
    let Some(js_path) = workbench_main_js_path(target) else {
        return Ok(false);
    };

    let content = fs::read_to_string(&js_path)
        .map_err(|e| format!("读取 workbench.desktop.main.js 失败: {}", e))?;

    // 已无 NLS MISSING throw → 已修补或该版本不存在此问题
    if !content.contains("!!! NLS MISSING: ") {
        return Ok(false);
    }

    // 备份原厂文件：走到这里 content 必含 NLS MISSING throw（原厂态），总是刷新备份，
    // 确保备份与当前安装版本严格一致。IDE 升级会覆盖 main.js 但不会删旧备份，
    // 若只写一次，停止接入时会把旧版本文件还原回去，造成 workbench 新旧版本错配。
    let backup = PathBuf::from(format!("{}{}", js_path.to_string_lossy(), NLS_BACKUP_SUFFIX));
    fs::write(&backup, &content)
        .map_err(|e| format!("备份 workbench.desktop.main.js 失败: {}", e))?;

    let Some((patched, _count)) = replace_nls_throws(&content) else {
        return Ok(false);
    };

    write_atomic(&js_path, &patched)
        .map_err(|e| format!("写入 workbench.desktop.main.js 失败: {}", e))?;
    Ok(true)
}

/// 还原直连时还原 NLS 原厂文件（有备份才还原，否则跳过）。
/// 版本防护：IDE 升级会把 main.js 覆盖回新版原厂，此时旧备份不能往回覆盖，
/// 否则新旧文件版本错配（可能引发前端异常降级，如误入屏幕阅读器模式）。
/// 汉化 restore 同样调用（审计：NLS 加固残留，还原英文后应回到原厂）。
pub fn restore_nls(target: &str) -> Result<bool, String> {
    let Some(js_path) = workbench_main_js_path(target) else {
        return Ok(false);
    };
    let backup = PathBuf::from(format!("{}{}", js_path.to_string_lossy(), NLS_BACKUP_SUFFIX));
    if !backup.exists() {
        return Ok(false);
    }

    // 防护 1：当前 main.js 仍含 NLS MISSING throw = 原厂态（未被我们 patch，
    // 常见于 IDE 升级覆盖后），无需还原；备份必属旧版本，直接淘汰。
    let current = fs::read_to_string(&js_path).map_err(|e| e.to_string())?;
    if current.contains("!!! NLS MISSING: ") {
        let _ = fs::remove_file(&backup);
        return Ok(false);
    }
    // 防护 2：当前 workbench.html 已无注入块 = IDE 升级后的原生状态。
    // html 与 main.js 同属 resources/app，升级必然同时覆盖，此时 NLS 备份
    // 即使内容上"看起来已 patch"，也极可能是旧版本残留，一并淘汰跳过。
    if let Some(html_path) = workbench_html_path(target) {
        if let Ok(html) = fs::read_to_string(&html_path) {
            if !html.contains(BYOK_BLOCK_START) {
                let _ = fs::remove_file(&backup);
                return Ok(false);
            }
        }
    }

    let orig = fs::read_to_string(&backup)
        .map_err(|e| format!("读取 NLS 备份失败: {}", e))?;
    write_atomic(&js_path, &orig)
        .map_err(|e| format!("还原 workbench.desktop.main.js 失败: {}", e))?;
    let _ = fs::remove_file(&backup);
    Ok(true)
}

// ---------------------------------------------------------------------------
// VS Code 完整性校验（Integrity Check）
//
// workbench 启动时会按 product.json 的 checksums 清单逐一校验核心文件
// （workbench.html、workbench.desktop.main.js、sessions.* 等）的 SHA-256。
// 这些文件被改写（byok 注入、汉化插件）后哈希必然对不上，IDE 就会弹
// "Your xxx installation appears to be corrupt. Please reinstall."。
// 官方没配 checksumFailMoreInfoUrl，提示走的是纯 notify 分支，连"不再提示"
// 按钮都没有，每次启动都会弹。
//
// 解法：清空 checksums 清单。workbench 的 _isPure() 拿到空清单时循环 0 次，
// 直接判定 isPure=true，提示从源头消失，且不改动任何核心文件内容。
// ---------------------------------------------------------------------------

/// 在根对象（depth == 1）里定位 "checksums" 键的值对象，返回其字节区间 [start, end)。
/// 手工扫描字符流而非用正则：能正确处理转义，也不会误匹配嵌套对象或字符串内容。
pub(super) fn find_checksums_object(content: &str) -> Option<(usize, usize)> {
    let bytes = content.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i] != b'{' {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }

    let mut depth = 1i32;
    i += 1;

    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return None;
                }
            }
            b'"' => {
                let str_start = i;
                i = skip_string(bytes, i);
                if depth != 1 || &content[str_start..i] != "\"checksums\"" {
                    continue;
                }
                // 区分"键"与"值"：键后面紧跟 ':'（可含空白），值后面是 ',' 或 '}'。
                // 顶层某个值恰好是字符串 "checksums" 时不能当成键。
                let mut j = i;
                while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                    j += 1;
                }
                if j >= bytes.len() || bytes[j] != b':' {
                    continue;
                }
                // 跳过 ':' 与空白，定位值的起始花括号
                i = j + 1;
                while i < bytes.len() && (bytes[i] as char).is_whitespace() {
                    i += 1;
                }
                if i >= bytes.len() || bytes[i] != b'{' {
                    return None;
                }
                // 括号匹配，找到该对象的结束位置
                let obj_start = i;
                let mut d = 0i32;
                while i < bytes.len() {
                    match bytes[i] {
                        b'"' => i = skip_string(bytes, i),
                        b'{' => {
                            d += 1;
                            i += 1;
                        }
                        b'}' => {
                            d -= 1;
                            i += 1;
                            if d == 0 {
                                return Some((obj_start, i));
                            }
                        }
                        _ => i += 1,
                    }
                }
                return None;
            }
            _ => i += 1,
        }
    }
    None
}

/// 从字符串起始引号处跳到结束引号之后（处理 \\ 转义）。
pub(super) fn skip_string(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return i + 1;
        }
        i += 1;
    }
    i
}

/// 清空 product.json 的 checksums 清单，消除 IDE 的"安装似乎损坏"提示。
/// 首次改动前把原厂文件备份为 product.json.byok-origin（幂等，不覆盖已有备份）。
/// 返回 Ok(true) 表示发生了写入；Ok(false) 表示已是清空状态或无需处理。
pub fn clear_product_checksums(target: &str) -> Result<bool, String> {
    let Some(path) = product_json_path(target) else {
        return Ok(false);
    };

    let content = fs::read_to_string(&path).map_err(|e| format!("读取 product.json 失败: {}", e))?;
    let Some((start, end)) = find_checksums_object(&content) else {
        return Ok(false);
    };
    if content[start..end].trim() == "{}" {
        return Ok(false);
    }

    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));
    // 只要当前 product.json 包含未清空的真实校验清单，就更新原厂备份，确保备份与当前 IDE 升级后的版本严格一致。
    fs::write(&backup, &content).map_err(|e| format!("备份 product.json 失败: {}", e))?;

    let mut patched = String::with_capacity(content.len());
    patched.push_str(&content[..start]);
    patched.push_str("{}");
    patched.push_str(&content[end..]);
    write_atomic(&path, &patched).map_err(|e| format!("写入 product.json 失败: {}", e))?;
    Ok(true)
}

/// 还原 product.json：用备份整体覆盖，恢复 IDE 自带的完整性校验清单。
/// 幂等：无备份且 checksums 已是原厂状态时返回 Ok(false)。
pub fn restore_product_json(target: &str) -> Result<bool, String> {
    let Some(path) = product_json_path(target) else {
        return Ok(false);
    };
    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));

    if backup.exists() {
        // 版本防护：当前 checksums 已是原厂非空状态（IDE 升级覆盖回原厂），
        // 说明清单并未被我们清空，无需还原；备份必属旧版本，直接淘汰，
        // 避免把旧版本 product.json（含旧版路径/版本号）覆盖到新版安装上。
        let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let current_patched = match find_checksums_object(&current) {
            Some((start, end)) => current[start..end].trim() == "{}",
            None => false,
        };
        if !current_patched {
            let _ = fs::remove_file(&backup);
            return Ok(false);
        }
        let orig = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
        write_atomic(&path, &orig).map_err(|e| format!("还原 product.json 失败: {}", e))?;
        let _ = fs::remove_file(&backup);
        return Ok(true);
    }

    // 无备份却留着清空痕迹：备份被外部清掉了，这里无从得知原厂哈希，如实上报而不是假装还原成功。
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match find_checksums_object(&content) {
        Some((start, end)) if content[start..end].trim() == "{}" => Err(
            "product.json 备份丢失，无法还原原厂完整性校验清单，重装 IDE 可恢复".into(),
        ),
        _ => Ok(false),
    }
}

