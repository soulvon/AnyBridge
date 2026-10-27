/**
 * 67-stats.js — 统计页渲染。
 *
 * 数据来源（两条独立账，不合并成一本）：
 *   1. 网关账本：get_stats（今日实时）+ get_stats_history（stats.json 按天）
 *   2. 旁路账本：get_local_usage（Claude Code 会话文件 + cursor-core.db）
 *
 * 口径：KPI 的请求/Token 合并两本账；费用与成功率只算网关（旁路没有价格与错误口径）。
 */

const STATS_STATE = {
  // 默认近 7 天：避免早上打开时「今日」还没流量，整页看起来是空的。
  range: 7,            // 1 / 7 / 30 / 0=全部
  loading: false,
  gateway: null,       // snapshot
  history: [],         // [{ day, requests, inputTokens, ... }]
  local: null,         // { days, cursorDays, sources, scannedAt }
};

function statsT(key) {
  return (typeof window.t === 'function' ? window.t(key) : null) || key;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1) + 'B';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + 'K';
  return String(v);
}

function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

function statsRangeDays() {
  return STATS_STATE.range === 0 ? 366 : STATS_STATE.range;
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

// 把两本账按天合成图表数据；旁路的 day 归属按本地日期。
function buildDaySeries() {
  const days = statsRangeDays();
  const keys = STATS_STATE.range === 0
    ? [...new Set([
      ...STATS_STATE.history.map((d) => d.day),
      ...Object.keys(STATS_STATE.local?.days || {}),
      ...Object.keys(STATS_STATE.local?.cursorDays || {}),
    ])].sort()
    : recentDayKeys(Math.min(days, 366));

  const gatewayByDay = new Map();
  for (const row of STATS_STATE.history) gatewayByDay.set(row.day, row);

  // 今日的实时快照可能比 stats.json 更新，覆盖同日历史。
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
      cachedTokens: snapshot.cachedTokens + (snapshot.cacheCreationInputTokens || 0),
      estCostUsd: snapshot.estCostUsd,
      byModelUsage: snapshot.byModelUsage,
      byModel: snapshot.byModel,
    });
  }

  return keys.map((day) => {
    const gw = gatewayByDay.get(day) || {};
    const claude = STATS_STATE.local?.days?.[day] || {};
    const cursor = STATS_STATE.local?.cursorDays?.[day] || {};
    const cpa = STATS_STATE.local?.cpaDays?.[day] || {};

    let localInput = 0;
    let localOutput = 0;
    let localCache = 0;
    let localRequests = 0;
    for (const usage of [...Object.values(claude), ...Object.values(cursor), ...Object.values(cpa)]) {
      localInput += Number(usage.input) || 0;
      localOutput += Number(usage.output) || 0;
      localCache += (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0);
      localRequests += Number(usage.requests) || 0;
    }

    return {
      day,
      requests: (Number(gw.requests) || 0) + localRequests,
      errors: Number(gw.errors) || 0,
      input: (Number(gw.inputTokens) || 0) + localInput,
      output: (Number(gw.outputTokens) || 0) + localOutput,
      cache: (Number(gw.cachedTokens) || 0) + localCache,
      cost: Number(gw.estCostUsd) || 0,
    };
  });
}

