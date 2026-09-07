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

test('Gemini streamGenerateContent renders single-event SSE snapshot', () => {
  const writes = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(data) { writes.push(data); },
    end() { this.ended = true; },
  };

  __localProxyTest.sendGeminiStream({ model: 'local-model' }, res, {
    conn: { format: 'openai' },
    text: 'hi',
    toolCalls: [{ name: 'read_file', arguments: { path: 'a' } }],
    usage: { inputTokens: 3, outputTokens: 5 },
  }, true);

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.ended, true);
  const chunks = writes
    .filter(l => l.startsWith('data: '))
    .map(l => JSON.parse(l.slice('data: '.length)));
  // 官方语义：alt=sse 每个 data 是累计快照，finishReason 只出现在终止块；
  // 单事件快照同时携带完整内容与 finishReason，客户端不会中途截断。
  assert.equal(chunks.length, 1);
  const candidate = chunks[0].candidates[0];
  assert.equal(candidate.finishReason, 'STOP');
  assert.deepEqual(candidate.content.parts[0], { text: 'hi' });
  assert.equal(candidate.content.parts[1].functionCall.name, 'read_file');
  assert.equal(candidate.content.parts[1].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(chunks[0].usageMetadata.totalTokenCount, 8);
});

test('Gemini streamGenerateContent without alt=sse returns JSON array stream', () => {
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write() {},
    end() { this.ended = true; },
  };

  __localProxyTest.sendGeminiStream({ model: 'local-model' }, res, {
    conn: { format: 'openai' },
    text: 'hi',
    usage: { inputTokens: 3, outputTokens: 5 },
  }, false);

  assert.equal(res.ended, true);
});

test('Gemini streamGenerateContent emits empty chunk when result has no content', () => {
  const writes = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(data) { writes.push(data); },
    end() { this.ended = true; },
  };

  __localProxyTest.sendGeminiStream({ model: 'local-model' }, res, { usage: {} }, true);

  const chunks = writes
    .filter(l => l.startsWith('data: '))
    .map(l => JSON.parse(l.slice('data: '.length)));
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].candidates[0].content.parts, [{ text: '' }]);
});

test('Gemini request keeps thoughtSignature and replays it to Gemini upstream', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [{
      role: 'model',
      parts: [{ functionCall: { name: 'check_flight', args: { flight: 'AA100' } }, thoughtSignature: 'sig-A' }],
    }],
  });

  const body = __localProxyTest.upstreamBody({
    format: 'gemini',
    model: 'gemini-3-pro',
    apiPath: '/v1beta/models/gemini-3-pro:generateContent',
  }, ctx);

  assert.equal(body.contents[0].parts[0].thoughtSignature, 'sig-A');
  assert.deepEqual(body.contents[0].parts[0].functionCall, { name: 'check_flight', args: { flight: 'AA100' } });

  // Anthropic 上游必须剥离内部签名字段，避免严格网关 400
  const anthropicBody = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-x',
    apiPath: '/v1/messages',
  }, {
    ...ctx,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi', thoughtSignature: 'sig-A' }] }],
    system: '',
  });
  assert.equal('thoughtSignature' in anthropicBody.messages[0].content[0], false);
  assert.equal(anthropicBody.messages[0].content[0].text, 'hi');
});

test('Gemini response rebuild attaches placeholder signature for cross-protocol tool calls', () => {
  const writes = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(data) { writes.push(data); },
    end(data) { if (data) writes.push(data); this.ended = true; },
  };

  __localProxyTest.sendGemini({ model: 'local-model' }, res, {
    conn: { format: 'openai' },
    text: '',
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    usage: { inputTokens: 3, outputTokens: 5 },
  });

  const body = JSON.parse(writes[0]);
  const part = body.candidates[0].content.parts[0];
  assert.deepEqual(part.functionCall, { id: 'call-1', name: 'read_file', args: { path: 'a' } });
  assert.equal(part.thoughtSignature, 'skip_thought_signature_validator');
});

test('Gemini model id from path strips models/ resource-name prefix', () => {
  assert.equal(__localProxyTest.geminiModelFromPath('/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini-2.5-pro');
  assert.equal(__localProxyTest.geminiModelFromPath('/v1beta/models/models/gemini-2.5-pro:generateContent'), 'gemini-2.5-pro');
  assert.equal(__localProxyTest.geminiModelFromPath('/v1beta/models/models/gemini-2.5-pro:streamGenerateContent'), 'gemini-2.5-pro');
  assert.equal(__localProxyTest.geminiModelFromPath('/v1beta/models/models/gemini-2.5-pro:countTokens'), 'gemini-2.5-pro');
  assert.equal(__localProxyTest.geminiModelFromPath('/v1beta/models/gemini-2.5-pro:countTokens'), 'gemini-2.5-pro');
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
