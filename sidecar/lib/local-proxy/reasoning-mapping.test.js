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
test('Responses 思考档位跨协议映射为 Anthropic thinking', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
    reasoning: { effort: 'xhigh' },
  });

  const body = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-opus-4-7',
    apiPath: '/v1/messages',
  }, ctx);

  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'high' });
});

test('chat 上游（未配 wireApi）也保留 responses 客户端的档位', () => {
  const ctx = __localProxyTest.normalizeRequest('responses', {
    model: 'local-model',
    input: 'hello',
    reasoning: { effort: 'high' },
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'deepseek-v4',
    apiPath: '/v1/chat/completions',
  }, ctx);

  assert.equal(body.reasoning_effort, 'high');
});

test('chat 客户端显式 reasoning_effort 透传（none 保留关闭语义）', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
  });

  const body = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/chat/completions',
  }, ctx);
  assert.equal(body.reasoning_effort, 'medium');

  const offCtx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });
  const offBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/chat/completions',
  }, offCtx);
  assert.equal(offBody.reasoning_effort, 'none');
});

test('anthropic 客户端 thinking 预算映射到 OpenAI 上游档位', () => {
  const ctx = __localProxyTest.normalizeRequest('anthropic', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 8192 },
  });

  const responsesBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/responses',
  }, ctx);
  assert.deepEqual(responsesBody.reasoning, { effort: 'medium' });

  const chatBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/chat/completions',
  }, ctx);
  assert.equal(chatBody.reasoning_effort, 'medium');
});

test('Responses 上游的思考文本不混入正文', () => {
  const json = {
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '先想一下' }] },
      { type: 'message', content: [{ type: 'output_text', text: '最终答案' }] },
      { type: 'function_call', name: 'read_file', arguments: '{"path":"a"}' },
    ],
  };
  assert.equal(
    __localProxyTest.extractText({ format: 'openai' }, json),
    '最终答案',
    '思考内容混进正文会让客户端把推理当回答显示',
  );
});

test('Gemini 上游的 thought part 不混入正文', () => {
  const json = {
    candidates: [{
      content: {
        parts: [
          { text: '思考过程', thought: true },
          { text: '最终答案' },
        ],
      },
    }],
  };
  assert.equal(__localProxyTest.extractText({ format: 'gemini' }, json), '最终答案');
});

test('responseObject 回传带 encrypted_content 的 reasoning item', () => {
  const json = {
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'gAAA' },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  };
  const obj = __localProxyTest.responseObject(
    { model: 'm' },
    { conn: { format: 'openai' }, json, text: 'answer', usage: {} },
    'resp-1',
  );

  assert.equal(obj.output[0].type, 'reasoning');
  assert.equal(obj.output[0].encrypted_content, 'gAAA');
  assert.equal(obj.output[1].type, 'message');
  assert.equal(obj.output[1].content[0].text, 'answer');
});

test('上游只有可读思考文本时构造不带 id 的 reasoning 摘要项', () => {
  const json = {
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '先分析需求' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  };
  const obj = __localProxyTest.responseObject(
    { model: 'm' },
    { conn: { format: 'openai' }, json, text: 'answer', usage: {} },
    'resp-2',
  );

  assert.equal(obj.output[0].type, 'reasoning');
  assert.equal(obj.output[0].id, undefined, '无密文时不带 id，避免客户端回放查不到的 id');
  assert.equal(obj.output[0].summary[0].text, '先分析需求');
});

test('anthropic adaptive 思考映射到 OpenAI 上游档位', () => {
  const ctx = __localProxyTest.normalizeRequest('anthropic', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
  });

  const responsesBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/responses',
  }, ctx);
  assert.deepEqual(responsesBody.reasoning, { effort: 'high' });

  const anthropicBody = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-opus-4-7',
    apiPath: '/v1/messages',
  }, { ...ctx, rawBody: { ...ctx.rawBody, thinking: undefined } });
  assert.equal(anthropicBody.thinking, undefined, 'adaptive 客户端到 anthropic 上游按原样透传链路由前一步负责');
});

test('chat 客户端 reasoning_effort 跨协议到 responses / anthropic 上游', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
  });

  const responsesBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/responses',
  }, ctx);
  assert.deepEqual(responsesBody.reasoning, { effort: 'medium' });

  const anthropicBody = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-opus-4-7',
    apiPath: '/v1/messages',
  }, ctx);
  assert.deepEqual(anthropicBody.thinking, { type: 'adaptive' });
  assert.deepEqual(anthropicBody.output_config, { effort: 'medium' });
});

test('chat 客户端关闭思考（none）在 anthropic 上游转 disabled', () => {
  const ctx = __localProxyTest.normalizeRequest('openai', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  const anthropicBody = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-opus-4-7',
    apiPath: '/v1/messages',
  }, ctx);
  assert.deepEqual(anthropicBody.thinking, { type: 'disabled' });
  assert.equal(anthropicBody.output_config, undefined);
});

test('anthropic 客户端未开启 thinking 时不注入档位', () => {
  const ctx = __localProxyTest.normalizeRequest('anthropic', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'disabled' },
  });

  const responsesBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'gpt-5.6',
    apiPath: '/v1/responses',
  }, ctx);
  assert.equal(responsesBody.reasoning, undefined);
});

test('anthropic 客户端直发的 thinking 优先，不被 effort 映射覆盖', () => {
  const ctx = __localProxyTest.normalizeRequest('anthropic', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 4096 },
  });

  const body = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-opus-4-7',
    apiPath: '/v1/messages',
  }, ctx);

  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.equal(body.output_config, undefined);
});

