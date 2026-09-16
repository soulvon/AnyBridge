// model-aliases.js — 维护跨版本模型别名与等价 UID 映射
//
// 背景：
// 旧版 Windsurf/Cascade 通常使用无后缀的简写模型名（如 kimi-k3, deepseek-v4-pro）。
// 新版 Devin Local (devin.exe / ACP) 内部白名单只认带具体思考档位的精确名称（如 kimi-k3-high, deepseek-v4-pro-high）。
// 本模块提供双向等价解析：
//   1. getEquivalentModelUids(uid): 获取某模型的所有等价 UID（包含新旧版本命名）。
//   2. getPreferredDevinModelUid(uid): 获取新版 Devin Local 首选的精确 UID。

export function normalizeModelUid(str) {
  return String(str || '').replace(/(\d)\.(\d)/g, '$1-$2');
}

const ALIAS_GROUPS = [
  ['kimi-k3', 'kimi-k3-high', 'kimi-k3-max', 'kimi-k3-low'],
  ['kimi-k2-6', 'kimi-k2.6'],
  ['kimi-k2-7', 'kimi-k2.7'],
  ['deepseek-v4-pro', 'deepseek-v4-pro-high', 'deepseek-v4-pro-max'],
  ['deepseek-v4-flash', 'deepseek-v4-flash-high', 'deepseek-v4-flash-max'],
  ['deepseek-v4-1-flash', 'deepseek-v4.1-flash', 'deepseek-v4-1-flash-high', 'deepseek-v4-1-flash-max'],
  ['glm-5-2', 'glm-5.2', 'glm-5-2-max', 'glm-5-2-high', 'glm-5-2-none', 'glm-5-2-1m', 'glm-5-2-max-1m'],
  ['glm-5-3', 'glm-5.3', 'glm-5-3-high', 'glm-5-3-low', 'glm-5-3-max'],
  ['gemini-3-6-flash-high', 'gemini-3.6-flash-high', 'gemini-3-6-flash', 'gemini-3.6-flash'],
  ['gemini-3-7-flash-high', 'gemini-3.7-flash-high', 'gemini-3-7-flash', 'gemini-3.7-flash'],
  ['gemini-3-8-flash-high', 'gemini-3.8-flash-high', 'gemini-3-8-flash', 'gemini-3.8-flash'],
  ['gemini-3-1-pro', 'gemini-3.1-pro', 'gemini-3-1-pro-high', 'gemini-3-1-pro-low'],
  ['claude-opus-5', 'claude-opus-5-high', 'claude-opus-5-medium', 'claude-opus-5-max'],
  ['claude-sonnet-5', 'claude-sonnet-5-medium', 'claude-sonnet-5-high'],
  ['swe-1-6', 'swe-1-6-fast', 'swe-1-6-slow'],
  ['swe-1-7', 'swe-1-7-medium'],
];

// 构建双向索引表
const EQUIVALENT_MAP = new Map();
const PREFERRED_DEVIN_MAP = new Map();

for (const group of ALIAS_GROUPS) {
  // 首选 Devin Local UID：如果有带 -high 或 -max 的全称，优先选之，否则选第一项
  const preferred = group.find(id => id.endsWith('-high') || id.endsWith('-max')) || group[0];
  for (const item of group) {
    const key = item.toLowerCase();
    const dotKey = normalizeModelUid(key);
    
    // 合并集合
    const existing = EQUIVALENT_MAP.get(key) || new Set();
    for (const other of group) {
      existing.add(other);
      existing.add(normalizeModelUid(other));
    }
    EQUIVALENT_MAP.set(key, existing);
    EQUIVALENT_MAP.set(dotKey, existing);

    PREFERRED_DEVIN_MAP.set(key, preferred);
    PREFERRED_DEVIN_MAP.set(dotKey, preferred);
  }
}

/**
 * 获取某个 modelUid 的所有等价名称集合（数组）
 * @param {string} modelUid 
 * @returns {string[]}
 */
export function getEquivalentModelUids(modelUid) {
  if (!modelUid) return [];
  const key = String(modelUid).trim().toLowerCase();
  const dotKey = normalizeModelUid(key);
  const set = EQUIVALENT_MAP.get(key) || EQUIVALENT_MAP.get(dotKey);
  if (!set) return [modelUid];
  return Array.from(set);
}

/**
 * 获取新版 Devin Local 认可的首选模型 UID
 * @param {string} modelUid 
 * @returns {string}
 */
export function getPreferredDevinModelUid(modelUid) {
  if (!modelUid) return '';
  const key = String(modelUid).trim().toLowerCase();
  const dotKey = normalizeModelUid(key);
  return PREFERRED_DEVIN_MAP.get(key) || PREFERRED_DEVIN_MAP.get(dotKey) || modelUid;
}
