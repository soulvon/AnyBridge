// shell/platform-settings-and-lang.js — 平台设置弹窗、IDE 目标选择器与界面汉化动作工厂
import { showCustomAlert, showBottomToast } from '../ui/feedback.js';

function mountPlatformOwnedSettings() {
  const moves = [
    ['0', 'platform-health-mount'],
    ['1', 'platform-access-mount']
  ];
  moves.forEach(([panelId, mountId]) => {
    const source = document.querySelector(`.settings-detail > [data-panel-id="${panelId}"]`);
    const mount = document.getElementById(mountId);
    if (!source || !mount) return;
    if (mount.firstElementChild) {
      // 已挂载过，只需重置 active 状态
      mount.classList.toggle('active', panelId === '0');
      return;
    }
    const clone = source.cloneNode(true);
    mount.classList.toggle('active', panelId === '0');

    /* ── 根源处理：剥离克隆卡片自身的玻璃外壳 ── */
    clone.classList.remove('glass-card', 'settings-panel', 'active');
    clone.removeAttribute('style');
    clone.removeAttribute('data-panel-id');
    // 移除 card-header（标题栏已由左侧导航体现）
    const header = clone.querySelector(':scope > .card-header');
    if (header) header.remove();

    /* ── 根源处理：剥离内部嵌套的 glass-card 外壳 ── */
    clone.querySelectorAll('.glass-card').forEach(inner => {
      inner.classList.remove('glass-card');
      inner.removeAttribute('style');
      const innerHeader = inner.querySelector(':scope > .card-header');
      if (innerHeader) innerHeader.remove();
    });
    // .health-summary / .control-bar 自带边框/背景，用 .platform-inlined 剥离
    clone.querySelectorAll('.health-summary, .control-bar').forEach(el => {
      el.classList.add('platform-inlined');
      el.removeAttribute('style');
    });

    /* ── 根源处理：解决 ID 重复——克隆中的 id 改为 data-oid ── */
    // 这样 _platformEl() 可以通过 data-oid 在活跃 mount 中找到克隆的元素
    clone.querySelectorAll('[id]').forEach(el => {
      el.setAttribute('data-oid', el.id);
      el.removeAttribute('id');
    });

    mount.appendChild(clone);
  });
  bindPlatformSettingsNav();
}

/**
 * 上下文感知的元素查找：优先从平台设置的活跃 mount 中查找克隆元素，
 * 回退到全局 getElementById。供 70-healthcheck.js 和 20-runtime.js 使用。
 */
function _platformEl(id) {
  const modal = document.getElementById('platform-settings-modal');
  if (modal && modal.classList.contains('active')) {
    const el = modal.querySelector('[data-oid="' + id + '"]') || modal.querySelector('#' + id);
    if (el) return el;
  }
  const activeMount = document.querySelector('#platform-panel-settings .platform-settings-mount.active');
  if (activeMount) {
    const el = activeMount.querySelector('[data-oid="' + id + '"]');
    if (el) return el;
  }
  return document.getElementById(id);
}

function openPlatformSettingsModal(initialTab = 'health') {
  const modal = document.getElementById('platform-settings-modal');
  if (!modal) return;
  switchPlatformSettingsTab(initialTab);
  syncPlatformSettingsModalData();
  modal.classList.add('active');
}

function closePlatformSettingsModal() {
  const modal = document.getElementById('platform-settings-modal');
  if (modal) modal.classList.remove('active');
}

function switchPlatformSettingsTab(tabName) {
  const isHealth = tabName === 'health';
  const healthBtn = document.getElementById('platform-settings-tab-btn-health');
  const accessBtn = document.getElementById('platform-settings-tab-btn-access');
  const healthPanel = document.getElementById('platform-settings-panel-health');
  const accessPanel = document.getElementById('platform-settings-panel-access');
  if (healthBtn) healthBtn.classList.toggle('active', isHealth);
  if (accessBtn) accessBtn.classList.toggle('active', !isHealth);
  if (healthPanel) healthPanel.classList.toggle('active', isHealth);
  if (accessPanel) accessPanel.classList.toggle('active', !isHealth);
}

