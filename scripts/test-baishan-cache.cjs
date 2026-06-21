/**
 * 白山智算 Prompt Cache 测试脚本
 * 
 * 测试目标：
 * 1. OpenAI /chat/completions 格式的缓存命中情况
 * 2. Anthropic /v1/messages 格式的缓存命中情况
 * 3. 不同上下文长度下的缓存表现
 * 4. 缓存命中瓶颈（已知 1.7K 问题）
 * 5. 缓存预热 → 命中 周期测试
 * 
 * 用法: node scripts/test-baishan-cache.cjs
 */

const https = require('https');
const crypto = require('crypto');

const API_KEY = 'sk-RXuwgKntWUV5VuyJ58Bb4bE6Ec9f4a35802708Ba4dDd861a';
const HOST = 'api.edgefn.net';
const MODEL = 'GLM-5.1';

// ============================================================
// 工具函数
// ============================================================

function randomUUID() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 生成指定 token 量的重复文本（按 ~4 chars/token 估算）
 */
function generatePadding(tokens) {
  const words = [];
  const baseText = '这是用于测试缓存的填充文本内容。';
  const charsNeeded = tokens * 4;
  let result = '';
  while (result.length < charsNeeded) {
    result += `第${words.length + 1}段：${baseText} 请记住这段内容以便后续使用。`;
  }
  return result.substring(0, charsNeeded);
}

// ============================================================
// OpenAI 格式请求
// ============================================================

