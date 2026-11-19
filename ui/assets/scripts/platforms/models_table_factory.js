// platforms/models_table_factory.js — split from 55-platforms.js
// ═══════ 通用模型表格行渲染工厂 ═══════

function createCbRowFactory(prefix) {
  const id = prefix.toLowerCase();
  const cls = prefix === 'Cb' ? 'cb' : 'wb';
  const dataAttr = `data-${id}-index`;
  const esc = platformEsc;
  const maskKey = (k) => {
    k = String(k || '').trim();
    if (k.length <= 12) return '***';
    return k.slice(0, 6) + '***' + k.slice(-4);
  };

  // Pi / Hermes / Dsh 等受管平台的状态与函数按 dom 前缀统一命名，避免逐个分支
  const getEditingIndex = () => globalThis[`${id}EditingIndex`];
  const setEditingIndex = (v) => { globalThis[`${id}EditingIndex`] = v; };
  const editFn = `edit${prefix}Model`;
  const deleteFn = `delete${prefix}Model`;

  return function modelRow(model, index) {
    // Buddy 固定 vendor=user，列表展示优先 name/id，避免全部显示成 "user"。
    const displayName = (model.vendor === 'user'
      ? (model.name || model.id)
      : (model.vendor || model.name || model.id)) || '未命名';
    const selected = cbSelectionSet(prefix).has(cbModelSelectionKey(prefix, model));
    const caps = [];
    if (model.supportsToolCall) caps.push(cbCapabilityPill(cls, 'tool', '工具'));
    if (model.supportsImages) caps.push(cbCapabilityPill(cls, 'image', '图片'));
    if (model.supportsReasoning) caps.push(cbCapabilityPill(cls, 'reason', '推理'));

    const enabled = model.enabled !== false;
    const toggleFn = `toggle${prefix}ModelEnabled`;
    const contextTokens = model.maxInputTokens != null ? model.maxInputTokens : null;
    const contextLabel = cbFormatContextTokens(contextTokens);
    const contextTitle = contextTokens != null && Number.isFinite(Number(contextTokens))
      ? `上下文窗口：${Number(contextTokens).toLocaleString()} tokens`
      : '未设置上下文窗口';

    const modelId = String(model.id || '');
    const iconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(modelId)
      : `<div class="model-item-icon fallback">${esc((modelId.charAt(0) || '?').toUpperCase())}</div>`;

    return `
    <tr ${dataAttr}="${index}" class="${selected ? 'cb-model-row-selected' : ''}">
      <td class="cb-select-cell">
        <input type="checkbox" class="cb-model-row-check" aria-label="选择 ${esc(model.id || '模型')}" ${selected ? 'checked' : ''} data-action="toggleCbModelSelection" data-events="change" data-args="[&quot;${prefix}&quot;,${index}]" data-pass-checked>
      </td>
      <td>
        <div class="model-id-copy-wrap">
          ${iconHtml}
          <span class="display-name-cell" title="${esc(model.id || '')}">${esc(model.id || '-')}</span>
          <button class="btn-icon model-id-copy-btn" data-action="copyTextToClipboard" data-args="[&quot;${esc(model.id || '')}&quot;,&quot;模型 ID&quot;]" title="复制模型 ID">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </td>
      <td><span title="${esc(displayName)}">${esc(displayName)}</span></td>
      <td class="${cls}-context-cell">
        <span class="${cls}-context-pill" title="${esc(contextTitle)}">${esc(contextLabel)}</span>
      </td>
      <td><div style="display:flex; gap:6px; flex-wrap:wrap;">${caps.join('') || '<span style="color:var(--text-muted);font-size:12px;">—</span>'}</div></td>
      <td>
        <div class="model-map-actions">
          <button class="btn-icon model-map-action-btn" data-action="openCbEditModal" data-args="[&quot;${prefix}&quot;,${index}]" title="编辑模型" aria-label="编辑模型">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon model-map-action-btn danger" data-action="${deleteFn}" data-args="[${index}]" title="删除模型" aria-label="删除模型">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
      <td class="model-map-toggle-cell">
        <label class="toggle-switch" title="${enabled ? '已启用' : '已停用'}">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-action="${toggleFn}" data-events="change" data-args="[${index}]" data-pass-checked>
          <span class="toggle-slider"></span>
        </label>
      </td>
    </tr>
  `;
  };
}

