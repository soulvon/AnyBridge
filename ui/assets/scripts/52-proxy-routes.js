// ═══════ LOCAL PROXY MODEL ROUTES ═══════
let proxyRoutesStore = { version: 1, defaultModelId: '', routes: [] };
let proxyRouteEditingId = '';
let proxyRouteDraftTargets = [];
let proxyRouteSelectedIds = new Set();
let proxyRouteProviderModels = [];
let proxyRouteProviderSearch = '';
let proxyRouteSelectedProviderId = '';
let proxyRouteSelectedModelId = '';
let proxyRouteBackupProviderSearch = '';
let proxyRouteBackupSelectedProviderId = '';
let proxyRouteBackupSelectedModelId = '';
let proxyRouteBackupPickerOpen = false;
// 弹窗内多选状态：Map<providerId, Set<modelId>>，编辑单模型时退化为空
let proxyRoutePickedModels = new Map();
let proxyRouteCustomNameTouched = false;

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
    id: String(route.id || '').trim(),
    displayName: String(route.id || '').trim(),
    idFromRenameRule: route.idFromRenameRule === true || route.id_from_rename_rule === true,
    enabled: route.enabled !== false,
    exposedFormats: ['openai', 'anthropic'],
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
  return {
    version: Number(store.version) || 1,
    defaultModelId: '',
    routes,
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

function proxyRouteDefaultUnlockForTarget(providerId, apiFormat = '') {
  const fmt = normalizeProxyRouteFormat(apiFormat);
  if (fmt === 'anthropic') {
    return proxyRouteProviderUnlockEnabled(providerId, 'claudeCode') ? 'claudeCode' : '';
  }
  if (fmt === 'openai') {
    return proxyRouteProviderUnlockEnabled(providerId, 'codex') ? 'codex' : '';
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
  const nextUnlock = proxyRouteDefaultUnlockForTarget(out.providerId, out.apiFormat);
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
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isBuiltinProvider(p));
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
  // 故意不注入「AnyBridge 本地」供应商:本地代理 tab 自己加自己会形成死循环
  // (本地代理路由表里的模型本来就在本地,不能再"从本地挑模型加到本地")。
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

async function loadProxyRoutes() {
  if (!invoke) return;
  try {
    const store = await invoke('load_proxy_routes');
    proxyRoutesStore = normalizeProxyRoutesStore(store);
    renderProxyRoutes();
    if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
    if (typeof syncLocalProxyProvider === 'function') syncLocalProxyProvider();
    if (typeof renderProviders === 'function') renderProviders();
  } catch (e) {
    addLog('err', '加载本地代理模型列表失败: ' + e);
  }
}

async function saveProxyRoutes(options = {}) {
  if (!invoke) {
    const message = '当前环境缺少 Tauri invoke，无法保存本地代理模型列表';
    addLog('err', message);
    showCustomAlert(message, '保存失败', 'error');
    return false;
  }
  try {
    proxyRoutesStore = normalizeProxyRoutesStore(proxyRoutesStore);
    await invoke('save_proxy_routes', { store: proxyRoutesStore });
    renderProxyRoutes();
    if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
    if (!options.silent) {
      addLog('ok', `本地代理模型列表已保存: ${proxyRoutesStore.routes.length} 个模型`);
      showBottomToast('本地代理模型列表已保存', 'success');
    }
    return true;
  } catch (e) {
    addLog('err', '保存本地代理模型列表失败: ' + e);
    showCustomAlert(String(e), '保存失败', 'error');
    return false;
  }
}

async function toggleProxyRouteEnabled(routeId, checked) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  const previous = cloneProxyRoutesStore();
  route.enabled = checked === true;
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(route.enabled ? '已启用模型' : '已停用模型', 'success');
}

async function toggleProxyRouteThirdPartyVision(routeId, checked) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  const previous = cloneProxyRoutesStore();
  route.enhancement = route.enhancement && typeof route.enhancement === 'object' ? route.enhancement : {};
  route.enhancement.thirdPartyVision = checked === true;
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(route.enhancement.thirdPartyVision ? '已启用第三方图片理解' : '已关闭第三方图片理解', 'success');
}

function cloneProxyRoutesStore(store = proxyRoutesStore) {
  return JSON.parse(JSON.stringify(store || { version: 1, defaultModelId: '', routes: [] }));
}

async function deleteProxyRoute(routeId) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  const previous = cloneProxyRoutesStore();
  proxyRoutesStore.routes = proxyRoutesStore.routes.filter(item => item.id !== routeId);
  proxyRouteSelectedIds.delete(routeId);
  proxyRoutesStore.defaultModelId = '';
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast('已删除模型', 'success');
}

function pruneProxyRouteSelection() {
  const valid = new Set((proxyRoutesStore.routes || []).map(route => route.id));
  proxyRouteSelectedIds.forEach(id => {
    if (!valid.has(id)) proxyRouteSelectedIds.delete(id);
  });
}

function visibleProxyRouteIds() {
  return Array.from(document.querySelectorAll('#proxyRoutesTableBody tr[data-proxy-route-id]'))
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.proxyRouteId)
    .filter(Boolean);
}

function syncProxyRouteSelectionState() {
  pruneProxyRouteSelection();
  const selected = proxyRouteSelectedIds.size;
  const deleteBtn = document.getElementById('proxyRoutesDeleteSelectedBtn');
  if (deleteBtn) {
    deleteBtn.disabled = selected === 0;
    const label = deleteBtn.querySelector('.proxy-routes-delete-label');
    if (label) label.textContent = selected ? `删除选中 (${selected})` : '删除选中';
  }
  const visibleIds = visibleProxyRouteIds();
  const selectedVisible = visibleIds.filter(id => proxyRouteSelectedIds.has(id)).length;
  const selectAll = document.getElementById('proxyRoutesSelectAll');
  if (selectAll) {
    selectAll.disabled = visibleIds.length === 0;
    selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
  // 批量操作按钮
  const hasSelection = selected > 0;
  const selectVisibleBtn = document.getElementById('proxyRoutesSelectVisibleBtn');
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = visibleIds.length === 0;
    const allSelected = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectVisibleBtn.textContent = allSelected ? '取消选择' : '选择当前';
  }
  const enableBtn = document.getElementById('proxyRoutesBulkEnableBtn');
  if (enableBtn) enableBtn.disabled = !hasSelection;
  const disableBtn = document.getElementById('proxyRoutesBulkDisableBtn');
  if (disableBtn) disableBtn.disabled = !hasSelection;
  const visionBtn = document.getElementById('proxyRoutesBulkVisionBtn');
  if (visionBtn) visionBtn.disabled = !hasSelection;
  // 计数
  const countPill = document.getElementById('proxyRoutesBulkCount');
  if (countPill) {
    const total = proxyRoutesStore.routes?.length || 0;
    countPill.textContent = selected > 0 ? `已选 ${selected} / 共 ${total} 个` : `共 ${total} 个`;
  }
}

function toggleProxyRouteSelection(routeId, checked) {
  if (!routeId) return;
  if (checked) proxyRouteSelectedIds.add(routeId);
  else proxyRouteSelectedIds.delete(routeId);
  const row = Array.from(document.querySelectorAll('#proxyRoutesTableBody tr[data-proxy-route-id]'))
    .find(item => item.dataset.proxyRouteId === routeId);
  if (row) row.classList.toggle('is-selected', checked);
  syncProxyRouteSelectionState();
}

function toggleProxyRoutesSelectAll(checked) {
  const ids = visibleProxyRouteIds();
  ids.forEach(id => {
    if (checked) proxyRouteSelectedIds.add(id);
    else proxyRouteSelectedIds.delete(id);
  });
  renderProxyRoutes();
}

async function deleteSelectedProxyRoutes() {
  pruneProxyRouteSelection();
  if (!proxyRouteSelectedIds.size) return;
  const previous = cloneProxyRoutesStore();
  const removed = new Set(proxyRouteSelectedIds);
  proxyRoutesStore.routes = (proxyRoutesStore.routes || []).filter(route => !removed.has(route.id));
  proxyRouteSelectedIds.clear();
  proxyRoutesStore.defaultModelId = '';
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(`已删除 ${removed.size} 个模型`, 'success');
}

function toggleVisibleProxyRouteSelection() {
  const visible = visibleProxyRouteIds();
  if (!visible.length) return;
  const allSelected = visible.every(id => proxyRouteSelectedIds.has(id));
  visible.forEach(id => {
    if (allSelected) proxyRouteSelectedIds.delete(id);
    else proxyRouteSelectedIds.add(id);
  });
  renderProxyRoutes();
}

