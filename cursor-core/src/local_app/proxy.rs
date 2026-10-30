//! Configures the local application proxy.
use std::{
    collections::HashSet,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
};

use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{header, Request, Response, StatusCode, Uri},
    rustls::crypto::aws_lc_rs,
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use parking_lot::RwLock;

use crate::{
    api::cursor::proxy::UPSTREAM_URL_HEADER, cursor::services::tab::is_tab_path, store::TabMode,
    Error, Result,
};

use super::ca::LoadedCa;

#[derive(Default)]
pub struct ProxyRuntime {
    url: Option<String>,
    port: Option<u16>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl ProxyRuntime {
    pub fn running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }
    pub fn url(&self) -> Option<String> {
        self.running().then(|| self.url.clone()).flatten()
    }
    pub fn port(&self) -> Option<u16> {
        if self.running() {
            self.port
        } else {
            None
        }
    }

    pub async fn start(
        &mut self,
        backend: SocketAddr,
        ca: LoadedCa,
        requested_port: u16,
        tab_mode: Arc<RwLock<TabMode>>,
    ) -> Result<(String, u16)> {
        if let Some(url) = self.url() {
            return Ok((url, self.port.unwrap_or_default()));
        }
        let listener = bind_proxy_listener(requested_port).await?;
        let address = listener.local_addr()?;
        let (stop, done) = oneshot::channel();
        let authority = RcgenAuthority::new(ca.issuer, 1_000, aws_lc_rs::default_provider());
        let proxy = Proxy::builder()
            .with_listener(listener)
            .with_ca(authority)
            .with_rustls_connector(aws_lc_rs::default_provider())
            .with_http_handler(CursorRelay { backend, tab_mode })
            .with_graceful_shutdown(async move {
                let _ = done.await;
            })
            .build()
            .map_err(|error| Error::Store(format!("build Cursor proxy: {error}")))?;
        self.stop = Some(stop);
        self.url = Some(format!("http://{address}"));
        self.port = Some(address.port());
        self.task = Some(tokio::spawn(async move {
            if let Err(error) = proxy.start().await {
                tracing::error!(%error, "Cursor proxy stopped unexpectedly");
            }
        }));
        Ok((self.url.clone().unwrap(), address.port()))
    }

    pub async fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), task).await;
        }
        self.url = None;
        self.port = None;
    }
}

async fn bind_proxy_listener(requested_port: u16) -> Result<TcpListener> {
    let requested = SocketAddr::from(([127, 0, 0, 1], requested_port));
    match TcpListener::bind(requested).await {
        Ok(listener) => Ok(listener),
        Err(error) if requested_port != 0 => {
            tracing::warn!(%requested, %error, "configured proxy port unavailable; selecting a random port");
            Ok(TcpListener::bind("127.0.0.1:0").await?)
        }
        Err(error) => Err(error.into()),
    }
}

#[derive(Clone)]
struct CursorRelay {
    backend: SocketAddr,
    tab_mode: Arc<RwLock<TabMode>>,
}

impl HttpHandler for CursorRelay {
    async fn handle_request(
        &mut self,
        _ctx: &HttpContext,
        mut request: Request<Body>,
    ) -> RequestOrResponse {
        let original = request.uri().clone();
        let locally_routed = should_route_locally(original.path(), *self.tab_mode.read());
        if is_cursor_host(original.host().unwrap_or_default()) {
            tracing::info!(
                target: "cursor_relay",
                stage = "http",
                method = %request.method(),
                host = original.host().unwrap_or("?"),
                path = original.path(),
                local = locally_routed,
                "HTTP 请求到达 MITM"
            );
        }
        if is_cursor_host(original.host().unwrap_or_default()) {
            if locally_routed {
                if let Ok(value) = original.to_string().parse() {
                    request.headers_mut().insert(UPSTREAM_URL_HEADER, value);
                }
                let path = original
                    .path_and_query()
                    .map(|value| value.as_str())
                    .unwrap_or("/");
                if let Ok(uri) = format!("http://{}{}", self.backend, path).parse::<Uri>() {
                    *request.uri_mut() = uri;
                }
            } else {
                note_fallback_path(original.path());
            }
        }
        if is_cursor_host(original.host().unwrap_or_default())
            && original.path() == CLOUD_AGENT_RUN_PATH
        {
            // Cursor 3.27+ 会向官方发起 GET /agent/v1/run（WebSocket 订阅云端 agent 命令），
            // 携带的是我们的本地注入 token，官方必然 401。透传只会得到同样的 401，
            // 还要白打一条 hudsucker tunnel ERROR；本地 agent 主链路（RunSSE）不依赖这条通道。
            // 就地返回 401：行为与官方一致、少一次出站、消除日志噪声。
            tracing::info!(
                target: "cursor_relay",
                stage = "http",
                path = CLOUD_AGENT_RUN_PATH,
                "云端命令通道本地短路（本地 token 官方必然 401，本地 agent 不依赖此通道）"
            );
            let response = Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    "{\"code\":\"unauthenticated\",\"message\":\"local BYOK mode\"}",
                ))
                .expect("static 401 response builder");
            return RequestOrResponse::Response(response);
        }
        request.into()
    }

    async fn should_intercept_connect(
        &mut self,
        _ctx: &HttpContext,
        request: &Request<Body>,
    ) -> bool {
        let host = request
            .uri()
            .authority()
            .map(|authority| authority.host().to_owned())
            .unwrap_or_default();
        let hit = is_cursor_host(&host);
        if hit {
            tracing::info!(target: "cursor_relay", stage = "connect", host = %host, "CONNECT 命中 Cursor 域名");
        }
        hit
    }

    async fn should_intercept_tls(
        &mut self,
        _ctx: &HttpContext,
        hello: hudsucker::rustls::server::ClientHello<'_>,
    ) -> bool {
        let sni = hello.server_name().unwrap_or("").to_owned();
        let hit = is_cursor_host(&sni);
        if hit {
            tracing::info!(target: "cursor_relay", stage = "tls", sni = %sni, "开始 TLS 中间人");
        } else if !sni.is_empty() {
            tracing::debug!(target: "cursor_relay", stage = "tls", sni = %sni, "非 Cursor 域名，直通");
        }
        hit
    }
}

