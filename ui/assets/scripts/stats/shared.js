// stats/shared.js — 统计引擎共享状态、来源注册表与日序/格式化工具

export const STATS_STATE = {
  range: 14,            // 1 / 7 / 14 / 30 / 0=全部（默认 14 天提供密集丰满的数据点）
  sourceFilter: 'all',  // all / cpa / claude / gateway
  metric: 'tokens',     // tokens / requests / cost
  rank: 'model',        // model / account / source
  loading: false,
  gateway: null,
  history: [],
  local: null,
  // 采集开关：由 Rust 的 get_stats_settings 返回
  settings: { disabledSources: [], availableSources: [] },
};

/** 可开关采集的旁路来源展示信息（网关账本由 sidecar 写，不在此列）。 */
export const BYPASS_SOURCE_META = {
  'claude-code': { label: 'Claude Code', hint: '~/.claude' },
  cursor: { label: 'Cursor', hint: 'cursor-core.db' },
  cpa: { label: 'CPA 套件', hint: 'usage.sqlite' },
  pi: { label: 'Pi', hint: 'usage.jsonl' },
  zcode: { label: 'ZCode', hint: 'model_usage' },
};

export const statsChartState = { mainInstance: null, sparkInstances: {} };

export function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 100_000_000 ? 1 : 2) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return String(Math.round(v));
}

export function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'K';
  return '$' + v.toFixed(2);
}

// 按当前指标选择格式化方式：费用走 $，其余走 K/M/B。
// ECharts 的 yAxis formatter 依赖它，缺失会在 setOption 内抛 ReferenceError。
export function fmtMetric(value, metric) {
  return metric === 'cost' ? fmtCost(value) : fmtNum(value);
}

export function dayKeyLocal(d) {
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function recentDayKeys(count) {
  const out = [];
  const today = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push(dayKeyLocal(d));
  }
  return out;
}

export function rangeDays() {
  return STATS_STATE.range === 0 ? 366 : STATS_STATE.range;
}

export function historyDaysToFetch() {
  return 371;
}

// ── 来源登记表：id → 展示名 + 取数方式 ──
// 新增旁路来源只需在这里加一行（并由扫描器写入对应的 day 桶），筛选器会自动出现。
export const STATS_SOURCES = {
  gateway: { label: '网关', bucket: null },
  'claude-code': { label: 'Claude Code', bucket: 'days' },
  cursor: { label: 'Cursor', bucket: 'cursorDays' },
  cpa: { label: 'CPA 套件', bucket: 'cpaDays' },
  pi: { label: 'Pi', bucket: 'piDays' },
  zcode: { label: 'ZCode', bucket: 'zcodeDays' },
};

export function sourceLabel(id) {
  return STATS_SOURCES[id]?.label || id;
}

/** 当前实际扫到的来源（含网关），顺序：网关 → 内置顺序 → 未知来源按 id 排。 */
export function discoveredSources() {
  const sources = STATS_STATE.local?.sources || {};
  const ids = new Set(Object.keys(sources));
  if (STATS_STATE.gateway) ids.add('gateway');

  const known = Object.keys(STATS_SOURCES).filter((id) => ids.has(id));
  const unknown = [...ids].filter((id) => !STATS_SOURCES[id]).sort();
  return [...known, ...unknown];
}

/** 该来源在给定日期桶里是否有数据（用于「有按钮就一定有数」）。 */
export function localBucketOf(id) {
  const bucket = STATS_SOURCES[id]?.bucket;
  if (!bucket) return null;
  return STATS_STATE.local?.[bucket] || null;
}

// ── 构建日序综合数据集（支持来源过滤） ──
export function buildDaySeries() {
  const only = STATS_STATE.sourceFilter;
  const include = (id) => only === 'all' || only === id;

  const gatewayByDay = new Map();
  if (include('gateway')) {
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

  // 参与本次统计的旁路桶（受来源筛选控制）
  const activeBuckets = Object.keys(STATS_SOURCES)
    .filter((id) => include(id))
    .map(localBucketOf)
    .filter(Boolean);

  const allDays = new Set([...gatewayByDay.keys()]);
  for (const bucket of activeBuckets) {
    Object.keys(bucket).forEach((day) => allDays.add(day));
  }

  const rows = [...allDays].sort().map((day) => {
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

export function splitRanges(series) {
  const half = Math.floor(series.length / 2);
  if (half === 0) return { current: series, previous: [] };
  return {
    current: series.slice(-half),
    previous: series.slice(0, series.length - half),
  };
}

export function sumSeries(series) {
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

// ── ECharts 微型 Sparkline 渲染器 ──
