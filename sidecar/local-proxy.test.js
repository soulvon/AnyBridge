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
