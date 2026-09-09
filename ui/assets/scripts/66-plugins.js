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

let lastRecordedPluginCount = null;

async function refreshPluginList(options = {}) {
  const manual = Boolean(options && options.manual);
  if (manual) {
    pluginLog('info', '正在重新扫描并刷新插件列表...');
  }
  try {
    const plugins = await pluginInvoke('plugin_list');
    globalThis.pluginRegistry = Array.isArray(plugins) ? plugins : [];
    const count = globalThis.pluginRegistry.length;
    const isInitial = lastRecordedPluginCount === null;
    if (manual || isInitial || count !== lastRecordedPluginCount) {
      lastRecordedPluginCount = count;
      const names = globalThis.pluginRegistry.map(p => p.manifest?.name || p.manifest?.id).join(', ');
      pluginLog('info', `已扫描本地插件库：发现 ${count} 个扩展插件${names ? `（${names}）` : ''}。`);
    }
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
  uninstalling: { label: '卸载中', cls: 'installing' },
  updating: { label: '更新中', cls: 'installing' },
  error: { label: '错误', cls: 'error' },
};

function pluginStateMeta(state) {
  return PLUGIN_STATE_META[state] || PLUGIN_STATE_META.unknown;
}

let currentPluginStatusFilter = 'all';

function setPluginStatusFilter(filter) {
  currentPluginStatusFilter = filter || 'all';
  document.querySelectorAll('[data-plugin-filter]').forEach(btn => {
    const isActive = btn.dataset.pluginFilter === currentPluginStatusFilter;
    btn.classList.toggle('active', isActive);
  });
  filterPluginTable();
}

function filterPluginTable() {
  const searchInput = document.getElementById('pluginSearchInput');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const rows = document.querySelectorAll('.plugin-table-main tbody tr');
  let visibleCount = 0;

  rows.forEach(row => {
    const text = (row.textContent || '').toLowerCase();
    const isInstalled = row.dataset.pluginInstalled === 'true';
    const matchesQuery = !query || text.includes(query);

    let matchesFilter = true;
    if (currentPluginStatusFilter === 'installed') {
      matchesFilter = isInstalled;
    } else if (currentPluginStatusFilter === 'not-installed') {
      matchesFilter = !isInstalled;
    }

    const show = matchesQuery && matchesFilter;
    row.style.display = show ? '' : 'none';
    if (show) visibleCount += 1;
  });

  const countPill = document.getElementById('pluginCountPill');
  if (countPill) {
    countPill.textContent = `共 ${visibleCount} 个`;
  }
}

function renderPluginList() {
  const host = document.getElementById('plugin-list-grid');
  if (host) {
    host.replaceChildren();
    if (globalThis.pluginRegistry && globalThis.pluginRegistry.length > 0) {
      for (const plugin of globalThis.pluginRegistry) {
        host.appendChild(renderPluginCard(plugin));
      }
    }
    filterPluginTable();
  }
  renderInstalledPluginCards();
}

// ═══════════════════════════════════════════════════
// 已安装大卡片（挂载在「已安装」Tab，100% 对齐 CPA 套件规格）
// ═══════════════════════════════════════════════════

globalThis.pluginUpdateReports = new Map();   // pluginId -> report
globalThis.pluginUpdateChecking = new Set();  // pluginId

function getPluginActionConfig(manifest, state, hasUpdate) {
  const pluginId = manifest.id;
  const isRunning = state === 'running';

  if (state === 'uninstalling') {
    return {
      primary: { label: '卸载中...', action: null, disabled: true },
      secondary: []
    };
  }

  if (state === 'updating') {
    return {
      primary: { label: '更新中...', action: null, disabled: true },
      secondary: []
    };
  }

  if (state === 'starting') {
    return {
      primary: { label: '启动中...', action: null, disabled: true },
      secondary: []
    };
  }

  if (isRunning) {
    if (hasUpdate) {
      return {
        primary: { label: '更新', action: () => upgradePlugin(pluginId) },
        secondary: [
          { label: '打开面板', action: () => openPluginConsole(pluginId), cls: 'accent' },
          { label: '重启', action: () => restartPlugin(pluginId), cls: 'accent' },
          { label: '停止', action: () => stopPlugin(pluginId), cls: 'warn' },
          { label: '设置', action: () => openPluginManager(pluginId), cls: 'secondary' },
          ...(manifest.homepage ? [{ label: '项目主页', action: () => openPluginLink(manifest.homepage), cls: 'secondary' }] : []),
          { label: '卸载', action: () => uninstallPlugin(pluginId), cls: 'danger' }
        ]
      };
    }
    return {
      primary: { label: '打开面板', action: () => openPluginConsole(pluginId) },
      secondary: [
        { label: '重启', action: () => restartPlugin(pluginId), cls: 'accent' },
        { label: '停止', action: () => stopPlugin(pluginId), cls: 'warn' },
        { label: '检测更新', action: () => checkPluginUpdate(pluginId), cls: 'accent' },
        { label: '设置', action: () => openPluginManager(pluginId), cls: 'secondary' },
        ...(manifest.homepage ? [{ label: '项目主页', action: () => openPluginLink(manifest.homepage), cls: 'secondary' }] : []),
        { label: '卸载', action: () => uninstallPlugin(pluginId), cls: 'danger' }
      ]
    };
  }

  // 已安装但未运行 (stopped / installed / error)
  if (hasUpdate) {
    return {
      primary: { label: '更新', action: () => upgradePlugin(pluginId) },
      secondary: [
        { label: '启动', action: () => startPlugin(pluginId), cls: 'accent' },
        { label: '设置', action: () => openPluginManager(pluginId), cls: 'secondary' },
        ...(manifest.homepage ? [{ label: '项目主页', action: () => openPluginLink(manifest.homepage), cls: 'secondary' }] : []),
        { label: '卸载', action: () => uninstallPlugin(pluginId), cls: 'danger' }
      ]
    };
  }

  return {
    primary: { label: '启动', action: () => startPlugin(pluginId) },
    secondary: [
      { label: '设置', action: () => openPluginManager(pluginId), cls: 'secondary' },
      { label: '检测更新', action: () => checkPluginUpdate(pluginId), cls: 'accent' },
      ...(manifest.homepage ? [{ label: '项目主页', action: () => openPluginLink(manifest.homepage), cls: 'secondary' }] : []),
      { label: '卸载', action: () => uninstallPlugin(pluginId), cls: 'danger' }
    ]
  };
}

async function renderInstalledPluginCards() {
  const container = document.getElementById('installed-plugins-container');
  if (!container) return;

  const installedPlugins = (globalThis.pluginRegistry || []).filter(p => {
    const s = p.status?.state;
    return ['installed', 'stopped', 'running', 'starting', 'stopping', 'error', 'deploying', 'uninstalling', 'updating'].includes(s);
  });

  const cards = [];
  for (const plugin of installedPlugins) {
    const config = await getPluginConfig(plugin.manifest.id);
    cards.push(renderInstalledPluginCard(plugin, config));
  }
  container.replaceChildren(...cards);
}

function renderInstalledPluginCard(plugin, config = {}) {
  const { manifest, status } = plugin;
  const state = status?.state || 'installed';
  const meta = pluginStateMeta(state);
  const isRunning = state === 'running';
  const isTrans = ['deploying', 'starting', 'stopping', 'uninstalling', 'updating'].includes(state);
  const report = globalThis.pluginUpdateReports?.get(manifest.id);
  const hasUpdate = Boolean(report?.hasUpdate);

  const card = document.createElement('article');
  card.className = 'extension-card extension-card-featured';
  card.dataset.installedPluginCard = manifest.id;
  card.dataset.extensionTags = 'api-gateway recommended';

  // 1. 顶部标识区（Logo 100% 对齐 CPA 套件规格：微立体渐变底色+纯白文字，标题行干净利落）
  const top = document.createElement('div');
  top.className = 'extension-card-top';

  const markText = manifest.short || (manifest.id === 'jimeng2api' ? 'JM' : (manifest.name || manifest.id).slice(0, 2).toUpperCase());
  const logoClass = manifest.id === 'jimeng2api'
    ? 'extension-logo-jimeng'
    : (manifest.id === 'grok2api' ? 'extension-logo-grok' : 'extension-logo-cpa');

  top.innerHTML = `
    <div class="extension-identity">
      <div class="extension-logo ${logoClass}" style="font-size: 13px;" aria-hidden="true">${markText}</div>
      <div>
        <div class="extension-title-row">
          <h3>${manifest.name || manifest.id}</h3>
        </div>
        <p>${manifest.description || '即梦多账号 API 网关，兼容 OpenAI 图像与视频接口，支持多账号池轮询。'}</p>
      </div>
    </div>
    <span class="extension-status status-${meta.cls}" id="installed-card-status-${manifest.id}">${meta.label}</span>
  `;

  // 2. 属性网格（2x2 对称四格：左版本、右端口、左安装目录、右组件运行状态）
  const metaGrid = document.createElement('div');
  metaGrid.className = 'extension-meta-grid';

  const verStr = status?.version || manifest.version || '1.0.0';
  const port = status?.port || config?.port || (manifest.id === 'jimeng2api' ? 5566 : 8000);
  const installPath = status?.install_path || config?.installPath || '默认目录';
  const shortInstallDir = installPath.length > 38 ? `${installPath.slice(0, 16)}...${installPath.slice(-18)}` : installPath;

  let componentText = '1 个';
  if (isRunning) componentText = '1/1 运行';
  else if (state === 'starting') componentText = '启动中';
  else if (state === 'stopped' || state === 'installed') componentText = '1 个 (未运行)';
  else if (state === 'error') componentText = '异常';

  metaGrid.innerHTML = `
    <div>
      <span>版本</span>
      <strong>v${verStr}</strong>
      <span class="extension-update-badge" id="installed-update-badge-${manifest.id}" ${hasUpdate ? '' : 'hidden'} data-action="upgradePlugin" data-arg="${manifest.id}" style="cursor: pointer;" title="点击一键更新">有更新</span>
    </div>
    <div>
      <span>端口</span>
      <strong>${port}</strong>
    </div>
    <div>
      <span>安装目录</span>
      <strong title="${installPath}">${shortInstallDir}</strong>
    </div>
    <div>
      <span>组件</span>
      <strong>${componentText}</strong>
    </div>
  `;

  // 3. 异常告警
  const alertEl = document.createElement('div');
  alertEl.className = 'extension-card-alert';
  if (status?.error) {
    alertEl.dataset.level = 'error';
    alertEl.textContent = status.error;
    alertEl.hidden = false;
  } else {
    alertEl.hidden = true;
  }

  // 4. 进度条（部署、启动、更新、卸载全过程动态反馈）
  const progressWrap = document.createElement('div');
  progressWrap.className = 'extension-progress';
  progressWrap.id = `installed-card-progress-${manifest.id}`;
  if (!isTrans) progressWrap.hidden = true;

  let progressMsg = '准备中...';
  if (state === 'uninstalling') progressMsg = '正在停止服务并清理本地安装目录与配置...';
  else if (state === 'updating') progressMsg = '正在拉取最新代码并重新编译构建...';
  else if (state === 'starting') progressMsg = '正在启动服务并校验端口健康检查...';
  else if (state === 'deploying') progressMsg = '正在下载并部署项目依赖...';

  progressWrap.innerHTML = `
    <div class="extension-progress-track">
      <div class="extension-progress-fill" style="width: 100%; animation: progress-indeterminate 1.5s infinite linear;"></div>
    </div>
    <div class="extension-progress-meta">
      <span id="installed-card-progress-text-${manifest.id}">${progressMsg}</span>
      <strong>进行中</strong>
    </div>
  `;

  // 5. 特性标签
  const tags = document.createElement('div');
  tags.className = 'extension-tags';
  tags.innerHTML = `
    <span>兼容 OpenAI 接口</span>
    <span>本地守护进程</span>
    <span>多账号池轮询</span>
    <span>实时健康巡检</span>
  `;

  // 6. 操作按钮栏（与 CPA 完全对齐：由 getPluginActionConfig 统一生成主按钮 + 次按钮组）
  const actions = document.createElement('div');
  actions.className = 'extension-actions';

  const secActions = document.createElement('div');
  secActions.className = 'extension-secondary-actions';

  const actionCfg = getPluginActionConfig(manifest, state, hasUpdate);
  const primaryBtn = makePluginBtn(
    actionCfg.primary.label,
    'btn-primary',
    actionCfg.primary.action || (() => {}),
    Boolean(actionCfg.primary.disabled)
  );
  if (actionCfg.primary.disabled) {
    const spinner = document.createElement('span');
    spinner.className = 'btn-spinner';
    primaryBtn.appendChild(spinner);
  }
  actions.appendChild(primaryBtn);

  (actionCfg.secondary || []).forEach(btn => {
    const el = makePluginBtn(btn.label, `btn-ghost ${btn.cls || 'secondary'}`, btn.action);
    secActions.appendChild(el);
  });
  actions.appendChild(secActions);

  // 7. 访问凭证卡片（完全采用 CPA 规格的 .cpa-credentials 结构）
  const creds = document.createElement('div');
  creds.className = 'cpa-credentials';

  const apiKeyHint = '网页 sessionid 或控制台创建的 jm_... 密钥';

  creds.innerHTML = `
    <div class="cpa-credentials-title">访问凭证 <span class="cpa-credentials-hint">点击即可复制</span></div>

    <div class="cpa-credentials-subtitle">Jimeng API (OpenAI 兼容)</div>
    <div class="cpa-credential-row">
      <span class="cpa-credential-label">API Key</span>
      <code class="cpa-credential-value">${apiKeyHint}</code>
      <button type="button" class="cpa-credential-copy" data-copy-text="${apiKeyHint}">复制</button>
    </div>
    <div class="cpa-credential-row cpa-credential-row-link">
      <span class="cpa-credential-label">API 地址</span>
      <code class="cpa-credential-value">http://127.0.0.1:${port}/v1</code>
      <button type="button" class="cpa-credential-copy" data-copy-url="http://127.0.0.1:${port}/v1">复制</button>
    </div>

    <div class="cpa-credentials-subtitle">Jimeng 管理面板</div>
    <div class="cpa-credential-row">
      <span class="cpa-credential-label">访问模式</span>
      <code class="cpa-credential-value" style="color: var(--success); font-weight: 600;">本地免密直达（点击打开面板直接进入）</code>
    </div>
    <div class="cpa-credential-row cpa-credential-row-link">
      <span class="cpa-credential-label">面板地址</span>
      <code class="cpa-credential-value">http://127.0.0.1:${port}</code>
      <button type="button" class="cpa-credential-copy" data-copy-url="http://127.0.0.1:${port}">复制</button>
    </div>
  `;

  // 复制按钮行内已复制反馈（与 CPA 完全一致，无多余浮动 toast）
  creds.querySelectorAll('.cpa-credential-copy').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const text = btn.dataset.copyUrl || btn.dataset.copyText || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.textContent = '已复制';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = '复制';
        }, 1500);
      });
    };
  });

  const updateBadge = metaGrid.querySelector('[data-action="upgradePlugin"]');
  if (updateBadge) updateBadge.addEventListener('click', () => upgradePlugin(manifest.id));

  card.append(top, metaGrid, alertEl, progressWrap, tags, actions, creds);
  return card;
}

