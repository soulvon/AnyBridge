// ES module (P3/P4) — escAttr 已迁至 ui/dom.js
import { escAttr, escapeHtml } from './ui/dom.js';
// ═══════ PROVIDER PROFILES (多套供应商 + 启用开关) ═══════
globalThis.providerStore = { providers: [], codexConfigs: [], claudeCodeConfigs: [], opencodeConfigs: [] };
globalThis.PROVIDER_VIEW_STORAGE_KEY = 'anybridge.providerViewMode';
globalThis.PROVIDER_SORT_STORAGE_KEY = 'anybridge.providerSortMode';
globalThis.PROVIDER_SORT_MODES = new Set(['default', 'name-asc', 'name-desc']);
globalThis.PROVIDER_SORT_LABELS = {
  default: '默认排序',
  'name-asc': '名称正序',
  'name-desc': '名称反序',
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

function providerSelectedModels(p) {
  if (!p) return [];
  if (Array.isArray(p.models) && p.models.length > 0) {
    return p.models.map(m => String(m || '').trim()).filter(Boolean);
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
  const mk = (label, on, title) => `
    <span class="tag" title="${escAttr(title || label)}" style="background:${on ? 'var(--success-dim)' : 'var(--bg-input)'}; color:${on ? 'var(--success)' : 'var(--text-muted)'}; border:1px solid ${on ? 'rgba(22,163,74,.22)' : 'var(--border)'}; font-size:${compact ? '10px' : '11px'}; padding:${compact ? '2px 6px' : '3px 8px'}; border-radius:7px;">${escAttr(label)}</span>`;
  return [
    mk('流式', c.stream),
    showModelCaps ? mk('视觉', c.vision, c.vision ? '该模型已标记支持图片理解' : '该模型未标记图片理解') : '',
    showModelCaps ? mk('工具', c.tools, c.tools ? '该模型已标记支持工具调用' : '该模型未标记工具调用') : '',
    c.gzip ? mk('Gzip', true, '已启用请求体 gzip 压缩') : '',
    c.toolSchemaCompatGemini ? mk('Schema兼容', true, '已启用 Gemini 工具 Schema 兼容模式（自动学习）') : '',
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
  if (supportsImages) {
    return { state: 'ok', label: '支持图片理解', title: '该槽位已启用图片理解' };
  }
  return { state: 'off', label: '不支持图片理解', title: '该槽位未启用图片理解' };
}

function renderVisionPill(info, compact = false) {
  const s = visionStatusStyle(info.state);
  return `<span class="tag" title="${escAttr(info.title || info.label)}" style="display:inline-flex;align-items:center;gap:5px;background:${s.bg};color:${s.color};border:1px solid ${s.border};font-size:${compact ? '10px' : '11px'};padding:${compact ? '2px 6px' : '3px 8px'};border-radius:7px;font-weight:700;white-space:nowrap;">${escAttr(info.label)}</span>`;
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
      title: '当前登录账号在 Windsurf 下拉中可见的模型槽位（含代理抓取的完整清单），默认优先使用',
    };
  }
  return {
    state: 'extended',
    label: '内置槽位',
    title: '来自内置/历史扩展目录，不在当前账号下拉里；切换到代理后仍可用于 BYOK 映射',
  };
}

function renderSourcePill(info, compact = false) {
  const account = info.state === 'account';
  const bg = account ? 'rgba(37,99,235,.10)' : 'var(--bg-input)';
  const color = account ? 'var(--accent)' : 'var(--text-muted)';
  const border = account ? 'rgba(37,99,235,.22)' : 'var(--border)';
  return `<span class="tag" title="${escAttr(info.title)}" style="display:inline-flex;align-items:center;background:${bg};color:${color};border:1px solid ${border};font-size:${compact ? '10px' : '11px'};padding:${compact ? '2px 6px' : '3px 8px'};border-radius:7px;font-weight:700;white-space:nowrap;">${escAttr(info.label)}</span>`;
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
      ${targetVision ? '<span style="font-size:10px;color:var(--success);font-weight:700;">目标支持视觉</span>' : '<span style="font-size:10px;color:var(--text-muted);font-weight:700;">目标未标记视觉</span>'}
    </div>
    <div style="margin-top:6px;color:${s.color};font-size:11px;line-height:1.45;">${escAttr(detail)}</div>
  `;
  box.style.background = s.bg;
  box.style.borderColor = s.border;
}


function isBuiltinProvider(p) {
  return isLocalProxyProvider(p) || isCpaLocalProvider(p);
}

/** 仅前端注入、不落盘的内置供应商（AnyBridge 本地代理） */
function isVirtualBuiltinProvider(p) {
  return isLocalProxyProvider(p);
}

globalThis.LOCAL_PROXY_PROVIDER_ID = 'anybridge-local-proxy';
globalThis.CPA_LOCAL_PROVIDER_ID = 'cpa-local';

/** 构建 AnyBridge 本地代理供应商的模型列表条目（供各「添加模型」页面使用） */
function localProxyProviderModelsEntry() {
  const port = (typeof getLocalProxyPort === 'function') ? getLocalProxyPort() : 7450;
  const apiKey = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : '';
  const models = (typeof getLocalProxyModels === 'function') ? getLocalProxyModels('openai') : [];
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

/** 判断供应商条目是否为 AnyBridge 本地代理 */
function isLocalProxyProviderEntry(p) {
  return !!(p && (p.providerId === LOCAL_PROXY_PROVIDER_ID || p.id === LOCAL_PROXY_PROVIDER_ID || p.isLocalProxy === true || p.meta?.localProxy === true));
}

function isLocalProxyProvider(p) {
  return isLocalProxyProviderEntry(p);
}

/** CPA 套件部署后自动添加的内置本地供应商 */
function isCpaLocalProvider(p) {
  if (!p) return false;
  if (p.id === CPA_LOCAL_PROVIDER_ID || p.meta?.cpaLocal === true) return true;
  if (typeof p.id === 'string' && p.id.startsWith('p-cpa-local')) return true;
  return false;
}

function builtinProviderBadgeHtml(p) {
  if (isLocalProxyProvider(p)) {
    return '<span class="provider-builtin-badge">本地代理</span>';
  }
  if (isCpaLocalProvider(p)) {
    return '<span class="provider-builtin-badge">本地代理</span>';
  }
  return '';
}

function syncLocalProxyProvider() {
  if (!providerStore || !Array.isArray(providerStore.providers)) return;
  const port = (typeof getLocalProxyPort === 'function') ? getLocalProxyPort() : 7450;
  const apiKey = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : '';
  const models = (typeof getLocalProxyModels === 'function') ? getLocalProxyModels('openai') : [];
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
    providerStore = await invoke('load_providers');
    if (!providerStore || !Array.isArray(providerStore.providers)) {
      providerStore = { providers: [], codexConfigs: [], claudeCodeConfigs: [], opencodeConfigs: [] };
    }
    syncLocalProxyProvider();
    syncCpaLocalProvider();
    if (!Array.isArray(providerStore.codexConfigs)) {
      providerStore.codexConfigs = [];
    }
    if (!Array.isArray(providerStore.claudeCodeConfigs)) {
      providerStore.claudeCodeConfigs = [];
    }
    if (!Array.isArray(providerStore.opencodeConfigs)) {
      providerStore.opencodeConfigs = [];
    }
    (providerStore.providers || []).forEach(normalizeProviderUnlocks);
  } catch (e) {
    providerStore = { providers: [], codexConfigs: [], claudeCodeConfigs: [], opencodeConfigs: [] };
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

function providerSortedList(list = []) {
  if (!Array.isArray(list)) return [];
  let result = list;
  if (providerSortMode !== 'default') {
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

function providerVisibleList(list = providerListAll()) {
  const terms = providerSearchKeyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length ? list.filter(p => {
    const text = providerSearchHaystack(p);
    return terms.every(term => text.includes(term));
  }) : list;
  return providerSortedList(visible);
}

function cleanupProviderSelection(list = providerListAll()) {
  const valid = new Set(list.map(p => p.id));
  providerSelectedIds.forEach(id => {
    if (!valid.has(id)) providerSelectedIds.delete(id);
  });
}

function providerModelBadges(p, limit = Infinity) {
  const modelsList = providerSelectedModels(p);
  const shown = modelsList.slice(0, limit);
  const chips = shown.map((m, idx) => {
    return `
      <span class="tag provider-model-chip">
        ${renderModelIcon(m)}
        <span class="provider-model-chip-text">${escAttr(m)}</span>
        ${idx === 0 ? '<span class="provider-model-default">(默认)</span>' : ''}
      </span>
    `;
  });
  if (Number.isFinite(limit) && modelsList.length > limit) {
    chips.push(`<span class="tag provider-model-more">+${modelsList.length - limit}</span>`);
  }
  return chips.join('');
}

function renderProviderToolbarState(total, visible) {
  const search = document.getElementById('providerSearchInput');
  if (search && search.value !== providerSearchKeyword) search.value = providerSearchKeyword;
  const clear = document.getElementById('providerSearchClear');
  if (clear) clear.style.display = providerSearchKeyword.trim() ? 'inline-flex' : 'none';

  const gridBtn = document.getElementById('providerViewGridBtn');
  const listBtn = document.getElementById('providerViewListBtn');
  if (gridBtn) gridBtn.classList.toggle('active', providerViewMode !== 'list');
  if (listBtn) listBtn.classList.toggle('active', providerViewMode === 'list');

  syncProviderSortControl();

  const visibleIds = visible.map(p => p.id).filter(Boolean);
  const selectedCount = providerSelectedIds.size;
  const selectedVisibleCount = visibleIds.filter(id => providerSelectedIds.has(id)).length;
  const bulkCount = document.getElementById('providerBulkCount');
  if (bulkCount) {
    bulkCount.textContent = selectedCount
      ? `已选择 ${selectedCount}`
      : (providerSearchKeyword.trim() ? `${visible.length}/${total} 个结果` : `共 ${total} 个`);
  }

  const selectVisibleBtn = document.getElementById('providerSelectVisibleBtn');
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = providerBulkRunning || visibleIds.length === 0;
    selectVisibleBtn.textContent = visibleIds.length && selectedVisibleCount === visibleIds.length ? '取消当前' : '选择当前';
  }
  ['providerBulkEnableBtn', 'providerBulkDisableBtn', 'providerBulkDeleteBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = providerBulkRunning || selectedCount === 0;
  });
}

function onProviderSearchInput(value) {
  providerSearchKeyword = String(value || '');
  renderProviders();
}

function clearProviderSearch() {
  providerSearchKeyword = '';
  const input = document.getElementById('providerSearchInput');
  if (input) input.value = '';
  renderProviders();
}

function setProviderViewMode(mode) {
  const previous = providerViewMode;
  providerViewMode = mode === 'list' ? 'list' : 'grid';
  try {
    localStorage.setItem(PROVIDER_VIEW_STORAGE_KEY, providerViewMode);
  } catch (e) {
    providerViewMode = previous;
    addLog('err', '保存供应商视图偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  renderProviders();
}

function setProviderSortMode(mode) {
  const previous = providerSortMode;
  providerSortMode = normalizeProviderSortMode(mode);
  try {
    localStorage.setItem(PROVIDER_SORT_STORAGE_KEY, providerSortMode);
  } catch (e) {
    providerSortMode = previous;
    addLog('err', '保存供应商排序偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  renderProviders();
}

function syncProviderSortControl() {
  const label = document.getElementById('providerSortLabel');
  if (label) label.textContent = providerSortLabel(providerSortMode);
  document.querySelectorAll('#providerSortMenu .provider-sort-option').forEach(btn => {
    const selected = btn.dataset.sortMode === providerSortMode;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function setProviderSortMenuOpen(open) {
  const control = document.getElementById('providerSortControl');
  const trigger = document.getElementById('providerSortTrigger');
  if (!control || !trigger) return;
  control.classList.toggle('open', !!open);
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleProviderSortMenu(event) {
  if (event) event.stopPropagation();
  const control = document.getElementById('providerSortControl');
  syncProviderSortControl();
  setProviderSortMenuOpen(!control?.classList.contains('open'));
}

function closeProviderSortMenu() {
  setProviderSortMenuOpen(false);
}

function chooseProviderSortMode(mode) {
  setProviderSortMode(mode);
  closeProviderSortMenu();
  document.getElementById('providerSortTrigger')?.focus();
}

document.addEventListener('click', event => {
  const control = document.getElementById('providerSortControl');
  if (control && !control.contains(event.target)) closeProviderSortMenu();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProviderSortMenu();
});

function toggleProviderSelection(id, checked, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  if (checked) providerSelectedIds.add(id);
  else providerSelectedIds.delete(id);
  renderProviders();
}

function toggleVisibleProvidersSelection() {
  const visible = providerVisibleList();
  const ids = visible.map(p => p.id).filter(Boolean);
  if (!ids.length) return;
  const allSelected = ids.every(id => providerSelectedIds.has(id));
  ids.forEach(id => {
    if (allSelected) providerSelectedIds.delete(id);
    else providerSelectedIds.add(id);
  });
  renderProviders();
}

async function setSelectedProvidersEnabled(enabled) {
  if (!invoke || providerBulkRunning) return;
  const selected = new Set(providerSelectedIds);
  const targets = (providerStore.providers || []).filter(p => selected.has(p.id) && p?.meta?.codexConfig !== true && !isBuiltinProvider(p));
  if (!targets.length) return;
  providerBulkRunning = true;
  renderProviderToolbarState(providerListAll().length, providerVisibleList());
  let okCount = 0;
  try {
    for (const p of targets) {
      await invoke('set_provider_enabled', { id: p.id, enabled });
      p.enabled = enabled;
      okCount += 1;
    }
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    addLog('ok', `已${enabled ? '启用' : '禁用'} ${okCount} 个供应商`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已${enabled ? '启用' : '禁用'} ${okCount} 个供应商`, 'success');
    }
  } catch (e) {
    addLog('err', '批量切换供应商失败: ' + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    providerBulkRunning = false;
    renderProviders();
  }
}

