// proxy-routes/store-and-lookup.js — 代理路由存储归一化、供应商查表与持久化

// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// ═══════ LOCAL PROXY MODEL ROUTES ═══════
globalThis.proxyRoutesStore = { version: 1, defaultModelId: '', routes: [] };
globalThis.proxyRoutesStoreLoaded = false;
globalThis.proxyRoutesLoadError = '';
globalThis.proxyRouteEditingId = '';
globalThis.proxyRouteDraftTargets = [];
globalThis.proxyRouteSelectedIds = new Set();
globalThis.proxyRouteProviderModels = [];
globalThis.proxyRouteProviderSearch = '';
globalThis.proxyRouteSelectedProviderId = '';
globalThis.proxyRouteSelectedModelId = '';
globalThis.proxyRouteBackupProviderSearch = '';
globalThis.proxyRouteBackupSelectedProviderId = '';
globalThis.proxyRouteBackupSelectedModelId = '';
globalThis.proxyRouteBackupPickerOpen = false;
// 弹窗内多选状态：Map<providerId, Set<modelId>>，编辑单模型时退化为空
globalThis.proxyRoutePickedModels = new Map();
globalThis.proxyRouteCustomNameTouched = false;

function proxyRouteEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeProxyRouteFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'auto') return '';
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini') return raw;
  return '';
}

function normalizeProxyRouteUnlock(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === 'codex') return 'codex';
  if (raw === 'claudeCode' || raw === 'claude-code' || raw === 'claude_code') return 'claudeCode';
  return '';
}

function normalizeProxyRouteTarget(target = {}) {
  return {
    providerId: String(target.providerId || target.provider_id || '').trim(),
    model: String(target.model || '').trim(),
    apiFormat: normalizeProxyRouteFormat(target.apiFormat || target.api_format),
    apiPath: String(target.apiPath || target.api_path || '').trim(),
    unlock: normalizeProxyRouteUnlock(target.unlock)
  };
}

function normalizeProxyRoute(route = {}) {
  return {
    uid: String(route.uid || '').trim(),
    id: String(route.id || '').trim(),
    displayName: String(route.id || '').trim(),
    idFromRenameRule: route.idFromRenameRule === true || route.id_from_rename_rule === true,
    enabled: route.enabled !== false,
    exposedFormats: ['openai', 'anthropic', 'gemini'],
    source: String(route.source || 'manual').trim() || 'manual',
    capabilities: {
      stream: route.capabilities?.stream !== false,
      tools: route.capabilities?.tools !== false,
      vision: route.capabilities?.vision !== false,
      reasoning: route.capabilities?.reasoning !== false,
    },
    enhancement: {
      retry: route.enhancement?.retry !== false,
      autoRouting: route.enhancement?.autoRouting !== false,
      thirdPartyVision: route.enhancement?.thirdPartyVision === true,
      preserveExtraParams: route.enhancement?.preserveExtraParams === true,
      rawProviderErrors: route.enhancement?.rawProviderErrors !== false,
    },
    targets: Array.isArray(route.targets) ? route.targets.map(normalizeProxyRouteTarget).filter(t => t.providerId || t.model) : [],
  };
}

function normalizeProxyRoutesStore(store = {}) {
  const routes = Array.isArray(store.routes) ? store.routes.map(normalizeProxyRoute).filter(route => route.id) : [];
  const cd = store.claudeDesktop;
  const claudeDesktop = cd && typeof cd === 'object' ? {
    sonnet: String(cd.sonnet || '').trim(),
    opus: String(cd.opus || '').trim(),
    haiku: String(cd.haiku || '').trim(),
    fable: String(cd.fable || '').trim(),
    sonnetName: String(cd.sonnetName || '').trim(),
    opusName: String(cd.opusName || '').trim(),
    haikuName: String(cd.haikuName || '').trim(),
    fableName: String(cd.fableName || '').trim(),
  } : null;
  return {
    version: Number(store.version) || 1,
    defaultModelId: '',
    routes,
    claudeDesktop,
  };
}

function proxyRouteProvider(providerId) {
  return (providerStore.providers || []).find(provider => provider.id === providerId) || null;
}

function proxyRouteProviderName(providerId) {
  const provider = proxyRouteProvider(providerId);
  return provider ? (provider.name || provider.id) : (providerId || '未选择供应商');
}

function proxyRouteProviderUnlockEnabled(providerId, kind) {
  const provider = proxyRouteProvider(providerId);
  const unlock = provider?.unlocks?.[kind];
  return !!(unlock && unlock.enabled !== false);
}

