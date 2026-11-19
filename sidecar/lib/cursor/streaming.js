// lib/cursor/streaming.js - Modular component split from cursor-proxy.js.

import {
  createUpstreamEventDecoder,
  settleStreamTrackerFail,
  settleStreamTrackerSuccess,
} from "../codec-registry.js";
import { parseSSEStream } from "../sse-parser.js";
import { CURSOR_AGENT_SYSTEM, CURSOR_TOOL_RESULT_MAX_BYTES } from "./common.js";
import { activePlanPrompt, appendBackgroundUpdate, loadConversationHistory, textPart } from "./stores.js";
import { cursorModePrompt, cursorReadTools, mcpToolsPrompt } from "./tool-definitions.js";
import { buildTextDeltaFrame, buildThinkingDeltaFrame, writeRunFrame } from "./tool-proto-builders.js";

function responsesInputFromMessages(messages) {
  return messages.map(message => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const text = (message.content || [])
      .filter(part => part?.type === 'text' && part.text)
      .map(part => String(part.text))
      .join('\n');
    return {
      type: 'message',
      role,
      content: [{
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text,
      }],
    };
  });
}


export function buildCursorInitialInput(sess) {
  const conversationID = sess.conversationID || sess.requestID || '';
  const history = conversationID ? loadConversationHistory(conversationID) : [];
  const messages = [
    ...history,
    { role: 'user', content: [textPart(sess.userText)] },
  ];
  return { conversationID, messages, input: responsesInputFromMessages(messages) };
}


export function buildAssistantInputItem(text) {
  const value = String(text || '');
  return {
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: value,
    }],
  };
}


export function buildFunctionCallInputItem(toolCall) {
  return {
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments || '{}',
  };
}


export function buildFunctionCallOutputInputItem(toolCall, output) {
  return {
    type: 'function_call_output',
    call_id: toolCall.id,
    output: String(output || ''),
  };
}


function limitUtf8Bytes(text, maxBytes) {
  const value = String(text || '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end = Math.max(0, end - Math.ceil((end || 1) / 8));
  }
  while (end < value.length && Buffer.byteLength(value.slice(0, end + 1), 'utf8') <= maxBytes) {
    end += 1;
  }
  return value.slice(0, end);
}


export function prepareToolOutputForModel(toolCall, output) {
  const value = output === undefined || output === null || output === ''
    ? '{"result":"ok"}'
    : String(output);
  if (Buffer.byteLength(value, 'utf8') <= CURSOR_TOOL_RESULT_MAX_BYTES) return value;
  const toolName = String(toolCall?.name || 'tool');
  const marker = `\n[truncated: Cursor ${toolName} tool output exceeded ${CURSOR_TOOL_RESULT_MAX_BYTES} bytes; rerun with a narrower scope or read a specific file/range for the rest.]`;
  return `${limitUtf8Bytes(value, CURSOR_TOOL_RESULT_MAX_BYTES)}${marker}`;
}

// Cursor 原生协议把用户选的思考档位放在 RequestedModel.parameters（effort/thinking）。
// 与 cursor-core 的 openai_responses 注入保持对称：有档位发 reasoning.effort，
// 只开思考不发档位时发 reasoning.summary（让上游走默认档），都关则不注入。

export function cursorReasoningFromSession(sess) {
  const params = sess?.requestedModel?.parameters || {};
  const raw = String(params.effort || params.reasoning || '').trim().toLowerCase();
  // effort=none 与 cursor-core 同口径：不注入档位（上游按默认档），不下发 'none'
  if (raw) return raw === 'none' ? null : { effort: raw };
  const thinkingOn = String(params.thinking || '').trim().toLowerCase() === 'true';
  if (thinkingOn || sess?.requestedModel?.maxMode === true) return { summary: 'auto' };
  return null;
}


