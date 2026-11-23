// platforms/antigravity_add.js — Antigravity 添加模型独立页面流程
async function openAntigravityAddPage() {
  navigateTo('platform-antigravity-add');
  await initAntigravityAddPage();
}
globalThis.openAntigravityAddModal = openAntigravityAddPage;

async function initAntigravityAddPage() {
  try {
    antigravityProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    antigravityProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    antigravityProviderModels = antigravityProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    antigravityProviderModels.unshift(lp);
  }
  antigravityAddSearchKw = '';
  const searchInput = document.getElementById('antigravity-add-search');
  if (searchInput) searchInput.value = '';

  const sorted = platformAddVisibleProviders(antigravityProviderModels, '');
  const firstWithModels = sorted.find(p => p.models && p.models.length > 0) || sorted[0];
  antigravityAddSelectedProvider = firstWithModels ? firstWithModels.providerId : null;

  renderAntigravityAddProviderList();
  renderAntigravityAddModels();
  updateAntigravityAddConfirmButton();
}

function onAntigravityAddSearch() {
  const input = document.getElementById('antigravity-add-search');
  antigravityAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderAntigravityAddProviderList();
}

function renderAntigravityAddProviderList() {
  const list = document.getElementById('antigravity-add-provider-list');
  syncPlatformAddSortControl('antigravity');
  if (!list) return;
  if (!antigravityProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(antigravityProviderModels, antigravityAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = antigravityAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="AnyBridge 内置供应商"><span>内置</span><span>供应商</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectAntigravityAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectAntigravityAddProvider(providerId) {
  antigravityAddSelectedProvider = providerId;
  renderAntigravityAddProviderList();
  renderAntigravityAddModels();
  updateAntigravityAddConfirmButton();
}

function renderAntigravityAddModels() {
  const titleEl = document.getElementById('antigravity-add-models-title');
  const subEl = document.getElementById('antigravity-add-models-sub');
  const body = document.getElementById('antigravity-add-models-list-page');
  if (!body) return;

  if (!antigravityAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = antigravityProviderModels.find(p => p.providerId === antigravityAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要注入到 Antigravity 的模型`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  const agConfigs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const existingModels = new Set();
  agConfigs.forEach(c => {
    if (c.sourceProviderId === provider.providerId || c.sourceProviderName === provider.providerName || c.name === provider.providerName) {
      if (c.defaultModel) existingModels.add(c.defaultModel);
      if (Array.isArray(c.models)) c.models.forEach(m => existingModels.add(m));
    }
  });

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models);

  body.innerHTML = sortedModels.map((m) => {
    const exists = existingModels.has(m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}">
        <input type="checkbox" class="antigravity-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateAntigravityAddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateAntigravityAddConfirmButton() {
  const btn = document.getElementById('antigravity-add-confirm-page');
  if (!btn) return;
  const checked = document.querySelectorAll('.antigravity-add-model-check:checked');
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    label.textContent = checked.length > 0 ? ` 保存选择 (${checked.length})` : ' 保存选择';
  }
}

function antigravityAddSelectAll() {
  cbSetAddModelChecks('.antigravity-add-model-check', true, updateAntigravityAddConfirmButton);
}

function antigravityAddSelectNone() {
  cbSetAddModelChecks('.antigravity-add-model-check', false, updateAntigravityAddConfirmButton);
}

async function confirmAddAntigravityModelsPage() {
  const provider = antigravityProviderModels.find(p => p.providerId === antigravityAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }

  const checkedBoxes = document.querySelectorAll('.antigravity-add-model-check:checked');
  const checkedModelIds = Array.from(checkedBoxes).map(cb => cb.dataset.modelId).filter(Boolean);
  if (!checkedModelIds.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const btn = document.getElementById('antigravity-add-confirm-page');
  const label = btn ? btn.querySelector('.model-action-label') : null;
  const originalLabel = label ? label.innerHTML : ` 保存选择 (${checkedModelIds.length})`;
  if (btn) {
    btn.disabled = true;
    if (label) label.innerHTML = loadingHtml('保存中…');
  }

  try {
    const ok = await mutateProviderStore(store => {
      if (!Array.isArray(store.antigravityConfigs)) {
        store.antigravityConfigs = [];
      }
      checkedModelIds.forEach(modelId => {
        const entryId = `ag-${provider.providerId}-${modelId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const existing = store.antigravityConfigs.find(c => c.id === entryId || (c.sourceProviderId === provider.providerId && c.defaultModel === modelId));
        if (existing) {
          existing.enabled = true;
          existing.injectModels = true;
          existing.sourceProviderId = provider.providerId;
          existing.sourceProviderName = provider.providerName;
          // 清理历史静态连接快照，保证实时读取 sourceProviderId 对应主供应商
          delete existing.apiHost;
          delete existing.apiPath;
          delete existing.apiKey;
          delete existing.apiFormat;
        } else {
          store.antigravityConfigs.push({
            id: entryId,
            name: modelId,
            defaultModel: modelId,
            models: [modelId],
            contextWindow: Number(store.antigravityContextWindow) || 262144,
            enabled: true,
            injectModels: true,
            sourceProviderId: provider.providerId,
            sourceProviderName: provider.providerName,
          });
        }
      });
    });

    if (ok) {
      await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
      navigateTo('platform-antigravity');
      antigravityRefreshConsole({ silent: true });
    }
  } catch (err) {
    console.error('[antigravity-add] confirm add failed:', err);
    showCustomAlert('添加模型失败: ' + err, '添加异常', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      if (label) label.innerHTML = originalLabel;
    }
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openAntigravityAddPage = openAntigravityAddPage;
  g.openAntigravityAddModal = openAntigravityAddPage;
  g.initAntigravityAddPage = initAntigravityAddPage;
  g.onAntigravityAddSearch = onAntigravityAddSearch;
  g.renderAntigravityAddProviderList = renderAntigravityAddProviderList;
  g.selectAntigravityAddProvider = selectAntigravityAddProvider;
  g.renderAntigravityAddModels = renderAntigravityAddModels;
  g.updateAntigravityAddConfirmButton = updateAntigravityAddConfirmButton;
  g.antigravityAddSelectAll = antigravityAddSelectAll;
  g.antigravityAddSelectNone = antigravityAddSelectNone;
  g.confirmAddAntigravityModelsPage = confirmAddAntigravityModelsPage;
})(globalThis);
