import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { invalidate } from '../../config-cache.js';
import { createChatSSEFromGemini } from '../chat-sse-transform.js';
import { __localProxyTest } from '../../local-proxy.js';
import { resolveTarget } from '../../provider-pool.js';
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

test('Claude Desktop model resolution strips 1M marker and maps dated aliases', () => {
  assert.equal(__localProxyTest.stripOneMContextMarker('claude-sonnet-5[1m]'), 'claude-sonnet-5');
  assert.equal(__localProxyTest.stripOneMContextMarker('claude-opus-5 [1M]'), 'claude-opus-5');
  assert.equal(__localProxyTest.resolveClaudeDesktopRole('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(__localProxyTest.resolveClaudeDesktopRole('claude-sonnet-4-6[1m]'), 'sonnet');
  assert.equal(__localProxyTest.resolveClaudeDesktopRole('claude-opus-4-8'), 'opus');
  assert.equal(__localProxyTest.resolveClaudeDesktopRole('claude-fable-5'), 'fable');
  assert.equal(__localProxyTest.resolveClaudeDesktopRole('custom-model'), null);
});

test('Claude Desktop maps requested roles to bound proxy routes from proxy-routes.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-cd-proxy-'));
  const previousConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  try {
    fs.writeFileSync(path.join(dir, 'proxy-routes.json'), JSON.stringify({
      version: 1,
      routes: [
        { uid: 'route-sonnet-uid', id: 'kimi-k2.7-code', enabled: true, targets: [{ providerId: 'kimi', model: 'k2' }] },
        { uid: 'route-opus-uid', id: 'deepseek-v4-pro', enabled: true, targets: [{ providerId: 'ds', model: 'v4' }] },
        { uid: 'route-haiku-uid', id: 'qwen-flash', enabled: true, targets: [{ providerId: 'qwen', model: 'flash' }] },
      ],
      claudeDesktop: {
        sonnet: 'route-sonnet-uid[1m]',
        opus: 'route-opus-uid',
        haiku: 'route-haiku-uid',
        fable: '',
      },
    }), 'utf8');

    // 勾选「声明 1M」后绑定值会带 [1m] 后缀，仍必须命中同一条本地路由
    const mappedSonnet = __localProxyTest.mapClaudeDesktopModel('claude-sonnet-5[1m]');
    assert.equal(mappedSonnet.model, 'kimi-k2.7-code');

    const mappedHaiku = __localProxyTest.mapClaudeDesktopModel('claude-haiku-4-5-20251001');
    assert.equal(mappedHaiku.model, 'qwen-flash');

    // Fable 未显式绑定时，回落到 Opus 档
    const mappedFable = __localProxyTest.mapClaudeDesktopModel('claude-fable-5');
    assert.equal(mappedFable.model, 'deepseek-v4-pro');
  } finally {
    invalidate('all');
    if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity handler recognizes v1internal paths and builds injected models list', async () => {
  const { isAntigravityPath, getAntigravityMethod, buildAntigravityModelsList, mockAntigravityLoadCodeAssist } = await import('../antigravity-handler.js');
  assert.equal(isAntigravityPath('/v1internal:loadCodeAssist'), true);
  assert.equal(isAntigravityPath('/v1internal:streamGenerateContent?alt=sse'), true);
  assert.equal(isAntigravityPath('/antigravity/v1internal:fetchAvailableModels'), true);
  assert.equal(isAntigravityPath('/v1/chat/completions'), false);

  assert.equal(getAntigravityMethod('/v1internal:loadCodeAssist'), 'loadCodeAssist');
  assert.equal(getAntigravityMethod('/antigravity/v1internal:streamGenerateContent?alt=sse'), 'streamGenerateContent');

  const models = buildAntigravityModelsList({
    antigravityConfigs: [
      {
        id: 'ag-custom',
        name: 'DeepSeek',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      }
    ]
  });
  // 官方目录缺失时不得伪造任何官方模型（注入会触发前端 Preact 无限渲染死循环）
  assert.equal(models.length, 2);
  assert.ok(models.every(m => m.name.startsWith('models/MODEL_')));
  assert.ok(models.some(m => /deepseek-chat/.test(m.displayName)));
  assert.ok(models.some(m => /deepseek-reasoner/.test(m.displayName)));
  assert.ok(!models.some(m => m.catalogKey.startsWith('MODEL_GOOGLE_GEMINI_')), '严禁注入官方 Gemini 模型');

  const providers = new Map([['ag-provider', {
    id: 'ag-provider',
    name: 'AG Provider',
    apiHost: 'http://127.0.0.1:9999',
    apiPath: '/v1',
    apiKey: 'test-key',
    enabled: true,
  }]]);
  const resolved = __localProxyTest.resolveProxyModelForTest('deepseek-chat', 'gemini', 'antigravity', providers, {
    antigravityConfigs: [{
      id: 'ag-custom',
      name: 'DeepSeek',
      defaultModel: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      sourceProviderId: 'ag-provider',
      enabled: true,
      injectModels: true,
    }],
  });
  assert.equal(resolved.route.targets[0].providerId, 'ag-provider', 'Antigravity 专用配置必须优先于全局同名路由');
  assert.equal(resolved.route.targets[0].model, 'deepseek-chat');

  const assist = mockAntigravityLoadCodeAssist();
  assert.ok(Array.isArray(assist.paidTier.availableCredits));
  assert.equal(assist.paidTier.availableCredits[0].creditAmount, 1000000);
});

