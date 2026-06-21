/**
 * 最小化工作请求 - prompt_cache_key 通过校验后，找最小可成功请求
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
        r({ code: res.statusCode, raw: d, headers: res.headers });
      });
    });
    q.on('error', e => r({ code: 0, raw: e.message }));
    q.write(p); q.end();
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
      try { current.data = JSON.parse(line.substring(6)); } catch (e) { current.data = line.substring(6); }
      events.push({ ...current });
      current = {};
    }
  }
  return events;
}

async function main() {
  console.log('=== 最小化工作请求 ===\n');

  // Test 1: prompt_cache_key + 最简 input
  console.log('[1] prompt_cache_key + 最简(字符串input, stream:true)');
  let r = await req({ model: 'gpt-5.5', prompt_cache_key: 'test', input: 'Say hi', max_output_tokens: 20, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 2: prompt_cache_key + 最简(字符串input, stream:false)  
  console.log('\n[2] prompt_cache_key + 最简(字符串input, stream:false)');
  r = await req({ model: 'gpt-5.5', prompt_cache_key: 'test', input: 'Say hi', max_output_tokens: 20, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 3: prompt_cache_key + 数组input + instructions, stream:true
  console.log('\n[3] prompt_cache_key + 数组input + instructions, stream:true');
  r = await req({ model: 'gpt-5.5', prompt_cache_key: 'test', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], max_output_tokens: 50, stream: true });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);

  // Test 4: prompt_cache_key + 数组input + instructions, stream:false
  console.log('\n[4] prompt_cache_key + 数组input + instructions, stream:false');
  r = await req({ model: 'gpt-5.5', prompt_cache_key: 'test', instructions: 'You are helpful.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }], max_output_tokens: 50, stream: false });
  console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 500)}`);

  // Test 5: prompt_cache_key + 完整 Codex 字段, stream:true
  console.log('\n[5] prompt_cache_key + 完整字段, stream:true');
  r = await req({
    model: 'gpt-5.5', prompt_cache_key: 'test',
    instructions: 'You are a helpful coding assistant.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi in one word' }] }],
    tools: [], tool_choice: 'auto', parallel_tool_calls: true,
    reasoning: { context: 'current_turn', effort: 'medium', summary: null },
    text: { format: { type: 'text' }, verbosity: 'low' },
    temperature: 1.0, top_p: 0.98, max_output_tokens: 50, stream: true,
    store: false, truncation: 'disabled', frequency_penalty: 0.0, presence_penalty: 0.0,
    output: [], metadata: {},
    previous_response_id: null, max_tool_calls: null,
    moderation: null, usage: null, user: null,
    top_logprobs: 0, service_tier: 'auto',
    include: ['reasoning.encrypted_content'],
  });
  if (r.code === 200) {
    const events = parseSSE(r.raw);
    const text = events.filter(e => e.event === 'response.output_text.delta').map(e => e.data?.delta || '').join('');
    console.log(`  ✅ HTTP 200! 响应: ${text}`);
  } else {
    console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);
  }

  // Test 6: 去掉 reasoning, stream:true
  console.log('\n[6] 完整字段 - reasoning, stream:true');
  r = await req({
    model: 'gpt-5.5', prompt_cache_key: 'test',
    instructions: 'You are a helpful coding assistant.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
    tools: [], tool_choice: 'auto',
    text: { format: { type: 'text' }, verbosity: 'low' },
    temperature: 1.0, top_p: 0.98, max_output_tokens: 50, stream: true,
    store: false, truncation: 'disabled',
    output: [], metadata: {},
    include: ['reasoning.encrypted_content'],
  });
  if (r.code === 200) {
    const events = parseSSE(r.raw);
    const text = events.filter(e => e.event === 'response.output_text.delta').map(e => e.data?.delta || '').join('');
    console.log(`  ✅ HTTP 200! 响应: ${text}`);
  } else {
    console.log(`  HTTP ${r.code}: ${r.raw.substring(0, 300)}`);
  }

  console.log('\n=== 完成 ===');
}

main().catch(console.error);