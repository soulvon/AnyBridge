const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb');
const buf = fs.readFileSync(dbPath);
const content = buf.toString('latin1');

console.log('=== 测试：提取最后一个 lastLoginEmail ===\n');

const pattern = /"lastLoginEmail"\s*:\s*"([^"]+)"/g;
const matches = [...content.matchAll(pattern)];

console.log(`找到 ${matches.length} 个 lastLoginEmail:\n`);

matches.forEach((m, i) => {
  console.log(`${i + 1}. ${m[1]}`);
});

if (matches.length > 0) {
  const lastEmail = matches[matches.length - 1][1];
  console.log(`\n最后一个（应该是当前账号）: ${lastEmail}`);
  console.log(`预期: kjtrkxi31562@gmail.com`);
  console.log(`结果: ${lastEmail === 'kjtrkxi31562@gmail.com' ? '✓ 正确' : '✗ 错误'}`);
}
