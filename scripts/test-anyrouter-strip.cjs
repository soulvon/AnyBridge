const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const template = JSON.parse(fs.readFileSync(__dirname + '/codex-template.json', 'utf-8'));

function call(desc, modifyFn) {
  return new Promise((resolve, reject) => {
    const body = JSON.parse(JSON.stringify(template));
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello in one word' }] }];
    modifyFn(body);

    const payload = JSON.stringify(body);
    console.log(`\n[${desc}]`);
    console.log(`  Payload: ${payload.length} bytes | Fields: ${Object.keys(body).join(', ')}`);

    const opts = {
      hostname: 'anyrouter.top',
      port: 443,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'Content-Length': Buffer.byteLength(payload),
        'accept': 'text/event-stream',
        'user-agent': 'Codex Desktop/0.142.0-alpha.1',
        'originator': 'Codex Desktop',
      },
      rejectUnauthorized: false,
      timeout: 30000
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const events = raw.split('\n\n').filter(Boolean);
          let text = '';
          let lastUsage = null;
          for (const event of events) {
            for (const line of event.split('\n')) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6);
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.type === 'response.output_text.delta' && parsed.delta) {
                    text += parsed.delta;
                  }
                  if (parsed.usage) lastUsage = parsed.usage;
                } catch (e) {}
              }
            }
          }
          resolve({ status: 200, text: text.trim(), usage: lastUsage });
        } else {
          resolve({ status: res.statusCode, error: raw.substring(0, 300) });
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('=== AnyRouter 字段必要性测试 ===');
  console.log('测试账号: 小号, 6个场景, 每次间隔3秒\n');

  const tests = [
    {
      name: '1.完整模板（对照组）',
      fn: (b) => {} // 不改任何东西
    },
    {
      name: '2.去掉 instructions',
      fn: (b) => {
        delete b.instructions;
        b.prompt_cache_key = crypto.randomUUID(); // 换新Key避免污染缓存
      }
    },
    {
      name: '3.去掉 tools',
      fn: (b) => {
        delete b.tools;
        b.prompt_cache_key = crypto.randomUUID();
      }
    },
    {
      name: '4.去掉 instructions + tools',
      fn: (b) => {
        delete b.instructions;
        delete b.tools;
        b.prompt_cache_key = crypto.randomUUID();
      }
    },
    {
      name: '5.去掉 tool_choice',
      fn: (b) => {
        delete b.tool_choice;
        b.prompt_cache_key = crypto.randomUUID();
      }
    },
    {
      name: '6.最小结构（model+input+cache_key+stream）',
      fn: (b) => {
        const keep = ['model', 'input', 'prompt_cache_key', 'stream'];
        Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
        b.prompt_cache_key = crypto.randomUUID();
      }
    },
  ];

  const results = [];
  for (const test of tests) {
    try {
      const r = await call(test.name, test.fn);
      results.push({ ...test, ...r });
      console.log(`  → Status: ${r.status} | Response: "${r.text || r.error}"`);
      if (r.usage) {
        console.log(`  → Usage: input=${r.usage.input_tokens}, output=${r.usage.output_tokens}`);
      }
    } catch (e) {
      results.push({ ...test, status: 'ERR', error: e.message });
      console.log(`  → Error: ${e.message}`);
    }
    // 间隔3秒，模拟正常对话频率
    if (tests.indexOf(test) < tests.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('\n\n=== 汇总 ===');
  console.log('| 测试 | Status | Response |');
  console.log('|------|--------|----------|');
  for (const r of results) {
    console.log(`| ${r.name} | ${r.status} | "${(r.text || r.error || '').substring(0, 60)}" |`);
  }

  console.log('\n完成。');
}

main().catch(console.error);
