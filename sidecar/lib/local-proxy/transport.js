// transport.js — Upstream HTTP(S) transport, auth resolution, retry/backoff, error classification,
// vision fallback, rate limiting, request/tool parameter overrides & request logging.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { parseSSEStream as parseStandardSSEStream } from '../sse-parser.js';
import { configDir } from '../config-dir.js';
import { cleanupExpiredLogs } from '../log-cleanup.js';
import { claudeCodeUnlockHeaders, codexUnlockHeaders } from '../codex-unlock.js';
import { redactGeminiCredential, resolveGeminiAuthHeader } from '../google-gemini.js';
import { attachUpstreamWatchdog, providerGateKey, providerInflightGate, ttfbMsFromEnhancement } from '../upstream-watchdog.js';
import {
  RETRYABLE_CODES,
  RETRYABLE_STATUS,
  checkWindowRateLimit,
  retryAfterMs,
  shortRetryAfterDelay,
  sleep,
} from '../http-retry.js';
import {
  buildAttemptRetryPolicy,
  computeAttemptRetryDelay,
  isRetryableAttemptFailure,
} from '../attempt-runner.js';
import { SHARED_HTTP_AGENT, SHARED_HTTPS_AGENT, httpsAgentFor } from '../../system-proxy.js';
import { preprocessImagesWithThirdPartyVision } from '../../vision-fallback.js';
import { hasImage } from './normalize.js';
import { LocalProxyUpstreamError } from './routes.js';

export { RETRYABLE_CODES, RETRYABLE_STATUS, retryAfterMs, shortRetryAfterDelay, sleep };

export function retryPolicy(enhancement = {}) {
  return buildAttemptRetryPolicy(enhancement);
}

export function retryDelay(attempt, policy, headers, elapsedMs) {
  return computeAttemptRetryDelay(attempt, policy, headers, elapsedMs, { capToRemaining: true });
}

export function retryable(status, code) {
  return isRetryableAttemptFailure({ statusCode: status, code, matchReasonText: false });
}

export function authHeaders(conn, sessionId) {
  if (conn.format === 'gemini') {
    if (conn.authScheme === 'bearer' || /^bearer\s+/i.test(String(conn.apiKey || '').trim()) || String(conn.apiKey || '').trim().startsWith('ya29.')) {
      const tok = String(conn.apiKey || '').trim().replace(/^bearer\s+/i, '');
      return { authorization: `Bearer ${tok}` };
    }
    return { 'x-goog-api-key': conn.apiKey };
  }
  if (conn.format === 'openai' && conn.unlockKind === 'codex') return codexUnlockHeaders(conn, sessionId);
  if (conn.format === 'openai') return { authorization: `Bearer ${conn.apiKey}` };
  if (conn.format === 'anthropic' && conn.unlockKind === 'claudeCode') return claudeCodeUnlockHeaders(conn);
  const h = { 'anthropic-version': '2023-06-01' };
  if (conn.authScheme === 'bearer') h.authorization = `Bearer ${conn.apiKey}`;
  else h['x-api-key'] = conn.apiKey;
  return h;
}

export async function resolveAuthHeaders(conn, sessionId) {
  if (conn.format === 'gemini') {
    try {
      const resolved = await resolveGeminiAuthHeader(conn.apiKey);
      return resolved.headers;
    } catch (e) {
      throw new Error(redactGeminiCredential(e?.message || String(e), conn.apiKey));
    }
  }
  return authHeaders(conn, sessionId);
}

function upstreamRequestOptions(conn, headers) {
  const protocol = conn.protocol === 'http' ? 'http' : 'https';
  const defaultPort = protocol === 'http' ? 80 : 443;
  return {
    module: protocol === 'http' ? http : https,
    options: {
      agent: protocol === 'http' ? SHARED_HTTP_AGENT : httpsAgentFor(SHARED_HTTPS_AGENT),
      hostname: conn.hostname || conn.host,
      port: Number(conn.port || defaultPort),
      path: conn.apiPath,
      method: 'POST',
      headers,
    },
  };
}

function buildExtraRequestHeaders(enhancement = {}) {
  const extraHeaders = {};
  if (enhancement.customHeadersEnabled === true && Array.isArray(enhancement.customHeaders)) {
    for (const h of enhancement.customHeaders) {
      if (h && h.key) extraHeaders[h.key] = h.value;
    }
  }
  return extraHeaders;
}

export function extractExtraRespHeaders(enhancement = {}) {
  const extraRespHeaders = {};
  if (enhancement.customHeadersEnabled === true && Array.isArray(enhancement.responseHeaders)) {
    for (const h of enhancement.responseHeaders) {
      if (h && h.key) extraRespHeaders[h.key] = h.value;
    }
  }
  return extraRespHeaders;
}

