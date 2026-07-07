// local-proxy.js - OpenAI/Anthropic compatible local reverse proxy.
// Reuses AnyBridge model slots, provider routing, retry config and vision fallback.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  applyCodexUnlockRequiredFields,
  buildClaudeCodeUnlockPayload,
  claudeCodeUnlockForTarget,
  claudeCodeUnlockHeaders,
  codexUnlockForTarget,
  codexUnlockHeaders,
} from './lib/codex-unlock.js';
import { getCodexProxyRoutes, getProxyRoutes } from './config-cache.js';
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
import { DEFAULT_SELF_HEAL_CONFIG, tryHeal } from './lib/self-heal.js';
import { executeSearchWithFailover } from './handlers/search-sources.js';

const AGENT = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
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

function geminiGenerateContentMatch(pathname) {
  return String(pathname || '').match(/^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
}

function isGeminiGenerateContentPath(pathname) {
  return !!geminiGenerateContentMatch(pathname);
}

function geminiModelFromPath(pathname) {
  const m = geminiGenerateContentMatch(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}

function geminiMethodFromPath(pathname) {
  const m = geminiGenerateContentMatch(pathname);
  return m ? m[2] : '';
}

export function isLocalProxyRequest(req) {
  const p = pathnameOf(req);
  return p === '/v1/models'
    || p === '/v1/chat/completions'
    || p === '/v1/responses'
    || p === '/v1beta/models'
    || isGeminiGenerateContentPath(p)
    || p === '/codex/v1/models'
    || p === '/codex/v1/chat/completions'
    || p === '/codex/v1/responses'
    || p === '/anthropic/v1/models'
    || p === '/__byok/web-search/test'
    || p === '/anthropic/v1/messages'
    || p === '/anthropic/messages'
    || p === '/anthropic/v1/messages/count_tokens'
    || p === '/anthropic/messages/count_tokens';
}

function proxyScopeForPath(pathname) {
  return String(pathname || '').startsWith('/codex/') ? 'codex' : 'default';
}

function isCodexProxyScope(scope) {
  return scope === 'codex';
}

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-beta',
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

function sendGeminiError(res, status, message, type = 'INVALID_ARGUMENT') {
  sendJson(res, status, { error: { code: status, message, status: type } });
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
  return String(req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers['api-key'] || '').trim();
}

function validateAuth(req) {
  const expected = String(readLocalConfig().LOCAL_PROXY_KEY || '').trim();
  if (!expected) return { ok: false, status: 503, message: 'AnyBridge 本地代理 key 尚未生成，请在代理页生成 key。' };
  if (authToken(req) !== expected) return { ok: false, status: 401, message: 'AnyBridge 本地代理 key 无效。' };
  return { ok: true };
}

// ─── 本地代理模型 ID 命名规则(跟 Devin 显示名设置一样:只存规则,运行时套用,不硬写 route.id)───
const RENAME_TEMPLATE_VARS = ['prefix', 'model', 'provider', 'suffix'];

function renderProxyRouteIdTemplate(tpl, vars) {
  // 多次扫描直到稳定,支持"占位符的值里再嵌占位符"(例如后缀 ({provider}))
  let out = String(tpl || '');
  const MAX = 8;
  for (let pass = 0; pass < MAX; pass++) {
    let prev = out;
    for (const k of RENAME_TEMPLATE_VARS) {
      out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k] == null ? '' : String(vars[k]));
    }
    if (out === prev) break;
  }
  return out.trim();
}

/** 获取命名规则(从 model-map.json 的 proxyRouteRenameRule 字段)。*/
function proxyRouteRenameRule() {
  const map = loadModelMapConfig();
  const rule = map && map.proxyRouteRenameRule;
  if (!rule || typeof rule !== 'object') return null;
  // 规则被禁用 → 不改名
  if (rule.enabled === false) return null;
  const prefix = String(rule.prefix || '');
  const suffix = String(rule.suffix || '');
  const template = String(rule.template || '');
  // 空规则 = 不改名
  if (!prefix && !suffix && !template) return null;
  const mode = String(rule.mode || 'simple');
  const tpl = mode === 'custom' && template ? template : '{prefix}{model}{suffix}';
  return { mode, prefix, suffix, template, tpl };
}

/** 获取供应商名(从 providers.json 的 id→name 映射)。*/
function providerNameById(providerId) {
  const providers = loadProviders();
  const p = providers instanceof Map
    ? providers.get(providerId)
    : (Array.isArray(providers) ? providers.find(p => p.id === providerId) : null);
  return p ? (p.name || p.id || '') : '';
}

