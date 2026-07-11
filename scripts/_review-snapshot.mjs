import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const css = readFileSync('ui/assets/styles/50-platforms.css', 'utf8');
const a = css.indexOf('.platform-console-actions .platform-proxy-primary');
console.log('=== CSS platform buttons ===');
console.log(css.slice(a, a + 1800));
console.log('has platform-refresh-proxy', css.includes('.platform-refresh-proxy'));
console.log('has danger-dim', css.includes('background: var(--danger-dim)'));

const models = readFileSync('ui-src/partials/pages/models.html', 'utf8');
console.log('models refresh', (models.match(/proxyRefreshBtn[^>]*/)||[])[0]);
console.log('models restore', (models.match(/proxyRestoreBtn[^>]*/)||[])[0]);
console.log('models git', execSync('git status --short -- ui-src/partials/pages/models.html', {encoding:'utf8'}) || '(clean)');

const idx = readFileSync('ui/index.html', 'utf8');
console.log('index refresh', (idx.match(/proxyRefreshBtn[^>]*/)||[])[0]);
console.log('index restore', (idx.match(/proxyRestoreBtn[^>]*/)||[])[0]);
console.log('overview', idx.includes('platform-panel-overview'));
console.log('analytics count', (idx.match(/class="proxy-analytics"/g)||[]).length);
console.log('logs panel count', (idx.match(/proxy-logs-panel/g)||[]).length);
console.log('logFilterBtn', idx.includes('id="logFilterBtn"'));
console.log('cycleLogFilter', idx.includes('cycleLogFilter'));
console.log('proxyStatsMount', idx.includes('proxyStatsMount'));
console.log('proxyLogsMount', idx.includes('proxyLogsMount'));

// check if stats tab double-calls refresh
const shell = readFileSync('ui/assets/scripts/10-shell.js', 'utf8');
const i = shell.indexOf('function activateProxyPanel');
console.log('=== activateProxyPanel snippet ===');
console.log(shell.slice(i, i + 900));

// cycleLogFilter edge: indexOf -1
const logs = readFileSync('ui/assets/scripts/state/logs.js', 'utf8');
const j = logs.indexOf('function cycleLogFilter');
console.log('=== cycleLogFilter ===');
console.log(logs.slice(j, j + 220));

// expand_user_path edge cases
const rust = readFileSync('src-tauri/src/commands/system.rs', 'utf8');
const k = rust.indexOf('fn expand_user_path');
console.log('=== expand_user_path ===');
console.log(rust.slice(k, k + 700));

// CSS vars used
const foundation = readFileSync('ui/assets/styles/00-foundation.css', 'utf8');
for (const v of ['--danger', '--danger-dim', '--accent', '--accent-light', '--text-muted', '--text-tertiary', '--success']) {
  console.log(v, foundation.includes(v) || css.includes(v) ? 'defined/used' : 'MISSING');
}
// more precise: definition in foundation
for (const v of ['--danger:', '--danger-dim:', '--accent:', '--accent-light:', '--text-muted:', '--text-tertiary:', '--success:']) {
  console.log('def', v, foundation.includes(v));
}
