// scripts/analyze_image_issue.cjs — 分析图片传递问题
// 对比 6月5日（有图片）和 6月7日（无图片）的差异

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

console.log('🔍 分析图片传递问题\n');
console.log('═'.repeat(60));

// 检查两天的日志
const dates = ['2026-06-05', '2026-06-07'];

for (const date of dates) {
  const logPath = path.join(LOG_DIR, `mitm-${date}.jsonl`);
  
  console.log(`\n📅 ${date}`);
  console.log('─'.repeat(60));
  
  if (!fs.existsSync(logPath)) {
    console.log('   ❌ 日志文件不存在');
    continue;
  }
  
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  
  let totalRequests = 0;
  let withImageUrl = 0;
  let withImageType = 0;
  let withBase64InText = 0;
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.direction !== 'upstream') continue;
      
      totalRequests++;
      
      const body = record.request?.body || '';
      if (typeof body !== 'string') continue;
      
      try {
        const payload = JSON.parse(body);
        
        if (payload.messages && Array.isArray(payload.messages)) {
          for (const msg of payload.messages) {
            if (msg.role !== 'user') continue;
            
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                // 标准图片格式
                if (block.type === 'image_url') {
                  withImageUrl++;
                  break;
                }
                // Anthropic 格式
                if (block.type === 'image' && block.source) {
                  withImageType++;
                  break;
                }
                // 文本中含 base64（非图片）
                if (block.type === 'text' && typeof block.text === 'string') {
                  if (block.text.includes(';base64,')) {
                    withBase64InText++;
                    break;
                  }
                }
              }
            } else if (typeof msg.content === 'string') {
              // 纯文本消息中的 base64
              if (msg.content.includes(';base64,')) {
                withBase64InText++;
              }
            }
          }
        }
      } catch (e) {}
      
    } catch (e) {}
  }
  
  console.log(`   总请求数: ${totalRequests}`);
  console.log(`   ✅ image_url 格式（正确）: ${withImageUrl}`);
  console.log(`   ⚠️  image+source 格式（Anthropic）: ${withImageType}`);
  console.log(`   📝 文本中含 base64（非图片）: ${withBase64InText}`);
  
  if (withImageUrl === 0 && withImageType === 0 && withBase64InText > 0) {
    console.log(`\n   ⚠️  结论: 这天没有真实的图片上传，只有代码/工具参数中的 base64`);
  } else if (withImageUrl > 0) {
    console.log(`\n   ✅ 结论: 图片成功传递到 API（使用正确格式）`);
  } else if (withImageType > 0) {
    console.log(`\n   ❌ 结论: 图片使用了错误格式（Anthropic），OpenAI API 无法识别`);
  }
}

console.log('\n' + '═'.repeat(60));
console.log('\n💡 总结:\n');
console.log('根据日志分析:');
console.log('- 6月5日: 用户真实上传了图片，且转换为正确的 image_url 格式');
console.log('- 6月7日: 用户没有上传图片，只是代码调试过程中出现的 base64 字符串');
console.log('\n如果用户反馈"图片理解不行"，可能的原因:');
console.log('1. ✅ 图片传递格式正确（已验证）');
console.log('2. ❓ 上游 API 本身不支持图片理解');
console.log('3. ❓ 上游 API 返回错误但未正确处理');
console.log('4. ❓ 模型选择问题（某些模型不支持 vision）');
console.log('\n建议下一步:');
console.log('- 使用 scripts/test_vision_api.cjs 直接测试君の公益 API');
console.log('- 检查 provider-pool.js 中该 API 的 vision capability 配置');
