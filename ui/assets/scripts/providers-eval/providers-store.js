// providers-eval/providers-store.js — 供应商存储、内置网关条目、排序过滤与预设列表
import { escAttr, escapeHtml } from '../ui/dom.js';
import {
  LOCAL_PROXY_PROVIDER_ID,
  CPA_LOCAL_PROVIDER_ID,
  createEmptyProviderStore,
  normalizeProviderStoreShape,
  markProviderStoreSnapshot,
  isLocalProxyProvider,
} from '../state/provider-store.js';

// ═══════ PROVIDER PROFILES (多套供应商 + 启用开关) ═══════
globalThis.PROVIDER_VIEW_STORAGE_KEY = 'anybridge.providerViewMode';
globalThis.PROVIDER_SORT_STORAGE_KEY = 'anybridge.providerSortMode';
globalThis.PROVIDER_SORT_MODES = new Set(['default', 'name-asc', 'name-desc', 'latency-asc']);
globalThis.PROVIDER_SORT_LABELS = {
  default: '默认排序',
  'name-asc': '名称正序',
  'name-desc': '名称反序',
  'latency-asc': '延迟优先',
};
globalThis.providerViewMode = (() => {
  try {
    return localStorage.getItem(PROVIDER_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch (_) {
    return 'grid';
  }
})();
globalThis.providerSortMode = (() => {
  try {
    return normalizeProviderSortMode(localStorage.getItem(PROVIDER_SORT_STORAGE_KEY));
  } catch (_) {
    return 'default';
  }
})();
globalThis.providerSearchKeyword = '';
globalThis.providerSelectedIds = new Set();
globalThis.providerBulkRunning = false;
globalThis.providerImportCandidates = [];
globalThis.providerImportSelectedIds = new Set();
globalThis.providerImportOpening = false;
globalThis.providerImportHasScanned = false;
globalThis.providerImportLastScannedSourceLabels = [];
globalThis.providerImportScanSeq = 0;
globalThis.providerImportScanRunning = false;
globalThis.providerImportActiveScanId = '';
globalThis.providerImportScanUnlisten = null;
globalThis.providerImportFilter = 'all';
globalThis.providerImportSourceStates = {};
globalThis.providerImportStep = 'select';
globalThis.PROVIDER_IMPORT_SOURCE_OPTIONS = [
  { key: 'cc-switch', label: 'CC Switch' },
  { key: 'cockpit-tools', label: 'Cockpit Tools' },
  { key: 'cherry-studio', label: 'Cherry Studio' },
];

function getModelFamilyRank(modelId, preferredFamily = '') {
  const raw = String(modelId || '').trim();
  const s = raw.replace(/\s*\(.*?\)\s*$/, '').toLowerCase();

  if (preferredFamily) {
    const pref = preferredFamily.toLowerCase();
    if (pref === 'claude' && /claude|opus|sonnet|haiku|fable/.test(s)) return 5;
    if ((pref === 'codex' || pref === 'gpt') && (/gpt|chatgpt|^o[134]|\bcodex\b/.test(s))) return 5;
    if (pref === 'grok' && /grok/.test(s)) return 5;
    if (pref === 'gemini' && /gemini|gemma/.test(s)) return 5;
  }

  if (/image|video|imagine|sora|dall-e|tts|speech|audio|embed|moderation/.test(s)) return 70;
  if (/claude|opus|sonnet|haiku|fable/.test(s)) return 10;
  if (/gpt|chatgpt|^o[134]|\bcodex\b/.test(s)) return 20;
  if (/gemini|gemma/.test(s)) return 30;
  if (/deepseek/.test(s)) return 40;
  if (/grok/.test(s)) return 50;
  if (/qwen|qwq|qvq|glm|chatglm|kimi|moonshot|mistral|llama|minimax|doubao|hunyuan|baichuan|yi|internlm/.test(s)) return 60;
  return 65;
}

function compareModelNames(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (sa === sb) return 0;

  const pureA = sa.replace(/\s*\(.*?\)\s*$/, '');
  const pureB = sb.replace(/\s*\(.*?\)\s*$/, '');

  const numRegex = /(\d+(?:\.\d+)*)/;
  const ma = pureA.match(numRegex);
  const mb = pureB.match(numRegex);
  if (ma && mb) {
    const preA = pureA.slice(0, ma.index).toLowerCase();
    const preB = pureB.slice(0, mb.index).toLowerCase();
    if (preA === preB) {
      const vaParts = ma[1].split('.').map(n => parseFloat(n) || 0);
      const vbParts = mb[1].split('.').map(n => parseFloat(n) || 0);
      const maxLen = Math.max(vaParts.length, vbParts.length);
      for (let i = 0; i < maxLen; i++) {
        const na = vaParts[i] ?? 0;
        const nb = vbParts[i] ?? 0;
        if (na !== nb) return nb - na;
      }
    }
  }

  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

function sortRoleSelectItems(items, preferredFamily = '') {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const aSaved = (a?.provider === '已保存' || a?.label === '已保存') ? 1 : 0;
    const bSaved = (b?.provider === '已保存' || b?.label === '已保存') ? 1 : 0;
    if (aSaved !== bSaved) return bSaved - aSaved;

    const idA = typeof a === 'string' ? a : (a?.id || a?.model || a?.name || String(a || ''));
    const idB = typeof b === 'string' ? b : (b?.id || b?.model || b?.name || String(b || ''));

    const rankA = getModelFamilyRank(idA, preferredFamily);
    const rankB = getModelFamilyRank(idB, preferredFamily);
    if (rankA !== rankB) return rankA - rankB;

    return compareModelNames(idA, idB);
  });
}

function sortModelsNaturally(list, preferredFamily = '') {
  return sortRoleSelectItems(list, preferredFamily);
}

function providerSelectedModels(p) {
  if (!p) return [];
  if (Array.isArray(p.models) && p.models.length > 0) {
    const list = p.models.map(m => String(m || '').trim()).filter(Boolean);
    return sortModelsNaturally(list);
  }
  const fallback = String(p.defaultModel || '').trim();
  return fallback ? [fallback] : [];
}

function providerCapabilities(p, modelId = null) {
  const caps = p && p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {};
  const modelCapsMap = p && p.modelCaps && typeof p.modelCaps === 'object' ? p.modelCaps : {};
  const modelCaps = modelId ? (modelCapsMap[modelId] || {}) : null;
  const hasModelVision = !!(modelCaps && Object.prototype.hasOwnProperty.call(modelCaps, 'vision'));
  const hasModelTools = !!(modelCaps && Object.prototype.hasOwnProperty.call(modelCaps, 'tools'));
  return {
    text: caps.text !== false,
    stream: caps.stream !== false,
    vision: hasModelVision ? modelCaps.vision === true : caps.vision !== false,
    tools: hasModelTools ? modelCaps.tools === true : caps.tools !== false,
    gzip: caps.gzip === true,
    toolSchemaCompatGemini: caps.toolSchemaCompat === 'gemini',
  };
}

function capabilityBadges(p, compact = false, modelId = null) {
  const c = providerCapabilities(p, modelId);
  const showModelCaps = !!modelId;
  const _t = (k) => (typeof window.t === 'function' ? window.t(k) : k);
  const mk = (label, on, title) => `
    <span class="tag tag-cap-badge ${on ? 'is-active' : 'is-off'}" title="${escAttr(title || label)}" style="background:${on ? 'var(--success-dim)' : 'var(--bg-input)'}; color:${on ? 'var(--success)' : 'var(--text-muted)'}; border:1px solid ${on ? 'rgba(22,163,74,.22)' : 'var(--border)'}; font-size:12px; padding:${compact ? '2px 7px' : '3px 9px'}; border-radius:7px;">${escAttr(label)}</span>`;
  return [
    mk(_t('流式'), c.stream),
    showModelCaps ? mk(_t('视觉'), c.vision, c.vision ? _t('该模型已标记支持图片理解') : _t('该模型未标记图片理解')) : '',
    showModelCaps ? mk(_t('工具'), c.tools, c.tools ? _t('该模型已标记支持工具调用') : _t('该模型未标记工具调用')) : '',
    c.gzip ? mk('Gzip', true, _t('已启用请求体 gzip 压缩')) : '',
    c.toolSchemaCompatGemini ? mk(_t('Schema兼容'), true, _t('已启用 Gemini 工具 Schema 兼容模式（自动学习）')) : '',
  ].filter(Boolean).join('');
}

// Windsurf 是否真的上传图片，取决于"原生模型槽位"本身；仅把映射目标标成 Vision 不够。
globalThis.IMAGE_UNSAFE_NATIVE_SLOT_IDS = new Set([
  'MODEL_XAI_GROK_3',
  'MODEL_XAI_GROK_3_MINI_REASONING',
]);

function catalogEntryOf(uid) {
  return (injectedCatalog || []).find(x => x.modelUid === uid) || null;
}

function nativeVisionSlotInfo(uid) {
  if (!uid) {
    return { ok: null, state: 'unknown', label: '未选择', title: '请先选择一个 Windsurf 模型槽位' };
  }
  if (IMAGE_UNSAFE_NATIVE_SLOT_IDS.has(uid)) {
    return {
      ok: false,
      state: 'risk',
      label: '慎用图片',
      title: '已实测该原生槽位不会稳定上传图片；请换用 GPT-4o、Claude Haiku 等原生视觉槽',
    };
  }
  const m = catalogEntryOf(uid);
  if (m && m.supportsImages === true) {
    return { ok: true, state: 'ok', label: '原生视觉', title: '该 Windsurf 槽位原生支持图片上传' };
  }
  if (m && m.supportsImages === false) {
    return { ok: false, state: 'risk', label: '非视觉槽', title: '该 Windsurf 槽位未标记原生图片能力' };
  }
  return { ok: null, state: 'unknown', label: '图片未知', title: '未在内置目录确认该槽位是否会上传图片' };
}

function targetSupportsVision(t) {
  const p = (providerStore.providers || []).find(x => x.id === (t && t.providerId));
  if (!p || p.enabled === false) return false;
  return providerCapabilities(p, t.model || p.defaultModel || null).vision === true;
}

function targetsSupportVision(targets) {
  return Array.isArray(targets) && targets.some(t => targetSupportsVision(t));
}

function visionStatusStyle(state) {
  if (state === 'ok') return { bg: 'var(--success-dim)', color: 'var(--success)', border: 'rgba(22,163,74,.22)' };
  if (state === 'risk') return { bg: 'rgba(217,119,6,.12)', color: 'var(--warn,#d97706)', border: 'rgba(217,119,6,.28)' };
  if (state === 'off') return { bg: 'var(--bg-input)', color: 'var(--text-muted)', border: 'var(--border)' };
  if (state === 'target-off') return { bg: 'var(--bg-input)', color: 'var(--text-muted)', border: 'var(--border)' };
  return { bg: 'rgba(37,99,235,.10)', color: 'var(--accent)', border: 'rgba(37,99,235,.22)' };
}

function slotVisionAssessment(uid, targets, supportsImages = true) {
  const _t = (k) => (typeof window.t === 'function' ? window.t(k) : k);
  if (supportsImages) {
    return { state: 'ok', label: _t('支持图片理解'), title: _t('该槽位已启用图片理解') };
  }
  return { state: 'off', label: _t('不支持图片理解'), title: _t('该槽位未启用图片理解') };
}

function renderVisionPill(info, compact = false) {
  const s = visionStatusStyle(info.state);
  return `<span class="tag tag-vision-pill tag-vision-${escAttr(info.state || 'default')}" title="${escAttr(info.title || info.label)}" style="display:inline-flex;align-items:center;gap:5px;background:${s.bg};color:${s.color};border:1px solid ${s.border};font-size:12px;padding:${compact ? '2px 7px' : '3px 9px'};border-radius:7px;font-weight:700;white-space:nowrap;">${escAttr(info.label)}</span>`;
}

function isAccountSlotModel(m) {
  return !!(m && m.origin === 'account');
}

function slotModelOf(uid) {
  return (ideModels || []).find(x => x.id === uid) || null;
}

function slotSourceInfo(uidOrModel) {
  const m = typeof uidOrModel === 'string' ? slotModelOf(uidOrModel) : uidOrModel;
  if (isAccountSlotModel(m)) {
    return {
      state: 'account',
      label: '当前账号',
      title: '当前登录账号在 Windsurf 下拉中可见的模型槽位（含网关抓取的完整清单），默认优先使用',
    };
  }
  return {
    state: 'extended',
    label: '内置槽位',
    title: '来自内置/历史扩展目录，不在当前账号下拉里；切换到网关后仍可用于 BYOK 映射',
  };
}

function renderSourcePill(info, compact = false) {
  const account = info.state === 'account';
  const bg = account ? 'rgba(37,99,235,.10)' : 'var(--bg-input)';
  const color = account ? 'var(--accent)' : 'var(--text-muted)';
  const border = account ? 'rgba(37,99,235,.22)' : 'var(--border)';
  return `<span class="tag" title="${escAttr(info.title)}" style="display:inline-flex;align-items:center;background:${bg};color:${color};border:1px solid ${border};font-size:12px;padding:${compact ? '2px 7px' : '3px 9px'};border-radius:7px;font-weight:700;white-space:nowrap;">${escAttr(info.label)}</span>`;
}

function visionSafeAlternatives(currentUid, limit = 3) {
  const used = new Set((modelMapStore.slots || []).map(x => x.modelUid).filter(x => x && x !== currentUid));
  return (ideModels || [])
    .filter(m => !used.has(m.id) && nativeVisionSlotInfo(m.id).ok === true)
    .slice(0, limit);
}

function updateSlotVisionHint() {
  const box = document.getElementById('slot-vision-hint');
  if (!box) return;
  const uid = selectedSlotUid || document.getElementById('slot-uid-select')?.value || '';
  const supportsImages = document.getElementById('slot-supports-images')?.checked !== false;
  const native = nativeVisionSlotInfo(uid);
  const targetVision = targetsSupportVision(selectedMappingTargets);
  const assessment = slotVisionAssessment(uid, selectedMappingTargets, supportsImages);
  const alts = visionSafeAlternatives(uid, 2).map(m => m.name).join(' / ');
  const s = visionStatusStyle(assessment.state === 'unset' ? native.state : assessment.state);
  let detail = assessment.title || native.title;
  if (assessment.state === 'risk' && alts) detail += `。推荐改用：${alts}`;
  if (!targetVision && selectedMappingTargets.length > 0) detail = '目标模型未标记 Vision；如果上游实际支持，请先测试供应商模型能力';
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        ${renderVisionPill(native, true)}
        ${renderVisionPill(assessment, true)}
      </div>
      ${targetVision ? '<span style="font-size:12px;color:var(--success);font-weight:700;">目标支持视觉</span>' : '<span style="font-size:12px;color:var(--text-muted);font-weight:700;">目标未标记视觉</span>'}
    </div>
    <div style="margin-top:6px;color:${s.color};font-size:12px;line-height:1.45;">${escAttr(detail)}</div>
  `;
  box.style.background = s.bg;
  box.style.borderColor = s.border;
}

/** 插件部署时自动登记的本地供应商（id 形如 plugin-<插件id>），与 CPA 同级内置待遇 */
function isPluginLocalProvider(p) {
  if (!p) return false;
  const id = p.id || p.providerId || p.provider_id;
  return typeof id === 'string' && id.startsWith('plugin-');
}

function isBuiltinProvider(p) {
  return isLocalProxyProvider(p) || isCpaLocalProvider(p) || isPluginLocalProvider(p);
}

/** 构建 AnyBridge 内置供应商的模型列表条目（供各「添加模型」页面使用） */
function localProxyProviderModelsEntry() {
  const port = (typeof getLocalProxyPort === 'function') ? getLocalProxyPort() : 7450;
  const apiKey = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : '';
  const rawModels = (typeof getLocalProxyModels === 'function') ? getLocalProxyModels('openai') : [];
  const models = sortRoleSelectItems(rawModels);
  return {
    providerId: LOCAL_PROXY_PROVIDER_ID,
    providerName: 'AnyBridge',
    models: models.map(m => ({
      id: m,
      name: m,
      supports_tool_call: true,
      supports_images: true,
      supports_reasoning: false,
    })),
    apiHost: `http://127.0.0.1:${port}`,
    apiKey,
    apiPath: '/v1/chat/completions',
    chatUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiFormat: 'openai',
    enabled: true,
    isLocalProxy: true,
  };
}

