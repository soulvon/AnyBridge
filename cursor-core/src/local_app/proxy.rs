//! Configures the local application proxy.
use std::{
    collections::HashSet,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
};

use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{header, Method, Request, Response, StatusCode, Uri},
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
            && is_agent_run_websocket_upgrade(request.method(), original.path())
        {
            // Cursor 3.27+/3.29+ 的 GET /agent/v1/run 是 WebSocket Upgrade（云端命令订阅 /
            // Agent Run 传输）。BootstrapStatsig 门禁补丁会把客户端钉回 RunSSE 运行时，
            // 但补丁依赖客户端缓存且 agent-host 有独立 gate 集合，残留升级请求仍可能出现：
            // 回 501 + Connection: close 让 transport 明确回退 RunSSE。401 会被客户端当成
            // 鉴权失败反复重试（Cursor 3.29.9 登录态实测口径）。
            tracing::info!(
                target: "cursor_relay",
                stage = "http",
                path = CLOUD_AGENT_RUN_PATH,
                "Agent Run WebSocket 本地禁用（强制回退 RunSSE 运行时）"
            );
            return RequestOrResponse::Response(agent_run_websocket_disabled());
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

/// Cursor 3.27+ 的云端 agent 命令订阅通道（GET WebSocket）；3.29+ 登录态下兼作
/// Agent Run 的 WebSocket 传输端点。
const CLOUD_AGENT_RUN_PATH: &str = "/agent/v1/run";

/// Agent Run 的 WebSocket 升级判定：GET + 路径。门禁补丁正常生效时客户端不该再发，
/// 这里是「补丁未覆盖时的兜底闸门」。
fn is_agent_run_websocket_upgrade(method: &Method, path: &str) -> bool {
    method == Method::GET && path == CLOUD_AGENT_RUN_PATH
}

/// 拒绝 Agent Run WebSocket 的固定答复：501 + Connection: close。
/// 501 让客户端把该传输视为「未实现」干净回退 RunSSE；401 会被当成鉴权失败重试。
fn agent_run_websocket_disabled() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_IMPLEMENTED)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONNECTION, "close")
        .body(Body::from(
            "Agent Run WebSocket is disabled by the local BYOK gateway; use RunSSE.\n",
        ))
        .expect("static WebSocket rejection is well formed")
}

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

    #[test]
    fn agent_run_websocket_upgrade_is_detected_and_rejected_with_501() {
        // 兜底闸门：门禁补丁未覆盖到的残留升级请求（GET /agent/v1/run）必须被 501 拒掉，
        // 让客户端回退 RunSSE；非 GET 的同路径请求不受影响（保持原有转发语义）
        assert!(is_agent_run_websocket_upgrade(&Method::GET, "/agent/v1/run"));
        assert!(!is_agent_run_websocket_upgrade(
            &Method::POST,
            "/agent/v1/run"
        ));
        assert!(!is_agent_run_websocket_upgrade(
            &Method::GET,
            "/agent/v1/other"
        ));

        let response = agent_run_websocket_disabled();
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        assert_eq!(
            response.headers().get(header::CONNECTION),
            Some(&header::HeaderValue::from_static("close"))
        );
    }
}
