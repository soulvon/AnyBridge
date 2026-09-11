// antigravity-handler.js — Google Antigravity (v1internal) 专有协议适配器
//
// 核心设计与防卡死架构：
// 1. 100% 对齐 Antigravity Protobuf JSON 规范（FetchAvailableModelsResponse）：
//    - models: map<string, ModelDetails>，每个模型必须提供 model/displayName/supportedMimeTypes
//    - defaultAgentModelId: 默认生效模型 ID
//    - agentModelSorts: 组织 Recommended 与 AnyBridge 自定义模型分组
// 2. 彻底移除伪造的 cloudaicompanionProject（引发 Go 语言服务器 CAIC 死循环的毒丸），
//    提供合规稳定的 loadCodeAssist / retrieveUserQuotaSummary 响应，杜绝掉登录与请求风暴。
// 3. Singleflight 防抖缓存机制：
//    IDE 启动时的瞬时并发握手与模型拉取请求共享处理状态，并提供平滑内存快照，杜绝 Preact 队列无限循环。
// 4. 精准模型分流：
//    自定义接入模型本地拦截并转换上游协议，官方模型透明走科学透传。

import https from 'node:https';
import { httpsAgentFor } from '../system-proxy.js';

export const OFFICIAL_ANTIGRAVITY_HOSTS = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
];
export const OFFICIAL_ANTIGRAVITY_HOST = OFFICIAL_ANTIGRAVITY_HOSTS[0];

// 官方出站单次尝试硬超时：必须覆盖 DNS 解析 / 代理 CONNECT / TLS / 响应全阶段。
// https.request 的 timeout 选项无法约束连接建立期，黑洞网络下会无限挂起并拖死 hybrid 握手。
export const OFFICIAL_ATTEMPT_TIMEOUT_MS = 1200;

// Singleflight 状态管理与平滑短效缓存（杜绝 IDE 启动阶段的请求风暴与重复探测）
const inFlightPromises = new Map();
const responseSnapshotCache = new Map();

export async function singleflight(key, ttlMs, taskFn) {
  const cached = responseSnapshotCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  if (inFlightPromises.has(key)) {
    return inFlightPromises.get(key);
  }
  const promise = (async () => {
    try {
      const data = await taskFn();
      if (data !== undefined && data !== null) {
        responseSnapshotCache.set(key, { data, expiresAt: Date.now() + ttlMs });
      }
      return data;
    } finally {
      inFlightPromises.delete(key);
    }
  })();
  inFlightPromises.set(key, promise);
  return promise;
}

export function clearAntigravityCache() {
  responseSnapshotCache.clear();
  inFlightPromises.clear();
}

export function isAntigravityPath(pathname) {
  const p = String(pathname || '');
  return p.startsWith('/v1internal:')
    || p.startsWith('/v1internal/')
    || p.startsWith('/antigravity/v1internal:')
    || p.startsWith('/antigravity/v1internal/')
    || p === '/antigravity'
    || p.startsWith('/antigravity/');
}

