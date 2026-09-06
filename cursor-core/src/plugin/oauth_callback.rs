//! Core-owned loopback callback transport for plugin OAuth authorization-code flows.
use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::Html,
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

use crate::{Error, Result};

const CALLBACK_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) struct CallbackRequest {
    pub result: std::result::Result<String, String>,
    pub response: oneshot::Sender<CallbackOutcome>,
}

#[derive(Debug)]
pub(super) struct CallbackOutcome {
    pub success: bool,
    pub message: Option<String>,
}

pub(super) struct CallbackHandle {
    pub redirect_uri: String,
    pub receiver: oneshot::Receiver<CallbackRequest>,
    shutdown: CancellationToken,
}

impl Drop for CallbackHandle {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    plugin_name: String,
    plugin_icon: String,
    resource_name: serde_json::Value,
    sender: Arc<Mutex<Option<oneshot::Sender<CallbackRequest>>>>,
    shutdown: CancellationToken,
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub(super) async fn bind(
    port: Option<u16>,
    path: &str,
    expected_state: String,
    plugin_name: String,
    plugin_icon: String,
    resource_name: serde_json::Value,
) -> Result<CallbackHandle> {
    let address = SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(0)));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| {
            Error::Config(format!(
                "cannot bind plugin OAuth callback at {address}: {error}"
            ))
        })?;
    let local_address = listener.local_addr()?;
    let redirect_uri = format!("http://127.0.0.1:{}{path}", local_address.port());
    let (sender, receiver) = oneshot::channel();
    let shutdown = CancellationToken::new();
    let state = CallbackState {
        expected_state,
        plugin_name,
        plugin_icon,
        resource_name,
        sender: Arc::new(Mutex::new(Some(sender))),
        shutdown: shutdown.clone(),
    };
    let router = Router::new()
        .route(path, get(handle_callback))
        .with_state(state);
    let graceful = shutdown.clone();
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async move { graceful.cancelled().await })
            .await
        {
            tracing::debug!(%error, "plugin OAuth callback server stopped");
        }
    });
    Ok(CallbackHandle {
        redirect_uri,
        receiver,
        shutdown,
    })
}

async fn handle_callback(
    State(state): State<CallbackState>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Html<String> {
    let locale = callback_locale(&headers);
    if query.state.as_deref() != Some(state.expected_state.as_str()) {
        return Html(render_page(
            &state,
            locale,
            false,
            Some(localized(
                locale,
                "授权状态不匹配，请返回应用后重试。",
                "Authorization state did not match. Return to the app and try again.",
            )),
        ));
    }

    let result = match query.code.filter(|code| !code.trim().is_empty()) {
        Some(code) => Ok(code),
        None => Err(query.error_description.or(query.error).unwrap_or_else(|| {
            localized(locale, "授权被取消。", "Authorization was cancelled.").to_owned()
        })),
    };
    let Some(sender) = state.sender.lock().await.take() else {
        return Html(render_page(
            &state,
            locale,
            false,
            Some(localized(
                locale,
                "该授权回调已被使用。",
                "This authorization callback has already been used.",
            )),
        ));
    };
    let (response, completion) = oneshot::channel();
    if sender.send(CallbackRequest { result, response }).is_err() {
        return Html(render_page(
            &state,
            locale,
            false,
            Some(localized(
                locale,
                "授权会话已结束。",
                "The authorization session has ended.",
            )),
        ));
    }

    let outcome = tokio::time::timeout(CALLBACK_RESPONSE_TIMEOUT, completion).await;
    state.shutdown.cancel();
    match outcome {
        Ok(Ok(outcome)) => Html(render_page(
            &state,
            locale,
            outcome.success,
            outcome.message.as_deref(),
        )),
        _ => Html(render_page(
            &state,
            locale,
            false,
            Some(localized(
                locale,
                "添加资源超时，请返回应用后重试。",
                "Adding the resource timed out. Return to the app and try again.",
            )),
        )),
    }
}

fn callback_locale(headers: &HeaderMap) -> &'static str {
    headers
        .get(axum::http::header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.to_ascii_lowercase().starts_with("zh"))
        .map(|_| "zh-CN")
        .unwrap_or("en-US")
}

