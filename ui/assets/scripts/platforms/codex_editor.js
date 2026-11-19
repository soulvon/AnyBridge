// platforms/codex_editor.js — split from 55-platforms.js
function syncCodexConfigTokenFromSource() {
  const sourceId = String(document.getElementById('codex-config-source-id')?.value || '').trim();
  const editId = String(document.getElementById('codex-config-edit-id')?.value || '').trim();
  const existing = editId ? codexConfigProviderById(editId) : null;
  const targetSourceId = sourceId || existing?.sourceProviderId || '';
  const configName = String(document.getElementById('codex-config-name')?.value || '').trim();

  const source = (providerStore.providers || []).find(p => p && (
    (targetSourceId && p.id === targetSourceId) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('未找到关联的来源供应商，请先在下方选择或关联来源。', '无法同步', 'warn');
    }
    return;
  }

  codexConfigSetInputValue('codex-config-source-id', source.id);
  codexConfigSetInputValue('codex-config-api-key', source.apiKey || '');
  const newEndpoint = codexConfigDisplayBaseUrl(source);
  if (newEndpoint) codexConfigSetInputValue('codex-config-base-url', newEndpoint);

  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌`, 'success');
  }
}

async function openCodexAddModal() {
  await openCodexConfigEditor();
}

function openCodexProviderAdd() {
  openCodexConfigEditor();
}

async function initCodexAddPage() {
  try {
    codexProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    codexProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    codexProviderModels = codexProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    codexProviderModels.unshift(lp);
  }
  codexAddSelectedProvider = null;
  codexAddSearchKw = '';
  const searchInput = document.getElementById('codex-add-search');
  if (searchInput) searchInput.value = '';
  setCodexAddWireApi('auto');
  renderCodexAddProviderList();
  renderCodexAddModels();
  updateCodexAddConfirmButton();
}

function onCodexAddSearch() {
  const input = document.getElementById('codex-add-search');
  codexAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderCodexAddProviderList();
}

function renderCodexAddProviderList() {
  renderConfigAddProviderList({
    listId: 'codex-add-provider-list',
    sortPrefix: 'codex',
    providers: codexProviderModels,
    keyword: codexAddSearchKw,
    selectedProviderId: codexAddSelectedProvider,
    selectAction: 'selectCodexAddProvider',
  });
}

function selectCodexAddProvider(providerId) {
  codexAddSelectedProvider = providerId;
  renderCodexAddProviderList();
  applyCodexConfigSource(providerId);
}

function renderCodexAddModels() {
  const codexConfigs = Array.isArray(providerStore?.codexConfigs) ? providerStore.codexConfigs : [];
  let cachedProviderId = null;
  let existingModels = new Set();
  renderConfigAddModelChecklist({
    titleId: 'codex-add-models-title',
    subId: 'codex-add-models-sub',
    bodyId: 'codex-add-models-list-page',
    selectedProviderId: codexAddSelectedProvider,
    providers: codexProviderModels,
    platformLabel: 'Codex',
    preferredFamily: 'codex',
    checkClass: 'codex-add-model-check',
    updateAction: 'updateCodexAddConfirmButton',
    isChecked: (m, provider) => {
      if (cachedProviderId !== provider.providerId) {
        cachedProviderId = provider.providerId;
        const existingConfig = codexConfigs.find(c => c.sourceProviderId === provider.providerId || c.name === provider.providerName);
        existingModels = new Set(existingConfig?.models || []);
      }
      return existingModels.has(m.id);
    },
  });
}

function updateCodexAddConfirmButton() {
  updateConfigAddConfirmButtonState('codex-add-confirm-page', '.codex-add-model-check');
}

function codexAddSelectAll() {
  cbSetAddModelChecks('.codex-add-model-check', true, updateCodexAddConfirmButton);
}

function codexAddSelectNone() {
  cbSetAddModelChecks('.codex-add-model-check', false, updateCodexAddConfirmButton);
}

function setCodexAddWireApi(api) {
  setCodexConfigWireApiRadio(api);
}

async function confirmAddCodexModelsPage() {
  const provider = codexProviderModels.find(p => p.providerId === codexAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.codex-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const checkedModelIds = checkedInputs.map(input => input.dataset.modelId);
  const defaultModel = checkedModelIds[0] || '';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1'}` : '');
  const endpoint = codexConfigEndpointParts(rawBaseUrl);

  const routeThroughProxy = document.getElementById('codex-add-route-through-proxy')?.checked ?? true;
  const injectModels = document.getElementById('codex-add-inject-models')?.checked ?? true;
  const unifySessionHistory = document.getElementById('codex-add-unify-session-history')?.checked ?? true;
  const preserveOfficialAuth = document.getElementById('codex-add-preserve-official-auth')?.checked ?? false;
  const wireApi = document.getElementById('codex-add-wire-api')?.value || 'auto';
  const wireApiAuto = wireApi === 'auto';

  const sanitizedProvider = grok_sanitize_key(provider.providerId);
  const configId = `codex-${sanitizedProvider}`;

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.codexConfigs)) store.codexConfigs = [];
      const existingIdx = store.codexConfigs.findIndex(p =>
        p.id === configId || p.sourceProviderId === provider.providerId
      );
      const existing = existingIdx >= 0 ? store.codexConfigs[existingIdx] : null;
      const configItem = {
        ...(existing || {}),
        id: existing?.id || configId,
        name: provider.providerName,
        apiHost: endpoint.apiHost || provider.apiHost,
        apiPath: endpoint.apiPath || provider.apiPath || '/v1',
        apiKey: provider.apiKey || '',
        defaultModel,
        models: checkedModelIds,
        modelCatalog: checkedModelIds,
        wireApi: wireApiAuto ? undefined : wireApi,
        wireApiAuto,
        routeThroughProxy,
        injectModels: !preserveOfficialAuth && injectModels,
        preserveOfficialAuth,
        unifySessionHistory,
        sourceProviderId: provider.providerId,
        sourceProviderName: provider.providerName,
      };
      if (existingIdx >= 0) {
        store.codexConfigs[existingIdx] = configItem;
      } else {
        store.codexConfigs.push(configItem);
      }
    },
    renderList: () => renderCodexConfigList(platformInfoOf('codex') || {}),
  });
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 Codex 配置: ${provider.providerName} (${checkedModelIds.length} 个模型)`);
    showCustomAlert(`已保存「${provider.providerName}」的 Codex 配置（${checkedModelIds.length} 个模型）。`, '保存成功', 'success');
    navigateTo('platform-codex');
    renderCodexConfigList(platformInfoOf('codex') || {});
  }
}

function setCodexConfigWireApiRadio(api) {
  const normalized = api || 'auto';
  const hidden = document.getElementById('codex-config-wire-api') || document.getElementById('codex-add-wire-api');
  if (hidden) hidden.value = normalized;
  document.querySelectorAll('input[name="codex-config-wire-api-radio"], input[name="codex-add-wire-api-radio"]').forEach(r => {
    r.checked = r.value === normalized;
  });
  refreshCodexWireApiAutoLabel();
  syncCodexRawConfigFromFields();
}

async function openCodexConfigEditor(providerId = '') {
  resetPasswordInputVisibility('codex-config-api-key', 'codex-config-api-key-toggle');
  navigateTo('platform-codex-add');
  await initCodexConfigEditorPage(providerId);
}

async function initCodexConfigEditorPage(providerId = '') {
  codexProviderModels = await loadConfigEditorProviderModels();
  codexAddSearchKw = '';
  const searchInput = document.getElementById('codex-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? codexConfigProviderById(providerId) : null;
  codexConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('codex-config-page-title');
  const subEl = document.getElementById('codex-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · Codex' : '添加配置 · Codex';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 Codex 配置。`
      : '从现有供应商创建或自由定制一份可切换的 Codex Responses 配置方案。';
  }

  codexConfigSetInputValue('codex-config-edit-id', provider?.id || '');

  if (provider) {
    const bound = resolveConfigEditorBoundView(provider);
    const liveProvider = bound.hasSource
      ? { ...provider, apiHost: bound.apiHost, apiPath: bound.apiPath, apiKey: bound.apiKey }
      : provider;

    codexAddSelectedProvider = provider.sourceProviderId || null;
    renderCodexAddProviderList();

    codexConfigSetInputValue('codex-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('codex-config-name', provider.name || '');
    codexConfigSetInputValue('codex-config-base-url', codexConfigDisplayBaseUrl(liveProvider));
    codexConfigSetInputValue('codex-config-api-key', liveProvider.apiKey || '');
    const routeEl = document.getElementById('codex-config-route-through-proxy');
    if (routeEl) routeEl.checked = provider.routeThroughProxy !== false;
    const preserveEl = document.getElementById('codex-config-preserve-official-auth');
    if (preserveEl) preserveEl.checked = !!provider.preserveOfficialAuth;
    const injectEl = document.getElementById('codex-config-inject-models');
    if (injectEl) injectEl.checked = !provider.preserveOfficialAuth && provider.injectModels !== false;
    const unifyEl = document.getElementById('codex-config-unify-session-history');
    if (unifyEl) unifyEl.checked = provider.unifySessionHistory !== false;

    setCodexConfigWireApiRadio(
      provider.wireApiAuto === false ? (codexWireApiOf(provider) || 'responses') : 'auto'
    );
    syncCodexConfigAuthInjectMutualExclusion();
    renderReasoningConfig(provider.codexChatReasoning);

    const catalog = provider.modelCatalog || [];
    const providerModels = codexConfigModelList(provider);
    const merged = mergeCatalogAndModels(catalog, providerModels);
    const defaultModel = provider.defaultModel || '';
    if (defaultModel) {
      const dm = merged.find(e => e.model === defaultModel);
      if (dm) dm.isDefault = true;
    }
    const catalogSet = new Set(catalog.map(e => e.model));
    for (const e of merged) {
      if (!catalogSet.has(e.model)) {
        e.inCatalog = false;
      }
    }
    renderCodexModelManager(merged, defaultModel, merged.length ? `已保存 ${merged.length} 个模型` : '可重新拉取模型列表');
    renderCodexAgentsPanel(provider.agentsConfig || { maxThreads: 6, maxDepth: 1, jobMaxRuntimeSeconds: 1800 }, provider.agents || []);
  } else {
    codexConfigSetInputValue('codex-config-source-id', '');
    codexConfigSetInputValue('codex-config-name', '');
    codexConfigSetInputValue('codex-config-base-url', '');
    codexConfigSetInputValue('codex-config-api-key', '');
    const routeEl = document.getElementById('codex-config-route-through-proxy');
    if (routeEl) routeEl.checked = true;
    const injectEl = document.getElementById('codex-config-inject-models');
    if (injectEl) injectEl.checked = true;
    const preserveEl = document.getElementById('codex-config-preserve-official-auth');
    if (preserveEl) preserveEl.checked = false;
    const unifyEl = document.getElementById('codex-config-unify-session-history');
    if (unifyEl) unifyEl.checked = true;

    setCodexConfigWireApiRadio('auto');
    syncCodexConfigAuthInjectMutualExclusion();
    renderReasoningConfig(null);
    renderCodexModelManager([], '', '选择供应商后拉取模型列表');
    renderCodexAgentsPanel({ maxThreads: 6, maxDepth: 1, jobMaxRuntimeSeconds: 1800 }, []);

    const firstProvider = codexProviderModels[0];
    if (firstProvider) {
      codexAddSelectedProvider = firstProvider.providerId;
      renderCodexAddProviderList();
      applyCodexConfigSource(firstProvider.providerId);
    } else {
      codexAddSelectedProvider = null;
      renderCodexAddProviderList();
    }
  }

  const hasRealDiskFile = await loadPlatformRealConfigFile('codex', 'codex-config-raw-toml');
  if (!hasRealDiskFile) {
    syncCodexRawConfigFromFields();
  }

  window.setTimeout(() => {
    document.getElementById('codex-config-name')?.focus();
  }, 50);
}