function syncPlatformSettingsModalData() {
  const modal = document.getElementById('platform-settings-modal');
  if (!modal) return;
  const mainIdeInput = document.getElementById('idePath');
  const modalIdeInput = modal.querySelector('[data-oid="idePath"]');
  if (modalIdeInput && mainIdeInput) {
    modalIdeInput.value = mainIdeInput.value || '';
  }
  const mainUnlock = document.getElementById('enhancement-unlockModels');
  const modalUnlock = modal.querySelector('[data-oid="enhancement-unlockModels"]');
  if (modalUnlock && mainUnlock) {
    modalUnlock.checked = mainUnlock.checked;
  }
  const mainRestartToggle = document.getElementById('ideRestartPromptToggle');
  const modalRestartToggle = modal.querySelector('[data-oid="ideRestartPromptToggle"]');
  const mainRestartMode = document.getElementById('ideRestartPromptMode');
  const modalRestartMode = modal.querySelector('[data-oid="ideRestartPromptMode"]');
  if (modalRestartToggle && mainRestartToggle) {
    modalRestartToggle.classList.toggle('active', mainRestartToggle.classList.contains('active'));
  }
  if (modalRestartMode && mainRestartMode) {
    modalRestartMode.textContent = mainRestartMode.textContent;
  }
  const mainCertStatus = document.getElementById('cert-status');
  const modalCertStatus = modal.querySelector('[data-oid="cert-status"]');
  if (modalCertStatus && mainCertStatus) {
    modalCertStatus.textContent = mainCertStatus.textContent;
  }
}

function bindPlatformSettingsNav() {
  const nav = document.querySelector('#platform-panel-settings .settings-sidebar');
  if (!nav || nav.dataset.bound === '1') return;
  nav.dataset.bound = '1';
  const items = nav.querySelectorAll('.settings-menu-item[data-platform-settings-panel]');
  const mounts = document.querySelectorAll('#platform-panel-settings .platform-settings-mount');
  items.forEach(item => {
    item.addEventListener('click', () => {
      const idx = item.dataset.platformSettingsPanel;
      items.forEach(i => i.classList.toggle('active', i === item));
      mounts.forEach((m, i) => {
        m.classList.toggle('active', String(i) === idx);
      });
    });
  });
}

function openProxyPlatform(platformId) {
  const target = normalizeProxyPlatform(platformId);
  const select = document.getElementById('targetIde');
  const changed = select && select.value !== target;
  if (select) {
    select.value = target;
  }
  updateProxyPlatformCopy(target);
  setPlatformRailActive(target);
  if (changed && typeof onTargetIdeChange === 'function') {
    onTargetIdeChange();
  }
  if (typeof setStatusPill === 'function') {
    setStatusPill(typeof proxyRunning !== 'undefined' ? proxyRunning : false);
  }
  activePlatformSection = 'models';
  navigateTo('models');
  if (typeof renderModelMap === 'function') {
    renderModelMap().catch(() => {});
  }
}

function openPlaceholderPlatform(platformId) {
  setPlatformRailActive(platformId);
  navigateTo(`platform-${platformId}`);
}

// ═══════ IDE SELECTOR ═══════
function getTargetIde() {
  const select = document.getElementById('targetIde');
  return select ? select.value : 'windsurf';
}

function syncCustomSelector() {}

