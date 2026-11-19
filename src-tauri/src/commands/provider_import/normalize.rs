use crate::commands::config::{ApiFormat, ProviderCapabilities, ProviderStore};
use regex::Regex;
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use super::*;
pub(super) fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub(super) fn parse_json_optional(raw: Option<&str>) -> Value {
    raw.and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn api_key_entries(value: &Value) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    match value {
        Value::Array(items) => {
            for (idx, item) in items.iter().enumerate() {
                if let Some(enabled) = item.get("isEnabled").and_then(Value::as_bool) {
                    if !enabled {
                        continue;
                    }
                }
                if let Some(key) = item.as_str().map(str::to_string).or_else(|| {
                    string_value(item, "apiKey")
                        .or_else(|| string_value(item, "key"))
                        .or_else(|| string_value(item, "value"))
                }) {
                    if key.trim().is_empty() {
                        continue;
                    }
                    let label = string_value(item, "name")
                        .or_else(|| string_value(item, "label"))
                        .unwrap_or_else(|| format!("密钥 {}", idx + 1));
                    entries.push((label, key));
                }
            }
        }
        Value::String(key) if !key.trim().is_empty() => {
            entries.push(("默认密钥".to_string(), key.clone()));
        }
        _ => {}
    }
    entries
}

pub(super) fn cherry_endpoint_url(
    endpoint_configs: &Value,
    default_chat_endpoint: Option<&str>,
) -> Option<String> {
    if let (Some(default_key), Some(obj)) = (default_chat_endpoint, endpoint_configs.as_object()) {
        if let Some(value) = obj.get(default_key) {
            if let Some(url) = recursive_find_url(value) {
                return Some(url);
            }
        }
    }
    recursive_find_url(endpoint_configs)
}

pub(super) fn recursive_find_url(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if looks_like_url(trimmed) {
                Some(trimmed.to_string())
            } else {
                None
            }
        }
        Value::Array(items) => items.iter().find_map(recursive_find_url),
        Value::Object(map) => {
            for key in [
                "baseUrl", "base_url", "apiHost", "api_host", "url", "endpoint",
            ] {
                if let Some(s) = map.get(key).and_then(Value::as_str) {
                    if looks_like_url(s) {
                        return Some(s.trim().to_string());
                    }
                }
            }
            map.values().find_map(recursive_find_url)
        }
        _ => None,
    }
}

pub(super) fn looks_like_url(value: &str) -> bool {
    let v = value.trim().to_lowercase();
    v.starts_with("http://")
        || v.starts_with("https://")
        || v.starts_with("localhost:")
        || v.starts_with("127.0.0.1:")
        || v.starts_with("[::1]:")
}

pub(super) fn recursive_string_contains(value: &Value, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    match value {
        Value::String(s) => s.to_lowercase().contains(&needle),
        Value::Array(items) => items.iter().any(|v| recursive_string_contains(v, &needle)),
        Value::Object(map) => map.iter().any(|(k, v)| {
            k.to_lowercase().contains(&needle) || recursive_string_contains(v, &needle)
        }),
        _ => false,
    }
}

pub(super) fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(super) fn push_string_value(out: &mut Vec<String>, value: &Value, key: &str) {
    if let Some(v) = string_value(value, key) {
        out.push(v);
    }
}

pub(super) fn toml_string_value(config: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"(?m)^\s*{}\s*=\s*["']([^"']+)["']"#, regex::escape(key));
    Regex::new(&pattern)
        .ok()?
        .captures(config)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn toml_section_string_value(config: &str, section: &str, key: &str) -> Option<String> {
    let normalized_target = normalize_toml_section(section);
    let mut in_section = false;
    let mut body = String::new();

    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let current = trimmed.trim_start_matches('[').trim_end_matches(']');
            let normalized = normalize_toml_section(current);
            if in_section && normalized != normalized_target {
                break;
            }
            in_section = normalized == normalized_target;
            continue;
        }
        if in_section {
            body.push_str(line);
            body.push('\n');
        }
    }

    if body.is_empty() {
        None
    } else {
        toml_string_value(&body, key)
    }
}

pub(super) fn normalize_toml_section(section: &str) -> String {
    section
        .split('.')
        .map(|part| part.trim().trim_matches('"').trim_matches('\''))
        .collect::<Vec<_>>()
        .join(".")
}

pub(super) fn is_official_dashscope_host(host: &str) -> bool {
    let hostname = reqwest::Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            host.trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    matches!(
        hostname.as_str(),
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com"
    )
}

