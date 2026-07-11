import { execSync } from 'child_process';

function show(rev) {
  const html = execSync(`git show ${rev}:ui/index.html`, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // top nav block
  const start = html.indexOf('class="top-nav"');
  const alt = html.indexOf('class="tab-item');
  const i = start >= 0 ? start : alt;
  console.log('\n====', rev, 'nav block ====');
  console.log(html.slice(i, i + 1800));

  // settings gear?
  console.log('settings gear/btn:', /tab-settings|data-page="settings"|openSettings|settings-btn|topbar.*settings/i.test(html));
  console.log('page-platform-proxy:', html.includes('id="page-platform-proxy"'));
  console.log('page-settings:', html.includes('id="page-settings"'));
}

for (const rev of ['be9e855', 'a31944e', '7842a40^', '7842a40', 'HEAD']) {
  try { show(rev); } catch (e) { console.log(rev, e.message.slice(0, 80)); }
}

// when was 统计 tab removed
const log = execSync('git log --oneline -S "统计" -- ui/index.html', { encoding: 'utf8' });
console.log('\ncommits touching 统计 in index:', log);
