// sidecar/lib/codec-registry.js — 统一五下游协议 (openai/responses/anthropic/gemini/antigravity)
// 真流式转换、生命周期安全管线与真实 usage 账本结算。

import crypto from 'node:crypto';
import { recordError, recordRecentOutcome, recordUsage } from '../stats.js';
import { createChatSSEConverter } from './chat-sse-transform.js';
import {
  createAnthropicSSEFromGemini,
  createAntigravityGeminiRelay,
  createGeminiNativeSSEForwarder,
  createResponsesSSEFromGemini,
} from './gemini-sse-transform.js';
import {
  GEMINI_SKIP_THOUGHT_SIGNATURE,
  buildGeminiSignatureScope,
  rememberGeminiToolCall,
} from './gemini-thought-signature.js';
import { createResponsesSSEFromChat } from './responses-chat-transform.js';
import { parseSSEStream } from './sse-parser.js';
import {
  createUpstreamEventDecoder,
  geminiUsageMetadataFromStats,
  normalizeUsageStats,
  resolveUpstreamProtocol,
  safeStreamErrMessage,
} from './upstream-decoder.js';
import { startSseKeepalive } from './upstream-watchdog.js';

export {
  createUpstreamEventDecoder,
  geminiUsageMetadataFromStats,
  normalizeUsageStats,
  resolveUpstreamProtocol,
};

function createResponsesPassthroughTransform(model) {
  let sawTerminal = false;
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationInputTokens: 0 };
  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error(event.error?.message || event.response?.error?.message || event.message || 'upstream stream error');
      }
      if (event.type === 'response.completed') {
        sawTerminal = true;
        if (event.response?.usage) usage = normalizeUsageStats(event.response.usage);
        return [{ ...event, response: { ...event.response, model } }];
      }
      if (event.response && typeof event.response === 'object' && event.response.model !== undefined) {
        return [{ ...event, response: { ...event.response, model } }];
      }
      return [event];
    },
    markDone() { sawTerminal = true; },
    flush() { return []; },
    hasTerminalFrame() { return sawTerminal; },
    getUsage() { return usage; },
    formatItem(ev) { return { event: ev.type, data: ev }; },
  };
}

function createResponsesFromDecoderTransform(model, decoder) {
  const respId = `resp-${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let started = false;
  let outputIndex = 0;
  let reasoningItem = null;
  let messageItem = null;
  const completedItems = [];

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
    out.push({ type: 'response.reasoning_summary_text.done', item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, text: reasoningItem.text });
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
    out.push({ type: 'response.output_text.done', item_id: messageItem.id, output_index: messageItem.index, content_index: 0, text: messageItem.text });
    out.push({ type: 'response.output_item.done', output_index: messageItem.index, item });
    completedItems.push(item);
    messageItem = null;
  };

  return {
    write(event) {
      const out = [];
      for (const ev of decoder.write(event)) {
        ensureCreated(out);
        if (ev.type === 'thinking' && ev.text) {
          closeMessage(out);
          if (!reasoningItem) {
            reasoningItem = { id: `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, index: outputIndex++, text: '' };
            out.push({ type: 'response.output_item.added', output_index: reasoningItem.index, item: { type: 'reasoning', id: reasoningItem.id, status: 'in_progress', summary: [] } });
          }
          reasoningItem.text += ev.text;
          out.push({ type: 'response.reasoning_summary_text.delta', item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, delta: ev.text });
        } else if (ev.type === 'text' && ev.text) {
          closeReasoning(out);
          if (!messageItem) {
            messageItem = { id: `msg-${crypto.randomUUID()}`, index: outputIndex++, text: '' };
            out.push({ type: 'response.output_item.added', output_index: messageItem.index, item: { type: 'message', id: messageItem.id, status: 'in_progress', role: 'assistant', content: [] } });
          }
          messageItem.text += ev.text;
          out.push({ type: 'response.output_text.delta', item_id: messageItem.id, output_index: messageItem.index, content_index: 0, delta: ev.text });
        }
      }
      return out;
    },
    markDone() { decoder.markDone(); },
    hasTerminalFrame() { return decoder.hasTerminalFrame(); },
    getUsage() { return decoder.getUsage(); },
    flush() {
      const out = [];
      ensureCreated(out);
      closeReasoning(out);
      closeMessage(out);
      for (const tc of decoder.getToolCalls()) {
        const idx = outputIndex++;
        const fcItem = {
          type: 'function_call',
          id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        };
        out.push({ type: 'response.output_item.added', output_index: idx, item: { ...fcItem, status: 'in_progress' } });
        out.push({ type: 'response.output_item.done', output_index: idx, item: fcItem });
        completedItems.push(fcItem);
      }
      const u = decoder.getUsage();
      const usageObj = { input_tokens: u.inputTokens, output_tokens: u.outputTokens, total_tokens: u.inputTokens + u.outputTokens };
      if (u.cachedTokens > 0) usageObj.input_tokens_details = { cached_tokens: u.cachedTokens };
      const outputText = completedItems.filter((i) => i.type === 'message').map((i) => i.content?.[0]?.text || '').join('');
      out.push({
        type: 'response.completed',
        response: { id: respId, object: 'response', created_at: createdAt, status: 'completed', model, output_text: outputText, output: completedItems, usage: usageObj },
      });
      return out;
    },
    formatItem(ev) { return { event: ev.type, data: ev }; },
  };
}

