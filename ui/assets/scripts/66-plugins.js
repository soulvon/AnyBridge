// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
/**
 * 66-plugins.js — 插件系统通用渲染层
 *
 * 所有 UI 由 plugin.json 驱动，不为具体插件写死任何逻辑：
 *   configSchema → 配置表单     panels → 管理面板 tabs
 *   capabilities → 面板可见性   panel.table.loadFrom / panel.loadFrom → adapter 数据源
 *
 * 组件：PluginList / PluginCard / PluginConfigForm / PluginPanel /
 *      PluginOverviewPanel / PluginTablePanel / PluginLogsPanel / PluginDeployDialog
 */

// ── 状态 ──
globalThis.pluginRegistry = [];              // [{ manifest, status }]
globalThis.activePluginId = '';              // 当前管理面板打开的插件
globalThis.activePluginPanelId = '';         // 当前选中的 tab
const pluginTokenCache = new Map();          // pluginId → { token, expiresAt }
let pluginStatusUnlisten = null;
let pluginDeployUnlisten = null;
let pluginLogTimer = null;

function pluginInvoke(cmd, args) {
  return invoke(cmd, args);
}

function pluginNotify(message, type = 'info') {
  if (typeof extensionNotify === 'function') extensionNotify(message, type);
  else if (typeof showNotification === 'function') showNotification(message, type);
}

function pluginLog(level, message) {
  if (typeof extensionLog === 'function') extensionLog(level, message);
}

async function openPluginLink(url) {
  if (!url) return;
  try {
    await pluginInvoke('open_url', { url });
  } catch (e) {
    pluginNotify(`打开链接失败: ${e}`, 'error');
  }
}

// ═══════════════════════════════════════════════════
// 数据层
// ═══════════════════════════════════════════════════

async function refreshPluginList() {
  try {
    const plugins = await pluginInvoke('plugin_list');
    globalThis.pluginRegistry = Array.isArray(plugins) ? plugins : [];
  } catch (e) {
    pluginLog('warn', `插件列表加载失败: ${e}`);
    globalThis.pluginRegistry = [];
  }
  renderPluginList();
  return globalThis.pluginRegistry;
}

function getPlugin(pluginId) {
  return globalThis.pluginRegistry.find((p) => p.manifest?.id === pluginId) || null;
}

async function getPluginConfig(pluginId) {
  try {
    return (await pluginInvoke('plugin_get_config', { pluginId })) || {};
  } catch {
    return {};
  }
}

/**
 * 取插件管理 API 的认证令牌。约定：adapter.authenticate(ctx, port, configValues)
 * 返回 { token, expiresAt }。仅在面板声明 requiresAuth 时调用。
 */
async function getPluginToken(pluginId, force = false) {
  const cached = pluginTokenCache.get(pluginId);
  if (!force && cached && (!cached.expiresAt || new Date(cached.expiresAt) > new Date(Date.now() + 30000))) {
    return cached.token;
  }
  const config = await getPluginConfig(pluginId);
  const port = Number(config.port) || 8000;
  const result = await pluginInvoke('plugin_adapter_call', {
    pluginId,
    method: 'authenticate',
    args: [port, config],
  });
  const token = result?.token || '';
  pluginTokenCache.set(pluginId, { token, expiresAt: result?.expiresAt || '' });
  return token;
}

/**
 * 调用插件管理方法。文档约定管理类方法签名为 (ctx, port, adminToken, ...extra)。
 * needsAuth=false 时按 (ctx, port, ...extra) 调用。
 */
