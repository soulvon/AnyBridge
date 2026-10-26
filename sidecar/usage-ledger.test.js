import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-ledger-'));
process.env.BYOK_CONFIG_DIR = tmpRoot;

const ledger = await import('./usage-ledger.js');

function summary(overrides = {}) {
  return {
    requestId: 'req-1',
    client: 'devin',
    route: 'chat',
    requestedModel: 'gpt-x',
    servedModel: 'gemini-3.8-flash-high',
    provider: 'CPA',
    providerId: 'p1',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    latencyMs: 900,
    status: 'ok',
    errorKind: null,
    errorMessage: null,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    retries: { count: 0, lastReason: null },
    attempts: [],
    ...overrides,
  };
}

describe('usage-ledger 明细账本', () => {
  it('每请求写一行，读取后可汇总', () => {
    ledger.appendRecord(summary());
    ledger.appendRecord(summary({ requestId: 'req-2', status: 'failed', errorKind: 'network' }));
    const rows = ledger.readDay();
    assert.equal(rows.length, 2);
    const agg = ledger.summarizeDay();
    assert.equal(agg.requests, 2);
    assert.equal(agg.errors, 1);
    assert.equal(agg.input, 20);
    assert.equal(agg.output, 10);
  });

  it('白名单裁剪：正文等未知字段永不落盘', () => {
    const picked = ledger.pickLedgerFields({
      ...summary(),
      body: 'SECRET REQUEST BODY',
      headers: { authorization: 'sk-xxx' },
      nested: { anything: true },
    });
    assert.equal(picked.body, undefined);
    assert.equal(picked.headers, undefined);
    assert.equal(picked.nested, undefined);
    const line = JSON.stringify(picked);
    assert.equal(line.includes('SECRET REQUEST BODY'), false);
    assert.equal(line.includes('sk-xxx'), false);
  });

  it('非对象输入显式抛错，不静默跳过', () => {
    assert.throws(() => ledger.appendRecord(null), /requires a summary object/);
  });

  it('账本文件按天命名且可定位', () => {
    const file = ledger.__ledgerTest.ledgerPath('2026-01-02');
    assert.equal(path.basename(file), 'usage-2026-01-02.jsonl');
    assert.equal(fs.existsSync(path.dirname(file)), true);
  });
});
