// claude-desktop/console.js — Claude Desktop 配置列表、模式头部与状态渲染

globalThis.claudeDesktopStatus = null;
globalThis.claudeDesktopSearchKw = '';

export function getClaudeDesktopModelCandidates() {
  const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
  return routes;
}

export function getClaudeDesktopConfigs() {
  if (!globalThis.providerStore) {
    globalThis.providerStore = { providers: [], claudeDesktopConfigs: [] };
  }
  if (!Array.isArray(globalThis.providerStore.claudeDesktopConfigs)) {
    globalThis.providerStore.claudeDesktopConfigs = [];
  }
  return globalThis.providerStore.claudeDesktopConfigs;
}

export function ensureDefaultClaudeDesktopConfig() {
  const configs = getClaudeDesktopConfigs();
  if (configs.length > 0) return configs;

  const routes = getClaudeDesktopModelCandidates();
  const sonnetCandidate = routes.find(r => /sonnet|k2|glm|v3|plus/i.test(r.displayName || r.id)) || routes[0];
  const opusCandidate = routes.find(r => /opus|pro|r1|deepseek|max/i.test(r.displayName || r.id)) || routes[1] || routes[0];
  const haikuCandidate = routes.find(r => /haiku|flash|mini|turbo/i.test(r.displayName || r.id)) || routes[2] || routes[0];

  const defaultItem = {
    id: 'claude-desktop-default-proxy',
    name: 'AnyBridge 网关预设',
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

export function getRouteLabel(routeRef) {
  if (!routeRef) return '';
  const routes = globalThis.proxyRoutesStore?.routes || [];
  const found = routes.find(r => r.uid === routeRef || r.id === routeRef);
  if (found) {
    return found.displayName || found.id;
  }
  return routeRef;
}

export function escapeHtml(str) {
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
      <button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="编辑" aria-label="编辑 ${escapeHtml(item.name)}" onclick="${escapeHtml(item.editAction)}">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      </button>
    `);
  }
  if (item.deleteAction) {
    actionButtons.push(`
      <button class="btn-icon model-map-action-btn danger codex-icon-action codex-delete-action" type="button" title="删除" aria-label="删除 ${escapeHtml(item.name)}" onclick="${escapeHtml(item.deleteAction)}">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `);
  }

  const switchButton = !item.current && item.action
    ? `<button class="btn-primary codex-switch-action" onclick="${escapeHtml(item.action)}">${escapeHtml(item.actionLabel || '切换')}</button>`
    : '';

  const reconfigureButton = item.current && item.reconfigureAction
    ? `<button class="codex-current-action codex-reconfigure-action" type="button" title="重新写入当前配置" onclick="${escapeHtml(item.reconfigureAction)}">重新配置</button>`
    : '';

  const mainAction = switchButton || reconfigureButton || '';

  const actionsHtml = (actionButtons.length || mainAction)
    ? `<div class="codex-config-actions">
        ${actionButtons.length ? `<div class="codex-card-icon-actions">${actionButtons.join('')}</div>` : ''}
        ${mainAction ? `<div class="codex-card-main-action">${mainAction}</div>` : ''}
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
    const rolePairs = [
      ['Sonnet', cfg.sonnetModel],
      ['Opus', cfg.opusModel],
      ['Haiku', cfg.haikuModel],
    ];
    if (cfg.fableModel) rolePairs.push(['Fable', cfg.fableModel]);
    const modelSummary = rolePairs
      .map(([role, model]) => `${role}: ${getRouteLabel(model) || '未选'}`)
      .join(' | ');
    const gatewayEndpoint = currentInfo.gatewayUrl || 'http://127.0.0.1:7450/claude-desktop';

    items.push({
      platformId: 'claude-desktop',
      name: cfg.name || '未命名配置',
      description: cfg.sourceProviderName ? `来源：${cfg.sourceProviderName}` : '本地路由角色档位映射配置',
      typeLabel: cfg.mode === 'direct' ? '直连' : '本地路由',
      tone: 'third',
      current: isCurrent,
      model: modelSummary,
      endpoint: gatewayEndpoint,
      protocol: 'router',
      action: isCurrent ? '' : `applyClaudeDesktopConfig(${JSON.stringify(cfg.id)})`,
      actionLabel: '切换',
      reconfigureAction: isCurrent ? `applyClaudeDesktopConfig(${JSON.stringify(cfg.id)})` : '',
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
  updateClaudeDesktopModeHeader(currentInfo);
}

function updateClaudeDesktopModeHeader(info = null) {
  const btn = document.getElementById('claude-desktop-hero-mode-btn');
  if (!btn) return;

  const currentInfo = info || globalThis.claudeDesktopStatus || {};
  const configs = ensureDefaultClaudeDesktopConfig();
  const isManaged = !!currentInfo.managedByAnyBridge;
  const isOfficial = !isManaged || currentInfo.deploymentMode === '1p';
  const appliedId = currentInfo.currentProviderId || '';

  if (isOfficial) {
    btn.className = 'btn-ghost secondary claude-desktop-mode-badge-btn';
    btn.style.color = 'var(--text-muted)';
    btn.style.borderColor = 'var(--border)';
    btn.style.background = 'var(--bg-glass-heavy)';
    btn.innerHTML = `
      <span class="claude-desktop-mode-dot" style="width:8px;height:8px;border-radius:50%;background:var(--text-muted);display:inline-block;"></span>
      <span>当前模式：官方模式</span>
    `;
    btn.title = '当前为官方模式（未开启本地路由网关）。点击查看说明';
    return;
  }

  const activeCfg = configs.find(cfg => cfg.id === appliedId || (!appliedId && cfg.id === 'claude-desktop-default-proxy')) || configs[0];
  const isDirect = activeCfg?.mode === 'direct';

  if (isDirect) {
    btn.className = 'btn-ghost info claude-desktop-mode-badge-btn';
    btn.style.color = 'var(--accent-info, #3b82f6)';
    btn.style.borderColor = 'rgba(59, 130, 246, 0.35)';
    btn.style.background = 'rgba(59, 130, 246, 0.08)';
    btn.innerHTML = `
      <span class="claude-desktop-mode-dot" style="width:8px;height:8px;border-radius:50%;background:#3b82f6;box-shadow:0 0 8px rgba(59,130,246,0.6);display:inline-block;"></span>
      <span>当前模式：直连模式</span>
    `;
    btn.title = `当前配置「${activeCfg.name}」处于直连模式。点击可快速切换为网关模式`;
  } else {
    btn.className = 'btn-ghost success claude-desktop-mode-badge-btn';
    btn.style.color = 'var(--accent-ok, #10b981)';
    btn.style.borderColor = 'rgba(16, 185, 129, 0.35)';
    btn.style.background = 'rgba(16, 185, 129, 0.08)';
    btn.innerHTML = `
      <span class="claude-desktop-mode-dot" style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px rgba(16,185,129,0.6);display:inline-block;"></span>
      <span>当前模式：网关模式</span>
    `;
    btn.title = `当前配置「${activeCfg.name}」处于本地路由网关模式。点击可快速切换为直连模式`;
  }
}

async function onClaudeDesktopHeroModeClick() {
  const currentInfo = globalThis.claudeDesktopStatus || {};
  const isManaged = !!currentInfo.managedByAnyBridge;
  const isOfficial = !isManaged || currentInfo.deploymentMode === '1p';
  if (isOfficial) {
    showCustomAlert('当前处于官方默认模式。请在下方配置列表中点击「切换」启用自定义网关配置或直连配置。', '当前模式：官方模式', 'info');
    return;
  }

  const configs = getClaudeDesktopConfigs();
  const appliedId = currentInfo.currentProviderId || '';
  const activeCfg = configs.find(cfg => cfg.id === appliedId || (!appliedId && cfg.id === 'claude-desktop-default-proxy')) || configs[0];
  if (!activeCfg) return;

  const currentMode = activeCfg.mode === 'direct' ? 'direct' : 'proxy';
  const targetMode = currentMode === 'direct' ? 'proxy' : 'direct';
  const currentLabel = currentMode === 'direct' ? '直连模式' : '网关模式 (本地路由)';
  const targetLabel = targetMode === 'direct' ? '直连模式' : '网关模式 (本地路由)';

  const ok = await showCustomConfirm(
    `当前配置「${activeCfg.name}」处于【${currentLabel}】。\n\n是否切换为【${targetLabel}】？\n\n• 网关模式：通过 AnyBridge 本地路由转发，支持任意供应商与模型角色映射\n• 直连模式：客户端直连远端服务，要求供应商原生兼容 Anthropic 协议`,
    '切换连接模式',
    'info'
  );
  if (!ok) return;

  const saved = await mutateProviderStore(store => {
    const item = (store.claudeDesktopConfigs || []).find(c => c.id === activeCfg.id);
    if (!item) return false;
    item.mode = targetMode;
  }, {
    alertOnError: true,
    onRollback: () => {
      renderClaudeDesktopConfigList();
    },
  });
  if (!saved) return;
  await applyClaudeDesktopConfig(activeCfg.id);
  renderClaudeDesktopConfigList();
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已将「${activeCfg.name}」切换为 ${targetLabel}`, 'success');
  }
}

function updateClaudeDesktopProxyBadge(running) {
  const proxyBadge = document.getElementById('claude-desktop-proxy-status-badge');
  if (!proxyBadge) return;
  const isRunning = (typeof running === 'boolean')
    ? running
    : ((typeof globalThis.proxyRunning === 'boolean') ? globalThis.proxyRunning : false);
  proxyBadge.textContent = isRunning ? '网关运行中' : '网关未启动';
  proxyBadge.style.background = isRunning ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-glass-heavy)';
  proxyBadge.style.color = isRunning ? 'var(--accent-ok, #10B981)' : 'var(--text-muted)';
}

async function loadClaudeDesktopConsole() {
  const pathLabel = document.getElementById('claude-desktop-config-path-label');
  const gatewayHint = document.getElementById('claude-desktop-gateway-url-hint');

  // 界面汉化按钮状态（与 Rust 保活 keeper 同一数据源）
  if (typeof refreshClaudeLangStatus === 'function') {
    void refreshClaudeLangStatus();
  }

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

    const isRunning = (typeof globalThis.proxyRunning === 'boolean')
      ? globalThis.proxyRunning
      : !!status?.proxyRunning;
    updateClaudeDesktopProxyBadge(isRunning);

    renderClaudeDesktopConfigList(status);
    updateClaudeDesktopModeHeader(status);
    if (typeof renderHeroVersion === 'function') {
      renderHeroVersion('claude-desktop', 'claude-desktop-platform-version');
    }
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

globalThis.loadClaudeDesktopConsole = loadClaudeDesktopConsole;
globalThis.updateClaudeDesktopProxyBadge = updateClaudeDesktopProxyBadge;
globalThis.updateClaudeDesktopModeHeader = updateClaudeDesktopModeHeader;
globalThis.onClaudeDesktopHeroModeClick = onClaudeDesktopHeroModeClick;
globalThis.renderClaudeDesktopConfigList = renderClaudeDesktopConfigList;
globalThis.onClaudeDesktopConfigSearch = onClaudeDesktopConfigSearch;

if (typeof document !== 'undefined' && document.getElementById('platform-claude-desktop-config-list')) {
  renderClaudeDesktopConfigList();
}
