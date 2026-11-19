use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[cfg(not(test))]
use super::antigravity::{
    antigravity_hub_config_dir, antigravity_ide_config_dir,
    antigravity_managed_endpoint_from_settings, is_anybridge_managed_endpoint,
};


/// 白底 Hub 端点补丁的目标 asar 节点。
/// 2.32.1 起 `--cloud_code_endpoint` 的端点常量移到 dist/lsDefaults.js，
/// 旧版仍在 dist/languageServer.js；两者并存时优先新节点。
pub(crate) fn hub_endpoint_node_name(header: &Value) -> Option<&'static str> {
    ["lsDefaults.js", "languageServer.js"]
        .into_iter()
        .find(|name| header.pointer(&format!("/files/dist/files/{name}")).is_some())
}


pub(crate) fn patch_antigravity_hub_asar(asar_path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};

    // ── 轻量预检：只读 header + 端点节点段（几 MB），
    //    已打补丁时直接返回。原先每次接入都全量读几百 MB 的 asar 做幂等检查，
    //    这是「一键接入 / 停止接入」点击后卡顿数秒的主要来源。
    let mut f = fs::File::open(asar_path).map_err(|e| format!("读取 asar 失败: {e}"))?;
    let mut head16 = [0u8; 16];
    f.read_exact(&mut head16).map_err(|e| format!("读取 asar 头失败: {e}"))?;
    let json_size = u32::from_le_bytes(head16[12..16].try_into().unwrap()) as usize;
    if json_size == 0 || json_size > 64 * 1024 * 1024 {
        return Err("asar header 大小异常".to_string());
    }

    let mut header_bytes = vec![0u8; 16 + json_size];
    f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    f.read_exact(&mut header_bytes).map_err(|e| format!("读取 asar header 失败: {e}"))?;
    let header_str = std::str::from_utf8(&header_bytes[16..])
        .map_err(|e| format!("解析 asar header utf8 失败: {e}"))?;
    let header: Value =
        serde_json::from_str(header_str).map_err(|e| format!("解析 asar header json 失败: {e}"))?;

    let node_name = hub_endpoint_node_name(&header).ok_or_else(|| {
        "未在 asar 中找到 dist/lsDefaults.js 或 dist/languageServer.js 节点".to_string()
    })?;
    let ls_probe = header
        .pointer(&format!("/files/dist/files/{node_name}"))
        .cloned()
        .ok_or_else(|| format!("未在 asar 中找到 dist/{node_name} 节点"))?;
    let offset: usize = ls_probe
        .get("offset")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let ls_size: usize = ls_probe.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let declared_header_size = u32::from_le_bytes(head16[4..8].try_into().unwrap()) as usize;
    let payload_start = crate::commands::antigravity_localization::asar_payload_start(declared_header_size);
    if ls_size == 0 || ls_size > 256 * 1024 * 1024 {
        return Err("languageServer.js 段大小异常".to_string());
    }

    // 只读 LS 段做轻量幂等预检。只认当前版本 marker：老版本留下的旧注入
    // 仍含 jetski.cloudCodeUrl，但必须继续走下面全量路径自愈成新版注入。
    f.seek(SeekFrom::Start((payload_start + offset) as u64))
        .map_err(|e| e.to_string())?;
    let mut ls_buf = vec![0u8; ls_size];
    f.read_exact(&mut ls_buf).map_err(|e| format!("读取 languageServer.js 失败: {e}"))?;
    if std::str::from_utf8(&ls_buf)
        .map(|c| c.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION))
        .unwrap_or(false)
    {
        // 已是当前版本补丁：无需重写 asar（从秒级降到毫秒级）
        return Ok(());
    }
    drop(f);

    // ── 未打补丁（或旧版注入格式）→ 全量读文件走注入路径
    let bytes = fs::read(asar_path).map_err(|e| format!("读取 asar 失败: {e}"))?;
    if bytes.len() < 16 {
        return Err("asar 文件太小".to_string());
    }
    let header_str = std::str::from_utf8(&bytes[16..16 + json_size])
        .map_err(|e| format!("解析 asar header utf8 失败: {e}"))?;
    let mut header: Value =
        serde_json::from_str(header_str).map_err(|e| format!("解析 asar header json 失败: {e}"))?;

    let ls_node = header
        .get_mut("files")
        .and_then(|f| f.get_mut("dist"))
        .and_then(|d| d.get_mut("files"))
        .and_then(|f| f.get_mut(node_name))
        .and_then(|n| n.as_object_mut())
        .ok_or_else(|| format!("未在 asar 中找到 dist/{node_name} 节点"))?;

    let offset: usize = ls_node
        .get("offset")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let size: usize = ls_node.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    // payload 基准 = 8 + bytes[4..8]（pickle 声明的 header 总长，已含对齐填充）
    let declared_header_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let payload_start = crate::commands::antigravity_localization::asar_payload_start(declared_header_size);
    if bytes.len() < payload_start + offset + size {
        return Err("asar payload 越界".to_string());
    }
    let original_code =
        std::str::from_utf8(&bytes[payload_start + offset..payload_start + offset + size])
            .map_err(|e| format!("解析 languageServer.js 失败: {e}"))?;

    // 变换逻辑抽成纯函数（patch_hub_language_server_code），便于单测覆盖
    // 老版本的任意缩进/换行/引号/端点域名，以及历史注入自愈。
    let new_code = patch_hub_language_server_code(original_code)?;

    let bak_path = asar_path.with_file_name("app.asar.official.bak");
    if !bak_path.exists() {
        let _ = fs::copy(asar_path, &bak_path);
    }

    let new_code_bytes = new_code.as_bytes();
    let old_payload = &bytes[payload_start..];
    let new_offset = old_payload.len();

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(new_code_bytes);
    let hash_hex = hex::encode(hasher.finalize());

    ls_node.insert(
        "offset".to_string(),
        serde_json::json!(new_offset.to_string()),
    );
    ls_node.insert("size".to_string(), serde_json::json!(new_code_bytes.len()));
    ls_node.insert(
        "integrity".to_string(),
        serde_json::json!({
            "algorithm": "SHA256",
            "hash": hash_hex.clone(),
            "blockSize": 4194304,
            "blocks": [hash_hex]
        }),
    );

    let new_header_json = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    let new_header_bytes = new_header_json.as_bytes();
    let new_json_size = new_header_bytes.len() as u32;
    // header 之后必须补 0..3 字节填充到 4 字节对齐，否则 Electron 读取整体错位
    let padding_len = crate::commands::antigravity_localization::asar_padding_len(new_header_bytes.len());

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
        .map_err(|e| format!("写入 asar 补丁失败: {e}"))?;
    Ok(())
}


