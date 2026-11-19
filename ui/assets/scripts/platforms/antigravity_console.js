// platforms/antigravity_console.js — split from 55-platforms.js
// ═══════ Antigravity 配置与模型管理 ═══════

globalThis.antigravityProviderModels = [];
globalThis.antigravityAddSelectedProvider = null;
globalThis.antigravityAddSearchKw = '';
globalThis._antigravitySearchKeyword = '';
globalThis._antigravitySelectedSet = new Set();
globalThis.antigravityConfigEditorMode = 'edit';
globalThis._currentAntigravityTarget = 'antigravity';

function getAntigravityTarget() {
  return globalThis._currentAntigravityTarget === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
}

function switchAntigravityClientTarget(target) {
  globalThis._currentAntigravityTarget = target === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
  if (typeof setPlatformRailActive === 'function') {
    setPlatformRailActive(globalThis._currentAntigravityTarget);
  }
  antigravityRefreshConsole({ silent: true });
  // 异步向后端核对真实磁盘状态（外部变动会让 detect_fingerprint 失效缓存并重扫），防止缓存误报「已接入」
  if (typeof refreshPlatforms === 'function') {
    const _t = (k) => (typeof window?.t === 'function' ? window.t(k) : k);
    refreshPlatforms({ silent: true, reloadProviders: true }).catch(e => {
      if (typeof addLog === 'function') addLog('err', _t('ag.consoleRefreshFailedPrefix') + (e?.message || e));
    });
  }
}
globalThis.switchAntigravityClientTarget = switchAntigravityClientTarget;

function renderAntigravityPageStatus(info) {
  if (info?.id && info.id !== getAntigravityTarget()) return;
  antigravityRefreshConsole({ silent: true });
}

function antigravityPageRoot() {
  return document.getElementById('page-platform-antigravity');
}

// ═══════ Antigravity 运行模式切换（纯 BYOK vs 混合模式） ═══════
function getAntigravityCurrentMode() {
  return (providerStore && providerStore.antigravityMode === 'hybrid') ? 'hybrid' : 'pure';
}

function syncAntigravityModeUi(mode) {
  const currentMode = mode || getAntigravityCurrentMode();
  const btns = document.querySelectorAll('.antigravity-mode-seg-btn');
  btns.forEach(btn => {
    const btnMode = btn.dataset.mode;
    btn.classList.toggle('is-active', btnMode === currentMode);
  });
}

