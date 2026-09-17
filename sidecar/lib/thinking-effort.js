// lib/thinking-effort.js — Devin/Windsurf modelUid 的思考档位(thinking effort)解析与转发
//
// Devin/Windsurf 把思考档位编进模型 UID:
//   gpt-5-6-sol-high · MODEL_GPT_5_2_XHIGH · claude-opus-5-medium · gpt-5-6-luna-none
//   claude-sonnet-4-6-thinking · glm-5-2-no-thinking · MODEL_XAI_GROK_3_MINI_REASONING
//   claude-opus-4-8-high-fast · gpt-5-6-luna-max-priority · MODEL_GPT_5_2_HIGH_PRIORITY
//   MODEL_PRIVATE_15 (label "GPT-5.1 High Thinking") · MODEL_GPT_5_1_CODEX_MAX_HIGH
//
// BYOK 映射只替换 model 字段时档位会丢失，上游一律按模型默认值推理。
// 这里负责:
//   1. 从 modelUid / catalog label 解析出档位（none|minimal|low|medium|high|xhigh|max|on|off）
//   2. 按目标模型族的可用词表钳制（同族=原样直传，跨族=就近转换）
//   3. 按目标协议把档位写进请求体:
//      - anthropic: thinking:{type:'adaptive'} + output_config:{effort}
//      - openai /responses: reasoning:{effort}
//      - openai /chat/completions: reasoning_effort
//
// 优先级: target.thinkingEffort 配置值 > BYOK_REASONING_EFFORT 环境变量 > modelUid 解析。

import { catalogEntryForUid, catalogEntries } from '../rename-models.js';

export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 尾部非档位修饰词：先剥掉再看档位（-fast/-priority=加速档, -1m=长上下文, -slow/-lightning=速度变体）
const MODIFIER_TOKENS = new Set(['fast', 'priority', '1m', 'slow', 'lightning']);
const THINKING_ON_TOKENS = new Set(['thinking', 'reasoning']);
const SIMPLE_EFFORT_TOKENS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// 各模型族支持的档位词表（用于跨族转换时就近钳制）。
// Anthropic adaptive effort 官方词表为 low|medium|high|max，Devin 的 xhigh 就近降为 high。
const VOCAB_CLAUDE = ['low', 'medium', 'high', 'max'];
const VOCAB_GPT = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const VOCAB_GEMINI = ['minimal', 'low', 'medium', 'high'];
const VOCAB_GENERIC = ['low', 'medium', 'high'];
const FAMILY_VOCAB = {
  claude: VOCAB_CLAUDE,
  gpt: VOCAB_GPT,
  gemini: VOCAB_GEMINI,
};

function normalizeUid(uid) {
  return String(uid || '').trim().replace(/(\d)\.(\d)/g, '$1-$2');
}

// 判断某个 base（去掉尾部 -max 后的前缀）在 catalog 里是否有 ≥2 个不同档位的兄弟项。
// 用于区分「-max 是档位」(claude-opus-4-7-max ↔ low/medium/high/xhigh 兄弟)
// 和「-max 是名字一部分」(swe-2-max、deepseek-v4-pro-max、codex-max)。
function hasEffortSiblings(base) {
  const b = normalizeUid(base).toLowerCase();
  if (!b) return false;
  const levels = new Set();
  for (const uid of catalogEntries().keys()) {
    const u = normalizeUid(uid).toLowerCase();
    if (!u.startsWith(`${b}-`) && !u.startsWith(`${b}_`)) continue;
    const tail = u.slice(b.length + 1).split(/[-_]/).filter(Boolean);
    while (tail.length && MODIFIER_TOKENS.has(tail[tail.length - 1])) tail.pop();
    if (tail.length === 1 && (SIMPLE_EFFORT_TOKENS.has(tail[0]) || tail[0] === 'max')) {
      levels.add(tail[0]);
    }
  }
  return levels.size >= 2;
}