/** CPA 套件部署后自动添加的内置本地供应商 */
function isCpaLocalProvider(p) {
  if (!p) return false;
  const id = p.id || p.providerId || p.provider_id;
  if (id === CPA_LOCAL_PROVIDER_ID || p.meta?.cpaLocal === true) return true;
  if (typeof id === 'string' && (id === 'cpa-local' || id.startsWith('p-cpa-local'))) return true;
  if (String(p.name || p.providerName || '').trim().toUpperCase() === 'CPA') return true;
  const host = String(p.apiHost || p.api_host || '').replace(/\/+$/, '').toLowerCase();
  if (host === 'http://127.0.0.1:8317' && /cpa/i.test(String(p.name || p.providerName || ''))) return true;
  return false;
}

function isAnyBridgeLocalProxy(p) {
  if (!p) return false;
  if (p.isLocalProxy === true || p.meta?.localProxy === true) return true;
  const id = String(p.providerId || p.id || p.provider_id || '').toLowerCase();
  if (id === LOCAL_PROXY_PROVIDER_ID || id === 'anybridge-local-proxy' || id === 'anybridge' || id === 'local-proxy') return true;
  const name = String(p.providerName || p.name || '').trim().toLowerCase();
  if (name === 'anybridge' || name.startsWith('anybridge')) return true;
  return false;
}

