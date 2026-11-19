// model-map/slot-actions.js — 槽位批量操作与网关增强参数/工具控制面板
import { escapeHtml, escAttr } from '../ui/dom.js';

async function batchDeleteSelectedSlots() {
  if (modelMapBulkRunning) return;
  cleanupModelMapSelection();
  const targets = (modelMapStore.slots || []).filter(s => modelMapSelectedIds.has(s.modelUid));
  if (!targets.length) return;
  modelMapBulkRunning = true;
  syncModelMapSelectionState();
  const removedUids = new Set(targets.map(s => s.modelUid));
  const prev = modelMapStore.slots.slice();
  let okCount = 0;
  try {
    modelMapStore.slots = modelMapStore.slots.filter(s => !removedUids.has(s.modelUid));
    if (await persistModelMap()) {
      okCount = targets.length;
      removedUids.forEach(uid => modelMapSelectedIds.delete(uid));
      addLog('info', `已删除 ${okCount} 个模型映射`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已删除 ${okCount} 个模型映射`, 'success');
      }
    } else {
      modelMapStore.slots = prev;
    }
  } catch (e) {
    modelMapStore.slots = prev;
    addLog('err', '批量删除失败: ' + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    modelMapBulkRunning = false;
    await renderModelMap();
  }
}

// ─── 网关增强配置面板 ───
function renderProxyEnhancement() {
  ensureModelMapDefaults();
  const e = modelMapStore.enhancement;
  ['retry', 'imageFallback', 'autoRouting', 'unlockModels', 'requestLogging',
    'systemPromptPrefixEnabled', 'customHeadersEnabled', 'toolFilterEnabled',
    'paramOverridesEnabled', 'rateLimitEnabled', 'webSearchEnabled', 'cooldownEnabled'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.checked = e[key] === true;
  });
  ['retryMaxRetries', 'retryBaseMs', 'retryCapMs', 'retryTotalSeconds', 'rateLimitRpm', 'visionBatchSize', 'visionContextMaxChars', 'webSearchMaxResults', 'webSearchMaxRounds',
    'failoverTtfbSeconds', 'cooldownTransientSeconds', 'cooldownMaxSeconds', 'cooldownAuthSeconds'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.value = e[key];
    syncEnhancementResetButton(key, e[key]);
  });
  ['visionMaxTokens', 'visionContextMode', 'visionMultiImageMode'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.value = String(e[key] || DEFAULT_PROXY_ENHANCEMENT[key]);
  });
  ['enabled', 'signature', 'budget', 'media'].forEach(key => {
    const el = document.getElementById(`enhancement-selfHeal-${key}`);
    if (el) el.checked = e.selfHeal?.[key] !== false;
  });
  setRetryConfigControlsEnabled(e.retry !== false);
  setCooldownConfigControlsEnabled(e.cooldownEnabled !== false);
  setSelfHealControlsEnabled(e.selfHeal?.enabled !== false);
  setPanelControlsEnabled('systemPromptPrefix', e.systemPromptPrefixEnabled === true);
  setPanelControlsEnabled('customHeaders', e.customHeadersEnabled === true);
  setPanelControlsEnabled('toolFilter', e.toolFilterEnabled === true);
  setPanelControlsEnabled('paramOverrides', e.paramOverridesEnabled === true);
  setPanelControlsEnabled('rateLimit', e.rateLimitEnabled === true);
  setVisionOptionControlsEnabled(e.imageFallback !== false);
  setVisionBatchSizeEnabled(e.visionMultiImageMode === 'chunk' && e.imageFallback !== false);

  const sp = document.getElementById('enhancement-systemPromptPrefix');
  if (sp) sp.value = e.systemPromptPrefix || '';

  const tfm = document.getElementById('enhancement-toolFilterMode');
  if (tfm) tfm.value = e.toolFilterMode || '';
  const tfl = document.getElementById('enhancement-toolFilterList');
  if (tfl) tfl.value = (e.toolFilterList || []).join(', ');

  const ftc = document.getElementById('enhancement-forceToolChoice');
  if (ftc) ftc.value = e.forceToolChoice || '';

  const po = document.getElementById('enhancement-paramOverrides');
  if (po) {
    const obj = e.paramOverrides || {};
    const keys = Object.keys(obj);
    po.value = keys.length ? keys.map(k => `${k}=${JSON.stringify(obj[k])}`).join('\n') : '';
  }

  renderHeaderList('customHeaders', modelMapStore.enhancement.customHeaders);
  renderHeaderList('responseHeaders', modelMapStore.enhancement.responseHeaders);
  setPanelControlsEnabled('customHeaders', e.customHeadersEnabled === true);

  renderProxyVisionModelList();
  renderVisionModelPicker();
  renderProxySearchSourceList();
  renderSearchSourcePicker();
}

function renderHeaderList(field, headers) {
  const wrap = document.getElementById(`enhancement-${field}-list`);
  if (!wrap) return;
  const items = Array.isArray(headers) ? headers : [];
  if (!items.length) {
    wrap.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">暂无自定义头部</div>';
    return;
  }
  wrap.innerHTML = items.map((h, i) =>
    '<div class="header-pair-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
    '<input type="text" value="' + escapeHtml(h.key || '') + '" placeholder="Header 名" style="flex:1;min-width:0;" data-action="updateHeaderPair" data-events="change" data-args="[&quot;' + field + '&quot;,' + i + ',&quot;key&quot;]" data-pass-value />' +
    '<input type="text" value="' + escapeHtml(h.value || '') + '" placeholder="Header 值" style="flex:1;min-width:0;" data-action="updateHeaderPair" data-events="change" data-args="[&quot;' + field + '&quot;,' + i + ',&quot;value&quot;]" data-pass-value />' +
    '<button class="btn btn-sm btn-danger" data-action="removeHeaderPair" data-args="[&quot;' + field + '&quot;,' + i + ']" title="删除">✕</button>' +
    '</div>'
  ).join('');
}

function addHeaderPair(field) {
  ensureModelMapDefaults();
  if (!Array.isArray(modelMapStore.enhancement[field])) modelMapStore.enhancement[field] = [];
  modelMapStore.enhancement[field].push({ key: '', value: '' });
  renderHeaderList(field, modelMapStore.enhancement[field]);
  autoSaveEnhancement();
}

function updateHeaderPair(field, idx, prop, value) {
  ensureModelMapDefaults();
  const arr = modelMapStore.enhancement[field];
  if (arr && arr[idx]) arr[idx][prop] = value;
  autoSaveEnhancement();
}

function removeHeaderPair(field, idx) {
  ensureModelMapDefaults();
  const arr = modelMapStore.enhancement[field];
  if (arr) { arr.splice(idx, 1); renderHeaderList(field, arr); }
  autoSaveEnhancement();
}

function updateEnhancementText(input, key) {
  ensureModelMapDefaults();
  modelMapStore.enhancement[key] = input.value;
  autoSaveEnhancement();
}

function updateEnhancementSelect(select, key) {
  ensureModelMapDefaults();
  modelMapStore.enhancement[key] = select.value;
  autoSaveEnhancement();
}

function updateParamOverrides(textarea) {
  ensureModelMapDefaults();
  const text = textarea.value.trim();
  if (!text) { modelMapStore.enhancement.paramOverrides = {}; autoSaveEnhancement(); return; }
  const obj = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) {
      try { obj[m[1]] = JSON.parse(m[2]); }
      catch { obj[m[1]] = m[2]; }
    }
  }
  modelMapStore.enhancement.paramOverrides = obj;
  autoSaveEnhancement();
}

function updateToolFilterList(input) {
  ensureModelMapDefaults();
  modelMapStore.enhancement.toolFilterList = input.value.split(',').map(s => s.trim()).filter(Boolean);
  autoSaveEnhancement();
}

function openProxyEnhancement() {
  ensureModelMapDefaults();
  proxyVisionPickerOpen = false;
  const picker = document.getElementById('proxyVisionModelPicker');
  if (picker) {
    picker.classList.remove('is-open');
    picker.setAttribute('aria-hidden', 'true');
  }
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('enhancement');
    renderProxyEnhancement();
    return;
  }
  renderProxyEnhancement();
  document.getElementById('proxyEnhancementModal')?.classList.add('is-open');
}

function closeProxyEnhancement() {
  document.getElementById('proxyEnhancementModal')?.classList.remove('is-open');
}

function toggleEnhancement(input, key) {
  ensureModelMapDefaults();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROXY_ENHANCEMENT, key)) return;
  modelMapStore.enhancement[key] = input.checked === true;
  if (key === 'retry') setRetryConfigControlsEnabled(modelMapStore.enhancement.retry !== false);
  if (key === 'cooldownEnabled') setCooldownConfigControlsEnabled(modelMapStore.enhancement.cooldownEnabled !== false);
  // 面板开关：切换时启用/禁用对应输入控件
  if (key === 'systemPromptPrefixEnabled') setPanelControlsEnabled('systemPromptPrefix', input.checked);
  if (key === 'customHeadersEnabled') setPanelControlsEnabled('customHeaders', input.checked);
  if (key === 'toolFilterEnabled') setPanelControlsEnabled('toolFilter', input.checked);
  if (key === 'paramOverridesEnabled') setPanelControlsEnabled('paramOverrides', input.checked);
  if (key === 'rateLimitEnabled') setPanelControlsEnabled('rateLimit', input.checked);
  if (key === 'imageFallback') {
    setVisionOptionControlsEnabled(input.checked === true);
    setVisionBatchSizeEnabled(input.checked === true && modelMapStore.enhancement.visionMultiImageMode === 'chunk');
  }
  autoSaveEnhancement();
}

function toggleSelfHeal(input, key) {
  ensureModelMapDefaults();
  if (!['enabled', 'signature', 'budget', 'media'].includes(key)) return;
  modelMapStore.enhancement.selfHeal[key] = input.checked === true;
  if (key === 'enabled') setSelfHealControlsEnabled(input.checked === true);
  autoSaveEnhancement();
}

function setPanelControlsEnabled(panel, enabled) {
  const map = {
    systemPromptPrefix: ['enhancement-systemPromptPrefix'],
    customHeaders: ['enhancement-customHeaders-list', 'enhancement-responseHeaders-list'],
    toolFilter: ['enhancement-toolFilterMode', 'enhancement-toolFilterList', 'enhancement-forceToolChoice'],
    paramOverrides: ['enhancement-paramOverrides'],
    rateLimit: ['enhancement-rateLimitRpm'],
  };
  const ids = map[panel] || [];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if ('disabled' in el) el.disabled = !enabled;
    el.querySelectorAll?.('input, textarea, select, button').forEach(child => {
      child.disabled = !enabled;
    });
  });
  // 自定义请求头的添加按钮
  if (panel === 'customHeaders') {
    document.querySelectorAll('[data-action="addHeaderPair"]').forEach(btn => { btn.disabled = !enabled; });
  }
}

function setVisionOptionControlsEnabled(enabled) {
  ['visionMaxTokens', 'visionContextMode', 'visionMultiImageMode', 'visionContextMaxChars'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.disabled = !enabled;
  });
}

function setVisionBatchSizeEnabled(enabled) {
  const el = document.getElementById('enhancement-visionBatchSize');
  if (el) el.disabled = !enabled;
}

function setRetryConfigControlsEnabled(enabled) {
  ['retryMaxRetries', 'retryBaseMs', 'retryCapMs', 'retryTotalSeconds'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.disabled = !enabled;
    const btn = document.getElementById(`enhancement-reset-${key}`);
    if (btn) btn.disabled = !enabled;
  });
}

function setCooldownConfigControlsEnabled(enabled) {
  ['cooldownTransientSeconds', 'cooldownMaxSeconds', 'cooldownAuthSeconds'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.disabled = !enabled;
    const btn = document.getElementById(`enhancement-reset-${key}`);
    if (btn) btn.disabled = !enabled;
  });
}

function syncEnhancementResetButton(key, val) {
  const btn = document.getElementById(`enhancement-reset-${key}`);
  if (!btn) return;
  const defaultVal = DEFAULT_PROXY_ENHANCEMENT[key];
  if (defaultVal === undefined) return;
  const isDefault = val !== '' && val !== null && val !== undefined && !Number.isNaN(Number(val)) && Number(val) === Number(defaultVal);
  btn.style.display = isDefault ? 'none' : 'inline-flex';
}

function onEnhancementNumberInput(input, key) {
  syncEnhancementResetButton(key, input.value.trim());
}

function resetSingleEnhancement(key) {
  ensureModelMapDefaults();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROXY_ENHANCEMENT, key)) return;
  const defaultVal = DEFAULT_PROXY_ENHANCEMENT[key];
  modelMapStore.enhancement[key] = defaultVal;
  const input = document.getElementById(`enhancement-${key}`);
  if (input) {
    input.value = defaultVal;
  }
  syncEnhancementResetButton(key, defaultVal);
  autoSaveEnhancement();
}

function setSelfHealControlsEnabled(enabled) {
  ['signature', 'budget', 'media'].forEach(key => {
    const el = document.getElementById(`enhancement-selfHeal-${key}`);
    if (el) el.disabled = !enabled;
  });
}

function updateEnhancementNumber(input, key) {
  ensureModelMapDefaults();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROXY_ENHANCEMENT, key)) return;
  const min = key === 'visionMaxTokens' ? 64
    : key === 'visionContextMaxChars' ? 500
      : (key === 'retryMaxRetries' || key === 'rateLimitRpm'
        || key === 'cooldownTransientSeconds' || key === 'cooldownAuthSeconds') ? 0 : 1;
  const value = normalizeEnhancementInt(input.value, DEFAULT_PROXY_ENHANCEMENT[key], min);
  modelMapStore.enhancement[key] = value;
  input.value = value;
  syncEnhancementResetButton(key, value);
  autoSaveEnhancement();
}

function updateVisionMultiImageMode(select) {
  updateEnhancementSelect(select, 'visionMultiImageMode');
  setVisionBatchSizeEnabled(select.value === 'chunk' && modelMapStore.enhancement.imageFallback !== false);
}

globalThis._enhancementSaveTimer = null;
async function autoSaveEnhancement() {
  if (!globalThis.modelMapLoaded) return;
  ensureModelMapDefaults();
  if (_enhancementSaveTimer) clearTimeout(_enhancementSaveTimer);
  _enhancementSaveTimer = setTimeout(async () => {
    _enhancementSaveTimer = null;
    if (await persistModelMap()) {
      if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
    } else if (lastSavedProxyEnhancement) {
      modelMapStore.enhancement = cloneProxyEnhancement(lastSavedProxyEnhancement);
      renderProxyEnhancement();
      if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
    }
  }, 400);
}

async function saveProxyEnhancement() {
  ensureModelMapDefaults();
  if (_enhancementSaveTimer) { clearTimeout(_enhancementSaveTimer); _enhancementSaveTimer = null; }
  if (await persistModelMap()) {
    addLog('ok', '已保存网关增强配置');
    await renderModelMap();
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
    const modal = document.getElementById('proxyEnhancementModal');
    if (modal?.classList.contains('editor-overlay')) closeProxyEnhancement();
  } else if (lastSavedProxyEnhancement) {
    modelMapStore.enhancement = cloneProxyEnhancement(lastSavedProxyEnhancement);
    renderProxyEnhancement();
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  }
}

function resetProxyEnhancementDefaults() {
  ensureModelMapDefaults();
  modelMapStore.enhancement = defaultProxyEnhancement();
  renderProxyEnhancement();
  autoSaveEnhancement();
}

function renderProxyVisionModelList() {
  ensureModelMapDefaults();
  const wrap = document.getElementById('proxyVisionModelList');
  if (!wrap) return;
  const items = modelMapStore.visionModels.imageModels;
  if (!items.length) {
    wrap.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:9px;color:var(--text-muted);font-size:12px;text-align:center;">尚未配置图片理解模型。添加后可在映射列表启用第三方图片理解。</div>';
    return;
  }
  wrap.innerHTML = items.map((item, idx) => {
    const p = (providerStore.providers || []).find(x => x.id === item.providerId);
    const invalid = !p || p.enabled === false;
    const caps = p ? providerCapabilities(p, item.model || p.defaultModel || null) : null;
    const capText = caps?.vision === true ? '已知支持图片' : '未确认图片能力';
    const capColor = caps?.vision === true ? 'var(--success)' : 'var(--text-muted)';
    const key = visionModelKey(item.providerId, item.model, item.apiFormat);
    const testing = proxyVisionTestingKey === key;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid ${invalid ? 'rgba(217,119,6,.28)' : 'var(--border)'};border-radius:9px;background:var(--bg-card);">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
          <span style="width:24px;height:24px;border-radius:6px;background:var(--bg-input);color:var(--text-muted);font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">${idx + 1}</span>
          <div style="display:flex;flex-direction:column;gap:3px;min-width:0;">
            <strong style="font-size:12.5px;color:${invalid ? 'var(--warn,#d97706)' : 'var(--text-primary)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escAttr(visionModelLabel(item))}</strong>
            <span style="font-size:12px;color:${capColor};">${invalid ? '供应商不可用' : capText}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <button class="btn-ghost" data-action="moveVisionModel" data-args="[${idx},-1]" ${idx === 0 ? 'disabled' : ''} style="height:28px;padding:0 8px;border-radius:7px;font-size:12px;">↑</button>
          <button class="btn-ghost" data-action="moveVisionModel" data-args="[${idx},1]" ${idx === items.length - 1 ? 'disabled' : ''} style="height:28px;padding:0 8px;border-radius:7px;font-size:12px;">↓</button>
          <button id="vision-test-btn-${idx}" class="btn-ghost" data-action="testVisionModel" data-args="[${idx}]" ${testing ? 'disabled' : ''} style="height:28px;padding:0 9px;border-radius:7px;font-size:12px;">${testing ? '测试中...' : '测试'}</button>
          <button class="btn-ghost" data-action="removeVisionModel" data-args="[${idx}]" style="height:28px;padding:0 8px;border-radius:7px;font-size:12px;">✕</button>
        </div>
      </div>`;
  }).join('');
}

function toggleVisionModelPicker() {
  setVisionModelPickerOpen(!proxyVisionPickerOpen);
}

function closeVisionModelPicker() {
  setVisionModelPickerOpen(false);
}

function setVisionModelPickerOpen(open) {
  proxyVisionPickerOpen = open === true;
  const picker = document.getElementById('proxyVisionModelPicker');
  if (picker) {
    picker.classList.toggle('is-open', proxyVisionPickerOpen);
    picker.setAttribute('aria-hidden', proxyVisionPickerOpen ? 'false' : 'true');
  }
  if (proxyVisionPickerOpen) {
    proxyVisionProviderSearch = '';
    proxyVisionPickedModels = new Map();
    const search = document.getElementById('proxyVisionModelSearch');
    if (search) search.value = '';
    const providers = visionModelProviderEntries();
    if (!providers.some(provider => provider.providerId === proxyVisionSelectedProviderId)) {
      proxyVisionSelectedProviderId = providers[0]?.providerId || '';
    }
    if (search) setTimeout(() => search.focus(), 0);
  }
  renderVisionModelPicker();
}

function collectVisionModelOptions() {
  const options = [];
  (providerStore.providers || []).forEach(p => {
    if (!p || p.enabled === false || p.meta?.codexConfig === true) return;
    providerSelectedModels(p).forEach(model => {
      const caps = providerCapabilities(p, model);
      ['openai', 'anthropic', 'gemini'].forEach(apiFormat => {
        options.push({ providerId: p.id, providerName: p.name || p.id, model, apiFormat, vision: caps.vision === true });
      });
    });
  });
  return options.sort((a, b) => Number(b.vision) - Number(a.vision) || a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model));
}

