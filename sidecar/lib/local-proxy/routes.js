// routes.js — Local proxy path routing, auth validation, route exposure lookup,
// Claude Desktop role binding, Antigravity proxy resolution & /models listing.

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config-dir.js';
import { codexAuthJsonPath } from '../codex-home.js';
import { getCodexProxyRoutes, getProvidersJson, getProxyRoutes } from '../../config-cache.js';
import { loadModelMapConfig, loadProviders } from '../../provider-pool.js';
import { fetchOfficialAntigravityRaw, isAntigravityPath, resolveAntigravityCustomModel } from '../antigravity-handler.js';
import { inferApiFormatFromEndpoint, isOfficialGoogleGeminiNativeOnlyEndpoint } from '../google-gemini.js';

export function readLocalConfig() {
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

export function readProvidersJson() {
  return getProvidersJson() || {};
}

export function resolveDefaultAntigravityModel(providersJson = readProvidersJson()) {
  const state = providersJson.platforms?.['antigravity-ide'] || providersJson.platforms?.antigravity;
  if (state?.providerId) {
    const cfg = (providersJson.antigravityConfigs || []).find((c) => c.id === state.providerId);
    if (cfg?.defaultModel) return cfg.defaultModel;
    const p = (providersJson.providers || []).find((x) => x.id === state.providerId);
    if (p?.defaultModel) return p.defaultModel;
  }
  const firstAg = (providersJson.antigravityConfigs || [])[0];
  if (firstAg?.defaultModel) return firstAg.defaultModel;
  return 'gemini-3-pro';
}

export function pathnameOf(req) {
  try {
    let p = new URL(req.url, 'http://127.0.0.1').pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    if (p.startsWith('/gemini/v1beta/')) p = p.slice(7);
    else if (p === '/gemini/v1beta') p = '/v1beta';
    else if (p.startsWith('/gemini/v1/')) p = '/v1' + p.slice(10);
    else if (p.startsWith('/claude/v1/')) p = '/v1' + p.slice(10);
    p = p.replace(/^\/(?:v1\/)+(v1beta\/)/, '/$1');
    p = p.replace(/^\/(?:v1\/)+/, '/v1/');
    p = p.replace(/^\/(?:v1beta\/)+/, '/v1beta/');
    return p;
  } catch {
    return req.url || '/';
  }
}

export function geminiGenerateContentMatch(pathname) {
  return String(pathname || '').match(/^\/(?:v1beta|v1)\/models\/(?:models\/)?(.+):(generateContent|streamGenerateContent|countTokens)$/);
}

export function isGeminiGenerateContentPath(pathname) {
  return !!geminiGenerateContentMatch(pathname);
}

export function geminiModelFromPath(pathname) {
  const m = geminiGenerateContentMatch(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}

export function geminiMethodFromPath(pathname) {
  const m = geminiGenerateContentMatch(pathname);
  return m ? m[2] : '';
}

export function isLocalProxyRequest(req) {
  const p = pathnameOf(req);
  return p === '/'
    || p === '/health'
    || p === '/status'
    || p === '/v1'
    || p === '/v1/models'
    || p === '/models'
    || p === '/v1/chat/completions'
    || p === '/chat/completions'
    || p === '/v1/responses'
    || p === '/responses'
    || p === '/v1/messages'
    || p === '/messages'
    || p === '/v1beta/models'
    || isGeminiGenerateContentPath(p)
    || (req.method === 'GET' && /^\/(?:v1beta|v1)\/models\/(?:models\/)?[^/:]+$/.test(p))
    || p === '/codex/v1/models'
    || p === '/codex/v1/chat/completions'
    || p === '/codex/v1/responses'
    || p === '/anthropic/v1/models'
    || p === '/__byok/web-search/test'
    || p === '/anthropic/v1/messages'
    || p === '/anthropic/messages'
    || p === '/claude-desktop/v1/models'
    || p === '/claude-desktop/models'
    || p === '/claude-desktop/v1/messages'
    || p === '/claude-desktop/messages'
    || p.startsWith('/claude-desktop/')
    || p.endsWith('/messages/count_tokens')
    || isAntigravityPath(p);
}

export function proxyScopeForPath(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/codex/')) return 'codex';
  if (p.startsWith('/claude-desktop')) return 'claude-desktop';
  if (isAntigravityPath(p)) return 'antigravity';
  return 'default';
}

export function isCodexProxyScope(scope) {
  return scope === 'codex';
}

export function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-beta',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...extra,
  };
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, cors({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers }));
  res.end(text);
}