// 从 modelUid 尾部解析档位。返回 {mode:'level',level} | {mode:'on'} | {mode:'off'} | null
function parseThinkingFromUidSuffix(uid) {
  const raw = normalizeUid(uid);
  if (!raw) return null;
  const tokens = raw.split(/[-_]+/).filter(Boolean);
  while (tokens.length && MODIFIER_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1].toLowerCase();
  if (THINKING_ON_TOKENS.has(last)) {
    const prev = tokens.length > 1 ? tokens[tokens.length - 2].toLowerCase() : '';
    return prev === 'no' ? { mode: 'off' } : { mode: 'on' };
  }
  if (last === 'none') return { mode: 'off' };
  if (last === 'max') {
    // base 必须用剥离修饰词后的剩余 token 重建，不能从 raw 尾部截（raw 还含 -fast/-priority）
    const base = tokens.slice(0, -1).join('-');
    return hasEffortSiblings(base) ? { mode: 'level', level: 'max' } : null;
  }
  if (SIMPLE_EFFORT_TOKENS.has(last)) return { mode: 'level', level: last };
  return null;
}

// 兜底：UID 不带档位时从 catalog label 解析（"GPT-5.1 High Thinking"、"GLM-5.2 High"、"o3 High"）。
function parseThinkingFromLabel(label) {
  const s = String(label || '').trim();
  if (!s) return null;
  // 剥掉尾部修饰："(Slow)"、"Fast"、"Priority"、"Lightning"、"1M"
  const stripped = s
    .replace(/\((?:slow|fast|priority|lightning)\)\s*$/i, '')
    .replace(/(?:\s|-)(?:fast|priority|lightning|1m)\s*$/i, '')
    .trim();
  // "No Thinking"/"High Thinking"/"Medium Reasoning" 等「级别+思考词」组合
  let m = stripped.match(/(?:^|\s|-)(no|minimal|low|medium|high|xhigh|max)\s+(?:thinking|reasoning)\s*$/i);
  if (m) {
    const lv = m[1].toLowerCase();
    if (lv === 'no') return { mode: 'off' };
    if (lv === 'max') return null; // label 里单独的 max 无法和名字区分，保守不猜
    return { mode: 'level', level: lv };
  }
  if (/(?:^|\s|-)no[\s-]+(?:thinking|reasoning)\s*$/i.test(stripped)) return { mode: 'off' };
  // 裸 "Thinking"/"Reasoning" 结尾（Claude Sonnet 4.5 Thinking、xAI Grok-3 mini Thinking）
  if (/(?:\s|-)(?:thinking|reasoning)\s*$/i.test(stripped)) return { mode: 'on' };
  // 裸级别结尾（"o3 High"、"GLM-5.2 High"、"Claude Opus 5 Medium"）
  m = stripped.match(/(?:^|\s|-)(minimal|low|medium|high|xhigh)\s*$/i);
  if (m) return { mode: 'level', level: m[1].toLowerCase() };
  return null;
}

/**
 * 解析请求里的 modelUid 得到思考档位。
 * @returns {{mode:'level',level:string}|{mode:'on'}|{mode:'off'}|null}
 */
export function parseThinkingFromUid(uid) {
  const bySuffix = parseThinkingFromUidSuffix(uid);
  if (bySuffix) return bySuffix;
  const entry = catalogEntryForUid(uid);
  if (entry?.label) return parseThinkingFromLabel(entry.label);
  return null;
}

// 目标模型族识别（决定可用档位词表）
export function modelFamily(name) {
  const s = String(name || '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(s)) return 'claude';
  if (/gpt|codex|openai/.test(s) || /^o[134](\b|[-.])/.test(s)) return 'gpt';
  if (/gemini/.test(s)) return 'gemini';
  if (/grok|xai/.test(s)) return 'grok';
  if (/glm|zhipu|chatglm/.test(s)) return 'glm';
  if (/kimi|moonshot/.test(s)) return 'kimi';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/swe/.test(s)) return 'swe';
  if (/qwen|dashscope/.test(s)) return 'qwen';
  if (/minimax/.test(s)) return 'minimax';
  if (/nemotron|nvidia/.test(s)) return 'nemotron';
  if (/llama/.test(s)) return 'llama';
  if (/inkling/.test(s)) return 'inkling';
  return 'generic';
}

// 目标连接的可用档位词表：anthropic 协议一律用 Claude 词表
// （adaptive + output_config.effort 支持 low~max）；其余按目标模型族。
export function effortVocabForConn(conn) {
  if (conn?.format === 'anthropic') return VOCAB_CLAUDE;
  return FAMILY_VOCAB[modelFamily(conn?.model)] || VOCAB_GENERIC;
}

