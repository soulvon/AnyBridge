// request-tracker.js — 请求级统计跟踪器。
//
// 一次请求一个实例，`finish()` 是唯一落账出口（见 docs/subsystems/stats.md）。
// 旧实现在 chat.js 里散落 30+ 处 record* 调用；这里把它们收敛成
// beginAttempt / endAttempt / reject / fail / noteRetry / finish。
//
// 口径（与 stats.js 的 A/B 对照必须成立）：
//   requests  = 每个 attempt 一次 recordRequest；被拒请求（无 attempt）在 finish 时补一次
//   errors    = failed + rejected（aborted 不计入 errors）
//   tokens    = 仅 status==='ok' 的 attempt usage（与旧行为一致：失败尝试不计 token）
//   latency   = 仅 ok 时的端到端耗时（旧 recordStreamLatency 同口径）
//   retries   = noteRetry 次数之和（旧 chat.js 未记录，这是修复项）
//
// 明确不做：本模块不写文件、不碰网络。明细账本由 usage-ledger.js 消费 finish 结果。

import { recordError, recordLatency, recordRequest, recordRetry, recordUsage } from './stats.js';

const STATUSES = new Set(['ok', 'failed', 'rejected', 'aborted']);
const ATTEMPT_STATUSES = new Set(['pending', 'ok', 'failed', 'skipped']);

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return emptyUsage();
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input: n(usage.inputTokens ?? usage.input),
    output: n(usage.outputTokens ?? usage.output),
    cacheRead: n(usage.cachedTokens ?? usage.cacheRead ?? usage.cacheReadInputTokens),
    cacheWrite: n(usage.cacheCreationInputTokens ?? usage.cacheWrite),
  };
}

/**
 * @param {{ client?: string|null, route?: string, requestedModel?: string|null }} init
 */
export function createTracker({ client = null, route = 'chat', requestedModel = null } = {}) {
  return new RequestTracker({ client, route, requestedModel });
}

export class RequestTracker {
  constructor({ client, route, requestedModel }) {
    this.requestId = null;
    this.client = client;
    this.route = route;
    this.requestedModel = requestedModel;
    this.startedAt = Date.now();

    this.status = null;      // ok | failed | rejected | aborted
    this.errorKind = null;
    this.errorMessage = null;

    this.provider = null;
    this.providerId = null;
    this.servedModel = null;

    this.usage = emptyUsage();
    this.retries = { count: 0, lastReason: null };
    this.attempts = [];
    this.latencyMs = null;

    this.finalized = false;
    this.openAttempt = -1;
  }

  // 与 chat.js 的 messageId 绑定，供日志/明细关联。首个绑定生效。
  bindRequestId(id) {
    if (!this.requestId) this.requestId = id || null;
    return this;
  }

  // 开始一次上游尝试。provider/model 必填——未知身份必须显式报错，不静默套默认值。
  beginAttempt({ provider, providerId = null, model }) {
    if (this.finalized) throw new Error('[tracker] beginAttempt after finish');
    if (!provider || typeof provider !== 'string') {
      throw new Error('[tracker] beginAttempt requires provider');
    }
    if (!model || typeof model !== 'string') {
      throw new Error('[tracker] beginAttempt requires model');
    }
    this.closeOpenAttempt({ status: 'skipped', error: 'superseded by next attempt' });

    const attempt = {
      provider,
      providerId,
      model,
      startedAt: Date.now(),
      ms: null,
      status: 'pending',
      statusCode: null,
      error: null,
      usage: null,
    };
    this.attempts.push(attempt);
    this.openAttempt = this.attempts.length - 1;

    this.provider = provider;
    this.providerId = providerId;
    this.servedModel = model;

    // 与旧实现一致：attempt 开始即 +1 requests。
    recordRequest({ provider, requestedModel: this.requestedModel, resolvedModel: model });
    return this;
  }

  /**
   * 结束当前尝试。
   * @param {{ status?: 'ok'|'failed'|'skipped', statusCode?: number|null, error?: string|null, ms?: number|null, usage?: object|null }} result
   */
  endAttempt({ status = 'ok', statusCode = null, error = null, ms = null, usage = null } = {}) {
    if (this.finalized) throw new Error('[tracker] endAttempt after finish');
    if (!ATTEMPT_STATUSES.has(status) || status === 'pending') {
      throw new Error(`[tracker] invalid attempt status: ${status}`);
    }
    if (this.openAttempt < 0) {
      throw new Error('[tracker] endAttempt without beginAttempt');
    }
    const attempt = this.attempts[this.openAttempt];
    attempt.status = status;
    attempt.statusCode = statusCode;
    attempt.error = error;
    attempt.ms = Number.isFinite(ms) ? ms : Date.now() - attempt.startedAt;
    attempt.usage = usage ? normalizeUsage(usage) : null;
    this.openAttempt = -1;

    if (status === 'ok') {
      this.servedModel = attempt.model;
      this.provider = attempt.provider;
      this.providerId = attempt.providerId;
      this.latencyMs = attempt.ms;
      this.usage = attempt.usage || emptyUsage();
    }
    return this;
  }

