// gemini-sse-transform.js — Google AI Studio / Vertex AI 原生 SSE 帧转发与跨协议流式转换。
//
// 职责：
//   1. createAntigravityGeminiRelay(): Antigravity v1internal 消费 Gemini/Vertex SSE 的真流式逐帧转发
//      (缓存 thoughtSignature、规范化 TOOL_CALL / STOP 终止态、汇总 usage)。
//   2. createGeminiNativeSSEForwarder(): /v1beta/*:streamGenerateContent 原生入口转发上游 Gemini SSE。
//   3. createAnthropicSSEFromGemini(): Gemini/Vertex SSE → Anthropic Messages SSE 真流式转换。
//   4. createResponsesSSEFromGemini(): Gemini/Vertex SSE → OpenAI Responses SSE 真流式转换。

import crypto from 'node:crypto';
import { createGeminiPartCallTracker } from './gemini-thought-signature.js';

export function extractGeminiUsage(event) {
  const gm = event?.usageMetadata || event?.usage_metadata;
  if (!gm || typeof gm !== 'object') return null;
  const inputTokens = Number(gm.promptTokenCount ?? gm.prompt_token_count) || 0;
  const outputTokens = Number(gm.candidatesTokenCount ?? gm.candidates_token_count) || 0;
  const cachedTokens = Number(gm.cachedContentTokenCount ?? gm.cached_content_token_count) || 0;
  return { inputTokens, outputTokens, cachedTokens };
}

function makeCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function geminiInlineErrorMessage(event) {
  const err = event?.error;
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err.status || JSON.stringify(err));
}

// ─── Antigravity v1internal ← Gemini/Vertex SSE 真流式转发 ───────────────
export function createAntigravityGeminiRelay(scope = '') {
  const callTracker = createGeminiPartCallTracker(scope);
  let sawToolCall = false;
  let sentTerminalFrame = false;
  let usage = null;
  let modelVersion = '';

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.error && !Array.isArray(event.candidates)) {
        sentTerminalFrame = true;
        throw new Error(geminiInlineErrorMessage(event));
      }
      if (event.modelVersion) modelVersion = event.modelVersion;
      const u = extractGeminiUsage(event);
      if (u) usage = u;

      const candidate = Array.isArray(event.candidates) ? event.candidates[0] : null;
      if (!candidate && !u) return [];

      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      let frameHasToolCall = false;
      const nextParts = [];

      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const extracted = callTracker.consume(part, makeCallId);
        if (extracted) {
          sawToolCall = true;
          frameHasToolCall = true;
          const callObj = { ...(extracted.call) };
          if (extracted.id && !callObj.id) callObj.id = extracted.id;
          const nextPart = { ...part, functionCall: callObj };
          delete nextPart.function_call;
          if (extracted.signature && !nextPart.thoughtSignature) {
            nextPart.thoughtSignature = extracted.signature;
          }
          nextParts.push(nextPart);
        } else {
          nextParts.push(part);
        }
      }

      if (!candidate && u) {
        // 仅有 usageMetadata 的尾帧
        return [{
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: sawToolCall ? 'TOOL_CALL' : 'STOP', index: 0 }],
          usageMetadata: event.usageMetadata || event.usage_metadata,
          ...(modelVersion ? { modelVersion } : {}),
        }];
      }

      let finishReason = candidate?.finishReason;
      if (frameHasToolCall && (!finishReason || finishReason === 'STOP')) {
        finishReason = 'TOOL_CALL';
      }
      if (finishReason) sentTerminalFrame = true;

      const nextCandidate = {
        ...candidate,
        index: candidate.index ?? 0,
        content: {
          ...(candidate.content || {}),
          role: candidate.content?.role || 'model',
          parts: nextParts,
        },
        ...(finishReason ? { finishReason } : {}),
      };

      const frame = {
        ...event,
        candidates: [nextCandidate],
      };
      return [frame];
    },
    flush() {
      if (sentTerminalFrame) return [];
      sentTerminalFrame = true;
      return [{
        candidates: [{
          content: { role: 'model', parts: [] },
          finishReason: sawToolCall ? 'TOOL_CALL' : 'STOP',
          index: 0,
        }],
        ...(modelVersion ? { modelVersion } : {}),
      }];
    },
    getUsage() {
      return usage;
    },
  };
}

