const https = require('https');
const crypto = require('crypto');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const SESSION_ID = crypto.randomUUID();

const base = {
  hostname: 'anyrouter.top', port: 443, path: '/v1/messages?beta=true', method: 'POST',
  headers: {
    'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY, 'x-api-key': KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'context-1m-2025-08-07',
    'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true'
  },
  rejectUnauthorized: false, timeout: 30000
};

function mkBody(overrides) {
  return {
    model: 'claude-opus-4-8', max_tokens: 64000, stream: true,
    system: [{ type: 'text', text: "You are Claude Code.", cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello in Chinese, one word.', cache_control: { type: 'ephemeral' } }] }],
    metadata: { user_id: JSON.stringify({ device_id: DEVICE_ID, account_uuid: '', session_id: SESSION_ID }) },
    ...overrides
  };
}

function call(desc, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = https.request({ ...base, headers: { ...base.headers, 'Content-Length': payload.length } }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let text = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('data: ')) {
            try { const d = JSON.parse(line.slice(6)); if (d.type==='content_block_delta' && d.delta?.type==='text_delta') text += d.delta.text||''; } catch {}
          }
        }
        resolve({ desc, status: res.statusCode, text: text.trim(), raw: raw.substring(0,200) });
      });
    });
    req.on('error', e => resolve({ desc, status: 'ERR', text: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ desc, status: 'TIMEOUT', text: '' }); });
    req.write(payload); req.end();
  });
}

async function main() {
  const tests = [
    ['对照组', mkBody({})],
    ['去metadata', mkBody({ metadata: undefined })],
    ['去system', mkBody({ system: undefined })],
    ['去metadata+system', mkBody({ metadata: undefined, system: undefined })],
    ['仅model+messages+stream', mkBody({ metadata: undefined, system: undefined, max_tokens: undefined })],
  ];

  for (const [desc, body] of tests) {
    // 清理undefined字段
    Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k]; });
    console.log(`\n>>> ${desc} (字段: ${Object.keys(body).join(', ')})`);
    const r = await call(desc, body);
    console.log(`  状态: ${r.status} | 回复: "${r.text}" | ${JSON.stringify(body).length}B`);
    await new Promise(r => setTimeout(r, 3000));
  }
}
main().catch(console.error);
