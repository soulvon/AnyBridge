/**
 * state/provider-store.js — 集中式供应商状态与持久化事务中心
 *
 * 职责：
 * 1. 管理 globalThis.providerStore 与加载就绪标记 providerStoreLoaded；
 * 2. 提供 resolveBoundProviderView：对含 sourceProviderId 的任意平台配置实时解析主供应商连接属性；
 * 3. 收口 persistProviders 与 mutateProviderStore：串行保存队列、虚拟内置供应商过滤、失败 100% 自动回滚与回调通知。
 */

export const LOCAL_PROXY_PROVIDER_ID = 'anybridge-local-proxy';
export const CPA_LOCAL_PROVIDER_ID = 'cpa-local';

const KNOWN_STORE_ARRAYS = [
  'providers',
  'codexConfigs',
  'claudeCodeConfigs',
  'opencodeConfigs',
  'grokConfigs',
  'claudeDesktopConfigs',
  'antigravityConfigs',
  'cursorConfigs',
  'codebuddyConfigs',
  'workbuddyConfigs',
  'zcodeConfigs',
  'piConfigs',
  'hermesConfigs',
  'dshConfigs',
];

let _committedSnapshot = null;
let _txQueue = Promise.resolve();

function _tr(key, fallback, params) {
  if (typeof globalThis.t === 'function') {
    const out = globalThis.t(key, params);
    if (out && out !== key) return out;
  }
  if (!params) return fallback;
  return String(fallback).replace(/\{(\w+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(params, k) ? params[k] : m
  ));
}

export function createEmptyProviderStore() {
  return {
    version: 1,
    providers: [],
    codexConfigs: [],
    claudeCodeConfigs: [],
    opencodeConfigs: [],
    grokConfigs: [],
    claudeDesktopConfigs: [],
  };
}

export function normalizeProviderStoreShape(store) {
  const base = createEmptyProviderStore();
  if (!store || typeof store !== 'object') return base;
  const merged = { ...base, ...store };
  for (const field of KNOWN_STORE_ARRAYS) {
    if (Object.prototype.hasOwnProperty.call(merged, field) && !Array.isArray(merged[field])) {
      merged[field] = [];
    }
  }
  if (!Array.isArray(merged.providers)) merged.providers = [];
  return merged;
}

if (!globalThis.providerStore || typeof globalThis.providerStore !== 'object') {
  globalThis.providerStore = createEmptyProviderStore();
} else {
  globalThis.providerStore = normalizeProviderStoreShape(globalThis.providerStore);
}
if (!('providerStoreLoaded' in globalThis)) {
  globalThis.providerStoreLoaded = false;
}

export function cloneProviderStore(store = globalThis.providerStore) {
  const source = store && typeof store === 'object' ? store : createEmptyProviderStore();
  try {
    return JSON.parse(JSON.stringify(source));
  } catch (_) {
    return createEmptyProviderStore();
  }
}

export function markProviderStoreSnapshot(store = globalThis.providerStore) {
  _committedSnapshot = cloneProviderStore(normalizeProviderStoreShape(store));
  return cloneProviderStore(_committedSnapshot);
}

export function getProviderStoreSnapshot() {
  return _committedSnapshot ? cloneProviderStore(_committedSnapshot) : null;
}

export function restoreProviderStoreSnapshot(snapshot) {
  const target = cloneProviderStore(normalizeProviderStoreShape(snapshot));
  if (globalThis.providerStore && typeof globalThis.providerStore === 'object') {
    const ref = globalThis.providerStore;
    for (const k of Object.keys(ref)) {
      if (!Object.prototype.hasOwnProperty.call(target, k)) {
        delete ref[k];
      }
    }
    Object.assign(ref, target);
    return ref;
  }
  globalThis.providerStore = target;
  return globalThis.providerStore;
}

export function isLocalProxyProviderEntry(p) {
  return !!(
    p
    && (
      p.providerId === LOCAL_PROXY_PROVIDER_ID
      || p.id === LOCAL_PROXY_PROVIDER_ID
      || p.isLocalProxy === true
      || p.meta?.localProxy === true
    )
  );
}

export function isLocalProxyProvider(p) {
  return isLocalProxyProviderEntry(p);
}

/** 仅前端注入、不落盘的虚拟内置供应商（AnyBridge 内置代理网关） */
export function isVirtualBuiltinProvider(p) {
  return !!(p && (isLocalProxyProvider(p) || p.isVirtualBuiltin === true));
}

export const isVirtualProviderEntry = isVirtualBuiltinProvider;

export function buildPersistableProviderStore(store = globalThis.providerStore) {
  const normalized = normalizeProviderStoreShape(store);
  return {
    ...normalized,
    providers: (normalized.providers || []).filter(p => !isVirtualBuiltinProvider(p)),
  };
}

export function isOfficialGoogleGeminiOnlyEndpointForUi(host, apiPath) {
  const h = String(host || '').trim().toLowerCase();
  const p = String(apiPath || '').trim().toLowerCase();
  const joined = `${h} ${p}`;
  if (
    joined.includes('/endpoints/openapi')
    || joined.includes('/openai/')
    || /\/openai(?:$|\?|\s)/.test(joined)
    || joined.includes('/chat/completions')
    || joined.includes('/responses')
    || joined.includes('/compatible-mode')
    || joined.includes('/publishers/anthropic/')
    || joined.includes(':rawpredict')
    || joined.includes(':streamrawpredict')
  ) {
    return false;
  }
  return h.includes('generativelanguage.googleapis.com')
    || /(?:^|\/\/|\.)aiplatform(?:\.[a-z0-9-]+)?(?:\.rep)?\.googleapis\.com(?:\/|:|\?|$)/.test(h)
    || p.includes('/publishers/google/models');
}

export function inferProviderApiFormat(provider, modelId = '', fallback = 'openai') {
  const host = String(provider?.apiHost || '').trim();
  const apiPath = String(provider?.apiPath || '').trim();
  if (isOfficialGoogleGeminiOnlyEndpointForUi(host, apiPath)) {
    return 'gemini';
  }
  const explicit = String(provider?.apiFormat || '').trim().toLowerCase();
  if (explicit === 'openai' || explicit === 'anthropic' || explicit === 'gemini') {
    return explicit;
  }
  if (typeof globalThis.inferExplicitFormatFromEndpoint === 'function') {
    const inferred = globalThis.inferExplicitFormatFromEndpoint(host, apiPath);
    if (inferred) return inferred;
  }
  const endpoint = `${host} ${apiPath}`.toLowerCase();
  if (endpoint.includes('/publishers/anthropic/') || endpoint.includes(':rawpredict') || endpoint.includes('/v1/messages')) {
    return 'anthropic';
  }
  if (endpoint.includes('/endpoints/openapi') || endpoint.includes('/chat/completions') || endpoint.includes('/responses')) {
    return 'openai';
  }
  if (
    endpoint.includes('generativelanguage.googleapis.com')
    || endpoint.includes('/publishers/google/models')
    || endpoint.includes(':generatecontent')
    || endpoint.includes(':streamgeneratecontent')
    || endpoint.includes('/v1beta')
    || /(?:^|\/\/|\s)(?:[a-z0-9-]+-)?aiplatform(?:\.[a-z0-9-]+)?(?:\.rep)?\.googleapis\.com(?:\/|:|\?|$)/.test(endpoint)
  ) {
    return 'gemini';
  }
  const m = String(modelId || provider?.defaultModel || '').toLowerCase();
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('claude')) return 'anthropic';
  return ['openai', 'anthropic', 'gemini'].includes(fallback) ? fallback : 'openai';
}

