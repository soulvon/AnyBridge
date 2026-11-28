import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { invalidate as invalidateConfigCache } from './config-cache.js';
import {
  clearAntigravityCache,
  forwardToOfficialAntigravity,
} from './lib/antigravity-handler.js';
import { __localProxyTest, handleLocalProxyRequest } from './local-proxy.js';

function withIsolatedConfigDir(setupFn, runFn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-ag-tools-'));
    const prevDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = tmpDir;
    invalidateConfigCache('all');
    clearAntigravityCache();
    try {
      setupFn(tmpDir);
      invalidateConfigCache('all');
      await runFn(tmpDir);
    } finally {
      clearAntigravityCache();
      invalidateConfigCache('all');
      if (prevDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = prevDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('Antigravity pure BYOK mode: /v1internal:listExperiments returns capability flags enabling plugins, MCP, skills, subagents and marketplaces', withIsolatedConfigDir(
  (tmpDir) => {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({
      values: { LOCAL_PROXY_KEY: 'test-ag-key' },
    }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      antigravityMode: 'pure',
      antigravityConfigs: [],
    }), 'utf8');
  },
  async () => {
    const server = http.createServer((req, res) => handleLocalProxyRequest(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1internal:listExperiments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.flags) && json.flags.length > 0, 'pure 模式 listExperiments 不得返回空对象 {}，否则客户端会禁用全部插件/MCP/子代理工具');

      const flagMap = new Map(json.flags.map((f) => [f.name, f]));
      for (const requiredBoolFlag of [
        'enable-agent-plugins-spec',
        'enable-customization-kind-plugin',
        'enable-customization-kind-mcp',
        'enable-customization-kind-skill',
        'enable-customization-kind-agent',
        'enable-customization-kind-workflow',
        'enable-customization-skills',
        'enable-plugin-auth',
        'enable-mcp-plugin-auth',
        'mcp-lazy-load-tools',
        'enable-mcp-non-blocking-turn-load',
        'enable-subagent-hub',
        'enable-update-steps-tool',
        'enable-ask-question-tool',
        'enable-run-workflow-tool',
        'enable-native-swarm',
      ]) {
        assert.equal(flagMap.get(requiredBoolFlag)?.boolValue, true, `必须开启 ${requiredBoolFlag}`);
      }
      assert.ok(
        flagMap.get('agy-plugin-marketplaces')?.stringListValue?.values?.length >= 2,
        '必须下发官方插件市场目录地址，否则纯 BYOK 下插件市场为空',
      );
      const subagentCfg = JSON.parse(flagMap.get('invoke-subagent-config')?.stringValue || '{}');
      assert.equal(subagentCfg.enabled, true);
      assert.equal(subagentCfg.always_inherit_model, true, '纯 BYOK 下子代理必须默认继承当前 BYOK 模型，避免请求不存在的官方轻量模型');
    } finally {
      server.close();
    }
  },
));

