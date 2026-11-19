//! 平台版本探测（借鉴 magpie `internal/agent/cliupdate.go` 三件套）。
//!
//! 三层来源：
//! 1. **CLI 类平台**（claude/codex/grok/opencode）：深度查找可执行文件后跑 `--version`
//!    ——查找范围 = PATH + 注册表 PATH + npm 全局前缀（GUI 进程拿不到登录 shell
//!    的 PATH，magpie #1771 的教训：47 目录 × 11 PATHEXT 一次 miss 111ms，
//!    所以结果按「路径+大小+mtime」缓存 10 分钟）
//! 2. **GUI 客户端**（Windsurf/Devin/Cursor/Antigravity）：注册表卸载键找安装目录
//!    → 读 `resources/app/product.json` 的 version（VS Code fork 标准字段）
//! 3. **最新版本**：npm registry（`/pkg/latest`），结果缓存 6 小时
//!
//! 原则（坑点库 read-failure-is-unknown）：任何探测失败返回 None（版本未知），
//! 绝不编造或当否定值使用。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use crate::commands::system::HideWindow;

/// CLI 探测规格（类似 magpie 的 cliSpecs）。
#[derive(Debug)]
pub struct CliSpec {
    pub bin: &'static str,
    pub npm_package: Option<&'static str>,
}

/// 平台 id → CLI 规格。只列有把握的（bin 名与 npm 包名经核实）；
/// 没把握的返回 None，版本行显示「已安装」不带版本号。
pub fn cli_spec(platform_id: &str) -> Option<CliSpec> {
    // 单一真源：CLI 元数据（bin / npm 包）来自 agent_spec::AGENTS。
    // 新增带 CLI 的 agent 只需在声明里填 bin/npm_package，无需改这里。
    let spec = super::agent_spec::find(platform_id)?;
    let bin = spec.bin?;
    Some(CliSpec {
        bin,
        npm_package: spec.npm_package,
    })
}

/// GUI 客户端（VS Code fork）的注册表卸载名与 product.json 相对路径。
pub fn gui_product(platform_id: &str) -> Option<(&'static str, &'static str)> {
    match platform_id {
        "windsurf" => Some(("Windsurf", r"resources\app\product.json")),
        "devin" => Some(("Devin", r"resources\app\product.json")),
        "cursor" => Some(("Cursor", r"resources\app\product.json")),
        "antigravity" | "antigravity-ide" => {
            Some(("Antigravity", r"resources\app\product.json"))
        }
        _ => None,
    }
}

/// 深度查找可执行文件：PATH → 注册表 PATH（HKLM+HKCU）→ npm 全局前缀。
/// 借鉴 magpie path_windows.go。
///
/// 关键：**静态标准目录优先，不依赖 spawn npm**——GUI 进程的 PATH 里
/// 往往没有 npm.cmd，`npm prefix -g` 会直接失败（实测：Codex 已装却
/// 显示"未安装"就是踩的这个，对应 magpie #1771 同类坑）。
pub fn find_tool(bin: &str) -> Option<PathBuf> {
    // 缓存：detect_platforms 对 13 个平台循环检测时会反复调用，
    // 每次 3 个子进程（reg×2 + npm）代价太高。
    let cache_key = format!("findtool:{}", bin);
    if let Some(hit) = cache_get(&cache_key, Duration::from_secs(300)) {
        return hit.map(PathBuf::from);
    }
    let result = find_tool_uncached(bin);
    cache_put(
        cache_key,
        result.as_ref().map(|p| p.to_string_lossy().to_string()),
    );
    result
}

