const fs = require('fs');
const log = fs.readFileSync(__dirname + '/../logs/sniffer-2026-06-19T14-53-47.log', 'utf-8');
const lines = log.split('\n');

let count = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/\[RES #(\d+)\] 200/);
  if (!m) continue;
  count++;
  console.log('=== RES #' + m[1] + ' (line ' + i + ') ===');
  
  for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
    if (lines[j].includes('--- Response Body ---')) {
      const body = lines[j + 1];
      if (!body) { console.log('  No body'); break; }
      console.log('  Body length:', body.length);
      
      if (body.length > 500) {
        // Check for usage
        const usageIdx = body.indexOf('"usage"');
        if (usageIdx > 0) {
          console.log('  USAGE:', body.substring(usageIdx, usageIdx + 250));
        }
        // Check for cached_tokens
        const cachedIdx = body.indexOf('cached');
        if (cachedIdx > 0) {
          console.log('  CACHED:', body.substring(cachedIdx, cachedIdx + 150));
        }
        // Check for input_tokens_details
        const detailsIdx = body.indexOf('input_tokens_details');
        if (detailsIdx > 0) {
          console.log('  DETAILS:', body.substring(detailsIdx, detailsIdx + 200));
        }
        // Last 300 chars
        if (body.length > 300) {
          console.log('  Last 300:', body.substring(body.length - 300));
        }
      }
      break;
    }
  }
  console.log('');
  if (count >= 3) break;
}