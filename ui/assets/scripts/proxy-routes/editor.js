// proxy-routes/editor.js — 路由编辑器打开、供应商与模型选择器交互

async function openProxyRouteEditor(routeId = '') {
  // 打开弹窗前先确保列表已加载：没加载成功就改不了，早报错比让用户白选一轮强。
  if (!(await ensureProxyRoutesLoaded())) {
    proxyRouteEditingId = '';
    const reason = String(globalThis.proxyRoutesLoadError || '未知原因');
    showCustomAlert(`内置模型列表还没加载成功，暂时无法添加或编辑模型。请先点「模型列表」右上角的刷新重试。失败原因：${reason}`, '打开失败', 'error');
    return;
  }
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
    exposedFormats: ['openai', 'anthropic', 'gemini'],
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
  setText('proxyRouteEditorSubtitle', route ? '默认同名转发，需要伪装或替换时再改实际模型。' : '从供应商模型中选择要通过本地网关对外暴露的模型。');
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
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p));
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
  syncProxyRouteUnlockSeg(normalizeProxyRouteUnlock(target.unlock));
}

function syncProxyRouteFormatSeg(value) {
  const container = document.getElementById('proxyRoutePrimaryFormatInput');
  if (!container) return;
  const normalized = normalizeProxyRouteFormat(value);
  container.querySelectorAll('.proxy-route-format-seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === normalized);
  });
}

function syncProxyRouteUnlockSeg(value) {
  const container = document.getElementById('proxyRoutePrimaryUnlockInput');
  if (!container) return;
  const normalized = normalizeProxyRouteUnlock(value);
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
        <button type="button" class="proxy-route-provider-item ${active ? 'active' : ''} ${isLP ? 'is-local-proxy' : ''}" data-action="selectProxyRouteProvider" data-arg="${proxyRouteEsc(provider.providerId)}">
          <span class="proxy-route-provider-icon">${proxyRouteEsc(proxyRouteProviderInitial(provider.providerName))}</span>
          <span class="proxy-route-provider-name">${proxyRouteEsc(provider.providerName || provider.providerId)}${isLP ? '<span class="proxy-route-prov-badge">内置供应商</span>' : ''}</span>
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
      <button type="button" class="proxy-route-model-item ${active ? 'active' : ''}" data-action="selectProxyRouteModel" data-args="[&quot;${proxyRouteEsc(selectedProvider.providerId)}&quot;,&quot;${proxyRouteEsc(id)}&quot;]">
        <span class="proxy-route-model-check">${active ? '&#10003;' : ''}</span>
        ${proxyRouteModelIcon(id)}
        <span class="proxy-route-model-name">${proxyRouteEsc(model?.name || id)}</span>
      </button>
    `;
  }).join('');
  syncProxyRouteBulkSelectionState();
  syncProxyRouteEditorConfirmState();
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openProxyRouteEditor = openProxyRouteEditor;
  g.closeProxyRouteEditor = closeProxyRouteEditor;
  g.onProxyRouteEditorRenameApplyChange = onProxyRouteEditorRenameApplyChange;
  g.providerOptions = providerOptions;
  g.renderProxyRoutePrimaryTargetEditor = renderProxyRoutePrimaryTargetEditor;
  g.syncProxyRouteFormatSeg = syncProxyRouteFormatSeg;
  g.syncProxyRouteUnlockSeg = syncProxyRouteUnlockSeg;
  g.onProxyRouteProviderSearch = onProxyRouteProviderSearch;
  g.syncProxyRouteEditorConfirmState = syncProxyRouteEditorConfirmState;
  g.updateProxyRouteEditorConfirmText = updateProxyRouteEditorConfirmText;
  g.totalPickedModelCount = totalPickedModelCount;
  g.currentProxyRouteProviderModels = currentProxyRouteProviderModels;
  g.currentProxyRouteProviderPickedCount = currentProxyRouteProviderPickedCount;
  g.syncProxyRouteBulkSelectionState = syncProxyRouteBulkSelectionState;
  g.setCurrentProxyRouteProviderModelsPicked = setCurrentProxyRouteProviderModelsPicked;
  g.selectAllProxyRouteModels = selectAllProxyRouteModels;
  g.selectNoProxyRouteModels = selectNoProxyRouteModels;
  g.syncProxyRouteEditorAdvancedVisibility = syncProxyRouteEditorAdvancedVisibility;
  g.selectProxyRouteProvider = selectProxyRouteProvider;
  g.selectProxyRouteModel = selectProxyRouteModel;
  g.renderProxyRouteProviderPicker = renderProxyRouteProviderPicker;
})(globalThis);
