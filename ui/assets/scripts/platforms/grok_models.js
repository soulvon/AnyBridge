// platforms/grok_models.js — Grok 模型目录管理、子代理模型覆盖与远程拉取
// ── Grok 模型管理（多模型注册，交互对齐 Codex 配置页） ──

function grokConfigSetModelStatus(text, tone = '') {
  const el = document.getElementById('grok-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone || '';
}

function grokConfigSetFetchLoading(loading) {
  setConfigFetchButtonLoading('grok-config-fetch-models-btn', loading);
}

function setGrokModelEntriesState(entries) {
  grokModelEntriesState = (Array.isArray(entries) ? entries : []).map(e => ({ ...e }));
}

function getGrokModelEntries() {
  if (grokModelEntriesState.length) {
    return grokModelEntriesState.map(e => ({ ...e }));
  }
  const container = document.getElementById('grok-config-model-list');
  if (!container) return [];
  const entries = [];
  for (const row of container.querySelectorAll('.codex-config-model-option[data-idx]')) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    const model = row.dataset.model || '';
    if (!checkbox || !model) continue;
    const entry = { model, inCatalog: checkbox.checked, isDefault: row.classList.contains('active') };
    const displayName = row.dataset.display || '';
    if (displayName) entry.displayName = displayName;
    const ctx = Number(row.dataset.ctx || '');
    if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx;
    entries.push(entry);
  }
  return entries;
}

function grokEntryContext(entry) {
  const n = Number(entry?.contextWindow);
  if (Number.isFinite(n) && n > 0) return n;
  return grokRecommendContextWindow(entry?.model || '');
}

/** 已勾选注册的模型项 */
function grokRegisteredEntries() {
  return getGrokModelEntries().filter(e => e.inCatalog && e.model);
}

function renderGrokModelManager(entries, defaultModel = '', status = '') {
  const container = document.getElementById('grok-config-model-list');
  if (!container) return;
  const list = Array.isArray(entries) ? entries : [];
  if (defaultModel) {
    list.forEach(e => { e.isDefault = e.inCatalog && e.model === defaultModel; });
  }
  setGrokModelEntriesState(list);

  if (!list.length) {
    container.innerHTML = '<div class="codex-config-model-empty">还没有模型，点击右上角拉取或手动添加。</div>';
    grokConfigSetModelStatus(status || '选择供应商后拉取模型列表');
    renderGrokSubagentRows();
    syncGrokRawConfigFromFields();
    return;
  }

  const inCat = list.filter(e => e.inCatalog).length;
  if (!status) {
    grokConfigSetModelStatus(`已保存 ${inCat} 个模型`);
  }

  container.innerHTML = list.map((entry, i) => {
    const model = platformEsc(entry.model || '');
    const displayName = platformEsc(entry.displayName || '');
    const ctx = entry.contextWindow ? platformEsc(cbFormatContextTokens(entry.contextWindow)) : '';
    const checked = entry.inCatalog ? 'checked' : '';
    const isDefault = !!entry.isDefault;
    const activeClass = isDefault ? ' active' : '';
    const defaultBtnClass = isDefault ? 'codex-model-default-btn is-default' : 'codex-model-default-btn';
    const defaultBtnText = isDefault ? '默认 ✓' : '设为默认';
    const defaultBtnClick = isDefault
      ? `selectGrokDefaultModel('')`
      : `selectGrokDefaultModel('${model}')`;
    const icon = typeof renderModelIcon === 'function' ? renderModelIcon(entry.model) : '';
    return `<div class="codex-config-model-option${activeClass}" data-idx="${i}" data-model="${model}" data-display="${displayName}" data-ctx="${entry.contextWindow || ''}">
      <input type="checkbox" ${checked} data-action="toggleGrokModelCatalog" data-events="change" data-args="[${i}]" title="加入模型目录">
      <span class="codex-model-icon-wrap">${icon}</span>
      <span class="codex-model-name" title="${model}">${model}</span>
      ${displayName ? `<span class="codex-model-display-name">${displayName}</span>` : ''}
      ${ctx ? `<span class="codex-model-ctx">${ctx}</span>` : ''}
      <div class="codex-model-actions">
        <button type="button" class="${defaultBtnClass}" data-action-call="${defaultBtnClick}">${defaultBtnText}</button>
        <button type="button" class="codex-config-fetch-btn" data-action="editGrokModelEntry" data-args="[${i}]">编辑</button>
        <button type="button" class="codex-config-catalog-del" data-action="removeGrokModelEntry" data-args="[${i}]">删除</button>
      </div>
    </div>`;
  }).join('');
  if (status) grokConfigSetModelStatus(status);
  // 模型池变化会影响子代理下拉的可选值，跟着刷新
  renderGrokSubagentRows();
  syncGrokRawConfigFromFields();
}

