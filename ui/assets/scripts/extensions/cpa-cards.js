// extensions/cpa-cards.js — CPA 操作按钮、卡片矩阵与全局指标汇总
import { EXTENSION_LOGS_STORAGE_KEY } from './state-logs.js';

function getCpaActionConfig(status, hasUpdate) {
  switch (status) {
    case 'not-installed':
      return {
        primary: { label: '一键部署', action: 'install-cpa' },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
    case 'installed':
      return {
        primary: { label: '启动', action: 'start-cpa-suite' },
        secondary: [
          { label: '切换版本', action: 'switch-cpa-version', cls: 'secondary' },
          { label: '卸载', action: 'uninstall-cpa-suite', danger: true, cls: 'danger' },
          { label: '检测更新', action: 'check-cpa-update', cls: 'accent' },
          { label: '设置', action: 'settings', cls: 'secondary' }
        ]
      };
    case 'running':
      if (hasUpdate) {
        return {
          primary: { label: '更新', action: 'update-cpa-suite' },
          secondary: [
            { label: '打开面板', action: 'open-cpamp', cls: 'accent' },
            { label: '重启', action: 'restart-cpa-suite', cls: 'accent' },
            { label: '停止', action: 'stop-cpa-suite', cls: 'warn' },
            { label: '切换版本', action: 'switch-cpa-version', cls: 'secondary' },
            { label: '设置', action: 'settings', cls: 'secondary' }
          ]
        };
      }
      return {
        primary: { label: '打开面板', action: 'open-cpamp' },
        secondary: [
          { label: '重启', action: 'restart-cpa-suite', cls: 'accent' },
          { label: '停止', action: 'stop-cpa-suite', cls: 'warn' },
          { label: '切换版本', action: 'switch-cpa-version', cls: 'secondary' },
          { label: '检测更新', action: 'check-cpa-update', cls: 'accent' },
          { label: '设置', action: 'settings', cls: 'secondary' }
        ]
      };
    case 'degraded':
      return {
        primary: { label: '重启', action: 'restart-cpa-suite' },
        secondary: [
          { label: '切换版本', action: 'switch-cpa-version', cls: 'secondary' },
          { label: '停止', action: 'stop-cpa-suite', cls: 'warn' },
          { label: '卸载', action: 'uninstall-cpa-suite', danger: true, cls: 'danger' },
          { label: '设置', action: 'settings', cls: 'secondary' }
        ]
      };
    case 'error':
      return {
        primary: { label: '刷新状态', action: 'refresh' },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
    case 'installing':
      return {
        primary: { label: '部署中...', action: null, disabled: true },
        secondary: []
      };
    case 'starting':
      return {
        primary: { label: '启动中...', action: null, disabled: true },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
    case 'stopping':
      return {
        primary: { label: '停止中...', action: null, disabled: true },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
    case 'updating':
      return {
        primary: { label: '更新中...', action: null, disabled: true },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
    case 'uninstalling':
      return {
        primary: { label: '卸载中...', action: null, disabled: true },
        secondary: []
      };
    case 'checking':
      return {
        primary: { label: '检测中...', action: null, disabled: true },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
    default:
      return {
        primary: { label: '一键部署', action: 'install-cpa' },
        secondary: [{ label: '设置', action: 'settings', cls: 'secondary' }]
      };
  }
}

function bindCpaActionButton(el, action) {
  if (!el) return;
  el.onclick = event => {
    event?.stopPropagation?.();
    if (!action || el.disabled) return;
    if (action === 'settings' || action === 'detail') openExtensionDetail('cpa-suite');
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

  // 加载态（如「检测中…」）必须带 spinner：静态文字看起来和卡住没区别。
  // spinner 由 loadingHtml 自带，这里绝不能再追加第二个圈（双加载圈事故）。
  if (primary.disabled) {
    primary.innerHTML = loadingHtml(config.primary.label);
  } else {
    primary.textContent = config.primary.label;
  }

  const frag = document.createDocumentFragment();
  (config.secondary || []).forEach(btn => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn-ghost' + (btn.cls ? ' ' + btn.cls : '');
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
  return document.querySelector('.extension-tab.active[data-extension-tab]')?.dataset.extensionTab || 'installed';
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
  try {
    sessionStorage.removeItem(EXTENSION_LOGS_STORAGE_KEY);
  } catch (_) {}
  renderExtensionLogs();
  extensionLog('info', '扩展与插件日志已清空。');
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
  const validTabs = new Set(['installed', 'plugins', 'logs']);
  let target = tab;
  if (!validTabs.has(target)) {
    if (target === 'logs') target = 'logs';
    else if (target === 'plugins') target = 'plugins';
    else target = 'installed';
  }

  document.querySelectorAll('.extension-tab[data-extension-tab]').forEach(btn => {
    const isActive = btn.dataset.extensionTab === target;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  });

  document.querySelectorAll('.extension-console-section[data-extension-section]').forEach(section => {
    const isActive = section.dataset.extensionSection === target;
    section.classList.toggle('active', isActive);
  });

  if ((target === 'plugins' || target === 'installed') && typeof refreshPluginList === 'function') {
    refreshPluginList();
  }

  if (target === 'logs') {
    requestAnimationFrame(() => {
      const body = document.getElementById('extensionLogBody');
      if (body) body.scrollTop = body.scrollHeight;
    });
  }
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

  const pluginCpaStatus = document.getElementById('plugin-cpa-status');
  const pluginCpaActions = document.getElementById('plugin-cpa-actions');
  const pluginCpaPorts = document.getElementById('plugin-cpa-ports');
  const pluginCpaComponents = document.getElementById('plugin-cpa-components');

  if (pluginCpaPorts && ports) {
    pluginCpaPorts.textContent = ports;
  }
  if (pluginCpaComponents && components.length) {
    const running = components.filter(c => c.status === 'running').length;
    pluginCpaComponents.textContent = `${running}/${components.length} 运行`;
  }
  if (pluginCpaStatus) {
    pluginCpaStatus.className = `plugin-status status-${status}`;
    pluginCpaStatus.textContent = status === 'running' ? '运行中' : status === 'installed' ? '已安装' : status === 'not-installed' ? '未安装' : '检测中';
  }
  if (pluginCpaActions) {
    if (status === 'not-installed') {
      pluginCpaActions.innerHTML = `
        <button type="button" class="btn-ghost secondary" data-action="openExtensionDetail" data-arg="cpa-suite">详情</button>
        <button type="button" class="btn-primary" data-action="handleExtensionAction" data-arg="install-cpa">安装</button>
      `;
    } else {
      pluginCpaActions.innerHTML = `
        <button type="button" class="btn-primary" data-action="switchExtensionTab" data-arg="installed">管理</button>
        <button type="button" class="btn-ghost secondary" data-action="handleExtensionAction" data-arg="open-cpamp">打开面板</button>
        <button type="button" class="btn-ghost danger" data-action="handleExtensionAction" data-arg="uninstall-cpa-suite">卸载</button>
      `;
    }
  }

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

function appendExtensionSettingRow(host, { label, desc, actionLabel, onClick, danger = false }) {
  const row = document.createElement('div');
  row.className = 'extension-detail-setting-row';
  const copy = document.createElement('div');
  copy.className = 'extension-detail-setting-label';
  const title = document.createElement('strong');
  title.textContent = label;
  const detail = document.createElement('span');
  detail.textContent = desc || '';
  copy.append(title, detail);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = danger ? 'btn-ghost extension-action-danger' : 'btn-ghost';
  btn.textContent = actionLabel || '操作';
  btn.onclick = (event) => {
    event?.stopPropagation?.();
    if (typeof onClick === 'function') onClick();
  };
  row.append(copy, btn);
  host.appendChild(row);
}

function appendExtensionSettingToggle(host, { label, desc, checked, onChange }) {
  const row = document.createElement('div');
  row.className = 'extension-detail-setting-row';
  const copy = document.createElement('div');
  copy.className = 'extension-detail-setting-label';
  const title = document.createElement('strong');
  title.textContent = label;
  const detail = document.createElement('span');
  detail.textContent = desc || '';
  copy.append(title, detail);
  const toggle = document.createElement('label');
  toggle.className = 'toggle-switch';
  toggle.title = checked ? '已开启' : '已关闭';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  toggle.append(input, slider);
  input.addEventListener('change', async () => {
    const next = Boolean(input.checked);
    toggle.title = next ? '已开启' : '已关闭';
    if (typeof onChange !== 'function') return;
    try {
      await onChange(next, input);
    } catch (e) {
      input.checked = !next;
      toggle.title = input.checked ? '已开启' : '已关闭';
      extensionNotify(`设置失败: ${e?.message || e}`, 'error');
    }
  });
  row.append(copy, toggle);
  host.appendChild(row);
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
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
  g.appendExtensionSettingRow = appendExtensionSettingRow;
  g.appendExtensionSettingToggle = appendExtensionSettingToggle;
})(globalThis);
