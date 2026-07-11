// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// ═══════ 扩展中心 ═══════
globalThis.CPAMP_MANAGEMENT_URL = 'http://127.0.0.1:18317/management.html';

globalThis.CPAMP_PLUGINS_URL = `${CPAMP_MANAGEMENT_URL}#/plugins`;
globalThis.EXTENSION_AUTO_REFRESH_MS = 10000;
globalThis.EXTENSION_TRANSIENT_STATUSES = new Set([
  'checking',
  'installing',
  'starting',
  'stopping',
  'updating',
  'uninstalling'
]);
globalThis.extensionServicesById = new Map();
globalThis.activeExtensionDetailId = '';
globalThis.cpaUpdateReport = null;
globalThis.cpaInstallDir = null;
globalThis.extensionAutoRefreshTimer = null;
globalThis.extensionDeployInProgress = false;
globalThis.cpaProgressState = { percent: 0, message: '' };

globalThis.EXTENSION_CATALOG = {
  'cpa-suite': {
    short: 'CPA',
    name: 'CPA 套件',
    kicker: '本地网关套件',
    description: 'CLIProxyAPI + CPA Manager Plus + CPA 插件商店，一键部署为本地 AI 网关管理中心。',
    type: '本地套件',
    level: 'L4 深度集成',
    primaryAction: 'install-cpa',
    primaryLabel: '一键部署',
    secondaryAction: 'check-cpa-update',
    secondaryLabel: '检测更新',
    github: [
      { label: 'CLIProxyAPI', url: 'https://github.com/router-for-me/CLIProxyAPI' },
      { label: 'CPA Manager Plus', url: 'https://github.com/seakee/CPA-Manager-Plus' }
    ],
    components: [
      { name: 'CLIProxyAPI', detail: '网关本体、管理接口，默认端口 8317', port: 8317 },
      { name: 'CPA Manager Plus', detail: '管理面板、统计、插件商店，默认端口 18317', port: 18317 },
      { name: 'CPA 插件', detail: '复用 CPA 插件库，后续展示安装数和可更新数', port: null }
    ],
    notes: [
      '支持 Windows / macOS / Linux：按当前系统自动选择 GitHub 发布包（zip 或 tar.gz）。',
      '安装前会弹出确认，明确展示下载来源、端口和本地进程运行风险。',
      '若对应平台暂无发布包，部署会明确报错；请查看 CLIProxyAPI / CPA Manager Plus 的 Release 资产。',
      'CPA 插件属于本地动态库能力，后续安装前需要显式提示本机代码执行风险。'
    ]
  },
  sub2api: {
    short: 'S2',
    name: 'sub2api',
    kicker: '供应商适配',
    description: '把订阅或账号能力转换成兼容 OpenAI 的接口，安装后可自动生成 AnyBridge 供应商。',
    type: '托管服务',
    level: 'L2-L3',
    primaryAction: 'install-sub2api',
    primaryLabel: '安装',
    secondaryAction: 'view-adapter-plan',
    secondaryLabel: '适配计划',
    github: [
      { label: 'GitHub 搜索：sub2api', url: 'https://github.com/search?q=sub2api&type=repositories' }
    ],
    components: [
      { name: 'sub2api 服务', detail: '仓库确认后补齐运行时、配置文件、默认端口和健康检查路径。', port: null }
    ],
    notes: [
      '具体仓库尚未确认，所以这里先放 GitHub 搜索入口，不伪造项目地址。',
      '适配完成后目标是安装本地服务，并自动生成 AnyBridge 兼容 OpenAI 的供应商。'
    ]
  },
  grok2api: {
    short: 'GX',
    name: 'grok2api',
    kicker: 'Grok 接口桥接',
    description: '面向 Grok/xAI 的本地接口适配服务，后续与 AnyBridge 联网搜索增强联动。',
    type: '托管服务',
    level: 'L2-L3',
    primaryAction: 'install-grok2api',
    primaryLabel: '安装',
    secondaryAction: 'view-adapter-plan',
    secondaryLabel: '适配计划',
    github: [
      { label: 'GitHub 搜索：grok2api', url: 'https://github.com/search?q=grok2api&type=repositories' }
    ],
    components: [
      { name: 'grok2api 服务', detail: '仓库确认后补齐鉴权方式、模型列表和健康检查。', port: null }
    ],
    notes: [
      '具体仓库尚未确认，所以这里先放 GitHub 搜索入口，不伪造项目地址。',
      '适配后会优先支持填写令牌、Cookie 或密钥，再生成 Grok 供应商配置。'
    ]
  },
  'free-jimeng': {
    short: 'JM',
    name: 'free 即梦',
    kicker: '生成服务桥接',
    description: '即梦相关生成接口的预留卡位。确认仓库和接口格式后再选择本地托管或外部服务接入。',
    type: '待确认',
    level: 'L1-L3',
    primaryAction: 'install-jimeng',
    primaryLabel: '安装',
    secondaryAction: 'view-adapter-plan',
    secondaryLabel: '适配计划',
    github: [
      { label: 'GitHub 搜索：free 即梦接口', url: 'https://github.com/search?q=free+jimeng+api&type=repositories' }
    ],
    components: [
      { name: 'free 即梦服务', detail: '待确认图片/视频生成接口、运行时和账号登录方式。', port: null }
    ],
    notes: [
      '具体仓库尚未确认，所以这里先放 GitHub 搜索入口，不伪造项目地址。',
      '如果项目不提供稳定二进制发布包，第一阶段会先按外部服务接入。'
    ]
  }
};

globalThis.EXTENSION_STATUS_LABELS = {
  checking: '检测中',
  pending: '待接入',
  'not-installed': '未安装',
  installed: '已安装未运行',
  stopped: '未运行',
  running: '运行中',
  degraded: '部分异常',
  error: '检测失败',
  installing: '部署中',
  starting: '启动中',
  stopping: '停止中',
  updating: '更新中',
  uninstalling: '卸载中'
};

globalThis.EXTENSION_STATUS_CLASSES = [
  'status-pending',
  'status-checking',
  'status-not-installed',
  'status-installed',
  'status-running',
  'status-degraded',
  'status-error',
  'status-stopped',
  'status-installing',
  'status-starting',
  'status-stopping',
  'status-updating',
  'status-uninstalling'
];

globalThis.EXTENSION_COMPONENT_DOT_CLASSES = [
  'pending',
  'muted',
  'running',
  'stopped',
  'degraded',
  'installed',
  'error'
];

globalThis.EXTENSION_LOG_LABELS = {
  info: '信息',
  warn: '警告',
  err: '错误',
  ok: '完成'
};

function extensionNotify(message, type = 'info') {
  if (typeof showBottomToast === 'function') {
    showBottomToast(message, type, { duration: 3200 });
    return;
  }
  console.log(`[扩展:${type}] ${message}`);
}

function openExtensionSettings() {
  const modal = document.getElementById('extension-settings-modal');
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add('active');
  loadCpaInstallDir();
  document.addEventListener('keydown', closeExtensionSettingsOnEsc);
}

function closeExtensionSettings() {
  const modal = document.getElementById('extension-settings-modal');
  if (!modal) return;
  modal.classList.remove('active');
  modal.hidden = true;
  document.removeEventListener('keydown', closeExtensionSettingsOnEsc);
}

function closeExtensionSettingsOnEsc(event) {
  if (event.key === 'Escape') closeExtensionSettings();
}

function toggleExtensionSettings() {
  const modal = document.getElementById('extension-settings-modal');
  if (!modal) return;
  if (modal.classList.contains('active') && !modal.hidden) closeExtensionSettings();
  else openExtensionSettings();
}

function bindExtensionSettingsModal() {
  const modal = document.getElementById('extension-settings-modal');
  if (!modal || modal.dataset.overlayBound === '1') return;
  modal.dataset.overlayBound = '1';
  modal.addEventListener('click', event => {
    if (event.target === modal) closeExtensionSettings();
  });
}

globalThis.EXTENSION_LOG_FILTERS = ['all', 'ok', 'info', 'warn', 'err'];
globalThis.extensionLogEntries = [];
globalThis.extensionLogFilter = 'all';
globalThis.EXTENSION_MAX_LOGS = 500;

function extensionNowTs() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function extensionEscapeHtml(s) {
  return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderExtensionLogLine(e) {
  const level = extensionEscapeHtml(e.level);
  const label = extensionEscapeHtml(String(e.level || '').toUpperCase());
  return `<div class="log-line" data-level="${level}"><span class="log-ts">${extensionEscapeHtml(e.ts)}</span><span class="log-lv ${level}">${label}</span><span class="log-msg">${extensionEscapeHtml(e.msg)}</span></div>`;
}

function renderExtensionLogs() {
  const body = document.getElementById('extensionLogBody');
  const count = document.getElementById('extensionLogCount');
  const filtered = extensionLogFilter !== 'all'
    ? extensionLogEntries.filter(e => e.level === extensionLogFilter)
    : extensionLogEntries;
  if (body) {
    body.innerHTML = filtered.map(renderExtensionLogLine).join('');
    body.scrollTop = body.scrollHeight;
  }
  if (count) count.textContent = `${filtered.length} 条记录`;
}

function extensionLog(level, message) {
  const normalized = level === 'error' ? 'err' : (level || 'info');
  extensionLogEntries.push({ ts: extensionNowTs(), level: normalized, msg: message });
  if (extensionLogEntries.length > EXTENSION_MAX_LOGS) {
    extensionLogEntries = extensionLogEntries.slice(-EXTENSION_MAX_LOGS);
  }
  renderExtensionLogs();
}

function setExtensionLogFilter(level) {
  if (!EXTENSION_LOG_FILTERS.includes(level)) return;
  extensionLogFilter = level;
  document.querySelectorAll('#extensionLogTabs .log-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.level === level);
  });
  renderExtensionLogs();
}

