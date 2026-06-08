// scripts/inspect_latest_image.cjs — 检查最近一条图片请求的格式
// 反向读取日志文件，找到最近的图片请求

const fs = require('fs');
const path = require('path');
const os = require('os');

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ide-byok');
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'ide-byok');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'ide-byok');
}

const LOG_DIR = path.join(configDir(), 'mitm-logs');
const today = new Date().toISOString().slice(0, 10);
const logPath = path.join(LOG_DIR, `mitm-${today}.jsonl`);

console.log(`📁 检查日志: ${logPath}\n`);

if (!fs.existsSync(logPath)) {
  console.log('❌ 日志文件不存在');
  process.exit(0);
}

// 读取全部内容，反向查找
const content = fs.readFileSync(logPath, 'utf8');
const lines = content.trim().split('\n').filter(Boolean);

console.log(`📊 总共 ${lines.length} 条日志记录\n`);

let latestImageRequest = null;

// 从后往前找
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const record = JSON.parse(lines[i]);
    
    if (record.direction !== 'upstream') continue;
    
    const body = record.request?.body || '';
    if (typeof body !== 'string') continue;
    
    const hasBase64 = body.includes('data:image/') || body.includes(';base64,');
    if (!hasBase64) continue;
    
    latestImageRequest = record;
    break;
  } catch (e) {
    // 忽略解析错误
  }
}

if (!latestImageRequest) {
  console.log('❌ 没有找到包含图片的请求');
  process.exit(0);
}

console.log(`🔍 找到最近的图片请求\n`);
console.log(`时间: ${latestImageRequest.ts}`);
console.log(`供应商: ${latestImageRequest.providerName} (${latestImageRequest.format})`);
console.log(`模型: ${latestImageRequest.model}\n`);

try {
  const payload = JSON.parse(latestImageRequest.request.body);
  
  console.log('📦 Payload 结构:');
  console.log(`   model: ${payload.model}`);
  console.log(`   messages 数量: ${payload.messages?.length || 0}\n`);
  
  let foundImageMessage = false;
  
  if (payload.messages && Array.isArray(payload.messages)) {
    for (let idx = 0; idx < payload.messages.length; idx++) {
      const msg = payload.messages[idx];
      
      // 只展示包含图片的消息
      let hasImage = false;
      if (Array.isArray(msg.content)) {
        hasImage = msg.content.some(b => 
          (b.type === 'image_url') || 
          (b.type === 'image') ||
          (b.type === 'input_image')
        );
      }
      
      if (!hasImage) continue;
      
      foundImageMessage = true;
      console.log(`📨 Message[${idx}] (含图片):`);
      console.log(`   role: ${msg.role}`);
      console.log(`   content: (array, ${msg.content.length} blocks)\n`);
      
      msg.content.forEach((block, bidx) => {
        console.log(`   📋 Block[${bidx}]:`);
        console.log(`      type: "${block.type}"`);
        
        if (block.type === 'text') {
          console.log(`      text: "${block.text?.slice(0, 80)}..."`);
          
        } else if (block.type === 'image_url') {
          console.log(`      ✅ 这是正确的 OpenAI 格式!`);
          const imageUrl = block.image_url;
          
          if (typeof imageUrl === 'string') {
            const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              console.log(`      image_url: "data:${match[1]};base64,..."`);
              console.log(`      base64 长度: ${match[2].length} chars (${(match[2].length * 0.75 / 1024).toFixed(1)} KB)`);
            }
          } else if (typeof imageUrl === 'object' && imageUrl.url) {
            const match = imageUrl.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              console.log(`      image_url.url: "data:${match[1]};base64,..."`);
              console.log(`      base64 长度: ${match[2].length} chars (${(match[2].length * 0.75 / 1024).toFixed(1)} KB)`);
            }
          } else {
            console.log(`      image_url: ${JSON.stringify(imageUrl).slice(0, 100)}`);
          }
          
        } else if (block.type === 'image') {
          console.log(`      ❌ 错误格式! 这是 Anthropic 格式，不是 OpenAI 格式`);
          console.log(`      应该使用: { type: "image_url", image_url: { url: "data:..." } }`);
          console.log(`      当前结构:`);
          console.log(JSON.stringify(block, null, 6));
          
        } else if (block.type === 'input_image') {
          console.log(`      ⚠️  这可能是 OpenAI Responses API 格式`);
          console.log(`      但 Chat Completions API 需要 "image_url" 类型`);
          
        } else {
          console.log(`      其他类型，结构:`);
          console.log(JSON.stringify(block, null, 6).slice(0, 300));
        }
        console.log('');
      });
    }
  }
  
  if (!foundImageMessage) {
    console.log('⚠️  payload 中有 base64 数据，但没有在 messages 的 content blocks 中找到图片');
  }
  
} catch (e) {
  console.error(`❌ 解析 payload 失败: ${e.message}`);
  console.log(`\nBody 前 1000 字符:\n${latestImageRequest.request.body.slice(0, 1000)}`);
}