async function deleteSelectedProviders() {
  if (providerBulkRunning) return;
  const selected = new Set(providerSelectedIds);
  const targets = (providerStore.providers || []).filter(p => selected.has(p.id) && p?.meta?.codexConfig !== true && !isBuiltinProvider(p));
  if (!targets.length) return;
  providerBulkRunning = true;
  renderProviderToolbarState(providerListAll().length, providerVisibleList());
  const previous = cloneProviderStore();
  providerStore.providers = (providerStore.providers || []).filter(p => !selected.has(p.id) || p?.meta?.codexConfig === true || isBuiltinProvider(p));
  targets.forEach(p => providerSelectedIds.delete(p.id));
  const ok = await persistProviders();
  if (!ok) {
    providerStore = cloneProviderStore(previous);
    targets.forEach(p => providerSelectedIds.add(p.id));
    providerBulkRunning = false;
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    return;
  }
  providerBulkRunning = false;
  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
  addLog('info', `已删除 ${targets.length} 个供应商`);
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已删除 ${targets.length} 个供应商`, 'success');
  }
}

function normalizeProviderUnlocks(p) {
  if (!p) return {};
  if (!p.unlocks || typeof p.unlocks !== 'object') p.unlocks = {};
  return p.unlocks;
}

function providerUnlockEnabled(p, kind) {
  const unlocks = normalizeProviderUnlocks(p);
  return !!(unlocks[kind] && unlocks[kind].enabled !== false);
}

function providerUnlockLabels(p) {
  const labels = [];
  if (providerUnlockEnabled(p, 'codex')) labels.push('Codex');
  if (providerUnlockEnabled(p, 'claudeCode')) labels.push('Claude Code');
  return labels;
}

function providerUnlockSummaryHtml(p) {
  const labels = providerUnlockLabels(p);
  if (!labels.length) return '';
  return `<div class="provider-unlock-summary active" title="已解锁限制：${escAttr(labels.join('、'))}">解锁限制：${escAttr(labels.join(' · '))}</div>`;
}

function providerUnlockTagsHtml(p) {
  const labels = providerUnlockLabels(p);
  if (!labels.length) return '';
  return labels.map(label => `<span class="tag provider-unlock-tag active" title="已解锁限制 ${escAttr(label)}">解锁限制 ${escAttr(label)}</span>`).join('');
}

function providerUnlockIconSvg(p) {
  const active = providerUnlockLabels(p).length > 0;
  return active
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.5-2.2"></path></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
}

function providerUnlockCardButtonHtml(p) {
  const isUnlocked = providerUnlockLabels(p).length > 0;
  return `<button class="btn-ghost provider-unlock-action ${isUnlocked ? 'active' : ''}" data-action="openProviderUnlockModal" data-arg="${escAttr(p.id)}" title="供应商解锁限制">${isUnlocked ? '已解锁限制' : '解锁限制'}</button>`;
}

function providerUnlockListButtonHtml(p) {
  return `<button class="provider-list-icon-btn provider-unlock-list-btn ${providerUnlockLabels(p).length ? 'active' : ''}" data-action="openProviderUnlockModal" data-arg="${escAttr(p.id)}" title="解锁限制" aria-label="解锁限制 ${escAttr(p.name || p.id)}">${providerUnlockIconSvg(p)}</button>`;
}


function ensureProviderUnlockModal() {
  let modal = document.getElementById('provider-unlock-modal');
  if (modal) return modal;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="provider-unlock-modal" data-action="closeProviderUnlockModal" data-only-self>
      <div class="modal-container provider-unlock-modal">
        <div class="modal-header provider-unlock-head">
          <div>
            <div class="modal-title" id="provider-unlock-title">供应商解锁限制</div>
            <div class="provider-unlock-sub" id="provider-unlock-sub">解锁限制后，该供应商可通过代理转发接入其他平台。</div>
          </div>
          <button class="modal-close-icon" data-action="closeProviderUnlockModal" aria-label="关闭解锁限制弹窗">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
          </button>
        </div>
        <div class="modal-body provider-unlock-body" id="provider-unlock-body"></div>
        <div class="modal-footer provider-unlock-footer">
          <button class="modal-btn modal-btn-confirm" data-action="closeProviderUnlockModal">完成</button>
        </div>
      </div>
    </div>`);
  return document.getElementById('provider-unlock-modal');
}

globalThis.providerUnlockEditingId = '';

function openProviderUnlockModal(providerId) {
  providerUnlockEditingId = providerId;
  const modal = ensureProviderUnlockModal();
  renderProviderUnlockModal();
  modal.classList.add('active');
}

function closeProviderUnlockModal() {
  document.getElementById('provider-unlock-modal')?.classList.remove('active');
  providerUnlockEditingId = '';
}

function providerUnlockRowHtml(p, kind, label, detail) {
  const enabled = providerUnlockEnabled(p, kind);
  return `
    <label class="provider-unlock-row ${enabled ? 'enabled' : ''}">
      <div class="provider-unlock-row-main">
        <strong>${escAttr(label)}</strong>
        <span>${escAttr(detail)}</span>
      </div>
      <input type="checkbox" ${enabled ? 'checked' : ''} data-action="setProviderUnlockFromModal" data-events="change" data-args="[&quot;${kind}&quot;]" data-pass-checked>
      <span class="provider-unlock-switch" aria-hidden="true"></span>
    </label>`;
}

function renderProviderUnlockModal() {
  const p = (providerStore.providers || []).find(x => x.id === providerUnlockEditingId);
  const body = document.getElementById('provider-unlock-body');
  const title = document.getElementById('provider-unlock-title');
  const sub = document.getElementById('provider-unlock-sub');
  if (!body || !p) return;
  normalizeProviderUnlocks(p);
  if (title) title.textContent = `供应商解锁限制：${p.name || p.id}`;
  if (sub) sub.textContent = '解锁限制后，该供应商可通过代理转发接入其他平台。';
  body.innerHTML = `
    <div class="provider-unlock-list">
      ${providerUnlockRowHtml(p, 'codex', 'Codex', '使用 Responses API 解锁限制模板')}
      ${providerUnlockRowHtml(p, 'claudeCode', 'Claude Code', '使用 Anthropic Messages 解锁限制模板')}
    </div>`;
}

