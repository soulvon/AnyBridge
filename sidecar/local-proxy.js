// local-proxy.js - OpenAI/Anthropic compatible local reverse proxy.
// Reuses AnyBridge model slots, provider routing, retry config and vision fallback.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeCodeUnlockPayload,
  buildCodexPromptCacheKey,
  buildCodexUnlockClientMetadata,
  claudeCodeUnlockHeaders,
  codexUnlockHeaders,
  normalizeClaudeCodeUnlock,
  normalizeCodexUnlock,
} from './lib/codex-unlock.js';
import { getProxyRoutes } from './config-cache.js';
import { loadModelMapConfig, loadProviders, resolveTarget } from './provider-pool.js';
import { preprocessImagesWithThirdPartyVision } from './vision-fallback.js';
import { httpsAgentFor } from './system-proxy.js';
import { recordError, recordLatency, recordRequest, recordRetry, recordUsage } from './stats.js';
import {
  responsesToChatCompletions,
  chatCompletionToResponse,
  chatErrorToResponseError,
  createResponsesSSEFromChat,
} from './lib/responses-chat-transform.js';

const AGENT = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']);

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(os.homedir(), 'AppData', 'Roaming', name);
}

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function readLocalConfig() {
  try {
    const file = path.join(configDir(), 'byok-config.json');
    if (!fs.existsSync(file)) return {};
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && json.values && typeof json.values === 'object' ? json.values : {};
  } catch (e) {
    console.warn(`[local-proxy] failed to read config: ${e.message}`);
    return {};
  }
}

function pathnameOf(req) {
  try { return new URL(req.url, 'http://127.0.0.1').pathname; }
  catch { return req.url || '/'; }
}

export function isLocalProxyRequest(req) {
  const p = pathnameOf(req);
  return p === '/v1/models'
    || p === '/v1/chat/completions'
    || p === '/v1/responses'
    || p === '/anthropic/v1/models'
    || p === '/anthropic/v1/messages'
    || p === '/anthropic/messages'
    || p === '/anthropic/v1/messages/count_tokens'
    || p === '/anthropic/messages/count_tokens';
}

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...extra,
  };
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, cors({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers }));
  res.end(text);
}

function sendRaw(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : String(body || '');
  const contentType = headers['content-type'] || headers['Content-Type'] || 'application/json; charset=utf-8';
  res.writeHead(status, cors({ 'content-type': contentType, 'content-length': Buffer.byteLength(text) }));
  res.end(text);
}

function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: type, status } });
}

function sendAnthropicError(res, status, message, type = 'api_error') {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

class LocalProxyUpstreamError extends Error {
  constructor(message, { status = 502, type = 'upstream_error', upstreamResponse = null } = {}) {
    super(message);
    this.name = 'LocalProxyUpstreamError';
    this.status = status;
    this.type = type;
    this.upstreamResponse = upstreamResponse;
  }
}

function authToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return String(req.headers['x-api-key'] || req.headers['api-key'] || '').trim();
}

function validateAuth(req) {
  const expected = String(readLocalConfig().LOCAL_PROXY_KEY || '').trim();
  if (!expected) return { ok: false, status: 503, message: 'AnyBridge 本地代理 key 尚未生成，请在代理页生成 key。' };
  if (authToken(req) !== expected) return { ok: false, status: 401, message: 'AnyBridge 本地代理 key 无效。' };
  return { ok: true };
}