function createAnthropicPassthroughTransform(echoModel) {
  let sawStop = false;
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationInputTokens: 0 };
  return {
    write(event, eventName) {
      if (!event || typeof event !== 'object') return [];
      const type = event.type || eventName;
      if (type === 'error') {
        throw new Error(event.error?.message || event.message || 'upstream stream error');
      }
      if (type === 'message_start') {
        if (event.message?.usage) usage = { ...usage, ...normalizeUsageStats(event.message.usage) };
        return [{ event: 'message_start', data: { ...event, message: { ...event.message, model: echoModel } } }];
      }
      if (type === 'message_delta') {
        if (event.usage) {
          const nu = normalizeUsageStats(event.usage);
          usage = {
            inputTokens: nu.inputTokens || usage.inputTokens,
            outputTokens: nu.outputTokens || usage.outputTokens,
            cachedTokens: nu.cachedTokens || usage.cachedTokens,
            cacheCreationInputTokens: nu.cacheCreationInputTokens || usage.cacheCreationInputTokens,
          };
        }
        return [{ event: 'message_delta', data: event }];
      }
      if (type === 'message_stop') {
        sawStop = true;
        return [{ event: 'message_stop', data: event }];
      }
      return [{ event: type || 'message', data: event }];
    },
    markDone() { sawStop = true; },
    hasTerminalFrame() { return sawStop; },
    flush() { return []; },
    getUsage() { return usage; },
    formatItem(ev) { return { event: ev.event, data: ev.data }; },
  };
}

