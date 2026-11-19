// hybrid-server.js — Selective intercept proxy for Windsurf
//
// GetChatMessage → Anthropic API (your key, your models)
// Everything else → real Codeium servers (trial account)
//
// Usage: node src/hybrid-server.js
//   Windsurf settings: "http.proxy": "http://localhost:3000"

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from './lib/config-dir.js';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { listenWithReclaim } from './port-utils.js';
import { handleGetChatMessage, shouldIntercept } from './handlers/chat.js';
import { createTracker } from './request-tracker.js';
import { handleLocalProxyRequest, isLocalProxyRequest } from './local-proxy.js';
import { handleCursorRequest } from './cursor-proxy.js';
import { injectWithRetry, listTargets, isAlreadyInjected, readInjectableModels } from './lib/codex-desktop-cdp.js';
import { parseFields, writeStringField, writeBytesField, writeVarintField } from './proto.js';
import { tryGunzip, unaryHeaders, wrapUnary } from './connect.js';
import { mergeUnaryFrames } from './handlers/build-response.js';
import { snapshot } from './stats.js';
import { extractModelList, unlockModels } from './rename-models.js';
import { WINDSURF_CATALOG } from './windsurf-catalog.js';
import { mitmLog, rpcAuditLog } from './mitm-logger.js';
import { SHARED_HTTPS_AGENT, httpsAgentFor } from './system-proxy.js';
import { attachPluginRoutes } from './plugin-loader.js';
import { createRateLimitedLogger } from './lib/log-rate-limit.js';
import {
  isPreHandshakeDisconnect,
  mitmCertRejected,
  TLS_CLIENT_CERT_REJECTED_EVENT,
} from './lib/tls-diagnostics.js';
import {
  hashModelList,
  loadMitmCertificates,
  rewriteConfigSignature,
  writeCapturedModelList,
} from './lib/hybrid-server/certs-and-traffic.js';
import {
  PREFLIGHT_ALLOW_METHODS,
  STREAMING_METHODS,
  createProtoHelpers,
  getRpcMethod,
  now,
  sanitizeProxyRequestHeaders,
  sanitizeProxyResponseHeaders,
  stripRoutePrefix,
} from './lib/hybrid-server/proto-helpers.js';
import { createCodeiumProxy } from './lib/hybrid-server/codeium-proxy.js';
import {
  createMitmInternalServer,
  handleByokCdpNoBodyRoute,
  handleByokCdpPostRoute,
  handleCommonCodeiumAndChatRoutes,
  handleMitmHealthRoute,
  startAntigravityHttpsEndpoint,
} from './lib/hybrid-server/mitm-and-cdp.js';

// 只给高频重复诊断套用去重限流，不替换全局 console：
// 第三方依赖的日志和一次性错误必须完整可见，排查时也不能被 60s 窗口吞掉最后一跳。
const diagLog = createRateLimitedLogger(console);

function intEnv(name, fallback, min = 1) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const PORT = intEnv('API_PORT', 7450, 1);
const DEBUG_IMAGES = /^(true|1|on)$/i.test(String(process.env.BYOK_DEBUG_IMAGES || 'false'));
const PROXY_HTTPS_AGENT = SHARED_HTTPS_AGENT;

// 遥测屏蔽：这些 gRPC 方法直接返回空 200 响应，不转发到服务端。
// 保护隐私，避免 BYOK 使用行为暴露。
const BLOCKED_TELEMETRY_METHODS = new Set([
  'RecordCortexTrajectory',
  'RecordCortexTrajectoryStep',
  'RecordAsyncTelemetry',
  'RecordStateInitialization',
  'RecordCortexExecutionMeta',
  'RecordCortexGeneratorMeta',
  'RecordTrajectorySegment',
  'RecordEvent',
  'RecordCortexStateEvent',
]);

// Real Codeium servers
const REAL_API_HOST = 'server.self-serve.windsurf.com';
const REAL_WEBSITE = 'windsurf.com';
const REAL_REGISTER_HOST = 'register.windsurf.com';
const REAL_UNLEASH_HOST = 'unleash.codeium.com';

// API hosts must be MITM'd for model/status rewriting. If the certificate
// cannot be loaded, these targets fail explicitly instead of silently falling
// back to a blind tunnel that makes the proxy look healthy but ineffective.
const MITM_HOSTS = new Set([
  REAL_API_HOST,
  'server.codeium.com',
  'api2.cursor.sh',
  'authentication.cursor.sh',
  'prod.authentication.cursor.sh',
]);