test('Antigravity true streaming converts OpenAI chunks to Gemini frames incrementally', () => {
  const converter = __localProxyTest.createGeminiStreamFromOpenAIChat();
  const textFrames = converter.write({ choices: [{ delta: { content: '你好' } }] });
  assert.equal(textFrames.length, 1);
  assert.equal(textFrames[0].content.parts[0].text, '你好');
  assert.equal(textFrames[0].finishReason, 'OTHER', '中间内容帧用 OTHER，不以 STOP 提前终止');

  converter.write({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'browser_subagent', arguments: '{"ta' } }] } }] });
  converter.write({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'sk":"x"}' } }] } }] });

  const flushed = converter.flush();
  const toolFrame = flushed.find(candidate => candidate.finishReason === 'TOOL_CALL');
  assert.ok(toolFrame, '工具调用必须产出 TOOL_CALL 帧');
  assert.equal(toolFrame.content.parts[0].functionCall.name, 'browser_subagent');
  assert.deepEqual(toolFrame.content.parts[0].functionCall.args, { task: 'x' });
  const stopFrame = flushed[flushed.length - 1];
  assert.equal(stopFrame.finishReason, 'STOP');
  assert.deepEqual(stopFrame.content.parts, [], '终止帧必须是空 parts 的 STOP');
});

test('Gemini uppercase tool schema is normalized to lowercase JSON Schema for OpenAI upstream', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{
      functionDeclarations: [{
        name: 'browser_subagent',
        description: 'run a browser subagent',
        parameters: {
          type: 'OBJECT',
          properties: {
            task: { type: 'STRING' },
            maxSteps: { type: 'INTEGER' },
            nested: { type: 'OBJECT', properties: { flag: { type: 'BOOLEAN' } } },
            list: { type: 'ARRAY', items: { type: 'STRING' } },
          },
        },
      }],
    }],
  });
  const openaiTools = __localProxyTest.openAITools(ctx.tools);
  const params = openaiTools[0].function.parameters;
  assert.equal(params.type, 'object', 'OpenAI 上游必须收到小写 object，否则 CPA 返回 400');
  assert.equal(params.properties.task.type, 'string');
  assert.equal(params.properties.maxSteps.type, 'integer');
  assert.equal(params.properties.nested.type, 'object');
  assert.equal(params.properties.nested.properties.flag.type, 'boolean');
  assert.equal(params.properties.list.type, 'array');
  assert.equal(params.properties.list.items.type, 'string');
});

test('Anthropic upstream also receives lowercase JSON Schema for Gemini tools', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{
      functionDeclarations: [{
        name: 'browser_subagent',
        parameters: { type: 'OBJECT', properties: { task: { type: 'STRING' } } },
      }],
    }],
  });
  const anthropic = __localProxyTest.anthropicTools(ctx.tools);
  assert.equal(anthropic[0].input_schema.type, 'object');
  assert.equal(anthropic[0].input_schema.properties.task.type, 'string');
});

