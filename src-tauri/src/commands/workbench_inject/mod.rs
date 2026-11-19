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
// 注入时机：跟随 IDE 切换到网关；还原直连时还原。需要写 Windsurf 安装目录
// （通常在 Program Files / LocalAppData），可能需要管理员权限。

use std::fs;
use std::path::PathBuf;

pub(super) const BYOK_BLOCK_START: &str = "<!-- byok-cards-start -->";
const BYOK_BLOCK_END: &str = "<!-- byok-cards-end -->";
const BYOK_VERSION_MARKER: &str = "<!-- byok-cards-v1 -->";
/// 汉化注入块标记（与 app_localization 模块共用同一常量，避免两处定义漂移）。
/// byok 的还原逻辑要识别它：汉化还在时不能还原完整性校验清单，
/// 也不能用备份整体覆盖（会把汉化块抹掉）。
pub(crate) const HANS_BLOCK_START: &str = "<!-- anybridge-hans-start -->";
pub(super) const BACKUP_SUFFIX: &str = ".byok-origin";
pub(super) const NLS_BACKUP_SUFFIX: &str = ".byok-nls-origin";

/// 原子写：复用统一底层原语，避免固定临时文件名碰撞与截断 HTML。
pub(super) fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    super::write_atomic(path, content.as_bytes())
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
/// 候选含 electron-sandbox：Cursor 等发行版把 workbench 放在 sandbox 目录
/// （Kite 的 enhancementInjector 同样列了三个候选，只认 browser 会定位失败）。
pub(crate) fn workbench_html_path(target: &str) -> Option<PathBuf> {
    let base = ide_app_dir(target)?;
    for sub in [
        "electron-browser",
        "electron-sandbox",
        "browser",
    ] {
        let p = base.join("out").join("vs").join("code").join(sub).join("workbench").join("workbench.html");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// IDE 的 product.json（存放 VS Code 完整性校验 checksums 的清单）。
pub(crate) fn product_json_path(target: &str) -> Option<PathBuf> {
    let p = ide_app_dir(target)?.join("product.json");
    if p.exists() { Some(p) } else { None }
}

/// workbench.desktop.main.js 路径（NLS 取词函数所在的主 bundle）。

pub mod nls_and_checksums;
pub(crate) use nls_and_checksums::*;

const INSERTED_CSP_LINE: &str = "\n\t\t\t\t\t'unsafe-inline'";

/// 还原后的原厂对齐自愈：product.json 的 checksums（base64(SHA-256)，键相对
/// resources/app/out/）就是原厂字节级真值。
///
/// 历史版本的注入/剥离会泄漏换行（每轮 +2），还原回填原厂校验和后哈希必然
/// 对不上，IDE 启动即弹「安装似乎损坏」（实测事故 2026-10-31：两个入口 HTML
/// 各累积 +4/+2 个换行）。这里按校验和收敛 `</body>` 前的多余换行：每删一个
/// 都重新对哈希，收敛成功 = 字节级复原；收敛失败如实报错（调用方保留剥离结果）。
/// 仅当 product.json 里存在该文件的校验条目（且清单非空）时才生效。
pub(crate) fn align_workbench_with_checksum(
    target: &str,
    html_path: &std::path::Path,
    content: &str,
) -> Result<Option<String>, String> {
    let want = match checksum_for_workbench(target, html_path) {
        Some(w) => w,
        // 清单为空 / 无该文件条目 / product.json 不可读 = 没有真值可对齐，跳过
        None => return Ok(None),
    };
    if content_hash_b64(content) == want {
        // 已与原厂字节一致，无需对齐
        return Ok(None);
    }
    Ok(align_content_with_checksum(content, &want))
}

/// 解析 product.json 的 checksums（base64(SHA-256)，键相对 resources/app/out/），
/// 取出该入口文件的原厂哈希。清单为空 / 无该文件条目 / 解析失败 → None。
fn checksum_for_workbench(target: &str, html_path: &std::path::Path) -> Option<String> {
    let product = product_json_path(target)?;
    let doc: serde_json::Value = serde_json::from_str(&fs::read_to_string(product).ok()?).ok()?;
    let checksums = doc.get("checksums")?.as_object()?;
    if checksums.is_empty() {
        return None;
    }
    let out_dir = ide_app_dir(target)?.join("out");
    let rel = html_path
        .strip_prefix(&out_dir)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    checksums.get(&rel)?.as_str().map(|s| s.to_string())
}

/// 按原厂哈希收敛内容：只处理「</body> 前多余换行」这一种历史泄漏形态。
/// 每删一个换行都重新对哈希，成功即字节级复原；删到只剩 1 个换行仍不一致，
/// 说明差异不是换行（如实放弃，绝不盲改）。
fn align_content_with_checksum(content: &str, want: &str) -> Option<String> {
    let mut cur = content.to_string();
    for _ in 0..256 {
        if content_hash_b64(&cur) == want {
            return Some(cur);
        }
        let body_pos = cur.rfind("</body>")?;
        let bytes = cur.as_bytes();
        let mut run_start = body_pos;
        while run_start > 0 && bytes[run_start - 1] == b'\n' {
            run_start -= 1;
        }
        // 只收敛「多余」换行；允许收敛到 0——每一步都有哈希背书，
        // 能对上原厂哈希就说明那就是原厂字节
        if body_pos - run_start < 1 {
            return None;
        }
        cur.remove(body_pos - 1);
    }
    None
}

fn content_hash_b64(s: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(s.as_bytes()))
}

/// 在 CSP 的 script-src 指令里补上 'unsafe-inline'，让注入的 inline <script> 能执行。
/// 已有则原样返回。只动 script-src，不碰其它指令。
/// 返回 (新内容, 是否实际插入)——插入与否必须记账（side-effects），还原时据此精确回滚。
pub(crate) fn ensure_csp_unsafe_inline(html: &str) -> (String, bool) {
    // 找 "script-src" 后面到下一个 ';' 之间的内容，若没有 'unsafe-inline' 就插入。
    let Some(idx) = html.find("script-src") else {
        return (html.to_string(), false);
    };
    let after = &html[idx..];
    let Some(semi_rel) = after.find(';') else {
        return (html.to_string(), false);
    };
    let directive = &after[..semi_rel];
    if directive.contains("'unsafe-inline'") {
        return (html.to_string(), false);
    }
    // 在 "script-src" 紧后插入 'unsafe-inline'
    let insert_at = idx + "script-src".len();
    let mut out = String::with_capacity(html.len() + 20);
    out.push_str(&html[..insert_at]);
    out.push_str(INSERTED_CSP_LINE);
    out.push_str(&html[insert_at..]);
    (out, true)
}

/// 精确移除 ensure_csp_unsafe_inline 插入的那一行（至多一次）。
/// 只允许在 side-effects 记账确认「这行是我们插的」时调用，
/// 否则会把原厂自带的 'unsafe-inline' 误删。
pub(crate) fn revert_csp_unsafe_inline(html: &str) -> String {
    html.replacen(INSERTED_CSP_LINE, "", 1)
}

/// 移除已存在的 byok 注入块（幂等重注入用）。
///
/// 与 strip_hans_block 同款纪律：注入格式 `"\n{块}\n"`，剥离必须连换行一起移除，
/// 否则逐轮累积的空行会在还原 product.json 校验和后触发「安装似乎损坏」。
fn strip_byok_block(html: &str) -> String {
    super::app_localization::strip_injected_block(html, BYOK_BLOCK_START, BYOK_BLOCK_END)
}

/// 接入网关时接管 IDE：注入 byok-cards.js，清空 product.json 的完整性校验清单，
/// 并加固 NLS 取词函数防止语言包缺词条白屏。
/// 返回 Ok(true) 表示发生了写入（需重启 IDE 生效）；Ok(false) 表示已是最新无需改动。
pub fn inject(script: &str, target: &str) -> Result<bool, String> {
    // 持全局注入锁：与汉化 apply/restore、保活 keeper 互斥，
    // 防并发读-改-写互相覆盖（详见 commands::inject_lock 注释）。
    let _guard = super::inject_lock();
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
    let (with_csp, csp_inserted) = ensure_csp_unsafe_inline(&new_html);
    new_html = with_csp;
    if csp_inserted {
        // 记账：还原时据此精确回滚这行 CSP 放行（原厂自带的不能误删）
        super::app_localization::record_csp_inserted(target, "workbench.html")?;
    }

    // CSP 有 nonce 时内联脚本必须带同名 nonce 才执行（Devin 就是这种情况，
    // 详见 super::app_localization::extract_csp_nonce 的说明）
    let open_tag = match super::app_localization::extract_csp_nonce(&new_html) {
        Some(n) => format!("<script nonce=\"{}\">", n),
        None => "<script>".to_string(),
    };
    let injection = format!(
        "\n{start}\n{ver}\n{open}\n{script}\n</script>\n{end}\n",
        start = BYOK_BLOCK_START,
        ver = BYOK_VERSION_MARKER,
        open = open_tag,
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
    // 持全局注入锁：与汉化 apply/restore、保活 keeper 互斥，
    // 防并发读-改-写互相覆盖（详见 commands::inject_lock 注释）。
    let _guard = super::inject_lock();
    // 汉化注入还在时不能还原校验清单：checksums 恢复后 IDE 会校验被改写的
    // workbench.html 并弹"安装已损坏"（与 app_localization 还原时的判断对称：
    // 那边 byok 在时也同样保留清空状态）。
    let hans_present = workbench_html_path(target)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|html| html.contains(HANS_BLOCK_START))
        .unwrap_or(false);

    // 三个文件都要还原，任一失败都不影响另一个执行，
    // 否则会留下"文件已还原但校验清单仍为空"的半截状态。
    let product_result = if hans_present {
        Ok(false)
    } else {
        restore_product_json(target)
    };
    let html_result = restore_workbench_html(target);
    let nls_result = restore_nls(target);
    let csp_result = if hans_present {
        // 汉化块还在：CSP 行仍被汉化的 inline script 需要，由汉化 restore 处理
        Ok(false)
    } else {
        restore_csp_record(target)
    };
    let align_result = if hans_present {
        // 汉化块还在：对齐自愈由汉化 restore 处理（它还负责 locale 等副作用）
        Ok(false)
    } else {
        align_workbench_entry(target)
    };

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
    match csp_result {
        Ok(v) => changed |= v,
        Err(e) => errors.push(e),
    }
    match align_result {
        Ok(v) => changed |= v,
        Err(e) => errors.push(e),
    }
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    Ok(changed)
}

/// 还原后按回填的原厂校验和对齐 workbench.html（自愈历史换行泄漏）。
fn align_workbench_entry(target: &str) -> Result<bool, String> {
    let Some(path) = workbench_html_path(target) else {
        return Ok(false);
    };
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.contains(BYOK_BLOCK_START) || content.contains(HANS_BLOCK_START) {
        return Ok(false);
    }
    match align_workbench_with_checksum(target, &path, &content)? {
        Some(aligned) => {
            write_atomic(&path, &aligned).map_err(|e| format!("原厂对齐失败: {e}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 消费 BYOK 注入时记的 CSP 账（汉化块还在时不动——汉化 restore 会处理）。
fn restore_csp_record(target: &str) -> Result<bool, String> {
    let Some(path) = workbench_html_path(target) else {
        return Ok(false);
    };
    let html = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if html.contains(BYOK_BLOCK_START) || html.contains(HANS_BLOCK_START) {
        return Ok(false);
    }
    if !super::app_localization::take_csp_record(target, "workbench.html")? {
        return Ok(false);
    }
    let reverted = revert_csp_unsafe_inline(&html);
    if reverted == html {
        return Ok(false);
    }
    write_atomic(&path, &reverted).map_err(|e| format!("还原 CSP 失败: {e}"))?;
    Ok(true)
}

/// 还原 workbench.html：只剥离自己的 byok 块，绝不用备份整体覆盖。
/// 备份是"接入前"快照：先接入后汉化的场景下备份没有汉化块，整体覆盖会把
/// 汉化注入一并抹掉（app_localization 早期同款坑，那边已改剥离，必须对齐）。
/// 幂等：无注入痕迹时返回 Ok(false)。
fn restore_workbench_html(target: &str) -> Result<bool, String> {
    let Some(path) = workbench_html_path(target) else {
        return Ok(false);
    };
    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));
    let html = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    if !html.contains(BYOK_BLOCK_START) {
        // 无注入块（IDE 升级覆盖成新版原厂，或已还原过）：备份必属旧版本，
        // 覆盖回去会造成版本错配，直接淘汰。
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        return Ok(false);
    }
    if !html.contains(BYOK_BLOCK_END) {
        // 块标记不完整（写入中断/外部改写）：如实报错并保留备份供手动还原，
        // 不做危险的整体覆盖。
        return Err(format!(
            "BYOK 注入块标记不完整，无法安全还原。请重装客户端，或用备份 {} 手动覆盖",
            backup.display()
        ));
    }
    let cleaned = strip_byok_block(&html);
    write_atomic(&path, &cleaned).map_err(|e| format!("还原 workbench.html 失败: {e}"))?;
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(true)
}


#[cfg(test)]
mod tests;