  // 记录一次重试（chat.js 的 onFailover 里调用）。旧实现完全未记录，这是修复项。
  noteRetry(reason) {
    if (this.finalized) return this;
    this.retries.count += 1;
    this.retries.lastReason = reason || null;
    return this;
  }

  // 未触达上游的本地拒绝（预检类）。errors +1，requests 在 finish 时补一次。
  reject(kind, message) {
    if (this.finalized) throw new Error('[tracker] reject after finish');
    if (this.status && this.status !== 'rejected') {
      throw new Error(`[tracker] reject conflicts with status=${this.status}`);
    }
    this.status = 'rejected';
    this.errorKind = kind || 'unknown';
    this.errorMessage = message || null;
    return this;
  }

  // 客户端断开。进 requests，不进 errors（用户主动取消不应拉高错误率）。
  abort(message) {
    if (this.finalized) throw new Error('[tracker] abort after finish');
    if (!this.status) this.status = 'aborted';
    this.errorKind = this.errorKind || 'client-abort';
    this.errorMessage = message || this.errorMessage || null;
    return this;
  }

  // 触达上游后的失败，或本地处理失败（vision/search）。不覆盖已定状态。
  fail(kind, message) {
    if (this.finalized) throw new Error('[tracker] fail after finish');
    if (this.status === 'ok') throw new Error('[tracker] fail conflicts with status=ok');
    if (!this.status) this.status = 'failed';
    this.errorKind = kind || this.errorKind || 'unknown';
    this.errorMessage = message || this.errorMessage || null;
    return this;
  }

  // 唯一落账出口。幂等：重复调用不再结算。
  finish() {
    if (this.finalized) return this.summary();
    this.finalized = true;

    this.closeOpenAttempt({ status: 'failed', error: 'finish without endAttempt' });

    const okAttempt = this.attempts.find((a) => a.status === 'ok') || null;
    if (okAttempt) {
      this.status = this.status || 'ok';
    }
    if (!this.status) {
      // 没有任何终态声明：视为失败并显式暴露，不静默当成功。
      this.status = 'failed';
      this.errorKind = this.errorKind || 'unclassified';
      this.errorMessage = this.errorMessage || 'request finished without terminal status';
    }

    // rejected 且从未触达上游：旧实现不计 requests，这里按新口径补一次。
    if (this.status === 'rejected' && this.attempts.length === 0) {
      recordRequest({
        provider: this.errorKind,
        requestedModel: this.requestedModel,
        resolvedModel: null,
      });
    }

    if (this.status === 'ok') {
      recordUsage({
        inputTokens: this.usage.input,
        outputTokens: this.usage.output,
        cachedTokens: this.usage.cacheRead,
        cacheCreationInputTokens: this.usage.cacheWrite,
      });
      if (Number.isFinite(this.latencyMs) && this.latencyMs >= 0) {
        recordLatency(this.latencyMs);
      }
    } else if (this.status === 'failed' || this.status === 'rejected') {
      recordError({
        provider: this.provider || this.errorKind,
        message: this.errorMessage || this.errorKind,
      });
    }
    // aborted 只进 requests，不进 errors。

    if (this.retries.count > 0) {
      recordRetry({ count: this.retries.count, reason: this.retries.lastReason, provider: this.provider });
    }
    return this.summary();
  }

  // 供明细账本（usage-ledger）消费的结构化快照。
  summary() {
    return {
      requestId: this.requestId,
      client: this.client,
      route: this.route,
      requestedModel: this.requestedModel,
      servedModel: this.servedModel,
      provider: this.provider,
      providerId: this.providerId,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      latencyMs: this.latencyMs,
      status: this.status,
      errorKind: this.errorKind,
      errorMessage: this.errorMessage,
      usage: { ...this.usage },
      retries: { ...this.retries },
      attempts: this.attempts.map((a) => ({ ...a })),
    };
  }

  closeOpenAttempt({ status, error }) {
    if (this.openAttempt < 0) return;
    const attempt = this.attempts[this.openAttempt];
    attempt.status = status;
    attempt.error = error;
    attempt.ms = Date.now() - attempt.startedAt;
    this.openAttempt = -1;
  }
}

export const __trackerTest = { STATUSES, normalizeUsage };
