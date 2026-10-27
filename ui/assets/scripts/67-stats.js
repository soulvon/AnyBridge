/**
 * 67-stats.js — 统计页渲染。
 *
 * 数据来源（两本账，不合并）：
 *   1. 网关账本：get_stats（今日实时）+ get_stats_history（stats.json 按天）
 *   2. 旁路账本：get_local_usage（Claude Code / Cursor / CPA）
 *
 * 口径：
 *   - 请求数 / Token：两本账相加
 *   - 费用 / 成功率：只算网关（旁路没有价格与错误契约），在副标题注明
 *   - 账号 / 来源排行：旁路侧为累计值（后端按天×模型聚合，无账号×天维度），标注「累计」
 */

const STATS_STATE = {
  // 默认近 7 天：避免早上打开时「今日」还没流量，整页看起来是空的。
  range: 7,            // 1 / 7 / 30 / 0=全部
  metric: 'tokens',    // tokens / requests / cost
  rank: 'model',       // model / account / source
  loading: false,
  gateway: null,
  history: [],
  local: null,
};

const STATS_METRIC_LABEL = {
  tokens: { title: 'Token', line: '请求数', unit: '' },
  requests: { title: '请求数', line: 'Token', unit: '' },
  cost: { title: '费用', line: '请求数', unit: '$' },
};

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1) + 'B';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + 'K';
  return String(Math.round(v));
}

function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'K';
  return '$' + v.toFixed(2);
}

function fmtMetric(value, metric) {
  return metric === 'cost' ? fmtCost(value) : fmtNum(value);
}

function dayKeyLocal(d) {
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function recentDayKeys(count) {
  const out = [];
  const today = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push(dayKeyLocal(d));
  }
  return out;
}

function rangeDays() {
  return STATS_STATE.range === 0 ? 366 : STATS_STATE.range;
}

function historyDaysToFetch() {
  // 多取一倍用于环比；「全部」档取一年。
  return STATS_STATE.range === 0 ? 366 : Math.min(366, STATS_STATE.range * 2 + 1);
}

// ── 合并两本账，按天出序列 ────────────────────────────────
function buildDaySeries() {
  const gatewayByDay = new Map();
  for (const row of STATS_STATE.history) gatewayByDay.set(row.day, row);

  const snapshot = STATS_STATE.gateway;
  if (snapshot) {
    const today = dayKeyLocal(new Date());
    const row = gatewayByDay.get(today) || { day: today };
    gatewayByDay.set(today, {
      ...row,
      day: today,
      requests: snapshot.requests,
      errors: snapshot.errors,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cachedTokens: (snapshot.cachedTokens || 0) + (snapshot.cacheCreationInputTokens || 0),
      estCostUsd: snapshot.estCostUsd,
      byModelUsage: snapshot.byModelUsage,
      byModel: snapshot.byModel,
    });
  }

  const local = STATS_STATE.local || {};
  const allDays = new Set([
    ...gatewayByDay.keys(),
    ...Object.keys(local.days || {}),
    ...Object.keys(local.cursorDays || {}),
    ...Object.keys(local.cpaDays || {}),
  ]);

  const rows = [...allDays].sort().map((day) => {
    const gw = gatewayByDay.get(day) || {};
    let localInput = 0;
    let localOutput = 0;
    let localCache = 0;
    let localRequests = 0;
    for (const usage of [
      ...Object.values(local.days?.[day] || {}),
      ...Object.values(local.cursorDays?.[day] || {}),
      ...Object.values(local.cpaDays?.[day] || {}),
    ]) {
      localInput += Number(usage.input) || 0;
      localOutput += Number(usage.output) || 0;
      localCache += (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0);
      localRequests += Number(usage.requests) || 0;
    }
    return {
      day,
      requests: (Number(gw.requests) || 0) + localRequests,
      errors: Number(gw.errors) || 0,
      gatewayRequests: Number(gw.requests) || 0,
      input: (Number(gw.inputTokens) || 0) + localInput,
      output: (Number(gw.outputTokens) || 0) + localOutput,
      cache: (Number(gw.cachedTokens) || 0) + localCache,
      cost: Number(gw.estCostUsd) || 0,
    };
  });

  if (STATS_STATE.range === 0) return rows;

  // 固定档位：按日历补齐，空闲日留 0 柱占位（不塌陷）。
  const want = new Set(recentDayKeys(rangeDays()));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return recentDayKeys(rangeDays()).map((day) => byDay.get(day) || {
    day, requests: 0, errors: 0, gatewayRequests: 0, input: 0, output: 0, cache: 0, cost: 0,
  });
}

