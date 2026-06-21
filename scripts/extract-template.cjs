const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '..', 'logs', 'sniffer-2026-06-19T14-53-47.log');
const log = fs.readFileSync(logPath, 'utf-8');
const lines = log.split('\n');

let found = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('--- Request Body ---')) {
    const bodyLine = lines[i + 1];
    if (!bodyLine || bodyLine.length < 500) continue;
    try {
      const b = JSON.parse(bodyLine);
      if (b.model !== 'gpt-5.5') continue;
      
      const template = {
        model: b.model,
        instructions: b.instructions,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello in one word' }] }],
        tools: b.tools,
        tool_choice: b.tool_choice,
        parallel_tool_calls: b.parallel_tool_calls,
        reasoning: b.reasoning,
        store: b.store,
        stream: true,
        include: b.include,
        prompt_cache_key: b.prompt_cache_key,
        text: b.text,
        client_metadata: b.client_metadata
      };
      
      const outPath = path.join(__dirname, 'codex-template.json');
      fs.writeFileSync(outPath, JSON.stringify(template, null, 2));
      console.log('Template saved to', outPath);
      console.log('Size:', JSON.stringify(template).length, 'bytes');
      console.log('Fields:', Object.keys(template).join(', '));
      console.log('Instructions length:', template.instructions.length);
      console.log('Tools count:', template.tools.length);
      console.log('prompt_cache_key:', template.prompt_cache_key);
      found = true;
      break;
    } catch(e) {
      console.log('Parse error at line', i, ':', e.message.substring(0, 100));
    }
  }
}

if (!found) console.log('No valid body found');