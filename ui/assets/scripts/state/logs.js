/**
 * state/logs.js — 运行日志状态与渲染（P4 共享层）
 *
 * 可变状态以 globalThis 为唯一源，避免 export let 与自由变量分叉。
 */
import { bindTauriBridge } from '../api/bridge.js';
import { escapeHtml } from '../ui/dom.js';

export const MAX_LOGS = 500;
export const LOG_FILTERS = ['all', 'ok', 'info', 'warn', 'err'];
export const LOG_FILTER_LABELS = { all: '全部', ok: 'OK', info: 'INFO', warn: 'WARN', err: 'ERR' };
export const LOG_VIEWER_LEVELS = ['ok', 'info', 'warn', 'err'];

function ensureState() {
  const g = globalThis;
  if (!Array.isArray(g.logEntries)) g.logEntries = [];
  if (typeof g.logRenderScheduled !== 'boolean') g.logRenderScheduled = false;
  if (typeof g.logScrollPending !== 'boolean') g.logScrollPending = false;
  if (typeof g.logFilter !== 'string') g.logFilter = 'all';
  if (!g.logViewerFilters || typeof g.logViewerFilters !== 'object') {
    g.logViewerFilters = {
      levels: new Set(LOG_VIEWER_LEVELS),
      query: '',
      limit: 200,
      order: 'desc',
      autoScroll: true,
    };
  }
  g.MAX_LOGS = MAX_LOGS;
  g.LOG_FILTERS = LOG_FILTERS;
  g.LOG_FILTER_LABELS = LOG_FILTER_LABELS;
  g.LOG_VIEWER_LEVELS = LOG_VIEWER_LEVELS;
}

ensureState();

export function nowTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function renderLogLine(e) {
  const level = escapeHtml(e.level);
  const label = escapeHtml(String(e.level || '').toUpperCase());
  return `<div class="log-line" data-level="${level}"><span class="log-ts">${escapeHtml(e.ts)}</span><span class="log-lv ${level}">${label}</span><span class="log-msg">${escapeHtml(e.msg)}</span></div>`;
}

export function renderLogs() {
  ensureState();
  const { logEntries, logFilter } = globalThis;
  const full = document.getElementById('fullLog');
  const dash = document.getElementById('dashLog');
  const filtered =
    typeof logFilter !== 'undefined' && logFilter !== 'all'
      ? logEntries.filter((e) => e.level === logFilter)
      : logEntries;
  if (full) full.innerHTML = filtered.map(renderLogLine).join('');
  if (dash) dash.innerHTML = logEntries.slice(-5).map(renderLogLine).join('');
  const count = document.getElementById('logCount');
  if (count) count.textContent = `${filtered.length} 条记录`;
  const analyticsCount = document.getElementById('analyticsLogEntryCount');
  if (analyticsCount) analyticsCount.textContent = `${logEntries.length} 条记录`;
  const modal = document.getElementById('log-viewer-modal');
  if (modal?.classList.contains('active')) renderLogViewer();
}

export function scheduleLogRender(scrollToBottom) {
  ensureState();
  globalThis.logScrollPending = globalThis.logScrollPending || !!scrollToBottom;
  if (globalThis.logRenderScheduled) return;
  globalThis.logRenderScheduled = true;
  const schedule = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  schedule(() => {
    globalThis.logRenderScheduled = false;
    renderLogs();
    if (globalThis.logScrollPending) {
      const full = document.getElementById('fullLog');
      if (full) full.scrollTop = full.scrollHeight;
      globalThis.logScrollPending = false;
    }
  });
}

export function addLog(level, msg) {
  ensureState();
  const normalizedLevel = level === 'error' ? 'err' : level;
  globalThis.logEntries.push({ ts: nowTs(), level: normalizedLevel, msg });
  if (globalThis.logEntries.length > MAX_LOGS) {
    globalThis.logEntries = globalThis.logEntries.slice(-MAX_LOGS);
  }
  scheduleLogRender(true);
}

export function clearLogs() {
  ensureState();
  globalThis.logEntries = [];
  renderLogs();
}

