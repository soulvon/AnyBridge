// scripts/inspect_image_format.cjs — 详细检查图片请求的格式
// 用于诊断图片数据的具体结构

const fs = require('fs');
const path = require('path');
const readline = require('readline');
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

const rl = readline.createInterface({
  input: fs.createReadStream(logPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let found = 0;

rl.on('line', (line) => {
  try {
    const record = JSON.parse(line);
    
    if (record.direction !== 'upstream') return;
    
    const body = record.request?.body || '';
    if (typeof body !== 'string') return;
    
    const hasBase64 = body.includes('data:image/') || body.includes(';base64,');
    if (!hasBase64) return;
    
    found++;
    
    // 只分析最近的一条
    if (found > 1) return;
    
    console.log(`🔍 分析第 ${found} 条图片请求\n`);
    console.log(`时间: ${record.ts}`);
    console.log(`供应商: ${record.providerName} (${record.format})`);
    console.log(`模型: ${record.model}\n`);
    
    try {
      const payload = JSON.parse(body);
      
      console.log('📦 Payload 结构:');
      console.log(`   model: ${payload.model}`);
      console.log(`   messages 数量: ${payload.messages?.length || 0}\n`);
      
      if (payload.messages && Array.isArray(payload.messages)) {
        payload.messages.forEach((msg, idx) => {
          console.log(`📨 Message[${idx}]:`);
          console.log(`   role: ${msg.role}`);
          
          if (typeof msg.content === 'string') {
            console.log(`   content: (string) ${msg.content.slice(0, 100)}...`);
          } else if (Array.isArray(msg.content)) {
            console.log(`   content: (array, ${msg.content.length} blocks)`);
            
            msg.content.forEach((block, bidx) => {
              console.log(`\n   📋 Block[${bidx}]:`);
              console.log(`      type: ${block.type}`);
              
              if (block.type === 'text') {
                console.log(`      text: ${block.text?.slice(0, 80)}...`);
              } else if (block.type === 'image_url') {
                const url = block.image_url?.url || block.image_url || '';
                if (typeof url === 'string') {
                  const match = url.match(/^data:([^;]+);base64,(.+)$/);
                  if (match) {
                    console.log(`      image_url.url: data:${match[1]};base64,...`);
                    console.log(`      base64 length: ${match[2].length} chars (${(match[2].length * 0.75 / 1024).toFixed(1)} KB)`);
                  } else {
                    console.log(`      image_url: ${url.slice(0, 100)}...`);
                  }
                } else {
                  console.log(`      image_url: ${JSON.stringify(url).slice(0, 100)}...`);
                }
              } else if (block.type === 'image') {
                console.log(`      ⚠️  使用了 type: "image" (这可能是错误格式)`);
                console.log(`      完整结构: ${JSON.stringify(block, null, 2).slice(0, 300)}`);
              } else {
                console.log(`      (其他类型)`);
                console.log(`      ${JSON.stringify(block, null, 2).slice(0, 200)}`);
              }
            });
          } else {
            console.log(`   content: ${JSON.stringify(msg.content).slice(0, 100)}...`);
          }
          console.log('');
        });
      }
      
      console.log('\n' + '─'.repeat(60));
      console.log('🔬 诊断结论:\n');
      
      // 检查是否符合 OpenAI Chat Completions 格式
      let hasCorrectFormat = false;
      let hasWrongFormat = false;
      
      if (payload.messages && Array.isArray(payload.messages)) {
        for (const msg of payload.messages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'image_url' && block.image_url) {
                hasCorrectFormat = true;
              }
              if (block.type === 'image' && block.source) {
                hasWrongFormat = true;
              }
            }
          }
        }
      }
      
      if (hasCorrectFormat) {
        console.log('✅ 格式正确: 使用了 OpenAI 标准的 image_url 格式');
      }
      
      if (hasWrongFormat) {
        console.log('❌ 格式错误: 使用了 Anthropic 的 image + source 格式');
        console.log('   OpenAI API 需要: { type: "image_url", image_url: { url: "data:..." } }');
        console.log('   当前使用: { type: "image", source: { type: "base64", ... } }');
      }
      
      if (!hasCorrectFormat && !hasWrongFormat) {
        console.log('⚠️  未检测到标准图片格式，但 body 中有 base64 数据');
        console.log('   可能是其他格式或嵌套位置不对');
      }
      
    } catch (e) {
      console.error(`❌ 解析 payload 失败: ${e.message}`);
      console.log(`\nBody 前 500 字符:\n${body.slice(0, 500)}`);
    }
    
  } catch (e) {
    // 忽略解析错误的行
  }
});

rl.on('close', () => {
  if (found === 0) {
    console.log('❌ 没有找到包含图片的请求');
  }
});
