import { execSync } from 'child_process';
import fs from 'fs';

// 1) Top nav tabs before/after 7842a40
for (const rev of ['7842a40^', '7842a40', 'be9e855', 'HEAD']) {
  try {
    const html = execSync(`git show ${rev}:ui/index.html`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const nav = html.match(/class="top-nav"[\s\S]{0,2500}/) || html.match(/tab-item[\s\S]{0,2000}/);
    console.log('\n==== NAV', rev, '====');
    // extract tab labels
    const labels = [...html.matchAll(/class="tab-item[^"]*"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m => m[1]);
    const dataPages = [...html.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]);
    console.log('labels:', labels);
    console.log('data-pages unique:', [...new Set(dataPages)].slice(0, 30));
    console.log('has page-stats', html.includes('id="page-stats"') || html.includes('id="page-analytics"'));
    console.log('has tab-stats', /data-page="stats"|data-page="analytics"|id="tab-stats"/.test(html));
    console.log('has tab-extensions', /data-page="extensions"|id="tab-extensions"/.test(html));
  } catch (e) {
    console.log(rev, 'fail', String(e.message).slice(0, 100));
  }
}

// 2) Extract old stats tab + page from parent of 7842a40
const parent = execSync('git show 7842a40^:ui/index.html', {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
// find 统计 in top nav context
const idx = parent.indexOf('>统计<');
console.log('\n统计 context around', idx);
if (idx > 0) console.log(parent.slice(Math.max(0, idx - 400), idx + 200));

// find page that was stats
for (const id of ['page-stats', 'page-analytics', 'page-proxy-stats', 'page-logs']) {
  console.log(id, parent.includes(`id="${id}"`));
}

// search for analytics
const m = parent.match(/id="page-[^"]*"[^>]*>[\s\S]{0,80}统计/);
console.log('page near 统计', m && m[0].slice(0, 200));

// 3) missing platform handlers - search history
for (const name of ['applyCbJson', 'exportCbModels', 'formatCbJson', 'importCbModels', 'toggleCbJsonEditor', 'cycleLogFilter']) {
  try {
    const out = execSync(`git log --all --oneline -S "function ${name}" -n 5`, { encoding: 'utf8' });
    console.log(name, ':', out.trim() || '(never defined as function)');
  } catch {}
}
