// providers-eval/provider-import-scan.js — 第三方工具配置导入向导与来源扫描
import { escAttr, escapeHtml } from '../ui/dom.js';

// ═══════ LOCAL PROVIDER IMPORT ═══════
function setProviderImportOpenButtonBusy(isBusy) {
  const btn = document.getElementById('provider-import-open-btn');
  if (!btn) return;
  if (typeof setLoading === 'function' && typeof clearLoading === 'function') {
    if (isBusy) setLoading(btn, '扫描中…');
    else clearLoading(btn);
    return;
  }
  btn.disabled = isBusy;
}

function providerImportSourceLabel(key) {
  return (PROVIDER_IMPORT_SOURCE_OPTIONS.find(x => x.key === key) || {}).label || key;
}

function providerImportSelectedSourceKeys() {
  const inputs = Array.from(document.querySelectorAll('#provider-import-sources input[type="checkbox"]'));
  return inputs.filter(input => input.checked).map(input => input.value);
}

function providerImportSelectedSourceLabels() {
  return providerImportSelectedSourceKeys().map(providerImportSourceLabel);
}

function setProviderImportSourceInputsDisabled(disabled) {
  document.querySelectorAll('#provider-import-sources input[type="checkbox"]').forEach(input => {
    input.disabled = disabled;
  });
}

function providerImportListSurface() {
  if (providerImportStep === 'scanning') {
    return document.getElementById('provider-import-scan-stage')
      || document.getElementById('provider-import-list');
  }
  return document.getElementById('provider-import-list');
}

function setProviderImportStep(step) {
  providerImportStep = ['scanning', 'results'].includes(step) ? step : 'select';
  const modal = document.querySelector('#provider-import-modal .provider-import-modal');
  if (modal) modal.dataset.importMode = providerImportStep;
  const title = document.getElementById('provider-import-control-title');
  if (title) {
    title.textContent = providerImportStep === 'results'
      ? '扫描结果'
      : (providerImportStep === 'scanning' ? '正在扫描' : '选择来源');
  }
  updateProviderImportPrimaryState();
}

function syncProviderImportSourceState() {
  const btn = document.getElementById('provider-import-rescan-btn');
  const selected = providerImportSelectedSourceKeys();
  if (btn) {
    btn.disabled = !providerImportScanRunning && selected.length === 0;
    btn.textContent = providerImportScanRunning ? '取消扫描' : (providerImportHasScanned ? '重新扫描' : '开始扫描');
  }
  const summary = document.getElementById('provider-import-summary');
  if (!providerImportHasScanned && summary) {
    summary.textContent = selected.length
      ? `已选择 ${selected.length} 个来源：${selected.map(providerImportSourceLabel).join(' / ')}`
      : '请选择至少一个扫描来源';
  }
  if (!providerImportScanRunning && !providerImportHasScanned) {
    resetProviderImportSourceStates(selected);
    renderProviderImportSourceStatus();
  }
  updateProviderImportPrimaryState();
}

function handleProviderImportScanAction() {
  return providerImportScanRunning ? cancelProviderImportScan() : scanProviderImportCandidates();
}

function handleProviderImportPrimaryAction() {
  if (providerImportStep !== 'results') {
    if (providerImportScanRunning) return cancelProviderImportScan();
    return scanProviderImportCandidates();
  }
  return importSelectedProviders();
}

async function openProviderImportModal() {
  if (providerImportOpening) return;
  const modal = document.getElementById('provider-import-modal');
  providerImportOpening = true;
  try {
    renderProviderImportScanPrompt();
    if (modal) modal.classList.add('active');
  } finally {
    providerImportOpening = false;
  }
}

function closeProviderImportModal() {
  const modal = document.getElementById('provider-import-modal');
  if (modal) modal.classList.remove('active');
}

