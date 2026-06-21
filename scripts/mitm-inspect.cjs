// 检查 MITM 日志，查找白山智算相关请求
const fs = require('fs');
const path = require('path');
const os = require('os');

const configDir = process.env.BYOK_CONFIG_DIR
  || path.join(os.homedir(), 'AppData', 'Roaming', 'anybridge');

const logDir = path.join(configDir, 'mitm-logs');
if (!fs.existsSync(logDir)) {
  console.log('MITM 日志目录不存在:', logDir);
  process.exit(0);
}

const files = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
if (files.length === 0) {
  console.log('没有 MITM 日志文件');
  process.exit(0);
}

const latestFile = path.join(logDir, files[files.length - 1]);
console.log('📁 最新日志:', latestFile);
console.log('📊 文件大小:', (fs.statSync(latestFile).size / 1024 / 1024).toFixed(1), 'MB\n');

// 逐行读取，找白山相关
const content = fs.readFileSync(latestFile, 'utf8');
const lines = content.trim().split('\n').filter(Boolean);
console.log('总行数:', lines.length);

const baishanLines = [];
for (const line of lines) {
  try {
    const r = JSON.parse(line);
    const isBaishan = (r.providerName || '').match(/白山|baishan/i)
      || (r.request?.url || '').includes('edgefn');
    if (isBaishan) baishanLines.push(r);
  } catch {}
}

console.log('白山智算相关:', baishanLines.length, '条\n');

// 展示最近的条目
const recent = baishanLines.slice(-20);
recent.forEach((b, i) => {
  console.log(`── #${i + 1} ──`);
  console.log('  方向:', b.direction);
  console.log('  格式:', b.format);
  console.log('  模型:', b.model);
  console.log('  时间:', b.ts);
  console.log('  状态码:', b.response?.statusCode);
  
  const body = String(b.request?.body || '');
  console.log('  请求体长度:', body.length);
  if (body.length > 0) {
    console.log('  请求体前 200 字:', body.slice(0, 200));
  }
  
  // 检查响应是否有 cache 相关字段
  if (b.response?.body) {
    const rb = String(b.response.body);
    if (rb.includes('cached_tokens') || rb.includes('prompt_tokens_details') || rb.includes('cache_creation') || rb.includes('cache_read')) {
      const tokens = rb.match(/"cached_tokens"\s*:\s*(\d+)/);
      const promptT = rb.match(/"prompt_tokens"\s*:\s*(\d+)/);
      console.log('  🧊 缓存信息: cached_tokens=' + (tokens ? tokens[1] : 'N/A') + ', prompt_tokens=' + (promptT ? promptT[1] : 'N/A'));
    }
    console.log('  响应体前 200 字:', rb.slice(0, 200));
  }
  console.log('');
});
