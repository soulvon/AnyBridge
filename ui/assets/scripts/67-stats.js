/**
 * 67-stats.js — 统计与全局账本交互引擎（深度复刻 magpie 原生紧凑美学与排版算法）
 */

const STATS_STATE = {
  range: 7,            // 1 / 7 / 30 / 0=全部
  rank: 'model',       // model / account / source
  loading: false,
  gateway: null,
  history: [],
  local: null,
};

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 100_000_000 ? 1 : 2) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return String(Math.round(v));
}

function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'K';
  return '$' + v.toFixed(2);
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
  return STATS_STATE.range === 0 ? 366 : Math.min(366, STATS_STATE.range * 2 + 1);
}

// ── 构建日序综合数据集 ──
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

    const sourcesToSum = [
      ...Object.values(local.days?.[day] || {}),
      ...Object.values(local.cursorDays?.[day] || {}),
      ...Object.values(local.cpaDays?.[day] || {}),
    ];

    for (const u of sourcesToSum) {
      localInput += Number(u.input) || 0;
      localOutput += Number(u.output) || 0;
      localCache += (Number(u.cache_read) || 0) + (Number(u.cache_write) || 0);
      localRequests += Number(u.requests) || 0;
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

  const byDay = new Map(rows.map((r) => [r.day, r]));
  return recentDayKeys(rangeDays()).map((day) => byDay.get(day) || {
    day, requests: 0, errors: 0, gatewayRequests: 0, input: 0, output: 0, cache: 0, cost: 0,
  });
}

function sumSeries(series) {
  const sum = { requests: 0, errors: 0, input: 0, output: 0, cache: 0, cost: 0, gatewayRequests: 0 };
  for (const row of series) {
    sum.requests += row.requests;
    sum.errors += row.errors;
    sum.gatewayRequests += row.gatewayRequests;
    sum.input += row.input;
    sum.output += row.output;
    sum.cache += row.cache;
    sum.cost += row.cost;
  }
  return sum;
}

// ── 渲染四联 KPI (对标 magpie .stats + .kpi) ──
function renderStatsKpi(allSeries) {
  const sum = sumSeries(allSeries);
  const totalTokens = sum.input + sum.output + sum.cache;
  const promptTokens = sum.input + sum.cache;
  const cacheHitRate = promptTokens > 0 ? Math.round((sum.cache / promptTokens) * 100) : 0;

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  // 右上角总估值
  set('statsKpiCost', fmtCost(sum.cost));

  // 1. Tokens
  set('statsKpiTokens', fmtNum(totalTokens));
  set('statsKpiTokensSub', `${fmtNum(sum.input)} in · ${fmtNum(sum.output)} out`);

  // 2. Cache
  set('statsKpiCache', fmtNum(sum.cache));
  set('statsKpiCacheSub', `命中率 ${cacheHitRate}% · 节省支出`);

  // 3. Calls
  set('statsKpiRequests', fmtNum(sum.requests));
  set('statsKpiRequestsSub', sum.errors > 0 ? `${fmtNum(sum.errors)} 失败 · 网关拦截` : '无异常调用');

  // 4. 健康度
  const gwReqs = sum.gatewayRequests;
  const successRate = gwReqs > 0 ? (1 - sum.errors / gwReqs) * 100 : 100;
  set('statsKpiSuccess', `${successRate.toFixed(1)}%`);
  set('statsKpiSuccessSub', gwReqs > 0 ? `网关流量 ${fmtNum(gwReqs)} 次` : '旁路无故障');
}

