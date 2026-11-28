//! 增强插件 GitHub 仓库详情拉取与受控图片代理（供弹窗内直览 GitHub 官方在线渲染 README）。
//!
//! 严格白名单限制：
//! - 仓库详情仅允许内置增强插件对应的 GitHub 仓库；
//! - 图片代理仅允许 GitHub/徽章白名单域名，返回 base64 `data:` URI 供前端在直连受阻时无感兜底。
//!
//! 拉取策略（抗 `api.github.com` 匿名限流）：
//! 1. 并发请求 `api.github.com/repos/{repo}`（尽力拿精确 Star/License/更新时间）与
//!    `https://github.com/{repo}` 页面（不受 API 60 次/小时限流，直接携带 GitHub 官方服务端渲染的
//!    `<article class="markdown-body">` 与基础元信息）；
//! 2. 首页非中文时自动探测 `README.zh-CN.md` / `README_zh.md` / `README_CN.md` 的在线渲染 `richText`；
//! 3. 若无法直连 `github.com` 拿在线 HTML，自动降级到 `raw.githubusercontent.com` + 镜像链拉取 Markdown 原文。

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::commands::apply_system_proxy;
use crate::commands::extensions::mirror_candidates;

use super::cdp_themes::CDP_THEME_SPECS;
use super::native_plugins::NATIVE_PLUGIN_SPECS;
use super::{cached_latest_version, CONTEXT_VIEWER_ID, CONTEXT_VIEWER_REPO};

pub(crate) const LOC_UPSTREAM_REPO: &str = "liominsb/Antigravity-Chinese-Localization";
const DETAIL_CACHE_TTL: Duration = Duration::from_secs(600);
const IMAGE_CACHE_TTL: Duration = Duration::from_secs(900);
const IMAGE_CACHE_MAX_ENTRIES: usize = 80;
const MAX_README_BYTES: usize = 256 * 1024;
const MAX_README_HTML_BYTES: usize = 512 * 1024;
const MAX_IMAGE_BYTES: usize = 6 * 1024 * 1024;
const WEB_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ZH_README_CANDIDATES: &[&str] = &["README.zh-CN.md", "README_zh.md", "README_CN.md"];
const README_CANDIDATES: &[&str] = &[
    "README.zh-CN.md",
    "README_zh.md",
    "README_CN.md",
    "README.md",
];

const ALLOWED_IMAGE_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "github.com",
    "camo.githubusercontent.com",
    "user-images.githubusercontent.com",
    "private-user-images.githubusercontent.com",
    "objects.githubusercontent.com",
    "avatars.githubusercontent.com",
    "img.shields.io",
    "shields.io",
    "badgen.net",
    "api.star-history.com",
    "star-history.com",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceGithubDetail {
    pub repo: String,
    pub html_url: String,
    pub default_branch: String,
    pub description: String,
    pub stars: Option<u64>,
    pub license: Option<String>,
    pub updated_at: Option<String>,
    pub latest_version: Option<String>,
    pub readme_filename: String,
    pub readme_markdown: String,
    pub readme_html: Option<String>,
    pub rendered_online: bool,
    pub raw_base_url: String,
}

static DETAIL_CACHE: OnceLock<Mutex<HashMap<String, (Instant, EnhanceGithubDetail)>>> =
    OnceLock::new();
static IMAGE_CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();

pub(crate) fn is_allowed_enhance_repo(repo: &str) -> bool {
    let clean = repo.trim();
    if clean.eq_ignore_ascii_case(CONTEXT_VIEWER_REPO)
        || clean.eq_ignore_ascii_case(LOC_UPSTREAM_REPO)
    {
        return true;
    }
    NATIVE_PLUGIN_SPECS
        .iter()
        .any(|s| s.repo.eq_ignore_ascii_case(clean))
        || CDP_THEME_SPECS
            .iter()
            .any(|s| s.repo.eq_ignore_ascii_case(clean))
}

pub(crate) fn is_allowed_enhance_image_url(url: &str) -> bool {
    let clean = url.trim();
    let Some(rest) = clean.strip_prefix("https://") else {
        return false;
    };
    if rest.is_empty() || rest.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || authority.contains(':') {
        return false;
    }
    let host = authority.to_ascii_lowercase();
    ALLOWED_IMAGE_HOSTS.iter().any(|allowed| host == *allowed)
}

