import { execSync } from 'child_process';

const html = execSync('git show be9e855:ui/index.html', {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
});

// extract all tab-item buttons fully
const re = /<button type="button" class="tab-item[\s\S]*?<\/button>/g;
const tabs = html.match(re) || [];
for (const t of tabs) {
  const label = (t.match(/<span>([^<]+)<\/span>/) || [])[1];
  const page = (t.match(/data-page="([^"]+)"/) || [])[1];
  const id = (t.match(/id="([^"]+)"/) || [])[1];
  console.log('---', id, page, label, 'len', t.length);
  if (label === '统计' || page === 'platform-proxy' || label === '设置') {
    console.log(t);
  }
}

// cycleLogFilter from be9e855
const rt = execSync('git show be9e855:ui/assets/scripts/20-runtime.js', {
  encoding: 'utf8',
  maxBuffer: 5 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
});
const i = rt.indexOf('function cycleLogFilter');
console.log('\n==== cycleLogFilter ====');
console.log(rt.slice(i, i + 400));

// createCbIoHandlers - does it create importCbModels etc?
const plat = execSync('git show be9e855:ui/assets/scripts/55-platforms.js', {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
});
const j = plat.indexOf('createCbIoHandlers');
console.log('\n==== createCbIoHandlers snippet ====');
console.log(plat.slice(j, j + 1500));
