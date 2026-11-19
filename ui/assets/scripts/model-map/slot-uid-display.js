// model-map/slot-uid-display.js — 模型显示名模板、上下文长度与思考后缀格式化
import { escapeHtml, escAttr } from '../ui/dom.js';

// ─── 模型映射显示设置模态框（名称前缀 + 后缀 + 高级模板）───
// 跟 sidecar renderTemplate 保持一致:占位符 {prefix} {label} {provider} {apiModel}
// 模板含 {provider} 且 provider 空 → 「未设置」
globalThis.DEFAULT_LABEL_TEMPLATE = '{prefix} {label} ({provider})';
globalThis.SIMPLE_LABEL_TEMPLATE_BASE = '{prefix} {label}';
globalThis.TEMPLATE_VAR_NAMES = ['prefix', 'label', 'provider', 'apiModel', 'slotUid', 'effort', 'context'];
globalThis.labelTemplateModalMode = 'simple';

const UID_EFFORT_TOKENS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking', 'reasoning']);
const UID_MODIFIER_TOKENS = new Set(['fast', 'priority', '1m', 'slow', 'lightning']);

function effortTokenFromUid(uid) {
  const tokens = String(uid || '').toLowerCase().split(/[-_]+/).filter(Boolean);
  while (tokens.length && UID_MODIFIER_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  const last = tokens[tokens.length - 1] || '';
  return UID_EFFORT_TOKENS.has(last) ? last : '';
}

function slotEffortOverride(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['off', 'none', 'disable', 'disabled', 'false', 'no'].includes(raw)) return 'off';
  if (['on', 'enabled', 'true'].includes(raw)) return 'high';
  if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(raw)) return raw;
  return 'auto';
}

// 前端本地最小别名映射（与 sidecar/lib/model-aliases.js 保持同源）：
// 旧版简写名 → 新版 Devin Local 唯一官方代表 UID，用于档位自动解析兜底。
const SHORTHAND_TO_DEVIN_CANONICAL = {
  'kimi-k3': 'kimi-k3-high',
  'kimi-k2-8': 'kimi-k2-8',
  'kimi-k2.8': 'kimi-k2-8',
  'kimi-2.8': 'kimi-k2-8',
  'deepseek-v4-pro': 'deepseek-v4-pro-high',
  'deepseek-v4-flash': 'deepseek-v4-flash-high',
  'deepseek-v4-1-flash': 'deepseek-v4-1-flash-high',
  'deepseek-v4.1-flash': 'deepseek-v4-1-flash-high',
  'glm-5-2': 'glm-5-2-max',
  'glm-5.2': 'glm-5-2-max',
  'glm-5-3': 'glm-5-3-high',
  'glm-5.3': 'glm-5-3-high',
  'gemini-3-6-flash': 'gemini-3-6-flash-high',
  'gemini-3.6-flash': 'gemini-3-6-flash-high',
  'gemini-3-7-flash': 'gemini-3-7-flash-high',
  'gemini-3.7-flash': 'gemini-3-7-flash-high',
  'gemini-3-8-flash': 'gemini-3-8-flash-high',
  'gemini-3.8-flash': 'gemini-3-8-flash-high',
  'gemini-3-1-pro': 'gemini-3-1-pro-high',
  'gemini-3.1-pro': 'gemini-3-1-pro-high',
  'claude-opus-5': 'claude-opus-5-high',
  'claude-opus-5-5': 'claude-opus-5-5-high',
  'claude-opus-5.5': 'claude-opus-5-5-high',
  'claude-sonnet-5': 'claude-sonnet-5-medium',
  'claude-sonnet-5-5': 'claude-sonnet-5-5-medium',
  'claude-sonnet-5.5': 'claude-sonnet-5-5-medium',
  'claude-fable-5-1': 'claude-fable-5-1-high',
  'claude-fable-5.1': 'claude-fable-5-1-high',
  'gpt-6-1-sol': 'gpt-6-1-sol-low',
  'gpt-6.1-sol': 'gpt-6-1-sol-low',
  'gpt-6-astra': 'gpt-6-astra-high',
  'gpt-6': 'gpt-6-astra-high',
  'grok-4-7': 'grok-4-7-high',
  'grok-4.7': 'grok-4-7-high',
  'qwen3-8-flash': 'qwen3-8-flash-high',
  'qwen3.8-flash': 'qwen3-8-flash-high',
  'qwen3-8-max': 'qwen3-8-max-high',
  'qwen3.8-max': 'qwen3-8-max-high',
  'minimax-m3-1': 'minimax-m3-1-flash-preview',
  'minimax-m3.1': 'minimax-m3-1-flash-preview',
  'step-5': 'step-5-preview',
  'step5': 'step-5-preview',
  'step5-preview': 'step-5-preview',
  'claude-haiku-5.5': 'claude-haiku-5-5',
  'claude-haiku-5-5': 'claude-haiku-5-5',
  'mistral-large': 'mistral-large-4',
  'hy4': 'hy4-preview',
  'swe-1-6': 'swe-1-6',
  'swe-1-7': 'swe-1-7',
};

