// scripts/check_image_in_mitm.cjs — 检查 MITM 日志中是否有图片请求
// 用于诊断 AnyBridge 是否正确传递图片到上游 API

const fs = require('fs');
const path = require('path');
const readline = require('readline');
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

// 获取今天的日志文件
const today = new Date().toISOString().slice(0, 10);
const logPath = path.join(LOG_DIR, `mitm-${today}.jsonl`);

console.log(`📁 检查日志: ${logPath}\n`);

if (!fs.existsSync(logPath)) {
  console.log('❌ 今天的日志文件不存在');
  console.log('   请在 IDE 中发送一条包含图片的请求后再运行此脚本');
  console.log(`   日志目录: ${LOG_DIR}`);
  process.exit(0);
}

const stat = fs.statSync(logPath);
console.log(`📊 日志文件大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB\n`);

// 逐行读取日志
const rl = readline.createInterface({
  input: fs.createReadStream(logPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let totalUpstream = 0;
let totalWithImages = 0;
const imageRequests = [];

rl.on('line', (line) => {
  try {
    const record = JSON.parse(line);
    
    // 只看上游请求
    if (record.direction !== 'upstream') return;
    totalUpstream++;
    
    const body = record.request?.body || '';
    if (typeof body !== 'string') return;
    
    // 检测图片特征
    const hasImageUrl = body.includes('"image_url"');
    const hasInputImage = body.includes('"input_image"');
    const hasBase64Image = body.includes('data:image/') || body.includes(';base64,');
    const hasImageType = body.includes('"type":"image"');
    
    if (hasImageUrl || hasInputImage || hasBase64Image || hasImageType) {
      totalWithImages++;
      
      // 提取关键信息
      const info = {
        timestamp: record.ts,
        provider: record.providerName || 'Unknown',
        model: record.model || 'Unknown',
        format: record.format || 'Unknown',
        bodyLength: body.length,
        hasImageUrl,
        hasInputImage,
        hasBase64Image,
        hasImageType,
      };
      
      // 尝试提取 base64 长度
      if (hasBase64Image) {
        const base64Match = body.match(/"data":"([^"]{100,})"/);
        if (base64Match) {
          info.base64Length = base64Match[1].length;
        }
      }
      
      imageRequests.push(info);
      
      if (imageRequests.length <= 10) {
        console.log(`🖼️  发现图片请求 #${totalWithImages}`);
        console.log(`   时间: ${info.timestamp}`);
        console.log(`   供应商: ${info.provider} (${info.format})`);
        console.log(`   模型: ${info.model}`);
        console.log(`   Body 大小: ${(info.bodyLength / 1024).toFixed(1)} KB`);
        if (info.base64Length) {
          console.log(`   Base64 长度: ${(info.base64Length / 1024).toFixed(1)} KB`);
        }
        console.log(`   特征: image_url=${hasImageUrl} input_image=${hasInputImage} base64=${hasBase64Image} type:image=${hasImageType}`);
        console.log('');
      }
    }
  } catch (e) {
    // 忽略解析错误的行
  }
});

rl.on('close', () => {
  console.log('─'.repeat(60));
  console.log(`\n📈 统计结果:`);
  console.log(`   总上游请求数: ${totalUpstream}`);
  console.log(`   包含图片的请求: ${totalWithImages} (${totalUpstream > 0 ? ((totalWithImages / totalUpstream) * 100).toFixed(1) : 0}%)`);
  
  if (totalWithImages === 0) {
    console.log('\n❌ 没有发现图片请求！');
    console.log('\n💡 诊断建议:');
    console.log('   1. 确认在 IDE 中发送的消息确实包含了图片附件');
    console.log('   2. 检查 sidecar 是否正在运行 (应该监听 7450 端口)');
    console.log('   3. 查看 parse-request.js 中的 [DEBUG-IMG] 日志输出');
    console.log('   4. 检查 Windsurf protobuf 请求中 field 10 (images) 是否存在');
  } else {
    console.log('\n✅ 发现图片请求，说明图片数据已经传递到上游 API');
    
    if (imageRequests.length > 10) {
      console.log(`\n💡 共 ${imageRequests.length} 条图片请求，以上仅展示前 10 条`);
    }
  }
  
  console.log(`\n📁 完整日志文件: ${logPath}`);
});
