// platforms/cursor_console.js — split from 55-platforms.js
// ═══════ Cursor BYOK Console (Specs Aligned Architecture) ═══════

globalThis.cursorConsoleBusy = false;
globalThis._cursorCachedStatus = null;
globalThis._cursorModelsList = [];
globalThis._cursorSearchKeyword = '';
globalThis._cursorSelectedSet = new Set();
globalThis._cursorProviderModels = [];
globalThis._cursorAddSelectedProvider = null;
globalThis._cursorAddSelectedModels = new Map(); // providerId -> Set of modelId
globalThis._cursorAddSearchKw = '';
globalThis._cursorAddSortMode = 'default';
globalThis._cursorProviderTagStyle = 'badge';
globalThis._cursorProviderBracketLeft = '[';
globalThis._cursorProviderBracketRight = ']';

function cursorEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cursorPageRoot() {
  return document.getElementById('page-platform-cursor');
}

function cursorEnsureBridge() {
  if (!invoke && typeof bindTauriBridge === 'function') bindTauriBridge();
  if (!invoke) throw new Error('Tauri 通道未就绪，Cursor 接入操作不可用。请从桌面版客户端启动。');
}

function cursorSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function cursorSetBusy(busy, busyText) {
  cursorConsoleBusy = !!busy;
  const mainBtn = document.getElementById('cursor-main-btn');
  const mainBtnText = document.getElementById('cursor-main-btn-text');
  const refreshBtn = document.getElementById('cursorRefreshBtn');
  const restoreBtn = document.getElementById('cursorRestoreBtn');

  if (mainBtn) {
    mainBtn.disabled = !!busy;
    if (busy && busyText && mainBtnText) {
      mainBtnText.textContent = busyText;
    }
  }
  if (refreshBtn) {
    refreshBtn.disabled = !!busy;
    refreshBtn.classList.toggle('is-spinning', !!busy);
  }
  if (restoreBtn && busy) {
    restoreBtn.disabled = true;
  }
}

// 刷新控制台主状态与模型列表
async function cursorRefreshConsole(options = {}) {
  const root = cursorPageRoot();
  if (!root) return;
  const isSilent = !!(options && options.silent);
  if (!isSilent) cursorSetBusy(true);

  try {
    cursorEnsureBridge();

    // 1. 获取 Rust Cursor Core 状态与模型列表（并行请求减少等待时间）
    const [statusRes, modelsRes, tagStyleRes] = await Promise.allSettled([
      invoke('cursor_get_status'),
      invoke('cursor_list_models'),
      invoke('cursor_get_provider_tag_style')
    ]);

    let status = statusRes.status === 'fulfilled' ? statusRes.value : null;
    globalThis._cursorCachedStatus = status;

    if (modelsRes.status === 'fulfilled' && Array.isArray(modelsRes.value)) {
      globalThis._cursorModelsList = modelsRes.value;
    }

    if (tagStyleRes.status === 'fulfilled' && tagStyleRes.value) {
      const val = tagStyleRes.value;
      if (typeof val === 'object' && val !== null) {
        globalThis._cursorProviderTagStyle = val.style || 'badge';
        globalThis._cursorProviderBracketLeft = val.bracketLeft ?? '[';
        globalThis._cursorProviderBracketRight = val.bracketRight ?? ']';
      } else if (typeof val === 'string') {
        globalThis._cursorProviderTagStyle = val;
      }
    }
    cursorUpdateTagStyleSelects(globalThis._cursorProviderTagStyle);

    // 界面汉化按钮状态（与 Rust 保活 keeper 同一数据源）
    if (typeof refreshCursorLangStatus === 'function') {
      void refreshCursorLangStatus();
    }

    const running = !!status?.running;
    const certReady = !!status?.certificateReady;
    const configuredCount = globalThis._cursorModelsList.length;
    const port = status?.controlPort || 17650;
    const actions = Array.isArray(status?.availableActions) ? status.availableActions : [];
    const canEnable = actions.includes('enable');
    const canDisable = actions.includes('disable');
    const canSync = actions.includes('sync');
    const canRepair = actions.includes('repair');

    // 1) 主动作按钮与停止按钮 (对齐 Devin / Windsurf 极简模式)
    const mainBtn = document.getElementById('cursor-main-btn');
    const mainBtnText = document.getElementById('cursor-main-btn-text');
    const restoreBtn = document.getElementById('cursorRestoreBtn');

    if (mainBtn && mainBtnText) {
      const icon = mainBtn.querySelector('.proxy-btn-icon');
      const _t = (k, p) => (typeof window.t === 'function' ? window.t(k, p) : k);
      if (running) {
        mainBtn.classList.add('is-connected');
        if (icon) {
          icon.innerHTML = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>';
        }
        mainBtnText.textContent = _t('已接入');
        mainBtn.setAttribute('aria-label', `Cursor ${_t('已接入')}`);
      } else if (!certReady && canRepair) {
        mainBtn.classList.remove('is-connected');
        if (icon) {
          icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
        }
        mainBtnText.textContent = _t('安装证书');
      } else if (configuredCount === 0) {
        mainBtn.classList.remove('is-connected');
        if (icon) {
          icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
        }
        mainBtnText.textContent = _t('添加模型');
      } else {
        mainBtn.classList.remove('is-connected');
        if (icon) {
          icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
        }
        mainBtnText.textContent = '一键接入';
      }
    }

    if (restoreBtn) {
      restoreBtn.disabled = !running;
      restoreBtn.classList.toggle('is-danger', running);
      restoreBtn.setAttribute('aria-label', running ? '停止 Cursor 接入 AnyBridge' : 'Cursor 当前未接入');
    }

    // 2) 更新模型数量与渲染列表
    const countPill = document.getElementById('cursor-model-count');
    if (countPill) {
      countPill.textContent = `共 ${configuredCount} 个`;
    }

    // 清理可能不存在的选中项
    const validIds = new Set(globalThis._cursorModelsList.map(m => m.id));
    globalThis._cursorSelectedSet = new Set(Array.from(globalThis._cursorSelectedSet).filter(id => validIds.has(id)));

    cursorRenderTableRows();
    cursorUpdateBulkActionButtons();

    // Hero 版本行
    if (typeof renderHeroVersion === 'function') {
      renderHeroVersion('cursor', 'cursor-platform-version');
    }

  } catch (err) {
    console.error('[cursor] refresh error:', err);
  } finally {
    if (!isSilent) cursorSetBusy(false);
  }
}

