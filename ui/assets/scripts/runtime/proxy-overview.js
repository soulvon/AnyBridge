// runtime/proxy-overview.js — 本地网关全局状态、快捷代码段与概览页实时控制
import { fmtNum, forEachElementAlias, setText, setBar, pctOf, escapeHtml } from '../ui/dom.js';
import { addLog, clearLogs, setLogFilter, openLogViewerModal, closeLogViewerModal, closeLogViewerOnEsc, syncLogViewerControls, onLogViewerLevelChange, setLogViewerLevelPreset, onLogViewerSearchInput, onLogViewerLimitChange, onLogViewerOrderChange, onLogViewerAutoScrollChange, logViewerFilteredEntries, renderLogViewerLine, renderLogViewer, exportLogs, nowTs, renderLogLine, renderLogs, scheduleLogRender } from '../state/logs.js';

// ═══════ PROXY TOGGLE ═══════
globalThis.proxyRunning = false;
globalThis.activeProxyTarget = '';
globalThis.ideProxyStatusByTarget = {};
globalThis.localProxyKey = '';
globalThis.localProxyPort = 7450;
globalThis.localProxyInferencePort = 7451;
globalThis.IDE_RESTART_AFTER_SWITCH_KEY = 'anybridge.ideRestartAfterSwitch';

function shouldAutoRestartIdeAfterSwitch() {
  try {
    return localStorage.getItem(IDE_RESTART_AFTER_SWITCH_KEY) === 'auto';
  } catch (_) {
    return false;
  }
}

function setAutoRestartIdeAfterSwitch(enabled) {
  try {
    if (enabled) localStorage.setItem(IDE_RESTART_AFTER_SWITCH_KEY, 'auto');
    else localStorage.removeItem(IDE_RESTART_AFTER_SWITCH_KEY);
  } catch (e) {
    addLog('err', '保存 IDE 重启偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
    return false;
  }
  syncIdeRestartPromptSetting();
  return true;
}

function resetIdeRestartPromptPreference() {
  const saved = setAutoRestartIdeAfterSwitch(false);
  if (!saved) return;
  if (typeof showBottomToast === 'function') {
    showBottomToast('已恢复为每次询问是否重启 IDE', 'success');
  }
}

function syncIdeRestartPromptSetting() {
  const auto = shouldAutoRestartIdeAfterSwitch();
  setText('ideRestartPromptMode', auto ? '自动立即重启' : '每次询问');
  document.querySelectorAll('[data-ide-restart-toggle]').forEach(el => {
    setConfigToggleElementState(el, auto);
  });
  forEachElementAlias('ideRestartPromptResetBtn', btn => {
    btn.disabled = !auto;
  });
}

function normalizeIdeProxyTargetValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'devin') return 'devin';
  if (raw === 'windsurf') return 'windsurf';
  if (raw === 'cursor') return 'cursor';
  if (typeof normalizeProxyPlatform === 'function') return normalizeProxyPlatform(raw);
  return 'windsurf';
}

async function resolveIdeProxyTarget(useDetect = false) {
  const selected = typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf';
  if (selected === 'auto' && useDetect && invoke) {
    try {
      const detected = await invoke('detect_target_ide');
      return normalizeIdeProxyTargetValue(detected);
    } catch (e) {
      addLog('warn', '自动检测 IDE 失败，使用 Windsurf: ' + e);
    }
  }
  return normalizeIdeProxyTargetValue(selected);
}

function getLocalProxyPort() {
  return Number(localProxyPort) || 7450;
}

function getLocalProxyInferencePort() {
  return Number(localProxyInferencePort) || 7451;
}

function getLocalProxyKeyValue() {
  return localProxyKey || '';
}

function getLocalProxyDefaultModel(format = 'openai') {
  try {
    if (typeof getProxyRouteDefaultModel === 'function') {
      const routeDefault = getProxyRouteDefaultModel(format);
      if (routeDefault) return routeDefault;
    }
    return '';
  } catch (_) {
    return '';
  }
}

function getLocalProxyModels(format = 'openai') {
  try {
    if (typeof getEnabledProxyRouteModels === 'function') {
      const routeModels = getEnabledProxyRouteModels(format);
      if (routeModels.length) return routeModels;
    }
  } catch (_) {}
  return [getLocalProxyDefaultModel(format)].filter(Boolean);
}