// ─── 原生 Gemini /v1beta/* ← Gemini/Vertex SSE 转发 ──────────────────────
export function createGeminiNativeSSEForwarder(scope = '') {
  const callTracker = createGeminiPartCallTracker(scope);
  let usage = null;

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.error && !Array.isArray(event.candidates)) {
        throw new Error(geminiInlineErrorMessage(event));
      }
      const u = extractGeminiUsage(event);
      if (u) usage = u;
      const parts = event.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        callTracker.consume(part, makeCallId);
      }
      return [event];
    },
    flush() {
      return [];
    },
    getUsage() {
      return usage;
    },
  };
}

// ─── Anthropic Messages SSE ← Gemini/Vertex SSE ───────────────────────────
export function createAnthropicSSEFromGemini(model, scope = '') {
  const callTracker = createGeminiPartCallTracker(scope);
  const sentCalls = new Set();
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  let started = false;
  let blockIndex = 0;
  let openBlockType = null; // 'thinking' | 'text'
  let sawToolCall = false;
  let finishReason = 'end_turn';
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  const anthropicUsageObj = (u) => {
    const out = { input_tokens: Number(u.inputTokens) || 0, output_tokens: Number(u.outputTokens) || 0 };
    if (u.cachedTokens > 0) out.cache_read_input_tokens = u.cachedTokens;
    return out;
  };

  const ensureStart = (out) => {
    if (started) return;
    started = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: anthropicUsageObj(usage),
        },
      },
    });
  };

  const closeOpenBlock = (out) => {
    if (!openBlockType) return;
    out.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: blockIndex },
    });
    blockIndex += 1;
    openBlockType = null;
  };

  const ensureBlock = (out, type) => {
    if (openBlockType === type) return;
    closeOpenBlock(out);
    openBlockType = type;
    out.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: blockIndex,
        content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
      },
    });
  };

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.error && !Array.isArray(event.candidates)) {
        throw new Error(geminiInlineErrorMessage(event));
      }
      const u = extractGeminiUsage(event);
      if (u) usage = u;

      const out = [];
      ensureStart(out);

      const candidate = Array.isArray(event.candidates) ? event.candidates[0] : null;
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.thought === true) {
          const thoughtSig = String(part.thoughtSignature || part.thought_signature || '').trim();
          if (typeof part.text === 'string' && part.text) {
            ensureBlock(out, 'thinking');
            out.push({
              event: 'content_block_delta',
              data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: part.text } },
            });
          }
          if (thoughtSig) {
            ensureBlock(out, 'thinking');
            out.push({
              event: 'content_block_delta',
              data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'signature_delta', signature: thoughtSig } },
            });
          }
          continue;
        }
        if (typeof part.text === 'string' && part.text && part.thought !== true) {
          ensureBlock(out, 'text');
          out.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: part.text } },
          });
          continue;
        }
        const extracted = callTracker.consume(part, makeCallId);
        if (extracted) {
          const { call, id: callId, upstreamId } = extracted;
          const argsText = JSON.stringify(call.args || {});
          const dedupKey = upstreamId ? `id:${upstreamId}` : `${call.name}|${argsText}`;
          if (sentCalls.has(dedupKey)) continue;
          sentCalls.add(dedupKey);
          sawToolCall = true;
          closeOpenBlock(out);
          out.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'tool_use', id: callId, name: call.name, input: {} },
            },
          });
          out.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: argsText },
            },
          });
          out.push({
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: blockIndex },
          });
          blockIndex += 1;
        }
      }

      if (candidate?.finishReason) {
        const fr = String(candidate.finishReason).toUpperCase();
        finishReason = sawToolCall ? 'tool_use' : (fr === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn');
      }
      return out;
    },
    flush() {
      const out = [];
      ensureStart(out);
      closeOpenBlock(out);
      if (blockIndex === 0 && !sawToolCall) {
        ensureBlock(out, 'text');
        closeOpenBlock(out);
      }
      out.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: sawToolCall ? 'tool_use' : finishReason, stop_sequence: null },
          usage: anthropicUsageObj(usage),
        },
      });
      out.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return out;
    },
    getUsage() {
      return usage;
    },
  };
}

