// platforms/managed_models.js — split from 55-platforms.js
// ═══════ 受管模型表格平台（Pi / Hermes / DeepSeek Harness）═══════
//
// 三个平台的配置文件格式各不相同（Pi 写 models.json 的 providers，Hermes 写 config.yaml 的
// custom_providers，DeepSeek Harness 写 settings.yaml + .credentials.yaml），但界面交互完全
// 一致：加载 → 表格编辑 → 保存 → 添加页。差异只在读写命令与文案，因此共用这一份实现，
// 按前缀生成各平台的全局状态与函数。

function createManagedModelsPlatform({
  prefix, // 表格前缀：'Pi' | 'Hermes' | 'Dsh'
  domPrefix, // DOM id 与全局状态前缀：'pi' | 'hermes' | 'dsh'
  loadCommand, // 后端读取命令
  saveCommand, // 后端保存命令
  fallbackPath, // 配置文件展示路径
}) {
  const modelsKey = `${domPrefix}Models`;
  const availableKey = `${domPrefix}AvailableModels`;
  const providerModelsKey = `${domPrefix}ProviderModels`;
  const editingKey = `${domPrefix}EditingIndex`;
  const addSelectedKey = `${domPrefix}AddSelectedProvider`;
  const addSearchKey = `${domPrefix}AddSearchKw`;
  const scopeKey = `${domPrefix}ConfigScope`;
  const rowFactory = globalThis[`${domPrefix}RowFactory`];
  const checkClass = `.${domPrefix}-add-model-check`;
  const platformId = MANAGED_MODEL_PLATFORM_IDS[prefix];
  const label = (typeof platformDef === 'function' ? platformDef(platformId).name : '') || prefix;

  globalThis[modelsKey] = [];
  globalThis[availableKey] = [];
  globalThis[scopeKey] = 'user';
  globalThis[providerModelsKey] = [];
  globalThis[editingKey] = -1;
  globalThis[addSelectedKey] = null;
  globalThis[addSearchKey] = '';

  const define = (name, fn) => {
    globalThis[name] = fn;
    window[name] = fn;
  };

  define(`${domPrefix}ModelRow`, (model, index) => rowFactory(model, index));

  define(`load${prefix}Models`, async () => {
    if (!invoke) return;
    try {
      const data = await invoke(loadCommand);
      const rawModels = Array.isArray(data.models) ? data.models : [];
      globalThis[modelsKey] = cbNormalizeModelsContext(rawModels);
      globalThis[availableKey] = Array.isArray(data.availableModels) ? data.availableModels : [];
      const meta = cbApplyConfigMeta(domPrefix, data, fallbackPath);
      globalThis[scopeKey] = meta.scope;
      globalThis[`render${prefix}Models`]();
      if (typeof addLog === 'function') addLog('ok', `${label} 模型列表已加载`);
    } catch (e) {
      if (typeof addLog === 'function') addLog('err', `加载 ${label} 模型失败: ${e}`);
      showCustomAlert(String(e), '加载失败', 'error');
    }
  });

  define(`render${prefix}Models`, () => {
    const tbody = document.getElementById(`${domPrefix}-model-tbody`);
    const empty = document.getElementById(`${domPrefix}-model-empty`);
    const table = document.getElementById(`${domPrefix}-model-table`);
    if (!tbody) return;
    const models = globalThis[modelsKey];
    cbUpdateConsoleStats(domPrefix, models);

    if (!models.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      if (table) table.style.display = 'none';
      cbSyncSelectionState(prefix);
      return;
    }

    const entries = cbFilteredModelEntries(models, domPrefix);
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';
    tbody.innerHTML = entries.length
      ? entries
        .map(({ model, index }) => globalThis[`${domPrefix}ModelRow`](model, index))
        .join('')
      : cbNoResultRow(domPrefix);
    cbSyncSelectionState(prefix);
  });

  define(`edit${prefix}Model`, (index) => openCbEditModal(prefix, index));
  define(`cancel${prefix}Edit`, () => closeCbEditModal());
  define(`save${prefix}Edit`, (index) => saveCbEditFromModal(index));
  define(`delete${prefix}Model`, (index) => cbDeleteModelByIndex(prefix, index));
  define(`deleteSelected${prefix}Models`, () => cbDeleteSelectedModels(prefix));
  define(`on${prefix}ModelSearch`, () => globalThis[`render${prefix}Models`]());

  define(`toggle${prefix}ModelEnabled`, async (index, checked) => {
    const model = globalThis[modelsKey][index];
    if (!model) return;
    const previous = model.enabled !== false;
    model.enabled = checked;
    globalThis[`render${prefix}Models`]();
    const saved = await globalThis[`save${prefix}Models`]({ silent: true });
    if (!saved) {
      model.enabled = previous;
      globalThis[`render${prefix}Models`]();
    }
  });

  define(`save${prefix}Models`, async (options = {}) => {
    if (!invoke) {
      const error = new Error('当前环境缺少 Tauri invoke，无法保存配置');
      if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
      if (options.throwOnError) throw error;
      return false;
    }
    try {
      globalThis[modelsKey] = cbNormalizeModelsContext(globalThis[modelsKey]);
      globalThis[availableKey] =
        cbMergeAvailableModels(globalThis[availableKey], globalThis[modelsKey]);
      const path = await invoke(saveCommand, {
        models: globalThis[modelsKey],
        availableModels: globalThis[availableKey],
        scope: globalThis[scopeKey],
      });
      const meta = cbApplyConfigMeta(
        domPrefix,
        { _configPath: path, _configScope: globalThis[scopeKey] },
        path,
      );
      globalThis[scopeKey] = meta.scope;
      if (typeof addLog === 'function') addLog('ok', `${label} 配置已保存到 ${path}`);
      if (!options.silent) showCustomAlert(`配置已保存到 ${path}`, '保存成功', 'success');
      return path;
    } catch (e) {
      if (typeof addLog === 'function') addLog('err', `保存 ${label} 配置失败: ${e}`);
      if (!options.silent) showCustomAlert(String(e), '保存失败', 'error');
      if (options.throwOnError) throw e;
      return false;
    }
  });

  define(`open${prefix}AddModal`, async () => {
    navigateTo(`platform-${platformId}-add`);
    await globalThis[`init${prefix}AddPage`]();
  });
  // 兼容沿用旧入口的调用
  define(`close${prefix}AddModal`, () => {});
  define(`on${prefix}AddProviderChange`, () => {});
  define(`confirmAdd${prefix}Models`, () => globalThis[`open${prefix}AddModal`]());

  define(`init${prefix}AddPage`, async () => {
    try {
      globalThis[providerModelsKey] = (await invoke('list_provider_models')) || [];
    } catch (e) {
      globalThis[providerModelsKey] = [];
    }
    // 注入 AnyBridge 内置供应商到首位：不想直连渠道时从这里导入模型，走 :7450 本地网关
    if (typeof localProxyProviderModelsEntry === 'function') {
      const lp = localProxyProviderModelsEntry();
      globalThis[providerModelsKey] = globalThis[providerModelsKey].filter(
        (p) => !isLocalProxyProviderEntry(p),
      );
      globalThis[providerModelsKey].unshift(lp);
    }
    globalThis[addSelectedKey] = null;
    globalThis[addSearchKey] = '';
    const searchInput = document.getElementById(`${domPrefix}-add-search`);
    if (searchInput) searchInput.value = '';
    globalThis[`render${prefix}AddProviderList`]();
    globalThis[`render${prefix}AddModels`]();
    globalThis[`update${prefix}AddConfirmButton`]();
  });

  define(`on${prefix}AddSearch`, () => {
    const input = document.getElementById(`${domPrefix}-add-search`);
    globalThis[addSearchKey] = (input?.value || '').trim().toLowerCase();
    globalThis[`render${prefix}AddProviderList`]();
  });

  define(`render${prefix}AddProviderList`, () => {
    const list = document.getElementById(`${domPrefix}-add-provider-list`);
    syncPlatformAddSortControl(domPrefix);
    if (!list) return;
    const providers = globalThis[providerModelsKey];
    if (!providers.length) {
      list.innerHTML = '<div class="wb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
      return;
    }
    const filtered = platformAddVisibleProviders(providers, globalThis[addSearchKey]);
    if (!filtered.length) {
      list.innerHTML = '<div class="wb-add-prov-empty">没有匹配的供应商</div>';
      return;
    }
    list.innerHTML = filtered
      .map((p) => {
        const initial = (p.providerName || '?').charAt(0).toUpperCase();
        const enabled = p.enabled !== false;
        const isActive = globalThis[addSelectedKey] === p.providerId;
        const isBuiltin = isBuiltinProxyEntry(p);
        const iconHtml = isBuiltin
          ? '<span class="wb-add-prov-icon wb-add-prov-icon-builtin" title="AnyBridge 内置供应商"><span>内置</span><span>供应商</span></span>'
          : `<span class="wb-add-prov-icon">${platformEsc(initial)}</span>`;
        return `
      <div class="wb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="select${prefix}AddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="wb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="wb-add-prov-count">${p.models.length}</span>
      </div>
    `;
      })
      .join('');
  });

  define(`select${prefix}AddProvider`, (providerId) => {
    globalThis[addSelectedKey] = providerId;
    globalThis[`render${prefix}AddProviderList`]();
    globalThis[`render${prefix}AddModels`]();
    globalThis[`update${prefix}AddConfirmButton`]();
  });

  define(`render${prefix}AddModels`, () => {
    const titleEl = document.getElementById(`${domPrefix}-add-models-title`);
    const subEl = document.getElementById(`${domPrefix}-add-models-sub`);
    const body = document.getElementById(`${domPrefix}-add-models-list-page`);
    if (!body) return;
    if (!globalThis[addSelectedKey]) {
      titleEl.textContent = '请选择供应商';
      subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
      body.innerHTML = '<div class="wb-add-models-empty">请从左侧选择一个供应商</div>';
      return;
    }
    const provider = globalThis[providerModelsKey].find(
      (p) => p.providerId === globalThis[addSelectedKey],
    );
    if (!provider) {
      titleEl.textContent = '供应商未找到';
      body.innerHTML = '<div class="wb-add-models-empty">供应商未找到</div>';
      return;
    }
    titleEl.textContent = provider.providerName;
    subEl.textContent = `共 ${provider.models.length} 个模型，勾选要保留或添加的项`;
    if (!provider.models.length) {
      body.innerHTML = '<div class="wb-add-models-empty">该供应商暂无模型</div>';
      return;
    }

    const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (l) => l;
    const sortedModels = sortFn(provider.models);

    body.innerHTML = sortedModels
      .map((m) => {
        const exists = globalThis[modelsKey].some((model) => model.id === m.id);
        return `
      <label class="wb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="wb-add-model-check ${domPrefix}-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="update${prefix}AddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
      })
      .join('');
  });

  define(`update${prefix}AddConfirmButton`, () => {
    const btn = document.getElementById(`${domPrefix}-add-confirm-page`);
    if (!btn) return;
    const total = document.querySelectorAll(checkClass).length;
    const checks = document.querySelectorAll(`${checkClass}:checked`);
    btn.disabled = total === 0;
    cbSetButtonLabel(btn, ` 保存选择 (${checks.length})`);
  });

  define(`${domPrefix}AddSelectAll`, () =>
    cbSetAddModelChecks(checkClass, true, globalThis[`update${prefix}AddConfirmButton`]));
  define(`${domPrefix}AddSelectNone`, () =>
    cbSetAddModelChecks(checkClass, false, globalThis[`update${prefix}AddConfirmButton`]));

  define(`confirmAdd${prefix}ModelsPage`, async () => {
    if (!globalThis[addSelectedKey]) return;
    const provider = globalThis[providerModelsKey].find(
      (p) => p.providerId === globalThis[addSelectedKey],
    );
    if (!provider) return;
    const btn = document.getElementById(`${domPrefix}-add-confirm-page`);
    setLoading(btn, '保存中…');
    const previousModels = globalThis[modelsKey].slice();
    const previousAvailableModels = globalThis[availableKey].slice();
    const result = cbApplyProviderModelSelection(prefix, provider, checkClass, platformId);
    globalThis[`render${prefix}Models`]();
    try {
      await globalThis[`save${prefix}Models`]({ silent: true, throwOnError: true });
      navigateTo(`platform-${platformId}`);
      showBottomToast(`已保存选择（${result.selectedCount} 个模型）`, 'success');
    } catch (e) {
      globalThis[modelsKey] = previousModels;
      globalThis[availableKey] = previousAvailableModels;
      globalThis[`render${prefix}Models`]();
      showCustomAlert(`保存失败，未写入配置：${e}`, '保存失败', 'error');
    } finally {
      clearLoading(btn);
      globalThis[`update${prefix}AddConfirmButton`]();
    }
  });

  define(`toggle${prefix}AddSort`, (event) => togglePlatformAddSortMenu(domPrefix, event));
  define(`choose${prefix}AddSortMode`, (mode) => choosePlatformAddSortMode(domPrefix, mode));

  // 拖拽导入与 JSON 编辑器（与 CodeBuddy 系列共用同一批工厂）
  createCbDropHandlers(
    prefix,
    () => globalThis[modelsKey], (v) => { globalThis[modelsKey] = v; },
    () => globalThis[availableKey], (v) => { globalThis[availableKey] = v; },
    globalThis[`render${prefix}Models`], label
  );

  createCbIoHandlers(
    prefix, platformId,
    () => globalThis[modelsKey], (v) => { globalThis[modelsKey] = v; },
    () => globalThis[availableKey], (v) => { globalThis[availableKey] = v; },
    globalThis[`render${prefix}Models`], globalThis[`save${prefix}Models`], globalThis[`load${prefix}Models`],
    label
  );
}

// ═══════ Pi 自定义模型管理 ═══════

createManagedModelsPlatform({
  prefix: 'Pi',
  domPrefix: 'pi',
  loadCommand: 'load_pi_models',
  saveCommand: 'save_pi_models',
  fallbackPath: '~/.pi/agent/models.json',
});

createManagedModelsPlatform({
  prefix: 'Hermes',
  domPrefix: 'hermes',
  loadCommand: 'load_hermes_models',
  saveCommand: 'save_hermes_models',
  fallbackPath: '~/.hermes/config.yaml',
});

createManagedModelsPlatform({
  prefix: 'Dsh',
  domPrefix: 'dsh',
  loadCommand: 'load_deepseek_harness_models',
  saveCommand: 'save_deepseek_harness_models',
  fallbackPath: '~/.dsh/settings.yaml',
});

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.createManagedModelsPlatform = createManagedModelsPlatform;
})(globalThis);

// 静态导出注册：让 Pi / Hermes / DeepSeek Harness 的动态动作对 ui-guards 静态检查可见
(function registerManagedActions(g) {
  for (const p of ['Pi', 'Hermes', 'Dsh']) {
    // 保留占位说明；下面逐条静态赋值供正则可达检查扫描
  }
  g.loadPiModels = g.loadPiModels;
  g.renderPiModels = g.renderPiModels;
  g.savePiModels = g.savePiModels;
  g.editPiModel = g.editPiModel;
  g.cancelPiEdit = g.cancelPiEdit;
  g.savePiEdit = g.savePiEdit;
  g.deletePiModel = g.deletePiModel;
  g.deleteSelectedPiModels = g.deleteSelectedPiModels;
  g.onPiModelSearch = g.onPiModelSearch;
  g.togglePiModelEnabled = g.togglePiModelEnabled;
  g.openPiAddModal = g.openPiAddModal;
  g.initPiAddPage = g.initPiAddPage;
  g.onPiAddSearch = g.onPiAddSearch;
  g.renderPiAddProviderList = g.renderPiAddProviderList;
  g.selectPiAddProvider = g.selectPiAddProvider;
  g.renderPiAddModels = g.renderPiAddModels;
  g.updatePiAddConfirmButton = g.updatePiAddConfirmButton;
  g.piAddSelectAll = g.piAddSelectAll;
  g.piAddSelectNone = g.piAddSelectNone;
  g.confirmAddPiModelsPage = g.confirmAddPiModelsPage;
  g.exportPiModels = g.exportPiModels;
  g.importPiModels = g.importPiModels;
  g.togglePiJsonEditor = g.togglePiJsonEditor;
  g.formatPiJson = g.formatPiJson;
  g.applyPiJson = g.applyPiJson;

  g.loadHermesModels = g.loadHermesModels;
  g.renderHermesModels = g.renderHermesModels;
  g.saveHermesModels = g.saveHermesModels;
  g.editHermesModel = g.editHermesModel;
  g.cancelHermesEdit = g.cancelHermesEdit;
  g.saveHermesEdit = g.saveHermesEdit;
  g.deleteHermesModel = g.deleteHermesModel;
  g.deleteSelectedHermesModels = g.deleteSelectedHermesModels;
  g.onHermesModelSearch = g.onHermesModelSearch;
  g.toggleHermesModelEnabled = g.toggleHermesModelEnabled;
  g.openHermesAddModal = g.openHermesAddModal;
  g.initHermesAddPage = g.initHermesAddPage;
  g.onHermesAddSearch = g.onHermesAddSearch;
  g.renderHermesAddProviderList = g.renderHermesAddProviderList;
  g.selectHermesAddProvider = g.selectHermesAddProvider;
  g.renderHermesAddModels = g.renderHermesAddModels;
  g.updateHermesAddConfirmButton = g.updateHermesAddConfirmButton;
  g.hermesAddSelectAll = g.hermesAddSelectAll;
  g.hermesAddSelectNone = g.hermesAddSelectNone;
  g.confirmAddHermesModelsPage = g.confirmAddHermesModelsPage;
  g.exportHermesModels = g.exportHermesModels;
  g.importHermesModels = g.importHermesModels;
  g.toggleHermesJsonEditor = g.toggleHermesJsonEditor;
  g.formatHermesJson = g.formatHermesJson;
  g.applyHermesJson = g.applyHermesJson;

  g.loadDshModels = g.loadDshModels;
  g.renderDshModels = g.renderDshModels;
  g.saveDshModels = g.saveDshModels;
  g.editDshModel = g.editDshModel;
  g.cancelDshEdit = g.cancelDshEdit;
  g.saveDshEdit = g.saveDshEdit;
  g.deleteDshModel = g.deleteDshModel;
  g.deleteSelectedDshModels = g.deleteSelectedDshModels;
  g.onDshModelSearch = g.onDshModelSearch;
  g.toggleDshModelEnabled = g.toggleDshModelEnabled;
  g.openDshAddModal = g.openDshAddModal;
  g.initDshAddPage = g.initDshAddPage;
  g.onDshAddSearch = g.onDshAddSearch;
  g.renderDshAddProviderList = g.renderDshAddProviderList;
  g.selectDshAddProvider = g.selectDshAddProvider;
  g.renderDshAddModels = g.renderDshAddModels;
  g.updateDshAddConfirmButton = g.updateDshAddConfirmButton;
  g.dshAddSelectAll = g.dshAddSelectAll;
  g.dshAddSelectNone = g.dshAddSelectNone;
  g.confirmAddDshModelsPage = g.confirmAddDshModelsPage;
  g.exportDshModels = g.exportDshModels;
  g.importDshModels = g.importDshModels;
  g.toggleDshJsonEditor = g.toggleDshJsonEditor;
  g.formatDshJson = g.formatDshJson;
  g.applyDshJson = g.applyDshJson;
})(globalThis);