// 渲染表格行数据 (对齐 cb-model-table 与 cb-model-empty)
function cursorRenderTableRows() {
  const tbody = document.getElementById('cursorModelTableBody');
  const empty = document.getElementById('cursor-model-empty');
  const table = document.getElementById('cursor-model-table');
  if (!tbody) return;

  if (!globalThis._cursorModelsList || globalThis._cursorModelsList.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';

  const list = cursorGetFilteredList();
  const kw = (globalThis._cursorSearchKeyword || '').trim();

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 36px 0;">
          未找到匹配「${cursorEsc(kw)}」的 Cursor 模型
        </td>
      </tr>
    `;
    return;
  }

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  let html = '';
  list.forEach(item => {
    const isChecked = globalThis._cursorSelectedSet.has(item.id);
    const displayName = (item.displayName || item.exposedModelId || '').trim();
    const providerName = (item.providerName || '未知供应商').trim();
    const isEnabled = item.enabled !== false;
    const isVisionEnabled = item.useThirdPartyVision === true;

    const iconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(item.exposedModelId || item.upstreamModel, { size: 20 })
      : `<span style="color:var(--accent);">✦</span>`;

    const visionTitle = !hasVisionModels
      ? '请先在「网关增强」中配置图片理解模型'
      : (isVisionEnabled ? '已启用第三方图片理解（点击关闭）' : '启用后图片将使用第三方模型理解（点击启用）');

    html += `
      <tr class="${isChecked ? 'cb-model-row-selected is-selected' : ''}" data-binding-id="${cursorEsc(item.id)}" style="min-height: 52px;">
        <td class="cb-select-cell" style="text-align: center; padding-left: 14px;">
          <label class="provider-select-check provider-select-check-table" data-stop data-action="__noop">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="cursorToggleRowSelect('${cursorEsc(item.id)}', this.checked)">
            <span></span>
          </label>
        </td>
        <td class="editable-cell display-name-cell" onclick="cursorStartEditDisplayName(this, '${cursorEsc(item.id)}')" title="点击修改显示名称">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--bg-input);border:1px solid var(--border);flex:0 0 24px;">
              ${iconHtml}
            </div>
            <div style="min-width:0;flex:1;">
              <strong style="font-weight:750;color:var(--text-primary);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cursorEsc(displayName)}">${cursorEsc(displayName)}</strong>
            </div>
          </div>
        </td>
        <td>
          <div class="model-id-copy-wrap" style="display:inline-flex;align-items:center;gap:6px;">
            <code style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);background:var(--bg-input);padding:2px 6px;border-radius:4px;border:1px solid var(--border);">${cursorEsc(item.exposedModelId)}</code>
            <button class="btn-icon model-id-copy-btn" style="width:22px;height:22px;min-width:22px;border:none;background:transparent;" onclick="copyTextToClipboard('${cursorEsc(item.exposedModelId)}', '模型 ID')" title="复制暴露模型 ID">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </td>
        <td>
          <div style="font-size:12.5px;color:var(--text-primary);font-weight:600;">${cursorEsc(providerName)}</div>
        </td>
        <td>
          <div class="model-map-actions">
            <button class="btn-icon model-map-action-btn" onclick="openCursorEditModal('${cursorEsc(item.id)}')" title="编辑模型" aria-label="编辑模型">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" onclick="cursorRemoveSingleModel('${cursorEsc(item.id)}', '${cursorEsc(displayName)}')" title="从 Cursor 移除" aria-label="从 Cursor 移除">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${cursorEsc(visionTitle)}">
            <input type="checkbox" ${isVisionEnabled ? 'checked' : ''} onchange="cursorToggleThirdPartyVision('${cursorEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${isEnabled ? '已向 Cursor 暴露（点击停用）' : '已停用（点击启用）'}">
            <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="cursorToggleModelEnabled('${cursorEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// 获取过滤后的模型列表
