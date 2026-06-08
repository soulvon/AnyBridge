// retry.js — Codex 风格指数退避重试包装器
//
// 核心策略（参考 OpenAI Codex CLI 的 `backoff.rs` / `run_with_retry` 语义）：
//   1. 默认至少 5 次尝试（1 次原始 + 5 次重试 = 6 次），可通过 env 调
//   2. 指数退避：baseMs * 2^(attempt-1)，上限 capMs
//   3. 全抖动（full jitter）：实际等待 = random(0, exp)，避免惊群
//   4. 只对「可重试」错误重试：网络错误、ECONNRESET/ETIMEDOUT/ENOTFOUND/EPIPE、
//      5xx（502/503/504）、429（按 Retry-After 头或退避）
//   5. 不重试：4xx（除 408/429）、客户端中断、上游返回正常但业务失败
//   6. 整体超时：受 maxTotalMs 限制（默认 60s），避免无限等
//   7. 支持 AbortSignal：客户端断开时立即终止
//
// 用法：
//   const result = await withRetry(async (signal) => {
//     return await doHttpRequest(opts, signal);
//   }, { maxRetries: 5, label: 'anthropic' });
//
//   // 或包裹 https.request：见 doRequestWithRetry()

import { performance } from 'node:perf_hooks';
import { recordRetry } from './stats.js';

const DEFAULT_OPTS = Object.freeze({
  maxRetries: 5,          // 至少 5 次重试（不算首次）
  baseMs: 500,            // 第一次退避基准
  capMs: 8000,            // 单次最大退避
  maxTotalMs: 60000,      // 整体最大耗时
  factor: 2,              // 退避倍数
  jitter: 'full',         // 'full' | 'equal' | 'none'
  retryableStatus: new Set([408, 425, 429, 500, 502, 503, 504]),
  retryableCodes: new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'ERR_NETWORK', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  ]),
  onRetry: null,          // (info) => void  // 钩子
  label: 'http',          // 日志标签
});

function rand() { return Math.random(); }

/**
 * 退避延迟：codex 用 full jitter —— rand(0, exp) 防止雷鸣群
 */
function backoffMs(attempt, opts) {
  const exp = Math.min(opts.capMs, opts.baseMs * Math.pow(opts.factor, attempt - 1));
  if (opts.jitter === 'none') return exp;
  if (opts.jitter === 'equal') return exp / 2 + rand() * (exp / 2);
  // full jitter（codex 默认）
  return rand() * exp;
}

/**
 * 错误分类：是否可重试
 */
export function isRetryable(err, opts) {
  if (!err) return false;
  // 客户端主动 abort → 不重试
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false;
  if (err.statusCode && opts.retryableStatus.has(err.statusCode)) return true;
  if (err.code && opts.retryableCodes.has(err.code)) return true;
  // 某些 SDK 抛出带 cause 的
  const cause = err.cause;
  if (cause && cause.code && opts.retryableCodes.has(cause.code)) return true;
  return false;
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 通用重试包装器：fn 必须返回 Promise，且接受 AbortSignal。
 * fn 抛出 / reject 的 err 应带 statusCode 或 code 以便分类。
 *
 * 返回值：fn 第一次成功的返回值。
 * 抛出：最后一次失败（若是可重试错误耗尽）或非可重试错误。
 */
export async function withRetry(fn, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts,
    retryableStatus: userOpts.retryableStatus || DEFAULT_OPTS.retryableStatus,
    retryableCodes: userOpts.retryableCodes || DEFAULT_OPTS.retryableCodes,
  };
  const maxAttempts = Math.max(1, opts.maxRetries + 1); // 重试次数 + 首次
  const start = performance.now();
  const ctrl = new AbortController();
  // 让外层 signal 透传（可选项）
  if (opts.signal) {
    if (opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let lastErr;
  let retriedCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctrl.signal.aborted) break;
    try {
      const result = await fn(ctrl.signal, attempt);
      if (attempt > 1) {
        console.log(`  ♻️  [${opts.label}] 第 ${attempt}/${maxAttempts} 次成功 (累计 ${Math.round(performance.now() - start)}ms)`);
        recordRetry({ count: retriedCount, reason: 'success_after_retry' });
      }
      return result;
    } catch (err) {
      lastErr = err;
      const elapsed = performance.now() - start;
      const retryable = isRetryable(err, opts);
      const noMoreAttempts = attempt >= maxAttempts;
      const overBudget = elapsed >= opts.maxTotalMs;
      if (!retryable || noMoreAttempts || overBudget) {
        if (attempt > 1) {
          console.error(`  ❌ [${opts.label}] 重试 ${attempt - 1} 次后仍失败: ${err.message}${overBudget ? ' (超时)' : ''}`);
          recordRetry({ count: retriedCount, reason: 'exhausted' });
        }
        throw err;
      }
      retriedCount++;
      const wait = backoffMs(attempt, opts);
      // 429 时尝试使用 Retry-After
      let retryAfterMs = 0;
      if (err.statusCode === 429 && err.headers) {
        const ra = err.headers['retry-after'];
        if (ra) {
          const v = parseInt(ra, 10);
          if (!Number.isNaN(v)) retryAfterMs = Math.min(v * 1000, opts.capMs);
        }
      }
      const finalWait = Math.max(wait, retryAfterMs);
      const info = { attempt, maxAttempts, waitMs: Math.round(finalWait), err, label: opts.label };
      if (typeof opts.onRetry === 'function') {
        try { opts.onRetry(info); } catch {}
      }
      console.warn(`  ⏳ [${opts.label}] 第 ${attempt} 次失败(${err.statusCode || err.code || err.message})，${Math.round(finalWait)}ms 后重试 (${attempt + 1}/${maxAttempts})`);
      await sleep(finalWait, ctrl.signal);
    }
  }
  throw lastErr || new Error('retry exhausted');
}

/**
 * 把一次 https.request 调用包成 Promise + 暴露 abort()。
 * 返回的 promise 失败时，err 上挂 statusCode / code / headers，便于 withRetry 分类。
 */
export function httpsRequestAsync(req, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; fn(v); };

    req.on('response', (res) => {
      // 流式响应：返回 res 对象，调用方自行 pipe/read。
      // 失败判定：仅在 statusCode 非 2xx 时 reject；2xx 直接 resolve(res)。
      if (res.statusCode >= 200 && res.statusCode < 300) {
        settle(resolve, res);
      } else {
        // 收集 body（限 4KB）供错误诊断
        const chunks = [];
        let total = 0;
        res.on('data', c => {
          if (total < 4096) {
            chunks.push(c);
            total += c.length;
            if (total > 4096) chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, 4096 - (total - c.length));
          }
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.headers = res.headers;
          err.body = body;
          settle(reject, err);
        });
        res.on('error', (e) => {
          const err = new Error(`HTTP ${res.statusCode} read error: ${e.message}`);
          err.statusCode = res.statusCode;
          err.headers = res.headers;
          settle(reject, err);
        });
      }
    });
    req.on('error', (e) => settle(reject, e));
    req.on('timeout', () => {
      const e = new Error('upstream timeout');
      e.code = 'ETIMEDOUT';
      settle(reject, e);
      req.destroy();
    });
    if (body) req.write(body);
    req.end();
  });
}
