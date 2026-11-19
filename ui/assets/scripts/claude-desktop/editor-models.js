// claude-desktop/editor-models.js — 编辑器来源供应商列表与模型拉取同步
import { escapeHtml, getClaudeDesktopConfigs } from './console.js';
import { getProviderModelList, stripClaudeDesktop1mMarker } from './role-selects.js';

function syncClaudeDesktopRawConfigFromFields() {
  const textarea = document.getElementById('claude-desktop-config-raw-json');
  if (!textarea) return;
  const sonnet = getClaudeDesktopRoleVal('sonnet') || 'claude-3-7-sonnet';
  const opus = getClaudeDesktopRoleVal('opus') || 'claude-3-opus';
  const haiku = getClaudeDesktopRoleVal('haiku') || 'claude-3-5-haiku';
  const fable = getClaudeDesktopRoleVal('fable') || '';

  const cfg = {
    enterprise: {
      custom_models: {
        sonnet: { id: sonnet },
        opus: { id: opus },
        haiku: { id: haiku }
      },
      gateway_url: "http://127.0.0.1:7450/claude-desktop"
    }
  };
  if (fable) {
    cfg.enterprise.custom_models.fable = { id: fable };
  }
  textarea.value = JSON.stringify(cfg, null, 2);
}

let claudeDesktopSourceSearchKw = '';

function onClaudeDesktopSourceSearch() {
  const input = document.getElementById('claude-desktop-source-search-input');
  claudeDesktopSourceSearchKw = (input?.value || '').trim().toLowerCase();
  const activeId = document.getElementById('claude-desktop-config-source-id')?.value || '';
  renderClaudeDesktopSourceList(activeId);
}

export function getClaudeDesktopCombinedSources() {
  let providers = (globalThis.providerStore?.providers || []).filter(p => p && p.enabled !== false && !p.isLocalProxy);

  // 构造并注入 AnyBridge 内置供应商与 CPA 内置供应商到前列，保持和 Cursor / Codex 等页面 100% 一致
  const builtinList = [];
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    if (lp) {
      builtinList.push({
        id: lp.providerId,
        providerId: lp.providerId,
        name: lp.providerName || 'AnyBridge',
        providerName: lp.providerName || 'AnyBridge',
        models: (lp.models || []).map(m => typeof m === 'string' ? m : m.id),
        meta: { localProxy: true },
        isLocalProxy: true
      });
    }
  }

  // 检查是否有 CPA 内置供应商供应商
  const cpaEntry = (globalThis.providerStore?.providers || []).find(p => p && (p.meta?.cpaLocal === true || p.id === 'cpa-local' || p.id === 'cpa' || p.name === 'CPA'));
  if (cpaEntry && !builtinList.some(b => b.id === cpaEntry.id)) {
    builtinList.push(cpaEntry);
  }

  return [...builtinList, ...providers.filter(p => !builtinList.some(b => b.id === p.id))];
}

