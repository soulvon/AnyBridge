// platforms/model_list_rows.js — 平台模型列表过滤、勾选批量操作与持久化

function cbModelsByClass(cls) {
  if (cls === 'cb') return cbModels;
  if (cls === 'zc') return zcModels;
  if (MANAGED_MODEL_PLATFORM_IDS[cls.charAt(0).toUpperCase() + cls.slice(1)]) {
    return globalThis[`${cls}Models`];
  }
  return wbModels;
}

function cbModelMatches(model, keyword) {
  if (!keyword) return true;
  return [
    model?.name,
    model?.id,
    model?.vendor,
    model?.url,
  ].some(value => String(value || '').toLowerCase().includes(keyword));
}

function cbFilteredModelEntries(models, prefix) {
  const keyword = (document.getElementById(`${prefix}-model-search`)?.value || '').trim().toLowerCase();
  return (models || [])
    .map((model, index) => ({ model, index }))
    .filter(entry => cbModelMatches(entry.model, keyword));
}

function cbNoResultRow(prefix) {
  return `
    <tr class="model-console-empty-row">
      <td colspan="7">
        <div>
          <strong>没有匹配的模型</strong>
          <span>换个关键词或清空搜索</span>
        </div>
      </td>
    </tr>
  `;
}

function cbUpdateConsoleStats(prefix, models) {
  const list = Array.isArray(models) ? models : [];
  // Buddy 固定 vendor=user，按 url/name 统计，避免供应商数恒为 1。
  const providerCount = new Set(list.map((m) => {
    if (String(m?.vendor || '') === 'user') return String(m?.url || m?.name || m?.id || 'Custom');
    return String(m?.vendor || m?.url || 'Custom');
  }).filter(Boolean)).size;
  const capCount = list.reduce((total, model) =>
    total + (model?.supportsToolCall ? 1 : 0) + (model?.supportsImages ? 1 : 0) + (model?.supportsReasoning ? 1 : 0),
    0
  );
  platformSetText(`${prefix}-console-count`, String(list.length));
  platformSetText(`${prefix}-console-provider-count`, String(providerCount));
  platformSetText(`${prefix}-console-cap-count`, String(capCount));
  // 更新标题旁的模型计数文字
  platformSetText(`${prefix}-model-count`, `共 ${list.length} 个`);
}

function cbButtonLabelEl(btn) {
  return btn?.querySelector('.model-action-label') || btn?.querySelector('span:last-child') || btn?.lastChild || null;
}

function cbGetButtonLabel(btn) {
  const label = cbButtonLabelEl(btn);
  return label ? label.textContent : '';
}

function cbSetButtonLabel(btn, text) {
  const label = cbButtonLabelEl(btn);
  if (label) label.textContent = text;
}

function onCbModelSearch() { renderCodeBuddyModels(); }
function onWbModelSearch() { renderWbModels(); }
function onZcModelSearch() { renderZcModels(); }

function cbSelectionSet(prefix) {
  if (!cbSelectedModelIds[prefix]) cbSelectedModelIds[prefix] = new Set();
  return cbSelectedModelIds[prefix];
}

function cbModelListRef(prefix) {
  if (prefix === 'Cb') {
    return {
      domPrefix: 'cb',
      getModels: () => cbModels,
      setModels: (models) => { cbModels = models; },
      getAvailable: () => cbAvailableModels,
      setAvailable: (available) => { cbAvailableModels = available; },
      render: renderCodeBuddyModels,
      save: saveCodeBuddyModels,
    };
  }
  if (prefix === 'Zc') {
    return {
      domPrefix: 'zc',
      getModels: () => zcModels,
      setModels: (models) => { zcModels = models; },
      getAvailable: () => zcAvailableModels,
      setAvailable: (available) => { zcAvailableModels = available; },
      render: renderZcModels,
      save: saveZcModels,
    };
  }
  if (MANAGED_MODEL_PLATFORM_IDS[prefix]) {
    const id = prefix.toLowerCase();
    return {
      domPrefix: id,
      getModels: () => globalThis[`${id}Models`],
      setModels: (models) => { globalThis[`${id}Models`] = models; },
      getAvailable: () => globalThis[`${id}AvailableModels`],
      setAvailable: (available) => { globalThis[`${id}AvailableModels`] = available; },
      render: globalThis[`render${prefix}Models`],
      save: globalThis[`save${prefix}Models`],
    };
  }
  return {
    domPrefix: 'wb',
    getModels: () => wbModels,
    setModels: (models) => { wbModels = models; },
    getAvailable: () => wbAvailableModels,
    setAvailable: (available) => { wbAvailableModels = available; },
    render: renderWbModels,
    save: saveWbModels,
  };
}

