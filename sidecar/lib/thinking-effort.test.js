import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyThinkingToPayload,
  clampEffortLevel,
  describeThinking,
  modelFamily,
  normalizeThinkingEffortConfig,
  parseThinkingFromUid,
  resolveThinkingEffort,
} from './thinking-effort.js';

const anthropicConn = { format: 'anthropic', model: 'claude-opus-4-7', apiPath: '/v1/messages' };
const responsesConn = { format: 'openai', model: 'gpt-5.6-sol', apiPath: '/v1/responses' };
const chatConn = { format: 'openai', model: 'gpt-5.6-sol', apiPath: '/v1/chat/completions' };

describe('parseThinkingFromUid', () => {
  it('从 UID 后缀解析档位', () => {
    assert.deepEqual(parseThinkingFromUid('gpt-5-6-sol-high'), { mode: 'level', level: 'high' });
    assert.deepEqual(parseThinkingFromUid('gpt-5-6-sol-low'), { mode: 'level', level: 'low' });
    assert.deepEqual(parseThinkingFromUid('gpt-5-6-sol-xhigh'), { mode: 'level', level: 'xhigh' });
    assert.deepEqual(parseThinkingFromUid('MODEL_GPT_5_2_XHIGH'), { mode: 'level', level: 'xhigh' });
    assert.deepEqual(parseThinkingFromUid('MODEL_GPT_5_1_CODEX_MAX_HIGH'), { mode: 'level', level: 'high' });
  });

  it('剥离尾部修饰词后再解析（-fast/-priority/-1m/-slow）', () => {
    assert.deepEqual(parseThinkingFromUid('claude-opus-4-7-high-fast'), { mode: 'level', level: 'high' });
    assert.deepEqual(parseThinkingFromUid('MODEL_GPT_5_2_MEDIUM_PRIORITY'), { mode: 'level', level: 'medium' });
    assert.deepEqual(parseThinkingFromUid('gpt-5-6-luna-low-priority'), { mode: 'level', level: 'low' });
    assert.deepEqual(parseThinkingFromUid('glm-5-2-none-1m'), { mode: 'off' });
  });

  it('none/no-thinking → off；裸 thinking → on', () => {
    assert.deepEqual(parseThinkingFromUid('gpt-5-6-luna-none'), { mode: 'off' });
    assert.deepEqual(parseThinkingFromUid('glm-5-2-none'), { mode: 'off' });
    assert.deepEqual(parseThinkingFromUid('claude-sonnet-4-6-thinking'), { mode: 'on' });
  });

  it('-max 有 ≥2 个档位兄弟时算档位', () => {
    assert.deepEqual(parseThinkingFromUid('claude-opus-4-7-max'), { mode: 'level', level: 'max' });
    assert.deepEqual(parseThinkingFromUid('gpt-5-6-luna-max'), { mode: 'level', level: 'max' });
    assert.deepEqual(parseThinkingFromUid('claude-opus-4-7-max-fast'), { mode: 'level', level: 'max' });
  });

  it('UID 无档位时回退到 catalog label', () => {
    // MODEL_PRIVATE_15 label 为 "GPT-5.1 High Thinking"
    assert.deepEqual(parseThinkingFromUid('MODEL_PRIVATE_15'), { mode: 'level', level: 'high' });
    // glm-5-2 label 为 "GLM-5.2 High"
    assert.deepEqual(parseThinkingFromUid('glm-5-2'), { mode: 'level', level: 'high' });
    assert.deepEqual(parseThinkingFromUid('glm-5-2-1m'), { mode: 'level', level: 'high' });
  });

  it('非档位 UID/label → null', () => {
    assert.equal(parseThinkingFromUid('deepseek-v4-pro'), null);
    assert.equal(parseThinkingFromUid('swe-1-6-fast'), null); // label "SWE-1.6 Fast" 剥掉后无档位
    assert.equal(parseThinkingFromUid('MODEL_SWE_1_5_SLOW'), null);
    assert.equal(parseThinkingFromUid(''), null);
    assert.equal(parseThinkingFromUid(null), null);
  });
});

describe('normalizeThinkingEffortConfig', () => {
  it('归一化配置值', () => {
    assert.equal(normalizeThinkingEffortConfig(undefined), 'auto');
    assert.equal(normalizeThinkingEffortConfig(''), 'auto');
    assert.equal(normalizeThinkingEffortConfig('auto'), 'auto');
    assert.equal(normalizeThinkingEffortConfig('HIGH'), 'high');
    assert.equal(normalizeThinkingEffortConfig('none'), 'off');
    assert.equal(normalizeThinkingEffortConfig('off'), 'off');
    assert.equal(normalizeThinkingEffortConfig('disabled'), 'off');
    assert.equal(normalizeThinkingEffortConfig('on'), 'high');
    assert.equal(normalizeThinkingEffortConfig('bogus'), 'auto');
  });
});

