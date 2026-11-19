import { chatCompletionToResponse } from '../responses-chat-transform.js';
import { normalizeGeminiResponseJson } from '../google-gemini.js';
import { estimateTokens } from './normalize.js';
import { extractText, extractToolCalls, upstreamReasoningText, usageFrom } from './response-emitters.js';
import { geminiStreamApiPath } from './upstream-payload.js';

export function selectStreamingAttempt(ctx, conn, payload) {
  if (ctx.stream !== true) return null;
  // 1. 任意入口 + Gemini/Vertex 上游 → :streamGenerateContent?alt=sse
  if (conn.format === 'gemini') {
    return {
      streamConn: { ...conn, apiPath: geminiStreamApiPath(conn) },
      streamPayload: payload,
      allowJsonFallback: true,
    };
  }
  // 2. Responses 客户端 + wireApi=chat（逐块转 Chat SSE → Responses SSE）
  if (conn.wireApi === 'chat' && ctx.kind === 'responses') {
    return {
      streamConn: conn,
      streamPayload: payload,
      allowJsonFallback: false,
    };
  }
  // 3. 其余任意入口（OpenAI Chat / Responses / Anthropic / Gemini-Antigravity）+ OpenAI / Responses / Anthropic 上游
  if (conn.format === 'openai' || conn.format === 'anthropic') {
    return {
      streamConn: conn,
      streamPayload: { ...payload, stream: true },
      allowJsonFallback: true,
    };
  }
  return null;
}

export function finalizeNonStreamResult(conn, r, json, effective, tracker, extraRespHeaders) {
  const normalizedJson = conn?.format === 'gemini' ? normalizeGeminiResponseJson(json) : json;
  const text = extractText(conn, normalizedJson);
  const reasoningText = upstreamReasoningText(conn, normalizedJson);
  const toolCalls = extractToolCalls(conn, normalizedJson);
  const usage = usageFrom(conn, normalizedJson, estimateTokens(effective.messages, effective.system), Math.ceil(text.length / 4));
  const responseObj = conn.wireApi === 'chat' && normalizedJson ? chatCompletionToResponse(normalizedJson, conn.model) : null;
  tracker.endAttempt({ status: 'ok', statusCode: r.statusCode, ms: r.durationMs, usage });
  tracker.finish();
  return {
    conn,
    text,
    ...(reasoningText ? { reasoningText } : {}),
    toolCalls,
    json: normalizedJson,
    usage,
    extraHeaders: extraRespHeaders,
    responseObj,
  };
}

export function recordStreamOutcomeReady(tracker, r) {
  tracker.endAttempt({ status: 'ok', statusCode: r.statusCode, ms: r.durationMs });
  tracker.finish();
}

