const fs = require('fs');
const crypto = require('crypto');

const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const SESSION_ID = crypto.randomUUID();

// 完整模板（跟测试脚本一致）
const fullBody = {
  model: 'claude-opus-4-8',
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
  system: [
    {
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
      cache_control: { type: 'ephemeral' }
    }
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Say "hello" in Chinese, just one word, nothing else.',
          cache_control: { type: 'ephemeral' }
        }
      ]
    }
  ]
};

const fields = Object.keys(fullBody);
const fullPayload = JSON.stringify(fullBody);

console.log('=== Claude API Body 字段字节统计 ===\n');
console.log(`完整 Payload: ${Buffer.byteLength(fullPayload)} 字节\n`);
console.log('| 字段 | 大小 | 占比 | 内容摘要 |');
console.log('|------|------|------|----------|');

let total = 0;
for (const field of fields) {
  const val = fullBody[field];
  const single = JSON.stringify({ [field]: val });
  const bytes = Buffer.byteLength(single);
  // 减去 2 字节的花括号和  字节的字段名前缀
  const fieldBytes = bytes - Buffer.byteLength('{"' + field + '":') - 1; // -1 for closing }
  const pct = ((fieldBytes / Buffer.byteLength(fullPayload)) * 100).toFixed(1);

  let preview = JSON.stringify(val);
  if (preview.length > 60) preview = preview.substring(0, 60) + '...';

  console.log(`| ${field} | ${fieldBytes}B | ${pct}% | ${preview} |`);
}

// Header 字节统计
console.log('\n=== Header 字节统计 ===\n');

const headers = [
  { key: 'Content-Type', value: 'application/json' },
  { key: 'Authorization', value: 'Bearer sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU' },
  { key: 'x-api-key', value: 'sk-d4Sirq0KQeyX4vCmhWrpI1I0o2XGO1dxRRxrBhETN8blNfUU' },
  { key: 'anthropic-version', value: '2023-06-01' },
  { key: 'anthropic-beta', value: 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24' },
  { key: 'x-app', value: 'cli' },
  { key: 'anthropic-dangerous-direct-browser-access', value: 'true' },
];

let headerTotal = 0;
for (const h of headers) {
  const bytes = Buffer.byteLength(h.key + ': ' + h.value);
  headerTotal += bytes;
  console.log(`  ${h.key}: ${bytes}B  → "${h.value}"`);
}
console.log(`\n  Header 合计: ~${headerTotal}B`);

// 可删字段汇总
console.log('\n=== 优化分析 ===\n');

const removable = [
  { field: 'x-app', bytes: Buffer.byteLength('x-app: cli'), risk: '无' },
  { field: 'dangerous-direct-browser-access', bytes: Buffer.byteLength('anthropic-dangerous-direct-browser-access: true'), risk: '无' },
  { field: 'thinking', bytes: Buffer.byteLength(JSON.stringify({ thinking: { type: 'adaptive' } })) - Buffer.byteLength('{"thinking":') - 1, risk: '低-去掉无思维链' },
  { field: 'output_config', bytes: Buffer.byteLength(JSON.stringify({ output_config: { effort: 'xhigh' } })) - Buffer.byteLength('{"output_config":') - 1, risk: '低-默认effort不是xhigh' },
  { field: 'max_tokens', bytes: Buffer.byteLength(JSON.stringify({ max_tokens: 64000 })) - Buffer.byteLength('{"max_tokens":') - 1, risk: '低-无显式token上限' },
  { field: 'metadata', bytes: Buffer.byteLength(JSON.stringify({ metadata: fullBody.metadata })) - Buffer.byteLength('{"metadata":') - 1, risk: '中-用户标识' },
  { field: 'system', bytes: Buffer.byteLength(JSON.stringify({ system: fullBody.system })) - Buffer.byteLength('{"system":') - 1, risk: '中-客户端指纹' },
];

console.log('| 可删项 | 省字节 | 风险 |');
console.log('|--------|--------|------|');
let safeTotal = 0, riskyTotal = 0;
for (const r of removable) {
  console.log(`| ${r.field} | ${r.bytes}B | ${r.risk} |`);
  if (r.risk === '无') safeTotal += r.bytes;
  else riskyTotal += r.bytes;
}
console.log(`\n  安全可省(x-app+browser-access): ${safeTotal}B`);
console.log(`  中等风险可省(thinking+output_config+max_tokens): ${removable.filter(r => r.risk.startsWith('低')).reduce((a, r) => a + r.bytes, 0)}B`);
console.log(`  高风险可省(metadata+system): ${removable.filter(r => r.risk.startsWith('中')).reduce((a, r) => a + r.bytes, 0)}B`);