test('Antigravity stream errors degrade to a valid SSE snapshot instead of a crashing JSON error', () => {
  const chunks = [];
  const headers = [];
  const res = {
    writeHead(status, h) { headers.push({ status, h }); },
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };
  __localProxyTest.writeAntigravityStreamError(res, { model: 'deepseek-v4-flash' }, '商汤: HTTP 429: inference exceeds tpm/rpm limit');
  assert.equal(headers[0].status, 200, '流式端点即使上游失败也必须回 200 SSE，否则 LS 会崩溃');
  assert.ok(String(headers[0].h['content-type']).startsWith('text/event-stream'));
  const body = chunks.join('');
  assert.ok(body.startsWith('data: '), '必须是 SSE data 帧');
  const envelope = JSON.parse(body.slice(6).trim());
  assert.ok(envelope.response, '必须包 Cloud Code 信封 {response,traceId,metadata}，否则 LS 取 envelope.Response 为 nil 会空指针崩溃');
  assert.equal(envelope.traceId, '');
  assert.ok(envelope.metadata, 'metadata 必须是对象');
  const payload = envelope.response;
  assert.equal(payload.candidates[0].content.role, 'model');
  assert.equal(payload.candidates[0].finishReason, 'STOP');
  assert.ok(String(payload.candidates[0].content.parts[0].text).includes('429'));
  assert.equal(payload.modelVersion, 'deepseek-v4-flash');
});

test('Gemini upstream keeps Google uppercase schema enums (no cross-protocol corruption)', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'local-model',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{
      functionDeclarations: [{
        name: 'browser_subagent',
        parameters: { type: 'OBJECT', properties: { task: { type: 'STRING' } } },
      }],
    }],
  });
  // normalizeGeminiTools 不改写原始 schema，Gemini 目标仍应拿到 Google 大写枚举
  assert.equal(ctx.tools[0].function.parameters.type, 'OBJECT');
  assert.equal(ctx.tools[0].function.parameters.properties.task.type, 'STRING');
});

test('Gemini upstream receives sanitized tool schema (no $schema/additionalProperties)', () => {
  const tools = __localProxyTest.geminiTools([{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'file path' },
          limit: { type: ['integer', 'null'] },
        },
      },
    },
  }]);
  const parameters = tools[0].functionDeclarations[0].parameters;
  assert.equal(parameters.$schema, undefined);
  assert.equal(parameters.additionalProperties, undefined);
  assert.equal(parameters.type, 'OBJECT');
  assert.equal(parameters.properties.path.type, 'STRING');
  assert.equal(parameters.properties.limit.type, 'INTEGER');
  assert.equal(parameters.properties.limit.nullable, true);
  assert.deepEqual(parameters.required, ['path']);
});

test('Responses upstream receives flat tools (AnyRouter 520 regression)', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: 'list files' }],
    tools: [{ type: 'function', function: { name: 'list_files', description: 'List files', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    tool_choice: 'auto',
  });
  const conn = {
    format: 'openai',
    apiPath: '/v1/responses',
    unlockKind: 'codex',
    model: 'gpt-6-astra',
    unlocks: { codex: { enabled: true, include: ['reasoning.encrypted_content'], wireApi: '/v1/responses' } },
  };
  const body = __localProxyTest.upstreamBody(conn, ctx);
  assert.equal(body.tools[0].name, 'list_files', 'Responses tools 必须是扁平结构（顶层 name），嵌套会被 AnyRouter 判非法返回 520');
  assert.equal(body.tools[0].function, undefined, 'Responses tools 不能带 Chat 风格 function 嵌套');
  assert.equal(body.tools[0].parameters.type, 'object');
  assert.equal(body.include[0], 'reasoning.encrypted_content');
});

test('Chat tools stay nested for chat completions upstream', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'list_files', parameters: { type: 'object', properties: {} } } }],
  });
  const conn = { format: 'openai', apiPath: '/v1/chat/completions', model: 'local-model' };
  const body = __localProxyTest.upstreamBody(conn, ctx);
  assert.equal(body.tools[0].function.name, 'list_files');
});