test('Antigravity tool schema normalization: preserves parametersJsonSchema and coerces protobuf string numeric constraints to JSON integers', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'gpt-probe',
    contents: [{ role: 'user', parts: [{ text: 'run mcp and steps' }] }],
    tools: [{
      functionDeclarations: [
        {
          name: 'mcp_plugin_tool',
          description: 'Eager MCP plugin tool declared via parametersJsonSchema',
          parametersJsonSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
              server: { type: 'string', minLength: '1' },
              limit: { type: ['INTEGER', 'null'], maximum: '100' },
            },
            required: ['server'],
          },
        },
        {
          name: 'update_steps',
          description: 'Update live checklist',
          parameters: {
            type: 'OBJECT',
            properties: {
              steps: {
                type: 'ARRAY',
                maxItems: '12',
                minItems: '1',
                items: {
                  type: 'OBJECT',
                  properties: {
                    title: { type: 'STRING', minLength: '1', maxLength: '80' },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['steps'],
          },
        },
        {
          name: 'call_mcp_tool',
          description: 'Call lazy MCP tool',
          parameters: {
            type: 'OBJECT',
            properties: {
              ServerName: { type: 'STRING', minLength: '1' },
              ToolName: { type: 'STRING', minLength: '1' },
              Arguments: { description: 'Arguments to pass to the tool.' },
            },
            required: ['ServerName', 'ToolName', 'Arguments'],
          },
        },
      ],
    }],
  });

  // 1. OpenAI Chat & Responses 出站：parametersJsonSchema 完整保留，字符串数字约束全部转为 integer
  const openAITools = __localProxyTest.openAITools(ctx.tools);
  assert.equal(openAITools.length, 3);
  const mcpParams = openAITools[0].function.parameters;
  assert.equal(mcpParams.type, 'object');
  assert.equal(mcpParams.properties.server.type, 'string');
  assert.equal(mcpParams.properties.server.minLength, 1);
  assert.equal(typeof mcpParams.properties.server.minLength, 'number');
  assert.deepEqual(mcpParams.properties.limit.type, ['integer', 'null']);
  assert.equal(mcpParams.properties.limit.maximum, 100);

  const stepsParams = openAITools[1].function.parameters;
  assert.equal(stepsParams.properties.steps.maxItems, 12);
  assert.equal(stepsParams.properties.steps.minItems, 1);
  assert.equal(stepsParams.properties.steps.items.properties.title.minLength, 1);
  assert.equal(stepsParams.properties.steps.items.properties.title.maxLength, 80);

  // 2. Anthropic 出站同样收到合法整数约束与保留的 parametersJsonSchema
  const anthropic = __localProxyTest.anthropicTools(ctx.tools);
  assert.equal(anthropic[0].input_schema.properties.server.minLength, 1);
  assert.equal(anthropic[1].input_schema.properties.steps.maxItems, 12);
  assert.equal(anthropic[2].input_schema.properties.ServerName.minLength, 1);

  // 3. Gemini/Vertex 出站（含原生透传清洗）：无 type 的 Arguments 补 OBJECT，parametersJsonSchema 清洗为合法 parameters
  const geminiRebuilt = __localProxyTest.geminiTools(ctx.tools);
  const geminiCallMcp = geminiRebuilt[0].functionDeclarations.find((d) => d.name === 'call_mcp_tool');
  assert.equal(geminiCallMcp.parameters.properties.Arguments.type, 'OBJECT');
  assert.equal(geminiCallMcp.parameters.properties.ServerName.minLength, 1);

  const geminiPassthrough = __localProxyTest.upstreamBody({
    format: 'gemini',
    isVertex: true,
    model: 'gemini-2.5-pro',
    apiPath: '/v1/projects/p/locations/global/publishers/google/models/gemini-2.5-pro:generateContent',
  }, ctx);
  const passthroughMcpDecl = geminiPassthrough.tools[0].functionDeclarations[0];
  assert.equal(passthroughMcpDecl.parametersJsonSchema, undefined, 'Vertex 透传清洗后不得同时残留互斥的 parametersJsonSchema');
  assert.equal(passthroughMcpDecl.parameters.properties.server.type, 'STRING');
  assert.equal(passthroughMcpDecl.parameters.properties.server.minLength, 1);
  const passthroughCallMcp = geminiPassthrough.tools[0].functionDeclarations[2];
  assert.equal(passthroughCallMcp.parameters.properties.Arguments.type, 'OBJECT');
});