function proxyRouteRows(kind) {
  const store = getProxyRoutes();
  if (store.loadError) throw new Error(`本地代理模型列表读取失败: ${store.loadError}`);
  if (!store.fileExists) return [];
  return (store.routes || [])
    .filter(route => route.enabled !== false)
    .filter(route => Array.isArray(route.targets) && route.targets.length > 0)
    .map(route => ({ id: route.id, name: route.id }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function readCodexModelCatalog() {
  try {
    const home = os.homedir();
    const codexDir = path.join(home, '.codex');
    const catalogFile = path.join(codexDir, 'anybridge-model-catalog.json');
    if (!fs.existsSync(catalogFile)) return [];
    const raw = fs.readFileSync(catalogFile, 'utf8');
    const parsed = JSON.parse(raw);
    // Codex 模型目录为 ModelsResponse 格式 {"models": [...]}；
    // 兼容旧版顶层数组 [...] 写法。
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.models) ? parsed.models : []);
    if (!Array.isArray(arr)) return [];
    return arr.map(e => ({ id: e.slug || e.model || '', name: e.display_name || e.slug || e.model || '' })).filter(e => e.id);
  } catch {
    return [];
  }
}

function handleModels(req, res) {
  const anthropic = pathnameOf(req).startsWith('/anthropic/');
  let rows;
  try {
    rows = proxyRouteRows(anthropic ? 'anthropic' : 'openai');
  } catch (e) {
    sendError(res, 500, e.message || String(e), 'configuration_error');
    return;
  }
  // 合并 Codex 模型目录（如果存在）
  const catalogModels = readCodexModelCatalog();
  const seen = new Set(rows.map(r => r.id));
  for (const cm of catalogModels) {
    if (!seen.has(cm.id)) {
      rows.push(cm);
      seen.add(cm.id);
    }
  }
  if (anthropic) {
    sendJson(res, 200, { data: rows.map(m => ({ id: m.id, type: 'model', display_name: m.name, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: rows[0]?.id || null, last_id: rows[rows.length - 1]?.id || null });
    return;
  }
  sendJson(res, 200, { object: 'list', data: rows.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'anybridge' })) });
}

function textPart(value) {
  const text = String(value || '');
  return text ? { type: 'text', text } : null;
}

function dataUrlToImage(url) {
  const m = String(url || '').trim().match(/^data:([^;,]+);base64,(.+)$/i);
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1] || 'image/png', data: m[2] || '' } };
}

function anthropicPartFromOpenAI(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text' || part.type === 'input_text') return textPart(part.text);
  if (part.type === 'image_url' || part.type === 'input_image') {
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return dataUrlToImage(imageUrl || part.image_url);
  }
  return null;
}

