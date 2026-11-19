// plugins/deploy-dialog.js — 插件自动化部署向导弹窗、4 阶段进度与日志流
import { pluginRuntime, pluginTokenCache, PLUGIN_STATE_META, pluginInvoke, pluginNotify, pluginLog, getPlugin, getPluginConfig, getPluginToken, pluginStateMeta, getPluginActionConfig } from './shared.js';

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
  initDeploySteps(stepsEl);
  const logEl = document.getElementById('plugin-deploy-log');
  if (logEl) logEl.replaceChildren();
  pluginRuntime.lastDeployLogMessage = '';

  // 重置进度条与文案
  const progressFill = document.getElementById('plugin-deploy-progress-fill');
  const progressPct = document.getElementById('plugin-deploy-progress-percent');
  const progressMsg = document.getElementById('plugin-deploy-progress-message');
  if (progressFill) progressFill.style.width = '0%';
  if (progressPct) progressPct.textContent = '0%';
  if (progressMsg) progressMsg.textContent = '正在准备部署...';

  const confirmView = document.getElementById('plugin-deploy-confirm-view');
  const progressView = document.getElementById('plugin-deploy-progress-view');
  confirmView.style.display = '';
  progressView.style.display = 'none';

  const okBtn = document.getElementById('plugin-deploy-confirm-btn');
  const cancelBtn = document.getElementById('plugin-deploy-cancel-btn');
  const closeBtn = document.getElementById('plugin-deploy-close-btn');
  if (closeBtn) closeBtn.onclick = () => modal.classList.remove('active');
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
    okBtn.innerHTML = loadingHtml('安装中…');
    cancelBtn.textContent = '后台运行';

    try {
      const deployArgs = { pluginId };
      if (selectedStrategy) deployArgs.strategy = selectedStrategy;
      await pluginInvoke('plugin_deploy', deployArgs);
      appendDeployLog(logEl, 'ok', '部署完成，服务已就绪');
      if (stepsEl) {
        stepsEl.querySelectorAll('.plugin-deploy-step').forEach(s => { s.dataset.status = 'done'; });
      }
      if (progressFill) progressFill.style.width = '100%';
      if (progressPct) progressPct.textContent = '100%';
      if (progressMsg) progressMsg.textContent = `${manifest.name || pluginId} 部署完成，准备就绪`;
      pluginNotify(`${manifest.name || pluginId} 部署完成`, 'ok');
      okBtn.disabled = false;
      okBtn.textContent = '完成并启动';
      okBtn.onclick = async () => {
        modal.classList.remove('active');
        await startPlugin(pluginId);
      };
    } catch (e) {
      appendDeployLog(logEl, 'err', String(e));
      if (stepsEl) {
        const running = stepsEl.querySelector('.plugin-deploy-step[data-status="running"]');
        if (running) running.dataset.status = 'error';
      }
      if (progressMsg) progressMsg.textContent = `部署失败: ${e}`;
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

// ── 部署阶段（固定 4 阶段，对齐 CPA，绝不产生零碎胶囊）──
const DEPLOY_STAGES = [
  { id: 'env', label: '环境检测' },
  { id: 'asset', label: '获取组件' },
  { id: 'config', label: '生成配置' },
  { id: 'ready', label: '就绪完成' }
];

function initDeploySteps(stepsEl) {
  if (!stepsEl) return;
  stepsEl.innerHTML = DEPLOY_STAGES.map(s => `
    <div class="plugin-deploy-step" data-stage="${s.id}" data-status="pending">
      <span class="plugin-deploy-step-icon"></span>
      <span class="plugin-deploy-step-label">${s.label}</span>
    </div>
  `).join('');
}

function mapStepToStage(key, title) {
  const sk = String(key || '').toLowerCase();
  const st = String(title || '').toLowerCase();
  if (sk === 'deploy-done' || st.includes('部署完成') || st.includes('完成')) return 'ready';
  if (sk === 'check-environment' || sk === 'port-check' || st.includes('环境') || st.includes('端口')) return 'env';
  if (sk === 'download' || sk === 'fetch' || st.includes('发布包') || st.includes('下载') || st.includes('clone') || st.includes('解压')) return 'asset';
  if (sk === 'config' || sk === 'deploy' || sk === 'add-provider' || st.includes('配置') || st.includes('供应商') || st.includes('编译') || st.includes('依赖') || st.includes('安装')) return 'config';
  return 'config';
}

function updateDeployStage(stepsEl, activeStageId, status) {
  if (!stepsEl) return;
  const stageIds = DEPLOY_STAGES.map(s => s.id);
  const activeIndex = stageIds.indexOf(activeStageId);
  if (activeIndex === -1) return;

  stageIds.forEach((id, idx) => {
    const el = stepsEl.querySelector(`[data-stage="${id}"]`);
    if (!el) return;
    if (idx < activeIndex) {
      el.dataset.status = 'done';
    } else if (idx === activeIndex) {
      if (status === 'error') el.dataset.status = 'error';
      else if (status === 'done' && id === 'ready') el.dataset.status = 'done';
      else el.dataset.status = 'running';
    } else {
      el.dataset.status = 'pending';
    }
  });
}

function appendDeployLog(logEl, level, message) {
  if (!logEl || !message) return;
  const trimmed = String(message).trim();
  if (!trimmed) return;

  // 过滤内部跳过与空跑噪声，保持日志清爽有干货
  if (trimmed.includes('无 shell 命令，跳过')) return;
  if (/^pre-check/i.test(trimmed)) return;

  // 相邻完全相同的信息去重（防止“部署完成”等连刷两次）
  if (trimmed === pluginRuntime.lastDeployLogMessage) return;
  pluginRuntime.lastDeployLogMessage = trimmed;

  const line = document.createElement('div');
  line.className = `plugin-deploy-log-line level-${level}`;
  const time = document.createElement('span');
  time.className = 'plugin-deploy-log-time';
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = trimmed;
  line.append(time, text);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** 根据部署事件估算进度百分比，确保进度条平滑递增 */
function estimateDeployPercent(key, title, status) {
  const sk = String(key || '').toLowerCase();
  const st = String(title || '').toLowerCase();
  if (sk === 'deploy-done' || st.includes('完成')) return 100;
  if (sk === 'add-provider' || st.includes('供应商')) return status === 'done' ? 95 : 90;
  if (sk === 'config' || st.includes('配置')) return status === 'done' ? 88 : 75;
  if (sk === 'download' || st.includes('发布包') || st.includes('下载')) return status === 'done' ? 65 : 45;
  if (sk === 'check-environment' || st.includes('环境')) return status === 'done' ? 25 : 10;
  return null;
}

/** 部署进度事件 → 进度条 + 步骤阶段 + 日志。 */
export function handleDeployProgress(payload) {
  const stepsEl = document.getElementById('plugin-deploy-steps');
  const logEl = document.getElementById('plugin-deploy-log');
  const progressFill = document.getElementById('plugin-deploy-progress-fill');
  const progressPct = document.getElementById('plugin-deploy-progress-percent');
  const progressMsg = document.getElementById('plugin-deploy-progress-message');
  if (!payload) return;

  const key = String(payload.step ?? '');
  const label = payload.title || stepLabelFor(key);

  // 更新进度条：后端给了真实百分比（如下载进度）就以它为准，否则按步骤估算
  const backendPercent = payload.details && typeof payload.details.percent === 'number'
    ? payload.details.percent
    : null;
  const pTarget = backendPercent === null
    ? estimateDeployPercent(key, payload.title, payload.status)
    : backendPercent;
  if (typeof pTarget === 'number' && progressFill && progressPct) {
    const cur = parseInt(progressPct.textContent, 10) || 0;
    const next = Math.max(cur, Math.min(100, pTarget));
    progressFill.style.width = `${next}%`;
    progressPct.textContent = `${next}%`;
  }
  if (progressMsg && (payload.message || label)) {
    // 过滤无意义的内部跳过文案作为主提示
    const cleanMsg = String(payload.message || label).trim();
    if (!cleanMsg.includes('无 shell 命令，跳过') && !/^pre-check/i.test(cleanMsg)) {
      progressMsg.textContent = cleanMsg;
    }
  }

  // 更新固定 4 阶段指示器
  const stage = mapStepToStage(key, payload.title);
  updateDeployStage(stepsEl, stage, payload.status);

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
    download: '获取发布包',
    restore: '恢复数据',
    deploy: '执行部署',
    config: '生成配置',
    'add-provider': '注册供应商',
    'deploy-done': '部署完成',
    fallback: '策略降级',
    'port-check': '端口检查',
  };
  return map[key] || `步骤 ${key}`;
}

// ═══════════════════════════════════════════════════
// PluginPanel（管理面板）
// ═══════════════════════════════════════════════════

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openPluginDeployDialog = openPluginDeployDialog;
  g.closePluginDeployDialog = closePluginDeployDialog;
})(globalThis);