function renderPluginCard(plugin) {
  const { manifest, status } = plugin;
  const meta = pluginStateMeta(status?.state);
  const state = status?.state || 'unknown';
  const installed = ['installed', 'stopped', 'running', 'starting', 'error'].includes(state);

  const row = document.createElement('tr');
  row.className = 'plugin-table-row';
  row.dataset.pluginCard = manifest.id;
  row.dataset.pluginInstalled = String(installed);
  row.dataset.pluginState = state;

  // 1. 插件名称/描述
  const nameTd = document.createElement('td');
  nameTd.className = 'plugin-name-cell';
  const markText = manifest.short || (manifest.id === 'jimeng2api' ? 'JM' : (manifest.name || manifest.id).slice(0, 2).toUpperCase());
  const accent = typeof manifest.accent === 'string' && manifest.accent.startsWith('#') ? manifest.accent : '#2563eb';
  const markBg = `${accent}1f`;
  const markColor = accent;
  nameTd.innerHTML = `
    <div class="plugin-identity-cell">
      <span class="plugin-card-mark" style="background: ${markBg}; color: ${markColor}; font-weight: 800;">${markText}</span>
      <div class="plugin-identity-text">
        <div class="plugin-title-row">
          <strong class="plugin-name">${manifest.name || manifest.id}</strong>
          <span class="plugin-status status-${meta.cls}">${meta.label}</span>
        </div>
        <p class="plugin-desc">${manifest.description || ''}</p>
      </div>
    </div>
  `;

  // 2. 分类
  const catTd = document.createElement('td');
  catTd.className = 'plugin-category-cell';
  const catMap = {
    'api-gateway': 'API 网关',
    'proxy': '代理服务',
    'tool': '辅助工具',
    'database': '数据存储',
    'other': '其它扩展'
  };
  const catLabel = catMap[manifest.category] || manifest.category || 'API 网关';
  catTd.innerHTML = `<span class="plugin-tag">${catLabel}</span>`;

  // 3. 端口
  const portTd = document.createElement('td');
  portTd.className = 'plugin-port-cell';
  if (status?.port) {
    portTd.innerHTML = `<code class="plugin-port-code">:${status.port}</code>`;
  } else {
    portTd.innerHTML = `<span class="text-muted">—</span>`;
  }

  // 4. 版本 / 策略
  const verTd = document.createElement('td');
  verTd.className = 'plugin-version-cell';
  const verStr = status?.version || manifest.version || '1.0.0';
  const stratStr = (manifest.deploy?.strategies || []).join(' / ') || 'binary';
  verTd.innerHTML = `<span>v${verStr} <small class="text-muted">(${stratStr})</small></span>`;

  // 5. 操作按钮
  const actionTd = document.createElement('td');
  actionTd.className = 'plugin-action-cell';
  const actions = document.createElement('div');
  actions.className = 'plugin-table-actions';

  if (!installed || state === 'unknown') {
    if (manifest.homepage) {
      actions.appendChild(
        makePluginBtn('项目主页', 'btn-ghost secondary btn-sm', () => openPluginLink(manifest.homepage))
      );
    }
    actions.appendChild(makePluginBtn('安装', 'btn-primary btn-sm', () => openPluginDeployDialog(manifest.id)));
  } else if (state === 'running' || state === 'starting') {
    actions.appendChild(makePluginBtn('管理', 'btn-primary btn-sm', () => openPluginManager(manifest.id)));
    actions.appendChild(makePluginBtn('停止', 'btn-ghost warn btn-sm', () => stopPlugin(manifest.id)));
    if (manifest.homepage) {
      actions.appendChild(
        makePluginBtn('项目主页', 'btn-ghost secondary btn-sm', () => openPluginLink(manifest.homepage))
      );
    }
    actions.appendChild(makePluginBtn('卸载', 'btn-ghost danger btn-sm', () => uninstallPlugin(manifest.id)));
  } else {
    actions.appendChild(makePluginBtn('启动', 'btn-primary btn-sm', () => startPlugin(manifest.id)));
    actions.appendChild(makePluginBtn('管理', 'btn-ghost accent btn-sm', () => openPluginManager(manifest.id)));
    if (manifest.homepage) {
      actions.appendChild(
        makePluginBtn('项目主页', 'btn-ghost secondary btn-sm', () => openPluginLink(manifest.homepage))
      );
    }
    actions.appendChild(makePluginBtn('卸载', 'btn-ghost danger btn-sm', () => uninstallPlugin(manifest.id)));
  }
  actionTd.appendChild(actions);

  row.append(nameTd, catTd, portTd, verTd, actionTd);

  if (status?.error) {
    const err = document.createElement('div');
    err.className = 'plugin-card-error';
    err.style.marginTop = '4px';
    err.textContent = status.error;
    nameTd.querySelector('.plugin-identity-text')?.appendChild(err);
  }

  return row;
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
  pluginLog('info', `正在启动插件【${pluginId}】...`);
  try {
    pluginNotify(`正在启动 ${pluginId}...`, 'info');
    await pluginInvoke('plugin_start', { pluginId });
    pluginLog('ok', `插件【${pluginId}】启动成功，健康检查通过。`);
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`启动失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginId}】启动失败: ${e}`);
    await refreshPluginList();
  }
}