function closeCodexConfigEditor() {
  resetPasswordInputVisibility('codex-config-api-key', 'codex-config-api-key-toggle');
  document.getElementById('codex-config-modal')?.classList.remove('active');
  navigateTo('platform-codex');
}

async function syncCodexConfigUiAfterStoreChange() {
  return commitPlatformConfigMutation({
    mutator: () => {},
    renderList: () => renderCodexConfigList(platformInfoOf('codex') || {}),
  });
}

async function saveCodexConfigEditor(switchAfter = false) {
  const editId = String(document.getElementById('codex-config-edit-id')?.value || '').trim();
  const sourceId = String(document.getElementById('codex-config-source-id')?.value || '').trim();
  const name = String(document.getElementById('codex-config-name')?.value || '').trim();
  let baseUrl = String(document.getElementById('codex-config-base-url')?.value || '').trim();
  let apiKey = String(document.getElementById('codex-config-api-key')?.value || '').trim();
  // 从统一模型管理器读取数据
  const allEntries = getCodexModelEntries();
  const defaultModel = allEntries.find(e => e.isDefault)?.model || '';
  const models = allEntries.map(e => e.model).filter(Boolean);
  const modelCatalog = allEntries
    .filter(e => e.inCatalog)
    .map(e => {
      const entry = { model: e.model };
      if (e.displayName) entry.displayName = e.displayName;
      if (e.contextWindow) entry.contextWindow = e.contextWindow;
      return entry;
    });

  const existing = editId ? codexConfigProviderById(editId) : null;
  const boundConn = resolveBoundConnectionForSave({
    sourceId,
    existing,
    baseUrl,
    apiKey,
    formatUrlFn: codexConfigDisplayBaseUrl,
  });
  if (boundConn.bound) {
    baseUrl = boundConn.baseUrl;
    apiKey = boundConn.apiKey;
  }

  if (!editId && !sourceId) {
    showCustomAlert('请先选择一个现有供应商。', '没有配置来源', 'warn');
    return;
  }
  if (!name || !baseUrl || !apiKey) {
    showCustomAlert('请填写配置名称、Base URL 和 API Key。', '配置不完整', 'warn');
    return;
  }

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.codexConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在同名配置，请换个名称（如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('codex-config-name')?.focus();
    return;
  }
  if (!models.length) {
    showCustomAlert('请至少添加一个模型。', '配置不完整', 'warn');
    return;
  }
  if (!defaultModel) {
    showCustomAlert('请先选择默认模型。', '未选择默认模型', 'warn');
    return;
  }
  const agents = getCodexAgents();
  const agentsError = validateCodexAgents(agents, models);
  if (agentsError) {
    showCustomAlert(agentsError, '子代理配置无效', 'warn');
    return;
  }

  const endpoint = typeof providerEndpointParts === 'function'
    ? providerEndpointParts(baseUrl, 'openai', '/v1')
    : { apiHost: baseUrl.replace(/\/+$/, ''), apiPath: '/v1' };
  const source = boundConn.bound ? boundConn.view.source : null;
  // 上游协议：选「自动识别」时按来源供应商的 API 路径推断，否则用用户显式选定的值。
  const wireApiChoice = String(document.getElementById('codex-config-wire-api')?.value || 'auto')
    .trim()
    .toLowerCase();
  const wireApiAuto = wireApiChoice !== 'chat' && wireApiChoice !== 'responses';
  const wireApi = wireApiAuto ? codexInferWireApi(source, existing) : wireApiChoice;
  const routeThroughProxy = document.getElementById('codex-config-route-through-proxy')?.checked !== false;
  syncCodexConfigAuthInjectMutualExclusion();
  const preserveOfficialAuth = document.getElementById('codex-config-preserve-official-auth')?.checked === true;
  // preserve 优先：与 codexProviderNeedsInject / 后端 watcher 一致
  const injectModels = preserveOfficialAuth
    ? false
    : document.getElementById('codex-config-inject-models')?.checked !== false;
  const unifySessionHistory = document.getElementById('codex-config-unify-session-history')?.checked !== false;

  const provider = {
    ...(existing || {}),
    id: editId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1',
    apiKey,
    defaultModel,
    models,
    wireApi,
    wireApiAuto,
    modelCatalog: modelCatalog.length ? modelCatalog : undefined,
    codexChatReasoning: getReasoningConfig(),
    agentsConfig: agents.length ? getCodexAgentsConfig() : undefined,
    agents: agents.length ? agents : undefined,
    routeThroughProxy,
    injectModels,
    preserveOfficialAuth,
    unifySessionHistory,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.codexConfigs)) store.codexConfigs = [];
      if (editId) {
        const idx = store.codexConfigs.findIndex(p => p.id === editId);
        if (idx >= 0) store.codexConfigs[idx] = provider;
        else store.codexConfigs.push(provider);
      } else {
        store.codexConfigs.push(provider);
      }
    },
    renderList: () => renderCodexConfigList(platformInfoOf('codex') || {}),
  });
  if (!ok) return;
  closeCodexConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 Codex 配置: ${name}`);
  if (switchAfter) await applyCodexProviderConfig(provider.id);
}

function codexActionIcon(type) {
  if (type === 'delete') {
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
  }
  if (type === 'config') {
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
  }
  if (type === 'start') {
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
  }
  return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
}

function codexReconfigureAction(action, disabled) {
  return `<button class="codex-current-action codex-reconfigure-action" type="button" title="重新写入当前配置" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(action)}">重新配置</button>`;
}

