// platforms/claude_code_editor.js — split from 55-platforms.js
function syncClaudeCodeConfigTokenFromSource() {
  const sourceId = String(document.getElementById('claude-code-config-source-id')?.value || '').trim();
  const editId = String(document.getElementById('claude-code-config-edit-id')?.value || '').trim();
  const existing = editId ? claudeCodeConfigProviderById(editId) : null;
  const targetSourceId = sourceId || existing?.sourceProviderId || '';
  const configName = String(document.getElementById('claude-code-config-name')?.value || '').trim();

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

  codexConfigSetInputValue('claude-code-config-source-id', source.id);
  codexConfigSetInputValue('claude-code-config-api-key', source.apiKey || '');
  const newEndpoint = claudeCodeConfigDisplayBaseUrl(source);
  if (newEndpoint) codexConfigSetInputValue('claude-code-config-base-url', newEndpoint);
  syncClaudeCodeRawConfigFromFields();

  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌`, 'success');
  }
}

async function fetchClaudeCodeConfigModels() {
  if (!invoke) return;
  const baseUrl = String(document.getElementById('claude-code-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('claude-code-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  await runRaceGuardedModelFetch({
    getSeq: () => claudeCodeConfigModelFetchSeq,
    bumpSeq: () => ++claudeCodeConfigModelFetchSeq,
    setLoadingFn: claudeCodeConfigSetFetchLoading,
    setStatusFn: claudeCodeConfigSetModelStatus,
    loadingStatusText: '正在拉取模型列表...',
    fetcher: async (_seq, isCurrent) => {
      let result = null;
      let lastError = null;
      for (const apiFormat of ['openai', 'anthropic']) {
        if (!isCurrent()) return null;
        try {
          claudeCodeConfigSetModelStatus(
            apiFormat === 'openai'
              ? '正在按 /v1/models 拉取模型列表...'
              : '正在按 Anthropic 鉴权重试模型列表...',
            'loading'
          );
          result = await fetchClaudeCodeConfigModelsWithFormat(baseUrl, apiKey, apiFormat);
          if (result?.models?.length) break;
          lastError = new Error(`${apiFormat === 'openai' ? 'OpenAI' : 'Anthropic'} 协议返回的模型列表为空`);
        } catch (e) {
          lastError = e;
        }
      }
      if (!result?.models?.length) throw lastError || new Error('接口返回的模型列表为空');
      return result;
    },
    onSuccess: async (result) => {
      const isAnyRouter = isAnyRouterEndpoint(baseUrl, document.getElementById('claude-code-config-name')?.value || '');
      const models = codexConfigNormalizeModels(result?.models || []);
      if (!models.length) throw new Error('接口返回的模型列表为空');

      refreshAllClaudeRoleSelects(models);

      // 同步更新当前选中供应商在界面列表与内存中的模型，并事务落盘
      const currentSourceId = document.getElementById('claude-code-config-source-id')?.value;
      if (currentSourceId) {
        const pInList = (claudeProviderModels || []).find(p => p.providerId === currentSourceId);
        if (pInList) {
          pInList.models = models.map(m => ({ id: m, name: m }));
        }
        await mutateProviderStore(store => {
          const pInStore = (store.providers || []).find(p => p.id === currentSourceId);
          if (!pInStore) return false;
          pInStore.models = [...models];
        }, { silent: true });
        renderClaudeAddProviderList();
      }

      const currentFb = document.getElementById('claude-code-config-model')?.value?.trim();
      const currentSonnet = document.getElementById('claude-model-id-sonnet')?.value?.trim();
      if ((!currentFb || currentFb === '__custom__') && (!currentSonnet || currentSonnet === '__custom__') && models[0]) {
        const clean = stripClaude1mMarker(models[0]);
        const use1m = isAnyRouter && isClaudeModel(clean);

        CLAUDE_ROLES.forEach(r => {
          setClaudeRoleSelectValue(`claude-model-id-${r.role}`, clean);
          if (r.nameKey) {
            const nameInput = document.getElementById(`claude-model-name-${r.role}`);
            if (nameInput) nameInput.value = clean;
          }
          if (r.has1m) setClaude1mCheckbox(r.role, use1m);
        });
        setClaudeRoleSelectValue('claude-code-config-model', clean);
        setClaude1mCheckbox('fallback', use1m);
      }

      claudeCodeConfigSetModelStatus(`已拉取 ${models.length} 个模型（可在下拉框中直接点选）`, 'success');
      syncClaudeCodeRawConfigFromFields();
      if (typeof addLog === 'function') addLog('ok', `Claude Code 配置模型拉取成功: ${models.length} 个`);
    },
    onError: (e) => {
      claudeCodeConfigSetModelStatus('拉取失败，可手动输入默认模型', 'error');
      if (typeof addLog === 'function') addLog('warn', `Claude Code 配置模型拉取失败: ${e}`);
      showCustomAlert(String(e), '模型拉取失败', 'error');
    },
  });
}

function claudeCodeProviderIsCurrent(provider, info) {
  const config = (info && info.claudeConfig) || {};
  if (!provider || !config || config.isOfficial) return false;
  const targetBase = claudeCodeTargetBaseUrl(provider).replace(/\/+$/, '').toLowerCase();
  const currentBase = String(config.baseUrl || '').replace(/\/+$/, '').toLowerCase();
  const sameBase = targetBase && currentBase && targetBase === currentBase;
  const sameModel = !config.model || !provider.defaultModel || config.model === provider.defaultModel;
  return sameBase && sameModel;
}

function claudeCodeConfigMatchesSearch(config) {
  const kw = claudeCodeConfigSearch.trim().toLowerCase();
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

async function openClaudeCodeAddModal() {
  await openClaudeCodeConfigEditor();
}

function openClaudeCodeProviderAdd() {
  openClaudeCodeConfigEditor();
}

async function initClaudeCodeConfigEditorPage(providerId = '') {
  claudeProviderModels = await loadConfigEditorProviderModels();
  claudeAddSearchKw = '';
  const searchInput = document.getElementById('claude-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? claudeCodeConfigProviderById(providerId) : null;
  claudeCodeConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('claude-code-config-page-title');
  const subEl = document.getElementById('claude-code-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · Claude Code' : '添加配置 · Claude Code';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 Claude Code 配置。`
      : '从现有 Anthropic 供应商创建或自由定制一份可切换的 Claude Code 独立配置。';
  }

  codexConfigSetInputValue('claude-code-config-edit-id', provider?.id || '');

  if (provider) {
    const bound = resolveConfigEditorBoundView(provider);
    const liveProvider = bound.hasSource
      ? { ...provider, apiHost: bound.apiHost, apiPath: bound.apiPath, apiKey: bound.apiKey }
      : provider;

    claudeAddSelectedProvider = provider.sourceProviderId || null;
    renderClaudeAddProviderList();

    codexConfigSetInputValue('claude-code-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('claude-code-config-name', provider.name || '');
    const baseUrl = claudeCodeConfigDisplayBaseUrl(liveProvider);
    codexConfigSetInputValue('claude-code-config-base-url', baseUrl);
    codexConfigSetInputValue('claude-code-config-api-key', liveProvider.apiKey || '');

    // 若已绑定主供应商，先同步 env 中的实时 URL/Key，避免回填与 raw JSON 展示过期连接快照
    let effectiveSettings = provider.settingsConfig || null;
    if (bound.hasSource && effectiveSettings && typeof effectiveSettings === 'object') {
      effectiveSettings = JSON.parse(JSON.stringify(effectiveSettings));
      if (!effectiveSettings.env || typeof effectiveSettings.env !== 'object' || Array.isArray(effectiveSettings.env)) {
        effectiveSettings.env = {};
      }
      effectiveSettings.env.ANTHROPIC_BASE_URL = baseUrl;
      effectiveSettings.env.ANTHROPIC_AUTH_TOKEN = liveProvider.apiKey || '';
      if ('ANTHROPIC_API_KEY' in effectiveSettings.env) {
        effectiveSettings.env.ANTHROPIC_API_KEY = liveProvider.apiKey || '';
      }
    }

    // 回填角色模型与 1M 复选框
    claudeCodeApplySettingsToRoleForm(effectiveSettings, liveProvider);

    const sourceModels = bound.source ? codexConfigModelList(bound.source) : [];
    const models = codexConfigModelList(liveProvider);
    const allCandidates = [...new Set([...models, ...sourceModels])];
    refreshAllClaudeRoleSelects(allCandidates);
    claudeCodeConfigSetModelStatus(`已加载「${provider.name || provider.id}」配置`, 'success');
    claudeCodeSetRawSettings(effectiveSettings || claudeCodeBuildSettingsForProvider(liveProvider, models));
  } else {
    codexConfigSetInputValue('claude-code-config-source-id', '');
    codexConfigSetInputValue('claude-code-config-name', '');
    codexConfigSetInputValue('claude-code-config-base-url', '');
    codexConfigSetInputValue('claude-code-config-api-key', '');
    refreshAllClaudeRoleSelects([]);
    setClaudeRoleSelectValue('claude-code-config-model', '');
    CLAUDE_ROLES.forEach(r => {
      setClaudeRoleSelectValue(`claude-model-id-${r.role}`, '');
      if (r.nameKey) {
        const nameInput = document.getElementById(`claude-model-name-${r.role}`);
        if (nameInput) nameInput.value = '';
      }
      if (r.has1m) setClaude1mCheckbox(r.role, false);
    });
    setClaude1mCheckbox('fallback', false);
    claudeCodeConfigSetModelStatus('请选择左侧供应商带入或手动填写', '');

    const firstProvider = claudeProviderModels[0];
    if (firstProvider) {
      claudeAddSelectedProvider = firstProvider.providerId;
      renderClaudeAddProviderList();
      applyClaudeCodeConfigSource(firstProvider.providerId);
    } else {
      claudeAddSelectedProvider = null;
      renderClaudeAddProviderList();
    }
  }

  await loadPlatformRealConfigFile('claude-code', 'claude-code-config-raw-json');

  window.setTimeout(() => {
    document.getElementById('claude-code-config-name')?.focus();
  }, 50);
}

