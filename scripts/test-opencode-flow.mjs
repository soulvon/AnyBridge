/**
 * 测试 Codex Chat 模式完整流程：
 * 1. 模拟 Codex 发来的 Responses API 请求
 * 2. 用 responsesToChatCompletions 转换为 Chat Completions 请求
 * 3. 发送到 OpenCode 供应商 API
 * 4. 用 chatCompletionToResponse 将响应转回 Responses 格式
 * 5. 验证输出结构正确
 *
 * 也测试流式路径：createResponsesSSEFromChat
 */

import { responsesToChatCompletions, chatCompletionToResponse, createResponsesSSEFromChat } from '../sidecar/lib/responses-chat-transform.js';

// ── OpenCode 供应商配置 ──
const OPENCODE_CONFIG = {
  apiHost: 'https://opencode.ai',
  apiPath: '/zen/go/v1/chat/completions',
  apiKey: 'sk-cqweLq7bV2P5KL6m3R5rcvrB2wnLft2dfNA5WMkkw33zHvXox44gRyv4znJIpN5q',
  model: 'deepseek-v4-flash',
  codexChatReasoning: {
    supportsThinking: false,
    supportsEffort: false,
    thinkingParam: 'none',
    effortParam: 'none',
    effortValueMode: 'passthrough',
    outputFormat: 'auto',
  },
};

// ── 模拟 Codex 发来的 Responses API 请求体 ──
const mockResponsesBody = {
  model: OPENCODE_CONFIG.model,
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '你好，请用一句话介绍你自己。' }],
    },
  ],
  stream: false,
  instructions: '你是一个友好的助手。',
};

const mockResponsesBodyStream = {
  ...mockResponsesBody,
  stream: true,
};

function log(label, obj) {
  console.log(`\n════════ ${label} ════════`);
  console.log(JSON.stringify(obj, null, 2));
}

async function testNonStreaming() {
  console.log('\n🔄 测试非流式路径 (Responses → Chat → OpenCode API → Responses)');

  // Step 1: Responses → Chat Completions
  const chatBody = responsesToChatCompletions(mockResponsesBody, OPENCODE_CONFIG.codexChatReasoning);
  chatBody.model = OPENCODE_CONFIG.model;
  log('Step 1: 转换后的 Chat Completions 请求', chatBody);

  // Step 2: 发送到 OpenCode API
  const url = `${OPENCODE_CONFIG.apiHost}${OPENCODE_CONFIG.apiPath}`;
  const requestBody = JSON.stringify(chatBody);
  console.log(`\n📤 发送请求到: ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCODE_CONFIG.apiKey}`,
    },
    body: requestBody,
  });

  console.log(`\n📥 响应状态码: ${res.status}`);

  if (!res.ok) {
    const errorText = await res.text();
    console.error('❌ 上游返回错误:');
    console.error(errorText.substring(0, 2000));
    return false;
  }

  const chatResponse = await res.json();
  log('Step 2: OpenCode API 返回的 Chat Completions 响应', chatResponse);

  // Step 3: Chat Completions → Responses
  const responsesObj = chatCompletionToResponse(chatResponse, OPENCODE_CONFIG.model);
  log('Step 3: 转换后的 Responses 格式响应', responsesObj);

  // Step 4: 验证结构
  const checks = [
    { name: 'response.id 存在', pass: !!responsesObj.id },
    { name: 'response.object === "response"', pass: responsesObj.object === 'response' },
    { name: 'response.status === "completed"', pass: responsesObj.status === 'completed' },
    { name: 'response.output 是数组', pass: Array.isArray(responsesObj.output) },
    { name: 'response.output 包含 message 类型', pass: responsesObj.output?.some(o => o.type === 'message') },
    { name: 'message.content[0].type === "output_text"', pass: responsesObj.output?.find(o => o.type === 'message')?.content?.[0]?.type === 'output_text' },
    { name: 'response.output_text 非空', pass: !!responsesObj.output_text },
    { name: 'response.usage 存在', pass: !!responsesObj.usage },
  ];

  console.log('\n✅ 验证结果:');
  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  return allPass;
}

