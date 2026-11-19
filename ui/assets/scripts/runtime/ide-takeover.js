// runtime/ide-takeover.js — IDE 代理状态探测、端口保存、预检与主代理启停轮询
import { fmtNum, forEachElementAlias, setText, setBar, pctOf, escapeHtml } from '../ui/dom.js';
import { addLog, clearLogs, setLogFilter, openLogViewerModal, closeLogViewerModal, closeLogViewerOnEsc, syncLogViewerControls, onLogViewerLevelChange, setLogViewerLevelPreset, onLogViewerSearchInput, onLogViewerLimitChange, onLogViewerOrderChange, onLogViewerAutoScrollChange, logViewerFilteredEntries, renderLogViewerLine, renderLogViewer, exportLogs, nowTs, renderLogLine, renderLogs, scheduleLogRender } from '../state/logs.js';
import { syncProxyPageControls } from './proxy-overview.js';
import { readTakeoverStateSafe, isTakeoverFresh, takeoverWarmupElapsed } from './proxy-lifecycle.js';

async function refreshIdeProxyStatus(targetOverride = '') {
  if (!invoke) return null;
  const target = normalizeIdeProxyTargetValue(targetOverride || (typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf'));
  try {
    const status = await invoke('get_ide_proxy_status', { target });
    ideProxyStatusByTarget[target] = status || { target, patched: false };
    syncIdeProxyButton();
    return ideProxyStatusByTarget[target];
  } catch (e) {
    addLog('warn', `${ideDisplayLabel(target)} 网关切换状态读取失败: ${e}`);
    syncIdeProxyButton();
    return null;
  }
}

async function ensureLocalProxyConfig(values = {}) {
  localProxyPort = parseInt(values.PROXY_PORT || values.LOCAL_PROXY_PORT || localProxyPort || '7450', 10) || 7450;
  localProxyInferencePort = parseInt(values.INFERENCE_PORT || values.LOCAL_INFERENCE_PORT || localProxyInferencePort || '7451', 10) || 7451;
  localProxyKey = String(values.LOCAL_PROXY_KEY || localProxyKey || '').trim();
  if (!localProxyKey && invoke) {
    const previousKey = localProxyKey;
    localProxyKey = generateLocalProxyKeyValue();
    try {
      const current = await invoke('load_config') || {};
      current.LOCAL_PROXY_KEY = localProxyKey;
      current.PROXY_PORT = String(localProxyPort);
      current.INFERENCE_PORT = String(localProxyInferencePort);
      await invoke('save_config', { values: current });
    } catch (e) {
      localProxyKey = previousKey;
      addLog('err', '生成本地网关 key 后保存失败: ' + e);
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(String(e), '本地网关 key 保存失败', 'error');
      }
    }
  }
  syncLocalProxyUi();
}

async function persistLocalProxyConfig() {
  if (!invoke) return false;
  try {
    const current = await invoke('load_config') || {};
    current.LOCAL_PROXY_KEY = localProxyKey;
    current.PROXY_PORT = String(localProxyPort);
    current.INFERENCE_PORT = String(localProxyInferencePort);
    await invoke('save_config', { values: current });
    return true;
  } catch (e) {
    addLog('err', '保存本地网关配置失败: ' + e);
    return false;
  }
}

function parseProxyPortInputValue(value, label) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label} 必须是 1-65535 之间的端口号`);
  }
  return n;
}

function proxyPortInputIds(source = 'proxy') {
  return source === 'settings'
    ? { api: 'settingsProxyPortInput', inference: 'settingsInferencePortInput' }
    : { api: 'localProxyPortInput', inference: 'localProxyInferencePortInput' };
}

async function saveLocalProxyPorts(source = 'proxy') {
  if (!invoke && !bindTauriBridge()) return;
  const ids = proxyPortInputIds(source);
  const apiInput = document.getElementById(ids.api);
  const inferenceInput = ids.inference ? document.getElementById(ids.inference) : null;
  try {
    const nextApiPort = parseProxyPortInputValue(apiInput?.value || getLocalProxyPort(), 'API 服务端口');
    const nextInferencePort = inferenceInput
      ? parseProxyPortInputValue(inferenceInput.value || getLocalProxyInferencePort(), '推理服务端口')
      : getLocalProxyInferencePort();
    if (nextApiPort === nextInferencePort) {
      throw new Error('API 服务端口和推理服务端口不能相同');
    }
    const changed = nextApiPort !== getLocalProxyPort() || nextInferencePort !== getLocalProxyInferencePort();
    if (proxyRunning && changed) {
      const ok = await showCustomConfirm(
        '修改端口需要重启本地网关。保存后会立即重启网关，已经写入外部工具的本地网关地址需要重新应用或复制。',
        '保存端口并重启',
        'warn'
      );
      if (!ok) {
        syncLocalProxyUi();
        return;
      }
    }
    const previousApiPort = localProxyPort;
    const previousInferencePort = localProxyInferencePort;
    localProxyPort = nextApiPort;
    localProxyInferencePort = nextInferencePort;
    const saved = await persistLocalProxyConfig();
    if (!saved) {
      localProxyPort = previousApiPort;
      localProxyInferencePort = previousInferencePort;
      syncLocalProxyUi();
      showCustomAlert('本地网关端口保存失败，已恢复原端口。', '保存失败', 'error');
      return;
    }
    syncLocalProxyUi();
    if (typeof renderPlatformDetailStatuses === 'function') renderPlatformDetailStatuses();
    addLog('ok', `本地网关端口已保存: ${nextApiPort} / ${nextInferencePort}`);
    if (proxyRunning && changed) {
      await restartGlobalProxyService();
    } else {
      showCustomAlert('本地网关端口已保存。', '保存完成', 'success');
    }
  } catch (e) {
    syncLocalProxyUi();
    addLog('err', '保存本地网关端口失败: ' + e);
    showCustomAlert(String(e.message || e), '保存失败', 'error');
  }
}
async function copyTextToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    addLog('ok', `已复制${label || ''}`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已复制 ${label || '内容'} 到剪贴板`, 'success');
    }
  } catch (e) {
    addLog('err', `复制失败: ${e}`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`复制失败: ${e?.message || e}`, 'error');
    }
  }
}