// ─── MITM certs for server.codeium.com (optional — not needed behind nginx) ──
// Priority: BYOK_CONFIG_DIR/certs (user-generated) → BYOK_RESOURCE_DIR/certs → ../certs
function resolveCertsDir() {
  // pathToFileURL 正确处理 Windows 盘符（file:///C:/...），避免 file://C:/ 被解析成 host
  const toUrl = (p) => {
    const base = pathToFileURL(path.resolve(String(p))).href.replace(/\/?$/, '/');
    return new URL('certs/', base);
  };
  if (process.env.BYOK_CONFIG_DIR) return toUrl(process.env.BYOK_CONFIG_DIR);
  if (process.env.BYOK_RESOURCE_DIR) return toUrl(process.env.BYOK_RESOURCE_DIR);
  try {
    if (import.meta?.url) return new URL('../certs/', import.meta.url);
  } catch {}
  return toUrl(process.cwd());
}
const CERTS_DIR = resolveCertsDir();

// ─── 接管心跳 ───
// 「IDE 接管是否生效」的唯一可靠判据：网关有没有收到目标 IDE 的模型请求。
// 配置写进 settings.json（patched）不等于生效——IDE 只在启动时读取网关配置，
// 写完不重启就一直直连，模型下拉框永远不会被改写。
// 这里把心跳落盘，供 Rust 侧体检直接判决，不再靠用户描述现象。
const TAKEOVER_STATE_FILE = 'anybridge-takeover-state.json';
const takeoverState = {
  version: 1,
  proxyStartedAt: Date.now(),
  lastIdeRequestAt: 0,
  lastCaptureAt: 0,
  captureSource: '',
  captureHost: '',
};
let takeoverPersistAt = 0;

function takeoverStatePath() {
  return path.join(configDir(), TAKEOVER_STATE_FILE);
}

function persistTakeoverState(force = false) {
  const now = Date.now();
  // IDE 心跳是秒级的，落盘节流到 5s，避免磁盘 IO 被打满
  if (!force && now - takeoverPersistAt < 5000) return;
  takeoverPersistAt = now;
  try {
    fs.writeFile(takeoverStatePath(), JSON.stringify(takeoverState, null, 2), () => {});
  } catch { /* 心跳落盘失败不影响网关功能 */ }
}

function noteTakeoverRequest(host) {
  takeoverState.lastIdeRequestAt = Date.now();
  if (host) takeoverState.captureHost = String(host);
  persistTakeoverState();
}

function noteTakeoverCapture(host) {
  takeoverState.lastCaptureAt = Date.now();
  takeoverState.captureSource = 'captured';
  if (host) takeoverState.captureHost = String(host);
  persistTakeoverState(true);
}

// 启动即落一次初始状态：让体检能区分「网关在跑但从没收到请求」与「网关没跑」
persistTakeoverState(true);

const {
  MITM_CERT,
  MITM_KEY,
  MITM_CA_CERT,
  MITM_ENABLED,
  MITM_CERT_FINGERPRINT,
  MITM_ERROR,
} = loadMitmCertificates(CERTS_DIR, MITM_HOSTS);

let requestCounter = 0;

const CA_COMMON_NAME_HINT = '「AnyBridge Local CA」';

const mitmUpstreamHost = new WeakMap();

const modelRewriteCacheState = {
  lastModelListSig: '',
  lastModelListCapturedAt: 0,
  lastModelCaptureLogAt: 0,
  lastModelRewriteLogAt: 0,
  lastUnlockInputSig: '',
  lastUnlockResult: null,
};

function getUpstreamHost(url) {
  if (url.includes('unleash') || url.includes('experiment_config')) {
    return REAL_UNLEASH_HOST;
  }
  return REAL_API_HOST;
}

const {
  rewriteRegisterUser,
  buildPreflightOkResponse,
  makeUnaryResponseCollector,
} = createProtoHelpers({
  PORT,
  parseFields,
  writeStringField,
  writeBytesField,
  writeVarintField,
  mergeUnaryFrames,
  wrapUnary,
  unaryHeaders,
});

const proxyToCodeium = createCodeiumProxy({
  configDir,
  mitmUpstreamHost,
  getUpstreamHost,
  httpsAgentFor,
  PROXY_HTTPS_AGENT,
  rpcAuditLog,
  mitmLog,
  tryGunzip,
  rewriteRegisterUser,
  noteTakeoverRequest,
  noteTakeoverCapture,
  diagLog,
  extractModelList,
  unlockModels,
  cacheState: modelRewriteCacheState,
});

// ─── Main request handler ─────────────────────────────────

