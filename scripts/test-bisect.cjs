/**
 * 二分法测试 - 定位 AnyRouter 校验的关键字段
 * 用法: node scripts/test-bisect.cjs
 */
const https = require('https');
const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';

const CODE_BASE = {
  model: 'gpt-5.5',
  instructions: 'You are a helpful coding assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi in one word' }] }],
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { context: 'current_turn', effort: 'medium', summary: null },
  text: { format: { type: 'text' }, verbosity: 'low' },
  temperature: 1.0,
  top_p: 0.98,
  max_output_tokens: 50,
  stream: false,
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

async function main() {
  console.log('=== 二分法测试 AnyRouter 校验字段 ===\n');

  // Test 1: 最简 baseline
  console.log('[1] baseline: 最简格式');
  let r = await req({ model: 'gpt-5.5', input: 'Say hi', max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);
  const baselineOk = r.code === 200;

  // Test 2: 只加 instructions
  console.log('\n[2] + instructions');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: 'Say hi', max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 3: 只用 input 数组格式
  console.log('\n[3] input=数组 (无instructions)');
  r = await req({ model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 4: input=数组 + instructions
  console.log('\n[4] input=数组 + instructions');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 5: + tools=[]
  console.log('\n[5] + tools=[]');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], tools: [], max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 6: + tool_choice, parallel_tool_calls
  console.log('\n[6] + tool_choice + parallel_tool_calls');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], tools: [], tool_choice: 'auto', parallel_tool_calls: true, max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 7: + reasoning
  console.log('\n[7] + reasoning');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], tools: [], tool_choice: 'auto', parallel_tool_calls: true, reasoning: { context: 'current_turn', effort: 'medium', summary: null }, text: { format: { type: 'text' }, verbosity: 'low' }, max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 8: + text config
  console.log('\n[8] + text format');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], tools: [], tool_choice: 'auto', parallel_tool_calls: true, reasoning: { context: 'current_turn', effort: 'medium', summary: null }, text: { format: { type: 'text' }, verbosity: 'low' }, temperature: 1.0, top_p: 0.98, max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 9: + 全部 null/empty 字段
  console.log('\n[9] + 全部 null/empty 字段 (store, truncation, etc.)');
  r = await req({ ...CODE_BASE });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 10: + tool_usage
  console.log('\n[10] + tool_usage');
  const b10 = { ...CODE_BASE };
  b10.tool_usage = { image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 }, output_tokens: 0, output_tokens_details: { image_tokens: 0, text_tokens: 0 }, total_tokens: 0 }, web_search: { num_requests: 0 } };
  r = await req(b10);
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 11: + safety_identifier
  console.log('\n[11] + safety_identifier');
  const b11 = { ...CODE_BASE };
  b11.safety_identifier = 'user-test123';
  r = await req(b11);
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  // Test 12: + prompt_cache
  console.log('\n[12] + prompt_cache_key + prompt_cache_retention');
  const b12 = { ...CODE_BASE };
  b12.prompt_cache_key = 'test-cache';
  b12.prompt_cache_retention = '24h';
  r = await req(b12);
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 200)}`);

  console.log('\n=== 完成 ===');
}

main().catch(console.error);