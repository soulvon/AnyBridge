/**
 * 深挖：reveal-path CSS、cb/wb/zc 绑定、按钮 HTML class、未入库改动窗口
 * 用法: node scripts/_audit-reveal-and-buttons.mjs
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

function snip(text, needle, after = 300) {
  if (!text) return null;
  const i = text.indexOf(needle);
  if (i < 0) return null;
  return text.slice(i, i + after);
}

console.log('=== 1) .reveal-path CSS 是否存在 ===\n');
const cssFiles = [
  'ui/assets/styles/50-platforms.css',
  'ui/assets/styles/30-pages.css',
  'ui/assets/styles/10-shell.css',
  'ui/assets/styles/00-foundation.css',
  'ui/assets/app.css',
];
for (const f of cssFiles) {
  if (!existsSync(f)) continue;
  const t = readFileSync(f, 'utf8');
  const n = (t.match(/reveal-path/g) || []).length;
  console.log(f, 'reveal-path count=', n);
  if (n) console.log(snip(t, 'reveal-path', 400), '\n');
}

// also search all css
const allCss = sh('git grep -n "reveal-path" -- "*.css" || true');
console.log('git grep reveal-path css:\n', allCss || '(none)');

console.log('\n=== 2) bindRevealPathLabel 调用上下文 (prefix) ===\n');
const platforms = readFileSync('ui/assets/scripts/55-platforms.js', 'utf8');
const lines = platforms.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('bindRevealPathLabel')) {
    const from = Math.max(0, i - 8);
    const to = Math.min(lines.length, i + 5);
    console.log(`--- around L${i + 1} ---`);
    for (let j = from; j < to; j++) console.log(`${j + 1}|${lines[j]}`);
  }
}

console.log('\n=== 3) isRevealablePath 实现 ===\n');
console.log(snip(platforms, 'function isRevealablePath', 350));

console.log('\n=== 4) models 页按钮 HTML class 历史 ===\n');
for (const rev of ['be9e855', 'a31944e', '7842a40', '4765f60', 'HEAD']) {
  const html = show(rev, 'ui/index.html') || '';
  const block = snip(html, 'proxyRefreshBtn', 500) || snip(html, 'id="proxyBtn"', 500);
  console.log('---', rev, '---');
  if (!block) {
    console.log('(not found)');
    continue;
  }
  // compact
  console.log(
    block
      .replace(/\s+/g, ' ')
      .replace(/</g, '\n<')
      .split('\n')
      .filter((l) => /button|proxyBtn|proxyRefresh|proxyRestore|class=|一键|刷新|停止/.test(l))
      .slice(0, 15)
      .join('\n'),
  );
}

console.log('\n=== 5) a31944e..7842a40 之间是否有未合并的本地痕迹（reflog）===\n');
const reflog = sh('git reflog --date=iso -30');
console.log(reflog.split(/\r?\n/).slice(0, 30).join('\n'));

console.log('\n=== 6) stash 列表 ===\n');
console.log(sh('git stash list') || '(empty)');

console.log('\n=== 7) 搜索全仓库历史 data-proxy-panel=stats/logs（限 pickaxe）===\n');
console.log('stats panel commits:');
console.log(sh('git log --oneline --all -S "data-proxy-panel=\\"stats\\"" -n 20') || '(none)');
console.log('logs panel commits:');
console.log(sh('git log --oneline --all -S "data-proxy-panel=\\"logs\\"" -n 20') || '(none)');
console.log('proxy-console-tab 统计:');
console.log(sh('git log --oneline --all -G "proxy-console-tab.*>统计" -n 20') || '(none)');
console.log('proxy-console-tab 日志:');
console.log(sh('git log --oneline --all -G "proxy-console-tab.*>日志" -n 20') || '(none)');

console.log('\n=== 8) activateProxyPanel 何时加入 stats/logs ===\n');
console.log(sh('git log --oneline -S "validPanels" -- ui/assets/scripts/10-shell.js -n 15') || '(none)');
for (const rev of ['be9e855', 'a31944e', '7842a40^', '7842a40', 'HEAD']) {
  const shell = show(rev, 'ui/assets/scripts/10-shell.js') || '';
  const sn = snip(shell, 'function activateProxyPanel', 280);
  console.log(rev, sn ? sn.replace(/\s+/g, ' ').slice(0, 220) : 'no activateProxyPanel');
}

console.log('\n=== 9) 当前 uncommitted is-danger 行 ===\n');
console.log(sh('git diff -- ui/assets/scripts/20-runtime.js'));

console.log('\nDONE');
