// platforms/grok_editor.js — split from 55-platforms.js
function selectGrokAddProvider(providerId) {
  grokAddSelectedProvider = providerId;
  renderGrokAddProviderList();
  const provider = grokProviderModels.find(p => p.providerId === providerId);
  if (provider) {
    applyGrokConfigSource(provider);
  }
}

function renderGrokAddModels() {
  const grokConfigs = Array.isArray(providerStore?.grokConfigs) ? providerStore.grokConfigs : [];
  renderConfigAddModelChecklist({
    titleId: 'grok-add-models-title',
    subId: 'grok-add-models-sub',
    bodyId: 'grok-add-models-list-page',
    selectedProviderId: grokAddSelectedProvider,
    providers: grokProviderModels,
    platformLabel: 'Grok',
    preferredFamily: 'grok',
    checkClass: 'grok-add-model-check',
    updateAction: 'updateGrokAddConfirmButton',
    isChecked: (m, provider) => grokConfigs.some(cfg =>
      (cfg.sourceProviderId === provider.providerId || cfg.id === `grok-${grok_sanitize_key(provider.providerId)}-${grok_sanitize_key(m.id)}`) && cfg.defaultModel === m.id
    ),
  });
}

function updateGrokAddConfirmButton() {
  updateConfigAddConfirmButtonState('grok-add-confirm-page', '.grok-add-model-check');
}

function grokAddSelectAll() {
  cbSetAddModelChecks('.grok-add-model-check', true, updateGrokAddConfirmButton);
}

function grokAddSelectNone() {
  cbSetAddModelChecks('.grok-add-model-check', false, updateGrokAddConfirmButton);
}