async function batchSetSelectedProxyRoutesEnabled(enabled) {
  pruneProxyRouteSelection();
  if (!proxyRouteSelectedIds.size) return;
  const previous = cloneProxyRoutesStore();
  const targets = (proxyRoutesStore.routes || []).filter(r => proxyRouteSelectedIds.has(r.id));
  targets.forEach(r => { r.enabled = enabled === true; });
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(`已${enabled ? '启用' : '停用'} ${targets.length} 个模型`, 'success');
}

async function batchSetSelectedProxyRoutesThirdPartyVision(enabled) {
  pruneProxyRouteSelection();
  if (!proxyRouteSelectedIds.size) return;
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (enabled && !hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置第三方图片理解模型。', '无法启用', 'warn');
    return;
  }
  const previous = cloneProxyRoutesStore();
  const targets = (proxyRoutesStore.routes || []).filter(r => proxyRouteSelectedIds.has(r.id));
  targets.forEach(r => {
    r.enhancement = r.enhancement && typeof r.enhancement === 'object' ? r.enhancement : {};
    r.enhancement.thirdPartyVision = enabled === true;
  });
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(`已${enabled ? '启用' : '关闭'} ${targets.length} 个模型的第三方图片理解`, 'success');
}

function proxyRouteBadges(route) {
  const caps = [];
  if (route.capabilities?.stream) caps.push('流式');
  if (route.capabilities?.tools) caps.push('工具');
  if (route.capabilities?.vision) caps.push('图片');
  if (route.capabilities?.reasoning) caps.push('推理');
  return caps.length
    ? caps.map(label => `<span class="proxy-route-badge">${proxyRouteEsc(label)}</span>`).join('')
    : '<span class="proxy-route-muted">未确认</span>';
}

function renderProxyRoutes() {
  proxyRoutesStore = normalizeProxyRoutesStore(proxyRoutesStore);
  const body = document.getElementById('proxyRoutesTableBody');
  if (!body) return;
  const card = document.querySelector('.proxy-routes-card');
  const tableWrap = document.querySelector('.proxy-routes-table-wrap');
  const query = (document.getElementById('proxyRoutesSearch')?.value || '').trim().toLowerCase();
  const routes = proxyRoutesStore.routes.filter(route => {
    const renderedId = proxyRouteRenderedId(route);
    const hay = [
      route.id,
      renderedId,
      route.source,
      ...(route.targets || []).flatMap(t => [t.providerId, proxyRouteProviderName(t.providerId), t.model, t.apiFormat, t.unlock, proxyRouteTargetRouteLabel(t)])
    ].join(' ').toLowerCase();
    return !query || hay.includes(query);
  });
  pruneProxyRouteSelection();
  const enabledCount = proxyRoutesStore.routes.filter(route => route.enabled !== false).length;
  setText('proxyRoutesTotal', String(proxyRoutesStore.routes.length));
  setText('proxyRoutesEnabled', String(enabledCount));
  setText('proxy-page-route-total', String(proxyRoutesStore.routes.length));
  setText('proxy-page-route-enabled', String(enabledCount));
  if (card) card.classList.toggle('is-empty-store', proxyRoutesStore.routes.length === 0);

  if (!routes.length) {
    if (tableWrap) tableWrap.classList.add('is-empty');
    const isFiltered = proxyRoutesStore.routes.length > 0;
    body.innerHTML = `<tr class="proxy-routes-empty-row"><td colspan="7">
      <div class="proxy-routes-empty-state">
        <div class="proxy-routes-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="9" x2="15" y2="9" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="13" y2="17" />
          </svg>
        </div>
        <div class="proxy-routes-empty-title">${isFiltered ? '没有匹配的模型' : '尚未配置本地代理模型'}</div>
        <div class="proxy-routes-empty-subtitle">${isFiltered ? '换个关键词再试。' : '从供应商模型中添加到本地代理模型列表。'}</div>
        ${isFiltered ? '' : '<button type="button" class="btn-primary proxy-routes-empty-action" onclick="openProxyRouteEditor()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>添加模型</button>'}
      </div>
    </td></tr>`;
    syncProxyRouteSelectionState();
    return;
  }

  if (tableWrap) tableWrap.classList.remove('is-empty');
  body.innerHTML = routes.map(route => {
    const targetText = route.targets?.length
      ? route.targets.map((target, idx) => `<div class="proxy-route-target-line"><span>${idx + 1}</span>${proxyRouteEsc(proxyRouteTargetLabel(target))}</div>`).join('')
      : '<span class="proxy-route-muted">未配置目标</span>';
    const selected = proxyRouteSelectedIds.has(route.id);
    const thirdPartyVision = route.enhancement?.thirdPartyVision === true;
    return `
      <tr data-proxy-route-id="${proxyRouteEsc(route.id)}" class="${selected ? 'is-selected' : ''}">
        <td class="proxy-route-select-cell model-map-select-cell" onclick="event.stopPropagation()">
          <label class="provider-select-check provider-select-check-table" title="选择此模型" onclick="event.stopPropagation()">
            <input type="checkbox" class="proxy-route-row-check" aria-label="选择 ${proxyRouteEsc(route.id)}" ${selected ? 'checked' : ''} onchange="toggleProxyRouteSelection('${proxyRouteEsc(route.id)}', this.checked)">
            <span></span>
          </label>
        </td>
        <td><code class="proxy-route-model-id">${proxyRouteEsc(proxyRouteRenderedId(route))}</code></td>
        <td>${targetText}</td>
        <td><div class="proxy-route-badges">${proxyRouteBadges(route)}</div></td>
        <td>
          <div class="model-map-actions proxy-route-row-actions">
            <button class="btn-icon model-map-action-btn" onclick="openProxyRouteEditor('${proxyRouteEsc(route.id)}')" title="编辑模型" aria-label="编辑模型">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" onclick="deleteProxyRoute('${proxyRouteEsc(route.id)}')" title="删除模型" aria-label="删除模型">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="proxy-route-toggle-cell model-map-toggle-cell">
          <label class="toggle-switch" title="${thirdPartyVision ? '已启用第三方图片理解' : '已关闭第三方图片理解'}">
            <input type="checkbox" ${thirdPartyVision ? 'checked' : ''} onchange="toggleProxyRouteThirdPartyVision('${proxyRouteEsc(route.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="proxy-route-enabled-cell model-map-toggle-cell">
          <label class="toggle-switch" title="${route.enabled ? '已启用' : '已禁用'}">
            <input type="checkbox" ${route.enabled ? 'checked' : ''} onchange="toggleProxyRouteEnabled('${proxyRouteEsc(route.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>`;
  }).join('');
  syncProxyRouteSelectionState();
}

