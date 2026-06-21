// local-proxy.js - OpenAI/Anthropic compatible local reverse proxy.
// Reuses AnyBridge model slots, provider routing, retry config and vision fallback.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { getSlots } from './config-cache.js';
import { loadModelMapConfig, loadProviders, resolveTarget } from './provider-pool.js';
import { preprocessImagesWithThirdPartyVision } from './vision-fallback.js';
import { httpsAgentFor } from './system-proxy.js';
import { recordError, recordLatency, recordRequest, recordRetry, recordUsage } from './stats.js';

const AGENT = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
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

function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: type } });
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

function modelRows() {
  const rows = [];
  for (const [id, entry] of getSlots()) {
    if (!entry || !entry.data) continue;
    if (entry.kind === 'slot') {
      const slot = entry.data;
      if (slot.enabled === false) continue;
      if (!Array.isArray(slot.targets) || slot.targets.length === 0) continue;
      rows.push({ id, name: slot.displayName || id });
    } else if (entry.kind === 'injected') {
      const item = entry.data;
      if (!item.providerId || !String(item.model || '').trim()) continue;
      rows.push({ id, name: item.label || id });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function handleModels(req, res) {
  const rows = modelRows();
  if (pathnameOf(req).startsWith('/anthropic/')) {
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
    model: String(body.model || '').trim() || 'anybridge-default',
    system: base.system,
    messages: base.messages,
    tools: Array.isArray(body.tools) ? body.tools : [],
    toolChoice: body.tool_choice || body.toolChoice || null,
    stream: body.stream === true,
    maxTokens: Number(body.max_tokens || body.max_output_tokens || body.max_completion_tokens) || 4096,
    temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : undefined,
  };
}

function estimateTokens(messages, system = '') {
  const text = [system, ...messages.flatMap(m => (m.content || []).map(p => p.type === 'text' ? p.text : '[image]'))].join('\n');
  return Math.max(1, Math.ceil(text.length / 4));
}

function injectedAsSlot(item) {
  if (!item || !item.providerId || !String(item.model || '').trim()) return null;
  return { modelUid: item.modelUid, displayName: item.label || item.modelUid, useThirdPartyVision: item.useThirdPartyVision === true, targets: [{ providerId: item.providerId, model: item.model, apiFormat: item.apiFormat || item.api_format, apiPath: item.apiPath || item.api_path, unlock: item.unlock || null }] };
}

function resolveSlot(model) {
  const slots = getSlots();
  let entry = slots.get(model);
  if (!entry && (!model || model === 'anybridge-default')) {
    for (const [, candidate] of slots) {
      if (candidate?.kind === 'slot' && candidate.data?.enabled !== false && Array.isArray(candidate.data?.targets) && candidate.data.targets.length) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return { error: `模型映射不存在: ${model}` };
  if (entry.kind === 'slot') {
    const slot = entry.data;
    if (slot.enabled === false) return { error: `模型映射已禁用: ${model}` };
    if (!Array.isArray(slot.targets) || slot.targets.length === 0) return { error: `模型映射没有配置目标: ${model}` };
    return { slot };
  }
  const slot = injectedAsSlot(entry.data);
  return slot ? { slot } : { error: `模型槽位尚未配置目标: ${model}` };
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
  if (conn.format === 'anthropic') {
    return { model: conn.model, system: ctx.system || undefined, messages: ctx.messages, max_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, tools: anthropicTools(ctx.tools) };
  }
  const useResponses = String(conn.apiPath || '').toLowerCase().includes('/responses');
  if (useResponses) return { model: conn.model, input: openAIResponsesInput(ctx.messages), instructions: ctx.system || undefined, max_output_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, tools: openAITools(ctx.tools) };
  return { model: conn.model, messages: openAIChatMessages(ctx.system, ctx.messages), max_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, tools: openAITools(ctx.tools) };
}

function authHeaders(conn) {
  if (conn.format === 'openai') return { authorization: `Bearer ${conn.apiKey}` };
  const h = { 'anthropic-version': '2023-06-01' };
  if (conn.authScheme === 'bearer') h.authorization = `Bearer ${conn.apiKey}`;
  else h['x-api-key'] = conn.apiKey;
  return h;
}

function requestUpstream(conn, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const started = Date.now();
    const req = https.request({ agent: httpsAgentFor(AGENT), hostname: conn.host, port: 443, path: conn.apiPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, ...authHeaders(conn) } }, apiRes => {
      const chunks = [];
      apiRes.on('data', c => chunks.push(c));
      apiRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: apiRes.statusCode || 0, text, json, durationMs: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.setTimeout(300000);
    req.end(body);
  });
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

async function maybeVisionFallback(ctx, slot, providers, mapConfig) {
  if (!hasImage(ctx.messages) || slot.useThirdPartyVision !== true || mapConfig?.enhancement?.imageFallback === false) return ctx;
  const visionModels = mapConfig?.visionModels?.imageModels || [];
  if (!visionModels.length) throw new Error(`模型「${slot.displayName || slot.modelUid || ctx.model}」启用了第三方图片理解，但代理增强里没有配置图片理解模型。`);
  const result = await preprocessImagesWithThirdPartyVision(ctx.messages, visionModels, providers, { requestId: crypto.randomUUID(), requestedModel: ctx.model, slotModelUid: slot.modelUid || ctx.model, slotDisplayName: slot.displayName || ctx.model });
  return { ...ctx, messages: result.messages };
}

async function execute(ctx) {
  const resolved = resolveSlot(ctx.model);
  if (resolved.error) throw new Error(resolved.error);
  const providers = loadProviders();
  const mapConfig = loadModelMapConfig();
  const effective = await maybeVisionFallback(ctx, resolved.slot, providers, mapConfig);
  const enhancement = mapConfig?.enhancement || {};
  const targets = enhancement.autoRouting === false ? [resolved.slot.targets[0]] : [...resolved.slot.targets];
  const policy = retryPolicy(enhancement);
  const failures = [];
  for (const target of targets) {
    const conn = resolveTarget(target, providers);
    if (conn.error) { failures.push(conn.error); continue; }
    recordRequest({ provider: conn.providerName, requestedModel: ctx.model, resolvedModel: conn.model });
    const payload = upstreamBody(conn, effective);
    const started = Date.now();
    let retryCount = 0;
    while (true) {
      try {
        const r = await requestUpstream(conn, payload);
        recordLatency(r.durationMs);
        if (r.statusCode >= 200 && r.statusCode < 300) {
          const text = extractText(conn, r.json);
          const usage = usageFrom(conn, r.json, estimateTokens(effective.messages, effective.system), Math.ceil(text.length / 4));
          recordUsage(usage);
          return { conn, text, json: r.json, usage };
        }
        const msg = `HTTP ${r.statusCode}: ${upstreamMessage(r)}`;
        if (policy.enabled && retryCount < policy.maxRetries && retryable(r.statusCode) && Date.now() - started < policy.totalMs) {
          retryCount++; recordRetry({ count: 1, reason: msg }); await sleep(retryDelay(retryCount, policy)); continue;
        }
        failures.push(`${conn.providerName}: ${msg}`); break;
      } catch (e) {
        const code = e?.code || e?.message;
        if (policy.enabled && retryCount < policy.maxRetries && retryable(0, code) && Date.now() - started < policy.totalMs) {
          retryCount++; recordRetry({ count: 1, reason: code || 'network error' }); await sleep(retryDelay(retryCount, policy)); continue;
        }
        failures.push(`${conn.providerName}: ${e.message || e}`); break;
      }
    }
  }
  const message = failures.length ? `AnyBridge 本地代理没有可用目标：${failures.join('；')}` : 'AnyBridge 本地代理没有可用目标。';
  recordError({ provider: 'local-proxy', message });
  throw new Error(message);
}

function openAIUsage(usage = {}) {
  const prompt = Number(usage.inputTokens) || 0, completion = Number(usage.outputTokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
function anthropicUsage(usage = {}) { return { input_tokens: Number(usage.inputTokens) || 0, output_tokens: Number(usage.outputTokens) || 0 }; }
function sse(res, event, data) { if (event) res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); }

function sendOpenAIChat(ctx, res, result) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8' }));
    sse(res, null, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if (result.text) sse(res, null, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }] });
    sse(res, null, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n'); res.end(); return;
  }
  sendJson(res, 200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: ctx.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage: openAIUsage(result.usage) });
}

function responseObject(ctx, result, id) {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: ctx.model, output_text: result.text, output: [{ type: 'message', id: `msg-${crypto.randomUUID()}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: result.text }] }], usage: { input_tokens: Number(result.usage?.inputTokens) || 0, output_tokens: Number(result.usage?.outputTokens) || 0, total_tokens: (Number(result.usage?.inputTokens) || 0) + (Number(result.usage?.outputTokens) || 0) } };
}

function sendOpenAIResponses(ctx, res, result) {
  const id = `resp-${crypto.randomUUID()}`;
  const obj = responseObject(ctx, result, id);
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8' }));
    sse(res, null, { type: 'response.created', response: { ...obj, output: [], output_text: '' } });
    sse(res, null, { type: 'response.output_text.delta', item_id: obj.output[0].id, output_index: 0, content_index: 0, delta: result.text });
    sse(res, null, { type: 'response.completed', response: obj });
    res.write('data: [DONE]\n\n'); res.end(); return;
  }
  sendJson(res, 200, obj);
}

function sendAnthropic(ctx, res, result) {
  const message = { id: `msg_${crypto.randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: ctx.model, content: [{ type: 'text', text: result.text }], stop_reason: 'end_turn', stop_sequence: null, usage: anthropicUsage(result.usage) };
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8' }));
    sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    if (result.text) sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.text } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: anthropicUsage(result.usage) });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end(); return;
  }
  sendJson(res, 200, message);
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
    sendError(res, 502, e.message || String(e), 'upstream_error');
  }
}