function localProxyOrigin() {
  return `http://127.0.0.1:${getLocalProxyPort()}`;
}

function localProxyBaseUrl(format = 'openai') {
  // Claude Code 与 Anthropic SDK 官方规范：ANTHROPIC_BASE_URL 填服务端点根地址，
  // SDK 会自动追加 /v1/messages，后端已支持路由自适应解析；
  // Gemini 官方 SDK 同样以根地址为 baseUrl。
  if (format === 'anthropic' || format === 'gemini') return localProxyOrigin();
  return `${localProxyOrigin()}/v1`;
}

function localProxyModelsUrl() {
  return `${localProxyBaseUrl('openai')}/models`;
}

function localProxyEndpointParts(format = 'openai') {
  const url = new URL(localProxyBaseUrl(format));
  return { apiHost: url.origin, apiPath: url.pathname };
}

function getLocalProxyRuntimeConfig(platformId = 'codex') {
  const format = platformId === 'claude-code' ? 'anthropic' : 'openai';
  const endpoint = localProxyEndpointParts(format);
  const models = getLocalProxyModels(format);
  const model = getLocalProxyDefaultModel(format) || models[0];
  return {
    id: `anybridge-local-proxy-${platformId}`,
    name: 'AnyBridge 内置供应商',
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath,
    apiKey: getLocalProxyKeyValue(),
    defaultModel: model,
    models,
    sourceProviderId: 'local-proxy',
    sourceProviderName: 'AnyBridge',
    localProxy: true,
    apiFormat: format,
    endpoint: localProxyBaseUrl(format),
  };
}

function generateLocalProxyKeyValue() {
  const bytes = new Uint8Array(18);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'abk-local-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function syncProxyEnhancementSummary() {
  try {
    if (typeof modelMapStore === 'undefined') return;
    const enhancement = modelMapStore.enhancement || {};
    setText('proxyEnhancementRetryState', `重试：${enhancement.retry === false ? '关闭' : '开启'}`);
    setText('proxyEnhancementImageState', `图片理解：${enhancement.imageFallback === false ? '关闭' : '开启'}`);
    setText('proxyEnhancementVisionCount', `图片模型：${modelMapStore.visionModels?.imageModels?.length || 0}`);
  } catch (_) {}
}

function syncLocalProxyUi() {
  setText('globalProxyStatusText', proxyRunning ? '网关运行中' : '网关未启动');
  if (typeof globalThis.updateClaudeDesktopProxyBadge === 'function') {
    globalThis.updateClaudeDesktopProxyBadge(proxyRunning);
  }
  setText('localProxyUnifiedUrl', localProxyOrigin());
  setText('localProxyOpenAiUrl', localProxyBaseUrl('openai'));
  setText('localProxyClaudeUrl', localProxyBaseUrl('anthropic'));
  setText('localProxyGeminiUrl', localProxyBaseUrl('gemini'));
  setText('localProxyModelsUrl', localProxyModelsUrl());
  setText('localProxyKeyValue', localProxyKey || '未生成');
  ['localProxyPortInput', 'settingsProxyPortInput'].forEach(id => {
    forEachElementAlias(id, input => {
      input.value = String(getLocalProxyPort());
    });
  });
  ['localProxyInferencePortInput', 'settingsInferencePortInput'].forEach(id => {
    forEachElementAlias(id, input => {
      input.value = String(getLocalProxyInferencePort());
    });
  });
  forEachElementAlias('route-mitm', el => {
    el.value = `:${getLocalProxyPort()}`;
  });
  forEachElementAlias('route-direct', el => {
    el.value = `:${getLocalProxyInferencePort()}`;
  });
  setText('route-port-desc', `MITM 接入 :${getLocalProxyPort()} / 直连接入 :${getLocalProxyInferencePort()}`);
  syncProxyEnhancementSummary();
  updateProxyPresetSnippet();
}

let currentProxyPresetTab = 'cursor';

function setProxyPresetTab(tab) {
  currentProxyPresetTab = tab || 'cursor';
  document.querySelectorAll('.proxy-preset-tab[data-preset]').forEach(el => {
    el.classList.toggle('active', el.dataset.preset === currentProxyPresetTab);
  });
  updateProxyPresetSnippet();
}

