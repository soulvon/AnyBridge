// extensions/state-logs.js — 扩展中心共享状态、日志持久化与 CPA 凭据卡片渲染

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
globalThis.cpaAutoStart = true;
globalThis.cpaProxySettings = {
  mode: 'system',
  customUrl: '',
  systemUrl: null,
  effectiveUrl: '',
  appliedUrl: null,
  needsRestart: false,
  suiteRunning: false
};
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
    name: 'Jimeng2API',
    kicker: '即梦 API 网关',
    description: '即梦多账号 API 网关，兼容 OpenAI 图像与视频接口，支持账号池轮询。',
    type: 'API 网关',
    level: 'L2-L3',
    primaryAction: 'install-jimeng',
    primaryLabel: '安装',
    secondaryAction: 'open-jimeng-homepage',
    secondaryLabel: '项目主页',
    github: [
      { label: 'GitHub：zhizinan1997/jimeng-free-api-all', url: 'https://github.com/zhizinan1997/jimeng-free-api-all' }
    ],
    components: [
      { name: 'Jimeng2API 服务', detail: '基于 Node.js 22+ 或 Docker 运行，默认监听 5566 端口。', port: 5566 }
    ],
    notes: [
      '支持即梦 4.x/5.x 图像与视频模型生成，提供 OpenAI 兼容的 /v1/chat/completions 与 /v1/images/generations 接口。',
      '首次运行将生成 AES-256 加密密钥用于保护账号池中的即梦 Cookie。'
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
globalThis.EXTENSION_MAX_LOGS = 500;
export const EXTENSION_LOGS_STORAGE_KEY = 'anybridge_extension_logs_v1';

function loadExtensionLogsFromStorage() {
  try {
    const raw = sessionStorage.getItem(EXTENSION_LOGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(-EXTENSION_MAX_LOGS);
      }
    }
  } catch (_) {}
  return [];
}

function saveExtensionLogsToStorage() {
  try {
    sessionStorage.setItem(EXTENSION_LOGS_STORAGE_KEY, JSON.stringify(globalThis.extensionLogEntries.slice(-150)));
  } catch (_) {}
}

globalThis.extensionLogEntries = loadExtensionLogsFromStorage();
globalThis.extensionLogFilter = 'all';

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
  saveExtensionLogsToStorage();
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
  if (text) {
    if (cpaProgressState.message) {
      text.textContent = cpaProgressState.message;
    } else if (typeof loadingHtml === 'function') {
      text.innerHTML = loadingHtml('处理中…');
    }
  }
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

  // 凭证区默认折叠（卡片保持精简），用户展开偏好按卡片记忆
  const foldKey = 'anybridge.pluginCard.cpa-suite.expanded';
  const foldBtn = document.getElementById('cpa-card-fold-btn');
  const applyCpaFold = (open) => {
    container.hidden = !open;
    if (foldBtn) {
      foldBtn.classList.toggle('is-open', open);
      foldBtn.title = open ? '收起详情' : '展开详情';
      foldBtn.setAttribute('aria-label', foldBtn.title);
    }
    try { localStorage.setItem(foldKey, open ? '1' : '0'); } catch (_) {}
  };
  let cpaFoldOpen = false;
  try { cpaFoldOpen = localStorage.getItem(foldKey) === '1'; } catch (_) {}
  applyCpaFold(cpaFoldOpen);
  if (foldBtn) foldBtn.onclick = () => applyCpaFold(container.hidden);

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

// ---- P3 globalThis mirror ----
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
})(globalThis);