async function openProxyRouteEditor(routeId = '') {
  proxyRouteEditingId = String(routeId || '').trim();
  const route = proxyRouteEditingId
    ? proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId)
    : null;
  if (proxyRouteEditingId && !route) {
    showCustomAlert(`模型不存在或已被删除: ${proxyRouteEditingId}`, '打开失败', 'error');
    proxyRouteEditingId = '';
    return;
  }
  const modal = document.getElementById('proxy-route-editor-modal');
  modal?.classList.toggle('is-editing', !!route);
  modal?.classList.toggle('is-adding', !route);
  const draft = route ? normalizeProxyRoute(route) : normalizeProxyRoute({
    id: '',
    displayName: '',
    enabled: true,
    exposedFormats: ['openai', 'anthropic'],
    capabilities: { stream: true, tools: true, vision: true, reasoning: true },
    targets: []
  });
  proxyRouteDraftTargets = draft.targets.length ? draft.targets : [normalizeProxyRouteTarget({})];
  const primaryTarget = proxyRouteDraftTargets[0] || normalizeProxyRouteTarget({});
  proxyRouteProviderSearch = '';
  proxyRouteSelectedProviderId = primaryTarget.providerId || '';
  proxyRouteSelectedModelId = primaryTarget.model || '';
  proxyRouteBackupProviderSearch = '';
  proxyRouteBackupSelectedProviderId = '';
  proxyRouteBackupSelectedModelId = '';
  proxyRouteBackupPickerOpen = false;
  // 编辑模式保持单选语义；新建模式清空多选桶
  proxyRoutePickedModels = new Map();
  if (!route && primaryTarget.providerId && primaryTarget.model) {
    const bucket = new Set();
    bucket.add(primaryTarget.model);
    proxyRoutePickedModels.set(primaryTarget.providerId, bucket);
  }
  proxyRouteCustomNameTouched = !!route;
  setText('proxyRouteEditorTitle', route ? '编辑模型' : '添加模型');
  setText('proxyRouteEditorSubtitle', route ? '默认同名转发，需要伪装或替换时再改实际模型。' : '从供应商模型中选择要暴露到本地代理的模型。');
  setText('proxyRouteEditorConfirmBtn', route ? '保存模型' : '添加到列表');
  updateProxyRouteEditorConfirmText();
  // 「按规则重写 ID」复选框:仅新建模式显示(编辑模式不参与);状态从 modelMapStore.proxyRouteRenameRule.enabled 同步
  const renameToggleWrap = document.getElementById('proxyRouteEditorRenameToggle');
  const renameApplyInput = document.getElementById('proxyRouteEditorRenameApply');
  if (renameToggleWrap) renameToggleWrap.style.display = route ? 'none' : '';
  if (renameApplyInput) {
    const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || {};
    renameApplyInput.checked = rule.enabled !== false;
  }
  document.getElementById('proxyRouteIdInput').value = draft.id;
  document.getElementById('proxyRouteIdInput').disabled = false;
  document.getElementById('proxyRouteIdInput').oninput = () => {
    proxyRouteCustomNameTouched = true;
    syncProxyRouteEditorConfirmState();
  };
  document.getElementById('proxyRouteCapStreamInput').checked = draft.capabilities.stream !== false;
  document.getElementById('proxyRouteCapToolsInput').checked = draft.capabilities.tools !== false;
  document.getElementById('proxyRouteCapVisionInput').checked = draft.capabilities.vision !== false;
  document.getElementById('proxyRouteCapReasoningInput').checked = draft.capabilities.reasoning !== false;
  document.getElementById('proxyRouteRetryInput').checked = draft.enhancement.retry !== false;
  document.getElementById('proxyRouteAutoRoutingInput').checked = draft.enhancement.autoRouting !== false;
  document.getElementById('proxyRoutePreserveExtraParamsInput').checked = draft.enhancement.preserveExtraParams === true;
  document.getElementById('proxyRouteRawProviderErrorsInput').checked = draft.enhancement.rawProviderErrors !== false;
  const searchInput = document.getElementById('proxyRouteProviderSearch');
  if (searchInput) searchInput.value = '';
  const backupSearchInput = document.getElementById('proxyRouteBackupProviderSearch');
  if (backupSearchInput) backupSearchInput.value = '';
  if (!route) {
    try {
      await loadProxyRouteProviderModels();
    } catch (e) {
      proxyRouteProviderModels = [];
      addLog('err', '加载供应商模型列表失败: ' + e);
    }
    if (!proxyRouteSelectedProviderId && proxyRouteProviderModels.length) {
      const firstWithModels = proxyRouteProviderModels.find(provider => Array.isArray(provider.models) && provider.models.length);
      proxyRouteSelectedProviderId = (firstWithModels || proxyRouteProviderModels[0]).providerId;
    }
    renderProxyRouteProviderPicker();
  } else {
    try {
      await loadProxyRouteProviderModels();
    } catch (e) {
      proxyRouteProviderModels = [];
      addLog('err', '加载供应商模型列表失败: ' + e);
    }
    proxyRouteBackupSelectedProviderId = proxyRouteSelectedProviderId || proxyRouteProviderModels[0]?.providerId || '';
    renderProxyRoutePrimaryTargetEditor();
    renderProxyRouteTargetsEditor();
    renderProxyRouteBackupPicker();
  }
  const advanced = document.querySelector('#proxy-route-editor-modal .proxy-route-advanced');
  if (advanced) advanced.open = false;
  syncProxyRouteEditorAdvancedVisibility();
  modal?.classList.add('active');
}

function closeProxyRouteEditor() {
  document.getElementById('proxy-route-editor-modal')?.classList.remove('active');
}

/** 添加模型弹窗里的「按规则重写 ID」开关:同步到全局规则(两个弹窗共享同一个 enabled)并立即持久化。*/
async function onProxyRouteEditorRenameApplyChange() {
  const input = document.getElementById('proxyRouteEditorRenameApply');
  if (!input || !modelMapStore) return;
  if (!modelMapStore.proxyRouteRenameRule || typeof modelMapStore.proxyRouteRenameRule !== 'object') {
    modelMapStore.proxyRouteRenameRule = { enabled: true, mode: '', prefix: '', suffix: '', template: '' };
  }
  modelMapStore.proxyRouteRenameRule.enabled = !!input.checked;
  if (typeof persistModelMap === 'function') {
    const ok = await persistModelMap();
    if (!ok) {
      addLog('err', '保存规则状态失败');
      return;
    }
  }
  // 同步刷新:列表渲染会读 enabled
  renderProxyRoutes();
}

function providerOptions(selectedId) {
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isBuiltinProvider(p));
  return [
    '<option value="">选择供应商</option>',
    ...providers.map(p => `<option value="${proxyRouteEsc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${proxyRouteEsc(p.name || p.id)}</option>`)
  ].join('');
}

function renderProxyRoutePrimaryTargetEditor() {
  const target = proxyRouteDraftTargets[0] || normalizeProxyRouteTarget({});
  const providerInput = document.getElementById('proxyRoutePrimaryProviderInput');
  const modelInput = document.getElementById('proxyRoutePrimaryModelInput');
  if (providerInput) providerInput.innerHTML = providerOptions(target.providerId);
  if (modelInput) modelInput.value = target.model || '';
  syncProxyRouteFormatSeg(normalizeProxyRouteFormat(target.apiFormat));
}

function syncProxyRouteFormatSeg(value) {
  const container = document.getElementById('proxyRoutePrimaryFormatInput');
  if (!container) return;
  const normalized = normalizeProxyRouteFormat(value);
  container.querySelectorAll('.proxy-route-format-seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === normalized);
  });
}

function onProxyRouteProviderSearch() {
  proxyRouteProviderSearch = document.getElementById('proxyRouteProviderSearch')?.value || '';
  renderProxyRouteProviderPicker();
}

function syncProxyRouteEditorConfirmState() {
  const btn = document.getElementById('proxyRouteEditorConfirmBtn');
  if (!btn) return;
  if (proxyRouteEditingId) {
    const id = String(document.getElementById('proxyRouteIdInput')?.value || '').trim();
    const hasTarget = proxyRouteDraftTargets
      .map(normalizeProxyRouteTarget)
      .some(target => target.providerId && target.model);
    btn.disabled = !id || !hasTarget;
    return;
  }
  // 新建模式：只要勾选了任意模型即可保存
  btn.disabled = totalPickedModelCount() === 0;
}

function updateProxyRouteEditorConfirmText() {
  if (proxyRouteEditingId) return;
  const n = totalPickedModelCount();
  setText('proxyRouteEditorConfirmBtn', n > 1 ? `添加 ${n} 个到列表` : '添加到列表');
}

function totalPickedModelCount() {
  let n = 0;
  proxyRoutePickedModels.forEach(set => { n += set.size; });
  return n;
}

function currentProxyRouteProviderModels() {
  const provider = proxyRouteProviderEntry(proxyRouteSelectedProviderId);
  if (!provider || !Array.isArray(provider.models)) return [];
  return provider.models
    .map(model => String(model?.id || '').trim())
    .filter(Boolean);
}

function currentProxyRouteProviderPickedCount() {
  const modelIds = new Set(currentProxyRouteProviderModels());
  const picked = proxyRoutePickedModels.get(proxyRouteSelectedProviderId);
  if (!picked || !modelIds.size) return 0;
  let count = 0;
  picked.forEach(modelId => {
    if (modelIds.has(modelId)) count++;
  });
  return count;
}

function syncProxyRouteBulkSelectionState() {
  const modelIds = currentProxyRouteProviderModels();
  const pickedCount = currentProxyRouteProviderPickedCount();
  const selectAllBtn = document.getElementById('proxyRouteSelectAllBtn');
  const selectNoneBtn = document.getElementById('proxyRouteSelectNoneBtn');
  if (selectAllBtn) selectAllBtn.disabled = !!proxyRouteEditingId || !modelIds.length || pickedCount === modelIds.length;
  if (selectNoneBtn) selectNoneBtn.disabled = !!proxyRouteEditingId || !modelIds.length || pickedCount === 0;
}

