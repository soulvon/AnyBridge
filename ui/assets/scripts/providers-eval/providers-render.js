// providers-eval/providers-render.js — 供应商卡片/列表渲染、多选批量与平台解锁弹窗
import { escAttr, escapeHtml } from '../ui/dom.js';

function providerVisibleList(list = providerListAll()) {
  const terms = providerSearchKeyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length ? list.filter(p => {
    const text = providerSearchHaystack(p);
    return terms.every(term => text.includes(term));
  }) : list;
  return providerSortedList(visible);
}

function cleanupProviderSelection(list = providerListAll()) {
  const valid = new Set(list.map(p => p.id));
  providerSelectedIds.forEach(id => {
    if (!valid.has(id)) providerSelectedIds.delete(id);
  });
}

function providerModelBadges(p, limit = Infinity) {
  const modelsList = providerSelectedModels(p);
  const shown = modelsList.slice(0, limit);
  const chips = shown.map((m, idx) => {
    return `
      <span class="tag provider-model-chip" data-action="copyTextToClipboard" data-args="[&quot;${escAttr(m)}&quot;,&quot;模型 ID&quot;]" title="点击复制模型 ID: ${escAttr(m)}" style="cursor:pointer;">
        ${typeof renderModelIcon === 'function' ? renderModelIcon(m) : ''}
        <span class="provider-model-chip-text">${escAttr(m)}</span>
        ${idx === 0 ? '<span class="provider-model-default">(默认)</span>' : ''}
      </span>
    `;
  });
  if (Number.isFinite(limit) && modelsList.length > limit) {
    chips.push(`<span class="tag provider-model-more">+${modelsList.length - limit}</span>`);
  }
  return chips.join('');
}

function renderProviderToolbarState(total, visible) {
  const search = document.getElementById('providerSearchInput');
  if (search && search.value !== providerSearchKeyword) search.value = providerSearchKeyword;
  const clear = document.getElementById('providerSearchClear');
  if (clear) clear.style.display = providerSearchKeyword.trim() ? 'inline-flex' : 'none';

  const gridBtn = document.getElementById('providerViewGridBtn');
  const listBtn = document.getElementById('providerViewListBtn');
  if (gridBtn) gridBtn.classList.toggle('active', providerViewMode !== 'list');
  if (listBtn) listBtn.classList.toggle('active', providerViewMode === 'list');

  syncProviderSortControl();

  const visibleIds = visible.map(p => p.id).filter(Boolean);
  const selectedCount = providerSelectedIds.size;
  const selectedVisibleCount = visibleIds.filter(id => providerSelectedIds.has(id)).length;
  const bulkCount = document.getElementById('providerBulkCount');
  if (bulkCount) {
    bulkCount.textContent = selectedCount
      ? `已选择 ${selectedCount}`
      : (providerSearchKeyword.trim() ? `${visible.length}/${total} 个结果` : `共 ${total} 个`);
  }

  const selectVisibleBtn = document.getElementById('providerSelectVisibleBtn');
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = providerBulkRunning || visibleIds.length === 0;
    selectVisibleBtn.textContent = visibleIds.length && selectedVisibleCount === visibleIds.length ? '取消当前' : '选择当前';
  }
  ['providerBulkEnableBtn', 'providerBulkDisableBtn', 'providerBulkDeleteBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = providerBulkRunning || selectedCount === 0;
  });
}

function onProviderSearchInput(value) {
  providerSearchKeyword = String(value || '');
  renderProviders();
}

function clearProviderSearch() {
  providerSearchKeyword = '';
  const input = document.getElementById('providerSearchInput');
  if (input) input.value = '';
  renderProviders();
}

