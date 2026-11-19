//! Google AI Studio (Gemini) 与 Google Cloud Vertex AI 统一端点、协议推断与凭据签发模块。
//!
//! 收敛分散在 config.rs / eval.rs / platforms.rs 中的 Gemini/Vertex 路径规范化与鉴权逻辑：
//! - AI Studio (`generativelanguage.googleapis.com`): `x-goog-api-key` 或 OAuth Bearer，保留 `/v1beta` / `/v1/models`
//! - Vertex Express Mode (`aiplatform.googleapis.com` + `AQ.` Key): 保留 `/v1/publishers/google/models`
//! - Standard Vertex AI (`projects/{p}/locations/{loc}` + Bearer / Service Account JSON / ADC / Impersonation):
//!   自动校准 `global` / `us` / `eu` / `<region>-aiplatform.googleapis.com` 区域主机，使用 OAuth2 Bearer 鉴权。


pub mod auth;
pub use auth::*;

use std::sync::OnceLock;
use regex::Regex;

fn re_gemini_action() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i):(?:generatecontent|streamgeneratecontent|counttokens)$")
            .expect("valid gemini action regex")
    })
}

fn re_vertex_project_location() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"/v1(?:beta1?)?/projects/[^/]+/locations/[^/]+$")
            .expect("valid vertex location regex")
    })
}

fn re_version_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^/v1(?:beta1?)?$").expect("valid version regex"))
}

fn re_publishers_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(/v1(?:beta1?)?)?/(publishers(?:/.*)?)$")
            .expect("valid publishers regex")
    })
}
fn parse_hostname(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    reqwest::Url::parse(&with_scheme)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| trimmed.to_ascii_lowercase())
}

pub fn host_scheme_and_origin(host: &str) -> (String, Option<String>) {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return (String::new(), None);
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    if let Ok(u) = reqwest::Url::parse(&with_scheme) {
        let origin = match u.port() {
            Some(p) => format!("{}://{}:{}", u.scheme(), u.host_str().unwrap_or(""), p),
            None => format!("{}://{}", u.scheme(), u.host_str().unwrap_or("")),
        };
        let embedded_path = u.path().trim_end_matches('/');
        let path_opt = if embedded_path.is_empty() || embedded_path == "/" {
            None
        } else {
            Some(embedded_path.to_string())
        };
        return (origin, path_opt);
    }
    (with_scheme, None)
}

pub fn clean_api_path(api_path: Option<&str>) -> String {
    let raw = api_path.unwrap_or("").trim();
    if raw.is_empty() {
        return String::new();
    }
    let prefixed = if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{}", raw)
    };
    prefixed.trim_end_matches('/').to_string()
}

pub fn is_aiplatform_host(hostname: &str) -> bool {
    let h = hostname.trim().to_ascii_lowercase();
    if h == "aiplatform.googleapis.com" {
        return true;
    }
    if h.ends_with("-aiplatform.googleapis.com") && h.len() > "-aiplatform.googleapis.com".len() {
        return true;
    }
    if h.ends_with(".aiplatform.googleapis.com") && h.len() > ".aiplatform.googleapis.com".len() {
        return true;
    }
    h.starts_with("aiplatform.") && h.ends_with(".rep.googleapis.com")
}

pub fn is_vertex_endpoint(host: &str, api_path: Option<&str>) -> bool {
    let hostname = parse_hostname(host);
    if is_aiplatform_host(&hostname) {
        return true;
    }
    let (_, embedded_path) = host_scheme_and_origin(host);
    let combined = format!(
        "{}{}",
        embedded_path.as_deref().unwrap_or(""),
        clean_api_path(api_path)
    )
    .to_ascii_lowercase();
    combined.contains("/publishers/google/")
        || combined.contains("/publishers/anthropic/")
        || (combined.contains("/projects/") && combined.contains("/locations/"))
}

fn has_openai_endpoint_suffix(full_path_lower: &str) -> bool {
    full_path_lower.contains("/endpoints/openapi")
        || full_path_lower.contains("/openai/")
        || full_path_lower.ends_with("/openai")
        || full_path_lower.contains("/openai?")
        || full_path_lower.contains("/chat/completions")
        || full_path_lower.contains("/responses")
        || full_path_lower.contains("/compatible-mode")
}

pub fn is_official_google_gemini_native_only_endpoint(host: &str, api_path: Option<&str>) -> bool {
    let (origin, embedded_path) = host_scheme_and_origin(host);
    let hostname = parse_hostname(&origin);
    let full_path = format!(
        "{}{}",
        embedded_path.as_deref().unwrap_or(""),
        clean_api_path(api_path)
    )
    .to_ascii_lowercase();

    if has_openai_endpoint_suffix(&full_path)
        || full_path.contains("/publishers/anthropic/")
        || full_path.contains(":rawpredict")
        || full_path.contains(":streamrawpredict")
    {
        return false;
    }

    hostname == "generativelanguage.googleapis.com"
        || is_aiplatform_host(&hostname)
        || full_path.contains("/publishers/google/models")
}