function proxyRouteApiFormatForUnlock(unlock) {
  if (unlock === 'codex') return 'openai';
  if (unlock === 'claudeCode') return 'anthropic';
  return '';
}

// 模型族判断需与 sidecar/provider-pool.js 的运行时校验保持一致，
// 否则 UI 推导出的解锁类型会在上游被静默丢弃。
function proxyRouteModelFamily(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return '';
  if (/claude|opus|sonnet|haiku|fable/.test(raw)) return 'claude';
  if (/gpt|swe|codex/.test(raw) || /^o[134]/.test(raw)) return 'gpt';
  return '';
}

function proxyRouteUnlockForModelFamily(family) {
  if (family === 'claude') return 'claudeCode';
  if (family === 'gpt') return 'codex';
  return '';
}

// 解锁方式遵循「手动指定优先，智能推断兜底」：
// 1) target.unlock 是显式选择，只要供应商开启了解锁就原样保留（模型名不否决手动配置）；
// 2) 未指定解锁时，按显式接口格式推导；
// 3) 接口格式也未指定时，才按模型名智能推断。
// 智能推断可能猜错（如 gpt 命名但只支持 messages 契约的模型），猜错时用户可手动修正。
function proxyRouteDefaultUnlockForTarget(providerId, apiFormat = '', model = '') {
  const fmt = normalizeProxyRouteFormat(apiFormat);
  if (fmt === 'gemini') return '';
  if (fmt === 'anthropic') return proxyRouteProviderUnlockEnabled(providerId, 'claudeCode') ? 'claudeCode' : '';
  if (fmt === 'openai') return proxyRouteProviderUnlockEnabled(providerId, 'codex') ? 'codex' : '';
  const familyUnlock = proxyRouteUnlockForModelFamily(proxyRouteModelFamily(model));
  if (familyUnlock) {
    return proxyRouteProviderUnlockEnabled(providerId, familyUnlock) ? familyUnlock : '';
  }
  if (proxyRouteProviderUnlockEnabled(providerId, 'codex')) return 'codex';
  if (proxyRouteProviderUnlockEnabled(providerId, 'claudeCode')) return 'claudeCode';
  return '';
}

function proxyRouteTargetWithDefaultUnlock(target = {}) {
  const out = normalizeProxyRouteTarget(target);
  const currentUnlock = normalizeProxyRouteUnlock(out.unlock);
  if (currentUnlock && proxyRouteProviderUnlockEnabled(out.providerId, currentUnlock)) {
    out.unlock = currentUnlock;
    out.apiFormat = proxyRouteApiFormatForUnlock(currentUnlock);
    return out;
  }
  const nextUnlock = proxyRouteDefaultUnlockForTarget(out.providerId, out.apiFormat, out.model);
  out.unlock = nextUnlock;
  if (nextUnlock) out.apiFormat = proxyRouteApiFormatForUnlock(nextUnlock);
  return out;
}

