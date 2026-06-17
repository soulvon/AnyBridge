// handlers/chat.js — GetChatMessage handler (orchestrator)
//
// Parses Windsurf's protobuf request → calls Anthropic Messages API → streams
// back Connect-RPC protobuf using the correct exa.api_server_pb schema.

import https from 'node:https';
import crypto from 'node:crypto';
import { parseGetChatMessageRequest } from './parse-request.js';
import { buildErrorChunk } from './build-response.js';
import { AnthropicStreamProcessor, parseSSEChunk } from './anthropic-stream.js';
import { OpenAIChatCompletionsStreamProcessor, OpenAIStreamProcessor, parseOpenAISSEChunk } from './openai-stream.js';
import { wrapEnvelope, endOfStreamEnvelope, endOfStreamErrorEnvelope, streamHeaders, gzipSync, unwrapRequest } from '../connect.js';
import { recordRequest, recordUsage, recordError, recordLatency } from '../stats.js';
import { getInjectedByUid, getSlot, loadProviders, resolveTarget, rememberProviderToolSchemaCompat, updateModelCapabilities } from '../provider-pool.js';
import { mitmLog } from '../mitm-logger.js';
import { getRuntimeModelSlotStatus } from '../rename-models.js';
import { httpsAgentFor } from '../system-proxy.js';

// ─── Config ────────────────────────────────────────────────

function intEnv(names, fallback, min = 0) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null || raw === '') continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= min) return n;
  }
  return fallback;
}

const MAX_TOKENS = intEnv('MAX_TOKENS', 16384, 1);
const UPSTREAM_TIMEOUT_MS = intEnv(['UPSTREAM_TIMEOUT_MS', 'API_TIMEOUT_MS'], 300000, 1000);
const RETRY_ENABLED = !/^(false|0|off)$/i.test(String(process.env.BYOK_RETRY || 'true'));
const RETRY_MAX = intEnv('BYOK_RETRY_MAX', 5, 0);
const RETRY_BASE_MS = intEnv('BYOK_RETRY_BASE_MS', 600, 1);
const RETRY_CAP_MS = intEnv('BYOK_RETRY_CAP_MS', 8000, 1);
const RETRY_TOTAL_MS = intEnv('BYOK_RETRY_TOTAL_MS', 60000, 0);
const NATIVE_STREAM_ERRORS = !/^(false|0|off)$/i.test(String(process.env.BYOK_NATIVE_ERRORS || 'true'));
const OPENAI_REASONING_EFFORT = String(process.env.BYOK_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || '').trim();
const OPENAI_REASONING_SUMMARY = String(process.env.BYOK_REASONING_SUMMARY || process.env.OPENAI_REASONING_SUMMARY || '').trim();
const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: intEnv('BYOK_MAX_SOCKETS', 64, 1),
  maxFreeSockets: intEnv('BYOK_MAX_FREE_SOCKETS', 16, 1),
});
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_NETWORK', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED',
]);

function retryAfterMs(headers = {}) {
  const raw = headers['retry-after'];
  if (!raw) return 0;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const seconds = parseInt(val, 10);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_CAP_MS);
  const at = Date.parse(val);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_CAP_MS);
  return 0;
}

function isRetryableFailure(reason, meta = {}) {
  if (!RETRY_ENABLED) return false;
  if (meta.statusCode) return RETRYABLE_STATUS.has(meta.statusCode);
  if (meta.code) return RETRYABLE_CODES.has(meta.code);
  return /timeout|reset|socket hang up|econn|epipe|network|dns|eai_again/i.test(String(reason || ''));
}

function retryDelayMs(attempt, meta = {}) {
  const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.max(Math.random() * exp, retryAfterMs(meta.headers));
}

function clampText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function extractUpstreamMessage(body) {
  if (!body) return '';
  const raw = String(body).trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    const msg = json?.error?.message
      || json?.error?.detail
      || json?.message
      || json?.detail
      || (typeof json?.error === 'string' ? json.error : '');
    if (msg) return clampText(msg.replace(/\s*\(request id:[^)]+\)/ig, ''));
  } catch {
    // Non-JSON provider bodies are still useful if they are short.
  }
  return clampText(raw.replace(/\s*\(request id:[^)]+\)/ig, ''));
}