function extensionStatusLabel(status) {
  return EXTENSION_STATUS_LABELS[status] || EXTENSION_STATUS_LABELS.pending;
}

function setExtensionStatusBadge(el, status, label) {
  if (!el) return;
  el.classList.remove(...EXTENSION_STATUS_CLASSES);
  const normalized = status || 'pending';
  const className = normalized === 'not-installed' ? 'status-not-installed' : `status-${normalized}`;
  el.classList.add(EXTENSION_STATUS_CLASSES.includes(className) ? className : 'status-pending');
  el.textContent = label || extensionStatusLabel(normalized);
}

function isExtensionsPageActive() {
  return Boolean(document.getElementById('page-extensions')?.classList.contains('active'));
}

function clearExtensionAutoRefresh() {
  if (extensionAutoRefreshTimer) {
    clearTimeout(extensionAutoRefreshTimer);
    extensionAutoRefreshTimer = null;
  }
}

function scheduleExtensionAutoRefresh(status) {
  clearExtensionAutoRefresh();
  if (!isExtensionsPageActive()) return;
  if (extensionDeployInProgress || EXTENSION_TRANSIENT_STATUSES.has(status)) return;
  if (status !== 'degraded' && status !== 'error') return;
  extensionAutoRefreshTimer = setTimeout(async () => {
    extensionAutoRefreshTimer = null;
    if (!isExtensionsPageActive()) return;
    const current = extensionServicesById.get('cpa-suite')?.status;
    if (extensionDeployInProgress || EXTENSION_TRANSIENT_STATUSES.has(current)) return;
    await refreshExtensionStatuses({ silent: true, auto: true });
  }, EXTENSION_AUTO_REFRESH_MS);
}

function setCpaProgress(percent, message, visible = true) {
  const host = document.getElementById('extension-cpa-progress');
  const fill = document.getElementById('extension-cpa-progress-fill');
  const text = document.getElementById('extension-cpa-progress-text');
  const pct = document.getElementById('extension-cpa-progress-percent');
  if (!host) return;
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  cpaProgressState = { percent: normalized, message: message || cpaProgressState.message || '' };
  host.hidden = !visible;
  if (fill) fill.style.width = `${normalized}%`;
  if (text) text.textContent = cpaProgressState.message || '处理中...';
  if (pct) pct.textContent = `${Math.round(normalized)}%`;
}

function hideCpaProgress() {
  extensionDeployInProgress = false;
  setCpaProgress(0, '', false);
  const status = extensionServicesById.get('cpa-suite')?.status;
  if (status) scheduleExtensionAutoRefresh(status);
}

function setCpaSuiteTransientStatus(status, label) {
  setExtensionStatusBadge(document.getElementById('extension-cpa-status'), status, label);
  const service = extensionServicesById.get('cpa-suite');
  const installed = Boolean(service?.installed) || status === 'starting' || status === 'stopping'
    || status === 'updating' || status === 'uninstalling' || status === 'installed';
  const hasUpdate = cpaUpdateReport?.components?.some(component => component.updateAvailable === true);
  renderCpaActions(status, installed, hasUpdate);
  if (status === 'installing' || status === 'updating') {
    extensionDeployInProgress = true;
    if (!document.getElementById('extension-cpa-progress') || document.getElementById('extension-cpa-progress').hidden) {
      setCpaProgress(2, status === 'updating' ? '准备更新...' : '准备部署...', true);
    }
  }
  clearExtensionAutoRefresh();
}

function collectCpaAlertMessages(service) {
  const messages = [];
  const status = service?.status || '';
  const components = Array.isArray(service?.components) ? service.components : [];
  const notes = Array.isArray(service?.notes) ? service.notes : [];

  notes.forEach(note => {
    if (/【|端口异常|健康检查异常|组件未运行|部分异常|端口有响应/.test(String(note))) {
      messages.push(String(note));
    }
  });

  components.forEach(component => {
    if (!component?.port) return;
    if (component.status === 'degraded') {
      messages.push(`${component.name} 端口 ${component.port} 响应异常：${component.detail || '健康检查未通过'}`);
    } else if (component.status === 'stopped' && status === 'degraded') {
      messages.push(`${component.name} 端口 ${component.port} 未监听`);
    }
  });

  if (status === 'error' && !messages.length) {
    messages.push('扩展状态检测失败，请确认桌面端通信通道后点击刷新。');
  }
  if (status === 'degraded' && !messages.length) {
    messages.push('套件部分组件异常，请查看详情或尝试重启。');
  }

  // 去重
  return [...new Set(messages)];
}

function renderCpaAlert(service) {
  const alert = document.getElementById('extension-cpa-alert');
  if (!alert) return;
  const status = service?.status || '';
  const portsEl = document.getElementById('extension-cpa-ports');
  const messages = (status === 'degraded' || status === 'error')
    ? collectCpaAlertMessages(service)
    : [];

  if (!messages.length) {
    alert.hidden = true;
    alert.textContent = '';
    alert.removeAttribute('data-level');
    if (portsEl) portsEl.classList.remove('meta-warn');
    return;
  }

  alert.hidden = false;
  alert.dataset.level = status === 'error' ? 'error' : 'warn';
  alert.textContent = messages.slice(0, 2).join('；');
  alert.title = messages.join('\n');

  if (portsEl) {
    const hasPortIssue = messages.some(msg => /端口|未监听|健康检查|占用|异常/.test(msg));
    portsEl.classList.toggle('meta-warn', hasPortIssue);
  }
}

function renderCpaCredentials(service) {
  const container = document.getElementById('cpa-credentials');
  if (!container) return;
  const secrets = service?.secrets;
  if (!secrets) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const adminEl = document.getElementById('cpa-cred-admin-key');
  const mgmtEl = document.getElementById('cpa-cred-management-key');
  const apiKeyEl = document.getElementById('cpa-cred-api-key');
  if (adminEl) adminEl.textContent = secrets.adminKey || '—';
  if (mgmtEl) mgmtEl.textContent = secrets.managementKey || '—';
  if (apiKeyEl) apiKeyEl.textContent = secrets.apiKey || '—';

  container.querySelectorAll('.cpa-credential-copy').forEach(btn => {
    btn.onclick = null;
    btn.classList.remove('copied');
    btn.textContent = '复制';
    btn.onclick = (e) => {
      e.stopPropagation();
      let text = '';
      const copyKey = btn.dataset.copy;
      const copyUrl = btn.dataset.copyUrl;
      if (copyKey === 'admin-key') text = secrets.adminKey || '';
      else if (copyKey === 'management-key') text = secrets.managementKey || '';
      else if (copyKey === 'api-key') text = secrets.apiKey || '';
      else if (copyUrl) text = copyUrl;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.textContent = '已复制';
        setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '复制'; }, 1500);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); btn.classList.add('copied'); btn.textContent = '已复制'; setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '复制'; }, 1500); } catch(_) {}
        document.body.removeChild(ta);
      });
    };
  });
}

function getCpaActionConfig(status, hasUpdate) {
  switch (status) {
    case 'not-installed':
      return {
        primary: { label: '一键部署', action: 'install-cpa' },
        secondary: [{ label: '详情', action: 'detail' }]
      };
    case 'installed':
      return {
        primary: { label: '启动', action: 'start-cpa-suite' },
        secondary: [
          { label: '切换版本', action: 'switch-cpa-version' },
          { label: '卸载', action: 'uninstall-cpa-suite', danger: true },
          { label: '检测更新', action: 'check-cpa-update' },
          { label: '详情', action: 'detail' }
        ]
      };
    case 'running':
      if (hasUpdate) {
        return {
          primary: { label: '更新', action: 'update-cpa-suite' },
          secondary: [
            { label: '打开面板', action: 'open-cpamp' },
            { label: '切换版本', action: 'switch-cpa-version' },
            { label: '停止', action: 'stop-cpa-suite' },
            { label: '详情', action: 'detail' }
          ]
        };
      }
      return {
        primary: { label: '打开面板', action: 'open-cpamp' },
        secondary: [
          { label: '停止', action: 'stop-cpa-suite' },
          { label: '切换版本', action: 'switch-cpa-version' },
          { label: '检测更新', action: 'check-cpa-update' },
          { label: '详情', action: 'detail' }
        ]
      };
    case 'degraded':
      return {
        primary: { label: '重启', action: 'restart-cpa-suite' },
        secondary: [
          { label: '切换版本', action: 'switch-cpa-version' },
          { label: '停止', action: 'stop-cpa-suite' },
          { label: '卸载', action: 'uninstall-cpa-suite', danger: true },
          { label: '详情', action: 'detail' }
        ]
      };
    case 'error':
      return {
        primary: { label: '刷新状态', action: 'refresh' },
        secondary: [{ label: '详情', action: 'detail' }]
      };
    case 'installing':
      return {
        primary: { label: '部署中...', action: null, disabled: true },
        secondary: []
      };
    case 'starting':
      return {
        primary: { label: '启动中...', action: null, disabled: true },
        secondary: [{ label: '详情', action: 'detail' }]
      };
    case 'stopping':
      return {
        primary: { label: '停止中...', action: null, disabled: true },
        secondary: [{ label: '详情', action: 'detail' }]
      };
    case 'updating':
      return {
        primary: { label: '更新中...', action: null, disabled: true },
        secondary: [{ label: '详情', action: 'detail' }]
      };
    case 'uninstalling':
      return {
        primary: { label: '卸载中...', action: null, disabled: true },
        secondary: []
      };
    case 'checking':
      return {
        primary: { label: '检测中...', action: null, disabled: true },
        secondary: [{ label: '详情', action: 'detail' }]
      };
    default:
      return {
        primary: { label: '一键部署', action: 'install-cpa' },
        secondary: [{ label: '详情', action: 'detail' }]
      };
  }
}

function bindCpaActionButton(el, action) {
  if (!el) return;
  el.onclick = event => {
    event?.stopPropagation?.();
    if (!action || el.disabled) return;
    if (action === 'detail') openExtensionDetail('cpa-suite');
    else handleExtensionAction(action);
  };
}

