// platforms/platform_add_sort.js — 全平台添加页供应商排序与搜索筛选控制

// 表格行工厂（提前声明，避免 TDZ）
function platformAddProviderSortedList(list = []) {
  if (!Array.isArray(list)) return [];
  const builtinProxies = [];
  const regularProviders = [];
  for (const p of list) {
    if (isBuiltinProxyEntry(p)) {
      builtinProxies.push(p);
    } else {
      regularProviders.push(p);
    }
  }

  // 内置反代工具始终固定排在最前面：
  // AnyBridge 第一，CPA 第二，插件新增的内置反代工具第三（同级按名称正序）
  builtinProxies.sort((a, b) => {
    const rankA = builtinProxySortRank(a);
    const rankB = builtinProxySortRank(b);
    if (rankA !== rankB) return rankA - rankB;
    return comparePlatformAddProvidersByName(a, b);
  });

  // 常规第三方供应商按当前选中的模式排序
  if (platformAddProviderSortMode === 'name-asc') {
    regularProviders.sort(comparePlatformAddProvidersByName);
  } else if (platformAddProviderSortMode === 'name-desc') {
    regularProviders.sort((a, b) => comparePlatformAddProvidersByName(b, a));
  }

  return [...builtinProxies, ...regularProviders];
}

function platformAddProviderSearchHaystack(p) {
  return [
    p?.providerName,
    p?.providerId,
  ].map(x => String(x || '').toLowerCase()).join(' ');
}

