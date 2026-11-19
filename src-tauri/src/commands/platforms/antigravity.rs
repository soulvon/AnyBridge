use crate::commands::config::Provider;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::antigravity_patch::{patch_antigravity_hub_asar, patch_antigravity_ide_extension};
use super::common::{
    agent_stash_dir, backup_path, emit_switch_progress, ensure_backup, vscode_like_data_dir,
    AntigravityConfigInfo, SwitchResult, PLATFORM_ANTIGRAVITY,
};
use super::platform_enum::Platform;


/// 纯函数：只替换/删除 settings.json 里的 `jetski.cloudCodeUrl` 一行，
/// 其余文本（包括 Antigravity Kite 写入的 `antigravityKite.*` 键、注释、
/// JSONC 尾逗号、缩进格式）**逐字节保留**。
///
/// 为什么不能「解析 JSON → to_string_pretty 整体重写」：Kite 扩展用 VS Code
/// 配置 API 并发写同一个文件（每次切号、改状态栏都会写）。整体重写会把
/// 它在两次读取之间写入的键静默丢掉（lost update）。最小替换把冲突面
/// 缩到我们自己的一行，且不改变文件其它任何字节。
pub(in crate::commands::platforms) fn upsert_settings_endpoint_text(raw: &str, endpoint: Option<&str>) -> Result<String, String> {
    let re = regex::Regex::new(
        r#"(?m)^([ \t]*)"jetski\.cloudCodeUrl"[ \t]*:[ \t]*"(?:[^"\\]|\\.)*"[ \t]*,?[ \t]*(\r?\n)?"#,
    )
    .map_err(|e| format!("正则编译失败: {e}"))?;

    match endpoint {
        Some(url) => {
            let escaped = url.replace('\\', "\\\\").replace('"', "\\\"");
            let line = format!("${{1}}\"jetski.cloudCodeUrl\": \"{escaped}\",${{2}}");
            if re.is_match(raw) {
                return Ok(re.replace(raw, line.as_str()).to_string());
            }
            // 键不存在：插到顶层对象第一个 `{` 之后，沿用原文件换行风格。
            let brace = raw.find('{').ok_or("settings.json 缺少顶层对象")?;
            let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
            // 缩进跟随文件里已有的第一条键；没有则默认两空格。
            let indent = raw
                .lines()
                .find(|l| l.trim_start().starts_with('"') && l.contains(':'))
                .map(|l| l[..l.len() - l.trim_start().len()].to_string())
                .unwrap_or_else(|| "  ".to_string());
            Ok(format!(
                "{}{{{newline}{indent}\"jetski.cloudCodeUrl\": \"{escaped}\",{newline}{}",
                &raw[..brace],
                raw[brace + 1..].trim_start_matches(['\r', '\n'])
            ))
        }
        None => Ok(re.replace_all(raw, "").to_string()),
    }
}


/// IO 包装：写入前**重新读取**最新内容再做最小替换，进一步缩短并发窗口。
pub(in crate::commands::platforms) fn write_settings_endpoint(path: &Path, endpoint: Option<&str>) -> Result<(), String> {
    if !path.exists() && endpoint.is_none() {
        return Ok(());
    }
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| format!("读取 settings.json 失败: {e}"))?
    } else {
        "{}".to_string()
    };
    let next = upsert_settings_endpoint_text(&raw, endpoint)?;
    if next == raw {
        return Ok(()); // 幂等：无变更不写，避免无谓触碰 Kite 正在读的文件
    }
    crate::commands::write_atomic(path, next.as_bytes())
}


pub(crate) fn antigravity_hub_config_dir() -> Option<PathBuf> {
    let data_dir = vscode_like_data_dir()?;
    let app_user = data_dir.join("Antigravity").join("User");
    if app_user.exists() {
        return Some(app_user);
    }
    let app_base = data_dir.join("Antigravity");
    if app_base.exists() {
        return Some(app_user);
    }
    Some(app_user)
}