function renderCpaActions(status, _installed, hasUpdate) {
  const primary = document.getElementById('extension-cpa-primary-action');
  const secondary = document.getElementById('extension-cpa-secondary-actions');
  if (!primary || !secondary) return;

  const config = getCpaActionConfig(status, hasUpdate);
  const isTransient = EXTENSION_TRANSIENT_STATUSES.has(status);
  primary.disabled = Boolean(config.primary.disabled) || isTransient;
  primary.title = config.primary.title || '';
  bindCpaActionButton(primary, isTransient ? null : config.primary.action);

  primary.textContent = config.primary.label;
  if (isTransient) {
    const spinner = document.createElement('span');
    spinner.className = 'btn-spinner';
    primary.appendChild(spinner);
  }

  const frag = document.createDocumentFragment();
  (config.secondary || []).forEach(btn => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = btn.danger ? 'btn-ghost extension-action-danger' : 'btn-ghost';
    el.textContent = btn.label;
    el.title = btn.title || '';
    bindCpaActionButton(el, btn.action);
    frag.appendChild(el);
  });
  secondary.replaceChildren(frag);
}

function setComponentDot(id, status) {
  const dot = document.getElementById(id);
  if (!dot) return;
  dot.classList.remove(...EXTENSION_COMPONENT_DOT_CLASSES);
  dot.classList.add(EXTENSION_COMPONENT_DOT_CLASSES.includes(status) ? status : 'pending');
}

function currentExtensionTab() {
  return document.querySelector('.extension-tab.active[data-extension-tab]')?.dataset.extensionTab || 'all';
}

// 兼容旧调用名
function currentExtensionFilter() {
  return currentExtensionTab();
}

function ensureExtensionBridge() {
  return Boolean(invoke || (typeof bindTauriBridge === 'function' && bindTauriBridge()));
}

function clearExtensionLogs() {
  extensionLogEntries = [];
  renderExtensionLogs();
  extensionLog('info', '部署日志已清空。');
}

function clearExtensionNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function appendExtensionMetric(host, label, value) {
  const item = document.createElement('div');
  item.className = 'extension-detail-metric';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const valueEl = document.createElement('strong');
  valueEl.textContent = value || '—';
  item.append(labelEl, valueEl);
  host.appendChild(item);
}

function switchExtensionTab(tab) {
  const normalized = tab || 'all';
  document.querySelectorAll('.extension-tab[data-extension-tab]').forEach(btn => {
    const isActive = btn.dataset.extensionTab === normalized;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  });

  const logPanel = document.getElementById('extensionsLogPanel');
  const cardGrid = document.getElementById('extensionCardGrid');
  const emptyState = document.getElementById('extensionEmptyState');
  const isLogs = normalized === 'logs';

  // 与代理页一致：日志是独立整页视图，隐藏卡片区
  if (logPanel) {
    logPanel.hidden = !isLogs;
    logPanel.classList.toggle('is-active', isLogs);
  }
  if (cardGrid) {
    cardGrid.hidden = isLogs;
    cardGrid.classList.toggle('is-hidden', isLogs);
  }

  if (isLogs) {
    if (emptyState) emptyState.hidden = true;
    // 切到日志页时滚到底部最新记录
    requestAnimationFrame(() => {
      const body = document.getElementById('extensionLogBody');
      if (body) body.scrollTop = body.scrollHeight;
    });
    return;
  }

  let visibleCount = 0;
  document.querySelectorAll('[data-extension-card]').forEach(card => {
    const tags = String(card.dataset.extensionTags || '').split(/\s+/).filter(Boolean);
    const visible = normalized === 'all' || tags.includes(normalized);
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  });

  if (emptyState) emptyState.hidden = visibleCount > 0;
}

// 兼容旧调用名
function switchExtensionFilter(filter) {
  switchExtensionTab(filter);
}

function syncExtensionCardTags(id, status) {
  const card = document.querySelector(`[data-extension-card="${id}"]`);
  if (!card) return;
  const tags = new Set(String(card.dataset.extensionTags || '').split(/\s+/).filter(Boolean));
  if (status && status !== 'not-installed') tags.add('installed');
  else tags.delete('installed');
  card.dataset.extensionTags = Array.from(tags).join(' ');
}

function describeExtensionComponent(component) {
  if (!component) return '等待状态检测。';
  const port = component.port ? `:${component.port}` : '插件库';
  const version = component.version ? `，版本 ${component.version}` : '';
  const http = component.httpStatus ? `，HTTP ${component.httpStatus}` : '';
  const installed = component.installDir ? '，已发现本地目录' : '';
  if (component.status === 'running') {
    return `${port} 有响应${http}${version}${installed}`;
  }
  if (component.status === 'stopped') {
    return `${port} 未监听${installed || '，未发现本地目录'}`;
  }
  if (component.status === 'degraded') {
    return `${port} 响应异常：${component.detail || '健康检查未通过'}`;
  }
  if (component.status === 'pending') {
    return component.detail || '等待后端管理接口接入。';
  }
  if (component.status === 'installed') {
    return `${port} 已安装但未运行${version}${installed}`;
  }
  return component.detail || `${port} 状态待确认。`;
}

function updateExtensionComponent(component) {
  const idMap = {
    'cli-proxy-api': {
      dot: 'extension-cpa-cli-dot',
      detail: 'extension-cpa-cli-detail',
      port: 'extension-cpa-cli-port'
    },
    'cpa-manager-plus': {
      dot: 'extension-cpa-cpamp-dot',
      detail: 'extension-cpa-cpamp-detail',
      port: 'extension-cpa-cpamp-port'
    },
    'cpa-plugins': {
      dot: 'extension-cpa-plugins-dot',
      detail: 'extension-cpa-plugins-detail',
      port: 'extension-cpa-plugins-port'
    }
  };
  const refs = idMap[component?.id];
  if (!refs) return;
  setComponentDot(refs.dot, component.status);
  const detail = document.getElementById(refs.detail);
  if (detail) {
    detail.textContent = describeExtensionComponent(component);
    detail.title = [component.detail, component.installDir].filter(Boolean).join('\n');
  }
  const port = document.getElementById(refs.port);
  if (port) {
    port.textContent = component.port ? `:${component.port}` : '插件库';
  }
}

function updateCpaSuiteCard(service) {
  const status = service?.status || 'error';
  const installed = Boolean(service?.installed);
  const hasUpdate = cpaUpdateReport?.components?.some(component => component.updateAvailable === true);
  extensionServicesById.set('cpa-suite', service || null);
  syncExtensionCardTags('cpa-suite', status);
  setExtensionStatusBadge(document.getElementById('extension-cpa-status'), status);

  const version = document.getElementById('extension-cpa-version');
  if (version) {
    version.textContent = service?.version || (status === 'not-installed' ? '未安装' : '版本待检测');
  }

  const updateBadge = document.getElementById('extension-cpa-update-badge');
  if (updateBadge) updateBadge.hidden = !hasUpdate;

  const components = Array.isArray(service?.components) ? service.components : [];
  const ports = components
    .filter(component => component.port)
    .map(component => component.port)
    .join(' / ');
  const portsEl = document.getElementById('extension-cpa-ports');
  if (portsEl) portsEl.textContent = ports || '8317 / 18317';

  const componentCount = document.getElementById('extension-cpa-components');
  if (componentCount) {
    const running = components.filter(component => component.status === 'running').length;
    componentCount.textContent = components.length ? `${running}/${components.length} 运行` : '3 个';
  }

  components.forEach(updateExtensionComponent);
  renderCpaActions(status, installed, hasUpdate);
  renderCpaInstallDir();
  renderCpaAlert(service);
  renderCpaCredentials(service);

  if (!extensionDeployInProgress && (status === 'running' || status === 'installed' || status === 'not-installed' || status === 'degraded' || status === 'error')) {
    hideCpaProgress();
  }

  if (service?.notes?.length) {
    document.querySelector('[data-extension-card="cpa-suite"]')?.setAttribute('title', service.notes.join('\n'));
  }

  scheduleExtensionAutoRefresh(status);
  switchExtensionTab(currentExtensionTab());
}

function updateExtensionsMetric(services) {
  const metric = document.getElementById('extensionsManagedServicesMetric');
  if (!metric) return;
  const managed = services.filter(service => service.status !== 'not-installed');
  const running = managed.filter(service => service.status === 'running').length;
  metric.textContent = managed.length ? `${running}/${managed.length} 运行` : '0 已接入';
}

function extensionPortsText(service, catalog) {
  const components = Array.isArray(service?.components) && service.components.length
    ? service.components
    : catalog?.components || [];
  const ports = components
    .filter(component => component.port)
    .map(component => component.port)
    .join(' / ');
  return ports || '待分配';
}

function renderExtensionGithubLinks(host, catalog) {
  clearExtensionNode(host);
  const links = Array.isArray(catalog?.github) ? catalog.github : [];
  if (!links.length) {
    const empty = document.createElement('div');
    empty.className = 'extension-detail-empty';
    empty.textContent = '暂无 GitHub 地址。';
    host.appendChild(empty);
    return;
  }
  links.forEach(link => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'extension-detail-link';
    row.onclick = () => openExtensionURL(link.url, link.label);
    const label = document.createElement('strong');
    label.textContent = link.label;
    const url = document.createElement('code');
    url.textContent = link.url;
    const action = document.createElement('span');
    action.textContent = '打开';
    row.append(label, url, action);
    host.appendChild(row);
  });
}

