// providers-eval/provider-import-apply.js — 导入候选勾选、冲突检查与批量写入
import { escAttr, escapeHtml } from '../ui/dom.js';

async function cancelProviderImportScan() {
  if (!invoke || !providerImportScanRunning) return;
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  setLoading(btn, '取消中…');
  setLoading(confirmBtn, '取消中…');
  try {
    await invoke('cancel_provider_import_scan');
  } catch (e) {
    clearLoading(btn);
    clearLoading(confirmBtn);
    addLog('err', '取消本地扫描失败: ' + e);
  }
}

function finishProviderImportScanUi() {
  const list = providerImportListSurface();
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  if (list) list.classList.remove('is-scanning');
  if (confirmBtn && confirmBtn.dataset.prevHtml !== undefined) {
    clearLoading(confirmBtn);
  }
  if (btn) {
    if (btn.dataset.prevHtml !== undefined) clearLoading(btn);
    btn.disabled = false;
    btn.textContent = providerImportHasScanned ? '重新扫描' : '开始扫描';
  }
  if (selectAll) selectAll.disabled = providerImportCandidates.filter(c => providerImportCandidateStatus(c).selectable).length === 0;
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (clearBtn) clearBtn.disabled = providerImportCandidates.length === 0;
  setProviderImportSourceInputsDisabled(false);
  syncProviderImportSelectionState();
  syncProviderImportSourceState();
  renderProviderImportSourceStatus();
  renderProviderImportResultsSub();
  updateProviderImportPrimaryState();
}

function renderProviderImportNotices(notices) {
  const box = document.getElementById('provider-import-notices');
  if (!box) return;
  const clean = (notices || []).map(x => String(x || '').trim()).filter(Boolean);
  box.classList.toggle('has-items', clean.length > 0);
  box.innerHTML = clean.map(n => `<div class="provider-import-notice">${escAttr(n)}</div>`).join('');
}

function renderProviderImportResultsSub() {
  const box = document.getElementById('provider-import-results-sub');
  if (!box) return;
  if (providerImportScanRunning) {
    box.textContent = '扫描过程中会逐步追加候选项';
    return;
  }
  const counts = providerImportStatusCounts();
  box.textContent = providerImportCandidates.length
    ? `${providerImportCandidates.length} 个候选 · ${counts.ready || 0} 可导入 · ${counts.duplicate || 0} 已存在`
    : '扫描后在这里审核候选项';
}

function providerImportScanProgressHtml(options = {}) {
  const { inline = false } = options;
  const states = PROVIDER_IMPORT_SOURCE_OPTIONS.map(source => providerImportSourceStates[source.key] || {
    key: source.key,
    label: source.label,
    selected: providerImportSelectedSourceKeys().includes(source.key),
    status: providerImportSelectedSourceKeys().includes(source.key) ? 'queued' : 'off',
    found: 0,
    message: '',
  });
  const selectedStates = states.filter(state => state.selected);
  const activeState = selectedStates.find(state => state.status === 'scanning')
    || selectedStates.find(state => state.status === 'queued')
    || selectedStates[0]
    || null;
  const finished = selectedStates.filter(state => ['found', 'empty', 'error', 'cancelled'].includes(state.status)).length;
  const total = selectedStates.length;
  const found = providerImportCandidates.length;
  const rows = selectedStates.map(state => {
    const title = state.message || providerImportSourceStatusText(state);
    return `
      <div class="provider-import-scan-log-row ${escAttr(state.status)}">
        <span class="provider-import-scan-log-dot" aria-hidden="true"></span>
        <span class="provider-import-scan-log-name">${escAttr(state.label)}</span>
        <span class="provider-import-scan-log-text" title="${escAttr(title)}">${escAttr(providerImportSourceStatusText(state))}</span>
      </div>`;
  }).join('');
  const loadingLines = [0, 1, 2, 3, 4].map((_, index) => `
    <div class="provider-import-loading-row" style="--row:${index}">
      <span class="provider-import-loading-check"></span>
      <span class="provider-import-loading-main"></span>
      <span class="provider-import-loading-meta"></span>
      <span class="provider-import-loading-state"></span>
    </div>
  `).join('');

  return `
    <div class="provider-import-scan-progress ${inline ? 'inline' : ''}" role="status" aria-live="polite">
      <div class="provider-import-scan-progress-head">
        <div class="provider-import-scan-icon is-running">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-3.2-6.9"></path>
            <path d="M21 3v6h-6"></path>
          </svg>
        </div>
        <div class="provider-import-scan-progress-copy">
          <div class="provider-import-scan-title">${escAttr(activeState ? `正在扫描 ${activeState.label}` : '正在扫描本机配置')}</div>
          <div class="provider-import-scan-desc">已完成 ${finished} / ${total || 0} 个来源${found ? ` · 已发现 ${found} 个候选` : ' · 正在等待候选结果'}</div>
        </div>
      </div>
      <div class="provider-import-scan-log">${rows}</div>
      ${inline ? '' : `<div class="provider-import-loading-lines" aria-hidden="true">${loadingLines}</div>`}
    </div>`;
}