function createAnthropicFromDecoderTransform(echoModel, decoder) {
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  let started = false;
  let blockIndex = 0;
  let openBlockType = null;
  let sawTool = false;

  const anthropicUsageObj = (u) => {
    const out = { input_tokens: Number(u.inputTokens) || 0, output_tokens: Number(u.outputTokens) || 0 };
    if (u.cachedTokens > 0) out.cache_read_input_tokens = u.cachedTokens;
    if (u.cacheCreationInputTokens > 0) out.cache_creation_input_tokens = u.cacheCreationInputTokens;
    return out;
  };
  const ensureStart = (out) => {
    if (started) return;
    started = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', model: echoModel, content: [], stop_reason: null, stop_sequence: null, usage: anthropicUsageObj(decoder.getUsage()) },
      },
    });
  };
  const closeBlock = (out) => {
    if (!openBlockType) return;
    out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } });
    blockIndex += 1;
    openBlockType = null;
  };
  const ensureBlock = (out, type) => {
    if (openBlockType === type) return;
    closeBlock(out);
    openBlockType = type;
    out.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index: blockIndex, content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } },
    });
  };

  return {
    write(event) {
      const out = [];
      for (const ev of decoder.write(event)) {
        ensureStart(out);
        if (ev.type === 'thinking') {
          ensureBlock(out, 'thinking');
          if (ev.text) out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: ev.text } } });
          if (ev.signature) out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'signature_delta', signature: ev.signature } } });
        } else if (ev.type === 'text' && ev.text) {
          ensureBlock(out, 'text');
          out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: ev.text } } });
        }
      }
      return out;
    },
    markDone() { decoder.markDone(); },
    hasTerminalFrame() { return decoder.hasTerminalFrame(); },
    getUsage() { return decoder.getUsage(); },
    flush() {
      const out = [];
      ensureStart(out);
      closeBlock(out);
      for (const tc of decoder.getToolCalls()) {
        sawTool = true;
        out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } } });
        out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.arguments || '{}' } } });
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } });
        blockIndex += 1;
      }
      if (blockIndex === 0 && !sawTool) {
        ensureBlock(out, 'text');
        closeBlock(out);
      }
      const r = decoder.getFinishReason();
      const stopReason = sawTool ? 'tool_use' : (r === 'length' ? 'max_tokens' : 'end_turn');
      out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: anthropicUsageObj(decoder.getUsage()) } });
      out.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return out;
    },
    formatItem(ev) { return { event: ev.event, data: ev.data }; },
  };
}

function createGeminiNativeFromDecoderTransform(model, decoder, scope) {
  let emittedAny = false;
  return {
    write(event) {
      const parts = [];
      for (const ev of decoder.write(event)) {
        if (ev.type === 'thinking' && ev.text) parts.push({ text: ev.text, thought: true });
        else if (ev.type === 'text' && ev.text) parts.push({ text: ev.text });
      }
      if (!parts.length) return [];
      emittedAny = true;
      return [{ candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: model }];
    },
    markDone() { decoder.markDone(); },
    hasTerminalFrame() { return decoder.hasTerminalFrame(); },
    getUsage() { return decoder.getUsage(); },
    flush() {
      const parts = [];
      for (const tc of decoder.getToolCalls()) {
        const sig = tc.thoughtSignature || GEMINI_SKIP_THOUGHT_SIGNATURE;
        rememberGeminiToolCall(tc.id, { signature: sig, upstreamId: tc.id, scope });
        parts.push({ functionCall: { ...(tc.id ? { id: tc.id } : {}), name: tc.name, args: tc.args || {} }, thoughtSignature: sig });
      }
      if (!emittedAny && parts.length === 0) parts.push({ text: '' });
      const r = decoder.getFinishReason();
      const finishReason = r === 'length' ? 'MAX_TOKENS' : (r === 'content_filter' ? 'SAFETY' : 'STOP');
      return [{
        candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }],
        usageMetadata: geminiUsageMetadataFromStats(decoder.getUsage()),
        modelVersion: model,
      }];
    },
    formatItem(frame) { return { event: null, data: frame }; },
  };
}