fn plugin_id_for_repo(repo: &str) -> Option<&'static str> {
    let clean = repo.trim();
    if clean.eq_ignore_ascii_case(CONTEXT_VIEWER_REPO) {
        return Some(CONTEXT_VIEWER_ID);
    }
    if let Some(s) = NATIVE_PLUGIN_SPECS
        .iter()
        .find(|s| s.repo.eq_ignore_ascii_case(clean))
    {
        return Some(s.id);
    }
    CDP_THEME_SPECS
        .iter()
        .find(|s| s.repo.eq_ignore_ascii_case(clean))
        .map(|s| s.id)
}

pub(crate) fn build_raw_base_url(repo: &str, branch: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{}/{}",
        repo.trim(),
        branch.trim()
    )
}

fn build_http_client(timeout_secs: u64, ua: &str) -> Result<reqwest::Client, String> {
    apply_system_proxy(reqwest::Client::builder())
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent(ua)
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))
}

#[derive(Default)]
pub(crate) struct RepoMeta {
    pub(crate) default_branch: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) stars: Option<u64>,
    pub(crate) license: Option<String>,
    pub(crate) updated_at: Option<String>,
}

fn decode_basic_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

/// 从 GitHub 仓库网页或 blob HTML 中提取完整的 `<article class="markdown-body ...">...</article>`。
pub(crate) fn extract_markdown_article(html: &str) -> Option<String> {
    let re = Regex::new(r#"(?i)<article\b[^>]*\bclass="[^"]*\bmarkdown-body\b[^"]*"[^>]*>"#).ok()?;
    let m = re.find(html)?;
    let start = m.start();
    let tail = &html[m.end()..];

    let mut depth: usize = 1;
    let mut cursor: usize = 0;
    let tag_re = Regex::new(r#"(?i)</?article\b[^>]*>"#).ok()?;
    for tm in tag_re.find_iter(tail) {
        let s = tm.as_str();
        if s.starts_with("</") {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                cursor = m.end() + tm.end();
                break;
            }
        } else {
            depth += 1;
        }
    }
    if cursor <= start {
        return None;
    }
    let slice = &html[start..cursor];
    if slice.len() > MAX_README_HTML_BYTES {
        return None;
    }
    Some(slice.to_string())
}

fn parse_star_count(raw: &str) -> Option<u64> {
    let cleaned = raw.trim().replace(',', "");
    if cleaned.is_empty() {
        return None;
    }
    if let Ok(n) = cleaned.parse::<u64>() {
        return Some(n);
    }
    let lower = cleaned.to_ascii_lowercase();
    if let Some(num) = lower.strip_suffix('k') {
        return num.parse::<f64>().ok().map(|v| (v * 1000.0).round() as u64);
    }
    if let Some(num) = lower.strip_suffix('m') {
        return num
            .parse::<f64>()
            .ok()
            .map(|v| (v * 1_000_000.0).round() as u64);
    }
    None
}

pub(crate) fn extract_page_meta(html: &str, repo: &str) -> RepoMeta {
    let mut meta = RepoMeta::default();

    if let Ok(re) = Regex::new(r#"(?:data-default-branch|"defaultBranch")\s*[:=]\s*"([^"]+)""#) {
        if let Some(cap) = re.captures(html) {
            let b = cap[1].trim();
            if !b.is_empty() {
                meta.default_branch = Some(b.to_string());
            }
        }
    }

    if let Ok(re) = Regex::new(r#"(?i)<meta\s+name="description"\s+content="([^"]+)""#) {
        if let Some(cap) = re.captures(html) {
            let mut desc = decode_basic_html_entities(cap[1].trim());
            let suffix = format!(" - {repo}");
            if let Some(stripped) = desc.strip_suffix(&suffix) {
                desc = stripped.trim().to_string();
            }
            if !desc.is_empty() && !desc.starts_with("Contribute to ") {
                meta.description = Some(desc);
            }
        }
    }

    if let Ok(re) = Regex::new(
        r#"(?is)id="repo-stars-counter-star"[^>]*?(?:title="([^"]+)"|aria-label="(\d[\d,]*)\s+users)"#,
    ) {
        if let Some(cap) = re.captures(html) {
            let raw = cap.get(1).or_else(|| cap.get(2)).map(|m| m.as_str()).unwrap_or("");
            meta.stars = parse_star_count(raw);
        }
    }
    if meta.stars.is_none() {
        if let Ok(re) = Regex::new(r#"(?is)/stargazers"[\s\S]{0,360}?<strong[^>]*>([\d.,kKmM]+)</strong>"#) {
            if let Some(cap) = re.captures(html) {
                meta.stars = parse_star_count(&cap[1]);
            }
        }
    }

    if let Ok(re) = Regex::new(r#"(?i)([A-Za-z0-9.-]+)\s+license\s*</a>"#) {
        if let Some(cap) = re.captures(html) {
            let lic = cap[1].trim();
            if !lic.is_empty() && !lic.eq_ignore_ascii_case("view") {
                meta.license = Some(lic.to_string());
            }
        }
    }

    meta
}

/// 粗略判断已渲染的 HTML 片段是否包含足够多的中文内容（用于决定是否无需再探测 `README.zh-CN.md`）。
pub(crate) fn html_has_significant_chinese(html: &str) -> bool {
    let mut cjk = 0usize;
    for ch in html.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            cjk += 1;
            if cjk >= 24 {
                return true;
            }
        }
    }
    false
}

