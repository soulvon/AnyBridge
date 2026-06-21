const fs = require('fs');
const log = fs.readFileSync(__dirname + '/../logs/sniffer-2026-06-19T14-53-47.log', 'utf-8');
const lines = log.split('\n');

// 找第一个成功的响应体
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('--- Response Body ---')) {
    const bodyLine = lines[i + 1];
    if (!bodyLine || bodyLine.length < 50) continue;
    
    console.log('Body length:', bodyLine.length);
    
    // 搜索 usage
    const usageIdx = bodyLine.indexOf('"usage"');
    if (usageIdx > 0) {
      console.log('\n=== Usage section ===');
      console.log(bodyLine.substring(usageIdx, usageIdx + 300));
    }
    
    // 搜索 cached
    const cacheIdx = bodyLine.indexOf('"cached"');
    if (cacheIdx > 0) {
      console.log('\n=== Cache section ===');
      console.log(bodyLine.substring(cacheIdx, cacheIdx + 200));
    }

    // 搜索 input_tokens
    const inputIdx = bodyLine.indexOf('"input_tokens"');
    if (inputIdx > 0) {
      console.log('\n=== Near input_tokens ===');
      console.log(bodyLine.substring(Math.max(0, inputIdx - 50), inputIdx + 200));
    }

    // 最后 800 字符
    console.log('\n=== Last 800 chars ===');
    console.log(bodyLine.substring(Math.max(0, bodyLine.length - 800)));
    break;
  }
}