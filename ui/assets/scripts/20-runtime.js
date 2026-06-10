// ═══════ PROXY TOGGLE ═══════
let proxyRunning = false;
let activeProxyTarget = '';

// 防连点:记录进行中的 toggle key,同一目标的并发操作会被忽略,避免后写覆盖先写。
const _inFlightToggles = new Set();

function ideDisplayLabel(ide) {
  const labels = { windsurf: 'Windsurf', devin: 'Devin', auto: '自动检测' };
  return labels[ide] || (ide ? ide.charAt(0).toUpperCase() + ide.slice(1) : 'Windsurf');
}

function statusTargetIde() {
  return proxyRunning && activeProxyTarget ? activeProxyTarget : getTargetIde();
}

function setStatusPill(running) {
  proxyRunning = running;
  const pill = document.getElementById('statusPill');
  const topPill = document.getElementById('topbarStatus');
  const btn = document.getElementById('proxyBtn');
  const sub = document.getElementById('controlSub');

  if (pill) {
    if (running) {
      pill.className = 'status-pill online';
      pill.innerHTML = '<span class="status-dot"></span> 运行中';
    } else {
      pill.className = 'status-pill offline';
      pill.innerHTML = '<span class="status-dot"></span> 已停止';
    }
  }

  if (topPill) {
    const statusText = topPill.querySelector('.status-text');
    if (running) {
      topPill.className = 'topbar-status online';
      if (statusText) statusText.textContent = '运行中';
    } else {
      topPill.className = 'topbar-status offline';
      if (statusText) statusText.textContent = '已停止';
    }
  }

  if (sub) {
    const ide = statusTargetIde();
    const ideLabel = ideDisplayLabel(ide);
    sub.textContent = running
      ? `已接入 ${ideLabel} · 端口 :7450 / :7451 · 重启 IDE 生效`
      : `代理未运行 · 目标: ${ideLabel} · 端口 :7450 / :7451`;
  }
  if (btn) {
    const icon = btn.querySelector('.proxy-btn-icon');
    const text = btn.querySelector('.proxy-btn-text');
    if (icon && text) {
      if (running) {
        icon.innerHTML = '<rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/>';
        text.textContent = '停止代理';
      } else {
        icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"/>';
        text.textContent = '启动代理';
      }
    } else {
      btn.textContent = running ? '■ 停止代理' : '⚡ 启动代理';
    }
    btn.classList.toggle('running', running);
  }
}

let _toggling = false;

function renderPreflightReport(report, targetElId) {
  const el = document.getElementById(targetElId || 'env-check-results');
  if (!el) return;
  const issues = report && Array.isArray(report.issues) ? report.issues : [];
  if (!issues.length) {
    el.innerHTML = '<div class="setting-desc">未返回体检结果</div>';
    return;
  }
  const label = { ok: '通过', warn: '提示', err: '错误' };
  el.innerHTML = issues.map(i => {
    const level = i.level || 'info';
    const color = level === 'err' ? 'var(--danger)' : (level === 'warn' ? 'var(--warning)' : 'var(--success)');
    return `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
      <span style="min-width:42px;color:${color};font-weight:700;">${label[level] || level.toUpperCase()}</span>
      <span style="color:var(--text-secondary);line-height:1.5;">${escapeHtml(i.message || String(i))}</span>
    </div>`;
  }).join('');
}

async function runEnvironmentCheck(options) {
  if (!invoke && !bindTauriBridge()) throw new Error('Tauri 通道未就绪');
  const opts = options || {};
  const target = opts.target || getTargetIde();
  const prefix = opts.prefix || '环境体检';
  const report = await invoke('preflight_proxy', { targetIde: target });
  const issues = report && Array.isArray(report.issues) ? report.issues : [];
  const errors = issues.filter(i => i.level === 'err');
  const warnings = issues.filter(i => i.level === 'warn');
  const oks = issues.filter(i => i.level === 'ok');
  oks.forEach(i => addLog('ok', `${prefix}: ` + (i.message || String(i))));
  warnings.forEach(i => addLog('warn', `${prefix}: ` + (i.message || String(i))));
  if (errors.length) addLog('err', `${prefix}未通过: ` + errors.map(i => i.message || String(i)).join('; '));
  if (opts.renderTo) renderPreflightReport(report, opts.renderTo);
  return { report, issues, errors, warnings, effectiveTarget: (report && (report.target_ide || report.targetIde)) || target };
}