function summarizeProviderMessage(message) {
  const text = clampText(message, 180);
  if (!text) return '';
  if (/无可用渠道|no available channel/i.test(text)) return '该中转当前没有可用渠道';
  if (/insufficient|quota|余额|额度|balance/i.test(text)) return '额度或余额不足';
  if (/invalid api key|unauthorized|认证|鉴权|api key/i.test(text)) return 'API Key 无效或已过期';
  if (/permission|forbidden|not allowed|无权限|未开通/i.test(text)) return '没有该模型权限或尚未开通';
  if (/model.*not found|does not exist|模型.*不存在|unknown model/i.test(text)) return '模型名不可用或未开通';
  if (/rate limit|too many requests|限流|频率/i.test(text)) return '触发上游限流';
  if (/overloaded|temporarily|service unavailable|维护|不可用/i.test(text)) return '上游服务暂时不可用';
  return text;
}

function targetLabel(failure = {}) {
  const provider = failure.providerName || failure.providerId || '未知供应商';
  const model = failure.model ? ` / ${failure.model}` : '';
  return `「${provider}${model}」`;
}

function failureSummary(failure = {}) {
  const status = failure.statusCode ? `返回 HTTP ${failure.statusCode}` : `失败：${failure.reason || failure.code || '未知错误'}`;
  const upstream = summarizeProviderMessage(extractUpstreamMessage(failure.body));
  return `${targetLabel(failure)} ${status}${upstream ? `（${upstream}）` : ''}`;
}

function failureLogLine(failure = {}) {
  const upstream = summarizeProviderMessage(extractUpstreamMessage(failure.body));
  return `${failure.providerName || failure.providerId || 'provider'}: ${failure.reason || failure.code || 'failed'}${upstream ? ` (${upstream})` : ''}`;
}

function failureHint(failures = []) {
  const text = failures.map(f => `${f.reason || ''} ${extractUpstreamMessage(f.body)}`).join(' ');
  if (failures.some(f => f.statusCode === 401) || /unauthorized|invalid api key|api key|认证|鉴权/i.test(text)) {
    return '请检查 API Key、账户状态和模型权限。';
  }
  if (failures.some(f => f.statusCode === 403) || /permission|forbidden|无权限|未开通/i.test(text)) {
    return '请检查模型权限，或换一个已开通的模型。';
  }
  if (failures.some(f => f.statusCode === 429) || /rate limit|too many requests|限流|频率/i.test(text)) {
    return '请稍后重试，或降低并发/换备用供应商。';
  }
  if (/无可用渠道|no available channel/i.test(text)) {
    return '请切换模型/供应商，或在模型映射里添加备用目标。';
  }
  if (failures.some(f => ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(f.code))) {
    return '请检查网络、代理和 API Host 配置。';
  }
  return '请稍后重试，或在模型映射里添加备用目标。';
}

function connectCodeForFailures(failures = []) {
  if (failures.some(f => f.statusCode === 401)) return 'unauthenticated';
  if (failures.some(f => f.statusCode === 403)) return 'permission_denied';
  if (failures.some(f => f.statusCode === 429)) return 'resource_exhausted';
  if (failures.some(f => f.statusCode === 408 || f.statusCode === 504 || f.code === 'ETIMEDOUT')) return 'deadline_exceeded';
  if (failures.some(f => f.statusCode >= 500 || f.code)) return 'unavailable';
  return 'invalid_argument';
}

function providerFailureMessage(failures = []) {
  if (failures.length === 0) {
    return 'BYOK 暂时无法连接模型：没有可用的供应商目标。请检查模型映射，或添加备用目标。';
  }
  const summaries = failures.map(failureSummary);
  const head = failures.length === 1
    ? `BYOK 暂时无法连接模型：${summaries[0]}。`
    : `BYOK 暂时无法连接模型，${failures.length} 个备用目标都不可用：${summaries.join('；')}。`;
  return clampText(`${head}${failureHint(failures)}`, 520);
}

