// ═══════ PROVIDER PROFILES (多套供应商 + 启用开关) ═══════
let providerStore = { providers: [] };
let providerImportCandidates = [];
let providerImportSelectedIds = new Set();
let providerImportOpening = false;
let providerImportHasScanned = false;
let providerImportLastScannedSourceLabels = [];
let providerImportScanSeq = 0;
const PROVIDER_IMPORT_SOURCE_OPTIONS = [
  { key: 'cc-switch', label: 'CC Switch' },
  { key: 'cockpit-tools', label: 'Cockpit Tools' },
  { key: 'cherry-studio', label: 'Cherry Studio' },
];

function providerLogoClass(fmt) {
  return fmt === 'openai' ? 'logo-openai' : 'logo-anthropic';
}
function providerLogoChar(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}
function escAttr(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function providerCapabilities(p, modelId = null) {
  const caps = p && p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {};
  const path = String((p && p.apiPath) || '').toLowerCase();
  const fmt = (p && p.apiFormat) || 'anthropic';
  const modelCapsMap = p && p.modelCaps && typeof p.modelCaps === 'object' ? p.modelCaps : {};
  const modelCaps = modelId ? (modelCapsMap[modelId] || {}) : null;
  const hasModelVision = !!(modelCaps && Object.prototype.hasOwnProperty.call(modelCaps, 'vision'));
  const hasModelTools = !!(modelCaps && Object.prototype.hasOwnProperty.call(modelCaps, 'tools'));
  return {
    text: caps.text !== false,
    stream: caps.stream !== false,
    vision: hasModelVision ? modelCaps.vision === true : caps.vision === true,
    tools: hasModelTools ? modelCaps.tools === true : caps.tools === true,
    gzip: caps.gzip === true,
    toolSchemaCompatGemini: caps.toolSchemaCompat === 'gemini',
    chat: fmt === 'openai' && path.includes('/chat/completions'),
    responses: fmt === 'openai' && path.includes('/responses'),
    anthropic: fmt === 'anthropic',
  };
}


function capabilityBadges(p, compact = false, modelId = null) {
  const c = providerCapabilities(p, modelId);
  const showModelCaps = !!modelId;
  const mk = (label, on, title) => `
    <span class="tag" title="${escAttr(title || label)}" style="background:${on ? 'var(--success-dim)' : 'var(--bg-input)'}; color:${on ? 'var(--success)' : 'var(--text-muted)'}; border:1px solid ${on ? 'rgba(22,163,74,.22)' : 'var(--border)'}; font-size:${compact ? '10px' : '11px'}; padding:${compact ? '2px 6px' : '3px 8px'}; border-radius:7px;">${escAttr(label)}</span>`;
  const protocol = c.responses ? mk('Responses', true) : (c.chat ? mk('对话', true) : (c.anthropic ? mk('Anthropic', true) : ''));
  return [
    protocol,
    mk('流式', c.stream),
    showModelCaps ? mk('视觉', c.vision, c.vision ? '该模型已标记支持图片理解' : '该模型未标记图片理解') : '',
    showModelCaps ? mk('工具', c.tools, c.tools ? '该模型已标记支持工具调用' : '该模型未标记工具调用') : '',
    c.gzip ? mk('Gzip', true, '已启用请求体 gzip 压缩') : '',
    c.toolSchemaCompatGemini ? mk('Schema兼容', true, '已启用 Gemini 工具 Schema 兼容模式（自动学习）') : '',
  ].filter(Boolean).join('');
}

// Windsurf 是否真的上传图片，取决于“原生模型槽位”本身；仅把映射目标标成 Vision 不够。
const IMAGE_UNSAFE_NATIVE_SLOT_IDS = new Set([
  'MODEL_XAI_GROK_3',
  'MODEL_XAI_GROK_3_MINI_REASONING',
]);

function catalogEntryOf(uid) {
  return (injectedCatalog || []).find(x => x.modelUid === uid) || null;
}

function nativeVisionSlotInfo(uid) {
  if (!uid) {
    return { ok: null, state: 'unknown', label: '未选择', title: '请先选择一个 Windsurf 模型槽位' };
  }
  if (IMAGE_UNSAFE_NATIVE_SLOT_IDS.has(uid)) {
    return {
      ok: false,
      state: 'risk',
      label: '慎用图片',
      title: '已实测该原生槽位不会稳定上传图片；请换用 GPT-4o、Claude Haiku 等原生视觉槽',
    };
  }
  const m = catalogEntryOf(uid);
  if (m && m.supportsImages === true) {
    return { ok: true, state: 'ok', label: '原生视觉', title: '该 Windsurf 槽位原生支持图片上传' };
  }
  if (m && m.supportsImages === false) {
    return { ok: false, state: 'risk', label: '非视觉槽', title: '该 Windsurf 槽位未标记原生图片能力' };
  }
  return { ok: null, state: 'unknown', label: '图片未知', title: '未在内置目录确认该槽位是否会上传图片' };
}

function targetSupportsVision(t) {
  const p = (providerStore.providers || []).find(x => x.id === (t && t.providerId));
  if (!p || p.enabled === false) return false;
  return providerCapabilities(p, t.model || p.defaultModel || null).vision === true;
}

function targetsSupportVision(targets) {
  return Array.isArray(targets) && targets.some(t => targetSupportsVision(t));
}

function visionStatusStyle(state) {
  if (state === 'ok') return { bg: 'var(--success-dim)', color: 'var(--success)', border: 'rgba(22,163,74,.22)' };
  if (state === 'risk') return { bg: 'rgba(217,119,6,.12)', color: 'var(--warn,#d97706)', border: 'rgba(217,119,6,.28)' };
  if (state === 'off') return { bg: 'var(--bg-input)', color: 'var(--text-muted)', border: 'var(--border)' };
  if (state === 'target-off') return { bg: 'var(--bg-input)', color: 'var(--text-muted)', border: 'var(--border)' };
  return { bg: 'rgba(37,99,235,.10)', color: 'var(--accent)', border: 'rgba(37,99,235,.22)' };
}

function slotVisionAssessment(uid, targets, supportsImages = true) {
  if (supportsImages) {
    return { state: 'ok', label: '支持图片理解', title: '该槽位已启用图片理解' };
  }
  return { state: 'off', label: '不支持图片理解', title: '该槽位未启用图片理解' };
}

function renderVisionPill(info, compact = false) {
  const s = visionStatusStyle(info.state);
  return `<span class="tag" title="${escAttr(info.title || info.label)}" style="display:inline-flex;align-items:center;gap:5px;background:${s.bg};color:${s.color};border:1px solid ${s.border};font-size:${compact ? '10px' : '11px'};padding:${compact ? '2px 6px' : '3px 8px'};border-radius:7px;font-weight:700;white-space:nowrap;">${escAttr(info.label)}</span>`;
}

function isAccountSlotModel(m) {
  return !!(m && m.origin === 'account');
}

function slotModelOf(uid) {
  return (ideModels || []).find(x => x.id === uid) || null;
}

function slotSourceInfo(uidOrModel) {
  const m = typeof uidOrModel === 'string' ? slotModelOf(uidOrModel) : uidOrModel;
  if (isAccountSlotModel(m)) {
    return {
      state: 'account',
      label: '当前账号',
      title: '当前 IDE 账号实际返回的模型槽位，默认优先使用',
    };
  }
  return {
    state: 'extended',
    label: '内置槽位',
    title: '来自内置全量槽位目录；启用代理改写后可用于 BYOK 映射',
  };
}

function renderSourcePill(info, compact = false) {
  const account = info.state === 'account';
  const bg = account ? 'rgba(37,99,235,.10)' : 'var(--bg-input)';
  const color = account ? 'var(--accent)' : 'var(--text-muted)';
  const border = account ? 'rgba(37,99,235,.22)' : 'var(--border)';
  return `<span class="tag" title="${escAttr(info.title)}" style="display:inline-flex;align-items:center;background:${bg};color:${color};border:1px solid ${border};font-size:${compact ? '10px' : '11px'};padding:${compact ? '2px 6px' : '3px 8px'};border-radius:7px;font-weight:700;white-space:nowrap;">${escAttr(info.label)}</span>`;
}

function visionSafeAlternatives(currentUid, limit = 3) {
  const used = new Set((modelMapStore.slots || []).map(x => x.modelUid).filter(x => x && x !== currentUid));
  return (ideModels || [])
    .filter(m => !used.has(m.id) && nativeVisionSlotInfo(m.id).ok === true)
    .slice(0, limit);
}

function updateSlotVisionHint() {
  const box = document.getElementById('slot-vision-hint');
  if (!box) return;
  const uid = selectedSlotUid || document.getElementById('slot-uid-select')?.value || '';
  const supportsImages = document.getElementById('slot-supports-images')?.checked !== false;
  const native = nativeVisionSlotInfo(uid);
  const targetVision = targetsSupportVision(selectedMappingTargets);
  const assessment = slotVisionAssessment(uid, selectedMappingTargets, supportsImages);
  const alts = visionSafeAlternatives(uid, 2).map(m => m.name).join(' / ');
  const s = visionStatusStyle(assessment.state === 'unset' ? native.state : assessment.state);
  let detail = assessment.title || native.title;
  if (assessment.state === 'risk' && alts) detail += `。推荐改用：${alts}`;
  if (!targetVision && selectedMappingTargets.length > 0) detail = '目标模型未标记 Vision；如果上游实际支持，请先测试供应商模型能力';
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        ${renderVisionPill(native, true)}
        ${renderVisionPill(assessment, true)}
      </div>
      ${targetVision ? '<span style="font-size:10px;color:var(--success);font-weight:700;">目标支持视觉</span>' : '<span style="font-size:10px;color:var(--text-muted);font-weight:700;">目标未标记视觉</span>'}
    </div>
    <div style="margin-top:6px;color:${s.color};font-size:11px;line-height:1.45;">${escAttr(detail)}</div>
  `;
  box.style.background = s.bg;
  box.style.borderColor = s.border;
}


async function loadProviders() {
  if (!invoke) return;
  try {
    providerStore = await invoke('load_providers');
    if (!providerStore || !Array.isArray(providerStore.providers)) {
      providerStore = { providers: [] };
    }
  } catch (e) {
    providerStore = { providers: [] };
  }
  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
}

function renderProviders() {
  const grid = document.getElementById('providerGrid');
  const empty = document.getElementById('providerEmpty');
  if (!grid) return;
  const list = providerStore.providers || [];
  if (empty) empty.style.display = list.length ? 'none' : 'block';

  grid.innerHTML = list.map(p => {
    const enabled = p.enabled !== false;
    const fmt = p.apiFormat || 'anthropic';

    // Keep model chip containers visually calm; icons retain their model-family colors.
    const modelsList = (p.models && Array.isArray(p.models) && p.models.length) ? p.models : (p.defaultModel ? [p.defaultModel] : []);
    const modelsBadges = modelsList.map((m, idx) => {
      return `
        <span class="tag provider-model-chip" style="background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border); display:flex; align-items:center; gap:6px; font-weight:600; padding:4px 10px; border-radius:8px; font-size:11px; min-width:0; max-width:100%;">
          ${renderModelIcon(m)}
          <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escAttr(m)}</span>
          ${idx === 0 ? '<span style="opacity:0.5; font-size:9px; font-weight:normal; margin-left:2px; flex-shrink:0;">(默认)</span>' : ''}
        </span>
      `;
    }).join('');

    return `
      <div class="provider-card ${enabled ? 'active' : ''}" style="display:flex; flex-direction:column; min-height:220px;">
        <div class="provider-top">
          <div class="provider-id">
            <div class="provider-logo ${providerLogoClass(fmt)}">${escAttr(providerLogoChar(p.name))}</div>
            <div>
              <div class="provider-name">${escAttr(p.name)}</div>
            </div>
          </div>
          <div class="toggle ${enabled ? 'on' : ''}" title="${enabled ? '已启用，点击禁用' : '未启用，点击启用'}" onclick="toggleProviderEnabled('${escAttr(p.id)}')"></div>
        </div>
        <div class="provider-body" style="flex:1; display:flex; flex-direction:column; gap:14px; padding:16px 20px;">
          <div class="field" style="margin-bottom:0; min-height:0;">
            <div class="field-label" style="margin-bottom:6px;">已选模型</div>
            <div style="display:flex; flex-direction:column; gap:6px; max-height:160px; overflow-y:auto; padding-right:2px;">${modelsBadges || '<span style="color:var(--text-muted); font-size:12px;">未选择</span>'}</div>
          </div>
          <div class="field" style="margin-bottom:0; margin-top:auto;">
            <div class="field-label" style="margin-bottom:6px;">配置格式</div>
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="tag tag-${fmt}">${fmt === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
              ${enabled
                ? '<span class="tag tag-anthropic" style="background:var(--success-dim);color:var(--success)">● 已启用</span>'
                : '<span class="tag" style="background:var(--text-muted);color:#fff;opacity:.6">○ 未启用</span>'}
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <div class="field-label" style="margin-bottom:6px;">能力</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">${capabilityBadges(p)}</div>
          </div>
        </div>
        <div class="provider-footer">
          <div class="conn-dot no" id="conn-dot-${escAttr(p.id)}"></div>
          <span class="conn-text" id="conn-text-${escAttr(p.id)}">未测试</span>
          <button class="btn-ghost" style="margin-left:auto" onclick="testProvider('${escAttr(p.id)}')">测试</button>
          <button class="btn-ghost" onclick="openProviderEditor('${escAttr(p.id)}')">编辑</button>
          <button class="btn-ghost" onclick="deleteProvider('${escAttr(p.id)}')">删除</button>
        </div>
      </div>`;
  }).join('');
}

// ═══════ LOCAL PROVIDER IMPORT ═══════
function setProviderImportOpenButtonBusy(isBusy) {
  const btn = document.getElementById('provider-import-open-btn');
  if (!btn) return;
  const label = btn.querySelector('.provider-toolbar-label');
  btn.disabled = isBusy;
  if (label) label.textContent = isBusy ? '扫描中…' : '本地导入';
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

function syncProviderImportSourceState() {
  const btn = document.getElementById('provider-import-rescan-btn');
  const selected = providerImportSelectedSourceKeys();
  if (btn && !btn.textContent.includes('扫描中')) {
    btn.disabled = selected.length === 0;
  }
  document.querySelectorAll('.provider-import-scan-btn').forEach(scanBtn => {
    scanBtn.disabled = selected.length === 0;
  });
  const summary = document.getElementById('provider-import-summary');
  if (!providerImportHasScanned && summary) {
    summary.textContent = selected.length
      ? `需要扫描后显示候选供应商 · ${selected.map(providerImportSourceLabel).join(' / ')}`
      : '请选择至少一个扫描来源';
  }
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

function providerImportListHeaderHtml() {
  return `
    <div class="provider-import-list-header">
      <span></span>
      <span>来源</span>
      <span>供应商</span>
      <span>API</span>
      <span>Key</span>
    </div>`;
}

function renderProviderImportScanPrompt() {
  providerImportScanSeq++;
  providerImportHasScanned = false;
  providerImportLastScannedSourceLabels = [];
  providerImportCandidates = [];
  providerImportSelectedIds = new Set();

  const list = document.getElementById('provider-import-list');
  const summary = document.getElementById('provider-import-summary');
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  const selectedSources = providerImportSelectedSourceLabels();

  renderProviderImportNotices([]);
  if (summary) {
    summary.textContent = selectedSources.length
      ? `需要扫描后显示候选供应商 · ${selectedSources.join(' / ')}`
      : '请选择至少一个扫描来源';
  }
  if (btn) {
    btn.disabled = selectedSources.length === 0;
    btn.textContent = '开始扫描';
  }
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '导入选中项';
  }
  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    selectAll.disabled = true;
  }
  if (list) {
    list.classList.remove('is-scanning');
    list.innerHTML = `
      <div class="provider-import-empty provider-import-scan-prompt">
        <div class="provider-import-scan-title">需要先扫描本机配置</div>
        <div class="provider-import-scan-desc">先选择要扫描的工具来源，再从本地配置中查找可导入的 API 供应商。</div>
        <button class="model-panel-btn provider-import-scan-btn" onclick="scanProviderImportCandidates()">开始扫描</button>
      </div>`;
  }
  syncProviderImportSourceState();
}

function providerImportSkeletonHtml(rows = 6) {
  const skeletonRows = Array.from({ length: rows }, (_, idx) => `
    <div class="provider-import-item provider-import-skeleton-row" aria-hidden="true">
      <span class="provider-import-skeleton-check"></span>
      <span class="provider-import-skeleton-line source" style="--delay:${idx * 45 + 35}ms"></span>
      <span class="provider-import-skeleton-line name" style="--delay:${idx * 45}ms"></span>
      <span class="provider-import-skeleton-line api" style="--delay:${idx * 45 + 70}ms"></span>
      <span class="provider-import-skeleton-line key" style="--delay:${idx * 45 + 120}ms"></span>
    </div>`).join('');
  return `${providerImportListHeaderHtml()}${skeletonRows}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const list = document.getElementById('provider-import-list');
  const summary = document.getElementById('provider-import-summary');
  const btn = document.getElementById('provider-import-rescan-btn');
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  if (list) {
    list.classList.add('is-scanning');
    list.innerHTML = providerImportSkeletonHtml(Math.max(5, Math.min(providerImportCandidates.length || 6, 8)));
  }
  if (summary) summary.textContent = `正在扫描：${selectedSourceNames.join(' / ')}`;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '扫描中…';
  }
  if (confirmBtn) confirmBtn.disabled = true;
  if (selectAll) selectAll.disabled = true;
  setProviderImportSourceInputsDisabled(true);

  try {
    const [result] = await Promise.all([
      invoke('scan_importable_providers', { sources: selectedSources }),
      sleep(240),
    ]);
    if (scanSeq !== providerImportScanSeq) return false;
    providerImportCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
    providerImportSelectedIds = new Set(providerImportCandidates.map(c => c.id));
    renderProviderImportNotices(Array.isArray(result?.notices) ? result.notices : []);
    renderProviderImportCandidates();
    if (logResult) addLog('ok', `本地扫描完成：${providerImportCandidates.length} 个候选供应商`);
    return true;
  } catch (e) {
    if (scanSeq !== providerImportScanSeq) return false;
    providerImportCandidates = [];
    providerImportSelectedIds = new Set();
    renderProviderImportNotices([]);
    if (list) list.innerHTML = `<div class="provider-import-empty">扫描失败：${escAttr(e)}</div>`;
    if (summary) summary.textContent = '扫描失败';
    addLog('err', '本地供应商扫描失败: ' + e);
    return false;
  } finally {
    if (scanSeq === providerImportScanSeq) {
      if (list) list.classList.remove('is-scanning');
      if (btn) {
        btn.disabled = false;
        btn.textContent = providerImportHasScanned ? '重新扫描' : '开始扫描';
      }
      if (selectAll) selectAll.disabled = false;
      setProviderImportSourceInputsDisabled(false);
      syncProviderImportSelectionState();
      syncProviderImportSourceState();
    }
  }
}

