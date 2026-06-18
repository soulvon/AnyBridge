// scripts/find_real_image_request.cjs — 查找真正的图片上传请求
// 排除工具调用和代码内容，只找用户上传的图片

const fs = require('fs');
const path = require('path');
const os = require('os');

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(os.homedir(), 'AppData', 'Roaming', name);
}

const LOG_DIR = path.join(configDir(), 'mitm-logs');

// 检查最近几天的日志
const today = new Date();
const dates = [];
for (let i = 0; i < 7; i++) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  dates.push(d.toISOString().slice(0, 10));
}

console.log(`🔍 搜索最近 7 天的图片上传请求...\n`);

let foundCount = 0;

for (const date of dates) {
  const logPath = path.join(LOG_DIR, `mitm-${date}.jsonl`);
  if (!fs.existsSync(logPath)) continue;
  
  console.log(`📅 检查 ${date}...`);
  
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      
      if (record.direction !== 'upstream') continue;
      
      const body = record.request?.body || '';
      if (typeof body !== 'string') continue;
      
      // 寻找图片特征
      if (!body.includes('image')) continue;
      
      try {
        const payload = JSON.parse(body);
        
        // 检查 messages 中是否有 image_url 或 image 类型的 content block
        if (payload.messages && Array.isArray(payload.messages)) {
          for (const msg of payload.messages) {
            if (msg.role !== 'user') continue;
            if (!Array.isArray(msg.content)) continue;
            
            for (const block of msg.content) {
              // OpenAI 格式: { type: "image_url", image_url: { url: "..." } }
              if (block.type === 'image_url' && block.image_url) {
                const url = block.image_url.url || block.image_url;
                if (typeof url === 'string' && url.startsWith('data:image')) {
                  foundCount++;
                  console.log(`\n✅ 找到图片请求 #${foundCount}`);
                  console.log(`   时间: ${record.ts}`);
                  console.log(`   供应商: ${record.providerName} (${record.format})`);
                  console.log(`   模型: ${record.model}`);
                  
                  const match = url.match(/^data:([^;]+);base64,(.+)$/);
                  if (match) {
                    console.log(`   MIME: ${match[1]}`);
                    console.log(`   大小: ${(match[2].length * 0.75 / 1024).toFixed(1)} KB`);
                  }
                  
                  // 导出第一个找到的
                  if (foundCount === 1) {
                    const output = {
                      timestamp: record.ts,
                      provider: record.providerName,
                      model: record.model,
                      format: record.format,
                      payload: payload,
                    };
                    fs.writeFileSync('scripts/_real_image_request.json', JSON.stringify(output, null, 2), 'utf8');
                    console.log(`   💾 已导出到: scripts/_real_image_request.json`);
                  }
                  
                  if (foundCount >= 5) break;
                }
              }
              
              // Anthropic 格式: { type: "image", source: { type: "base64", ... } }
              if (block.type === 'image' && block.source) {
                foundCount++;
                console.log(`\n⚠️  找到 Anthropic 格式图片 #${foundCount}`);
                console.log(`   时间: ${record.ts}`);
                console.log(`   供应商: ${record.providerName} (${record.format})`);
                console.log(`   模型: ${record.model}`);
                console.log(`   ❌ 这是错误格式！OpenAI API 不支持此格式`);
                
                if (foundCount === 1) {
                  const output = {
                    timestamp: record.ts,
                    provider: record.providerName,
                    model: record.model,
                    format: record.format,
                    payload: payload,
                  };
                  fs.writeFileSync('scripts/_real_image_request.json', JSON.stringify(output, null, 2), 'utf8');
                  console.log(`   💾 已导出到: scripts/_real_image_request.json`);
                }
                
                if (foundCount >= 5) break;
              }
            }
            
            if (foundCount >= 5) break;
          }
        }
      } catch (e) {
        // JSON 解析失败，跳过
      }
      
      if (foundCount >= 5) break;
      
    } catch (e) {}
  }
  
  if (foundCount >= 5) break;
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`\n📊 总结:`);
if (foundCount === 0) {
  console.log('   ❌ 没有找到任何图片上传请求');
  console.log('\n   可能的原因:');
  console.log('   1. 用户还没有在 IDE 中发送过包含图片的消息');
  console.log('   2. 图片数据在 protobuf 解析时丢失了');
  console.log('   3. 图片转换逻辑有 bug');
} else {
  console.log(`   ✅ 找到 ${foundCount} 个图片上传请求`);
  console.log(`   📁 详细数据已导出到: scripts/_real_image_request.json`);
}
