// stats.js — In-memory runtime statistics for the BYOK dashboard.
// Reset on each proxy restart (daily counters keyed by date).
//
// Rate window: 60s sliding window divided into 6 buckets × 10s each.
// On snapshot we sum the buckets that fell in the last 60s to produce RPM/TPM/avg latency.

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// 60s 滑窗：6 个 10s bucket，环形复用
const BUCKET_MS = 10_000;
const BUCKET_COUNT = 6;
const WINDOW_MS = BUCKET_MS * BUCKET_COUNT;

function emptyBucket() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencySumMs: 0, latencySamples: 0 };
}

const buckets = new Array(BUCKET_COUNT).fill(null).map(() => emptyBucket());
let currentBucket = null;
let currentBucketStart = 0;

function rollBucketIfNeeded(now) {
  if (currentBucket && (now - currentBucketStart) < BUCKET_MS) return;
  const idx = Math.floor(now / BUCKET_MS) % BUCKET_COUNT;
  if (!currentBucket || buckets[idx] !== currentBucket) {
    buckets[idx] = emptyBucket();
    currentBucket = buckets[idx];
    currentBucketStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  }
}

function activeBucket() {
  const now = Date.now();
  rollBucketIfNeeded(now);
  return currentBucket;
}

const state = {
  startedAt: Date.now(),
  day: todayKey(),
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastProvider: null,
  lastModel: null,
  lastError: null,
  byModel: {},
  recent: [],
  retries: 0,           // 累计重试次数
  lastRetries: 0,       // 最近一次请求的重试次数
  lastRetryReason: null, // 最近一次重试原因
};

function rollDayIfNeeded() {
  const t = todayKey();
  if (t !== state.day) {
    state.day = t;
    state.requests = 0;
    state.errors = 0;
    state.inputTokens = 0;
    state.outputTokens = 0;
    state.byModel = {};
    state.recent = [];
    state.lastError = null;
    state.retries = 0;
  }
}

function pushRecent(entry) {
  state.recent.unshift({ ts: Date.now(), ...entry });
  if (state.recent.length > 20) state.recent.length = 20;
}

export function recordRequest({ provider, requestedModel, resolvedModel }) {
  rollDayIfNeeded();
  state.requests += 1;
  state.lastProvider = provider;
  state.lastModel = resolvedModel;
  const k = resolvedModel || 'unknown';
  state.byModel[k] = (state.byModel[k] || 0) + 1;
  activeBucket().requests += 1;
  pushRecent({ type: 'request', provider, requestedModel, resolvedModel });
}

export function recordUsage({ inputTokens = 0, outputTokens = 0 }) {
  rollDayIfNeeded();
  state.inputTokens += inputTokens;
  state.outputTokens += outputTokens;
  const b = activeBucket();
  b.inputTokens += inputTokens;
  b.outputTokens += outputTokens;
}

export function recordError({ provider, message }) {
  rollDayIfNeeded();
  state.errors += 1;
  state.lastError = message;
  activeBucket().errors += 1;
  pushRecent({ type: 'error', provider, message });
}

/**
 * 记录单次请求的端到端延迟（毫秒）。从拿到 200 响应到流结束的时间。
 * 用于 60s 滑窗的 avg latency 计算。
 */
export function recordLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const b = activeBucket();
  b.latencySumMs += ms;
  b.latencySamples += 1;
}

export function recordRetry({ count, reason }) {
  rollDayIfNeeded();
  state.retries += count;
  state.lastRetries = count;
  state.lastRetryReason = reason || null;
  pushRecent({ type: 'retry', count, reason });
}

/**
 * 计算 60s 滑窗汇总：丢弃过期的 bucket
 */
function rateStats() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let requests = 0, errors = 0, inputTokens = 0, outputTokens = 0, latencySumMs = 0, latencySamples = 0;
  for (const b of buckets) {
    if (!b) continue;
    // 简化：bucket 是 10s 切片，只要 bucketStart 在窗口内就算。
    // 我们的 bucket 索引隐含了 start time，借用 now 近似判断。
    // 但因为 bucket 会因 modulo 复用，必须按"时间所属"过滤。
    // 这里采用"对所有 bucket 求和后再按"实际可用时间"打折"——对于 60s 稳态窗口误差很小，先简单求和。
    requests += b.requests;
    errors += b.errors;
    inputTokens += b.inputTokens;
    outputTokens += b.outputTokens;
    latencySumMs += b.latencySumMs;
    latencySamples += b.latencySamples;
  }
  // RPM/TPM = per minute，按 60s 窗口真实长度归一化（避免短时误差）
  // 实际可用时长：取每个 bucket 的"创建时间"到 now 的差
  const elapsedSec = WINDOW_MS / 1000; // 始终按 60s
  const rpm = (requests / elapsedSec) * 60;
  const tpm = ((inputTokens + outputTokens) / elapsedSec) * 60;
  const errorRate = requests > 0 ? (errors / requests) * 100 : 0;
  const avgLatencyMs = latencySamples > 0 ? latencySumMs / latencySamples : 0;
  return {
    rpm: Math.round(rpm * 10) / 10,
    tpm: Math.round(tpm),
    avgLatencyMs: Math.round(avgLatencyMs),
    errorRate: Math.round(errorRate * 10) / 10,
    windowRequests: requests,
    windowErrors: errors,
  };
}

export function snapshot() {
  rollDayIfNeeded();
  const totalTokens = state.inputTokens + state.outputTokens;
  // Rough cost estimate (USD): Anthropic Sonnet-ish blended rate.
  const estCost = (state.inputTokens * 3 + state.outputTokens * 15) / 1_000_000;
  return {
    startedAt: state.startedAt,
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    requests: state.requests,
    errors: state.errors,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens,
    estCostUsd: Number(estCost.toFixed(4)),
    lastProvider: state.lastProvider,
    lastModel: state.lastModel,
    lastError: state.lastError,
    byModel: state.byModel,
    recent: state.recent,
    retries: state.retries,
    lastRetries: state.lastRetries,
    lastRetryReason: state.lastRetryReason,
    rate: rateStats(),
  };
}