function normalizeProviderImportHost(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeProviderImportPath(value) {
  return String(value || '').trim().toLowerCase();
}

function providerImportCandidateApiAddress(c) {
  return String(c?.apiHost || '').replace(/\/+$/, '') || '--';
}

function providerImportCandidateWarnings(c) {
  return Array.isArray(c?.warnings) ? c.warnings.map(x => String(x || '').trim()).filter(Boolean) : [];
}

function providerImportCandidateIsDuplicate(c) {
  const host = normalizeProviderImportHost(c?.apiHost);
  const path = normalizeProviderImportPath(c?.apiPath);
  const key = String(c?.apiKey || '');
  if (!host || !key) return false;
  return (providerStore.providers || []).some(p => {
    if (p?.meta?.codexConfig === true) return false;
    return normalizeProviderImportHost(p.apiHost) === host
      && normalizeProviderImportPath(p.apiPath) === path
      && String(p.apiKey || '') === key;
  });
}

function providerImportCandidateStatus(c) {
  if (!String(c?.apiHost || '').trim() || !String(c?.apiKey || '').trim()) {
    return { state: 'invalid', label: '缺少信息', title: '缺少 API 地址或密钥，无法直接导入', selectable: false, autoSelect: false };
  }
  if (providerImportCandidateIsDuplicate(c)) {
    return { state: 'duplicate', label: '已存在', title: '当前供应商列表中已有相同地址、路径和密钥', selectable: false, autoSelect: false };
  }
  const warnings = providerImportCandidateWarnings(c);
  if (warnings.length) {
    return { state: 'ready', label: '可导入', title: warnings.join('\n'), selectable: true, autoSelect: true };
  }
  return { state: 'ready', label: '可导入', title: '信息完整，默认选中导入', selectable: true, autoSelect: true };
}

function providerImportStatusPillHtml(status) {
  return `<span class="provider-import-status-pill ${escAttr(status.state)}" title="${escAttr(status.title)}">${escAttr(status.label)}</span>`;
}

function providerImportStatusCounts() {
  return providerImportCandidates.reduce((acc, c) => {
    const status = providerImportCandidateStatus(c).state;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { ready: 0, warning: 0, duplicate: 0, invalid: 0 });
}

function updateProviderImportFooterSummary() {
  const box = document.getElementById('provider-import-footer-summary');
  if (!box) return;
  if (providerImportScanRunning) {
    const done = Object.values(providerImportSourceStates).filter(s => ['found', 'empty', 'error'].includes(s.status)).length;
    const total = providerImportSelectedSourceKeys().length || PROVIDER_IMPORT_SOURCE_OPTIONS.length;
    box.textContent = `正在扫描 ${done} / ${total} 个来源，可随时取消`;
    return;
  }
  if (!providerImportHasScanned) {
    const selected = providerImportSelectedSourceKeys().length;
    box.textContent = selected ? `已选择 ${selected} 个来源` : '请选择扫描来源';
    return;
  }
  const selectable = providerImportCandidates.filter(c => providerImportCandidateStatus(c).selectable).length;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  const skipped = Math.max(0, providerImportCandidates.length - selectable);
  box.textContent = providerImportCandidates.length
    ? `已选择 ${selected} / ${selectable} 个可选项${skipped ? ` · ${skipped} 个不可导入` : ''}`
    : '没有可导入的候选供应商';
}

function updateProviderImportPrimaryState() {
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  if (!confirmBtn) return;
  if (providerImportStep !== 'results') {
    const selectedSources = providerImportSelectedSourceKeys();
    confirmBtn.disabled = !providerImportScanRunning && selectedSources.length === 0;
    if (providerImportScanRunning) {
      confirmBtn.textContent = '取消扫描';
    } else {
      confirmBtn.textContent = '开始扫描';
    }
    return;
  }

  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  confirmBtn.disabled = selected === 0 || providerImportScanRunning;
  confirmBtn.textContent = selected ? `导入选中项 (${selected})` : '导入选中项';
}

function resetProviderImportSourceStates(selectedKeys = providerImportSelectedSourceKeys()) {
  providerImportSourceStates = {};
  PROVIDER_IMPORT_SOURCE_OPTIONS.forEach(source => {
    const selected = selectedKeys.includes(source.key);
    providerImportSourceStates[source.key] = {
      key: source.key,
      label: source.label,
      selected,
      status: selected ? 'queued' : 'off',
      found: 0,
      message: selected ? '等待扫描' : '未选择',
    };
  });
}

function providerImportSourceStatusText(state) {
  if (!state) return '等待扫描';
  if (state.status === 'scanning') return '扫描中';
  if (state.status === 'found') return `找到 ${state.found || 0}`;
  if (state.status === 'empty') return '无可导入';
  if (state.status === 'error') return '出错';
  if (state.status === 'cancelled') return '已取消';
  if (state.status === 'off') return '未选择';
  return '等待扫描';
}

function renderProviderImportSourceStatus() {
  const box = document.getElementById('provider-import-source-status');
  if (!box) return;
  const states = PROVIDER_IMPORT_SOURCE_OPTIONS.map(source => providerImportSourceStates[source.key] || {
    key: source.key,
    label: source.label,
    selected: providerImportSelectedSourceKeys().includes(source.key),
    status: providerImportSelectedSourceKeys().includes(source.key) ? 'queued' : 'off',
    found: 0,
    message: '',
  });
  box.innerHTML = states.map(state => `
    <div class="provider-import-source-state ${escAttr(state.status)}">
      <span class="provider-import-source-state-name">${escAttr(state.label)}</span>
      <span class="provider-import-source-state-text" title="${escAttr(state.message || providerImportSourceStatusText(state))}">${escAttr(providerImportSourceStatusText(state))}</span>
    </div>
  `).join('');
}

function renderProviderImportFilters() {
  const box = document.getElementById('provider-import-filters');
  if (!box) return;
  const counts = providerImportStatusCounts();
  const items = [
    ['all', `全部 ${providerImportCandidates.length}`],
    ['ready', `可导入 ${counts.ready || 0}`],
    ['duplicate', `已存在 ${counts.duplicate || 0}`],
  ];
  box.innerHTML = items.map(([key, label]) => `
    <button type="button" class="provider-import-filter ${providerImportFilter === key ? 'active' : ''}" data-action="setProviderImportFilter" data-arg="${key}">${escAttr(label)}</button>
  `).join('');
}

function setProviderImportFilter(filter) {
  providerImportFilter = filter || 'all';
  renderProviderImportCandidates();
}

function providerImportFilteredCandidates() {
  if (providerImportFilter === 'all') return providerImportCandidates;
  return providerImportCandidates.filter(c => providerImportCandidateStatus(c).state === providerImportFilter);
}

function renderProviderImportScanPrompt() {
  providerImportScanSeq++;
  providerImportStep = 'select';
  providerImportHasScanned = false;
  providerImportLastScannedSourceLabels = [];
  providerImportCandidates = [];
  providerImportSelectedIds = new Set();
  providerImportFilter = 'all';
  providerImportScanRunning = false;
  providerImportActiveScanId = '';

  setProviderImportStep('select');
  const scanStage = document.getElementById('provider-import-scan-stage');
  const resultList = document.getElementById('provider-import-list');
  const summary = document.getElementById('provider-import-summary');
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  const selectedSources = providerImportSelectedSourceLabels();

  renderProviderImportNotices([]);
  if (summary) {
    summary.textContent = selectedSources.length
      ? `已选择 ${selectedSources.length} 个来源：${selectedSources.join(' / ')}`
      : '请选择至少一个扫描来源';
  }
  if (btn) {
    btn.disabled = selectedSources.length === 0;
    btn.textContent = '开始扫描';
  }
  if (confirmBtn) {
    confirmBtn.disabled = selectedSources.length === 0;
    confirmBtn.textContent = '开始扫描';
  }
  if (selectAll) {
    selectAll.disabled = true;
  }
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (clearBtn) clearBtn.disabled = true;
  resetProviderImportSourceStates(providerImportSelectedSourceKeys());
  renderProviderImportSourceStatus();
  renderProviderImportFilters();
  renderProviderImportResultsSub();
  updateProviderImportFooterSummary();
  if (resultList) {
    resultList.classList.remove('is-scanning');
    resultList.classList.remove('has-results');
    resultList.innerHTML = '<div class="provider-import-empty compact">扫描完成后在这里审核候选项。</div>';
  }
  if (scanStage) {
    scanStage.classList.remove('is-scanning');
    scanStage.classList.remove('has-results');
    scanStage.innerHTML = '';
  }
  syncProviderImportSourceState();
  updateProviderImportPrimaryState();
}

async function scanProviderImportCandidates(options = {}) {
  const { logResult = true } = options;
  if (!invoke) return false;
  const selectedSources = providerImportSelectedSourceKeys();
  if (!selectedSources.length) {
    showCustomAlert('请先选择至少一个要扫描的工具来源。', '没有扫描来源', 'warn');
    syncProviderImportSourceState();
    return false;
  }
  const selectedSourceNames = selectedSources.map(providerImportSourceLabel);
  providerImportLastScannedSourceLabels = selectedSourceNames;
  const scanSeq = ++providerImportScanSeq;
  providerImportHasScanned = true;
  providerImportScanRunning = true;
  providerImportActiveScanId = '';
  providerImportCandidates = [];
  providerImportSelectedIds = new Set();
  providerImportFilter = 'all';
  setProviderImportStep('scanning');
  resetProviderImportSourceStates(selectedSources);
  const list = providerImportListSurface();
  const summary = document.getElementById('provider-import-summary');
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  if (list) {
    list.classList.add('is-scanning');
    list.classList.remove('has-results');
    list.innerHTML = providerImportScanProgressHtml();
  }
  if (summary) summary.textContent = `正在扫描：${selectedSourceNames.join(' / ')}`;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '取消扫描';
  }
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = '取消扫描';
  }
  if (selectAll) selectAll.disabled = true;
  const clearBtn = document.getElementById('provider-import-clear-selection');
  if (clearBtn) clearBtn.disabled = true;
  renderProviderImportSourceStatus();
  renderProviderImportFilters();
  renderProviderImportResultsSub();
  updateProviderImportFooterSummary();
  setProviderImportSourceInputsDisabled(true);

  try {
    await bindProviderImportScanListener();
    const scanId = await invoke('start_provider_import_scan', { sources: selectedSources });
    if (scanSeq !== providerImportScanSeq) return false;
    providerImportActiveScanId = String(scanId || '');
    return true;
  } catch (e) {
    return scanProviderImportCandidatesFallback(e, selectedSources, scanSeq, logResult);
  }
}

