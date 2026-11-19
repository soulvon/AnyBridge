/**
 * Chat 消息推理/内容提取与 <think> 标签剥离辅助函数。
 */

import { parseSSEText } from '../sse-parser.js';

export function extractReasoningFromChatMessage(message) {
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
export function extractReasoningDelta(delta, outputFormat) {
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
 * 从 content 文本中剥离<think>...</think> 标签。
 * 某些上游（如 minimax-m3 经 opencode）把 thinking 用<think> 标签包裹后塞进 content 字段，
 * 而不是放在独立的 reasoning_content 字段。这里把标签内文本提取为 reasoning，标签外为正文。
 * @param {string} text
 * @returns {{ reasoning: string, content: string }}
 */
export function splitThinkTags(text) {
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

export function extractContentFromChatMessage(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map(p => p?.text || '').join('');
  return null;
}

export function parseChatSSELines(text) {
  const results = [];
  for (const evt of parseSSEText(text, { flush: true })) {
    if (evt.done || evt.jsonError || !evt.data || typeof evt.data !== 'object') continue;
    results.push(evt.data);
  }
  return results;
}

export function aggregateChatSSEChunks(chunks, model) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
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

  return {
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
}

