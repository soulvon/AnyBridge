use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use super::*;

// ═══════ 部署 ═══════

/// CPA 套件部署/更新/安装/切换的全局互斥锁，防止并发操作互相干扰
pub(super) static CPA_DEPLOY_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

pub(super) fn cpa_deploy_lock() -> &'static tokio::sync::Mutex<()> {
    CPA_DEPLOY_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeployProgress {
    pub(super) step: String,
    pub(super) message: String,
    pub(super) percent: u8,
    pub(super) is_error: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct GithubAsset {
    pub(super) name: String,
    pub(super) browser_download_url: String,
    pub(super) size: u64,
}

#[derive(Debug, Deserialize)]
pub(super) struct GithubReleaseWithAssets {
    pub(super) tag_name: String,
    pub(super) assets: Vec<GithubAsset>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct CpaSecrets {
    pub(super) admin_key: String,
    pub(super) management_key: String,
    pub(super) api_key: String,
}

pub(super) fn emit_deploy_progress(app: &AppHandle, step: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "deploy-progress",
        DeployProgress {
            step: step.into(),
            message: message.into(),
            percent,
            is_error: false,
        },
    );
}

pub(super) fn build_github_client() -> Result<reqwest::Client, String> {
    let mut builder = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(GITHUB_TIMEOUT_SECS))
        .user_agent(format!(
            "AnyBridge-Extension-Deploy/{}",
            env!("CARGO_PKG_VERSION")
        ));

    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(auth) = format!("Bearer {}", token).parse() {
            headers.insert(reqwest::header::AUTHORIZATION, auth);
        }
        if let Ok(accept) = "application/vnd.github+json".parse() {
            headers.insert(reqwest::header::ACCEPT, accept);
        }
        builder = builder.default_headers(headers);
    }

    builder.build().map_err(|e| e.to_string())
}

pub(super) fn generate_random_key(len: usize) -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub(super) async fn fetch_release_with_assets(repo: &str) -> Result<GithubReleaseWithAssets, String> {
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        match fetch_release_with_assets_attempt(repo).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                last_err = e;
                if attempt < 2 {
                    let delay = Duration::from_secs(2 * (attempt + 1) as u64);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_err)
}

pub(super) async fn fetch_release_with_assets_attempt(repo: &str) -> Result<GithubReleaseWithAssets, String> {
    let client = build_github_client()?;
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub 最新发布包失败 {}：{}", repo, e))?;
    let status = response.status();
    if status.is_success() {
        return response
            .json::<GithubReleaseWithAssets>()
            .await
            .map_err(|e| format!("无法解析 GitHub 发布包信息 {}：{}", repo, e));
    }

    // 403/429 通常为 API 未认证限流；404 可能是 release 不存在或 API 被限制。使用网页抓取兜底。
    if status == 403 || status == 429 || status == 404 {
        let release = fetch_latest_release_via_web_redirect(repo).await?;
        let tag = &release.tag_name;
        return fetch_release_assets_via_web(repo, tag).await;
    }

    Err(format!(
        "GitHub 最新发布包请求失败 {}：HTTP {}（未认证 API 请求易被限流，可设置 GITHUB_TOKEN 环境变量提升额度）",
        repo, status
    ))
}

pub(super) async fn fetch_release_with_assets_by_tag(
    repo: &str,
    tag: &str,
) -> Result<GithubReleaseWithAssets, String> {
    let client = build_github_client()?;
    let tag = tag.trim().trim_start_matches('v').trim_start_matches('V');
    // 先试 tags/vX，再试 tags/X
    let candidates = [
        format!("v{}", tag),
        tag.to_string(),
        format!("V{}", tag),
    ];
    let mut last_err = String::new();
    let mut rate_limited = false;
    for tag_name in &candidates {
        let url = format!(
            "https://api.github.com/repos/{}/releases/tags/{}",
            repo, tag_name
        );
        let response = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("请求 GitHub 指定版本失败 {} @ {}：{}", repo, tag_name, e))?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<GithubReleaseWithAssets>()
                .await
                .map_err(|e| format!("无法解析 GitHub 发布包 {} @ {}：{}", repo, tag_name, e));
        }
        last_err = format!("HTTP {}", status);
        if status == 403 || status == 429 {
            rate_limited = true;
            break;
        }
        if status != 404 {
            break;
        }
    }

    // API 限流时，通过网页抓取兜底
    if rate_limited {
        for tag_name in &candidates {
            if let Ok(release) = fetch_release_assets_via_web(repo, tag_name).await {
                return Ok(release);
            }
        }
    }

    Err(format!(
        "未找到 {} 的发布版本 {}（{}）",
        repo, tag, last_err
    ))
}