fn find_tool_uncached(bin: &str) -> Option<PathBuf> {
    // npm 全局在 Windows 生成 .cmd shim（不是 .exe）——必须多后缀尝试，
    // 否则 PATH 里明明有 codex.cmd 却报「未安装」（实测踩中）。
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{bin}.exe"), format!("{bin}.cmd"), format!("{bin}.bat")]
    } else {
        vec![bin.to_string()]
    };
    let mut dirs: Vec<PathBuf> = Vec::new();

    // 1. 当前进程 PATH
    if let Some(path_var) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }

    // 2. 静态标准目录（无需 spawn，覆盖 99% 的安装位置）
    if let Some(home) = dirs::home_dir() {
        for d in [
            // npm 全局默认前缀（npm i -g 在 Windows 的落点）
            home.join("AppData").join("Roaming").join("npm"),
            // 官方独立安装器/vendor 目录
            home.join(".local").join("bin"),
            home.join(".claude").join("local"),
            home.join(".codex").join("bin"),
            home.join(".grok").join("bin"),
            home.join(".opencode").join("bin"),
            // 版本管理器
            home.join(".volta").join("bin"),
            home.join(".bun").join("bin"),
            home.join(".npm-global"),
            home.join("AppData").join("Local").join("Programs"),
        ] {
            dirs.push(d);
        }
    }

    // 3. 注册表 PATH（HKLM 系统级 + HKCU 用户级，展开 %VAR%）
    for key in [
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        r"HKCU\Environment",
    ] {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", key, "/v", "Path"])
            .hide_window()
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            if let Some(line) = text.lines().find(|l| l.contains("Path")) {
                if let Some(raw) = line
                    .split("REG_EXPAND_SZ")
                    .nth(1)
                    .or_else(|| line.split("REG_SZ").nth(1))
                {
                    let expanded = expand_env_vars(raw.trim());
                    dirs.extend(std::env::split_paths(&expanded));
                }
            }
        }
    }

    // 4. npm 全局前缀（补充：spawn 成功才加，失败不致命）
    if let Ok(out) = std::process::Command::new("npm")
        .args(["prefix", "-g"])
        .hide_window()
        .output()
    {
        let prefix = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !prefix.is_empty() {
            dirs.push(PathBuf::from(prefix));
        }
    }

    dirs.into_iter()
        .flat_map(|d| candidates.iter().map(move |c| d.join(c)))
        .find(|p| p.is_file())
}

/// 展开 %VAR% 环境变量（注册表 PATH 里的写法）。
pub(super) fn expand_env_vars(s: &str) -> String {
    let mut out = s.to_string();
    while let Some(start) = out.find('%') {
        let Some(rel_end) = out[start + 1..].find('%') else { break };
        let end = start + 1 + rel_end;
        let name = &out[start + 1..end];
        if name.is_empty() {
            break;
        }
        let val = std::env::var(name).unwrap_or_default();
        out.replace_range(start..=end, &val);
    }
    out
}

// ── 缓存 ─────────────────────────────────────────────────────

type CacheVal = (Instant, Option<String>);

fn cache_store() -> &'static Mutex<HashMap<String, CacheVal>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, CacheVal>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn cache_get(key: &str, ttl: Duration) -> Option<Option<String>> {
    let map = cache_store().lock().ok()?;
    map.get(key).and_then(|(at, v)| {
        if at.elapsed() < ttl {
            Some(v.clone())
        } else {
            None
        }
    })
}

pub(super) fn cache_put(key: String, v: Option<String>) {
    if let Ok(mut map) = cache_store().lock() {
        map.insert(key, (Instant::now(), v));
    }
}

fn file_stamp(p: &PathBuf) -> Option<(u64, u64)> {
    let meta = fs_meta(p)?;
    Some((meta.len, meta.mtime))
}

struct FileMeta {
    len: u64,
    mtime: u64,
}

fn fs_meta(p: &PathBuf) -> Option<FileMeta> {
    let meta = std::fs::metadata(p).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(FileMeta {
        len: meta.len(),
        mtime,
    })
}

/// 版本探测失败记忆（借鉴 magpie versionsFailed #864）：跑 --version 被
/// 杀软拦截/挂起等场景下，按「路径+大小+mtime」指纹记住失败——二进制不变
/// 就不再重试子进程（600s TTL 缓存会让失败每 10 分钟反复触发杀软弹窗）。
/// 二进制升级后指纹变化自然失效。
fn failed_probes() -> &'static Mutex<HashMap<String, ()>> {
    static FAILED: std::sync::OnceLock<Mutex<HashMap<String, ()>>> = std::sync::OnceLock::new();
    FAILED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// bin 是 npm shim（路径位于 node_modules 树内）时，直接读包的
