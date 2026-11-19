use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use super::*;
use std::time::Duration;
use super::claude_desktop_zh::*;
use super::lang_pack::*;
use super::scripts_and_dict::*;
use super::workbench_checks::*;

/// `elevate`：是否允许在权限不足时弹一次性 UAC 自动授权。
/// 界面操作（命令）传 true；keeper 等后台场景传 false——失败静默跳过下周期重试。
///
/// 锁纪律：本函数是**外部入口**，负责拿 inject_lock；真正的注入逻辑在
/// `apply_inner`（**不加锁**，假定调用方已持锁）。这样 keeper 才能在持锁
/// 状态下调用注入而不触发 std::sync::Mutex 的不可重入死锁
/// （实测事故：keeper 持锁 → 调 apply → apply 再加锁 → 同线程死锁，
/// 并把用户的汉化请求一起堵死）。
pub(super) fn apply(platform: &str, elevate: bool) -> Result<LocalizationOperationResult, String> {
    if platform == "claude-desktop" {
        // claude 没有语言包网络段，全程持锁：它改的是 index.html/i18n/config.json，
        // 与 keeper/BYOK 互斥（此前在锁外裸奔，审计发现）。
        let _guard = crate::commands::inject_lock();
        return apply_claude(elevate);
    }
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;

    // 语言包策略：已装 → 直接切显示语言；未装 → 默认自动从 Open VSX 安装与
    // IDE 引擎匹配的版本（用户要求默认设置好，不让用户手动去扩展市场）。
    // 安装/切换失败不阻断汉化本体，但必须如实写进消息，绝不静默吞掉。
    // 语言包安装走网络（Open VSX + VSIX 下载），绝不在注入锁内做——
    // 否则 keeper 会被几分钟的网络超时挡住。语言包操作与 html 注入互不相干。
    let mut lang_note: Option<String> = None;
    // 无论已装还是本次安装，都清一次 obsolete 标记（目录合法但被标记 =
    // VS Code 扫描器跳过，实测踩中）。
    clear_obsolete_mark(platform, LANG_PACK_EXTENSION_ID);
    // 只在「当前还没有生效中的中文包」时才注册官方包：
    // 用户已装并生效了第三方中文包（如 openubmc）时不抢注册，避免覆盖用户选择
    if !lang_pack_installed(platform) {
        if let Some(ver) = installed_lang_pack_version(platform) {
            register_language_pack(platform, &ver);
        }
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
    let _guard = crate::commands::inject_lock();
    apply_inner(platform, &display, &lang_note)
}

/// 注入段实现（**调用方必须已持有 inject_lock**，见 apply 的锁纪律说明）。
pub(super) fn apply_inner(
    platform: &str,
    display: &str,
    lang_note: &Option<String>,
) -> Result<LocalizationOperationResult, String> {
    // 入口可能不止一个：Antigravity IDE 的设置页/Agent 面板由独立引导窗口
    // （workbench-jetski-agent.html）渲染，只注入 workbench.html 时它仍全英文。
    // 必须全部注入；任何一个失败都如实报错，绝不谎报"已汉化"。
    let targets = localization_target_htmls(platform);
    if targets.is_empty() {
        return Err(format!(
            "未定位到 {} 的 workbench.html（请先安装并运行一次 {} 后重试）",
            display, display
        ));
    }

    let mut entries = 0usize;
    let mut injected: Vec<String> = Vec::new();
    for html_path in &targets {
        match inject_hans_into(platform, display, html_path) {
            Ok(n) => {
                entries = entries.max(n);
                injected.push(
                    html_path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or("workbench.html")
                        .to_string(),
                );
            }
            Err(e) => {
                let done = if injected.is_empty() {
                    "无".to_string()
                } else {
                    injected.join("、")
                };
                return Err(format!("{e}（本次已注入：{done}，其余入口请重试）"));
            }
        }
    }
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
        "{} 汉化已应用成功（{} 条词条），重启客户端后生效",
        display, entries
    );
    if let Some(note) = locale_note.or(lang_note.clone()) {
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

/// 单个界面入口 HTML 的汉化注入（幂等），返回注入的词条数。
///
/// 抽成独立函数的原因：主 workbench.html 与设置页的引导窗口 HTML 必须走
/// **完全相同**的一套纪律（快照自愈、原厂备份、CSP 补 'unsafe-inline'、
/// nonce 继承、写后校验、失败回滚）。各写一份必然漏改其中一处。
pub(super) fn inject_hans_into(
    platform: &str,
    display: &str,
    html_path: &Path,
) -> Result<usize, String> {
    inject_hans_into_with_cache(&cache_dir(platform), platform, display, html_path)
}

/// 注入实现。`cache` 由调用方传入：生产用 cache_dir，测试用临时目录，
/// 避免单测把快照写进真实用户缓存（否则损坏自愈会拿测试夹具覆盖真文件）。
pub(super) fn inject_hans_into_with_cache(
    cache: &Path,
    platform: &str,
    display: &str,
    html_path: &Path,
) -> Result<usize, String> {
    let file_name = html_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("workbench.html");
    let html = fs::read_to_string(html_path)
        .map_err(|e| format!("读取 {file_name} 失败: {e}"))?;

    // 防御零：读到疑似损坏（缺 </body>）→ 用快照自愈。
    // 事故背景：apply 写入过程中用户强杀 AnyBridge，文件系统留下截断的
    // workbench.html（实测 307KB 被截成 1.7KB），IDE 直接起不来，
    // 而同目录备份已被上次还原删除 —— 无快照就彻底救不回来。
    let snapshot = html_snapshot_path(cache, html_path);
    if !is_valid_workbench(&html) {
        if let Ok(s) = fs::read_to_string(&snapshot) {
            if s.len() > html.len() && s.contains("</body>") {
                // 自愈不能把 BYOK 注入块一起冲掉（快照可能生成于 BYOK 注入之前）
                let restored = snapshot_with_byok_preserved(&html, &s);
                let _ = write_atomic(html_path, &restored);
                return Err(format!(
                    "检测到 {} 的 {file_name} 异常（可能被中断的写入截断），已从快照自动恢复，请重新点击汉化",
                    display
                ));
            }
        }
        return Err(format!(
            "{} 的 {file_name} 内容异常（{} 字节），已中止以避免进一步损坏。请重装 {} 后重试",
            display,
            html.len(),
            display
        ));
    }
    // 快照：无论当前是否原厂态都保存"上一次可用状态"，供中断后自愈。
    let _ = fs::write(&snapshot, html.as_bytes());

    // 备份：当前 html 无汉化标记 = 原厂态（首次注入，或 IDE 升级覆盖后的新版原厂），
    // 一律刷新备份以严格对齐当前安装版本。
    // 若只在"备份不存在"时才写，keeper 在升级后重注入时备份仍是旧版本 html，
    // 用户后续点还原会把旧版本覆盖回新版安装，造成 workbench 版本错配。
    // （还原成功后备份会被删除，因此这里不会误刷新。）
    let backup = PathBuf::from(format!("{}{}", html_path.to_string_lossy(), HANS_BACKUP_SUFFIX));
    if !html.contains(HANS_BLOCK_START) {
        fs::write(&backup, &html).map_err(|e| format!("备份 {file_name} 失败: {e}"))?;
    }

    let stripped = strip_hans_block(&html);
    let (with_csp, csp_inserted) = ensure_csp_unsafe_inline(&stripped);
    if csp_inserted {
        // 记账：还原时据此精确移除这行 CSP 放行（原厂自带的不能误删）
        record_csp_inserted(platform, file_name)?;
    }
    // 非主入口 = 辅助窗口（Antigravity IDE 的设置页/Agent 面板）：脚本首行置标记，
    // 引擎据此跳过"等 workbench 根节点 + 隐藏首屏"，否则会白屏等到 6 秒超时。
    let script = hans_script_for_window(platform, file_name != "workbench.html");
    let entries = count_entries(&script);
    // CSP 有 nonce 时内联脚本必须带同名 nonce 才能执行（详见 extract_csp_nonce 注释）
    let open_tag = match extract_csp_nonce(&html) {
        Some(n) => format!("<script nonce=\"{}\">", n),
        None => "<script>".to_string(),
    };
    let block = format!(
        "\n{start}\n{ver}\n{open}\n{script}\n</script>\n{end}\n",
        start = HANS_BLOCK_START,
        ver = HANS_VERSION_MARKER,
        open = open_tag,
        script = script,
        end = HANS_BLOCK_END,
    );

    let Some(body_idx) = with_csp.rfind("</body>") else {
        return Err(format!("{file_name} 缺少 </body>，无法注入"));
    };
    let mut new_html = String::with_capacity(with_csp.len() + block.len());
    new_html.push_str(&with_csp[..body_idx]);
    new_html.push_str(&block);
    new_html.push_str(&with_csp[body_idx..]);
    write_atomic(html_path, &new_html).map_err(|e| format!("写入 {file_name} 失败: {e}"))?;

    // 写后校验：确认真的写进去了且结构完整。写入被中断（强杀/磁盘满）时
    // 文件可能只有一部分，不校验就当成功会给用户留一个起不来的 IDE。
    let written_ok = fs::read_to_string(html_path)
        .ok()
        .map(|v| v.contains(HANS_BLOCK_START) && v.contains("</body>") && v.len() >= html.len())
        .unwrap_or(false);
    if !written_ok {
        // 回滚到快照（上次可用状态），宁可回到英文界面也不能白屏。
        // 同样要保住 BYOK 块：回滚是异常路径，不能顺手把另一条链的注入也抹掉
        if let Ok(s) = fs::read_to_string(&snapshot) {
            let current = fs::read_to_string(html_path).unwrap_or_default();
            let restored = snapshot_with_byok_preserved(&current, &s);
            let _ = write_atomic(html_path, &restored);
        }
        return Err(format!(
            "汉化写入后校验失败（{} 的 {file_name} 异常），已从快照恢复，请重启客户端后重试",
            display
        ));
    }
    Ok(entries)
}

pub(super) fn restore(platform: &str, elevate: bool) -> Result<LocalizationOperationResult, String> {
    if platform == "claude-desktop" {
        // 与 apply 对称：claude 还原也全程持锁（此前在锁外裸奔，审计发现）
        let _guard = crate::commands::inject_lock();
        return restore_claude(elevate);
    }
    // 持全局注入锁：与 BYOK 接入/还原、保活 keeper 互斥，
    // 防并发读-改-写互相覆盖（详见 commands::inject_lock 注释）。
    let _guard = crate::commands::inject_lock();
    let (display, _) = platform_meta(platform).ok_or_else(|| format!("不支持的平台: {}", platform))?;

    // 与 apply 完全对称：每个被注入过的入口 HTML 都要剥离汉化块。
    // 只还原主 workbench.html 会把设置页入口留在汉化态，形成半还原的脏状态。
    let targets = localization_target_htmls(platform);
    if targets.is_empty() {
        return Err(format!("未定位到 {} 的 workbench.html", display));
    }

    // 还原一律走「剥离自己的汉化块」，绝不用备份整体覆盖：
    // 备份是"打汉化前"的快照，若用户是先汉化、后一键接入，备份里没有 BYOK 注入块，
    // 整体覆盖会把 BYOK 的 byok-cards 块一并抹掉，导致接入静默失效
    // （antigravity_localization.rs 里同一个坑早有记载：绝不回退到接入前的纯净版）。
    let mut changed = false;
    for html_path in &targets {
        let file_name = html_path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("workbench.html");
        let backup = PathBuf::from(format!("{}{}", html_path.to_string_lossy(), HANS_BACKUP_SUFFIX));
        let html = fs::read_to_string(html_path).map_err(|e| e.to_string())?;

        if html.contains(HANS_BLOCK_START) {
            if !html.contains(HANS_BLOCK_END) {
                // 块标记不完整（写入被中断或遭外部改写）：如实报错，不做危险的整体覆盖，
                // 备份保留供用户手动还原。
                return Err(format!(
                    "{} 的 {file_name} 汉化块标记不完整，无法安全还原。请重装客户端，或用备份 {} 手动覆盖",
                    display,
                    backup.display()
                ));
            }
            let mut cleaned = strip_hans_block(&html);
            // 副作用回滚①：CSP 的 'unsafe-inline'。仅当记账确认是我们插的、
            // 且该文件已无 BYOK 块（BYOK 的 inline script 还需要它执行）才移除。
            if !cleaned.contains(BYOK_BLOCK_START)
                && take_csp_record(platform, file_name).unwrap_or(false)
            {
                cleaned = revert_csp_unsafe_inline(&cleaned);
            }
            write_atomic(html_path, &cleaned)
                .map_err(|e| format!("还原 {file_name} 失败: {e}"))?;
            changed = true;
            invalidate_status_cache();
        }
        // 备份的存在价值只到还原为止；剥离成功后即清理，避免下次 apply 误用旧版本。
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
    }

    // product.json 校验清单：仅当 byok 注入块也不在时才会去还原
    // （byok 还在用则必须保留清空状态，否则它那边弹"安装已损坏"）。
    let mut warning = String::new();
    let byok_present = targets.iter().any(|p| {
        fs::read_to_string(p)
            .map(|h| h.contains(BYOK_BLOCK_START))
            .unwrap_or(false)
    });
    if !byok_present {
        if let Err(e) = restore_product_json(platform) {
            warning = format!("；完整性校验清单还原失败：{e}（重装 IDE 可恢复）");
        }
        // 副作用回滚②：NLS 取词加固。BYOK 同样依赖它，仅在无 byok 块时还原；
        // restore_nls 自带版本防护（IDE 升级后旧备份不会覆盖新版文件）。
        match crate::commands::workbench_inject::restore_nls(platform) {
            Ok(true) => changed = true,
            Ok(false) => {}
            Err(e) => {
                let nls_warning = format!("；NLS 原厂文件还原失败：{e}");
                warning.push_str(&nls_warning);
            }
        }
        // 副作用回滚④：原厂对齐自愈——校验和已回填，按原厂哈希收敛历史泄漏的换行
        // （strip 修好前的每一轮注入/剥离都漏 2 个换行，累积在存量安装上）
        for html_path in &targets {
            let content = match fs::read_to_string(html_path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.contains(HANS_BLOCK_START) || content.contains(BYOK_BLOCK_START) {
                continue;
            }
            match crate::commands::workbench_inject::align_workbench_with_checksum(platform, html_path, &content)
            {
                Ok(Some(aligned)) => {
                    write_atomic(html_path, &aligned)
                        .map_err(|e| format!("原厂对齐失败: {e}"))?;
                    changed = true;
                }
                Ok(None) => {}
                Err(e) => warning.push_str(&format!("；{e}")),
            }
        }
    }

    // 副作用回滚③：显示语言。仅当当前仍是我们写的 zh-cn 才回滚——
    // 用户中途手动改过 locale 的（值 != zh-cn）保留用户选择，绝不覆盖。
    let locale_note = match take_locale_record(platform) {
        Ok(Some(record)) => {
            let reverted = ide_state_dir(platform).and_then(|state| {
                let argv_path = state.join("argv.json");
                let raw = fs::read_to_string(&argv_path).ok()?;
                let current_is_ours = parse_jsonc(&raw)
                    .and_then(|d| d.get("locale").and_then(|v| v.as_str()).map(String::from))
                    .as_deref()
                    == Some("zh-cn");
                if !current_is_ours {
                    return None;
                }
                let new_text = revert_locale_in_argv(&raw, &record)?;
                write_atomic(&argv_path, &new_text).ok()?;
                Some(true)
            });
            match reverted {
                Some(true) => Some("；显示语言已还原为改前设置".to_string()),
                _ => None,
            }
        }
        Ok(None) => None,
        Err(e) => Some(format!("；显示语言回滚失败：{e}")),
    };
    if let Some(note) = locale_note {
        changed = true;
        warning.push_str(&note);
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

/// Claude Desktop 汉化（i18n 目录注入方案，实测可行）：
/// 1. 定位 ion-dist（Claude 升级会换新目录，每次重新定位）
/// 2. 授权目录与 index.html（MSIX 受保护目录需要 takeown + icacls）
/// 3. 写 /i18n/zh-Hans.json + /i18n/dynamic/zh-Hans.json（词典来自热更新缓存）
/// 4. 扫描语言 store 模块与导出别名（版本相关，绝不硬编码）
/// 5. 注入 index.html：声明 zh-Hans 目录（meta 两段 hash）+ setLocaleOverride
/// 6. config.json locale=zh-Hans
///
/// 注意：改 en-US.json 是无效路线——react-intl 的默认语言直接用组件内联的
/// defaultMessage，根本不读 en-US.json；且前端只认 meta 里声明过的 locale。
pub(super) fn apply_claude(elevate: bool) -> Result<LocalizationOperationResult, String> {
    let _ = elevate; // 授权走 grant_acl（静默，必要时由系统弹 UAC）
    let dist = claude_ion_dist_dir().ok_or_else(|| {
        "未定位到 Claude Desktop 的界面资源（ion-dist）。请先安装并运行一次 Claude Desktop"
            .to_string()
    })?;

    // 1. 授权：ion-dist 与其 i18n 目录（新装/升级后的目录没有写权限）
    grant_acl(&dist, true)?;
    grant_acl(&dist.join("i18n"), true)?;
    // 授权后仍不可写 = 非管理员运行且 ACL 未授权，给出可操作的指引而不是裸错误
    if fs::OpenOptions::new()
        .write(true)
        .open(dist.join("index.html"))
        .is_err()
    {
        return Err(
            "无权限写入 Claude 安装目录（微软商店版位于受保护目录）。请以管理员身份运行 AnyBridge 后重试，或改用官网安装版"
                .to_string(),
        );
    }

    // 2. 写词典
    let entries = claude_write_zh_dicts(&dist)?;

    // 3. 扫描 store 模块（版本变化时文件名/导出别名都会变）
    let (store_rel, store_export) = detect_claude_store(&dist).ok_or_else(|| {
        "未能定位 Claude 的语言运行时模块（版本可能已变更）。已保留词典，请反馈该问题".to_string()
    })?;

    // 4. 注入 index.html
    let snippet = claude_inject_snippet(&store_rel, &store_export);
    claude_inject_index(&dist, &snippet)?;

    // 5. 切语言（config.json）
    let locale_changed = claude_set_locale(CLAUDE_ZH_LOCALE, false)?;

    // 6. 校验：index.html 必须真的带上了标记
    let html = fs::read_to_string(dist.join("index.html"))
        .map_err(|e| format!("写入后读取 index.html 失败: {e}"))?;
    if !html.contains(CLAUDE_ZH_MARKER) {
        return Err("注入校验失败：index.html 未包含汉化标记".to_string());
    }

    set_enabled("claude-desktop");
    invalidate_status_cache();

    let mut message = format!("Claude Desktop 汉化已应用成功（{} 条词条）", entries);
    if locale_changed {
        message.push_str("，显示语言已切换为简体中文");
    }
    message.push_str("，重启客户端后生效");
    Ok(LocalizationOperationResult {
        ok: true,
        message,
        localized: true,
    })
}

/// Claude Desktop 还原：剥离 index.html 注入、删除 zh-Hans 词典、locale 恢复 en-US。
pub(super) fn restore_claude(elevate: bool) -> Result<LocalizationOperationResult, String> {
    let _ = elevate;
    let dist = claude_ion_dist_dir()
        .ok_or_else(|| "未定位到 Claude Desktop 的界面资源".to_string())?;

    let idx = dist.join("index.html");
    let mut changed = false;
    if let Ok(html) = fs::read_to_string(&idx) {
        let stripped = claude_strip_inject(&html);
        if stripped != html {
            grant_acl(&idx, false)?;
            fs::write(&idx, stripped.as_bytes())
                .map_err(|e| format!("还原 index.html 失败: {e}"))?;
            changed = true;
        }
    }
    // 删掉我们放的词典（Claude 自己的语言文件不碰）
    for p in [
        dist.join("i18n").join(format!("{CLAUDE_ZH_LOCALE}.json")),
        dist.join("i18n").join("dynamic").join(format!("{CLAUDE_ZH_LOCALE}.json")),
    ] {
        if p.exists() {
            grant_acl(&p, false)?;
            if fs::remove_file(&p).is_ok() {
                changed = true;
            }
        }
    }
    if claude_set_locale("en-US", true)? {
        changed = true;
    }
    clear_enabled("claude-desktop");
    invalidate_status_cache();

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

pub(super) const KEEPER_FIRST_DELAY: Duration = Duration::from_secs(60);
pub(super) const KEEPER_INTERVAL: Duration = Duration::from_secs(600);
pub(super) const KEEPER_PLATFORMS: [&str; 5] = [
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
pub(super) fn keeper_should_reinject(platform: &str, enabled: bool) -> bool {
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

pub(super) fn keeper_tick(app: &tauri::AppHandle, platform: &str) {
    // 判定 + 重注入全程持锁：若判定在锁外，用户可能在判定后、注入前点了还原，
    // 而 keeper 手里是旧的"需重注入"结论 → 块被写回"复活"。
    // 注意：持锁后只能调 apply_inner（apply 会再次加锁 → 不可重入死锁，实测事故）。
    let _guard = crate::commands::inject_lock();
    if !keeper_should_reinject(platform, is_enabled(platform)) {
        return;
    }
    // 被 IDE 升级覆盖 → 重注入（apply 幂等；IDE 运行中文件被锁则 Err，下周期重试）。
    // elevate=false：keeper 是后台线程，权限不足时绝不去弹 UAC，静默等下周期。
    let display = platform_meta(platform).map(|m| m.0).unwrap_or(platform);
    // claude 走 i18n 目录注入链：apply_inner 是 workbench 注入，对 claude 必然
    // 报"未定位到 workbench.html"（此前每 10 分钟一条错误日志，keeper 名存实亡）。
    // 两者都是无锁版，本函数已持锁。
    let result = if platform == "claude-desktop" {
        apply_claude(false)
    } else {
        apply_inner(platform, &display, &None)
    };
    match result {
        Ok(_) => {
            eprintln!("[loc-keeper] {} 汉化被客户端升级覆盖，已自动重注入", display);
            let _ = app.emit(
                "proxy-log",
                crate::commands::proxy::LogLine {
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

