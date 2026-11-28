// sidecar/lib/upstream-decoder.js — 统一四上游协议 (openai/responses/anthropic/gemini) 识别、
// 增量事件解码、usage 规范化与错误文本安全提取。

import crypto from 'node:crypto';
import {
  buildGeminiSignatureScope,
  createGeminiPartCallTracker,
} from './gemini-thought-signature.js';
import { redactGeminiCredential } from './google-gemini.js';

export function newCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function normalizeUsageStats(usage = null) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? 0) || 0;
  const cachedTokens = Number(
    usage.cachedTokens
    ?? usage.cacheRead
    ?? usage.cache_read_input_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.cachedContentTokenCount
    ?? 0,
  ) || 0;
  const cacheCreationInputTokens = Number(
    usage.cacheCreationInputTokens
    ?? usage.cache_creation_input_tokens
    ?? 0,
  ) || 0;
  return { inputTokens, outputTokens, cachedTokens, cacheCreationInputTokens };
}

export function geminiUsageMetadataFromStats(usage = {}) {
  const prompt = Number(usage.inputTokens) || 0;
  const candidates = Number(usage.outputTokens) || 0;
  const cached = Number(usage.cachedTokens) || 0;
  const out = { promptTokenCount: prompt, candidatesTokenCount: candidates, totalTokenCount: prompt + candidates };
  if (cached > 0) out.cachedContentTokenCount = cached;
  return out;
}

/**
 * 解析上游协议格式（支持静态连接信息 + 动态首帧纠正）。
 */