function renderProviderImportNotices(notices) {
  const box = document.getElementById('provider-import-notices');
  if (!box) return;
  const clean = (notices || []).map(x => String(x || '').trim()).filter(Boolean);
  if (providerImportCandidates.length > 0) {
    box.classList.remove('has-items');
    box.innerHTML = '';
    return;
  }
  box.classList.toggle('has-items', clean.length > 0);
  box.innerHTML = clean.map(n => `<div class="provider-import-notice">${escAttr(n)}</div>`).join('');
}

function renderProviderImportCandidates() {
  const list = document.getElementById('provider-import-list');
  const summary = document.getElementById('provider-import-summary');
  if (summary) {
    const sources = [...new Set(providerImportCandidates.map(c => c.source).filter(Boolean))];
    const scanned = providerImportLastScannedSourceLabels.length
      ? providerImportLastScannedSourceLabels
      : providerImportSelectedSourceLabels();
    summary.textContent = providerImportCandidates.length
      ? `${providerImportCandidates.length} 个候选 · 扫描列表：${scanned.join(' / ')} · 命中：${sources.join(' / ')}`
      : `没有可导入的候选 · 扫描列表：${scanned.join(' / ')}`;
  }
  if (!list) return;
  if (!providerImportCandidates.length) {
    list.innerHTML = `
      <div class="provider-import-empty provider-import-scan-prompt">
        <div class="provider-import-scan-title">没有扫到可直接导入的供应商</div>
        <div class="provider-import-scan-desc">可以稍后重新扫描，或手动新增供应商。</div>
        <button class="model-panel-btn provider-import-scan-btn" onclick="scanProviderImportCandidates()">重新扫描</button>
      </div>`;
    syncProviderImportSelectionState();
    return;
  }

  const rows = providerImportCandidates.map(c => {
    const selected = providerImportSelectedIds.has(c.id);
    const endpoint = `${c.apiHost || ''}${c.apiPath || ''}`;
    const sourceTitle = [c.source || '', c.sourcePath || '', c.sourceId || ''].filter(Boolean).join('\n');
    return `
      <label class="provider-import-item">
        <input class="provider-import-check" type="checkbox" ${selected ? 'checked' : ''} onchange="toggleProviderImportCandidate('${escAttr(c.id)}', this.checked)">
        <div class="provider-import-source-cell">
          <span class="provider-import-source-pill" title="${escAttr(sourceTitle)}">${escAttr(c.source || '未知来源')}</span>
        </div>
        <div class="provider-import-name" title="${escAttr(c.name || '')}">
          ${escAttr(c.name || '未命名供应商')}
        </div>
        <div class="provider-import-cell">
          <div class="provider-import-cell-value provider-import-scroll-value" title="${escAttr(endpoint || '')}">${escAttr(endpoint || '--')}</div>
        </div>
        <div class="provider-import-cell">
          <div class="provider-import-cell-value provider-import-key provider-import-scroll-value" title="${escAttr(c.apiKey || '')}">${escAttr(c.apiKey || '--')}</div>
        </div>
      </label>`;
  }).join('');

  list.innerHTML = `${providerImportListHeaderHtml()}${rows}`;
  syncProviderImportSelectionState();
}

