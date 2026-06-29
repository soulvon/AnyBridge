// self-heal.test.js — 智能重试单测
//
// 用 Node 内置 node:test 运行：node --test sidecar/lib/self-heal.test.js
// 移植 cc-switch 的 thinking_rectifier / thinking_budget_rectifier / media_sanitizer 全部用例。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNSUPPORTED_IMAGE_MARKER,
  MAX_THINKING_BUDGET,
  MAX_TOKENS_VALUE,
  DEFAULT_SELF_HEAL_CONFIG,
  shouldHealThinkingSignature,
  shouldHealThinkingBudget,
  isUnsupportedImageError,
  healThinkingSignature,
  healThinkingBudget,
  healImageBlocks,
  containsImageBlocks,
  tryHeal,
} from './self-heal.js';

const enabled = { ...DEFAULT_SELF_HEAL_CONFIG };
const signatureDisabled = { enabled: true, signature: false, budget: true, media: true };
const budgetDisabled = { enabled: true, signature: true, budget: false, media: true };
const masterDisabled = { enabled: false, signature: true, budget: true, media: true };

// ==================== shouldHealThinkingSignature ====================

describe('shouldHealThinkingSignature', () => {
  it('detects invalid signature in thinking block', () => {
    assert.equal(shouldHealThinkingSignature("messages.1.content.0: Invalid `signature` in `thinking` block", enabled), true);
  });

  it('detects invalid signature without backticks', () => {
    assert.equal(shouldHealThinkingSignature("Messages.1.Content.0: invalid signature in thinking block", enabled), true);
  });

  it('detects thought signature not valid', () => {
    assert.equal(shouldHealThinkingSignature("Unable to submit request because Thought signature is not valid.. Learn more: https://example.com/help", enabled), true);
  });

  it('detects invalid signature in nested json', () => {
    const nested = '{"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"***.content.0: Invalid `signature` in `thinking` block\\"},\\"request_id\\":\\"req_xxx\\"}"}}';
    assert.equal(shouldHealThinkingSignature(nested, enabled), true);
  });

  it('detects thought signature in nested json', () => {
    const nested = '{"error":{"message":"Unable to submit request because Thought signature is not valid.. Learn more: https://example.com/help","type":"upstream_error","param":"","code":400}}';
    assert.equal(shouldHealThinkingSignature(nested, enabled), true);
  });

  it('detects expected thinking found tool_use', () => {
    assert.equal(shouldHealThinkingSignature("messages.69.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`.", enabled), true);
  });

  it('does not detect expected thinking found text', () => {
    assert.equal(shouldHealThinkingSignature("messages.69.content.0.type: Expected `thinking` or `redacted_thinking`, but found `text`.", enabled), false);
  });

  it('detects must start with thinking block', () => {
    assert.equal(shouldHealThinkingSignature("a final `assistant` message must start with a thinking block", enabled), true);
  });

  it('does not trigger for unrelated errors', () => {
    assert.equal(shouldHealThinkingSignature("Request timeout", enabled), false);
    assert.equal(shouldHealThinkingSignature("Connection refused", enabled), false);
    assert.equal(shouldHealThinkingSignature(null, enabled), false);
  });

  it('detects signature field required', () => {
    assert.equal(shouldHealThinkingSignature("***.***.***.***.***.signature: Field required", enabled), true);
    const nested = '{"error":{"type":"<nil>","message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"***.***.***.***.***.signature: Field required\\"},\\"request_id\\":\\"req_xxx\\"}"}}';
    assert.equal(shouldHealThinkingSignature(nested, enabled), true);
  });

  it('detects signature extra inputs not permitted', () => {
    assert.equal(shouldHealThinkingSignature("xxx.signature: Extra inputs are not permitted", enabled), true);
    assert.equal(shouldHealThinkingSignature("xxx.signature: Extra inputs not permitted", enabled), true);
  });

  it('detects thinking blocks cannot be modified', () => {
    assert.equal(shouldHealThinkingSignature("thinking or redacted_thinking blocks in the response cannot be modified", enabled), true);
  });

  it('detects invalid request phrases', () => {
    assert.equal(shouldHealThinkingSignature("非法请求：thinking signature 不合法", enabled), true);
    assert.equal(shouldHealThinkingSignature("illegal request: tool_use block mismatch", enabled), true);
    assert.equal(shouldHealThinkingSignature("invalid request: malformed JSON", enabled), true);
  });

  it('does not detect adaptive tag mismatch', () => {
    assert.equal(shouldHealThinkingSignature("Input tag 'adaptive' found using 'type' does not match expected tags", enabled), false);
  });

  it('respects signature sub-switch', () => {
    assert.equal(shouldHealThinkingSignature("Invalid `signature` in `thinking` block", signatureDisabled), false);
  });

  it('respects master switch', () => {
    assert.equal(shouldHealThinkingSignature("Invalid `signature` in `thinking` block", masterDisabled), false);
  });
});

