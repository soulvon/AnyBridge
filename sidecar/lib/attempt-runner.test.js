// sidecar/lib/attempt-runner.test.js — 外层尝试状态机、候选密钥轮换、可重试判定与 Retry-After 微退避单测

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAttemptRetryPolicy,
  computeAttemptRetryDelay,
  createTargetAttemptRunner,
  isRetryableAttemptFailure,
  resolveCandidateKeys,
} from './attempt-runner.js';

test('resolveCandidateKeys: 优先返回不可枚举的 _apiKeyCandidates，否则降级 apiKey', () => {
  const conn = { apiKey: 'fallback-key' };
  Object.defineProperty(conn, '_apiKeyCandidates', { value: ['k1', 'k2'], enumerable: false });
  assert.deepEqual(resolveCandidateKeys(conn), ['k1', 'k2']);
  assert.deepEqual(resolveCandidateKeys({ apiKey: 'single' }), ['single']);
  assert.deepEqual(resolveCandidateKeys({}), []);
});

test('isRetryableAttemptFailure: 统一覆盖状态码、网络错误码与可选消息文本分类', () => {
  assert.equal(isRetryableAttemptFailure({ statusCode: 429 }), true);
  assert.equal(isRetryableAttemptFailure({ statusCode: 524 }), true);
  assert.equal(isRetryableAttemptFailure({ statusCode: 400 }), false);
  assert.equal(isRetryableAttemptFailure({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableAttemptFailure({ reason: 'socket hang up', matchReasonText: true }), true);
  assert.equal(isRetryableAttemptFailure({ reason: 'socket hang up', matchReasonText: false }), false);
});

test('createTargetAttemptRunner: 401/429 顺延切换候选密钥，即使 retry.enabled=false 也能轮换', () => {
  const notes = [];
  const conn = { format: 'openai', apiKey: 'k1' };
  Object.defineProperty(conn, '_apiKeyCandidates', { value: ['k1', 'k2', 'k3'], enumerable: false });

  const runner = createTargetAttemptRunner({
    conn,
    policy: buildAttemptRetryPolicy({ retry: false }),
    tracker: { noteRetry: (n) => notes.push(n) },
  });

  const d1 = runner.evaluateFailure({ statusCode: 401, reason: 'bad key 1' });
  assert.equal(d1.action, 'rotate-key');
  assert.equal(d1.conn.apiKey, 'k2');
  assert.equal(d1.waitMs, 0);

  const d2 = runner.evaluateFailure({ statusCode: 429, headers: { 'retry-after': '1' }, reason: 'rate limited' });
  assert.equal(d2.action, 'rotate-key');
  assert.equal(d2.conn.apiKey, 'k3');
  assert.equal(d2.waitMs, 1000);

  // 密钥耗尽且 retry=false，停止不再重试
  const d3 = runner.evaluateFailure({ statusCode: 429, headers: { 'retry-after': '1' }, reason: 'rate limited' });
  assert.equal(d3.action, 'stop');
  assert.equal(notes.length, 2);
});

test('createTargetAttemptRunner: 429 <2s Retry-After 走微退避，>=2s 走常规重试受 capMs/budget 约束', () => {
  const runner = createTargetAttemptRunner({
    conn: { format: 'openai', apiKey: 'only-key' },
    policy: { enabled: true, maxRetries: 2, baseMs: 500, capMs: 4000, totalMs: 60000 },
    tracker: { noteRetry: () => {} },
  });

  const d1 = runner.evaluateFailure({ statusCode: 429, headers: { 'retry-after': '1' }, reason: 'rl' });
  assert.equal(d1.action, 'micro-backoff');
  assert.equal(d1.waitMs, 1000);
  assert.equal(d1.retryCount, 1);

  const d2 = runner.evaluateFailure({ statusCode: 429, headers: { 'retry-after': '5' }, reason: 'rl' });
  assert.equal(d2.action, 'retry');
  assert.equal(d2.waitMs, 4000);
  assert.equal(d2.retryCount, 2);

  // 超过 maxRetries 停止
  const d3 = runner.evaluateFailure({ statusCode: 503, reason: 'busy' });
  assert.equal(d3.action, 'stop');
});

test('createTargetAttemptRunner: headersSent=true 严禁旋转密钥或重试', () => {
  const conn = { format: 'openai', apiKey: 'k1' };
  Object.defineProperty(conn, '_apiKeyCandidates', { value: ['k1', 'k2'], enumerable: false });
  const runner = createTargetAttemptRunner({
    conn,
    policy: buildAttemptRetryPolicy({}),
    tracker: { noteRetry: () => {} },
  });

  const d = runner.evaluateFailure({ statusCode: 429, headersSent: true, reason: 'late error' });
  assert.equal(d.action, 'stop');
  assert.equal(runner.keyIndex, 0);
  assert.equal(runner.retryCount, 0);
});

test('computeAttemptRetryDelay: 支持 capToRemaining 开关', () => {
  const policy = { baseMs: 1000, capMs: 8000, totalMs: 10000 };
  const capped = computeAttemptRetryDelay(2, policy, { 'retry-after': '6' }, 8500, { capToRemaining: true });
  assert.equal(capped, 1500);
  const uncapped = computeAttemptRetryDelay(2, policy, { 'retry-after': '6' }, 8500, { capToRemaining: false });
  assert.equal(uncapped, 6000);
});
