// sidecar/lib/attempt-runner.js — 统一外层目标尝试、多密钥顺延轮换、可重试错误判定与 Retry-After 微退避决策

import { connWithApiKey } from '../provider-pool.js';
import {
  RETRYABLE_CODES,
  RETRYABLE_STATUS,
  retryAfterMs,
  shortRetryAfterDelay,
} from './http-retry.js';

const DEFAULT_RETRY_DEFAULTS = Object.freeze({
  maxRetries: 5,
  baseMs: 600,
  capMs: 8000,
  totalMs: 60000,
});

const RETRYABLE_REASON_RE = /timeout|reset|socket hang up|econn|epipe|network|dns|eai_again/i;

function parsePositiveInt(value, fallback, min = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function buildAttemptRetryPolicy(enhancement = {}, defaults = DEFAULT_RETRY_DEFAULTS) {
  const baseDefaults = { ...DEFAULT_RETRY_DEFAULTS, ...defaults };
  const defaultTotalSeconds = Math.max(1, Math.ceil((Number(baseDefaults.totalMs) || 60000) / 1000));
  return {
    enabled: enhancement.retry !== false,
    maxRetries: parsePositiveInt(enhancement.retryMaxRetries, baseDefaults.maxRetries, 0),
    baseMs: parsePositiveInt(enhancement.retryBaseMs, baseDefaults.baseMs, 1),
    capMs: parsePositiveInt(enhancement.retryCapMs, baseDefaults.capMs, 1),
    totalMs: parsePositiveInt(enhancement.retryTotalSeconds, defaultTotalSeconds, 1) * 1000,
  };
}

export function resolveCandidateKeys(conn) {
  if (Array.isArray(conn?._apiKeyCandidates) && conn._apiKeyCandidates.length > 0) {
    return conn._apiKeyCandidates;
  }
  return conn?.apiKey ? [conn.apiKey] : [];
}

export function isRetryableAttemptFailure({ statusCode = 0, code = '', reason = '', matchReasonText = true } = {}) {
  const numericStatus = Number(statusCode) || 0;
  if (numericStatus > 0) return RETRYABLE_STATUS.has(numericStatus);
  if (code && RETRYABLE_CODES.has(code)) return true;
  if (matchReasonText && reason) return RETRYABLE_REASON_RE.test(String(reason));
  return false;
}

export function computeAttemptRetryDelay(
  attempt,
  policy = DEFAULT_RETRY_DEFAULTS,
  headers = null,
  elapsedMs = 0,
  { capToRemaining = true, capMsOverride = null } = {},
) {
  const capMs = Number(policy?.capMs) || DEFAULT_RETRY_DEFAULTS.capMs;
  const baseMs = Number(policy?.baseMs) || DEFAULT_RETRY_DEFAULTS.baseMs;
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const raCap = capMsOverride != null ? capMsOverride : capMs;
  const ra = Math.min(retryAfterMs(headers || {}), raCap);
  const raw = Math.max(Math.random() * exp, ra);
  if (!capToRemaining) return Math.round(raw);
  const totalMs = Number(policy?.totalMs) || DEFAULT_RETRY_DEFAULTS.totalMs;
  const remaining = Math.max(0, totalMs - Math.max(0, elapsedMs || 0));
  return Math.round(Math.min(raw, remaining));
}

export function createTargetAttemptRunner({
  conn,
  keyCandidates = resolveCandidateKeys(conn),
  policy,
  tracker = null,
  startedAt = Date.now(),
  microBackoffCapMs = 2000,
  matchReasonText = true,
  capToRemaining = true,
  capMsOverride = null,
} = {}) {
  let currentConn = conn;
  const keys = Array.isArray(keyCandidates) ? keyCandidates : [];
  let keyIdx = 0;
  let retryCount = 0;

  return {
    get conn() {
      return currentConn;
    },
    get keyIndex() {
      return keyIdx;
    },
    get totalKeys() {
      return keys.length;
    },
    get retryCount() {
      return retryCount;
    },
    get startedAt() {
      return startedAt;
    },
    evaluateFailure({ statusCode = 0, code = '', headers = null, reason = '', headersSent = false, includeReasonInRotationNote = true } = {}) {
      if (headersSent) return { action: 'stop' };

      const numericStatus = Number(statusCode) || 0;
      if ((numericStatus === 401 || numericStatus === 429) && keyIdx + 1 < keys.length) {
        keyIdx += 1;
        currentConn = connWithApiKey(currentConn, keys[keyIdx]);
        const waitMs = numericStatus === 429 ? shortRetryAfterDelay(headers, microBackoffCapMs) : 0;
        const baseNote = `HTTP ${numericStatus} key-rotation (${keyIdx + 1}/${keys.length})`;
        const note = includeReasonInRotationNote && reason ? `${baseNote}: ${reason}` : baseNote;
        tracker?.noteRetry?.(note);
        return {
          action: 'rotate-key',
          conn: currentConn,
          keyIndex: keyIdx,
          totalKeys: keys.length,
          waitMs,
        };
      }

      const elapsed = Date.now() - startedAt;
      const budgetOk = Boolean(policy?.enabled) && retryCount < policy.maxRetries && elapsed < policy.totalMs;
      if (!budgetOk) return { action: 'stop' };

      const microWaitMs = numericStatus === 429 ? shortRetryAfterDelay(headers, microBackoffCapMs) : 0;
      if (microWaitMs > 0) {
        retryCount += 1;
        tracker?.noteRetry?.(reason ? `HTTP 429 micro-backoff ${microWaitMs}ms: ${reason}` : `HTTP 429 micro-backoff ${microWaitMs}ms`);
        return {
          action: 'micro-backoff',
          waitMs: microWaitMs,
          retryCount,
          maxRetries: policy.maxRetries,
        };
      }

      if (isRetryableAttemptFailure({ statusCode: numericStatus, code, reason, matchReasonText })) {
        retryCount += 1;
        const retryNote = numericStatus ? `HTTP ${numericStatus}: ${reason}` : (reason || code || 'network error');
        tracker?.noteRetry?.(retryNote);
        const waitMs = computeAttemptRetryDelay(retryCount, policy, headers, elapsed, {
          capToRemaining,
          capMsOverride,
        });
        return {
          action: 'retry',
          waitMs,
          retryCount,
          maxRetries: policy.maxRetries,
        };
      }

      return { action: 'stop' };
    },
  };
}
