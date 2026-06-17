pub mod cert_install;
pub mod config;
pub mod eval;
pub mod ide_config;
pub mod ide_models;
pub mod model_map;
pub mod platforms;
pub mod provider_import;
pub mod proxy;
pub mod system;
pub mod update;
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
fn windows_user_proxy_url() -> Option<String> {
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
fn windows_user_proxy_url() -> Option<String> {
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

/// 原子写：先写同目录临时文件再 rename 覆盖，避免写入中途崩溃留下截断文件。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("byok-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}
