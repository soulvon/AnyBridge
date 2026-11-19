// shell/navigation.js — 顶栏 Tab 导航、设置模态、新手引导与本地网关子面板挂载
import { showCustomAlert, showBottomToast, showCustomConfirm, showCustomPrompt } from '../ui/feedback.js';

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
  'platform-cursor-add',
  'platform-claude-code',
  'platform-claude-add',
  'platform-claude-desktop',
  'platform-claude-desktop-add',
  'platform-codex',
  'platform-codex-add',
  'platform-antigravity',
  'platform-antigravity-ide',
  'platform-antigravity-add',
  'platform-codebuddy',
  'platform-codebuddy-add',
  'platform-opencode',
  'platform-opencode-add',
  'platform-zcode',
  'platform-zcode-add',
  'platform-workbuddy',
  'platform-workbuddy-add',
  'platform-grok',
  'platform-grok-add',
  'platform-pi',
  'platform-pi-add',
  'platform-hermes',
  'platform-hermes-add',
  'platform-deepseek-harness',
  'platform-deepseek-harness-add'
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
  // 统计已划入网关页 tab；overview 统一跳代理「统计」
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
  if (pageId === 'settings') {
    openSettingsModal();
    return;
  }

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
    'platform-cursor-add': 'models',
    'platform-claude-code': 'models',
    'platform-claude-add': 'models',
    'platform-claude-desktop': 'models',
    'platform-claude-desktop-add': 'models',
    'platform-codex': 'models',
    'platform-codex-add': 'models',
    'platform-antigravity': 'models',
    'platform-antigravity-ide': 'models',
    'platform-antigravity-add': 'models',
    'platform-codebuddy': 'models',
    'platform-codebuddy-add': 'models',
    'platform-opencode': 'models',
    'platform-opencode-add': 'models',
    'platform-zcode': 'models',
    'platform-zcode-add': 'models',
    'platform-workbuddy': 'models',
    'platform-workbuddy-add': 'models',
    'platform-grok': 'models',
    'platform-grok-add': 'models',
    'platform-pi': 'models',
    'platform-pi-add': 'models',
    'platform-hermes': 'models',
    'platform-hermes-add': 'models',
    'platform-deepseek-harness': 'models',
    'platform-deepseek-harness-add': 'models'
  };
  const activeTabPageId = pageId === 'platform-proxy' && activePlatformSection === 'settings'
    ? 'models'
    : editorToTabMap[pageId] || (pageId.startsWith('platform-') ? 'models' : pageId);
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
  if (pageId === 'models' && typeof renderModelMap === 'function') {
    renderModelMap().catch(() => {});
  }
  if (pageId === 'platform-claude-desktop' && typeof loadClaudeDesktopConsole === 'function') {
    loadClaudeDesktopConsole().catch(() => {});
  }
  if (pageId === 'stats' && typeof loadStats === 'function') {
    loadStats();
  }
  if (pageId === 'extensions') {
    if (typeof onExtensionsPageEnter === 'function') onExtensionsPageEnter();
    else if (typeof refreshExtensionStatuses === 'function') refreshExtensionStatuses({ silent: true });
  } else if (typeof onExtensionsPageLeave === 'function') {
    onExtensionsPageLeave();
  }
  // R19/T3 + R22/T4：离开供应商编辑器页即清结果条（回列表/切 tab/进 eval 都走这里；settings 是弹窗早退不算离开）
  if (pageId !== 'provider-editor' && typeof clearEditorResultBar === 'function') {
    clearEditorResultBar('providerEditorTestResult', { force: true });
    clearEditorResultBar('providerFetchResult', { force: true });
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

function openSettingsModal(panelId = 'appearance') {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  activateSettingsPanel(panelId);
  modal.classList.add('active');
  const topbarSettingsBtn = document.getElementById('topbarSettingsBtn');
  if (topbarSettingsBtn) topbarSettingsBtn.classList.add('active');
  document.addEventListener('keydown', closeSettingsModalOnEsc);
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.remove('active');
  const topbarSettingsBtn = document.getElementById('topbarSettingsBtn');
  if (topbarSettingsBtn) topbarSettingsBtn.classList.remove('active');
  document.removeEventListener('keydown', closeSettingsModalOnEsc);
}

function closeSettingsModalOnEsc(event) {
  if (event.key === 'Escape') closeSettingsModal();
}

function openSettingsPanel(panelId) {
  openSettingsModal(panelId);
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
    const isActive = section.dataset.proxySection === target;
    section.classList.toggle('active', isActive);
    section.style.display = isActive ? (target === 'enhancement' ? 'flex' : 'block') : 'none';
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
 * 将全局统计 KPI / 网关日志挂到网关页 stats、logs tab。
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
// 代理控制台 tab 点击由 HTML data-action="activateProxyPanel" 统一派发，不再重复 addEventListener。
mountProxyEnhancementPanel();
mountProxyStatsAndLogsPanels();
document.querySelectorAll('.proxy-enhancement-tab[data-enhancement-panel]').forEach(tab => {
  tab.addEventListener('click', () => activateEnhancementPanel(tab.dataset.enhancementPanel));
});

// ---- P3 globalThis mirror ----
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
  g.openSettingsModal = openSettingsModal;
  g.closeSettingsModal = closeSettingsModal;
  g.openSettingsPanel = openSettingsPanel;
  g.markOnboardingGuideSeen = markOnboardingGuideSeen;
  g.openOnboardingGuide = openOnboardingGuide;
  g.closeOnboardingGuide = closeOnboardingGuide;
  g.finishOnboardingGuide = finishOnboardingGuide;
  g.closeOnboardingGuideOnEsc = closeOnboardingGuideOnEsc;
  g.maybeShowOnboardingGuide = maybeShowOnboardingGuide;
  g.activateProxyPanel = activateProxyPanel;
  g.openProxyPanel = openProxyPanel;
  g.mountProxyStatsAndLogsPanels = mountProxyStatsAndLogsPanels;
  g.mountProxyEnhancementPanel = mountProxyEnhancementPanel;
  g.activateEnhancementPanel = activateEnhancementPanel;
})(globalThis);
