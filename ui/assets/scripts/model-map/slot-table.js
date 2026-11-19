// model-map/slot-table.js — 槽位映射主表格渲染、搜索筛选与全选批量控制
import { escapeHtml, escAttr } from '../ui/dom.js';
import { effectiveEffortToken, formatContextWindow, displayUidForLabel } from './slot-uid-display.js';

async function renderModelMap() {
  const body = document.getElementById('modelMapBody');
  if (!body) return;
  try {
    try {
      await ensureIdeModels({ force: true });
    } catch (e) {
      console.warn('[renderModelMap] ensureIdeModels error:', e);
    }
    try {
      await ensureInjected();
    } catch (e) {
      console.warn('[renderModelMap] ensureInjected error:', e);
    }
    try {
      const res = await invoke('load_model_map');
      modelMapStore = (res && Array.isArray(res.slots)) ? res : { slots: [] };
      globalThis.modelMapLoaded = true;
      if (typeof addLog === 'function') {
        addLog('info', `[renderModelMap] 从磁盘读取到 ${modelMapStore.slots.length} 个槽位`);
      }
    } catch (e) {
      modelMapStore = { slots: [] };
      if (typeof addLog === 'function') addLog('warn', '加载模型映射失败: ' + e);
    }

    ensureModelMapDefaults();
    lastSavedProxyEnhancement = cloneProxyEnhancement();

    modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
    modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
    modelMapStore.slotVisibilityMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
    ensureSlotVisibilityArray();
    const badge = document.getElementById('injected-count-badge');
    if (badge) badge.textContent = '槽位管理';

    const slots = modelMapStore.slots || [];
    const rows = slots.map(s => {
      try {
        return { kind: 'mapped', slot: s, model: slotModelOf(s.modelUid) };
      } catch (err) {
        return { kind: 'mapped', slot: s, model: null };
      }
    });

    const emptyEl = document.getElementById('model-map-empty');
    const tableEl = document.getElementById('modelMapTable');
    const ideName = (typeof getTargetIde === 'function' && getTargetIde() === 'devin') ? 'Devin' : 'Windsurf';
    const subtitleEl = document.getElementById('model-map-empty-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `添加第一个模型映射，让 ${ideName} 使用你指定的 AI 供应商与模型能力。`;
    }

    if (rows.length === 0) {
      if (emptyEl) emptyEl.style.display = '';
      if (tableEl) tableEl.style.display = 'none';
      body.innerHTML = '';
      syncModelMapSelectionState();
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (tableEl) tableEl.style.display = 'table';

    body.innerHTML = rows.map(row => {
      try {
        const s = row.slot;
        const orig = originalNameOf(s.modelUid);
        const customName = s.displayName && s.displayName.trim();
        const baseName = customName || orig;
        const prefix = (modelMapStore.namePrefix || '').trim();
        const tpl = (modelMapStore.labelTemplate || '').trim();
        const firstTarget = (s.targets && s.targets[0]) || null;
        const providerName = firstTarget ? providerNameOf(firstTarget.providerId) : '';
        const apiModel = firstTarget ? firstTarget.model : '';
        const slotThinkingEffort = (firstTarget && firstTarget.thinkingEffort) || s.thinkingEffort || '';
        const display = renderLabelTemplate(tpl, {
          prefix,
          label: baseName,
          provider: providerName,
          apiModel,
          slotUid: displayUidForLabel(s.modelUid),
          effort: effectiveEffortToken(slotThinkingEffort, s.modelUid),
          context: formatContextWindow(s.contextWindow),
        }, {
          showSlotUid: !!modelMapStore.showSlotUid,
          showThinkingEffort: !!modelMapStore.showThinkingEffort,
          showContextWindow: !!modelMapStore.showContextWindow,
        });
        const slotIconKey = typeof getModelIconKey === 'function'
          ? (getModelIconKey(apiModel) || getModelIconKey(baseName) || getModelIconKey(s.modelUid) || getModelIconKey(orig))
          : null;
        const modelIconHtml = typeof renderModelIcon === 'function'
          ? renderModelIcon(slotIconKey || apiModel || s.modelUid || orig || baseName)
          : '';
        const chain = (s.targets && s.targets.length)
          ? renderTargetChain(s.targets)
          : `<span style="color:var(--warn,#d97706);cursor:pointer" data-action="openFailoverEditor" data-arg="${escAttr(s.modelUid)}">未设置 ⚠ [点击配置]</span>`;
        const vision = typeof slotVisionAssessment === 'function'
          ? slotVisionAssessment(s.modelUid, s.targets || [], s.supportsImages !== false)
          : { state: 'supported', label: '支持图片' };
        const enabled = s.enabled !== false;
        const hasVisionModels = (modelMapStore.visionModels?.imageModels?.length || 0) > 0;
        const useThirdParty = s.useThirdPartyVision === true;
        const visionDisabled = !hasVisionModels ? 'disabled' : '';
        const visionTitle = !hasVisionModels
          ? '请先在「网关增强」中配置图片理解模型'
          : (useThirdParty ? '已启用第三方图片理解' : '启用后图片将使用第三方模型理解');
        const selected = modelMapSelectedIds.has(s.modelUid);
        return `
          <tr data-model-uid="${escAttr(s.modelUid)}" data-row-kind="mapped" class="${selected ? 'is-selected' : ''}">
            <td class="model-map-select-cell" data-action="__noop" data-stop>
              <label class="provider-select-check provider-select-check-table" title="选择此映射" data-action="__noop" data-stop>
                <input type="checkbox" class="model-map-row-check" data-uid="${escAttr(s.modelUid)}" ${selected ? 'checked' : ''} data-action="toggleModelMapSelection" data-events="change" data-args="[&quot;${escAttr(s.modelUid)}&quot;]" data-pass-checked data-pass-event>
                <span></span>
              </label>
            </td>
            <td class="editable-cell display-name-cell" data-action="startEditDisplayName" data-args="[&quot;${escAttr(s.modelUid)}&quot;]" data-pass-this title="${escAttr(display)}">
              <div class="model-map-display-name-wrap" style="display:flex;align-items:center;gap:8px;min-width:0;">
                ${modelIconHtml}
                <span class="model-map-display-name-text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${escAttr(display)}</span>
              </div>
            </td>
            <td>
              <div>${escAttr(orig)}</div>
              <div style="margin-top:3px;">${typeof renderVisionPill === 'function' ? renderVisionPill(vision, true) : ''}</div>
            </td>
            <td class="model-target-cell" data-action="openFailoverEditor" data-arg="${escAttr(s.modelUid)}" title="配置故障转移分流目标">${chain}</td>
            <td>
              <div class="model-map-actions">
                <button class="btn-icon model-map-action-btn" data-action="openSlotEditor" data-arg="${escAttr(s.modelUid)}" title="编辑映射" aria-label="编辑映射">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon model-map-action-btn danger" data-action="deleteSlot" data-arg="${escAttr(s.modelUid)}" title="删除映射" aria-label="删除映射">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </td>
            <td class="model-map-toggle-cell">
              <label class="toggle-switch" title="${escAttr(visionTitle)}">
                <input type="checkbox" ${useThirdParty ? 'checked' : ''} ${visionDisabled} data-action="toggleSlotThirdPartyVision" data-events="change" data-args="[&quot;${escAttr(s.modelUid)}&quot;]" data-pass-checked>
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td class="model-map-toggle-cell">
              <label class="toggle-switch" title="${enabled ? '已启用，点击停用' : '已停用，点击启用'}">
                <input type="checkbox" ${enabled ? 'checked' : ''} data-action="toggleSlotEnabled" data-events="change" data-arg="${escAttr(s.modelUid)}">
                <span class="toggle-slider"></span>
              </label>
            </td>
          </tr>`;
      } catch (rowErr) {
        console.error('[renderModelMap] row render error:', rowErr);
        return '';
      }
    }).join('');

    filterModelTable();
    syncModelMapSelectionState();
  } catch (globalErr) {
    console.error('[renderModelMap] global error:', globalErr);
    if (typeof addLog === 'function') {
      addLog('err', '[renderModelMap] 渲染严重异常: ' + globalErr);
    }
  }
}

// ─── 双击/点击编辑显示名 ───
function startEditDisplayName(td, uid) {
  if (td.querySelector('input')) return;
  // 编辑时只展示自定义名部分（不含前缀），便于用户修改
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  const orig = originalNameOf(uid);
  const customName = s && s.displayName && s.displayName.trim() ? s.displayName : orig;
  td.innerHTML = `<input type="text" class="input-sm" style="width:100%; text-align:left; font-family:inherit; padding:4px 8px; border-radius:6px; box-shadow:none; outline:none; height:28px;" value="${escAttr(customName)}">`;
  const input = td.querySelector('input');

  // 阻止 input 上的点击事件冒泡，防止重复触发 td.onclick
  input.addEventListener('click', (e) => e.stopPropagation());

  input.focus();
  input.select();

  let finished = false;
  async function finishEdit() {
    if (finished) return;
    finished = true;
    const newVal = input.value.trim();
    const s = modelMapStore.slots.find(x => x.modelUid === uid);
    if (s) {
      const orig = originalNameOf(uid);
      const prevDisplay = s.displayName && s.displayName.trim() ? s.displayName : orig;
      // 只有当新输入的值和当前的显示名（或原名）不同，才更新并保存
      if (newVal !== prevDisplay) {
        const prev = s.displayName;
        // 如果输入的值就是原名，视为清除自定义显示名，保存为空
        s.displayName = (newVal === orig) ? '' : newVal;
        if (await persistModelMap()) {
          addLog('ok', `已更新显示名: ${newVal || orig}`);
        } else {
          s.displayName = prev;
        }
      }
    }
    await renderModelMap();
  }

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishEdit();
    } else if (e.key === 'Escape') {
      finished = true;
      renderModelMap();
    }
  });
}