// ──────────────────────────────────────────────────────────
// 黑底 IDE（Antigravity IDE）语言服务器端点接管
//
// `jetski.cloudCodeUrl` 只被 IDE 主进程（Electron 侧 CloudCode 服务）消费；
// Agent 面板的语言服务器是独立进程 `agy.exe --hub`，它的端点只认
// `--cloud_code_endpoint` 参数或 `CLOUD_CODE_URL` 环境变量。实测（2026-11-10）：
// 不接管时 LS 全部请求直连 daily-cloudcode-pa.googleapis.com，网关注入的 byok
// 模型在 LS 的模型表里不存在，选中即报
// `failed to construct executor: unknown model key ...: model not found`，
// 斜杠命令同样挂掉——这正是「一键接入显示已接入但会话崩溃」的假接入。
//
// 修复：在 IDE 扩展的 buildServerEnv（构造 agy.exe 启动环境的函数）里注入一段
// 自包含读取逻辑：从 settings.json 的 `jetski.cloudCodeUrl` 取端点写入
// serverEnv.CLOUD_CODE_URL。白底 Hub 走 patch_antigravity_hub_asar 的
// languageServer.js 注入（`--cloud_code_endpoint`），与此互不影响。
//
// 两个铁律（白底 asar 补丁踩过的坑原样适用）：
//   1. 注入代码必须自带 require("fs")/require("os")——客户端升级后
//      extension.js 顶部导入与 minify 变量名（如 Ia/fd/$c）都可能改名，
//      引用外部标识符会抛 ReferenceError 导致语言服务崩溃循环。
//   2. 手工 setx CLOUD_CODE_URL 不可靠：环境变量块在进程创建时快照，
//      setx 只对 Explorer 之后新启动的进程生效；v0.5.8（4c16b733）删除
//      setx 后本就该走文件补丁，不能再依赖环境变量。
// ──────────────────────────────────────────────────────────

pub(in crate::commands::platforms) const ANTIGRAVITY_IDE_EXTENSION_MARKER: &str = "/*ANYBRIDGE_CLOUD_CODE_URL*/";

pub(in crate::commands::platforms) const ANTIGRAVITY_HUB_ENDPOINT_MARKER: &str = "/*ANYBRIDGE_CLOUD_CODE_ENDPOINT*/";


// 注入块版本：keeper 的幂等判据必须认版本号，否则已接入用户升级后
// 旧的坏注入块永远不会自愈（旧 marker 与新版共用同一字符串）。
//   v2：先清除继承端点 + 按端隔离 settings 候选；
//   v3：修复 v2 里 `names={names}` 未被替换导致注入静默失效的事故。
pub(in crate::commands::platforms) const ANTIGRAVITY_IDE_EXTENSION_VERSION: &str = "/*ANYBRIDGE_CLOUD_CODE_URL_V5*/";