pub(crate) fn antigravity_ide_config_dir() -> Option<PathBuf> {
    let data_dir = vscode_like_data_dir()?;
    let ide_user = data_dir.join("Antigravity IDE").join("User");
    if ide_user.exists() {
        return Some(ide_user);
    }
    let ide_base = data_dir.join("Antigravity IDE");
    if ide_base.exists() {
        return Some(ide_user);
    }
    Some(ide_user)
}


#[allow(dead_code)]
pub(in crate::commands::platforms) fn antigravity_config_dir() -> Option<PathBuf> {
    antigravity_hub_config_dir().or_else(antigravity_ide_config_dir)
}


/// 纯函数：端点 URL 是否由 AnyBridge 接管。
/// keeper / 状态查询共用，避免并行测试之间通过配置文件互相干扰。
pub(in crate::commands::platforms) fn is_anybridge_managed_endpoint(url: Option<&str>) -> bool {
    matches!(url, Some(u) if u.contains("127.0.0.1") || u.contains("localhost"))
}


/// 读取某端 settings.json 里的 `jetski.cloudCodeUrl`（读不到返回 None，不报错）。
#[cfg_attr(test, allow(dead_code))]
pub(in crate::commands::platforms) fn antigravity_managed_endpoint_from_settings(dir: &Path) -> Option<String> {
    let path = dir.join("settings.json");
    let raw = fs::read_to_string(path).ok()?;
    let obj = crate::commands::ide_config::parse_object(&raw).ok()?;
    obj.get("jetski.cloudCodeUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}


/// 成套还原：清掉两端 settings.json 里残留的本地网关端点。
///
/// v1.1.0 事故：用户停止接入时只撤了当前客户端的配置，另一端仍写着
/// `https://localhost:7452`；AnyBridge 退出后网关不再监听，那一端的 LS
/// 就把死端点固化下来（userInfo 永远失败 → 面板回退「Continue with Google」
/// → 切号插件失效）。两端共用同一个本地网关，接入/还原本就是整体语义，
/// 留一端必然制造死端点，因此任一还原都清两端。
///
/// 清理任意目录列表中的 `jetski.cloudCodeUrl` 本地托管残留（测试可注入临时目录）。
/// 只删「由 AnyBridge 接管」的本地地址；用户自己配的官方端点/其它代理
/// 一律不动（字段级还原写回原值也由调用方先完成）。
pub(in crate::commands::platforms) fn clear_antigravity_stale_managed_endpoints_in_dirs(dirs: &[PathBuf]) {
    for dir in dirs {
        let path = dir.join("settings.json");
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let obj = match crate::commands::ide_config::parse_object(&raw) {
            Ok(o) => o,
            Err(_) => continue,
        };
        let managed = obj
            .get("jetski.cloudCodeUrl")
            .and_then(|v| v.as_str())
            .map(|u| is_anybridge_managed_endpoint(Some(u)))
            .unwrap_or(false);
        if !managed {
            continue;
        }
        let _ = &obj; // obj 仅用于判定是否由本地网关接管
        let _ = write_settings_endpoint(&path, None);
    }
}


pub(in crate::commands::platforms) fn clear_antigravity_stale_managed_endpoints() {
    #[cfg(test)]
    {
        panic!("测试禁止调用 clear_antigravity_stale_managed_endpoints() 修改宿主机真实 settings.json，请改用 clear_antigravity_stale_managed_endpoints_in_dirs");
    }
    #[cfg(not(test))]
    {
        let dirs: Vec<PathBuf> = [
            antigravity_hub_config_dir(),
            antigravity_ide_config_dir(),
        ]
        .into_iter()
        .flatten()
        .collect();
        clear_antigravity_stale_managed_endpoints_in_dirs(&dirs);
    }
}


pub(in crate::commands::platforms) fn read_antigravity_config_info(path: &PathBuf) -> Result<Option<AntigravityConfigInfo>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some(AntigravityConfigInfo {
            cloud_code_url: None,
            managed_by_any_bridge: false,
            is_official: true,
        }));
    }
    let obj = crate::commands::ide_config::parse_object(&raw)?;
    let cloud_code_url = obj
        .get("jetski.cloudCodeUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let managed = is_anybridge_managed_endpoint(cloud_code_url.as_deref());
    let is_official = cloud_code_url.is_none()
        || matches!(
            cloud_code_url.as_deref(),
            Some("https://cloudcode-pa.googleapis.com")
                | Some("https://daily-cloudcode-pa.googleapis.com")
                | Some("https://daily-cloudcode-pa.sandbox.googleapis.com")
        );
    Ok(Some(AntigravityConfigInfo {
        cloud_code_url,
        managed_by_any_bridge: managed,
        is_official,
    }))
}