function updateProxyPresetSnippet() {
  const codeEl = document.getElementById('proxyPresetCodeSnippet');
  if (!codeEl) return;
  const origin = localProxyOrigin();
  const key = getLocalProxyKeyValue() || 'abk-local-xxx';
  if (currentProxyPresetTab === 'curl') {
    codeEl.textContent = `curl ${origin}/v1/models -H "Authorization: Bearer ${key}"`;
  } else if (currentProxyPresetTab === 'env') {
    codeEl.textContent = `export OPENAI_BASE_URL="${origin}/v1" OPENAI_API_KEY="${key}"`;
  } else {
    // 默认 cursor / vscode
    codeEl.textContent = `Base URL: ${origin}/v1 | Key: ${key.slice(0, 16)}...`;
  }
}

async function copyQuickPresetSnippet() {
  const origin = localProxyOrigin();
  const key = getLocalProxyKeyValue() || '';
  let content = '';
  let label = '配置';
  if (currentProxyPresetTab === 'curl') {
    content = `curl ${origin}/v1/models -H "Authorization: Bearer ${key}"`;
    label = 'cURL 测试命令';
  } else if (currentProxyPresetTab === 'env') {
    content = `export OPENAI_BASE_URL="${origin}/v1"\nexport OPENAI_API_KEY="${key}"`;
    label = 'Shell 环境变量';
  } else {
    content = JSON.stringify({
      "openai.baseUrl": `${origin}/v1`,
      "openai.apiKey": key
    }, null, 2);
    label = '客户端 JSON 配置';
  }
  await copyTextToClipboard(content, label);
}

function toggleGatewayDrawer(show) {
  const mask = document.getElementById('gatewayDrawerMask');
  if (!mask) return;
  const isVisible = show !== undefined ? Boolean(show) : (mask.style.display !== 'flex');
  mask.style.display = isVisible ? 'flex' : 'none';
}

function setDrawerSubTab(tab) {
  const isTimeline = tab === 'timeline';
  const timelineEl = document.getElementById('gatewayDrawerTimeline');
  const logsEl = document.getElementById('gatewayDrawerLogs');
  const btnTimeline = document.getElementById('drawerTabTimelineBtn');
  const btnLogs = document.getElementById('drawerTabLogsBtn');

  if (timelineEl) timelineEl.style.display = isTimeline ? 'flex' : 'none';
  if (logsEl) logsEl.style.display = isTimeline ? 'none' : 'block';
  if (btnTimeline) btnTimeline.classList.toggle('active', isTimeline);
  if (btnLogs) btnLogs.classList.toggle('active', !isTimeline);
}

export function renderProxyOverviewRecentStream(recentList) {
  const container = document.getElementById('proxyOverviewRecentStream');
  if (!container) return;
  const items = Array.isArray(recentList) ? recentList.filter(Boolean).slice(0, 6) : [];
  if (!items.length) {
    container.innerHTML = '<div class="proxy-live-stream-empty">暂无近期调用记录 · 发起请求后在此实时呈现</div>';
    return;
  }
  container.innerHTML = items.map(item => {
    const isErr = item.type === 'error';
    const isRetry = item.type === 'retry';
    const tagClass = isErr ? 'proxy-tag-err' : (isRetry ? 'proxy-tag-warn' : 'proxy-tag-ok');
    const tagText = isErr ? '错误' : (isRetry ? `重试 ×${item.count || 1}` : '200 OK');
    const model = escapeHtml(item.resolvedModel || item.requestedModel || item.model || '通用请求');
    const sub = isErr
      ? escapeHtml(item.message || '未知错误')
      : (isRetry ? escapeHtml(item.reason || '触发重试') : `上游: ${escapeHtml(item.provider || '默认')}`);
    const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString() : '';
    return `<div class="proxy-live-stream-item">
      <div class="proxy-live-stream-left">
        <span class="proxy-live-stream-tag ${tagClass}">${tagText}</span>
        <div class="proxy-live-stream-meta">
          <div class="proxy-live-stream-model" title="${model}">${model}</div>
          <div class="proxy-live-stream-sub" title="${sub}">${sub}</div>
        </div>
      </div>
      <div class="proxy-live-stream-right">
        <span>${timeStr}</span>
      </div>
    </div>`;
  }).join('');

  // 同步刷新抽屉内最近一条的真实链路数据
  const latest = items[0];
  if (latest) {
    const metaEl = document.getElementById('drawerRecentReqMeta');
    const timeEl = document.getElementById('drawerRecentReqTime');
    const durEl = document.getElementById('drawerRecentReqDuration');
    if (metaEl) {
      metaEl.textContent = `模型: ${latest.resolvedModel || latest.model || 'auto'} · 上游: ${latest.provider || 'default'}`;
    }
    if (timeEl && latest.ts) {
      timeEl.textContent = new Date(latest.ts).toLocaleTimeString();
    }
    if (durEl && latest.durationMs) {
      durEl.textContent = `${latest.durationMs}ms`;
    }
  }
}