function openAIPartFromAnthropic(part, mode = 'chat') {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return { type: mode === 'responses' ? 'input_text' : 'text', text: String(part.text || '') };
  if (part.type === 'image' && part.source?.data) {
    const url = `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
    return mode === 'responses' ? { type: 'input_image', image_url: url } : { type: 'image_url', image_url: { url } };
  }
  return null;
}

function normalizeOpenAI(body) {
  const messages = [];
  let system = String(body.instructions || '').trim();
  const input = Array.isArray(body.messages) ? body.messages : body.input;
  const rows = typeof input === 'string' ? [{ role: 'user', content: input }] : (Array.isArray(input) ? input : []);
  for (const msg of rows) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');
    const raw = msg.content ?? msg.text ?? '';
    if (role === 'system') {
      const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.map(p => p?.text || '').join('\n') : '');
      system = [system, text].filter(Boolean).join('\n');
      continue;
    }
    const content = typeof raw === 'string' ? [textPart(raw)].filter(Boolean) : (Array.isArray(raw) ? raw.map(anthropicPartFromOpenAI).filter(Boolean) : []);
    messages.push({ role, content });
  }
  return { system, messages };
}

function normalizeAnthropicContent(content) {
  if (typeof content === 'string') return [textPart(content)].filter(Boolean);
  if (!Array.isArray(content)) return [];
  return content.map(p => {
    if (!p || typeof p !== 'object') return null;
    if (p.type === 'text') return textPart(p.text);
    if (p.type === 'image') return p;
    return null;
  }).filter(Boolean);
}

function normalizeAnthropic(body) {
  const system = typeof body.system === 'string' ? body.system : (Array.isArray(body.system) ? body.system.map(p => p?.text || '').filter(Boolean).join('\n') : '');
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: normalizeAnthropicContent(m?.content) }))
    .filter(m => m.content.length > 0);
  return { system, messages };
}

function normalizeRequest(kind, body) {
  const base = kind === 'anthropic' ? normalizeAnthropic(body) : normalizeOpenAI(body);
  return {
    kind,
    model: String(body.model || '').trim(),
    system: base.system,
    messages: base.messages,
    tools: Array.isArray(body.tools) ? body.tools : [],
    toolChoice: body.tool_choice || body.toolChoice || null,
    stream: body.stream === true,
    maxTokens: Number(body.max_tokens || body.max_output_tokens || body.max_completion_tokens) || 4096,
    temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : undefined,
    extraParams: passthroughParams(kind, body),
    rawBody: body,
  };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function passthroughParams(kind, body = {}) {
  if (!body || typeof body !== 'object') return {};
  const blocked = new Set([
    'model',
    'messages',
    'input',
    'instructions',
    'system',
    'stream',
    'max_tokens',
    'max_output_tokens',
    'max_completion_tokens',
    'temperature',
    'tools',
    'tool_choice',
    'toolChoice',
    'extra_body',
    // thinking/reasoning 由 sidecar 根据上游格式重新构建，不能透传
    // Codex Desktop 发 thinking.type: "enabled"，但 MiniMax 只接受 "adaptive"/"disabled"
    'thinking',
    'reasoning',
  ]);
  const out = isPlainObject(body.extra_body) ? { ...body.extra_body } : {};
  for (const [key, value] of Object.entries(body)) {
    if (blocked.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function cleanBody(body) {
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
  return body;
}

function estimateTokens(messages, system = '') {
  const text = [system, ...messages.flatMap(m => (m.content || []).map(p => p.type === 'text' ? p.text : '[image]'))].join('\n');
  return Math.max(1, Math.ceil(text.length / 4));
}

function routeAsSlot(route) {
  return {
    modelUid: route.id,
    displayName: route.id,
    supportsImages: route.capabilities?.vision === true,
    useThirdPartyVision: route.enhancement?.thirdPartyVision === true,
    targets: Array.isArray(route.targets) ? route.targets : [],
  };
}

function resolveProxyModel(model, kind) {
  const store = getProxyRoutes();
  if (store.loadError) return { error: `本地代理模型列表读取失败: ${store.loadError}` };
  if (!store.fileExists) return { error: '本地代理模型列表为空。请在「代理 > 模型列表」添加模型。' };

  const requested = String(model || '').trim();
  if (!requested) return { error: '请求缺少 model，无法匹配本地代理模型列表。' };
  const modelId = requested;
  const route = (store.routes || []).find(item => item.id === modelId);
  if (!route) return { error: `模型不在本地代理模型列表中: ${modelId}` };
  if (route.enabled === false) return { error: `本地代理模型已禁用: ${modelId}` };
  if (!Array.isArray(route.targets) || route.targets.length === 0) {
    return { error: `本地代理模型没有可用上游目标: ${modelId}` };
  }
  return { slot: routeAsSlot(route), route };
}

function hasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
}

function positiveInt(value, fallback, min = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function retryPolicy(enhancement = {}) {
  return { enabled: enhancement.retry !== false, maxRetries: positiveInt(enhancement.retryMaxRetries, 5, 0), baseMs: positiveInt(enhancement.retryBaseMs, 600, 1), capMs: positiveInt(enhancement.retryCapMs, 8000, 1), totalMs: positiveInt(enhancement.retryTotalSeconds, 60, 1) * 1000 };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function retryDelay(attempt, policy) { return Math.round(Math.random() * Math.min(policy.capMs, policy.baseMs * Math.pow(2, Math.max(0, attempt - 1)))); }
function retryable(status, code) { return status ? RETRYABLE_STATUS.has(status) : RETRYABLE_CODES.has(code); }

function openAIChatMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const content = (m.content || []).map(p => openAIPartFromAnthropic(p, 'chat')).filter(Boolean);
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content });
  }
  return out;
}

function openAIResponsesInput(messages) {
  return messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: (m.content || []).map(p => openAIPartFromAnthropic(p, 'responses')).filter(Boolean) }));
}

function anthropicTools(tools) {
  const out = [];
  for (const tool of tools || []) {
    if (tool?.name && tool.input_schema) out.push(tool);
    else if (tool?.type === 'function' && tool.function?.name) out.push({ name: tool.function.name, description: tool.function.description || '', input_schema: tool.function.parameters || { type: 'object', properties: {} } });
  }
  return out.length ? out : undefined;
}

function openAITools(tools) {
  const out = [];
  for (const tool of tools || []) {
    if (tool?.type === 'function' && tool.function?.name) out.push(tool);
    else if (tool?.name && tool.input_schema) out.push({ type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.input_schema } });
  }
  return out.length ? out : undefined;
}

function upstreamBody(conn, ctx) {
  const extras = ctx.preserveExtraParams === true ? (ctx.extraParams || {}) : {};
  if (conn.format === 'anthropic') {
    const claudeCodeUnlock = conn.unlockKind === 'claudeCode' ? normalizeClaudeCodeUnlock(conn.unlocks?.claudeCode) : null;
    if (claudeCodeUnlock) {
      return buildClaudeCodeUnlockPayload({
        model: conn.model,
        messages: ctx.messages,
        maxTokens: ctx.maxTokens,
        stream: false,
      });
    }
    return cleanBody({ ...extras, model: conn.model, system: ctx.system || undefined, messages: ctx.messages, max_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, tools: anthropicTools(ctx.tools), tool_choice: ctx.toolChoice || undefined });
  }
  // wireApi=chat: 仅当客户端发来 Responses API 请求时，才做 Responses→Chat 转换
  if (conn.wireApi === 'chat' && ctx.kind === 'responses' && ctx.rawBody) {
    const chatBody = responsesToChatCompletions(ctx.rawBody, conn.codexChatReasoning);
    chatBody.model = conn.model;
    return cleanBody({ ...extras, ...chatBody });
  }
  const useResponses = String(conn.apiPath || '').toLowerCase().includes('/responses');
  const codexUnlock = conn.unlockKind === 'codex' ? normalizeCodexUnlock(conn.unlocks?.codex) : null;
  if (useResponses) {
    const input = openAIResponsesInput(ctx.messages);
    const body = {
      ...extras,
      model: conn.model,
      input,
      instructions: ctx.system || undefined,
      max_output_tokens: codexUnlock ? undefined : ctx.maxTokens,
      temperature: ctx.temperature,
      stream: false,
      tools: openAITools(ctx.tools),
      tool_choice: ctx.toolChoice || undefined,
    };
    if (codexUnlock) {
      const promptCacheKey = buildCodexPromptCacheKey(input);
      body.include = codexUnlock.include;
      body.prompt_cache_key = promptCacheKey;
      body.parallel_tool_calls = true;
      body.reasoning = { effort: 'medium' };
      body.store = false;
      body.text = { verbosity: 'low' };
      body.client_metadata = buildCodexUnlockClientMetadata(promptCacheKey);
      body.tool_choice = body.tools ? 'auto' : undefined;
    }
    return cleanBody(body);
  }
  return cleanBody({ ...extras, model: conn.model, messages: openAIChatMessages(ctx.system, ctx.messages), max_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, tools: openAITools(ctx.tools), tool_choice: ctx.toolChoice || undefined });
}

function authHeaders(conn) {
  if (conn.format === 'openai' && conn.unlockKind === 'codex') return codexUnlockHeaders(conn);
  if (conn.format === 'openai') return { authorization: `Bearer ${conn.apiKey}` };
  if (conn.format === 'anthropic' && conn.unlockKind === 'claudeCode') return claudeCodeUnlockHeaders(conn);
  const h = { 'anthropic-version': '2023-06-01' };
  if (conn.authScheme === 'bearer') h.authorization = `Bearer ${conn.apiKey}`;
  else h['x-api-key'] = conn.apiKey;
  return h;
}

function requestUpstream(conn, payload, enhancement = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const started = Date.now();
    const extraHeaders = {};
    if (enhancement.customHeadersEnabled === true && Array.isArray(enhancement.customHeaders)) {
      for (const h of enhancement.customHeaders) {
        if (h && h.key) extraHeaders[h.key] = h.value;
      }
    }
    const req = https.request({ agent: httpsAgentFor(AGENT), hostname: conn.host, port: 443, path: conn.apiPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, ...authHeaders(conn), ...extraHeaders } }, apiRes => {
      const chunks = [];
      apiRes.on('data', c => chunks.push(c));
      apiRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: apiRes.statusCode || 0, headers: apiRes.headers || {}, text, json, durationMs: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.setTimeout(300000);
    req.end(body);
  });
}

// ── 流式请求：返回 response stream 供调用方逐块消费 ──
function requestUpstreamStream(conn, payload, enhancement = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const started = Date.now();
    const extraHeaders = {};
    if (enhancement.customHeadersEnabled === true && Array.isArray(enhancement.customHeaders)) {
      for (const h of enhancement.customHeaders) {
        if (h && h.key) extraHeaders[h.key] = h.value;
      }
    }
    const req = https.request({ agent: httpsAgentFor(AGENT), hostname: conn.host, port: 443, path: conn.apiPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, ...authHeaders(conn), ...extraHeaders } }, apiRes => {
      resolve({
        statusCode: apiRes.statusCode || 0,
        headers: apiRes.headers || {},
        response: apiRes,
        durationMs: Date.now() - started,
      });
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.setTimeout(300000);
    req.end(body);
  });
}

// 读取完整 error response body（非 2xx 时收集错误信息）
async function collectStreamBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// 解析上游 SSE 流，逐块 yield JSON 对象
async function* parseSSEStream(response) {
  let buffer = '';
  for await (const chunk of response) {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch {}
    }
  }
  const trimmed = buffer.trim();
  if (trimmed.startsWith('data: ')) {
    const data = trimmed.slice(6);
    if (data !== '[DONE]') { try { yield JSON.parse(data); } catch {} }
  }
}

function extractText(conn, json) {
  if (!json) return '';
  if (conn.format === 'anthropic') return (json.content || []).map(p => p?.text || '').filter(Boolean).join('');
  if (typeof json.output_text === 'string') return json.output_text;
  const chatText = json.choices?.[0]?.message?.content;
  if (typeof chatText === 'string') return chatText;
  if (Array.isArray(chatText)) return chatText.map(p => p?.text || '').join('');
  if (Array.isArray(json.output)) return json.output.flatMap(i => i?.content || []).map(p => p?.text || p?.content || '').filter(Boolean).join('');
  return '';
}

function usageFrom(conn, json, fallbackIn, fallbackOut) {
  const u = json?.usage || {};
  if (conn.format === 'anthropic') return { inputTokens: Number(u.input_tokens) || fallbackIn, outputTokens: Number(u.output_tokens) || fallbackOut, cachedTokens: Number(u.cache_read_input_tokens) || 0 };
  return { inputTokens: Number(u.input_tokens || u.prompt_tokens) || fallbackIn, outputTokens: Number(u.output_tokens || u.completion_tokens) || fallbackOut, cachedTokens: Number(u.input_tokens_details?.cached_tokens || u.prompt_tokens_details?.cached_tokens) || 0 };
}

function upstreamMessage(r) { return r.json?.error?.message || r.json?.message || r.json?.detail || r.text || `HTTP ${r.statusCode}`; }

function compactText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return { error: { message: String(text || '') } }; }
}

function isRateLimitOrHighLoad(failure = {}) {
  const status = Number(failure.statusCode) || 0;
  const text = `${failure.reason || ''} ${failure.message || ''}`;
  if (status === 429 || status === 529) return true;
  if (status === 503 && /service unavailable|overloaded|temporarily|rate limit|too many requests/i.test(text)) return true;
  return /负载.*上限|达到上限|get_channel_failed|rate limit|too many requests|限流|频率|overloaded/i.test(text);
}

function classifyFailures(failures = []) {
  const text = failures.map(f => `${f.reason || ''} ${f.message || ''}`).join(' ');
  if (failures.some(f => f.statusCode === 401) || /unauthorized|invalid api key|api key|认证|鉴权/i.test(text)) {
    return { status: 401, type: 'authentication_error' };
  }
  if (failures.some(f => f.statusCode === 403) || /permission|forbidden|无权限|未开通/i.test(text)) {
    return { status: 403, type: 'permission_error' };
  }
  if (failures.some(isRateLimitOrHighLoad)) {
    return { status: 429, type: 'rate_limit_error' };
  }
  if (failures.some(f => f.statusCode === 400)) return { status: 400, type: 'invalid_request_error' };
  if (failures.some(f => f.statusCode === 404)) return { status: 404, type: 'not_found_error' };
  if (failures.some(f => f.statusCode >= 500)) return { status: 503, type: 'api_error' };
  return { status: 502, type: 'upstream_error' };
}

function failureMessage(failure = {}) {
  if (typeof failure === 'string') return failure;
  const status = failure.statusCode ? `HTTP ${failure.statusCode}` : (failure.code || '失败');
  const details = failure.message ? `: ${failure.message}` : '';
  return `${failure.providerName || 'provider'}: ${status}${details}`;
}

async function maybeVisionFallback(ctx, slot, providers, mapConfig) {
  if (!hasImage(ctx.messages) || slot.useThirdPartyVision !== true || mapConfig?.enhancement?.imageFallback === false) return ctx;
  const visionModels = mapConfig?.visionModels?.imageModels || [];
  if (!visionModels.length) throw new Error(`模型「${slot.displayName || slot.modelUid || ctx.model}」启用了第三方图片理解，但代理增强里没有配置图片理解模型。`);
  const result = await preprocessImagesWithThirdPartyVision(ctx.messages, visionModels, providers, { requestId: crypto.randomUUID(), requestedModel: ctx.model, slotModelUid: slot.modelUid || ctx.model, slotDisplayName: slot.displayName || ctx.model });
  return { ...ctx, messages: result.messages };
}

// ── 速率限制 ──
const rateLimitBuckets = new Map();
function checkRateLimit(model, rpm) {
  const now = Date.now();
  const windowMs = 60000;
  const bucket = rateLimitBuckets.get(model);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(model, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= rpm) return false;
  bucket.count++;
  return true;
}

// ── 请求日志 ──
function logRequest(ctx, phase) {
  try {
    const dir = path.join(configDir(), 'proxy-logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

async function execute(ctx) {
  const resolved = resolveProxyModel(ctx.model, ctx.kind);
  if (resolved.error) throw new Error(resolved.error);
  const providers = loadProviders();
  const mapConfig = loadModelMapConfig();
  const enhancement = { ...(mapConfig?.enhancement || {}) };
  if (resolved.route?.enhancement) {
    if (resolved.route.enhancement.retry === false) enhancement.retry = false;
    if (resolved.route.enhancement.autoRouting === false) enhancement.autoRouting = false;
  }
  const preserveExtraParams = resolved.route?.enhancement?.preserveExtraParams === true;
  const rawProviderErrors = resolved.route?.enhancement?.rawProviderErrors !== false;
  const effective = await maybeVisionFallback(ctx, resolved.slot, providers, mapConfig);
  effective.preserveExtraParams = preserveExtraParams;

  // ── 系统提示词注入 ──
  if (enhancement.systemPromptPrefixEnabled === true && enhancement.systemPromptPrefix) {
    effective.system = [enhancement.systemPromptPrefix, effective.system].filter(Boolean).join('\n\n') || undefined;
  }

  // ── 工具过滤 ──
  if (enhancement.toolFilterEnabled === true && enhancement.toolFilterMode && Array.isArray(effective.tools) && effective.tools.length) {
    const filterSet = new Set(enhancement.toolFilterList.map(n => String(n || '').trim()).filter(Boolean));
    if (filterSet.size) {
      effective.tools = effective.tools.filter(tool => {
        const name = tool?.name || tool?.function?.name || '';
        if (enhancement.toolFilterMode === 'allow') return filterSet.has(name);
        if (enhancement.toolFilterMode === 'deny') return !filterSet.has(name);
        return true;
      });
    }
  }

  // ── 强制 tool_choice ──
  if (enhancement.toolFilterEnabled === true && enhancement.forceToolChoice) {
    effective.toolChoice = enhancement.forceToolChoice;
  }

  // ── 请求参数覆盖 ──
  if (enhancement.paramOverridesEnabled === true && enhancement.paramOverrides && typeof enhancement.paramOverrides === 'object') {
    Object.assign(effective, enhancement.paramOverrides);
  }

  // ── 速率限制 ──
  if (enhancement.rateLimitEnabled === true && enhancement.rateLimitRpm > 0) {
    const allowed = checkRateLimit(ctx.model, enhancement.rateLimitRpm);
    if (!allowed) {
      throw new LocalProxyUpstreamError(`请求频率超限：${enhancement.rateLimitRpm} RPM`, {
        status: 429, type: 'rate_limit_error',
      });
    }
  }

  // ── 请求日志 ──
  if (enhancement.requestLogging) {
    logRequest(ctx, 'request');
  }

  const targets = enhancement.autoRouting === false ? [resolved.slot.targets[0]] : [...resolved.slot.targets];
  const policy = retryPolicy(enhancement);
  const failures = [];
  for (const target of targets) {
    const conn = resolveTarget(target, providers);
    if (conn.error) { failures.push({ providerName: target.providerId, message: conn.error }); continue; }
    recordRequest({ provider: conn.providerName, requestedModel: ctx.model, resolvedModel: conn.model });
    const payload = upstreamBody(conn, effective);
    const started = Date.now();
    let retryCount = 0;
    while (true) {
      try {
        // ── 真流式路径：wireApi=chat 且客户端请求 stream（仅 Responses API）──
        if (conn.wireApi === 'chat' && ctx.kind === 'responses' && effective.stream === true) {
          const r = await requestUpstreamStream(conn, payload, enhancement);
          recordLatency(r.durationMs);
          if (r.statusCode >= 200 && r.statusCode < 300) {
            const extraRespHeaders = {};
            if (enhancement.customHeadersEnabled === true && Array.isArray(enhancement.responseHeaders)) {
              for (const h of enhancement.responseHeaders) {
                if (h && h.key) extraRespHeaders[h.key] = h.value;
              }
            }
            return { conn, stream: true, upstreamResponse: r.response, extraHeaders: extraRespHeaders };
          }
          // 非 2xx：收集错误 body，走重试逻辑
          const errorText = await collectStreamBody(r.response);
          const errorJson = safeParse(errorText);
          const msg = compactText(upstreamMessage({ statusCode: r.statusCode, json: errorJson, text: errorText }));
          if (policy.enabled && retryCount < policy.maxRetries && retryable(r.statusCode) && Date.now() - started < policy.totalMs) {
            retryCount++; recordRetry({ count: 1, reason: `HTTP ${r.statusCode}: ${msg}` }); await sleep(retryDelay(retryCount, policy)); continue;
          }
          failures.push({
            providerName: conn.providerName,
            statusCode: r.statusCode,
            headers: r.headers,
            body: errorText,
            message: msg,
            wireApi: conn.wireApi,
          });
          break;
        }
        // ── 非流式路径（原有逻辑）──
        const r = await requestUpstream(conn, payload, enhancement);
        recordLatency(r.durationMs);
        if (r.statusCode >= 200 && r.statusCode < 300) {
          const text = extractText(conn, r.json);
          const usage = usageFrom(conn, r.json, estimateTokens(effective.messages, effective.system), Math.ceil(text.length / 4));
          recordUsage(usage);
          if (enhancement.requestLogging) {
            logRequest({ ...ctx, _response: { statusCode: r.statusCode, text } }, 'response');
          }
          // ── 自定义响应头 ──
          const extraRespHeaders = {};
          if (enhancement.customHeadersEnabled === true && Array.isArray(enhancement.responseHeaders)) {
            for (const h of enhancement.responseHeaders) {
              if (h && h.key) extraRespHeaders[h.key] = h.value;
            }
          }
          // wireApi=chat: 用 chatCompletionToResponse 转换完整响应（含 reasoning/tool_calls）
          const responseObj = conn.wireApi === 'chat' && r.json
            ? chatCompletionToResponse(r.json, conn.model)
            : null;
          return { conn, text, json: r.json, usage, extraHeaders: extraRespHeaders, responseObj };
        }
        const msg = compactText(upstreamMessage(r));
        if (policy.enabled && retryCount < policy.maxRetries && retryable(r.statusCode) && Date.now() - started < policy.totalMs) {
          retryCount++; recordRetry({ count: 1, reason: `HTTP ${r.statusCode}: ${msg}` }); await sleep(retryDelay(retryCount, policy)); continue;
        }
        failures.push({
          providerName: conn.providerName,
          statusCode: r.statusCode,
          headers: r.headers,
          body: r.text,
          message: msg,
          wireApi: conn.wireApi,
        });
        break;
      } catch (e) {
        const code = e?.code || e?.message;
        if (policy.enabled && retryCount < policy.maxRetries && retryable(0, code) && Date.now() - started < policy.totalMs) {
          retryCount++; recordRetry({ count: 1, reason: code || 'network error' }); await sleep(retryDelay(retryCount, policy)); continue;
        }
        failures.push({ providerName: conn.providerName, code, message: e.message || String(e) }); break;
      }
    }
  }
  const lastUpstreamResponse = [...failures].reverse().find(f => f.statusCode && typeof f.body === 'string');
  if (lastUpstreamResponse && rawProviderErrors) {
    const classification = classifyFailures([lastUpstreamResponse]);
    recordError({
      provider: 'local-proxy',
      message: `${lastUpstreamResponse.providerName || 'provider'}: HTTP ${lastUpstreamResponse.statusCode}: ${lastUpstreamResponse.message || ''}`,
    });
    throw new LocalProxyUpstreamError(`upstream HTTP ${lastUpstreamResponse.statusCode}`, {
      status: classification.status,
      type: classification.type,
      upstreamResponse: {
        statusCode: classification.status,
        headers: lastUpstreamResponse.headers || {},
        body: lastUpstreamResponse.wireApi === 'chat' && lastUpstreamResponse.body
          ? JSON.stringify(chatErrorToResponseError(safeParse(lastUpstreamResponse.body)))
          : lastUpstreamResponse.body,
      },
    });
  }

  const classification = classifyFailures(failures);
  const message = failures.length ? `AnyBridge 本地代理没有可用目标：${failures.map(failureMessage).join('；')}` : 'AnyBridge 本地代理没有可用目标。';
  recordError({ provider: 'local-proxy', message });
  throw new LocalProxyUpstreamError(message, classification);
}

function openAIUsage(usage = {}) {
  const prompt = Number(usage.inputTokens) || 0, completion = Number(usage.outputTokens) || 0;
  const cached = Number(usage.cachedTokens) || 0;
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}
function anthropicUsage(usage = {}) {
  const out = { input_tokens: Number(usage.inputTokens) || 0, output_tokens: Number(usage.outputTokens) || 0 };
  const cached = Number(usage.cachedTokens) || 0;
  if (cached > 0) out.cache_read_input_tokens = cached;
  return out;
}
function sse(res, event, data) { if (event) res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); }

function sendOpenAIChat(ctx, res, result) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const extra = result.extraHeaders || {};
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    sse(res, null, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if (result.text) sse(res, null, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }] });
    sse(res, null, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n'); res.end(); return;
  }
  sendJson(res, 200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage: openAIUsage(result.usage) }, extra);
}

function responseObject(ctx, result, id) {
  const input = Number(result.usage?.inputTokens) || 0;
  const output = Number(result.usage?.outputTokens) || 0;
  const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
  const cached = Number(result.usage?.cachedTokens) || 0;
  if (cached > 0) usage.input_tokens_details = { cached_tokens: cached };
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: ctx.model, output_text: result.text, output: [{ type: 'message', id: `msg-${crypto.randomUUID()}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: result.text }] }], usage };
}

