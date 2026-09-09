import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isAntigravityPath,
  getAntigravityMethod,
  buildAntigravityModelsList,
  cleanAntigravityModelId,
  mockAntigravityLoadCodeAssist,
  mockAntigravityUserQuotaSummary,
} from './lib/antigravity-handler.js';
import { __localProxyTest, handleLocalProxyRequest } from './local-proxy.js';

test('Antigravity handler: path recognition & method extraction', () => {
  assert.equal(isAntigravityPath('/v1internal:loadCodeAssist'), true);
  assert.equal(isAntigravityPath('/v1internal:streamGenerateContent?alt=sse'), true);
  assert.equal(isAntigravityPath('/antigravity/v1internal:fetchAvailableModels'), true);
  assert.equal(isAntigravityPath('/antigravity/messages'), true);
  assert.equal(isAntigravityPath('/v1/chat/completions'), false);

  assert.equal(getAntigravityMethod('/v1internal:loadCodeAssist'), 'loadCodeAssist');
  assert.equal(getAntigravityMethod('/v1internal:streamGenerateContent?alt=sse'), 'streamGenerateContent');
  assert.equal(getAntigravityMethod('/antigravity/v1internal:fetchAvailableModels'), 'fetchAvailableModels');
  assert.equal(getAntigravityMethod('/v1internal:retrieveUserQuotaSummary'), 'retrieveUserQuotaSummary');
  assert.equal(getAntigravityMethod('/v1internal:countTokens'), 'countTokens');
});

test('Antigravity handler: model catalog injection with custom models', () => {
  const mockProvidersJson = {
    antigravityConfigs: [
      {
        id: 'ag-custom-deepseek',
        name: 'DeepSeek-V3 (SiliconFlow)',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        sourceProviderName: 'SiliconFlow',
        models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'],
      },
    ],
    providers: [
      {
        id: 'openai-provider',
        name: 'OpenAI Official',
        defaultModel: 'gpt-4o',
        enabled: true,
      },
      {
        id: 'disabled-provider',
        name: 'Disabled Provider',
        defaultModel: 'disabled-model',
        enabled: false,
      },
    ],
  };

  const list = buildAntigravityModelsList(mockProvidersJson);
  assert.ok(Array.isArray(list) && list.length > 0);

  // 1. 自定义 Antigravity 模型已注入
  const customModel1 = list.find(m => m.name === 'models/deepseek-ai/DeepSeek-V3');
  assert.ok(customModel1, '应当包含用户配置的 deepseek-ai/DeepSeek-V3');
  assert.match(customModel1.displayName, /DeepSeek-V3/);

  const customModel2 = list.find(m => m.name === 'models/deepseek-ai/DeepSeek-R1');
  assert.ok(customModel2, '应当包含用户配置的 deepseek-ai/DeepSeek-R1');

  // 2. 启用的官方供应商模型已注入
  const gpt4o = list.find(m => m.name === 'models/gpt-4o');
  assert.ok(gpt4o, '应当包含启用的供应商模型 gpt-4o');

  // 3. 禁用的供应商模型不应被注入
  const disabled = list.find(m => m.name === 'models/disabled-model');
  assert.equal(disabled, undefined, '禁用的供应商模型不应注入');

  // 4. 默认兜底官方模型已注入
  const geminiPro = list.find(m => m.name === 'models/gemini-3-pro');
  assert.ok(geminiPro, '应当包含默认模型 gemini-3-pro');

  assert.equal(cleanAntigravityModelId('models/deepseek-ai/DeepSeek-V3'), 'deepseek-ai/DeepSeek-V3');
  assert.equal(cleanAntigravityModelId('deepseek-chat'), 'deepseek-chat');
});

test('Antigravity handler: quota & code assist mocks', () => {
  const codeAssist = mockAntigravityLoadCodeAssist();
  assert.equal(codeAssist.currentTier?.id, 'standard-tier');
  assert.equal(codeAssist.cloudaicompanionProject, 'projects/antigravity-local');
  assert.ok(codeAssist.paidTier?.availableCredits?.[0]?.creditAmount > 0);

  const quota = mockAntigravityUserQuotaSummary();
  assert.ok(Array.isArray(quota.userQuotaSummary?.quotas));
  assert.ok(quota.userQuotaSummary.quotas.length > 0);
  assert.equal(quota.userQuotaSummary.quotas[0].status, 'ACTIVE');
});

test('Antigravity request normalization: nested request payload', () => {
  // Antigravity 客户端发出的专有包装结构
  const rawAntigravityPayload = {
    project: 'antigravity-proj-123',
    model: 'models/deepseek-ai/DeepSeek-V3',
    userAgent: 'antigravity',
    request: {
      contents: [
        {
          role: 'user',
          parts: [{ text: '请帮我写一段快排' }],
        },
      ],
      systemInstruction: {
        parts: [{ text: '你是一个专业的资深工程师。' }],
      },
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.2,
      },
    },
  };

  const reqData = rawAntigravityPayload.request;
  const targetModel = cleanAntigravityModelId(rawAntigravityPayload.model);
  const normalized = __localProxyTest.normalizeRequest('gemini', {
    ...reqData,
    model: targetModel,
    stream: true,
  });

  assert.equal(normalized.kind, 'gemini');
  assert.equal(normalized.model, 'deepseek-ai/DeepSeek-V3');
  assert.equal(normalized.system, '你是一个专业的资深工程师。');
  assert.equal(normalized.messages.length, 1);
  assert.equal(normalized.messages[0].role, 'user');
  assert.equal(normalized.messages[0].content[0].text, '请帮我写一段快排');
  assert.equal(normalized.maxTokens, 8192);
  assert.equal(normalized.temperature, 0.2);
});

