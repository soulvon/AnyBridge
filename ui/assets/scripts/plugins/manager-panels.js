// plugins/manager-panels.js — 插件管理弹窗面板（概览/数据表/日志/schema配置）与系统初始化
import { pluginRuntime, pluginTokenCache, PLUGIN_STATE_META, pluginInvoke, pluginNotify, pluginLog, getPlugin, getPluginConfig, getPluginToken, pluginStateMeta, getPluginActionConfig } from './shared.js';
import { handleDeployProgress } from './deploy-dialog.js';

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
  if (pluginRuntime.pluginLogTimer) {
    clearInterval(pluginRuntime.pluginLogTimer);
    pluginRuntime.pluginLogTimer = null;
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

  if (pluginRuntime.pluginLogTimer) {
    clearInterval(pluginRuntime.pluginLogTimer);
    pluginRuntime.pluginLogTimer = null;
  }

  const body = document.getElementById('plugin-manager-body');
  body.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'plugin-panel-loading';
  loading.innerHTML = loadingHtml('加载中…');
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
    if (pluginRuntime.pluginLogTimer) {
      clearInterval(pluginRuntime.pluginLogTimer);
      pluginRuntime.pluginLogTimer = null;
      autoBtn.textContent = '自动刷新：关';
    } else {
      pluginRuntime.pluginLogTimer = setInterval(load, 3000);
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
    if (!pluginRuntime.pluginDeployUnlisten) {
      pluginRuntime.pluginDeployUnlisten = await tauriEvent.listen('plugin-deploy-progress', (e) => {
        handleDeployProgress(e.payload);
      });
    }
    if (!pluginRuntime.pluginStatusUnlisten) {
      pluginRuntime.pluginStatusUnlisten = await tauriEvent.listen('plugin-status-changed', async (e) => {
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

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openPluginManager = openPluginManager;
  g.closePluginManager = closePluginManager;
  g.selectPluginPanel = selectPluginPanel;
  g.initPluginSystem = initPluginSystem;
})(globalThis);
