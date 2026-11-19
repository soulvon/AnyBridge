// platforms/zcode.js — split from 55-platforms.js
// ═══════ ZCode 自定义模型管理 ═══════

globalThis.zcModels = [];
globalThis.zcAvailableModels = [];
globalThis.zcConfigScope = 'user';
globalThis.zcConfigPath = '~/.zcode/v2/config.json';
globalThis.zcProviderModels = [];
globalThis.zcEditingIndex = -1;
globalThis.zcAddSelectedProvider = null;
globalThis.zcAddSearchKw = '';

globalThis.ZC_PLATFORM = 'zcode';

function zcModelRow(model, index) {
  return zcRowFactory(model, index);
}

async function loadZcModels() {
  if (!invoke) return;
  try {
    const data = await invoke('load_codebuddy_models', { platform: ZC_PLATFORM });
    const rawModels = Array.isArray(data.models) ? data.models : [];
    zcModels = cbNormalizeModelsContext(rawModels);
    zcAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('zc', data, '~/.zcode/v2/config.json');
    zcConfigScope = meta.scope;
    zcConfigPath = meta.path;
    renderZcModels();
    const upgraded = rawModels.some((m, i) => {
      const before = m?.maxInputTokens;
      const after = zcModels[i]?.maxInputTokens;
      return before !== after;
    });
    if (upgraded) {
      await saveZcModels({ silent: true });
    }
    if (typeof addLog === 'function') addLog('ok', 'ZCode 模型列表已加载');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '加载 ZCode 模型失败: ' + e);
    showCustomAlert(String(e), '加载失败', 'error');
  }
}

function renderZcModels() {
  const tbody = document.getElementById('zc-model-tbody');
  const empty = document.getElementById('zc-model-empty');
  const table = document.getElementById('zc-model-table');
  if (!tbody) return;
  cbUpdateConsoleStats('zc', zcModels);

  if (!zcModels.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    cbSyncSelectionState('Zc');
    return;
  }

  const entries = cbFilteredModelEntries(zcModels, 'zc');
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';
  tbody.innerHTML = entries.length
    ? entries.map(({ model, index }) => zcModelRow(model, index)).join('')
    : cbNoResultRow('zc');
  cbSyncSelectionState('Zc');
}

function editZcModel(index) { openCbEditModal('Zc', index); }
function cancelZcEdit() { closeCbEditModal(); }
function saveZcEdit(index) { saveCbEditFromModal(index); }

function deleteZcModel(index) {
  cbDeleteModelByIndex('Zc', index);
}

async function toggleZcModelEnabled(index, checked) {
  const model = zcModels[index];
  if (!model) return;
  const previous = model.enabled !== false;
  model.enabled = checked;
  renderZcModels();
  const saved = await saveZcModels({ silent: true });
  if (!saved) {
    model.enabled = previous;
    renderZcModels();
  }
}

async function saveZcModels(options = {}) {
  if (!invoke) {
    const error = new Error('当前环境缺少 Tauri invoke，无法保存 ZCode 配置');
    if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
    if (options.throwOnError) throw error;
    return false;
  }
  try {
    zcAvailableModels = cbMergeAvailableModels(zcAvailableModels, zcModels);
    const path = await invoke('save_codebuddy_models', {
      platform: ZC_PLATFORM,
      models: zcModels,
      availableModels: zcAvailableModels,
      scope: zcConfigScope,
    });
    zcConfigPath = path;
    const meta = cbApplyConfigMeta('zc', { _configPath: path, _configScope: zcConfigScope }, path);
    zcConfigScope = meta.scope;
    if (typeof addLog === 'function') addLog('ok', `ZCode 配置已保存到 ${path}，并同步写入 CLI 配置`);
    if (!options.silent) showCustomAlert(`配置已保存到 ${path}，并同步写入 ~/.zcode/cli/config.json`, '保存成功', 'success');
    return path;
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '保存 ZCode 配置失败: ' + e);
    if (!options.silent) showCustomAlert(String(e), '保存失败', 'error');
    if (options.throwOnError) throw e;
    return false;
  }
}

const zcAddApi = createBuddyAddHandlers({
  prefix: 'Zc',
  domPrefix: 'zc',
  platformId: ZC_PLATFORM,
  pageSlug: 'zcode',
  cssPrefix: 'wb',
  extraCssPrefix: 'zc',
  openModalName: 'openZcAddModal',
  closeModalName: 'closeZcAddModal',
  providerChangeName: 'onZcAddProviderChange',
  legacyConfirmName: 'confirmAddZcModels',
  confirmPageName: 'confirmAddZcModelsPage',
  renderModelsFnName: 'renderZcModels',
  saveModelsFnName: 'saveZcModels',
  buildExistsPredicate: (provider, currentModels) => {
    const zcodeProviderId = zcProviderIdForProvider(provider);
    return (m) => currentModels.some((model) => zcProviderModelKey(model) === zcProviderModelKeyParts(zcodeProviderId, m.id));
  },
});

