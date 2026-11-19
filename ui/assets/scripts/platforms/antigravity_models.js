// platforms/antigravity_models.js — split from 55-platforms.js
function antigravityFilterModels(keyword) {
  _antigravitySearchKeyword = keyword || '';
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityToggleSelectAll(checked) {
  const visible = antigravityGetFilteredList();
  if (checked) {
    visible.forEach(m => _antigravitySelectedSet.add(m.id));
  } else {
    visible.forEach(m => _antigravitySelectedSet.delete(m.id));
  }
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityToggleSelectAllVisible() {
  const visible = antigravityGetFilteredList();
  if (!visible.length) return;
  const allSelected = visible.every(m => _antigravitySelectedSet.has(m.id));
  antigravityToggleSelectAll(!allSelected);
}

function antigravityToggleRowSelect(id, checked) {
  if (checked) _antigravitySelectedSet.add(id);
  else _antigravitySelectedSet.delete(id);
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityUpdateBulkActionButtons() {
  const count = _antigravitySelectedSet.size;
  const selectAll = document.getElementById('antigravitySelectAll');
  const visible = antigravityGetFilteredList();

  if (selectAll) {
    selectAll.checked = visible.length > 0 && visible.every(m => _antigravitySelectedSet.has(m.id));
  }

  const enableBtn = document.getElementById('antigravity-bulk-enable-btn');
  const disableBtn = document.getElementById('antigravity-bulk-disable-btn');
  const visionBtn = document.getElementById('antigravity-bulk-vision-btn');
  const removeBtn = document.getElementById('antigravity-bulk-remove-btn');

  if (enableBtn) enableBtn.disabled = count === 0;
  if (disableBtn) disableBtn.disabled = count === 0;
  if (visionBtn) visionBtn.disabled = count === 0;
  if (removeBtn) removeBtn.disabled = count === 0;
}

async function antigravityToggleThirdPartyVision(id, checked) {
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (checked && !hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置图片理解模型。', '无法启用', 'warn');
    antigravityRenderTableRows();
    return;
  }

  let touched = false;
  const ok = await mutateProviderStore(store => {
    const target = Array.isArray(store.antigravityConfigs)
      ? store.antigravityConfigs.find(c => c.id === id)
      : null;
    if (!target) return false;
    target.useThirdPartyVision = !!checked;
    touched = true;
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!touched) return;
  if (ok) await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
}

async function antigravityBulkThirdPartyVisionAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs) || _antigravitySelectedSet.size === 0) return;
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (!hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置第三方图片理解模型。', '无法启用', 'warn');
    return;
  }

  const count = _antigravitySelectedSet.size;
  const ok = await mutateProviderStore(store => {
    (store.antigravityConfigs || []).forEach(c => {
      if (_antigravitySelectedSet.has(c.id)) {
        c.useThirdPartyVision = true;
      }
    });
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!ok) return;
  await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
  showBottomToast(`已批量启用 ${count} 个模型的第三方图片理解`, 'success');
}

async function antigravityToggleModelEnabled(id, checked) {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  let touched = false;
  const ok = await mutateProviderStore(store => {
    const target = (store.antigravityConfigs || []).find(c => c.id === id);
    if (!target) return false;
    target.enabled = checked;
    target.injectModels = checked;
    touched = true;
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!touched || !ok) return;
  await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
}

async function antigravityBulkEnableAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs) || _antigravitySelectedSet.size === 0) return;
  const count = _antigravitySelectedSet.size;
  const ok = await mutateProviderStore(store => {
    (store.antigravityConfigs || []).forEach(c => {
      if (_antigravitySelectedSet.has(c.id)) {
        c.enabled = true;
        c.injectModels = true;
      }
    });
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!ok) return;
  await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
  showBottomToast(`已批量启用 ${count} 个 Antigravity 模型`, 'success');
}

async function antigravityBulkDisableAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs) || _antigravitySelectedSet.size === 0) return;
  const count = _antigravitySelectedSet.size;
  const ok = await mutateProviderStore(store => {
    (store.antigravityConfigs || []).forEach(c => {
      if (_antigravitySelectedSet.has(c.id)) {
        c.enabled = false;
        c.injectModels = false;
      }
    });
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!ok) return;
  await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
  showBottomToast(`已批量停用 ${count} 个 Antigravity 模型`, 'info');
}

async function antigravityBulkRemoveAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  const count = _antigravitySelectedSet.size;
  if (count === 0) return;
  const idsToRemove = new Set(_antigravitySelectedSet);
  const ok = await mutateProviderStore(store => {
    store.antigravityConfigs = (store.antigravityConfigs || []).filter(c => !idsToRemove.has(c.id));
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!ok) return;
  _antigravitySelectedSet.clear();
  await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
  showBottomToast(`已移除 ${count} 个模型`, 'success');
}