function cursorGetFilteredList() {
  const kw = (globalThis._cursorSearchKeyword || '').trim().toLowerCase();
  return (globalThis._cursorModelsList || []).filter(item => {
    if (!kw) return true;
    const matchName = (item.displayName || '').toLowerCase().includes(kw);
    const matchExposed = (item.exposedModelId || '').toLowerCase().includes(kw);
    const matchProvider = (item.providerName || '').toLowerCase().includes(kw);
    const matchTarget = (item.upstreamModel || '').toLowerCase().includes(kw);
    let matchUrl = false;
    if (providerStore && Array.isArray(providerStore.providers)) {
      const p = providerStore.providers.find(x => x.id === item.providerId);
      if (p && (p.baseUrl || p.apiHost)) {
        matchUrl = String(p.baseUrl || p.apiHost).toLowerCase().includes(kw);
      }
    }
    return matchName || matchExposed || matchProvider || matchTarget || matchUrl;
  });
}

// 就地修改显示名称
function cursorStartEditDisplayName(td, bindingId) {
  if (td.querySelector('input')) return;
  const item = globalThis._cursorModelsList.find(x => x.id === bindingId);
  if (!item) return;

  const currName = (item.displayName || item.exposedModelId || '').trim();
  td.innerHTML = `<input type="text" class="input-sm" style="width:100%; text-align:left; font-family:inherit; padding:4px 8px; border-radius:6px; box-shadow:none; outline:none; height:28px; font-size:13px; font-weight:600; color:var(--text-primary); background:var(--bg-card); border:1px solid var(--accent);" value="${cursorEsc(currName)}">`;
  const input = td.querySelector('input');
  if (!input) return;

  input.addEventListener('click', (e) => e.stopPropagation());
  input.focus();
  input.select();

  let finished = false;
  async function finishEdit() {
    if (finished) return;
    finished = true;
    const newVal = input.value.trim();
    if (newVal && newVal !== currName) {
      cursorEnsureBridge();
      try {
        await invoke('cursor_update_model', {
          payload: {
            id: bindingId,
            displayName: newVal
          }
        });
        item.displayName = newVal;
        cursorRefreshConsole({ silent: true }).catch(() => {});
      } catch (e) {
        showCustomAlert('更新显示名失败: ' + e, '保存异常', 'error');
      }
    }
    cursorRenderTableRows();
  }

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishEdit();
    } else if (e.key === 'Escape') {
      finished = true;
      cursorRenderTableRows();
    }
  });
}

