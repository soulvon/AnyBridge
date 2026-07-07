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

test('resolveTarget supports Gemini Native providers', () => {
  const providers = new Map([[
    'google',
    {
      id: 'google',
      name: 'Google Gemini',
      enabled: true,
      apiHost: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-test',
      apiPath: '/v1beta',
      defaultModel: 'gemini-2.5-pro',
    },
  ]]);

  const conn = resolveTarget({
    providerId: 'google',
    model: 'gemini-2.5-flash',
    apiFormat: 'gemini',
  }, providers);

  assert.equal(conn.error, undefined);
  assert.equal(conn.format, 'gemini');
  assert.equal(conn.host, 'generativelanguage.googleapis.com');
  assert.equal(conn.apiPath, '/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(conn.authScheme, 'x-api-key');
});

test('resolveTarget preserves HTTP localhost provider ports', () => {
  const providers = new Map([[
    'cpa',
    {
      id: 'cpa',
      name: 'CPA',
      enabled: true,
      apiHost: 'http://localhost:8317',
      apiKey: 'sk-test',
      defaultModel: 'grok-composer-2.5-fast',
    },
  ]]);

  const conn = resolveTarget({
    providerId: 'cpa',
    model: 'grok-composer-2.5-fast',
    apiFormat: 'openai',
  }, providers);

  assert.equal(conn.error, undefined);
  assert.equal(conn.protocol, 'http');
  assert.equal(conn.hostname, 'localhost');
  assert.equal(conn.host, 'localhost');
  assert.equal(conn.port, 8317);
  assert.equal(conn.apiPath, '/v1/chat/completions');
});

test('resolveTarget joins apiHost path prefixes with normalized API paths', () => {
  const providers = new Map([[
    'longcat',
    {
      id: 'longcat',
      name: 'LongCat',
      enabled: true,
      apiHost: 'https://api.longcat.chat/openai',
      apiKey: 'ak-test',
      apiPath: '/v1/chat/completions',
      defaultModel: 'LongCat-Flash-Chat',
    },
  ]]);

  const conn = resolveTarget({
    providerId: 'longcat',
    model: 'LongCat-Flash-Chat',
    apiFormat: 'openai',
  }, providers);

  assert.equal(conn.error, undefined);
  assert.equal(conn.protocol, 'https');
  assert.equal(conn.hostname, 'api.longcat.chat');
  assert.equal(conn.apiPath, '/openai/v1/chat/completions');
});
