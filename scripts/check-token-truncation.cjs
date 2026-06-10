const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb');
const buf = fs.readFileSync(dbPath);
const content = buf.toString('latin1');

console.log('=== 检查 token 是否被截断 ===\n');

// 查找 apiKey 字段后面的内容
const keyIndex = content.indexOf('"apiKey"');
if (keyIndex === -1) {
  console.log('✗ 未找到 apiKey 字段');
  process.exit(1);
}

console.log('✓ 找到 apiKey 字段，位置:', keyIndex);

// 提取 apiKey 后面 500 字符
const after = content.slice(keyIndex, keyIndex + 500);
console.log('\napiKey 后面 500 字符:');
console.log(after.replace(/[\x00-\x1f]/g, '·'));

// 尝试手动提取完整 token
const manualMatch = after.match(/"apiKey"\s*:\s*"(devin-session-token\$[^"]+)"/);
if (manualMatch) {
  console.log('\n✓ 手动提取 token:');
  console.log('  长度:', manualMatch[1].length);
  console.log('  完整内容:', manualMatch[1]);
} else {
  console.log('\n✗ 无法提取 token');
}