export function buildLocalProxyContext(sess, adapter, inputItems = null) {
  const initial = inputItems ? null : buildCursorInitialInput(sess);
  const tools = cursorReadTools(sess);
  const system = [
    CURSOR_AGENT_SYSTEM,
    cursorModePrompt(sess.mode),
    activePlanPrompt(sess.conversationID || sess.requestID || ''),
    mcpToolsPrompt(sess),
  ].filter(Boolean).join('\n');
  const input = inputItems || initial.input;
  const reasoning = cursorReasoningFromSession(sess);
  return {
    client: 'cursor',
    kind: 'responses',
    model: adapter.id,
    system,
    messages: initial?.messages || [],
    tools,
    toolChoice: 'auto',
    stream: true,
    maxTokens: 4096,
    rawBody: {
      model: adapter.id,
      instructions: system,
      input,
      stream: true,
      max_output_tokens: 4096,
      tools,
      tool_choice: 'auto',
      ...(reasoning ? { reasoning } : {}),
    },
  };
}


export function writeBackgroundFrame(res, state, frame) {
  appendBackgroundUpdate(state, frame);
  return writeRunFrame(res, frame);
}


export async function consumeCursorUpstreamStream(res, result, { onText, onThinking } = {}) {
  if (!result?.upstreamResponse || typeof result.upstreamResponse[Symbol.asyncIterator] !== 'function') {
    throw new Error('Cursor RunSSE streaming requested but upstream response is not a readable stream');
  }
  const decoder = createUpstreamEventDecoder(result.conn);
  let assistantText = '';
  let disconnected = false;
  let sawDone = false;

  const destroyUpstream = () => {
    try { result.upstreamResponse?.destroy?.(); } catch {}
  };
  const onResClose = () => {
    if (!res?.writableEnded) {
      disconnected = true;
      destroyUpstream();
    }
  };
  if (typeof res?.once === 'function') res.once('close', onResClose);

  try {
    for await (const evt of parseSSEStream(result.upstreamResponse, { emitDone: true, onChunk: () => { result.watchdog?.touch?.(); } })) {
      if (disconnected || res?.destroyed || res?.writableEnded) {
        disconnected = true;
        break;
      }
      if (evt.done) {
        sawDone = true;
        decoder.markDone();
        break;
      }
      if (evt.jsonError) {
        throw new Error(`Cursor upstream stream contained invalid JSON data: ${String(evt.rawData || '').slice(0, 500)}`);
      }
      if (!evt.data || typeof evt.data !== 'object') continue;
      for (const ev of decoder.write(evt.data)) {
        if (ev.type === 'thinking' && ev.text && typeof onThinking === 'function') {
          if (onThinking(ev.text) === false) {
            disconnected = true;
            break;
          }
        } else if (ev.type === 'text' && ev.text) {
          assistantText += ev.text;
          if (typeof onText === 'function' && onText(ev.text) === false) {
            disconnected = true;
            break;
          }
        }
      }
      if (disconnected) break;
    }

    const usage = decoder.getUsage();
    const toolCalls = decoder.getToolCalls();
    const finishReason = decoder.getFinishReason();
    if (disconnected) {
      settleStreamTrackerFail(result, 'client disconnected', usage, true);
      return { assistantText, usage, toolCalls, finishReason, disconnected: true };
    }
    if (!sawDone && !decoder.hasTerminalFrame()) {
      throw new Error('Cursor upstream stream ended before terminal frame');
    }
    settleStreamTrackerSuccess(result, usage);
    return { assistantText, usage, toolCalls, finishReason, disconnected: false };
  } catch (err) {
    settleStreamTrackerFail(result, err?.message || String(err), decoder.getUsage(), disconnected);
    throw err;
  } finally {
    if (typeof res?.off === 'function') res.off('close', onResClose);
    destroyUpstream();
    try { result.watchdog?.clear?.(); } catch {}
  }
}

export async function writeStreamingResult(res, result) {
  return consumeCursorUpstreamStream(res, result, {
    onThinking: (text) => writeRunFrame(res, buildThinkingDeltaFrame(text)),
    onText: (text) => writeRunFrame(res, buildTextDeltaFrame(text)),
  });
}

