use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const KITE_LATEST_RELEASE_API: &str = "https://api.github.com/repos/soulvon/Kite/releases/latest";
const GITHUB_USER_AGENT: &str = "AnyBridge-Kite-Installer";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Serialize)]
pub struct KiteInstallResult {
    pub platform: String,
    pub version: String,
    pub asset_name: String,
    pub ide_path: String,
    pub vsix_path: String,
    pub message: String,
}

#[tauri::command]
pub async fn install_kite_plugin(target: Option<String>) -> Result<KiteInstallResult, String> {
    let platform = normalize_target(target)?;
    let ide_path = detect_ide_install_path(&platform)?;

    let client = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .user_agent(GITHUB_USER_AGENT)
        .build()
        .map_err(|e| format!("创建 Kite 下载客户端失败: {}", e))?;

    let release = fetch_latest_release(&client).await?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name.to_ascii_lowercase().ends_with(".vsix"))
        .ok_or_else(|| "Kite latest release 中未找到 .vsix 插件包".to_string())?;

    let vsix_path = download_asset(&client, asset).await?;
    let install_platform = platform.clone();
    let install_ide_path = ide_path.clone();
    let install_vsix_path = vsix_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_vsix_for_target(&install_platform, &install_ide_path, &install_vsix_path)
    })
    .await
    .map_err(|e| format!("Kite 安装任务失败: {}", e))??;

    let label = platform_label(&platform);
    Ok(KiteInstallResult {
        platform,
        version: release.tag_name,
        asset_name: asset.name.clone(),
        ide_path: ide_path.to_string_lossy().to_string(),
        vsix_path: vsix_path.to_string_lossy().to_string(),
        message: format!(
            "Kite 插件已安装到 {}。如果 IDE 已打开，请重载窗口或重启后查看。",
            label
        ),
    })
}

fn normalize_target(target: Option<String>) -> Result<String, String> {
    let raw = target
        .unwrap_or_else(|| crate::commands::system::detect_target_ide())
        .trim()
        .to_ascii_lowercase();
    let resolved = if raw.is_empty() || raw == "auto" {
        crate::commands::system::detect_target_ide()
    } else {
        raw
    };
    match resolved.as_str() {
        "windsurf" | "devin" => Ok(resolved),
        other => Err(format!(
            "Kite 一键安装当前仅支持 Windsurf / Devin，当前目标为 {}",
            other
        )),
    }
}

fn platform_label(target: &str) -> &'static str {
    match target {
        "devin" => "Devin",
        _ => "Windsurf",
    }
}

async fn fetch_latest_release(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(KITE_LATEST_RELEASE_API)
        .send()
        .await
        .map_err(|e| format!("请求 Kite 最新发布失败: {}", e))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 Kite 最新发布响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "获取 Kite 最新发布失败: HTTP {} {}",
            status,
            truncate_for_error(&body)
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("解析 Kite 最新发布失败: {}", e))
}

async fn download_asset(client: &reqwest::Client, asset: &GithubAsset) -> Result<PathBuf, String> {
    let response = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("下载 Kite 插件包失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "下载 Kite 插件包失败: HTTP {} {}",
            status,
            truncate_for_error(&body)
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取 Kite 插件包失败: {}", e))?;
    if bytes.is_empty() {
        return Err("下载到的 Kite 插件包为空".into());
    }

    let dir = crate::commands::config::config_dir_path().join("kite-plugin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 Kite 插件缓存目录失败: {}", e))?;
    let path = dir.join(safe_asset_file_name(&asset.name));
    crate::commands::write_atomic(&path, &bytes)
        .map_err(|e| format!("写入 Kite 插件包失败: {}", e))?;
    Ok(path)
}

fn safe_asset_file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "kite.vsix".to_string()
    } else {
        out
    }
}

fn truncate_for_error(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(480).collect()
}

