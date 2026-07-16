// upstream-watchdog.js — multi-stage hang protection for upstream HTTP/SSE.
//
// Stages:
//   - TTFB: first response headers must arrive
//   - idle: after response starts, chunks must keep arriving (or touch())
//   - hard: absolute ceiling for the whole request
//
// Also exports:
//   - SSE client keepalive helper (comment lines, SSE-spec ignorable)
//   - per-key concurrency gate (in-flight limiter)

function intEnv(names, fallback, min = 0) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null || raw === '') continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= min) return n;
  }
  return fallback;
}

/** Hard ceiling for a single upstream request (connect + stream). Default 5 min. */
export const UPSTREAM_TIMEOUT_MS = intEnv(['UPSTREAM_TIMEOUT_MS', 'API_TIMEOUT_MS'], 300_000, 1000);
/** Time to first response headers. Default 90s. */
export const UPSTREAM_TTFB_MS = intEnv(['UPSTREAM_TTFB_MS', 'BYOK_TTFB_MS'], 90_000, 1000);
/**
 * Max silence between upstream stream chunks after the stream has started.
 * Default 300s — reasoning models (Grok/o-series) can think for minutes with no tokens;
 * xAI docs recommend proxy idle ≥ 10 min for long Grok responses.
 */
export const UPSTREAM_IDLE_MS = intEnv(['UPSTREAM_IDLE_MS', 'BYOK_STREAM_IDLE_MS'], 300_000, 1000);
/** Interval for writing SSE comment keepalives to the client. 0 = disabled. Default 15s. */
export const SSE_KEEPALIVE_MS = intEnv(['BYOK_SSE_KEEPALIVE_MS', 'SSE_KEEPALIVE_MS'], 15_000, 0);
/** Max concurrent upstream requests per provider key. 0 = unlimited. Default 8. */
export const UPSTREAM_MAX_INFLIGHT = intEnv(['BYOK_MAX_INFLIGHT', 'UPSTREAM_MAX_INFLIGHT'], 8, 0);

/**
 * Attach TTFB / idle / hard timers to a ClientRequest.
 * @param {import('node:http').ClientRequest} apiReq
 * @param {{ label?: string, ttfbMs?: number, idleMs?: number, hardMs?: number }} [opts]
 * @returns {{ touch: () => void, clear: () => void, markResponse: (apiRes?: import('node:http').IncomingMessage) => void }}
 */