function renderCodexConfigCard(config) {
  const disabled = platformBusy === (config.platformId || 'codex');
  const editButton = config.editAction
    ? `<button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="编辑" aria-label="编辑 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.editAction)}">${codexActionIcon('edit')}</button>`
    : '';
  const deleteButton = config.deleteAction
    ? `<button class="btn-icon model-map-action-btn danger codex-icon-action codex-delete-action" type="button" title="删除" aria-label="删除 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.deleteAction)}">${codexActionIcon('delete')}</button>`
    : '';
  const removeButton = config.removeAction
    ? `<button class="btn-icon model-map-action-btn danger codex-icon-action codex-delete-action" type="button" title="${platformEsc(config.removeLabel || '移除')}" aria-label="从 live 配置移除 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.removeAction)}">${codexActionIcon('delete')}</button>`
    : '';
  const configButton = config.configAction
    ? `<button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="${platformEsc(config.configLabel || '配置模型')}" aria-label="${platformEsc(config.configLabel || '配置')} ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.configAction)}">${codexActionIcon('config')}</button>`
    : '';
  const desktopSupported = codexDesktopAutomationSupported();
  const startDisabled = disabled || !desktopSupported;
  const startTitle = desktopSupported ? '重启 Codex 桌面版' : '仅 Windows 支持自动启动 / 注入 Codex Desktop';
  const startButton = config.startAction
    ? `<button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="${platformEsc(startTitle)}" aria-label="启动 Codex ${platformEsc(config.name)}" ${startDisabled ? 'disabled' : ''} data-action-call="${platformEsc(config.startAction)}">${codexActionIcon('start')}</button>`
    : '';
  const switchButton = config.current || !config.action
    ? ''
    : `<button class="btn-primary codex-switch-action" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.action)}">${platformEsc(config.actionLabel || '切换')}</button>`;
  const reconfigureButton = config.current && config.action
    ? `${codexReconfigureAction(config.action, disabled)}`
    : '';
  const iconActions = [editButton, deleteButton, removeButton, configButton, startButton].filter(Boolean).join('');
  const mainAction = switchButton || reconfigureButton || '';
  const actions = (iconActions || mainAction)
    ? `<div class="codex-config-actions">
        ${iconActions ? `<div class="codex-card-icon-actions">${iconActions}</div>` : ''}
        ${mainAction ? `<div class="codex-card-main-action">${mainAction}</div>` : ''}
      </div>`
    : '<span class="codex-row-muted">-</span>';
  const agentCount = Array.isArray(config.agents) ? config.agents.length : Number(config.agentCount || 0);
  const meta = codexConfigMetaLine([
    config.model || '',
    config.endpoint || '',
    config.protocol || 'responses',
    agentCount > 0 ? `子代理: ${agentCount}` : '',
  ]);
  return `
    <article class="codex-config-card ${config.current ? 'current' : ''} ${platformEsc(config.tone || '')}">
      <div class="codex-config-main">
        <div class="codex-config-title">
          <strong title="${platformEsc(config.name)}">${platformEsc(config.name)}</strong>
          ${config.current ? '<span class="codex-config-badge-current">当前使用</span>' : ''}
          ${codexConfigBadge(config.typeLabel || '第三方', config.tone)}
          ${config.injectBadge === 'success'
            ? '<span class="codex-config-badge-success">✓ codex 桌面版正确显示模型</span>'
            : config.injectBadge === 'muted'
              ? '<span class="codex-config-badge-muted">codex 桌面版使用默认模型</span>'
              : ''}
          ${config.preserveAuthBadge === 'success'
            ? '<span class="codex-config-badge-success">✓ 保留官方登录</span>'
            : ''}
        </div>
        <p>${platformEsc(config.description || '')}</p>
        <div class="codex-config-meta">${meta}</div>
      </div>
      <div class="codex-config-card-side">
        ${actions}
      </div>
    </article>
  `;
}

