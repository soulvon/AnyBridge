// ═══════ LOCAL PROXY MODEL ROUTES ═══════
let proxyRoutesStore = { version: 1, defaultModelId: '', routes: [], compatFromModelMap: false };
let proxyRouteEditingId = '';
let proxyRouteDraftTargets = [];

function proxyRouteEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeProxyRouteFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'anthropic' ? 'anthropic' : raw === 'openai' ? 'openai' : '';
}

function normalizeProxyRouteTarget(target = {}) {
  return {
    providerId: String(target.providerId || target.provider_id || '').trim(),
    model: String(target.model || '').trim(),
    apiFormat: normalizeProxyRouteFormat(target.apiFormat || target.api_format) || 'openai',
    apiPath: String(target.apiPath || target.api_path || '').trim(),
    unlock: String(target.unlock || '').trim()
  };
}

function normalizeProxyRoute(route = {}) {
  const exposed = Array.isArray(route.exposedFormats)
    ? route.exposedFormats.map(normalizeProxyRouteFormat).filter(Boolean)
    : ['openai', 'anthropic'];
  return {
    id: String(route.id || '').trim(),
    displayName: String(route.displayName || route.display_name || '').trim(),
    enabled: route.enabled !== false,
    exposedFormats: [...new Set(exposed.length ? exposed : ['openai', 'anthropic'])],
    source: String(route.source || 'manual').trim() || 'manual',
    capabilities: {
      stream: route.capabilities?.stream === true,
      tools: route.capabilities?.tools === true,
      vision: route.capabilities?.vision === true,
      reasoning: route.capabilities?.reasoning === true,
    },
    enhancement: {
      retry: route.enhancement?.retry !== false,
      autoRouting: route.enhancement?.autoRouting !== false,
      thirdPartyVision: route.enhancement?.thirdPartyVision === true,
    },
    targets: Array.isArray(route.targets) ? route.targets.map(normalizeProxyRouteTarget).filter(t => t.providerId || t.model) : [],
  };
}

function normalizeProxyRoutesStore(store = {}) {
  const routes = Array.isArray(store.routes) ? store.routes.map(normalizeProxyRoute).filter(route => route.id) : [];
  const enabled = routes.filter(route => route.enabled !== false);
  const defaultModelId = String(store.defaultModelId || '').trim();
  return {
    version: Number(store.version) || 1,
    defaultModelId: enabled.some(route => route.id === defaultModelId) ? defaultModelId : (enabled[0]?.id || ''),
    routes,
    compatFromModelMap: store.compatFromModelMap === true,
  };
}

function proxyRouteProvider(providerId) {
  return (providerStore.providers || []).find(provider => provider.id === providerId) || null;
}

function proxyRouteProviderName(providerId) {
  const provider = proxyRouteProvider(providerId);
  return provider ? (provider.name || provider.id) : (providerId || '未选择供应商');
}

function proxyRouteTargetLabel(target) {
  const provider = proxyRouteProviderName(target.providerId);
  const model = target.model || '未填写模型';
  const format = normalizeProxyRouteFormat(target.apiFormat) === 'anthropic' ? 'Claude' : 'OpenAI';
  return `${provider} / ${model} · ${format}`;
}

function getEnabledProxyRouteModels(format = 'openai') {
  const fmt = normalizeProxyRouteFormat(format) || 'openai';
  const routes = Array.isArray(proxyRoutesStore.routes) ? proxyRoutesStore.routes : [];
  return routes
    .filter(route => route.enabled !== false)
    .filter(route => (route.exposedFormats || []).includes(fmt))
    .map(route => route.id);
}

function getProxyRouteDefaultModel(format = 'openai') {
  const models = getEnabledProxyRouteModels(format);
  if (models.includes(proxyRoutesStore.defaultModelId)) return proxyRoutesStore.defaultModelId;
  return models[0] || '';
}

