// ═══════ TAB NAVIGATION ═══════
const tabs = document.querySelectorAll('.tab-item[data-page], .community-nav-btn[data-page]');
const pages = document.querySelectorAll('.page');

function hideAllEditorModals() {
  ['providerModal', 'slotModal', 'injectedModal', 'failoverModal', 'modelMapSettingsModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('is-open');
  });
}

function navigateTo(pageId) {
  // 切页前先收起所有编辑弹窗，避免弹层残留造成"仪表盘出现模型面板"
  hideAllEditorModals();

  const activeTabPageId = pageId === 'eval-history' ? 'eval' : pageId;
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
    main.classList.toggle('dashboard-active', pageId === 'dashboard');
    main.classList.toggle('logs-active', pageId === 'logs');
  }
  if (pageId === 'eval') {
    renderEvalProviderOptions();
    loadEvalReports();
  }
  if (pageId === 'eval-history') {
    loadEvalReports();
  }
}

function focusTabByOffset(currentTab, offset) {
  const tabList = Array.from(tabs);
  const index = tabList.indexOf(currentTab);
  if (index < 0) return;
  const nextIndex = (index + offset + tabList.length) % tabList.length;
  const nextTab = tabList[nextIndex];
  navigateTo(nextTab.dataset.page);
  nextTab.focus();
}

tabs.forEach(t => {
  t.addEventListener('click', () => navigateTo(t.dataset.page));
  t.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateTo(t.dataset.page);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTabByOffset(t, 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
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

// ═══════ SETTINGS SUBNAV ═══════
function activateSettingsPanel(index) {
  const panelIndex = Number(index) || 0;
  const menuItems = document.querySelectorAll('.settings-menu-item[data-settings-panel]');
  const panels = document.querySelectorAll('.settings-detail > .glass-card');
  menuItems.forEach(item => {
    const isActive = Number(item.dataset.settingsPanel) === panelIndex;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', String(isActive));
  });
  panels.forEach((panel, i) => panel.classList.toggle('active', i === panelIndex));
}

document.querySelectorAll('.settings-menu-item[data-settings-panel]').forEach(item => {
  item.addEventListener('click', () => activateSettingsPanel(item.dataset.settingsPanel));
});
activateSettingsPanel(6);

// ═══════ IDE SELECTOR ═══════
function getTargetIde() {
  const select = document.getElementById('targetIde');
  return select ? select.value : 'windsurf';
}

function getCustomSelectorParts() {
  const container = document.getElementById('customIdeSelector');
  return {
    container,
    trigger: container ? container.querySelector('.custom-select-trigger') : null,
    options: container ? Array.from(container.querySelectorAll('.custom-option-item')) : []
  };
}

function focusCustomOptionAt(index) {
  const { options } = getCustomSelectorParts();
  if (!options.length) return;
  const nextIndex = (index + options.length) % options.length;
  options.forEach(option => { option.tabIndex = -1; });
  options[nextIndex].tabIndex = 0;
  options[nextIndex].focus();
}

function setCustomSelectorOpen(open, focusSelected = false) {
  const { container, trigger, options } = getCustomSelectorParts();
  if (!container || !trigger) return;
  container.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  const selectedIndex = Math.max(0, options.findIndex(option => option.classList.contains('selected')));
  options.forEach((option, index) => { option.tabIndex = open && index === selectedIndex ? 0 : -1; });
  if (open && focusSelected) {
    focusCustomOptionAt(selectedIndex);
  }
}

function toggleCustomSelector(event) {
  if (event) event.stopPropagation();
  const container = document.getElementById('customIdeSelector');
  if (container) {
    setCustomSelectorOpen(!container.classList.contains('open'));
  }
}

function selectCustomOption(val, label, event) {
  if (event) event.stopPropagation();
  const select = document.getElementById('targetIde');
  if (select) {
    select.value = val;
    // 触发原生 change 事件，让原本绑定的 onTargetIdeChange 完美执行
    select.dispatchEvent(new Event('change'));
  }

  // 关闭下拉面板
  setCustomSelectorOpen(false);

  // 同步高亮和触发器文案
  syncCustomSelector();

  const { trigger } = getCustomSelectorParts();
  if (event && event.type === 'keydown' && trigger) trigger.focus();
}

function syncCustomSelector() {
  const val = getTargetIde();
  const labelMap = {
    'windsurf': 'Windsurf',
    'devin': 'Devin',
    'auto': '自动检测'
  };

  const labelEl = document.getElementById('customSelectedLabel');
  if (labelEl) {
    labelEl.textContent = labelMap[val] || val;
  }

  const { container, trigger, options } = getCustomSelectorParts();
  const isOpen = container ? container.classList.contains('open') : false;
  if (trigger) {
    trigger.setAttribute('aria-label', `选择目标 IDE，当前为 ${labelMap[val] || val}`);
  }
  options.forEach(item => {
    const selected = item.getAttribute('data-value') === val;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected && isOpen ? 0 : -1;
  });
}

const customSelectorTrigger = document.querySelector('.custom-select-trigger');
if (customSelectorTrigger) {
  customSelectorTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setCustomSelectorOpen(true, true);
    }
  });
}

