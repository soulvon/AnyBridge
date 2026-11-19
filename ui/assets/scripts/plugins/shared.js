// plugins/shared.js — 插件注册表共享状态、IPC/通知/日志封装与状态过滤器

// ── 状态 ──
globalThis.pluginRegistry = [];              // [{ manifest, status }]
globalThis.activePluginId = '';              // 当前管理面板打开的插件
globalThis.activePluginPanelId = '';         // 当前选中的 tab
export const pluginTokenCache = new Map();
export const pluginRuntime = {
  pluginStatusUnlisten: null,
  pluginDeployUnlisten: null,
  pluginLogTimer: null,
  lastRecordedPluginCount: null,
  currentPluginStatusFilter: 'all',
  lastDeployLogMessage: '',
};

export function pluginInvoke(cmd, args) {
  return invoke(cmd, args);
}

export function pluginNotify(message, type = 'info') {
  if (typeof extensionNotify === 'function') extensionNotify(message, type);
  else if (typeof showNotification === 'function') showNotification(message, type);
}

export function pluginLog(level, message) {
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

async function refreshPluginList(options = {}) {
  const manual = Boolean(options && options.manual);
  if (manual) {
    pluginLog('info', '正在重新扫描并刷新插件列表...');
  }
  try {
    const plugins = await pluginInvoke('plugin_list');
    globalThis.pluginRegistry = Array.isArray(plugins) ? plugins : [];
    const count = globalThis.pluginRegistry.length;
    const isInitial = pluginRuntime.lastRecordedPluginCount === null;
    if (manual || isInitial || count !== pluginRuntime.lastRecordedPluginCount) {
      pluginRuntime.lastRecordedPluginCount = count;
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

export function getPlugin(pluginId) {
  return globalThis.pluginRegistry.find((p) => p.manifest?.id === pluginId) || null;
}

export async function getPluginConfig(pluginId) {
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
export async function getPluginToken(pluginId, force = false) {
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

export const PLUGIN_STATE_META = {
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

export function pluginStateMeta(state) {
  return PLUGIN_STATE_META[state] || PLUGIN_STATE_META.unknown;
}

function setPluginStatusFilter(filter) {
  pluginRuntime.currentPluginStatusFilter = filter || 'all';
  document.querySelectorAll('[data-plugin-filter]').forEach(btn => {
    const isActive = btn.dataset.pluginFilter === pluginRuntime.currentPluginStatusFilter;
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
    if (pluginRuntime.currentPluginStatusFilter === 'installed') {
      matchesFilter = isInstalled;
    } else if (pluginRuntime.currentPluginStatusFilter === 'not-installed') {
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

export function getPluginActionConfig(manifest, state, hasUpdate) {
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

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openPluginLink = openPluginLink;
  g.refreshPluginList = refreshPluginList;
  g.callPluginMethod = callPluginMethod;
  g.setPluginStatusFilter = setPluginStatusFilter;
  g.filterPluginTable = filterPluginTable;
  g.renderPluginList = renderPluginList;
})(globalThis);