// 搜索栏输入联动
function cursorFilterModels(keyword) {
  globalThis._cursorSearchKeyword = keyword || '';
  cursorRenderTableRows();
}

// 勾选单行
function cursorToggleRowSelect(bindingId, checked) {
  if (checked) {
    globalThis._cursorSelectedSet.add(bindingId);
  } else {
    globalThis._cursorSelectedSet.delete(bindingId);
  }
  const tr = document.querySelector(`tr[data-binding-id="${bindingId}"]`);
  if (tr) tr.classList.toggle('is-selected', checked);
  cursorUpdateBulkActionButtons();
}

// 全选 / 取消全选
function cursorToggleSelectAll(checked) {
  globalThis._cursorSelectedSet.clear();
  if (checked) {
    const list = cursorGetFilteredList();
    list.forEach(m => globalThis._cursorSelectedSet.add(m.id));
  }
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
}

// 选择当前显示的所有模型
function cursorToggleSelectAllVisible() {
  const list = cursorGetFilteredList();
  if (!list.length) return;
  const allSelected = list.every(m => globalThis._cursorSelectedSet.has(m.id));
  if (allSelected) {
    list.forEach(m => globalThis._cursorSelectedSet.delete(m.id));
  } else {
    list.forEach(m => globalThis._cursorSelectedSet.add(m.id));
  }
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
}

// 更新批量操作按钮状态
function cursorUpdateBulkActionButtons() {
  const hasSelected = globalThis._cursorSelectedSet.size > 0;
  const enableBtn = document.getElementById('cursor-bulk-enable-btn');
  const disableBtn = document.getElementById('cursor-bulk-disable-btn');
  const visionBtn = document.getElementById('cursor-bulk-vision-btn');
  const removeBtn = document.getElementById('cursor-bulk-remove-btn');
  const selectVisibleBtn = document.getElementById('cursor-bulk-select-visible-btn');
  const selectAllCheckbox = document.getElementById('cursorSelectAll');

  if (enableBtn) enableBtn.disabled = !hasSelected;
  if (disableBtn) disableBtn.disabled = !hasSelected;
  if (visionBtn) visionBtn.disabled = !hasSelected;
  if (removeBtn) removeBtn.disabled = !hasSelected;

  const list = cursorGetFilteredList();
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = list.length === 0;
  }
  if (selectAllCheckbox && list.length > 0) {
    selectAllCheckbox.checked = list.every(m => globalThis._cursorSelectedSet.has(m.id));
  } else if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
  }
}

// 切换单模型第三方图片理解
async function cursorToggleThirdPartyVision(bindingId, enabled) {
  cursorEnsureBridge();
  const item = globalThis._cursorModelsList.find(m => m.id === bindingId);
  if (!item) return;

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (enabled && !hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置图片理解模型。', '无法启用', 'warn');
    cursorRenderTableRows();
    return;
  }

  const prev = item.useThirdPartyVision;
  item.useThirdPartyVision = !!enabled;
  cursorRenderTableRows();
  try {
    await invoke('cursor_update_model', {
      payload: {
        id: bindingId,
        useThirdPartyVision: !!enabled
      }
    });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    item.useThirdPartyVision = prev;
    cursorRenderTableRows();
    showCustomAlert('切换第三方图片理解失败: ' + e, '操作异常', 'error');
  }
}

// 批量启用第三方图片理解
async function cursorBulkThirdPartyVisionAction() {
  if (globalThis._cursorSelectedSet.size === 0) return;
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (!hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置第三方图片理解模型。', '无法启用', 'warn');
    return;
  }

  const ids = Array.from(globalThis._cursorSelectedSet);
  cursorEnsureBridge();
  globalThis._cursorModelsList.forEach(m => {
    if (globalThis._cursorSelectedSet.has(m.id)) {
      m.useThirdPartyVision = true;
    }
  });
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_third_party_vision', { ids, enabled: true });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    console.error('[cursor] bulk set third party vision failed:', e);
    showCustomAlert('批量设置第三方图片理解失败: ' + e, '操作异常', 'error');
  }
}