async function copyLocalProxyValue(kind) {
  const value = kind === 'key'
    ? getLocalProxyKeyValue()
    : kind === 'unified'
      ? localProxyOrigin()
      : kind === 'claude'
        ? localProxyBaseUrl('anthropic')
        : kind === 'gemini'
          ? localProxyBaseUrl('gemini')
          : kind === 'models'
            ? localProxyModelsUrl()
            : localProxyBaseUrl('openai');
  if (!value) {
    addLog('warn', '本地网关 key 尚未生成');
    return;
  }
  await copyTextToClipboard(value, kind === 'key' ? '本地 key' : (kind === 'unified' ? '统一 Base URL' : '本地网关地址'));
}

async function regenerateLocalProxyKey() {
  const ok = await showCustomConfirm('重新生成后，已经写入外部工具的本地网关 key 需要重新应用。', '重新生成本地 key', 'warn');
  if (!ok) return;
  const previousKey = localProxyKey;
  localProxyKey = generateLocalProxyKeyValue();
  const saved = await persistLocalProxyConfig();
  if (!saved) {
    localProxyKey = previousKey;
    syncLocalProxyUi();
    showCustomAlert('本地网关 key 保存失败，已恢复原 key。', '保存失败', 'error');
    return;
  }
  syncLocalProxyUi();
  if (typeof renderPlatformDetailStatuses === 'function') renderPlatformDetailStatuses();
  addLog('ok', '本地网关 key 已重新生成');
}
// 防连点:记录进行中的 toggle key,同一目标的并发操作会被忽略,避免后写覆盖先写。
globalThis._inFlightToggles = new Set();

function ideDisplayLabel(ide) {
  const labels = {
    windsurf: 'Windsurf',
    devin: 'Devin',
    cursor: 'Cursor',
    auto: '自动检测',
    'antigravity-ide': 'Antigravity IDE',
    'claude-desktop': 'Claude Desktop',
  };
  return labels[ide] || (ide ? ide.charAt(0).toUpperCase() + ide.slice(1) : 'Windsurf');
}

function statusTargetIde() {
  return proxyRunning && activeProxyTarget ? activeProxyTarget : getTargetIde();
}