// ── 渲染 72px 极简走势图 (对标 magpie .chart) ──
function renderStatsChart(series) {
  const barsHost = document.getElementById('statsChartBars');
  const labelsHost = document.getElementById('statsChartLabels');
  const peakHost = document.getElementById('statsChartPeak');
  if (!barsHost || !labelsHost) return;

  if (!series.length) {
    barsHost.innerHTML = '<div class="us-none">暂无周期数据</div>';
    labelsHost.innerHTML = '';
    if (peakHost) peakHost.textContent = '峰值: 0';
    return;
  }

  // 峰值基于当天的 total tokens (input + output + cache)
  const peaks = series.map((r) => r.input + r.output + r.cache);
  const maxPeak = Math.max(...peaks, 1);
  if (peakHost) peakHost.textContent = `峰值: ${fmtNum(maxPeak)}`;

  // 生成双层输入/输出柱形 (output 叠在 input 之上，对标 magpie .bar .in, .out)
  barsHost.innerHTML = series.map((r) => {
    const total = r.input + r.output + r.cache;
    const inTokens = r.input + r.cache;
    const inPct = ((inTokens / maxPeak) * 100).toFixed(1);
    const outPct = ((r.output / maxPeak) * 100).toFixed(1);

    const tip = `${r.day}\n总吞吐: ${fmtNum(total)} (入:${fmtNum(r.input)} 出:${fmtNum(r.output)} 缓:${fmtNum(r.cache)})\n调用: ${fmtNum(r.requests)} 次`;

    return `
      <div class="us-bar" title="${escapeText(tip)}">
        <i class="out" style="height: ${outPct}%;"></i>
        <i class="in" style="height: ${inPct}%;"></i>
      </div>
    `;
  }).join('');

  // 底部标签抽样算法 (对标 magpie every 规则: 8天以内天天下标，超过的隔开)
  const n = series.length;
  const every = n <= 8 ? 1 : n <= 31 ? Math.ceil(n / 6) : Math.ceil(n / 5);

  labelsHost.innerHTML = series.map((r, i) => {
    const isLast = (i === n - 1) && ((n - 1) % every >= every / 2);
    const show = (i % every === 0) || isLast;
    return `<span>${show ? r.day.slice(5) : ''}</span>`;
  }).join('');
}

// ── 渲染分组排行 (对标 magpie .row.stat: 名字/细线进度/单量/估值) ──
function collectRankData(series) {
  const days = new Set(series.map((r) => r.day));
  const rankKind = STATS_STATE.rank;

  if (rankKind === 'model') {
    const map = new Map();
    const add = (model, usage) => {
      if (!model) return;
      const cur = map.get(model) || { name: model, requests: 0, tokens: 0, input: 0, output: 0, cache: 0 };
      const inp = Number(usage.input) || 0;
      const out = Number(usage.output) || 0;
      const cch = (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0);
      cur.tokens += inp + out + cch;
      cur.input += inp;
      cur.output += out;
      cur.cache += cch;
      cur.requests += Number(usage.requests) || 0;
      map.set(model, cur);
    };

    for (const row of STATS_STATE.history) {
      if (!days.has(row.day) || !row.byModelUsage) continue;
      for (const [m, u] of Object.entries(row.byModelUsage)) add(m, u);
    }
    const snap = STATS_STATE.gateway;
    if (snap?.byModelUsage && days.has(dayKeyLocal(new Date()))) {
      for (const [m, u] of Object.entries(snap.byModelUsage)) add(m, u);
    }

    const local = STATS_STATE.local || {};
    for (const b of [local.days, local.cursorDays, local.cpaDays]) {
      for (const [day, models] of Object.entries(b || {})) {
        if (!days.has(day)) continue;
        for (const [m, u] of Object.entries(models)) add(m, u);
      }
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 15);
  }

  if (rankKind === 'account') {
    const accounts = STATS_STATE.local?.cpaAccounts || [];
    return accounts.map((acc) => ({
      name: acc.account,
      sub: acc.provider || 'CPA',
      requests: Number(acc.requests) || 0,
      tokens: (Number(acc.input) || 0) + (Number(acc.output) || 0) + (Number(acc.cache_read) || 0) + (Number(acc.cache_write) || 0),
      input: Number(acc.input) || 0,
      output: Number(acc.output) || 0,
    })).sort((a, b) => b.tokens - a.tokens).slice(0, 15);
  }

  // rankKind === 'source'
  const sources = STATS_STATE.local?.sources || {};
  const list = Object.entries(sources).map(([k, u]) => {
    let title = k;
    let sub = '旁路日志';
    if (k === 'claude-code') { title = 'Claude Code CLI'; sub = '~/.claude projects'; }
    else if (k === 'cursor') { title = 'Cursor IDE'; sub = 'cursor-core.db'; }
    else if (k === 'cpa') { title = 'CPA 套件代理池'; sub = 'usage.sqlite 聚合'; }
    return {
      name: title,
      sub,
      requests: Number(u.requests) || 0,
      tokens: (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cache_read) || 0) + (Number(u.cache_write) || 0),
      input: Number(u.input) || 0,
      output: Number(u.output) || 0,
    };
  });

  if (STATS_STATE.gateway) {
    const g = STATS_STATE.gateway;
    list.push({
      name: 'AnyBridge 本地网关',
      sub: '核心拦截通道',
      requests: Number(g.requests) || 0,
      tokens: (Number(g.inputTokens) || 0) + (Number(g.outputTokens) || 0) + (Number(g.cachedTokens) || 0),
      input: Number(g.inputTokens) || 0,
      output: Number(g.outputTokens) || 0,
    });
  }

  return list.sort((a, b) => b.tokens - a.tokens);
}

