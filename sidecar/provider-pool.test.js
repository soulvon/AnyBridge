import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTarget } from './provider-pool.js';

function providersWithChatWireApiUnlocks() {
  return new Map([[
    'anyrouter',
    {
      id: 'anyrouter',
      name: 'AnyRouter',
      enabled: true,
      apiHost: 'https://api.anyrouter.test',
      apiKey: 'sk-test',
      apiPath: '/v1',
      defaultModel: 'gpt-5.5',
      wireApi: 'chat',
      capabilities: { tools: true, vision: true },
      unlocks: {
        codex: {
          enabled: true,
          wireApi: '/v1/responses',
          include: ['reasoning.encrypted_content'],
        },
        claudeCode: {
          enabled: true,
          wireApi: '/v1/messages?beta=true',
        },
      },
    },
  ]]);
}

test('resolveTarget preserves Codex unlock wireApi when provider wireApi is chat', () => {
  const conn = resolveTarget({
    providerId: 'anyrouter',
    model: 'gpt-5.5',
    unlock: 'codex',
  }, providersWithChatWireApiUnlocks());

  assert.equal(conn.error, undefined);
  assert.equal(conn.format, 'openai');
  assert.equal(conn.unlockKind, 'codex');
  assert.equal(conn.apiPath, '/v1/responses');
});

test('resolveTarget still uses chat path for ordinary chat-wire providers', () => {
  const conn = resolveTarget({
    providerId: 'anyrouter',
    model: 'gpt-5.5',
  }, providersWithChatWireApiUnlocks());

  assert.equal(conn.error, undefined);
  assert.equal(conn.format, 'openai');
  assert.equal(conn.unlockKind, null);
  assert.equal(conn.apiPath, '/v1/chat/completions');
});

test('resolveTarget rejects apiPath overrides that conflict with platform unlock wireApi', () => {
  const conn = resolveTarget({
    providerId: 'anyrouter',
    model: 'gpt-5.5',
    unlock: 'codex',
    apiPath: '/v1/chat/completions',
  }, providersWithChatWireApiUnlocks());

  assert.match(conn.error, /Codex 解锁目标不支持覆盖 apiPath/);
});
