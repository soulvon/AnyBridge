// sidecar/lib/http-retry.js — 统一 HTTP 瞬时重试底座、状态码分类、有界 LRU Map 与限流窗口。
// 由原 retry.js、transport.js 与 chat/utils.js 的重复策略合并收口而来。

import { performance } from 'node:perf_hooks';

export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
export const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_NETWORK', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function retryAfterMs(headers = {}, capMs = Infinity) {
  const raw = headers?.['retry-after'];
  if (!raw) return 0;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const seconds = parseInt(val, 10);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, capMs);
  const at = Date.parse(val);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), capMs);
  return 0;
}

export function shortRetryAfterDelay(headers, maxMs = 2000) {
  const ms = retryAfterMs(headers);
  return ms > 0 && ms < maxMs ? ms : 0;
}

export function isRetryableStatusOrCode(status, code) {
  if (status) return RETRYABLE_STATUS.has(status);
  if (code) return RETRYABLE_CODES.has(code);
  return false;
}

export function isRetryableError(err, { retryableStatus = RETRYABLE_STATUS, retryableCodes = RETRYABLE_CODES } = {}) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false;
  if (err.statusCode && retryableStatus.has(err.statusCode)) return true;
  if (err.code && retryableCodes.has(err.code)) return true;
  const cause = err.cause;
  if (cause?.code && retryableCodes.has(cause.code)) return true;
  return false;
}

const DEFAULT_RETRY_OPTS = Object.freeze({
  maxRetries: 3,
  baseMs: 400,
  capMs: 4000,
  maxTotalMs: 20000,
  factor: 2,
  jitter: 'full',
  retryableStatus: RETRYABLE_STATUS,
  retryableCodes: RETRYABLE_CODES,
  onRetry: null,
  label: 'http',
});

export function backoffMs(attempt, opts = DEFAULT_RETRY_OPTS) {
  const capMs = Number(opts.capMs) || DEFAULT_RETRY_OPTS.capMs;
  const baseMs = Number(opts.baseMs) || DEFAULT_RETRY_OPTS.baseMs;
  const factor = Number(opts.factor) || 2;
  const exp = Math.min(capMs, baseMs * Math.pow(factor, Math.max(0, attempt - 1)));
  if (opts.jitter === 'none') return exp;
  if (opts.jitter === 'equal') return exp / 2 + Math.random() * (exp / 2);
  return Math.random() * exp;
}

export async function withRetry(fn, userOpts = {}) {
  const opts = {
    ...DEFAULT_RETRY_OPTS,
    ...userOpts,
    retryableStatus: userOpts.retryableStatus || RETRYABLE_STATUS,
    retryableCodes: userOpts.retryableCodes || RETRYABLE_CODES,
  };
  const maxAttempts = Math.max(1, Number(opts.maxRetries ?? DEFAULT_RETRY_OPTS.maxRetries) + 1);
  const start = performance.now();
  const ctrl = new AbortController();
  let onExternalAbort = null;
  if (opts.signal) {
    if (opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    onExternalAbort = () => ctrl.abort();
    opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let lastErr;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (ctrl.signal.aborted) break;
      try {
        return await fn(ctrl.signal, attempt);
      } catch (err) {
        lastErr = err;
        const elapsed = performance.now() - start;
        const canRetry = isRetryableError(err, opts);
        const noMore = attempt >= maxAttempts;
        const overBudget = elapsed >= opts.maxTotalMs;
        if (!canRetry || noMore || overBudget) {
          throw err;
        }
        const wait = backoffMs(attempt, opts);
        const raMs = err.statusCode === 429 && err.headers ? retryAfterMs(err.headers, opts.capMs) : 0;
        const finalWait = Math.min(Math.max(wait, raMs), Math.max(0, opts.maxTotalMs - elapsed));
        if (typeof opts.onRetry === 'function') {
          try { opts.onRetry({ attempt, maxAttempts, waitMs: Math.round(finalWait), err, label: opts.label }); } catch {}
        }
        await sleep(finalWait, ctrl.signal);
      }
    }
    throw lastErr || new Error('retry exhausted');
  } finally {
    if (opts.signal && onExternalAbort) {
      opts.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * 标准有界 LRU Map 写入：刷新插入顺序并按 maxEntries 淘汰最久未使用的条目。
 */
export function boundedMapSet(map, key, value, maxEntries = 2000) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

/**
 * 标准有界 Set 写入。
 */
export function boundedSetAdd(set, key, maxEntries = 500) {
  if (set.has(key)) set.delete(key);
  while (set.size >= maxEntries) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  set.add(key);
}

/**
 * 统一滑动固定窗口 RPM 限流器（带过期桶清理与容量上限，防恶意高基数 key 爆内存）。
 */
export function checkWindowRateLimit(buckets, key, rpm, maxBuckets = 2000) {
  const now = Date.now();
  if (buckets.size >= maxBuckets && !buckets.has(key)) {
    for (const [k, b] of buckets) {
      if (!b || now > b.resetAt) buckets.delete(k);
    }
    while (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    boundedMapSet(buckets, key, { count: 1, resetAt: now + 60000 }, maxBuckets);
    return true;
  }
  if (bucket.count >= rpm) return false;
  bucket.count += 1;
  return true;
}