export async function handleHybridHandshake(res, req, body, pathname, ensureFn, mockFn) {
  const raw = await fetchOfficialAntigravityRaw(req, body, pathname);
  if (raw && raw.contentType && raw.contentType.toLowerCase().includes('json')) {
    try {
      const parsed = JSON.parse(raw.body.toString('utf8'));
      if (parsed && typeof parsed === 'object') {
        sendJson(res, 200, ensureFn(parsed));
        return;
      }
    } catch {}
  }
  if (raw) {
    res.writeHead(raw.statusCode, cors({ 'content-type': raw.contentType || 'application/octet-stream', 'content-length': raw.body.length }));
    res.end(raw.body);
    return;
  }
  sendJson(res, 200, mockFn());
}

export function sendRaw(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : String(body || '');
  const contentType = headers['content-type'] || headers['Content-Type'] || 'application/json; charset=utf-8';
  res.writeHead(status, cors({ 'content-type': contentType, 'content-length': Buffer.byteLength(text) }));
  res.end(text);
}

export function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: type, status } });
}

export function sendAnthropicError(res, status, message, type = 'api_error') {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

export function sendGeminiError(res, status, message, type = 'INVALID_ARGUMENT') {
  sendJson(res, status, { error: { code: status, message, status: type } });
}

export class LocalProxyUpstreamError extends Error {
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
  try {
    const keyParam = new URL(req.url, 'http://localhost').searchParams.get('key');
    if (keyParam) return keyParam.trim();
  } catch {}
  return String(req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers['api-key'] || '').trim();
}

let _cachedCodexToken = null;
let _cachedCodexTokenMtime = 0;

function readCodexOAuthToken() {
  try {
    const authPath = codexAuthJsonPath();
    if (!fs.existsSync(authPath)) return null;
    const stat = fs.statSync(authPath);
    const mtime = stat.mtimeMs;
    if (_cachedCodexToken && mtime === _cachedCodexTokenMtime) return _cachedCodexToken;
    const raw = fs.readFileSync(authPath, 'utf8');
    const json = JSON.parse(raw);
    const token = (json.OPENAI_API_KEY || json.access_token || '').replace(/^Bearer\s+/i, '').trim();
    _cachedCodexToken = token || null;
    _cachedCodexTokenMtime = mtime;
    return _cachedCodexToken;
  } catch {
    return null;
  }
}

export function validateAuth(req) {
  const expected = String(readLocalConfig().LOCAL_PROXY_KEY || '').trim();
  if (!expected) return { ok: false, status: 503, message: 'AnyBridge 内置供应商 key 尚未生成，请在网关页生成 key。' };
  const token = authToken(req);
  if (token === expected) return { ok: true };
  const p = pathnameOf(req);
  if (isAntigravityPath(p)) return { ok: true };
  if (String(p).startsWith('/codex/')) {
    const oauthToken = readCodexOAuthToken();
    if (oauthToken && token === oauthToken) return { ok: true };
  }
  return { ok: false, status: 401, message: 'AnyBridge 内置供应商 key 无效。' };
}

const RENAME_TEMPLATE_VARS = ['prefix', 'model', 'provider', 'suffix'];

function renderProxyRouteIdTemplate(tpl, vars) {
  let out = String(tpl || '');
  for (let pass = 0; pass < 8; pass++) {
    const prev = out;
    for (const k of RENAME_TEMPLATE_VARS) {
      out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k] == null ? '' : String(vars[k]));
    }
    if (out === prev) break;
  }
  return out.trim();
}