document.querySelectorAll('.custom-option-item').forEach((option) => {
  option.addEventListener('keydown', (event) => {
    const { options, trigger } = getCustomSelectorParts();
    const index = options.indexOf(option);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusCustomOptionAt(index + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusCustomOptionAt(index - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusCustomOptionAt(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusCustomOptionAt(options.length - 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setCustomSelectorOpen(false);
      if (trigger) trigger.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectCustomOption(option.dataset.value, option.textContent.trim(), event);
    }
  });
});

// 监听全局点击事件，点击外部时收起下拉框
window.addEventListener('click', () => {
  setCustomSelectorOpen(false);
});

async function onTargetIdeChange() {
  const ide = getTargetIde();

  // 保存配置到 BYOK config
  if (invoke) {
    try {
      const config = await invoke('load_config') || {};
      config.target_ide = ide;
      await invoke('save_config', { values: config });
    } catch (e) {
      console.error('Failed to save target_ide:', e);
    }
  }

  // 如果是自动检测，执行检测
  let displayIde = ide;
  if (ide === 'auto' && invoke) {
    try {
      const detected = await invoke('detect_target_ide');
      if (detected && (detected === 'windsurf' || detected === 'devin')) {
        displayIde = detected;
      }
    } catch (e) {
      console.error('Auto-detect failed:', e);
    }
  }

  // 更新状态文本和 flow 图
  updateFlowIdeTarget(displayIde);
  setStatusPill(proxyRunning);
  const displayLabel = displayIde === 'auto' ? '自动检测' : displayIde.charAt(0).toUpperCase() + displayIde.slice(1);
  addLog('info', `目标 IDE 切换为: ${displayLabel}`);

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

// ═══════ CUSTOM ALERT (替代原生 alert) ═══════
function showCustomAlert(message, title, iconType) {
  title = title || '提示';
  iconType = iconType || 'info'; // info | warn | error | success

  const modal = document.getElementById('custom-alert-modal');
  const titleEl = document.getElementById('custom-alert-title');
  const bodyEl = document.getElementById('custom-alert-body');
  const iconEl = document.getElementById('custom-alert-icon');
  const okBtn = document.getElementById('custom-alert-ok-btn');
  if (!modal || !bodyEl || !okBtn) {
    // 降级为原生 alert
    alert(message);
    return;
  }

  titleEl.textContent = title;
  bodyEl.textContent = message;

  // 根据类型切换图标和颜色
  const iconColorMap = { info: 'var(--accent)', warn: 'var(--accent-warm)', error: 'var(--danger)', success: 'var(--success)' };
  const iconSvgMap = {
    info: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    warn: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    error: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    success: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>'
  };
  iconEl.style.color = iconColorMap[iconType] || iconColorMap.info;
  iconEl.innerHTML = iconSvgMap[iconType] || iconSvgMap.info;

  modal.classList.add('active');

  // 绑定一次性关闭
  const close = () => {
    modal.classList.remove('active');
    okBtn.removeEventListener('click', close);
    modal.removeEventListener('click', overlayClose);
    document.removeEventListener('keydown', escClose);
  };
  okBtn.addEventListener('click', close);

  // 点击遮罩关闭
  const overlayClose = (e) => {
    if (e.target === modal) close();
  };
  modal.addEventListener('click', overlayClose);

  // Esc 关闭
  const escClose = (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) close();
  };
  document.addEventListener('keydown', escClose);
}

// ═══════ CUSTOM CONFIRM (替代原生 confirm，返回 Promise<boolean>) ═══════
function showCustomConfirm(message, title, iconType) {
  title = title || '确认';
  iconType = iconType || 'warn';

  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const leadEl = document.getElementById('modal-lead');
    const btnCancel = document.getElementById('modal-btn-cancel');
    const btnConfirm = document.getElementById('modal-btn-confirm');

    if (!modal || !btnCancel || !btnConfirm) {
      // 降级为原生 confirm
      resolve(confirm(message));
      return;
    }

    if (leadEl) leadEl.textContent = message;

    // 重置 footer 为确认/取消双按钮
    const footer = modal.querySelector('.modal-footer');
    if (footer) {
      btnCancel.style.display = '';
      btnCancel.textContent = '取消';
      btnConfirm.style.display = '';
      btnConfirm.textContent = '确定';
      btnConfirm.style.width = '';
    }

    modal.classList.add('active');

    const cleanup = () => {
      modal.classList.remove('active');
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
    };

    const onConfirm = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(true); };
    const onCancel = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(false); };
    const onOverlay = (e) => { if (e.target === modal) { cleanup(); resolve(false); } };
    const onEsc = (e) => { if (e.key === 'Escape' && modal.classList.contains('active')) { cleanup(); resolve(false); } };

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}
