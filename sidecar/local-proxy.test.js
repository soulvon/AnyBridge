import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { invalidate } from './config-cache.js';
import { createChatSSEFromGemini } from './lib/chat-sse-transform.js';
import { __localProxyTest } from './local-proxy.js';
import { resolveTarget } from './provider-pool.js';

test('buildExposedIdLookup: 字面 ID 优先,渲染别名冲突跳过并告警,不再毒化全局', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-exposed-id-'));
  const previousConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  try {
    // 复刻线上事故配置:命名规则 suffix=({provider}) + 字面同名的另一条路由
    fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
      proxyRouteRenameRule: { enabled: true, mode: 'simple', suffix: '({provider})' },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([
      { id: 'ar', name: 'AnyRouter', apiHost: 'https://example.test', enabled: true },
    ]), 'utf8');

    const routes = [
      { id: 'gpt-6-astra', targets: [{ providerId: 'ar', model: 'gpt-6-astra' }] },
      { id: 'gpt-6-astra(AnyRouter)', targets: [{ providerId: 'ar', model: 'gpt-6-astra' }] },
      { id: 'gemini-flash', targets: [{ providerId: 'ar', model: 'gemini-flash' }] },
    ];

    // 修复前:这里会 throw 并导致所有模型(包括 gemini-flash)的解析全部 502
    const lookup = __localProxyTest.buildExposedIdLookup(routes);
    assert.equal(lookup.get('gpt-6-astra'), routes[0]);
    // 字面 ID 归属第二条路由,第一条路由渲染出的同名别名让位
    assert.equal(lookup.get('gpt-6-astra(AnyRouter)'), routes[1]);
    assert.equal(lookup.get('gemini-flash'), routes[2]);
  } finally {
    invalidate('all');
    if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildExposedIdLookup: 两条路由字面 ID 相同仍然报错(真重复)', () => {
  const routes = [
    { id: 'dup-model', targets: [{ providerId: 'p1', model: 'm1' }] },
    { id: 'dup-model', targets: [{ providerId: 'p2', model: 'm2' }] },
  ];
  assert.throws(
    () => __localProxyTest.buildExposedIdLookup(routes, { applyRename: false }),
    /同时是 dup-model 和 dup-model 两条路由的字面 ID/,
  );
});

test('自环目标识别: 只有AnyBridge 内置供应商算自环, 普通供应商不是', () => {
  assert.equal(__localProxyTest.isLocalProxySelfTarget({ providerId: 'anybridge-local-proxy' }), true);
  assert.equal(__localProxyTest.isLocalProxySelfTarget({ providerId: 'anybridge' }), true);
  assert.equal(__localProxyTest.isLocalProxySelfTarget({ providerId: 'cpa-local' }), false);
  assert.equal(__localProxyTest.isLocalProxySelfTarget({ providerId: 'p-import-cockpittools-1' }), false);
  assert.equal(__localProxyTest.isLocalProxySelfTarget(null), false);
});

test('sameRoute: uid 优先, 缺失时退化比 id', () => {
  assert.equal(__localProxyTest.sameRoute({ uid: 'uid-1', id: 'a' }, { uid: 'uid-1', id: 'a' }), true);
  assert.equal(__localProxyTest.sameRoute({ uid: 'uid-1', id: 'a' }, { uid: 'uid-2', id: 'a' }), false);
  assert.equal(__localProxyTest.sameRoute({ id: 'a' }, { id: 'a' }), true);
  assert.equal(__localProxyTest.sameRoute({ id: 'a' }, { id: 'b' }), false);
  assert.equal(__localProxyTest.sameRoute(null, { id: 'a' }), false);
});

