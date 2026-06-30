// ═══════ PROXY TOGGLE ═══════
let proxyRunning = false;
let activeProxyTarget = '';
let ideProxyStatusByTarget = {};
let localProxyKey = '';
let localProxyPort = 7450;
let localProxyInferencePort = 7451;
const IDE_RESTART_AFTER_SWITCH_KEY = 'anybridge.ideRestartAfterSwitch';

function shouldAutoRestartIdeAfterSwitch() {
  try {
    return localStorage.getItem(IDE_RESTART_AFTER_SWITCH_KEY) === 'auto';
  } catch (_) {
    return false;
  }
}

function setAutoRestartIdeAfterSwitch(enabled) {
  try {
    if (enabled) localStorage.setItem(IDE_RESTART_AFTER_SWITCH_KEY, 'auto');
    else localStorage.removeItem(IDE_RESTART_AFTER_SWITCH_KEY);
  } catch (e) {
    addLog('err', '保存 IDE 重启偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
    return false;
  }
  syncIdeRestartPromptSetting();
  return true;
}

function resetIdeRestartPromptPreference() {
  const saved = setAutoRestartIdeAfterSwitch(false);
  if (!saved) return;
  if (typeof showBottomToast === 'function') {
    showBottomToast('已恢复为每次询问是否重启 IDE', 'success');
  }
}

function syncIdeRestartPromptSetting() {
  const auto = shouldAutoRestartIdeAfterSwitch();
  setText('ideRestartPromptMode', auto ? '自动立即重启' : '每次询问');
  forEachElementAlias('ideRestartPromptResetBtn', btn => {
    btn.disabled = !auto;
  });
}


function normalizeIdeProxyTargetValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'devin') return 'devin';
  if (raw === 'windsurf') return 'windsurf';
  if (raw === 'cursor') return 'cursor';
  if (typeof normalizeProxyPlatform === 'function') return normalizeProxyPlatform(raw);
  return 'windsurf';
}

async function resolveIdeProxyTarget(useDetect = false) {
  const selected = typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf';
  if (selected === 'auto' && useDetect && invoke) {
    try {
      const detected = await invoke('detect_target_ide');
      return normalizeIdeProxyTargetValue(detected);
    } catch (e) {
      addLog('warn', '自动检测 IDE 失败，使用 Windsurf: ' + e);
    }
  }
  return normalizeIdeProxyTargetValue(selected);
}

function getLocalProxyPort() {
  return Number(localProxyPort) || 7450;
}

function getLocalProxyInferencePort() {
  return Number(localProxyInferencePort) || 7451;
}

function getLocalProxyKeyValue() {
  return localProxyKey || '';
}

function getLocalProxyDefaultModel(format = 'openai') {
  try {
    if (typeof getProxyRouteDefaultModel === 'function') {
      const routeDefault = getProxyRouteDefaultModel(format);
      if (routeDefault) return routeDefault;
    }
    return '';
  } catch (_) {
    return '';
  }
}

function getLocalProxyModels(format = 'openai') {
  try {
    if (typeof getEnabledProxyRouteModels === 'function') {
      const routeModels = getEnabledProxyRouteModels(format);
      if (routeModels.length) return routeModels;
    }
  } catch (_) {}
  return [getLocalProxyDefaultModel(format)].filter(Boolean);
}

function localProxyOrigin() {
  return `http://127.0.0.1:${getLocalProxyPort()}`;
}

function localProxyBaseUrl(format = 'openai') {
  return format === 'anthropic' ? `${localProxyOrigin()}/anthropic` : `${localProxyOrigin()}/v1`;
}

function localProxyModelsUrl() {
  return `${localProxyBaseUrl('openai')}/models`;
}

function localProxyEndpointParts(format = 'openai') {
  const url = new URL(localProxyBaseUrl(format));
  return { apiHost: url.origin, apiPath: url.pathname };
}

function getLocalProxyRuntimeConfig(platformId = 'codex') {
  const format = platformId === 'claude-code' ? 'anthropic' : 'openai';
  const endpoint = localProxyEndpointParts(format);
  const models = getLocalProxyModels(format);
  const model = getLocalProxyDefaultModel(format) || models[0];
  return {
    id: `anybridge-local-proxy-${platformId}`,
    name: 'AnyBridge 本地代理',
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath,
    apiKey: getLocalProxyKeyValue(),
    defaultModel: model,
    models,
    sourceProviderId: 'local-proxy',
    sourceProviderName: 'AnyBridge',
    localProxy: true,
    apiFormat: format,
    endpoint: localProxyBaseUrl(format),
  };
}