function _fallbackEndpointFromSettings(cfg) {
  const sc = cfg?.settingsConfig;
  if (!sc || typeof sc !== 'object') return { host: '', key: '' };
  const env = sc.env && typeof sc.env === 'object' ? sc.env : {};
  const opts = sc.options && typeof sc.options === 'object' ? sc.options : {};
  const host = String(
    env.ANTHROPIC_BASE_URL
    || opts.baseURL
    || opts.baseUrl
    || sc.baseURL
    || sc.baseUrl
    || ''
  ).trim();
  const key = String(
    env.ANTHROPIC_AUTH_TOKEN
    || env.ANTHROPIC_API_KEY
    || opts.apiKey
    || opts.api_key
    || sc.apiKey
    || ''
  ).trim();
  return { host, key };
}

/**
 * 统一解析绑定了 sourceProviderId 的平台配置视图。
 * 只要存在 sourceProviderId 且主供应商在 store.providers 中可找到，
 * 连接字段（apiHost/apiPath/apiKey/apiFormat/enabled）一律实时以主供应商为准。
 */
export function resolveBoundProviderView(cfg, store = globalThis.providerStore) {
  const item = cfg && typeof cfg === 'object' ? cfg : {};
  const providers = Array.isArray(store?.providers) ? store.providers : [];
  const sourceId = String(item.sourceProviderId || '').trim();
  const source = sourceId
    ? providers.find(p => p && (p.id === sourceId || p.providerId === sourceId)) || null
    : null;

  const settingsFallback = !sourceId ? _fallbackEndpointFromSettings(item) : { host: '', key: '' };
  const host = source
    ? String(source.apiHost || '')
    : String(item.apiHost || settingsFallback.host || '');
  const apiPath = source
    ? String(source.apiPath || '')
    : String(item.apiPath || '');
  const apiKey = source
    ? String(source.apiKey || '')
    : String(item.apiKey || settingsFallback.key || '');
  const apiKeys = source
    ? (Array.isArray(source.apiKeys) ? [...source.apiKeys] : (apiKey ? [apiKey] : []))
    : (Array.isArray(item.apiKeys) ? [...item.apiKeys] : (apiKey ? [apiKey] : []));

  const rawOverride = String(item.apiFormatOverride || '').trim().toLowerCase();
  const overrideFormat = ['openai', 'anthropic', 'gemini'].includes(rawOverride) ? rawOverride : '';
  const effectiveForInfer = source
    ? {
        ...source,
        apiFormat: overrideFormat || source.apiFormat || '',
      }
    : {
        ...item,
        apiHost: host,
        apiPath,
        apiFormat: overrideFormat || item.apiFormat || '',
      };
  const fallbackFormat = source
    ? (String(item.apiFormat || '').trim().toLowerCase() || 'openai')
    : 'openai';
  const apiFormat = inferProviderApiFormat(
    effectiveForInfer,
    item.defaultModel || item.model || '',
    fallbackFormat
  );

  const sourceEnabled = source ? source.enabled !== false : true;
  const configEnabled = item.enabled !== false;
  const enabled = source ? (configEnabled && sourceEnabled) : configEnabled;

  return {
    source,
    hasSource: Boolean(source),
    sourceMissing: Boolean(sourceId && !source),
    sourceProviderId: sourceId,
    sourceProviderName: String((source && (source.name || source.providerName)) || item.sourceProviderName || item.name || '').trim(),
    apiHost: host,
    apiPath,
    apiKey,
    apiKeys,
    apiFormat,
    apiFormatOverride: overrideFormat,
    wireApi: String((source && source.wireApi) || item.wireApi || '').trim(),
    enabled,
    sourceEnabled,
    configEnabled,
  };
}

