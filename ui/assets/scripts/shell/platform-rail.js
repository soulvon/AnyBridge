// shell/platform-rail.js — 平台左侧栏选中同步、本地网关文案与拖拽排序持久化
import { showCustomAlert, showBottomToast } from '../ui/feedback.js';

// ═══════ PLATFORM RAIL ═══════
globalThis.PROXY_PLATFORM_META = {
  windsurf: {
    label: 'Windsurf',
    title: 'Windsurf',
    short: 'Windsurf',
    icon: './assets/icons/platform-windsurf.svg',
    subtitle: '本机网关、MITM 证书、Windsurf 配置和模型路由集中管理。'
  },
  devin: {
    label: 'Devin',
    title: 'Devin',
    short: 'Devin',
    icon: './assets/icons/platform-devin.svg',
    subtitle: '本机网关、MITM 证书、Devin 配置和模型路由集中管理。'
  },
  cursor: {
    label: 'Cursor',
    short: 'Cursor',
    icon: './assets/icons/platform-cursor.svg',
    subtitle: 'Cursor 通过本机 MITM 入口接入内置模型、对话工具流、Background Composer 和会话落盘。'
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
  const _t = (k, p) => (typeof window.t === 'function' ? window.t(k, p) : k);
  const title = document.getElementById('proxy-platform-title');
  const subtitle = document.getElementById('proxy-platform-subtitle');
  const icon = document.getElementById('proxy-platform-icon');
  if (title) title.textContent = _t(meta.title) || meta.label;
  if (subtitle) subtitle.textContent = _t(meta.subtitle);
  if (icon) {
    icon.src = meta.icon;
    icon.alt = meta.label;
  }
  const emptySubtitle = document.getElementById('model-map-empty-subtitle');
  if (emptySubtitle) {
    emptySubtitle.textContent = _t(`添加第一个模型映射，让 ${meta.label || '当前平台'} 使用你指定的 AI 供应商与模型能力。`);
  }
  // Hero 版本行：rail 切换时必须用 rail 的真实目标刷新。
  // 注意不能用 refreshAllHeroVersions 里的 getTargetIde()——那是全局 IDE
  // 选择器的值，不随 rail 变化，会导致 Devin 页显示 Windsurf 的版本。
  // 此处为用户交互路径，55-platforms.js 必然已加载；初始化早期调用有
  // typeof 守卫兜底。
  if (typeof renderHeroVersion === 'function') {
    renderHeroVersion(id, 'proxy-platform-version');
  }
  void refreshProxyLangStatus();
}

function syncPlatformRailForPage(pageId) {
  const agTarget = typeof getAntigravityTarget === 'function'
    ? getAntigravityTarget()
    : (globalThis._currentAntigravityTarget === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity');
  const pageToPlatform = {
    'platform-cursor': 'cursor',
    'platform-cursor-add': 'cursor',
    'platform-claude-code': 'claude-code',
    'platform-claude-add': 'claude-code',
    'platform-claude-desktop': 'claude-desktop',
    'platform-claude-desktop-add': 'claude-desktop',
    'platform-codex': 'codex',
    'platform-codex-add': 'codex',
    'platform-antigravity': agTarget,
    'platform-antigravity-ide': 'antigravity-ide',
    'platform-antigravity-add': agTarget,
    'platform-codebuddy': 'codebuddy',
    'platform-codebuddy-add': 'codebuddy',
    'platform-opencode': 'opencode',
    'platform-opencode-add': 'opencode',
    'platform-zcode': 'zcode',
    'platform-zcode-add': 'zcode',
    'platform-workbuddy': 'workbuddy',
    'platform-workbuddy-add': 'workbuddy',
    'platform-grok': 'grok',
    'platform-grok-add': 'grok',
    'platform-pi': 'pi',
    'platform-pi-add': 'pi',
    'platform-hermes': 'hermes',
    'platform-hermes-add': 'hermes',
    'platform-deepseek-harness': 'deepseek-harness',
    'platform-deepseek-harness-add': 'deepseek-harness'
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

window.addEventListener('byok-language-change', (e) => {
  if (!e?.detail?.previousLanguage) return;
  try {
    const current = typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf';
    updateProxyPlatformCopy(current);
    if (typeof refreshIdeProxyStatus === 'function') {
      refreshIdeProxyStatus(current).catch(() => {});
    }
    if (globalThis.modelMapLoaded && typeof syncModelMapSelectionState === 'function') {
      syncModelMapSelectionState();
    }
  } catch (err) {
    console.warn('[byok-language-change] handler error:', err);
  }
});

// ═══════ PLATFORM RAIL · DRAG & DROP REORDER ═══════
globalThis.PLATFORM_RAIL_ORDER_KEY = 'anybridge.platformRailOrder';
globalThis.DEFAULT_PLATFORM_RAIL_ORDER = [
  'devin',
  'windsurf',
  'cursor',
  'antigravity',
  'antigravity-ide',
  'codex',
  'claude-code',
  'claude-desktop',
  'codebuddy',
  'workbuddy',
  'grok',
  'zcode',
  'opencode',
  'pi',
  'hermes',
  'deepseek-harness'
];

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
    if (!Array.isArray(parsed)) return null;
    let filtered = parsed.filter(id => typeof id === 'string');
    if (!filtered.includes('claude-desktop')) {
      const ccIdx = filtered.indexOf('claude-code');
      if (ccIdx !== -1) {
        filtered.splice(ccIdx + 1, 0, 'claude-desktop');
      } else {
        filtered.push('claude-desktop');
      }
      writePlatformRailOrder(filtered);
    } else {
      const cdIdx = filtered.indexOf('claude-desktop');
      const ccIdx = filtered.indexOf('claude-code');
      if (ccIdx !== -1 && cdIdx !== -1 && cdIdx !== ccIdx + 1) {
        filtered.splice(cdIdx, 1);
        filtered.splice(ccIdx + 1, 0, 'claude-desktop');
        writePlatformRailOrder(filtered);
      }
    }
    if (!filtered.includes('antigravity-ide')) {
      const agIdx = filtered.indexOf('antigravity');
      if (agIdx !== -1) {
        filtered.splice(agIdx + 1, 0, 'antigravity-ide');
      } else {
        filtered.push('antigravity-ide');
      }
      writePlatformRailOrder(filtered);
    } else {
      const ideIdx = filtered.indexOf('antigravity-ide');
      const agIdx = filtered.indexOf('antigravity');
      if (agIdx !== -1 && ideIdx !== -1 && ideIdx !== agIdx + 1) {
        filtered.splice(ideIdx, 1);
        filtered.splice(agIdx + 1, 0, 'antigravity-ide');
        writePlatformRailOrder(filtered);
      }
    }
    if (!filtered.includes('pi')) {
      filtered.push('pi');
      writePlatformRailOrder(filtered);
    }
    for (const platformId of ['hermes', 'deepseek-harness']) {
      if (!filtered.includes(platformId)) {
        filtered.push(platformId);
        writePlatformRailOrder(filtered);
      }
    }
    const OLD_DEFAULTS = [
      '["devin","windsurf","codex","cursor","claude-code","codebuddy","workbuddy","opencode","zcode","grok"]',
      '["windsurf","devin","codex","claude-code","cursor","codebuddy","workbuddy","zcode","opencode","grok"]'
    ];
    if (OLD_DEFAULTS.includes(JSON.stringify(filtered))) {
      writePlatformRailOrder(DEFAULT_PLATFORM_RAIL_ORDER);
      return DEFAULT_PLATFORM_RAIL_ORDER;
    }
    return filtered;
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

function clearDragShift() {
  getPlatformRailItems().forEach(it => {
    it.classList.remove('is-drag-shift-up', 'is-drag-shift-down');
  });
}

function applyDragShift(targetItem, placeAbove) {
  // 保持向后兼容镜像导出
}

function bindPlatformRailDragAndDrop() {
  const rail = getPlatformRailElement();
  if (!rail || rail.dataset.dndBound === '1') return;
  rail.dataset.dndBound = '1';

  // 禁用原生 HTML5 拖拽，改用 pointer 事件
  getPlatformRailItems().forEach(item => {
    item.draggable = false;
    item.querySelectorAll('.platform-rail-handle').forEach(h => { h.draggable = false; });
  });

  // 阻止原生拖拽默认行为
  rail.addEventListener('dragstart', (e) => e.preventDefault());

  const sidebar = rail.closest('.app-sidebar') || rail.parentElement;

  let drag = null;
  let suppressClick = false;
  let autoScrollRaf = null;

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
    target.style.setProperty('--handle-dot-color', cs.getPropertyValue('--handle-dot-color-drag').trim());
    target.style.setProperty('--handle-dot-color-dark', cs.getPropertyValue('--handle-dot-color-drag-dark').trim());
  }

  function startDrag(e) {
    drag.started = true;
    const allItems = getPlatformRailItems();
    drag.items = allItems;
    drag.sourceIndex = allItems.indexOf(drag.item);
    drag.targetIndex = drag.sourceIndex;

    const itemRect = drag.item.getBoundingClientRect();
    const mb = parseFloat(getComputedStyle(drag.item).marginBottom) || 7;
    drag.shiftDistance = itemRect.height + mb;
    rail.style.setProperty('--drag-shift-distance', `${drag.shiftDistance}px`);

    // 记录在静态无位移状态下各项相对于 rail 顶部的原始中心 Y
    const railRect = rail.getBoundingClientRect();
    drag.itemCenters = allItems.map(it => {
      const r = it.getBoundingClientRect();
      return (r.top - railRect.top) + r.height / 2;
    });

    // 创建克隆体
    const clone = drag.item.cloneNode(true);
    clone.classList.add('is-drag-clone');
    clone.removeAttribute('onclick');
    clone.removeAttribute('data-platform-rail');
    clone.style.left = itemRect.left + 'px';
    clone.style.top = (e.clientY - drag.offsetY) + 'px';
    clone.style.width = drag.width + 'px';
    copyHandleVars(clone);
    document.body.appendChild(clone);
    drag.clone = clone;

    // 隐藏原项
    drag.item.style.opacity = '0';
    platformRailDragging = drag.item;
    document.body.classList.add('is-platform-rail-dragging');

    try {
      if (drag.item.setPointerCapture && drag.pointerId !== undefined) {
        drag.item.setPointerCapture(drag.pointerId);
      }
    } catch (_) {}
  }

  function updateShifts(targetIndex) {
    const { items, sourceIndex } = drag;
    if (sourceIndex < 0) return;

    items.forEach((it, idx) => {
      it.classList.remove('is-drag-shift-up', 'is-drag-shift-down');
      if (it === drag.item) return;

      if (sourceIndex < targetIndex) {
        // 向下拖动：原位到目标位之间的项向上移补位
        if (idx > sourceIndex && idx <= targetIndex) {
          it.classList.add('is-drag-shift-up');
        }
      } else if (sourceIndex > targetIndex) {
        // 向上拖动：目标位到原位之间的项向下移腾位
        if (idx >= targetIndex && idx < sourceIndex) {
          it.classList.add('is-drag-shift-down');
        }
      }
    });
  }

  function computeTargetIndex(cursorRailY) {
    const { sourceIndex, itemCenters } = drag;
    let index = 0;
    for (let i = 0; i < itemCenters.length; i++) {
      if (i === sourceIndex) continue;
      if (cursorRailY > itemCenters[i]) {
        index++;
      }
    }
    return Math.max(0, Math.min(index, itemCenters.length - 1));
  }

  function handleAutoScroll(clientY) {
    if (!sidebar) return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const threshold = 45;
    const maxSpeed = 10;

    let speed = 0;
    if (clientY < sidebarRect.top + threshold) {
      const ratio = 1 - Math.max(0, clientY - sidebarRect.top) / threshold;
      speed = -Math.round(ratio * maxSpeed);
    } else if (clientY > sidebarRect.bottom - threshold) {
      const ratio = 1 - Math.max(0, sidebarRect.bottom - clientY) / threshold;
      speed = Math.round(ratio * maxSpeed);
    }

    if (speed !== 0) {
      if (!autoScrollRaf) {
        const scrollStep = () => {
          if (!drag || !drag.started) {
            autoScrollRaf = null;
            return;
          }
          sidebar.scrollTop += speed;
          if (lastMoveEvent) processDragMove(lastMoveEvent);
          autoScrollRaf = requestAnimationFrame(scrollStep);
        };
        autoScrollRaf = requestAnimationFrame(scrollStep);
      }
    } else if (autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  }

  let dragRafPending = false;
  let lastMoveEvent = null;

  function processDragMove(e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.startX) < 4 && Math.abs(e.clientY - drag.startY) < 4) return;
      startDrag(e);
    }

    const railRect = rail.getBoundingClientRect();
    drag.clone.style.left = railRect.left + 'px';
    drag.clone.style.top = (e.clientY - drag.offsetY) + 'px';

    const cursorRailY = e.clientY - railRect.top;
    const newTargetIndex = computeTargetIndex(cursorRailY);

    if (newTargetIndex !== drag.targetIndex) {
      drag.targetIndex = newTargetIndex;
      updateShifts(newTargetIndex);
    }

    handleAutoScroll(e.clientY);
  }

  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const item = e.target.closest('.platform-rail-item[data-platform-rail]');
    if (!item) return;
    const rect = item.getBoundingClientRect();
    drag = {
      item,
      pointerId: e.pointerId,
      started: false,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      items: [],
      sourceIndex: -1,
      targetIndex: -1,
      shiftDistance: 53,
      itemCenters: [],
    };
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    lastMoveEvent = e;
    if (dragRafPending) return;
    dragRafPending = true;
    requestAnimationFrame(() => {
      dragRafPending = false;
      if (lastMoveEvent) processDragMove(lastMoveEvent);
    });
  });

  function finishDrag(e, cancelled) {
    if (!drag) return;
    if (autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }

    const currentDrag = drag;
    drag = null;
    document.body.classList.remove('is-platform-rail-dragging');

    if (!currentDrag.started) return;

    try {
      if (currentDrag.item.releasePointerCapture && currentDrag.pointerId !== undefined) {
        currentDrag.item.releasePointerCapture(currentDrag.pointerId);
      }
    } catch (_) {}

    if (currentDrag.clone) currentDrag.clone.remove();
    currentDrag.item.style.opacity = '';

    const { items, sourceIndex, targetIndex } = currentDrag;

    // 关键优化：切换 DOM 前临时关闭过渡，避免 class 清除与 DOM 移动时反向闪烁
    rail.classList.add('no-transition');
    clearDragShift();
    rail.style.removeProperty('--drag-shift-distance');
    platformRailDragging = null;
    suppressClick = true;

    if (!cancelled && targetIndex >= 0 && targetIndex !== sourceIndex && items[targetIndex]) {
      const parent = currentDrag.item.parentNode;
      if (targetIndex > sourceIndex) {
        parent.insertBefore(currentDrag.item, items[targetIndex].nextSibling);
      } else {
        parent.insertBefore(currentDrag.item, items[targetIndex]);
      }
      persistPlatformRailOrder();
      if (typeof showBottomToast === 'function') {
        showBottomToast('接入平台顺序已更新', 'success');
      }
    }

    void rail.offsetHeight; // 强制回流
    rail.classList.remove('no-transition');
  }

  document.addEventListener('pointerup', (e) => finishDrag(e, false));
  document.addEventListener('pointercancel', (e) => finishDrag(e, true));

  rail.addEventListener('click', (e) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  }, true);
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

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.normalizeProxyPlatform = normalizeProxyPlatform;
  g.setPlatformRailActive = setPlatformRailActive;
  g.updateProxyPlatformCopy = updateProxyPlatformCopy;
  g.syncPlatformRailForPage = syncPlatformRailForPage;
  g.getPlatformRailElement = getPlatformRailElement;
  g.getPlatformRailItems = getPlatformRailItems;
  g.readPlatformRailOrder = readPlatformRailOrder;
  g.writePlatformRailOrder = writePlatformRailOrder;
  g.applyPlatformRailOrder = applyPlatformRailOrder;
  g.persistPlatformRailOrder = persistPlatformRailOrder;
  g.clearPlatformRailDragMarkers = clearPlatformRailDragMarkers;
  g.clearDragShift = clearDragShift;
  g.applyDragShift = applyDragShift;
  g.bindPlatformRailDragAndDrop = bindPlatformRailDragAndDrop;
  g.initPlatformRailOrder = initPlatformRailOrder;
})(globalThis);
