// ES module (P3/P4) — feedback 已迁至 ui/feedback.js
import { showCustomAlert, showBottomToast, showCustomConfirm, showCustomPrompt } from './ui/feedback.js';
// ═══════ TAB NAVIGATION ═══════
globalThis.tabs = document.querySelectorAll('.tab-item[data-page]');
globalThis.pages = document.querySelectorAll('.page');
globalThis.activePlatformSection = 'models';

globalThis.PLATFORM_SHELL_PAGES = new Set([
  'platform-proxy',
  'slot-editor',
  'model-slots',
  'models',
  'more-platforms',
  'platform-cursor',
  'platform-claude-code',
  'platform-codex',
  'platform-codebuddy',
  'platform-codebuddy-add',
  'platform-opencode',
  'platform-zcode',
  'platform-zcode-add',
  'platform-workbuddy',
  'platform-workbuddy-add'
]);

function normalizePlatformSection(section) {
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
  const panelId = normalizePlatformSection(section) === 'settings' ? 'settings' : 'overview';
  document.querySelectorAll('.platform-panel[data-platform-panel]').forEach(panel => {
    const isActive = panel.dataset.platformPanel === panelId;
    panel.classList.toggle('active', isActive);
  });
}

function syncPlatformSubtabsForPage(pageId) {
  const section = getPlatformSectionForPage(pageId);
  if (!section) return;
  activePlatformSection = section;
  document.querySelectorAll('.platform-subtab[data-platform-section]').forEach(tab => {
    const isActive = tab.dataset.platformSection === section;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  });
  if (pageId === 'platform-proxy') {
    setPlatformPanel(section);
  }
}

function openPlatformSection(section) {
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
}

function syncPlatformConsoleHead() {
  document.querySelectorAll('.platform-console-head').forEach(head => {
    head.style.display = '';
  });
}

function hideAllEditorModals() {
  // providerModal / slotModal 已经被改造为普通 page（page-provider-editor / page-slot-editor），
  // 关闭时由 navigateTo 切回列表页；这里只收起真正的弹窗
  ['failoverModal', 'modelMapSettingsModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('is-open');
  });
}

function navigateTo(pageId) {
  // 切页前先收起所有编辑弹窗，避免弹层残留造成"仪表盘出现模型面板"
  hideAllEditorModals();

  if (pageId === 'platform-proxy' && activePlatformSection !== 'settings') {
    activePlatformSection = 'overview';
  }

  // 编辑器 page 归属到对应的 tab：高亮对应的 tab，激活对应 page
  const editorToTabMap = {
    'provider-editor': 'providers',
    'eval': 'providers',
    'eval-history': 'providers',
    'slot-editor': 'models',
    'model-slots': 'models',
    'models': 'models',
    'more-platforms': 'models',
    'platform-cursor': 'models',
    'platform-claude-code': 'models',
    'platform-codex': 'models',
    'platform-codebuddy': 'models',
    'platform-codebuddy-add': 'models',
    'platform-opencode': 'models',
    'platform-zcode': 'models',
    'platform-zcode-add': 'models',
    'platform-workbuddy': 'models',
    'platform-workbuddy-add': 'models'
  };
  const activeTabPageId = pageId === 'platform-proxy' && activePlatformSection === 'settings'
    ? 'models'
    : editorToTabMap[pageId] || pageId;
  tabs.forEach(t => {
    const isActive = t.dataset.page === activeTabPageId;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', String(isActive));
    t.tabIndex = isActive ? 0 : -1;
  });
  pages.forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');
  const main = document.querySelector('.main');
  if (main) {
    main.classList.toggle('settings-active', pageId === 'settings');
  }
  const topbarSettingsBtn = document.getElementById('topbarSettingsBtn');
  if (topbarSettingsBtn) {
    topbarSettingsBtn.classList.toggle('active', pageId === 'settings');
  }
  const shell = document.querySelector('.workspace-shell');
  if (shell) {
    shell.classList.toggle('without-platform-rail', !PLATFORM_SHELL_PAGES.has(pageId));
  }
  if (pageId === 'eval') {
    renderEvalProviderOptions({ fetchRemote: true });
    loadEvalReports();
  }
  if (pageId === 'eval-history') {
    loadEvalReports();
  }
  if (pageId === 'more-platforms' && typeof refreshPlatforms === 'function') {
    refreshPlatforms();
  }
  if (pageId === 'extensions') {
    if (typeof onExtensionsPageEnter === 'function') onExtensionsPageEnter();
    else if (typeof refreshExtensionStatuses === 'function') refreshExtensionStatuses({ silent: true });
  } else if (typeof onExtensionsPageLeave === 'function') {
    onExtensionsPageLeave();
  }
  syncPlatformRailForPage(pageId);
  syncPlatformSubtabsForPage(pageId);
}