// ==================== healThinkingSignature ====================

describe('healThinkingSignature', () => {
  it('removes thinking blocks and signature fields', () => {
    const body = {
      model: 'claude-test',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig' },
          { type: 'text', text: 'hello', signature: 'sig_text' },
          { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {}, signature: 'sig_tool' },
          { type: 'redacted_thinking', data: 'r', signature: 'sig_redacted' },
        ],
      }],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, true);
    assert.equal(result.removedThinkingBlocks, 1);
    assert.equal(result.removedRedactedThinkingBlocks, 1);
    assert.equal(result.removedSignatureFields, 2);

    const content = body.messages[0].content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].signature, undefined);
    assert.equal(content[1].type, 'tool_use');
    assert.equal(content[1].signature, undefined);
  });

  it('removes top level thinking when tool_use without prefix', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, true);
    assert.equal(body.thinking, undefined);
  });

  it('no change when no issues', () => {
    const body = {
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, false);
    assert.equal(result.removedThinkingBlocks, 0);
  });

  it('no change when no messages', () => {
    const body = { model: 'claude-test' };
    const result = healThinkingSignature(body);
    assert.equal(result.applied, false);
  });

  it('preserves thinking block removal triggers top level removal', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'enabled' },
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'some thought' },
          { type: 'tool_use', id: 'toolu_1', name: 'Test', input: {} },
        ],
      }],
    };
    const result = healThinkingSignature(body);

    // thinking block 被移除后，首块变成 tool_use，触发删除顶层 thinking
    assert.equal(result.applied, true);
    assert.equal(result.removedThinkingBlocks, 1);
  });

  it('keeps adaptive when no legacy blocks', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, false);
    assert.equal(body.thinking.type, 'adaptive');
    assert.equal(body.thinking.budget_tokens, undefined);
  });

  it('adaptive preserves existing budget_tokens', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'adaptive', budget_tokens: 5000 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, false);
    assert.equal(body.thinking.type, 'adaptive');
    assert.equal(body.thinking.budget_tokens, 5000);
  });

  it('enabled type no change with only user text', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, false);
    assert.equal(body.thinking.type, 'enabled');
  });

  it('adaptive does not remove top level thinking', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, false);
    assert.equal(body.thinking.type, 'adaptive');
  });

  it('adaptive still cleans legacy signature blocks', () => {
    const body = {
      model: 'claude-test',
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig_thinking' },
          { type: 'text', text: 'hello', signature: 'sig_text' },
        ],
      }],
    };
    const result = healThinkingSignature(body);

    assert.equal(result.applied, true);
    assert.equal(result.removedThinkingBlocks, 1);
    const content = body.messages[0].content;
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].signature, undefined);
    assert.equal(body.thinking.type, 'adaptive');
  });
});

// ==================== shouldHealThinkingBudget ====================

describe('shouldHealThinkingBudget', () => {
  it('detects budget_tokens + thinking + 1024', () => {
    assert.equal(shouldHealThinkingBudget("thinking.budget_tokens: Input should be greater than or equal to 1024", enabled), true);
  });

  it('does not detect budget_tokens without thinking', () => {
    assert.equal(shouldHealThinkingBudget("budget_tokens must be less than max_tokens", enabled), false);
  });

  it('does not detect 1024 without thinking + budget_tokens', () => {
    assert.equal(shouldHealThinkingBudget("budget_tokens: value must be at least 1024", enabled), false);
  });

  it('detects thinking budget_tokens >= 1024', () => {
    assert.equal(shouldHealThinkingBudget("thinking budget_tokens must be >= 1024", enabled), true);
  });

  it('does not trigger for unrelated error', () => {
    assert.equal(shouldHealThinkingBudget("Request timeout", enabled), false);
    assert.equal(shouldHealThinkingBudget(null, enabled), false);
  });

  it('respects budget sub-switch', () => {
    assert.equal(shouldHealThinkingBudget("thinking.budget_tokens: Input should be greater than or equal to 1024", budgetDisabled), false);
  });

  it('respects master switch', () => {
    assert.equal(shouldHealThinkingBudget("thinking.budget_tokens: Input should be greater than or equal to 1024", masterDisabled), false);
  });
});

// ==================== healThinkingBudget ====================

