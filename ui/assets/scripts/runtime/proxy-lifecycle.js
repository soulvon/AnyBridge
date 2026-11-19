// runtime/proxy-lifecycle.js — 接管心跳判断、重启提示、统计心跳与窗口控制
import { fmtNum, forEachElementAlias, setText, setBar, pctOf, escapeHtml } from '../ui/dom.js';
import { addLog, clearLogs, setLogFilter, openLogViewerModal, closeLogViewerModal, closeLogViewerOnEsc, syncLogViewerControls, onLogViewerLevelChange, setLogViewerLevelPreset, onLogViewerSearchInput, onLogViewerLimitChange, onLogViewerOrderChange, onLogViewerAutoScrollChange, logViewerFilteredEntries, renderLogViewerLine, renderLogViewer, exportLogs, nowTs, renderLogLine, renderLogs, scheduleLogRender } from '../state/logs.js';
import { renderProxyOverviewRecentStream } from './proxy-overview.js';

// ─── 接管心跳 ───
// IDE 只在启动时读取 settings.json 里的网关配置，所以「配置已写入(patched)」不等于生效。
// 唯一可靠判据是「网关最近有没有收到该 IDE 的模型请求」，由 sidecar 落盘到
// anybridge-takeover-state.json。以下阈值必须与 Rust proxy.rs 中的同名常量保持一致。
const TAKEOVER_FRESH_WINDOW_MS = 10 * 60 * 1000;
const TAKEOVER_WARMUP_MS = 90 * 1000;
const LABEL_WAIT_REQ = '等待请求';
const LABEL_NO_REQ = '尚无请求';
const LABEL_TODAY_TOTAL = '本日累计';
const LABEL_WAIT_TRAFFIC = '等待流量';

let _statsWasReset = false;
let _lastRecentFp;
let _lastTopModelsFp;

function buildRecentStreamFingerprint(recent) {
  if (!Array.isArray(recent) || recent.length === 0) return 'empty';
  return JSON.stringify(recent.filter(Boolean).slice(0, 6).map((item) => {
    const rawTs = Number(item.ts);
    const tsSec = Number.isFinite(rawTs)
      ? (rawTs > 1e12 ? Math.floor(rawTs / 1000) : Math.floor(rawTs))
      : (item.ts ? Math.floor(Date.parse(item.ts) / 1000) || 0 : 0);
    return [
      item.type || '',
      item.count || 0,
      item.resolvedModel || '',
      item.requestedModel || '',
      item.model || '',
      item.provider || '',
      item.reason || '',
      item.message || '',
      item.durationMs || 0,
      tsSec,
    ];
  }));
}