export function getAntigravityMethod(pathname) {
  const p = String(pathname || '');
  const colonIndex = p.lastIndexOf(':');
  if (colonIndex !== -1) {
    const afterColon = p.slice(colonIndex + 1).split(/[?#/]/)[0];
    if (afterColon) return afterColon;
  }
  const m = p.match(/v1internal[:/]([^?#/]+)/);
  return m ? m[1] : '';
}

export function cleanAntigravityModelId(model) {
  if (!model) return '';
  return String(model).replace(/^models\//, '').trim();
}

// BYOK 自定义模型可占用的运行枚举槽位。
//
// 铁律：槽位枚举必须同时存在于 IDE 前端 Model enum（main.js）与 Go 语言服务器二进制中。
// 前端 enum 里没有 MODEL_CHAT_GPT_4 / MODEL_CHAT_O3 / MODEL_CHAT_O1 / MODEL_DEEPSEEK_R1
// （这些是 Go 侧旧版枚举，前端早已移除）——一旦分配给 BYOK 模型，前端 proto 解析到
// 未知枚举值会触发渲染进程 Preact 无限循环（CPU 100%、内存飙至 2GB），窗口直接卡死。
// 同样禁止把以下枚举直接分配给用户模型：
// 1. MODEL_PLACEHOLDER_M<N>：属于 Language Server 内部模型；M36/M50/M318 在下方单独隐藏注册。
// 2. MODEL_GOOGLE_GEMINI_INTERNAL_BYOM：强制要求请求级 model info override，目录注入链路不提供。
export const ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS = [
  'MODEL_CLAUDE_4_SONNET',
  'MODEL_CLAUDE_4_SONNET_THINKING',
  'MODEL_CLAUDE_4_OPUS',
  'MODEL_CLAUDE_4_OPUS_THINKING',
  'MODEL_CLAUDE_4_5_SONNET',
  'MODEL_CLAUDE_4_5_SONNET_THINKING',
  'MODEL_CLAUDE_4_5_HAIKU',
  'MODEL_CLAUDE_4_5_HAIKU_THINKING',
  'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
];

/**
 * 根据被占用的运行枚举槽位，反推与之一致的 ModelProvider。
 *
 * 关键：ModelDetails.model 字段（运行枚举）与 modelProvider 必须自洽，
 * 否则 Go 语言服务器会把该模型误判为「非官方模型」并重新映射到 MODEL_PLACEHOLDER_M<N>，
 * 从而在构造 executor 时抛 "unknown model key ... model not found"。
 */
function modelProviderForRuntimeModel(runtimeModelId) {
  if (runtimeModelId.startsWith('MODEL_CLAUDE_')) return 'MODEL_PROVIDER_ANTHROPIC';
  if (runtimeModelId.startsWith('MODEL_OPENAI_')) return 'MODEL_PROVIDER_OPENAI';
  return 'MODEL_PROVIDER_GOOGLE';
}

function apiProviderForRuntimeModel(runtimeModelId) {
  if (runtimeModelId.startsWith('MODEL_CLAUDE_')) return 'API_PROVIDER_ANTHROPIC_VERTEX';
  if (runtimeModelId.startsWith('MODEL_OPENAI_')) return 'API_PROVIDER_OPENAI_VERTEX';
  return 'API_PROVIDER_GOOGLE_GEMINI';
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function stableHexHash(value) {
  return fnv1a32(value).toString(16).padStart(8, '0');
}

function readableCatalogModelId(modelId) {
  const readable = cleanAntigravityModelId(modelId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return readable || 'model';
}

function configuredModelsForAntigravity(config) {
  return Array.from(new Set([
    config?.defaultModel,
    ...(Array.isArray(config?.models) ? config.models : []),
    ...(Array.isArray(config?.modelCatalog) ? config.modelCatalog.map(entry => entry?.model) : []),
  ].map(cleanAntigravityModelId).filter(Boolean)));
}

function customModelSeed(config, upstreamModel) {
  const providerId = String(config?.sourceProviderId || config?.providerId || config?.id || config?.sourceProviderName || config?.name || 'anybridge').trim();
  return `${providerId}\u0000${cleanAntigravityModelId(upstreamModel)}`;
}

function allocateRuntimeModelId(seed, occupiedIds) {
  const slotCount = ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS.length;
  const preferredIndex = fnv1a32(seed) % slotCount;
  for (let i = 0; i < slotCount; i++) {
    const idx = (preferredIndex + i) % slotCount;
    const candidate = ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS[idx];
    if (!occupiedIds.has(candidate)) {
      occupiedIds.add(candidate);
      return candidate;
    }
  }
  return ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS[preferredIndex];
}

function buildAntigravityCustomModelIdentities(providersJson = {}) {
  const occupiedRuntimeIds = new Set();
  const identities = [];
  const configs = Array.isArray(providersJson.antigravityConfigs) ? providersJson.antigravityConfigs : [];
  for (const config of configs) {
    if (!config || config.enabled === false || config.injectModels === false) continue;
    for (const upstreamModel of configuredModelsForAntigravity(config)) {
      const seed = customModelSeed(config, upstreamModel);
      const runtimeModelId = allocateRuntimeModelId(seed, occupiedRuntimeIds);
      const catalogKey = `byok-${readableCatalogModelId(upstreamModel)}-${stableHexHash(seed)}`;
      identities.push({ config, upstreamModel, runtimeModelId, catalogKey });
    }
  }
  return identities;
}

const ANTIGRAVITY_INTERNAL_RUNTIME_MODELS = [
  {
    catalogKey: 'anybridge-internal-checkpoint',
    runtimeModelId: 'MODEL_PLACEHOLDER_M50',
    displayName: 'AnyBridge Internal Checkpoint',
  },
  {
    catalogKey: 'anybridge-internal-fast-model',
    runtimeModelId: 'MODEL_PLACEHOLDER_M318',
    displayName: 'AnyBridge Internal Fast Model',
  },
  {
    catalogKey: 'anybridge-internal-checkpoint-fallback',
    runtimeModelId: 'MODEL_PLACEHOLDER_M36',
    displayName: 'AnyBridge Internal Checkpoint Fallback',
  },
];

function activeAntigravityIdentity(providersJson = {}) {
  const identities = buildAntigravityCustomModelIdentities(providersJson);
  const activeId = providersJson.platforms?.antigravity?.providerId;
  if (activeId) {
    const active = identities.filter(identity =>
      identity.config?.id === activeId || identity.config?.name === activeId
    );
    const defaultModel = cleanAntigravityModelId(active[0]?.config?.defaultModel);
    return active.find(identity => identity.upstreamModel === defaultModel) || active[0] || identities[0] || null;
  }
  const firstDefault = cleanAntigravityModelId(identities[0]?.config?.defaultModel);
  return identities.find(identity => identity.upstreamModel === firstDefault) || identities[0] || null;
}

function addAntigravityInternalModels(models) {
  for (const dependency of ANTIGRAVITY_INTERNAL_RUNTIME_MODELS) {
    if (Object.values(models).some(model => model?.model === dependency.runtimeModelId)) continue;
    models[dependency.catalogKey] = {
      model: dependency.runtimeModelId,
      displayName: dependency.displayName,
      description: 'AnyBridge Language Server internal dependency',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      maxTokens: 1048576,
      maxOutputTokens: 65535,
      disabled: false,
      recommended: false,
      supportedMimeTypes: {},
    };
  }
}

// 记录 IDE 最近一次实际使用的 BYOK 模型；内部依赖模型（checkpoint / fast model）
// 会跟随它，避免默认 provider 冷却时内部请求持续失败并把错误提示插入对话。
let lastActiveIdentity = null;

function isIdentityUsable(identity, providersJson = {}) {
  if (!identity?.config?.id || !identity?.upstreamModel) return false;
  const configs = Array.isArray(providersJson.antigravityConfigs) ? providersJson.antigravityConfigs : [];
  return configs.some(config =>
    config && config.id === identity.config.id
    && config.enabled !== false && config.injectModels !== false
    && Array.isArray(config.models) && config.models.includes(identity.upstreamModel)
  );
}

/**
 * 判断目标模型是否为 AnyBridge 中配置并启用的第三方接入模型。
 * 兼容 IDE 实际发送的 MODEL_PLACEHOLDER_Mxxx、目录中的 byok-* catalogKey 以及原始上游模型 ID。
 */
export function resolveAntigravityCustomModel(modelId, providersJson = {}) {
  const requested = cleanAntigravityModelId(modelId);
  if (!requested) return null;
  const normalized = requested.toLowerCase();
  // 内部依赖模型既可能以运行枚举（MODEL_PLACEHOLDER_M50）发送，
  // 也可能以目录键（anybridge-internal-checkpoint）发送，两者都必须识别。
  // 只认运行枚举会导致 LS 请求内部 checkpoint / fast model 时解析失败，
  // 代理返回 400 JSON，LS 在流式解析时空指针崩溃（generation.go:680）。
  const internal = ANTIGRAVITY_INTERNAL_RUNTIME_MODELS.find(dependency =>
    dependency.runtimeModelId.toLowerCase() === normalized
    || String(dependency.catalogKey || '').toLowerCase() === normalized
  );
  if (internal) {
    // 内部依赖模型优先跟随用户当前正在使用的模型：默认 provider 冷却时，
    // 若仍路由到它会持续失败并把错误提示插入对话；跟随当前模型可保持可用。
    const preferred = isIdentityUsable(lastActiveIdentity, providersJson) ? lastActiveIdentity : null;
    const active = preferred || activeAntigravityIdentity(providersJson);
    return active ? { ...active, exposedModel: active.upstreamModel, isInternalDependency: true } : null;
  }
  for (const identity of buildAntigravityCustomModelIdentities(providersJson)) {
    const { config, upstreamModel, runtimeModelId, catalogKey } = identity;
    const acceptedIds = [
      upstreamModel,
      runtimeModelId,
      catalogKey,
      config.id,
      config.name,
    ].map(cleanAntigravityModelId).filter(Boolean).map(value => value.toLowerCase());
    if (acceptedIds.includes(normalized)) {
      lastActiveIdentity = { config, upstreamModel, runtimeModelId, catalogKey };
      return {
        config,
        upstreamModel,
        exposedModel: upstreamModel,
        runtimeModelId,
        catalogKey,
      };
    }
  }
  return null;
}

export function isAntigravityCustomModel(modelId, providersJson = {}) {
  return resolveAntigravityCustomModel(modelId, providersJson) !== null;
}

const COMMON_IMAGE_MIMES = {
  'image/png': true,
  'image/jpeg': true,
  'image/jpg': true,
  'image/webp': true,
  'image/gif': true,
};

/**
 * 官方目录缺失时的兜底响应（严格契合 IDE 前端 Protobuf 字段契约）。
 *
 * 严禁在此伪造/注入任何官方模型。曾经尝试注入官方 Gemini 枚举
 * （MODEL_GOOGLE_GEMINI_2_5_PRO / FLASH / FLASH_THINKING / FLASH_LITE）以缓解 Cascade 的
 * "unknown model key ... model not found" 后台报错，实测会触发 IDE 前端渲染进程
 * Preact 队列无限循环（渲染进程 CPU 100%、内存飙至 2GB，窗口直接无响应卡死）。
 *
 * 那些 Cascade 报错属于后台噪音，不影响 IDE 打开与发消息；而前端死循环是致命的。
 * 因此官方目录缺失时必须保持空目录，只注入本地 BYOK 模型。
 */
export function defaultOfficialModelsResponse() {
  // 官方目录拉取失败时不伪造官方模型。参考 Antigravity Studio 的 fallback 行为：
  // 返回空官方目录，再仅注入本地 BYOK 模型，避免未知字符串被解析成 MODEL_UNSPECIFIED。
  return {
    models: {},
    agentModelSorts: [],
  };
}

function resolveDefaultAntigravityCatalogKey(providersJson = {}, injectedIds = []) {
  const activeId = providersJson.platforms?.antigravity?.providerId;
  const identities = buildAntigravityCustomModelIdentities(providersJson);
  if (activeId) {
    const found = identities.find(i => i.config?.id === activeId || i.config?.name === activeId);
    if (found && injectedIds.includes(found.catalogKey)) {
      return found.catalogKey;
    }
  }
  return injectedIds[0] || '';
}

/**
 * 动态合并官方模型与 AnyBridge 自定义模型
 */
export function mergeAntigravityModelsResponse(officialResponse = {}, providersJson = {}) {
  let response;
  if (
    officialResponse
    && typeof officialResponse === 'object'
    && officialResponse.models
    && !Array.isArray(officialResponse.models)
    && typeof officialResponse.models === 'object'
    && Object.keys(officialResponse.models).length > 0
  ) {
    response = structuredClone(officialResponse);
  } else {
    response = defaultOfficialModelsResponse();
  }

  const models = response.models || {};
  const injectedIds = [];
  addAntigravityInternalModels(models);

  for (const identity of buildAntigravityCustomModelIdentities(providersJson)) {
    const { config, upstreamModel, runtimeModelId, catalogKey } = identity;
    const providerName = config.sourceProviderName || config.name || 'AnyBridge';
    const supportsImages = config.useThirdPartyVision !== true;
    models[catalogKey] = {
      catalogKey,
      runtimeModelId,
      providerModelId: upstreamModel,
      name: `models/${runtimeModelId}`,
      model: runtimeModelId,
      planModel: runtimeModelId,
      requestedModel: runtimeModelId,
      displayName: `${upstreamModel} (${providerName})`,
      description: `Custom BYOK Model (Provider: ${providerName})`,
      apiProvider: apiProviderForRuntimeModel(runtimeModelId),
      modelProvider: modelProviderForRuntimeModel(runtimeModelId),
      recommended: false,
      disabled: false,
      supportsImages,
      supportsThinking: true,
      supportsTools: true,
      roles: ['agent'],
      inputModalities: supportsImages ? ['text', 'image'] : ['text'],
      outputModalities: ['text'],
      maxTokens: Number(config.contextWindow) || 262144,
      maxOutputTokens: 65536,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      supportedMimeTypes: supportsImages ? COMMON_IMAGE_MIMES : {},
      vertexModelId: upstreamModel,
      tagTitle: providerName,
      tagDescription: 'BYOK',
    };
    injectedIds.push(catalogKey);
  }

  // 只规范化 MIME 映射；不要改写官方 model 枚举或其他原始字段。
  for (const val of Object.values(models)) {
    if (!val) continue;
    const sourceMimes = val.supportedMimeTypes && typeof val.supportedMimeTypes === 'object'
      ? val.supportedMimeTypes
      : {};
    val.supportedMimeTypes = Object.fromEntries(
      Object.entries(sourceMimes).map(([mime, enabled]) => [mime, enabled !== false]),
    );
  }

  response.models = models;

  if (injectedIds.length > 0) {
    // 1. 必须始终保证 agentModelSorts 具有至少一个分组：
    //    IDE 前端 main.js 中的 r2l 函数仅通过遍历 agentModelSorts 的 groups 来生成 clientModelConfigs，
    //    若 sorts 为空，前端展示的可用模型列表即为空（显示 No models available）。
    if (!Array.isArray(response.agentModelSorts) || response.agentModelSorts.length === 0) {
      response.agentModelSorts = [
        {
          displayName: 'Recommended',
          groups: [
            {
              displayName: 'AnyBridge',
              modelIds: [...injectedIds],
            },
          ],
        },
      ];
    } else {
      const firstSort = response.agentModelSorts.find(s => s && typeof s === 'object');
      if (firstSort) {
        if (!Array.isArray(firstSort.groups) || firstSort.groups.length === 0) {
          firstSort.groups = [{ displayName: 'AnyBridge', modelIds: [] }];
        }
        const firstGroup = firstSort.groups[0];
        if (!Array.isArray(firstGroup.modelIds)) {
          firstGroup.modelIds = [];
        }
        for (const catalogKey of injectedIds) {
          if (!firstGroup.modelIds.includes(catalogKey)) {
            firstGroup.modelIds.unshift(catalogKey);
          }
        }
      }
    }

    // 2. 设置合规的 defaultAgentModelId，优先指向当前选中的 AnyBridge 模型
    if (!response.defaultAgentModelId || !Object.prototype.hasOwnProperty.call(models, response.defaultAgentModelId)) {
      const defaultCatalogKey = resolveDefaultAntigravityCatalogKey(providersJson, injectedIds);
      if (defaultCatalogKey) {
        response.defaultAgentModelId = defaultCatalogKey;
      }
    }
  }

  return response;
}

/**
 * 兼容旧方法名与单元测试（数组形式导出）
 */
export function buildAntigravityModelsList(providersJson = {}) {
  const merged = mergeAntigravityModelsResponse({}, providersJson);
  const result = [];
  for (const [key, details] of Object.entries(merged.models || {})) {
    if (key.startsWith('anybridge-internal-')) continue;
    const runtimeModelId = details.model || key;
    result.push({
      name: `models/${runtimeModelId}`,
      model: `models/${runtimeModelId}`,
      catalogKey: key,
      displayName: details.displayName || key,
      description: details.description || key,
      supportedGenerationMethods: details.supportedGenerationMethods || ['generateContent', 'streamGenerateContent', 'countTokens'],
      supportsImages: details.supportsImages !== false,
      supportsThinking: details.supportsThinking === true,
    });
  }
  return result;
}

export function mergeAntigravityModelsList(baseModels = [], providersJson = {}) {
  return buildAntigravityModelsList(providersJson);
}

function officialHeaders(reqHeaders, payload, host) {
  const headers = { ...reqHeaders };
  delete headers.host;
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['content-length'];
  headers.host = host || OFFICIAL_ANTIGRAVITY_HOST;
  if (payload) headers['content-length'] = String(payload.length);
  return headers;
}

/**
 * 官方出站请求的硬超时控制。
 *
 * https.request 的 timeout 选项只覆盖 socket 空闲阶段，DNS 解析、代理 CONNECT
 * 隧道建立（系统代理 agent 默认 30s）均不受其约束——一旦网络/代理黑洞，
 * 请求会无限挂起，而 hybrid 模式的握手处理器都是 await 等待，
 * 将直接导致 Antigravity IDE 启动阶段 State refresh 无响应而整体卡死。
 * 这里用 AbortController 在全生命周期强制中断。
 */
function officialRequestWithHardTimeout(host, options, payload, onResponse, timeoutMs) {
  return new Promise((resolve) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const upstream = https.request({
      agent: httpsAgentFor(),
      hostname: host,
      port: 443,
      signal: abort.signal,
      ...options,
    }, (upstreamRes) => {
      onResponse(upstreamRes, finish);
    });
    upstream.on('error', () => finish(null));
    upstream.on('timeout', () => {
      upstream.destroy();
      finish(null);
    });
    upstream.end(payload || undefined);
  });
}

function officialRequestOnce(host, req, payload, pathname, search, timeoutMs) {
  return officialRequestWithHardTimeout(
    host,
    {
      path: pathname + search,
      method: req.method,
      headers: officialHeaders(req.headers, payload, host),
      rejectUnauthorized: true,
      timeout: timeoutMs,
    },
    payload,
    (upstreamRes, finish) => {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => finish({
        statusCode: upstreamRes.statusCode || 502,
        headers: upstreamRes.headers,
        body: Buffer.concat(chunks),
      }));
      upstreamRes.on('error', () => finish(null));
    },
    timeoutMs,
  );
}

/**
 * 探测并拉取 Google 官方模型列表（带超时保护与单飞缓存）
 */
export async function fetchOfficialAntigravityModels(req, body) {
  return singleflight('official_models_response', 30000, async () => {
    const url = new URL(req.url, 'http://localhost');
    const payload = body === undefined || body === null
      ? Buffer.from('{}', 'utf8')
      : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
    const results = await Promise.all(
      OFFICIAL_ANTIGRAVITY_HOSTS.map(host =>
        officialRequestOnce(host, req, payload, '/v1internal:fetchAvailableModels', url.search, 1500)
      )
    );
    const ok = results.find(r => r && r.statusCode >= 200 && r.statusCode < 300 && r.body);
    if (ok) {
      try {
        const parsed = JSON.parse(ok.body.toString('utf8'));
        if (parsed && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
          return parsed;
        }
      } catch {}
    }
    return null;
  });
}

/**
 * 将请求透传至 Google 官方服务器，若网络不通或鉴权失败快速优雅回调 onFailed。
 *
 * 每个 host 使用 AbortController 硬超时（1200ms，覆盖 DNS / 代理 CONNECT / TLS / 响应），
 * 三个 host 串行尝试总耗时上限约 3.6s，绝不允许单个黑洞连接拖死 hybrid 握手链路。
 */
export async function forwardToOfficialAntigravity(req, res, { body, customPath, onFailed } = {}) {
  const hosts = OFFICIAL_ANTIGRAVITY_HOSTS;
  const url = new URL(req.url, 'http://localhost');
  let pathname = customPath || url.pathname;
  if (pathname.startsWith('/antigravity/')) pathname = pathname.replace(/^\/antigravity/, '');
  else if (pathname === '/antigravity') pathname = '/';
  const fullPath = pathname + url.search;

  let payload = body;
  if (payload !== undefined && payload !== null && !Buffer.isBuffer(payload)) {
    payload = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  }

  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    const isLast = i === hosts.length - 1;
    try {
      const handled = await officialRequestWithHardTimeout(
        host,
        {
          path: fullPath,
          method: req.method,
          headers: officialHeaders(req.headers, payload, host),
          rejectUnauthorized: true,
          timeout: OFFICIAL_ATTEMPT_TIMEOUT_MS,
        },
        payload,
        (fwdRes, finish) => {
          // 如果官方返回 401 / 403 且提供了兜底回调，立即优雅切换到兜底响应，绝不向客户端下发 401 导致掉登录
          if ((fwdRes.statusCode === 401 || fwdRes.statusCode === 403) && typeof onFailed === 'function') {
            fwdRes.resume();
            finish(false);
            return;
          }
          const resHeaders = { ...fwdRes.headers };
          resHeaders['access-control-allow-origin'] = '*';
          resHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
          resHeaders['access-control-allow-headers'] = '*';

          res.writeHead(fwdRes.statusCode, resHeaders);
          fwdRes.pipe(res);
          fwdRes.on('end', () => finish(true));
          fwdRes.on('error', () => {
            if (!res.writableEnded) res.end();
            finish(true);
          });
        },
        OFFICIAL_ATTEMPT_TIMEOUT_MS,
      );

      if (handled) return;
    } catch {
      if (isLast) break;
    }
  }

  if (typeof onFailed === 'function') {
    onFailed();
  } else if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 502, message: '官方服务器连接失败' } }));
  }
}