function visionFormatLabel(apiFormat) {
  const fmt = normalizeMappingApiFormat(apiFormat);
  if (fmt === 'anthropic') return 'Anthropic';
  if (fmt === 'gemini') return 'Gemini';
  return 'OpenAI';
}

function visionOptionKey(option) {
  return visionModelKey(option.providerId, option.model, option.apiFormat);
}

function visionModelIcon(modelId) {
  if (typeof renderModelIcon === 'function') return renderModelIcon(modelId);
  const initial = String(modelId || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="model-item-icon fallback">${escAttr(initial)}</div>`;
}

function visionModelProviderEntries() {
  const groups = new Map();
  collectVisionModelOptions().forEach(option => {
    if (!groups.has(option.providerId)) {
      groups.set(option.providerId, {
        providerId: option.providerId,
        providerName: option.providerName || option.providerId,
        models: [],
      });
    }
    groups.get(option.providerId).models.push(option);
  });
  return Array.from(groups.values()).sort((a, b) => a.providerName.localeCompare(b.providerName) || a.providerId.localeCompare(b.providerId));
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.batchDeleteSelectedSlots = batchDeleteSelectedSlots;
  g.renderProxyEnhancement = renderProxyEnhancement;
  g.renderHeaderList = renderHeaderList;
  g.addHeaderPair = addHeaderPair;
  g.updateHeaderPair = updateHeaderPair;
  g.removeHeaderPair = removeHeaderPair;
  g.updateEnhancementText = updateEnhancementText;
  g.updateEnhancementSelect = updateEnhancementSelect;
  g.updateParamOverrides = updateParamOverrides;
  g.updateToolFilterList = updateToolFilterList;
  g.openProxyEnhancement = openProxyEnhancement;
  g.closeProxyEnhancement = closeProxyEnhancement;
  g.toggleEnhancement = toggleEnhancement;
  g.toggleSelfHeal = toggleSelfHeal;
  g.setPanelControlsEnabled = setPanelControlsEnabled;
  g.setVisionOptionControlsEnabled = setVisionOptionControlsEnabled;
  g.setVisionBatchSizeEnabled = setVisionBatchSizeEnabled;
  g.setRetryConfigControlsEnabled = setRetryConfigControlsEnabled;
  g.setCooldownConfigControlsEnabled = setCooldownConfigControlsEnabled;
  g.syncEnhancementResetButton = syncEnhancementResetButton;
  g.onEnhancementNumberInput = onEnhancementNumberInput;
  g.resetSingleEnhancement = resetSingleEnhancement;
  g.setSelfHealControlsEnabled = setSelfHealControlsEnabled;
  g.updateEnhancementNumber = updateEnhancementNumber;
  g.updateVisionMultiImageMode = updateVisionMultiImageMode;
  g.autoSaveEnhancement = autoSaveEnhancement;
  g.saveProxyEnhancement = saveProxyEnhancement;
  g.resetProxyEnhancementDefaults = resetProxyEnhancementDefaults;
  g.renderProxyVisionModelList = renderProxyVisionModelList;
  g.toggleVisionModelPicker = toggleVisionModelPicker;
  g.closeVisionModelPicker = closeVisionModelPicker;
  g.setVisionModelPickerOpen = setVisionModelPickerOpen;
  g.collectVisionModelOptions = collectVisionModelOptions;
  g.visionFormatLabel = visionFormatLabel;
  g.visionOptionKey = visionOptionKey;
  g.visionModelIcon = visionModelIcon;
  g.visionModelProviderEntries = visionModelProviderEntries;
})(globalThis);
