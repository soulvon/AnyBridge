// model-map/slot-visibility.js — 官方与自定义模型可见性策略与快捷注入列表
import { escapeHtml, escAttr } from '../ui/dom.js';

globalThis.SLOT_VISIBILITY_LABELS = {
  mapped: '应用：仅显示已映射槽位',
  official: '应用：已映射 + 官方模型',
  all: '应用：已映射 + 官方模型 + 全部',
};

globalThis.SLOT_VISIBILITY_SHORT_LABELS = {
  mapped: '仅已映射',
  official: '已映射 + 官方',
  all: '全部模型',
};

function normalizeUnlockScope(mode) {
  return Object.prototype.hasOwnProperty.call(UNLOCK_SCOPE_LABELS, mode) ? mode : 'all';
}

function normalizeSlotVisibilityMode(mode) {
  return Object.prototype.hasOwnProperty.call(SLOT_VISIBILITY_LABELS, mode) ? mode : 'official';
}

function ensureSlotVisibilityArray() {
  if (!Array.isArray(modelMapStore.slotVisibility)) modelMapStore.slotVisibility = [];
  return modelMapStore.slotVisibility;
}

function slotVisibilityOverrideMap() {
  const map = new Map();
  ensureSlotVisibilityArray().forEach(item => {
    if (item && item.modelUid) map.set(item.modelUid, item.visible !== false);
  });
  return map;
}

function baseSlotVisibleForMode(row, mode) {
  const normalized = normalizeSlotVisibilityMode(mode);
  if (row.isMapped) return true;
  if (row.isOfficial) return normalized === 'official' || normalized === 'all';
  return normalized === 'all';
}

function updateSlotPresetButtons(rows = slotVisibilityRows) {
  const allRows = Array.isArray(rows) ? rows : [];
  const counts = {
    mapped: allRows.filter(row => baseSlotVisibleForMode(row, 'mapped')).length,
    official: allRows.filter(row => baseSlotVisibleForMode(row, 'official')).length,
    all: allRows.length,
  };
  const activeMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  document.querySelectorAll('.model-slot-preset').forEach(btn => {
    const mode = normalizeSlotVisibilityMode(btn.dataset.mode);
    let labelEl = btn.querySelector('.model-slot-preset-label');
    let countEl = btn.querySelector('.model-slot-preset-count');
    if (!labelEl || !countEl) {
      btn.textContent = '';
      labelEl = document.createElement('span');
      labelEl.className = 'model-slot-preset-label';
      countEl = document.createElement('span');
      countEl.className = 'model-slot-preset-count';
      btn.append(labelEl, countEl);
    }
    const label = btn.dataset.label || SLOT_VISIBILITY_LABELS[mode] || mode;
    const count = counts[mode] || 0;
    labelEl.textContent = label;
    countEl.textContent = String(count);
    btn.classList.toggle('active', mode === activeMode);
    btn.setAttribute('aria-pressed', mode === activeMode ? 'true' : 'false');
    btn.title = `${label}：${count} 个槽位`;
  });
}

function updateSlotFilterCounts(rows = slotVisibilityRows) {
  const filterEl = document.getElementById('injected-filter');
  if (!filterEl) return;
  const allRows = Array.isArray(rows) ? rows : [];
  const counts = {
    all: allRows.length,
    visible: allRows.filter(row => row.visible).length,
    hidden: allRows.filter(row => !row.visible).length,
    mapped: allRows.filter(row => row.isMapped).length,
    official: allRows.filter(row => row.isOfficial).length,
    unconfigured: allRows.filter(row => !row.isMapped && !row.isOfficial && !row.hasConfiguredByok).length,
  };
  const labels = {
    all: '全部',
    visible: '显示中',
    hidden: '已隐藏',
    mapped: '已映射',
    official: '官方模型',
    unconfigured: '未配置',
  };
  Array.from(filterEl.options).forEach(option => {
    const value = option.value;
    if (!Object.prototype.hasOwnProperty.call(labels, value)) return;
    option.textContent = `${labels[value]} (${counts[value] || 0})`;
  });
}

function setSlotVisibilityFilter(value) {
  const filter = document.getElementById('injected-filter');
  if (filter) filter.value = value;
}

function setSlotVisibilityDirty(dirty) {
  slotVisibilityDirty = !!dirty;
  const saveBtn = document.getElementById('slot-visibility-save-btn');
  const saveLabel = document.getElementById('slot-visibility-save-label');
  if (saveBtn) saveBtn.classList.toggle('has-pending', slotVisibilityDirty);
  if (saveLabel) saveLabel.textContent = slotVisibilityDirty ? '保存更改' : '保存';
  updateSlotPolicySummary();
}

