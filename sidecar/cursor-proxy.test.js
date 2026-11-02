import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __cursorProxyTest } from './cursor-proxy.js';
import { writeMessageField, writeStringField } from './proto.js';

function requestedModelBuffer({ modelId, maxMode = false, parameters = {} }) {
  const parts = [];
  if (modelId) parts.push(writeStringField(1, modelId));
  if (maxMode) parts.push(Buffer.from([0x10, 0x01])); // field 2, wire 0, value 1
  for (const [id, value] of Object.entries(parameters)) {
    parts.push(writeMessageField(3, Buffer.concat([writeStringField(1, id), writeStringField(2, value)])));
  }
  return Buffer.concat(parts);
}

test('parseRequestedModel 解析 Cursor 界面下发的思考参数', () => {
  const buf = requestedModelBuffer({
    modelId: 'claude-opus-4-7',
    maxMode: true,
    parameters: { effort: 'high', thinking: 'true', fast: 'true', context: '200k' },
  });

  const model = __cursorProxyTest.parseRequestedModel(buf);

  assert.equal(model.modelId, 'claude-opus-4-7');
  assert.equal(model.maxMode, true);
  assert.deepEqual(model.parameters, {
    effort: 'high',
    thinking: 'true',
    fast: 'true',
    context: '200k',
  });
});

test('parseRequestedModel 无参数时 parameters 为空对象', () => {
  const model = __cursorProxyTest.parseRequestedModel(requestedModelBuffer({ modelId: 'gpt-5.6' }));
  assert.deepEqual(model.parameters, {});
  assert.equal(model.maxMode, false);
});

test('cursorReasoningFromSession：effort 优先，none 不注入', () => {
  const high = __cursorProxyTest.cursorReasoningFromSession({
    requestedModel: { parameters: { effort: 'high' } },
  });
  assert.deepEqual(high, { effort: 'high' });

  const off = __cursorProxyTest.cursorReasoningFromSession({
    requestedModel: { parameters: { effort: 'none' } },
  });
  assert.equal(off, null, 'effort=none 与 cursor-core 同口径：不开思考，不注入档位');
});

test('cursorReasoningFromSession：只开思考不带档位时发 summary，全关不注入', () => {
  const thinking = __cursorProxyTest.cursorReasoningFromSession({
    requestedModel: { parameters: { thinking: 'true' } },
  });
  assert.deepEqual(thinking, { summary: 'auto' });

  const maxMode = __cursorProxyTest.cursorReasoningFromSession({
    requestedModel: { maxMode: true, parameters: {} },
  });
  assert.deepEqual(maxMode, { summary: 'auto' });

  const none = __cursorProxyTest.cursorReasoningFromSession({ requestedModel: { parameters: {} } });
  assert.equal(none, null);
});

test('buildLocalProxyContext 把档位写进 Responses 请求体', () => {
  const ctx = __cursorProxyTest.buildLocalProxyContext({
    requestID: 'req-1',
    conversationID: 'conv-1',
    mode: 'agent',
    userText: 'hello',
    requestedModel: { modelId: 'claude-opus-4-7', parameters: { effort: 'medium' } },
  }, { id: 'claude-opus-4-7' });

  assert.equal(ctx.kind, 'responses');
  assert.deepEqual(ctx.rawBody.reasoning, { effort: 'medium' });

  const plain = __cursorProxyTest.buildLocalProxyContext({
    requestID: 'req-2',
    conversationID: 'conv-2',
    mode: 'agent',
    userText: 'hello',
    requestedModel: { modelId: 'gpt-5.6', parameters: {} },
  }, { id: 'gpt-5.6' });

  assert.equal(plain.rawBody.reasoning, undefined);
});
