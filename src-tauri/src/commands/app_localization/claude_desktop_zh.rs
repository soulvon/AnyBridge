use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use super::*;
use super::workbench_checks::*;

/// Claude Desktop 的 ion-dist 目录（前端资源根）。
/// 官网安装版优先（%LOCALAPPDATA%\AnthropicClaude 最新版本目录），
/// 商店版（MSIX/WindowsApps）通过 Appx 清单定位。
#[cfg(target_os = "windows")]
pub(super) fn claude_ion_dist_dir() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // 1. 官网安装版：按版本目录精准定位
    if let Some(local) = dirs::data_local_dir() {
        let root = local.join("AnthropicClaude");
        if root.is_dir() {
            if let Some(found) = pick_claude_ion_dist(&root) {
                return Some(found);
            }
        }
    }
    // 2. 商店版：Appx InstallLocation/app/resources/ion-dist
    // 包名用 "*Claude*" 通配符：精确名 'Claude' 在部分机器上匹配不到商店版包。
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-AppxPackage -Name '*Claude*' | Where-Object { $_.InstallLocation } | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
        ])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let install = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !install.is_empty() {
        let p = PathBuf::from(install)
            .join("app")
            .join("resources")
            .join("ion-dist");
        if p.join("index.html").exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub(super) fn claude_ion_dist_dir() -> Option<PathBuf> {
    // macOS: /Applications/Claude.app/Contents/Resources/app/resources/ion-dist
    let p = PathBuf::from(
        "/Applications/Claude.app/Contents/Resources/app/resources/ion-dist",
    );
    if p.join("index.html").exists() {
        return Some(p);
    }
    None
}

/// 注入标记：index.html 里出现它即视为已汉化（也是 keeper 的判据）。
pub(super) const CLAUDE_ZH_MARKER: &str = "__anybridgeZh3";
/// Claude 注入的语言 locale。
pub(super) const CLAUDE_ZH_LOCALE: &str = "zh-Hans";

/// 授权目录/文件的写权限（MSIX 的 WindowsApps 受保护目录）。
/// 目录用 (OI)(CI) 让新建文件继承；文件单独授权才能改写已存在的 index.html。
#[cfg(target_os = "windows")]
pub(super) fn grant_acl(path: &Path, is_dir: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let hidden = 0x0800_0000;
    let p = path.to_string_lossy().to_string();
    let suffix = if is_dir { ":(OI)(CI)F" } else { ":F" };
    let _ = std::process::Command::new("takeown.exe")
        .args(["/F", &p, "/A"])
        .creation_flags(hidden)
        .status();
    let mut grants = vec!["Administrators".to_string(), "*S-1-5-32-544".to_string()];
    if let Ok(user) = std::env::var("USERNAME") {
        grants.push(user);
    }
    for who in grants {
        let _ = std::process::Command::new("icacls.exe")
            .args([&p, "/grant", &format!("{}{}", who, suffix)])
            .creation_flags(hidden)
            .status();
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn grant_acl(_path: &Path, _is_dir: bool) -> Result<(), String> {
    Ok(())
}

/// 扫描 ion-dist 找语言 store 模块与导出别名。
///
/// Claude 每次升级都会重新混淆打包，模块文件名与导出别名都会变
/// （1.49585 是 shared-3-DO6JrgpN.js / Rd，3.6556 是 shared-52-uHFNjl7C.js / Wp），
/// 所以必须运行时按特征扫描，不能硬编码。
pub(super) fn detect_claude_store(dist: &Path) -> Option<(String, String)> {
    let assets = dist.join("assets");
    let mut stack = vec![assets];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("js") {
                continue;
            }
            let Ok(src) = fs::read_to_string(&p) else {
                continue;
            };
            // 语言 store 的初始化特征
            if !src.contains("messagesLocale:null") {
                continue;
            }
            let Some((sym, exp)) = extract_store_symbols(&src) else {
                continue;
            };
            let _ = sym;
            let rel = p
                .strip_prefix(dist)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            return Some((rel, exp));
        }
    }
    None
}

/// 从 store 模块源码提取「store 变量符号」与「导出别名」。
/// 形如：`...,Oy=Oi((e,t)=>({messages:{},messagesLocale:null,...` + `export{... Oy as Wp ...}`
pub(super) fn extract_store_symbols(src: &str) -> Option<(String, String)> {
    let anchor = src.find("messagesLocale:null")?;
    // store 定义形如：`...,js=Dn((e,t)=>({messages:{},messagesLocale:null...`
    // 取 anchor 之前**最靠后**的 `符号=函数((e,t)=>(` 匹配。
    let head = &src[..anchor];
    let re_def = regex::Regex::new(r"([$\w]+)\s*=\s*[$\w]+\s*\(\(e,t\)\s*=>").ok()?;
    let sym = re_def
        .captures_iter(head)
        .last()?
        .get(1)?
        .as_str()
        .to_string();
    let escaped = sym.replace('$', "\\$");
    let re = regex::Regex::new(&format!(
        r"[,{{]\s*{}\s+as\s+([$\w]+)\s*[,}}]",
        escaped
    ))
    .ok()?;
    let exp = re.captures(src)?.get(1)?.as_str().to_string();
    Some((sym, exp))
}

/// 生成注入脚本：声明 zh-Hans 目录（meta 要求 **两段** hash `locale:h1.h2`），
/// 再调 store 的 setLocaleOverride 切语言。
/// 词典已就位于 /i18n/zh-Hans.json，前端按 locale 自行请求，故脚本极小。
pub(super) fn claude_inject_snippet(store_rel: &str, store_export: &str) -> String {
    format!(
        r#"
<script>
/* AnyBridge Claude 中文注入：声明 zh-Hans 目录（两段 hash）并运行时切换语言。
   词典位于 /i18n/{{locale}}.json，前端自行加载。 marker: {marker} */
(function(){{
  if(window.{marker}) return; window.{marker}=1;
  function declare(){{
    try{{
      var m=document.querySelector('meta[name="i18n-catalogs"]');
      if(!m){{ m=document.createElement('meta'); m.name='i18n-catalogs'; document.head.appendChild(m); }}
      var cur=m.getAttribute('data-i18n-catalogs')||'';
      if(!/(^|,){locale}:/.test(cur)){{
        m.setAttribute('data-i18n-catalogs',(cur?cur+',':'')+'{locale}:1.1');
      }}
    }}catch(e){{}}
  }}
  async function applyZh(){{
    try{{
      declare();
      var mod=await import('/{store_rel}');
      var store=mod['{store_export}'];
      if(!store||typeof store.getState!=='function'){{ console.warn('[anybridge-zh] store missing'); return; }}
      var st=store.getState();
      if(typeof st.setLocaleOverride!=='function'){{ console.warn('[anybridge-zh] api missing'); return; }}
      if(st.localeOverride!=='{locale}'){{ st.setLocaleOverride('{locale}'); }}
      console.info('[anybridge-zh] applied');
    }}catch(e){{ console.warn('[anybridge-zh] failed:', e && (e.message||e)); }}
  }}
  document.addEventListener('DOMContentLoaded',function(){{ declare(); applyZh(); }});
  window.addEventListener('load',function(){{ declare(); applyZh(); }});
  var n=0,t=setInterval(function(){{ declare(); if(n===0||n===10||n===20||n===30) applyZh(); if(++n>50) clearInterval(t); }},300);
}})();
</script>
"#,
        marker = CLAUDE_ZH_MARKER,
        locale = CLAUDE_ZH_LOCALE,
        store_rel = store_rel,
        store_export = store_export,
    )
}

/// 剥离 index.html 里我们注入的脚本（幂等重注入用）。
///
/// 与注入格式互逆：注入片段是 `"\n<script>…</script>\n"`（插在 </head> 前），
/// 剥离必须把这两个换行一并吸掉，否则每轮「注入→剥离」净漏 2 字节
/// （Claude 没有 index.html 完整性校验，泄漏无症状但文件会慢性膨胀）。
pub(super) fn claude_strip_inject(html: &str) -> String {
    let re = regex::Regex::new(
        r"(?s)\n?<script>\s*/\* AnyBridge Claude 中文注入.*?</script>\n?",
    )
    .unwrap();
    re.replace_all(html, "").to_string()
}

/// 注入（或刷新）index.html 的脚本，返回是否有改动。
pub(super) fn claude_inject_index(dist: &Path, snippet: &str) -> Result<bool, String> {
    let idx = dist.join("index.html");
    let raw = fs::read_to_string(&idx).map_err(|e| format!("读取 index.html 失败: {e}"))?;
    let cleaned = claude_strip_inject(&raw);
    let injected = if let Some(pos) = cleaned.find("</head>") {
        let mut out = String::with_capacity(cleaned.len() + snippet.len());
        out.push_str(&cleaned[..pos]);
        out.push_str(snippet);
        out.push_str(&cleaned[pos..]);
        out
    } else {
        format!("{cleaned}{snippet}")
    };
    if injected == raw {
        return Ok(false);
    }
    // index.html 是已存在文件，必须单文件授权（目录 inherit 只对新文件生效）
    grant_acl(&idx, false)?;
    fs::write(&idx, injected.as_bytes()).map_err(|e| format!("写入 index.html 失败: {e}"))?;
    Ok(true)
}

/// 写 Claude 的中文词典文件：/i18n/zh-Hans.json 与 /i18n/dynamic/zh-Hans.json。
/// 返回写入的 base 词条数。
pub(super) fn claude_write_zh_dicts(dist: &Path) -> Result<usize, String> {
    let cache = cache_dir("claude-desktop");
    let dict_path = cache.join(script_cache_name("claude-desktop"));
    let raw = fs::read_to_string(&dict_path).map_err(|_| {
        "本地暂无中文词库，请先点击「检查在线词库更新」下载".to_string()
    })?;
    let va: Value =
        serde_json::from_str(&raw).map_err(|e| format!("词库缓存解析失败: {e}"))?;
    let map = va.as_object().ok_or("词库缓存格式异常（非 JSON 对象）")?;
    if map.is_empty() {
        return Err("词库缓存为空，已中止写入".to_string());
    }

    let i18n = dist.join("i18n");
    let dynamic = i18n.join("dynamic");
    let _ = fs::create_dir_all(&dynamic);
    grant_acl(&i18n, true)?;

    let base_out = serde_json::to_string(&va).map_err(|e| e.to_string())?;
    fs::write(i18n.join(format!("{CLAUDE_ZH_LOCALE}.json")), base_out.as_bytes())
        .map_err(|e| format!("写入 zh-Hans 词典失败: {e}"))?;

    // dynamic 词典：缓存目录里若有 dynamic 就用，否则空对象兜底
    let dyn_src = cache.join("dynamic-zh-CN.json");
    let dyn_out = fs::read_to_string(&dyn_src)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));
    fs::write(
        dynamic.join(format!("{CLAUDE_ZH_LOCALE}.json")),
        serde_json::to_string(&dyn_out).unwrap_or_else(|_| "{}".to_string()).as_bytes(),
    )
    .map_err(|e| format!("写入 dynamic 词典失败: {e}"))?;

    Ok(map.len())
}