function sendOpenAIResponses(ctx, res, result) {
  const extra = result.extraHeaders || {};

  // ── 真流式：wireApi=chat 且 stream=true，逐块转换 Chat SSE → Responses SSE ──
  if (result.stream === true && result.conn?.wireApi === 'chat') {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    const converter = createResponsesSSEFromChat(ctx.model, result.conn?.codexChatReasoning?.outputFormat);
    (async () => {
      try {
        for await (const chunk of parseSSEStream(result.upstreamResponse)) {
          const events = converter.write(chunk);
          for (const ev of events) sse(res, ev.type, ev);
        }
        const finalEvents = converter.flush();
        for (const ev of finalEvents) sse(res, ev.type, ev);
        // 从最终响应中记录 usage
        const finalResp = converter.getResponse();
        const usage = usageFrom(result.conn, { usage: finalResp.usage }, 0, 0);
        recordUsage(usage);
      } catch (e) {
        // 流中途出错，尽量优雅结束
        try { sse(res, 'error', { type: 'error', message: e?.message || 'stream error' }); } catch {}
      } finally {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    })();
    return;
  }

  // ── 非流式或假流式（原有逻辑）──
  const id = `resp-${crypto.randomUUID()}`;
  // wireApi=chat 时使用预转换的完整响应对象（含 reasoning/tool_calls）
  const obj = result.responseObj || responseObject(ctx, result, id);
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    sse(res, 'response.created', { type: 'response.created', response: { ...obj, output: [], output_text: '' } });
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: obj.output[0].id, status: 'in_progress', role: 'assistant', content: [] } });
    sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: obj.output[0].id, output_index: 0, content_index: 0, delta: result.text });
    sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: obj.output[0].id, output_index: 0, content_index: 0, text: result.text });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: obj.output[0] });
    sse(res, 'response.completed', { type: 'response.completed', response: obj });
    res.write('data: [DONE]\n\n'); res.end(); return;
  }
  sendJson(res, 200, obj, extra);
}