// ═══════ MODEL FILTERING LOGIC ═══════
function filterModelTable() {
  const searchInput = document.getElementById('model-search-input');
  const query = String(searchInput?.value || '').toLowerCase().trim();

  const body = document.getElementById('modelMapBody');
  if (!body) return;

  const prevNoResult = document.getElementById('model-map-no-result-row');
  if (prevNoResult) prevNoResult.remove();

  const rows = body.getElementsByTagName('tr');
  let matchCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // 跳过无结果提示行
    if (row.id === 'model-map-no-result-row') {
      continue;
    }

    // cells[0]=复选框 cells[1]=显示名 cells[2]=原模型名 cells[3]=映射目标/供应商
    const display = (row.cells[1]?.textContent || '').toLowerCase();
    const orig = (row.cells[2]?.textContent || '').toLowerCase();
    const target = (row.cells[3]?.textContent || '').toLowerCase();
    const slot = (row.dataset.modelUid || '').toLowerCase();

    // 搜索匹配
    const matchesSearch = query === '' ||
      orig.includes(query) ||
      display.includes(query) ||
      target.includes(query) ||
      slot.includes(query);

    if (matchesSearch) {
      row.style.display = '';
      matchCount++;
    } else {
      row.style.display = 'none';
    }
  }

  if (query && matchCount === 0 && rows.length > 0) {
    const tr = document.createElement('tr');
    tr.id = 'model-map-no-result-row';
    tr.innerHTML = '<td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px 0;font-size:13px;">未找到匹配的模型映射</td>';
    body.appendChild(tr);
  }

  syncModelMapSelectionState();
}