async function callPluginMethod(pluginId, method, extraArgs = [], needsAuth = true) {
  const config = await getPluginConfig(pluginId);
  const port = Number(config.port) || 8000;
  const args = needsAuth
    ? [port, await getPluginToken(pluginId), ...extraArgs]
    : [port, ...extraArgs];
  try {
    return await pluginInvoke('plugin_adapter_call', { pluginId, method, args });
  } catch (e) {
    // 令牌可能过期，重认证后重试一次
    if (needsAuth && /401|unauthor|token/i.test(String(e))) {
      const retryArgs = [port, await getPluginToken(pluginId, true), ...extraArgs];
      return await pluginInvoke('plugin_adapter_call', { pluginId, method, args: retryArgs });
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════
// PluginList / PluginCard
// ═══════════════════════════════════════════════════

const PLUGIN_STATE_META = {
  unknown: { label: '未安装', cls: 'not-installed' },
  deploying: { label: '部署中', cls: 'installing' },
  installed: { label: '已安装', cls: 'stopped' },
  starting: { label: '启动中', cls: 'installing' },
  running: { label: '运行中', cls: 'running' },
  stopping: { label: '停止中', cls: 'installing' },
  stopped: { label: '已停止', cls: 'stopped' },
  error: { label: '错误', cls: 'error' },
};

function pluginStateMeta(state) {
  return PLUGIN_STATE_META[state] || PLUGIN_STATE_META.unknown;
}

function renderPluginList() {
  const host = document.getElementById('plugin-list-grid');
  if (!host) return;
  host.replaceChildren();

  if (!globalThis.pluginRegistry.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-empty';
    empty.textContent = '未发现插件定义。插件目录为 resources/plugins/。';
    host.appendChild(empty);
    return;
  }

  for (const plugin of globalThis.pluginRegistry) {
    host.appendChild(renderPluginCard(plugin));
  }
}

function renderPluginCard(plugin) {
  const { manifest, status } = plugin;
  const meta = pluginStateMeta(status?.state);
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.pluginCard = manifest.id;

  const head = document.createElement('div');
  head.className = 'plugin-card-head';

  const mark = document.createElement('span');
  mark.className = 'plugin-card-mark';
  mark.textContent = (manifest.name || manifest.id).slice(0, 2).toUpperCase();
  head.appendChild(mark);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-card-title-wrap';
  const title = document.createElement('h3');
  title.textContent = manifest.name || manifest.id;
  titleWrap.appendChild(title);
  const desc = document.createElement('p');
  desc.textContent = manifest.description || '';
  titleWrap.appendChild(desc);
  head.appendChild(titleWrap);

  const badge = document.createElement('span');
  badge.className = `plugin-status status-${meta.cls}`;
  badge.textContent = meta.label;
  head.appendChild(badge);
  card.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'plugin-card-meta';
  const addMeta = (label, value) => {
    const cell = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    cell.append(l, v);
    grid.appendChild(cell);
  };
  addMeta('分类', manifest.category || '-');
  addMeta('版本', status?.version || manifest.version || '-');
  addMeta('端口', status?.port ? `:${status.port}` : '-');
  addMeta('策略', (manifest.deploy?.strategies || []).join(' / ') || '-');
  card.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'plugin-card-actions';
  const state = status?.state || 'unknown';
  const installed = ['installed', 'stopped', 'running', 'starting', 'error'].includes(state);

  if (!installed || state === 'unknown') {
    actions.appendChild(makePluginBtn('安装', 'btn-primary', () => openPluginDeployDialog(manifest.id)));
  } else if (state === 'running' || state === 'starting') {
    actions.appendChild(makePluginBtn('管理', 'btn-primary', () => openPluginManager(manifest.id)));
    actions.appendChild(makePluginBtn('停止', 'btn-ghost secondary', () => stopPlugin(manifest.id)));
  } else {
    actions.appendChild(makePluginBtn('启动', 'btn-primary', () => startPlugin(manifest.id)));
    actions.appendChild(makePluginBtn('管理', 'btn-ghost accent', () => openPluginManager(manifest.id)));
  }

  if (manifest.homepage) {
    actions.appendChild(
      makePluginBtn('项目主页', 'btn-ghost secondary', () => openPluginLink(manifest.homepage))
    );
  }
  card.appendChild(actions);

  if (status?.error) {
    const err = document.createElement('p');
    err.className = 'plugin-card-error';
    err.textContent = status.error;
    card.appendChild(err);
  }

  return card;
}

function makePluginBtn(label, cls, onClick, disabled = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

// ═══════════════════════════════════════════════════
// 生命周期
// ═══════════════════════════════════════════════════

async function startPlugin(pluginId) {
  try {
    pluginNotify(`正在启动 ${pluginId}...`, 'info');
    await pluginInvoke('plugin_start', { pluginId });
    pluginLog('info', `${pluginId} 启动中，等待健康检查`);
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`启动失败: ${e}`, 'error');
    pluginLog('err', `${pluginId} 启动失败: ${e}`);
    await refreshPluginList();
  }
}

async function stopPlugin(pluginId) {
  try {
    await pluginInvoke('plugin_stop', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginNotify(`${pluginId} 已停止`, 'ok');
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`停止失败: ${e}`, 'error');
  }
}

async function restartPlugin(pluginId) {
  try {
    pluginNotify(`正在重启 ${pluginId}...`, 'info');
    await pluginInvoke('plugin_restart', { pluginId });
    pluginTokenCache.delete(pluginId);
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`重启失败: ${e}`, 'error');
  }
}

async function uninstallPlugin(pluginId) {
  const ok = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(`确定卸载 ${pluginId}？安装目录与数据将被删除，无法恢复。`, '卸载插件')
    : window.confirm(`确定卸载 ${pluginId}？`);
  if (!ok) return;
  try {
    await pluginInvoke('plugin_uninstall', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginNotify(`${pluginId} 已卸载`, 'ok');
    closePluginManager();
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`卸载失败: ${e}`, 'error');
  }
}

async function checkPluginHealth(pluginId) {
  try {
    const result = await pluginInvoke('plugin_health_check', { pluginId });
    const el = document.getElementById('plugin-health-line');
    if (el) {
      el.textContent = result?.ok
        ? `健康 · 延迟 ${result.latency ?? '-'}ms`
        : `不健康 · ${result?.detail || result?.status || '无响应'}`;
      el.className = `plugin-health-line ${result?.ok ? 'is-ok' : 'is-bad'}`;
    }
    return result;
  } catch (e) {
    pluginNotify(`健康检查失败: ${e}`, 'error');
    return null;
  }
}

// ═══════════════════════════════════════════════════
// PluginDeployDialog
// ═══════════════════════════════════════════════════

async function openPluginDeployDialog(pluginId) {
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    pluginNotify(`未找到插件 ${pluginId}`, 'error');
    return;
  }
  const modal = document.getElementById('plugin-deploy-modal');
  if (!modal) return;

  const manifest = plugin.manifest;
  document.getElementById('plugin-deploy-title').textContent = `安装 ${manifest.name || pluginId}`;
  const strategies = manifest.deploy?.strategies || ['source'];
  const src = manifest.deploy?.source || {};

  const infoEl = document.getElementById('plugin-deploy-info');
  infoEl.replaceChildren();
  const addInfo = (label, value) => {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'plugin-deploy-info-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    row.append(l, v);
    infoEl.appendChild(row);
  };
  addInfo('部署策略', strategies.join(' → ') + (strategies.length > 1 ? '（失败自动降级）' : ''));
  addInfo('预计耗时', src.estimatedTime);
  addInfo('磁盘占用', src.minDiskMB ? `≥ ${src.minDiskMB} MB` : '');
  addInfo('需要联网', src.requiresNetwork ? '是' : '否');
  addInfo('项目地址', manifest.homepage);

  const stepsEl = document.getElementById('plugin-deploy-steps');
  stepsEl.replaceChildren();
  const logEl = document.getElementById('plugin-deploy-log');
  logEl.replaceChildren();

  const confirmView = document.getElementById('plugin-deploy-confirm-view');
  const progressView = document.getElementById('plugin-deploy-progress-view');
  confirmView.style.display = '';
  progressView.style.display = 'none';

  const okBtn = document.getElementById('plugin-deploy-confirm-btn');
  const cancelBtn = document.getElementById('plugin-deploy-cancel-btn');
  okBtn.disabled = false;
  okBtn.textContent = '开始安装';

  // 环境预检（按第一个策略）
  const envEl = document.getElementById('plugin-deploy-env');
  envEl.replaceChildren();
  const envHint = document.createElement('p');
  envHint.className = 'plugin-deploy-env-hint';
  envHint.textContent = '正在检测环境依赖...';
  envEl.appendChild(envHint);

  modal.classList.add('active');

  pluginInvoke('plugin_check_environment', { pluginId, strategy: strategies[0] })
    .then((env) => {
      envEl.replaceChildren();
      const title = document.createElement('p');
      title.className = 'plugin-deploy-env-title';
      title.textContent = env?.ready ? '环境依赖已就绪' : '缺少以下依赖：';
      title.classList.add(env?.ready ? 'is-ok' : 'is-bad');
      envEl.appendChild(title);
      for (const m of env?.missing || []) {
        const row = document.createElement('div');
        row.className = 'plugin-deploy-env-row';
        const name = document.createElement('strong');
        name.textContent = `${m.name}${m.version ? ' ' + m.version : ''}`;
        const how = document.createElement('span');
        how.textContent = m.installer ? `安装：${m.installer}` : '';
        row.append(name, how);
        if (m.alternativeDownload) {
          const link = document.createElement('a');
          link.href = '#';
          link.textContent = '下载页';
          link.addEventListener('click', (ev) => {
            ev.preventDefault();
            openPluginLink(m.alternativeDownload);
          });
          row.appendChild(link);
        }
        envEl.appendChild(row);
      }
      if (!env?.ready && strategies.length > 1) {
        const note = document.createElement('p');
        note.className = 'plugin-deploy-env-hint';
        note.textContent = `仍可尝试安装：${strategies[0]} 失败后会自动降级到 ${strategies[1]}。`;
        envEl.appendChild(note);
      }
    })
    .catch((e) => {
      envEl.replaceChildren();
      const err = document.createElement('p');
      err.className = 'plugin-deploy-env-hint is-bad';
      err.textContent = `环境检测失败: ${e}`;
      envEl.appendChild(err);
    });

  cancelBtn.onclick = () => modal.classList.remove('active');
  okBtn.onclick = async () => {
    confirmView.style.display = 'none';
    progressView.style.display = '';
    okBtn.disabled = true;
    okBtn.textContent = '安装中...';
    cancelBtn.textContent = '后台运行';

    try {
      await pluginInvoke('plugin_deploy', { pluginId });
      appendDeployLog(logEl, 'ok', '部署完成');
      pluginNotify(`${manifest.name || pluginId} 部署完成`, 'ok');
      okBtn.disabled = false;
      okBtn.textContent = '完成并启动';
      okBtn.onclick = async () => {
        modal.classList.remove('active');
        await startPlugin(pluginId);
      };
    } catch (e) {
      appendDeployLog(logEl, 'err', String(e));
      pluginNotify(`部署失败: ${e}`, 'error');
      okBtn.disabled = false;
      okBtn.textContent = '重试';
      okBtn.onclick = () => openPluginDeployDialog(pluginId);
    } finally {
      cancelBtn.textContent = '关闭';
      await refreshPluginList();
    }
  };
}

function closePluginDeployDialog() {
  const modal = document.getElementById('plugin-deploy-modal');
  if (modal) modal.classList.remove('active');
}

function appendDeployLog(logEl, level, message) {
  if (!logEl || !message) return;
  const line = document.createElement('div');
  line.className = `plugin-deploy-log-line level-${level}`;
  const time = document.createElement('span');
  time.className = 'plugin-deploy-log-time';
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = message;
  line.append(time, text);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** 部署进度事件 → 步骤列表 + 日志。步骤由事件动态出现，不预设步骤名。 */
function handleDeployProgress(payload) {
  const stepsEl = document.getElementById('plugin-deploy-steps');
  const logEl = document.getElementById('plugin-deploy-log');
  if (!payload) return;

  const key = String(payload.step ?? '');
  const label = payload.title || stepLabelFor(key);
  if (stepsEl && key) {
    let row = stepsEl.querySelector(`[data-step="${CSS.escape(key)}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'plugin-deploy-step';
      row.dataset.step = key;
      const icon = document.createElement('span');
      icon.className = 'plugin-deploy-step-icon';
      const text = document.createElement('span');
      text.className = 'plugin-deploy-step-label';
      row.append(icon, text);
      stepsEl.appendChild(row);
    }
    row.querySelector('.plugin-deploy-step-label').textContent = label;
    row.dataset.status = payload.status || 'running';
  }

  const level = payload.status === 'error' ? 'err' : payload.status === 'done' ? 'ok' : 'info';
  appendDeployLog(logEl, level, payload.message);
  if (payload.status === 'error') {
    pluginLog('err', `[${label}] ${payload.message || ''}`);
  }
}

function stepLabelFor(key) {
  const map = {
    'check-environment': '检测环境',
    'environment-ok': '环境就绪',
    deploy: '执行部署',
    config: '生成配置',
    'deploy-done': '部署完成',
    fallback: '策略降级',
    'port-check': '端口检查',
  };
  return map[key] || `步骤 ${key}`;
}

// ═══════════════════════════════════════════════════
// PluginPanel（管理面板）
// ═══════════════════════════════════════════════════

async function openPluginManager(pluginId) {
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    pluginNotify(`未找到插件 ${pluginId}`, 'error');
    return;
  }
  const modal = document.getElementById('plugin-manager-modal');
  if (!modal) return;

  globalThis.activePluginId = pluginId;
  document.getElementById('plugin-manager-title').textContent = `${plugin.manifest.name || pluginId} 管理`;

  const panels = visiblePanels(plugin.manifest);
  const tabsEl = document.getElementById('plugin-manager-tabs');
  tabsEl.replaceChildren();
  for (const panel of panels) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'plugin-tab';
    tab.textContent = panel.title || panel.id;
    tab.dataset.panelId = panel.id;
    tab.addEventListener('click', () => selectPluginPanel(panel.id));
    tabsEl.appendChild(tab);
  }

  modal.classList.add('active');
  document.addEventListener('keydown', closePluginManagerOnEsc);
  await selectPluginPanel(panels[0]?.id || 'overview');
}

function closePluginManager() {
  const modal = document.getElementById('plugin-manager-modal');
  if (modal) modal.classList.remove('active');
  globalThis.activePluginId = '';
  globalThis.activePluginPanelId = '';
  if (pluginLogTimer) {
    clearInterval(pluginLogTimer);
    pluginLogTimer = null;
  }
  document.removeEventListener('keydown', closePluginManagerOnEsc);
}

function closePluginManagerOnEsc(e) {
  if (e.key === 'Escape') closePluginManager();
}

/** 面板可见性由 capability 决定；额外追加由 configSchema 驱动的「配置」面板。 */
function visiblePanels(manifest) {
  const caps = manifest.capabilities || [];
  const declared = (manifest.panels || [])
    .filter((p) => !p.capability || caps.includes(p.capability))
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if ((manifest.configSchema || []).length) {
    declared.push({ id: '__config', title: '配置', type: 'builtin', order: 999 });
  }
  return declared;
}

async function selectPluginPanel(panelId) {
  const pluginId = globalThis.activePluginId;
  const plugin = getPlugin(pluginId);
  if (!plugin) return;
  globalThis.activePluginPanelId = panelId;

  document.querySelectorAll('#plugin-manager-tabs .plugin-tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.panelId === panelId);
  });

  if (pluginLogTimer) {
    clearInterval(pluginLogTimer);
    pluginLogTimer = null;
  }

  const body = document.getElementById('plugin-manager-body');
  body.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'plugin-panel-loading';
  loading.textContent = '加载中...';
  body.appendChild(loading);

  const panel = visiblePanels(plugin.manifest).find((p) => p.id === panelId);
  if (!panel) return;

  try {
    let node;
    if (panel.id === '__config') node = await renderPluginConfigForm(plugin);
    else if (panel.id === 'overview') node = await renderPluginOverviewPanel(plugin, panel);
    else if (panel.id === 'logs' || panel.capability === 'logs') node = await renderPluginLogsPanel(plugin, panel);
    else node = await renderPluginDataPanel(plugin, panel);

    if (globalThis.activePluginPanelId !== panelId) return; // 用户已切走
    body.replaceChildren(node);
  } catch (e) {
    if (globalThis.activePluginPanelId !== panelId) return;
    body.replaceChildren(renderPluginError(e));
  }
}

function renderPluginError(e) {
  const box = document.createElement('div');
  box.className = 'plugin-panel-error';
  const title = document.createElement('p');
  title.textContent = '面板加载失败';
  const detail = document.createElement('code');
  detail.textContent = String(e);
  box.append(title, detail);
  return box;
}

// ── PluginOverviewPanel ──
async function renderPluginOverviewPanel(plugin, panel) {
  const { manifest, status } = plugin;
  const config = await getPluginConfig(manifest.id);
  const wrap = document.createElement('div');
  wrap.className = 'plugin-panel';

  const values = {
    status: pluginStateMeta(status?.state).label,
    state: status?.state,
    port: status?.port || config.port || '-',
    version: status?.version || manifest.version || '-',
    pid: status?.pid || '-',
    uptime: status?.startedAt ? formatPluginUptime(status.startedAt) : '-',
    installPath: status?.installPath || config.installPath || '-',
  };

  const grid = document.createElement('div');
  grid.className = 'plugin-field-grid';
  const fields = panel.fields?.length
    ? panel.fields
    : [
        { key: 'status', label: '状态', type: 'status-light' },
        { key: 'port', label: '端口', type: 'text' },
        { key: 'version', label: '版本', type: 'text' },
        { key: 'uptime', label: '运行时间', type: 'duration' },
      ];
  for (const f of fields) {
    grid.appendChild(renderPluginField(f, values[f.key], status?.state));
  }
  // 概览始终补充 PID 与安装路径
  grid.appendChild(renderPluginField({ key: 'pid', label: 'PID', type: 'text' }, values.pid));
  wrap.appendChild(grid);

  const pathRow = document.createElement('p');
  pathRow.className = 'plugin-install-path';
  pathRow.textContent = `安装路径：${values.installPath}`;
  wrap.appendChild(pathRow);

  const health = document.createElement('p');
  health.id = 'plugin-health-line';
  health.className = 'plugin-health-line';
  health.textContent = '尚未检查';
  wrap.appendChild(health);

  const actions = document.createElement('div');
  actions.className = 'plugin-panel-actions';
  const state = status?.state;
  const running = state === 'running' || state === 'starting';
  actions.appendChild(makePluginBtn('启动', 'btn-primary', () => startPlugin(manifest.id), running));
  actions.appendChild(makePluginBtn('停止', 'btn-ghost secondary', () => stopPlugin(manifest.id), !running));
  actions.appendChild(makePluginBtn('重启', 'btn-ghost accent', () => restartPlugin(manifest.id), !running));
  actions.appendChild(makePluginBtn('立即检查', 'btn-ghost secondary', () => checkPluginHealth(manifest.id)));
  actions.appendChild(makePluginBtn('卸载', 'btn-ghost danger', () => uninstallPlugin(manifest.id)));
  wrap.appendChild(actions);

  if (status?.error) {
    const err = document.createElement('p');
    err.className = 'plugin-panel-error-line';
    err.textContent = status.error;
    wrap.appendChild(err);
  }

  if (running) checkPluginHealth(manifest.id);
  return wrap;
}

function renderPluginField(field, value, state) {
  const cell = document.createElement('div');
  cell.className = 'plugin-field';
  const label = document.createElement('span');
  label.textContent = field.label || field.key;
  cell.appendChild(label);

  const val = document.createElement('strong');
  if (field.type === 'status-light') {
    const dot = document.createElement('i');
    dot.className = `plugin-dot state-${pluginStateMeta(state).cls}`;
    val.append(dot, document.createTextNode(String(value ?? '-')));
  } else if (field.type === 'number') {
    val.textContent = value === undefined || value === null ? '0' : String(value);
  } else {
    val.textContent = value === undefined || value === null || value === '' ? '-' : String(value);
  }
  cell.appendChild(val);
  return cell;
}

function formatPluginUptime(startedAt) {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return '-';
  let sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const d = Math.floor(sec / 86400);
  sec %= 86400;
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── PluginDataPanel（fields + table + actions，覆盖账号管理 / Client Key 等）──
async function renderPluginDataPanel(plugin, panel) {
  const pluginId = plugin.manifest.id;
  const needsAuth = panel.requiresAuth !== false;
  const wrap = document.createElement('div');
  wrap.className = 'plugin-panel';

  if (plugin.status?.state !== 'running') {
    const hint = document.createElement('p');
    hint.className = 'plugin-panel-hint';
    hint.textContent = '插件未在运行，请先启动后再管理。';
    wrap.appendChild(hint);
    return wrap;
  }

  // 统计字段
  if (panel.fields?.length && panel.loadFrom) {
    const stats = await callPluginMethod(pluginId, panel.loadFrom, [], needsAuth).catch(() => ({}));
    const grid = document.createElement('div');
    grid.className = 'plugin-field-grid';
    for (const f of panel.fields) grid.appendChild(renderPluginField(f, stats?.[f.key]));
    wrap.appendChild(grid);
  }

  // 操作按钮
  if (panel.actions?.length) {
    const bar = document.createElement('div');
    bar.className = 'plugin-panel-actions';
    for (const action of panel.actions) {
      if (action.type === 'row-action') continue; // 渲染在表格行内
      bar.appendChild(renderPluginAction(pluginId, panel, action, needsAuth));
    }
    wrap.appendChild(bar);
  }

  // 表格
  if (panel.table?.loadFrom) {
    const table = await renderPluginTable(plugin, panel, needsAuth);
    wrap.appendChild(table);
  }

  return wrap;
}

function renderPluginAction(pluginId, panel, action, needsAuth) {
  if (action.type === 'file-upload') {
    const btn = makePluginBtn(action.label, 'btn-ghost accent', async () => {
      let filePath = null;
      try {
        filePath = await pluginInvoke('pick_file', {
          title: action.label,
          extensions: action.accept ? action.accept.split(',').map((s) => s.trim()) : [],
        });
      } catch (e) {
        pluginNotify(`选择文件失败: ${e}`, 'error');
        return;
      }
      if (!filePath) return;
      try {
        const result = await callPluginMethod(pluginId, action.method || action.id, [filePath, action.variant || 'build'], needsAuth);
        pluginNotify(`${action.label}完成：导入 ${result?.imported ?? '-'} 条`, 'ok');
        await selectPluginPanel(panel.id);
      } catch (e) {
        pluginNotify(`${action.label}失败: ${e}`, 'error');
      }
    });
    return btn;
  }

  if (action.type === 'prompt') {
    return makePluginBtn(action.label, 'btn-ghost accent', async () => {
      const value = window.prompt(action.promptLabel || action.label);
      if (!value) return;
      try {
        await callPluginMethod(pluginId, action.method || action.id, [value], needsAuth);
        pluginNotify(`${action.label}成功`, 'ok');
        await selectPluginPanel(panel.id);
      } catch (e) {
        pluginNotify(`${action.label}失败: ${e}`, 'error');
      }
    });
  }

  return makePluginBtn(action.label, 'btn-ghost secondary', async () => {
    if (action.confirm) {
      const ok = typeof showCustomConfirm === 'function'
        ? await showCustomConfirm(`确定执行「${action.label}」？`, action.label)
        : window.confirm(`确定执行「${action.label}」？`);
      if (!ok) return;
    }
    try {
      await callPluginMethod(pluginId, action.method || action.id, [], needsAuth);
      pluginNotify(`${action.label}成功`, 'ok');
      await selectPluginPanel(panel.id);
    } catch (e) {
      pluginNotify(`${action.label}失败: ${e}`, 'error');
    }
  });
}

async function renderPluginTable(plugin, panel, needsAuth) {
  const pluginId = plugin.manifest.id;
  const columns = panel.table.columns || [];
  const rowAction = (panel.actions || []).find((a) => a.type === 'row-action');

  const box = document.createElement('div');
  box.className = 'plugin-table-box';

  let rows = [];
  try {
    const data = await callPluginMethod(pluginId, panel.table.loadFrom, [], needsAuth);
    rows = normalizeTableRows(data);
  } catch (e) {
    const err = document.createElement('p');
    err.className = 'plugin-panel-hint is-bad';
    err.textContent = `数据加载失败: ${e}`;
    box.appendChild(err);
    return box;
  }

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }
  if (rowAction) {
    const th = document.createElement('th');
    th.textContent = '操作';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length + (rowAction ? 1 : 0);
    td.className = 'plugin-table-empty';
    td.textContent = '暂无数据';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const v = row?.[col];
      td.textContent = v === undefined || v === null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      tr.appendChild(td);
    }
    if (rowAction) {
      const td = document.createElement('td');
      td.appendChild(
        makePluginBtn(rowAction.label, 'btn-ghost danger btn-xs', async () => {
          if (rowAction.confirm) {
            const ok = typeof showCustomConfirm === 'function'
              ? await showCustomConfirm(`确定${rowAction.label}这一项？`, rowAction.label)
              : window.confirm(`确定${rowAction.label}这一项？`);
            if (!ok) return;
          }
          const id = row.id || row.key || row.keyId;
          try {
            await callPluginMethod(pluginId, rowAction.method || rowAction.id, [id], needsAuth);
            pluginNotify(`${rowAction.label}成功`, 'ok');
            await selectPluginPanel(panel.id);
          } catch (e) {
            pluginNotify(`${rowAction.label}失败: ${e}`, 'error');
          }
        })
      );
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  return box;
}

/** adapter 返回形态各异：数组 / {items} / {data} / {list} — 统一成数组。 */
function normalizeTableRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'data', 'list', 'rows', 'keys', 'accounts']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

// ── PluginLogsPanel ──
async function renderPluginLogsPanel(plugin, panel) {
  const pluginId = plugin.manifest.id;
  const wrap = document.createElement('div');
  wrap.className = 'plugin-panel';

  const bar = document.createElement('div');
  bar.className = 'plugin-panel-actions';
  const box = document.createElement('div');
  box.className = 'plugin-log-box';
  box.id = 'plugin-log-box';

  const load = async () => {
    let lines = [];
    // 优先用 adapter 自己的日志接口；返回 null 表示回退到进程日志文件
    try {
      const fromAdapter = await callPluginMethod(pluginId, 'getLogs', [{ lines: 300 }], false);
      if (fromAdapter?.lines?.length) {
        lines = fromAdapter.lines.map((l) =>
          typeof l === 'string' ? l : `${l.time || ''} [${l.level || 'info'}] ${l.message || ''}`
        );
      }
    } catch { /* adapter 未实现，走文件 */ }

    if (!lines.length) {
      try {
        const logs = await pluginInvoke('plugin_read_logs', { pluginId, lines: 300 });
        lines = [...(logs?.stdout || []), ...(logs?.stderr || []).map((l) => `[stderr] ${l}`)];
      } catch (e) {
        lines = [`日志读取失败: ${e}`];
      }
    }

    box.replaceChildren();
    if (!lines.length) {
      const empty = document.createElement('p');
      empty.className = 'plugin-panel-hint';
      empty.textContent = '暂无日志。';
      box.appendChild(empty);
      return;
    }
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'plugin-log-line';
      if (/error|failed|panic/i.test(line)) div.classList.add('is-err');
      div.textContent = line;
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  };

  bar.appendChild(makePluginBtn('刷新', 'btn-ghost secondary', load));
  const autoBtn = makePluginBtn('自动刷新：关', 'btn-ghost accent', () => {
    if (pluginLogTimer) {
      clearInterval(pluginLogTimer);
      pluginLogTimer = null;
      autoBtn.textContent = '自动刷新：关';
    } else {
      pluginLogTimer = setInterval(load, 3000);
      autoBtn.textContent = '自动刷新：开';
    }
  });
  bar.appendChild(autoBtn);
  wrap.append(bar, box);
  await load();
  return wrap;
}

// ── PluginConfigForm（由 configSchema 自动渲染）──
async function renderPluginConfigForm(plugin) {
  const manifest = plugin.manifest;
  const config = await getPluginConfig(manifest.id);
  const wrap = document.createElement('div');
  wrap.className = 'plugin-panel';

  const form = document.createElement('div');
  form.className = 'plugin-config-form';
  const inputs = new Map();

  const visible = (manifest.configSchema || []).filter((f) => !f.hidden);
  const hidden = (manifest.configSchema || []).filter((f) => f.hidden);

  for (const field of visible) {
    form.appendChild(buildConfigRow(field, config, inputs));
  }

  if (hidden.length) {
    const sep = document.createElement('p');
    sep.className = 'plugin-config-sep';
    sep.textContent = '系统自动生成的密钥（通常不需要修改）';
    form.appendChild(sep);
    for (const field of hidden) {
      form.appendChild(buildConfigRow(field, config, inputs, true));
    }
  }
  wrap.appendChild(form);

  const actions = document.createElement('div');
  actions.className = 'plugin-panel-actions';
  actions.appendChild(
    makePluginBtn('保存配置', 'btn-primary', async () => {
      const next = { ...config };
      for (const [key, el] of inputs) {
        const field = (manifest.configSchema || []).find((f) => f.key === key);
        if (field?.immutable && config[key]) continue; // 不可变字段跳过
        if (field?.type === 'number') next[key] = Number(el.value) || field.default || 0;
        else if (field?.type === 'boolean') next[key] = el.checked;
        else next[key] = el.value;
      }
      try {
        await pluginInvoke('plugin_set_config', { pluginId: manifest.id, values: next });
        pluginNotify('配置已保存。重启插件后生效。', 'ok');
        pluginTokenCache.delete(manifest.id);
      } catch (e) {
        pluginNotify(`保存失败: ${e}`, 'error');
      }
    })
  );
  actions.appendChild(
    makePluginBtn('重新生成配置文件', 'btn-ghost accent', async () => {
      const installPath = plugin.status?.installPath || config.installPath;
      if (!installPath) {
        pluginNotify('插件尚未安装，无法生成配置文件', 'warn');
        return;
      }
      try {
        const path = await pluginInvoke('plugin_generate_config', { pluginId: manifest.id, installPath });
        pluginNotify(`配置文件已写入：${path}`, 'ok');
      } catch (e) {
        pluginNotify(`生成失败: ${e}`, 'error');
      }
    })
  );
  wrap.appendChild(actions);
  return wrap;
}

function buildConfigRow(field, config, inputs, isSecret = false) {
  const row = document.createElement('div');
  row.className = 'plugin-config-row';

  const label = document.createElement('label');
  label.textContent = field.label || field.key;
  if (field.required) {
    const star = document.createElement('span');
    star.className = 'plugin-config-required';
    star.textContent = ' *';
    label.appendChild(star);
  }
  row.appendChild(label);

  const controls = document.createElement('div');
  controls.className = 'plugin-config-controls';

  let input;
  const current = config[field.key] ?? field.default ?? '';

  if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(current);
  } else if (field.type === 'select') {
    input = document.createElement('select');
    input.className = 'settings-input';
    for (const opt of field.options || []) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (String(current) === String(opt.value)) o.selected = true;
      input.appendChild(o);
    }
  } else {
    input = document.createElement('input');
    input.className = 'settings-input';
    input.type = field.type === 'password' || isSecret ? 'password' : field.type === 'number' ? 'number' : 'text';
    input.value = current === null || current === undefined ? '' : String(current);
  }

  const immutable = field.immutable && config[field.key];
  if (immutable) {
    input.disabled = true;
    input.title = '此配置在首次生成后不可修改';
  }
  inputs.set(field.key, input);
  controls.appendChild(input);

  if (isSecret || field.type === 'password') {
    controls.appendChild(
      makePluginBtn('显示', 'btn-ghost secondary btn-xs', (ev) => {
        const btn = ev.currentTarget;
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.textContent = input.type === 'password' ? '显示' : '隐藏';
      })
    );
    controls.appendChild(
      makePluginBtn('复制', 'btn-ghost secondary btn-xs', async () => {
        try {
          await navigator.clipboard.writeText(input.value);
          pluginNotify('已复制到剪贴板', 'ok');
        } catch {
          pluginNotify('复制失败', 'error');
        }
      })
    );
  }
  row.appendChild(controls);

  const hints = [];
  if (field.description) hints.push(field.description);
  if (immutable) hints.push('首次生成后不可修改');
  if (hints.length) {
    const hint = document.createElement('p');
    hint.className = 'plugin-config-hint';
    hint.textContent = hints.join(' · ');
    row.appendChild(hint);
  }
  return row;
}

// ═══════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════

async function initPluginSystem() {
  try {
    await pluginInvoke('plugin_restore_state');
  } catch (e) {
    pluginLog('warn', `插件状态恢复失败: ${e}`);
  }

  await refreshPluginList();

  if (typeof tauriEvent?.listen === 'function') {
    if (!pluginDeployUnlisten) {
      pluginDeployUnlisten = await tauriEvent.listen('plugin-deploy-progress', (e) => {
        handleDeployProgress(e.payload);
      });
    }
    if (!pluginStatusUnlisten) {
      pluginStatusUnlisten = await tauriEvent.listen('plugin-status-changed', async (e) => {
        const status = e.payload;
        if (!status?.pluginId) return;
        const entry = getPlugin(status.pluginId);
        if (entry) entry.status = status;
        renderPluginList();
        // 管理面板开着且是同一插件时，刷新概览
        if (globalThis.activePluginId === status.pluginId && globalThis.activePluginPanelId === 'overview') {
          await selectPluginPanel('overview');
        }
      });
    }
  }
}

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g.refreshPluginList = refreshPluginList;
  g.renderPluginList = renderPluginList;
  g.initPluginSystem = initPluginSystem;
  g.openPluginManager = openPluginManager;
  g.closePluginManager = closePluginManager;
  g.selectPluginPanel = selectPluginPanel;
  g.openPluginDeployDialog = openPluginDeployDialog;
  g.closePluginDeployDialog = closePluginDeployDialog;
  g.startPlugin = startPlugin;
  g.stopPlugin = stopPlugin;
  g.restartPlugin = restartPlugin;
  g.uninstallPlugin = uninstallPlugin;
  g.checkPluginHealth = checkPluginHealth;
  g.callPluginMethod = callPluginMethod;
})(globalThis);