function updateSlotPolicySummary() {
  const summary = document.getElementById('slot-policy-summary');
  if (!summary) return;
  const visibility = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  const rows = slotVisibilityRows || [];
  const visibleCount = rows.filter(r => r.visible).length;
  const overrideCount = ensureSlotVisibilityArray().length;
  const shortLabel = SLOT_VISIBILITY_SHORT_LABELS[visibility] || SLOT_VISIBILITY_SHORT_LABELS.official;
  summary.textContent = [
    `当前策略：${shortLabel}`,
    rows.length ? `已显示 ${visibleCount} / ${rows.length}` : '',
    overrideCount ? `单独调整 ${overrideCount}` : '',
    slotVisibilityDirty ? '未保存' : '',
  ].filter(Boolean).join(' · ');
}

async function setSlotVisibilityMode(mode) {
  const nextMode = normalizeSlotVisibilityMode(mode);
  const hadOverrides = ensureSlotVisibilityArray().length > 0;
  const changed = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode) !== nextMode || hadOverrides;
  modelMapStore.slotVisibilityMode = nextMode;
  modelMapStore.slotVisibility = [];
  modelMapStore.unlockScope = 'all';
  modelMapStore.slotDisplayMode = 'all';
  // 预设按钮表示最终 IDE 模型列表策略；应用后直接展示策略命中的槽位。
  setSlotVisibilityFilter('visible');
  if (changed) setSlotVisibilityDirty(true);
  updateSlotPresetButtons();
  // 点击 flash 动画：让按钮短暂闪烁表示已应用
  const clickedBtn = document.querySelector(`.model-slot-preset[data-mode="${nextMode}"]`);
  if (clickedBtn) {
    clickedBtn.classList.add('just-applied');
    setTimeout(() => clickedBtn.classList.remove('just-applied'), 600);
  }
  await renderInjectedList();
  const shortLabel = SLOT_VISIBILITY_SHORT_LABELS[nextMode] || nextMode;
  addLog('info', `策略「${shortLabel}」已应用，共 ${slotVisibilityRows.filter(r => r.visible).length} 个槽位显示，保存后生效`);
}

function setSlotVisibilityOverride(uid, visible) {
  if (!uid) return;
  modelMapStore.slotVisibility = ensureSlotVisibilityArray().filter(item => item && item.modelUid !== uid);
  const row = (slotVisibilityRows || []).find(item => item.uid === uid);
  if (row && row.baseVisible === !!visible) return;
  modelMapStore.slotVisibility.push({ modelUid: uid, visible: !!visible });
}

function onSlotVisibilityToggle(uid, checked) {
  setSlotVisibilityOverride(uid, checked);
  setSlotVisibilityDirty(true);
  renderInjectedList();
}

function toggleSlotVisibilitySelectAll(checked) {
  document.querySelectorAll('.slot-visibility-row-check').forEach(input => {
    const row = input.closest('tr');
    if (!row || row.style.display === 'none') return;
    input.checked = !!checked;
  });
  syncSlotVisibilitySelectionState();
}

function selectedSlotVisibilityUids() {
  return Array.from(document.querySelectorAll('.slot-visibility-row-check:checked'))
    .map(input => input.dataset.uid)
    .filter(Boolean);
}

function syncSlotVisibilitySelectionState() {
  const checks = Array.from(document.querySelectorAll('.slot-visibility-row-check'));
  const selected = checks.filter(input => input.checked).length;
  const selectAll = document.getElementById('slot-visibility-select-all');
  if (selectAll) {
    selectAll.checked = checks.length > 0 && selected === checks.length;
    selectAll.indeterminate = selected > 0 && selected < checks.length;
  }
  const label = document.getElementById('slot-visibility-select-label');
  if (label) label.textContent = selected ? `已选 ${selected}` : '选择';
  const disabled = selected === 0;
  const enableBtn = document.getElementById('slot-bulk-enable-btn');
  const disableBtn = document.getElementById('slot-bulk-disable-btn');
  if (enableBtn) enableBtn.disabled = disabled;
  if (disableBtn) disableBtn.disabled = disabled;
}

function batchSetSlotVisibility(visible) {
  const uids = selectedSlotVisibilityUids();
  if (uids.length === 0) {
    showCustomAlert('请先勾选要批量调整的模型槽位', '未选择槽位', 'info');
    return;
  }
  uids.forEach(uid => setSlotVisibilityOverride(uid, visible));
  setSlotVisibilityDirty(true);
  renderInjectedList();
  addLog('info', `已${visible ? '启用' : '禁用'} ${uids.length} 个模型槽位，保存后生效`);
}