test('Chat tool history converts to tool_use/tool_result and Responses items', () => {
  const argumentsJson = '{"path":"."}';
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'gpt-6-astra',
    messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: argumentsJson } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
    ],
  });
  const assistant = ctx.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content[0].type, 'tool_use');
  assert.equal(assistant.content[0].name, 'list_files');
  assert.deepEqual(assistant.content[0].input, { path: '.' });
  const toolMsg = ctx.messages[2];
  assert.equal(toolMsg.role, 'user', '连续工具结果必须收敛到 user 侧的 tool_result');
  assert.equal(toolMsg.content[0].type, 'tool_result');
  assert.equal(toolMsg.content[0].tool_use_id, 'call_1');
  const input = __localProxyTest.openAIResponsesInput(ctx.messages);
  assert.deepEqual(input[1], { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: argumentsJson });
  assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' });
});

test('sendOpenAIChat emits tool_calls for streaming and non-streaming', () => {
  const toolCalls = [{ id: 'call_1', name: 'list_files', arguments: { path: '.' } }];
  const streamChunks = [];
  const streamRes = { writeHead() {}, write(s) { streamChunks.push(s); }, end() {} };
  __localProxyTest.sendOpenAIChat({ stream: true, model: 'm' }, streamRes, { text: '', toolCalls });
  const streamBody = streamChunks.join('');
  assert.ok(streamBody.includes('"tool_calls"'), '流式必须下发 tool_calls');
  assert.ok(streamBody.includes('"finish_reason":"tool_calls"'), '有工具调用时 finish_reason 必须是 tool_calls');
  let jsonBody = null;
  const jsonRes = { writeHead() {}, write() {}, end(s) { jsonBody = JSON.parse(s); } };
  __localProxyTest.sendOpenAIChat({ stream: false, model: 'm' }, jsonRes, { text: '', toolCalls, usage: {} });
  assert.equal(jsonBody.choices[0].message.tool_calls[0].function.name, 'list_files');
  assert.equal(jsonBody.choices[0].finish_reason, 'tool_calls');
});

test('responsesToolChoice flattens Chat-style function choice', () => {
  assert.deepEqual(__localProxyTest.responsesToolChoice({ type: 'function', function: { name: 'list_files' } }), { type: 'function', name: 'list_files' });
  assert.equal(__localProxyTest.responsesToolChoice('auto'), 'auto');
});

test('Claude Code unlock keeps client system and client tools', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'gpt-6-astra-cc-format',
    // Chat Completions 客户端（CodeBuddy/ZCode）通过 system 角色消息下发提示词
    messages: [
      { role: 'system', content: 'You are a coding assistant in an IDE.' },
      { role: 'user', content: 'list files' },
    ],
    tools: [{ type: 'function', function: { name: 'list_files', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto',
  });
  const conn = {
    format: 'anthropic',
    apiPath: '/v1/messages?beta=true',
    unlockKind: 'claudeCode',
    model: 'gpt-6-astra-cc-format',
    unlocks: { claudeCode: { enabled: true, wireApi: '/v1/messages?beta=true' } },
  };
  const body = __localProxyTest.upstreamBody(conn, ctx);
  assert.ok(body.system[0].text.includes('Claude agent'), '第一个 system block 必须是指纹');
  assert.equal(body.system[1].text, 'You are a coding assistant in an IDE.', '客户端 system 不能丢');
  assert.ok(body.tools.length >= 22, '必须是 21 个原生指纹 tools 加上客户端 tools');
  assert.ok(body.tools.some(t => t.name === 'list_files' && t.input_schema), '客户端 tools 必须带 input_schema');
  assert.deepEqual(body.tool_choice, { type: 'auto' }, 'OpenAI 字符串 tool_choice 必须转成 Anthropic 对象');
});

test('ResolveTarget respects explicit unlock regardless of model name', () => {
  const provider = {
    id: 'p-test-anyrouter',
    name: 'AnyRouter(test)',
    apiHost: 'https://anyrouter.top',
    apiKey: 'sk-test',
    enabled: true,
    unlocks: {
      codex: { enabled: true, wireApi: '/v1/responses' },
      claudeCode: { enabled: true, wireApi: '/v1/messages?beta=true' },
    },
  };
  const providers = new Map([[provider.id, provider]]);
  const conn = resolveTarget({ providerId: provider.id, model: 'gpt-6-astra-cc-format', apiFormat: 'anthropic', unlock: 'claudeCode' }, providers);
  assert.equal(conn.unlockKind, 'claudeCode', 'gpt 命名的模型也能走 Claude Code 解锁，不能按名字静默降级');
  assert.equal(conn.apiPath, '/v1/messages?beta=true');
});