function setCurrentProxyRouteProviderModelsPicked(checked) {
  if (proxyRouteEditingId) return;
  const provider = proxyRouteProviderEntry(proxyRouteSelectedProviderId);
  const modelIds = currentProxyRouteProviderModels();
  if (!provider || !modelIds.length) return;

  if (checked) {
    proxyRoutePickedModels.set(provider.providerId, new Set(modelIds));
  } else {
    proxyRoutePickedModels.delete(provider.providerId);
  }
  const total = totalPickedModelCount();
  proxyRouteSelectedModelId = total === 1
    ? Array.from(proxyRoutePickedModels.values()).find(set => set.size)?.values().next().value || ''
    : '';
  syncProxyRouteEditorAdvancedVisibility();
  renderProxyRouteProviderPicker();
  updateProxyRouteEditorConfirmText();
  syncProxyRouteEditorConfirmState();
}

function selectAllProxyRouteModels() {
  setCurrentProxyRouteProviderModelsPicked(true);
}

function selectNoProxyRouteModels() {
  setCurrentProxyRouteProviderModelsPicked(false);
}

function syncProxyRouteEditorAdvancedVisibility() {
  // 新建只负责从供应商模型列表添加；改名和上游目标调整统一走编辑表单。
  const hide = !proxyRouteEditingId;
  document.querySelectorAll('#proxy-route-editor-modal .proxy-route-advanced-single-only').forEach(el => {
    el.style.display = hide ? 'none' : '';
  });
}

function selectProxyRouteProvider(providerId) {
  proxyRouteSelectedProviderId = String(providerId || '').trim();
  const provider = proxyRouteProviderEntry(proxyRouteSelectedProviderId);
  const stillValid = provider?.models?.some(model => String(model?.id || '') === proxyRouteSelectedModelId);
  if (!stillValid) proxyRouteSelectedModelId = '';
  renderProxyRouteProviderPicker();
  updateProxyRouteEditorConfirmText();
}

function selectProxyRouteModel(providerId, modelId) {
  const provider = proxyRouteProviderEntry(providerId);
  const model = proxyRouteProviderModel(providerId, modelId);
  if (!provider || !model) return;
  // 编辑模式：单选替换，保持原有行为
  if (proxyRouteEditingId) {
    const previousModelId = proxyRouteSelectedModelId;
    const previousModel = proxyRouteProviderModel(proxyRouteSelectedProviderId, previousModelId);
    proxyRouteSelectedProviderId = providerId;
    proxyRouteSelectedModelId = modelId;
    const target = normalizeProxyRouteTarget({
      providerId,
      model: model.id,
      apiFormat: '',
    });
    proxyRouteDraftTargets[0] = proxyRouteTargetWithDefaultUnlock(target);
    const idInput = document.getElementById('proxyRouteIdInput');
    const currentId = String(idInput?.value || '').trim();
    const previousName = String(previousModel?.name || previousModelId || '').trim();
    if (idInput && !idInput.disabled && (!proxyRouteCustomNameTouched || !currentId || currentId === previousModelId || currentId === previousName)) {
      idInput.value = model.id;
    }
    if (document.getElementById('proxyRouteCapToolsInput')) document.getElementById('proxyRouteCapToolsInput').checked = model.supportsToolCall === true;
    if (document.getElementById('proxyRouteCapVisionInput')) document.getElementById('proxyRouteCapVisionInput').checked = model.supportsImages === true;
    if (document.getElementById('proxyRouteCapReasoningInput')) document.getElementById('proxyRouteCapReasoningInput').checked = model.supportsReasoning === true;
    renderProxyRoutePrimaryTargetEditor();
    renderProxyRouteTargetsEditor();
    renderProxyRouteBackupPicker();
  } else {
    // 新建模式：多选切换
    proxyRouteSelectedProviderId = providerId;
    let bucket = proxyRoutePickedModels.get(providerId);
    if (!bucket) {
      bucket = new Set();
      proxyRoutePickedModels.set(providerId, bucket);
    }
    if (bucket.has(modelId)) {
      bucket.delete(modelId);
      if (!bucket.size) proxyRoutePickedModels.delete(providerId);
    } else {
      bucket.add(modelId);
    }
    const total = totalPickedModelCount();
    proxyRouteSelectedModelId = total === 1 ? modelId : '';
  }
  syncProxyRouteEditorAdvancedVisibility();
  renderProxyRouteProviderPicker();
  if (proxyRouteEditingId) renderProxyRouteTargetsEditor();
  updateProxyRouteEditorConfirmText();
  syncProxyRouteEditorConfirmState();
}

function renderProxyRouteProviderPicker() {
  const providerList = document.getElementById('proxyRouteProviderList');
  const modelList = document.getElementById('proxyRouteModelList');
  const title = document.getElementById('proxyRouteModelProviderTitle');
  const sub = document.getElementById('proxyRouteModelProviderSub');
  if (!providerList || !modelList) return;

  const providers = proxyRouteVisibleProviders();
  if (!providers.length) {
    providerList.innerHTML = `<div class="proxy-route-picker-empty">${proxyRouteProviderModels.length ? '没有匹配的供应商' : '暂无可用供应商'}</div>`;
  } else {
    providerList.innerHTML = providers.map(provider => {
      const active = provider.providerId === proxyRouteSelectedProviderId;
      const isLP = isLocalProxyProviderEntry(provider);
      return `
        <button type="button" class="proxy-route-provider-item ${active ? 'active' : ''} ${isLP ? 'is-local-proxy' : ''}" onclick="selectProxyRouteProvider('${proxyRouteEsc(provider.providerId)}')">
          <span class="proxy-route-provider-icon">${proxyRouteEsc(proxyRouteProviderInitial(provider.providerName))}</span>
          <span class="proxy-route-provider-name">${proxyRouteEsc(provider.providerName || provider.providerId)}${isLP ? '<span class="proxy-route-prov-badge">本地</span>' : ''}</span>
          <span class="proxy-route-provider-count">${Array.isArray(provider.models) ? provider.models.length : 0}</span>
        </button>
      `;
    }).join('');
  }

  const selectedProvider = proxyRouteProviderEntry(proxyRouteSelectedProviderId);
  if (!selectedProvider) {
    if (title) title.textContent = '请选择供应商';
    if (sub) sub.textContent = '右侧会展示该供应商的模型';
    modelList.innerHTML = '<div class="proxy-route-picker-empty">先从左侧选择供应商</div>';
    syncProxyRouteBulkSelectionState();
    syncProxyRouteEditorConfirmState();
    return;
  }

  const models = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const pickedCount = currentProxyRouteProviderPickedCount();
  if (title) title.textContent = selectedProvider.providerName || selectedProvider.providerId;
  if (sub) sub.textContent = `共 ${models.length} 个模型，当前已选 ${pickedCount} 个`;
  if (!models.length) {
    modelList.innerHTML = '<div class="proxy-route-picker-empty">该供应商暂无模型</div>';
    syncProxyRouteBulkSelectionState();
    syncProxyRouteEditorConfirmState();
    return;
  }
  const bucket = proxyRoutePickedModels.get(selectedProvider.providerId) || new Set();
  modelList.innerHTML = models.map(model => {
    const id = String(model?.id || '').trim();
    const isMulti = !proxyRouteEditingId;
    const active = isMulti
      ? bucket.has(id)
      : (selectedProvider.providerId === proxyRouteSelectedProviderId && id === proxyRouteSelectedModelId);
    return `
      <button type="button" class="proxy-route-model-item ${active ? 'active' : ''}" onclick="selectProxyRouteModel('${proxyRouteEsc(selectedProvider.providerId)}', '${proxyRouteEsc(id)}')">
        <span class="proxy-route-model-check">${active ? '&#10003;' : ''}</span>
        ${proxyRouteModelIcon(id)}
        <span class="proxy-route-model-name">${proxyRouteEsc(model?.name || id)}</span>
      </button>
    `;
  }).join('');
  syncProxyRouteBulkSelectionState();
  syncProxyRouteEditorConfirmState();
}

function proxyRouteFormatLabel(value) {
  const fmt = normalizeProxyRouteFormat(value);
  if (fmt === 'anthropic') return 'Claude';
  if (fmt === 'openai') return 'OpenAI';
  if (fmt === 'gemini') return 'Gemini';
  return '自动';
}