function createAntigravityFromDecoderTransform(model, decoder, scope) {
  return {
    write(event) {
      const parts = [];
      for (const ev of decoder.write(event)) {
        if (ev.type === 'thinking' && ev.text) parts.push({ text: ev.text, thought: true });
        else if (ev.type === 'text' && ev.text) parts.push({ text: ev.text });
      }
      if (!parts.length) return [];
      return [{ candidates: [{ content: { role: 'model', parts }, finishReason: 'OTHER', index: 0 }], ...(model ? { modelVersion: model } : {}) }];
    },
    markDone() { decoder.markDone(); },
    hasTerminalFrame() { return decoder.hasTerminalFrame(); },
    getUsage() { return decoder.getUsage(); },
    flush() {
      const out = [];
      const calls = decoder.getToolCalls();
      if (calls.length > 0) {
        const parts = calls.map((tc) => {
          const sig = tc.thoughtSignature || GEMINI_SKIP_THOUGHT_SIGNATURE;
          rememberGeminiToolCall(tc.id, { signature: sig, upstreamId: tc.id, scope });
          return { functionCall: { ...(tc.id ? { id: tc.id } : {}), name: tc.name, args: tc.args || {} }, thoughtSignature: sig };
        });
        out.push({ candidates: [{ content: { role: 'model', parts }, finishReason: 'TOOL_CALL', index: 0 }], ...(model ? { modelVersion: model } : {}) });
      }
      const u = decoder.getUsage();
      out.push({
        candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }],
        ...(u.inputTokens || u.outputTokens ? { usageMetadata: geminiUsageMetadataFromStats(u) } : {}),
        ...(model ? { modelVersion: model } : {}),
      });
      return out;
    },
    formatItem(frame) { return { event: null, data: frame }; },
  };
}

/**
 * 统一创建目标协议流转换器。
 */
export function createProtocolStreamTransform(targetFormat, conn, ctx, opts = {}) {
  const scope = buildGeminiSignatureScope(conn);
  const protocol = resolveUpstreamProtocol(conn);
  const model = ctx.model || '';
  const echoModel = ctx.originalModel || model;

  if (targetFormat === 'openai') {
    const id = opts.id || `chatcmpl-${crypto.randomUUID()}`;
    const created = opts.created || Math.floor(Date.now() / 1000);
    const inner = createChatSSEConverter(conn, model, id, created);
    let sawTerminal = false;
    return {
      write(event) {
        const detected = resolveUpstreamProtocol(conn, event);
        if (detected === 'openai' && event?.choices?.some((c) => c?.finish_reason)) sawTerminal = true;
        else if (detected === 'responses' && event?.type === 'response.completed') sawTerminal = true;
        else if (detected === 'anthropic' && event?.type === 'message_stop') sawTerminal = true;
        else if (detected === 'gemini' && event?.candidates?.[0]?.finishReason) sawTerminal = true;
        if (event?.type === 'error' || event?.type === 'response.failed') {
          throw new Error(safeStreamErrMessage(event.error?.message || event.response?.error?.message || event.message, conn));
        }
        return inner.write(event);
      },
      markDone() { sawTerminal = true; },
      hasTerminalFrame() { return sawTerminal; },
      flush() { return inner.flush(); },
      getUsage() { return normalizeUsageStats(inner.getUsage()); },
      formatItem(chunk) { return { event: null, data: chunk }; },
    };
  }

  if (targetFormat === 'responses') {
    if (protocol === 'gemini') {
      const inner = createResponsesSSEFromGemini(model, scope);
      let sawFinish = false;
      return {
        write(event) { if (event?.candidates?.[0]?.finishReason) sawFinish = true; return inner.write(event); },
        markDone() { sawFinish = true; },
        hasTerminalFrame() { return sawFinish; },
        flush() { return inner.flush(); },
        getUsage() { return normalizeUsageStats(inner.getUsage()); },
        formatItem(ev) { return { event: ev.type, data: ev }; },
      };
    }
    if (protocol === 'openai') {
      const inner = createResponsesSSEFromChat(model, conn?.codexChatReasoning?.outputFormat);
      let sawFinish = false;
      return {
        write(event) {
          if (event?.error) throw new Error(safeStreamErrMessage(event.error, conn));
          if (event?.choices?.some((c) => c?.finish_reason)) sawFinish = true;
          return inner.write(event);
        },
        markDone() { sawFinish = true; },
        hasTerminalFrame() { return sawFinish; },
        flush() { return inner.flush(); },
        getUsage() { return normalizeUsageStats(inner.getResponse()?.usage); },
        formatItem(ev) { return { event: ev.type, data: ev }; },
      };
    }
    if (protocol === 'responses') return createResponsesPassthroughTransform(model);
    return createResponsesFromDecoderTransform(model, createUpstreamEventDecoder(conn));
  }

  if (targetFormat === 'anthropic') {
    if (protocol === 'gemini') {
      const inner = createAnthropicSSEFromGemini(echoModel, scope);
      let sawFinish = false;
      return {
        write(event) { if (event?.candidates?.[0]?.finishReason) sawFinish = true; return inner.write(event); },
        markDone() { sawFinish = true; },
        hasTerminalFrame() { return sawFinish; },
        flush() { return inner.flush(); },
        getUsage() { return normalizeUsageStats(inner.getUsage()); },
        formatItem(ev) { return { event: ev.event, data: ev.data }; },
      };
    }
    if (protocol === 'anthropic') return createAnthropicPassthroughTransform(echoModel);
    return createAnthropicFromDecoderTransform(echoModel, createUpstreamEventDecoder(conn));
  }

  if (targetFormat === 'gemini') {
    if (protocol === 'gemini') {
      const inner = createGeminiNativeSSEForwarder(scope);
      let sawFinish = false;
      return {
        write(event) { if (event?.candidates?.[0]?.finishReason) sawFinish = true; return inner.write(event); },
        markDone() { sawFinish = true; },
        hasTerminalFrame() { return sawFinish; },
        flush() { return inner.flush(); },
        getUsage() { return normalizeUsageStats(inner.getUsage()); },
        formatItem(frame) { return { event: null, data: frame }; },
      };
    }
    return createGeminiNativeFromDecoderTransform(model, createUpstreamEventDecoder(conn), scope);
  }

  // antigravity
  if (protocol === 'gemini') {
    const inner = createAntigravityGeminiRelay(scope);
    let sawFinish = false;
    return {
      write(event) { if (event?.candidates?.[0]?.finishReason) sawFinish = true; return inner.write(event); },
      markDone() { sawFinish = true; },
      hasTerminalFrame() { return sawFinish; },
      flush() { return inner.flush(); },
      getUsage() { return normalizeUsageStats(inner.getUsage()); },
      formatItem(frame) { return { event: null, data: frame }; },
    };
  }
  return createAntigravityFromDecoderTransform(model, createUpstreamEventDecoder(conn), scope);
}

