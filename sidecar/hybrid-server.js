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
import { listenWithReclaim } from './port-utils.js';
import { handleGetChatMessage, shouldIntercept } from './handlers/chat.js';
import { parseFields, writeStringField, writeBytesField } from './proto.js';
import { tryGunzip } from './connect.js';
import { snapshot } from './stats.js';
import { renameModels, extractModelList, unlockModels } from './rename-models.js';

const PORT = parseInt(process.env.API_PORT || '7450', 10);

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

// ─── MITM certs for server.codeium.com (optional — not needed behind nginx) ──
// Priority: BYOK_CONFIG_DIR/certs (user-generated) → BYOK_RESOURCE_DIR/certs → ../certs
function resolveCertsDir() {
  const toUrl = (p) => new URL(`file://${p.replace(/\\/g, '/')}/certs/`);
  if (process.env.BYOK_CONFIG_DIR) return toUrl(process.env.BYOK_CONFIG_DIR);
  if (process.env.BYOK_RESOURCE_DIR) return toUrl(process.env.BYOK_RESOURCE_DIR);
  return new URL('../certs/', import.meta.url);
}
const CERTS_DIR = resolveCertsDir();
let MITM_CERT, MITM_KEY;
try {
  MITM_CERT = fs.readFileSync(new URL('server.codeium.com.pem', CERTS_DIR));
  MITM_KEY = fs.readFileSync(new URL('server.codeium.com-key.pem', CERTS_DIR));
} catch {
  console.log('⚠️  No MITM certs found — CONNECT MITM disabled (OK if behind nginx)');
}

let requestCounter = 0;

// ─── Helpers ──────────────────────────────────────────────

function getRpcMethod(url) {
  const parts = url.split('/');
  return parts[parts.length - 1] || '';
}

function getUpstreamHost(url) {
  if (url.includes('unleash') || url.includes('experiment_config')) {
    return REAL_UNLEASH_HOST;
  }
  return REAL_API_HOST;
}

// Windsurf Secure adds /_route/api_server prefix; real server doesn't use it
function stripRoutePrefix(url) {
  return url.replace(/^\/_route\/api_server/, '');
}

function now() {
  return new Date().toISOString().slice(11, 23);
}

// ─── Varint encoder (for protobuf rewrite) ────────────────