async function confirmAddGrokModelsPage() {
  const provider = grokProviderModels.find(p => p.providerId === grokAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.grok-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const apiBackend = document.getElementById('grok-add-backend')?.value || 'chat_completions';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1'}` : '');
  const endpoint = grokConfigEndpointParts(rawBaseUrl);

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.grokConfigs)) store.grokConfigs = [];
      checkedInputs.forEach(input => {
        const modelId = input.dataset.modelId;
        const modelName = input.dataset.modelName || modelId;
        const sanitizedProvider = grok_sanitize_key(provider.providerId);
        const sanitizedModel = grok_sanitize_key(modelId);
        const configId = `grok-${sanitizedProvider}-${sanitizedModel}`;

        const existingIdx = store.grokConfigs.findIndex(cfg =>
          cfg.id === configId || (cfg.sourceProviderId === provider.providerId && cfg.defaultModel === modelId)
        );

        const configItem = {
          id: existingIdx >= 0 ? store.grokConfigs[existingIdx].id : configId,
          name: `${provider.providerName} - ${modelName}`,
          apiHost: endpoint.apiHost || provider.apiHost,
          apiPath: endpoint.apiPath || provider.apiPath || '/v1',
          apiKey: provider.apiKey || '',
          defaultModel: modelId,
          apiBackend: apiBackend,
          contextWindow: grokRecommendContextWindow(modelId),
          sourceProviderId: provider.providerId,
          sourceProviderName: provider.providerName,
        };

        if (existingIdx >= 0) {
          store.grokConfigs[existingIdx] = configItem;
        } else {
          store.grokConfigs.push(configItem);
        }
      });
    },
    renderList: () => renderGrokConfigList(platformInfoOf('grok') || {}),
  });
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 ${checkedInputs.length} 个模型到 Grok 配置`);
    showCustomAlert(`已成功保存 ${checkedInputs.length} 个 Grok 模型配置。`, '保存成功', 'success');
    navigateTo('platform-grok');
    renderGrokConfigList(platformInfoOf('grok') || {});
  }
}

async function openGrokConfigEditor(providerId = '') {
  resetPasswordInputVisibility('grok-config-api-key', 'grok-config-api-key-toggle');
  navigateTo('platform-grok-add');
  await initGrokConfigEditorPage(providerId);
}

function closeGrokConfigEditor() {
  resetPasswordInputVisibility('grok-config-api-key', 'grok-config-api-key-toggle');
  document.getElementById('grok-config-modal')?.classList.remove('active');
  navigateTo('platform-grok');
}

function syncGrokConfigTokenFromSource() {
  const sourceId = document.getElementById('grok-config-source-id')?.value;
  const source = (providerStore.providers || []).find(p => p.id === sourceId);
  if (!source) {
    showCustomAlert('未关联来源供应商，无法自动同步。', '提示', 'info');
    return;
  }
  codexConfigSetInputValue('grok-config-api-key', source.apiKey || '');
  codexConfigSetInputValue('grok-config-base-url', openai_base_url_from_source(source));
  if (source.defaultModel) {
    // 同步令牌后按新来源刷新模型列表，默认模型保持注册
    const current = getGrokModelEntries();
    const seen = new Set(current.map(e => e.model));
    const merged = [...current.map(e => ({ ...e }))];
    grokModelIdsOf(source.models || []).forEach(id => {
      if (seen.has(id)) return;
      seen.add(id);
      merged.push({ model: id, displayName: '', contextWindow: grokRecommendContextWindow(id), inCatalog: false, isDefault: false });
    });
    const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
    const defaultModel = current.find(e => e.isDefault)?.model || source.defaultModel;
    renderGrokModelManager(sortFn(merged, 'grok'), defaultModel);
  }
  if (typeof addLog === 'function') addLog('info', `已从来源供应商「${source.name}」同步最新配置`);
}

async function syncGrokConfigUiAfterStoreChange() {
  return commitPlatformConfigMutation({
    mutator: () => {},
    renderList: () => renderGrokConfigList(platformInfoOf('grok') || {}),
  });
}

async function saveGrokConfigEditor(addAfter = false) {
  const editId = document.getElementById('grok-config-edit-id')?.value.trim();
  const sourceId = document.getElementById('grok-config-source-id')?.value.trim();
  // 名称留空时自动取来源供应商名，别让用户卡在这一步
  const name = document.getElementById('grok-config-name')?.value.trim()
    || (providerStore.providers || []).find(p => p && p.id === sourceId)?.name
    || (grokProviderModels || []).find(p => p && p.providerId === sourceId)?.providerName
    || '';
  let rawBaseUrl = document.getElementById('grok-config-base-url')?.value.trim();
  let apiKey = document.getElementById('grok-config-api-key')?.value.trim();
  const apiBackend = document.getElementById('grok-config-backend')?.value.trim() || 'chat_completions';

  const existing = editId ? grokConfigProviderById(editId) : null;
  const boundConn = resolveBoundConnectionForSave({
    sourceId,
    existing,
    baseUrl: rawBaseUrl,
    apiKey,
    formatUrlFn: view => view.apiHost ? (view.apiHost.replace(/\/+$/, '') + (view.apiPath || '/v1')) : '',
  });
  if (boundConn.bound) {
    rawBaseUrl = boundConn.baseUrl;
    apiKey = boundConn.apiKey;
  }

  if (!name) {
    showCustomAlert('请输入配置名称。', '无法保存', 'warn');
    return;
  }

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.grokConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Grok 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('grok-config-name')?.focus();
    return;
  }
  if (!rawBaseUrl) {
    showCustomAlert('请输入 Base URL。', '无法保存', 'warn');
    return;
  }

  const registered = grokRegisteredEntries();
  if (!registered.length) {
    showCustomAlert('请至少勾选注册一个模型（列表里勾选，或点「添加模型」手动输入）。', '无法保存', 'warn');
    return;
  }
  // 没有显式设默认时取第一个注册模型，避免 [models].default 指向不存在的段
  const defaultEntry = registered.find(e => e.isDefault) || registered[0];
  const defaultModel = defaultEntry.model;
  registered.forEach(e => { e.isDefault = e.model === defaultModel; });

  const endpoint = grokConfigEndpointParts(rawBaseUrl);
  const source = boundConn.bound ? boundConn.view.source : null;

  const models = registered.map(e => e.model);
  // 逐模型的上下文窗口：留空的按模型推荐值填，避免小上下文模型按 200,000 处理永不压缩
  const modelContexts = {};
  registered.forEach(e => {
    modelContexts[e.model] = grokEntryContext(e);
  });
  const contextWindow = modelContexts[defaultModel];
  // 子代理覆盖：留空（继承主模型）的类型不落盘
  const subagentModels = {};
  Object.entries(grokSubagentModels || {}).forEach(([agent, target]) => {
    if (String(agent).trim() && String(target).trim()) {
      subagentModels[String(agent).trim()] = String(target).trim();
    }
  });

  const config = {
    ...(existing || {}),
    id: editId || `grok-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1',
    apiKey,
    defaultModel,
    models,
    apiBackend,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
    contextWindow,
    modelContexts,
    subagentModels,
  };

  const ok = await commitPlatformConfigMutation({
    mutator: store => {
      if (!Array.isArray(store.grokConfigs)) store.grokConfigs = [];
      if (editId) {
        const idx = store.grokConfigs.findIndex(p => p.id === editId);
        if (idx >= 0) store.grokConfigs[idx] = config;
        else store.grokConfigs.push(config);
      } else {
        store.grokConfigs.push(config);
      }
    },
    renderList: () => renderGrokConfigList(platformInfoOf('grok') || {}),
  });
  if (!ok) return;
  closeGrokConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 Grok 配置: ${name}`);
  if (addAfter) await applyGrokProviderConfig(config.id);
}

function editGrokProviderConfig(providerId) {
  openGrokConfigEditor(providerId);
}

async function deleteGrokProviderConfig(providerId) {
  const provider = grokConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('grok');
  const isCurrent = info && (info.currentProviderId === providerId || info.currentProviderId === grok_sanitize_key(providerId));

  const confirmMsg = isCurrent
    ? `「${provider.name || provider.id}」当前正在生效中。\n\n删除该配置将自动为您恢复为「官方默认配置」。是否确认删除？`
    : `确认删除 Grok 配置「${provider.name || provider.id}」吗？`;

  const ok = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!ok) return;

  if (isCurrent) {
    await restoreGrokOfficialConfig();
  }

  const synced = await commitPlatformConfigMutation({
    mutator: store => {
      store.grokConfigs = (store.grokConfigs || []).filter(p => p.id !== providerId);
    },
    renderList: () => renderGrokConfigList(platformInfoOf('grok') || {}),
  });
  if (!synced) return;
  if (typeof addLog === 'function') addLog('info', `已删除 Grok 配置: ${provider.name || provider.id}`);
}

async function applyGrokProviderConfig(providerId) {
  const provider = grokConfigProviderById(providerId);
  const label = provider?.name || providerId;
  const model = provider?.defaultModel || '默认模型';
  const contextWindow = provider?.contextWindow
    ? `${provider.contextWindow} token`
    : '未设置（Grok 会按 200,000 处理）';
  const extraCount = Math.max(0, (Array.isArray(provider?.models) ? provider.models.length : 1) - 1);
  const registerLine = extraCount
    ? `\n同时注册：${extraCount + 1} 个模型（其余用 /model 或 Ctrl+M 切换）`
    : '';
  const ok = await showCustomConfirm(
    `将把 Grok Build CLI 默认模型切换为「${label}」。\n\n模型：${model}\n上下文窗口：${contextWindow}${registerLine}\n配置文件：~/.grok/config.toml\n\n下次在终端启动 grok 即可生效。`,
    '切换 Grok 配置',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy('grok', true);
  showSwitchProgress('grok', '正在写入 Grok 配置文件…');
  try {
    const result = await invoke('switch_platform', { platform: 'grok', providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Grok 配置切换成功');
    showCustomAlert(result.message || 'Grok 配置切换成功。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Grok 切换失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('grok', false);
    renderPlatformDetailStatuses();
  }
}

function onGrokConfigSearch() {
  const input = document.getElementById('grok-config-search');
  grokConfigSearch = input ? input.value : '';
  const info = platformInfoOf('grok');
  if (info) renderGrokConfigList(info);
}

function grokConfigMatchesSearch(config) {
  if (!grokConfigSearch.trim()) return true;
  const kw = grokConfigSearch.trim().toLowerCase();
  return [
    config.name,
    config.model,
    config.endpoint,
    config.description,
  ].some(value => String(value || '').toLowerCase().includes(kw));
}

async function restoreGrokOfficialConfig() {
  const info = platformInfoOf('grok') || {};
  const isOfficial = !info.managedByAnyBridge;
  const message = isOfficial
    ? 'Grok Build 当前已经是官方配置。仍要清理 AnyBridge 写入的托管模型段吗？'
    : '将把 Grok Build 切回官方配置。\n\n这会清理 AnyBridge 写入的自定义端点与默认模型设置，恢复使用 xAI 官方默认登录态与模型。在终端重新运行 grok 即可生效。';
  const ok = await showCustomConfirm(message, '切回官方配置', 'warn');
  if (!ok) return;

  setPlatformBusy('grok', true);
  showSwitchProgress('grok', '正在准备切回官方配置…');
  try {
    const result = await invoke('restore_grok_official_config');
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Grok 已切回官方配置');
    showCustomAlert(result.message || 'Grok 已切回官方配置。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Grok 切回官方失败: ${e}`);
    showCustomAlert(String(e), '切回官方失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('grok', false);
    renderPlatformDetailStatuses();
  }
}