describe('healThinkingBudget', () => {
  it('adjusts budget and max_tokens', () => {
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 512 }, max_tokens: 1024 };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, true);
    assert.equal(result.before.thinkingType, 'enabled');
    assert.equal(result.after.thinkingType, 'enabled');
    assert.equal(result.before.thinkingBudgetTokens, 512);
    assert.equal(result.after.thinkingBudgetTokens, MAX_THINKING_BUDGET);
    assert.equal(result.before.maxTokens, 1024);
    assert.equal(result.after.maxTokens, MAX_TOKENS_VALUE);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.thinking.budget_tokens, MAX_THINKING_BUDGET);
    assert.equal(body.max_tokens, MAX_TOKENS_VALUE);
  });

  it('skips adaptive', () => {
    const body = { model: 'claude-test', thinking: { type: 'adaptive', budget_tokens: 512 }, max_tokens: 1024 };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, false);
    assert.deepEqual(result.before, result.after);
    assert.equal(body.thinking.type, 'adaptive');
    assert.equal(body.thinking.budget_tokens, 512);
    assert.equal(body.max_tokens, 1024);
  });

  it('preserves large max_tokens', () => {
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 512 }, max_tokens: 100000 };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, true);
    assert.equal(result.before.maxTokens, 100000);
    assert.equal(result.after.maxTokens, 100000);
    assert.equal(body.max_tokens, 100000);
  });

  it('creates thinking object when missing', () => {
    const body = { model: 'claude-test', max_tokens: 1024 };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, true);
    assert.equal(result.before.thinkingType, null);
    assert.equal(result.after.thinkingType, 'enabled');
    assert.equal(result.after.thinkingBudgetTokens, MAX_THINKING_BUDGET);
    assert.equal(result.after.maxTokens, MAX_TOKENS_VALUE);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.thinking.budget_tokens, MAX_THINKING_BUDGET);
    assert.equal(body.max_tokens, MAX_TOKENS_VALUE);
  });

  it('sets max_tokens when missing', () => {
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 512 } };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, true);
    assert.equal(result.before.maxTokens, null);
    assert.equal(result.after.maxTokens, MAX_TOKENS_VALUE);
    assert.equal(body.max_tokens, MAX_TOKENS_VALUE);
  });

  it('normalizes non-enabled type', () => {
    const body = { model: 'claude-test', thinking: { type: 'disabled', budget_tokens: 512 }, max_tokens: 1024 };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, true);
    assert.equal(result.before.thinkingType, 'disabled');
    assert.equal(result.after.thinkingType, 'enabled');
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.thinking.budget_tokens, MAX_THINKING_BUDGET);
    assert.equal(body.max_tokens, MAX_TOKENS_VALUE);
  });

  it('no change when already valid', () => {
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 32000 }, max_tokens: 64001 };
    const result = healThinkingBudget(body);

    assert.equal(result.applied, false);
    assert.deepEqual(result.before, result.after);
    assert.equal(body.thinking.budget_tokens, 32000);
    assert.equal(body.max_tokens, 64001);
  });
});

// ==================== isUnsupportedImageError ====================

describe('isUnsupportedImageError', () => {
  it('detects unsupported image error', () => {
    assert.equal(isUnsupportedImageError(400, '{"error":{"message":"This model does not support image input"}}'), true);
  });

  it('ignores non-image errors', () => {
    assert.equal(isUnsupportedImageError(400, '{"error":{"message":"Invalid API key"}}'), false);
  });

  it('detects media error phrasing', () => {
    assert.equal(isUnsupportedImageError(400, '{"error":{"message":"This model cannot process media inputs"}}'), true);
  });

  it('detects attachment error phrasing', () => {
    assert.equal(isUnsupportedImageError(422, '{"message":"attachments are not supported by this model"}'), true);
  });

  it('detects unknown variant image_url', () => {
    assert.equal(isUnsupportedImageError(400, '{"error":{"message":"Failed to deserialize the JSON body into the target type: messages[11]: unknown variant image_url, expected text"}}'), true);
  });

  it('rejects wrong status codes', () => {
    assert.equal(isUnsupportedImageError(401, '{"error":{"message":"image not supported"}}'), false);
    assert.equal(isUnsupportedImageError(500, '{"error":{"message":"image not supported"}}'), false);
  });

  it('rejects non-image messages at valid status', () => {
    assert.equal(isUnsupportedImageError(400, '{"error":{"message":"rate limit exceeded"}}'), false);
  });
});

// ==================== healImageBlocks ====================