// Antigravity 拖拽导入处理
window.antigravityDragOver = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('antigravity-drop-zone');
  if (zone) zone.classList.add('drag-over');
};
window.antigravityDragLeave = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('antigravity-drop-zone');
  if (zone) zone.classList.remove('drag-over');
};
window.antigravityDrop = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('antigravity-drop-zone');
  if (zone) zone.classList.remove('drag-over');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const file = files[0];
  if (!file.name.endsWith('.json')) {
    showCustomAlert('请拖入 .json 文件', '格式不支持', 'warn');
    return;
  }
  const reader = new FileReader();
  reader.onload = async function(ev) {
    try {
      const data = JSON.parse(ev.target.result);
      const incoming = Array.isArray(data.models) ? data.models : (Array.isArray(data) ? data : []);
      if (!incoming.length) {
        showCustomAlert('JSON 中未包含模型数组', '导入失败', 'warn');
        return;
      }
      let added = 0;
      const ok = await mutateProviderStore(store => {
        const current = Array.isArray(store.antigravityConfigs) ? [...store.antigravityConfigs] : [];
        incoming.forEach(m => {
          if (!m || !m.id) return;
          if (current.some(c => c.id === m.id)) return;
          const sourceId = String(m.sourceProviderId || '').trim();
          const overrideFmt = String(m.apiFormatOverride || '').trim().toLowerCase();
          const defaultModel = m.defaultModel || m.model || m.id;
          const entry = {
            id: m.id,
            name: m.name || m.id,
            defaultModel,
            models: Array.isArray(m.models) && m.models.length ? m.models : [defaultModel],
            sourceProviderId: sourceId,
            sourceProviderName: m.sourceProviderName || '自定义导入',
            enabled: m.enabled !== false,
          };
          if (sourceId) {
            if (overrideFmt === 'openai' || overrideFmt === 'anthropic' || overrideFmt === 'gemini') {
              entry.apiFormatOverride = overrideFmt;
            }
          } else {
            entry.apiFormat = inferProviderApiFormat(m, defaultModel, 'openai');
            if (m.apiHost) entry.apiHost = m.apiHost;
            if (m.apiPath) entry.apiPath = m.apiPath;
          }
          current.push(entry);
          added++;
        });
        if (added === 0) return false;
        store.antigravityConfigs = current;
      }, {
        alertOnError: true,
        onRollback: () => {
          if (typeof antigravityRenderTableRows === 'function') antigravityRenderTableRows();
        },
      });

      if (added === 0) {
        showCustomAlert('没有新模型需要导入', '提示', 'info');
      } else if (ok) {
        if (typeof antigravityRenderTableRows === 'function') antigravityRenderTableRows();
        if (typeof antigravityRefreshConsole === 'function') antigravityRefreshConsole({ silent: true });
        showCustomAlert(`成功导入 ${added} 个模型配置`, '导入成功', 'ok');
      }
    } catch (err) {
      showCustomAlert('解析 JSON 失败: ' + err.message, '解析错误', 'error');
    }
  };
  reader.readAsText(file);
};

// ═══════ 拖拽导入（通用工厂） ═══════

function createCbDropHandlers(prefix, modelsGetter, modelsSetter, availableGetter, availableSetter, renderFn, configLabel) {
  const id = prefix.toLowerCase();

  window[id + 'DragOver'] = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById(id + '-drop-zone');
    if (zone) zone.classList.add('drag-over');
  };

  window[id + 'DragLeave'] = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById(id + '-drop-zone');
    if (zone) zone.classList.remove('drag-over');
  };

  window[id + 'Drop'] = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById(id + '-drop-zone');
    if (zone) zone.classList.remove('drag-over');

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const file = files[0];
    if (!file.name.endsWith('.json')) {
      showCustomAlert('请拖入 .json 文件', '格式不支持', 'warn');
      return;
    }

    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        const incoming = Array.isArray(data.models) ? data.models : [];
        if (!incoming.length) {
          showCustomAlert('文件中没有 models 数组或为空', '导入失败', 'warn');
          return;
        }
        const current = modelsGetter();
        const existingIds = new Set(current.map(m => cbModelSelectionKey(prefix, m)).filter(Boolean));
        let added = 0;
        incoming.forEach(m => {
          const key = cbModelSelectionKey(prefix, m);
          if (!m.id || !key || existingIds.has(key)) return;
          existingIds.add(key);
          current.push(m);
          added++;
        });
        modelsSetter(current);
        if (Array.isArray(data.availableModels)) {
          const avail = availableGetter();
          data.availableModels.forEach(aid => {
            if (!avail.includes(aid)) avail.push(aid);
          });
          availableSetter(avail);
        }
        availableSetter(cbMergeAvailableModels(availableGetter(), current));
        renderFn();
        showCustomAlert(
          `拖入导入完成：${incoming.length} 个模型中有 ${added} 个新增（${incoming.length - added} 个重复已跳过）`,
          '导入结果',
          added > 0 ? 'success' : 'info'
        );
      } catch (err) {
        showCustomAlert('JSON 解析失败：' + err.message, '导入失败', 'error');
      }
    };
    reader.readAsText(file);
  };
}

