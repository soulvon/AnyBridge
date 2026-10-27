/**
 * 67-stats.js — 统计与全局账本交互引擎
 *
 * 核心设计目标：
 * 1. 规避死板简陋的纯文本列表，采用现代控制台视觉（深浅模式兼容）。
 * 2. 精确计算 Token 输入/输出/缓存 3段堆叠柱状图，计算真实折线坐标。
 * 3. 整合 CPA、Claude Code、Cursor 与 网关的消耗，支持来源筛选。
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

// ── 构建日序综合数据集（支持来源过滤） ──
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

// ── 渲染迷你火花线 ──
function renderSparkSvg(id, values, colorVar = 'var(--accent)') {
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
  const h = 32;
  const pad = 3;
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

// ── 渲染 KPI 4联卡 ──
function renderTrendBadge(id, current, previous, { inverse = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!previous || previous <= 0) {
    el.textContent = '持平';
    el.className = 'stats-trend-badge is-neutral';
    return;
  }
  const delta = (current - previous) / previous;
  const pct = Math.abs(delta * 100);
  const up = delta >= 0;
  const good = inverse ? !up : up;
  el.textContent = `${up ? '↑' : '↓'} ${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
  el.className = `stats-trend-badge ${good ? 'is-up' : 'is-down'}`;
}

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
  set('statsKpiRequestsSub', STATS_STATE.range === 0 ? '历史全量累计' : `近 ${rangeDays()} 天调用量`);

  set('statsKpiTokens', fmtNum(totalTokens));
  set('statsKpiTokensSub', `输入 ${fmtNum(sum.input)} · 输出 ${fmtNum(sum.output)} · 缓存 ${fmtNum(sum.cache)}`);

  // 计算三段比例
  const safeTotal = totalTokens || 1;
  const inputPct = Math.max(0, (sum.input / safeTotal) * 100);
  const outputPct = Math.max(0, (sum.output / safeTotal) * 100);
  const cachePct = Math.max(0, (sum.cache / safeTotal) * 100);

  const inputEl = document.getElementById('statsTokenInputSeg');
  const outputEl = document.getElementById('statsTokenOutputSeg');
  const cacheEl = document.getElementById('statsTokenCacheSeg');
  if (inputEl) inputEl.style.width = `${inputPct.toFixed(1)}%`;
  if (outputEl) outputEl.style.width = `${outputPct.toFixed(1)}%`;
  if (cacheEl) cacheEl.style.width = `${cachePct.toFixed(1)}%`;

  set('statsKpiCost', fmtCost(sum.cost));
  set('statsKpiCostSub', STATS_STATE.sourceFilter === 'gateway' ? '网关精确估算' : '含网关直连，旁路暂不计价');

  const gwRequests = sum.gatewayRequests;
  const successRate = gwRequests > 0 ? (1 - sum.errors / gwRequests) * 100 : 100;
  set('statsKpiSuccess', `${successRate.toFixed(1)}%`);
  set('statsKpiSuccessSub', sum.errors > 0 ? `网关阻断/错误 ${fmtNum(sum.errors)} 次` : '网关流量无异常阻断');

  const healthPill = document.getElementById('statsHealthStatus');
  if (healthPill) {
    if (successRate >= 99) {
      healthPill.className = 'stats-health-pill is-ok';
      healthPill.textContent = '运行通畅';
    } else if (successRate >= 90) {
      healthPill.className = 'stats-health-pill is-warn';
      healthPill.textContent = '偶发波动';
    } else {
      healthPill.className = 'stats-health-pill is-err';
      healthPill.textContent = '异常频发';
    }
  }

  renderTrendBadge('statsTrendRequests', sum.requests, prev.requests);
  renderTrendBadge('statsTrendTokens', totalTokens, prevTokens);
  renderTrendBadge('statsTrendCost', sum.cost, prev.cost);

  // Sparklines
  renderSparkSvg('statsSparkRequests', current.map((r) => r.requests), 'var(--accent, #1261A6)');
  renderSparkSvg('statsSparkCost', current.map((r) => r.cost), 'var(--accent-warm, #D97706)');
  renderSparkSvg('statsSparkSuccess', current.map((r) => (r.gatewayRequests > 0 ? Math.max(0, 100 - (r.errors / r.gatewayRequests) * 100) : 100)), 'var(--success, #11875D)');
}

// ── 渲染主折柱混合大图 ──
function renderStatsTrend(series) {
  const host = document.getElementById('statsTrendChart');
  if (!host) return;
  const metric = STATS_STATE.metric;

  if (!series.length) {
    host.innerHTML = '<div class="stats-empty-shimmer">当前时间范围暂无用量记录</div>';
    return;
  }

  const values = series.map((r) => metricValue(r, metric));
  const max = Math.max(...values, 1);
  const maxRequests = Math.max(...series.map((r) => r.requests), 1);

  // 4段 Y 轴刻度
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
    ratio,
    label: fmtMetric(max * ratio, metric),
  }));

  // 生成三段堆叠柱或纯量柱
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
        <div class="stats-bar-stack" style="height: ${Math.max(heightPct, 2).toFixed(1)}%;">
          <span class="stats-seg-bar is-cache" style="height: ${cachePct.toFixed(1)}%;"></span>
          <span class="stats-seg-bar is-output" style="height: ${outPct.toFixed(1)}%;"></span>
          <span class="stats-seg-bar is-input" style="height: ${inPct.toFixed(1)}%;"></span>
        </div>
      `;
    } else {
      segmentsHtml = `
        <div class="stats-bar-stack" style="height: ${Math.max(heightPct, 2).toFixed(1)}%;">
          <span class="stats-seg-bar is-primary" style="height: 100%;"></span>
        </div>
      `;
    }

    const shortDate = row.day.slice(5);
    const tip = `日期: ${row.day}\n总Token: ${fmtNum(row.input + row.output + row.cache)} (入:${fmtNum(row.input)} 出:${fmtNum(row.output)} 缓:${fmtNum(row.cache)})\n请求: ${fmtNum(row.requests)} 次\n费用估算: ${fmtCost(row.cost)}`;

    return `
      <div class="stats-bar-col" title="${escapeText(tip)}">
        <div class="stats-bar-hover-val">${totalVal > 0 ? fmtMetric(totalVal, metric) : ''}</div>
        <div class="stats-bar-track">
          ${segmentsHtml}
        </div>
        <div class="stats-bar-axis-x">${shortDate}</div>
      </div>
    `;
  }).join('');

  // 折线坐标映射
  const step = series.length > 1 ? 100 / (series.length - 1) : 50;
  const linePoints = series.map((row, i) => {
    const x = (i * step).toFixed(2);
    // 映射在 10% - 90% 高度区间
    const y = (90 - (row.requests / maxRequests) * 78).toFixed(2);
    return `${x},${y}`;
  }).join(' ');

  host.innerHTML = `
    <div class="stats-chart-scaffold">
      <div class="stats-axis-y">
        ${ticks.map((t) => `<span class="stats-tick-label">${t.label}</span>`).join('')}
      </div>

      <div class="stats-plot-area">
        <!-- 背景水平网格参考线 -->
        <div class="stats-grid-lines">
          <div class="stats-grid-line"></div>
          <div class="stats-grid-line"></div>
          <div class="stats-grid-line"></div>
          <div class="stats-grid-line"></div>
          <div class="stats-grid-line is-base"></div>
        </div>

        <!-- 请求数趋势覆盖线 -->
        <svg class="stats-req-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="${linePoints}" vector-effect="non-scaling-stroke"></polyline>
        </svg>

        <!-- 柱状图集合 -->
        <div class="stats-bars-flex">
          ${barsHtml}
        </div>
      </div>
    </div>
  `;
}

// ── 排行多维数据抽取 ──
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

    // 历程
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
    return [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 16);
  }

  if (rankKind === 'account') {
    const accounts = STATS_STATE.local?.cpaAccounts || [];
    return accounts.map((acc) => ({
      name: acc.account,
      badge: acc.provider,
      requests: Number(acc.requests) || 0,
      tokens: (Number(acc.input) || 0) + (Number(acc.output) || 0) + (Number(acc.cache_read) || 0) + (Number(acc.cache_write) || 0),
      failed: Number(acc.failed) || 0,
    })).sort((a, b) => b.tokens - a.tokens).slice(0, 16);
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
    host.innerHTML = '<div class="stats-empty">当前周期内无维度排行数据</div>';
    return;
  }

  const maxVal = Math.max(...rows.map((r) => r.tokens), 1);

  host.innerHTML = `
    <table class="stats-pro-table">
      <thead>
        <tr>
          <th>名称 / 身份</th>
          <th style="width: 110px; text-align: right;">调用频次</th>
          <th style="width: 140px; text-align: right;">总计消耗</th>
          <th style="width: 180px;">用量占比</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const pct = Math.max(1, Math.round((row.tokens / maxVal) * 100));
          return `
            <tr>
              <td>
                <div class="stats-name-col">
                  <span class="stats-primary-text" title="${escapeText(row.name)}">${escapeText(row.name)}</span>
                  ${row.badge ? `<span class="stats-sub-badge">${escapeText(row.badge)}</span>` : ''}
                </div>
              </td>
              <td style="text-align: right;">
                <span class="stats-num-mono">${fmtNum(row.requests)}</span>
              </td>
              <td style="text-align: right;">
                <span class="stats-num-mono is-bold">${fmtNum(row.tokens)}</span>
              </td>
              <td>
                <div class="stats-table-meter">
                  <div class="stats-meter-fill" style="width: ${pct}%;"></div>
                  <span class="stats-meter-text">${pct}%</span>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── 渲染数据源与健康面板 ──
function renderStatsSourcesDeck() {
  const host = document.getElementById('statsSourcesDeck');
  if (!host) return;

  const local = STATS_STATE.local || {};
  const sources = local.sources || {};
  const gateway = STATS_STATE.gateway;

  const cards = [];

  // 网关卡
  if (gateway) {
    cards.push(`
      <div class="stats-source-card">
        <div class="stats-sc-head">
          <span class="stats-sc-status is-active"></span>
          <span class="stats-sc-title">AnyBridge 网关代理</span>
          <span class="stats-sc-tag">核心</span>
        </div>
        <div class="stats-sc-body">
          <div class="stats-sc-stat"><span class="label">今日请求</span><strong>${fmtNum(gateway.requests)}</strong></div>
          <div class="stats-sc-stat"><span class="label">Token</span><strong>${fmtNum((gateway.inputTokens || 0) + (gateway.outputTokens || 0))}</strong></div>
        </div>
      </div>
    `);
  }

  // CPA 套件卡
  if (sources.cpa) {
    const cpaAccCount = local.cpaAccounts ? local.cpaAccounts.length : 0;
    cards.push(`
      <div class="stats-source-card">
        <div class="stats-sc-head">
          <span class="stats-sc-status is-active"></span>
          <span class="stats-sc-title">CPA 套件 (CLIProxyAPI)</span>
          <span class="stats-sc-tag">已接入</span>
        </div>
        <div class="stats-sc-body">
          <div class="stats-sc-stat"><span class="label">挂载账号</span><strong>${cpaAccCount} 个</strong></div>
          <div class="stats-sc-stat"><span class="label">全量调用</span><strong>${fmtNum(sources.cpa.requests)}</strong></div>
          <div class="stats-sc-stat"><span class="label">Token 吞吐</span><strong>${fmtNum(sources.cpa.input + sources.cpa.output)}</strong></div>
        </div>
      </div>
    `);
  }

  // Claude Code 卡
  if (sources['claude-code']) {
    cards.push(`
      <div class="stats-source-card">
        <div class="stats-sc-head">
          <span class="stats-sc-status is-active"></span>
          <span class="stats-sc-title">Claude Code CLI</span>
          <span class="stats-sc-tag">本地旁路</span>
        </div>
        <div class="stats-sc-body">
          <div class="stats-sc-stat"><span class="label">会话请求</span><strong>${fmtNum(sources['claude-code'].requests)}</strong></div>
          <div class="stats-sc-stat"><span class="label">吞吐</span><strong>${fmtNum(sources['claude-code'].input + sources['claude-code'].output)}</strong></div>
        </div>
      </div>
    `);
  }

  // Cursor IDE 卡
  if (sources.cursor) {
    cards.push(`
      <div class="stats-source-card">
        <div class="stats-sc-head">
          <span class="stats-sc-status is-active"></span>
          <span class="stats-sc-title">Cursor Core 数据库</span>
          <span class="stats-sc-tag">SQLite</span>
        </div>
        <div class="stats-sc-body">
          <div class="stats-sc-stat"><span class="label">LLM Calls</span><strong>${fmtNum(sources.cursor.requests)}</strong></div>
          <div class="stats-sc-stat"><span class="label">吞吐</span><strong>${fmtNum(sources.cursor.input + sources.cursor.output)}</strong></div>
        </div>
      </div>
    `);
  }

  if (!cards.length) {
    host.innerHTML = '<div class="stats-empty">未发现活跃的旁路数据源</div>';
    return;
  }

  host.innerHTML = `<div class="stats-sources-grid">${cards.join('')}</div>`;

  const meta = document.getElementById('statsSourcesLastScan');
  if (meta && local.scannedAt) {
    meta.textContent = `最近扫描同步于 ${new Date(local.scannedAt).toLocaleTimeString()}`;
  }
}

// ── 渲染实时审计日志表格 ──
function renderStatsRecentTable() {
  const tbody = document.getElementById('statsRecentTbody');
  if (!tbody) return;
  const rows = STATS_STATE.gateway?.recent || [];

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="stats-empty">当前网关无最近会话调用</td></tr>';
    return;
  }

  const clamp = (text, max = 80) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };

  tbody.innerHTML = rows.slice(0, 20).map((e) => {
    const timeStr = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
    let statusBadge = '<span class="stats-pill-status is-ok">成功</span>';
    let routeDesc = '';
    let metaText = escapeText(e.provider || '默认通道');

    if (e.type === 'error') {
      statusBadge = '<span class="stats-pill-status is-err">失败</span>';
      routeDesc = `<span class="stats-err-msg" title="${escapeText(e.message)}">${escapeText(clamp(e.message))}</span>`;
    } else if (e.type === 'retry') {
      statusBadge = `<span class="stats-pill-status is-warn">重试 ×${Number(e.count) || 1}</span>`;
      routeDesc = `<span class="stats-warn-msg" title="${escapeText(e.reason)}">${escapeText(clamp(e.reason))}</span>`;
    } else {
      const reqM = e.requestedModel || '';
      const resM = e.resolvedModel || '';
      if (reqM && resM && reqM !== resM) {
        routeDesc = `<div class="stats-route-arrow"><span class="from">${escapeText(reqM)}</span><span class="arrow">→</span><span class="to">${escapeText(resM)}</span></div>`;
      } else {
        routeDesc = `<span class="stats-model-name">${escapeText(resM || reqM || '未指定')}</span>`;
      }
    }

    return `
      <tr>
        <td class="stats-time-cell">${timeStr}</td>
        <td>${statusBadge}</td>
        <td class="stats-channel-cell">${metaText}</td>
        <td>${routeDesc}</td>
        <td style="text-align: right;" class="stats-mono-cell">—</td>
      </tr>
    `;
  }).join('');
}

// ── 全量同步装配 ──
function renderStatsAll() {
  const series = buildDaySeries();
  renderStatsKpi(series);
  renderStatsTrend(series);
  renderStatsRankTable(series);
  renderStatsSourcesDeck();
  renderStatsRecentTable();
}

function statsSkeleton() {
  const chart = document.getElementById('statsTrendChart');
  if (chart) chart.innerHTML = '<div class="stats-empty-shimmer">正在汇总历史账本…</div>';
}

async function loadStats({ silent = false } = {}) {
  if (STATS_STATE.loading) return;
  STATS_STATE.loading = true;
  if (!silent) statsSkeleton();
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

    // 后台静默复查旁路源，获取新增后自刷新
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
  // 时间范围切换
  bindSeg('#page-stats .stats-capsule-group[aria-label="时间范围"]', 'data-stats-range', (value) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next === STATS_STATE.range) return;
    STATS_STATE.range = next;
    loadStats();
  });

  // 来源过滤切换
  bindSeg('#page-stats .stats-capsule-group[aria-label="来源过滤"]', 'data-stats-source-filter', (value) => {
    STATS_STATE.sourceFilter = value;
    renderStatsAll();
  });

  // 指标切换
  bindSeg('#page-stats .stats-seg-control[aria-label="图表指标"]', 'data-stats-metric', (value) => {
    STATS_STATE.metric = value;
    renderStatsTrend(buildDaySeries());
  });

  // 排行维度切换
  bindSeg('#page-stats .stats-seg-control[aria-label="排行维度"]', 'data-stats-rank', (value) => {
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