async function scanProviderImportCandidatesFallback(originalError, selectedSources, scanSeq, logResult = true) {
  try {
    const result = await invoke('scan_importable_providers', { sources: selectedSources });
    if (scanSeq !== providerImportScanSeq) return false;
    providerImportScanRunning = false;
    providerImportCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
    providerImportSelectedIds = new Set(providerImportCandidates.filter(c => providerImportCandidateStatus(c).autoSelect).map(c => c.id));
    selectedSources.forEach(key => {
      const label = providerImportSourceLabel(key);
      const count = providerImportCandidates.filter(c => c.source === label).length;
      providerImportSourceStates[key] = { key, label, selected: true, status: count ? 'found' : 'empty', found: count, message: count ? `找到 ${count} 个候选` : '没有可导入项' };
    });
    renderProviderImportNotices(Array.isArray(result?.notices) ? result.notices : []);
    renderProviderImportSourceStatus();
    setProviderImportStep('results');
    renderProviderImportCandidates();
    finishProviderImportScanUi();
    if (logResult) addLog('ok', `一键导入扫描完成：${providerImportCandidates.length} 个候选供应商`);
    return true;
  } catch (e) {
    providerImportScanRunning = false;
    providerImportCandidates = [];
    providerImportSelectedIds = new Set();
    renderProviderImportNotices([]);
    const list = providerImportListSurface();
    const summary = document.getElementById('provider-import-summary');
    if (list) {
      list.classList.remove('is-scanning');
      list.classList.remove('has-results');
      list.innerHTML = `<div class="provider-import-empty">扫描失败：${escAttr(e || originalError)}</div>`;
    }
    if (summary) summary.textContent = '扫描失败';
    finishProviderImportScanUi();
    addLog('err', '本地供应商扫描失败: ' + (e || originalError));
    return false;
  }
}

