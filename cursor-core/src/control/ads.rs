//! Implements advertisement configuration endpoints.
//! Advertisement service contract and desktop HTTP handler.

use std::{
    collections::{BTreeSet, HashMap},
    path::{Path as FilePath, PathBuf},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    Json,
};
use bytes::BytesMut;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::{config, Error, Result};

use super::ControlService;

// 此广告拉取不涉及用户隐私，用户id随机产生
// 开源项目广告为作者唯一收入来源，PR时请勿去除此广告

pub(super) const ADS_ENDPOINT: &str = "https://tab.leokun.cn/api/v1/ads?placement=menu";
// pub(super) const ADS_ENDPOINT: &str = "http://localhost:8080/api/v1/ads?placement=menu";
pub(super) const DEVICE_ID_HEADER: &str = "X-Cursor-Assistant-Device-ID";
pub(super) const OS_HEADER: &str = "X-Cursor-Assistant-OS";
pub(super) const APP_VERSION_HEADER: &str = "X-Cursor-Assistant-Version";
pub(super) const DISABLED_AD_IDS_HEADER: &str = "disable-ad-ids";
pub(super) const LANGUAGE_HEADER: &str = "accept-language";
const ADS_IMAGE_ROUTE: &str = "/__byok-api__/api/promotions/images";
const MAX_AD_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "gif", "webp", "avif"];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdRuntime {
    pub slots: Vec<AdSlot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdSlot {
    pub id: String,
    pub enabled: bool,
    pub placement: AdPlacement,
    pub target: AdTarget,
    pub content: AdContent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdPlacement {
    Menu,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdTarget {
    pub title: String,
    pub description: String,
    pub image_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdContent {
    pub title: String,
    pub description: String,
    pub image_url: String,
    pub details: Vec<AdDetail>,
    pub button: AdButton,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdDetail {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdButton {
    pub label: String,
    pub action: AdAction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdAction {
    #[serde(rename = "type")]
    pub action_type: AdActionType,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdDismissalInput {
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdActionType {
    OpenBrowser,
}

impl AdRuntime {
    pub(super) fn into_menu_slots(mut self) -> Result<Self> {
        self.slots
            .retain(|slot| slot.enabled && slot.placement == AdPlacement::Menu);
        for slot in &self.slots {
            validate_http_url(&slot.target.image_url, "target.imageUrl")?;
            validate_http_url(&slot.content.image_url, "content.imageUrl")?;
            validate_http_url(&slot.content.button.action.url, "content.button.action.url")?;
        }
        Ok(self)
    }

    pub(super) async fn cache_images(&mut self, client: &reqwest::Client) {
        let cache_dir = match config::managed_data_dir() {
            Ok(path) => path.join("ads"),
            Err(error) => {
                tracing::warn!(%error, "failed to resolve advertisement image cache directory");
                return;
            }
        };
        let urls = self
            .slots
            .iter()
            .flat_map(|slot| [&slot.target.image_url, &slot.content.image_url])
            .cloned()
            .collect::<BTreeSet<_>>();
        let downloads = futures_util::future::join_all(urls.iter().map(|url| {
            let cache_dir = &cache_dir;
            async move {
                let result = cache_image(client, cache_dir, url).await;
                (url, result)
            }
        }))
        .await;
        let mut cached_urls = HashMap::new();
        for (url, result) in downloads {
            match result {
                Ok(cached_url) => {
                    cached_urls.insert(url.as_str(), cached_url);
                }
                Err(error) => {
                    tracing::warn!(%error, image_url = %url, "failed to cache advertisement image")
                }
            }
        }
        for slot in &mut self.slots {
            if let Some(url) = cached_urls.get(slot.target.image_url.as_str()) {
                slot.target.image_url.clone_from(url);
            }
            if let Some(url) = cached_urls.get(slot.content.image_url.as_str()) {
                slot.content.image_url.clone_from(url);
            }
        }
    }
}

async fn cache_image(client: &reqwest::Client, cache_dir: &FilePath, url: &str) -> Result<String> {
    tokio::fs::create_dir_all(cache_dir).await?;
    let hash = hex::encode(Sha256::digest(url.as_bytes()));
    if let Some(file_name) = cached_file_name(cache_dir, &hash).await {
        return Ok(format!("{ADS_IMAGE_ROUTE}/{file_name}"));
    }

    let response = client
        .get(url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(Error::Provider(format!(
            "advertisement image download failed ({})",
            response.status()
        )));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(image_extension)
        .ok_or_else(|| {
            Error::Provider("advertisement image has an unsupported content type".into())
        })?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_AD_IMAGE_BYTES as u64)
    {
        return Err(Error::Provider("advertisement image exceeds 10 MiB".into()));
    }

    let mut bytes = BytesMut::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_AD_IMAGE_BYTES {
            return Err(Error::Provider("advertisement image exceeds 10 MiB".into()));
        }
        bytes.extend_from_slice(&chunk);
    }

    let file_name = format!("{hash}.{content_type}");
    let destination = cache_dir.join(&file_name);
    let temporary = cache_dir.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, &bytes).await?;
    if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
        if !destination.exists() {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error.into());
        }
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    Ok(format!("{ADS_IMAGE_ROUTE}/{file_name}"))
}

async fn cached_file_name(cache_dir: &FilePath, hash: &str) -> Option<String> {
    for extension in IMAGE_EXTENSIONS {
        let file_name = format!("{hash}.{extension}");
        if tokio::fs::metadata(cache_dir.join(&file_name))
            .await
            .is_ok()
        {
            return Some(file_name);
        }
    }
    None
}

fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

fn validate_http_url(value: &str, field: &str) -> Result<()> {
    let url = Url::parse(value)
        .map_err(|error| Error::Provider(format!("advertisement {field} is invalid: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Provider(format!(
            "advertisement {field} must be an absolute HTTP or HTTPS URL"
        )));
    }
    Ok(())
}

pub async fn image(
    Path(file_name): Path<String>,
) -> std::result::Result<Response<Body>, StatusCode> {
    let (hash, extension) = file_name.rsplit_once('.').ok_or(StatusCode::NOT_FOUND)?;
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !IMAGE_EXTENSIONS.contains(&extension)
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let path: PathBuf = config::managed_data_dir()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .join("ads")
        .join(&file_name);
    let bytes = tokio::fs::read(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    })?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type_for_extension(extension)),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn content_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub async fn get(
    State(service): State<ControlService>,
    headers: HeaderMap,
) -> Result<Json<AdRuntime>> {
    let disabled_ad_ids = headers
        .get(DISABLED_AD_IDS_HEADER)
        .and_then(|value| value.to_str().ok());
    Ok(Json(
        service.ads(disabled_ad_ids, ad_language(&headers)).await?,
    ))
}

fn ad_language(headers: &HeaderMap) -> &'static str {
    match headers
        .get(LANGUAGE_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if value.eq_ignore_ascii_case("zh-CN") => "zh-CN",
        _ => "en-US",
    }
}

pub async fn dismiss(
    State(service): State<ControlService>,
    Path(ad_id): Path<String>,
    Json(input): Json<AdDismissalInput>,
) -> Result<StatusCode> {
    service.dismiss_ad(&ad_id, &input).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{
        body::Body,
        http::{header, Response},
        routing::get,
        Router,
    };

    use super::*;

    #[test]
    fn recognizes_supported_image_content_types() {
        assert_eq!(image_extension("image/png"), Some("png"));
        assert_eq!(image_extension("image/jpeg; charset=binary"), Some("jpg"));
        assert_eq!(image_extension("IMAGE/WEBP"), Some("webp"));
        assert_eq!(image_extension("image/svg+xml"), None);
        assert_eq!(image_extension("text/html"), None);
    }

    #[tokio::test]
    async fn downloads_an_ad_image_once_and_reuses_the_cache() {
        let requests = Arc::new(AtomicUsize::new(0));
        let request_counter = requests.clone();
        let app = Router::new().route(
            "/ad.png",
            get(move || {
                request_counter.fetch_add(1, Ordering::SeqCst);
                async {
                    Response::builder()
                        .header(header::CONTENT_TYPE, "image/png")
                        .body(Body::from(&b"cached image"[..]))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        let remote_url = format!("http://{address}/ad.png");

        let first = cache_image(&client, root.path(), &remote_url)
            .await
            .unwrap();
        let second = cache_image(&client, root.path(), &remote_url)
            .await
            .unwrap();

        assert_eq!(first, second);
        assert!(first.starts_with(ADS_IMAGE_ROUTE));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let file_name = first.rsplit('/').next().unwrap();
        assert_eq!(
            tokio::fs::read(root.path().join(file_name)).await.unwrap(),
            b"cached image"
        );
        server.abort();
    }
}
