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
import { extractToolCalls } from './response-emitters.js';
import { lookupGeminiToolCall } from '../gemini-thought-signature.js';
import { __localProxyTest } from '../../local-proxy.js';
import { resolveTarget } from '../../provider-pool.js';
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

test('Gemini 输出上限：客户端未显式指定时不下发 maxOutputTokens', () => {
  const gen = __localProxyTest.geminiGenerationConfig;
  const implicit = gen({ rawBody: { contents: [] }, maxTokens: 4096 });
  assert.equal(implicit.maxOutputTokens, undefined);
  const explicit = gen({ rawBody: { max_tokens: 800 }, maxTokens: 800 });
  assert.equal(explicit.maxOutputTokens, 800);
  const native = gen({ rawBody: { generationConfig: { maxOutputTokens: 2048 } }, maxTokens: 2048 });
  assert.equal(native.maxOutputTokens, 2048);
  const snake = gen({ rawBody: { max_output_tokens: 512 }, maxTokens: 512 });
  assert.equal(snake.maxOutputTokens, 512);
});

test('geminiStreamApiPath 把 generateContent 换成 streamGenerateContent?alt=sse', () => {
  const f = __localProxyTest.geminiStreamApiPath;
  assert.equal(
    f({ apiPath: '/v1beta/models/gemini-3.8-flash:generateContent' }),
    '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'
  );
  assert.equal(
    f({ apiPath: '/v1/projects/p/locations/global/publishers/google/models/gemini-4-argon:generateContent' }),
    '/v1/projects/p/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse'
  );
  assert.equal(f({ apiPath: '/x:streamGenerateContent' }), '/x:streamGenerateContent?alt=sse');
  assert.equal(f({ apiPath: '/x:streamGenerateContent?alt=sse' }), '/x:streamGenerateContent?alt=sse');
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


test('跨协议工具历史（OpenAI/Anthropic/Responses）转 Gemini 上游在缓存未命中时自动补兜底签名', () => {
  // 场景 A：OpenAI Chat 缓存未命中（如服务重启或跨模型切换历史）→ 不带伪造 id，首条 functionCall 补跳过哨兵
  const openaiCtx = __localProxyTest.normalizeRequest('openai', {
    model: 'gemini-4-hydrogen',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '我先读取两个文件',
        tool_calls: [
          { id: 'call_unknown_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } },
          { id: 'call_unknown_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.md"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_unknown_2', content: 'B' },
      { role: 'tool', tool_call_id: 'call_unknown_1', content: 'A' },
      { role: 'user', content: '继续总结' },
    ],
  });
  const openaiBody = __localProxyTest.upstreamBody({
    format: 'gemini',
    model: 'gemini-4-hydrogen',
    apiPath: '/v1/projects/p/locations/global/publishers/google/models/gemini-4-hydrogen:generateContent',
  }, openaiCtx);

  assert.equal(openaiBody.contents.length, 3, '连续的 tool 结果与紧随其后的 user 文本应合并进同一个 user turn');
  assert.equal(openaiBody.contents[1].parts[0].text, '我先读取两个文件');
  assert.deepEqual(openaiBody.contents[1].parts[1], {
    functionCall: { name: 'read_file', args: { path: 'a.md' } },
    thoughtSignature: 'skip_thought_signature_validator',
  });
  assert.deepEqual(openaiBody.contents[1].parts[2], {
    functionCall: { name: 'read_file', args: { path: 'b.md' } },
  });
  assert.deepEqual(openaiBody.contents[2].parts, [
    { functionResponse: { name: 'read_file', response: { result: 'A' } } },
    { functionResponse: { name: 'read_file', response: { result: 'B' } } },
    { text: '继续总结' },
  ]);

  // 场景 B：Anthropic（Claude Code）tool_use / tool_result（含错误与图片）
  const anthropicCtx = __localProxyTest.normalizeRequest('anthropic', {
    model: 'gemini-4-hydrogen',
    messages: [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { cmd: 'ls' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          is_error: true,
          content: [
            { type: 'text', text: 'boom' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
          ],
        }],
      },
    ],
  });
  const anthropicBody = __localProxyTest.upstreamBody({
    format: 'gemini',
    model: 'gemini-4-hydrogen',
    apiPath: '/v1beta/models/gemini-4-hydrogen:generateContent',
  }, anthropicCtx);
  assert.equal(anthropicBody.contents.length, 3);
  assert.equal(anthropicBody.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.deepEqual(anthropicBody.contents[1].parts[0].functionCall, { name: 'bash', args: { cmd: 'ls' } });
  assert.deepEqual(anthropicBody.contents[2].parts[0], {
    functionResponse: { name: 'bash', response: { error: 'boom' } },
  });
  assert.deepEqual(anthropicBody.contents[2].parts[1], {
    inlineData: { mimeType: 'image/png', data: 'aW1n' },
  });

  // 场景 C：OpenAI Responses（function_call / function_call_output）
  const responsesCtx = __localProxyTest.normalizeRequest('responses', {
    model: 'gemini-4-hydrogen',
    input: [
      { role: 'user', content: 'check' },
      { type: 'function_call', call_id: 'fc_1', name: 'stat', arguments: '{"path":"x"}' },
      { type: 'function_call_output', call_id: 'fc_1', output: 'ok' },
    ],
  });
  const responsesBody = __localProxyTest.upstreamBody({
    format: 'gemini',
    model: 'gemini-4-hydrogen',
    apiPath: '/v1beta/models/gemini-4-hydrogen:generateContent',
  }, responsesCtx);
  assert.equal(responsesBody.contents.length, 3);
  assert.equal(responsesBody.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.deepEqual(responsesBody.contents[1].parts[0].functionCall, { name: 'stat', args: { path: 'x' } });
  assert.deepEqual(responsesBody.contents[2].parts[0], {
    functionResponse: { name: 'stat', response: { result: 'ok' } },
  });
});

test('extractToolCalls 提取非流式 Gemini functionCall 的 thoughtSignature 并记住生成 id', () => {
  const writes = [];
  const res = {
    writeHead() {},
    write(data) { writes.push(data); },
    end(data) { if (data) writes.push(data); },
  };
  const conn = {
    format: 'gemini',
    model: 'gemini-4-hydrogen',
    apiPath: '/v1beta/models/gemini-4-hydrogen:generateContent',
  };
  const toolCalls = __localProxyTest.extractToolCalls(conn, {
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { functionCall: { name: 'get_time', args: {} }, thoughtSignature: 'sig-nonstream-1' },
        ],
      },
    }],
  });
  assert.equal(toolCalls.length, 1);
  assert.ok(toolCalls[0].id, '无上游 id 但带签名时必须生成稳定 id 供回放匹配');

  __localProxyTest.sendOpenAIChat({ stream: false, model: 'gemini-4-hydrogen' }, res, {
    conn,
    text: '',
    toolCalls,
    usage: {},
  });
  const sentMsg = JSON.parse(writes[0]).choices[0].message;
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'gemini-4-hydrogen',
    messages: [
      { role: 'user', content: 'time?' },
      sentMsg,
      { role: 'tool', tool_call_id: sentMsg.tool_calls[0].id, content: '17:40' },
    ],
  });
  const body = __localProxyTest.upstreamBody(conn, ctx);
  assert.equal(body.contents[1].parts[0].thoughtSignature, 'sig-nonstream-1');
  assert.deepEqual(body.contents[1].parts[0].functionCall, { name: 'get_time', args: {} });
  assert.deepEqual(body.contents[2].parts[0].functionResponse, { name: 'get_time', response: { result: '17:40' } });
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

test('extractToolCalls: Gemini non-streaming part extracts callId even without thoughtSignature and records signature when present', () => {
  const conn = { format: 'gemini' };
  const mockResponse = {
    candidates: [{
      content: {
        parts: [
          {
            thought: true,
            thoughtSignature: 'sig-abc-123',
          },
          {
            functionCall: {
              name: 'read_file',
              args: { path: 'foo.txt' },
            },
          },
          {
            functionCall: {
              name: 'write_file',
              args: { path: 'bar.txt', content: 'test' },
            },
          },
        ],
      },
    }],
  };

  const calls = extractToolCalls(conn, mockResponse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'read_file');
  assert.match(calls[0].id, /^call_[a-f0-9]{24}$/);
  assert.deepEqual(calls[0].arguments, { path: 'foo.txt' });

  const cachedMeta = lookupGeminiToolCall(calls[0].id);
  assert.ok(cachedMeta);
  assert.equal(cachedMeta.signature, 'sig-abc-123');

  assert.equal(calls[1].name, 'write_file');
  assert.match(calls[1].id, /^call_[a-f0-9]{24}$/);
});