test('Responses input: assistant history must use output_text', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'gpt-6-astra',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '我先写入文件', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.html"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
  });
  const input = __localProxyTest.openAIResponsesInput(ctx.messages);
  assert.equal(input[0].content[0].type, 'input_text', 'user 历史用 input_text');
  assert.equal(input[1].content[0].type, 'output_text', 'assistant 输出历史必须用 output_text，否则 AnyRouter 返回 520');
  assert.equal(input[2].type, 'function_call');
  assert.equal(input[3].type, 'function_call_output');
});

test('Cloudflare 5xx (520-524) are retryable', () => {
  for (const status of [520, 521, 522, 523, 524]) {
    assert.ok(__localProxyTest.RETRYABLE_STATUS.has(status), `HTTP ${status} 必须自动重试，否则 AnyRouter 偶发瞬断会直接暴露为 503`);
  }
});

test('ResolveTarget: smart model-name inference only when nothing is explicit', () => {
  const provider = {
    id: 'p-test-plain',
    name: 'Relay(test)',
    apiHost: 'https://relay.example.com',
    apiKey: 'sk-test',
    enabled: true,
  };
  const providers = new Map([[provider.id, provider]]);
  // 全自动：接口格式与解锁都没指定 → 按模型名智能推断
  assert.equal(resolveTarget({ providerId: provider.id, model: 'gpt-6-astra' }, providers).format, 'openai');
  assert.equal(resolveTarget({ providerId: provider.id, model: 'claude-opus-5-5' }, providers).format, 'anthropic');
  // 手动指定接口格式 → 覆盖模型名推断
  assert.equal(
    resolveTarget({ providerId: provider.id, model: 'gpt-6-astra', apiFormat: 'anthropic' }, providers).format,
    'anthropic',
    '显式 apiFormat 必须赢过模型名推断',
  );
});

test('upstreamErrorText: 空响应 / 拦截页 / 无 message 的 JSON 都算"没信息"', () => {
  const { upstreamErrorText } = __localProxyTest;
  assert.equal(upstreamErrorText(''), '');
  assert.equal(upstreamErrorText('   '), '');
  assert.equal(upstreamErrorText(undefined), '');
  assert.equal(upstreamErrorText('<html><body>403 Forbidden</body></html>'), '');
  assert.equal(upstreamErrorText('{"error":{"code":403}}'), '');
  assert.equal(upstreamErrorText('{"error":{"message":"模型未开通"}}'), '模型未开通');
  assert.equal(upstreamErrorText('{"detail":"rate limited"}'), 'rate limited');
  assert.equal(upstreamErrorText('{"error":"plain string error"}'), 'plain string error');
  assert.equal(upstreamErrorText('plain text failure'), 'plain text failure');
});

test('failureMessage: 空 403 必须写成"上游返回空响应"而不是空字符串', () => {
  const { failureMessage } = __localProxyTest;
  // responses 路径在空 body 时会把 message 退化成 "HTTP 403" 占位，摘要里不能再重复
  assert.equal(
    failureMessage({ providerName: '渠道A', statusCode: 403, message: 'HTTP 403', body: '' }),
    '渠道A HTTP 403（上游返回空响应）',
  );
  // HTML 拦截页原样塞进摘要没有可读性
  assert.equal(
    failureMessage({ providerName: '渠道B', statusCode: 403, message: '<html>blocked</html>', body: '<html>blocked</html>' }),
    '渠道B HTTP 403（上游返回空响应）',
  );
  assert.equal(
    failureMessage({ providerName: '渠道C', statusCode: 403, message: 'HTTP 403', body: '{"error":{"message":"模型未开通"}}' }),
    '渠道C HTTP 403：模型未开通',
  );
  assert.equal(
    failureMessage({ providerName: '渠道D', code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }),
    '渠道D ECONNREFUSED：connect ECONNREFUSED 127.0.0.1:1',
  );
});

test('classifyFailures: 空 403 归类为权限错误（供下游给出可读提示）', () => {
  const { classifyFailures } = __localProxyTest;
  assert.deepEqual(classifyFailures([{ statusCode: 403, message: 'HTTP 403', body: '' }]), {
    status: 403,
    type: 'permission_error',
  });
});


