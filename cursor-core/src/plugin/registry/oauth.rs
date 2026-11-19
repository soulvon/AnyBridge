use std::{path::Path, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::{
    catalog::PluginEntry,
    descriptor::{OAUTH2_ADD_METHOD, OAUTH2_AUTHORIZATION_CODE_ADD_METHOD},
    oauth_callback::{self, CallbackHandle, CallbackOutcome, CallbackRequest},
    state::{now_ms, ResourceDraft},
};
use super::{find_resource, PluginRegistry};
use crate::{Error, Result};

const OAUTH_SLOW_DOWN_STEP_MS: i64 = 5_000;

pub(super) struct OAuthSession {
    plugin_id: String,
    resource_type: String,
    method_id: String,
    session: serde_json::Value,
    expires_at_ms: i64,
    poll_interval_ms: i64,
    next_poll_at_ms: i64,
    flow: OAuthFlow,
}

enum OAuthFlow {
    DeviceCode,
    AuthorizationCode {
        redirect_uri: String,
        code_verifier: String,
        callback: CallbackHandle,
    },
}

enum OAuthPollWork {
    DeviceCode {
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    },
    AuthorizationCode {
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBeginResponse {
    pub session_id: String,
    pub user_code: Option<String>,
    pub verification_url: String,
    pub verification_url_complete: Option<String>,
    pub expires_at_ms: i64,
    pub poll_interval_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum OAuthPollResponse {
    #[serde(rename_all = "camelCase")]
    Pending { poll_interval_ms: i64 },
    #[serde(rename_all = "camelCase")]
    Completed {
        added: usize,
        updated: usize,
        model_sync_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Denied { message: Option<String> },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

impl PluginRegistry {
    pub async fn oauth_begin(
        &self,
        plugin_id: &str,
        resource_type: &str,
        method_id: &str,
    ) -> Result<OAuthBeginResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let method = resource
            .add
            .iter()
            .find(|method| method.id == method_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "plugin '{plugin_id}' does not define OAuth method '{method_id}'"
                ))
            })?;
        // 同一添加入口只有一个活跃生命周期。重新开始时先丢弃旧会话，
        // Drop 授权码会话中的 CallbackHandle 会立即释放 loopback listener。
        self.inner.oauth_sessions.lock().await.retain(|_, session| {
            session.plugin_id != plugin_id
                || session.resource_type != resource_type
                || session.method_id != method_id
        });
        let worker = self.worker(&entry, &executable).await;
        let session_id = uuid::Uuid::new_v4().to_string();

        let (
            session,
            verification_url,
            verification_url_complete,
            expires_at_ms,
            poll_interval_ms,
            flow,
            user_code,
        ) = match method.method_type.as_str() {
            OAUTH2_ADD_METHOD => {
                let value = worker
                    .invoke(
                        "oauth.begin",
                        serde_json::json!({
                            "resourceType": resource_type,
                            "methodId": method.id,
                        }),
                        CancellationToken::new(),
                    )
                    .await?;
                let begin: OAuth2Begin = serde_json::from_value(value)?;
                (
                    begin.session,
                    begin.verification_url,
                    begin.verification_url_complete,
                    begin.expires_at_ms,
                    begin.poll_interval_ms.max(1_000),
                    OAuthFlow::DeviceCode,
                    Some(begin.user_code),
                )
            }
            OAUTH2_AUTHORIZATION_CODE_ADD_METHOD => {
                let state = oauth_random_secret();
                let code_verifier = oauth_random_secret();
                let code_challenge =
                    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
                let callback = method.callback.as_ref();
                let callback = oauth_callback::bind(
                    callback.and_then(|value| value.port),
                    callback
                        .and_then(|value| value.path.as_deref())
                        .unwrap_or("/oauth-callback"),
                    state.clone(),
                    entry.manifest.name.clone(),
                    entry.icon.clone(),
                    serde_json::to_value(&resource.display_name)?,
                )
                .await?;
                let redirect_uri = callback.redirect_uri.clone();
                let value = worker
                    .invoke(
                        "oauth.begin",
                        serde_json::json!({
                            "resourceType": resource_type,
                            "methodId": method.id,
                            "authorization": {
                                "redirectUri": redirect_uri,
                                "state": state,
                                "codeChallenge": code_challenge,
                            },
                        }),
                        CancellationToken::new(),
                    )
                    .await?;
                let begin: OAuth2AuthorizationCodeBegin = serde_json::from_value(value)?;
                let poll_interval_ms = begin.poll_interval_ms.unwrap_or(1_000).max(1_000);
                (
                    begin.session,
                    begin.authorization_url,
                    None,
                    begin.expires_at_ms,
                    poll_interval_ms,
                    OAuthFlow::AuthorizationCode {
                        redirect_uri,
                        code_verifier,
                        callback,
                    },
                    None,
                )
            }
            method_type => {
                return Err(Error::Config(format!(
                        "plugin '{plugin_id}' OAuth method '{method_id}' uses unsupported type '{method_type}'"
                    )));
            }
        };

        if expires_at_ms <= now_ms() {
            return Err(Error::Protocol(format!(
                "plugin '{plugin_id}' OAuth method '{method_id}' returned an expired session"
            )));
        }
        self.inner.oauth_sessions.lock().await.insert(
            session_id.clone(),
            OAuthSession {
                plugin_id: plugin_id.to_owned(),
                resource_type: resource_type.to_owned(),
                method_id: method_id.to_owned(),
                session,
                expires_at_ms,
                poll_interval_ms,
                next_poll_at_ms: now_ms() + poll_interval_ms,
                flow,
            },
        );
        let cleanup = self.clone();
        let cleanup_session_id = session_id.clone();
        let cleanup_delay_ms = expires_at_ms.saturating_sub(now_ms()) as u64;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(cleanup_delay_ms)).await;
            cleanup
                .inner
                .oauth_sessions
                .lock()
                .await
                .remove(&cleanup_session_id);
        });
        Ok(OAuthBeginResponse {
            session_id,
            user_code,
            verification_url,
            verification_url_complete,
            expires_at_ms,
            poll_interval_ms,
        })
    }

    pub async fn oauth_poll(&self, session_id: &str) -> Result<OAuthPollResponse> {
        let work = {
            let now = now_ms();
            let mut sessions = self.inner.oauth_sessions.lock().await;
            let Some(state) = sessions.get_mut(session_id) else {
                return Ok(OAuthPollResponse::Failed {
                    message: "authorization session no longer exists".into(),
                });
            };
            if now >= state.expires_at_ms {
                sessions.remove(session_id);
                return Ok(OAuthPollResponse::Failed {
                    message: "authorization expired".into(),
                });
            }
            if now < state.next_poll_at_ms {
                return Ok(OAuthPollResponse::Pending {
                    poll_interval_ms: state.poll_interval_ms,
                });
            }
            state.next_poll_at_ms = now + state.poll_interval_ms;

            let common = (
                state.plugin_id.clone(),
                state.resource_type.clone(),
                state.method_id.clone(),
                state.session.clone(),
            );
            match &mut state.flow {
                OAuthFlow::DeviceCode => OAuthPollWork::DeviceCode {
                    plugin_id: common.0,
                    resource_type: common.1,
                    method_id: common.2,
                    session: common.3,
                    poll_interval_ms: state.poll_interval_ms,
                },
                OAuthFlow::AuthorizationCode {
                    redirect_uri,
                    code_verifier,
                    callback,
                } => match callback.receiver.try_recv() {
                    Ok(callback_request) => OAuthPollWork::AuthorizationCode {
                        plugin_id: common.0,
                        resource_type: common.1,
                        method_id: common.2,
                        session: common.3,
                        redirect_uri: redirect_uri.clone(),
                        code_verifier: code_verifier.clone(),
                        callback_request,
                    },
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                        return Ok(OAuthPollResponse::Pending {
                            poll_interval_ms: state.poll_interval_ms,
                        });
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                        sessions.remove(session_id);
                        return Ok(OAuthPollResponse::Failed {
                            message: "authorization callback stopped before completion".into(),
                        });
                    }
                },
            }
        };

        match work {
            OAuthPollWork::DeviceCode {
                plugin_id,
                resource_type,
                method_id,
                session,
                poll_interval_ms,
            } => {
                self.poll_device_code(
                    session_id,
                    plugin_id,
                    resource_type,
                    method_id,
                    session,
                    poll_interval_ms,
                )
                .await
            }
            OAuthPollWork::AuthorizationCode {
                plugin_id,
                resource_type,
                method_id,
                session,
                redirect_uri,
                code_verifier,
                callback_request,
            } => {
                self.complete_authorization_code(
                    session_id,
                    plugin_id,
                    resource_type,
                    method_id,
                    session,
                    redirect_uri,
                    code_verifier,
                    callback_request,
                )
                .await
            }
        }
    }

    async fn poll_device_code(
        &self,
        session_id: &str,
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    ) -> Result<OAuthPollResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, &plugin_id).await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "oauth.poll",
                serde_json::json!({
                    "resourceType": resource_type,
                    "methodId": method_id,
                    "session": session,
                }),
                CancellationToken::new(),
            )
            .await?;
        let poll: OAuth2Poll = serde_json::from_value(value)?;
        match poll {
            OAuth2Poll::Pending { session } => {
                self.update_session(session_id, session, None).await;
                Ok(OAuthPollResponse::Pending { poll_interval_ms })
            }
            OAuth2Poll::SlowDown { session } => {
                let interval = poll_interval_ms + OAUTH_SLOW_DOWN_STEP_MS;
                self.update_session(session_id, session, Some(interval))
                    .await;
                Ok(OAuthPollResponse::Pending {
                    poll_interval_ms: interval,
                })
            }
            OAuth2Poll::Completed { resources } => {
                // 持久化成功后才销毁设备码会话:写盘瞬时失败时下次轮询还能重试。
                let response = self
                    .persist_oauth_resources(
                        &entry,
                        &executable,
                        &plugin_id,
                        &resource_type,
                        resources,
                    )
                    .await?;
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(response)
            }
            OAuth2Poll::Denied { message } => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(OAuthPollResponse::Denied { message })
            }
            OAuth2Poll::Failed { message } => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(OAuthPollResponse::Failed { message })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn complete_authorization_code(
        &self,
        session_id: &str,
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    ) -> Result<OAuthPollResponse> {
        let CallbackRequest { result, response } = callback_request;
        let code = match result {
            Ok(code) => code,
            Err(message) => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                let _ = response.send(CallbackOutcome {
                    success: false,
                    message: Some(message.clone()),
                });
                return Ok(OAuthPollResponse::Denied {
                    message: Some(message),
                });
            }
        };

        let result = async {
            let executable = self.executable()?;
            let entry = self.find_entry(&executable, &plugin_id).await?;
            let value = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "oauth.complete",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "methodId": method_id,
                        "session": session,
                        "authorization": {
                            "code": code,
                            "redirectUri": redirect_uri,
                            "codeVerifier": code_verifier,
                        },
                    }),
                    CancellationToken::new(),
                )
                .await?;
            let resources: Vec<ResourceDraft> = serde_json::from_value(value)?;
            self.persist_oauth_resources(&entry, &executable, &plugin_id, &resource_type, resources)
                .await
        }
        .await;

        self.inner.oauth_sessions.lock().await.remove(session_id);
        match result {
            Ok(completed) => {
                let _ = response.send(CallbackOutcome {
                    success: true,
                    message: None,
                });
                Ok(completed)
            }
            Err(error) => {
                let message = error.to_string();
                let _ = response.send(CallbackOutcome {
                    success: false,
                    message: Some(message.clone()),
                });
                Ok(OAuthPollResponse::Failed { message })
            }
        }
    }

    async fn persist_oauth_resources(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        plugin_id: &str,
        resource_type: &str,
        resources: Vec<ResourceDraft>,
    ) -> Result<OAuthPollResponse> {
        let outcome = self
            .inner
            .state
            .upsert_resources(plugin_id, resource_type, resources)
            .await?;
        let model_sync_error = self
            .sync_provider_models_for_resource(entry, executable, resource_type)
            .await;
        Ok(OAuthPollResponse::Completed {
            added: outcome.added,
            updated: outcome.updated,
            model_sync_error,
        })
    }

    async fn update_session(
        &self,
        session_id: &str,
        session: Option<serde_json::Value>,
        poll_interval_ms: Option<i64>,
    ) {
        let mut sessions = self.inner.oauth_sessions.lock().await;
        if let Some(state) = sessions.get_mut(session_id) {
            if let Some(session) = session {
                state.session = session;
            }
            if let Some(interval) = poll_interval_ms {
                state.poll_interval_ms = interval;
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2Begin {
    session: serde_json::Value,
    user_code: String,
    verification_url: String,
    #[serde(default)]
    verification_url_complete: Option<String>,
    expires_at_ms: i64,
    poll_interval_ms: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2AuthorizationCodeBegin {
    session: serde_json::Value,
    authorization_url: String,
    expires_at_ms: i64,
    #[serde(default)]
    poll_interval_ms: Option<i64>,
}

pub(super) fn oauth_random_secret() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "status")]
enum OAuth2Poll {
    #[serde(rename_all = "camelCase")]
    Pending {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    SlowDown {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Completed { resources: Vec<ResourceDraft> },
    #[serde(rename_all = "camelCase")]
    Denied {
        #[serde(default)]
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}
