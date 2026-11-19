// platforms/cursor_add.js — split from 55-platforms.js
// ═══════ CURSOR 独立添加模型页面 ═══════

async function openCursorAddPage() {
  navigateTo('platform-cursor-add');
  await initCursorAddPage();
}

async function initCursorAddPage() {
  cursorEnsureBridge();
  try {
    const raw = await invoke('cursor_list_provider_models') || [];
    globalThis._cursorProviderModels = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[cursor-add] list provider models failed:', e);
    globalThis._cursorProviderModels = [];
  }

  // 注入 AnyBridge 内置供应商到列表首位
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    if (lp && Array.isArray(lp.models)) {
      lp.models.forEach(m => {
        const already = (globalThis._cursorModelsList || []).some(item =>
          item.targetModel === m.id || item.exposedModelId === m.id || item.id === m.id
        );
        m.alreadyAdded = already;
      });
    }
    globalThis._cursorProviderModels = globalThis._cursorProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    globalThis._cursorProviderModels.unshift(lp);
  }

  globalThis._cursorAddSelectedProvider = null;
  globalThis._cursorAddSelectedModels.clear();
  globalThis._cursorAddSearchKw = '';

  const searchInput = document.getElementById('cursor-add-search');
  if (searchInput) searchInput.value = '';

  // 默认选中第一个有模型的供应商（优先排在最前的内置供应商或第一项）
  const sorted = platformAddVisibleProviders(globalThis._cursorProviderModels, '');
  const firstWithModels = sorted.find(p => p.models && p.models.length > 0);
  if (firstWithModels) {
    globalThis._cursorAddSelectedProvider = firstWithModels.providerId;
  }

  renderCursorAddProviderList();
  renderCursorAddModels();
  updateCursorAddConfirmButton();
}

function onCursorAddSearch() {
  const input = document.getElementById('cursor-add-search');
  globalThis._cursorAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderCursorAddProviderList();
}

function toggleCursorAddSort(event) {
  togglePlatformAddSortMenu('cursor', event);
}

function chooseCursorAddSortMode(mode) {
  choosePlatformAddSortMode('cursor', mode);
}

function renderCursorAddProviderList() {
  const list = document.getElementById('cursor-add-provider-list');
  syncPlatformAddSortControl('cursor');
  if (!list) return;

  if (!globalThis._cursorProviderModels || globalThis._cursorProviderModels.length === 0) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无可用的供应商，请先在「供应商」页添加</div>';
    return;
  }

  const filtered = platformAddVisibleProviders(globalThis._cursorProviderModels, globalThis._cursorAddSearchKw);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }

  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = globalThis._cursorAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const availableCount = (p.models || []).length;
    const alreadyCount = (p.models || []).filter(m => m.alreadyAdded).length;
    const countDisplay = alreadyCount > 0 ? `${alreadyCount}/${availableCount}` : String(availableCount);

    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="AnyBridge 内置供应商"><span>内置</span><span>供应商</span></span>`
      : `<span class="cb-add-prov-icon">${cursorEsc(initial)}</span>`;

    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectCursorAddProvider" data-arg="${cursorEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${cursorEsc(p.providerName)}</span>
        <span class="cb-add-prov-count" title="共 ${availableCount} 个模型，其中 ${alreadyCount} 个已添加">${countDisplay}</span>
      </div>
    `;
  }).join('');
}

function selectCursorAddProvider(providerId) {
  globalThis._cursorAddSelectedProvider = providerId;
  renderCursorAddProviderList();
  renderCursorAddModels();
  updateCursorAddConfirmButton();
}

