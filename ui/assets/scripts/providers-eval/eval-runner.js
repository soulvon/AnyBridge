// providers-eval/eval-runner.js — 模型评测表单、组合下拉选择与评测执行
import { escAttr, escapeHtml } from '../ui/dom.js';

// ═══════ MODEL EVALUATION ═══════
globalThis.evalReports = [];
globalThis.currentEvalReportId = '';
globalThis.evalRunning = false;
globalThis.currentEvalProgressId = '';
globalThis.evalProgressUnlisten = null;
globalThis.EVAL_COMBO_IDS = ['eval-provider-select', 'eval-format-select', 'eval-model-select'];
globalThis.evalRemoteModelCache = new Map();
globalThis.evalRemoteModelPending = new Set();
globalThis.evalModelFetchSeq = 0;

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

function normalizeEvalApiFormat(value, allowAuto = true) {
  const raw = String(value || '').trim().toLowerCase();
  if (allowAuto && raw === 'auto') return 'auto';
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic') return 'anthropic';
  if (raw === 'gemini') return 'gemini';
  return allowAuto ? 'auto' : 'openai';
}

function evalApiFormatLabel(value) {
  const fmt = normalizeEvalApiFormat(value);
  if (fmt === 'auto') return '自动';
  if (fmt === 'openai') return 'OpenAI';
  if (fmt === 'anthropic') return 'Anthropic';
  if (fmt === 'gemini') return 'Gemini';
  return value || '--';
}

function getEvalApiFormat() {
  return normalizeEvalApiFormat(document.getElementById('eval-format-select')?.value || 'auto');
}

function evalRemoteModelCacheKey(providerId, apiFormat) {
  return `${String(providerId || '')}|${normalizeEvalApiFormat(apiFormat, false)}`;
}

function getEvalSavedModelList(provider) {
  if (!provider) return [];
  const models = [];
  if (provider.defaultModel) models.push(provider.defaultModel);
  if (Array.isArray(provider.models)) models.push(...provider.models);
  return normalizeEvalModels(models);
}

function getEvalModelList(provider, apiFormat = getEvalApiFormat()) {
  if (!provider) return [];
  const fmt = normalizeEvalApiFormat(apiFormat);
  const remoteModels = fmt === 'auto'
    ? [
        ...(evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, 'openai')) || []),
        ...(evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, 'anthropic')) || []),
        ...(evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, 'gemini')) || []),
      ]
    : (evalRemoteModelCache.get(evalRemoteModelCacheKey(provider.id, fmt)) || []);
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

function shouldAutoFetchEvalModels() {
  return !!document.getElementById('page-eval')?.classList.contains('active');
}

async function fetchEvalRemoteModels(provider) {
  if (!canFetchEvalModels(provider)) return;
  const requestedFormat = getEvalApiFormat();
  const formats = requestedFormat === 'auto' ? ['openai', 'anthropic', 'gemini'] : [requestedFormat];
  const seq = ++evalModelFetchSeq;
  const modelSelect = document.getElementById('eval-model-select');
  let lastError = null;
  try {
    for (const apiFormat of formats) {
      const cacheKey = evalRemoteModelCacheKey(provider.id, apiFormat);
      if (evalRemoteModelCache.has(cacheKey)) return;
      if (evalRemoteModelPending.has(cacheKey)) return;
      evalRemoteModelPending.add(cacheKey);
      try {
        const result = await invoke('fetch_models', {
          args: {
            host: getEvalProviderFetchHost(provider),
            api_key: provider.apiKey,
            path: provider.apiPath || null,
            api_format: apiFormat,
          }
        });
        if (seq !== evalModelFetchSeq) return;
        const remoteModels = normalizeEvalModels(result?.models || []);
        if (!remoteModels.length) throw new Error('返回的模型列表为空');
        evalRemoteModelCache.set(cacheKey, remoteModels);
        renderEvalModelOptions({ fetchRemote: false });
        lastError = null;
        return;
      } catch (e) {
        lastError = e;
        if (requestedFormat === 'auto') {
          addLog('warn', `自动协议拉取模型：${evalApiFormatLabel(apiFormat)} 未通（${e}）`);
        }
      } finally {
        evalRemoteModelPending.delete(cacheKey);
      }
    }
  } catch (e) {
    lastError = e;
  } finally {
    if (seq !== evalModelFetchSeq) return;
    if (lastError && modelSelect && !getEvalModelList(provider).length) {
      modelSelect.innerHTML = '<option value="">模型拉取失败</option>';
      syncEvalCombos();
    }
    if (lastError) {
      addLog('warn', `检测模型完整列表拉取失败：${provider.name} (${lastError})`);
    }
  }
}

function renderEvalProviderOptions(options = {}) {
  const fetchRemote = options.fetchRemote ?? shouldAutoFetchEvalModels();
  const select = document.getElementById('eval-provider-select');
  if (!select) return;
  const previous = select.value;
  const providers = (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p));
  if (!providers.length) {
    select.innerHTML = '<option value="">无启用供应商</option>';
    renderEvalModelOptions({ fetchRemote });
    syncEvalCombos();
    return;
  }
  select.innerHTML = providers
    .map(p => `<option value="${escAttr(p.id)}">${escAttr(p.name)}</option>`)
    .join('');
  select.value = providers.some(p => p.id === previous) ? previous : providers[0].id;
  renderEvalModelOptions({ fetchRemote });
  syncEvalCombos();
}