/// 递归复制目录内容（用于迁移旧版本 auth/、plugins/ 等数据）
pub(super) fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dst)
        .map_err(|e| format!("创建目录 {} 失败: {}", dst.display(), e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {}", src.display(), e))? {
        let entry =
            entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_contents(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制文件 {} 失败: {}", src_path.display(), e))?;
        }
    }
    Ok(())
}

/// 通过 GitHub 网页抓取 release 资产列表，绕过 API 限流。
/// 抓取 expanded_assets 页面，解析其中的下载链接。
pub(super) async fn fetch_release_assets_via_web(
    repo: &str,
    tag: &str,
) -> Result<GithubReleaseWithAssets, String> {
    let client = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(GITHUB_TIMEOUT_SECS))
        .user_agent(format!(
            "AnyBridge-Extension-Deployer/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://github.com/{}/releases/expanded_assets/{}",
        repo, tag
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 GitHub 发布资产页失败 {} @ {}：{}", repo, tag, e))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "GitHub 发布资产页请求失败 {} @ {}：HTTP {}",
            repo, tag, status
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("读取 GitHub 发布资产页失败：{}", e))?;

    // 解析 HTML 中的下载链接，格式如：href="/repo/releases/download/tag/filename"
    let prefix = format!("/{}/releases/download/{}/", repo, tag);
    let mut assets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for segment in html.split('"') {
        if let Some(rest) = segment.strip_prefix(&prefix) {
            let filename = rest.trim_end_matches('"').trim();
            if !filename.is_empty()
                && !filename.contains('/')
                && !filename.contains('\\')
                && seen.insert(filename.to_string())
            {
                let download_url = format!("https://github.com{}{}", prefix, filename);
                assets.push(GithubAsset {
                    name: filename.to_string(),
                    browser_download_url: download_url,
                    size: 0,
                });
            }
        }
    }

    if assets.is_empty() {
        return Err(format!(
            "无法从 GitHub 发布页解析资产列表 {} @ {}",
            repo, tag
        ));
    }

    Ok(GithubReleaseWithAssets {
        tag_name: tag.to_string(),
        assets,
    })
}

pub(super) fn host_os_tokens() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["windows", "win"]
    }
    #[cfg(target_os = "macos")]
    {
        &["darwin", "macos", "osx", "mac"]
    }
    #[cfg(target_os = "linux")]
    {
        &["linux"]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        &[]
    }
}

pub(super) fn host_arch_tokens() -> Result<&'static [&'static str], String> {
    #[cfg(target_arch = "x86_64")]
    {
        return Ok(&["amd64", "x86_64", "x64"]);
    }
    #[cfg(target_arch = "aarch64")]
    {
        return Ok(&["arm64", "aarch64"]);
    }
    #[cfg(target_arch = "x86")]
    {
        return Ok(&["386", "i386", "ia32", "win32"]);
    }
    #[allow(unreachable_code)]
    Err("当前一键部署不支持此 CPU 架构。".into())
}

pub(super) fn is_release_archive_name(name: &str) -> bool {
    let n = name.to_lowercase();
    // 仅声明 extract_archive 实际支持的格式，避免选出 .tar.bz2 后解压失败
    n.ends_with(".zip") || n.ends_with(".tar.gz") || n.ends_with(".tgz")
}

pub(super) fn asset_matches_host(name: &str, os_tokens: &[&str], arch_tokens: &[&str]) -> bool {
    let n = name.to_lowercase();
    if !is_release_archive_name(&n) {
        return false;
    }
    // 排除明显的其它 OS
    let other_os: &[&str] = match std::env::consts::OS {
        "windows" => &["darwin", "macos", "linux", "freebsd"],
        "macos" => &["windows", "win32", "win64", "linux", "freebsd"],
        "linux" => &["windows", "win32", "win64", "darwin", "macos", "osx"],
        _ => &[],
    };
    if other_os.iter().any(|tok| n.contains(tok)) {
        return false;
    }
    let os_ok = os_tokens.iter().any(|tok| n.contains(tok));
    let arch_ok = arch_tokens.iter().any(|tok| n.contains(tok));
    os_ok && arch_ok
}

