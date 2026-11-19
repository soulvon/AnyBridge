// sidecar/lib/sse-parser.test.js — 标准 SSE 解析器与 UTF-8 多字节流边界测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createSSEParser, parseSSEStream, parseSSEText } from './sse-parser.js';
import { parseSSEChunk } from '../handlers/anthropic-stream.js';
import { parseOpenAISSEChunk } from '../handlers/openai-stream.js';
import { parseUpstreamSSE } from './cursor/common.js';

test('createSSEParser: 正确拼接多行 data:、支持 data:{...} 无空格、支持无 event: 默认事件并 flush 尾帧', () => {
  const parser = createSSEParser({ parseJson: false });
  const chunk1 = Buffer.from('event: custom\ndata: line1\r\ndata:line2\r\n\r\n');
  const chunk2 = Buffer.from('data: {"ok":true}\r\n'); // 无 event:、末尾无空行

  const ev1 = parser.push(chunk1);
  assert.equal(ev1.length, 1);
  assert.equal(ev1[0].event, 'custom');
  assert.equal(ev1[0].hasExplicitEvent, true);
  assert.equal(ev1[0].data, 'line1\nline2');

  const ev2Pending = parser.push(chunk2);
  assert.equal(ev2Pending.length, 0);

  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].event, 'message');
  assert.equal(flushed[0].hasExplicitEvent, false);
  assert.equal(flushed[0].data, '{"ok":true}');
});

test('createSSEParser: 多字节 UTF-8 与 \\r\\n 跨 chunk 边界不产生替换符', async () => {
  const payload = 'data:{"text":"你好🚀世界"}\r\ndata:[DONE]\r\n';
  const full = Buffer.from(payload, 'utf8');
  const rocketBytePos = Buffer.from('data:{"text":"你好', 'utf8').length;
  const crPos = payload.indexOf('\r\n');
  const crBytePos = Buffer.from(payload.slice(0, crPos), 'utf8').length;

  // 在 4 字节 emoji 正中间以及 \r 和 \n 之间切分 chunk
  const chunks = [
    full.subarray(0, rocketBytePos + 2),
    full.subarray(rocketBytePos + 2, crBytePos + 1),
    full.subarray(crBytePos + 1),
  ];
  const events = [];
  for await (const evt of parseSSEStream(Readable.from(chunks), { emitDone: true })) {
    events.push(evt);
  }
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].data, { text: '你好🚀世界' });
  assert.equal(events[1].done, true);
});

test('createSSEParser: 完整 JSON 连续 data 行无需空行也能拆分为独立事件，且支持分行 JSON', () => {
  const continuous = parseSSEText('data:{"a":1}\ndata:{"b":2}\ndata:[DONE]\n');
  assert.equal(continuous.length, 3);
  assert.deepEqual(continuous[0].data, { a: 1 });
  assert.deepEqual(continuous[1].data, { b: 2 });
  assert.equal(continuous[2].done, true);

  const splitJson = parseSSEText('data: {"hello":\ndata: "world"}\n\n');
  assert.equal(splitJson.length, 1);
  assert.deepEqual(splitJson[0].data, { hello: 'world' });
});

test('anthropic/openai 流解析器兼容无空格与默认事件', () => {
  const anth = parseSSEChunk('data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
  assert.equal(anth.length, 1);
  assert.equal(anth[0].event, 'content_block_delta');
  assert.equal(anth[0].data.delta.text, 'hi');

  const oai = parseOpenAISSEChunk('data:{"type":"response.output_text.delta","delta":"yo"}\ndata:[DONE]\n');
  assert.equal(oai.length, 2);
  assert.equal(oai[0].data.delta, 'yo');
  assert.equal(oai[1].done, true);
});

test('Cursor parseUpstreamSSE 多字节 UTF-8 分片不乱码并严格校验流尾非 SSE 数据', async () => {
  const msg = 'data:{"text":"中文测试🎉"}\ndata:[DONE]\n';
  const buf = Buffer.from(msg, 'utf8');
  const split = Buffer.from('data:{"text":"中文测试', 'utf8').length + 1;
  const items = [];
  for await (const item of parseUpstreamSSE(Readable.from([buf.subarray(0, split), buf.subarray(split)]))) {
    items.push(item);
  }
  assert.deepEqual(items, [{ text: '中文测试🎉' }]);

  await assert.rejects(async () => {
    for await (const _ of parseUpstreamSSE(Readable.from(['<html>bad gateway</html>']))) {
      // consume
    }
  }, /non-SSE trailing data/);
});
