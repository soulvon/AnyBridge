// sidecar/lib/antigravity/catalog-models.js — Antigravity 运行时模型目录生成、内部依赖槽位分配与自定义模型解析

import {
  allocateRuntimeModelId as allocateRuntimeModelIdImpl,
  apiProviderForRuntimeModel,
  configuredModelsForAntigravity as configuredModelsForAntigravityImpl,
  customModelSeed as customModelSeedImpl,
  modelProviderForRuntimeModel,
  normalizeModelCatalogMimesAndSorts,
  readableCatalogModelId as readableCatalogModelIdImpl,
  stableHexHash,
} from './slot-helpers.js';

export function cleanAntigravityModelId(model) {
  if (!model) return '';
  return String(model).replace(/^models\//, '').trim();
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

const COMMON_IMAGE_MIMES = {
  'image/png': true,
  'image/jpeg': true,
  'image/jpg': true,
  'image/webp': true,
  'image/gif': true,
};

// 记录 IDE 最近一次实际使用的 BYOK 模型；内部依赖模型（checkpoint / fast model）
// 会跟随它，避免默认 provider 冷却时内部请求持续失败并把错误提示插入对话。
let lastActiveIdentity = null;

function buildAntigravityCustomModelIdentities(providersJson = {}, supportedRuntimeModels = []) {
  const occupiedRuntimeIds = new Set();
  const identities = [];
  const configs = Array.isArray(providersJson.antigravityConfigs) ? providersJson.antigravityConfigs : [];
  for (const config of configs) {
    if (!config || config.enabled === false || config.injectModels === false) continue;
    for (const upstreamModel of configuredModelsForAntigravityImpl(config, cleanAntigravityModelId)) {
      const seed = customModelSeedImpl(config, upstreamModel, cleanAntigravityModelId);
      const runtimeModelId = allocateRuntimeModelIdImpl(seed, occupiedRuntimeIds, supportedRuntimeModels);
      const catalogKey = `byok-${readableCatalogModelIdImpl(upstreamModel, cleanAntigravityModelId)}-${stableHexHash(seed)}`;
      identities.push({ config, upstreamModel, runtimeModelId, catalogKey });
    }
  }
  return identities;
}

function activeAntigravityIdentity(providersJson = {}, supportedRuntimeModels = []) {
  const identities = buildAntigravityCustomModelIdentities(providersJson, supportedRuntimeModels);
  const activeId = providersJson.platforms?.['antigravity-ide']?.providerId
    || providersJson.platforms?.antigravity?.providerId;
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
export function resolveAntigravityCustomModelWithSlots(modelId, providersJson = {}, supportedRuntimeModels = []) {
  const requested = cleanAntigravityModelId(modelId);
  if (!requested) return null;
  const normalized = requested.toLowerCase();
  const internal = ANTIGRAVITY_INTERNAL_RUNTIME_MODELS.find(dependency =>
    dependency.runtimeModelId.toLowerCase() === normalized
    || String(dependency.catalogKey || '').toLowerCase() === normalized
  );
  if (internal) {
    const preferred = isIdentityUsable(lastActiveIdentity, providersJson) ? lastActiveIdentity : null;
    const active = preferred || activeAntigravityIdentity(providersJson, supportedRuntimeModels);
    return active ? { ...active, exposedModel: active.upstreamModel, isInternalDependency: true } : null;
  }
  for (const identity of buildAntigravityCustomModelIdentities(providersJson, supportedRuntimeModels)) {
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

/**
 * 官方目录缺失时的兜底响应（严格契合 IDE 前端 Protobuf 字段契约）。
 */
export function defaultOfficialModelsResponse() {
  return {
    models: {},
    agentModelSorts: [],
  };
}

function resolveDefaultAntigravityCatalogKey(providersJson = {}, injectedIds = [], supportedRuntimeModels = []) {
  const activeId = providersJson.platforms?.['antigravity-ide']?.providerId
    || providersJson.platforms?.antigravity?.providerId;
  const identities = buildAntigravityCustomModelIdentities(providersJson, supportedRuntimeModels);
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
export function mergeAntigravityModelsResponseWithSlots(officialResponse = {}, providersJson = {}, supportedRuntimeModels = []) {
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

  const sourceProviderNames = new Map(
    (Array.isArray(providersJson.providers) ? providersJson.providers : [])
      .filter(p => p && p.id && p.name)
      .map(p => [p.id, p.name])
  );

  const fallbackWindow = Number(providersJson?.antigravityContextWindow) || 262144;
  for (const identity of buildAntigravityCustomModelIdentities(providersJson, supportedRuntimeModels)) {
    const { config, upstreamModel, runtimeModelId, catalogKey } = identity;
    const providerName = (config.sourceProviderId && sourceProviderNames.get(config.sourceProviderId))
      || config.sourceProviderName
      || config.name
      || 'AnyBridge';
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
      maxTokens: Number(config.contextWindow) || fallbackWindow,
      maxOutputTokens: 65536,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      supportedMimeTypes: supportsImages ? COMMON_IMAGE_MIMES : {},
      vertexModelId: upstreamModel,
      tagTitle: providerName,
      tagDescription: 'BYOK',
    };
    injectedIds.push(catalogKey);
  }

  normalizeModelCatalogMimesAndSorts(
    response,
    models,
    injectedIds,
    providersJson,
    (pj, ids) => resolveDefaultAntigravityCatalogKey(pj, ids, supportedRuntimeModels),
  );

  return response;
}

export function buildAntigravityModelsListWithSlots(providersJson = {}, supportedRuntimeModels = []) {
  const merged = mergeAntigravityModelsResponseWithSlots({}, providersJson, supportedRuntimeModels);
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