function renderExtensionComponents(host, service, catalog) {
  clearExtensionNode(host);
  const runtimeComponents = Array.isArray(service?.components) ? service.components : [];
  const source = runtimeComponents.length ? runtimeComponents : (catalog?.components || []);
  if (!source.length) {
    const empty = document.createElement('div');
    empty.className = 'extension-detail-empty';
    empty.textContent = '暂无组件信息。';
    host.appendChild(empty);
    return;
  }
  source.forEach(component => {
    const row = document.createElement('div');
    row.className = 'extension-detail-component';
    const dot = document.createElement('span');
    dot.className = `component-dot ${component.status || 'pending'}`;
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = component.name || component.id || '组件';
    const detail = document.createElement('small');
    detail.textContent = runtimeComponents.length ? describeExtensionComponent(component) : (component.detail || '待接入。');
    copy.append(name, detail);
    const code = document.createElement('code');
    code.textContent = component.port ? `:${component.port}` : (component.healthUrl ? '健康检查' : '待定');
    row.append(dot, copy, code);
    host.appendChild(row);
  });
}

function renderExtensionNotes(host, service, catalog) {
  clearExtensionNode(host);
  const notes = [
    ...(Array.isArray(catalog?.notes) ? catalog.notes : []),
    ...(Array.isArray(service?.notes) ? service.notes : [])
  ];
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'extension-detail-empty';
    empty.textContent = '暂无接入说明。';
    host.appendChild(empty);
    return;
  }
  notes.forEach(note => {
    const item = document.createElement('div');
    item.className = 'extension-detail-note';
    const text = String(note);
    if (/【|端口异常|健康检查异常|组件未运行|部分异常/.test(text)) {
      item.classList.add('extension-detail-note-alert');
    }
    item.textContent = text;
    host.appendChild(item);
  });
}

function highlightExtensionDetailAlerts(service) {
  const host = document.getElementById('extensionDetailNotes');
  if (!host || !service) return;
  const alerts = collectCpaAlertMessages(service);
  if (!alerts.length) return;
  // 将运行时告警置顶展示（若 notes 已渲染告警项则不重复）
  const existing = new Set(
    Array.from(host.querySelectorAll('.extension-detail-note')).map(el => el.textContent)
  );
  alerts.reverse().forEach(message => {
    if (existing.has(message)) return;
    const item = document.createElement('div');
    item.className = 'extension-detail-note extension-detail-note-alert';
    item.textContent = message;
    host.prepend(item);
  });
}

function openExtensionDetail(id) {
  const catalog = EXTENSION_CATALOG[id];
  if (!catalog) {
    extensionNotify('扩展详情待接入。', 'info');
    return;
  }
  activeExtensionDetailId = id;
  const service = extensionServicesById.get(id);
  const modal = document.getElementById('extension-detail-modal');
  if (!modal) return;

  const mark = document.getElementById('extensionDetailMark');
  if (mark) {
    mark.textContent = catalog.short || '扩展';
    mark.className = `extension-detail-mark extension-detail-mark-${id}`;
  }
  const kicker = document.getElementById('extensionDetailKicker');
  if (kicker) kicker.textContent = catalog.kicker || '扩展详情';
  const title = document.getElementById('extensionDetailTitle');
  if (title) title.textContent = catalog.name;
  const desc = document.getElementById('extensionDetailDescription');
  if (desc) desc.textContent = catalog.description;

  const metrics = document.getElementById('extensionDetailMetrics');
  clearExtensionNode(metrics);
  appendExtensionMetric(metrics, '状态', extensionStatusLabel(service?.status || (id === 'cpa-suite' ? 'checking' : 'not-installed')));
  appendExtensionMetric(metrics, '类型', catalog.type);
  appendExtensionMetric(metrics, '版本', service?.version || '待检测');
  appendExtensionMetric(metrics, '端口', extensionPortsText(service, catalog));
  appendExtensionMetric(metrics, '接入等级', catalog.level);
  appendExtensionMetric(metrics, '来源', service?.installSource || 'GitHub 或手动导入');
  appendExtensionMetric(metrics, '安装目录', service?.installDir || '默认');

  renderExtensionGithubLinks(document.getElementById('extensionDetailGithub'), catalog);
  renderExtensionComponents(document.getElementById('extensionDetailComponents'), service, catalog);
  renderExtensionNotes(document.getElementById('extensionDetailNotes'), service, catalog);
  highlightExtensionDetailAlerts(service);

  const secondary = document.getElementById('extensionDetailSecondaryAction');
  if (secondary) {
    secondary.textContent = catalog.secondaryLabel || '更多';
    secondary.onclick = () => handleExtensionAction(catalog.secondaryAction || 'view-adapter-plan');
  }
  const primary = document.getElementById('extensionDetailPrimaryAction');
  if (primary) {
    let primaryAction = catalog.primaryAction;
    let primaryLabel = catalog.primaryLabel || '执行操作';
    if (id === 'cpa-suite') {
      const status = service?.status || 'not-installed';
      const hasUpdate = cpaUpdateReport?.components?.some(component => component.updateAvailable === true);
      const config = getCpaActionConfig(status, hasUpdate);
      // 详情弹窗内「查看详情」无意义，降级为刷新
      if (config.primary.action === 'detail') {
        primaryAction = 'refresh';
        primaryLabel = '刷新状态';
        primary.disabled = false;
      } else {
        primaryAction = config.primary.action || catalog.primaryAction;
        primaryLabel = config.primary.label;
        primary.disabled = Boolean(config.primary.disabled);
      }
    } else {
      primary.disabled = false;
    }
    primary.textContent = primaryLabel;
    primary.onclick = () => {
      if (!primaryAction || primary.disabled) return;
      if (primaryAction === 'detail') return;
      handleExtensionAction(primaryAction);
    };
  }

  modal.classList.add('active');
  document.addEventListener('keydown', closeExtensionDetailOnEsc);
}

function closeExtensionDetail() {
  const modal = document.getElementById('extension-detail-modal');
  if (modal) modal.classList.remove('active');
  activeExtensionDetailId = '';
  document.removeEventListener('keydown', closeExtensionDetailOnEsc);
}

function closeExtensionDetailOnEsc(event) {
  if (event.key === 'Escape') closeExtensionDetail();
}

function bindExtensionCardOpeners() {
  // 仅通过「详情」按钮打开弹窗，卡片本体不响应点击
  const modal = document.getElementById('extension-detail-modal');
  if (modal && modal.dataset.overlayBound !== '1') {
    modal.dataset.overlayBound = '1';
    modal.addEventListener('click', event => {
      if (event.target === modal) closeExtensionDetail();
    });
  }
}

async function refreshExtensionStatuses(options = {}) {
  const silent = Boolean(options.silent);
  const auto = Boolean(options.auto);
  if (extensionDeployInProgress && auto) {
    scheduleExtensionAutoRefresh('degraded');
    return;
  }
  if (!ensureExtensionBridge()) {
    const message = '桌面通信通道未就绪，无法读取扩展状态。';
    if (!auto) extensionLog('err', message);
    setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'error');
    renderCpaActions('error', false, false);
    renderCpaAlert({ status: 'error', notes: [message] });
    scheduleExtensionAutoRefresh('error');
    if (!silent && typeof showCustomAlert === 'function') showCustomAlert(message, '扩展状态检测失败', 'error');
    return;
  }

  if (!silent && !auto) extensionLog('info', '正在刷新扩展状态...');
  // 自动刷新不闪「检测中」，避免卡片跳动
  if (!silent && !auto) {
    setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'checking');
    renderCpaActions('checking', false, false);
  }
  try {
    const services = await invoke('extension_list_managed_services');
    const list = Array.isArray(services) ? services : [];
    extensionServicesById = new Map(list.map(service => [service.id, service]));
    updateExtensionsMetric(list);
    updateCpaSuiteCard(extensionServicesById.get('cpa-suite'));
    const cpa = extensionServicesById.get('cpa-suite');
    if (!silent && !auto) {
      extensionLog(cpa?.status === 'running' ? 'ok' : 'info', `扩展状态已刷新：CPA 套件 ${extensionStatusLabel(cpa?.status || 'error')}。`);
    }
    if (activeExtensionDetailId) openExtensionDetail(activeExtensionDetailId);
  } catch (e) {
    const message = String(e?.message || e);
    setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'error');
    renderCpaActions('error', false, false);
    renderCpaAlert({ status: 'error', notes: [`扩展状态刷新失败: ${message}`] });
    scheduleExtensionAutoRefresh('error');
    if (!auto) extensionLog('err', `扩展状态刷新失败: ${message}`);
    if (!silent && typeof showCustomAlert === 'function') showCustomAlert(message, '扩展状态检测失败', 'error');
  }
}

function formatUpdateLine(component) {
  const current = component.currentVersion || '当前版本未知';
  const latest = component.latestVersion || '未知';
  const suffix = component.updateAvailable === true
    ? '可更新'
    : component.updateAvailable === false
      ? '已是最新'
      : '无法比较';
  return `${component.name}：${current} 更新为 ${latest}（${suffix}）`;
}

globalThis.cpaUpdateChecking = false;

