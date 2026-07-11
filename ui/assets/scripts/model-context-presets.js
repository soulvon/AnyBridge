/**
 * 主流模型推荐上下文配置
 * 数据源：../model-context-presets.json
 * 规则：有推荐配置就用推荐；没有则用 defaults
 * 匹配：精确 > 边界匹配；短/歧义 token 仅精确匹配，避免误伤
 */
const PRESETS = await fetch(new URL('../model-context-presets.json', import.meta.url), {
  cache: 'no-cache',
})
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .catch((err) => {
    console.warn('[model-context-presets] 加载失败，使用内置默认值', err);
    return {
      version: 0,
      defaults: { maxInputTokens: 128000, maxOutputTokens: 8192 },
      models: [],
      patterns: [],
    };
  });

function normalizeModelId(modelId) {
  return String(modelId || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .trim();
}

function defaultsOf() {
  const d = PRESETS?.defaults || {};
  return {
    maxInputTokens: Number(d.maxInputTokens) || 128000,
    maxOutputTokens: Number(d.maxOutputTokens) || 8192,
  };
}

/** 短 token / 版本碎片：只允许精确匹配，避免 o1、m2.7、seed 误伤 */
function isAmbiguousToken(token) {
  const t = String(token || '').toLowerCase();
  if (!t) return true;
  if (t.length <= 3) return true;
  // 无分隔符的短串：seed、gpt5、glm5、k2.5、m2.7
  if (t.length < 5 && !t.includes('-') && !t.includes('_') && !t.includes('/')) return true;
  // 版本碎片：m2.7、k2.5、o1.5
  if (/^[a-z]{0,2}\d+(\.\d+)+$/.test(t)) return true;
  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 边界匹配：token 必须是完整片段（两侧为非字母数字或边界）
 * 例：seed 不匹配 seedream；claude-opus-4 可匹配 claude-opus-4-6
 */
function tokenMatches(id, token) {
  const t = String(token || '').toLowerCase();
  if (!t) return false;
  if (id === t) return true;
  if (isAmbiguousToken(t)) {
    // 歧义 token：仅允许作为前缀 + 分隔符（o1-pro、gpt5.4）
    return id.startsWith(`${t}-`) || id.startsWith(`${t}.`) || id.startsWith(`${t}_`);
  }
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`);
  return re.test(id);
}

function matchListHit(id, list) {
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((token) => tokenMatches(id, token));
}

function scoreMatch(id, token) {
  const t = String(token || '').toLowerCase();
  if (!t) return -1;
  if (id === t) return 1000 + t.length;
  if (!tokenMatches(id, t)) return -1;
  // 前缀匹配略优于中间片段
  if (id.startsWith(t)) return 200 + t.length;
  return 100 + t.length;
}

function bestModelEntry(id) {
  const models = Array.isArray(PRESETS?.models) ? PRESETS.models : [];
  let best = null;
  let bestScore = -1;
  for (const entry of models) {
    const tokens = Array.isArray(entry?.match) && entry.match.length
      ? entry.match
      : [entry?.id].filter(Boolean);
    for (const token of tokens) {
      const score = scoreMatch(id, token);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
  }
  return bestScore >= 0 ? best : null;
}

function firstPatternEntry(id) {
  const patterns = Array.isArray(PRESETS?.patterns) ? PRESETS.patterns : [];
  for (const entry of patterns) {
    const includes = entry?.includesAny;
    const requires = entry?.requiresAny;
    if (!matchListHit(id, includes)) continue;
    if (Array.isArray(requires) && requires.length && !matchListHit(id, requires)) continue;
    return entry;
  }
  return null;
}

function resolvePreset(modelId) {
  const id = normalizeModelId(modelId);
  const fallback = defaultsOf();
  if (!id) {
    return { ...fallback, source: 'default', id: '' };
  }

  const modelHit = bestModelEntry(id);
  if (modelHit) {
    return {
      maxInputTokens: Number(modelHit.maxInputTokens) || fallback.maxInputTokens,
      maxOutputTokens: Number(modelHit.maxOutputTokens) || fallback.maxOutputTokens,
      source: 'model',
      id: modelHit.id || id,
      note: modelHit.note || '',
    };
  }

  const patternHit = firstPatternEntry(id);
  if (patternHit) {
    return {
      maxInputTokens: Number(patternHit.maxInputTokens) || fallback.maxInputTokens,
      maxOutputTokens: Number(patternHit.maxOutputTokens) || fallback.maxOutputTokens,
      source: 'pattern',
      id: patternHit.id || id,
      note: patternHit.note || '',
    };
  }

  return { ...fallback, source: 'default', id };
}

export function recommendContextWindow(modelId) {
  return resolvePreset(modelId).maxInputTokens;
}

export function recommendMaxOutputTokens(modelId) {
  return resolvePreset(modelId).maxOutputTokens;
}

export function resolveModelContextPreset(modelId) {
  return resolvePreset(modelId);
}

export function getModelContextPresets() {
  return PRESETS;
}

// 兼容非模块调用
if (typeof globalThis !== 'undefined') {
  globalThis.MODEL_CONTEXT_PRESETS = PRESETS;
  globalThis.recommendContextWindow = recommendContextWindow;
  globalThis.recommendMaxOutputTokens = recommendMaxOutputTokens;
  globalThis.resolveModelContextPreset = resolveModelContextPreset;
}
