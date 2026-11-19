import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { invalidate } from '../config-cache.js';
import { handleLocalProxyRequest } from '../local-proxy.js';
import { closeServer, mockRes, startServer } from './google-gemini-test-helpers.js';
test('Antigravity local-proxy pins resolved config when two configs share the same upstreamModel', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-ag-pinned-'));
  const prevConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = tmpDir;
  invalidate();

  const hitOrder = [];
  const srvA = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hitOrder.push({ server: 'A', url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'from-A' }] }, finishReason: 'STOP' }],
        totalTokens: 11,
      }));
    });
  });
  const srvB = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hitOrder.push({ server: 'B', url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'from-B' }] }, finishReason: 'STOP' }],
        totalTokens: 22,
      }));
    });
  });

  try {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({ values: { LOCAL_PROXY_KEY: 'local-k' } }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [
        { id: 'prov-a', name: 'Provider A', apiHost: `http://127.0.0.1:${srvA.port}`, apiKey: 'AIza-A', apiFormat: 'gemini', enabled: true },
        { id: 'prov-b', name: 'Provider B', apiHost: `http://127.0.0.1:${srvB.port}`, apiPath: '/v1/publishers/google/models', apiKey: 'AQ.B', apiFormat: 'gemini', enabled: true },
      ],
      antigravityConfigs: [
        { id: 'ag-aistudio-pro', name: 'AG AIStudio', defaultModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'], sourceProviderId: 'prov-a', enabled: true },
        { id: 'ag-vertex-pro', name: 'AG Vertex', defaultModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'], sourceProviderId: 'prov-b', enabled: true },
      ],
    }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'model-map.json'), JSON.stringify({ slots: [] }), 'utf8');
    invalidate();

    const genRes = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:generateContent', headers: {} },
      genRes,
      JSON.stringify({ model: 'ag-vertex-pro', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }),
    );
    await genRes.waitForEnd();
    assert.equal(genRes.statusCode, 200);
    assert.match(genRes.bodyText, /from-B/);

    const countRes = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:countTokens', headers: {} },
      countRes,
      JSON.stringify({ model: 'ag-vertex-pro', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }),
    );
    await countRes.waitForEnd();
    assert.equal(countRes.statusCode, 200);
    assert.deepEqual(JSON.parse(countRes.bodyText), { totalTokens: 22 });
    assert.equal(hitOrder.every((h) => h.server === 'B'), true);
    assert.ok(hitOrder.some((h) => h.url.includes('/v1/publishers/google/models/gemini-2.5-pro:countTokens')));
  } finally {
    await closeServer(srvA.server);
    await closeServer(srvB.server);
    if (prevConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevConfigDir;
    invalidate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Antigravity sourceProviderId takes precedence over stale antigravityConfigs snapshot', async () => {
  const { handleLocalProxyRequest } = await import('../local-proxy.js');
  const { invalidate } = await import('../config-cache.js');
  const { loadProviders } = await import('../provider-pool.js');
  const { resolveAntigravityProxyModel } = await import('./local-proxy/routes.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-live-source-'));
  const prevConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = tmpDir;

  const hits = [];
  const srvLive = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ url: req.url, key: req.headers['x-goog-api-key'] || '', auth: req.headers.authorization || '', raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'live-ok' }] }, finishReason: 'STOP' }],
      }));
    });
  });

  try {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({ values: { LOCAL_PROXY_KEY: 'local-k' } }), 'utf8');
    // 主供应商已经迁移到 Gemini 原生 /v1/publishers/google/models，但 antigravityConfigs 上遗留了过时的 openai/sk-old 快照
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [
        {
          id: 'prov-live',
          name: 'Live Source',
          apiHost: `http://127.0.0.1:${srvLive.port}`,
          apiPath: '/v1/publishers/google/models',
          apiKey: 'AIza-live-key',
          apiFormat: 'gemini',
          enabled: true,
        },
      ],
      antigravityConfigs: [
        {
          id: 'ag-stale',
          name: 'gemini-2.5-pro',
          defaultModel: 'gemini-2.5-pro',
          models: ['gemini-2.5-pro'],
          sourceProviderId: 'prov-live',
          apiHost: 'http://127.0.0.1:9',
          apiPath: '/v1/chat/completions',
          apiKey: 'sk-stale-key',
          apiFormat: 'openai',
          enabled: true,
        },
      ],
    }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'model-map.json'), JSON.stringify({ slots: [] }), 'utf8');
    invalidate('all');

    const loaded = loadProviders();
    const cachedAg = loaded.get('ag-stale');
    assert.equal(cachedAg.apiHost, `http://127.0.0.1:${srvLive.port}`);
    assert.equal(cachedAg.apiPath, '/v1/publishers/google/models');
    assert.equal(cachedAg.apiKey, 'AIza-live-key');
    assert.equal(cachedAg.apiFormat, 'gemini');

    const resolved = resolveAntigravityProxyModel('ag-stale', loaded, JSON.parse(fs.readFileSync(path.join(tmpDir, 'providers.json'), 'utf8')));
    assert.equal(resolved.route.targets[0].apiFormat, 'gemini');
    assert.equal(resolved.route.targets[0].apiPath, '/v1/publishers/google/models');

    const res = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:generateContent', headers: {} },
      res,
      JSON.stringify({ model: 'ag-stale', request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } }),
    );
    await res.waitForEnd();
    assert.equal(res.statusCode, 200);
    assert.match(res.bodyText, /live-ok/);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, 'AIza-live-key');
    assert.ok(hits[0].url.includes('/v1/publishers/google/models/gemini-2.5-pro:generateContent'));
  } finally {
    await closeServer(srvLive.server);
    if (prevConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevConfigDir;
    invalidate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gemini -> gemini native passthrough preserves fileData, executableCode, codeExecutionResult, multipart systemInstruction and raw tools', async () => {
  const { normalizeRequest } = await import('./local-proxy/normalize.js');
  const { upstreamBody } = await import('./local-proxy/upstream-payload.js');

  const rawGeminiBody = {
    model: 'gemini-2.5-pro',
    stream: true,
    cachedContent: 'cachedContents/abc123',
    systemInstruction: {
      role: 'user',
      parts: [
        { text: 'Rule 1' },
        { fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/spec.txt' } },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Analyze this' },
          { fileData: { mimeType: 'application/pdf', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz' } },
        ],
      },
      {
        role: 'model',
        parts: [
          { executableCode: { language: 'PYTHON', code: 'print(6 * 7)' } },
          { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '42\n' } },
        ],
      },
    ],
    tools: [
      { codeExecution: {} },
      { googleSearch: {} },
      { functionDeclarations: [{ name: 'lookup', description: 'Lookup item', parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' } } } }] },
    ],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { answer: { type: 'INTEGER' } } },
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
    },
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
  };

  const ctx = normalizeRequest('gemini', rawGeminiBody);
  // normalizeRequest 不再把 fileData / executableCode / codeExecutionResult 丢弃
  assert.equal(ctx.messages.length, 2);
  assert.equal(ctx.messages[0].content.length, 2);
  assert.equal(ctx.messages[0].content[1].type, 'gemini_part');
  assert.equal(ctx.messages[1].content.length, 2);
  assert.equal(ctx.messages[1].content[0].type, 'gemini_part');
  assert.equal(ctx.messages[1].content[1].type, 'gemini_part');

  const geminiUpstream = upstreamBody({ format: 'gemini', model: 'gemini-2.5-pro' }, ctx);
  assert.equal(geminiUpstream.model, undefined);
  assert.equal(geminiUpstream.stream, undefined);
  assert.equal(geminiUpstream.cachedContent, 'cachedContents/abc123');
  assert.deepEqual(geminiUpstream.systemInstruction, rawGeminiBody.systemInstruction);
  assert.deepEqual(geminiUpstream.contents, rawGeminiBody.contents);
  assert.deepEqual(geminiUpstream.tools, rawGeminiBody.tools);
  assert.deepEqual(geminiUpstream.toolConfig, rawGeminiBody.toolConfig);
  assert.deepEqual(geminiUpstream.generationConfig.responseSchema, rawGeminiBody.generationConfig.responseSchema);
  assert.equal(geminiUpstream.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(geminiUpstream.safetySettings, rawGeminiBody.safetySettings);

  // 叠加 systemPromptPrefix 时保留原本的多 part systemInstruction 并在首部插入前缀
  const prefixed = upstreamBody(
    { format: 'gemini', model: 'gemini-2.5-pro' },
    { ...ctx, systemPromptPrefixApplied: 'Global Prefix' },
  );
  assert.equal(prefixed.systemInstruction.parts.length, 3);
  assert.deepEqual(prefixed.systemInstruction.parts[0], { text: 'Global Prefix' });
  assert.deepEqual(prefixed.systemInstruction.parts[1], { text: 'Rule 1' });
  assert.deepEqual(prefixed.systemInstruction.parts[2], rawGeminiBody.systemInstruction.parts[1]);

  // 跨协议到 OpenAI 时，fileData / executableCode / codeExecutionResult 有降级文本，而非静默丢失
  const openaiUpstream = upstreamBody({ format: 'openai', model: 'gpt-4o', apiPath: '/v1/chat/completions' }, ctx);
  const serialized = JSON.stringify(openaiUpstream.messages);
  assert.match(serialized, /generativelanguage\.googleapis\.com\/v1beta\/files\/xyz/);
  assert.match(serialized, /print\(6 \* 7\)/);
  assert.match(serialized, /Code Execution OUTCOME_OK/);
});

test('gemini -> gemini native countTokens forwards raw multipart systemInstruction, fileData and tools', async () => {
  const { handleLocalProxyRequest } = await import('../local-proxy.js');
  const { invalidate } = await import('../config-cache.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-native-count-'));
  const prevConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = tmpDir;

  let seenUpstreamBody = null;
  const srv = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenUpstreamBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totalTokens: 77 }));
    });
  });

  try {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({ values: { LOCAL_PROXY_KEY: 'local-k' } }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [{ id: 'p-gem', name: 'Gem', apiHost: `http://127.0.0.1:${srv.port}`, apiKey: 'AIza-k', apiFormat: 'gemini', enabled: true }],
    }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'proxy-routes.json'), JSON.stringify({
      version: 1,
      routes: [{
        uid: 'u-gem-count',
        id: 'gemini-2.5-pro',
        enabled: true,
        exposedFormats: ['gemini'],
        targets: [{ providerId: 'p-gem', model: 'gemini-2.5-pro', apiFormat: 'gemini' }],
      }],
    }), 'utf8');
    invalidate('all');

    const countPayload = {
      systemInstruction: { parts: [{ text: 'Sys A' }, { text: 'Sys B' }] },
      contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'gs://x/y.pdf' } }] }],
      tools: [{ googleSearch: {} }],
    };
    const res = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1beta/models/gemini-2.5-pro:countTokens', headers: { 'x-goog-api-key': 'local-k' } },
      res,
      JSON.stringify(countPayload),
    );
    await res.waitForEnd();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.bodyText), { totalTokens: 77 });
    const forwarded = seenUpstreamBody.generateContentRequest || seenUpstreamBody;
    assert.deepEqual(forwarded.systemInstruction, countPayload.systemInstruction);
    assert.deepEqual(forwarded.contents, countPayload.contents);
    assert.deepEqual(forwarded.tools, countPayload.tools);
  } finally {
    await closeServer(srv.server);
    if (prevConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevConfigDir;
    invalidate('all');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Antigravity v1internal passthrough strips internal LS wrapper keys and normalizes snake/camel without dropping top-level controls', async () => {
  const { handleLocalProxyRequest } = await import('../local-proxy.js');
  const { invalidate } = await import('../config-cache.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v1int-clean-'));
  const prevConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = tmpDir;

  let seenUpstream = null;
  let seenCountUpstream = null;
  const srv = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      if (req.url.includes(':countTokens')) seenCountUpstream = parsed;
      else seenUpstream = parsed;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.includes(':countTokens')
        ? { totalTokens: 42 }
        : { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'clean-ok' }] }, finishReason: 'STOP' }] }));
    });
  });

  try {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({ values: { LOCAL_PROXY_KEY: 'local-k' } }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [{ id: 'p-gem', name: 'Gem', apiHost: `http://127.0.0.1:${srv.port}`, apiKey: 'AIza-k', apiFormat: 'gemini', enabled: true }],
      antigravityConfigs: [{ id: 'ag-1', name: 'gemini-2.5-pro', defaultModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'], sourceProviderId: 'p-gem', enabled: true }],
    }), 'utf8');
    invalidate('all');

    const res = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:generateContent', headers: {} },
      res,
      JSON.stringify({
        model: 'ag-1',
        project: 'cloudcode-proj',
        requestId: 'req-123',
        userAgent: 'antigravity/1.0',
        requestType: 'agent',
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        request: {
          session_id: 'sess-abc',
          sessionId: 'sess-abc',
          user_prompt_id: 'prompt-1',
          metadata: { ideType: 'ANTIGRAVITY' },
          system_instruction: { parts: [{ text: 'Keep native parts' }] },
          contents: [{ role: 'user', parts: [{ text: 'hi' }, { executableCode: { language: 'PYTHON', code: 'print(1)' } }] }],
          generation_config: {
            max_output_tokens: 512,
            thinking_config: { thinking_budget: 256, include_thoughts: true },
          },
        },
      }),
    );
    await res.waitForEnd();
    assert.equal(res.statusCode, 200);
    assert.ok(seenUpstream);
    for (const forbidden of ['project', 'requestId', 'userAgent', 'requestType', 'session_id', 'sessionId', 'user_prompt_id', 'metadata', 'system_instruction', 'generation_config']) {
      assert.equal(Object.prototype.hasOwnProperty.call(seenUpstream, forbidden), false, `透传负载不得泄漏字段 ${forbidden}`);
    }
    assert.deepEqual(seenUpstream.systemInstruction, { parts: [{ text: 'Keep native parts' }] });
    assert.deepEqual(seenUpstream.safetySettings, [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }]);
    assert.deepEqual(seenUpstream.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
    assert.equal(seenUpstream.generationConfig.maxOutputTokens, 512);
    assert.equal(seenUpstream.generationConfig.max_output_tokens, undefined);
    assert.deepEqual(seenUpstream.generationConfig.thinkingConfig, { thinkingBudget: 256, includeThoughts: true });

    const countRes = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:countTokens', headers: {} },
      countRes,
      JSON.stringify({
        model: 'ag-1',
        systemInstruction: { parts: [{ text: 'TopSys' }] },
        tools: [{ googleSearch: {} }],
        request: { contents: [{ role: 'user', parts: [{ text: 'count me' }] }] },
      }),
    );
    await countRes.waitForEnd();
    assert.equal(countRes.statusCode, 200);
    const forwardedCount = seenCountUpstream.generateContentRequest || seenCountUpstream;
    assert.deepEqual(forwardedCount.systemInstruction, { parts: [{ text: 'TopSys' }] });
    assert.deepEqual(forwardedCount.tools, [{ googleSearch: {} }]);
  } finally {
    await closeServer(srv.server);
    if (prevConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevConfigDir;
    invalidate('all');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Antigravity internal dependency routes to last-used config even when two configs share the same upstreamModel, and disabled sourceProvider does not fall back to proxyRoutes', async () => {
  const { handleLocalProxyRequest } = await import('../local-proxy.js');
  const { resolveProxyModel } = await import('./local-proxy/routes.js');
  const { invalidate } = await import('../config-cache.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-shared-upstream-'));
  const prevConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = tmpDir;

  const hits = [];
  const srvFirst = await startServer((req, res) => {
    hits.push('first');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'wrong-first' }, finish_reason: 'stop' }] }));
  });
  const srvSecond = await startServer((req, res) => {
    hits.push('second');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'right-second' }] }, finishReason: 'STOP' }],
    }));
  });

  try {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({ values: { LOCAL_PROXY_KEY: 'local-k' } }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [
        { id: 'p-first', name: 'First OpenAI', apiHost: `http://127.0.0.1:${srvFirst.port}`, apiPath: '/v1/chat/completions', apiKey: 'sk-1', apiFormat: 'openai', enabled: true },
        { id: 'p-second', name: 'Second Gemini', apiHost: `http://127.0.0.1:${srvSecond.port}`, apiKey: 'AIza-2', apiFormat: 'gemini', enabled: true },
        { id: 'p-disabled', name: 'Disabled Prov', apiHost: `http://127.0.0.1:${srvFirst.port}`, apiKey: 'sk-off', apiFormat: 'openai', enabled: false },
      ],
      antigravityConfigs: [
        { id: 'ag-first', name: 'First Shared', defaultModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'], sourceProviderId: 'p-first', enabled: true, injectModels: true },
        { id: 'ag-second', name: 'Second Shared', defaultModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'], sourceProviderId: 'p-second', enabled: true, injectModels: true },
        { id: 'ag-disabled', name: 'Disabled Shared', defaultModel: 'fallback-route-model', models: ['fallback-route-model'], sourceProviderId: 'p-disabled', enabled: true, injectModels: true },
      ],
      platforms: { antigravity: { providerId: 'ag-first' } },
    }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'proxy-routes.json'), JSON.stringify({
      version: 1,
      routes: [{
        uid: 'u-trap',
        id: 'ag-disabled',
        enabled: true,
        exposedFormats: ['openai', 'gemini'],
        targets: [{ providerId: 'p-first', model: 'fallback-route-model', apiFormat: 'openai' }],
      }],
    }), 'utf8');
    invalidate('all');

    // 先触发一次 ag-second，把 lastActiveIdentity 置为 ag-second (p-second)
    const r1 = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:generateContent', headers: {} },
      r1,
      JSON.stringify({ model: 'ag-second', request: { contents: [{ role: 'user', parts: [{ text: 'step1' }] }] } }),
    );
    await r1.waitForEnd();
    assert.equal(r1.statusCode, 200);
    assert.deepEqual(hits, ['second']);

    // 紧接着请求内部依赖 checkpoint：必须依然路由到 second，不能因同名 upstreamModel 回落到 first！
    const r2 = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:generateContent', headers: {} },
      r2,
      JSON.stringify({ model: 'anybridge-internal-checkpoint', request: { contents: [{ role: 'user', parts: [{ text: 'checkpoint' }] }] } }),
    );
    await r2.waitForEnd();
    assert.equal(r2.statusCode, 200);
    assert.deepEqual(hits, ['second', 'second']);

    // 关联的 sourceProvider 被禁用时，不得绕道 proxy-routes.json 的同名路由
    const disabledResolved = resolveProxyModel('ag-disabled', 'gemini', { scope: 'antigravity' });
    assert.ok(disabledResolved.error, '关联主供应商禁用时必须显式报错阻断，不可静默回落 proxy-routes');
    assert.match(disabledResolved.error, /禁用/);
  } finally {
    await closeServer(srvFirst.server);
    await closeServer(srvSecond.server);
    if (prevConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevConfigDir;
    invalidate('all');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
