import { execSync } from 'child_process';
import fs from 'fs';

// Find commits that had stats/logs proxy tabs
const revs = execSync('git rev-list --all -- ui/index.html', { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .slice(0, 80);

const hits = [];
for (const rev of revs) {
  try {
    const html = execSync(`git show ${rev}:ui/index.html`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const hasStatsTab = /data-proxy-panel=["']stats["']/.test(html) || /proxy-console-tab[^>]*>统计</.test(html);
    const hasLogsTab = /data-proxy-panel=["']logs["']/.test(html) || /proxy-console-tab[^>]*>日志</.test(html);
    if (hasStatsTab || hasLogsTab) {
      const subj = execSync(`git log -1 --format=%s ${rev}`, { encoding: 'utf8' }).trim();
      hits.push({ rev: rev.slice(0, 7), subj, hasStatsTab, hasLogsTab });
    }
  } catch {}
}
console.log('commits with stats/logs proxy tabs:', hits.length);
for (const h of hits.slice(0, 20)) console.log(JSON.stringify(h));

// Also check 7842a40 parent vs 7842a40 for proxy-console-tabs block
for (const rev of ['7842a40^', '7842a40', 'be9e855', '5721631', '5b73b6d']) {
  try {
    const html = execSync(`git show ${rev}:ui/index.html`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = html.match(/class="proxy-console-tabs"[\s\S]{0,1200}/);
    console.log('\n====', rev, '====');
    console.log(m ? m[0].slice(0, 700) : 'NO TABS BLOCK');
  } catch (e) {
    console.log(rev, 'fail', String(e.message).slice(0, 80));
  }
}

// Extract missing platform handlers from 55-platforms
const plat = fs.readFileSync('ui/assets/scripts/55-platforms.js', 'utf8');
for (const name of [
  'applyCbJson',
  'applyWbJson',
  'exportCbModels',
  'exportWbModels',
  'formatCbJson',
  'formatWbJson',
  'formatZcJson',
  'importCbModels',
  'importWbModels',
  'toggleCbJsonEditor',
  'toggleWbJsonEditor',
  'cycleLogFilter',
]) {
  console.log(name, 'in platforms?', plat.includes(`function ${name}`) || plat.includes(`${name} =`));
}