function toggleGrokModelCatalog(idx) {
  if (!grokModelEntriesState[idx]) return;
  grokModelEntriesState[idx].inCatalog = !grokModelEntriesState[idx].inCatalog;
  if (!grokModelEntriesState[idx].inCatalog) grokModelEntriesState[idx].isDefault = false;
  const defaultModel = grokModelEntriesState.find(e => e.isDefault)?.model || '';
  renderGrokModelManager(grokModelEntriesState, defaultModel);
}

function cancelGrokModelEdit() {
  const entries = getGrokModelEntries();
  renderGrokModelManager(entries, entries.find(e => e.isDefault)?.model || '');
}

function selectGrokDefaultModel(model) {
  const entries = getGrokModelEntries();
  const defaultModel = String(model || '').trim();
  entries.forEach(e => { e.isDefault = e.inCatalog && e.model === defaultModel; });
  renderGrokModelManager(entries, defaultModel);
  grokConfigSetModelStatus(defaultModel ? `默认模型：${defaultModel}` : '已清空默认模型', defaultModel ? 'success' : '');
}

function addGrokModelEntry() {
  const entries = getGrokModelEntries();
  entries.push({ model: '', displayName: '', contextWindow: '', inCatalog: true, isDefault: false });
  renderGrokModelManager(entries, entries.find(e => e.isDefault)?.model || '');
  editGrokModelEntry(entries.length - 1);
}

function editGrokModelEntry(idx) {
  const container = document.getElementById('grok-config-model-list');
  if (!container) return;
  const row = container.querySelectorAll('.codex-config-model-option[data-idx]')[idx];
  if (!row) return;
  const entries = getGrokModelEntries();
  const entry = entries[idx];
  if (!entry) return;
  row.classList.remove('active');
  row.innerHTML = `<div class="codex-config-catalog-row" style="width:100%">
    <input class="field-input" placeholder="模型 ID" value="${platformEsc(entry.model)}">
    <input class="field-input" placeholder="显示名（可选）" value="${platformEsc(entry.displayName)}">
    <input class="field-input" placeholder="上下文窗口" value="${platformEsc(String(entry.contextWindow || ''))}">
    <div style="display:flex;gap:4px">
      <button type="button" class="codex-config-fetch-btn" data-action="saveGrokModelEdit" data-args="[${idx}]">确定</button>
      <button type="button" class="codex-config-catalog-del" data-action="cancelGrokModelEdit">取消</button>
    </div>
  </div>`;
  row.querySelector('.field-input')?.focus();
}

function saveGrokModelEdit(idx) {
  const container = document.getElementById('grok-config-model-list');
  if (!container) return;
  const row = container.querySelectorAll('.codex-config-model-option[data-idx]')[idx];
  if (!row) return;
  const entries = getGrokModelEntries();
  const inputs = row.querySelectorAll('.field-input');
  const model = inputs[0]?.value?.trim() || '';
  if (!model) return;
  const ctxStr = inputs[2]?.value?.trim() || '';
  if (ctxStr) {
    const ctx = Number(ctxStr);
    if (!Number.isInteger(ctx) || ctx < 8192) {
      showCustomAlert('上下文窗口必须是 ≥ 8192 的整数（token），或留空使用推荐值。', '无法保存', 'warn');
      return;
    }
    entries[idx].contextWindow = ctx;
  } else {
    delete entries[idx].contextWindow;
  }
  entries[idx].model = model;
  entries[idx].displayName = inputs[1]?.value?.trim() || '';
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderGrokModelManager(entries, defaultModel);
}

function removeGrokModelEntry(idx) {
  const entries = getGrokModelEntries();
  if (!entries[idx]) return;
  entries.splice(idx, 1);
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderGrokModelManager(entries, defaultModel);
}

function batchSetGrokModelCatalog(inCatalog) {
  const entries = getGrokModelEntries();
  if (!entries.length) return;
  entries.forEach(e => {
    e.inCatalog = inCatalog;
    if (!inCatalog) e.isDefault = false;
  });
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderGrokModelManager(entries, defaultModel);
  grokConfigSetModelStatus(inCatalog ? `已加入 ${entries.length} 个模型到目录` : `已清空目录`, inCatalog ? 'success' : '');
  setTimeout(() => renderGrokModelManager(getGrokModelEntries(), grokConfigGetDefaultModel()), 1500);
}

