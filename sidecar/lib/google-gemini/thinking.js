/**
 * Google Gemini ThinkingConfig 归一化、400 自愈、thoughtSignature 修复、
 * countTokens 载荷构造与数组流响应归一化。
 */

export const GEMINI_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export function isGemini3Or4Model(model) {
  const s = String(model || '').toLowerCase();
  return /gemini[-_ ]?(?:[3-9]|1\d)(?:\.\d+)?/.test(s);
}

function budgetToLevel(budget, model) {
  const n = Number(budget);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return /flash/i.test(String(model || '')) ? 'MINIMAL' : 'LOW';
  if (n < 4096) return 'LOW';
  if (n < 16384) return 'MEDIUM';
  return 'HIGH';
}

function levelToBudget(level) {
  switch (String(level || '').toUpperCase()) {
    case 'NONE':
    case 'MINIMAL':
      return 0;
    case 'LOW':
      return 1024;
    case 'MEDIUM':
      return 8192;
    case 'HIGH':
    case 'MAX':
      return 24576;
    default:
      return null;
  }
}

export function normalizeGeminiThinkingConfig(payload, conn) {
  const tc = payload?.generationConfig?.thinkingConfig;
  if (!tc || typeof tc !== 'object') return payload;

  const model = String(conn?.model || '');
  const nextTc = { ...tc };
  const isModern = isGemini3Or4Model(model);

  // 兼容 snake_case / camelCase 残留字段统一转为 Gemini REST camelCase
  if (nextTc.thinking_budget !== undefined && nextTc.thinkingBudget === undefined) {
    nextTc.thinkingBudget = nextTc.thinking_budget;
  }
  if (nextTc.thinking_level !== undefined && nextTc.thinkingLevel === undefined) {
    nextTc.thinkingLevel = nextTc.thinking_level;
  }
  if (nextTc.include_thoughts !== undefined && nextTc.includeThoughts === undefined) {
    nextTc.includeThoughts = nextTc.include_thoughts;
  }
  delete nextTc.thinking_budget;
  delete nextTc.thinking_level;
  delete nextTc.include_thoughts;

  if (isModern) {
    if (!nextTc.thinkingLevel && nextTc.thinkingBudget !== undefined) {
      const mapped = budgetToLevel(nextTc.thinkingBudget, model);
      if (mapped) nextTc.thinkingLevel = mapped;
    }
    delete nextTc.thinkingBudget;
    if (String(nextTc.thinkingLevel || '').toUpperCase() === 'NONE') {
      delete nextTc.thinkingLevel;
      delete nextTc.includeThoughts;
    }
  } else if (/gemini/i.test(model)) {
    if (nextTc.thinkingBudget === undefined && nextTc.thinkingLevel) {
      const mappedBudget = levelToBudget(nextTc.thinkingLevel);
      if (mappedBudget !== null) nextTc.thinkingBudget = mappedBudget;
    }
    delete nextTc.thinkingLevel;
    const is25Pro = /2\.5[-_ ]?pro/i.test(model);
    const is25FlashLite = /2\.5[-_ ]?flash[-_ ]?lite/i.test(model);
    if (nextTc.thinkingBudget !== undefined && Number.isFinite(Number(nextTc.thinkingBudget))) {
      const rawBudget = Number(nextTc.thinkingBudget);
      if (is25Pro) {
        // gemini-2.5-pro 不允许 thinkingBudget=0，最小为 128（-1 代表动态思考保留不动）
        if (rawBudget >= 0 && rawBudget < 128) {
          nextTc.thinkingBudget = 128;
        }
      } else if (is25FlashLite && rawBudget > 0 && rawBudget < 512) {
        nextTc.thinkingBudget = 512;
      }
    }
    if (Number(nextTc.thinkingBudget) === 0) {
      delete nextTc.includeThoughts;
    }
  }

  const nextGen = { ...payload.generationConfig };
  if (Object.keys(nextTc).length === 0) {
    delete nextGen.thinkingConfig;
  } else {
    nextGen.thinkingConfig = nextTc;
  }
  return { ...payload, generationConfig: nextGen };
}