function handleRequest(req, res) {
  const id = ++requestCounter;
  const method = getRpcMethod(req.url);

  // ── BYOK control endpoint: stats snapshot (local UI only) ──
  if (req.url === '/__byok/stats') {
    const payload = JSON.stringify({
      ...snapshot(),
      mitmEnabled: MITM_ENABLED,
      mitmCertFingerprint: MITM_CERT_FINGERPRINT,
      mitmCertDir: CERTS_DIR.href,
      mitmError: MITM_ERROR,
      mitmHosts: [...MITM_HOSTS],
      windsurfCatalogCount: WINDSURF_CATALOG.length,
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(payload);
    return;
  }

  if (handleMitmHealthRoute(req, res, { mitmUpstreamHost, MITM_ENABLED, MITM_CERT_FINGERPRINT })) {
    return;
  }

  if (handleByokCdpNoBodyRoute(req, res, { listTargets })) return;

  const chunks = [];
  req.on('error', err => {
    console.error(`[${now()}] #${id} REQ ERROR: ${err.message}`);
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (handleByokCdpPostRoute(req, res, body, id, {
      readInjectableModels,
      injectWithRetry,
      isAlreadyInjected,
      cacheState: modelRewriteCacheState,
    })) {
      return;
    }

    if (isLocalProxyRequest(req)) {
      console.log(`[${now()}] #${id} local ${req.method} ${req.url}`);
      Promise.resolve(handleLocalProxyRequest(req, res, body)).catch(err => {
        console.error(`[${now()}] #${id} local proxy error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
      });
      return;
    }

    // ── Plugin system internal routes ──
    if (req.url.startsWith('/internal/plugins/')) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      let pluginBody = null;
      if (req.method === 'POST') {
        try { pluginBody = JSON.parse(body || '{}'); } catch { pluginBody = {}; }
      }
      res.setHeader('content-type', 'application/json');
      attachPluginRoutes(req, res, url, pluginBody).then(handled => {
        if (!handled) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        }
      }).catch(err => {
        console.error(`[${now()}] #${id} plugin route error: ${err.message}`);
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: err.message }));
      });
      return;
    }

    if (handleCursorRequest(req, res, body, {
      id,
      source: 'http',
      log: (line) => console.log(`[${now()}] #${id} ${line}`),
    })) {
      return;
    }

    // 仅浏览器网页导航 (GET + Accept: text/html) 才做 302 跳转。
    // gRPC/Connect 调用是 POST + proto/connect，绝不满足，必须透传到 Codeium——
    // 否则刷新额度 / 切换账号等请求会被 302 误伤而失败。
    const accept = req.headers['accept'] || '';
    const isBrowserNav = req.method === 'GET' && accept.includes('text/html');

    // ── Web/OAuth redirects → real Windsurf servers ──
    if (isBrowserNav && (
        req.url.startsWith('/profile') || req.url.startsWith('/login') ||
        req.url.startsWith('/signup') || req.url.startsWith('/redirect/') ||
        req.url.startsWith('/changelog') || req.url === '/favicon.ico')) {
      console.log(`[${now()}] #${id} → redirect ${req.url}`);
      res.writeHead(302, { location: `https://${REAL_WEBSITE}${req.url}` });
      return res.end();
    }

    if (isBrowserNav && (
        req.url.includes('prompt=login') || req.url.includes('scope=openid') ||
        req.url.includes('authorize') || req.url.includes('client_id=codeium'))) {
      console.log(`[${now()}] #${id} → auth redirect`);
      res.writeHead(302, { location: `https://${REAL_REGISTER_HOST}${req.url}` });
      return res.end();
    }

    if (handleCommonCodeiumAndChatRoutes(req, res, body, {
      id,
      method,
      source: 'http',
      client: 'direct',
      BLOCKED_TELEMETRY_METHODS,
      rpcAuditLog,
      buildPreflightOkResponse,
      shouldIntercept,
      createTracker,
      handleGetChatMessage,
      onBeforeChat: DEBUG_IMAGES ? () => {
        try {
          const dumpDir = path.join(configDir(), 'debug-dumps');
          fs.mkdirSync(dumpDir, { recursive: true });
          const dumpPath = path.join(dumpDir, `getchat-${Date.now()}.bin`);
          fs.writeFileSync(dumpPath, body);
          console.log(`  [DEBUG-DUMP] raw body saved to ${dumpPath} (${body.length}b)`);
        } catch(e) {
          console.log(`  [DEBUG-DUMP] err: ${e.message}`);
        }
        try {
          const bodyStr = body.toString('latin1');
          const matches = [...bodyStr.matchAll(/base64_data[\x00-\xff]{0,5}([A-Za-z0-9+\/=]{50,})/g)];
          for (const m of matches) {
            const b64 = m[1];
            const buf = Buffer.from(b64.slice(0, 100), 'base64');
            let sizeStr = '';
            if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) {
              const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
              sizeStr = `PNG ${w}x${h}`;
            } else if (buf[0] === 0xff && buf[1] === 0xd8) {
              sizeStr = 'JPEG (parse skipped)';
            } else {
              sizeStr = 'unknown format head=' + Array.from(buf.slice(0,4)).map(x=>x.toString(16)).join('');
            }
            console.log(`  [DEBUG-RAW-IMG] ${sizeStr} b64_len=${b64.length} decoded~=${Math.floor(b64.length*0.75)}b`);
          }
          if (matches.length === 0) console.log(`  [DEBUG-RAW-IMG] no base64_data in raw body`);
        } catch (e) {
          console.log(`  [DEBUG-RAW-IMG] scan err: ${e.message}`);
        }
      } : null,
    })) {
      return;
    }

    // ── Everything else → forward to real Codeium ──
    if (method === 'GetUserStatus') {
      statusLog.sample(id, method, body.length);
    } else {
      console.log(`[${now()}] #${id} → ${method || req.url.slice(0, 80)} (${body.length}b) → Codeium`);
    }
    proxyToCodeium(req, res, body, id);
  });
}