async function bindProviderImportScanListener() {
  if (!tauriEvent?.listen || providerImportScanUnlisten) return;
  providerImportScanUnlisten = await tauriEvent.listen('provider-import-scan-progress', (event) => {
    applyProviderImportScanProgress(event.payload || {});
  });
}

function applyProviderImportScanProgress(payload) {
  const scanId = String(payload.scanId || '');
  if (!providerImportActiveScanId && scanId) providerImportActiveScanId = scanId;
  if (providerImportActiveScanId && scanId && providerImportActiveScanId !== scanId) return;

  const sourceKey = payload.sourceKey || '';
  if (sourceKey && providerImportSourceStates[sourceKey]) {
    providerImportSourceStates[sourceKey] = {
      ...providerImportSourceStates[sourceKey],
      status: payload.status || providerImportSourceStates[sourceKey].status,
      found: Number(payload.found || 0),
      message: payload.message || '',
    };
  }

  if (payload.phase === 'source-complete' && Array.isArray(payload.candidates)) {
    mergeProviderImportCandidates(payload.candidates);
    renderProviderImportNotices(Array.isArray(payload.notices) ? payload.notices : []);
  }

  if (payload.phase === 'complete') {
    providerImportScanRunning = false;
    providerImportCandidates = Array.isArray(payload.candidates) ? payload.candidates : providerImportCandidates;
    providerImportSelectedIds = new Set(providerImportCandidates.filter(c => providerImportCandidateStatus(c).autoSelect).map(c => c.id));
    renderProviderImportNotices(Array.isArray(payload.notices) ? payload.notices : []);
    setProviderImportStep('results');
    renderProviderImportCandidates();
    finishProviderImportScanUi();
    addLog('ok', `一键导入扫描完成：${providerImportCandidates.length} 个候选供应商`);
    return;
  }

  if (payload.phase === 'cancelled') {
    finishProviderImportCancelledScan(payload.message || '扫描已取消');
    return;
  }

  renderProviderImportSourceStatus();
  renderProviderImportCandidates();
  updateProviderImportFooterSummary();
  const summary = document.getElementById('provider-import-summary');
  if (summary && payload.message) summary.textContent = payload.message;
}

