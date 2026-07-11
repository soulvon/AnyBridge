/**
 * 对比 ui/index.html.baseline 与当前，找丢失的统计/日志 tab、按钮 class、路径点击
 * 用法: node scripts/_audit-baseline-diff.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

function sh(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    return e.stdout || '';
  }
}

const basePath = 'ui/index.html.baseline';
const curPath = 'ui/index.html';
if (!existsSync(basePath)) {
  console.log('NO baseline file');
  process.exit(0);
}

const base = readFileSync(basePath, 'utf8');
const cur = readFileSync(curPath, 'utf8');

console.log('baseline size', base.length, 'current size', cur.length);

function proxyTabs(html) {
  const tabs = [];
  const re = /data-proxy-panel="([^"]+)"[^>]*>([^<]*)</g;
  let m;
  while ((m = re.exec(html))) tabs.push(`${m[1]}:${m[2].trim()}`);
  return tabs;
}
function topTabs(html) {
  const out = [];
  const re = /id="(tab-[^"]+)"([^>]*)>[\s\S]*?<span>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[3]);
  return out;
}

console.log('\n=== top tabs ===');
console.log('baseline:', topTabs(base).join(' | '));
console.log('current :', topTabs(cur).join(' | '));

console.log('\n=== proxy tabs ===');
console.log('baseline:', proxyTabs(base).join(', '));
console.log('current :', proxyTabs(cur).join(', '));

const markers = [
  'data-proxy-panel="stats"',
  'data-proxy-panel="logs"',
  'data-proxy-section="stats"',
  'data-proxy-section="logs"',
  'tab-overview',
  'cycleLogFilter',
  'is-danger',
  'is-connected',
  'reveal-path',
  'revealConfigPath',
  'bindRevealPathLabel',
  'proxy-btn-text',
  'platform-proxy-primary',
  'platform-stop-proxy',
  'stat-requests',
  'fullLog',
  'analyticsLogEntryCount',
  'page-platform-proxy',
];

console.log('\n=== marker presence ===');
for (const m of markers) {
  console.log(`${m.padEnd(32)} base=${base.includes(m)} cur=${cur.includes(m)}`);
}

// extract proxy console tabs block from both
function block(html, startNeedle, len = 800) {
  const i = html.indexOf(startNeedle);
  if (i < 0) return null;
  return html.slice(i, i + len);
}

console.log('\n=== baseline proxy-console-tabs ===');
console.log(block(base, 'proxy-console-tabs', 900));
console.log('\n=== current proxy-console-tabs ===');
console.log(block(cur, 'proxy-console-tabs', 900));

// button block
console.log('\n=== baseline proxy buttons ===');
console.log(block(base, 'proxyRefreshBtn', 600)?.replace(/\s+/g, ' '));
console.log('\n=== current proxy buttons ===');
console.log(block(cur, 'proxyRefreshBtn', 600)?.replace(/\s+/g, ' '));

// config path labels with surrounding attrs
const ids = [
  'codex-config-path-label',
  'claude-code-config-path-label',
  'opencode-config-path-label',
  'cb-config-path-label',
  'wb-config-path-label',
  'zc-config-path-label',
];
console.log('\n=== config path code tags ===');
for (const id of ids) {
  for (const [name, html] of [
    ['base', base],
    ['cur', cur],
  ]) {
    const re = new RegExp(`<code[^>]*id="${id}"[^>]*>[^<]*</code>`, 'i');
    const m = html.match(re);
    console.log(name, id, m ? m[0] : '(missing)');
  }
}

// git log for baseline file
console.log('\n=== is baseline tracked? ===');
console.log(sh('git ls-files ui/index.html.baseline') || '(untracked)');
console.log(sh('git log --oneline -5 -- ui/index.html.baseline') || '(no log)');
console.log(sh('git check-ignore -v ui/index.html.baseline') || '(not ignored or no check)');

// when was baseline modified
try {
  const { statSync } = await import('node:fs');
  const st = statSync(basePath);
  console.log('baseline mtime', st.mtime.toISOString(), 'size', st.size);
  const st2 = statSync(curPath);
  console.log('current  mtime', st2.mtime.toISOString(), 'size', st2.size);
} catch (e) {
  console.log(e.message);
}

// diff line counts roughly by unique lines
function lineSet(html) {
  return new Set(html.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}
const bs = lineSet(base);
const cs = lineSet(cur);
let onlyBase = 0;
let onlyCur = 0;
for (const l of bs) if (!cs.has(l)) onlyBase++;
for (const l of cs) if (!bs.has(l)) onlyCur++;
console.log('\napprox unique trimmed lines only-in-baseline', onlyBase, 'only-in-current', onlyCur);

// show only-in-baseline lines that look feature-related
const featureRe = /统计|日志|stats|logs|is-danger|is-connected|reveal|config-path|proxy-console-tab|一键接入|停止接入|刷新状态/;
console.log('\n=== only-in-baseline feature-ish lines (sample) ===');
let n = 0;
for (const l of bs) {
  if (!cs.has(l) && featureRe.test(l)) {
    console.log(l.slice(0, 200));
    if (++n >= 60) break;
  }
}
console.log('shown', n);

console.log('\nDONE');