function toggleProviderImportCandidate(id, checked) {
  if (checked) {
    providerImportSelectedIds.add(id);
  } else {
    providerImportSelectedIds.delete(id);
  }
  syncProviderImportSelectionState();
}

function toggleAllProviderImportCandidates(checked) {
  providerImportSelectedIds = checked
    ? new Set(providerImportCandidates.map(c => c.id))
    : new Set();
  renderProviderImportCandidates();
}

function syncProviderImportSelectionState() {
  const total = providerImportCandidates.length;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id)).length;
  const confirmBtn = document.getElementById('provider-import-confirm-btn');
  const selectAll = document.getElementById('provider-import-select-all');
  if (confirmBtn) {
    confirmBtn.disabled = selected === 0;
    confirmBtn.textContent = selected ? `导入选中项 (${selected})` : '导入选中项';
  }
  if (selectAll) {
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
    selectAll.disabled = total === 0;
  }
}

async function importSelectedProviders() {
  if (!invoke) return;
  const selected = providerImportCandidates.filter(c => providerImportSelectedIds.has(c.id));
  if (!selected.length) {
    showCustomAlert('请先勾选要导入的供应商。', '没有选中项', 'warn');
    return;
  }

  const btn = document.getElementById('provider-import-confirm-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '导入中…';
  }
  try {
    const result = await invoke('import_providers', { candidates: selected });
    if (result?.store && Array.isArray(result.store.providers)) {
      providerStore = result.store;
    } else {
      await loadProviders();
    }
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    closeProviderImportModal();
    const imported = Number(result?.imported || 0);
    const skipped = Number(result?.skipped || 0);
    addLog('ok', `本地导入完成：新增 ${imported} 个，跳过 ${skipped} 个`);
    if (skipped > 0) {
      showCustomAlert(`已新增 ${imported} 个供应商，跳过 ${skipped} 个已存在或无效项。`, '导入完成', 'info');
    }
  } catch (e) {
    addLog('err', '本地供应商导入失败: ' + e);
    showCustomAlert(String(e), '导入失败', 'error');
  } finally {
    syncProviderImportSelectionState();
  }
}