function splitRanges(series) {
  const half = Math.floor(series.length / 2);
  if (half === 0) return { current: series, previous: [] };
  return {
    current: series.slice(-half),
    previous: series.slice(0, series.length - half),
  };
}

function sumSeries(series) {
  const sum = { requests: 0, errors: 0, input: 0, output: 0, cache: 0, cost: 0 };
  for (const row of series) {
    sum.requests += row.requests;
    sum.errors += row.errors;
    sum.input += row.input;
    sum.output += row.output;
    sum.cache += row.cache;
    sum.cost += row.cost;
  }
  return sum;
}

function metricValue(row, metric) {
  if (metric === 'requests') return row.requests;
  if (metric === 'cost') return row.cost;
  return row.input + row.output + row.cache;
}

// ── KPI ─────────────────────────────────────────────────
function renderTrendPill(id, current, previous, { inverse = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!previous || previous <= 0) {
    el.textContent = '—';
    el.className = 'stats-kpi-trend';
    return;
  }
  const delta = (current - previous) / previous;
  const pct = Math.abs(delta * 100);
  const up = delta >= 0;
  const good = inverse ? !up : up;
  el.textContent = `${up ? '↑' : '↓'} ${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
  el.className = `stats-kpi-trend ${good ? 'is-good' : 'is-bad'}`;
}

function renderSpark(id, values, { color = '#3b82f6' } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const points = values.map((v, i) => {
    const x = (i * step).toFixed(2);
    const y = (26 - (v / max) * 22 - 2).toFixed(2);
    return `${x},${y}`;
  }).join(' ');
  el.innerHTML = values.length > 1
    ? `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>`
    : '';
}

function renderStatsKpi(allSeries) {
  const { current, previous } = splitRanges(allSeries);
  const sum = sumSeries(current);
  const prev = sumSeries(previous);
  const tokens = sum.input + sum.output + sum.cache;
  const prevTokens = prev.input + prev.output + prev.cache;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  set('statsKpiRequests', fmtNum(sum.requests));
  set('statsKpiRequestsSub', STATS_STATE.range === 0 ? '全部区间' : `近 ${rangeDays()} 天`);
  set('statsKpiTokens', fmtNum(tokens));
  set('statsKpiTokensSub', `↑${fmtNum(sum.input)} ↓${fmtNum(sum.output)} 缓存${fmtNum(sum.cache)}`);
  set('statsKpiCost', fmtCost(sum.cost));
  const costSub = document.getElementById('statsKpiCostSub');
  if (costSub) {
    const unpriced = STATS_STATE.gateway?.pricing?.unpricedModels || [];
    costSub.textContent = unpriced.length
      ? `按模型单价估算（${unpriced.length} 个模型用默认价）`
      : '按模型单价估算，非账单';
  }
  const successRate = sum.requests > 0 ? (1 - sum.errors / sum.requests) * 100 : 100;
  set('statsKpiSuccess', `${successRate.toFixed(1)}%`);
  set('statsKpiSuccessSub', sum.errors > 0 ? `失败 ${fmtNum(sum.errors)} 次（网关侧）` : '网关侧无失败');

  renderTrendPill('statsTrendRequests', sum.requests, prev.requests);
  renderTrendPill('statsTrendTokens', tokens, prevTokens);
  renderTrendPill('statsTrendCost', sum.cost, prev.cost);
  renderTrendPill('statsTrendSuccess', successRate, null);

  renderSpark('statsSparkRequests', current.map((r) => r.requests), { color: '#3b82f6' });
  renderSpark('statsSparkTokens', current.map((r) => r.input + r.output + r.cache), { color: '#22c55e' });
  renderSpark('statsSparkCost', current.map((r) => r.cost), { color: '#f59e0b' });
  renderSpark('statsSparkSuccess', current.map((r) => (r.gatewayRequests > 0 ? Math.max(0, 100 - (r.errors / r.gatewayRequests) * 100) : 100)), { color: '#14b8a6' });
}

// ── 趋势图（柱 + 折线 + 轴）──────────────────────────────
function renderStatsTrend(series) {
  const host = document.getElementById('statsTrendChart');
  const sub = document.getElementById('statsChartSub');
  if (!host) return;
  const metric = STATS_STATE.metric;
  if (sub) {
    sub.textContent = metric === 'requests' ? '柱为当日请求数' : '柱为当日用量，折线为请求数';
  }
  if (!series.length) {
    host.innerHTML = '<div class="stats-empty">还没有统计数据，先跑一次请求</div>';
    return;
  }

  const values = series.map((r) => metricValue(r, metric));
  const max = Math.max(...values, 1);
  // Y 轴刻度：4 段
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    ratio,
    label: fmtMetric(max * ratio, metric),
  }));
  const maxRequests = Math.max(...series.map((r) => r.requests), 1);

  const bars = series.map((row) => {
    const value = metricValue(row, metric);
    const h = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
    const label = row.day.slice(5);
    const tip = `${row.day}｜请求 ${fmtNum(row.requests)}｜输入 ${fmtNum(row.input)}｜输出 ${fmtNum(row.output)}｜缓存 ${fmtNum(row.cache)}｜${fmtCost(row.cost)}`;
    return `<div class="stats-bar-slot" title="${tip}">
      <span class="stats-bar-value">${value > 0 ? fmtMetric(value, metric) : ''}</span>
      <div class="stats-bar" style="height:${h}%"></div>
      <span class="stats-bar-label">${label}</span>
    </div>`;
  }).join('');

  // 折线：请求数（tokens 指标下作为第二维度参考）
  const step = series.length > 1 ? 100 / (series.length - 1) : 100;
  const linePoints = series.map((row, i) => {
    const x = (i * step).toFixed(2);
    const y = (100 - (row.requests / maxRequests) * 88 - 4).toFixed(2);
    return `${x},${y}`;
  }).join(' ');

  host.innerHTML = `
    <div class="stats-chart-body">
      <div class="stats-axis">
        ${ticks.slice().reverse().map((t) => `<span>${t.label}</span>`).join('')}
      </div>
      <div class="stats-plot">
        <svg class="stats-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="${linePoints}" fill="none" stroke="rgba(59,130,246,.55)" stroke-width="1.2" vector-effect="non-scaling-stroke"></polyline>
        </svg>
        <div class="stats-bars">${bars}</div>
      </div>
    </div>`;
}

// ── 排行（模型 / 账号 / 来源）────────────────────────────
function collectModelUsage(series) {
  const days = new Set(series.map((r) => r.day));
  const acc = new Map();
  const add = (model, usage) => {
    const cur = acc.get(model) || { tokens: 0, requests: 0 };
    cur.tokens += (Number(usage.input) || 0) + (Number(usage.output) || 0)
      + (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0);
    cur.requests += Number(usage.requests) || 0;
    acc.set(model, cur);
  };

  for (const row of STATS_STATE.history) {
    if (!days.has(row.day) || !row.byModelUsage) continue;
    for (const [model, usage] of Object.entries(row.byModelUsage)) add(model, usage);
  }
  const snapshot = STATS_STATE.gateway;
  if (snapshot?.byModelUsage && days.has(dayKeyLocal(new Date()))) {
    for (const [model, usage] of Object.entries(snapshot.byModelUsage)) add(model, usage);
  }
  const local = STATS_STATE.local || {};
  for (const bucket of [local.days, local.cursorDays, local.cpaDays]) {
    for (const [day, models] of Object.entries(bucket || {})) {
      if (!days.has(day)) continue;
      for (const [model, usage] of Object.entries(models)) add(model, usage);
    }
  }
  return [...acc.entries()]
    .map(([name, usage]) => ({ name, requests: usage.requests, tokens: usage.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12);
}

function collectAccountUsage() {
  const accounts = STATS_STATE.local?.cpaAccounts || [];
  return accounts.map((acc) => ({
    name: acc.account,
    sub: acc.provider,
    requests: Number(acc.requests) || 0,
    tokens: (Number(acc.input) || 0) + (Number(acc.output) || 0)
      + (Number(acc.cache_read) || 0) + (Number(acc.cache_write) || 0),
    failed: Number(acc.failed) || 0,
  })).sort((a, b) => b.tokens - a.tokens).slice(0, 12);
}

function collectSourceUsage() {
  const sources = STATS_STATE.local?.sources || {};
  const label = (name) => (name === 'claude-code' ? 'Claude Code'
    : name === 'cursor' ? 'Cursor'
      : name === 'cpa' ? 'CPA 套件'
        : name);
  const rows = Object.entries(sources).map(([name, usage]) => ({
    name: label(name),
    requests: Number(usage.requests) || 0,
    tokens: (Number(usage.input) || 0) + (Number(usage.output) || 0)
      + (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0),
  }));
  if (STATS_STATE.gateway) {
    rows.push({
      name: '网关（经代理）',
      requests: Number(STATS_STATE.gateway.requests) || 0,
      tokens: (Number(STATS_STATE.gateway.inputTokens) || 0) + (Number(STATS_STATE.gateway.outputTokens) || 0)
        + (Number(STATS_STATE.gateway.cachedTokens) || 0),
    });
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

function renderStatsRank(series) {
  const host = document.getElementById('statsRankTable');
  if (!host) return;
  const rank = STATS_STATE.rank;
  let rows = [];
  let note = '';
  if (rank === 'model') {
    rows = collectModelUsage(series);
    note = `区间：近 ${rangeDays()} 天` + (STATS_STATE.range === 0 ? '（全部）' : '');
  } else if (rank === 'account') {
    rows = collectAccountUsage();
    note = 'CPA 账号为累计值（后端按天×模型聚合，无账号×天维度）';
  } else {
    rows = collectSourceUsage();
    note = '旁路来源为累计值；网关为今日快照';
  }

  if (!rows.length) {
    host.innerHTML = '<div class="stats-empty">暂无数据</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  host.innerHTML = `
    <div class="stats-table-head">
      <span>名称</span><span>调用</span><span>Token</span><span class="stats-table-bar-col">占比</span>
    </div>
    ${rows.map((row) => {
      const pct = Math.max(1, Math.round((row.tokens / max) * 100));
      return `<div class="stats-table-row">
        <span class="stats-table-name" title="${escapeText(row.name)}">${escapeText(row.name)}${row.sub ? `<em>${escapeText(row.sub)}</em>` : ''}</span>
        <span class="stats-table-num">${fmtNum(row.requests)}</span>
        <span class="stats-table-num">${fmtNum(row.tokens)}</span>
        <span class="stats-table-bar-col"><i style="width:${pct}%"></i></span>
      </div>`;
    }).join('')}
    <div class="stats-table-note">${escapeText(note)}</div>`;
}

// ── 最近请求 ────────────────────────────────────────────
function renderStatsRecent() {
  const host = document.getElementById('statsRecent');
  if (!host) return;
  const rows = STATS_STATE.gateway?.recent || [];
  if (!rows.length) {
    host.innerHTML = '<div class="stats-empty">暂无请求记录</div>';
    return;
  }
  const clamp = (text, max = 90) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };
  host.innerHTML = rows.slice(0, 10).map((entry) => {
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '—';
    if (entry.type === 'request') {
      const requested = entry.requestedModel || '';
      const served = entry.resolvedModel || '';
      const model = requested && served && requested !== served
        ? `${escapeText(requested)} → ${escapeText(served)}`
        : escapeText(served || requested || '—');
      return `<div class="stats-recent-row">
        <span class="stats-recent-ts">${ts}</span>
        <span class="stats-recent-tag is-ok">请求</span>
        <span class="stats-recent-model">${model}</span>
        <span class="stats-recent-meta">${escapeText(entry.provider || '')}</span>
      </div>`;
    }
    if (entry.type === 'error') {
      return `<div class="stats-recent-row">
        <span class="stats-recent-ts">${ts}</span>
        <span class="stats-recent-tag is-err">错误</span>
        <span class="stats-recent-model">${escapeText(clamp(entry.message))}</span>
        <span class="stats-recent-meta">${escapeText(entry.provider || '')}</span>
      </div>`;
    }
    if (entry.type === 'retry') {
      return `<div class="stats-recent-row">
        <span class="stats-recent-ts">${ts}</span>
        <span class="stats-recent-tag is-warn">重试 ×${Number(entry.count) || 1}</span>
        <span class="stats-recent-model">${escapeText(clamp(entry.reason))}</span>
        <span class="stats-recent-meta">${escapeText(entry.provider || '')}</span>
      </div>`;
    }
    return '';
  }).join('');
}

function renderStatsAll() {
  const series = buildDaySeries();
  renderStatsKpi(series);
  renderStatsTrend(series);
  renderStatsRank(series);
  renderStatsRecent();
}

// ── 加载与交互 ──────────────────────────────────────────
function statsSkeleton() {
  const chart = document.getElementById('statsTrendChart');
  if (chart) chart.innerHTML = '<div class="stats-skeleton"></div>';
}

async function loadStats({ silent = false } = {}) {
  if (STATS_STATE.loading) return;
  STATS_STATE.loading = true;
  if (!silent) statsSkeleton();
  const btn = document.getElementById('statsRefreshBtn');
  if (btn) btn.classList.add('is-busy');

  try {
    if (typeof invoke !== 'function') {
      throw new Error('Tauri bridge 未就绪');
    }
    const [gateway, history, local] = await Promise.all([
      invoke('get_stats').catch(() => null),
      invoke('get_stats_history', { days: historyDaysToFetch() }).catch(() => ({ days: [] })),
      invoke('get_local_usage').catch(() => null),
    ]);
    STATS_STATE.gateway = gateway;
    STATS_STATE.history = Array.isArray(history?.days) ? history.days : [];
    STATS_STATE.local = local;
    renderStatsAll();
    // 触发一次旁路扫描：失败不影响页面（下次刷新再试）。
    invoke('scan_local_usage').then((fresh) => {
      if (fresh) {
        STATS_STATE.local = fresh;
        renderStatsAll();
      }
    }).catch(() => {});
  } catch (e) {
    const chart = document.getElementById('statsTrendChart');
    if (chart) chart.innerHTML = `<div class="stats-empty">统计加载失败：${escapeText(e?.message || e)}</div>`;
  } finally {
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
  bindSeg('#page-stats .stats-range', 'data-stats-range', (value) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next === STATS_STATE.range) return;
    STATS_STATE.range = next;
    loadStats();
  });

  bindSeg('#page-stats .stats-seg[aria-label="图表指标"]', 'data-stats-metric', (value) => {
    STATS_STATE.metric = value;
    renderStatsTrend(buildDaySeries());
  });

  bindSeg('#page-stats .stats-seg[aria-label="排行维度"]', 'data-stats-rank', (value) => {
    STATS_STATE.rank = value;
    renderStatsRank(buildDaySeries());
  });

  const refresh = document.getElementById('statsRefreshBtn');
  if (refresh && !refresh.dataset.bound) {
    refresh.dataset.bound = '1';
    refresh.addEventListener('click', () => loadStats());
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
  if (document.getElementById('page-stats').classList.contains('active')) {
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
