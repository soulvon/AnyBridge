// sidecar/lib/local-proxy/openai-anthropic-payload.js — OpenAI Chat / Responses 与 Anthropic 出站请求负载构造

import crypto from 'node:crypto';
import {
  applyCodexUnlockRequiredFields,
  buildClaudeCodeUnlockPayload,
  claudeCodeUnlockForTarget,
  codexUnlockForTarget,
} from '../codex-unlock.js';
import { responsesToChatCompletions } from '../responses-chat-transform.js';
import {
  applyThinkingToPayload,
  clampEffortLevel,
  effortFromAnthropicBudget,
  effortVocabForConn,
} from '../thinking-effort.js';
import {
  cleanBody,
  normalizeToolParameters,
  openAIPartFromAnthropic,
  textPart,
  toolDescriptor,
  toolResultOutputText,
} from './normalize.js';

export function applyChatAssistantReasoning(assistantMsg, thinkingParts = [], hasToolCalls = false, existingReasoning = undefined) {
  const joined = (Array.isArray(thinkingParts) ? thinkingParts : []).filter(Boolean).join('\n');
  if (existingReasoning !== undefined && existingReasoning !== null && String(existingReasoning) !== '') {
    assistantMsg.reasoning_content = String(existingReasoning);
  } else if (joined) {
    assistantMsg.reasoning_content = joined;
  } else if (hasToolCalls) {
    assistantMsg.reasoning_content = '';
  }
  return assistantMsg;
}

export function openAIChatMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const rawParts = Array.isArray(m.content) ? m.content : (m.content ? [textPart(m.content)].filter(Boolean) : []);
    const textParts = [];
    const thinkingParts = [];
    const toolCalls = [];
    for (const p of rawParts) {
      if (p.type === 'tool_use') {
        toolCalls.push({
          id: p.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: { name: p.name, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input || {}) },
        });
      } else if (p.type === 'tool_result') {
        const contentStr = toolResultOutputText(p.content);
        out.push({ role: 'tool', tool_call_id: p.tool_use_id || '', content: contentStr });
      } else if (p.type === 'thinking') {
        if (p.thinking) thinkingParts.push(String(p.thinking));
      } else if (p.type === 'gemini_part' && p.part?.thought === true) {
        if (p.part.text) thinkingParts.push(String(p.part.text));
      } else {
        const converted = openAIPartFromAnthropic(p, 'chat');
        if (converted) textParts.push(converted);
      }
    }
    if (m.role === 'assistant') {
      const assistantMsg = { role: 'assistant' };
      const content = textParts.length === 1 && textParts[0].type === 'text' ? textParts[0].text : (textParts.length > 0 ? textParts : null);
      if (content !== null) assistantMsg.content = content;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      applyChatAssistantReasoning(assistantMsg, thinkingParts, toolCalls.length > 0, m.reasoningContent ?? m.reasoning_content);
      if (assistantMsg.content != null || assistantMsg.tool_calls || assistantMsg.reasoning_content) out.push(assistantMsg);
    } else if (m.role === 'user' && textParts.length > 0) {
      const content = textParts.length === 1 && textParts[0].type === 'text' ? textParts[0].text : textParts;
      out.push({ role: 'user', content });
    }
  }
  return out;
}

export function responsesToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  if (choice.type === 'function' && choice.function?.name) {
    return { type: 'function', name: choice.function.name };
  }
  return choice;
}

export function openAIResponsesInput(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = [];
    const flush = () => {
      if (content.length > 0) {
        out.push({ role, content });
        content = [];
      }
    };
    for (const p of (m.content || [])) {
      if (p?.type === 'tool_use') {
        flush();
        out.push({
          type: 'function_call',
          call_id: String(p.id || ''),
          name: String(p.name || ''),
          arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input || {}),
        });
      } else if (p?.type === 'tool_result') {
        flush();
        out.push({
          type: 'function_call_output',
          call_id: String(p.tool_use_id || ''),
          output: toolResultOutputText(p.content),
        });
      } else {
        const converted = openAIPartFromAnthropic(p, 'responses');
        if (converted) {
          if (role === 'assistant' && converted.type === 'input_text') converted.type = 'output_text';
          content.push(converted);
        }
      }
    }
    flush();
  }
  return out;
}

export function anthropicToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    const lower = choice.toLowerCase();
    if (lower === 'auto') return { type: 'auto' };
    if (lower === 'required' || lower === 'any') return { type: 'any' };
    return undefined;
  }
  if (typeof choice === 'object') {
    if (choice.type === 'auto' || choice.type === 'any' || choice.type === 'tool') return choice;
    const name = choice.name || choice.function?.name;
    if (name) return { type: 'tool', name };
  }
  return undefined;
}

export function anthropicTools(tools) {
  const out = [];
  for (const tool of tools || []) {
    const descriptor = toolDescriptor(tool);
    if (!descriptor) continue;
    out.push({
      name: descriptor.name,
      description: descriptor.description,
      input_schema: normalizeToolParameters(descriptor.schema) || { type: 'object', properties: {} },
    });
  }
  return out.length ? out : undefined;
}

export function openAITools(tools, { chatCompletions = true } = {}) {
  const out = [];
  for (const tool of tools || []) {
    const descriptor = toolDescriptor(tool);
    if (!descriptor) continue;
    const parameters = normalizeToolParameters(descriptor.schema) || { type: 'object', properties: {} };
    if (chatCompletions) {
      out.push({ type: 'function', function: { name: descriptor.name, description: descriptor.description, parameters } });
    } else {
      out.push({ type: 'function', name: descriptor.name, description: descriptor.description, parameters });
    }
  }
  return out.length ? out : undefined;
}

