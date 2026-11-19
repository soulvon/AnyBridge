// lib/rename/template-and-catalog.js — 槽位标签模板、目录加载与改名/解锁配置构造

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config-dir.js';
import { getEquivalentModelUids, getCanonicalDevinUid } from '../model-aliases.js';
import { WINDSURF_CATALOG } from '../../windsurf-catalog.js';

export const RUNTIME_MODEL_SLOT_STATUS = new Map();

export function getRuntimeModelSlotStatus(modelUid) {
  if (!modelUid) return null;
  return RUNTIME_MODEL_SLOT_STATUS.get(modelUid) || null;
}

// 渲染显示模板。
//   tpl: 例如 "{prefix} {label} ({provider})",为空则用 DEFAULT_LABEL_TEMPLATE
//   vars: { prefix, label, provider, apiModel }
//     - prefix 可为空串(用户不想要前缀)
//     - label 必填,空 label 会渲染为空模板结果
//     - provider 为空时,若模板包含 {provider} 占位符 → 替换为「未设置」;否则填空串
//     - apiModel 可为空串
// 渲染后会 trim 收尾,再去掉连续多空格,避免出现 "(BYOK) Claude ()" 之类的尾巴。
//
// 变量白名单(避免用户模板里写别的占位符导致泄漏):
//   {prefix} {label} {provider} {apiModel} {slotUid} {effort} {context}
const DEFAULT_LABEL_TEMPLATE = '{prefix} {label} ({provider})';
const TEMPLATE_VARS = ['prefix', 'label', 'provider', 'apiModel', 'slotUid', 'effort', 'context'];
const UNLOCK_SCOPES = new Set(['all', 'common', 'configured', 'claude', 'gpt', 'gemini', 'code']);
const SLOT_VISIBILITY_MODES = new Set(['mapped', 'official', 'all']);

function normalizeUnlockScope(mode) {
  const s = String(mode || '').trim();
  return UNLOCK_SCOPES.has(s) ? s : 'all';
}

export function normalizeSlotVisibilityMode(mode) {
  const s = String(mode || '').trim();
  return SLOT_VISIBILITY_MODES.has(s) ? s : 'official';
}

// 官方 protobuf GetUserStatus 的 field22 modelUid 用连字符分隔版本号
// （如 gemini-3-7-flash-high、gpt-5-6-sol-medium），但 JSON API 与内置 catalog
// 部分条目用点分隔（如 gemini-3.7-flash-high、gpt-5.6-sol）。
// 归一到连字符格式，确保 rename 槽位 key 能命中官方响应里的 modelUid。
export function normalizeModelUid(uid) {
  return String(uid || '').replace(/(\d)\.(\d)/g, '$1-$2');
}

function isCommonManagedSlot(uid, label = '') {
  const s = `${uid || ''} ${label || ''}`.toLowerCase();
  return /claude|opus|sonnet|haiku|gpt|codex|gemini|kimi|swe|grok|glm|deepseek/.test(s);
}

export function slotMatchesUnlockScope(uid, label, unlockScope) {
  const mode = normalizeUnlockScope(unlockScope);
  const s = `${uid || ''} ${label || ''}`.toLowerCase();
  if (mode === 'all') return true;
  if (mode === 'common') return isCommonManagedSlot(uid, label);
  if (mode === 'claude') return /claude|opus|sonnet|haiku/.test(s);
  if (mode === 'gpt') return /gpt|openai|o3|o4|codex/.test(s);
  if (mode === 'gemini') return /gemini|google/.test(s);
  if (mode === 'code') return /swe|code|codex|grok/.test(s);
  return false;
}

export function fallbackRewritePlan(uid, label, unlockScope, slotVisibilityMode, wasDisabled, ctx = null) {
  const visibility = normalizeSlotVisibilityMode(slotVisibilityMode);
  if (visibility === 'mapped') {
    // 只显示已映射槽位：未映射但官方原本可用的项也禁用掉。
    return wasDisabled ? null : { status: 'hidden', disabled: true };
  }
  if (visibility === 'official') {
    // 映射槽位 + 官方模型：只标记并保留官方本来可用的项，不放出灰色项。
    return wasDisabled ? null : { status: 'official', disabled: false };
  }
  // 全部模型：官方项标为「官方」，灰色项按解锁范围放出并标为「未配置」。
  if (!wasDisabled) return { status: 'official', disabled: false };
  if (!slotMatchesUnlockScope(uid, label, unlockScope)) return null;
  return { status: 'unconfigured', disabled: false };
}