async function toggleProxy() {
  _diag('toggleProxy called');
  if (_toggling) { _diag('toggleProxy skipped: already in progress'); return; }
  _toggling = true;
  try {
  if (!invoke && !bindTauriBridge()) {
    _diag('toggleProxy abort: invoke unavailable');
    addLog('err', 'Tauri 通道未就绪，代理操作不可用。请重启应用后重试。');
    return;
  }

  const activeOverlays = Array.from(document.querySelectorAll('.modal-overlay.active')).map(el => el.id || '(no-id)');
  _diag('active overlays: ' + (activeOverlays.length ? activeOverlays.join(',') : 'none'));

  const btn = document.getElementById('proxyBtn');
  const target = getTargetIde();

  if (btn) {
    btn.disabled = true;
    const text = btn.querySelector('.proxy-btn-text');
    if (text) {
      text.textContent = proxyRunning ? '停止中…' : '启动中…';
    } else {
      btn.textContent = proxyRunning ? '停止中…' : '启动中…';
    }
  }
  try {
    if (proxyRunning) {
      const stoppedTarget = activeProxyTarget || target;
      const report = await invoke('stop_proxy', { targetIde: stoppedTarget });
      setStatusPill(false);
      // 检查还原报告，如果有警告则提示用户
      const warnings = [];
      if (report && report.ide_config && !report.ide_config.startsWith('ok')) {
        warnings.push('IDE 代理配置: ' + report.ide_config);
      }
      if (warnings.length) {
        addLog('warn', '⚠ 部分还原未成功: ' + warnings.join('；'));
        showCustomAlert('停止代理成功，但以下配置未能自动还原:\n\n• ' + warnings.join('\n• ') +
              '\n\n请手动检查 IDE 设置中的 http.proxy 和 http.proxyStrictSSL，否则 IDE 可能无法联网。', '部分还原失败', 'warn');
      } else {
        await promptRestartIde('已停止代理并还原配置。IDE 仍指向已关闭的代理，需重启才能恢复正常联网。', stoppedTarget);
      }
      activeProxyTarget = '';
    } else {
      let effectiveTarget = target;
      let check;
      try {
        check = await runEnvironmentCheck({ target, prefix: '启动自检' });
        effectiveTarget = check.effectiveTarget;
      } catch (e) {
        addLog('err', '启动自检执行失败，已阻止启动: ' + e);
        showCustomAlert('启动自检执行失败，代理未启动。请先处理异常后重试:\n\n' + e, '启动自检失败', 'error');
        return;
      }
      if (check.errors.length) {
        const messages = check.errors.map(i => i.message || String(i));
        showCustomAlert('无法启动，已自动处理能修复的部分。请先处理以下问题:\n\n• ' + messages.join('\n• '), '启动自检未通过', 'error');
        return;
      }
      if (check.warnings.length) {
        const messages = check.warnings.slice(0, 3).map(i => i.message || String(i));
        addLog('warn', `启动自检通过，但有 ${check.warnings.length} 条提示: ${messages.join('；')}`);
      }
      await invoke('start_proxy', { targetIde: target, skipPreflight: true });
      activeProxyTarget = effectiveTarget === 'auto' ? target : effectiveTarget;
      setStatusPill(true);
      await promptRestartIde('代理已启动，需重启 IDE 才能生效。', activeProxyTarget);
    }
  } catch (e) {
    addLog('err', '代理操作失败: ' + e);
    setStatusPill(proxyRunning);
  } finally {
    if (btn) btn.disabled = false;
  }
  } finally { _toggling = false; }
}