function canonicalDevinUidOf(uid) {
  const raw = String(uid || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const norm = lower.replace(/(\d)\.(\d)/g, '$1-$2');
  return SHORTHAND_TO_DEVIN_CANONICAL[lower] || SHORTHAND_TO_DEVIN_CANONICAL[norm] || norm;
}

export function effectiveEffortToken(thinkingEffort, uid) {
  const cfgLevel = slotEffortOverride(thinkingEffort);
  if (cfgLevel === 'off') return '';
  if (cfgLevel !== 'auto') return cfgLevel;
  // 自动模式：简写名先映射为官方规范名再提取档位（deepseek-v4-pro → high）。
  const canonical = canonicalDevinUidOf(uid) || uid || '';
  return effortTokenFromUid(canonical);
}

function stripTrailingEffortToken(name) {
  const s = String(name || '');
  const m = s.match(/[-_\s]([a-z0-9]+)$/i);
  if (m && UID_EFFORT_TOKENS.has(m[1].toLowerCase())) return s.slice(0, m.index).trimEnd();
  return s;
}

function formatEffortDisplay(effort) {
  if (!effort) return '';
  const s = String(effort).toLowerCase();
  const map = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
    none: 'None',
  };
  return map[s] || (s.charAt(0).toUpperCase() + s.slice(1));
}

export function formatContextWindow(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000) {
    const m = n >= 1048576 ? Math.round(n / 1048576) : Math.round(n / 1000000);
    return `${m}M`;
  }
  if (n >= 1000) {
    if (n % 1024 === 0 && n % 1000 !== 0) {
      return `${Math.round(n / 1024)}K`;
    }
    return `${Math.round(n / 1000)}K`;
  }
  return String(n);
}

// 展示层 UID 美化：官方下发 UID 的版本号用连字符分隔（gemini-3-7-flash-high），
// 界面展示还原为点号（gemini-3.7-flash-high），与官方 label 写法一致。
export function displayUidForLabel(uid) {
  const s = String(uid || '');
  if (!s) return '';
  return s.replace(/(\d)-(\d)(?=\b|[-_])/g, '$1.$2');
}

function renderLabelTemplate(tpl, vars, options = {}) {
  const tmpl = (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
  const {
    showSlotUid = false,
    showThinkingEffort = false,
    showContextWindow = false,
  } = options;

  let baseLabel = vars.label || '';
  const effortDisplay = formatEffortDisplay(vars.effort || '');
  const context = vars.context || '';

  const hasEffortVar = /\{effort\}/i.test(tmpl);
  if (showThinkingEffort && effortDisplay && !hasEffortVar) {
    baseLabel = `${stripTrailingEffortToken(baseLabel)} ${effortDisplay}`;
  }

  const hasContextVar = /\{context\}/i.test(tmpl);
  if (showContextWindow && context && !hasContextVar) {
    baseLabel = `${baseLabel} [${context}]`;
  }

  const hasProvider = /\bprovider\b/.test(tmpl);
  const v = {
    prefix: vars.prefix || '',
    label: baseLabel,
    provider: vars.provider || (hasProvider ? '未设置' : ''),
    apiModel: vars.apiModel || '',
    slotUid: vars.slotUid || '',
    effort: effortDisplay,
    context: context,
  };
  let out = tmpl;
  for (const k of TEMPLATE_VAR_NAMES) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), v[k]);
  }
  out = out.replace(/[ \t]{2,}/g, ' ').trim();

  const hasSlotUidVar = /\{slotUid\}/i.test(tmpl);
  if (showSlotUid && vars.slotUid && !hasSlotUidVar && out) {
    out = `${vars.slotUid}>${out}`;
  }

  return out;
}