async function persistModelMap() {
  if (!globalThis.modelMapLoaded) {
    console.warn('[persistModelMap] modelMapStore 尚未加载完成，放弃保存以保护磁盘配置');
    return false;
  }
  try {
    ensureModelMapDefaults();
    await invoke('save_model_map', { map: modelMapForPersist() });
    lastSavedProxyEnhancement = cloneProxyEnhancement();
    return true;
  } catch (e) {
    addLog('err', '保存映射失败: ' + e);
    showCustomAlert('保存映射失败：' + e, '保存失败', 'error');
    return false;
  }
}

// ─── 模型映射批量勾选 / 批量操作 ───
// 选区：仅包含 modelMapStore.slots 中真实存在的 modelUid（避免指向已删除行）
function cleanupModelMapSelection() {
  const valid = new Set((modelMapStore.slots || []).map(s => s.modelUid));
  modelMapSelectedIds.forEach(uid => {
    if (!valid.has(uid)) modelMapSelectedIds.delete(uid);
  });
}

function toggleModelMapSelection(uid, checked, event) {
  if (event) event.stopPropagation();
  if (!uid) return;
  if (checked) modelMapSelectedIds.add(uid);
  else modelMapSelectedIds.delete(uid);
  // 同步行高亮
  const row = document.querySelector(`#modelMapBody tr[data-model-uid="${CSS.escape(uid)}"]`);
  if (row) row.classList.toggle('is-selected', checked);
  syncModelMapSelectionState();
}