function setStatusPill(running, status = {}) {
  proxyRunning = !!running;
  if (status && (status.api_port || status.apiPort)) {
    localProxyPort = Number(status.api_port || status.apiPort) || localProxyPort || 7450;
  }
  if (status && (status.inference_port || status.inferencePort)) {
    localProxyInferencePort = Number(status.inference_port || status.inferencePort) || localProxyInferencePort || 7451;
  }
  const sub = document.getElementById('controlSub');
  const platformSubs = Array.from(document.querySelectorAll('[data-proxy-control-sub]'));
  const ide = normalizeIdeProxyTargetValue(typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf');
  const ideLabel = ideDisplayLabel(ide);
  const ideStatus = ideProxyStatusByTarget[ide] || {};
  const subText = ideStatus.patched
    ? (proxyRunning ? `已切到网关 · ${ideLabel} · ${getLocalProxyPort()}` : `已切到网关，网关未运行 · ${ideLabel}`)
    : `未切到网关 · ${ideLabel} · ${getLocalProxyPort()}`;
  [sub, ...platformSubs].filter(Boolean).forEach(el => { el.textContent = subText; });
  updateGlobalProxyStatusPill(proxyRunning);
  updateProxyPageState(proxyRunning);
  syncLocalProxyUi();
  syncIdeProxyButton();
}
globalThis._toggling = false;

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

function promptInstallCertificateBeforeProxy() {
  const message = '切换到网关前需要安装本地证书，IDE 才能信任本机代理。';
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const titleEl = modal?.querySelector('.modal-title');
    const leadEl = document.getElementById('modal-lead');
    const questionEl = leadEl?.nextElementSibling;
    const warningEl = modal?.querySelector('.modal-warning');
    const warningTextEl = warningEl?.querySelector('span:last-child');
    const btnCancel = document.getElementById('modal-btn-cancel');
    const btnConfirm = document.getElementById('modal-btn-confirm');

    if (!modal || !btnCancel || !btnConfirm) {
      if (typeof showCustomConfirm === 'function') {
        showCustomConfirm(message + '\n\n是否现在安装证书并继续切换到网关？', '需要安装证书', 'warn').then(resolve);
      } else {
        resolve(confirm(message + '\n\n是否现在安装证书并继续切换到网关？'));
      }
      return;
    }

    const prev = {
      title: titleEl ? titleEl.innerHTML : '',
      lead: leadEl ? leadEl.textContent : '',
      question: questionEl ? questionEl.textContent : '',
      warningDisplay: warningEl ? warningEl.style.display : '',
      warningText: warningTextEl ? warningTextEl.innerHTML : '',
      cancelText: btnCancel.textContent,
      confirmText: btnConfirm.textContent,
      confirmWidth: btnConfirm.style.width,
    };

    if (titleEl) {
      titleEl.innerHTML =
        '<span class="modal-icon" style="color: var(--accent);">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="4" y="11" width="16" height="9" rx="2"></rect>' +
        '<path d="M8 11V7a4 4 0 0 1 8 0v4"></path>' +
        '<path d="M12 15v2"></path>' +
        '</svg>' +
        '</span>' +
        '<span>需要安装证书</span>';
    }
    if (leadEl) leadEl.textContent = message;
    if (questionEl) questionEl.textContent = '点击「安装证书并继续」后，应用会自动安装证书，安装成功就继续切换到网关。';
    if (warningEl) warningEl.style.display = '';
    if (warningTextEl) {
      warningTextEl.innerHTML = '如果系统弹出授权窗口，请选择<strong>是</strong>。这是本机网关证书，只用于让 IDE 信任当前电脑上的网关。';
    }
    btnCancel.textContent = '暂不切换';
    btnConfirm.textContent = '安装证书并继续';
    btnConfirm.style.width = '';

    modal.classList.add('active');

    const restore = () => {
      if (titleEl) titleEl.innerHTML = prev.title;
      if (leadEl) leadEl.textContent = prev.lead;
      if (questionEl) questionEl.textContent = prev.question;
      if (warningEl) warningEl.style.display = prev.warningDisplay;
      if (warningTextEl) warningTextEl.innerHTML = prev.warningText;
      btnCancel.textContent = prev.cancelText;
      btnConfirm.textContent = prev.confirmText;
      btnConfirm.style.width = prev.confirmWidth;
    };
    const cleanup = (result) => {
      modal.classList.remove('active');
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      restore();
      resolve(result);
    };
    const onConfirm = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(true); };
    const onCancel = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(false); };
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onEsc = (e) => { if (e.key === 'Escape' && modal.classList.contains('active')) cleanup(false); };

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}

function setProxyButtonBusyText(textValue) {
  const btn = document.getElementById('proxyBtn');
  if (!btn) return;
  const text = btn.querySelector('.proxy-btn-text');
  if (text) {
    text.textContent = textValue;
  } else {
    btn.textContent = textValue;
  }
}

