// platforms/shared_buddy_add.js — Buddy / ZCode 添加模型独立页共用流程工厂

function createBuddyAddHandlers({
  prefix,
  domPrefix,
  platformId,
  pageSlug,
  cssPrefix,
  extraCssPrefix = '',
  openModalName,
  closeModalName,
  providerChangeName,
  legacyConfirmName,
  confirmPageName,
  renderModelsFnName,
  saveModelsFnName,
  buildExistsPredicate,
}) {
  const modelsKey = `${domPrefix}Models`;
  const availableKey = `${domPrefix}AvailableModels`;
  const providerModelsKey = `${domPrefix}ProviderModels`;
  const addSelectedKey = `${domPrefix}AddSelectedProvider`;
  const addSearchKey = `${domPrefix}AddSearchKw`;
  const checkClassName = `${domPrefix}-add-model-check`;
  const checkSelector = `.${checkClassName}`;
  const selectActionName = `select${prefix}AddProvider`;
  const updateConfirmName = `update${prefix}AddConfirmButton`;
  const cls = (suffix) => (extraCssPrefix ? `${cssPrefix}-${suffix} ${extraCssPrefix}-${suffix}` : `${cssPrefix}-${suffix}`);

  const define = (name, fn) => {
    globalThis[name] = fn;
    if (typeof window !== 'undefined') window[name] = fn;
    return fn;
  };

  const renderProviderList = define(`render${prefix}AddProviderList`, () => {
    const list = document.getElementById(`${domPrefix}-add-provider-list`);
    syncPlatformAddSortControl(domPrefix);
    if (!list) return;
    const providers = globalThis[providerModelsKey] || [];
    if (!providers.length) {
      list.innerHTML = `<div class="${cls('add-prov-empty')}">暂无供应商，请先在「供应商」页添加</div>`;
      return;
    }
    const filtered = platformAddVisibleProviders(providers, globalThis[addSearchKey]);
    if (!filtered.length) {
      list.innerHTML = `<div class="${cls('add-prov-empty')}">没有匹配的供应商</div>`;
      return;
    }
    list.innerHTML = filtered.map((p) => {
      const initial = (p.providerName || '?').charAt(0).toUpperCase();
      const enabled = p.enabled !== false;
      const isActive = globalThis[addSelectedKey] === p.providerId;
      const isBuiltin = isBuiltinProxyEntry(p);
      const iconHtml = isBuiltin
        ? `<span class="${cls('add-prov-icon')} ${cssPrefix}-add-prov-icon-builtin" title="AnyBridge 内置供应商"><span>内置</span><span>供应商</span></span>`
        : `<span class="${cls('add-prov-icon')}">${platformEsc(initial)}</span>`;
      return `
      <div class="${cls('add-prov-item')} ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="${selectActionName}" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="${cls('add-prov-name')}">${platformEsc(p.providerName)}</span>
        <span class="${cls('add-prov-count')}">${p.models.length}</span>
      </div>
    `;
    }).join('');
  });

  const renderModels = define(`render${prefix}AddModels`, () => {
    const titleEl = document.getElementById(`${domPrefix}-add-models-title`);
    const subEl = document.getElementById(`${domPrefix}-add-models-sub`);
    const body = document.getElementById(`${domPrefix}-add-models-list-page`);
    if (!body) return;
    const selectedId = globalThis[addSelectedKey];
    if (!selectedId) {
      if (titleEl) titleEl.textContent = '请选择供应商';
      if (subEl) subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
      body.innerHTML = `<div class="${cls('add-models-empty')}">请从左侧选择一个供应商</div>`;
      return;
    }
    const providers = globalThis[providerModelsKey] || [];
    const provider = providers.find((p) => p.providerId === selectedId);
    if (!provider) {
      if (titleEl) titleEl.textContent = '供应商未找到';
      if (subEl) subEl.textContent = '';
      body.innerHTML = `<div class="${cls('add-models-empty')}">供应商未找到</div>`;
      return;
    }
    if (titleEl) titleEl.textContent = provider.providerName;
    if (subEl) subEl.textContent = `共 ${provider.models.length} 个模型，勾选要保留或添加的项`;
    if (!provider.models.length) {
      body.innerHTML = `<div class="${cls('add-models-empty')}">该供应商暂无模型</div>`;
      return;
    }

    const currentModels = globalThis[modelsKey] || [];
    const isExists = typeof buildExistsPredicate === 'function'
      ? buildExistsPredicate(provider, currentModels)
      : ((m) => currentModels.some((model) => model.id === m.id));

    const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
    const sortedModels = sortFn(provider.models);

    body.innerHTML = sortedModels.map((m) => {
      const exists = isExists(m);
      return `
      <label class="${cls('add-model-row')} ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="${checkClassName}" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="${updateConfirmName}">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
    }).join('');
  });

  const updateConfirmButton = define(updateConfirmName, () => {
    const btn = document.getElementById(`${domPrefix}-add-confirm-page`);
    if (!btn) return;
    const total = document.querySelectorAll(checkSelector).length;
    const checks = document.querySelectorAll(`${checkSelector}:checked`);
    btn.disabled = total === 0;
    cbSetButtonLabel(btn, ` 保存选择 (${checks.length})`);
  });

  const initPage = define(`init${prefix}AddPage`, async () => {
    try {
      globalThis[providerModelsKey] = await invoke('list_provider_models') || [];
    } catch (e) {
      globalThis[providerModelsKey] = [];
    }
    if (typeof localProxyProviderModelsEntry === 'function') {
      const lp = localProxyProviderModelsEntry();
      globalThis[providerModelsKey] = globalThis[providerModelsKey].filter((p) => !isLocalProxyProviderEntry(p));
      globalThis[providerModelsKey].unshift(lp);
    }
    globalThis[addSelectedKey] = null;
    globalThis[addSearchKey] = '';
    const searchInput = document.getElementById(`${domPrefix}-add-search`);
    if (searchInput) searchInput.value = '';
    renderProviderList();
    renderModels();
    updateConfirmButton();
  });

  const openModal = define(openModalName, async () => {
    navigateTo(`platform-${pageSlug}-add`);
    await initPage();
  });

  const closeModal = define(closeModalName, () => {});
  const onProviderChange = define(providerChangeName, () => {});
  const legacyConfirm = define(legacyConfirmName, () => openModal());

  const onSearch = define(`on${prefix}AddSearch`, () => {
    const input = document.getElementById(`${domPrefix}-add-search`);
    globalThis[addSearchKey] = (input?.value || '').trim().toLowerCase();
    renderProviderList();
  });

  const selectProvider = define(selectActionName, (providerId) => {
    globalThis[addSelectedKey] = providerId;
    renderProviderList();
    renderModels();
    updateConfirmButton();
  });

  const selectAll = define(`${domPrefix}AddSelectAll`, () => {
    cbSetAddModelChecks(checkSelector, true, updateConfirmButton);
  });

  const selectNone = define(`${domPrefix}AddSelectNone`, () => {
    cbSetAddModelChecks(checkSelector, false, updateConfirmButton);
  });

  const confirmPage = define(confirmPageName, async () => {
    const selectedId = globalThis[addSelectedKey];
    if (!selectedId) return;
    const provider = (globalThis[providerModelsKey] || []).find((p) => p.providerId === selectedId);
    if (!provider) return;
    const btn = document.getElementById(`${domPrefix}-add-confirm-page`);
    setLoading(btn, '保存中…');
    const previousModels = (globalThis[modelsKey] || []).slice();
    const previousAvailableModels = (globalThis[availableKey] || []).slice();
    const result = cbApplyProviderModelSelection(prefix, provider, checkSelector, platformId);
    const renderFn = globalThis[renderModelsFnName];
    const saveFn = globalThis[saveModelsFnName];
    if (typeof renderFn === 'function') renderFn();
    try {
      await saveFn({ silent: true, throwOnError: true });
      navigateTo(`platform-${pageSlug}`);
      showBottomToast(`已保存选择（${result.selectedCount} 个模型）`, 'success');
    } catch (e) {
      globalThis[modelsKey] = previousModels;
      globalThis[availableKey] = previousAvailableModels;
      if (typeof renderFn === 'function') renderFn();
      showCustomAlert(`保存失败，未写入配置：${e}`, '保存失败', 'error');
    } finally {
      clearLoading(btn);
      updateConfirmButton();
    }
  });

  return {
    openModal,
    closeModal,
    onProviderChange,
    legacyConfirm,
    initPage,
    onSearch,
    renderProviderList,
    selectProvider,
    renderModels,
    updateConfirmButton,
    selectAll,
    selectNone,
    confirmPage,
  };
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.createBuddyAddHandlers = createBuddyAddHandlers;
})(globalThis);
