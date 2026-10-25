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

/// CLI 探测规格（类似 magpie 的 cliSpecs）。
pub struct CliSpec {
    pub bin: &'static str,
    pub npm_package: Option<&'static str>,
}

/// 平台 id → CLI 规格。只列有把握的（bin 名与 npm 包名经核实）；
/// 没把握的返回 None，版本行显示「已安装」不带版本号。
pub fn cli_spec(platform_id: &str) -> Option<CliSpec> {
    let spec = match platform_id {
        "claude-code" => CliSpec {
            bin: "claude",
            npm_package: Some("@anthropic-ai/claude-code"),
        },
        "codex" => CliSpec {
            bin: "codex",
            npm_package: Some("@openai/codex"),
        },
        "grok" => CliSpec {
            bin: "grok",
            npm_package: Some("@vibe-kit/grok-cli"),
        },
        "opencode" => CliSpec {
            bin: "opencode",
            npm_package: Some("opencode-ai"),
        },
        _ => return None,
    };
    Some(spec)
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
            .creation_flags_windows()
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
        .creation_flags_windows()
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

trait CreationFlags {
    fn creation_flags_windows(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl CreationFlags for std::process::Command {
    fn creation_flags_windows(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：GUI 程序防黑窗
        self
    }
}

#[cfg(not(windows))]
impl CreationFlags for std::process::Command {
    fn creation_flags_windows(&mut self) -> &mut Self {
        self
    }
}

/// 展开 %VAR% 环境变量（注册表 PATH 里的写法）。
fn expand_env_vars(s: &str) -> String {
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

fn cache_get(key: &str, ttl: Duration) -> Option<Option<String>> {
    let map = cache_store().lock().ok()?;
    map.get(key).and_then(|(at, v)| {
        if at.elapsed() < ttl {
            Some(v.clone())
        } else {
            None
        }
    })
}

fn cache_put(key: String, v: Option<String>) {
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

    let out = std::process::Command::new(&bin_path)
        .args(spec_args(platform_id))
        .creation_flags_windows()
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let version = parse_version_line(&text);
    cache_put(key, version.clone());
    version
}

fn spec_args(platform_id: &str) -> &'static [&'static str] {
    // 个别 CLI 的版本参数不同，默认 --version
    match platform_id {
        _ => &["--version"],
    }
}

/// 从 --version 输出提取 semver（第一段含数字的点分版本）。
fn parse_version_line(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c| c == 'v' || c == 'V' || c == '(' || c == ')');
        if t.chars().next()?.is_ascii_digit() && t.contains('.') {
            return Some(t.to_string());
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
#[cfg(windows)]
pub fn installed_gui_version(platform_id: &str) -> Option<String> {
    // ide_app_dir 返回 <install>\resources\app，带路径缓存（首次后毫秒级）。
    let app_dir = super::workbench_inject::ide_app_dir(platform_id)?;

    let key = format!("gui:{}", platform_id);
    if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
        return hit;
    }

    let product = app_dir.join("product.json");
    let version = std::fs::read_to_string(&product)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            // VS Code fork：version = 应用版本（Windsurf 1.101.1），
            // vscodeVersion = 引擎版本（1.110.1）。展示应用版本，与
            // 客户端「关于」页一致。
            v.get("version")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });

    cache_put(key, version.clone());
    version
}

/// 旧实现保留备查（注册表枚举 + 进程枚举），已不再被调用。
/// 在 find_ide_exe 体系全面失效的机器上才有价值，届时再启用。
#[cfg(windows)]
#[allow(dead_code)]
fn legacy_gui_probe_registry(platform_id: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_NO_MORE_ITEMS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ,
    };

    let (display, rel) = gui_product(platform_id)?;
    let key = format!("gui:{}", platform_id);
    if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
        return hit;
    }

    let mut version: Option<String> = None;

    // ① 运行中进程路径（最可靠）：客户端正在运行 → 主进程 exe 所在目录
    //    即安装目录。本机实测：Windsurf/Devin/Cursor 装在自定义目录且
    //    未写卸载键，注册表路线完全失效，进程路线秒级命中。
    let main_exe = match platform_id {
        "windsurf" => Some("Windsurf.exe"),
        "devin" => Some("Devin.exe"),
        "cursor" => Some("Cursor.exe"),
        "antigravity" => Some("antigravity.exe"),
        "antigravity-ide" => Some("Antigravity IDE.exe"),
        _ => None,
    };
    if let Some(exe_name) = main_exe {
        if let Some(install_dir) = running_client_install_dir(exe_name) {
            let product = install_dir.join(rel);
            if let Ok(content) = std::fs::read_to_string(&product) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
                        version = Some(ver.to_string());
                    }
                }
            }
        }
    }

    // ② 注册表卸载键（安装器写了卸载键的机器上有效）
    if version.is_none() {
    'hives: for hive_root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for sub in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            unsafe {
                let mut uninstall: HKEY = std::ptr::null_mut();
                if RegOpenKeyExW(hive_root, wide(sub).as_ptr(), 0, KEY_READ, &mut uninstall) != 0 {
                    continue;
                }
                let mut index = 0u32;
                loop {
                    let mut name_buf = [0u16; 256];
                    let mut name_len = name_buf.len() as u32;
                    if RegEnumKeyExW(
                        uninstall,
                        index,
                        name_buf.as_mut_ptr(),
                        &mut name_len,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    ) == ERROR_NO_MORE_ITEMS
                    {
                        break;
                    }
                    index += 1;

                    let sub_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
                    let child_path = format!("{}\\{}", sub, sub_name);
                    let mut child: HKEY = std::ptr::null_mut();
                    if RegOpenKeyExW(hive_root, wide(&child_path).as_ptr(), 0, KEY_READ, &mut child)
                        != 0
                    {
                        continue;
                    }

                    // DisplayName 包含目标名（大小写不敏感）才算
                    let display_name = reg_read_string(child, "DisplayName");
                    let matched = display_name
                        .as_deref()
                        .map(|d| d.to_lowercase().contains(&display.to_lowercase()))
                        .unwrap_or(false);

                    if matched {
                        let mut loc = reg_read_string(child, "InstallLocation");
                        if loc.is_none() {
                            // InstallLocation 可能是 REG_EXPAND_SZ
                            loc = reg_read_string_expanded(child, "InstallLocation");
                        }
                        if let Some(dir) = loc.filter(|s| !s.trim().is_empty()) {
                            let product = PathBuf::from(dir.trim().trim_matches('"')).join(rel);
                            if let Ok(content) = std::fs::read_to_string(&product) {
                                if let Ok(v) =
                                    serde_json::from_str::<serde_json::Value>(&content)
                                {
                                    if let Some(ver) =
                                        v.get("version").and_then(|x| x.as_str())
                                    {
                                        version = Some(ver.to_string());
                                    }
                                }
                            }
                        }
                    }
                    RegCloseKey(child);
                    if version.is_some() {
                        break;
                    }
                }
                RegCloseKey(uninstall);
            }
            if version.is_some() {
                break 'hives;
            }
        }
    }
    } // if version.is_none()

    cache_put(key, version.clone());
    version
}