// 批量启用
async function cursorBulkEnableAction() {
  if (globalThis._cursorSelectedSet.size === 0) return;
  cursorEnsureBridge();
  const ids = Array.from(globalThis._cursorSelectedSet);
  globalThis._cursorModelsList.forEach(m => {
    if (globalThis._cursorSelectedSet.has(m.id)) {
      m.enabled = true;
    }
  });
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_enabled', { ids, enabled: true });
    if (typeof addLog === 'function') addLog('ok', `已批量启用 ${ids.length} 个 Cursor 模型`);
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    console.error('[cursor] bulk enable failed:', e);
    showCustomAlert('批量启用失败: ' + e, '操作异常', 'error');
  }
}

// 批量停用
async function cursorBulkDisableAction() {
  if (globalThis._cursorSelectedSet.size === 0) return;
  cursorEnsureBridge();
  const ids = Array.from(globalThis._cursorSelectedSet);
  globalThis._cursorModelsList.forEach(m => {
    if (globalThis._cursorSelectedSet.has(m.id)) {
      m.enabled = false;
    }
  });
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_enabled', { ids, enabled: false });
    if (typeof addLog === 'function') addLog('ok', `已批量停用 ${ids.length} 个 Cursor 模型`);
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    console.error('[cursor] bulk disable failed:', e);
    showCustomAlert('批量停用失败: ' + e, '操作异常', 'error');
  }
}

// 批量移除
async function cursorBulkRemoveAction() {
  if (globalThis._cursorSelectedSet.size === 0) return;
  const count = globalThis._cursorSelectedSet.size;
  // 仅移除 Cursor 中的选用关系（不影响统一供应商与共享路由），直接生效不再二次确认。
  cursorEnsureBridge();
  const ids = Array.from(globalThis._cursorSelectedSet);
  const prevList = globalThis._cursorModelsList.slice();
  globalThis._cursorModelsList = globalThis._cursorModelsList.filter(m => !globalThis._cursorSelectedSet.has(m.id));
  globalThis._cursorSelectedSet.clear();
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
  try {
    await invoke('cursor_remove_models', { ids });
    if (typeof addLog === 'function') addLog('ok', `已从 Cursor 移除 ${count} 个模型绑定`);
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    globalThis._cursorModelsList = prevList;
    cursorRenderTableRows();
    console.error('[cursor] bulk remove failed:', e);
    showCustomAlert('批量移除失败: ' + e, '移除异常', 'error');
  }
}

// 单个模型启停
async function cursorToggleModelEnabled(bindingId, enabled) {
  cursorEnsureBridge();
  const item = globalThis._cursorModelsList.find(m => m.id === bindingId);
  if (!item) return;
  const prev = item.enabled;
  item.enabled = !!enabled;
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_enabled', { ids: [bindingId], enabled: !!enabled });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    item.enabled = prev;
    cursorRenderTableRows();
    showCustomAlert('切换状态失败: ' + e, '操作异常', 'error');
  }
}

// 单个模型移除
async function cursorRemoveSingleModel(bindingId, displayName) {
  // 仅从 Cursor 列表移除（不影响共享路由与其他 IDE），直接生效不再二次确认。
  cursorEnsureBridge();
  const prevList = globalThis._cursorModelsList.slice();
  globalThis._cursorModelsList = globalThis._cursorModelsList.filter(m => m.id !== bindingId);
  globalThis._cursorSelectedSet.delete(bindingId);
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
  try {
    await invoke('cursor_remove_models', { ids: [bindingId] });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    globalThis._cursorModelsList = prevList;
    cursorRenderTableRows();
    showCustomAlert('移除模型失败: ' + e, '移除异常', 'error');
  }
}

// ═══════ CURSOR 编辑模型模态弹窗 ═══════

