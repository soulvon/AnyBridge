// platforms/opencode_editor.js — split from 55-platforms.js
function syncOpenCodeConfigTokenFromSource() {
  const sourceId = String(document.getElementById('opencode-config-source-id')?.value || '').trim();
  const editId = String(document.getElementById('opencode-config-edit-id')?.value || '').trim();
  const existing = editId ? opencodeConfigProviderById(editId) : null;
  const targetSourceId = sourceId || existing?.sourceProviderId || '';
  const configName = String(document.getElementById('opencode-config-name')?.value || '').trim();

  const source = (providerStore.providers || []).find(p => p && (
    (targetSourceId && p.id === targetSourceId) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('未找到关联的来源供应商，请先选择来源。', '无法同步', 'warn');
    }
    return;
  }

  codexConfigSetInputValue('opencode-config-source-id', source.id);
  codexConfigSetInputValue('opencode-config-api-key', source.apiKey || '');
  const newEndpoint = opencodeConfigDisplayBaseUrl(source);
  if (newEndpoint) codexConfigSetInputValue('opencode-config-base-url', newEndpoint);
  syncOpenCodeRawConfigFromFields();

  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌`, 'success');
  }
}

async function openOpenCodeAddModal() {
  await openOpenCodeConfigEditor();
}

function openOpenCodeProviderAdd() {
  openOpenCodeConfigEditor();
}

async function initOpenCodeConfigEditorPage(providerId = '') {
  opencodeProviderModels = await loadConfigEditorProviderModels();
  opencodeAddSearchKw = '';
  const searchInput = document.getElementById('opencode-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? opencodeConfigProviderById(providerId) : null;
  opencodeConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('opencode-config-page-title');
  const subEl = document.getElementById('opencode-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · OpenCode' : '添加配置 · OpenCode';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 OpenCode 配置。`
      : '从现有供应商创建或自由定制一份独立 OpenCode provider 配置方案。';
  }

  codexConfigSetInputValue('opencode-config-edit-id', provider?.id || '');

  if (provider) {
    const bound = resolveConfigEditorBoundView(provider);
    let effectiveSettings = provider.settingsConfig || null;
    const liveProvider = bound.hasSource
      ? { ...provider, apiHost: bound.apiHost, apiPath: bound.apiPath, apiKey: bound.apiKey }
      : provider;
    const displayBaseUrl = opencodeConfigDisplayBaseUrl(liveProvider);
    if (bound.hasSource && effectiveSettings && typeof effectiveSettings === 'object') {
      effectiveSettings = JSON.parse(JSON.stringify(effectiveSettings));
      if (!effectiveSettings.options || typeof effectiveSettings.options !== 'object' || Array.isArray(effectiveSettings.options)) {
        effectiveSettings.options = {};
      }
      effectiveSettings.options.baseURL = displayBaseUrl;
      effectiveSettings.options.apiKey = liveProvider.apiKey || '';
    }

    opencodeAddSelectedProvider = provider.sourceProviderId || null;
    renderOpenCodeAddProviderList();

    codexConfigSetInputValue('opencode-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('opencode-config-name', provider.name || '');
    codexConfigSetInputValue('opencode-config-base-url', displayBaseUrl);
    codexConfigSetInputValue('opencode-config-api-key', liveProvider.apiKey || '');
    const models = codexConfigModelList(liveProvider);
    codexConfigSetInputValue('opencode-config-model', provider.defaultModel || models[0] || '');
    opencodeConfigSetModels(models, provider.defaultModel || models[0] || '', models.length ? `已保存 ${models.length} 个模型` : '可重新拉取模型列表');
    opencodeSetRawSettings(opencodeBuildSettingsForProvider({ ...liveProvider, settingsConfig: effectiveSettings }, models));
  } else {
    codexConfigSetInputValue('opencode-config-source-id', '');
    codexConfigSetInputValue('opencode-config-name', '');
    codexConfigSetInputValue('opencode-config-base-url', '');
    codexConfigSetInputValue('opencode-config-api-key', '');
    codexConfigSetInputValue('opencode-config-model', '');
    opencodeConfigSetModels([], '', '选择供应商后拉取模型列表');

    const firstProvider = opencodeProviderModels[0];
    if (firstProvider) {
      opencodeAddSelectedProvider = firstProvider.providerId;
      renderOpenCodeAddProviderList();
      applyOpenCodeConfigSource(firstProvider.providerId);
    } else {
      opencodeAddSelectedProvider = null;
      renderOpenCodeAddProviderList();
    }
  }

  await loadPlatformRealConfigFile('opencode', 'opencode-config-raw-json');

  window.setTimeout(() => {
    document.getElementById('opencode-config-name')?.focus();
  }, 50);
}

