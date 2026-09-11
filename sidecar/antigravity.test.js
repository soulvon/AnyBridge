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
  mergeAntigravityModelsResponse,
  resolveAntigravityCustomModel,
  cleanAntigravityModelId,
  mockAntigravityLoadCodeAssist,
  mockAntigravityUserQuotaSummary,
  mockAntigravityUserInfo,
  mockAntigravityAdminControls,
  mockAntigravityUserSettings,
  isAntigravityBypassMetricsPath,
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

  // 自定义 Antigravity 模型以合法的语言服务器白名单枚举注入（catalogKey 带 byok- 前缀）
  const customModels = list.filter(m => m.catalogKey.startsWith('byok-'));
  assert.equal(customModels.length, 2);
  assert.ok(customModels.some(m => /DeepSeek-V3/.test(m.displayName)));
  assert.ok(customModels.some(m => /DeepSeek-R1/.test(m.displayName)));

  // 普通 providers 不能绕过 antigravityConfigs 被隐式注入
  const gpt4o = list.find(m => m.displayName === 'gpt-4o');
  assert.equal(gpt4o, undefined);

  // 官方目录缺失时严禁伪造官方模型（实测注入官方枚举会触发前端 Preact 无限渲染死循环）
  const anyOfficial = list.find(m => m.catalogKey.startsWith('MODEL_GOOGLE_GEMINI_'));
  assert.equal(anyOfficial, undefined);

  assert.equal(cleanAntigravityModelId('models/deepseek-ai/DeepSeek-V3'), 'deepseek-ai/DeepSeek-V3');
  assert.equal(cleanAntigravityModelId('deepseek-chat'), 'deepseek-chat');
});

