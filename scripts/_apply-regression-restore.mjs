/**
 * 应用 UI 回归恢复（A–F）
 * 用法: node scripts/_apply-regression-restore.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

function read(p) {
  return readFileSync(p, 'utf8');
}
function write(p, s) {
  writeFileSync(p, s, 'utf8');
  console.log('wrote', p);
}
function mustReplace(src, oldStr, newStr, label) {
  if (!src.includes(oldStr)) throw new Error(`replace failed: ${label}\n--- looking for ---\n${oldStr.slice(0, 240)}`);
  const out = src.replace(oldStr, newStr);
  if (out === src) throw new Error(`replace no-op: ${label}`);
  return out;
}

// ═══════════════════════════════════════════
// 1) 10-shell.js — overview 导航 + stats/logs 挂载
// ═══════════════════════════════════════════
{
  let s = read('ui/assets/scripts/10-shell.js');

  s = mustReplace(
    s,
    `function normalizePlatformSection(section) {
  return ['models', 'settings'].includes(section) ? section : 'models';
}

function getPlatformSectionForPage(pageId) {
  if (['models', 'model-slots', 'slot-editor'].includes(pageId)) return 'models';
  if (pageId === 'platform-proxy') {
    return activePlatformSection === 'settings' ? 'settings' : 'settings';
  }
  return null;
}

function setPlatformPanel(section) {
  const panelId = normalizePlatformSection(section) === 'settings' ? 'settings' : 'settings';`,
    `function normalizePlatformSection(section) {
  return ['overview', 'models', 'settings'].includes(section) ? section : 'models';
}

function getPlatformSectionForPage(pageId) {
  if (['models', 'model-slots', 'slot-editor'].includes(pageId)) return 'models';
  if (pageId === 'platform-proxy') {
    return activePlatformSection === 'settings' ? 'settings' : 'overview';
  }
  return null;
}

function setPlatformPanel(section) {
  const panelId = normalizePlatformSection(section) === 'settings' ? 'settings' : 'overview';`,
    'shell platform section overview',
  );

  s = mustReplace(
    s,
    `  if (pageId === 'platform-proxy' && activePlatformSection !== 'settings') {
    activePlatformSection = 'settings';
  }`,
    `  if (pageId === 'platform-proxy' && activePlatformSection !== 'settings') {
    activePlatformSection = 'overview';
  }`,
    'navigateTo platform-proxy default overview',
  );

  s = mustReplace(
    s,
    `function openPlatformSection(section) {
  const target = normalizePlatformSection(section);
  activePlatformSection = target;
  if (target === 'models') {
    navigateTo('models');
    syncPlatformConsoleHead();
    return;
  }
  navigateTo('platform-proxy');
  setPlatformPanel(target);
  syncPlatformSubtabsForPage('platform-proxy');
  syncPlatformConsoleHead();
}`,
    `function openPlatformSection(section) {
  const target = normalizePlatformSection(section);
  activePlatformSection = target;
  if (target === 'models') {
    navigateTo('models');
    syncPlatformConsoleHead();
    return;
  }
  // 统计已划入代理页 tab；overview 统一跳代理「统计」
  if (target === 'overview') {
    if (typeof openProxyPanel === 'function') openProxyPanel('stats');
    else navigateTo('proxy');
    syncPlatformConsoleHead();
    return;
  }
  navigateTo('platform-proxy');
  setPlatformPanel(target);
  syncPlatformSubtabsForPage('platform-proxy');
  syncPlatformConsoleHead();
}`,
    'openPlatformSection overview -> proxy stats',
  );

  s = mustReplace(
    s,
    `  if (target === 'stats' && typeof renderProxyStats === 'function') {
    renderProxyStats();
  }
}`,
    `  if ((target === 'stats' || target === 'logs') && typeof refreshStats === 'function') {
    refreshStats();
  }
  if (target === 'stats' && typeof renderProxyStats === 'function') {
    renderProxyStats();
  }
  if (target === 'logs' && typeof renderLogs === 'function') {
    renderLogs();
  }
}`,
    'activateProxyPanel stats/logs refresh',
  );

  if (!s.includes('function mountProxyStatsAndLogsPanels')) {
    s = mustReplace(
      s,
      `function mountProxyEnhancementPanel() {`,
      `/**
 * 将全局统计 KPI / 代理日志挂到代理页 stats、logs tab。
 * 从 platform-proxy overview 迁移 DOM（同 id，只迁一次）。
 */
function mountProxyStatsAndLogsPanels() {
  const statsMount = document.getElementById('proxyStatsMount');
  const logsMount = document.getElementById('proxyLogsMount');
  const analytics = document.querySelector('#platform-panel-overview .proxy-analytics');
  if (!analytics) return;

  const logsPanel = analytics.querySelector('.proxy-logs-panel');

  if (statsMount && !statsMount.dataset.mounted) {
    statsMount.dataset.mounted = '1';
    statsMount.appendChild(analytics);
  }
  if (logsMount && logsPanel && !logsMount.dataset.mounted) {
    logsMount.dataset.mounted = '1';
    logsMount.appendChild(logsPanel);
  }
}

