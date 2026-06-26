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

function appendResponsesInputAsChatMessages(inputItems, messages, toolCtx) {
  let pendingToolCalls = [];
  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || '';
    if (type === 'function_call') {
      pendingToolCalls.push({
        id: item.call_id || item.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: resolveChatToolName(item.name, toolCtx), arguments: String(item.arguments || '{}') },
      });
    } else if (type === 'function_call_output') {
      if (pendingToolCalls.length > 0) {
        messages.push({ role: 'assistant', tool_calls: pendingToolCalls, reasoning_content: '' });
        pendingToolCalls = [];
      }
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: String(item.output || '') });
    } else if (type === 'message') {
      if (pendingToolCalls.length > 0) {
        messages.push({ role: 'assistant', tool_calls: pendingToolCalls, reasoning_content: '' });
        pendingToolCalls = [];
      }
      const role = item.role === 'assistant' ? 'assistant' : (item.role === 'system' ? 'system' : 'user');
      messages.push({ role, content: extractMessageContent(item.content) });
    } else if (type === 'reasoning') {
      const text = extractReasoningText(item);
      if (text) attachReasoningToLastAssistant(messages, text);
    } else if (type === 'input_text' || type === 'input_image' || type === 'input_file' || type === 'input_audio') {
      const content = convertInputPartToChat(item);
      if (content) messages.push({ role: 'user', content });
    }
  }
  if (pendingToolCalls.length > 0) {
    messages.push({ role: 'assistant', tool_calls: pendingToolCalls, reasoning_content: '' });
  }
}

function extractMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') {
      parts.push({ type: 'text', text: String(part.text || '') });
    } else if (part.type === 'input_image' || part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function convertInputPartToChat(item) {
  if (item.type === 'input_text') return String(item.text || '');
  if (item.type === 'input_image') {
    const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
    return url ? [{ type: 'image_url', image_url: { url } }] : null;
  }
  return null;
}

function extractReasoningText(item) {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map(p => p?.text || p?.content || '').filter(Boolean).join('');
  if (item.summary) return String(item.summary);
  return '';
}

function attachReasoningToLastAssistant(messages, text) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const existing = messages[i].reasoning_content;
      messages[i].reasoning_content = existing ? `${existing}\n${text}` : text;
      return;
    }
  }
}

function collapseSystemMessagesToHead(messages) {
  const systemParts = [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string' && m.content) systemParts.push(m.content);
  }
  if (systemParts.length <= 1) return;
  const filtered = messages.filter(m => m.role !== 'system');
  filtered.unshift({ role: 'system', content: systemParts.join('\n') });
  messages.length = 0;
  messages.push(...filtered);
}

function backfillToolCallReasoningPlaceholders(messages) {
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      if (msg.reasoning_content === undefined) msg.reasoning_content = '';
    }
  }
}

// ═══════════════════════════════════════════════
// 2. Tool 转换
// ═══════════════════════════════════════════════

function buildToolContext(tools) {
  const ctx = { chatTools: [], seenChatNames: new Set(), chatNameToSpec: new Map() };
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    const type = tool.type || '';
    if (type === 'function') addFunctionTool(ctx, tool, null);
    else if (type === 'custom') addCustomTool(ctx, tool);
    else if (type === 'tool_search') addToolSearchProxy(ctx);
    else if (type === 'namespace') expandNamespace(ctx, tool);
  }
  return ctx;
}

function addFunctionTool(ctx, tool, namespace) {
  const func = tool.function || tool;
  const name = String(func.name || '');
  if (!name) return;
  const chatName = namespace ? `${namespace}__${name}` : name;
  const truncated = truncateToolName(chatName);
  if (ctx.seenChatNames.has(truncated)) return;
  ctx.seenChatNames.add(truncated);
  ctx.chatNameToSpec.set(truncated, { kind: 'function', name, namespace });
  ctx.chatTools.push({
    type: 'function',
    function: {
      name: truncated,
      description: String(func.description || ''),
      parameters: func.parameters || func.input_schema || { type: 'object', properties: {} },
    },
  });
}

