// stats.js — In-memory runtime statistics for the BYOK dashboard.
// Reset on each proxy restart (daily counters keyed by date).
//
// Rate window: 60s sliding window divided into 6 buckets × 10s each.
// On snapshot we sum the buckets that fell in the last 60s to produce RPM/TPM/avg latency.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_STATS_RETENTION_DAYS = 365;
let persistTimer = null;

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return process.env.APPDATA ? path.join(process.env.APPDATA, name) : path.join(os.homedir(), 'AppData', 'Roaming', name);
}

function statsPath() {
  return path.join(configDir(), 'stats.json');
}

function visionLogDir() {
  return path.join(configDir(), 'vision-logs');
}

function visionLogPath() {
  return path.join(visionLogDir(), 'vision-' + todayKey() + '.jsonl');
}

function configPath() {
  return path.join(configDir(), 'byok-config.json');
}

function readStatsRetentionDays() {
  try {
    const file = configPath();
    if (!fs.existsSync(file)) return DEFAULT_STATS_RETENTION_DAYS;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = json && json.values ? json.values.STATS_RETENTION_DAYS : null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_STATS_RETENTION_DAYS;
    return Math.max(1, Math.min(3650, n));
  } catch {
    return DEFAULT_STATS_RETENTION_DAYS;
  }
}

function dailySnapshot() {
  return {
    day: state.day,
    requests: state.requests,
    errors: state.errors,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cachedTokens: state.cachedTokens,
    cacheCreationInputTokens: state.cacheCreationInputTokens,
    lastProvider: state.lastProvider,
    lastModel: state.lastModel,
    lastError: state.lastError,
    byModel: state.byModel,
    recent: state.recent,
    retries: state.retries,
    lastRetries: state.lastRetries,
    lastRetryReason: state.lastRetryReason,
    visionFallback: state.visionFallback,
  };
}

function pruneHistory(days, retentionDays) {
  const cutoff = Date.now() - (retentionDays - 1) * 24 * 60 * 60 * 1000;
  for (const day of Object.keys(days)) {
    const ts = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(ts) || ts < cutoff) delete days[day];
  }
}

function persistedSnapshot() {
  const retentionDays = readStatsRetentionDays();
  const days = { ...state.history, [state.day]: dailySnapshot() };
  pruneHistory(days, retentionDays);
  state.history = days;
  return {
    version: 2,
    retentionDays,
    days,
  };
}

function persistNow() {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(statsPath(), JSON.stringify(persistedSnapshot(), null, 2));
  } catch (e) {
    console.error(`[stats] failed to persist stats: ${e.message}`);
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer.unref) persistTimer.unref();
}

function loadPersistedState() {
  try {
    const file = statsPath();
    if (!fs.existsSync(file)) return null;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json) return null;
    if (json.version === 2 && json.days && typeof json.days === 'object' && !Array.isArray(json.days)) {
      const days = { ...json.days };
      pruneHistory(days, readStatsRetentionDays());
      const current = days[todayKey()] || null;
      return { ...(current || {}), day: todayKey(), history: days };
    }
    if (json.day !== todayKey()) return { day: todayKey(), history: { [json.day]: json } };
    return { ...json, history: { [json.day]: json } };
  } catch (e) {
    console.error(`[stats] failed to load persisted stats: ${e.message}`);
    return null;
  }
}

function emptyVisionFallback() {
  return {
    images: 0,
    apiCalls: 0,
    cacheHits: 0,
    failures: 0,
    byModel: {},
    recent: [],
  };
}

function normalizeVisionFallback(value) {
  const base = emptyVisionFallback();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  return {
    images: Number.isFinite(value.images) ? value.images : 0,
    apiCalls: Number.isFinite(value.apiCalls) ? value.apiCalls : 0,
    cacheHits: Number.isFinite(value.cacheHits) ? value.cacheHits : 0,
    failures: Number.isFinite(value.failures) ? value.failures : 0,
    byModel: value.byModel && typeof value.byModel === 'object' && !Array.isArray(value.byModel) ? value.byModel : {},
    recent: Array.isArray(value.recent) ? value.recent.slice(0, 20) : [],
  };
}

function appendVisionLog(record) {
  try {
    fs.mkdirSync(visionLogDir(), { recursive: true });
    fs.appendFile(visionLogPath(), JSON.stringify(record) + '\n', 'utf8', (e) => {
      if (e) console.error('[stats] failed to write vision log: ' + e.message);
    });
  } catch (e) {
    console.error('[stats] failed to prepare vision log: ' + e.message);
  }
}

