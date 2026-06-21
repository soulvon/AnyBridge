const https = require('https');
const crypto = require('crypto');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const MODELS = ['claude-opus-4-8[1m]', 'claude-opus-4-7', 'claude-opus-4-8'];

const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const SESSION_ID = crypto.randomUUID();

function callModel(model) {
  return new Promise((resolve) => {
    const body = {
      model,
      max_tokens: 64000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      metadata: {
        user_id: JSON.stringify({
          device_id: DEVICE_ID,
          account_uuid: '',
          session_id: SESSION_ID
        })
      },
      system: [{
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'Say hello in Chinese, one word only.',
          cache_control: { type: 'ephemeral' }
        }]
      }]
    };

    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'anyrouter.top', port: 443,
      path: '/v1/messages?beta=true', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24',
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      rejectUnauthorized: false, timeout: 30000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let text = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta')
                text += d.delta.text || '';
            } catch {}
          }
        }
        resolve({ model, status: res.statusCode, text: text.trim() || '(empty)', raw: raw.substring(0, 200) });
      });
    });
    req.on('error', (e) => resolve({ model, status: 'ERR', text: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ model, status: 'TIMEOUT', text: '' }); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  for (const m of MODELS) {
    console.log(`\n>>> 测试模型: ${m}`);
    const r = await callModel(m);
    console.log(`  状态: ${r.status} | 回复: "${r.text}" | 原始: ${r.raw}`);
    if (r.status === 200) { console.log('  ✅ 成功了!'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
}
main().catch(console.error);
