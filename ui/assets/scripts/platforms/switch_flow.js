// platforms/switch_flow.js — split from 55-platforms.js
// ═══════ 切换进度提示 ═══════

globalThis._switchProgressUnlisten = null;
globalThis._switchProgressPlatform = null;
globalThis._switchFlowState = null;

// 后端 message 契约（见 codex_desktop.rs 顶部注释）：
//   第一行 = 给用户看的固定句，整句作为 key 收录在 ui/assets/i18n/en-US.js；
//   第二行起 = `详情：…` 技术原因（端口、os error）。
// 主句上屏（可被 DOM 翻译），详情进日志面板，不把底层错误砸给用户。
// 入参可能是 Error 对象、invoke 抛出的字符串或后端返回的 message 字符串，
// 统一在这里归一，避免 String(error) 变成 "[object Object]"。
function rawMessageText(source) {
  if (source && typeof source === 'object' && 'message' in source) {
    return String(source.message || '');
  }
  return String(source === undefined || source === null ? '' : source);
}

function messageHeadline(source) {
  const raw = rawMessageText(source).trim();
  if (!raw) return '';
  return raw.split('\n')[0].trim() || raw;
}

function messageDetail(source) {
  const lines = rawMessageText(source).trim().split('\n');
  return lines.length > 1 ? lines.slice(1).join(' ').trim() : '';
}

function switchFlowErrorText(e) {
  return messageHeadline(e) || '未知错误';
}

// 日志保留完整信息（主句 + 详情），便于用户回帖时直接复制。
function switchFlowErrorLog(e, prefix = '') {
  const main = switchFlowErrorText(e);
  const detail = messageDetail(e);
  return `${prefix}${main}${detail ? `｜${detail}` : ''}`;
}

function assertSwitchResultOk(result, fallbackMessage) {
  if (result && result.ok === false) {
    throw new Error(result.message || fallbackMessage || '操作失败');
  }
  return result;
}

