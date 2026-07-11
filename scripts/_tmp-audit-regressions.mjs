/**
 * Audit accidental UI regressions:
 * 1) data-action handlers missing on globalThis / function decls
 * 2) HTML ids referenced by JS that are missing
 * 3) known broken renames (cycleLogFilter, renderProxyStats)
 * 4) diff 7842a40 for accidental deletions in 20-runtime / shell
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = process.cwd();

function walk(dir, pred, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (pred(ent.name, p)) out.push(p);
  }
  return out;
}

const htmlFiles = walk('ui-src', (n) => n.endsWith('.html'));
const jsFiles = walk('ui/assets/scripts', (n) => n.endsWith('.js'));

// collect data-action names from html + js templates
const actionNames = new Map(); // name -> files
function addAction(name, file) {
  if (!name || name === '__noop') return;
  if (!actionNames.has(name)) actionNames.set(name, new Set());
  actionNames.get(name).add(file);
}

const actionRe = /data-action(?:-call)?=["']([^"']+)["']/g;
const chainRe = /data-action-chain=["']([^"']+)["']/g;
const actionsMapRe = /data-actions=["']([^"']+)["']/g;

for (const f of [...htmlFiles, ...jsFiles]) {
  const t = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = actionRe.exec(t))) {
    let raw = m[1];
    // data-action-call="fn(...)"
    const call = raw.match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (call) addAction(call[1], f);
    else if (!raw.includes('${') && !raw.includes('{')) addAction(raw, f);
  }
  while ((m = chainRe.exec(t))) {
    try {
      const decoded = m[1].replace(/&quot;/g, '"');
      const arr = JSON.parse(decoded);
      for (const step of arr) if (step?.fn) addAction(step.fn, f);
    } catch {}
  }
  while ((m = actionsMapRe.exec(t))) {
    try {
      const decoded = m[1].replace(/&quot;/g, '"');
      const map = JSON.parse(decoded);
      for (const v of Object.values(map)) if (v?.action) addAction(v.action, f);
    } catch {}
  }
}

// collect defined handlers: function name + mirror + globalThis assign
const defined = new Set();
for (const f of jsFiles) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) defined.add(m[1]);
  for (const m of t.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) defined.add(m[1]);
  for (const m of t.matchAll(/g\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of t.matchAll(/globalThis\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of t.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
}

const missingActions = [...actionNames.entries()]
  .filter(([name]) => !defined.has(name))
  .sort((a, b) => a[0].localeCompare(b[0]));

console.log('=== Missing data-action handlers ===');
if (!missingActions.length) console.log('(none)');
for (const [name, files] of missingActions) {
  console.log(`  ${name}  <- ${[...files].slice(0, 3).join(', ')}`);
}

// known symbols
const known = [
  'cycleLogFilter',
  'setLogFilter',
  'renderProxyStats',
  'openLogViewerModal',
  'is-danger',
  'analyticsLogEntryCount',
  'fullLog',
  'dashLog',
];
console.log('\n=== Known symbol presence ===');
const allHtml = fs.readFileSync('ui/index.html', 'utf8');
const allJs = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
for (const k of known) {
  console.log(
    `  ${k}: html=${allHtml.includes(k)} js=${allJs.includes(k)} definedFn=${defined.has(k)}`,
  );
}

// activateProxyPanel valid panels vs actual tabs
const shell = fs.readFileSync('ui/assets/scripts/10-shell.js', 'utf8');
const valid = shell.match(/validPanels = new Set\(\[([^\]]+)\]\)/);
console.log('\n=== activateProxyPanel validPanels ===');
console.log(valid ? valid[1] : 'not found');
const tabs = [...allHtml.matchAll(/data-proxy-panel="([^"]+)"/g)].map((m) => m[1]);
const sections = [...allHtml.matchAll(/data-proxy-section="([^"]+)"/g)].map((m) => m[1]);
console.log('HTML tabs:', [...new Set(tabs)]);
console.log('HTML sections:', [...new Set(sections)]);

// page-platform-proxy vs page-proxy ownership of stats/logs
console.log('\n=== Stats/logs DOM homes ===');
console.log('page-platform-proxy has fullLog:', /id="page-platform-proxy"[\s\S]*?id="fullLog"/.test(allHtml));
console.log('page-proxy has fullLog:', /id="page-proxy"[\s\S]*?id="fullLog"/.test(allHtml));
console.log('stat-requests in platform-proxy:', /id="page-platform-proxy"[\s\S]*?id="stat-requests"/.test(allHtml));
console.log('stat-requests in page-proxy:', /id="page-proxy"[\s\S]*?id="stat-requests"/.test(allHtml));

// 7842a40 accidental deletions in 20-runtime
console.log('\n=== 7842a40 deletions in 20-runtime (sample) ===');
try {
  const diff = execSync('git show 7842a40 -- ui/assets/scripts/20-runtime.js', {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const dels = diff
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---') && l.length > 2)
    .slice(0, 80);
  for (const l of dels) console.log(l);
} catch (e) {
  console.log('diff fail', e.message.slice(0, 200));
}

// compare function list be9e855 vs HEAD for 20-runtime
function fnsAt(rev, file) {
  try {
    const t = execSync(`git show ${rev}:${file}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return new Set([...t.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}
const oldFns = fnsAt('be9e855', 'ui/assets/scripts/20-runtime.js');
const newFns = fnsAt('HEAD', 'ui/assets/scripts/20-runtime.js');
// also check state/logs and others for moved
const headAllFns = defined;
const lost = [...oldFns].filter((n) => !headAllFns.has(n)).sort();
console.log('\n=== Functions in be9e855 20-runtime missing from HEAD codebase ===');
console.log(lost.length ? lost.join(', ') : '(none)');

// shell functions
const oldShell = fnsAt('be9e855', 'ui/assets/scripts/10-shell.js');
const lostShell = [...oldShell].filter((n) => !headAllFns.has(n)).sort();
console.log('\n=== Functions in be9e855 10-shell missing from HEAD ===');
console.log(lostShell.length ? lostShell.join(', ') : '(none)');

// HTML button text / labels that might have been removed - search git for 统计 tab
console.log('\n=== git pickaxe for 统计 tab near proxy-console ===');
try {
  const out = execSync('git log --all --oneline -S "统计" -- ui/index.html ui-src/partials/pages/proxy.html', {
    encoding: 'utf8',
  });
  console.log(out || '(no commits)');
} catch {}

// Look for proxy-console-tab with 统计 or 日志 in any commit via git log -p limited
try {
  const out = execSync(
    'git log --all -G "proxy-console-tab.*>统计<|>日志<" --oneline -n 20 -- ui/index.html ui-src',
    { encoding: 'utf8' },
  );
  console.log('regex commits:', out || '(none)');
} catch {}
