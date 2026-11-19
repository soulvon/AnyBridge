use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
const GOOGLE_CLOUD_PLATFORM_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_LEAD_SECS: u64 = 120;

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    expires_at: u64,
}

static TOKEN_CACHE: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();

fn token_cache() -> &'static Mutex<HashMap<String, CachedToken>> {
    TOKEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeminiAuthHeader {
    ApiKey(String),
    Bearer(String),
}

#[derive(Debug, Deserialize)]
struct GoogleCredFile {
    #[serde(rename = "type")]
    cred_type: Option<String>,
    project_id: Option<String>,
    quota_project_id: Option<String>,
    client_email: Option<String>,
    private_key: Option<String>,
    token_uri: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    service_account_impersonation_url: Option<String>,
    source_credentials: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    #[serde(rename = "accessToken")]
    iam_access_token: Option<String>,
    expires_in: Option<u64>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn fingerprint(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    hex::encode(digest)
}


pub fn looks_like_google_oauth_credential(raw_cred: &str) -> bool {
    let trimmed = raw_cred.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.starts_with("ya29.")
        || lower.starts_with("bearer ")
        || trimmed.starts_with('{')
        || trimmed.starts_with('@')
        || lower == "adc"
        || lower == "gcloud"
    {
        return true;
    }
    false
}

/// 若凭据本身包含 GCP project_id（Service Account JSON / ADC 文件），且路径包含 `{project}` 或缺少项目段时提取返回。
pub fn credential_project_id(raw_cred: &str) -> Option<String> {
    let json_text = resolve_credential_json_text(raw_cred).ok()??;
    let parsed: GoogleCredFile = serde_json::from_str(&json_text).ok()?;
    parsed
        .project_id
        .or(parsed.quota_project_id)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn default_adc_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("GOOGLE_APPLICATION_CREDENTIALS") {
        let pb = PathBuf::from(p.trim());
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(cfg) = std::env::var("CLOUDSDK_CONFIG") {
        let pb = PathBuf::from(cfg.trim()).join("application_default_credentials.json");
        if pb.is_file() {
            return Some(pb);
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = dirs::config_dir() {
        let pb = appdata
            .join("gcloud")
            .join("application_default_credentials.json");
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let pb = home
            .join(".config")
            .join("gcloud")
            .join("application_default_credentials.json");
        if pb.is_file() {
            return Some(pb);
        }
    }
    None
}

fn resolve_credential_json_text(raw_cred: &str) -> Result<Option<String>, String> {
    let trimmed = raw_cred.trim();
    if trimmed.starts_with('{') {
        return Ok(Some(trimmed.to_string()));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "adc" || lower == "gcloud" {
        let path = default_adc_path().ok_or_else(|| {
            "未找到 Google Cloud ADC 凭据文件（请先运行 `gcloud auth application-default login` 或设置 `GOOGLE_APPLICATION_CREDENTIALS`）".to_string()
        })?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 ADC 凭据文件失败 ({}): {}", path.display(), e))?;
        return Ok(Some(text));
    }
    if let Some(rest) = trimmed.strip_prefix('@') {
        let path_str = rest.trim();
        let expanded = if path_str.starts_with("~/") || path_str.starts_with("~\\") {
            dirs::home_dir()
                .map(|h| h.join(&path_str[2..]))
                .unwrap_or_else(|| PathBuf::from(path_str))
        } else {
            PathBuf::from(path_str)
        };
        let text = std::fs::read_to_string(&expanded)
            .map_err(|e| format!("读取 Google 凭据文件失败 ({}): {}", expanded.display(), e))?;
        return Ok(Some(text));
    }
    Ok(None)
}

fn pem_pkcs8_to_der(pem: &str) -> Result<Vec<u8>, String> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("-----"))
        .collect();
    if body.is_empty() {
        return Err("Service Account private_key 内容为空".to_string());
    }
    STANDARD
        .decode(body.as_bytes())
        .map_err(|e| format!("解析 Service Account private_key PEM 失败: {}", e))
}

fn build_service_account_jwt(
    client_email: &str,
    private_key_pem: &str,
    token_uri: &str,
) -> Result<String, String> {
    let der = pem_pkcs8_to_der(private_key_pem)?;
    let key_pair = RsaKeyPair::from_pkcs8(&der)
        .map_err(|_| "Service Account private_key 不是有效的 PKCS#8 RSA 私钥".to_string())?;
    let iat = now_secs();
    let exp = iat + 3600;
    let header = serde_json::json!({ "alg": "RS256", "typ": "JWT" });
    let claims = serde_json::json!({
        "iss": client_email,
        "scope": GOOGLE_CLOUD_PLATFORM_SCOPE,
        "aud": token_uri,
        "iat": iat,
        "exp": exp,
    });
    let header_b64 = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());
    let claims_b64 = URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes());
    let signing_input = format!("{}.{}", header_b64, claims_b64);

    let rng = SystemRandom::new();
    let mut sig = vec![0u8; key_pair.public().modulus_len()];
    key_pair
        .sign(&RSA_PKCS1_SHA256, &rng, signing_input.as_bytes(), &mut sig)
        .map_err(|_| "签发 Google Service Account JWT 失败".to_string())?;
    let sig_b64 = URL_SAFE_NO_PAD.encode(&sig);
    Ok(format!("{}.{}", signing_input, sig_b64))
}

async fn mint_token_from_json_value(
    client: &reqwest::Client,
    val: &serde_json::Value,
) -> Result<(String, u64), String> {
    let json_text = val.to_string();
    let cache_key = fingerprint(&json_text);
    let now = now_secs();
    {
        let guard = token_cache().lock().await;
        if let Some(hit) = guard.get(&cache_key) {
            if hit.expires_at > now + TOKEN_REFRESH_LEAD_SECS {
                return Ok((hit.access_token.clone(), hit.expires_at));
            }
        }
    }

    let cred: GoogleCredFile =
        serde_json::from_value(val.clone()).map_err(|e| format!("Google 凭据 JSON 无效: {}", e))?;
    let cred_type = cred.cred_type.as_deref().unwrap_or("");

    let (access_token, expires_at) = match cred_type {
        "service_account" => {
            let email = cred
                .client_email
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Service Account 凭据缺少 client_email")?;
            let pk = cred
                .private_key
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or("Service Account 凭据缺少 private_key")?;
            let token_uri = cred
                .token_uri
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_GOOGLE_TOKEN_URI);
            let assertion = build_service_account_jwt(email, pk, token_uri)?;
            let resp = client
                .post(token_uri)
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                    ("assertion", assertion.as_str()),
                ])
                .send()
                .await
                .map_err(|e| format!("换取 Google OAuth Token 网络错误: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "Google Service Account 换取令牌失败 (HTTP {}): {}",
                    status,
                    body.chars().take(200).collect::<String>()
                ));
            }
            let tr: TokenResponse = resp
                .json()
                .await
                .map_err(|e| format!("解析 Google Token 响应失败: {}", e))?;
            let token = tr
                .access_token
                .filter(|s| !s.trim().is_empty())
                .ok_or("Google Token 响应缺少 access_token")?;
            let ttl = tr.expires_in.unwrap_or(3600).max(60);
            (token, now_secs() + ttl)
        }
        "authorized_user" => {
            let client_id = cred
                .client_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Google authorized_user 凭据缺少 client_id")?;
            let client_secret = cred
                .client_secret
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Google authorized_user 凭据缺少 client_secret")?;
            let refresh_token = cred
                .refresh_token
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Google authorized_user 凭据缺少 refresh_token")?;
            let resp = client
                .post(DEFAULT_GOOGLE_TOKEN_URI)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
                .map_err(|e| format!("刷新 Google ADC Token 网络错误: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "Google ADC 刷新令牌失败 (HTTP {}): {}",
                    status,
                    body.chars().take(200).collect::<String>()
                ));
            }
            let tr: TokenResponse = resp
                .json()
                .await
                .map_err(|e| format!("解析 Google ADC Token 响应失败: {}", e))?;
            let token = tr
                .access_token
                .filter(|s| !s.trim().is_empty())
                .ok_or("Google ADC 响应缺少 access_token")?;
            let ttl = tr.expires_in.unwrap_or(3600).max(60);
            (token, now_secs() + ttl)
        }
        "impersonated_service_account" => {
            let target_url = cred
                .service_account_impersonation_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Google impersonated_service_account 缺少 service_account_impersonation_url")?;
            let source_val = cred
                .source_credentials
                .as_ref()
                .ok_or("Google impersonated_service_account 缺少 source_credentials")?;
            let (source_tok, _) = Box::pin(mint_token_from_json_value(client, source_val)).await?;
            let resp = client
                .post(target_url)
                .bearer_auth(source_tok)
                .json(&serde_json::json!({ "scope": [GOOGLE_CLOUD_PLATFORM_SCOPE] }))
                .send()
                .await
                .map_err(|e| format!("模拟服务账号换取 Token 网络错误: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "IAM 服务账号模拟令牌失败 (HTTP {}): {}",
                    status,
                    body.chars().take(200).collect::<String>()
                ));
            }
            let tr: TokenResponse = resp
                .json()
                .await
                .map_err(|e| format!("解析 IAM Token 响应失败: {}", e))?;
            let token = tr
                .iam_access_token
                .or(tr.access_token)
                .filter(|s| !s.trim().is_empty())
                .ok_or("IAM 响应缺少 accessToken")?;
            (token, now_secs() + 3500)
        }
        other => {
            return Err(format!("不支持的 Google 凭据类型: {}", other));
        }
    };

    let mut guard = token_cache().lock().await;
    guard.insert(
        cache_key,
        CachedToken {
            access_token: access_token.clone(),
            expires_at,
        },
    );
    Ok((access_token, expires_at))
}