async function deleteCodexProviderConfig(providerId) {
  const provider = codexConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('codex');
  const isCurrent = codexProviderIsCurrent(provider, info);

  const confirmMsg = isCurrent
    ? `「${provider.name || provider.id}」当前正在生效中。\n\n删除该配置将自动为您恢复为「官方默认配置」。是否确认删除？`
    : `确定要删除 Codex 配置「${provider.name || provider.id}」吗？`;

  const okConfirm = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!okConfirm) return;

  if (isCurrent) {
    await restoreCodexOfficialConfig();
  }

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      store.codexConfigs = (store.codexConfigs || []).filter(p => p.id !== providerId);
    },
    renderList: () => renderCodexConfigList(platformInfoOf('codex') || {}),
  });
  if (!ok) return;
  if (typeof addLog === 'function') addLog('info', `已删除 Codex 配置: ${provider.name || provider.id}`);
}

function editCodexProviderConfig(providerId) {
  const provider = codexConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  openCodexConfigEditor(providerId);
}

function codexConfigMatchesSearch(config) {
  const kw = codexConfigSearch.trim().toLowerCase();
  if (!kw) return true;
  return [
    config.name,
    config.typeLabel,
    config.model,
    config.endpoint,
    config.protocol,
    config.description,
  ].some(value => String(value || '').toLowerCase().includes(kw));
}