async function setProviderUnlockFromModal(kind, enabled) {
  if (!invoke || !providerUnlockEditingId) return;
  const p = (providerStore.providers || []).find(x => x.id === providerUnlockEditingId);
  if (!p) return;
  const key = `provider-unlock:${providerUnlockEditingId}:${kind}`;
  if (_inFlightToggles.has(key)) return;
  _inFlightToggles.add(key);
  try {
    const updated = await invoke('set_provider_unlock', { providerId: providerUnlockEditingId, kind, enabled });
    const idx = providerStore.providers.findIndex(x => x.id === providerUnlockEditingId);
    if (idx >= 0 && updated) providerStore.providers[idx] = updated;
    if (idx >= 0) normalizeProviderUnlocks(providerStore.providers[idx]);
    renderProviders();
    renderProviderUnlockModal();
    addLog('ok', `供应商「${p.name || p.id}」已${enabled ? '解锁限制' : '取消解锁限制'} ${kind === 'codex' ? 'Codex' : 'Claude Code'}`);
  } catch (e) {
    showCustomAlert(String(e), enabled ? '解锁限制失败' : '取消解锁限制失败', 'error');
    renderProviderUnlockModal();
  } finally {
    _inFlightToggles.delete(key);
  }
}
function renderProviderCards(list) {
  return list.map(p => {
    const enabled = p.enabled !== false;
    const selected = providerSelectedIds.has(p.id);
    const builtin = isBuiltinProvider(p);
    const builtinBadge = builtinProviderBadgeHtml(p);
    const toggleHtml = builtin
      ? ''
      : `<div class="toggle ${enabled ? 'on' : ''}" title="${enabled ? '已启用，点击禁用' : '未启用，点击启用'}" data-action="toggleProviderEnabled" data-arg="${escAttr(p.id)}"></div>`;
    const isLocalProxy = isLocalProxyProvider(p);
    const actionsHtml = isLocalProxy
      ? `<button class="btn-ghost" data-action="testProvider" data-arg="${escAttr(p.id)}">测试</button>
         ${providerUnlockCardButtonHtml(p)}
         <button class="btn-ghost" data-action="navigateToProxyModels">编辑</button>`
      : builtin
      ? `<button class="btn-ghost" data-action="testProvider" data-arg="${escAttr(p.id)}">测试</button>
         ${providerUnlockCardButtonHtml(p)}
         <button class="btn-ghost" data-action="openProviderEditor" data-arg="${escAttr(p.id)}">编辑</button>`
      : `<button class="btn-ghost" data-action="testProvider" data-arg="${escAttr(p.id)}">测试</button>
         ${providerUnlockCardButtonHtml(p)}
         <button class="btn-ghost" data-action="openProviderEditor" data-arg="${escAttr(p.id)}">编辑</button>
         <button class="btn-ghost" data-action="deleteProvider" data-arg="${escAttr(p.id)}">删除</button>`;

    const selectCheckHtml = builtin
      ? ''
      : `<label class="provider-select-check" title="选择供应商" data-action="__noop" data-stop>
            <input type="checkbox" ${selected ? 'checked' : ''} data-action="toggleProviderSelection" data-events="change" data-args="[&quot;${escAttr(p.id)}&quot;]" data-pass-checked data-pass-event>
            <span></span>
          </label>`;
    const connStatusHtml = builtin
      ? `<div class="provider-conn-status" title="未测试">
            <div class="conn-dot no" id="conn-dot-${escAttr(p.id)}"></div>
            <span class="conn-text" id="conn-text-${escAttr(p.id)}" title="未测试">未测试</span>
          </div>`
      : `<div class="provider-conn-status" title="未测试">
            <div class="conn-dot no" id="conn-dot-${escAttr(p.id)}"></div>
            <span class="conn-text" id="conn-text-${escAttr(p.id)}" title="未测试">未测试</span>
          </div>`;

    return `
      <div class="provider-card ${enabled ? 'active' : ''} ${selected ? 'selected' : ''} ${builtin ? 'provider-card-builtin' : ''}">
        <div class="provider-top">
          ${selectCheckHtml}
          <div class="provider-id">
            <div>
              <div class="provider-name">${escAttr(p.name)} ${builtinBadge}</div>
            </div>
          </div>
          ${toggleHtml}
        </div>
        <div class="provider-body">
          <div class="field provider-model-field-block">
            <div class="field-label">已选模型</div>
            <div class="provider-model-chip-list">${providerModelBadges(p) || '<span class="provider-empty-text">未选择</span>'}</div>
          </div>
        </div>
        <div class="provider-footer">
          ${connStatusHtml}
          <div class="provider-card-actions">
            ${actionsHtml}
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderProviderListTable(list) {
  return `
    <div class="provider-list-shell">
      <table class="provider-list-table">
        <thead>
          <tr>
            <th class="provider-list-check-col"></th>
            <th>供应商</th>
            <th>能力 / 限制</th>
            <th class="provider-list-action-col">操作</th>
            <th class="provider-list-enabled-col">启用</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(p => {
            const enabled = p.enabled !== false;
            const selected = providerSelectedIds.has(p.id);
            const builtin = isBuiltinProvider(p);
            const builtinBadge = builtinProviderBadgeHtml(p);
            const isLocalProxy = isLocalProxyProvider(p);
            const actionButtons = isLocalProxy
              ? `<button class="provider-list-icon-btn" data-action="testProvider" data-arg="${escAttr(p.id)}" title="测试" aria-label="测试 ${escAttr(p.name || p.id)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M10 2v7.3a4 4 0 0 1-.54 2L4.2 20.1A1.3 1.3 0 0 0 5.32 22h13.36a1.3 1.3 0 0 0 1.12-1.9l-5.26-8.8a4 4 0 0 1-.54-2V2"></path>
                    <path d="M8.5 2h7"></path>
                    <path d="M7.5 15h9"></path>
                  </svg>
                </button>
                ${providerUnlockListButtonHtml(p)}
                <button class="provider-list-icon-btn" data-action="navigateToProxyModels" title="编辑" aria-label="编辑">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                  </svg>
                </button>`
              : builtin
              ? `<button class="provider-list-icon-btn" data-action="testProvider" data-arg="${escAttr(p.id)}" title="测试" aria-label="测试 ${escAttr(p.name || p.id)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M10 2v7.3a4 4 0 0 1-.54 2L4.2 20.1A1.3 1.3 0 0 0 5.32 22h13.36a1.3 1.3 0 0 0 1.12-1.9l-5.26-8.8a4 4 0 0 1-.54-2V2"></path>
                    <path d="M8.5 2h7"></path>
                    <path d="M7.5 15h9"></path>
                  </svg>
                </button>
                ${providerUnlockListButtonHtml(p)}
                <button class="provider-list-icon-btn" data-action="openProviderEditor" data-arg="${escAttr(p.id)}" title="编辑" aria-label="编辑 ${escAttr(p.name || p.id)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                  </svg>
                </button>`
              : `<button class="provider-list-icon-btn" data-action="testProvider" data-arg="${escAttr(p.id)}" title="测试" aria-label="测试 ${escAttr(p.name || p.id)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M10 2v7.3a4 4 0 0 1-.54 2L4.2 20.1A1.3 1.3 0 0 0 5.32 22h13.36a1.3 1.3 0 0 0 1.12-1.9l-5.26-8.8a4 4 0 0 1-.54-2V2"></path>
                    <path d="M8.5 2h7"></path>
                    <path d="M7.5 15h9"></path>
                  </svg>
                </button>
                ${providerUnlockListButtonHtml(p)}
                <button class="provider-list-icon-btn" data-action="openProviderEditor" data-arg="${escAttr(p.id)}" title="编辑" aria-label="编辑 ${escAttr(p.name || p.id)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                  </svg>
                </button>
                <button class="provider-list-icon-btn danger" data-action="deleteProvider" data-arg="${escAttr(p.id)}" title="删除" aria-label="删除 ${escAttr(p.name || p.id)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 6h18"></path>
                    <path d="M8 6V4h8v2"></path>
                    <path d="M19 6l-1 14H6L5 6"></path>
                    <path d="M10 11v5"></path>
                    <path d="M14 11v5"></path>
                  </svg>
                </button>`;
            const toggleHtml = builtin
              ? ''
              : `<div class="toggle ${enabled ? 'on' : ''}" title="${enabled ? '已启用，点击禁用' : '未启用，点击启用'}" data-action="toggleProviderEnabled" data-arg="${escAttr(p.id)}"></div>`;
            return `
              <tr class="${selected ? 'selected' : ''} ${builtin ? 'provider-list-row-builtin' : ''}">
                <td class="provider-list-check-col">
                  ${builtin ? '' : `<label class="provider-select-check provider-select-check-table" title="选择供应商" data-action="__noop" data-stop>
                    <input type="checkbox" ${selected ? 'checked' : ''} data-action="toggleProviderSelection" data-events="change" data-args="[&quot;${escAttr(p.id)}&quot;]" data-pass-checked data-pass-event>
                    <span></span>
                  </label>`}
                </td>
                <td>
                  <div class="provider-list-identity">
                    <div class="provider-list-name-wrap">
                      <div class="provider-name">${escAttr(p.name)} ${builtinBadge}</div>
                      <div class="provider-list-sub">${escAttr(p.apiHost || p.id || '')}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="provider-inline-tags">
                    ${capabilityBadges(p, true)}
                    ${providerUnlockTagsHtml(p)}
                  </div>
                </td>
                <td class="provider-list-action-col">
                  <div class="provider-list-actions">
                    ${actionButtons}
                  </div>
                </td>
                <td class="provider-list-enabled-col">
                  <div class="provider-list-status-cell">
                    ${toggleHtml}
                  </div>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderProviders() {
  syncLocalProxyProvider();
  syncCpaLocalProvider();
  const grid = document.getElementById('providerGrid');
  const empty = document.getElementById('providerEmpty');
  if (!grid) return;
  const all = providerListAll();
  cleanupProviderSelection(all);
  const list = providerVisibleList(all);
  renderProviderToolbarState(all.length, list);
  grid.classList.toggle('provider-grid-list', providerViewMode === 'list');
  grid.innerHTML = providerViewMode === 'list'
    ? renderProviderListTable(list)
    : renderProviderCards(list);
  if (empty) {
    empty.style.display = list.length ? 'none' : 'block';
    empty.textContent = all.length
      ? '没有匹配的供应商。'
      : '尚未配置任何供应商，点击右上角「新增供应商」开始。';
  }
}

// ═══════ LOCAL PROVIDER IMPORT ═══════
function setProviderImportOpenButtonBusy(isBusy) {
  const btn = document.getElementById('provider-import-open-btn');
  if (!btn) return;
  const label = btn.querySelector('.provider-toolbar-label');
  btn.disabled = isBusy;
  if (label) label.textContent = isBusy ? '扫描中…' : '一键导入';
}

function providerImportSourceLabel(key) {
  return (PROVIDER_IMPORT_SOURCE_OPTIONS.find(x => x.key === key) || {}).label || key;
}

function providerImportSelectedSourceKeys() {
  const inputs = Array.from(document.querySelectorAll('#provider-import-sources input[type="checkbox"]'));
  return inputs.filter(input => input.checked).map(input => input.value);
}

function providerImportSelectedSourceLabels() {
  return providerImportSelectedSourceKeys().map(providerImportSourceLabel);
}

function setProviderImportSourceInputsDisabled(disabled) {
  document.querySelectorAll('#provider-import-sources input[type="checkbox"]').forEach(input => {
    input.disabled = disabled;
  });
}

function providerImportListSurface() {
  if (providerImportStep === 'scanning') {
    return document.getElementById('provider-import-scan-stage')
      || document.getElementById('provider-import-list');
  }
  return document.getElementById('provider-import-list');
}

function setProviderImportStep(step) {
  providerImportStep = ['scanning', 'results'].includes(step) ? step : 'select';
  const modal = document.querySelector('#provider-import-modal .provider-import-modal');
  if (modal) modal.dataset.importMode = providerImportStep;
  const title = document.getElementById('provider-import-control-title');
  if (title) {
    title.textContent = providerImportStep === 'results'
      ? '扫描结果'
      : (providerImportStep === 'scanning' ? '正在扫描' : '选择来源');
  }
  updateProviderImportPrimaryState();
}

function syncProviderImportSourceState() {
  const btn = document.getElementById('provider-import-rescan-btn');
  const selected = providerImportSelectedSourceKeys();
  if (btn) {
    btn.disabled = !providerImportScanRunning && selected.length === 0;
    btn.textContent = providerImportScanRunning ? '取消扫描' : (providerImportHasScanned ? '重新扫描' : '开始扫描');
  }
  const summary = document.getElementById('provider-import-summary');
  if (!providerImportHasScanned && summary) {
    summary.textContent = selected.length
      ? `已选择 ${selected.length} 个来源：${selected.map(providerImportSourceLabel).join(' / ')}`
      : '请选择至少一个扫描来源';
  }
  if (!providerImportScanRunning && !providerImportHasScanned) {
    resetProviderImportSourceStates(selected);
    renderProviderImportSourceStatus();
  }
  updateProviderImportPrimaryState();
}

function handleProviderImportScanAction() {
  return providerImportScanRunning ? cancelProviderImportScan() : scanProviderImportCandidates();
}

function handleProviderImportPrimaryAction() {
  if (providerImportStep !== 'results') {
    if (providerImportScanRunning) return cancelProviderImportScan();
    return scanProviderImportCandidates();
  }
  return importSelectedProviders();
}

async function openProviderImportModal() {
  if (providerImportOpening) return;
  const modal = document.getElementById('provider-import-modal');
  providerImportOpening = true;
  try {
    renderProviderImportScanPrompt();
    if (modal) modal.classList.add('active');
  } finally {
    providerImportOpening = false;
  }
}

function closeProviderImportModal() {
  const modal = document.getElementById('provider-import-modal');
  if (modal) modal.classList.remove('active');
}

function normalizeProviderImportHost(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeProviderImportPath(value) {
  return String(value || '').trim().toLowerCase();
}

function providerImportCandidateApiAddress(c) {
  return String(c?.apiHost || '').replace(/\/+$/, '') || '--';
}

function providerImportCandidateWarnings(c) {
  return Array.isArray(c?.warnings) ? c.warnings.map(x => String(x || '').trim()).filter(Boolean) : [];
}

function providerImportCandidateIsDuplicate(c) {
  const host = normalizeProviderImportHost(c?.apiHost);
  const path = normalizeProviderImportPath(c?.apiPath);
  const key = String(c?.apiKey || '');
  if (!host || !key) return false;
  return (providerStore.providers || []).some(p => {
    if (p?.meta?.codexConfig === true) return false;
    return normalizeProviderImportHost(p.apiHost) === host
      && normalizeProviderImportPath(p.apiPath) === path
      && String(p.apiKey || '') === key;
  });
}

function providerImportCandidateStatus(c) {
  if (!String(c?.apiHost || '').trim() || !String(c?.apiKey || '').trim()) {
    return { state: 'invalid', label: '缺少信息', title: '缺少 API 地址或密钥，无法直接导入', selectable: false, autoSelect: false };
  }
  if (providerImportCandidateIsDuplicate(c)) {
    return { state: 'duplicate', label: '已存在', title: '当前供应商列表中已有相同地址、路径和密钥', selectable: false, autoSelect: false };
  }
  const warnings = providerImportCandidateWarnings(c);
  if (warnings.length) {
    return { state: 'ready', label: '可导入', title: warnings.join('\n'), selectable: true, autoSelect: true };
  }
  return { state: 'ready', label: '可导入', title: '信息完整，默认选中导入', selectable: true, autoSelect: true };
}

function providerImportStatusPillHtml(status) {
  return `<span class="provider-import-status-pill ${escAttr(status.state)}" title="${escAttr(status.title)}">${escAttr(status.label)}</span>`;
}

function providerImportStatusCounts() {
  return providerImportCandidates.reduce((acc, c) => {
    const status = providerImportCandidateStatus(c).state;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { ready: 0, warning: 0, duplicate: 0, invalid: 0 });
}

function updateProviderImportFooterSummary() {
  const box = document.getElementById('provider-import-footer-summary');
  if (!box) return;
  if (providerImportScanRunning) {
    const done = Object.values(providerImportSourceStates).filter(s => ['found', 'empty', 'error'].includes(s.status)).length;
    const total = providerImportSelectedSourceKeys().length || PROVIDER_IMPORT_SOURCE_OPTIONS.length;
    box.textContent = `正在扫描 ${done} / ${total} 个来源，可随时取消`;
    return;
  }
  if (!providerImportHasScanned) {
    const selected = providerImportSelectedSourceKeys().length;
    box.textContent = selected ? `已选择 ${selected} 个来源` : '请选择扫描来源';
    return;
  }
  const selectable = providerImportCandidates.filter(c => providerImportCandidateStatus(c).selectable).length;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  const skipped = Math.max(0, providerImportCandidates.length - selectable);
  box.textContent = providerImportCandidates.length
    ? `已选择 ${selected} / ${selectable} 个可选项${skipped ? ` · ${skipped} 个不可导入` : ''}`
    : '没有可导入的候选供应商';
}

function updateProviderImportPrimaryState() {
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  if (!confirmBtn) return;
  if (providerImportStep !== 'results') {
    const selectedSources = providerImportSelectedSourceKeys();
    confirmBtn.disabled = !providerImportScanRunning && selectedSources.length === 0;
    if (providerImportScanRunning) {
      confirmBtn.textContent = '取消扫描';
    } else {
      confirmBtn.textContent = '开始扫描';
    }
    return;
  }

  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  confirmBtn.disabled = selected === 0 || providerImportScanRunning;
  confirmBtn.textContent = selected ? `导入选中项 (${selected})` : '导入选中项';
}

function resetProviderImportSourceStates(selectedKeys = providerImportSelectedSourceKeys()) {
  providerImportSourceStates = {};
  PROVIDER_IMPORT_SOURCE_OPTIONS.forEach(source => {
    const selected = selectedKeys.includes(source.key);
    providerImportSourceStates[source.key] = {
      key: source.key,
      label: source.label,
      selected,
      status: selected ? 'queued' : 'off',
      found: 0,
      message: selected ? '等待扫描' : '未选择',
    };
  });
}

function providerImportSourceStatusText(state) {
  if (!state) return '等待扫描';
  if (state.status === 'scanning') return '扫描中';
  if (state.status === 'found') return `找到 ${state.found || 0}`;
  if (state.status === 'empty') return '无可导入';
  if (state.status === 'error') return '出错';
  if (state.status === 'cancelled') return '已取消';
  if (state.status === 'off') return '未选择';
  return '等待扫描';
}

function renderProviderImportSourceStatus() {
  const box = document.getElementById('provider-import-source-status');
  if (!box) return;
  const states = PROVIDER_IMPORT_SOURCE_OPTIONS.map(source => providerImportSourceStates[source.key] || {
    key: source.key,
    label: source.label,
    selected: providerImportSelectedSourceKeys().includes(source.key),
    status: providerImportSelectedSourceKeys().includes(source.key) ? 'queued' : 'off',
    found: 0,
    message: '',
  });
  box.innerHTML = states.map(state => `
    <div class="provider-import-source-state ${escAttr(state.status)}">
      <span class="provider-import-source-state-name">${escAttr(state.label)}</span>
      <span class="provider-import-source-state-text" title="${escAttr(state.message || providerImportSourceStatusText(state))}">${escAttr(providerImportSourceStatusText(state))}</span>
    </div>
  `).join('');
}

function renderProviderImportFilters() {
  const box = document.getElementById('provider-import-filters');
  if (!box) return;
  const counts = providerImportStatusCounts();
  const items = [
    ['all', `全部 ${providerImportCandidates.length}`],
    ['ready', `可导入 ${counts.ready || 0}`],
    ['duplicate', `已存在 ${counts.duplicate || 0}`],
  ];
  box.innerHTML = items.map(([key, label]) => `
    <button type="button" class="provider-import-filter ${providerImportFilter === key ? 'active' : ''}" data-action="setProviderImportFilter" data-arg="${key}">${escAttr(label)}</button>
  `).join('');
}

function setProviderImportFilter(filter) {
  providerImportFilter = filter || 'all';
  renderProviderImportCandidates();
}

function providerImportFilteredCandidates() {
  if (providerImportFilter === 'all') return providerImportCandidates;
  return providerImportCandidates.filter(c => providerImportCandidateStatus(c).state === providerImportFilter);
}

function renderProviderImportScanPrompt() {
  providerImportScanSeq++;
  providerImportStep = 'select';
  providerImportHasScanned = false;
  providerImportLastScannedSourceLabels = [];
  providerImportCandidates = [];
  providerImportSelectedIds = new Set();
  providerImportFilter = 'all';
  providerImportScanRunning = false;
  providerImportActiveScanId = '';

  setProviderImportStep('select');
  const scanStage = document.getElementById('provider-import-scan-stage');
  const resultList = document.getElementById('provider-import-list');
  const summary = document.getElementById('provider-import-summary');
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  const selectedSources = providerImportSelectedSourceLabels();

  renderProviderImportNotices([]);
  if (summary) {
    summary.textContent = selectedSources.length
      ? `已选择 ${selectedSources.length} 个来源：${selectedSources.join(' / ')}`
      : '请选择至少一个扫描来源';
  }
  if (btn) {
    btn.disabled = selectedSources.length === 0;
    btn.textContent = '开始扫描';
  }
  if (confirmBtn) {
    confirmBtn.disabled = selectedSources.length === 0;
    confirmBtn.textContent = '开始扫描';
  }
  if (selectAll) {
    selectAll.disabled = true;
  }
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (clearBtn) clearBtn.disabled = true;
  resetProviderImportSourceStates(providerImportSelectedSourceKeys());
  renderProviderImportSourceStatus();
  renderProviderImportFilters();
  renderProviderImportResultsSub();
  updateProviderImportFooterSummary();
  if (resultList) {
    resultList.classList.remove('is-scanning');
    resultList.classList.remove('has-results');
    resultList.innerHTML = '<div class="provider-import-empty compact">扫描完成后在这里审核候选项。</div>';
  }
  if (scanStage) {
    scanStage.classList.remove('is-scanning');
    scanStage.classList.remove('has-results');
    scanStage.innerHTML = '';
  }
  syncProviderImportSourceState();
  updateProviderImportPrimaryState();
}

async function scanProviderImportCandidates(options = {}) {
  const { logResult = true } = options;
  if (!invoke) return false;
  const selectedSources = providerImportSelectedSourceKeys();
  if (!selectedSources.length) {
    showCustomAlert('请先选择至少一个要扫描的工具来源。', '没有扫描来源', 'warn');
    syncProviderImportSourceState();
    return false;
  }
  const selectedSourceNames = selectedSources.map(providerImportSourceLabel);
  providerImportLastScannedSourceLabels = selectedSourceNames;
  const scanSeq = ++providerImportScanSeq;
  providerImportHasScanned = true;
  providerImportScanRunning = true;
  providerImportActiveScanId = '';
  providerImportCandidates = [];
  providerImportSelectedIds = new Set();
  providerImportFilter = 'all';
  setProviderImportStep('scanning');
  resetProviderImportSourceStates(selectedSources);
  const list = providerImportListSurface();
  const summary = document.getElementById('provider-import-summary');
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  if (list) {
    list.classList.add('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = providerImportScanProgressHtml();
  }
  if (summary) summary.textContent = `正在扫描：${selectedSourceNames.join(' / ')}`;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '取消扫描';
  }
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = '取消扫描';
  }
  if (selectAll) selectAll.disabled = true;
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (clearBtn) clearBtn.disabled = true;
  renderProviderImportSourceStatus();
  renderProviderImportFilters();
  renderProviderImportResultsSub();
  updateProviderImportFooterSummary();
  setProviderImportSourceInputsDisabled(true);

  try {
    await bindProviderImportScanListener();
    const scanId = await invoke('start_provider_import_scan', { sources: selectedSources });
    if (scanSeq !== providerImportScanSeq) return false;
    providerImportActiveScanId = String(scanId || '');
    return true;
  } catch (e) {
    return scanProviderImportCandidatesFallback(e, selectedSources, scanSeq, logResult);
  }
}

async function scanProviderImportCandidatesFallback(originalError, selectedSources, scanSeq, logResult = true) {
  try {
    const result = await invoke('scan_importable_providers', { sources: selectedSources });
    if (scanSeq !== providerImportScanSeq) return false;
    providerImportScanRunning = false;
    providerImportCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
    providerImportSelectedIds = new Set(providerImportCandidates.filter(c => providerImportCandidateStatus(c).autoSelect).map(c => c.id));
    selectedSources.forEach(key => {
      const label = providerImportSourceLabel(key);
      const count = providerImportCandidates.filter(c => c.source === label).length;
      providerImportSourceStates[key] = { key, label, selected: true, status: count ? 'found' : 'empty', found: count, message: count ? `找到 ${count} 个候选` : '没有可导入项' };
    });
    renderProviderImportNotices(Array.isArray(result?.notices) ? result.notices : []);
    renderProviderImportSourceStatus();
    setProviderImportStep('results');
    renderProviderImportCandidates();
    finishProviderImportScanUi();
    if (logResult) addLog('ok', `一键导入扫描完成：${providerImportCandidates.length} 个候选供应商`);
    return true;
  } catch (e) {
    providerImportScanRunning = false;
    providerImportCandidates = [];
    providerImportSelectedIds = new Set();
    renderProviderImportNotices([]);
    const list = providerImportListSurface();
    const summary = document.getElementById('provider-import-summary');
    if (list) {
      list.classList.remove('is-scanning');
      list.classList.remove('has-results');
      list.innerHTML = `<div class="provider-import-empty">扫描失败：${escAttr(e || originalError)}</div>`;
    }
    if (summary) summary.textContent = '扫描失败';
    finishProviderImportScanUi();
    addLog('err', '本地供应商扫描失败: ' + (e || originalError));
    return false;
  }
}

async function bindProviderImportScanListener() {
  if (!tauriEvent?.listen || providerImportScanUnlisten) return;
  providerImportScanUnlisten = await tauriEvent.listen('provider-import-scan-progress', (event) => {
    applyProviderImportScanProgress(event.payload || {});
  });
}

function applyProviderImportScanProgress(payload) {
  const scanId = String(payload.scanId || '');
  if (!providerImportActiveScanId && scanId) providerImportActiveScanId = scanId;
  if (providerImportActiveScanId && scanId && providerImportActiveScanId !== scanId) return;

  const sourceKey = payload.sourceKey || '';
  if (sourceKey && providerImportSourceStates[sourceKey]) {
    providerImportSourceStates[sourceKey] = {
      ...providerImportSourceStates[sourceKey],
      status: payload.status || providerImportSourceStates[sourceKey].status,
      found: Number(payload.found || 0),
      message: payload.message || '',
    };
  }

  if (payload.phase === 'source-complete' && Array.isArray(payload.candidates)) {
    mergeProviderImportCandidates(payload.candidates);
    renderProviderImportNotices(Array.isArray(payload.notices) ? payload.notices : []);
  }

  if (payload.phase === 'complete') {
    providerImportScanRunning = false;
    providerImportCandidates = Array.isArray(payload.candidates) ? payload.candidates : providerImportCandidates;
    providerImportSelectedIds = new Set(providerImportCandidates.filter(c => providerImportCandidateStatus(c).autoSelect).map(c => c.id));
    renderProviderImportNotices(Array.isArray(payload.notices) ? payload.notices : []);
    setProviderImportStep('results');
    renderProviderImportCandidates();
    finishProviderImportScanUi();
    addLog('ok', `一键导入扫描完成：${providerImportCandidates.length} 个候选供应商`);
    return;
  }

  if (payload.phase === 'cancelled') {
    finishProviderImportCancelledScan(payload.message || '扫描已取消');
    return;
  }

  renderProviderImportSourceStatus();
  renderProviderImportCandidates();
  updateProviderImportFooterSummary();
  const summary = document.getElementById('provider-import-summary');
  if (summary && payload.message) summary.textContent = payload.message;
}

function mergeProviderImportCandidates(candidates) {
  (candidates || []).forEach(candidate => {
    if (!candidate || !candidate.id) return;
    const existing = providerImportCandidates.findIndex(c => c.id === candidate.id);
    if (existing >= 0) providerImportCandidates[existing] = candidate;
    else providerImportCandidates.push(candidate);
    if (providerImportCandidateStatus(candidate).autoSelect) providerImportSelectedIds.add(candidate.id);
  });
}

function finishProviderImportCancelledScan(message = '扫描已取消') {
  providerImportScanRunning = false;
  providerImportActiveScanId = '';
  Object.keys(providerImportSourceStates).forEach(key => {
    if (providerImportSourceStates[key].status === 'queued' || providerImportSourceStates[key].status === 'scanning') {
      providerImportSourceStates[key].status = 'cancelled';
      providerImportSourceStates[key].message = message;
    }
  });

  if (providerImportCandidates.length) {
    providerImportHasScanned = true;
    setProviderImportStep('results');
    renderProviderImportSourceStatus();
    renderProviderImportCandidates();
    finishProviderImportScanUi();
    const summary = document.getElementById('provider-import-summary');
    if (summary) summary.textContent = `扫描已取消，已保留 ${providerImportCandidates.length} 个候选`;
    addLog('warn', `本地供应商扫描已取消，保留 ${providerImportCandidates.length} 个候选`);
    return;
  }

  providerImportHasScanned = false;
  setProviderImportStep('select');
  const scanStage = document.getElementById('provider-import-scan-stage');
  const resultList = document.getElementById('provider-import-list');
  if (scanStage) {
    scanStage.classList.remove('is-scanning');
    scanStage.classList.remove('has-results');
    scanStage.innerHTML = '';
  }
  if (resultList) {
    resultList.classList.remove('is-scanning');
    resultList.classList.remove('has-results');
    resultList.innerHTML = '<div class="provider-import-empty compact">扫描完成后在这里审核候选项。</div>';
  }
  syncProviderImportSourceState();
  finishProviderImportScanUi();
  const summary = document.getElementById('provider-import-summary');
  if (summary) summary.textContent = '扫描已取消，可重新开始';
  addLog('warn', '本地供应商扫描已取消');
}

async function cancelProviderImportScan() {
  if (!invoke || !providerImportScanRunning) return;
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '取消中…';
  }
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '取消中…';
  }
  try {
    await invoke('cancel_provider_import_scan');
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '取消扫描';
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '取消扫描';
    }
    addLog('err', '取消本地扫描失败: ' + e);
  }
}

function finishProviderImportScanUi() {
  const list = providerImportListSurface();
  const btn = document.getElementById('provider-import-rescan-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  if (list) list.classList.remove('is-scanning');
  if (btn) {
    btn.disabled = false;
    btn.textContent = providerImportHasScanned ? '重新扫描' : '开始扫描';
  }
  if (selectAll) selectAll.disabled = providerImportCandidates.filter(c => providerImportCandidateStatus(c).selectable).length === 0;
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (clearBtn) clearBtn.disabled = providerImportCandidates.length === 0;
  setProviderImportSourceInputsDisabled(false);
  syncProviderImportSelectionState();
  syncProviderImportSourceState();
  renderProviderImportSourceStatus();
  renderProviderImportResultsSub();
  updateProviderImportPrimaryState();
}

function renderProviderImportNotices(notices) {
  const box = document.getElementById('provider-import-notices');
  if (!box) return;
  const clean = (notices || []).map(x => String(x || '').trim()).filter(Boolean);
  box.classList.toggle('has-items', clean.length > 0);
  box.innerHTML = clean.map(n => `<div class="provider-import-notice">${escAttr(n)}</div>`).join('');
}

function renderProviderImportResultsSub() {
  const box = document.getElementById('provider-import-results-sub');
  if (!box) return;
  if (providerImportScanRunning) {
    box.textContent = '扫描过程中会逐步追加候选项';
    return;
  }
  const counts = providerImportStatusCounts();
  box.textContent = providerImportCandidates.length
    ? `${providerImportCandidates.length} 个候选 · ${counts.ready || 0} 可导入 · ${counts.duplicate || 0} 已存在`
    : '扫描后在这里审核候选项';
}

function providerImportScanProgressHtml(options = {}) {
  const { inline = false } = options;
  const states = PROVIDER_IMPORT_SOURCE_OPTIONS.map(source => providerImportSourceStates[source.key] || {
    key: source.key,
    label: source.label,
    selected: providerImportSelectedSourceKeys().includes(source.key),
    status: providerImportSelectedSourceKeys().includes(source.key) ? 'queued' : 'off',
    found: 0,
    message: '',
  });
  const selectedStates = states.filter(state => state.selected);
  const activeState = selectedStates.find(state => state.status === 'scanning')
    || selectedStates.find(state => state.status === 'queued')
    || selectedStates[0]
    || null;
  const finished = selectedStates.filter(state => ['found', 'empty', 'error', 'cancelled'].includes(state.status)).length;
  const total = selectedStates.length;
  const found = providerImportCandidates.length;
  const rows = selectedStates.map(state => {
    const title = state.message || providerImportSourceStatusText(state);
    return `
      <div class="provider-import-scan-log-row ${escAttr(state.status)}">
        <span class="provider-import-scan-log-dot" aria-hidden="true"></span>
        <span class="provider-import-scan-log-name">${escAttr(state.label)}</span>
        <span class="provider-import-scan-log-text" title="${escAttr(title)}">${escAttr(providerImportSourceStatusText(state))}</span>
      </div>`;
  }).join('');
  const loadingLines = [0, 1, 2, 3, 4].map((_, index) => `
    <div class="provider-import-loading-row" style="--row:${index}">
      <span class="provider-import-loading-check"></span>
      <span class="provider-import-loading-main"></span>
      <span class="provider-import-loading-meta"></span>
      <span class="provider-import-loading-state"></span>
    </div>
  `).join('');

  return `
    <div class="provider-import-scan-progress ${inline ? 'inline' : ''}" role="status" aria-live="polite">
      <div class="provider-import-scan-progress-head">
        <div class="provider-import-scan-icon is-running">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-3.2-6.9"></path>
            <path d="M21 3v6h-6"></path>
          </svg>
        </div>
        <div class="provider-import-scan-progress-copy">
          <div class="provider-import-scan-title">${escAttr(activeState ? `正在扫描 ${activeState.label}` : '正在扫描本机配置')}</div>
          <div class="provider-import-scan-desc">已完成 ${finished} / ${total || 0} 个来源${found ? ` · 已发现 ${found} 个候选` : ' · 正在等待候选结果'}</div>
        </div>
      </div>
      <div class="provider-import-scan-log">${rows}</div>
      ${inline ? '' : `<div class="provider-import-loading-lines" aria-hidden="true">${loadingLines}</div>`}
    </div>`;
}

function renderProviderImportCandidates() {
  const list = providerImportListSurface();
  const summary = document.getElementById('provider-import-summary');
  renderProviderImportFilters();
  renderProviderImportResultsSub();
  if (summary) {
    if (!providerImportScanRunning) {
      summary.textContent = providerImportCandidates.length
        ? `${providerImportCandidates.length} 个候选`
        : '没有可导入的候选';
    }
  }
  if (!list) return;
  if (providerImportStep === 'scanning') {
    list.classList.add('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = providerImportScanProgressHtml();
    syncProviderImportSelectionState();
    return;
  }
  if (providerImportScanRunning && !providerImportCandidates.length) {
    list.classList.add('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = providerImportScanProgressHtml();
    syncProviderImportSelectionState();
    return;
  }
  if (!providerImportCandidates.length) {
    list.classList.remove('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = `
      <div class="provider-import-empty provider-import-scan-prompt">
        <div class="provider-import-scan-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        </div>
        <div class="provider-import-scan-title">没有扫到可直接导入的供应商</div>
        <div class="provider-import-scan-desc">可以稍后重新打开一键导入，或手动新增供应商。</div>
      </div>`;
    syncProviderImportSelectionState();
    return;
  }
  list.classList.toggle('is-scanning', providerImportScanRunning);
  list.classList.add('has-results');

  const visible = providerImportFilteredCandidates();
  if (!visible.length) {
    list.innerHTML = providerImportScanRunning
      ? providerImportScanProgressHtml({ inline: true })
      : `<div class="provider-import-empty compact">当前筛选下没有候选项。</div>`;
    syncProviderImportSelectionState();
    return;
  }

  const rows = visible.map(c => {
    const status = providerImportCandidateStatus(c);
    const selected = providerImportSelectedIds.has(c.id);
    const sourceTitle = [c.source || '', c.sourcePath || '', c.sourceId || ''].filter(Boolean).join('\n');
    const endpoint = providerImportCandidateApiAddress(c);
    const warnings = providerImportCandidateWarnings(c);
    const note = c.sourcePath || '';
    const nextChecked = selected ? 'false' : 'true';
    return `
      <div class="provider-import-row ${escAttr(status.state)} ${selected ? 'selected' : ''}" data-action="toggleProviderImportCandidate" data-args="[&quot;${escAttr(c.id)}&quot;,${nextChecked}]">
        <input class="provider-import-check" type="checkbox" ${selected ? 'checked' : ''} ${status.selectable ? '' : 'disabled'} data-action="__noop" data-stop data-action="toggleProviderImportCandidate" data-events="change" data-args="[&quot;${escAttr(c.id)}&quot;]" data-pass-checked>
        <div class="provider-import-row-main">
          <div class="provider-import-row-identity">
            <span class="provider-import-name" title="${escAttr(c.name || '')}">${escAttr(c.name || '未命名供应商')}</span>
            <span class="provider-import-source-pill" title="${escAttr(sourceTitle)}">${escAttr(c.source || '未知来源')}</span>
          </div>
          <span class="provider-import-row-endpoint" title="${escAttr(endpoint)}">${escAttr(endpoint || '--')}</span>
          <span class="provider-import-row-state">${providerImportStatusPillHtml(status)}</span>
          ${note ? `<div class="provider-import-row-note" title="${escAttr(note)}">${escAttr(note)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  list.innerHTML = providerImportScanRunning
    ? `${rows}<div class="provider-import-scan-tail">${providerImportScanProgressHtml({ inline: true })}</div>`
    : rows;
  syncProviderImportSelectionState();
}

function toggleProviderImportCandidate(id, checked) {
  const candidate = providerImportCandidates.find(c => c.id === id);
  if (candidate && !providerImportCandidateStatus(candidate).selectable) return;
  if (checked) {
    providerImportSelectedIds.add(id);
  } else {
    providerImportSelectedIds.delete(id);
  }
  syncProviderImportSelectionState();
}

function toggleAllProviderImportCandidates(checked) {
  if (checked) {
    providerImportSelectedIds = new Set(providerImportCandidates.filter(c => providerImportCandidateStatus(c).state === 'ready').map(c => c.id));
  } else {
    providerImportSelectedIds = new Set();
  }
  renderProviderImportCandidates();
}

function syncProviderImportSelectionState() {
  const total = providerImportCandidates.filter(c => providerImportCandidateStatus(c).selectable).length;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  const selectAll = document.getElementById('provider-import-select-all');
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (selectAll) {
    selectAll.disabled = total === 0 || providerImportScanRunning;
  }
  if (clearBtn) {
    clearBtn.disabled = selected === 0 || providerImportScanRunning;
  }
  updateProviderImportFooterSummary();
  updateProviderImportPrimaryState();
}

async function importSelectedProviders() {
  if (!invoke) return;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id) && providerImportCandidateStatus(c).selectable);
  if (!selected.length) {
    showCustomAlert('请先勾选要导入的供应商。', '没有选中项', 'warn');
    return;
  }

  const btn = document.getElementById('provider-import-confirm-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '导入中…';
  }
  try {
    const result = await invoke('import_providers', { candidates: selected });
    if (result?.store && Array.isArray(result.store.providers)) {
      providerStore = result.store;
    } else {
      await loadProviders();
    }
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    closeProviderImportModal();
    const imported = Number(result?.imported || 0);
    const skipped = Number(result?.skipped || 0);
    addLog('ok', `一键导入完成：新增 ${imported} 个，跳过 ${skipped} 个`);
    const messages = Array.isArray(result?.messages) ? result.messages.filter(Boolean).slice(0, 3) : [];
    const detail = messages.length ? `\n\n${messages.join('\n')}` : '';
    showCustomAlert(`已新增 ${imported} 个供应商，跳过 ${skipped} 个。${detail}`, '导入完成', skipped ? 'info' : 'success');
  } catch (e) {
    addLog('err', '本地供应商导入失败: ' + e);
    showCustomAlert(String(e), '导入失败', 'error');
  } finally {
    syncProviderImportSelectionState();
  }
}

// ═══════ MODEL EVALUATION ═══════
globalThis.evalReports = [];
globalThis.currentEvalReportId = '';
globalThis.evalRunning = false;
globalThis.currentEvalProgressId = '';
globalThis.evalProgressUnlisten = null;
globalThis.EVAL_COMBO_IDS = ['eval-provider-select', 'eval-format-select', 'eval-model-select'];
globalThis.evalRemoteModelCache = new Map();
globalThis.evalRemoteModelPending = new Set();
globalThis.evalModelFetchSeq = 0;

function getEvalComboParts(selectId) {
  const shell = document.querySelector(`.eval-combo[data-select-id="${selectId}"]`);
  return {
    shell,
    select: document.getElementById(selectId),
    trigger: shell ? shell.querySelector('.eval-combo-trigger') : null,
    label: shell ? shell.querySelector('.eval-combo-label') : null,
    menu: shell ? shell.querySelector('.eval-combo-menu') : null,
  };
}

function closeEvalCombos(exceptId = '') {
  EVAL_COMBO_IDS.forEach(selectId => {
    if (selectId === exceptId) return;
    const { shell, trigger, menu } = getEvalComboParts(selectId);
    if (!shell) return;
    shell.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.setAttribute('aria-hidden', 'true');
  });
}

function focusEvalComboOption(selectId, offset = 0) {
  const { menu, select } = getEvalComboParts(selectId);
  if (!menu || !select) return;
  const options = Array.from(menu.querySelectorAll('.eval-combo-option'));
  if (!options.length) return;
  const selectedIndex = Math.max(0, Array.from(select.options).findIndex(option => option.value === select.value));
  const next = (selectedIndex + offset + options.length) % options.length;
  options[next].focus();
}

function setEvalComboOpen(selectId, open) {
  const { shell, trigger } = getEvalComboParts(selectId);
  if (!shell || !trigger) return;
  closeEvalCombos(selectId);
  shell.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  const { menu } = getEvalComboParts(selectId);
  if (menu) menu.setAttribute('aria-hidden', String(!open));
  if (open) {
    syncEvalCombo(selectId);
    requestAnimationFrame(() => focusEvalComboOption(selectId));
  }
}

function toggleEvalCombo(selectId, event) {
  if (event) event.stopPropagation();
  const { shell } = getEvalComboParts(selectId);
  setEvalComboOpen(selectId, !(shell && shell.classList.contains('open')));
}

function handleEvalComboTriggerKey(selectId, event) {
  if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  setEvalComboOpen(selectId, true);
  requestAnimationFrame(() => focusEvalComboOption(selectId, event.key === 'ArrowUp' ? -1 : 0));
}

function selectEvalComboOption(selectId, value, event) {
  if (event) event.stopPropagation();
  const { select, trigger } = getEvalComboParts(selectId);
  if (!select) return;
  const changed = select.value !== value;
  select.value = value;
  if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  closeEvalCombos();
  syncEvalCombos();
  if (trigger) trigger.focus();
}

function syncEvalCombo(selectId) {
  const { select, trigger, label, menu, shell } = getEvalComboParts(selectId);
  if (!select || !trigger || !label || !menu || !shell) return;
  const options = Array.from(select.options);
  const selected = options.find(option => option.value === select.value) || options[0] || null;
  if (selected && select.value !== selected.value) select.value = selected.value;
  label.textContent = selected ? selected.textContent : '--';
  trigger.disabled = !options.length;
  const isOpen = shell.classList.contains('open');
  trigger.setAttribute('aria-expanded', String(isOpen));
  menu.setAttribute('aria-hidden', String(!isOpen));
  menu.innerHTML = '';
  options.forEach(option => {
    const item = document.createElement('button');
    const isSelected = selected && option.value === selected.value;
    item.type = 'button';
    item.className = `eval-combo-option${isSelected ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isSelected));
    item.innerHTML = '<span class="eval-option-text"></span><span class="eval-option-check" aria-hidden="true">✓</span>';
    item.querySelector('.eval-option-text').textContent = option.textContent;
    item.addEventListener('click', event => selectEvalComboOption(selectId, option.value, event));
    menu.appendChild(item);
  });
}

function syncEvalCombos() {
  EVAL_COMBO_IDS.forEach(syncEvalCombo);
}

window.addEventListener('click', () => closeEvalCombos());
document.addEventListener('keydown', event => {
  const activeCombo = document.querySelector('.eval-combo.open');
  if (!activeCombo) return;
  const selectId = activeCombo.getAttribute('data-select-id') || '';
  const options = Array.from(activeCombo.querySelectorAll('.eval-combo-option'));
  const currentIndex = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    const { trigger } = getEvalComboParts(selectId);
    closeEvalCombos();
    if (trigger) trigger.focus();
    return;
  }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (Math.max(0, currentIndex) + delta + options.length) % options.length;
    options[next].focus();
  }
});

