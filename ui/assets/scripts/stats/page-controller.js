// stats/page-controller.js — 统计页控制、筛选、设置与加载调度
import { statsChartState, STATS_STATE, BYPASS_SOURCE_META, STATS_SOURCES, escapeText, fmtNum, fmtCost, fmtMetric, dayKeyLocal, recentDayKeys, rangeDays, historyDaysToFetch, sourceLabel, discoveredSources, localBucketOf, buildDaySeries, splitRanges, sumSeries } from './shared.js';
import { renderEchartSpark, renderDeltaPill, renderTokenLegend, renderStatsKpi, buildTodayHourlySeries, showChartEmptyState, renderEchartsMainChart } from './charts.js';
import { collectRankRows, renderStatsRankTable, renderStatsSourcesDeck, buildFullYearDayMap, renderTokenHeatmap, renderStatsRecentTable } from './tables-and-heatmap.js';

function renderSourceControls() {
  const host = document.getElementById('statsSourceFilters');
  if (host) {
    const ids = ['all', ...discoveredSources()];
    // 选中的来源已经不存在（卸载/清空）时回退到「全部来源」
    if (STATS_STATE.sourceFilter !== 'all' && !ids.includes(STATS_STATE.sourceFilter)) {
      STATS_STATE.sourceFilter = 'all';
    }
    host.innerHTML = ids.map((id) => {
      const active = id === STATS_STATE.sourceFilter;
      const label = id === 'all' ? '全部来源' : sourceLabel(id);
      return `<button type="button" class="ez-pill-btn${active ? ' active' : ''}" data-stats-source-filter="${escapeText(id)}" role="tab" aria-selected="${active}">${escapeText(label)}</button>`;
    }).join('');
  }

  // 排行里的 CPA 账号 tab：没有账号就不出现
  const accountTab = document.querySelector('#page-stats [data-stats-rank="account"]');
  if (accountTab) {
    const hasAccounts = (STATS_STATE.local?.cpaAccounts || []).length > 0;
    accountTab.hidden = !hasAccounts;
    if (!hasAccounts && accountTab.classList.contains('active')) {
      accountTab.classList.remove('active');
      accountTab.setAttribute('aria-selected', 'false');
      STATS_STATE.rank = 'model';
      const modelTab = document.querySelector('#page-stats [data-stats-rank="model"]');
      if (modelTab) {
        modelTab.classList.add('active');
        modelTab.setAttribute('aria-selected', 'true');
      }
    }
  }
}

// ── 采集设置：来源开关 ──
function renderStatsSettings() {
  const host = document.getElementById('statsSettingsBody');
  if (!host) return;
  const available = STATS_STATE.settings.availableSources || [];
  const disabled = STATS_STATE.settings.disabledSources || [];

  if (!available.length) {
    host.innerHTML = '<div class="ez-setting-empty">本机未发现可采集的客户端</div>';
    return;
  }

  host.innerHTML = available.map((id) => {
    const meta = BYPASS_SOURCE_META[id] || { label: id, hint: '' };
    const enabled = !disabled.includes(id);
    return `<div class="ez-setting-row">
      <span class="ez-setting-name">${escapeText(meta.label)}</span>
      <span class="ez-setting-hint">${escapeText(meta.hint)}</span>
      <div class="toggle-sm${enabled ? ' on' : ''}" role="switch" tabindex="0" aria-checked="${enabled}"
           aria-label="${escapeText(meta.label)} 采集开关" data-stats-source-toggle="${escapeText(id)}"></div>
    </div>`;
  }).join('');
}

function setStatsSettingsOpen(open) {
  const panel = document.getElementById('statsSettingsPanel');
  const btn = document.getElementById('statsSettingsBtn');
  if (!panel || !btn) return;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) renderStatsSettings();
}

/** 切换单个来源的采集开关：先落盘，再重扫，最后整页重算。 */
async function toggleSourceCollection(id) {
  const current = new Set(STATS_STATE.settings.disabledSources || []);
  if (current.has(id)) current.delete(id);
  else current.add(id);

  // 乐观更新，失败再回滚
  const optimistic = [...current];
  STATS_STATE.settings.disabledSources = optimistic;
  renderStatsSettings();

  try {
    STATS_STATE.settings = await invoke('set_stats_settings', { disabledSources: optimistic });
    const fresh = await invoke('scan_local_usage').catch(() => null);
    if (fresh) STATS_STATE.local = fresh;
    renderStatsSettings();
    renderStatsAll();
  } catch (e) {
    console.error('[AnyBridge Stats] 保存采集设置失败:', e);
    // 回滚到服务端真实状态，不留下与服务端不符的 UI
    try {
      STATS_STATE.settings = await invoke('get_stats_settings');
    } catch {
      STATS_STATE.settings.disabledSources = [];
    }
    renderStatsSettings();
    const panel = document.getElementById('statsSettingsPanel');
    if (panel) {
      const foot = panel.querySelector('.ez-popover-foot');
      if (foot) foot.textContent = `保存失败：${e?.message || e}`;
    }
  }
}