function buildTopModelsFingerprint(byModel, totalRequests) {
  const entries = Object.entries(byModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return `${totalRequests}|` + entries.map(([m, c]) => `${m}:${c}`).join(',');
}

export async function readTakeoverStateSafe() {
  if (!invoke) return null;
  try {
    return await invoke('get_takeover_state');
  } catch (_) {
    return null; // 读不到时退回旧行为，不阻断主流程
  }
}

export function isTakeoverFresh(state) {
  const last = Number(state && state.lastIdeRequestAt) || 0;
  return last > 0 && (Date.now() - last) <= TAKEOVER_FRESH_WINDOW_MS;
}

export function takeoverWarmupElapsed(state) {
  const started = Number(state && state.proxyStartedAt) || 0;
  return started <= 0 || (Date.now() - started) > TAKEOVER_WARMUP_MS;
}

async function restartIdeNow(target) {
  try {
    const result = await invoke('restart_ide', { target });
    addLog('ok', result);
    return true;
  } catch (e) {
    addLog('err', '重启 IDE 失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
    return false;
  }
}

// 代理/直连切换后，提示并询问是否一键重启 IDE 使其生效。
// 非代理场景（如界面汉化）可通过 options 传入定制标题/状态文案，并用
// skipAutoPreference 跳过「切换网关后自动重启」偏好与代理专属勾选项。
function promptRestartIde(leadText, targetOverride, options = {}) {
  if (!invoke) return Promise.resolve(false);
  const target = targetOverride || activeProxyTarget || getTargetIde();
  const label = ideDisplayLabel(target);
  const mode = options.mode === 'direct' ? 'direct' : 'proxy';
  const lead = leadText || `${label} 网关状态已变更，需重启 IDE 才能生效。`;
  const detail = String(options.detail || '').trim();

  if (!options.skipAutoPreference && shouldAutoRestartIdeAfterSwitch()) {
    addLog('info', `按偏好自动重启 ${label}`);
    return restartIdeNow(target);
  }

  return new Promise((resolve) => {
    const modal = document.getElementById('ide-restart-modal');
    const titleEl = document.getElementById('ide-restart-title');
    const leadEl = document.getElementById('ide-restart-lead');
    const statusEl = document.getElementById('ide-restart-status');
    const detailEl = document.getElementById('ide-restart-detail');
    const autoInput = document.getElementById('ide-restart-auto-checkbox');
    const btnLater = document.getElementById('ide-restart-later-btn');
    const btnNow = document.getElementById('ide-restart-now-btn');

    if (!modal || !btnLater || !btnNow) {
      showCustomConfirm(lead + '\n\n重启会强制关闭 IDE，请先保存所有未保存的工作。', '需要重启 IDE', 'warn')
        .then(async ok => resolve(ok ? await restartIdeNow(target) : false));
      return;
    }

    const isDesktopApp = target === 'claude-desktop' || target === 'claude' || target === 'antigravity';
    const appKind = isDesktopApp ? '客户端' : 'IDE';

    if (titleEl) titleEl.textContent = options.title || `重启 ${label} 以应用${mode === 'direct' ? '直连' : '代理'}`;
    if (leadEl) leadEl.textContent = lead;

    const statusBox = statusEl ? statusEl.closest('.ide-restart-status') : null;
    if (statusBox) {
      // options.statusText === null 时隐藏整个卡片与小圆点，避免留下空框
      if (options.statusText === null) {
        statusBox.style.display = 'none';
        if (statusEl) statusEl.textContent = '';
      } else {
        statusBox.style.display = '';
        if (statusEl) {
          statusEl.textContent = options.statusText || (mode === 'direct'
            ? `已恢复直连配置，重启后 ${appKind} 不再经过 AnyBridge。`
            : `已写入 AnyBridge 网关配置，本地网关服务已启动。`);
        }
      }
    }

    const warningTextEl = modal.querySelector('.modal-warning span:last-child');
    if (warningTextEl) {
      warningTextEl.innerHTML = `重启会<strong>强制关闭</strong> ${appKind}，请先保存所有未保存的工作。`;
    }
    if (detailEl) {
      detailEl.textContent = detail || '';
      detailEl.style.display = detail ? '' : 'none';
    }
    // 非代理场景隐藏代理专属的自动重启勾选项
    if (autoInput) {
      autoInput.checked = false;
      autoInput.closest('.ide-restart-option').style.display = options.skipAutoPreference ? 'none' : '';
    }
    btnLater.disabled = false;
    btnNow.disabled = false;
    btnNow.textContent = '立即重启';

    modal.classList.add('active');

    const cleanup = (result) => {
      modal.classList.remove('active');
      btnLater.removeEventListener('click', onLater);
      btnNow.removeEventListener('click', onNow);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      resolve(result);
    };

    const onLater = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(false);
    };
    const onNow = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rememberAuto = !!autoInput?.checked;
      btnLater.disabled = true;
      setLoading(btnNow, '重启中…');
      try {
        const restarted = await restartIdeNow(target);
        if (restarted && rememberAuto) setAutoRestartIdeAfterSwitch(true);
        cleanup(restarted);
      } finally {
        clearLoading(btnNow);
      }
    };
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onEsc = (e) => { if (e.key === 'Escape' && modal.classList.contains('active')) cleanup(false); };

    btnLater.addEventListener('click', onLater);
    btnNow.addEventListener('click', onNow);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}

function resetStatsUi() {
  if (resetStatsUi._wasReset) return;
  resetStatsUi._wasReset = true;
  _lastRecentFp = undefined;
  _lastTopModelsFp = undefined;
  setText('stat-requests', '—');
  setText('stat-requests-sub', '网关未运行');
  setText('stat-tokens', '—');
  setText('stat-tokens-sub', '输入 / 输出 / 缓存');
  setText('stat-success-rate', '—');
  setText('stat-errors-sub', LABEL_WAIT_REQ);
  setText('stat-provider', '—');
  setText('stat-model', LABEL_NO_REQ);
  setText('stat-rpm', '—');
  setText('stat-tpm', '—');
  setText('stat-latency', '—');
  setText('stat-retries', '—');
  setText('stat-retries-sub', LABEL_TODAY_TOTAL);
  setText('stat-error-rate', '—');
  setText('stat-window-errors', '最近窗口');
  setText('stat-window-requests', '0');
  setText('stat-window-tokens', '0');
  setText('stat-window-errors-count', '0');
  setText('stat-cost', '—');
  setText('proxy-page-requests', '—');
  setText('proxy-page-tokens', '—');
  setText('proxy-page-success-rate', '—');
  setText('proxy-page-latency', '—');
  setText('proxyHeroRequests', '—');
  setText('proxyHeroLatency', '—');
  setText('proxyHeroSuccessRate', '—');
  renderProxyOverviewRecentStream([]);
  setText('stat-health-pill', LABEL_WAIT_TRAFFIC);
  setText('stat-input-tokens', '—');
  setText('stat-output-tokens', '—');
  setText('stat-cached-tokens', '—');
  setText('stat-vision-images', '0');
  setText('stat-vision-api-calls', '0');
  setText('stat-vision-cache-hits', '0');
  setText('stat-vision-failures', '0');
  setText('proxy-page-vision-images', '0');
  setText('proxy-page-vision-api-calls', '0');
  setText('proxy-page-vision-cache-hits', '0');
  setText('proxy-page-vision-failures', '0');
  ['stat-window-requests-bar', 'stat-window-tokens-bar', 'stat-window-errors-bar', 'stat-input-token-bar', 'stat-output-token-bar', 'stat-cached-token-bar'].forEach(id => setBar(id, 0));
  renderTopModels({}, 0);
}

function updateHealthPill(errorRate, latencyMs, windowRequests) {
  const el = document.getElementById('stat-health-pill');
  if (!el) return;
  el.classList.remove('ok', 'warn', 'danger');
  if (!windowRequests) {
    el.textContent = LABEL_WAIT_TRAFFIC;
    return;
  }
  if (errorRate >= 5) {
    el.textContent = '错误偏高';
    el.classList.add('danger');
    return;
  }
  if (errorRate >= 1 || latencyMs >= 8000) {
    el.textContent = '需要关注';
    el.classList.add('warn');
    return;
  }
  el.textContent = '运行正常';
  el.classList.add('ok');
}

function renderProxyStats() {
  return refreshStats();
}

// 把 sidecar stats.recent 里的重试事件接到前端日志面板（R11/T5）。
// refreshStats 每 3s 轮询一次；key 去重防止同一事件重复入账（stats 接口为全量快照而非增量流）。
function consumeRetryLogEvents(recent) {
  const events = Array.isArray(recent) ? recent.filter((e) => e && e.type === 'retry') : [];
  if (!events.length) return;
  const seen = globalThis._retryLogKeys instanceof Set ? globalThis._retryLogKeys : new Set();
  globalThis._retryLogKeys = seen;
  for (const ev of events.slice().reverse()) {
    const key = `${ev.ts}|${ev.count}|${ev.reason}|${ev.provider || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    while (seen.size > 200) seen.delete(seen.values().next().value);
    const who = ev.provider ? `${ev.provider} ` : '';
    addLog('warn', `${who}上游重试 ×${ev.count}：${ev.reason || '未知原因'}`);
  }
}

async function refreshStats() {
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!invoke) return;
  if (_toggling) return;
  if (refreshStats._inFlight) return;
  if (!proxyRunning) {
    resetStatsUi();
    return;
  }
  refreshStats._inFlight = true;
  resetStatsUi._wasReset = false;
  try {
    const s = await invoke('get_stats');
    consumeRetryLogEvents(s.recent);
    const recentFp = buildRecentStreamFingerprint(s.recent);
    if (recentFp !== _lastRecentFp) {
      _lastRecentFp = recentFp;
      renderProxyOverviewRecentStream(s.recent);
    }
    const r = s.rate || {};
    const totalTokens = Number(s.totalTokens) || 0;
    const inputTokens = Number(s.inputTokens) || 0;
    const outputTokens = Number(s.outputTokens) || 0;
    const cachedTokens = Number(s.cachedTokens) || 0;
    const totalTokenParts = Math.max(1, inputTokens + outputTokens + cachedTokens);
    const errors = Number(s.errors) || 0;
    const requests = Number(s.requests) || 0;
    const successRate = requests > 0 ? Math.max(0, 100 - (errors / requests) * 100) : null;
    const windowRequests = Number(r.windowRequests) || 0;
    const windowErrors = Number(r.windowErrors) || 0;
    const windowTokens = (Number(r.tpm) || 0) * 60;
    const errorRate = Number(r.errorRate) || 0;
    const avgLatency = Number(r.avgLatencyMs) || 0;

    setText('stat-requests', fmtNum(s.requests));
    setText('proxy-page-requests', fmtNum(s.requests));
    setText('proxyHeroRequests', fmtNum(s.requests));
    setText('stat-requests-sub', s.requests > 0 ? `运行 ${Math.floor(s.uptimeSec / 60)} 分钟` : LABEL_WAIT_REQ);
    setText('stat-tokens', fmtNum(s.totalTokens));
    setText('proxy-page-tokens', fmtNum(s.totalTokens));
    const _t = (k) => (typeof window !== 'undefined' && typeof window.t === 'function' ? window.t(k) : k);
    const estCost = s.estCostUsd != null ? s.estCostUsd : '0.00';
    const cachedPart = s.cachedTokens ? `  ${_t('缓存')} ${fmtNum(s.cachedTokens)}` : '';
    const approxPrefix = typeof window !== 'undefined' && window.ByokI18n?.language === 'en-US' ? '~' : '约 ';
    setText('stat-tokens-sub', `${_t('输入')} ${fmtNum(s.inputTokens)}  ${_t('输出')} ${fmtNum(s.outputTokens)}${cachedPart}  ${approxPrefix}$${estCost}`);
    const successRateText = successRate == null ? '—' : `${successRate.toFixed(successRate >= 99 ? 1 : 0)}%`;
    setText('stat-success-rate', successRateText);
    setText('proxyHeroSuccessRate', successRateText);
    setText('stat-provider', s.lastProvider || '—');
    setText('stat-model', s.lastModel || LABEL_NO_REQ);
    setText('stat-errors-sub', s.lastError ? `${fmtNum(errors)} 次错误 · 最近: ${s.lastError}` : `${fmtNum(errors)} 次错误`);
    setText('stat-rpm', r.rpm != null ? r.rpm : '—');
    setText('stat-tpm', r.tpm != null ? fmtNum(r.tpm) : '—');
    const latencyText = r.avgLatencyMs != null ? `${r.avgLatencyMs}ms` : '—';
    setText('stat-latency', latencyText);
    setText('proxyHeroLatency', latencyText);
    setText('stat-retries', fmtNum(s.retries || 0));
    setText('stat-retries-sub', s.lastRetryReason ? `最近: ${s.lastRetryReason}` : LABEL_TODAY_TOTAL);
    setText('stat-error-rate', r.errorRate != null ? `${r.errorRate}%` : '—');
    setText('stat-window-errors', `${windowErrors} 个错误`);
    setText('stat-window-requests', fmtNum(windowRequests));
    setText('stat-window-tokens', fmtNum(Math.round(windowTokens)));
    setText('stat-window-errors-count', fmtNum(windowErrors));
    setText('stat-cost', s.estCostUsd != null ? `$${s.estCostUsd}` : '—');
    setText('stat-input-tokens', fmtNum(inputTokens));
    setText('stat-output-tokens', fmtNum(outputTokens));
    setText('stat-cached-tokens', fmtNum(cachedTokens));

    setBar('stat-window-requests-bar', Math.min(100, (windowRequests / 60) * 100));
    setBar('stat-window-tokens-bar', Math.min(100, (windowTokens / 120000) * 100));
    setBar('stat-window-errors-bar', Math.min(100, (windowErrors / Math.max(1, windowRequests)) * 100));
    setBar('stat-input-token-bar', pctOf(inputTokens, totalTokenParts));
    setBar('stat-output-token-bar', pctOf(outputTokens, totalTokenParts));
    setBar('stat-cached-token-bar', pctOf(cachedTokens, totalTokenParts));
    updateHealthPill(errorRate, avgLatency, windowRequests);

    const vision = s.visionFallback || {};
    setText('stat-vision-images', fmtNum(vision.images || 0));
    setText('stat-vision-api-calls', fmtNum(vision.apiCalls || 0));
    setText('stat-vision-cache-hits', fmtNum(vision.cacheHits || 0));
    setText('stat-vision-failures', fmtNum(vision.failures || 0));
    setText('proxy-page-vision-images', fmtNum(vision.images || 0));
    setText('proxy-page-vision-api-calls', fmtNum(vision.apiCalls || 0));
    setText('proxy-page-vision-cache-hits', fmtNum(vision.cacheHits || 0));
    setText('proxy-page-vision-failures', fmtNum(vision.failures || 0));

    const topModelsFp = buildTopModelsFingerprint(s.byModel, requests);
    if (topModelsFp !== _lastTopModelsFp) {
      _lastTopModelsFp = topModelsFp;
      renderTopModels(s.byModel || {}, requests);
    }
    // 更新平台设置里的流量路由信息
    const rp = document.getElementById('route-providers');
    if (rp) {
      const activeCount = typeof providerStore !== 'undefined' && providerStore && providerStore.providers
        ? providerStore.providers.filter(p => p.enabled !== false).length
        : 0;
      rp.textContent = activeCount > 0 ? `${activeCount} 个供应商` : '—';
    }
  } catch (e) {
    // proxy running but stats endpoint not reachable yet — keep last values
  } finally {
    refreshStats._inFlight = false;
  }
}

function renderTopModels(byModel, totalRequests = 0) {
  const container = document.getElementById('topModelsChart');
  if (!container) return;
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (entries.length === 0) {
    container.innerHTML = '<div class="proxy-empty-state">尚无模型请求数据</div>';
    return;
  }
  const maxVal = entries[0][1];
  const colors = ['#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626'];
  let html = '<div class="proxy-model-head"><span>模型</span><span>请求</span><span>占比</span><span>分布</span></div>';
  entries.forEach(([model, count], i) => {
    const pct = Math.max(4, (count / maxVal) * 100);
    const share = totalRequests > 0 ? (count / totalRequests) * 100 : 0;
    const color = colors[i % colors.length];
    html += `<div class="proxy-model-row">
      <span class="proxy-model-name" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
      <strong>${fmtNum(count)}</strong>
      <span>${share ? share.toFixed(1) : '0.0'}%</span>
      <div class="proxy-model-bar"><i style="width:${pct}%;background:${color};"></i></div>
    </div>`;
  });
  container.innerHTML = html;
}

// ═══════ WINDOW CONTROLS ═══════
async function windowMinimize() {
  if (!appWindow) bindTauriBridge();
  if (appWindow) {
    try { await appWindow.minimize(); } catch(e) { _diag('minimize error: ' + e); }
  } else {
    _diag('windowMinimize: appWindow unavailable');
  }
}
async function windowMaximize() {
  if (!appWindow) bindTauriBridge();
  if (appWindow) {
    try { await appWindow.toggleMaximize(); } catch(e) { _diag('maximize error: ' + e); }
  } else {
    _diag('windowMaximize: appWindow unavailable');
  }
}
async function windowClose() {
  // Close request is intercepted by Rust → hides to tray.
  if (!appWindow) bindTauriBridge();
  if (appWindow) {
    try { await appWindow.close(); } catch(e) { _diag('close error: ' + e); }
  } else {
    _diag('windowClose: appWindow unavailable');
  }
}

function bindWindowControlHandlers() {
  const minBtn = document.querySelector('.win-minimize');
  const maxBtn = document.querySelector('.win-maximize');
  const closeBtn = document.querySelector('.win-close');

  const bind = (el, fn, label) => {
    if (!el) { _diag(`WARN: ${label} button not found`); return; }
    if (el.dataset.windowControlBound === '1') return;
    el.dataset.windowControlBound = '1';
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn().catch(err => _diag(`${label} error: ` + err));
    };
    el.addEventListener('click', handler);
    _diag(`${label} handler bound`);
  };
  bind(minBtn, windowMinimize, 'minimize');
  bind(maxBtn, windowMaximize, 'maximize');
  bind(closeBtn, windowClose, 'close');
}

if (typeof document !== 'undefined' && !globalThis._statsVisibilityBound) {
  globalThis._statsVisibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && globalThis.proxyRunning) {
      refreshStats().catch(() => {});
    }
  });
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.restartIdeNow = restartIdeNow;
  g.promptRestartIde = promptRestartIde;
  g.resetStatsUi = resetStatsUi;
  g.updateHealthPill = updateHealthPill;
  g.renderProxyStats = renderProxyStats;
  g.refreshStats = refreshStats;
  g.renderTopModels = renderTopModels;
  g.windowMinimize = windowMinimize;
  g.windowMaximize = windowMaximize;
  g.windowClose = windowClose;
  g.bindWindowControlHandlers = bindWindowControlHandlers;
})(globalThis);