export function resolveUpstreamProtocol(conn, sampleEvent = null) {
  if (sampleEvent && typeof sampleEvent === 'object') {
    if (Array.isArray(sampleEvent.candidates)) return 'gemini';
    const t = typeof sampleEvent.type === 'string' ? sampleEvent.type : '';
    if (t.startsWith('response.')) return 'responses';
    if (['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(t)) {
      return 'anthropic';
    }
    if (Array.isArray(sampleEvent.choices)) return 'openai';
  }
  if (conn?.format === 'gemini') return 'gemini';
  if (conn?.format === 'anthropic') return 'anthropic';
  const apiPath = String(conn?.apiPath || '').toLowerCase();
  if (conn?.wireApi === 'responses' || apiPath.includes('/responses') || conn?.unlockKind === 'codex') {
    return 'responses';
  }
  return 'openai';
}

function normalizeFinishReason(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'stop';
  if (s === 'tool_use' || s === 'tool_calls' || s === 'tool_call') return 'tool_calls';
  if (s === 'max_tokens' || s === 'length') return 'length';
  if (s === 'content_filter' || s === 'safety' || s === 'recitation' || s === 'prohibited_content' || s === 'spii') return 'content_filter';
  return 'stop';
}

export function safeStreamErrMessage(err, conn) {
  const raw = err?.message || (typeof err === 'string' ? err : JSON.stringify(err || 'upstream stream error'));
  return conn?.format === 'gemini' ? redactGeminiCredential(String(raw), conn?.apiKey) : String(raw);
}

/**
 * 四上游统一增量解码器：
 * 输出标准事件序列：
 * - { type: 'thinking', text, signature? }
 * - { type: 'text', text }
 * - { type: 'tool_call_delta', index, id?, name?, argumentsDelta? }
 * - { type: 'tool_call', id, name, args, thoughtSignature? }
 * - { type: 'usage', usage }
 * - { type: 'finish', reason }
 */
export function createUpstreamEventDecoder(conn, options = {}) {
  let protocol = resolveUpstreamProtocol(conn);
  const mapToolName = typeof options?.mapToolName === 'function' ? options.mapToolName : null;
  const decodeName = (raw) => {
    const s = String(raw || '');
    return s && mapToolName ? String(mapToolName(s)) : s;
  };
  const scope = buildGeminiSignatureScope(conn);
  const geminiTracker = createGeminiPartCallTracker(scope);
  const sentGeminiCalls = new Set();
  const toolAccumulators = new Map();
  const responseIdxMap = new Map();
  const anthropicIdxMap = new Map();
  let nextToolIdx = 0;
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationInputTokens: 0 };
  let finishReason = null;
  let sawTerminal = false;
  let anthropicStopReason = 'end_turn';
  let sawGeminiToolCall = false;

  const updateUsage = (partial) => {
    const norm = normalizeUsageStats(partial);
    if (!norm) return;
    usage = {
      inputTokens: norm.inputTokens || usage.inputTokens,
      outputTokens: norm.outputTokens || usage.outputTokens,
      cachedTokens: norm.cachedTokens || usage.cachedTokens,
      cacheCreationInputTokens: norm.cacheCreationInputTokens || usage.cacheCreationInputTokens,
    };
  };

  const ensureAcc = (idx, init = {}) => {
    let acc = toolAccumulators.get(idx);
    if (!acc) {
      acc = { index: idx, id: '', name: '', argumentsText: '', rawArgs: undefined, thoughtSignature: '' };
      toolAccumulators.set(idx, acc);
    }
    if (init.id) acc.id = String(init.id);
    if (init.name) acc.name = decodeName(init.name);
    if (init.argumentsDelta) acc.argumentsText += String(init.argumentsDelta);
    if (init.rawArgs !== undefined) acc.rawArgs = init.rawArgs;
    if (init.thoughtSignature) acc.thoughtSignature = String(init.thoughtSignature);
    return acc;
  };

  return {
    get protocol() { return protocol; },
    markDone() {
      sawTerminal = true;
    },
    hasTerminalFrame() {
      return sawTerminal;
    },
    getUsage() {
      return { ...usage };
    },
    getFinishReason() {
      return finishReason || (toolAccumulators.size > 0 ? 'tool_calls' : 'stop');
    },
    getToolCalls() {
      return [...toolAccumulators.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, acc]) => {
          let args = acc.rawArgs;
          let argumentsJson = acc.argumentsText;
          if (args === undefined) {
            try { args = acc.argumentsText ? JSON.parse(acc.argumentsText) : {}; } catch { args = {}; }
          }
          if (!argumentsJson) {
            argumentsJson = typeof args === 'string' ? args : JSON.stringify(args || {});
          }
          return {
            id: acc.id || newCallId(),
            name: acc.name,
            arguments: argumentsJson,
            arguments_json: argumentsJson,
            args: args && typeof args === 'object' ? args : {},
            thoughtSignature: acc.thoughtSignature || '',
          };
        })
        .filter((tc) => tc.name);
    },
    write(event) {
      if (!event || typeof event !== 'object') return [];
      const detected = resolveUpstreamProtocol(conn, event);
      if (detected) protocol = detected;

      if (event.type === 'error' || event.type === 'response.failed' || (event.error && !Array.isArray(event.candidates))) {
        const errObj = event.error || event.response?.error || event;
        throw new Error(safeStreamErrMessage(errObj?.message || errObj, conn));
      }

      const out = [];
      if (protocol === 'openai') {
        if (event.usage) {
          updateUsage(event.usage);
          out.push({ type: 'usage', usage: this.getUsage() });
        }
        const choice = event.choices?.[0];
        if (!choice) return out;
        const src = choice.delta || choice.message || {};
        const reasoning = src.reasoning_content ?? src.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          out.push({ type: 'thinking', text: reasoning });
        }
        const text = typeof src.content === 'string'
          ? src.content
          : (Array.isArray(src.content) ? src.content.map((p) => p?.text || '').join('') : '');
        if (text) out.push({ type: 'text', text });

        for (const tc of (Array.isArray(src.tool_calls) ? src.tool_calls : [])) {
          const idx = Number.isFinite(Number(tc.index)) ? Number(tc.index) : nextToolIdx++;
          const id = tc.id ? String(tc.id) : '';
          const name = tc.function?.name ? decodeName(tc.function.name) : '';
          const argumentsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
          const acc = ensureAcc(idx, { id, name, argumentsDelta });
          if (!acc.id) acc.id = newCallId();
          out.push({
            type: 'tool_call_delta',
            index: idx,
            id: id || undefined,
            name: name || undefined,
            argumentsDelta,
          });
        }
        if (choice.finish_reason) {
          sawTerminal = true;
          finishReason = normalizeFinishReason(choice.finish_reason);
          out.push({ type: 'finish', reason: finishReason });
        }
        return out;
      }

      if (protocol === 'responses') {
        switch (event.type) {
          case 'response.reasoning.delta':
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta':
            if (event.delta) out.push({ type: 'thinking', text: String(event.delta) });
            break;
          case 'response.output_text.delta':
            if (event.delta) out.push({ type: 'text', text: String(event.delta) });
            break;
          case 'response.output_item.added': {
            const item = event.item;
            if (item?.type === 'function_call') {
              const outIdx = event.output_index ?? 0;
              const toolIdx = nextToolIdx++;
              responseIdxMap.set(outIdx, toolIdx);
              const id = String(item.call_id || item.id || newCallId());
              const name = decodeName(item.name);
              ensureAcc(toolIdx, { id, name });
              out.push({ type: 'tool_call_delta', index: toolIdx, id, name, argumentsDelta: '' });
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            const outIdx = event.output_index ?? 0;
            const toolIdx = responseIdxMap.get(outIdx);
            if (toolIdx != null && event.delta) {
              ensureAcc(toolIdx, { argumentsDelta: String(event.delta) });
              out.push({ type: 'tool_call_delta', index: toolIdx, argumentsDelta: String(event.delta) });
            }
            break;
          }
          case 'response.output_item.done': {
            const item = event.item;
            if (item?.type === 'function_call') {
              const outIdx = event.output_index ?? 0;
              let toolIdx = responseIdxMap.get(outIdx);
              if (toolIdx == null) {
                toolIdx = nextToolIdx++;
                responseIdxMap.set(outIdx, toolIdx);
              }
              const acc = ensureAcc(toolIdx, { id: item.call_id || item.id, name: item.name });
              if (!acc.argumentsText && typeof item.arguments === 'string' && item.arguments) {
                acc.argumentsText = item.arguments;
                out.push({ type: 'tool_call_delta', index: toolIdx, argumentsDelta: item.arguments });
              }
            }
            break;
          }
          case 'response.completed': {
            sawTerminal = true;
            const resp = event.response || {};
            if (resp.usage) {
              updateUsage(resp.usage);
              out.push({ type: 'usage', usage: this.getUsage() });
            }
            const hasTools = toolAccumulators.size > 0
              || (Array.isArray(resp.output) && resp.output.some((item) => item?.type === 'function_call'));
            finishReason = hasTools ? 'tool_calls' : 'stop';
            out.push({ type: 'finish', reason: finishReason });
            break;
          }
          default:
            break;
        }
        return out;
      }

      if (protocol === 'anthropic') {
        switch (event.type) {
          case 'message_start':
            if (event.message?.usage) {
              updateUsage(event.message.usage);
              out.push({ type: 'usage', usage: this.getUsage() });
            }
            break;
          case 'content_block_start': {
            const block = event.content_block;
            const bIdx = event.index ?? 0;
            if (block?.type === 'tool_use') {
              const toolIdx = nextToolIdx++;
              anthropicIdxMap.set(bIdx, toolIdx);
              const id = String(block.id || newCallId());
              const name = decodeName(block.name);
              ensureAcc(toolIdx, { id, name });
              out.push({ type: 'tool_call_delta', index: toolIdx, id, name, argumentsDelta: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const bIdx = event.index ?? 0;
            const delta = event.delta || {};
            if (delta.type === 'thinking_delta' && delta.thinking) {
              out.push({ type: 'thinking', text: String(delta.thinking) });
            } else if (delta.type === 'signature_delta' && delta.signature) {
              out.push({ type: 'thinking', text: '', signature: String(delta.signature) });
            } else if (delta.type === 'text_delta' && delta.text) {
              out.push({ type: 'text', text: String(delta.text) });
            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
              const toolIdx = anthropicIdxMap.get(bIdx);
              if (toolIdx != null) {
                ensureAcc(toolIdx, { argumentsDelta: String(delta.partial_json) });
                out.push({ type: 'tool_call_delta', index: toolIdx, argumentsDelta: String(delta.partial_json) });
              }
            }
            break;
          }
          case 'message_delta':
            if (event.delta?.stop_reason) anthropicStopReason = event.delta.stop_reason;
            if (event.usage) {
              updateUsage(event.usage);
              out.push({ type: 'usage', usage: this.getUsage() });
            }
            break;
          case 'message_stop':
            sawTerminal = true;
            finishReason = normalizeFinishReason(anthropicStopReason);
            out.push({ type: 'finish', reason: finishReason });
            break;
          default:
            break;
        }
        return out;
      }

      // Gemini
      const gm = event.usageMetadata || event.usage_metadata;
      if (gm) {
        updateUsage(gm);
        out.push({ type: 'usage', usage: this.getUsage() });
      }
      const cand = Array.isArray(event.candidates) ? event.candidates[0] : null;
      const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.thought === true) {
          const sig = String(part.thoughtSignature || part.thought_signature || '').trim();
          if (part.text || sig) out.push({ type: 'thinking', text: String(part.text || ''), ...(sig ? { signature: sig } : {}) });
          continue;
        }
        if (typeof part.text === 'string' && part.text) {
          out.push({ type: 'text', text: part.text });
          continue;
        }
        const extracted = geminiTracker.consume(part, newCallId);
        if (extracted) {
          const { call, id: callId, upstreamId, signature } = extracted;
          const argsText = JSON.stringify(call.args || {});
          const dedupKey = upstreamId ? `id:${upstreamId}` : `${call.name}|${argsText}`;
          if (sentGeminiCalls.has(dedupKey)) continue;
          sentGeminiCalls.add(dedupKey);
          sawGeminiToolCall = true;
          const idx = nextToolIdx++;
          ensureAcc(idx, {
            id: callId,
            name: call.name,
            argumentsDelta: argsText,
            rawArgs: call.args || {},
            thoughtSignature: signature,
          });
          out.push({ type: 'tool_call', id: callId, name: call.name, args: call.args || {}, thoughtSignature: signature });
        }
      }
      if (cand?.finishReason) {
        sawTerminal = true;
        finishReason = sawGeminiToolCall ? 'tool_calls' : normalizeFinishReason(cand.finishReason);
        out.push({ type: 'finish', reason: finishReason });
      }
      return out;
    },
  };
}
