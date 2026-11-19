// responses-chat-transform.js
// Responses API <-> Chat Completions API 双向转换模块
// 参考 CC-Switch 的 transform_codex_chat.rs 移植

import crypto from 'node:crypto';

const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  'frequency_penalty', 'logit_bias', 'logprobs', 'metadata', 'n',
  'parallel_tool_calls', 'presence_penalty', 'response_format', 'seed',
  'service_tier', 'stop', 'stream_options', 'top_logprobs', 'user',
];

const CHAT_TOOL_NAME_MAX_LEN = 64;
const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_FIELD = 'input';

// ═══════════════════════════════════════════════
// 1. Responses → Chat Completions 请求转换
// ═══════════════════════════════════════════════

export function responsesToChatCompletions(body, reasoningConfig = null) {
  const messages = [];
  const instructions = String(body.instructions || '').trim();
  if (instructions) messages.push({ role: 'system', content: instructions });

  const toolCtx = buildToolContext(body.tools);
  const input = Array.isArray(body.input) ? body.input
    : (typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : []);
  appendResponsesInputAsChatMessages(input, messages, toolCtx);
  collapseSystemMessagesToHead(messages);
  backfillToolCallReasoningPlaceholders(messages);

  const chatBody = { model: String(body.model || ''), messages, stream: body.stream === true };

  const maxOutput = Number(body.max_output_tokens);
  if (Number.isFinite(maxOutput) && maxOutput > 0) {
    chatBody.max_tokens = maxOutput;
    chatBody.max_completion_tokens = maxOutput;
  }
  if (body.max_tokens != null) chatBody.max_tokens = body.max_tokens;
  if (body.max_completion_tokens != null) chatBody.max_completion_tokens = body.max_completion_tokens;
  if (body.temperature != null) chatBody.temperature = body.temperature;
  if (body.top_p != null) chatBody.top_p = body.top_p;

  applyReasoningOptions(chatBody, body, reasoningConfig);

  if (toolCtx.chatTools.length > 0) {
    chatBody.tools = toolCtx.chatTools;
    chatBody.tool_choice = body.tool_choice || 'auto';
  } else {
    delete chatBody.tool_choice;
  }

  for (const field of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) chatBody[field] = body[field];
  }
  if (chatBody.stream && !chatBody.stream_options) {
    chatBody.stream_options = { include_usage: true };
  }
  return chatBody;
}

import {
  appendResponsesInputAsChatMessages,
  applyReasoningOptions,
  backfillToolCallReasoningPlaceholders,
  buildToolContext,
  collapseSystemMessagesToHead,
} from './responses-chat/to-chat.js';
import {
  aggregateChatSSEChunks,
  extractContentFromChatMessage,
  extractReasoningDelta,
  extractReasoningFromChatMessage,
  parseChatSSELines,
  splitThinkTags,
} from './responses-chat/content-helpers.js';
export { parseChatSSELines };

// ═══════════════════════════════════════════════
// 4. Chat → Responses 响应转换（非流式）
// ═══════════════════════════════════════════════