function sendTerminalError(res, messageId, message, code = 'unavailable') {
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(200, streamHeaders());
  if (NATIVE_STREAM_ERRORS) {
    res.write(endOfStreamErrorEnvelope({ code, message }));
  } else {
    res.write(wrapEnvelope(buildErrorChunk(messageId, message)));
    res.write(endOfStreamEnvelope());
  }
  res.end();
}

// ─── Service tier (fast mode) ──────────────────────────────

// Detect fast mode from Windsurf model ID (suffix "-priority" = service_tier: fast)
function getServiceTier(requestedModel) {
  if (!requestedModel) return undefined;
  if (requestedModel.endsWith('-priority')) return 'fast';
  return undefined;
}

// 轻量提取 GetChatMessage 请求里的模型 ID（field21），不解析完整 body。
function extractModelId(body, headers) {
  try {
    const payload = unwrapRequest(body, headers || {});
    let i = 0;
    while (i < payload.length) {
      let tag = 0, shift = 0;
      while (true) { const b = payload[i++]; tag |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      const fn = tag >>> 3, wt = tag & 7;
      if (wt === 2) {
        let len = 0; shift = 0;
        while (true) { const b = payload[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
        if (fn === 21) return payload.subarray(i, i + len).toString('utf8');
        i += len;
      } else if (wt === 0) {
        while (payload[i++] & 0x80) {}
      } else if (wt === 5) { i += 4; }
      else if (wt === 1) { i += 8; }
      else return '';
    }
  } catch { /* 解析失败按"不拦截"处理，安全透传 */ }
  return '';
}

function messageHasImage(msg) {
  if (!msg || typeof msg.content === 'string') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(block => block && block.type === 'image');
}

function markModelSuccess(conn, model, messages, tools) {
  updateModelCapabilities(
    conn.providerId,
    model,
    Array.isArray(messages) && messages.some(messageHasImage),
    Array.isArray(tools) && tools.length > 0
  );
}

function recordStreamLatency(startedAt) {
  if (startedAt) recordLatency(Date.now() - startedAt);
}

function isGeminiModel(model = '') {
  return /gemini/i.test(String(model));
}

// Gemini(OpenAI 兼容层)对 JSON Schema 支持是子集。
// 这里递归剔除常见不兼容关键字，避免 INVALID_ARGUMENT 400。
function sanitizeJsonSchemaForGemini(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchemaForGemini);

  const allowed = new Set([
    'type', 'properties', 'required', 'items', 'description', 'enum',
    'nullable', 'format', 'minimum', 'maximum', 'minLength', 'maxLength',
    'minItems', 'maxItems', 'additionalProperties', 'default', 'title'
  ]);

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!allowed.has(k)) continue;
    out[k] = sanitizeJsonSchemaForGemini(v);
  }
  return out;
}

function normalizeToolSchema(inputSchema, model, forceGeminiCompat = false) {
  const raw = typeof inputSchema === 'string' ? JSON.parse(inputSchema) : (inputSchema || {});
  return (forceGeminiCompat || isGeminiModel(model)) ? sanitizeJsonSchemaForGemini(raw) : raw;
}

function shouldAutoEnableGeminiSchemaCompat(statusCode, errBody = '') {
  if (statusCode !== 400) return false;
  const s = String(errBody || '');
  return /Invalid JSON payload received/i.test(s)
    && /(exclusiveMinimum|propertyNames|function_declarations)/i.test(s);
}


// 路由层判断:该 GetChatMessage 是否应被劫持转发到第三方 provider。

// 命中普通 BYOK 映射或模型槽位管理项才拦截;否则原样透传给 Codeium。
export function shouldIntercept(body, headers) {
  const modelId = extractModelId(body, headers);
  const slot = getSlot(modelId);
  if (slot) return true;
  if (getInjectedByUid(modelId)) return true;
  return getRuntimeModelSlotStatus(modelId)?.status === 'unconfigured';
}


// ─── Main handler ──────────────────────────────────────────

