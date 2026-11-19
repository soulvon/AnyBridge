// sidecar/lib/codec-registry.test.js — 覆盖 B-P0-1 / B-P0-2 / 槽位释放 / 流式账本结算 / 无损协议转换 / 韧性单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { invalidate } from '../config-cache.js';
import { handleLocalProxyRequest } from '../local-proxy.js';
import { createChatSSEFromAnthropic, createChatSSEFromResponses } from './chat-sse-transform.js';
import { consumeCursorUpstreamStream } from './cursor/streaming.js';
import { clearGeminiToolCallCache, lookupGeminiToolCall, rememberGeminiToolCall } from './gemini-thought-signature.js';
import { normalizeOpenAI } from './local-proxy/normalize.js';
import { responseObject, sendAntigravityStream, sendGeminiStream } from './local-proxy/response-emitters.js';
import { geminiContents, openAIChatMessages } from './local-proxy/upstream-payload.js';
import { responsesToChatCompletions } from './responses-chat-transform.js';
import { raceOfficialSuccess } from './antigravity/mocks-and-handshake.js';
import { resolveGeminiAuthHeader, clearGeminiTokenCache } from './google-gemini.js';
import { toOpenAIChatMessages } from '../handlers/chat/to-openai-messages.js';

function makeTrackableStream(chunks, { errorAfterChunk = null } = {}) {
  const pt = new PassThrough();
  let destroyed = false;
  const origDestroy = pt.destroy.bind(pt);
  pt.destroy = (err) => {
    destroyed = true;
    return origDestroy(err);
  };
  pt.wasDestroyed = () => destroyed;
  queueMicrotask(async () => {
    for (let i = 0; i < chunks.length; i++) {
      if (destroyed) return;
      pt.write(chunks[i]);
      await new Promise((r) => setTimeout(r, 1));
      if (errorAfterChunk === i) {
        pt.destroy(new Error('upstream mid-stream reset'));
        return;
      }
    }
    if (!destroyed) pt.end();
  });
  return pt;
}

function makeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.statusCode = 200;
  res.chunks = [];
  res.writeHead = (s) => { res.statusCode = s; res.headersSent = true; };
  res.write = (c) => { res.chunks.push(String(c)); return true; };
  res.end = (c) => { if (c) res.chunks.push(String(c)); res.writableEnded = true; };
  return res;
}