async function initClaudeAddPage() {
  await initClaudeCodeConfigEditorPage();
}

function onClaudeAddSearch() {
  const input = document.getElementById('claude-add-search');
  claudeAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderClaudeAddProviderList();
}

function renderClaudeAddProviderList() {
  renderConfigAddProviderList({
    listId: 'claude-add-provider-list',
    sortPrefix: 'claude',
    providers: claudeProviderModels,
    keyword: claudeAddSearchKw,
    selectedProviderId: claudeAddSelectedProvider,
    selectAction: 'selectClaudeAddProvider',
  });
}

function selectClaudeAddProvider(providerId) {
  claudeAddSelectedProvider = providerId;
  renderClaudeAddProviderList();
  applyClaudeCodeConfigSource(providerId);
}

function renderClaudeAddModels() {
  const claudeConfigs = Array.isArray(providerStore?.claudeCodeConfigs) ? providerStore.claudeCodeConfigs : [];
  let cachedProviderId = null;
  let existingModels = new Set();
  renderConfigAddModelChecklist({
    titleId: 'claude-add-models-title',
    subId: 'claude-add-models-sub',
    bodyId: 'claude-add-models-list-page',
    selectedProviderId: claudeAddSelectedProvider,
    providers: claudeProviderModels,
    platformLabel: 'Claude Code',
    preferredFamily: 'claude',
    checkClass: 'claude-add-model-check',
    updateAction: 'updateClaudeAddConfirmButton',
    isChecked: (m, provider) => {
      if (cachedProviderId !== provider.providerId) {
        cachedProviderId = provider.providerId;
        const existingConfig = claudeConfigs.find(c => c.sourceProviderId === provider.providerId || c.name === provider.providerName);
        existingModels = new Set(existingConfig?.models || []);
      }
      return existingModels.has(m.id);
    },
  });
}

