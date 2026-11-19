import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import {
  PREFLIGHT_ALLOW_METHODS,
  getRpcMethod,
  now,
} from './proto-helpers.js';

export function handleByokCdpNoBodyRoute(req, res, { listTargets }) {
  const reqPath = req.url.split('?')[0];
  if (reqPath === '/__byok/codex-cdp/version') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, version: '20260627-v6-proven', patchKey: '__ccSwitchCodexModelPickerUnlockV6' }));
    return true;
  }

  if (reqPath === '/__byok/codex-cdp/status') {
    (async () => {
      try {
        const search = req.url.split('?')[1] || '';
        const params = new URLSearchParams(search);
        const port = parseInt(params.get('port') || '9229', 10);
        const targets = await listTargets(port);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ ok: true, reachable: true, targets: targets.length }));
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ ok: true, reachable: false, error: err.message }));
      }
    })();
    return true;
  }

  return false;
}

export function handleByokCdpPostRoute(req, res, body, id, {
  readInjectableModels,
  injectWithRetry,
  isAlreadyInjected,
  cacheState,
}) {
  if (req.url === '/__byok/codex-cdp/inject' && req.method === 'POST') {
    (async () => {
      try {
        const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
        const port = parseInt(payload.port || '9229', 10);
        const models = Array.isArray(payload.models) && payload.models.length
          ? payload.models
          : readInjectableModels();
        console.log(`[${now()}] #${id} CDP inject → port ${port}, ${models.length} models`);
        const result = await injectWithRetry(port, models);
        const json = JSON.stringify(result);
        res.writeHead(result.ok ? 200 : 502, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(json) });
        res.end(json);
      } catch (err) {
        console.error(`[${now()}] #${id} CDP inject error: ${err.message}`);
        const json = JSON.stringify({ ok: false, message: err.message || String(err) });
        res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(json) });
        res.end(json);
      }
    })();
    return true;
  }

  if (req.url === '/__byok/codex-cdp/check' && req.method === 'POST') {
    (async () => {
      try {
        const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
        const port = parseInt(payload.port || '9229', 10);
        const injected = await isAlreadyInjected(port);
        const json = JSON.stringify({ ok: true, injected });
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(json) });
        res.end(json);
      } catch (err) {
        const json = JSON.stringify({ ok: true, injected: false, error: err.message });
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(json) });
        res.end(json);
      }
    })();
    return true;
  }

  if (req.url === '/__byok/invalidate-models' && req.method === 'POST') {
    cacheState.lastUnlockInputSig = '';
    cacheState.lastUnlockResult = null;
    cacheState.lastModelListCapturedAt = 0;
    cacheState.lastModelRewriteLogAt = 0;
    cacheState.lastModelCaptureLogAt = 0;
    const json = JSON.stringify({ ok: true });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(json) });
    res.end(json);
    console.log(`[${now()}] #${id} 🧹 invalidated unlockModels cache`);
    return true;
  }

  return false;
}

export function handleMitmHealthRoute(req, res, { mitmUpstreamHost, MITM_ENABLED, MITM_CERT_FINGERPRINT }) {
  if (req.url !== '/__byok/mitm-health') return false;
  const upstream = req.socket && mitmUpstreamHost.get(req.socket);
  const payload = JSON.stringify({
    ok: MITM_ENABLED && Boolean(upstream),
    source: upstream ? 'mitm' : 'direct',
    upstream: upstream || null,
    mitmEnabled: MITM_ENABLED,
    fingerprint: MITM_CERT_FINGERPRINT,
  });
  res.writeHead(upstream && MITM_ENABLED ? 200 : 503, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'connection': 'close',
  });
  res.end(payload);
  return true;
}