function renderCursorAddModels() {
  const titleEl = document.getElementById('cursor-add-models-title');
  const subEl = document.getElementById('cursor-add-models-sub');
  const body = document.getElementById('cursor-add-models-list-page');
  if (!body) return;

  if (!globalThis._cursorAddSelectedProvider) {
    if (titleEl) titleEl.textContent = '请选择供应商';
    if (subEl) subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = globalThis._cursorProviderModels.find(p => p.providerId === globalThis._cursorAddSelectedProvider);
  if (!provider) {
    if (titleEl) titleEl.textContent = '供应商未找到';
    if (subEl) subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  if (titleEl) titleEl.textContent = provider.providerName;
  if (subEl) subEl.textContent = `该供应商下共有 ${provider.models.length} 个模型可供添加到 Cursor`;

  const models = provider.models || [];
  if (models.length === 0) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型，请在供应商管理中拉取或添加模型</div>';
    return;
  }

  const selectedForProv = globalThis._cursorAddSelectedModels.get(provider.providerId) || new Set();

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(models);

  body.innerHTML = sortedModels.map(m => {
    const isAlready = !!m.alreadyAdded;
    const isSelected = selectedForProv.has(m.id);
    const caps = [];
    if (m.supportsToolCall) caps.push(cbCapabilityPill('cb', 'tool', '工具'));
    if (m.supportsImages) caps.push(cbCapabilityPill('cb', 'image', '图片'));
    if (m.supportsReasoning) caps.push(cbCapabilityPill('cb', 'reason', '推理'));

    return `
      <label class="cb-add-model-row ${isAlready ? 'already-added' : ''}" data-model-id="${cursorEsc(m.id)}">
        <input type="checkbox" class="cb-add-model-check" data-model-id="${cursorEsc(m.id)}" ${isAlready ? 'disabled checked' : (isSelected ? 'checked' : '')} onchange="toggleCursorAddModel('${cursorEsc(provider.providerId)}', '${cursorEsc(m.id)}', this.checked)">
        ${cbAddModelIdentity(m.id)}
        <div class="cb-add-model-caps" style="margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          ${caps.join('')}
          ${isAlready ? '<span class="tag" style="background:rgba(148,163,184,0.15);color:var(--text-muted);font-size:12px;">已添加</span>' : ''}
        </div>
      </label>
    `;
  }).join('');
}

function toggleCursorAddModel(providerId, modelId, isChecked) {
  const provider = globalThis._cursorProviderModels.find(p => p.providerId === providerId);
  if (!provider) return;
  const model = (provider.models || []).find(m => m.id === modelId);
  if (!model || model.alreadyAdded) return;

  if (!globalThis._cursorAddSelectedModels.has(providerId)) {
    globalThis._cursorAddSelectedModels.set(providerId, new Set());
  }
  const set = globalThis._cursorAddSelectedModels.get(providerId);
  if (typeof isChecked === 'boolean') {
    if (isChecked) {
      set.add(modelId);
    } else {
      set.delete(modelId);
    }
  } else {
    if (set.has(modelId)) {
      set.delete(modelId);
    } else {
      set.add(modelId);
    }
  }

  updateCursorAddConfirmButton();
}

function cursorAddSelectAll() {
  if (!globalThis._cursorAddSelectedProvider) return;
  const provider = globalThis._cursorProviderModels.find(p => p.providerId === globalThis._cursorAddSelectedProvider);
  if (!provider) return;

  if (!globalThis._cursorAddSelectedModels.has(globalThis._cursorAddSelectedProvider)) {
    globalThis._cursorAddSelectedModels.set(globalThis._cursorAddSelectedProvider, new Set());
  }
  const set = globalThis._cursorAddSelectedModels.get(globalThis._cursorAddSelectedProvider);

  const container = document.getElementById('cursor-add-models-list-page');
  if (container) {
    const checks = container.querySelectorAll('.cb-add-model-check:not(:disabled)');
    checks.forEach(chk => {
      chk.checked = true;
      const mid = chk.dataset.modelId;
      if (mid) set.add(mid);
    });
  } else {
    (provider.models || []).forEach(m => {
      if (!m.alreadyAdded) set.add(m.id);
    });
  }

  updateCursorAddConfirmButton();
}

function cursorAddSelectNone() {
  if (!globalThis._cursorAddSelectedProvider) return;
  if (globalThis._cursorAddSelectedModels.has(globalThis._cursorAddSelectedProvider)) {
    globalThis._cursorAddSelectedModels.get(globalThis._cursorAddSelectedProvider).clear();
  }
  const container = document.getElementById('cursor-add-models-list-page');
  if (container) {
    const checks = container.querySelectorAll('.cb-add-model-check:not(:disabled)');
    checks.forEach(chk => {
      chk.checked = false;
    });
  }
  updateCursorAddConfirmButton();
}

function updateCursorAddConfirmButton() {
  let totalSelected = 0;
  globalThis._cursorAddSelectedModels.forEach(set => {
    totalSelected += set.size;
  });

  const btn = document.getElementById('cursor-add-confirm-page');
  if (btn) {
    btn.disabled = totalSelected === 0;
    const label = btn.querySelector('.model-action-label');
    if (label) {
      label.textContent = totalSelected > 0 ? ` 保存选择 (${totalSelected})` : ' 保存选择';
    }
  }
}

function onCursorAddNamingRuleChange() {
  const prefix = (document.getElementById('cursor-add-prefix')?.value || '').trim();
  const suffix = (document.getElementById('cursor-add-suffix')?.value || '').trim();
  const previewEl = document.getElementById('cursor-add-naming-preview');
  if (previewEl) {
    let name = 'gpt-5.4';
    if (prefix) name = `${prefix} ${name}`;
    if (suffix) name = `${name} ${suffix}`;
    previewEl.textContent = name;
  }
}

async function confirmAddCursorModelsPage() {
  const modelsPayload = [];
  globalThis._cursorAddSelectedModels.forEach((modelSet, providerId) => {
    modelSet.forEach(modelId => {
      modelsPayload.push({ providerId, modelId });
    });
  });

  if (modelsPayload.length === 0) return;

  const prefix = (document.getElementById('cursor-add-prefix')?.value || '').trim() || null;
  const suffix = (document.getElementById('cursor-add-suffix')?.value || '').trim() || null;

  const btn = document.getElementById('cursor-add-confirm-page');
  const label = btn ? btn.querySelector('.model-action-label') : null;
  const originalLabel = label ? label.textContent : ' 保存选择';
  if (btn) {
    btn.disabled = true;
    if (label) label.innerHTML = loadingHtml('保存中…');
  }

  cursorEnsureBridge();
  try {
    await invoke('cursor_add_models', {
      req: {
        models: modelsPayload,
        prefix,
        suffix
      }
    });
    globalThis._cursorAddSelectedModels.clear();
    navigateTo('platform-cursor');
    cursorRefreshConsole({ silent: true }).catch(err => {
      console.warn('[cursor] background refresh failed:', err);
    });
  } catch (e) {
    console.error('[cursor-add] confirm add failed:', e);
    showCustomAlert('添加模型失败: ' + e, '添加异常', 'error');
    if (btn) {
      btn.disabled = false;
      if (label) label.textContent = originalLabel;
    }
  } finally {
    if (btn && globalThis._cursorAddSelectedModels.size === 0) {
      btn.disabled = true;
      if (label) label.textContent = ' 保存选择';
    }
  }
}

function openPlatformPage(platformId) {
  // 声明表新增的 agent 没有内置页面 → 通用页（避免 navigateTo 打空）
  const builtinPageId =
    platformId === 'antigravity-ide' ? 'platform-antigravity' : `platform-${platformId}`;
  if (!document.getElementById(`page-${builtinPageId}`) && !document.getElementById(builtinPageId)) {
    if (typeof openGenericAgentPage === 'function') {
      openGenericAgentPage(platformId);
      return;
    }
  }
  if (platformId === 'antigravity' || platformId === 'antigravity-ide') {
    globalThis._currentAntigravityTarget = platformId;
    // navigateTo 会按页面映射把侧边栏高亮重置为「反重力」，此处需按实际目标纠正
    if (typeof setPlatformRailActive === 'function') {
      setPlatformRailActive(platformId);
    }
  }
  const targetPage = builtinPageId;
  navigateTo(targetPage);
  renderPlatformDetailStatuses();
  renderPlatformProviderOptions();
  if (platformId === 'cursor') {
    if (globalThis._cursorModelsList && globalThis._cursorModelsList.length > 0) {
      cursorRenderTableRows();
    }
    cursorRefreshConsole({ silent: true }).catch(e => {
      if (typeof addLog === 'function') addLog('err', 'Cursor 控制台刷新失败: ' + e);
    });
  } else if (platformId === 'antigravity' || platformId === 'antigravity-ide') {
    antigravityRefreshConsole({ silent: true });
    antigravityRenderTableRows();
    if (typeof refreshPlatforms === 'function') {
      const _t = (k) => (typeof window?.t === 'function' ? window.t(k) : k);
      refreshPlatforms({ silent: true, reloadProviders: true }).catch(e => {
        if (typeof addLog === 'function') addLog('err', _t('ag.consoleRefreshFailedPrefix') + (e?.message || e));
      });
    }
  } else if (platformId === 'codebuddy') {
    loadCodeBuddyModels();
  } else if (platformId === 'workbuddy') {
    loadWbModels();
  } else if (platformId === 'zcode') {
    loadZcModels();
  } else if (platformId === 'pi') {
    loadPiModels();
  } else if (platformId === 'hermes') {
    loadHermesModels();
  } else if (platformId === 'deepseek-harness') {
    loadDshModels();
  } else if (platformId === 'grok' || platformId === 'claude-code' || platformId === 'codex' || platformId === 'opencode') {
    if (platformId === 'grok' && typeof renderGrokPageStatus === 'function') {
      renderGrokPageStatus(platformInfoOf('grok') || {});
    }
    if (typeof refreshPlatforms === 'function') {
      refreshPlatforms({ silent: true, force: true, reloadProviders: true }).catch(e => {
        if (typeof addLog === 'function') addLog('warn', `刷新 ${platformId} 状态失败: ` + e);
      });
    }
  } else if (platformId === 'claude-desktop') {
    if (typeof loadClaudeDesktopConsole === 'function') {
      loadClaudeDesktopConsole();
    }
  }
}

async function onPlatformProviderChange(platformId) {
  const select = document.getElementById(`platform-${platformId}-select`);
  const preview = document.getElementById(`platform-${platformId}-preview`);
  const applyBtn = document.getElementById(`platform-${platformId}-apply`);
  const providerId = select ? select.value : '';

  if (!preview) return;
  if (!providerId) {
    preview.textContent = '请选择供应商';
    if (applyBtn) applyBtn.disabled = true;
    if (platformId === 'codex') renderCodexTargetSummary(null);
    return;
  }

  const provider = platformProviderList(platformId).find(p => p.id === providerId);
  const def = platformDef(platformId);
  if (!provider) {
    preview.textContent = platformId === 'codex' ? 'Codex 配置不存在或尚未加载' : '供应商不存在或尚未加载';
    if (applyBtn) applyBtn.disabled = true;
    if (platformId === 'codex') renderCodexTargetSummary(null, 'Codex 配置不存在或尚未加载');
    return;
  }

  if (applyBtn) applyBtn.disabled = platformBusy === platformId;
  if (platformId === 'codex') renderCodexTargetSummary(provider);
  preview.textContent = '正在生成预览...';
  try {
    const text = await invoke('preview_platform_switch', { platform: platformId, providerId });
    preview.textContent = text || '无预览内容';
  } catch (e) {
    preview.textContent = '生成预览失败：' + e;
    if (applyBtn) applyBtn.disabled = true;
  }
}

function setPlatformBusy(platformId, busy) {
  platformBusy = busy ? platformId : null;
  ['apply', 'restore'].forEach(action => {
    const btn = document.getElementById(`platform-${platformId}-${action}`);
    if (btn) btn.disabled = busy;
  });
  if (platformId === 'codex') {
    document
      .querySelectorAll('.codex-row-action, .codex-add-config-btn, .codex-refresh-btn, .codex-restore-btn')
      .forEach(btn => { btn.disabled = busy; });
  }
  if (platformId === 'claude-code') {
    document
      .querySelectorAll('#page-platform-claude-code .codex-card-action, #page-platform-claude-code .codex-add-config-btn, #page-platform-claude-code .codex-refresh-btn, #page-platform-claude-code .codex-restore-btn')
      .forEach(btn => { btn.disabled = busy; });
  }
  if (platformId === 'opencode') {
    document
      .querySelectorAll('#page-platform-opencode .codex-card-action, #page-platform-opencode .codex-add-config-btn, #page-platform-opencode .codex-refresh-btn, #page-platform-opencode .codex-restore-btn')
      .forEach(btn => { btn.disabled = busy; });
  }
  const select = document.getElementById(`platform-${platformId}-select`);
  if (select) select.disabled = busy;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openCursorAddPage = openCursorAddPage;
  g.initCursorAddPage = initCursorAddPage;
  g.onCursorAddSearch = onCursorAddSearch;
  g.toggleCursorAddSort = toggleCursorAddSort;
  g.chooseCursorAddSortMode = chooseCursorAddSortMode;
  g.renderCursorAddProviderList = renderCursorAddProviderList;
  g.selectCursorAddProvider = selectCursorAddProvider;
  g.renderCursorAddModels = renderCursorAddModels;
  g.toggleCursorAddModel = toggleCursorAddModel;
  g.cursorAddSelectAll = cursorAddSelectAll;
  g.cursorAddSelectNone = cursorAddSelectNone;
  g.updateCursorAddConfirmButton = updateCursorAddConfirmButton;
  g.onCursorAddNamingRuleChange = onCursorAddNamingRuleChange;
  g.confirmAddCursorModelsPage = confirmAddCursorModelsPage;
  g.openPlatformPage = openPlatformPage;
  g.onPlatformProviderChange = onPlatformProviderChange;
  g.setPlatformBusy = setPlatformBusy;
})(globalThis);
