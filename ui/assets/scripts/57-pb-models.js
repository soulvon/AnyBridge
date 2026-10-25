/**
 * Pi / Hermes / DeepSeek Harness 的模型管理（前端实现）。
 *
 * 背景：这三页的 HTML 与 add 子页面从 v0.5.28 起就存在，但前端渲染/保存
 * 逻辑**从未实现**（`pi-model-tbody` 在 JS 历史中 0 次出现），导致
 * openPlatformPage 调用 loadPiModels() 直接 ReferenceError、列表永远空白。
 *
 * 三平台结构同构（models 数组 + 供应商池选择 + add 子页面），因此用一套
 * 参数化实现，避免三份重复代码：
 *   - 列表：<p>-model-tbody / <p>-model-table / <p>-model-empty
 *   - 添加：<p>-add-provider-list / <p>-add-models-list-page / <p>-add-confirm-page
 *
 * 数据形状（与后端 load_*_models / save_*_models 一致）：
 *   { id, name, vendor, url, apiKey, supportsToolCall, supportsImages, supportsReasoning }
 */

const PB_SPECS = {
  pi: {
    label: 'Pi',
    load: 'load_pi_models',
    save: 'save_pi_models',
    p: 'pi',
    addPage: 'platform-pi-add',
  },
  hermes: {
    label: 'Hermes',
    load: 'load_hermes_models',
    save: 'save_hermes_models',
    p: 'hermes',
    addPage: 'platform-hermes-add',
  },
  dsh: {
    label: 'DeepSeek Harness',
    load: 'load_deepseek_harness_models',
    save: 'save_deepseek_harness_models',
    p: 'dsh',
    addPage: 'platform-deepseek-harness-add',
  },
};

const _pbModels = { pi: [], hermes: [], dsh: [] };
const _pbAdd = {
  providerId: null,
  providers: [],
  kw: '',
  selected: new Set(),
};

function _pbSpec(pid) {
  return PB_SPECS[pid] || null;
}

function _pbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function _pbHasInvoke() {
  return typeof invoke === 'function' || (typeof bindTauriBridge === 'function' && bindTauriBridge());
}

/* ───────────── 列表：加载 / 渲染 / 保存 / 删除 ───────────── */

async function pbLoadModels(pid) {
  const spec = _pbSpec(pid);
  if (!spec || !_pbHasInvoke()) return;
  try {
    const data = await invoke(spec.load);
    const models = Array.isArray(data?.models) ? data.models : [];
    _pbModels[pid] = models;
    pbRenderModels(pid);
    if (typeof addLog === 'function') {
      addLog('ok', `${spec.label} 已加载 ${models.length} 个模型`);
    }
  } catch (e) {
    // 暴露而非掩盖：加载失败必须可见（此前是 ReferenceError 静默中断）
    const msg = String(e?.message || e);
    if (typeof addLog === 'function') addLog('err', `${spec.label} 模型加载失败: ${msg}`);
    if (typeof showBottomToast === 'function') showBottomToast(`${spec.label} 模型加载失败: ${msg}`, 'error', { duration: 6000 });
  }
}

function pbRenderModels(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  const p = spec.p;
  const tbody = document.getElementById(`${p}-model-tbody`);
  const table = document.getElementById(`${p}-model-table`);
  const empty = document.getElementById(`${p}-model-empty`);
  if (!tbody) return;

  const models = _pbModels[pid] || [];
  if (!models.length) {
    tbody.innerHTML = '';
    if (table) table.style.display = 'none';
    if (empty) empty.style.display = '';
    pbUpdateCount(pid);
    return;
  }
  if (table) table.style.display = 'table';
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = models
    .map((m, i) => {
      const badges = [
        m.supportsImages ? '图片' : '',
        m.supportsReasoning ? '推理' : '',
      ].filter(Boolean).join(' · ');
      return `<tr>
        <td><input type="checkbox" class="${p}-model-check" data-index="${i}"></td>
        <td title="${_pbEsc(m.id)}">${_pbEsc(m.name || m.id)}</td>
        <td>${_pbEsc(m.vendor || '')}</td>
        <td title="${_pbEsc(m.url || '')}" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_pbEsc(m.url || '')}</td>
        <td>${_pbEsc(badges)}</td>
      </tr>`;
    })
    .join('');
  pbUpdateCount(pid);
}

function pbUpdateCount(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  const el = document.getElementById(`${spec.p}-models-count`);
  if (el) el.textContent = String((_pbModels[pid] || []).length);
}

async function pbPersist(pid) {
  const spec = _pbSpec(pid);
  if (!spec || !_pbHasInvoke()) return false;
  try {
    await invoke(spec.save, {
      models: _pbModels[pid] || [],
      availableModels: [],
      scope: null,
    });
    if (typeof showBottomToast === 'function') showBottomToast(`${spec.label} 模型已保存`, 'success');
    if (typeof addLog === 'function') addLog('ok', `${spec.label} 模型已保存`);
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (typeof addLog === 'function') addLog('err', `${spec.label} 保存失败: ${msg}`);
    if (typeof showCustomAlert === 'function') showCustomAlert(msg, `${spec.label} 保存失败`, 'error');
    return false;
  }
}

