// model-map/vision-and-search.js — 图片理解模型选择器与联网搜索源配置
import { escapeHtml, escAttr } from '../ui/dom.js';

function visionProviderSearchHaystack(provider) {
  return [
    provider?.providerName,
    provider?.providerId,
    ...(provider?.models || []).flatMap(model => [model.model, model.apiFormat, visionFormatLabel(model.apiFormat)]),
  ].map(x => String(x || '').toLowerCase()).join(' ');
}

function visibleVisionModelProviders() {
  const terms = String(proxyVisionProviderSearch || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = visionModelProviderEntries();
  if (!terms.length) return list;
  return list.filter(provider => {
    const haystack = visionProviderSearchHaystack(provider);
    return terms.every(term => haystack.includes(term));
  });
}

function visionModelProviderEntry(providerId) {
  return visionModelProviderEntries().find(provider => provider.providerId === providerId) || null;
}

function totalPickedVisionModelCount() {
  let total = 0;
  proxyVisionPickedModels.forEach(bucket => { total += bucket.size; });
  return total;
}

function currentVisionProviderPickedCount() {
  return proxyVisionPickedModels.get(proxyVisionSelectedProviderId)?.size || 0;
}

function onVisionModelPickerSearch() {
  proxyVisionProviderSearch = document.getElementById('proxyVisionModelSearch')?.value || '';
  const providers = visibleVisionModelProviders();
  if (!providers.some(provider => provider.providerId === proxyVisionSelectedProviderId)) {
    proxyVisionSelectedProviderId = providers[0]?.providerId || '';
  }
  renderVisionModelPicker();
}

function selectVisionModelProvider(providerId) {
  proxyVisionSelectedProviderId = String(providerId || '').trim();
  renderVisionModelPicker();
}

function toggleVisionModelOption(providerId, optionKey) {
  const provider = visionModelProviderEntry(providerId);
  const option = (provider?.models || []).find(item => visionOptionKey(item) === optionKey);
  if (!option) return;
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  if (configured.has(optionKey)) return;
  let bucket = proxyVisionPickedModels.get(providerId);
  if (!bucket) {
    bucket = new Set();
    proxyVisionPickedModels.set(providerId, bucket);
  }
  if (bucket.has(optionKey)) {
    bucket.delete(optionKey);
    if (!bucket.size) proxyVisionPickedModels.delete(providerId);
  } else {
    bucket.add(optionKey);
  }
  renderVisionModelPicker();
}

function selectAllVisionModels() {
  const provider = visionModelProviderEntry(proxyVisionSelectedProviderId);
  if (!provider) return;
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  const available = (provider.models || []).map(visionOptionKey).filter(key => !configured.has(key));
  if (!available.length) return;
  proxyVisionPickedModels.set(provider.providerId, new Set(available));
  renderVisionModelPicker();
}

function selectNoVisionModels() {
  proxyVisionPickedModels.delete(proxyVisionSelectedProviderId);
  renderVisionModelPicker();
}

function syncVisionModelPickerActions() {
  const provider = visionModelProviderEntry(proxyVisionSelectedProviderId);
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  const available = provider ? (provider.models || []).filter(option => !configured.has(visionOptionKey(option))) : [];
  const picked = totalPickedVisionModelCount();
  const currentPicked = currentVisionProviderPickedCount();
  const allBtn = document.getElementById('proxyVisionSelectAllBtn');
  const noneBtn = document.getElementById('proxyVisionSelectNoneBtn');
  const addBtn = document.getElementById('proxyVisionAddSelectedBtn');
  const summary = document.getElementById('proxyVisionPickedSummary');
  if (allBtn) allBtn.disabled = !available.length || currentPicked === available.length;
  if (noneBtn) noneBtn.disabled = currentPicked === 0;
  if (addBtn) addBtn.disabled = picked === 0;
  if (summary) summary.textContent = picked ? `已选择 ${picked} 个模型` : '未选择模型';
}

function renderVisionModelPicker() {
  const providerList = document.getElementById('proxyVisionProviderList');
  const modelList = document.getElementById('proxyVisionModelPickerList');
  const title = document.getElementById('proxyVisionModelProviderTitle');
  const sub = document.getElementById('proxyVisionModelProviderSub');
  if (!providerList || !modelList) return;
  ensureModelMapDefaults();
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  const providers = visibleVisionModelProviders();
  if (!providers.some(provider => provider.providerId === proxyVisionSelectedProviderId)) {
    proxyVisionSelectedProviderId = providers[0]?.providerId || '';
  }

  if (!providers.length) {
    providerList.innerHTML = `<div class="proxy-route-picker-empty">${visionModelProviderEntries().length ? '没有匹配的供应商或模型' : '暂无可用供应商'}</div>`;
  } else {
    providerList.innerHTML = providers.map(provider => {
      const active = provider.providerId === proxyVisionSelectedProviderId;
      const isLP = isLocalProxyProviderEntry(provider);
      return `
        <button type="button" class="proxy-route-provider-item ${active ? 'active' : ''} ${isLP ? 'is-local-proxy' : ''}" data-action="selectVisionModelProvider" data-arg="${escAttr(provider.providerId)}">
          <span class="proxy-route-provider-icon">${escAttr(String(provider.providerName || provider.providerId || '?').trim().charAt(0).toUpperCase() || '?')}</span>
          <span class="proxy-route-provider-name">${escAttr(provider.providerName || provider.providerId)}${isLP ? '<span class="proxy-route-prov-badge">内置供应商</span>' : ''}</span>
          <span class="proxy-route-provider-count">${provider.models.length}</span>
        </button>
      `;
    }).join('');
  }

  const selectedProvider = visionModelProviderEntry(proxyVisionSelectedProviderId);
  if (!selectedProvider) {
    if (title) title.textContent = '请选择供应商';
    if (sub) sub.textContent = '右侧会展示可加入图片理解链的模型';
    modelList.innerHTML = '<div class="proxy-route-picker-empty">先从左侧选择供应商</div>';
    syncVisionModelPickerActions();
    return;
  }

  const pickedCount = currentVisionProviderPickedCount();
  if (title) title.textContent = selectedProvider.providerName || selectedProvider.providerId;
  if (sub) sub.textContent = `共 ${selectedProvider.models.length} 个模型，当前已选 ${pickedCount} 个`;
  if (!selectedProvider.models.length) {
    modelList.innerHTML = '<div class="proxy-route-picker-empty">该供应商暂无可选模型</div>';
    syncVisionModelPickerActions();
    return;
  }

  const bucket = proxyVisionPickedModels.get(selectedProvider.providerId) || new Set();
  modelList.innerHTML = selectedProvider.models.map(option => {
    const key = visionOptionKey(option);
    const already = configured.has(key);
    const active = already || bucket.has(key);
    return `
      <button type="button" class="proxy-route-model-item proxy-vision-model-item ${active ? 'active' : ''} ${already ? 'is-disabled' : ''}"
        ${already ? 'disabled' : ''} data-action="toggleVisionModelOption" data-args="[&quot;${escAttr(selectedProvider.providerId)}&quot;,&quot;${escAttr(key)}&quot;]">
        <span class="proxy-route-model-check">${active ? '&#10003;' : ''}</span>
        ${visionModelIcon(option.model)}
        <span class="proxy-route-model-name">
          <strong>${escAttr(option.model)}</strong>
          <small>${escAttr(visionFormatLabel(option.apiFormat))} · ${option.vision ? '已知支持图片' : '未确认图片能力'}</small>
        </span>
      </button>`;
  }).join('');
  syncVisionModelPickerActions();
}

async function addSelectedVisionModels() {
  ensureModelMapDefaults();
  const prev = modelMapStore.visionModels.imageModels.slice();
  const existing = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  let added = 0;
  proxyVisionPickedModels.forEach(bucket => {
    bucket.forEach(key => {
      const decoded = decodeVisionModelKey(key);
      const providerId = decoded.providerId || '';
      const model = decoded.model || '';
      const apiFormat = normalizeMappingApiFormat(decoded.apiFormat) || 'openai';
      if (providerId && model && !existing.has(key)) {
        modelMapStore.visionModels.imageModels.push({ providerId, model, apiFormat });
        existing.add(key);
        added += 1;
      }
    });
  });
  if (!added) return;
  proxyVisionPickedModels = new Map();
  closeVisionModelPicker();
  renderProxyEnhancement();
  if (await persistModelMap()) {
    addLog('ok', `已保存 ${added} 个图片理解模型`);
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  } else {
    modelMapStore.visionModels.imageModels = prev;
    renderProxyEnhancement();
  }
}

async function removeVisionModel(idx) {
  ensureModelMapDefaults();
  const prev = modelMapStore.visionModels.imageModels.slice();
  modelMapStore.visionModels.imageModels.splice(idx, 1);
  renderProxyEnhancement();
  if (await persistModelMap()) {
    addLog('info', '已删除图片理解模型');
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  } else {
    modelMapStore.visionModels.imageModels = prev;
    renderProxyEnhancement();
  }
}

async function moveVisionModel(idx, dir) {
  ensureModelMapDefaults();
  const list = modelMapStore.visionModels.imageModels;
  const next = idx + dir;
  if (next < 0 || next >= list.length) return;
  const prev = list.slice();
  const tmp = list[idx];
  list[idx] = list[next];
  list[next] = tmp;
  renderProxyEnhancement();
  if (await persistModelMap()) {
    addLog('info', '已保存图片理解模型顺序');
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  } else {
    modelMapStore.visionModels.imageModels = prev;
    renderProxyEnhancement();
  }
}

globalThis.SEARCH_SOURCE_PRESETS = Object.freeze([
  { key: 'tavily', type: 'api', label: 'Tavily', needsKey: true, defaultHost: 'https://api.tavily.com' },
  { key: 'serper', type: 'api', label: 'Serper', needsKey: true, defaultHost: 'https://google.serper.dev' },
  { key: 'bravesearch', type: 'api', label: 'Brave Search', needsKey: true, defaultHost: 'https://api.search.brave.com' },
  { key: 'duckduckgo', type: 'engine', label: 'DuckDuckGo', needsKey: false, defaultHost: '' },
  { key: 'searxng', type: 'engine', label: 'SearXNG', needsKey: false, defaultHost: '' },
]);

function searchSourceDisplayName(key) {
  const preset = SEARCH_SOURCE_PRESETS.find(x => x.key === String(key || '').toLowerCase());
  return preset?.label || String(key || 'Search');
}

function searchSourcePreset(key) {
  return SEARCH_SOURCE_PRESETS.find(x => x.key === String(key || '').toLowerCase()) || null;
}

function searchSourceKey(src) {
  return String(src?.engine || src?.provider || '').trim().toLowerCase();
}

function renderProxySearchSourceList() {
  ensureModelMapDefaults();
  const wrap = document.getElementById('proxySearchSourceList');
  if (!wrap) return;
  const items = modelMapStore.searchModels.searchSources;
  if (!items.length) {
    wrap.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:9px;color:var(--text-muted);font-size:12px;text-align:center;">尚未配置搜索源。目标模型无内置搜索时，需要至少一个启用的搜索源。</div>';
    return;
  }
  wrap.innerHTML = items.map((src, idx) => {
    const key = searchSourceKey(src);
    const preset = searchSourcePreset(key);
    const needsKey = preset?.needsKey === true;
    const isEngine = src.type === 'engine';
    const testing = proxySearchTestingId === src.id;
    return `
      <div style="display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:9px;min-width:0;">
            <span style="width:24px;height:24px;border-radius:7px;background:var(--bg-input);color:var(--text-muted);font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;">${idx + 1}</span>
            <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              <strong style="font-size:12.5px;color:var(--text-primary);">${escAttr(src.name || searchSourceDisplayName(key))}</strong>
              <small style="font-size:12px;color:var(--text-muted);">${isEngine ? '搜索引擎' : '搜索 API'} · ${escAttr(key)}</small>
            </div>
          </div>
          <label class="toggle-switch" title="启用搜索源">
            <input type="checkbox" ${src.enabled !== false ? 'checked' : ''} data-action="toggleSearchSourceEnabled" data-events="change" data-args="[${idx}]" data-pass-checked>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">
          <label style="display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-muted);">
            API Key
            <input type="password" value="${escAttr(src.apiKey || '')}" ${needsKey ? '' : 'disabled'} placeholder="${needsKey ? '必填' : '无需 API Key'}" data-action="updateSearchSourceField" data-events="change" data-args="[${idx},&quot;apiKey&quot;]" data-pass-value style="height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-primary);">
          </label>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-muted);">
            API Host
            <input type="text" value="${escAttr(src.apiHost || '')}" placeholder="${escAttr(preset?.defaultHost || (key === 'searxng' ? 'https://your-searxng.example.com' : '默认'))}" ${key === 'duckduckgo' ? 'disabled' : ''} data-action="updateSearchSourceField" data-events="change" data-args="[${idx},&quot;apiHost&quot;]" data-pass-value style="height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-primary);">
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
          <button class="btn-ghost" data-action="moveSearchSource" data-args="[${idx},-1]" ${idx === 0 ? 'disabled' : ''} style="height:28px;padding:0 8px;border-radius:7px;font-size:12px;">↑</button>
          <button class="btn-ghost" data-action="moveSearchSource" data-args="[${idx},1]" ${idx === items.length - 1 ? 'disabled' : ''} style="height:28px;padding:0 8px;border-radius:7px;font-size:12px;">↓</button>
          <button class="btn-ghost" data-action="testSearchSource" data-args="[${idx}]" ${testing ? 'disabled' : ''} style="height:28px;padding:0 9px;border-radius:7px;font-size:12px;">${testing ? '测试中...' : '测试'}</button>
          <button class="btn-ghost" data-action="removeSearchSource" data-args="[${idx}]" style="height:28px;padding:0 8px;border-radius:7px;font-size:12px;">删除</button>
        </div>
      </div>`;
  }).join('');
}

function toggleSearchSourcePicker() {
  proxySearchSourcePickerOpen = !proxySearchSourcePickerOpen;
  renderSearchSourcePicker();
}

function closeSearchSourcePicker() {
  proxySearchSourcePickerOpen = false;
  renderSearchSourcePicker();
}

function renderSearchSourcePicker() {
  const wrap = document.getElementById('proxySearchSourcePicker');
  if (!wrap) return;
  wrap.style.display = proxySearchSourcePickerOpen ? 'block' : 'none';
  if (!proxySearchSourcePickerOpen) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px;">
      ${SEARCH_SOURCE_PRESETS.map(preset => `
        <button type="button" class="btn-ghost" data-action="addSearchSource" data-arg="${escAttr(preset.key)}" style="text-align:left;padding:10px;border-radius:9px;border:1px solid var(--border);background:var(--bg-card);display:flex;flex-direction:column;gap:3px;">
          <strong style="font-size:12.5px;color:var(--text-primary);">${escAttr(preset.label)}</strong>
          <small style="font-size:12px;color:var(--text-muted);">${preset.type === 'api' ? 'API' : 'Engine'} · ${preset.needsKey ? '需要 Key' : '无需 Key'}</small>
        </button>`).join('')}
    </div>`;
}

async function addSearchSource(key) {
  ensureModelMapDefaults();
  const preset = searchSourcePreset(key);
  if (!preset) return;
  const prev = modelMapStore.searchModels.searchSources.slice();
  modelMapStore.searchModels.searchSources.push({
    id: `src-${preset.key}-${Date.now().toString(36)}`,
    name: preset.label,
    type: preset.type,
    provider: preset.type === 'api' ? preset.key : '',
    engine: preset.type === 'engine' ? preset.key : '',
    apiKey: '',
    apiHost: preset.defaultHost,
    enabled: true,
  });
  closeSearchSourcePicker();
  renderProxyEnhancement();
  if (!(await persistModelMap())) {
    modelMapStore.searchModels.searchSources = prev;
    renderProxyEnhancement();
  }
}

async function updateSearchSourceField(idx, field, value) {
  ensureModelMapDefaults();
  const src = modelMapStore.searchModels.searchSources[idx];
  if (!src || !['apiKey', 'apiHost'].includes(field)) return;
  src[field] = String(value || '').trim();
  await persistModelMap();
}

async function toggleSearchSourceEnabled(idx, enabled) {
  ensureModelMapDefaults();
  const src = modelMapStore.searchModels.searchSources[idx];
  if (!src) return;
  src.enabled = enabled === true;
  await persistModelMap();
}

async function removeSearchSource(idx) {
  ensureModelMapDefaults();
  const prev = modelMapStore.searchModels.searchSources.slice();
  modelMapStore.searchModels.searchSources.splice(idx, 1);
  renderProxyEnhancement();
  if (!(await persistModelMap())) {
    modelMapStore.searchModels.searchSources = prev;
    renderProxyEnhancement();
  }
}

async function moveSearchSource(idx, dir) {
  ensureModelMapDefaults();
  const list = modelMapStore.searchModels.searchSources;
  const next = idx + dir;
  if (next < 0 || next >= list.length) return;
  const prev = list.slice();
  [list[idx], list[next]] = [list[next], list[idx]];
  renderProxyEnhancement();
  if (!(await persistModelMap())) {
    modelMapStore.searchModels.searchSources = prev;
    renderProxyEnhancement();
  }
}

async function testSearchSource(idx) {
  ensureModelMapDefaults();
  const src = modelMapStore.searchModels.searchSources[idx];
  if (!src) return;
  const query = await showCustomPrompt('输入测试搜索关键词', '今日新闻', '搜索测试');
  if (!query) return;
  proxySearchTestingId = src.id;
  renderProxyEnhancement();
  try {
    const runtime = typeof getLocalProxyRuntimeConfig === 'function' ? getLocalProxyRuntimeConfig('codex') : null;
    const port = typeof getLocalProxyPort === 'function' ? getLocalProxyPort() : 7450;
    const res = await fetch(`http://127.0.0.1:${port}/__byok/web-search/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(runtime?.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}) },
      body: JSON.stringify({ source: src, query, maxResults: 3 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const count = Array.isArray(data.results) ? data.results.length : 0;
    showCustomAlert((data.results || []).map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet || ''}`).join('\n\n') || '没有结果', `搜索测试成功 (${count})`, 'success');
  } catch (e) {
    showCustomAlert(String(e?.message || e), '搜索测试失败', 'error');
  } finally {
    proxySearchTestingId = '';
    renderProxyEnhancement();
  }
}

function isMissingVisionTestCommandMessage(msg) {
  const lower = String(msg || '').toLowerCase();
  return lower.includes('unknown command') || lower.includes('command not found');
}

function closeVisionTestModal() {
  document.getElementById('proxyVisionTestModal')?.classList.remove('active');
}

function setVisionTestState(state, meta, result) {
  const modalEl = document.querySelector('#proxyVisionTestModal .proxy-vision-test-modal');
  const statusEl = document.getElementById('proxyVisionTestStatus');
  const metaEl = document.getElementById('proxyVisionTestMeta');
  const resultEl = document.getElementById('proxyVisionTestResult');
  const statusText = state === 'success' ? '测试通过' : (state === 'error' ? '测试失败' : '测试中');
  if (modalEl) modalEl.dataset.state = state;
  if (statusEl) {
    statusEl.className = `proxy-vision-test-status is-${state}`;
    statusEl.textContent = statusText;
  }
  if (metaEl) metaEl.textContent = meta || '';
  if (resultEl) {
    resultEl.className = `proxy-vision-test-result is-${state}`;
    resultEl.textContent = result || '';
    resultEl.scrollTop = 0;
  }
}

async function testVisionModel(idx) {
  ensureModelMapDefaults();
  const item = modelMapStore.visionModels.imageModels[idx];
  if (!item) return;
  const key = visionModelKey(item.providerId, item.model, item.apiFormat);
  proxyVisionTestingKey = key;
  const modal = document.getElementById('proxyVisionTestModal');
  const image = document.getElementById('proxyVisionTestImage');
  const title = document.getElementById('proxyVisionTestTitle');
  const imageBase64 = await getProxyVisionTestImageBase64();
  if (modal) modal.classList.add('active');
  if (image) image.src = `data:image/png;base64,${imageBase64}`;
  if (title) title.textContent = `图片测试 · ${visionModelLabel(item)}`;
  setVisionTestState('running', '正在发送测试图片...', '等待供应商返回图片理解结果。');
  renderProxyVisionModelList();
  const started = Date.now();
  try {
    const res = await invoke('test_vision', {
      args: { providerId: item.providerId, model: item.model, apiFormat: item.apiFormat, imageBase64 }
    });
    const duration = res?.durationMs ?? (Date.now() - started);
    if (res?.ok === false) {
      const err = res.error || '模型未返回有效图片理解结果';
      const message = isMissingVisionTestCommandMessage(err) ? '图片测试接口待实现，请重启应用加载新版后端。' : err;
      setVisionTestState('error', `失败 · ${duration}ms`, message);
    } else {
      const text = String(res?.text || '测试成功').slice(0, 1200);
      setVisionTestState('success', `成功 · ${duration}ms`, text);
    }
  } catch (e) {
    const msg = String(e || '');
    if (isMissingVisionTestCommandMessage(msg)) {
      setVisionTestState('error', '失败', '图片测试接口待实现，请重启应用加载新版后端。');
    } else {
      setVisionTestState('error', '失败', msg);
    }
  } finally {
    proxyVisionTestingKey = '';
    renderProxyVisionModelList();
  }
}

async function toggleSlotThirdPartyVision(uid, enabled) {
  ensureModelMapDefaults();
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!s) return;
  const prev = s.useThirdPartyVision === true;
  s.useThirdPartyVision = enabled === true;
  if (await persistModelMap()) {
    addLog('ok', `已${enabled ? '启用' : '停用'}「${s.displayName || uid}」的第三方图片理解`);
    await renderModelMap();
  } else {
    s.useThirdPartyVision = prev;
    await renderModelMap();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.visionProviderSearchHaystack = visionProviderSearchHaystack;
  g.visibleVisionModelProviders = visibleVisionModelProviders;
  g.visionModelProviderEntry = visionModelProviderEntry;
  g.totalPickedVisionModelCount = totalPickedVisionModelCount;
  g.currentVisionProviderPickedCount = currentVisionProviderPickedCount;
  g.onVisionModelPickerSearch = onVisionModelPickerSearch;
  g.selectVisionModelProvider = selectVisionModelProvider;
  g.toggleVisionModelOption = toggleVisionModelOption;
  g.selectAllVisionModels = selectAllVisionModels;
  g.selectNoVisionModels = selectNoVisionModels;
  g.syncVisionModelPickerActions = syncVisionModelPickerActions;
  g.renderVisionModelPicker = renderVisionModelPicker;
  g.addSelectedVisionModels = addSelectedVisionModels;
  g.removeVisionModel = removeVisionModel;
  g.moveVisionModel = moveVisionModel;
  g.searchSourceDisplayName = searchSourceDisplayName;
  g.searchSourcePreset = searchSourcePreset;
  g.searchSourceKey = searchSourceKey;
  g.renderProxySearchSourceList = renderProxySearchSourceList;
  g.toggleSearchSourcePicker = toggleSearchSourcePicker;
  g.closeSearchSourcePicker = closeSearchSourcePicker;
  g.renderSearchSourcePicker = renderSearchSourcePicker;
  g.addSearchSource = addSearchSource;
  g.updateSearchSourceField = updateSearchSourceField;
  g.toggleSearchSourceEnabled = toggleSearchSourceEnabled;
  g.removeSearchSource = removeSearchSource;
  g.moveSearchSource = moveSearchSource;
  g.testSearchSource = testSearchSource;
  g.isMissingVisionTestCommandMessage = isMissingVisionTestCommandMessage;
  g.closeVisionTestModal = closeVisionTestModal;
  g.setVisionTestState = setVisionTestState;
  g.testVisionModel = testVisionModel;
  g.toggleSlotThirdPartyVision = toggleSlotThirdPartyVision;
})(globalThis);