export function anthropicMessagesWithoutSignature(messages) {
  return (messages || [])
    .map((m) => {
      const cleanContent = (m.content || [])
        .map((block) => {
          if (!block || typeof block !== 'object') return null;
          if (block.type === 'thinking' && !block.signature) return null;
          const { thoughtSignature, toolName, ...rest } = block;
          return rest;
        })
        .filter(Boolean);
      return { role: m.role, content: cleanContent };
    })
    .filter((m) => m.content.length > 0);
}

export function clientReasoningEffort(conn, ctx) {
  if (ctx?.kind !== 'responses') return null;
  const raw = String(ctx.rawBody?.reasoning?.effort || '').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'unset') return null;
  return clampEffortLevel(raw, effortVocabForConn(conn));
}

export function clientChatReasoningEffort(conn, ctx) {
  if (ctx?.kind !== 'openai') return null;
  const raw = String(ctx.rawBody?.reasoning_effort || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'none') return 'none';
  return clampEffortLevel(raw, effortVocabForConn(conn));
}

export function clientAnthropicEffort(conn, ctx) {
  if (ctx?.kind !== 'anthropic') return null;
  const thinking = ctx.rawBody?.thinking;
  if (!thinking || typeof thinking !== 'object') return null;
  if (thinking.type === 'disabled' || thinking.type === 'off') return null;
  const level = thinking.type === 'adaptive' ? 'high' : effortFromAnthropicBudget(thinking.budget_tokens);
  return level ? clampEffortLevel(level, effortVocabForConn(conn)) : null;
}

function finishAnthropicBody(conn, ctx, body) {
  if (!body.thinking) {
    const clientEffort = clientReasoningEffort(conn, ctx) || clientChatReasoningEffort(conn, ctx);
    if (clientEffort === 'none') applyThinkingToPayload(body, conn, { mode: 'off' });
    else if (clientEffort) applyThinkingToPayload(body, conn, { mode: 'level', level: clientEffort });
  }
  return body;
}

export function buildAnthropicUpstreamBody(conn, ctx, messages, extras = {}) {
  const anthropicMessages = anthropicMessagesWithoutSignature(messages);
  const claudeCodeUnlock = claudeCodeUnlockForTarget(conn);
  if (claudeCodeUnlock) {
    return buildClaudeCodeUnlockPayload({
      model: conn.model,
      system: ctx.system,
      messages: anthropicMessages,
      maxTokens: ctx.maxTokens,
      stream: false,
      tools: anthropicTools(ctx.tools),
      toolChoice: anthropicToolChoice(ctx.toolChoice),
    });
  }
  return finishAnthropicBody(conn, ctx, cleanBody({
    ...extras,
    model: conn.model,
    system: ctx.system || undefined,
    messages: anthropicMessages,
    max_tokens: ctx.maxTokens,
    temperature: ctx.temperature,
    stream: false,
    thinking: ctx.rawBody?.thinking || undefined,
    tools: anthropicTools(ctx.tools),
    tool_choice: anthropicToolChoice(ctx.toolChoice),
  }));
}

export function buildOpenAIUpstreamBody(conn, ctx, messages, extras = {}) {
  const codexUnlock = codexUnlockForTarget(conn);
  if (!codexUnlock && conn.wireApi === 'chat' && ctx.kind === 'responses' && ctx.rawBody) {
    const chatBody = responsesToChatCompletions(ctx.rawBody, conn.codexChatReasoning);
    chatBody.model = conn.model;
    return cleanBody({ ...extras, ...chatBody });
  }
  const useResponses = String(conn.apiPath || '').toLowerCase().includes('/responses');
  const clientEffort = clientReasoningEffort(conn, ctx) || clientChatReasoningEffort(conn, ctx) || clientAnthropicEffort(conn, ctx);
  if (useResponses) {
    const rawInput = ctx.kind === 'responses' ? ctx.rawBody?.input : undefined;
    const input = Array.isArray(rawInput) && rawInput.length > 0 ? rawInput : openAIResponsesInput(messages);
    const body = {
      ...extras,
      model: conn.model,
      input,
      instructions: ctx.system || undefined,
      max_output_tokens: codexUnlock ? undefined : ctx.maxTokens,
      temperature: ctx.temperature,
      stream: false,
      tools: openAITools(ctx.tools, { chatCompletions: false }),
      tool_choice: responsesToolChoice(ctx.toolChoice) || undefined,
      store: false,
    };
    if (clientEffort) body.reasoning = { effort: clientEffort };
    if (codexUnlock) applyCodexUnlockRequiredFields(body, codexUnlock);
    return cleanBody(body);
  }
  const chatBody = {
    ...extras,
    model: conn.model,
    messages: openAIChatMessages(ctx.system, messages),
    max_tokens: ctx.maxTokens,
    temperature: ctx.temperature,
    stream: false,
    tools: openAITools(ctx.tools),
    tool_choice: ctx.toolChoice || undefined,
  };
  if (chatBody.reasoning_effort === undefined && clientEffort) {
    chatBody.reasoning_effort = clientEffort;
  }
  return cleanBody(chatBody);
}