// ═══════ ZCode JSON 编辑器：原生嵌套格式（覆盖通用工厂） ═══════
// ZCode 配置采用 provider → {providerId → {name, kind, options, source, models: {modelId: meta}}} 嵌套结构，
// 重写 toggle/apply 让 JSON 编辑器展示真实配置格式，而非 CodeBuddy 扁平 models[] 数组。

function zcFlatToNative(models) {
  const providers = {};
  for (const model of (models || [])) {
    const baseURL = zcNormalizeBaseUrl(model.url || '');
    const pid = zcProviderIdForModel({ ...model, url: baseURL });
    if (!providers[pid]) {
      providers[pid] = {
        name: model.vendor || 'Custom',
        kind: 'openai-compatible',
        options: {
          apiKey: model.apiKey || '',
          baseURL,
          apiKeyRequired: true,
        },
        source: 'custom',
        models: {},
      };
    }
    const input = model.supportsImages ? ['text', 'image'] : ['text'];
    const limit = { context: model.maxInputTokens || cbRecommendContextWindow(model.id) };
    if (model.maxOutputTokens) limit.output = model.maxOutputTokens;
    const meta = { name: model.name || model.id, limit, modalities: { input, output: ['text'] } };
    if (model.supportsReasoning) {
      meta.reasoning = {
        enabled: true,
        variants: ['enabled', 'off'],
        defaultVariant: 'enabled',
      };
    }
    providers[pid].models[model.id] = meta;
  }
  return { $schema: 'https://zcode.z.ai/config.json', provider: providers };
}

function zcReasoningEnabled(meta) {
  const reasoning = meta?.reasoning;
  if (typeof reasoning === 'boolean') return reasoning;
  if (reasoning && typeof reasoning === 'object') return reasoning.enabled !== false;
  return false;
}

function zcNativeToFlat(config) {
  const models = [];
  const providers = (config && config.provider) || {};
  for (const [pid, prov] of Object.entries(providers)) {
    if (prov.kind !== 'openai-compatible') continue;
    if ((prov.source || '') === 'builtin' || pid.startsWith('builtin:')) continue;
    const opts = prov.options || {};
    const baseURL = zcNormalizeBaseUrl(opts.baseURL || opts.baseUrl || '');
    const provModels = prov.models || {};
    for (const [mid, meta] of Object.entries(provModels)) {
      const inputArr = (meta.modalities && meta.modalities.input) || ['text'];
      const limit = meta.limit || {};
      models.push({
        id: mid,
        name: meta.name || mid,
        vendor: prov.name || 'Custom',
        url: baseURL,
        apiKey: opts.apiKey || '',
        providerId: zcProviderIdForModel({
          providerId: pid,
          vendor: prov.name || 'Custom',
          url: baseURL,
          apiKey: opts.apiKey || '',
        }),
        maxInputTokens: limit.context || cbRecommendContextWindow(mid),
        maxOutputTokens: limit.output || undefined,
        supportsImages: inputArr.includes('image'),
        supportsReasoning: zcReasoningEnabled(meta),
        supportsToolCall: false,
        enabled: prov.enabled !== false && meta.enabled !== false,
      });
    }
  }
  return models;
}

function zcPayloadToFlat(data) {
  if (data && data.provider && typeof data.provider === 'object') return zcNativeToFlat(data);
  return Array.isArray(data?.models) ? data.models.map(model => {
    const next = {
      ...model,
      url: zcNormalizeBaseUrl(model.url || model.baseURL || model.baseUrl || ''),
    };
    return {
      ...next,
      providerId: zcProviderIdForModel(next),
    };
  }) : [];
}