export function renderClaudeDesktopSourceList(selectedId = '') {
  const list = document.getElementById('claude-desktop-config-source-list');
  if (!list) return;

  if (typeof globalThis.syncPlatformAddSortControl === 'function') {
    globalThis.syncPlatformAddSortControl('claudeDesktop');
  }

  let combined = getClaudeDesktopCombinedSources();

  if (typeof globalThis.platformAddVisibleProviders === 'function') {
    // 映射格式以兼容 platformAddVisibleProviders
    const mapped = combined.map(p => ({
      ...p,
      providerId: p.providerId || p.id,
      providerName: p.providerName || p.name
    }));
    const sorted = globalThis.platformAddVisibleProviders(mapped, claudeDesktopSourceSearchKw);
    combined = sorted;
  } else if (claudeDesktopSourceSearchKw) {
    combined = combined.filter(p => (p.name || p.providerName || p.id).toLowerCase().includes(claudeDesktopSourceSearchKw));
  }

  const count = document.getElementById('claude-desktop-config-source-count');
  if (count) count.textContent = String(combined.length);

  if (combined.length === 0) {
    list.innerHTML = '<div class="codex-config-source-empty">没有匹配的供应商</div>';
    return;
  }

  list.innerHTML = combined.map(p => {
    const pid = p.providerId || p.id;
    const pname = p.providerName || p.name || pid;
    const active = pid === selectedId;
    const isBuiltin = typeof globalThis.isBuiltinProxyEntry === 'function' ? globalThis.isBuiltinProxyEntry(p) : (p.meta?.localProxy || p.meta?.cpaLocal || p.id === 'cpa');

    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="AnyBridge 内置供应商"><span>内置</span><span>供应商</span></span>`
      : `<span class="cb-add-prov-icon">${escapeHtml(pname.charAt(0).toUpperCase())}</span>`;

    const modelCount = (p.models || []).length;
    return `
      <div class="cb-add-prov-item ${active ? 'active' : ''} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="onClaudeDesktopSourceSelect" data-arg="${escapeHtml(pid)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${escapeHtml(pname)}</span>
        <span class="cb-add-prov-count">${modelCount}</span>
      </div>
    `;
  }).join('');
}

function setClaudeDesktopModelStatus(text, tone = '') {
  const el = document.getElementById('claude-desktop-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  if (tone === 'error') {
    el.style.color = 'var(--danger)';
  } else if (tone === 'success') {
    el.style.color = 'var(--success, #10b981)';
  } else if (tone === 'loading') {
    el.style.color = 'var(--accent)';
  } else {
    el.style.color = 'var(--text-muted)';
  }
}

async function fetchClaudeDesktopConfigModels() {
  if (!globalThis.invoke) return;
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value;
  if (!sourceId) {
    showCustomAlert('请先从左侧选择一个供应商。', '无法拉取', 'warn');
    return;
  }

  const providers = globalThis.providerStore?.providers || [];
  let p = providers.find(x => x.id === sourceId || x.providerId === sourceId);
  if (!p && typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    if (lp && (lp.providerId === sourceId || lp.id === sourceId)) {
      const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
      p = {
        id: lp.providerId,
        name: lp.providerName || 'AnyBridge',
        defaultModel: routes[0]?.id || '',
        models: routes.map(r => r.id),
        isLocalProxy: true
      };
    }
  }

  if (!p) {
    showCustomAlert('找不到所选供应商信息。', '无法拉取', 'warn');
    return;
  }

  if (p.meta?.localProxy || p.isLocalProxy || p.id === 'local-proxy' || p.id === 'anybridge' || p.name === 'AnyBridge') {
    if (typeof loadProxyRoutes === 'function') {
      await loadProxyRoutes();
    }
    const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
    populateRoleSelects({
      sourceProviderId: p.id,
      sonnetModel: document.getElementById('claude-desktop-config-sonnet')?.value,
      opusModel: document.getElementById('claude-desktop-config-opus')?.value,
      haikuModel: document.getElementById('claude-desktop-config-haiku')?.value,
      fableModel: document.getElementById('claude-desktop-config-fable')?.value,
    }, p);
    setClaudeDesktopModelStatus(`内置模型路由已刷新，共 ${routes.length} 个可用模型`, 'success');
    if (typeof showBottomToast === 'function') {
      showBottomToast(`内置模型路由已刷新，共 ${routes.length} 个可用模型`, 'success');
    }
    return;
  }

  const btn = document.getElementById('claude-desktop-config-fetch-models-btn');
  const setBtnLoading = (loading) => {
    if (!btn) return;
    btn.classList.toggle('is-loading', !!loading);
    if (loading) {
      setLoading(btn, '拉取中…');
    } else {
      clearLoading(btn);
    }
  };

  const host = p.apiHost || '';
  const apiKey = p.apiKey || '';
  if (!host) {
    showCustomAlert('该供应商未配置 API Host / 地址。', '无法拉取', 'warn');
    return;
  }

  setBtnLoading(true);
  setClaudeDesktopModelStatus('正在拉取模型列表...', 'loading');

  try {
    let result = null;
    let lastError = null;
    const formats = p.apiFormat ? [p.apiFormat] : ['openai', 'anthropic'];
    for (const apiFormat of formats) {
      try {
        const parts = (typeof claudeCodeConfigModelEndpointParts === 'function')
          ? claudeCodeConfigModelEndpointParts(host, apiFormat)
          : { apiHost: host, apiPath: apiFormat === 'openai' ? '/v1' : '/v1/messages' };
        result = await invoke('fetch_models', {
          args: {
            host: parts.apiHost,
            api_key: apiKey,
            api_format: apiFormat,
            path: parts.apiPath || (apiFormat === 'openai' ? '/v1' : '/v1/messages'),
          }
        });
        if (result?.models?.length) break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!result?.models?.length) {
      throw lastError || new Error('接口返回的模型列表为空');
    }

    const fetched = (result.models || []).map(m => typeof m === 'string' ? m : (m?.id || m?.model || '')).filter(Boolean);
    if (!fetched.length) throw new Error('解析到的模型列表为空');

    const cleanFetched = [...new Set(fetched.map(m => stripClaudeDesktop1mMarker(m)).filter(Boolean))];
    p.models = cleanFetched;

    // 同步到 providerStore 并持久化
    const synced = await mutateProviderStore(store => {
      const pInStore = (store.providers || []).find(pr => pr.id === p.id);
      if (!pInStore) return false;
      pInStore.models = [...cleanFetched];
    }, { silent: true });
    if (synced) {
      const pInStore = (globalThis.providerStore?.providers || []).find(pr => pr.id === p.id);
      if (pInStore) p.models = [...pInStore.models];
    }

    // 更新角色选择：如果当前选中的值不在新拉取的模型中，重新智能匹配
    const sonnetInput = document.getElementById('claude-desktop-config-sonnet');
    const opusInput = document.getElementById('claude-desktop-config-opus');
    const haikuInput = document.getElementById('claude-desktop-config-haiku');
    const fableInput = document.getElementById('claude-desktop-config-fable');

    let sonnetVal = stripClaudeDesktop1mMarker(sonnetInput?.value || '');
    let opusVal = stripClaudeDesktop1mMarker(opusInput?.value || '');
    let haikuVal = stripClaudeDesktop1mMarker(haikuInput?.value || '');
    let fableVal = stripClaudeDesktop1mMarker(fableInput?.value || '');

    if (!cleanFetched.includes(sonnetVal)) {
      sonnetVal = pickBestModelForRole('sonnetModel', cleanFetched, p.defaultModel);
      const nameEl = document.getElementById('claude-desktop-config-sonnet-name');
      if (nameEl) nameEl.value = sonnetVal;
    }
    if (!cleanFetched.includes(opusVal)) {
      opusVal = pickBestModelForRole('opusModel', cleanFetched, p.defaultModel);
      const nameEl = document.getElementById('claude-desktop-config-opus-name');
      if (nameEl) nameEl.value = opusVal;
    }
    if (!cleanFetched.includes(haikuVal)) {
      haikuVal = pickBestModelForRole('haikuModel', cleanFetched, p.defaultModel);
      const nameEl = document.getElementById('claude-desktop-config-haiku-name');
      if (nameEl) nameEl.value = haikuVal;
    }
    if (fableVal && !cleanFetched.includes(fableVal)) {
      fableVal = '';
      const nameEl = document.getElementById('claude-desktop-config-fable-name');
      if (nameEl) nameEl.value = '';
    }

    populateRoleSelects({
      sourceProviderId: p.id,
      sonnetModel: sonnetVal,
      opusModel: opusVal,
      haikuModel: haikuVal,
      fableModel: fableVal,
    }, p);

    renderClaudeDesktopSourceList(p.id);
    setClaudeDesktopModelStatus(`已拉取 ${cleanFetched.length} 个模型并更新到下拉框`, 'success');
    if (typeof addLog === 'function') addLog('ok', `[Claude Desktop] 成功为「${p.name || p.id}」拉取 ${fetched.length} 个模型`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已成功拉取 ${fetched.length} 个模型`, 'success');
    }
  } catch (e) {
    setClaudeDesktopModelStatus('拉取失败，可点击自定义输入模型', 'error');
    if (typeof addLog === 'function') addLog('warn', `[Claude Desktop] 拉取模型失败: ${e}`);
    showCustomAlert(`拉取模型失败: ${e.message || e}`, '拉取失败', 'error');
  } finally {
    setBtnLoading(false);
  }
}