function proxyRouteRenameRule() {
  const map = loadModelMapConfig();
  const rule = map && map.proxyRouteRenameRule;
  if (!rule || typeof rule !== 'object' || rule.enabled === false) return null;
  const prefix = String(rule.prefix || '');
  const suffix = String(rule.suffix || '');
  const template = String(rule.template || '');
  if (!prefix && !suffix && !template) return null;
  const mode = String(rule.mode || 'simple');
  const tpl = mode === 'custom' && template ? template : '{prefix}{model}{suffix}';
  return { mode, prefix, suffix, template, tpl };
}

function providerNameById(providerId) {
  const providers = loadProviders();
  const p = providers instanceof Map
    ? providers.get(providerId)
    : (Array.isArray(providers) ? providers.find((x) => x.id === providerId) : null);
  return p ? (p.name || p.id || '') : '';
}

export function renderedProxyRouteId(route, options = {}) {
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
  const normalized = formats.map((fmt) => String(fmt || '').trim().toLowerCase()).filter(Boolean);
  return normalized.length ? normalized : ['openai', 'anthropic', 'gemini'];
}

function localProxyKind(kind) {
  if (kind === 'anthropic') return 'anthropic';
  if (kind === 'gemini') return 'gemini';
  return 'openai';
}

export function routeSupportsKind(route, kind) {
  return routeExposedFormats(route).includes(localProxyKind(kind));
}

function routeAliases(route, options = {}) {
  const aliases = [String(route.id || '').trim()].filter(Boolean);
  const exposed = renderedProxyRouteId(route, options);
  if (exposed && exposed !== route.id) aliases.push(exposed);
  return aliases;
}

export function buildExposedIdLookup(routes, options = {}) {
  const lookup = new Map();
  for (const route of routes) {
    const literal = String(route.id || '').trim();
    if (!literal) continue;
    const previous = lookup.get(literal);
    if (previous && previous !== route) {
      throw new Error(`本地内置模型 ID 冲突: ${literal} 同时是 ${previous.id} 和 ${route.id} 两条路由的字面 ID。请调整模型 ID 或命名规则。`);
    }
    lookup.set(literal, route);
  }
  for (const route of routes) {
    const exposed = renderedProxyRouteId(route, options);
    if (!exposed || exposed === route.id) continue;
    const owner = lookup.get(exposed);
    if (owner && owner !== route) {
      console.warn(`[local-proxy] 暴露别名冲突已跳过: "${exposed}" 归属于路由 ${owner.id},路由 ${route.id} 的命名规则别名不生效。请调整模型 ID 或命名规则。`);
      continue;
    }
    lookup.set(exposed, route);
  }
  return lookup;
}

function proxyRouteStore(scope) {
  return isCodexProxyScope(scope) ? getCodexProxyRoutes() : getProxyRoutes();
}

function proxyRouteStoreMissingMessage(scope) {
  return isCodexProxyScope(scope)
    ? 'Codex 专用内置模型列表为空。请在「更多平台 > Codex」重新切换第三方配置。'
    : '内置模型列表为空。请在「网关 > 模型列表」添加模型。';
}

function proxyRouteStoreReadErrorPrefix(scope) {
  return isCodexProxyScope(scope) ? 'Codex 专用内置模型列表读取失败' : '内置模型列表读取失败';
}