function focusTabByOffset(currentTab, offset) {
  const tabList = Array.from(tabs);
  const index = tabList.indexOf(currentTab);
  if (index < 0) return;
  const nextIndex = (index + offset + tabList.length) % tabList.length;
  const nextTab = tabList[nextIndex];
  if (nextTab.dataset.page === 'proxy' && typeof openProxyPanel === 'function') {
    openProxyPanel('overview');
  } else {
    navigateTo(nextTab.dataset.page);
  }
  nextTab.focus();
}

tabs.forEach(t => {
  t.addEventListener('click', () => {
    if (t.dataset.platformSection) openPlatformSection(t.dataset.platformSection);
    else if (t.dataset.page === 'proxy' && typeof openProxyPanel === 'function') openProxyPanel('overview');
    else navigateTo(t.dataset.page);
  });
  t.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (t.dataset.platformSection) openPlatformSection(t.dataset.platformSection);
      else if (t.dataset.page === 'proxy' && typeof openProxyPanel === 'function') openProxyPanel('overview');
      else navigateTo(t.dataset.page);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusTabByOffset(t, 1);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusTabByOffset(t, -1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusTabByOffset(t, -Array.from(tabs).indexOf(t));
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusTabByOffset(t, tabs.length - 1 - Array.from(tabs).indexOf(t));
    }
  });
});

function focusPlatformSubtabByOffset(currentTab, offset) {
  const tabList = Array.from(currentTab.closest('.platform-subtab-nav')?.querySelectorAll('.platform-subtab[data-platform-section]') || []);
  const index = tabList.indexOf(currentTab);
  if (index < 0) return;
  const nextIndex = (index + offset + tabList.length) % tabList.length;
  const nextTab = tabList[nextIndex];
  const section = nextTab.dataset.platformSection;
  openPlatformSection(section);
  const activeVisibleTab = document.querySelector(`.page.active .platform-subtab[data-platform-section="${section}"]`);
  (activeVisibleTab || nextTab).focus();
}

document.querySelectorAll('.platform-subtab[data-platform-section]').forEach(tab => {
  tab.addEventListener('click', () => openPlatformSection(tab.dataset.platformSection));
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPlatformSection(tab.dataset.platformSection);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusPlatformSubtabByOffset(tab, 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusPlatformSubtabByOffset(tab, -1);
    }
  });
});

// ═══════ SETTINGS SUBNAV ═══════
function activateSettingsPanel(index) {
  const panelIndex = String(index);
  const menuItems = document.querySelectorAll('.settings-menu-item[data-settings-panel]');
  // 旧版用 DOM 顺序匹配, 新版用 panel 上 data-panel-id 匹配, 这样 menu 编号和
  // panel DOM 顺序解耦, 加新 panel / 调顺序不需要重排大块 HTML。
  const panels = document.querySelectorAll('.settings-detail > [data-panel-id]');
  menuItems.forEach(item => {
    const isActive = String(item.dataset.settingsPanel) === panelIndex;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', String(isActive));
  });
  panels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panelId === panelIndex);
  });
}

function openSettingsPanel(panelId) {
  navigateTo('settings');
  activateSettingsPanel(panelId);
}

// ═══════ QUICK START GUIDE ═══════
globalThis.ONBOARDING_GUIDE_SEEN_KEY = 'anybridge.onboardingGuideSeen';

function markOnboardingGuideSeen() {
  localStorage.setItem(ONBOARDING_GUIDE_SEEN_KEY, '1');
}