function renderEvalModelOptions(options = {}) {
  const fetchRemote = options.fetchRemote ?? shouldAutoFetchEvalModels();
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

globalThis.EVAL_DIMENSIONS = [
  { key: 'protocol', label: '协议合规', ids: ['P1', 'P2', 'P5', 'P13'] },
  { key: 'performance', label: '性能', ids: ['P10', 'P11'] },
  { key: 'safety', label: '安全性', ids: ['P8', 'P14'] },
  { key: 'content', label: '内容完整性', ids: ['P4'] },
  { key: 'capability', label: '能力验证', ids: ['P6', 'P9', 'P11'] },
  { key: 'identity', label: '身份一致', ids: ['P3', 'P7'] },
];

globalThis.EVAL_CHECK_OPTIONS = [
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
      <input type="checkbox" value="${escAttr(opt.id)}" checked data-action="syncEvalCheckButton" data-events="change">
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

  // 检测是否 protocol_offline
  const protocolOffline = caps.some(c => c.rule === 'protocol_offline');
  const p1 = probes.find(p => p.id === 'P1');

  if (caps.length) {
    items.push(`命中 ${caps.length} 条硬上限规则，最终综合分被压到 ${Math.min(...caps.map(c => Number(c.capValue || 0))).toFixed(0)} 分以内。`);
  }

  // 协议不可用时，从 P1 探针 evidence 中提取排查提示
  if (protocolOffline && p1) {
    if (p1.summary) items.push(`P1 协议连通性：${p1.summary}`);
    const hints = (p1.evidence || []).filter(e =>
      e.startsWith('请') || e.startsWith('供应商') || e.startsWith('目标') || e.startsWith('HTTPS') || e.startsWith('响应')
    );
    hints.forEach(h => items.push(`💡 ${h}`));
    const retryInfo = (p1.evidence || []).find(e => e.startsWith('已重试'));
    if (retryInfo) items.push(retryInfo);
  }

  const relation = metrics.modelRelation || 'unknown';
  const reported = report?.reportedModel || '';
  if (reported) {
    items.push(`响应模型字段为 ${reported}，与请求模型关系：${evalRelationLabel(relation)}。`);
  }
  if (!protocolOffline) {
    probes
      .filter(p => p.status !== 'skip' && (p.status !== 'pass' || evalSafeScore(p.score) < 75))
      .sort((a, b) => evalSafeScore(a.score) - evalSafeScore(b.score))
      .slice(0, 4)
      .forEach(p => items.push(`${p.id} ${p.name}: ${p.summary || evalStatusLabel(p.status)}`));
  }
  if (!items.length && dimensions.length) {
    const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0];
    items.push(`${weakest.label} 当前为 ${weakest.score}%，其它关键探针未发现明显异常。`);
  }
  list.innerHTML = items.map(item => `<li>${escAttr(item)}</li>`).join('');
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.getEvalComboParts = getEvalComboParts;
  g.closeEvalCombos = closeEvalCombos;
  g.focusEvalComboOption = focusEvalComboOption;
  g.setEvalComboOpen = setEvalComboOpen;
  g.toggleEvalCombo = toggleEvalCombo;
  g.handleEvalComboTriggerKey = handleEvalComboTriggerKey;
  g.selectEvalComboOption = selectEvalComboOption;
  g.syncEvalCombo = syncEvalCombo;
  g.syncEvalCombos = syncEvalCombos;
  g.getEvalProvider = getEvalProvider;
  g.normalizeEvalModels = normalizeEvalModels;
  g.normalizeEvalApiFormat = normalizeEvalApiFormat;
  g.evalApiFormatLabel = evalApiFormatLabel;
  g.getEvalApiFormat = getEvalApiFormat;
  g.evalRemoteModelCacheKey = evalRemoteModelCacheKey;
  g.getEvalSavedModelList = getEvalSavedModelList;
  g.getEvalModelList = getEvalModelList;
  g.getEvalProviderFetchHost = getEvalProviderFetchHost;
  g.canFetchEvalModels = canFetchEvalModels;
  g.shouldAutoFetchEvalModels = shouldAutoFetchEvalModels;
  g.fetchEvalRemoteModels = fetchEvalRemoteModels;
  g.renderEvalProviderOptions = renderEvalProviderOptions;
  g.renderEvalModelOptions = renderEvalModelOptions;
  g.evalStatusLabel = evalStatusLabel;
  g.evalStatusTag = evalStatusTag;
  g.evalRiskLabel = evalRiskLabel;
  g.evalRiskColor = evalRiskColor;
  g.evalRelationLabel = evalRelationLabel;
  g.evalCheckStatusClass = evalCheckStatusClass;
  g.renderEvalChecks = renderEvalChecks;
  g.evalFormatDuration = evalFormatDuration;
  g.evalFormatTime = evalFormatTime;
  g.renderEvalCheckPicker = renderEvalCheckPicker;
  g.setAllEvalChecks = setAllEvalChecks;
  g.getSelectedEvalChecks = getSelectedEvalChecks;
  g.getEvalTotalForSelected = getEvalTotalForSelected;
  g.syncEvalCheckButton = syncEvalCheckButton;
  g.openEvalCheckModal = openEvalCheckModal;
  g.closeEvalCheckModal = closeEvalCheckModal;
  g.setEvalText = setEvalText;
  g.evalScoreBand = evalScoreBand;
  g.evalSafeScore = evalSafeScore;
  g.evalDimensionScores = evalDimensionScores;
  g.updateEvalRadar = updateEvalRadar;
  g.renderEvalDimensions = renderEvalDimensions;
  g.evalDiagnosisLevel = evalDiagnosisLevel;
  g.renderEvalDiagnosis = renderEvalDiagnosis;
})(globalThis);