async function loadProxyRoutes() {
  if (!invoke) return;
  try {
    const store = await invoke('load_proxy_routes');
    proxyRoutesStore = normalizeProxyRoutesStore(store);
    renderProxyRoutes();
    if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
    if (typeof renderAllPlatformAccessModeUi === 'function') renderAllPlatformAccessModeUi();
  } catch (e) {
    addLog('err', '加载本地代理模型路由失败: ' + e);
  }
}

async function saveProxyRoutes(options = {}) {
  if (!invoke) return false;
  try {
    proxyRoutesStore = normalizeProxyRoutesStore(proxyRoutesStore);
    await invoke('save_proxy_routes', { store: proxyRoutesStore });
    proxyRoutesStore.compatFromModelMap = false;
    renderProxyRoutes();
    if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
    if (typeof renderAllPlatformAccessModeUi === 'function') renderAllPlatformAccessModeUi();
    if (!options.silent) {
      addLog('ok', `本地代理模型路由已保存: ${proxyRoutesStore.routes.length} 条`);
      showBottomToast('本地代理模型路由已保存', 'success');
    }
    return true;
  } catch (e) {
    addLog('err', '保存本地代理模型路由失败: ' + e);
    showCustomAlert(String(e), '保存失败', 'error');
    return false;
  }
}

async function importProxyRoutesFromModelMap() {
  if (!invoke) return;
  try {
    const result = await invoke('import_proxy_routes_from_model_map');
    proxyRoutesStore = normalizeProxyRoutesStore(result?.store || {});
    renderProxyRoutes();
    if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
    if (typeof renderAllPlatformAccessModeUi === 'function') renderAllPlatformAccessModeUi();
    const imported = Number(result?.imported || 0);
    const skipped = Number(result?.skipped || 0);
    addLog('ok', `已从平台模型映射导入代理模型路由: 新增 ${imported} 条，跳过 ${skipped} 条`);
    showCustomAlert(`已新增 ${imported} 条代理模型路由，跳过 ${skipped} 条重复路由。`, '导入完成', skipped ? 'info' : 'success');
  } catch (e) {
    addLog('err', '导入代理模型路由失败: ' + e);
    showCustomAlert(String(e), '导入失败', 'error');
  }
}

function setProxyRoutesDefault(modelId) {
  proxyRoutesStore.defaultModelId = String(modelId || '').trim();
  renderProxyRoutes();
  if (typeof syncLocalProxyUi === 'function') syncLocalProxyUi();
  if (typeof renderAllPlatformAccessModeUi === 'function') renderAllPlatformAccessModeUi();
}

function toggleProxyRouteEnabled(routeId, checked) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  route.enabled = checked === true;
  if (!route.enabled && proxyRoutesStore.defaultModelId === route.id) {
    proxyRoutesStore.defaultModelId = getEnabledProxyRouteModels('openai').find(id => id !== route.id) || '';
  }
  renderProxyRoutes();
}

function deleteProxyRoute(routeId) {
  const route = proxyRoutesStore.routes.find(item => item.id === routeId);
  if (!route) return;
  showCustomConfirm(`将删除本地代理模型路由「${route.displayName || route.id}」。`, '删除模型路由', 'warn').then(ok => {
    if (!ok) return;
    proxyRoutesStore.routes = proxyRoutesStore.routes.filter(item => item.id !== routeId);
    if (proxyRoutesStore.defaultModelId === routeId) proxyRoutesStore.defaultModelId = getEnabledProxyRouteModels('openai')[0] || '';
    renderProxyRoutes();
  });
}

function proxyRouteBadges(route) {
  const caps = [];
  if (route.capabilities?.stream) caps.push('流式');
  if (route.capabilities?.tools) caps.push('工具');
  if (route.capabilities?.vision) caps.push('图片');
  if (route.capabilities?.reasoning) caps.push('推理');
  if (route.enhancement?.thirdPartyVision) caps.push('第三方图片');
  return caps.length
    ? caps.map(label => `<span class="proxy-route-badge">${proxyRouteEsc(label)}</span>`).join('')
    : '<span class="proxy-route-muted">未确认</span>';
}