/**
 * 统一流式账本结算（真流式完成后才写入 tracker + usage-ledger，异常/中断绝不伪造 ok）。
 */
export function settleStreamTrackerSuccess(result, usage) {
  const norm = normalizeUsageStats(usage) || { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationInputTokens: 0 };
  const tracker = result?._tracker;
  if (tracker) {
    if (!tracker.finalized) {
      if (tracker.openAttempt >= 0) {
        tracker.endAttempt({
          status: 'ok',
          statusCode: result._statusCode || 200,
          ms: Date.now() - (Number(result.startedAt) || Date.now()),
          usage: norm,
        });
      }
      tracker.finish();
    }
    return;
  }
  if (norm.inputTokens || norm.outputTokens || norm.cachedTokens || norm.cacheCreationInputTokens) {
    recordUsage(norm);
  }
  if (result?.recentRequestId) {
    recordRecentOutcome({
      requestId: result.recentRequestId,
      inputTokens: norm.inputTokens,
      outputTokens: norm.outputTokens,
      cachedTokens: norm.cachedTokens,
      latencyMs: Date.now() - (Number(result.startedAt) || Date.now()),
      stream: true,
    });
  }
}

export function settleStreamTrackerFail(result, reason, partialUsage = null, isClientAbort = false) {
  const tracker = result?._tracker;
  const msg = String(reason || 'stream error');
  if (tracker) {
    if (!tracker.finalized) {
      if (isClientAbort) {
        if (tracker.openAttempt >= 0) {
          tracker.endAttempt({ status: 'failed', statusCode: result._statusCode || 200, ms: Date.now() - (Number(result.startedAt) || Date.now()), error: msg });
        }
        tracker.abort(msg);
      } else {
        if (tracker.openAttempt >= 0) {
          tracker.endAttempt({
            status: 'failed',
            statusCode: result._statusCode || 200,
            ms: Date.now() - (Number(result.startedAt) || Date.now()),
            error: msg,
            usage: partialUsage ? normalizeUsageStats(partialUsage) : null,
          });
        }
        tracker.fail('upstream-stream', msg);
      }
      tracker.finish();
    }
    return;
  }
  if (!isClientAbort) {
    recordError({ provider: result?.conn?.providerName || 'local-proxy', message: msg });
  }
}