function setProxyPlatformActionBusy(busy) {
  const restoreBtn = document.getElementById('proxyRestoreBtn');
  ['proxyBtn', 'proxyRefreshBtn', 'proxyRestoreBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (busy) {
      el.disabled = true;
      return;
    }
    // 结束 busy 后，停止接入仍由 syncIdeProxyButton 按 patched 状态决定
    if (id === 'proxyRestoreBtn') return;
    el.disabled = false;
  });
  if (!busy && typeof syncIdeProxyButton === 'function') {
    syncIdeProxyButton();
  } else if (!busy && restoreBtn) {
    // fallback: 未接入时保持禁用
    const target = normalizeIdeProxyTargetValue(typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf');
    const patched = !!(ideProxyStatusByTarget[target] || {}).patched;
    restoreBtn.disabled = !patched;
    restoreBtn.classList.toggle('is-danger', patched);
  }
}

async function refreshCurrentProxyPlatformStatus() {
  if (!invoke && !bindTauriBridge()) return;
  const target = await resolveIdeProxyTarget(false);
  await refreshStatus();
  await refreshIdeProxyStatus(target);
  addLog('info', `${ideDisplayLabel(target)} 状态已刷新`);
}

async function restoreCurrentProxyPlatformDirect() {
  return toggleProxy('direct');
}