/// 在 GitHub release assets 中挑选当前 OS/arch 的安装包（zip / tar.gz）。
pub(super) fn find_platform_release_asset<'a>(
    assets: &'a [GithubAsset],
    label: &str,
) -> Result<&'a GithubAsset, String> {
    let os_tokens = host_os_tokens();
    if os_tokens.is_empty() {
        return Err(format!("{} 当前操作系统不支持一键部署。", label));
    }
    let arch_tokens = host_arch_tokens()?;

    let candidates: Vec<&GithubAsset> = assets
        .iter()
        .filter(|a| asset_matches_host(&a.name, os_tokens, arch_tokens))
        .collect();

    if candidates.is_empty() {
        let available = assets
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join("、");
        return Err(format!(
            "未在 {} 的 GitHub 发布包中找到匹配当前平台（{} / {}）的安装包。可用资产：{}",
            label,
            std::env::consts::OS,
            std::env::consts::ARCH,
            if available.is_empty() {
                "（无）".into()
            } else {
                available
            }
        ));
    }

    // 优先 zip，其次 tar.gz；同类型取名字更短的（通常是主包而非 source）
    let mut ranked = candidates;
    ranked.sort_by_key(|a| {
        let n = a.name.to_lowercase();
        let ext_rank = if n.ends_with(".zip") {
            0
        } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
            1
        } else {
            2
        };
        (ext_rank, a.name.len())
    });
    ranked
        .into_iter()
        .next()
        .ok_or_else(|| format!("{} 未找到可用安装包", label))
}

/// 下载专用 HTTP 客户端：超时 300s（大文件需要足够时间），区别于 API 客户端的 15s
pub(super) fn build_download_client() -> Result<reqwest::Client, String> {
    let builder = crate::commands::apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(300))
        .user_agent(format!(
            "AnyBridge-Extension-Deployer/{}",
            env!("CARGO_PKG_VERSION")
        ));
    builder.build().map_err(|e| e.to_string())
}

/// 进度回调：调用方决定进度事件投递到哪个界面（扩展部署 / 插件部署）。
pub(crate) type DownloadProgress<'a> = &'a (dyn Fn(&str, u8) + Send + Sync);

/// 从单个 URL 下载文件（带进度回调 + 停滞检测），返回下载的临时文件路径
pub(super) async fn download_from_url(
    url: &str,
    tmp: &Path,
    on_progress: DownloadProgress<'_>,
    base_percent: u8,
    end_percent: u8,
) -> Result<(), String> {
    let client = build_download_client()?;
    let response = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载发布包失败：HTTP {}", status));
    }

    let total = response.content_length();
    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| format!("无法创建临时文件: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();
    const STALL_TIMEOUT: Duration = Duration::from_secs(30);

    loop {
        let chunk_future = stream.next();
        match tokio::time::timeout(STALL_TIMEOUT, chunk_future).await {
            Ok(Some(chunk)) => {
                let data = chunk.map_err(|e| format!("下载失败: {}", e))?;
                tokio::io::AsyncWriteExt::write_all(&mut file, &data)
                    .await
                    .map_err(|e| format!("写入临时文件失败: {}", e))?;
                downloaded += data.len() as u64;

                if last_emit.elapsed() >= Duration::from_millis(400) {
                    let (pct, msg) = if let Some(total) = total {
                        let p = base_percent
                            + ((downloaded as f64 / total as f64)
                                * (end_percent - base_percent) as f64) as u8;
                        (
                            p,
                            format!(
                                "下载中 {:.1} / {:.1} MB",
                                downloaded as f64 / 1_000_000.0,
                                total as f64 / 1_000_000.0
                            ),
                        )
                    } else {
                        (
                            base_percent,
                            format!("下载中 {:.1} MB", downloaded as f64 / 1_000_000.0),
                        )
                    };
                    on_progress(&msg, pct);
                    last_emit = std::time::Instant::now();
                }
            }
            Ok(None) => break, // stream ended
            Err(_) => {
                return Err(format!(
                    "下载停滞超时（{}s 无数据），已下载 {:.1} MB",
                    STALL_TIMEOUT.as_secs(),
                    downloaded as f64 / 1_000_000.0
                ));
            }
        }
    }

    // 刷新文件确保数据落盘
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("刷新临时文件失败: {}", e))?;

    // 文件大小校验
    let file_size = tokio::fs::metadata(tmp)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if file_size == 0 {
        return Err("下载完成但文件为空，可能下载源异常".into());
    }
    if let Some(expected) = total {
        if file_size != expected {
            return Err(format!(
                "下载文件大小不匹配：期望 {} 字节，实际 {} 字节",
                expected, file_size
            ));
        }
    }

    Ok(())
}

