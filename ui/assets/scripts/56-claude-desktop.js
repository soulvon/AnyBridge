// 56-claude-desktop.js — Claude Desktop 本地路由控制台逻辑（独立标准卡片化规范）
import { showCustomAlert, showCustomConfirm } from './ui/feedback.js';

globalThis.claudeDesktopStatus = null;
globalThis.claudeDesktopSearchKw = '';

function getClaudeDesktopModelCandidates() {
  const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
  return routes;
}

function getClaudeDesktopConfigs() {
  if (!globalThis.providerStore) {
    globalThis.providerStore = { providers: [], claudeDesktopConfigs: [] };
  }
  if (!Array.isArray(globalThis.providerStore.claudeDesktopConfigs)) {
    globalThis.providerStore.claudeDesktopConfigs = [];
  }
  return globalThis.providerStore.claudeDesktopConfigs;
}

function ensureDefaultClaudeDesktopConfig() {
  const configs = getClaudeDesktopConfigs();
  if (configs.length > 0) return configs;

  const routes = getClaudeDesktopModelCandidates();
  const sonnetCandidate = routes.find(r => /sonnet|k2|glm|v3|plus/i.test(r.displayName || r.id)) || routes[0];
  const opusCandidate = routes.find(r => /opus|pro|r1|deepseek|max/i.test(r.displayName || r.id)) || routes[1] || routes[0];
  const haikuCandidate = routes.find(r => /haiku|flash|mini|turbo/i.test(r.displayName || r.id)) || routes[2] || routes[0];

  const defaultItem = {
    id: 'claude-desktop-default-proxy',
    name: 'AnyBridge 代理预设',
    mode: 'proxy',
    sourceProviderId: '',
    sourceProviderName: 'AnyBridge 本地网关',
    sonnetModel: sonnetCandidate ? (sonnetCandidate.uid || sonnetCandidate.id) : 'claude-3-7-sonnet',
    opusModel: opusCandidate ? (opusCandidate.uid || opusCandidate.id) : 'claude-3-opus',
    haikuModel: haikuCandidate ? (haikuCandidate.uid || haikuCandidate.id) : 'claude-3-5-haiku',
    fableModel: '',
  };

  configs.push(defaultItem);
  return configs;
}