async function checkCpaExtensionUpdates(autoUpdate = false) {
  if (!ensureExtensionBridge()) {
    const message = '桌面通信通道未就绪，无法检测 CPA 更新。';
    extensionLog('err', message);
    if (typeof showCustomAlert === 'function') showCustomAlert(message, 'CPA 更新检测失败', 'error');
    return;
  }
  if (cpaUpdateChecking) return;
  cpaUpdateChecking = true;

  // 显示检测中状态：禁用按钮并更改文字
  setCpaSuiteTransientStatus('checking');
  extensionLog('info', '正在检查 CPA 套件的 GitHub 最新发布包...');

  try {
    const report = await invoke('extension_check_cpa_updates');
    cpaUpdateReport = report || null;
    const components = Array.isArray(report?.components) ? report.components : [];
    const hasUpdateNow = components.some(component => component.updateAvailable === true);
    const unknown = components.some(component => component.updateAvailable === null || component.updateAvailable === undefined);
    const lines = components.map(formatUpdateLine);
    extensionLog(hasUpdateNow ? 'warn' : 'ok', `CPA 更新检测完成: ${lines.join('；')}`);
    updateCpaSuiteCard(extensionServicesById.get('cpa-suite'));
    if (autoUpdate && hasUpdateNow) {
      await updateCpaSuite();
      return;
    }
    if (!hasUpdateNow) {
      if (typeof showCustomAlert === 'function') {
        const body = `${lines.join('\n')}\n\n检测时间: ${report?.checkedAt || '未知'}`;
        showCustomAlert(body, 'CPA 套件更新检测', unknown ? 'info' : 'success');
      }
      return;
    }
    if (typeof showCustomConfirm === 'function') {
      const confirmed = await showCustomConfirm(
        `${lines.join('\n')}\n\n是否立即更新？`,
        'CPA 套件有新版本',
        'warn'
      );
      if (confirmed) {
        await updateCpaSuite();
        return;
      }
    }
    if (typeof showCustomAlert === 'function') {
      const body = `${lines.join('\n')}\n\n检测时间: ${report?.checkedAt || '未知'}`;
      showCustomAlert(body, 'CPA 套件更新检测', 'warn');
    }
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `CPA 更新检测失败: ${message}`);
    if (typeof showCustomAlert === 'function') showCustomAlert(message, 'CPA 更新检测失败', 'error');
  } finally {
    cpaUpdateChecking = false;
    // 恢复按钮到实际状态
    updateCpaSuiteCard(extensionServicesById.get('cpa-suite'));
  }
}

async function stopCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法停止 CPA 套件。');
    return;
  }
  setCpaSuiteTransientStatus('stopping');
  extensionLog('warn', '正在停止 CPA 套件...');
  try {
    await invoke('extension_stop_cpa_suite');
    extensionNotify('CPA 套件已停止。', 'info');
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `停止 CPA 套件失败: ${message}`);
    extensionNotify(`停止失败: ${message}`, 'error');
  } finally {
    await refreshExtensionStatuses({ silent: true });
  }
}

async function startCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法启动 CPA 套件。');
    return;
  }
  setCpaSuiteTransientStatus('starting');
  extensionLog('info', '正在启动 CPA 套件...');
  try {
    await invoke('extension_start_cpa_suite');
    extensionNotify('CPA 套件已启动', 'success');
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `启动 CPA 套件失败: ${message}`);
    extensionNotify(`启动失败: ${message}`, 'error');
  } finally {
    await refreshExtensionStatuses({ silent: true });
  }
}

async function uninstallCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法卸载 CPA 套件。');
    return;
  }
  const confirmed = await showCustomConfirm(
    '将停止服务并删除当前托管安装目录下的扩展文件（版本目录、installed.json、secrets 等）。不会删除桌面 CPA 导入源。此操作不可撤销。确定卸载？',
    '卸载 CPA 套件',
    'warn'
  );
  if (!confirmed) return;
  setCpaSuiteTransientStatus('uninstalling');
  extensionLog('warn', '正在卸载 CPA 套件...');
  try {
    await invoke('extension_uninstall_cpa_suite');
    cpaUpdateReport = null;
    await loadCpaInstallDir();
    await refreshExtensionStatuses({ silent: true });
    const still = extensionServicesById.get('cpa-suite');
    if (still?.installed || still?.status === 'installed' || still?.status === 'running' || still?.status === 'degraded') {
      extensionNotify('托管目录已清理，但仍检测到桌面等外部安装来源。', 'warn');
      extensionLog('warn', '卸载后仍检测到可扫描的 CPA 安装（例如桌面 CPA 目录），不会自动删除外部目录。');
    } else {
      extensionNotify('CPA 套件已卸载', 'info');
    }
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `卸载 CPA 套件失败: ${message}`);
    extensionNotify(`卸载失败: ${message}`, 'error');
    await refreshExtensionStatuses({ silent: true });
  }
}

async function restartCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法重启 CPA 套件。');
    return;
  }
  setCpaSuiteTransientStatus('starting', '重启中');
  extensionLog('warn', '正在重启 CPA 套件...');
  try {
    await invoke('extension_restart_cpa_suite');
    extensionNotify('CPA 套件已重启', 'success');
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `重启 CPA 套件失败: ${message}`);
    extensionNotify(`重启失败: ${message}`, 'error');
  } finally {
    await refreshExtensionStatuses({ silent: true });
  }
}

async function updateCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法更新 CPA 套件。');
    return;
  }
  if (!cpaUpdateReport?.components?.some(component => component.updateAvailable === true)) {
    await checkCpaExtensionUpdates(true);
    return;
  }
  const confirmed = await showCustomConfirm(
    '检测到新版本，将停止服务、下载并覆盖安装，服务会短暂中断。确定更新？',
    '确认更新 CPA 套件',
    'warn'
  );
  if (!confirmed) return;
  const installDir = await chooseCpaInstallDir();
  if (installDir === null) {
    extensionLog('info', '用户取消了选择安装目录。');
    return;
  }
  setCpaSuiteTransientStatus('updating');
  setCpaProgress(1, '开始更新 CPA 套件...', true);
  extensionLog('warn', '开始更新 CPA 套件...');
  try {
    await invoke('extension_update_cpa_suite', { installDir });
    setCpaProgress(100, '更新完成', true);
    extensionNotify('CPA 套件更新完成！', 'success');
    cpaUpdateReport = null;
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `CPA 套件更新失败: ${message}`);
    extensionNotify(`更新失败: ${message}`, 'error');
    renderCpaAlert({ status: 'error', notes: [message] });
  } finally {
    await refreshExtensionStatuses({ silent: true });
    setTimeout(() => hideCpaProgress(), 800);
  }
}

async function initExtensions() {
  bindExtensionCardOpeners();
  bindExtensionSettingsModal();
  bindDeployProgressListener();
  switchExtensionTab('all');
  await refreshExtensionStatuses({ silent: true });
  await loadCpaInstallDir();
}

function onExtensionsPageEnter() {
  if (extensionLogEntries.length === 0) {
    extensionLog('info', '扩展中心已就绪，正在检测本地服务状态...');
  }
  if (typeof refreshExtensionStatuses === 'function') {
    refreshExtensionStatuses({ silent: true });
  }
}

function onExtensionsPageLeave() {
  clearExtensionAutoRefresh();
}

async function loadCpaInstallDir() {
  if (!ensureExtensionBridge()) return;
  try {
    cpaInstallDir = await invoke('extension_cpa_install_dir') || null;
    renderCpaInstallDir();
  } catch (e) {
    extensionLog('err', `读取安装目录失败: ${e?.message || e}`);
  }
}

function renderCpaInstallDir() {
  const el = document.getElementById('extension-cpa-install-dir');
  if (el) {
    const label = cpaInstallDir || '默认';
    el.textContent = label;
    el.title = cpaInstallDir || '';
  }
  const settingsEl = document.getElementById('extensionInstallDirText');
  if (settingsEl) {
    settingsEl.textContent = cpaInstallDir || '默认目录';
  }
}

async function chooseCpaInstallDir() {
  if (!ensureExtensionBridge()) return null;
  const defaultDir = cpaInstallDir || (await invoke('extension_cpa_default_install_dir'));
  if (typeof defaultDir !== 'string') return cpaInstallDir;
  const chosen = await showCustomPrompt('请指定 CPA 套件安装目录（留空使用默认目录）', defaultDir, 'CPA 安装目录');
  if (chosen === null) return null;
  const dir = chosen.trim();
  cpaInstallDir = dir || defaultDir;
  renderCpaInstallDir();
  if (dir && dir !== defaultDir) {
    try {
      await invoke('extension_set_cpa_install_dir', { dir });
    } catch (e) {
      extensionLog('warn', `保存安装目录失败: ${e?.message || e}`);
    }
  }
  return cpaInstallDir;
}

async function setCpaInstallDir() {
  const chosen = await chooseCpaInstallDir();
  if (chosen) {
    extensionNotify(`安装目录已设置为 ${chosen}`, 'info');
    extensionLog('info', `CPA 安装目录: ${chosen}`);
  }
}

function toggleExtensionDetails(id, button) {
  const details = document.getElementById(`extension-details-${id}`);
  if (!details) return;
  const willHide = !details.hidden;
  details.hidden = willHide;
  if (button) {
    button.setAttribute('aria-expanded', String(!willHide));
    button.textContent = willHide ? '展开详情' : '收起详情';
  }
}

async function openExtensionURL(url, label) {
  try {
    await invoke('open_url', { url });
    extensionNotify(`已打开 ${label}`, 'info');
    extensionLog('info', `打开链接: ${label} (${url})`);
  } catch (e) {
    extensionLog('err', `打开链接失败: ${e?.message || e}`);
    extensionNotify(`打开链接失败: ${e?.message || e}`, 'error');
  }
}

function showExtensionBackendPending(title, detail) {
  const message = `${detail}\n\n下一步需要接入桌面端命令：下载发布包、解压、生成配置、启动服务、健康检查。`;
  if (typeof showCustomAlert === 'function') {
    showCustomAlert(message, title, 'info');
  } else {
    extensionNotify(detail, 'info');
  }
  extensionLog('warn', `${title}: 后端命令待接入。`);
}