function renderStatsRank(series) {
  const host = document.getElementById('statsRankList');
  if (!host) return;
  const rows = collectRankData(series);

  if (!rows.length) {
    host.innerHTML = '<div class="us-none">周期内未产生记录</div>';
    return;
  }

  const maxVal = Math.max(...rows.map((r) => r.tokens), 1);

  host.innerHTML = rows.map((r) => {
    const pct = Math.max(1.5, (r.tokens / maxVal) * 100).toFixed(1);
    const subText = r.sub || `${fmtNum(r.requests)} 次调用`;
    const tokensSub = `${fmtNum(r.input || 0)} in · ${fmtNum(r.output || 0)} out`;

    return `
      <div class="us-stat-row">
        <div class="us-stat-who">
          <div class="us-stat-name" title="${escapeText(r.name)}">${escapeText(r.name)}</div>
          <div class="us-stat-sub">${escapeText(subText)}</div>
        </div>
        <div class="us-stat-share" title="${pct}% 相对占比">
          <i style="width: ${pct}%;"></i>
        </div>
        <div class="us-stat-num">
          <b>${fmtNum(r.tokens)}</b>
          <small>${tokensSub}</small>
        </div>
        <div class="us-stat-cost">
          ${r.requests ? fmtNum(r.requests) + ' 次' : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ── 渲染数据通道概况 ──
function renderStatsSourcesDeck() {
  const host = document.getElementById('statsSourcesDeck');
  if (!host) return;

  const local = STATS_STATE.local || {};
  const sources = local.sources || {};
  const gateway = STATS_STATE.gateway;
  const cards = [];

  if (gateway) {
    cards.push(`
      <div class="us-sc-card">
        <div class="us-sc-card-top">
          <span class="us-sc-name">AnyBridge 网关</span>
          <span class="us-sc-pill">在线</span>
        </div>
        <div class="us-sc-nums">
          <span>今日调用</span>
          <b>${fmtNum(gateway.requests)} 次</b>
        </div>
      </div>
    `);
  }

  if (sources.cpa) {
    const accs = local.cpaAccounts ? local.cpaAccounts.length : 0;
    cards.push(`
      <div class="us-sc-card">
        <div class="us-sc-card-top">
          <span class="us-sc-name">CPA 套件代理池</span>
          <span class="us-sc-pill">${accs} 账号</span>
        </div>
        <div class="us-sc-nums">
          <span>累计吞吐</span>
          <b>${fmtNum(sources.cpa.input + sources.cpa.output)}</b>
        </div>
      </div>
    `);
  }

  if (sources['claude-code']) {
    cards.push(`
      <div class="us-sc-card">
        <div class="us-sc-card-top">
          <span class="us-sc-name">Claude Code</span>
          <span class="us-sc-pill">~/.claude</span>
        </div>
        <div class="us-sc-nums">
          <span>会话调用</span>
          <b>${fmtNum(sources['claude-code'].requests)} 次</b>
        </div>
      </div>
    `);
  }

  if (sources.cursor) {
    cards.push(`
      <div class="us-sc-card">
        <div class="us-sc-card-top">
          <span class="us-sc-name">Cursor Core</span>
          <span class="us-sc-pill">SQLite</span>
        </div>
        <div class="us-sc-nums">
          <span>数据库记录</span>
          <b>${fmtNum(sources.cursor.requests)} 次</b>
        </div>
      </div>
    `);
  }

  host.innerHTML = cards.length ? cards.join('') : '<div class="us-none">无挂载通道</div>';
}

// ── 渲染实时请求审计表 (对标 magpie .led) ──
function renderStatsRecentTable() {
  const tbody = document.getElementById('statsRecentTbody');
  if (!tbody) return;
  const rows = STATS_STATE.gateway?.recent || [];

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="us-none">当前网关无最近会话调用</td></tr>';
    return;
  }

  const clamp = (text, max = 75) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };

  tbody.innerHTML = rows.slice(0, 20).map((e) => {
    const timeStr = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
    let statusBadge = '<span class="us-tag-ok">成功</span>';
    let routeDesc = '';
    let metaText = escapeText(e.provider || '默认网关');

    if (e.type === 'error') {
      statusBadge = '<span class="us-tag-err">失败</span>';
      routeDesc = `<span style="color:#b91c1c;">${escapeText(clamp(e.message))}</span>`;
    } else if (e.type === 'retry') {
      statusBadge = `<span class="us-tag-warn">重试 ×${Number(e.count) || 1}</span>`;
      routeDesc = `<span style="color:#b45309;">${escapeText(clamp(e.reason))}</span>`;
    } else {
      const reqM = e.requestedModel || '';
      const resM = e.resolvedModel || '';
      if (reqM && resM && reqM !== resM) {
        routeDesc = `<span>${escapeText(reqM)}</span><span class="us-arrow">→</span><b>${escapeText(resM)}</b>`;
      } else {
        routeDesc = `<span>${escapeText(resM || reqM || '未指定')}</span>`;
      }
    }

    return `
      <tr>
        <td class="us-time">${timeStr}</td>
        <td>${statusBadge}</td>
        <td>${metaText}</td>
        <td>${routeDesc}</td>
        <td style="text-align: right; font-family:'JetBrains Mono',monospace;">—</td>
      </tr>
    `;
  }).join('');
}

// ── 全量同步 ──
function renderStatsAll() {
  const series = buildDaySeries();
  renderStatsKpi(series);
  renderStatsChart(series);
  renderStatsRank(series);
  renderStatsSourcesDeck();
  renderStatsRecentTable();
}

async function loadStats({ silent = false } = {}) {
  if (STATS_STATE.loading) return;
  STATS_STATE.loading = true;
  const btn = document.getElementById('statsRefreshBtn');
  if (btn) btn.classList.add('is-busy');

  try {
    if (typeof invoke !== 'function') throw new Error('Tauri bridge 未就绪');
    const [gateway, history, local] = await Promise.all([
      invoke('get_stats').catch(() => null),
      invoke('get_stats_history', { days: historyDaysToFetch() }).catch(() => ({ days: [] })),
      invoke('get_local_usage').catch(() => null),
    ]);
    STATS_STATE.gateway = gateway;
    STATS_STATE.history = Array.isArray(history?.days) ? history.days : [];
    STATS_STATE.local = local;
    renderStatsAll();

    // 触发旁路更新
    invoke('scan_local_usage').then((fresh) => {
      if (fresh) {
        STATS_STATE.local = fresh;
        renderStatsAll();
      }
    }).catch(() => {});
  } catch (e) {
    console.error('统计加载失败', e);
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
      el.classList.toggle('on', active);
      el.setAttribute('aria-selected', String(active));
    });
    onChange(value);
  });
}

function bindStatsPage() {
  // 时间周期切换
  bindSeg('#page-stats .us-segs[aria-label="时间周期"]', 'data-stats-range', (value) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next === STATS_STATE.range) return;
    STATS_STATE.range = next;
    loadStats();
  });

  // 排行视图切换
  bindSeg('#page-stats .us-segs[aria-label="排行视图"]', 'data-stats-rank', (value) => {
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
