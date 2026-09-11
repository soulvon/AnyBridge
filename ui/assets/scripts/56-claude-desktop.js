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
      description: cfg.sourceProviderName ? `来源：${cfg.sourceProviderName}（本地路由）` : '本地路由角色档位映射配置',
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
    btn.title = '当前为官方模式（未开启本地路由代理）。点击查看说明';
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
    btn.title = `当前配置「${activeCfg.name}」处于直连模式。点击可快速切换为代理模式`;
  } else {
    btn.className = 'btn-ghost success claude-desktop-mode-badge-btn';
    btn.style.color = 'var(--accent-ok, #10b981)';
    btn.style.borderColor = 'rgba(16, 185, 129, 0.35)';
    btn.style.background = 'rgba(16, 185, 129, 0.08)';
    btn.innerHTML = `
      <span class="claude-desktop-mode-dot" style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px rgba(16,185,129,0.6);display:inline-block;"></span>
      <span>当前模式：代理模式</span>
    `;
    btn.title = `当前配置「${activeCfg.name}」处于本地路由代理模式。点击可快速切换为直连模式`;
  }
}

async function onClaudeDesktopHeroModeClick() {
  const currentInfo = globalThis.claudeDesktopStatus || {};
  const isManaged = !!currentInfo.managedByAnyBridge;
  const isOfficial = !isManaged || currentInfo.deploymentMode === '1p';
  if (isOfficial) {
    showCustomAlert('当前处于官方默认模式。请在下方配置列表中点击「切换」启用自定义代理或直连配置。', '当前模式：官方模式', 'info');
    return;
  }

  const configs = getClaudeDesktopConfigs();
  const appliedId = currentInfo.currentProviderId || '';
  const activeCfg = configs.find(cfg => cfg.id === appliedId || (!appliedId && cfg.id === 'claude-desktop-default-proxy')) || configs[0];
  if (!activeCfg) return;

  const currentMode = activeCfg.mode === 'direct' ? 'direct' : 'proxy';
  const targetMode = currentMode === 'direct' ? 'proxy' : 'direct';
  const currentLabel = currentMode === 'direct' ? '直连模式' : '代理模式 (本地路由)';
  const targetLabel = targetMode === 'direct' ? '直连模式' : '代理模式 (本地路由)';

  const ok = await showCustomConfirm(
    `当前配置「${activeCfg.name}」处于【${currentLabel}】。\n\n是否切换为【${targetLabel}】？\n\n• 代理模式：通过 AnyBridge 本地路由转发，支持任意供应商与模型角色映射\n• 直连模式：客户端直连远端服务，要求供应商原生兼容 Anthropic 协议`,
    '切换连接模式',
    'info'
  );
  if (!ok) return;

  activeCfg.mode = targetMode;
  if (typeof persistProviders === 'function') {
    await persistProviders();
  }
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
  proxyBadge.textContent = isRunning ? '代理运行中' : '代理未启动';
  proxyBadge.style.background = isRunning ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-glass-heavy)';
  proxyBadge.style.color = isRunning ? 'var(--accent-ok, #10B981)' : 'var(--text-muted)';
}