async function antigravityPrimaryAction() {
  const target = getAntigravityTarget();
  const info = platformInfoOf(target);
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';

  if (info?.managedByAnyBridge) {
    showCustomAlert(`${platName} 当前已成功接入 AnyBridge。\n\n如需断开连接，请点击右侧「停止接入」按钮。`, '已处于接入状态', 'info');
    return;
  }

  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const activeProviderId = configs.find(c => c.enabled !== false)?.id || configs[0]?.id || '';

  setPlatformBusy(target, true);
  try {
    if (typeof addLog === 'function') addLog('info', `正在配置 ${platName} 接入 settings.json 与网关端点…`);
    const result = assertSwitchResultOk(
      await invoke('switch_platform', { platform: target, providerId: activeProviderId }),
      `${platName} 接入失败`
    );
    if (typeof addLog === 'function') {
      addLog('ok', result.message || `${platName} 已成功接入 AnyBridge`);
    }

    // 重启确认是用户点这一下的第一诉求：先弹窗，状态刷新放到弹窗响应之后。
    // 原顺序（刷新 13 个平台状态 → 重绘 → 才弹窗）会让点击后卡 1-2 秒才见反馈，
    // 而那些善后工作并不需要挡在弹窗前面。
    if (typeof promptRestartIde === 'function') {
      setPlatformBusy(target, false); // 解除忙碌态，弹窗立刻可交互
      await promptRestartIde('已接入 AnyBridge，重启后生效。', target, { mode: 'proxy', statusText: null });
    }
    await refreshPlatforms({ silent: true, reloadProviders: false });
    antigravityRefreshConsole({ silent: true });
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${platName} 接入失败: ` + e);
    showCustomAlert(String(e?.message || e), '接入失败', 'error');
  } finally {
    setPlatformBusy(target, false);
  }
}

async function antigravityRestoreAction() {
  await restoreAntigravityOfficialConfig();
  antigravityRefreshConsole({ silent: true });
}

async function restoreAntigravityOfficialConfig() {
  const target = getAntigravityTarget();
  const info = platformInfoOf(target) || {};
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';
  const alreadyOfficial = !info.managedByAnyBridge;
  if (alreadyOfficial) {
    showCustomAlert(`${platName} 当前已经是官方直连模式，无需重复恢复。`, '提示', 'info');
    return;
  }

  setPlatformBusy(target, true);
  try {
    if (typeof addLog === 'function') addLog('info', `正在恢复 ${platName} 官方配置…`);
    const result = assertSwitchResultOk(
      await invoke('restore_antigravity_official_config', { platform: target }),
      `${platName} 官方配置还原失败`
    );
    if (typeof addLog === 'function') {
      addLog('ok', result.message || `${platName} 已恢复官方模式`);
    }

    // 同 antigravityPrimaryAction：重启确认优先弹，状态刷新后置，
    // 避免点击后卡 1-2 秒才出现弹窗。
    if (typeof promptRestartIde === 'function') {
      setPlatformBusy(target, false);
      await promptRestartIde('已切回官方直连，重启后生效。', target, { mode: 'direct', statusText: null });
    }
    await refreshPlatforms({ silent: true, reloadProviders: false });
    antigravityRefreshConsole({ silent: true });
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${platName} 切回官方失败: ` + e);
    showCustomAlert(String(e?.message || e), '切回官方失败', 'error');
  } finally {
    setPlatformBusy(target, false);
  }
}

function renderAntigravityConfigList(info = {}) {
  if (typeof antigravityRefreshConsole === 'function') {
    antigravityRefreshConsole({ silent: true });
  }
}

async function syncAntigravityConfigUiAfterStoreChange(options = {}) {
  if (!options?.skipPersist && typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) {
      if (typeof renderProviders === 'function') renderProviders();
      if (typeof antigravityRefreshConsole === 'function') antigravityRefreshConsole({ silent: true });
      return false;
    }
  }
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
  if (typeof renderModelMap === 'function') await renderModelMap();
  if (typeof antigravityRefreshConsole === 'function') antigravityRefreshConsole({ silent: true });
  renderPlatformProviderOptions();
  return true;
}

function isOfficialGoogleGeminiOnlyEndpointForUi(host, apiPath) {
  const h = String(host || '').trim().toLowerCase();
  const p = String(apiPath || '').trim().toLowerCase();
  const joined = `${h} ${p}`;
  if (
    joined.includes('/endpoints/openapi')
    || joined.includes('/openai/')
    || /\/openai(?:$|\?|\s)/.test(joined)
    || joined.includes('/chat/completions')
    || joined.includes('/responses')
    || joined.includes('/compatible-mode')
    || joined.includes('/publishers/anthropic/')
    || joined.includes(':rawpredict')
    || joined.includes(':streamrawpredict')
  ) {
    return false;
  }
  return h.includes('generativelanguage.googleapis.com')
    || /(?:^|\/\/|\.)aiplatform(?:\.[a-z0-9-]+)?(?:\.rep)?\.googleapis\.com(?:\/|:|\?|$)/.test(h)
    || p.includes('/publishers/google/models');
}