export function handleGetChatMessage(req, res, body) {
  let { systemPrompt, messages, tools, toolChoice, requestedModel, initiator } =
    parseGetChatMessageRequest(body, req.headers);

  const messageId = crypto.randomUUID();
  let slot = getSlot(requestedModel);
  const injected = slot ? null : getInjectedByUid(requestedModel);
  const runtimeSlot = slot || injected ? null : getRuntimeModelSlotStatus(requestedModel);

  if (injected && injected.status !== 'configured') {
    const label = injected.label || requestedModel;
    const msg = `模型槽位「${label}」已解锁但尚未配置 BYOK 映射。请在「模型槽位管理」中选择供应商并填写 model 字段。`;
    console.warn(`  ⚠️  ${msg}`);
    recordError({ provider: 'model-slot', message: msg });
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  if (runtimeSlot && runtimeSlot.status === 'unconfigured') {
    const label = runtimeSlot.label || requestedModel;
    const msg = `模型槽位「${label}」已解锁但尚未配置 BYOK 映射。请在「模型槽位管理」中选择供应商并填写 model 字段。`;
    console.warn(`  ⚠️  ${msg}`);
    recordError({ provider: 'model-slot', message: msg });
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  if (injected) {
    slot = {
      modelUid: injected.modelUid,
      displayName: injected.label,
      supportsImages: injected.supportsImages !== false,
      targets: [{ providerId: injected.providerId, model: injected.model }],
      routeKind: 'injected',
    };
  }

  // shouldIntercept 已保证命中槽位才进来；防御性兜底:无槽位/无 targets → 清晰报错。
  if (!slot || !slot.targets || slot.targets.length === 0) {
    const label = slot?.displayName || requestedModel;
    const msg = `模型映射「${label}」已启用但尚未配置目标供应商。请在「模型映射」中编辑该行并添加供应商/model。`;
    console.warn(`  ⚠️  ${msg}`);
    recordError({ provider: 'model-slot', message: msg });
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  const providers = loadProviders();
  const serviceTier = getServiceTier(requestedModel);

  const routeLabel = slot.routeKind === 'injected' ? 'Managed slot' : 'Slot';
  console.log(`  🧠 ${routeLabel}: ${requestedModel} (${slot.displayName || '原名'}) → ${slot.targets.length} target(s)`);
  console.log(`  📝 System: ${systemPrompt.length} chars  💬 Messages: ${messages.length}${tools ? `  🔧 Tools: ${tools.length}` : ''}`);

  const hasImages = messages.some(messageHasImage);
  const routingTargets = [...slot.targets].sort((a, b) => {
    if (!hasImages) return 0;
    const connA = resolveTarget(a, providers);
    const connB = resolveTarget(b, providers);
    const av = connA.capabilities?.vision === true ? 1 : 0;
    const bv = connB.capabilities?.vision === true ? 1 : 0;
    return bv - av;
  });
  if (hasImages) {
    const imgCount = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0), 0);
    const sampleBlock = messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
    const sampleImg = sampleBlock ? sampleBlock.content.find(b => b.type === 'image') : null;
    const dataLen = sampleImg?.source?.data?.length || 0;
    const mediaType = sampleImg?.source?.media_type || 'unknown';
    console.log(`  🖼️  Image request detected: ${imgCount} image(s), data_len=${dataLen}, media_type=${mediaType}; preferring Vision-capable targets`);
  }

  // 故障转移:按 targets 顺序逐个尝试。只要还没开始向客户端写流，失败就切下一个。
  let idx = 0;
  const errors = [];
  const failures = [];
  function rememberFailure(failure) {
    failures.push(failure);
    errors.push(failureLogLine(failure));
  }
  // 当前活跃的上游请求。客户端断开时只销毁它（避免给每个 target 重复注册 close 监听器泄漏）。
  let currentApiReq = null;
  let retryTimer = null;
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = !res.writableEnded;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (clientClosed && currentApiReq && !currentApiReq.destroyed) {
      console.log(`  🔌 客户端断开，中止上游请求`);
      currentApiReq.destroy();
    }
  });

  function attemptNext() {
    if (clientClosed || res.writableEnded) return;
    if (idx >= routingTargets.length) {
      // 全部失败 → 无兜底，直接报错（日志已逐条打印原因）。
      console.error(`  ❌ 所有目标均失败: ${errors.join(' | ')}`);
      recordError({ provider: 'failover', message: errors.join(' | ') });
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, providerFailureMessage(failures), connectCodeForFailures(failures));
      }
      return;
    }

    const target = routingTargets[idx];
    const conn = resolveTarget(target, providers);
    idx++;

    if (conn.error) {
      console.warn(`  ⚠️  目标#${idx} ${target.providerId} 跳过: ${conn.error} → 切换下一个`);
      rememberFailure({
        providerId: target.providerId,
        model: target.model,
        reason: conn.error,
      });
      return attemptNext();
    }

    if (hasImages && conn.capabilities?.vision === false) {
      console.warn(`  ⚠️  目标#${idx} ${conn.providerName} 未标记支持 Vision，但仍尝试转发（探测可能误报）`);
    }

    console.log(`  ➡️  目标#${idx}: ${conn.providerName} (${conn.format}) → ${conn.model}${conn.capabilities?.gzip ? ' [gzip]' : ''}`);
    recordRequest({ provider: conn.providerName, requestedModel, resolvedModel: conn.model });

    const sys = `${systemPrompt}\n\nYou are powered by ${conn.model}.`;
    const targetStartedAt = Date.now();
    let retryCount = 0;

    const startTargetRequest = () => {
      retryTimer = null;
      if (clientClosed || res.writableEnded) return;
      const onFailover = (reason, meta = {}) => {
        if (clientClosed || res.writableEnded) return;
        const canRetry = !res.headersSent
          && retryCount < RETRY_MAX
          && (retryCount === 0 || (Date.now() - targetStartedAt) < RETRY_TOTAL_MS)
          && isRetryableFailure(reason, meta);

        if (canRetry) {
          retryCount++;
          const delay = Math.round(retryDelayMs(retryCount, meta));
          console.warn(`  ⏳ ${conn.providerName} 失败(${reason})，${delay}ms 后重试 ${retryCount}/${RETRY_MAX}`);
          retryTimer = setTimeout(startTargetRequest, delay);
          return;
        }

        console.warn(`  ⚠️  ${conn.providerName} 失败(${reason}) → 切换下一个`);
        rememberFailure({
          providerId: conn.providerId,
          providerName: conn.providerName,
          model: conn.model,
          reason,
          statusCode: meta.statusCode,
          code: meta.code,
          body: meta.body,
        });
        attemptNext();
      };

      const opts = {
        systemPrompt: sys,
        messages,
        tools,
        toolChoice,
        resolvedModel: conn.model,
        serviceTier,
        messageId,
        conn,
        onFailover,
        schemaCompatRetry: false,
        bindActiveReq: (r) => { currentApiReq = r; },
      };

      currentApiReq = conn.format === 'openai'
        ? streamOpenAI(req, res, opts)
        : streamAnthropic(req, res, opts);
    };

    startTargetRequest();
  }

  attemptNext();
}