let _statusFailStreak = 0;
let _refreshStatusInFlight = false;
async function refreshStatus() {
  if (!invoke) return;
  if (_toggling) return;
  if (_refreshStatusInFlight) return;
  _refreshStatusInFlight = true;
  try {
    const s = await invoke('get_proxy_status');
    const running = !!s.running;
    if (running) {
      activeProxyTarget = s.target_ide || s.targetIde || activeProxyTarget;
    } else {
      activeProxyTarget = '';
    }
    setStatusPill(running);
    _statusFailStreak = 0;
  } catch (e) {
    // 轮询偶发失败不打扰用户；连续多次失败才告警一次，避免每 3 秒刷屏。
    _statusFailStreak++;
    if (_statusFailStreak === 5) addLog('warn', '无法获取代理状态(已连续失败5次): ' + e);
  } finally {
    _refreshStatusInFlight = false;
  }
}

// 代理状态变更后，提示并询问是否一键重启 IDE 使其生效。
function promptRestartIde(leadText, targetOverride) {
  if (!invoke) return Promise.resolve(false);
  const lead = leadText || '代理状态已变更，需重启 IDE 才能生效。';
  const target = targetOverride || activeProxyTarget || getTargetIde();

  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const btnCancel = document.getElementById('modal-btn-cancel');
    const btnConfirm = document.getElementById('modal-btn-confirm');

    if (!modal || !btnCancel || !btnConfirm) {
      // 降级使用 showCustomConfirm
      showCustomConfirm(lead + '\n\n重启会强制关闭 IDE，请先保存所有未保存的工作。', '需要重启 IDE', 'warn').then(resolve);
      return;
    }

    const leadEl = document.getElementById('modal-lead');
    if (leadEl) leadEl.textContent = lead;

    // 显示自定义 Modal
    modal.classList.add('active');

    const cleanup = (result) => {
      modal.classList.remove('active');
      // 移除事件监听，防止内存泄露和事件重复绑定
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      resolve(result);
    };

    function onCancel() {
      cleanup(false);
    }

    async function onConfirm() {
      cleanup(true);
      try {
        const result = await invoke('restart_ide', { target });
        addLog('ok', result);
      } catch (e) {
        addLog('err', '重启 IDE 失败: ' + e);
      }
    }

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
  });
}


function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

async function refreshStats() {
  if (!invoke) return;
  if (_toggling) return;
  if (refreshStats._inFlight) return;
  if (!proxyRunning) {
    setText('stat-requests', '—');
    setText('stat-requests-sub', '代理未运行');
    setText('stat-tokens', '—');
    setText('stat-provider', '—');
    setText('stat-model', '尚无请求');
    setText('stat-errors', '—');
    setText('stat-rpm', '—');
    setText('stat-tpm', '—');
    setText('stat-latency', '—');
    setText('stat-retries', '—');
    setText('stat-retries-sub', '本日累计');
    return;
  }
  refreshStats._inFlight = true;
  try {
    const s = await invoke('get_stats');
    // 第一排：累计指标
    setText('stat-requests', fmtNum(s.requests));
    setText('stat-requests-sub', s.requests > 0 ? `运行 ${Math.floor(s.uptimeSec / 60)} 分钟` : '等待请求');
    setText('stat-tokens', fmtNum(s.totalTokens));
    setText('stat-tokens-sub', `↑${fmtNum(s.inputTokens)} ↓${fmtNum(s.outputTokens)} · ≈$${s.estCostUsd}`);
    setText('stat-provider', s.lastProvider || '—');
    setText('stat-model', s.lastModel || '尚无请求');
    setText('stat-errors', fmtNum(s.errors));
    setText('stat-errors-sub', s.lastError ? `最近: ${s.lastError}` : '本日累计');
    // 第二排：速率指标
    const r = s.rate || {};
    setText('stat-rpm', r.rpm != null ? r.rpm : '—');
    setText('stat-tpm', r.tpm != null ? fmtNum(r.tpm) : '—');
    setText('stat-latency', r.avgLatencyMs != null ? `${r.avgLatencyMs}ms` : '—');
    setText('stat-retries', fmtNum(s.retries || 0));
    setText('stat-retries-sub', s.lastRetryReason ? `最近: ${s.lastRetryReason}` : '本日累计');
    // Top 模型横向条形图
    renderTopModels(s.byModel || {});
    // 更新 IDE 接入设置里的流量路由信息
    const rp = document.getElementById('route-providers');
    if (rp) {
      const activeCount = providerStore && providerStore.providers ? providerStore.providers.filter(p => p.enabled !== false).length : 0;
      rp.textContent = activeCount > 0 ? `${activeCount} 个供应商` : '—';
    }
  } catch (e) {
    // proxy running but stats endpoint not reachable yet — keep last values
  } finally {
    refreshStats._inFlight = false;
  }
}

