/**
 * 回归清单筛查：对照 git 历史，找出代理 tab / 按钮色 / 配置路径点击等丢失项
 * 用法: node scripts/_audit-regressions-v2.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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

function safeShow(rev, file) {
  const out = sh(`git show ${rev}:${file}`);
  if (!out || out.startsWith('fatal:') || out.includes('does not exist')) return null;
  return out;
}

function proxyTabs(html) {
  if (!html) return [];
  const tabs = [];
  const re = /data-proxy-panel="([^"]+)"[^>]*>([^<]*)</g;
  let m;
  while ((m = re.exec(html))) tabs.push({ panel: m[1], label: m[2].trim() });
  return tabs;
}

function topTabs(html) {
  if (!html) return [];
  const out = [];
  const re = /id="(tab-[^"]+)"([^>]*)>[\s\S]*?<span>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    out.push({
      id: m[1],
      page: (attrs.match(/data-page="([^"]+)"/) || [])[1] || '',
      section: (attrs.match(/data-platform-section="([^"]+)"/) || [])[1] || '',
      label: m[3],
    });
  }
  return out;
}

function has(text, ...needles) {
  if (!text) return false;
  return needles.every((n) => text.includes(n));
}

function any(text, ...needles) {
  if (!text) return false;
  return needles.some((n) => text.includes(n));
}

// 关键提交：扩展中心前后 + HTML 拆分 + 按钮色版本
const KEY_REVS = [
  'be9e855', // v0.2.1 按钮色
  'a31944e', // 扩展前仍有顶栏统计
  '7842a40^', // 扩展中心父提交
  '7842a40', // 扩展中心
  '4765f60', // HTML partials 拆分
  'db1dd79', // data-action
  '299462d', // ES module
  '9ab7295', // P4
  'HEAD',
];

const FILES = {
  index: 'ui/index.html',
  runtime: 'ui/assets/scripts/20-runtime.js',
  platforms: 'ui/assets/scripts/55-platforms.js',
  shell: 'ui/assets/scripts/10-shell.js',
  css: 'ui/assets/styles/50-platforms.css',
};

console.log('=== 1) 各关键提交：代理页 tabs / 顶栏 / 关键符号 ===\n');

for (const rev of KEY_REVS) {
  const index = safeShow(rev, FILES.index);
  const runtime = safeShow(rev, FILES.runtime);
  const platforms = safeShow(rev, FILES.platforms);
  const shell = safeShow(rev, FILES.shell);
  const css = safeShow(rev, FILES.css);

  const tabs = proxyTabs(index);
  const tops = topTabs(index);
  const row = {
    rev,
    topTabs: tops.map((t) => t.label).join('|') || '(no index)',
    proxyTabs: tabs.map((t) => `${t.panel}:${t.label}`).join(', ') || '(none)',
    hasStatsPanel: any(index, 'data-proxy-panel="stats"', 'data-proxy-section="stats"'),
    hasLogsPanel: any(index, 'data-proxy-panel="logs"', 'data-proxy-section="logs"'),
    topStats: tops.some((t) => t.label === '统计' || t.id === 'tab-overview'),
    isDangerJs: any(runtime, "toggle('is-danger'", 'is-danger'),
    isConnectedJs: any(runtime, 'is-connected'),
    isDangerCss: any(css, 'is-danger'),
    isConnectedCss: any(css, 'is-connected'),
    cycleLogFilter: any(runtime, 'function cycleLogFilter'),
    revealConfigPath: any(platforms, 'function revealConfigPath', 'revealConfigPath'),
    bindRevealPathLabel: any(platforms, 'function bindRevealPathLabel', 'bindRevealPathLabel'),
    bindRevealCalls: platforms ? (platforms.match(/bindRevealPathLabel\(/g) || []).length : 0,
    activateProxyValid: shell && shell.includes("'stats'") && shell.includes("'logs'"),
  };
  console.log(JSON.stringify(row, null, 0));
}

console.log('\n=== 2) 当前工作区（含未提交）===\n');
const now = {
  index: existsSync(FILES.index) ? readFileSync(FILES.index, 'utf8') : '',
  runtime: existsSync(FILES.runtime) ? readFileSync(FILES.runtime, 'utf8') : '',
  platforms: existsSync(FILES.platforms) ? readFileSync(FILES.platforms, 'utf8') : '',
  shell: existsSync(FILES.shell) ? readFileSync(FILES.shell, 'utf8') : '',
  css: existsSync(FILES.css) ? readFileSync(FILES.css, 'utf8') : '',
  logs: existsSync('ui/assets/scripts/state/logs.js')
    ? readFileSync('ui/assets/scripts/state/logs.js', 'utf8')
    : '',
  proxyPartial: existsSync('ui-src/partials/pages/proxy.html')
    ? readFileSync('ui-src/partials/pages/proxy.html', 'utf8')
    : '',
  platformProxyPartial: existsSync('ui-src/partials/pages/platform-proxy.html')
    ? readFileSync('ui-src/partials/pages/platform-proxy.html', 'utf8')
    : '',
  modelsPartial: existsSync('ui-src/partials/pages/models.html')
    ? readFileSync('ui-src/partials/pages/models.html', 'utf8')
    : '',
};

const nowProxyTabs = proxyTabs(now.proxyPartial || now.index);
console.log('proxy tabs now:', nowProxyTabs);
console.log('top tabs now:', topTabs(now.index).map((t) => t.label));
console.log('is-danger toggle now:', now.runtime.includes("toggle('is-danger'"));
console.log('is-connected now:', now.runtime.includes('is-connected'));
console.log('cycleLogFilter now:', /function cycleLogFilter|export function cycleLogFilter/.test(now.runtime + now.logs));
console.log('setLogFilter now:', /function setLogFilter|export function setLogFilter/.test(now.logs + now.runtime));
console.log('revealConfigPath now:', now.platforms.includes('function revealConfigPath'));
console.log('bindRevealPathLabel now:', now.platforms.includes('function bindRevealPathLabel'));
console.log('bindRevealPathLabel call count:', (now.platforms.match(/bindRevealPathLabel\(/g) || []).length);

// 哪些平台 label 绑了 reveal
const bindSites = [...now.platforms.matchAll(/bindRevealPathLabel\(\s*'([^']+)'/g)].map((m) => m[1]);
console.log('bindRevealPathLabel targets:', bindSites);

// HTML 里配置路径 code 元素
const pathLabels = [
  'codex-config-path-label',
  'claude-code-config-path-label',
  'opencode-config-path-label',
  'cb-config-path-label',
  'wb-config-path-label',
  'zc-config-path-label',
];
console.log('\nconfig path labels in HTML:');
for (const id of pathLabels) {
  const inIndex = now.index.includes(`id="${id}"`);
  const hasClickAttr =
    now.index.includes(`id="${id}"`) &&
    /id="[^"]*config-path-label"[^>]*(onclick|data-action|cursor:pointer|class="[^"]*clickable)/.test(now.index);
  console.log(`  ${id}: inHtml=${inIndex}`);
}

console.log('\n=== 3) 7842a40 对 runtime 的关键删除 ===\n');
const diff = sh('git show 7842a40 -- ui/assets/scripts/20-runtime.js');
const deleted = diff
  .split(/\r?\n/)
  .filter((l) => l.startsWith('-') && !l.startsWith('---'))
  .filter((l) =>
    /is-danger|is-connected|cycleLogFilter|setLogFilter|renderProxyStats|classList\.toggle|function /.test(l),
  )
  .slice(0, 40);
deleted.forEach((l) => console.log(l));

console.log('\n=== 4) 历史里是否出现过代理页 stats/logs 子 tab ===\n');
// 只扫 index 相关提交，避免全仓库
const indexCommits = sh('git log --oneline -- ui/index.html')
  .trim()
  .split(/\r?\n/)
  .map((l) => l.split(' ')[0])
  .filter(Boolean)
  .slice(0, 30);

let foundStatsTab = [];
let foundLogsTab = [];
for (const h of indexCommits) {
  const html = safeShow(h, 'ui/index.html');
  if (!html) continue;
  if (html.includes('data-proxy-panel="stats"') || /proxy-console-tab[^>]*>\s*统计\s*</.test(html)) {
    foundStatsTab.push(h);
  }
  if (html.includes('data-proxy-panel="logs"') || /proxy-console-tab[^>]*>\s*日志\s*</.test(html)) {
    foundLogsTab.push(h);
  }
}
console.log('commits with proxy stats tab:', foundStatsTab.length ? foundStatsTab.join(', ') : '(none in last 30 index commits)');
console.log('commits with proxy logs tab:', foundLogsTab.length ? foundLogsTab.join(', ') : '(none in last 30 index commits)');

// 也查 be9e855 的完整 proxy-console-tabs 片段
console.log('\n=== 5) be9e855 proxy-console-tabs 片段 ===\n');
const be = safeShow('be9e855', 'ui/index.html') || '';
const i = be.indexOf('proxy-console-tabs');
console.log(i >= 0 ? be.slice(i, i + 500) : '(not found)');

console.log('\n=== 6) HEAD proxy-console-tabs 片段 ===\n');
const hi = now.index.indexOf('proxy-console-tabs');
console.log(hi >= 0 ? now.index.slice(hi, hi + 500) : '(not found)');

console.log('\n=== 7) bindRevealPathLabel 实现 + 调用点 ===\n');
const pi = now.platforms.indexOf('function revealConfigPath');
console.log(pi >= 0 ? now.platforms.slice(pi, pi + 250) : 'revealConfigPath missing');
const bi = now.platforms.indexOf('function bindRevealPathLabel');
console.log(bi >= 0 ? now.platforms.slice(bi, bi + 250) : 'bindRevealPathLabel missing');
const callLines = now.platforms
  .split(/\r?\n/)
  .map((l, idx) => ({ n: idx + 1, l }))
  .filter((x) => x.l.includes('bindRevealPathLabel('));
callLines.forEach((x) => console.log(`${x.n}: ${x.l.trim()}`));

console.log('\n=== 8) syncIdeProxyButton 当前片段 ===\n');
const si = now.runtime.indexOf('function syncIdeProxyButton');
console.log(si >= 0 ? now.runtime.slice(si, si + 700) : 'missing');

console.log('\n=== 9) uncommitted diff stat ===\n');
console.log(sh('git diff --stat'));
console.log(sh('git status --short'));

console.log('\nDONE');