createCbDropHandlers(
  'Cb',
  () => cbModels, v => { cbModels = v; },
  () => cbAvailableModels, v => { cbAvailableModels = v; },
  () => renderCodeBuddyModels(), 'CodeBuddy'
);

createCbDropHandlers(
  'Wb',
  () => wbModels, v => { wbModels = v; },
  () => wbAvailableModels, v => { wbAvailableModels = v; },
  () => renderWbModels(), 'WorkBuddy'
);

createCbDropHandlers(
  'Zc',
  () => zcModels, v => { zcModels = v; },
  () => zcAvailableModels, v => { zcAvailableModels = v; },
  () => renderZcModels(), 'ZCode'
);

// ═══════ 导入导出 & JSON 编辑器（通用工厂） ═══════

function createCbIoHandlers(prefix, platform, modelsGetter, modelsSetter, availableGetter, availableSetter, renderFn, saveFn, loadFn, configLabel) {
  const id = prefix.toLowerCase();

  const setJsonToggleActive = (active) => {
    const btn = document.querySelector(`[data-json-toggle="${id}"]`);
    if (!btn) return;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  const setJsonView = (open) => {
    const listView = document.getElementById(id + '-list-view');
    const jsonView = document.getElementById(id + '-json-view');
    if (!jsonView) return;

    if (open) {
      if (listView) listView.style.display = 'none';
      jsonView.style.display = 'block';
      setJsonToggleActive(true);
      return;
    }

    jsonView.style.display = 'none';
    if (listView) listView.style.display = '';
    setJsonToggleActive(false);
    renderFn();
  };

  const bindGlobal = (name, fn) => {
    globalThis[name] = fn;
    if (typeof window !== 'undefined') window[name] = fn;
  };

  // ─── 导出 ───
  bindGlobal('export' + prefix + 'Models', function() {
    const models = modelsGetter();
    const available = availableGetter();
    const payload = { models, availableModels: available };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = platform + '-models.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof addLog === 'function') addLog('ok', `${configLabel} 配置已导出`);
  });

  // ─── 导入 ───
  bindGlobal('import' + prefix + 'Models', function(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    // 重置 input，允许重复选择同一文件
    event.target.value = '';
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = JSON.parse(e.target.result);
        const incoming = Array.isArray(data.models) ? data.models : [];
        if (!incoming.length) {
          showCustomAlert('导入文件中没有 models 数组或为空', '导入失败', 'warn');
          return;
        }
        const current = modelsGetter();
        const existingIds = new Set(current.map(m => cbModelSelectionKey(prefix, m)).filter(Boolean));
        let added = 0;
        incoming.forEach(m => {
          const key = cbModelSelectionKey(prefix, m);
          if (!m.id || !key || existingIds.has(key)) return;
          existingIds.add(key);
          current.push(m);
          added++;
        });
        modelsSetter(current);
        if (Array.isArray(data.availableModels)) {
          const avail = availableGetter();
          data.availableModels.forEach(id => {
            if (!avail.includes(id)) avail.push(id);
          });
          availableSetter(avail);
        }
        availableSetter(cbMergeAvailableModels(availableGetter(), current));
        renderFn();
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
  });

  // ─── JSON 编辑器 ───
  bindGlobal('toggle' + prefix + 'JsonEditor', function() {
    const jsonView = document.getElementById(id + '-json-view');
    const wrap = document.getElementById(id + '-json-editor-wrap');
    if (!wrap) {
      console.warn('[toggle' + prefix + 'JsonEditor] wrap not found:', id + '-json-editor-wrap');
      return;
    }
    const isHidden = !jsonView || jsonView.style.display === 'none';
    if (isHidden) {
      // 展开：先填数据
      const models = modelsGetter();
      const available = availableGetter();
      const payload = { models, availableModels: available };
      const editor = document.getElementById(id + '-json-editor');
      if (editor) editor.value = JSON.stringify(payload, null, 2);
      const errEl = document.getElementById(id + '-json-error');
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      setJsonView(true);
    } else {
      setJsonView(false);
    }
  });

  bindGlobal('format' + prefix + 'Json', function() {
    const editor = document.getElementById(id + '-json-editor');
    const errEl = document.getElementById(id + '-json-error');
    if (!editor) return;
    try {
      const data = JSON.parse(editor.value);
      editor.value = JSON.stringify(data, null, 2);
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    } catch (err) {
      if (errEl) { errEl.style.display = ''; errEl.textContent = '格式化失败：' + err.message; }
    }
  });

  bindGlobal('apply' + prefix + 'Json', function() {
    const editor = document.getElementById(id + '-json-editor');
    const errEl = document.getElementById(id + '-json-error');
    if (!editor) return;
    try {
      const data = JSON.parse(editor.value);
      const models = Array.isArray(data.models) ? data.models : [];
      const available = Array.isArray(data.availableModels) ? data.availableModels : models.map(m => m.id).filter(Boolean);
      modelsSetter(models);
      availableSetter(available);
      setJsonView(false);
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      showCustomAlert(`已从 JSON 编辑器应用 ${models.length} 个模型`, '应用成功', 'success');
    } catch (err) {
      if (errEl) { errEl.style.display = ''; errEl.textContent = 'JSON 语法错误：' + err.message; }
    }
  });
}

// 为三个平台各注册一套
createCbIoHandlers(
  'Cb', 'codebuddy',
  () => cbModels, v => { cbModels = v; },
  () => cbAvailableModels, v => { cbAvailableModels = v; },
  () => renderCodeBuddyModels(), () => saveCodeBuddyModels(), () => loadCodeBuddyModels(),
  'CodeBuddy'
);

createCbIoHandlers(
  'Wb', 'workbuddy',
  () => wbModels, v => { wbModels = v; },
  () => wbAvailableModels, v => { wbAvailableModels = v; },
  () => renderWbModels(), () => saveWbModels(), () => loadWbModels(),
  'WorkBuddy'
);

createCbIoHandlers(
  'Zc', 'zcode',
  () => zcModels, v => { zcModels = v; },
  () => zcAvailableModels, v => { zcAvailableModels = v; },
  () => renderZcModels(), () => saveZcModels(), () => loadZcModels(),
  'ZCode'
);

globalThis.cbRowFactory = createCbRowFactory('Cb');
globalThis.wbRowFactory = createCbRowFactory('Wb');
globalThis.zcRowFactory = createCbRowFactory('Zc');
globalThis.piRowFactory = createCbRowFactory('Pi');
globalThis.hermesRowFactory = createCbRowFactory('Hermes');
globalThis.dshRowFactory = createCbRowFactory('Dsh');

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.createCbRowFactory = createCbRowFactory;
  g.createCbDropHandlers = createCbDropHandlers;
  g.createCbIoHandlers = createCbIoHandlers;
})(globalThis);

// 静态导出注册：让动态生成的 Cb/Wb/Zc IO 与 JSON 动作对 ui-guards 静态可达检查可见
(function registerCbIoActions(g) {
  g.exportCbModels = g.exportCbModels;
  g.importCbModels = g.importCbModels;
  g.toggleCbJsonEditor = g.toggleCbJsonEditor;
  g.formatCbJson = g.formatCbJson;
  g.applyCbJson = g.applyCbJson;
  g.exportWbModels = g.exportWbModels;
  g.importWbModels = g.importWbModels;
  g.toggleWbJsonEditor = g.toggleWbJsonEditor;
  g.formatWbJson = g.formatWbJson;
  g.applyWbJson = g.applyWbJson;
  g.exportZcModels = g.exportZcModels;
  g.importZcModels = g.importZcModels;
  g.toggleZcJsonEditor = g.toggleZcJsonEditor;
  g.formatZcJson = g.formatZcJson;
  g.applyZcJson = g.applyZcJson;
})(globalThis);
