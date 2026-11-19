// lib/rename/json-and-specs.js — GetUserStatus JSON 改写与模型槽位规格构造

import { getCanonicalDevinUid } from '../model-aliases.js';
import {
  BUILTIN_LABELS,
  canDeclareImagesForSlot,
  catalogByUid,
  catalogLabels,
  catalogModels,
  configuredLabelFromRuntime,
  fallbackRewritePlan,
  normalizeSlotVisibilityMode,
  renderTemplate,
  visibleOverridePlan,
} from './template-and-catalog.js';

// 全局替换 JSON 文本里的旧 label 为新 label（带引号边界，避免误伤子串）。
export function renameInJson(text, pairs) {
  let changed = 0;
  for (const [oldLabel, newLabel] of pairs) {
    const needle = `"${oldLabel}"`;
    const repl = `"${newLabel}"`;
    let from = 0;
    while (true) {
      const pos = text.indexOf(needle, from);
      if (pos === -1) break;
      text = text.slice(0, pos) + repl + text.slice(pos + needle.length);
      changed++;
      from = pos + repl.length;
    }
  }
  return { text, changed };
}

export function hiddenByVisibility(uid, slotVisibility) {
  return !!(slotVisibility && slotVisibility.has(uid) && slotVisibility.get(uid) === false);
}

export function visibleByOverride(uid, slotVisibility) {
  return !!(slotVisibility && slotVisibility.has(uid) && slotVisibility.get(uid) !== false);
}

export function markRuntime(runtimeStatus, uid, label, status, source) {
  if (runtimeStatus && status === 'unconfigured') {
    runtimeStatus.set(uid, { label: label || uid, status, source });
  }
}

export function existingRewriteSpec(uid, origLabel, wasDisabled, cfg, ctx) {
  if (hiddenByVisibility(uid, ctx.slotVisibility)) return { keep: false };

  if (cfg) {
    return {
      keep: true,
      uid,
      newLabel: configuredLabelFromRuntime(cfg, origLabel, uid, ctx.labelTemplate, ctx.namePrefix, ctx),
      wantImages: cfg.wantImages,
      apiIdOverride: cfg.apiIdOverride || '',
      contextWindow: cfg.contextWindow || null,
      disabled: false,
      status: 'configured',
      source: cfg.source || 'rename',
    };
  }

  if (!ctx.unlockAll) return { keep: true, passthrough: true };

  const overridePlan = visibleByOverride(uid, ctx.slotVisibility)
    ? visibleOverridePlan(uid, wasDisabled, ctx.slotVisibility)
    : null;
  const plan = overridePlan || fallbackRewritePlan(
    uid,
    origLabel,
    ctx.unlockScope,
    ctx.slotVisibilityMode,
    wasDisabled,
    ctx
  );
  if (!plan || plan.status === 'hidden') return { keep: false };

  const labelText = origLabel || uid;
  const newLabel = renderTemplate(ctx.labelTemplate, {
    prefix: '',
    label: labelText,
    provider: plan.status === 'unconfigured' ? '未配置' : '官方',
    apiModel: '',
  });
  markRuntime(ctx.runtimeStatus, uid, labelText, plan.status, 'fallback');
  return {
    keep: true,
    uid,
    newLabel,
    wantImages: canDeclareImagesForSlot(uid),
    disabled: plan.disabled,
    status: plan.status,
    source: 'fallback',
  };
}

function configuredMissingSpecs(seenUids, ctx) {
  const specs = [];
  for (const [uid, cfg] of ctx.byUid) {
    if (!uid || seenUids.has(uid) || hiddenByVisibility(uid, ctx.slotVisibility)) continue;
    if (cfg.isAlias) {
      // 1. 如果该别名关联的原槽位已在响应中，不重复注入
      if (cfg.aliasOf && seenUids.has(cfg.aliasOf)) continue;
    } else {
      // 2. 如果主项未在响应中，但其新版规范名已在响应中，不重复注入
      const canonical = getCanonicalDevinUid(uid);
      if (canonical && seenUids.has(canonical)) continue;
    }
    const catalog = catalogByUid().get(uid);
    const fallbackLabel = catalog?.label || catalogLabels().get(uid) || BUILTIN_LABELS[uid] || uid;
    specs.push({
      uid,
      newLabel: configuredLabelFromRuntime(cfg, fallbackLabel, uid, ctx.labelTemplate, ctx.namePrefix, ctx),
      wantImages: cfg.wantImages,
      apiIdOverride: cfg.apiIdOverride || '',
      contextWindow: cfg.contextWindow || null,
      disabled: false,
      status: 'configured',
      source: cfg.source || 'rename',
    });
    seenUids.add(uid);
  }
  return specs;
}

