/**
 * 检查 git stash 与 7842a40^ 父提交窗口，找统计/日志 tab 与路径点击
 * 用法: node scripts/_audit-stash-and-gap.mjs
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function sh(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}

console.log('=== stash list ===');
console.log(sh('git stash list'));

console.log('\n=== stash@{0} stat ===');
console.log(sh('git stash show --stat stash@{0}'));

console.log('\n=== stash@{0} feature markers in patch ===');
const patch = sh('git stash show -p stash@{0}');
const keys = [
  'data-proxy-panel="stats"',
  'data-proxy-panel="logs"',
  'proxy-console-tab',
  '统计',
  '日志',
  'is-danger',
  'is-connected',
  'reveal-path',
  'bindRevealPathLabel',
  'cycleLogFilter',
  'tab-overview',
  'config-path-label',
];
for (const k of keys) {
  const count = patch.split(k).length - 1;
  if (count) console.log(k, 'count=', count);
}

// extract interesting added lines
console.log('\n=== stash interesting + lines (sample) ===');
let n = 0;
for (const line of patch.split(/\r?\n/)) {
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (/统计|日志|stats|logs|is-danger|is-connected|reveal|config-path|proxy-console-tab|cycleLogFilter|tab-overview/.test(line)) {
    console.log(line.slice(0, 220));
    if (++n >= 80) break;
  }
}
console.log('shown', n);

// commits between a31944e and 7842a40
console.log('\n=== commits a31944e..7842a40 ===');
console.log(sh('git log --oneline a31944e..7842a40'));

// what files changed a31944e..7842a40 for ui
console.log('\n=== ui files changed a31944e..7842a40 ===');
console.log(sh('git diff --stat a31944e..7842a40 -- ui/ ui-src/').split(/\r?\n/).slice(0, 60).join('\n'));

// specifically: when did activateProxyPanel gain stats/logs without HTML?
console.log('\n=== who introduced validPanels stats/logs ===');
console.log(sh('git log -p -S "validPanels" -- ui/assets/scripts/10-shell.js').split(/\r?\n/).slice(0, 80).join('\n'));

// cbApplyConfigMeta / prefix bind for cb wb zc
console.log('\n=== search bindReveal in all history platforms ===');
console.log(sh('git log --oneline -S "bindRevealPathLabel" -- ui/assets/scripts/55-platforms.js -n 15'));

// check if cbApplyConfigMeta ever bound reveal for all prefixes
const head = sh('git show HEAD:ui/assets/scripts/55-platforms.js');
const i = head.indexOf('function cbApplyConfigMeta');
console.log('\n=== cbApplyConfigMeta snippet ===');
console.log(i >= 0 ? head.slice(i, i + 500) : 'missing');

const j = head.indexOf("bindRevealPathLabel(`${prefix}");
console.log('\n=== prefix bind context ===');
if (j >= 0) console.log(head.slice(j - 300, j + 200));

// 7842a40^ vs a31944e for shell activateProxyPanel
console.log('\n=== shell activateProxyPanel a31944e vs 7842a40^ ===');
console.log(sh('git diff a31944e 7842a40^ -- ui/assets/scripts/10-shell.js').split(/\r?\n/).filter(l => /activateProxyPanel|stats|logs|validPanels|统计|tab-overview/.test(l)).slice(0, 40).join('\n'));

console.log('\nDONE');