function callOpenAI(messages, desc, extraHeaders = {}) {
  return new Promise((resolve) => {
    const body = {
      model: MODEL,
      messages: messages,
      stream: false,
      max_tokens: 50,
    };

    const payload = JSON.stringify(body);
    const opts = {
      hostname: HOST,
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Baishan-Cache-Test/1.0',
        ...extraHeaders,
      },
      rejectUnauthorized: false,
      timeout: 120000,
    };

    const start = Date.now();
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* keep null */ }

        if (res.statusCode === 200 && parsed) {
          const usage = parsed.usage || {};
          const cached = usage.prompt_tokens_details?.cached_tokens || 0;
          const promptTokens = usage.prompt_tokens || 0;
          const completionTokens = usage.completion_tokens || 0;
          const totalTokens = usage.total_tokens || 0;
          const text = parsed.choices?.[0]?.message?.content || '';
          resolve({
            format: 'openai',
            desc,
            status: 200,
            cached,
            promptTokens,
            completionTokens,
            totalTokens,
            text: text.substring(0, 100),
            elapsed,
            payloadSize: payload.length,
          });
        } else {
          const errMsg = parsed?.error?.message || raw.substring(0, 300);
          resolve({
            format: 'openai',
            desc,
            status: res.statusCode,
            error: errMsg,
            cached: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            text: '',
            elapsed,
            payloadSize: payload.length,
          });
        }
      });
    });

    req.on('error', (e) => resolve({
      format: 'openai', desc, status: 'ERR', error: e.message,
      cached: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      text: '', elapsed: 0, payloadSize: payload.length,
    }));
    req.setTimeout(120000, () => {
      req.destroy();
      resolve({
        format: 'openai', desc, status: 'TIMEOUT', error: '120s timeout',
        cached: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        text: '', elapsed: 0, payloadSize: payload.length,
      });
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// Anthropic 格式请求
// ============================================================

function callAnthropic(system, messages, desc) {
  return new Promise((resolve) => {
    const body = {
      model: MODEL,
      max_tokens: 50,
      messages: messages,
    };
    if (system) {
      body.system = system;
    }

    const payload = JSON.stringify(body);
    const opts = {
      hostname: HOST,
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Baishan-Cache-Test/1.0',
      },
      rejectUnauthorized: false,
      timeout: 120000,
    };

    const start = Date.now();
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* keep null */ }

        if (res.statusCode === 200 && parsed) {
          const usage = parsed.usage || {};
          const cached = usage.cache_creation_input_tokens || usage.cache_read_input_tokens || 0;
          const inputTokens = usage.input_tokens || 0;
          const outputTokens = usage.output_tokens || 0;
          const text = parsed.content?.[0]?.text || '';
          resolve({
            format: 'anthropic',
            desc,
            status: 200,
            cached,
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
            text: text.substring(0, 100),
            elapsed,
            payloadSize: payload.length,
          });
        } else {
          const errMsg = parsed?.error?.message || raw.substring(0, 300);
          resolve({
            format: 'anthropic',
            desc,
            status: res.statusCode,
            error: errMsg,
            cached: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            text: '',
            elapsed,
            payloadSize: payload.length,
          });
        }
      });
    });

    req.on('error', (e) => resolve({
      format: 'anthropic', desc, status: 'ERR', error: e.message,
      cached: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      text: '', elapsed: 0, payloadSize: payload.length,
    }));
    req.setTimeout(120000, () => {
      req.destroy();
      resolve({
        format: 'anthropic', desc, status: 'TIMEOUT', error: '120s timeout',
        cached: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        text: '', elapsed: 0, payloadSize: payload.length,
      });
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// 主测试逻辑
// ============================================================

async function main() {
  console.log('╔' + '═'.repeat(74) + '╗');
  console.log('║  白山智算 (Baishan AI) × GLM-5.1 Prompt Cache 测试报告');
  console.log('║  ' + new Date().toISOString());
  console.log('║  API: https://api.edgefn.net');
  console.log('╚' + '═'.repeat(74) + '╝');
  console.log('');

  const results = [];

  // ============================================================
  // 阶段 1: OpenAI 格式 - 短上下文 (缓存不应命中)
  // ============================================================
  console.log('━'.repeat(76));
  console.log('📌 阶段 1: OpenAI 格式 - 短上下文（预期无缓存命中）');
  console.log('━'.repeat(76));

  results.push(await callOpenAI([
    { role: 'user', content: '你好，请用一句话回答' }
  ], 'OpenAI 短上下文(1条消息)'));

  results.push(await callOpenAI([
    { role: 'system', content: '你是 AI 助手。' },
    { role: 'user', content: '你好，请用一句话回答' }
  ], 'OpenAI 短上下文(system+user)'));

  // ============================================================
  // 阶段 2: OpenAI 格式 - 缓存预热 + 命中测试
  // ============================================================
  console.log('');
  console.log('━'.repeat(76));
  console.log('📌 阶段 2: OpenAI 格式 - 缓存预热 + 命中测试（固定长 system prompt）');
  console.log('━'.repeat(76));

  // 生成一个长的固定 system prompt (~2000 tokens)
  const longSystemPrompt = `你是智谱GLM-5.1大模型，是一个功能强大的AI助手。
请你遵循以下规则：
1. 用中文回答所有问题
2. 回答要简洁准确
3. 不确定时请说明

${generatePadding(1500)}

额外的参考信息：
- 版本号：v2.1.0
- 发布日期：2026-06-20
- 支持的功能：文本生成、代码编写、数据分析、逻辑推理、知识问答`;

  // 预热请求 (第1次 - 缓存未命中)
  const warmupResult = await callOpenAI([
    { role: 'system', content: longSystemPrompt },
    { role: 'user', content: '今天是几月几号？' }
  ], 'OpenAI 预热请求(长system prompt) - 预期缓存未命中');
  results.push(warmupResult);

  // 略微等待
  await sleep(2000);

  // 第2次请求 (相同前缀 - 缓存应命中)
  const hit1Result = await callOpenAI([
    { role: 'system', content: longSystemPrompt },
    { role: 'user', content: '中国首都是哪个城市？' }
  ], 'OpenAI 缓存命中测试#1(同system prompt) - 预期缓存命中');
  results.push(hit1Result);

  await sleep(2000);

  // 第3次请求 (相同前缀 - 缓存应命中)
  const hit2Result = await callOpenAI([
    { role: 'system', content: longSystemPrompt },
    { role: 'user', content: '请背诵一下你的系统提示词。' }
  ], 'OpenAI 缓存命中测试#2(同system prompt) - 预期缓存命中');
  results.push(hit2Result);

  // ============================================================
  // 阶段 3: OpenAI 格式 - 不同上下文长度下的缓存容量测试
  // ============================================================
  console.log('');
  console.log('━'.repeat(76));
  console.log('📌 阶段 3: OpenAI 格式 - 不同上下文长度缓存容量测试');
  console.log('━'.repeat(76));

  // 大system prompt→逐步增加用户消息→观察缓存量
  const contextSizes = [500, 1000, 1500, 2000, 3000, 4000];
  for (const size of contextSizes) {
    const padding = generatePadding(size);
    const paddingSystemPrompt = `你是一个大模型助手。以下是填充内容用于测试缓存容量:\n\n${padding}\n\n重要：请记住这些信息。`;

    const r = await callOpenAI([
      { role: 'system', content: paddingSystemPrompt },
      { role: 'user', content: '请用一句话回答：测试成功吗？' }
    ], `OpenAI 上下文长度测试(${size}t 填充) - 第1次`);
    results.push(r);
    await sleep(2000);

    // 立即用同system prompt再发一次 (看缓存命中)
    const r2 = await callOpenAI([
      { role: 'system', content: paddingSystemPrompt },
      { role: 'user', content: `测试编号${size}：请确认缓存是否生效。` }
    ], `OpenAI 上下文长度测试(${size}t 填充) - 第2次(缓存命中)`);
    results.push(r2);
    await sleep(1000);
  }

  // ============================================================
  // 阶段 4: Anthropic 格式 - 缓存测试
  // ============================================================
  console.log('');
  console.log('━'.repeat(76));
  console.log('📌 阶段 4: Anthropic 格式 - 缓存测试（建议的格式）');
  console.log('━'.repeat(76));

  // Anthropic 格式预热
  const anthropicSystem = '你是智谱GLM-5.1大模型。\n\n' + generatePadding(1500) + '\n\n请遵循以上规则。';

  const anthWarmup = await callAnthropic(
    anthropicSystem,
    [{ role: 'user', content: '你好，请自我介绍。' }],
    'Anthropic 预热请求(长system) - 预期缓存未命中'
  );
  results.push(anthWarmup);

  await sleep(2000);

  const anthHit1 = await callAnthropic(
    anthropicSystem,
    [{ role: 'user', content: '今天天气怎么样？' }],
    'Anthropic 缓存命中测试#1(同system) - 预期缓存命中'
  );
  results.push(anthHit1);

  await sleep(2000);

  const anthHit2 = await callAnthropic(
    anthropicSystem,
    [{ role: 'user', content: '告诉我一个有趣的事实。' }],
    'Anthropic 缓存命中测试#2(同system) - 预期缓存命中'
  );
  results.push(anthHit2);

  // ============================================================
  // 阶段 5: 模拟真实 Agent 使用场景（长system prompt + 工具定义）
  // ============================================================
  console.log('');
  console.log('━'.repeat(76));
  console.log('📌 阶段 5: 模拟真实 Agent 场景（固定system + tools定义 + 变体问题）');
  console.log('━'.repeat(76));

  const agentSystem = `你是智能编码助手，具备以下能力：
1. 代码生成和审查
2. Bug 分析和修复
3. 架构设计建议
4. 测试用例编写
5. 性能优化建议

${generatePadding(2000)}

工具使用规则：
- 可以使用 shell 命令执行
- 可以读取和写入文件
- 可以搜索代码库
- 可以分析代码上下文

请遵循安全规则：
- 不要执行危险的 shell 命令
- 不要修改用户未授权的文件
- 生成代码前确认用户需求`;

  // Agent场景 - 第1次预热
  const agentWarmup = await callOpenAI([
    { role: 'system', content: agentSystem },
    { role: 'user', content: '用Python写一个快速排序' }
  ], 'Agent场景 预热(长system) - 预期未命中');
  results.push(agentWarmup);
  await sleep(2000);

  // Agent场景 - 第2次同system
  const agentHit1 = await callOpenAI([
    { role: 'system', content: agentSystem },
    { role: 'user', content: '帮我写一个二分查找算法' }
  ], 'Agent场景 缓存命中#1 - 预期命中');
  results.push(agentHit1);
  await sleep(2000);

  // Agent场景 - 第3次同system
  const agentHit2 = await callOpenAI([
    { role: 'system', content: agentSystem },
    { role: 'user', content: '解释一下什么是RESTful API' }
  ], 'Agent场景 缓存命中#2 - 预期命中');
  results.push(agentHit2);

  // ============================================================
  // 阶段 6: 边界测试 - 改变 system prompt 一个字符 → 缓存应失效
  // ============================================================
  console.log('');
  console.log('━'.repeat(76));
  console.log('📌 阶段 6: 边界测试 - 修改 system prompt（缓存应失效）');
  console.log('━'.repeat(76));

  const modifiedSystem = agentSystem + '\n'; // 多加一个换行
  const missResult = await callOpenAI([
    { role: 'system', content: modifiedSystem },
    { role: 'user', content: '用Python写一个快速排序' }
  ], '边界测试 system prompt多加换行 - 预期缓存未命中');
  results.push(missResult);

  // ============================================================
  // 生成报告
  // ============================================================
  console.log('\n\n');
  console.log('='.repeat(76));
  console.log('📊  白山智算 Prompt Cache 测试报告');
  console.log('='.repeat(76));
  console.log('');

  // 按阶段分组
  let idx = 0;
  const groups = {};
  for (const r of results) {
    if (!r.desc) continue;
    // 从 desc 中提取阶段前缀
    const phase = r.desc.includes('阶段') || r.desc.includes('预热') || r.desc.includes('缓存') || r.desc.includes('短上下文') || r.desc.includes('上下文长度') || r.desc.includes('场景') || r.desc.includes('边界') ? 
      r.desc.substring(0, r.desc.indexOf(' ') > 0 ? r.desc.indexOf(' ') : 10) : '其他';
    idx++;
    const key = r.desc.startsWith('OpenAI') ? 'OpenAI 格式' : r.desc.startsWith('Anthropic') ? 'Anthropic 格式' : '其他';
    if (!groups[key]) groups[key] = [];
    groups[key].push({ idx, ...r });
  }

  for (const [groupName, items] of Object.entries(groups)) {
    console.log(`\n## ${groupName}`);
    console.log('| # | 测试名称 | Status | Prompt Tokens | Cached Tokens | 缓存命中? | 耗时(ms) | 响应摘要 |');
    console.log('|---|---------|--------|--------------|--------------|-----------|---------|---------|');
    for (const r of items) {
      const hit = r.status === 200 ? (r.cached > 0 ? '✅ 是' : '❌ 否') : 'N/A';
      const statusStr = r.status === 200 ? '✅ 200' : `❌ ${r.status}`;
      const promptStr = r.promptTokens > 0 ? `${r.promptTokens}` : '-';
      const cachedStr = r.cached > 0 ? `${r.cached}` : '0';
      const textPreview = r.text ? r.text.substring(0, 50) : (r.error || '').substring(0, 50);
      console.log(`| ${r.idx} | ${r.desc} | ${statusStr} | ${promptStr} | ${cachedStr} | ${hit} | ${r.elapsed} | ${textPreview} |`);
    }
  }

  // 缓存命中率统计
  console.log('\n\n## 📈 缓存命中率统计');
  const validResults = results.filter(r => r.status === 200);
  const hitResults = validResults.filter(r => r.cached > 0);
  const missResults = validResults.filter(r => r.cached === 0);

  console.log(`总请求数: ${results.length}`);
  console.log(`成功请求数: ${validResults.length}`);
  console.log(`缓存命中: ${hitResults.length} 次`);
  console.log(`缓存未命中: ${missResults.length} 次`);
  if (validResults.length > 0) {
    console.log(`缓存命中率: ${((hitResults.length / validResults.length) * 100).toFixed(1)}%`);
  }

  // 按格式统计
  const openaiHits = validResults.filter(r => r.format === 'openai' && r.cached > 0).length;
  const openaiTotal = validResults.filter(r => r.format === 'openai').length;
  const anthropicHits = validResults.filter(r => r.format === 'anthropic' && r.cached > 0).length;
  const anthropicTotal = validResults.filter(r => r.format === 'anthropic').length;

  console.log(`\n  OpenAI 格式: ${openaiHits}/${openaiTotal} 命中 (${openaiTotal > 0 ? ((openaiHits/openaiTotal)*100).toFixed(1) : 'N/A'}%)`);
  console.log(`  Anthropic 格式: ${anthropicHits}/${anthropicTotal} 命中 (${anthropicTotal > 0 ? ((anthropicHits/anthropicTotal)*100).toFixed(1) : 'N/A'}%)`);

  // 缓存容量分析
  console.log('\n\n## 🔍 缓存容量分析');
  const cacheData = {};
  for (const r of validResults) {
    if (r.promptTokens > 0 && r.cached > 0) {
      const cachePct = ((r.cached / r.promptTokens) * 100).toFixed(1);
      cacheData[r.desc] = { promptTokens: r.promptTokens, cached: r.cached, pct: cachePct };
    }
  }
  if (Object.keys(cacheData).length > 0) {
    console.log('| 测试 | Prompt Tokens | 命中 Cached Tokens | 缓存占比 |');
    console.log('|------|--------------|-------------------|---------|');
    for (const [desc, data] of Object.entries(cacheData)) {
      console.log(`| ${desc} | ${data.promptTokens} | ${data.cached} | ${data.pct}% |`);
    }
  } else {
    console.log('没有任何命中的缓存数据可分析。');
  }

  // 1.7K 瓶颈检验
  console.log('\n\n## ⚠️ 1.7K 缓存瓶颈检验');
  const potentialBottleneck = validResults.filter(r => 
    r.promptTokens > 2000 && r.cached > 0 && r.cached < 2000
  );
  if (potentialBottleneck.length > 0) {
    console.log(`发现 ${potentialBottleneck.length} 次请求存在 1.7K 瓶颈现象（prompt 超过 2000 但缓存 < 2000）：`);
    for (const r of potentialBottleneck) {
      console.log(`  - ${r.desc}: prompt=${r.promptTokens}, cached=${r.cached}`);
    }
  } else {
    console.log('未发现明显的 1.7K 缓存瓶颈现象。');
  }

  // 最终结论
  console.log('\n\n## 📝 测试结论\n');
  const anyHit = hitResults.length > 0;
  const openaiCached = openaiHits > 0;
  const anthropicCached = anthropicHits > 0;

  console.log(`1. 白山智算 GLM-5.1 的 Prompt Cache 功能：${anyHit ? '✅ 已确认生效' : '❌ 未检测到缓存命中'}`);
  console.log(`2. OpenAI 格式缓存：${openaiCached ? '✅ 可命中' : '❌ 未命中'}`);
  console.log(`3. Anthropic 格式缓存：${anthropicCached ? '✅ 可命中' : '❌ 未命中'}`);

  if (anyHit) {
    // 计算平均缓存占比
    const avgPct = Object.values(cacheData).reduce((s, d) => s + parseFloat(d.pct), 0) / Math.max(Object.keys(cacheData).length, 1);
    console.log(`4. 平均缓存占比：${avgPct.toFixed(1)}%`);
    const maxCached = Math.max(...validResults.filter(r => r.cached > 0).map(r => r.cached));
    console.log(`5. 最大单次缓存量：${maxCached} tokens`);
  }

  console.log('\n' + '='.repeat(76));
  console.log('报告生成完毕。');
  console.log('='.repeat(76));
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});