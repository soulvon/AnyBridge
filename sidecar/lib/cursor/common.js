// lib/cursor/common.js - Modular component split from cursor-proxy.js.

import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { configDir } from "../config-dir.js";
import { createSSEParser } from "../sse-parser.js";
import { writeVarintField } from "../../proto.js";

export const API2_HOSTS = new Set(['api2.cursor.sh']);
export const AUTH_HOSTS = new Set([
  'authentication.cursor.sh',
  'prod.authentication.cursor.sh',
]);
export const CURSOR_HOSTS = new Set([...API2_HOSTS, ...AUTH_HOSTS]);

export const PATHS = {
  availableModels: '/aiserver.v1.AiService/AvailableModels',
  defaultModelNudge: '/aiserver.v1.AiService/GetDefaultModelNudgeData',
  bidiAppend: '/aiserver.v1.BidiService/BidiAppend',
  runSSE: '/agent.v1.AgentService/RunSSE',
  writeGitCommitMessage: '/aiserver.v1.AiService/WriteGitCommitMessage',
  streamBugBotAgenticSSE: '/aiserver.v1.AiService/StreamBugBotAgenticSSE',
  backgroundAddFollowup: '/aiserver.v1.BackgroundComposerService/AddAsyncFollowupBackgroundComposer',
  backgroundStatus: '/aiserver.v1.BackgroundComposerService/GetBackgroundComposerStatus',
  backgroundAttach: '/aiserver.v1.BackgroundComposerService/AttachBackgroundComposer',
  backgroundInteractionUpdates: '/aiserver.v1.BackgroundComposerService/StreamInteractionUpdatesSSE',
};
export const RUNSSE_WAIT_TIMEOUT_MS = 5000;
export const RUNSSE_KEEPALIVE_MS = 10000;
export const SESSION_TTL_MS = 10 * 60 * 1000;
export const RECENT_SESSION_FALLBACK_MS = 2 * 60 * 1000;
export const BACKGROUND_COMPOSER_TTL_MS = 30 * 60 * 1000;
export const CURSOR_HISTORY_MAX_MESSAGES = 100;
export const CURSOR_HISTORY_MAX_BYTES = 1024 * 1024;
export const BACKGROUND_STATUS_RUNNING = 1;
export const BACKGROUND_STATUS_FINISHED = 2;
export const BACKGROUND_STATUS_ERROR = 3;
export const BACKGROUND_STATUS_CREATING = 4;
export const BUGBOT_STATUS_IN_PROGRESS = 1;
export const BUGBOT_STATUS_IN_PROGRESS_ITERATIONS = 2;
export const BUGBOT_STATUS_DONE = 3;
export const BUGBOT_STATUS_ERROR = 4;
export const BUGBOT_MAX_REPORTS = 20;
export const BUGBOT_RESPONSE_PREVIEW_BYTES = 2000;
export const CURSOR_TOOL_LOOP_MAX_ROUNDS = 20;
export const CURSOR_TURN_MAX_MS = 5 * 60 * 1000;
export const CURSOR_TOOL_RESULT_MAX_BYTES = 24 * 1024;
export const CURSOR_INTERACTION_WAIT_MS = 45000;
export const CURSOR_AGENT_SYSTEM = [
  'You are running inside Cursor through AnyBridge Cursor BYOK.',
  'Answer as a concise, practical coding assistant.',
  'The Cursor Read, Glob, Grep, Write, StrReplace, Delete, Shell, CreatePlan, AddTodo, UpdateTodo, SwitchMode, and MCP tools are bridged in this build when Cursor provides the corresponding tool metadata.',
  'Only claim you inspected or changed local files after using the corresponding Cursor tool, or when the user provided the content in chat.',
].join('\n');


export function cursorHistoryDir() {
  return path.join(configDir(), 'cursor-history');
}


export function conversationHistoryPath(conversationID) {
  const hash = crypto.createHash('sha256').update(String(conversationID || '')).digest('hex');
  return path.join(cursorHistoryDir(), `${hash}.json`);
}


export function conversationArtifactDir(conversationID) {
  const hash = crypto.createHash('sha256').update(String(conversationID || '')).digest('hex');
  return path.join(cursorHistoryDir(), hash);
}