function handleExtensionAction(action) {
  switch (action) {
    case 'install-cpa':
      deployCpaSuite();
      break;
    case 'import-existing':
      showExtensionBackendPending(
        '导入已有服务',
        '将扫描现有 CPA / CPAMP 目录，读取版本、端口和配置，并纳入 AnyBridge 管理。'
      );
      break;
    case 'refresh':
      refreshExtensionStatuses();
      break;
    case 'open-cpamp':
      openExtensionURL(CPAMP_MANAGEMENT_URL, 'CPA Manager Plus');
      break;
    case 'open-cpamp-plugins':
      openExtensionURL(CPAMP_PLUGINS_URL, 'CPA 插件管理');
      break;
    case 'check-cpa-update':
      checkCpaExtensionUpdates();
      break;
    case 'stop-cpa-suite':
      stopCpaSuite();
      break;
    case 'start-cpa-suite':
      startCpaSuite();
      break;
    case 'uninstall-cpa-suite':
      uninstallCpaSuite();
      break;
    case 'restart-cpa-suite':
      restartCpaSuite();
      break;
    case 'update-cpa-suite':
      updateCpaSuite();
      break;
    case 'switch-cpa-version':
      openCpaVersionSwitchModal();
      break;
    case 'set-cpa-install-dir':
      setCpaInstallDir();
      break;
    case 'install-sub2api':
      showExtensionBackendPending(
        'sub2api 安装',
        '将按扩展清单下载并托管 sub2api，安装后可生成 AnyBridge 供应商配置。'
      );
      break;
    case 'install-grok2api':
      showExtensionBackendPending(
        'grok2api 安装',
        '将按扩展清单下载并托管 grok2api，安装后可生成 Grok 供应商配置。'
      );
      break;
    case 'install-jimeng':
      showExtensionBackendPending(
        'free 即梦安装',
        '需要先确认具体 GitHub 仓库、API 格式和运行方式，再决定本地托管或外部服务接入。'
      );
      break;
    case 'view-adapter-plan':
      extensionNotify('适配计划已写入 spec/35-扩展中心与一键部署规划.md。', 'info');
      extensionLog('info', '查看适配计划: spec/35-扩展中心与一键部署规划.md。');
      break;
    default:
      extensionNotify('扩展操作待接入。', 'info');
      extensionLog('warn', `未知扩展操作: ${action || '(empty)'}`);
  }
}

function bindDeployProgressListener() {
  if (!window.__deployProgressBound && typeof tauriEvent !== 'undefined' && tauriEvent?.listen) {
    window.__deployProgressBound = true;
    tauriEvent.listen('deploy-progress', (e) => {
      const p = e.payload || {};
      const level = p.isError ? 'err' : 'info';
      const percent = Number(p.percent);
      const message = p.message || '';
      if (Number.isFinite(percent)) {
        extensionDeployInProgress = true;
        setCpaProgress(percent, message, true);
      }
      if (p.step === 'download') {
        extensionLog(level, `${message} (${Number.isFinite(percent) ? `${percent}%` : '…'})`);
      } else if (message) {
        extensionLog(level, message);
      }
      if (p.step === 'done' || percent >= 100) {
        setCpaProgress(100, message || '完成', true);
      }
    });
  }
}

globalThis.CPA_DEPLOY_STEP_MAP = {
  check: 'check', fetch: 'fetch',
  download_cpa: 'download', download_cpamp: 'download', download: 'download',
  extract_cpa: 'extract', extract_cpamp: 'extract',
  config: 'config',
  start_cpa: 'start', start_cpamp: 'start',
  health_cpa: 'health', health_cpamp: 'health',
  done: 'done',
};
globalThis.CPA_DEPLOY_STEP_ORDER = ['check', 'fetch', 'download', 'extract', 'config', 'start', 'health'];

async function deployCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法执行部署。');
    return;
  }
  await showCpaDeployModal();
}

function showCpaDeployModal() {
  return new Promise(async (resolve) => {
    const modal = document.getElementById('cpa-deploy-modal');
    if (!modal) { resolve(null); return; }

    const confirmView = document.getElementById('cpa-deploy-confirm-view');
    const progressView = document.getElementById('cpa-deploy-progress-view');
    const resultView = document.getElementById('cpa-deploy-result-view');
    const titleEl = document.getElementById('cpa-deploy-modal-title');
    const iconEl = document.getElementById('cpa-deploy-modal-icon');
    const footer = document.getElementById('cpa-deploy-footer');
    const okBtn = document.getElementById('cpa-deploy-confirm-btn');
    const cancelBtn = document.getElementById('cpa-deploy-cancel-btn');
    const inputEl = document.getElementById('cpa-deploy-dir-input');
    const hintEl = document.getElementById('cpa-deploy-dir-hint');

    let defaultDir = cpaInstallDir || '';
    try {
      defaultDir = cpaInstallDir || (await invoke('extension_cpa_default_install_dir'));
    } catch (_) {}
    if (inputEl) {
      inputEl.value = cpaInstallDir || '';
      inputEl.placeholder = defaultDir ? `默认：${defaultDir}` : '留空使用默认目录';
    }
    if (hintEl) hintEl.textContent = defaultDir ? `默认目录：${defaultDir}` : '';

    function switchView(view) {
      confirmView.style.display = view === 'confirm' ? '' : 'none';
      progressView.style.display = view === 'progress' ? '' : 'none';
      resultView.style.display = view === 'result' ? '' : 'none';
    }

    function setFooter(cancelText, confirmText, confirmVisible, confirmHandler) {
      cancelBtn.textContent = cancelText || '取消';
      okBtn.textContent = confirmText || '确定';
      okBtn.style.display = confirmVisible === false ? 'none' : '';
      okBtn.onclick = confirmHandler || null;
      cancelBtn.onclick = null;
    }

    function resetSteps() {
      document.querySelectorAll('.cpa-deploy-step').forEach(s => {
        s.classList.remove('active', 'done', 'error');
      });
      const fill = document.getElementById('cpa-deploy-progress-fill');
      const pct = document.getElementById('cpa-deploy-progress-percent');
      const msg = document.getElementById('cpa-deploy-progress-message');
      const logBox = document.getElementById('cpa-deploy-log-box');
      if (fill) fill.style.width = '0%';
      if (pct) pct.textContent = '0%';
      if (msg) msg.textContent = '准备中...';
      if (logBox) logBox.innerHTML = '';
    }

    function updateStep(stepKey, state) {
      const mapped = CPA_DEPLOY_STEP_MAP[stepKey];
      if (!mapped || mapped === 'done') return;
      const el = document.querySelector(`.cpa-deploy-step[data-step="${mapped}"]`);
      if (!el) return;
      el.classList.remove('active', 'done', 'error');
      el.classList.add(state);
    }

    function markPriorDone(stepKey) {
      const mapped = CPA_DEPLOY_STEP_MAP[stepKey];
      if (!mapped) return;
      const idx = CPA_DEPLOY_STEP_ORDER.indexOf(mapped);
      if (idx < 0) return;
      for (let i = 0; i < idx; i++) {
        const prevEl = document.querySelector(`.cpa-deploy-step[data-step="${CPA_DEPLOY_STEP_ORDER[i]}"]`);
        if (prevEl && !prevEl.classList.contains('error')) {
          prevEl.classList.remove('active');
          prevEl.classList.add('done');
        }
      }
    }

    function appendDeployLog(message, level) {
      const logBox = document.getElementById('cpa-deploy-log-box');
      if (!logBox) return;
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      const line = document.createElement('div');
      line.className = 'cpa-deploy-log-line';
      line.innerHTML = `<span class="cpa-deploy-log-ts">${ts}</span><span class="cpa-deploy-log-msg ${level || ''}">${message}</span>`;
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function updateProgress(percent, message) {
      const fill = document.getElementById('cpa-deploy-progress-fill');
      const pct = document.getElementById('cpa-deploy-progress-percent');
      const msg = document.getElementById('cpa-deploy-progress-message');
      if (fill) fill.style.width = `${percent}%`;
      if (pct) pct.textContent = `${Math.round(percent)}%`;
      if (msg && message) msg.textContent = message;
    }

    function showResult(success, title, desc, errorDetail) {
      switchView('result');
      if (titleEl) titleEl.textContent = success ? '部署完成' : '部署失败';
      if (iconEl) iconEl.style.color = success ? 'var(--success)' : 'var(--danger)';

      const content = document.getElementById('cpa-deploy-result-content');
      if (content) {
        const checkSvg = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        const xSvg = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        content.innerHTML = `
          <div class="cpa-deploy-result-icon ${success ? 'success' : 'error'}">${success ? checkSvg : xSvg}</div>
          <div class="cpa-deploy-result-title">${title}</div>
          <div class="cpa-deploy-result-desc">${desc}</div>
          ${errorDetail ? `<div class="cpa-deploy-result-error-box">${errorDetail}</div>` : ''}
        `;
      }

      setFooter('关闭', '', false);
      cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(); };
    }

    let progressUnlisten = null;

    function cleanup() {
      modal.classList.remove('active');
      if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
      document.removeEventListener('keydown', onEsc);
    }

    const onEsc = (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        if (progressView.style.display !== 'none') return;
        cleanup(); resolve();
      }
    };

    switchView('confirm');
    setFooter('取消', '开始部署', true, null);
    modal.classList.add('active');
    setTimeout(() => { if (inputEl) inputEl.focus(); }, 50);

    cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(); };
    modal.addEventListener('click', (e) => { if (e.target === modal && progressView.style.display === 'none') { cleanup(); resolve(); } });
    document.addEventListener('keydown', onEsc);

    okBtn.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();

      const dir = (inputEl?.value || '').trim();
      const finalDir = dir || defaultDir || '';
      if (dir && dir !== defaultDir) {
        cpaInstallDir = finalDir;
        renderCpaInstallDir();
        invoke('extension_set_cpa_install_dir', { dir }).catch(err => {
          extensionLog('warn', `保存安装目录失败: ${err?.message || err}`);
        });
      } else if (!dir) {
        cpaInstallDir = finalDir;
        renderCpaInstallDir();
      }

      switchView('progress');
      if (titleEl) titleEl.textContent = '正在部署...';
      if (iconEl) iconEl.style.color = 'var(--accent)';
      setFooter('后台运行', '', false);
      cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(); };
      resetSteps();
      appendDeployLog('开始部署 CPA 套件...', 'ok');

      setCpaSuiteTransientStatus('installing');
      setCpaProgress(1, '开始部署 CPA 套件...', true);

      if (typeof tauriEvent !== 'undefined' && tauriEvent?.listen) {
        tauriEvent.listen('deploy-progress', (ev) => {
          const p = ev.payload || {};
          const percent = Number(p.percent);
          const message = p.message || '';
          const step = p.step || '';

          if (Number.isFinite(percent)) {
            updateProgress(percent, message);
            setCpaProgress(percent, message, true);
          }

          if (step && step !== 'done') {
            markPriorDone(step);
            updateStep(step, 'active');
          }

          if (step === 'done' || percent >= 100) {
            CPA_DEPLOY_STEP_ORDER.forEach(s => {
              const el = document.querySelector(`.cpa-deploy-step[data-step="${s}"]`);
              if (el && !el.classList.contains('error')) {
                el.classList.remove('active');
                el.classList.add('done');
              }
            });
          }

          const level = p.isError ? 'err' : (step && step.startsWith('download') ? '' : '');
          appendDeployLog(message, level);
        }).then(unlisten => { progressUnlisten = unlisten; });
      }

      try {
        const result = await invoke('extension_deploy_cpa_suite', { installDir: finalDir });
        setCpaProgress(100, '部署完成', true);
        extensionServicesById.set(result.id, result);
        updateExtensionsMetric([result]);
        updateCpaSuiteCard(result);
        extensionLog('ok', `部署完成：CPA 套件 ${extensionStatusLabel(result.status)}`);
        extensionNotify('CPA 套件部署完成！', 'success');
        appendDeployLog('部署完成！', 'ok');

        showResult(true, '部署完成', [
          'CPA 套件已成功部署并启动运行。',
          '<strong>CLIProxyAPI</strong>：端口 8317',
          '<strong>CPA Manager Plus</strong>：端口 18317',
          '点击卡片上的「打开面板」即可进入管理界面。'
        ].join('<br>'));
      } catch (err) {
        const msg = String(err?.message || err);
        setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'error', '部署失败');
        extensionLog('err', `部署失败: ${msg}`);
        extensionNotify(`部署失败: ${msg}`, 'error');
        renderCpaAlert({ status: 'error', notes: [msg] });
        appendDeployLog(`部署失败: ${msg}`, 'err');

        document.querySelectorAll('.cpa-deploy-step.active').forEach(s => {
          s.classList.remove('active');
          s.classList.add('error');
        });

        showResult(false, '部署失败', '部署过程中出现错误，请查看下方错误详情。', msg);
        await refreshExtensionStatuses({ silent: true });
      } finally {
        setTimeout(() => hideCpaProgress(), 800);
      }
    };
  });
}

