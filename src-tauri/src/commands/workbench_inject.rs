// workbench_inject.rs — 向 Windsurf 的 workbench.html 注入独立前端脚本（byok-cards.js）。
//
// 目的：在模型选择面板的卡片上做纯视觉改写（去标题后缀、隐藏推理档位区）。
// 这是前端 DOM 层的事，MITM 改 protobuf 做不到，所以走 workbench.html 注入。
//
// 与汉化插件（windsurf-pool / ws-better）完全隔离：
//   - 备份后缀用 .byok-origin（汉化插件用 .origin，互不覆盖）
//   - 注入块用独立标记 BYOK_BLOCK_START/END，清理时只动自己的块
//   - 只改文本 / 隐藏元素，不用 innerHTML，故无需放宽 Trusted-Types
//
// 注入时机：跟随 IDE 切换到代理；还原直连时还原。需要写 Windsurf 安装目录
// （通常在 Program Files / LocalAppData），可能需要管理员权限。

use std::fs;
use std::path::PathBuf;

const BYOK_BLOCK_START: &str = "<!-- byok-cards-start -->";
const BYOK_BLOCK_END: &str = "<!-- byok-cards-end -->";
const BYOK_VERSION_MARKER: &str = "<!-- byok-cards-v1 -->";
const BACKUP_SUFFIX: &str = ".byok-origin";
const NLS_BACKUP_SUFFIX: &str = ".byok-nls-origin";

/// 原子写：同目录临时文件 + rename，避免写 workbench.html 中途崩溃留下截断 HTML。
/// Windows 上 rename 可能因文件锁失败，重试 3 次。
fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.byok-tmp", path.to_string_lossy()));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    let mut last_err = String::new();
    for i in 0..3u32 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if i < 2 { std::thread::sleep(std::time::Duration::from_millis(50)); }
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(last_err)
}

/// 推导 IDE 的 resources\app（macOS: Contents/Resources/app）目录。
/// workbench.html 和 product.json 都在这个目录下，所以路径推导只做一次。
pub(crate) fn ide_app_dir(target: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // exe 在 <root>\Windsurf.exe 或 <root>\Devin.exe，资源在 <root>\resources\app
        let exe = crate::commands::system::find_ide_exe(target)?;
        let roots = [
            exe.parent().map(|p| p.join("resources").join("app")),
            // 部分布局把 exe 放在 bin\ 下
            exe.parent()
                .and_then(|p| p.parent())
                .map(|p| p.join("resources").join("app")),
        ];
        for root in roots.into_iter().flatten() {
            if root.is_dir() {
                return Some(root);
            }
        }
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        // <Windsurf.app>/Contents/Resources/app 或 <Devin.app>/Contents/Resources/app
        let app = crate::commands::system::find_ide_app(target)?;
        let p = app.join("Contents").join("Resources").join("app");
        return if p.is_dir() { Some(p) } else { None };
    }

    #[cfg(target_os = "linux")]
    {
        // bin 可能是 /usr/bin/windsurf 软链，不能只用 parent() 推 resources。
        let bin = crate::commands::system::find_ide_bin(target)?;
        let mut roots = Vec::new();

        let resolved = std::fs::canonicalize(&bin).unwrap_or_else(|_| bin.clone());
        if let Some(parent) = resolved.parent() {
            roots.push(parent.join("resources").join("app"));
            // .../bin/windsurf → .../resources/app
            if parent
                .file_name()
                .map(|n| n.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
            {
                if let Some(grand) = parent.parent() {
                    roots.push(grand.join("resources").join("app"));
                }
            }
        }
        if let Some(parent) = bin.parent() {
            roots.push(parent.join("resources").join("app"));
        }

        // 常见 deb/rpm 安装布局
        let dir_name = match target {
            "devin" => "Devin",
            "cursor" => "Cursor",
            _ => "Windsurf",
        };
        let lower = dir_name.to_lowercase();
        roots.push(PathBuf::from(format!(
            "/usr/share/{}/resources/app",
            lower
        )));
        roots.push(PathBuf::from(format!("/opt/{}/resources/app", dir_name)));
        roots.push(PathBuf::from(format!(
            "/opt/{}/resources/app",
            lower
        )));

        for root in roots {
            if root.is_dir() {
                return Some(root);
            }
        }
        return None;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = target;
        None
    }
}