async function toggleProxy(mode = 'toggle') {
  _diag('toggleProxy called');
  if (_toggling) { _diag('toggleProxy skipped: already in progress'); return; }
  _toggling = true;
  const btn = document.getElementById('proxyBtn');
  try {
    if (!invoke && !bindTauriBridge()) {
      _diag('toggleProxy abort: invoke unavailable');
      addLog('err', 'Tauri 通道未就绪，网关切换不可用。请重启应用后重试。');
      return;
    }

    const target = await resolveIdeProxyTarget(true);
    const label = ideDisplayLabel(target);
    const status = await refreshIdeProxyStatus(target);
    const patched = !!status?.patched;

    if (mode === 'proxy' && patched) {
      if (!proxyRunning) {
        setProxyPlatformActionBusy(true);
        setProxyButtonBusyText('启动网关...');
        setGlobalProxyBusy(true, '网关启动中');
        try {
          await invoke('start_proxy_service');
          addLog('ok', '本地网关已自动启动');
        } catch (e) {
          if (String(e).includes('网关已在运行')) {
            addLog('warn', '网关服务已在运行，已刷新状态');
          } else {
            updateGlobalProxyStatusPill(false, 'error');
            updateProxyPageState(false, 'error');
            throw new Error('自动启动本地网关失败: ' + e);
          }
        } finally {
          setGlobalProxyBusy(false);
        }
        await refreshStatus();
      }
      // 已 patched 只代表配置写进了 settings.json，不代表生效：IDE 只在启动时读取它。
      // 用「接管心跳」判断流量是否真的进了代理。之前这里直接 return，
      // 导致错过第一次重启弹窗的用户再也得不到任何提示（IDE 永远显示官方原模型）。
      const takeover = await readTakeoverStateSafe();
      const takeoverFresh = isTakeoverFresh(takeover);
      if (!takeoverFresh && takeoverWarmupElapsed(takeover)) {
        await promptRestartIde(
          `代理还没收到 ${label} 的模型请求，通常是写入配置后未重启（macOS 需 Cmd+Q 完全退出）。`,
          target,
          { mode: 'proxy', statusText: null },
        );
        return;
      }
      addLog('info', takeoverFresh ? `${label} 已接入 AnyBridge（接管已生效）` : `${label} 已接入 AnyBridge，等待 ${label} 连接`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(takeoverFresh ? `${label} 已接入 AnyBridge` : `${label} 已接入，请重启 ${label} 生效`, takeoverFresh ? 'info' : 'warn');
      }
      return;
    }

    if (mode === 'direct' && !patched) {
      addLog('info', `${label} 当前未接入网关，无需还原`);
      if (typeof showBottomToast === 'function') showBottomToast(`${label} 当前未接入网关`, 'info');
      return;
    }

    setProxyPlatformActionBusy(true);
    setProxyButtonBusyText(mode === 'direct' || patched ? '停止中...' : '接入中...');

    if (mode === 'direct' || (mode === 'toggle' && patched)) {
      // 精简交互：不再单独弹「确认停止」窗口，直接执行恢复；
      // 由后续「重启 IDE」弹窗（立即重启 / 稍后）作为唯一确认点。
      const report = await invoke('restore_ide_direct', { target });
      const warnings = [];
      if (report && report.ideConfig && !String(report.ideConfig).startsWith('ok')) warnings.push('IDE 配置: ' + report.ideConfig);
      if (report && report.workbenchInject && !String(report.workbenchInject).startsWith('ok')) warnings.push('卡片注入: ' + report.workbenchInject);
      if (report && report.cursorAuth && !String(report.cursorAuth).startsWith('ok')) warnings.push('Cursor 状态: ' + report.cursorAuth);
      // 状态刷新是善后工作，不该挡在用户反馈（警告/重启确认）前面。
      // 原顺序先 await 刷新（1-2 秒）才弹窗，点击后有明显卡顿感。
      const refreshLater = () => {
        refreshIdeProxyStatus(target)
          .then(() => setStatusPill(proxyRunning))
          .catch(() => {});
      };
      if (warnings.length) {
        addLog('warn', `${label} 停止接入完成，但有提示: ${warnings.join('；')}`);
        showCustomAlert(warnings.join('\n'), '停止接入提示', 'warn');
        refreshLater();
      } else {
        addLog('ok', `${label} 已停止接入`);
        await promptRestartIde('已恢复直连，重启后生效。', target, { mode: 'direct', statusText: null });
        refreshLater();
      }
      return;
    }

    if (!proxyRunning) {
      setProxyButtonBusyText('启动网关...');
      setGlobalProxyBusy(true, '网关启动中');
      try {
        await invoke('start_proxy_service');
        addLog('ok', '本地网关已自动启动');
      } catch (e) {
        if (String(e).includes('网关已在运行')) {
          addLog('warn', '网关服务已在运行，已刷新状态后继续切换');
        } else {
          updateGlobalProxyStatusPill(false, 'error');
          updateProxyPageState(false, 'error');
          throw new Error('自动启动本地网关失败: ' + e);
        }
      } finally {
        setGlobalProxyBusy(false);
      }
      await refreshStatus();
    }

    setProxyButtonBusyText('接入中...');
    const report = await invoke('switch_ide_to_proxy', { target });
    const injectWarn = report && report.workbenchInject && String(report.workbenchInject).startsWith('warn:')
      ? report.workbenchInject.replace(/^warn:\s*/, '')
      : '';
    const cursorState = report && report.cursorAuth && String(report.cursorAuth).startsWith('ok')
      ? report.cursorAuth
      : '';
    addLog('ok', `${label} 已切换到 AnyBridge 内置供应商`);
    if (injectWarn) addLog('warn', `${label} 卡片注入提示: ${injectWarn}`);
    if (cursorState && target === 'cursor') addLog('ok', `Cursor 状态已写入: ${cursorState}`);
    await promptRestartIde('已切到网关，重启后生效。', target, {
      mode: 'proxy',
      statusText: null,
      detail: injectWarn
    });
    // 弹窗响应后再刷新状态：刷新是善后工作，不该挡在重启确认前面
    await refreshIdeProxyStatus(target);
    setStatusPill(proxyRunning);
  } catch (e) {
    addLog('err', '平台网关切换失败: ' + e);
    showCustomAlert(String(e), '切换失败', 'error');
    setStatusPill(proxyRunning);
  } finally {
    setProxyPlatformActionBusy(false);
    _toggling = false;
    syncIdeProxyButton();
  }
}

function setGlobalProxyBusy(busy, label = '') {
  ['globalProxyStartBtn', 'globalProxyStopBtn', 'globalProxyRestartBtn', 'topbarProxyPrimaryBtn', 'topbarProxyRestartBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!busy;
  });
  if (busy) {
    updateGlobalProxyStatusPill(false, 'starting');
    updateProxyPageState(false, 'starting');
    if (label) setText('proxyPageStateText', label);
  } else {
    syncTopbarProxyControls(proxyRunning);
    syncProxyPageControls(proxyRunning);
  }
}

