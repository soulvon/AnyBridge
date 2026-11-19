// sidecar/lib/local-proxy/api-keys-rotation.test.js — apiKeys 多密钥池 401/429 轮换、Micro-backoff 与 codeium-proxy 超时/断连单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { invalidate } from '../../config-cache.js';
import { execute } from '../../local-proxy.js';
import { handleGetChatMessage } from '../../handlers/chat.js';
import { createTracker } from '../../request-tracker.js';
import { wrapEnvelope } from '../../connect.js';
import { writeVarintField, writeStringField, writeBytesField } from '../../proto.js';
import { createCodeiumProxy } from '../hybrid-server/codeium-proxy.js';

function buildChatRequestBody(modelId, text = 'hello') {
  const userMsg = Buffer.concat([
    writeVarintField(2, 1), // SOURCE.USER
    writeStringField(3, text),
  ]);
  const raw = Buffer.concat([
    writeBytesField(3, userMsg), // field 3 = repeated ChatMessagePrompt
    writeStringField(21, modelId),
  ]);
  return wrapEnvelope(raw);
}

test('local-proxy execute: 401 与 429 在重试循环内顺延轮换 apiKeys 并尊重 <2s Retry-After 微退避', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-key-rot-'));
  const prevDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  const seenAuths = [];
  const server = http.createServer((req, res) => {
    seenAuths.push(req.headers.authorization || '');
    if (seenAuths.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key 1' } }));
      return;
    }
    if (seenAuths.length === 2) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'rate limit key 2' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok from key 3' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
      providers: [{
        id: 'p-multi',
        name: 'MultiKey',
        apiHost: `http://127.0.0.1:${port}`,
        apiPath: '/v1/chat/completions',
        apiFormat: 'openai',
        apiKey: 'k1',
        apiKeys: ['k1', 'k2', 'k3'],
        enabled: true,
      }],
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'proxy-routes.json'), JSON.stringify({
      version: 1,
      routes: [{
        id: 'multi-model',
        exposedFormats: ['openai'],
        targets: [{ providerId: 'p-multi', model: 'm-1' }],
      }],
    }), 'utf8');
    invalidate('all');

    const started = Date.now();
    const result = await execute({
      kind: 'openai',
      model: 'multi-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      stream: false,
      maxTokens: 64,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.text, 'ok from key 3');
    assert.deepEqual(seenAuths, ['Bearer k1', 'Bearer k2', 'Bearer k3']);
    assert.ok(elapsed >= 800, '429 带 Retry-After=1s 时应原地等待微退避后再切下一 key');
  } finally {
    server.closeAllConnections?.();
    server.close();
    invalidate('all');
    if (prevDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers/chat.js: !res.headersSent 时 401/429 顺延切换 apiKeys 池内下一把密钥并成功吐流', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-chat-rot-'));
  const prevDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  const seenAuths = [];
  const server = http.createServer((req, res) => {
    seenAuths.push(req.headers.authorization || '');
    if (seenAuths.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'expired' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"rotated ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
      providers: [{
        id: 'p-chat-multi',
        name: 'ChatMulti',
        apiHost: `http://127.0.0.1:${port}`,
        apiPath: '/v1/chat/completions',
        apiFormat: 'openai',
        apiKey: 'ck-1',
        apiKeys: ['ck-1', 'ck-2'],
        enabled: true,
      }],
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
      slots: [{
        modelUid: 'chat-multi-uid',
        enabled: true,
        targets: [{ providerId: 'p-chat-multi', model: 'gpt-x', apiFormat: 'openai' }],
      }],
    }), 'utf8');
    invalidate('all');

    const res = new EventEmitter();
    res.headersSent = false;
    res.writableEnded = false;
    res.chunks = [];
    res.writeHead = (s) => { res.statusCode = s; res.headersSent = true; };
    res.write = (c) => { res.chunks.push(c); return true; };

    const donePromise = new Promise((resolve) => {
      res.end = (c) => {
        if (c) res.chunks.push(c);
        res.writableEnded = true;
        res.emit('close');
        resolve();
      };
    });

    const tracker = createTracker({ client: 'windsurf', route: 'chat', requestedModel: 'chat-multi-uid' });
    handleGetChatMessage({ headers: {} }, res, buildChatRequestBody('chat-multi-uid'), tracker);
    await donePromise;

    assert.deepEqual(seenAuths, ['Bearer ck-1', 'Bearer ck-2']);
    assert.equal(tracker.retries.count, 1);
    assert.equal(tracker.status, 'ok');
    assert.ok(Buffer.concat(res.chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8').includes('rotated ok'));
  } finally {
    server.closeAllConnections?.();
    server.close();
    invalidate('all');
    if (prevDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codeium-proxy: 客户端关闭 res 时立即销毁上游请求防空烧', () => {
  let fakeReq;
  const origRequest = https.request;
  https.request = () => {
    fakeReq = new EventEmitter();
    fakeReq.destroyed = false;
    fakeReq.destroy = () => { fakeReq.destroyed = true; };
    fakeReq.end = () => {};
    return fakeReq;
  };
  try {
    const proxy = createCodeiumProxy({
      configDir: () => os.tmpdir(),
      mitmUpstreamHost: new Map(),
      getUpstreamHost: () => 'server.codeium.com',
      httpsAgentFor: (a) => a,
      PROXY_HTTPS_AGENT: {},
      rpcAuditLog: () => {},
      mitmLog: () => {},
      tryGunzip: (b) => b,
      rewriteRegisterUser: (b) => b,
      noteTakeoverRequest: () => {},
      noteTakeoverCapture: () => {},
      diagLog: { log: () => {} },
      extractModelList: () => [],
      unlockModels: () => null,
      cacheState: {},
    });
    const res = new EventEmitter();
    res.writableEnded = false;
    proxy({ url: '/exa.language_server_pb.LanguageServerService/GetChatMessage', headers: {}, method: 'POST' }, res, Buffer.from('{}'), 1);
    assert.equal(fakeReq.destroyed, false);
    res.emit('close');
    assert.equal(fakeReq.destroyed, true);
  } finally {
    https.request = origRequest;
  }
});
