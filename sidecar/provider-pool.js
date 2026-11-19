// provider-pool.js — 只读消费 config-cache.js 提供的 providers / model-map 视图，
// 为路由层提供:按 modelUid 查槽位、按 providerId 解析连接信息与运行期内存标记（绝不回写 providers.json）。

import { getModelMapConfig, getProviders, getSlots } from './config-cache.js';
import { getEquivalentModelUids, normalizeModelUid } from './lib/model-aliases.js';
import {
  cleanApiPath as cleanGeminiPath,
  inferApiFormatFromEndpoint,
  isVertexEndpoint,
  looksLikeGoogleOAuthCredential,
  normalizeGeminiApiPath as normalizeGeminiEndpointPath,
  resolveGeminiEndpoint,
} from './lib/google-gemini.js';

function cleanApiPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function parseApiHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return { error: 'API Host 为空' };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: `API Host 无效(${raw})` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `API Host 协议不支持(${url.protocol})` };
  }
  if (!url.hostname) return { error: `API Host 缺少主机名(${raw})` };
  return {
    protocol: url.protocol === 'http:' ? 'http' : 'https',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'http:' ? 80 : 443),
    basePath: cleanApiPath(url.pathname),
  };
}

function joinApiPath(basePath, apiPath) {
  const base = cleanApiPath(basePath);
  const path = cleanApiPath(apiPath);
  if (!base) return path || '/';
  if (!path) return base;
  if (path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

function isOfficialDashScopeHost(host) {
  const h = String(host || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  return /^(dashscope|dashscope-intl|dashscope-us)\.aliyuncs\.com$/.test(h);
}

function normalizeOpenAIApiPath(host, apiPath) {
  const path = cleanApiPath(apiPath);
  const lower = path.toLowerCase();

  // DashScope's OpenAI-compatible BYOK endpoint is not the native /api/v1 API.
  // Users usually paste the official base_url ending in /compatible-mode/v1.
  if (isOfficialDashScopeHost(host)) {
    if (lower.endsWith('/compatible-mode/v1/chat/completions') || lower.endsWith('/compatible-mode/v1/responses')) return path;
    if (lower === '/v1/chat/completions' || lower === '/api/v1/chat/completions') {
      return '/compatible-mode/v1/chat/completions';
    }
    if (lower === '/v1/responses' || lower === '/api/v1/responses') {
      return '/compatible-mode/v1/responses';
    }
    if (!path || lower === '/v1' || lower === '/api/v1' || lower === '/compatible-mode' || lower === '/compatible-mode/v1') {
      return '/compatible-mode/v1/chat/completions';
    }
    if (lower.endsWith('/compatible-mode/v1')) return `${path}/chat/completions`;
    if (lower.endsWith('/compatible-mode')) return `${path}/v1/chat/completions`;
  }

  // 通用 compatible-mode 补全：百炼 TokenPlan 等非 dashscope.aliyuncs.com 域名
  // 也使用 /compatible-mode 路径格式，需要补全 /v1/chat/completions。
  if (lower.includes('/compatible-mode')) {
    if (lower.endsWith('/compatible-mode/v1/chat/completions') || lower.endsWith('/compatible-mode/v1/responses')) return path;
    if (lower.endsWith('/compatible-mode/v1')) return `${path}/chat/completions`;
    if (lower.endsWith('/compatible-mode')) return `${path}/v1/chat/completions`;
  }

  if (lower.endsWith('/chat/completions') || lower.endsWith('/responses')) return path;

  if (!path) return '/v1/chat/completions';
  if (lower.endsWith('/v1')) return `${path}/chat/completions`;
  return path;
}

function normalizeAnthropicApiPath(apiPath) {
  const path = cleanApiPath(apiPath);
  const lower = path.toLowerCase();
  if (!path) return '/v1/messages';
  if (lower.endsWith('/messages')) return path;
  if (lower.endsWith('/v1')) return `${path}/messages`;
  return `${path}/v1/messages`;
}

function normalizeGeminiApiPath(host, apiPath, model) {
  return normalizeGeminiEndpointPath(host, apiPath, model, 'generateContent');
}

function shouldUseAnthropicBearerAuth(host, apiPath) {
  const hostname = String(host || '').split('/')[0].split(':')[0].toLowerCase();
  const path = normalizeAnthropicApiPath(apiPath).toLowerCase();
  return hostname === 'api.deepseek.com' && path.startsWith('/anthropic/');
}

function inferApiFormatFromPath(apiPath) {
  const path = cleanApiPath(apiPath).toLowerCase();
  if (!path) return null;
  if (path.endsWith('/chat/completions') || path.endsWith('/responses')) return 'openai';
  if (path.includes('/openai/') || /\/openai(?:$|\?)/.test(path) || path.includes('/endpoints/openapi') || path.includes('/compatible-mode')) return 'openai';
  if (path.endsWith('/messages') || path.includes('/messages/') || path.includes('/publishers/anthropic/') || path.includes(':rawpredict')) return 'anthropic';
  if (path.includes(':generatecontent')
      || path.includes(':streamgeneratecontent')
      || path.includes(':counttokens')
      || path === '/v1beta'
      || path.includes('/v1beta/')
      || path.includes('/publishers/google/models')) {
    return 'gemini';
  }
  return null;
}

function inferApiFormatFromHost(host, apiPath = null) {
  return inferApiFormatFromEndpoint(host, apiPath);
}

// 模型名启发：只作最后兜底（手动 unlock > target apiFormat > 端点/path/host 推断 > provider apiFormat > 模型名）。
// 启发可能猜错（如 gpt-6-astra-cc-format 实际只支持 messages 契约），
// 所以运行时永远允许 target.unlock / apiFormat 显式覆盖，猜测结果不否决任何显式配置。
function inferApiFormatFromModelName(model) {
  const m = String(model || '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 'anthropic';
  if (/gemini/.test(m)) return 'gemini';
  if (/gpt|swe|codex/.test(m) || /^o[134]/.test(m)) return 'openai';
  return null;
}

function inferTargetRouteFormat({
  targetApiFormat,
  unlockApiFormat,
  targetUnlock,
  providerApiFormat,
  explicitPath,
  providerPath,
  rawHost,
  host,
  model,
}) {
  if (unlockApiFormat) return { format: unlockApiFormat, source: targetUnlock };
  if (targetApiFormat) return { format: targetApiFormat, source: 'target-apiFormat' };

  const targetPathFormat = inferApiFormatFromPath(explicitPath);
  if (targetPathFormat?.error) return targetPathFormat;
  if (targetPathFormat) return { format: targetPathFormat, source: 'target-apiPath' };

  const providerPathFormat = inferApiFormatFromPath(providerPath);
  if (providerPathFormat?.error) return providerPathFormat;
  if (providerPathFormat) return { format: providerPathFormat, source: 'provider-apiPath' };

  const hostFormat = inferApiFormatFromHost(rawHost || host, explicitPath || providerPath || null);
  if (hostFormat) return { format: hostFormat, source: 'host' };

  if (providerApiFormat) return { format: providerApiFormat, source: 'provider-apiFormat' };

  const modelNameFormat = inferApiFormatFromModelName(model);
  if (modelNameFormat) return { format: modelNameFormat, source: 'model-name-heuristic' };

  return { format: 'openai', source: 'auto-default-openai' };
}

// 兼容旧 API：每次直接返回缓存的 providers Map（config-cache 已处理 mtime）。
export function loadProviders() {
  return getProviders();
}

export function loadModelMapConfig() {
  return getModelMapConfig();
}

// 返回该 modelUid 对应的槽位（启用且有 targets 才算可路由），否则 null。
export function getSlot(modelUid) {
  if (!modelUid) return null;
  const slots = getSlots();
  let entry = slots.get(modelUid) || slots.get(normalizeModelUid(modelUid));
  if (!entry) {
    const candidates = getEquivalentModelUids(modelUid);
    for (const cand of candidates) {
      entry = slots.get(cand) || slots.get(normalizeModelUid(cand));
      if (entry && entry.kind === 'slot') break;
    }
  }
  if (!entry || entry.kind !== 'slot') return null;
  const slot = entry.data;
  if (!slot || slot.enabled === false) return null;
  return slot;
}

// 返回该 modelUid 对应的注入项（任意时刻都返回，未配置也返回供 chat.js 报"未配置"），否则 null。
// kind: 'unconfigured'（已注入但没配 providerId/model）/ 'configured'（可用）
export function getInjectedByUid(modelUid) {
  if (!modelUid) return null;
  const slots = getSlots();
  let entry = slots.get(modelUid) || slots.get(normalizeModelUid(modelUid));
  if (!entry) {
    const candidates = getEquivalentModelUids(modelUid);
    for (const cand of candidates) {
      entry = slots.get(cand) || slots.get(normalizeModelUid(cand));
      if (entry && entry.kind === 'injected') break;
    }
  }
  if (!entry || entry.kind !== 'injected') return null;
  const inj = entry.data;
  const hasProvider = inj.providerId && inj.providerId.length > 0;
  const hasModel = inj.model && inj.model.trim().length > 0;
  return {
    label: inj.label,
    modelUid: inj.modelUid,
    providerId: hasProvider ? inj.providerId : null,
    model: hasModel ? inj.model : null,
    apiFormat: inj.apiFormat || inj.api_format || null,
    apiPath: inj.apiPath || inj.api_path || null,
    unlock: inj.unlock || null,
    thinkingEffort: inj.thinkingEffort || inj.thinking_effort || null,
    supportsImages: inj.supportsImages !== false,
    status: (hasProvider && hasModel) ? 'configured' : 'unconfigured',
  };
}

// 运行期记忆某个供应商的工具 schema 兼容模式（仅保留在内存，遵从 Rust 唯一写端）
const MAX_RUNTIME_MARK_ENTRIES = 2000;
const runtimeToolSchemaCompat = new Map();

function setBoundedRuntimeMap(map, key, val) {
  if (map.has(key)) map.delete(key);
  while (map.size >= MAX_RUNTIME_MARK_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, val);
}

export function rememberProviderToolSchemaCompat(providerId, mode = 'gemini') {
  if (!providerId || !mode) return false;
  const p = getProviders().get(providerId);
  if (!p) return false;
  const current = runtimeToolSchemaCompat.get(providerId) || p.capabilities?.toolSchemaCompat;
  if (current === mode) return false;
  setBoundedRuntimeMap(runtimeToolSchemaCompat, providerId, mode);
  return true;
}

function normalizeTargetUnlock(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'codex') return 'codex';
  if (raw === 'claudeCode' || raw === 'claude-code' || raw === 'claude_code') return 'claudeCode';
  return { error: `未知解锁类型(${raw})` };
}

function normalizeTargetApiFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'auto') return null;
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic') return 'anthropic';
  if (raw === 'gemini') return 'gemini';
  return { error: `未知目标协议(${raw})` };
}

function apiFormatForUnlock(kind) {
  if (kind === 'codex') return 'openai';
  if (kind === 'claudeCode') return 'anthropic';
  return null;
}

function providerUnlockEnabled(provider, kind) {
  const unlock = provider?.unlocks?.[kind];
  return !!(unlock && unlock.enabled !== false);
}

const targetKeyRotation = new Map();

function extractKeyPoolEntry(entry) {
  if (entry && typeof entry === 'object') {
    const key = String(entry.key ?? entry.apiKey ?? entry.value ?? '').trim();
    return { key, disabled: entry.enabled === false };
  }
  return { key: String(entry || '').trim(), disabled: false };
}

function collectTargetKeyPool(target, provider) {
  const seen = new Set();
  const disabledKeys = new Set();
  const out = [];
  const pushKey = (key) => {
    const s = String(key || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  const providerList = Array.isArray(provider?.apiKeys || provider?.api_keys) ? (provider.apiKeys || provider.api_keys) : [];
  for (const raw of providerList) {
    const parsed = extractKeyPoolEntry(raw);
    if (parsed.key && parsed.disabled) disabledKeys.add(parsed.key);
  }
  const targetList = Array.isArray(target?.apiKeys || target?.api_keys) ? (target.apiKeys || target.api_keys) : [];
  for (const raw of targetList) {
    const parsed = extractKeyPoolEntry(raw);
    if (parsed.key && !parsed.disabled) pushKey(parsed.key);
  }
  const primary = String(provider?.apiKey || '').trim();
  if (primary && !disabledKeys.has(primary)) pushKey(primary);
  for (const raw of providerList) {
    const parsed = extractKeyPoolEntry(raw);
    if (parsed.key && !parsed.disabled) pushKey(parsed.key);
  }
  return out;
}

export function getApiKeyCandidates(target, providers) {
  const provider = target?.providerId ? providers?.get?.(target.providerId) : null;
  const pool = collectTargetKeyPool(target, provider);
  if (pool.length <= 1) return pool;
  const rotationKey = `${target?.providerId || target?.provider_id || ''}|${target?.model || ''}`;
  const start = targetKeyRotation.get(rotationKey) || 0;
  return pool.map((_, idx) => pool[(start + idx) % pool.length]);
}

function apiKeyForTarget(target, provider) {
  const pool = collectTargetKeyPool(target, provider);
  if (!pool.length) return provider?.apiKey;
  if (pool.length === 1) return pool[0];
  const rotationKey = `${target.providerId || target.provider_id || ''}|${target.model || ''}`;
  const next = targetKeyRotation.get(rotationKey) || 0;
  setBoundedRuntimeMap(targetKeyRotation, rotationKey, (next + 1) % pool.length);
  return { primary: pool[next % pool.length], orderedPool: pool.map((_, i) => pool[(next + i) % pool.length]) };
}

// 把一个 target {providerId, model, apiFormat, unlock?} 解析成实际连接信息。
// 供应商不存在或被禁用 → 返回 {error}。
export function resolveTarget(target, providers) {
  const p = providers.get(target.providerId);
  if (!p) return { error: `供应商不存在(${target.providerId})` };
  if (p.enabled === false) return { error: `供应商已禁用(${p.name})` };

  const targetUnlock = normalizeTargetUnlock(target.unlock);
  if (targetUnlock?.error) return { error: targetUnlock.error };
  const targetApiFormat = normalizeTargetApiFormat(target.apiFormat || target.api_format);
  if (targetApiFormat?.error) return { error: targetApiFormat.error };
  // 供应商未开启对应解锁 → 不加 unlock 参数，普通请求，不报错
  let effectiveUnlock = targetUnlock;
  if (effectiveUnlock && !providerUnlockEnabled(p, effectiveUnlock)) {
    effectiveUnlock = null;
  }
  // 协议族不再按模型名猜测：AnyRouter 存在 gpt 命名却只支持 messages 契约的模型
  // （如 gpt-6-astra-cc-format，走 /v1/responses 会 400 not implemented）。
  // 是否解锁、走哪个契约由 target.unlock + apiFormat 显式声明；配错时由上游明确报错，
  // 而不是在本地静默改写请求契约。
  const unlockApiFormat = apiFormatForUnlock(effectiveUnlock);
  if (targetApiFormat && unlockApiFormat && targetApiFormat !== unlockApiFormat) {
    return { error: `目标协议 ${targetApiFormat} 与${effectiveUnlock === 'codex' ? ' Codex' : ' Claude Code'} 解锁不匹配` };
  }
  const parsedHost = parseApiHost(p.apiHost);
  if (parsedHost?.error) return { error: parsedHost.error };
  const host = parsedHost.hostname;
  const explicitPath = target.apiPath || target.api_path || null;
  const unlockConfig = effectiveUnlock ? p.unlocks?.[effectiveUnlock] : null;
  const unlockWireApi = unlockConfig?.wireApi || unlockConfig?.wire_api || null;
  if (effectiveUnlock && explicitPath && unlockWireApi && cleanApiPath(explicitPath) !== cleanApiPath(unlockWireApi)) {
    return { error: `${effectiveUnlock === 'codex' ? 'Codex' : 'Claude Code'} 解锁目标不支持覆盖 apiPath；请留空并使用供应商解锁模板 ${cleanApiPath(unlockWireApi)}` };
  }
  const providerPath = p.apiPath || p.api_path || null;
  const providerApiFormatParsed = normalizeTargetApiFormat(p.apiFormat || p.api_format);
  const providerApiFormat = typeof providerApiFormatParsed === 'string' ? providerApiFormatParsed : null;
  const modelId = target.model || p.defaultModel;
  const selectedKey = apiKeyForTarget(target, p);
  const resolvedApiKey = typeof selectedKey === 'object' && selectedKey !== null ? selectedKey.primary : selectedKey;
  const orderedKeyPool = typeof selectedKey === 'object' && selectedKey !== null
    ? selectedKey.orderedPool
    : (resolvedApiKey ? [String(resolvedApiKey)] : []);
  const route = inferTargetRouteFormat({
    targetApiFormat,
    unlockApiFormat,
    targetUnlock: effectiveUnlock,
    providerApiFormat,
    explicitPath,
    providerPath,
    rawHost: p.apiHost,
    host,
    model: modelId,
  });
  if (route?.error) return { error: route.error };
  const routeFormat = route.format;
  const configuredPath = (explicitPath || unlockWireApi || providerPath) && (explicitPath || unlockWireApi || providerPath) !== '/'
    ? (explicitPath || unlockWireApi || providerPath)
    : null;

  let resolvedHost = host;
  let resolvedHostname = parsedHost.hostname;
  let resolvedProtocol = parsedHost.protocol;
  let resolvedPort = parsedHost.port;
  let finalApiPath;
  let isVertex = false;

  if (routeFormat === 'gemini' && !unlockWireApi) {
    const endpoint = resolveGeminiEndpoint(p.apiHost, configuredPath, modelId, resolvedApiKey, 'generateContent');
    resolvedHost = endpoint.hostname;
    resolvedHostname = endpoint.hostname;
    resolvedProtocol = endpoint.protocol;
    resolvedPort = endpoint.port;
    finalApiPath = endpoint.apiPath;
    isVertex = endpoint.isVertex;
  } else {
    const apiPath = unlockWireApi && !explicitPath
      ? cleanApiPath(unlockWireApi)
      : (routeFormat === 'openai'
        ? (!configuredPath && /\/openai$/i.test(parsedHost.basePath) ? '/chat/completions' : normalizeOpenAIApiPath(host, configuredPath))
        : (routeFormat === 'gemini'
          ? normalizeGeminiApiPath(p.apiHost, configuredPath, modelId)
          : normalizeAnthropicApiPath(configuredPath)));
    // wireApi=chat 是普通 OpenAI 兼容供应商的提示；平台解锁目标使用自己的 wireApi，不应被覆盖。
    const routeApiPath = (routeFormat === 'openai' && p.wireApi === 'chat' && !explicitPath && !effectiveUnlock)
      ? apiPath.replace(/\/responses$/, '/chat/completions')
      : apiPath;
    finalApiPath = (routeFormat === 'gemini' && !unlockWireApi)
      ? routeApiPath
      : joinApiPath(parsedHost.basePath, routeApiPath);
    isVertex = routeFormat === 'gemini' && isVertexEndpoint(p.apiHost, finalApiPath);
  }
  const hasGoogleOAuth = routeFormat === 'gemini' && looksLikeGoogleOAuthCredential(resolvedApiKey);
  // 合并供应商级 + 模型级 + 运行期内存能力标记
  const supplierCaps = p.capabilities || {};
  const memCompat = runtimeToolSchemaCompat.get(p.id);
  const modelCaps = (p.modelCaps || {})[modelId] || {};
  const memCaps = runtimeModelCaps.get(`${p.id}|${modelId}`) || {};
  const mergedModelCaps = { ...modelCaps, ...memCaps };
  const hasModelVision = Object.prototype.hasOwnProperty.call(mergedModelCaps, 'vision');
  const hasModelTools = Object.prototype.hasOwnProperty.call(mergedModelCaps, 'tools');
  const capabilities = {
    ...supplierCaps,
    ...(memCompat ? { toolSchemaCompat: memCompat } : {}),
    // 模型级覆盖供应商级（vision/tools 是模型能力）。
    // Provider 级 vision=false 可能来自小图探测误判，不能作为图片请求硬拦截依据。
    vision: hasModelVision ? mergedModelCaps.vision : true,
    tools: hasModelTools ? mergedModelCaps.tools : supplierCaps.tools,
  };
  const conn = {
    providerId: p.id,
    providerName: p.name,
    host: resolvedHost,
    hostname: resolvedHostname,
    protocol: resolvedProtocol,
    port: resolvedPort,
    apiPath: finalApiPath,
    apiKey: resolvedApiKey,
    format: routeFormat,
    routeSource: route.source,
    authScheme: (routeFormat === 'openai' || hasGoogleOAuth || shouldUseAnthropicBearerAuth(resolvedHost, finalApiPath)) ? 'bearer' : 'x-api-key',
    isVertex,
    hasGoogleOAuth,
    model: modelId,
    capabilities,
    unlocks: p.unlocks || {},
    unlockKind: effectiveUnlock,
    wireApi: p.wireApi || '',
    codexChatReasoning: p.codexChatReasoning || null,
  };
  if (orderedKeyPool.length > 0) {
    Object.defineProperty(conn, '_apiKeyCandidates', { value: orderedKeyPool, enumerable: false, configurable: true });
  }
  return conn;
}

export function connWithApiKey(conn, nextKey) {
  const apiKey = String(nextKey || '').trim();
  if (!conn || !apiKey || apiKey === conn.apiKey) return conn;
  const hasGoogleOAuth = conn.format === 'gemini' && looksLikeGoogleOAuthCredential(apiKey);
  const authScheme = (conn.format === 'openai' || hasGoogleOAuth || shouldUseAnthropicBearerAuth(conn.hostname || conn.host, conn.apiPath))
    ? 'bearer'
    : 'x-api-key';
  const updated = { ...conn, apiKey, hasGoogleOAuth, authScheme };
  if (Array.isArray(conn._apiKeyCandidates)) {
    Object.defineProperty(updated, '_apiKeyCandidates', { value: conn._apiKeyCandidates, enumerable: false, configurable: true });
  }
  return updated;
}

// 运行期更新模型能力标记（仅维持在内存 Map，绝不回写 providers.json）
const runtimeModelCaps = new Map();

export function updateModelCapabilities(providerId, modelId, hasVision, hasTools) {
  if (!providerId || !modelId) return false;
  const key = `${providerId}|${modelId}`;
  const cur = { ...(runtimeModelCaps.get(key) || {}) };
  let changed = false;
  if (hasVision && cur.vision !== true) { cur.vision = true; changed = true; }
  if (hasTools && cur.tools !== true) { cur.tools = true; changed = true; }
  if (changed) {
    setBoundedRuntimeMap(runtimeModelCaps, key, cur);
  }
  return changed;
}