/**
 * 极其合规的 Mock 配额及服务能力（彻底移除毒丸项目字段，秒级返回，杜绝重试风暴）
 */
export function mockAntigravityLoadCodeAssist() {
  return {
    currentTier: {
      id: 'standard-tier',
      name: 'Standard Tier',
      isDefault: true,
    },
    paidTier: {
      id: 'paid-tier',
      name: 'Paid Tier',
      availableCredits: [
        {
          creditType: 'GOOGLE_ONE_AI',
          creditAmount: 1000000,
          minimumCreditAmountForUsage: 0,
        },
      ],
    },
    allowedTiers: [
      {
        id: 'free-tier',
        name: 'Free Tier',
        isDefault: true,
      },
    ],
    cloudaicompanionProject: '',
  };
}

export function mockAntigravityUserQuotaSummary() {
  return {
    userQuotaSummary: {
      quotas: [
        {
          modelId: 'gemini-2.5-pro',
          remainingQuota: 1000,
          resetTime: '2099-01-01T00:00:00Z',
          status: 'ACTIVE',
        },
        {
          modelId: 'gemini-2.5-flash',
          remainingQuota: 1000,
          resetTime: '2099-01-01T00:00:00Z',
          status: 'ACTIVE',
        },
        {
          modelId: 'gemini-3-pro',
          remainingQuota: 1000,
          resetTime: '2099-01-01T00:00:00Z',
          status: 'ACTIVE',
        },
        {
          modelId: 'claude-3-7-sonnet',
          remainingQuota: 1000,
          resetTime: '2099-01-01T00:00:00Z',
          status: 'ACTIVE',
        },
      ],
    },
  };
}