async function selectAntigravityMode(mode) {
  const targetMode = mode === 'hybrid' ? 'hybrid' : 'pure';
  if (!providerStore) providerStore = createEmptyProviderStore();
  syncAntigravityModeUi(targetMode);
  if (providerStore.antigravityMode === targetMode) return;

  const ok = await mutateProviderStore(
    store => {
      store.antigravityMode = targetMode;
    },
    {
      silent: true,
      onRollback: err => {
        syncAntigravityModeUi(getAntigravityCurrentMode());
        if (typeof showBottomToast === 'function') {
          showBottomToast('保存模式失败: ' + (err?.message || err), 'error');
        }
      },
    }
  );
  if (!ok) return;

  const modeDesc = targetMode === 'hybrid' ? '混合模式（保留官方 + 自建）' : '纯 BYOK 模式（免登谷歌，纯走自建）';
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已切换为${modeDesc}`, 'success');
  }
  if (typeof addLog === 'function') {
    addLog('info', `Antigravity 运行模式已切换为：${targetMode}`);
  }
}

async function antigravityRefreshConsole(options = {}) {
  const root = antigravityPageRoot();
  if (!root) return;

  syncAntigravityModeUi();

  const target = getAntigravityTarget();
  const isIde = target === 'antigravity-ide';
  const info = platformInfoOf(target);
  const managed = !!info?.managedByAnyBridge;

  // 1. 更新头部图标、标题与副标题
  const iconImg = document.getElementById('antigravity-platform-icon');
  const titleEl = document.getElementById('antigravity-platform-title');
  const subtitleEl = document.getElementById('antigravity-platform-subtitle');
  if (iconImg) {
    iconImg.src = isIde ? './assets/icons/platform-antigravity-ide.png' : './assets/icons/platform-antigravity-hub.png';
    iconImg.alt = isIde ? 'Antigravity IDE' : 'Antigravity';
  }
  if (titleEl) {
    titleEl.textContent = isIde ? 'Antigravity IDE' : 'Antigravity';
  }
  if (subtitleEl) {
    subtitleEl.textContent = isIde
      ? 'Google 编程 IDE · 管理端点重定向与模型映射'
      : 'Google 桌面 Agent · 管理端点重定向与模型映射';
  }
  // 版本行跟随当前客户端（Hub ⇄ IDE）——两者版本号不同，切换时必须重渲
  if (typeof renderHeroVersion === 'function') {
    renderHeroVersion(target, 'antigravity-platform-version');
  }

  // 2. 更新顶部接入状态与按钮 (完全对齐 Windsurf / Cursor 统一接入规范)
  const mainBtn = document.getElementById('antigravity-main-btn');
  const mainBtnText = document.getElementById('antigravity-main-btn-text');
  const mainBtnIcon = mainBtn?.querySelector('.proxy-btn-icon');
  const restoreBtn = document.getElementById('antigravityRestoreBtn');
  const clientName = isIde ? 'Antigravity IDE' : 'Antigravity';

  if (mainBtn && mainBtnText) {
    mainBtn.classList.add('platform-proxy-primary');
    mainBtn.classList.remove('platform-proxy-active');
    const _t = (k, p) => (typeof window.t === 'function' ? window.t(k, p) : k);
    if (managed) {
      mainBtn.classList.add('is-connected');
      if (mainBtnIcon) {
        mainBtnIcon.innerHTML = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>';
      }
      mainBtnText.textContent = _t('已接入');
      mainBtn.setAttribute('aria-label', `${clientName} ${_t('已接入')}`);
    } else {
      mainBtn.classList.remove('is-connected');
      if (mainBtnIcon) {
        mainBtnIcon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
      }
      mainBtnText.textContent = _t('一键接入');
      mainBtn.setAttribute('aria-label', `${clientName} ${_t('一键接入')}`);
    }
  }

  if (restoreBtn) {
    restoreBtn.disabled = !managed;
    restoreBtn.classList.toggle('is-danger', managed);
    restoreBtn.setAttribute('aria-label', managed ? `停止 ${clientName} 接入 AnyBridge` : `${clientName} 当前未接入`);
  }

  bindRevealPathLabel('antigravity-config-path-label', info?.configPath || (isIde ? 'Antigravity IDE/User/settings.json' : 'Antigravity/User/settings.json'));

  // 「查看配置」按钮的 data-arg 跟随当前客户端（Hub / IDE），否则会读错平台的配置
  const configViewBtn = document.getElementById('antigravity-config-view-btn');
  if (configViewBtn) {
    configViewBtn.dataset.arg = isIde ? 'antigravity-ide' : 'antigravity';
  }

  // 4. 清理不存在的选中项
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const validIds = new Set(configs.map(c => c.id));
  _antigravitySelectedSet = new Set(Array.from(_antigravitySelectedSet).filter(id => validIds.has(id)));

  // 5. 渲染数据表格
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
  void refreshAntigravityLangStatus();
}

/** 按钮动作：显式刷新 Antigravity / IDE 真实状态与模型列表（带 spinner 反馈与超时保护）。 */
async function antigravityRefreshConsoleAction(triggerEl) {
  if (antigravityRefreshConsoleAction._busy) return;
  const _t = (k) => (typeof window?.t === 'function' ? window.t(k) : k);
  const refreshBtn = document.getElementById('antigravityRefreshBtn');
  const modelsBtn = document.getElementById('antigravityRefreshModelsBtn')
    || document.querySelector('#page-platform-antigravity .platform-model-btn-icon[aria-label="刷新模型列表"]');
  const activeBtn = (triggerEl && typeof triggerEl.querySelectorAll === 'function' ? triggerEl : null) || refreshBtn;
  const isIconBtn = !!(activeBtn && activeBtn.classList?.contains('platform-model-btn-icon'));

  antigravityRefreshConsoleAction._busy = true;
  if (refreshBtn && refreshBtn !== activeBtn) refreshBtn.disabled = true;
  if (modelsBtn && modelsBtn !== activeBtn) modelsBtn.disabled = true;
  if (activeBtn) {
    if (isIconBtn) {
      if (activeBtn.dataset.prevHtml == null) activeBtn.dataset.prevHtml = activeBtn.innerHTML;
      activeBtn.disabled = true;
      activeBtn.innerHTML = spinnerHtml(14);
    } else {
      setLoading(activeBtn, _t('ag.refreshing'));
    }
  }

  let timeoutId = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(_t('ag.refreshTimeout'))), 15000);
    });
    await Promise.race([
      (async () => {
        await refreshPlatforms({
          silent: false,
          skipOverviewBtn: true,
          reloadProviders: true,
          force: true,
          throwOnError: true,
        });
        await antigravityRefreshConsole({ silent: true });
      })(),
      timeoutPromise,
    ]);
    if (typeof showBottomToast === 'function') {
      showBottomToast(_t('ag.refreshed'), 'success');
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (typeof addLog === 'function') addLog('err', _t('ag.refreshFailedPrefix') + msg);
    if (typeof showBottomToast === 'function') {
      showBottomToast(_t('ag.refreshFailedPrefix') + msg, 'error');
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    antigravityRefreshConsoleAction._busy = false;
    if (activeBtn) {
      if (isIconBtn) {
        activeBtn.disabled = false;
        if (activeBtn.dataset.prevHtml != null) {
          activeBtn.innerHTML = activeBtn.dataset.prevHtml;
          delete activeBtn.dataset.prevHtml;
        }
      } else {
        clearLoading(activeBtn);
      }
    }
    if (refreshBtn && refreshBtn !== activeBtn) refreshBtn.disabled = false;
    if (modelsBtn && modelsBtn !== activeBtn) modelsBtn.disabled = false;
  }
}

function antigravityGetFilteredList() {
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const kw = (_antigravitySearchKeyword || '').trim().toLowerCase();
  if (!kw) return configs;
  return configs.filter(item => {
    const view = typeof resolveAntigravityConfigView === 'function' ? resolveAntigravityConfigView(item) : item;
    return [
      item.name,
      item.id,
      item.defaultModel,
      view.sourceProviderName,
      view.apiFormat,
      view.apiHost,
      view.apiPath,
    ].some(v => String(v || '').toLowerCase().includes(kw));
  });
}

function antigravityRenderTableRows() {
  const tbody = document.getElementById('antigravityModelTableBody');
  const empty = document.getElementById('antigravity-model-empty');
  const table = document.getElementById('antigravity-model-table');
  const countPill = document.getElementById('antigravity-model-count');
  if (!tbody) return;

  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  if (countPill) countPill.textContent = `共 ${configs.length} 个`;

  if (configs.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';

  const list = antigravityGetFilteredList();
  const kw = (_antigravitySearchKeyword || '').trim();

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 36px 0;">
          未找到匹配「${platformEsc(kw)}」的 Antigravity 模型
        </td>
      </tr>
    `;
    return;
  }

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  let html = '';
  list.forEach(item => {
    const view = typeof resolveAntigravityConfigView === 'function' ? resolveAntigravityConfigView(item) : item;
    const isChecked = _antigravitySelectedSet.has(item.id);
    const displayName = (item.name || item.defaultModel || item.id).trim();
    const exposedModel = (item.defaultModel || item.id).trim();
    const providerName = (view.sourceProviderName || item.name || '自定义供应商').trim();
    const isEnabled = item.enabled !== false && item.injectModels !== false;
    const isVisionEnabled = item.useThirdPartyVision === true;
    const protocol = (view.apiFormat || 'openai').toUpperCase();

    const iconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(exposedModel, { size: 20 })
      : `<span style="color:var(--accent);">✦</span>`;

    const visionTitle = !hasVisionModels
      ? '请先在「网关增强」中配置图片理解模型'
      : (isVisionEnabled ? '已启用第三方图片理解（点击关闭）' : '启用后图片将使用第三方模型理解（点击启用）');

    html += `
      <tr class="${isChecked ? 'cb-model-row-selected is-selected' : ''}" data-config-id="${platformEsc(item.id)}" style="min-height: 52px;">
        <td class="cb-select-cell" style="text-align: center; padding-left: 14px;">
          <label class="provider-select-check provider-select-check-table" data-stop data-action="__noop">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="antigravityToggleRowSelect('${platformEsc(item.id)}', this.checked)">
            <span></span>
          </label>
        </td>
        <td class="display-name-cell">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--bg-input);border:1px solid var(--border);flex:0 0 24px;">
              ${iconHtml}
            </div>
            <div style="min-width:0;flex:1;">
              <strong style="font-weight:750;color:var(--text-primary);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${platformEsc(displayName)}">${platformEsc(displayName)}</strong>
            </div>
          </div>
        </td>
        <td>
          <code style="font-size:12px;color:var(--text-secondary);background:var(--bg-input);padding:2px 6px;border-radius:4px;border:1px solid var(--border);">${platformEsc(exposedModel)}</code>
        </td>
        <td>
          <span style="font-size:12px;color:var(--text-primary);font-weight:600;">${platformEsc(providerName)}</span>
        </td>
        <td>
          <span class="platform-badge" style="font-size:12px;padding:2px 7px;background:var(--bg-input);border:1px solid var(--border);border-radius:5px;">${platformEsc(protocol)}</span>
        </td>
        <td>
          <div class="model-map-actions">
            <button class="btn-icon model-map-action-btn" type="button" title="编辑模型" aria-label="编辑模型" onclick="editAntigravityProviderConfig('${platformEsc(item.id)}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" type="button" title="从 Antigravity 移除" aria-label="从 Antigravity 移除" onclick="deleteAntigravityProviderConfig('${platformEsc(item.id)}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${platformEsc(visionTitle)}">
            <input type="checkbox" ${isVisionEnabled ? 'checked' : ''} onchange="antigravityToggleThirdPartyVision('${platformEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${isEnabled ? '已向 Antigravity 暴露（点击停用）' : '已停用（点击启用）'}">
            <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="antigravityToggleModelEnabled('${platformEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.getAntigravityTarget = getAntigravityTarget;
  g.switchAntigravityClientTarget = switchAntigravityClientTarget;
  g.renderAntigravityPageStatus = renderAntigravityPageStatus;
  g.antigravityPageRoot = antigravityPageRoot;
  g.getAntigravityCurrentMode = getAntigravityCurrentMode;
  g.syncAntigravityModeUi = syncAntigravityModeUi;
  g.selectAntigravityMode = selectAntigravityMode;
  g.antigravityRefreshConsole = antigravityRefreshConsole;
  g.antigravityRefreshConsoleAction = antigravityRefreshConsoleAction;
  g.antigravityGetFilteredList = antigravityGetFilteredList;
  g.antigravityRenderTableRows = antigravityRenderTableRows;
})(globalThis);
