// stats/tables-and-heatmap.js — 排行表、数据通道卡片、全年热力图与审计明细表
import { STATS_STATE, BYPASS_SOURCE_META, STATS_SOURCES, escapeText, fmtNum, fmtCost, fmtMetric, dayKeyLocal, recentDayKeys, rangeDays, historyDaysToFetch, sourceLabel, discoveredSources, localBucketOf, buildDaySeries, splitRanges, sumSeries } from './shared.js';

export function collectRankRows(series) {
  const rankKind = STATS_STATE.rank;

  if (rankKind === 'model') {
    const map = new Map();
    // 同名模型可能以 "gemini-3.8-flash" / "Gemini 3.8 Flash" 两种写法出现（网关与旁路账本各记各的），
    // 归一成小写去空格后再合并，否则排行榜会把同一个模型拆成两行。
    const normKey = (model) => String(model).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.\-_]/g, '');
    const add = (model, usage) => {
      if (!model) return;
      const key = normKey(model);
      const cur = map.get(key) || { name: String(model).trim(), requests: 0, tokens: 0, input: 0, output: 0, cache: 0 };
      const inp = Number(usage.input) || 0;
      const out = Number(usage.output) || 0;
      const cch = (Number(usage.cache_read) || 0) + (Number(usage.cache_write) || 0);
      cur.tokens += inp + out + cch;
      cur.input += inp;
      cur.output += out;
      cur.cache += cch;
      cur.requests += Number(usage.requests) || 0;
      map.set(key, cur);
    };

    // 历程
    const days = new Set(series.map((r) => r.day));
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

    // 若当前周期内无增量模型，退回展示全周期已有模型，杜绝空白
    if (map.size === 0) {
      for (const b of [local.days, local.cursorDays, local.cpaDays]) {
        for (const models of Object.values(b || {})) {
          for (const [m, u] of Object.entries(models || {})) add(m, u);
        }
      }
    }

    return [...map.values()].sort((a, b) => (b.tokens || b.requests) - (a.tokens || a.requests)).slice(0, 15);
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
      badge: '实时网关',
      requests: Number(g.requests) || 0,
      tokens: (Number(g.inputTokens) || 0) + (Number(g.outputTokens) || 0) + (Number(g.cachedTokens) || 0),
    });
  }

  return list.sort((a, b) => b.tokens - a.tokens);
}