function _enqueueStoreTx(task) {
  const next = _txQueue.then(task, task);
  _txQueue = next.catch(() => {});
  return next;
}

function _reportPersistFailure(err, options = {}) {
  const errText = String(err?.message || err || 'unknown error');
  if (typeof globalThis.addLog === 'function') {
    globalThis.addLog('err', `${_tr('store.saveFailedPrefix', 'Failed to save provider config: ')}${errText}`);
  }
  if (options.silent || options.silentError) return;
  const notice = `${_tr('store.saveRollbackPrefix', 'Save failed; local changes have been rolled back: ')}${errText}`;
  if (options.alertOnError && typeof globalThis.showCustomAlert === 'function') {
    globalThis.showCustomAlert(notice, _tr('store.saveFailedTitle', 'Save Failed'), 'error');
  } else if (typeof globalThis.showBottomToast === 'function') {
    globalThis.showBottomToast(notice, 'error');
  } else if (typeof globalThis.showCustomAlert === 'function') {
    globalThis.showCustomAlert(notice, _tr('store.saveFailedTitle', 'Save Failed'), 'error');
  }
}

async function _commitCurrentStoreLocked(rollbackSnapshot, options = {}) {
  if (!globalThis.providerStoreLoaded) {
    console.warn('[persistProviders] providerStore is not loaded yet; aborting save to protect disk config');
    return false;
  }
  const invokeFn = globalThis.invoke;
  if (typeof invokeFn !== 'function') {
    if (rollbackSnapshot) {
      restoreProviderStoreSnapshot(rollbackSnapshot);
      _committedSnapshot = cloneProviderStore(rollbackSnapshot);
    }
    const err = new Error('invoke bridge unavailable');
    _reportPersistFailure(err, options);
    if (typeof options.onRollback === 'function') {
      await options.onRollback(err);
    }
    return false;
  }

  try {
    const storeToSave = buildPersistableProviderStore(globalThis.providerStore);
    await invokeFn('save_providers', { store: storeToSave });
    _committedSnapshot = cloneProviderStore(normalizeProviderStoreShape(globalThis.providerStore));
    if (typeof options.onSuccess === 'function') {
      await options.onSuccess(globalThis.providerStore);
    }
    return true;
  } catch (err) {
    console.error('persistProviders failed, rolling back store:', err);
    if (rollbackSnapshot) {
      restoreProviderStoreSnapshot(rollbackSnapshot);
      _committedSnapshot = cloneProviderStore(rollbackSnapshot);
    }
    _reportPersistFailure(err, options);
    if (typeof options.onRollback === 'function') {
      await options.onRollback(err);
    }
    return false;
  }
}

