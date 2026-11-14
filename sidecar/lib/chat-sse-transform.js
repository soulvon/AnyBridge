// chat-sse-transform.js — 上游流式事件 → OpenAI Chat Completions SSE chunk。
//
// 本地网关的 chat 入站真流式：客户端（CodeBuddy/ZCode/WorkBuddy/OpenCode）按
// Chat SSE 增量消费，上游可能是三种形态：
//   1. Responses SSE（codex 解锁 / 普通 Responses 上游）
//   2. Anthropic SSE（claudeCode 解锁 / 普通 Anthropic 上游）
//   3. Chat SSE（普通 OpenAI Chat 上游，直接透传）
// 三个转换器统一接口：write(event) → chunk[]，flush() → chunk[]，getUsage() → usage|null。

import crypto from 'node:crypto';

function chunkBase(id, created, model) {
  return { id, object: 'chat.completion.chunk', created, model };
}

function randomCallId() {
  return `call_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-6)}`;
}

// ─── Responses SSE → Chat SSE ─────────────────────────────
export function createChatSSEFromResponses(model, id, created) {
  const toolIndexByOutput = {};
  let nextToolIndex = 0;
  let usage = null;

  const textChunk = (text) => ({
    ...chunkBase(id, created, model),
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      const out = [];
      switch (event.type) {
        case 'response.output_item.added': {
          const item = event.item;
          if (item?.type === 'function_call') {
            const outputIndex = event.output_index ?? 0;
            const toolIndex = nextToolIndex;
            nextToolIndex += 1;
            toolIndexByOutput[outputIndex] = toolIndex;
            out.push({
              ...chunkBase(id, created, model),
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolIndex,
                    id: item.call_id || item.id || randomCallId(),
                    type: 'function',
                    function: { name: item.name || '', arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            });
          }
          break;
        }
        case 'response.output_text.delta': {
          if (event.delta) out.push(textChunk(event.delta));
          break;
        }
        case 'response.function_call_arguments.delta': {
          const outputIndex = event.output_index ?? 0;
          const toolIndex = toolIndexByOutput[outputIndex];
          if (toolIndex != null && event.delta) {
            out.push({
              ...chunkBase(id, created, model),
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: toolIndex, function: { arguments: event.delta } }] },
                finish_reason: null,
              }],
            });
          }
          break;
        }
        case 'response.completed': {
          const resp = event.response || {};
          const hasToolCall = Array.isArray(resp.output) && resp.output.some(item => item?.type === 'function_call');
          if (resp.usage) {
            const prompt = Number(resp.usage.input_tokens) || 0;
            const completion = Number(resp.usage.output_tokens) || 0;
            usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
            const cached = resp.usage.input_tokens_details?.cached_tokens
              ?? resp.usage.prompt_tokens_details?.cached_tokens;
            if (Number.isFinite(Number(cached)) && Number(cached) > 0) {
              usage.prompt_tokens_details = { cached_tokens: Number(cached) };
            }
          }
          out.push({
            ...chunkBase(id, created, model),
            choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }],
            ...(usage ? { usage } : {}),
          });
          break;
        }
        default:
          break; // created / in_progress / done 等元数据事件忽略
      }
      return out;
    },
    flush() { return []; },
    getUsage() { return usage; },
  };
}

// ─── Anthropic SSE → Chat SSE ─────────────────────────────
export function createChatSSEFromAnthropic(model, id, created) {
  const toolIndexByBlock = {};
  let nextToolIndex = 0;
  let usage = null;
  let finishReason = 'stop';

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      const out = [];
      switch (event.type) {
        case 'message_start': {
          const u = event.message?.usage;
          if (u) {
            const prompt = Number(u.input_tokens) || 0;
            usage = { prompt_tokens: prompt, completion_tokens: 0, total_tokens: prompt };
          }
          break;
        }
        case 'content_block_start': {
          const block = event.content_block;
          const blockIndex = event.index ?? 0;
          if (block?.type === 'tool_use') {
            const toolIndex = nextToolIndex;
            nextToolIndex += 1;
            toolIndexByBlock[blockIndex] = toolIndex;
            out.push({
              ...chunkBase(id, created, model),
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolIndex,
                    id: block.id || randomCallId(),
                    type: 'function',
                    function: { name: block.name || '', arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            });
          }
          break;
        }
        case 'content_block_delta': {
          const blockIndex = event.index ?? 0;
          const delta = event.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            out.push({
              ...chunkBase(id, created, model),
              choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
            });
          } else if (delta.type === 'input_json_delta') {
            const toolIndex = toolIndexByBlock[blockIndex];
            if (toolIndex != null && delta.partial_json) {
              out.push({
                ...chunkBase(id, created, model),
                choices: [{
                  index: 0,
                  delta: { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] },
                  finish_reason: null,
                }],
              });
            }
          }
          break;
        }
        case 'message_delta': {
          const stop = event.delta?.stop_reason;
          if (stop === 'tool_use') finishReason = 'tool_calls';
          else if (stop === 'max_tokens') finishReason = 'length';
          else if (stop) finishReason = 'stop';
          const outTokens = Number(event.usage?.output_tokens);
          if (usage && Number.isFinite(outTokens)) {
            usage.completion_tokens = outTokens;
            usage.total_tokens = usage.prompt_tokens + outTokens;
          }
          break;
        }
        case 'message_stop': {
          out.push({
            ...chunkBase(id, created, model),
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
          });
          break;
        }
        default:
          break; // content_block_stop / ping 等忽略
      }
      return out;
    },
    flush() { return []; },
    getUsage() { return usage; },
  };
}

