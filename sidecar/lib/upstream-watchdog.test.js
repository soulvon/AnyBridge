// upstream-watchdog.test.js — concurrency gate unit tests
// Run: node --test lib/upstream-watchdog.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConcurrencyGate,
  providerGateKey,
} from './upstream-watchdog.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createConcurrencyGate', () => {
  it('limits concurrent run() callers per key', async () => {
    const gate = createConcurrencyGate(1);
    let concurrent = 0;
    let peak = 0;

    async function job() {
      return gate.run('k', async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await delay(20);
        concurrent -= 1;
        return 'ok';
      });
    }

    const results = await Promise.all([job(), job(), job()]);
    assert.deepEqual(results, ['ok', 'ok', 'ok']);
    assert.equal(peak, 1);
    assert.deepEqual(gate.stats('k'), { active: 0, waiting: 0, max: 1 });
  });

  it('allows up to max inflight', async () => {
    const gate = createConcurrencyGate(2);
    let concurrent = 0;
    let peak = 0;
    const started = [];

    async function job(id) {
      return gate.run('k', async () => {
        started.push(id);
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await delay(30);
        concurrent -= 1;
      });
    }

    await Promise.all([job('a'), job('b'), job('c')]);
    assert.equal(peak, 2);
    assert.equal(started.length, 3);
  });

  it('isolates different keys', async () => {
    const gate = createConcurrencyGate(1);
    let concurrent = 0;
    let peak = 0;

    async function job(key) {
      return gate.run(key, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await delay(25);
        concurrent -= 1;
      });
    }

    await Promise.all([job('a'), job('b')]);
    assert.equal(peak, 2);
  });

  it('releases slot when run() throws', async () => {
    const gate = createConcurrencyGate(1);
    await assert.rejects(
      () => gate.run('k', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(gate.stats('k'), { active: 0, waiting: 0, max: 1 });

    let ran = false;
    await gate.run('k', async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it('acquire free is idempotent and FIFO', async () => {
    const gate = createConcurrencyGate(1);
    const free1 = await gate.acquire('k');
    assert.deepEqual(gate.stats('k'), { active: 1, waiting: 0, max: 1 });

    const order = [];
    let free2;
    const waiter = gate.acquire('k').then((free) => {
      free2 = free;
      order.push('acquired-2');
      return free;
    });

    await delay(10);
    assert.deepEqual(gate.stats('k'), { active: 1, waiting: 1, max: 1 });
    assert.equal(order.length, 0);

    free1();
    free1(); // idempotent
    await waiter;
    assert.equal(order[0], 'acquired-2');
    assert.deepEqual(gate.stats('k'), { active: 1, waiting: 0, max: 1 });

    free2();
    assert.deepEqual(gate.stats('k'), { active: 0, waiting: 0, max: 1 });
  });

  it('max=0 is unlimited no-op', async () => {
    const gate = createConcurrencyGate(0);
    const free = await gate.acquire('k');
    free();
    free();
    const result = await gate.run('k', async () => 42);
    assert.equal(result, 42);
    assert.deepEqual(gate.stats('k'), { active: 0, waiting: 0, max: 0 });
  });
});

describe('providerGateKey', () => {
  it('builds provider|host|model key', () => {
    assert.equal(
      providerGateKey({
        providerName: 'OpenAI',
        hostname: 'api.openai.com',
        model: 'gpt-4o',
      }),
      'OpenAI|api.openai.com|gpt-4o',
    );
  });

  it('falls back for missing fields', () => {
    assert.equal(providerGateKey({}), 'provider|unknown-host|model');
    assert.equal(
      providerGateKey({ providerId: 'p1', host: 'h1' }),
      'p1|h1|model',
    );
  });
});