async function initOpenCodeAddPage() {
  await initOpenCodeConfigEditorPage();
}

function onOpenCodeAddSearch() {
  const input = document.getElementById('opencode-add-search');
  opencodeAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderOpenCodeAddProviderList();
}

function renderOpenCodeAddProviderList() {
  renderConfigAddProviderList({
    listId: 'opencode-add-provider-list',
    sortPrefix: 'opencode',
    providers: opencodeProviderModels,
    keyword: opencodeAddSearchKw,
    selectedProviderId: opencodeAddSelectedProvider,
    selectAction: 'selectOpenCodeAddProvider',
  });
}

function selectOpenCodeAddProvider(providerId) {
  opencodeAddSelectedProvider = providerId;
  renderOpenCodeAddProviderList();
  applyOpenCodeConfigSource(providerId);
}

function renderOpenCodeAddModels() {
  const opencodeConfigs = Array.isArray(providerStore?.opencodeConfigs) ? providerStore.opencodeConfigs : [];
  let cachedProviderId = null;
  let existingModels = new Set();
  renderConfigAddModelChecklist({
    titleId: 'opencode-add-models-title',
    subId: 'opencode-add-models-sub',
    bodyId: 'opencode-add-models-list-page',
    selectedProviderId: opencodeAddSelectedProvider,
    providers: opencodeProviderModels,
    platformLabel: 'OpenCode',
    checkClass: 'opencode-add-model-check',
    updateAction: 'updateOpenCodeAddConfirmButton',
    isChecked: (m, provider) => {
      if (cachedProviderId !== provider.providerId) {
        cachedProviderId = provider.providerId;
        const existingConfig = opencodeConfigs.find(c => c.sourceProviderId === provider.providerId || c.name === provider.providerName);
        existingModels = new Set(existingConfig?.models || []);
      }
      return existingModels.has(m.id);
    },
  });
}

function updateOpenCodeAddConfirmButton() {
  updateConfigAddConfirmButtonState('opencode-add-confirm-page', '.opencode-add-model-check');
}

function opencodeAddSelectAll() {
  cbSetAddModelChecks('.opencode-add-model-check', true, updateOpenCodeAddConfirmButton);
}

function opencodeAddSelectNone() {
  cbSetAddModelChecks('.opencode-add-model-check', false, updateOpenCodeAddConfirmButton);
}