async function testStreaming() {
  console.log('\n🔄 测试流式路径 (Responses → Chat SSE → OpenCode API → Responses SSE)');

  // Step 1: Responses → Chat Completions (stream=true)
  const chatBody = responsesToChatCompletions(mockResponsesBodyStream, OPENCODE_CONFIG.codexChatReasoning);
  chatBody.model = OPENCODE_CONFIG.model;
  chatBody.stream = true;
  log('Step 1: 转换后的 Chat Completions 流式请求', chatBody);

  // Step 2: 发送流式请求到 OpenCode API
  const url = `${OPENCODE_CONFIG.apiHost}${OPENCODE_CONFIG.apiPath}`;
  const requestBody = JSON.stringify(chatBody);
  console.log(`\n📤 发送流式请求到: ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCODE_CONFIG.apiKey}`,
      'Accept': 'text/event-stream',
    },
    body: requestBody,
  });

  console.log(`\n📥 响应状态码: ${res.status}`);

  if (!res.ok) {
    const errorText = await res.text();
    console.error('❌ 上游返回错误:');
    console.error(errorText.substring(0, 2000));
    return false;
  }

  // Step 3: 读取 SSE 流并逐块转换
  const converter = createResponsesSSEFromChat(OPENCODE_CONFIG.model, OPENCODE_CONFIG.codexChatReasoning.outputFormat);
  const allEvents = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        const events = converter.write(chunk);
        allEvents.push(...events);
      } catch {
        // skip non-JSON
      }
    }
  }

  // 处理最后残留的 buffer
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          const chunk = JSON.parse(data);
          const events = converter.write(chunk);
          allEvents.push(...events);
        } catch {
          // skip
        }
      }
    }
  }

  const finalEvents = converter.flush();
  allEvents.push(...finalEvents);

  log('Step 3: 转换后的 Responses SSE 事件列表', allEvents.map(e => e.type));

  // Step 4: 验证事件结构
  const eventTypes = allEvents.map(e => e.type);
  const checks = [
    { name: '包含 response.created', pass: eventTypes.includes('response.created') },
    { name: '包含 response.output_text.delta', pass: eventTypes.some(t => t === 'response.output_text.delta') },
    { name: '包含 response.output_text.done', pass: eventTypes.includes('response.output_text.done') },
    { name: '包含 response.output_item.done', pass: eventTypes.includes('response.output_item.done') },
    { name: '包含 response.completed', pass: eventTypes.includes('response.completed') },
  ];

  const completedEvent = allEvents.find(e => e.type === 'response.completed');
  if (completedEvent) {
    const resp = completedEvent.response;
    checks.push({ name: 'completed.response.output 是数组', pass: Array.isArray(resp?.output) });
    checks.push({ name: 'completed.response.output 包含 message 类型', pass: resp?.output?.some(o => o.type === 'message') });
    checks.push({ name: 'completed.response.output_text 非空', pass: !!resp?.output_text });
    checks.push({ name: 'completed.response.usage 存在', pass: !!resp?.usage });
  }

  console.log('\n✅ 验证结果:');
  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (completedEvent) {
    console.log(`\n📝 最终输出文本: ${completedEvent.response.output_text?.substring(0, 200)}`);
  }

  return allPass;
}

// ── 主函数 ──
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Codex Chat 模式完整流程测试 (OpenCode 供应商)  ║');
  console.log('╚══════════════════════════════════════════════╝');

  let nonStreamPass = false;
  let streamPass = false;

  try {
    nonStreamPass = await testNonStreaming();
  } catch (e) {
    console.error('❌ 非流式测试异常:', e.message);
    console.error(e.stack);
  }

  try {
    streamPass = await testStreaming();
  } catch (e) {
    console.error('❌ 流式测试异常:', e.message);
    console.error(e.stack);
  }

  console.log('\n═══════════════════════════════════════');
  console.log('📊 测试总结:');
  console.log(`  非流式: ${nonStreamPass ? '✅ 通过' : '❌ 失败'}`);
  console.log(`  流  式: ${streamPass ? '✅ 通过' : '❌ 失败'}`);
  console.log('═══════════════════════════════════════');

  process.exit(nonStreamPass && streamPass ? 0 : 1);
}

main();