/// 从运行中的客户端主进程反推安装目录。
/// Toolhelp32 枚举进程（与 kill_antigravity_language_server 同款，毫秒级），
/// 找到主进程 exe 后向上回溯到含 `resources\app\product.json` 的目录。
#[cfg(windows)]
pub fn running_client_install_dir(exe_name: &str) -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut result = None;

        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if name.eq_ignore_ascii_case(exe_name) && entry.th32ProcessID != 0 {
                    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if !h.is_null() {
                        let mut buf = [0u16; 1024];
                        let mut len = buf.len() as u32;
                        if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
                            != 0
                        {
                            let exe_path =
                                PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]));
                            // exe 在 <install>\Xxx.exe，product.json 在 <install>\resources\app\
                            let mut dir = exe_path.parent().map(|p| p.to_path_buf());
                            for _ in 0..4 {
                                let Some(d) = dir else { break };
                                if d.join("resources").join("app").join("product.json").is_file() {
                                    result = Some(d);
                                    break;
                                }
                                dir = d.parent().map(|p| p.to_path_buf());
                            }
                        }
                        CloseHandle(h);
                    }
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        result
    }
}

#[cfg(not(windows))]
pub fn running_client_install_dir(_exe_name: &str) -> Option<std::path::PathBuf> {
    None
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
use windows_sys::Win32::System::Registry::{HKEY, REG_EXPAND_SZ, REG_SZ};

/// 读 REG_SZ 字符串值。
#[cfg(windows)]
fn reg_read_string(hkey: HKEY, name: &str) -> Option<String> {
    unsafe {
        use windows_sys::Win32::System::Registry::RegQueryValueExW;
        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let mut kind = 0u32;
        if RegQueryValueExW(
            hkey,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        ) == 0
        {
            let len = (size as usize) / 2;
            let s = String::from_utf16_lossy(&buf[..len]);
            Some(s.trim_end_matches('\0').to_string())
        } else {
            None
        }
    }
}

/// 读 REG_EXPAND_SZ 并展开 %VAR%。
#[cfg(windows)]
fn reg_read_string_expanded(hkey: HKEY, name: &str) -> Option<String> {
    unsafe {
        use windows_sys::Win32::System::Registry::RegQueryValueExW;
        let mut buf = [0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let mut kind = 0u32;
        if RegQueryValueExW(
            hkey,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        ) == 0
            && (kind == REG_SZ || kind == REG_EXPAND_SZ)
        {
            let len = (size as usize) / 2;
            let s = String::from_utf16_lossy(&buf[..len]).trim_end_matches('\0').to_string();
            Some(expand_env_vars(&s))
        } else {
            None
        }
    }
}

/// 非 Windows：无注册表，暂不支持 GUI 版本探测（返回 None = 未知）。
#[cfg(not(windows))]
pub fn installed_gui_version(_platform_id: &str) -> Option<String> {
    None
}

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

    // 用检测到的 npm（bin 同目录通常有 npm.cmd / npm）
    let npm = bin_path
        .parent()
        .map(|d| {
            #[cfg(windows)]
            {
                d.join("npm.cmd")
            }
            #[cfg(not(windows))]
            d.join("npm")
        })
        .unwrap_or_else(|| PathBuf::from("npm"));

    let out = std::process::Command::new(&npm)
        .args(["install", "-g", &format!("{}@{}", npm_package, target_version)])
        .creation_flags_windows()
        .output()
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