function openCursorEditModal(bindingId) {
  const item = globalThis._cursorModelsList.find(m => m.id === bindingId);
  if (!item) return;

  const modal = document.getElementById('cursorEditModelModal');
  if (!modal) return;

  document.getElementById('cursorEditBindingId').value = item.id;
  document.getElementById('cursorEditDisplayName').value = item.displayName || '';
  
  const iconEl = document.getElementById('cursorEditModelIcon');
  if (iconEl) {
    iconEl.innerHTML = (typeof renderModelIcon === 'function')
      ? renderModelIcon(item.exposedModelId || item.upstreamModel, { size: 20 })
      : '✦';
  }

  const exposedTextEl = document.getElementById('cursorEditExposedIdText');
  if (exposedTextEl) exposedTextEl.textContent = item.exposedModelId || '--';

  const providerNameEl = document.getElementById('cursorEditProviderName');
  if (providerNameEl) providerNameEl.textContent = item.providerName || 'AnyBridge 共享路由';

  const routeUidEl = document.getElementById('cursorEditRouteUidShort');
  if (routeUidEl) routeUidEl.textContent = item.routeUid ? (item.routeUid.length > 18 ? item.routeUid.slice(0, 18) + '...' : item.routeUid) : '--';

  document.getElementById('cursorEditEnabled').checked = item.enabled !== false;
  const tpvEl = document.getElementById('cursorEditThirdPartyVision');
  if (tpvEl) tpvEl.checked = item.useThirdPartyVision === true;
  document.getElementById('cursorEditReasoningEffort').value = item.overrides?.reasoningEffort || '';
  document.getElementById('cursorEditContextWindow').value = item.overrides?.contextWindowTokens || '';
  document.getElementById('cursorEditMaxTokens').value = item.overrides?.maxCompletionTokens || '';

  modal.classList.add('active');
}

function closeCursorEditModal() {
  const modal = document.getElementById('cursorEditModelModal');
  if (modal) modal.classList.remove('active');
}

async function saveCursorEditModel() {
  const bindingId = document.getElementById('cursorEditBindingId').value;
  if (!bindingId) return;

  const displayName = (document.getElementById('cursorEditDisplayName').value || '').trim();
  const enabled = document.getElementById('cursorEditEnabled').checked;
  const useThirdPartyVision = document.getElementById('cursorEditThirdPartyVision') ? document.getElementById('cursorEditThirdPartyVision').checked : false;
  const reasoningEffort = document.getElementById('cursorEditReasoningEffort').value || null;
  const contextRaw = document.getElementById('cursorEditContextWindow').value;
  const maxRaw = document.getElementById('cursorEditMaxTokens').value;

  const contextWindowTokens = contextRaw ? parseInt(contextRaw, 10) : null;
  const maxCompletionTokens = maxRaw ? parseInt(maxRaw, 10) : null;

  cursorEnsureBridge();
  try {
    await invoke('cursor_update_model', {
      payload: {
        id: bindingId,
        displayName: displayName || null,
        enabled,
        useThirdPartyVision,
        overrides: {
          reasoningEffort: reasoningEffort || null,
          contextWindowTokens: (contextWindowTokens && !isNaN(contextWindowTokens)) ? contextWindowTokens : null,
          maxCompletionTokens: (maxCompletionTokens && !isNaN(maxCompletionTokens)) ? maxCompletionTokens : null
        }
      }
    });

    closeCursorEditModal();
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    showCustomAlert('保存修改失败: ' + e, '保存异常', 'error');
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cursorEsc = cursorEsc;
  g.cursorPageRoot = cursorPageRoot;
  g.cursorEnsureBridge = cursorEnsureBridge;
  g.cursorSetText = cursorSetText;
  g.cursorSetBusy = cursorSetBusy;
  g.cursorRefreshConsole = cursorRefreshConsole;
  g.cursorRenderTableRows = cursorRenderTableRows;
  g.cursorGetFilteredList = cursorGetFilteredList;
  g.cursorStartEditDisplayName = cursorStartEditDisplayName;
  g.cursorFilterModels = cursorFilterModels;
  g.cursorToggleRowSelect = cursorToggleRowSelect;
  g.cursorToggleSelectAll = cursorToggleSelectAll;
  g.cursorToggleSelectAllVisible = cursorToggleSelectAllVisible;
  g.cursorUpdateBulkActionButtons = cursorUpdateBulkActionButtons;
  g.cursorToggleThirdPartyVision = cursorToggleThirdPartyVision;
  g.cursorBulkThirdPartyVisionAction = cursorBulkThirdPartyVisionAction;
  g.cursorBulkEnableAction = cursorBulkEnableAction;
  g.cursorBulkDisableAction = cursorBulkDisableAction;
  g.cursorBulkRemoveAction = cursorBulkRemoveAction;
  g.cursorToggleModelEnabled = cursorToggleModelEnabled;
  g.cursorRemoveSingleModel = cursorRemoveSingleModel;
  g.openCursorEditModal = openCursorEditModal;
  g.closeCursorEditModal = closeCursorEditModal;
  g.saveCursorEditModel = saveCursorEditModel;
})(globalThis);
