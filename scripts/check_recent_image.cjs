const fs = require('fs');
const path = require('path');
const os = require('os');

const logFile = path.join(os.homedir(), 'AppData', 'Roaming', 'ide-byok', 'mitm-logs', 'mitm-2026-06-08.jsonl');

console.log('检查最近的图片请求...\n');

if (!fs.existsSync(logFile)) {
  console.log('❌ 日志文件不存在');
  process.exit(1);
}

// 读取最后 500 行
const content = fs.readFileSync(logFile, 'utf8');
const lines = content.trim().split('\n').slice(-500);

console.log(`读取最后 ${lines.length} 行日志\n`);

let foundImage = false;
let lastImageRequest = null;

// 从后往前查找
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const record = JSON.parse(lines[i]);
    
    // 检查请求体中是否有图片
    if (record.requestBody) {
      const body = typeof record.requestBody === 'string' ? JSON.parse(record.requestBody) : record.requestBody;
      
      if (body.messages) {
        for (const msg of body.messages) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'image_url' || part.type === 'image') {
                foundImage = true;
                lastImageRequest = {
                  timestamp: record.timestamp,
                  provider: record.providerName,
                  model: record.model,
                  hasImageInRequest: true,
                  imageType: part.type,
                  hasData: part.type === 'image_url' ? !!part.image_url?.url : !!part.source?.data
                };
                break;
              }
            }
          }
          if (foundImage) break;
        }
      }
    }
    
    if (foundImage) break;
  } catch (e) {
    // 跳过解析错误的行
  }
}

if (lastImageRequest) {
  console.log('✅ 找到最近的图片请求:\n');
  console.log(`时间: ${lastImageRequest.timestamp}`);
  console.log(`Provider: ${lastImageRequest.provider}`);
  console.log(`模型: ${lastImageRequest.model}`);
  console.log(`图片类型: ${lastImageRequest.imageType}`);
  console.log(`包含数据: ${lastImageRequest.hasData ? '✅ 是' : '❌ 否'}`);
} else {
  console.log('❌ 最近 500 行日志中没有发现图片请求');
  console.log('\n这说明问题可能是:');
  console.log('1. 图片在 protobuf 解析阶段就丢失了');
  console.log('2. 或者图片请求被路由层过滤掉了（vision: false）');
}