// âââââââ CPA çæ¬åæ¢ âââââââ

globalThis.cpaVersionCatalog = null;
globalThis.cpaVersionSelected = { cli: null, cpamp: null };
globalThis.cpaVersionBusy = false;

function findCpaComponentVersions(catalog, id) {
  return ((catalog && catalog.components) || []).find(function (c) { return c.id === id; }) || null;
}

function formatCpaVersionDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  } catch (_) {
    return '';
  }
}

function renderCpaVersionList(host, component, selectedVersion, onSelect) {
  if (!host) return;
  host.innerHTML = '';
  var versions = Array.isArray(component && component.versions) ? component.versions : [];
  if (!versions.length) {
    var empty = document.createElement('div');
    empty.className = 'cpa-version-empty';
    empty.textContent = '暂无可用版本（请检查网络或稍后重试）';
    host.appendChild(empty);
    return;
  }
  versions.forEach(function (entry) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'cpa-version-row';
    if (entry.version === selectedVersion) row.classList.add('is-selected');
    if (entry.active) row.classList.add('is-active');
    if (!entry.installed) row.classList.add('is-remote');
    var main = document.createElement('div');
    main.className = 'cpa-version-row-main';
    var ver = document.createElement('strong');
    ver.textContent = entry.version;
    main.appendChild(ver);
    var badges = document.createElement('div');
    badges.className = 'cpa-version-badges';
    if (entry.active) {
      var b1 = document.createElement('span');
      b1.className = 'cpa-version-badge cpa-version-badge-active';
      b1.textContent = '当前';
      badges.appendChild(b1);
    }
    if (entry.installed) {
      var b2 = document.createElement('span');
      b2.className = 'cpa-version-badge cpa-version-badge-installed';
      b2.textContent = '已安装';
      badges.appendChild(b2);
    } else {
      var b3 = document.createElement('span');
      b3.className = 'cpa-version-badge cpa-version-badge-remote';
      b3.textContent = '需下载';
      badges.appendChild(b3);
    }
    if (entry.prerelease) {
      var b4 = document.createElement('span');
      b4.className = 'cpa-version-badge cpa-version-badge-pre';
      b4.textContent = '预发布';
      badges.appendChild(b4);
    }
    main.appendChild(badges);
    var meta = document.createElement('div');
    meta.className = 'cpa-version-row-meta';
    var date = formatCpaVersionDate(entry.publishedAt);
    meta.textContent = date || (entry.installed ? '本地缓存' : 'GitHub');
    row.append(main, meta);
    row.onclick = function () { onSelect(entry.version); };
    host.appendChild(row);
  });
}

function updateCpaVersionConfirmLabel() {
  var btn = document.getElementById('cpa-version-confirm-btn');
  if (!btn || !cpaVersionCatalog) return;
  var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
  var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
  var cliEntry = ((cli && cli.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cli; });
  var cpampEntry = ((cpamp && cpamp.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cpamp; });
  var needDownload = (cliEntry && !cliEntry.installed) || (cpampEntry && !cpampEntry.installed);
  var same = cliEntry && cliEntry.active && cpampEntry && cpampEntry.active;
  btn.disabled = Boolean(cpaVersionBusy) || !cpaVersionSelected.cli || !cpaVersionSelected.cpamp || same;
  if (same) btn.textContent = '已是当前版本';
  else if (needDownload) btn.textContent = '下载并切换';
  else btn.textContent = '切换到已选版本';
}

function refreshCpaVersionLists() {
  var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
  var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
  renderCpaVersionList(document.getElementById('cpa-version-cli-list'), cli, cpaVersionSelected.cli, function (ver) {
    cpaVersionSelected.cli = ver;
    refreshCpaVersionLists();
  });
  renderCpaVersionList(document.getElementById('cpa-version-cpamp-list'), cpamp, cpaVersionSelected.cpamp, function (ver) {
    cpaVersionSelected.cpamp = ver;
    refreshCpaVersionLists();
  });
  var cliCur = document.getElementById('cpa-version-cli-current');
  var cpampCur = document.getElementById('cpa-version-cpamp-current');
  if (cliCur) cliCur.textContent = (cli && cli.currentVersion) || '未知';
  if (cpampCur) cpampCur.textContent = (cpamp && cpamp.currentVersion) || '未知';
  updateCpaVersionConfirmLabel();
}

function setCpaVersionProgress(visible, percent, message) {
  var wrap = document.getElementById('cpa-version-progress');
  var fill = document.getElementById('cpa-version-progress-fill');
  var pct = document.getElementById('cpa-version-progress-percent');
  var msg = document.getElementById('cpa-version-progress-message');
  if (wrap) wrap.hidden = !visible;
  if (fill && Number.isFinite(percent)) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  if (pct && Number.isFinite(percent)) pct.textContent = Math.round(percent) + '%';
  if (msg && message) msg.textContent = message;
}

async function openCpaVersionSwitchModal() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法切换版本。');
    extensionNotify('桌面通信通道未就绪', 'error');
    return;
  }
  var modal = document.getElementById('cpa-version-modal');
  if (!modal) {
    extensionNotify('版本切换界面未就绪', 'error');
    return;
  }
  var confirmBtn = document.getElementById('cpa-version-confirm-btn');
  var cancelBtn = document.getElementById('cpa-version-cancel-btn');
  var loadingEl = document.getElementById('cpa-version-loading');
  var bodyEl = document.getElementById('cpa-version-body');
  cpaVersionBusy = false;
  setCpaVersionProgress(false, 0, '');
  if (loadingEl) { loadingEl.hidden = false; loadingEl.textContent = '正在加载本地与 GitHub 版本列表...'; }
  if (bodyEl) bodyEl.hidden = true;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '加载中...'; }
  modal.classList.add('active');
  var onEsc = function (e) { if (e.key === 'Escape' && !cpaVersionBusy) closeCpaVersionSwitchModal(); };
  document.addEventListener('keydown', onEsc);
  modal._cpaVersionEsc = onEsc;
  if (cancelBtn) {
    cancelBtn.onclick = function (e) { e.preventDefault(); if (cpaVersionBusy) return; closeCpaVersionSwitchModal(); };
  }
  if (modal.dataset.overlayBound !== '1') {
    modal.dataset.overlayBound = '1';
    modal.addEventListener('click', function (e) { if (e.target === modal && !cpaVersionBusy) closeCpaVersionSwitchModal(); });
  }
  try {
    extensionLog('info', '正在加载 CPA 本地与远程版本列表...');
    var catalog = await invoke('extension_list_cpa_versions');
    cpaVersionCatalog = catalog || null;
    var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
    var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
    cpaVersionSelected = {
      cli: (cli && cli.currentVersion) || (cli && cli.versions && cli.versions[0] && cli.versions[0].version) || null,
      cpamp: (cpamp && cpamp.currentVersion) || (cpamp && cpamp.versions && cpamp.versions[0] && cpamp.versions[0].version) || null
    };
    if (loadingEl) loadingEl.hidden = true;
    if (bodyEl) bodyEl.hidden = false;
    refreshCpaVersionLists();
    extensionLog('ok', '版本列表已加载：CPA ' + ((cli && cli.versions && cli.versions.length) || 0) + ' 个 / CPAMP ' + ((cpamp && cpamp.versions && cpamp.versions.length) || 0) + ' 个');
  } catch (e) {
    var message = String((e && e.message) || e);
    extensionLog('err', '加载版本列表失败: ' + message);
    if (loadingEl) { loadingEl.hidden = false; loadingEl.textContent = '加载失败：' + message; }
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '加载失败'; }
    return;
  }
  if (confirmBtn) {
    confirmBtn.onclick = async function (e) {
      e.preventDefault();
      if (cpaVersionBusy) return;
      await applyCpaVersionSelection();
    };
  }
}