pub(in crate::commands::platforms) fn antigravity_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "antigravity",
        file: "settings.json",
    }
}


pub(in crate::commands::platforms) fn antigravity_ide_stash_key() -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform: "antigravity-ide",
        file: "settings.json",
    }
}


pub(in crate::commands::platforms) fn restore_antigravity_official_config_sync(
    app: &AppHandle,
    platform: Option<&str>,
) -> Result<SwitchResult, String> {
    let plat_id = platform.unwrap_or(PLATFORM_ANTIGRAVITY).to_string();
    let plat = Platform::from_id(&plat_id).unwrap_or(Platform::Antigravity);
    emit_switch_progress(app, plat.id(), "backup", "正在备份当前配置…");
    let path = plat
        .config_path()
        .ok_or_else(|| format!("无法定位 {} 用户配置路径", plat.display_name()))?;
    {
        let _guard = crate::commands::inject_lock();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        if path.exists() {
            ensure_backup(&path)?;
        }
        emit_switch_progress(app, plat.id(), "writing", "正在恢复官方配置…");
        if matches!(plat, Platform::AntigravityIde) {
            plat.apply_antigravity_ide_official_with_stash_locked(&path, &agent_stash_dir(), !cfg!(test))?;
        } else {
            plat.apply_antigravity_official_with_stash_locked(&path, &agent_stash_dir(), !cfg!(test))?;
        }
    }

    emit_switch_progress(app, plat.id(), "saving", "正在清除接管记录…");
    let _ = crate::commands::store_io::update_provider_store(|store| {
        let changed = store.platforms.remove(plat.id()).is_some();
        Ok((changed, ()))
    });

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    emit_switch_progress(app, plat.id(), "done", "已切回官方配置");
    Ok(SwitchResult {
        ok: true,
        message: format!("已切回 {} 官方配置，重启后生效", plat.display_name()),
        config_path,
        backup_path: backup,
    })
}

impl Platform {

    pub(in crate::commands::platforms) fn apply_antigravity_ide(&self, path: &PathBuf, _p: &Provider) -> Result<(), String> {
        self.apply_antigravity_ide_with_stash(path, &agent_stash_dir())
    }


    /// 记账可注入版：受管字段 = `jetski.cloudCodeUrl` 单键。
    pub(in crate::commands::platforms) fn apply_antigravity_ide_with_stash(&self, path: &PathBuf, stash_dir: &Path) -> Result<(), String> {
        let _guard = crate::commands::inject_lock();
        let ports = crate::commands::config::configured_proxy_ports();
        // 必须使用 https://localhost：LS 对明文 HTTP 端点会隐藏 boost /
        // teamwork-preview 等高级命令；证书为 AnyBridge Local CA 签发（SAN 含 localhost）
        let proxy_url = format!("https://localhost:{}", ports.antigravity_https_port);

        // 1. 接管黑底 IDE 语言服务器（agy.exe --hub）的端点。只写 jetski.cloudCodeUrl
        //    是「假接入」：IDE 主进程走网关，agy.exe 仍直连官方，注入模型在 LS
        //    模型表里不存在，选中即 `unknown model key` 会话崩溃。失败必须中断。
        if !cfg!(test) {
            patch_antigravity_ide_extension()?;
        }

        let raw = if path.exists() {
            fs::read_to_string(path).unwrap_or_default()
        } else {
            String::new()
        };
        let obj = crate::commands::ide_config::parse_object(&raw).unwrap_or_default();

        // 记账（幂等；总是执行）
        let plans = vec![crate::commands::agent_stash::FieldPlan {
            path: vec!["jetski.cloudCodeUrl".into()],
            current: obj
                .get("jetski.cloudCodeUrl")
                .and_then(Value::as_str)
                .map(|s| crate::commands::agent_stash::Stashed::Str(s.to_string()))
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
            new: crate::commands::agent_stash::Stashed::Str(proxy_url.clone()),
        }];
        if let Err(e) =
            crate::commands::agent_stash::record_apply(stash_dir, &antigravity_ide_stash_key(), &plans)
        {
            eprintln!("[agent-stash] Antigravity IDE 记账失败（不影响切换）: {e}");
        }

        // 只改自己那一行，保留 Kite 等扩展并发写入的其它键/注释/格式。
        let _ = &obj; // obj 仅用于上面的记账，实际写入走最小替换
        write_settings_endpoint(path, Some(&proxy_url))?;

        Ok(())
    }