function isCpaLocalProxy(p) {
  return isCpaLocalProvider(p);
}

function isOtherBuiltinProxy(p) {
  if (!p) return false;
  if (isAnyBridgeLocalProxy(p) || isCpaLocalProxy(p)) return false;
  if (isPluginLocalProvider(p)) return true;
  if (p.isBuiltin === true || p.builtin === true || p.meta?.builtin === true || p.meta?.isBuiltin === true) return true;
  if (p.meta?.pluginProxy === true || p.isPluginProxy === true || p.meta?.isProxy === true || p.isProxy === true) return true;
  if (p.meta?.cpaLocal === true || p.meta?.localProxy === true) return true;
  const host = String(p.apiHost || p.api_host || '').toLowerCase();
  if ((host.includes('127.0.0.1') || host.includes('localhost')) && (p.meta?.plugin || p.meta?.extension || p.pluginId)) return true;
  return false;
}

function isBuiltinProxyEntry(p) {
  return isAnyBridgeLocalProxy(p) || isCpaLocalProxy(p) || isOtherBuiltinProxy(p);
}

function builtinProxySortRank(p) {
  if (isAnyBridgeLocalProxy(p)) return 1;
  if (isCpaLocalProxy(p)) return 2;
  if (isOtherBuiltinProxy(p)) return 3;
  return 999;
}