pub(in crate::commands::platforms) const ANTIGRAVITY_HUB_ENDPOINT_VERSION: &str = "/*ANYBRIDGE_CLOUD_CODE_ENDPOINT_V5*/";


/// 注入块：自包含（自带 require/os/homedir、跨平台 settings.json 候选路径），
/// 不引用 minify 内部标识符。运行时动态读 settings.json——接入/还原随
/// `jetski.cloudCodeUrl` 撤键自动生效，补丁本体无需随 URL 变化重打。
///
/// 兼容性（v1.1.0 固化）：
/// - 用户名/主目录全部由 os.homedir() / APPDATA / XDG_CONFIG_HOME 推导，
///   绝不硬编码某个具体用户的主目录或盘符；
/// - 产品目录名覆盖新旧版本（Antigravity IDE / Antigravity / antigravity-ide 等），
///   老版本可能只写其中一种；
/// - 支持便携版 `--user-data-dir=<path>`（从启动参数解析）与显式环境变量
///   ANYBRIDGE_ANTIGRAVITY_SETTINGS（自定义安装路径的最后兜底）；
/// - Windows / macOS / Linux 分别走 APPDATA、Library/Application Support、
///   XDG_CONFIG_HOME 或 ~/.config。
/// 生成「候选 settings.json 路径」的 JS 表达式。
///
/// v1.1.0 事故修复：黑底 IDE 与白底 Hub 是**两个独立客户端**，各有自己的
/// `jetski.cloudCodeUrl`。共用一份候选列表会让黑底 agy.exe 读到白底残留的
/// 本地网关地址（用户只还原了黑底时），网关一停就成了死端点 → userInfo 拿不到
/// → Agent 面板回退「Continue with Google」→ 切号插件失效。因此按端隔离目录名：
/// 黑底只读 IDE 系列，白底只读 Hub 系列。
///
/// `names` 是 JS 数组字面量字符串（如 `["Antigravity IDE","antigravity-ide"]`）。
/// 纯字符串函数，便于门控直接取出交给 Node 解析。
///
/// 注意：这里**故意不用 `format!`**。模板里 `{}` 极多（对象字面量、函数体），
/// 用 format! 必须把每个 `{` 转义成 `{{`，一旦漏转义/多转义就会静默产出坏代码。
/// v1.1.5 事故：`names={names}` 未被替换成真实数组，运行时 `for(const n of names)`
/// 抛 TypeError 被外层 catch 吞掉，注入完全失效（LS 直连官方、BYOK 模型不下发），
/// 而 `node --check` 语法校验因 `{names}` 是合法 shorthand 属性而放行。
/// 改用显式占位符 replace，模板按可读的 JS 原样书写。
pub(in crate::commands::platforms) fn antigravity_settings_candidates_js(names: &str) -> String {
    let template = r#"(function(){const p=require("path"),os=require("os"),h=os.homedir(),env=process.env,names=__AB_NAMES__,roots=[],cands=[];if(env.ANYBRIDGE_ANTIGRAVITY_SETTINGS)cands.push(env.ANYBRIDGE_ANTIGRAVITY_SETTINGS);const av=process.argv||[];for(let i=0;i<av.length;i++){const a=av[i];if(a==="--user-data-dir"&&av[i+1])cands.push(p.join(av[i+1].replace(/^"(.*)"$/,"$1"),"User","settings.json"));else{const m=/^--user-data-dir=(.+)$/.exec(a);if(m)cands.push(p.join(m[1].replace(/^"(.*)"$/,"$1"),"User","settings.json"))}}if(process.platform==="win32"){if(env.APPDATA)roots.push(env.APPDATA);roots.push(p.join(h,"AppData","Roaming"));if(env.LOCALAPPDATA)roots.push(env.LOCALAPPDATA)}else if(process.platform==="darwin"){roots.push(p.join(h,"Library","Application Support"));if(env.XDG_CONFIG_HOME)roots.push(env.XDG_CONFIG_HOME);roots.push(p.join(h,".config"))}else{if(env.XDG_CONFIG_HOME)roots.push(env.XDG_CONFIG_HOME);roots.push(p.join(h,".config"));if(env.XDG_DATA_HOME)roots.push(env.XDG_DATA_HOME);roots.push(p.join(h,".local","share"))}for(const r of roots){for(const n of names)cands.push(p.join(r,n,"User","settings.json"));cands.push(p.join(r,"User","settings.json"))}return cands})()"#;
    template.replace("__AB_NAMES__", names)
}