pub async fn resolve_gemini_auth(
    client: &reqwest::Client,
    raw_cred: &str,
) -> Result<GeminiAuthHeader, String> {
    let trimmed = raw_cred.trim();
    if trimmed.is_empty() {
        return Err("缺少 API 密钥或 Google OAuth 凭据".to_string());
    }
    if let Some(bearer) = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
    {
        return Ok(GeminiAuthHeader::Bearer(bearer.trim().to_string()));
    }
    if trimmed.starts_with("ya29.") {
        return Ok(GeminiAuthHeader::Bearer(trimmed.to_string()));
    }
    if let Some(json_text) = resolve_credential_json_text(trimmed)? {
        let val: serde_json::Value = serde_json::from_str(&json_text)
            .map_err(|e| format!("Google 凭据 JSON 解析失败: {}", e))?;
        let (tok, _) = mint_token_from_json_value(client, &val).await?;
        return Ok(GeminiAuthHeader::Bearer(tok));
    }
    Ok(GeminiAuthHeader::ApiKey(trimmed.to_string()))
}

pub async fn resolve_gemini_auth_header_pair(
    client: &reqwest::Client,
    raw_cred: &str,
) -> Result<(String, String), String> {
    match resolve_gemini_auth(client, raw_cred).await? {
        GeminiAuthHeader::ApiKey(k) => Ok(("x-goog-api-key".to_string(), k)),
        GeminiAuthHeader::Bearer(tok) => Ok(("Authorization".to_string(), format!("Bearer {}", tok))),
    }
}

pub async fn apply_gemini_auth(
    client: &reqwest::Client,
    req: reqwest::RequestBuilder,
    raw_cred: &str,
) -> Result<reqwest::RequestBuilder, String> {
    match resolve_gemini_auth(client, raw_cred).await? {
        GeminiAuthHeader::ApiKey(k) => Ok(req.header("x-goog-api-key", k)),
        GeminiAuthHeader::Bearer(tok) => Ok(req.header("Authorization", format!("Bearer {}", tok))),
    }
}


pub fn redact_credential(text: &str, raw_cred: &str) -> String {
    let mut out = text.to_string();
    let trimmed = raw_cred.trim();
    if !trimmed.is_empty() && trimmed.len() >= 6 && !trimmed.starts_with('{') {
        out = out.replace(trimmed, "***");
    }
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            for k in ["private_key", "refresh_token", "client_secret"] {
                if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
                    if s.len() >= 6 {
                        out = out.replace(s, "***");
                    }
                }
            }
        }
    }
    out
}