function platformAddVisibleProviders(list = [], keyword = '') {
  const source = Array.isArray(list) ? list : [];
  const terms = String(keyword || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length
    ? source.filter(p => {
        const haystack = platformAddProviderSearchHaystack(p);
        return terms.every(term => haystack.includes(term));
      })
    : source;
  return platformAddProviderSortedList(filtered);
}

function renderPlatformAddProviderLists() {
  renderCbAddProviderList();
  renderWbAddProviderList();
  renderZcAddProviderList();
  if (typeof renderPiAddProviderList === 'function') renderPiAddProviderList();
  if (typeof renderHermesAddProviderList === 'function') renderHermesAddProviderList();
  if (typeof renderDshAddProviderList === 'function') renderDshAddProviderList();
  renderGrokAddProviderList();
  renderOpenCodeAddProviderList();
  renderCodexAddProviderList();
  renderClaudeAddProviderList();
  renderCursorAddProviderList();
  renderAntigravityAddProviderList();
  if (typeof renderClaudeDesktopSourceList === 'function') {
    const activeId = document.getElementById('claude-desktop-config-source-id')?.value || '';
    renderClaudeDesktopSourceList(activeId);
  }
}

function setPlatformAddProviderSortMode(mode) {
  const previous = platformAddProviderSortMode;
  platformAddProviderSortMode = normalizePlatformAddProviderSortMode(mode);
  try {
    localStorage.setItem(PLATFORM_ADD_PROVIDER_SORT_STORAGE_KEY, platformAddProviderSortMode);
  } catch (e) {
    platformAddProviderSortMode = previous;
    if (typeof addLog === 'function') addLog('err', '保存添加模型排序偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  renderPlatformAddProviderLists();
}

function syncPlatformAddSortControl(prefix) {
  const label = document.getElementById(`${prefix}AddSortLabel`);
  if (label) label.textContent = platformAddProviderSortLabel(platformAddProviderSortMode);
  const menu = document.getElementById(`${prefix}AddSortMenu`);
  menu?.querySelectorAll('.provider-sort-option').forEach(btn => {
    const selected = btn.dataset.sortMode === platformAddProviderSortMode;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function syncAllPlatformAddSortControls() {
  PLATFORM_ADD_SORT_PREFIXES.forEach(syncPlatformAddSortControl);
}

function setPlatformAddSortMenuOpen(prefix, open) {
  if (open) {
    PLATFORM_ADD_SORT_PREFIXES.forEach(otherPrefix => {
      if (otherPrefix !== prefix) setPlatformAddSortMenuOpen(otherPrefix, false);
    });
    if (typeof closeProviderSortMenu === 'function') closeProviderSortMenu();
  }
  const control = document.getElementById(`${prefix}AddSortControl`);
  const trigger = document.getElementById(`${prefix}AddSortTrigger`);
  if (!control || !trigger) return;
  control.classList.toggle('open', !!open);
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function togglePlatformAddSortMenu(prefix, event) {
  if (event) event.stopPropagation();
  syncPlatformAddSortControl(prefix);
  const control = document.getElementById(`${prefix}AddSortControl`);
  setPlatformAddSortMenuOpen(prefix, !control?.classList.contains('open'));
}

function closePlatformAddSortMenus() {
  PLATFORM_ADD_SORT_PREFIXES.forEach(prefix => setPlatformAddSortMenuOpen(prefix, false));
}

function choosePlatformAddSortMode(prefix, mode) {
  setPlatformAddProviderSortMode(mode);
  closePlatformAddSortMenus();
  document.getElementById(`${prefix}AddSortTrigger`)?.focus();
}

function toggleCbAddSort(event) { togglePlatformAddSortMenu('cb', event); }
function chooseCbAddSortMode(mode) { choosePlatformAddSortMode('cb', mode); }
function toggleWbAddSort(event) { togglePlatformAddSortMenu('wb', event); }
function chooseWbAddSortMode(mode) { choosePlatformAddSortMode('wb', mode); }
function toggleZcAddSort(event) { togglePlatformAddSortMenu('zc', event); }
function chooseZcAddSortMode(mode) { choosePlatformAddSortMode('zc', mode); }
function togglePiAddSort(event) { togglePlatformAddSortMenu('pi', event); }
function choosePiAddSortMode(mode) { choosePlatformAddSortMode('pi', mode); }
function toggleHermesAddSort(event) { togglePlatformAddSortMenu('hermes', event); }
function chooseHermesAddSortMode(mode) { choosePlatformAddSortMode('hermes', mode); }
function toggleDshAddSort(event) { togglePlatformAddSortMenu('dsh', event); }
function chooseDshAddSortMode(mode) { choosePlatformAddSortMode('dsh', mode); }
function toggleGrokAddSort(event) { togglePlatformAddSortMenu('grok', event); }
function chooseGrokAddSortMode(mode) { choosePlatformAddSortMode('grok', mode); }
function toggleOpenCodeAddSort(event) { togglePlatformAddSortMenu('opencode', event); }
function chooseOpenCodeAddSortMode(mode) { choosePlatformAddSortMode('opencode', mode); }
function toggleCodexAddSort(event) { togglePlatformAddSortMenu('codex', event); }
function chooseCodexAddSortMode(mode) { choosePlatformAddSortMode('codex', mode); }
function toggleClaudeAddSort(event) { togglePlatformAddSortMenu('claude', event); }
function chooseClaudeAddSortMode(mode) { choosePlatformAddSortMode('claude', mode); }
function toggleClaudeDesktopAddSort(event) { togglePlatformAddSortMenu('claudeDesktop', event); }
function chooseClaudeDesktopAddSortMode(mode) { choosePlatformAddSortMode('claudeDesktop', mode); }
function toggleAntigravityAddSort(event) { togglePlatformAddSortMenu('antigravity', event); }
function chooseAntigravityAddSortMode(mode) { choosePlatformAddSortMode('antigravity', mode); }

document.addEventListener('click', event => {
  const insideSortControl = PLATFORM_ADD_SORT_PREFIXES.some(prefix => {
    const control = document.getElementById(`${prefix}AddSortControl`);
    return control && control.contains(event.target);
  });
  if (!insideSortControl) closePlatformAddSortMenus();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePlatformAddSortMenus();
});

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.platformAddProviderSortedList = platformAddProviderSortedList;
  g.platformAddProviderSearchHaystack = platformAddProviderSearchHaystack;
  g.platformAddVisibleProviders = platformAddVisibleProviders;
  g.renderPlatformAddProviderLists = renderPlatformAddProviderLists;
  g.setPlatformAddProviderSortMode = setPlatformAddProviderSortMode;
  g.syncPlatformAddSortControl = syncPlatformAddSortControl;
  g.syncAllPlatformAddSortControls = syncAllPlatformAddSortControls;
  g.setPlatformAddSortMenuOpen = setPlatformAddSortMenuOpen;
  g.togglePlatformAddSortMenu = togglePlatformAddSortMenu;
  g.closePlatformAddSortMenus = closePlatformAddSortMenus;
  g.choosePlatformAddSortMode = choosePlatformAddSortMode;
  g.toggleCbAddSort = toggleCbAddSort;
  g.chooseCbAddSortMode = chooseCbAddSortMode;
  g.toggleWbAddSort = toggleWbAddSort;
  g.chooseWbAddSortMode = chooseWbAddSortMode;
  g.toggleZcAddSort = toggleZcAddSort;
  g.chooseZcAddSortMode = chooseZcAddSortMode;
  g.togglePiAddSort = togglePiAddSort;
  g.choosePiAddSortMode = choosePiAddSortMode;
  g.toggleHermesAddSort = toggleHermesAddSort;
  g.chooseHermesAddSortMode = chooseHermesAddSortMode;
  g.toggleDshAddSort = toggleDshAddSort;
  g.chooseDshAddSortMode = chooseDshAddSortMode;
  g.toggleGrokAddSort = toggleGrokAddSort;
  g.chooseGrokAddSortMode = chooseGrokAddSortMode;
  g.toggleOpenCodeAddSort = toggleOpenCodeAddSort;
  g.chooseOpenCodeAddSortMode = chooseOpenCodeAddSortMode;
  g.toggleCodexAddSort = toggleCodexAddSort;
  g.chooseCodexAddSortMode = chooseCodexAddSortMode;
  g.toggleClaudeAddSort = toggleClaudeAddSort;
  g.chooseClaudeAddSortMode = chooseClaudeAddSortMode;
  g.toggleClaudeDesktopAddSort = toggleClaudeDesktopAddSort;
  g.chooseClaudeDesktopAddSortMode = chooseClaudeDesktopAddSortMode;
  g.toggleAntigravityAddSort = toggleAntigravityAddSort;
  g.chooseAntigravityAddSortMode = chooseAntigravityAddSortMode;
})(globalThis);