export function setLogFilter(level) {
  ensureState();
  if (!LOG_FILTERS.includes(level)) return;
  globalThis.logFilter = level;
  document.querySelectorAll('.log-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.level === level);
  });
  const btn = document.getElementById('logFilterBtn');
  if (btn) btn.textContent = `筛选: ${LOG_FILTER_LABELS[level] || level} ▾`;
  renderLogs();
}

export function cycleLogFilter() {
  ensureState();
  const i = LOG_FILTERS.indexOf(globalThis.logFilter);
  const next = LOG_FILTERS[(i + 1) % LOG_FILTERS.length];
  setLogFilter(next);
}

export function openLogViewerModal() {
  const modal = document.getElementById('log-viewer-modal');
  if (!modal) throw new Error('log-viewer-modal not found');
  modal.classList.add('active');
  syncLogViewerControls();
  renderLogViewer();
  document.addEventListener('keydown', closeLogViewerOnEsc);
}

export function closeLogViewerModal() {
  const modal = document.getElementById('log-viewer-modal');
  if (!modal) throw new Error('log-viewer-modal not found');
  modal.classList.remove('active');
  document.removeEventListener('keydown', closeLogViewerOnEsc);
}

export function closeLogViewerOnEsc(event) {
  if (event.key === 'Escape') closeLogViewerModal();
}

export function syncLogViewerControls() {
  ensureState();
  const { logViewerFilters } = globalThis;
  LOG_VIEWER_LEVELS.forEach((level) => {
    const input = document.querySelector(`.log-viewer-level[data-level="${level}"] input`);
    const label = input?.closest('.log-viewer-level');
    const checked = logViewerFilters.levels.has(level);
    if (input) input.checked = checked;
    if (label) label.classList.toggle('active', checked);
  });
  const search = document.getElementById('logViewerSearchInput');
  if (search && search.value !== logViewerFilters.query) search.value = logViewerFilters.query;
  const limit = document.getElementById('logViewerLimitSelect');
  if (limit) limit.value = String(logViewerFilters.limit);
  const order = document.getElementById('logViewerOrderSelect');
  if (order) order.value = logViewerFilters.order;
  const auto = document.getElementById('logViewerAutoScrollInput');
  if (auto) auto.checked = logViewerFilters.autoScroll;
}

export function onLogViewerLevelChange(level, checked) {
  ensureState();
  if (!LOG_VIEWER_LEVELS.includes(level)) throw new Error(`Unknown log level: ${level}`);
  if (checked) globalThis.logViewerFilters.levels.add(level);
  else globalThis.logViewerFilters.levels.delete(level);
  syncLogViewerControls();
  renderLogViewer();
}

export function setLogViewerLevelPreset(preset) {
  ensureState();
  if (preset === 'all') {
    globalThis.logViewerFilters.levels = new Set(LOG_VIEWER_LEVELS);
  } else if (preset === 'important') {
    globalThis.logViewerFilters.levels = new Set(['warn', 'err']);
  } else if (preset === 'errors') {
    globalThis.logViewerFilters.levels = new Set(['err']);
  } else {
    throw new Error(`Unknown log level preset: ${preset}`);
  }
  syncLogViewerControls();
  renderLogViewer();
}

export function onLogViewerSearchInput(value) {
  ensureState();
  globalThis.logViewerFilters.query = String(value || '').trim();
  renderLogViewer();
}

export function onLogViewerLimitChange(value) {
  ensureState();
  const next = Number.parseInt(value, 10);
  if (![50, 100, 200, 500].includes(next)) throw new Error(`Unknown log limit: ${value}`);
  globalThis.logViewerFilters.limit = next;
  renderLogViewer();
}

export function onLogViewerOrderChange(value) {
  ensureState();
  if (value !== 'asc' && value !== 'desc') throw new Error(`Unknown log order: ${value}`);
  globalThis.logViewerFilters.order = value;
  renderLogViewer();
}

export function onLogViewerAutoScrollChange(checked) {
  ensureState();
  globalThis.logViewerFilters.autoScroll = !!checked;
}