pub(super) fn normalize_endpoint(
    base_url: &str,
    api_format: &ApiFormat,
    wire_api: Option<&str>,
) -> (String, Option<String>) {
    let mut raw = base_url.trim().trim_end_matches('/').to_string();
    if !raw.starts_with("http://") && !raw.starts_with("https://") {
        raw = format!("https://{}", raw);
    }

    if let Ok(url) = reqwest::Url::parse(&raw) {
        let host = match url.port() {
            Some(port) => format!(
                "{}://{}:{}",
                url.scheme(),
                url.host_str().unwrap_or_default(),
                port
            ),
            None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
        };
        let path = url.path().trim_end_matches('/').to_string();
        let lower_path = path.to_lowercase();
        let is_responses = wire_api
            .map(|v| v.eq_ignore_ascii_case("responses"))
            .unwrap_or_else(|| lower_path.contains("/responses"));

        let api_path = match api_format {
            ApiFormat::Anthropic => {
                if lower_path.is_empty() || lower_path == "/" {
                    "/v1/messages".to_string()
                } else if lower_path.ends_with("/messages") {
                    path
                } else if lower_path.ends_with("/v1") {
                    format!("{}/messages", path)
                } else {
                    format!("{}/v1/messages", path)
                }
            }
            ApiFormat::Openai => {
                if is_official_dashscope_host(&host) {
                    if lower_path.ends_with("/compatible-mode/v1/responses")
                        || lower_path.ends_with("/compatible-mode/v1/chat/completions")
                    {
                        path
                    } else if lower_path == "/v1/chat/completions"
                        || lower_path == "/api/v1/chat/completions"
                    {
                        "/compatible-mode/v1/chat/completions".to_string()
                    } else if lower_path == "/v1/responses" || lower_path == "/api/v1/responses" {
                        "/compatible-mode/v1/responses".to_string()
                    } else if lower_path.is_empty()
                        || lower_path == "/"
                        || lower_path == "/v1"
                        || lower_path == "/api/v1"
                        || lower_path == "/compatible-mode"
                        || lower_path == "/compatible-mode/v1"
                    {
                        "/compatible-mode/v1/chat/completions".to_string()
                    } else if lower_path.ends_with("/compatible-mode/v1") {
                        format!("{}/chat/completions", path)
                    } else if lower_path.ends_with("/compatible-mode") {
                        format!("{}/v1/chat/completions", path)
                    } else if lower_path.ends_with("/responses")
                        || lower_path.ends_with("/chat/completions")
                    {
                        path
                    } else {
                        "/compatible-mode/v1/chat/completions".to_string()
                    }
                } else if lower_path.ends_with("/responses")
                    || lower_path.ends_with("/chat/completions")
                {
                    path
                } else if is_responses {
                    if lower_path.is_empty() || lower_path == "/" {
                        "/v1/responses".to_string()
                    } else if lower_path.ends_with("/v1") {
                        format!("{}/responses", path)
                    } else {
                        format!("{}/v1/responses", path)
                    }
                } else if lower_path.ends_with("/v1") {
                    format!("{}/chat/completions", path)
                } else if !lower_path.is_empty() && lower_path != "/" {
                    format!("{}/v1/chat/completions", path)
                } else {
                    "/v1/chat/completions".to_string()
                }
            }
            ApiFormat::Gemini => {
                if lower_path.is_empty() || lower_path == "/" {
                    "/v1beta".to_string()
                } else if lower_path.ends_with("/v1beta") || lower_path.ends_with("/v1") {
                    path
                } else {
                    format!("{}/v1beta", path)
                }
            }
        };

        split_endpoint_prefix(host, api_path, api_format)
    } else {
        let api_path = match api_format {
            ApiFormat::Anthropic => "/v1/messages",
            ApiFormat::Gemini => "/v1beta",
            ApiFormat::Openai => {
                if wire_api
                    .map(|v| v.eq_ignore_ascii_case("responses"))
                    .unwrap_or(false)
                {
                    "/v1/responses"
                } else {
                    "/v1/chat/completions"
                }
            }
        };
        (raw, Some(api_path.to_string()))
    }
}

pub(super) fn split_endpoint_prefix(
    host: String,
    api_path: String,
    api_format: &ApiFormat,
) -> (String, Option<String>) {
    if matches!(api_format, ApiFormat::Openai) && is_official_dashscope_host(&host) {
        return (host, Some(api_path));
    }

    let path = api_path.trim_end_matches('/').to_string();
    if path.is_empty() || path == "/" {
        return (host, None);
    }

    let segments: Vec<&str> = path.split('/').collect();
    if let Some(v1_index) = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("v1"))
    {
        let prefix = segments[..v1_index].join("/");
        let suffix = segments[v1_index..].join("/");
        let api_host = if prefix.trim_matches('/').is_empty() {
            host
        } else {
            format!(
                "{}{}",
                host.trim_end_matches('/'),
                format!("/{}", prefix.trim_matches('/'))
            )
        };
        return (
            api_host,
            Some(format!("/{}", suffix.trim_start_matches('/'))),
        );
    }

    (host, Some(path))
}

pub(super) fn finalize_candidate(candidate: &mut ImportProviderCandidate) {
    candidate.api_host = candidate.api_host.trim_end_matches('/').to_string();
    candidate.models = unique_strings(candidate.models.clone());
    candidate.default_model = candidate.default_model.trim().to_string();
    if !candidate.default_model.is_empty() && !candidate.models.contains(&candidate.default_model) {
        candidate.models.insert(0, candidate.default_model.clone());
    }
    candidate.capabilities = normalize_caps(candidate.capabilities.clone());
    candidate.id = make_candidate_id(candidate);
}