/// Claude 的用户配置文件（config.json，含 locale 字段）。
pub(super) fn claude_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Claude").join("config.json"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().map(|h| {
            h.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("config.json")
        })
    }
}

/// 把 config.json 的 locale 设为指定值（幂等），返回是否有改动。
/// Claude 升级会重写该文件，因此每次 apply 都要重设。
pub(super) fn claude_set_locale(locale: &str, restore: bool) -> Result<bool, String> {
    let Some(cfg) = claude_config_path() else {
        return Ok(false);
    };
    if !cfg.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&cfg).map_err(|e| format!("读取 config.json 失败: {e}"))?;
    let mut doc: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // 解析失败绝不覆盖用户配置
        Err(_) => return Err("Claude config.json 解析失败，已跳过语言设置".to_string()),
    };
    let cur = doc.get("locale").and_then(|v| v.as_str()).unwrap_or("");
    let target = if restore { "en-US" } else { locale };
    if cur == target {
        return Ok(false);
    }
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("locale".to_string(), json!(target));
    }
    // 备份一次原始配置，便于排查
    let bak = cfg.with_extension("json.anybridge-bak");
    if !bak.exists() {
        let _ = fs::write(&bak, raw.as_bytes());
    }
    fs::write(&cfg, serde_json::to_string_pretty(&doc).unwrap_or(raw).as_bytes())
        .map_err(|e| format!("写入 config.json 失败: {e}"))?;
    Ok(true)
}

/// Claude 是否已汉化：index.html 里有我们的注入标记且 zh-Hans 词典就位。
/// 用注入标记而不是"中文字符数"，因为升级会覆盖整个目录，标记随之消失。
pub(super) fn is_claude_localized() -> bool {
    let Some(dist) = claude_ion_dist_dir() else {
        return false;
    };
    let Ok(html) = fs::read_to_string(dist.join("index.html")) else {
        return false;
    };
    if !html.contains(CLAUDE_ZH_MARKER) {
        return false;
    }
    dist.join("i18n")
        .join(format!("{CLAUDE_ZH_LOCALE}.json"))
        .exists()
}