/**
 * 持久化当前 globalThis.providerStore 到磁盘（串行排队 + 过滤虚拟内置供应商 + 失败自动回滚）。
 * @returns {Promise<boolean>}
 */
export async function persistProviders(options = {}) {
  const opts = typeof options === 'boolean' ? { silent: options } : (options || {});
  return _enqueueStoreTx(async () => {
    const fallbackSnapshot = opts.rollbackSnapshot || _committedSnapshot;
    return _commitCurrentStoreLocked(fallbackSnapshot, opts);
  });
}

/**
 * 事务式修改 providerStore：在串行队列中先拍深拷贝快照，执行 mutator，再持久落盘。
 * 任何异常、mutator 返回 false、或 save_providers 失败均 100% 回滚内存状态并返回 false。
 * @param {(store: object) => any} mutatorFn
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function mutateProviderStore(mutatorFn, options = {}) {
  if (typeof mutatorFn !== 'function') {
    throw new TypeError('mutateProviderStore requires a mutator function');
  }
  const opts = options || {};
  return _enqueueStoreTx(async () => {
    if (!globalThis.providerStoreLoaded) {
      console.warn('[mutateProviderStore] providerStore is not loaded yet; aborting mutation');
      return false;
    }
    globalThis.providerStore = normalizeProviderStoreShape(globalThis.providerStore);
    const beforeSnapshot = cloneProviderStore(globalThis.providerStore);
    try {
      const result = await mutatorFn(globalThis.providerStore);
      if (result === false) {
        restoreProviderStoreSnapshot(beforeSnapshot);
        return false;
      }
    } catch (err) {
      restoreProviderStoreSnapshot(beforeSnapshot);
      _reportPersistFailure(err, opts);
      if (typeof opts.onRollback === 'function') {
        await opts.onRollback(err);
      }
      return false;
    }
    return _commitCurrentStoreLocked(beforeSnapshot, opts);
  });
}

(function mirrorFns(g) {
  g.LOCAL_PROXY_PROVIDER_ID = LOCAL_PROXY_PROVIDER_ID;
  g.CPA_LOCAL_PROVIDER_ID = CPA_LOCAL_PROVIDER_ID;
  g.createEmptyProviderStore = createEmptyProviderStore;
  g.normalizeProviderStoreShape = normalizeProviderStoreShape;
  g.cloneProviderStore = cloneProviderStore;
  g.markProviderStoreSnapshot = markProviderStoreSnapshot;
  g.getProviderStoreSnapshot = getProviderStoreSnapshot;
  g.restoreProviderStoreSnapshot = restoreProviderStoreSnapshot;
  g.isLocalProxyProviderEntry = isLocalProxyProviderEntry;
  g.isLocalProxyProvider = isLocalProxyProvider;
  g.isVirtualBuiltinProvider = isVirtualBuiltinProvider;
  g.isVirtualProviderEntry = isVirtualProviderEntry;
  g.buildPersistableProviderStore = buildPersistableProviderStore;
  g.isOfficialGoogleGeminiOnlyEndpointForUi = isOfficialGoogleGeminiOnlyEndpointForUi;
  g.inferProviderApiFormat = inferProviderApiFormat;
  g.resolveBoundProviderView = resolveBoundProviderView;
  g.persistProviders = persistProviders;
  g.mutateProviderStore = mutateProviderStore;
})(globalThis);