function generateLocalProxyKeyValue() {
  const bytes = new Uint8Array(18);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'abk-local-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function syncProxyEnhancementSummary() {
  try {
    if (typeof modelMapStore === 'undefined') return;
    const enhancement = modelMapStore.enhancement || {};
    setText('proxyEnhancementRetryState', `重试：${enhancement.retry === false ? '关闭' : '开启'}`);
    setText('proxyEnhancementImageState', `图片理解：${enhancement.imageFallback === false ? '关闭' : '开启'}`);
    setText('proxyEnhancementVisionCount', `图片模型：${modelMapStore.visionModels?.imageModels?.length || 0}`);
  } catch (_) {}
}

function syncLocalProxyUi() {
  setText('globalProxyStatusText', proxyRunning ? '代理运行中' : '代理未启动');
  setText('localProxyOpenAiUrl', localProxyBaseUrl('openai'));
  setText('localProxyClaudeUrl', localProxyBaseUrl('anthropic'));
  setText('localProxyModelsUrl', localProxyModelsUrl());
  setText('localProxyKeyValue', localProxyKey || '未生成');
  ['localProxyPortInput', 'settingsProxyPortInput'].forEach(id => {
    forEachElementAlias(id, input => {
      input.value = String(getLocalProxyPort());
    });
  });
  ['localProxyInferencePortInput', 'settingsInferencePortInput'].forEach(id => {
    forEachElementAlias(id, input => {
      input.value = String(getLocalProxyInferencePort());
    });
  });
  forEachElementAlias('route-mitm', el => {
    el.value = `:${getLocalProxyPort()}`;
  });
  forEachElementAlias('route-direct', el => {
    el.value = `:${getLocalProxyInferencePort()}`;
  });
  setText('route-port-desc', `MITM 代理 :${getLocalProxyPort()} / 直连代理 :${getLocalProxyInferencePort()}`);
  syncProxyEnhancementSummary();
}

function updateGlobalProxyStatusPill(running, tone = '') {
  const pill = document.getElementById('globalProxyStatusPill');
  if (!pill) return;
  pill.classList.remove('running', 'starting', 'error', 'off');
  pill.classList.add(tone || (running ? 'running' : 'off'));
}

function updateProxyPageState(running, tone = '') {
  const state = document.getElementById('proxyConsoleState');
  const textEl = document.getElementById('proxyPageStateText');
  const subEl = document.getElementById('proxyPageStateSub');
  if (state) {
    state.classList.remove('running', 'starting', 'error');
    if (tone) state.classList.add(tone);
    else if (running) state.classList.add('running');
  }
  if (textEl) textEl.textContent = running ? '代理运行中' : '代理未启动';
  if (subEl) subEl.textContent = running ? '本地入口已启动' : '本地入口等待启动';
}