/// settings.json 读取片段（JSONC 容错，黑底/白底注入模板共用，收敛到一处）。
///
/// 2026-11-14 真机事故：VSCode 系 settings.json 是 JSONC——注释与尾逗号合法，
/// 客户端自己按 JSONC 读没问题；注入块却用严格 JSON.parse，真机文件里一个
/// 尾逗号就让 parse 抛错被 catch 吞掉 → 注入静默回退官方端点 → LS 直连官方、
/// BYOK 失效。且此前所有运行时测试都走 ANYBRIDGE_ANTIGRAVITY_SETTINGS 覆盖
/// 路径，默认候选扫描从未在真实文件形状上验证过，测试全绿真机仍失效。
/// 因此：先严格 parse（快速路径），失败后剥块注释/行注释（`[^:"']` 守卫
/// 不误伤 `https://`）与尾逗号再重试一次。
pub(in crate::commands::platforms) fn antigravity_settings_read_js() -> String {
    let template = r#"(function(){let t="";try{t=fs.readFileSync(f,"utf8")}catch(_){return undefined}try{return JSON.parse(t)["jetski.cloudCodeUrl"]}catch(_){}const s=t.replace(/\/\*[\s\S]*?\*\//g,"").replace(/(^|[^:"'])\/\/[^\r\n]*/g,"$1").replace(/,(\s*[}\]])/g,"$1");try{return JSON.parse(s)["jetski.cloudCodeUrl"]}catch(_){}return undefined})()"#;
    template.to_string()
}


pub(in crate::commands::platforms) const ANTIGRAVITY_IDE_SETTINGS_NAMES: &str =
    r#"["Antigravity IDE","antigravity-ide","Antigravity-IDE"]"#;

pub(in crate::commands::platforms) const ANTIGRAVITY_HUB_SETTINGS_NAMES: &str = r#"["Antigravity","antigravity"]"#;


/// 黑底 IDE 注入块：给 buildServerEnv 返回的 env 对象补 CLOUD_CODE_URL。
///
/// 关键：先 `delete e.CLOUD_CODE_URL`。buildServerEnv 通常以
/// `{...process.env}` 起步，父进程（IDE 主进程）可能继承了接入时留下的
/// 会话级/用户级 CLOUD_CODE_URL。若只在有 settings 值时覆盖、无值时什么都不做，
/// 用户「停止接入」撤键后脏值仍留在 env 里，agy.exe 会继续把 Cloud Code
/// 指向已停掉的本地网关 → loadCodeAssist/userInfo 全部失败 → 面板回退
/// 「Continue with Google」→ 切号插件失效（v1.1.0 实测事故）。
pub(in crate::commands::platforms) fn antigravity_ide_extension_injection() -> String {
    // 与候选片段同样用 replace 而非 format!：模板里花括号密集，
    // 一处漏转义就会静默产出坏代码（v1.1.5 `{names}` 事故）。
    let template = r#"(function(e){try{delete e.CLOUD_CODE_URL}catch(_){}try{const fs=require("fs"),cands=__AB_CANDS__;for(const f of cands){if(!f)continue;try{if(!fs.existsSync(f))continue;const v=__AB_READ__;if(typeof v==="string"&&v.trim()&&/^https?:/i.test(v.trim())){e.CLOUD_CODE_URL=v.trim();break}}catch(_){}}}catch(_){}return e}__AB_V2____AB_MARKER__)"#;
    template
        .replace(
            "__AB_CANDS__",
            &antigravity_settings_candidates_js(ANTIGRAVITY_IDE_SETTINGS_NAMES),
        )
        .replace("__AB_READ__", &antigravity_settings_read_js())
        .replace("__AB_V2__", ANTIGRAVITY_IDE_EXTENSION_VERSION)
        .replace("__AB_MARKER__", ANTIGRAVITY_IDE_EXTENSION_MARKER)
}


/// 白底 Hub 的 languageServer.js 注入块：返回端点字符串（自带 require，
/// 不依赖文件顶部导入；electron.app 不可用时有 os.homedir 兜底）。
///
/// fallback 只回官方常量，**绝不读 process.env.CLOUD_CODE_URL**：那个变量
/// 常是接入时遗留的本地网关地址，撤键后会把 language_server.exe 钉在死端点上。
pub(in crate::commands::platforms) fn antigravity_hub_endpoint_injection() -> String {
    let template = r#"(() => { try { const fs=require("fs"),cands=__AB_CANDS__;for(const f of cands){if(!f)continue;try{if(!fs.existsSync(f))continue;const v=__AB_READ__;if(typeof v==="string"&&v.trim()&&/^https?:/i.test(v.trim()))return v.trim();}catch(_){}} } catch(_) {} return 'https://daily-cloudcode-pa.googleapis.com'; })()__AB_V2____AB_MARKER__"#;
    template
        .replace(
            "__AB_CANDS__",
            &antigravity_settings_candidates_js(ANTIGRAVITY_HUB_SETTINGS_NAMES),
        )
        .replace("__AB_READ__", &antigravity_settings_read_js())
        .replace("__AB_V2__", ANTIGRAVITY_HUB_ENDPOINT_VERSION)
        .replace("__AB_MARKER__", ANTIGRAVITY_HUB_ENDPOINT_MARKER)
}


