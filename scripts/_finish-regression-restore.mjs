/**
 * 补齐剩余回归恢复项（幂等，兼容 CRLF）
 * 用法: node scripts/_finish-regression-restore.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

function read(p) {
  return readFileSync(p, 'utf8');
}
function write(p, s) {
  writeFileSync(p, s, 'utf8');
  console.log('wrote', p);
}

/** 用 LF 匹配，写回时保留原文件换行风格 */
function replaceBlock(src, oldLf, newLf, label) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const oldStr = oldLf.replace(/\n/g, nl);
  const newStr = newLf.replace(/\n/g, nl);
  if (!src.includes(oldStr)) {
    // 再试：把源归一化后匹配
    const norm = src.replace(/\r\n/g, '\n');
    if (!norm.includes(oldLf)) {
      throw new Error(`replace failed: ${label}\n--- looking for ---\n${oldLf.slice(0, 300)}`);
    }
    const outNorm = norm.replace(oldLf, newLf);
    return outNorm.replace(/\n/g, nl);
  }
  return src.replace(oldStr, newStr);
}

// 1) logs.js — cycleLogFilter
{
  let s = read('ui/assets/scripts/state/logs.js');
  if (!s.includes('function cycleLogFilter')) {
    s = replaceBlock(
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
    s = replaceBlock(
      s,
      `g.setLogFilter = setLogFilter;`,
      `g.setLogFilter = setLogFilter;
g.cycleLogFilter = cycleLogFilter;`,
      'mirror cycleLogFilter',
    );
    write('ui/assets/scripts/state/logs.js', s);
  } else {
    console.log('skip: cycleLogFilter');
  }
}

// 2) 20-runtime.js — renderProxyStats alias
{
  let s = read('ui/assets/scripts/20-runtime.js');
  if (!s.includes('function renderProxyStats')) {
    s = replaceBlock(
      s,
      `async function refreshStats() {`,
      `function renderProxyStats() {
  return refreshStats();
}

async function refreshStats() {`,
      'renderProxyStats alias',
    );
    s = replaceBlock(
      s,
      `  g.refreshStats = refreshStats;`,
      `  g.refreshStats = refreshStats;
  g.renderProxyStats = renderProxyStats;`,
      'mirror renderProxyStats',
    );
    write('ui/assets/scripts/20-runtime.js', s);
  } else {
    console.log('skip: renderProxyStats');
  }
}

// 3) 55-platforms.js — path click + cursorOpenStats
{
  let s = read('ui/assets/scripts/55-platforms.js');

  if (s.includes("if (!s || s.startsWith('~')) return false;")) {
    s = replaceBlock(
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
  } else if (s.includes("s === '~'") || s.includes("s.startsWith('~/')")) {
    console.log('skip: isRevealablePath already allows tilde');
  } else {
    throw new Error('unexpected isRevealablePath body');
  }

  if (s.includes("const display = String(path || '').trim() || el.textContent || '';")) {
    console.log('skip: bindRevealPathLabel already updated');
  } else {
    s = replaceBlock(
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
  }

  if (s.includes("openPlatformSection('overview')") && s.includes('function cursorOpenStats')) {
    console.log('skip: cursorOpenStats already updated');
  } else {
    s = replaceBlock(
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
  }

  write('ui/assets/scripts/55-platforms.js', s);
}

// 4) proxy.html tabs + sections
{
  let s = read('ui-src/partials/pages/proxy.html');
  if (!s.includes('data-proxy-panel="stats"')) {
    s = replaceBlock(
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

    s = replaceBlock(
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
    console.log('skip: proxy stats/logs tabs');
  }
}

// 5) CSS
{
  const cssPath = 'ui/assets/styles/50-platforms.css';
  let s = read(cssPath);
  if (!s.includes('.proxy-stats-mount')) {
    const nl = s.includes('\r\n') ? '\r\n' : '\n';
    s += `${nl}${nl}/* 代理页 · 统计 / 日志 tab 挂载区 */${nl}.proxy-stats-mount,${nl}.proxy-logs-mount {${nl}  min-height: 240px;${nl}}${nl}.proxy-stats-mount .proxy-analytics {${nl}  margin: 0;${nl}}${nl}.proxy-logs-mount .proxy-logs-panel {${nl}  margin: 0;${nl}}${nl}.proxy-logs-mount .proxy-logs-box,${nl}.proxy-logs-mount #fullLog {${nl}  min-height: 360px;${nl}  max-height: min(70vh, 720px);${nl}}${nl}`;
    write(cssPath, s);
  } else {
    console.log('skip: proxy mount css');
  }
}

// 6) Rust reveal_path expand ~
{
  const p = 'src-tauri/src/commands/system.rs';
  let s = read(p);
  if (!s.includes('fn expand_user_path')) {
    s = replaceBlock(
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
    console.log('skip: expand_user_path');
  }
}

console.log('REMAINING PATCHES APPLIED OK');
