// test-antigravity-inference.mjs — 真实推理能力全矩阵测试
import http from 'node:http';

const PORT = 7450;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ACTIVE_MODEL = 'byok-deepseek-v4-flash-73570bd8'; // 真实的 SenseNova 上游

function request(path, body = {}, isStream = false) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const start = performance.now();
    const req = http.request(
      `${BASE_URL}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const elapsed = performance.now() - start;
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              data: JSON.parse(raw),
              raw,
              elapsed,
            });
          } catch {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              raw,
              elapsed,
            });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout connecting to ${path}`));
    });
    req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('========================================================');
  console.log('🚀 开始 Antigravity 本地网关推理能力矩阵测试');
  console.log(`🎯 目标模型: ${ACTIVE_MODEL}`);
  console.log('========================================================\n');

  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`✅ [通过] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [失败] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. countTokens
  await check('Token 计数接口 countTokens', async () => {
    const res = await request('/v1internal:countTokens', {
      model: ACTIVE_MODEL,
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Hello, this is a token test.' }] }],
      },
    });
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (typeof res.data.totalTokens !== 'number' || res.data.totalTokens <= 0) {
      throw new Error(`Token 计数结果异常: ${JSON.stringify(res.data)}`);
    }
    console.log(`   - 估算 Token 数量: ${res.data.totalTokens} | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 2. 非流式 generateContent
  await check('非流式内容生成 generateContent', async () => {
    const res = await request('/v1internal:generateContent', {
      model: ACTIVE_MODEL,
      request: {
        contents: [{ role: 'user', parts: [{ text: '请回复四个字：测试通过' }] }],
        generationConfig: { maxOutputTokens: 50 },
      },
    });
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}, body: ${res.raw}`);
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error(`未返回生成文本: ${res.raw}`);
    console.log(`   - 生成回复: "${text.trim()}" | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 3. SSE 流式 streamGenerateContent?alt=sse
  await check('SSE 双向流式推理 streamGenerateContent?alt=sse', async () => {
    const res = await request('/v1internal:streamGenerateContent?alt=sse', {
      model: ACTIVE_MODEL,
      request: {
        contents: [{ role: 'user', parts: [{ text: '1+1等于几？请简短回答。' }] }],
        generationConfig: { maxOutputTokens: 50 },
      },
    }, true);
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}, body: ${res.raw}`);
    if (!res.headers['content-type']?.includes('text/event-stream')) {
      throw new Error(`Content-Type 必须是 text/event-stream, 实际: ${res.headers['content-type']}`);
    }
    if (!res.raw.includes('data: ')) {
      throw new Error(`SSE 流格式异常，缺少 "data: " 前缀: ${res.raw}`);
    }
    if (!res.raw.includes('candidates')) {
      throw new Error(`SSE 内容缺少 candidates 字段: ${res.raw}`);
    }
    console.log(`   - SSE 字节流长度: ${res.raw.length} bytes | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
    console.log(`   - 预览前 120 字符: ${res.raw.slice(0, 120).replace(/\n/g, ' ')}...`);
  });

  // 4. 未知模型错误处理
  await check('未知模型错误处理 (400 明确报错，禁止外网挂起)', async () => {
    const res = await request('/v1internal:generateContent', {
      model: 'unknown-non-existent-model',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    });
    if (res.status !== 400) throw new Error(`预期返回 400 错误，实际: ${res.status}`);
    if (!res.data.error?.message?.includes('未找到模型')) {
      throw new Error(`错误提示内容不符合预期: ${JSON.stringify(res.data)}`);
    }
    if (res.elapsed > 200) throw new Error(`错误返回超时，未在本地快速拦截: ${res.elapsed.toFixed(1)}ms`);
    console.log(`   - 拦截响应耗时: ${res.elapsed.toFixed(1)}ms | 提示: ${res.data.error.message}`);
  });

  console.log('\n========================================================');
  console.log(`📊 推理测试结果: 全部 ${passed + failed} 项测试 | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
  console.log('========================================================\n');

  if (failed > 0) process.exit(1);
}

runTests();
