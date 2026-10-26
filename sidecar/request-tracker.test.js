import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// stats.js 是模块级单例，且会按 BYOK_CONFIG_DIR 持久化。
// 必须在动态 import 之前把配置目录指到临时目录，避免污染真实 stats.json。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-tracker-'));
process.env.BYOK_CONFIG_DIR = tmpRoot;

const { createTracker } = await import('./request-tracker.js');
const stats = await import('./stats.js');

function delta(fn) {
  const before = stats.snapshot();
  fn();
  const after = stats.snapshot();
  return {
    requests: after.requests - before.requests,
    errors: after.errors - before.errors,
    input: after.inputTokens - before.inputTokens,
    output: after.outputTokens - before.outputTokens,
    cached: after.cachedTokens - before.cachedTokens,
    retries: after.retries - before.retries,
    upstreamAttempts: after.upstreamAttempts - before.upstreamAttempts,
  };
}

describe('request-tracker 口径', () => {
  it('成功尝试：一次 request、token 与延迟按成功 attempt 结算', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });
    tracker.bindRequestId('req-ok-1');

    const d = delta(() => {
      tracker.beginAttempt({ provider: 'CPA', providerId: 'p1', model: 'gemini-3.8-flash-high' });
      tracker.endAttempt({
        status: 'ok',
        statusCode: 200,
        ms: 1200,
        usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30, cacheCreationInputTokens: 5 },
      });
      tracker.finish();
    });

    assert.equal(d.requests, 1);
    assert.equal(d.errors, 0);
    assert.equal(d.input, 100);
    assert.equal(d.output, 20);
    assert.equal(d.cached, 30);
    assert.equal(tracker.summary().status, 'ok');
    assert.equal(tracker.summary().servedModel, 'gemini-3.8-flash-high');
  });

  it('从未发起上游尝试的失败（路由解析失败）也计入 requests', () => {
    const tracker = createTracker({ client: 'local-proxy', route: 'local-proxy', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.fail('route-unresolved', '没有匹配的路由');
      tracker.finish();
    });

    assert.equal(d.requests, 1);
    assert.equal(d.errors, 1);
    assert.equal(tracker.summary().attempts.length, 0);
  });

  it('预检拒绝：计入 requests 与 errors（新口径，errorRate 恒 ≤ 100%）', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.reject('rate-limit', '请求频率超限');
      tracker.finish();
    });

    assert.equal(d.requests, 1);
    assert.equal(d.errors, 1);
    assert.equal(d.input + d.output, 0);
    assert.equal(tracker.summary().errorKind, 'rate-limit');
  });

  it('全部失败：每次尝试各计一次 requests，errors 只计一次', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.beginAttempt({ provider: 'A', model: 'm-a' });
      tracker.endAttempt({ status: 'failed', statusCode: 500, error: 'boom' });
      tracker.beginAttempt({ provider: 'B', model: 'm-b' });
      tracker.endAttempt({ status: 'failed', statusCode: 503, error: 'boom2' });
      tracker.fail('failover', '所有目标均失败');
      tracker.finish();
    });

    assert.equal(d.requests, 2);
    assert.equal(d.errors, 1);
    assert.equal(tracker.summary().attempts.length, 2);
  });

  it('失败尝试的 usage 不计入 tokens（与旧行为一致）', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.beginAttempt({ provider: 'A', model: 'm-a' });
      tracker.endAttempt({ status: 'failed', statusCode: 500, usage: { inputTokens: 999, outputTokens: 111 } });
      tracker.fail('upstream-http', 'HTTP 500');
      tracker.finish();
    });

    assert.equal(d.input, 0);
    assert.equal(d.output, 0);
  });

  it('客户端断开：进 requests 不进 errors', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.beginAttempt({ provider: 'A', model: 'm-a' });
      tracker.abort('client closed');
      tracker.finish();
    });

    assert.equal(d.requests, 1);
    assert.equal(d.errors, 0);
    assert.equal(tracker.summary().status, 'aborted');
  });

  it('finish 幂等：重复调用不重复结算', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.beginAttempt({ provider: 'A', model: 'm-a' });
      tracker.endAttempt({ status: 'ok', usage: { inputTokens: 10, outputTokens: 2 } });
      tracker.finish();
      tracker.finish();
      tracker.finish();
    });

    assert.equal(d.requests, 1);
    assert.equal(d.input, 10);
  });

  it('重试计入 retries 与 upstreamAttempts（旧 chat.js 完全未记录，属修复项）', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });

    const d = delta(() => {
      tracker.beginAttempt({ provider: 'A', model: 'm-a' });
      tracker.noteRetry('HTTP 429: rate limited');
      tracker.noteRetry('HTTP 429: rate limited');
      tracker.endAttempt({ status: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
      tracker.finish();
    });

    assert.equal(d.retries, 2);
    assert.equal(d.upstreamAttempts, 3);
    assert.equal(tracker.summary().retries.lastReason, 'HTTP 429: rate limited');
  });

  it('未知身份显式抛错，不静默套默认值', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });
    assert.throws(() => tracker.beginAttempt({ model: 'm' }), /requires provider/);
    assert.throws(() => tracker.beginAttempt({ provider: 'A' }), /requires model/);
    assert.throws(() => tracker.endAttempt({ status: 'ok' }), /without beginAttempt/);
  });

  it('结算后晚到的 fail/abort 不改账本也不抛错（socket 事件时序）', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });
    tracker.beginAttempt({ provider: 'A', model: 'm-a' });
    tracker.endAttempt({ status: 'ok', usage: { inputTokens: 5, outputTokens: 1 } });

    const d = delta(() => {
      tracker.finish();
      tracker.fail('upstream-stream', 'late error after finish');
      tracker.abort('late close');
    });

    assert.equal(tracker.summary().status, 'ok');
    assert.equal(d.errors, 0);
    assert.equal(d.input, 5);
  });

  it('无终态声明的请求显式标记为失败而非成功', () => {
    const tracker = createTracker({ client: 'devin', route: 'chat', requestedModel: 'gpt-x' });
    tracker.beginAttempt({ provider: 'A', model: 'm-a' });
    const d = delta(() => {
      tracker.finish();
    });
    assert.equal(tracker.summary().status, 'failed');
    assert.equal(tracker.summary().errorKind, 'unclassified');
    assert.equal(d.errors, 1);
  });
});
