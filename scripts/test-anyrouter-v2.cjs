/**
 * AnyRouter gpt-5.5 完整测试 - 完全匹配 Codex 请求格式
 */
const https = require('https');
const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';

function req(body) {
  return new Promise(r => {
    const p = JSON.stringify(body);
    const q = https.request({
      hostname:'anyrouter.top', port:443, path:'/v1/responses', method:'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization':'Bearer '+KEY,
        'originator': 'Codex Desktop',
        'user-agent': 'Codex Desktop/0.142.0-alpha.1 (Windows 10.0.26200; x86_64)',
        'accept': 'text/event-stream',
      },
      rejectUnauthorized:false, timeout:60000
    }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        r({ code: res.statusCode, raw: d });
      });
    });
    q.on('error',e=>r({code:0,raw:e.message}));
    q.write(p); q.end();
  });
}

async function main() {
  // 完全匹配 Codex 请求体, 逐步添加字段测试
  const bodies = [
    {
      name: 'base + max_output_tokens=null + output=[] + metadata',
      body: {
        model: 'gpt-5.5',
        instructions: 'You are helpful. Reply short.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { context: 'current_turn', effort: 'medium', summary: null },
        text: { format: { type: 'text' }, verbosity: 'low' },
        temperature: 1.0,
        top_p: 0.98,
        max_output_tokens: null,
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
      }
    },
    {
      name: '+ tool_usage + safety_identifier + prompt_cache',
      body: {
        model: 'gpt-5.5',
        instructions: 'You are helpful. Reply short.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { context: 'current_turn', effort: 'medium', summary: null },
        text: { format: { type: 'text' }, verbosity: 'low' },
        temperature: 1.0,
        top_p: 0.98,
        max_output_tokens: null,
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
        tool_usage: {
          image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 }, output_tokens: 0, output_tokens_details: { image_tokens: 0, text_tokens: 0 }, total_tokens: 0 },
          web_search: { num_requests: 0 }
        },
        safety_identifier: 'user-test123',
        prompt_cache_key: 'test-cache',
        prompt_cache_retention: '24h',
      }
    },
  ];

  for (const { name, body } of bodies) {
    console.log(`[${name}]`);
    const r = await req(body);
    console.log('HTTP ' + r.code);
    if (r.code === 200) {
      const lines = r.raw.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.substring(6));
            if (d.type === 'response.output_text.delta' && d.delta) {
              process.stdout.write(d.delta);
            }
          } catch(e) {}
        }
      }
      console.log('');
    } else {
      console.log(r.raw.substring(0, 300));
    }
    console.log('');
  }
}
main().catch(console.error);