/**
 * 对比平台按钮颜色相关历史
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function sh(c) {
  try {
    return execSync(c, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || String(e.message || e);
  }
}

const markers = [
  'platform-proxy-primary',
  'platform-stop-proxy',
  'proxyRefreshBtn',
  'proxyRestoreBtn',
  'is-connected',
  'is-danger',
  'platform-console-actions',
];

console.log('=== current CSS snippets ===');
const css = readFileSync('ui/assets/styles/50-platforms.css', 'utf8');
for (const m of markers) {
  const idx = css.indexOf(m);
  if (idx < 0) {
    console.log(m, 'NOT IN CSS');
    continue;
  }
  // print surrounding rule-ish block
  const start = Math.max(0, css.lastIndexOf('\n', idx - 80));
  console.log('\n---', m, '---');
  console.log(css.slice(start, start + 350));
}

console.log('\n=== git log pickaxe button colors ===');
console.log(sh('git log --oneline -S "is-connected" -n 15 -- ui/assets/styles ui/assets/scripts'));
console.log(sh('git log --oneline -S "platform-proxy-primary" -n 15 -- ui'));
console.log(sh('git log --oneline -S "platform-stop-proxy" -n 15 -- ui'));

// compare be9e855 vs HEAD for button-related CSS
const commits = ['be9e855', 'a31944e', '7842a40', 'HEAD'];
for (const h of commits) {
  console.log(`\n=== ${h} CSS button rules ===`);
  let content = '';
  try {
    content = sh(`git show ${h}:ui/assets/styles/50-platforms.css`);
  } catch {
    content = '';
  }
  if (!content || content.startsWith('fatal')) {
    // try older path
    content = sh(`git show ${h}:ui/assets/styles/50-platforms.css 2>nul`) || '';
  }
  if (!content || content.includes('fatal:')) {
    console.log('no 50-platforms.css');
    // search in index or other css
    const files = sh(`git ls-tree -r --name-only ${h} -- ui/assets/styles`).trim().split(/\r?\n/).filter(Boolean);
    console.log('style files', files.join(', '));
    for (const f of files) {
      const c = sh(`git show ${h}:${f}`);
      if (c.includes('platform-proxy-primary') || c.includes('is-connected') || c.includes('proxyBtn')) {
        console.log('found in', f);
        const i = c.indexOf('platform-proxy-primary');
        if (i >= 0) console.log(c.slice(Math.max(0, i - 50), i + 500));
        const j = c.indexOf('is-connected');
        if (j >= 0) console.log(c.slice(Math.max(0, j - 50), j + 400));
      }
    }
    continue;
  }
  for (const key of ['platform-proxy-primary', 'platform-stop-proxy', 'is-connected', 'is-danger', 'proxy-btn']) {
    if (content.includes(key)) console.log('has', key);
    else console.log('miss', key);
  }
  const i = content.indexOf('.platform-console-actions');
  if (i >= 0) console.log(content.slice(i, i + 900));
}

// HTML button classes now
console.log('\n=== current HTML buttons ===');
const models = existsSync('ui-src/partials/pages/models.html')
  ? readFileSync('ui-src/partials/pages/models.html', 'utf8')
  : '';
const re = /id="proxy(Btn|RefreshBtn|RestoreBtn)"[^>]*>/g;
let m;
while ((m = re.exec(models))) console.log(m[0]);
// broader
const re2 = /proxyBtn|proxyRefreshBtn|proxyRestoreBtn|一键接入|刷新状态|停止接入/g;
const hits = [...models.matchAll(/<button[^>]*(?:proxyBtn|proxyRefreshBtn|proxyRestoreBtn|一键接入|刷新状态|停止接入)[^>]*>[\s\S]*?<\/button>/g)];
hits.slice(0, 10).forEach((h) => console.log(h[0].slice(0, 300)));