/// package.json 拿版本——零子进程（magpie npmVersion 思路：npm 装的 CLI
/// 其包版本即安装版本，不必运行二进制）。返回 None 时调用方回退跑 --version。
fn npm_shim_version(bin_path: &std::path::Path, npm_package: &str) -> Option<String> {
    // 从 bin 向上找最近的 node_modules 目录（<prefix>/node_modules/.bin/foo → node_modules）
    let mut cur = bin_path.parent()?;
    let node_modules: &std::path::Path = loop {
        if cur.file_name().and_then(|s| s.to_str()) == Some("node_modules") {
            break cur;
        }
        cur = cur.parent()?;
    };
    for base in [
        node_modules.to_path_buf(),
        // 双层布局：prefix 被用户设成 .../node_modules 时包在其下再一层
        node_modules.join("node_modules"),
    ] {
        let pkg_json = base.join(npm_package).join("package.json");
        let Ok(raw) = std::fs::read_to_string(&pkg_json) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
            if !ver.is_empty() {
                return Some(ver.to_string());
            }
        }
    }
    None
}

/// 已装版本（CLI：跑 --version，带缓存；失败返回 None = 未知）。
pub fn installed_cli_version(platform_id: &str) -> Option<String> {
    let spec = cli_spec(platform_id)?;
    let bin_path = find_tool(spec.bin)?;

    // 缓存键：路径+大小+mtime（二进制被升级后自动失效）
    let stamp = file_stamp(&bin_path)?;
    let key = format!("cli:{}:{:?}", platform_id, stamp);
    if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
        return hit;
    }
    // 失败记忆：同指纹曾全失败 → 不再重试（返回 None = 未知）
    if failed_probes().lock().map(|m| m.contains_key(&key)).unwrap_or(false) {
        return None;
    }

    // npm shim 直读优先（零子进程）→ CLI 自报 → npm prefix 回退。
    // 不响应 --version 的 CLI（如 dsh）走后两级（magpie installMethod 思路）。
    let mut version = spec
        .npm_package
        .and_then(|pkg| npm_shim_version(&bin_path, pkg));
    // 探测必须带超时：个别 CLI 的 --version 会挂起（等待输入/网络/卡死），
    // 无超时会拖住整个平台检测循环（13 个平台串行探测），表现为界面长时间无响应
    if version.is_none() {
        let mut probe = std::process::Command::new(&bin_path);
        probe.args(spec_args(platform_id)).hide_window();
        if let Ok(out) = spawn_with_timeout(probe, Duration::from_secs(10)) {
            version = parse_version_line(&String::from_utf8_lossy(&out.stdout));
        }
    }
    if version.is_none() {
        version = spec.npm_package.and_then(package_json_version);
    }

    if let Ok(mut failed) = failed_probes().lock() {
        if version.is_some() {
            failed.remove(&key);
        } else {
            failed.insert(key.clone(), ());
        }
    }
    cache_put(key, version.clone());
    version
}

/// npm 全局安装能力探针（缓存 5 分钟）：
/// ① npm 在 PATH ② 全局前缀**可写**（免 UAC）。
/// 只有两项都满足才在 UI 上展示「一键安装/更新」——不能成功的动作不该展示。
pub fn npm_install_capability() -> bool {
    let key = "npm:install-capable";
    if let Some(hit) = cache_get(key, Duration::from_secs(300)) {
        return hit.as_deref() == Some("1");
    }
    let ok = (|| -> bool {
        if find_tool("npm").is_none() {
            return false;
        }
        let Some(prefix) = npm_global_prefix() else {
            return false;
        };
        // 写探针：能建临时文件即免提权可写（Program Files 下会失败）
        let probe = prefix.join(".anybridge-write-probe");
        match std::fs::write(&probe, b"1") {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    })();
    cache_put(
        key.to_string(),
        Some(if ok { "1".into() } else { "0".into() }),
    );
    ok
}

/// npm 全局前缀（缓存 5 分钟；`npm prefix -g` 单次 1s+）。
fn npm_global_prefix() -> Option<PathBuf> {
    let key = "npm:global-prefix";
    if let Some(hit) = cache_get(key, Duration::from_secs(300)) {
        return hit.map(PathBuf::from);
    }
    // 必须用 find_tool 定位到的完整路径：Windows 上只有 npm.cmd，
    // `Command::new("npm")` 会直接 spawn 失败（探针恒 false → 安装/更新
    // 按钮永不显示）。
    let npm_bin = find_tool("npm").unwrap_or_else(|| PathBuf::from("npm"));
    let out = std::process::Command::new(&npm_bin)
        .args(["prefix", "-g"])
        .hide_window()
        .output()
        .ok()?;
    let prefix = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let result = if prefix.is_empty() { None } else { Some(prefix) };
    cache_put(key.to_string(), result.clone());
    result.map(PathBuf::from)
}

/// 从 npm 全局安装目录读包版本——CLI 不报版本时的回退。
///
/// 处理「双层 node_modules」布局：prefix 可能被用户设成 `.../node_modules`
/// （实测 E:\cache\node_modules），此时包实际在
/// `<prefix>/node_modules/<pkg>` 而非 `<prefix>/<pkg>`，两种都试。
fn package_json_version(npm_package: &str) -> Option<String> {
    let prefix = npm_global_prefix()?;
    let candidates = [
        prefix.join("node_modules").join(npm_package).join("package.json"),
        prefix.join(npm_package).join("package.json"),
    ];
    for path in candidates {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
            if !ver.is_empty() {
                return Some(ver.to_string());
            }
        }
    }
    None
}