// ─── Server ───────────────────────────────────────────────

// 高频请求日志采样：避免每秒 10+ 条 GetUserStatus 把日志洪流。
// 策略：每 5s 内最多打印 1 条。
const statusLog = {
  lastPrintAt: 0,
  count: 0,
  sample(id, method, size) {
    this.count++;
    const now = Date.now();
    if (now - this.lastPrintAt >= 5000) {
      console.log(`[${new Date().toISOString().slice(11, 23)}] #${id} → MITM ${method} (${size}b) → Codeium [过去 5s 共 ${this.count} 次心跳]`);
      this.lastPrintAt = now;
      this.count = 0;
    }
  },
};

const server = http.createServer(handleRequest);

const mitmServer = createMitmInternalServer({
  nextRequestId: () => ++requestCounter,
  mitmUpstreamHost,
  MITM_ENABLED,
  MITM_CERT_FINGERPRINT,
  handleCursorRequest,
  BLOCKED_TELEMETRY_METHODS,
  rpcAuditLog,
  buildPreflightOkResponse,
  shouldIntercept,
  makeUnaryResponseCollector,
  createTracker,
  handleGetChatMessage,
  statusLog,
  proxyToCodeium,
});

// ─── CONNECT tunnel handler ───────────────────────────────
// Two modes:
//   1. server.codeium.com → MITM: terminate TLS, parse HTTP, intercept GetChatMessage
//   2. Everything else    → Blind TCP pipe (login, telemetry, marketplace, etc.)

