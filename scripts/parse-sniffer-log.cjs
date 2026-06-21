/**
 * 解析代理日志，提取 Codex 请求的关键字段
 */
const fs = require('fs');

const logFile = 'logs/sniffer-2026-06-19T14-53-47.log';
const log = fs.readFileSync(logFile, 'utf-8');
const lines = log.split('\n');

// 找到所有 REQ 的行号
const reqs = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/\[REQ #(\d+)\]/);
  if (m) reqs.push({ num: +m[1], line: i });
}

console.log('找到 ' + reqs.length + ' 个请求\n');

for (const req of reqs) {
  // 找到请求体开始位置
  let bodyStart = -1;
  let bodyLine = '';
  for (let i = req.line; i < lines.length && i < req.line + 30; i++) {
    if (lines[i].includes('--- Request Body ---')) {
      bodyStart = i + 1;
      bodyLine = lines[bodyStart];
      break;
    }
  }
  if (!bodyLine || bodyLine.length < 10) {
    console.log('=== REQ #' + req.num + ' === 无请求体或太短');
    continue;
  }

  try {
    const body = JSON.parse(bodyLine);
    console.log('=== REQ #' + req.num + ' (body ' + bodyLine.length + ' chars) ===');
    console.log('  model:', body.model);
    console.log('  stream:', body.stream);
    console.log('  instructions length:', (body.instructions || '').length);
    console.log('  input type:', Array.isArray(body.input) ? 'array(' + body.input.length + ')' : 'string');
    console.log('  tools count:', Array.isArray(body.tools) ? body.tools.length : 'n/a');
    console.log('  has prompt_cache_key:', 'prompt_cache_key' in body, body.prompt_cache_key ? '=' + body.prompt_cache_key : '');
    console.log('  has safety_identifier:', 'safety_identifier' in body, body.safety_identifier ? '=' + body.safety_identifier : '');
    console.log('  has tool_usage:', 'tool_usage' in body);
    console.log('  reasoning:', JSON.stringify(body.reasoning));
    console.log('  text:', JSON.stringify(body.text));
    console.log('  include:', JSON.stringify(body.include));
    console.log('  store:', body.store);
    console.log('  truncation:', body.truncation);
    console.log('  service_tier:', body.service_tier);
    console.log('  max_output_tokens:', body.max_output_tokens);
    console.log('  temperature:', body.temperature);
    console.log('  top_p:', body.top_p);
    console.log('  tool_choice:', body.tool_choice);
    console.log('  parallel_tool_calls:', body.parallel_tool_calls);
    console.log('  ALL KEYS:', Object.keys(body).join(', '));
    console.log('');
  } catch (e) {
    console.log('=== REQ #' + req.num + ' === PARSE ERROR: ' + e.message.substring(0, 100));
    console.log('  body preview: ' + bodyLine.substring(0, 200));
    console.log('');
  }
}