export function handleCommonCodeiumAndChatRoutes(req, res, body, {
  id,
  method,
  source,
  client,
  BLOCKED_TELEMETRY_METHODS,
  rpcAuditLog,
  buildPreflightOkResponse,
  shouldIntercept,
  makeUnaryResponseCollector,
  createTracker,
  handleGetChatMessage,
  onBeforeChat,
}) {
  if (BLOCKED_TELEMETRY_METHODS.has(method)) {
    console.log(`[${now()}] #${id} 🚫 ${source === 'mitm' ? 'MITM ' : ''}${method} → blocked`);
    rpcAuditLog({
      id,
      phase: 'blocked',
      source,
      route: 'blocked',
      method,
      url: req.url,
      requestBytes: body.length,
      statusCode: 200,
      responseBytes: 0,
    });
    res.writeHead(200, { 'content-type': 'application/proto' });
    res.end();
    return true;
  }

  if (PREFLIGHT_ALLOW_METHODS.has(method)) {
    console.log(`[${now()}] #${id} ${source === 'mitm' ? 'MITM ' : ''}${method} -> local preflight ok`);
    const protoBody = buildPreflightOkResponse(method);
    const frame = Buffer.alloc(5 + protoBody.length);
    frame[0] = 0;
    frame.writeUInt32BE(protoBody.length, 1);
    protoBody.copy(frame, 5);
    rpcAuditLog({
      id,
      phase: 'intercepted',
      source,
      route: 'byok-preflight-allow',
      method,
      url: req.url,
      requestBytes: body.length,
      statusCode: 200,
      responseBytes: frame.length,
    });
    res.writeHead(200, {
      'content-type': 'application/proto',
      'content-length': frame.length,
    });
    res.end(frame);
    return true;
  }

  if (method === 'GetChatMessage' && shouldIntercept(body, req.headers)) {
    console.log(`[${now()}] #${id} ⚡ ${source === 'mitm' ? 'MITM ' : ''}GetChatMessage → BYOK (${body.length}b) ct=${req.headers['content-type'] || '-'} enc=${req.headers['connect-content-encoding'] || req.headers['content-encoding'] || '-'}`);
    rpcAuditLog({
      id,
      phase: 'intercepted',
      source,
      route: 'byok',
      method,
      url: req.url,
      requestBytes: body.length,
    });
    if (typeof onBeforeChat === 'function') onBeforeChat();
    const reqContentType = String(req.headers['content-type'] || '');
    const isUnaryRequest = source === 'mitm' && reqContentType.includes('application/proto') && !reqContentType.includes('connect+proto');
    const targetRes = isUnaryRequest && typeof makeUnaryResponseCollector === 'function'
      ? makeUnaryResponseCollector(res)
      : res;
    const tracker = createTracker({ client: client || 'direct', route: 'chat' });
    try {
      const result = handleGetChatMessage(req, targetRes, body, tracker);
      if (result && typeof result.catch === 'function') {
        result.catch(err => {
          console.error(`[${now()}] #${id} Chat error: ${err.message}`);
          if (!targetRes.headersSent) targetRes.writeHead(500);
          if (!targetRes.writableEnded) targetRes.end();
          tracker.finish();
        });
      }
    } catch (err) {
      console.error(`[${now()}] #${id} Chat error: ${err.message}`);
      if (!targetRes.headersSent) targetRes.writeHead(500);
      if (!targetRes.writableEnded) targetRes.end();
      tracker.finish();
    }
    return true;
  }

  return false;
}

export function createMitmInternalServer({
  nextRequestId,
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
}) {
  return http.createServer((req, res) => {
    const id = nextRequestId();
    const method = getRpcMethod(req.url);
    const upstreamHost = req.socket && mitmUpstreamHost.get(req.socket);

    if (handleMitmHealthRoute(req, res, { mitmUpstreamHost, MITM_ENABLED, MITM_CERT_FINGERPRINT })) {
      return;
    }

    const chunks = [];
    req.on('error', err => {
      console.error(`[${now()}] #${id} MITM REQ ERROR: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    });
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (handleCursorRequest(req, res, body, {
        id,
        source: 'mitm',
        upstreamHost,
        log: (line) => console.log(`[${now()}] #${id} ${line}`),
      })) {
        return;
      }

      if (handleCommonCodeiumAndChatRoutes(req, res, body, {
        id,
        method,
        source: 'mitm',
        client: upstreamHost && upstreamHost.includes('windsurf') ? 'windsurf' : 'devin',
        BLOCKED_TELEMETRY_METHODS,
        rpcAuditLog,
        buildPreflightOkResponse,
        shouldIntercept,
        makeUnaryResponseCollector,
        createTracker,
        handleGetChatMessage,
      })) {
        return;
      }

      if (method === 'GetUserStatus') {
        statusLog.sample(id, method, body.length);
      } else {
        console.log(`[${now()}] #${id} → MITM ${method || req.url.slice(0, 80)} (${body.length}b) → Codeium`);
      }
      proxyToCodeium(req, res, body, id, { skipRewrite: true, source: 'mitm' });
    });
  });
}

export function startAntigravityHttpsEndpoint({ CERTS_DIR, handleRequest, intEnv }) {
  const keyPath = fileURLToPath(new URL('mitm-leaf-key.pem', CERTS_DIR));
  const certPath = fileURLToPath(new URL('mitm-leaf.pem', CERTS_DIR));
  try {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      console.error('[antigravity-https] 证书缺失，跳过 HTTPS 端点');
      return;
    }
    const httpsServer = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      handleRequest,
    );
    const httpsPort = intEnv('ANTIGRAVITY_HTTPS_PORT', 7452, 1);
    httpsServer.on('error', err => console.error(`[antigravity-https] 监听 ${httpsPort} 失败: ${err.message}`));
    httpsServer.listen(httpsPort, '127.0.0.1', () => {
      console.error(`[antigravity-https] 已就绪: https://localhost:${httpsPort}`);
    });
  } catch (e) {
    console.error(`[antigravity-https] 启动异常: ${e.message}`);
  }
}