describe('healImageBlocks', () => {
  it('replaces image blocks with marker', () => {
    const body = {
      model: 'mimo-v2.5-pro',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
      }],
    };

    assert.equal(containsImageBlocks(body), true);
    const count = healImageBlocks(body);

    assert.equal(count, 1);
    assert.equal(body.messages[0].content[0].type, 'text');
    assert.equal(body.messages[0].content[0].text, UNSUPPORTED_IMAGE_MARKER);
  });

  it('replaces nested tool_result image blocks', () => {
    const body = {
      model: 'deepseek-v4-pro',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
        }],
      }],
    };

    const count = healImageBlocks(body);

    assert.equal(count, 1);
    assert.equal(body.messages[0].content[0].content[0].text, UNSUPPORTED_IMAGE_MARKER);
  });

  it('preserves cache_control when replacing', () => {
    const body = {
      model: 'deepseek-v4-pro',
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc' },
          cache_control: { type: 'ephemeral' },
        }],
      }],
    };

    const count = healImageBlocks(body);

    assert.equal(count, 1);
    const block = body.messages[0].content[0];
    assert.equal(block.type, 'text');
    assert.equal(block.text, UNSUPPORTED_IMAGE_MARKER);
    assert.deepEqual(block.cache_control, { type: 'ephemeral' });
  });

  it('replaces chat image_url blocks', () => {
    const body = {
      model: 'deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      }],
    };

    const count = healImageBlocks(body);

    assert.equal(count, 1);
    assert.equal(body.messages[0].content[1].type, 'text');
    assert.equal(body.messages[0].content[1].text, UNSUPPORTED_IMAGE_MARKER);
  });

  it('replaces codex input_image blocks', () => {
    const body = {
      model: 'deepseek-v4-flash',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc' },
        ],
      }],
    };

    const count = healImageBlocks(body);

    assert.equal(count, 1);
    assert.equal(body.input[0].content[1].type, 'input_text');
    assert.equal(body.input[0].content[1].text, UNSUPPORTED_IMAGE_MARKER);
  });

  it('returns 0 when no image blocks', () => {
    const body = {
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };

    assert.equal(containsImageBlocks(body), false);
    assert.equal(healImageBlocks(body), 0);
  });
});

// ==================== tryHeal 编排器 ====================

describe('tryHeal', () => {
  it('triggers signature heal once', () => {
    const body = {
      model: 'claude-test',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig' },
          { type: 'text', text: 'hello' },
        ],
      }],
    };
    const state = { signatureHealed: false, budgetHealed: false, mediaHealed: false };

    const r1 = tryHeal(body, 400, "Invalid `signature` in `thinking` block", enabled, state);
    assert.equal(r1.healed, true);
    assert.equal(r1.kind, 'signature');
    assert.equal(state.signatureHealed, true);

    // 第二次同样错误不再整流
    const r2 = tryHeal(body, 400, "Invalid `signature` in `thinking` block", enabled, state);
    assert.equal(r2.healed, false);
  });

  it('triggers budget heal when signature not applicable', () => {
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 512 }, max_tokens: 1024 };
    const state = { signatureHealed: false, budgetHealed: false, mediaHealed: false };

    const r = tryHeal(body, 400, "thinking.budget_tokens: Input should be greater than or equal to 1024", enabled, state);
    assert.equal(r.healed, true);
    assert.equal(r.kind, 'budget');
    assert.equal(state.budgetHealed, true);
  });

  it('triggers media heal', () => {
    const body = {
      model: 'deepseek-v4-pro',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
      }],
    };
    const state = { signatureHealed: false, budgetHealed: false, mediaHealed: false };

    const r = tryHeal(body, 400, '{"error":{"message":"This model does not support image input"}}', enabled, state);
    assert.equal(r.healed, true);
    assert.equal(r.kind, 'media');
    assert.equal(state.mediaHealed, true);
  });

  it('does not heal when config disabled', () => {
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 512 } };
    const state = { signatureHealed: false, budgetHealed: false, mediaHealed: false };

    const r = tryHeal(body, 400, "Invalid `signature` in `thinking` block", masterDisabled, state);
    assert.equal(r.healed, false);
  });

  it('returns not healed when nothing matches', () => {
    const body = { model: 'claude-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    const state = { signatureHealed: false, budgetHealed: false, mediaHealed: false };

    const r = tryHeal(body, 500, "Internal server error", enabled, state);
    assert.equal(r.healed, false);
    assert.equal(r.kind, null);
  });

  it('signature applied=false falls through to budget', () => {
    // 签名错误匹配但 body 无 thinking block 可整流，继续尝试 budget
    const body = { model: 'claude-test', thinking: { type: 'enabled', budget_tokens: 512 }, max_tokens: 1024 };
    const state = { signatureHealed: false, budgetHealed: false, mediaHealed: false };
    // 错误同时匹配签名场景7(invalid request)和预算条件
    const errorText = "invalid request: thinking budget_tokens must be >= 1024";

    const r = tryHeal(body, 400, errorText, enabled, state);
    // 签名整流 applied=false（无 thinking block），继续 budget 命中
    assert.equal(r.healed, true);
    assert.equal(r.kind, 'budget');
  });
});
