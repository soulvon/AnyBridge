/**
 * 深挖平台三按钮默认色 / 状态色丢失原因
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function sh(c) {
  try {
    return execSync(c, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || '';
  }
}

// 1) be9e855 对按钮相关的 diff 摘要
console.log('=== be9e855 commit message / files ===');
console.log(sh('git show be9e855 --stat --oneline').split(/\r?\n/).slice(0, 40).join('\n'));

console.log('\n=== be9e855 button-related diff (filtered) ===');
const diff = sh('git show be9e855 -- ui/assets/styles ui/index.html');
const lines = diff.split(/\r?\n/).filter((l) =>
  /btn-primary|platform-proxy|platform-stop|is-connected|is-danger|proxyBtn|刷新|停止|一键|proxy-btn|\.btn-ghost|platform-console-actions/.test(l),
);
console.log(lines.slice(0, 120).join('\n'));

// 2) 当前 btn-primary / platform button CSS
const styleFiles = [
  'ui/assets/styles/00-tokens.css',
  'ui/assets/styles/10-base.css',
  'ui/assets/styles/20-layout.css',
  'ui/assets/styles/30-components.css',
  'ui/assets/styles/40-providers.css',
  'ui/assets/styles/50-platforms.css',
  'ui/assets/styles/60-settings.css',
].filter((f) => {
  try {
    readFileSync(f);
    return true;
  } catch {
    return false;
  }
});

// find all style files
const allStyles = sh('git ls-files ui/assets/styles').trim().split(/\r?\n/).filter(Boolean);
console.log('\nstyle files:', allStyles.join(', '));

for (const f of allStyles) {
  const c = readFileSync(f, 'utf8');
  if (/\.btn-primary|platform-proxy-primary|proxy-btn-action/.test(c)) {
    console.log(`\n=== matches in ${f} ===`);
    const re = /\.btn-primary[^{]*\{[^}]*\}|\.platform-console-actions[^{]*\{[^}]*\}|\.platform-proxy-primary[^{,\n]*[^{]*\{[^}]*\}|\.proxy-btn[^{,\n]*\{[^}]*\}/g;
    // simpler: print line ranges around keywords
    const keys = ['.btn-primary', 'platform-proxy-primary', 'proxy-btn-action', 'platform-stop-proxy', 'is-connected', 'is-danger'];
    for (const k of keys) {
      let idx = 0;
      let n = 0;
      while ((idx = c.indexOf(k, idx)) >= 0 && n < 3) {
        const start = c.lastIndexOf('\n', Math.max(0, idx - 30)) + 1;
        // extend to next few braces
        let end = idx;
        let braces = 0;
        let seen = false;
        for (let i = idx; i < Math.min(c.length, idx + 800); i++) {
          if (c[i] === '{') {
            braces++;
            seen = true;
          }
          if (c[i] === '}') {
            braces--;
            if (seen && braces === 0) {
              end = i + 1;
              break;
            }
          }
        }
        console.log(c.slice(start, end || idx + 200));
        console.log('---');
        idx = idx + k.length;
        n++;
      }
    }
  }
}

// 3) HTML class chain for proxyBtn historically
console.log('\n=== historical proxyBtn HTML ===');
for (const h of ['be9e855', 'a31944e', '7842a40', 'HEAD']) {
  const html = sh(`git show ${h}:ui/index.html`);
  const m = html.match(/id="proxyBtn"[^>]*>[\s\S]{0,200}/) || html.match(/class="[^"]*proxyBtn[^"]*"/);
  // better
  const m2 = html.match(/<button[^>]*id="proxyBtn"[^>]*>/);
  const m3 = html.match(/<button[^>]*id="proxyRefreshBtn"[^>]*>/);
  const m4 = html.match(/<button[^>]*id="proxyRestoreBtn"[^>]*>/);
  console.log(h, 'proxyBtn:', m2?.[0]);
  console.log(h, 'refresh:', m3?.[0]);
  console.log(h, 'restore:', m4?.[0]);
}

// 4) Check if btn-primary styles require something missing
console.log('\n=== btn-primary full rules from components ===');
for (const f of allStyles) {
  const c = readFileSync(f, 'utf8');
  if (!c.includes('.btn-primary')) continue;
  let idx = 0;
  while ((idx = c.indexOf('.btn-primary', idx)) >= 0) {
    const start = Math.max(0, c.lastIndexOf('\n', idx - 1) + 1);
    let end = idx;
    let braces = 0;
    let seen = false;
    for (let i = idx; i < Math.min(c.length, idx + 1200); i++) {
      if (c[i] === '{') {
        braces++;
        seen = true;
      }
      if (c[i] === '}') {
        braces--;
        if (seen && braces === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const block = c.slice(start, end);
    if (block.length < 500) console.log(f, block);
    idx = idx + 12;
  }
}