function builtinProviderBadgeHtml(p) {
  if (isLocalProxyProvider(p)) {
    return '<span class="provider-builtin-badge">本地网关</span>';
  }
  if (isCpaLocalProvider(p)) {
    return '<span class="provider-builtin-badge">本地网关</span>';
  }
  if (isPluginLocalProvider(p)) {
    return '<span class="provider-builtin-badge">本地网关</span>';
  }
  return '';
}

function syncLocalProxyProvider() {
  if (!providerStore || !Array.isArray(providerStore.providers)) return;
  const port = (typeof getLocalProxyPort === 'function') ? getLocalProxyPort() : 7450;
  const apiKey = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : '';
  const rawModels = (typeof getLocalProxyModels === 'function') ? getLocalProxyModels('openai') : [];
  const models = sortRoleSelectItems(rawModels);
  const defaultModel = (typeof getLocalProxyDefaultModel === 'function') ? getLocalProxyDefaultModel('openai') : '';
  const provider = {
    id: LOCAL_PROXY_PROVIDER_ID,
    name: 'AnyBridge',
    apiHost: `http://127.0.0.1:${port}`,
    apiKey,
    apiPath: '/v1/chat/completions',
    defaultModel: defaultModel || (models[0] || ''),
    apiFormat: 'openai',
    enabled: true,
    models,
    capabilities: { tools: true, vision: true },
    modelCaps: {},
    unlocks: {},
    meta: { builtin: true, localProxy: true },
  };
  const idx = providerStore.providers.findIndex(p => p.id === LOCAL_PROXY_PROVIDER_ID);
  if (idx >= 0) {
    providerStore.providers.splice(idx, 1);
  }
  providerStore.providers.unshift(provider);
}

