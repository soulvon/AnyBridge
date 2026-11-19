import crypto from 'node:crypto';
import { toolResultOutputText } from '../local-proxy/normalize.js';

const CHAT_TOOL_NAME_MAX_LEN = 64;
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const TOOL_SEARCH_PROXY_NAME = 'tool_search';

// ═══════════════════════════════════════════════
// 1. Input 消息转换
// ═══════════════════════════════════════════════

export function appendResponsesInputAsChatMessages(inputItems, messages, toolCtx) {
  let pendingToolCalls = [];
  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;
    // Responses API 允许 message 项省略 type（用 role/content 表达）。
    // 之前只按 type 匹配，省略 type 的项会静默掉进"谁都不认识"的分支被丢弃，
    // 表现为上游收到空 messages（Gemini 系直接 400: contents is not specified）。
    const type = item.type || ((item.role || item.content) ? 'message' : '');
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
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: toolResultOutputText(item.output) });
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

export function collapseSystemMessagesToHead(messages) {
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

export function backfillToolCallReasoningPlaceholders(messages) {
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      if (msg.reasoning_content === undefined) msg.reasoning_content = '';
    }
  }
}

// ═══════════════════════════════════════════════
// 2. Tool 转换
// ═══════════════════════════════════════════════

export function buildToolContext(tools) {
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

export function applyReasoningOptions(chatBody, responsesBody, config) {
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