function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
}


export function isCursorHost(value) {
  return CURSOR_HOSTS.has(normalizeHost(value));
}


export function requestHost(req, upstreamHost = '') {
  if (upstreamHost) return normalizeHost(upstreamHost);
  try {
    if (/^https?:\/\//i.test(req.url || '')) {
      return normalizeHost(new URL(req.url).host);
    }
  } catch {}
  return normalizeHost(req.headers?.host);
}


export function requestPath(req) {
  try {
    if (/^https?:\/\//i.test(req.url || '')) {
      return new URL(req.url).pathname;
    }
  } catch {}
  return String(req.url || '').split('?')[0] || '/';
}


export function respond404(res) {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end('404 page not found\n');
}


export function respondJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  });
  res.end(body);
}


export function respondProto(res, body) {
  res.writeHead(200, {
    'content-type': 'application/proto',
    'content-length': String(body.length),
  });
  res.end(body);
}


function httpDecodedBody(body, headers = {}) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') {
    return zlib.gunzipSync(body);
  }
  return body;
}


function isConnectContent(headers = {}) {
  return String(headers['content-type'] || '').toLowerCase().includes('connect');
}


export function decodeCursorPayloads(body, headers = {}) {
  const buf = httpDecodedBody(body, headers);
  if (!isConnectContent(headers) || buf.length < 5) return [buf];

  const frames = [];
  for (let offset = 0; offset + 5 <= buf.length;) {
    const flags = buf[offset];
    const length = buf.readUInt32BE(offset + 1);
    const end = offset + 5 + length;
    if (end > buf.length) break;
    let payload = buf.subarray(offset + 5, end);
    offset = end;
    if (flags & 0x02) continue;
    if (flags & 0x01) payload = zlib.gunzipSync(payload);
    frames.push(payload);
  }
  return frames.length ? frames : [buf];
}


export function decodeHexProto(value) {
  const hex = String(value || '').trim();
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error('Cursor BidiAppend data is not valid even-length hex');
  }
  return Buffer.from(hex, 'hex');
}


export function concat(parts) {
  return Buffer.concat(parts.filter(Boolean));
}


export function writeBoolField(field, value) {
  return writeVarintField(field, value ? 1 : 0);
}


export function normalizeTodoStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['pending', 'in_progress', 'completed', 'cancelled'].includes(value)) return value;
  return '';
}


export function todoStatusCode(status) {
  switch (normalizeTodoStatus(status)) {
    case 'in_progress': return 2;
    case 'completed': return 3;
    case 'cancelled': return 4;
    default: return 1;
  }
}


export function cloneTodos(todos = []) {
  return todos.map(todo => ({
    id: String(todo?.id || ''),
    content: String(todo?.content || ''),
    status: normalizeTodoStatus(todo?.status) || 'pending',
  }));
}


export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export function textChunks(text, size = 800) {
  const value = String(text || '');
  if (!value) return [];
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks;
}


function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}


export function usageTokens(usage, fallbackText = '') {
  const explicit = Number(usage?.totalTokens);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const input = Number(usage?.inputTokens) || Number(usage?.input_tokens) || Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.outputTokens) || Number(usage?.output_tokens) || Number(usage?.completion_tokens) || 0;
  const total = input + output;
  return total > 0 ? total : estimateTokens(fallbackText);
}


export function mergeUsage(left, right) {
  if (!right) return left || null;
  const out = { ...(left || {}) };
  for (const [target, keys] of [
    ['inputTokens', ['inputTokens', 'input_tokens', 'prompt_tokens']],
    ['outputTokens', ['outputTokens', 'output_tokens', 'completion_tokens']],
    ['cachedTokens', ['cachedTokens', 'cached_tokens']],
    ['totalTokens', ['totalTokens', 'total_tokens', 'total']],
  ]) {
    const value = keys.map(key => Number(right?.[key]) || 0).find(v => v > 0) || 0;
    out[target] = (Number(out[target]) || 0) + value;
  }
  return out;
}


export function openAIUsageFromStream(usage = {}) {
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens) || 0;
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens) || 0;
  return { inputTokens, outputTokens, cachedTokens };
}

