use std::path::PathBuf;
use std::time::Duration;
use super::{cache_get, cache_put, expand_env_vars, gui_product};
#[cfg(windows)]
pub fn installed_gui_version(platform_id: &str) -> Option<String> {
    // Claude Desktop（微软商店 Appx 版）：版本编码在安装目录名里——
    // C:\Program Files\WindowsApps\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc
    // 从 exe 路径段直接解析，无需额外的 PowerShell 查询。
    if platform_id == "claude-desktop" || platform_id == "claude" {
        let key = format!("gui:{}", platform_id);
        if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
            return hit;
        }
        let version = claude_desktop_appx_version();
        cache_put(key, version.clone());
        return version;
    }

    // 纯 Electron 应用（WorkBuddy / ZCode）：版本在 resources/app.asar 内
    if let Some(exe_name) = electron_main_exe(platform_id) {
        let key = format!("gui:{}", platform_id);
        if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
            return hit;
        }
        let version = electron_asar_version(exe_name);
        cache_put(key, version.clone());
        return version;
    }

    // 桌面 IDE 型（CodeBuddy）：版本在安装目录，不在同名 CLI 里。
    // 实测 CodeBuddy IDE 1.106.1 vs CLI 2.171.0，混用会显示错版本。
    if let Some(spec) = crate::commands::agent_spec::find(platform_id) {
        if let Some(prefix) = spec.gui_exe_prefix {
            let key = format!("gui:{}", platform_id);
            if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
                return hit;
            }
            let version = running_process_dir_by_prefix(prefix).and_then(|d| electron_app_version(&d));
            cache_put(key, version.clone());
            return version;
        }
    }

    // 白名单守卫：只有已知 GUI 平台才走 GUI 探测。
    // 否则 find_ide_exe 对未知 id（pi/hermes/codebuddy…）会走其默认分支
    // （= Windsurf），把 Windsurf 的版本安到无关平台头上
    // （实测：Pi/Hermes 页显示 v1.110.1）。
    if platform_id != "antigravity" && gui_product(platform_id).is_none() {
        return None;
    }

    let key = format!("gui:{}", platform_id);
    if let Some(hit) = cache_get(&key, Duration::from_secs(600)) {
        return hit;
    }

    // Antigravity Hub 是 Electron 应用（非 VS Code fork），没有 resources/app，
    // 版本在 app.asar 内的 package.json——hub_asar_path() 是汉化/接入同款定位链。
    if platform_id == "antigravity" {
        let version = antigravity_hub_version();
        cache_put(key, version.clone());
        return version;
    }

    // ide_app_dir 返回 <install>\resources\app，带路径缓存（首次后毫秒级）。
    let app_dir = crate::commands::workbench_inject::ide_app_dir(platform_id)?;

    let product = app_dir.join("product.json");
    let version = std::fs::read_to_string(&product)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| product_version_from_json(&v));

    cache_put(key, version.clone());
    version
}

/// 从 VS Code fork 的 product.json 取**产品版本**（客户端「关于」页显示的）。
///
/// 坑：`version` 字段在这些 fork 里通常是 **VS Code 引擎版本**，不是产品版本。
/// 实测（用户对照「关于」对话框）：
/// - Windsurf：windsurfVersion=2.3.15 ✓ / version=1.110.1（引擎）✗
/// - Devin：windsurfVersion=3.11.216 ✓ / version=1.126.0（引擎）✗
///   （Devin 继承了 Windsurf 的字段名）
/// - Antigravity IDE：ideVersion=2.5.5 ✓ / version=1.107.0（引擎）✗
/// - Cursor：version=3.15.6 ✓ / vscodeVersion=1.128.0（引擎）
///
/// 取值顺序：专有字段 → `version`（且不能等于 vscodeVersion，否则说明它只是引擎）。
pub fn product_version_from_json(v: &serde_json::Value) -> Option<String> {
    for key in ["windsurfVersion", "ideVersion", "productVersion", "appVersion"] {
        if let Some(ver) = v.get(key).and_then(|x| x.as_str()) {
            if !ver.is_empty() {
                return Some(ver.to_string());
            }
        }
    }
    let ver = v.get("version").and_then(|x| x.as_str())?;
    if let Some(engine) = v.get("vscodeVersion").and_then(|x| x.as_str()) {
        if engine == ver {
            return None; // version 与引擎版本相同 → 它只是引擎版本，不冒充产品版本
        }
    }
    if ver.is_empty() {
        return None;
    }
    Some(ver.to_string())
}

/// Claude Desktop（Appx 商店版）：从安装目录名解析版本。
/// 目录形如 `Claude_3.6556.2.0_x64__pzs8sxrjxfjjc`（WindowsApps 下）。
#[cfg(windows)]
fn claude_desktop_appx_version() -> Option<String> {
    let exe = crate::commands::system::find_ide_exe("claude-desktop")?;
    for comp in exe.components() {
        let seg = comp.as_os_str().to_string_lossy();
        if let Some(rest) = seg.strip_prefix("Claude_") {
            if let Some((ver, _)) = rest.split_once('_') {
                if ver.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
                    && ver.contains('.')
                {
                    return Some(ver.to_string());
                }
            }
        }
    }
    None
}