async fn fetch_repo_meta(client: &reqwest::Client, repo: &str) -> RepoMeta {
    let url = format!("https://api.github.com/repos/{repo}");
    let Ok(resp) = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    else {
        return RepoMeta::default();
    };
    if !resp.status().is_success() {
        return RepoMeta::default();
    }
    let Ok(json) = resp.json::<serde_json::Value>().await else {
        return RepoMeta::default();
    };
    RepoMeta {
        default_branch: json
            .get("default_branch")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        description: json
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        stars: json.get("stargazers_count").and_then(|v| v.as_u64()),
        license: json
            .get("license")
            .and_then(|l| l.get("spdx_id").or_else(|| l.get("name")))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "NOASSERTION")
            .map(str::to_string),
        updated_at: json
            .get("pushed_at")
            .or_else(|| json.get("updated_at"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }
}

async fn fetch_github_repo_page(
    client: &reqwest::Client,
    repo: &str,
) -> Option<(RepoMeta, Option<String>)> {
    let url = format!("https://github.com/{repo}");
    let resp = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().await.ok()?;
    if html.is_empty() {
        return None;
    }
    let meta = extract_page_meta(&html, repo);
    let article = extract_markdown_article(&html);
    Some((meta, article))
}

async fn fetch_github_blob_rendered_html(
    client: &reqwest::Client,
    repo: &str,
    branch: &str,
    filename: &str,
) -> Option<String> {
    let url = format!("https://github.com/{repo}/blob/{branch}/{filename}");
    for _attempt in 0..2 {
        if let Ok(resp) = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            if resp.status().as_u16() == 404 {
                return None;
            }
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(trimmed) = json
                        .pointer("/payload/codeViewBlobRoute/richText")
                        .or_else(|| json.pointer("/payload/blob/richText"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                    {
                        if !trimmed.is_empty() && trimmed.len() <= MAX_README_HTML_BYTES {
                            return Some(trimmed.to_string());
                        }
                    }
                }
            }
        }
        // JSON payload 偶发 504 或结构变更时，直接抓网页 HTML 提取官方渲染 article
        if let Ok(resp) = client
            .get(&format!("{url}?plain=0"))
            .header("Accept", "text/html,application/xhtml+xml")
            .send()
            .await
        {
            if resp.status().as_u16() == 404 {
                return None;
            }
            if resp.status().is_success() {
                if let Ok(html) = resp.text().await {
                    if let Some(article) = extract_markdown_article(&html) {
                        return Some(article);
                    }
                }
            }
        }
    }
    None
}