export async function* parseUpstreamSSE(response) {
  if (!response || typeof response[Symbol.asyncIterator] !== 'function') {
    throw new Error('Cursor RunSSE streaming requested but upstream response is not a readable stream');
  }
  let flushing = false;
  let lastInvalidLine = '';
  let trailingInvalidLine = '';
  let sawValidEvent = false;
  const parser = createSSEParser({
    parseJson: true,
    onInvalidLine: (line) => {
      lastInvalidLine = line;
      if (flushing) trailingInvalidLine = line;
    },
  });

  const handleEvent = (evt) => {
    trailingInvalidLine = '';
    if (evt.done) return { done: true };
    if (evt.jsonError) {
      throw new Error(`Cursor RunSSE upstream stream contained invalid JSON data: ${String(evt.rawData || '').slice(0, 500)}`);
    }
    if (evt.data?.error) {
      const message = evt.data.error.message || evt.data.error.code || JSON.stringify(evt.data.error);
      throw new Error(`Cursor RunSSE upstream stream error: ${message}`);
    }
    sawValidEvent = true;
    return { done: false, value: evt.data };
  };

  for await (const chunk of response) {
    for (const evt of parser.push(chunk)) {
      const res = handleEvent(evt);
      if (res.done) return;
      yield res.value;
    }
  }

  flushing = true;
  for (const evt of parser.flush()) {
    const res = handleEvent(evt);
    if (res.done) return;
    yield res.value;
  }

  const badTrailing = trailingInvalidLine || (!sawValidEvent ? lastInvalidLine : '');
  if (badTrailing) {
    throw new Error(`Cursor RunSSE upstream stream ended with non-SSE trailing data: ${badTrailing.slice(0, 500)}`);
  }
}


export function chatStreamDeltas(chunk) {
  let text = '';
  let thinking = '';
  for (const choice of chunk?.choices || []) {
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string') text += delta.content;
    if (Array.isArray(delta.content)) {
      text += delta.content.map(part => part?.text || '').filter(Boolean).join('');
    }
    if (typeof delta.reasoning_content === 'string') thinking += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') thinking += delta.reasoning;
  }
  return { text, thinking };
}


export function accumulateChatToolCalls(chunk, accs) {
  for (const choice of chunk?.choices || []) {
    const sources = [];
    if (choice?.message && Array.isArray(choice.message.tool_calls)) sources.push(choice.message.tool_calls);
    if (choice?.delta && Array.isArray(choice.delta.tool_calls)) sources.push(choice.delta.tool_calls);
    for (const toolCalls of sources) {
      for (const tc of toolCalls) {
        const index = Number.isFinite(Number(tc.index)) ? Number(tc.index) : 0;
        if (!accs[index]) {
          accs[index] = { id: '', name: '', arguments: '' };
        }
        if (tc.id) accs[index].id = String(tc.id);
        if (tc.function?.name) accs[index].name = String(tc.function.name);
        if (typeof tc.function?.arguments === 'string') {
          accs[index].arguments += tc.function.arguments;
        }
      }
    }
  }
}


export function finalizeToolCalls(accs) {
  return accs
    .filter(Boolean)
    .map((tc, index) => ({
      id: tc.id || `call_${crypto.createHash('sha256').update(`${tc.name}|${tc.arguments}|${index}`).digest('hex').slice(0, 24)}`,
      name: tc.name,
      arguments: tc.arguments || '{}',
    }))
    .filter(tc => tc.name);
}


export function responseObjToolCalls(responseObj) {
  const out = [];
  for (const item of responseObj?.output || []) {
    if (item?.type !== 'function_call') continue;
    out.push({
      id: item.call_id || item.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: item.name || '',
      arguments: String(item.arguments || '{}'),
    });
  }
  return out.filter(tc => tc.name);
}


export function cursorErrorMessage(err) {
  const base = err?.message || String(err);
  const upstreamBody = err?.upstreamResponse?.body;
  if (!upstreamBody) return base;
  const preview = String(upstreamBody).slice(0, 1000);
  return `${base}: ${preview}`;
}

