// model-aliases.js — 维护跨版本模型别名与等价 UID 映射
//
// 设计原则：
// 1. 列表展示层（1:1 精确映射）：
//    用户在 AnyBridge 配置的一个槽位，在 IDE 下拉框中必须且只能展示为【一项】。
//    若用户配的是旧版简写名（如 kimi-k3），通过 getCanonicalDevinUid 映射为新版唯一对应项（如 kimi-k3-high）；
//    绝不把同家族的其他推理档位（如 low / max / none / 1m）全部改名，彻底杜绝重复列表！
//
// 2. 请求路由层（多对一容错）：
//    在 getSlot 查找执行槽位时，通过 getEquivalentModelUids 支持别名容错，
//    确保无论 IDE 传过来带不带后缀都能准确命中目标供应商。

export function normalizeModelUid(str) {
  return String(str || '').replace(/(\d)\.(\d)/g, '$1-$2');
}

// 常见旧版简写名 -> 新版 Devin Local 唯一官方代表 UID (1:1 映射)
const SHORTHAND_TO_DEVIN_CANONICAL = {
  'kimi-k3': 'kimi-k3-high',
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
  'claude-sonnet-5': 'claude-sonnet-5-medium',
  'swe-1-6': 'swe-1-6',
  'swe-1-7': 'swe-1-7',
};

// 路由容错等价组（仅用于请求执行阶段的 getSlot 容错匹配）
const ROUTING_EQUIVALENT_GROUPS = [
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

const ROUTING_MAP = new Map();
for (const group of ROUTING_EQUIVALENT_GROUPS) {
  for (const item of group) {
    const key = item.toLowerCase();
    const dotKey = normalizeModelUid(key);
    const existing = ROUTING_MAP.get(key) || new Set();
    for (const other of group) {
      existing.add(other);
      existing.add(normalizeModelUid(other));
    }
    ROUTING_MAP.set(key, existing);
    ROUTING_MAP.set(dotKey, existing);
  }
}

/**
 * 获取某个 modelUid 在新版 Devin Local 下的唯一对应 UID（1:1 映射）
 * 用于构建界面下拉框，保证一个槽位对应一个下拉条目。
 * @param {string} modelUid 
 * @returns {string}
 */
export function getCanonicalDevinUid(modelUid) {
  if (!modelUid) return '';
  const raw = String(modelUid).trim();
  const lower = raw.toLowerCase();
  const norm = normalizeModelUid(lower);
  return SHORTHAND_TO_DEVIN_CANONICAL[lower] || SHORTHAND_TO_DEVIN_CANONICAL[norm] || normalizeModelUid(raw);
}

/**
 * 兼容旧导出名
 */
export const getPreferredDevinModelUid = getCanonicalDevinUid;

/**
 * 获取某个 modelUid 的所有可能别名组（用于请求路由阶段的 getSlot 容错查找）
 * @param {string} modelUid 
 * @returns {string[]}
 */
export function getEquivalentModelUids(modelUid) {
  if (!modelUid) return [];
  const key = String(modelUid).trim().toLowerCase();
  const dotKey = normalizeModelUid(key);
  const set = ROUTING_MAP.get(key) || ROUTING_MAP.get(dotKey);
  if (!set) return [modelUid];
  return Array.from(set);
}