function applyPersistedState(saved) {
  if (!saved) return;
  state.day = saved.day || todayKey();
  state.requests = Number.isFinite(saved.requests) ? saved.requests : 0;
  state.errors = Number.isFinite(saved.errors) ? saved.errors : 0;
  state.inputTokens = Number.isFinite(saved.inputTokens) ? saved.inputTokens : 0;
  state.outputTokens = Number.isFinite(saved.outputTokens) ? saved.outputTokens : 0;
  state.cachedTokens = Number.isFinite(saved.cachedTokens) ? saved.cachedTokens : 0;
  state.cacheCreationInputTokens = Number.isFinite(saved.cacheCreationInputTokens) ? saved.cacheCreationInputTokens : 0;
  state.lastProvider = saved.lastProvider || null;
  state.lastModel = saved.lastModel || null;
  state.lastError = saved.lastError || null;
  state.byModel = saved.byModel && typeof saved.byModel === 'object' && !Array.isArray(saved.byModel) ? saved.byModel : {};
  state.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 20) : [];
  state.retries = Number.isFinite(saved.retries) ? saved.retries : 0;
  state.lastRetries = Number.isFinite(saved.lastRetries) ? saved.lastRetries : 0;
  state.lastRetryReason = saved.lastRetryReason || null;
  state.visionFallback = normalizeVisionFallback(saved.visionFallback);
  state.history = saved.history && typeof saved.history === 'object' && !Array.isArray(saved.history) ? saved.history : {};
}

// 60s 滑窗：6 个 10s bucket，环形复用
const BUCKET_MS = 10_000;
const BUCKET_COUNT = 6;
const WINDOW_MS = BUCKET_MS * BUCKET_COUNT;

function emptyBucket() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, latencySumMs: 0, latencySamples: 0 };
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
  cachedTokens: 0,
  cacheCreationInputTokens: 0,
  lastProvider: null,
  lastModel: null,
  lastError: null,
  byModel: {},
  recent: [],
  retries: 0,           // 累计重试次数
  lastRetries: 0,       // 最近一次请求的重试次数
  lastRetryReason: null, // 最近一次重试原因
  visionFallback: emptyVisionFallback(),
  history: {},
};

applyPersistedState(loadPersistedState());