function updateClaudeAddConfirmButton() {
  updateConfigAddConfirmButtonState('claude-add-confirm-page', '.claude-add-model-check');
}

function claudeAddSelectAll() {
  cbSetAddModelChecks('.claude-add-model-check', true, updateClaudeAddConfirmButton);
}

function claudeAddSelectNone() {
  cbSetAddModelChecks('.claude-add-model-check', false, updateClaudeAddConfirmButton);
}

async function confirmAddClaudeModelsPage() {
  const provider = claudeProviderModels.find(p => p.providerId === claudeAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.claude-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const checkedModelIds = checkedInputs.map(input => input.dataset.modelId);
  const defaultModel = checkedModelIds[0] || '';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1/messages'}` : '');
  const endpoint = claudeCodeConfigEndpointParts(rawBaseUrl);

  const maxRetries = Number(document.getElementById('claude-add-max-retries')?.value || 10);
  const sanitizedProvider = grok_sanitize_key(provider.providerId);
  const configId = `claude-code-${sanitizedProvider}`;

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.claudeCodeConfigs)) store.claudeCodeConfigs = [];
      const existingIdx = store.claudeCodeConfigs.findIndex(p =>
        p.id === configId || p.sourceProviderId === provider.providerId
      );
      const existing = existingIdx >= 0 ? store.claudeCodeConfigs[existingIdx] : null;
      const settingsConfig = claudeCodeBuildSettingsForProvider({
        name: provider.providerName,
        apiHost: endpoint.apiHost || provider.apiHost,
        apiPath: endpoint.apiPath || provider.apiPath || '/v1/messages',
        apiKey: provider.apiKey || '',
        settingsConfig: existing?.settingsConfig || null,
      }, checkedModelIds);

      if (settingsConfig && settingsConfig.env) {
        settingsConfig.env.ANTHROPIC_MAX_RETRIES = String(maxRetries);
      }

      const configItem = {
        ...(existing || {}),
        id: existing?.id || configId,
        name: provider.providerName,
        apiHost: endpoint.apiHost || provider.apiHost,
        apiPath: endpoint.apiPath || provider.apiPath || '/v1/messages',
        apiKey: provider.apiKey || '',
        defaultModel,
        models: checkedModelIds,
        settingsConfig,
        sourceProviderId: provider.providerId,
        sourceProviderName: provider.providerName,
      };

      if (existingIdx >= 0) {
        store.claudeCodeConfigs[existingIdx] = configItem;
      } else {
        store.claudeCodeConfigs.push(configItem);
      }
    },
    renderList: () => renderClaudeCodeConfigList(platformInfoOf('claude-code') || {}),
  });
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 Claude Code 配置: ${provider.providerName} (${checkedModelIds.length} 个模型)`);
    showCustomAlert(`已成功保存「${provider.providerName}」的 Claude Code 配置（共 ${checkedModelIds.length} 个模型）。`, '保存成功', 'success');
    navigateTo('platform-claude-code');
    renderClaudeCodeConfigList(platformInfoOf('claude-code') || {});
  }
}

async function openClaudeCodeConfigEditor(providerId = '') {
  resetPasswordInputVisibility('claude-code-config-api-key', 'claude-code-config-api-key-toggle');
  navigateTo('platform-claude-add');
  await initClaudeCodeConfigEditorPage(providerId);
}

function closeClaudeCodeConfigEditor() {
  resetPasswordInputVisibility('claude-code-config-api-key', 'claude-code-config-api-key-toggle');
  document.getElementById('claude-code-config-modal')?.classList.remove('active');
  navigateTo('platform-claude-code');
}

async function syncClaudeCodeConfigUiAfterStoreChange() {
  return commitPlatformConfigMutation({
    mutator: () => {},
    renderList: () => renderClaudeCodeConfigList(platformInfoOf('claude-code') || {}),
  });
}

async function saveClaudeCodeConfigEditor(switchAfter = false) {
  const editId = String(document.getElementById('claude-code-config-edit-id')?.value || '').trim();
  const sourceId = String(document.getElementById('claude-code-config-source-id')?.value || '').trim();
  const name = String(document.getElementById('claude-code-config-name')?.value || '').trim();
  let baseUrl = String(document.getElementById('claude-code-config-base-url')?.value || '').trim();
  let apiKey = String(document.getElementById('claude-code-config-api-key')?.value || '').trim();
  let defaultModel = String(document.getElementById('claude-code-config-model')?.value || '').trim();
  const isAnyRouter = isAnyRouterEndpoint(baseUrl, name);
  defaultModel = ensureOneMContextMarker(defaultModel, isAnyRouter);
  let settingsConfig = null;
  try {
    settingsConfig = claudeCodeConfigObjectFromRawOrFields();
  } catch (e) {
    showCustomAlert(`原始配置 JSON 格式无效：${e}`, '配置不完整', 'warn');
    return;
  }
  const validation = claudeCodeValidateSettingsConfig(settingsConfig);
  if (validation) {
    showCustomAlert(validation, '配置不完整', 'warn');
    return;
  }
  const existing = editId ? claudeCodeConfigProviderById(editId) : null;
  const boundConn = resolveBoundConnectionForSave({
    sourceId,
    existing,
    baseUrl,
    apiKey,
    formatUrlFn: claudeCodeConfigDisplayBaseUrl,
  });
  if (boundConn.bound) {
    // 已绑定主供应商：优先采信主供应商连接字段并强制覆写 settingsConfig.env，杜绝旧快照反咬
    baseUrl = boundConn.baseUrl;
    apiKey = boundConn.apiKey;
    settingsConfig = claudeCodeNormalizeSettingsConfig(settingsConfig, baseUrl, apiKey, defaultModel);
    if (!settingsConfig.env || typeof settingsConfig.env !== 'object' || Array.isArray(settingsConfig.env)) {
      settingsConfig.env = {};
    }
    settingsConfig.env.ANTHROPIC_BASE_URL = baseUrl;
    settingsConfig.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    if ('ANTHROPIC_API_KEY' in settingsConfig.env) {
      settingsConfig.env.ANTHROPIC_API_KEY = apiKey;
    }
    delete settingsConfig.apiKey;
  } else {
    settingsConfig = claudeCodeNormalizeSettingsConfig(settingsConfig, baseUrl, apiKey, defaultModel);
    const env = settingsConfig && typeof settingsConfig === 'object' ? settingsConfig.env || {} : {};
    baseUrl = claudeCodeBaseUrlFromEnv(env) || baseUrl;
    apiKey = claudeCodeApiKeyFromSettings(settingsConfig) || apiKey;
  }
  defaultModel = claudeCodeEnvModel(settingsConfig) || defaultModel;
  const models = claudeCodeExtractModelsFromRoleForm();
  if (!models.length) {
    showCustomAlert('请至少在角色映射表中输入一个模型（例如 Sonnet 或默认兜底模型）。', '模型未填写', 'warn');
    return;
  }
  if (!defaultModel) {
    defaultModel = models[0];
    codexConfigSetInputValue('claude-code-config-model', defaultModel);
  }

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.claudeCodeConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Claude Code 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('claude-code-config-name')?.focus();
    return;
  }

  const endpoint = claudeCodeConfigEndpointParts(baseUrl);
  const source = boundConn.bound ? boundConn.view.source : null;
  const provider = {
    ...(existing || {}),
    id: editId || `claude-code-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1/messages',
    apiKey,
    defaultModel,
    models,
    settingsConfig,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.claudeCodeConfigs)) store.claudeCodeConfigs = [];
      if (editId) {
        const idx = store.claudeCodeConfigs.findIndex(p => p.id === editId);
        if (idx >= 0) store.claudeCodeConfigs[idx] = provider;
        else store.claudeCodeConfigs.push(provider);
      } else {
        store.claudeCodeConfigs.push(provider);
      }
    },
    renderList: () => renderClaudeCodeConfigList(platformInfoOf('claude-code') || {}),
  });
  if (!ok) return;
  closeClaudeCodeConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 Claude Code 配置: ${name}`);
  if (switchAfter) await applyClaudeCodeProviderConfig(provider.id);
}

function editClaudeCodeProviderConfig(providerId) {
  const provider = claudeCodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  openClaudeCodeConfigEditor(providerId);
}

async function deleteClaudeCodeProviderConfig(providerId) {
  const provider = claudeCodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('claude-code');
  const isCurrent = claudeCodeProviderIsCurrent(provider, info);

  const confirmMsg = isCurrent
    ? `「${provider.name || provider.id}」当前正在生效中。\n\n删除该配置将自动为您恢复为「官方默认配置」。是否确认删除？`
    : `确定要删除 Claude Code 配置「${provider.name || provider.id}」吗？`;

  const okConfirm = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!okConfirm) return;

  if (isCurrent) {
    await restoreClaudeCodeOfficialConfig();
  }

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      store.claudeCodeConfigs = (store.claudeCodeConfigs || []).filter(p => p.id !== providerId);
    },
    renderList: () => renderClaudeCodeConfigList(platformInfoOf('claude-code') || {}),
  });
  if (!ok) return;
  if (typeof addLog === 'function') addLog('info', `已删除 Claude Code 配置: ${provider.name || provider.id}`);
}

function renderClaudeCodeConfigList(info) {
  const list = document.getElementById('platform-claude-code-config-list');
  if (!list) return;

  const providers = platformProviderList('claude-code');
  const config = (info && info.claudeConfig) || {};
  const items = [];

  items.push({
    platformId: 'claude-code',
    name: '官方默认配置',
    description: '使用 Claude Code 官方登录态，不写入第三方地址和 token。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: !!config.isOfficial || (!info.currentProviderId && !config.baseUrl),
    model: config.isOfficial && config.model ? config.model : '官方默认',
    endpoint: '~/.claude/settings.json',
    protocol: 'anthropic',
    action: 'restoreClaudeCodeOfficialConfig()',
  });

  const claudeLocalCard = platformLocalProxyCard('claude-code', info);
  if (claudeLocalCard) items.push(claudeLocalCard);

  const isExternal = !!info.currentProviderId && !config.isOfficial && !info.managedByAnyBridge
    && !providers.some(provider => claudeCodeProviderIsCurrent(provider, info));
  if (isExternal) {
    items.push({
      platformId: 'claude-code',
      name: info.currentProviderName || '当前外部配置',
      description: '由其他工具或手动配置写入。可以保留，也可以切换到下方任一配置。',
      typeLabel: '外部',
      tone: 'third external',
      current: true,
      model: config.model || '未知模型',
      endpoint: config.baseUrl || info.currentProviderId,
      protocol: 'anthropic',
    });
  }

  providers.forEach(provider => {
    const baseUrl = claudeCodeTargetBaseUrl(provider);
    const current = claudeCodeProviderIsCurrent(provider, info);
    items.push({
      platformId: 'claude-code',
      name: provider.name || provider.id,
      description: '第三方 Anthropic API 兼容配置。',
      typeLabel: '第三方',
      tone: 'third',
      current,
      model: provider.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: 'anthropic',
      action: `applyClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
      editAction: `editClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
      deleteAction: `deleteClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
    });
  });

  const filtered = items.filter(claudeCodeConfigMatchesSearch);
  const count = document.getElementById('claude-code-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

function onClaudeCodeConfigSearch() {
  const input = document.getElementById('claude-code-config-search');
  claudeCodeConfigSearch = input ? input.value : '';
  const info = platformInfoOf('claude-code');
  if (info) renderClaudeCodeConfigList(info);
}

function opencodeConfigProviderById(id) {
  return (providerStore.opencodeConfigs || []).find(p => p && p.id === id) || null;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.syncClaudeCodeConfigTokenFromSource = syncClaudeCodeConfigTokenFromSource;
  g.fetchClaudeCodeConfigModels = fetchClaudeCodeConfigModels;
  g.claudeCodeProviderIsCurrent = claudeCodeProviderIsCurrent;
  g.claudeCodeConfigMatchesSearch = claudeCodeConfigMatchesSearch;
  g.openClaudeCodeAddModal = openClaudeCodeAddModal;
  g.openClaudeCodeProviderAdd = openClaudeCodeProviderAdd;
  g.initClaudeCodeConfigEditorPage = initClaudeCodeConfigEditorPage;
  g.initClaudeAddPage = initClaudeAddPage;
  g.onClaudeAddSearch = onClaudeAddSearch;
  g.renderClaudeAddProviderList = renderClaudeAddProviderList;
  g.selectClaudeAddProvider = selectClaudeAddProvider;
  g.renderClaudeAddModels = renderClaudeAddModels;
  g.updateClaudeAddConfirmButton = updateClaudeAddConfirmButton;
  g.claudeAddSelectAll = claudeAddSelectAll;
  g.claudeAddSelectNone = claudeAddSelectNone;
  g.confirmAddClaudeModelsPage = confirmAddClaudeModelsPage;
  g.openClaudeCodeConfigEditor = openClaudeCodeConfigEditor;
  g.closeClaudeCodeConfigEditor = closeClaudeCodeConfigEditor;
  g.syncClaudeCodeConfigUiAfterStoreChange = syncClaudeCodeConfigUiAfterStoreChange;
  g.saveClaudeCodeConfigEditor = saveClaudeCodeConfigEditor;
  g.editClaudeCodeProviderConfig = editClaudeCodeProviderConfig;
  g.deleteClaudeCodeProviderConfig = deleteClaudeCodeProviderConfig;
  g.renderClaudeCodeConfigList = renderClaudeCodeConfigList;
  g.onClaudeCodeConfigSearch = onClaudeCodeConfigSearch;
  g.opencodeConfigProviderById = opencodeConfigProviderById;
})(globalThis);