function proxyRouteRows(kind, options = {}) {
  const store = proxyRouteStore(options.scope);
  if (store.loadError) throw new Error(`${proxyRouteStoreReadErrorPrefix(options.scope)}: ${store.loadError}`);
  if (!store.fileExists) return [];
  const lookupOptions = { applyRename: options.applyRename !== false };
  const candidates = (store.routes || [])
    .filter((route) => route.enabled !== false)
    .filter((route) => Array.isArray(route.targets) && route.targets.length > 0)
    .filter((route) => routeSupportsKind(route, kind));
  buildExposedIdLookup(candidates, lookupOptions);
  return candidates
    .map((route) => {
      const exposedId = renderedProxyRouteId(route, lookupOptions);
      return { id: exposedId, name: exposedId };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function stripOneMContextMarker(model) {
  let m = String(model || '').trim();
  if (m.toLowerCase().endsWith('[1m]')) {
    m = m.slice(0, -4).trim();
  }
  return m;
}

export function resolveClaudeDesktopRole(model) {
  const m = stripOneMContextMarker(model).toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  if (m.includes('sonnet')) return 'sonnet';
  return null;
}

export function mapClaudeDesktopModel(requestedModel) {
  const rawModel = stripOneMContextMarker(requestedModel);
  const role = resolveClaudeDesktopRole(rawModel);
  const store = getProxyRoutes();
  const bindings = store?.claudeDesktop || {};
  let targetRef = '';
  if (role === 'sonnet') targetRef = bindings.sonnet;
  else if (role === 'opus') targetRef = bindings.opus;
  else if (role === 'haiku') targetRef = bindings.haiku;
  else if (role === 'fable') targetRef = bindings.fable || bindings.opus;

  if (targetRef) {
    const cleanTarget = stripOneMContextMarker(targetRef);
    const route = (store?.routes || []).find((r) => r.uid === cleanTarget || r.id === cleanTarget);
    if (route) {
      if (!route.enabled) return { error: `Claude Desktop 绑定的内置模型已禁用: ${route.id}` };
      return { model: route.id, original: requestedModel, route };
    }
    const providers = loadProviders();
    const storeJson = readProvidersJson();
    const currentId = storeJson?.platforms?.['claude-desktop']?.providerId;
    const currentCfg = (storeJson?.claudeDesktopConfigs || []).find((c) => c.id === currentId);
    const sourceProvider = currentCfg?.sourceProviderId ? providers.get(currentCfg.sourceProviderId) : null;
    if (!sourceProvider || sourceProvider.enabled === false) {
      return { error: `Claude Desktop 绑定的模型 [${cleanTarget}] 无法解析：当前配置未关联有效的源供应商。` };
    }
    const dynamicRoute = {
      id: cleanTarget,
      enabled: true,
      targets: [{ providerId: sourceProvider.id, model: cleanTarget }],
    };
    return { model: cleanTarget, original: requestedModel, route: dynamicRoute };
  }

  const directRoute = (store?.routes || []).find((r) => r.id === rawModel || r.uid === rawModel);
  if (directRoute) {
    if (!directRoute.enabled) return { error: `请求的内置模型已禁用: ${directRoute.id}` };
    return { model: directRoute.id, original: requestedModel, route: directRoute };
  }

  return {
    error: `Claude Desktop 请求模型 [${requestedModel}] 对应的角色 [${role || '未知'}] 尚未在 AnyBridge 平台设置中绑定有效的内置模型。`,
  };
}

function handleClaudeDesktopModels(res) {
  const store = getProxyRoutes();
  const bindings = store?.claudeDesktop || {};
  const isOneMCandidate = (routeRef) => {
    if (!routeRef) return false;
    const clean = String(routeRef).trim();
    const r = (store?.routes || []).find((x) => x.uid === clean || x.id === clean);
    if (r) {
      const self1m = /\[1m\]|1m/i.test(r.id || '') || /\[1m\]|1m/i.test(r.displayName || '');
      const target1m = Array.isArray(r.targets) && r.targets.some((t) => /\[1m\]|1m/i.test(t.model || ''));
      if (self1m || target1m) return true;
    }
    return /\[1m\]|1m/i.test(clean);
  };
  const models = [
    { id: 'claude-sonnet-5', type: 'model', display_name: bindings.sonnetName || 'Claude Sonnet 5', created_at: '2024-01-01T00:00:00Z', supports1m: isOneMCandidate(bindings.sonnet) },
    { id: 'claude-opus-5', type: 'model', display_name: bindings.opusName || 'Claude Opus 5', created_at: '2024-01-01T00:00:00Z', supports1m: isOneMCandidate(bindings.opus) },
    { id: 'claude-haiku-4-5', type: 'model', display_name: bindings.haikuName || 'Claude Haiku 4.5', created_at: '2024-01-01T00:00:00Z', supports1m: isOneMCandidate(bindings.haiku) },
  ];
  if (bindings.fable && String(bindings.fable).trim()) {
    models.push({ id: 'claude-fable-5', type: 'model', display_name: bindings.fableName || 'Claude Fable 5', created_at: '2024-01-01T00:00:00Z', supports1m: isOneMCandidate(bindings.fable) });
  }
  sendJson(res, 200, {
    data: models,
    has_more: false,
    first_id: models[0]?.id || null,
    last_id: models[models.length - 1]?.id || null,
  });
}

export function handleModels(req, res) {
  const pathname = pathnameOf(req);
  if (pathname.startsWith('/claude-desktop')) {
    handleClaudeDesktopModels(res);
    return;
  }
  const anthropic = pathname.startsWith('/anthropic/') || !!req.headers['anthropic-version'];
  const gemini = pathname === '/v1beta/models' || (pathname === '/v1/models' && (!!req.headers['x-goog-api-key'] || (req.url && req.url.includes('key='))));
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
    sendJson(res, 200, { data: rows.map((m) => ({ id: m.id, type: 'model', display_name: m.name, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: rows[0]?.id || null, last_id: rows[rows.length - 1]?.id || null });
    return;
  }
  if (gemini) {
    sendJson(res, 200, {
      models: rows.map((m) => ({
        name: `models/${m.id}`,
        displayName: m.name,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      })),
    });
    return;
  }
  sendJson(res, 200, { object: 'list', data: rows.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'anybridge' })) });
}

export function handleGeminiModelInfo(modelId, res, scope) {
  const resolved = resolveProxyModel(modelId, 'gemini', { scope, applyRename: !isCodexProxyScope(scope) });
  if (resolved.error) {
    sendGeminiError(res, 404, `模型不存在: ${modelId}`, 'NOT_FOUND');
    return;
  }
  const exposedId = renderedProxyRouteId(resolved.route, { applyRename: !isCodexProxyScope(scope) });
  sendJson(res, 200, {
    name: `models/${exposedId}`,
    displayName: exposedId,
    supportedGenerationMethods: ['generateContent', 'countTokens'],
  });
}

export function routeAsSlot(route) {
  return {
    modelUid: route.id,
    displayName: route.displayName || route.id,
    enabled: route.enabled !== false,
    useThirdPartyVision: route.enhancement?.thirdPartyVision === true,
    useThirdPartySearch: route.enhancement?.thirdPartySearch === true,
    targets: route.targets || [],
  };
}

export function isLocalProxySelfTarget(target) {
  const id = String(target?.providerId || '').trim().toLowerCase();
  return id === 'anybridge-local-proxy' || id === 'anybridge';
}

export function sameRoute(a, b) {
  if (!a || !b) return false;
  if (a.uid && b.uid) return a.uid === b.uid;
  return a.id === b.id;
}

export function buildAntigravityRouteFromCustomModel(customModel, requestedModel, providers = loadProviders()) {
  if (!customModel) return null;
  const requested = String(requestedModel || customModel.exposedModel || customModel.upstreamModel || '').trim();
  const sourceProvider = customModel?.config?.sourceProviderId ? providers.get(customModel.config.sourceProviderId) : null;
  const provider = sourceProvider || (customModel?.config?.id ? providers.get(customModel.config.id) : null);
  if (!provider) {
    return { error: `Antigravity 模型「${requested}」关联的供应商不存在，请检查配置。` };
  }
  if (provider.enabled === false) {
    return { error: `Antigravity 模型「${requested}」关联的供应商「${provider.name || provider.id}」已禁用。` };
  }
  const normalizeFmt = (v) => {
    const f = String(v || '').trim().toLowerCase();
    return f === 'openai' || f === 'anthropic' || f === 'gemini' ? f : '';
  };
  const overrideFmt = normalizeFmt(customModel.config.apiFormatOverride);
  // 关联 sourceProviderId 时以主供应商为准，绝不让历史静态快照覆盖主供应商变更
  const effectivePath = sourceProvider
    ? (sourceProvider.apiPath || null)
    : (customModel.config.apiPath || provider.apiPath || null);
  let effectiveFormat = sourceProvider
    ? (overrideFmt
        || normalizeFmt(sourceProvider.apiFormat)
        || inferApiFormatFromEndpoint(sourceProvider.apiHost, effectivePath)
        || normalizeFmt(customModel.config.apiFormat)
        || null)
    : (overrideFmt
        || normalizeFmt(customModel.config.apiFormat)
        || normalizeFmt(provider.apiFormat)
        || inferApiFormatFromEndpoint(provider.apiHost, effectivePath)
        || null);
  if (isOfficialGoogleGeminiNativeOnlyEndpoint(provider.apiHost, effectivePath)) {
    effectiveFormat = 'gemini';
  }
  const dynamicRoute = {
    id: requested || customModel.upstreamModel,
    enabled: true,
    enhancement: { thirdPartyVision: customModel.config.useThirdPartyVision === true },
    targets: [{
      providerId: provider.id,
      model: customModel.upstreamModel,
      apiFormat: effectiveFormat,
      apiPath: effectivePath,
    }],
  };
  return { slot: routeAsSlot(dynamicRoute), route: dynamicRoute };
}

export function resolveAntigravityProxyModel(model, providers = loadProviders(), providersJson = readProvidersJson()) {
  const requested = String(model || '').trim();
  const customModel = resolveAntigravityCustomModel(requested, providersJson);
  return buildAntigravityRouteFromCustomModel(customModel, requested, providers);
}

export function resolveProxyModel(model, kind, options = {}) {
  const scope = options.scope || 'default';
  if (scope === 'antigravity') {
    const antigravityResolved = resolveAntigravityProxyModel(model);
    if (antigravityResolved) return antigravityResolved;
  }
  const store = proxyRouteStore(scope);
  if (store.loadError) return { error: `${proxyRouteStoreReadErrorPrefix(scope)}: ${store.loadError}` };
  if (!store.fileExists) return { error: proxyRouteStoreMissingMessage(scope) };

  const requested = String(model || '').trim();
  if (!requested) return { error: '请求缺少 model，无法匹配内置模型列表。' };

  const routes = store.routes || [];
  const candidates = routes.filter((route) => routeSupportsKind(route, kind));
  let lookup;
  const lookupOptions = { applyRename: options.applyRename !== false };
  try {
    lookup = buildExposedIdLookup(candidates, lookupOptions);
  } catch (e) {
    return { error: e.message || String(e) };
  }
  const route = lookup.get(requested);
  if (!route) {
    const routeWithOtherFormat = routes.find((r) => routeAliases(r, lookupOptions).includes(requested));
    if (routeWithOtherFormat) {
      return { error: `模型 ${requested} 未暴露为 ${localProxyKind(kind)} 兼容入口。` };
    }
    return { error: `模型不在内置模型列表中: ${requested}` };
  }
  if (route.enabled === false) return { error: `内置模型已禁用: ${requested}` };
  if (!Array.isArray(route.targets) || route.targets.length === 0) {
    return { error: `内置模型没有可用上游目标: ${requested}` };
  }
  return { slot: routeAsSlot(route), route };
}