/** 把 route.id 按命名规则渲染成"对外暴露的新 ID"。规则为空时返回原始 id。*/
function renderedProxyRouteId(route, options = {}) {
  if (options.applyRename === false) return route.id;
  if (route?.idFromRenameRule === true || route?.id_from_rename_rule === true) return route.id;
  const rule = proxyRouteRenameRule();
  if (!rule) return route.id;
  const firstTarget = Array.isArray(route.targets) && route.targets.length > 0 ? route.targets[0] : null;
  const providerName = firstTarget ? providerNameById(firstTarget.providerId) : '';
  const newId = renderProxyRouteIdTemplate(rule.tpl, {
    prefix: rule.prefix,
    model: route.id,
    provider: providerName,
    suffix: rule.suffix,
  });
  return newId || route.id;
}

function routeExposedFormats(route) {
  const formats = Array.isArray(route?.exposedFormats) ? route.exposedFormats : [];
  const normalized = formats.map(fmt => String(fmt || '').trim().toLowerCase()).filter(Boolean);
  return normalized.length ? normalized : ['openai', 'anthropic', 'gemini'];
}

function localProxyKind(kind) {
  if (kind === 'anthropic') return 'anthropic';
  if (kind === 'gemini') return 'gemini';
  return 'openai';
}

function routeSupportsKind(route, kind) {
  return routeExposedFormats(route).includes(localProxyKind(kind));
}

function routeAliases(route, options = {}) {
  const aliases = [String(route.id || '').trim()].filter(Boolean);
  const exposed = renderedProxyRouteId(route, options);
  if (exposed && exposed !== route.id) aliases.push(exposed);
  return aliases;
}

/** 构建"对外暴露 ID → 原始 route"查找表,供 resolveProxyModel 做反向解析。*/
function buildExposedIdLookup(routes, options = {}) {
  const lookup = new Map();
  for (const route of routes) {
    for (const alias of routeAliases(route, options)) {
      const previous = lookup.get(alias);
      if (previous && previous !== route) {
        throw new Error(`本地代理暴露模型 ID 冲突: ${alias} 同时匹配 ${previous.id} 和 ${route.id}。请调整模型 ID 或命名规则。`);
      }
      lookup.set(alias, route);
    }
  }
  return lookup;
}

function proxyRouteStore(scope) {
  return isCodexProxyScope(scope) ? getCodexProxyRoutes() : getProxyRoutes();
}

function proxyRouteStoreMissingMessage(scope) {
  return isCodexProxyScope(scope)
    ? 'Codex 专用代理模型列表为空。请在「更多平台 > Codex」重新切换第三方配置。'
    : '本地代理模型列表为空。请在「代理 > 模型列表」添加模型。';
}

function proxyRouteStoreReadErrorPrefix(scope) {
  return isCodexProxyScope(scope) ? 'Codex 专用代理模型列表读取失败' : '本地代理模型列表读取失败';
}