async function stopPlugin(pluginId) {
  pluginLog('warn', `正在停止插件【${pluginId}】...`);
  try {
    await pluginInvoke('plugin_stop', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginLog('ok', `插件【${pluginId}】已成功停止。`);
    pluginNotify(`${pluginId} 已停止`, 'ok');
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`停止失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginId}】停止失败: ${e}`);
  }
}

async function restartPlugin(pluginId) {
  pluginLog('warn', `正在重启插件【${pluginId}】...`);
  try {
    pluginNotify(`正在重启 ${pluginId}...`, 'info');
    await pluginInvoke('plugin_restart', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginLog('ok', `插件【${pluginId}】重启成功，健康检查通过。`);
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`重启失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginId}】重启失败: ${e}`);
  }
}

function setPluginTransientState(pluginId, state, label) {
  const plugin = getPlugin(pluginId);
  if (plugin) {
    plugin.status = { ...(plugin.status || {}), state, error: null };
  }
}

async function checkPluginUpdate(pluginId, opts = {}) {
  const options = typeof opts === 'boolean' ? { autoUpdate: opts } : (opts || {});
  const silent = Boolean(options.silent);
  const autoUpdate = Boolean(options.autoUpdate);

  const plugin = getPlugin(pluginId);
  const pluginName = plugin?.manifest?.name || pluginId;

  if (globalThis.pluginUpdateChecking?.has(pluginId)) return;
  globalThis.pluginUpdateChecking?.add(pluginId);

  if (!silent) {
    pluginLog('info', `正在检查【${pluginName}】的 GitHub 最新发布包...`);
  }

  const updateBtns = document.querySelectorAll(`[data-action="checkPluginUpdate"][data-arg="${pluginId}"]`);
  updateBtns.forEach(b => { b.disabled = true; b.textContent = '检测中...'; });

  try {
    const report = await pluginInvoke('plugin_check_update', { pluginId });
    globalThis.pluginUpdateReports.set(pluginId, report || null);
    const hasUpdate = Boolean(report?.hasUpdate);

    renderPluginList();

    if (hasUpdate || !silent) {
      pluginLog(hasUpdate ? 'warn' : 'ok', `【${pluginName}】更新检测完成: ${report?.message || (hasUpdate ? '发现新版本' : '已是最新版本')}`);
    }

    if (autoUpdate && hasUpdate) {
      await upgradePlugin(pluginId, { skipConfirm: true });
      return;
    }

    if (!silent) {
      if (!hasUpdate) {
        if (typeof showCustomAlert === 'function') {
          const body = `${pluginName}：${report?.currentVersion || plugin?.manifest?.version || 'v1.2.6'}（已是最新）\n\n检测时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
          showCustomAlert(body, `${pluginName} 更新检测`, 'success');
        } else {
          pluginNotify(`【${pluginName}】已是最新版本`, 'ok');
        }
        return;
      }

      if (typeof showCustomConfirm === 'function') {
        const body = `${pluginName}：当前 ${report.currentVersion || plugin?.manifest?.version || 'v1.2.6'} 更新为 ${report.latestVersion || '最新'}\n\n将停止服务、拉取最新代码并重新编译（服务会短暂中断）。是否立即更新？`;
        const confirmed = await showCustomConfirm(body, `${pluginName} 有新版本`, 'warn');
        if (confirmed) {
          await upgradePlugin(pluginId, { skipConfirm: true });
        }
        return;
      }

      if (typeof showCustomAlert === 'function') {
        const body = `${pluginName}：发现新版本 ${report?.latestVersion}\n\n检测时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
        showCustomAlert(body, `${pluginName} 更新检测`, 'warn');
      }
    }
  } catch (e) {
    const message = String(e?.message || e);
    if (!silent) {
      pluginLog('err', `【${pluginName}】更新检测失败: ${message}`);
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(message, `${pluginName} 更新检测失败`, 'error');
      } else {
        pluginNotify(`检测更新失败: ${message}`, 'error');
      }
    }
  } finally {
    globalThis.pluginUpdateChecking?.delete(pluginId);
    updateBtns.forEach(b => { b.disabled = false; b.textContent = '检测更新'; });
    renderPluginList();
  }
}