function openOnboardingGuide(options = {}) {
  const modal = document.getElementById('onboarding-guide-modal');
  if (!modal) throw new Error('onboarding-guide-modal not found');
  modal.classList.add('active');
  if (!options.manual) markOnboardingGuideSeen();
  document.addEventListener('keydown', closeOnboardingGuideOnEsc);
}

function closeOnboardingGuide() {
  const modal = document.getElementById('onboarding-guide-modal');
  if (!modal) throw new Error('onboarding-guide-modal not found');
  modal.classList.remove('active');
  markOnboardingGuideSeen();
  document.removeEventListener('keydown', closeOnboardingGuideOnEsc);
}

function finishOnboardingGuide() {
  closeOnboardingGuide();
  navigateTo('models');
}

function closeOnboardingGuideOnEsc(event) {
  if (event.key === 'Escape') closeOnboardingGuide();
}

function maybeShowOnboardingGuide() {
  if (localStorage.getItem(ONBOARDING_GUIDE_SEEN_KEY) === '1') return;
  openOnboardingGuide();
}

function activateProxyPanel(panelId = 'overview') {
  const validPanels = new Set(['overview', 'routes', 'enhancement', 'logs', 'stats']);
  const target = validPanels.has(panelId) ? panelId : 'overview';
  document.querySelectorAll('.proxy-console-tab[data-proxy-panel]').forEach(tab => {
    const isActive = tab.dataset.proxyPanel === target;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('.proxy-console-section[data-proxy-section]').forEach(section => {
    section.classList.toggle('active', section.dataset.proxySection === target);
  });
  if (target === 'enhancement' && typeof renderProxyEnhancement === 'function') {
    renderProxyEnhancement();
  }
  if (target === 'routes' && typeof renderProxyRoutes === 'function') {
    renderProxyRoutes();
  }
  if ((target === 'stats' || target === 'logs') && typeof refreshStats === 'function') {
    refreshStats();
  }
  if (target === 'stats' && typeof renderProxyStats === 'function') {
    renderProxyStats();
  }
  if (target === 'logs' && typeof renderLogs === 'function') {
    renderLogs();
  }
}

function openProxyPanel(panelId = 'overview') {
  navigateTo('proxy');
  activateProxyPanel(panelId);
}

/**
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

function mountProxyEnhancementPanel() {
  const source = document.getElementById('proxyEnhancementModal');
  const mount = document.getElementById('proxyEnhancementMount');
  if (!source || !mount || source.dataset.mounted === 'proxy') return;

  source.dataset.mounted = 'proxy';
  source.id = 'proxyEnhancementPanel';
  source.classList.remove('editor-overlay', 'is-open');
  source.classList.add('glass-card', 'proxy-enhancement-settings');
  source.removeAttribute('style');
  source.removeAttribute('data-panel-id');

  const innerCard = source.querySelector(':scope > .glass-card');
  if (innerCard) {
    innerCard.removeAttribute('style');
    innerCard.classList.remove('glass-card');
    while (innerCard.firstChild) source.appendChild(innerCard.firstChild);
    innerCard.remove();
  }

  source.querySelectorAll('button[data-action="closeProxyEnhancement"]').forEach(btn => btn.remove());
  const header = source.querySelector(':scope > .card-header');
  if (header) header.removeAttribute('style');
  const body = source.querySelector(':scope > .card-body');
  if (body) {
    body.classList.add('proxy-enhancement-body');
    body.removeAttribute('style');
  }

  mount.appendChild(source);
}

function activateEnhancementPanel(panelId) {
  const tabs = document.querySelectorAll('.proxy-enhancement-tab[data-enhancement-panel]');
  const panes = document.querySelectorAll('.proxy-enhancement-pane[data-enhancement-pane]');
  tabs.forEach(tab => {
    const isActive = tab.dataset.enhancementPanel === panelId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  panes.forEach(pane => {
    pane.classList.toggle('active', pane.dataset.enhancementPane === panelId);
  });
}

document.querySelectorAll('.settings-menu-item[data-settings-panel]').forEach(item => {
  item.addEventListener('click', () => activateSettingsPanel(item.dataset.settingsPanel));
});
document.querySelectorAll('.proxy-console-tab[data-proxy-panel]').forEach(tab => {
  tab.addEventListener('click', () => activateProxyPanel(tab.dataset.proxyPanel));
});
mountProxyEnhancementPanel();
mountProxyStatsAndLogsPanels();
document.querySelectorAll('.proxy-enhancement-tab[data-enhancement-panel]').forEach(tab => {
  tab.addEventListener('click', () => activateEnhancementPanel(tab.dataset.enhancementPanel));
});
mountPlatformOwnedSettings();
activateSettingsPanel('appearance');
activateProxyPanel('overview');
syncPlatformSubtabsForPage('platform-proxy');

// ═══════ PLATFORM RAIL ═══════
globalThis.PROXY_PLATFORM_META = {
  windsurf: {
    label: 'Windsurf',
    title: 'Windsurf 接入控制台',
    short: 'Windsurf',
    icon: './assets/icons/platform-windsurf.svg',
    subtitle: '本机代理、MITM 证书、Windsurf 配置和模型路由集中管理。',
    kiteAd: 'Kite 插件：Windsurf 增强入口'
  },
  devin: {
    label: 'Devin',
    title: 'Devin 接入控制台',
    short: 'Devin',
    icon: './assets/icons/platform-devin.svg',
    subtitle: '本机代理、MITM 证书、Devin 配置和模型路由集中管理。',
    kiteAd: 'Kite 插件：Devin 增强入口'
  },
  cursor: {
    label: 'Cursor',
    short: 'Cursor',
    icon: './assets/icons/platform-cursor.svg',
    subtitle: 'Cursor 通过本机 MITM 入口接入代理模型、对话工具流、Background Composer 和会话落盘。'
  }
};

function normalizeProxyPlatform(platformId) {
  return platformId === 'devin' || platformId === 'windsurf' || platformId === 'cursor' ? platformId : 'windsurf';
}

function setPlatformRailActive(platformId) {
  document.querySelectorAll('.platform-rail-item[data-platform-rail]').forEach(item => {
    const isActive = item.dataset.platformRail === platformId;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

function updateProxyPlatformCopy(platformId) {
  const id = normalizeProxyPlatform(platformId);
  const meta = PROXY_PLATFORM_META[id] || PROXY_PLATFORM_META.windsurf;
  const title = document.getElementById('proxy-platform-title');
  const subtitle = document.getElementById('proxy-platform-subtitle');
  const icon = document.getElementById('proxy-platform-icon');
  const kiteAd = document.getElementById('proxy-platform-kite-ad');
  const kiteAdCopy = document.getElementById('proxy-platform-kite-ad-copy');
  if (title) title.textContent = meta.title || meta.label;
  if (subtitle) subtitle.textContent = meta.subtitle;
  if (icon) {
    icon.src = meta.icon;
    icon.alt = meta.label;
  }
  if (kiteAd) {
    const showAd = Boolean(meta.kiteAd);
    kiteAd.hidden = !showAd;
    kiteAd.classList.toggle('is-hidden', !showAd);
    kiteAd.dataset.platform = id;
    kiteAd.setAttribute('aria-label', showAd ? `打开 Kite 插件安装选项（${meta.label}）` : 'Kite 插件安装选项');
  }
  if (kiteAdCopy && meta.kiteAd) {
    kiteAdCopy.textContent = meta.kiteAd;
  }
  const kiteModalPlatform = document.getElementById('kite-plugin-platform-label');
  if (kiteModalPlatform) kiteModalPlatform.textContent = meta.label;
}

function currentKitePluginPlatform() {
  const ad = document.getElementById('proxy-platform-kite-ad');
  const fromAd = ad?.dataset?.platform;
  if (fromAd === 'windsurf' || fromAd === 'devin') return fromAd;
  const fromSelect = typeof getTargetIde === 'function' ? getTargetIde() : '';
  return fromSelect === 'devin' ? 'devin' : 'windsurf';
}

function openKitePluginModal() {
  const modal = document.getElementById('kite-plugin-modal');
  const platform = currentKitePluginPlatform();
  const meta = PROXY_PLATFORM_META[platform] || PROXY_PLATFORM_META.windsurf;
  const label = document.getElementById('kite-plugin-platform-label');
  const installBtn = document.getElementById('kite-plugin-install-btn');
  if (label) label.textContent = meta.label;
  if (installBtn) {
    installBtn.disabled = false;
    installBtn.classList.remove('is-loading');
    const title = installBtn.querySelector('strong');
    if (title) title.textContent = '一键安装';
  }
  if (!modal) return;
  modal.classList.add('active');
  document.addEventListener('keydown', closeKitePluginModalOnEsc);
}

function closeKitePluginModal() {
  const modal = document.getElementById('kite-plugin-modal');
  if (modal) modal.classList.remove('active');
  document.removeEventListener('keydown', closeKitePluginModalOnEsc);
}

function closeKitePluginModalOnEsc(event) {
  if (event.key === 'Escape') closeKitePluginModal();
}

async function installKitePlugin() {
  const platform = currentKitePluginPlatform();
  const meta = PROXY_PLATFORM_META[platform] || PROXY_PLATFORM_META.windsurf;
  const installBtn = document.getElementById('kite-plugin-install-btn');
  if (!invoke && !bindTauriBridge()) {
    showCustomAlert('Tauri 通道未就绪，无法执行本机安装命令。请重启 AnyBridge 后再试。', 'Kite 安装失败', 'error');
    return;
  }
  if (installBtn) {
    installBtn.disabled = true;
    installBtn.classList.add('is-loading');
    const title = installBtn.querySelector('strong');
    if (title) title.textContent = '安装中...';
  }
  try {
    if (typeof addLog === 'function') addLog('info', `开始为 ${meta.label} 安装 Kite 插件`);
    const result = await invoke('install_kite_plugin', { target: platform });
    const message = result?.message || `Kite 插件已安装到 ${meta.label}`;
    closeKitePluginModal();
    if (typeof addLog === 'function') addLog('ok', message);
    if (typeof showBottomToast === 'function') showBottomToast(message, 'success', { duration: 3600 });
    showCustomAlert(message, 'Kite 安装完成', 'success');
  } catch (e) {
    const message = String(e?.message || e);
    if (typeof addLog === 'function') addLog('err', `Kite 安装失败: ${message}`);
    showCustomAlert(message, 'Kite 安装失败', 'error');
    if (installBtn) {
      installBtn.disabled = false;
      installBtn.classList.remove('is-loading');
      const title = installBtn.querySelector('strong');
      if (title) title.textContent = '一键安装';
    }
  }
}

function syncPlatformRailForPage(pageId) {
  const pageToPlatform = {
    'platform-cursor': 'cursor',
    'platform-claude-code': 'claude-code',
    'platform-codex': 'codex',
    'platform-codebuddy': 'codebuddy',
    'platform-codebuddy-add': 'codebuddy',
    'platform-opencode': 'opencode',
    'platform-zcode': 'zcode',
    'platform-zcode-add': 'zcode',
    'platform-workbuddy': 'workbuddy',
    'platform-workbuddy-add': 'workbuddy'
  };
  if (pageToPlatform[pageId]) {
    setPlatformRailActive(pageToPlatform[pageId]);
    return;
  }
  if (['platform-proxy', 'models', 'model-slots', 'slot-editor'].includes(pageId)) {
    const target = normalizeProxyPlatform(getTargetIde());
    const select = document.getElementById('targetIde');
    if (select && select.value !== target) select.value = target;
    updateProxyPlatformCopy(target);
    setPlatformRailActive(target);
  }
}

// ═══════ PLATFORM RAIL · DRAG & DROP REORDER ═══════
globalThis.PLATFORM_RAIL_ORDER_KEY = 'anybridge.platformRailOrder';

function getPlatformRailElement() {
  return document.querySelector('.platform-rail');
}

function getPlatformRailItems() {
  const rail = getPlatformRailElement();
  if (!rail) return [];
  return Array.from(rail.querySelectorAll('.platform-rail-item[data-platform-rail]'));
}

function readPlatformRailOrder() {
  try {
    const raw = localStorage.getItem(PLATFORM_RAIL_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : null;
  } catch (_) {
    return null;
  }
}

function writePlatformRailOrder(order) {
  try {
    localStorage.setItem(PLATFORM_RAIL_ORDER_KEY, JSON.stringify(order));
    return true;
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '保存平台栏顺序失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
    return false;
  }
}

function applyPlatformRailOrder(order, { persist = false } = {}) {
  const rail = getPlatformRailElement();
  if (!rail || !Array.isArray(order) || order.length === 0) return;
  const byId = new Map();
  getPlatformRailItems().forEach(item => byId.set(item.dataset.platformRail, item));
  const fragment = document.createDocumentFragment();
  order.forEach(id => {
    const node = byId.get(id);
    if (node) {
      fragment.appendChild(node);
      byId.delete(id);
    }
  });
  // 追加未在保存顺序里的（兜底，避免顺序被裁断）
  byId.forEach(node => fragment.appendChild(node));
  rail.appendChild(fragment);
  if (persist) {
    writePlatformRailOrder(getPlatformRailItems().map(i => i.dataset.platformRail));
  }
}

function persistPlatformRailOrder() {
  writePlatformRailOrder(getPlatformRailItems().map(i => i.dataset.platformRail));
}

function clearPlatformRailDragMarkers(except) {
  getPlatformRailItems().forEach(item => {
    if (item === except) return;
    item.classList.remove('is-drag-over-top', 'is-drag-over-bottom');
  });
}

globalThis.platformRailDragging = null;

function bindPlatformRailDragAndDrop() {
  const rail = getPlatformRailElement();
  if (!rail || rail.dataset.dndBound === '1') return;
  rail.dataset.dndBound = '1';

  // 禁用原生 HTML5 拖拽，改用 pointer 事件实现"手机图标拖动"效果
  getPlatformRailItems().forEach(item => {
    item.draggable = false;
    item.querySelectorAll('.platform-rail-handle').forEach(h => { h.draggable = false; });
  });

  let drag = null;       // { item, clone, started, startX, startY, offsetX, offsetY, width }
  let suppressClick = false;

  const HANDLE_VARS = [
    '--handle-width', '--handle-height', '--handle-justify-self', '--handle-align-self',
    '--handle-opacity', '--handle-opacity-hover', '--handle-dot-radius',
    '--handle-dot-color', '--handle-dot-color-drag', '--handle-dot-color-dark', '--handle-dot-color-drag-dark',
    '--handle-dot-padding-x', '--handle-dot-padding-y', '--handle-dot-col-spacing', '--handle-dot-row-spacing',
    '--handle-shadow-on', '--handle-shadow-color', '--handle-shadow-offset-x', '--handle-shadow-offset-y', '--handle-shadow-blur'
  ];

  function copyHandleVars(target) {
    const cs = getComputedStyle(rail);
    HANDLE_VARS.forEach(v => {
      const val = cs.getPropertyValue(v).trim();
      if (val) target.style.setProperty(v, val);
    });
    // 手柄跟随 rail 当前 opacity（默认 0 = 隐藏，不强制显示）
    target.style.setProperty('--handle-dot-color', cs.getPropertyValue('--handle-dot-color-drag').trim());
    target.style.setProperty('--handle-dot-color-dark', cs.getPropertyValue('--handle-dot-color-drag-dark').trim());
  }

  function findDropTarget(clientY) {
    const items = getPlatformRailItems();
    for (const it of items) {
      if (it === drag.item) continue;
      const r = it.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return { item: it, placeAbove: (clientY - r.top) < r.height / 2 };
      }
    }
    return null;
  }

  // ── pointerdown：记录起点，暂不启动 ──
  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const item = e.target.closest('.platform-rail-item[data-platform-rail]');
    if (!item) return;
    const rect = item.getBoundingClientRect();
    drag = {
      item, started: false,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
    };
  });

  // ── pointermove：超阈值才启动，rAF 节流防抖 ──
  let dragRafPending = false;
  let lastMoveEvent = null;
  let shiftDebounceTimer = null;
  const SHIFT_DEBOUNCE_MS = 70;

  function applyShiftNow() {
    if (!lastMoveEvent) return;
    const drop = findDropTarget(lastMoveEvent.clientY);
    clearPlatformRailDragMarkers();
    clearDragShift();
    if (drop) {
      drop.item.classList.toggle('is-drag-over-top', drop.placeAbove);
      drop.item.classList.toggle('is-drag-over-bottom', !drop.placeAbove);
      applyDragShift(drop.item, drop.placeAbove);
    }
  }

  function scheduleShift() {
    if (shiftDebounceTimer) clearTimeout(shiftDebounceTimer);
    shiftDebounceTimer = setTimeout(() => {
      shiftDebounceTimer = null;
      applyShiftNow();
    }, SHIFT_DEBOUNCE_MS);
  }

  function processDragMove() {
    dragRafPending = false;
    if (!drag || !lastMoveEvent) return;
    const e = lastMoveEvent;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.startX) < 5 && Math.abs(e.clientY - drag.startY) < 5) return;
      drag.started = true;
      // 创建克隆体
      const rect = drag.item.getBoundingClientRect();
      const clone = drag.item.cloneNode(true);
      clone.classList.add('is-drag-clone');
      clone.removeAttribute('onclick');
      clone.removeAttribute('data-platform-rail');
      clone.style.left = rect.left + 'px';
      clone.style.top = rect.top + 'px';
      clone.style.width = drag.width + 'px';
      copyHandleVars(clone);
      document.body.appendChild(clone);
      drag.clone = clone;
      // 隐藏原项
      drag.item.style.opacity = '0';
      platformRailDragging = drag.item;
    }
    // 克隆体跟随鼠标（仅垂直方向，水平锁定在原位）—— 每帧更新，不防抖
    drag.clone.style.top = (e.clientY - drag.offsetY) + 'px';
    // 按钮变动防抖：光标停 70ms 才重排，避免快速移动时抖动
    scheduleShift();
  }

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    lastMoveEvent = e;
    if (dragRafPending) return;
    dragRafPending = true;
    requestAnimationFrame(processDragMove);
  });

  // ── pointerup / pointercancel：归位 ──
  function finishDrag(e, cancelled) {
    if (!drag) return;
    // 清理未触发的 shift 防抖定时器
    if (shiftDebounceTimer) { clearTimeout(shiftDebounceTimer); shiftDebounceTimer = null; }
    if (!drag.started) { drag = null; return; }

    const drop = cancelled ? null : findDropTarget(e.clientY);

    // 移除克隆体
    drag.clone.remove();
    // 恢复原项
    drag.item.style.opacity = '';

    if (drop) {
      const parent = drag.item.parentNode;
      if (drop.placeAbove) parent.insertBefore(drag.item, drop.item);
      else parent.insertBefore(drag.item, drop.item.nextSibling);
      persistPlatformRailOrder();
      if (typeof showBottomToast === 'function') {
        showBottomToast('接入平台顺序已更新', 'success');
      }
    }
    clearPlatformRailDragMarkers();
    clearDragShift();
    platformRailDragging = null;
    suppressClick = true;
    drag = null;
  }
  document.addEventListener('pointerup', (e) => finishDrag(e, false));
  document.addEventListener('pointercancel', (e) => finishDrag(e, true));

  // 拖拽刚结束时吞掉 click，避免触发 onclick 跳转页面
  rail.addEventListener('click', (e) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  }, true);
}

// ── "自然流动"辅助：源位与目标位之间的项上移，目标位之后的项下移 ──
function applyDragShift(targetItem, placeAbove) {
  const items = getPlatformRailItems();
  const targetIndex = items.indexOf(targetItem);
  const sourceIndex = items.indexOf(platformRailDragging);
  if (targetIndex < 0 || sourceIndex < 0) return;

  // 插入位置：落在目标上方 = 插到目标之前，落在下方 = 插到目标之后
  const insertIndex = placeAbove ? targetIndex : targetIndex + 1;

  items.forEach((it, idx) => {
    it.classList.remove('is-drag-shift-up', 'is-drag-shift-down');
    if (it === platformRailDragging) return;

    if (sourceIndex < insertIndex) {
      // 向下拖：源位和目标位之间的项上移补位
      if (idx > sourceIndex && idx < insertIndex) {
        it.classList.add('is-drag-shift-up');
      }
    } else if (sourceIndex > insertIndex) {
      // 向上拖：目标位和源位之间的项下移撑开
      if (idx >= insertIndex && idx < sourceIndex) {
        it.classList.add('is-drag-shift-down');
      }
    }
    // sourceIndex == insertIndex：原位不动，不 shift
  });
}

function clearDragShift() {
  getPlatformRailItems().forEach(it => {
    it.classList.remove('is-drag-shift-up', 'is-drag-shift-down');
  });
}

function initPlatformRailOrder() {
  // 首次进入前先把保存的顺序应用到 DOM
  const stored = readPlatformRailOrder();
  if (stored && stored.length) {
    applyPlatformRailOrder(stored);
  } else {
    // 没有历史顺序时，把当前 DOM 顺序落盘，作为基线
    persistPlatformRailOrder();
  }
  bindPlatformRailDragAndDrop();
}

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
  const activeMount = document.querySelector('#platform-panel-settings .platform-settings-mount.active');
  if (activeMount) {
    const el = activeMount.querySelector('[data-oid="' + id + '"]');
    if (el) return el;
  }
  return document.getElementById(id);
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
      addLog('warn', `全局代理服务正在运行；新的 IDE 选择只影响当前页面的切换按钮`);
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

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g.normalizePlatformSection = normalizePlatformSection;
  g.getPlatformSectionForPage = getPlatformSectionForPage;
  g.setPlatformPanel = setPlatformPanel;
  g.syncPlatformSubtabsForPage = syncPlatformSubtabsForPage;
  g.openPlatformSection = openPlatformSection;
  g.syncPlatformConsoleHead = syncPlatformConsoleHead;
  g.hideAllEditorModals = hideAllEditorModals;
  g.navigateTo = navigateTo;
  g.focusTabByOffset = focusTabByOffset;
  g.focusPlatformSubtabByOffset = focusPlatformSubtabByOffset;
  g.activateSettingsPanel = activateSettingsPanel;
  g.openSettingsPanel = openSettingsPanel;
  g.markOnboardingGuideSeen = markOnboardingGuideSeen;
  g.openOnboardingGuide = openOnboardingGuide;
  g.closeOnboardingGuide = closeOnboardingGuide;
  g.finishOnboardingGuide = finishOnboardingGuide;
  g.closeOnboardingGuideOnEsc = closeOnboardingGuideOnEsc;
  g.maybeShowOnboardingGuide = maybeShowOnboardingGuide;
  g.activateProxyPanel = activateProxyPanel;
  g.openProxyPanel = openProxyPanel;
  g.mountProxyEnhancementPanel = mountProxyEnhancementPanel;
  g.mountProxyStatsAndLogsPanels = mountProxyStatsAndLogsPanels;
  g.activateEnhancementPanel = activateEnhancementPanel;
  g.normalizeProxyPlatform = normalizeProxyPlatform;
  g.setPlatformRailActive = setPlatformRailActive;
  g.updateProxyPlatformCopy = updateProxyPlatformCopy;
  g.currentKitePluginPlatform = currentKitePluginPlatform;
  g.openKitePluginModal = openKitePluginModal;
  g.closeKitePluginModal = closeKitePluginModal;
  g.closeKitePluginModalOnEsc = closeKitePluginModalOnEsc;
  g.installKitePlugin = installKitePlugin;
  g.syncPlatformRailForPage = syncPlatformRailForPage;
  g.getPlatformRailElement = getPlatformRailElement;
  g.getPlatformRailItems = getPlatformRailItems;
  g.readPlatformRailOrder = readPlatformRailOrder;
  g.writePlatformRailOrder = writePlatformRailOrder;
  g.applyPlatformRailOrder = applyPlatformRailOrder;
  g.persistPlatformRailOrder = persistPlatformRailOrder;
  g.clearPlatformRailDragMarkers = clearPlatformRailDragMarkers;
  g.bindPlatformRailDragAndDrop = bindPlatformRailDragAndDrop;
  g.applyDragShift = applyDragShift;
  g.clearDragShift = clearDragShift;
  g.initPlatformRailOrder = initPlatformRailOrder;
  g.mountPlatformOwnedSettings = mountPlatformOwnedSettings;
  g._platformEl = _platformEl;
  g.bindPlatformSettingsNav = bindPlatformSettingsNav;
  g.openProxyPlatform = openProxyPlatform;
  g.openPlaceholderPlatform = openPlaceholderPlatform;
  g.getTargetIde = getTargetIde;
  g.syncCustomSelector = syncCustomSelector;
  g.onTargetIdeChange = onTargetIdeChange;
  g.updateFlowIdeTarget = updateFlowIdeTarget;
})(globalThis);