test('responseObject: openai 上游的 tool_calls 必须转成 function_call 输出项', () => {
  // 复刻线上事故:cursor-core /v1/responses + 无 wireApi 的 openai 上游返回工具调用
  const ctx = { model: 'gemini-3.8-flash-high' };
  const result = {
    text: '',
    toolCalls: [{ id: 'get_weather-1', name: 'get_weather', arguments: { city: '北京' } }],
    usage: { inputTokens: 56, outputTokens: 57 },
  };
  const obj = __localProxyTest.responseObject(ctx, result, 'resp-test');
  assert.equal(obj.output.length, 1);
  const fc = obj.output[0];
  assert.equal(fc.type, 'function_call');
  assert.equal(fc.name, 'get_weather');
  assert.equal(fc.call_id, 'get_weather-1');
  // Responses 协议的 arguments 是 JSON 字符串
  assert.deepEqual(JSON.parse(fc.arguments), { city: '北京' });
});

test('sendOpenAIResponses: 假流式必须发送 function_call 的完整 output_item 事件', () => {
  const chunks = [];
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };
  __localProxyTest.sendOpenAIResponses(
    { model: 'm', stream: true },
    res,
    {
      text: '',
      toolCalls: [{ id: 'call-1', name: 'list_files', arguments: { path: '.' } }],
      usage: { inputTokens: 3, outputTokens: 5 },
    },
  );

  const events = chunks.join('').split('\n\n').flatMap((block) => {
    const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.output_item.added',
    'response.output_item.done',
    'response.completed',
  ]);

  const added = events[1];
  const done = events[2];
  assert.equal(added.output_index, 0);
  assert.equal(added.item.type, 'function_call');
  assert.equal(added.item.status, 'in_progress');
  assert.equal(done.output_index, 0);
  assert.equal(done.item.call_id, 'call-1');
  assert.deepEqual(JSON.parse(done.item.arguments), { path: '.' });
  assert.equal(events.at(-1).response.output[0].type, 'function_call');
});

test('sendOpenAIResponses: 假流式先发 reasoning 项（含密文），message 索引顺延', () => {
  const chunks = [];
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };
  const json = {
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '思考摘要' }], encrypted_content: 'gAAA' },
      { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
    ],
  };
  __localProxyTest.sendOpenAIResponses(
    { model: 'm', stream: true },
    res,
    { conn: { format: 'openai' }, json, text: '答案', toolCalls: [], usage: {} },
  );

  const events = chunks.join('').split('\n\n').flatMap((block) => {
    const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.output_item.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.output_item.done',
    'response.completed',
  ]);
  const reasoningDone = events[4];
  assert.equal(reasoningDone.output_index, 0);
  assert.equal(reasoningDone.item.encrypted_content, 'gAAA', '密文必须回传，客户端下一轮才能回放思考上下文');
  const messageAdded = events[5];
  assert.equal(messageAdded.output_index, 1, 'reasoning 占位后 message 索引顺延');
});