function mountProxyEnhancementPanel() {`,
      'add mountProxyStatsAndLogsPanels',
    );

    s = mustReplace(
      s,
      `mountProxyEnhancementPanel();
document.querySelectorAll('.proxy-enhancement-tab[data-enhancement-panel]').forEach(tab => {
  tab.addEventListener('click', () => activateEnhancementPanel(tab.dataset.enhancementPanel));
});
mountPlatformOwnedSettings();`,
      `mountProxyEnhancementPanel();
mountProxyStatsAndLogsPanels();
document.querySelectorAll('.proxy-enhancement-tab[data-enhancement-panel]').forEach(tab => {
  tab.addEventListener('click', () => activateEnhancementPanel(tab.dataset.enhancementPanel));
});
mountPlatformOwnedSettings();`,
      'call mountProxyStatsAndLogsPanels',
    );

    s = mustReplace(
      s,
      `  g.mountProxyEnhancementPanel = mountProxyEnhancementPanel;`,
      `  g.mountProxyEnhancementPanel = mountProxyEnhancementPanel;
  g.mountProxyStatsAndLogsPanels = mountProxyStatsAndLogsPanels;`,
      'mirror mountProxyStatsAndLogsPanels',
    );
  }

  write('ui/assets/scripts/10-shell.js', s);
}

// ═══════════════════════════════════════════
// 2) state/logs.js — cycleLogFilter
// ═══════════════════════════════════════════
{
  let s = read('ui/assets/scripts/state/logs.js');
  if (!s.includes('function cycleLogFilter')) {
    s = mustReplace(
      s,
      `export function setLogFilter(level) {
  ensureState();
  if (!LOG_FILTERS.includes(level)) return;
  globalThis.logFilter = level;
  document.querySelectorAll('.log-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.level === level);
  });
  renderLogs();
}`,
      `export function setLogFilter(level) {
  ensureState();
  if (!LOG_FILTERS.includes(level)) return;
  globalThis.logFilter = level;
  document.querySelectorAll('.log-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.level === level);
  });
  const btn = document.getElementById('logFilterBtn');
  if (btn) btn.textContent = \`筛选: \${LOG_FILTER_LABELS[level] || level} ▾\`;
  renderLogs();
}

export function cycleLogFilter() {
  ensureState();
  const i = LOG_FILTERS.indexOf(globalThis.logFilter);
  const next = LOG_FILTERS[(i + 1) % LOG_FILTERS.length];
  setLogFilter(next);
}`,
      'cycleLogFilter',
    );
    s = mustReplace(
      s,
      `g.setLogFilter = setLogFilter;`,
      `g.setLogFilter = setLogFilter;
g.cycleLogFilter = cycleLogFilter;`,
      'mirror cycleLogFilter',
    );
    write('ui/assets/scripts/state/logs.js', s);
  } else {
    console.log('skip: cycleLogFilter exists');
  }
}

// ═══════════════════════════════════════════
// 3) 20-runtime.js — renderProxyStats 别名
// ═══════════════════════════════════════════
{
  let s = read('ui/assets/scripts/20-runtime.js');
  if (!s.includes('function renderProxyStats')) {
    s = mustReplace(
      s,
      `async function refreshStats() {`,
      `function renderProxyStats() {
  return refreshStats();
}

async function refreshStats() {`,
      'renderProxyStats alias',
    );
    s = mustReplace(
      s,
      `  g.refreshStats = refreshStats;`,
      `  g.refreshStats = refreshStats;
  g.renderProxyStats = renderProxyStats;`,
      'mirror renderProxyStats',
    );
    write('ui/assets/scripts/20-runtime.js', s);
  } else {
    console.log('skip: renderProxyStats exists');
  }
}

// ═══════════════════════════════════════════
// 4) 55-platforms.js — 路径点击 + cursorOpenStats
// ═══════════════════════════════════════════
{
  let s = read('ui/assets/scripts/55-platforms.js');

  s = mustReplace(
    s,
    `function isRevealablePath(path) {
  const s = String(path || '').trim();
  if (!s || s.startsWith('~')) return false;
  return s.includes('/') || s.includes('\\\\') || /^[A-Za-z]:/.test(s);
}`,
    `function isRevealablePath(path) {
  const s = String(path || '').trim();
  if (!s) return false;
  // ~/.xxx 也允许点击；后端 reveal_path 负责展开 home
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\\\')) return true;
  return s.includes('/') || s.includes('\\\\') || /^[A-Za-z]:/.test(s);
}`,
    'isRevealablePath allow tilde',
  );

  s = mustReplace(
    s,
    `function bindRevealPathLabel(labelId, path) {
  const el = document.getElementById(labelId);
  if (!el) return;
  el.textContent = path;
  if (isRevealablePath(path)) {
    el.classList.add('reveal-path');
    el.title = '点击打开所在文件夹';
    el.onclick = () => revealConfigPath(path);
  } else {
    el.classList.remove('reveal-path');
    el.title = '';
    el.onclick = null;
  }
}`,
    `function bindRevealPathLabel(labelId, path) {
  const el = document.getElementById(labelId);
  if (!el) return;
  const display = String(path || '').trim() || el.textContent || '';
  el.textContent = display;
  if (isRevealablePath(display)) {
    el.classList.add('reveal-path');
    el.title = '点击打开所在文件夹';
    el.onclick = () => revealConfigPath(display);
  } else {
    el.classList.remove('reveal-path');
    el.title = '';
    el.onclick = null;
  }
}`,
    'bindRevealPathLabel',
  );

  s = mustReplace(
    s,
    `function cursorOpenStats() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('stats');
  } else {
    navigateTo('proxy');
  }
}`,
    `function cursorOpenStats() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('stats');
  } else if (typeof openPlatformSection === 'function') {
    openPlatformSection('overview');
  } else {
    navigateTo('proxy');
  }
}`,
    'cursorOpenStats',
  );

  write('ui/assets/scripts/55-platforms.js', s);
}