test('Antigravity E2E cross-protocol tool name codec: encodes names with colons/dots for OpenAI/Anthropic and restores original names in SSE stream', withIsolatedConfigDir(
  (tmpDir) => {
    fs.writeFileSync(path.join(tmpDir, 'byok-config.json'), JSON.stringify({
      values: { LOCAL_PROXY_KEY: 'test-ag-key' },
    }), 'utf8');
  },
  async (tmpDir) => {
    const seenUpstreamBodies = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seenUpstreamBodies.push(body);
        // 严格模拟 OpenAI/Anthropic 工具名正则校验 ^[a-zA-Z0-9_-]{1,64}$
        for (const t of body.tools || []) {
          const name = t.function?.name || t.name;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Invalid tool name: ${name}` } }));
            return;
          }
        }
        const wireToolName = body.tools[0].function.name;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call_ns_1', type: 'function', function: { name: wireToolName, arguments: '{"query":"hello"}' } }],
            },
            finish_reason: null,
          }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      antigravityMode: 'pure',
      providers: [{
        id: 'p-strict-openai',
        name: 'StrictOpenAI',
        apiHost: `http://127.0.0.1:${upstreamPort}`,
        apiPath: '/v1/chat/completions',
        apiFormat: 'openai',
        apiKey: 'sk-test',
        defaultModel: 'gpt-strict',
        models: ['gpt-strict'],
        enabled: true,
      }],
      antigravityConfigs: [{
        id: 'ag-strict',
        name: 'gpt-strict',
        sourceProviderId: 'p-strict-openai',
        defaultModel: 'gpt-strict',
        models: ['gpt-strict'],
        enabled: true,
        injectModels: true,
      }],
      platforms: { antigravity: { providerId: 'ag-strict' } },
    }), 'utf8');
    invalidateConfigCache('all');

    const proxy = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handleLocalProxyRequest(req, res, Buffer.concat(chunks)));
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = proxy.address().port;

    try {
      const agRes = await fetch(`http://127.0.0.1:${proxyPort}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-strict',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'search via plugin' }] }],
            tools: [{
              functionDeclarations: [{
                name: 'mcp.huge-search:query.v2',
                description: 'Plugin tool with dots and colon',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { query: { type: 'string', minLength: '1' } },
                  required: ['query'],
                },
              }],
            }],
            toolConfig: {
              functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: ['mcp.huge-search:query.v2'],
              },
            },
          },
        }),
      });
      assert.equal(agRes.status, 200);
      const sseText = await agRes.text();
      const frames = sseText
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));

      const toolFrame = frames.find((f) => f.response?.candidates?.[0]?.finishReason === 'TOOL_CALL');
      assert.ok(toolFrame, `必须成功收到 TOOL_CALL 帧而非 400 错误帧，实际输出: ${sseText}`);
      const fnCall = toolFrame.response.candidates[0].content.parts[0].functionCall;
      assert.equal(fnCall.name, 'mcp.huge-search:query.v2', '流式返回给 Antigravity 时必须还原原始带冒号/点号的工具名');
      assert.deepEqual(fnCall.args, { query: 'hello' });
      assert.match(seenUpstreamBodies[0].tool_choice.function.name, /^[a-zA-Z0-9_-]{1,64}$/, 'tool_choice 中的工具名也必须同步编码');
    } finally {
      proxy.close();
      upstream.close();
    }
  },
));

test('Antigravity multi-turn history to OpenAI/Anthropic: deduplicates ID-less parallel calls, extracts functionResponse.parts, and drops empty thought-only turns', () => {
  const ctx = __localProxyTest.normalizeRequest('gemini', {
    model: 'claude-sonnet-test',
    contents: [
      { role: 'user', parts: [{ text: 'read two files' }] },
      // 轮次 1：纯 thought 的中间轮次（过滤后不应残留空 content: []）
      { role: 'model', parts: [{ thought: true, text: 'thinking silently...' }] },
      // 轮次 2：两条同名且无 id 的并行 functionCall
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'call_mcp_tool', args: { ServerName: 's1', ToolName: 't1', Arguments: {} } } },
          { functionCall: { name: 'call_mcp_tool', args: { ServerName: 's1', ToolName: 't2', Arguments: {} } } },
        ],
      },
      // 轮次 3：两条无 id 的 functionResponse，其中第二条通过新版 parts 字段携带返回文本
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'call_mcp_tool', response: { output: 'FIRST_RESULT' } } },
          { functionResponse: { name: 'call_mcp_tool', response: {}, parts: [{ text: 'SECOND_FROM_PARTS' }] } },
        ],
      },
    ],
  });

  const anthropicBody = __localProxyTest.upstreamBody({
    format: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiPath: '/v1/messages',
  }, ctx);

  assert.ok(
    anthropicBody.messages.every((m) => Array.isArray(m.content) && m.content.length > 0),
    '不得向 Anthropic 发送任何空 content: [] 消息',
  );

  const assistantToolMsg = anthropicBody.messages.find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'));
  assert.ok(assistantToolMsg);
  const toolUses = assistantToolMsg.content.filter((b) => b.type === 'tool_use');
  assert.equal(toolUses.length, 2);
  assert.notEqual(toolUses[0].id, toolUses[1].id, '两条无 id 的同名 functionCall 必须分配唯一不碰撞的 tool_use.id');

  const userResultMsg = anthropicBody.messages[anthropicBody.messages.length - 1];
  const toolResults = userResultMsg.content.filter((b) => b.type === 'tool_result');
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0].tool_use_id, toolUses[0].id);
  assert.match(String(toolResults[0].content), /FIRST_RESULT/);
  assert.equal(toolResults[1].tool_use_id, toolUses[1].id);
  assert.match(String(toolResults[1].content), /SECOND_FROM_PARTS/, '必须提取 functionResponse.parts 中的文本结果');
});

test('forwardToOfficialAntigravity does not throw ERR_HTTP_HEADERS_SENT when response headers were already sent', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstream.close();

  let writeHeadCalls = 0;
  const alreadySentRes = {
    headersSent: true,
    writableEnded: true,
    writeHead() {
      writeHeadCalls += 1;
      const err = new Error('Cannot write headers after they are sent to the client');
      err.code = 'ERR_HTTP_HEADERS_SENT';
      throw err;
    },
    end() {},
  };

  await assert.doesNotReject(async () => {
    await forwardToOfficialAntigravity(
      { url: '/v1internal:loadCodeAssist', method: 'POST', headers: {} },
      alreadySentRes,
      { body: Buffer.from('{}') },
    );
  });
  assert.equal(writeHeadCalls, 0, 'headersSent 为 true 时严禁再次调用 writeHead');
});
