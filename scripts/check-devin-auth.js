// 检查 Devin 登录态
import fs from 'fs';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb');

if (!fs.existsSync(dbPath)) {
  console.error('❌ Devin state.vscdb 不存在');
  process.exit(1);
}

const buf = fs.readFileSync(dbPath);
const content = buf.toString('latin1');

console.log('=== 搜索所有 devin-session-token ===\n');

// 搜索所有可能的 token
const allMatches = content.match(/devin-session-token\$[A-Za-z0-9._-]{50,}/g);

if (allMatches && allMatches.length > 0) {
  console.log(`找到 ${allMatches.length} 个 token:\n`);
  allMatches.forEach((token, i) => {
    console.log(`${i + 1}. ${token.slice(0, 80)}...`);
  });
} else {
  console.log('❌ 未找到任何 devin-session-token');
}

console.log('\n=== 搜索 email ===\n');
const emails = content.match(/"lastLoginEmail"\s*:\s*"([^"]+)"/g);
if (emails) {
  emails.forEach(e => console.log(e));
} else {
  console.log('未找到 email');
}

console.log('\n=== 搜索 windsurfAuthStatus ===\n');
const authStatusMatch = content.match(/"windsurfAuthStatus"/);
if (authStatusMatch) {
  console.log('✓ 找到 windsurfAuthStatus 字段');
  
  // 提取完整的 JSON
  const jsonStart = content.indexOf('{', authStatusMatch.index);
  if (jsonStart > 0) {
    let depth = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    
    try {
      const jsonStr = content.slice(jsonStart, jsonEnd);
      const data = JSON.parse(jsonStr);
      
      if (data.userStatusProtoBinaryBase64) {
        console.log('✓ 找到 userStatusProtoBinaryBase64（Base64 protobuf 数据）');
        console.log('  长度:', data.userStatusProtoBinaryBase64.length);
      }
      
      if (data.allowedCommandModelConfigs) {
        console.log('✓ 找到 allowedCommandModelConfigs');
        console.log('  模型数:', data.allowedCommandModelConfigs.length);
        console.log('\n  前 5 个:');
        data.allowedCommandModelConfigs.slice(0, 5).forEach((m, i) => {
          console.log(`    ${i + 1}. ${m.label || m.modelUid} (${m.modelUid})`);
        });
      }
      
      if (data.planInfo) {
        console.log('\n✓ 账号信息:');
        console.log('  套餐:', data.planInfo.planName);
        console.log('  邮箱:', data.userStatus?.email);
      }
    } catch (e) {
      console.log('解析 JSON 失败:', e.message);
    }
  }
} else {
  console.log('❌ 未找到 windsurfAuthStatus');
}
