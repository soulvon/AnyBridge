/**
 * 快速测试 DeepSeek-V4-Pro 是否支持 prompt caching
 */
const https = require('https');

const API_KEY = 'sk-RXuwgKntWUV5VuyJ58Bb4bE6Ec9f4a35802708Ba4dDd861a';
const HOST = 'api.edgefn.net';
const MODEL = 'DeepSeek-V4-Pro';

const LONG_SYSTEM = '你是一个专业的代码助手。请严格遵守以下规则：\n1. 始终使用中文回答\n2. 代码注释使用中文\n3. 变量命名使用英文驼峰\n4. 每个函数必须有 JSDoc 注释\n5. 错误处理必须完整\n6. 使用 TypeScript 类型定义\n7. 遵循 SOLID 原则\n8. 优先使用函数式编程\n9. 避免使用 any 类型\n10. 单元测试覆盖率不低于 80%\n'.repeat(50);

function req(messages, label) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, messages, stream: false, max_tokens: 50 });
    const opts = {
      hostname: HOST, port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const r = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const usage = j.usage || {};
          console.log(`  ${label}: status=${res.statusCode} | prompt=${usage.prompt_tokens} | cached=${usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0} | completion=${usage.completion_tokens}`);
          resolve({ usage, status: res.statusCode });
        } catch (e) {
          console.log(`  ${label}: status=${res.statusCode} body=${data.slice(0, 200)}`);
          resolve({ usage: {}, status: res.statusCode });
        }
      });
    });
    r.on('error', e => { console.log(`  ${label}: ERR ${e.message}`); reject(e); });
    r.write(body);
    r.end();
  });
}

async function main() {
  console.log(`\n=== 测试 ${MODEL} Prompt Cache ===\n`);

  const systemMsg = { role: 'system', content: LONG_SYSTEM };

  // 预热
  await req([systemMsg, { role: 'user', content: '你好' }], '预热#1');
  await sleep(2000);

  // 命中测试 - 相同 system prompt
  await req([systemMsg, { role: 'user', content: '你好' }], '命中#1');
  await sleep(2000);

  // 命中测试 - 不同 user 问题
  await req([systemMsg, { role: 'user', content: '解释一下闭包' }], '命中#2');
  await sleep(2000);

  // 短 system prompt 对照
  await req([{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }], '对照(短system)');

  console.log('\n=== 完成 ===');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => console.error(e));