fn spec_args(platform_id: &str) -> &'static [&'static str] {
    // 个别 CLI 的版本参数不同，默认 --version
    match platform_id {
        _ => &["--version"],
    }
}

/// 从 --version 输出提取 semver（第一个数字开头的点分版本）。
///
/// 注意：曾用 `t.chars().next()?` —— 空 token（连续空格/换行）会让整个
/// 函数提前返回 None，导致「有版本号却读不出」。改为逐 token 跳过。
fn parse_version_line(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c| c == 'v' || c == 'V' || c == '(' || c == ')');
        if let Some(first) = t.chars().next() {
            if first.is_ascii_digit() && t.contains('.') {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// GUI 客户端版本：**直接复用一键注入的安装目录定位链**。
///
/// 房间里的大象：workbench_inject::ide_app_dir(target) → system::find_ide_exe()
/// 是本项目久经实战的四层探测（配置缓存自愈 → 常见位置（含自定义盘符
/// E:\Program\devin）→ 运行进程（路径过滤区分 Devin/Windsurf 同名主进程）
/// → 注册表），一键注入/汉化/语言包全靠它定位安装目录。
///
/// 教训：本函数曾两度重造轮子（reg query 全树搜索、Toolhelp32 进程枚举），
/// 前者挂起（Devin 卡「检测中」），后者在本机仍因「自定义安装无卸载键」
/// 落空——而 find_ide_exe 的第②层（common_ide_candidates）早已覆盖。
/// 修正：版本探测只是安装目录定位的一个消费方，不是新的探测体系。
/// GUI 客户端版本：**直接复用一键注入的安装目录定位链**（最终形态）。
///
/// 复盘：本函数曾两度重造轮子——
/// ① `reg query /s /f` 全树搜索：挂起（Devin 卡「检测中」，CIM 同款慢）；
/// ② 原生注册表枚举 + Toolhelp32 进程枚举：本机仍落空（自定义安装
///    E:\Program\devin 未写卸载键，运行中进程也可能不在）。
/// 而一键注入的 `ide_app_dir → find_ide_exe` 四层探测（缓存自愈 →
/// 常见位置含自定义盘符 → 运行进程路径过滤 → 注册表）早已解决这一切，
/// workbench/语言包/检查脚本全在用它。
/// 教训沉淀：版本探测只是「安装目录定位」的一个消费方，不是新的探测体系；
/// 动手前先盘点现有资产（房间里的大象）。

mod gui_probe;

pub use gui_probe::*;

/// 子进程执行带超时：更新命令可能卡在下载或网络上，不能无限等待
/// （无限等待 = spawn_blocking 线程永久占用 + UI 一直转圈，用户无从判断）。
/// 超时后按本次启动的 PID 精确终止（不按进程名扫，避免误伤同名进程）。
pub fn spawn_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::process::Stdio;
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动子进程失败: {e}"))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(format!("读取子进程输出失败: {e}")),
        Err(_) => {
            kill_update_pid(pid);
            Err(format!(
                "命令执行超时（{} 分钟），已终止。可稍后重试，或到终端手动执行",
                timeout.as_secs() / 60
            ))
        }
    }
}

/// 按 PID 终止（只杀本次启动的进程及其子进程）
fn kill_update_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .hide_window()
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