function setProviderViewMode(mode) {
  const previous = providerViewMode;
  providerViewMode = mode === 'list' ? 'list' : 'grid';
  try {
    localStorage.setItem(PROVIDER_VIEW_STORAGE_KEY, providerViewMode);
  } catch (e) {
    providerViewMode = previous;
    addLog('err', '保存供应商视图偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  renderProviders();
}

function setProviderSortMode(mode) {
  const previous = providerSortMode;
  providerSortMode = normalizeProviderSortMode(mode);
  try {
    localStorage.setItem(PROVIDER_SORT_STORAGE_KEY, providerSortMode);
  } catch (e) {
    providerSortMode = previous;
    addLog('err', '保存供应商排序偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  renderProviders();
}

function syncProviderSortControl() {
  const label = document.getElementById('providerSortLabel');
  if (label) label.textContent = providerSortLabel(providerSortMode);
  document.querySelectorAll('#providerSortMenu .provider-sort-option').forEach(btn => {
    const selected = btn.dataset.sortMode === providerSortMode;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function setProviderSortMenuOpen(open) {
  const control = document.getElementById('providerSortControl');
  const trigger = document.getElementById('providerSortTrigger');
  if (!control || !trigger) return;
  control.classList.toggle('open', !!open);
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleProviderSortMenu(event) {
  if (event) event.stopPropagation();
  const control = document.getElementById('providerSortControl');
  syncProviderSortControl();
  setProviderSortMenuOpen(!control?.classList.contains('open'));
}

function closeProviderSortMenu() {
  setProviderSortMenuOpen(false);
}

function chooseProviderSortMode(mode) {
  setProviderSortMode(mode);
  closeProviderSortMenu();
  document.getElementById('providerSortTrigger')?.focus();
}

document.addEventListener('click', event => {
  const control = document.getElementById('providerSortControl');
  if (control && !control.contains(event.target)) closeProviderSortMenu();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProviderSortMenu();
});

function toggleProviderSelection(id, checked, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  if (checked) providerSelectedIds.add(id);
  else providerSelectedIds.delete(id);
  renderProviders();
}

function toggleVisibleProvidersSelection() {
  const visible = providerVisibleList();
  const ids = visible.map(p => p.id).filter(Boolean);
  if (!ids.length) return;
  const allSelected = ids.every(id => providerSelectedIds.has(id));
  ids.forEach(id => {
    if (allSelected) providerSelectedIds.delete(id);
    else providerSelectedIds.add(id);
  });
  renderProviders();
}

async function setSelectedProvidersEnabled(enabled) {
  if (!invoke || providerBulkRunning) return;
  const selected = new Set(providerSelectedIds);
  const targets = (providerStore.providers || []).filter(p => selected.has(p.id) && p?.meta?.codexConfig !== true && !isBuiltinProvider(p));
  if (!targets.length) return;
  providerBulkRunning = true;
  renderProviderToolbarState(providerListAll().length, providerVisibleList());
  let okCount = 0;
  try {
    for (const p of targets) {
      await invoke('set_provider_enabled', { id: p.id, enabled });
      p.enabled = enabled;
      okCount += 1;
    }
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    addLog('ok', `已${enabled ? '启用' : '禁用'} ${okCount} 个供应商`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已${enabled ? '启用' : '禁用'} ${okCount} 个供应商`, 'success');
    }
  } catch (e) {
    addLog('err', '批量切换供应商失败: ' + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    providerBulkRunning = false;
    renderProviders();
  }
}

async function deleteSelectedProviders() {
  if (providerBulkRunning) return;
  const selected = new Set(providerSelectedIds);
  const targets = (providerStore.providers || []).filter(p => selected.has(p.id) && p?.meta?.codexConfig !== true && !isBuiltinProvider(p));
  if (!targets.length) return;
  providerBulkRunning = true;
  renderProviderToolbarState(providerListAll().length, providerVisibleList());
  let ok = false;
  try {
    ok = await mutateProviderStore(store => {
      store.providers = (store.providers || []).filter(p => !selected.has(p.id) || p?.meta?.codexConfig === true || isBuiltinProvider(p));
    });
    if (ok) {
      targets.forEach(p => providerSelectedIds.delete(p.id));
    }
  } finally {
    providerBulkRunning = false;
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
  }
  if (!ok) return;
  addLog('info', `已删除 ${targets.length} 个供应商`);
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已删除 ${targets.length} 个供应商`, 'success');
  }
}

function normalizeProviderUnlocks(p) {
  if (!p) return {};
  if (!p.unlocks || typeof p.unlocks !== 'object') p.unlocks = {};
  return p.unlocks;
}

function providerUnlockEnabled(p, kind) {
  const unlocks = normalizeProviderUnlocks(p);
  return !!(unlocks[kind] && unlocks[kind].enabled !== false);
}

function providerUnlockLabels(p) {
  const labels = [];
  if (providerUnlockEnabled(p, 'codex')) labels.push('Codex');
  if (providerUnlockEnabled(p, 'claudeCode')) labels.push('Claude Code');
  return labels;
}

function providerUnlockSummaryHtml(p) {
  const labels = providerUnlockLabels(p);
  if (!labels.length) return '';
  return `<div class="provider-unlock-summary active" title="已解锁限制：${escAttr(labels.join('、'))}">解锁限制：${escAttr(labels.join(' · '))}</div>`;
}

function providerUnlockTagsHtml(p) {
  const labels = providerUnlockLabels(p);
  if (!labels.length) return '';
  return labels.map(label => `<span class="tag provider-unlock-tag active" title="已解锁限制 ${escAttr(label)}">解锁限制 ${escAttr(label)}</span>`).join('');
}

function providerUnlockIconSvg(p) {
  const active = providerUnlockLabels(p).length > 0;
  return active
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.5-2.2"></path></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
}

function providerUnlockListButtonHtml(p) {
  return `<button class="btn-icon model-map-action-btn provider-list-icon-btn provider-unlock-list-btn ${providerUnlockLabels(p).length ? 'active' : ''}" data-action="openProviderUnlockModal" data-arg="${escAttr(p.id)}" title="解锁限制" aria-label="解锁限制 ${escAttr(p.name || p.id)}">${providerUnlockIconSvg(p)}</button>`;
}

const PROVIDER_ACTION_ICON_PATHS = {
  test: '<path d="M10 2v7.3a4 4 0 0 1-.54 2L4.2 20.1A1.3 1.3 0 0 0 5.32 22h13.36a1.3 1.3 0 0 0 1.12-1.9l-5.26-8.8a4 4 0 0 1-.54-2V2"></path><path d="M8.5 2h7"></path><path d="M7.5 15h9"></path>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
  delete: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>',
};

// 供应商行操作统一使用图标按钮（与内置模型列表 /.btn-icon 一致）
function providerActionIconButtonHtml(icon, { action, arg, label, title = '', extraClass = '' }) {
  const fullLabel = title || label;
  return `<button class="btn-icon model-map-action-btn provider-list-icon-btn${extraClass ? ` ${extraClass}` : ''}" data-action="${action}" data-arg="${escAttr(arg)}" title="${escAttr(fullLabel)}" aria-label="${escAttr(label)}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PROVIDER_ACTION_ICON_PATHS[icon]}</svg>
    </button>`;
}

function providerActionButtonsHtml(p) {
  const builtin = isBuiltinProvider(p);
  const isLocalProxy = isLocalProxyProvider(p);
  const nameLabel = p.name || p.id;
  const testButton = providerActionIconButtonHtml('test', {
    action: 'testProvider',
    arg: p.id,
    label: `测试 ${nameLabel}`,
    title: '测试',
  });
  const editButton = providerActionIconButtonHtml('edit', {
    action: isLocalProxy ? 'navigateToProxyModels' : 'openProviderEditor',
    arg: p.id,
    label: `编辑 ${nameLabel}`,
    title: '编辑',
  });
  const deleteButton = providerActionIconButtonHtml('delete', {
    action: 'deleteProvider',
    arg: p.id,
    label: `删除 ${nameLabel}`,
    title: '删除',
    extraClass: 'danger',
  });
  return `${testButton}${providerUnlockListButtonHtml(p)}${editButton}${builtin || isLocalProxy ? '' : deleteButton}`;
}

function ensureProviderUnlockModal() {
  let modal = document.getElementById('provider-unlock-modal');
  if (modal) return modal;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="provider-unlock-modal" data-action="closeProviderUnlockModal" data-only-self>
      <div class="modal-container provider-unlock-modal">
        <div class="modal-header provider-unlock-head">
          <div>
            <div class="modal-title" id="provider-unlock-title">供应商解锁限制</div>
            <div class="provider-unlock-sub" id="provider-unlock-sub">解锁限制后，该供应商可通过网关转发接入其他平台。</div>
          </div>
          <button class="modal-close-icon" data-action="closeProviderUnlockModal" aria-label="关闭解锁限制弹窗">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
          </button>
        </div>
        <div class="modal-body provider-unlock-body" id="provider-unlock-body"></div>
        <div class="modal-footer provider-unlock-footer">
          <button class="modal-btn modal-btn-confirm" data-action="closeProviderUnlockModal">完成</button>
        </div>
      </div>
    </div>`);
  return document.getElementById('provider-unlock-modal');
}

globalThis.providerUnlockEditingId = '';

function openProviderUnlockModal(providerId) {
  providerUnlockEditingId = providerId;
  const modal = ensureProviderUnlockModal();
  renderProviderUnlockModal();
  modal.classList.add('active');
}

function closeProviderUnlockModal() {
  document.getElementById('provider-unlock-modal')?.classList.remove('active');
  providerUnlockEditingId = '';
}

function providerUnlockRowHtml(p, kind, label, detail) {
  const enabled = providerUnlockEnabled(p, kind);
  return `
    <label class="provider-unlock-row ${enabled ? 'enabled' : ''}">
      <div class="provider-unlock-row-main">
        <strong>${escAttr(label)}</strong>
        <span>${escAttr(detail)}</span>
      </div>
      <input type="checkbox" ${enabled ? 'checked' : ''} data-action="setProviderUnlockFromModal" data-events="change" data-args="[&quot;${kind}&quot;]" data-pass-checked>
      <span class="provider-unlock-switch" aria-hidden="true"></span>
    </label>`;
}

function renderProviderUnlockModal() {
  const p = (providerStore.providers || []).find(x => x.id === providerUnlockEditingId);
  const body = document.getElementById('provider-unlock-body');
  const title = document.getElementById('provider-unlock-title');
  const sub = document.getElementById('provider-unlock-sub');
  if (!body || !p) return;
  normalizeProviderUnlocks(p);
  if (title) title.textContent = `供应商解锁限制：${p.name || p.id}`;
  if (sub) sub.textContent = '解锁限制后，该供应商可通过网关转发接入其他平台。';
  body.innerHTML = `
    <div class="provider-unlock-list">
      ${providerUnlockRowHtml(p, 'codex', 'Codex', '使用 Responses API 解锁限制模板')}
      ${providerUnlockRowHtml(p, 'claudeCode', 'Claude Code', '使用 Anthropic Messages 解锁限制模板')}
    </div>`;
}

async function setProviderUnlockFromModal(kind, enabled) {
  if (!invoke || !providerUnlockEditingId) return;
  const p = (providerStore.providers || []).find(x => x.id === providerUnlockEditingId);
  if (!p) return;
  const key = `provider-unlock:${providerUnlockEditingId}:${kind}`;
  if (_inFlightToggles.has(key)) return;
  _inFlightToggles.add(key);
  try {
    const updated = await invoke('set_provider_unlock', { providerId: providerUnlockEditingId, kind, enabled });
    const idx = providerStore.providers.findIndex(x => x.id === providerUnlockEditingId);
    if (idx >= 0 && updated) providerStore.providers[idx] = updated;
    if (idx >= 0) normalizeProviderUnlocks(providerStore.providers[idx]);
    renderProviders();
    renderProviderUnlockModal();
    addLog('ok', `供应商「${p.name || p.id}」已${enabled ? '解锁限制' : '取消解锁限制'} ${kind === 'codex' ? 'Codex' : 'Claude Code'}`);
  } catch (e) {
    showCustomAlert(String(e), enabled ? '解锁限制失败' : '取消解锁限制失败', 'error');
    renderProviderUnlockModal();
  } finally {
    _inFlightToggles.delete(key);
  }
}
function renderProviderCards(list) {
  return list.map(p => {
    const enabled = p.enabled !== false;
    const selected = providerSelectedIds.has(p.id);
    const builtin = isBuiltinProvider(p);
    const builtinBadge = builtinProviderBadgeHtml(p);
    const toggleHtml = builtin
      ? ''
      : `<label class="toggle-switch" title="${enabled ? '已启用，点击禁用' : '未启用，点击启用'}">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-action="toggleProviderEnabled" data-events="change" data-arg="${escAttr(p.id)}">
          <span class="toggle-slider"></span>
        </label>`;
    const actionsHtml = providerActionButtonsHtml(p);

    const selectCheckHtml = builtin
      ? ''
      : `<label class="provider-select-check" title="选择供应商" data-action="__noop" data-stop>
            <input type="checkbox" ${selected ? 'checked' : ''} data-action="toggleProviderSelection" data-events="change" data-args="[&quot;${escAttr(p.id)}&quot;]" data-pass-checked data-pass-event>
            <span></span>
          </label>`;
    const connState = p.connStatus || null;
    const dotClass = connState ? (connState.ok ? 'conn-dot ok' : 'conn-dot no') : 'conn-dot no';
    const statusText = connState ? escAttr(connState.text) : '未测试';
    const statusTitle = connState ? escAttr(connState.title || connState.text) : '未测试';
    const connStatusHtml = `
      <div class="provider-conn-status" title="${statusTitle}">
        <div class="${dotClass}" id="conn-dot-${escAttr(p.id)}"></div>
        <span class="conn-text" id="conn-text-${escAttr(p.id)}" title="${statusTitle}">${statusText}</span>
      </div>`;

    return `
      <div class="provider-card ${enabled ? 'active' : ''} ${selected ? 'selected' : ''} ${builtin ? 'provider-card-builtin' : ''}">
        <div class="provider-top">
          ${selectCheckHtml}
          <div class="provider-id">
            <div>
              <div class="provider-name">${escAttr(p.name)} ${builtinBadge}</div>
            </div>
          </div>
          ${toggleHtml}
        </div>
        <div class="provider-body">
          <div class="field provider-model-field-block">
            <div class="field-label">已选模型</div>
            <div class="provider-model-chip-list">${providerModelBadges(p) || '<span class="provider-empty-text">未选择</span>'}</div>
          </div>
          ${builtin || globalThis.PROVIDER_BALANCE_UI_ENABLED !== true || typeof providerBalanceRowHtml !== 'function' ? '' : providerBalanceRowHtml(p)}
        </div>
        <div class="provider-footer">
          ${connStatusHtml}
          <div class="provider-card-actions">
            ${actionsHtml}
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderProviderListTable(list) {
  return `
    <div class="provider-list-shell">
      <table class="provider-list-table">
        <thead>
          <tr>
            <th class="provider-list-check-col"></th>
            <th>供应商</th>
            <th>能力 / 限制</th>
            <th class="provider-list-action-col">操作</th>
            <th class="provider-list-enabled-col">启用</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(p => {
            const enabled = p.enabled !== false;
            const selected = providerSelectedIds.has(p.id);
            const builtin = isBuiltinProvider(p);
            const builtinBadge = builtinProviderBadgeHtml(p);
            const actionButtons = providerActionButtonsHtml(p);
            const toggleHtml = builtin
              ? ''
              : `<label class="toggle-switch" title="${enabled ? '已启用，点击禁用' : '未启用，点击启用'}">
                  <input type="checkbox" ${enabled ? 'checked' : ''} data-action="toggleProviderEnabled" data-events="change" data-arg="${escAttr(p.id)}">
                  <span class="toggle-slider"></span>
                </label>`;
            return `
              <tr class="${selected ? 'selected' : ''} ${builtin ? 'provider-list-row-builtin' : ''}">
                <td class="provider-list-check-col">
                  ${builtin ? '' : `<label class="provider-select-check provider-select-check-table" title="选择供应商" data-action="__noop" data-stop>
                    <input type="checkbox" ${selected ? 'checked' : ''} data-action="toggleProviderSelection" data-events="change" data-args="[&quot;${escAttr(p.id)}&quot;]" data-pass-checked data-pass-event>
                    <span></span>
                  </label>`}
                </td>
                <td>
                  <div class="provider-list-identity">
                    <div class="provider-list-name-wrap">
                      <div class="provider-name">${escAttr(p.name)} ${builtinBadge}</div>
                      <div class="provider-list-sub">${escAttr(p.apiHost || p.id || '')}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="provider-inline-tags">
                    ${capabilityBadges(p, true)}
                    ${providerUnlockTagsHtml(p)}
                  </div>
                </td>
                <td class="provider-list-action-col">
                  <div class="provider-list-actions">
                    ${actionButtons}
                  </div>
                </td>
                <td class="provider-list-enabled-col">
                  <div class="provider-list-status-cell">
                    ${toggleHtml}
                  </div>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderProviders() {
  syncLocalProxyProvider();
  syncCpaLocalProvider();
  const grid = document.getElementById('providerGrid');
  const empty = document.getElementById('providerEmpty');
  if (!grid) return;
  const all = providerListAll();
  cleanupProviderSelection(all);
  // 供应商被删掉后清掉残留余额，避免下次同名供应商张冠李戴
  if (typeof pruneProviderBalanceCache === 'function') {
    pruneProviderBalanceCache(all.map(p => p.id));
  }
  const list = providerVisibleList(all);
  renderProviderToolbarState(all.length, list);
  grid.classList.toggle('provider-grid-list', providerViewMode === 'list');
  grid.innerHTML = providerViewMode === 'list'
    ? renderProviderListTable(list)
    : renderProviderCards(list);
  if (empty) {
    empty.style.display = list.length ? 'none' : 'block';
    empty.textContent = all.length
      ? '没有匹配的供应商。'
      : '尚未配置任何供应商，点击右上角「新增供应商」开始。';
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.providerVisibleList = providerVisibleList;
  g.cleanupProviderSelection = cleanupProviderSelection;
  g.providerModelBadges = providerModelBadges;
  g.renderProviderToolbarState = renderProviderToolbarState;
  g.onProviderSearchInput = onProviderSearchInput;
  g.clearProviderSearch = clearProviderSearch;
  g.setProviderViewMode = setProviderViewMode;
  g.setProviderSortMode = setProviderSortMode;
  g.syncProviderSortControl = syncProviderSortControl;
  g.setProviderSortMenuOpen = setProviderSortMenuOpen;
  g.toggleProviderSortMenu = toggleProviderSortMenu;
  g.closeProviderSortMenu = closeProviderSortMenu;
  g.chooseProviderSortMode = chooseProviderSortMode;
  g.toggleProviderSelection = toggleProviderSelection;
  g.toggleVisibleProvidersSelection = toggleVisibleProvidersSelection;
  g.setSelectedProvidersEnabled = setSelectedProvidersEnabled;
  g.deleteSelectedProviders = deleteSelectedProviders;
  g.normalizeProviderUnlocks = normalizeProviderUnlocks;
  g.providerUnlockEnabled = providerUnlockEnabled;
  g.providerUnlockLabels = providerUnlockLabels;
  g.providerUnlockSummaryHtml = providerUnlockSummaryHtml;
  g.providerUnlockTagsHtml = providerUnlockTagsHtml;
  g.providerUnlockIconSvg = providerUnlockIconSvg;
  g.providerUnlockListButtonHtml = providerUnlockListButtonHtml;
  g.providerActionButtonsHtml = providerActionButtonsHtml;
  g.ensureProviderUnlockModal = ensureProviderUnlockModal;
  g.openProviderUnlockModal = openProviderUnlockModal;
  g.closeProviderUnlockModal = closeProviderUnlockModal;
  g.providerUnlockRowHtml = providerUnlockRowHtml;
  g.renderProviderUnlockModal = renderProviderUnlockModal;
  g.setProviderUnlockFromModal = setProviderUnlockFromModal;
  g.renderProviderCards = renderProviderCards;
  g.renderProviderListTable = renderProviderListTable;
  g.renderProviders = renderProviders;
})(globalThis);