function aggregate(series) {
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

function renderStatsKpi(series) {
  const sum = aggregate(series);
  const tokens = sum.input + sum.output;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  set('statsKpiRequests', fmtNum(sum.requests));
  set('statsKpiRequestsSub', STATS_STATE.range === 1 ? '今日（网关 + 本地日志）' : '区间内（网关 + 本地日志）');
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
  set('statsKpiSuccessSub', sum.errors > 0 ? `失败 ${sum.errors} 次（网关侧）` : '网关侧无失败');
}

function renderStatsTrend(series) {
  const host = document.getElementById('statsTrendChart');
  if (!host) return;
  if (!series.length) {
    host.innerHTML = '<div class="stats-empty">还没有统计数据，先跑一次请求</div>';
    return;
  }
  const max = Math.max(...series.map((r) => r.input + r.output + r.cache), 1);
  const bars = series.map((row) => {
    const total = row.input + row.output + row.cache;
    const h = total > 0 ? Math.max(2, Math.round((total / max) * 100)) : 0;
    const inH = total > 0 ? (row.input / total) * 100 : 0;
    const outH = total > 0 ? (row.output / total) * 100 : 0;
    const cacheH = total > 0 ? (row.cache / total) * 100 : 0;
    const label = row.day.slice(5);
    const tip = `${row.day}｜请求 ${row.requests}｜输入 ${fmtNum(row.input)}｜输出 ${fmtNum(row.output)}｜缓存 ${fmtNum(row.cache)}`;
    return `<div class="stats-bar-slot" title="${tip}">
      <div class="stats-bar" style="height:${h}%">
        <span class="stats-bar-seg stats-bar-cache" style="height:${cacheH}%"></span>
        <span class="stats-bar-seg stats-bar-output" style="height:${outH}%"></span>
        <span class="stats-bar-seg stats-bar-input" style="height:${inH}%"></span>
      </div>
      <span class="stats-bar-label">${label}</span>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="stats-bars">${bars}</div>`;
}

function collectModelUsage(series) {
  const days = new Set(series.map((r) => r.day));
  const acc = new Map();
  const add = (model, usage) => {
    const cur = acc.get(model) || { tokens: 0, requests: 0 };
    cur.tokens += (Number(usage.input) || 0) + (Number(usage.output) || 0) + (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0);
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
  for (const [day, models] of Object.entries(STATS_STATE.local?.days || {})) {
    if (!days.has(day)) continue;
    for (const [model, usage] of Object.entries(models)) add(model, usage);
  }
  for (const [day, models] of Object.entries(STATS_STATE.local?.cursorDays || {})) {
    if (!days.has(day)) continue;
    for (const [model, usage] of Object.entries(models)) add(model, usage);
  }
  for (const [day, models] of Object.entries(STATS_STATE.local?.cpaDays || {})) {
    if (!days.has(day)) continue;
    for (const [model, usage] of Object.entries(models)) add(model, usage);
  }
  return [...acc.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
}

function renderStatsRank(series) {
  const host = document.getElementById('statsModelRank');
  if (!host) return;
  const rows = collectModelUsage(series).slice(0, 8);
  if (!rows.length) {
    host.innerHTML = '<div class="stats-empty">暂无数据</div>';
    return;
  }
  const max = rows[0][1].tokens || 1;
  host.innerHTML = rows.map(([model, usage]) => {
    const pct = Math.round((usage.tokens / max) * 100);
    return `<div class="stats-rank-row">
      <span class="stats-rank-name" title="${model}">${model}</span>
      <span class="stats-rank-bar"><i style="width:${pct}%"></i></span>
      <span class="stats-rank-value">${fmtNum(usage.tokens)}</span>
    </div>`;
  }).join('');
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderStatsSources() {
  const host = document.getElementById('statsSources');
  if (!host) return;
  const sources = STATS_STATE.local?.sources || {};
  const rows = Object.entries(sources);
  const gateway = STATS_STATE.gateway;
  const parts = [];
  if (gateway) {
    parts.push(`<div class="stats-source-row">
      <span class="stats-source-name">网关（经代理）</span>
      <span class="stats-source-meta">今日 ${fmtNum(gateway.requests)} 次请求</span>
    </div>`);
  }
  for (const [name, usage] of rows) {
    const label = name === 'claude-code' ? 'Claude Code（本地日志）'
      : name === 'cursor' ? 'Cursor（cursor-core 记录）'
        : name === 'cpa' ? 'CPA 套件（账号池）'
          : name;
    parts.push(`<div class="stats-source-row">
      <span class="stats-source-name">${escapeText(label)}</span>
      <span class="stats-source-meta">${fmtNum(usage.requests)} 次 · ↑${fmtNum(usage.input)} ↓${fmtNum(usage.output)}</span>
    </div>`);
  }

  const accounts = STATS_STATE.local?.cpaAccounts || [];
  if (accounts.length) {
    const accountRows = accounts.slice(0, 6).map((acc) => `
      <div class="stats-source-row stats-account-row">
        <span class="stats-source-name">${escapeText(acc.account)}</span>
        <span class="stats-source-meta">${fmtNum(acc.requests)} 次 · ↑${fmtNum(acc.input)} ↓${fmtNum(acc.output)}${acc.failed ? ` · 失败 ${acc.failed}` : ''}</span>
      </div>`).join('');
    parts.push(`<div class="stats-account-block">
      <div class="stats-account-title">CPA 账号</div>
      ${accountRows}
    </div>`);
  }

  if (!parts.length) {
    host.innerHTML = '<div class="stats-empty">还没有数据源。跑一次请求，或安装 Claude Code 后点击刷新。</div>';
    return;
  }
  const scanned = STATS_STATE.local?.scannedAt
    ? new Date(STATS_STATE.local.scannedAt).toLocaleString()
    : null;
  host.innerHTML = parts.join('') + (scanned
    ? `<div class="stats-source-foot">本地日志扫描于 ${scanned}</div>`
    : '');
}

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
  renderStatsSources();
  renderStatsRecent();
}

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
      invoke('get_stats_history', { days: statsRangeDays() }).catch(() => ({ days: [] })),
      invoke('get_local_usage').catch(() => null),
    ]);
    STATS_STATE.gateway = gateway;
    STATS_STATE.history = Array.isArray(history?.days) ? history.days : [];
    STATS_STATE.local = local;
    renderStatsAll();
    // 顺手触发一次旁路扫描：失败不影响页面（下次刷新再试）。
    invoke('scan_local_usage').then((fresh) => {
      if (fresh) {
        STATS_STATE.local = fresh;
        renderStatsAll();
      }
    }).catch(() => {});
  } catch (e) {
    const chart = document.getElementById('statsTrendChart');
    if (chart) chart.innerHTML = `<div class="stats-empty">统计加载失败：${e?.message || e}</div>`;
  } finally {
    STATS_STATE.loading = false;
    if (btn) btn.classList.remove('is-busy');
  }
}

function bindStatsPage() {
  const rangeHost = document.querySelector('#page-stats .stats-range');
  if (rangeHost && !rangeHost.dataset.bound) {
    rangeHost.dataset.bound = '1';
    rangeHost.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-stats-range]');
      if (!btn) return;
      const value = Number(btn.dataset.statsRange);
      if (!Number.isFinite(value) || value === STATS_STATE.range) return;
      STATS_STATE.range = value;
      rangeHost.querySelectorAll('[data-stats-range]').forEach((el) => {
        const active = el === btn;
        el.classList.toggle('active', active);
        el.setAttribute('aria-selected', String(active));
      });
      loadStats();
    });
  }

  const refresh = document.getElementById('statsRefreshBtn');
  if (refresh && !refresh.dataset.bound) {
    refresh.dataset.bound = '1';
    refresh.addEventListener('click', () => loadStats());
  }

  // 切到统计页时刷新（顶部 tab 点击）。
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