test('端到端：Cursor Responses 请求的档位与思考回放项直达上游', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-e2e-effort-'));
  const previousConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{
      id: 'p1', name: 'Mock', apiHost: 'https://mock.test', apiKey: 'k', enabled: true, apiFormat: 'openai',
    }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'proxy-routes.json'), JSON.stringify({
    version: 1,
    routes: [{
      uid: 'r1',
      id: 'cursor-opus',
      enabled: true,
      displayName: 'Cursor Opus',
      capabilities: { reasoning: true },
      targets: [{ providerId: 'p1', model: 'gpt-5.6', apiPath: '/v1/responses' }],
    }],
  }), 'utf8');

  const upstreamCalls = [];
  const originalRequest = https.request;
  https.request = function mockRequest(options, cb) {
    let body = Buffer.alloc(0);
    const req = new EventEmitter();
    req.write = chunk => {
      if (chunk) body = Buffer.concat([body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    };
    req.setTimeout = () => req;
    req.destroy = err => { if (err) req.emit('error', err); };
    req.end = chunk => {
      if (chunk) req.write(chunk);
      upstreamCalls.push({ options, payload: JSON.parse(body.toString('utf8') || '{}') });
      const res = new Readable({ read() {} });
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      process.nextTick(() => {
        cb(res);
        res.push(JSON.stringify({
          output: [
            { type: 'reasoning', id: 'rs_up', summary: [{ type: 'summary_text', text: '思考' }], encrypted_content: 'gUp' },
            { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
          ],
        }));
        res.push(null);
      });
    };
    return req;
  };

  try {
    const ctx = __localProxyTest.normalizeRequest('responses', {
      model: 'cursor-opus',
      input: [
        { type: 'reasoning', id: 'rs_prev', encrypted_content: 'gPrev' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
      reasoning: { effort: 'xhigh' },
    });

    const result = await __localProxyTest.execute(ctx);

    const payload = upstreamCalls[0].payload;
    assert.equal(payload.reasoning.effort, 'xhigh', 'Cursor 界面选的档位必须到达上游');
    assert.equal(payload.input[0].type, 'reasoning', '上一轮思考回放项必须原样透传');
    assert.equal(payload.input[0].encrypted_content, 'gPrev');
    assert.equal(result.text, '答案', '思考文本不得混入正文');
  } finally {
    https.request = originalRequest;
    invalidate('all');
    if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('responseObject: 纯文本回复保持单一 message 输出项', () => {
  const obj = __localProxyTest.responseObject(
    { model: 'm' },
    { text: '你好', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    'resp-test',
  );
  assert.equal(obj.output.length, 1);
  assert.equal(obj.output[0].content[0].text, '你好');
});

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


test('Gemini Native tool history converts to OpenAI tool_calls instead of 400', () => {
  // 真机事故：Antigravity 会话带 Hook/工具调用历史时，Gemini Native 的
  // functionCall/functionResponse 被网关直接拒绝，BYOK（OpenAI 协议）会话必炸。
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [
      { role: 'user', parts: [{ text: '查航班' }] },
      { role: 'model', parts: [{ functionCall: { name: 'check_flight', args: { flight: 'AA100' } }, thoughtSignature: 'sig-A' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'check_flight', response: { status: 'on time' } } }] },
    ],
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-x',
    apiPath: '/v1/chat/completions',
  }, ctx);

  const assistant = body.messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  const toolResult = body.messages.find(m => m.role === 'tool');
  assert.ok(assistant, 'functionCall 必须转成 assistant.tool_calls');
  assert.equal(assistant.tool_calls[0].function.name, 'check_flight');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { flight: 'AA100' });
  assert.ok(toolResult, 'functionResponse 必须转成 role:tool 消息');
  assert.equal(toolResult.tool_call_id, assistant.tool_calls[0].id, '工具结果必须与调用 id 配对');
  assert.match(toolResult.content, /on time/);
  assert.equal(JSON.stringify(body).includes('thoughtSignature'), false, '内部签名不得泄漏到 OpenAI 上游');
});

test('Gemini Native tool results pair with repeated call ids instead of 400', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [
      { role: 'model', parts: [
        { functionCall: { id: 'id-1', name: 'read_file', args: { path: 'a' } } },
        { functionCall: { id: 'id-2', name: 'read_file', args: { path: 'b' } } },
      ] },
      { role: 'user', parts: [
        { functionResponse: { name: 'read_file', response: { content: 'A' } } },
        { functionResponse: { id: 'id-2', name: 'read_file', response: { content: 'B' } } },
      ] },
    ],
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-x',
    apiPath: '/v1/chat/completions',
  }, ctx);

  const calls = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
  const results = body.messages.filter(m => m.role === 'tool');
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].tool_call_id, 'id-1', '同名调用按出现顺序配对');
  assert.equal(results[1].tool_call_id, 'id-2', '显式 id 优先');
});

test('Gemini Native non-image attachment degrades to text instead of 400', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [{ role: 'user', parts: [
      { text: '看这个 PDF' },
      { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0x' } },
    ] }],
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-x',
    apiPath: '/v1/chat/completions',
  }, ctx);

  const text = JSON.stringify(body.messages);
  assert.match(text, /application\/pdf/, '非图片附件应降级为带类型说明的文本占位');
  assert.match(text, /看这个 PDF/, '相邻文本不能丢');
});

test('Gemini Native tool history converts for Anthropic upstream too', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'ok' } } }] },
    ],
  });

  const body = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-x',
    apiPath: '/v1/messages',
  }, ctx);

  const parts = body.messages.flatMap(m => m.content || []);
  assert.equal(parts.filter(p => p.type === 'tool_use').length, 1);
  assert.equal(parts.filter(p => p.type === 'tool_result').length, 1);
  assert.equal(parts.find(p => p.type === 'tool_use').name, 'read_file');
  assert.equal(JSON.stringify(body).includes('thoughtSignature'), false);
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

