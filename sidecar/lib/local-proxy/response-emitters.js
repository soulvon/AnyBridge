// response-emitters.js — Upstream response extraction & OpenAI Chat / Responses / Anthropic / Gemini / Antigravity emitters.

import crypto from 'node:crypto';
import {
  createProtocolStreamTransform,
  geminiUsageMetadataFromStats,
  runStreamPipeline,
} from '../codec-registry.js';
import {
  GEMINI_SKIP_THOUGHT_SIGNATURE,
  buildGeminiSignatureScope,
  createGeminiPartCallTracker,
} from '../gemini-thought-signature.js';
import { redactGeminiCredential } from '../google-gemini.js';
import { extractReasoningFromChatMessage } from '../responses-chat/content-helpers.js';
import { estimateTokens, isPlainObject, normalizeRequest, parseJsonObject } from './normalize.js';
import { cors, sendJson } from './routes.js';

export function extractText(conn, json) {
  if (!json) return '';
  if (conn.format === 'anthropic') return (json.content || []).map((p) => p?.text || '').filter(Boolean).join('');
  if (conn.format === 'gemini') return (json.candidates?.[0]?.content?.parts || []).filter((p) => p?.thought !== true).map((p) => p?.text || '').filter(Boolean).join('');
  if (typeof json.output_text === 'string') return json.output_text;
  const chatText = json.choices?.[0]?.message?.content;
  if (typeof chatText === 'string') return chatText;
  if (Array.isArray(chatText)) return chatText.map((p) => p?.text || '').join('');
  if (Array.isArray(json.output)) {
    return json.output
      .filter((item) => item?.type === 'message')
      .flatMap((item) => item?.content || [])
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

export function usageFrom(conn, json, fallbackIn, fallbackOut) {
  const u = json?.usage || {};
  if (conn.format === 'anthropic') {
    return {
      inputTokens: Number(u.input_tokens) || fallbackIn,
      outputTokens: Number(u.output_tokens) || fallbackOut,
      cachedTokens: Number(u.cache_read_input_tokens) || 0,
      cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
    };
  }
  if (conn.format === 'gemini') {
    const gm = json?.usageMetadata || json?.usage_metadata || {};
    return {
      inputTokens: Number(gm.promptTokenCount || gm.prompt_token_count) || fallbackIn,
      outputTokens: Number(gm.candidatesTokenCount || gm.candidates_token_count) || fallbackOut,
      cachedTokens: Number(gm.cachedContentTokenCount || gm.cached_content_token_count) || 0,
      cacheCreationInputTokens: 0,
    };
  }
  return {
    inputTokens: Number(u.input_tokens || u.prompt_tokens) || fallbackIn,
    outputTokens: Number(u.output_tokens || u.completion_tokens) || fallbackOut,
    cachedTokens: Number(u.input_tokens_details?.cached_tokens || u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens) || 0,
    cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
  };
}

export function extractToolCalls(conn, json) {
  if (!json) return [];
  if (conn.format === 'anthropic') {
    return (json.content || [])
      .filter((part) => part?.type === 'tool_use' && part.name)
      .map((part) => ({ id: part.id || '', name: part.name, arguments: part.input || {} }));
  }
  if (conn.format === 'gemini') {
    const callTracker = createGeminiPartCallTracker(buildGeminiSignatureScope(conn));
    const calls = [];
    for (const part of (json.candidates?.[0]?.content?.parts || [])) {
      const extracted = callTracker.consume(
        part,
        () => `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      );
      if (!extracted) continue;
      calls.push({ id: extracted.id, name: extracted.call.name, arguments: extracted.call.args || {} });
    }
    return calls;
  }
  const message = json.choices?.[0]?.message || {};
  const chatCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const responseCalls = Array.isArray(json.output) ? json.output.filter((item) => item?.type === 'function_call') : [];
  return [
    ...chatCalls.map((call) => ({
      id: call.id || '',
      name: call.function?.name || '',
      arguments: parseJsonObject(call.function?.arguments || '{}'),
    })),
    ...responseCalls.map((call) => ({
      id: call.call_id || call.id || '',
      name: call.name || '',
      arguments: parseJsonObject(call.arguments || '{}'),
    })),
  ].filter((call) => call.name);
}

export function upstreamReasoningText(conn, json) {
  if (!isPlainObject(json)) return '';
  if (conn?.format === 'anthropic') {
    return (json.content || []).filter((p) => p?.type === 'thinking').map((p) => String(p.thinking || '')).join('');
  }
  if (conn?.format === 'gemini') {
    return (json.candidates?.[0]?.content?.parts || []).filter((p) => p?.thought === true).map((p) => String(p.text || '')).join('');
  }
  if (Array.isArray(json.output)) {
    return json.output
      .filter((item) => item?.type === 'reasoning')
      .map((item) => {
        const summary = Array.isArray(item.summary) ? item.summary.map((s) => s?.text || '').join('') : '';
        const content = Array.isArray(item.content) ? item.content.map((c) => c?.text || '').join('') : '';
        return summary || content;
      })
      .join('');
  }
  if (json.choices?.[0]?.message) {
    return extractReasoningFromChatMessage(json.choices[0].message);
  }
  return '';
}

export function responseReasoningItems(conn, json) {
  if (conn?.format === 'openai' && Array.isArray(json?.output)) {
    const replayable = json.output.filter((item) => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content);
    if (replayable.length) return replayable;
  }
  const text = upstreamReasoningText(conn, json);
  if (!text) return [];
  return [{
    type: 'reasoning',
    summary: [{ type: 'summary_text', text }],
    content: [{ type: 'reasoning_text', text }],
  }];
}

function openAIUsage(usage = {}) {
  const prompt = Number(usage.inputTokens) || 0;
  const completion = Number(usage.outputTokens) || 0;
  const cached = Number(usage.cachedTokens) || 0;
  const cacheCreation = Number(usage.cacheCreationInputTokens) || 0;
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached };
  if (cacheCreation > 0) out.cache_creation_input_tokens = cacheCreation;
  return out;
}

function anthropicUsage(usage = {}) {
  const out = { input_tokens: Number(usage.inputTokens) || 0, output_tokens: Number(usage.outputTokens) || 0 };
  const cached = Number(usage.cachedTokens) || 0;
  const cacheCreation = Number(usage.cacheCreationInputTokens) || 0;
  if (cached > 0) out.cache_read_input_tokens = cached;
  if (cacheCreation > 0) out.cache_creation_input_tokens = cacheCreation;
  return out;
}

export function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chatCompletionToolCall(call, index) {
  return {
    index,
    id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
  };
}

export function sendOpenAIChat(ctx, res, result) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const extra = result.extraHeaders || {};
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    const chunk = (choices) => ({ id, object: 'chat.completion.chunk', created, model: ctx.model, choices });
    sse(res, null, chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));
    if (result.reasoningText) sse(res, null, chunk([{ index: 0, delta: { reasoning_content: result.reasoningText }, finish_reason: null }]));
    if (result.text) sse(res, null, chunk([{ index: 0, delta: { content: result.text }, finish_reason: null }]));
    if (toolCalls.length > 0) {
      sse(res, null, chunk([{
        index: 0,
        delta: {
          tool_calls: toolCalls.map((call, i) => {
            const { function: fn, ...rest } = chatCompletionToolCall(call, i);
            return { ...rest, function: { ...fn, arguments: '' } };
          }),
        },
        finish_reason: null,
      }]));
      sse(res, null, chunk([{
        index: 0,
        delta: {
          tool_calls: toolCalls.map((call, i) => ({ index: i, function: { arguments: JSON.stringify(call.arguments || {}) } })),
        },
        finish_reason: null,
      }]));
    }
    sse(res, null, chunk([{ index: 0, delta: {}, finish_reason: finishReason }]));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  const message = { role: 'assistant', content: result.text || '' };
  if (result.reasoningText) message.reasoning_content = result.reasoningText;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call, i) => {
      const { index, ...rest } = chatCompletionToolCall(call, i);
      return rest;
    });
  }
  sendJson(res, 200, { id, object: 'chat.completion', created, model: ctx.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: openAIUsage(result.usage) }, extra);
}

export async function sendOpenAIChatStream(ctx, res, result) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const extra = result.extraHeaders || {};
  res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
  sse(res, null, { id, object: 'chat.completion.chunk', created, model: ctx.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  const converter = createProtocolStreamTransform('openai', result.conn, ctx, { id, created });
  await runStreamPipeline({
    res,
    result,
    converter,
    useKeepalive: true,
    emitItem: (out) => sse(res, null, out),
    onUpstreamError: (message) => sse(res, null, { error: { message, type: 'upstream_error' } }),
    onCompleted: () => res.write('data: [DONE]\n\n'),
  });
}

export function responseObject(ctx, result, id) {
  const input = Number(result.usage?.inputTokens) || 0;
  const output = Number(result.usage?.outputTokens) || 0;
  const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
  const cached = Number(result.usage?.cachedTokens) || 0;
  if (cached > 0) usage.input_tokens_details = { cached_tokens: cached };
  if (Number(result.usage?.cacheCreationInputTokens) > 0) {
    usage.cache_creation_input_tokens = Number(result.usage.cacheCreationInputTokens);
  }
  const outputItems = responseReasoningItems(result.conn, result.json);
  if (!outputItems.length && result.reasoningText) {
    outputItems.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: result.reasoningText }],
      content: [{ type: 'reasoning_text', text: result.reasoningText }],
    });
  }
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls.filter((tc) => tc?.name) : [];
  const text = String(result.text || '');
  if (text || toolCalls.length === 0) {
    outputItems.push({
      type: 'message', id: `msg-${crypto.randomUUID()}`, status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }
  for (const tc of toolCalls) {
    outputItems.push({
      type: 'function_call',
      id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      call_id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
    });
  }
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: ctx.model, output_text: text, output: outputItems, usage };
}

export function sendOpenAIResponses(ctx, res, result) {
  const extra = result.extraHeaders || {};
  if (ctx.stream && result.stream === true && result.upstreamResponse) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    const converter = createProtocolStreamTransform('responses', result.conn, ctx);
    return runStreamPipeline({
      res,
      result,
      converter,
      useKeepalive: true,
      emitItem: (ev) => sse(res, ev.type, ev),
      onUpstreamError: (message) => sse(res, 'error', { type: 'error', message }),
      onCompleted: () => res.write('data: [DONE]\n\n'),
    });
  }

  const id = `resp-${crypto.randomUUID()}`;
  const obj = result.responseObj || responseObject(ctx, result, id);
  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    sse(res, 'response.created', { type: 'response.created', response: { ...obj, output: [], output_text: '' } });
    for (let i = 0; i < obj.output.length; i++) {
      const item = obj.output[i];
      if (item.type === 'reasoning') {
        sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress' } });
        const reasoningDelta = Array.isArray(item.summary) ? item.summary.map((s) => s?.text || '').join('') : '';
        if (reasoningDelta) {
          sse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: i, summary_index: 0, delta: reasoningDelta });
          sse(res, 'response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: i, summary_index: 0, text: reasoningDelta });
        }
        sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: i, item });
      } else if (item.type === 'message') {
        const msgText = String(item.content?.[0]?.text ?? result.text ?? '');
        sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: i, item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] } });
        if (msgText) {
          sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: i, content_index: 0, delta: msgText });
          sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: i, content_index: 0, text: msgText });
        }
        sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: i, item });
      } else {
        sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress' } });
        sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: i, item });
      }
    }
    sse(res, 'response.completed', { type: 'response.completed', response: obj });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  sendJson(res, 200, obj, extra);
}

export function sendAnthropic(ctx, res, result) {
  const extra = result.extraHeaders || {};
  const echoModel = ctx.originalModel || ctx.model;

  if (ctx.stream && result.stream === true && result.upstreamResponse) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    const converter = createProtocolStreamTransform('anthropic', result.conn, ctx);
    return runStreamPipeline({
      res,
      result,
      converter,
      useKeepalive: true,
      emitItem: (ev) => sse(res, ev.event, ev.data),
      onUpstreamError: (message) => sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message } }),
    });
  }

  const rawMessageId = result.json?.id;
  const messageId = typeof rawMessageId === 'string' && rawMessageId.trim()
    ? rawMessageId
    : ((typeof rawMessageId === 'number' || typeof rawMessageId === 'bigint') && String(rawMessageId).trim()
      ? String(rawMessageId)
      : `msg_${crypto.randomUUID().replace(/-/g, '')}`);

  let content = [];
  let stopReason = 'end_turn';
  let stopSequence = null;

  if (result.conn?.format === 'anthropic' && Array.isArray(result.json?.content) && result.json.content.length > 0) {
    content = result.json.content;
    stopReason = result.json.stop_reason || (result.toolCalls?.length ? 'tool_use' : 'end_turn');
    stopSequence = result.json.stop_sequence || null;
  } else {
    if (result.reasoningText) content.push({ type: 'thinking', thinking: result.reasoningText });
    if (result.text) content.push({ type: 'text', text: result.text });
    for (const tc of (result.toolCalls || [])) {
      content.push({
        type: 'tool_use',
        id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: tc.name,
        input: tc.arguments || {},
      });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    stopReason = (result.toolCalls && result.toolCalls.length > 0) ? 'tool_use' : 'end_turn';
  }

  const message = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: echoModel,
    content,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage: anthropicUsage(result.usage),
  };

  if (ctx.stream) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });
    let blockIndex = 0;
    for (const block of content) {
      if (block.type === 'text') {
        sse(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        if (block.text) sse(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: block.text } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      } else if (block.type === 'tool_use') {
        sse(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        const partialJson = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {});
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: partialJson } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      } else if (block.type === 'thinking') {
        sse(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } });
        if (block.thinking) sse(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: block.thinking } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      }
    }
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: stopSequence }, usage: anthropicUsage(result.usage) });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
    return;
  }
  sendJson(res, 200, message, extra);
}

function geminiUsageMetadata(usage = {}) {
  return geminiUsageMetadataFromStats(usage);
}

export function geminiResponsePayload(ctx, result) {
  if (result.conn?.format === 'gemini' && isPlainObject(result.json)) return result.json;
  const parts = [];
  if (result.reasoningText) parts.push({ text: result.reasoningText, thought: true });
  if (result.text) parts.push({ text: result.text });
  for (const call of result.toolCalls || []) {
    parts.push({
      functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args: call.arguments || {} },
      thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE,
    });
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: geminiUsageMetadata(result.usage),
    modelVersion: ctx.model,
  };
}

export function antigravityErrorSnapshot(ctx, message) {
  const text = `[AnyBridge] 上游请求失败：${message}`;
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    ...(ctx?.model ? { modelVersion: ctx.model } : {}),
  };
}

export function antigravityEnvelope(response) {
  return { response, traceId: '', metadata: {} };
}

export function writeAntigravityStreamError(res, ctx, message) {
  res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8' }));
  sse(res, null, antigravityEnvelope(antigravityErrorSnapshot(ctx, message)));
  res.end();
}

export function createGeminiStreamFromOpenAIChat() {
  const toolCalls = new Map();
  let usage = null;
  return {
    write(chunk) {
      if (!chunk || typeof chunk !== 'object') return [];
      if (chunk.usage) usage = chunk.usage;
      const out = [];
      const delta = chunk.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        out.push({ content: { role: 'model', parts: [{ text: delta.content }] }, finishReason: 'OTHER', index: 0 });
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        out.push({ content: { role: 'model', parts: [{ text: delta.reasoning_content, thought: true }] }, finishReason: 'OTHER', index: 0 });
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) || { id: '', name: '', args: '' };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = call.function.name;
        if (call.function?.arguments) current.args += call.function.arguments;
        toolCalls.set(index, current);
      }
      return out;
    },
    flush() {
      const out = [];
      if (toolCalls.size) {
        const parts = [];
        for (const call of toolCalls.values()) {
          let args = {};
          try { args = call.args ? JSON.parse(call.args) : {}; } catch {}
          parts.push({
            functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args },
            thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE,
          });
        }
        out.push({ content: { role: 'model', parts }, finishReason: 'TOOL_CALL', index: 0 });
      }
      out.push({ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 });
      return out;
    },
    getUsage() {
      return usage
        ? {
          inputTokens: Number(usage.prompt_tokens) || 0,
          outputTokens: Number(usage.completion_tokens) || 0,
          cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
        }
        : null;
    },
  };
}

export function sendGemini(ctx, res, result) {
  sendJson(res, 200, geminiResponsePayload(ctx, result), result.extraHeaders || {});
}

export function sendGeminiStream(ctx, res, result, asSse) {
  const extra = result.extraHeaders || {};
  if (result.stream === true && result.upstreamResponse) {
    const converter = createProtocolStreamTransform('gemini', result.conn, ctx);
    res.writeHead(200, cors({
      'content-type': asSse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
      ...extra,
    }));
    if (!asSse) res.write('[');
    let wroteAny = false;
    return runStreamPipeline({
      res,
      result,
      converter,
      useKeepalive: asSse,
      emitItem: (frame) => {
        if (asSse) sse(res, null, frame);
        else {
          res.write((wroteAny ? ',\n' : '\n') + JSON.stringify(frame));
          wroteAny = true;
        }
      },
      onUpstreamError: (safeErr) => {
        const errPayload = { error: { code: 502, message: safeErr, status: 'INTERNAL' } };
        if (asSse) sse(res, null, errPayload);
        else {
          res.write((wroteAny ? ',\n' : '\n') + JSON.stringify(errPayload));
          wroteAny = true;
        }
      },
      onFinally: () => {
        if (!asSse) {
          try { res.write(wroteAny ? '\n]' : ']'); } catch {}
        }
      },
    });
  }
  const payload = geminiResponsePayload(ctx, result);
  if (!asSse) { sendJson(res, 200, [payload], extra); return; }
  res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
  sse(res, null, payload);
  res.end();
}

export function sendAntigravityStream(ctx, res, result, customModel = null) {
  const extra = result.extraHeaders || {};
  if (result.stream === true && result.upstreamResponse) {
    res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
    const converter = createProtocolStreamTransform('antigravity', result.conn, ctx);
    return runStreamPipeline({
      res,
      result,
      converter,
      useKeepalive: true,
      emitItem: (frame) => sse(res, null, antigravityEnvelope(frame)),
      onUpstreamError: (msg) => {
        if (!customModel?.isInternalDependency) {
          sse(res, null, antigravityEnvelope(antigravityErrorSnapshot(ctx, msg)));
        }
      },
    });
  }
  const payload = geminiResponsePayload(ctx, result);
  const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
  if (payload.candidates?.[0]) {
    payload.candidates[0].finishReason = hasToolCalls ? 'TOOL_CALL' : 'OTHER';
  }
  res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }));
  sse(res, null, antigravityEnvelope(payload));
  sse(res, null, antigravityEnvelope({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }] }));
  res.end();
}

export function handleCountTokens(body, res) {
  const ctx = normalizeRequest('anthropic', body);
  sendJson(res, 200, { input_tokens: estimateTokens(ctx.messages, ctx.system) });
}