export async function requestUpstream(conn, payload, enhancement = {}) {
  const label = `${conn.providerName || 'provider'}/${conn.model || 'model'} local-proxy`;
  const auth = await resolveAuthHeaders(conn, payload?.prompt_cache_key);
  return providerInflightGate.run(providerGateKey(conn), () => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const started = Date.now();
    const requestConfig = upstreamRequestOptions(conn, {
      'content-type': 'application/json',
      'content-length': body.length,
      ...auth,
      ...buildExtraRequestHeaders(enhancement),
    });
    let watchdog;
    const req = requestConfig.module.request(requestConfig.options, (apiRes) => {
      if (watchdog) watchdog.markResponse(apiRes);
      else queueMicrotask(() => watchdog?.markResponse(apiRes));
      const clearWatchdog = () => watchdog?.clear();
      const chunks = [];
      apiRes.on('data', (c) => chunks.push(c));
      apiRes.on('end', () => {
        clearWatchdog();
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: apiRes.statusCode || 0, headers: apiRes.headers || {}, text, json, durationMs: Date.now() - started });
      });
      apiRes.on('close', clearWatchdog);
      apiRes.on('error', (err) => {
        clearWatchdog();
        reject(err);
      });
    });
    watchdog = attachUpstreamWatchdog(req, { label, ttfbMs: ttfbMsFromEnhancement(enhancement) });
    req.on('error', (err) => {
      watchdog.clear();
      reject(err);
    });
    req.end(body);
  }));
}

export async function requestUpstreamStream(conn, payload, enhancement = {}) {
  const label = `${conn.providerName || 'provider'}/${conn.model || 'model'} local-proxy-stream`;
  const auth = await resolveAuthHeaders(conn, payload?.prompt_cache_key);
  const gateKey = providerGateKey(conn);
  const freeSlot = await providerInflightGate.acquire(gateKey);

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const started = Date.now();
    const requestConfig = upstreamRequestOptions(conn, {
      'content-type': 'application/json',
      'content-length': body.length,
      ...auth,
      ...buildExtraRequestHeaders(enhancement),
    });

    let headerSettled = false;
    let slotFreed = false;
    const freeOnce = () => {
      if (slotFreed) return;
      slotFreed = true;
      freeSlot();
    };
    const settleHeader = (fn, value) => {
      if (headerSettled) return;
      headerSettled = true;
      fn(value);
    };

    let watchdog;
    const req = requestConfig.module.request(requestConfig.options, (apiRes) => {
      if (watchdog) watchdog.markResponse(apiRes);
      else queueMicrotask(() => watchdog?.markResponse(apiRes));
      const cleanup = () => {
        watchdog?.clear();
        freeOnce();
      };
      apiRes.on('end', cleanup);
      apiRes.on('close', cleanup);
      apiRes.on('error', cleanup);
      settleHeader(resolve, {
        statusCode: apiRes.statusCode || 0,
        headers: apiRes.headers || {},
        response: apiRes,
        durationMs: Date.now() - started,
        watchdog,
      });
    });
    watchdog = attachUpstreamWatchdog(req, { label, ttfbMs: ttfbMsFromEnhancement(enhancement) });
    req.on('error', (err) => {
      watchdog.clear();
      freeOnce();
      settleHeader(reject, err);
    });
    req.end(body);
  });
}

export async function collectStreamBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function* parseSSEStream(response, { onChunk } = {}) {
  for await (const evt of parseStandardSSEStream(response, { onChunk, parseJson: true })) {
    if (evt.jsonError || !evt.data || typeof evt.data !== 'object') continue;
    yield evt.data;
  }
}

export function upstreamMessage(r) {
  return r.json?.error?.message || r.json?.message || r.json?.detail || r.text || `HTTP ${r.statusCode}`;
}

export function compactText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function safeParse(text) {
  try { return JSON.parse(text); } catch { return { error: { message: String(text || '') } }; }
}

function isRateLimitOrHighLoad(failure = {}) {
  const status = Number(failure.statusCode) || 0;
  const text = `${failure.reason || ''} ${failure.message || ''}`;
  if (status === 429 || status === 529) return true;
  if (status === 503 && /service unavailable|overloaded|temporarily|rate limit|too many requests/i.test(text)) return true;
  return /负载.*上限|达到上限|get_channel_failed|rate limit|too many requests|限流|频率|overloaded/i.test(text);
}