function unconfiguredCatalogMissingSpecs(seenUids, ctx) {
  const specs = [];
  const visibility = normalizeSlotVisibilityMode(ctx.slotVisibilityMode);
  for (const m of catalogModels()) {
    const uid = m.modelUid;
    if (!uid || seenUids.has(uid) || ctx.byUid.has(uid)) continue;
    if (hiddenByVisibility(uid, ctx.slotVisibility)) continue;
    if (visibility !== 'all' && !visibleByOverride(uid, ctx.slotVisibility)) continue;

    const labelText = m.label || uid;
    const newLabel = renderTemplate(ctx.labelTemplate, {
      prefix: '',
      label: labelText,
      provider: '未配置',
      apiModel: '',
    });
    markRuntime(ctx.runtimeStatus, uid, labelText, 'unconfigured', 'catalog');
    specs.push({
      uid,
      newLabel,
      wantImages: m.supportsImages !== false && canDeclareImagesForSlot(uid),
      disabled: false,
      status: 'unconfigured',
      source: 'catalog',
    });
    seenUids.add(uid);
  }
  return specs;
}

export function missingModelSpecs(seenUids, ctx) {
  return [
    ...configuredMissingSpecs(seenUids, ctx),
    ...(ctx.unlockAll ? unconfiguredCatalogMissingSpecs(seenUids, ctx) : []),
  ];
}

export function modelMetadataForUid(uid, contextWindowOverride = null) {
  const catalog = catalogByUid().get(uid) || {};
  const apiId = catalog.apiId || (!String(uid || '').startsWith('MODEL_') ? uid : null);
  const override = Number(contextWindowOverride);
  const catalogWindow = Number(catalog.contextWindow);
  const contextWindow = Number.isFinite(override) && override > 0
    ? Math.trunc(override)
    : (Number.isFinite(catalogWindow) && catalogWindow > 0 ? Math.trunc(catalogWindow) : null);
  return {
    uid,
    apiId,
    contextWindow,
  };
}

/** slot.contextWindow 覆盖 GetUserStatus JSON 条目；无有效覆盖时保持原值。 */
function applyContextWindowToJsonItem(item, spec) {
  if (!item || typeof item !== 'object') return item;
  const n = Number(spec && spec.contextWindow);
  if (!Number.isFinite(n) || n <= 0) return item;
  item.contextWindow = Math.trunc(n);
  return item;
}


