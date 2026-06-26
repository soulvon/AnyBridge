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
import os from 'node:os';
import crypto from 'node:crypto';
import { listenWithReclaim } from './port-utils.js';
import { handleGetChatMessage, shouldIntercept } from './handlers/chat.js';
import { handleLocalProxyRequest, isLocalProxyRequest } from './local-proxy.js';
import { injectPatches, listTargets, isAlreadyInjected, readInjectableModels } from './lib/codex-desktop-cdp.js';
import { parseFields, writeStringField, writeBytesField, writeVarintField } from './proto.js';
import { tryGunzip } from './connect.js';
import { snapshot } from './stats.js';
import { extractModelList, unlockModels } from './rename-models.js';
import { mitmLog, rpcAuditLog } from './mitm-logger.js';
import { httpsAgentFor } from './system-proxy.js';

function intEnv(name, fallback, min = 1) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const PORT = intEnv('API_PORT', 7450, 1);
const DEBUG_IMAGES = /^(true|1|on)$/i.test(String(process.env.BYOK_DEBUG_IMAGES || 'false'));
const PROXY_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: intEnv('BYOK_PROXY_MAX_SOCKETS', 64, 1),
  maxFreeSockets: intEnv('BYOK_PROXY_MAX_FREE_SOCKETS', 16, 1),
});

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(os.homedir(), 'AppData', 'Roaming', name);
}

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

// MITM 连接的上游主机映射：记录每个 TLS socket 对应的原始 CONNECT 目标。
// Devin 连 server.codeium.com，Windsurf 连 server.self-serve.windsurf.com，
// 代理需要转发到各自的真实上游，不能一律发到 windsurf.com。
const mitmUpstreamHost = new WeakMap();

// 高频 GetUserStatus 去重：每 10s 至少只写一次 ide-models.json，
// 每 5s 至少只打一次相关日志。避免每秒 8-10 次心跳把磁盘 IO 打满。
let lastModelListSig = '';
let lastModelListCapturedAt = 0;
let lastModelCaptureLogAt = 0;
let lastModelRewriteLogAt = 0;
// unlockModels 结果缓存：同一秒内输入相同 → 复用上次结果
let lastUnlockInputSig = '';
let lastUnlockResult = null;

function hashModelList(list) {
  // 短签名：modelUid + label。够用——下游关心的是"清单是否变化"。
  try {
    const h = crypto.createHash('sha1');
    for (const m of list) h.update(`${m.modelUid || ''}|${m.label || ''}\n`);
    return h.digest('hex').slice(0, 16);
  } catch {
    return String(Date.now());
  }
}

function writeCapturedModelList(file, list) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = {};
  }

  const existingByUid = new Map();
  for (const item of (Array.isArray(existing.models) ? existing.models : [])) {
    if (item && item.modelUid) existingByUid.set(item.modelUid, item);
  }

  const models = list.map(item => {
    const prev = existingByUid.get(item.modelUid) || {};
    const out = {
      modelUid: item.modelUid,
      label: item.label || item.modelUid,
    };
    const apiId = item.apiId || prev.apiId;
    if (apiId) out.apiId = apiId;
    return out;
  });

  const next = {
    capturedAt: Date.now(),
    source: 'captured',
    models,
  };
  if (Array.isArray(existing.accountModelIds)) next.accountModelIds = existing.accountModelIds;
  if (existing.account && typeof existing.account === 'object') next.account = existing.account;
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

function rewriteConfigSignature() {
  const dir = configDir();
  return ['model-map.json', 'providers.json', 'ide-models.json']
    .map((name) => {
      try {
        const s = fs.statSync(path.join(dir, name));
        return `${name}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${name}:missing`;
      }
    })
    .join('|');
}

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

function sanitizeProxyRequestHeaders(headers, body) {
  const out = { ...headers };
  delete out.host;
  delete out.connection;
  delete out['proxy-connection'];
  delete out['keep-alive'];
  delete out.te;
  delete out.trailer;
  delete out.upgrade;
  delete out['transfer-encoding'];
  delete out['content-length'];
  if (body && body.length > 0) out['content-length'] = String(body.length);
  return out;
}