/// 带镜像测速 + 轮询回退的下载（扩展部署用：进度投递到扩展部署界面）
pub(super) async fn download_asset(
    url: &str,
    filename: &str,
    app: &AppHandle,
    base_percent: u8,
    end_percent: u8,
) -> Result<PathBuf, String> {
    let emit = |msg: &str, pct: u8| emit_deploy_progress(app, "download", msg, pct);
    download_asset_with(url, filename, &emit, base_percent, end_percent).await
}

/// 带镜像测速 + 轮询回退的下载，进度由调用方投递。
///
/// 这是 CPA / 扩展部署用的同一条链路：跟随 Windows 系统代理（reqwest 与 curl 的
/// 证书信任源不同，企业网或本机代理环境下 curl 常常直接 60 失败）、并发测速挑最快
/// 镜像、逐个镜像重试、失败再换源。
pub(crate) async fn download_asset_with(
    url: &str,
    filename: &str,
    on_progress: DownloadProgress<'_>,
    base_percent: u8,
    end_percent: u8,
) -> Result<PathBuf, String> {
    let tmp = std::env::temp_dir().join(filename);

    // 1. 测速
    on_progress("正在测速，寻找最快下载源...", base_percent);
    let ranked = speed_test_mirrors(url).await;

    if ranked.is_empty() {
        // 没有可用镜像，直接从原始 URL 下载
        download_from_url(url, &tmp, on_progress, base_percent, end_percent).await?;
        return Ok(tmp);
    }

    // 2. 按测速结果依次尝试，每个镜像最多重试 2 次
    let mut last_err = String::new();
    for (i, (mirror, duration)) in ranked.iter().enumerate() {
        let mirror_url = build_mirror_url(url, mirror);
        let speed_label = if *duration == u64::MAX {
            "未测速".to_string()
        } else {
            format!("{}ms", duration)
        };

        if i == 0 {
            on_progress(
                &format!("从 {} 下载...（测速 {}）", mirror.name, speed_label),
                base_percent,
            );
        } else {
            on_progress(&format!("切换到 {} 重试下载...", mirror.name), base_percent);
        }

        let mut mirror_err = String::new();
        for attempt in 0..2u32 {
            if attempt > 0 {
                let delay = Duration::from_secs(2u64 * (1 << attempt)); // 4s, 8s
                on_progress(
                    &format!("{} 第 {} 次重试（{}s 后）...", mirror.name, attempt + 1, delay.as_secs()),
                    base_percent,
                );
                tokio::time::sleep(delay).await;
            }
            match download_from_url(&mirror_url, &tmp, on_progress, base_percent, end_percent).await {
                Ok(()) => return Ok(tmp),
                Err(e) => {
                    mirror_err = e;
                    let _ = tokio::fs::remove_file(&tmp).await;
                }
            }
        }
        last_err = mirror_err;
    }

    Err(format!("所有镜像下载均失败，最后错误: {}", last_err))
}

/// 解析 GitHub 发布包的真实下载地址（插件部署复用，避免各处重复实现）。
///
/// 返回 (tag, 下载 URL)。先取版本号（未指定则取 latest），再拉该版本的资产列表做
/// 精确匹配：资产不存在时给出「这个版本有哪些包」的可读报错，而不是让镜像返回一个
/// 语焉不详的 404。
pub(crate) async fn resolve_release_asset(
    repo: &str,
    version: Option<&str>,
    asset_name: &str,
) -> Result<(String, String), String> {
    let tag = match version {
        Some(v) => v.trim().to_string(),
        None => latest_release_tag(repo).await?,
    };
    if tag.is_empty() {
        return Err(format!("无法解析 {} 的发布版本号", repo));
    }

    match fetch_release_assets_via_web(repo, &tag).await {
        Ok(release) => {
            match release
                .assets
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(asset_name))
            {
                Some(asset) => Ok((tag, asset.browser_download_url.clone())),
                None => {
                    let available = release
                        .assets
                        .iter()
                        .map(|a| a.name.as_str())
                        .collect::<Vec<_>>()
                        .join("、");
                    Err(format!(
                        "{} {} 中没有发布包 {}（该版本只有：{}）",
                        repo, tag, asset_name, available
                    ))
                }
            }
        }
        // 资产页解析失败不阻断下载：按 GitHub 的固定 URL 规则拼，HTTP 层错误由镜像重试兜住
        Err(_) => Ok((
            tag.clone(),
            format!(
                "https://github.com/{}/releases/download/{}/{}",
                repo, tag, asset_name
            ),
        )),
    }
}