async function runSwitchFlow(options) {
  const {
    title = '确认切换',
    lead = '',
    confirmText = '确定',
    platform,
    runningMessage = '正在处理…',
    successTitle = '切换完成',
    failureTitle = '切换失败',
    skipConfirm = false,
    task,
  } = options || {};

  if (_switchFlowState) {
    throw new Error('已有切换任务正在进行，请等待完成。');
  }
  if (typeof task !== 'function') {
    throw new Error('切换任务未配置。');
  }

  const modal = document.getElementById('custom-confirm-modal');
  const bodyEl = modal?.querySelector('.modal-body');
  const titleEl = document.getElementById('custom-confirm-title');
  const leadEl = document.getElementById('modal-lead');
  const questionEl = leadEl?.nextElementSibling;
  const warningEl = modal?.querySelector('.modal-warning');
  const btnCancel = document.getElementById('modal-btn-cancel');
  const btnConfirm = document.getElementById('modal-btn-confirm');
  if (!modal || !bodyEl || !titleEl || !leadEl || !btnCancel || !btnConfirm) {
    throw new Error('切换确认弹窗 DOM 未初始化。');
  }

  return new Promise((resolve) => {
    const prev = {
      title: titleEl.textContent,
      lead: leadEl.textContent,
      leadDisplay: leadEl.style.display,
      leadWhiteSpace: leadEl.style.whiteSpace,
      question: questionEl ? questionEl.textContent : '',
      questionDisplay: questionEl ? questionEl.style.display : '',
      warningDisplay: warningEl ? warningEl.style.display : '',
      cancelText: btnCancel.textContent,
      cancelDisplay: btnCancel.style.display,
      cancelDisabled: btnCancel.disabled,
      confirmText: btnConfirm.textContent,
      confirmDisplay: btnConfirm.style.display,
      confirmDisabled: btnConfirm.disabled,
      confirmWidth: btnConfirm.style.width,
      confirmMinWidth: btnConfirm.style.minWidth,
    };

    let flowResult = { confirmed: false };
    const flowEl = document.createElement('div');
    flowEl.className = 'switch-flow-state';
    flowEl.setAttribute('aria-live', 'polite');
    flowEl.style.display = 'none';
    bodyEl.appendChild(flowEl);

    const renderProgress = (message) => {
      flowEl.className = 'switch-flow-state is-running';
      flowEl.style.display = '';
      flowEl.innerHTML = `
        <span class="switch-progress-spinner" aria-hidden="true"></span>
        <span class="switch-flow-msg"></span>
      `;
      const msgEl = flowEl.querySelector('.switch-flow-msg');
      if (msgEl) msgEl.textContent = message || '正在处理…';
    };

    const setMessage = (message) => {
      if (!message) return;
      const msgEl = flowEl.querySelector('.switch-flow-msg');
      if (msgEl) msgEl.textContent = message;
    };

    const renderResult = (ok, message) => {
      titleEl.textContent = ok ? successTitle : failureTitle;
      leadEl.style.display = 'none';
      flowEl.className = `switch-flow-state is-result ${ok ? 'is-success' : 'is-error'}`;
      flowEl.style.display = '';
      flowEl.innerHTML = `
        <span class="switch-flow-icon" aria-hidden="true">${ok ? '✓' : '!'}</span>
        <span class="switch-flow-msg"></span>
      `;
      const msgEl = flowEl.querySelector('.switch-flow-msg');
      if (msgEl) msgEl.textContent = message || (ok ? '已完成。' : '操作失败。');
      btnCancel.style.display = 'none';
      btnConfirm.style.display = '';
      btnConfirm.disabled = false;
      btnConfirm.textContent = ok ? '完成' : '关闭';
      btnConfirm.style.minWidth = '88px';
      btnConfirm.addEventListener('click', onDone);
    };

    const flowState = {
      platform,
      setProgress: (message) => {
        if (message) setMessage(message);
      },
    };

    const cleanup = () => {
      modal.classList.remove('active');
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      btnConfirm.removeEventListener('click', onDone);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      if (_switchFlowState === flowState) _switchFlowState = null;
      flowEl.remove();
      titleEl.textContent = prev.title;
      leadEl.textContent = prev.lead;
      leadEl.style.display = prev.leadDisplay;
      leadEl.style.whiteSpace = prev.leadWhiteSpace;
      if (questionEl) {
        questionEl.textContent = prev.question;
        questionEl.style.display = prev.questionDisplay;
      }
      if (warningEl) warningEl.style.display = prev.warningDisplay;
      btnCancel.textContent = prev.cancelText;
      btnCancel.style.display = prev.cancelDisplay;
      btnCancel.disabled = prev.cancelDisabled;
      btnConfirm.textContent = prev.confirmText;
      btnConfirm.style.display = prev.confirmDisplay;
      btnConfirm.disabled = prev.confirmDisabled;
      btnConfirm.style.width = prev.confirmWidth;
      btnConfirm.style.minWidth = prev.confirmMinWidth;
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const start = async () => {
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      // skipConfirm 时 modal 可能还没 add active（确认态没显示）
      if (!modal.classList.contains('active')) modal.classList.add('active');
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      btnCancel.style.display = 'none';
      btnConfirm.style.display = 'none';
      btnCancel.disabled = true;
      btnConfirm.disabled = true;
      _switchFlowState = flowState;
      renderProgress(runningMessage);

      try {
        const result = await task({ setMessage });
        flowResult = { confirmed: true, ok: true, result };
        renderResult(true, result?.message || '已完成。');
      } catch (e) {
        flowResult = { confirmed: true, ok: false, error: e };
        renderResult(false, switchFlowErrorText(e));
      } finally {
        if (_switchFlowState === flowState) _switchFlowState = null;
      }
    };

    function onConfirm(e) {
      e.preventDefault();
      e.stopPropagation();
      start();
    }
    function onCancel(e) {
      e.preventDefault();
      e.stopPropagation();
      finish({ confirmed: false });
    }
    function onDone(e) {
      e.preventDefault();
      e.stopPropagation();
      finish(flowResult);
    }
    function onOverlay(e) {
      if (e.target === modal) finish({ confirmed: false });
    }
    function onEsc(e) {
      if (e.key === 'Escape' && modal.classList.contains('active')) finish({ confirmed: false });
    }

    titleEl.textContent = title;
    leadEl.textContent = lead;
    leadEl.style.display = '';
    leadEl.style.whiteSpace = 'pre-line';
    if (questionEl) {
      questionEl.textContent = '';
      questionEl.style.display = 'none';
    }
    if (warningEl) warningEl.style.display = 'none';
    btnCancel.style.display = '';
    btnCancel.disabled = false;
    btnCancel.textContent = '取消';
    btnConfirm.style.display = '';
    btnConfirm.disabled = false;
    btnConfirm.textContent = confirmText;
    btnConfirm.style.width = '';
    if (skipConfirm) {
      // 跳过确认态，直接进进度态（用户已在卡片上看到信息，无需再确认）
      start();
    } else {
      modal.classList.add('active');
    }

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}

function showSwitchProgress(platformId, initialMessage) {
  _switchProgressPlatform = platformId;
  let toast = document.getElementById('switch-progress-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'switch-progress-toast';
    toast.className = 'switch-progress-toast';
    toast.innerHTML = `
      <div class="switch-progress-spinner"></div>
      <div class="switch-progress-content">
        <div class="switch-progress-title">正在切换配置…</div>
        <div class="switch-progress-message"></div>
      </div>
    `;
    document.body.appendChild(toast);
  }
  const msgEl = toast.querySelector('.switch-progress-message');
  if (msgEl) msgEl.textContent = initialMessage || '正在处理…';
  toast.classList.add('show');
}

function updateSwitchProgress(payload) {
  if (!payload || !payload.platform) return;
  if (_switchFlowState && payload.platform === _switchFlowState.platform) {
    _switchFlowState.setProgress(payload.message || '正在处理…');
  }
  if (_switchProgressPlatform && payload.platform !== _switchProgressPlatform) return;
  const toast = document.getElementById('switch-progress-toast');
  if (!toast) return;
  const msgEl = toast.querySelector('.switch-progress-message');
  if (msgEl) msgEl.textContent = payload.message || '正在处理…';
  // toast 左侧已有 switch-progress-spinner，标题再插 loadingHtml 会变成两个圈；
  // 标题只负责收尾切文案，动态指示交给那唯一的 spinner。
  const titleEl = toast.querySelector('.switch-progress-title');
  if (titleEl && payload.step === 'done') {
    titleEl.textContent = '完成';
  }
}

function hideSwitchProgress() {
  const toast = document.getElementById('switch-progress-toast');
  if (toast) {
    toast.classList.remove('show');
    setTimeout(() => { toast.remove(); }, 300);
  }
  _switchProgressPlatform = null;
}

async function bindSwitchProgressListener() {
  if (!tauriEvent?.listen || _switchProgressUnlisten) return;
  _switchProgressUnlisten = await tauriEvent.listen('platform-switch-progress', (event) => {
    updateSwitchProgress(event.payload || {});
  });
}

async function applyPlatform(platformId) {
  // Codex 主 UI 走卡片 applyCodexProviderConfig；这里兜底避免通用入口只写配置不重启。
  // platform-codex-select 可能不存在（卡片 UI），依次回退：store 当前 → select → 首个配置。
  if (platformId === 'codex') {
    const storeId = String(providerStore?.platforms?.codex?.providerId || '').trim();
    const select = document.getElementById('platform-codex-select');
    const selectId = select ? String(select.value || '').trim() : '';
    const firstId = (platformProviderList('codex')[0] || {}).id || '';
    const providerId = storeId || selectId || firstId;
    if (!providerId) {
      showCustomAlert('请先添加一份 Codex 配置。', '无法切换', 'warn');
      return;
    }
    return applyCodexProviderConfig(providerId);
  }

  const def = platformDef(platformId);
  const select = document.getElementById(`platform-${platformId}-select`);
  const providerId = select ? select.value : '';
  if (!providerId) {
    showCustomAlert('请选择一个可用供应商。', '无法切换', 'warn');
    return;
  }

  const provider = platformProviderList(platformId).find(p => p.id === providerId);
  if (!provider) {
    showCustomAlert('供应商不存在或尚未加载。', '无法切换', 'error');
    return;
  }
  const confirmMessage = `将把「${provider.name}」写入 ${def.name} 配置文件，并在首次接管前创建 .byok-bak 备份。`;
  const ok = await showCustomConfirm(confirmMessage, '确认切换', 'warn');
  if (!ok) return;

  setPlatformBusy(platformId, true);
  showSwitchProgress(platformId, '正在准备切换…');
  try {
    const result = await invoke('switch_platform', { platform: platformId, providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || `${def.name} 已切换`);
    showCustomAlert(result.message || `${def.name} 已切换。`, '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${def.name} 切换失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy(platformId, false);
    if (platformId === 'opencode') renderPlatformDetailStatuses();
    else onPlatformProviderChange(platformId);
  }
}

function codexApplyConfirmMessage(provider) {
  const info = platformInfoOf('codex') || {};
  const from = info.currentProviderName || info.currentProviderId || '当前配置';
  const to = provider.name || provider.id || '目标配置';
  const model = provider.defaultModel || '默认模型';
  // 与 applyCodexProviderConfig / watcher 一致：preserveOfficialAuth 优先禁止 CDP 注入。
  const preserveAuth = codexProviderPreservesOfficialAuth(provider);
  const needsInject = codexProviderNeedsInject(provider);
  const hint = codexDesktopAutomationSupported()
    ? (preserveAuth
      ? '重启后使用官方登录'
      : needsInject
        ? '重启后可选第三方模型'
        : '重启后生效')
    : '请手动重启 Codex 生效';
  const historyHint = provider.unifySessionHistory === false ? '' : '，历史会话保持可见';
  return `将把 Codex 从「${from}」切换到「${to}」。\n\n默认模型：${model}\n${hint}${historyHint}。`;
}

async function repairCodexSessionVisibility() {
  const info = platformInfoOf('codex') || {};
  const providerId = (info.codexConfig && info.codexConfig.modelProviderId)
    || info.currentProviderId
    || 'openai';
  const ok = await showCustomConfirm(
    `把历史会话对齐到「${providerId}」，在侧边栏重新可见。\n\n请先完全退出 Codex。`,
    '修复会话历史',
    'info'
  );
  if (!ok) return;

  setPlatformBusy('codex', true);
  showSwitchProgress('codex', '正在修复会话历史…');
  try {
    const summary = await invoke('repair_codex_session_visibility');
    const msg = summary && summary.message
      ? `${summary.message}（更新 ${summary.updatedSqliteRowCount || 0} 条）`
      : '历史会话已修复';
    if (typeof addLog === 'function') addLog('ok', msg);
    showCustomAlert(msg, '修复完成', 'success');
    await refreshPlatforms({ silent: true });
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `修复会话历史失败: ${e}`);
    showCustomAlert(String(e), '修复失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('codex', false);
    renderPlatformDetailStatuses();
  }
}

async function restoreCodexOfficialConfig() {
  const info = platformInfoOf('codex') || {};
  const alreadyOfficial = !!(info.codexConfig && info.codexConfig.isOfficial);
  const autoRestartHint = codexDesktopAutomationSupported()
    ? '重启后使用官方登录。'
    : '请手动重启 Codex。';
  const message = alreadyOfficial
    ? '当前已是官方配置，仍要清理吗？'
    : `将把 Codex 切回官方默认配置。\n\n${autoRestartHint}`;
  const flow = await runSwitchFlow({
    title: '切回官方配置',
    lead: message,
    confirmText: '确认切回',
    platform: 'codex',
    runningMessage: '正在准备切回官方配置…',
    successTitle: '切换完成',
    failureTitle: '切回官方失败',
    skipConfirm: false,
    task: async ({ setMessage }) => {
      setPlatformBusy('codex', true);
      try {
        setMessage('正在写入 Codex 官方配置…');
        const result = assertSwitchResultOk(
          await invoke('restore_codex_official_config'),
          'Codex 官方配置还原失败'
        );

        let restart = null;
        if (codexDesktopAutomationSupported()) {
          setMessage('正在重启 Codex…');
          restart = assertSwitchResultOk(
            await invoke('restart_codex_desktop', { managed: false, model: null }),
            'Codex 重启失败'
          );
        } else {
          setMessage('已跳过自动重启（仅支持 Windows）。');
        }

        if (typeof addLog === 'function') {
          addLog('ok', result.message || 'Codex 已切回官方配置');
          if (restart) addLog('ok', restart.message || 'Codex 桌面版已按官方模式重启');
          else addLog('warn', codexDesktopUnsupportedMessage());
        }
        setMessage('正在刷新 Codex 状态…');
        await refreshPlatforms({ silent: true, reloadProviders: false });
        return {
          message: `${result.message || 'Codex 已切回官方配置。'}\n\n${restart ? (restart.message || 'Codex 已重启。') : codexDesktopUnsupportedMessage()}`
        };
      } finally {
        setPlatformBusy('codex', false);
        renderPlatformDetailStatuses();
      }
    }
  });
  if (flow.confirmed && !flow.ok && typeof addLog === 'function') {
    addLog('err', switchFlowErrorLog(flow.error, 'Codex 切回官方失败: '));
  }
}

async function restorePlatform(platformId) {
  const def = platformDef(platformId);
  const ok = await showCustomConfirm(
    `将从 .byok-bak 还原 ${def.name} 配置，并清除 AnyBridge 的接管记录。`,
    '确认还原',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy(platformId, true);
  showSwitchProgress(platformId, '正在准备还原配置…');
  try {
    const restored = await invoke('restore_platform', { platform: platformId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    const msg = restored ? `${def.name} 已从备份还原。` : `${def.name} 没有可还原的 AnyBridge 备份。`;
    if (typeof addLog === 'function') addLog(restored ? 'ok' : 'warn', msg);
    showCustomAlert(msg, restored ? '还原完成' : '没有备份', restored ? 'success' : 'info');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${def.name} 还原失败: ${e}`);
    showCustomAlert(String(e), '还原失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy(platformId, false);
    if (platformId === 'codex' || platformId === 'opencode' || platformId === 'grok') renderPlatformDetailStatuses();
    else {
      const managedPrefix = Object.keys(MANAGED_MODEL_PLATFORM_IDS).find(
        (prefix) => MANAGED_MODEL_PLATFORM_IDS[prefix] === platformId,
      );
      if (managedPrefix) globalThis[`load${managedPrefix}Models`]();
      else onPlatformProviderChange(platformId);
    }
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.rawMessageText = rawMessageText;
  g.messageHeadline = messageHeadline;
  g.messageDetail = messageDetail;
  g.switchFlowErrorText = switchFlowErrorText;
  g.switchFlowErrorLog = switchFlowErrorLog;
  g.assertSwitchResultOk = assertSwitchResultOk;
  g.runSwitchFlow = runSwitchFlow;
  g.showSwitchProgress = showSwitchProgress;
  g.updateSwitchProgress = updateSwitchProgress;
  g.hideSwitchProgress = hideSwitchProgress;
  g.bindSwitchProgressListener = bindSwitchProgressListener;
  g.applyPlatform = applyPlatform;
  g.codexApplyConfirmMessage = codexApplyConfirmMessage;
  g.repairCodexSessionVisibility = repairCodexSessionVisibility;
  g.restoreCodexOfficialConfig = restoreCodexOfficialConfig;
  g.restorePlatform = restorePlatform;
})(globalThis);
