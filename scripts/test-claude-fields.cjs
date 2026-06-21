const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';

// 模拟 Claude Code 设备ID
const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const SESSION_ID = crypto.randomUUID();

// 参考 AnyRouter-claude.html（已验证可用）+ 抓包日志
const template = {
  model: 'claude-opus-4-8',
  max_tokens: 64000,
  stream: true,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'xhigh' },       // HTML用的xhigh,不是high!
  metadata: {
    user_id: JSON.stringify({
      device_id: DEVICE_ID,
      account_uuid: '',
      session_id: SESSION_ID
    })
  },
  system: [
    {
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
      cache_control: { type: 'ephemeral' }
    }
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Say "hello" in Chinese, just one word, nothing else.',
          cache_control: { type: 'ephemeral' }
        }
      ]
    }
  ]
};

// 参考 HTML 文件(已验证)和抓包日志
// HTML beta: claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24
// 抓包beta: ...mid-conversation-system-2026-04-07... (多了这一项)
const fullHeaders = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer ' + KEY,
  'x-api-key': KEY,                         // HTML里有这个!
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24',
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true'
};

function call(desc, modifyBodyFn, modifyHeadersFn) {
  return new Promise((resolve, reject) => {
    const body = JSON.parse(JSON.stringify(template));
    if (modifyBodyFn) modifyBodyFn(body);

    const headers = { ...fullHeaders };
    if (modifyHeadersFn) modifyHeadersFn(headers);

    const payload = JSON.stringify(body);
    const bodyFields = Object.keys(body).join(', ');
    const headerKeys = Object.keys(headers).join(', ');

    headers['Content-Length'] = Buffer.byteLength(payload);

    const opts = {
      hostname: 'anyrouter.top',
      port: 443,
      path: '/v1/messages?beta=true',
      method: 'POST',
      headers: headers,
      rejectUnauthorized: false,
      timeout: 60000
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          // 解析 SSE 流
          let text = '';
          let thinking = '';
          let usage = null;
          const events = raw.split('\n\n').filter(Boolean);
          for (const event of events) {
            for (const line of event.split('\n')) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.type === 'content_block_delta') {
                    if (parsed.delta?.type === 'text_delta') {
                      text += parsed.delta.text || '';
                    } else if (parsed.delta?.type === 'thinking_delta') {
                      thinking += parsed.delta.thinking || '';
                    }
                  }
                  if (parsed.type === 'message_delta' && parsed.usage) {
                    usage = parsed.usage;
                  }
                  if (parsed.usage && !usage) {
                    usage = parsed.usage;
                  }
                } catch (e) {}
              }
            }
          }
          resolve({
            status: 200,
            text: text.trim() || '(thinking only, ' + thinking.length + ' chars)',
            usage: usage,
            bodyFields,
            headerKeys,
            payloadSize: payload.length
          });
        } else {
          resolve({
            status: res.statusCode,
            error: raw.substring(0, 400),
            bodyFields,
            headerKeys,
            payloadSize: payload.length
          });
        }
      });
    });
    req.on('error', (e) => resolve({
      status: 'ERR',
      error: e.message,
      bodyFields,
      headerKeys,
      payloadSize: payload.length
    }));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ status: 'TIMEOUT', error: '60s timeout', bodyFields, headerKeys, payloadSize: payload.length });
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('=== Claude API 字段精简测试 ===');
  console.log(`模板全部 Body 字段: ${Object.keys(template).join(', ')}`);
  console.log(`模板共 ${Object.keys(template).length} 个 Body 字段`);
  console.log(`模板 Headers: ${Object.keys(fullHeaders).join(', ')}\n`);

  const tests = [];

  // === 阶段1: 对照组 ===
  tests.push({
    category: '对照',
    name: '完整模板(对照组)',
    bodyFn: (b) => {},
    headerFn: (h) => {}
  });

  // === 阶段2: 单字段删除 ===
  const bodyFields = Object.keys(template);
  for (const field of bodyFields) {
    if (field === 'model' || field === 'messages' || field === 'stream') continue;
    tests.push({
      category: '单删Body',
      name: `去掉「${field}」`,
      bodyFn: (b) => { delete b[field]; },
      headerFn: (h) => {}
    });
  }

  // === 阶段3: 单 Header 测试 ===
  const testHeaders = ['anthropic-beta', 'x-app', 'anthropic-dangerous-direct-browser-access'];
  for (const h of testHeaders) {
    tests.push({
      category: '单删Header',
      name: `去掉 Header「${h}」`,
      bodyFn: (b) => {},
      headerFn: (headers) => { delete headers[h]; }
    });
  }

  // === 阶段4: anthropic-beta 精简测试 ===
  tests.push({
    category: 'Header变体',
    name: '精简beta: 仅claude-code-20250219',
    bodyFn: (b) => {},
    headerFn: (headers) => {
      headers['anthropic-beta'] = 'claude-code-20250219';
    }
  });
  tests.push({
    category: 'Header变体',
    name: '精简beta: 仅context-1m-2025-08-07',
    bodyFn: (b) => {},
    headerFn: (headers) => {
      headers['anthropic-beta'] = 'context-1m-2025-08-07';
    }
  });
  tests.push({
    category: 'Header变体',
    name: '精简beta: 仅effort-2025-11-24',
    bodyFn: (b) => {},
    headerFn: (headers) => {
      headers['anthropic-beta'] = 'effort-2025-11-24';
    }
  });

  // === 阶段5: 组合删除 ===
  tests.push({
    category: '组合',
    name: '去掉 thinking+output_config',
    bodyFn: (b) => { delete b.thinking; delete b.output_config; },
    headerFn: (h) => {}
  });
  tests.push({
    category: '组合',
    name: '去掉 thinking+output_config+metadata',
    bodyFn: (b) => { delete b.thinking; delete b.output_config; delete b.metadata; },
    headerFn: (h) => {}
  });
  tests.push({
    category: '组合',
    name: '最精简: model+messages+stream 仅3字段',
    bodyFn: (b) => {
      const keep = ['model', 'messages', 'stream'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    },
    headerFn: (h) => {}
  });
  tests.push({
    category: '组合',
    name: '最精简 + 去掉所有可选Header',
    bodyFn: (b) => {
      const keep = ['model', 'messages', 'stream'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    },
    headerFn: (headers) => {
      delete headers['anthropic-beta'];
      delete headers['x-app'];
      delete headers['anthropic-dangerous-direct-browser-access'];
    }
  });

  console.log(`共 ${tests.length} 个测试，预计耗时 ${Math.round(tests.length * 3.5 / 60)} 分钟\n`);

  const results = [];
  let idx = 0;
  for (const test of tests) {
    idx++;
    process.stdout.write(`[${idx}/${tests.length}] ${test.name}... `);
    try {
      const r = await call(test.name, test.bodyFn, test.headerFn);
      results.push({ ...test, ...r });
      if (r.status === 200) {
        const usageStr = r.usage ? ` in=${r.usage.input_tokens} out=${r.usage.output_tokens}` : '';
        console.log(`✅ 200 | "${(r.text || '').substring(0, 50)}" | ${r.payloadSize}B${usageStr}`);
      } else {
        console.log(`❌ ${r.status} | "${(r.error || '').substring(0, 80)}" | ${r.payloadSize}B`);
      }
    } catch (e) {
      results.push({ ...test, status: 'EXCEPTION', error: e.message });
      console.log(`❌ EXCEPTION: ${e.message}`);
    }
    // 间隔3秒
    if (idx < tests.length) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // === 汇总报告 ===
  console.log('\n\n' + '='.repeat(80));
  console.log('=== 汇总报告 ===');
  console.log('='.repeat(80));

  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) categories[r.category] = [];
    categories[r.category].push(r);
  }

  for (const [cat, items] of Object.entries(categories)) {
    console.log(`\n## ${cat}`);
    console.log(`| # | 测试 | Status | Response | Size |`);
    console.log(`|---|------|--------|----------|------|`);
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const resp = r.status === 200
        ? (r.text || '').substring(0, 40) || '(empty)'
        : (r.error || '').substring(0, 50);
      console.log(`| ${i + 1} | ${r.name} | ${r.status} | "${resp}" | ${r.payloadSize}B |`);
    }
  }

  // 最小可行字段集
  const all200 = results.filter(r => r.status === 200);
  if (all200.length > 0) {
    const smallest = all200.sort((a, b) => a.payloadSize - b.payloadSize)[0];
    console.log(`\n## 最小可行Payload`);
    console.log(`测试: ${smallest.name}`);
    console.log(`Body字段: ${smallest.bodyFields}`);
    console.log(`Header字段: ${smallest.headerKeys}`);
    console.log(`大小: ${smallest.payloadSize}B`);
  }

  const allErrors = results.filter(r => r.status !== 200 && r.status !== 'TIMEOUT' && r.status !== 'ERR');
  if (allErrors.length > 0) {
    console.log(`\n## 错误分析`);
    for (const r of allErrors) {
      console.log(`  ❌ ${r.name}: ${r.status} - ${r.error?.substring(0, 200)}`);
    }
  }

  console.log('\n完成。');
}

main().catch(console.error);