/// 统一端点协议推断（与 sidecar/provider-pool.js 与 ui 40-model-picker.js 同构）。
pub fn infer_api_format_from_endpoint(host: &str, api_path: Option<&str>) -> Option<&'static str> {
    let (origin, embedded_path) = host_scheme_and_origin(host);
    let hostname = parse_hostname(&origin);
    let full_path = format!(
        "{}{}",
        embedded_path.as_deref().unwrap_or(""),
        clean_api_path(api_path)
    )
    .to_ascii_lowercase();
    let combined = format!("{}{}", origin.to_ascii_lowercase(), full_path);

    if combined.is_empty() {
        return None;
    }

    // 先拦截明确的 Anthropic / OpenAI 特征，避免误伤区域 Vertex Claude 或 Vertex OpenAI 兼容入口
    if full_path.contains("/publishers/anthropic/")
        || full_path.contains(":rawpredict")
        || full_path.contains(":streamrawpredict")
        || full_path.ends_with("/messages")
        || full_path.contains("/v1/messages")
    {
        return Some("anthropic");
    }
    if has_openai_endpoint_suffix(&full_path) {
        return Some("openai");
    }

    let is_google_gemini_host =
        hostname == "generativelanguage.googleapis.com" || is_aiplatform_host(&hostname);
    if is_google_gemini_host
        || full_path.contains("/publishers/google/models")
        || full_path.contains("/v1beta")
        || full_path.contains(":generatecontent")
        || full_path.contains(":streamgeneratecontent")
        || full_path.contains(":counttokens")
        || hostname.contains("gemini")
    {
        return Some("gemini");
    }

    if hostname.contains("anthropic") {
        return Some("anthropic");
    }

    if [
        "openai",
        "deepseek",
        "siliconflow",
        "dashscope",
        "volces",
        "moonshot",
        "minimaxi",
        "minimax",
        "bigmodel",
        "z.ai",
        "groq",
        "mistral",
        "together",
        "fireworks",
        "cerebras",
        "huggingface",
        "tokenhub",
        "longcat",
        "xiaomimimo",
        "stepfun",
        "baichuan",
        "perplexity",
        "nvidia",
        "x.ai",
    ]
    .iter()
    .any(|kw| hostname.contains(kw))
        || full_path == "/v1"
        || full_path.starts_with("/v1/")
        || full_path.ends_with("/v1")
    {
        return Some("openai");
    }

    None
}


fn merge_embedded_and_api_path(embedded: Option<String>, clean_arg: String) -> String {
    if clean_arg.is_empty() {
        return embedded.unwrap_or_default();
    }
    let Some(prefix) = embedded else {
        return clean_arg;
    };
    if prefix.is_empty() {
        return clean_arg;
    }
    let p_lower = prefix.to_ascii_lowercase();
    let c_lower = clean_arg.to_ascii_lowercase();
    if c_lower == p_lower
        || c_lower.starts_with(&format!("{}/", p_lower))
        || c_lower.starts_with(&format!("{}?", p_lower))
    {
        clean_arg
    } else {
        format!("{}{}", prefix, clean_arg)
    }
}

fn percent_encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            b => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn gemini_action_api_path(api_path: &str, action: &str) -> String {
    let raw = api_path.trim();
    if raw.is_empty() {
        return String::new();
    }
    let normalized_method = match action {
        "streamGenerateContent" => "streamGenerateContent",
        "countTokens" => "countTokens",
        _ => "generateContent",
    };
    let (path_part, query_part) = match raw.split_once('?') {
        Some((p, q)) => (p, q),
        None => (raw, ""),
    };
    let re_action = re_gemini_action();
    let next_path = if re_action.is_match(path_part) {
        re_action
            .replace(path_part, format!(":{}", normalized_method))
            .into_owned()
    } else {
        format!("{}:{}", path_part, normalized_method)
    };
    let mut pairs: Vec<(String, String)> = query_part
        .split('&')
        .filter(|item| !item.is_empty())
        .map(|item| match item.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (item.to_string(), String::new()),
        })
        .collect();
    if normalized_method == "streamGenerateContent" {
        if !pairs.iter().any(|(k, _)| k.eq_ignore_ascii_case("alt")) {
            pairs.push(("alt".to_string(), "sse".to_string()));
        }
    } else {
        pairs.retain(|(k, _)| !k.eq_ignore_ascii_case("alt"));
    }
    if pairs.is_empty() {
        next_path
    } else {
        let q = pairs
            .into_iter()
            .map(|(k, v)| if v.is_empty() { k } else { format!("{}={}", k, v) })
            .collect::<Vec<_>>()
            .join("&");
        format!("{}?{}", next_path, q)
    }
}