function closeCpaVersionSwitchModal() {
  var modal = document.getElementById('cpa-version-modal');
  if (modal) modal.classList.remove('active');
  if (modal && modal._cpaVersionEsc) {
    document.removeEventListener('keydown', modal._cpaVersionEsc);
    modal._cpaVersionEsc = null;
  }
  setCpaVersionProgress(false, 0, '');
  cpaVersionBusy = false;
}

async function applyCpaVersionSelection() {
  if (!cpaVersionCatalog || !cpaVersionSelected.cli || !cpaVersionSelected.cpamp) return;
  var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
  var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
  var cliEntry = ((cli && cli.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cli; });
  var cpampEntry = ((cpamp && cpamp.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cpamp; });
  if (!cliEntry || !cpampEntry) { extensionNotify('请选择有效的 CPA / CPAMP 版本', 'warn'); return; }
  if (cliEntry.active && cpampEntry.active) { extensionNotify('已是当前版本，无需切换', 'info'); return; }
  var needDownload = !cliEntry.installed || !cpampEntry.installed;
  var suite = extensionServicesById.get('cpa-suite');
  var isRunning = suite && (suite.status === 'running' || suite.status === 'degraded');
  var lines = [
    'CLIProxyAPI：' + ((cli && cli.currentVersion) || '未知') + ' → ' + cliEntry.version + (cliEntry.installed ? '' : '（需下载）'),
    'CPA Manager Plus：' + ((cpamp && cpamp.currentVersion) || '未知') + ' → ' + cpampEntry.version + (cpampEntry.installed ? '' : '（需下载）'),
    isRunning ? '切换时会短暂停止并重启服务。' : '切换后将按需启动服务。',
    needDownload ? '未安装的版本会从 GitHub 下载（可能需要几分钟）。' : '两个版本均已在本地，将直接切换。'
  ];
  var confirmed = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(lines.join('\n'), needDownload ? '下载并切换版本' : '确认切换版本', 'warn')
    : true;
  if (!confirmed) return;
  cpaVersionBusy = true;
  updateCpaVersionConfirmLabel();
  var confirmBtn = document.getElementById('cpa-version-confirm-btn');
  var cancelBtn = document.getElementById('cpa-version-cancel-btn');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = needDownload ? '下载中...' : '切换中...'; }
  if (cancelBtn) cancelBtn.disabled = true;
  setCpaSuiteTransientStatus('updating');
  setCpaVersionProgress(true, 2, needDownload ? '准备下载指定版本...' : '正在切换版本...');
  extensionLog('warn', '开始' + (needDownload ? '下载并' : '') + '切换版本：CPA ' + cliEntry.version + ' / CPAMP ' + cpampEntry.version);
  var progressUnlisten = null;
  try {
    if (needDownload && typeof tauriEvent !== 'undefined' && tauriEvent && tauriEvent.listen) {
      progressUnlisten = await tauriEvent.listen('deploy-progress', function (ev) {
        var p = ev.payload || {};
        var percent = Number(p.percent);
        var msg = p.message || '';
        if (Number.isFinite(percent)) { setCpaVersionProgress(true, percent, msg); setCpaProgress(percent, msg, true); }
        else if (msg) { setCpaVersionProgress(true, undefined, msg); }
        if (msg) extensionLog(p.isError ? 'err' : 'info', msg);
      });
    }
    if (needDownload) {
      await invoke('extension_install_cpa_version', { cliVersion: cliEntry.version, cpampVersion: cpampEntry.version, restart: true });
    } else {
      await invoke('extension_switch_cpa_version', { cliVersion: cliEntry.version, cpampVersion: cpampEntry.version, restart: true });
    }
    setCpaVersionProgress(true, 100, '完成');
    extensionNotify('已切换到 CPA ' + cliEntry.version + ' / CPAMP ' + cpampEntry.version, 'success');
    extensionLog('ok', '版本切换完成：CPA ' + cliEntry.version + ' / CPAMP ' + cpampEntry.version);
    cpaUpdateReport = null;
    await refreshExtensionStatuses({ silent: true });
    closeCpaVersionSwitchModal();
  } catch (e) {
    var errMsg = String((e && e.message) || e);
    extensionLog('err', '版本切换失败: ' + errMsg);
    extensionNotify('版本切换失败: ' + errMsg, 'error');
    setCpaVersionProgress(true, undefined, '失败：' + errMsg);
    await refreshExtensionStatuses({ silent: true });
  } finally {
    if (typeof progressUnlisten === 'function') progressUnlisten();
    cpaVersionBusy = false;
    if (cancelBtn) cancelBtn.disabled = false;
    updateCpaVersionConfirmLabel();
    setTimeout(function () { hideCpaProgress(); }, 800);
  }
}

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g.extensionNotify = extensionNotify;
  g.openExtensionSettings = openExtensionSettings;
  g.closeExtensionSettings = closeExtensionSettings;
  g.closeExtensionSettingsOnEsc = closeExtensionSettingsOnEsc;
  g.toggleExtensionSettings = toggleExtensionSettings;
  g.bindExtensionSettingsModal = bindExtensionSettingsModal;
  g.extensionNowTs = extensionNowTs;
  g.extensionEscapeHtml = extensionEscapeHtml;
  g.renderExtensionLogLine = renderExtensionLogLine;
  g.renderExtensionLogs = renderExtensionLogs;
  g.extensionLog = extensionLog;
  g.setExtensionLogFilter = setExtensionLogFilter;
  g.extensionStatusLabel = extensionStatusLabel;
  g.setExtensionStatusBadge = setExtensionStatusBadge;
  g.isExtensionsPageActive = isExtensionsPageActive;
  g.clearExtensionAutoRefresh = clearExtensionAutoRefresh;
  g.scheduleExtensionAutoRefresh = scheduleExtensionAutoRefresh;
  g.setCpaProgress = setCpaProgress;
  g.hideCpaProgress = hideCpaProgress;
  g.setCpaSuiteTransientStatus = setCpaSuiteTransientStatus;
  g.collectCpaAlertMessages = collectCpaAlertMessages;
  g.renderCpaAlert = renderCpaAlert;
  g.renderCpaCredentials = renderCpaCredentials;
  g.getCpaActionConfig = getCpaActionConfig;
  g.bindCpaActionButton = bindCpaActionButton;
  g.renderCpaActions = renderCpaActions;
  g.setComponentDot = setComponentDot;
  g.currentExtensionTab = currentExtensionTab;
  g.currentExtensionFilter = currentExtensionFilter;
  g.ensureExtensionBridge = ensureExtensionBridge;
  g.clearExtensionLogs = clearExtensionLogs;
  g.clearExtensionNode = clearExtensionNode;
  g.appendExtensionMetric = appendExtensionMetric;
  g.switchExtensionTab = switchExtensionTab;
  g.switchExtensionFilter = switchExtensionFilter;
  g.syncExtensionCardTags = syncExtensionCardTags;
  g.describeExtensionComponent = describeExtensionComponent;
  g.updateExtensionComponent = updateExtensionComponent;
  g.updateCpaSuiteCard = updateCpaSuiteCard;
  g.updateExtensionsMetric = updateExtensionsMetric;
  g.extensionPortsText = extensionPortsText;
  g.renderExtensionGithubLinks = renderExtensionGithubLinks;
  g.renderExtensionComponents = renderExtensionComponents;
  g.renderExtensionNotes = renderExtensionNotes;
  g.highlightExtensionDetailAlerts = highlightExtensionDetailAlerts;
  g.openExtensionDetail = openExtensionDetail;
  g.closeExtensionDetail = closeExtensionDetail;
  g.closeExtensionDetailOnEsc = closeExtensionDetailOnEsc;
  g.bindExtensionCardOpeners = bindExtensionCardOpeners;
  g.refreshExtensionStatuses = refreshExtensionStatuses;
  g.formatUpdateLine = formatUpdateLine;
  g.checkCpaExtensionUpdates = checkCpaExtensionUpdates;
  g.stopCpaSuite = stopCpaSuite;
  g.startCpaSuite = startCpaSuite;
  g.uninstallCpaSuite = uninstallCpaSuite;
  g.restartCpaSuite = restartCpaSuite;
  g.updateCpaSuite = updateCpaSuite;
  g.initExtensions = initExtensions;
  g.onExtensionsPageEnter = onExtensionsPageEnter;
  g.onExtensionsPageLeave = onExtensionsPageLeave;
  g.loadCpaInstallDir = loadCpaInstallDir;
  g.renderCpaInstallDir = renderCpaInstallDir;
  g.chooseCpaInstallDir = chooseCpaInstallDir;
  g.setCpaInstallDir = setCpaInstallDir;
  g.toggleExtensionDetails = toggleExtensionDetails;
  g.openExtensionURL = openExtensionURL;
  g.showExtensionBackendPending = showExtensionBackendPending;
  g.handleExtensionAction = handleExtensionAction;
  g.bindDeployProgressListener = bindDeployProgressListener;
  g.deployCpaSuite = deployCpaSuite;
  g.showCpaDeployModal = showCpaDeployModal;
  g.findCpaComponentVersions = findCpaComponentVersions;
  g.formatCpaVersionDate = formatCpaVersionDate;
  g.renderCpaVersionList = renderCpaVersionList;
  g.updateCpaVersionConfirmLabel = updateCpaVersionConfirmLabel;
  g.refreshCpaVersionLists = refreshCpaVersionLists;
  g.setCpaVersionProgress = setCpaVersionProgress;
  g.openCpaVersionSwitchModal = openCpaVersionSwitchModal;
  g.closeCpaVersionSwitchModal = closeCpaVersionSwitchModal;
  g.applyCpaVersionSelection = applyCpaVersionSelection;
})(globalThis);