function renderTopModels(byModel) {
  const container = document.getElementById('topModelsChart');
  if (!container) return;
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (entries.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:8px 0;">尚无数据</div>';
    return;
  }
  const maxVal = entries[0][1];
  const colors = ['#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#8b5cf6'];
  let html = '';
  entries.forEach(([model, count], i) => {
    const pct = Math.max(4, (count / maxVal) * 100);
    const color = colors[i % colors.length];
    html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <div style="width:120px;font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;" title="${model}">${model}</div>
      <div style="flex:1;height:18px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.4s ease;"></div>
      </div>
      <div style="width:40px;font-size:12px;color:var(--text-muted);text-align:right;flex-shrink:0;">${count}</div>
    </div>`;
  });
  container.innerHTML = html;
}

// ═══════ WINDOW CONTROLS ═══════
async function windowMinimize() {
  if (!appWindow) bindTauriBridge();
  if (appWindow) {
    try { await appWindow.minimize(); } catch(e) { _diag('minimize error: ' + e); }
  } else {
    _diag('windowMinimize: appWindow unavailable');
  }
}
async function windowMaximize() {
  if (!appWindow) bindTauriBridge();
  if (appWindow) {
    try { await appWindow.toggleMaximize(); } catch(e) { _diag('maximize error: ' + e); }
  } else {
    _diag('windowMaximize: appWindow unavailable');
  }
}
async function windowClose() {
  // Close request is intercepted by Rust → hides to tray.
  if (!appWindow) bindTauriBridge();
  if (appWindow) {
    try { await appWindow.close(); } catch(e) { _diag('close error: ' + e); }
  } else {
    _diag('windowClose: appWindow unavailable');
  }
}

function bindWindowControlHandlers() {
  const minBtn = document.querySelector('.win-minimize');
  const maxBtn = document.querySelector('.win-maximize');
  const closeBtn = document.querySelector('.win-close');

  const bind = (el, fn, label) => {
    if (!el) { _diag(`WARN: ${label} button not found`); return; }
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn().catch(err => _diag(`${label} error: ` + err));
    };
    el.addEventListener('click', handler);
    el.addEventListener('pointerup', handler);
    _diag(`${label} handler bound`);
  };
  bind(minBtn, windowMinimize, 'minimize');
  bind(maxBtn, windowMaximize, 'maximize');
  bind(closeBtn, windowClose, 'close');
}


// ═══════ THEME TOGGLE ═══════
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.title = theme === 'dark' ? '切换至浅色主题' : '切换至深色主题';
  }
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('byok-theme', next); } catch {}
}

// ═══════ LOG STREAM ═══════
const MAX_LOGS = 500;
let logEntries = [];
let logRenderScheduled = false;
let logScrollPending = false;

function nowTs() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderLogLine(e) {
  return `<div class="log-line"><span class="log-ts">${e.ts}</span><span class="log-lv ${e.level}">${e.level.toUpperCase().padEnd(4)}</span><span class="log-msg">${escapeHtml(e.msg)}</span></div>`;
}

function renderLogs() {
  const full = document.getElementById('fullLog');
  const dash = document.getElementById('dashLog');
  const filtered = (typeof logFilter !== 'undefined' && logFilter !== 'all')
    ? logEntries.filter(e => e.level === logFilter)
    : logEntries;
  if (full) full.innerHTML = filtered.map(renderLogLine).join('');
  if (dash) dash.innerHTML = logEntries.slice(-5).map(renderLogLine).join('');
  const count = document.getElementById('logCount');
  if (count) count.textContent = `${filtered.length} 条记录`;
}

function scheduleLogRender(scrollToBottom) {
  logScrollPending = logScrollPending || !!scrollToBottom;
  if (logRenderScheduled) return;
  logRenderScheduled = true;
  const schedule = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  schedule(() => {
    logRenderScheduled = false;
    renderLogs();
    if (logScrollPending) {
      const full = document.getElementById('fullLog');
      if (full) full.scrollTop = full.scrollHeight;
      logScrollPending = false;
    }
  });
}

function addLog(level, msg) {
  logEntries.push({ ts: nowTs(), level, msg });
  if (logEntries.length > MAX_LOGS) logEntries = logEntries.slice(-MAX_LOGS);
  scheduleLogRender(true);
}

function clearLogs() {
  logEntries = [];
  renderLogs();
}

let logFilter = 'all';
const LOG_FILTERS = ['all', 'ok', 'info', 'warn', 'err'];
const LOG_FILTER_LABELS = { all: '全部', ok: 'OK', info: 'INFO', warn: 'WARN', err: 'ERR' };

function cycleLogFilter() {
  const i = LOG_FILTERS.indexOf(logFilter);
  logFilter = LOG_FILTERS[(i + 1) % LOG_FILTERS.length];
  const btn = document.getElementById('logFilterBtn');
  if (btn) btn.textContent = `筛选: ${LOG_FILTER_LABELS[logFilter]} ▾`;
  renderLogs();
}

async function exportLogs() {
  if (logEntries.length === 0) {
    addLog('warn', '暂无日志可导出');
    return;
  }
  if (invoke || bindTauriBridge()) {
    try {
      const path = await invoke('export_proxy_logs', { entries: logEntries });
      addLog('ok', `已导出 ${logEntries.length} 条日志: ${path}`);
      return;
    } catch (e) {
      addLog('warn', '后端导出失败，尝试浏览器下载: ' + e);
    }
  }
  const text = logEntries.map(e => `[${e.ts}] ${e.level.toUpperCase()} ${e.msg}`).join('\n');
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

// ═══════ ACCESS GUIDE (replaces patch logic) ═══════
async function openCertsDir() {
  if (!invoke) return;
  try { await invoke('open_config_dir', { which: 'certs' }); }
  catch (e) { addLog('err', '打开目录失败: ' + e); }
}
async function openConfigDir() {
  if (!invoke) return;
  try { await invoke('open_config_dir', { which: 'config' }); }
  catch (e) { addLog('err', '打开目录失败: ' + e); }
}
async function generateCerts() {
  if (!invoke) return;
  const status = document.getElementById('cert-status');
  try {
    const result = await invoke('generate_certs');
    if (status) status.textContent = result + '（重启代理后生效）';
    addLog('ok', '证书: ' + result);
  } catch (e) {
    if (status) status.textContent = '生成失败: ' + e;
    addLog('err', '证书生成失败: ' + e);
  }
}

async function runSettingsEnvironmentCheck() {
  const btn = document.getElementById('env-check-btn');
  const summary = document.getElementById('env-check-summary');
  if (btn) btn.disabled = true;
  if (summary) summary.textContent = '体检中，正在自动修复可处理的问题…';
  try {
    const result = await runEnvironmentCheck({ target: getTargetIde(), prefix: '手动体检', renderTo: 'env-check-results' });
    if (summary) {
      summary.textContent = result.errors.length
        ? `体检未通过：${result.errors.length} 个错误，${result.warnings.length} 个提示`
        : `体检通过：${result.warnings.length} 个提示`;
    }
    if (result.errors.length) {
      showCustomAlert('环境体检未通过:\n\n• ' + result.errors.map(i => i.message || String(i)).join('\n• '), '环境体检', 'error');
    }
  } catch (e) {
    if (summary) summary.textContent = '体检失败: ' + e;
    addLog('err', '手动体检失败: ' + e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function detectIdePath() {
  if (!invoke) return;
  const input = document.getElementById('idePath');
  const status = document.getElementById('ide-path-status');
  try {
    const target = getTargetIde();
    const path = await invoke('detect_ide_path', { target });
    if (path) {
      if (input) input.value = path;
      if (status) status.textContent = '已自动定位 ✓';
    } else {
      if (input) { input.value = ''; input.placeholder = '未自动定位，请手动指定 IDE 可执行文件'; }
      if (status) status.textContent = '自动探测失败，请手动指定 IDE 可执行文件后保存';
    }
  } catch (e) {
    if (status) status.textContent = '探测失败: ' + e;
  }
}

async function saveIdePath() {
  if (!invoke) return;
  const input = document.getElementById('idePath');
  const status = document.getElementById('ide-path-status');
  const path = input ? input.value.trim() : '';
  if (!path) { if (status) status.textContent = '请先填写 IDE 可执行文件路径'; return; }
  try {
    await invoke('set_ide_path', { path });
    if (status) status.textContent = '已保存路径 ✓（下次启动代理生效）';
    addLog('ok', 'IDE 路径已设置: ' + path);
  } catch (e) {
    if (status) status.textContent = '保存失败: ' + e;
    addLog('err', 'IDE 路径保存失败: ' + e);
  }
}

// ═══════ CONFIG PERSISTENCE ═══════
async function loadAndFillConfig() {
  if (!invoke) return {};
  try {
    const values = await invoke('load_config');
    document.querySelectorAll('[data-config-key]').forEach(el => {
      const k = el.getAttribute('data-config-key');
      if (k in values) el.value = values[k];
    });
    applyToggleStates(values);
    return values;
  } catch (e) { return {}; }
}

async function saveConfigField(key, value) {
  if (!invoke) return false;
  try {
    const current = await invoke('load_config');
    current[key] = value;
    await invoke('save_config', { values: current });
    return true;
  } catch (e) {
    addLog('err', '保存配置失败: ' + e);
    return false;
  }
}

document.querySelectorAll('[data-config-key]').forEach(el => {
  el.addEventListener('change', () => saveConfigField(el.getAttribute('data-config-key'), el.value));
});

// ═══════ TOGGLE SWITCHES (persisted as config) ═══════
document.querySelectorAll('[data-config-toggle]').forEach(el => {
  el.addEventListener('click', async () => {
    el.classList.toggle('on');
    const key = el.getAttribute('data-config-toggle');
    const ok = await saveConfigField(key, el.classList.contains('on') ? 'true' : 'false');
    if (!ok) el.classList.toggle('on'); // 保存失败，回滚 UI 状态
  });
});

document.querySelectorAll('[data-autostart]').forEach(el => {
  el.addEventListener('click', async () => {
    el.classList.toggle('on');
    const enabled = el.classList.contains('on');
    if (invoke) {
      try { await invoke('set_autostart', { enabled }); addLog('ok', enabled ? '已设置开机自启' : '已取消开机自启'); }
      catch (e) { el.classList.toggle('on'); addLog('err', '自启设置失败: ' + e); }
    }
  });
});

function applyToggleStates(config) {
  document.querySelectorAll('[data-config-toggle]').forEach(el => {
    const key = el.getAttribute('data-config-toggle');
    if (config[key] === 'true') el.classList.add('on');
    else if (config[key] === 'false') el.classList.remove('on');
  });
}
