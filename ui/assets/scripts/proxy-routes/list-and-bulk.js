// proxy-routes/list-and-bulk.js — 内置模型路由列表渲染、多选批量操作与开关控制

async function saveProxyRoutes(options = {}) {
  if (!invoke) {
    const message = '当前环境缺少 Tauri invoke，无法保存内置模型列表';
    addLog('err', message);
    showCustomAlert(message, '保存失败', 'error');
    return false;
  }
  // 未加载成功时不写盘，并且明确报错（调用方已经改过内存数据，这里绝不能再重新加载覆盖它）。
  if (!globalThis.proxyRoutesStoreLoaded) {
    const reason = String(globalThis.proxyRoutesLoadError || '未知原因');
    const message = `内置模型列表还没加载成功，为避免覆盖已有配置已放弃保存。请先点「模型列表」右上角的刷新（或下面的「重试加载」）后再操作。失败原因：${reason}`;
    addLog('err', '保存内置模型列表失败: ' + reason);
    showCustomAlert(message, '保存失败', 'error');
    return false;
  }
  try {
    proxyRoutesStore = normalizeProxyRoutesStore(proxyRoutesStore);
    await invoke('save_proxy_routes', { store: proxyRoutesStore });
    renderProxyRoutes();
    if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
    if (!options.silent) {
      addLog('ok', `内置模型列表已保存: ${proxyRoutesStore.routes.length} 个模型`);
      showBottomToast('内置模型列表已保存', 'success');
    }
    return true;
  } catch (e) {
    addLog('err', '保存内置模型列表失败: ' + e);
    showCustomAlert(String(e), '保存失败', 'error');
    return false;
  }
}

async function toggleProxyRouteEnabled(routeId, checked) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  const previous = cloneProxyRoutesStore();
  route.enabled = checked === true;
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(route.enabled ? '已启用模型' : '已停用模型', 'success');
}

async function toggleProxyRouteThirdPartyVision(routeId, checked) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  const previous = cloneProxyRoutesStore();
  route.enhancement = route.enhancement && typeof route.enhancement === 'object' ? route.enhancement : {};
  route.enhancement.thirdPartyVision = checked === true;
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(route.enhancement.thirdPartyVision ? '已启用第三方图片理解' : '已关闭第三方图片理解', 'success');
}

function cloneProxyRoutesStore(store = proxyRoutesStore) {
  return JSON.parse(JSON.stringify(store || { version: 1, defaultModelId: '', routes: [] }));
}

async function deleteProxyRoute(routeId) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  const previous = cloneProxyRoutesStore();
  proxyRoutesStore.routes = proxyRoutesStore.routes.filter(item => item.id !== routeId);
  proxyRouteSelectedIds.delete(routeId);
  proxyRoutesStore.defaultModelId = '';
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast('已删除模型', 'success');
}

function pruneProxyRouteSelection() {
  const valid = new Set((proxyRoutesStore.routes || []).map(route => route.id));
  proxyRouteSelectedIds.forEach(id => {
    if (!valid.has(id)) proxyRouteSelectedIds.delete(id);
  });
}

function visibleProxyRouteIds() {
  return Array.from(document.querySelectorAll('#proxyRoutesTableBody tr[data-proxy-route-id]'))
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.proxyRouteId)
    .filter(Boolean);
}