/**
 * 合规的用户信息（消除 IDE 状态栏/面板的未登录与用户凭据警告）
 */
export function mockAntigravityUserInfo() {
  return {
    name: 'AnyBridge User',
    email: 'user@anybridge.local',
    profilePictureUrl: '',
    userTier: {
      id: 'standard-tier',
      name: 'Standard Tier',
      isDefault: true,
    },
    userSettings: {
      telemetryEnabled: false,
      userDataCollectionForceDisabled: true,
    },
  };
}

/**
 * 合规的管理控制权限（允许开启全部模型与 Agent 特性）
 */
export function mockAntigravityAdminControls() {
  return {
    adminControls: {
      allFeaturesEnabled: true,
      allowedModels: [],
    },
  };
}

/**
 * 标准全局用户配置
 */
export function mockAntigravityUserSettings() {
  return {
    userSettings: {
      telemetryEnabled: false,
      userDataCollectionForceDisabled: true,
    },
  };
}

/**
 * 判定是否为遥测、埋点、指标或环境探测请求。
 * 这些请求无需转发至外网，代理应在 0ms 内直接返回 200 {}，杜绝排队卡死。
 */
export function isAntigravityBypassMetricsPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  return p.includes('recordcodeassistmetrics')
    || p.includes('recordtrajectoryanalytics')
    || p.includes('recordclientevent')
    || p.includes('recordsmartchoicesfeedback')
    || p.includes('uploadperformanceprofile')
    || p.includes('listexperiments')
    || p.includes('checkurlantivirus')
    || p.includes('checkurldenylist');
}