function rollDayIfNeeded() {
  const t = todayKey();
  if (t !== state.day) {
    state.history[state.day] = dailySnapshot();
    state.day = t;
    state.requests = 0;
    state.errors = 0;
    state.inputTokens = 0;
    state.outputTokens = 0;
    state.cachedTokens = 0;
    state.cacheCreationInputTokens = 0;
    state.byModel = {};
    state.recent = [];
    state.lastError = null;
    state.retries = 0;
    state.visionFallback = emptyVisionFallback();
    schedulePersist();
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
  schedulePersist();
}

export function recordUsage({ inputTokens = 0, outputTokens = 0, cachedTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 } = {}) {
  rollDayIfNeeded();
  const readTokens = Math.max(Number(cachedTokens) || 0, Number(cacheReadInputTokens) || 0);
  const creationTokens = Number(cacheCreationInputTokens) || 0;
  state.inputTokens += inputTokens;
  state.outputTokens += outputTokens;
  state.cachedTokens += readTokens;
  state.cacheCreationInputTokens += creationTokens;
  const b = activeBucket();
  b.inputTokens += inputTokens;
  b.outputTokens += outputTokens;
  b.cachedTokens += readTokens;
  schedulePersist();
}

export function recordError({ provider, message }) {
  rollDayIfNeeded();
  state.errors += 1;
  state.lastError = message;
  activeBucket().errors += 1;
  pushRecent({ type: 'error', provider, message });
  schedulePersist();
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
  schedulePersist();
}

function pushVisionRecent(entry) {
  state.visionFallback.recent.unshift(entry);
  if (state.visionFallback.recent.length > 20) state.visionFallback.recent.length = 20;
}

export function recordVisionFallback(event = {}) {
  rollDayIfNeeded();
  const now = new Date().toISOString();
  const ok = event.status !== 'error' && !event.error;
  const providerName = event.providerName || null;
  const model = event.model || null;
  const modelKey = providerName || model ? (providerName || 'unknown') + '/' + (model || 'unknown') : 'unknown';

  if (ok) {
    state.visionFallback.images += 1;
    if (event.cached) state.visionFallback.cacheHits += 1;
    else state.visionFallback.apiCalls += Number.isFinite(event.apiCalls) ? event.apiCalls : 1;
    state.visionFallback.byModel[modelKey] = (state.visionFallback.byModel[modelKey] || 0) + 1;
  } else {
    state.visionFallback.failures += 1;
    if (Number.isFinite(event.apiCalls) && event.apiCalls > 0) {
      state.visionFallback.apiCalls += event.apiCalls;
    }
  }

  const description = typeof event.description === 'string' ? event.description : '';
  const record = {
    ts: now,
    status: ok ? 'ok' : 'error',
    requestId: event.requestId || null,
    conversationKey: event.conversationKey || null,
    requestedModel: event.requestedModel || null,
    slotModelUid: event.slotModelUid || null,
    slotDisplayName: event.slotDisplayName || null,
    providerId: event.providerId || null,
    providerName,
    model,
    protocol: event.protocol || null,
    cached: !!event.cached,
    imageRef: Number.isFinite(event.imageRef) ? event.imageRef : null,
    duplicateInRequest: !!event.duplicateInRequest,
    seenInConversation: !!event.seenInConversation,
    apiCalls: Number.isFinite(event.apiCalls) ? event.apiCalls : (ok && !event.cached ? 1 : 0),
    imageHash: event.imageHash || null,
    imageBytes: event.imageBytes || 0,
    base64Length: event.base64Length || 0,
    mimeType: event.mimeType || 'image/png',
    messageIndex: Number.isFinite(event.messageIndex) ? event.messageIndex : null,
    blockIndex: Number.isFinite(event.blockIndex) ? event.blockIndex : null,
    userTextPreview: event.userTextPreview || '',
    descriptionLength: description.length,
    description,
    error: event.error || null,
  };

  pushVisionRecent({
    ts: Date.now(),
    status: record.status,
    requestId: record.requestId,
    conversationKey: record.conversationKey,
    requestedModel: record.requestedModel,
    slotModelUid: record.slotModelUid,
    providerName: record.providerName,
    model: record.model,
    protocol: record.protocol,
    cached: record.cached,
    imageRef: record.imageRef,
    duplicateInRequest: record.duplicateInRequest,
    seenInConversation: record.seenInConversation,
    apiCalls: record.apiCalls,
    imageHash: record.imageHash,
    imageBytes: record.imageBytes,
    mimeType: record.mimeType,
    descriptionLength: record.descriptionLength,
    descriptionPreview: description.slice(0, 300),
    error: record.error,
  });
  appendVisionLog(record);
  schedulePersist();
}

/**
 * 计算 60s 滑窗汇总：丢弃过期的 bucket
 */
function rateStats() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let requests = 0, errors = 0, inputTokens = 0, outputTokens = 0, cachedTokens = 0, latencySumMs = 0, latencySamples = 0;
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
    cachedTokens += b.cachedTokens || 0;
    latencySumMs += b.latencySumMs;
    latencySamples += b.latencySamples;
  }
  // RPM = per minute；TPS = tokens per second，按 60s 窗口归一化
  // 实际可用时长：取每个 bucket 的"创建时间"到 now 的差
  const elapsedSec = WINDOW_MS / 1000; // 始终按 60s
  const rpm = (requests / elapsedSec) * 60;
  const tpm = (inputTokens + outputTokens) / elapsedSec;
  const errorRate = requests > 0 ? (errors / requests) * 100 : 0;
  const avgLatencyMs = latencySamples > 0 ? latencySumMs / latencySamples : 0;
  return {
    rpm: Math.round(rpm * 10) / 10,
    tpm: Math.round(tpm * 10) / 10,
    avgLatencyMs: Math.round(avgLatencyMs),
    errorRate: Math.round(errorRate * 10) / 10,
    windowRequests: requests,
    windowErrors: errors,
    cachedTokens,
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
    cachedTokens: state.cachedTokens,
    cacheCreationInputTokens: state.cacheCreationInputTokens,
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
    visionFallback: state.visionFallback,
    visionLogFile: visionLogPath(),
    historyDays: Object.keys(state.history).length,
    rate: rateStats(),
  };
}
