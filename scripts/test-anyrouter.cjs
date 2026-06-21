/**
 * AnyRouter Responses API 格式探测脚本
 * 用法: node scripts/test-anyrouter.cjs
 * 
 * 逐步尝试不同的请求体格式，找出能通过校验的最小结构
 */

const https = require('https');

const API_KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const HOST = 'anyrouter.top';
const MODEL = 'gpt-5.5';

function doRequest(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: HOST,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });

    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });

    req.write(payload);
    req.end();
  });
}

async function test(name, body) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🧪 测试: ${name}`);
  console.log(`   请求体: ${JSON.stringify(body).substring(0, 200)}`);
  const result = await doRequest('/v1/responses', body);
  const ok = result.status === 200;
  const icon = ok ? '✅' : '❌';
  const summary = typeof result.body === 'object' ? JSON.stringify(result.body).substring(0, 300) : String(result.body).substring(0, 300);
  console.log(`   ${icon} HTTP ${result.status}: ${summary}`);
  return { name, ...result, ok };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   AnyRouter /v1/responses 格式探测             ║');
  console.log(`║   Model: ${MODEL}                                 ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  const results = [];

  // ===== 第1轮: 基础 input 变体 =====
  console.log('\n🔍 第1轮: input 格式变体');

  results.push(await test('input=字符串', {
    model: MODEL,
    input: 'say hi in one word',
    max_output_tokens: 20,
  }));

  results.push(await test('input=字符串 + instructions', {
    model: MODEL,
    instructions: 'You are a helpful assistant.',
    input: 'say hi in one word',
    max_output_tokens: 20,
  }));

  results.push(await test('input=[messages数组]', {
    model: MODEL,
    input: [{ role: 'user', content: 'say hi in one word' }],
    max_output_tokens: 20,
  }));

  results.push(await test('input=[messages]+instructions', {
    model: MODEL,
    instructions: 'You are a helpful assistant.',
    input: [{ role: 'user', content: 'say hi in one word' }],
    max_output_tokens: 20,
  }));

  // ===== 第2轮: 加 stream =====
  console.log('\n🔍 第2轮: stream 参数');

  results.push(await test('input=字符串 + stream:false', {
    model: MODEL,
    input: 'say hi',
    stream: false,
    max_output_tokens: 20,
  }));

  results.push(await test('input=字符串 + stream:true', {
    model: MODEL,
    input: 'say hi',
    stream: true,
    max_output_tokens: 20,
  }));

  // ===== 第3轮: 加 tools =====
  console.log('\n🔍 第3轮: tools 字段');

  results.push(await test('input=字符串 + tools=[]', {
    model: MODEL,
    instructions: 'You are helpful.',
    input: 'say hi',
    tools: [],
    max_output_tokens: 20,
  }));

  results.push(await test('input=[messages] + tools=[]', {
    model: MODEL,
    instructions: 'You are helpful.',
    input: [{ role: 'user', content: 'say hi' }],
    tools: [],
    max_output_tokens: 20,
  }));

  // ===== 第4轮: 参数名变体 =====
  console.log('\n🔍 第4轮: 参数名变体');

  results.push(await test('max_tokens 替代 max_output_tokens', {
    model: MODEL,
    input: 'say hi',
    max_tokens: 20,
  }));

  results.push(await test('两个都有', {
    model: MODEL,
    input: 'say hi',
    max_tokens: 20,
    max_output_tokens: 20,
  }));

  // ===== 第5轮: 完整参数 =====
  console.log('\n🔍 第5轮: 完整参数组合');

  results.push(await test('input=字符串+完整参数', {
    model: MODEL,
    instructions: 'You are a helpful assistant.',
    input: 'say hi',
    tools: [],
    temperature: 0.7,
    top_p: 0.95,
    max_output_tokens: 50,
    stream: false,
  }));

  results.push(await test('input=[messages]+完整参数', {
    model: MODEL,
    instructions: 'You are a helpful assistant.',
    input: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'say hi' },
    ],
    tools: [],
    temperature: 0.7,
    top_p: 0.95,
    max_output_tokens: 50,
    stream: false,
  }));

  // ===== 第6轮: Codex 风格 body =====
  console.log('\n🔍 第6轮: Codex 风格 (含 reasoning)');

  results.push(await test('Codex风格+reasoning', {
    model: MODEL,
    instructions: 'You are a coding agent.',
    input: [{ role: 'user', content: 'say hi' }],
    tools: [
      { type: 'function', name: 'bash', description: 'run shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
    ],
    temperature: 0.7,
    max_output_tokens: 50,
    reasoning: { effort: 'medium' },
  }));

  results.push(await test('Codex风格 无reasoning', {
    model: MODEL,
    instructions: 'You are a coding agent.',
    input: [{ role: 'user', content: 'say hi' }],
    tools: [
      { type: 'function', name: 'bash', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
    ],
    temperature: 0.7,
    max_output_tokens: 50,
  }));

  // ===== 第7轮: truncation 等特殊参数 =====
  console.log('\n🔍 第7轮: 特殊参数');

  results.push(await test('truncation参数', {
    model: MODEL,
    instructions: 'You are helpful.',
    input: 'say hi',
    max_output_tokens: 20,
    truncation: 'auto',
  }));

  results.push(await test('include参数', {
    model: MODEL,
    instructions: 'You are helpful.',
    input: 'say hi',
    max_output_tokens: 20,
    include: [],
  }));

  results.push(await test('text format', {
    model: MODEL,
    instructions: 'You are helpful.',
    input: 'say hi',
    max_output_tokens: 20,
    text: { format: { type: 'text' } },
  }));

  // ===== 汇总 =====
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 探测结果汇总:');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  if (passed.length > 0) {
    console.log(`\n✅ 成功 (${passed.length}个):`);
    passed.forEach(r => {
      console.log(`   [${r.name}] HTTP ${r.status}`);
      console.log(`   Body: ${JSON.stringify(r.body).substring(0, 200)}`);
    });
  } else {
    console.log('\n❌ 全部失败，分析错误类型:');
    const errors = {};
    failed.forEach(r => {
      const errMsg = typeof r.body === 'object' && r.body ? 
        (r.body.error?.message || r.body.error || JSON.stringify(r.body)) : 
        String(r.body);
      const key = errMsg.substring(0, 80);
      errors[key] = (errors[key] || 0) + 1;
    });
    Object.entries(errors).forEach(([msg, count]) => {
      console.log(`   [x${count}] ${msg}`);
    });
  }
}

main().catch(console.error);