/// 从 IDE 可执行文件路径推出 workbench.html 路径。
pub(crate) fn workbench_html_path(target: &str) -> Option<PathBuf> {
    let p = ide_app_dir(target)?.join(PathBuf::from("out")
        .join("vs")
        .join("code")
        .join("electron-browser")
        .join("workbench")
        .join("workbench.html"));
    if p.exists() { Some(p) } else { None }
}

/// IDE 的 product.json（存放 VS Code 完整性校验 checksums 的清单）。
pub(crate) fn product_json_path(target: &str) -> Option<PathBuf> {
    let p = ide_app_dir(target)?.join("product.json");
    if p.exists() { Some(p) } else { None }
}

/// workbench.desktop.main.js 路径（NLS 取词函数所在的主 bundle）。
fn workbench_main_js_path(target: &str) -> Option<PathBuf> {
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
fn replace_nls_throws(content: &str) -> Option<(String, usize)> {
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

/// 接入代理时加固 NLS 取词函数（幂等：已修补或无匹配则跳过）。
/// 返回 Ok(true) 表示发生了修改。
fn patch_nls_tolerant(target: &str) -> Result<bool, String> {
    let Some(js_path) = workbench_main_js_path(target) else {
        return Ok(false);
    };

    let content = fs::read_to_string(&js_path)
        .map_err(|e| format!("读取 workbench.desktop.main.js 失败: {}", e))?;

    // 已无 NLS MISSING throw → 已修补或该版本不存在此问题
    if !content.contains("!!! NLS MISSING: ") {
        return Ok(false);
    }

    // 备份原厂文件（幂等：仅首次写入，后续 IDE 升级由 inject_workbench_html
    // 的同名逻辑刷新 workbench.html 备份，此处同理只在原厂状态下备份）
    let backup = PathBuf::from(format!("{}{}", js_path.to_string_lossy(), NLS_BACKUP_SUFFIX));
    if !backup.exists() {
        fs::write(&backup, &content)
            .map_err(|e| format!("备份 workbench.desktop.main.js 失败: {}", e))?;
    }

    let Some((patched, count)) = replace_nls_throws(&content) else {
        return Ok(false);
    };

    write_atomic(&js_path, &patched)
        .map_err(|e| format!("写入 workbench.desktop.main.js 失败: {}", e))?;
    Ok(true)
}

/// 还原直连时还原 NLS 原厂文件（有备份才还原，否则跳过）。
fn restore_nls(target: &str) -> Result<bool, String> {
    let Some(js_path) = workbench_main_js_path(target) else {
        return Ok(false);
    };
    let backup = PathBuf::from(format!("{}{}", js_path.to_string_lossy(), NLS_BACKUP_SUFFIX));
    if !backup.exists() {
        return Ok(false);
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
fn find_checksums_object(content: &str) -> Option<(usize, usize)> {
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
fn skip_string(bytes: &[u8], start: usize) -> usize {
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
pub(crate) fn clear_product_checksums(target: &str) -> Result<bool, String> {
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
pub(crate) fn restore_product_json(target: &str) -> Result<bool, String> {
    let Some(path) = product_json_path(target) else {
        return Ok(false);
    };
    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));

    if backup.exists() {
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

/// 在 CSP 的 script-src 指令里补上 'unsafe-inline'，让注入的 inline <script> 能执行。
/// 已有则原样返回。只动 script-src，不碰其它指令。
fn ensure_csp_unsafe_inline(html: &str) -> String {
    // 找 "script-src" 后面到下一个 ';' 之间的内容，若没有 'unsafe-inline' 就插入。
    let Some(idx) = html.find("script-src") else {
        return html.to_string();
    };
    let after = &html[idx..];
    let Some(semi_rel) = after.find(';') else {
        return html.to_string();
    };
    let directive = &after[..semi_rel];
    if directive.contains("'unsafe-inline'") {
        return html.to_string();
    }
    // 在 "script-src" 紧后插入 'unsafe-inline'
    let insert_at = idx + "script-src".len();
    let mut out = String::with_capacity(html.len() + 20);
    out.push_str(&html[..insert_at]);
    out.push_str("\n\t\t\t\t\t'unsafe-inline'");
    out.push_str(&html[insert_at..]);
    out
}

/// 移除已存在的 byok 注入块（幂等重注入用）。
fn strip_byok_block(html: &str) -> String {
    let (Some(s), Some(e)) = (html.find(BYOK_BLOCK_START), html.find(BYOK_BLOCK_END)) else {
        return html.to_string();
    };
    let end = e + BYOK_BLOCK_END.len();
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..s]);
    out.push_str(&html[end..]);
    out
}

/// 接入代理时接管 IDE：注入 byok-cards.js，清空 product.json 的完整性校验清单，
/// 并加固 NLS 取词函数防止语言包缺词条白屏。
/// 返回 Ok(true) 表示发生了写入（需重启 IDE 生效）；Ok(false) 表示已是最新无需改动。
pub fn inject(script: &str, target: &str) -> Result<bool, String> {
    let html_changed = inject_workbench_html(script, target)?;
    // 即便 HTML 本次没变（已注入过），也要确保校验清单是清空状态：
    // 用户或 IDE 更新把它写回原厂值后，"安装损坏"提示会重新弹出。
    let product_changed = clear_product_checksums(target)?;
    // NLS 容错加固：IDE 升级后 workbench.desktop.main.js 被覆盖回原厂（throw 恢复），
    // 每次注入时自动重新检测并修补，确保所有 AnyBridge 用户都不会因语言包缺词条白屏。
    let nls_changed = patch_nls_tolerant(target)?;
    Ok(html_changed || product_changed || nls_changed)
}

/// 向 workbench.html 注入脚本。
/// 返回 Ok(true) 表示发生了写入；Ok(false) 表示已是最新无需改动。
fn inject_workbench_html(script: &str, target: &str) -> Result<bool, String> {
    let Some(path) = workbench_html_path(target) else {
        return Err(format!(
            "未定位到 {} 的 workbench.html（可能装在非默认目录且未运行）。\
             请启动 {} 后重试，或在设置页手动指定路径",
            target, target
        ));
    };

    let html = fs::read_to_string(&path).map_err(|e| format!("读取 workbench.html 失败: {}", e))?;

    // 已注入且版本一致 → 跳过。
    if html.contains(BYOK_VERSION_MARKER) {
        return Ok(false);
    }

    // 走到这里说明当前 html 是未注入的（新装或 IDE 更新后的原厂文件），
    // 直接刷新备份，确保备份始终对应当前安装的原厂版本。
    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));
    fs::write(&backup, &html).map_err(|e| format!("备份 workbench.html 失败: {}", e))?;

    let mut new_html = strip_byok_block(&html);
    new_html = ensure_csp_unsafe_inline(&new_html);

    let injection = format!(
        "\n{start}\n{ver}\n<script>\n{script}\n</script>\n{end}\n",
        start = BYOK_BLOCK_START,
        ver = BYOK_VERSION_MARKER,
        script = script,
        end = BYOK_BLOCK_END,
    );

    let Some(body_idx) = new_html.rfind("</body>") else {
        return Err("workbench.html 缺少 </body>".into());
    };
    new_html.insert_str(body_idx, &injection);

    write_atomic(&path, &new_html).map_err(|e| format!("写入 workbench.html 失败: {}", e))?;
    Ok(true)
}

/// 还原直连时还原 IDE：恢复 workbench.html、product.json 的完整性校验清单和 NLS 原厂文件。
/// 幂等：无注入痕迹时返回 Ok(false)。
pub fn restore(target: &str) -> Result<bool, String> {
    // 三个文件都要还原，任一失败都不影响另一个执行，
    // 否则会留下"文件已还原但校验清单仍为空"的半截状态。
    let product_result = restore_product_json(target);
    let html_result = restore_workbench_html(target);
    let nls_result = restore_nls(target);

    let mut changed = false;
    let mut errors: Vec<String> = Vec::new();
    match product_result {
        Ok(v) => changed |= v,
        Err(e) => errors.push(e),
    }
    match html_result {
        Ok(v) => changed |= v,
        Err(e) => errors.push(e),
    }
    match nls_result {
        Ok(v) => changed |= v,
        Err(e) => errors.push(e),
    }
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    Ok(changed)
}

/// 还原 workbench.html：优先用备份整体覆盖，否则仅剥离 byok 块。
/// 幂等：无注入痕迹时返回 Ok(false)。
fn restore_workbench_html(target: &str) -> Result<bool, String> {
    let Some(path) = workbench_html_path(target) else {
        return Ok(false);
    };
    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));

    if backup.exists() {
        let orig = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
        write_atomic(&path, &orig).map_err(|e| format!("还原 workbench.html 失败: {}", e))?;
        let _ = fs::remove_file(&backup);
        return Ok(true);
    }

    // 无备份：尝试只剥离自己的块（兜底，不动其它注入）。
    let html = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if !html.contains(BYOK_BLOCK_START) {
        return Ok(false);
    }
    let cleaned = strip_byok_block(&html);
    write_atomic(&path, &cleaned).map_err(|e| format!("清理 workbench.html 失败: {}", e))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把定位到的 checksums 对象替换成 {}，返回处理后的完整内容。
    fn cleared(content: &str) -> Option<String> {
        let (s, e) = find_checksums_object(content)?;
        Some(format!("{}{{}}{}", &content[..s], &content[e..]))
    }

    #[test]
    fn locates_top_level_checksums() {
        let content = r#"{"nameShort":"Devin","checksums":{"vs/a.js":"h1","vs/b.js":"h2"},"version":"1.0"}"#;
        let (s, e) = find_checksums_object(content).expect("应定位到顶层 checksums");
        assert_eq!(&content[s..e], r#"{"vs/a.js":"h1","vs/b.js":"h2"}"#);

        let out = cleared(content).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["checksums"], serde_json::json!({}));
        assert_eq!(v["nameShort"], "Devin");
        assert_eq!(v["version"], "1.0");
    }

    #[test]
    fn ignores_nested_checksums() {
        let content = r#"{"nested":{"checksums":{"x":"inner"}},"checksums":{"vs/a.js":"outer"}}"#;
        let (s, e) = find_checksums_object(content).unwrap();
        assert_eq!(&content[s..e], r#"{"vs/a.js":"outer"}"#);
    }

    #[test]
    fn string_value_named_checksums_is_not_a_key() {
        // 顶层某个值恰好是字符串 "checksums" 时，不能被当成键，否则会误清空下一个对象。
        let content = r#"{"tip":"checksums","other":{"checksums":{"x":"inner"}}}"#;
        assert!(find_checksums_object(content).is_none());
    }

    #[test]
    fn returns_none_without_checksums_object() {
        assert!(find_checksums_object(r#"{"checksums":null}"#).is_none());
        assert!(find_checksums_object(r#"{"nameShort":"Devin"}"#).is_none());
        assert!(find_checksums_object("not json at all").is_none());
    }

    #[test]
    fn handles_escapes_and_braces_in_values() {
        let content = r#"{"note":"he said \"{}\" ok","checksums":{"vs/a.js":"h"}}"#;
        let (s, e) = find_checksums_object(content).unwrap();
        assert_eq!(&content[s..e], r#"{"vs/a.js":"h"}"#);

        let out = cleared(content).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["note"], "he said \"{}\" ok");
    }

    // ── NLS 容错加固 ──────────────────────────────────────────

    #[test]
    fn replaces_single_nls_throw() {
        let content = r#"function lAo(r,i){let e=tit()?.[r];if(typeof e!="string"){if(typeof i=="string")return i;throw new Error(`!!! NLS MISSING: ${r} !!!`)}return e}"#;
        let (out, count) = replace_nls_throws(content).expect("应替换成功");
        assert_eq!(count, 1);
        assert!(!out.contains("NLS MISSING"), "替换后不应残留 NLS MISSING");
        assert!(out.contains("return \"\""), "应包含 return \"\"");
        // 函数其余部分不变
        assert!(out.contains("function lAo(r,i)"));
        assert!(out.contains("return e}"));
    }

    #[test]
    fn replaces_multiple_nls_throws() {
        let content = "a throw new Error(`!!! NLS MISSING: ${x} !!!`) b throw new Error(`!!! NLS MISSING: ${y} !!!`) c";
        let (out, count) = replace_nls_throws(content).expect("应替换成功");
        assert_eq!(count, 2);
        assert_eq!(out.matches("NLS MISSING").count(), 0);
        assert_eq!(out.matches("return \"\"").count(), 2);
    }

    #[test]
    fn returns_none_when_no_nls_throw() {
        assert!(replace_nls_throws("no nls here").is_none());
        assert!(replace_nls_throws("").is_none());
    }

    #[test]
    fn idempotent_after_patch() {
        let content = r#"throw new Error(`!!! NLS MISSING: ${r} !!!`)"#;
        let (patched, _) = replace_nls_throws(content).unwrap();
        // 修补后再跑一次应无匹配
        assert!(replace_nls_throws(&patched).is_none());
    }

    #[test]
    fn handles_different_variable_names() {
        // 不同版本 minified 变量名不同，确保都能匹配
        let content = "throw new Error(`!!! NLS MISSING: ${messageId} !!!`)";
        let (out, _) = replace_nls_throws(content).unwrap();
        assert!(!out.contains("NLS MISSING"));
    }
}
