// 测试 refresh_ide_models 命令（Devin）
import fs from 'fs';
import path from 'path';
import os from 'os';

// 读取 Devin 的 state.vscdb
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb');

if (!fs.existsSync(dbPath)) {
  console.error('❌ Devin state.vscdb 不存在:', dbPath);
  process.exit(1);
}

console.log('✓ Devin state.vscdb 存在');
console.log('路径:', dbPath);
console.log('大小:', (fs.statSync(dbPath).size / 1024).toFixed(2), 'KB');

// 读取并查找 session token
const buf = fs.readFileSync(dbPath);
const content = buf.toString('latin1');

// 搜索 session token
const patterns = [
  /"devin\.pendingApiKeyMigration"\s*:\s*"(devin-session-token\$[^"]+)"/,
  /"apiKey"\s*:\s*"(devin-session-token\$[^"]+)"/,
  /"idToken"\s*:\s*"(devin-session-token\$[^"]+)"/,
];

let token = null;
for (const pat of patterns) {
  const m = content.match(pat);
  if (m && m[1]) {
    token = m[1];
    break;
  }
}

if (!token) {
  console.error('❌ 未找到 devin-session-token');
  process.exit(1);
}

console.log('✓ 找到 session token:', token.slice(0, 50) + '...');

// 搜索 email
const emailMatch = content.match(/"lastLoginEmail"\s*:\s*"([^"]+)"/);
const email = emailMatch ? emailMatch[1] : 'unknown';
console.log('✓ 邮箱:', email);

// 搜索 apiServerUrl
const urlMatch = content.match(/"apiServerUrl"\s*:\s*"([^"]+)"/);
const apiServerUrl = urlMatch ? urlMatch[1] : 'https://server.codeium.com';
console.log('✓ API 地址:', apiServerUrl);

// 调用 GetUserStatus
console.log('\n开始调用 GetUserStatus...');
const url = `${apiServerUrl.replace(/\/$/, '')}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;

const body = {
  metadata: {
    apiKey: token,
    ideName: 'devin',
    ideVersion: '0.0.0',
    extensionName: 'devin',
    extensionVersion: '1.0.0',
    locale: 'en',
  },
};

try {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  console.log('状态码:', resp.status);
  
  if (!resp.ok) {
    const text = await resp.text();
    console.error('❌ API 返回错误:', text.slice(0, 200));
    process.exit(1);
  }

  const data = await resp.json();
  
  const planName = data.planInfo?.planName || 'Unknown';
  const userEmail = data.userStatus?.email || 'unknown';
  const clientConfigs = data.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  
  console.log('\n✓ API 调用成功!');
  console.log('账号:', userEmail);
  console.log('套餐:', planName);
  console.log('clientModelConfigs 数量:', clientConfigs.length);
  
  if (clientConfigs.length > 0) {
    console.log('\n前 5 个模型:');
    clientConfigs.slice(0, 5).forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.label || m.modelUid} (${m.modelUid})`);
    });
  }
  
} catch (e) {
  console.error('❌ 请求失败:', e.message);
  process.exit(1);
}