/// 规范化 Gemini / Vertex 路径，绝不错误改写 Vertex `/v1/projects/...` 或 `/v1/publishers/...` 为 `/v1beta`。
pub fn normalize_gemini_api_path_for_action(
    host: &str,
    api_path: Option<&str>,
    model: &str,
    action: &str,
) -> String {
    let (_, embedded_path) = host_scheme_and_origin(host);
    let clean_arg = clean_api_path(api_path);
    let clean = merge_embedded_and_api_path(embedded_path, clean_arg);

    let (path_only, query_only) = match clean.split_once('?') {
        Some((p, q)) => (p.trim_end_matches('/'), q),
        None => (clean.as_str(), ""),
    };
    let lower = path_only.to_ascii_lowercase();
    let model_clean = model.trim().strip_prefix("models/").unwrap_or(model.trim());
    let encoded_model = percent_encode_uri_component(model_clean);
    let is_vertex = is_vertex_endpoint(host, Some(path_only));
    let suffix = match action {
        "streamGenerateContent" => "streamGenerateContent",
        "countTokens" => "countTokens",
        _ => "generateContent",
    };

    let base_resolved = if lower.ends_with(":generatecontent")
        || lower.ends_with(":streamgeneratecontent")
        || lower.ends_with(":counttokens")
    {
        path_only.to_string()
    } else if lower.contains("/v1beta/models/")
        || lower.contains("/v1/models/")
        || lower.contains("/publishers/google/models/")
    {
        format!("{}:{}", path_only, suffix)
    } else if path_only.is_empty() {
        if is_vertex {
            format!("/v1/publishers/google/models/{}:{}", encoded_model, suffix)
        } else {
            format!("/v1beta/models/{}:{}", encoded_model, suffix)
        }
    } else if lower.ends_with("/publishers/google/models") || lower.ends_with("/models") {
        format!("{}/{}:{}", path_only, encoded_model, suffix)
    } else if lower.ends_with("/publishers/google") {
        format!("{}/models/{}:{}", path_only, encoded_model, suffix)
    } else if re_vertex_project_location().is_match(&lower) {
        format!("{}/publishers/google/models/{}:{}", path_only, encoded_model, suffix)
    } else if lower.ends_with("/v1beta") {
        format!("{}/models/{}:{}", path_only, encoded_model, suffix)
    } else if lower.ends_with("/v1") {
        if is_vertex {
            format!("{}/publishers/google/models/{}:{}", path_only, encoded_model, suffix)
        } else {
            let prefix = &path_only[..path_only.len().saturating_sub(3)];
            format!("{}/v1beta/models/{}:{}", prefix, encoded_model, suffix)
        }
    } else {
        format!("{}/v1beta/models/{}:{}", path_only, encoded_model, suffix)
    };

    let full_with_query = if query_only.is_empty() {
        base_resolved
    } else {
        format!("{}?{}", base_resolved, query_only)
    };
    gemini_action_api_path(&full_with_query, action)
}

pub fn normalize_gemini_api_path(host: &str, api_path: Option<&str>, model: &str) -> String {
    normalize_gemini_api_path_for_action(host, api_path, model, "generateContent")
}

fn infer_vertex_location_from_hostname(hostname: &str) -> Option<String> {
    let h = hostname.trim().to_ascii_lowercase();
    if let Some(rest) = h.strip_prefix("aiplatform.") {
        if let Some(loc) = rest.strip_suffix(".rep.googleapis.com") {
            if !loc.is_empty() {
                return Some(loc.to_string());
            }
        }
    }
    if let Some(loc) = h.strip_suffix("-aiplatform.googleapis.com") {
        if !loc.is_empty() {
            return Some(loc.to_string());
        }
    }
    None
}