function getEvalProvider(id) {
  return (providerStore.providers || []).find(p => p.id === id) || null;
}

function normalizeEvalModels(models) {
  return [...new Set((models || []).map(m => String(m || '').trim()).filter(Boolean))];
}

function normalizeEvalApiFormat(value, allowAuto = true) {
  const raw = String(value || '').trim().toLowerCase();
  if (allowAuto && raw === 'auto') return 'auto';
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic') return 'anthropic';
  return allowAuto ? 'auto' : 'openai';
}

function evalApiFormatLabel(value) {
  const fmt = normalizeEvalApiFormat(value);
  if (fmt === 'auto') return '自动';
  if (fmt === 'openai') return 'OpenAI';
  if (fmt === 'anthropic') return 'Anthropic';
  return value || '--';
}

function getEvalApiFormat() {
  return normalizeEvalApiFormat(document.getElementById('eval-format-select')?.value || 'auto');
}

function evalRemoteModelCacheKey(providerId, apiFormat) {
  return `${String(providerId || '')}|${normalizeEvalApiFormat(apiFormat, false)}`;
}

function getEvalSavedModelList(provider) {
  if (!provider) return [];
  const models = [];
  if (provider.defaultModel) models.push(provider.defaultModel);
  if (Array.isArray(provider.models)) models.push(...provider.models);
  return normalizeEvalModels(models);
}

