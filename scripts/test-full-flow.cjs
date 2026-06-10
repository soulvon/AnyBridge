const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb');
const buf = fs.readFileSync(dbPath);
const content = buf.toString('latin1');

console.log('=== 完整测试：模拟 Rust 代码提取逻辑 ===\n');

// 1. 提取 token
const tokenPatterns = [
  /"windsurf\.pendingApiKeyMigration"\s*:\s*"(devin-session-token\$[^"]+)"/,
  /"apiKey"\s*:\s*"(devin-session-token\$[^"]+)"/,
  /"idToken"\s*:\s*"(devin-session-token\$[^"]+)"/,
];

let token = null;
for (const pattern of tokenPatterns) {
  const match = content.match(pattern);
  if (match && match[1]) {
    token = match[1];
    console.log('✓ 找到 token（第一个匹配）');
    console.log('  长度:', token.length);
    console.log('  前 80 字符:', token.slice(0, 80) + '...');
    break;
  }
}

if (!token) {
  console.log('✗ 未找到 token');
  process.exit(1);
}

// 2. 提取 email（第一个匹配）
const emailPattern = /"lastLoginEmail"\s*:\s*"([^"]+)"/;
const emailMatch = content.match(emailPattern);
const email = emailMatch ? emailMatch[1] : null;

console.log('\n✓ 找到 email（第一个匹配）:', email);

// 3. 提取 apiServerUrl
const urlPattern = /"apiServerUrl"\s*:\s*"([^"]+)"/;
const urlMatch = content.match(urlPattern);
const apiServerUrl = urlMatch ? urlMatch[1] : 'https://server.self-serve.windsurf.com';

console.log('✓ API URL:', apiServerUrl);

// 4. 调用 API
console.log('\n=== 调用 GetUserStatus API ===\n');

(async () => {
  try {
    const resp = await fetch(`${apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          apiKey: token,
          ideName: 'windsurf',
          ideVersion: '0.0.0',
          extensionName: 'windsurf-next',
          extensionVersion: '1.0.0',
          locale: 'en',
        },
      }),
    });
    
    console.log('状态码:', resp.status);
    
    if (resp.status === 401) {
      const text = await resp.text();
      console.log('✗ Token 失效 (401)');
      console.log('错误:', text.slice(0, 300));
    } else if (resp.ok) {
      const data = await resp.json();
      const configs = data.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      console.log('✓ API 调用成功！');
      console.log('  账号:', data.userStatus?.email);
      console.log('  套餐:', data.planInfo?.planName);
      console.log('  模型数:', configs.length);
      
      if (email === data.userStatus?.email) {
        console.log('\n✓✓✓ email 匹配成功！Rust 代码逻辑正确！');
      } else {
        console.log(`\n✗ email 不匹配: vscdb=${email}, API=${data.userStatus?.email}`);
      }
    } else {
      const text = await resp.text();
      console.log('✗ API 失败:', text.slice(0, 300));
    }
  } catch (e) {
    console.log('✗ 请求失败:', e.message);
  }
})();