function syncProxyRouteSelectionState() {
  pruneProxyRouteSelection();
  const selected = proxyRouteSelectedIds.size;
  const deleteBtn = document.getElementById('proxyRoutesDeleteSelectedBtn');
  if (deleteBtn) {
    deleteBtn.disabled = selected === 0;
    const label = deleteBtn.querySelector('.proxy-routes-delete-label');
    if (label) label.textContent = selected ? `删除选中 (${selected})` : '删除选中';
  }
  const visibleIds = visibleProxyRouteIds();
  const selectedVisible = visibleIds.filter(id => proxyRouteSelectedIds.has(id)).length;
  const selectAll = document.getElementById('proxyRoutesSelectAll');
  if (selectAll) {
    selectAll.disabled = visibleIds.length === 0;
    selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
  // 批量操作按钮
  const hasSelection = selected > 0;
  const selectVisibleBtn = document.getElementById('proxyRoutesSelectVisibleBtn');
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = visibleIds.length === 0;
    const allSelected = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectVisibleBtn.textContent = allSelected ? '取消选择' : '选择当前';
  }
  const enableBtn = document.getElementById('proxyRoutesBulkEnableBtn');
  if (enableBtn) enableBtn.disabled = !hasSelection;
  const disableBtn = document.getElementById('proxyRoutesBulkDisableBtn');
  if (disableBtn) disableBtn.disabled = !hasSelection;
  const visionBtn = document.getElementById('proxyRoutesBulkVisionBtn');
  if (visionBtn) visionBtn.disabled = !hasSelection;
  // 计数
  const countPill = document.getElementById('proxyRoutesBulkCount');
  if (countPill) {
    const total = proxyRoutesStore.routes?.length || 0;
    countPill.textContent = selected > 0 ? `已选 ${selected} / 共 ${total} 个` : `共 ${total} 个`;
  }
}

function toggleProxyRouteSelection(routeId, checked) {
  if (!routeId) return;
  if (checked) proxyRouteSelectedIds.add(routeId);
  else proxyRouteSelectedIds.delete(routeId);
  const row = Array.from(document.querySelectorAll('#proxyRoutesTableBody tr[data-proxy-route-id]'))
    .find(item => item.dataset.proxyRouteId === routeId);
  if (row) row.classList.toggle('is-selected', checked);
  syncProxyRouteSelectionState();
}

function toggleProxyRoutesSelectAll(checked) {
  const ids = visibleProxyRouteIds();
  ids.forEach(id => {
    if (checked) proxyRouteSelectedIds.add(id);
    else proxyRouteSelectedIds.delete(id);
  });
  renderProxyRoutes();
}

async function deleteSelectedProxyRoutes() {
  pruneProxyRouteSelection();
  if (!proxyRouteSelectedIds.size) return;
  const previous = cloneProxyRoutesStore();
  const removed = new Set(proxyRouteSelectedIds);
  proxyRoutesStore.routes = (proxyRoutesStore.routes || []).filter(route => !removed.has(route.id));
  proxyRouteSelectedIds.clear();
  proxyRoutesStore.defaultModelId = '';
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(`已删除 ${removed.size} 个模型`, 'success');
}

function toggleVisibleProxyRouteSelection() {
  const visible = visibleProxyRouteIds();
  if (!visible.length) return;
  const allSelected = visible.every(id => proxyRouteSelectedIds.has(id));
  visible.forEach(id => {
    if (allSelected) proxyRouteSelectedIds.delete(id);
    else proxyRouteSelectedIds.add(id);
  });
  renderProxyRoutes();
}

async function batchSetSelectedProxyRoutesEnabled(enabled) {
  pruneProxyRouteSelection();
  if (!proxyRouteSelectedIds.size) return;
  const previous = cloneProxyRoutesStore();
  const targets = (proxyRoutesStore.routes || []).filter(r => proxyRouteSelectedIds.has(r.id));
  targets.forEach(r => { r.enabled = enabled === true; });
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(`已${enabled ? '启用' : '停用'} ${targets.length} 个模型`, 'success');
}

async function batchSetSelectedProxyRoutesThirdPartyVision(enabled) {
  pruneProxyRouteSelection();
  if (!proxyRouteSelectedIds.size) return;
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (enabled && !hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置第三方图片理解模型。', '无法启用', 'warn');
    return;
  }
  const previous = cloneProxyRoutesStore();
  const targets = (proxyRoutesStore.routes || []).filter(r => proxyRouteSelectedIds.has(r.id));
  targets.forEach(r => {
    r.enhancement = r.enhancement && typeof r.enhancement === 'object' ? r.enhancement : {};
    r.enhancement.thirdPartyVision = enabled === true;
  });
  const ok = await saveProxyRoutes({ silent: true });
  if (!ok) {
    proxyRoutesStore = normalizeProxyRoutesStore(previous);
    renderProxyRoutes();
    return;
  }
  showBottomToast(`已${enabled ? '启用' : '关闭'} ${targets.length} 个模型的第三方图片理解`, 'success');
}