server.on('connect', (req, clientSocket, head) => {
  const id = ++requestCounter;
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;

  // ── MITM for API hosts (Windsurf/Devin/experimental Cursor)
  if (MITM_HOSTS.has(host) && !MITM_ENABLED) {
    console.error(`[${now()}] #${id} ❌ MITM unavailable for ${host}: ${MITM_ERROR || 'unknown certificate error'}`);
    rpcAuditLog({
      id,
      phase: 'connect',
      source: 'connect',
      route: 'mitm_unavailable',
      url: req.url,
      upstream: host,
      statusCode: 503,
      error: MITM_ERROR || 'certificate unavailable',
    });
    clientSocket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  if (MITM_HOSTS.has(host) && MITM_ENABLED) {
    console.log(`[${now()}] #${id} 🔓 MITM ${host}:${targetPort}`);
    rpcAuditLog({
      id,
      phase: 'connect',
      source: 'connect',
      route: 'mitm',
      url: req.url,
      upstream: host,
      statusCode: 200,
    });

    // Tell client the tunnel is open
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-agent: windsurf-hybrid\r\n' +
      '\r\n'
    );

    // Push back any buffered data before TLS wrapping
    if (head && head.length > 0) {
      clientSocket.unshift(head);
    }

    // Terminate TLS — client thinks it's talking to server.codeium.com.
    // Force ALPN to http/1.1: the decrypted stream is fed to an HTTP/1.1
    // server, so we must not let the client negotiate h2 (would hang/reset).
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      cert: MITM_CERT,
      key: MITM_KEY,
      ALPNProtocols: ['http/1.1'],
    });

    let tlsEstablished = false;
    tlsSocket.on('secure', () => {
      tlsEstablished = true;
      console.log(`  [#${id}] 🔐 TLS established, ALPN=${tlsSocket.alpnProtocol || 'none'}`);
    });

    tlsSocket.on('error', (err) => {
      if (isPreHandshakeDisconnect(err, tlsEstablished)) {
        diagLog.error(
          `⚠️ [${host}] MITM TLS 握手未完成即断开 (${err.code})，客户端可能未信任 MITM 证书或被系统策略中断`,
        );
        if (!clientSocket.destroyed) clientSocket.destroy();
        return;
      }
      // 握手建立后的 ECONNRESET / EPIPE 属于正常长连接关闭噪声
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
      console.error(`  [#${id}] MITM TLS error: ${err.message}`);
      // 客户端不认我们的证书时，光甩一行 OpenSSL 内部错误没人看得懂，
      // 直接把排查动作写清楚（这种失败会导致模型改写不生效，表现为"还是原模型"）。
      if (mitmCertRejected(err)) {
        // 原始 TLS 错误仍逐次记录；重复的结构事件和操作指引交给 diagLog 去重，避免握手风暴刷屏。
        diagLog.error(TLS_CLIENT_CERT_REJECTED_EVENT);
        // 去重按整行文本匹配，因此这条指引不带请求序号；逐次明细由上面的原始错误行承担。
        diagLog.error(
          '❗ 客户端拒绝了 MITM 证书 → 请到「平台(智能体) > 设置 > 环境检测」点「清理并重装」，' +
          '并在系统弹窗里允许授权；然后完全退出 IDE 再打开。若仍失败，检查系统钥匙串/证书库里 ' +
          `${CA_COMMON_NAME_HINT} 是否为「始终信任」。`
        );
      }
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    // Feed the decrypted connection into our internal HTTP server
    // 记录此 socket 的上游主机，MITM 内部服务器转发时需要知道原始目标
    mitmUpstreamHost.set(tlsSocket, host);
    mitmServer.emit('connection', tlsSocket);
    return;
  }

  // ── Everything else: blind TCP pipe ──
  console.log(`[${now()}] #${id} CONNECT ${host}:${targetPort}`);
  rpcAuditLog({
    id,
    phase: 'connect',
    source: 'connect',
    route: 'pipe',
    url: req.url,
    upstream: host,
    statusCode: 200,
  });

  const serverSocket = net.connect(targetPort, host, () => {
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-agent: windsurf-hybrid\r\n' +
      '\r\n'
    );
    if (head.length > 0) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', (err) => {
    console.error(`  [#${id}] CONNECT error → ${host}:${targetPort}: ${err.message}`);
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    }
  });

  clientSocket.on('error', () => {
    if (!serverSocket.destroyed) serverSocket.destroy();
  });
});

function logBanner() {
  console.log(`\n⚡ Windsurf HYBRID PROXY on http://localhost:${PORT}`);
  console.log(`\n   MODE: MITM CONNECT (normal Windsurf, full features)`);
  console.log(`\n   MITM status: ${MITM_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(`   MITM cert: ${CERTS_DIR.href}`);
  if (MITM_CERT_FINGERPRINT) console.log(`   MITM fingerprint: ${MITM_CERT_FINGERPRINT}`);
  if (MITM_ERROR) console.log(`   MITM error: ${MITM_ERROR}`);
  console.log(`   MITM → server.codeium.com:443`);
  console.log(`     GetChatMessage  → Anthropic API (your models, your key)`);
  console.log(`     Everything else → real Codeium (trial account)`);
  console.log(`\n   LOCAL COMPATIBLE API:`);
  console.log(`     OpenAI  -> http://localhost:${PORT}/v1`);
  console.log(`     Codex   -> http://localhost:${PORT}/codex/v1`);
  console.log(`     Claude  -> http://localhost:${PORT}/anthropic`);
  console.log(`     Gemini  -> http://localhost:${PORT}`);

  console.log(`\n   PASSTHROUGH (blind TCP pipe):`);
  console.log(`     All other CONNECT targets (login, telemetry, marketplace)`);
  console.log(`\n   Settings needed:`);
  console.log(`     "http.proxy": "http://localhost:${PORT}"`);
  console.log(`     "http.proxyStrictSSL": false\n`);
}

listenWithReclaim(server, PORT, logBanner, 'hybrid');

// ─── Antigravity HTTPS 端点 ───
// Antigravity 的语言服务器对明文 HTTP 端点会隐藏 boost / teamwork-preview 等
// 高级命令（官方直连是 https）。这里用已受系统信任的 AnyBridge Local CA 签发的
// 叶子证书（SAN 含 localhost）提供 https 端点，使接管后 LS 仍以 https 方式接入。
startAntigravityHttpsEndpoint({ CERTS_DIR, handleRequest, intEnv });