function addCustomTool(ctx, tool) {
  const name = String(tool.name || '');
  if (!name) return;
  const truncated = truncateToolName(name);
  if (ctx.seenChatNames.has(truncated)) return;
  ctx.seenChatNames.add(truncated);
  ctx.chatNameToSpec.set(truncated, { kind: 'custom', name, namespace: null });
  ctx.chatTools.push({
    type: 'function',
    function: {
      name: truncated,
      description: `${tool.description || ''}\n\nOriginal tool definition:\n${JSON.stringify(tool)}`.trim(),
      parameters: {
        type: 'object',
        properties: { [CUSTOM_TOOL_INPUT_FIELD]: { type: 'string', description: 'Raw string input for the original custom tool.' } },
        required: [CUSTOM_TOOL_INPUT_FIELD],
      },
    },
  });
}

function addToolSearchProxy(ctx) {
  if (ctx.seenChatNames.has(TOOL_SEARCH_PROXY_NAME)) return;
  ctx.seenChatNames.add(TOOL_SEARCH_PROXY_NAME);
  ctx.chatNameToSpec.set(TOOL_SEARCH_PROXY_NAME, { kind: 'tool_search', name: TOOL_SEARCH_PROXY_NAME, namespace: null });
  ctx.chatTools.push({
    type: 'function',
    function: {
      name: TOOL_SEARCH_PROXY_NAME,
      description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' }, limit: { type: 'integer', description: 'Max results', default: 10 } },
        required: ['query'],
      },
    },
  });
}

function expandNamespace(ctx, tool) {
  const ns = String(tool.name || '');
  if (!ns) return;
  for (const child of (tool.tools || tool.children || [])) {
    if (child?.type === 'function') addFunctionTool(ctx, child, ns);
  }
}

function truncateToolName(name) {
  if (name.length <= CHAT_TOOL_NAME_MAX_LEN) return name;
  const hash = crypto.createHash('sha256').update(name).digest('hex');
  return `${hash.slice(0, 56)}_${hash.slice(56, 63)}`;
}

function resolveChatToolName(originalName, toolCtx) {
  if (toolCtx.chatNameToSpec.has(originalName)) return originalName;
  for (const [chatName, spec] of toolCtx.chatNameToSpec) {
    if (spec.name === originalName) return chatName;
  }
  return originalName;
}

// ═══════════════════════════════════════════════
// 3. Reasoning 参数注入
// ═══════════════════════════════════════════════

function applyReasoningOptions(chatBody, responsesBody, config) {
  if (!config) {
    const effort = responsesBody?.reasoning?.effort;
    if (effort) chatBody.reasoning = { effort };
    return;
  }
  // 字段名与 Rust serde rename (camelCase) 保持一致
  const supportsThinking = config.supportsThinking === true || config.supportsEffort === true;
  const supportsEffort = config.supportsEffort === true;
  const thinkingParam = config.thinkingParam || 'none';
  const effortParam = config.effortParam || 'none';
  const effortValueMode = config.effortValueMode || 'passthrough';
  const requested = reasoningRequested(responsesBody);
  if (requested === null) return;
  const enabled = requested === true;

  if (supportsThinking) {
    if (thinkingParam === 'thinking') chatBody.thinking = { type: enabled ? 'enabled' : 'disabled' };
    else if (thinkingParam === 'enable_thinking') chatBody.enable_thinking = enabled;
    else if (thinkingParam === 'reasoning_split') chatBody.reasoning_split = enabled;
  }
  if (supportsEffort && enabled) {
    const mapped = mapReasoningEffort(responsesBody?.reasoning?.effort || 'medium', effortValueMode);
    if (effortParam === 'reasoning_effort') chatBody.reasoning_effort = mapped;
    else if (effortParam === 'reasoning.effort') chatBody.reasoning = { effort: mapped };
  } else if (supportsEffort && !enabled && effortParam === 'reasoning.effort') {
    chatBody.reasoning = { effort: 'none' };
  }
}

function reasoningRequested(body) {
  const effort = body?.reasoning?.effort;
  if (typeof effort === 'string') {
    return !['none', 'off', 'disabled'].includes(effort.trim().toLowerCase());
  }
  if (body?.reasoning !== undefined) return body.reasoning !== null;
  return null;
}

function mapReasoningEffort(effort, mode) {
  const lower = String(effort || '').trim().toLowerCase();
  if (mode === 'deepseek') return ['max', 'xhigh'].includes(lower) ? 'max' : 'high';
  if (mode === 'low_high') return ['minimal', 'low'].includes(lower) ? 'low' : 'high';
  if (mode === 'openrouter') return ['max', 'xhigh'].includes(lower) ? 'xhigh' : lower;
  return lower;
}

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