function proxyRouteBadges(route) {
  const caps = [];
  if (route.capabilities?.stream) caps.push('流式');
  if (route.capabilities?.tools) caps.push('工具');
  if (route.capabilities?.vision) caps.push('图片');
  if (route.capabilities?.reasoning) caps.push('推理');
  return caps.length
    ? caps.map(label => `<span class="proxy-route-badge">${proxyRouteEsc(label)}</span>`).join('')
    : '<span class="proxy-route-muted">未确认</span>';
}

function renderProxyRoutes() {
  proxyRoutesStore = normalizeProxyRoutesStore(proxyRoutesStore);
  const body = document.getElementById('proxyRoutesTableBody');
  if (!body) return;
  const card = document.querySelector('.proxy-routes-card');
  const tableWrap = document.querySelector('.proxy-routes-table-wrap');
  const query = (document.getElementById('proxyRoutesSearch')?.value || '').trim().toLowerCase();
  const routes = proxyRoutesStore.routes.filter(route => {
    const renderedId = proxyRouteRenderedId(route);
    const hay = [
      route.id,
      renderedId,
      route.source,
      ...(route.targets || []).flatMap(t => {
        const p = providerStore?.providers?.find(x => x.id === t.providerId);
        return [
          t.providerId,
          proxyRouteProviderName(t.providerId),
          t.model,
          t.apiFormat,
          t.unlock,
          proxyRouteTargetRouteLabel(t),
          p?.baseUrl,
          p?.apiHost
        ];
      })
    ].join(' ').toLowerCase();
    return !query || hay.includes(query);
  });
  pruneProxyRouteSelection();
  const enabledCount = proxyRoutesStore.routes.filter(route => route.enabled !== false).length;
  setText('proxyRoutesTotal', String(proxyRoutesStore.routes.length));
  setText('proxyRoutesEnabled', String(enabledCount));
  setText('proxy-page-route-total', String(proxyRoutesStore.routes.length));
  setText('proxy-page-route-enabled', String(enabledCount));
  if (card) card.classList.toggle('is-empty-store', proxyRoutesStore.routes.length === 0);

  if (!routes.length) {
    if (tableWrap) tableWrap.classList.add('is-empty');
    const isFiltered = proxyRoutesStore.routes.length > 0;
    body.innerHTML = `<tr class="proxy-routes-empty-row"><td colspan="7">
      <div class="proxy-routes-empty-state">
        <div class="proxy-routes-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="9" x2="15" y2="9" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="13" y2="17" />
          </svg>
        </div>
        <div class="proxy-routes-empty-title">${isFiltered ? '没有匹配的模型' : '尚未配置内置模型'}</div>
        <div class="proxy-routes-empty-subtitle">${isFiltered ? '换个关键词再试。' : '从供应商模型中添加到内置模型列表。'}</div>
        ${isFiltered ? '' : '<button type="button" class="btn-primary proxy-routes-empty-action" data-action="openProxyRouteEditor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>添加模型</button>'}
      </div>
    </td></tr>`;
    syncProxyRouteSelectionState();
    return;
  }

  if (tableWrap) tableWrap.classList.remove('is-empty');
  body.innerHTML = routes.map(route => {
    const targetText = route.targets?.length
      ? route.targets.map((target, idx) => `<div class="proxy-route-target-line"><span>${idx + 1}</span>${proxyRouteEsc(proxyRouteTargetLabel(target))}</div>`).join('')
      : '<span class="proxy-route-muted">未配置目标</span>';
    const selected = proxyRouteSelectedIds.has(route.id);
    const thirdPartyVision = route.enhancement?.thirdPartyVision === true;
    const renderedId = proxyRouteRenderedId(route);
    const iconModelKey = (typeof getModelIconKey === 'function')
      ? (getModelIconKey(route.id) || getModelIconKey(route.targets?.[0]?.model) || getModelIconKey(renderedId))
      : null;
    const modelIconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(iconModelKey || route.targets?.[0]?.model || route.id)
      : `<div class="model-item-icon fallback">${proxyRouteEsc(String(route.id || '?').charAt(0).toUpperCase())}</div>`;
    return `
      <tr data-proxy-route-id="${proxyRouteEsc(route.id)}" class="${selected ? 'is-selected' : ''}">
        <td class="proxy-route-select-cell model-map-select-cell" data-action="__noop" data-stop>
          <label class="provider-select-check provider-select-check-table" title="选择此模型" data-action="__noop" data-stop>
            <input type="checkbox" class="proxy-route-row-check" aria-label="选择 ${proxyRouteEsc(route.id)}" ${selected ? 'checked' : ''} data-action="toggleProxyRouteSelection" data-events="change" data-args="[&quot;${proxyRouteEsc(route.id)}&quot;]" data-pass-checked>
            <span></span>
          </label>
        </td>
        <td>
          <div class="proxy-route-model-id-wrap">
            ${modelIconHtml}
            <code class="proxy-route-model-id">${proxyRouteEsc(renderedId)}</code>
          </div>
        </td>
        <td>${targetText}</td>
        <td><div class="proxy-route-badges">${proxyRouteBadges(route)}</div></td>
        <td>
          <div class="model-map-actions proxy-route-row-actions">
            <button class="btn-icon model-map-action-btn" data-action="openProxyRouteEditor" data-arg="${proxyRouteEsc(route.id)}" title="编辑模型" aria-label="编辑模型">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" data-action="deleteProxyRoute" data-arg="${proxyRouteEsc(route.id)}" title="删除模型" aria-label="删除模型">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="proxy-route-toggle-cell model-map-toggle-cell">
          <label class="toggle-switch" title="${thirdPartyVision ? '已启用第三方图片理解' : '已关闭第三方图片理解'}">
            <input type="checkbox" ${thirdPartyVision ? 'checked' : ''} data-action="toggleProxyRouteThirdPartyVision" data-events="change" data-args="[&quot;${proxyRouteEsc(route.id)}&quot;]" data-pass-checked>
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="proxy-route-enabled-cell model-map-toggle-cell">
          <label class="toggle-switch" title="${route.enabled ? '已启用' : '已禁用'}">
            <input type="checkbox" ${route.enabled ? 'checked' : ''} data-action="toggleProxyRouteEnabled" data-events="change" data-args="[&quot;${proxyRouteEsc(route.id)}&quot;]" data-pass-checked>
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>`;
  }).join('');
  syncProxyRouteSelectionState();
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.saveProxyRoutes = saveProxyRoutes;
  g.toggleProxyRouteEnabled = toggleProxyRouteEnabled;
  g.toggleProxyRouteThirdPartyVision = toggleProxyRouteThirdPartyVision;
  g.cloneProxyRoutesStore = cloneProxyRoutesStore;
  g.deleteProxyRoute = deleteProxyRoute;
  g.pruneProxyRouteSelection = pruneProxyRouteSelection;
  g.visibleProxyRouteIds = visibleProxyRouteIds;
  g.syncProxyRouteSelectionState = syncProxyRouteSelectionState;
  g.toggleProxyRouteSelection = toggleProxyRouteSelection;
  g.toggleProxyRoutesSelectAll = toggleProxyRoutesSelectAll;
  g.deleteSelectedProxyRoutes = deleteSelectedProxyRoutes;
  g.toggleVisibleProxyRouteSelection = toggleVisibleProxyRouteSelection;
  g.batchSetSelectedProxyRoutesEnabled = batchSetSelectedProxyRoutesEnabled;
  g.batchSetSelectedProxyRoutesThirdPartyVision = batchSetSelectedProxyRoutesThirdPartyVision;
  g.proxyRouteBadges = proxyRouteBadges;
  g.renderProxyRoutes = renderProxyRoutes;
})(globalThis);