/// 硬校验：CLI 二进制是否真的能启动。
///
/// 为什么不能只看版本号：`installed_cli_version` 在 CLI 无输出时会回退到
/// npm 包内的 package.json——文件损坏但包元数据还在时会「读到旧版本号」，
/// 于是把坏掉的 CLI 当成可用。这里直接启动一次二进制，能起来才算数。
pub fn cli_binary_runs(platform_id: &str) -> bool {
    let Some(spec) = cli_spec(platform_id) else {
        return false;
    };
    let Some(bin_path) = find_tool(spec.bin) else {
        return false;
    };
    let mut cmd = std::process::Command::new(&bin_path);
    cmd.args(spec_args(platform_id)).hide_window();
    spawn_with_timeout(cmd, Duration::from_secs(20)).is_ok()
}

/// 官方自更新（如 `claude update`）：命令成功即视为完成。
///
/// 不强制要求版本号立即变化——官方渠道可能尚未推送（实测 native 版与
/// npm 版发布不同步），硬判「更新失败」会误导用户。
/// 但**必须硬校验二进制仍可启动**（见 cli_binary_runs），
/// 更新后起不来 = 失败，不能算成功。
pub fn run_self_update_sync(
    bin: &str,
    args: &[&str],
    env: Option<&[(&str, &str)]>,
    platform_id: &str,
) -> Result<(), String> {
    let path =
        find_tool(bin).ok_or_else(|| format!("未找到 {bin} 可执行文件，无法执行官方更新命令"))?;
    let mut cmd = std::process::Command::new(&path);
    cmd.args(args).hide_window();
    // 声明式环境变量覆盖（如 grok 必须 GROK_INSTALLER=internal，
    // 否则它误判安装方式为 npm，Windows 上 spawn npm 必失败）
    if let Some(pairs) = env {
        cmd.envs(pairs.iter().map(|(k, v)| (*k, *v)));
    }
    // 超时 10 分钟：自更新要下载完整二进制（实测 grok 1.0.70 约 168MB），
    // 但要防网络挂起把线程和 UI 永久拖住
    let out = spawn_with_timeout(cmd, Duration::from_secs(600))
        .map_err(|e| format!("执行官方更新命令失败: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let detail = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(format!(
            "官方更新命令失败（exit={:?}）: {}",
            out.status.code(),
            detail.chars().take(300).collect::<String>()
        ));
    }
    invalidate_version_cache(platform_id);
    Ok(())
}

/// Toolhelp32 进程枚举（唯一实现）：pred 决定匹配哪个进程。
#[cfg(windows)]

/// 统一入口：平台已装版本（CLI 或 GUI 自动选择）。
pub fn installed_version(platform_id: &str) -> Option<String> {
    if let Some(v) = installed_cli_version(platform_id) {
        return Some(v);
    }
    installed_gui_version(platform_id)
}

