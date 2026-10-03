// chat-sse-transform.js — 上游流式事件 → OpenAI Chat Completions SSE chunk。
//
// 本地代理的 chat 入站真流式：客户端（CodeBuddy/ZCode/WorkBuddy/OpenCode）按
// Chat SSE 增量消费，上游可能是三种形态：
//   1. Responses SSE（codex 解锁 / 普通 Responses 上游）
//   2. Anthropic SSE（claudeCode 解锁 / 普通 Anthropic 上游）
//   3. Chat SSE（普通 OpenAI Chat 上游，直接透传）
// 三个转换器统一接口：write(event) → chunk[]，flush() → chunk[]，getUsage() → usage|null。

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
export function createChatSSEPassthrough(model) {
  let usage = null;
  return {
    write(event) {
      if (!event || typeof event !== 'object' || !Array.isArray(event.choices)) return [];
      if (event.usage) usage = event.usage;
      return [{ ...event, model }];
    },
    flush() { return []; },
    getUsage() { return usage; },
  };
}

// 按上游形态选择转换器。
export function createChatSSEConverter(conn, model, id, created) {
  if (conn?.format === 'anthropic') return createChatSSEFromAnthropic(model, id, created);
  const path = String(conn?.apiPath || '').toLowerCase();
  if (path.includes('/responses') || conn?.unlockKind === 'codex') return createChatSSEFromResponses(model, id, created);
  return createChatSSEPassthrough(model);
}