/** 规范化 CPA 内置供应商：固定 id、标记 meta，便于徽章与排序 */
function syncCpaLocalProvider() {
  if (!providerStore || !Array.isArray(providerStore.providers)) return;
  const idx = providerStore.providers.findIndex(p =>
    p.id === CPA_LOCAL_PROVIDER_ID
    || (typeof p.id === 'string' && p.id.startsWith('p-cpa-local'))
    || (String(p.apiHost || '').replace(/\/+$/, '').toLowerCase() === 'http://127.0.0.1:8317' && /cpa/i.test(String(p.name || '')))
  );
  if (idx < 0) return;
  const p = providerStore.providers[idx];
  p.id = CPA_LOCAL_PROVIDER_ID;
  if (!p.name || p.name === 'CPA (本地)' || /^CPA \(本地\)/.test(p.name)) p.name = 'CPA';
  p.meta = { ...(p.meta || {}), builtin: true, cpaLocal: true };
  p.enabled = true;
  if (!p.apiPath) p.apiPath = '/v1';
}

async function loadProviders() {
  if (!invoke) return;
  try {
    const loaded = await invoke('load_providers');
    providerStore = normalizeProviderStoreShape(loaded);
    globalThis.providerStoreLoaded = true;
    syncLocalProxyProvider();
    syncCpaLocalProvider();
    (providerStore.providers || []).forEach(normalizeProviderUnlocks);
    markProviderStoreSnapshot(providerStore);
  } catch (e) {
    providerStore = createEmptyProviderStore();
  }
  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
}

