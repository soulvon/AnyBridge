const fs = require('fs');
const https = require('https');

const KEY = 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU';
const template = JSON.parse(fs.readFileSync(__dirname + '/codex-template.json', 'utf-8'));

// 只改用户消息
template.input = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello in one word' }] }
];

const payload = JSON.stringify(template);
console.log('Payload size:', payload.length, 'bytes');
console.log('Sending request...');

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
  console.log('Status:', res.statusCode);
  console.log('Headers:', JSON.stringify(res.headers));

  let raw = '';
  res.on('data', (chunk) => {
    raw += chunk.toString();
  });

  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('\n=== SUCCESS ===');
      // 解析 SSE 流
      const events = raw.split('\n\n').filter(Boolean);
      for (const event of events) {
        const lines = event.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6);
            if (data === '[DONE]') {
              console.log('[DONE]');
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'response.output_text.delta' && parsed.delta) {
                process.stdout.write(parsed.delta);
              }
            } catch (e) { /* skip */ }
          }
        }
      }
      console.log('\n=== END ===');
    } else {
      console.log('Response body (first 500):', raw.substring(0, 500));
    }
  });
});

req.on('error', (e) => console.log('Error:', e.message));
req.write(payload);
req.end();