test('OpenAI Chat 多轮工具调用转 Gemini 上游保留 functionCall/functionResponse 与真实 thoughtSignature', () => {
  // 复刻真机事故（CodeBuddy -> AnyBridge -> Google AI Studio gemini-4-hydrogen）：
  // 1) Round 1 流式返回带 thoughtSignature 与 id 的并行 functionCall
  const converter = createChatSSEFromGemini('gemini-4-hydrogen(Google Gemini)', 'chatcmpl-1', 1);
  const sseChunks = converter.write({
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { functionCall: { id: 'call_real_1', name: 'read_file', args: { path: '偏好.md' } }, thoughtSignature: 'sig-real-1' },
          { functionCall: { id: 'call_real_2', name: 'read_file', args: { path: '索引.md' } } },
        ],
      },
      finishReason: 'STOP',
    }],
  });
  const emittedIds = sseChunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls || []).map(tc => tc.id);
  assert.deepEqual(emittedIds, ['call_real_1', 'call_real_2']);

  // 2) Round 2 CodeBuddy 回传标准 OpenAI Chat 历史（tool_calls + role:tool，且刻意颠倒返回顺序验证配对）
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'gemini-4-hydrogen(Google Gemini)',
    stream: true,
    messages: [
      { role: 'system', content: 'Read project docs first.' },
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_real_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"偏好.md"}' } },
          { id: 'call_real_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"索引.md"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_real_2', content: '# 索引内容' },
      { role: 'tool', tool_call_id: 'call_real_1', content: '# 偏好内容' },
    ],
  });

  const body = __localProxyTest.upstreamBody({
    format: 'gemini',
    model: 'gemini-4-hydrogen',
    apiPath: '/v1beta/models/gemini-4-hydrogen:generateContent',
  }, ctx);

  assert.equal(body.contents.length, 3, 'user -> model -> user 三轮历史不得被吞掉');
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[0].parts[0].text, '你好');

  const modelParts = body.contents[1].parts;
  assert.equal(body.contents[1].role, 'model');
  assert.equal(modelParts.length, 2);
  assert.deepEqual(modelParts[0], {
    functionCall: { id: 'call_real_1', name: 'read_file', args: { path: '偏好.md' } },
    thoughtSignature: 'sig-real-1',
  });
  assert.deepEqual(modelParts[1], {
    functionCall: { id: 'call_real_2', name: 'read_file', args: { path: '索引.md' } },
  });

  const toolUserParts = body.contents[2].parts;
  assert.equal(body.contents[2].role, 'user');
  assert.equal(toolUserParts.length, 2);
  assert.deepEqual(toolUserParts[0], {
    functionResponse: { id: 'call_real_1', name: 'read_file', response: { result: '# 偏好内容' } },
  });
  assert.deepEqual(toolUserParts[1], {
    functionResponse: { id: 'call_real_2', name: 'read_file', response: { result: '# 索引内容' } },
  });
});


test('Responses 直连上游必须透传客户端思考档位（issue #40）', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
    reasoning: { summary: 'auto', effort: 'high' },
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/responses',
  }, ctx);

  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('Responses 思考档位按目标模型族词表钳制', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
    reasoning: { effort: 'xhigh' },
  });

  // xhigh 不在 generic 词表（low/medium/high）内 → 就近降为 high
  const genericBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'some-model',
    apiPath: '/v1/responses',
  }, ctx);
  assert.deepEqual(genericBody.reasoning, { effort: 'high' });

  // gpt 族支持 xhigh → 原样直传
  const gptBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6-sol',
    apiPath: '/v1/responses',
  }, ctx);
  assert.deepEqual(gptBody.reasoning, { effort: 'xhigh' });
});

test('Responses 请求未带 effort 时不注入 reasoning', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/responses',
  }, ctx);

  assert.equal(body.reasoning, undefined);
});