    pub(in crate::commands::platforms) fn apply_antigravity(&self, path: &PathBuf, _p: &Provider) -> Result<(), String> {
        self.apply_antigravity_with_stash(path, &agent_stash_dir())
    }


    /// 记账可注入版：受管字段 = `jetski.cloudCodeUrl` 单键。
    pub(in crate::commands::platforms) fn apply_antigravity_with_stash(&self, path: &PathBuf, stash_dir: &Path) -> Result<(), String> {
        // 全程持全局注入锁：补丁、记账、settings.json 写入均与 keeper / 汉化 / 还原互斥。
        let _guard = crate::commands::inject_lock();
        let ports = crate::commands::config::configured_proxy_ports();
        // 必须使用 https://localhost：LS 对明文 HTTP 端点会隐藏 boost /
        // teamwork-preview 等高级命令；证书为 AnyBridge Local CA 签发（SAN 含 localhost）
        let proxy_url = format!("https://localhost:{}", ports.antigravity_https_port);

        // 1. 确保白色桌面端 app.asar 已经打上端点补丁（失败必须中断接入，
        //    否则 LS 会以未补丁状态启动、静默走官方端点，造成「假接入」）
        //    路径查找必须跨平台：macOS 在 /Applications/Antigravity.app 下，
        //    Linux 在 ~/.local/share 下，不能只认 Windows 的 Programs 布局。
        if !cfg!(test) {
            if let Some(asar_path) = crate::commands::antigravity_localization::hub_asar_path() {
                patch_antigravity_hub_asar(&asar_path)?;
            }
        }

        // 2. 写入用户配置 settings.json
        let raw = if path.exists() {
            fs::read_to_string(path).unwrap_or_default()
        } else {
            String::new()
        };
        let obj = crate::commands::ide_config::parse_object(&raw).unwrap_or_default();

        // 记账（幂等；总是执行）
        let plans = vec![crate::commands::agent_stash::FieldPlan {
            path: vec!["jetski.cloudCodeUrl".into()],
            current: obj
                .get("jetski.cloudCodeUrl")
                .and_then(Value::as_str)
                .map(|s| crate::commands::agent_stash::Stashed::Str(s.to_string()))
                .unwrap_or(crate::commands::agent_stash::Stashed::Absent),
            new: crate::commands::agent_stash::Stashed::Str(proxy_url.clone()),
        }];
        if let Err(e) =
            crate::commands::agent_stash::record_apply(stash_dir, &antigravity_stash_key(), &plans)
        {
            eprintln!("[agent-stash] Antigravity 记账失败（不影响切换）: {e}");
        }

        let _ = &obj; // obj 仅用于记账；写入走最小替换，避免覆盖 Kite 的键
        write_settings_endpoint(path, Some(&proxy_url))?;

        // 3. 若正在运行语言服务，终止它促使其热重启重载新配置。
        //    用原生 API 枚举进程，不再 spawn PowerShell——Get-CimInstance 的
        //    CIM 查询实测 1-3 秒，是「一键接入」点击后卡顿的主因。
        #[cfg(windows)]
        if !cfg!(test) {
            Self::kill_antigravity_language_server();
        }
        Ok(())
    }


