/**
 * 精确定位 - 逐个测试哪个字段让格式校验通过
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

const BASE = {
  model: 'gpt-5.5',
  instructions: 'You are a helpful coding assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { context: 'current_turn', effort: 'medium', summary: null },
  text: { format: { type: 'text' }, verbosity: 'low' },
  temperature: 1.0, top_p: 0.98,
  max_output_tokens: 50, stream: true,
  store: false, truncation: 'disabled',
  frequency_penalty: 0.0, presence_penalty: 0.0,
  output: [], metadata: {},
  previous_response_id: null, max_tool_calls: null,
  moderation: null, usage: null, user: null,
  top_logprobs: 0, service_tier: 'auto',
  include: ['reasoning.encrypted_content'],
};

function isPass(r) {
  return r.code !== 400 || !r.raw.includes('invalid codex request');
}

async function main() {
  console.log('=== 精确定位校验关键字段 ===\n');

  // 1. 只有 prompt_cache_key
  console.log('[1] 只有 prompt_cache_key');
  let r = await req({ ...BASE, prompt_cache_key: 'test' });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 2. 只有 prompt_cache_retention
  console.log('[2] 只有 prompt_cache_retention');
  r = await req({ ...BASE, prompt_cache_retention: '24h' });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 3. prompt_cache_key + prompt_cache_retention
  console.log('[3] prompt_cache_key + prompt_cache_retention');
  r = await req({ ...BASE, prompt_cache_key: 'test', prompt_cache_retention: '24h' });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 4. 只有 safety_identifier
  console.log('[4] 只有 safety_identifier');
  r = await req({ ...BASE, safety_identifier: 'user-test' });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 5. 只有 tool_usage
  console.log('[5] 只有 tool_usage');
  r = await req({ ...BASE, tool_usage: { image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 }, output_tokens: 0, output_tokens_details: { image_tokens: 0, text_tokens: 0 }, total_tokens: 0 }, web_search: { num_requests: 0 } } });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 6. 带真实 tool 定义 (web_search_preview)
  console.log('[6] 真实 tool 定义 (web_search_preview)');
  r = await req({ ...BASE, tools: [{ type: 'web_search_preview', user_location: { type: 'approximate' }, search_context_size: 'medium' }] });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 7. 长 instructions
  console.log('[7] 长 instructions (500+ chars)');
  r = await req({ ...BASE, instructions: 'You are a helpful coding assistant. '.repeat(30) });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  // 8. prompt_cache_key + 长 instructions
  console.log('[8] prompt_cache_key + 长 instructions');
  r = await req({ ...BASE, prompt_cache_key: 'test', instructions: 'You are a helpful coding assistant. '.repeat(30) });
  console.log(`  HTTP ${r.code}: ${isPass(r) ? '✅ 校验通过' : '❌ invalid codex request'} | ${r.raw.substring(0, 150)}`);

  console.log('\n=== 完成 ===');
}

main().catch(console.error);