describe('resolveThinkingEffort', () => {
  it('配置值优先于 modelUid 解析', () => {
    const t = { thinkingEffort: 'low' };
    assert.deepEqual(resolveThinkingEffort(t, 'gpt-5-6-sol-high', responsesConn),
      { mode: 'level', level: 'low', source: 'config' });
  });

  it('配置 off → 显式关闭', () => {
    const t = { thinkingEffort: 'off' };
    assert.deepEqual(resolveThinkingEffort(t, 'gpt-5-6-sol-high', responsesConn),
      { mode: 'off', source: 'config' });
  });

  it('auto：同族直传', () => {
    assert.deepEqual(resolveThinkingEffort({}, 'gpt-5-6-sol-xhigh', responsesConn),
      { mode: 'level', level: 'xhigh', source: 'auto' });
    assert.deepEqual(resolveThinkingEffort({}, 'gpt-5-6-luna-none', responsesConn),
      { mode: 'off', source: 'auto' });
  });

  it('auto：跨族就近钳制', () => {
    // gpt 的 xhigh → claude 词表无 xhigh → 就近降为 high
    const r = resolveThinkingEffort({}, 'gpt-5-6-sol-xhigh', anthropicConn);
    assert.equal(r.mode, 'level');
    assert.equal(r.level, 'high');
    assert.equal(r.clamped, true);
    // gpt 的 max → gpt 词表无 max → 降为 xhigh
    const g = resolveThinkingEffort({ thinkingEffort: 'max' }, 'x', responsesConn);
    assert.equal(g.level, 'xhigh');
    // none → claude 词表无 none，但 off 是模式不是档位，直接下发 disabled
    const off = resolveThinkingEffort({}, 'gpt-5-6-luna-none', anthropicConn);
    assert.equal(off.mode, 'off');
  });

  it('裸 thinking/on → high', () => {
    const r = resolveThinkingEffort({}, 'claude-sonnet-4-6-thinking', anthropicConn);
    assert.deepEqual(r, { mode: 'level', level: 'high', source: 'auto' });
  });

  it('无法解析 → null（不注入）', () => {
    assert.equal(resolveThinkingEffort({}, 'deepseek-v4-pro', responsesConn), null);
  });

  it('gemini 目标族钳制', () => {
    const gemini = { format: 'openai', model: 'gemini-3.1-pro', apiPath: '/v1/chat/completions' };
    const r = resolveThinkingEffort({}, 'gpt-5-6-sol-xhigh', gemini);
    assert.equal(r.level, 'high'); // gemini 词表无 xhigh → high
  });

  it('支持 snake_case 字段 thinking_effort', () => {
    const r = resolveThinkingEffort({ thinking_effort: 'medium' }, 'x', responsesConn);
    assert.equal(r.level, 'medium');
  });
});

describe('applyThinkingToPayload', () => {
  it('anthropic：adaptive + output_config.effort', () => {
    const p = { model: 'claude-opus-4-7' };
    applyThinkingToPayload(p, anthropicConn, { mode: 'level', level: 'high' });
    assert.deepEqual(p.thinking, { type: 'adaptive' });
    assert.deepEqual(p.output_config, { effort: 'high' });
  });

  it('anthropic：保留 output_config 其它字段；off → disabled 且移除 effort', () => {
    const p = { output_config: { effort: 'high', other: 1 }, thinking: { type: 'adaptive' } };
    applyThinkingToPayload(p, anthropicConn, { mode: 'off' });
    assert.deepEqual(p.thinking, { type: 'disabled' });
    assert.deepEqual(p.output_config, { other: 1 });
  });

  it('openai /responses → reasoning.effort，保留 reasoning 其它字段', () => {
    const p = { reasoning: { summary: 'auto' } };
    applyThinkingToPayload(p, responsesConn, { mode: 'level', level: 'medium' });
    assert.deepEqual(p.reasoning, { summary: 'auto', effort: 'medium' });
  });

  it('openai /chat/completions → reasoning_effort', () => {
    const p = {};
    applyThinkingToPayload(p, chatConn, { mode: 'level', level: 'low' });
    assert.equal(p.reasoning_effort, 'low');
    assert.equal(p.reasoning, undefined);
  });

  it('openai off → none', () => {
    const p = {};
    applyThinkingToPayload(p, responsesConn, { mode: 'off' });
    assert.deepEqual(p.reasoning, { effort: 'none' });
  });

  it('resolved 为 null / 非支持协议 → 不修改', () => {
    const p = {};
    applyThinkingToPayload(p, anthropicConn, null);
    assert.deepEqual(p, {});
    const g = {};
    applyThinkingToPayload(g, { format: 'gemini', model: 'gemini-3.1-pro' }, { mode: 'level', level: 'high' });
    assert.deepEqual(g, {});
  });
});

describe('clampEffortLevel / modelFamily / describeThinking', () => {
  it('clamp：词表含该级→原样；否则就近降档再升档', () => {
    assert.equal(clampEffortLevel('high', ['low', 'medium', 'high']), 'high');
    assert.equal(clampEffortLevel('xhigh', ['low', 'medium', 'high', 'max']), 'high');
    assert.equal(clampEffortLevel('minimal', ['low', 'medium', 'high']), 'low');
    assert.equal(clampEffortLevel('none', ['low', 'medium', 'high']), 'low');
    assert.equal(clampEffortLevel('bogus', ['low']), null);
  });

  it('modelFamily 识别', () => {
    assert.equal(modelFamily('claude-opus-4-7'), 'claude');
    assert.equal(modelFamily('gpt-5.6-sol'), 'gpt');
    assert.equal(modelFamily('o3'), 'gpt');
    assert.equal(modelFamily('gemini-3.1-pro'), 'gemini');
    assert.equal(modelFamily('unknown-thing'), 'generic');
  });

  it('describeThinking', () => {
    assert.equal(describeThinking({ mode: 'level', level: 'high' }), 'high');
    assert.equal(describeThinking({ mode: 'off' }), 'off');
    assert.equal(describeThinking(null), '');
  });
});