function mergeProviderImportCandidates(candidates) {
  (candidates || []).forEach(candidate => {
    if (!candidate || !candidate.id) return;
    const existing = providerImportCandidates.findIndex(c => c.id === candidate.id);
    if (existing >= 0) providerImportCandidates[existing] = candidate;
    else providerImportCandidates.push(candidate);
    if (providerImportCandidateStatus(candidate).autoSelect) providerImportSelectedIds.add(candidate.id);
  });
}

function finishProviderImportCancelledScan(message = '扫描已取消') {
  providerImportScanRunning = false;
  providerImportActiveScanId = '';
  Object.keys(providerImportSourceStates).forEach(key => {
    if (providerImportSourceStates[key].status === 'queued' || providerImportSourceStates[key].status === 'scanning') {
      providerImportSourceStates[key].status = 'cancelled';
      providerImportSourceStates[key].message = message;
    }
  });

  if (providerImportCandidates.length) {
    providerImportHasScanned = true;
    setProviderImportStep('results');
    renderProviderImportSourceStatus();
    renderProviderImportCandidates();
    finishProviderImportScanUi();
    const summary = document.getElementById('provider-import-summary');
    if (summary) summary.textContent = `扫描已取消，已保留 ${providerImportCandidates.length} 个候选`;
    addLog('warn', `本地供应商扫描已取消，保留 ${providerImportCandidates.length} 个候选`);
    return;
  }

  providerImportHasScanned = false;
  setProviderImportStep('select');
  const scanStage = document.getElementById('provider-import-scan-stage');
  const resultList = document.getElementById('provider-import-list');
  if (scanStage) {
    scanStage.classList.remove('is-scanning');
    scanStage.classList.remove('has-results');
    scanStage.innerHTML = '';
  }
  if (resultList) {
    resultList.classList.remove('is-scanning');
    resultList.classList.remove('has-results');
    resultList.innerHTML = '<div class="provider-import-empty compact">扫描完成后在这里审核候选项。</div>';
  }
  syncProviderImportSourceState();
  finishProviderImportScanUi();
  const summary = document.getElementById('provider-import-summary');
  if (summary) summary.textContent = '扫描已取消，可重新开始';
  addLog('warn', '本地供应商扫描已取消');
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.setProviderImportOpenButtonBusy = setProviderImportOpenButtonBusy;
  g.providerImportSourceLabel = providerImportSourceLabel;
  g.providerImportSelectedSourceKeys = providerImportSelectedSourceKeys;
  g.providerImportSelectedSourceLabels = providerImportSelectedSourceLabels;
  g.setProviderImportSourceInputsDisabled = setProviderImportSourceInputsDisabled;
  g.providerImportListSurface = providerImportListSurface;
  g.setProviderImportStep = setProviderImportStep;
  g.syncProviderImportSourceState = syncProviderImportSourceState;
  g.handleProviderImportScanAction = handleProviderImportScanAction;
  g.handleProviderImportPrimaryAction = handleProviderImportPrimaryAction;
  g.openProviderImportModal = openProviderImportModal;
  g.closeProviderImportModal = closeProviderImportModal;
  g.normalizeProviderImportHost = normalizeProviderImportHost;
  g.normalizeProviderImportPath = normalizeProviderImportPath;
  g.providerImportCandidateApiAddress = providerImportCandidateApiAddress;
  g.providerImportCandidateWarnings = providerImportCandidateWarnings;
  g.providerImportCandidateIsDuplicate = providerImportCandidateIsDuplicate;
  g.providerImportCandidateStatus = providerImportCandidateStatus;
  g.providerImportStatusPillHtml = providerImportStatusPillHtml;
  g.providerImportStatusCounts = providerImportStatusCounts;
  g.updateProviderImportFooterSummary = updateProviderImportFooterSummary;
  g.updateProviderImportPrimaryState = updateProviderImportPrimaryState;
  g.resetProviderImportSourceStates = resetProviderImportSourceStates;
  g.providerImportSourceStatusText = providerImportSourceStatusText;
  g.renderProviderImportSourceStatus = renderProviderImportSourceStatus;
  g.renderProviderImportFilters = renderProviderImportFilters;
  g.setProviderImportFilter = setProviderImportFilter;
  g.providerImportFilteredCandidates = providerImportFilteredCandidates;
  g.renderProviderImportScanPrompt = renderProviderImportScanPrompt;
  g.scanProviderImportCandidates = scanProviderImportCandidates;
  g.scanProviderImportCandidatesFallback = scanProviderImportCandidatesFallback;
  g.bindProviderImportScanListener = bindProviderImportScanListener;
  g.applyProviderImportScanProgress = applyProviderImportScanProgress;
  g.mergeProviderImportCandidates = mergeProviderImportCandidates;
  g.finishProviderImportCancelledScan = finishProviderImportCancelledScan;
})(globalThis);
