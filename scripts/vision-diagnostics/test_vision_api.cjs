// scripts/test_vision_api.cjs — 测试图片理解功能
// 用于验证 AnyBridge 是否正确将图片传递到 API

const https = require('https');
const fs = require('fs');
const path = require('path');

// 配置：从环境变量读取或使用默认值
const API_BASE = process.env.TEST_API_BASE || 'https://api.junai.cn';
const API_KEY = process.env.TEST_API_KEY || '';
const MODEL = process.env.TEST_MODEL || 'claude-3-5-sonnet-20241022';

if (!API_KEY) {
  console.error('❌ 请设置 TEST_API_KEY 环境变量');
  process.exit(1);
}

// 读取测试图片（优先从桌面读取，否则创建一个简单的测试图片）
const desktopImg = 'C:\\Users\\admin\\Desktop\\PixPin_20260604090853.png';
let base64Image;

if (fs.existsSync(desktopImg)) {
  const imgBuf = fs.readFileSync(desktopImg);
  base64Image = imgBuf.toString('base64');
  console.log(`✅ 读取桌面图片: ${(imgBuf.length / 1024).toFixed(1)} KB`);
} else {
  // 创建一个简单的 10x10 红色 PNG 作为测试
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVQYV2P8z8BQz0BFwMgwasChAQBf9AoL/k2MVQAAAABJRU5ErkJggg==',
    'base64'
  );
  base64Image = png.toString('base64');
  console.log('⚠️  桌面图片未找到，使用测试图片 (10x10 红色)');
}

// 构造请求 payload
const payload = {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`
          }
        },
        {
          type: 'text',
          text: '请描述这张图片的内容'
        }
      ]
    }
  ],
  max_tokens: 1024,
  stream: false
};

const payloadStr = JSON.stringify(payload);
const url = new URL('/v1/chat/completions', API_BASE);

console.log(`\n🚀 测试 Vision API`);
console.log(`   API: ${url.href}`);
console.log(`   Model: ${MODEL}`);
console.log(`   Payload size: ${(payloadStr.length / 1024).toFixed(1)} KB`);
console.log(`   Base64 image: ${(base64Image.length / 1024).toFixed(1)} KB\n`);

const options = {
  hostname: url.hostname,
  port: url.port || 443,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Length': Buffer.byteLength(payloadStr)
  }
};

const req = https.request(options, (res) => {
  console.log(`📥 响应状态: ${res.statusCode}`);
  console.log(`   Headers: ${JSON.stringify(res.headers, null, 2)}\n`);

  let data = '';
  res.setEncoding('utf8');
  
  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      
      if (response.error) {
        console.error('❌ API 返回错误:');
        console.error(JSON.stringify(response.error, null, 2));
        process.exit(1);
      }

      if (response.choices && response.choices[0]) {
        const message = response.choices[0].message;
        console.log('✅ API 响应成功\n');
        console.log('📝 模型回复:');
        console.log('─'.repeat(60));
        console.log(message.content);
        console.log('─'.repeat(60));
        
        if (response.usage) {
          console.log(`\n📊 Token 使用:`);
          console.log(`   Input: ${response.usage.prompt_tokens}`);
          console.log(`   Output: ${response.usage.completion_tokens}`);
          console.log(`   Total: ${response.usage.total_tokens}`);
        }
      } else {
        console.error('❌ 意外的响应格式:');
        console.error(JSON.stringify(response, null, 2));
      }
    } catch (e) {
      console.error('❌ 解析响应失败:');
      console.error(e.message);
      console.error('原始响应:', data.slice(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.error(`❌ 请求失败: ${e.message}`);
  process.exit(1);
});

req.setTimeout(30000, () => {
  console.error('❌ 请求超时 (30s)');
  req.destroy();
  process.exit(1);
});

req.write(payloadStr);
req.end();