function visibleModelMapSlots() {
  // 搜索/过滤后仍可见的行
  return Array.from(document.querySelectorAll('#modelMapBody tr[data-row-kind="mapped"]'))
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.modelUid)
    .filter(Boolean);
}

function toggleVisibleModelMapSelectionFromHeader(checked) {
  // 表头全选框的勾选态由 syncModelMapSelectionState 校正，传入的 checked 仅作参考
  const visible = visibleModelMapSlots();
  if (!visible.length) return;
  const allSelected = visible.length > 0 && visible.every(uid => modelMapSelectedIds.has(uid));
  visible.forEach(uid => {
    if (allSelected) modelMapSelectedIds.delete(uid);
    else modelMapSelectedIds.add(uid);
  });
  renderModelMap();
}

function toggleVisibleModelMapSelection() {
  // 工具栏的「选择当前」按钮：若当前可见行已全选则取消，否则全选当前
  const visible = visibleModelMapSlots();
  if (!visible.length) return;
  const allSelected = visible.every(uid => modelMapSelectedIds.has(uid));
  visible.forEach(uid => {
    if (allSelected) modelMapSelectedIds.delete(uid);
    else modelMapSelectedIds.add(uid);
  });
  renderModelMap();
}

function syncModelMapSelectionState() {
  cleanupModelMapSelection();
  const total = (modelMapStore.slots || []).length;
  const selected = modelMapSelectedIds.size;
  const countEl = document.getElementById('modelMapBulkCount');
  const _t = (k, p) => (typeof window.t === 'function' ? window.t(k, p) : k);
  if (countEl) {
    countEl.textContent = selected
      ? _t('已选择 {selected} / {total}', { selected, total })
      : _t('共 {total} 个', { total });
    countEl.classList.toggle('is-active', selected > 0);
  }
  const disabled = modelMapBulkRunning || selected === 0;
  ['modelMapBulkEnableBtn', 'modelMapBulkDisableBtn', 'modelMapBulkVisionBtn', 'modelMapBulkDeleteBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
  // 工具栏的「选择当前」按钮
  const selectVisibleBtn = document.getElementById('modelMapSelectVisibleBtn');
  const visibleIds = visibleModelMapSlots();
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = modelMapBulkRunning || visibleIds.length === 0;
    selectVisibleBtn.textContent = visibleIds.length && visibleIds.every(uid => modelMapSelectedIds.has(uid))
      ? _t('取消当前')
      : _t('选择当前');
  }
  // 表头全选框的 indeterminate 与 checked 态
  const selectAll = document.getElementById('modelMapSelectAll');
  if (selectAll) {
    const visibleSelectedCount = visibleIds.filter(uid => modelMapSelectedIds.has(uid)).length;
    if (visibleIds.length === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      selectAll.disabled = true;
    } else {
      selectAll.disabled = false;
      selectAll.checked = visibleSelectedCount === visibleIds.length;
      selectAll.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;
    }
  }
}