function updateGlobalProxyStatusPill(running, tone = '') {
  const pill = document.getElementById('globalProxyStatusPill');
  if (!pill) return;
  pill.classList.remove('running', 'starting', 'error', 'off');
  pill.classList.add(tone || (running ? 'running' : 'off'));
  syncTopbarProxyControls(running, tone);
  syncProxyPageControls(running, tone);
}

export function syncProxyPageControls(running, tone = '') {
  const startBtn = document.getElementById('globalProxyStartBtn');
  const stopBtn = document.getElementById('globalProxyStopBtn');
  const restartBtn = document.getElementById('globalProxyRestartBtn');
  const isBusy = tone === 'starting';
  const isRunning = !!running && !isBusy;

  if (startBtn) {
    startBtn.disabled = isBusy;
    startBtn.classList.remove('btn-ghost');
    startBtn.classList.add('btn-primary');
    startBtn.classList.toggle('is-connected', isRunning);
    if (isRunning) {
      startBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 5px;"><path d="M20 6 9 17l-5-5"/></svg>已启动';
      startBtn.title = '网关运行中';
    } else {
      if (isBusy) {
        startBtn.innerHTML = typeof loadingHtml === 'function' ? loadingHtml('启动中…') : '启动中…';
      } else {
        startBtn.textContent = '启动网关';
      }
      startBtn.title = '启动全局网关服务';
    }
  }
  if (stopBtn) {
    stopBtn.disabled = isBusy || !isRunning;
  }
  if (restartBtn) {
    restartBtn.disabled = isBusy || !isRunning;
  }
}

function syncTopbarProxyControls(running, tone = '') {
  const primary = document.getElementById('topbarProxyPrimaryBtn');
  const primaryText = document.getElementById('topbarProxyPrimaryText');
  const primaryIcon = primary?.querySelector('.topbar-proxy-action-icon');
  const restart = document.getElementById('topbarProxyRestartBtn');
  const isBusy = tone === 'starting';
  const isRunning = !!running && !isBusy;
  if (primary) {
    primary.classList.toggle('running', isRunning);
    primary.disabled = isBusy;
    const label = isBusy ? '处理中' : (isRunning ? '停止网关' : '启动网关');
    primary.title = label;
    primary.setAttribute('aria-label', label);
  }
  if (primaryText) {
    if (isBusy) {
      primaryText.innerHTML = typeof loadingHtml === 'function' ? loadingHtml('处理中…') : '处理中…';
    } else {
      primaryText.textContent = isRunning ? '停止' : '启动';
    }
  }
  if (primaryIcon) {
    primaryIcon.setAttribute('fill', 'currentColor');
    primaryIcon.innerHTML = isRunning
      ? '<path d="M7 6.25A1.25 1.25 0 0 1 8.25 5h7.5A1.25 1.25 0 0 1 17 6.25v11.5A1.25 1.25 0 0 1 15.75 19h-7.5A1.25 1.25 0 0 1 7 17.75V6.25Z"></path>'
      : '<path d="M8 5.6v12.8c0 .7.77 1.13 1.37.76l10.08-6.4a.9.9 0 0 0 0-1.52L9.37 4.84A.9.9 0 0 0 8 5.6Z"></path>';
  }
  if (restart) {
    restart.disabled = isBusy || !isRunning;
  }
}

async function toggleGlobalProxyFromTopbar() {
  if (proxyRunning) return stopGlobalProxyService();
  return startGlobalProxyService();
}

function updateProxyPageState(running, tone = '') {
  const state = document.getElementById('proxyConsoleState');
  const textEl = document.getElementById('proxyPageStateText');
  const subEl = document.getElementById('proxyPageStateSub');
  if (state) {
    state.classList.remove('running', 'starting', 'error');
    if (tone) state.classList.add(tone);
    else if (running) state.classList.add('running');
  }
  if (textEl) textEl.textContent = running ? '网关运行中' : '网关未启动';
  if (subEl) subEl.textContent = running ? '本地入口已启动' : '本地入口等待启动';
}