function normalizedLabelTemplate(tpl) {
  return (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
}

function composeSimpleLabelTemplate(suffix) {
  const cleanSuffix = (suffix || '').trim();
  return cleanSuffix ? `${SIMPLE_LABEL_TEMPLATE_BASE} ${cleanSuffix}` : SIMPLE_LABEL_TEMPLATE_BASE;
}

function suffixFromSimpleLabelTemplate(tpl) {
  const normalized = normalizedLabelTemplate(tpl);
  const match = normalized.match(/^\{prefix\}\s+\{label\}(.*)$/);
  if (!match) return null;
  return (match[1] || '').trim();
}

function currentModalLabelTemplate() {
  const tplInput = document.getElementById('model-label-template-modal');
  if (labelTemplateModalMode === 'custom') {
    return tplInput ? tplInput.value.trim() : '';
  }
  const suffixInput = document.getElementById('model-name-suffix-modal');
  const suffix = suffixInput ? suffixInput.value.trim() : '';
  return composeSimpleLabelTemplate(suffix);
}

function labelTemplateForStoreFromModal() {
  const tpl = currentModalLabelTemplate();
  return normalizedLabelTemplate(tpl) === DEFAULT_LABEL_TEMPLATE ? '' : tpl.trim();
}

// 取 provider 友好名(从当前 providerStore 找,失败回退 id)
function providerNameOf(pid) {
  if (!pid) return '';
  try {
    const list = (typeof providerStore !== 'undefined' && providerStore && Array.isArray(providerStore.providers)) ? providerStore.providers : [];
    const p = list.find(x => x && x.id === pid);
    return p ? (p.name || pid) : pid;
  } catch { return pid; }
}

// 打开显示设置模态框
function openModelMapSettings() {
  const modal = document.getElementById('modelMapSettingsModal');
  if (!modal) {
    console.error('[openModelMapSettings] modal element not found');
    return;
  }
  // 同步当前配置到 input
  const prefixInput = document.getElementById('model-name-prefix-modal');
  const suffixInput = document.getElementById('model-name-suffix-modal');
  const tplInput = document.getElementById('model-label-template-modal');
  const effortCheckbox = document.getElementById('model-show-effort-modal');
  const slotUidCheckbox = document.getElementById('model-show-slot-uid-modal');
  const contextCheckbox = document.getElementById('model-show-context-modal');

  if (prefixInput) prefixInput.value = modelMapStore.namePrefix || '';
  const currentTpl = modelMapStore.labelTemplate || '';
  const simpleSuffix = suffixFromSimpleLabelTemplate(currentTpl);
  labelTemplateModalMode = simpleSuffix === null ? 'custom' : 'simple';
  if (suffixInput) suffixInput.value = simpleSuffix === null ? '' : simpleSuffix;
  if (tplInput) tplInput.value = simpleSuffix === null ? (currentTpl || DEFAULT_LABEL_TEMPLATE) : composeSimpleLabelTemplate(simpleSuffix);

  if (effortCheckbox) effortCheckbox.checked = !!modelMapStore.showThinkingEffort;
  if (slotUidCheckbox) slotUidCheckbox.checked = !!modelMapStore.showSlotUid;
  if (contextCheckbox) contextCheckbox.checked = !!modelMapStore.showContextWindow;

  const advanced = document.getElementById('label-template-advanced');
  if (advanced) advanced.open = labelTemplateModalMode === 'custom';
  // 渲染预览
  updateModalLabelTemplatePreview();
  modal.classList.add('is-open');
}

function closeModelMapSettings() {
  const modal = document.getElementById('modelMapSettingsModal');
  if (modal) modal.classList.remove('is-open');
}

function onModalSimpleLabelInput() {
  labelTemplateModalMode = 'simple';
  const tplInput = document.getElementById('model-label-template-modal');
  const suffixInput = document.getElementById('model-name-suffix-modal');
  if (tplInput) tplInput.value = composeSimpleLabelTemplate(suffixInput ? suffixInput.value : '');
  updateModalLabelTemplatePreview();
}

function onModalAdvancedLabelTemplateInput() {
  labelTemplateModalMode = 'custom';
  updateModalLabelTemplatePreview();
}

function onModalDisplayOptionChange() {
  updateModalLabelTemplatePreview();
}

// 快速设置前缀
function setQuickPrefix(val) {
  const prefixInput = document.getElementById('model-name-prefix-modal');
  if (!prefixInput) return;
  prefixInput.value = val || '';
  onModalSimpleLabelInput();
}

// 快速设置后缀
function setQuickSuffix(val) {
  const suffixInput = document.getElementById('model-name-suffix-modal');
  if (!suffixInput) return;
  suffixInput.value = val || '';
  onModalSimpleLabelInput();
}

// 在高级模板输入框光标处插入占位符或符号胶囊
function insertTemplateToken(token) {
  const tplInput = document.getElementById('model-label-template-modal');
  if (!tplInput) return;
  labelTemplateModalMode = 'custom';
  const advanced = document.getElementById('label-template-advanced');
  if (advanced && !advanced.open) advanced.open = true;

  const start = tplInput.selectionStart ?? tplInput.value.length;
  const end = tplInput.selectionEnd ?? tplInput.value.length;
  const val = tplInput.value;

  // 智能补空格：如果插入的是占位符，且前面不是空格或左括号/分隔符，补前导空格
  let insertText = token;
  const isVar = /^\{.*\}$/.test(token);
  if (isVar && start > 0 && !/[\s(\[{>]/.test(val.charAt(start - 1))) {
    insertText = ' ' + insertText;
  }
  if (isVar && end < val.length && !/[\s)\]}]/.test(val.charAt(end))) {
    insertText = insertText + ' ';
  }

  tplInput.value = val.substring(0, start) + insertText + val.substring(end);
  tplInput.focus();
  const newPos = start + insertText.length;
  tplInput.setSelectionRange(newPos, newPos);

  updateModalLabelTemplatePreview();
}

// 一键应用推荐预设模板
function applyPresetTemplate(tpl) {
  const tplInput = document.getElementById('model-label-template-modal');
  if (!tplInput) return;
  labelTemplateModalMode = 'custom';
  const advanced = document.getElementById('label-template-advanced');
  if (advanced && !advanced.open) advanced.open = true;
  tplInput.value = tpl || '';
  tplInput.focus();
  updateModalLabelTemplatePreview();
}

function onLabelTemplateAdvancedToggle() {
  const advanced = document.getElementById('label-template-advanced');
  const tplInput = document.getElementById('model-label-template-modal');
  if (advanced && advanced.open && labelTemplateModalMode !== 'custom' && tplInput) {
    tplInput.value = currentModalLabelTemplate();
  }
}

// 兼容旧的事件名
function onModalLabelTemplateInput() {
  updateModalLabelTemplatePreview();
}

// 模态框里输入变化 → 实时刷新预览
function updateModalLabelTemplatePreview() {
  const tplInput = document.getElementById('model-label-template-modal');
  const tpl = currentModalLabelTemplate();
  const preview = document.getElementById('label-template-preview');
  if (!preview) return;
  if (labelTemplateModalMode === 'simple' && tplInput) tplInput.value = tpl;
  const prefixInput = document.getElementById('model-name-prefix-modal');
  const prefix = prefixInput ? prefixInput.value.trim() : '';

  const showEffort = !!document.getElementById('model-show-effort-modal')?.checked;
  const showSlotUid = !!document.getElementById('model-show-slot-uid-modal')?.checked;
  const showContext = !!document.getElementById('model-show-context-modal')?.checked;
  const opts = { showSlotUid, showThinkingEffort: showEffort, showContextWindow: showContext };

  // 同步卡片高亮样式
  document.getElementById('opt-row-effort')?.classList.toggle('active', showEffort);
  document.getElementById('opt-row-slotuid')?.classList.toggle('active', showSlotUid);
  document.getElementById('opt-row-context')?.classList.toggle('active', showContext);

  // 实时预览数据源：优先取用户当前实际配置的前 3 个槽位！所见即所得！
  let cases = [];
  const configuredSlots = (modelMapStore && Array.isArray(modelMapStore.slots))
    ? modelMapStore.slots.filter(s => s && s.enabled !== false && s.modelUid)
    : [];

  if (configuredSlots.length > 0) {
    cases = configuredSlots.slice(0, 4).map(s => {
      const orig = originalNameOf(s.modelUid);
      const customName = s.displayName && s.displayName.trim();
      const baseName = customName || orig;
      const firstTarget = (s.targets && s.targets[0]) || null;
      const providerName = firstTarget ? providerNameOf(firstTarget.providerId) : '';
      const apiModel = firstTarget ? firstTarget.model : '';
      const slotThinkingEffort = (firstTarget && firstTarget.thinkingEffort) || s.thinkingEffort || '';
      return {
        from: s.modelUid,
        slotUid: s.modelUid,
        label: baseName,
        provider: providerName,
        apiModel: apiModel,
        effort: effectiveEffortToken(slotThinkingEffort, s.modelUid),
        context: formatContextWindow(s.contextWindow),
      };
    });
  }

  const subtitleEl = document.getElementById('label-template-preview-subtitle');
  if (cases.length > 0) {
    if (subtitleEl) subtitleEl.textContent = '基于当前已添加模型实时呈现';
  } else {
    if (subtitleEl) subtitleEl.textContent = '未添加模型，展示官方代表性示例';
    cases = [
      { from: 'gemini-3.8-flash-high', slotUid: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash', provider: 'CPA', apiModel: 'gemini-3.8-flash', effort: 'high', context: '1M' },
      { from: 'gemini-3.7-flash-high', slotUid: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash', provider: '黑鸟白', apiModel: 'gemini-3.7-flash', effort: 'high', context: '1M' },
      { from: 'claude-opus-4-8-medium', slotUid: 'claude-opus-4-8-medium', label: 'Claude Opus 4.8', provider: '君の公益', apiModel: 'claude-opus-4-8', effort: 'medium', context: '1M' },
      { from: 'glm-5-2-max', slotUid: 'glm-5-2-max', label: 'GLM 5.2', provider: '', apiModel: 'glm-5.2', effort: 'max', context: '128K' },
    ];
  }
  const html = cases.map(c => {
    const out = renderLabelTemplate(tpl, { prefix, ...c }, opts);
    return `<div class="label-preview-row">
      <span class="label-preview-orig" title="${escapeHtml(c.from)}">${escapeHtml(c.from)}</span>
      <span class="label-preview-arrow">→</span>
      <span class="label-preview-result" title="${escapeHtml(out)}">${escapeHtml(out)}</span>
    </div>`;
  }).join('');
  preview.innerHTML = html;
}

// 模态框保存按钮:同步字段 + 持久化 + 重新渲染列表
async function saveModelMapSettingsFromModal() {
  const prefixInput = document.getElementById('model-name-prefix-modal');
  const suffixInput = document.getElementById('model-name-suffix-modal');
  const tplInput = document.getElementById('model-label-template-modal');
  const effortCheckbox = document.getElementById('model-show-effort-modal');
  const slotUidCheckbox = document.getElementById('model-show-slot-uid-modal');
  const contextCheckbox = document.getElementById('model-show-context-modal');

  const newPrefix = prefixInput ? prefixInput.value.trim() : '';
  const newTpl = labelTemplateForStoreFromModal();
  const newShowEffort = !!effortCheckbox?.checked;
  const newShowSlotUid = !!slotUidCheckbox?.checked;
  const newShowContext = !!contextCheckbox?.checked;

  const prevPrefix = modelMapStore.namePrefix || '';
  const prevTpl = modelMapStore.labelTemplate || '';
  const prevShowEffort = !!modelMapStore.showThinkingEffort;
  const prevShowSlotUid = !!modelMapStore.showSlotUid;
  const prevShowContext = !!modelMapStore.showContextWindow;

  let changed = false;
  if (newPrefix !== prevPrefix) { modelMapStore.namePrefix = newPrefix; changed = true; }
  if (newTpl !== prevTpl) { modelMapStore.labelTemplate = newTpl; changed = true; }
  if (newShowEffort !== prevShowEffort) { modelMapStore.showThinkingEffort = newShowEffort; changed = true; }
  if (newShowSlotUid !== prevShowSlotUid) { modelMapStore.showSlotUid = newShowSlotUid; changed = true; }
  if (newShowContext !== prevShowContext) { modelMapStore.showContextWindow = newShowContext; changed = true; }

  if (!changed) {
    addLog('info', '未改动');
    closeModelMapSettings();
    return;
  }
  if (await persistModelMap()) {
    await renderModelMap();
    const parts = [];
    if (newPrefix !== prevPrefix) parts.push(newPrefix ? `前缀=${newPrefix}` : '清除前缀');
    if (newTpl !== prevTpl) {
      if (labelTemplateModalMode === 'custom') {
        parts.push(newTpl ? `高级格式=${newTpl}` : '默认格式');
      } else {
        const suffix = suffixInput ? suffixInput.value.trim() : '';
        parts.push(suffix ? `后缀=${suffix}` : '清除后缀');
      }
    }
    if (newShowEffort !== prevShowEffort) parts.push(`思考档位=${newShowEffort ? '显示' : '隐藏'}`);
    if (newShowSlotUid !== prevShowSlotUid) parts.push(`原始槽位=${newShowSlotUid ? '显示' : '隐藏'}`);
    if (newShowContext !== prevShowContext) parts.push(`上下文=${newShowContext ? '显示' : '隐藏'}`);
    addLog('ok', `显示名设置已更新（${parts.join('，')}）`);
    closeModelMapSettings();
  } else {
    // 持久化失败 → 回滚
    modelMapStore.namePrefix = prevPrefix;
    modelMapStore.labelTemplate = prevTpl;
    modelMapStore.showThinkingEffort = prevShowEffort;
    modelMapStore.showSlotUid = prevShowSlotUid;
    modelMapStore.showContextWindow = prevShowContext;
    if (prefixInput) prefixInput.value = prevPrefix;
    if (tplInput) tplInput.value = prevTpl;
    const prevSuffix = suffixFromSimpleLabelTemplate(prevTpl);
    if (suffixInput) suffixInput.value = prevSuffix === null ? '' : prevSuffix;
    labelTemplateModalMode = prevSuffix === null ? 'custom' : 'simple';
    addLog('err', '保存显示设置失败');
  }
}

// ─── 模型槽位管理（旧字段 injected，解锁 Windsurf 灰色模型）───
// modelMapStore.injected: [{ label, modelUid, providerId, model, apiFormat, unlock, supportsImages }]
// 加载时确保存在（兼容旧 model-map.json）
globalThis.injectedCatalog = null;     // 128 模型内置目录（首次调用时加载）
globalThis.slotVisibilityRows = [];
globalThis.slotVisibilityDirty = false;

globalThis.UNLOCK_SCOPE_LABELS = {
  all: '全部槽位',
  common: '常用槽位',
  claude: 'Claude',
  gpt: 'GPT / Codex',
  gemini: 'Gemini',
  code: 'Code / SWE',
  configured: '已配置 BYOK',
};

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.renderLabelTemplate = renderLabelTemplate;
  g.normalizedLabelTemplate = normalizedLabelTemplate;
  g.composeSimpleLabelTemplate = composeSimpleLabelTemplate;
  g.suffixFromSimpleLabelTemplate = suffixFromSimpleLabelTemplate;
  g.currentModalLabelTemplate = currentModalLabelTemplate;
  g.labelTemplateForStoreFromModal = labelTemplateForStoreFromModal;
  g.providerNameOf = providerNameOf;
  g.openModelMapSettings = openModelMapSettings;
  g.closeModelMapSettings = closeModelMapSettings;
  g.onModalSimpleLabelInput = onModalSimpleLabelInput;
  g.onModalAdvancedLabelTemplateInput = onModalAdvancedLabelTemplateInput;
  g.onModalDisplayOptionChange = onModalDisplayOptionChange;
  g.setQuickPrefix = setQuickPrefix;
  g.setQuickSuffix = setQuickSuffix;
  g.insertTemplateToken = insertTemplateToken;
  g.applyPresetTemplate = applyPresetTemplate;
  g.onLabelTemplateAdvancedToggle = onLabelTemplateAdvancedToggle;
  g.onModalLabelTemplateInput = onModalLabelTemplateInput;
  g.updateModalLabelTemplatePreview = updateModalLabelTemplatePreview;
  g.saveModelMapSettingsFromModal = saveModelMapSettingsFromModal;
})(globalThis);
