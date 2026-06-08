// scripts/dump_image_payload.cjs — 导出完整的图片请求 payload
// 用于深度分析图片数据的实际位置

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

if (!fs.existsSync(logPath)) {
  console.log('❌ 日志文件不存在');
  process.exit(0);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.trim().split('\n').filter(Boolean);

console.log(`📊 扫描 ${lines.length} 条日志...\n`);

let latestImageRequest = null;

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
  } catch (e) {}
}

if (!latestImageRequest) {
  console.log('❌ 没有找到包含图片的请求');
  process.exit(0);
}

console.log(`✅ 找到最近的图片请求: ${latestImageRequest.ts}\n`);

const outputFile = 'scripts/_debug_image_payload.json';

try {
  const payload = JSON.parse(latestImageRequest.request.body);
  
  // 递归查找所有包含 base64 的路径
  function findBase64Paths(obj, path = '') {
    const results = [];
    
    if (typeof obj === 'string') {
      if (obj.includes(';base64,') || (obj.includes('data:image') && obj.length > 100)) {
        const preview = obj.slice(0, 100) + '...[' + obj.length + ' chars]';
        results.push({ path, preview, length: obj.length });
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        results.push(...findBase64Paths(item, `${path}[${idx}]`));
      });
    } else if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(key => {
        results.push(...findBase64Paths(obj[key], path ? `${path}.${key}` : key));
      });
    }
    
    return results;
  }
  
  const base64Paths = findBase64Paths(payload);
  
  console.log(`🔍 Base64 数据位置分析:\n`);
  base64Paths.forEach((item, idx) => {
    console.log(`   [${idx + 1}] ${item.path}`);
    console.log(`       长度: ${item.length} chars (${(item.length * 0.75 / 1024).toFixed(1)} KB)`);
    console.log(`       预览: ${item.preview}\n`);
  });
  
  // 导出完整 payload 供分析
  const output = {
    timestamp: latestImageRequest.ts,
    provider: latestImageRequest.providerName,
    model: latestImageRequest.model,
    format: latestImageRequest.format,
    base64_locations: base64Paths,
    full_payload: payload,
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`💾 完整 payload 已导出到: ${outputFile}`);
  console.log(`   文件大小: ${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB`);
  
} catch (e) {
  console.error(`❌ 解析失败: ${e.message}`);
  
  // 导出原始 body
  fs.writeFileSync(outputFile, latestImageRequest.request.body, 'utf8');
  console.log(`💾 原始 body 已导出到: ${outputFile}`);
}
