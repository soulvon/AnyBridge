const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const template = JSON.parse(fs.readFileSync(__dirname + '/codex-template.json', 'utf-8'));

function call(desc, modifyFn) {
  return new Promise((resolve, reject) => {
    const body = JSON.parse(JSON.stringify(template));
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello in one word' }] }];
    // 每个测试用新 cache_key，避免缓存交叉污染
    body.prompt_cache_key = crypto.randomUUID();
    modifyFn(body);

    const payload = JSON.stringify(body);
    const fields = Object.keys(body).join(', ');

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
          const events = raw.split('\n\n').filter(Boolean);
          let text = '';
          let lastUsage = null;
          let totalCached = 0;
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
                  if (parsed.usage) {
                    lastUsage = parsed.usage;
                    if (parsed.usage.input_tokens_details?.cached_tokens) {
                      totalCached = parsed.usage.input_tokens_details.cached_tokens;
                    }
                  }
                } catch (e) {}
              }
            }
          }
          resolve({ status: 200, text: text.trim(), usage: lastUsage, cached: totalCached, fields, payloadSize: payload.length });
        } else {
          resolve({ status: res.statusCode, error: raw.substring(0, 400), fields, payloadSize: payload.length });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 'ERR', error: e.message, fields, payloadSize: payload.length }));
    req.setTimeout(60000, () => { req.destroy(); resolve({ status: 'TIMEOUT', error: '60s timeout', fields, payloadSize: payload.length }); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('=== AnyRouter 字段必要性综合测试 ===');
  console.log(`模板全部字段: ${Object.keys(template).join(', ')}`);
  console.log(`模板共 ${Object.keys(template).length} 个字段\n`);

  const tests = [];

  // === 阶段1: 单字段删除测试（逐个删除看哪些会 400） ===
  const allFields = Object.keys(template);
  for (const field of allFields) {
    if (field === 'model' || field === 'input') continue; // model和input肯定必须
    tests.push({
      category: '单删',
      name: `去掉「${field}」`,
      fn: (b) => { delete b[field]; }
    });
  }

  // === 阶段2: 组合删除测试 ===
  // 根据阶段1结果，尝试逐步精简
  tests.push({
    category: '组合',
    name: '去掉 instructions+tools',
    fn: (b) => { delete b.instructions; delete b.tools; }
  });
  tests.push({
    category: '组合',
    name: '去掉 instructions+tools+tool_choice',
    fn: (b) => { delete b.instructions; delete b.tools; delete b.tool_choice; }
  });
  tests.push({
    category: '组合',
    name: '去掉 store+include+client_metadata',
    fn: (b) => { delete b.store; delete b.include; delete b.client_metadata; }
  });
  tests.push({
    category: '组合',
    name: '去掉 reasoning+text+parallel_tool_calls',
    fn: (b) => { delete b.reasoning; delete b.text; delete b.parallel_tool_calls; }
  });
  tests.push({
    category: '组合',
    name: '精简版(仅model+input+stream+cache_key)',
    fn: (b) => {
      const keep = ['model', 'input', 'stream', 'prompt_cache_key'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    }
  });
  tests.push({
    category: '组合',
    name: '精简版+store=false',
    fn: (b) => {
      const keep = ['model', 'input', 'stream', 'prompt_cache_key', 'store'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
      b.store = false;
    }
  });
  tests.push({
    category: '组合',
    name: '精简版+include',
    fn: (b) => {
      const keep = ['model', 'input', 'stream', 'prompt_cache_key', 'include'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    }
  });
  tests.push({
    category: '组合',
    name: '精简版+text',
    fn: (b) => {
      const keep = ['model', 'input', 'stream', 'prompt_cache_key', 'text'];
      Object.keys(b).forEach(k => { if (!keep.includes(k)) delete b[k]; });
    }
  });

  // === 阶段3: 完整模板对照组 ===
  tests.unshift({
    category: '对照',
    name: '完整模板(对照组)',
    fn: (b) => {} // 不动
  });

  // === 阶段4: Devin模拟测试 ===
  tests.push({
    category: 'Devin',
    name: 'Devin格式: 只替换instructions',
    fn: (b) => {
      b.instructions = 'You are Devin, an AI coding assistant. Help the user with their programming tasks.';
    }
  });
  tests.push({
    category: 'Devin',
    name: 'Devin格式: 替换instructions+空tools',
    fn: (b) => {
      b.instructions = 'You are Devin, an AI coding assistant.';
      b.tools = [];
    }
  });
  tests.push({
    category: 'Devin',
    name: 'Devin格式: 去掉instructions+tools(干净)',
    fn: (b) => {
      delete b.instructions;
      delete b.tools;
    }
  });

  // === 阶段5: 边界测试 ===
  tests.push({
    category: '边界',
    name: '空include数组',
    fn: (b) => { b.include = []; }
  });
  tests.push({
    category: '边界',
    name: 'include=null',
    fn: (b) => { b.include = null; }
  });
  tests.push({
    category: '边界',
    name: 'stream=false',
    fn: (b) => { b.stream = false; }
  });
  tests.push({
    category: '边界',
    name: 'parallel_tool_calls=false',
    fn: (b) => { b.parallel_tool_calls = false; }
  });
  tests.push({
    category: '边界',
    name: 'client_metadata={}',
    fn: (b) => { b.client_metadata = {}; }
  });
  tests.push({
    category: '边界',
    name: '空reasoning',
    fn: (b) => { b.reasoning = {}; }
  });

  console.log(`共 ${tests.length} 个测试，预计耗时 ${Math.round(tests.length * 3.5 / 60)} 分钟\n`);

  const results = [];
  let idx = 0;
  for (const test of tests) {
    idx++;
    process.stdout.write(`[${idx}/${tests.length}] ${test.name}... `);
    try {
      const r = await call(test.name, test.fn);
      results.push({ ...test, ...r });
      if (r.status === 200) {
        console.log(`✅ 200 | "${r.text}" | ${r.payloadSize}B | cached=${r.cached}`);
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
    console.log(`| # | 测试 | Status | Response | Size | Cached |`);
    console.log(`|---|------|--------|----------|------|--------|`);
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const resp = r.status === 200 ? r.text?.substring(0, 40) || '(empty)' : (r.error || '').substring(0, 50);
      const cached = r.cached || '-';
      console.log(`| ${i+1} | ${r.name} | ${r.status} | "${resp}" | ${r.payloadSize}B | ${cached} |`);
    }
  }

  // 最小可行字段集
  const all200 = results.filter(r => r.status === 200);
  if (all200.length > 0) {
    // 找payload最小的200响应
    const smallest = all200.sort((a, b) => a.payloadSize - b.payloadSize)[0];
    console.log(`\n## 最小可行Payload`);
    console.log(`测试: ${smallest.name}`);
    console.log(`字段: ${smallest.fields}`);
    console.log(`大小: ${smallest.payloadSize}B`);
  }

  const all400s = results.filter(r => r.status === 400);
  if (all400s.length > 0) {
    console.log(`\n## 400错误分析`);
    for (const r of all400s) {
      console.log(`  ❌ ${r.name}: ${r.error?.substring(0, 200)}`);
    }
  }

  console.log('\n\n完成。');
}

main().catch(console.error);