export function logViewerFilteredEntries() {
  ensureState();
  const { logEntries, logViewerFilters } = globalThis;
  const q = logViewerFilters.query.toLowerCase();
  let rows = logEntries.filter((e) => {
    if (!logViewerFilters.levels.has(e.level)) return false;
    if (!q) return true;
    return `${e.ts} ${e.level} ${e.msg}`.toLowerCase().includes(q);
  });
  rows = rows.slice(-logViewerFilters.limit);
  if (logViewerFilters.order === 'desc') rows = rows.slice().reverse();
  return rows;
}

export function renderLogViewerLine(e) {
  return `<div class="log-viewer-line">
    <span class="log-viewer-ts">${escapeHtml(e.ts)}</span>
    <span class="log-viewer-lv ${escapeHtml(e.level)}">${escapeHtml(String(e.level).toUpperCase())}</span>
    <span class="log-viewer-msg">${escapeHtml(e.msg)}</span>
  </div>`;
}

export function renderLogViewer() {
  ensureState();
  const body = document.getElementById('logViewerBody');
  if (!body) return;
  const rows = logViewerFilteredEntries();
  body.innerHTML = rows.length
    ? rows.map(renderLogViewerLine).join('')
    : '<div class="log-viewer-empty">没有匹配当前过滤条件的日志。</div>';
  const visible = document.getElementById('logViewerVisibleCount');
  if (visible) visible.textContent = `${rows.length} 条匹配 / 共 ${globalThis.logEntries.length} 条`;
  const counts = LOG_VIEWER_LEVELS.reduce((acc, level) => {
    acc[level] = globalThis.logEntries.filter((e) => e.level === level).length;
    return acc;
  }, {});
  const summary = document.getElementById('logViewerLevelSummary');
  if (summary) {
    summary.textContent = `OK ${counts.ok || 0} · INFO ${counts.info || 0} · WARN ${counts.warn || 0} · ERR ${counts.err || 0}`;
  }
  if (globalThis.logViewerFilters.autoScroll) {
    body.scrollTop = globalThis.logViewerFilters.order === 'desc' ? 0 : body.scrollHeight;
  }
}

export async function exportLogs() {
  ensureState();
  const { logEntries } = globalThis;
  if (logEntries.length === 0) {
    addLog('warn', '暂无日志可导出');
    return;
  }
  if (globalThis.invoke || bindTauriBridge()) {
    try {
      const path = await globalThis.invoke('export_proxy_logs', { entries: logEntries });
      addLog('ok', `已导出 ${logEntries.length} 条日志: ${path}`);
      return;
    } catch (e) {
      addLog('warn', '后端导出失败，尝试浏览器下载: ' + e);
    }
  }
  const text = logEntries.map((e) => `[${e.ts}] ${e.level.toUpperCase()} ${e.msg}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `byok-logs-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  addLog('ok', `已导出 ${logEntries.length} 条日志`);
}

const g = globalThis;
g.nowTs = nowTs;
g.renderLogLine = renderLogLine;
g.renderLogs = renderLogs;
g.scheduleLogRender = scheduleLogRender;
g.addLog = addLog;
g.clearLogs = clearLogs;
g.setLogFilter = setLogFilter;
g.cycleLogFilter = cycleLogFilter;
g.openLogViewerModal = openLogViewerModal;
g.closeLogViewerModal = closeLogViewerModal;
g.closeLogViewerOnEsc = closeLogViewerOnEsc;
g.syncLogViewerControls = syncLogViewerControls;
g.onLogViewerLevelChange = onLogViewerLevelChange;
g.setLogViewerLevelPreset = setLogViewerLevelPreset;
g.onLogViewerSearchInput = onLogViewerSearchInput;
g.onLogViewerLimitChange = onLogViewerLimitChange;
g.onLogViewerOrderChange = onLogViewerOrderChange;
g.onLogViewerAutoScrollChange = onLogViewerAutoScrollChange;
g.logViewerFilteredEntries = logViewerFilteredEntries;
g.renderLogViewerLine = renderLogViewerLine;
g.renderLogViewer = renderLogViewer;
g.exportLogs = exportLogs;
