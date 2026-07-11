import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || e.message || '';
  }
}

function tabsFrom(html) {
  const out = [];
  const re = /id="(tab-[^"]+)"([^>]*)>[\s\S]*?<span>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    const page = (attrs.match(/data-page="([^"]+)"/) || [])[1] || '';
    const sec = (attrs.match(/data-platform-section="([^"]+)"/) || [])[1] || '';
    out.push({ id: m[1], page, sec, label: m[3] });
  }
  return out;
}

const hist = sh('git show be9e855:ui/index.html');
const parent = sh('git show 7842a40^:ui/index.html');
const cur = readFileSync('ui/index.html', 'utf8');
const src = readFileSync('ui-src/index.html', 'utf8');

console.log('=== TOP TABS ===');
console.log('be9e855:', tabsFrom(hist).map((t) => `${t.label}(${t.page}${t.sec ? '/' + t.sec : ''})`).join(' | '));
console.log('7842a40^:', tabsFrom(parent).map((t) => `${t.label}(${t.page}${t.sec ? '/' + t.sec : ''})`).join(' | '));
console.log('current ui:', tabsFrom(cur).map((t) => `${t.label}(${t.page}${t.sec ? '/' + t.sec : ''})`).join(' | '));
console.log('current ui-src:', tabsFrom(src).map((t) => `${t.label}(${t.page}${t.sec ? '/' + t.sec : ''})`).join(' | '));

const rtNow =
  readFileSync('ui/assets/scripts/20-runtime.js', 'utf8') +
  '\n' +
  readFileSync('ui/assets/scripts/state/logs.js', 'utf8');
const rtHist = sh('git show be9e855:ui/assets/scripts/20-runtime.js');
const shellNow = readFileSync('ui/assets/scripts/10-shell.js', 'utf8');
const platforms = readFileSync('ui/assets/scripts/55-platforms.js', 'utf8');
const pp = readFileSync('ui-src/partials/pages/platform-proxy.html', 'utf8');
const proxy = readFileSync('ui-src/partials/pages/proxy.html', 'utf8');

const checks = [
  ['cycleLogFilter defined (hist)', /function cycleLogFilter/.test(rtHist)],
  ['cycleLogFilter defined (now)', /function cycleLogFilter|export function cycleLogFilter/.test(rtNow)],
  ['setLogFilter defined (now)', /function setLogFilter|export function setLogFilter/.test(rtNow)],
  ['is-danger toggle (now, uncommitted fix)', /classList\.toggle\('is-danger'/.test(rtNow)],
  ['is-connected toggle (now)', /classList\.(add|toggle)\('is-connected'/.test(rtNow)],
  ['renderProxyStats call site (shell)', shellNow.includes('renderProxyStats')],
  ['renderProxyStats function exists', /function renderProxyStats|renderProxyStats\s*=/.test(rtNow + shellNow + platforms)],
  ['platform-proxy page exists', pp.includes('page-platform-proxy') || pp.includes('id="page-platform-proxy"') || true],
  ['platform-proxy has 全局代理统计', pp.includes('全局代理统计')],
  ['platform-proxy has fullLog', pp.includes('id="fullLog"')],
  ['platform-proxy has cycleLogFilter btn', pp.includes('cycleLogFilter')],
  ['proxy page tabs', [...proxy.matchAll(/data-proxy-panel="([^"]+)"/g)].map((m) => m[1]).join(',')],
  ['activateProxyPanel supports stats/logs', /validPanels = new Set\(\[[^\]]*stats[^\]]*logs/.test(shellNow) || shellNow.includes("'stats'") && shellNow.includes("'logs'")],
  ['createCbIoHandlers factory', platforms.includes('function createCbIoHandlers')],
  ['exportCbModels via factory', platforms.includes("window['export' + prefix + 'Models']")],
  ['formatZcJson override', platforms.includes('formatZcJson') || platforms.includes("window['format' + prefix + 'Json']")],
  ['top tab 统计 present now', /tab-overview|span>统计</.test(src)],
  ['top tab 扩展 present now', src.includes('tab-extensions') || src.includes('>扩展<')],
];

console.log('\n=== CHECKS ===');
for (const [k, v] of checks) console.log(String(v).padEnd(40), k);

// Where was 统计 tab removed?
console.log('\n=== 统计 tab history ===');
const commits = sh('git log --oneline -20 -- ui-src/index.html ui/index.html').trim().split(/\r?\n/).slice(0, 15);
for (const line of commits) {
  const hash = line.split(' ')[0];
  const html = sh(`git show ${hash}:ui/index.html`);
  if (!html || html.startsWith('fatal')) continue;
  const hasStats = /span>统计</.test(html) || /tab-overview/.test(html);
  const hasExt = /span>扩展</.test(html) || /tab-extensions/.test(html);
  console.log(hash, '统计=', hasStats, '扩展=', hasExt, line.slice(8, 60));
}

// cursorOpenStats target
const cursorOpen = platforms.match(/function cursorOpenStats[\s\S]{0,400}/);
console.log('\n=== cursorOpenStats ===');
console.log(cursorOpen ? cursorOpen[0].slice(0, 350) : 'NOT FOUND');

// openPlatformSection overview path
const openSec = shellNow.match(/function openPlatformSection[\s\S]{0,350}/);
console.log('\n=== openPlatformSection ===');
console.log(openSec ? openSec[0].slice(0, 300) : 'NOT FOUND');

// uncommitted diff summary
console.log('\n=== uncommitted ===');
console.log(sh('git diff --stat'));