/// 联合解析 Google AI Studio / Vertex 请求最终使用的 `(resolved_origin, resolved_path)`。
/// 对于 Standard Vertex OAuth2（非 Express API Key），按 location 自动校准全球/多区域/区域 aiplatform 主机，
/// 并在路径中含 `{project}` 或路径为空/版本前缀且凭据 JSON 自带 `project_id` 时自动填入。
pub fn resolve_gemini_endpoint_for_action(
    host: &str,
    api_path: Option<&str>,
    model: &str,
    raw_cred: &str,
    action: &str,
) -> (String, String) {
    let (mut origin, embedded_path) = host_scheme_and_origin(host);
    let clean_arg = clean_api_path(api_path);
    let mut effective_path = merge_embedded_and_api_path(embedded_path, clean_arg);

    if effective_path.contains("{project}") {
        if let Some(proj) = credential_project_id(raw_cred) {
            effective_path = effective_path.replace("{project}", &proj);
        }
    }

    let is_oauth = looks_like_google_oauth_credential(raw_cred);
    let hostname = parse_hostname(&origin);
    if is_oauth
        && is_vertex_endpoint(
            &origin,
            if effective_path.is_empty() {
                None
            } else {
                Some(effective_path.as_str())
            },
        )
        && !effective_path.to_ascii_lowercase().contains("/projects/")
    {
        if let Some(proj) = credential_project_id(raw_cred) {
            let loc = infer_vertex_location_from_hostname(&hostname)
                .unwrap_or_else(|| "global".to_string());
            let encoded_proj = percent_encode_uri_component(&proj);
            let (path_part, query_part) = match effective_path.split_once('?') {
                Some((p, q)) => (p.trim_end_matches('/'), Some(q)),
                None => (effective_path.as_str(), None),
            };
            let version_re = re_version_prefix();
            let pub_re = re_publishers_suffix();
            let next_path = if path_part.is_empty() {
                format!("/v1/projects/{}/locations/{}", encoded_proj, loc)
            } else if version_re.is_match(path_part) {
                format!("{}/projects/{}/locations/{}", path_part, encoded_proj, loc)
            } else if let Some(caps) = pub_re.captures(path_part) {
                let ver = caps.get(1).map(|m| m.as_str()).unwrap_or("/v1");
                let rest = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                format!("{}/projects/{}/locations/{}/{}", ver, encoded_proj, loc, rest)
            } else {
                String::new()
            };
            if !next_path.is_empty() {
                effective_path = match query_part {
                    Some(q) if !q.is_empty() => format!("{}?{}", next_path, q),
                    _ => next_path,
                };
            }
        }
    }

    if is_oauth && hostname == "aiplatform.googleapis.com" {
        if let Some(loc_re) = Regex::new(r"/locations/([^/]+)(?:/|$)").ok() {
            if let Some(caps) = loc_re.captures(&effective_path) {
                let loc = caps[1].trim().to_ascii_lowercase();
                if !loc.is_empty() && loc != "global" && !loc.contains('{') {
                    let scheme = if origin.starts_with("http://") {
                        "http"
                    } else {
                        "https"
                    };
                    origin = match loc.as_str() {
                        "us" | "eu" => format!("{}://aiplatform.{}.rep.googleapis.com", scheme, loc),
                        region => format!("{}://{}-aiplatform.googleapis.com", scheme, region),
                    };
                }
            }
        }
    }

    let path = normalize_gemini_api_path_for_action(
        &origin,
        if effective_path.is_empty() {
            None
        } else {
            Some(effective_path.as_str())
        },
        model,
        action,
    );
    (origin, path)
}

pub fn resolve_gemini_endpoint(
    host: &str,
    api_path: Option<&str>,
    model: &str,
    raw_cred: &str,
) -> (String, String) {
    resolve_gemini_endpoint_for_action(host, api_path, model, raw_cred, "generateContent")
}

/// 从 Gemini / Vertex JSON 响应提取非思考正文文本（严格跳过 `thought: true` 片段）。
pub fn extract_gemini_non_thought_text(json: &serde_json::Value) -> String {
    let Some(parts) = json
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
    else {
        return String::new();
    };
    parts
        .iter()
        .filter(|p| p.get("thought").and_then(|t| t.as_bool()) != Some(true))
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

/// 从 Gemini / Vertex JSON 响应提取最终文本（跳过 `thought: true` 思考片段，必要时兜底回所有文本）。
pub fn extract_gemini_parts_text(json: &serde_json::Value) -> String {
    let answer = extract_gemini_non_thought_text(json);
    if !answer.is_empty() {
        return answer;
    }
    let Some(parts) = json
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
    else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

pub fn build_gemini_model_list_paths(host: &str, api_path: Option<&str>) -> Vec<String> {
    let (_, embedded_path) = host_scheme_and_origin(host);
    let clean_arg = clean_api_path(api_path);
    let effective = if clean_arg.is_empty() {
        embedded_path.unwrap_or_default()
    } else {
        clean_arg
    };
    let lower = effective.to_ascii_lowercase();
    let mut out = Vec::new();
    if !effective.is_empty() {
        if lower.ends_with("/models") {
            out.push(effective.clone());
        } else if lower.ends_with("/v1beta") || lower.ends_with("/v1") {
            out.push(format!("{}/models", effective));
        } else if !lower.contains(":generatecontent") && !lower.contains(":streamgeneratecontent") {
            out.push(format!("{}/v1beta/models", effective));
            out.push(format!("{}/v1/models", effective));
            out.push(format!("{}/models", effective));
        }
    }
    out.push("/v1beta/models".to_string());
    out.push("/v1/models".to_string());
    out.push("/models".to_string());
    out.dedup();
    out
}


#[cfg(test)]
mod tests;