function getRouteLabel(routeRef) {
  if (!routeRef) return '';
  const routes = globalThis.proxyRoutesStore?.routes || [];
  const found = routes.find(r => r.uid === routeRef || r.id === routeRef);
  if (found) {
    return found.displayName || found.id;
  }
  return routeRef;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDesktopCard(item) {
  const currentBadge = item.current ? '<span class="codex-config-badge-current">当前使用</span>' : '';
  const typeBadge = item.typeLabel === '官方'
    ? '<span class="codex-config-badge-official">官方</span>'
    : '<span class="codex-config-badge-third">本地路由</span>';

  const actionButtons = [];
  if (item.editAction) {
    actionButtons.push(`
      <button class="btn-icon codex-icon-action" type="button" title="编辑" aria-label="编辑 ${escapeHtml(item.name)}" onclick="${escapeHtml(item.editAction)}">
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
        </svg>
      </button>
    `);
  }
  if (item.deleteAction) {
    actionButtons.push(`
      <button class="btn-icon danger codex-icon-action codex-delete-action" type="button" title="删除" aria-label="删除 ${escapeHtml(item.name)}" onclick="${escapeHtml(item.deleteAction)}">
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6"></path><path d="M14 11v6"></path>
        </svg>
      </button>
    `);
  }

  const switchButton = !item.current && item.action
    ? `<button class="btn-primary codex-switch-action" onclick="${escapeHtml(item.action)}">${escapeHtml(item.actionLabel || '切换')}</button>`
    : '';

  const actionsHtml = (actionButtons.length || switchButton)
    ? `<div class="codex-config-actions">
        ${actionButtons.length ? `<div class="codex-card-icon-actions">${actionButtons.join('')}</div>` : ''}
        ${switchButton ? `<div class="codex-card-main-action">${switchButton}</div>` : ''}
      </div>`
    : '<span class="codex-row-muted">-</span>';

  return `
    <article class="codex-config-card ${item.current ? 'current' : ''} ${item.tone || ''}">
      <div class="codex-config-main">
        <div class="codex-config-title">
          <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          ${currentBadge}
          ${typeBadge}
        </div>
        <p>${escapeHtml(item.description || '')}</p>
        <div class="codex-config-meta">
          <span>${escapeHtml(item.model || '-')}</span>
          <span class="codex-meta-dot">•</span>
          <span>${escapeHtml(item.endpoint || '-')}</span>
        </div>
      </div>
      <div class="codex-config-card-side">
        ${actionsHtml}
      </div>
    </article>
  `;
}

function renderClaudeDesktopConfigList(info = null) {
  const list = document.getElementById('platform-claude-desktop-config-list');
  if (!list) return;

  const currentInfo = info || globalThis.claudeDesktopStatus || {};
  const configs = ensureDefaultClaudeDesktopConfig();
  const isManaged = !!currentInfo.managedByAnyBridge;
  const isOfficial = !isManaged || currentInfo.deploymentMode === '1p';
  const appliedId = currentInfo.currentProviderId || '';

  const items = [];

  // 1. 官方默认配置卡片
  items.push({
    platformId: 'claude-desktop',
    name: '官方默认配置',
    description: '使用 Claude Desktop 官方账号登录，不开启本地路由。',
    typeLabel: '官方',
    tone: 'official',
    current: isOfficial,
    model: '官方默认登录',
    endpoint: currentInfo.normalConfigPath || 'claude_desktop_config.json',
    protocol: 'official',
    action: isOfficial ? '' : 'restoreClaudeDesktopOfficialConfig()',
    actionLabel: '切回官方',
  });

  // 2. 自定义本地路由配置卡片列表
  configs.forEach(cfg => {
    const isCurrent = isManaged && (appliedId === cfg.id || (!appliedId && cfg.id === 'claude-desktop-default-proxy'));
    const sonnetTxt = getRouteLabel(cfg.sonnetModel) || '未选';
    const opusTxt = getRouteLabel(cfg.opusModel) || '未选';
    const haikuTxt = getRouteLabel(cfg.haikuModel) || '未选';

    const modelSummary = `Sonnet: ${sonnetTxt} | Opus: ${opusTxt} | Haiku: ${haikuTxt}`;
    const gatewayEndpoint = currentInfo.gatewayUrl || 'http://127.0.0.1:7450/claude-desktop';

    items.push({
      platformId: 'claude-desktop',
      name: cfg.name || '未命名配置',
      description: cfg.sourceProviderName ? `来源：${cfg.sourceProviderName}（本地路由）` : '本地路由角色档位映射配置',
      typeLabel: cfg.mode === 'direct' ? '直连' : '本地路由',
      tone: 'third',
      current: isCurrent,
      model: modelSummary,
      endpoint: gatewayEndpoint,
      protocol: 'router',
      action: isCurrent ? '' : `applyClaudeDesktopConfig(${JSON.stringify(cfg.id)})`,
      actionLabel: '切换',
      editAction: `editClaudeDesktopConfig(${JSON.stringify(cfg.id)})`,
      deleteAction: `deleteClaudeDesktopConfig(${JSON.stringify(cfg.id)})`,
    });
  });

  // 搜索过滤
  const kw = (globalThis.claudeDesktopSearchKw || '').trim().toLowerCase();
  const filtered = items.filter(it => {
    if (!kw) return true;
    return (it.name && it.name.toLowerCase().includes(kw)) ||
           (it.model && it.model.toLowerCase().includes(kw)) ||
           (it.description && it.description.toLowerCase().includes(kw));
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(it => renderDesktopCard(it)).join('');
}

async function loadClaudeDesktopConsole() {
  const pathLabel = document.getElementById('claude-desktop-config-path-label');
  const proxyBadge = document.getElementById('claude-desktop-proxy-status-badge');
  const gatewayHint = document.getElementById('claude-desktop-gateway-url-hint');

  // 先用内存状态立即渲染一次，避免界面卡在“正在加载…”
  renderClaudeDesktopConfigList();

  if (!globalThis.invoke) return;

  try {
    if (typeof loadProxyRoutes === 'function') {
      await loadProxyRoutes().catch(() => {});
    }

    const status = await invoke('get_claude_desktop_status');
    globalThis.claudeDesktopStatus = status;

    if (gatewayHint && status?.gatewayUrl) {
      gatewayHint.textContent = status.gatewayUrl;
    }

    if (pathLabel && status?.threepConfigPath) {
      pathLabel.textContent = status.threepConfigPath;
      if (typeof bindRevealPathLabel === 'function') {
        bindRevealPathLabel('claude-desktop-config-path-label', status.threepConfigPath);
      }
    }

    const proxyRunning = !!status?.proxyRunning;
    if (proxyBadge) {
      proxyBadge.textContent = proxyRunning ? '代理运行中' : '代理未启动';
      proxyBadge.style.background = proxyRunning ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-glass-heavy)';
      proxyBadge.style.color = proxyRunning ? 'var(--accent-ok, #10B981)' : 'var(--text-muted)';
    }

    renderClaudeDesktopConfigList(status);
  } catch (e) {
    console.error('加载 Claude Desktop 状态失败:', e);
    renderClaudeDesktopConfigList();
  }
}

function onClaudeDesktopConfigSearch() {
  const input = document.getElementById('claude-desktop-config-search');
  globalThis.claudeDesktopSearchKw = input ? input.value : '';
  renderClaudeDesktopConfigList();
}

function populateRoleSelects(selectedValues = {}) {
  const routes = getClaudeDesktopModelCandidates();
  const roles = [
    { id: 'claude-desktop-config-sonnet', key: 'sonnetModel', name: 'Sonnet 档' },
    { id: 'claude-desktop-config-opus', key: 'opusModel', name: 'Opus 档' },
    { id: 'claude-desktop-config-haiku', key: 'haikuModel', name: 'Haiku 档' },
    { id: 'claude-desktop-config-fable', key: 'fableModel', name: 'Fable 档', optional: true },
  ];

  roles.forEach(({ id, key, optional }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const currentVal = selectedValues[key] || '';
    const options = [];

    if (optional) {
      options.push('<option value="">(未启用)</option>');
    } else if (routes.length === 0) {
      options.push('<option value="">暂无可用的代理模型</option>');
    } else if (!currentVal) {
      options.push('<option value="" disabled selected>请选择代理模型</option>');
    }

    routes.forEach(m => {
      const val = m.uid || m.id;
      const selected = val === currentVal || m.id === currentVal ? 'selected' : '';
      const label = m.displayName || m.id;
      const targetHint = m.targets && m.targets[0] ? ` (${m.targets[0].model})` : '';
      options.push(`<option value="${val}" ${selected}>${escapeHtml(label)}${escapeHtml(targetHint)}</option>`);
    });

    el.innerHTML = options.join('');
    if (currentVal) el.value = currentVal;
  });
}

function renderClaudeDesktopSourceList(selectedId = '') {
  const list = document.getElementById('claude-desktop-config-source-list');
  const count = document.getElementById('claude-desktop-config-source-count');
  if (!list) return;

  const providers = (globalThis.providerStore?.providers || []).filter(p => p && p.enabled !== false && !p.isLocalProxy);
  if (count) count.textContent = String(providers.length);

  if (providers.length === 0) {
    list.innerHTML = '<div class="codex-config-source-empty">暂无可用供应商</div>';
    return;
  }

  list.innerHTML = providers.map(p => {
    const active = p.id === selectedId ? 'active' : '';
    return `
      <div class="codex-config-source-item ${active}" data-action="onClaudeDesktopSourceSelect" data-arg="${escapeHtml(p.id)}" style="cursor:pointer;padding:8px 10px;border-radius:6px;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;background:${active ? 'var(--bg-card-hover)' : 'transparent'};">
        <strong style="font-size:12.5px;color:var(--text-primary);">${escapeHtml(p.name || p.id)}</strong>
        <span style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.defaultModel || '默认模型')}</span>
      </div>
    `;
  }).join('');
}

function onClaudeDesktopSourceSelect(providerId) {
  const providers = globalThis.providerStore?.providers || [];
  const p = providers.find(x => x.id === providerId);
  if (!p) return;

  renderClaudeDesktopSourceList(providerId);

  const sourceIdInput = document.getElementById('claude-desktop-config-source-id');
  if (sourceIdInput) sourceIdInput.value = p.id;

  const nameInput = document.getElementById('claude-desktop-config-name');
  if (nameInput && (!nameInput.value || nameInput.value.includes('预设') || nameInput.value.includes('方案'))) {
    nameInput.value = `${p.name || p.id} 方案`;
  }

  const routes = getClaudeDesktopModelCandidates();
  const matchingRoute = routes.find(r => {
    return r.targets && r.targets.some(t => t.providerId === p.id);
  });

  if (matchingRoute) {
    const val = matchingRoute.uid || matchingRoute.id;
    const sonnetEl = document.getElementById('claude-desktop-config-sonnet');
    if (sonnetEl && !sonnetEl.value) sonnetEl.value = val;
    const opusEl = document.getElementById('claude-desktop-config-opus');
    if (opusEl && !opusEl.value) opusEl.value = val;
    const haikuEl = document.getElementById('claude-desktop-config-haiku');
    if (haikuEl && !haikuEl.value) haikuEl.value = val;
  }
}

function openClaudeDesktopAddModal() {
  const modal = document.getElementById('claude-desktop-config-modal');
  if (!modal) return;

  document.getElementById('claude-desktop-config-modal-title').textContent = '添加 Claude Desktop 配置';
  document.getElementById('claude-desktop-config-modal-sub').textContent = '从现有供应商或代理路由创建一份可切换的本地路由配置。';

  document.getElementById('claude-desktop-config-edit-id').value = '';
  document.getElementById('claude-desktop-config-source-id').value = '';
  document.getElementById('claude-desktop-config-name').value = '';
  document.getElementById('claude-desktop-config-mode').value = 'proxy';

  renderClaudeDesktopSourceList('');
  populateRoleSelects({});

  modal.classList.add('active');
}

function editClaudeDesktopConfig(configId) {
  const modal = document.getElementById('claude-desktop-config-modal');
  if (!modal) return;

  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) return;

  document.getElementById('claude-desktop-config-modal-title').textContent = '编辑 Claude Desktop 配置';
  document.getElementById('claude-desktop-config-modal-sub').textContent = `修改配置「${cfg.name}」的各档位映射。`;

  document.getElementById('claude-desktop-config-edit-id').value = cfg.id;
  document.getElementById('claude-desktop-config-source-id').value = cfg.sourceProviderId || '';
  document.getElementById('claude-desktop-config-name').value = cfg.name || '';
  document.getElementById('claude-desktop-config-mode').value = cfg.mode || 'proxy';

  renderClaudeDesktopSourceList(cfg.sourceProviderId || '');
  populateRoleSelects({
    sonnetModel: cfg.sonnetModel,
    opusModel: cfg.opusModel,
    haikuModel: cfg.haikuModel,
    fableModel: cfg.fableModel,
  });

  modal.classList.add('active');
}

function closeClaudeDesktopConfigEditor() {
  const modal = document.getElementById('claude-desktop-config-modal');
  if (modal) modal.classList.remove('active');
}

async function saveClaudeDesktopConfigEditor(switchAfter = false) {
  const editId = document.getElementById('claude-desktop-config-edit-id')?.value.trim();
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value.trim();
  const name = document.getElementById('claude-desktop-config-name')?.value.trim();
  const mode = document.getElementById('claude-desktop-config-mode')?.value.trim() || 'proxy';

  const sonnetModel = document.getElementById('claude-desktop-config-sonnet')?.value.trim();
  const opusModel = document.getElementById('claude-desktop-config-opus')?.value.trim();
  const haikuModel = document.getElementById('claude-desktop-config-haiku')?.value.trim();
  const fableModel = document.getElementById('claude-desktop-config-fable')?.value.trim() || '';

  if (!name) {
    showCustomAlert('请输入配置名称。', '提示', 'warn');
    return;
  }
  if (!sonnetModel || !opusModel || !haikuModel) {
    showCustomAlert('请至少为 Sonnet、Opus、Haiku 三个核心档位选择映射模型。', '提示', 'warn');
    return;
  }

  const providers = globalThis.providerStore?.providers || [];
  const sourceProvider = providers.find(p => p.id === sourceId);
  const configs = getClaudeDesktopConfigs();

  let targetId = editId;
  if (!targetId) {
    targetId = `claude-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const newConfig = {
    id: targetId,
    name,
    mode,
    sourceProviderId: sourceId,
    sourceProviderName: sourceProvider ? (sourceProvider.name || sourceProvider.id) : (mode === 'proxy' ? 'AnyBridge 代理' : '直连'),
    sonnetModel,
    opusModel,
    haikuModel,
    fableModel,
  };

  const existingIdx = configs.findIndex(c => c.id === targetId);
  if (existingIdx >= 0) {
    configs[existingIdx] = newConfig;
  } else {
    configs.push(newConfig);
  }

  closeClaudeDesktopConfigEditor();

  try {
    if (typeof persistProviders === 'function') {
      await persistProviders();
    }
    showCustomAlert('配置已保存。', '保存成功', 'success');
    renderClaudeDesktopConfigList();

    if (switchAfter) {
      await applyClaudeDesktopConfig(targetId);
    }
  } catch (e) {
    showCustomAlert(`保存失败: ${e}`, '错误', 'error');
  }
}

async function applyClaudeDesktopConfig(configId) {
  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) {
    showCustomAlert('找不到对应的配置。', '错误', 'error');
    return;
  }

  const ok = await showCustomConfirm(
    `确定切换到配置「${cfg.name}」吗？\n\n将开启本地路由模式（Sonnet: ${getRouteLabel(cfg.sonnetModel)}, Opus: ${getRouteLabel(cfg.opusModel)}, Haiku: ${getRouteLabel(cfg.haikuModel)}）。\n切换后请重启 Claude Desktop。`,
    '切换配置',
    'info'
  );
  if (!ok) return;

  try {
    const bindings = {
      sonnet: cfg.sonnetModel,
      opus: cfg.opusModel,
      haiku: cfg.haikuModel,
      fable: cfg.fableModel || '',
    };

    if (globalThis.invoke) {
      await invoke('save_claude_desktop_bindings', { bindings });
      const res = await invoke('switch_platform', { platform: 'claude-desktop', providerId: cfg.id });
      if (typeof addLog === 'function') addLog('ok', res?.message || `已切换至 ${cfg.name}`);
      showCustomAlert(res?.message || '配置已成功应用，请重启 Claude Desktop 生效。', '切换成功', 'success');
      await loadClaudeDesktopConsole();
      if (typeof refreshPlatforms === 'function') refreshPlatforms({ silent: true });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `切换配置失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  }
}

async function deleteClaudeDesktopConfig(configId) {
  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) return;

  const ok = await showCustomConfirm(
    `确定删除配置「${cfg.name}」吗？`,
    '删除配置',
    'warn'
  );
  if (!ok) return;

  const idx = configs.findIndex(c => c.id === configId);
  if (idx >= 0) {
    configs.splice(idx, 1);
  }

  try {
    if (typeof persistProviders === 'function') {
      await persistProviders();
    }
    renderClaudeDesktopConfigList();
    showCustomAlert('配置已删除。', '删除成功', 'success');
  } catch (e) {
    showCustomAlert(`删除失败: ${e}`, '错误', 'error');
  }
}