/// Antigravity Hub 的应用版本：读 app.asar 内的 package.json。
/// asar 解析与汉化的 patch_hub_asar 同一套格式约定（header + payload_start）。
#[cfg(windows)]
fn antigravity_hub_version() -> Option<String> {
    let asar_path = crate::commands::antigravity_localization::hub_asar_path()?;
    asar_package_version(&asar_path)
}

/// 读 Electron asar 内 package.json 的 version。
/// 格式与 patch_hub_asar 一致：16 字节头 + JSON header，
/// payload_start = 8 + declared。
#[cfg(windows)]
pub(super) fn asar_package_version(asar_path: &std::path::Path) -> Option<String> {
    use serde_json::Value;
    use std::fs;
    use std::io::{Read, Seek, SeekFrom};

    let mut f = fs::File::open(asar_path).ok()?;
    let mut head16 = [0u8; 16];
    f.read_exact(&mut head16).ok()?;
    let json_size = u32::from_le_bytes(head16[12..16].try_into().ok()?) as usize;
    if json_size == 0 || json_size > 64 * 1024 * 1024 {
        return None;
    }
    let mut header_bytes = vec![0u8; 16 + json_size];
    f.seek(SeekFrom::Start(0)).ok()?;
    f.read_exact(&mut header_bytes).ok()?;
    let header: Value =
        serde_json::from_str(std::str::from_utf8(&header_bytes[16..]).ok()?).ok()?;
    let node = header.pointer("/files/package.json")?.clone();
    let offset: usize = node.get("offset")?.as_str()?.parse().ok()?;
    let size: usize = node.get("size")?.as_u64()? as usize;
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let declared = u32::from_le_bytes(header_bytes[4..8].try_into().ok()?) as usize;
    let payload_start = crate::commands::antigravity_localization::asar_payload_start(declared);
    let mut buf = vec![0u8; size];
    f.seek(SeekFrom::Start((payload_start + offset) as u64)).ok()?;
    f.read_exact(&mut buf).ok()?;
    let pkg: Value = serde_json::from_slice(&buf).ok()?;
    pkg.get("version")?.as_str().map(|s| s.to_string())
}


/// 纯 Electron 应用（WorkBuddy / ZCode）：主进程 exe 名。
/// 它们没有 VS Code 的 product.json，版本只在 resources/app.asar 内。
/// 陷阱：安装根的 version 文件是 Electron 运行时版本
/// （实测 WorkBuddy = 37.10.3-42），不是应用版本，不能用。
#[cfg(windows)]
fn electron_main_exe(platform_id: &str) -> Option<&'static str> {
    match platform_id {
        "workbuddy" => Some("WorkBuddy.exe"),
        "zcode" => Some("ZCode.exe"),
        _ => None,
    }
}

/// 从运行中的 Electron 主进程定位 resources/app.asar 并读应用版本。
#[cfg(windows)]
fn electron_asar_version(exe_name: &str) -> Option<String> {
    let dir = running_process_dir(exe_name)?;
    asar_package_version(&dir.join("resources").join("app.asar"))
}

/// 运行中进程的可执行文件所在目录（精确 exe 名）。
#[cfg(windows)]
fn running_process_dir(exe_name: &str) -> Option<std::path::PathBuf> {
    running_process_dir_matching(|n| n.eq_ignore_ascii_case(exe_name))
}

/// 按前缀匹配进程名（CodeBuddy 有 "CodeBuddy CN.exe" 等地区变体）。
#[cfg(windows)]
fn running_process_dir_by_prefix(prefix: &str) -> Option<std::path::PathBuf> {
    let p = prefix.to_ascii_lowercase();
    running_process_dir_matching(move |n| n.to_ascii_lowercase().starts_with(&p))
}

/// Electron 应用版本：resources/app/package.json 优先，回退 app.asar 内嵌。
#[cfg(windows)]
fn electron_app_version(dir: &std::path::Path) -> Option<String> {
    let pkg = dir.join("resources").join("app").join("package.json");
    if let Ok(raw) = std::fs::read_to_string(&pkg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
                if !ver.is_empty() {
                    return Some(ver.to_string());
                }
            }
        }
    }
    asar_package_version(&dir.join("resources").join("app.asar"))
}


#[cfg(windows)]
fn running_process_dir_matching<F: Fn(&str) -> bool>(pred: F) -> Option<std::path::PathBuf> {
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
                if pred(&name) && entry.th32ProcessID != 0 {
                    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if !h.is_null() {
                        let mut buf = [0u16; 1024];
                        let mut len = buf.len() as u32;
                        if QueryFullProcessImageNameW(
                            h,
                            PROCESS_NAME_WIN32,
                            buf.as_mut_ptr(),
                            &mut len,
                        ) != 0
                        {
                            let exe_path = std::path::PathBuf::from(String::from_utf16_lossy(
                                &buf[..len as usize],
                            ));
                            result = exe_path.parent().map(|d| d.to_path_buf());
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

/// 从运行中的客户端主进程反推安装目录（含 resources/app/product.json）。
///
/// 复用 running_process_dir（唯一的 Toolhelp32 实现），避免两份进程枚举。
#[cfg(windows)]
pub fn running_client_install_dir(exe_name: &str) -> Option<PathBuf> {
    let mut cur = running_process_dir(exe_name)?;
    for _ in 0..4 {
        if cur
            .join("resources")
            .join("app")
            .join("product.json")
            .is_file()
        {
            return Some(cur);
        }
        cur = cur.parent()?.to_path_buf();
    }
    None
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

