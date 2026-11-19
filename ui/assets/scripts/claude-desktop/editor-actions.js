// claude-desktop/editor-actions.js — 配置保存、切换应用、删除与还原操作
import { getClaudeDesktopConfigs, ensureDefaultClaudeDesktopConfig } from './console.js';
import { pickBestModelForRole, getClaudeDesktop1m, setClaudeDesktop1m, stripClaudeDesktop1mMarker } from './role-selects.js';
import { getClaudeDesktopCombinedSources, renderClaudeDesktopSourceList } from './editor-models.js';

function openClaudeDesktopAddModal() {
  navigateTo('platform-claude-desktop-add');
  const titleEl = document.getElementById('claude-desktop-config-page-title');
  const subEl = document.getElementById('claude-desktop-config-page-sub');
  if (titleEl) titleEl.textContent = '添加配置 · Claude Desktop';
  if (subEl) subEl.textContent = '配置桌面端本地路由与各档位角色的模型映射。';

  const editIdInput = document.getElementById('claude-desktop-config-edit-id');
  if (editIdInput) editIdInput.value = '';
  const sourceIdInput = document.getElementById('claude-desktop-config-source-id');
  if (sourceIdInput) sourceIdInput.value = '';
  const nameInput = document.getElementById('claude-desktop-config-name');
  if (nameInput) nameInput.value = '';
  const modeInput = document.getElementById('claude-desktop-config-mode');
  if (modeInput) modeInput.value = 'proxy';

  ['sonnet', 'opus', 'fable', 'haiku'].forEach(role => {
    const el = document.getElementById(`claude-desktop-config-${role}-name`);
    if (el) el.value = '';
    const hidden = document.getElementById(`claude-desktop-config-${role}`);
    if (hidden) hidden.value = '';
  });

  const sourceList = getClaudeDesktopCombinedSources();
  const firstP = sourceList[0] || null;
  const firstId = firstP ? (firstP.providerId || firstP.id) : '';

  renderClaudeDesktopSourceList(firstId);

  if (firstId) {
    onClaudeDesktopSourceSelect(firstId);
  } else {
    populateRoleSelects({});
  }

  const resetFn = globalThis.resetPasswordInputVisibility || (typeof resetPasswordInputVisibility === 'function' ? resetPasswordInputVisibility : null);
  if (resetFn) {
    resetFn('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
  }

  if (typeof globalThis.loadPlatformRealConfigFile === 'function') {
    globalThis.loadPlatformRealConfigFile('claude-desktop', 'claude-desktop-config-raw-json');
  }

  window.setTimeout(() => {
    document.getElementById('claude-desktop-config-name')?.focus();
  }, 50);
}

function editClaudeDesktopConfig(configId) {
  navigateTo('platform-claude-desktop-add');
  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) return;

  const titleEl = document.getElementById('claude-desktop-config-page-title');
  const subEl = document.getElementById('claude-desktop-config-page-sub');
  if (titleEl) titleEl.textContent = '编辑配置 · Claude Desktop';
  if (subEl) subEl.textContent = `正在编辑「${cfg.name}」这份 Claude Desktop 配置。`;

  const editIdInput = document.getElementById('claude-desktop-config-edit-id');
  if (editIdInput) editIdInput.value = cfg.id;
  const sourceIdInput = document.getElementById('claude-desktop-config-source-id');
  if (sourceIdInput) sourceIdInput.value = cfg.sourceProviderId || '';
  const nameInput = document.getElementById('claude-desktop-config-name');
  if (nameInput) nameInput.value = cfg.name || '';
  const modeInput = document.getElementById('claude-desktop-config-mode');
  if (modeInput) modeInput.value = cfg.mode || 'proxy';

  const baseUrlInput = document.getElementById('claude-desktop-config-base-url');
  if (baseUrlInput) baseUrlInput.value = cfg.apiHost || cfg.baseUrl || '';
  const apiKeyInput = document.getElementById('claude-desktop-config-api-key');
  if (apiKeyInput) apiKeyInput.value = cfg.apiKey || '';

  const sonnetNameInput = document.getElementById('claude-desktop-config-sonnet-name');
  if (sonnetNameInput) sonnetNameInput.value = cfg.sonnetName || '';
  const opusNameInput = document.getElementById('claude-desktop-config-opus-name');
  if (opusNameInput) opusNameInput.value = cfg.opusName || '';
  const fableNameInput = document.getElementById('claude-desktop-config-fable-name');
  if (fableNameInput) fableNameInput.value = cfg.fableName || '';
  const haikuNameInput = document.getElementById('claude-desktop-config-haiku-name');
  if (haikuNameInput) haikuNameInput.value = cfg.haikuName || '';

  const providers = globalThis.providerStore?.providers || [];
  const p = cfg.sourceProviderId ? providers.find(x => x.id === cfg.sourceProviderId) : null;

  renderClaudeDesktopSourceList(cfg.sourceProviderId || '');
  populateRoleSelects({
    sourceProviderId: cfg.sourceProviderId || '',
    sonnetModel: cfg.sonnetModel,
    opusModel: cfg.opusModel,
    haikuModel: cfg.haikuModel,
    fableModel: cfg.fableModel,
  }, p);

  setClaudeDesktopModelStatus(`正在编辑「${cfg.name}」模型映射`, 'success');

  const resetFnEdit = globalThis.resetPasswordInputVisibility || (typeof resetPasswordInputVisibility === 'function' ? resetPasswordInputVisibility : null);
  if (resetFnEdit) {
    resetFnEdit('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
  }

  if (typeof globalThis.loadPlatformRealConfigFile === 'function') {
    globalThis.loadPlatformRealConfigFile('claude-desktop', 'claude-desktop-config-raw-json');
  }

  window.setTimeout(() => {
    document.getElementById('claude-desktop-config-name')?.focus();
  }, 50);
}

function closeClaudeDesktopConfigEditor() {
  navigateTo('platform-claude-desktop');
}

async function saveClaudeDesktopConfigEditor(switchAfter = false) {
  const editId = document.getElementById('claude-desktop-config-edit-id')?.value.trim();
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value.trim();
  const name = document.getElementById('claude-desktop-config-name')?.value.trim();
  const mode = document.getElementById('claude-desktop-config-mode')?.value.trim() || 'proxy';
  const apiHost = document.getElementById('claude-desktop-config-base-url')?.value.trim() || '';
  const apiKey = document.getElementById('claude-desktop-config-api-key')?.value.trim() || '';

  let sonnetModel = getClaudeDesktopRoleVal('sonnet');
  let opusModel = getClaudeDesktopRoleVal('opus');
  let fableModel = getClaudeDesktopRoleVal('fable');
  let haikuModel = getClaudeDesktopRoleVal('haiku');

  // CC Switch 规范：留空的档会自动沿用 Sonnet（或第一个已填档）的模型，确保子 agent 调用的 Haiku 始终可用
  const fallbackModel = sonnetModel || opusModel || fableModel || haikuModel;
  if (!fallbackModel) {
    showCustomAlert('请至少为一个档位（如 Sonnet）选择映射模型。', '提示', 'warn');
    return;
  }
  if (!sonnetModel) sonnetModel = fallbackModel;
  if (!opusModel) opusModel = fallbackModel;
  if (!haikuModel) haikuModel = fallbackModel;

  const sonnetName = document.getElementById('claude-desktop-config-sonnet-name')?.value.trim() || '';
  const opusName = document.getElementById('claude-desktop-config-opus-name')?.value.trim() || '';
  const fableName = document.getElementById('claude-desktop-config-fable-name')?.value.trim() || '';
  const haikuName = document.getElementById('claude-desktop-config-haiku-name')?.value.trim() || '';

  if (!name) {
    showCustomAlert('请输入配置名称。', '提示', 'warn');
    return;
  }

  // 避免同名配置混淆校验
  const configs = getClaudeDesktopConfigs();
  let targetId = editId;
  const isDuplicateName = configs.some(
    c => c && c.id !== targetId && String(c.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Claude Desktop 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('claude-desktop-config-name')?.focus();
    return;
  }

  const providers = globalThis.providerStore?.providers || [];
  const sourceProvider = providers.find(p => p.id === sourceId);

  if (!targetId) {
    targetId = `claude-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const newConfig = {
    id: targetId,
    name,
    mode,
    apiHost,
    apiKey,
    sourceProviderId: sourceId,
    sourceProviderName: sourceProvider ? (sourceProvider.name || sourceProvider.id) : (mode === 'proxy' ? 'AnyBridge 内置供应商' : '直连'),
    sonnetModel,
    opusModel,
    haikuModel,
    fableModel,
    sonnetName,
    opusName,
    fableName,
    haikuName,
  };

  const ok = await mutateProviderStore(store => {
    if (!Array.isArray(store.claudeDesktopConfigs)) store.claudeDesktopConfigs = [];
    const existingIdx = store.claudeDesktopConfigs.findIndex(c => c.id === targetId);
    if (existingIdx >= 0) {
      store.claudeDesktopConfigs[existingIdx] = newConfig;
    } else {
      store.claudeDesktopConfigs.push(newConfig);
    }
  }, {
    alertOnError: true,
    onRollback: () => {
      renderClaudeDesktopConfigList();
    },
  });
  if (!ok) return;

  closeClaudeDesktopConfigEditor();
  showCustomAlert('配置已保存。', '保存成功', 'success');
  renderClaudeDesktopConfigList();

  if (switchAfter) {
    try {
      await applyClaudeDesktopConfig(targetId);
    } catch (e) {
      showCustomAlert(`保存后应用失败: ${e}`, '错误', 'error');
    }
  }
}

async function applyClaudeDesktopConfig(configId) {
  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) {
    showCustomAlert('找不到对应的配置。', '错误', 'error');
    return;
  }

  const currentInfo = globalThis.claudeDesktopStatus || {};
  const isCurrentlyApplied = !!currentInfo.managedByAnyBridge && (currentInfo.currentProviderId === cfg.id || (!currentInfo.currentProviderId && cfg.id === 'claude-desktop-default-proxy'));
  const promptTitle = isCurrentlyApplied ? '重新配置' : '切换配置';
  const promptRoles = [
    ['Sonnet', cfg.sonnetModel],
    ['Opus', cfg.opusModel],
    ['Haiku', cfg.haikuModel],
  ];
  if (cfg.fableModel) promptRoles.push(['Fable', cfg.fableModel]);
  const promptRoleText = promptRoles
    .map(([role, model]) => `${role}: ${getRouteLabel(model) || '未选'}`)
    .join(', ');
  const promptText = isCurrentlyApplied
    ? `确定重新配置「${cfg.name}」吗？\n\n将重新写入本地路由配置（${promptRoleText}）。\n完成后请重启 Claude Desktop。`
    : `确定切换到配置「${cfg.name}」吗？\n\n将开启本地路由模式（${promptRoleText}）。\n切换后请重启 Claude Desktop。`;

  const ok = await showCustomConfirm(promptText, promptTitle, 'info');
  if (!ok) return;

  try {
    const bindings = {
      sonnet: cfg.sonnetModel,
      opus: cfg.opusModel,
      haiku: cfg.haikuModel,
      fable: cfg.fableModel || '',
      sonnetName: cfg.sonnetName || '',
      opusName: cfg.opusName || '',
      fableName: cfg.fableName || '',
      haikuName: cfg.haikuName || '',
    };

    if (globalThis.invoke) {
      await invoke('save_claude_desktop_bindings', { bindings });
      const res = await invoke('switch_platform', { platform: 'claude-desktop', providerId: cfg.id });
      if (typeof addLog === 'function') addLog('ok', res?.message || (isCurrentlyApplied ? `已重新配置 ${cfg.name}` : `已切换至 ${cfg.name}`));
      const successMsg = isCurrentlyApplied
        ? '当前配置已重新写入，请重启 Claude Desktop 生效。'
        : (res?.message || '配置已成功应用，请重启 Claude Desktop 生效。');
      showCustomAlert(successMsg, isCurrentlyApplied ? '重新配置成功' : '切换成功', 'success');
      await loadClaudeDesktopConsole();
      if (typeof refreshPlatforms === 'function') refreshPlatforms({ silent: true });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${promptTitle}失败: ${e}`);
    showCustomAlert(String(e), `${promptTitle}失败`, 'error');
  }
}

async function deleteClaudeDesktopConfig(configId) {
  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) return;

  const ok = await showCustomConfirm(
    `确定删除配置「${cfg.name}」吗？`,
    '删除配置',
    'warn'
  );
  if (!ok) return;

  const saved = await mutateProviderStore(store => {
    const list = Array.isArray(store.claudeDesktopConfigs) ? store.claudeDesktopConfigs : [];
    const idx = list.findIndex(c => c.id === configId);
    if (idx < 0) return false;
    list.splice(idx, 1);
  }, {
    alertOnError: true,
    onRollback: () => {
      renderClaudeDesktopConfigList();
    },
  });
  if (!saved) return;
  renderClaudeDesktopConfigList();
  showCustomAlert('配置已删除。', '删除成功', 'success');
}