async function onTargetIdeChange() {
  const select = document.getElementById('targetIde');
  const previousIde = select?.dataset.persistedValue || 'windsurf';
  const ide = getTargetIde();

  // 保存配置到 BYOK config
  if (invoke) {
    try {
      const config = await invoke('load_config') || {};
      config.target_ide = ide;
      await invoke('save_config', { values: config });
      if (select) select.dataset.persistedValue = ide;
    } catch (e) {
      if (select) select.value = previousIde;
      updateProxyPlatformCopy(previousIde);
      setPlatformRailActive(previousIde);
      syncCustomSelector();
      addLog('err', '目标 IDE 保存失败: ' + e);
      showCustomAlert(String(e), '保存失败', 'error');
      return;
    }
  }

  // 如果是自动检测，执行检测
  let displayIde = ide;
  if (ide === 'auto' && invoke) {
    try {
      const detected = await invoke('detect_target_ide');
      if (detected && (detected === 'windsurf' || detected === 'devin' || detected === 'cursor')) {
        displayIde = detected;
      }
    } catch (e) {
      console.error('Auto-detect failed:', e);
    }
  }

  // 更新状态文本和 flow 图
  updateFlowIdeTarget(displayIde);
  if (displayIde === 'windsurf' || displayIde === 'devin' || displayIde === 'cursor') {
    updateProxyPlatformCopy(displayIde);
    setPlatformRailActive(displayIde);
  }
  setStatusPill(proxyRunning);
  if (typeof refreshIdeProxyStatus === 'function') refreshIdeProxyStatus(displayIde).catch(() => {});
  const displayLabel = displayIde === 'auto' ? '自动检测' : displayIde.charAt(0).toUpperCase() + displayIde.slice(1);
  addLog('info', `目标 IDE 切换为: ${displayLabel}`);
  if (proxyRunning && typeof activeProxyTarget !== 'undefined' && activeProxyTarget) {
    const runningLabel = activeProxyTarget.charAt(0).toUpperCase() + activeProxyTarget.slice(1);
    if (ide !== 'auto' && ide !== activeProxyTarget) {
      addLog('warn', `本地网关正在运行；新的 IDE 选择只影响当前页面的切换按钮`);
    }
  }

  // 同步自定义下拉状态
  syncCustomSelector();
}

function updateFlowIdeTarget(ide) {
  const ideLabel = ide === 'auto' ? '自动检测' : ide.charAt(0).toUpperCase() + ide.slice(1);
  const flowSub = document.getElementById('flowIdeTarget');
  if (flowSub) {
    flowSub.textContent = ideLabel;
  }
}

// ═══════ 界面汉化通用工厂（Windsurf/Devin/Cursor 共用） ═══════
// DOM id 前缀 + 平台 id 参数化：data-action 绑定到实例化后的具体函数。

function proxyLangPlatform() {
  const ide = typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf';
  return (ide === 'devin' || ide === 'windsurf') ? ide : null;
}