function proxyRouteTargetRouteLabel(target) {
  const unlock = normalizeProxyRouteUnlock(target?.unlock);
  if (unlock === 'codex') return 'Codex 解锁';
  if (unlock === 'claudeCode') return 'Claude Code 解锁';
  return proxyRouteFormatLabel(target?.apiFormat);
}

function proxyRouteTargetCard(target, idx) {
  const isPrimary = idx === 0;
  const provider = proxyRouteProviderName(target.providerId);
  const model = target.model || '未填写模型';
  const format = proxyRouteTargetRouteLabel(target);
  return `
    <div class="proxy-route-chain-item ${isPrimary ? 'is-primary' : ''}">
      <div class="proxy-route-chain-index">${isPrimary ? '主' : idx}</div>
      <div class="proxy-route-chain-main">
        <strong>${proxyRouteEsc(provider)} / ${proxyRouteEsc(model)}</strong>
        <span>${proxyRouteEsc(format)}${isPrimary ? ' · 当前模型' : ' · 备用模型'}</span>
      </div>
      <div class="proxy-route-chain-actions">
        ${isPrimary ? '' : `
          <button type="button" class="btn-icon model-map-action-btn" onclick="moveProxyRouteTarget(${idx}, -1)" ${idx === 1 ? 'disabled' : ''} title="上移" aria-label="上移备用模型">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
          </button>
          <button type="button" class="btn-icon model-map-action-btn" onclick="moveProxyRouteTarget(${idx}, 1)" ${idx === proxyRouteDraftTargets.length - 1 ? 'disabled' : ''} title="下移" aria-label="下移备用模型">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <button type="button" class="btn-icon model-map-action-btn danger" onclick="removeProxyRouteTarget(${idx})" title="移除" aria-label="移除备用模型">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </button>
        `}
      </div>
    </div>
  `;
}

function renderProxyRouteTargetsEditor() {
  const wrap = document.getElementById('proxyRouteTargetsEditor');
  if (!wrap) return;
  if (!proxyRouteDraftTargets.length) proxyRouteDraftTargets.push(normalizeProxyRouteTarget({}));
  const backups = proxyRouteDraftTargets
    .map((target, idx) => ({ target, idx }))
    .filter(item => item.idx > 0);
  const primary = proxyRouteDraftTargets[0] || normalizeProxyRouteTarget({});
  wrap.innerHTML = `
    <div class="proxy-route-chain-list">
      ${proxyRouteTargetCard(primary, 0)}
      ${backups.length
        ? backups.map(({ target, idx }) => proxyRouteTargetCard(target, idx)).join('')
        : '<div class="proxy-route-backup-empty">还没有备用模型。添加后会在主模型失败时按顺序尝试。</div>'}
    </div>
  `;
  syncProxyRouteEditorConfirmState();
}

function openProxyRouteBackupPicker() {
  proxyRouteBackupPickerOpen = true;
  const providers = proxyRouteBackupVisibleProviders();
  if (!providers.some(provider => provider.providerId === proxyRouteBackupSelectedProviderId)) {
    proxyRouteBackupSelectedProviderId = providers[0]?.providerId || proxyRouteProviderModels[0]?.providerId || '';
  }
  if (!proxyRouteBackupSelectedModelId) {
    const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
    proxyRouteBackupSelectedModelId = provider?.models?.[0]?.id || '';
  }
  renderProxyRouteBackupPicker();
  document.getElementById('proxy-route-backup-picker-modal')?.classList.add('active');
}

function closeProxyRouteBackupPicker() {
  proxyRouteBackupPickerOpen = false;
  document.getElementById('proxy-route-backup-picker-modal')?.classList.remove('active');
}

function onProxyRouteBackupProviderSearch() {
  proxyRouteBackupProviderSearch = document.getElementById('proxyRouteBackupProviderSearch')?.value || '';
  const providers = proxyRouteBackupVisibleProviders();
  if (!providers.some(provider => provider.providerId === proxyRouteBackupSelectedProviderId)) {
    proxyRouteBackupSelectedProviderId = providers[0]?.providerId || '';
    proxyRouteBackupSelectedModelId = '';
  }
  renderProxyRouteBackupPicker();
}

function selectProxyRouteBackupProvider(providerId) {
  proxyRouteBackupSelectedProviderId = String(providerId || '').trim();
  const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
  if (!provider?.models?.some(model => model.id === proxyRouteBackupSelectedModelId)) {
    proxyRouteBackupSelectedModelId = provider?.models?.[0]?.id || '';
  }
  renderProxyRouteBackupPicker();
}

function selectProxyRouteBackupModel(providerId, modelId) {
  proxyRouteBackupSelectedProviderId = String(providerId || '').trim();
  proxyRouteBackupSelectedModelId = String(modelId || '').trim();
  renderProxyRouteBackupPicker();
}

function proxyRouteTargetKey(target) {
  return `${target.providerId || ''}\n${target.model || ''}`;
}

function addSelectedProxyRouteBackupModel() {
  const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
  const model = proxyRouteProviderModel(proxyRouteBackupSelectedProviderId, proxyRouteBackupSelectedModelId);
  if (!provider || !model) return;
  const target = proxyRouteTargetWithDefaultUnlock({ providerId: provider.providerId, model: model.id, apiFormat: '' });
  const existing = new Set(proxyRouteDraftTargets.map(t => proxyRouteTargetKey(normalizeProxyRouteTarget(t))));
  if (existing.has(proxyRouteTargetKey(target))) {
    showBottomToast('该模型已在当前链路中', 'warn');
    return;
  }
  proxyRouteDraftTargets.push(target);
  proxyRouteBackupSelectedModelId = '';
  renderProxyRouteTargetsEditor();
  closeProxyRouteBackupPicker();
}

