import { execSync } from 'child_process';
import fs from 'fs';

const commits = ['a31944e', '771c7f3', 'f3b8803', '4765f60', 'HEAD'];
for (const c of commits) {
  try {
    const html = execSync(`git show ${c}:ui/index.html`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const m = html.match(/class="proxy-console-tabs"[\s\S]{0,800}/);
    console.log('\n====', c, 'tabs ====');
    console.log(m ? m[0].slice(0, 500) : 'NO TABS');
    console.log('has stats tab', html.includes('data-proxy-panel="stats"'));
    console.log('has logs tab', html.includes('data-proxy-panel="logs"'));
    console.log('has stats section', html.includes('data-proxy-section="stats"'));
    console.log('has logs section', html.includes('data-proxy-section="logs"'));
  } catch (e) {
    console.log(c, 'fail', e.message.slice(0, 100));
  }
}

// extract full stats/logs sections from a commit that has them
const src = execSync('git show a31944e:ui/index.html', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const tabs = src.match(/<div class="proxy-console-tabs"[\s\S]*?<\/div>/);
fs.writeFileSync('scripts/_tmp-proxy-tabs.html', tabs ? tabs[0] : 'none');

// find stats section
const statsStart = src.indexOf('data-proxy-section="stats"');
const logsStart = src.indexOf('data-proxy-section="logs"');
console.log('\nstatsStart', statsStart, 'logsStart', logsStart);
if (statsStart > 0) {
  // walk back to section open
  const s0 = src.lastIndexOf('<div class="proxy-console-section"', statsStart);
  // find next section or end of page-proxy-ish
  let s1 = src.indexOf('data-proxy-section="logs"', statsStart);
  if (s1 < 0) s1 = src.indexOf('</div>\n        </div>\n', statsStart);
  // better: find section start for logs
  const logsSec = src.lastIndexOf('<div class="proxy-console-section"', logsStart);
  const afterLogs = src.indexOf('<div class="proxy-console-section"', logsSec + 10);
  // end of logs section: find matching - use next sibling section or end marker
  // extract from stats section start to end of logs section
  // find end of logs by searching for next major page or closing of page-proxy
  const pageEnd = src.indexOf('id="page-platform-cursor"', logsStart);
  const chunk = src.slice(s0, pageEnd > 0 ? pageEnd : s0 + 5000);
  fs.writeFileSync('scripts/_tmp-proxy-stats-logs.html', chunk.slice(0, 15000));
  console.log('wrote chunk len', chunk.length);
}