async function loadClaudeDesktopConsole() {
  const pathLabel = document.getElementById('claude-desktop-config-path-label');
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

    const isRunning = (typeof globalThis.proxyRunning === 'boolean')
      ? globalThis.proxyRunning
      : !!status?.proxyRunning;
    updateClaudeDesktopProxyBadge(isRunning);

    renderClaudeDesktopConfigList(status);
    updateClaudeDesktopModeHeader(status);
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

function getProviderModelList(provider) {
  if (!provider) return [];
  const sortFn = typeof globalThis.sortRoleSelectItems === 'function' ? globalThis.sortRoleSelectItems : (list) => list;
  if (provider.isLocalProxy || provider.meta?.localProxy || provider.id === 'local-proxy' || provider.id === 'anybridge' || provider.name === 'AnyBridge') {
    const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
    const list = routes.map(r => stripClaudeDesktop1mMarker(r.id)).filter(Boolean);
    return sortFn(list, 'claude');
  }
  const set = new Set();
  if (provider.defaultModel && String(provider.defaultModel).trim()) {
    set.add(stripClaudeDesktop1mMarker(provider.defaultModel));
  }
  if (Array.isArray(provider.models)) {
    provider.models.forEach(m => {
      const id = typeof m === 'string' ? m.trim() : (m?.id || m?.model || '').trim();
      const clean = stripClaudeDesktop1mMarker(id);
      if (clean) set.add(clean);
    });
  }
  if (Array.isArray(provider.modelCatalog)) {
    provider.modelCatalog.forEach(m => {
      const id = (m?.model || m?.id || '').trim();
      const clean = stripClaudeDesktop1mMarker(id);
      if (clean) set.add(clean);
    });
  }
  return sortFn(Array.from(set), 'claude');
}

function pickBestModelForRole(roleKey, modelList, defaultModel = '') {
  if (!modelList || modelList.length === 0) return defaultModel || '';
  const lowerList = modelList.map(m => ({ raw: m, lower: stripClaudeDesktop1mMarker(m).toLowerCase() }));

  let matchPatterns = [];
  if (roleKey === 'sonnetModel') {
    matchPatterns = ['sonnet', 'k2', 'glm-5', 'glm', 'v3', 'v4', 'plus', 'pro', 'flash', 'chat'];
  } else if (roleKey === 'opusModel') {
    matchPatterns = ['opus', 'r1', 'deepseek', 'o1', 'o3', 'max', 'high', 'pro', 'reasoning'];
  } else if (roleKey === 'haikuModel') {
    matchPatterns = ['haiku', 'mini', 'flash', 'fast', 'turbo', 'lite', 'speed'];
  } else if (roleKey === 'fableModel') {
    matchPatterns = ['fable'];
  }

  for (const pat of matchPatterns) {
    const found = lowerList.find(item => item.lower.includes(pat));
    if (found) return found.raw;
  }

  if (defaultModel && modelList.includes(defaultModel)) return defaultModel;
  return roleKey === 'fableModel' ? '' : (modelList[0] || '');
}

function hasClaudeDesktop1mMarker(val) {
  return /\[1m\]$/i.test(String(val || '').trim());
}

function stripClaudeDesktop1mMarker(val) {
  return String(val || '').trim().replace(/\[1m\]$/i, '').trim();
}

function applyClaudeDesktop1mMarker(val, enabled) {
  const base = stripClaudeDesktop1mMarker(val);
  if (!base) return '';
  return enabled ? `${base}[1m]` : base;
}

function getClaudeDesktop1m(role) {
  const cb = document.getElementById(`claude-desktop-1m-${role}`);
  return !!cb?.checked;
}

function setClaudeDesktop1m(role, checked) {
  const cb = document.getElementById(`claude-desktop-1m-${role}`);
  if (cb) cb.checked = !!checked;
  const box = document.getElementById(`claude-desktop-1m-box-${role}`);
  if (box) box.classList.toggle('active', !!checked);
}

function onClaudeDesktop1mChange(role, checked) {
  const box = document.getElementById(`claude-desktop-1m-box-${role}`);
  if (box) box.classList.toggle('active', !!checked);
  syncClaudeDesktopRawConfigFromFields();
}

function getClaudeDesktopRoleVal(role) {
  const input = document.getElementById(`claude-desktop-config-${role}`);
  const raw = input ? input.value : '';
  if (!raw || raw === '__clear__' || raw === '__custom__') return '';
  return applyClaudeDesktop1mMarker(raw, getClaudeDesktop1m(role));
}

function onClaudeDesktopRoleSelectChange(role, value) {
  const providers = globalThis.providerStore?.providers || [];
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value;
  const name = document.getElementById('claude-desktop-config-name')?.value || '';
  const p = providers.find(x => x.id === sourceId);
  const isAnyRouter = (p?.name || name || p?.apiHost || '').toLowerCase().includes('anyrouter');
  const isClaude = String(value || '').toLowerCase().includes('claude');

  // 联动更新菜单显示名：切换/选择模型时自动将显示名改为选中的模型，方便用户查看并在其基础上修改
  const cleanVal = stripClaudeDesktop1mMarker(value || '');
  const nameInput = document.getElementById(`claude-desktop-config-${role}-name`);
  if (nameInput) {
    nameInput.value = cleanVal;
  }

  setClaudeDesktop1m(role, isAnyRouter && isClaude);

  // 重新渲染该组件的 trigger 与选项选中状态
  populateRoleSelects({
    sourceProviderId: sourceId,
    sonnetModel: document.getElementById('claude-desktop-config-sonnet')?.value,
    opusModel: document.getElementById('claude-desktop-config-opus')?.value,
    haikuModel: document.getElementById('claude-desktop-config-haiku')?.value,
    fableModel: document.getElementById('claude-desktop-config-fable')?.value,
  }, p);

  syncClaudeDesktopRawConfigFromFields();
}

function claudeDesktopQuickSetAllModels() {
  const sonnetVal = stripClaudeDesktop1mMarker(document.getElementById('claude-desktop-config-sonnet')?.value);
  const opusVal = stripClaudeDesktop1mMarker(document.getElementById('claude-desktop-config-opus')?.value);
  const haikuVal = stripClaudeDesktop1mMarker(document.getElementById('claude-desktop-config-haiku')?.value);
  const sourceVal = sonnetVal || opusVal || haikuVal;

  if (!sourceVal || sourceVal === '__clear__' || sourceVal === '__custom__') {
    showCustomAlert('请先在上方任意档位中选择一个有效模型。', '未指定模型', 'info');
    return;
  }

  const providers = globalThis.providerStore?.providers || [];
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value;
  const name = document.getElementById('claude-desktop-config-name')?.value || '';
  const p = providers.find(x => x.id === sourceId);
  const isAnyRouter = (p?.name || name || p?.apiHost || '').toLowerCase().includes('anyrouter');
  const isClaude = sourceVal.toLowerCase().includes('claude');
  const use1m = isAnyRouter && isClaude;

  ['sonnet', 'opus', 'fable', 'haiku'].forEach(role => {
    const input = document.getElementById(`claude-desktop-config-${role}`);
    if (input) input.value = sourceVal;
    const nameInput = document.getElementById(`claude-desktop-config-${role}-name`);
    if (nameInput) {
      nameInput.value = sourceVal;
    }
    setClaudeDesktop1m(role, use1m);
  });

  populateRoleSelects({
    sourceProviderId: sourceId,
    sonnetModel: sourceVal,
    opusModel: sourceVal,
    haikuModel: sourceVal,
    fableModel: sourceVal,
  }, p);

  syncClaudeDesktopRawConfigFromFields();
  if (typeof addLog === 'function') addLog('ok', `已将模型「${sourceVal}」一键填充到所有 Desktop 角色`);
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已将「${sourceVal}」一键填充到所有角色档位`, 'success');
  }
}

function closeAllCustomRoleMenus() {
  document.querySelectorAll('.claude-desktop-role-row, .claude-role-row').forEach(row => {
    row.style.zIndex = '';
    row.classList.remove('has-open-select');
  });
  document.querySelectorAll('.claude-desktop-role-card, .claude-code-role-card, .cb-add-models-card, .glass-card').forEach(card => {
    card.style.zIndex = '';
    card.classList.remove('has-open-select');
  });
  document.querySelectorAll('.custom-role-select').forEach(el => {
    el.classList.remove('open');
    el.classList.remove('drop-up');
    const m = el.querySelector('.custom-role-select-menu');
    if (m) m.style.display = 'none';
  });
}

function getModelFamilyRank(modelId) {
  const s = String(modelId || '').toLowerCase();
  // 图像/视频/语音等专用或多模态生成模型沉底
  if (/image|video|imagine|sora|dall-e|tts|speech|audio|embed|moderation/.test(s)) return 70;
  // Claude 平台下核心模型置顶
  if (/claude|opus|sonnet|haiku|fable/.test(s)) return 10;
  // 主流旗舰开发模型
  if (/gpt|chatgpt|^o[134]|\bcodex\b/.test(s)) return 20;
  if (/gemini|gemma/.test(s)) return 30;
  if (/deepseek/.test(s)) return 40;
  if (/grok/.test(s)) return 50;
  if (/qwen|qwq|qvq|glm|chatglm|kimi|moonshot|mistral|llama|minimax|doubao|hunyuan|baichuan|yi|internlm/.test(s)) return 60;
  return 65;
}

function compareModelNames(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (sa === sb) return 0;

  // 相同前缀下的版本号数字倒序（如 gemini-3.8 在 gemini-3.6 前面；gpt-6 在 gpt-5.6 前面；grok-4.6 在 grok-4.5 前面）
  const numRegex = /(\d+(?:\.\d+)*)/;
  const ma = sa.match(numRegex);
  const mb = sb.match(numRegex);
  if (ma && mb) {
    const preA = sa.slice(0, ma.index).toLowerCase();
    const preB = sb.slice(0, mb.index).toLowerCase();
    if (preA === preB) {
      const vaParts = ma[1].split('.').map(n => parseFloat(n) || 0);
      const vbParts = mb[1].split('.').map(n => parseFloat(n) || 0);
      const maxLen = Math.max(vaParts.length, vbParts.length);
      for (let i = 0; i < maxLen; i++) {
        const na = vaParts[i] ?? 0;
        const nb = vbParts[i] ?? 0;
        if (na !== nb) return nb - na; // 版本号高的优先排在前面
      }
    }
  }

  // 默认自然语言字典序
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

function sortRoleSelectItems(items, preferredFamily = 'claude') {
  if (typeof globalThis.sortRoleSelectItems === 'function' && globalThis.sortRoleSelectItems !== sortRoleSelectItems) {
    return globalThis.sortRoleSelectItems(items, preferredFamily);
  }
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const aSaved = (a.provider === '已保存' || a.label === '已保存') ? 1 : 0;
    const bSaved = (b.provider === '已保存' || b.label === '已保存') ? 1 : 0;
    if (aSaved !== bSaved) return bSaved - aSaved;

    const idA = a.id || a.model || String(a);
    const idB = b.id || b.model || String(b);

    const rankA = getModelFamilyRank(idA);
    const rankB = getModelFamilyRank(idB);
    if (rankA !== rankB) return rankA - rankB;

    return compareModelNames(idA, idB);
  });
}

function toggleCustomRoleMenu(containerId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const container = document.getElementById(containerId);
  if (!container) return;
  const wasOpen = container.classList.contains('open');

  // 关闭页面上其他已打开的菜单
  closeAllCustomRoleMenus();

  if (!wasOpen) {
    // 动态智能判断是往上弹还是往下弹
    const rect = container.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    // 当下方剩余空间不足 240px 且上方空间更多时，自动向上弹出
    const isDropUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    if (isDropUp) {
      container.classList.add('drop-up');
    } else {
      container.classList.remove('drop-up');
    }

    container.classList.add('open');
    const parentRow = container.closest('.claude-desktop-role-row') || container.closest('.claude-role-row') || container.closest('div');
    if (parentRow) {
      parentRow.style.zIndex = '1500';
      parentRow.classList.add('has-open-select');
    }
    const parentCard = container.closest('.claude-desktop-role-card') || container.closest('.claude-code-role-card') || container.closest('.cb-add-models-card') || container.closest('.glass-card');
    if (parentCard) {
      parentCard.style.zIndex = '200';
      parentCard.classList.add('has-open-select');
    }
    const menu = container.querySelector('.custom-role-select-menu');
    if (menu) {
      menu.style.display = 'block';
      const list = menu.querySelector('.custom-role-select-list');
      if (list) {
        // 根据弹出方向动态设置最大高度，确保不会被屏幕顶部或底部边缘截断
        const availableSpace = isDropUp ? (spaceAbove - 24) : (spaceBelow - 24);
        const maxHeight = Math.max(140, Math.min(300, Math.floor(availableSpace)));
        list.style.maxHeight = `${maxHeight}px`;
      }
      const searchInput = menu.querySelector('.custom-role-select-search-input');
      if (searchInput) {
        searchInput.value = '';
        filterCustomRoleMenu(containerId, '');
        window.setTimeout(() => searchInput.focus(), 30);
      }
    }
  }
}

function filterCustomRoleMenu(containerId, query) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const q = String(query || '').trim().toLowerCase();
  const opts = container.querySelectorAll('.custom-role-select-opt');
  opts.forEach(opt => {
    const val = (opt.dataset.value || '').toLowerCase();
    const lbl = (opt.dataset.label || '').toLowerCase();
    const match = !q || val.includes(q) || lbl.includes(q);
    opt.style.display = match ? 'flex' : 'none';
  });
}

function selectCustomRoleItem(containerId, hiddenInputId, value, role) {
  const hiddenInput = document.getElementById(hiddenInputId);
  if (hiddenInput) {
    hiddenInput.value = value;
  }
  closeAllCustomRoleMenus();

  if (containerId.startsWith('claude-desktop-')) {
    if (typeof onClaudeDesktopRoleSelectChange === 'function') {
      onClaudeDesktopRoleSelectChange(role, value);
    }
  } else if (role === 'fallback') {
    if (typeof onClaudeFallbackSelectChange === 'function') {
      onClaudeFallbackSelectChange(value);
    }
  } else {
    if (typeof onClaudeRoleSelectChange === 'function') {
      onClaudeRoleSelectChange(role, value);
    }
  }
}

async function promptCustomRoleItem(containerId, hiddenInputId, role) {
  const custom = (typeof showCustomPrompt === 'function')
    ? await showCustomPrompt('请输入实际请求模型 ID（例如 claude-opus-4-7 或 gemini-2.5-pro）：', '自定义模型', '')
    : prompt('请输入实际请求模型 ID：', '');
  if (custom && custom.trim()) {
    const clean = stripClaudeDesktop1mMarker(custom.trim());
    selectCustomRoleItem(containerId, hiddenInputId, clean, role);
  }
}

function renderCustomRoleSelect({
  containerId,
  hiddenInputId,
  role,
  currentValue = '',
  groupLabel = '',
  items = [],
  optional = false,
}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let hiddenInput = document.getElementById(hiddenInputId);
  if (!hiddenInput) {
    hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    hiddenInput.id = hiddenInputId;
    container.appendChild(hiddenInput);
  }
  hiddenInput.value = currentValue || '';

  const cleanVal = stripClaudeDesktop1mMarker(currentValue || '');
  const sortedItems = sortRoleSelectItems(items);
  const matched = sortedItems.find(it => it.id === cleanVal);

  let iconHtml = '';
  let displayText = '';
  let badgeHtml = '';

  if (cleanVal) {
    iconHtml = (typeof renderModelIcon === 'function') ? renderModelIcon(cleanVal) : '';
    displayText = cleanVal;
    if (matched && matched.provider) {
      badgeHtml = `<span class="custom-role-select-badge">${escapeHtml(matched.provider)}</span>`;
    }
  } else if (optional) {
    displayText = '<span style="color:var(--text-muted);">(未启用 / 留空)</span>';
  } else {
    displayText = '<span style="color:var(--text-muted);">请选择真实模型…</span>';
  }

  const triggerHtml = `
    <button type="button" class="custom-role-select-trigger" onclick="toggleCustomRoleMenu('${containerId}', event)">
      <div class="custom-role-select-value">
        ${iconHtml ? `<span class="custom-role-select-icon">${iconHtml}</span>` : ''}
        <span class="custom-role-select-text">${displayText}</span>
        ${badgeHtml}
      </div>
      <svg class="custom-role-select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
  `;

  let searchHtml = '';
  if (sortedItems.length >= 6) {
    searchHtml = `
      <div class="custom-role-select-search-wrap" onclick="event.stopPropagation()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="custom-role-select-search-input" placeholder="搜索模型" oninput="filterCustomRoleMenu('${containerId}', this.value)" autocomplete="off">
      </div>
    `;
  }

  let menuHtml = `
    <div class="custom-role-select-menu" style="display: none;" onclick="event.stopPropagation()">
      ${searchHtml}
      <div class="custom-role-select-list">
  `;

  if (optional) {
    const isSelected = !cleanVal;
    menuHtml += `
      <div class="custom-role-select-opt ${isSelected ? 'selected' : ''}" data-value="" data-label="未启用" onclick="selectCustomRoleItem('${containerId}', '${hiddenInputId}', '', '${role}')">
        <span class="custom-role-select-opt-name" style="color:var(--text-muted);">(未启用 / 留空)</span>
        ${isSelected ? '<span class="custom-role-select-opt-check">✓</span>' : ''}
      </div>
    `;
  }

  if (groupLabel && sortedItems.length > 0) {
    menuHtml += `<div class="custom-role-select-group-title">${escapeHtml(groupLabel)}</div>`;
  }

  sortedItems.forEach(it => {
    const isSelected = it.id === cleanVal;
    const itemIcon = (typeof renderModelIcon === 'function') ? renderModelIcon(it.id) : '';
    const badge = it.provider ? `<span class="custom-role-select-opt-badge">${escapeHtml(it.provider)}</span>` : '';
    menuHtml += `
      <div class="custom-role-select-opt ${isSelected ? 'selected' : ''}" data-value="${escapeHtml(it.id)}" data-label="${escapeHtml(it.label || it.id)}" onclick="selectCustomRoleItem('${containerId}', '${hiddenInputId}', '${escapeHtml(it.id)}', '${role}')">
        <span class="custom-role-select-opt-icon">${itemIcon}</span>
        <span class="custom-role-select-opt-name" title="${escapeHtml(it.id)}">${escapeHtml(it.id)}</span>
        ${badge}
        ${isSelected ? '<span class="custom-role-select-opt-check">✓</span>' : ''}
      </div>
    `;
  });

  menuHtml += `
        <div class="custom-role-select-custom-btn" onclick="promptCustomRoleItem('${containerId}', '${hiddenInputId}', '${role}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <span>自定义输入模型...</span>
        </div>
      </div>
    </div>
  `;

  container.innerHTML = '';
  container.appendChild(hiddenInput);
  container.insertAdjacentHTML('beforeend', triggerHtml + menuHtml);
}

function populateRoleSelects(selectedValues = {}, targetProvider = null) {
  const providers = globalThis.providerStore?.providers || [];
  const p = targetProvider || (selectedValues.sourceProviderId ? providers.find(x => x.id === selectedValues.sourceProviderId) : null);
  const isLocalProxy = !p || p.isLocalProxy || p.meta?.localProxy || p.id === 'local-proxy' || p.id === 'anybridge' || p.name === 'AnyBridge';
  const isAnyRouter = (p?.name || p?.id || p?.apiHost || '').toLowerCase().includes('anyrouter');

  let modelItems = [];
  let groupLabel = '';

  if (isLocalProxy) {
    const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
    groupLabel = `本地代理路由 (${routes.length})`;
    modelItems = routes.map(r => {
      const cleanId = stripClaudeDesktop1mMarker(r.id);
      const targetProvId = r.targets?.[0]?.providerId;
      const targetProv = targetProvId
        ? ((globalThis.providerStore?.providers || []).find(pr => pr.id === targetProvId)?.name || targetProvId)
        : '';
      return { id: cleanId, label: cleanId, provider: targetProv };
    });
  } else {
    const rawModels = getProviderModelList(p);
    groupLabel = p?.name ? `供应商【${p.name}】模型 (${rawModels.length})` : `当前供应商模型 (${rawModels.length})`;
    modelItems = rawModels.map(m => {
      const cleanId = stripClaudeDesktop1mMarker(m);
      return { id: cleanId, label: cleanId, provider: '' };
    });
  }

  const roles = [
    { key: 'sonnetModel', role: 'sonnet', name: 'Sonnet 主模型' },
    { key: 'opusModel', role: 'opus', name: 'Opus 深度推理' },
    { key: 'haikuModel', role: 'haiku', name: 'Haiku 轻量快速' },
    { key: 'fableModel', role: 'fable', name: 'Fable 扩展模型', optional: true },
  ];

  roles.forEach(({ key, role, optional }) => {
    const containerId = `claude-desktop-role-select-${role}`;
    const hiddenInputId = `claude-desktop-config-${role}`;
    const hiddenInput = document.getElementById(hiddenInputId);
    let rawVal = selectedValues[key] !== undefined ? selectedValues[key] : (hiddenInput ? hiddenInput.value : '');
    let cleanVal = stripClaudeDesktop1mMarker(rawVal);
    let use1m = hasClaudeDesktop1mMarker(rawVal) || (isAnyRouter && String(cleanVal).toLowerCase().includes('claude'));

    // 如果当前选中的值不在列表中且非空，仅在编辑已有配置时作为保留项加入
    const availableItems = [...modelItems];
    const isEditing = !!document.getElementById('claude-desktop-config-edit-id')?.value;
    if (isEditing && cleanVal && !availableItems.some(it => it.id === cleanVal)) {
      availableItems.unshift({ id: cleanVal, label: cleanVal, provider: '已保存' });
    }

    renderCustomRoleSelect({
      containerId,
      hiddenInputId,
      role,
      currentValue: cleanVal,
      groupLabel,
      items: availableItems,
      optional,
    });

    setClaudeDesktop1m(role, use1m);
  });

  syncClaudeDesktopRawConfigFromFields();
}

// 绑定全局点击关闭下拉菜单监听
if (typeof document !== 'undefined' && !window._customRoleSelectGlobalBound) {
  window._customRoleSelectGlobalBound = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-role-select')) {
      closeAllCustomRoleMenus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllCustomRoleMenus();
    }
  });
}

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

function getClaudeDesktopCombinedSources() {
  let providers = (globalThis.providerStore?.providers || []).filter(p => p && p.enabled !== false && !p.isLocalProxy);

  // 构造并注入 AnyBridge 本地代理与 CPA 本地代理到前列，保持和 Cursor / Codex 等页面 100% 一致
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

  // 检查是否有 CPA 本地代理供应商
  const cpaEntry = (globalThis.providerStore?.providers || []).find(p => p && (p.meta?.cpaLocal === true || p.id === 'cpa-local' || p.id === 'cpa' || p.name === 'CPA'));
  if (cpaEntry && !builtinList.some(b => b.id === cpaEntry.id)) {
    builtinList.push(cpaEntry);
  }

  return [...builtinList, ...providers.filter(p => !builtinList.some(b => b.id === p.id))];
}

function renderClaudeDesktopSourceList(selectedId = '') {
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
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
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
    setClaudeDesktopModelStatus(`本地代理路由已刷新，共 ${routes.length} 个可用模型`, 'success');
    if (typeof showBottomToast === 'function') {
      showBottomToast(`本地代理路由已刷新，共 ${routes.length} 个可用模型`, 'success');
    }
    return;
  }

  const btn = document.getElementById('claude-desktop-config-fetch-models-btn');
  const setBtnLoading = (loading) => {
    if (!btn) return;
    btn.disabled = !!loading;
    btn.classList.toggle('is-loading', !!loading);
    btn.innerHTML = loading
      ? '<span style="display:inline-block;animation:spin 1s linear infinite;">⟳</span><span>拉取中...</span>'
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
        </svg><span>拉取模型列表</span>`;
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
    const pInStore = (globalThis.providerStore?.providers || []).find(pr => pr.id === p.id);
    if (pInStore) {
      pInStore.models = [...cleanFetched];
      if (typeof persistProviders === 'function') {
        persistProviders();
      }
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

function openClaudeDesktopAddModal() {
  navigateTo('platform-claude-desktop-add');
  const titleEl = document.getElementById('claude-desktop-config-page-title');
  const subEl = document.getElementById('claude-desktop-config-page-sub');
  if (titleEl) titleEl.textContent = '添加配置 · Claude Desktop';
  if (subEl) subEl.textContent = '配置桌面端本地路由与各档位角色的模型映射。';

  const editIdInput = document.getElementById('claude-desktop-config-edit-id');
  if (editIdInput) editIdInput.value = '';
  const sourceIdInput = document.getElementById('claude-desktop-config-source-id');
  if (sourceIdInput) sourceIdInput.value = '';
  const nameInput = document.getElementById('claude-desktop-config-name');
  if (nameInput) nameInput.value = '';
  const modeInput = document.getElementById('claude-desktop-config-mode');
  if (modeInput) modeInput.value = 'proxy';

  ['sonnet', 'opus', 'fable', 'haiku'].forEach(role => {
    const el = document.getElementById(`claude-desktop-config-${role}-name`);
    if (el) el.value = '';
    const hidden = document.getElementById(`claude-desktop-config-${role}`);
    if (hidden) hidden.value = '';
  });

  const sourceList = getClaudeDesktopCombinedSources();
  const firstP = sourceList[0] || null;
  const firstId = firstP ? (firstP.providerId || firstP.id) : '';

  renderClaudeDesktopSourceList(firstId);

  if (firstId) {
    onClaudeDesktopSourceSelect(firstId);
  } else {
    populateRoleSelects({});
  }

  const resetFn = globalThis.resetPasswordInputVisibility || (typeof resetPasswordInputVisibility === 'function' ? resetPasswordInputVisibility : null);
  if (resetFn) {
    resetFn('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
  }

  if (typeof globalThis.loadPlatformRealConfigFile === 'function') {
    globalThis.loadPlatformRealConfigFile('claude-desktop', 'claude-desktop-config-raw-json');
  }

  window.setTimeout(() => {
    document.getElementById('claude-desktop-config-name')?.focus();
  }, 50);
}

function editClaudeDesktopConfig(configId) {
  navigateTo('platform-claude-desktop-add');
  const configs = getClaudeDesktopConfigs();
  const cfg = configs.find(c => c.id === configId);
  if (!cfg) return;

  const titleEl = document.getElementById('claude-desktop-config-page-title');
  const subEl = document.getElementById('claude-desktop-config-page-sub');
  if (titleEl) titleEl.textContent = '编辑配置 · Claude Desktop';
  if (subEl) subEl.textContent = `正在编辑「${cfg.name}」这份 Claude Desktop 配置。`;

  const editIdInput = document.getElementById('claude-desktop-config-edit-id');
  if (editIdInput) editIdInput.value = cfg.id;
  const sourceIdInput = document.getElementById('claude-desktop-config-source-id');
  if (sourceIdInput) sourceIdInput.value = cfg.sourceProviderId || '';
  const nameInput = document.getElementById('claude-desktop-config-name');
  if (nameInput) nameInput.value = cfg.name || '';
  const modeInput = document.getElementById('claude-desktop-config-mode');
  if (modeInput) modeInput.value = cfg.mode || 'proxy';

  const baseUrlInput = document.getElementById('claude-desktop-config-base-url');
  if (baseUrlInput) baseUrlInput.value = cfg.apiHost || cfg.baseUrl || '';
  const apiKeyInput = document.getElementById('claude-desktop-config-api-key');
  if (apiKeyInput) apiKeyInput.value = cfg.apiKey || '';

  const sonnetNameInput = document.getElementById('claude-desktop-config-sonnet-name');
  if (sonnetNameInput) sonnetNameInput.value = cfg.sonnetName || '';
  const opusNameInput = document.getElementById('claude-desktop-config-opus-name');
  if (opusNameInput) opusNameInput.value = cfg.opusName || '';
  const fableNameInput = document.getElementById('claude-desktop-config-fable-name');
  if (fableNameInput) fableNameInput.value = cfg.fableName || '';
  const haikuNameInput = document.getElementById('claude-desktop-config-haiku-name');
  if (haikuNameInput) haikuNameInput.value = cfg.haikuName || '';

  const providers = globalThis.providerStore?.providers || [];
  const p = cfg.sourceProviderId ? providers.find(x => x.id === cfg.sourceProviderId) : null;

  renderClaudeDesktopSourceList(cfg.sourceProviderId || '');
  populateRoleSelects({
    sourceProviderId: cfg.sourceProviderId || '',
    sonnetModel: cfg.sonnetModel,
    opusModel: cfg.opusModel,
    haikuModel: cfg.haikuModel,
    fableModel: cfg.fableModel,
  }, p);

  setClaudeDesktopModelStatus(`正在编辑「${cfg.name}」模型映射`, 'success');

  const resetFnEdit = globalThis.resetPasswordInputVisibility || (typeof resetPasswordInputVisibility === 'function' ? resetPasswordInputVisibility : null);
  if (resetFnEdit) {
    resetFnEdit('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
  }

  if (typeof globalThis.loadPlatformRealConfigFile === 'function') {
    globalThis.loadPlatformRealConfigFile('claude-desktop', 'claude-desktop-config-raw-json');
  }

  window.setTimeout(() => {
    document.getElementById('claude-desktop-config-name')?.focus();
  }, 50);
}

function closeClaudeDesktopConfigEditor() {
  navigateTo('platform-claude-desktop');
}

async function saveClaudeDesktopConfigEditor(switchAfter = false) {
  const editId = document.getElementById('claude-desktop-config-edit-id')?.value.trim();
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value.trim();
  const name = document.getElementById('claude-desktop-config-name')?.value.trim();
  const mode = document.getElementById('claude-desktop-config-mode')?.value.trim() || 'proxy';
  const apiHost = document.getElementById('claude-desktop-config-base-url')?.value.trim() || '';
  const apiKey = document.getElementById('claude-desktop-config-api-key')?.value.trim() || '';

  let sonnetModel = getClaudeDesktopRoleVal('sonnet');
  let opusModel = getClaudeDesktopRoleVal('opus');
  let fableModel = getClaudeDesktopRoleVal('fable');
  let haikuModel = getClaudeDesktopRoleVal('haiku');

  // CC Switch 规范：留空的档会自动沿用 Sonnet（或第一个已填档）的模型，确保子 agent 调用的 Haiku 始终可用
  const fallbackModel = sonnetModel || opusModel || fableModel || haikuModel;
  if (!fallbackModel) {
    showCustomAlert('请至少为一个档位（如 Sonnet）选择映射模型。', '提示', 'warn');
    return;
  }
  if (!sonnetModel) sonnetModel = fallbackModel;
  if (!opusModel) opusModel = fallbackModel;
  if (!haikuModel) haikuModel = fallbackModel;

  const sonnetName = document.getElementById('claude-desktop-config-sonnet-name')?.value.trim() || '';
  const opusName = document.getElementById('claude-desktop-config-opus-name')?.value.trim() || '';
  const fableName = document.getElementById('claude-desktop-config-fable-name')?.value.trim() || '';
  const haikuName = document.getElementById('claude-desktop-config-haiku-name')?.value.trim() || '';

  if (!name) {
    showCustomAlert('请输入配置名称。', '提示', 'warn');
    return;
  }

  // 避免同名配置混淆校验
  const configs = getClaudeDesktopConfigs();
  let targetId = editId;
  const isDuplicateName = configs.some(
    c => c && c.id !== targetId && String(c.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Claude Desktop 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('claude-desktop-config-name')?.focus();
    return;
  }

  const providers = globalThis.providerStore?.providers || [];
  const sourceProvider = providers.find(p => p.id === sourceId);

  if (!targetId) {
    targetId = `claude-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const newConfig = {
    id: targetId,
    name,
    mode,
    apiHost,
    apiKey,
    sourceProviderId: sourceId,
    sourceProviderName: sourceProvider ? (sourceProvider.name || sourceProvider.id) : (mode === 'proxy' ? 'AnyBridge 代理' : '直连'),
    sonnetModel,
    opusModel,
    haikuModel,
    fableModel,
    sonnetName,
    opusName,
    fableName,
    haikuName,
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

  const currentInfo = globalThis.claudeDesktopStatus || {};
  const isCurrentlyApplied = !!currentInfo.managedByAnyBridge && (currentInfo.currentProviderId === cfg.id || (!currentInfo.currentProviderId && cfg.id === 'claude-desktop-default-proxy'));
  const promptTitle = isCurrentlyApplied ? '重新配置' : '切换配置';
  const promptRoles = [
    ['Sonnet', cfg.sonnetModel],
    ['Opus', cfg.opusModel],
    ['Haiku', cfg.haikuModel],
  ];
  if (cfg.fableModel) promptRoles.push(['Fable', cfg.fableModel]);
  const promptRoleText = promptRoles
    .map(([role, model]) => `${role}: ${getRouteLabel(model) || '未选'}`)
    .join(', ');
  const promptText = isCurrentlyApplied
    ? `确定重新配置「${cfg.name}」吗？\n\n将重新写入本地路由配置（${promptRoleText}）。\n完成后请重启 Claude Desktop。`
    : `确定切换到配置「${cfg.name}」吗？\n\n将开启本地路由模式（${promptRoleText}）。\n切换后请重启 Claude Desktop。`;

  const ok = await showCustomConfirm(promptText, promptTitle, 'info');
  if (!ok) return;

  try {
    const bindings = {
      sonnet: cfg.sonnetModel,
      opus: cfg.opusModel,
      haiku: cfg.haikuModel,
      fable: cfg.fableModel || '',
      sonnetName: cfg.sonnetName || '',
      opusName: cfg.opusName || '',
      fableName: cfg.fableName || '',
      haikuName: cfg.haikuName || '',
    };

    if (globalThis.invoke) {
      await invoke('save_claude_desktop_bindings', { bindings });
      const res = await invoke('switch_platform', { platform: 'claude-desktop', providerId: cfg.id });
      if (typeof addLog === 'function') addLog('ok', res?.message || (isCurrentlyApplied ? `已重新配置 ${cfg.name}` : `已切换至 ${cfg.name}`));
      const successMsg = isCurrentlyApplied
        ? '当前配置已重新写入，请重启 Claude Desktop 生效。'
        : (res?.message || '配置已成功应用，请重启 Claude Desktop 生效。');
      showCustomAlert(successMsg, isCurrentlyApplied ? '重新配置成功' : '切换成功', 'success');
      await loadClaudeDesktopConsole();
      if (typeof refreshPlatforms === 'function') refreshPlatforms({ silent: true });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${promptTitle}失败: ${e}`);
    showCustomAlert(String(e), `${promptTitle}失败`, 'error');
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

function toggleClaudeDesktopKeyVisibility() {
  const toggleFn = globalThis.togglePasswordInputVisibility || (typeof togglePasswordInputVisibility === 'function' ? togglePasswordInputVisibility : null);
  if (toggleFn) {
    toggleFn('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
    return;
  }
  const input = document.getElementById('claude-desktop-config-api-key');
  const btn = document.getElementById('claude-desktop-config-api-key-toggle');
  if (!input) return;
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  if (btn) {
    btn.innerHTML = isPwd
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  }
}

function syncClaudeDesktopConfigTokenFromSource() {
  const sourceId = String(document.getElementById('claude-desktop-config-source-id')?.value || '').trim();
  const configName = String(document.getElementById('claude-desktop-config-name')?.value || '').trim();
  const providers = globalThis.providerStore?.providers || [];
  const source = providers.find(p => p && (
    (sourceId && (p.id === sourceId || p.providerId === sourceId)) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    showCustomAlert('未找到关联的来源供应商，请先在左侧选择来源供应商。', '无法同步', 'warn');
    return;
  }

  const baseUrlInput = document.getElementById('claude-desktop-config-base-url');
  if (baseUrlInput) {
    if (source.isLocalProxy || source.meta?.localProxy || source.id === 'local-proxy' || source.id === 'anybridge' || source.name === 'AnyBridge') {
      baseUrlInput.value = 'http://127.0.0.1:7450/v1';
    } else {
      const endpoint = source.apiHost ? (source.apiPath ? `${source.apiHost.replace(/\/+$/, '')}${source.apiPath}` : `${source.apiHost.replace(/\/+$/, '')}/v1`) : '';
      baseUrlInput.value = endpoint || source.apiHost || '';
    }
  }

  const apiKeyInput = document.getElementById('claude-desktop-config-api-key');
  if (apiKeyInput) {
    if (source.isLocalProxy || source.meta?.localProxy || source.id === 'local-proxy' || source.id === 'anybridge' || source.name === 'AnyBridge') {
      apiKeyInput.value = (typeof getLocalProxyKeyValue === 'function') ? getLocalProxyKeyValue() : (source.apiKey || '');
    } else {
      apiKeyInput.value = source.apiKey || '';
    }
  }

  syncClaudeDesktopRawConfigFromFields();
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌与地址`, 'success');
  } else {
    showCustomAlert(`已同步供应商「${source.name || source.id}」的最新令牌与地址。`, '同步成功', 'success');
  }
}

// 挂载全局方法
globalThis.loadClaudeDesktopConsole = loadClaudeDesktopConsole;
globalThis.updateClaudeDesktopProxyBadge = updateClaudeDesktopProxyBadge;
globalThis.updateClaudeDesktopModeHeader = updateClaudeDesktopModeHeader;
globalThis.onClaudeDesktopHeroModeClick = onClaudeDesktopHeroModeClick;
globalThis.renderClaudeDesktopConfigList = renderClaudeDesktopConfigList;
globalThis.onClaudeDesktopConfigSearch = onClaudeDesktopConfigSearch;
globalThis.openClaudeDesktopAddModal = openClaudeDesktopAddModal;
globalThis.openClaudeDesktopConfigEditor = openClaudeDesktopAddModal;
globalThis.editClaudeDesktopConfig = editClaudeDesktopConfig;
globalThis.deleteClaudeDesktopConfig = deleteClaudeDesktopConfig;
globalThis.closeClaudeDesktopConfigEditor = closeClaudeDesktopConfigEditor;
globalThis.onClaudeDesktopSourceSearch = onClaudeDesktopSourceSearch;
globalThis.saveClaudeDesktopConfigEditor = saveClaudeDesktopConfigEditor;
globalThis.applyClaudeDesktopConfig = applyClaudeDesktopConfig;
globalThis.restoreClaudeDesktopOfficialConfig = restoreClaudeDesktopOfficialConfig;
globalThis.refreshClaudeDesktopAction = refreshClaudeDesktopAction;
globalThis.onClaudeDesktopSourceSelect = onClaudeDesktopSourceSelect;
globalThis.syncClaudeDesktopRawConfigFromFields = syncClaudeDesktopRawConfigFromFields;
globalThis.onClaudeDesktopRoleSelectChange = onClaudeDesktopRoleSelectChange;
globalThis.onClaudeDesktop1mChange = onClaudeDesktop1mChange;
globalThis.claudeDesktopQuickSetAllModels = claudeDesktopQuickSetAllModels;
globalThis.getClaudeDesktopRoleVal = getClaudeDesktopRoleVal;
globalThis.populateRoleSelects = populateRoleSelects;
globalThis.fetchClaudeDesktopConfigModels = fetchClaudeDesktopConfigModels;
globalThis.setClaudeDesktopModelStatus = setClaudeDesktopModelStatus;
globalThis.toggleCustomRoleMenu = toggleCustomRoleMenu;
globalThis.filterCustomRoleMenu = filterCustomRoleMenu;
globalThis.selectCustomRoleItem = selectCustomRoleItem;
globalThis.promptCustomRoleItem = promptCustomRoleItem;
globalThis.renderCustomRoleSelect = renderCustomRoleSelect;
globalThis.toggleClaudeDesktopKeyVisibility = toggleClaudeDesktopKeyVisibility;
globalThis.syncClaudeDesktopConfigTokenFromSource = syncClaudeDesktopConfigTokenFromSource;

// 脚本载入时尝试预渲染（如果 DOM 已存在）
if (typeof document !== 'undefined' && document.getElementById('platform-claude-desktop-config-list')) {
  renderClaudeDesktopConfigList();
}