function renderProxyRouteBackupPicker() {
  const providerList = document.getElementById('proxyRouteBackupProviderList');
  const modelList = document.getElementById('proxyRouteBackupModelList');
  const title = document.getElementById('proxyRouteBackupProviderTitle');
  const sub = document.getElementById('proxyRouteBackupProviderSub');
  const confirm = document.getElementById('proxyRouteAddBackupConfirmBtn');
  if (!providerList || !modelList) return;
  const providers = proxyRouteBackupVisibleProviders();
  if (!providers.some(provider => provider.providerId === proxyRouteBackupSelectedProviderId)) {
    proxyRouteBackupSelectedProviderId = providers[0]?.providerId || '';
  }
  if (!providers.length) {
    providerList.innerHTML = `<div class="proxy-route-picker-empty">${proxyRouteProviderModels.length ? '没有匹配的供应商或模型' : '暂无可用供应商'}</div>`;
  } else {
    providerList.innerHTML = providers.map(provider => {
      const active = provider.providerId === proxyRouteBackupSelectedProviderId;
      const isLP = isLocalProxyProviderEntry(provider);
      return `
        <button type="button" class="proxy-route-provider-item ${active ? 'active' : ''} ${isLP ? 'is-local-proxy' : ''}" onclick="selectProxyRouteBackupProvider('${proxyRouteEsc(provider.providerId)}')">
          <span class="proxy-route-provider-icon">${proxyRouteEsc(proxyRouteProviderInitial(provider.providerName))}</span>
          <span class="proxy-route-provider-name">${proxyRouteEsc(provider.providerName || provider.providerId)}${isLP ? '<span class="proxy-route-prov-badge">本地</span>' : ''}</span>
          <span class="proxy-route-provider-count">${Array.isArray(provider.models) ? provider.models.length : 0}</span>
        </button>
      `;
    }).join('');
  }
  const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
  if (!provider) {
    if (title) title.textContent = '请选择供应商';
    if (sub) sub.textContent = '右侧选择要加入备用链路的模型';
    modelList.innerHTML = '<div class="proxy-route-picker-empty">先从左侧选择供应商</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!models.some(model => model.id === proxyRouteBackupSelectedModelId)) {
    proxyRouteBackupSelectedModelId = models[0]?.id || '';
  }
  if (title) title.textContent = provider.providerName || provider.providerId;
  if (sub) sub.textContent = `共 ${models.length} 个模型，选择后添加到备用链路`;
  if (!models.length) {
    modelList.innerHTML = '<div class="proxy-route-picker-empty">该供应商暂无模型</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  const existing = new Set(proxyRouteDraftTargets.map(t => proxyRouteTargetKey(normalizeProxyRouteTarget(t))));
  modelList.innerHTML = models.map(model => {
    const id = String(model?.id || '').trim();
    const targetKey = proxyRouteTargetKey(normalizeProxyRouteTarget({ providerId: provider.providerId, model: id }));
    const used = existing.has(targetKey);
    const active = id === proxyRouteBackupSelectedModelId;
    return `
      <button type="button" class="proxy-route-model-item ${active ? 'active' : ''} ${used ? 'is-disabled' : ''}"
        ${used ? 'disabled' : ''} onclick="selectProxyRouteBackupModel('${proxyRouteEsc(provider.providerId)}', '${proxyRouteEsc(id)}')">
        <span class="proxy-route-model-check">${active || used ? '&#10003;' : ''}</span>
        ${proxyRouteModelIcon(id)}
        <span class="proxy-route-model-name">
          <strong>${proxyRouteEsc(model?.name || id)}</strong>
          <small>${used ? '已在当前链路中' : '添加为备用模型'}</small>
        </span>
      </button>
    `;
  }).join('');
  if (confirm) {
    const selectedKey = proxyRouteTargetKey(normalizeProxyRouteTarget({ providerId: provider.providerId, model: proxyRouteBackupSelectedModelId }));
    confirm.disabled = !proxyRouteBackupSelectedModelId || existing.has(selectedKey);
  }
}

function updateProxyRouteTarget(index, field, value) {
  if (!proxyRouteDraftTargets[index]) return;
  proxyRouteDraftTargets[index][field] = field === 'apiFormat' ? normalizeProxyRouteFormat(value) : String(value || '').trim();
  if (field === 'providerId' || field === 'apiFormat') {
    proxyRouteDraftTargets[index] = proxyRouteTargetWithDefaultUnlock(proxyRouteDraftTargets[index]);
  }
  // 手动输入模型名时，自动推断能力
  if (field === 'model' && index === 0) {
    const modelId = String(value || '').trim();
    const providerId = proxyRouteDraftTargets[0]?.providerId || '';
    const knownModel = proxyRouteProviderModel(providerId, modelId);
    if (knownModel) {
      if (document.getElementById('proxyRouteCapToolsInput')) document.getElementById('proxyRouteCapToolsInput').checked = knownModel.supportsToolCall === true;
      if (document.getElementById('proxyRouteCapVisionInput')) document.getElementById('proxyRouteCapVisionInput').checked = knownModel.supportsImages === true;
      if (document.getElementById('proxyRouteCapReasoningInput')) document.getElementById('proxyRouteCapReasoningInput').checked = knownModel.supportsReasoning === true;
    } else {
      const reasoningRe = /reason|thinking|r1|o\d|glm|claude|gpt-5/i;
      if (document.getElementById('proxyRouteCapReasoningInput')) document.getElementById('proxyRouteCapReasoningInput').checked = reasoningRe.test(modelId);
    }
  }
  if (index === 0) renderProxyRoutePrimaryTargetEditor();
  renderProxyRouteTargetsEditor();
  renderProxyRouteBackupPicker();
  syncProxyRouteEditorConfirmState();
}

function addProxyRouteTargetRow() {
  openProxyRouteBackupPicker();
}

function removeProxyRouteTarget(index) {
  proxyRouteDraftTargets.splice(index, 1);
  renderProxyRouteTargetsEditor();
  renderProxyRouteBackupPicker();
}

function moveProxyRouteTarget(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= proxyRouteDraftTargets.length) return;
  const item = proxyRouteDraftTargets[index];
  proxyRouteDraftTargets[index] = proxyRouteDraftTargets[next];
  proxyRouteDraftTargets[next] = item;
  renderProxyRouteTargetsEditor();
  renderProxyRouteBackupPicker();
}

async function saveProxyRouteEditor() {
  // 编辑模式：单条保存
  if (proxyRouteEditingId) {
    const id = String(document.getElementById('proxyRouteIdInput')?.value || '').trim();
    if (!id) {
      showCustomAlert('请填写模型 ID。', '保存失败', 'error');
      return;
    }
    if (proxyRoutesStore.routes.some(route => route.id === id && route.id !== proxyRouteEditingId)) {
      showCustomAlert(`模型已在列表中: ${id}`, '保存失败', 'error');
      return;
    }
    const exposedFormats = ['openai', 'anthropic'];
    const targets = proxyRouteDraftTargets.map(proxyRouteTargetWithDefaultUnlock).filter(t => t.providerId || t.model);
    if (!targets.length) {
      showCustomAlert('请填写上游目标。', '保存失败', 'error');
      return;
    }
    const invalid = targets.find(t => !t.providerId || !t.model);
    if (invalid) {
      showCustomAlert('每个上游目标都必须包含供应商和上游模型。API 格式可以留空自动识别。', '保存失败', 'error');
      return;
    }
    const existingRoute = proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId);
    const route = normalizeProxyRoute({
      id,
      displayName: id,
      idFromRenameRule: existingRoute?.idFromRenameRule === true,
      enabled: existingRoute?.enabled !== false,
      exposedFormats,
      source: proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId)?.source || 'manual',
      capabilities: {
        stream: document.getElementById('proxyRouteCapStreamInput')?.checked === true,
        tools: document.getElementById('proxyRouteCapToolsInput')?.checked === true,
        vision: document.getElementById('proxyRouteCapVisionInput')?.checked === true,
        reasoning: document.getElementById('proxyRouteCapReasoningInput')?.checked === true,
      },
      enhancement: {
        retry: document.getElementById('proxyRouteRetryInput')?.checked === true,
        autoRouting: document.getElementById('proxyRouteAutoRoutingInput')?.checked === true,
        thirdPartyVision: existingRoute?.enhancement?.thirdPartyVision === true,
        preserveExtraParams: document.getElementById('proxyRoutePreserveExtraParamsInput')?.checked === true,
        rawProviderErrors: document.getElementById('proxyRouteRawProviderErrorsInput')?.checked !== false,
      },
      targets,
    });
    const previous = cloneProxyRoutesStore();
    const btn = document.getElementById('proxyRouteEditorConfirmBtn');
    const originalText = btn?.textContent || '保存模型';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中...';
    }
    const idx = proxyRoutesStore.routes.findIndex(item => item.id === proxyRouteEditingId);
    if (idx >= 0) proxyRoutesStore.routes[idx] = route;
    else proxyRoutesStore.routes.push(route);
    proxyRoutesStore.defaultModelId = '';
    const ok = await saveProxyRoutes({ silent: true });
    if (!ok) {
      proxyRoutesStore = normalizeProxyRoutesStore(previous);
      renderProxyRoutes();
      if (btn) btn.textContent = originalText;
      syncProxyRouteEditorConfirmState();
      return;
    }
    closeProxyRouteEditor();
    showBottomToast('模型已保存', 'success');
    return;
  }

  // 新建模式：多选批量保存
  if (totalPickedModelCount() === 0) {
    showCustomAlert('请至少勾选一个模型。', '保存失败', 'error');
    return;
  }
  const exposedFormats = ['openai', 'anthropic'];
  const capabilities = {
    stream: document.getElementById('proxyRouteCapStreamInput')?.checked === true,
    tools: document.getElementById('proxyRouteCapToolsInput')?.checked === true,
    vision: document.getElementById('proxyRouteCapVisionInput')?.checked === true,
    reasoning: document.getElementById('proxyRouteCapReasoningInput')?.checked === true,
  };
  const enhancement = {
    retry: document.getElementById('proxyRouteRetryInput')?.checked === true,
    autoRouting: document.getElementById('proxyRouteAutoRoutingInput')?.checked === true,
    thirdPartyVision: false,
    preserveExtraParams: document.getElementById('proxyRoutePreserveExtraParamsInput')?.checked === true,
    rawProviderErrors: document.getElementById('proxyRouteRawProviderErrorsInput')?.checked !== false,
  };
  const previous = cloneProxyRoutesStore();
  let added = 0, skipped = 0;
  proxyRoutePickedModels.forEach((bucket, providerId) => {
    bucket.forEach(modelId => {
      const model = proxyRouteProviderModel(providerId, modelId);
      if (!model) { skipped++; return; }
      if (proxyRouteTargetAlreadyExists(providerId, modelId)) { skipped++; return; }
      const idInfo = proxyRouteIdForNewModel(providerId, modelId);
      if (!idInfo.id) { skipped++; return; }
      const route = normalizeProxyRoute({
        id: idInfo.id,
        displayName: idInfo.id,
        idFromRenameRule: idInfo.idFromRenameRule,
        enabled: true,
        exposedFormats,
        source: 'manual',
        capabilities: {
          stream: capabilities.stream !== false,
          tools: model.supportsToolCall === true || capabilities.tools === true,
          vision: model.supportsImages === true || capabilities.vision === true,
          reasoning: model.supportsReasoning === true || capabilities.reasoning === true,
        },
        enhancement,
        targets: [proxyRouteTargetWithDefaultUnlock({ providerId, model: modelId, apiFormat: '' })],
      });
      proxyRoutesStore.routes.push(route);
      added++;
    });
  });
  proxyRoutesStore.defaultModelId = '';
  if (!added) {
    closeProxyRouteEditor();
    if (skipped) showBottomToast('所选模型均已在列表中', 'warn');
    return;
  }
  const btn = document.getElementById('proxyRouteEditorConfirmBtn');
  const originalText = btn?.textContent || '添加到列表';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中...';
  }
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    if (btn) btn.textContent = originalText;
    syncProxyRouteEditorConfirmState();
    return;
  }
  closeProxyRouteEditor();
  showBottomToast(`已添加 ${added} 个模型${skipped ? `（跳过 ${skipped} 个重复）` : ''}`, 'success');
}

