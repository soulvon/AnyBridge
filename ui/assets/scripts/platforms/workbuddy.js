// platforms/workbuddy.js — split from 55-platforms.js
// ═══════ WorkBuddy 自定义模型管理 ═══════

globalThis.wbModels = [];
globalThis.wbAvailableModels = [];
globalThis.wbConfigScope = 'user';
globalThis.wbConfigPath = '~/.workbuddy/models.json';
globalThis.wbProviderModels = [];
globalThis.wbEditingIndex = -1;
globalThis.wbAddSelectedProvider = null;
globalThis.wbAddSearchKw = '';

function wbModelRow(model, index) {
  return wbRowFactory(model, index);
}

async function loadWbModels() {
  if (!invoke) return;
  try {
    if (tencentBuddySyncEnabled) {
      await syncTencentBuddyModels(WB_PLATFORM, { silent: true });
      if (typeof addLog === 'function') addLog('ok', 'WorkBuddy 打开时已自动同步 CodeBuddy');
      return;
    }
    const data = await invoke('load_codebuddy_models', { platform: WB_PLATFORM });
    const rawModels = Array.isArray(data.models) ? data.models : [];
    wbModels = cbNormalizeModelsContext(normalizeBuddyModelsForPlatform(rawModels, WB_PLATFORM));
    wbAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('wb', data, '~/.workbuddy/models.json');
    wbConfigScope = meta.scope;
    wbConfigPath = meta.path;
    renderWbModels();
    // 历史默认 128K 升级，或 vendor 需迁移为 user 时，静默写回配置
    const upgraded = rawModels.some((m, i) => {
      const before = m?.maxInputTokens;
      const after = wbModels[i]?.maxInputTokens;
      return before !== after || String(m?.vendor || '') !== 'user';
    });
    if (upgraded) {
      await saveWbModels({ silent: true });
    }
    if (typeof addLog === 'function') addLog('ok', 'WorkBuddy 模型列表已加载');
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步 CodeBuddy / WorkBuddy' : '加载 WorkBuddy 模型';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '加载失败', 'error');
  }
}

function renderWbModels() {
  const tbody = document.getElementById('wb-model-tbody');
  const empty = document.getElementById('wb-model-empty');
  const table = document.getElementById('wb-model-table');
  if (!tbody) return;
  cbUpdateConsoleStats('wb', wbModels);

  if (!wbModels.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    cbSyncSelectionState('Wb');
    syncTencentBuddySyncButtons();
    return;
  }

  const entries = cbFilteredModelEntries(wbModels, 'wb');
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';
  tbody.innerHTML = entries.length
    ? entries.map(({ model, index }) => wbModelRow(model, index)).join('')
    : cbNoResultRow('wb');
  cbSyncSelectionState('Wb');
  syncTencentBuddySyncButtons();
}

function editWbModel(index) { openCbEditModal('Wb', index); }
function cancelWbEdit() { closeCbEditModal(); }
function saveWbEdit(index) { saveCbEditFromModal(index); }

function deleteWbModel(index) {
  cbDeleteModelByIndex('Wb', index);
}

async function toggleWbModelEnabled(index, checked) {
  const model = wbModels[index];
  if (!model) return;
  const previous = model.enabled !== false;
  model.enabled = checked;
  renderWbModels();
  const saved = await saveWbModels({ silent: true });
  if (!saved) {
    model.enabled = previous;
    renderWbModels();
  }
}

async function saveWbModels(options = {}) {
  if (!invoke) {
    const error = new Error('当前环境缺少 Tauri invoke，无法保存 WorkBuddy 配置');
    if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
    if (options.throwOnError) throw error;
    return false;
  }
  try {
    wbModels = normalizeBuddyModelsForPlatform(wbModels, WB_PLATFORM);
    wbAvailableModels = cbMergeAvailableModels(wbAvailableModels, wbModels);
    if (tencentBuddySyncEnabled && !options.skipBuddySync) {
      const result = await syncTencentBuddyModels(WB_PLATFORM, {
        useCurrentPrimary: true,
        silent: true,
      });
      if (!options.silent) {
        showCustomAlert(`配置已同步保存到 ${result.paths.codebuddy} 与 ${result.paths.workbuddy}`, '保存成功', 'success');
      }
      return result.paths.workbuddy;
    }
    const path = await invoke('save_codebuddy_models', {
      platform: WB_PLATFORM,
      models: wbModels,
      availableModels: wbAvailableModels,
      scope: wbConfigScope,
    });
    wbConfigPath = path;
    const meta = cbApplyConfigMeta('wb', { _configPath: path, _configScope: wbConfigScope }, path);
    wbConfigScope = meta.scope;
    if (typeof addLog === 'function') addLog('ok', `WorkBuddy 配置已保存到 ${path}`);
    if (!options.silent) showCustomAlert(`配置已保存到 ${path}`, '保存成功', 'success');
    return path;
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步保存 CodeBuddy / WorkBuddy 配置' : '保存 WorkBuddy 配置';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    if (!options.silent) showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '保存失败', 'error');
    if (options.throwOnError) throw e;
    return false;
  }
}

const wbAddApi = createBuddyAddHandlers({
  prefix: 'Wb',
  domPrefix: 'wb',
  platformId: WB_PLATFORM,
  pageSlug: 'workbuddy',
  cssPrefix: 'wb',
  openModalName: 'openWbAddModal',
  closeModalName: 'closeWbAddModal',
  providerChangeName: 'onWbAddProviderChange',
  legacyConfirmName: 'confirmAddWbModels',
  confirmPageName: 'confirmAddWbModelsPage',
  renderModelsFnName: 'renderWbModels',
  saveModelsFnName: 'saveWbModels',
});

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.wbModelRow = wbModelRow;
  g.loadWbModels = loadWbModels;
  g.renderWbModels = renderWbModels;
  g.editWbModel = editWbModel;
  g.cancelWbEdit = cancelWbEdit;
  g.saveWbEdit = saveWbEdit;
  g.deleteWbModel = deleteWbModel;
  g.toggleWbModelEnabled = toggleWbModelEnabled;
  g.saveWbModels = saveWbModels;
  g.openWbAddModal = wbAddApi.openModal;
  g.closeWbAddModal = wbAddApi.closeModal;
  g.onWbAddProviderChange = wbAddApi.onProviderChange;
  g.confirmAddWbModels = wbAddApi.legacyConfirm;
  g.initWbAddPage = wbAddApi.initPage;
  g.onWbAddSearch = wbAddApi.onSearch;
  g.renderWbAddProviderList = wbAddApi.renderProviderList;
  g.selectWbAddProvider = wbAddApi.selectProvider;
  g.renderWbAddModels = wbAddApi.renderModels;
  g.updateWbAddConfirmButton = wbAddApi.updateConfirmButton;
  g.wbAddSelectAll = wbAddApi.selectAll;
  g.wbAddSelectNone = wbAddApi.selectNone;
  g.confirmAddWbModelsPage = wbAddApi.confirmPage;
})(globalThis);