/// npm 包的最新版本（6 小时缓存）。
pub async fn npm_latest_version(npm_package: &str) -> Option<String> {
    let key = format!("npm-latest:{}", npm_package);
    if let Some(hit) = cache_get(&key, Duration::from_secs(6 * 3600)) {
        return hit;
    }
    let url = format!("https://registry.npmjs.org/{}/latest", npm_package);
    let client = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .user_agent("AnyBridge-VersionCheck")
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let body = client.get(&url).send().await.ok()?.text().await.ok()?;
    let v = serde_json::from_str::<serde_json::Value>(&body)
        .ok()?
        .get("version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    cache_put(key, v.clone());
    v
}

/// 官方版本通道（channel pointer）：响应体就是纯文本版本号，如 "1.0.70"。
///
/// 借鉴 magpie 的 grokLatest/channelVersion：官方 CLI 常通过静态文件暴露
/// 当前通道版本，这对「没有 npm 包」的平台是唯一可靠的最新版本来源。
/// 多个 URL 按顺序尝试，全部失败返回 None（= 未知，不猜）。
pub async fn channel_latest_version(urls: &[&str]) -> Option<String> {
    let key = format!("channel-latest:{}", urls.join(","));
    if let Some(hit) = cache_get(&key, Duration::from_secs(6 * 3600)) {
        return hit;
    }
    let client = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .user_agent("AnyBridge-VersionCheck")
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    for url in urls {
        let Ok(resp) = client.get(*url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(body) = resp.text().await else {
            continue;
        };
        let v = body.trim().trim_start_matches('v').trim().to_string();
        // 必须是形如 1.2.3 的版本号（整个响应体就是版本）
        if v.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && v.contains('.') {
            cache_put(key, Some(v.clone()));
            return Some(v);
        }
    }
    None
}

/// 简易 semver 比较：latest 是否比 current 新（只比数字段，预发布视为较旧）。
pub fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        let core = v.split(['-', '+']).next().unwrap_or("");
        core.split('.')
            .map(|s| s.parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(latest), parts(current));
    for i in 0..3 {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

/// 使指定平台的版本缓存失效（更新完成后必须调用，
/// 否则 10 分钟缓存会让验证拿到旧版本，误报"更新失败"）。
pub fn invalidate_version_cache(platform_id: &str) {
    if let Ok(mut map) = cache_store().lock() {
        let prefix = format!("cli:{}:", platform_id);
        map.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// 一键更新 CLI 的同步执行段（magpie 模式：跑官方 npm 命令，不自己下载
/// 替换二进制）。latest 版本由调用方（async 上下文）预先查好传入。
///
/// 返回 Err 时 message 里带可手动执行的命令（用户复制到终端）。
/// npm 全局目录在 Program Files 时会 EPERM——提示用户手动提权执行
/// （自动弹 UAC 需要临时脚本接力，后续再加强）。
pub fn update_npm_package_sync(
    npm_package: &str,
    platform_id: &str,
    target_version: &str,
) -> Result<String, String> {
    let spec = cli_spec(platform_id).ok_or_else(|| format!("平台 {platform_id} 不支持 CLI 更新"))?;
    let bin_path =
        find_tool(spec.bin).ok_or_else(|| format!("未找到 {} 可执行文件，无法定位 npm", spec.bin))?;

    // npm 定位：必须走 find_tool（深度 PATH + 注册表）。
    // 踩过的坑：曾用「CLI 同目录的 npm.cmd」——当 CLI 装在自定义 prefix
    // （如 E:\cache\node_modules）时那里根本没有 npm，导致更新点了没反应。
    let npm = find_tool("npm").unwrap_or_else(|| {
        bin_path
            .parent()
            .map(|d| {
                #[cfg(windows)]
                {
                    d.join("npm.cmd")
                }
                #[cfg(not(windows))]
                d.join("npm")
            })
            .unwrap_or_else(|| PathBuf::from("npm"))
    });

    let mut cmd = std::process::Command::new(&npm);
    cmd.args(["install", "-g", &format!("{}@{}", npm_package, target_version)])
        .hide_window();
    let out = spawn_with_timeout(cmd, Duration::from_secs(600))
        .map_err(|e| format!("启动 npm 失败: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let manual = format!("npm install -g {}@{}", npm_package, target_version);
        let hint = if stderr.contains("EPERM") || stderr.contains("EACCES") {
            "；npm 全局目录需要管理员权限，请复制命令到管理员终端执行"
        } else {
            "；可复制命令到终端手动执行"
        };
        return Err(format!(
            "npm 更新失败（退出码 {:?}）{}。手动命令：{}",
            out.status.code(),
            hint,
            manual
        ));
    }

    // 验证（magpie 教训：更新后必须确认版本真变了，没变要报错）
    invalidate_version_cache(platform_id);
    // 硬校验：先看二进制能不能起来——package.json 回退会让坏掉的安装也「读到版本号」
    if !cli_binary_runs(platform_id) {
        return Err(format!(
            "更新命令已执行，但 {} 无法启动（二进制可能损坏）。手动恢复：npm install -g {}@{}",
            spec.bin, npm_package, target_version
        ));
    }
    match installed_cli_version(platform_id) {
        Some(v) if !is_newer(target_version, &v) => Ok(v),
        Some(v) => Err(format!(
            "更新命令已执行，但版本仍为 v{v}（期望 v{target_version}）。可能存在多个安装位置，请检查 PATH 优先级"
        )),
        None => Err(format!(
            "更新命令已执行，但无法读取新版本。请检查 {} 是否仍可用",
            spec.bin
        )),
    }
}


#[cfg(test)]
mod tests;