// ─── 批量重命名（模型 ID 命名规则）───
// 跟 Devin/Windsurf「显示名设置」思路一致:存规则(proxyRouteRenameRule),
// 老路由运行时套用规则。新增同名模型时如果原始 ID/别名已被占用,会把当前规则渲染成
// 一个最终 route.id 并标记 idFromRenameRule,避免同名供应商模型被跳过或后续二次拼接。
let proxyRouteRenameMode = 'simple'; // 'simple' | 'custom'
const PROXY_ROUTE_RENAME_TEMPLATE_VARS = ['prefix', 'model', 'provider', 'suffix'];

function renderProxyRouteRenameTemplate(tpl, vars) {
  // 多次扫描直到稳定,支持"占位符的值里再嵌占位符"的场景
  // (例如后缀填字面量 {provider},应在渲染时再展开成供应商名)
  let out = String(tpl == null ? '' : tpl);
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let prev = out;
    for (const k of PROXY_ROUTE_RENAME_TEMPLATE_VARS) {
      const re = new RegExp('\\{' + k + '\\}', 'g');
      out = out.replace(re, vars[k] == null ? '' : String(vars[k]));
    }
    if (out === prev) break;
  }
  return out;
}

/** 把 route.id 按命名规则渲染成"对外暴露的 ID"。规则为空或禁用时返回原始 id。*/
function proxyRouteRenderedId(route) {
  if (route?.idFromRenameRule === true || route?.id_from_rename_rule === true) return route.id;
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || null;
  if (!rule || typeof rule !== 'object') return route.id;
  // 规则被禁用 → 保持原始 ID,不拼接(用户明确要求"保持原有模型名")
  if (rule.enabled === false) return route.id;
  const prefix = String(rule.prefix || '');
  const suffix = String(rule.suffix || '');
  const mode = String(rule.mode || 'simple');
  const tpl = mode === 'custom' && rule.template ? String(rule.template) : proxyRouteRenameSimpleTemplate();
  if (!prefix && !suffix && (mode !== 'custom' || !rule.template)) return route.id;
  const providerId = proxyRouteRenameFirstProviderId(route);
  const providerName = providerId ? proxyRouteProviderName(providerId) : '';
  const rendered = renderProxyRouteRenameTemplate(tpl, { prefix, model: route.id, provider: providerName, suffix });
  return rendered || route.id;
}

function proxyRouteRenderedIdForModel(modelId, providerId) {
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || null;
  const rawId = String(modelId || '').trim();
  if (!rawId || !rule || typeof rule !== 'object' || rule.enabled === false) return rawId;
  const prefix = String(rule.prefix || '');
  const suffix = String(rule.suffix || '');
  const mode = String(rule.mode || 'simple');
  const tpl = mode === 'custom' && rule.template ? String(rule.template) : proxyRouteRenameSimpleTemplate();
  if (!prefix && !suffix && (mode !== 'custom' || !rule.template)) return rawId;
  const providerName = providerId ? proxyRouteProviderName(providerId) : '';
  const rendered = renderProxyRouteRenameTemplate(tpl, { prefix, model: rawId, provider: providerName, suffix });
  return String(rendered || rawId).trim();
}

function proxyRouteRenameRuleEnabled() {
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || null;
  return !rule || typeof rule !== 'object' || rule.enabled !== false;
}

function proxyRouteConflictFallbackId(modelId, providerId) {
  const rawId = String(modelId || '').trim();
  if (!rawId) return '';
  const providerName = providerId ? proxyRouteProviderName(providerId) : '';
  return renderProxyRouteRenameTemplate('{model}({provider})', {
    prefix: '',
    model: rawId,
    provider: providerName,
    suffix: '',
  }).trim();
}

function proxyRouteIdForNewModel(providerId, modelId) {
  const rawId = String(modelId || '').trim();
  if (!rawId) return { id: '', idFromRenameRule: false };
  if (!proxyRouteAliasExists(rawId)) return { id: rawId, idFromRenameRule: false };
  let renderedId = proxyRouteRenderedIdForModel(rawId, providerId);
  // 规则启用但尚未配置前缀/后缀时，同名模型默认用 model(provider) 落盘，避免直接跳过。
  if (renderedId === rawId && proxyRouteRenameRuleEnabled()) {
    renderedId = proxyRouteConflictFallbackId(rawId, providerId);
  }
  if (renderedId && renderedId !== rawId && !proxyRouteAliasExists(renderedId)) {
    return { id: renderedId, idFromRenameRule: true };
  }
  return { id: '', idFromRenameRule: false };
}

function proxyRouteRenameSimpleTemplate(prefix, suffix) {
  return `{prefix}{model}{suffix}`;
}

function currentProxyRouteRenameTemplate() {
  if (proxyRouteRenameMode === 'custom') {
    const tplInput = document.getElementById('proxyRouteRenameTemplate');
    return tplInput ? tplInput.value : '';
  }
  return proxyRouteRenameSimpleTemplate();
}

function proxyRouteRenameFirstProviderId(route) {
  if (!route || !Array.isArray(route.targets) || !route.targets.length) return '';
  const first = route.targets.find(t => t && (t.providerId || t.model));
  return String(first?.providerId || '').trim();
}

function computeProxyRouteRenames() {
  // 规则驱动(跟 Devin 显示名设置一样):不改 route.id,只算"如果套规则后的显示 ID"
  const routes = Array.isArray(proxyRoutesStore.routes) ? proxyRoutesStore.routes : [];
  const tpl = currentProxyRouteRenameTemplate();
  const prefixInput = document.getElementById('proxyRouteRenamePrefix');
  const suffixInput = document.getElementById('proxyRouteRenameSuffix');
  const prefix = prefixInput ? prefixInput.value : '';
  const suffix = suffixInput ? suffixInput.value : '';
  const list = routes.map((route) => {
    const providerId = proxyRouteRenameFirstProviderId(route);
    const providerName = providerId ? proxyRouteProviderName(providerId) : '';
    const newIdRaw = route.idFromRenameRule === true
      ? route.id
      : renderProxyRouteRenameTemplate(tpl, {
        prefix,
        model: route.id,
        provider: providerName,
        suffix,
      });
    const newId = String(newIdRaw == null ? '' : newIdRaw).trim();
    const unchanged = newId === route.id;
    // 检测渲染后 ID 重复(两条 route 套规则后变成同一个新 ID)
    return {
      oldId: route.id,
      newId,
      aliases: newId && newId !== route.id ? [route.id, newId] : [route.id],
      route,
      providerName,
      unchanged,
    };
  });
  // 重复检测:运行时同时接受原始 ID 和渲染后 ID，任一别名跨模型碰撞都必须阻止保存。
  const aliasOwners = new Map();
  list.forEach(item => {
    item.aliases.forEach(alias => {
      if (!alias) return;
      if (!aliasOwners.has(alias)) aliasOwners.set(alias, new Set());
      aliasOwners.get(alias).add(item.oldId);
    });
  });
  list.forEach(item => {
    item.duplicate = item.aliases.some(alias => alias && (aliasOwners.get(alias)?.size || 0) > 1);
  });
  return { list, tpl, prefix, suffix };
}