export function renderStatsRankTable(series) {
  const host = document.getElementById('statsRankTable');
  if (!host) return;
  const rows = collectRankRows(series);

  if (!rows.length) {
    host.innerHTML = '<div class="ez-empty-state">当前周期内无排行数据</div>';
    return;
  }

  const maxVal = Math.max(...rows.map((r) => r.tokens), 1);

  host.innerHTML = rows.map((r) => {
    // 真实占比：小项不再一律显示 1.5%，1% 以下显示 <1
    const ratio = maxVal > 0 ? (r.tokens / maxVal) * 100 : 0;
    const pctText = ratio >= 10 ? ratio.toFixed(0) : ratio >= 1 ? ratio.toFixed(1) : (ratio > 0 ? '<1' : '0');
    const pct = Math.max(ratio, 0.6);
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
          <span class="ez-meter-val">${pctText}%</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── 渲染数据通道卡片矩阵 ──
export function renderStatsSourcesDeck() {
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
          <span class="ez-ch-name">AnyBridge 本地网关</span>
          <span class="ez-ch-badge">核心通道</span>
        </div>
        <div class="ez-ch-stats">
          <div class="ez-ch-row"><span>今日调用</span><b>${fmtNum(gateway.requests)} 次</b></div>
          <div class="ez-ch-row"><span>Token</span><b>${fmtNum((gateway.inputTokens || 0) + (gateway.outputTokens || 0))}</b></div>
        </div>
      </div>
    `);
  }

  const overlapped = local.overlapped || {};
  for (const [id, usage] of Object.entries(sources)) {
    const meta = BYPASS_SOURCE_META[id] || { label: id, hint: '' };
    // CPA 额外显示账号数，其余显示读取位置
    const badge = id === 'cpa'
      ? `${(local.cpaAccounts || []).length} 账号`
      : (meta.hint || '旁路日志');
    // 经我们自己的账本转发过的部分已剔除，这里明确告知，避免「总量悄悄变小」
    const dup = overlapped[id];
    const dupLine = dup && dup.requests > 0
      ? `<div class="ez-ch-row is-muted"><span>已去重</span><b>${fmtNum(dup.requests)} 次</b></div>`
      : '';

    cards.push(`
      <div class="ez-channel-card">
        <div class="ez-ch-top">
          <span class="ez-ch-name">${escapeText(meta.label)}</span>
          <span class="ez-ch-badge">${escapeText(badge)}</span>
        </div>
        <div class="ez-ch-stats">
          <div class="ez-ch-row"><span>调用</span><b>${fmtNum(usage.requests)} 次</b></div>
          <div class="ez-ch-row"><span>吞吐</span><b>${fmtNum((Number(usage.input) || 0) + (Number(usage.output) || 0))}</b></div>
          ${dupLine}
        </div>
      </div>
    `);
  }

  if (cards.length) {
    host.innerHTML = cards.join('');
  } else {
    host.innerHTML = '<div class="ez-empty-state">未发现活跃通道</div>';
  }

  const meta = document.getElementById('statsSourcesLastScan');
  if (meta && local.scannedAt) {
    meta.textContent = `旁路同步于 ${new Date(local.scannedAt).toLocaleTimeString()}`;
  }
}

// ── 构建全年（53 周）多源融合日序，供热力图使用（与顶部来源筛选器联动）──
export function buildFullYearDayMap() {
  const only = STATS_STATE.sourceFilter;
  const include = (id) => only === 'all' || only === id;

  const gatewayByDay = new Map();
  if (include('gateway')) {
    for (const row of STATS_STATE.history) gatewayByDay.set(row.day, row);
    const daily = STATS_STATE.gateway?.daily;
    if (Array.isArray(daily)) {
      for (const row of daily) {
        if (!gatewayByDay.has(row.day)) {
          gatewayByDay.set(row.day, {
            day: row.day,
            requests: row.requests,
            errors: row.errors,
            inputTokens: row.tokens,
            outputTokens: 0,
            cachedTokens: row.cachedTokens,
          });
        }
      }
    }
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
      });
    }
  }

  const activeBuckets = Object.keys(STATS_SOURCES)
    .filter((id) => include(id))
    .map(localBucketOf)
    .filter(Boolean);

  const allDays = new Set([...gatewayByDay.keys()]);
  for (const bucket of activeBuckets) {
    Object.keys(bucket).forEach((day) => allDays.add(day));
  }

  const byDay = new Map();
  for (const day of [...allDays].sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const gw = gatewayByDay.get(day) || {};
    let localInput = 0;
    let localOutput = 0;
    let localCache = 0;
    let localRequests = 0;

    for (const bucket of activeBuckets) {
      for (const u of Object.values(bucket[day] || {})) {
        localInput += Number(u.input) || 0;
        localOutput += Number(u.output) || 0;
        localCache += (Number(u.cache_read) || 0) + (Number(u.cache_write) || 0);
        localRequests += Number(u.requests) || 0;
      }
    }

    const input = (Number(gw.inputTokens) || 0) + localInput;
    const output = (Number(gw.outputTokens) || 0) + localOutput;
    const cache = (Number(gw.cachedTokens) || 0) + localCache;
    const requests = (Number(gw.requests) || 0) + localRequests;
    byDay.set(day, {
      day,
      requests,
      input,
      output,
      cache,
      tokens: input + output + cache,
    });
  }
  return byDay;
}

// ── 渲染 Token 活动热力图（GitHub / ZCode 贡献图式，整整 53 周铺满 + 多源联动）──
export function renderTokenHeatmap() {
  const host = document.getElementById('statsTokenHeatmap');
  const kpisHost = document.getElementById('statsHeatmapKpis');
  if (!host) return;
  const byDay = buildFullYearDayMap();

  if (!byDay.size) {
    host.innerHTML = '<div style="font-size:12px; color:var(--text-tertiary); padding:16px 0; line-height:1.7;">还没有每日用量记录。产生请求后，这里会按天累积成全年热力图。</div>';
    if (kpisHost) kpisHost.innerHTML = '<span class="ez-badge">暂无数据</span>';
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeks = 53; // 完整 53 周（约 371 天）铺满整个卡片
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay()); // 对齐到周日

  let total = 0;
  let totalCache = 0;
  let maxTokens = 0;
  let activeDays = 0;
  let maxStreak = 0;
  let tempStreak = 0;
  let currentStreak = 0;

  // 按全年连续自然日扫描，精准算活跃天数、最长连续与当前连续
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = dayKeyLocal(cursor);
    const item = byDay.get(key);
    const tokens = Number(item?.tokens) || 0;
    const cache = Number(item?.cache) || 0;
    total += tokens;
    totalCache += cache;
    if (tokens > 0) {
      activeDays += 1;
      tempStreak += 1;
      if (tempStreak > maxStreak) maxStreak = tempStreak;
      if (tokens > maxTokens) maxTokens = tokens;
    } else {
      tempStreak = 0;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // 当前连续：若今天已有用量则取 tempStreak；若今天刚过零点还没请求，看昨天为止的连续天数
  currentStreak = tempStreak;
  if (currentStreak === 0) {
    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    while (yest >= start) {
      const item = byDay.get(dayKeyLocal(yest));
      if ((Number(item?.tokens) || 0) > 0) {
        currentStreak += 1;
        yest.setDate(yest.getDate() - 1);
      } else {
        break;
      }
    }
  }

  const cacheRate = total > 0 ? (totalCache / total) * 100 : 0;

  // 渲染热力图头部的 5 个指标胶囊
  if (kpisHost) {
    kpisHost.innerHTML = `
      <div class="ez-badge" style="display: inline-flex; gap: 4px; padding: 4px 10px; font-size: 12px;">
        <span style="color: var(--text-tertiary);">累计</span>
        <strong style="color: var(--text-primary);">${fmtNum(total)}</strong>
      </div>
      <div class="ez-badge" style="display: inline-flex; gap: 4px; padding: 4px 10px; font-size: 12px;">
        <span style="color: var(--text-tertiary);">活跃</span>
        <strong style="color: var(--text-primary);">${activeDays} 天</strong>
      </div>
      <div class="ez-badge" style="display: inline-flex; gap: 4px; padding: 4px 10px; font-size: 12px;">
        <span style="color: var(--text-tertiary);">当前连续</span>
        <strong style="color: var(--text-primary);">${currentStreak} 天</strong>
      </div>
      <div class="ez-badge" style="display: inline-flex; gap: 4px; padding: 4px 10px; font-size: 12px;">
        <span style="color: var(--text-tertiary);">最长连续</span>
        <strong style="color: var(--text-primary);">${maxStreak} 天</strong>
      </div>
      <div class="ez-badge" style="display: inline-flex; gap: 4px; padding: 4px 10px; font-size: 12px;">
        <span style="color: var(--text-tertiary);">单日最高</span>
        <strong style="color: var(--text-primary);">${fmtNum(maxTokens)}</strong>
      </div>
      <div class="ez-badge" style="display: inline-flex; gap: 4px; padding: 4px 10px; font-size: 12px;">
        <span style="color: var(--text-tertiary);">缓存占比</span>
        <strong style="color: var(--text-primary);">${cacheRate.toFixed(1)}%</strong>
      </div>
    `;
  }

  const max = Math.max(1, maxTokens);

  // 5 档色阶用「活跃日的四分位数」分档：对数映射在百万～十亿跨度下会把大半格子压成同一档，
  // 分位数能保证四档在画面上的面积大致均衡，深浅一眼可辨。
  const positives = [...byDay.values()]
    .map((d) => Number(d.tokens) || 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const quantile = (p) => {
    if (!positives.length) return 0;
    return positives[Math.min(positives.length - 1, Math.floor(positives.length * p))];
  };
  const t1 = quantile(0.25);
  const t2 = quantile(0.5);
  const t3 = quantile(0.85);
  const color = (value) => {
    const n = Number(value) || 0;
    if (!n) return 'var(--border)';
    if (n <= t1) return 'rgba(59,130,246,0.22)';
    if (n <= t2) return 'rgba(59,130,246,0.45)';
    if (n <= t3) return 'rgba(59,130,246,0.70)';
    return 'rgba(59,130,246,0.95)';
  };

  const cols = [];
  const monthLabels = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w += 1) {
    const cells = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) {
        cells.push(null);
        continue;
      }
      const key = dayKeyLocal(date);
      const row = byDay.get(key);
      cells.push({
        key,
        tokens: Number(row?.tokens) || 0,
        input: Number(row?.input) || 0,
        output: Number(row?.output) || 0,
        cache: Number(row?.cache) || 0,
        requests: Number(row?.requests) || 0,
      });
    }
    const first = cells.find(Boolean);
    const month = first ? Number(first.key.slice(5, 7)) - 1 : -1;
    let label = '';
    if (month >= 0 && month !== lastMonth) {
      label = `${month + 1}月`;
      lastMonth = month;
    }
    monthLabels.push(label);
    cols.push(cells);
  }

  // 左侧星期坐标（周日=0，只标 一/三/五 避免拥挤）
  const dowLabels = ['', '一', '', '三', '', '五', '']
    .map((txt) => `<div style="flex: 1 1 0%; display: flex; align-items: center; justify-content: flex-end; font-size: 12px; line-height: 1; color: var(--text-tertiary); padding-right: 4px; user-select: none;">${txt}</div>`)
    .join('');

  // 自适应宽度的网格列：每列 1fr 自适应伸缩，格子正方形，撑满整个卡片宽度
  const grid = cols.map((cells) => `
    <div style="flex: 1 1 0%; min-width: 9px; max-width: 16px; display: flex; flex-direction: column; gap: 3px;">
      ${cells.map((c) => (c
        ? `<div class="ez-hm-cell" data-day="${c.key}" data-tokens="${c.tokens}" data-in="${c.input}" data-out="${c.output}" data-cache="${c.cache}" data-req="${c.requests}" title="${c.key}&#10;总计：${fmtNum(c.tokens)} tokens（输入 ${fmtNum(c.input)} / 输出 ${fmtNum(c.output)} / 缓存 ${fmtNum(c.cache)}）&#10;请求：${fmtNum(c.requests)} 次" style="width: 100%; aspect-ratio: 1; border-radius: 2.5px; background: ${color(c.tokens)}; cursor: pointer;"></div>`
        : '<div style="width: 100%; aspect-ratio: 1;"></div>')).join('')}
    </div>
  `).join('');

  const labels = cols.map((_, i) => `
    <div style="flex: 1 1 0%; min-width: 9px; max-width: 16px; font-size: 12px; line-height: 1; color: var(--text-tertiary); overflow: visible; white-space: nowrap;">
      ${monthLabels[i] || ''}
    </div>
  `).join('');

  const legend = [0, t1, t2, t3, max]
    .map((v) => `<span style="display: inline-block; width: 11px; height: 11px; border-radius: 2.5px; background: ${color(v)};"></span>`)
    .join('');

  const sourceDesc = STATS_STATE.sourceFilter === 'all' ? '全部来源' : sourceLabel(STATS_STATE.sourceFilter);

  host.innerHTML = `
    <div style="display: flex; gap: 3px; width: 100%; align-items: stretch;">
      <div style="display: flex; flex-direction: column; gap: 3px; width: 20px; flex-shrink: 0;">${dowLabels}</div>
      <div style="display: flex; gap: 3px; flex: 1 1 0%; justify-content: space-between; align-items: stretch;">${grid}</div>
    </div>
    <div style="display: flex; gap: 3px; width: 100%; margin-top: 6px; padding-left: 23px; justify-content: space-between;">${labels}</div>
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 12px; font-size: 12px; color: var(--text-tertiary);">
      <span id="statsHeatmapDetail">53 周活动 · ${sourceDesc}（共 ${fmtNum(total)} tokens / ${activeDays} 天活跃，点任意格子查看单日明细）</span>
      <div style="display: flex; align-items: center; gap: 4px;">
        <span>少</span>${legend}<span>多</span>
      </div>
    </div>
  `;

  // 点击任意格子在左下角展示当天输入/输出/缓存与请求数明细
  if (!host.dataset.boundClick) {
    host.dataset.boundClick = '1';
    host.addEventListener('click', (ev) => {
      const cell = ev.target && ev.target.closest ? ev.target.closest('.ez-hm-cell') : null;
      if (!cell) return;
      const detailEl = document.getElementById('statsHeatmapDetail');
      if (!detailEl) return;
      const day = cell.dataset.day || '';
      const tok = Number(cell.dataset.tokens) || 0;
      const inp = Number(cell.dataset.in) || 0;
      const out = Number(cell.dataset.out) || 0;
      const cac = Number(cell.dataset.cache) || 0;
      const req = Number(cell.dataset.req) || 0;
      detailEl.innerHTML = `<strong style="color:var(--text-primary);">${escapeText(day)}</strong> · 共 <b>${fmtNum(tok)}</b> tokens（输入 ${fmtNum(inp)} · 输出 ${fmtNum(out)} · 缓存 ${fmtNum(cac)}）· <b>${fmtNum(req)}</b> 次请求`;
    });
  }
}

// ── 渲染实时审计表格 ──
export function renderStatsRecentTable() {
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

  const fmtMs = (ms) => {
    const v = Number(ms) || 0;
    return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
  };

  tbody.innerHTML = rows.slice(0, 20).map((e) => {
    const timeStr = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
    let statusBadge = '<span class="ez-pill-state is-ok">成功</span>';
    let routeDesc = '';
    const channel = escapeText(e.provider || '默认网关');

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

    // 消耗 / 耗时：请求开始时由 tracker 按 id 占位，结束后回补 tokens 与耗时
    const u = e.usage || null;
    const input = u ? (Number(u.input ?? u.inputTokens) || 0) : 0;
    const output = u ? (Number(u.output ?? u.outputTokens) || 0) : 0;
    const cache = u ? (Number(u.cacheRead ?? u.cachedTokens) || 0) : 0;
    const ms = Number(e.latencyMs) || 0;
    const usageBits = [];
    if (input || output) usageBits.push(`${fmtNum(input)} in / ${fmtNum(output)} out`);
    if (cache) usageBits.push(`缓存 ${fmtNum(cache)}`);
    if (ms) usageBits.push(fmtMs(ms));
    const usageHtml = usageBits.length
      ? `<span style="font-family:'JetBrains Mono',monospace; white-space: nowrap;">${usageBits.join(' · ')}</span>`
      : '<span style="color:var(--text-tertiary);">—</span>';

    const channelTags = [];
    if (e.stream) channelTags.push('<span class="ez-pill-state is-ok" style="font-size:12px; padding:1px 6px; line-height:18px;">流式</span>');
    if (e.statusCode) channelTags.push(`<span style="font-size:12px; color:var(--text-tertiary); font-family:monospace;">${Number(e.statusCode)}</span>`);

    return `
      <tr>
        <td class="ez-cell-time" style="white-space: nowrap;">${timeStr}</td>
        <td style="white-space: nowrap;">${statusBadge}</td>
        <td class="ez-cell-channel" style="white-space: nowrap;">
          <div style="display: inline-flex; align-items: center; gap: 6px;">
            <span style="font-weight: 500;">${channel}</span>
            ${channelTags.join('')}
          </div>
        </td>
        <td>${routeDesc}</td>
        <td style="text-align: right; white-space: nowrap;">${usageHtml}</td>
      </tr>
    `;
  }).join('');
}

// ── 来源筛选器：按实际扫到的数据源动态生成（热插拔） ──
// 没装的来源不会出现按钮，装了并扫到数据就自动多一个按钮，Cursor 之类不再选不到。
