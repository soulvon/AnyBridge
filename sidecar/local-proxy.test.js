import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { invalidate } from './config-cache.js';
import { __localProxyTest } from './local-proxy.js';

test('paramOverrides maps public max_tokens alias to internal maxTokens', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 128,
  });

  __localProxyTest.applyParamOverrides(ctx, {
    paramOverridesEnabled: true,
    paramOverrides: {
      max_tokens: 4096,
      top_p: 0.7,
    },
  });

  assert.equal(ctx.maxTokens, 4096);
  assert.deepEqual(ctx.paramOverrideExtras, { top_p: 0.7 });
});

test('paramOverrides are emitted even when route passthrough is disabled', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hello' }],
  });
  ctx.preserveExtraParams = false;

  __localProxyTest.applyParamOverrides(ctx, {
    paramOverridesEnabled: true,
    paramOverrides: {
      top_p: 0.7,
    },
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'upstream-model',
    apiPath: '/v1/chat/completions',
  }, ctx);

  assert.equal(body.top_p, 0.7);
});

test('OpenAI exposed routes also accept Responses API requests', () => {
  const route = {
    id: 'local-model',
    exposedFormats: ['openai'],
    targets: [{ providerId: 'provider-1', model: 'upstream-model' }],
  };

  assert.equal(__localProxyTest.routeSupportsKind(route, 'openai'), true);
  assert.equal(__localProxyTest.routeSupportsKind(route, 'responses'), true);
  assert.equal(__localProxyTest.routeSupportsKind(route, 'anthropic'), false);
});

test('Gemini Native requests convert to Gemini upstream payloads', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    systemInstruction: { parts: [{ text: 'You are concise.' }] },
    contents: [{
      role: 'user',
      parts: [
        { text: 'hello' },
        { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 256,
      temperature: 0.2,
      topP: 0.9,
    },
    tools: [{
      functionDeclarations: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } },
  });

  const body = __localProxyTest.upstreamBody({
    format: 'gemini',
    model: 'gemini-2.5-pro',
    apiPath: '/v1beta/models/gemini-2.5-pro:generateContent',
  }, ctx);

  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'You are concise.' }] });
  assert.equal(body.contents[0].role, 'user');
  assert.deepEqual(body.contents[0].parts[0], { text: 'hello' });
  assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'aW1n' } });
  assert.equal(body.generationConfig.maxOutputTokens, 256);
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal(body.generationConfig.topP, 0.9);
  assert.equal(body.tools[0].functionDeclarations[0].name, 'read_file');
  assert.deepEqual(body.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] },
  });
});

test('Codex unlock keeps Responses payload even when provider wireApi is chat', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
    max_output_tokens: 128,
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.5',
    apiPath: '/v1/responses',
    wireApi: 'chat',
    unlockKind: 'codex',
    unlocks: {
      codex: {
        enabled: true,
        wireApi: '/v1/responses',
        include: ['reasoning.encrypted_content'],
      },
    },
  }, ctx);

  assert.equal(body.model, 'gpt-5.5');
  assert.ok(Array.isArray(body.input));
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.match(body.prompt_cache_key, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(body.store, false);
  assert.equal('messages' in body, false);
  assert.equal('max_tokens' in body, false);
});

test('Responses upstream forces store:false even when preserveExtraParams sets store:true', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
    store: true,
  });
  ctx.preserveExtraParams = true;

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.5',
    apiPath: '/v1/responses',
  }, ctx);

  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-5.5');
  assert.ok(Array.isArray(body.input));
});

test('tool filtering rejects stale tool_choice references', () => {
  const ctx = {
    tools: [
      { type: 'function', function: { name: 'read_file' } },
      { type: 'function', function: { name: 'delete_file' } },
    ],
    toolChoice: { type: 'function', function: { name: 'delete_file' } },
  };

  assert.throws(() => __localProxyTest.applyToolEnhancement(ctx, {
    toolFilterEnabled: true,
    toolFilterMode: 'deny',
    toolFilterList: ['delete_file'],
  }), /tool_choice 指向不可用工具: delete_file/);
});

test('Codex route scope keeps raw model ids instead of applying global rename rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-local-proxy-'));
  const previousConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  try {
    fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
      proxyRouteRenameRule: {
        enabled: true,
        mode: 'simple',
        prefix: 'AB-',
      },
    }), 'utf8');

    const route = { id: 'deepseek-v4-flash', targets: [] };
    assert.equal(__localProxyTest.renderedProxyRouteId(route), 'AB-deepseek-v4-flash');
    assert.equal(
      __localProxyTest.renderedProxyRouteId(route, { applyRename: false }),
      'deepseek-v4-flash',
    );
  } finally {
    invalidate('all');
    if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