fn localized<'a>(locale: &str, chinese: &'a str, english: &'a str) -> &'a str {
    if locale == "zh-CN" {
        chinese
    } else {
        english
    }
}

fn localized_value(value: &serde_json::Value, locale: &str) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            value
                .get(locale)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            value
                .get("en-US")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            value
                .as_object()?
                .values()
                .find_map(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| localized(locale, "资源", "resource").to_owned())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_page(
    state: &CallbackState,
    locale: &str,
    success: bool,
    message: Option<&str>,
) -> String {
    let plugin_name = escape_html(&state.plugin_name);
    let plugin_icon = escape_html(&state.plugin_icon);
    let resource_name = escape_html(&localized_value(&state.resource_name, locale));
    let title = if success {
        localized(locale, "资源添加成功", "Resource added")
    } else {
        localized(locale, "资源添加失败", "Could not add resource")
    };
    let detail = message.map(escape_html).unwrap_or_else(|| {
        if success {
            localized(
                locale,
                "已为该插件添加资源。",
                "A resource has been added for this plugin.",
            )
            .to_owned()
        } else {
            localized(
                locale,
                "请返回应用后重试。",
                "Return to the app and try again.",
            )
            .to_owned()
        }
    });
    let close = localized(
        locale,
        "您现在可以关闭本页面并返回 Cursor BYOK。",
        "You can now close this page and return to Cursor BYOK.",
    );
    format!(
        r#"<!doctype html>
<html lang="{locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>{title}</title><style>
:root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:15px system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}}main{{width:min(420px,calc(100vw - 48px));text-align:center}}img{{width:56px;height:56px;object-fit:contain}}h1{{font-size:20px;margin:16px 0 6px}}.plugin{{opacity:.72;margin-bottom:24px}}.resource{{font-weight:600;margin:8px 0}}.detail{{opacity:.82;line-height:1.6}}.close{{opacity:.62;margin-top:24px;font-size:13px}}
</style></head><body><main><img src="{plugin_icon}" alt=""><h1>{title}</h1><div class="plugin">{plugin_name}</div><div class="resource">{resource_name}</div><div class="detail">{detail}</div><div class="close">{close}</div></main></body></html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_plugin_content_in_callback_page() {
        let state = CallbackState {
            expected_state: "state".into(),
            plugin_name: "<plugin>".into(),
            plugin_icon: "data:image/svg+xml;base64,abc".into(),
            resource_name: serde_json::json!({"en-US": "Accounts & keys"}),
            sender: Arc::new(Mutex::new(None)),
            shutdown: CancellationToken::new(),
        };
        let page = render_page(&state, "en-US", true, None);
        assert!(page.contains("&lt;plugin&gt;"));
        assert!(page.contains("Accounts &amp; keys"));
        assert!(!page.contains("<plugin>"));
    }

    #[tokio::test]
    async fn callback_rejects_wrong_state_then_delivers_code() {
        let mut callback = bind(
            None,
            "/oauth-callback",
            "expected".into(),
            "Plugin".into(),
            "data:image/svg+xml;base64,abc".into(),
            serde_json::json!("Account"),
        )
        .await
        .unwrap();
        let client = reqwest::Client::new();
        let rejected = client
            .get(format!(
                "{}?state=wrong&code=ignored",
                callback.redirect_uri
            ))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(rejected.contains("Authorization state did not match"));

        let client = client.clone();
        let redirect_uri = callback.redirect_uri.clone();
        let browser = tokio::spawn(async move {
            client
                .get(format!("{redirect_uri}?state=expected&code=accepted"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        let request = (&mut callback.receiver).await.unwrap();
        assert_eq!(request.result.unwrap(), "accepted");
        request
            .response
            .send(CallbackOutcome {
                success: true,
                message: None,
            })
            .unwrap();
        assert!(browser.await.unwrap().contains("Resource added"));
    }
}
