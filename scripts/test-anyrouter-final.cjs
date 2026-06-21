/**
 * AnyRouter gpt-5.5 连通性测试 - 基于真实 Codex 请求格式
 * 用法: node scripts/test-anyrouter-final.cjs
 * 
 * 关键发现:
 *   - 端点: POST /v1/responses
 *   - 模型: gpt-5.5 (不是 codex-gpt-5.5!)
 *   - 响应: SSE 流式, 含 reasoning tokens
 */

const https = require('https');

const CONFIG = {
  host: 'anyrouter.top',
  port: 443,
  apiKey: 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU',
  model: 'gpt-5.5', // 关键: 不是 codex-gpt-5.5!
};

function callResponsesAPI(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: CONFIG.host, port: CONFIG.port,
      path: '/v1/responses', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, raw, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

function parseSSE(raw) {
  const events = [];
  const lines = raw.split('\n');
  let current = {};
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      current.event = line.substring(7).trim();
    } else if (line.startsWith('data: ')) {
      const dataStr = line.substring(6);
      try { current.data = JSON.parse(dataStr); } catch (e) { current.data = dataStr; }
      events.push({ ...current });
      current = {};
    }
  }
  return events;
}

function extractText(events) {
  const texts = [];
  for (const ev of events) {
    if (ev.event === 'response.output_text.delta' && ev.data?.delta) {
      texts.push(ev.data.delta);
    }
  }
  return texts.join('');
}

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  AnyRouter gpt-5.5 连通性测试             ║');
  console.log('╚════════════════════════════════════════════╝\n');

  // ====== Test 1: 最简格式 (非流式) ======
  console.log('[Test 1] 最简格式: input=字符串, stream=false');
  let r = await callResponsesAPI({
    model: CONFIG.model,
    input: 'Reply exactly: OK',
    max_output_tokens: 20,
    stream: false,
  });
  printResult(r, 1);

  // ====== Test 2: 带 instructions + stream=false ======
  console.log('[Test 2] input=字符串 + instructions, stream=false');
  r = await callResponsesAPI({
    model: CONFIG.model,
    instructions: 'You are a helpful assistant. Keep responses short.',
    input: 'What is 2+2?',
    max_output_tokens: 50,
    temperature: 0.7,
    stream: false,
    text: { format: { type: 'text' }, verbosity: 'low' },
  });
  printResult(r, 2);

  // ====== Test 3: input=messages数组 (仿 Codex 格式) ======
  console.log('[Test 3] input=[messages] 仿 Codex 格式, stream=false');
  r = await callResponsesAPI({
    model: CONFIG.model,
    instructions: 'You are a helpful coding assistant.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello in one word.' }] },
    ],
    max_output_tokens: 50,
    temperature: 0.7,
    stream: false,
    text: { format: { type: 'text' }, verbosity: 'low' },
  });
  printResult(r, 3);

  // ====== Test 4: 流式 ======
  console.log('[Test 4] 流式输出 stream=true');
  r = await callResponsesAPI({
    model: CONFIG.model,
    instructions: 'You are a helpful assistant.',
    input: 'Count from 1 to 5.',
    max_output_tokens: 100,
    temperature: 0.7,
    stream: true,
    text: { format: { type: 'text' }, verbosity: 'low' },
  });
  if (r.status === 200) {
    const events = parseSSE(r.raw);
    const text = extractText(events);
    console.log(`  [OK] HTTP 200 (stream)`);
    console.log(`  响应文本: ${text}`);
    console.log(`  共 ${events.length} 个 SSE 事件`);
  } else {
    printResult(r, 4);
  }
}

function printResult(result, testNum) {
  const status = result.status;
  const summary = (result.raw || '').substring(0, 400);

  if (status === 200) {
    // 尝试解析 JSON 或 SSE
    if (summary.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(summary);
        if (obj.output) {
          obj.output.forEach((item, i) => {
            if (item.content) {
              item.content.forEach((c) => {
                if (c.text) console.log(`  响应 [${i}]: ${c.text.substring(0, 200)}`);
              });
            }
          });
        } else {
          console.log(`  [OK] HTTP 200: ${JSON.stringify(obj).substring(0, 300)}`);
        }
      } catch (e) {
        console.log(`  [OK] HTTP 200: ${summary}`);
      }
    } else if (summary.includes('event:')) {
      const events = parseSSE(result.raw);
      const text = extractText(events);
      console.log(`  [OK] HTTP 200 (SSE)`);
      console.log(`  响应: ${text}`);
    } else {
      console.log(`  [OK] HTTP 200: ${summary}`);
    }
  } else if (status === 0) {
    console.log(`  [ERR] ${result.error}`);
  } else {
    console.log(`  [FAIL] HTTP ${status}: ${summary}`);
  }
  console.log('');
}

main().catch(console.error);