/// 纯函数：把白底 languageServer.js 里 `--cloud_code_endpoint` 的官方端点
/// 替换为动态注入表达式。兼容任意缩进、LF/CRLF、单双引号、任意官方端点域名、
/// 以及历史版本留下的旧注入表达式（自愈）。找不到参数时明确报错。
pub(in crate::commands::platforms) fn patch_hub_language_server_code(code: &str) -> Result<String, String> {
    // 只认当前版本；旧版注入必须走下面的正则自愈重新生成。
    if code.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION) {
        return Ok(code.to_string());
    }
    // 匹配形如：'--cloud_code_endpoint',\n  'https://...',  或旧版注入 IIFE。
    // 引号可为单/双引号；端点值可为任意域名；缩进/换行任意。
    // 旧注入 IIFE 后可能跟着版本/幂等注释（如 /*ANYBRIDGE_...*/），
    // 用 [^,\n]*? 吃掉注释直到分隔逗号，否则自愈匹配失败、旧注入无法升级。
    //
    // 不用 (?s)、值分支不跨行、IIFE 体用贪婪 .*：值永远在单行内，贪婪会
    // 越过注入块内部所有 `})()`（如 cands 构建器的 `})();`）终止于行内
    // 最后一个 `})()`，从而把旧版误补丁留下的悬空残尾一并吃掉。
    // 惰性版本会在第一个内层 `})()` 处截断、留下残尾（2026-11-11 真机事故：
    // 白底主进程 SyntaxError 拒绝启动），勿改回。
    let re = regex::Regex::new(
        r#"(['"]--cloud_code_endpoint['"]\s*,\s*)(?:['"][^'"\n]*['"]|\(\(\)\s*=>\s*\{.*\}\)\(\)[^,\n]*?)(\s*,)"#,
    )
    .map_err(|e| format!("正则编译失败: {e}"))?;
    let injection = antigravity_hub_endpoint_injection();
    // 替换串绝不能用 &str 形式：regex 的替换串会把 `$1`/`${name}` 当捕获组
    // 展开，而注入模板里含 JS 字面量 `$1`（JSONC 读取片段/引号剥离的
    // replace 反引引用），展开即产出坏 JS（2026-11-14 事故）。闭包替换
    // 无 `$` 展开，结构上杜绝。
    let mut out = re
        .replace(code, |caps: &regex::Captures| {
            format!("{}{injection}{}", &caps[1], &caps[2])
        })
        .to_string();
    if out == code {
        // 2.32.1+：--cloud_code_endpoint 的取值改为引用 dist/lsDefaults.js 里的
        // exports.LS_CLOUD_CODE_ENDPOINT 常量。只替换常量右侧，baseLsArgs()
        // 的参数数组保持原样；同一份 IIFE 模板在模块加载时求值一次。
        let defaults_re = regex::Regex::new(
            r#"(exports\.LS_CLOUD_CODE_ENDPOINT\s*=\s*)(?:['"][^'"\n]*['"]|\(\(\)\s*=>\s*\{.*\}\)\(\)[^;\n]*?)(\s*;)"#,
        )
        .map_err(|e| format!("lsDefaults 正则编译失败: {e}"))?;
        out = defaults_re
            .replace(code, |caps: &regex::Captures| {
                format!("{}{injection}{}", &caps[1], &caps[2])
            })
            .to_string();
    }
    if out == code {
        return Err(
            "未找到 --cloud_code_endpoint 参数或 LS_CLOUD_CODE_ENDPOINT 常量（客户端结构可能已变化）"
                .to_string(),
        );
    }
    Ok(out)
}