function getEvalModelList(provider, apiFormat = getEvalApiFormat()) {
  if (!provider) return [];
  const fmt = normalizeEvalApiFormat(apiFormat);
  const remoteModels = fmt === 'auto'
    ? [
        ...(evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, 'openai')) || []),
        ...(evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, 'anthropic')) || []),
      ]
    : (evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, fmt)) || []);
  return normalizeEvalModels([...getEvalSavedModelList(provider), ...remoteModels]);
}

function getEvalProviderFetchHost(provider) {
  const raw = String(provider?.apiHost || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).origin;
  } catch {
    return raw;
  }
}

function canFetchEvalModels(provider) {
  return !!(invoke && provider && provider.apiHost && provider.apiKey);
}

function shouldAutoFetchEvalModels() {
  return !!document.getElementById('page-eval')?.classList.contains('active');
}

async function fetchEvalRemoteModels(provider) {
  if (!canFetchEvalModels(provider)) return;
  const requestedFormat = getEvalApiFormat();
  const formats = requestedFormat === 'auto' ? ['openai', 'anthropic'] : [requestedFormat];
  const seq = ++evalModelFetchSeq;
  const modelSelect = document.getElementById('eval-model-select');
  let lastError = null;
  try {
    for (const apiFormat of formats) {
      const cacheKey = evalRemoteModelCacheKey(provider.id, apiFormat);
      if (evalRemoteModelCache.has(cacheKey)) return;
      if (evalRemoteModelPending.has(cacheKey)) return;
      evalRemoteModelPending.add(cacheKey);
      try {
        const result = await invoke('fetch_models', {
          args: {
            host: getEvalProviderFetchHost(provider),
            api_key: provider.apiKey,
            path: provider.apiPath || null,
            api_format: apiFormat,
          }
        });
        if (seq !== evalModelFetchSeq) return;
        const remoteModels = normalizeEvalModels(result?.models || []);
        if (!remoteModels.length) throw new Error('返回的模型列表为空');
        evalRemoteModelCache.set(cacheKey, remoteModels);
        renderEvalModelOptions({ fetchRemote: false });
        lastError = null;
        return;
      } catch (e) {
        lastError = e;
        if (requestedFormat === 'auto' && apiFormat === 'openai') {
          addLog('warn', `自动协议拉取模型：OpenAI 未通，尝试 Anthropic（${e}）`);
        }
      } finally {
        evalRemoteModelPending.delete(cacheKey);
      }
    }
  } catch (e) {
    lastError = e;
  } finally {
    if (seq !== evalModelFetchSeq) return;
    if (lastError && modelSelect && !getEvalModelList(provider).length) {
      modelSelect.innerHTML = '<option value="">模型拉取失败</option>';
      syncEvalCombos();
    }
    if (lastError) {
      addLog('warn', `检测模型完整列表拉取失败：${provider.name} (${lastError})`);
    }
  }
}

function renderEvalProviderOptions(options = {}) {
  const fetchRemote = options.fetchRemote ?? shouldAutoFetchEvalModels();
  const select = document.getElementById('eval-provider-select');
  if (!select) return;
  const previous = select.value;
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p));
  if (!providers.length) {
    select.innerHTML = '<option value="">无启用供应商</option>';
    renderEvalModelOptions({ fetchRemote });
    syncEvalCombos();
    return;
  }
  select.innerHTML = providers
    .map(p => `<option value="${escAttr(p.id)}">${escAttr(p.name)}</option>`)
    .join('');
  select.value = providers.some(p => p.id === previous) ? previous : providers[0].id;
  renderEvalModelOptions({ fetchRemote });
  syncEvalCombos();
}

function renderEvalModelOptions(options = {}) {
  const fetchRemote = options.fetchRemote ?? shouldAutoFetchEvalModels();
  const providerSelect = document.getElementById('eval-provider-select');
  const modelSelect = document.getElementById('eval-model-select');
  if (!modelSelect) return;
  const previous = modelSelect.value;
  const provider = getEvalProvider(providerSelect ? providerSelect.value : '');
  const models = getEvalModelList(provider);
  if (!models.length) {
    modelSelect.innerHTML = canFetchEvalModels(provider)
      ? '<option value="">拉取模型中...</option>'
      : '<option value="">未配置模型</option>';
    syncEvalCombos();
    if (fetchRemote) fetchEvalRemoteModels(provider);
    return;
  }
  modelSelect.innerHTML = models.map(m => `<option value="${escAttr(m)}">${escAttr(m)}</option>`).join('');
  const preferred = provider && models.includes(provider.defaultModel) ? provider.defaultModel : models[0];
  modelSelect.value = models.includes(previous) ? previous : preferred;
  syncEvalCombos();
  if (fetchRemote) fetchEvalRemoteModels(provider);
}

function evalStatusLabel(status) {
  return {
    pass: '通过',
    warn: '警告',
    fail: '失败',
    error: '错误',
    skip: '跳过',
    supported: '支持',
    partial: '部分',
    unsupported: '不支持',
    optional: '可选',
    unknown: '未测'
  }[status] || status || '--';
}

function evalStatusTag(status) {
  const key = String(status || 'skip').toLowerCase();
  return `<span class="eval-status ${escAttr(key)}">${escAttr(evalStatusLabel(key))}</span>`;
}

