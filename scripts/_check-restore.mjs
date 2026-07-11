/**
 * 检查回归恢复完成度
 */
import { readFileSync, existsSync } from 'node:fs';

const checks = [
  ['10-shell overview', 'ui/assets/scripts/10-shell.js', (s) => s.includes("'overview', 'models', 'settings'")],
  ['10-shell mount stats', 'ui/assets/scripts/10-shell.js', (s) => s.includes('mountProxyStatsAndLogsPanels')],
  ['10-shell open overview->stats', 'ui/assets/scripts/10-shell.js', (s) => s.includes("openProxyPanel('stats')")],
  ['cycleLogFilter', 'ui/assets/scripts/state/logs.js', (s) => s.includes('function cycleLogFilter')],
  ['renderProxyStats', 'ui/assets/scripts/20-runtime.js', (s) => s.includes('function renderProxyStats')],
  ['is-danger', 'ui/assets/scripts/20-runtime.js', (s) => s.includes("toggle('is-danger'")],
  ['isRevealable tilde', 'ui/assets/scripts/55-platforms.js', (s) => s.includes("s === '~'") || s.includes("s.startsWith('~/')")],
  ['cursorOpenStats', 'ui/assets/scripts/55-platforms.js', (s) => {
    const i = s.indexOf('function cursorOpenStats');
    return i >= 0 && s.slice(i, i + 300).includes("openProxyPanel('stats')");
  }],
  ['proxy tab stats', 'ui-src/partials/pages/proxy.html', (s) => s.includes('data-proxy-panel="stats"')],
  ['proxy tab logs', 'ui-src/partials/pages/proxy.html', (s) => s.includes('data-proxy-panel="logs"')],
  ['proxyStatsMount', 'ui-src/partials/pages/proxy.html', (s) => s.includes('proxyStatsMount')],
  ['css mount', 'ui/assets/styles/50-platforms.css', (s) => s.includes('.proxy-stats-mount')],
  ['rust expand_user_path', 'src-tauri/src/commands/system.rs', (s) => s.includes('fn expand_user_path')],
];

let ok = 0;
let fail = 0;
for (const [name, path, fn] of checks) {
  if (!existsSync(path)) {
    console.log('MISS FILE', name, path);
    fail++;
    continue;
  }
  const s = readFileSync(path, 'utf8');
  const pass = !!fn(s);
  console.log(pass ? 'OK  ' : 'NEED', name);
  if (pass) ok++;
  else fail++;
}
console.log(`\n${ok} ok / ${fail} need`);