// 把档位钳制到目标族词表内：词表含该级→原样（同族直传）；否则就近取更低档，再不行取最近更高档
export function clampEffortLevel(level, vocab) {
  const list = Array.isArray(vocab) && vocab.length ? vocab : VOCAB_GENERIC;
  if (list.includes(level)) return level;
  const rank = EFFORT_LEVELS.indexOf(level);
  if (rank < 0) return null;
  for (let i = rank - 1; i >= 0; i--) {
    if (list.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
  }
  for (let i = rank + 1; i < EFFORT_LEVELS.length; i++) {
    if (list.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
  }
  return null;
}

// 归一化 target.thinkingEffort 配置值。auto=跟随 modelUid；off=显式关闭。
export function normalizeThinkingEffortConfig(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'default') return 'auto';
  if (['off', 'none', 'disable', 'disabled', 'false', 'no'].includes(raw)) return 'off';
  if (raw === 'on' || raw === 'enabled' || raw === 'true') return 'high';
  if (EFFORT_LEVELS.includes(raw) && raw !== 'none') return raw;
  return 'auto';
}

/**
 * 计算某个目标最终要下发的思考档位。
 * @param {object} target 槽位目标 {providerId, model, thinkingEffort?}
 * @param {string} requestedModel 客户端请求的 modelUid
 * @returns {{mode:'off'}|{mode:'level',level:string,clamped?:boolean}|null} resolved.level 已是目标词表内的值
 */
export function resolveThinkingEffort(target, requestedModel, conn) {
  const cfg = normalizeThinkingEffortConfig(target?.thinkingEffort || target?.thinking_effort);
  let resolved = null;
  let source = '';
  if (cfg === 'off') {
    resolved = { mode: 'off' };
    source = 'config';
  } else if (cfg !== 'auto') {
    resolved = { mode: 'level', level: cfg };
    source = 'config';
  } else {
    const parsed = parseThinkingFromUid(requestedModel);
    if (!parsed) return null;
    if (parsed.mode === 'off') resolved = { mode: 'off' };
    else if (parsed.mode === 'on') resolved = { mode: 'level', level: 'high' };
    else resolved = { mode: 'level', level: parsed.level };
    source = 'auto';
  }
  if (resolved.mode === 'level') {
    const clamped = clampEffortLevel(resolved.level, effortVocabForConn(conn));
    if (!clamped) return null;
    if (clamped !== resolved.level) resolved = { ...resolved, level: clamped, clamped: true };
  }
  resolved.source = source;
  return resolved;
}

function stripEffortFromOutputConfig(apiPayload) {
  const oc = apiPayload.output_config;
  if (!oc || typeof oc !== 'object') return;
  const next = { ...oc };
  delete next.effort;
  if (Object.keys(next).length) apiPayload.output_config = next;
  else delete apiPayload.output_config;
}

/**
 * 把解析好的档位写进上游请求体（在 applyPayloadParamOverrides 之前调用，用户参数覆盖仍可生效）。
 * @param {object} apiPayload 即将发送的 payload（就地修改）
 * @param {object} conn resolveTarget 的连接信息（format/apiPath/model）
 * @param {object|null} resolved resolveThinkingEffort 的结果
 */
export function applyThinkingToPayload(apiPayload, conn, resolved) {
  if (!apiPayload || !conn || !resolved) return;
  if (conn.format === 'anthropic') {
    if (resolved.mode === 'off') {
      apiPayload.thinking = { type: 'disabled' };
      stripEffortFromOutputConfig(apiPayload);
    } else {
      apiPayload.thinking = { type: 'adaptive' };
      apiPayload.output_config = { ...(apiPayload.output_config || {}), effort: resolved.level };
    }
    return;
  }
  if (conn.format === 'openai') {
    const effort = resolved.mode === 'off' ? 'none' : resolved.level;
    if (/\/responses(?:$|\?)/i.test(String(conn.apiPath || ''))) {
      apiPayload.reasoning = { ...(apiPayload.reasoning || {}), effort };
    } else {
      apiPayload.reasoning_effort = effort;
    }
  }
}

export function describeThinking(resolved) {
  if (!resolved) return '';
  return resolved.mode === 'off' ? 'off' : resolved.level;
}
