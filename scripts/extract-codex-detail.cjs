/**
 * 提取 Codex 请求的关键字段详情
 */
const fs = require('fs');

const log = fs.readFileSync('logs/sniffer-2026-06-19T14-53-47.log', 'utf-8');
const lines = log.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('--- Request Body ---')) {
    try {
      const b = JSON.parse(lines[i + 1]);
      console.log('=== client_metadata ===');
      console.log(JSON.stringify(b.client_metadata, null, 2));
      console.log('\n=== tools 类型列表 ===');
      b.tools.forEach((t, idx) => {
        const name = t.name || t.type || 'unknown';
        console.log('  [' + idx + '] ' + name);
      });
      console.log('\n=== tools[0] 完整定义 ===');
      console.log(JSON.stringify(b.tools[0], null, 2).substring(0, 500));
      console.log('\n=== reasoning ===');
      console.log(JSON.stringify(b.reasoning));
      console.log('\n=== text ===');
      console.log(JSON.stringify(b.text));
      console.log('\n=== include ===');
      console.log(JSON.stringify(b.include));
      console.log('\n=== prompt_cache_key ===');
      console.log(b.prompt_cache_key);
      console.log('\n=== store ===');
      console.log(b.store);
      console.log('\n=== input[0] 结构 ===');
      console.log(JSON.stringify(b.input[0], null, 2).substring(0, 500));
      break;
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  }
}
