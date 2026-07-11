/**
 * 精确查：isRevealablePath、按钮完整 classList 逻辑、a31944e..7842a40 丢功能点
 * 用法: node scripts/_audit-precise-loss.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function sh(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
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

console.log('=== parents of 7842a40 ===');
console.log(sh('git log --oneline -5 7842a40'));
console.log(sh('git rev-parse 7842a40^'));
console.log(sh('git log --oneline a31944e..7842a40'));

console.log('\n=== which commit removed is-danger / cycleLogFilter / tab-overview ===');
for (const needle of [
  "classList.toggle('is-danger'",
  'function cycleLogFilter',
  'tab-overview',
  'id="tab-overview"',
]) {
  console.log('\nneedle:', needle);
  console.log(sh(`git log --oneline -S "${needle.replace(/"/g, '\\"')}" -- ui/assets/scripts/20-runtime.js ui/index.html -n 10`));
}

console.log('\n=== full syncIdeProxyButton from be9e855 ===');
const be = show('be9e855', 'ui/assets/scripts/20-runtime.js') || '';
const i = be.indexOf('function syncIdeProxyButton');
console.log(be.slice(i, i + 900));

console.log('\n=== full syncIdeProxyButton from HEAD worktree ===');
const now = readFileSync('ui/assets/scripts/20-runtime.js', 'utf8');
const j = now.indexOf('function syncIdeProxyButton');
console.log(now.slice(j, j + 900));

console.log('\n=== isRevealablePath + bindRevealPathLabel full ===');
const p = readFileSync('ui/assets/scripts/55-platforms.js', 'utf8');
const a = p.indexOf('function isRevealablePath');
const b = p.indexOf('function bindRevealPathLabel');
console.log(p.slice(a, a + 200));
console.log(p.slice(b, b + 280));

// when is cbApplyConfigMeta / prefix bind called
const c = p.indexOf('bindRevealPathLabel(`${prefix}');
console.log('\nprefix bind context:\n', p.slice(c - 400, c + 180));

// Does renderCodeBuddyModels / load set path label without bind?
console.log('\ncb-config-path-label text assignments:');
const lines = p.split(/\r?\n/);
lines.forEach((l, idx) => {
  if (/config-path-label|configPath|cbConfigPath|wbConfigPath|zcConfigPath/.test(l) && /textContent|bindReveal|getElementById/.test(l)) {
    console.log(`${idx + 1}|${l.trim()}`);
  }
});

console.log('\n=== platform button CSS selectors vs HTML classes ===');
const models = readFileSync('ui-src/partials/pages/models.html', 'utf8');
const btnArea = models.slice(models.indexOf('platform-console-actions') >= 0 ? models.indexOf('platform-console-actions') : models.indexOf('proxyBtn') - 200, models.indexOf('proxyRestoreBtn') + 200);
console.log(btnArea);

const css = readFileSync('ui/assets/styles/50-platforms.css', 'utf8');
const cssI = css.indexOf('.platform-console-actions .platform-proxy-primary');
console.log('\nCSS primary block:\n', css.slice(cssI, cssI + 500));

// Does proxyBtn have platform-proxy-primary class?
console.log('\nproxyBtn class in models:', (models.match(/id="proxyBtn"[^>]*>/) || [])[0]);
console.log('proxyRestoreBtn class:', (models.match(/id="proxyRestoreBtn"[^>]*>/) || [])[0]);
console.log('proxyRefreshBtn class:', (models.match(/id="proxyRefreshBtn"[^>]*>/) || [])[0]);

// be9e855 button classes
const beHtml = show('be9e855', 'ui/index.html') || '';
console.log('\nbe9e855 proxyBtn:', (beHtml.match(/id="proxyBtn"[^>]*>/) || [])[0]);
console.log('be9e855 restore:', (beHtml.match(/id="proxyRestoreBtn"[^>]*>/) || [])[0]);
console.log('be9e855 refresh:', (beHtml.match(/id="proxyRefreshBtn"[^>]*>/) || [])[0]);

console.log('\nDONE');