function evalRiskLabel(level) {
  return {
    low: '低风险',
    'medium-low': '较低',
    medium: '中风险',
    high: '高风险',
    critical: '严重'
  }[level] || '--';
}

function evalRiskColor(level) {
  return {
    low: 'var(--success)',
    'medium-low': 'var(--success)',
    medium: 'var(--accent-warm)',
    high: 'var(--danger)',
    critical: 'var(--danger)'
  }[level] || 'var(--text-primary)';
}

function evalRelationLabel(relation) {
  return {
    exact: '一致',
    alias: '别名',
    same_family: '同族',
    different: '不同',
    unknown: '未知'
  }[relation] || '--';
}

function evalCheckStatusClass(status) {
  const key = String(status || 'unknown').toLowerCase();
  if (key === 'supported' || key === 'pass') return 'supported';
  if (key === 'partial' || key === 'warn') return 'partial';
  if (key === 'unsupported' || key === 'fail' || key === 'error') return 'unsupported';
  if (key === 'optional') return 'unknown';
  return 'unknown';
}

function renderEvalChecks(containerId, checks, fallbackText = '等待检测') {
  const el = document.getElementById(containerId);
  if (!el) return;
  const items = Array.isArray(checks) ? checks : [];
  if (!items.length) {
    el.innerHTML = `<div class="eval-check-empty">${escAttr(fallbackText)}</div>`;
    return;
  }
  el.innerHTML = items.map(item => {
    const state = evalCheckStatusClass(item.status);
    const evidence = Array.isArray(item.evidence) && item.evidence.length
      ? item.evidence.slice(0, 2).join('\n')
      : '';
    const title = [item.detail, evidence].filter(Boolean).join('\n');
    return `
      <div class="eval-check-item ${state}" title="${escAttr(title)}">
        <div class="eval-check-top">
          <span>${escAttr(item.label || item.key || '--')}</span>
          <strong>${escAttr(evalStatusLabel(item.status))}</strong>
        </div>
        <div class="eval-check-detail">${escAttr(item.detail || '无细节')}</div>
      </div>`;
  }).join('');
}

function evalFormatDuration(ms) {
  const n = Number(ms || 0);
  if (!n) return '--';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function evalFormatTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '--';
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '--';
  }
}

globalThis.EVAL_DIMENSIONS = [
  { key: 'protocol', label: '协议合规', ids: ['P1', 'P2', 'P5', 'P13'] },
  { key: 'performance', label: '性能', ids: ['P10', 'P11'] },
  { key: 'safety', label: '安全性', ids: ['P8', 'P14'] },
  { key: 'content', label: '内容完整性', ids: ['P4'] },
  { key: 'capability', label: '能力验证', ids: ['P6', 'P9', 'P11'] },
  { key: 'identity', label: '身份一致', ids: ['P3', 'P7'] },
];

globalThis.EVAL_CHECK_OPTIONS = [
  { id: 'P4', label: '内容 Canary' },
  { id: 'P5', label: '流式传输' },
  { id: 'P6', label: '工具调用' },
  { id: 'P12', label: '图片理解' },
  { id: 'P13', label: '调用兼容' },
  { id: 'P14', label: '中转注入' },
  { id: 'P10', label: '稳定性' },
  { id: 'P8', label: 'Token 注入' },
  { id: 'P9', label: 'JSON 输出' },
  { id: 'P11', label: '输出吞吐' },
];

function renderEvalCheckPicker() {
  const grid = document.getElementById('eval-check-picker-grid');
  if (!grid) return;
  grid.innerHTML = EVAL_CHECK_OPTIONS.map(opt => `
    <label class="eval-check-option">
      <input type="checkbox" value="${escAttr(opt.id)}" checked data-action="syncEvalCheckButton" data-events="change">
      <span>${escAttr(opt.label)}</span>
    </label>
  `).join('');
  syncEvalCheckButton();
}

function setAllEvalChecks(checked) {
  document.querySelectorAll('#eval-check-picker-grid input[type="checkbox"]').forEach(input => {
    input.checked = !!checked;
  });
  syncEvalCheckButton();
}

function getSelectedEvalChecks() {
  const inputs = Array.from(document.querySelectorAll('#eval-check-picker-grid input[type="checkbox"]'));
  if (!inputs.length) return EVAL_CHECK_OPTIONS.map(opt => opt.id);
  return inputs.filter(input => input.checked).map(input => input.value);
}

function getEvalTotalForSelected(selectedChecks = getSelectedEvalChecks()) {
  return 4 + (Array.isArray(selectedChecks) ? selectedChecks.length : EVAL_CHECK_OPTIONS.length);
}

function syncEvalCheckButton() {
  const btn = document.getElementById('eval-check-open-btn');
  if (!btn) return;
  const count = getSelectedEvalChecks().length;
  btn.textContent = `检测项(${count}个)`;
  btn.title = count ? `已选择 ${count} 个附加检测项` : '仅执行基础协议检测';
}

function openEvalCheckModal() {
  syncEvalCheckButton();
  document.getElementById('eval-check-modal')?.classList.add('active');
}

function closeEvalCheckModal() {
  syncEvalCheckButton();
  document.getElementById('eval-check-modal')?.classList.remove('active');
}

function setEvalText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function evalScoreBand(score) {
  if (score >= 85) return '高一致性';
  if (score >= 70) return '良好';
  if (score >= 50) return '需复核';
  if (score >= 30) return '高风险';
  return '不可用';
}

function evalSafeScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function evalDimensionScores(report) {
  const probes = Array.isArray(report?.probes) ? report.probes : [];
  return EVAL_DIMENSIONS.map(dim => {
    const matched = probes.filter(p => dim.ids.includes(String(p.id || '').toUpperCase()) && p.status !== 'skip');
    const score = matched.length
      ? matched.reduce((sum, p) => sum + evalSafeScore(p.score), 0) / matched.length
      : evalSafeScore(report?.score);
    return { ...dim, score: Math.round(score), probes: matched };
  });
}