function renderProviderImportCandidates() {
  const list = providerImportListSurface();
  const summary = document.getElementById('provider-import-summary');
  renderProviderImportFilters();
  renderProviderImportResultsSub();
  if (summary) {
    if (!providerImportScanRunning) {
      summary.textContent = providerImportCandidates.length
        ? `${providerImportCandidates.length} 个候选`
        : '没有可导入的候选';
    }
  }
  if (!list) return;
  if (providerImportStep === 'scanning') {
    list.classList.add('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = providerImportScanProgressHtml();
    syncProviderImportSelectionState();
    return;
  }
  if (providerImportScanRunning && !providerImportCandidates.length) {
    list.classList.add('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = providerImportScanProgressHtml();
    syncProviderImportSelectionState();
    return;
  }
  if (!providerImportCandidates.length) {
    list.classList.remove('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = `
      <div class="provider-import-empty provider-import-scan-prompt">
        <div class="provider-import-scan-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        </div>
        <div class="provider-import-scan-title">没有扫到可直接导入的供应商</div>
        <div class="provider-import-scan-desc">可以稍后重新打开一键导入，或手动新增供应商。</div>
      </div>`;
    syncProviderImportSelectionState();
    return;
  }
  list.classList.toggle('is-scanning', providerImportScanRunning);
  list.classList.add('has-results');

  const visible = providerImportFilteredCandidates();
  if (!visible.length) {
    list.innerHTML = providerImportScanRunning
      ? providerImportScanProgressHtml({ inline: true })
      : `<div class="provider-import-empty compact">当前筛选下没有候选项。</div>`;
    syncProviderImportSelectionState();
    return;
  }

  const rows = visible.map(c => {
    const status = providerImportCandidateStatus(c);
    const selected = providerImportSelectedIds.has(c.id);
    const sourceTitle = [c.source || '', c.sourcePath || '', c.sourceId || ''].filter(Boolean).join('\n');
    const endpoint = providerImportCandidateApiAddress(c);
    const warnings = providerImportCandidateWarnings(c);
    const note = c.sourcePath || '';
    const nextChecked = selected ? 'false' : 'true';
    return `
      <div class="provider-import-row ${escAttr(status.state)} ${selected ? 'selected' : ''}" data-action="toggleProviderImportCandidate" data-args="[&quot;${escAttr(c.id)}&quot;,${nextChecked}]">
        <input class="provider-import-check" type="checkbox" ${selected ? 'checked' : ''} ${status.selectable ? '' : 'disabled'} data-action="__noop" data-stop data-action="toggleProviderImportCandidate" data-events="change" data-args="[&quot;${escAttr(c.id)}&quot;]" data-pass-checked>
        <div class="provider-import-row-main">
          <div class="provider-import-row-identity">
            <span class="provider-import-name" title="${escAttr(c.name || '')}">${escAttr(c.name || '未命名供应商')}</span>
            <span class="provider-import-source-pill" title="${escAttr(sourceTitle)}">${escAttr(c.source || '未知来源')}</span>
          </div>
          <span class="provider-import-row-endpoint" title="${escAttr(endpoint)}">${escAttr(endpoint || '--')}</span>
          <span class="provider-import-row-state">${providerImportStatusPillHtml(status)}</span>
          ${note ? `<div class="provider-import-row-note" title="${escAttr(note)}">${escAttr(note)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  list.innerHTML = providerImportScanRunning
    ? `${rows}<div class="provider-import-scan-tail">${providerImportScanProgressHtml({ inline: true })}</div>`
    : rows;
  syncProviderImportSelectionState();
}

function toggleProviderImportCandidate(id, checked) {
  const candidate = providerImportCandidates.find(c => c.id === id);
  if (candidate && !providerImportCandidateStatus(candidate).selectable) return;
  if (checked) {
    providerImportSelectedIds.add(id);
  } else {
    providerImportSelectedIds.delete(id);
  }
  syncProviderImportSelectionState();
}

function toggleAllProviderImportCandidates(checked) {
  if (checked) {
    providerImportSelectedIds = new Set(providerImportCandidates.filter(c => providerImportCandidateStatus(c).state === 'ready').map(c => c.id));
  } else {
    providerImportSelectedIds = new Set();
  }
  renderProviderImportCandidates();
}

function syncProviderImportSelectionState() {
  const total = providerImportCandidates.filter(c => providerImportCandidateStatus(c).selectable).length;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  const selectAll = document.getElementById('provider-import-select-all');
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (selectAll) {
    selectAll.disabled = total === 0 || providerImportScanRunning;
  }
  if (clearBtn) {
    clearBtn.disabled = selected === 0 || providerImportScanRunning;
  }
  updateProviderImportFooterSummary();
  updateProviderImportPrimaryState();
}

async function importSelectedProviders() {
  if (!invoke) return;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id) && providerImportCandidateStatus(c).selectable);
  if (!selected.length) {
    showCustomAlert('请先勾选要导入的供应商。', '没有选中项', 'warn');
    return;
  }

  const btn = document.getElementById('provider-import-confirm-btn');
  setLoading(btn, '导入中…');
  try {
    const result = await invoke('import_providers', { candidates: selected });
    if (result?.store && Array.isArray(result.store.providers)) {
      providerStore = normalizeProviderStoreShape(result.store);
      globalThis.providerStoreLoaded = true;
      syncLocalProxyProvider();
      syncCpaLocalProvider();
      (providerStore.providers || []).forEach(normalizeProviderUnlocks);
      markProviderStoreSnapshot(providerStore);
    } else {
      await loadProviders();
    }
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    closeProviderImportModal();
    const imported = Number(result?.imported || 0);
    const skipped = Number(result?.skipped || 0);
    addLog('ok', `一键导入完成：新增 ${imported} 个，跳过 ${skipped} 个`);
    const messages = Array.isArray(result?.messages) ? result.messages.filter(Boolean).slice(0, 3) : [];
    const detail = messages.length ? `\n\n${messages.join('\n')}` : '';
    showCustomAlert(`已新增 ${imported} 个供应商，跳过 ${skipped} 个。${detail}`, '导入完成', skipped ? 'info' : 'success');
  } catch (e) {
    addLog('err', '本地供应商导入失败: ' + e);
    showCustomAlert(String(e), '导入失败', 'error');
  } finally {
    clearLoading(btn);
    syncProviderImportSelectionState();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cancelProviderImportScan = cancelProviderImportScan;
  g.finishProviderImportScanUi = finishProviderImportScanUi;
  g.renderProviderImportNotices = renderProviderImportNotices;
  g.renderProviderImportResultsSub = renderProviderImportResultsSub;
  g.providerImportScanProgressHtml = providerImportScanProgressHtml;
  g.renderProviderImportCandidates = renderProviderImportCandidates;
  g.toggleProviderImportCandidate = toggleProviderImportCandidate;
  g.toggleAllProviderImportCandidates = toggleAllProviderImportCandidates;
  g.syncProviderImportSelectionState = syncProviderImportSelectionState;
  g.importSelectedProviders = importSelectedProviders;
})(globalThis);