async function pbSaveModels(pid) {
  const ok = await pbPersist(pid);
  if (ok) pbRenderModels(pid);
}

async function pbDeleteSelected(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  const checked = Array.from(document.querySelectorAll(`.${spec.p}-model-check:checked`));
  if (!checked.length) {
    if (typeof showBottomToast === 'function') showBottomToast('请先勾选要删除的模型', 'info');
    return;
  }
  const drop = new Set(checked.map((el) => Number(el.dataset.index)));
  _pbModels[pid] = (_pbModels[pid] || []).filter((_, i) => !drop.has(i));
  const ok = await pbPersist(pid);
  if (ok) pbRenderModels(pid);
}

function pbToggleSelectAll(pid, checked) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  document.querySelectorAll(`.${spec.p}-model-check`).forEach((el) => {
    el.checked = !!checked;
  });
}

/* ───────────── 添加子页面 ───────────── */

async function pbOpenAdd(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  if (typeof navigateTo === 'function') navigateTo(spec.addPage);
  await pbInitAddPage(pid);
}

async function pbInitAddPage(pid) {
  const spec = _pbSpec(pid);
  if (!spec || !_pbHasInvoke()) return;
  _pbAdd.providerId = null;
  _pbAdd.kw = '';
  _pbAdd.selected = new Set();
  try {
    const list = await invoke('list_provider_models');
    _pbAdd.providers = Array.isArray(list) ? list : [];
  } catch (e) {
    _pbAdd.providers = [];
    if (typeof addLog === 'function') addLog('err', `${spec.label} 供应商列表读取失败: ${String(e?.message || e)}`);
  }
  const search = document.getElementById(`${spec.p}-add-search`);
  if (search) search.value = '';
  if (_pbAdd.providers.length) _pbAdd.providerId = _pbAdd.providers[0].providerId;
  pbRenderAddProviders(pid);
  pbRenderAddModels(pid);
}

function pbRenderAddProviders(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  const box = document.getElementById(`${spec.p}-add-provider-list`);
  if (!box) return;
  if (!_pbAdd.providers.length) {
    box.innerHTML = '<div class="wb-empty-subtitle">没有可用供应商，请先在「供应商」页添加。</div>';
    return;
  }
  box.innerHTML = _pbAdd.providers
    .map((p) => {
      const active = p.providerId === _pbAdd.providerId ? ' active' : '';
      const count = Array.isArray(p.models) ? p.models.length : 0;
      return `<button type="button" class="pb-add-provider${active}" data-pb-provider="${_pbEsc(p.providerId)}">
        <span>${_pbEsc(p.providerName || p.providerId)}</span>
        <small>${count} 个模型</small>
      </button>`;
    })
    .join('');
  // 用事件委托避免内联 onclick（CSP 友好）
  box.querySelectorAll('[data-pb-provider]').forEach((btn) => {
    btn.onclick = () => {
      _pbAdd.providerId = btn.getAttribute('data-pb-provider');
      _pbAdd.selected = new Set();
      pbRenderAddProviders(pid);
      pbRenderAddModels(pid);
    };
  });
}

function pbRenderAddModels(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  const box = document.getElementById(`${spec.p}-add-models-list-page`);
  const title = document.getElementById(`${spec.p}-add-models-title`);
  const sub = document.getElementById(`${spec.p}-add-models-sub`);
  if (!box) return;
  const provider = _pbAdd.providers.find((p) => p.providerId === _pbAdd.providerId);
  if (!provider) {
    box.innerHTML = '';
    return;
  }
  const kw = (_pbAdd.kw || '').toLowerCase();
  const models = (Array.isArray(provider.models) ? provider.models : []).filter(
    (m) => !kw || String(m.id || '').toLowerCase().includes(kw) || String(m.name || '').toLowerCase().includes(kw)
  );
  if (title) title.textContent = provider.providerName || provider.providerId;
  if (sub) sub.textContent = `${models.length} 个可选模型`;
  if (!models.length) {
    box.innerHTML = '<div class="wb-empty-subtitle">该供应商没有可选模型。</div>';
    return;
  }
  box.innerHTML = models
    .map((m) => {
      const id = String(m.id || '');
      const checked = _pbAdd.selected.has(id) ? ' checked' : '';
      return `<label class="pb-add-model-row">
        <input type="checkbox" class="pb-add-model-check" data-model-id="${_pbEsc(id)}"${checked}>
        <span>${_pbEsc(m.name || id)}</span>
      </label>`;
    })
    .join('');
  box.querySelectorAll('.pb-add-model-check').forEach((el) => {
    el.onchange = () => {
      const id = el.getAttribute('data-model-id');
      if (el.checked) _pbAdd.selected.add(id);
      else _pbAdd.selected.delete(id);
    };
  });
}