function cbSelectedVisibleEntries(prefix) {
  const ref = cbModelListRef(prefix);
  return cbFilteredModelEntries(ref.getModels(), ref.domPrefix);
}

function cbPruneSelection(prefix) {
  const ref = cbModelListRef(prefix);
  const ids = new Set(ref.getModels().map(model => cbModelSelectionKey(prefix, model)).filter(Boolean));
  const selected = cbSelectionSet(prefix);
  Array.from(selected).forEach(id => {
    if (!ids.has(id)) selected.delete(id);
  });
}

function cbSyncSelectionState(prefix) {
  cbPruneSelection(prefix);
  const ref = cbModelListRef(prefix);
  const selected = cbSelectionSet(prefix);
  const visibleEntries = cbSelectedVisibleEntries(prefix);
  const visibleIds = visibleEntries.map(({ model }) => cbModelSelectionKey(prefix, model)).filter(Boolean);
  const visibleSelected = visibleIds.filter(id => selected.has(id)).length;
  const domPrefix = ref.domPrefix;
  const selectAll = document.getElementById(`${domPrefix}-select-all`);
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
    selectAll.disabled = visibleIds.length === 0;
  }
  const btn = document.getElementById(`${domPrefix}-delete-selected-btn`);
  if (btn) {
    const count = selected.size;
    btn.disabled = count === 0;
    const label = btn.querySelector('.cb-bulk-delete-label');
    if (label) label.textContent = count ? `删除选中 (${count})` : '删除选中';
  }
}

function toggleCbModelSelection(prefix, index, checked) {
  const ref = cbModelListRef(prefix);
  const model = ref.getModels()[index];
  const id = cbModelSelectionKey(prefix, model);
  if (!id) return;
  const selected = cbSelectionSet(prefix);
  if (checked) selected.add(id);
  else selected.delete(id);
  cbSyncSelectionState(prefix);
}

function toggleCbModelSelectAll(prefix, checked) {
  const selected = cbSelectionSet(prefix);
  cbSelectedVisibleEntries(prefix).forEach(({ model }) => {
    const id = cbModelSelectionKey(prefix, model);
    if (!id) return;
    if (checked) selected.add(id);
    else selected.delete(id);
  });
  cbModelListRef(prefix).render();
}