export function visibleOverridePlan(uid, wasDisabled, slotVisibility) {
  if (!slotVisibility || !slotVisibility.has(uid)) return null;
  if (slotVisibility.get(uid) === false) return { status: 'hidden', disabled: true };
  return { status: wasDisabled ? 'unconfigured' : 'official', disabled: false };
}

export function renderTemplate(tpl, vars) {
  const tmpl = (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
  // provider 为空 → 模板里包含 {provider} 时,显示「未设置」(兄弟硬性要求)
  const hasProvider = /\bprovider\b/.test(tmpl);
  const v = {
    prefix:   vars.prefix   || '',
    label:    vars.label    || '',
    provider: vars.provider || (hasProvider ? '未设置' : ''),
    apiModel: vars.apiModel || '',
    slotUid:  vars.slotUid  || '',
    effort:   vars.effort   || '',
    context:  vars.context  || '',
  };
  let out = tmpl;
  for (const k of TEMPLATE_VARS) {
    // 词边界匹配 {key},忽略大小写
    const re = new RegExp(`\\{${k}\\}`, 'g');
    out = out.replace(re, v[k]);
  }
  // 合并连续多空格 + trim
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

// modelUid 尾部的档位/修饰 token，词表与 lib/thinking-effort.js 保持一致。
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

function effectiveEffortToken(thinkingEffort, uid) {
  const cfgLevel = slotEffortOverride(thinkingEffort);
  if (cfgLevel === 'off') return '';
  if (cfgLevel !== 'auto') return cfgLevel;
  // 自动模式下先用规范官方 UID 剥离：旧版简写名（kimi-k3 / deepseek-v4-pro /
  // glm-5-2 等）本身不带档位后缀，其官方规范名（kimi-k3-high / deepseek-v4-pro-high /
  // glm-5-2-max）才带。直接解析简写名会把 'pro'、'k3' 误当名字尾巴而漏判档位。
  const canonical = getCanonicalDevinUid(uid) || uid || '';
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

function formatContextWindow(num) {
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

// 展示层 UID 美化：官方下发 UID 里的版本号用连字符分隔（gemini-3-7-flash-high、
// glm-5-2-max），界面直接裸展示可读性差。把「单数字-单数字」还原为点号版本
// （3-7 → 3.7、5-2 → 5.2、2-6 → 2.6），与官方 label 的 "Gemini 3.7 Flash" 写法一致。
// 仅处理单个数字间的连字符，不会误伤 deepseek-v4-pro（4 是 v 前缀的一部分）、
// kimi-k3、swe-1-6（模式不符）这类非版本片段。
function displayUidForLabel(uid) {
  const s = String(uid || '');
  if (!s) return '';
  return s.replace(/(\d)-(\d)(?=\b|[-_])/g, '$1.$2');
}

export function formatSlotLabel(customName, fallbackLabel, uid, opts = {}) {
  const {
    labelTemplate = '',
    namePrefix = '',
    providerName = '未配置',
    apiModel = '',
    thinkingEffort = '',
    contextWindow = null,
    showSlotUid = false,
    showThinkingEffort = false,
    showContextWindow = false,
  } = opts;

  let baseLabel = (customName && customName.trim()) || fallbackLabel || uid || '';
  const effort = effectiveEffortToken(thinkingEffort, uid);
  const effortDisplay = formatEffortDisplay(effort);
  const context = formatContextWindow(contextWindow);

  const tpl = (labelTemplate && labelTemplate.trim()) || DEFAULT_LABEL_TEMPLATE;
  const hasEffortVar = /\{effort\}/i.test(tpl);
  if (showThinkingEffort && effortDisplay && !hasEffortVar) {
    baseLabel = `${stripTrailingEffortToken(baseLabel)} ${effortDisplay}`;
  }

  const hasContextVar = /\{context\}/i.test(tpl);
  if (showContextWindow && context && !hasContextVar) {
    baseLabel = `${baseLabel} [${context}]`;
  }

  const displayUid = displayUidForLabel(uid);
  const vars = {
    prefix: namePrefix,
    label: baseLabel,
    provider: providerName,
    apiModel,
    slotUid: displayUid,
    effort: effortDisplay,
    context: context || '',
  };
  let rendered = renderTemplate(labelTemplate, vars);

  const hasSlotUidVar = /\{slotUid\}/i.test(tpl);
  if (showSlotUid && uid && !hasSlotUidVar && rendered) {
    rendered = `${displayUid}>${rendered}`;
  }

  return rendered;
}

export function configuredLabelFromRuntime(cfg, fallbackLabel, uid, labelTemplate, namePrefix, ctx = null) {
  if (!cfg || cfg.source !== 'rename') return cfg ? cfg.newLabel : '';
  const opts = {
    labelTemplate: (ctx && ctx.labelTemplate) || labelTemplate,
    namePrefix: (ctx && ctx.namePrefix) || namePrefix,
    providerName: cfg.providerName || '未配置',
    apiModel: cfg.apiModel || '',
    thinkingEffort: cfg.thinkingEffort || '',
    contextWindow: cfg.contextWindow || null,
    showSlotUid: !!(ctx && ctx.showSlotUid),
    showThinkingEffort: !!(ctx && ctx.showThinkingEffort),
    showContextWindow: !!(ctx && ctx.showContextWindow),
  };
  return formatSlotLabel(cfg.customName, fallbackLabel, uid, opts);
}

export function configuredApiIdForUid(uid) {
  const catalog = catalogByUid().get(uid);
  return catalog?.apiId || (!String(uid || '').startsWith('MODEL_') ? uid : '');
}

export function uniqueConfiguredApiId(apiId, uid) {
  const base = String(apiId || '').trim();
  if (!base) return '';
  const s = String(uid || '').toLowerCase();
  if (s.includes('thinking')) return `${base}-thinking`;
  if (s.includes('xhigh')) return `${base}-xhigh`;
  if (s.includes('high')) return `${base}-high`;
  if (s.includes('medium')) return `${base}-medium`;
  if (s.includes('low')) return `${base}-low`;
  if (s.includes('fast')) return `${base}-fast`;
  return `${base}-${s.replace(/^model_/, '').replace(/[^a-z0-9]+/g, '-')}`;
}

// 内置兜底:captured ide-models.json 不存在或缺某 modelUid 时，用这张已知表查原始 label。
// 覆盖默认预设的 3 个槽位 + 常见可被改名的模型，确保新装(从未抓过 GetUserStatus)也能改名。
export const BUILTIN_LABELS = {
  MODEL_XAI_GROK_3: 'xAI Grok-3',
  MODEL_XAI_GROK_3_MINI_REASONING: 'xAI Grok-3 mini Thinking',
  MODEL_PRIVATE_4: 'Grok Code Fast 1',
};

// 已实测这些原生槽位不会稳定上传图片。即使目标 BYOK 模型支持 Vision，
// 也不能把它们伪装成 supportsImages=true，否则 IDE 下拉框会误导用户。
export const IMAGE_UNSAFE_NATIVE_SLOT_IDS = new Set([
  'MODEL_XAI_GROK_3',
  'MODEL_XAI_GROK_3_MINI_REASONING',
]);

export function canDeclareImagesForSlot(uid) {
  return !IMAGE_UNSAFE_NATIVE_SLOT_IDS.has(uid);
}

// 完整 catalog 兜底: 新形态 modelUid（如 claude-opus-4-8-*、kimi-k2-6、swe-1-6 等）
// Windsurf 客户端的 GetUserStatus 响应里用 API 级 ID 作为 modelUid (field22)，
// 这些新形态不在 ide-models.json（只抓了旧 MODEL_* 枚举）里。
// 加载内置 windsurf-catalog.json 取原始 label 兜底，避免改名被跳过。
let _catalogLabels = null;
export function catalogLabels() {
  if (_catalogLabels !== null) return _catalogLabels;
  _catalogLabels = new Map();
  for (const m of catalogModels()) {
    if (m.modelUid && m.label) _catalogLabels.set(m.modelUid, m.label);
  }
  return _catalogLabels;
}

let _catalogModels = null;
export function catalogModels() {
  if (_catalogModels !== null) return _catalogModels;
  const byUid = new Map();
  const add = (m) => {
    if (!m || !m.modelUid) return;
    const existing = byUid.get(m.modelUid) || {};
    byUid.set(m.modelUid, {
      label: m.label || existing.label || m.modelUid,
      modelUid: m.modelUid,
      apiId: m.apiId || existing.apiId || null,
      supportsImages: m.supportsImages !== false,
      contextWindow: m.contextWindow || existing.contextWindow || null,
    });
  };
  try {
    let raw;
    const candidates = [];
    const resDir = process.env.BYOK_RESOURCE_DIR;
    if (resDir) candidates.push(path.join(resDir, 'sidecar', 'windsurf-catalog.json'));
    candidates.push(new URL('./windsurf-catalog.json', import.meta.url));
    candidates.push(path.join(process.cwd(), 'windsurf-catalog.json'));
    for (const candidate of candidates) {
      try {
        raw = fs.readFileSync(candidate, 'utf8');
        if (raw) break;
      } catch { /* ignore */ }
    }
    if (raw) {
      const obj = JSON.parse(raw);
      for (const m of (obj.models || [])) add(m);
    }
  } catch { /* ignore */ }
  for (const m of WINDSURF_CATALOG || []) add(m);

  // UI 侧 list_ide_models 会把缓存和内置表合并。sidecar 没有 Rust 内置表，
  // 这里至少并入已缓存/已抓取的额外 modelUid，避免已出现在管理页的槽位无法合成。
  for (const name of ['ide-models.json', 'windsurf-models.json']) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(configDir(), name), 'utf8'));
      for (const e of (c.models || [])) {
        if (!e.modelUid || !e.label || String(e.label).startsWith('http')) continue;
        add({
          modelUid: e.modelUid,
          label: e.label,
          apiId: e.apiId || null,
          supportsImages: e.supportsImages !== false,
        });
      }
    } catch { /* ignore */ }
  }

  _catalogModels = [...byUid.values()];
  return _catalogModels;
}

