/**
 * 深挖：按钮色 / 配置路径点击 / 代理 stats+logs 在历史中的真实形态
 * 用法: node scripts/_audit-features-detail.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

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

function show(rev, file) {
  const out = sh(`git show ${rev}:${file}`);
  if (!out || out.startsWith('fatal:')) return null;
  return out;
}

function snippetAround(text, needle, before = 120, after = 400) {
  if (!text) return null;
  const i = text.indexOf(needle);
  if (i < 0) return null;
  return text.slice(Math.max(0, i - before), i + after);
}

console.log('=== A. syncIdeProxyButton 历史对比 ===\n');
for (const rev of ['be9e855', 'a31944e', '7842a40^', '7842a40', '4765f60', 'HEAD']) {
  const rt = show(rev, 'ui/assets/scripts/20-runtime.js');
  const snip = snippetAround(rt, 'function syncIdeProxyButton', 0, 650);
  console.log('---', rev, '---');
  if (!snip) {
    console.log('(function not found)');
    continue;
  }
  const lines = snip.split(/\r?\n/).slice(0, 35);
  // only print classList / textContent related
  lines.forEach((l) => {
    if (/classList|textContent|disabled|is-danger|is-connected|restoreBtn|proxyBtn|function /.test(l)) {
      console.log(l);
    }
  });
}

console.log('\n=== B. bindRevealPathLabel 历史调用点 ===\n');
for (const rev of ['be9e855', 'a31944e', '7842a40', '4765f60', 'db1dd79', 'HEAD']) {
  const p = show(rev, 'ui/assets/scripts/55-platforms.js');
  if (!p) {
    console.log(rev, 'no platforms.js');
    continue;
  }
  const calls = [...p.matchAll(/bindRevealPathLabel\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const hasFn = p.includes('function bindRevealPathLabel');
  const hasReveal = p.includes('function revealConfigPath');
  console.log(rev, { hasFn, hasReveal, calls });
}

console.log('\n=== C. 当前 HTML 配置路径 code 标签上下文 ===\n');
const index = readFileSync('ui/index.html', 'utf8');
const ids = [
  'codex-config-path-label',
  'claude-code-config-path-label',
  'opencode-config-path-label',
  'cb-config-path-label',
  'wb-config-path-label',
  'zc-config-path-label',
];
for (const id of ids) {
  const snip = snippetAround(index, `id="${id}"`, 80, 200);
  console.log('---', id, '---');
  console.log(snip ? snip.replace(/\s+/g, ' ').trim() : '(missing)');
}

console.log('\n=== D. 当前 CSS 按钮状态类 ===\n');
const css = readFileSync('ui/assets/styles/50-platforms.css', 'utf8');
for (const needle of [
  '.platform-proxy-primary.is-connected',
  '.platform-stop-proxy.is-danger',
  'proxyRefreshBtn',
  'platform-console-actions',
]) {
  const snip = snippetAround(css, needle, 0, 180);
  console.log(needle, snip ? 'FOUND' : 'MISSING');
  if (snip) console.log(snip.split(/\r?\n/).slice(0, 8).join('\n'), '\n');
}

console.log('\n=== E. models.html 按钮 class 现状 ===\n');
const models = readFileSync('ui-src/partials/pages/models.html', 'utf8');
const btnBlock = snippetAround(models, 'proxyRefreshBtn', 100, 350);
console.log(btnBlock || '(not found)');

console.log('\n=== F. 4765f60 (HTML split) 是否改了 proxy tabs ===\n');
const d = sh('git show 4765f60 --stat -- ui/index.html ui-src/');
console.log(d.split(/\r?\n/).slice(0, 40).join('\n'));
const diffTabs = sh('git show 4765f60 -- ui/index.html');
const tabLines = diffTabs
  .split(/\r?\n/)
  .filter((l) => /proxy-console-tab|data-proxy-panel|统计|日志|tab-overview|is-danger|config-path/.test(l))
  .slice(0, 50);
console.log('tab-related diff lines:', tabLines.length);
tabLines.forEach((l) => console.log(l));

console.log('\n=== G. 7842a40 index 里统计相关 diff ===\n');
const d2 = sh('git show 7842a40 -- ui/index.html');
const lines2 = d2
  .split(/\r?\n/)
  .filter((l) => /统计|日志|tab-overview|proxy-console-tab|data-proxy-panel|extensions|扩展/.test(l))
  .slice(0, 80);
lines2.forEach((l) => console.log(l));

console.log('\nDONE');
