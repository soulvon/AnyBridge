use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use super::*;
use super::claude_desktop_zh::*;
use super::workbench_checks::*;

/// 已汉化 = **每一个**入口 HTML 都带汉化块。
///
/// 只看主 workbench.html 会把"菜单中文、设置页仍英文"的半汉化状态误报成
/// 已完成（Antigravity IDE 的设置页入口独立成窗口，实测事故）。keeper 也靠
/// 这个判定决定是否重注入，判据必须覆盖完整生效链。
pub(super) fn is_localized(platform: &str) -> bool {
    if platform == "claude-desktop" {
        return is_claude_localized();
    }
    let targets = localization_target_htmls(platform);
    !targets.is_empty()
        && targets.iter().all(|p| {
            fs::read_to_string(p)
                .map(|html| html.contains(HANS_BLOCK_START))
                .unwrap_or(false)
        })
}

/// 客户端是否已安装（分平台：VS Code 系看 workbench.html，Claude 看语言文件）。
/// build_status 与保活 keeper 必须共用同一判定，否则会出现"状态显示已安装
/// 但 keeper 永远不重注入"的偏差（Claude 没有 workbench.html）。
pub(super) fn is_installed(platform: &str) -> bool {
    // 不支持的平台一律未安装：未知 target 会落到 find_ide_exe 的默认分支
    // （当成 Windsurf 探测），不拦掉会把别人的安装误判成自己的。
    if platform_meta(platform).is_none() {
        return false;
    }
    if platform == "claude-desktop" {
        claude_ion_dist_dir().is_some()
    } else {
        workbench_html_path(platform).is_some()
    }
}

/// 统计脚本词条数。兼容两种序列化风格：
/// 上游原版脚本用单引号（`\t\t['en', 'zh'],`），词典组装生成的用双引号。
pub(super) fn count_entries(script: &str) -> usize {
    let re = regex::Regex::new(r#"(?m)^\s*\[["']"#).unwrap();
    re.find_iter(script).count()
}

/// 解析 JSONC（VS Code 系 argv.json 是带 // 注释的模板）。
/// 剥掉行/块注释后再按标准 JSON 解析；解析失败返回 None，调用方绝不覆盖原文件。
pub(super) fn parse_jsonc(raw: &str) -> Option<Value> {
    let no_block = regex::Regex::new(r"/\*[\s\S]*?\*/")
        .unwrap()
        .replace_all(raw, "");
    let no_line = regex::Regex::new(r"(?m)^\s*//.*$")
        .unwrap()
        .replace_all(&no_block, "");
    serde_json::from_str(&no_line).ok()
}

/// 已装中文语言包时把显示语言切到 zh-cn（argv.json，幂等）。
/// 语言包没装时不动——此时 overlay 只汉化专有界面，
/// 标准菜单仍走官方英文，由 UI 提示用户去扩展市场安装语言包。
pub(super) fn ensure_locale_zh_cn(platform: &str) -> Result<bool, String> {
    if !lang_pack_installed(platform) {
        return Ok(false);
    }
    // argv.json 必须在 Electron 主进程实际读取的路径（见 ide_argv_path 注释）：
    // Windsurf/Devin/Antigravity IDE 在 ~/.<name>/argv.json，不能只写 %APPDATA% 目录。
    let Some(argv_path) = ide_argv_path(platform) else {
        return Ok(false);
    };
    if let Some(parent) = argv_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // argv.json 是 JSONC：解析失败时绝不用空对象覆盖，避免丢用户原有配置
    let mut doc: Value = if argv_path.exists() {
        let raw = fs::read_to_string(&argv_path).map_err(|e| e.to_string())?;
        match parse_jsonc(&raw) {
            Some(v) => v,
            None => return Err("argv.json 解析失败（非 JSONC），已跳过语言切换以免覆盖你的配置".to_string()),
        }
    } else {
        json!({})
    };
    if doc.get("locale").and_then(|v| v.as_str()) == Some("zh-cn") {
        return Ok(false);
    }
    // 记账改前值：还原时据此精确回滚（键不存在 = 还原时删除该键）
    let previous = doc.get("locale").and_then(|v| v.as_str()).map(|s| s.to_string());
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("locale".to_string(), json!("zh-cn"));
    }
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_atomic(&argv_path, &text)?;
    record_locale_previous(platform, previous.as_deref())?;
    Ok(true)
}