// ── 全量同步 ──
// 逐块渲染：任何一块抛错只降级该块并留下可见错误，不再让整页停在占位文案。
// （教训：ECharts formatter 引用未定义函数会让 renderStatsAll 从中间中断，
//  表现为 KPI 有值、图表空白、其余面板一句「正在检查…」永不消失。）
function renderStatsAll() {
  // 先校正来源控件（可能把失效的选中项回退为「全部」），再据此取数
  renderSourceControls();
  const series = buildDaySeries();

  const panels = [
    ['KPI', () => renderStatsKpi(series)],
    ['主图表', () => renderEchartsMainChart(series)],
    ['排行', () => renderStatsRankTable(series)],
    ['数据源', () => renderStatsSourcesDeck()],
    ['热力图', () => renderTokenHeatmap()],
    ['最近请求', () => renderStatsRecentTable()],
  ];

  for (const [name, render] of panels) {
    try {
      render();
    } catch (e) {
      console.error(`[AnyBridge Stats] ${name} 渲染失败:`, e);
      panicPanel(name, e);
    }
  }

  // 若图表容器有实例，延迟一帧确保 layout 稳定后再次 resize
  setTimeout(() => {
    if (statsChartState.mainInstance && typeof statsChartState.mainInstance.resize === 'function') {
      statsChartState.mainInstance.resize();
    }
  }, 100);
}

/** 把失败落到对应面板上，避免「一句话永远转圈」这种假加载态。 */
function panicPanel(name, error) {
  const target = {
    KPI: null,
    主图表: 'mainTrendEcharts',
    排行: 'statsRankTable',
    数据源: 'statsSourcesDeck',
    热力图: 'statsTokenHeatmap',
    最近请求: 'statsRecentTbody',
  }[name];
  if (!target) return;
  const el = document.getElementById(target);
  if (!el) return;
  el.innerHTML = `<div class="ez-empty-state">${name}渲染失败：${escapeText(error?.message || error)}</div>`;
}