function modelSlotSkeletonHtml(rows = 9) {
  const body = Array.from({ length: rows }, (_, idx) => `
    <div class="model-slot-skeleton-row" aria-hidden="true">
      <span class="model-slot-skeleton-check" style="--delay:${idx * 45}ms"></span>
      <span class="model-slot-skeleton-line name" style="--delay:${idx * 45 + 40}ms"></span>
      <span class="model-slot-skeleton-line uid" style="--delay:${idx * 45 + 80}ms"></span>
      <span class="model-slot-skeleton-line provider" style="--delay:${idx * 45 + 120}ms"></span>
      <span class="model-slot-skeleton-check" style="--delay:${idx * 45 + 160}ms"></span>
    </div>`).join('');
  return `
    <div class="model-slot-skeleton" role="status" aria-label="正在加载模型槽位目录">
      <div class="model-slot-skeleton-header">
        <span></span>
        <span>模型名</span>
        <span>modelUid</span>
        <span>状态</span>
        <span>显示</span>
      </div>
      ${body}
    </div>`;
}

async function ensureInjected() {
  if (injectedCatalog) return injectedCatalog;
  try {
    const res = await invoke('list_windsurf_catalog');
    injectedCatalog = (res && Array.isArray(res.models)) ? res.models : [];
  } catch (e) {
    console.error('加载 Windsurf 模型目录失败:', e);
    injectedCatalog = [];
  }
  return injectedCatalog;
}

async function openInjectedEditor() {
  const page = document.getElementById('page-model-slots');
  if (!page) return;
  navigateTo('model-slots');
  try {
    const res = await invoke('load_model_map');
    if (res && Array.isArray(res.slots)) modelMapStore = res;
  } catch (e) {
    addLog('warn', '加载模型槽位配置失败: ' + e);
  }
  // 确保 modelMapStore.injected 存在
  if (!Array.isArray(modelMapStore.injected)) modelMapStore.injected = [];
  const list = document.getElementById('injected-list');
  if (list) {
    list.innerHTML = modelSlotSkeletonHtml();
  }
  await syncCurrentIdeModels();
  document.getElementById('injected-search').value = '';
  document.getElementById('injected-filter').value = 'all';
  modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
  modelMapStore.slotVisibilityMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  ensureSlotVisibilityArray();
  slotVisibilityDirty = false;
  updateSlotPresetButtons();
  setSlotVisibilityDirty(false);
  try {
    await renderInjectedList();
  } catch (e) {
    console.error('渲染模型槽位失败:', e);
    addLog('warn', '加载模型槽位管理失败: ' + e);
    if (list) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--warn,#d97706);font-size:12px;">模型槽位目录加载失败，请检查内置 catalog 资源或重启应用。</div>';
    }
  }
}

function closeInjectedEditor() {
  navigateTo('models');
}