test('B-P0-1: sendGeminiStream 真流式支持 OpenAI Chat / Responses / Anthropic 转 Gemini SSE（含思考/工具/签名）且 100% destroy 上游', async () => {
  clearGeminiToolCallCache();
  // 1) OpenAI Chat -> Gemini SSE
  const chatRes = makeRes();
  const chatUp = makeTrackableStream([
    'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"结果文本"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_oai_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ]);
  await sendGeminiStream(
    { model: 'gemini-3-pro' },
    chatRes,
    { conn: { format: 'openai', host: 'api.oai.test', model: 'm1' }, stream: true, upstreamResponse: chatUp },
    true,
  );
  assert.equal(chatUp.wasDestroyed(), true, '正常完成也必须 destroy 上游释放槽位');
  const chatEvents = chatRes.chunks.join('').split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
  const allParts = chatEvents.flatMap((e) => e.candidates?.[0]?.content?.parts || []);
  assert.ok(allParts.some((p) => p.thought === true && p.text === '先分析'));
  assert.ok(allParts.some((p) => p.thought !== true && p.text === '结果文本'));
  const fcPart = allParts.find((p) => p.functionCall);
  assert.equal(fcPart.functionCall.name, 'read_file');
  assert.equal(fcPart.thoughtSignature, 'skip_thought_signature_validator');
  assert.ok(lookupGeminiToolCall('call_oai_1', { host: 'api.oai.test', model: 'm1' }));

  // 2) Responses -> Gemini SSE
  const respRes = makeRes();
  const respUp = makeTrackableStream([
    'data: {"type":"response.reasoning_summary_text.delta","delta":"想一想"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"答复"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}\n\n',
  ]);
  await sendGeminiStream(
    { model: 'gemini-3-pro' },
    respRes,
    { conn: { format: 'openai', apiPath: '/v1/responses', model: 'm2' }, stream: true, upstreamResponse: respUp },
    true,
  );
  assert.equal(respUp.wasDestroyed(), true);
  assert.match(respRes.chunks.join(''), /想一想/);
  assert.match(respRes.chunks.join(''), /答复/);

  // 3) Anthropic -> Gemini SSE + 客户端断连立即销毁上游且不发 STOP
  const abortRes = makeRes();
  const neverEndingUp = new PassThrough();
  let destroyedOnAbort = false;
  neverEndingUp.destroy = () => { destroyedOnAbort = true; PassThrough.prototype.destroy.call(neverEndingUp); };
  const p = sendGeminiStream(
    { model: 'gemini-3-pro' },
    abortRes,
    { conn: { format: 'anthropic', model: 'claude' }, stream: true, upstreamResponse: neverEndingUp },
    true,
  );
  neverEndingUp.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\n\n');
  await new Promise((r) => setTimeout(r, 15));
  abortRes.emit('close');
  await p;
  assert.equal(destroyedOnAbort, true, '客户端断连必须立刻销毁上游防止槽位死锁和空烧');
  assert.equal(abortRes.chunks.join('').includes('"finishReason":"STOP"'), false, '断连不得补发伪造 STOP');

  // 4) 流异常后严禁补发 STOP
  const errRes = makeRes();
  const errUp = makeTrackableStream([
    'data: {"choices":[{"delta":{"content":"中途"}}]}\n\n',
  ], { errorAfterChunk: 0 });
  await sendGeminiStream(
    { model: 'gemini-3-pro' },
    errRes,
    { conn: { format: 'openai', model: 'm3' }, stream: true, upstreamResponse: errUp },
    true,
  );
  assert.equal(errUp.wasDestroyed(), true);
  assert.match(errRes.chunks.join(''), /"error"/);
  assert.equal(errRes.chunks.join('').includes('"finishReason":"STOP"'), false);
});

test('B-P0-2: Antigravity 与 Cursor 真流式支持 Responses / Anthropic / Gemini 上游，断连销毁并释放槽位', async () => {
  // Antigravity <- Responses
  const agRes = makeRes();
  const agUp = makeTrackableStream([
    'data: {"type":"response.reasoning_summary_text.delta","delta":"推理"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"正文"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":4}}}\n\n',
  ]);
  await sendAntigravityStream(
    { model: 'gemini-3-pro' },
    agRes,
    { conn: { format: 'openai', apiPath: '/v1/responses', model: 'gpt-5' }, stream: true, upstreamResponse: agUp },
  );
  assert.equal(agUp.wasDestroyed(), true);
  const agText = agRes.chunks.join('');
  assert.match(agText, /"thought":true/);
  assert.match(agText, /"text":"正文"/);
  assert.match(agText, /"finishReason":"STOP"/);

  // Cursor <- Anthropic
  const cursorFrames = [];
  const cursorRes = makeRes();
  cursorRes.write = (buf) => { cursorFrames.push(buf); return true; };
  const anthUp = makeTrackableStream([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15,"cache_creation_input_tokens":4}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"ls","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const cursorOut = await consumeCursorUpstreamStream(
    cursorRes,
    { conn: { format: 'anthropic', model: 'claude' }, upstreamResponse: anthUp },
    { onThinking: () => true, onText: () => true },
  );
  assert.equal(anthUp.wasDestroyed(), true);
  assert.equal(cursorOut.assistantText, '答');
  assert.equal(cursorOut.toolCalls[0].name, 'ls');
  assert.equal(cursorOut.usage.inputTokens, 15);
  assert.equal(cursorOut.usage.outputTokens, 6);
  assert.equal(cursorOut.usage.cacheCreationInputTokens, 4);
});

test('流式请求端到端写入 usage-ledger 真实 usage（非 0），提前 EOF 不记 ok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-stream-ledger-'));
  const prevDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  let mode = 'ok';
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (mode === 'ok') {
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":33,"cache_creation_input_tokens":9}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else {
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"截断"}}\n\n');
      res.end(); // 未发 message_stop 提前 EOF
    }
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();

  try {
    fs.writeFileSync(path.join(dir, 'byok-config.json'), JSON.stringify({
      values: { LOCAL_PROXY_KEY: 'test-proxy-key' },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
      providers: [{ id: 'p-anth', name: 'Anth', apiHost: `http://127.0.0.1:${port}`, apiKey: 'sk-a', apiFormat: 'anthropic', enabled: true }],
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'proxy-routes.json'), JSON.stringify({
      version: 1,
      routes: [{ id: 'g-stream', exposedFormats: ['gemini', 'openai'], targets: [{ providerId: 'p-anth', model: 'claude' }] }],
    }), 'utf8');
    invalidate('all');

    const resOk = makeRes();
    await handleLocalProxyRequest(
      {
        method: 'POST',
        url: '/v1beta/models/g-stream:streamGenerateContent?alt=sse',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': 'test-proxy-key' },
      },
      resOk,
      Buffer.from(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })),
    );

    mode = 'eof';
    const resFail = makeRes();
    await handleLocalProxyRequest(
      {
        method: 'POST',
        url: '/v1beta/models/g-stream:streamGenerateContent?alt=sse',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': 'test-proxy-key' },
      },
      resFail,
      Buffer.from(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })),
    );

    const day = new Date().toISOString().slice(0, 10);
    const ledgerFile = path.join(dir, 'usage', `usage-${day}.jsonl`);
    const rows = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const okRow = rows.find((r) => r.status === 'ok');
    const failRow = rows.find((r) => r.status === 'failed');
    assert.ok(okRow, '完整流应记为 ok');
    assert.equal(okRow.usage.input, 33);
    assert.equal(okRow.usage.output, 12);
    assert.equal(okRow.usage.cacheWrite, 9);
    assert.ok(failRow, '未收齐终止帧提前 EOF 不得记 ok，必须记 failed');
  } finally {
    upstream.closeAllConnections?.();
    upstream.close();
    invalidate('all');
    if (prevDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('协议互转、reasoning_content 跨协议透传、LRU 与 host 隔离签名、以及非 2xx 重试容错', async () => {
  // 1) normalizeOpenAI: 不拆 assistant、合并 tool+user、剔空 content:[]
  const norm = normalizeOpenAI({
    input: [
      { role: 'assistant', content: '查一下' },
      { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: { ok: true } },
      { role: 'user', content: '补充一句' },
      { role: 'assistant', content: '' },
    ],
  });
  assert.equal(norm.messages.length, 2, 'assistant 文本+tool_use 合并、tool_result+user 合并、空消息剔除');
  assert.equal(norm.messages[0].content.length, 2);
  assert.equal(norm.messages[1].content.length, 2);

  // 2) to-chat: 对象/数组 function_call_output 不出现 [object Object]
  const chatReq = responsesToChatCompletions({
    input: [
      { type: 'function_call', call_id: 'c1', name: 'stat', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: { status: 'ok', count: 3 } },
    ],
  });
  assert.equal(chatReq.messages.find((m) => m.role === 'tool').content, '{"status":"ok","count":3}');

  // 3) openAIChatMessages & toOpenAIChatMessages 统一回填 reasoning_content
  const oaiMsgs = openAIChatMessages('', [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
  ]);
  assert.equal(oaiMsgs[0].reasoning_content, '');
  const chatHandlerMsgs = toOpenAIChatMessages('', [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
  ]);
  assert.equal(chatHandlerMsgs[0].reasoning_content, '');

  // 4) Gemini 3/4 并行调用首条缺签名、次条有缓存签名 → 首条补兜底哨兵；且 host/model 严格隔离
  clearGeminiToolCallCache();
  rememberGeminiToolCall('call_second', { signature: 'sig-host-a', upstreamId: 'call_second', scope: { host: 'host-a.com', model: 'g3' } });
  assert.equal(lookupGeminiToolCall('call_second', { host: 'host-b.com', model: 'g3' }), null, '不同 host 不得串联签名');
  const contents = geminiContents('', [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_first_miss', name: 'f1', input: {} },
        { type: 'tool_use', id: 'call_second', name: 'f2', input: {} },
      ],
    },
  ], { host: 'host-a.com', model: 'g3' });
  assert.equal(contents[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(contents[0].parts[1].thoughtSignature, 'sig-host-a');

  // 5) LRU 上限 2000 淘汰与访问刷新
  clearGeminiToolCallCache();
  rememberGeminiToolCall('hot-key', { signature: 'sig-hot' });
  for (let i = 0; i < 1998; i++) rememberGeminiToolCall(`fill-${i}`, { signature: `s-${i}` });
  assert.equal(lookupGeminiToolCall('hot-key')?.signature, 'sig-hot');
  rememberGeminiToolCall('push-1', { signature: 's1' });
  rememberGeminiToolCall('push-2', { signature: 's2' });
  assert.equal(lookupGeminiToolCall('hot-key')?.signature, 'sig-hot', '热键命中刷新后不应被 LRU 淘汰');
  assert.equal(lookupGeminiToolCall('fill-0'), null, '最冷键应已淘汰');

  // 6) Responses/Anthropic -> Chat SSE 透传 reasoning_content & cache_creation_input_tokens
  const r2c = createChatSSEFromResponses('m', 'id1', 1);
  assert.equal(r2c.write({ type: 'response.reasoning.delta', delta: '思考' })[0].choices[0].delta.reasoning_content, '思考');
  const a2c = createChatSSEFromAnthropic('m', 'id2', 1);
  a2c.write({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 6 } } });
  assert.equal(a2c.write({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } })[0].choices[0].delta.reasoning_content, '想');
  a2c.write({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
  const aStop = a2c.write({ type: 'message_stop' });
  assert.equal(aStop[0].usage.cache_creation_input_tokens, 6);

  // 7) raceOfficialSuccess 赢后立刻 abort 败者
  const aborted = [];
  const win = await raceOfficialSuccess([
    { promise: Promise.resolve({ statusCode: 200, body: Buffer.from('ok') }), abort: () => aborted.push(0) },
    { promise: new Promise(() => {}), abort: () => aborted.push(1) },
    { promise: new Promise(() => {}), abort: () => aborted.push(2) },
  ]);
  assert.equal(win.statusCode, 200);
  assert.deepEqual(aborted, [1, 2]);

  // 8) google-gemini OAuth 503 重试与 singleflight
  clearGeminiTokenCache();
  let calls = 0;
  const sa = JSON.stringify({
    type: 'service_account',
    client_email: 'a@b.iam.gserviceaccount.com',
    private_key: (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const auth = await resolveGeminiAuthHeader(sa, {
    tokenPoster: async () => {
      calls++;
      if (calls === 1) return { statusCode: 503, headers: {}, text: 'busy', json: null };
      return { statusCode: 200, headers: {}, text: '', json: { access_token: 'ya29.retry_ok', expires_in: 3600 } };
    },
  });
  assert.equal(calls, 2);
  assert.equal(auth.token, 'ya29.retry_ok');

  // 9) responseObject 无空 message
  const rObj = responseObject({ model: 'm' }, { text: '', toolCalls: [{ id: '1', name: 'fn', arguments: {} }] }, 'r1');
  assert.equal(rObj.output.every((i) => i.type !== 'message'), true);
});