/// 解压 VSIX 的 extension/ 目录到目标扩展目录（带 zip-slip 防护）。
pub(super) fn unzip_extension(zip_path: &Path, target: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 VSIX 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 VSIX 失败: {e}"))?;
    // 第一遍：整包校验。任何条目不可净化即整体拒绝——
    // 否则正常条目先落盘、恶意条目才报错，会留下半截安装目录。
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("读取 VSIX 条目失败: {e}"))?;
        if entry.enclosed_name().is_none() {
            return Err("VSIX 内含非法路径（疑似路径穿越），已中止安装".to_string());
        }
    }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 VSIX 条目失败: {e}"))?;
        // enclosed_name 是 zip crate 官方的防穿越姿势：剔除 .. 与绝对路径组件，
        // 任何条目都被圈在 target 内。
        let safe_name = entry
            .enclosed_name()
            .ok_or_else(|| "VSIX 内含非法路径".to_string())?;
        let name = safe_name.to_string_lossy().to_string();
        let Some(rel) = name.strip_prefix("extension/") else {
            continue; // 只安装 extension/ 内容，忽略元数据
        };
        if rel.is_empty() {
            continue;
        }
        let out_path = target.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压写入失败: {e}"))?;
    }
    Ok(())
}

/// 从 Open VSX 下载并安装 VS Code 官方简体中文语言包（VS Code 系平台通用）。
/// 语言包版本号与 VS Code 引擎对齐（如 1.106.x 语言包配 1.106.x 引擎），
/// 必须按 IDE 的 major.minor 精确匹配，跨版本装了不生效甚至报引擎不兼容。
/// 返回 Ok(true) 表示发生了安装；已装返回 Ok(false)。
/// 从 extensions.json 移除指定扩展 id 的登记条目。
/// VS Code 按登记表 + 目录扫描双源加载扩展：只隔离/替换目录而不清登记，
/// 登记条目会指向不存在的目录，扩展面板报 "Unable to read file" 无法清除。
pub(super) fn unregister_extension(platform: &str, extension_id: &str) {
    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return;
    };
    let path = ext_dir.join("extensions.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(arr) = val.as_array() else {
        return;
    };
    let kept: Vec<Value> = arr
        .iter()
        .filter(|item| {
            item.get("identifier")
                .and_then(|i| i.get("id"))
                .and_then(|id| id.as_str())
                != Some(extension_id)
        })
        .cloned()
        .collect();
    if kept.len() != arr.len() {
        let _ = fs::write(&path, serde_json::to_string_pretty(&kept).unwrap_or_default());
    }
}

/// 从 .obsolete 移除指定扩展 id 的废弃标记。
/// VS Code 扩展扫描器启动时读这个文件：目录名在 obsolete 列表里的扩展直接跳过——
/// 手动放置的语言包若被标记（卸载残留/扫描异常），目录和 package.json 都合法
/// 也不会被加载，现象是"装了但扩展面板看不到"。
pub(super) fn clear_obsolete_mark(platform: &str, extension_id: &str) {
    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return;
    };
    let path = ext_dir.join(".obsolete");
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, Value>>(&raw) else {
        return;
    };
    let keys: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with(extension_id))
        .cloned()
        .collect();
    for k in keys {
        map.remove(&k);
    }
    let _ = fs::write(&path, serde_json::to_string(&map).unwrap_or_default());
}

