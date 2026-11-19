// plugins/cards.js — 已安装插件卡片与扩展市场卡片渲染
import { pluginRuntime, pluginTokenCache, PLUGIN_STATE_META, pluginInvoke, pluginNotify, pluginLog, getPlugin, getPluginConfig, getPluginToken, pluginStateMeta, getPluginActionConfig } from './shared.js';

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
    <div class="extension-top-side">
      <span class="extension-status status-${meta.cls}" id="installed-card-status-${manifest.id}">${meta.label}</span>
    </div>
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
    // 与 CPA 卡片同一实现：加载态统一由 loadingHtml 提供 spinner，禁止另造一个
    primaryBtn.innerHTML = loadingHtml(actionCfg.primary.label);
  }
  actions.appendChild(primaryBtn);

  (actionCfg.secondary || []).forEach(btn => {
    const el = makePluginBtn(btn.label, `btn-ghost ${btn.cls || 'secondary'}`, btn.action);
    secActions.appendChild(el);
  });
  actions.appendChild(secActions);

  // 7. 访问凭证卡片（完全采用 CPA 规格的 .cpa-credentials 结构）
  //    插件可在 manifest.credentials 里自描述：[{ subtitle, rows: [{ label, value, copy }] }]，
  //    value 支持 {port} 与 {config.<key>} 占位符；未声明时回落到 Jimeng 的历史文案。
  const creds = document.createElement('div');
  creds.className = 'cpa-credentials';

  const escCred = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fillCred = (s) => escCred(String(s ?? ''))
    .replaceAll('{port}', port)
    .replace(/\{config\.(\w+)\}/g, (_, k) => escCred(config?.[k] ?? ''));

  if (Array.isArray(manifest.credentials) && manifest.credentials.length) {
    let html = `<div class="cpa-credentials-title">访问凭证 <span class="cpa-credentials-hint">点击即可复制</span></div>`;
    for (const grp of manifest.credentials) {
      html += `<div class="cpa-credentials-subtitle">${fillCred(grp.subtitle)}</div>`;
      for (const row of grp.rows || []) {
        const val = fillCred(row.value ?? '');
        const copyBtn = row.copy
          ? `<button type="button" class="cpa-credential-copy" data-copy-url="${val}" title="复制">复制</button>`
          : '';
        html += `<div class="cpa-credential-row${row.copy ? ' cpa-credential-row-link' : ''}">` +
          `<span class="cpa-credential-label">${escCred(row.label ?? '')}</span>` +
          `<code class="cpa-credential-value">${val}</code>${copyBtn}</div>`;
      }
    }
    creds.innerHTML = html;
  } else {
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
  }

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

  // 8. 详情折叠：默认精简（凭证区收起），展开偏好按插件记忆
  const foldKey = `anybridge.pluginCard.${manifest.id}.expanded`;
  let credsExpanded = false;
  try { credsExpanded = localStorage.getItem(foldKey) === '1'; } catch (_) {}
  creds.hidden = !credsExpanded;

  const foldBtn = document.createElement('button');
  foldBtn.type = 'button';
  foldBtn.className = 'extension-fold-btn' + (credsExpanded ? ' is-open' : '');
  foldBtn.title = credsExpanded ? '收起详情' : '展开详情';
  foldBtn.setAttribute('aria-label', foldBtn.title);
  foldBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  foldBtn.onclick = () => {
    const open = creds.hidden;
    creds.hidden = !open;
    foldBtn.classList.toggle('is-open', open);
    foldBtn.title = open ? '收起详情' : '展开详情';
    foldBtn.setAttribute('aria-label', foldBtn.title);
    try { localStorage.setItem(foldKey, open ? '1' : '0'); } catch (_) {}
  };
  top.querySelector('.extension-top-side')?.appendChild(foldBtn);

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
  const hasBrandAccent = typeof manifest.accent === 'string' && manifest.accent.startsWith('#');
  const markBg = hasBrandAccent ? `${manifest.accent}1f` : 'rgba(var(--accent-rgb), 0.12)';
  const markColor = hasBrandAccent ? manifest.accent : 'var(--accent)';
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
    'proxy': '网关服务',
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

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.renderInstalledPluginCards = renderInstalledPluginCards;
  g.renderInstalledPluginCard = renderInstalledPluginCard;
  g.renderPluginCard = renderPluginCard;
})(globalThis);