test('Antigravity HTTP 端点模拟: fetchAvailableModels & loadCodeAssist', async () => {
  // 创建模拟本地代理 HTTP 服务
  const server = http.createServer((req, res) => {
    handleLocalProxyRequest(req, res);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. 测试 loadCodeAssist
    const assistRes = await fetch(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(assistRes.status, 200);
    const assistJson = await assistRes.json();
    assert.equal(assistJson.currentTier?.id, 'standard-tier');
    assert.equal(assistJson.cloudaicompanionProject, 'projects/antigravity-local');

    // 2. 测试 fetchAvailableModels
    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.ok(Array.isArray(modelsJson.models) && modelsJson.models.length > 0);
    assert.ok(modelsJson.models.some(m => m.name === 'models/gemini-3-pro'));

    // 3. 测试 retrieveUserQuotaSummary
    const quotaRes = await fetch(`http://127.0.0.1:${port}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(quotaRes.status, 200);
    const quotaJson = await quotaRes.json();
    assert.ok(quotaJson.userQuotaSummary?.quotas?.length > 0);

    // 4. 测试 onboardUser
    const onboardRes = await fetch(`http://127.0.0.1:${port}/v1internal:onboardUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(onboardRes.status, 200);
    const onboardJson = await onboardRes.json();
    assert.equal(onboardJson.status, 'ONBOARDED');
  } finally {
    server.close();
  }
});

test('Antigravity 协议流式输出: 思考链 (Thinking) 与工具调用 (Tool Calling) 封装', () => {
  const writes = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(data) { writes.push(data); },
    end() { this.ended = true; },
  };

  __localProxyTest.sendGeminiStream({ model: 'deepseek-reasoner' }, res, {
    conn: { format: 'openai' },
    reasoningText: '思考过程：首先分析用户的需求...',
    text: '这是给用户的最终代码回答。',
    toolCalls: [{ name: 'execute_command', arguments: { command: 'ls' } }],
    usage: { inputTokens: 50, outputTokens: 120 },
  }, true);

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.ended, true);

  const rawData = writes.find(w => w.startsWith('data: '));
  assert.ok(rawData, '应当输出 SSE data 块');
  const parsed = JSON.parse(rawData.slice('data: '.length));

  const candidate = parsed.candidates[0];
  assert.equal(candidate.content.role, 'model');

  // 验证思考过程被正确标记为 thought: true
  const thoughtPart = candidate.content.parts.find(p => p.thought === true);
  assert.ok(thoughtPart, '应当包含 thought: true 的思考链块');
  assert.equal(thoughtPart.text, '思考过程：首先分析用户的需求...');

  // 验证文本回复
  const textPart = candidate.content.parts.find(p => p.text === '这是给用户的最终代码回答。');
  assert.ok(textPart, '应当包含正常的文本内容');

  // 验证工具调用
  const toolPart = candidate.content.parts.find(p => p.functionCall);
  assert.ok(toolPart, '应当包含 functionCall 工具调用');
  assert.equal(toolPart.functionCall.name, 'execute_command');
  assert.equal(toolPart.thoughtSignature, 'skip_thought_signature_validator');
});

test('Antigravity 自定义模型到 OpenAI 上游请求体双向转换', () => {
  const agRequest = {
    model: 'models/deepseek-chat',
    request: {
      contents: [
        {
          role: 'user',
          parts: [{ text: '写一个排序算法' }],
        },
      ],
      systemInstruction: {
        parts: [{ text: '你是一个专业的助手' }],
      },
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
      },
    },
  };

  const cleanModel = cleanAntigravityModelId(agRequest.model);
  const normalized = __localProxyTest.normalizeRequest('gemini', {
    ...agRequest.request,
    model: cleanModel,
    stream: true,
  });

  // 模拟转换为 OpenAI 目标请求体
  const openAIBody = __localProxyTest.upstreamBody({
    format: 'openai',
    model: 'deepseek-chat',
    apiPath: '/v1/chat/completions',
  }, normalized);

  assert.equal(openAIBody.model, 'deepseek-chat');
  assert.equal(openAIBody.messages[0].role, 'system');
  assert.equal(openAIBody.messages[0].content, '你是一个专业的助手');
  assert.equal(openAIBody.messages[1].role, 'user');
  assert.equal(openAIBody.messages[1].content, '写一个排序算法');
  assert.equal(openAIBody.temperature, 0.7);
  assert.equal(openAIBody.stream, false);
});