function renderCodexConfigList(info) {
  const list = document.getElementById('platform-codex-config-list');
  if (!list) return;

  const providers = platformProviderList('codex');
  const config = (info && info.codexConfig) || {};
  const items = [];

  items.push({
    name: '官方默认配置',
    description: '使用 Codex 官方登录态，不写入第三方地址和 token。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: !!config.isOfficial,
    model: '官方默认',
    endpoint: 'auth.json 登录态',
    protocol: 'responses',
    action: 'restoreCodexOfficialConfig()',
  });

  const codexLocalCard = platformLocalProxyCard('codex', info);
  if (codexLocalCard) items.push(codexLocalCard);

  const isExternal = !!info.currentProviderId && !config.isOfficial && !info.managedByAnyBridge
    && !providers.some(provider => codexProviderIsCurrent(provider, info));
  if (isExternal) {
    items.push({
      name: info.currentProviderName || config.providerName || info.currentProviderId || '当前第三方配置',
      description: '由其他工具或手动配置写入。可以保留，也可以切换到下方任一配置。',
      typeLabel: '第三方',
      tone: 'third external',
      current: true,
      model: config.model || '未知',
      endpoint: config.baseUrl || config.modelProviderId || info.currentProviderId,
      protocol: config.wireApi || 'responses',
    });
  }

  providers.forEach(provider => {
    const baseUrl = codexTargetBaseUrl(provider);
    const current = codexProviderIsCurrent(provider, info);
    const typeLabel = provider.routeThroughProxy === false ? '直连' : '网关';
    const preserveAuth = codexProviderPreservesOfficialAuth(provider);
    const needInject = codexProviderNeedsInject(provider);
    const isOfficialModel = /^gpt-/i.test(String(provider.defaultModel || '').trim());
    items.push({
      name: provider.name || provider.id,
      description: '第三方 OpenAI Responses 兼容配置。',
      typeLabel: isOfficialModel ? `${typeLabel}（官方模型）` : typeLabel,
      tone: 'third',
      current,
      model: provider.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: provider.wireApi || 'responses',
      // 三态：success=注入；muted=主动关闭注入；空=保留官方登录（由 preserveAuth 徽章说明）
      injectBadge: needInject ? 'success' : (preserveAuth ? '' : 'muted'),
      preserveAuthBadge: preserveAuth ? 'success' : '',
      action: `applyCodexProviderConfig(${platformJsArg(provider.id)})`,
      editAction: `editCodexProviderConfig(${platformJsArg(provider.id)})`,
      startAction: current ? `startCodexWithCdp(${needInject ? 'true' : 'false'})` : '',
      deleteAction: `deleteCodexProviderConfig(${platformJsArg(provider.id)})`,
    });
  });

  const filtered = items.filter(codexConfigMatchesSearch);
  const count = document.getElementById('codex-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.syncCodexConfigTokenFromSource = syncCodexConfigTokenFromSource;
  g.openCodexAddModal = openCodexAddModal;
  g.openCodexProviderAdd = openCodexProviderAdd;
  g.initCodexAddPage = initCodexAddPage;
  g.onCodexAddSearch = onCodexAddSearch;
  g.renderCodexAddProviderList = renderCodexAddProviderList;
  g.selectCodexAddProvider = selectCodexAddProvider;
  g.renderCodexAddModels = renderCodexAddModels;
  g.updateCodexAddConfirmButton = updateCodexAddConfirmButton;
  g.codexAddSelectAll = codexAddSelectAll;
  g.codexAddSelectNone = codexAddSelectNone;
  g.setCodexAddWireApi = setCodexAddWireApi;
  g.confirmAddCodexModelsPage = confirmAddCodexModelsPage;
  g.setCodexConfigWireApiRadio = setCodexConfigWireApiRadio;
  g.openCodexConfigEditor = openCodexConfigEditor;
  g.initCodexConfigEditorPage = initCodexConfigEditorPage;
  g.closeCodexConfigEditor = closeCodexConfigEditor;
  g.syncCodexConfigUiAfterStoreChange = syncCodexConfigUiAfterStoreChange;
  g.saveCodexConfigEditor = saveCodexConfigEditor;
  g.codexActionIcon = codexActionIcon;
  g.codexReconfigureAction = codexReconfigureAction;
  g.renderCodexConfigCard = renderCodexConfigCard;
  g.deleteCodexProviderConfig = deleteCodexProviderConfig;
  g.editCodexProviderConfig = editCodexProviderConfig;
  g.codexConfigMatchesSearch = codexConfigMatchesSearch;
  g.renderCodexConfigList = renderCodexConfigList;
})(globalThis);