async function confirmAddOpenCodeModelsPage() {
  const provider = opencodeProviderModels.find(p => p.providerId === opencodeAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.opencode-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const checkedModelIds = checkedInputs.map(input => input.dataset.modelId);
  const defaultModel = checkedModelIds[0] || '';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1'}` : '');
  const endpoint = opencodeConfigEndpointParts(rawBaseUrl);

  const sanitizedProvider = grok_sanitize_key(provider.providerId);
  const configId = `opencode-${sanitizedProvider}`;

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.opencodeConfigs)) store.opencodeConfigs = [];
      const existingIdx = store.opencodeConfigs.findIndex(p =>
        p.id === configId || p.sourceProviderId === provider.providerId
      );
      const existing = existingIdx >= 0 ? store.opencodeConfigs[existingIdx] : null;
      const settingsConfig = opencodeBuildSettingsForProvider({
        name: provider.providerName,
        apiHost: endpoint.apiHost || provider.apiHost,
        apiPath: endpoint.apiPath || provider.apiPath || '/v1',
        apiKey: provider.apiKey || '',
        settingsConfig: existing?.settingsConfig || null,
      }, checkedModelIds);

      const configItem = {
        ...(existing || {}),
        id: existing?.id || configId,
        name: provider.providerName,
        apiHost: endpoint.apiHost || provider.apiHost,
        apiPath: endpoint.apiPath || provider.apiPath || '/v1',
        apiKey: provider.apiKey || '',
        defaultModel,
        models: checkedModelIds,
        settingsConfig,
        sourceProviderId: provider.providerId,
        sourceProviderName: provider.providerName,
      };

      if (existingIdx >= 0) {
        store.opencodeConfigs[existingIdx] = configItem;
      } else {
        store.opencodeConfigs.push(configItem);
      }
    },
    renderList: () => renderOpenCodeConfigList(platformInfoOf('opencode') || {}),
  });
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 OpenCode 配置: ${provider.providerName} (${checkedModelIds.length} 个模型)`);
    showCustomAlert(`已成功保存「${provider.providerName}」的 OpenCode 配置（共 ${checkedModelIds.length} 个模型）。`, '保存成功', 'success');
    navigateTo('platform-opencode');
    renderOpenCodeConfigList(platformInfoOf('opencode') || {});
  }
}

async function openOpenCodeConfigEditor(providerId = '') {
  resetPasswordInputVisibility('opencode-config-api-key', 'opencode-config-api-key-toggle');
  navigateTo('platform-opencode-add');
  await initOpenCodeConfigEditorPage(providerId);
}

function closeOpenCodeConfigEditor() {
  resetPasswordInputVisibility('opencode-config-api-key', 'opencode-config-api-key-toggle');
  document.getElementById('opencode-config-modal')?.classList.remove('active');
  navigateTo('platform-opencode');
}

async function syncOpenCodeConfigUiAfterStoreChange() {
  return commitPlatformConfigMutation({
    mutator: () => {},
    renderList: () => renderOpenCodeConfigList(platformInfoOf('opencode') || {}),
  });
}

async function saveOpenCodeConfigEditor(addAfter = false) {
  const editId = String(document.getElementById('opencode-config-edit-id')?.value || '').trim();
  const sourceId = String(document.getElementById('opencode-config-source-id')?.value || '').trim();
  let name = String(document.getElementById('opencode-config-name')?.value || '').trim();
  let baseUrl = String(document.getElementById('opencode-config-base-url')?.value || '').trim();
  let apiKey = String(document.getElementById('opencode-config-api-key')?.value || '').trim();
  let defaultModel = String(document.getElementById('opencode-config-model')?.value || '').trim();
  let settingsConfig = null;
  try {
    settingsConfig = opencodeConfigObjectFromRawOrFields();
  } catch (e) {
    showCustomAlert(`原始配置 JSON 格式无效：${e}`, '配置不完整', 'warn');
    return;
  }
  const validation = opencodeValidateSettingsConfig(settingsConfig);
  if (validation) {
    showCustomAlert(validation, '配置不完整', 'warn');
    return;
  }

  const existing = editId ? opencodeConfigProviderById(editId) : null;
  const boundConn = resolveBoundConnectionForSave({
    sourceId,
    existing,
    baseUrl,
    apiKey,
    formatUrlFn: opencodeConfigDisplayBaseUrl,
  });

  const options = settingsConfig.options && typeof settingsConfig.options === 'object' ? settingsConfig.options : {};
  const modelKeys = opencodeModelKeysFromSettings(settingsConfig);
  name = opencodeConfigNameFromSettings(settingsConfig) || name;
  if (boundConn.bound) {
    // 已绑定主供应商：优先采信主供应商连接字段并覆写 settingsConfig.options，杜绝旧快照反咬
    baseUrl = boundConn.baseUrl;
    apiKey = boundConn.apiKey;
    if (!settingsConfig.options || typeof settingsConfig.options !== 'object' || Array.isArray(settingsConfig.options)) {
      settingsConfig.options = {};
    }
    settingsConfig.options.baseURL = baseUrl;
    settingsConfig.options.apiKey = apiKey;
    delete settingsConfig.options.baseUrl;
  } else {
    baseUrl = opencodeBaseUrlFromOptions(options).trim() || baseUrl;
    apiKey = opencodeApiKeyFromOptions(options).trim() || apiKey;
  }
  defaultModel = modelKeys.includes(defaultModel) ? defaultModel : modelKeys[0] || defaultModel;
  const models = codexConfigParseModels(modelKeys.length ? modelKeys.join('\n') : document.getElementById('opencode-config-models')?.value, defaultModel);
  settingsConfig = opencodeNormalizeSettingsConfig(settingsConfig, name, baseUrl, apiKey, models);

  if (!editId && !sourceId) {
    showCustomAlert('请先选择一个现有供应商。', '没有配置来源', 'warn');
    return;
  }
  if (!name || !baseUrl || !apiKey || !defaultModel) {
    showCustomAlert('请填写配置名称、Base URL、API Key 和默认模型。', '配置不完整', 'warn');
    return;
  }

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.opencodeConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 OpenCode 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('opencode-config-name')?.focus();
    return;
  }
  if (!models.length) {
    showCustomAlert('请至少填写一个模型。', '配置不完整', 'warn');
    return;
  }

  const endpoint = opencodeConfigEndpointParts(baseUrl);
  const source = boundConn.bound ? boundConn.view.source : null;
  const provider = {
    ...(existing || {}),
    id: editId || `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1',
    apiKey,
    defaultModel,
    models,
    settingsConfig,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.opencodeConfigs)) store.opencodeConfigs = [];
      if (editId) {
        const idx = store.opencodeConfigs.findIndex(p => p.id === editId);
        if (idx >= 0) store.opencodeConfigs[idx] = provider;
        else store.opencodeConfigs.push(provider);
      } else {
        store.opencodeConfigs.push(provider);
      }
    },
    renderList: () => renderOpenCodeConfigList(platformInfoOf('opencode') || {}),
  });
  if (!ok) return;
  closeOpenCodeConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 OpenCode 配置: ${name}`);
  if (addAfter) await applyOpenCodeProviderConfig(provider.id);
}

function editOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  openOpenCodeConfigEditor(providerId);
}

async function deleteOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('opencode');
  const isLive = openCodeProviderIsLive(provider, info);

  const confirmMsg = isLive
    ? `「${provider.name || provider.id}」已加入 OpenCode 运行配置。\n\n删除该配置将自动从 OpenCode 中移除并删除。是否确认？`
    : `确定要删除 OpenCode 配置「${provider.name || provider.id}」吗？`;

  const okConfirm = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!okConfirm) return;

  if (isLive) {
    await removeOpenCodeProviderConfig(providerId);
  }

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      store.opencodeConfigs = (store.opencodeConfigs || []).filter(p => p.id !== providerId);
    },
    renderList: () => renderOpenCodeConfigList(platformInfoOf('opencode') || {}),
  });
  if (!ok) return;
  if (typeof addLog === 'function') addLog('info', `已删除 OpenCode 配置: ${provider.name || provider.id}`);
}

async function restoreOpenCodeOfficialConfig() {
  const info = platformInfoOf('opencode') || {};
  const isOfficial = !info.managedByAnyBridge;
  const message = isOfficial
    ? 'OpenCode 当前已经是官方配置。仍要清理 AnyBridge 写入的托管提供商与当前 model 吗？'
    : '将把 OpenCode 切回官方配置。\n\n这会清除 AnyBridge 写入的第三方提供商与当前 model 设定，恢复使用 OpenCode 官方 Zen / Go 套餐与官方登录凭证（auth.json）。新会话或重启 OpenCode 后生效。';
  const ok = await showCustomConfirm(message, '切回官方配置', 'warn');
  if (!ok) return;

  setPlatformBusy('opencode', true);
  showSwitchProgress('opencode', '正在准备切回官方配置…');
  try {
    const result = await invoke('restore_opencode_official_config');
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'OpenCode 已切回官方配置');
    showCustomAlert(result.message || 'OpenCode 已切回官方配置。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `OpenCode 切回官方失败: ${e}`);
    showCustomAlert(String(e), '切回官方失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('opencode', false);
    renderPlatformDetailStatuses();
  }
}

function renderOpenCodeConfigList(info) {
  const list = document.getElementById('platform-opencode-config-list');
  if (!list) return;

  const providers = platformProviderList('opencode');
  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  const isOfficial = !info.managedByAnyBridge;
  const items = [];

  items.push({
    platformId: 'opencode',
    name: '官方默认配置',
    description: '使用 OpenCode 官方订阅套餐（Zen / Go）与官方登录凭证（opencode auth login），无需配置第三方 API。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: isOfficial,
    currentLabel: '当前使用',
    model: '官方默认 (Zen / Go)',
    endpoint: '~/.config/opencode/opencode.json',
    protocol: 'OpenCode 官方',
    action: 'restoreOpenCodeOfficialConfig()',
    actionLabel: '切回官方',
  });

  const opencodeLocalCard = platformLocalProxyCard('opencode', info);
  if (opencodeLocalCard) items.push(opencodeLocalCard);

  liveIds
    .filter(id => !providers.some(provider => provider.id === id))
    .forEach(id => {
      const active = info?.currentProviderId === id;
      items.push({
        platformId: 'opencode',
        name: id,
        description: '由其他工具或手动配置写入。AnyBridge 不会修改这份外部配置。',
        typeLabel: active ? '当前使用' : '外部',
        tone: active ? 'third live' : 'third external',
        current: active,
        currentLabel: '当前使用',
        model: '外部配置',
        endpoint: '~/.config/opencode/opencode.json',
        protocol: 'openai-compatible',
      });
    });

  providers.forEach(provider => {
    const baseUrl = opencodeTargetBaseUrl(provider);
    const live = openCodeProviderIsLive(provider, info);
    const active = info?.currentProviderId === provider.id;
    items.push({
      platformId: 'opencode',
      name: provider.name || provider.id,
      description: '独立 OpenCode provider 配置，应用时追加到 opencode.json 并可设为当前 model。',
      typeLabel: active ? '当前使用' : (live ? '已加入' : '配置'),
      tone: active ? 'third live' : 'third',
      current: active,
      currentLabel: '当前使用',
      model: provider.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: 'openai-compatible',
      action: `applyOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      actionLabel: '切换',
      editAction: `editOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      deleteAction: `deleteOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      removeAction: live ? `removeOpenCodeProviderConfig(${platformJsArg(provider.id)})` : '',
      removeLabel: '移除',
    });
  });

  const filtered = items.filter(opencodeConfigMatchesSearch);
  const count = document.getElementById('opencode-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

function onOpenCodeConfigSearch() {
  const input = document.getElementById('opencode-config-search');
  opencodeConfigSearch = input ? input.value : '';
  const info = platformInfoOf('opencode');
  if (info) renderOpenCodeConfigList(info);
}

async function applyOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法加入', 'error');
    return;
  }

  const model = provider.defaultModel || '默认模型';
  const baseUrl = opencodeTargetBaseUrl(provider);
  const info = platformInfoOf('opencode') || {};
  const live = openCodeProviderIsLive(provider, info);
  const ok = await showCustomConfirm(
    `将把 OpenCode 配置「${provider.name || provider.id}」${live ? '设为当前 model' : '加入 live provider 列表，并设为当前 model'}。\n\n模型：${model}\n地址：${baseUrl}\n\n不会覆盖其他 OpenCode provider。新会话或重启 OpenCode 后生效。`,
    live ? '设为当前 OpenCode 配置' : '加入并设为当前',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy('opencode', true);
  showSwitchProgress('opencode', live ? '正在准备设置当前 OpenCode 配置…' : '正在准备加入 OpenCode 配置…');
  try {
    const result = await invoke('switch_platform', { platform: 'opencode', providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'OpenCode 配置已设置');
    showCustomAlert(result.message || 'OpenCode 配置已设置。', '设置完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `OpenCode 配置设置失败: ${e}`);
    showCustomAlert(String(e), '设置失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('opencode', false);
    renderPlatformDetailStatuses();
  }
}

async function removeOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  const label = provider?.name || providerId;
  const ok = await showCustomConfirm(
    `将从 OpenCode live 配置移除「${label}」。\n\n保存的 OpenCode 配置方案仍会保留，可稍后重新加入。`,
    '移除 OpenCode 配置',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy('opencode', true);
  try {
    const result = await invoke('remove_opencode_config_from_live', { providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || '已从 OpenCode 移除配置');
    showCustomAlert(result.message || '已从 OpenCode 移除配置。', '移除完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `OpenCode 移除失败: ${e}`);
    showCustomAlert(String(e), '移除失败', 'error');
  } finally {
    setPlatformBusy('opencode', false);
    renderPlatformDetailStatuses();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.syncOpenCodeConfigTokenFromSource = syncOpenCodeConfigTokenFromSource;
  g.openOpenCodeAddModal = openOpenCodeAddModal;
  g.openOpenCodeProviderAdd = openOpenCodeProviderAdd;
  g.initOpenCodeConfigEditorPage = initOpenCodeConfigEditorPage;
  g.initOpenCodeAddPage = initOpenCodeAddPage;
  g.onOpenCodeAddSearch = onOpenCodeAddSearch;
  g.renderOpenCodeAddProviderList = renderOpenCodeAddProviderList;
  g.selectOpenCodeAddProvider = selectOpenCodeAddProvider;
  g.renderOpenCodeAddModels = renderOpenCodeAddModels;
  g.updateOpenCodeAddConfirmButton = updateOpenCodeAddConfirmButton;
  g.opencodeAddSelectAll = opencodeAddSelectAll;
  g.opencodeAddSelectNone = opencodeAddSelectNone;
  g.confirmAddOpenCodeModelsPage = confirmAddOpenCodeModelsPage;
  g.openOpenCodeConfigEditor = openOpenCodeConfigEditor;
  g.closeOpenCodeConfigEditor = closeOpenCodeConfigEditor;
  g.syncOpenCodeConfigUiAfterStoreChange = syncOpenCodeConfigUiAfterStoreChange;
  g.saveOpenCodeConfigEditor = saveOpenCodeConfigEditor;
  g.editOpenCodeProviderConfig = editOpenCodeProviderConfig;
  g.deleteOpenCodeProviderConfig = deleteOpenCodeProviderConfig;
  g.restoreOpenCodeOfficialConfig = restoreOpenCodeOfficialConfig;
  g.renderOpenCodeConfigList = renderOpenCodeConfigList;
  g.onOpenCodeConfigSearch = onOpenCodeConfigSearch;
  g.applyOpenCodeProviderConfig = applyOpenCodeProviderConfig;
  g.removeOpenCodeProviderConfig = removeOpenCodeProviderConfig;
})(globalThis);