pub(super) fn import_caps(vision: bool, tools: bool, gzip: bool) -> ProviderCapabilities {
    ProviderCapabilities {
        text: true,
        stream: true,
        vision,
        tools,
        gzip,
    }
}

pub(super) fn normalize_caps(mut caps: ProviderCapabilities) -> ProviderCapabilities {
    caps.text = true;
    caps.stream = true;
    caps
}

pub(super) fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        let key = value.to_lowercase();
        if seen.insert(key) {
            out.push(value);
        }
    }
    out
}

pub(super) fn candidate_signature(candidate: &ImportProviderCandidate) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        match candidate.api_format {
            ApiFormat::Anthropic => "anthropic",
            ApiFormat::Openai => "openai",
            ApiFormat::Gemini => "gemini",
        },
        candidate.api_host.trim_end_matches('/').to_lowercase(),
        candidate
            .api_path
            .clone()
            .unwrap_or_default()
            .to_lowercase(),
        candidate.api_key,
        candidate.default_model.to_lowercase()
    )
}

pub(super) fn make_candidate_id(candidate: &ImportProviderCandidate) -> String {
    let mut hasher = Sha256::new();
    hasher.update(candidate.source.as_bytes());
    hasher.update(b"\n");
    hasher.update(candidate.source_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(candidate_signature(candidate).as_bytes());
    let digest = hex::encode(hasher.finalize());
    let source = candidate
        .source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    format!("{}-{}", source, &digest[..16])
}

pub(super) fn provider_exists(store: &ProviderStore, candidate: &ImportProviderCandidate) -> bool {
    store.providers.iter().any(|provider| {
        provider
            .api_host
            .trim_end_matches('/')
            .eq_ignore_ascii_case(candidate.api_host.trim_end_matches('/'))
            && provider
                .api_path
                .as_deref()
                .unwrap_or_default()
                .eq_ignore_ascii_case(candidate.api_path.as_deref().unwrap_or_default())
            && provider.api_key == candidate.api_key
    })
}

pub(super) fn unique_provider_id(store: &ProviderStore, candidate_id: &str) -> String {
    let base = format!("p-import-{}", candidate_id);
    if !store.providers.iter().any(|p| p.id == base) {
        return base;
    }
    for idx in 2..1000 {
        let next = format!("{}-{}", base, idx);
        if !store.providers.iter().any(|p| p.id == next) {
            return next;
        }
    }
    format!("{}-{}", base, store.providers.len() + 1)
}

pub(super) fn unique_provider_name(store: &ProviderStore, name: &str) -> String {
    let base = name.trim();
    if !store.providers.iter().any(|p| p.name == base) {
        return base.to_string();
    }
    for idx in 2..1000 {
        let next = format!("{} ({})", base, idx);
        if !store.providers.iter().any(|p| p.name == next) {
            return next;
        }
    }
    format!("{} ({})", base, store.providers.len() + 1)
}

pub(super) fn add_named_file_matches(
    paths: &mut Vec<PathBuf>,
    file_name: &str,
    max_depth: usize,
    max_results: usize,
) {
    let mut found = Vec::new();
    for root in common_config_roots() {
        find_named_files(&root, file_name, max_depth, max_results, &mut found);
        if found.len() >= max_results {
            break;
        }
    }
    paths.extend(found);
}

pub(super) fn common_config_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data) = dirs::data_dir() {
        roots.push(data);
    }
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local);
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".config"));
        roots.push(home.join("AppData").join("Roaming"));
        roots.push(home.join("AppData").join("Local"));
    }
    existing_unique_dirs(roots)
}

pub(super) fn find_named_files(
    root: &Path,
    file_name: &str,
    max_depth: usize,
    max_results: usize,
    out: &mut Vec<PathBuf>,
) {
    if max_depth == 0 || out.len() >= max_results || !root.is_dir() {
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= max_results {
            break;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case(file_name))
                .unwrap_or(false)
            {
                out.push(path);
            }
        } else if file_type.is_dir() && should_descend_config_dir(&path) {
            find_named_files(&path, file_name, max_depth - 1, max_results, out);
        }
    }
}

pub(super) fn should_descend_config_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "cache"
            | "code cache"
            | "gpucache"
            | "crashpad"
            | "logs"
            | "log"
            | "temp"
            | "tmp"
            | "node_modules"
            | "target"
            | ".git"
    )
}

pub(super) fn existing_unique_dirs(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if !path.is_dir() {
            continue;
        }
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_lowercase();
        if seen.insert(key) {
            out.push(path);
        }
    }
    out
}

pub(super) fn existing_unique_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if !path.exists() {
            continue;
        }
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_lowercase();
        if seen.insert(key) {
            out.push(path);
        }
    }
    out
}