export function unlockInJson(text, unlockAll, byUid, defaultProviderName = '', labelTemplate = '', namePrefix = '', unlockScope = 'all', slotVisibilityMode = 'official', slotVisibility = null, runtimeStatus = null, extra = {}) {
  const ctx = {
    unlockAll,
    byUid,
    defaultProviderName,
    labelTemplate,
    namePrefix,
    unlockScope,
    slotVisibilityMode,
    slotVisibility,
    runtimeStatus,
    showSlotUid: extra.showSlotUid === true,
    showThinkingEffort: extra.showThinkingEffort === true,
    showContextWindow: extra.showContextWindow === true,
  };
  try {
    const root = JSON.parse(text);
    const arr = root?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (Array.isArray(arr)) {
      const seenUids = new Set();
      const next = [];
      for (const item of arr) {
        const uid = item && typeof item.modelUid === 'string' ? item.modelUid : '';
        if (!uid) {
          next.push(item);
          continue;
        }
        seenUids.add(uid);
        const cfg = byUid.get(uid);
        const spec = existingRewriteSpec(uid, item.label || uid, item.disabled === true, cfg, ctx);
        if (spec.passthrough) {
          next.push(item);
          continue;
        }
        if (!spec.keep) continue;
        const out = { ...item };
        if (spec.newLabel) out.label = spec.newLabel;
        out.disabled = spec.disabled === true;
        if (typeof spec.wantImages === 'boolean') out.supportsImages = spec.wantImages;
        applyContextWindowToJsonItem(out, spec);
        next.push(out);
      }

      const template = next[0] || arr[0] || {};
      for (const spec of missingModelSpecs(seenUids, ctx)) {
        const out = {
          ...template,
          label: spec.newLabel,
          modelUid: spec.uid,
          disabled: spec.disabled === true,
        };
        if (typeof spec.wantImages === 'boolean') out.supportsImages = spec.wantImages;
        applyContextWindowToJsonItem(out, spec);
        next.push(out);
      }

      root.userStatus.cascadeModelConfigData.clientModelConfigs = next;
      const nextText = JSON.stringify(root);
      return { text: nextText, changed: nextText === text ? 0 : 1 };
    }
  } catch { /* fall back to boundary-based rewrite below */ }

  let changed = 0;
  const uidRe = /"modelUid"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = uidRe.exec(text)) !== null) {
    const uid = m[1];
    const cfg = byUid.get(uid);
    if (!cfg && !unlockAll) continue;
    // 从 modelUid 位置向前找最近的 '{'，向后找匹配的 '}'，确定该条目的 JSON 对象边界
    const objStart = findObjectStart(text, m.index);
    if (objStart === -1) continue;
    const objEnd = findObjectEnd(text, objStart);
    if (objEnd === -1) continue;
    const obj = text.slice(objStart, objEnd + 1);
    const lblM = obj.match(/"label"\s*:\s*"([^"]*)"/);
    const origLabel = lblM ? lblM[1] : '';
    const wasDisabled = /"disabled"\s*:\s*true/.test(obj);
    const overridePlan = visibleOverridePlan(uid, wasDisabled, slotVisibility);
    const plan = (!cfg && unlockAll)
      ? (overridePlan || fallbackRewritePlan(uid, origLabel, unlockScope, slotVisibilityMode, wasDisabled, ctx))
      : null;
    const hideConfigured = !!(cfg && overridePlan && overridePlan.status === 'hidden');
    if (!cfg && unlockAll && !plan) continue;

    // 取配置: 有 cfg 用 cfg；否则按显示策略处理 fallback。
    const wantImages = hideConfigured ? undefined : (cfg
      ? cfg.wantImages
      : (plan && plan.status !== 'hidden' ? canDeclareImagesForSlot(uid) : undefined));
    let newLabel = cfg && !hideConfigured ? configuredLabelFromRuntime(cfg, origLabel, uid, labelTemplate, namePrefix) : null;
    const nextDisabled = hideConfigured ? true : (cfg ? false : (plan ? plan.disabled : false));
    if (!cfg && plan && plan.status !== 'hidden') {
      const labelText = origLabel || uid;
      newLabel = renderTemplate(labelTemplate, {
        prefix: '',
        label: labelText,
        provider: plan.status === 'unconfigured' ? '未配置' : '官方',
        apiModel: '',
      });
      if (runtimeStatus && plan.status === 'unconfigured') {
        runtimeStatus.set(uid, { label: labelText, status: plan.status, source: 'fallback' });
      }
    }

    // 1) label 改写（rename/injected 项才需要）
    let newObj = obj;
    if (newLabel) {
      // 匹配 "label":"..." 替换
      const labelMatch = newObj.match(/"label"\s*:\s*"([^"]*)"/);
      if (labelMatch) {
        // 用 JSON 转义防止 label 含引号
        const escaped = newLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        newObj = newObj.replace(/"label"\s*:\s*"[^"]*"/, `"label":"${escaped}"`);
      }
    }
    // 2) disabled 按策略写入：false 可省略，true 需显式插入。
    if (/"disabled"\s*:\s*(true|false)/.test(newObj)) {
      newObj = newObj.replace(/"disabled"\s*:\s*(true|false)/g, `"disabled":${nextDisabled ? 'true' : 'false'}`);
    } else if (nextDisabled) {
      newObj = newObj.replace(/^\{/, '{"disabled":true,');
    }
    // 3) supportsImages 对齐：隐藏项保持原值，其它项显式对齐。
    if (typeof wantImages === 'boolean') {
      const imgVal = wantImages ? 'true' : 'false';
      if (/"supportsImages"\s*:\s*(true|false)/.test(newObj)) {
        newObj = newObj.replace(/"supportsImages"\s*:\s*(true|false)/g, `"supportsImages":${imgVal}`);
      } else {
        // 紧跟开头的 '{' 插入字段（JSON 对象字段无序，安全）
        newObj = newObj.replace(/^\{/, `{"supportsImages":${imgVal},`);
      }
    }
    // 4) contextWindow：仅 slot 有有效覆盖时写入。
    const slotCtx = cfg && !hideConfigured ? Number(cfg.contextWindow) : NaN;
    if (Number.isFinite(slotCtx) && slotCtx > 0) {
      const ctxVal = String(Math.trunc(slotCtx));
      if (/"contextWindow"\s*:\s*\d+/.test(newObj)) {
        newObj = newObj.replace(/"contextWindow"\s*:\s*\d+/g, `"contextWindow":${ctxVal}`);
      } else {
        newObj = newObj.replace(/^\{/, `{"contextWindow":${ctxVal},`);
      }
    }
    if (newObj !== obj) {
      text = text.slice(0, objStart) + newObj + text.slice(objEnd + 1);
      changed++;
      // 更新 uidRe 的 lastIndex，因为 text 长度可能变了
      uidRe.lastIndex = objStart + newObj.length;
    }
  }
  return { text, changed };
}

// 从 pos 位置向前找最近的不在字符串内的 '{'。
// 反向扫描时需要先判断当前是否在字符串内：从 pos 向前数引号，奇数个则在串内。
function findObjectStart(text, pos) {
  // 先判断 pos 位置是否在字符串内
  let inStr = false;
  for (let k = 0; k <= pos; k++) {
    if (text[k] === '"' && (k === 0 || text[k - 1] !== '\\')) inStr = !inStr;
  }
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    const c = text[i];
    // 跟踪字符串状态（反向）
    if (c === '"' && (i === 0 || text[i - 1] !== '\\')) inStr = !inStr;
    if (inStr) continue;
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// 从 objStart 位置找匹配的 '}'（跳过嵌套对象和字符串）
function findObjectEnd(text, objStart) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = objStart; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