pub fn is_cursor_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(host.as_str(), "api2.cursor.sh" | "api3.cursor.sh" | "authenticator.cursor.sh")
        || host.ends_with(".cursor.sh")
}

fn is_local_path(path: &str) -> bool {
    matches!(
        path,
        "/agent.v1.AgentService/RunSSE"
            | "/aiserver.v1.BidiService/BidiAppend"
            | "/aiserver.v1.AiService/AvailableDocs"
            | "/aiserver.v1.DashboardService/GetEffectiveUserPlugins"
            | "/aiserver.v1.DashboardService/GetUserPrivacyMode"
            | "/agent.v1.AgentService/UpdateConversationMetadata"
            | "/aiserver.v1.AiService/GetServerConfig"
            | "/aiserver.v1.ServerConfigService/GetServerConfig"
            | "/aiserver.v1.AiService/AvailableModels"
            | "/agent.v1.AgentService/GetUsableModels"
            | "/aiserver.v1.AiService/GetUsableModels"
            | "/agent.v1.AgentService/GetDefaultModelForCli"
            | "/aiserver.v1.AiService/GetDefaultModelForCli"
            | "/aiserver.v1.AiService/GetDefaultModel"
            | "/aiserver.v1.AiService/GetDefaultModelNudgeData"
            | "/aiserver.v1.AuthService/GetEmail"
            | "/aiserver.v1.AuthService/GetUserMeta"
            | "/aiserver.v1.DashboardService/GetMe"
            | "/aiserver.v1.DashboardService/GetTeams"
            | "/aiserver.v1.DashboardService/GetUserProfile"
            | "/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
            | "/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants"
            | "/aiserver.v1.AiService/KnowledgeBaseAdd"
            | "/aiserver.v1.AiService/KnowledgeBaseList"
            | "/aiserver.v1.AiService/KnowledgeBaseUpdate"
            | "/aiserver.v1.AiService/KnowledgeBaseRemove"
            | "/aiserver.v1.AiService/WriteGitCommitMessage"
            | "/aiserver.v1.NetworkService/IsConnected"
            | "/aiserver.v1.AnalyticsService/BootstrapStatsig"
            | "/auth/full_stripe_profile"
            | "/auth/stripe_profile"
    )
}

fn should_route_locally(path: &str, tab_mode: TabMode) -> bool {
    is_local_path(path) || (is_tab_path(path) && tab_mode != TabMode::Direct)
}

/// Cursor 3.27+ 的云端 agent 命令订阅通道（GET WebSocket）。
const CLOUD_AGENT_RUN_PATH: &str = "/agent/v1/run";

/// fallback 留痕：未命中本地路由的 Cursor 请求路径，去重后各记一条。
/// 名单式白名单只能保证"名单内的都处理对了"，保证不了"名单还够用"——
/// 新版新增的端点（世界变了）只会安静地走 fallback 透传官方，
/// 表现是"自定义模型没反应"且无任何报错。这张表就是发现机制：
/// 新路径从这里冒出来，就是新版要支持的东西。
static FALLBACK_SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn note_fallback_path(path: &str) {
    let set = FALLBACK_SEEN.get_or_init(|| Mutex::new(HashSet::new()));
    let mut guard = match set.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if guard.len() < 256 && guard.insert(path.to_owned()) {
        tracing::info!(
            target: "cursor_relay",
            stage = "fallback",
            path = %path,
            "透传官方：未命中本地路由（新端点从这里冒出来，纳入下一轮白名单评审）"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_cli_transport_and_model_metadata_routes_stay_local() {
        for path in [
            "/aiserver.v1.AiService/GetServerConfig",
            "/aiserver.v1.ServerConfigService/GetServerConfig",
            "/agent.v1.AgentService/GetDefaultModelForCli",
            "/aiserver.v1.AiService/GetDefaultModelForCli",
            "/aiserver.v1.AiService/GetDefaultModel",
            "/aiserver.v1.AiService/GetDefaultModelNudgeData",
            "/aiserver.v1.AiService/AvailableDocs",
            "/aiserver.v1.DashboardService/GetEffectiveUserPlugins",
            "/aiserver.v1.DashboardService/GetUserPrivacyMode",
            "/agent.v1.AgentService/UpdateConversationMetadata",
        ] {
            assert!(is_local_path(path), "{path} must not reach Cursor upstream");
        }
    }
}
