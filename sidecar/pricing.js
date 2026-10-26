// pricing.js — 内置模型估算单价（每百万 token，USD）。
//
// 定位：给仪表盘一个**量级正确**的成本估算，不是账单。价格随厂商调整，
// 未知模型一律走 DEFAULT 并在快照里标记为未定价，不假装精确。
// 匹配顺序自上而下，先命中先得；正则只描述模型族，不列穷举型号。

const PRICING = [
  // Anthropic Claude（Opus/Sonnet/Haiku 取同一档，宁可高估不漏计）
  { match: /claude/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // OpenAI
  { match: /gpt-5|gpt-4\.1|gpt-4o/i, input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  { match: /^o[34](-|$)/i, input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  // Google Gemini
  { match: /gemini.*flash/i, input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
  { match: /gemini/i, input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
  // 国产/第三方常见族
  { match: /deepseek/i, input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  { match: /kimi|moonshot/i, input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
  { match: /glm/i, input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.6 },
  { match: /qwen/i, input: 0.4, output: 1.2, cacheRead: 0.1, cacheWrite: 0.4 },
  { match: /mimo|minimax/i, input: 0.3, output: 1.2, cacheRead: 0.075, cacheWrite: 0.3 },
  { match: /grok/i, input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2 },
];

const DEFAULT_PRICING = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/**
 * 返回模型单价与是否为内置价。
 * @param {string} model
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, priced: boolean }}
 */
export function priceFor(model) {
  const name = String(model || '');
  for (const row of PRICING) {
    if (row.match.test(name)) {
      return { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, priced: true };
    }
  }
  return { ...DEFAULT_PRICING, priced: false };
}

/**
 * 单模型用量成本（USD）。
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} usage
 * @param {string} model
 */
export function costOf(usage, model) {
  const p = priceFor(model);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (
    (n(usage?.input) * p.input
      + n(usage?.output) * p.output
      + n(usage?.cacheRead) * p.cacheRead
      + n(usage?.cacheWrite) * p.cacheWrite) / 1_000_000
  );
}

/**
 * 按模型用量估算总成本。
 * @param {Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number }>} byModelUsage
 * @returns {{ totalUsd: number, unpricedModels: string[] }}
 */
export function estimateCost(byModelUsage = {}) {
  let totalUsd = 0;
  const unpricedModels = [];
  for (const [model, usage] of Object.entries(byModelUsage)) {
    if (!usage) continue;
    const price = priceFor(model);
    if (!price.priced) unpricedModels.push(model);
    totalUsd += costOf(usage, model);
  }
  return { totalUsd, unpricedModels };
}

export const __pricingTest = { PRICING, DEFAULT_PRICING };