export function downgradeGeminiThinkingConfigOn400(payload, errorText, healState = {}) {
  if (!payload?.generationConfig?.thinkingConfig) return null;
  const msg = String(errorText || '');
  if (!/(thinking|thinking_level|thinking_budget|thinkingConfig|thinking_config|MINIMAL)/i.test(msg)) {
    return null;
  }
  const tc = payload.generationConfig.thinkingConfig;
  if (String(tc.thinkingLevel || '').toUpperCase() === 'MINIMAL' && !healState.minimalDowngraded) {
    healState.minimalDowngraded = true;
    return {
      kind: 'gemini-thinking-minimal-to-low',
      payload: {
        ...payload,
        generationConfig: {
          ...payload.generationConfig,
          thinkingConfig: { ...tc, thinkingLevel: 'LOW' },
        },
      },
    };
  }
  if (healState.thinkingHealed) return null;
  healState.thinkingHealed = true;
  const nextGen = { ...payload.generationConfig };
  delete nextGen.thinkingConfig;
  return {
    kind: 'gemini-remove-thinking-config',
    payload: { ...payload, generationConfig: nextGen },
  };
}

export function applyGeminiSkipThoughtSignatureValidator(payload) {
  if (!payload || !Array.isArray(payload.contents)) return payload;
  const nextContents = payload.contents.map((entry) => {
    if (!entry || !Array.isArray(entry.parts)) return entry;
    let firstFnInTurn = true;
    const nextParts = entry.parts.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const { thoughtSignature: _ts, thought_signature: _tss, ...rest } = part;
      if (part.functionCall || part.function_call) {
        if (firstFnInTurn) {
          firstFnInTurn = false;
          return { ...rest, thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE };
        }
        return rest;
      }
      return rest;
    });
    return { ...entry, parts: nextParts };
  });
  return { ...payload, contents: nextContents };
}

export function healGeminiInvalidThoughtSignature(payload, errorText, healState = {}) {
  if (!payload || !Array.isArray(payload.contents) || healState.signatureHealed) return null;
  const msg = String(errorText || '');
  if (!/(?:thought_?signature|thoughtSignature)/i.test(msg)) return null;
  healState.signatureHealed = true;
  return {
    kind: 'gemini-skip-thought-signature',
    payload: applyGeminiSkipThoughtSignatureValidator(payload),
  };
}

export function healGemini400Payload(payload, errorText, healState = {}) {
  return downgradeGeminiThinkingConfigOn400(payload, errorText, healState)
    || healGeminiInvalidThoughtSignature(payload, errorText, healState);
}

export function buildGeminiCountTokensPayload({ isVertex, model, contents, systemInstruction, tools, safetySettings }) {
  const modelClean = String(model || '').trim().replace(/^models\//i, '');
  if (isVertex) {
    const flat = { contents };
    if (systemInstruction) flat.systemInstruction = systemInstruction;
    if (tools) flat.tools = tools;
    if (safetySettings) flat.safetySettings = safetySettings;
    return flat;
  }
  const inner = {
    model: `models/${modelClean}`,
    contents,
  };
  if (systemInstruction) inner.systemInstruction = systemInstruction;
  if (tools) inner.tools = tools;
  if (safetySettings) inner.safetySettings = safetySettings;
  return { generateContentRequest: inner };
}

export function normalizeGeminiResponseJson(parsed) {
  if (!Array.isArray(parsed)) return parsed;
  const parts = [];
  let finishReason = null;
  let usageMetadata = null;
  let modelVersion = '';
  let promptFeedback = null;
  for (const frame of parsed) {
    if (!frame || typeof frame !== 'object') continue;
    if (frame.error && !Array.isArray(frame.candidates)) return frame;
    if (frame.modelVersion) modelVersion = frame.modelVersion;
    if (frame.usageMetadata || frame.usage_metadata) {
      usageMetadata = frame.usageMetadata || frame.usage_metadata;
    }
    if (frame.promptFeedback) promptFeedback = frame.promptFeedback;
    const candidate = Array.isArray(frame.candidates) ? frame.candidates[0] : null;
    if (candidate) {
      if (Array.isArray(candidate.content?.parts)) parts.push(...candidate.content.parts);
      if (candidate.finishReason) finishReason = candidate.finishReason;
    }
  }
  const candidate = {
    index: 0,
    content: { role: 'model', parts },
    ...(finishReason ? { finishReason } : {}),
  };
  return {
    candidates: [candidate],
    ...(usageMetadata ? { usageMetadata } : {}),
    ...(modelVersion ? { modelVersion } : {}),
    ...(promptFeedback ? { promptFeedback } : {}),
  };
}