function renderGrokConfigList(info) {
  const list = document.getElementById('platform-grok-config-list');
  if (!list) return;

  const configs = Array.isArray(providerStore?.grokConfigs) ? providerStore.grokConfigs : [];
  const currentId = info?.currentProviderId || '';
  const isOfficial = !info.managedByAnyBridge;
  const items = [];

  items.push({
    platformId: 'grok',
    name: '官方默认配置',
    description: '使用 Grok Build 官方登录态（grok login）与 xAI 官方内置模型。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: isOfficial,
    currentLabel: '当前使用',
    model: '官方默认 (grok-4.5)',
    endpoint: '~/.grok/config.toml',
    protocol: 'xAI 原生',
    action: 'restoreGrokOfficialConfig()',
    actionLabel: '切回官方',
  });

  const grokLocalCard = platformLocalProxyCard('grok', info);
  if (grokLocalCard) items.push(grokLocalCard);

  configs.forEach(cfg => {
    const isCurrent = currentId === cfg.id || currentId === grok_sanitize_key(cfg.id);
    const backendLabel = cfg.apiBackend === 'responses'
      ? 'Responses 协议'
      : cfg.apiBackend === 'messages'
        ? 'Messages 协议'
        : 'Chat Completions 协议';
    const baseUrl = cfg.apiHost ? (cfg.apiHost.replace(/\/+$/, '') + (cfg.apiPath || '/v1')) : '未设置地址';
    items.push({
      platformId: 'grok',
      name: cfg.name || cfg.id,
      description: 'Grok Build 自定义模型配置，写入 ~/.grok/config.toml。',
      typeLabel: isCurrent ? '当前使用' : '第三方',
      tone: isCurrent ? 'third live' : 'third',
      current: isCurrent,
      currentLabel: '当前使用',
      model: `${grokConfigModelLabel(cfg)} · 上下文 ${cfg.contextWindow ? cbFormatContextTokens(cfg.contextWindow) : '未设置'}`,
      endpoint: baseUrl,
      protocol: backendLabel,
      action: `applyGrokProviderConfig(${platformJsArg(cfg.id)})`,
      actionLabel: '切换',
      editAction: `editGrokProviderConfig(${platformJsArg(cfg.id)})`,
      deleteAction: `deleteGrokProviderConfig(${platformJsArg(cfg.id)})`,
    });
  });

  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  liveIds
    .filter(id => !configs.some(c => c.id === id || grok_sanitize_key(c.id) === id))
    .forEach(id => {
      const isCurrent = currentId === id;
      items.push({
        platformId: 'grok',
        name: id,
        description: '在 ~/.grok/config.toml 中由手动或外部写入的模型配置。',
        typeLabel: isCurrent ? '当前使用' : '外部配置',
        tone: isCurrent ? 'third live' : 'third external',
        current: isCurrent,
        currentLabel: '当前使用',
        model: '外部模型',
        endpoint: '~/.grok/config.toml',
        protocol: '原生配置',
      });
    });

  const filtered = items.filter(grokConfigMatchesSearch);
  const count = document.getElementById('grok-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = `
      <div class="codex-table-empty">
        <div style="font-size: 14px; font-weight: 600; margin-bottom: 6px;">尚无 Grok 配置</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">点击右上角「+ 添加配置」从已有的供应商一键创建并切换。</div>
        <button class="btn-primary" type="button" data-action="openGrokConfigAdd">+ 添加首个配置</button>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

async function restoreClaudeCodeOfficialConfig() {
  const info = platformInfoOf('claude-code') || {};
  const alreadyOfficial = !!(info.claudeConfig && info.claudeConfig.isOfficial);
  const message = alreadyOfficial
    ? 'Claude Code 当前已经是官方配置。仍要清理 AnyBridge 写入的 ANTHROPIC_* env 字段吗？'
    : '将把 Claude Code 切回官方配置。\n\n这会移除 AnyBridge 写入的 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 和模型 env 字段，但会保留 MCP、权限、hooks、语言等其他配置。切换后需要重启 Claude Code 才会生效。';
  const ok = await showCustomConfirm(message, '切回官方配置', 'warn');
  if (!ok) return;

  setPlatformBusy('claude-code', true);
  showSwitchProgress('claude-code', '正在准备切回官方配置…');
  try {
    const result = await invoke('restore_claude_official_config');
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Claude Code 已切回官方配置');
    showCustomAlert(result.message || 'Claude Code 已切回官方配置。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Claude Code 切回官方失败: ${e}`);
    showCustomAlert(String(e), '切回官方失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('claude-code', false);
    renderPlatformDetailStatuses();
  }
}

async function applyClaudeCodeProviderConfig(providerId) {
  const provider = platformProviderList('claude-code').find(p => p.id === providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法切换', 'error');
    return;
  }

  const info = platformInfoOf('claude-code') || {};
  const from = info.currentProviderName || info.currentProviderId || '当前配置';
  const to = provider.name || provider.id || '目标配置';
  const model = provider.defaultModel || '默认模型';
  const baseUrl = claudeCodeTargetBaseUrl(provider);
  const message = `将把 Claude Code 从「${from}」切换到「${to}」。\n\n模型：${model}\n地址：${baseUrl}\n\n只会合并写入 settings.json 的 env 字段，原有 MCP、权限、hooks、语言等配置会保留。切换后需要重启 Claude Code 才会生效。`;
  const ok = await showCustomConfirm(message, '切换 Claude Code 配置', 'warn');
  if (!ok) return;

  setPlatformBusy('claude-code', true);
  showSwitchProgress('claude-code', '正在准备切换 Claude Code 配置…');
  try {
    const result = await invoke('switch_platform', { platform: 'claude-code', providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Claude Code 配置已切换');
    showCustomAlert(result.message || 'Claude Code 配置已切换。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Claude Code 切换失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('claude-code', false);
    renderPlatformDetailStatuses();
  }
}

function onCodexConfigSearch() {
  const input = document.getElementById('codex-config-search');
  codexConfigSearch = input ? input.value : '';
  const info = platformInfoOf('codex');
  if (info) renderCodexConfigList(info);
}

async function applyCodexProviderConfig(providerId) {
  const provider = codexConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法切换', 'error');
    return;
  }

  const flow = await runSwitchFlow({
    title: '切换 Codex 配置',
    lead: codexApplyConfirmMessage(provider),
    confirmText: '确认切换',
    platform: 'codex',
    runningMessage: '正在准备切换 Codex 配置…',
    successTitle: '切换完成',
    failureTitle: '切换失败',
    skipConfirm: false,
    task: async ({ setMessage }) => {
      setPlatformBusy('codex', true);
      try {
        setMessage('正在写入 Codex 配置…');
        const result = assertSwitchResultOk(
          await invoke('switch_platform', { platform: 'codex', providerId }),
          'Codex 配置切换失败'
        );

        let restart = null;
        const preserveAuth = codexProviderPreservesOfficialAuth(provider);
        const needInject = codexProviderNeedsInject(provider);
        if (codexDesktopAutomationSupported()) {
          setMessage(preserveAuth
            ? '正在以官方登录模式重启 Codex…'
            : needInject
              ? '正在重启 Codex 并解锁模型…'
              : '正在重启 Codex…');
          restart = assertSwitchResultOk(
            await invoke('restart_codex_desktop', { managed: true, model: provider.defaultModel || null, injectModels: needInject }),
            'Codex 重启或注入失败'
          );
        } else {
          setMessage('已跳过自动重启（仅支持 Windows）。');
        }

        if (typeof addLog === 'function') {
          addLog('ok', result.message || 'Codex 配置已切换');
          if (restart) {
            addLog('ok', restart.message || (needInject ? 'Codex 已重启并解锁模型' : 'Codex 已重启'));
          } else {
            addLog('warn', codexDesktopUnsupportedMessage());
          }
        }
        setMessage('正在刷新 Codex 状态…');
        await refreshPlatforms({ silent: true, reloadProviders: false });
        const restartFallback = needInject ? 'Codex 已重启并解锁模型。' : 'Codex 已重启。';
        return {
          message: `${result.message || 'Codex 配置已切换。'}\n\n${restart ? (restart.message || restartFallback) : codexDesktopUnsupportedMessage()}`
        };
      } finally {
        setPlatformBusy('codex', false);
        renderPlatformDetailStatuses();
      }
    }
  });
  if (flow.confirmed && !flow.ok && typeof addLog === 'function') {
    addLog('err', switchFlowErrorLog(flow.error, 'Codex 切换失败: '));
  }
}

async function startCodexWithCdp(injectModels = true) {
  if (!codexDesktopAutomationSupported()) {
    const msg = codexDesktopUnsupportedMessage();
    if (typeof addLog === 'function') addLog('warn', msg);
    showCustomAlert(msg, '当前平台不支持', 'warn');
    return;
  }
  setPlatformBusy('codex', true);
  try {
    const result = await invoke('start_codex_with_cdp', { injectModels: !!injectModels });
    if (typeof addLog === 'function') {
      addLog(result.ok ? 'ok' : 'err', switchFlowErrorLog(result.message, ''));
    }
    showCustomAlert(
      messageHeadline(result.message).replace(/^Error:\s*/i, ''),
      result.ok ? '提示' : '启动失败',
      result.ok ? 'success' : 'error'
    );
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', switchFlowErrorLog(e, '启动 Codex 失败: '));
    showCustomAlert(messageHeadline(e) || String(e), '启动失败', 'error');
  } finally {
    setPlatformBusy('codex', false);
  }
}

function renderPlatformProviderOptions() {
  platformMetaIds().forEach(platformId => {
    const select = document.getElementById(`platform-${platformId}-select`);
    const applyBtn = document.getElementById(`platform-${platformId}-apply`);
    if (!select) return;

    const info = platformInfoOf(platformId);
    const providers = platformProviderList(platformId);
    const previous = select.value || (info && info.currentProviderId) || '';

    if (!providers.length) {
      select.innerHTML = `<option value="">无可用 ${platformEsc(platformFormatLabel(platformDef(platformId).requiredApiFormat))} 供应商</option>`;
      select.value = '';
      if (applyBtn) applyBtn.disabled = true;
      platformSetText(`platform-${platformId}-preview`, '请先在「供应商」页添加并启用匹配协议的供应商。');
      if (platformId === 'codex') renderCodexTargetSummary(null, '请先添加 Codex 配置');
      return;
    }

    select.innerHTML = providers
      .map(p => `<option value="${platformEsc(p.id)}">${platformEsc(p.name)} · ${platformEsc(p.defaultModel || '默认模型未设置')}</option>`)
      .join('');
    select.value = providers.some(p => p.id === previous) ? previous : providers[0].id;
    if (platformId === 'codex') {
      renderCodexTargetSummary(providers.find(p => p.id === select.value) || providers[0]);
    }
    onPlatformProviderChange(platformId);
  });
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.selectGrokAddProvider = selectGrokAddProvider;
  g.renderGrokAddModels = renderGrokAddModels;
  g.updateGrokAddConfirmButton = updateGrokAddConfirmButton;
  g.grokAddSelectAll = grokAddSelectAll;
  g.grokAddSelectNone = grokAddSelectNone;
  g.confirmAddGrokModelsPage = confirmAddGrokModelsPage;
  g.openGrokConfigEditor = openGrokConfigEditor;
  g.closeGrokConfigEditor = closeGrokConfigEditor;
  g.syncGrokConfigTokenFromSource = syncGrokConfigTokenFromSource;
  g.syncGrokConfigUiAfterStoreChange = syncGrokConfigUiAfterStoreChange;
  g.saveGrokConfigEditor = saveGrokConfigEditor;
  g.editGrokProviderConfig = editGrokProviderConfig;
  g.deleteGrokProviderConfig = deleteGrokProviderConfig;
  g.applyGrokProviderConfig = applyGrokProviderConfig;
  g.onGrokConfigSearch = onGrokConfigSearch;
  g.grokConfigMatchesSearch = grokConfigMatchesSearch;
  g.restoreGrokOfficialConfig = restoreGrokOfficialConfig;
  g.renderGrokConfigList = renderGrokConfigList;
  g.restoreClaudeCodeOfficialConfig = restoreClaudeCodeOfficialConfig;
  g.applyClaudeCodeProviderConfig = applyClaudeCodeProviderConfig;
  g.onCodexConfigSearch = onCodexConfigSearch;
  g.applyCodexProviderConfig = applyCodexProviderConfig;
  g.startCodexWithCdp = startCodexWithCdp;
  g.renderPlatformProviderOptions = renderPlatformProviderOptions;
})(globalThis);
