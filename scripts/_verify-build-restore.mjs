/**
 * 验证构建产物与关键恢复点
 */
import { readFileSync } from 'node:fs';

const index = readFileSync('ui/index.html', 'utf8');
const checks = [
  ['stats tab', index.includes('data-proxy-panel="stats"')],
  ['logs tab', index.includes('data-proxy-panel="logs"')],
  ['proxyStatsMount', index.includes('id="proxyStatsMount"')],
  ['proxyLogsMount', index.includes('id="proxyLogsMount"')],
  ['logFilterBtn cycle', index.includes('data-action="cycleLogFilter"')],
  ['platform-panel-overview analytics', index.includes('proxy-analytics')],
];

const platforms = readFileSync('ui/assets/scripts/55-platforms.js', 'utf8');
checks.push(['tilde reveal', platforms.includes("s.startsWith('~/')")]);
checks.push(['bind display', platforms.includes("const display = String(path || '')")]);

const logs = readFileSync('ui/assets/scripts/state/logs.js', 'utf8');
checks.push(['cycleLogFilter export', logs.includes('export function cycleLogFilter')]);
checks.push(['cycleLogFilter mirror', logs.includes('g.cycleLogFilter = cycleLogFilter')]);

const rust = readFileSync('src-tauri/src/commands/system.rs', 'utf8');
checks.push(['expand_user_path', rust.includes('fn expand_user_path')]);
checks.push(['reveal uses expand', rust.includes('expand_user_path(&path)')]);

let fail = 0;
for (const [name, ok] of checks) {
  console.log(ok ? 'OK  ' : 'FAIL', name);
  if (!ok) fail++;
}
console.log(fail ? `\n${fail} FAILED` : '\nALL BUILD CHECKS OK');
process.exit(fail ? 1 : 0);