function syncIdeProxyButton() {
  const btn = document.getElementById('proxyBtn');
  if (!btn) return;
  const restoreBtn = document.getElementById('proxyRestoreBtn');
  const target = normalizeIdeProxyTargetValue(typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf');
  const status = ideProxyStatusByTarget[target] || {};
  const patched = !!status.patched;
  const icon = btn.querySelector('.proxy-btn-icon');
  const text = btn.querySelector('.proxy-btn-text');
  const stateText = btn.querySelector('[data-proxy-state-text]');
  const label = ideDisplayLabel(target);
  btn.classList.remove('running', 'warning', 'is-connected');
  if (restoreBtn) {
    restoreBtn.textContent = '停止接入';
    restoreBtn.classList.toggle('is-danger', patched);
    restoreBtn.disabled = !patched;
    restoreBtn.setAttribute('aria-label', patched ? `停止 ${label} 接入 AnyBridge` : `${label} 当前未接入`);
  }
  if (patched) {
    btn.classList.add('is-connected');
    if (icon) {
      icon.innerHTML = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    if (text) text.textContent = '已接入';
    if (stateText) stateText.textContent = proxyRunning ? '代理运行中' : '代理未运行';
    btn.setAttribute('aria-label', `${label} 已接入 AnyBridge`);
    return;
  }
  if (icon) {
    icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"/>';
  }
  if (text) text.textContent = '一键接入';
  if (stateText) stateText.textContent = '未接入';
  btn.setAttribute('aria-label', `${label} 一键接入 AnyBridge`);
}

async function refreshIdeProxyStatus(targetOverride = '') {
  if (!invoke) return null;
  const target = normalizeIdeProxyTargetValue(targetOverride || (typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf'));
  try {
    const status = await invoke('get_ide_proxy_status', { target });
    ideProxyStatusByTarget[target] = status || { target, patched: false };
    syncIdeProxyButton();
    return ideProxyStatusByTarget[target];
  } catch (e) {
    addLog('warn', `${ideDisplayLabel(target)} 代理切换状态读取失败: ${e}`);
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
      addLog('err', '生成本地代理 key 后保存失败: ' + e);
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(String(e), '本地代理 key 保存失败', 'error');
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
    addLog('err', '保存本地代理配置失败: ' + e);
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
    : { api: 'localProxyPortInput' };
}

async function saveLocalProxyPorts(source = 'proxy') {
  if (!invoke && !bindTauriBridge()) return;
  const ids = proxyPortInputIds(source);
  const apiInput = document.getElementById(ids.api);
  const inferenceInput = ids.inference ? document.getElementById(ids.inference) : null;
  try {
    const nextApiPort = parseProxyPortInputValue(apiInput?.value || getLocalProxyPort(), 'API 服务端口');
    if (nextApiPort === getLocalProxyInferencePort()) {
      throw new Error('API 服务端口和推理服务端口不能相同');
    }
    const nextInferencePort = inferenceInput
      ? parseProxyPortInputValue(inferenceInput.value || getLocalProxyInferencePort(), '推理服务端口')
      : getLocalProxyInferencePort();
    const changed = nextApiPort !== getLocalProxyPort() || nextInferencePort !== getLocalProxyInferencePort();
    if (proxyRunning && changed) {
      const ok = await showCustomConfirm(
        '修改端口需要重启全局代理服务。保存后会立即重启代理，已经写入外部工具的本地代理地址需要重新应用或复制。',
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
      showCustomAlert('本地代理端口保存失败，已恢复原端口。', '保存失败', 'error');
      return;
    }
    syncLocalProxyUi();
    if (typeof renderPlatformDetailStatuses === 'function') renderPlatformDetailStatuses();
    addLog('ok', `本地代理端口已保存: ${nextApiPort} / ${nextInferencePort}`);
    if (proxyRunning && changed) {
      await restartGlobalProxyService();
    } else {
      showCustomAlert('本地代理端口已保存。', '保存完成', 'success');
    }
  } catch (e) {
    syncLocalProxyUi();
    addLog('err', '保存本地代理端口失败: ' + e);
    showCustomAlert(String(e.message || e), '保存失败', 'error');
  }
}
async function copyTextToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    addLog('ok', `已复制${label || ''}`);
  } catch (e) {
    addLog('err', `复制失败: ${e}`);
  }
}

async function copyLocalProxyValue(kind) {
  const value = kind === 'key'
    ? getLocalProxyKeyValue()
    : kind === 'claude'
      ? localProxyBaseUrl('anthropic')
      : kind === 'models'
        ? localProxyModelsUrl()
        : localProxyBaseUrl('openai');
  if (!value) {
    addLog('warn', '本地代理 key 尚未生成');
    return;
  }
  await copyTextToClipboard(value, kind === 'key' ? '本地 key' : '本地代理地址');
}

async function regenerateLocalProxyKey() {
  const ok = await showCustomConfirm('重新生成后，已经写入外部工具的本地代理 key 需要重新应用。', '重新生成本地 key', 'warn');
  if (!ok) return;
  const previousKey = localProxyKey;
  localProxyKey = generateLocalProxyKeyValue();
  const saved = await persistLocalProxyConfig();
  if (!saved) {
    localProxyKey = previousKey;
    syncLocalProxyUi();
    showCustomAlert('本地代理 key 保存失败，已恢复原 key。', '保存失败', 'error');
    return;
  }
  syncLocalProxyUi();
  if (typeof renderPlatformDetailStatuses === 'function') renderPlatformDetailStatuses();
  addLog('ok', '本地代理 key 已重新生成');
}
// 防连点:记录进行中的 toggle key,同一目标的并发操作会被忽略,避免后写覆盖先写。
const _inFlightToggles = new Set();

function ideDisplayLabel(ide) {
  const labels = { windsurf: 'Windsurf', devin: 'Devin', cursor: 'Cursor', auto: '自动检测' };
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
    ? (proxyRunning ? `已切到代理 · ${ideLabel} · ${getLocalProxyPort()}` : `已切到代理，代理未运行 · ${ideLabel}`)
    : `未切到代理 · ${ideLabel} · ${getLocalProxyPort()}`;
  [sub, ...platformSubs].filter(Boolean).forEach(el => { el.textContent = subText; });
  updateGlobalProxyStatusPill(proxyRunning);
  updateProxyPageState(proxyRunning);
  syncLocalProxyUi();
  syncIdeProxyButton();
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

function promptInstallCertificateBeforeProxy() {
  const message = '切换到代理前需要安装本地证书，IDE 才能信任本机代理。';
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
      resolve(confirm(message + '\n\n是否现在安装证书并继续切换到代理？'));
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
    if (questionEl) questionEl.textContent = '点击「安装证书并继续」后，应用会自动安装证书，安装成功就继续切换到代理。';
    if (warningEl) warningEl.style.display = '';
    if (warningTextEl) {
      warningTextEl.innerHTML = '如果系统弹出授权窗口，请选择<strong>是</strong>。这是本机代理证书，只用于让 IDE 信任当前电脑上的代理。';
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
  ['proxyBtn', 'proxyRefreshBtn', 'proxyRestoreBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!busy;
  });
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
      addLog('err', 'Tauri 通道未就绪，代理切换不可用。请重启应用后重试。');
      return;
    }

    const target = await resolveIdeProxyTarget(true);
    const label = ideDisplayLabel(target);
    const status = await refreshIdeProxyStatus(target);
    const patched = !!status?.patched;

    if (mode === 'proxy' && patched) {
      if (!proxyRunning) {
        setProxyPlatformActionBusy(true);
        setProxyButtonBusyText('启动代理...');
        setGlobalProxyBusy(true, '代理启动中');
        try {
          await invoke('start_proxy_service');
          addLog('ok', '全局代理服务已自动启动');
        } catch (e) {
          if (String(e).includes('代理已在运行')) {
            addLog('warn', '代理服务已在运行，已刷新状态');
          } else {
            updateGlobalProxyStatusPill(false, 'error');
            updateProxyPageState(false, 'error');
            throw new Error('自动启动全局代理服务失败: ' + e);
          }
        } finally {
          setGlobalProxyBusy(false);
        }
        await refreshStatus();
      }
      addLog('info', `${label} 已接入 AnyBridge`);
      if (typeof showBottomToast === 'function') showBottomToast(`${label} 已接入 AnyBridge`, 'info');
      return;
    }

    if (mode === 'direct' && !patched) {
      addLog('info', `${label} 当前未接入代理，无需还原`);
      if (typeof showBottomToast === 'function') showBottomToast(`${label} 当前未接入代理`, 'info');
      return;
    }

    setProxyPlatformActionBusy(true);
    setProxyButtonBusyText(mode === 'direct' || patched ? '停止中...' : '接入中...');

    if (mode === 'direct' || (mode === 'toggle' && patched)) {
      const ok = await showCustomConfirm(`将停止 ${label} 接入 AnyBridge，并恢复为直连配置。`, '停止接入', 'warn');
      if (!ok) return;
      const report = await invoke('restore_ide_direct', { target });
      const warnings = [];
      if (report && report.ideConfig && !String(report.ideConfig).startsWith('ok')) warnings.push('IDE 配置: ' + report.ideConfig);
      if (report && report.workbenchInject && !String(report.workbenchInject).startsWith('ok')) warnings.push('卡片注入: ' + report.workbenchInject);
      if (report && report.cursorAuth && !String(report.cursorAuth).startsWith('ok')) warnings.push('Cursor 状态: ' + report.cursorAuth);
      await refreshIdeProxyStatus(target);
      setStatusPill(proxyRunning);
      if (warnings.length) {
        addLog('warn', `${label} 停止接入完成，但有提示: ${warnings.join('；')}`);
        showCustomAlert(warnings.join('\n'), '停止接入提示', 'warn');
      } else {
        addLog('ok', `${label} 已停止接入`);
        await promptRestartIde(`${label} 已停止接入并恢复直连，重启 IDE 后生效。`, target, { mode: 'direct' });
      }
      return;
    }

    if (!proxyRunning) {
      setProxyButtonBusyText('启动代理...');
      setGlobalProxyBusy(true, '代理启动中');
      try {
        await invoke('start_proxy_service');
        addLog('ok', '全局代理服务已自动启动');
      } catch (e) {
        if (String(e).includes('代理已在运行')) {
          addLog('warn', '代理服务已在运行，已刷新状态后继续切换');
        } else {
          updateGlobalProxyStatusPill(false, 'error');
          updateProxyPageState(false, 'error');
          throw new Error('自动启动全局代理服务失败: ' + e);
        }
      } finally {
        setGlobalProxyBusy(false);
      }
      await refreshStatus();
    }

    setProxyButtonBusyText('接入中...');
    const report = await invoke('switch_ide_to_proxy', { target });
    await refreshIdeProxyStatus(target);
    setStatusPill(proxyRunning);
    const injectWarn = report && report.workbenchInject && String(report.workbenchInject).startsWith('warn:')
      ? report.workbenchInject.replace(/^warn:\s*/, '')
      : '';
    const cursorState = report && report.cursorAuth && String(report.cursorAuth).startsWith('ok')
      ? report.cursorAuth
      : '';
    addLog('ok', `${label} 已切换到 AnyBridge 本地代理`);
    if (injectWarn) addLog('warn', `${label} 卡片注入提示: ${injectWarn}`);
    if (cursorState && target === 'cursor') addLog('ok', `Cursor 状态已写入: ${cursorState}`);
    await promptRestartIde(`${label} 已切到代理，本地代理已启动，重启 IDE 后生效。`, target, {
      mode: 'proxy',
      detail: injectWarn
    });
  } catch (e) {
    addLog('err', '平台代理切换失败: ' + e);
    showCustomAlert(String(e), '切换失败', 'error');
    setStatusPill(proxyRunning);
  } finally {
    setProxyPlatformActionBusy(false);
    _toggling = false;
    syncIdeProxyButton();
  }
}

function setGlobalProxyBusy(busy, label = '') {
  ['globalProxyStartBtn', 'globalProxyStopBtn', 'globalProxyRestartBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!busy;
  });
  if (busy) {
    updateGlobalProxyStatusPill(false, 'starting');
    updateProxyPageState(false, 'starting');
    if (label) setText('proxyPageStateText', label);
  }
}

async function startGlobalProxyService() {
  if (!invoke && !bindTauriBridge()) return;
  setGlobalProxyBusy(true, '代理启动中');
  try {
    await invoke('start_proxy_service');
    await refreshStatus();
    addLog('ok', '全局代理服务已启动');
  } catch (e) {
    updateGlobalProxyStatusPill(false, 'error');
    updateProxyPageState(false, 'error');
    addLog('err', '启动全局代理服务失败: ' + e);
    showCustomAlert(String(e), '启动失败', 'error');
  } finally {
    setGlobalProxyBusy(false);
  }
}

async function stopGlobalProxyService() {
  if (!invoke && !bindTauriBridge()) return;
  setGlobalProxyBusy(true, '代理停止中');
  try {
    await invoke('stop_proxy_service');
    setStatusPill(false);
    addLog('ok', '全局代理服务已停止');
  } catch (e) {
    if (String(e).includes('代理未运行')) setStatusPill(false);
    else {
      addLog('err', '停止全局代理服务失败: ' + e);
      showCustomAlert(String(e), '停止失败', 'error');
    }
  } finally {
    setGlobalProxyBusy(false);
  }
}

async function restartGlobalProxyService() {
  if (!invoke && !bindTauriBridge()) return;
  setGlobalProxyBusy(true, '代理重启中');
  try {
    await invoke('restart_proxy_service');
    await refreshStatus();
    addLog('ok', '全局代理服务已重启');
  } catch (e) {
    updateGlobalProxyStatusPill(false, 'error');
    updateProxyPageState(false, 'error');
    addLog('err', '重启全局代理服务失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
  } finally {
    setGlobalProxyBusy(false);
  }
}
let _statusFailStreak = 0;
let _refreshStatusInFlight = false;
async function refreshStatus() {
  if (!invoke) return;
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
    if (_statusFailStreak === 5) addLog('warn', '无法获取代理状态(已连续失败5次): ' + e);
  } finally {
    _refreshStatusInFlight = false;
  }
}
async function restartIdeNow(target) {
  try {
    const result = await invoke('restart_ide', { target });
    addLog('ok', result);
    return true;
  } catch (e) {
    addLog('err', '重启 IDE 失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
    return false;
  }
}

// 代理/直连切换后，提示并询问是否一键重启 IDE 使其生效。
function promptRestartIde(leadText, targetOverride, options = {}) {
  if (!invoke) return Promise.resolve(false);
  const target = targetOverride || activeProxyTarget || getTargetIde();
  const label = ideDisplayLabel(target);
  const mode = options.mode === 'direct' ? 'direct' : 'proxy';
  const lead = leadText || `${label} 代理状态已变更，需重启 IDE 才能生效。`;
  const detail = String(options.detail || '').trim();

  if (shouldAutoRestartIdeAfterSwitch()) {
    addLog('info', `按偏好自动重启 ${label}`);
    return restartIdeNow(target);
  }

  return new Promise((resolve) => {
    const modal = document.getElementById('ide-restart-modal');
    const titleEl = document.getElementById('ide-restart-title');
    const leadEl = document.getElementById('ide-restart-lead');
    const statusEl = document.getElementById('ide-restart-status');
    const detailEl = document.getElementById('ide-restart-detail');
    const autoInput = document.getElementById('ide-restart-auto-checkbox');
    const btnLater = document.getElementById('ide-restart-later-btn');
    const btnNow = document.getElementById('ide-restart-now-btn');

    if (!modal || !btnLater || !btnNow) {
      showCustomConfirm(lead + '\n\n重启会强制关闭 IDE，请先保存所有未保存的工作。', '需要重启 IDE', 'warn')
        .then(async ok => resolve(ok ? await restartIdeNow(target) : false));
      return;
    }

    if (titleEl) titleEl.textContent = `重启 ${label} 以应用${mode === 'direct' ? '直连' : '代理'}`;
    if (leadEl) leadEl.textContent = lead;
    if (statusEl) {
      statusEl.textContent = mode === 'direct'
        ? '已恢复直连配置，重启后 IDE 不再经过 AnyBridge。'
        : '已写入 AnyBridge 代理配置，本地代理服务已启动。';
    }
    if (detailEl) {
      detailEl.textContent = detail ? `提示：${detail}` : '';
      detailEl.style.display = detail ? '' : 'none';
    }
    if (autoInput) autoInput.checked = false;
    btnLater.disabled = false;
    btnNow.disabled = false;
    btnNow.textContent = '立即重启';

    modal.classList.add('active');

    const cleanup = (result) => {
      modal.classList.remove('active');
      btnLater.removeEventListener('click', onLater);
      btnNow.removeEventListener('click', onNow);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      resolve(result);
    };

    const onLater = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(false);
    };
    const onNow = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rememberAuto = !!autoInput?.checked;
      btnLater.disabled = true;
      btnNow.disabled = true;
      btnNow.textContent = '重启中...';
      const restarted = await restartIdeNow(target);
      if (restarted && rememberAuto) setAutoRestartIdeAfterSwitch(true);
      cleanup(restarted);
    };
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onEsc = (e) => { if (e.key === 'Escape' && modal.classList.contains('active')) cleanup(false); };

    btnLater.addEventListener('click', onLater);
    btnNow.addEventListener('click', onNow);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}


function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function forEachElementAlias(id, cb) {
  const seen = new Set();
  const direct = document.getElementById(id);
  if (direct) {
    seen.add(direct);
    cb(direct);
  }
  document.querySelectorAll(`[data-oid="${id}"]`).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    cb(el);
  });
}

function setText(id, v) {
  forEachElementAlias(id, el => {
    el.textContent = v;
  });
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  el.style.width = safe + '%';
}

function pctOf(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return (value / total) * 100;
}

function resetStatsUi() {
  setText('stat-requests', '—');
  setText('stat-requests-sub', '代理未运行');
  setText('stat-tokens', '—');
  setText('stat-tokens-sub', '输入 / 输出 / 缓存');
  setText('stat-success-rate', '—');
  setText('stat-errors-sub', '等待请求');
  setText('stat-provider', '—');
  setText('stat-model', '尚无请求');
  setText('stat-rpm', '—');
  setText('stat-tpm', '—');
  setText('stat-latency', '—');
  setText('stat-retries', '—');
  setText('stat-retries-sub', '本日累计');
  setText('stat-error-rate', '—');
  setText('stat-window-errors', '最近窗口');
  setText('stat-window-requests', '0');
  setText('stat-window-tokens', '0');
  setText('stat-window-errors-count', '0');
  setText('stat-cost', '—');
  setText('proxy-page-requests', '—');
  setText('proxy-page-tokens', '—');
  setText('proxy-page-success-rate', '—');
  setText('proxy-page-latency', '—');
  setText('stat-health-pill', '等待流量');
  setText('stat-input-tokens', '—');
  setText('stat-output-tokens', '—');
  setText('stat-cached-tokens', '—');
  setText('stat-vision-images', '0');
  setText('stat-vision-api-calls', '0');
  setText('stat-vision-cache-hits', '0');
  setText('stat-vision-failures', '0');
  setText('proxy-page-vision-images', '0');
  setText('proxy-page-vision-api-calls', '0');
  setText('proxy-page-vision-cache-hits', '0');
  setText('proxy-page-vision-failures', '0');
  ['stat-window-requests-bar', 'stat-window-tokens-bar', 'stat-window-errors-bar', 'stat-input-token-bar', 'stat-output-token-bar', 'stat-cached-token-bar'].forEach(id => setBar(id, 0));
  renderTopModels({}, 0);
}

function updateHealthPill(errorRate, latencyMs, windowRequests) {
  const el = document.getElementById('stat-health-pill');
  if (!el) return;
  el.classList.remove('ok', 'warn', 'danger');
  if (!windowRequests) {
    el.textContent = '等待流量';
    return;
  }
  if (errorRate >= 5) {
    el.textContent = '错误偏高';
    el.classList.add('danger');
    return;
  }
  if (errorRate >= 1 || latencyMs >= 8000) {
    el.textContent = '需要关注';
    el.classList.add('warn');
    return;
  }
  el.textContent = '运行正常';
  el.classList.add('ok');
}

async function refreshStats() {
  if (!invoke) return;
  if (_toggling) return;
  if (refreshStats._inFlight) return;
  if (!proxyRunning) {
    resetStatsUi();
    return;
  }
  refreshStats._inFlight = true;
  try {
    const s = await invoke('get_stats');
    const r = s.rate || {};
    const totalTokens = Number(s.totalTokens) || 0;
    const inputTokens = Number(s.inputTokens) || 0;
    const outputTokens = Number(s.outputTokens) || 0;
    const cachedTokens = Number(s.cachedTokens) || 0;
    const totalTokenParts = Math.max(1, inputTokens + outputTokens + cachedTokens);
    const errors = Number(s.errors) || 0;
    const requests = Number(s.requests) || 0;
    const successRate = requests > 0 ? Math.max(0, 100 - (errors / requests) * 100) : null;
    const windowRequests = Number(r.windowRequests) || 0;
    const windowErrors = Number(r.windowErrors) || 0;
    const windowTokens = (Number(r.tpm) || 0) * 60;
    const errorRate = Number(r.errorRate) || 0;
    const avgLatency = Number(r.avgLatencyMs) || 0;

    setText('stat-requests', fmtNum(s.requests));
    setText('proxy-page-requests', fmtNum(s.requests));
    setText('stat-requests-sub', s.requests > 0 ? `运行 ${Math.floor(s.uptimeSec / 60)} 分钟` : '等待请求');
    setText('stat-tokens', fmtNum(s.totalTokens));
    setText('proxy-page-tokens', fmtNum(s.totalTokens));
    const cachedPart = s.cachedTokens ? ` 缓存${fmtNum(s.cachedTokens)} ·` : '';
    setText('stat-tokens-sub', `↑${fmtNum(s.inputTokens)} ↓${fmtNum(s.outputTokens)} ·${cachedPart} ≈$${s.estCostUsd}`);
    setText('stat-success-rate', successRate == null ? '—' : `${successRate.toFixed(successRate >= 99 ? 1 : 0)}%`);
    setText('stat-provider', s.lastProvider || '—');
    setText('stat-model', s.lastModel || '尚无请求');
    setText('stat-errors-sub', s.lastError ? `${fmtNum(errors)} 次错误 · 最近: ${s.lastError}` : `${fmtNum(errors)} 次错误`);
    setText('stat-rpm', r.rpm != null ? r.rpm : '—');
    setText('stat-tpm', r.tpm != null ? fmtNum(r.tpm) : '—');
    setText('stat-latency', r.avgLatencyMs != null ? `${r.avgLatencyMs}ms` : '—');
    setText('stat-retries', fmtNum(s.retries || 0));
    setText('stat-retries-sub', s.lastRetryReason ? `最近: ${s.lastRetryReason}` : '本日累计');
    setText('stat-error-rate', r.errorRate != null ? `${r.errorRate}%` : '—');
    setText('stat-window-errors', `${windowErrors} 个错误`);
    setText('stat-window-requests', fmtNum(windowRequests));
    setText('stat-window-tokens', fmtNum(Math.round(windowTokens)));
    setText('stat-window-errors-count', fmtNum(windowErrors));
    setText('stat-cost', s.estCostUsd != null ? `$${s.estCostUsd}` : '—');
    setText('stat-input-tokens', fmtNum(inputTokens));
    setText('stat-output-tokens', fmtNum(outputTokens));
    setText('stat-cached-tokens', fmtNum(cachedTokens));

    setBar('stat-window-requests-bar', Math.min(100, (windowRequests / 60) * 100));
    setBar('stat-window-tokens-bar', Math.min(100, (windowTokens / 120000) * 100));
    setBar('stat-window-errors-bar', Math.min(100, (windowErrors / Math.max(1, windowRequests)) * 100));
    setBar('stat-input-token-bar', pctOf(inputTokens, totalTokenParts));
    setBar('stat-output-token-bar', pctOf(outputTokens, totalTokenParts));
    setBar('stat-cached-token-bar', pctOf(cachedTokens, totalTokenParts));
    updateHealthPill(errorRate, avgLatency, windowRequests);

    const vision = s.visionFallback || {};
    setText('stat-vision-images', fmtNum(vision.images || 0));
    setText('stat-vision-api-calls', fmtNum(vision.apiCalls || 0));
    setText('stat-vision-cache-hits', fmtNum(vision.cacheHits || 0));
    setText('stat-vision-failures', fmtNum(vision.failures || 0));
    setText('proxy-page-vision-images', fmtNum(vision.images || 0));
    setText('proxy-page-vision-api-calls', fmtNum(vision.apiCalls || 0));
    setText('proxy-page-vision-cache-hits', fmtNum(vision.cacheHits || 0));
    setText('proxy-page-vision-failures', fmtNum(vision.failures || 0));

    renderTopModels(s.byModel || {}, requests);
    // 更新平台设置里的流量路由信息
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

function renderTopModels(byModel, totalRequests = 0) {
  const container = document.getElementById('topModelsChart');
  if (!container) return;
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (entries.length === 0) {
    container.innerHTML = '<div class="proxy-empty-state">尚无模型请求数据</div>';
    return;
  }
  const maxVal = entries[0][1];
  const colors = ['#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#8b5cf6'];
  let html = '<div class="proxy-model-head"><span>模型</span><span>请求</span><span>占比</span><span>分布</span></div>';
  entries.forEach(([model, count], i) => {
    const pct = Math.max(4, (count / maxVal) * 100);
    const share = totalRequests > 0 ? (count / totalRequests) * 100 : 0;
    const color = colors[i % colors.length];
    html += `<div class="proxy-model-row">
      <span class="proxy-model-name" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
      <strong>${fmtNum(count)}</strong>
      <span>${share ? share.toFixed(1) : '0.0'}%</span>
      <div class="proxy-model-bar"><i style="width:${pct}%;background:${color};"></i></div>
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
    if (el.dataset.windowControlBound === '1') return;
    el.dataset.windowControlBound = '1';
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn().catch(err => _diag(`${label} error: ` + err));
    };
    el.addEventListener('click', handler);
    _diag(`${label} handler bound`);
  };
  bind(minBtn, windowMinimize, 'minimize');
  bind(maxBtn, windowMaximize, 'maximize');
  bind(closeBtn, windowClose, 'close');
}


// ═══════ THEME TOGGLE ═══════
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = document.getElementById('theme-setting-label');
  const desc = document.getElementById('theme-setting-desc');
  const btn = document.getElementById('settings-theme-toggle');
  const isDark = theme === 'dark';
  if (label) label.textContent = isDark ? '切换至浅色' : '切换至深色';
  if (desc) desc.textContent = isDark ? '当前使用深色主题' : '当前使用浅色主题';
  if (btn) btn.title = isDark ? '切换至浅色主题' : '切换至深色主题';
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('byok-theme', next);
  } catch (e) {
    applyTheme(isDark ? 'dark' : 'light');
    addLog('err', '保存主题偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
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
  const status = (typeof _platformEl === 'function' ? _platformEl('cert-status') : document.getElementById('cert-status'));
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
  const input = (typeof _platformEl === 'function' ? _platformEl('idePath') : document.getElementById('idePath'));
  const status = (typeof _platformEl === 'function' ? _platformEl('ide-path-status') : document.getElementById('ide-path-status'));
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
  const input = (typeof _platformEl === 'function' ? _platformEl('idePath') : document.getElementById('idePath'));
  const status = (typeof _platformEl === 'function' ? _platformEl('ide-path-status') : document.getElementById('ide-path-status'));
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
      el.dataset.persistedValue = el.value;
    });
    applyToggleStates(values);
    await ensureLocalProxyConfig(values);
    const targetSelect = document.getElementById('targetIde');
    if (targetSelect) targetSelect.dataset.persistedValue = targetSelect.value;
    if (window.ByokI18n) {
      window.ByokI18n.initFromConfig(values);
      window.ByokI18n.bindLanguageControls();
    }
    return values;
  } catch (e) { return {}; }
}

async function saveConfigField(key, value) {
  if (!invoke) {
    if (typeof showCustomAlert === 'function') showCustomAlert('当前环境缺少 Tauri invoke，无法保存配置。', '保存失败', 'error');
    return false;
  }
  try {
    const current = await invoke('load_config');
    current[key] = value;
    await invoke('save_config', { values: current });
    return true;
  } catch (e) {
    addLog('err', '保存配置失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存配置失败', 'error');
    return false;
  }
}

document.querySelectorAll('[data-config-key]').forEach(el => {
  el.addEventListener('change', async () => {
    const previous = el.dataset.persistedValue ?? el.defaultValue ?? '';
    const ok = await saveConfigField(el.getAttribute('data-config-key'), el.value);
    if (ok) {
      el.dataset.persistedValue = el.value;
    } else {
      el.value = previous;
    }
  });
});

// ═══════ TOGGLE SWITCHES (persisted as config) ═══════
document.querySelectorAll('[data-config-toggle]').forEach(el => {
  el.addEventListener('click', async () => {
    const key = el.getAttribute('data-config-toggle');
    const previous = el.classList.contains('on');
    const next = !previous;
    setConfigToggleState(key, next);
    const ok = await saveConfigField(key, next ? 'true' : 'false');
    if (!ok) setConfigToggleState(key, previous);
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
    // AUTO_START_PROXY 默认为 true（未配置时也开启）
    if (key === 'AUTO_START_PROXY') {
      setConfigToggleElementState(el, config[key] !== 'false');
    } else {
      if (config[key] === 'true') setConfigToggleElementState(el, true);
      else if (config[key] === 'false') setConfigToggleElementState(el, false);
    }
  });
}

function setConfigToggleElementState(el, enabled) {
  el.classList.toggle('on', !!enabled);
  el.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  el.setAttribute('aria-checked', enabled ? 'true' : 'false');
}

function setConfigToggleState(key, enabled) {
  document.querySelectorAll(`[data-config-toggle="${key}"]`).forEach(el => {
    setConfigToggleElementState(el, enabled);
  });
}