/**
 * 统一流式转发执行器：
 * - 绑定 res.on('close') 立即销毁 upstreamResponse，防止空烧
 * - try/finally 保证任何分支（正常/异常/断连）都销毁 upstreamResponse 释放 providerInflightGate 槽位
 * - 流异常或未收齐终止帧提前 EOF 时，严禁调用 converter.flush() 补发 STOP/[DONE]，严禁记为 ok
 */
export async function runStreamPipeline({
  res,
  result,
  converter,
  useKeepalive = true,
  emitItem,
  onUpstreamError,
  onCompleted,
  onFinally,
}) {
  const keepalive = useKeepalive ? startSseKeepalive(res) : null;
  const watchdog = result?.watchdog;
  let clientClosed = false;
  let streamFailed = false;
  let failureReason = '';
  let sawDoneFrame = false;

  const destroyUpstream = () => {
    try { result?.upstreamResponse?.destroy?.(); } catch {}
  };
  const onResClose = () => {
    if (!res?.writableEnded) {
      clientClosed = true;
      destroyUpstream();
    }
  };
  if (typeof res?.once === 'function') res.once('close', onResClose);

  try {
    for await (const evt of parseSSEStream(result.upstreamResponse, { emitDone: true, onChunk: () => { if (watchdog) watchdog.touch(); } })) {
      if (clientClosed || res?.writableEnded) {
        clientClosed = true;
        break;
      }
      if (keepalive) keepalive.touch();
      if (evt.done) {
        sawDoneFrame = true;
        converter.markDone?.();
        break;
      }
      if (evt.jsonError || !evt.data || typeof evt.data !== 'object') continue;
      for (const item of converter.write(evt.data, evt.event)) {
        emitItem(item);
      }
    }

    if (clientClosed) {
      settleStreamTrackerFail(result, 'client disconnected', converter.getUsage?.(), true);
      return;
    }

    const complete = sawDoneFrame || (converter.hasTerminalFrame ? converter.hasTerminalFrame() : true);
    if (!complete) {
      streamFailed = true;
      failureReason = 'upstream stream ended before terminal frame';
      onUpstreamError(failureReason);
      settleStreamTrackerFail(result, failureReason, converter.getUsage?.(), false);
      return;
    }

    for (const item of (converter.flush ? converter.flush() : [])) {
      emitItem(item);
    }
    if (typeof onCompleted === 'function') onCompleted();
    settleStreamTrackerSuccess(result, converter.getUsage ? converter.getUsage() : null);
  } catch (err) {
    streamFailed = true;
    const safeMsg = safeStreamErrMessage(err, result?.conn);
    failureReason = safeMsg;
    if (!clientClosed) {
      try { onUpstreamError(safeMsg); } catch {}
    }
    settleStreamTrackerFail(result, safeMsg, converter.getUsage?.(), clientClosed);
  } finally {
    if (typeof res?.off === 'function') res.off('close', onResClose);
    destroyUpstream();
    if (watchdog) watchdog.clear();
    if (keepalive) keepalive.stop();
    if (typeof onFinally === 'function') {
      try { onFinally({ clientClosed, streamFailed, failureReason }); } catch {}
    }
    try { if (typeof res?.end === 'function' && !res.writableEnded) res.end(); } catch {}
  }
}