async function upgradePlugin(pluginId, opts = {}) {
  const options = typeof opts === 'boolean' ? { skipConfirm: opts } : (opts || {});
  const skipConfirm = Boolean(options.skipConfirm);

  const plugin = getPlugin(pluginId);
  const pluginName = plugin?.manifest?.name || pluginId;

  if (!skipConfirm) {
    const confirmed = typeof showCustomConfirm === 'function'
      ? await showCustomConfirm(
          '检测到新版本，将停止服务、拉取最新代码并重新编译，服务会短暂中断。确定更新？',
          `确认更新 ${pluginName}`,
          'warn'
        )
      : true;
    if (!confirmed) return;
  }

  setPluginTransientState(pluginId, 'updating', '开始更新...');
  pluginLog('warn', `开始更新【${pluginName}】...`);
  renderPluginList();

  try {
    await pluginInvoke('plugin_upgrade', { pluginId });
    globalThis.pluginUpdateReports.delete(pluginId);
    pluginLog('ok', `【${pluginName}】更新完成！`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`${pluginName} 更新完成！`, 'success');
    } else {
      pluginNotify(`${pluginName} 更新完成！`, 'ok');
    }
    await refreshPluginList();
  } catch (e) {
    const message = String(e?.message || e);
    pluginLog('err', `【${pluginName}】更新失败: ${message}`);
    if (typeof showCustomAlert === 'function') {
      showCustomAlert(message, `${pluginName} 更新失败`, 'error');
    } else {
      pluginNotify(`更新失败: ${message}`, 'error');
    }
    await refreshPluginList();
  }
}