function sendAnthropic(ctx, res, result) {
  const message = { id: `msg_${crypto.randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: ctx.model, content: [{ type: 'text', text: result.text }], stop_reason: 'end_turn', stop_sequence: null, usage: anthropicUsage(result.usage) };
  const extra = result.extraHeaders || {};
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    if (result.text) sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.text } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: anthropicUsage(result.usage) });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end(); return;
  }
  sendJson(res, 200, message, extra);
}

function handleCountTokens(body, res) {
  const ctx = normalizeRequest('anthropic', body);
  sendJson(res, 200, { input_tokens: estimateTokens(ctx.messages, ctx.system) });
}

export async function handleLocalProxyRequest(req, res, body) {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); res.end(); return; }
  const auth = validateAuth(req);
  if (!auth.ok) { sendError(res, auth.status, auth.message, 'authentication_error'); return; }
  const p = pathnameOf(req);
  if (req.method === 'GET' && (p === '/v1/models' || p === '/anthropic/v1/models')) { handleModels(req, res); return; }
  let json;
  try { json = body && body.length ? JSON.parse(body.toString('utf8')) : {}; }
  catch (e) { sendError(res, 400, `请求 JSON 解析失败: ${e.message}`); return; }
  if (p.endsWith('/messages/count_tokens')) { handleCountTokens(json, res); return; }
  try {
    if (p === '/v1/chat/completions') { const ctx = normalizeRequest('openai', json); sendOpenAIChat(ctx, res, await execute(ctx)); return; }
    if (p === '/v1/responses') { const ctx = normalizeRequest('responses', json); sendOpenAIResponses(ctx, res, await execute(ctx)); return; }
    if (p === '/anthropic/v1/messages' || p === '/anthropic/messages') { const ctx = normalizeRequest('anthropic', json); sendAnthropic(ctx, res, await execute(ctx)); return; }
    sendError(res, 404, `未知本地代理路径: ${p}`);
  } catch (e) {
    if (e.upstreamResponse) {
      sendRaw(res, e.upstreamResponse.statusCode || e.status || 502, e.upstreamResponse.body, e.upstreamResponse.headers);
      return;
    }
    const status = Number(e.status) || 502;
    const type = e.type || 'upstream_error';
    const message = e.message || String(e);
    if (p.startsWith('/anthropic/')) {
      sendAnthropicError(res, status, message, type);
      return;
    }
    sendError(res, status, message, type);
  }
}
