/**
 * 二分法测试 v2 - 测试 stream:true 的影响
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

async function main() {
  console.log('=== 测试 stream:true 的影响 ===\n');

  // Test 1: stream:true, 最简
  console.log('[1] stream:true, 最简格式');
  let r = await req({ model: 'gpt-5.5', input: 'Say hi', max_output_tokens: 20, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 2: stream:true, + instructions
  console.log('\n[2] stream:true, + instructions');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: 'Say hi', max_output_tokens: 20, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 3: stream:true, input=数组
  console.log('\n[3] stream:true, input=数组');
  r = await req({ model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], max_output_tokens: 20, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 4: stream:true, + instructions + tools + text
  console.log('\n[4] stream:true, + instructions + tools + text');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], tools: [], tool_choice: 'auto', text: { format: { type: 'text' }, verbosity: 'low' }, max_output_tokens: 20, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 5: stream:true, + reasoning
  console.log('\n[5] stream:true, + reasoning');
  r = await req({ model: 'gpt-5.5', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], tools: [], tool_choice: 'auto', parallel_tool_calls: true, reasoning: { context: 'current_turn', effort: 'medium', summary: null }, text: { format: { type: 'text' }, verbosity: 'low' }, max_output_tokens: 20, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 6: stream:true, 所有 null 字段
  console.log('\n[6] stream:true, 全部null字段');
  r = await req({
    model: 'gpt-5.5', instructions: 'You are helpful.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
    tools: [], tool_choice: 'auto', parallel_tool_calls: true,
    reasoning: { context: 'current_turn', effort: 'medium', summary: null },
    text: { format: { type: 'text' }, verbosity: 'low' },
    temperature: 1.0, top_p: 0.98, max_output_tokens: 20, stream: true,
    store: false, truncation: 'disabled', frequency_penalty: 0.0, presence_penalty: 0.0,
    output: [], metadata: {}, previous_response_id: null, max_tool_calls: null,
    moderation: null, usage: null, user: null, top_logprobs: 0, service_tier: 'auto',
    include: ['reasoning.encrypted_content'],
  });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 7: stream:true, + prompt_cache
  console.log('\n[7] stream:true, + prompt_cache');
  r = await req({
    model: 'gpt-5.5', instructions: 'You are helpful.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
    tools: [], tool_choice: 'auto', parallel_tool_calls: true,
    reasoning: { context: 'current_turn', effort: 'medium', summary: null },
    text: { format: { type: 'text' }, verbosity: 'low' },
    temperature: 1.0, top_p: 0.98, max_output_tokens: 20, stream: true,
    store: false, truncation: 'disabled', frequency_penalty: 0.0, presence_penalty: 0.0,
    output: [], metadata: {}, previous_response_id: null, max_tool_calls: null,
    moderation: null, usage: null, user: null, top_logprobs: 0, service_tier: 'auto',
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'test-cache', prompt_cache_retention: '24h',
  });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  console.log('\n=== 完成 ===');
}

main().catch(console.error);