let _catalogByUid = null;
export function catalogByUid() {
  if (_catalogByUid !== null) return _catalogByUid;
  _catalogByUid = new Map();
  for (const m of catalogModels()) _catalogByUid.set(m.modelUid, m);
  return _catalogByUid;
}

// 供 thinking-effort.js 使用：按 modelUid 查 catalog 条目（label/apiId），
// 点/横杠两种分隔符都尝试（官方响应用横杠，catalog 部分条目用点）。
export function catalogEntryForUid(uid) {
  const raw = String(uid || '');
  if (!raw) return null;
  const byUid = catalogByUid();
  return byUid.get(raw) || byUid.get(raw.replace(/(\d)\.(\d)/g, '$1-$2')) || null;
}

// 供 thinking-effort.js 做兄弟档位探测：返回全部 catalog modelUid 的 Map。
export function catalogEntries() {
  return catalogByUid();
}

// 改名表来源:model-map.json 的槽位。需要把「原始 label → 新名」
// 配对，但 model-map 只有 modelUid+displayName，原始 label 来自 captured ide-models.json
// (优先) 或内置 BUILTIN_LABELS (兜底)。热加载，每次响应读最新配置。
//
// namePrefix（全局前缀）: 当 namePrefix 非空时，所有已路由模型的显示名前面都会拼接该前缀。
//   有自定义 displayName 的槽位: "{prefix} {displayName}"
//   无自定义 displayName 的槽位: "{prefix} {原始label}"
// namePrefix 为空时，行为与之前一致（只有 displayName 非空才改名）。
export function buildRenameTable() {
  const dir = configDir();
  let slots = [];
  let namePrefix = '';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.json'), 'utf8'));
    slots = Array.isArray(m.slots) ? m.slots : [];
    namePrefix = (m.namePrefix || '').trim();
  } catch { /* 无配置 → 空表，不改名 */ }

  let captured = new Map();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'ide-models.json'), 'utf8'));
    for (const e of (c.models || [])) captured.set(e.modelUid, e.label);
  } catch { /* 无 captured → 退化为只用内置兜底表 */ }

  const pairs = [];
  for (const s of slots) {
    if (s.enabled === false) continue; // 未路由=保持原名（与 provider-pool 分流判断一致）
    const orig = captured.get(s.modelUid) || BUILTIN_LABELS[s.modelUid];
    if (!orig) continue;
    const customName = s.displayName && s.displayName.trim();
    if (namePrefix) {
      // 有全局前缀时：无论是否有自定义 displayName，都拼接前缀
      const baseName = customName || orig;
      const newName = `${namePrefix} ${baseName}`;
      if (newName !== orig) pairs.push([orig, newName]);
    } else if (customName) {
      // 无全局前缀且自定义名非空：仅改自定义名
      if (orig !== customName) pairs.push([orig, customName]);
    }
    // 无前缀且无自定义名：跳过，显示原名
  }
  // 顺序先长后短，避免短 label 抢先匹配长 label 的前缀。
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