async function startGlobalProxyService() {
  if (!invoke && !bindTauriBridge()) return;
  if (proxyRunning) {
    if (typeof showBottomToast === 'function') showBottomToast('本地网关已在运行中', 'info');
    return;
  }
  setGlobalProxyBusy(true, '网关启动中');
  try {
    await invoke('start_proxy_service');
    await refreshStatus();
    addLog('ok', '本地网关已启动');
  } catch (e) {
    updateGlobalProxyStatusPill(false, 'error');
    updateProxyPageState(false, 'error');
    addLog('err', '启动本地网关失败: ' + e);
    showCustomAlert(String(e), '启动失败', 'error');
  } finally {
    setGlobalProxyBusy(false);
  }
}

async function stopGlobalProxyService() {
  if (!invoke && !bindTauriBridge()) return;
  setGlobalProxyBusy(true, '网关停止中');
  try {
    await invoke('stop_proxy_service');
    setStatusPill(false);
    addLog('ok', '本地网关已停止');
  } catch (e) {
    if (String(e).includes('网关未运行')) setStatusPill(false);
    else {
      addLog('err', '停止本地网关失败: ' + e);
      showCustomAlert(String(e), '停止失败', 'error');
    }
  } finally {
    setGlobalProxyBusy(false);
  }
}

async function restartGlobalProxyService() {
  if (!invoke && !bindTauriBridge()) return;
  setGlobalProxyBusy(true, '网关重启中');
  try {
    await invoke('restart_proxy_service');
    await refreshStatus();
    addLog('ok', '本地网关已重启');
  } catch (e) {
    updateGlobalProxyStatusPill(false, 'error');
    updateProxyPageState(false, 'error');
    addLog('err', '重启本地网关失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
  } finally {
    setGlobalProxyBusy(false);
  }
}
globalThis._statusFailStreak = 0;
globalThis._refreshStatusInFlight = false;
async function refreshStatus() {
  if (!invoke) return;
  // 可见性守卫（借鉴 magpie）：窗口最小化/遮挡时不做状态轮询，
  // 避免后台空转；恢复可见时立即补一次刷新。
  if (typeof document !== 'undefined' && document.hidden) return;
  if (_refreshStatusInFlight) return;
  _refreshStatusInFlight = true;
  try {
    const s = await invoke('get_proxy_status');
    const running = !!s.running;
    activeProxyTarget = running ? (s.target_ide || s.targetIde || '') : '';
    setStatusPill(running, s);
    _statusFailStreak = 0;
    refreshIdeProxyStatus().catch(() => {});
  } catch (e) {
    _statusFailStreak++;
    if (_statusFailStreak === 5) addLog('warn', '无法获取网关状态(已连续失败5次): ' + e);
  } finally {
    _refreshStatusInFlight = false;
  }
}
// 恢复可见时立即补一次刷新（守卫跳过的周期在这里补齐）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && typeof refreshStatus === 'function') {
      refreshStatus().catch(() => {});
    }
  });
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.refreshIdeProxyStatus = refreshIdeProxyStatus;
  g.ensureLocalProxyConfig = ensureLocalProxyConfig;
  g.persistLocalProxyConfig = persistLocalProxyConfig;
  g.parseProxyPortInputValue = parseProxyPortInputValue;
  g.proxyPortInputIds = proxyPortInputIds;
  g.saveLocalProxyPorts = saveLocalProxyPorts;
  g.copyTextToClipboard = copyTextToClipboard;
  g.copyLocalProxyValue = copyLocalProxyValue;
  g.regenerateLocalProxyKey = regenerateLocalProxyKey;
  g.ideDisplayLabel = ideDisplayLabel;
  g.statusTargetIde = statusTargetIde;
  g.setStatusPill = setStatusPill;
  g.renderPreflightReport = renderPreflightReport;
  g.runEnvironmentCheck = runEnvironmentCheck;
  g.promptInstallCertificateBeforeProxy = promptInstallCertificateBeforeProxy;
  g.setProxyButtonBusyText = setProxyButtonBusyText;
  g.setProxyPlatformActionBusy = setProxyPlatformActionBusy;
  g.refreshCurrentProxyPlatformStatus = refreshCurrentProxyPlatformStatus;
  g.restoreCurrentProxyPlatformDirect = restoreCurrentProxyPlatformDirect;
  g.toggleProxy = toggleProxy;
  g.setGlobalProxyBusy = setGlobalProxyBusy;
  g.startGlobalProxyService = startGlobalProxyService;
  g.stopGlobalProxyService = stopGlobalProxyService;
  g.restartGlobalProxyService = restartGlobalProxyService;
  g.refreshStatus = refreshStatus;
})(globalThis);
