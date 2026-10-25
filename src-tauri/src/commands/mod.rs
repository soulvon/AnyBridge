pub mod antigravity_loc_payload;
pub mod antigravity_localization;
pub mod agent_spec;
pub mod declared_apply;
pub mod app_localization;
pub mod cert_install;
pub mod claude_desktop;
pub mod codex_desktop;
pub mod codex_session_visibility;
pub mod config;
pub mod cursor_auth;
pub mod cursor_core;
pub mod cursor_models;
pub mod eval;
pub mod extensions;
pub mod ide_config;
pub mod ide_models;
pub mod model_map;
pub mod platforms;
pub mod plugin_asset;
pub mod plugins;
pub mod provider_import;
pub mod proxy;
pub mod proxy_routes;
pub mod system;
pub mod update;
pub mod version_probe;
pub mod windsurf_catalog;
pub mod workbench_inject;

use std::path::Path;

#[cfg(target_os = "windows")]
fn reg_query_current_user_internet_setting(value_name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;

    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            value_name,
        ])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(value_name) {
            return None;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 3 {
            return None;
        }
        Some(parts[2..].join(" "))
    })
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let pick = raw
        .split(';')
        .find_map(|part| part.trim().strip_prefix("https=").map(str::trim))
        .or_else(|| {
            raw.split(';')
                .find_map(|part| part.trim().strip_prefix("http=").map(str::trim))
        })
        .or_else(|| {
            raw.split(';')
                .map(str::trim)
                .find(|part| !part.is_empty())
                .map(|part| part.split_once('=').map(|(_, v)| v).unwrap_or(part).trim())
        })?;

    if pick.is_empty() {
        None
    } else if pick.starts_with("http://") || pick.starts_with("https://") {
        Some(pick.to_string())
    } else {
        Some(format!("http://{}", pick))
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_user_proxy_url() -> Option<String> {
    let enabled = reg_query_current_user_internet_setting("ProxyEnable")?;
    let enabled = enabled.trim();
    let is_enabled = enabled == "1" || enabled.eq_ignore_ascii_case("0x1");
    if !is_enabled {
        return None;
    }
    let server = reg_query_current_user_internet_setting("ProxyServer")?;
    parse_windows_proxy_server(&server)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn windows_user_proxy_url() -> Option<String> {
    None
}

pub(crate) fn apply_system_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let Some(proxy_url) = windows_user_proxy_url() else {
        return builder;
    };
    match reqwest::Proxy::all(&proxy_url) {
        Ok(proxy) => builder.proxy(proxy),
        Err(_) => builder,
    }
}

/// 注入/还原操作的全局互斥锁。
///
/// 为什么需要：BYOK 接入、界面汉化、汉化保活 keeper 可能并发对同一个
/// workbench.html 做「读-改-写」。无锁时后完成者会把旧读入的内容整体写回，
/// 覆盖前者的结果——典型事故：用户点还原（剥离完成），keeper 线程恰好在此前
/// 读入了含块的旧内容并写回，块"复活"，用户以为还原了其实没有。
///
/// 纪律：所有对 workbench.html / product.json / main.js 的读-改-写序列
/// （inject / restore / apply / keeper_tick）必须持此锁；只读探测不持锁。
/// 网络下载（如语言包 VSIX）绝不放在锁内，避免 keeper 被长时间挡住。
pub(crate) static INJECT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 获取注入锁；锁中毒（前一个持有者 panic）时恢复内部数据继续用，
/// 绝不让一次 panic 永久卡死后续所有注入/还原/保活。
pub(crate) fn inject_lock() -> std::sync::MutexGuard<'static, ()> {
    INJECT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 拉取 GitHub 内容文本：原始 URL 优先，失败依次尝试扩展镜像清单
/// （用户在扩展页配置的 mirrors.json，prefix 镜像对 raw 域名有效）。
///
/// 为什么不用 api.github.com：未认证限额 60 次/小时且按出口 IP 计——
/// Clash 共享节点的出口 IP 早被全球用户刷爆（实测 HTTP 403 Forbidden）。
/// raw.githubusercontent.com 是 CDN 不设此限制，故统一走 raw + 镜像兜底。
/// 把 raw.githubusercontent.com 的链接扩展成多镜像候选清单（对齐上游
/// good9527/Claude-Desktop-Chinese 的 Get-CdnFile：jsdelivr/fastly/ghfast/原始）。
/// 原始 URL 形式：`https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
fn cdn_mirror_candidates(url: &str) -> Vec<String> {
    let mut out = vec![url.to_string()];
    let Some(rest) = url.strip_prefix("https://raw.githubusercontent.com/") else {
        return out;
    };
    let parts: Vec<&str> = rest.splitn(4, '/').collect();
    if parts.len() < 4 {
        return out;
    }
    let (owner, repo, git_ref, path) = (parts[0], parts[1], parts[2], parts[3]);
    let gh_raw = format!("https://raw.githubusercontent.com/{owner}/{repo}/{git_ref}/{path}");
    out.push(format!("https://ghfast.top/{gh_raw}"));
    out.push(format!("https://fastly.jsdelivr.net/gh/{owner}/{repo}@{git_ref}/{path}"));
    out.push(format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{git_ref}/{path}"));
    out
}

pub(crate) async fn fetch_github_content(url: &str, timeout_secs: u64) -> Result<String, String> {
    let client = apply_system_proxy(
        reqwest::Client::builder()
            .user_agent("AnyBridge-Desktop-Client")
            .timeout(std::time::Duration::from_secs(timeout_secs)),
    )
    .build()
    .map_err(|e| e.to_string())?;

    let mut last_err = String::new();
    // 候选：CPA 扩展镜像清单（用户在扩展页配的）+ 上游同款 CDN 镜像
    let mut candidates = extensions::mirror_candidates(url);
    for m in cdn_mirror_candidates(url) {
        if !candidates.contains(&m) {
            candidates.push(m);
        }
    }
    for candidate in candidates {
        match client.get(&candidate).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(text) if !text.trim().is_empty() => return Ok(text),
                Ok(_) => last_err = format!("{} 返回空内容", candidate),
                Err(e) => last_err = format!("{} 读取失败: {}", candidate, e),
            },
            Ok(resp) => {
                last_err = format!("{} HTTP {}", candidate, resp.status());
            }
            Err(e) => {
                last_err = format!("{} 请求失败: {}", candidate, e);
            }
        }
    }
    Err(format!(
        "所有下载源均失败（{}）。可稍后重试，或在扩展设置的 GitHub 镜像里添加可用镜像",
        last_err
    ))
}

/// 内容 SHA256（版本指纹）：与上游 commit sha 解耦，纯内容比对。
pub(crate) fn content_sha256(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// 原子写：先写同目录临时文件再 rename 覆盖，避免写入中途崩溃留下截断文件。
/// Windows 上 rename 可能因杀毒软件/索引服务锁定目标文件而 EPERM，重试 3 次。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("byok-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let mut last_err = String::new();
    for i in 0..3u32 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if i < 2 { std::thread::sleep(std::time::Duration::from_millis(50)); }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(last_err)
}