export function buildUnlockSet() {
  const dir = configDir();
  const byUid = new Map();
  let unlockAll = true;

  let namePrefix = '';
  let labelTemplate = '';
  let showSlotUid = false;
  let showThinkingEffort = false;
  let showContextWindow = false;
  let unlockScope = 'all';
  let slotVisibilityMode = 'official';
  let slotVisibility = new Map();
  let slots = [];
  let injected = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.json'), 'utf8'));
    namePrefix = (m.namePrefix || '').trim();
    labelTemplate = (m.labelTemplate || '').trim();
    showSlotUid = m.showSlotUid === true;
    showThinkingEffort = m.showThinkingEffort === true;
    showContextWindow = m.showContextWindow === true;
    unlockScope = normalizeUnlockScope(m.unlockScope || m.slotDisplayMode);
    slotVisibilityMode = normalizeSlotVisibilityMode(m.slotVisibilityMode);
    unlockAll = !(m.enhancement && typeof m.enhancement === 'object' && m.enhancement.unlockModels === false);
    for (const item of (Array.isArray(m.slotVisibility) ? m.slotVisibility : [])) {
      if (item && item.modelUid) slotVisibility.set(item.modelUid, item.visible !== false);
    }
    slots = Array.isArray(m.slots) ? m.slots : [];
    injected = Array.isArray(m.injected) ? m.injected : [];
  } catch { /* 无配置 → 使用默认槽位显示策略 */ }

  // 读取 captured ide-models.json (rename 需要原始 label)
  let captured = new Map();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'ide-models.json'), 'utf8'));
    for (const e of (c.models || [])) captured.set(e.modelUid, e.label);
  } catch { /* 无 captured → 退化为只用内置兜底表 */ }

  // 读取 providers.json (injected 需要 provider 名称)
  const providerNames = new Map();
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    for (const pv of (p.providers || [])) providerNames.set(pv.id, pv.name);
  } catch { /* 无 providers → 注入项显示"未配置" */ }

  // 1) 槽位改名（路由项）
  for (const s of slots) {
    if (s.enabled === false) continue;
    if (!s.modelUid) continue;
    // 归一化槽位 modelUid：点/连字符版本号差异统一为官方连字符格式，
    // 确保与 protobuf field22 的 modelUid 精确命中（否则点格式槽位会匹配失败）。
    const uid = normalizeModelUid(s.modelUid);
    // 三级 label 查找: captured (用户抓的) > catalog (新形态 API ID) > BUILTIN_LABELS (旧兜底)
    const orig = captured.get(uid) || catalogLabels().get(uid) || BUILTIN_LABELS[uid] || '';
    const customName = s.displayName && s.displayName.trim();
    const providerName = (s.targets && s.targets[0] && providerNames.get(s.targets[0].providerId)) || '未配置';
    const apiModel = (s.targets && s.targets[0] && s.targets[0].model) || '';
    const slotThinkingEffort = (s.targets && s.targets[0] && s.targets[0].thinkingEffort) || s.thinkingEffort || '';
    const slotContextWindow = Number(s.contextWindow);
    const validContextWindow = Number.isFinite(slotContextWindow) && slotContextWindow > 0
      ? Math.trunc(slotContextWindow)
      : null;
    const newLabel = formatSlotLabel(customName, orig, uid, {
      labelTemplate,
      namePrefix,
      providerName,
      apiModel,
      thinkingEffort: slotThinkingEffort,
      contextWindow: validContextWindow,
      showSlotUid,
      showThinkingEffort,
      showContextWindow,
    });
    const slotEntry = {
      newLabel,
      customName,
      providerName,
      apiModel,
      thinkingEffort: slotThinkingEffort,
      wantImages: s.supportsImages !== false && canDeclareImagesForSlot(uid),
      contextWindow: validContextWindow,
      source: 'rename',
    };
    byUid.set(uid, slotEntry);

    // 贴合使用习惯：严格 1:1 映射！
    // 若槽位填的是旧版简写名（如 kimi-k3、deepseek-v4-pro），仅挂载新版 Devin Local 的唯一对应项（如 kimi-k3-high），
    // 绝不将同家族的 low / max / 1m 等其它档位一并改名，杜绝重复列表！
    const canonicalUid = getCanonicalDevinUid(s.modelUid);
    if (canonicalUid && canonicalUid !== uid && !byUid.has(canonicalUid)) {
      byUid.set(canonicalUid, {
        ...slotEntry,
        isAlias: true,
        aliasOf: uid,
      });
    }
  }

  // 2) 注入项（解锁灰色模型）
  for (const i of injected) {
    if (!i.modelUid) continue;
    const providerName = (i.providerId && providerNames.get(i.providerId)) || '未配置';
    // 三级查找: captured > catalog > 注入项的 label (兜底)
    const orig = captured.get(i.modelUid) || catalogLabels().get(i.modelUid) || i.label;
    const newLabel = renderTemplate(labelTemplate, {
      prefix: namePrefix,
      label: i.label,
      provider: providerName,
      apiModel: i.model || '',
    });
    if (newLabel === orig) continue;
    const injEntry = {
      newLabel,
      wantImages: i.supportsImages !== false && canDeclareImagesForSlot(i.modelUid),
      source: 'injected',
    };
    const normUid = normalizeModelUid(i.modelUid);
    byUid.set(normUid, injEntry);

    const canonicalUid = getCanonicalDevinUid(i.modelUid);
    if (canonicalUid && canonicalUid !== normUid && !byUid.has(canonicalUid)) {
      byUid.set(canonicalUid, {
        ...injEntry,
        isAlias: true,
        aliasOf: normUid,
      });
    }
  }

  // Devin/Windsurf 客户端会基于隐藏 apiId 做二次去重。若两个 BYOK 槽位
  // 克隆同一个官方 apiId（例如 Claude 4.5 / Claude 4.5 Thinking），下拉框会少一项。
  // 只对重复的已配置槽位写唯一 apiId，保持无冲突槽位继续使用 catalog 元数据。
  const apiBuckets = new Map();
  for (const [uid, cfg] of byUid) {
    if (!cfg || cfg.source !== 'rename') continue;
    const apiId = configuredApiIdForUid(uid);
    if (!apiId) continue;
    if (!apiBuckets.has(apiId)) apiBuckets.set(apiId, []);
    apiBuckets.get(apiId).push(uid);
  }
  for (const [apiId, uids] of apiBuckets) {
    if (uids.length <= 1) continue;
    for (const uid of uids.slice(1)) {
      const cfg = byUid.get(uid);
      if (cfg) cfg.apiIdOverride = uniqueConfiguredApiId(apiId, uid);
    }
  }

  // 3) 不再单独预填 unlock-prefix 项;改由 rewriteForUnlock 在递归到
  //    每个 ClientModelConfig 时直接从原 label 读出 + 加 (BYOK) 前缀,
  //    这样即使 modelUid 不在 captured/catalog 里也能正确处理。

  // 4) 默认 provider: 取 providers 的第一个（按数组顺序），作为「未单独配置」项的后缀兜底
  //    没有 provider → 渲染时由 renderTemplate 决定(模板含 {provider} → 「未设置」)
  let defaultProviderName = '';
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    const list = (p && Array.isArray(p.providers)) ? p.providers : [];
    if (list.length > 0 && list[0] && list[0].name) {
      defaultProviderName = list[0].name;
    }
  } catch { /* 无 providers → 走 renderTemplate 的「未设置」兜底 */ }

  return {
    unlockAll,
    byUid,
    defaultProviderName,
    labelTemplate,
    namePrefix,
    unlockScope,
    slotVisibilityMode,
    slotVisibility,
    showSlotUid,
    showThinkingEffort,
    showContextWindow,
  };
}

// 在一个 protobuf 子 message 中查找 field1 (label) 的字符串值。
// 返回字符串或 null。给 unlock-prefix 用: 即使 catalog 没收录, 也能从原响应里直接读出 label。