function encodeVarintBuf(value) {
  const bytes = [];
  let v = BigInt(value);
  if (v < 0n) v = v + (1n << 64n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

// ─── Rewrite RegisterUser response ────────────────────────
// Replace api_server_url (field 3) so extension keeps talking to us

function rewriteRegisterUser(protoBuf) {
  try {
    const fields = parseFields(protoBuf);
    const parts = [];
    for (const f of fields) {
      if (f.field === 3 && f.wireType === 2) {
        const origUrl = f.value.toString('utf8');
        console.log(`  🔄 RegisterUser: ${origUrl} → http://localhost:${PORT}`);
        parts.push(writeStringField(3, `http://localhost:${PORT}`));
      } else if (f.wireType === 0) {
        parts.push(Buffer.concat([
          Buffer.from([(f.field << 3) | 0]),
          encodeVarintBuf(f.value),
        ]));
      } else if (f.wireType === 2) {
        parts.push(writeBytesField(f.field, f.value));
      } else if (f.wireType === 1) {
        const tag = Buffer.from([(f.field << 3) | 1]);
        parts.push(Buffer.concat([tag, f.value]));
      } else if (f.wireType === 5) {
        const tag = Buffer.from([(f.field << 3) | 5]);
        parts.push(Buffer.concat([tag, f.value]));
      }
    }
    return Buffer.concat(parts);
  } catch (e) {
    console.error(`  ❌ RegisterUser rewrite failed: ${e.message}`);
    return protoBuf;
  }
}

// ─── Streaming RPCs that need to be piped through ─────────

const STREAMING_METHODS = new Set([
  'GetStreamingCompletions',
  'GetStreamingExternalChatCompletions',
]);

// ─── Forward request to real Codeium ──────────────────────

function proxyToCodeium(req, res, body, id, opts = {}) {
  const method = getRpcMethod(req.url);
  const upstream = getUpstreamHost(req.url);
  const upstreamPath = stripRoutePrefix(req.url);
  const isStreaming = STREAMING_METHODS.has(method);

  // Forward headers — swap host, drop connection
  const fwdHeaders = { ...req.headers };
  delete fwdHeaders.host;
  delete fwdHeaders.connection;
  fwdHeaders.host = upstream;

  const proxyReq = https.request({
    hostname: upstream,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: fwdHeaders,
  }, (proxyRes) => {

    if (isStreaming) {
      // Pipe streaming responses through
      console.log(`  [#${id}] ← ${proxyRes.statusCode} (streaming ${method})`);
      res.writeHead(proxyRes.statusCode, { ...proxyRes.headers });
      proxyRes.pipe(res);
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
    } else {
      // Buffer unary responses
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        let resBody = Buffer.concat(chunks);
        console.log(`  [#${id}] ← ${proxyRes.statusCode} (${resBody.length}b)`);

        // Rewrite RegisterUser to keep extension pointed at us (HTTP mode only)
        if (!opts.skipRewrite && method === 'RegisterUser' && proxyRes.statusCode === 200 && resBody.length > 5) {
          try {
            const flags = resBody[0];
            const msgLen = resBody.readUInt32BE(1);
            if (msgLen === resBody.length - 5 && flags <= 1) {
              let payload = resBody.subarray(5);
              if (flags === 1) {
                const d = tryGunzip(payload);
                if (d) payload = d;
              }
              const rewritten = rewriteRegisterUser(payload);
              const envelope = Buffer.alloc(5 + rewritten.length);
              envelope[0] = 0;
              envelope.writeUInt32BE(rewritten.length, 1);
              rewritten.copy(envelope, 5);
              resBody = envelope;
              console.log(`  [#${id}] 🔄 RegisterUser rewritten`);
            }
          } catch (e) {
            console.error(`  [#${id}] RegisterUser rewrite error: ${e.message}`);
          }
        }

        // 改写 GetUserStatus 响应里的模型显示名（下拉框 label）。
        let stripEncoding = false;
        if (method === 'GetUserStatus' && proxyRes.statusCode === 200) {
          // 抓取原始模型清单(改名前)→ 缓存供 GUI 添加映射时选用。
          try {
            const list = extractModelList(resBody);
            if (list && list.length) {
              const dir = process.env.BYOK_CONFIG_DIR;
              if (dir) {
                const file = path.join(dir, 'ide-models.json');
                fs.writeFileSync(file, JSON.stringify({ capturedAt: Date.now(), models: list }, null, 2));
                console.log(`  [#${id}] 📋 captured ${list.length} Windsurf models → ide-models.json`);
              }
            }
          } catch (e) {
            console.error(`  [#${id}] capture models error: ${e.message}`);
          }
          try {
            const renamed = renameModels(resBody);
            if (renamed) {
              resBody = renamed.body;
              // Connect 帧被改成未压缩帧时清压缩头；gzip/plain 保持原编码。
              if (renamed.wasConnect) stripEncoding = true;
              console.log(`  [#${id}] 🏷️  renamed ${renamed.changed} model label(s)`);
            }
          } catch (e) {
            console.error(`  [#${id}] rename models error: ${e.message}`);
          }
          // 模型解锁：将 BYOK 槽位模型的 disabled=true 改为 disabled=false。
          try {
            const unlocked = unlockModels(resBody);
            if (unlocked) {
              resBody = unlocked.body;
              if (unlocked.wasConnect) stripEncoding = true;
              console.log(`  [#${id}] 🔓 unlocked ${unlocked.changed} model(s)`);
            }
          } catch (e) {
            console.error(`  [#${id}] unlock models error: ${e.message}`);
          }
        }

        const resHeaders = { ...proxyRes.headers };
        if (stripEncoding) {
          delete resHeaders['content-encoding'];
          delete resHeaders['connect-content-encoding'];
        }
        delete resHeaders['content-length'];
        resHeaders['content-length'] = resBody.length;
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(resBody);
      });
      proxyRes.on('error', (err) => {
        console.error(`  [#${id}] ← error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end();
      });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`  [#${id}] ✗ upstream: ${err.message}`);
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end(`Upstream error: ${err.message}`);
  });

  proxyReq.end(body);
}

// ─── Main request handler ─────────────────────────────────

function handleRequest(req, res) {
  const id = ++requestCounter;
  const method = getRpcMethod(req.url);

  // ── BYOK control endpoint: stats snapshot (local UI only) ──
  if (req.url === '/__byok/stats') {
    const payload = JSON.stringify(snapshot());
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(payload);
    return;
  }

  const chunks = [];
  req.on('error', err => {
    console.error(`[${now()}] #${id} REQ ERROR: ${err.message}`);
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // ── Web/OAuth redirects → real Windsurf servers ──
    if (req.url.startsWith('/profile') || req.url.startsWith('/login') ||
        req.url.startsWith('/signup') || req.url.startsWith('/redirect/') ||
        req.url.startsWith('/changelog') || req.url === '/favicon.ico') {
      console.log(`[${now()}] #${id} → redirect ${req.url}`);
      res.writeHead(302, { location: `https://${REAL_WEBSITE}${req.url}` });
      return res.end();
    }

    if (req.url.includes('prompt=login') || req.url.includes('scope=openid') ||
        req.url.includes('authorize') || req.url.includes('client_id=codeium')) {
      console.log(`[${now()}] #${id} → auth redirect`);
      res.writeHead(302, { location: `https://${REAL_REGISTER_HOST}${req.url}` });
      return res.end();
    }

    // ── Telemetry blocking: 返回空 200，不转发到服务端 ──
    if (BLOCKED_TELEMETRY_METHODS.has(method)) {
      console.log(`[${now()}] #${id} 🚫 ${method} → blocked`);
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end();
      return;
    }

    // ── Intercept: GetChatMessage → Anthropic API ──
    // TODO: GetWebSearchResults / GetWebSearchRedirect — currently forwarded to
    // Codeium, but can be intercepted here to route through own search API.
    if (method === 'GetChatMessage' && shouldIntercept(body, req.headers)) {
      console.log(`[${now()}] #${id} ⚡ GetChatMessage → Anthropic API (${body.length}b)`);
      try {
        const result = handleGetChatMessage(req, res, body);
        if (result && typeof result.catch === 'function') {
          result.catch(err => {
            console.error(`[${now()}] #${id} Chat error: ${err.message}`);
            if (!res.headersSent) res.writeHead(500);
            if (!res.writableEnded) res.end();
          });
        }
      } catch (err) {
        console.error(`[${now()}] #${id} Chat error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // ── Everything else → forward to real Codeium ──
    console.log(`[${now()}] #${id} → ${method || req.url.slice(0, 80)} (${body.length}b) → Codeium`);
    proxyToCodeium(req, res, body, id);
  });
}

// ─── Server ───────────────────────────────────────────────

const server = http.createServer(handleRequest);

// ─── MITM internal server (handles decrypted traffic) ─────
// This server is NEVER bound to a port. We manually emit 'connection'
// events with TLS-unwrapped sockets from the CONNECT handler.

const mitmServer = http.createServer((req, res) => {
  const id = ++requestCounter;
  const method = getRpcMethod(req.url);

  const chunks = [];
  req.on('error', err => {
    console.error(`[${now()}] #${id} MITM REQ ERROR: ${err.message}`);
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // ── Telemetry blocking ──
    if (BLOCKED_TELEMETRY_METHODS.has(method)) {
      console.log(`[${now()}] #${id} 🚫 MITM ${method} → blocked`);
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end();
      return;
    }

    // ── THE INTERCEPTION: GetChatMessage → Anthropic API ──
    if (method === 'GetChatMessage' && shouldIntercept(body, req.headers)) {
      console.log(`[${now()}] #${id} ⚡ MITM GetChatMessage → Anthropic (${body.length}b)`);
      try {
        const result = handleGetChatMessage(req, res, body);
        if (result && typeof result.catch === 'function') {
          result.catch(err => {
            console.error(`[${now()}] #${id} Chat error: ${err.message}`);
            if (!res.headersSent) res.writeHead(500);
            if (!res.writableEnded) res.end();
          });
        }
      } catch (err) {
        console.error(`[${now()}] #${id} Chat error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // ── Everything else → forward to real Codeium (skip RegisterUser rewrite) ──
    console.log(`[${now()}] #${id} → MITM ${method || req.url.slice(0, 80)} (${body.length}b) → Codeium`);
    proxyToCodeium(req, res, body, id, { skipRewrite: true });
  });
});

// ─── CONNECT tunnel handler ───────────────────────────────
// Two modes:
//   1. server.codeium.com → MITM: terminate TLS, parse HTTP, intercept GetChatMessage
//   2. Everything else    → Blind TCP pipe (login, telemetry, marketplace, etc.)

server.on('connect', (req, clientSocket, head) => {
  const id = ++requestCounter;
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;

  // ── MITM for server.codeium.com (only if certs loaded) ──
  if (host === REAL_API_HOST && MITM_CERT && MITM_KEY) {
    console.log(`[${now()}] #${id} 🔓 MITM ${host}:${targetPort}`);

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

    tlsSocket.on('secure', () => {
      console.log(`  [#${id}] 🔐 TLS established, ALPN=${tlsSocket.alpnProtocol || 'none'}`);
    });

    tlsSocket.on('error', (err) => {
      // Ignore ECONNRESET / EPIPE — client disconnected
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
      console.error(`  [#${id}] MITM TLS error: ${err.message}`);
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    // Feed the decrypted connection into our internal HTTP server
    mitmServer.emit('connection', tlsSocket);
    return;
  }

  // ── Everything else: blind TCP pipe ──
  console.log(`[${now()}] #${id} CONNECT ${host}:${targetPort}`);

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
  console.log(`\n   MITM → server.codeium.com:443`);
  console.log(`     GetChatMessage  → Anthropic API (your models, your key)`);
  console.log(`     Everything else → real Codeium (trial account)`);
  console.log(`\n   PASSTHROUGH (blind TCP pipe):`);
  console.log(`     All other CONNECT targets (login, telemetry, marketplace)`);
  console.log(`\n   Settings needed:`);
  console.log(`     "http.proxy": "http://localhost:${PORT}"`);
  console.log(`     "http.proxyStrictSSL": false\n`);
}

listenWithReclaim(server, PORT, logBanner, 'hybrid');