// ═══════ MODEL EVALUATION ═══════
let evalReports = [];
let currentEvalReportId = '';
let evalRunning = false;
let currentEvalProgressId = '';
let evalProgressUnlisten = null;
const EVAL_COMBO_IDS = ['eval-provider-select', 'eval-model-select'];
const evalRemoteModelCache = new Map();
const evalRemoteModelPending = new Set();
let evalModelFetchSeq = 0;

function getEvalComboParts(selectId) {
  const shell = document.querySelector(`.eval-combo[data-select-id="${selectId}"]`);
  return {
    shell,
    select: document.getElementById(selectId),
    trigger: shell ? shell.querySelector('.eval-combo-trigger') : null,
    label: shell ? shell.querySelector('.eval-combo-label') : null,
    menu: shell ? shell.querySelector('.eval-combo-menu') : null,
  };
}

function closeEvalCombos(exceptId = '') {
  EVAL_COMBO_IDS.forEach(selectId => {
    if (selectId === exceptId) return;
    const { shell, trigger, menu } = getEvalComboParts(selectId);
    if (!shell) return;
    shell.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.setAttribute('aria-hidden', 'true');
  });
}

function focusEvalComboOption(selectId, offset = 0) {
  const { menu, select } = getEvalComboParts(selectId);
  if (!menu || !select) return;
  const options = Array.from(menu.querySelectorAll('.eval-combo-option'));
  if (!options.length) return;
  const selectedIndex = Math.max(0, Array.from(select.options).findIndex(option => option.value === select.value));
  const next = (selectedIndex + offset + options.length) % options.length;
  options[next].focus();
}

function setEvalComboOpen(selectId, open) {
  const { shell, trigger } = getEvalComboParts(selectId);
  if (!shell || !trigger) return;
  closeEvalCombos(selectId);
  shell.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  const { menu } = getEvalComboParts(selectId);
  if (menu) menu.setAttribute('aria-hidden', String(!open));
  if (open) {
    syncEvalCombo(selectId);
    requestAnimationFrame(() => focusEvalComboOption(selectId));
  }
}

function toggleEvalCombo(selectId, event) {
  if (event) event.stopPropagation();
  const { shell } = getEvalComboParts(selectId);
  setEvalComboOpen(selectId, !(shell && shell.classList.contains('open')));
}

function handleEvalComboTriggerKey(selectId, event) {
  if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  setEvalComboOpen(selectId, true);
  requestAnimationFrame(() => focusEvalComboOption(selectId, event.key === 'ArrowUp' ? -1 : 0));
}

function selectEvalComboOption(selectId, value, event) {
  if (event) event.stopPropagation();
  const { select, trigger } = getEvalComboParts(selectId);
  if (!select) return;
  const changed = select.value !== value;
  select.value = value;
  if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  closeEvalCombos();
  syncEvalCombos();
  if (trigger) trigger.focus();
}

