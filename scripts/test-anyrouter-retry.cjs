const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const template = JSON.parse(fs.readFileSync(__dirname + '/codex-template.json', 'utf-8'));

function call(desc, modifyFn) {
  return new Promise((resolve) => {
    const body = JSON.parse(JSON.stringify(template));
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello in one word' }] }];
    body.prompt_cache_key = crypto.randomUUID();
    modifyFn(body);

    const payload = JSON.stringify(body);

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
      timeout: 60000
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          let text = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ') && line.substring(6) !== '[DONE]') {
              try { const p = JSON.parse(line.substring(6)); text += p.delta || ''; } catch (e) {}
            }
          }
          resolve({ status: 200, text: text.trim(), size: payload.length });
        } else {
          resolve({ status: res.statusCode, error: raw.substring(0, 300), size: payload.length });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 'ERR', error: e.message, size: payload.length }));
    req.setTimeout(60000, () => { req.destroy(); resolve({ status: 'TIMEOUT', size: payload.length }); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('=== 针对性复测（消除500噪声）===\n');

  const tests = [];

  // 1. 重复测"去掉text"3次，看是否稳定复现500
  for (let i = 1; i <= 3; i++) {
    tests.push({
      name: `重测${i}: 去掉text`,
      fn: (b) => { delete b.text; }
    });
  }

  // 2. 确认精简版+include 确实不需要text（重测2次）
  for (let i = 1; i <= 2; i++) {
    tests.push({
      name: `重测${i}: 精简5字段(model+input+stream+include+cache)`,
      fn: (b) => {
        const keep = ['model', 'input', 'stream', 'include', 'prompt_cache_key'];
        Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
      }
    });
  }

  // 3. 精简版+include+text (6字段，验证text可有可无)
  tests.push({
    name: '精简6字段(+text)',
    fn: (b) => {
      const keep = ['model', 'input', 'stream', 'include', 'prompt_cache_key', 'text'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    }
  });

  // 4. 去掉model试试（反向验证model是否必须）
  tests.push({
    name: '去掉model',
    fn: (b) => { delete b.model; }
  });

  // 5. model=空字符串
  tests.push({
    name: 'model=""',
    fn: (b) => { b.model = ''; }
  });

  // 6. 去掉input
  tests.push({
    name: '去掉input',
    fn: (b) => { delete b.input; }
  });

  // 7. 绝对最小: model+input+include+cache (去掉stream)
  tests.push({
    name: '4字段(无stream)',
    fn: (b) => {
      const keep = ['model', 'input', 'include', 'prompt_cache_key'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    }
  });

  // 8. 绝对最小+stream=false
  tests.push({
    name: '4字段+stream=false',
    fn: (b) => {
      const keep = ['model', 'input', 'include', 'prompt_cache_key'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
      b.stream = false;
    }
  });

  console.log(`共 ${tests.length} 个测试\n`);

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    process.stdout.write(`[${i+1}/${tests.length}] ${t.name}... `);
    const r = await call(t.name, t.fn);
    if (r.status === 200) {
      console.log(`✅ 200 | "${r.text}" | ${r.size}B`);
    } else {
      console.log(`❌ ${r.status} | "${(r.error||'').substring(0,100)}" | ${r.size}B`);
    }
    if (i < tests.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n=== 结论 ===');
}

main().catch(console.error);