async function batchSetSelectedSlotsEnabled(enabled) {
  if (modelMapBulkRunning) return;
  cleanupModelMapSelection();
  const targets = (modelMapStore.slots || []).filter(s => modelMapSelectedIds.has(s.modelUid));
  if (!targets.length) return;
  modelMapBulkRunning = true;
  syncModelMapSelectionState();
  const prevMap = new Map(targets.map(s => [s.modelUid, s.enabled !== false]));
  let okCount = 0;
  try {
    targets.forEach(s => { s.enabled = enabled === true; });
    if (await persistModelMap()) {
      okCount = targets.length;
      addLog('ok', `已${enabled ? '启用' : '停用'} ${okCount} 个模型映射`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已${enabled ? '启用' : '停用'} ${okCount} 个模型映射`, 'success');
      }
    } else {
      prevMap.forEach((prev, uid) => {
        const s = modelMapStore.slots.find(x => x.modelUid === uid);
        if (s) s.enabled = prev;
      });
    }
  } catch (e) {
    prevMap.forEach((prev, uid) => {
      const s = modelMapStore.slots.find(x => x.modelUid === uid);
      if (s) s.enabled = prev;
    });
    addLog('err', `批量${enabled ? '启用' : '停用'}失败: ` + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    modelMapBulkRunning = false;
    await renderModelMap();
  }
}

async function batchSetSelectedSlotsThirdPartyVision(enabled) {
  if (modelMapBulkRunning) return;
  cleanupModelMapSelection();
  const hasVisionModels = (modelMapStore.visionModels?.imageModels?.length || 0) > 0;
  if (!hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置图片理解模型。', '无法启用', 'warn');
    return;
  }
  const targets = (modelMapStore.slots || []).filter(s => modelMapSelectedIds.has(s.modelUid));
  if (!targets.length) return;
  modelMapBulkRunning = true;
  syncModelMapSelectionState();
  const prevMap = new Map(targets.map(s => [s.modelUid, s.useThirdPartyVision === true]));
  let okCount = 0;
  try {
    targets.forEach(s => { s.useThirdPartyVision = enabled === true; });
    if (await persistModelMap()) {
      okCount = targets.length;
      addLog('ok', `已为 ${okCount} 个映射${enabled ? '启用' : '关闭'}第三方图片理解`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已${enabled ? '启用' : '关闭'} ${okCount} 个映射的第三方图片理解`, 'success');
      }
    } else {
      prevMap.forEach((prev, uid) => {
        const s = modelMapStore.slots.find(x => x.modelUid === uid);
        if (s) s.useThirdPartyVision = prev;
      });
    }
  } catch (e) {
    prevMap.forEach((prev, uid) => {
      const s = modelMapStore.slots.find(x => x.modelUid === uid);
      if (s) s.useThirdPartyVision = prev;
    });
    addLog('err', `批量${enabled ? '启用' : '关闭'}第三方图片理解失败: ` + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    modelMapBulkRunning = false;
    await renderModelMap();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.renderModelMap = renderModelMap;
  g.startEditDisplayName = startEditDisplayName;
  g.filterModelTable = filterModelTable;
  g.persistModelMap = persistModelMap;
  g.cleanupModelMapSelection = cleanupModelMapSelection;
  g.toggleModelMapSelection = toggleModelMapSelection;
  g.visibleModelMapSlots = visibleModelMapSlots;
  g.toggleVisibleModelMapSelectionFromHeader = toggleVisibleModelMapSelectionFromHeader;
  g.toggleVisibleModelMapSelection = toggleVisibleModelMapSelection;
  g.syncModelMapSelectionState = syncModelMapSelectionState;
  g.batchSetSelectedSlotsEnabled = batchSetSelectedSlotsEnabled;
  g.batchSetSelectedSlotsThirdPartyVision = batchSetSelectedSlotsThirdPartyVision;
})(globalThis);