function renderProxyRouteDefaultSelect() {
  const select = document.getElementById('proxyRoutesDefaultModel');
  if (!select) return;
  const enabled = proxyRoutesStore.routes.filter(route => route.enabled !== false);
  select.innerHTML = [
    '<option value="">未设置</option>',
    ...enabled.map(route => `<option value="${proxyRouteEsc(route.id)}">${proxyRouteEsc(route.displayName || route.id)}</option>`)
  ].join('');
  select.value = proxyRoutesStore.defaultModelId || '';
}

function renderProxyRoutes() {
  proxyRoutesStore = normalizeProxyRoutesStore(proxyRoutesStore);
  const body = document.getElementById('proxyRoutesTableBody');
  if (!body) return;
  const query = (document.getElementById('proxyRoutesSearch')?.value || '').trim().toLowerCase();
  const routes = proxyRoutesStore.routes.filter(route => {
    const hay = [
      route.id,
      route.displayName,
      route.source,
      ...(route.targets || []).flatMap(t => [t.providerId, proxyRouteProviderName(t.providerId), t.model, t.apiFormat])
    ].join(' ').toLowerCase();
    return !query || hay.includes(query);
  });
  const enabledCount = proxyRoutesStore.routes.filter(route => route.enabled !== false).length;
  const banner = document.getElementById('proxyRoutesCompatBanner');
  if (banner) banner.style.display = proxyRoutesStore.compatFromModelMap ? '' : 'none';
  setText('proxyRoutesTotal', `路由：${proxyRoutesStore.routes.length}`);
  setText('proxyRoutesEnabled', `启用：${enabledCount}`);
  setText('proxyRoutesDefault', `默认：${proxyRoutesStore.defaultModelId || '未设置'}`);
  setText('proxy-page-route-total', String(proxyRoutesStore.routes.length));
  setText('proxy-page-route-enabled', String(enabledCount));
  setText('proxy-page-route-default', proxyRoutesStore.defaultModelId || '未设置');
  renderProxyRouteDefaultSelect();
  if (typeof renderAllPlatformAccessModeUi === 'function') renderAllPlatformAccessModeUi();

  if (!routes.length) {
    const text = proxyRoutesStore.routes.length
      ? '没有匹配的模型路由'
      : '尚未配置本地代理模型路由。可以从平台模型映射导入，或手动添加第一条路由。';
    body.innerHTML = `<tr><td colspan="7" class="proxy-routes-empty">${proxyRouteEsc(text)}</td></tr>`;
    return;
  }

  body.innerHTML = routes.map(route => {
    const targetText = route.targets?.length
      ? route.targets.map((target, idx) => `<div class="proxy-route-target-line"><span>${idx + 1}</span>${proxyRouteEsc(proxyRouteTargetLabel(target))}</div>`).join('')
      : '<span class="proxy-route-muted">未配置目标</span>';
    const formats = (route.exposedFormats || []).map(fmt => fmt === 'anthropic' ? 'Claude' : 'OpenAI').join(' / ');
    return `
      <tr>
        <td>
          <label class="toggle-switch" title="${route.enabled ? '已启用' : '已禁用'}">
            <input type="checkbox" ${route.enabled ? 'checked' : ''} onchange="toggleProxyRouteEnabled('${proxyRouteEsc(route.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td><code>${proxyRouteEsc(route.id)}</code></td>
        <td>
          <div class="proxy-route-name">${proxyRouteEsc(route.displayName || route.id)}</div>
          <div class="proxy-route-source">${proxyRouteEsc(route.source || 'manual')}</div>
        </td>
        <td>${proxyRouteEsc(formats || '未设置')}</td>
        <td>${targetText}</td>
        <td><div class="proxy-route-badges">${proxyRouteBadges(route)}</div></td>
        <td>
          <div class="proxy-route-row-actions">
            <button class="btn-ghost" onclick="openProxyRouteEditor('${proxyRouteEsc(route.id)}')">编辑</button>
            <button class="btn-ghost danger" onclick="deleteProxyRoute('${proxyRouteEsc(route.id)}')">删除</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function openProxyRouteEditor(routeId = '') {
  proxyRouteEditingId = String(routeId || '').trim();
  const route = proxyRouteEditingId
    ? proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId)
    : null;
  const draft = route ? normalizeProxyRoute(route) : normalizeProxyRoute({
    id: '',
    displayName: '',
    enabled: true,
    exposedFormats: ['openai', 'anthropic'],
    capabilities: { stream: true },
    targets: []
  });
  proxyRouteDraftTargets = draft.targets.length ? draft.targets : [normalizeProxyRouteTarget({ apiFormat: 'openai' })];
  setText('proxyRouteEditorTitle', route ? '编辑模型路由' : '添加模型路由');
  document.getElementById('proxyRouteIdInput').value = draft.id;
  document.getElementById('proxyRouteIdInput').disabled = !!route;
  document.getElementById('proxyRouteNameInput').value = draft.displayName;
  document.getElementById('proxyRouteEnabledInput').checked = draft.enabled !== false;
  document.getElementById('proxyRouteExposeOpenAiInput').checked = draft.exposedFormats.includes('openai');
  document.getElementById('proxyRouteExposeAnthropicInput').checked = draft.exposedFormats.includes('anthropic');
  document.getElementById('proxyRouteCapStreamInput').checked = draft.capabilities.stream === true;
  document.getElementById('proxyRouteCapToolsInput').checked = draft.capabilities.tools === true;
  document.getElementById('proxyRouteCapVisionInput').checked = draft.capabilities.vision === true;
  document.getElementById('proxyRouteCapReasoningInput').checked = draft.capabilities.reasoning === true;
  document.getElementById('proxyRouteRetryInput').checked = draft.enhancement.retry !== false;
  document.getElementById('proxyRouteAutoRoutingInput').checked = draft.enhancement.autoRouting !== false;
  document.getElementById('proxyRouteThirdPartyVisionInput').checked = draft.enhancement.thirdPartyVision === true;
  renderProxyRouteTargetsEditor();
  document.getElementById('proxy-route-editor-modal')?.classList.add('active');
}

function closeProxyRouteEditor() {
  document.getElementById('proxy-route-editor-modal')?.classList.remove('active');
}

function providerOptions(selectedId) {
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true);
  return [
    '<option value="">选择供应商</option>',
    ...providers.map(p => `<option value="${proxyRouteEsc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${proxyRouteEsc(p.name || p.id)}</option>`)
  ].join('');
}

function renderProxyRouteTargetsEditor() {
  const wrap = document.getElementById('proxyRouteTargetsEditor');
  if (!wrap) return;
  if (!proxyRouteDraftTargets.length) proxyRouteDraftTargets.push(normalizeProxyRouteTarget({ apiFormat: 'openai' }));
  wrap.innerHTML = proxyRouteDraftTargets.map((target, idx) => `
    <div class="proxy-route-target-editor-row">
      <span class="proxy-route-target-index">${idx + 1}</span>
      <select onchange="updateProxyRouteTarget(${idx}, 'providerId', this.value)">${providerOptions(target.providerId)}</select>
      <input class="field-input" value="${proxyRouteEsc(target.model)}" placeholder="上游模型 ID" onchange="updateProxyRouteTarget(${idx}, 'model', this.value)">
      <select onchange="updateProxyRouteTarget(${idx}, 'apiFormat', this.value)">
        <option value="openai" ${target.apiFormat === 'openai' ? 'selected' : ''}>OpenAI</option>
        <option value="anthropic" ${target.apiFormat === 'anthropic' ? 'selected' : ''}>Claude</option>
      </select>
      <button class="btn-ghost" onclick="moveProxyRouteTarget(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>上移</button>
      <button class="btn-ghost" onclick="moveProxyRouteTarget(${idx}, 1)" ${idx === proxyRouteDraftTargets.length - 1 ? 'disabled' : ''}>下移</button>
      <button class="btn-ghost danger" onclick="removeProxyRouteTarget(${idx})">删除</button>
    </div>
  `).join('');
}

function updateProxyRouteTarget(index, field, value) {
  if (!proxyRouteDraftTargets[index]) return;
  proxyRouteDraftTargets[index][field] = field === 'apiFormat' ? normalizeProxyRouteFormat(value) || 'openai' : String(value || '').trim();
}

function addProxyRouteTargetRow() {
  proxyRouteDraftTargets.push(normalizeProxyRouteTarget({ apiFormat: 'openai' }));
  renderProxyRouteTargetsEditor();
}

function removeProxyRouteTarget(index) {
  proxyRouteDraftTargets.splice(index, 1);
  renderProxyRouteTargetsEditor();
}

function moveProxyRouteTarget(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= proxyRouteDraftTargets.length) return;
  const item = proxyRouteDraftTargets[index];
  proxyRouteDraftTargets[index] = proxyRouteDraftTargets[next];
  proxyRouteDraftTargets[next] = item;
  renderProxyRouteTargetsEditor();
}