function syncEvalCombo(selectId) {
  const { select, trigger, label, menu, shell } = getEvalComboParts(selectId);
  if (!select || !trigger || !label || !menu || !shell) return;
  const options = Array.from(select.options);
  const selected = options.find(option => option.value === select.value) || options[0] || null;
  if (selected && select.value !== selected.value) select.value = selected.value;
  label.textContent = selected ? selected.textContent : '--';
  trigger.disabled = !options.length;
  const isOpen = shell.classList.contains('open');
  trigger.setAttribute('aria-expanded', String(isOpen));
  menu.setAttribute('aria-hidden', String(!isOpen));
  menu.innerHTML = '';
  options.forEach(option => {
    const item = document.createElement('button');
    const isSelected = selected && option.value === selected.value;
    item.type = 'button';
    item.className = `eval-combo-option${isSelected ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isSelected));
    item.innerHTML = '<span class="eval-option-text"></span><span class="eval-option-check" aria-hidden="true">✓</span>';
    item.querySelector('.eval-option-text').textContent = option.textContent;
    item.addEventListener('click', event => selectEvalComboOption(selectId, option.value, event));
    menu.appendChild(item);
  });
}

function syncEvalCombos() {
  EVAL_COMBO_IDS.forEach(syncEvalCombo);
}

window.addEventListener('click', () => closeEvalCombos());
document.addEventListener('keydown', event => {
  const activeCombo = document.querySelector('.eval-combo.open');
  if (!activeCombo) return;
  const selectId = activeCombo.getAttribute('data-select-id') || '';
  const options = Array.from(activeCombo.querySelectorAll('.eval-combo-option'));
  const currentIndex = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    const { trigger } = getEvalComboParts(selectId);
    closeEvalCombos();
    if (trigger) trigger.focus();
    return;
  }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (Math.max(0, currentIndex) + delta + options.length) % options.length;
    options[next].focus();
  }
});

function getEvalProvider(id) {
  return (providerStore.providers || []).find(p => p.id === id) || null;
}

function normalizeEvalModels(models) {
  return [...new Set((models || []).map(m => String(m || '').trim()).filter(Boolean))];
}

function getEvalSavedModelList(provider) {
  if (!provider) return [];
  const models = [];
  if (provider.defaultModel) models.push(provider.defaultModel);
  if (Array.isArray(provider.models)) models.push(...provider.models);
  return normalizeEvalModels(models);
}

function getEvalModelList(provider) {
  if (!provider) return [];
  const remoteModels = evalRemoteModelCache.get(provider.id) || [];
  return normalizeEvalModels([...getEvalSavedModelList(provider), ...remoteModels]);
}

function getEvalProviderFetchHost(provider) {
  const raw = String(provider?.apiHost || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).origin;
  } catch {
    return raw;
  }
}

function canFetchEvalModels(provider) {
  return !!(invoke && provider && provider.apiHost && provider.apiKey);
}

async function fetchEvalRemoteModels(provider) {
  if (!canFetchEvalModels(provider)) return;
  if (evalRemoteModelCache.has(provider.id) || evalRemoteModelPending.has(provider.id)) return;
  const seq = ++evalModelFetchSeq;
  evalRemoteModelPending.add(provider.id);
  const modelSelect = document.getElementById('eval-model-select');
  try {
    const result = await invoke('fetch_models', {
      args: {
        host: getEvalProviderFetchHost(provider),
        api_key: provider.apiKey,
        api_format: provider.apiFormat || 'anthropic',
      }
    });
    if (seq !== evalModelFetchSeq) return;
    const remoteModels = normalizeEvalModels(result?.models || []);
    if (!remoteModels.length) throw new Error('返回的模型列表为空');
    evalRemoteModelCache.set(provider.id, remoteModels);
    renderEvalModelOptions({ fetchRemote: false });
  } catch (e) {
    if (seq !== evalModelFetchSeq) return;
    if (modelSelect && !getEvalModelList(provider).length) {
      modelSelect.innerHTML = '<option value="">模型拉取失败</option>';
      syncEvalCombos();
    }
    addLog('warn', `检测模型完整列表拉取失败：${provider.name} (${e})`);
  } finally {
    evalRemoteModelPending.delete(provider.id);
  }
}

function renderEvalProviderOptions() {
  const select = document.getElementById('eval-provider-select');
  if (!select) return;
  const previous = select.value;
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false);
  if (!providers.length) {
    select.innerHTML = '<option value="">无启用供应商</option>';
    renderEvalModelOptions();
    syncEvalCombos();
    return;
  }
  select.innerHTML = providers
    .map(p => `<option value="${escAttr(p.id)}">${escAttr(p.name)}</option>`)
    .join('');
  select.value = providers.some(p => p.id === previous) ? previous : providers[0].id;
  renderEvalModelOptions();
  syncEvalCombos();
}

function renderEvalModelOptions(options = {}) {
  const { fetchRemote = true } = options;
  const providerSelect = document.getElementById('eval-provider-select');
  const modelSelect = document.getElementById('eval-model-select');
  if (!modelSelect) return;
  const previous = modelSelect.value;
  const provider = getEvalProvider(providerSelect ? providerSelect.value : '');
  const models = getEvalModelList(provider);
  if (!models.length) {
    modelSelect.innerHTML = canFetchEvalModels(provider)
      ? '<option value="">拉取模型中...</option>'
      : '<option value="">未配置模型</option>';
    syncEvalCombos();
    if (fetchRemote) fetchEvalRemoteModels(provider);
    return;
  }
  modelSelect.innerHTML = models.map(m => `<option value="${escAttr(m)}">${escAttr(m)}</option>`).join('');
  const preferred = provider && models.includes(provider.defaultModel) ? provider.defaultModel : models[0];
  modelSelect.value = models.includes(previous) ? previous : preferred;
  syncEvalCombos();
  if (fetchRemote) fetchEvalRemoteModels(provider);
}

function evalStatusLabel(status) {
  return {
    pass: '通过',
    warn: '警告',
    fail: '失败',
    error: '错误',
    skip: '跳过',
    supported: '支持',
    partial: '部分',
    unsupported: '不支持',
    optional: '可选',
    unknown: '未测'
  }[status] || status || '--';
}

function evalStatusTag(status) {
  const key = String(status || 'skip').toLowerCase();
  return `<span class="eval-status ${escAttr(key)}">${escAttr(evalStatusLabel(key))}</span>`;
}

function evalRiskLabel(level) {
  return {
    low: '低风险',
    'medium-low': '较低',
    medium: '中风险',
    high: '高风险',
    critical: '严重'
  }[level] || '--';
}

function evalRiskColor(level) {
  return {
    low: 'var(--success)',
    'medium-low': 'var(--success)',
    medium: 'var(--accent-warm)',
    high: 'var(--danger)',
    critical: 'var(--danger)'
  }[level] || 'var(--text-primary)';
}

function evalRelationLabel(relation) {
  return {
    exact: '一致',
    alias: '别名',
    same_family: '同族',
    different: '不同',
    unknown: '未知'
  }[relation] || '--';
}

function evalCheckStatusClass(status) {
  const key = String(status || 'unknown').toLowerCase();
  if (key === 'supported' || key === 'pass') return 'supported';
  if (key === 'partial' || key === 'warn') return 'partial';
  if (key === 'unsupported' || key === 'fail' || key === 'error') return 'unsupported';
  if (key === 'optional') return 'unknown';
  return 'unknown';
}

function renderEvalChecks(containerId, checks, fallbackText = '等待检测') {
  const el = document.getElementById(containerId);
  if (!el) return;
  const items = Array.isArray(checks) ? checks : [];
  if (!items.length) {
    el.innerHTML = `<div class="eval-check-empty">${escAttr(fallbackText)}</div>`;
    return;
  }
  el.innerHTML = items.map(item => {
    const state = evalCheckStatusClass(item.status);
    const evidence = Array.isArray(item.evidence) && item.evidence.length
      ? item.evidence.slice(0, 2).join('\n')
      : '';
    const title = [item.detail, evidence].filter(Boolean).join('\n');
    return `
      <div class="eval-check-item ${state}" title="${escAttr(title)}">
        <div class="eval-check-top">
          <span>${escAttr(item.label || item.key || '--')}</span>
          <strong>${escAttr(evalStatusLabel(item.status))}</strong>
        </div>
        <div class="eval-check-detail">${escAttr(item.detail || '无细节')}</div>
      </div>`;
  }).join('');
}

function evalFormatDuration(ms) {
  const n = Number(ms || 0);
  if (!n) return '--';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function evalFormatTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '--';
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '--';
  }
}

const EVAL_DIMENSIONS = [
  { key: 'protocol', label: '协议合规', ids: ['P1', 'P2', 'P5', 'P13'] },
  { key: 'performance', label: '性能', ids: ['P10', 'P11'] },
  { key: 'safety', label: '安全性', ids: ['P8', 'P14'] },
  { key: 'content', label: '内容完整性', ids: ['P4'] },
  { key: 'capability', label: '能力验证', ids: ['P6', 'P9', 'P11'] },
  { key: 'identity', label: '身份一致', ids: ['P3', 'P7'] },
];

const EVAL_CHECK_OPTIONS = [
  { id: 'P4', label: '内容 Canary' },
  { id: 'P5', label: '流式传输' },
  { id: 'P6', label: '工具调用' },
  { id: 'P12', label: '图片理解' },
  { id: 'P13', label: '调用兼容' },
  { id: 'P14', label: '中转注入' },
  { id: 'P10', label: '稳定性' },
  { id: 'P8', label: 'Token 注入' },
  { id: 'P9', label: 'JSON 输出' },
  { id: 'P11', label: '输出吞吐' },
];

function renderEvalCheckPicker() {
  const grid = document.getElementById('eval-check-picker-grid');
  if (!grid) return;
  grid.innerHTML = EVAL_CHECK_OPTIONS.map(opt => `
    <label class="eval-check-option">
      <input type="checkbox" value="${escAttr(opt.id)}" checked onchange="syncEvalCheckButton()">
      <span>${escAttr(opt.label)}</span>
    </label>
  `).join('');
  syncEvalCheckButton();
}

function setAllEvalChecks(checked) {
  document.querySelectorAll('#eval-check-picker-grid input[type="checkbox"]').forEach(input => {
    input.checked = !!checked;
  });
  syncEvalCheckButton();
}

function getSelectedEvalChecks() {
  const inputs = Array.from(document.querySelectorAll('#eval-check-picker-grid input[type="checkbox"]'));
  if (!inputs.length) return EVAL_CHECK_OPTIONS.map(opt => opt.id);
  return inputs.filter(input => input.checked).map(input => input.value);
}

function getEvalTotalForSelected(selectedChecks = getSelectedEvalChecks()) {
  return 4 + (Array.isArray(selectedChecks) ? selectedChecks.length : EVAL_CHECK_OPTIONS.length);
}

function syncEvalCheckButton() {
  const btn = document.getElementById('eval-check-open-btn');
  if (!btn) return;
  const count = getSelectedEvalChecks().length;
  btn.textContent = `检测项(${count}个)`;
  btn.title = count ? `已选择 ${count} 个附加检测项` : '仅执行基础协议检测';
}

function openEvalCheckModal() {
  syncEvalCheckButton();
  document.getElementById('eval-check-modal')?.classList.add('active');
}

function closeEvalCheckModal() {
  syncEvalCheckButton();
  document.getElementById('eval-check-modal')?.classList.remove('active');
}

function setEvalText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function evalScoreBand(score) {
  if (score >= 85) return '高一致性';
  if (score >= 70) return '良好';
  if (score >= 50) return '需复核';
  if (score >= 30) return '高风险';
  return '不可用';
}

function evalSafeScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function evalDimensionScores(report) {
  const probes = Array.isArray(report?.probes) ? report.probes : [];
  return EVAL_DIMENSIONS.map(dim => {
    const matched = probes.filter(p => dim.ids.includes(String(p.id || '').toUpperCase()) && p.status !== 'skip');
    const score = matched.length
      ? matched.reduce((sum, p) => sum + evalSafeScore(p.score), 0) / matched.length
      : evalSafeScore(report?.score);
    return { ...dim, score: Math.round(score), probes: matched };
  });
}

function updateEvalRadar(score, dimensions) {
  const poly = document.getElementById('eval-radar-poly');
  const radarScore = document.getElementById('eval-radar-score');
  if (radarScore) radarScore.textContent = Number.isFinite(Number(score)) ? String(Math.round(score)) : '--';
  if (!poly) return;
  const cx = 110;
  const cy = 110;
  const radius = 86;
  const angles = [-90, -30, 30, 90, 150, 210];
  const points = (dimensions || EVAL_DIMENSIONS).map((dim, index) => {
    const value = evalSafeScore(dim.score) / 100;
    const angle = angles[index] * Math.PI / 180;
    const x = cx + Math.cos(angle) * radius * value;
    const y = cy + Math.sin(angle) * radius * value;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  poly.setAttribute('points', points.join(' '));
}

function renderEvalDimensions(dimensions) {
  const grid = document.getElementById('eval-dimension-grid');
  if (!grid) return;
  grid.innerHTML = dimensions.map(dim => {
    const probeMarks = dim.probes.length
      ? dim.probes.slice(0, 3).map(p => `<span>${escAttr(p.status === 'pass' ? '✓' : p.status === 'skip' ? '-' : p.status === 'warn' ? '?' : '×')}${escAttr(p.id || '')}</span>`).join('')
      : '<span>--</span>';
    return `
      <div class="eval-dimension-item">
        <div class="eval-dimension-top">
          <span>${escAttr(dim.label)}</span>
          <strong>${dim.score}%</strong>
        </div>
        <div class="eval-dimension-bar"><i style="width:${dim.score}%"></i></div>
        <div class="eval-dimension-probes">${probeMarks}</div>
      </div>`;
  }).join('');
}

function evalDiagnosisLevel(score) {
  if (score >= 85) return '高一致性（近似官方）';
  if (score >= 70) return '整体可用';
  if (score >= 50) return '需要复核';
  if (score >= 30) return '高风险';
  return '不可用';
}

function renderEvalDiagnosis(report, dimensions) {
  const score = evalSafeScore(report?.score);
  setEvalText('eval-diagnosis-level', evalDiagnosisLevel(score));
  const list = document.getElementById('eval-diagnosis-list');
  if (!list) return;
  const probes = Array.isArray(report?.probes) ? report.probes : [];
  const caps = Array.isArray(report?.caps) ? report.caps : [];
  const metrics = report?.metrics || {};
  const items = [];
  if (caps.length) {
    items.push(`命中 ${caps.length} 条硬上限规则，最终综合分被压到 ${Math.min(...caps.map(c => Number(c.capValue || 0))).toFixed(0)} 分以内。`);
  }
  const relation = metrics.modelRelation || 'unknown';
  const reported = report?.reportedModel || '';
  if (reported) {
    items.push(`响应模型字段为 ${reported}，与请求模型关系：${evalRelationLabel(relation)}。`);
  }
  probes
    .filter(p => p.status !== 'skip' && (p.status !== 'pass' || evalSafeScore(p.score) < 75))
    .sort((a, b) => evalSafeScore(a.score) - evalSafeScore(b.score))
    .slice(0, 4)
    .forEach(p => items.push(`${p.id} ${p.name}: ${p.summary || evalStatusLabel(p.status)}`));
  if (!items.length && dimensions.length) {
    const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0];
    items.push(`${weakest.label} 当前为 ${weakest.score}%，其它关键探针未发现明显异常。`);
  }
  list.innerHTML = items.map(item => `<li>${escAttr(item)}</li>`).join('');
}

function resetEvalReportChrome() {
  currentEvalProgressId = '';
  setEvalText('eval-report-state', '未开始');
  setEvalText('eval-report-target', '请选择供应商和模型');
  setEvalText('eval-report-id', '--');
  setEvalText('eval-report-clock', '--');
  setEvalText('eval-progress-text', '等待检测');
  setEvalText('eval-progress-score', '--');
  setEvalText('eval-footnote-left', '暂无报告');
  setEvalText('eval-footnote-right', '本机检测 · 完整探针');
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '0%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'idle';
  updateEvalRadar(0, EVAL_DIMENSIONS.map(dim => ({ ...dim, score: 0, probes: [] })));
  renderEvalDimensions([]);
  setEvalText('eval-diagnosis-level', '综合判定');
  const diagnosis = document.getElementById('eval-diagnosis-list');
  if (diagnosis) diagnosis.innerHTML = '';
  const capCard = document.getElementById('eval-cap-card');
  if (capCard) capCard.classList.add('no-caps');
  setEvalText('eval-cap-limit', '未命中硬上限');
  const capBox = document.getElementById('eval-caps');
  if (capBox) capBox.innerHTML = '<div class="eval-cap-row eval-cap-row-ok"><span class="eval-cap-pill">OK</span><div><strong>暂无硬上限命中</strong><small>完整检测完成后显示封顶规则</small></div></div>';
  renderEvalChecks('eval-capability-checks', [], '完整检测完成后显示能力支持情况');
  renderEvalChecks('eval-protocol-checks', [], '完整检测完成后显示调用方式兼容情况');
}

function renderEvalRunning(provider, model) {
  currentEvalProgressId = '';
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (empty) {
    empty.style.display = 'grid';
    empty.textContent = '正在执行全面检测...';
  }
  if (result) result.style.display = 'none';
  setEvalText('eval-report-state', '检测中');
  setEvalText('eval-report-target', `${provider?.name || '--'} · ${model || '--'} · 全面检测`);
  setEvalText('eval-report-id', 'pending');
  setEvalText('eval-report-clock', evalFormatTime(Date.now()));
  setEvalText('eval-progress-text', '准备执行完整探针');
  setEvalText('eval-progress-score', `0 / ${getEvalTotalForSelected()}`);
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'running';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '2%';
  document.querySelector('.eval-progress-panel')?.classList.add('is-running');
}

function renderEvalFailure(provider, model, message) {
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (empty) {
    empty.style.display = 'grid';
    empty.textContent = '检测失败，请查看日志';
  }
  if (result) result.style.display = 'none';
  setEvalText('eval-report-state', '失败');
  setEvalText('eval-report-target', `${provider?.name || '--'} · ${model || '--'}`);
  setEvalText('eval-report-id', '--');
  setEvalText('eval-report-clock', evalFormatTime(Date.now()));
  setEvalText('eval-progress-text', String(message || '检测失败').slice(0, 80));
  setEvalText('eval-progress-score', '--');
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'fail';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '0%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
}

function applyEvalProgress(payload) {
  if (!payload || !evalRunning) return;
  if (!currentEvalProgressId && payload.reportId) {
    currentEvalProgressId = payload.reportId;
    setEvalText('eval-report-id', payload.reportId);
  }
  if (currentEvalProgressId && payload.reportId && payload.reportId !== currentEvalProgressId) return;
  const completed = Number(payload.completed || 0);
  const total = Number(payload.total || 0) || getEvalTotalForSelected();
  const percent = Math.max(2, Math.min(98, Math.round((completed / total) * 100)));
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = `${percent}%`;
  setEvalText('eval-progress-score', `${Math.min(completed, total)} / ${total}`);
  if (payload.phase === 'started') {
    setEvalText('eval-progress-text', '开始执行完整探针');
    return;
  }
  if (payload.phase === 'finished') {
    setEvalText('eval-progress-text', '正在生成报告');
    setEvalText('eval-progress-score', `${total} / ${total}`);
    if (fill) fill.style.width = '100%';
    return;
  }
  const probe = [payload.probeId, payload.probeName].filter(Boolean).join(' ');
  const status = payload.status ? ` · ${evalStatusLabel(payload.status)}` : '';
  const score = payload.status && payload.status !== 'skip' ? ` · ${Number(payload.score || 0).toFixed(0)}分` : '';
  setEvalText('eval-progress-text', `${probe || '探针完成'}${status}${score}`);
}

async function bindEvalProgressListener() {
  if (!tauriEvent?.listen || evalProgressUnlisten) return;
  evalProgressUnlisten = await tauriEvent.listen('provider-eval-progress', (event) => {
    applyEvalProgress(event.payload || {});
  });
}

function renderEvalReport(report) {
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (!report) {
    currentEvalReportId = '';
    if (empty) {
      empty.style.display = 'grid';
      empty.textContent = '暂无报告';
    }
    if (result) result.style.display = 'none';
    ['eval-score', 'eval-risk', 'eval-requests', 'eval-duration', 'eval-reported-model', 'eval-token-speed', 'eval-ttft', 'eval-output-tokens', 'eval-score-cap-count', 'eval-score-probe-count', 'eval-score-model-relation'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '--';
        el.style.color = '';
        el.title = '';
      }
    });
    const riskStat = document.querySelector('.eval-stat-risk');
    if (riskStat) delete riskStat.dataset.level;
    const meta = document.getElementById('eval-report-meta');
    if (meta) meta.textContent = '--';
    resetEvalReportChrome();
    renderEvalHistory();
    return;
  }

  currentEvalReportId = report.id || '';
  if (empty) empty.style.display = 'none';
  if (result) result.style.display = 'grid';

  const score = Number(report.score || 0);
  const scoreEl = document.getElementById('eval-score');
  if (scoreEl) scoreEl.textContent = score.toFixed(0);
  const riskEl = document.getElementById('eval-risk');
  if (riskEl) {
    riskEl.textContent = evalScoreBand(score);
    riskEl.style.color = evalRiskColor(report.riskLevel);
  }
  const riskStat = document.querySelector('.eval-stat-risk');
  if (riskStat) riskStat.dataset.level = report.riskLevel || '';
  const requestEl = document.getElementById('eval-requests');
  if (requestEl) requestEl.textContent = String(report.usage?.requestCount || 0);
  const durationEl = document.getElementById('eval-duration');
  if (durationEl) durationEl.textContent = evalFormatDuration(report.durationMs);
  const metrics = report.metrics || {};
  const reportedModel = report.reportedModel || '';
  const relation = metrics.modelRelation || (reportedModel ? 'unknown' : 'unknown');
  const reportedEl = document.getElementById('eval-reported-model');
  if (reportedEl) {
    reportedEl.textContent = reportedModel || '--';
    reportedEl.title = reportedModel
      ? `请求模型: ${report.model || '--'}\n响应模型: ${reportedModel}\n关系: ${evalRelationLabel(relation)}`
      : '响应中未发现 model 字段';
  }
  const speedEl = document.getElementById('eval-token-speed');
  if (speedEl) {
    const tps = metrics.tokensPerSecond;
    speedEl.textContent = Number.isFinite(Number(tps)) ? Number(tps).toFixed(1) : '--';
  }
  const ttftEl = document.getElementById('eval-ttft');
  if (ttftEl) ttftEl.textContent = metrics.ttftMs == null ? '--' : evalFormatDuration(metrics.ttftMs);
  const outputEl = document.getElementById('eval-output-tokens');
  if (outputEl) {
    const outputTokens = metrics.throughputTokens ?? report.usage?.outputTokens;
    outputEl.textContent = outputTokens == null ? '--' : String(outputTokens);
  }
  const meta = document.getElementById('eval-report-meta');
  if (meta) {
    const modelMeta = reportedModel && reportedModel !== report.model
      ? `${report.model || '--'} → ${reportedModel}`
      : (report.model || reportedModel || '--');
    meta.textContent = `${report.providerName || '--'} · ${modelMeta} · 全面检测 · 触发 ${Array.isArray(report.caps) ? report.caps.length : 0} 条 cap`;
  }
  const verdict = document.getElementById('eval-verdict');
  if (verdict) verdict.textContent = report.verdict || '--';

  const caps = Array.isArray(report.caps) ? report.caps : [];
  const capBox = document.getElementById('eval-caps');
  const capCard = document.getElementById('eval-cap-card');
  const capLimit = document.getElementById('eval-cap-limit');
  if (capCard) capCard.classList.toggle('no-caps', !caps.length);
  if (capLimit) {
    capLimit.textContent = caps.length
      ? `最严上限 ≤ ${Math.min(...caps.map(c => Number(c.capValue || 0))).toFixed(0)} 分`
      : '未命中硬上限';
  }
  if (capBox) {
    capBox.innerHTML = caps.length
      ? caps.map(c => `
        <div class="eval-cap-row">
          <span class="eval-cap-pill">≤ ${Number(c.capValue || 0).toFixed(0)}</span>
          <div>
            <strong>${escAttr(c.reason || c.rule || '硬上限规则命中')}</strong>
            <small>规则: ${escAttr(c.rule || '--')}</small>
          </div>
        </div>`).join('')
      : '<div class="eval-cap-row eval-cap-row-ok"><span class="eval-cap-pill">OK</span><div><strong>无硬上限命中</strong><small>综合分未被 cap 规则压低</small></div></div>';
  }
  setEvalText('eval-score-cap-count', `${caps.length} 条`);
  const probesForCount = Array.isArray(report.probes) ? report.probes : [];
  const executedCount = probesForCount.filter(p => p.status !== 'skip').length;
  const skippedCount = probesForCount.length - executedCount;
  setEvalText('eval-score-probe-count', skippedCount ? `${executedCount}/${probesForCount.length}` : `${executedCount} 项`);
  setEvalText('eval-score-model-relation', evalRelationLabel(relation));

  const dimensions = evalDimensionScores(report);
  updateEvalRadar(score, dimensions);
  renderEvalDimensions(dimensions);
  renderEvalDiagnosis(report, dimensions);
  renderEvalChecks('eval-capability-checks', report.capabilityChecks, '该报告没有能力矩阵');
  renderEvalChecks('eval-protocol-checks', report.protocolChecks, '该报告没有协议矩阵');
  setEvalText('eval-report-state', '已完成');
  setEvalText('eval-report-target', `${report.providerName || '--'} · ${report.model || '--'} · 全面检测`);
  setEvalText('eval-report-id', report.id || '--');
  setEvalText('eval-report-clock', evalFormatTime(report.createdAt));
  setEvalText('eval-progress-text', '检测完成');
  setEvalText('eval-progress-score', `${score.toFixed(0)} / 100`);
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'done';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '100%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
  setEvalText('eval-footnote-left', `报告 ID ${report.id || '--'} · ${report.providerName || '--'} · ${evalFormatTime(report.createdAt)}`);
  setEvalText('eval-footnote-right', `本机检测 · 全面探针 · 请求 ${report.usage?.requestCount || 0} · 耗时 ${evalFormatDuration(report.durationMs)}`);

  const body = document.getElementById('eval-probe-body');
  if (body) {
    const probes = Array.isArray(report.probes) ? report.probes : [];
    body.innerHTML = probes.map(p => {
      const evidence = Array.isArray(p.evidence) ? p.evidence : [];
      const evidenceHtml = evidence.length
        ? `<div class="eval-evidence">${evidence.map(x => escAttr(x)).join('<br>')}</div>`
        : '';
      const latency = p.latencyMs == null ? '--' : `${p.latencyMs}ms`;
      const scoreText = p.status === 'skip' ? '--' : Number(p.score || 0).toFixed(1);
      const key = String(p.status || 'skip').toLowerCase();
      return `
        <tr class="eval-probe-row status-${escAttr(key)}">
          <td><span style="font-family:var(--font-mono);font-weight:800;">${escAttr(p.id || '')}</span><div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${escAttr(p.name || '')}</div></td>
          <td>${evalStatusTag(p.status)}</td>
          <td style="font-family:var(--font-mono);font-weight:700;">${scoreText}</td>
          <td style="font-family:var(--font-mono);color:var(--text-muted);">${latency}</td>
          <td><div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">${escAttr(p.summary || '')}</div>${evidenceHtml}</td>
        </tr>`;
    }).join('');
  }
  renderEvalHistory();
}

function renderEvalHistory() {
  const list = document.getElementById('eval-history-list');
  ['evalReportCount', 'evalHistoryPageCount'].forEach(id => {
    const count = document.getElementById(id);
    if (count) count.textContent = `${evalReports.length} 份报告`;
  });
  if (!list) return;
  if (!evalReports.length) {
    list.innerHTML = '<div class="eval-empty-state">暂无历史</div>';
    return;
  }
  list.innerHTML = evalReports.map(r => {
    const active = r.id === currentEvalReportId ? ' active' : '';
    const reportedModel = r.reportedModel || '';
    const modelLine = reportedModel && reportedModel !== r.model
      ? `${r.model || '--'} → ${reportedModel}`
      : (r.model || reportedModel || '--');
    return `
      <div class="eval-history-item${active}" onclick="selectEvalReport('${escAttr(r.id)}')">
        <div class="eval-history-top">
          <div class="eval-history-name">
            <div class="eval-history-provider">${escAttr(r.providerName || '--')}</div>
            <div class="eval-history-model" title="${escAttr(modelLine)}">${escAttr(modelLine)}</div>
          </div>
          <div class="eval-history-score" style="color:${evalRiskColor(r.riskLevel)};">${Number(r.score || 0).toFixed(1)}</div>
        </div>
        <div class="eval-history-meta">
          <span class="eval-history-time">${evalFormatTime(r.createdAt)}</span>
          <button class="btn-ghost eval-history-delete" onclick="deleteEvalReport('${escAttr(r.id)}', event)">删除</button>
        </div>
      </div>`;
  }).join('');
}

function selectEvalReport(id) {
  const report = evalReports.find(r => r.id === id);
  if (!report) return;
  renderEvalReport(report);
  openEvalWorkbenchPage();
}

function openEvalHistoryPage() {
  navigateTo('eval-history');
  renderEvalHistory();
}

function openEvalWorkbenchPage() {
  navigateTo('eval');
}

async function loadEvalReports() {
  if (!invoke) {
    evalReports = [];
    renderEvalHistory();
    return;
  }
  try {
    evalReports = await invoke('list_eval_reports') || [];
    const current = evalReports.find(r => r.id === currentEvalReportId);
    renderEvalReport(current || evalReports[0] || null);
  } catch (e) {
    evalReports = [];
    renderEvalHistory();
    addLog('warn', '检测报告加载失败: ' + e);
  }
}

function setEvalRunning(running) {
  evalRunning = running;
  const btn = document.getElementById('evalRunBtn');
  if (!btn) return;
  btn.disabled = running;
  btn.classList.toggle('running', running);
  btn.textContent = running ? '检测中...' : '开始检测';
  btn.style.opacity = running ? '.72' : '1';
  btn.style.cursor = running ? 'default' : 'pointer';
}

async function startEval() {
  if (evalRunning) return;
  const providerId = document.getElementById('eval-provider-select')?.value || '';
  const model = document.getElementById('eval-model-select')?.value || '';
  const mode = 'standard';
  const selectedChecks = getSelectedEvalChecks();
  const provider = getEvalProvider(providerId);
  if (!provider || !model) {
    showCustomAlert('请选择已启用的供应商和模型。', '无法检测', 'warn');
    return;
  }

  setEvalRunning(true);
  renderEvalRunning(provider, model);
  addLog('info', `开始检测「${provider.name} / ${model}」`);
  try {
    const report = await invoke('run_provider_eval', {
      request: { providerId, model, mode, selectedChecks }
    });
    evalReports = [report, ...evalReports.filter(r => r.id !== report.id)].slice(0, 20);
    renderEvalReport(report);
    await loadEvalReports();
    addLog('ok', `检测完成：${provider.name} / ${model}，得分 ${Number(report.score || 0).toFixed(1)}`);
  } catch (e) {
    addLog('err', '检测失败: ' + e);
    renderEvalFailure(provider, model, e);
    showCustomAlert(String(e), '检测失败', 'error');
  } finally {
    setEvalRunning(false);
  }
}

async function deleteEvalReport(id, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  if (!(await showCustomConfirm('确定删除这份检测报告？', '删除确认', 'warn'))) return;
  try {
    evalReports = await invoke('delete_eval_report', { id }) || [];
    renderEvalReport(evalReports[0] || null);
    addLog('info', '已删除检测报告');
  } catch (e) {
    addLog('err', '删除检测报告失败: ' + e);
  }
}

async function toggleProviderEnabled(id) {
  if (!invoke) return;
  const key = 'provider:' + id;
  if (_inFlightToggles.has(key)) return;
  const p = providerStore.providers.find(x => x.id === id);
  if (!p) return;
  const next = !(p.enabled !== false);
  _inFlightToggles.add(key);
  try {
    await invoke('set_provider_enabled', { id, enabled: next });
    p.enabled = next;
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    addLog('ok', `供应商「${p.name}」已${next ? '启用' : '禁用'}`);
  } catch (e) {
    addLog('err', '启用状态切换失败: ' + e);
  } finally {
    _inFlightToggles.delete(key);
  }
}

async function deleteProvider(id) {
  const p = providerStore.providers.find(x => x.id === id);
  if (!(await showCustomConfirm(`确定删除供应商「${p ? p.name : id}」？`, '删除确认', 'warn'))) return;
  providerStore.providers = providerStore.providers.filter(x => x.id !== id);
  await persistProviders();
  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
  addLog('info', '已删除供应商');
}

async function persistProviders() {
  if (!invoke) return;
  try {
    await invoke('save_providers', { store: providerStore });
  } catch (e) {
    addLog('err', '保存供应商失败: ' + e);
  }
}

syncEvalCombos();