/** 首屏加载失败：骨架必须被替换成错误，绝不能让骨架一直转下去。 */
function showStatsFailure(error) {
  const message = escapeText(error?.message || error);
  const panels = {
    mainTrendEcharts: `<div class="ez-empty-state">统计加载失败：${message}</div>`,
    statsRankTable: `<div class="ez-empty-state">统计加载失败：${message}</div>`,
    statsSourcesDeck: `<div class="ez-empty-state">统计加载失败：${message}</div>`,
    statsTokenHeatmap: `<div class="ez-empty-state">统计加载失败：${message}</div>`,
  };
  for (const [id, html] of Object.entries(panels)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  const tbody = document.getElementById('statsRecentTbody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="5" class="ez-empty-state">统计加载失败：${message}</td></tr>`;
  }
}

function localUsageSummaryFp(local) {
  if (!local || typeof local !== 'object') return 'none';
  const sources = local.sources && typeof local.sources === 'object'
    ? Object.keys(local.sources).sort().map((k) => {
        const u = local.sources[k] || {};
        return `${k}:${Number(u.requests) || 0}:${Number(u.input) || 0}:${Number(u.output) || 0}:${Number(u.cache_read) || 0}:${Number(u.cache_write) || 0}`;
      }).join(';')
    : '';
  const accLen = Array.isArray(local.cpaAccounts) ? local.cpaAccounts.length : 0;
  const dayCounts = ['days', 'cursorDays', 'cpaDays', 'piDays', 'zcodeDays']
    .map((b) => (local[b] && typeof local[b] === 'object' ? Object.keys(local[b]).length : 0))
    .join(',');
  return `${sources}|acc:${accLen}|days:${dayCounts}`;
}

function computeStatsFingerprint() {
  const gw = STATS_STATE.gateway;
  const gwFp = gw
    ? `${Number(gw.requests) || 0}:${Number(gw.totalTokens) || 0}:${Number(gw.errors) || 0}:${Array.isArray(gw.recent) ? gw.recent.length : 0}`
    : 'null';
  const histLen = Array.isArray(STATS_STATE.history) ? STATS_STATE.history.length : 0;
  return `${STATS_STATE.range}|${STATS_STATE.sourceFilter}|${gwFp}|h:${histLen}|${localUsageSummaryFp(STATS_STATE.local)}`;
}

async function loadStats({ silent = false } = {}) {
  if (STATS_STATE.loading) return;
  STATS_STATE.loading = true;
  const btn = document.getElementById('statsRefreshBtn');
  if (btn) btn.classList.add('is-busy');

  // 只有「还没有任何数据」时才上骨架；刷新时保留旧内容，避免闪一下变空再填回
  const page = document.getElementById('page-stats');
  const firstLoad = !STATS_STATE.gateway && STATS_STATE.history.length === 0;
  if (firstLoad) page?.classList.add('stats-loading');

  try {
    if (typeof invoke !== 'function') throw new Error('Tauri bridge 未就绪');
    const [gateway, history, local, settings] = await Promise.all([
      invoke('get_stats').catch(() => null),
      invoke('get_stats_history', { days: historyDaysToFetch() }).catch(() => ({ days: [] })),
      invoke('get_local_usage').catch(() => null),
      invoke('get_stats_settings').catch(() => null),
    ]);
    STATS_STATE.gateway = gateway;
    STATS_STATE.history = Array.isArray(history?.days) ? history.days : [];
    STATS_STATE.local = local;
    if (settings) STATS_STATE.settings = settings;
    const beforeScanFp = computeStatsFingerprint();
    renderStatsAll();

    invoke('scan_local_usage').then((fresh) => {
      if (!fresh) return;
      STATS_STATE.local = fresh;
      if (computeStatsFingerprint() === beforeScanFp) return;
      renderStatsAll();
    }).catch(() => {});
  } catch (e) {
    console.error('统计加载失败', e);
    if (firstLoad) showStatsFailure(e);
  } finally {
    page?.classList.remove('stats-loading');
    STATS_STATE.loading = false;
    if (btn) btn.classList.remove('is-busy');
  }
}

function bindSeg(selector, attr, onChange) {
  const host = document.querySelector(selector);
  if (!host || host.dataset.bound) return;
  host.dataset.bound = '1';
  host.addEventListener('click', (event) => {
    const btn = event.target.closest(`[${attr}]`);
    if (!btn) return;
    const value = btn.getAttribute(attr);
    host.querySelectorAll(`[${attr}]`).forEach((el) => {
      const active = el === btn;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    });
    onChange(value);
  });
}

function bindStatsPage() {
  bindSeg('#page-stats .ez-pill-nav[aria-label="统计周期"]', 'data-stats-range', (value) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next === STATS_STATE.range) return;
    STATS_STATE.range = next;
    loadStats();
  });

  bindSeg('#page-stats .ez-pill-nav[aria-label="数据来源"]', 'data-stats-source-filter', (value) => {
    STATS_STATE.sourceFilter = value;
    renderStatsAll();
  });

  bindSeg('#page-stats .ez-pill-nav[aria-label="图表指标"]', 'data-stats-metric', (value) => {
    STATS_STATE.metric = value;
    renderEchartsMainChart(buildDaySeries());
  });

  bindSeg('#page-stats .ez-pill-nav[aria-label="排行视图"]', 'data-stats-rank', (value) => {
    STATS_STATE.rank = value;
    renderStatsRankTable(buildDaySeries());
  });

  const refresh = document.getElementById('statsRefreshBtn');
  if (refresh && !refresh.dataset.bound) {
    refresh.dataset.bound = '1';
    refresh.addEventListener('click', () => loadStats());
  }

  // 采集设置：齿轮开合 / 关闭 / 点外部收起 / 开关点击与键盘操作
  const settingsBtn = document.getElementById('statsSettingsBtn');
  const settingsPanel = document.getElementById('statsSettingsPanel');
  const settingsClose = document.getElementById('statsSettingsClose');

  if (settingsBtn && !settingsBtn.dataset.bound) {
    settingsBtn.dataset.bound = '1';
    settingsBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      setStatsSettingsOpen(settingsPanel?.hidden !== false);
    });
  }

  if (settingsClose && !settingsClose.dataset.bound) {
    settingsClose.dataset.bound = '1';
    settingsClose.addEventListener('click', () => setStatsSettingsOpen(false));
  }

  if (settingsPanel && !settingsPanel.dataset.bound) {
    settingsPanel.dataset.bound = '1';
    settingsPanel.addEventListener('click', (event) => {
      // 面板内点击不冒泡到 document，避免刚开就被判为「点外部」收起
      event.stopPropagation();
      const toggle = event.target.closest('[data-stats-source-toggle]');
      if (toggle) toggleSourceCollection(toggle.getAttribute('data-stats-source-toggle'));
    });
    settingsPanel.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const toggle = event.target.closest('[data-stats-source-toggle]');
      if (!toggle) return;
      event.preventDefault();
      toggleSourceCollection(toggle.getAttribute('data-stats-source-toggle'));
    });
  }

  if (!document.body.dataset.statsSettingsBound) {
    document.body.dataset.statsSettingsBound = '1';
    document.addEventListener('click', () => setStatsSettingsOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setStatsSettingsOpen(false);
    });
  }

  document.querySelectorAll('[data-page="stats"]').forEach((tab) => {
    if (tab.dataset.statsBound) return;
    tab.dataset.statsBound = '1';
    tab.addEventListener('click', () => setTimeout(() => loadStats({ silent: true }), 60));
  });
}

function initStatsPage() {
  if (!document.getElementById('page-stats')) return;
  bindStatsPage();
  // 仅当 Tauri bridge 已就绪时立即预热统计数据；首屏冷启阶段由 90-init.js 在 ensureTauriBridge() 后触发
  if (typeof globalThis.invoke === 'function') {
    loadStats({ silent: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStatsPage, { once: true });
} else {
  initStatsPage();
}

globalThis.loadStats = loadStats;
globalThis.initStatsPage = initStatsPage;