function saveProxyRouteEditor() {
  const id = String(document.getElementById('proxyRouteIdInput')?.value || '').trim();
  if (!id) {
    showCustomAlert('对外模型 ID 不能为空。', '保存失败', 'error');
    return;
  }
  if (!proxyRouteEditingId && proxyRoutesStore.routes.some(route => route.id === id)) {
    showCustomAlert(`模型路由 ID 已存在: ${id}`, '保存失败', 'error');
    return;
  }
  const exposedFormats = [];
  if (document.getElementById('proxyRouteExposeOpenAiInput')?.checked) exposedFormats.push('openai');
  if (document.getElementById('proxyRouteExposeAnthropicInput')?.checked) exposedFormats.push('anthropic');
  if (!exposedFormats.length) {
    showCustomAlert('至少需要暴露一个入口。', '保存失败', 'error');
    return;
  }
  const targets = proxyRouteDraftTargets.map(normalizeProxyRouteTarget).filter(t => t.providerId || t.model);
  if (!targets.length) {
    showCustomAlert('至少需要配置一个路由目标。', '保存失败', 'error');
    return;
  }
  const invalid = targets.find(t => !t.providerId || !t.model || !t.apiFormat);
  if (invalid) {
    showCustomAlert('每个路由目标都必须包含供应商、上游模型 ID 和 API 格式。', '保存失败', 'error');
    return;
  }
  const route = normalizeProxyRoute({
    id,
    displayName: document.getElementById('proxyRouteNameInput')?.value || id,
    enabled: document.getElementById('proxyRouteEnabledInput')?.checked === true,
    exposedFormats,
    source: proxyRouteEditingId ? (proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId)?.source || 'manual') : 'manual',
    capabilities: {
      stream: document.getElementById('proxyRouteCapStreamInput')?.checked === true,
      tools: document.getElementById('proxyRouteCapToolsInput')?.checked === true,
      vision: document.getElementById('proxyRouteCapVisionInput')?.checked === true,
      reasoning: document.getElementById('proxyRouteCapReasoningInput')?.checked === true,
    },
    enhancement: {
      retry: document.getElementById('proxyRouteRetryInput')?.checked === true,
      autoRouting: document.getElementById('proxyRouteAutoRoutingInput')?.checked === true,
      thirdPartyVision: document.getElementById('proxyRouteThirdPartyVisionInput')?.checked === true,
    },
    targets,
  });
  const idx = proxyRoutesStore.routes.findIndex(item => item.id === (proxyRouteEditingId || id));
  if (idx >= 0) proxyRoutesStore.routes[idx] = route;
  else proxyRoutesStore.routes.push(route);
  if (!proxyRoutesStore.defaultModelId && route.enabled) proxyRoutesStore.defaultModelId = route.id;
  closeProxyRouteEditor();
  renderProxyRoutes();
}
