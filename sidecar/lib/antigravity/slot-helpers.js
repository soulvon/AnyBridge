export function modelProviderForRuntimeModel(runtimeModelId) {
  if (runtimeModelId.startsWith('MODEL_CLAUDE_')) return 'MODEL_PROVIDER_ANTHROPIC';
  if (runtimeModelId.startsWith('MODEL_OPENAI_')) return 'MODEL_PROVIDER_OPENAI';
  return 'MODEL_PROVIDER_GOOGLE';
}

export function apiProviderForRuntimeModel(runtimeModelId) {
  if (runtimeModelId.startsWith('MODEL_CLAUDE_')) return 'API_PROVIDER_ANTHROPIC_VERTEX';
  if (runtimeModelId.startsWith('MODEL_OPENAI_')) return 'API_PROVIDER_OPENAI_VERTEX';
  return 'API_PROVIDER_GOOGLE_GEMINI';
}

export function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function stableHexHash(value) {
  return fnv1a32(value).toString(16).padStart(8, '0');
}

export function readableCatalogModelId(modelId, cleanModelId) {
  const readable = cleanModelId(modelId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return readable || 'model';
}

export function configuredModelsForAntigravity(config, cleanModelId) {
  return Array.from(new Set([
    config?.defaultModel,
    ...(Array.isArray(config?.models) ? config.models : []),
    ...(Array.isArray(config?.modelCatalog) ? config.modelCatalog.map((entry) => entry?.model) : []),
  ].map(cleanModelId).filter(Boolean)));
}

export function customModelSeed(config, upstreamModel, cleanModelId) {
  const providerId = String(config?.sourceProviderId || config?.providerId || config?.id || config?.sourceProviderName || config?.name || 'anybridge').trim();
  return `${providerId}\u0000${cleanModelId(upstreamModel)}`;
}

export function allocateRuntimeModelId(seed, occupiedIds, supportedRuntimeModels) {
  const slotCount = supportedRuntimeModels.length;
  const preferredIndex = fnv1a32(seed) % slotCount;
  for (let i = 0; i < slotCount; i++) {
    const idx = (preferredIndex + i) % slotCount;
    const candidate = supportedRuntimeModels[idx];
    if (!occupiedIds.has(candidate)) {
      occupiedIds.add(candidate);
      return candidate;
    }
  }
  const fallback = supportedRuntimeModels[preferredIndex];
  console.warn(
    `[antigravity] 警告：${slotCount} 个 BYOK 运行槽位已全部分配，seed=${JSON.stringify(seed)} 将与其它模型共用槽位 ${fallback}，` +
    `请考虑精简 Antigravity 自定义模型数量（≤ ${slotCount}）`,
  );
  return fallback;
}

export function normalizeModelCatalogMimesAndSorts(response, models, injectedIds, providersJson, resolveDefaultCatalogKey) {
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

    if (!response.defaultAgentModelId || !Object.prototype.hasOwnProperty.call(models, response.defaultAgentModelId)) {
      const defaultCatalogKey = resolveDefaultCatalogKey(providersJson, injectedIds);
      if (defaultCatalogKey) {
        response.defaultAgentModelId = defaultCatalogKey;
      }
    }
  }
}
