use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use super::*;

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
pub(super) fn is_valid_workbench(html: &str) -> bool {
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
pub(super) fn html_snapshot_path(cache_dir: &Path, html_path: &Path) -> PathBuf {
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
pub(super) fn ag_ide_entry_htmls(primary: &Path) -> Vec<PathBuf> {
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
pub(super) fn localization_target_htmls(platform: &str) -> Vec<PathBuf> {
    match workbench_html_path(platform) {
        Some(primary) if platform == "antigravity-ide" => ag_ide_entry_htmls(&primary),
        Some(primary) => vec![primary],
        None => Vec::new(),
    }
}

/// 汉化启用标记（保活依据）：apply 成功时写入，restore 成功时删除。
/// IDE 升级会把 html 覆盖回原厂（汉化标记消失），仅靠 html 判断会误判为
/// "用户主动还原"，所以必须有独立的持久化开启标记。
pub(super) fn enabled_marker_path(platform: &str) -> PathBuf {
    cache_dir(platform).join("enabled.json")
}

pub(crate) fn is_enabled(platform: &str) -> bool {
    enabled_marker_path(platform).exists()
}

pub(super) fn set_enabled(platform: &str) {
    let meta = json!({
        "platform": platform,
        "enabledAt": chrono::Utc::now().to_rfc3339()
    });
    let _ = fs::write(
        enabled_marker_path(platform),
        meta.to_string().as_bytes(),
    );
}

pub(super) fn clear_enabled(platform: &str) {
    let _ = fs::remove_file(enabled_marker_path(platform));
}

/// 解析版本前缀：支持 `1.106.0-universal` / `-1.107.0` 等扩展目录后缀形态。
pub(super) fn parse_semver_prefix(raw: &str) -> Option<(u32, u32, u32)> {
    let cleaned = raw.trim().trim_start_matches(['-', 'v', 'V']);
    let mut parts = cleaned.split('.');
    let parse_num = |s: &str| -> Option<u32> {
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            None
        } else {
            digits.parse::<u32>().ok()
        }
    };
    let major = parse_num(parts.next()?)?;
    let minor = parse_num(parts.next()?)?;
    let patch = parts.next().and_then(parse_num).unwrap_or(0);
    Some((major, minor, patch))
}

/// 判断语言包版本与 IDE 引擎版本是否兼容：
/// 同大版本且 `pack.minor <= engine.minor`（允许向下兼容最多 5 个 minor 版本）。
/// 实测 Open VSX 上 `ms-ceintl/vscode-language-pack-zh-hans` 缺少 `1.107.x`，
/// `1.106.0`（`engines.vscode: ^1.106.0`）原生兼容 `1.107.0` 引擎；高于引擎的版本不兼容。
pub(super) fn is_lang_pack_compatible(pack_ver: (u32, u32, u32), engine_ver: (u32, u32, u32)) -> bool {
    pack_ver.0 == engine_ver.0
        && pack_ver.1 <= engine_ver.1
        && engine_ver.1.saturating_sub(pack_ver.1) <= 5
}

/// 从版本列表中挑出与当前 IDE 引擎兼容且版本号最大的原始键。
pub(super) fn pick_compatible_lang_pack_version<'a>(
    versions: impl IntoIterator<Item = &'a str>,
    engine: &str,
) -> Option<String> {
    let engine_ver = parse_semver_prefix(engine)?;
    let mut pick: Option<(String, (u32, u32, u32))> = None;
    for raw in versions {
        let Some(ver) = parse_semver_prefix(raw) else {
            continue;
        };
        if is_lang_pack_compatible(ver, engine_ver)
            && pick.as_ref().map(|(_, pv)| ver > *pv).unwrap_or(true)
        {
            pick = Some((raw.to_string(), ver));
        }
    }
    pick.map(|(k, _)| k)
}

/// IDE 内置引擎版本：优先 product.json 的 vscodeVersion 字段（Cursor 等发行版
/// 用自己的版本号，如 3.15.6，而内置 VS Code 引擎在 vscodeVersion，如 1.128.0），
/// 回退 version 字段（Windsurf 系的 version 即引擎对齐版本）。
pub(super) fn engine_version(platform: &str) -> Option<String> {
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

/// 已装语言包里是否有与 IDE 引擎兼容的版本（兼容同 minor 或向下 5 个 minor，
/// 并支持 `-universal` 等目录后缀）。
pub(super) fn compatible_lang_pack_dir(platform: &str) -> Option<PathBuf> {
    let engine = engine_version(platform)?;
    let engine_ver = parse_semver_prefix(&engine)?;
    let ext_dir = ide_extensions_dir(platform)?;
    let entries = fs::read_dir(&ext_dir).ok()?;
    let mut matched: Option<((u32, u32, u32), PathBuf)> = None;
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(LANG_PACK_DIR_PREFIX) else {
            continue;
        };
        let Some(ver) = parse_semver_prefix(rest) else {
            continue;
        };
        if is_lang_pack_compatible(ver, engine_ver)
            && matched.as_ref().map(|(mv, _)| ver > *mv).unwrap_or(true)
        {
            matched = Some((ver, e.path()));
        }
    }
    matched.map(|(_, p)| p)
}

/// 读扩展目录的 `.obsolete` 废弃标记 key 集合（小写，用于前缀匹配）。
pub(super) fn obsolete_keys(ext_dir: &Path) -> Vec<String> {
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
pub(super) fn extension_dir_for_id(ext_dir: &Path, id: &str) -> Option<PathBuf> {
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
pub(super) fn lang_pack_installed(platform: &str) -> bool {
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

/// 原子写：复用统一底层原语，避免固定临时文件名碰撞与截断 HTML。
pub(super) fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    crate::commands::write_atomic(path, content.as_bytes())
}

/// 移除已存在的汉化注入块（幂等重注入用）。
///
/// 注入格式是 `"\n{块}\n"`（插在 </body> 前），剥离必须把这两个换行一并移除：
/// 只删块本体会让文件比原厂多出空行，逐轮累积——AG IDE 的 product.json
/// 校验和覆盖 workbench.html，还原后原厂哈希一对上就弹「安装似乎损坏」
/// （实测事故 2026-10-31：两个入口 HTML 各累积 +4/+2 个换行）。
pub(super) fn strip_hans_block(html: &str) -> String {
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
pub(super) fn snapshot_with_byok_preserved(current: &str, snapshot: &str) -> String {
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
pub(super) fn parse_version_dir(name: &str) -> Vec<u32> {
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
pub(super) fn pick_claude_ion_dist(root: &Path) -> Option<PathBuf> {
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