export function attachUpstreamWatchdog(apiReq, {
  label = 'upstream',
  ttfbMs = UPSTREAM_TTFB_MS,
  idleMs = UPSTREAM_IDLE_MS,
  hardMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let settled = false;
  let gotResponse = false;
  let hardTimer = null;
  let ttfbTimer = null;
  let idleTimer = null;

  function clearAll() {
    if (settled) return;
    settled = true;
    if (hardTimer) clearTimeout(hardTimer);
    if (ttfbTimer) clearTimeout(ttfbTimer);
    if (idleTimer) clearTimeout(idleTimer);
    hardTimer = ttfbTimer = idleTimer = null;
  }

  function kill(reason) {
    if (settled || apiReq.destroyed) return;
    console.warn(`  ⏱️  ${label}: ${reason}`);
    clearAll();
    const err = new Error(reason);
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  }

  function armIdle() {
    if (settled || idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => kill('upstream stream idle timeout'), idleMs);
  }

  function touch() {
    if (settled) return;
    if (gotResponse) armIdle();
  }

  function markResponse(apiRes) {
    if (settled) return;
    gotResponse = true;
    if (ttfbTimer) {
      clearTimeout(ttfbTimer);
      ttfbTimer = null;
    }
    armIdle();
    if (apiRes && typeof apiRes.on === 'function') {
      apiRes.on('data', touch);
      apiRes.on('end', clearAll);
      apiRes.on('close', clearAll);
      apiRes.on('error', clearAll);
    }
  }

  // Disable Node's single socket timeout; we own the policy.
  try { apiReq.setTimeout(0); } catch { /* ignore */ }

  if (hardMs > 0) {
    hardTimer = setTimeout(() => kill('upstream hard timeout'), hardMs);
  }
  if (ttfbMs > 0) {
    ttfbTimer = setTimeout(() => {
      if (!gotResponse) kill('upstream first-byte timeout');
    }, ttfbMs);
  }

  apiReq.on('socket', (socket) => {
    try { socket.setTimeout(0); } catch { /* ignore */ }
  });

  apiReq.on('response', (apiRes) => {
    markResponse(apiRes);
  });
  apiReq.on('error', clearAll);
  apiReq.on('close', clearAll);
  apiReq.on('abort', clearAll);

  return { touch, clear: clearAll, markResponse };
}

/**
 * Write SSE comment keepalives while upstream is silent.
 * SSE comments (`: ...`) are ignorable per the HTML SSE spec.
 * @param {import('node:http').ServerResponse} res
 * @param {{ intervalMs?: number, comment?: string }} [opts]
 * @returns {{ touch: () => void, stop: () => void }}
 */
export function startSseKeepalive(res, {
  intervalMs = SSE_KEEPALIVE_MS,
  comment = 'keepalive',
} = {}) {
  if (!intervalMs || intervalMs <= 0 || !res || res.writableEnded || res.destroyed) {
    return { touch() {}, stop() {} };
  }

  let timer = null;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function writeKeepalive() {
    if (stopped || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    try {
      res.write(`: ${comment}\n\n`);
    } catch {
      stop();
    }
  }

  timer = setInterval(writeKeepalive, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  res.on('close', stop);
  res.on('error', stop);
  res.on('finish', stop);

  return {
    touch() {
      // no-op: interval-based keepalives; touch reserved for future adaptive logic
    },
    stop,
  };
}

/**
 * Per-key concurrency gate. Serializes excess callers with a FIFO wait queue.
 * @param {number} [maxInflight]
 */
export function createConcurrencyGate(maxInflight = UPSTREAM_MAX_INFLIGHT) {
  const max = Math.max(0, Number(maxInflight) || 0);
  /** @type {Map<string, { active: number, wait: Array<() => void> }>} */
  const buckets = new Map();

  function bucket(key) {
    const k = String(key || 'default');
    let b = buckets.get(k);
    if (!b) {
      b = { active: 0, wait: [] };
      buckets.set(k, b);
    }
    return b;
  }

  function release(key) {
    const b = bucket(key);
    b.active = Math.max(0, b.active - 1);
    const next = b.wait.shift();
    if (next) {
      b.active += 1;
      next();
    } else if (b.active === 0 && b.wait.length === 0) {
      buckets.delete(String(key || 'default'));
    }
  }

  /**
   * Acquire a slot (may wait). Call release(key) when done.
   * Prefer run() for simple request/response; use acquire for streams.
   * @param {string} key
   * @returns {Promise<() => void>} release function
   */
  async function acquire(key) {
    if (max <= 0) return () => {};
    const b = bucket(key);
    if (b.active >= max) {
      await new Promise((resolve) => {
        b.wait.push(resolve);
      });
    } else {
      b.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release(key);
    };
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function run(key, fn) {
    const free = await acquire(key);
    try {
      return await fn();
    } finally {
      free();
    }
  }

  function stats(key) {
    const b = buckets.get(String(key || 'default'));
    return {
      active: b?.active || 0,
      waiting: b?.wait?.length || 0,
      max,
    };
  }

  return { run, acquire, release, stats, max };
}

/** Shared default gate for provider-scoped upstream concurrency. */
export const providerInflightGate = createConcurrencyGate(UPSTREAM_MAX_INFLIGHT);

export function providerGateKey(conn = {}) {
  const host = conn.hostname || conn.host || 'unknown-host';
  const provider = conn.providerName || conn.providerId || 'provider';
  const model = conn.model || 'model';
  return `${provider}|${host}|${model}`;
}