function onClaudeDesktopSourceSelect(providerId) {
  const providers = globalThis.providerStore?.providers || [];
  let p = providers.find(x => x.id === providerId || x.providerId === providerId);

  if (!p && typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    if (lp && (lp.providerId === providerId || lp.id === providerId)) {
      const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
      p = {
        id: lp.providerId,
        name: lp.providerName || 'AnyBridge',
        defaultModel: routes[0]?.id || '',
        models: routes.map(r => r.id),
        isLocalProxy: true
      };
    }
  }

  if (!p) return;

  renderClaudeDesktopSourceList(providerId);

  const sourceIdInput = document.getElementById('claude-desktop-config-source-id');
  if (sourceIdInput) sourceIdInput.value = p.id;

  const nameInput = document.getElementById('claude-desktop-config-name');
  if (nameInput) {
    const cur = (nameInput.value || '').trim();
    if (!cur || cur.includes('方案') || cur.includes('预设') || cur === 'AnyBridge' || providers.some(item => item.name === cur || item.id === cur)) {
      nameInput.value = p.name || p.id;
    }
  }

  if (p.isLocalProxy || p.meta?.localProxy || p.id === 'local-proxy' || p.id === 'anybridge' || p.name === 'AnyBridge') {
    const baseUrlInput = document.getElementById('claude-desktop-config-base-url');
    if (baseUrlInput) baseUrlInput.value = 'http://127.0.0.1:7450/v1';
    const apiKeyInput = document.getElementById('claude-desktop-config-api-key');
    if (apiKeyInput) {
      apiKeyInput.value = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : (p.apiKey || '');
    }
  } else {
    const baseUrlInput = document.getElementById('claude-desktop-config-base-url');
    if (baseUrlInput) {
      const endpoint = p.apiHost ? (p.apiPath ? `${p.apiHost.replace(/\/+$/, '')}${p.apiPath}` : `${p.apiHost.replace(/\/+$/, '')}/v1`) : '';
      baseUrlInput.value = endpoint || p.apiHost || '';
    }
    const apiKeyInput = document.getElementById('claude-desktop-config-api-key');
    if (apiKeyInput) apiKeyInput.value = p.apiKey || '';
  }

  const models = getProviderModelList(p);
  const sonnetVal = pickBestModelForRole('sonnetModel', models, p.defaultModel);
  const opusVal = pickBestModelForRole('opusModel', models, p.defaultModel);
  const haikuVal = pickBestModelForRole('haikuModel', models, p.defaultModel);
  const fableVal = '';

  populateRoleSelects({
    sourceProviderId: p.id,
    sonnetModel: sonnetVal,
    opusModel: opusVal,
    haikuModel: haikuVal,
    fableModel: fableVal,
  }, p);

  ['sonnet', 'opus', 'fable', 'haiku'].forEach(role => {
    const nameInput = document.getElementById(`claude-desktop-config-${role}-name`);
    if (nameInput) {
      const val = (role === 'sonnet' ? sonnetVal : role === 'opus' ? opusVal : role === 'fable' ? fableVal : haikuVal) || '';
      nameInput.value = val;
    }
  });

  setClaudeDesktopModelStatus(`共 ${models.length} 个可用模型（可点击上方拉取更新）`, 'success');
}

globalThis.onClaudeDesktopSourceSearch = onClaudeDesktopSourceSearch;
globalThis.onClaudeDesktopSourceSelect = onClaudeDesktopSourceSelect;
globalThis.syncClaudeDesktopRawConfigFromFields = syncClaudeDesktopRawConfigFromFields;
globalThis.fetchClaudeDesktopConfigModels = fetchClaudeDesktopConfigModels;
globalThis.setClaudeDesktopModelStatus = setClaudeDesktopModelStatus;