// ═══════════════════════════════════════════
// 5) proxy.html — 统计 / 日志 tab + section
// ═══════════════════════════════════════════
{
  let s = read('ui-src/partials/pages/proxy.html');
  if (!s.includes('data-proxy-panel="stats"')) {
    s = mustReplace(
      s,
      `            <div class="proxy-console-tabs" role="tablist" aria-label="代理配置">
              <button type="button" class="proxy-console-tab active" data-proxy-panel="overview" aria-selected="true">概览</button>
              <button type="button" class="proxy-console-tab" data-proxy-panel="routes" aria-selected="false">模型列表</button>
              <button type="button" class="proxy-console-tab" data-proxy-panel="enhancement" aria-selected="false">代理增强</button>
            </div>`,
      `            <div class="proxy-console-tabs" role="tablist" aria-label="代理配置">
              <button type="button" class="proxy-console-tab active" data-proxy-panel="overview" aria-selected="true">概览</button>
              <button type="button" class="proxy-console-tab" data-proxy-panel="routes" aria-selected="false">模型列表</button>
              <button type="button" class="proxy-console-tab" data-proxy-panel="enhancement" aria-selected="false">代理增强</button>
              <button type="button" class="proxy-console-tab" data-proxy-panel="stats" aria-selected="false">统计</button>
              <button type="button" class="proxy-console-tab" data-proxy-panel="logs" aria-selected="false">日志</button>
            </div>`,
      'proxy tabs',
    );

    s = mustReplace(
      s,
      `            <div class="proxy-console-section" data-proxy-section="enhancement">
              <div id="proxyEnhancementMount"></div>
            </div>
          </section>
        </div>`,
      `            <div class="proxy-console-section" data-proxy-section="enhancement">
              <div id="proxyEnhancementMount"></div>
            </div>

            <div class="proxy-console-section" data-proxy-section="stats">
              <div id="proxyStatsMount" class="proxy-stats-mount"></div>
            </div>

            <div class="proxy-console-section" data-proxy-section="logs">
              <div id="proxyLogsMount" class="proxy-logs-mount"></div>
            </div>
          </section>
        </div>`,
      'proxy sections',
    );
    write('ui-src/partials/pages/proxy.html', s);
  } else {
    console.log('skip: proxy stats/logs tabs exist');
  }
}

// ═══════════════════════════════════════════
// 6) CSS — 代理页内嵌统计/日志
// ═══════════════════════════════════════════
{
  const cssPath = 'ui/assets/styles/50-platforms.css';
  let s = read(cssPath);
  if (!s.includes('.proxy-stats-mount')) {
    s += `

/* 代理页 · 统计 / 日志 tab 挂载区 */
.proxy-stats-mount,
.proxy-logs-mount {
  min-height: 240px;
}
.proxy-stats-mount .proxy-analytics {
  margin: 0;
}
.proxy-logs-mount .proxy-logs-panel {
  margin: 0;
}
.proxy-logs-mount .proxy-logs-box,
.proxy-logs-mount #fullLog {
  min-height: 360px;
  max-height: min(70vh, 720px);
}
`;
    write(cssPath, s);
  } else {
    console.log('skip: proxy mount css exists');
  }
}

// ═══════════════════════════════════════════
// 7) Rust reveal_path — 展开 ~
// ═══════════════════════════════════════════
{
  const p = 'src-tauri/src/commands/system.rs';
  let s = read(p);
  if (!s.includes('fn expand_user_path')) {
    s = mustReplace(
      s,
      `#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path);
    let parent = target
        .parent()
        .ok_or_else(|| "无法获取配置文件所在目录".to_string())?
        .to_path_buf();
    reveal_path_impl(&parent)
}`,
      `fn expand_user_path(path: &str) -> std::path::PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        return dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\\\"))
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(trimmed)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = expand_user_path(&path);
    // 文件：打开父目录；目录：直接打开
    let parent = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .ok_or_else(|| "无法获取配置文件所在目录".to_string())?
            .to_path_buf()
    };
    reveal_path_impl(&parent)
}`,
      'rust reveal_path expand tilde',
    );
    write(p, s);
  } else {
    console.log('skip: expand_user_path exists');
  }
}

console.log('ALL PATCHES APPLIED OK');