function renderProxyRouteRenamePreview() {
  const preview = document.getElementById('proxyRouteRenamePreview');
  const errorEl = document.getElementById('proxyRouteRenameError');
  const statsEl = document.getElementById('proxyRouteRenameStats');
  const saveBtn = document.getElementById('proxyRouteRenameSaveBtn');
  if (!preview) return;
  const { list } = computeProxyRouteRenames();
  const total = list.length;
  const changed = list.filter(i => !i.unchanged && i.newId);
  const unchanged = list.filter(i => i.unchanged).length;
  const duplicates = list.filter(i => i.duplicate);
  if (statsEl) {
    statsEl.textContent = total
      ? `共 ${total} 个 · 显示改名 ${changed.length} · 不变 ${unchanged}`
      : '暂无模型';
  }
  if (saveBtn) {
    saveBtn.disabled = duplicates.length > 0;
    saveBtn.title = duplicates.length
      ? '暴露模型 ID 存在冲突，需调整规则后才能保存'
      : changed.length
      ? `将保存规则,对外暴露 ${changed.length} 个改名后的 ID`
      : '规则无变化,保存即生效';
  }
  if (errorEl) {
    if (duplicates.length) {
      errorEl.style.display = '';
      errorEl.textContent = `有 ${duplicates.length} 个模型的原始 ID 或显示 ID 发生冲突。为避免客户端请求误路由，请调整规则后再保存。`;
    } else {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }
  }
  if (!total) {
    preview.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:6px 4px;">本地代理模型列表为空。先在「模型列表」里添加几个模型再批量命名。</div>`;
    return;
  }
  const rows = list.map((item) => {
    const oldHtml = `<span style="color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${proxyRouteEsc(item.oldId)}">${proxyRouteEsc(item.oldId)}</span>`;
    let newHtml;
    let rowStyle = '';
    let badge = '';
    if (item.duplicate) {
      rowStyle = 'background:rgba(220,80,80,0.10);border:1px solid rgba(220,80,80,0.4);';
      newHtml = `<span style="color:#c44;font-weight:700;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${proxyRouteEsc(item.newId)}">${proxyRouteEsc(item.newId)}</span>`;
      badge = '<span style="color:#c44;font-size:10px;margin-left:6px;">⚠ ID 重复</span>';
    } else if (item.unchanged) {
      rowStyle = 'opacity:0.55;';
      newHtml = `<span style="color:var(--text-muted);font-family:var(--font-mono);">(不变)</span>`;
    } else {
      newHtml = `<span style="color:var(--text-primary);font-weight:700;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${proxyRouteEsc(item.newId)}">${proxyRouteEsc(item.newId)}</span>`;
    }
    return `<div style="display:grid;grid-template-columns:minmax(140px,1.1fr) 16px minmax(180px,1.4fr) auto;gap:8px;align-items:center;line-height:1.5;min-width:0;padding:4px 6px;border-radius:6px;${rowStyle}">
      ${oldHtml}
      <span style="color:var(--text-muted);text-align:center;">→</span>
      ${newHtml}
      ${badge}
    </div>`;
  }).join('');
  preview.innerHTML = rows;
}

function openProxyRouteRenameModal() {
  const modal = document.getElementById('proxyRouteRenameModal');
  if (!modal) return;
  const prefixInput = document.getElementById('proxyRouteRenamePrefix');
  const suffixInput = document.getElementById('proxyRouteRenameSuffix');
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  const advanced = document.getElementById('proxyRouteRenameAdvanced');
  const enabledInput = document.getElementById('proxyRouteRenameEnabled');
  // 从持久化的规则回填(避免每次打开都得重新输入,导致规则叠加)
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || {};
  const savedMode = String(rule.mode || 'simple');
  const savedPrefix = String(rule.prefix || '');
  const savedSuffix = String(rule.suffix || '');
  const savedTpl = String(rule.template || '');
  if (prefixInput) prefixInput.value = savedPrefix;
  if (suffixInput) suffixInput.value = savedSuffix;
  if (tplInput) tplInput.value = savedTpl || proxyRouteRenameSimpleTemplate();
  if (enabledInput) enabledInput.checked = rule.enabled !== false;
  proxyRouteRenameMode = savedMode === 'custom' ? 'custom' : 'simple';
  if (advanced) advanced.open = proxyRouteRenameMode === 'custom';
  renderProxyRouteRenamePreview();
  modal.classList.add('is-open');
  setTimeout(() => {
    // 简单模式聚焦前缀;高级模式聚焦模板
    (proxyRouteRenameMode === 'custom' ? tplInput : prefixInput)?.focus();
  }, 30);
}

function closeProxyRouteRenameModal() {
  const modal = document.getElementById('proxyRouteRenameModal');
  if (modal) modal.classList.remove('is-open');
}

/** 命名规则弹窗里的「启用规则」开关:与添加模型弹窗共享同一个 enabled,onchange 立即持久化(同步到添加弹窗的复选框)。*/
async function onProxyRouteRenameEnabledChange() {
  const input = document.getElementById('proxyRouteRenameEnabled');
  if (!input || !modelMapStore) return;
  if (!modelMapStore.proxyRouteRenameRule || typeof modelMapStore.proxyRouteRenameRule !== 'object') {
    modelMapStore.proxyRouteRenameRule = { enabled: true, mode: '', prefix: '', suffix: '', template: '' };
  }
  modelMapStore.proxyRouteRenameRule.enabled = !!input.checked;
  // 同步到添加模型弹窗的复选框(下次打开时会再读,这里手动改 DOM 立即生效)
  const addInput = document.getElementById('proxyRouteEditorRenameApply');
  if (addInput) addInput.checked = !!input.checked;
  if (typeof persistModelMap === 'function') {
    const ok = await persistModelMap();
    if (!ok) addLog('err', '保存规则状态失败');
  }
  // 同步刷新模型列表
  renderProxyRoutes();
}

function onProxyRouteRenameInput() {
  // 简单模式:用户改了前缀/后缀 → 切回 simple 模式 + 同步模板字段
  proxyRouteRenameMode = 'simple';
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  if (tplInput) tplInput.value = proxyRouteRenameSimpleTemplate();
  const advanced = document.getElementById('proxyRouteRenameAdvanced');
  if (advanced) advanced.open = false;
  renderProxyRouteRenamePreview();
}

function onProxyRouteRenameTemplateInput() {
  // 高级模式:用户改模板 → 切到 custom 模式,前缀/后缀暂时失效
  proxyRouteRenameMode = 'custom';
  renderProxyRouteRenamePreview();
}

function onProxyRouteRenameAdvancedToggle() {
  const advanced = document.getElementById('proxyRouteRenameAdvanced');
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  if (advanced && advanced.open) {
    // 展开时把当前 effective 模板填入
    if (tplInput) tplInput.value = currentProxyRouteRenameTemplate();
    proxyRouteRenameMode = 'custom';
  } else if (advanced && !advanced.open && proxyRouteRenameMode === 'custom') {
    // 收起时切回 simple,同步一份默认模板到 input(避免下次展开拿到旧值)
    if (tplInput) tplInput.value = proxyRouteRenameSimpleTemplate();
    proxyRouteRenameMode = 'simple';
  }
  renderProxyRouteRenamePreview();
}

async function saveProxyRouteRenameFromModal() {
  const saveBtn = document.getElementById('proxyRouteRenameSaveBtn');
  if (saveBtn?.disabled) return;
  const prefixInput = document.getElementById('proxyRouteRenamePrefix');
  const suffixInput = document.getElementById('proxyRouteRenameSuffix');
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  const enabledInput = document.getElementById('proxyRouteRenameEnabled');
  const currentRule = {
    enabled: enabledInput ? !!enabledInput.checked : true,
    mode: proxyRouteRenameMode,
    prefix: prefixInput ? prefixInput.value : '',
    suffix: suffixInput ? suffixInput.value : '',
    template: tplInput ? tplInput.value : '',
  };
  // 只保存规则(不硬写 route.id,跟 Devin 显示名设置一样)
  // 改规则 = 改模板,旧模板立即失效,新模板立即生效,永远不叠加
  if (modelMapStore) {
    modelMapStore.proxyRouteRenameRule = currentRule;
    if (typeof persistModelMap === 'function') {
      const ok = await persistModelMap();
      if (!ok) {
        showCustomAlert('保存命名规则失败', '保存失败', 'error');
        return;
      }
    }
  }
  addLog('ok', '已保存本地代理模型命名规则');
  showBottomToast('命名规则已保存', 'success');
  closeProxyRouteRenameModal();
  // 刷新模型列表(渲染时套用规则显示改名后的 ID)
  renderProxyRoutes();
}
