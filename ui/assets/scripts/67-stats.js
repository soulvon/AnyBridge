/**
 * 67-stats.js — 统计引擎（全面适配 EasyUI 设计体系）
 */

const STATS_STATE = {
  range: 7,             // 1 / 7 / 30 / 0=全部
  sourceFilter: 'all',  // all / cpa / claude / gateway
  metric: 'tokens',     // tokens / requests / cost
  rank: 'model',        // model / account / source
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
  return STATS_STATE.range === 0 ? 366 : Math.min(366, STATS_STATE.range * 2 + 1);
}

// ── 构建日序综合数据集（支持 EasyUI 通道筛选） ──
function buildDaySeries() {
  const filter = STATS_STATE.sourceFilter;
  const includeGateway = filter === 'all' || filter === 'gateway';
  const includeCpa = filter === 'all' || filter === 'cpa';
  const includeClaude = filter === 'all' || filter === 'claude';
  const includeCursor = filter === 'all';

  const gatewayByDay = new Map();
  if (includeGateway) {
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
  }

  const local = STATS_STATE.local || {};
  const allDays = new Set([...gatewayByDay.keys()]);
  if (includeClaude) Object.keys(local.days || {}).forEach((d) => allDays.add(d));
  if (includeCursor) Object.keys(local.cursorDays || {}).forEach((d) => allDays.add(d));
  if (includeCpa) Object.keys(local.cpaDays || {}).forEach((d) => allDays.add(d));

  const rows = [...allDays].sort().map((day) => {
    const gw = gatewayByDay.get(day) || {};
    let localInput = 0;
    let localOutput = 0;
    let localCache = 0;
    let localRequests = 0;

    const sourcesToSum = [];
    if (includeClaude && local.days?.[day]) sourcesToSum.push(...Object.values(local.days[day]));
    if (includeCursor && local.cursorDays?.[day]) sourcesToSum.push(...Object.values(local.cursorDays[day]));
    if (includeCpa && local.cpaDays?.[day]) sourcesToSum.push(...Object.values(local.cpaDays[day]));

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

function splitRanges(series) {
  const half = Math.floor(series.length / 2);
  if (half === 0) return { current: series, previous: [] };
  return {
    current: series.slice(-half),
    previous: series.slice(0, series.length - half),
  };
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

function metricValue(row, metric) {
  if (metric === 'requests') return row.requests;
  if (metric === 'cost') return row.cost;
  return row.input + row.output + row.cache;
}

// ── EasyUI Sparkline 微线图生成 ──
function renderSparkSvg(id, values, colorVar = 'var(--accent, #1261A6)') {
  const el = document.getElementById(id);
  if (!el) return;
  if (!values.length || values.every((v) => v === 0)) {
    el.innerHTML = '';
    return;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const pad = 2;
  const step = w / Math.max(values.length - 1, 1);

  const coords = values.map((v, i) => {
    const x = i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = coords.join(' ');
  const area = `0,${h} ${polyline} ${w},${h}`;

  el.innerHTML = `
    <polygon points="${area}" fill="${colorVar}" fill-opacity="0.12"></polygon>
    <polyline points="${polyline}" fill="none" stroke="${colorVar}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></polyline>
  `;
}

// ── 渲染 EasyUI Delta 徽标 ──
function renderDeltaPill(id, current, previous, { inverse = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!previous || previous <= 0) {
    el.textContent = '持平';
    el.className = 'ez-delta-pill is-neutral';
    return;
  }
  const delta = (current - previous) / previous;
  const pct = Math.abs(delta * 100);
  const up = delta >= 0;
  const good = inverse ? !up : up;
  el.textContent = `${up ? '↑' : '↓'} ${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
  el.className = `ez-delta-pill ${good ? 'is-up' : 'is-down'}`;
}

// ── 渲染 StatGrid ──
function renderStatsKpi(allSeries) {
  const { current, previous } = splitRanges(allSeries);
  const sum = sumSeries(current);
  const prev = sumSeries(previous);
  const totalTokens = sum.input + sum.output + sum.cache;
  const prevTokens = prev.input + prev.output + prev.cache;

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  set('statsKpiRequests', fmtNum(sum.requests));
  set('statsKpiRequestsSub', STATS_STATE.range === 0 ? '历史全量累计' : `近 ${rangeDays()} 天调用汇总`);

  set('statsKpiTokens', fmtNum(totalTokens));
  set('statsKpiTokensSub', `输入 ${fmtNum(sum.input)} · 输出 ${fmtNum(sum.output)} · 缓存 ${fmtNum(sum.cache)}`);

  // EasyUI 比例进度条
  const safeTotal = totalTokens || 1;
  const inPct = Math.max(0, (sum.input / safeTotal) * 100);
  const outPct = Math.max(0, (sum.output / safeTotal) * 100);
  const cachePct = Math.max(0, (sum.cache / safeTotal) * 100);

  const inEl = document.getElementById('statsTokenInputSeg');
  const outEl = document.getElementById('statsTokenOutputSeg');
  const cacheEl = document.getElementById('statsTokenCacheSeg');
  if (inEl) inEl.style.width = `${inPct.toFixed(1)}%`;
  if (outEl) outEl.style.width = `${outPct.toFixed(1)}%`;
  if (cacheEl) cacheEl.style.width = `${cachePct.toFixed(1)}%`;

  set('statsKpiCost', fmtCost(sum.cost));
  set('statsKpiCostSub', STATS_STATE.sourceFilter === 'gateway' ? '网关直连精确估算' : '含网关直连，旁路按默认计');

  const gwRequests = sum.gatewayRequests;
  const successRate = gwRequests > 0 ? (1 - sum.errors / gwRequests) * 100 : 100;
  set('statsKpiSuccess', `${successRate.toFixed(1)}%`);
  set('statsKpiSuccessSub', sum.errors > 0 ? `网关阻断 / 错误 ${fmtNum(sum.errors)} 次` : '网关流量无异常阻断');

  const healthPill = document.getElementById('statsHealthStatus');
  if (healthPill) {
    if (successRate >= 99) {
      healthPill.className = 'ez-status-tag is-ok';
      healthPill.textContent = '通畅';
    } else if (successRate >= 90) {
      healthPill.className = 'ez-status-tag is-warn';
      healthPill.textContent = '波动';
    } else {
      healthPill.className = 'ez-status-tag is-err';
      healthPill.textContent = '告警';
    }
  }

  renderDeltaPill('statsTrendRequests', sum.requests, prev.requests);
  renderDeltaPill('statsTrendTokens', totalTokens, prevTokens);
  renderDeltaPill('statsTrendCost', sum.cost, prev.cost);

  // Sparklines
  renderSparkSvg('statsSparkRequests', current.map((r) => r.requests), '#3b82f6');
  renderSparkSvg('statsSparkCost', current.map((r) => r.cost), '#f59e0b');
  renderSparkSvg('statsSparkSuccess', current.map((r) => (r.gatewayRequests > 0 ? Math.max(0, 100 - (r.errors / r.gatewayRequests) * 100) : 100)), '#10b981');
}

// ── 渲染 EasyUI Bar Chart ──
function renderStatsTrend(series) {
  const host = document.getElementById('statsTrendChart');
  if (!host) return;
  const metric = STATS_STATE.metric;

  if (!series.length) {
    host.innerHTML = '<div class="ez-empty-state">当前时间范围暂无用量记录</div>';
    return;
  }

  const values = series.map((r) => metricValue(r, metric));
  const max = Math.max(...values, 1);
  const maxRequests = Math.max(...series.map((r) => r.requests), 1);

  // 4 段 Y 轴刻度
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
    ratio,
    label: fmtMetric(max * ratio, metric),
  }));

  // 生成 EasyUI Stacked Bar
  const barsHtml = series.map((row) => {
    const totalVal = metricValue(row, metric);
    const heightPct = (totalVal / max) * 100;

    let segmentsHtml = '';
    if (metric === 'tokens') {
      const sumT = (row.input + row.output + row.cache) || 1;
      const inPct = (row.input / sumT) * 100;
      const outPct = (row.output / sumT) * 100;
      const cachePct = (row.cache / sumT) * 100;
      segmentsHtml = `
        <div class="ez-bar-stack" style="height: ${Math.max(heightPct, 2).toFixed(1)}%;">
          <span class="ez-seg is-cache" style="height: ${cachePct.toFixed(1)}%;"></span>
          <span class="ez-seg is-out" style="height: ${outPct.toFixed(1)}%;"></span>
          <span class="ez-seg is-in" style="height: ${inPct.toFixed(1)}%;"></span>
        </div>
      `;
    } else {
      segmentsHtml = `
        <div class="ez-bar-stack" style="height: ${Math.max(heightPct, 2).toFixed(1)}%;">
          <span class="ez-seg is-fill" style="height: 100%;"></span>
        </div>
      `;
    }

    const shortDate = row.day.slice(5);
    const tip = `日期: ${row.day}\n总Token: ${fmtNum(row.input + row.output + row.cache)} (入:${fmtNum(row.input)} 出:${fmtNum(row.output)} 缓:${fmtNum(row.cache)})\n调用: ${fmtNum(row.requests)} 次\n费用估算: ${fmtCost(row.cost)}`;

    return `
      <div class="ez-bar-cell" title="${escapeText(tip)}">
        <div class="ez-bar-val">${totalVal > 0 ? fmtMetric(totalVal, metric) : ''}</div>
        <div class="ez-bar-body">
          ${segmentsHtml}
        </div>
        <div class="ez-axis-x">${shortDate}</div>
      </div>
    `;
  }).join('');

  // 折线覆盖
  const step = series.length > 1 ? 100 / (series.length - 1) : 50;
  const linePoints = series.map((row, i) => {
    const x = (i * step).toFixed(2);
    const y = (90 - (row.requests / maxRequests) * 78).toFixed(2);
    return `${x},${y}`;
  }).join(' ');

  host.innerHTML = `
    <div class="ez-chart-scaffold">
      <div class="ez-axis-y">
        ${ticks.map((t) => `<span>${t.label}</span>`).join('')}
      </div>

      <div class="ez-plot-stage">
        <!-- 背景水平虚线 -->
        <div class="ez-grid-backdrop">
          <div class="ez-grid-line"></div>
          <div class="ez-grid-line"></div>
          <div class="ez-grid-line"></div>
          <div class="ez-grid-line"></div>
          <div class="ez-grid-line is-zero"></div>
        </div>

        <!-- 频次折线 -->
        <svg class="ez-line-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="${linePoints}" vector-effect="non-scaling-stroke"></polyline>
        </svg>

        <!-- 柱形集合 -->
        <div class="ez-bars-track">
          ${barsHtml}
        </div>
      </div>
    </div>
  `;
}

// ── 排行多维数据收集 ──
function collectRankRows(series) {
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
      badge: acc.provider || 'CPA',
      requests: Number(acc.requests) || 0,
      tokens: (Number(acc.input) || 0) + (Number(acc.output) || 0) + (Number(acc.cache_read) || 0) + (Number(acc.cache_write) || 0),
    })).sort((a, b) => b.tokens - a.tokens).slice(0, 15);
  }

  // rankKind === 'source'
  const sources = STATS_STATE.local?.sources || {};
  const list = Object.entries(sources).map(([k, u]) => {
    let title = k;
    let badge = '旁路日志';
    if (k === 'claude-code') { title = 'Claude Code CLI'; badge = '~/.claude'; }
    else if (k === 'cursor') { title = 'Cursor IDE'; badge = 'cursor-core.db'; }
    else if (k === 'cpa') { title = 'CPA 套件代理池'; badge = 'usage.sqlite'; }
    return {
      name: title,
      badge,
      requests: Number(u.requests) || 0,
      tokens: (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cache_read) || 0) + (Number(u.cache_write) || 0),
    };
  });

  if (STATS_STATE.gateway) {
    const g = STATS_STATE.gateway;
    list.push({
      name: 'AnyBridge 本地网关',
      badge: '实时代理',
      requests: Number(g.requests) || 0,
      tokens: (Number(g.inputTokens) || 0) + (Number(g.outputTokens) || 0) + (Number(g.cachedTokens) || 0),
    });
  }

  return list.sort((a, b) => b.tokens - a.tokens);
}

function renderStatsRankTable(series) {
  const host = document.getElementById('statsRankTable');
  if (!host) return;
  const rows = collectRankRows(series);

  if (!rows.length) {
    host.innerHTML = '<div class="ez-empty-state">当前周期内无排行数据</div>';
    return;
  }

  const maxVal = Math.max(...rows.map((r) => r.tokens), 1);

  host.innerHTML = rows.map((r) => {
    const pct = Math.max(1.5, Math.round((r.tokens / maxVal) * 100));
    return `
      <div class="ez-rank-item">
        <div class="ez-rank-who">
          <span class="ez-rank-name" title="${escapeText(r.name)}">${escapeText(r.name)}</span>
          ${r.badge ? `<span class="ez-rank-tag">${escapeText(r.badge)}</span>` : ''}
        </div>
        <div class="ez-rank-mono">${fmtNum(r.requests)} 次</div>
        <div class="ez-rank-mono is-bold">${fmtNum(r.tokens)}</div>
        <div class="ez-rank-meter">
          <div class="ez-meter-track">
            <div class="ez-meter-fill" style="width: ${pct}%;"></div>
          </div>
          <span class="ez-meter-val">${pct}%</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── 渲染数据通道卡片矩阵 ──
function renderStatsSourcesDeck() {
  const host = document.getElementById('statsSourcesDeck');
  if (!host) return;

  const local = STATS_STATE.local || {};
  const sources = local.sources || {};
  const gateway = STATS_STATE.gateway;
  const cards = [];

  if (gateway) {
    cards.push(`
      <div class="ez-channel-card">
        <div class="ez-ch-top">
          <span class="ez-ch-name">AnyBridge 网关代理</span>
          <span class="ez-ch-badge">核心通道</span>
        </div>
        <div class="ez-ch-stats">
          <div class="ez-ch-row"><span>今日调用</span><b>${fmtNum(gateway.requests)} 次</b></div>
          <div class="ez-ch-row"><span>Token</span><b>${fmtNum((gateway.inputTokens || 0) + (gateway.outputTokens || 0))}</b></div>
        </div>
      </div>
    `);
  }

  if (sources.cpa) {
    const accs = local.cpaAccounts ? local.cpaAccounts.length : 0;
    cards.push(`
      <div class="ez-channel-card">
        <div class="ez-ch-top">
          <span class="ez-ch-name">CPA 套件 (CLIProxyAPI)</span>
          <span class="ez-ch-badge">${accs} 账号</span>
        </div>
        <div class="ez-ch-stats">
          <div class="ez-ch-row"><span>总调用</span><b>${fmtNum(sources.cpa.requests)} 次</b></div>
          <div class="ez-ch-row"><span>全量吞吐</span><b>${fmtNum(sources.cpa.input + sources.cpa.output)}</b></div>
        </div>
      </div>
    `);
  }

  if (sources['claude-code']) {
    cards.push(`
      <div class="ez-channel-card">
        <div class="ez-ch-top">
          <span class="ez-ch-name">Claude Code CLI</span>
          <span class="ez-ch-badge">~/.claude</span>
        </div>
        <div class="ez-ch-stats">
          <div class="ez-ch-row"><span>会话调用</span><b>${fmtNum(sources['claude-code'].requests)} 次</b></div>
          <div class="ez-ch-row"><span>吞吐</span><b>${fmtNum(sources['claude-code'].input + sources['claude-code'].output)}</b></div>
        </div>
      </div>
    `);
  }

  if (sources.cursor) {
    cards.push(`
      <div class="ez-channel-card">
        <div class="ez-ch-top">
          <span class="ez-ch-name">Cursor Core 数据库</span>
          <span class="ez-ch-badge">SQLite</span>
        </div>
        <div class="ez-ch-stats">
          <div class="ez-ch-row"><span>LLM Calls</span><b>${fmtNum(sources.cursor.requests)} 次</b></div>
          <div class="ez-ch-row"><span>吞吐</span><b>${fmtNum(sources.cursor.input + sources.cursor.output)}</b></div>
        </div>
      </div>
    `);
  }

  host.innerHTML = cards.length ? cards.join('') : '<div class="ez-empty-state">未发现活跃通道</div>';

  const meta = document.getElementById('statsSourcesLastScan');
  if (meta && local.scannedAt) {
    meta.textContent = `旁路同步于 ${new Date(local.scannedAt).toLocaleTimeString()}`;
  }
}

// ── 渲染实时审计表格 ──
function renderStatsRecentTable() {
  const tbody = document.getElementById('statsRecentTbody');
  if (!tbody) return;
  const rows = STATS_STATE.gateway?.recent || [];

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="ez-empty-state">当前网关无最近会话调用</td></tr>';
    return;
  }

  const clamp = (text, max = 70) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };

  tbody.innerHTML = rows.slice(0, 20).map((e) => {
    const timeStr = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
    let statusBadge = '<span class="ez-pill-state is-ok">成功</span>';
    let routeDesc = '';
    let metaText = escapeText(e.provider || '默认网关');

    if (e.type === 'error') {
      statusBadge = '<span class="ez-pill-state is-err">失败</span>';
      routeDesc = `<span style="color:#b91c1c;">${escapeText(clamp(e.message))}</span>`;
    } else if (e.type === 'retry') {
      statusBadge = `<span class="ez-pill-state is-warn">重试 ×${Number(e.count) || 1}</span>`;
      routeDesc = `<span style="color:#b45309;">${escapeText(clamp(e.reason))}</span>`;
    } else {
      const reqM = e.requestedModel || '';
      const resM = e.resolvedModel || '';
      if (reqM && resM && reqM !== resM) {
        routeDesc = `<div class="ez-cell-route"><span class="from">${escapeText(reqM)}</span><span class="arrow">→</span><span class="to">${escapeText(resM)}</span></div>`;
      } else {
        routeDesc = `<span>${escapeText(resM || reqM || '未指定')}</span>`;
      }
    }

    return `
      <tr>
        <td class="ez-cell-time">${timeStr}</td>
        <td>${statusBadge}</td>
        <td class="ez-cell-channel">${metaText}</td>
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
  renderStatsTrend(series);
  renderStatsRankTable(series);
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
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    });
    onChange(value);
  });
}

function bindStatsPage() {
  // 时间周期切换
  bindSeg('#page-stats .ez-pill-nav[aria-label="统计周期"]', 'data-stats-range', (value) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next === STATS_STATE.range) return;
    STATS_STATE.range = next;
    loadStats();
  });

  // 来源过滤切换
  bindSeg('#page-stats .ez-pill-nav[aria-label="数据来源"]', 'data-stats-source-filter', (value) => {
    STATS_STATE.sourceFilter = value;
    renderStatsAll();
  });

  // 指标切换
  bindSeg('#page-stats .ez-pill-nav[aria-label="图表指标"]', 'data-stats-metric', (value) => {
    STATS_STATE.metric = value;
    renderStatsTrend(buildDaySeries());
  });

  // 排行视图切换
  bindSeg('#page-stats .ez-pill-nav[aria-label="排行视图"]', 'data-stats-rank', (value) => {
    STATS_STATE.rank = value;
    renderStatsRankTable(buildDaySeries());
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
