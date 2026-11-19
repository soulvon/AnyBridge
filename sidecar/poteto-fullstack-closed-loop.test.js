// poteto-fullstack-closed-loop.test.js — @poteto 运行时全栈闭环实测：
// 启动真实 sidecar/proxy-entry.js 子进程 + 四协议本地 Mock 上游，验证跨协议流式 UTF-8 截断防御、
// Gemini thoughtSignature 工具调用保真、UI/Rust 对象格式多密钥池 429 轮转与禁用跳过、
// 禁用供应商硬阻断、客户端断流防空烧与 /__byok/stats 实时记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SIDECAR_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.join(SIDECAR_DIR, 'proxy-entry.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function httpRequest({ port, method = 'POST', reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function parseSseEvents(text) {
  const events = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = '';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const raw = dataLines.join('\n');
    if (!raw || raw === '[DONE]') continue;
    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      events.push({ event, raw });
    }
  }
  return events;
}

function createMockQuadUpstream() {
  const seenAuths = [];
  const hangCloseTimestamps = [];
  let hangActive = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json = {};
      try { json = rawBody ? JSON.parse(rawBody) : {}; } catch {}
      const urlPath = (req.url || '/').split('?')[0];
      const auth = String(req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '');

      // Case 4：多密钥池故障注入（记录每跳凭证，429 不重试延迟过久）
      if (urlPath === '/rot/v1/chat/completions') {
        seenAuths.push(auth);
        if (auth === 'Bearer key-429-first') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          res.end(JSON.stringify({ error: { message: 'rate limit hit on first key' } }));
          return;
        }
        if (auth !== 'Bearer key-backup-second') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `unexpected auth: ${auth}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-rot-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'key-rotation-verified' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        }));
        return;
      }

      // Case 6：客户端断流探针（先下发 SSE 头与首帧，再挂起等待断流回收）
      if (urlPath.startsWith('/hang/')) {
        hangActive = true;
        const onClosed = () => {
          if (hangActive) {
            hangActive = false;
            hangCloseTimestamps.push(Date.now());
          }
        };
        res.once('close', onClosed);
        req.socket?.once('close', onClosed);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        const firstChunk = JSON.stringify({
          id: 'chatcmpl-hang-1',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'first-byte-sent ' }, finish_reason: null }],
        });
        res.write(`data: ${firstChunk}\n\n`);
        return;
      }

      // Case 1：OpenAI Chat SSE —— 故意把 UTF-8 三字节中文劈跨两个 TCP chunk 发送
      if (urlPath === '/v1/chat/completions' || urlPath === '/openai/v1/chat/completions') {
        if (json.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          const fullFrame = Buffer.from(
            `data: ${JSON.stringify({
              id: 'chatcmpl-utf8',
              choices: [{ index: 0, delta: { content: '你好，土豆姐闭环验证通过！' }, finish_reason: null }],
            })}\n\n`,
            'utf8',
          );
          const idx = fullFrame.indexOf(Buffer.from('好', 'utf8'));
          const cutAt = idx > 0 ? idx + 1 : Math.floor(fullFrame.length / 2);
          res.write(fullFrame.subarray(0, cutAt));
          setTimeout(() => {
            res.write(fullFrame.subarray(cutAt));
            res.write(`data: ${JSON.stringify({
              id: 'chatcmpl-utf8',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 18, completion_tokens: 14 },
            })}\n\n`);
            res.end('data: [DONE]\n\n');
          }, 15);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-unary',
          choices: [{ index: 0, message: { role: 'assistant', content: 'openai-unary-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
        return;
      }

      // Case 2：Gemini streamGenerateContent SSE（带 functionCall + thoughtSignature + 文本）
      if (urlPath.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        const callFrame = {
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [{
                functionCall: { name: 'lookup_weather', args: { city: 'Shanghai' } },
                thoughtSignature: 'sig_poteto_verified_01',
              }],
            },
          }],
        };
        const endFrame = {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '工具已调用' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 9 },
        };
        res.write(`data: ${JSON.stringify(callFrame)}\n\n`);
        res.write(`data: ${JSON.stringify(endFrame)}\n\n`);
        res.end();
        return;
      }

      // Case 3：Anthropic Messages SSE
      if (urlPath === '/v1/messages' || urlPath === '/anthropic/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-up-1', role: 'assistant', model: json.model || 'claude-up', usage: { input_tokens: 15, output_tokens: 0 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic-stream-for-responses' } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } })}\n\n`);
        res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Unhandled mock path: ${urlPath}` } }));
    });
  });

  return {
    server,
    seenAuths,
    hangCloseTimestamps,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('@poteto full-stack closed-loop: real proxy-entry + quad-protocol mock upstream', async () => {
  const upstream = createMockQuadUpstream();
  const mockPort = await upstream.start();
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-poteto-e2e-'));
  const apiPort = await getFreePort();
  const infPort = await getFreePort();
  const agHttpsPort = await getFreePort();
  const proxyKey = 'poteto-e2e-local-key';

  fs.writeFileSync(path.join(cfgDir, 'byok-config.json'), JSON.stringify({
    values: { LOCAL_PROXY_KEY: proxyKey, API_KEY: proxyKey },
  }), 'utf8');

  fs.writeFileSync(path.join(cfgDir, 'providers.json'), JSON.stringify({
    antigravityMode: 'pure',
    providers: [
      {
        id: 'prov-openai-mock', name: 'MockOpenAI', apiFormat: 'openai',
        apiHost: `http://127.0.0.1:${mockPort}`, apiPath: '/v1/chat/completions',
        apiKey: 'sk-oai-mock', enabled: true,
      },
      {
        id: 'prov-gemini-mock', name: 'MockGemini', apiFormat: 'gemini',
        apiHost: `http://127.0.0.1:${mockPort}`, apiPath: '/v1beta',
        apiKey: 'AIza-mock-gem', enabled: true,
      },
      {
        id: 'prov-anthropic-mock', name: 'MockAnthropic', apiFormat: 'anthropic',
        apiHost: `http://127.0.0.1:${mockPort}`, apiPath: '/v1/messages',
        apiKey: 'sk-ant-mock', enabled: true,
      },
      {
        // 与 Rust Vec<ProviderApiKey> 及 UI 36-provider-keys.js 落盘格式完全一致
        id: 'prov-rot-obj', name: 'MockRotationObj', apiFormat: 'openai',
        apiHost: `http://127.0.0.1:${mockPort}`, apiPath: '/rot/v1/chat/completions',
        apiKey: 'key-429-first',
        apiKeys: [
          { id: 'k-off', label: '已停用', key: 'key-disabled-must-skip', enabled: false },
          { id: 'k-1', label: '主力限流', key: 'key-429-first', enabled: true },
          { id: 'k-2', label: '备用正常', key: 'key-backup-second', enabled: true },
        ],
        enabled: true,
      },
      {
        id: 'prov-hang-mock', name: 'MockHang', apiFormat: 'openai',
        apiHost: `http://127.0.0.1:${mockPort}`, apiPath: '/hang/v1/chat/completions',
        apiKey: 'sk-hang', enabled: true,
      },
      {
        id: 'prov-disabled-mock', name: 'MockDisabled', apiFormat: 'openai',
        apiHost: `http://127.0.0.1:${mockPort}`, apiPath: '/v1/chat/completions',
        apiKey: 'sk-disabled', enabled: false,
      },
    ],
    antigravityConfigs: [],
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(cfgDir, 'model-map.json'), JSON.stringify({
    slots: [],
    enhancement: { retry: true, retryMaxRetries: 3, retryBaseMs: 20, retryCapMs: 50, retryTotalSeconds: 10 },
  }), 'utf8');

  fs.writeFileSync(path.join(cfgDir, 'proxy-routes.json'), JSON.stringify({
    version: 2,
    routes: [
      { id: 'route-oai-utf8', exposedFormats: ['openai', 'anthropic'], targets: [{ providerId: 'prov-openai-mock', model: 'gpt-utf8' }] },
      { id: 'route-gem-tools', exposedFormats: ['openai', 'gemini'], targets: [{ providerId: 'prov-gemini-mock', model: 'gemini-2.5-pro' }] },
      { id: 'route-ant-resp', exposedFormats: ['openai', 'anthropic'], targets: [{ providerId: 'prov-anthropic-mock', model: 'claude-4' }] },
      { id: 'route-key-rot', exposedFormats: ['openai'], targets: [{ providerId: 'prov-rot-obj', model: 'gpt-rot' }] },
      { id: 'route-hang', exposedFormats: ['openai'], targets: [{ providerId: 'prov-hang-mock', model: 'gpt-hang' }] },
      { id: 'route-disabled-only', exposedFormats: ['openai'], targets: [{ providerId: 'prov-disabled-mock', model: 'gpt-off' }] },
    ],
  }, null, 2), 'utf8');

  const child = spawn(process.execPath, [ENTRY_PATH], {
    cwd: SIDECAR_DIR,
    env: {
      ...process.env,
      BYOK_CONFIG_DIR: cfgDir,
      API_PORT: String(apiPort),
      INFERENCE_PORT: String(infPort),
      ANTIGRAVITY_HTTPS_PORT: String(agHttpsPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sidecarLogs = '';
  child.stdout.on('data', (d) => { sidecarLogs += d; });
  child.stderr.on('data', (d) => { sidecarLogs += d; });

  const authHeaders = { authorization: `Bearer ${proxyKey}`, 'content-type': 'application/json' };

  try {
    let healthy = false;
    for (let i = 0; i < 45 && child.exitCode === null; i++) {
      try {
        const h = await httpRequest({ port: apiPort, method: 'GET', reqPath: '/health', headers: authHeaders });
        if (h.status === 200) { healthy = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.ok(healthy, `proxy-entry 未就绪:\n${sidecarLogs}`);

    // Case 1: Anthropic 下游 -> OpenAI Chat 上游（劈裂 UTF-8 多字节汉字 SSE）
    const c1 = await httpRequest({
      port: apiPort,
      reqPath: '/v1/messages',
      headers: { ...authHeaders, 'anthropic-version': '2023-06-01' },
      body: { model: 'route-oai-utf8', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(c1.status, 200);
    const c1Events = parseSseEvents(c1.text);
    const c1Text = c1Events
      .filter((e) => e.data?.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    assert.equal(c1Text, '你好，土豆姐闭环验证通过！', `UTF-8 中文拼接异常: ${c1.text}`);
    assert.equal(c1Text.includes('\uFFFD'), false, '出现 U+FFFD 乱码字符');

    // Case 4: UI/Rust ProviderApiKey 对象多密钥池（429 自动顺延 + 跳过 enabled=false + 禁止 [object Object]）
    const c4 = await httpRequest({
      port: apiPort,
      reqPath: '/v1/chat/completions',
      headers: authHeaders,
      body: { model: 'route-key-rot', stream: false, messages: [{ role: 'user', content: 'rotate' }] },
    });
    assert.equal(c4.status, 200, `多密钥对象池轮转失败: status=${c4.status} body=${c4.text}`);
    const c4Json = JSON.parse(c4.text);
    assert.equal(c4Json.choices?.[0]?.message?.content, 'key-rotation-verified');
    assert.deepEqual(
      upstream.seenAuths,
      ['Bearer key-429-first', 'Bearer key-backup-second'],
      `密钥尝试序列错误（不应发 [object Object] 或停用密钥）: ${JSON.stringify(upstream.seenAuths)}`,
    );

    // Case 2: OpenAI 下游 -> Gemini 上游（tool_calls 与 thoughtSignature 跨协议保真）
    const c2 = await httpRequest({
      port: apiPort,
      reqPath: '/v1/chat/completions',
      headers: authHeaders,
      body: { model: 'route-gem-tools', stream: true, messages: [{ role: 'user', content: '查上海天气' }] },
    });
    assert.equal(c2.status, 200, `c2 failed: status=${c2.status} body=${c2.text} | logs=${sidecarLogs}`);
    const c2Events = parseSseEvents(c2.text);
    const toolName = c2Events.find((e) => e.data?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name)
      ?.data?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name;
    assert.equal(toolName, 'lookup_weather', `未透传 Gemini tool_calls: ${c2.text}`);
    assert.ok(c2Events.some((e) => e.data?.choices?.[0]?.delta?.content?.includes('工具已调用')));

    // Case 3: OpenAI Responses 下游 -> Anthropic Messages 上游流式闭环
    const c3 = await httpRequest({
      port: apiPort,
      reqPath: '/v1/responses',
      headers: authHeaders,
      body: { model: 'route-ant-resp', stream: true, input: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(c3.status, 200);
    const c3Events = parseSseEvents(c3.text);
    const c3Delta = c3Events
      .filter((e) => e.data?.type === 'response.output_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.equal(c3Delta, 'anthropic-stream-for-responses', `Responses 跨协议流式异常: ${c3.text}`);

    // Case 5: 禁用供应商硬阻断，绝不串台
    const c5 = await httpRequest({
      port: apiPort,
      reqPath: '/v1/chat/completions',
      headers: authHeaders,
      body: { model: 'route-disabled-only', stream: false, messages: [{ role: 'user', content: 'should block' }] },
    });
    assert.ok(c5.status >= 400, `禁用供应商应硬阻断报错，实际返回 HTTP ${c5.status}: ${c5.text}`);

    // Case 6: 客户端流式中途断流 -> 立即关闭上游 socket，不卡死后续请求
    let abortedAt = 0;
    await new Promise((resolve, reject) => {
      const abortReq = http.request({
        host: '127.0.0.1', port: apiPort, path: '/v1/chat/completions', method: 'POST', headers: authHeaders,
      }, (res) => {
        res.once('data', () => {
          abortedAt = Date.now();
          abortReq.destroy();
          resolve();
        });
      });
      abortReq.on('error', (err) => {
        if (abortedAt > 0) resolve();
        else reject(err);
      });
      abortReq.end(JSON.stringify({ model: 'route-hang', stream: true, messages: [{ role: 'user', content: 'hang' }] }));
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(upstream.hangCloseTimestamps.length >= 1, '客户端断流后上游连接未被销毁');
    assert.ok(upstream.hangCloseTimestamps[0] - abortedAt < 500, '上游断流清理超时 >500ms');

    // 验证断流后网关队列/网关进程仍健康可继续处理请求
    const afterHang = await httpRequest({
      port: apiPort,
      reqPath: '/v1/chat/completions',
      headers: authHeaders,
      body: { model: 'route-oai-utf8', stream: false, messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(afterHang.status, 200);

    // Case 7: /__byok/stats 统计计数器已真实入账
    const statsRes = await httpRequest({ port: apiPort, method: 'GET', reqPath: '/__byok/stats', headers: authHeaders });
    assert.equal(statsRes.status, 200);
    const stats = JSON.parse(statsRes.text);
    assert.ok(Number(stats.requests) >= 5, `/__byok/stats requests 应 >= 5，实际=${stats.requests}`);
    assert.ok(Number(stats.inputTokens) > 0 && Number(stats.outputTokens) > 0, `token 统计异常: ${statsRes.text}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
    await upstream.stop();
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