test('Antigravity handler: quota & code assist mocks', () => {
  const codeAssist = mockAntigravityLoadCodeAssist();
  assert.equal(codeAssist.currentTier?.id, 'standard-tier');
  assert.equal(codeAssist.cloudaicompanionProject, '');
  assert.ok(codeAssist.paidTier?.availableCredits?.[0]?.creditAmount > 0);
  assert.ok(codeAssist.allowedTiers?.some(tier => tier.id === 'free-tier'));

  const fallbackModels = mergeAntigravityModelsResponse({}, {});
  for (const details of Object.values(fallbackModels.models)) {
    assert.ok(details.model, '每个模型必须声明 model 枚举值');
    assert.ok(Object.values(details.supportedMimeTypes || {}).every(value => typeof value === 'boolean'), 'supportedMimeTypes 必须是 map<string, bool>');
  }

  const customModels = mergeAntigravityModelsResponse({}, {
    antigravityConfigs: [{
      id: 'custom-1',
      name: 'Custom Model',
      defaultModel: 'vendor/model-a',
      models: ['vendor/model-a', 'vendor/model-b'],
      sourceProviderName: 'Vendor',
      enabled: true,
      injectModels: true,
    }],
  });
  const customEntries = Object.entries(customModels.models)
    .filter(([, details]) => details.tagDescription === 'BYOK');
  assert.equal(customEntries.length, 2);
  assert.ok(customEntries.every(([catalogKey]) => catalogKey.startsWith('byok-')), '自定义模型 map key 必须使用独立 catalogKey');
  assert.ok(customEntries.every(([, details]) => details.model.startsWith('MODEL_')), '自定义模型必须使用合法预留运行枚举');
  assert.equal(new Set(customEntries.map(([, details]) => details.model)).size, customEntries.length, '自定义模型运行枚举必须唯一');
  assert.ok(customEntries.every(([, details]) => details.requestedModel === details.model && details.planModel === details.model));
  assert.ok(customEntries.every(([, details]) => {
    if (details.modelProvider === 'MODEL_PROVIDER_ANTHROPIC') {
      return details.apiProvider === 'API_PROVIDER_ANTHROPIC_VERTEX';
    }
    if (details.modelProvider === 'MODEL_PROVIDER_OPENAI') {
      return details.apiProvider === 'API_PROVIDER_OPENAI_VERTEX';
    }
    return details.apiProvider === 'API_PROVIDER_GOOGLE_GEMINI';
  }), '运行枚举、模型供应商和 API 供应商必须保持同一协议族');
  assert.ok(customEntries.every(([, details]) => details.vertexModelId), 'BYOK 模型必须携带真实上游模型 ID');
  assert.ok(Array.isArray(customModels.agentModelSorts) && customModels.agentModelSorts.length > 0, '必须构建 agentModelSorts 确保 IDE 前端展示模型');
  assert.ok(customModels.agentModelSorts[0].groups[0].modelIds.length > 0, 'agentModelSorts 分组必须包含注入的 BYOK 模型');
  assert.ok(customModels.defaultAgentModelId, '必须设置合法存在的 defaultAgentModelId');

  const internalDependencies = Object.entries(customModels.models)
    .filter(([, details]) => ['MODEL_PLACEHOLDER_M36', 'MODEL_PLACEHOLDER_M50', 'MODEL_PLACEHOLDER_M318'].includes(details.model));
  assert.equal(internalDependencies.length, 3, '纯 BYOK 模式必须注册 Language Server 所需的 M36/M50/M318 隐藏模型');
  const visibleModelIds = customModels.agentModelSorts.flatMap(sort =>
    (sort.groups || []).flatMap(group => group.modelIds || [])
  );
  assert.ok(internalDependencies.every(([catalogKey]) => !visibleModelIds.includes(catalogKey)), '内部依赖模型不得出现在用户模型下拉框');
  assert.equal(resolveAntigravityCustomModel('MODEL_PLACEHOLDER_M36', {
    antigravityConfigs: [{
      id: 'custom-1',
      name: 'Custom Model',
      defaultModel: 'vendor/model-a',
      models: ['vendor/model-a', 'vendor/model-b'],
      sourceProviderName: 'Vendor',
      enabled: true,
      injectModels: true,
    }],
    platforms: { antigravity: { providerId: 'custom-1' } },
  })?.upstreamModel, 'vendor/model-a', 'M36 必须路由到当前选中的 BYOK 默认模型');
  assert.equal(resolveAntigravityCustomModel('MODEL_PLACEHOLDER_M50', {
    antigravityConfigs: [{
      id: 'custom-1',
      name: 'Custom Model',
      defaultModel: 'vendor/model-a',
      models: ['vendor/model-a', 'vendor/model-b'],
      sourceProviderName: 'Vendor',
      enabled: true,
      injectModels: true,
    }],
    platforms: { antigravity: { providerId: 'custom-1' } },
  })?.upstreamModel, 'vendor/model-a', 'M50 必须路由到当前选中的 BYOK 默认模型');
  assert.equal(resolveAntigravityCustomModel('MODEL_PLACEHOLDER_M318', {
    antigravityConfigs: [{
      id: 'custom-1',
      name: 'Custom Model',
      defaultModel: 'vendor/model-a',
      models: ['vendor/model-a', 'vendor/model-b'],
      sourceProviderName: 'Vendor',
      enabled: true,
      injectModels: true,
    }],
    platforms: { antigravity: { providerId: 'custom-1' } },
  })?.upstreamModel, 'vendor/model-a', 'M318 必须路由到当前选中的 BYOK 默认模型');

  for (const [catalogKey, details] of customEntries) {
    const byRuntime = resolveAntigravityCustomModel(details.model, {
      antigravityConfigs: [{
        id: 'custom-1',
        name: 'Custom Model',
        defaultModel: 'vendor/model-a',
        models: ['vendor/model-a', 'vendor/model-b'],
        sourceProviderName: 'Vendor',
        enabled: true,
        injectModels: true,
      }],
    });
    const byCatalog = resolveAntigravityCustomModel(catalogKey, {
      antigravityConfigs: [{
        id: 'custom-1',
        name: 'Custom Model',
        defaultModel: 'vendor/model-a',
        models: ['vendor/model-a', 'vendor/model-b'],
        sourceProviderName: 'Vendor',
        enabled: true,
        injectModels: true,
      }],
    });
    assert.ok(byRuntime?.upstreamModel);
    assert.notEqual(byRuntime.upstreamModel, details.model, 'placeholder 必须反向映射为真实上游模型');
    assert.equal(byCatalog?.upstreamModel, byRuntime.upstreamModel);
  }

  const quota = mockAntigravityUserQuotaSummary();
  assert.ok(Array.isArray(quota.userQuotaSummary?.quotas));
  assert.ok(quota.userQuotaSummary.quotas.length > 0);
  assert.equal(quota.userQuotaSummary.quotas[0].status, 'ACTIVE');

  const userInfo = mockAntigravityUserInfo();
  assert.equal(userInfo.email, 'user@anybridge.local');
  assert.equal(userInfo.userTier?.id, 'standard-tier');

  const adminControls = mockAntigravityAdminControls();
  assert.equal(adminControls.adminControls?.allFeaturesEnabled, true);

  const userSettings = mockAntigravityUserSettings();
  assert.equal(userSettings.userSettings?.telemetryEnabled, false);

  assert.equal(isAntigravityBypassMetricsPath('/v1internal:recordCodeAssistMetrics'), true);
  assert.equal(isAntigravityBypassMetricsPath('/v1internal:recordTrajectoryAnalytics'), true);
  assert.equal(isAntigravityBypassMetricsPath('/v1internal:listExperiments'), true);
  assert.equal(isAntigravityBypassMetricsPath('/v1internal:fetchAvailableModels'), false);
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
    assert.equal(assistJson.cloudaicompanionProject, '');

    // 2. 测试 onboardUser 必须返回已完成的 Long-running Operation，禁止轮询 /v1internal/undefined
    const onboardRes = await fetch(`http://127.0.0.1:${port}/v1internal:onboardUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tierId: 'free-tier' }),
    });
    assert.equal(onboardRes.status, 200);
    const onboardJson = await onboardRes.json();
    assert.equal(onboardJson.done, true);
    assert.ok(onboardJson.name);
    assert.ok(onboardJson.response && typeof onboardJson.response === 'object');

    // 3. 测试 fetchAvailableModels
    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.ok(modelsJson.models && typeof modelsJson.models === 'object' && !Array.isArray(modelsJson.models));
    assert.ok(Object.entries(modelsJson.models).every(([key, details]) => {
      if (!key.startsWith('byok-')) return true;
      return details.model.startsWith('MODEL_');
    }));
    assert.ok(Array.isArray(modelsJson.agentModelSorts));

    // 4. 测试 retrieveUserQuotaSummary
    const quotaRes = await fetch(`http://127.0.0.1:${port}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(quotaRes.status, 200);
    const quotaJson = await quotaRes.json();
    assert.ok(quotaJson.userQuotaSummary?.quotas?.length > 0);

    // 5. 测试 fetchUserInfo
    const userRes = await fetch(`http://127.0.0.1:${port}/v1internal:fetchUserInfo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(userRes.status, 200);
    const userJson = await userRes.json();
    assert.equal(userJson.name, 'AnyBridge User');
    assert.equal(userJson.userTier?.id, 'standard-tier');

    // 6. 测试 fetchAdminControls
    const adminRes = await fetch(`http://127.0.0.1:${port}/v1internal:fetchAdminControls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(adminRes.status, 200);
    const adminJson = await adminRes.json();
    assert.equal(adminJson.adminControls?.allFeaturesEnabled, true);

    // 7. 测试指标旁路拦截: recordCodeAssistMetrics (0ms 秒回 200 {})
    const metricRes = await fetch(`http://127.0.0.1:${port}/v1internal:recordCodeAssistMetrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'test' }),
    });
    assert.equal(metricRes.status, 200);
    const metricJson = await metricRes.json();
    assert.deepEqual(metricJson, {});

    // 8. 测试其他未知探测接口安全兜底 (200 {})
    const unknownRes = await fetch(`http://127.0.0.1:${port}/v1internal:unknownProbingMethod`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unknownRes.status, 200);
    const unknownJson = await unknownRes.json();
    assert.deepEqual(unknownJson, {});
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

test('Antigravity internal dependency catalog keys resolve to the active BYOK model', () => {
  const providersJson = {
    antigravityConfigs: [{
      id: 'custom-1',
      name: 'Custom Model',
      defaultModel: 'vendor/model-a',
      models: ['vendor/model-a'],
      sourceProviderName: 'Vendor',
      enabled: true,
      injectModels: true,
    }],
    platforms: { antigravity: { providerId: 'custom-1' } },
  };
  // LS 实际用目录键请求内部 checkpoint / fast model；只认运行枚举会导致 400 并崩溃
  for (const key of ['anybridge-internal-checkpoint', 'anybridge-internal-fast-model', 'anybridge-internal-checkpoint-fallback']) {
    const resolved = resolveAntigravityCustomModel(key, providersJson);
    assert.ok(resolved, `内部目录键 ${key} 必须能解析到 BYOK 模型`);
    assert.equal(resolved.upstreamModel, 'vendor/model-a');
  }
  for (const runtime of ['MODEL_PLACEHOLDER_M36', 'MODEL_PLACEHOLDER_M50', 'MODEL_PLACEHOLDER_M318']) {
    assert.equal(resolveAntigravityCustomModel(runtime, providersJson)?.upstreamModel, 'vendor/model-a');
  }
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