async function uninstallPlugin(pluginId) {
  const plugin = getPlugin(pluginId);
  const pluginName = plugin?.manifest?.name || pluginId;
  const ok = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(`确定卸载【${pluginName}】？安装目录与本地数据将被删除，无法恢复。`, '卸载插件', 'warn')
    : window.confirm(`确定卸载【${pluginName}】？`);
  if (!ok) return;

  pluginLog('warn', `正在卸载插件【${pluginName}】...`);

  // 1. 设置卸载中过渡态并重新渲染呈现进度条
  setPluginTransientState(pluginId, 'uninstalling', '卸载中...');
  renderPluginList();

  try {
    await pluginInvoke('plugin_uninstall', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginLog('ok', `插件【${pluginName}】已成功卸载，本地文件与配置已清理。`);
    pluginNotify(`【${pluginName}】已成功卸载`, 'ok');
    closePluginManager();
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`卸载失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginName}】卸载失败: ${e}`);
    await refreshPluginList();
  }
}

async function openPluginConsole(pluginId) {
  const config = await getPluginConfig(pluginId);
  const port = Number(config?.port) || 5566;
  const url = `http://127.0.0.1:${port}`;
  await openPluginLink(url);
}

async function copyPluginText(text, label = '地址') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    pluginNotify(`已复制${label}`, 'ok');
  } catch {
    pluginNotify('复制失败', 'error');
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

  // Strategy selector — only shown when multiple strategies are available
  const stratRow = document.getElementById('plugin-deploy-strategy-row');
  stratRow.replaceChildren();
  let selectedStrategy = null; // null = auto (let Rust walk all strategies with fallback)
  if (strategies.length > 1) {
    const label = document.createElement('label');
    label.className = 'plugin-deploy-strategy-label';
    label.textContent = '部署策略';
    const select = document.createElement('select');
    select.className = 'settings-input';
    // Auto option: let Rust try all strategies with fallback
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '自动（失败降级）';
    select.appendChild(autoOpt);
    for (const s of strategies) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s === 'source' ? '源码编译' : s === 'docker' ? 'Docker 容器' : s;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => { selectedStrategy = select.value || null; });
    stratRow.append(label, select);
  }

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
      const deployArgs = { pluginId };
      if (selectedStrategy) deployArgs.strategy = selectedStrategy;
      await pluginInvoke('plugin_deploy', deployArgs);
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
        const result = await callPluginMethod(pluginId, action.method || action.id, [filePath, action.variant || action.id], needsAuth);
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
  for (const key of ['items', 'data', 'list', 'rows', 'keys']) {
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
  g.filterPluginTable = filterPluginTable;
  g.setPluginStatusFilter = setPluginStatusFilter;
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
  g.setPluginTransientState = setPluginTransientState;
  g.renderInstalledPluginCards = renderInstalledPluginCards;
  g.checkPluginUpdate = checkPluginUpdate;
  g.upgradePlugin = upgradePlugin;
  g.openPluginConsole = openPluginConsole;
  g.copyPluginText = copyPluginText;
  g.openPluginLink = openPluginLink;
})(globalThis);