function makeLangActions(prefix, getPlatform, displayName) {
  const el = (id) => document.getElementById(prefix + id);
  const name = () => displayName || (getPlatform() === 'devin' ? 'Devin Desktop' : 'Windsurf');

  function appendLog(text, level = 'info') {
    const box = el('LogBox');
    if (!box) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    let prefixTag = '[信息]';
    if (level === 'ok') prefixTag = '[成功]';
    else if (level === 'warn') prefixTag = '[警告]';
    else if (level === 'err') prefixTag = '[错误]';
    box.textContent += `${time} ${prefixTag} ${text}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = el('LogBox');
    if (box) box.textContent = '';
  }

  async function refreshStatus(updateModal = false) {
    const btn = el('Btn');
    const platform = getPlatform();
    if (!btn) return;
    if (!platform) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    if (typeof invoke !== 'function') return;
    try {
      const st = await invoke('get_app_localization_status', { platform });
      const textEl = el('BtnText');
      if (textEl) textEl.textContent = st?.localized ? '已汉化' : '一键汉化';
      btn.classList.toggle('success', !!st?.localized);
      btn.classList.toggle('secondary', !st?.localized);
      if (updateModal) {
        const clientName = name();
        const badge = el('ModalStatusBadge');
        if (badge) {
          // 未汉化是正常状态，用中性色而不是警告红
          if (st?.localized) {
            badge.textContent = '已汉化';
            badge.style.background = 'rgba(16, 185, 129, 0.15)';
            badge.style.color = '#10b981';
          } else {
            badge.textContent = '未汉化';
            badge.style.background = 'var(--bg-glass-elevated, rgba(255,255,255,0.06))';
            badge.style.color = 'var(--text-muted)';
          }
        }
        const verEl = el('ModalVer');
        if (verEl && st?.currentVersion) verEl.textContent = 'v' + st.currentVersion;
        const langPackEl = el('ModalLangPack');
        if (langPackEl) {
          langPackEl.textContent = st?.langPackInstalled ? '已安装' : '未安装';
          langPackEl.style.color = st?.langPackInstalled ? '#10b981' : 'var(--text-muted)';
        }
        const restoreBtn = el('ModalRestoreBtn');
        if (restoreBtn) restoreBtn.disabled = !st?.localized;
        const applyBtn = el('ModalApplyBtn');
        if (applyBtn) applyBtn.textContent = st?.localized ? '重新应用汉化' : '一键应用汉化';
        if (st?.installed) {
          appendLog(`检测到 ${clientName} 已安装，当前状态: ${st.localized ? '已汉化' : '官方英文未汉化'}`);
        } else {
          appendLog(`未检测到 ${clientName} 的标准安装目录，请先安装并运行一次该客户端`, 'warn');
        }
      }
    } catch (err) {
      if (updateModal) appendLog(`状态探测异常: ${err}`, 'err');
    }
  }

  function openModal() {
    const modal = el('Modal');
    const platform = getPlatform();
    if (!modal || !platform) return;
    const clientName = name();
    const titleEl = el('ModalTitle');
    if (titleEl) titleEl.textContent = `${clientName} 界面汉化`;
    const clientNameEl = el('ModalClientName');
    if (clientNameEl) clientNameEl.textContent = clientName;
    clearLog();
    modal.classList.add('active');
    appendLog(`已打开 ${clientName} 汉化管理面板，正在探测环境状态...`);
    void refreshStatus(true);
  }

  function closeModal() {
    const modal = el('Modal');
    if (modal) modal.classList.remove('active');
  }

  // 与白色反重力（Antigravity 桌面端汉化）的操作交互对齐：
  // apply/restore 成功后弹统一的重启确认窗，支持一键重启客户端。
  // 注意：lead 不带客户端名——标题（"重启 {客户端}"）已经有，重复显得冗余。
  async function confirmRestart(actionDesc, statusText) {
    const target = getPlatform();
    if (typeof promptRestartIde !== 'function') return;
    const restarted = await promptRestartIde(
      `${actionDesc}，是否立即重启客户端使其生效？`,
      target,
      {
        title: `重启 ${name()}`,
        // 要点已并入上方问句，隐藏重复的状态条；「重启会强制关闭 IDE」的警示保留
        statusText: null,
        skipAutoPreference: true,
      }
    );
    if (restarted) {
      appendLog(`${name()} 已重启，界面变更已生效`, 'ok');
      // 重启成功后关掉汉化面板（客户端已重启，面板任务完成）
      const modalMap = { windsurf: 'proxyLangModal', devin: 'proxyLangModal', cursor: 'cursorLangModal', 'claude-desktop': 'claudeLangModal' };
      const modalId = modalMap[target];
      if (modalId) el(modalId)?.classList.remove('active');
    } else {
      appendLog(`已选择稍后重启，下次启动客户端后生效`);
    }
  }

  async function applyAction() {
    const platform = getPlatform();
    if (!platform) return;
    const clientName = name();
    appendLog('----------------------------------------');
    const applyBtn = el('ModalApplyBtn');
    if (applyBtn) applyBtn.disabled = true;
    try {
      // 词库策略（对齐反馈：每次检查更新太慢）：apply 不做更新检查，
      // 本地有词库直接用（手动更新走「检查在线词库更新」按钮）。
      // 仅 Claude 首次使用（本地无词库缓存）时自动下载，否则它无法汉化。
      appendLog(`[1/4] 正在准备中文词库...`);
      try {
        const st = await invoke('get_app_localization_status', { platform });
        if (platform === 'claude-desktop' && !st?.langPackInstalled) {
          appendLog(`本地暂无词库，正在下载（约 1MB，仅首次）...`);
          const dl = await invoke('download_app_localization_update', { platform });
          appendLog(`词库下载成功: ${dl?.message}`, 'ok');
        } else {
          appendLog(`词库已就绪 (v${st?.currentVersion || 'baseline'}）`);
        }
      } catch (e) {
        appendLog(`词库准备失败（可点「检查在线词库更新」重试）: ${e}`, 'warn');
      }
      // 第二步：应用汉化
      appendLog(`[2/4] 正在检测 ${clientName} 安装与写入权限...`);
      appendLog(`[3/4] 正在备份原版资源并写入汉化...`);
      const res = await invoke('apply_app_localization', { platform });
      appendLog(`[4/4] ${res?.message || '汉化注入完成！'}`, 'ok');
      await refreshStatus(true);
      if (typeof showBottomToast === 'function') {
        showBottomToast(res?.message || `${clientName} 汉化成功`, 'success', { duration: 6000 });
      }
      appendLog('升级保活已开启：客户端升级覆盖后，AnyBridge 运行时会自动重新注入');
      await confirmRestart('汉化补丁已成功注入', '汉化补丁已写入本地客户端资源，重启后中文界面即刻生效。');
    } catch (e) {
      appendLog(`汉化失败: ${e?.message || e}`, 'err');
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(String(e?.message || e), '汉化失败', 'error');
      }
    } finally {
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  async function restoreAction() {
    const platform = getPlatform();
    if (!platform) return;
    const clientName = name();
    appendLog('----------------------------------------');
    appendLog(`[1/2] 正在检索 ${clientName} 官方原版备份并准备还原...`);
    const restoreBtn = el('ModalRestoreBtn');
    if (restoreBtn) restoreBtn.disabled = true;
    try {
      const res = await invoke('restore_app_localization', { platform });
      appendLog(`[2/2] ${res?.message || '已成功还原官方英文原版！'}`, 'ok');
      await refreshStatus(true);
      if (typeof showBottomToast === 'function') {
        showBottomToast(res?.message || `${clientName} 已恢复英文原版`, 'success', { duration: 6000 });
      }
      await confirmRestart('已还原官方英文原版', '已还原官方英文原版，重启后恢复英文界面。');
    } catch (e) {
      appendLog(`还原英文失败: ${e?.message || e}`, 'err');
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(String(e?.message || e), '还原失败', 'error');
      }
    } finally {
      if (restoreBtn) restoreBtn.disabled = false;
    }
  }

  async function checkUpdateAction() {
    const platform = getPlatform();
    if (!platform) return;
    appendLog('----------------------------------------');
    appendLog('正在检查上游词库更新...');
    try {
      const info = await invoke('check_app_localization_update', { platform });
      appendLog(`上游词库版本: ${info?.latestVersion || '未知'}`);
      if (info?.hasUpdate) {
        appendLog(`发现新版汉化词库（当前 v${info.currentVersion}），正在下载...`, 'ok');
        appendLog('正在下载最新词库至本地热更新缓存...');
        const dl = await invoke('download_app_localization_update', { platform });
        appendLog(`词库下载成功: ${dl?.message}`, 'ok');
        // 只下载，不自动应用：是否注入、何时注入由用户决定（应用按钮才是注入入口）
        appendLog('新词库已就绪，点击「重新应用汉化」即可生效', 'warn');
        if (typeof showBottomToast === 'function') {
          showBottomToast('词库已更新，点击「重新应用汉化」生效', 'success');
        }
      } else {
        appendLog(`当前词库已是最新版本 (v${info?.currentVersion || 'baseline'})，无需更新`, 'ok');
        if (typeof showBottomToast === 'function') {
          showBottomToast(`当前汉化词库已是最新版本 (v${info?.currentVersion || 'baseline'})`, 'success');
        }
      }
    } catch (e) {
      appendLog(`检查在线更新失败（不影响离线使用内置汉化）: ${e}`, 'warn');
      if (typeof showCustomAlert === 'function') {
        showCustomAlert('检查在线更新失败（将使用内置离线汉化词库）：\n' + String(e?.message || e), '检查提示', 'info');
      }
    }
  }

  return { appendLog, clearLog, refreshStatus, openModal, closeModal, applyAction, restoreAction, checkUpdateAction };
}

// 实例：Windsurf/Devin（models 页，平台跟随 IDE 选择器）、Cursor、Claude Desktop
const proxyLangActions = makeLangActions('proxyLang', () => proxyLangPlatform());
const cursorLangActions = makeLangActions('cursorLang', () => 'cursor', 'Cursor');
const claudeLangActions = makeLangActions('claudeLang', () => 'claude-desktop', 'Claude Desktop');

globalThis.openProxyLangModal = proxyLangActions.openModal;
globalThis.closeProxyLangModal = proxyLangActions.closeModal;
globalThis.clearProxyLangLog = proxyLangActions.clearLog;
globalThis.applyProxyLocalizationAction = proxyLangActions.applyAction;
globalThis.restoreProxyLocalizationAction = proxyLangActions.restoreAction;
globalThis.checkProxyLocalizationUpdateAction = proxyLangActions.checkUpdateAction;
globalThis.refreshProxyLangStatus = proxyLangActions.refreshStatus;

globalThis.openCursorLangModal = cursorLangActions.openModal;
globalThis.closeCursorLangModal = cursorLangActions.closeModal;
globalThis.clearCursorLangLog = cursorLangActions.clearLog;
globalThis.applyCursorLocalizationAction = cursorLangActions.applyAction;
globalThis.restoreCursorLocalizationAction = cursorLangActions.restoreAction;
globalThis.checkCursorLocalizationUpdateAction = cursorLangActions.checkUpdateAction;
globalThis.refreshCursorLangStatus = cursorLangActions.refreshStatus;

globalThis.openClaudeLangModal = claudeLangActions.openModal;
globalThis.closeClaudeLangModal = claudeLangActions.closeModal;
globalThis.clearClaudeLangLog = claudeLangActions.clearLog;
globalThis.applyClaudeLocalizationAction = claudeLangActions.applyAction;
globalThis.restoreClaudeLocalizationAction = claudeLangActions.restoreAction;
globalThis.checkClaudeLocalizationUpdateAction = claudeLangActions.checkUpdateAction;
globalThis.refreshClaudeLangStatus = claudeLangActions.refreshStatus;

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.mountPlatformOwnedSettings = mountPlatformOwnedSettings;
  g._platformEl = _platformEl;
  g.openPlatformSettingsModal = openPlatformSettingsModal;
  g.closePlatformSettingsModal = closePlatformSettingsModal;
  g.switchPlatformSettingsTab = switchPlatformSettingsTab;
  g.syncPlatformSettingsModalData = syncPlatformSettingsModalData;
  g.bindPlatformSettingsNav = bindPlatformSettingsNav;
  g.openProxyPlatform = openProxyPlatform;
  g.openPlaceholderPlatform = openPlaceholderPlatform;
  g.getTargetIde = getTargetIde;
  g.syncCustomSelector = syncCustomSelector;
  g.onTargetIdeChange = onTargetIdeChange;
  g.updateFlowIdeTarget = updateFlowIdeTarget;
})(globalThis);