export function classifyFailures(failures = []) {
  const text = failures.map((f) => `${f.reason || ''} ${f.message || ''}`).join(' ');
  if (failures.some((f) => f.statusCode === 401) || /unauthorized|invalid api key|api key|认证|鉴权/i.test(text)) {
    return { status: 401, type: 'authentication_error' };
  }
  if (failures.some((f) => f.statusCode === 403) || /permission|forbidden|无权限|未开通/i.test(text)) {
    return { status: 403, type: 'permission_error' };
  }
  if (failures.some(isRateLimitOrHighLoad)) {
    return { status: 429, type: 'rate_limit_error' };
  }
  if (failures.some((f) => f.statusCode === 400)) return { status: 400, type: 'invalid_request_error' };
  if (failures.some((f) => f.statusCode === 404)) return { status: 404, type: 'not_found_error' };
  if (failures.some((f) => f.statusCode >= 500)) return { status: 503, type: 'api_error' };
  return { status: 502, type: 'upstream_error' };
}

export function upstreamErrorText(body) {
  const text = String(body == null ? '' : body).trim();
  if (!text || text.startsWith('<')) return '';
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message || json?.error?.type || json?.message || json?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (typeof json?.error === 'string' && json.error.trim()) return json.error.trim();
    return '';
  } catch {
    return text;
  }
}

export function readableErrorText(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.startsWith('<') || /^HTTP \d{3}$/i.test(text)) return '';
  return text;
}

export function failureMessage(failure = {}) {
  if (typeof failure === 'string') return failure;
  const status = failure.statusCode ? `HTTP ${failure.statusCode}` : (failure.code || '失败');
  const raw = readableErrorText(failure.message)
    || (failure.body != null ? upstreamErrorText(failure.body) : '');
  const detail = raw ? `：${raw}` : (failure.statusCode ? '（上游返回空响应）' : '');
  return `${failure.providerName || 'provider'} ${status}${detail}`;
}

export async function maybeVisionFallback(ctx, slot, providers, mapConfig) {
  if (!hasImage(ctx.messages) || slot.useThirdPartyVision !== true || mapConfig?.enhancement?.imageFallback === false) return ctx;
  const visionModels = mapConfig?.visionModels?.imageModels || [];
  if (!visionModels.length) throw new Error(`模型「${slot.displayName || slot.modelUid || ctx.model}」启用了第三方图片理解，但网关增强里没有配置图片理解模型。`);
  const visionOptions = {
    maxTokens: mapConfig?.enhancement?.visionMaxTokens,
    contextMode: mapConfig?.enhancement?.visionContextMode,
    contextMaxChars: mapConfig?.enhancement?.visionContextMaxChars,
    multiImageMode: mapConfig?.enhancement?.visionMultiImageMode,
    batchSize: mapConfig?.enhancement?.visionBatchSize,
  };
  const fbCtx = { requestId: crypto.randomUUID(), requestedModel: ctx.model, slotModelUid: slot.modelUid || ctx.model, slotDisplayName: slot.displayName || ctx.model, visionOptions };
  const result = await preprocessImagesWithThirdPartyVision(ctx.messages, visionModels, providers, fbCtx);

  let rawBody = ctx.rawBody;
  if (rawBody) {
    if (ctx.kind === 'responses' && Array.isArray(rawBody.input)) {
      rawBody = { ...rawBody, input: await fallbackResponsesInput(rawBody.input, visionModels, providers, fbCtx) };
    } else if (ctx.kind === 'openai' && Array.isArray(rawBody.messages)) {
      const r = await preprocessImagesWithThirdPartyVision(rawBody.messages, visionModels, providers, fbCtx);
      rawBody = { ...rawBody, messages: r.messages };
    }
  }
  return { ...ctx, messages: result.messages, rawBody, visionFallbackApplied: true };
}

async function fallbackResponsesInput(input, visionModels, providers, fbCtx) {
  const out = input.slice();
  const messageItemIndices = [];
  const looseIndices = [];
  input.forEach((item, i) => {
    if (item && item.type === 'message' && Array.isArray(item.content)) messageItemIndices.push(i);
    else if (item && item.type === 'input_image') looseIndices.push(i);
  });
  if (messageItemIndices.length) {
    const msgs = messageItemIndices.map((i) => input[i]);
    const r = await preprocessImagesWithThirdPartyVision(msgs, visionModels, providers, fbCtx);
    r.messages.forEach((m, k) => { out[messageItemIndices[k]] = m; });
  }
  if (looseIndices.length) {
    const looseMsg = { role: 'user', content: looseIndices.map((i) => input[i]) };
    const r = await preprocessImagesWithThirdPartyVision([looseMsg], visionModels, providers, fbCtx);
    const newContent = r.messages[0]?.content || looseMsg.content;
    looseIndices.forEach((idx, k) => { out[idx] = newContent[k] ?? input[idx]; });
  }
  return out;
}