async function restoreClaudeDesktopOfficialConfig() {
  const ok = await showCustomConfirm(
    '确定切回 Claude Desktop 官方默认配置吗？\n\n将清理本地路由配置并恢复官方登录状态。完成后请重启 Claude Desktop。',
    '切回官方',
    'warn'
  );
  if (!ok) return;

  try {
    if (globalThis.invoke) {
      const res = await invoke('restore_platform', { platform: 'claude-desktop' });
      if (typeof addLog === 'function') addLog('ok', res?.message || '已切回 Claude Desktop 官方默认配置');
      showCustomAlert(res?.message || '已恢复官方默认配置，请重启 Claude Desktop 生效。', '还原完成', 'success');
      await loadClaudeDesktopConsole();
      if (typeof refreshPlatforms === 'function') refreshPlatforms({ silent: true });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '切回官方默认配置失败: ' + e);
    showCustomAlert(String(e), '还原失败', 'error');
  }
}

async function refreshClaudeDesktopAction() {
  await loadClaudeDesktopConsole();
  if (typeof addLog === 'function') addLog('info', 'Claude Desktop 状态已刷新');
}

// 挂载全局方法
globalThis.loadClaudeDesktopConsole = loadClaudeDesktopConsole;
globalThis.renderClaudeDesktopConfigList = renderClaudeDesktopConfigList;
globalThis.onClaudeDesktopConfigSearch = onClaudeDesktopConfigSearch;
globalThis.openClaudeDesktopAddModal = openClaudeDesktopAddModal;
globalThis.editClaudeDesktopConfig = editClaudeDesktopConfig;
globalThis.deleteClaudeDesktopConfig = deleteClaudeDesktopConfig;
globalThis.closeClaudeDesktopConfigEditor = closeClaudeDesktopConfigEditor;
globalThis.saveClaudeDesktopConfigEditor = saveClaudeDesktopConfigEditor;
globalThis.applyClaudeDesktopConfig = applyClaudeDesktopConfig;
globalThis.restoreClaudeDesktopOfficialConfig = restoreClaudeDesktopOfficialConfig;
globalThis.refreshClaudeDesktopAction = refreshClaudeDesktopAction;
globalThis.onClaudeDesktopSourceSelect = onClaudeDesktopSourceSelect;

// 脚本载入时尝试预渲染（如果 DOM 已存在）
if (typeof document !== 'undefined' && document.getElementById('platform-claude-desktop-config-list')) {
  renderClaudeDesktopConfigList();
}
