import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, estimateCost, priceFor } from './pricing.js';

describe('pricing 估算价', () => {
  it('已知模型族命中内置价', () => {
    assert.equal(priceFor('claude-sonnet-4').priced, true);
    assert.equal(priceFor('gemini-3.8-flash-high').priced, true);
    assert.equal(priceFor('deepseek-v4').priced, true);
  });

  it('未知模型用默认价并显式标记未定价', () => {
    const p = priceFor('totally-unknown-model');
    assert.equal(p.priced, false);
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
  });

  it('单模型成本按输入/输出/缓存分别计价', () => {
    // claude：input 3 / output 15 / cacheRead 0.3 / cacheWrite 3.75（每百万）
    const cost = costOf(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      'claude-sonnet-4',
    );
    assert.equal(Number(cost.toFixed(6)), 3 + 15 + 0.3 + 3.75);
  });

  it('cache token 参与计价（旧实现完全忽略）', () => {
    const withCache = costOf({ input: 0, output: 0, cacheRead: 1_000_000 }, 'claude-sonnet-4');
    assert.equal(Number(withCache.toFixed(6)), 0.3);
  });

  it('汇总多模型并列出未定价模型', () => {
    const { totalUsd, unpricedModels } = estimateCost({
      'claude-sonnet-4': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      'mystery-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    assert.equal(Number(totalUsd.toFixed(6)), 3 + 3);
    assert.deepEqual(unpricedModels, ['mystery-model']);
  });

  it('空数据返回 0 成本', () => {
    const { totalUsd, unpricedModels } = estimateCost({});
    assert.equal(totalUsd, 0);
    assert.deepEqual(unpricedModels, []);
  });
});