const rateLimitBuckets = new Map();
export function checkRateLimit(model, rpm) {
  return checkWindowRateLimit(rateLimitBuckets, model, rpm, 2000);
}

function toolName(tool) {
  return String(tool?.name || tool?.function?.name || '').trim();
}

function toolChoiceName(choice) {
  if (!choice || typeof choice !== 'object') return '';
  if (choice.type === 'tool') return String(choice.name || '').trim();
  if (choice.type === 'function') return String(choice.function?.name || choice.name || '').trim();
  return '';
}

export function applyToolEnhancement(effective, enhancement = {}) {
  if (enhancement.toolFilterEnabled !== true) return;
  if (enhancement.toolFilterMode && Array.isArray(effective.tools) && effective.tools.length) {
    const filterSet = new Set((enhancement.toolFilterList || []).map((n) => String(n || '').trim()).filter(Boolean));
    if (filterSet.size) {
      const beforeLen = effective.tools.length;
      effective.tools = effective.tools.filter((tool) => {
        const name = toolName(tool);
        if (enhancement.toolFilterMode === 'allow') return filterSet.has(name);
        if (enhancement.toolFilterMode === 'deny') return !filterSet.has(name);
        return true;
      });
      if (effective.tools.length !== beforeLen) effective.toolsMutated = true;
    }
  }
  if (enhancement.forceToolChoice) {
    effective.toolChoice = enhancement.forceToolChoice;
    effective.toolChoiceMutated = true;
  }
  const chosenTool = toolChoiceName(effective.toolChoice);
  if (chosenTool) {
    const available = new Set((effective.tools || []).map(toolName).filter(Boolean));
    if (!available.has(chosenTool)) {
      throw new LocalProxyUpstreamError(`工具过滤后 tool_choice 指向不可用工具: ${chosenTool}`, {
        status: 400,
        type: 'invalid_request_error',
      });
    }
  }
}

function assignPositiveInteger(target, key, value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new LocalProxyUpstreamError(`${label} 必须是大于 0 的整数`, { status: 400, type: 'invalid_request_error' });
  }
  target[key] = n;
}

export function applyParamOverrides(effective, enhancement = {}) {
  if (enhancement.paramOverridesEnabled !== true) return;
  const overrides = enhancement.paramOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  const extras = { ...(effective.paramOverrideExtras || {}) };
  for (const [key, value] of Object.entries(overrides)) {
    if (['max_tokens', 'max_output_tokens', 'max_completion_tokens', 'maxTokens'].includes(key)) {
      assignPositiveInteger(effective, 'maxTokens', value, key);
      effective.maxTokensOverridden = true;
    } else if (key === 'temperature') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new LocalProxyUpstreamError('temperature 必须是数字', { status: 400, type: 'invalid_request_error' });
      effective.temperature = n;
      effective.temperatureOverridden = true;
    } else if (key === 'tool_choice' || key === 'toolChoice') {
      effective.toolChoice = value;
      effective.toolChoiceMutated = true;
    } else if (key === 'system' || key === 'instructions') {
      effective.system = String(value || '');
      effective.systemOverridden = true;
    } else if (key === 'tools') {
      if (!Array.isArray(value)) throw new LocalProxyUpstreamError('tools 覆盖值必须是数组', { status: 400, type: 'invalid_request_error' });
      effective.tools = value;
      effective.toolsMutated = true;
    } else if (['model', 'messages', 'input', 'stream'].includes(key)) {
      throw new LocalProxyUpstreamError(`请求参数覆盖不支持修改 ${key}`, { status: 400, type: 'invalid_request_error' });
    } else {
      extras[key] = value;
    }
  }
  effective.paramOverrideExtras = extras;
}

export function logRequest(ctx, phase) {
  try {
    const dir = path.join(configDir(), 'proxy-logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cleanupExpiredLogs();
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `proxy-${date}.jsonl`);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      phase,
      model: ctx.model,
      kind: ctx.kind,
      ...(phase === 'request' ? { system: ctx.system?.slice(0, 200), messageCount: ctx.messages?.length } : {}),
      ...(ctx._response ? { statusCode: ctx._response.statusCode, textPreview: ctx._response.text?.slice(0, 500) } : {}),
    });
    fs.appendFileSync(file, entry + '\n');
  } catch {}
}