    /// 终止 Antigravity 自己的语言服务进程（促使其热重启加载新端点配置）。
    ///
    /// 关键：必须按**可执行文件路径**过滤，只杀 `antigravity\resources\bin` 下
    /// 的进程——其它产品（Windsurf 等）也可能有同名 `language_server.exe`。
    ///
    /// 性能：原生 Toolhelp32 快照枚举全部进程只要几十毫秒；
    /// 原实现用 PowerShell 的 Get-CimInstance（WMI/CIM 查询）要 1-3 秒。
    #[cfg(windows)]
    pub(in crate::commands::platforms) fn kill_antigravity_language_server() {
        #[cfg(test)]
        {
            panic!("测试禁止调用 kill_antigravity_language_server() 终止宿主机存活进程");
        }
        #[cfg(not(test))]
        {
            use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            };
            use windows_sys::Win32::System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            };

            unsafe {
                let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snap == INVALID_HANDLE_VALUE {
                    return;
                }
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

                if Process32FirstW(snap, &mut entry) != 0 {
                    loop {
                        let end = entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len());
                        let exe_name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                        let pid = entry.th32ProcessID;

                        // 两种语言服务都要终止：白底 Hub 是 language_server.exe，
                        // 黑底 IDE 是 ~/.gemini/bin/agy.exe --hub。只杀前者时，
                        // 黑底仍继承接入时的 CLOUD_CODE_URL 环境块，还原不生效。
                        let is_hub_ls = exe_name.eq_ignore_ascii_case("language_server.exe");
                        let is_ide_ls = exe_name.eq_ignore_ascii_case("agy.exe");
                        if (is_hub_ls || is_ide_ls) && pid != 0 {
                            let h = OpenProcess(
                                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                                0,
                                pid,
                            );
                            // HANDLE 在 windows-sys 0.59 是 *mut c_void，按指针判空
                            if !h.is_null() {
                                let mut buf = [0u16; 1024];
                                let mut len = buf.len() as u32;
                                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
                                    != 0
                                {
                                    let full = String::from_utf16_lossy(&buf[..len as usize]);
                                    let lower = full.to_lowercase().replace('/', "\\");
                                    // 路径白名单：只终止 Antigravity 自己的语言服务，
                                    // 绝不误杀其它产品同名的 language_server.exe / agy 工具。
                                    let matched = lower.contains("antigravity\\resources\\bin")
                                        || lower.contains("\\.gemini\\bin\\agy.exe");
                                    if matched {
                                        let _ = TerminateProcess(h, 1);
                                    }
                                }
                                CloseHandle(h);
                            }
                        }

                        if Process32NextW(snap, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snap);
            }
        }
    }


    #[cfg(test)]
    pub(in crate::commands::platforms) fn apply_antigravity_ide_official_with_stash(
        &self,
        path: &PathBuf,
        stash_dir: &Path,
    ) -> Result<(), String> {
        let _guard = crate::commands::inject_lock();
        let allow_host_side_effects = !cfg!(test);
        self.apply_antigravity_ide_official_with_stash_locked(path, stash_dir, allow_host_side_effects)
    }

    pub(in crate::commands::platforms) fn apply_antigravity_ide_official_with_stash_locked(
        &self,
        path: &PathBuf,
        stash_dir: &Path,
        allow_host_side_effects: bool,
    ) -> Result<(), String> {
        // 注：extensions/agy/vscode/extension.js 里的 CLOUD_CODE_URL 注入块
        // 保留不剥离——它运行时读 settings.json 的 jetski.cloudCodeUrl，
        // 撤键后读不到 URL 即回退官方端点，与接入行为对称（patch_antigravity_ide_extension）。
        // 门控开启：字段级还原（用户自己设过 cloudCodeUrl 时写回原值）
        if crate::commands::agent_stash::field_restore_enabled() {
            match crate::commands::field_restore::restore_json_fields_via_stash(
                path,
                &antigravity_ide_stash_key(),
                stash_dir,
                "Antigravity IDE",
            ) {
                Ok(true) => {
                    if allow_host_side_effects && !cfg!(test) {
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            let _ = std::process::Command::new("reg")
                                .args(&["delete", "HKCU\\Environment", "/v", "CLOUD_CODE_URL", "/f"])
                                .creation_flags(0x0800_0000)
                                .output();
                        }
                        // 字段级还原只写回本端原值，另一端残留仍需成套清理。
                        clear_antigravity_stale_managed_endpoints();
                        #[cfg(windows)]
                        Self::kill_antigravity_language_server();
                    }
                    return Ok(());
                }
                Ok(false) => {}
                Err(e) => {
                    eprintln!("[agent-stash] Antigravity IDE 字段级还原失败，退回删键: {e}");
                }
            }
        }

        // 只删自己那一行，Kite 的 antigravityKite.* 键与注释原样保留。
        let _ = write_settings_endpoint(path, None);

        if allow_host_side_effects && !cfg!(test) {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("reg")
                    .args(&["delete", "HKCU\\Environment", "/v", "CLOUD_CODE_URL", "/f"])
                    .creation_flags(0x0800_0000)
                    .output();
            }

            // reg delete 只改注册表，已运行的 IDE 主进程及其子进程继承的
            // CLOUD_CODE_URL 环境块不变。必须终止语言服务促其热重启，让
            // buildServerEnv 的注入块（先 delete 再按需写）以干净环境重建。
            // 否则用户只还原黑底、白底 settings 仍指向本地网关时，agy.exe
            // 会被钉在已停掉的网关上，userInfo 永远拿不到（v1.1.0 事故）。
            // 成套还原：另一端若还残留本地网关地址，网关一停就是死端点。
            clear_antigravity_stale_managed_endpoints();

            #[cfg(windows)]
            Self::kill_antigravity_language_server();
        }
        Ok(())
    }


    #[cfg(test)]
    pub(in crate::commands::platforms) fn apply_antigravity_official_with_stash(
        &self,
        path: &PathBuf,
        stash_dir: &Path,
    ) -> Result<(), String> {
        let _guard = crate::commands::inject_lock();
        let allow_host_side_effects = !cfg!(test);
        self.apply_antigravity_official_with_stash_locked(path, stash_dir, allow_host_side_effects)
    }

    pub(in crate::commands::platforms) fn apply_antigravity_official_with_stash_locked(
        &self,
        path: &PathBuf,
        stash_dir: &Path,
        allow_host_side_effects: bool,
    ) -> Result<(), String> {
        // 门控开启：字段级还原
        if crate::commands::agent_stash::field_restore_enabled() {
            match crate::commands::field_restore::restore_json_fields_via_stash(
                path,
                &antigravity_stash_key(),
                stash_dir,
                "Antigravity",
            ) {
                Ok(true) => {
                    if allow_host_side_effects && !cfg!(test) {
                        clear_antigravity_stale_managed_endpoints();
                        #[cfg(windows)]
                        Self::kill_antigravity_language_server();
                    }
                    return Ok(());
                }
                Ok(false) => {}
                Err(e) => {
                    eprintln!("[agent-stash] Antigravity 字段级还原失败，退回删键: {e}");
                }
            }
        }

        let _ = write_settings_endpoint(path, None);

        if allow_host_side_effects && !cfg!(test) {
            // 成套还原：另一端若还残留本地网关地址，网关一停就是死端点。
            clear_antigravity_stale_managed_endpoints();

            // 终止语言服务促使其热重启加载官方端点。
            // 与 apply_antigravity 同源：用原生 API，不用 PowerShell CIM（1-3 秒）。
            #[cfg(windows)]
            Self::kill_antigravity_language_server();
        }
        Ok(())
    }

}