async function cbPersistModelDeletion(prefix, previousModels, previousAvailable, deletedCount) {
  const ref = cbModelListRef(prefix);
  try {
    await ref.save({ silent: true, throwOnError: true });
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已删除 ${deletedCount} 个模型`, 'success');
    }
  } catch (e) {
    ref.setModels(previousModels);
    ref.setAvailable(previousAvailable);
    ref.render();
    showCustomAlert(`保存失败，已恢复删除前状态：${e}`, '保存失败', 'error');
  }
}

async function cbDeleteModelByIndex(prefix, index) {
  const ref = cbModelListRef(prefix);
  const models = ref.getModels();
  const model = models[index];
  if (!model) return;
  const previousModels = models.slice();
  const previousAvailable = ref.getAvailable().slice();
  const id = String(model.id || '');
  const selectionKey = cbModelSelectionKey(prefix, model);
  ref.setAvailable(cbRemoveAvailableModel(ref.getAvailable(), id));
  models.splice(index, 1);
  cbSelectionSet(prefix).delete(selectionKey);
  ref.render();
  await cbPersistModelDeletion(prefix, previousModels, previousAvailable, 1);
}

async function cbDeleteSelectedModels(prefix) {
  const ref = cbModelListRef(prefix);
  const selected = cbSelectionSet(prefix);
  if (!selected.size) return;
  const selectedIds = new Set(selected);
  const previousModels = ref.getModels().slice();
  const previousAvailable = ref.getAvailable().slice();
  const deletedCount = selectedIds.size;
  const nextModels = ref.getModels().filter(model => !selectedIds.has(cbModelSelectionKey(prefix, model)));
  ref.setModels(nextModels);
  if (prefix === 'Zc') {
    ref.setAvailable(cbMergeAvailableModels([], nextModels));
  } else {
    ref.setAvailable(cbUniqueStrings(ref.getAvailable()).filter(id => !selectedIds.has(String(id || ''))));
  }
  selected.clear();
  ref.render();
  await cbPersistModelDeletion(prefix, previousModels, previousAvailable, deletedCount);
}

function deleteSelectedCbModels() { cbDeleteSelectedModels('Cb'); }
function deleteSelectedWbModels() { cbDeleteSelectedModels('Wb'); }
function deleteSelectedZcModels() { cbDeleteSelectedModels('Zc'); }

async function copyCbModelId(cls, index) {
  const model = cbModelsByClass(cls)[index];
  const id = model?.id || '';
  if (!id) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(id);
    } else {
      const ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showCustomAlert(`已复制 ${id}`, '已复制', 'success');
  } catch (e) {
    showCustomAlert(String(e), '复制失败', 'error');
  }
}

function cbModelRow(model, index) {
  return cbRowFactory(model, index);
}

async function loadCodeBuddyModels() {
  if (!invoke) return;
  try {
    if (tencentBuddySyncEnabled) {
      await syncTencentBuddyModels(CB_PLATFORM, { silent: true });
      if (typeof addLog === 'function') addLog('ok', 'CodeBuddy 打开时已自动同步 WorkBuddy');
      return;
    }
    const data = await invoke('load_codebuddy_models', { platform: CB_PLATFORM });
    const rawModels = Array.isArray(data.models) ? data.models : [];
    cbModels = cbNormalizeModelsContext(normalizeBuddyModelsForPlatform(rawModels, CB_PLATFORM));
    cbAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('cb', data, '~/.codebuddy/models.json');
    cbConfigScope = meta.scope;
    cbConfigPath = meta.path;
    renderCodeBuddyModels();
    // 历史默认 128K 升级，或 vendor 需迁移为 user 时，静默写回配置
    const upgraded = rawModels.some((m, i) => {
      const before = m?.maxInputTokens;
      const after = cbModels[i]?.maxInputTokens;
      return before !== after || String(m?.vendor || '') !== 'user';
    });
    if (upgraded) {
      await saveCodeBuddyModels({ silent: true });
    }
    if (typeof addLog === 'function') addLog('ok', 'CodeBuddy 模型列表已加载');
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步 CodeBuddy / WorkBuddy' : '加载 CodeBuddy 模型';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '加载失败', 'error');
  }
}

function renderCodeBuddyModels() {
  const tbody = document.getElementById('cb-model-tbody');
  const empty = document.getElementById('cb-model-empty');
  const table = document.getElementById('cb-model-table');
  if (!tbody) return;
  cbUpdateConsoleStats('cb', cbModels);

  if (!cbModels.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    cbSyncSelectionState('Cb');
    syncTencentBuddySyncButtons();
    return;
  }

  const entries = cbFilteredModelEntries(cbModels, 'cb');
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';
  tbody.innerHTML = entries.length
    ? entries.map(({ model, index }) => cbModelRow(model, index)).join('')
    : cbNoResultRow('cb');
  cbSyncSelectionState('Cb');
  syncTencentBuddySyncButtons();
}

function editCbModel(index) { openCbEditModal('Cb', index); }
function cancelCbEdit() { closeCbEditModal(); }
function saveCbEdit(index) { saveCbEditFromModal(index); }

function deleteCbModel(index) {
  cbDeleteModelByIndex('Cb', index);
}

async function toggleCbModelEnabled(index, checked) {
  const model = cbModels[index];
  if (!model) return;
  const previous = model.enabled !== false;
  model.enabled = checked;
  renderCodeBuddyModels();
  const saved = await saveCodeBuddyModels({ silent: true });
  if (!saved) {
    model.enabled = previous;
    renderCodeBuddyModels();
  }
}

async function saveCodeBuddyModels(options = {}) {
  if (!invoke) {
    const error = new Error('当前环境缺少 Tauri invoke，无法保存 CodeBuddy 配置');
    if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
    if (options.throwOnError) throw error;
    return false;
  }
  try {
    cbAvailableModels = cbMergeAvailableModels(cbAvailableModels, cbModels);
    if (tencentBuddySyncEnabled && !options.skipBuddySync) {
      const result = await syncTencentBuddyModels(CB_PLATFORM, {
        useCurrentPrimary: true,
        silent: true,
      });
      if (!options.silent) {
        showCustomAlert(`配置已同步保存到 ${result.paths.codebuddy} 与 ${result.paths.workbuddy}`, '保存成功', 'success');
      }
      return result.paths.codebuddy;
    }
    const path = await invoke('save_codebuddy_models', {
      platform: CB_PLATFORM,
      models: normalizeBuddyModelsForPlatform(cbModels, CB_PLATFORM),
      availableModels: cbAvailableModels,
      scope: cbConfigScope,
    });
    cbConfigPath = path;
    const meta = cbApplyConfigMeta('cb', { _configPath: path, _configScope: cbConfigScope }, path);
    cbConfigScope = meta.scope;
    if (typeof addLog === 'function') addLog('ok', `CodeBuddy 配置已保存到 ${path}`);
    if (!options.silent) showCustomAlert(`配置已保存到 ${path}`, '保存成功', 'success');
    return path;
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步保存 CodeBuddy / WorkBuddy 配置' : '保存 CodeBuddy 配置';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    if (!options.silent) showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '保存失败', 'error');
    if (options.throwOnError) throw e;
    return false;
  }
}

// ─── 添加模型 · 独立页面版 ───

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cbModelsByClass = cbModelsByClass;
  g.cbModelMatches = cbModelMatches;
  g.cbFilteredModelEntries = cbFilteredModelEntries;
  g.cbNoResultRow = cbNoResultRow;
  g.cbUpdateConsoleStats = cbUpdateConsoleStats;
  g.cbButtonLabelEl = cbButtonLabelEl;
  g.cbGetButtonLabel = cbGetButtonLabel;
  g.cbSetButtonLabel = cbSetButtonLabel;
  g.onCbModelSearch = onCbModelSearch;
  g.onWbModelSearch = onWbModelSearch;
  g.onZcModelSearch = onZcModelSearch;
  g.cbSelectionSet = cbSelectionSet;
  g.cbModelListRef = cbModelListRef;
  g.cbSelectedVisibleEntries = cbSelectedVisibleEntries;
  g.cbPruneSelection = cbPruneSelection;
  g.cbSyncSelectionState = cbSyncSelectionState;
  g.toggleCbModelSelection = toggleCbModelSelection;
  g.toggleCbModelSelectAll = toggleCbModelSelectAll;
  g.cbPersistModelDeletion = cbPersistModelDeletion;
  g.cbDeleteModelByIndex = cbDeleteModelByIndex;
  g.cbDeleteSelectedModels = cbDeleteSelectedModels;
  g.deleteSelectedCbModels = deleteSelectedCbModels;
  g.deleteSelectedWbModels = deleteSelectedWbModels;
  g.deleteSelectedZcModels = deleteSelectedZcModels;
  g.copyCbModelId = copyCbModelId;
  g.cbModelRow = cbModelRow;
  g.loadCodeBuddyModels = loadCodeBuddyModels;
  g.renderCodeBuddyModels = renderCodeBuddyModels;
  g.editCbModel = editCbModel;
  g.cancelCbEdit = cancelCbEdit;
  g.saveCbEdit = saveCbEdit;
  g.deleteCbModel = deleteCbModel;
  g.toggleCbModelEnabled = toggleCbModelEnabled;
  g.saveCodeBuddyModels = saveCodeBuddyModels;
})(globalThis);