function extractReasoningFromChatMessage(message) {
  if (message.reasoning_content) return String(message.reasoning_content);
  if (typeof message.reasoning === 'string') return message.reasoning;
  if (message.reasoning?.content) return String(message.reasoning.content);
  if (Array.isArray(message.reasoning_details)) {
    return message.reasoning_details.map(d => d?.text || d?.content || '').filter(Boolean).join('');
  }
  return '';
}

/**
 * 从流式 delta 中提取 reasoning 文本
 * @param {object} delta - Chat SSE delta 对象
 * @param {string} outputFormat - auto/reasoning_content/reasoning/reasoning_details
 * @returns {string} reasoning 文本（可能为空字符串）
 */
function extractReasoningDelta(delta, outputFormat) {
  if (outputFormat === 'reasoning_content') return String(delta.reasoning_content || '');
  if (outputFormat === 'reasoning') {
    if (typeof delta.reasoning === 'string') return delta.reasoning;
    if (delta.reasoning?.content) return String(delta.reasoning.content);
    return '';
  }
  if (outputFormat === 'reasoning_details') {
    if (Array.isArray(delta.reasoning_details)) {
      return delta.reasoning_details.map(d => d?.text || d?.content || '').filter(Boolean).join('');
    }
    return '';
  }
  // auto: 检查所有常见字段
  if (delta.reasoning_content) return String(delta.reasoning_content);
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (delta.reasoning?.content) return String(delta.reasoning.content);
  if (Array.isArray(delta.reasoning_details)) {
    return delta.reasoning_details.map(d => d?.text || d?.content || '').filter(Boolean).join('');
  }
  return '';
}

/**
 * 从 content 文本中剥离<think>...<think> 标签。
 * 某些上游（如 minimax-m3 经 opencode）把 thinking 用<think> 标签包裹后塞进 content 字段，
 * 而不是放在独立的 reasoning_content 字段。这里把标签内文本提取为 reasoning，标签外为正文。
 * @param {string} text
 * @returns {{ reasoning: string, content: string }}
 */
function splitThinkTags(text) {
  const openT = '<think>';
  const closeT = '</think>';
  if (!text || typeof text !== 'string') return { reasoning: '', content: text || '' };
  let reasoning = '';
  let content = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(openT, i);
    if (open === -1) { content += text.slice(i); break; }
    content += text.slice(i, open);
    const close = text.indexOf(closeT, open + openT.length);
    if (close === -1) {
      // 没有闭合标签，剩余全部当正文
      content += text.slice(open);
      break;
    }
    reasoning += text.slice(open + openT.length, close).replace(/^\n+/, '').replace(/\n+$/, '');
    i = close + closeT.length;
  }
  return { reasoning: reasoning.trim(), content: content.trim() };
}

function extractContentFromChatMessage(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map(p => p?.text || '').join('');
  return null;
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
 * 将 SSE 文本行解析为 JSON 对象数组
 */
export function parseChatSSELines(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) continue;
    const data = trimmed.slice(6);
    if (data === '[DONE]') continue;
    try {
      results.push(JSON.parse(data));
    } catch {}
  }
  return results;
}

/**
 * 将完整 SSE 文本聚合为单个 Chat Completion 对象（兜底）
 */
export function chatSSEToResponseValue(text, model) {
  const chunks = parseChatSSELines(text);
  let content = '';
  let reasoning = '';
  let toolCalls = [];
  let finishReason = null;
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0] || {};
    const delta = choice.delta || {};
    const message = choice.message || {};

    // 假流式 message 快照
    if (message.content) content += typeof message.content === 'string' ? message.content : '';
    if (message.reasoning_content) reasoning += message.reasoning_content;
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        const idx = (tc.index || 0);
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
      }
    }

    // 增量 delta
    if (delta.content) content += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = (tc.index || 0);
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason && !finishReason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  // 构造 Chat Completion 对象
  const chatResult = {
    choices: [{
      message: {
        role: 'assistant',
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.filter(Boolean).length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
      },
      finish_reason: finishReason || 'stop',
    }],
    usage: usage || {},
    model,
  };

  return chatCompletionToResponse(chatResult, model);
}
