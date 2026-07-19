import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCodexUnlockRequiredFields,
  claudeCodeUnlockForTarget,
  codexUnlockForTarget,
} from './codex-unlock.js';

const providerUnlocks = {
  codex: {
    enabled: true,
    wireApi: '/v1/responses',
    include: ['reasoning.encrypted_content'],
  },
  claudeCode: {
    enabled: true,
    wireApi: '/v1/messages?beta=true',
  },
};

describe('Codex supplier unlock routing', () => {
  it('does not apply provider-level Codex unlock unless the target opts in', () => {
    assert.equal(codexUnlockForTarget({ unlocks: providerUnlocks, unlockKind: null }), null);
    assert.equal(codexUnlockForTarget({ unlocks: providerUnlocks, unlockKind: 'claudeCode' }), null);
  });

  it('applies Codex unlock only for target.unlock="codex"', () => {
    assert.deepEqual(codexUnlockForTarget({ unlocks: providerUnlocks, unlockKind: 'codex' }), {
      include: ['reasoning.encrypted_content'],
      wireApi: '/v1/responses',
    });
  });

  it('applies Claude Code unlock only for target.unlock="claudeCode"', () => {
    assert.equal(claudeCodeUnlockForTarget({ unlocks: providerUnlocks, unlockKind: null }), null);
    assert.equal(claudeCodeUnlockForTarget({ unlocks: providerUnlocks, unlockKind: 'codex' }), null);
    assert.deepEqual(claudeCodeUnlockForTarget({ unlocks: providerUnlocks, unlockKind: 'claudeCode' }), {
      wireApi: '/v1/messages?beta=true',
    });
  });

  it('adds only the required Codex unlock fields', () => {
    const payload = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      stream: true,
      store: true,
    };

    applyCodexUnlockRequiredFields(payload, codexUnlockForTarget({
      unlocks: providerUnlocks,
      unlockKind: 'codex',
    }));

    assert.deepEqual(Object.keys(payload).sort(), ['include', 'input', 'model', 'prompt_cache_key', 'store', 'stream']);
    assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
    assert.equal(payload.store, false);
    assert.match(payload.prompt_cache_key, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
