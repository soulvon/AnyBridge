/**
 * 反向二分 - 从完整 BASE 逐个删字段，找最小必需字段
 */
const https = require('https');
const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';

function req(body) {
  return new Promise(r => {
    const p = JSON.stringify(body);
    const q = https.request({
      hostname: 'anyrouter.top', port: 443, path: '/v1/responses', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'originator': 'Codex Desktop',
        'user-agent': 'Codex Desktop/0.142.0-alpha.1 (Windows 10.0.26200; x86_64)',
        'accept': 'text/event-stream',
      },
      rejectUnauthorized: false, timeout: 30000
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        r({ code: res.statusCode, raw: d });
      });
    });
    q.on('error', e => r({ code: 0, raw: e.message }));
    q.write(p); q.end();
  });
}

const FULL = {
  model: 'gpt-5.5',
  prompt_cache_key: 'test',
  instructions: 'You are a helpful coding assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { context: 'current_turn', effort: 'medium', summary: null },
  text: { format: { type: 'text' }, verbosity: 'low' },
  temperature: 1.0,
  top_p: 0.98,
  max_output_tokens: 50,
  stream: true,
  store: false,
  truncation: 'disabled',
  frequency_penalty: 0.0,
  presence_penalty: 0.0,
  output: [],
  metadata: {},
  previous_response_id: null,
  max_tool_calls: null,
  moderation: null,
  usage: null,
  user: null,
  top_logprobs: 0,
  service_tier: 'auto',
  include: ['reasoning.encrypted_content'],
};

function isPass(r) {
  return r.code !== 400 || !r.raw.includes('invalid codex request');
}

function cloneWithout(obj, keys) {
  const c = { ...obj };
  for (const k of keys) delete c[k];
  return c;
}

async function main() {
  console.log('=== 反向二分：删除字段找出最小必需集 ===\n');

  // Baseline: FULL should pass
  console.log('[0] 完整 BASE (对照组)');
  let r = await req(FULL);
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove include
  console.log('[1] -include');
  r = await req(cloneWithout(FULL, ['include']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove service_tier, top_logprobs, user, usage, moderation, max_tool_calls
  console.log('[2] -service_tier, top_logprobs, user, usage, moderation, max_tool_calls');
  r = await req(cloneWithout(FULL, ['service_tier', 'top_logprobs', 'user', 'usage', 'moderation', 'max_tool_calls']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove previous_response_id, metadata, output
  console.log('[3] -previous_response_id, metadata, output');
  r = await req(cloneWithout(FULL, ['previous_response_id', 'metadata', 'output']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove frequency_penalty, presence_penalty
  console.log('[4] -frequency_penalty, presence_penalty');
  r = await req(cloneWithout(FULL, ['frequency_penalty', 'presence_penalty']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove truncation, store
  console.log('[5] -truncation, store');
  r = await req(cloneWithout(FULL, ['truncation', 'store']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove reasoning
  console.log('[6] -reasoning');
  r = await req(cloneWithout(FULL, ['reasoning']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove parallel_tool_calls
  console.log('[7] -parallel_tool_calls');
  r = await req(cloneWithout(FULL, ['parallel_tool_calls']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove tool_choice
  console.log('[8] -tool_choice');
  r = await req(cloneWithout(FULL, ['tool_choice']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove tools
  console.log('[9] -tools');
  r = await req(cloneWithout(FULL, ['tools']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove text
  console.log('[10] -text');
  r = await req(cloneWithout(FULL, ['text']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  // Remove top_p, temperature
  console.log('[11] -top_p, temperature');
  r = await req(cloneWithout(FULL, ['top_p', 'temperature']));
  console.log(`  => ${isPass(r) ? '✅ 通过' : '❌ 失败'} | ${r.raw.substring(0, 150)}`);

  console.log('\n=== 完成 ===');
}

main().catch(console.error);