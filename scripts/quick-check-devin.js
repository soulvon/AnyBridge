const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb');
const buf = fs.readFileSync(dbPath);
const content = buf.toString('latin1');

const emailMatch = content.match(/"lastLoginEmail"\s*:\s*"([^"]+)"/);
console.log('当前登录账号:', emailMatch ? emailMatch[1] : '未找到');

const tokenMatch = content.match(/"(?:windsurf|devin)\.pendingApiKeyMigration"\s*:\s*"(devin-session-token\$[^"]{50,100})/);
if (tokenMatch) {
  console.log('Token 前缀:', tokenMatch[1].slice(0, 80) + '...');
} else {
  console.log('未找到 session token');
}