function sanitizeProxyResponseHeaders(headers, opts = {}) {
  const out = { ...headers };
  delete out.connection;
  delete out['proxy-connection'];
  delete out['keep-alive'];
  delete out.te;
  delete out.trailer;
  delete out.upgrade;
  delete out['transfer-encoding'];
  delete out['content-length'];
  if (opts.stripEncoding) {
    delete out['content-encoding'];
    delete out['connect-content-encoding'];
  }
  if (opts.contentLength !== undefined) out['content-length'] = String(opts.contentLength);
  return out;
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

// ─── BYOK preflight allowance: synthesize successful local capacity checks ──
// These preflight RPCs are answered locally so configured BYOK chat routing can continue:
//
// 1. CheckUserMessageRateLimitResponse (exa.api_server_pb)
//    Proto shape observed from the client schema:
//      field 1: hasCapacity (bool)
//      field 2: message (string)
//      field 3: messagesRemaining (int32)
//      field 4: maxMessages (int32)
//      field 5: resetsInSeconds (int64)
//
// 2. CheckChatCapacityResponse (exa.language_server_pb)
//    Proto 结构：
//      field 1: has_capacity (bool)
//      field 2: message (string)
//      field 3: active_sessions (int32)
//
// BYOK 模式下用自己的 API，不走 Codeium 配额，所以直接返回 hasCapacity=true。
// Proto3 默认值不编码（false/0/"" 不序列化），所以只编码非零字段即可。
function buildPreflightOkResponse(method) {
  // hasCapacity = true → field 1, wire type 0 (varint), value = 1
  const hasCapacity = writeVarintField(1, 1);
  if (method === 'CheckChatCapacity') {
    // activeSessions = 0 → proto3 默认值不编码
    return Buffer.concat([hasCapacity]);
  }
  // CheckUserMessageRateLimit: 加上 messagesRemaining 和 maxMessages
  // messagesRemaining = 9999 → field 3, wire type 0 (varint)
  const messagesRemaining = writeVarintField(3, 9999);
  // maxMessages = 9999 → field 4, wire type 0 (varint)
  const maxMessages = writeVarintField(4, 9999);
  return Buffer.concat([hasCapacity, messagesRemaining, maxMessages]);
}

const PREFLIGHT_ALLOW_METHODS = new Set(['CheckUserMessageRateLimit', 'CheckChatCapacity']);

const STREAMING_METHODS = new Set([
  'GetStreamingCompletions',
  'GetStreamingExternalChatCompletions',
]);

// ─── Forward request to real Codeium ──────────────────────

function proxyToCodeium(req, res, body, id, opts = {}) {
  const method = getRpcMethod(req.url);
  // MITM 模式下优先使用 socket 记录的上游主机（Devin: server.codeium.com, Windsurf: server.self-serve.windsurf.com）
  const socketUpstream = req.socket && mitmUpstreamHost.get(req.socket);
  const upstream = opts.upstream || socketUpstream || getUpstreamHost(req.url);
  const upstreamPath = stripRoutePrefix(req.url);
  const isStreaming = STREAMING_METHODS.has(method);
  const source = opts.source || 'http';

  rpcAuditLog({
    id,
    phase: 'request',
    source,
    route: 'codeium',
    method,
    url: req.url,
    upstream,
    upstreamPath,
    requestBytes: body ? body.length : 0,
  });

  // Forward headers — swap host and normalize body framing.
  // Node rejects responses/requests that carry both Content-Length and Transfer-Encoding.
  const fwdHeaders = sanitizeProxyRequestHeaders(req.headers, body);
  fwdHeaders.host = upstream;

  const proxyReq = https.request({
    agent: httpsAgentFor(PROXY_HTTPS_AGENT),
    hostname: upstream,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: fwdHeaders,
  }, (proxyRes) => {

    if (isStreaming) {
      // Pipe streaming responses through
      console.log(`  [#${id}] ← ${proxyRes.statusCode} (streaming ${method})`);
      let responseBytes = 0;
      proxyRes.on('data', c => { responseBytes += c.length; });
      // MITM 日志：GetChatMessage 透传到 Codeium 时记录
      if (method === 'GetChatMessage') {
        mitmLog({ direction: 'upstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` } });
      }
      res.writeHead(proxyRes.statusCode, sanitizeProxyResponseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
      // 透传的 GetChatMessage 响应日志
      proxyRes.on('end', () => {
        rpcAuditLog({
          id,
          phase: 'response',
          source,
          route: 'codeium',
          method,
          url: req.url,
          upstream,
          upstreamPath,
          statusCode: proxyRes.statusCode,
          responseBytes,
        });
        if (method === 'GetChatMessage') {
          mitmLog({ direction: 'downstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` }, response: { statusCode: proxyRes.statusCode } });
        }
      });
    } else {
      // Buffer unary responses
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        let resBody = Buffer.concat(chunks);
        console.log(`  [#${id}] ← ${proxyRes.statusCode} (${resBody.length}b)`);
        rpcAuditLog({
          id,
          phase: 'response',
          source,
          route: 'codeium',
          method,
          url: req.url,
          upstream,
          upstreamPath,
          statusCode: proxyRes.statusCode,
          responseBytes: resBody.length,
        });
        // MITM 日志：GetChatMessage 透传（非流式分支）
        if (method === 'GetChatMessage') {
          mitmLog({ direction: 'upstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` } });
          mitmLog({ direction: 'downstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` }, response: { statusCode: proxyRes.statusCode, body: resBody.length <= 4096 ? resBody.toString('utf8') : `[${resBody.length}b]` } });
        }

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

        // 改写 GetUserStatus 响应（合并三件事：label 改名 + 注入项 + 全部解锁）。
        // 阶段 4 改造后，unlockModels 一次性完成以下职责：
        //   - 槽位改名（model-map.json 的 slots.displayName + namePrefix）
        //   - 注入项（model-map.json 的 injected）→ label 改写为 "(BYOK) {label} (服务商/未配置)" + 解锁
        //   - 全部解锁（删 field4 disabled = true）让下拉框灰色项可点
        // 调用方仅需一次，替代之前 renameModels + unlockModels 两次调用。
        let stripEncoding = false;
        if (method === 'GetUserStatus' && proxyRes.statusCode === 200) {
          // 抓取原始模型清单(改名前)→ 缓存供 GUI 添加映射时选用。
          // 性能优化：每秒 8-10 次心跳 → 节流到 30s 一次 + 签名比对
          // 注意：unlockModels 仍然每次都做（必须做，下拉框要看到 BYOK 项）
          const shouldCapture = (Date.now() - lastModelListCapturedAt) > 30000;
          if (shouldCapture) {
            try {
              const list = extractModelList(resBody);
              if (list && list.length) {
                const dir = process.env.BYOK_CONFIG_DIR;
                if (dir) {
                  const file = path.join(dir, 'ide-models.json');
                  const sig = hashModelList(list);
                  if (sig !== lastModelListSig) {
                    lastModelListSig = sig;
                    writeCapturedModelList(file, list);
                    console.log(`  [#${id}] 📋 captured ${list.length} Windsurf models → ide-models.json`);
                  }
                }
              }
              lastModelListCapturedAt = Date.now();
            } catch (e) {
              console.error(`  [#${id}] capture models error: ${e.message}`);
            }
          }
          try {
            // 节流：unlockModels 是个 protobuf 完整改写。每秒 8-10 次心跳 → 1s 内只跑一次
            // 用 resBody 的 sha1 短路——同一秒内上游响应没变，直接复用上次结果
            const inputSig = `${crypto.createHash('sha1').update(resBody).digest('hex').slice(0, 16)}|${rewriteConfigSignature()}`;
            if (inputSig === lastUnlockInputSig && lastUnlockResult) {
              resBody = lastUnlockResult.body;
              if (lastUnlockResult.wasConnect) stripEncoding = true;
            } else {
              const result = unlockModels(resBody);
              if (result) {
                resBody = result.body;
                if (result.wasConnect) stripEncoding = true;
                lastUnlockResult = result;
                lastUnlockInputSig = inputSig;
                // 5s 内只打一次 rewrite 日志
                if (Date.now() - lastModelRewriteLogAt > 5000) {
                  console.log(`  [#${id}] 🔄 rewrote ${result.changed} model(s) (rename+unlock+inject)`);
                  lastModelRewriteLogAt = Date.now();
                }
              }
            }
          } catch (e) {
            console.error(`  [#${id}] rewrite models error: ${e.message}`);
          }
        }

        const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
          stripEncoding,
          contentLength: resBody.length,
        });
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(resBody);
      });
      proxyRes.on('error', (err) => {
        console.error(`  [#${id}] ← error: ${err.message}`);
        rpcAuditLog({
          id,
          phase: 'error',
          source,
          route: 'codeium',
          method,
          url: req.url,
          upstream,
          upstreamPath,
          error: err.message,
        });
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end();
      });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`  [#${id}] ✗ upstream: ${err.message}`);
    rpcAuditLog({
      id,
      phase: 'error',
      source,
      route: 'codeium',
      method,
      url: req.url,
      upstream,
      upstreamPath,
      requestBytes: body ? body.length : 0,
      error: err.message,
    });
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

  // -- BYOK control endpoint: injection module version (no body) --
  if (req.url.split('?')[0] === '/__byok/codex-cdp/version') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, version: '20260627-v6-proven', patchKey: '__ccSwitchCodexModelPickerUnlockV6' }));
    return;
  }

  // ── BYOK control endpoint: Codex Desktop CDP status (no body) ──
  if (req.url.split('?')[0] === '/__byok/codex-cdp/status') {
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

    // ── BYOK control endpoint: inject CDP patches into Codex Desktop ──
    if (req.url === '/__byok/codex-cdp/inject' && req.method === 'POST') {
      (async () => {
        try {
          const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
          const port = parseInt(payload.port || '9229', 10);
          const models = Array.isArray(payload.models) && payload.models.length
            ? payload.models
            : readInjectableModels();
          // models_cache.json 由 Rust write_models_cache 在 Codex 启动前写入
          //（带 anybridge_managed 标记、slug 无前缀）。此处不再写 models_cache：
          // CDP inject 发生在 Codex 启动之后，启动后改 models_cache 对已加载的 Desktop
          // 无效，且会与 Rust 注入产生重复/前缀不一致的条目（历史 bug 根因）。
          console.log(`[${now()}] #${id} CDP inject → port ${port}, ${models.length} models`);
          const result = await injectPatches(port, models);
          res.writeHead(result.ok ? 200 : 502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[${now()}] #${id} CDP inject error: ${err.message}`);
          res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: false, message: err.message || String(err) }));
        }
      })();
      return;
    }

    // ── BYOK control endpoint: check if CDP injection is present ──
    if (req.url === '/__byok/codex-cdp/check' && req.method === 'POST') {
      (async () => {
        try {
          const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
          const port = parseInt(payload.port || '9229', 10);
          const injected = await isAlreadyInjected(port);
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: true, injected }));
        } catch (err) {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: true, injected: false, error: err.message }));
        }
      })();
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

    // ── Telemetry blocking: 返回空 200，不转发到服务端 ──
    if (BLOCKED_TELEMETRY_METHODS.has(method)) {
      console.log(`[${now()}] #${id} 🚫 ${method} → blocked`);
      rpcAuditLog({
        id,
        phase: 'blocked',
        source: 'http',
        route: 'blocked',
        method,
        url: req.url,
        requestBytes: body.length,
        statusCode: 200,
        responseBytes: 0,
      });
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end();
      return;
    }

    // BYOK preflight allowance: return a successful local capacity response.
    if (PREFLIGHT_ALLOW_METHODS.has(method)) {
      console.log(`[${now()}] #${id} ${method} -> local preflight ok`);
      const protoBody = buildPreflightOkResponse(method);
      const frame = Buffer.alloc(5 + protoBody.length);
      frame[0] = 0; // flags
      frame.writeUInt32BE(protoBody.length, 1);
      protoBody.copy(frame, 5);
      rpcAuditLog({
        id,
        phase: 'intercepted',
        source: 'http',
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
      return;
    }

    // ── Intercept: GetChatMessage → Anthropic API ──
    // TODO: GetWebSearchResults / GetWebSearchRedirect — currently forwarded to
    // Codeium, but can be intercepted here to route through own search API.
    if (method === 'GetChatMessage' && shouldIntercept(body, req.headers)) {
      console.log(`[${now()}] #${id} ⚡ GetChatMessage → Anthropic API (${body.length}b)`);
      rpcAuditLog({
        id,
        phase: 'intercepted',
        source: 'http',
        route: 'byok',
        method,
        url: req.url,
        requestBytes: body.length,
      });
      if (DEBUG_IMAGES) {
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
      }
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
    if (method === 'GetUserStatus') {
      statusLog.sample(id, method, body.length);
    } else {
      console.log(`[${now()}] #${id} → ${method || req.url.slice(0, 80)} (${body.length}b) → Codeium`);
    }
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
      rpcAuditLog({
        id,
        phase: 'blocked',
        source: 'mitm',
        route: 'blocked',
        method,
        url: req.url,
        requestBytes: body.length,
        statusCode: 200,
        responseBytes: 0,
      });
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end();
      return;
    }

    // BYOK preflight allowance: return a successful local capacity response.
    if (PREFLIGHT_ALLOW_METHODS.has(method)) {
      console.log(`[${now()}] #${id} MITM ${method} -> local preflight ok`);
      const protoBody = buildPreflightOkResponse(method);
      const frame = Buffer.alloc(5 + protoBody.length);
      frame[0] = 0;
      frame.writeUInt32BE(protoBody.length, 1);
      protoBody.copy(frame, 5);
      rpcAuditLog({
        id,
        phase: 'intercepted',
        source: 'mitm',
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
      return;
    }

    // ── THE INTERCEPTION: GetChatMessage → Anthropic API ──
    if (method === 'GetChatMessage' && shouldIntercept(body, req.headers)) {
      console.log(`[${now()}] #${id} ⚡ MITM GetChatMessage → Anthropic (${body.length}b)`);
      rpcAuditLog({
        id,
        phase: 'intercepted',
        source: 'mitm',
        route: 'byok',
        method,
        url: req.url,
        requestBytes: body.length,
      });
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
    // 高频心跳 GetUserStatus 不刷日志：每秒 8-10 条 → 仅每 N 条采样一次
    if (method === 'GetUserStatus') {
      statusLog.sample(id, method, body.length);
    } else {
      console.log(`[${now()}] #${id} → MITM ${method || req.url.slice(0, 80)} (${body.length}b) → Codeium`);
    }
    proxyToCodeium(req, res, body, id, { skipRewrite: true, source: 'mitm' });
  });
});

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

// ─── CONNECT tunnel handler ───────────────────────────────
// Two modes:
//   1. server.codeium.com → MITM: terminate TLS, parse HTTP, intercept GetChatMessage
//   2. Everything else    → Blind TCP pipe (login, telemetry, marketplace, etc.)

server.on('connect', (req, clientSocket, head) => {
  const id = ++requestCounter;
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;

  // ── MITM for API hosts (Windsurf: server.self-serve.windsurf.com, Devin: server.codeium.com)
  const MITM_HOSTS = new Set([REAL_API_HOST, 'server.codeium.com']);
  if (MITM_HOSTS.has(host) && MITM_CERT && MITM_KEY) {
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
  console.log(`\n   MITM → server.codeium.com:443`);
  console.log(`     GetChatMessage  → Anthropic API (your models, your key)`);
  console.log(`     Everything else → real Codeium (trial account)`);
  console.log(`\n   LOCAL COMPATIBLE API:`);
  console.log(`     OpenAI  -> http://localhost:${PORT}/v1`);
  console.log(`     Claude  -> http://localhost:${PORT}/anthropic`);

  console.log(`\n   PASSTHROUGH (blind TCP pipe):`);
  console.log(`     All other CONNECT targets (login, telemetry, marketplace)`);
  console.log(`\n   Settings needed:`);
  console.log(`     "http.proxy": "http://localhost:${PORT}"`);
  console.log(`     "http.proxyStrictSSL": false\n`);
}

listenWithReclaim(server, PORT, logBanner, 'hybrid');

