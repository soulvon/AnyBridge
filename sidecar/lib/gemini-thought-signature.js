// gemini-thought-signature.js — Gemini functionCall 思维签名与上游 call.id 缓存。
//
// 背景：Gemini 3 / 4 思考模型（含 Google AI Studio 与 Vertex）在返回 functionCall 时
// 会附带 thoughtSignature（并行调用通常只在首条 functionCall 附带），并在下一轮回传
// history 时强制校验（缺失直接 400）。而 OpenAI Chat / Anthropic 等标准客户端在多轮
// 回传时只保留 tool_call.id / tool_use.id，不透传 Gemini 专属的 thoughtSignature。
//
// 这里在本地网关内存按 toolCallId 记住上游原始 { signature, upstreamId }：
// - 命中时精确回放真实 thoughtSignature（以及上游原生的 call.id，仅当上游确实发过时）；
// - 未命中时（重启、跨模型切换历史）由调用方给首条 functionCall 补官方兜底签名
//   skip_thought_signature_validator，绝不强塞本地伪造的 id 给不认 id 的 Vertex v1。

export const GEMINI_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const SIGNATURE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

const toolCallMetaCache = new Map();

export function buildGeminiSignatureScope(connOrScope) {
  if (!connOrScope) return 'default';
  if (typeof connOrScope === 'string') {
    const trimmed = connOrScope.trim();
    return trimmed || 'default';
  }
  if (typeof connOrScope === 'object') {
    const host = String(connOrScope.host || connOrScope.hostname || '').trim().toLowerCase();
    const model = String(connOrScope.model || connOrScope.resolvedModel || '').trim();
    if (!host) return 'default';
    return `${host}::${model}`;
  }
  return 'default';
}

function scopedCacheKey(key, scope) {
  return `${buildGeminiSignatureScope(scope)}::${key}`;
}

function pruneIfNeeded(now) {
  if (toolCallMetaCache.size < MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of toolCallMetaCache) {
    if (now >= entry.expiresAt) toolCallMetaCache.delete(key);
  }
  while (toolCallMetaCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = toolCallMetaCache.keys().next().value;
    if (oldestKey === undefined) break;
    toolCallMetaCache.delete(oldestKey);
  }
}

export function rememberGeminiToolCall(callId, { signature = '', upstreamId = '', scope = '' } = {}) {
  const key = String(callId || '').trim();
  const sig = String(signature || '').trim();
  const upId = String(upstreamId || '').trim();
  if (!key || (!sig && !upId)) return;
  const cacheKey = scopedCacheKey(key, scope);
  const now = Date.now();
  pruneIfNeeded(now);
  // 刷新插入顺序，保持真实 LRU
  toolCallMetaCache.delete(cacheKey);
  toolCallMetaCache.set(cacheKey, {
    signature: sig,
    upstreamId: upId,
    expiresAt: now + SIGNATURE_TTL_MS,
  });
}

export function lookupGeminiToolCall(callId, scope = '') {
  const key = String(callId || '').trim();
  if (!key) return null;
  const cacheKey = scopedCacheKey(key, scope);
  const entry = toolCallMetaCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    toolCallMetaCache.delete(cacheKey);
    return null;
  }
  // LRU 访问刷新
  toolCallMetaCache.delete(cacheKey);
  toolCallMetaCache.set(cacheKey, entry);
  return { signature: entry.signature, upstreamId: entry.upstreamId };
}

/**
 * 为一次 Gemini candidate 消费（流式 SSE 或整包 JSON）创建 part 签名/调用提取器：
 * 统一处理「thoughtSignature 可能落在前序 thought part 上」及「call.id 缓存登记」。
 */
export function createGeminiPartCallTracker(scope = '') {
  let pendingSignature = '';
  return {
    consume(part, createId) {
      const partSig = String(part?.thoughtSignature || part?.thought_signature || '').trim();
      const call = part?.functionCall || part?.function_call;
      if (!call?.name) {
        if (partSig) pendingSignature = partSig;
        return null;
      }
      const upstreamId = call.id ? String(call.id).trim() : '';
      const signature = partSig || pendingSignature;
      if (partSig || pendingSignature) pendingSignature = '';
      const id = upstreamId || (typeof createId === 'function' ? createId(signature) : '');
      if (id && (signature || upstreamId)) {
        rememberGeminiToolCall(id, { signature, upstreamId, scope });
      }
      return { call, id, upstreamId, signature };
    },
  };
}

export function clearGeminiToolCallCache() {
  toolCallMetaCache.clear();
}