function batchSetGrokDefaultModel() {
  const entries = getGrokModelEntries();
  if (!entries.length) return;
  entries.forEach(e => { e.isDefault = false; });
  renderGrokModelManager(entries, '');
  grokConfigSetModelStatus('已清空默认模型', '');
  setTimeout(() => renderGrokModelManager(getGrokModelEntries(), ''), 1500);
}

function grokConfigGetDefaultModel() {
  const entries = getGrokModelEntries();
  return entries.find(e => e.isDefault)?.model || '';
}

// ── Grok 子代理模型覆盖（[subagents.models]） ──

globalThis.GROK_SUBAGENT_TYPES = [
  { id: 'explore', desc: '只读研究：检索、读文件、grep，不改文件' },
  { id: 'plan', desc: '实施计划：探索代码库后产出方案，不改文件' },
  { id: 'general-purpose', desc: '通用代理：可写文件的全能子代理' },
];

globalThis.grokSubagentModels = {};
globalThis.grokSubagentCustomTypes = [];

function grokSubagentTypeList() {
  const builtinIds = GROK_SUBAGENT_TYPES.map(t => t.id);
  const custom = (grokSubagentCustomTypes || []).filter(id => id && !builtinIds.includes(id));
  return [...GROK_SUBAGENT_TYPES, ...custom.map(id => ({ id, desc: '自定义类型' }))];
}

/** 模型对应的 config.toml 段 key（与后端 apply_grok 的命名规则一致） */
function grokSectionKeyOf(model, defaultModel, baseKey) {
  if (!model) return '';
  return model === defaultModel ? baseKey : `${baseKey}--${grok_sanitize_key(model)}`;
}

function renderGrokSubagentRows() {
  const wrap = document.getElementById('grok-subagent-rows');
  if (!wrap) return;
  const entries = grokRegisteredEntries();
  if (!entries.length) {
    wrap.innerHTML = '<div class="codex-config-model-empty" style="min-height: 72px;">先在「模型管理」里注册模型，再为子代理指定</div>';
    return;
  }
  const defaultModel = entries.find(e => e.isDefault)?.model || entries[0].model;
  const editId = document.getElementById('grok-config-edit-id')?.value.trim();
  const name = document.getElementById('grok-config-name')?.value.trim();
  const baseKey = grok_sanitize_key(editId || name || 'custom');
  const items = entries.map(e => ({
    id: grokSectionKeyOf(e.model, defaultModel, baseKey),
    label: e.model,
  }));

  const types = grokSubagentTypeList();
  wrap.innerHTML = types.map(type => {
    const isCustom = !GROK_SUBAGENT_TYPES.some(t => t.id === type.id);
    return `
      <div class="grok-subagent-row" data-agent="${platformEsc(type.id)}" style="display: grid; grid-template-columns: minmax(140px, 1fr) minmax(220px, 1.5fr) 64px; gap: 12px; align-items: center;">
        <div>
          <div style="font-size: 12.5px; font-weight: 700; color: var(--text-primary); font-family: var(--font-mono);">${platformEsc(type.id)}</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${platformEsc(type.desc)}</div>
        </div>
        <div class="custom-role-select" id="grok-subagent-select-${platformEsc(type.id)}"></div>
        ${isCustom
          ? `<button type="button" class="btn-ghost warn" data-action="removeGrokSubagentRow" data-arg="${platformEsc(type.id)}" style="height: 28px; padding: 0 10px; font-size: 12px;">移除</button>`
          : '<span></span>'}
      </div>`;
  }).join('');

  if (typeof renderCustomRoleSelect !== 'function') return;
  types.forEach(type => {
    renderCustomRoleSelect({
      containerId: `grok-subagent-select-${type.id}`,
      hiddenInputId: `grok-subagent-input-${type.id}`,
      role: 'subagent',
      currentValue: grokSubagentModels?.[type.id] || '',
      groupLabel: '已注册模型',
      items,
      optional: true,
    });
  });
  syncGrokRawConfigFromFields();
}

function onGrokSubagentModelSelected(containerId, value) {
  const agent = String(containerId || '').replace('grok-subagent-select-', '');
  if (!agent) return;
  if (!grokSubagentModels) grokSubagentModels = {};
  if (value) grokSubagentModels[agent] = value;
  else delete grokSubagentModels[agent];
  renderGrokSubagentRows();
}

async function addGrokSubagentRow() {
  const typed = (typeof showCustomPrompt === 'function')
    ? await showCustomPrompt('输入子代理类型名（内置 explore / plan / general-purpose 已在列表中，这里填自定义类型，如 bug-analyzer、code-reviewer）', '添加子代理类型', '')
    : prompt('输入子代理类型名：', '');
  const id = String(typed || '').trim();
  if (!id) return;
  if (!grokSubagentCustomTypes) grokSubagentCustomTypes = [];
  if (!grokSubagentCustomTypes.includes(id) && !GROK_SUBAGENT_TYPES.some(t => t.id === id)) {
    grokSubagentCustomTypes.push(id);
  }
  renderGrokSubagentRows();
}