function updateEvalRadar(score, dimensions) {
  const poly = document.getElementById('eval-radar-poly');
  const radarScore = document.getElementById('eval-radar-score');
  if (radarScore) radarScore.textContent = Number.isFinite(Number(score)) ? String(Math.round(score)) : '--';
  if (!poly) return;
  const cx = 110;
  const cy = 110;
  const radius = 86;
  const angles = [-90, -30, 30, 90, 150, 210];
  const points = (dimensions || EVAL_DIMENSIONS).map((dim, index) => {
    const value = evalSafeScore(dim.score) / 100;
    const angle = angles[index] * Math.PI / 180;
    const x = cx + Math.cos(angle) * radius * value;
    const y = cy + Math.sin(angle) * radius * value;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  poly.setAttribute('points', points.join(' '));
}

function renderEvalDimensions(dimensions) {
  const grid = document.getElementById('eval-dimension-grid');
  if (!grid) return;
  grid.innerHTML = dimensions.map(dim => {
    const probeMarks = dim.probes.length
      ? dim.probes.slice(0, 3).map(p => `<span>${escAttr(p.status === 'pass' ? '✓' : p.status === 'skip' ? '-' : p.status === 'warn' ? '?' : '×')}${escAttr(p.id || '')}</span>`).join('')
      : '<span>--</span>';
    return `
      <div class="eval-dimension-item">
        <div class="eval-dimension-top">
          <span>${escAttr(dim.label)}</span>
          <strong>${dim.score}%</strong>
        </div>
        <div class="eval-dimension-bar"><i style="width:${dim.score}%"></i></div>
        <div class="eval-dimension-probes">${probeMarks}</div>
      </div>`;
  }).join('');
}

function evalDiagnosisLevel(score) {
  if (score >= 85) return '高一致性（近似官方）';
  if (score >= 70) return '整体可用';
  if (score >= 50) return '需要复核';
  if (score >= 30) return '高风险';
  return '不可用';
}

function renderEvalDiagnosis(report, dimensions) {
  const score = evalSafeScore(report?.score);
  setEvalText('eval-diagnosis-level', evalDiagnosisLevel(score));
  const list = document.getElementById('eval-diagnosis-list');
  if (!list) return;
  const probes = Array.isArray(report?.probes) ? report.probes : [];
  const caps = Array.isArray(report?.caps) ? report.caps : [];
  const metrics = report?.metrics || {};
  const items = [];

  // 检测是否 protocol_offline
  const protocolOffline = caps.some(c => c.rule === 'protocol_offline');
  const p1 = probes.find(p => p.id === 'P1');

  if (caps.length) {
    items.push(`命中 ${caps.length} 条硬上限规则，最终综合分被压到 ${Math.min(...caps.map(c => Number(c.capValue || 0))).toFixed(0)} 分以内。`);
  }

  // 协议不可用时，从 P1 探针 evidence 中提取排查提示
  if (protocolOffline && p1) {
    if (p1.summary) items.push(`P1 协议连通性：${p1.summary}`);
    const hints = (p1.evidence || []).filter(e =>
      e.startsWith('请') || e.startsWith('供应商') || e.startsWith('目标') || e.startsWith('HTTPS') || e.startsWith('响应')
    );
    hints.forEach(h => items.push(`💡 ${h}`));
    const retryInfo = (p1.evidence || []).find(e => e.startsWith('已重试'));
    if (retryInfo) items.push(retryInfo);
  }

  const relation = metrics.modelRelation || 'unknown';
  const reported = report?.reportedModel || '';
  if (reported) {
    items.push(`响应模型字段为 ${reported}，与请求模型关系：${evalRelationLabel(relation)}。`);
  }
  if (!protocolOffline) {
    probes
      .filter(p => p.status !== 'skip' && (p.status !== 'pass' || evalSafeScore(p.score) < 75))
      .sort((a, b) => evalSafeScore(a.score) - evalSafeScore(b.score))
      .slice(0, 4)
      .forEach(p => items.push(`${p.id} ${p.name}: ${p.summary || evalStatusLabel(p.status)}`));
  }
  if (!items.length && dimensions.length) {
    const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0];
    items.push(`${weakest.label} 当前为 ${weakest.score}%，其它关键探针未发现明显异常。`);
  }
  list.innerHTML = items.map(item => `<li>${escAttr(item)}</li>`).join('');
}

function resetEvalReportChrome() {
  currentEvalProgressId = '';
  setEvalText('eval-report-state', '未开始');
  setEvalText('eval-report-target', '请选择供应商和模型');
  setEvalText('eval-report-id', '--');
  setEvalText('eval-report-clock', '--');
  setEvalText('eval-progress-text', '等待检测');
  setEvalText('eval-progress-score', '--');
  setEvalText('eval-footnote-left', '暂无报告');
  setEvalText('eval-footnote-right', '本机检测 · 完整探针');
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '0%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'idle';
  updateEvalRadar(0, EVAL_DIMENSIONS.map(dim => ({ ...dim, score: 0, probes: [] })));
  renderEvalDimensions([]);
  setEvalText('eval-diagnosis-level', '综合判定');
  const diagnosis = document.getElementById('eval-diagnosis-list');
  if (diagnosis) diagnosis.innerHTML = '';
  const capCard = document.getElementById('eval-cap-card');
  if (capCard) capCard.classList.add('no-caps');
  setEvalText('eval-cap-limit', '未命中硬上限');
  const capBox = document.getElementById('eval-caps');
  if (capBox) capBox.innerHTML = '<div class="eval-cap-row eval-cap-row-ok"><span class="eval-cap-pill">OK</span><div><strong>暂无硬上限命中</strong><small>完整检测完成后显示封顶规则</small></div></div>';
  renderEvalChecks('eval-capability-checks', [], '完整检测完成后显示能力支持情况');
  renderEvalChecks('eval-protocol-checks', [], '完整检测完成后显示调用方式兼容情况');
}

function renderEvalRunning(provider, model, apiFormat = getEvalApiFormat()) {
  currentEvalProgressId = '';
  const protocol = evalApiFormatLabel(apiFormat);
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (empty) {
    empty.style.display = 'grid';
    empty.textContent = '正在执行全面检测...';
  }
  if (result) result.style.display = 'none';
  setEvalText('eval-report-state', '检测中');
  setEvalText('eval-report-target', `${provider?.name || '--'} · ${model || '--'} · ${protocol} · 全面检测`);
  setEvalText('eval-report-id', 'pending');
  setEvalText('eval-report-clock', evalFormatTime(Date.now()));
  setEvalText('eval-progress-text', '准备执行完整探针');
  setEvalText('eval-progress-score', `0 / ${getEvalTotalForSelected()}`);
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'running';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '2%';
  document.querySelector('.eval-progress-panel')?.classList.add('is-running');
}

function renderEvalFailure(provider, model, message, apiFormat = getEvalApiFormat()) {
  const protocol = evalApiFormatLabel(apiFormat);
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (empty) {
    empty.style.display = 'grid';
    empty.textContent = '检测失败，请查看日志';
  }
  if (result) result.style.display = 'none';
  setEvalText('eval-report-state', '失败');
  setEvalText('eval-report-target', `${provider?.name || '--'} · ${model || '--'} · ${protocol}`);
  setEvalText('eval-report-id', '--');
  setEvalText('eval-report-clock', evalFormatTime(Date.now()));
  setEvalText('eval-progress-text', String(message || '检测失败').slice(0, 80));
  setEvalText('eval-progress-score', '--');
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'fail';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '0%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
}

function applyEvalProgress(payload) {
  if (!payload || !evalRunning) return;
  if (!currentEvalProgressId && payload.reportId) {
    currentEvalProgressId = payload.reportId;
    setEvalText('eval-report-id', payload.reportId);
  }
  if (currentEvalProgressId && payload.reportId && payload.reportId !== currentEvalProgressId) return;
  const completed = Number(payload.completed || 0);
  const total = Number(payload.total || 0) || getEvalTotalForSelected();
  const percent = Math.max(2, Math.min(98, Math.round((completed / total) * 100)));
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = `${percent}%`;
  setEvalText('eval-progress-score', `${Math.min(completed, total)} / ${total}`);
  if (payload.phase === 'started') {
    setEvalText('eval-progress-text', '开始执行完整探针');
    return;
  }
  if (payload.phase === 'finished') {
    setEvalText('eval-progress-text', '正在生成报告');
    setEvalText('eval-progress-score', `${total} / ${total}`);
    if (fill) fill.style.width = '100%';
    return;
  }
  const probe = [payload.probeId, payload.probeName].filter(Boolean).join(' ');
  const status = payload.status ? ` · ${evalStatusLabel(payload.status)}` : '';
  const score = payload.status && payload.status !== 'skip' ? ` · ${Number(payload.score || 0).toFixed(0)}分` : '';
  setEvalText('eval-progress-text', `${probe || '探针完成'}${status}${score}`);
}

async function bindEvalProgressListener() {
  if (!tauriEvent?.listen || evalProgressUnlisten) return;
  evalProgressUnlisten = await tauriEvent.listen('provider-eval-progress', (event) => {
    applyEvalProgress(event.payload || {});
  });
}

function renderEvalReport(report) {
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (!report) {
    currentEvalReportId = '';
    if (empty) {
      empty.style.display = 'grid';
      empty.textContent = '暂无报告';
    }
    if (result) result.style.display = 'none';
    ['eval-score', 'eval-risk', 'eval-requests', 'eval-duration', 'eval-reported-model', 'eval-token-speed', 'eval-ttft', 'eval-output-tokens', 'eval-score-cap-count', 'eval-score-probe-count', 'eval-score-model-relation'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '--';
        el.style.color = '';
        el.title = '';
      }
    });
    const riskStat = document.querySelector('.eval-stat-risk');
    if (riskStat) delete riskStat.dataset.level;
    const meta = document.getElementById('eval-report-meta');
    if (meta) meta.textContent = '--';
    resetEvalReportChrome();
    renderEvalHistory();
    return;
  }

  currentEvalReportId = report.id || '';
  if (empty) empty.style.display = 'none';
  if (result) result.style.display = 'grid';

  const score = Number(report.score || 0);
  const scoreEl = document.getElementById('eval-score');
  if (scoreEl) scoreEl.textContent = score.toFixed(0);
  const riskEl = document.getElementById('eval-risk');
  if (riskEl) {
    riskEl.textContent = evalScoreBand(score);
    riskEl.style.color = evalRiskColor(report.riskLevel);
  }
  const riskStat = document.querySelector('.eval-stat-risk');
  if (riskStat) riskStat.dataset.level = report.riskLevel || '';
  const requestEl = document.getElementById('eval-requests');
  if (requestEl) requestEl.textContent = String(report.usage?.requestCount || 0);
  const durationEl = document.getElementById('eval-duration');
  if (durationEl) durationEl.textContent = evalFormatDuration(report.durationMs);
  const metrics = report.metrics || {};
  const reportedModel = report.reportedModel || '';
  const relation = metrics.modelRelation || (reportedModel ? 'unknown' : 'unknown');
  const reportedEl = document.getElementById('eval-reported-model');
  if (reportedEl) {
    reportedEl.textContent = reportedModel || '--';
    reportedEl.title = reportedModel
      ? `请求模型: ${report.model || '--'}\n响应模型: ${reportedModel}\n关系: ${evalRelationLabel(relation)}`
      : '响应中未发现 model 字段';
  }
  const speedEl = document.getElementById('eval-token-speed');
  if (speedEl) {
    const tps = metrics.tokensPerSecond;
    speedEl.textContent = Number.isFinite(Number(tps)) ? Number(tps).toFixed(1) : '--';
  }
  const ttftEl = document.getElementById('eval-ttft');
  if (ttftEl) ttftEl.textContent = metrics.ttftMs == null ? '--' : evalFormatDuration(metrics.ttftMs);
  const outputEl = document.getElementById('eval-output-tokens');
  if (outputEl) {
    const outputTokens = metrics.throughputTokens ?? report.usage?.outputTokens;
    outputEl.textContent = outputTokens == null ? '--' : String(outputTokens);
  }
  const meta = document.getElementById('eval-report-meta');
  if (meta) {
    const protocol = evalApiFormatLabel(report.apiFormat);
    const modelMeta = reportedModel && reportedModel !== report.model
      ? `${report.model || '--'} → ${reportedModel}`
      : (report.model || reportedModel || '--');
    meta.textContent = `${report.providerName || '--'} · ${modelMeta} · ${protocol} · 全面检测 · 触发 ${Array.isArray(report.caps) ? report.caps.length : 0} 条 cap`;
  }
  const verdict = document.getElementById('eval-verdict');
  if (verdict) verdict.textContent = report.verdict || '--';

  const caps = Array.isArray(report.caps) ? report.caps : [];
  const capBox = document.getElementById('eval-caps');
  const capCard = document.getElementById('eval-cap-card');
  const capLimit = document.getElementById('eval-cap-limit');
  if (capCard) capCard.classList.toggle('no-caps', !caps.length);
  if (capLimit) {
    capLimit.textContent = caps.length
      ? `最严上限 ≤ ${Math.min(...caps.map(c => Number(c.capValue || 0))).toFixed(0)} 分`
      : '未命中硬上限';
  }
  if (capBox) {
    capBox.innerHTML = caps.length
      ? caps.map(c => `
        <div class="eval-cap-row">
          <span class="eval-cap-pill">≤ ${Number(c.capValue || 0).toFixed(0)}</span>
          <div>
            <strong>${escAttr(c.reason || c.rule || '硬上限规则命中')}</strong>
            <small>规则: ${escAttr(c.rule || '--')}</small>
          </div>
        </div>`).join('')
      : '<div class="eval-cap-row eval-cap-row-ok"><span class="eval-cap-pill">OK</span><div><strong>无硬上限命中</strong><small>综合分未被 cap 规则压低</small></div></div>';
  }
  setEvalText('eval-score-cap-count', `${caps.length} 条`);
  const probesForCount = Array.isArray(report.probes) ? report.probes : [];
  const executedCount = probesForCount.filter(p => p.status !== 'skip').length;
  const skippedCount = probesForCount.length - executedCount;
  setEvalText('eval-score-probe-count', skippedCount ? `${executedCount}/${probesForCount.length}` : `${executedCount} 项`);
  setEvalText('eval-score-model-relation', evalRelationLabel(relation));

  const dimensions = evalDimensionScores(report);
  updateEvalRadar(score, dimensions);
  renderEvalDimensions(dimensions);
  renderEvalDiagnosis(report, dimensions);
  renderEvalChecks('eval-capability-checks', report.capabilityChecks, '该报告没有能力矩阵');
  renderEvalChecks('eval-protocol-checks', report.protocolChecks, '该报告没有协议矩阵');
  setEvalText('eval-report-state', '已完成');
  setEvalText('eval-report-target', `${report.providerName || '--'} · ${report.model || '--'} · ${evalApiFormatLabel(report.apiFormat)} · 全面检测`);
  setEvalText('eval-report-id', report.id || '--');
  setEvalText('eval-report-clock', evalFormatTime(report.createdAt));
  const offlineCap = caps.find(c => c.rule === 'protocol_offline');
  const allProbes = Array.isArray(report.probes) ? report.probes : [];
  if (offlineCap) {
    const p1probe = allProbes.find(p => p.id === 'P1');
    const failSummary = p1probe?.summary || '协议不可用';
    setEvalText('eval-progress-text', `协议失败：${failSummary}`);
    setEvalText('eval-progress-score', `${score.toFixed(0)} / 100`);
    const state = document.getElementById('eval-report-state');
    if (state) state.dataset.state = 'warn';
  } else {
    setEvalText('eval-progress-text', '检测完成');
    setEvalText('eval-progress-score', `${score.toFixed(0)} / 100`);
    const state = document.getElementById('eval-report-state');
    if (state) state.dataset.state = 'done';
  }
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '100%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
  setEvalText('eval-footnote-left', `报告 ID ${report.id || '--'} · ${report.providerName || '--'} · ${evalApiFormatLabel(report.apiFormat)} · ${evalFormatTime(report.createdAt)}`);
  setEvalText('eval-footnote-right', `本机检测 · 全面探针 · 请求 ${report.usage?.requestCount || 0} · 耗时 ${evalFormatDuration(report.durationMs)}`);

  const body = document.getElementById('eval-probe-body');
  if (body) {
    const probes = Array.isArray(report.probes) ? report.probes : [];
    body.innerHTML = probes.map(p => {
      const evidence = Array.isArray(p.evidence) ? p.evidence : [];
      const evidenceHtml = evidence.length
        ? `<div class="eval-evidence">${evidence.map(x => escAttr(x)).join('<br>')}</div>`
        : '';
      const latency = p.latencyMs == null ? '--' : `${p.latencyMs}ms`;
      const scoreText = p.status === 'skip' ? '--' : Number(p.score || 0).toFixed(1);
      const key = String(p.status || 'skip').toLowerCase();
      return `
        <tr class="eval-probe-row status-${escAttr(key)}">
          <td><span style="font-family:var(--font-mono);font-weight:800;">${escAttr(p.id || '')}</span><div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${escAttr(p.name || '')}</div></td>
          <td>${evalStatusTag(p.status)}</td>
          <td style="font-family:var(--font-mono);font-weight:700;">${scoreText}</td>
          <td style="font-family:var(--font-mono);color:var(--text-muted);">${latency}</td>
          <td><div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">${escAttr(p.summary || '')}</div>${evidenceHtml}</td>
        </tr>`;
    }).join('');
  }
  renderEvalHistory();
}

function renderEvalHistory() {
  const list = document.getElementById('eval-history-list');
  ['evalReportCount', 'evalHistoryPageCount'].forEach(id => {
    const count = document.getElementById(id);
    if (count) count.textContent = `${evalReports.length} 份报告`;
  });
  if (!list) return;
  if (!evalReports.length) {
    list.innerHTML = '<div class="eval-empty-state">暂无历史</div>';
    return;
  }
  list.innerHTML = evalReports.map(r => {
    const active = r.id === currentEvalReportId ? ' active' : '';
    const reportedModel = r.reportedModel || '';
    const modelLine = reportedModel && reportedModel !== r.model
      ? `${r.model || '--'} → ${reportedModel}`
      : (r.model || reportedModel || '--');
    const protocol = evalApiFormatLabel(r.apiFormat);
    return `
      <div class="eval-history-item${active}" data-action="selectEvalReport" data-arg="${escAttr(r.id)}">
        <div class="eval-history-top">
          <div class="eval-history-name">
            <div class="eval-history-provider">${escAttr(r.providerName || '--')}</div>
            <div class="eval-history-model" title="${escAttr(`${modelLine} · ${protocol}`)}">${escAttr(modelLine)} · ${escAttr(protocol)}</div>
          </div>
          <div class="eval-history-score" style="color:${evalRiskColor(r.riskLevel)};">${Number(r.score || 0).toFixed(1)}</div>
        </div>
        <div class="eval-history-meta">
          <span class="eval-history-time">${evalFormatTime(r.createdAt)}</span>
          <button class="btn-ghost eval-history-delete" data-action="deleteEvalReport" data-args="[&quot;${escAttr(r.id)}&quot;]" data-pass-event>删除</button>
        </div>
      </div>`;
  }).join('');
}

function selectEvalReport(id) {
  const report = evalReports.find(r => r.id === id);
  if (!report) return;
  renderEvalReport(report);
  openEvalWorkbenchPage();
}

function openEvalHistoryPage() {
  navigateTo('eval-history');
  renderEvalHistory();
}

function openEvalWorkbenchPage() {
  navigateTo('eval');
}

async function loadEvalReports() {
  if (!invoke) {
    evalReports = [];
    renderEvalHistory();
    return;
  }
  try {
    evalReports = await invoke('list_eval_reports') || [];
    const current = evalReports.find(r => r.id === currentEvalReportId);
    renderEvalReport(current || evalReports[0] || null);
  } catch (e) {
    evalReports = [];
    renderEvalHistory();
    addLog('warn', '检测报告加载失败: ' + e);
  }
}

function setEvalRunning(running) {
  evalRunning = running;
  const btn = document.getElementById('evalRunBtn');
  if (!btn) return;
  btn.disabled = running;
  btn.classList.toggle('running', running);
  btn.textContent = running ? '检测中...' : '开始检测';
  btn.style.opacity = running ? '.72' : '1';
  btn.style.cursor = running ? 'default' : 'pointer';
}

function evalReportProtocolConnected(report) {
  const p1 = Array.isArray(report?.probes) ? report.probes.find(p => p.id === 'P1') : null;
  const status = String(p1?.status || '').toLowerCase();
  return status === 'pass' || status === 'warn';
}

function evalReportProtocolSummary(report) {
  const p1 = Array.isArray(report?.probes) ? report.probes.find(p => p.id === 'P1') : null;
  return p1?.summary || report?.verdict || '协议连通性未通过';
}

function rememberEvalReport(report) {
  if (!report?.id) return;
  evalReports = [report, ...evalReports.filter(r => r.id !== report.id)].slice(0, 20);
}

async function runProviderEvalRequest(providerId, model, mode, selectedChecks, apiFormat) {
  return await invoke('run_provider_eval', {
    request: { providerId, model, apiFormat, mode, selectedChecks }
  });
}

async function startEval() {
  if (evalRunning) return;
  const providerId = document.getElementById('eval-provider-select')?.value || '';
  const model = document.getElementById('eval-model-select')?.value || '';
  const apiFormat = getEvalApiFormat();
  const mode = 'standard';
  const selectedChecks = getSelectedEvalChecks();
  const provider = getEvalProvider(providerId);
  if (!provider || !model) {
    showCustomAlert('请选择已启用的供应商和模型。', '无法检测', 'warn');
    return;
  }

  setEvalRunning(true);
  renderEvalRunning(provider, model, apiFormat);
  addLog('info', `开始检测「${provider.name} / ${model}」· ${evalApiFormatLabel(apiFormat)}`);
  try {
    let report = null;
    if (apiFormat === 'auto') {
      renderEvalRunning(provider, model, 'openai');
      addLog('info', '自动协议：先按 OpenAI 检测');
      let openaiReport = null;
      try {
        openaiReport = await runProviderEvalRequest(providerId, model, mode, selectedChecks, 'openai');
        rememberEvalReport(openaiReport);
      } catch (e) {
        addLog('warn', `自动协议：OpenAI 请求异常，尝试 Anthropic（${e}）`);
      }
      if (openaiReport && evalReportProtocolConnected(openaiReport)) {
        report = openaiReport;
        addLog('ok', '自动协议：OpenAI 已通过，不再尝试 Anthropic');
      } else {
        const reason = openaiReport ? evalReportProtocolSummary(openaiReport) : 'OpenAI 请求异常';
        addLog('warn', `自动协议：OpenAI 未通（${reason}），尝试 Anthropic`);
        renderEvalRunning(provider, model, 'anthropic');
        report = await runProviderEvalRequest(providerId, model, mode, selectedChecks, 'anthropic');
        rememberEvalReport(report);
      }
    } else {
      report = await runProviderEvalRequest(providerId, model, mode, selectedChecks, apiFormat);
      rememberEvalReport(report);
    }
    renderEvalReport(report);
    await loadEvalReports();
    const doneLevel = evalReportProtocolConnected(report) ? 'ok' : 'warn';
    addLog(doneLevel, `检测完成：${provider.name} / ${model} · ${evalApiFormatLabel(report.apiFormat)}，得分 ${Number(report.score || 0).toFixed(1)}`);
  } catch (e) {
    addLog('err', '检测失败: ' + e);
    renderEvalFailure(provider, model, e, apiFormat);
    showCustomAlert(String(e), '检测失败', 'error');
  } finally {
    setEvalRunning(false);
  }
}