function providerListAll() {
  return (providerStore.providers || []).filter(p => p?.meta?.codexConfig !== true);
}

function providerSearchHaystack(p) {
  return [
    p?.name,
    p?.id,
    p?.apiHost,
    p?.apiPath,
    p?.defaultModel,
    ...(Array.isArray(p?.models) ? p.models : []),
    p?.enabled === false ? '未启用 disabled off' : '已启用 enabled on',
  ].map(x => String(x || '').toLowerCase()).join(' ');
}

function normalizeProviderSortMode(mode) {
  return PROVIDER_SORT_MODES.has(mode) ? mode : 'default';
}

function providerSortLabel(mode) {
  return PROVIDER_SORT_LABELS[normalizeProviderSortMode(mode)] || PROVIDER_SORT_LABELS.default;
}

function providerSortText(p) {
  return String(p?.name || p?.id || '').trim();
}

function compareProvidersByName(a, b) {
  const primary = providerSortText(a).localeCompare(providerSortText(b), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
  if (primary !== 0) return primary;
  return String(a?.id || '').localeCompare(String(b?.id || ''), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

/** 延迟实测值；没测过返回 null（不能当 0 参与排序，否则未测的会排最前）。 */
function providerLatencyMs(p) {
  const raw = Number(p?.connStatus?.latencyMs);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function providerSortedList(list = []) {
  if (!Array.isArray(list)) return [];
  let result = list;
  if (providerSortMode === 'latency-asc') {
    result = [...list].sort((a, b) => {
      const la = providerLatencyMs(a);
      const lb = providerLatencyMs(b);
      if (la === null && lb === null) return compareProvidersByName(a, b);
      if (la === null) return 1;
      if (lb === null) return -1;
      return la === lb ? compareProvidersByName(a, b) : la - lb;
    });
  } else if (providerSortMode !== 'default') {
    const sorted = [...list].sort(compareProvidersByName);
    result = providerSortMode === 'name-desc' ? sorted.reverse() : sorted;
  }
  // 内置本地供应商固定置顶：AnyBridge 第一，CPA 第二，不受排序影响
  const pinned = [];
  for (const id of [LOCAL_PROXY_PROVIDER_ID, CPA_LOCAL_PROVIDER_ID]) {
    const i = result.findIndex(p => p.id === id);
    if (i >= 0) pinned.push(...result.splice(i, 1));
  }
  if (pinned.length) result = [...pinned, ...result];
  return result;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.getModelFamilyRank = getModelFamilyRank;
  g.compareModelNames = compareModelNames;
  g.sortRoleSelectItems = sortRoleSelectItems;
  g.sortModelsNaturally = sortModelsNaturally;
  g.providerSelectedModels = providerSelectedModels;
  g.providerCapabilities = providerCapabilities;
  g.capabilityBadges = capabilityBadges;
  g.catalogEntryOf = catalogEntryOf;
  g.nativeVisionSlotInfo = nativeVisionSlotInfo;
  g.targetSupportsVision = targetSupportsVision;
  g.targetsSupportVision = targetsSupportVision;
  g.visionStatusStyle = visionStatusStyle;
  g.slotVisionAssessment = slotVisionAssessment;
  g.renderVisionPill = renderVisionPill;
  g.isAccountSlotModel = isAccountSlotModel;
  g.slotModelOf = slotModelOf;
  g.slotSourceInfo = slotSourceInfo;
  g.renderSourcePill = renderSourcePill;
  g.visionSafeAlternatives = visionSafeAlternatives;
  g.updateSlotVisionHint = updateSlotVisionHint;
  g.isBuiltinProvider = isBuiltinProvider;
  g.localProxyProviderModelsEntry = localProxyProviderModelsEntry;
  g.isCpaLocalProvider = isCpaLocalProvider;
  g.isAnyBridgeLocalProxy = isAnyBridgeLocalProxy;
  g.isCpaLocalProxy = isCpaLocalProxy;
  g.isOtherBuiltinProxy = isOtherBuiltinProxy;
  g.isBuiltinProxyEntry = isBuiltinProxyEntry;
  g.builtinProxySortRank = builtinProxySortRank;
  g.builtinProviderBadgeHtml = builtinProviderBadgeHtml;
  g.syncLocalProxyProvider = syncLocalProxyProvider;
  g.syncCpaLocalProvider = syncCpaLocalProvider;
  g.loadProviders = loadProviders;
  g.providerListAll = providerListAll;
  g.providerSearchHaystack = providerSearchHaystack;
  g.normalizeProviderSortMode = normalizeProviderSortMode;
  g.providerSortLabel = providerSortLabel;
  g.providerSortText = providerSortText;
  g.compareProvidersByName = compareProvidersByName;
  g.providerSortedList = providerSortedList;
})(globalThis);