/// 纯函数：把 buildServerEnv 的 `return <env>` 原地包一层注入 IIFE。
///
/// 兼容性（v1.1.0 固化）：老版本客户端的 buildServerEnv 可能是
/// `return c}` / `return c;}` / `return c;\r\n}` / `return _env }`，导出形式可能是
/// `$c.buildServerEnvironment=fd`、`exports.buildServerEnvironment=...` 或
/// `["buildServerEnvironment"]=...`。因此不再假设「return 后紧跟 }」，
/// 而是用正则定位锚点前最后一个 `return <标识符>` 并**原地替换表达式本身**：
/// 后缀（`;}`、`\r\n}` 等）原样保留，天然不会产生两份 return。
///
/// 幂等：已含 marker 直接返回；锚点/return 缺失必须报错，接入流程据此中断防假接入。
pub(in crate::commands::platforms) fn patch_antigravity_extension_code(code: &str) -> Result<String, String> {
    if code.contains(ANTIGRAVITY_IDE_EXTENSION_MARKER) {
        return if antigravity_extension_has_anchor(code) {
            Ok(code.to_string())
        } else {
            Err(
                "客户端 extension.js 已含 AnyBridge 注入但未找到 buildServerEnvironment 锚点（客户端结构可能已变化）"
                    .to_string(),
            )
        };
    }
    let anchor = antigravity_extension_anchor(code).ok_or(
        "未在 extension.js 中找到 buildServerEnvironment 赋值（客户端结构可能已变化）",
    )?;
    let head = &code[..anchor];
    let re = regex::Regex::new(r"return\s+([A-Za-z_$][A-Za-z0-9_$]*)")
        .map_err(|e| format!("正则编译失败: {e}"))?;
    let matched = re
        .captures_iter(head)
        .last()
        .ok_or("未找到 buildServerEnv 的 return 语句")?;
    let whole = matched.get(0).ok_or("return 匹配异常")?;
    let var_name = matched
        .get(1)
        .map(|m| m.as_str())
        .ok_or("未找到 return 的变量名")?;
    // 防止误匹配 `return new Foo()` / `return function()` 之类表达式。
    if ["new", "function", "class", "await", "void", "typeof", "delete"].contains(&var_name) {
        return Err(format!("buildServerEnv return 不是简单变量: {var_name}"));
    }
    let injection = antigravity_ide_extension_injection();
    // 原地替换：前缀 + 新 return 表达式 + 原后缀（含 ; 与 }），只生成一份 return。
    Ok(format!(
        "{}return ({injection})({var_name}){}",
        &head[..whole.start()],
        &code[whole.end()..]
    ))
}


/// 就地剥离任意历史版本的注入，还原成 `return (<var>)` 的原始形态。
///
/// 用于旧补丁升级：客户端升级可能已删掉 `js.anybridge-bak`，不能只依赖备份。
/// 注入形态固定为 `return (` + IIFE + `)(<var>)`，用非贪婪匹配到 marker 结尾。
pub(in crate::commands::platforms) fn strip_antigravity_extension_injection(code: &str) -> Result<String, String> {
    // 注入体以块注释（可能连续多个版本 marker）结尾，随后是 `)(<var>)`。
    // 用 `[\s\S]*?ANYBRIDGE_CLOUD_CODE_URL[\s\S]*?` 锚定 marker 再吃到 `)(var)`，
    // 比单纯 `\}` 更稳（IIFE 内部有多层花括号）。
    let re = regex::Regex::new(
        r#"(?s)return \(\(function\(e\)\{[\s\S]*?ANYBRIDGE_CLOUD_CODE_URL[\s\S]*?\)\(([A-Za-z_$][A-Za-z0-9_$]*)\)"#,
    )
    .map_err(|e| format!("正则编译失败: {e}"))?;
    if !re.is_match(code) {
        return Err("未匹配到已知形态的端点注入".to_string());
    }
    // 还原成原始形态 `return <var>`（不带括号），这样后续
    // patch_antigravity_extension_code 的 return 正则才能重新识别。
    Ok(re.replace(code, "return $1").to_string())
}


/// 定位 buildServerEnvironment 导出锚点，兼容新旧版本的多种写法。
pub(in crate::commands::platforms) fn antigravity_extension_anchor(code: &str) -> Option<usize> {
    for needle in [
        ".buildServerEnvironment",
        "[\"buildServerEnvironment\"]",
        "['buildServerEnvironment']",
        "buildServerEnvironment=",
        "buildServerEnvironment:",
    ] {
        if let Some(i) = code.find(needle) {
            return Some(i);
        }
    }
    None
}


pub(in crate::commands::platforms) fn antigravity_extension_has_anchor(code: &str) -> bool {
    antigravity_extension_anchor(code).is_some()
}


