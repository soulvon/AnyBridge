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
// 注入时机：跟随代理服务启动；停止/退出时还原。需要写 Windsurf 安装目录
// （通常在 Program Files / LocalAppData），可能需要管理员权限。

use std::fs;
use std::path::PathBuf;

const BYOK_BLOCK_START: &str = "<!-- byok-cards-start -->";
const BYOK_BLOCK_END: &str = "<!-- byok-cards-end -->";
const BYOK_VERSION_MARKER: &str = "<!-- byok-cards-v1 -->";
const BACKUP_SUFFIX: &str = ".byok-origin";

/// 原子写：同目录临时文件 + rename，避免写 workbench.html 中途崩溃留下截断 HTML。
fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.byok-tmp", path.to_string_lossy()));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// 从 IDE 可执行文件路径推出 workbench.html 路径。
fn workbench_html_path(target: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let app_root = {
        // exe 在 <root>\Windsurf.exe 或 <root>\Devin.exe，资源在 <root>\resources\app
        let exe = crate::commands::system::find_ide_exe(target)?;
        exe.parent()?.join("resources").join("app")
    };

    #[cfg(target_os = "macos")]
    let app_root = {
        // <Windsurf.app>/Contents/Resources/app 或 <Devin.app>/Contents/Resources/app
        let app = crate::commands::system::find_ide_app(target)?;
        app.join("Contents").join("Resources").join("app")
    };

    #[cfg(target_os = "linux")]
    let app_root = {
        // bin 通常在 <root>/windsurf 或 <root>/devin，资源在 <root>/resources/app
        let bin = crate::commands::system::find_ide_bin(target)?;
        bin.parent()?.join("resources").join("app")
    };

    let p = app_root
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

/// 注入 byok-cards.js（脚本内容由调用方提供，来自打包资源）。
/// 返回 Ok(true) 表示发生了写入（需重启 IDE 生效）；Ok(false) 表示已是最新无需改动。
pub fn inject(script: &str, target: &str) -> Result<bool, String> {
    let Some(path) = workbench_html_path(target) else {
        return Err(
            format!("未定位到 {} 的 workbench.html（可能装在非默认目录且未运行）。\
             请启动 {} 后重试，或在设置页手动指定路径", target, target)
        );
    };

    let html = fs::read_to_string(&path).map_err(|e| format!("读取 workbench.html 失败: {}", e))?;

    // 已注入且版本一致 → 跳过。
    if html.contains(BYOK_VERSION_MARKER) {
        return Ok(false);
    }

    // 幂等备份：仅当备份不存在时写入纯净副本。
    let backup = PathBuf::from(format!("{}{}", path.to_string_lossy(), BACKUP_SUFFIX));
    if !backup.exists() {
        fs::write(&backup, &html).map_err(|e| format!("备份 workbench.html 失败: {}", e))?;
    }

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

/// 还原 workbench.html：优先用备份整体覆盖，否则仅剥离 byok 块。
/// 幂等：无注入痕迹时返回 Ok(false)。
pub fn restore(target: &str) -> Result<bool, String> {
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