// ─── Chat SSE 透传（上游即 Chat 格式，仅改写 model 名） ────
//
// 透传不等于「什么都不做」：上游是第三方供应商（中转站居多）时，chunk 的
// `id` 可能是数字、null，甚至干脆缺失；而客户端（CodeBuddy/ZCode/WorkBuddy/OpenCode）
// 是按官方 OpenAI 规范用 schema 校验的，非字符串 id 会直接报
// 「响应数据无效 / Expected 'id' to be a string」并让整轮对话失败。
// 既然流量经过我们中转，就有责任把响应规范到客户端期望的形状——
// 这里对 id / object / created 做兜底，合规的上游字段原样保留，不产生任何改写。
export function createChatSSEPassthrough(model, id, created) {
  let usage = null;
  const fallbackId = (typeof id === 'string' && id.trim()) ? id : '';
  const fallbackCreated = Number.isFinite(Number(created)) ? Number(created) : 0;
  // 同一条流内保持 id / created 稳定，避免每块都变导致客户端当作新消息
  let stableId = fallbackId;
  let stableCreated = fallbackCreated;

  const ensureId = (value) => {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (!stableId) stableId = `chatcmpl-${crypto.randomUUID()}`;
    return stableId;
  };
  const ensureCreated = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    if (!stableCreated) stableCreated = Math.floor(Date.now() / 1000);
    return stableCreated;
  };

  return {
    write(event) {
      if (!event || typeof event !== 'object' || !Array.isArray(event.choices)) return [];
      if (event.usage) usage = event.usage;
      return [{
        ...event,
        id: ensureId(event.id),
        // 流式出口只可能是 chunk；上游偶有写成 chat.completion 的，统一纠正
        object: 'chat.completion.chunk',
        created: ensureCreated(event.created),
        model,
      }];
    },
    flush() { return []; },
    getUsage() { return usage; },
  };
}

// ─── Gemini SSE → Chat SSE ─────────────────────────────
// 实测（2026-11-12，Vertex gemini-3.8-flash）：streamGenerateContent?alt=sse 的每个 data
// 是「增量片段」（各事件文本互不重叠），不是累计快照——直接下发即可，不能再做 diff。
// thought:true 的片段不发给客户端；functionCall 按 name+args 去重（同一调用可能重复出现）。
export function createChatSSEFromGemini(model, id, created) {
  const sentCalls = new Set();
  let nextToolIndex = 0;
  let usage = null;
  let finishReason = 'stop';

  const textChunk = (text) => ({
    ...chunkBase(id, created, model),
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });

  const reasonFromFinish = (raw) => {
    const s = String(raw || '').toUpperCase();
    if (s === 'MAX_TOKENS') return 'length';
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(s)) return 'content_filter';
    return 'stop';
  };

  return {
    write(event) {
      if (!event || typeof event !== 'object') return [];
      const out = [];
      const candidate = Array.isArray(event.candidates) ? event.candidates[0] : null;
      const parts = candidate?.content?.parts || [];

      const text = parts
        .filter((p) => p?.text && p.thought !== true)
        .map((p) => p.text)
        .join('');
      if (text) out.push(textChunk(text));

      for (const part of parts) {
        const call = part?.functionCall || part?.function_call;
        if (!call?.name) continue;
        const argsText = JSON.stringify(call.args || {});
        const key = `${call.name}|${argsText}`;
        if (sentCalls.has(key)) continue;
        sentCalls.add(key);
        const toolIndex = nextToolIndex;
        nextToolIndex += 1;
        out.push({
          ...chunkBase(id, created, model),
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                id: call.id || randomCallId(),
                type: 'function',
                function: { name: call.name, arguments: argsText },
              }],
            },
            finish_reason: null,
          }],
        });
      }

      if (candidate?.finishReason) {
        finishReason = sentCalls.size ? 'tool_calls' : reasonFromFinish(candidate.finishReason);
      }

      const gm = event.usageMetadata || event.usage_metadata;
      if (gm) {
        const prompt = Number(gm.promptTokenCount || gm.prompt_token_count) || 0;
        const completion = Number(gm.candidatesTokenCount || gm.candidates_token_count) || 0;
        const cached = Number(gm.cachedContentTokenCount || gm.cached_content_token_count) || 0;
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
        if (cached > 0) usage.prompt_tokens_details = { cached_tokens: cached };
      }
      return out;
    },
    flush() {
      return [{
        ...chunkBase(id, created, model),
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      }];
    },
    getUsage() { return usage; },
  };
}

// 按上游形态选择转换器。
export function createChatSSEConverter(conn, model, id, created) {
  if (conn?.format === 'gemini') return createChatSSEFromGemini(model, id, created);
  if (conn?.format === 'anthropic') return createChatSSEFromAnthropic(model, id, created);
  const path = String(conn?.apiPath || '').toLowerCase();
  if (path.includes('/responses') || conn?.unlockKind === 'codex') return createChatSSEFromResponses(model, id, created);
  return createChatSSEPassthrough(model, id, created);
}