async fn fetch_text_with_mirrors(client: &reqwest::Client, raw_url: &str) -> Option<String> {
    for candidate in mirror_candidates(raw_url) {
        let Ok(resp) = client.get(&candidate).send().await else {
            continue;
        };
        if resp.status().as_u16() == 404 {
            if candidate == raw_url {
                return None;
            }
            continue;
        }
        if !resp.status().is_success() {
            continue;
        }
        if let Ok(bytes) = resp.bytes().await {
            if bytes.is_empty() {
                continue;
            }
            let slice = if bytes.len() > MAX_README_BYTES {
                &bytes[..MAX_README_BYTES]
            } else {
                &bytes[..]
            };
            let text = String::from_utf8_lossy(slice).to_string();
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

async fn fetch_readme_markdown(
    client: &reqwest::Client,
    repo: &str,
    preferred_branch: Option<&str>,
) -> Option<(String, String, String)> {
    let mut branches: Vec<String> = Vec::new();
    if let Some(b) = preferred_branch {
        if !b.trim().is_empty() {
            branches.push(b.trim().to_string());
        }
    }
    for fallback in ["main", "master"] {
        if !branches.iter().any(|b| b == fallback) {
            branches.push(fallback.to_string());
        }
    }

    for branch in branches {
        for filename in README_CANDIDATES {
            let raw_url = format!("https://raw.githubusercontent.com/{repo}/{branch}/{filename}");
            if let Some(markdown) = fetch_text_with_mirrors(client, &raw_url).await {
                return Some((branch, (*filename).to_string(), markdown));
            }
        }
    }
    None
}

pub(crate) async fn fetch_enhance_github_detail(
    repo: String,
    force_refresh: bool,
) -> Result<EnhanceGithubDetail, String> {
    let clean_repo = repo.trim().to_string();
    if !is_allowed_enhance_repo(&clean_repo) {
        return Err(format!("不支持查看未登记的仓库详情：{clean_repo}"));
    }

    if !force_refresh {
        let cache = DETAIL_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(map) = cache.lock() {
            if let Some((ts, cached)) = map.get(&clean_repo) {
                if ts.elapsed() < DETAIL_CACHE_TTL {
                    return Ok(cached.clone());
                }
            }
        }
    }

    let api_client = build_http_client(6, "AnyBridge-Enhance-Viewer")?;
    let web_client = build_http_client(12, WEB_USER_AGENT)?;

    let (api_meta, page_res) = tokio::join!(
        fetch_repo_meta(&api_client, &clean_repo),
        fetch_github_repo_page(&web_client, &clean_repo),
    );

    let (page_meta, page_article) = page_res.unwrap_or_else(|| (RepoMeta::default(), None));
    let merged_branch = api_meta
        .default_branch
        .or(page_meta.default_branch)
        .unwrap_or_else(|| "main".to_string());
    let description = api_meta
        .description
        .or(page_meta.description)
        .unwrap_or_default();
    let stars = api_meta.stars.or(page_meta.stars);
    let license = api_meta.license.or(page_meta.license);
    let updated_at = api_meta.updated_at.or(page_meta.updated_at);

    let mut readme_html: Option<String> = None;
    let mut readme_filename = "README.md".to_string();
    let mut branch = merged_branch;
    let mut readme_markdown = String::new();

    if let Some(article) = page_article {
        if html_has_significant_chinese(&article) {
            readme_html = Some(article);
        } else {
            let mut found_zh = None;
            for candidate in ZH_README_CANDIDATES {
                if let Some(zh_html) =
                    fetch_github_blob_rendered_html(&web_client, &clean_repo, &branch, candidate)
                        .await
                {
                    found_zh = Some(((*candidate).to_string(), zh_html));
                    break;
                }
            }
            if let Some((fname, zh_html)) = found_zh {
                readme_filename = fname;
                readme_html = Some(zh_html);
            } else {
                // 若网页版中文 README 临时不可达，检查 raw 是否存在中文版，有则优先展示中文说明
                let raw_client = build_http_client(8, "AnyBridge-Enhance-Viewer")?;
                for candidate in ZH_README_CANDIDATES {
                    let raw_url = format!("https://raw.githubusercontent.com/{clean_repo}/{branch}/{candidate}");
                    if let Some(zh_md) = fetch_text_with_mirrors(&raw_client, &raw_url).await {
                        readme_filename = (*candidate).to_string();
                        readme_markdown = zh_md;
                        break;
                    }
                }
                if readme_markdown.is_empty() {
                    readme_html = Some(article);
                }
            }
        }
    }

    let rendered_online = readme_html.is_some();

    // 在线 HTML 不可用且尚未拿到中文 Markdown 时，通过 raw + 镜像链拉取 Markdown 原文作为兜底
    if !rendered_online && readme_markdown.is_empty() {
        let raw_client = build_http_client(12, "AnyBridge-Enhance-Viewer")?;
        if let Some((found_branch, found_file, found_md)) =
            fetch_readme_markdown(&raw_client, &clean_repo, Some(&branch)).await
        {
            branch = found_branch;
            readme_filename = found_file;
            readme_markdown = found_md;
        } else if description.is_empty() && stars.is_none() {
            return Err(
                "无法拉取 GitHub 仓库说明，请检查网络连接或在外部浏览器打开查看。".to_string(),
            );
        }
    }

    let latest_version = plugin_id_for_repo(&clean_repo).and_then(cached_latest_version);
    let detail = EnhanceGithubDetail {
        html_url: format!("https://github.com/{clean_repo}"),
        raw_base_url: build_raw_base_url(&clean_repo, &branch),
        repo: clean_repo.clone(),
        default_branch: branch,
        description,
        stars,
        license,
        updated_at,
        latest_version,
        readme_filename,
        readme_markdown,
        readme_html,
        rendered_online,
    };

    let cache = DETAIL_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = cache.lock() {
        map.insert(clean_repo, (Instant::now(), detail.clone()));
    }

    Ok(detail)
}

pub(crate) fn detect_image_mime(content_type: Option<&str>, bytes: &[u8], url: &str) -> Option<&'static str> {
    if let Some(ct) = content_type {
        let base = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        match base.as_str() {
            "image/png" => return Some("image/png"),
            "image/jpeg" | "image/jpg" => return Some("image/jpeg"),
            "image/gif" => return Some("image/gif"),
            "image/webp" => return Some("image/webp"),
            "image/svg+xml" => return Some("image/svg+xml"),
            "image/avif" => return Some("image/avif"),
            "image/x-icon" | "image/vnd.microsoft.icon" => return Some("image/x-icon"),
            _ => {}
        }
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).trim_start().to_string();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
        return Some("image/svg+xml");
    }
    let path_lower = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if path_lower.ends_with(".svg") {
        return Some("image/svg+xml");
    }
    None
}

pub(crate) async fn fetch_enhance_github_image(url: String) -> Result<String, String> {
    let clean_url = url.trim().to_string();
    if !is_allowed_enhance_image_url(&clean_url) {
        return Err("不支持代理非白名单域名的图片地址".to_string());
    }

    {
        let cache = IMAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(map) = cache.lock() {
            if let Some((ts, cached)) = map.get(&clean_url) {
                if ts.elapsed() < IMAGE_CACHE_TTL {
                    return Ok(cached.clone());
                }
            }
        }
    }

    let client = build_http_client(12, WEB_USER_AGENT)?;
    let use_mirrors = clean_url.starts_with("https://raw.githubusercontent.com/")
        || clean_url.starts_with("https://github.com/");
    let candidates = if use_mirrors {
        mirror_candidates(&clean_url)
    } else {
        vec![clean_url.clone()]
    };

    let mut last_err = String::from("图片拉取失败");
    for candidate in candidates {
        let resp = match client
            .get(&candidate)
            .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        if !resp.status().is_success() {
            last_err = format!("HTTP {}", resp.status().as_u16());
            continue;
        }
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(len) = resp.content_length() {
            if len as usize > MAX_IMAGE_BYTES {
                return Err("图片体积超出限制".to_string());
            }
        }
        let Ok(bytes) = resp.bytes().await else {
            last_err = "读取图片响应失败".to_string();
            continue;
        };
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            last_err = "图片内容为空或超出限制".to_string();
            continue;
        }
        let Some(mime) = detect_image_mime(ct.as_deref(), &bytes, &clean_url) else {
            last_err = "响应不是有效图片格式".to_string();
            continue;
        };
        let data_uri = format!("data:{mime};base64,{}", BASE64_STANDARD.encode(&bytes));

        let cache = IMAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(mut map) = cache.lock() {
            if map.len() >= IMAGE_CACHE_MAX_ENTRIES {
                map.retain(|_, (ts, _)| ts.elapsed() < IMAGE_CACHE_TTL);
                if map.len() >= IMAGE_CACHE_MAX_ENTRIES {
                    if let Some(oldest_key) = map
                        .iter()
                        .min_by_key(|(_, (ts, _))| *ts)
                        .map(|(k, _)| k.clone())
                    {
                        map.remove(&oldest_key);
                    }
                }
            }
            map.insert(clean_url, (Instant::now(), data_uri.clone()));
        }
        return Ok(data_uri);
    }

    Err(last_err)
}