/// Antigravity 安装根目录候选（不含 resources 层）。
///
/// 兼容性（v1.1.0 固化）：
/// - 绝不硬编码用户名或盘符：一律从 dirs::home_dir/data_local_dir 与环境变量推导；
/// - 显式覆盖：ANYBRIDGE_ANTIGRAVITY_IDE_APP_DIR / ANYBRIDGE_ANTIGRAVITY_HUB_APP_DIR
///   直接指向 resources/app（或 .app 内的 Resources/app）目录；
/// - 扫描常见安装父目录里名字含 antigravity 的子目录，覆盖自定义安装路径、
///   不同版本目录名（Antigravity IDE / antigravity-ide / Antigravity 等）；
/// - Windows / macOS / Linux 分别覆盖各自的标准安装布局。
pub(in crate::commands::platforms) fn antigravity_install_app_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let push_unique = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if !p.as_os_str().is_empty() && !out.contains(&p) {
            out.push(p);
        }
    };

    // 1. 显式覆盖（优先级最高）：直接给 app 目录。
    for key in [
        "ANYBRIDGE_ANTIGRAVITY_IDE_APP_DIR",
        "ANYBRIDGE_ANTIGRAVITY_HUB_APP_DIR",
    ] {
        if let Ok(dir) = std::env::var(key) {
            let p = PathBuf::from(&dir);
            push_unique(p.clone(), &mut out);
            // 也允许指向安装根（自动补 resources/app）
            push_unique(p.join("resources").join("app"), &mut out);
        }
    }

    // 2. 老版本/自定义目录名：扫描常见安装父目录。
    let mut scan_parents: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_local_dir() {
            scan_parents.push(local.join("Programs"));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(v) = std::env::var(key) {
                scan_parents.push(PathBuf::from(&v));
                scan_parents.push(PathBuf::from(v).join("Programs"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        scan_parents.push(PathBuf::from("/Applications"));
        if let Some(home) = dirs::home_dir() {
            scan_parents.push(home.join("Applications"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for base in ["/opt", "/usr/share", "/usr/lib", "/usr/local/share"] {
            scan_parents.push(PathBuf::from(base));
        }
        if let Some(home) = dirs::home_dir() {
            scan_parents.push(home.join(".local").join("share"));
            scan_parents.push(home.join(".local").join("opt"));
        }
        if let Ok(v) = std::env::var("XDG_DATA_HOME") {
            scan_parents.push(PathBuf::from(v));
        }
    }

    for parent in scan_parents {
        let entries = match fs::read_dir(&parent) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.contains("antigravity") {
                continue;
            }
            let root = entry.path();
            // Windows 解包布局：<root>/resources/app
            push_unique(root.join("resources").join("app"), &mut out);
            // macOS .app 布局：<root>/Contents/Resources/app
            push_unique(
                root.join("Contents").join("Resources").join("app"),
                &mut out,
            );
            // 已经是 app 目录本身
            push_unique(root.clone(), &mut out);
        }
    }

    // 3. 固定标准路径兜底（即使扫描不到也已覆盖）。
    #[cfg(target_os = "windows")]
    if let Some(local) = dirs::data_local_dir() {
        for name in ["Antigravity IDE", "antigravity", "Antigravity", "antigravity-ide"] {
            push_unique(
                local.join("Programs").join(name).join("resources").join("app"),
                &mut out,
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        for name in [
            "Antigravity IDE.app",
            "Antigravity.app",
            "antigravity-ide.app",
        ] {
            push_unique(
                PathBuf::from("/Applications")
                    .join(name)
                    .join("Contents")
                    .join("Resources")
                    .join("app"),
                &mut out,
            );
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for name in ["antigravity-ide", "antigravity", "Antigravity IDE"] {
            for base in ["/opt", "/usr/share", "/usr/lib"] {
                push_unique(
                    PathBuf::from(base)
                        .join(name)
                        .join("resources")
                        .join("app"),
                    &mut out,
                );
            }
        }
    }
    out
}


/// 黑底 IDE 的 extension.js 候选路径。
#[cfg_attr(test, allow(dead_code))]
pub(in crate::commands::platforms) fn antigravity_ide_extension_candidates() -> Vec<PathBuf> {
    antigravity_install_app_dirs()
        .into_iter()
        .map(|app| {
            app.join("extensions")
                .join("agy")
                .join("vscode")
                .join("extension.js")
        })
        .collect()
}


/// 白底 Hub 的 app.asar 候选路径（供 localization::hub_asar_path 复用）。
pub(crate) fn antigravity_hub_asar_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = std::env::var("ANYBRIDGE_ANTIGRAVITY_HUB_ASAR") {
        out.push(PathBuf::from(dir));
    }
    for app in antigravity_install_app_dirs() {
        // app 目录的上一级就是 resources
        if let Some(resources) = app.parent() {
            let asar = resources.join("app.asar");
            if !out.contains(&asar) {
                out.push(asar);
            }
        }
    }
    out
}


/// 客户端升级会整包覆盖 `app.asar` / `extensions/agy/vscode/extension.js`，
/// 两个端点补丁随之丢失，导致「界面显示已接入、LS 却直连官方」的假接入。
/// 巡检只在配置仍指向本地网关时重打（用户已停止接入就绝不擅自改安装目录）。
/// 两个 patch 函数自身幂等且带轻量预检，因此常态巡检只读几 KB header。
pub(in crate::commands::platforms) fn antigravity_endpoint_keeper_tick() {
    #[cfg(test)]
    {
        panic!("测试禁止调用 antigravity_endpoint_keeper_tick() 读写宿主机真实安装目录");
    }
    #[cfg(not(test))]
    {
        let is_hub_managed = || {
            antigravity_hub_config_dir()
                .and_then(|d| antigravity_managed_endpoint_from_settings(&d))
                .map(|u| is_anybridge_managed_endpoint(Some(&u)))
                .unwrap_or(false)
        };
        let is_ide_managed = || {
            antigravity_ide_config_dir()
                .and_then(|d| antigravity_managed_endpoint_from_settings(&d))
                .map(|u| is_anybridge_managed_endpoint(Some(&u)))
                .unwrap_or(false)
        };

        if !is_hub_managed() && !is_ide_managed() {
            return; // 未接入 → 零开销，且绝不擅自改安装目录
        }

        // 持全局注入锁后二次校验，防止在等锁期间配置已被还原导致把官方端重新打回补丁。
        let _guard = crate::commands::inject_lock();
        if is_hub_managed() {
            if let Some(asar_path) = crate::commands::antigravity_localization::hub_asar_path() {
                if let Err(e) = patch_antigravity_hub_asar(&asar_path) {
                    eprintln!("[ag-endpoint-keeper] 白底 asar 端点补丁补打失败: {e}");
                }
            }
        }
        if is_ide_managed() {
            if let Err(e) = patch_antigravity_ide_extension() {
                eprintln!("[ag-endpoint-keeper] 黑底 IDE 端点补丁补打失败: {e}");
            }
        }
    }
}


/// 后台保活：客户端升级覆盖注入文件后自动重打端点补丁。
/// 仅在「已接入」时工作，未接入 / 未安装时静默跳过，绝不打扰用户。
pub fn spawn_antigravity_endpoint_keeper() {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(15));
        loop {
            antigravity_endpoint_keeper_tick();
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}


/// 幂等给黑底 IDE 的 agy 启动环境注入 `CLOUD_CODE_URL`。
/// 首次接管前备份到 `extension.js.anybridge-bak`；失败必须中断接入。
pub(crate) fn patch_antigravity_ide_extension() -> Result<(), String> {
    #[cfg(test)]
    {
        panic!("测试禁止调用 patch_antigravity_ide_extension() 修改宿主机真实 extension.js");
    }
    #[cfg(not(test))]
    {
        let candidates = antigravity_ide_extension_candidates();
        let target = candidates
            .iter()
            .find(|c| c.exists())
            .ok_or("未找到 Antigravity IDE 安装目录（extensions/agy/vscode/extension.js），请先安装并启动一次 Antigravity IDE")?;
        let original = fs::read_to_string(target).map_err(|e| format!("读取 extension.js 失败: {e}"))?;
        if original.contains(ANTIGRAVITY_IDE_EXTENSION_VERSION)
            && original.contains(".buildServerEnvironment")
        {
            // 幂等：已是当前版本，运行时动态读 settings.json，URL/端口变化无需重打。
            return Ok(());
        }
        let bak = target.with_extension("js.anybridge-bak");
        if !bak.exists() {
            let _ = fs::copy(target, &bak);
        }
        // 旧版注入（含旧 marker 但缺当前版本标记）：先剥离旧注入再重打。
        // 优先就地正则剥离（不依赖备份，客户端升级后备份可能已不存在）；
        // 剥离失败才退回官方备份。
        let base = if original.contains(ANTIGRAVITY_IDE_EXTENSION_MARKER) {
            if let Ok(stripped) = strip_antigravity_extension_injection(&original) {
                stripped
            } else if bak.exists() {
                fs::read_to_string(&bak).unwrap_or(original.clone())
            } else {
                return Err(
                    "检测到旧版端点注入但无法就地剥离、且找不到官方备份 extension.js.anybridge-bak；请重装客户端后重新接入"
                        .to_string(),
                );
            }
        } else {
            original.clone()
        };
        let patched = patch_antigravity_extension_code(&base)?;
        crate::commands::write_atomic(target, patched.as_bytes())
            .map_err(|e| format!("写入 extension.js 补丁失败: {e}"))?;
        Ok(())
    }
}