function inferProviderApiFormat(provider, modelId = '', fallback = 'openai') {
  const host = String(provider?.apiHost || '').trim();
  const apiPath = String(provider?.apiPath || '').trim();
  if (isOfficialGoogleGeminiOnlyEndpointForUi(host, apiPath)) {
    return 'gemini';
  }
  const explicit = String(provider?.apiFormat || '').trim().toLowerCase();
  if (explicit === 'openai' || explicit === 'anthropic' || explicit === 'gemini') {
    return explicit;
  }
  if (typeof globalThis.inferExplicitFormatFromEndpoint === 'function') {
    const inferred = globalThis.inferExplicitFormatFromEndpoint(host, apiPath);
    if (inferred) return inferred;
  }
  const endpoint = `${host} ${apiPath}`.toLowerCase();
  if (endpoint.includes('/publishers/anthropic/') || endpoint.includes(':rawpredict') || endpoint.includes('/v1/messages')) {
    return 'anthropic';
  }
  if (endpoint.includes('/endpoints/openapi') || endpoint.includes('/chat/completions') || endpoint.includes('/responses')) {
    return 'openai';
  }
  if (
    endpoint.includes('generativelanguage.googleapis.com')
    || endpoint.includes('/publishers/google/models')
    || endpoint.includes(':generatecontent')
    || endpoint.includes(':streamgeneratecontent')
    || endpoint.includes('/v1beta')
    || /(?:^|\/\/|\s)(?:[a-z0-9-]+-)?aiplatform(?:\.[a-z0-9-]+)?(?:\.rep)?\.googleapis\.com(?:\/|:|\?|$)/.test(endpoint)
  ) {
    return 'gemini';
  }
  const m = String(modelId || provider?.defaultModel || '').toLowerCase();
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('claude')) return 'anthropic';
  return ['openai', 'anthropic', 'gemini'].includes(fallback) ? fallback : 'openai';
}

function resolveAntigravityConfigView(item) {
  if (typeof resolveBoundProviderView === 'function') {
    return resolveBoundProviderView(item, providerStore);
  }
  const cfg = item && typeof item === 'object' ? item : {};
  const providers = Array.isArray(providerStore?.providers) ? providerStore.providers : [];
  const source = cfg.sourceProviderId ? providers.find(p => p && p.id === cfg.sourceProviderId) : null;
  const host = source ? String(source.apiHost || '') : String(cfg.apiHost || '');
  const apiPath = source ? String(source.apiPath || '') : String(cfg.apiPath || '');
  const overrideFormat = String(cfg.apiFormatOverride || '').trim().toLowerCase();
  const effectiveSource = source
    ? {
        ...source,
        apiFormat: overrideFormat || source.apiFormat || '',
      }
    : {
        ...cfg,
        apiFormat: overrideFormat || cfg.apiFormat || '',
      };
  const fallbackFormat = source
    ? (String(cfg.apiFormat || '').trim().toLowerCase() || 'openai')
    : 'openai';
  const apiFormat = inferProviderApiFormat(effectiveSource, cfg.defaultModel || '', fallbackFormat);
  return {
    source,
    hasSource: Boolean(source),
    sourceProviderName: String((source && source.name) || cfg.sourceProviderName || cfg.name || '').trim(),
    apiHost: host,
    apiPath,
    apiFormat,
    apiFormatOverride: overrideFormat,
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      try { antigravityRenderTableRows(); } catch (_) {}
    });
  } else {
    setTimeout(() => {
      try { antigravityRenderTableRows(); } catch (_) {}
    }, 0);
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.antigravityFilterModels = antigravityFilterModels;
  g.antigravityToggleSelectAll = antigravityToggleSelectAll;
  g.antigravityToggleSelectAllVisible = antigravityToggleSelectAllVisible;
  g.antigravityToggleRowSelect = antigravityToggleRowSelect;
  g.antigravityUpdateBulkActionButtons = antigravityUpdateBulkActionButtons;
  g.antigravityToggleThirdPartyVision = antigravityToggleThirdPartyVision;
  g.antigravityBulkThirdPartyVisionAction = antigravityBulkThirdPartyVisionAction;
  g.antigravityToggleModelEnabled = antigravityToggleModelEnabled;
  g.antigravityBulkEnableAction = antigravityBulkEnableAction;
  g.antigravityBulkDisableAction = antigravityBulkDisableAction;
  g.antigravityBulkRemoveAction = antigravityBulkRemoveAction;
  g.antigravityPrimaryAction = antigravityPrimaryAction;
  g.antigravityRestoreAction = antigravityRestoreAction;
  g.restoreAntigravityOfficialConfig = restoreAntigravityOfficialConfig;
  g.renderAntigravityConfigList = renderAntigravityConfigList;
  g.syncAntigravityConfigUiAfterStoreChange = syncAntigravityConfigUiAfterStoreChange;
  g.isOfficialGoogleGeminiOnlyEndpointForUi = isOfficialGoogleGeminiOnlyEndpointForUi;
  g.inferProviderApiFormat = inferProviderApiFormat;
  g.resolveAntigravityConfigView = resolveAntigravityConfigView;
})(globalThis);