fn command_output_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn run_install_command(mut command: Command, display: String) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|e| format!("执行 Kite 安装命令失败: {}\n{}", e, display))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = command_output_text(&output.stdout);
    let stderr = command_output_text(&output.stderr);
    Err(format!(
        "Kite 安装命令失败: {}\nexit: {}\nstdout: {}\nstderr: {}",
        display,
        output.status,
        if stdout.is_empty() {
            "(empty)"
        } else {
            &stdout
        },
        if stderr.is_empty() {
            "(empty)"
        } else {
            &stderr
        }
    ))
}

#[cfg(target_os = "windows")]
fn detect_ide_install_path(target: &str) -> Result<PathBuf, String> {
    crate::commands::system::find_ide_exe(target).ok_or_else(|| {
        format!(
            "未找到 {} 安装位置，无法安装 Kite 插件",
            platform_label(target)
        )
    })
}

#[cfg(target_os = "macos")]
fn detect_ide_install_path(target: &str) -> Result<PathBuf, String> {
    crate::commands::system::find_ide_app(target)
        .ok_or_else(|| format!("未找到 {}.app，无法安装 Kite 插件", platform_label(target)))
}

#[cfg(target_os = "linux")]
fn detect_ide_install_path(target: &str) -> Result<PathBuf, String> {
    crate::commands::system::find_ide_bin(target).ok_or_else(|| {
        format!(
            "未找到 {} 可执行文件，无法安装 Kite 插件",
            platform_label(target)
        )
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn detect_ide_install_path(target: &str) -> Result<PathBuf, String> {
    let _ = target;
    Err("当前系统不支持 Kite 一键安装".into())
}

#[cfg(target_os = "windows")]
fn install_vsix_for_target(target: &str, ide_path: &Path, vsix_path: &Path) -> Result<(), String> {
    let mut command = Command::new(ide_path);
    command
        .arg("--install-extension")
        .arg(vsix_path)
        .arg("--force")
        .creation_flags(0x0800_0000);
    let display = format!(
        "\"{}\" --install-extension \"{}\" --force",
        ide_path.display(),
        vsix_path.display()
    );
    let _ = target;
    run_install_command(command, display)
}

#[cfg(target_os = "macos")]
fn install_vsix_for_target(target: &str, ide_path: &Path, vsix_path: &Path) -> Result<(), String> {
    let cli = resolve_macos_extension_cli(target, ide_path)?;
    let mut command = Command::new(&cli);
    command
        .arg("--install-extension")
        .arg(vsix_path)
        .arg("--force");
    let display = format!(
        "\"{}\" --install-extension \"{}\" --force",
        cli.display(),
        vsix_path.display()
    );
    run_install_command(command, display)
}

#[cfg(target_os = "macos")]
fn resolve_macos_extension_cli(target: &str, app_path: &Path) -> Result<PathBuf, String> {
    let cli_name = match target {
        "devin" => "devin",
        _ => "windsurf",
    };
    let app_name = match target {
        "devin" => "Devin",
        _ => "Windsurf",
    };
    let candidates = [
        app_path
            .join("Contents")
            .join("Resources")
            .join("app")
            .join("bin")
            .join(cli_name),
        app_path.join("Contents").join("MacOS").join(app_name),
    ];
    candidates.into_iter().find(|p| p.exists()).ok_or_else(|| {
        format!(
            "未在 {} 中找到扩展安装命令，无法安装 Kite 插件",
            app_path.display()
        )
    })
}

#[cfg(target_os = "linux")]
fn install_vsix_for_target(target: &str, ide_path: &Path, vsix_path: &Path) -> Result<(), String> {
    let mut command = Command::new(ide_path);
    command
        .arg("--install-extension")
        .arg(vsix_path)
        .arg("--force");
    let display = format!(
        "\"{}\" --install-extension \"{}\" --force",
        ide_path.display(),
        vsix_path.display()
    );
    let _ = target;
    run_install_command(command, display)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn install_vsix_for_target(target: &str, ide_path: &Path, vsix_path: &Path) -> Result<(), String> {
    let _ = (target, ide_path, vsix_path);
    Err("当前系统不支持 Kite 一键安装".into())
}