function pbOnAddSearch(pid, value) {
  _pbAdd.kw = String(value || '');
  pbRenderAddModels(pid);
}

async function pbConfirmAdd(pid) {
  const spec = _pbSpec(pid);
  if (!spec) return;
  const provider = _pbAdd.providers.find((p) => p.providerId === _pbAdd.providerId);
  if (!provider || !_pbAdd.selected.size) {
    if (typeof showBottomToast === 'function') showBottomToast('请勾选至少一个模型', 'info');
    return;
  }
  const btn = document.getElementById(`${spec.p}-add-confirm-page`);
  const orig = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = loadingHtml('保存中…');
  }
  try {
    const existing = _pbModels[pid] || [];
    const merged = existing.slice();
    const baseUrl = String(provider.apiHost || '').replace(/\/+$/, '');
    for (const m of provider.models || []) {
      const id = String(m.id || '');
      if (!_pbAdd.selected.has(id)) continue;
      if (merged.some((x) => x.id === id && x.vendor === provider.providerId)) continue;
      merged.push({
        id,
        name: String(m.name || id),
        vendor: String(provider.providerId),
        url: baseUrl,
        apiKey: String(provider.apiKey || ''),
        supportsToolCall: m.supportsToolCall !== false,
        supportsImages: !!m.supportsImages,
        supportsReasoning: !!m.supportsReasoning,
      });
    }
    _pbModels[pid] = merged;
    const ok = await pbPersist(pid);
    if (ok) {
      if (typeof navigateTo === 'function') navigateTo(`platform-${pid === 'dsh' ? 'deepseek-harness' : pid}`);
      pbRenderModels(pid);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
}

/* ───────────── 平台包装（data-action 需要平铺函数名） ───────────── */

function loadPiModels() { return pbLoadModels('pi'); }
function openPiAddModal() { return pbOpenAdd('pi'); }
function confirmAddPiModelsPage() { return pbConfirmAdd('pi'); }
function savePiModels() { return pbSaveModels('pi'); }
function deleteSelectedPiModels() { return pbDeleteSelected('pi'); }
function onPiAddSearch(el) { return pbOnAddSearch('pi', el && el.value); }
function onPiModelSearch() { /* 列表页搜索：暂不实现过滤，保持提示 */ }
function piAddSelectAll() { pbToggleAddAll(true); }
function piAddSelectNone() { pbToggleAddAll(false); }

function loadHermesModels() { return pbLoadModels('hermes'); }
function openHermesAddModal() { return pbOpenAdd('hermes'); }
function confirmAddHermesModelsPage() { return pbConfirmAdd('hermes'); }
function saveHermesModels() { return pbSaveModels('hermes'); }
function deleteSelectedHermesModels() { return pbDeleteSelected('hermes'); }
function onHermesAddSearch(el) { return pbOnAddSearch('hermes', el && el.value); }
function onHermesModelSearch() { }
function hermesAddSelectAll() { pbToggleAddAll(true); }
function hermesAddSelectNone() { pbToggleAddAll(false); }

function loadDshModels() { return pbLoadModels('dsh'); }
function openDshAddModal() { return pbOpenAdd('dsh'); }
function confirmAddDshModelsPage() { return pbConfirmAdd('dsh'); }
function saveDshModels() { return pbSaveModels('dsh'); }
function deleteSelectedDshModels() { return pbDeleteSelected('dsh'); }
function onDshAddSearch(el) { return pbOnAddSearch('dsh', el && el.value); }
function onDshModelSearch() { }
function dshAddSelectAll() { pbToggleAddAll(true); }
function dshAddSelectNone() { pbToggleAddAll(false); }

function pbToggleAddAll(checked) {
  _pbAdd.selected = new Set();
  document.querySelectorAll('.pb-add-model-check').forEach((el) => {
    el.checked = !!checked;
    if (checked) _pbAdd.selected.add(el.getAttribute('data-model-id'));
  });
}

/* ───────────── 导出到 globalThis（data-action 解析依赖 window[name]） ───────────── */

Object.assign(globalThis, {
  loadPiModels, openPiAddModal, confirmAddPiModelsPage, savePiModels, deleteSelectedPiModels,
  onPiAddSearch, onPiModelSearch, piAddSelectAll, piAddSelectNone,
  loadHermesModels, openHermesAddModal, confirmAddHermesModelsPage, saveHermesModels,
  deleteSelectedHermesModels, onHermesAddSearch, onHermesModelSearch, hermesAddSelectAll,
  hermesAddSelectNone,
  loadDshModels, openDshAddModal, confirmAddDshModelsPage, saveDshModels, deleteSelectedDshModels,
  onDshAddSearch, onDshModelSearch, dshAddSelectAll, dshAddSelectNone,
});