function syncIdeProxyButton() {
  const target = normalizeIdeProxyTargetValue(typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf');
  const status = ideProxyStatusByTarget[target] || {};
  const patched = !!status.patched;
  const _t = (k, p) => (typeof window.t === 'function' ? window.t(k, p) : k);
  const label = ideDisplayLabel(target);

  // 「停止接入」必须先同步，且不能依赖 proxyBtn 是否存在——
  // 平台控制台页（如 Devin）只有停止按钮、没有一键接入按钮，
  // 原先 `if (!btn) return` 会让这里直接跳过，导致未接入时按钮仍可点，
  // 点了才弹「当前未接入网关」（用户感知为"点不了停止"）。
  const restoreBtn = document.getElementById('proxyRestoreBtn');
  if (restoreBtn) {
    restoreBtn.textContent = _t('停止接入');
    restoreBtn.classList.toggle('is-danger', patched);
    restoreBtn.disabled = !patched;
    restoreBtn.title = patched ? '' : '当前未接入，无需停止';
    restoreBtn.setAttribute(
      'aria-label',
      patched ? _t(`停止 ${label} 接入 AnyBridge`) : `${label} ${_t('当前未接入')}`
    );
  }

  const btn = document.getElementById('proxyBtn');
  if (!btn) return;
  const icon = btn.querySelector('.proxy-btn-icon');
  const text = btn.querySelector('.proxy-btn-text');
  const stateText = btn.querySelector('[data-proxy-state-text]');
  btn.classList.remove('running', 'warning', 'is-connected');
  if (patched) {
    btn.classList.add('is-connected');
    if (icon) {
      icon.innerHTML = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    if (text) text.textContent = _t('已接入');
    if (stateText) stateText.textContent = proxyRunning ? _t('网关运行中') : _t('网关未运行');
    btn.setAttribute('aria-label', `${label} ${_t('已接入')}`);
    return;
  }
  if (icon) {
    icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"/>';
  }
  if (text) text.textContent = _t('一键接入');
  if (stateText) stateText.textContent = _t('未接入');
  btn.setAttribute('aria-label', `${label} ${_t('一键接入')}`);
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.shouldAutoRestartIdeAfterSwitch = shouldAutoRestartIdeAfterSwitch;
  g.setAutoRestartIdeAfterSwitch = setAutoRestartIdeAfterSwitch;
  g.resetIdeRestartPromptPreference = resetIdeRestartPromptPreference;
  g.syncIdeRestartPromptSetting = syncIdeRestartPromptSetting;
  g.normalizeIdeProxyTargetValue = normalizeIdeProxyTargetValue;
  g.resolveIdeProxyTarget = resolveIdeProxyTarget;
  g.getLocalProxyPort = getLocalProxyPort;
  g.getLocalProxyInferencePort = getLocalProxyInferencePort;
  g.getLocalProxyKeyValue = getLocalProxyKeyValue;
  g.getLocalProxyDefaultModel = getLocalProxyDefaultModel;
  g.getLocalProxyModels = getLocalProxyModels;
  g.localProxyOrigin = localProxyOrigin;
  g.localProxyBaseUrl = localProxyBaseUrl;
  g.localProxyModelsUrl = localProxyModelsUrl;
  g.localProxyEndpointParts = localProxyEndpointParts;
  g.getLocalProxyRuntimeConfig = getLocalProxyRuntimeConfig;
  g.generateLocalProxyKeyValue = generateLocalProxyKeyValue;
  g.syncProxyEnhancementSummary = syncProxyEnhancementSummary;
  g.syncLocalProxyUi = syncLocalProxyUi;
  g.setProxyPresetTab = setProxyPresetTab;
  g.copyQuickPresetSnippet = copyQuickPresetSnippet;
  g.toggleGatewayDrawer = toggleGatewayDrawer;
  g.setDrawerSubTab = setDrawerSubTab;
  g.updateGlobalProxyStatusPill = updateGlobalProxyStatusPill;
  g.syncTopbarProxyControls = syncTopbarProxyControls;
  g.toggleGlobalProxyFromTopbar = toggleGlobalProxyFromTopbar;
  g.updateProxyPageState = updateProxyPageState;
  g.syncIdeProxyButton = syncIdeProxyButton;
})(globalThis);