function proxyRouteProviderInitial(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

function proxyRouteProviderEntry(providerId) {
  return (proxyRouteProviderModels || []).find(item => item.providerId === providerId) || null;
}

function proxyRouteProviderModel(providerId, modelId) {
  const provider = proxyRouteProviderEntry(providerId);
  return (provider?.models || []).find(model => String(model?.id || '') === String(modelId || '')) || null;
}

function proxyRouteModelIcon(modelId) {
  if (typeof renderModelIcon === 'function') return renderModelIcon(modelId);
  const initial = String(modelId || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="model-item-icon fallback">${proxyRouteEsc(initial)}</div>`;
}

function proxyRouteProviderSearchHaystack(provider) {
  return [provider?.providerName, provider?.providerId].map(x => String(x || '').toLowerCase()).join(' ');
}

function proxyRouteVisibleProviders() {
  const terms = String(proxyRouteProviderSearch || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(proxyRouteProviderModels) ? proxyRouteProviderModels : [];
  if (!terms.length) return list;
  return list.filter(provider => {
    const haystack = proxyRouteProviderSearchHaystack(provider);
    return terms.every(term => haystack.includes(term));
  });
}

function proxyRouteBackupVisibleProviders() {
  const terms = String(proxyRouteBackupProviderSearch || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(proxyRouteProviderModels) ? proxyRouteProviderModels : [];
  if (!terms.length) return list;
  return list.filter(provider => {
    const haystack = [
      proxyRouteProviderSearchHaystack(provider),
      ...(provider?.models || []).map(model => `${model?.id || ''} ${model?.name || ''}`),
    ].join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

function proxyRouteProviderModelsFromStore() {
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p));
  return providers.map(provider => {
    const models = Array.isArray(provider.models) ? provider.models : [];
    return {
      providerId: provider.id,
      providerName: provider.name || provider.id,
      models: models.map(model => ({
        id: String(model || '').trim(),
        name: String(model || '').trim(),
        supportsToolCall: provider.capabilities?.tools === true,
        supportsImages: provider.capabilities?.vision === true,
        supportsReasoning: /reason|thinking|r1|o\d|glm|claude|gpt-5/i.test(String(model || '')),
      })).filter(model => model.id),
    };
  });
}

async function loadProxyRouteProviderModels() {
  if (invoke) {
    proxyRouteProviderModels = await invoke('list_provider_models') || [];
  } else {
    proxyRouteProviderModels = proxyRouteProviderModelsFromStore();
  }
  // 故意不注入「AnyBridge 本地」供应商:网关 tab 自己加自己会形成死循环
  // (内置模型路由表里的模型本来就在本地,不能再"从本地挑模型加到本地")。
  // 其他场景(CodeBuddy/WorkBuddy/ZCode 平台 tab 的添加模型)各自独立维护注入,
  // 不受本函数影响。
}

function proxyRouteTargetLabel(target) {
  const provider = proxyRouteProviderName(target.providerId);
  const model = target.model || '未填写模型';
  const unlock = normalizeProxyRouteUnlock(target.unlock);
  const fmt = normalizeProxyRouteFormat(target.apiFormat);
  const format = unlock === 'codex'
    ? 'Codex 解锁'
    : (unlock === 'claudeCode'
      ? 'Claude Code 解锁'
      : (fmt === 'anthropic' ? 'Claude' : (fmt === 'openai' ? 'OpenAI' : '自动')));
  return `${provider} / ${model} · ${format}`;
}

function proxyRouteAliasesForRoute(route) {
  const aliases = new Set();
  const id = String(route?.id || '').trim();
  const renderedId = String(proxyRouteRenderedId(route || {}) || '').trim();
  if (id) aliases.add(id);
  if (renderedId) aliases.add(renderedId);
  return Array.from(aliases);
}

function proxyRouteAliasExists(id) {
  const target = String(id || '').trim();
  if (!target) return false;
  return (proxyRoutesStore.routes || []).some(route => proxyRouteAliasesForRoute(route).includes(target));
}

function proxyRouteTargetAlreadyExists(providerId, modelId) {
  const provider = String(providerId || '').trim();
  const model = String(modelId || '').trim();
  if (!provider || !model) return false;
  return (proxyRoutesStore.routes || []).some(route =>
    (route.targets || []).map(normalizeProxyRouteTarget).some(target =>
      target.providerId === provider && target.model === model
    )
  );
}

function getEnabledProxyRouteModels(format = 'openai') {
  const routes = Array.isArray(proxyRoutesStore.routes) ? proxyRoutesStore.routes : [];
  return routes
    .filter(route => route.enabled !== false)
    .map(route => proxyRouteRenderedId(route));
}

function getProxyRouteDefaultModel(format = 'openai') {
  const models = getEnabledProxyRouteModels(format);
  return models[0] || '';
}

async function loadProxyRoutesOnce() {
  const store = await invoke('load_proxy_routes');
  proxyRoutesStore = normalizeProxyRoutesStore(store);
  globalThis.proxyRoutesStoreLoaded = true;
  globalThis.proxyRoutesLoadError = '';
  renderProxyRoutes();
  if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
  if (typeof syncLocalProxyProvider === 'function') syncLocalProxyProvider();
  if (typeof renderProviders === 'function') renderProviders();
}

// 配置文件损坏时自动修复，而不是弹错误框烦用户：
// Rust 端会先把原文件隔离备份，再抢救出可用条目重写，这里重新加载一次即可恢复可用。
async function loadProxyRoutes() {
  if (!invoke) return;
  try {
    await loadProxyRoutesOnce();
    return;
  } catch (e) {
    globalThis.proxyRoutesStoreLoaded = false;
    globalThis.proxyRoutesLoadError = String(e || '未知原因');
    addLog('err', '加载内置模型列表失败: ' + e);
  }
  try {
    const report = await invoke('repair_proxy_routes');
    addLog('warn', `内置模型列表配置已自动修复：${report?.message || ''}${report?.backupPath ? `（原文件已备份：${report.backupPath}）` : ''}`);
    await loadProxyRoutesOnce();
    showBottomToast('模型列表配置已自动修复，现在可以正常添加模型', 'warn');
    return;
  } catch (repairErr) {
    globalThis.proxyRoutesStoreLoaded = false;
    addLog('err', '自动修复内置模型列表配置失败: ' + repairErr);
  }
  // 自动修复也没成功（例如配置目录不可写）才显式报错
  renderProxyRoutesLoadError();
  showCustomAlert(`内置模型列表加载失败，且自动修复未成功，为避免覆盖已有配置已暂停保存。失败原因：${globalThis.proxyRoutesLoadError}`, '加载失败', 'error');
}

/** 列表未加载时补一次加载。只能在改动 proxyRoutesStore 之前调用，否则会覆盖掉刚建好的条目。*/
async function ensureProxyRoutesLoaded() {
  if (globalThis.proxyRoutesStoreLoaded) return true;
  await loadProxyRoutes();
  return globalThis.proxyRoutesStoreLoaded === true;
}

/** 加载失败时把失败原因画进列表，避免停在"正在加载模型列表..."骗人。*/
function renderProxyRoutesLoadError() {
  const body = document.getElementById('proxyRoutesTableBody');
  if (!body) return;
  const reason = String(globalThis.proxyRoutesLoadError || '未知原因');
  const tableWrap = document.querySelector('.proxy-routes-table-wrap');
  if (tableWrap) tableWrap.classList.add('is-empty');
  body.innerHTML = `<tr class="proxy-routes-empty-row"><td colspan="7">
    <div class="proxy-routes-empty-state">
      <div class="proxy-routes-empty-title">模型列表加载失败</div>
      <div class="proxy-routes-empty-subtitle">为避免覆盖已有配置，保存已暂停。点「重试加载」后再操作。</div>
      <div style="margin-top:10px;font-size:12px;line-height:1.5;color:var(--text-muted);word-break:break-all;">${proxyRouteEsc(reason)}</div>
      <button type="button" class="btn-primary proxy-routes-empty-action" data-action="loadProxyRoutes">重试加载</button>
    </div>
  </td></tr>`;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.proxyRouteEsc = proxyRouteEsc;
  g.normalizeProxyRouteFormat = normalizeProxyRouteFormat;
  g.normalizeProxyRouteUnlock = normalizeProxyRouteUnlock;
  g.normalizeProxyRouteTarget = normalizeProxyRouteTarget;
  g.normalizeProxyRoute = normalizeProxyRoute;
  g.normalizeProxyRoutesStore = normalizeProxyRoutesStore;
  g.proxyRouteProvider = proxyRouteProvider;
  g.proxyRouteProviderName = proxyRouteProviderName;
  g.proxyRouteProviderUnlockEnabled = proxyRouteProviderUnlockEnabled;
  g.proxyRouteApiFormatForUnlock = proxyRouteApiFormatForUnlock;
  g.proxyRouteModelFamily = proxyRouteModelFamily;
  g.proxyRouteUnlockForModelFamily = proxyRouteUnlockForModelFamily;
  g.proxyRouteDefaultUnlockForTarget = proxyRouteDefaultUnlockForTarget;
  g.proxyRouteTargetWithDefaultUnlock = proxyRouteTargetWithDefaultUnlock;
  g.proxyRouteProviderInitial = proxyRouteProviderInitial;
  g.proxyRouteProviderEntry = proxyRouteProviderEntry;
  g.proxyRouteProviderModel = proxyRouteProviderModel;
  g.proxyRouteModelIcon = proxyRouteModelIcon;
  g.proxyRouteProviderSearchHaystack = proxyRouteProviderSearchHaystack;
  g.proxyRouteVisibleProviders = proxyRouteVisibleProviders;
  g.proxyRouteBackupVisibleProviders = proxyRouteBackupVisibleProviders;
  g.proxyRouteProviderModelsFromStore = proxyRouteProviderModelsFromStore;
  g.loadProxyRouteProviderModels = loadProxyRouteProviderModels;
  g.proxyRouteTargetLabel = proxyRouteTargetLabel;
  g.proxyRouteAliasesForRoute = proxyRouteAliasesForRoute;
  g.proxyRouteAliasExists = proxyRouteAliasExists;
  g.proxyRouteTargetAlreadyExists = proxyRouteTargetAlreadyExists;
  g.getEnabledProxyRouteModels = getEnabledProxyRouteModels;
  g.getProxyRouteDefaultModel = getProxyRouteDefaultModel;
  g.loadProxyRoutes = loadProxyRoutes;
})(globalThis);