function buildSlotVisibilityRows() {
  const rows = new Map();
  const ensureRow = (uid, label, apiId = '', source = 'catalog') => {
    if (!uid) return null;
    const existing = rows.get(uid) || {
      uid,
      label: label || uid,
      apiId: apiId || '',
      isMapped: false,
      isOfficial: false,
      hasConfiguredByok: false,
      source,
    };
    if (label && (!existing.label || existing.label === existing.uid)) existing.label = label;
    if (apiId && !existing.apiId) existing.apiId = apiId;
    if (source === 'account') existing.source = 'account';
    rows.set(uid, existing);
    return existing;
  };

  (ideModels || []).forEach(m => {
    const row = ensureRow(m.id, m.name, m.api_id || '', isAccountSlotModel(m) ? 'account' : 'extended');
    if (row && isAccountSlotModel(m)) row.isOfficial = true;
  });
  (injectedCatalog || []).forEach(m => {
    ensureRow(m.modelUid, m.label, m.apiId || '', 'catalog');
  });
  (modelMapStore.injected || []).forEach(i => {
    const row = ensureRow(i.modelUid, i.label, i.model || '', 'catalog');
    if (row) row.hasConfiguredByok = !!(i.providerId && String(i.model || '').trim());
  });
  (modelMapStore.slots || []).forEach(s => {
    const fallback = originalNameOf(s.modelUid);
    const row = ensureRow(s.modelUid, s.displayName || fallback, '', 'mapped');
    if (!row) return;
    row.isMapped = true;
    row.label = s.displayName || row.label || fallback;
    row.mappingEnabled = s.enabled !== false;
  });

  const overrides = slotVisibilityOverrideMap();
  const mode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  const statusOf = row => {
    if (row.isMapped) return row.mappingEnabled === false ? 'mapped-off' : 'mapped';
    if (row.isOfficial) return 'official';
    if (row.hasConfiguredByok) return 'configured';
    return 'unconfigured';
  };

  return Array.from(rows.values()).map(row => {
    const baseVisible = baseSlotVisibleForMode(row, mode);
    const hasOverride = overrides.has(row.uid);
    return {
      ...row,
      originalName: originalNameOf(row.uid),
      baseVisible,
      visible: hasOverride ? overrides.get(row.uid) : baseVisible,
      hasOverride,
      status: statusOf(row),
    };
  }).sort((a, b) => {
    const rank = row => row.isMapped ? 0 : (row.isOfficial ? 1 : 2);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
}

function renderSlotStatusPill(row) {
  const styles = {
    mapped: ['已映射', 'rgba(var(--accent-rgb), .10)', 'var(--accent)', 'rgba(var(--accent-rgb), .24)'],
    'mapped-off': ['已映射', 'var(--bg-input)', 'var(--text-muted)', 'var(--border)'],
    official: ['官方', 'rgba(22,163,74,.10)', 'var(--success,#16a34a)', 'rgba(22,163,74,.24)'],
    configured: ['已配置', 'rgba(var(--accent-secondary-rgb), .10)', 'var(--accent-secondary)', 'rgba(var(--accent-secondary-rgb), .24)'],
    unconfigured: ['未配置', 'rgba(217,119,6,.10)', 'var(--warn,#d97706)', 'rgba(217,119,6,.24)'],
  };
  const s = styles[row.status] || styles.unconfigured;
  return `<span class="tag" style="background:${s[1]};color:${s[2]};border:1px solid ${s[3]};font-size:12px;padding:2px 8px;border-radius:7px;font-weight:700;white-space:nowrap;">${s[0]}</span>`;
}

async function renderInjectedList() {
  const list = document.getElementById('injected-list');
  if (!list) return;
  await ensureInjected();
  const query = (document.getElementById('injected-search')?.value || '').toLowerCase().trim();
  const filter = document.getElementById('injected-filter')?.value || 'all';
  slotVisibilityRows = buildSlotVisibilityRows();
  updateSlotPresetButtons(slotVisibilityRows);
  updateSlotFilterCounts(slotVisibilityRows);

  const rows = slotVisibilityRows.filter(row => {
    if (filter === 'visible' && !row.visible) return false;
    if (filter === 'hidden' && row.visible) return false;
    if (filter === 'mapped' && !row.isMapped) return false;
    if (filter === 'official' && !row.isOfficial) return false;
    if (filter === 'unconfigured' && (row.isMapped || row.isOfficial || row.hasConfiguredByok)) return false;
    if (!query) return true;
    const hay = `${row.label || ''} ${row.uid || ''} ${row.apiId || ''}`.toLowerCase();
    return hay.includes(query);
  });

  updateSlotPolicySummary();
  const selectAll = document.getElementById('slot-visibility-select-all');
  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
  const badge = document.getElementById('injected-count-badge');
  if (badge) badge.textContent = '模型槽位管理';

  if (rows.length === 0) {
    list.innerHTML = '<div style="padding:28px;text-align:center;color:var(--text-muted);font-size:12px;">无匹配模型槽位</div>';
    syncSlotVisibilitySelectionState();
    return;
  }

  const hasVisionModels = (modelMapStore.visionModels?.imageModels?.length || 0) > 0;
  list.innerHTML = `<table class="slot-visibility-table">
    <thead>
      <tr>
        <th style="width:34px;"></th>
        <th>模型名</th>
        <th>原始模型名</th>
        <th>modelUid</th>
        <th style="width:120px;">状态</th>
        <th style="width:100px;">图片理解</th>
        <th style="width:96px;text-align:right;">显示</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(row => {
        const vi = nativeVisionSlotInfo(row.uid);
        let visionBadge;
        if (vi.ok === false && hasVisionModels) {
          visionBadge = renderVisionPill({ state: 'auto', label: '第三方增强', title: '该模型不支持图片，已自动启用第三方图片理解增强' }, true);
        } else {
          visionBadge = renderVisionPill(vi, true);
        }
        return `
        <tr data-uid="${escAttr(row.uid)}" class="${row.visible ? '' : 'is-hidden'}">
          <td>
            <input class="slot-visibility-row-check" data-uid="${escAttr(row.uid)}" type="checkbox" data-action="syncSlotVisibilitySelectionState" data-events="change">
          </td>
          <td>
            <div class="slot-visibility-name">${escAttr(row.label)}</div>
            ${row.apiId ? `<div class="slot-visibility-sub">${escAttr(row.apiId)}</div>` : ''}
          </td>
          <td class="slot-visibility-orig">${escAttr(row.originalName)}</td>
          <td class="slot-visibility-uid">${escAttr(row.uid)}</td>
          <td>
            <div class="slot-visibility-status">
              ${renderSlotStatusPill(row)}
              ${row.hasOverride ? '<span class="slot-visibility-override">单独设置</span>' : ''}
            </div>
          </td>
          <td>${visionBadge}</td>
          <td>
            <label class="slot-visibility-switch" title="${row.visible ? '当前显示在 IDE 模型列表' : '当前不显示在 IDE 模型列表'}">
              <input type="checkbox" ${row.visible ? 'checked' : ''} data-action="onSlotVisibilityToggle" data-events="change" data-args="[&quot;${escAttr(row.uid)}&quot;]" data-pass-checked>
              <span></span>
            </label>
          </td>
      </tr>`;
      }).join('')}
    </tbody>
  </table>`;
  syncSlotVisibilitySelectionState();
}

async function saveInjectedFromEditor() {
  modelMapStore.unlockScope = 'all';
  modelMapStore.slotDisplayMode = 'all';
  modelMapStore.slotVisibilityMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  ensureSlotVisibilityArray();
  if (await persistModelMap()) {
    setSlotVisibilityDirty(false);
    addLog('ok', '已保存模型槽位显示设置');
    await renderInjectedList();
    await renderModelMap();
  }
}

async function toggleSlotEnabled(uid) {
  const key = 'slot:' + uid;
  if (_inFlightToggles.has(key)) return;
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!s) return;
  s.enabled = !(s.enabled !== false);
  _inFlightToggles.add(key);
  try {
    if (await persistModelMap()) { await renderModelMap(); }
    else {
      s.enabled = !s.enabled;
      await renderModelMap();
    }
  } finally {
    _inFlightToggles.delete(key);
  }
}

async function deleteSlot(uid) {
  const previous = cloneModelMapStore();
  modelMapStore.slots = modelMapStore.slots.filter(x => x.modelUid !== uid);
  if (await persistModelMap()) {
    await renderModelMap();
    addLog('info', '已删除映射');
  } else {
    modelMapStore = cloneModelMapStore(previous);
    await renderModelMap();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.normalizeUnlockScope = normalizeUnlockScope;
  g.normalizeSlotVisibilityMode = normalizeSlotVisibilityMode;
  g.ensureSlotVisibilityArray = ensureSlotVisibilityArray;
  g.slotVisibilityOverrideMap = slotVisibilityOverrideMap;
  g.baseSlotVisibleForMode = baseSlotVisibleForMode;
  g.updateSlotPresetButtons = updateSlotPresetButtons;
  g.updateSlotFilterCounts = updateSlotFilterCounts;
  g.setSlotVisibilityFilter = setSlotVisibilityFilter;
  g.setSlotVisibilityDirty = setSlotVisibilityDirty;
  g.updateSlotPolicySummary = updateSlotPolicySummary;
  g.setSlotVisibilityMode = setSlotVisibilityMode;
  g.setSlotVisibilityOverride = setSlotVisibilityOverride;
  g.onSlotVisibilityToggle = onSlotVisibilityToggle;
  g.toggleSlotVisibilitySelectAll = toggleSlotVisibilitySelectAll;
  g.selectedSlotVisibilityUids = selectedSlotVisibilityUids;
  g.syncSlotVisibilitySelectionState = syncSlotVisibilitySelectionState;
  g.batchSetSlotVisibility = batchSetSlotVisibility;
  g.modelSlotSkeletonHtml = modelSlotSkeletonHtml;
  g.ensureInjected = ensureInjected;
  g.openInjectedEditor = openInjectedEditor;
  g.closeInjectedEditor = closeInjectedEditor;
  g.buildSlotVisibilityRows = buildSlotVisibilityRows;
  g.renderSlotStatusPill = renderSlotStatusPill;
  g.renderInjectedList = renderInjectedList;
  g.saveInjectedFromEditor = saveInjectedFromEditor;
  g.toggleSlotEnabled = toggleSlotEnabled;
  g.deleteSlot = deleteSlot;
})(globalThis);