// 覆盖：JSON 编辑器展开时显示 ZCode 原生嵌套格式
window.toggleZcJsonEditor = function() {
  const jsonView = document.getElementById('zc-json-view');
  if (!jsonView) return;
  const isHidden = jsonView.style.display === 'none';
  if (isHidden) {
    const listView = document.getElementById('zc-list-view');
    const native = zcFlatToNative(zcModels);
    const editor = document.getElementById('zc-json-editor');
    if (editor) editor.value = JSON.stringify(native, null, 2);
    const errEl = document.getElementById('zc-json-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (listView) listView.style.display = 'none';
    jsonView.style.display = 'block';
    const btn = document.querySelector('[data-json-toggle="zc"]');
    if (btn) { btn.classList.add('is-active'); btn.setAttribute('aria-pressed', 'true'); }
  } else {
    jsonView.style.display = 'none';
    const listView = document.getElementById('zc-list-view');
    if (listView) listView.style.display = '';
    const btn = document.querySelector('[data-json-toggle="zc"]');
    if (btn) { btn.classList.remove('is-active'); btn.setAttribute('aria-pressed', 'false'); }
    renderZcModels();
  }
};

// 覆盖：应用 JSON 编辑器时解析 ZCode 原生格式回扁平结构
window.applyZcJson = function() {
  const editor = document.getElementById('zc-json-editor');
  const errEl = document.getElementById('zc-json-error');
  if (!editor) return;
  try {
    const data = JSON.parse(editor.value);
    const models = zcPayloadToFlat(data);
    zcModels = models;
    zcAvailableModels = models.map(m => m.id).filter(Boolean);
    document.getElementById('zc-json-view').style.display = 'none';
    const listView = document.getElementById('zc-list-view');
    if (listView) listView.style.display = '';
    const btn = document.querySelector('[data-json-toggle="zc"]');
    if (btn) { btn.classList.remove('is-active'); btn.setAttribute('aria-pressed', 'false'); }
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    renderZcModels();
    showCustomAlert(`已从 JSON 编辑器应用 ${models.length} 个模型`, '应用成功', 'success');
  } catch (err) {
    if (errEl) { errEl.style.display = ''; errEl.textContent = 'JSON 语法错误：' + err.message; }
  }
};

// 覆盖导出：输出 ZCode 原生嵌套格式
window.exportZcModels = function() {
  const native = zcFlatToNative(zcModels);
  const json = JSON.stringify(native, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'zcode-config.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  if (typeof addLog === 'function') addLog('ok', 'ZCode 配置已导出（原生格式）');
};

window.importZcModels = function(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const incoming = zcPayloadToFlat(data);
      if (!incoming.length) {
        showCustomAlert('导入文件中没有可识别的 ZCode provider/models 配置', '导入失败', 'warn');
        return;
      }
      const existingIds = new Set(zcModels.map(zcProviderModelKey).filter(Boolean));
      let added = 0;
      incoming.forEach(model => {
        const key = zcProviderModelKey(model);
        if (!model.id || !key || existingIds.has(key)) return;
        existingIds.add(key);
        zcModels.push(model);
        added++;
      });
      zcAvailableModels = cbMergeAvailableModels(zcAvailableModels, zcModels);
      renderZcModels();
      showCustomAlert(
        `导入完成：${incoming.length} 个模型中有 ${added} 个新增（${incoming.length - added} 个重复已跳过）`,
        '导入结果',
        added > 0 ? 'success' : 'info'
      );
    } catch (err) {
      showCustomAlert('JSON 解析失败：' + err.message, '导入失败', 'error');
    }
  };
  reader.readAsText(file);
};

window.zcDrop = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('zc-drop-zone');
  if (zone) zone.classList.remove('drag-over');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const file = files[0];
  if (!file.name.endsWith('.json')) {
    showCustomAlert('请拖入 .json 文件', '格式不支持', 'warn');
    return;
  }
  window.importZcModels({ target: { files: [file], value: '' } });
};

// ---- P3 globalThis mirror (functions/classes) ----

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.zcModelRow = zcModelRow;
  g.loadZcModels = loadZcModels;
  g.renderZcModels = renderZcModels;
  g.editZcModel = editZcModel;
  g.cancelZcEdit = cancelZcEdit;
  g.saveZcEdit = saveZcEdit;
  g.deleteZcModel = deleteZcModel;
  g.toggleZcModelEnabled = toggleZcModelEnabled;
  g.saveZcModels = saveZcModels;
  g.openZcAddModal = zcAddApi.openModal;
  g.closeZcAddModal = zcAddApi.closeModal;
  g.onZcAddProviderChange = zcAddApi.onProviderChange;
  g.confirmAddZcModels = zcAddApi.legacyConfirm;
  g.initZcAddPage = zcAddApi.initPage;
  g.onZcAddSearch = zcAddApi.onSearch;
  g.renderZcAddProviderList = zcAddApi.renderProviderList;
  g.selectZcAddProvider = zcAddApi.selectProvider;
  g.renderZcAddModels = zcAddApi.renderModels;
  g.updateZcAddConfirmButton = zcAddApi.updateConfirmButton;
  g.zcAddSelectAll = zcAddApi.selectAll;
  g.zcAddSelectNone = zcAddApi.selectNone;
  g.confirmAddZcModelsPage = zcAddApi.confirmPage;
  g.zcFlatToNative = zcFlatToNative;
  g.zcReasoningEnabled = zcReasoningEnabled;
  g.zcNativeToFlat = zcNativeToFlat;
  g.zcPayloadToFlat = zcPayloadToFlat;
})(globalThis);