export function chatCompletionToResponse(chatResult, model) {
  const id = `resp-${crypto.randomUUID()}`;
  const choice = chatResult?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];

  // reasoning_content 字段（规范上游如 deepseek）+ content 里的<think> 标签（minimax 等）
  const fieldReasoning = extractReasoningFromChatMessage(message);
  const rawContent = extractContentFromChatMessage(message);
  const { reasoning: tagReasoning, content: cleanContent } = splitThinkTags(rawContent || '');
  const reasoningText = [fieldReasoning, tagReasoning].filter(Boolean).join('\n').trim();
  if (reasoningText) {
    output.push({
      type: 'reasoning',
      id: `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      summary: [{ type: 'summary_text', text: reasoningText }],
      content: [{ type: 'reasoning_text', text: reasoningText }],
    });
  }

  const contentText = cleanContent;
  if (contentText !== null && contentText !== '') {
    output.push({
      type: 'message', id: `msg-${crypto.randomUUID()}`,
      status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: contentText }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        call_id: tc.id || '', name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
      });
    }
  }

  const status = choice.finish_reason === 'length' ? 'incomplete' : 'completed';
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status, model: model || chatResult?.model || '',
    output_text: contentText || '', output,
    usage: chatUsageToResponsesUsage(chatResult?.usage),
  };
}



function chatUsageToResponsesUsage(usage) {
  const u = usage || {};
  const input = Number(u.prompt_tokens || u.input_tokens) || 0;
  const output = Number(u.completion_tokens || u.output_tokens) || 0;
  const total = Number(u.total_tokens) || (input + output);
  const cached = Number(u.prompt_tokens_details?.cached_tokens || u.input_tokens_details?.cached_tokens) || 0;
  const result = { input_tokens: input, output_tokens: output, total_tokens: total };
  if (cached > 0) result.input_tokens_details = { cached_tokens: cached };
  const reasoningTokens = Number(u.completion_tokens_details?.reasoning_tokens) || 0;
  result.output_tokens_details = { reasoning_tokens: reasoningTokens };
  if (u.cache_read_input_tokens) result.cache_read_input_tokens = Number(u.cache_read_input_tokens);
  if (u.cache_creation_input_tokens) result.cache_creation_input_tokens = Number(u.cache_creation_input_tokens);
  return result;
}

// ═══════════════════════════════════════════════
// 5. Chat 错误 → Responses 错误
// ═══════════════════════════════════════════════

export function chatErrorToResponseError(errorBody) {
  let message = 'Unknown error';
  let type = 'upstream_error';
  let code = null;

  if (typeof errorBody === 'string') {
    message = errorBody;
  } else if (errorBody?.error?.message) {
    message = String(errorBody.error.message);
    type = String(errorBody.error.type || 'upstream_error');
    code = errorBody.error.code || null;
  } else if (errorBody?.base_resp?.status_msg) {
    // MiniMax 非标
    message = String(errorBody.base_resp.status_msg);
    code = errorBody.base_resp.status_code || null;
  } else if (errorBody?.message) {
    message = String(errorBody.message);
  } else if (errorBody?.detail) {
    message = String(errorBody.detail);
  }

  return { error: { message, type, code, param: null } };
}

// ═══════════════════════════════════════════════
// 6. 流式响应转换（Chat SSE → Responses SSE）
// ═══════════════════════════════════════════════

/**
 * 创建 Responses SSE 流转换器
 * @param {string} model - 模型名
 * @param {string} [outputFormat='auto'] - reasoning 输出格式：auto/reasoning_content/reasoning/reasoning_details
 * @returns {object} { write(chunk), flush(), getResponse() }
 */
export function createResponsesSSEFromChat(model, outputFormat = 'auto') {
  const responseId = `resp-${crypto.randomUUID()}`;
  const messageId = `msg-${crypto.randomUUID()}`;
  const reasoningId = `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let created = false;
  let textBuffer = '';
  let reasoningBuffer = '';
  let toolCalls = [];
  let finishReason = null;
  let usage = null;
  // reasoning 和 message 是两个独立 output item：reasoning 在前(message 出现前先 done)
  let reasoningItemAdded = false;
  let reasoningPartAdded = false;
  let reasoningItemDone = false;
  let messageItemAdded = false;
  let textPartAdded = false;
  const openT = '<think>';
  const closeT = '</think>';

  //<think> 标签状态机：处理 content 字段里<think>...<think> 包裹的 thinking
  // minimax 等上游把 thinking 塞进 content 用标签包裹，需跨 delta 检测标签边界。
  let inThink = false;       // 当前是否在<think>...<think> 块内
  let pendingTail = '';      // 末尾可能是不完整标签的文本，暂不分发

  /**
   * 把一段已确认不含未完成标签的文本分发到对应通道。
   * inThink=true → reasoning 通道；false → output_text 通道。
   * 返回产生的 SSE 事件数组。
   */
  function emitContentText(text, baseEvents) {
    if (!text) return;
    if (inThink) {
      // reasoning 通道
      if (!reasoningItemAdded) {
        reasoningItemAdded = true;
        baseEvents.push({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: reasoningId, summary: [], content: [], status: 'in_progress' },
        });
      }
      if (!reasoningPartAdded) {
        reasoningPartAdded = true;
        baseEvents.push({
          type: 'response.content_part.added',
          item_id: reasoningId, output_index: 0, content_index: 0,
          part: { type: 'reasoning_text', text: '' },
        });
      }
      reasoningBuffer += text;
      baseEvents.push({
        type: 'response.reasoning_text.delta',
        item_id: reasoningId, output_index: 0, content_index: 0,
        delta: text,
      });
    } else {
      // output_text 通道
      const msgOutputIndex = reasoningItemAdded ? 1 : 0;
      if (!messageItemAdded) {
        messageItemAdded = true;
        baseEvents.push({
          type: 'response.output_item.added',
          output_index: msgOutputIndex,
          item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
        });
      }
      if (!textPartAdded) {
        textPartAdded = true;
        baseEvents.push({
          type: 'response.content_part.added',
          item_id: messageId, output_index: msgOutputIndex, content_index: 0,
          part: { type: 'output_text', text: '' },
        });
      }
      textBuffer += text;
      baseEvents.push({
        type: 'response.output_text.delta',
        item_id: messageId, output_index: msgOutputIndex, content_index: 0,
        delta: text,
      });
    }
  }

  /**
   * 处理 content delta：扫描<think> 标签边界，切换 inThink 状态，分发文本。
   * 标签可能跨 delta，用 pendingTail 暂存末尾不完整部分。
   */
  function processContentDelta(rawDelta, events) {
    let buf = pendingTail + rawDelta;
    pendingTail = '';
    while (buf.length) {
      const tag = inThink ? closeT : openT;
      const idx = buf.indexOf(tag);
      if (idx === -1) {
        // 没找到标签。末尾可能是不完整标签前缀，暂存。
        // 找最长的可能是标签前缀的尾部
        let keep = 0;
        for (let n = Math.min(buf.length, tag.length - 1); n >= 1; n--) {
          if (tag.startsWith(buf.slice(buf.length - n))) { keep = n; break; }
        }
        emitContentText(buf.slice(0, buf.length - keep), events);
        pendingTail = buf.slice(buf.length - keep);
        break;
      }
      // 找到标签：先分发标签前的文本
      emitContentText(buf.slice(0, idx), events);
      // 切换状态
      if (inThink) {
        // 闭合<think>：done reasoning item（若已建）
        if (reasoningItemAdded && !reasoningItemDone) {
          reasoningItemDone = true;
          events.push({
            type: 'response.reasoning_text.done',
            item_id: reasoningId, output_index: 0, content_index: 0,
            text: reasoningBuffer,
          });
          events.push({
            type: 'response.content_part.done',
            item_id: reasoningId, output_index: 0, content_index: 0,
            part: { type: 'reasoning_text', text: reasoningBuffer },
          });
          events.push({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning', id: reasoningId,
              summary: [{ type: 'summary_text', text: reasoningBuffer }],
              content: [{ type: 'reasoning_text', text: reasoningBuffer }],
            },
          });
        }
        inThink = false;
      } else {
        // 开启<think>
        inThink = true;
      }
      buf = buf.slice(idx + tag.length);
    }
  }

  return {
    /**
     * 处理一个 Chat SSE chunk，返回 Responses SSE 事件数组
     */
    write(chunk) {
      const events = [];
      const choice = chunk?.choices?.[0] || {};
      const delta = choice.delta || {};

      // response.created（仅首次）
      if (!created) {
        created = true;
        events.push({
          type: 'response.created',
          response: {
            id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
            status: 'in_progress', model, output: [], output_text: '',
          },
        });
      }

      // reasoning delta（规范上游如 deepseek 的 reasoning_content 字段）
      const reasoningDelta = extractReasoningDelta(delta, outputFormat);
      if (reasoningDelta) {
        // 先建独立 reasoning output item（output_index 0）
        if (!reasoningItemAdded) {
          reasoningItemAdded = true;
          events.push({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: reasoningId, summary: [], content: [], status: 'in_progress' },
          });
        }
        if (!reasoningPartAdded) {
          reasoningPartAdded = true;
          events.push({
            type: 'response.content_part.added',
            item_id: reasoningId, output_index: 0, content_index: 0,
            part: { type: 'reasoning_text', text: '' },
          });
        }
        reasoningBuffer += reasoningDelta;
        events.push({
          type: 'response.reasoning_text.delta',
          item_id: reasoningId, output_index: 0, content_index: 0,
          delta: reasoningDelta,
        });
      }

      // content delta：含<think> 标签时由状态机分流到 reasoning/output_text
      if (delta.content) {
        processContentDelta(delta.content, events);
      }

      // tool_calls delta
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }

      // finish_reason
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      // usage
      if (chunk.usage) {
        usage = chunk.usage;
      }

      return events;
    },

    /**
     * 生成结束事件
     */
    flush() {
      const events = [];
      const status = finishReason === 'length' ? 'incomplete' : 'completed';
      const finalUsage = chatUsageToResponsesUsage(usage);

      // 先冲掉 pendingTail 残留（可能是不完整标签或末尾文本）
      if (pendingTail) {
        const tmp = pendingTail;
        pendingTail = '';
        emitContentText(tmp, events);
      }

      // 若仍在 think 块内（上游未闭合<think>），强制闭合
      if (inThink) {
        inThink = false;
        if (reasoningItemAdded && !reasoningItemDone) {
          reasoningItemDone = true;
          events.push({
            type: 'response.reasoning_text.done',
            item_id: reasoningId, output_index: 0, content_index: 0,
            text: reasoningBuffer,
          });
          events.push({
            type: 'response.content_part.done',
            item_id: reasoningId, output_index: 0, content_index: 0,
            part: { type: 'reasoning_text', text: reasoningBuffer },
          });
          events.push({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning', id: reasoningId,
              summary: [{ type: 'summary_text', text: reasoningBuffer }],
              content: [{ type: 'reasoning_text', text: reasoningBuffer }],
            },
          });
        }
      }

      const msgOutputIndex = reasoningItemAdded ? 1 : 0;

      // 若 reasoning item 还没 done（content 从未出现），在此 done
      if (reasoningItemAdded && !reasoningItemDone) {
        reasoningItemDone = true;
        events.push({
          type: 'response.reasoning_text.done',
          item_id: reasoningId, output_index: 0, content_index: 0,
          text: reasoningBuffer,
        });
        events.push({
          type: 'response.content_part.done',
          item_id: reasoningId, output_index: 0, content_index: 0,
          part: { type: 'reasoning_text', text: reasoningBuffer },
        });
        events.push({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning', id: reasoningId,
            summary: [{ type: 'summary_text', text: reasoningBuffer }],
            content: [{ type: 'reasoning_text', text: reasoningBuffer }],
          },
        });
      }

      // message item：若 content 从未出现，补建 message item
      if (!messageItemAdded) {
        events.push({
          type: 'response.output_item.added',
          output_index: msgOutputIndex,
          item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
        });
        events.push({
          type: 'response.content_part.added',
          item_id: messageId, output_index: msgOutputIndex, content_index: 0,
          part: { type: 'output_text', text: '' },
        });
      }

      // output_text.done + content_part.done
      events.push({
        type: 'response.output_text.done',
        item_id: messageId, output_index: msgOutputIndex, content_index: 0,
        text: textBuffer,
      });
      events.push({
        type: 'response.content_part.done',
        item_id: messageId, output_index: msgOutputIndex, content_index: 0,
        part: { type: 'output_text', text: textBuffer },
      });
      events.push({
        type: 'response.output_item.done',
        output_index: msgOutputIndex,
        item: {
          type: 'message', id: messageId, status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: textBuffer }],
        },
      });

      // function_call items
      let outputIndex = msgOutputIndex + 1;
      for (const tc of toolCalls) {
        if (!tc) continue;
        events.push({
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { type: 'function_call', id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, call_id: tc.id, name: tc.name, arguments: tc.arguments },
        });
        events.push({
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: { type: 'function_call', id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, call_id: tc.id, name: tc.name, arguments: tc.arguments },
        });
        outputIndex++;
      }

      // response.completed
      const output = [];
      if (reasoningBuffer) {
        output.push({
          type: 'reasoning', id: reasoningId,
          summary: [{ type: 'summary_text', text: reasoningBuffer }],
          content: [{ type: 'reasoning_text', text: reasoningBuffer }],
        });
      }
      output.push({
        type: 'message', id: messageId, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: textBuffer }],
      });
      for (const tc of toolCalls) {
        if (!tc) continue;
        output.push({
          type: 'function_call',
          id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          call_id: tc.id, name: tc.name, arguments: tc.arguments,
        });
      }

      events.push({
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
          status, model, output, output_text: textBuffer, usage: finalUsage,
        },
      });

      return events;
    },

    getResponse() {
      const status = finishReason === 'length' ? 'incomplete' : 'completed';
      const output = [];
      if (reasoningBuffer) {
        output.push({
          type: 'reasoning', id: reasoningId,
          summary: [{ type: 'summary_text', text: reasoningBuffer }],
          content: [{ type: 'reasoning_text', text: reasoningBuffer }],
        });
      }
      output.push({
        type: 'message', id: messageId, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: textBuffer }],
      });
      for (const tc of toolCalls) {
        if (!tc) continue;
        output.push({
          type: 'function_call',
          id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          call_id: tc.id, name: tc.name, arguments: tc.arguments,
        });
      }
      return {
        id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status, model, output, output_text: textBuffer,
        usage: chatUsageToResponsesUsage(usage),
      };
    },
  };
}

/**
 * 将完整 SSE 文本聚合为单个 Chat Completion 对象（兜底）
 */
export function chatSSEToResponseValue(text, model) {
  const chunks = parseChatSSELines(text);
  return chatCompletionToResponse(aggregateChatSSEChunks(chunks, model), model);
}