// ─── Anthropic streaming ────────────────────────────────────

function anthropicAuthHeaders(conn) {
  const headers = {
    'anthropic-version': '2023-06-01',
  };
  if (conn.authScheme === 'bearer') {
    headers.authorization = `Bearer ${conn.apiKey}`;
  } else {
    headers['x-api-key'] = conn.apiKey;
  }
  return headers;
}

function streamAnthropic(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId, conn, onFailover }) {
  const apiPayload = {
    model: resolvedModel,
    system: systemPrompt || undefined,
    messages,
    stream: true,
    max_tokens: MAX_TOKENS,
  };
  if (tools && tools.length > 0) {
    apiPayload.tools = tools;
    if (toolChoice) apiPayload.tool_choice = toolChoice;
  }

  const apiBody = JSON.stringify(apiPayload);
  const processor = new AnthropicStreamProcessor(messageId, resolvedModel);
  let failed = false; // 防止 error+statusCode 双触发 onFailover

  // ── MITM 日志：记录上游请求 ──
  const mitmReqId = crypto.randomUUID();
  mitmLog({
    direction: 'upstream',
    providerName: conn.providerName,
    model: resolvedModel,
    format: 'anthropic',
    request: {
      method: 'POST',
      url: `https://${conn.host}${conn.apiPath}`,
      headers: { 'content-type': 'application/json', ...anthropicAuthHeaders(conn) },
      body: apiBody,
    },
  });

  const apiReq = https.request({
    agent: httpsAgentFor(HTTPS_AGENT),
    hostname: conn.host,
    port: 443,
    path: conn.apiPath,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...anthropicAuthHeaders(conn),
      'content-length': Buffer.byteLength(apiBody),
    },
  }, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
      const fail = () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 300)}`);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'anthropic', request: { method: 'POST', url: `https://${conn.host}${conn.apiPath}` }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
        apiReq.destroy();
        if (!failed) { failed = true; onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody }); }
      };
      apiRes.on('end', fail);
      // 上游只发头不发 body 时 'end' 可能不来，加超时兜底避免请求挂死。
      setTimeout(() => { if (!failed) fail(); }, 5000);
      return;
    }

    // 收到 200 → 确定用这个供应商，此刻才向客户端发流头（之前都还能切换）。
    const streamStartedAt = Date.now();
    res.writeHead(200, streamHeaders());
    apiRes.setEncoding('utf8');

    function processPart(part) {
      const events = parseSSEChunk(part + '\n\n');
      for (const evt of events) {
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
        if (processor.isDone && !res.writableEnded) {
          res.write(endOfStreamEnvelope());
          res.end();
          recordStreamLatency(streamStartedAt);
          markModelSuccess(conn, resolvedModel, messages, tools);
          recordUsage(processor.usage);
          console.log(`  ✅ Stream done (stop: ${processor.stopReason})`);
        }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        console.log(`  ✅ Stream ended`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ Anthropic stream error: ${err.message}`);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    // 连接阶段失败（headersSent=false）→ 还能切换下一个供应商。
    if (!failed && !res.headersSent) { failed = true; onFailover(err.message, { code: err.code }); return; }
    if (!res.writableEnded) {
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  // 上游挂起防护：120s 无响应则断开（触发上面的 error handler 回写错误流或故障转移）。
  apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    const err = new Error('upstream timeout');
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  });

  apiReq.end(apiBody);
  return apiReq;
}

// ─── OpenAI Responses API streaming ─────────────────────────

function streamOpenAI(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId, conn, onFailover, schemaCompatRetry = false, bindActiveReq = null }) {
  if (conn.apiPath.includes('/chat/completions')) {
    return streamOpenAIChatCompletions(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId, conn, onFailover, schemaCompatRetry, bindActiveReq });
  }


  // Convert Anthropic-format messages to OpenAI format
  const openaiMessages = toOpenAIMessages(systemPrompt, messages);

  const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';

  // Responses API payload — uses `input` instead of `messages`
  const apiPayload = {
    model: resolvedModel,
    input: openaiMessages,
    stream: true,
    max_output_tokens: MAX_TOKENS,
  };
  if (OPENAI_REASONING_EFFORT && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_EFFORT)) {
    apiPayload.reasoning = { effort: OPENAI_REASONING_EFFORT };
    if (OPENAI_REASONING_SUMMARY && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_SUMMARY)) {
      apiPayload.reasoning.summary = OPENAI_REASONING_SUMMARY;
    }
  }

  if (serviceTier) apiPayload.service_tier = serviceTier;
  if (tools && tools.length > 0) {
    apiPayload.tools = tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: normalizeToolSchema(t.input_schema, resolvedModel, forceGeminiCompat),
    }));


    if (toolChoice) {
      if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
      else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
      else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', name: toolChoice.name };
    }
  }

  const apiBody = JSON.stringify(apiPayload);
  // MITM 日志：记录上游请求
  mitmLog({ direction: 'upstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: `https://${conn.host}${conn.apiPath}`, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${conn.apiKey}` }, body: apiBody } });
  // gzip 可选：供应商标记了 capabilities.gzip=true 才压缩。
  // 用于绕过中转站 Cloudflare WAF 对明文 body 的命令注入检测；
  // One-Hub 等不支持 gzip 的端点保持明文。
  const useGzip = conn.capabilities?.gzip === true;
  const finalBody = useGzip ? gzipSync(Buffer.from(apiBody)) : Buffer.from(apiBody);
  const responseProcessor = new OpenAIStreamProcessor(messageId, resolvedModel);
  const chatFallbackProcessor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
  let processorMode = 'responses';
  const activeProcessor = () => processorMode === 'chat' ? chatFallbackProcessor : responseProcessor;
  let failed = false;

  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'authorization': `Bearer ${conn.apiKey}`,
    'content-length': finalBody.length,
  };
  if (useGzip) reqHeaders['content-encoding'] = 'gzip';

  const apiReq = https.request({
    agent: httpsAgentFor(HTTPS_AGENT),
    hostname: conn.host,
    port: 443,
    path: conn.apiPath,
    method: 'POST',
    headers: reqHeaders,
  }, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
      const fail = () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 300)}`);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: `https://${conn.host}${conn.apiPath}` }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });

        if (!schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(apiRes.statusCode, errBody) && tools && tools.length > 0 && !res.headersSent) {
          const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
          if (remembered) {
            console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
          }
          console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
          apiReq.destroy();
          if (!failed) {
            failed = true;
            return streamOpenAI(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              serviceTier,
              messageId,
              conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
              onFailover,
              schemaCompatRetry: true,
              bindActiveReq,
            });
          }
          return;
        }

        apiReq.destroy();
        if (!failed) { failed = true; onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody }); }
      };

    apiRes.on('end', fail);
    // 上游只发头不发 body 时 'end' 可能不来，加超时兜底避免请求挂死。
      setTimeout(() => { if (!failed) fail(); }, 5000);
      return;
    }

    const streamStartedAt = Date.now();
    res.writeHead(200, streamHeaders());
    apiRes.setEncoding('utf8');

    function processPart(part) {
      const events = parseOpenAISSEChunk(part + '\n');
      for (const evt of events) {
        if (processorMode === 'responses' && evt?.data?.choices) {
          processorMode = 'chat';
          console.warn(`  ⚠️  OpenAI endpoint returned chat.completion chunks; switching stream parser`);
        }
        const processor = activeProcessor();
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      const processor = activeProcessor();
      if (processor.isDone && !res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        console.log(`  ✅ OpenAI stream done (stop: ${processor.stopReason})`);
      }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      const processor = activeProcessor();
      // Force stop chunk if stream ended without response.completed
      if (!processor.isDone && !res.writableEnded) {
        const expectedDone = processorMode === 'chat' ? '[DONE]' : 'response.completed';
        console.log(`  ⚠️  OpenAI stream ended without ${expectedDone} — forcing stop`);
        const finalChunks = processor.processEvent({ done: true, type: 'done', data: null });
        for (const chunk of finalChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        console.log(`  ✅ OpenAI stream ended (stop: ${processor.stopReason})`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ OpenAI stream error: ${err.message}`);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);

  apiReq.on('error', (err) => {

    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    if (!failed && !res.headersSent) { failed = true; onFailover(err.message, { code: err.code }); return; }
    if (!res.writableEnded) {
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  // 上游挂起防护：120s 无响应则断开（触发上面的 error handler 回写错误流或故障转移）。
  apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    const err = new Error('upstream timeout');
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  });

  apiReq.end(finalBody);
  return apiReq;
}

// ─── OpenAI Chat Completions API streaming ──────────────────

function streamOpenAIChatCompletions(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId, conn, onFailover, schemaCompatRetry = false, bindActiveReq = null }) {
  const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';

  const apiPayload = {
    model: resolvedModel,
    messages: toOpenAIChatMessages(systemPrompt, messages),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
  };

  if (serviceTier) apiPayload.service_tier = serviceTier;
  if (tools && tools.length > 0) {
    apiPayload.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: normalizeToolSchema(t.input_schema, resolvedModel, forceGeminiCompat),
      },
    }));

    if (toolChoice) {
      if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
      else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
      else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', function: { name: toolChoice.name } };
    }
  }

  const apiBody = JSON.stringify(apiPayload);
  // MITM 日志：记录上游请求
  mitmLog({ direction: 'upstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: `https://${conn.host}${conn.apiPath}`, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${conn.apiKey}` }, body: apiBody } });
  const processor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
  let failed = false;

  const apiReq = https.request({
    agent: httpsAgentFor(HTTPS_AGENT),
    hostname: conn.host,
    port: 443,
    path: conn.apiPath,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'authorization': `Bearer ${conn.apiKey}`,
      'content-length': Buffer.byteLength(apiBody),
    },
  }, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
      const fail = () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 300)}`);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: `https://${conn.host}${conn.apiPath}` }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });

        if (!schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(apiRes.statusCode, errBody) && tools && tools.length > 0 && !res.headersSent) {
          const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
          if (remembered) {
            console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
          }
          console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
          apiReq.destroy();
          if (!failed) {
            failed = true;
            return streamOpenAIChatCompletions(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              serviceTier,
              messageId,
              conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
              onFailover,
              schemaCompatRetry: true,
              bindActiveReq,
            });
          }
          return;
        }

        apiReq.destroy();
        if (!failed) { failed = true; onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody }); }
      };

      apiRes.on('end', fail);
      setTimeout(() => { if (!failed) fail(); }, 5000);
      return;
    }

    const streamStartedAt = Date.now();
    res.writeHead(200, streamHeaders());
    apiRes.setEncoding('utf8');

    function processPart(part) {
      const events = parseOpenAISSEChunk(part + '\n');
      for (const evt of events) {
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (processor.isDone && !res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        console.log(`  ✅ OpenAI chat stream done (stop: ${processor.stopReason})`);
      }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      if (!processor.isDone && !res.writableEnded) {
        const finalChunks = processor.processEvent({ done: true, type: 'done', data: null });
        for (const chunk of finalChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        console.log(`  ✅ OpenAI chat stream ended (stop: ${processor.stopReason})`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ OpenAI chat stream error: ${err.message}`);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);

  apiReq.on('error', (err) => {

    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    if (!failed && !res.headersSent) { failed = true; onFailover(err.message, { code: err.code }); return; }
    if (!res.writableEnded) {
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    const err = new Error('upstream timeout');
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  });

  apiReq.end(apiBody);
  return apiReq;
}

// ─── Anthropic → OpenAI Responses API input converter ───────
//
// Responses API uses a flat array of typed items instead of messages:
//   { role: "user"|"assistant"|"system"|"developer", content: "..." }
//   { type: "function_call", call_id, name, arguments }
//   { type: "function_call_output", call_id, output }

function toOpenAIMessages(systemPrompt, anthropicMessages) {
  const result = [];

  // System prompt → developer message (Responses API prefers "developer" over "system")
  if (systemPrompt) {
    result.push({ role: 'developer', content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      // Text content → assistant message
      let textContent = '';
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
      if (textContent) {
        result.push({ role: 'assistant', content: textContent });
      }

      // Tool calls → function_call items (Responses API format)
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          result.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          });
        }
      }

    } else if (msg.role === 'user') {
      const contentParts = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          contentParts.push(block.text);
        } else if (block.type === 'image') {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${block.source?.media_type || 'image/png'};base64,${block.source?.data || ''}`,
          });
        } else if (block.type === 'tool_result') {
          // Tool results → function_call_output items (Responses API format)
          result.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        }
      }

      if (contentParts.length > 0) {
        const hasMedia = contentParts.some(p => typeof p !== 'string');
        if (hasMedia) {
          result.push({
            role: 'user',
            content: contentParts.map(p =>
              typeof p === 'string' ? { type: 'input_text', text: p } : p
            ),
          });
        } else {
          result.push({ role: 'user', content: contentParts.join('\n') });
        }
      }
    }
  }

  return result;
}

function toOpenAIChatMessages(systemPrompt, anthropicMessages) {
  const result = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      let textContent = '';
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
            },
          });
        }
      }
      const out = { role: 'assistant', content: textContent || null };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      result.push(out);
      continue;
    }

    const contentParts = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source?.media_type || 'image/png'};base64,${block.source?.data || ''}` },
        });
      } else if (block.type === 'tool_result') {
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }

    if (contentParts.length > 0) {
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        result.push({ role: msg.role, content: contentParts[0].text });
      } else {
        result.push({ role: msg.role, content: contentParts });
      }
    }
  }

  return result;
}
