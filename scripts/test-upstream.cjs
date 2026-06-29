const https = require('https');

const API_KEY = 'sk-cqweLq7bV2P5'; // Will be read from provider config
const fs = require('fs');
const path = require('path');
const { configDir } = require('./lib/config-dir.cjs');

// Read full API key
const providersFile = path.join(configDir(), 'providers.json');
const data = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
const opencode = data.providers.find(p => p.id === 'p-1782238927068-ipois');
const apiKey = opencode.apiKey;

console.log('Testing OpenCode API directly...');
console.log('URL: https://opencode.ai/zen/go/v1/chat/completions');
console.log('Model: deepseek-v4-flash');
console.log('Stream: true\n');

const body = JSON.stringify({
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'user', content: '你是那个模型' }
  ],
  stream: true,
  stream_options: { include_usage: true }
});

const req = https.request({
  hostname: 'opencode.ai',
  port: 443,
  path: '/zen/go/v1/chat/completions',
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${apiKey}`,
    'content-length': Buffer.byteLength(body)
  }
}, (res) => {
  console.log('Status:', res.statusCode);
  console.log('Content-Type:', res.headers['content-type']);
  console.log('Response headers:', JSON.stringify(res.headers, null, 2));
  
  let chunkCount = 0;
  let firstChunk = null;
  let lastChunk = null;
  let fullBody = '';
  
  res.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    fullBody += text;
    
    // Parse SSE lines
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') {
        console.log('\n[DONE] received');
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        chunkCount++;
        if (chunkCount === 1) firstChunk = parsed;
        lastChunk = parsed;
        
        // Log first 3 chunks
        if (chunkCount <= 3) {
          console.log(`\nChunk ${chunkCount}:`, JSON.stringify(parsed).substring(0, 300));
        }
      } catch (e) {
        // Not JSON, might be non-SSE response
      }
    }
  });
  
  res.on('end', () => {
    console.log('\n=== Summary ===');
    console.log('Total SSE chunks:', chunkCount);
    if (firstChunk) {
      console.log('First chunk keys:', Object.keys(firstChunk));
      const choice = firstChunk.choices?.[0];
      if (choice) {
        console.log('First choice keys:', Object.keys(choice));
        if (choice.delta) console.log('First delta keys:', Object.keys(choice.delta));
      }
    }
    if (lastChunk) {
      console.log('Last chunk keys:', Object.keys(lastChunk));
      if (lastChunk.usage) console.log('Usage:', JSON.stringify(lastChunk.usage));
    }
    
    // If no SSE chunks, show raw response
    if (chunkCount === 0) {
      console.log('\nNo SSE chunks found. Raw response (first 500 chars):');
      console.log(fullBody.substring(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.log('Request error:', e.message);
});

req.write(body);
req.end();