async function deleteEvalReport(id, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  try {
    evalReports = await invoke('delete_eval_report', { id }) || [];
    renderEvalReport(evalReports[0] || null);
    addLog('info', '已删除检测报告');
  } catch (e) {
    addLog('err', '删除检测报告失败: ' + e);
  }
}

async function toggleProviderEnabled(id) {
  if (!invoke) return;
  const key = 'provider:' + id;
  if (_inFlightToggles.has(key)) return;
  const p = providerStore.providers.find(x => x.id === id);
  if (!p) return;
  if (p.meta?.codexConfig === true) {
    showCustomAlert('这是 Codex 配置，不属于供应商启用状态。', '无法操作', 'warn');
    return;
  }
  if (isBuiltinProvider(p)) {
    showCustomAlert('内置供应商不可禁用。', '无法操作', 'warn');
    return;
  }
  const next = !(p.enabled !== false);
  _inFlightToggles.add(key);
  try {
    await invoke('set_provider_enabled', { id, enabled: next });
    p.enabled = next;
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    addLog('ok', `供应商「${p.name}」已${next ? '启用' : '禁用'}`);
  } catch (e) {
    addLog('err', '启用状态切换失败: ' + e);
  } finally {
    _inFlightToggles.delete(key);
  }
}

async function deleteProvider(id) {
  const p = providerStore.providers.find(x => x.id === id);
  if (p?.meta?.codexConfig === true) {
    showCustomAlert('这是 Codex 配置，请在 Codex 配置页删除。', '无法删除供应商', 'warn');
    return;
  }
  if (isBuiltinProvider(p)) {
    showCustomAlert('内置供应商不可删除。', '无法删除供应商', 'warn');
    return;
  }
  const previous = cloneProviderStore();
  providerStore.providers = providerStore.providers.filter(x => x.id !== id);
  const ok = await persistProviders();
  if (!ok) {
    providerStore = cloneProviderStore(previous);
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    return;
  }
  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
  addLog('info', '已删除供应商');
}

function cloneProviderStore(store = providerStore) {
  return JSON.parse(JSON.stringify(store || { version: 1, providers: [] }));
}

async function persistProviders() {
  if (!invoke) {
    const message = '当前环境缺少 Tauri invoke，无法保存供应商配置';
    addLog('err', message);
    if (typeof showCustomAlert === 'function') showCustomAlert(message, '保存失败', 'error');
    return false;
  }
  try {
    const storeToSave = {
      ...providerStore,
      providers: (providerStore.providers || []).filter(p => !isVirtualBuiltinProvider(p)),
    };
    await invoke('save_providers', { store: storeToSave });
    return true;
  } catch (e) {
    addLog('err', '保存供应商失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存供应商失败', 'error');
    return false;
  }
}

function copyLocalProxyInfo() {
  const p = providerStore.providers.find(x => x.id === LOCAL_PROXY_PROVIDER_ID);
  if (!p) return;
  const info = [
    `名称: ${p.name}`,
    `API Host: ${p.apiHost}`,
    `API Path: ${p.apiPath}`,
    `API Key: ${p.apiKey || '(空)'}`,
    `默认模型: ${p.defaultModel || '(无)'}`,
    `可用模型: ${(p.models || []).join(', ') || '(无)'}`,
  ].join('\n');
  navigator.clipboard?.writeText(info).then(() => {
    showCustomAlert('连接信息已复制到剪贴板。', '复制成功', 'info');
  }).catch(() => {
    showCustomAlert(info, '连接信息', 'info');
  });
}

function navigateToProxyModels() {
  navigateTo('proxy');
  activateProxyPanel('routes');
}

function navigateToProxyEnhancement() {
  navigateTo('proxy');
  activateProxyPanel('enhancement');
  activateEnhancementPanel('vision');
}

syncEvalCombos();

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
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
  g.isVirtualBuiltinProvider = isVirtualBuiltinProvider;
  g.isLocalProxyProvider = isLocalProxyProvider;
  g.isCpaLocalProvider = isCpaLocalProvider;
  g.builtinProviderBadgeHtml = builtinProviderBadgeHtml;
  g.localProxyProviderModelsEntry = localProxyProviderModelsEntry;
  g.isLocalProxyProviderEntry = isLocalProxyProviderEntry;
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
  g.providerVisibleList = providerVisibleList;
  g.cleanupProviderSelection = cleanupProviderSelection;
  g.providerModelBadges = providerModelBadges;
  g.renderProviderToolbarState = renderProviderToolbarState;
  g.onProviderSearchInput = onProviderSearchInput;
  g.clearProviderSearch = clearProviderSearch;
  g.setProviderViewMode = setProviderViewMode;
  g.setProviderSortMode = setProviderSortMode;
  g.syncProviderSortControl = syncProviderSortControl;
  g.setProviderSortMenuOpen = setProviderSortMenuOpen;
  g.toggleProviderSortMenu = toggleProviderSortMenu;
  g.closeProviderSortMenu = closeProviderSortMenu;
  g.chooseProviderSortMode = chooseProviderSortMode;
  g.toggleProviderSelection = toggleProviderSelection;
  g.toggleVisibleProvidersSelection = toggleVisibleProvidersSelection;
  g.setSelectedProvidersEnabled = setSelectedProvidersEnabled;
  g.deleteSelectedProviders = deleteSelectedProviders;
  g.normalizeProviderUnlocks = normalizeProviderUnlocks;
  g.providerUnlockEnabled = providerUnlockEnabled;
  g.providerUnlockLabels = providerUnlockLabels;
  g.providerUnlockSummaryHtml = providerUnlockSummaryHtml;
  g.providerUnlockTagsHtml = providerUnlockTagsHtml;
  g.providerUnlockIconSvg = providerUnlockIconSvg;
  g.providerUnlockCardButtonHtml = providerUnlockCardButtonHtml;
  g.providerUnlockListButtonHtml = providerUnlockListButtonHtml;
  g.ensureProviderUnlockModal = ensureProviderUnlockModal;
  g.openProviderUnlockModal = openProviderUnlockModal;
  g.closeProviderUnlockModal = closeProviderUnlockModal;
  g.providerUnlockRowHtml = providerUnlockRowHtml;
  g.renderProviderUnlockModal = renderProviderUnlockModal;
  g.setProviderUnlockFromModal = setProviderUnlockFromModal;
  g.renderProviderCards = renderProviderCards;
  g.renderProviderListTable = renderProviderListTable;
  g.renderProviders = renderProviders;
  g.setProviderImportOpenButtonBusy = setProviderImportOpenButtonBusy;
  g.providerImportSourceLabel = providerImportSourceLabel;
  g.providerImportSelectedSourceKeys = providerImportSelectedSourceKeys;
  g.providerImportSelectedSourceLabels = providerImportSelectedSourceLabels;
  g.setProviderImportSourceInputsDisabled = setProviderImportSourceInputsDisabled;
  g.providerImportListSurface = providerImportListSurface;
  g.setProviderImportStep = setProviderImportStep;
  g.syncProviderImportSourceState = syncProviderImportSourceState;
  g.handleProviderImportScanAction = handleProviderImportScanAction;
  g.handleProviderImportPrimaryAction = handleProviderImportPrimaryAction;
  g.openProviderImportModal = openProviderImportModal;
  g.closeProviderImportModal = closeProviderImportModal;
  g.normalizeProviderImportHost = normalizeProviderImportHost;
  g.normalizeProviderImportPath = normalizeProviderImportPath;
  g.providerImportCandidateApiAddress = providerImportCandidateApiAddress;
  g.providerImportCandidateWarnings = providerImportCandidateWarnings;
  g.providerImportCandidateIsDuplicate = providerImportCandidateIsDuplicate;
  g.providerImportCandidateStatus = providerImportCandidateStatus;
  g.providerImportStatusPillHtml = providerImportStatusPillHtml;
  g.providerImportStatusCounts = providerImportStatusCounts;
  g.updateProviderImportFooterSummary = updateProviderImportFooterSummary;
  g.updateProviderImportPrimaryState = updateProviderImportPrimaryState;
  g.resetProviderImportSourceStates = resetProviderImportSourceStates;
  g.providerImportSourceStatusText = providerImportSourceStatusText;
  g.renderProviderImportSourceStatus = renderProviderImportSourceStatus;
  g.renderProviderImportFilters = renderProviderImportFilters;
  g.setProviderImportFilter = setProviderImportFilter;
  g.providerImportFilteredCandidates = providerImportFilteredCandidates;
  g.renderProviderImportScanPrompt = renderProviderImportScanPrompt;
  g.scanProviderImportCandidates = scanProviderImportCandidates;
  g.scanProviderImportCandidatesFallback = scanProviderImportCandidatesFallback;
  g.bindProviderImportScanListener = bindProviderImportScanListener;
  g.applyProviderImportScanProgress = applyProviderImportScanProgress;
  g.mergeProviderImportCandidates = mergeProviderImportCandidates;
  g.finishProviderImportCancelledScan = finishProviderImportCancelledScan;
  g.cancelProviderImportScan = cancelProviderImportScan;
  g.finishProviderImportScanUi = finishProviderImportScanUi;
  g.renderProviderImportNotices = renderProviderImportNotices;
  g.renderProviderImportResultsSub = renderProviderImportResultsSub;
  g.providerImportScanProgressHtml = providerImportScanProgressHtml;
  g.renderProviderImportCandidates = renderProviderImportCandidates;
  g.toggleProviderImportCandidate = toggleProviderImportCandidate;
  g.toggleAllProviderImportCandidates = toggleAllProviderImportCandidates;
  g.syncProviderImportSelectionState = syncProviderImportSelectionState;
  g.importSelectedProviders = importSelectedProviders;
  g.getEvalComboParts = getEvalComboParts;
  g.closeEvalCombos = closeEvalCombos;
  g.focusEvalComboOption = focusEvalComboOption;
  g.setEvalComboOpen = setEvalComboOpen;
  g.toggleEvalCombo = toggleEvalCombo;
  g.handleEvalComboTriggerKey = handleEvalComboTriggerKey;
  g.selectEvalComboOption = selectEvalComboOption;
  g.syncEvalCombo = syncEvalCombo;
  g.syncEvalCombos = syncEvalCombos;
  g.getEvalProvider = getEvalProvider;
  g.normalizeEvalModels = normalizeEvalModels;
  g.normalizeEvalApiFormat = normalizeEvalApiFormat;
  g.evalApiFormatLabel = evalApiFormatLabel;
  g.getEvalApiFormat = getEvalApiFormat;
  g.evalRemoteModelCacheKey = evalRemoteModelCacheKey;
  g.getEvalSavedModelList = getEvalSavedModelList;
  g.getEvalModelList = getEvalModelList;
  g.getEvalProviderFetchHost = getEvalProviderFetchHost;
  g.canFetchEvalModels = canFetchEvalModels;
  g.shouldAutoFetchEvalModels = shouldAutoFetchEvalModels;
  g.fetchEvalRemoteModels = fetchEvalRemoteModels;
  g.renderEvalProviderOptions = renderEvalProviderOptions;
  g.renderEvalModelOptions = renderEvalModelOptions;
  g.evalStatusLabel = evalStatusLabel;
  g.evalStatusTag = evalStatusTag;
  g.evalRiskLabel = evalRiskLabel;
  g.evalRiskColor = evalRiskColor;
  g.evalRelationLabel = evalRelationLabel;
  g.evalCheckStatusClass = evalCheckStatusClass;
  g.renderEvalChecks = renderEvalChecks;
  g.evalFormatDuration = evalFormatDuration;
  g.evalFormatTime = evalFormatTime;
  g.renderEvalCheckPicker = renderEvalCheckPicker;
  g.setAllEvalChecks = setAllEvalChecks;
  g.getSelectedEvalChecks = getSelectedEvalChecks;
  g.getEvalTotalForSelected = getEvalTotalForSelected;
  g.syncEvalCheckButton = syncEvalCheckButton;
  g.openEvalCheckModal = openEvalCheckModal;
  g.closeEvalCheckModal = closeEvalCheckModal;
  g.setEvalText = setEvalText;
  g.evalScoreBand = evalScoreBand;
  g.evalSafeScore = evalSafeScore;
  g.evalDimensionScores = evalDimensionScores;
  g.updateEvalRadar = updateEvalRadar;
  g.renderEvalDimensions = renderEvalDimensions;
  g.evalDiagnosisLevel = evalDiagnosisLevel;
  g.renderEvalDiagnosis = renderEvalDiagnosis;
  g.resetEvalReportChrome = resetEvalReportChrome;
  g.renderEvalRunning = renderEvalRunning;
  g.renderEvalFailure = renderEvalFailure;
  g.applyEvalProgress = applyEvalProgress;
  g.bindEvalProgressListener = bindEvalProgressListener;
  g.renderEvalReport = renderEvalReport;
  g.renderEvalHistory = renderEvalHistory;
  g.selectEvalReport = selectEvalReport;
  g.openEvalHistoryPage = openEvalHistoryPage;
  g.openEvalWorkbenchPage = openEvalWorkbenchPage;
  g.loadEvalReports = loadEvalReports;
  g.setEvalRunning = setEvalRunning;
  g.evalReportProtocolConnected = evalReportProtocolConnected;
  g.evalReportProtocolSummary = evalReportProtocolSummary;
  g.rememberEvalReport = rememberEvalReport;
  g.runProviderEvalRequest = runProviderEvalRequest;
  g.startEval = startEval;
  g.deleteEvalReport = deleteEvalReport;
  g.toggleProviderEnabled = toggleProviderEnabled;
  g.deleteProvider = deleteProvider;
  g.cloneProviderStore = cloneProviderStore;
  g.persistProviders = persistProviders;
  g.copyLocalProxyInfo = copyLocalProxyInfo;
  g.navigateToProxyModels = navigateToProxyModels;
  g.navigateToProxyEnhancement = navigateToProxyEnhancement;
})(globalThis);
