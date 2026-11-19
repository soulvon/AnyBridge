// handlers/chat/to-openai-messages.js — Anthropic 消息结构向 OpenAI Responses / Chat Completions 转换

import { toolResultOutputText } from '../../lib/local-proxy/normalize.js';
import { applyChatAssistantReasoning } from '../../lib/local-proxy/upstream-payload.js';

export function toOpenAIMessages(systemPrompt, anthropicMessages) {
  const result = [];

  if (systemPrompt) {
    result.push({ role: 'developer', content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      let textContent = '';
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
      if (textContent) {
        result.push({ role: 'assistant', content: textContent });
      }

      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          result.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          });
        }
      }
    } else if (msg.role === 'user') {
      const contentParts = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          contentParts.push(block.text);
        } else if (block.type === 'image') {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${block.source?.media_type || 'image/png'};base64,${block.source?.data || ''}`,
          });
        } else if (block.type === 'tool_result') {
          result.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: toolResultOutputText(block.content),
          });
        }
      }

      if (contentParts.length > 0) {
        const hasMedia = contentParts.some(p => typeof p !== 'string');
        if (hasMedia) {
          result.push({
            role: 'user',
            content: contentParts.map(p =>
              typeof p === 'string' ? { type: 'input_text', text: p } : p
            ),
          });
        } else {
          result.push({ role: 'user', content: contentParts.join('\n') });
        }
      }
    }
  }

  return result;
}

export function toOpenAIChatMessages(systemPrompt, anthropicMessages) {
  const result = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      let textContent = '';
      const thinkingTexts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'thinking') {
          if (block.thinking) thinkingTexts.push(String(block.thinking));
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
            },
          });
        }
      }
      const out = { role: 'assistant', content: textContent || '' };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      applyChatAssistantReasoning(out, thinkingTexts, toolCalls.length > 0, msg.reasoning_content);
      result.push(out);
      continue;
    }

    const contentParts = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source?.media_type || 'image/png'};base64,${block.source?.data || ''}` },
        });
      } else if (block.type === 'tool_result') {
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolResultOutputText(block.content),
        });
      }
    }

    if (contentParts.length > 0) {
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        result.push({ role: msg.role, content: contentParts[0].text });
      } else {
        result.push({ role: msg.role, content: contentParts });
      }
    }
  }

  return result;
}