pub(super) fn install_language_pack(platform: &str) -> Result<bool, String> {
    if lang_pack_installed(platform) {
        return Ok(false);
    }
    let Some(engine) = engine_version(platform) else {
        return Err("无法读取 IDE 引擎版本，请在扩展市场手动安装语言包".to_string());
    };
    let engine_ver = parse_semver_prefix(&engine);

    // 清理不兼容的旧语言包（如高于当前引擎或落后过多）：对当前引擎无效，
    // 留着会让 VS Code 的语言包选择器选中它导致界面回退英文。
    // 重命名为点前缀目录（VS Code 忽略隐藏目录），不直接删用户文件。
    if let Some(ext_dir) = ide_extensions_dir(platform) {
        if let (Some(want_ver), Ok(entries)) = (engine_ver, fs::read_dir(&ext_dir)) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let Some(rest) = name.strip_prefix(LANG_PACK_DIR_PREFIX) else {
                    continue;
                };
                let compatible = parse_semver_prefix(rest)
                    .map(|ver| is_lang_pack_compatible(ver, want_ver))
                    .unwrap_or(false);
                if !compatible {
                    let renamed = e.path().with_file_name(format!(".incompatible-{}", name));
                    let _ = fs::rename(e.path(), &renamed);
                }
            }
        }
        // 登记表同步：移除该 id 的全部条目，否则登记指向已隔离的目录，
        // 扩展面板持续报 "Unable to read file"（重装 IDE 都消不掉）。
        unregister_extension(platform, LANG_PACK_EXTENSION_ID);
    }

    // apply 是同步命令，语言包下载用 blocking 客户端；
    // apply_system_proxy 只接受异步 ClientBuilder，这里手动接入系统代理
    // （apply_system_proxy 内部同样只读 WinINET 注册表代理）。
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent("AnyBridge-Desktop-Client")
        .timeout(std::time::Duration::from_secs(60));
    if let Some(proxy_url) = crate::commands::windows_user_proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let ext_api = "https://open-vsx.org/api/ms-ceintl/vscode-language-pack-zh-hans";
    let val: Value = client
        .get(ext_api)
        .send()
        .map_err(|e| format!("请求 Open VSX 失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Open VSX 响应异常: {e}"))?
        .json()
        .map_err(|e| format!("解析 Open VSX 响应失败: {e}"))?;
    let all = val
        .get("allVersions")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "Open VSX 响应缺少 allVersions".to_string())?;

    // 选与 IDE 引擎兼容的最大版本（优先同 minor，缺发时向下兼容至多 5 个 minor）
    let Some(version) = pick_compatible_lang_pack_version(
        all.keys().map(String::as_str),
        &engine,
    ) else {
        return Err(format!(
            "Open VSX 上没有与 IDE 引擎 {engine} 匹配的中文语言包版本，请在扩展市场手动安装"
        ));
    };

    // 拿该版本详情 → VSIX 下载地址
    let detail: Value = client
        .get(format!("{}/{}", ext_api, version))
        .send()
        .map_err(|e| format!("请求语言包详情失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("语言包详情响应异常: {e}"))?
        .json()
        .map_err(|e| format!("解析语言包详情失败: {e}"))?;
    let vsix_url = detail
        .get("files")
        .and_then(|f| f.get("download"))
        .and_then(|d| d.as_str())
        .ok_or_else(|| "Open VSX 响应缺少 VSIX 下载地址".to_string())?
        .to_string();

    let cache = cache_dir(platform);
    let vsix_path = cache.join("language-pack.vsix");
    let bytes = client
        .get(&vsix_url)
        .send()
        .map_err(|e| format!("下载语言包 VSIX 失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("语言包 VSIX 下载异常: {e}"))?
        .bytes()
        .map_err(|e| format!("读取语言包 VSIX 失败: {e}"))?;
    fs::write(&vsix_path, &bytes).map_err(|e| format!("保存 VSIX 失败: {e}"))?;

    let Some(ext_dir) = ide_extensions_dir(platform) else {
        return Err("未找到 IDE 扩展目录，无法安装语言包".to_string());
    };
    let target = ext_dir
        .join(format!("ms-ceintl.vscode-language-pack-zh-hans-{version}"));
    let _ = fs::remove_dir_all(&target); // 旧半截安装清理
    unzip_extension(&vsix_path, &target)?;
    let _ = fs::remove_file(&vsix_path);
    // 解压成功还不够：.obsolete 里若有该 id 的废弃标记，VS Code 扫描器会跳过加载，
    // 必须清掉（卸载残留/扫描异常都可能留下标记）。
    clear_obsolete_mark(platform, LANG_PACK_EXTENSION_ID);
    // 注册到 languagepacks.json（VS Code 1.90+ 语言包解析机制）：启动时 IDE 按
    // 此文件把 locale 映射到语言包扩展，不注册 = 装了也不生效。
    register_language_pack(platform, &target);
    Ok(true)
}

/// 转成 IDE languagepacks.json 里的路径格式（小写盘符 + 反斜杠）。
pub(super) fn to_ide_path(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('/', "\\");
    if s.len() > 1 && s.as_bytes()[1] == b':' {
        s = s[..1].to_lowercase() + &s[1..];
    }
    s
}

/// 在指定 state 目录写入 languagepacks.json。
/// 优先从 `pack_dir/package.json` 读取真实语义版本号计算 MD5（避免 `-universal` 后缀错位），
/// 并以传入的真实 `pack_dir` 拼接 `translations` 绝对路径。
pub(super) fn register_language_pack_at(state: &Path, pack_dir: &Path) {
    let pkg: Value = fs::read_to_string(pack_dir.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let Some(loc) = pkg
        .get("contributes")
        .and_then(|c| c.get("localizations"))
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
    else {
        return;
    };
    let Some(language_id) = loc.get("languageId").and_then(|v| v.as_str()) else {
        return;
    };
    let label = loc
        .get("localizedLanguageName")
        .and_then(|v| v.as_str())
        .unwrap_or(language_id);
    let dir_ver = pack_dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(LANG_PACK_DIR_PREFIX))
        .map(|s| s.trim_start_matches('-'))
        .map(|s| s.strip_suffix("-universal").unwrap_or(s))
        .unwrap_or("");
    let version = pkg
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(dir_ver);
    if version.is_empty() {
        return;
    }

    // translations: {扩展id: 翻译文件绝对路径}（IDE 格式：小写盘符 + 反斜杠）
    let mut translations = serde_json::Map::new();
    if let Some(items) = loc.get("translations").and_then(|t| t.as_array()) {
        for item in items {
            let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(rel) = item.get("path").and_then(|v| v.as_str()) else {
                continue;
            };
            let abs = pack_dir.join(rel.trim_start_matches("./"));
            translations.insert(id.to_string(), json!(to_ide_path(&abs)));
        }
    }

    let _ = fs::create_dir_all(state);
    let path = state.join("languagepacks.json");
    // hash 算法实测复刻：IDE 用 md5(扩展id + 版本)（无分隔符直接拼接）。
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(LANG_PACK_EXTENSION_ID.as_bytes());
    hasher.update(version.as_bytes());
    let hash = hex::encode(hasher.finalize());

    let mut doc: serde_json::Map<String, Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    doc.insert(
        language_id.to_string(),
        json!({
            "hash": hash,
            "extensions": [{
                "extensionIdentifier": {"id": LANG_PACK_EXTENSION_ID, "uuid": LANG_PACK_EXTENSION_ID},
                "version": version,
            }],
            "translations": Value::Object(translations),
            "label": label,
        }),
    );
    let _ = write_atomic(&path, &serde_json::to_string(&doc).unwrap_or_default());
}

/// 在 languagepacks.json 注册语言包（user-data-dir 下）。
pub(super) fn register_language_pack(platform: &str, pack_dir: &Path) {
    let Some(state) = ide_state_dir(platform) else {
        return;
    };
    register_language_pack_at(&state, pack_dir);
}