async function restoreClaudeDesktopOfficialConfig() {
  const ok = await showCustomConfirm(
    '确定切回 Claude Desktop 官方默认配置吗？\n\n将清理本地路由配置并恢复官方登录状态。完成后请重启 Claude Desktop。',
    '切回官方',
    'warn'
  );
  if (!ok) return;

  try {
    if (globalThis.invoke) {
      const res = await invoke('restore_platform', { platform: 'claude-desktop' });
      if (typeof addLog === 'function') addLog('ok', res?.message || '已切回 Claude Desktop 官方默认配置');
      showCustomAlert(res?.message || '已恢复官方默认配置，请重启 Claude Desktop 生效。', '还原完成', 'success');
      await loadClaudeDesktopConsole();
      if (typeof refreshPlatforms === 'function') refreshPlatforms({ silent: true });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '切回官方默认配置失败: ' + e);
    showCustomAlert(String(e), '还原失败', 'error');
  }
}

async function refreshClaudeDesktopAction() {
  await loadClaudeDesktopConsole();
  if (typeof addLog === 'function') addLog('info', 'Claude Desktop 状态已刷新');
}

function toggleClaudeDesktopKeyVisibility() {
  const toggleFn = globalThis.togglePasswordInputVisibility || (typeof togglePasswordInputVisibility === 'function' ? togglePasswordInputVisibility : null);
  if (toggleFn) {
    toggleFn('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
    return;
  }
  const input = document.getElementById('claude-desktop-config-api-key');
  const btn = document.getElementById('claude-desktop-config-api-key-toggle');
  if (!input) return;
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  if (btn) {
    btn.innerHTML = isPwd
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  }
}

function syncClaudeDesktopConfigTokenFromSource() {
  const sourceId = String(document.getElementById('claude-desktop-config-source-id')?.value || '').trim();
  const configName = String(document.getElementById('claude-desktop-config-name')?.value || '').trim();
  const providers = globalThis.providerStore?.providers || [];
  const source = providers.find(p => p && (
    (sourceId && (p.id === sourceId || p.providerId === sourceId)) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    showCustomAlert('未找到关联的来源供应商，请先在左侧选择来源供应商。', '无法同步', 'warn');
    return;
  }

  const baseUrlInput = document.getElementById('claude-desktop-config-base-url');
  if (baseUrlInput) {
    if (source.isLocalProxy || source.meta?.localProxy || source.id === 'local-proxy' || source.id === 'anybridge' || source.name === 'AnyBridge') {
      baseUrlInput.value = 'http://127.0.0.1:7450/v1';
    } else {
      const endpoint = source.apiHost ? (source.apiPath ? `${source.apiHost.replace(/\/+$/, '')}${source.apiPath}` : `${source.apiHost.replace(/\/+$/, '')}/v1`) : '';
      baseUrlInput.value = endpoint || source.apiHost || '';
    }
  }

  const apiKeyInput = document.getElementById('claude-desktop-config-api-key');
  if (apiKeyInput) {
    if (source.isLocalProxy || source.meta?.localProxy || source.id === 'local-proxy' || source.id === 'anybridge' || source.name === 'AnyBridge') {
      apiKeyInput.value = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : (source.apiKey || '');
    } else {
      apiKeyInput.value = source.apiKey || '';
    }
  }

  syncClaudeDesktopRawConfigFromFields();
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌与地址`, 'success');
  } else {
    showCustomAlert(`已同步供应商「${source.name || source.id}」的最新令牌与地址。`, '同步成功', 'success');
  }
}

globalThis.openClaudeDesktopAddModal = openClaudeDesktopAddModal;
globalThis.openClaudeDesktopConfigEditor = openClaudeDesktopAddModal;
globalThis.editClaudeDesktopConfig = editClaudeDesktopConfig;
globalThis.deleteClaudeDesktopConfig = deleteClaudeDesktopConfig;
globalThis.closeClaudeDesktopConfigEditor = closeClaudeDesktopConfigEditor;
globalThis.saveClaudeDesktopConfigEditor = saveClaudeDesktopConfigEditor;
globalThis.applyClaudeDesktopConfig = applyClaudeDesktopConfig;
globalThis.restoreClaudeDesktopOfficialConfig = restoreClaudeDesktopOfficialConfig;
globalThis.refreshClaudeDesktopAction = refreshClaudeDesktopAction;
globalThis.toggleClaudeDesktopKeyVisibility = toggleClaudeDesktopKeyVisibility;
globalThis.syncClaudeDesktopConfigTokenFromSource = syncClaudeDesktopConfigTokenFromSource;