// ─── OpenAI Responses SSE ← Gemini/Vertex SSE ────────────────────────────
export function createResponsesSSEFromGemini(model, scope = '') {
  const callTracker = createGeminiPartCallTracker(scope);
  const sentCalls = new Set();
  const respId = `resp-${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let started = false;
  let outputIndex = 0;
  let reasoningItem = null;
  let messageItem = null;
  const completedItems = [];
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  const usageObj = () => {
    const out = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    };
    if (usage.cachedTokens > 0) out.input_tokens_details = { cached_tokens: usage.cachedTokens };
    return out;
  };

  const ensureCreated = (out) => {
    if (started) return;
    started = true;
    out.push({
      type: 'response.created',
      response: { id: respId, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [], output_text: '' },
    });
  };

  const closeReasoning = (out) => {
    if (!reasoningItem) return;
    const item = {
      type: 'reasoning',
      id: reasoningItem.id,
      summary: [{ type: 'summary_text', text: reasoningItem.text }],
      content: [{ type: 'reasoning_text', text: reasoningItem.text }],
    };
    out.push({
      type: 'response.reasoning_summary_text.done',
      item_id: reasoningItem.id,
      output_index: reasoningItem.index,
      summary_index: 0,
      text: reasoningItem.text,
    });
    out.push({ type: 'response.output_item.done', output_index: reasoningItem.index, item });
    completedItems.push(item);
    reasoningItem = null;
  };

  const closeMessage = (out) => {
    if (!messageItem) return;
    const item = {
      type: 'message',
      id: messageItem.id,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: messageItem.text }],
    };
    out.push({
      type: 'response.output_text.done',
      item_id: messageItem.id,
      output_index: messageItem.index,
      content_index: 0,
      text: messageItem.text,
    });
    out.push({ type: 'response.output_item.done', output_index: messageItem.index, item });
    completedItems.push(item);
    messageItem = null;
  };

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.error && !Array.isArray(event.candidates)) {
        throw new Error(geminiInlineErrorMessage(event));
      }
      const u = extractGeminiUsage(event);
      if (u) usage = u;

      const out = [];
      ensureCreated(out);
      const parts = event.candidates?.[0]?.content?.parts || [];

      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.thought === true && typeof part.text === 'string' && part.text) {
          closeMessage(out);
          if (!reasoningItem) {
            reasoningItem = { id: `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, index: outputIndex++, text: '' };
            out.push({
              type: 'response.output_item.added',
              output_index: reasoningItem.index,
              item: { type: 'reasoning', id: reasoningItem.id, status: 'in_progress', summary: [] },
            });
          }
          reasoningItem.text += part.text;
          out.push({
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoningItem.id,
            output_index: reasoningItem.index,
            summary_index: 0,
            delta: part.text,
          });
          continue;
        }
        if (typeof part.text === 'string' && part.text && part.thought !== true) {
          closeReasoning(out);
          if (!messageItem) {
            messageItem = { id: `msg-${crypto.randomUUID()}`, index: outputIndex++, text: '' };
            out.push({
              type: 'response.output_item.added',
              output_index: messageItem.index,
              item: { type: 'message', id: messageItem.id, status: 'in_progress', role: 'assistant', content: [] },
            });
          }
          messageItem.text += part.text;
          out.push({
            type: 'response.output_text.delta',
            item_id: messageItem.id,
            output_index: messageItem.index,
            content_index: 0,
            delta: part.text,
          });
          continue;
        }
        const extracted = callTracker.consume(part, makeCallId);
        if (extracted) {
          const { call, id: callId, upstreamId } = extracted;
          const argsText = JSON.stringify(call.args || {});
          const dedupKey = upstreamId ? `id:${upstreamId}` : `${call.name}|${argsText}`;
          if (sentCalls.has(dedupKey)) continue;
          sentCalls.add(dedupKey);
          closeReasoning(out);
          closeMessage(out);
          const idx = outputIndex++;
          const fcItem = {
            type: 'function_call',
            id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            call_id: callId,
            name: call.name,
            arguments: argsText,
          };
          out.push({ type: 'response.output_item.added', output_index: idx, item: { ...fcItem, status: 'in_progress' } });
          out.push({ type: 'response.output_item.done', output_index: idx, item: fcItem });
          completedItems.push(fcItem);
        }
      }
      return out;
    },
    flush() {
      const out = [];
      ensureCreated(out);
      closeReasoning(out);
      closeMessage(out);
      const outputText = completedItems
        .filter((item) => item.type === 'message')
        .map((item) => item.content?.[0]?.text || '')
        .join('');
      out.push({
        type: 'response.completed',
        response: {
          id: respId,
          object: 'response',
          created_at: createdAt,
          status: 'completed',
          model,
          output_text: outputText,
          output: completedItems,
          usage: usageObj(),
        },
      });
      return out;
    },
    getUsage() {
      return usage;
    },
  };
}
