// chat-sse-transform.test.js — 真流式转换器的增量映射回归测试
// Run: node --test lib/chat-sse-transform.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatSSEFromResponses,
  createChatSSEFromAnthropic,
  createChatSSEPassthrough,
  createChatSSEConverter,
} from './chat-sse-transform.js';

const ID = 'chatcmpl-test';
const CREATED = 1;

test('Responses SSE: text deltas become content chunks', () => {
  const c = createChatSSEFromResponses('m', ID, CREATED);
  const out = [
    ...c.write({ type: 'response.output_text.delta', delta: '你' }),
    ...c.write({ type: 'response.output_text.delta', delta: '好' }),
    ...c.write({ type: 'response.completed', response: { output: [], usage: { input_tokens: 3, output_tokens: 2 } } }),
  ];
  assert.equal(out[0].choices[0].delta.content, '你');
  assert.equal(out[1].choices[0].delta.content, '好');
  assert.equal(out[2].choices[0].finish_reason, 'stop');
  assert.equal(out[2].usage.total_tokens, 5);
  assert.equal(out[2].object, 'chat.completion.chunk');
});

test('Responses SSE: function_call arguments stream into tool_calls deltas', () => {
  const c = createChatSSEFromResponses('m', ID, CREATED);
  const first = c.write({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', call_id: 'call_a', name: 'write_file' },
  });
  assert.equal(first.length, 1);
  const tc = first[0].choices[0].delta.tool_calls[0];
  assert.equal(tc.index, 0);
  assert.equal(tc.id, 'call_a');
  assert.equal(tc.function.name, 'write_file');
  assert.equal(tc.function.arguments, '');

  const d1 = c.write({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' });
  const d2 = c.write({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"a.html"}' });
  assert.equal(d1[0].choices[0].delta.tool_calls[0].function.arguments, '{"path":');
  assert.equal(d2[0].choices[0].delta.tool_calls[0].function.arguments, '"a.html"}');

  const done = c.write({
    type: 'response.completed',
    response: { output: [{ type: 'function_call' }], usage: { input_tokens: 10, output_tokens: 5 } },
  });
  assert.equal(done[0].choices[0].finish_reason, 'tool_calls');
});

test('Responses SSE: multiple tool calls get sequential chat indexes', () => {
  const c = createChatSSEFromResponses('m', ID, CREATED);
  c.write({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'a' } });
  c.write({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_2', name: 'b' } });
  const d = c.write({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{}' });
  assert.equal(d[0].choices[0].delta.tool_calls[0].index, 1, '第二个函数的 chat index 必须是 1');
  assert.equal(d[0].choices[0].delta.tool_calls[0].id, undefined, '增量块只带 index+arguments');
});

test('Anthropic SSE: text + tool_use stream correctly', () => {
  const c = createChatSSEFromAnthropic('m', ID, CREATED);
  const start = c.write({ type: 'message_start', message: { usage: { input_tokens: 7 } } });
  assert.equal(start.length, 0);
  const t = c.write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
  assert.equal(t[0].choices[0].delta.content, 'Hello');
  const tu = c.write({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file' } });
  assert.equal(tu[0].choices[0].delta.tool_calls[0].function.name, 'write_file');
  const arg = c.write({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } });
  assert.equal(arg[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(arg[0].choices[0].delta.tool_calls[0].function.arguments, '{"path":"x"}');
  c.write({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
  const stop = c.write({ type: 'message_stop' });
  assert.equal(stop[0].choices[0].finish_reason, 'tool_calls');
  assert.equal(stop[0].usage.prompt_tokens, 7);
  assert.equal(stop[0].usage.completion_tokens, 4);
  assert.equal(stop[0].usage.total_tokens, 11);
});

test('Anthropic SSE: end_turn maps to stop gracefully', () => {
  const c = createChatSSEFromAnthropic('m', ID, CREATED);
  c.write({ type: 'message_start', message: { usage: { input_tokens: 2 } } });
  c.write({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
  const stop = c.write({ type: 'message_stop' });
  assert.equal(stop[0].choices[0].finish_reason, 'stop');
});

test('Chat SSE passthrough rewrites model name only', () => {
  const c = createChatSSEPassthrough('gpt-6-astra(AnyRouter)');
  const chunk = { id: 'x', object: 'chat.completion.chunk', model: 'gpt-6-astra', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] };
  const out = c.write(chunk);
  assert.equal(out[0].model, 'gpt-6-astra(AnyRouter)');
  assert.equal(out[0].choices[0].delta.content, 'hi');
  assert.deepEqual(c.write({ foo: 1 }), [], '非 chat chunk 忽略');
});

test('createChatSSEConverter picks by upstream shape', () => {
  const anthropic = createChatSSEConverter({ format: 'anthropic', apiPath: '/v1/messages' }, 'm', ID, CREATED);
  assert.ok(anthropic.write({ type: 'message_stop' }).length === 1);
  const responses = createChatSSEConverter({ format: 'openai', apiPath: '/v1/responses' }, 'm', ID, CREATED);
  assert.ok(responses.write({ type: 'response.output_text.delta', delta: 'x' }).length === 1);
  const codexUnlock = createChatSSEConverter({ format: 'openai', apiPath: '/v1/messages', unlockKind: 'codex' }, 'm', ID, CREATED);
  assert.ok(codexUnlock.write({ type: 'response.output_text.delta', delta: 'x' }).length === 1);
  const chat = createChatSSEConverter({ format: 'openai', apiPath: '/v1/chat/completions' }, 'm', ID, CREATED);
  assert.equal(chat.write({ choices: [{ delta: { content: 'y' } }] })[0].choices[0].delta.content, 'y');
});