function removeGrokSubagentRow(agent) {
  const id = String(agent || '').trim();
  if (!id) return;
  grokSubagentCustomTypes = (grokSubagentCustomTypes || []).filter(x => x !== id);
  if (grokSubagentModels) delete grokSubagentModels[id];
  renderGrokSubagentRows();
}

async function fetchGrokConfigModels() {
  if (!invoke) return;
  const baseUrl = String(document.getElementById('grok-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('grok-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  await runRaceGuardedModelFetch({
    getSeq: () => grokConfigModelFetchSeq,
    bumpSeq: () => ++grokConfigModelFetchSeq,
    setLoadingFn: grokConfigSetFetchLoading,
    setStatusFn: grokConfigSetModelStatus,
    loadingStatusText: '正在拉取模型列表...',
    fetcher: async () => {
      const endpoint = grokConfigEndpointParts(baseUrl);
      return invoke('fetch_models', {
        args: {
          host: endpoint.apiHost,
          api_key: apiKey,
          api_format: 'openai',
          path: endpoint.apiPath || '/v1',
        }
      });
    },
    onSuccess: (result) => {
      const fetchedModels = (result?.models || []).map(m => String(m || '').trim()).filter(Boolean);
      if (!fetchedModels.length) throw new Error('接口返回的模型列表为空');
      const existing = getGrokModelEntries();
      const existingMap = new Map(existing.map(e => [e.model, e]));
      const merged = [...existing.map(e => ({ ...e }))];
      for (const model of fetchedModels) {
        if (!existingMap.has(model)) {
          merged.push({ model, displayName: '', contextWindow: '', inCatalog: false, isDefault: false });
        }
      }
      const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
      const sorted = sortFn(merged, 'grok');
      const currentDefault = existing.find(e => e.isDefault)?.model || '';
      renderGrokModelManager(sorted, currentDefault, `已拉取 ${fetchedModels.length} 个模型`);
      if (typeof addLog === 'function') addLog('ok', `Grok 配置模型拉取成功: ${fetchedModels.length} 个`);
    },
    onError: (e) => {
      grokConfigSetModelStatus('拉取失败，可手动添加模型', 'error');
      if (typeof addLog === 'function') addLog('warn', `Grok 配置模型拉取失败: ${e}`);
      showCustomAlert(String(e), '模型拉取失败', 'error');
    },
  });
}

/** 来源供应商的模型 ID 列表（用于选供应商后预填列表） */
function grokModelIdsOf(models) {
  return (Array.isArray(models) ? models : [])
    .map(m => (typeof m === 'string' ? m : (m?.id || '')))
    .filter(Boolean);
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.grokConfigSetModelStatus = grokConfigSetModelStatus;
  g.grokConfigSetFetchLoading = grokConfigSetFetchLoading;
  g.setGrokModelEntriesState = setGrokModelEntriesState;
  g.getGrokModelEntries = getGrokModelEntries;
  g.grokEntryContext = grokEntryContext;
  g.grokRegisteredEntries = grokRegisteredEntries;
  g.renderGrokModelManager = renderGrokModelManager;
  g.toggleGrokModelCatalog = toggleGrokModelCatalog;
  g.cancelGrokModelEdit = cancelGrokModelEdit;
  g.selectGrokDefaultModel = selectGrokDefaultModel;
  g.addGrokModelEntry = addGrokModelEntry;
  g.editGrokModelEntry = editGrokModelEntry;
  g.saveGrokModelEdit = saveGrokModelEdit;
  g.removeGrokModelEntry = removeGrokModelEntry;
  g.batchSetGrokModelCatalog = batchSetGrokModelCatalog;
  g.batchSetGrokDefaultModel = batchSetGrokDefaultModel;
  g.grokConfigGetDefaultModel = grokConfigGetDefaultModel;
  g.grokSubagentTypeList = grokSubagentTypeList;
  g.grokSectionKeyOf = grokSectionKeyOf;
  g.renderGrokSubagentRows = renderGrokSubagentRows;
  g.onGrokSubagentModelSelected = onGrokSubagentModelSelected;
  g.addGrokSubagentRow = addGrokSubagentRow;
  g.removeGrokSubagentRow = removeGrokSubagentRow;
  g.fetchGrokConfigModels = fetchGrokConfigModels;
  g.grokModelIdsOf = grokModelIdsOf;
})(globalThis);