function proxyRouteRows(kind, options = {}) {
  const store = proxyRouteStore(options.scope);
  if (store.loadError) throw new Error(`${proxyRouteStoreReadErrorPrefix(options.scope)}: ${store.loadError}`);
  if (!store.fileExists) return [];
  const lookupOptions = { applyRename: options.applyRename !== false };
  const candidates = (store.routes || [])
    .filter(route => route.enabled !== false)
    .filter(route => Array.isArray(route.targets) && route.targets.length > 0)
    .filter(route => routeSupportsKind(route, kind));
  buildExposedIdLookup(candidates, lookupOptions);
  return candidates
    .map(route => {
      const exposedId = renderedProxyRouteId(route, lookupOptions);
      return { id: exposedId, name: exposedId };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function handleModels(req, res) {
  const pathname = pathnameOf(req);
  const anthropic = pathname.startsWith('/anthropic/');
  const gemini = pathname === '/v1beta/models';
  const scope = proxyScopeForPath(pathname);
  let rows;
  try {
    rows = proxyRouteRows(gemini ? 'gemini' : (anthropic ? 'anthropic' : 'openai'), {
      scope,
      applyRename: !isCodexProxyScope(scope),
    });
  } catch (e) {
    sendError(res, 500, e.message || String(e), 'configuration_error');
    return;
  }
  if (anthropic) {
    sendJson(res, 200, { data: rows.map(m => ({ id: m.id, type: 'model', display_name: m.name, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: rows[0]?.id || null, last_id: rows[rows.length - 1]?.id || null });
    return;
  }
  if (gemini) {
    sendJson(res, 200, {
      models: rows.map(m => ({
        name: `models/${m.id}`,
        displayName: m.name,
        supportedGenerationMethods: ['generateContent'],
      })),
    });
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

function geminiTextFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map(part => part?.text || '')
    .filter(Boolean)
    .join('\n');
}

function normalizeGeminiPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.text !== undefined) return textPart(part.text);
  const inline = part.inlineData || part.inline_data;
  if (inline?.data) {
    const mime = String(inline.mimeType || inline.mime_type || 'image/png');
    if (!mime.startsWith('image/')) {
      return {
        type: 'gemini_part',
        part: { inlineData: { mimeType: mime, data: String(inline.data || '') } },
      };
    }
    return { type: 'image', source: { type: 'base64', media_type: mime, data: String(inline.data || '') } };
  }
  if (part.functionResponse) return { type: 'gemini_part', part: { functionResponse: part.functionResponse } };
  if (part.function_response) return { type: 'gemini_part', part: { function_response: part.function_response } };
  if (part.functionCall) return { type: 'gemini_part', part: { functionCall: part.functionCall } };
  if (part.function_call) return { type: 'gemini_part', part: { function_call: part.function_call } };
  return null;
}

function normalizeGeminiTools(tools) {
  const out = [];
  for (const group of (Array.isArray(tools) ? tools : [])) {
    const declarations = group?.functionDeclarations || group?.function_declarations || [];
    for (const fn of declarations) {
      const name = String(fn?.name || '').trim();
      if (!name) continue;
      out.push({
        type: 'function',
        function: {
          name,
          description: String(fn.description || ''),
          parameters: fn.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function normalizeGeminiToolChoice(body) {
  const cfg = body?.toolConfig?.functionCallingConfig || body?.tool_config?.function_calling_config;
  if (!cfg || typeof cfg !== 'object') return null;
  const mode = String(cfg.mode || '').trim().toUpperCase();
  if (!mode || mode === 'MODE_UNSPECIFIED' || mode === 'AUTO') return 'auto';
  if (mode === 'NONE') return 'none';
  const allowed = cfg.allowedFunctionNames || cfg.allowed_function_names || [];
  if (mode === 'ANY' && Array.isArray(allowed) && allowed.length === 1) {
    return { type: 'function', function: { name: String(allowed[0]) } };
  }
  if (mode === 'ANY') return 'required';
  return null;
}

function normalizeGemini(body) {
  const systemParts = body?.systemInstruction?.parts || body?.system_instruction?.parts || [];
  const system = geminiTextFromParts(systemParts);
  const messages = [];
  for (const content of (Array.isArray(body.contents) ? body.contents : [])) {
    const role = content?.role === 'model' ? 'assistant' : 'user';
    const parts = (Array.isArray(content?.parts) ? content.parts : [])
      .map(normalizeGeminiPart)
      .filter(Boolean);
    if (parts.length) messages.push({ role, content: parts });
  }
  return { system, messages };
}

function normalizeRequest(kind, body) {
  const base = kind === 'anthropic'
    ? normalizeAnthropic(body)
    : (kind === 'gemini' ? normalizeGemini(body) : normalizeOpenAI(body));
  const generationConfig = kind === 'gemini' && body?.generationConfig && typeof body.generationConfig === 'object'
    ? body.generationConfig
    : {};
  return {
    kind,
    model: String(body.model || '').trim(),
    system: base.system,
    messages: base.messages,
    tools: kind === 'gemini' ? normalizeGeminiTools(body.tools) : (Array.isArray(body.tools) ? body.tools : []),
    toolChoice: kind === 'gemini' ? normalizeGeminiToolChoice(body) : (body.tool_choice || body.toolChoice || null),
    stream: body.stream === true,
    maxTokens: Number(body.max_tokens || body.max_output_tokens || body.max_completion_tokens || generationConfig.maxOutputTokens || generationConfig.max_output_tokens) || 4096,
    temperature: Number.isFinite(Number(body.temperature ?? generationConfig.temperature)) ? Number(body.temperature ?? generationConfig.temperature) : undefined,
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
  if (kind === 'gemini') {
    for (const key of [
      'contents',
      'systemInstruction',
      'system_instruction',
      'generationConfig',
      'generation_config',
      'toolConfig',
      'tool_config',
      'safetySettings',
      'safety_settings',
      'cachedContent',
      'cached_content',
    ]) blocked.add(key);
  }
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

function resolveProxyModel(model, kind, options = {}) {
  const scope = options.scope || 'default';
  const store = proxyRouteStore(scope);
  if (store.loadError) return { error: `${proxyRouteStoreReadErrorPrefix(scope)}: ${store.loadError}` };
  if (!store.fileExists) return { error: proxyRouteStoreMissingMessage(scope) };

  const requested = String(model || '').trim();
  if (!requested) return { error: '请求缺少 model，无法匹配本地代理模型列表。' };

  // 反向解析:先在"对外暴露 ID → 原始 route"查找表里找
  // (支持命名规则渲染后的新 ID,也兼容原始 ID)
  const routes = store.routes || [];
  const candidates = routes.filter(route => routeSupportsKind(route, kind));
  let lookup;
  const lookupOptions = { applyRename: options.applyRename !== false };
  try {
    lookup = buildExposedIdLookup(candidates, lookupOptions);
  } catch (e) {
    return { error: e.message || String(e) };
  }
  const route = lookup.get(requested);
  if (!route) {
    const routeWithOtherFormat = routes.find(route => routeAliases(route, lookupOptions).includes(requested));
    if (routeWithOtherFormat) {
      return { error: `模型 ${requested} 未暴露为 ${localProxyKind(kind)} 兼容入口。` };
    }
    return { error: `模型不在本地代理模型列表中: ${requested}` };
  }
  if (route.enabled === false) return { error: `本地代理模型已禁用: ${requested}` };
  if (!Array.isArray(route.targets) || route.targets.length === 0) {
    return { error: `本地代理模型没有可用上游目标: ${requested}` };
  }
  return { slot: routeAsSlot(route), route };
}

export const __localProxyTest = {
  buildExposedIdLookup,
  renderedProxyRouteId,
  routeSupportsKind,
  normalizeRequest,
  applyParamOverrides,
  applyToolEnhancement,
  upstreamBody,
};

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

function geminiPartFromAnthropic(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return { text: String(part.text || '') };
  if (part.type === 'image' && part.source?.data) {
    return { inlineData: { mimeType: part.source.media_type || 'image/png', data: part.source.data } };
  }
  if (part.type === 'gemini_part' && part.part) return part.part;
  return null;
}

function hasGeminiNativeOnlyParts(messages) {
  return (messages || []).some(message =>
    (message.content || []).some(part => part?.type === 'gemini_part')
  );
}

function geminiContents(system, messages) {
  const out = [];
  for (const m of messages || []) {
    const parts = (m.content || []).map(geminiPartFromAnthropic).filter(Boolean);
    if (!parts.length) continue;
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  if (!out.length && system) out.push({ role: 'user', parts: [{ text: system }] });
  return out;
}

function geminiTools(tools) {
  const declarations = [];
  for (const tool of tools || []) {
    const fn = tool?.type === 'function' ? tool.function : tool;
    const name = String(fn?.name || '').trim();
    if (!name) continue;
    declarations.push({
      name,
      description: String(fn.description || ''),
      parameters: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
    });
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

function geminiToolConfig(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  const name = toolChoice?.function?.name || toolChoice?.name;
  if (name) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [String(name)] } };
  return undefined;
}

function geminiGenerationConfig(ctx) {
  const raw = ctx.rawBody?.generationConfig || ctx.rawBody?.generation_config || {};
  const config = isPlainObject(raw) ? { ...raw } : {};
  delete config.max_output_tokens;
  config.maxOutputTokens = ctx.maxTokens;
  if (ctx.temperature !== undefined) config.temperature = ctx.temperature;
  return config;
}

function upstreamBody(conn, ctx) {
  const extras = {
    ...(ctx.preserveExtraParams === true ? (ctx.extraParams || {}) : {}),
    ...(ctx.paramOverrideExtras || {}),
  };
  if (conn.format !== 'gemini' && hasGeminiNativeOnlyParts(ctx.messages)) {
    throw new LocalProxyUpstreamError('Gemini Native 的 functionCall/functionResponse 或非图片 inlineData 只能路由到 Gemini Native 上游。', {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  if (conn.format === 'anthropic') {
    const claudeCodeUnlock = claudeCodeUnlockForTarget(conn);
    if (claudeCodeUnlock) {
      return buildClaudeCodeUnlockPayload({
        model: conn.model,
        messages: ctx.messages,
        maxTokens: ctx.maxTokens,
        stream: false,
      });
    }
    return cleanBody({ ...extras, model: conn.model, system: ctx.system || undefined, messages: ctx.messages, max_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, thinking: ctx.rawBody?.thinking || undefined, tools: anthropicTools(ctx.tools), tool_choice: ctx.toolChoice || undefined });
  }
  if (conn.format === 'gemini') {
    return cleanBody({
      ...extras,
      contents: geminiContents(ctx.system, ctx.messages),
      systemInstruction: ctx.system ? { parts: [{ text: ctx.system }] } : undefined,
      generationConfig: geminiGenerationConfig(ctx),
      tools: geminiTools(ctx.tools),
      toolConfig: geminiToolConfig(ctx.toolChoice),
      safetySettings: ctx.rawBody?.safetySettings || ctx.rawBody?.safety_settings || undefined,
      cachedContent: ctx.rawBody?.cachedContent || ctx.rawBody?.cached_content || undefined,
    });
  }
  const codexUnlock = codexUnlockForTarget(conn);
  // wireApi=chat: 仅当客户端发来 Responses API 请求时，才做 Responses→Chat 转换
  if (!codexUnlock && conn.wireApi === 'chat' && ctx.kind === 'responses' && ctx.rawBody) {
    const chatBody = responsesToChatCompletions(ctx.rawBody, conn.codexChatReasoning);
    chatBody.model = conn.model;
    return cleanBody({ ...extras, ...chatBody });
  }
  const useResponses = String(conn.apiPath || '').toLowerCase().includes('/responses');
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
      applyCodexUnlockRequiredFields(body, codexUnlock);
    }
    return cleanBody(body);
  }
  return cleanBody({ ...extras, model: conn.model, messages: openAIChatMessages(ctx.system, ctx.messages), max_tokens: ctx.maxTokens, temperature: ctx.temperature, stream: false, tools: openAITools(ctx.tools), tool_choice: ctx.toolChoice || undefined });
}

function authHeaders(conn) {
  if (conn.format === 'gemini') return { 'x-goog-api-key': conn.apiKey };
  if (conn.format === 'openai' && conn.unlockKind === 'codex') return codexUnlockHeaders(conn);
  if (conn.format === 'openai') return { authorization: `Bearer ${conn.apiKey}` };
  if (conn.format === 'anthropic' && conn.unlockKind === 'claudeCode') return claudeCodeUnlockHeaders(conn);
  const h = { 'anthropic-version': '2023-06-01' };
  if (conn.authScheme === 'bearer') h.authorization = `Bearer ${conn.apiKey}`;
  else h['x-api-key'] = conn.apiKey;
  return h;
}

function upstreamRequestOptions(conn, headers) {
  const protocol = conn.protocol === 'http' ? 'http' : 'https';
  const defaultPort = protocol === 'http' ? 80 : 443;
  return {
    module: protocol === 'http' ? http : https,
    options: {
      agent: protocol === 'http' ? HTTP_AGENT : httpsAgentFor(AGENT),
      hostname: conn.hostname || conn.host,
      port: Number(conn.port || defaultPort),
      path: conn.apiPath,
      method: 'POST',
      headers,
    },
  };
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
    const requestConfig = upstreamRequestOptions(conn, { 'content-type': 'application/json', 'content-length': body.length, ...authHeaders(conn), ...extraHeaders });
    const req = requestConfig.module.request(requestConfig.options, apiRes => {
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
    const requestConfig = upstreamRequestOptions(conn, { 'content-type': 'application/json', 'content-length': body.length, ...authHeaders(conn), ...extraHeaders });
    const req = requestConfig.module.request(requestConfig.options, apiRes => {
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
  if (conn.format === 'gemini') return (json.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').filter(Boolean).join('');
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
  if (conn.format === 'gemini') {
    const gm = json?.usageMetadata || json?.usage_metadata || {};
    return {
      inputTokens: Number(gm.promptTokenCount || gm.prompt_token_count) || fallbackIn,
      outputTokens: Number(gm.candidatesTokenCount || gm.candidates_token_count) || fallbackOut,
      cachedTokens: Number(gm.cachedContentTokenCount || gm.cached_content_token_count) || 0,
    };
  }
  return { inputTokens: Number(u.input_tokens || u.prompt_tokens) || fallbackIn, outputTokens: Number(u.output_tokens || u.completion_tokens) || fallbackOut, cachedTokens: Number(u.input_tokens_details?.cached_tokens || u.prompt_tokens_details?.cached_tokens) || 0 };
}

function parseJsonObject(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function extractToolCalls(conn, json) {
  if (!json) return [];
  if (conn.format === 'anthropic') {
    return (json.content || [])
      .filter(part => part?.type === 'tool_use' && part.name)
      .map(part => ({ id: part.id || '', name: part.name, arguments: part.input || {} }));
  }
  if (conn.format === 'gemini') {
    return (json.candidates?.[0]?.content?.parts || [])
      .map(part => part?.functionCall || part?.function_call)
      .filter(call => call?.name)
      .map(call => ({ id: '', name: call.name, arguments: call.args || {} }));
  }
  const message = json.choices?.[0]?.message || {};
  const chatCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const responseCalls = Array.isArray(json.output) ? json.output.filter(item => item?.type === 'function_call') : [];
  return [
    ...chatCalls.map(call => ({
      id: call.id || '',
      name: call.function?.name || '',
      arguments: parseJsonObject(call.function?.arguments || '{}'),
    })),
    ...responseCalls.map(call => ({
      id: call.call_id || call.id || '',
      name: call.name || '',
      arguments: parseJsonObject(call.arguments || '{}'),
    })),
  ].filter(call => call.name);
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
  const visionOptions = {
    maxTokens: mapConfig?.enhancement?.visionMaxTokens,
    contextMode: mapConfig?.enhancement?.visionContextMode,
    contextMaxChars: mapConfig?.enhancement?.visionContextMaxChars,
    multiImageMode: mapConfig?.enhancement?.visionMultiImageMode,
    batchSize: mapConfig?.enhancement?.visionBatchSize,
  };
  const fbCtx = { requestId: crypto.randomUUID(), requestedModel: ctx.model, slotModelUid: slot.modelUid || ctx.model, slotDisplayName: slot.displayName || ctx.model, visionOptions };
  const result = await preprocessImagesWithThirdPartyVision(ctx.messages, visionModels, providers, fbCtx);

  // 同步降级原始请求体：Responses→Chat 旁路会直接用 ctx.rawBody 重建上游请求
  // (responsesToChatCompletions(ctx.rawBody))，若不降级 rawBody，图片会被绕过。
  // 这里复用 preprocessImagesWithThirdPartyVision 的图片缓存，不重复调用第三方图片理解 API。
  let rawBody = ctx.rawBody;
  if (rawBody) {
    if (ctx.kind === 'responses' && Array.isArray(rawBody.input)) {
      rawBody = { ...rawBody, input: await fallbackResponsesInput(rawBody.input, visionModels, providers, fbCtx) };
    } else if (ctx.kind === 'openai' && Array.isArray(rawBody.messages)) {
      const r = await preprocessImagesWithThirdPartyVision(rawBody.messages, visionModels, providers, fbCtx);
      rawBody = { ...rawBody, messages: r.messages };
    }
  }
  return { ...ctx, messages: result.messages, rawBody };
}

// 降级 Responses API 的 input 数组。
// input 的 item 有两种形态：
//   1) message item: { type:'message', role:'user', content:[input_text/input_image] }
//      ——结构兼容 {role, content}，直接复用 preprocessImagesWithThirdPartyVision；
//   2) loose input part: { type:'input_image', image_url } / { type:'input_text', text }
//      ——聚合成临时 user message 降级后再按原序回填（每个 block 1:1 替换，数量不变）。
async function fallbackResponsesInput(input, visionModels, providers, fbCtx) {
  const out = input.slice();
  const messageItemIndices = [];
  const looseIndices = [];
  input.forEach((item, i) => {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      messageItemIndices.push(i);
    } else if (item && item.type === 'input_image') {
      looseIndices.push(i);
    }
  });

  if (messageItemIndices.length) {
    const msgs = messageItemIndices.map(i => input[i]);
    const r = await preprocessImagesWithThirdPartyVision(msgs, visionModels, providers, fbCtx);
    r.messages.forEach((m, k) => { out[messageItemIndices[k]] = m; });
  }

  if (looseIndices.length) {
    const looseMsg = { role: 'user', content: looseIndices.map(i => input[i]) };
    const r = await preprocessImagesWithThirdPartyVision([looseMsg], visionModels, providers, fbCtx);
    const newContent = r.messages[0]?.content || looseMsg.content;
    looseIndices.forEach((idx, k) => { out[idx] = newContent[k] ?? input[idx]; });
  }

  return out;
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

function toolName(tool) {
  return String(tool?.name || tool?.function?.name || '').trim();
}

function toolChoiceName(choice) {
  if (!choice || typeof choice !== 'object') return '';
  if (choice.type === 'tool') return String(choice.name || '').trim();
  if (choice.type === 'function') return String(choice.function?.name || choice.name || '').trim();
  return '';
}

function applyToolEnhancement(effective, enhancement = {}) {
  if (enhancement.toolFilterEnabled !== true) return;

  if (enhancement.toolFilterMode && Array.isArray(effective.tools) && effective.tools.length) {
    const filterSet = new Set((enhancement.toolFilterList || []).map(n => String(n || '').trim()).filter(Boolean));
    if (filterSet.size) {
      effective.tools = effective.tools.filter(tool => {
        const name = toolName(tool);
        if (enhancement.toolFilterMode === 'allow') return filterSet.has(name);
        if (enhancement.toolFilterMode === 'deny') return !filterSet.has(name);
        return true;
      });
    }
  }

  if (enhancement.forceToolChoice) {
    effective.toolChoice = enhancement.forceToolChoice;
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
    throw new LocalProxyUpstreamError(`${label} 必须是大于 0 的整数`, {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  target[key] = n;
}

function applyParamOverrides(effective, enhancement = {}) {
  if (enhancement.paramOverridesEnabled !== true) return;
  const overrides = enhancement.paramOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;

  const extras = { ...(effective.paramOverrideExtras || {}) };
  for (const [key, value] of Object.entries(overrides)) {
    if (['max_tokens', 'max_output_tokens', 'max_completion_tokens', 'maxTokens'].includes(key)) {
      assignPositiveInteger(effective, 'maxTokens', value, key);
    } else if (key === 'temperature') {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new LocalProxyUpstreamError('temperature 必须是数字', {
          status: 400,
          type: 'invalid_request_error',
        });
      }
      effective.temperature = n;
    } else if (key === 'tool_choice' || key === 'toolChoice') {
      effective.toolChoice = value;
    } else if (key === 'system' || key === 'instructions') {
      effective.system = String(value || '');
    } else if (key === 'tools') {
      if (!Array.isArray(value)) {
        throw new LocalProxyUpstreamError('tools 覆盖值必须是数组', {
          status: 400,
          type: 'invalid_request_error',
        });
      }
      effective.tools = value;
    } else if (['model', 'messages', 'input', 'stream'].includes(key)) {
      throw new LocalProxyUpstreamError(`请求参数覆盖不支持修改 ${key}`, {
        status: 400,
        type: 'invalid_request_error',
      });
    } else {
      extras[key] = value;
    }
  }
  effective.paramOverrideExtras = extras;
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

export async function execute(ctx) {
  const scope = ctx.proxyRouteScope || 'default';
  const resolved = resolveProxyModel(ctx.model, ctx.kind, {
    scope,
    applyRename: !isCodexProxyScope(scope),
  });
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
  // 智能重试配置：默认全开，可通过 model-map.json enhancement.selfHeal 覆盖
  const selfHealCfg = { ...DEFAULT_SELF_HEAL_CONFIG, ...(enhancement.selfHeal || {}) };
  const effective = await maybeVisionFallback(ctx, resolved.slot, providers, mapConfig);
  effective.preserveExtraParams = preserveExtraParams;

  // ── 系统提示词注入 ──
  if (enhancement.systemPromptPrefixEnabled === true && enhancement.systemPromptPrefix) {
    effective.system = [enhancement.systemPromptPrefix, effective.system].filter(Boolean).join('\n\n') || undefined;
  }

  // ── 请求参数覆盖 ──
  applyParamOverrides(effective, enhancement);

  // ── 工具过滤 / 强制 tool_choice ──
  applyToolEnhancement(effective, enhancement);

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
    let payload = upstreamBody(conn, effective);
    const started = Date.now();
    let retryCount = 0;
    // 智能重试状态：每个 target 独立，每个整流器最多触发一次防无限循环
    const healState = { signatureHealed: false, budgetHealed: false, mediaHealed: false };
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
          // ── 智能重试：错误驱动的请求自愈（仅 anthropic 格式上游）──
          if (conn.format === 'anthropic' && selfHealCfg.enabled) {
            const healed = tryHeal(payload, r.statusCode, errorText, selfHealCfg, healState);
            if (healed.healed) {
              console.log(`[local-proxy] [self-heal] ${healed.kind} triggered, retrying`);
              continue;
            }
          }
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
          const toolCalls = extractToolCalls(conn, r.json);
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
          return { conn, text, toolCalls, json: r.json, usage, extraHeaders: extraRespHeaders, responseObj };
        }
        const msg = compactText(upstreamMessage(r));
        // ── 智能重试：错误驱动的请求自愈（仅 anthropic 格式上游）──
        if (conn.format === 'anthropic' && selfHealCfg.enabled) {
          const healed = tryHeal(payload, r.statusCode, r.text, selfHealCfg, healState);
          if (healed.healed) {
            console.log(`[local-proxy] [self-heal] ${healed.kind} triggered, retrying`);
            continue;
          }
        }
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

function geminiUsageMetadata(usage = {}) {
  const prompt = Number(usage.inputTokens) || 0;
  const candidates = Number(usage.outputTokens) || 0;
  const cached = Number(usage.cachedTokens) || 0;
  const out = {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: prompt + candidates,
  };
  if (cached > 0) out.cachedContentTokenCount = cached;
  return out;
}

function sendGemini(ctx, res, result) {
  const extra = result.extraHeaders || {};
  const parts = [];
  if (result.text) parts.push({ text: result.text });
  for (const call of result.toolCalls || []) {
    parts.push({ functionCall: { name: call.name, args: call.arguments || {} } });
  }
  if (!parts.length) parts.push({ text: '' });
  const body = {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: (result.toolCalls || []).length ? 'STOP' : 'STOP',
      index: 0,
    }],
    usageMetadata: geminiUsageMetadata(result.usage),
    modelVersion: ctx.model,
  };
  sendJson(res, 200, body, extra);
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
  const scope = proxyScopeForPath(p);
  const attachScope = (ctx) => {
    ctx.proxyRouteScope = scope;
    return ctx;
  };
  if (req.method === 'GET' && (p === '/v1/models' || p === '/codex/v1/models' || p === '/anthropic/v1/models' || p === '/v1beta/models')) { handleModels(req, res); return; }
  let json;
  try { json = body && body.length ? JSON.parse(body.toString('utf8')) : {}; }
  catch (e) { sendError(res, 400, `请求 JSON 解析失败: ${e.message}`); return; }
  if (p === '/__byok/web-search/test') {
    const query = String(json.query || '').trim();
    if (!query) { sendError(res, 400, '测试搜索 query 不能为空'); return; }
    try {
      const result = await executeSearchWithFailover([json.source || {}], query, Number(json.maxResults) || 3);
      sendJson(res, 200, { results: result.results, source: result.source, attempts: result.attempts });
    } catch (e) {
      sendError(res, 502, e.message || '搜索源测试失败', 'search_source_error');
    }
    return;
  }
  if (p.endsWith('/messages/count_tokens')) { handleCountTokens(json, res); return; }
  try {
    if (p === '/v1/chat/completions' || p === '/codex/v1/chat/completions') { const ctx = attachScope(normalizeRequest('openai', json)); sendOpenAIChat(ctx, res, await execute(ctx)); return; }
    if (p === '/v1/responses' || p === '/codex/v1/responses') { const ctx = attachScope(normalizeRequest('responses', json)); sendOpenAIResponses(ctx, res, await execute(ctx)); return; }
    if (p === '/anthropic/v1/messages' || p === '/anthropic/messages') { const ctx = normalizeRequest('anthropic', json); sendAnthropic(ctx, res, await execute(ctx)); return; }
    if (isGeminiGenerateContentPath(p)) {
      if (geminiMethodFromPath(p) === 'streamGenerateContent') {
        sendGeminiError(res, 501, 'Gemini Native streamGenerateContent 暂未接入；请使用 generateContent。', 'UNIMPLEMENTED');
        return;
      }
      const ctx = attachScope(normalizeRequest('gemini', { ...json, model: geminiModelFromPath(p), stream: false }));
      sendGemini(ctx, res, await execute(ctx));
      return;
    }
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
    if (p.startsWith('/v1beta/')) {
      const geminiStatus = type === 'authentication_error' ? 'UNAUTHENTICATED'
        : (type === 'permission_error' ? 'PERMISSION_DENIED'
          : (type === 'not_found_error' ? 'NOT_FOUND' : 'INVALID_ARGUMENT'));
      sendGeminiError(res, status, message, geminiStatus);
      return;
    }
    sendError(res, status, message, type);
  }
}
