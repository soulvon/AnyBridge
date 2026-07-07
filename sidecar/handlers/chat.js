// handlers/chat.js — GetChatMessage handler (orchestrator)
//
// Parses Windsurf's protobuf request → calls Anthropic Messages API → streams
// back Connect-RPC protobuf using the correct exa.api_server_pb schema.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyCodexUnlockRequiredFields,
  buildClaudeCodeUnlockPayload,
  claudeCodeUnlockForTarget,
  claudeCodeUnlockHeaders,
  codexUnlockForTarget,
  codexUnlockHeaders,
} from '../lib/codex-unlock.js';
import { parseGetChatMessageRequest } from './parse-request.js';
import { buildErrorChunk } from './build-response.js';
import { AnthropicStreamProcessor, parseSSEChunk } from './anthropic-stream.js';
import { OpenAIChatCompletionsStreamProcessor, OpenAIStreamProcessor, parseOpenAISSEChunk } from './openai-stream.js';
import { wrapEnvelope, endOfStreamEnvelope, endOfStreamErrorEnvelope, streamHeaders, gzipSync, unwrapRequest } from '../connect.js';
import { recordRequest, recordUsage, recordError, recordLatency } from '../stats.js';
import { getInjectedByUid, getSlot, loadModelMapConfig, loadProviders, resolveTarget, rememberProviderToolSchemaCompat, updateModelCapabilities } from '../provider-pool.js';
import { mitmLog } from '../mitm-logger.js';
import { getRuntimeModelSlotStatus } from '../rename-models.js';
import { httpsAgentFor } from '../system-proxy.js';
import { preprocessImagesWithThirdPartyVision } from '../vision-fallback.js';
import {
  buildToolErrorContent,
  buildToolResultContent,
  enabledSearchSources,
  executeSearchWithFailover,
} from './search-sources.js';

// ─── Config ────────────────────────────────────────────────

function intEnv(names, fallback, min = 0) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null || raw === '') continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= min) return n;
  }
  return fallback;
}

const MAX_TOKENS = intEnv('MAX_TOKENS', 16384, 1);
const UPSTREAM_TIMEOUT_MS = intEnv(['UPSTREAM_TIMEOUT_MS', 'API_TIMEOUT_MS'], 300000, 1000);
const RETRY_MAX = intEnv('BYOK_RETRY_MAX', 5, 0);
const RETRY_BASE_MS = intEnv('BYOK_RETRY_BASE_MS', 600, 1);
const RETRY_CAP_MS = intEnv('BYOK_RETRY_CAP_MS', 8000, 1);
const RETRY_TOTAL_MS = intEnv('BYOK_RETRY_TOTAL_MS', 60000, 0);
const NATIVE_STREAM_ERRORS = /^(true|1|on)$/i.test(String(process.env.BYOK_NATIVE_ERRORS || 'false'));
const OPENAI_REASONING_EFFORT = String(process.env.BYOK_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || '').trim();
const OPENAI_REASONING_SUMMARY = String(process.env.BYOK_REASONING_SUMMARY || process.env.OPENAI_REASONING_SUMMARY || '').trim();
const PROMPT_CACHE_ENABLED = !/^(false|0|off)$/i.test(String(process.env.BYOK_PROMPT_CACHE || 'true'));
const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: intEnv('BYOK_MAX_SOCKETS', 64, 1),
  maxFreeSockets: intEnv('BYOK_MAX_FREE_SOCKETS', 16, 1),
});
const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: intEnv('BYOK_MAX_SOCKETS', 64, 1),
  maxFreeSockets: intEnv('BYOK_MAX_FREE_SOCKETS', 16, 1),
});
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_NETWORK', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED',
]);

function retryAfterMs(headers = {}) {
  const raw = headers['retry-after'];
  if (!raw) return 0;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const seconds = parseInt(val, 10);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_CAP_MS);
  const at = Date.parse(val);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_CAP_MS);
  return 0;
}

function isRetryableFailure(reason, meta = {}) {
  if (meta.statusCode) return RETRYABLE_STATUS.has(meta.statusCode);
  if (meta.code) return RETRYABLE_CODES.has(meta.code);
  return /timeout|reset|socket hang up|econn|epipe|network|dns|eai_again/i.test(String(reason || ''));
}

function positiveInt(value, fallback, min = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function retryPolicyFromEnhancement(enhancement = {}) {
  return {
    enabled: enhancement.retry !== false,
    maxRetries: positiveInt(enhancement.retryMaxRetries, RETRY_MAX, 0),
    baseMs: positiveInt(enhancement.retryBaseMs, RETRY_BASE_MS, 1),
    capMs: positiveInt(enhancement.retryCapMs, RETRY_CAP_MS, 1),
    totalMs: positiveInt(enhancement.retryTotalSeconds, Math.ceil(RETRY_TOTAL_MS / 1000), 1) * 1000,
  };
}

function retryDelayMs(attempt, meta = {}, policy = retryPolicyFromEnhancement()) {
  const exp = Math.min(policy.capMs, policy.baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.max(Math.random() * exp, retryAfterMs(meta.headers));
}

function clampText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function upstreamUrl(conn, apiPath) {
  const protocol = conn.protocol === 'http' ? 'http' : 'https';
  const hostname = conn.hostname || conn.host;
  const defaultPort = protocol === 'http' ? 80 : 443;
  const port = Number(conn.port || defaultPort);
  const portPart = port && port !== defaultPort ? `:${port}` : '';
  return `${protocol}://${hostname}${portPart}${apiPath}`;
}

function upstreamRequestOptions(conn, apiPath, headers) {
  const protocol = conn.protocol === 'http' ? 'http' : 'https';
  const defaultPort = protocol === 'http' ? 80 : 443;
  return {
    module: protocol === 'http' ? http : https,
    options: {
      agent: protocol === 'http' ? HTTP_AGENT : httpsAgentFor(HTTPS_AGENT),
      hostname: conn.hostname || conn.host,
      port: Number(conn.port || defaultPort),
      path: apiPath,
      method: 'POST',
      headers,
    },
  };
}

function extractUpstreamMessage(body) {
  if (!body) return '';
  const raw = String(body).trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    const msg = json?.error?.message
      || json?.error?.detail
      || json?.message
      || json?.detail
      || (typeof json?.error === 'string' ? json.error : '');
    if (msg) return clampText(msg.replace(/\s*\(request id:[^)]+\)/ig, ''));
  } catch {
    // Non-JSON provider bodies are still useful if they are short.
  }
  return clampText(raw.replace(/\s*\(request id:[^)]+\)/ig, ''));
}

function summarizeProviderMessage(message) {
  const text = clampText(message, 180);
  if (!text) return '';
  if (/无可用渠道|no available channel/i.test(text)) return '该中转当前没有可用渠道';
  if (/insufficient|quota|余额|额度|balance/i.test(text)) return '额度或余额不足';
  if (/invalid api key|unauthorized|认证|鉴权|api key/i.test(text)) return 'API Key 无效或已过期';
  if (/permission|forbidden|not allowed|无权限|未开通/i.test(text)) return '没有该模型权限或尚未开通';
  if (/model.*not found|does not exist|模型.*不存在|unknown model/i.test(text)) return '模型名不可用或未开通';
  if (/rate limit|too many requests|限流|频率|负载.*上限|达到上限|get_channel_failed|overloaded|service unavailable/i.test(text)) return '上游模型高负载或限流';
  if (/temporarily|维护|不可用/i.test(text)) return '上游服务暂时不可用';
  return text;
}

function targetLabel(failure = {}) {
  const provider = failure.providerName || failure.providerId || '未知供应商';
  const model = failure.model ? ` / ${failure.model}` : '';
  const route = [failure.routeMode, failure.apiPath].filter(Boolean).join(' ');
  return `「${provider}${model}${route ? ` · ${route}` : ''}」`;
}

function failureSummary(failure = {}) {
  const status = failure.statusCode ? `返回 HTTP ${failure.statusCode}` : `失败：${failure.reason || failure.code || '未知错误'}`;
  const upstream = summarizeProviderMessage(extractUpstreamMessage(failure.body));
  return `${targetLabel(failure)} ${status}${upstream ? `（${upstream}）` : ''}`;
}

function failureLogLine(failure = {}) {
  const upstream = summarizeProviderMessage(extractUpstreamMessage(failure.body));
  const route = [failure.routeMode, failure.apiPath].filter(Boolean).join(' ');
  return `${failure.providerName || failure.providerId || 'provider'}${route ? ` [${route}]` : ''}: ${failure.reason || failure.code || 'failed'}${upstream ? ` (${upstream})` : ''}`;
}

function failureHint(failures = []) {
  const text = failures.map(f => `${f.reason || ''} ${extractUpstreamMessage(f.body)}`).join(' ');
  if (failures.some(f => f.statusCode === 401) || /unauthorized|invalid api key|api key|认证|鉴权/i.test(text)) {
    return '请检查 API Key、账户状态和模型权限。';
  }
  if (failures.some(f => f.statusCode === 403) || /permission|forbidden|无权限|未开通/i.test(text)) {
    return '请检查模型权限，或换一个已开通的模型。';
  }
  if (failures.some(f => f.statusCode === 429 || f.statusCode === 529)
      || (failures.some(f => f.statusCode === 503) && /service unavailable|overloaded|temporarily/i.test(text))
      || /rate limit|too many requests|限流|频率|负载.*上限|达到上限|get_channel_failed|overloaded/i.test(text)) {
    return '请稍后重试，或降低并发/换备用供应商。';
  }
  if (/无可用渠道|no available channel/i.test(text)) {
    return '请切换模型/供应商，或在模型映射里添加备用目标。';
  }
  if (failures.some(f => ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(f.code))) {
    return '请检查网络、代理和 API Host 配置。';
  }
  return '请稍后重试，或在模型映射里添加备用目标。';
}

function connectCodeForFailures(failures = []) {
  if (failures.some(f => f.statusCode === 401)) return 'unauthenticated';
  if (failures.some(f => f.statusCode === 403)) return 'permission_denied';
  const text = failures.map(f => `${f.reason || ''} ${extractUpstreamMessage(f.body)}`).join(' ');
  if (failures.some(f => f.statusCode === 429 || f.statusCode === 529)) return 'resource_exhausted';
  if (failures.some(f => f.statusCode === 503) && /service unavailable|overloaded|temporarily/i.test(text)) return 'resource_exhausted';
  if (/负载.*上限|达到上限|get_channel_failed|rate limit|too many requests|限流|频率|overloaded/i.test(text)) return 'resource_exhausted';
  if (failures.some(f => f.statusCode === 408 || f.statusCode === 504 || f.code === 'ETIMEDOUT')) return 'deadline_exceeded';
  if (failures.some(f => f.statusCode >= 500 || f.code)) return 'unavailable';
  return 'invalid_argument';
}

function providerFailureMessage(failures = []) {
  if (failures.length === 0) {
    return 'BYOK 暂时无法连接模型：没有可用的供应商目标。请检查模型映射，或添加备用目标。';
  }
  const lastUpstreamBody = [...failures].reverse().find(f => typeof f.body === 'string' && f.body.length > 0)?.body;
  if (lastUpstreamBody) return lastUpstreamBody;
  const summaries = failures.map(failureSummary);
  const head = failures.length === 1
    ? `BYOK 暂时无法连接模型：${summaries[0]}。`
    : `BYOK 暂时无法连接模型，${failures.length} 个备用目标都不可用：${summaries.join('；')}。`;
  return clampText(`${head}${failureHint(failures)}`, 520);
}

function sendTerminalError(res, messageId, message, code = 'unavailable') {
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(200, streamHeaders());
  if (NATIVE_STREAM_ERRORS) {
    res.write(endOfStreamErrorEnvelope({ code, message }));
  } else {
    res.write(wrapEnvelope(buildErrorChunk(messageId, message)));
    res.write(endOfStreamEnvelope());
  }
  res.end();
}

// ─── Service tier (fast mode) ──────────────────────────────

// Detect fast mode from Windsurf model ID (suffix "-priority" = service_tier: fast)
function getServiceTier(requestedModel) {
  if (!requestedModel) return undefined;
  if (requestedModel.endsWith('-priority')) return 'fast';
  return undefined;
}

// 轻量提取 GetChatMessage 请求里的模型 ID（field21），不解析完整 body。
function extractModelId(body, headers) {
  try {
    const payload = unwrapRequest(body, headers || {});
    let i = 0;
    while (i < payload.length) {
      let tag = 0, shift = 0;
      while (true) { const b = payload[i++]; tag |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      const fn = tag >>> 3, wt = tag & 7;
      if (wt === 2) {
        let len = 0; shift = 0;
        while (true) { const b = payload[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
        if (fn === 21) return payload.subarray(i, i + len).toString('utf8');
        i += len;
      } else if (wt === 0) {
        while (payload[i++] & 0x80) {}
      } else if (wt === 5) { i += 4; }
      else if (wt === 1) { i += 8; }
      else return '';
    }
  } catch { /* 解析失败按"不拦截"处理，安全透传 */ }
  return '';
}

function messageHasImage(msg) {
  if (!msg || typeof msg.content === 'string') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(block => block && block.type === 'image');
}

function markModelSuccess(conn, model, messages, tools) {
  updateModelCapabilities(
    conn.providerId,
    model,
    Array.isArray(messages) && messages.some(messageHasImage),
    Array.isArray(tools) && tools.length > 0
  );
}

function enhancementHeaders(enhancement = {}, field) {
  if (enhancement.customHeadersEnabled !== true) return {};
  const rows = Array.isArray(enhancement[field]) ? enhancement[field] : [];
  const out = {};
  for (const h of rows) {
    if (h && h.key) out[h.key] = h.value;
  }
  return out;
}

function enhancementRequestHeaders(enhancement = {}) {
  return enhancementHeaders(enhancement, 'customHeaders');
}

function enhancementResponseHeaders(enhancement = {}) {
  return enhancementHeaders(enhancement, 'responseHeaders');
}

function applySystemPromptEnhancement(systemPrompt, enhancement = {}) {
  if (enhancement.systemPromptPrefixEnabled !== true || !enhancement.systemPromptPrefix) {
    return systemPrompt;
  }
  return [enhancement.systemPromptPrefix, systemPrompt].filter(Boolean).join('\n\n');
}

function chatToolName(tool) {
  const functionName = String(tool?.name || tool?.function?.name || '').trim();
  if (functionName) return functionName;
  if (tool?.google_search && typeof tool.google_search === 'object') return 'google_search';
  if (typeof tool?.type === 'string' && tool.type && tool.type !== 'function') return tool.type.trim();
  return '';
}

function chatToolChoiceName(choice) {
  if (!choice || typeof choice !== 'object') return '';
  if (choice.type === 'tool') return String(choice.name || '').trim();
  if (choice.type === 'function') return String(choice.function?.name || choice.name || '').trim();
  return '';
}

function applyChatToolEnhancement(tools, toolChoice, enhancement = {}) {
  let nextTools = Array.isArray(tools) ? tools : [];
  let nextToolChoice = toolChoice;
  if (enhancement.toolFilterEnabled !== true) return { tools: nextTools, toolChoice: nextToolChoice };

  if (enhancement.toolFilterMode && nextTools.length) {
    const filterSet = new Set((enhancement.toolFilterList || []).map(n => String(n || '').trim()).filter(Boolean));
    if (filterSet.size) {
      nextTools = nextTools.filter(tool => {
        const name = chatToolName(tool);
        if (enhancement.toolFilterMode === 'allow') return filterSet.has(name);
        if (enhancement.toolFilterMode === 'deny') return !filterSet.has(name);
        return true;
      });
    }
  }

  if (enhancement.forceToolChoice) {
    nextToolChoice = enhancement.forceToolChoice;
  }

  const chosenTool = chatToolChoiceName(nextToolChoice);
  if (chosenTool) {
    const available = new Set(nextTools.map(chatToolName).filter(Boolean));
    if (!available.has(chosenTool)) {
      return {
        tools: nextTools,
        toolChoice: nextToolChoice,
        error: `工具过滤后 tool_choice 指向不可用工具: ${chosenTool}`,
      };
    }
  }

  return { tools: nextTools, toolChoice: nextToolChoice };
}

const BUILTIN_SEARCH_TOOLS = [
  {
    match: (conn) =>
      (conn.providerId === 'google' || /^gemini/i.test(conn.model || '')) &&
      conn.format === 'openai',
    injectTool: () => ({ google_search: {} }),
  },
  {
    match: (conn) =>
      (conn.providerId === 'xai' || /^grok/i.test(conn.model || '')) &&
      conn.format === 'openai',
    injectTool: () => ({ type: 'web_search' }),
  },
  {
    match: (conn) =>
      conn.providerId === 'openai' &&
      conn.format === 'openai' &&
      /search-preview/i.test(conn.model || ''),
    injectTool: (conn) => isOpenAIResponsesPath(conn.apiPath)
      ? ({ type: 'web_search_preview' })
      : null,
  },
];

function isOpenAIResponsesPath(apiPath = '') {
  return /\/responses(?:$|\?)/i.test(String(apiPath || ''));
}

function isOpenAIChatCompletionsPath(apiPath = '') {
  return /\/chat\/completions(?:$|\?)/i.test(String(apiPath || ''));
}

function applyChatToolInjection(tools, conn, enhancement = {}, searchModels = {}) {
  const nextTools = Array.isArray(tools) ? [...tools] : [];
  if (enhancement.webSearchEnabled !== true) {
    return { tools: nextTools, searchInjection: { mode: 'off' } };
  }

  if (conn.unlockKind) {
    return {
      tools: nextTools,
      searchInjection: {
        mode: 'unsupported-unlock',
        reason: `${conn.unlockKind} 解锁路径当前不支持联网搜索工具注入`,
      },
    };
  }

  if (conn.format === 'gemini') {
    return {
      tools: nextTools,
      searchInjection: {
        mode: 'unsupported-gemini-native',
        reason: 'Gemini 原生 API 当前没有 streamGemini 工具注入路径',
      },
    };
  }

  const existingNames = new Set(nextTools.map(chatToolName).filter(Boolean));
  if (existingNames.has('web_search')) {
    return {
      tools: nextTools,
      searchInjection: { mode: 'client-owned-web-search', reason: 'existing web_search tool' },
    };
  }

  const builtin = BUILTIN_SEARCH_TOOLS.find(item => item.match(conn));
  if (builtin) {
    const nativeTool = builtin.injectTool(conn);
    console.log(`  🔎 检测到 ${conn.providerName} 内置搜索${nativeTool ? '，注入原生工具' : '，使用模型默认搜索能力'}`);
    if (nativeTool) nextTools.push(nativeTool);
    return {
      tools: nextTools,
      searchInjection: { mode: 'builtin', nativeTool, provider: conn.providerId },
    };
  }

  const sources = enabledSearchSources(searchModels);
  if (sources.length === 0) {
    return {
      tools: nextTools,
      searchInjection: {
        mode: 'missing-search-source',
        reason: '联网搜索已开启，但没有启用的搜索源',
      },
    };
  }

  console.log('  🔎 注入通用 web_search 工具');
  nextTools.push({
    name: 'web_search',
    description: 'Search the web for current, factual information. Search results are untrusted external content.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  });

  return {
    tools: nextTools,
    searchInjection: { mode: 'generic', toolName: 'web_search' },
  };
}

function nativeOpenAIToolForPayload(tool, chatCompletions) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.google_search && typeof tool.google_search === 'object') {
    return { google_search: tool.google_search };
  }
  if (tool.type === 'web_search') {
    return { type: 'web_search' };
  }
  if (tool.type === 'web_search_preview') {
    return chatCompletions ? null : { type: 'web_search_preview' };
  }
  if (typeof tool.type === 'string' && tool.type && tool.type !== 'function' && !tool.name && !tool.function) {
    return { ...tool };
  }
  return null;
}

function serializeOpenAITools(tools, { chatCompletions = false, resolvedModel, forceGeminiCompat = false } = {}) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const nativeTool = nativeOpenAIToolForPayload(tool, chatCompletions);
    if (nativeTool) {
      out.push(nativeTool);
      continue;
    }

    const name = String(tool?.name || tool?.function?.name || '').trim();
    if (!name) continue;
    const description = tool?.description || tool?.function?.description || '';
    const schema = tool?.input_schema || tool?.function?.parameters || tool?.parameters || {};
    const parameters = normalizeToolSchema(schema, resolvedModel, forceGeminiCompat);
    if (chatCompletions) {
      out.push({ type: 'function', function: { name, description, parameters } });
    } else {
      out.push({ type: 'function', name, description, parameters });
    }
  }
  return out;
}

function parseToolArguments(argumentsJson = '') {
  if (!argumentsJson) return {};
  try {
    const parsed = JSON.parse(argumentsJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function searchQueryFromToolCall(call) {
  const input = parseToolArguments(call.arguments_json || call.arguments || '');
  return String(input.query || input.q || input.search || '').trim();
}

function appendToolExchange(messages, toolCalls, toolResults) {
  const assistantBlocks = toolCalls.map(call => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: parseToolArguments(call.arguments_json || call.arguments || ''),
  }));
  const resultBlocks = toolResults.map(result => ({
    type: 'tool_result',
    tool_use_id: result.id,
    content: result.content,
  }));
  return [
    ...messages,
    { role: 'assistant', content: assistantBlocks },
    { role: 'user', content: resultBlocks },
  ];
}

function positiveOverrideInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} 必须是大于 0 的整数`);
  return n;
}

function applyPayloadParamOverrides(payload, enhancement = {}, tokenKey = 'max_tokens') {
  if (enhancement.paramOverridesEnabled !== true) return;
  const overrides = enhancement.paramOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;

  for (const [key, value] of Object.entries(overrides)) {
    if (['max_tokens', 'max_output_tokens', 'max_completion_tokens', 'maxTokens'].includes(key)) {
      payload[tokenKey] = positiveOverrideInt(value, key);
    } else if (['model', 'messages', 'input', 'stream'].includes(key)) {
      throw new Error(`请求参数覆盖不支持修改 ${key}`);
    } else if (key === 'toolChoice') {
      payload.tool_choice = value;
    } else {
      payload[key] = value;
    }
  }
}

const chatRateLimitBuckets = new Map();
function checkChatRateLimit(model, rpm) {
  const now = Date.now();
  const windowMs = 60000;
  const bucket = chatRateLimitBuckets.get(model);
  if (!bucket || now > bucket.resetAt) {
    chatRateLimitBuckets.set(model, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= rpm) return false;
  bucket.count++;
  return true;
}

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(os.homedir(), 'AppData', 'Roaming', name);
}

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function logEnhancedChatRequest(entry) {
  try {
    const dir = path.join(configDir(), 'proxy-logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `proxy-${date}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      entrypoint: 'get-chat-message',
      ...entry,
    }) + '\n');
  } catch (e) {
    console.warn(`  ⚠️  请求日志写入失败: ${e.message}`);
  }
}

function logEnhancedChatResponse(enhancement, conn, resolvedModel, processor) {
  if (enhancement.requestLogging !== true) return;
  logEnhancedChatRequest({
    phase: 'response',
    provider: conn.providerName,
    model: resolvedModel,
    statusCode: 200,
    usage: processor?.usage || {},
  });
}

function shouldUseAnthropicPromptCache(conn, claudeCodeUnlock, promptCacheRetry = false) {
  if (!PROMPT_CACHE_ENABLED || promptCacheRetry || claudeCodeUnlock) return false;
  return conn?.format === 'anthropic';
}

function cacheControl() {
  return { type: 'ephemeral' };
}

function withAnthropicSystemCache(systemPrompt, enabled) {
  if (!systemPrompt) return undefined;
  if (!enabled) return systemPrompt;
  return [{ type: 'text', text: systemPrompt, cache_control: cacheControl() }];
}

function withAnthropicToolsCache(tools, enabled) {
  if (!enabled || !Array.isArray(tools) || tools.length === 0) return tools;
  return tools.map((tool, idx) => {
    if (idx !== tools.length - 1 || !tool || typeof tool !== 'object') return tool;
    return { ...tool, cache_control: cacheControl() };
  });
}

function withAnthropicPromptCacheHeaders(headers, enabled) {
  if (!enabled) return headers;
  const out = { ...headers };
  const beta = 'prompt-caching-2024-07-31';
  const existing = String(out['anthropic-beta'] || '').trim();
  out['anthropic-beta'] = existing
    ? (existing.split(',').map(x => x.trim()).includes(beta) ? existing : `${existing},${beta}`)
    : beta;
  return out;
}

function isPromptCacheRejected(statusCode, body = '') {
  if (![400, 422].includes(statusCode)) return false;
  return /cache[_ -]?control|prompt[_ -]?cache|prompt caching|anthropic-beta|unknown field|extra_forbidden|unrecognized|unsupported/i.test(String(body || ''));
}

function recordStreamLatency(startedAt) {
  if (startedAt) recordLatency(Date.now() - startedAt);
}

function isGeminiModel(model = '') {
  return /gemini/i.test(String(model));
}

// Gemini(OpenAI 兼容层)对 JSON Schema 支持是子集。
// 这里递归剔除常见不兼容关键字，避免 INVALID_ARGUMENT 400。
function sanitizeJsonSchemaForGemini(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchemaForGemini);

  const allowed = new Set([
    'type', 'properties', 'required', 'items', 'description', 'enum',
    'nullable', 'format', 'minimum', 'maximum', 'minLength', 'maxLength',
    'minItems', 'maxItems', 'additionalProperties', 'default', 'title'
  ]);

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!allowed.has(k)) continue;
    out[k] = sanitizeJsonSchemaForGemini(v);
  }
  return out;
}

function normalizeToolSchema(inputSchema, model, forceGeminiCompat = false) {
  const raw = typeof inputSchema === 'string' ? JSON.parse(inputSchema) : (inputSchema || {});
  return (forceGeminiCompat || isGeminiModel(model)) ? sanitizeJsonSchemaForGemini(raw) : raw;
}

function shouldAutoEnableGeminiSchemaCompat(statusCode, errBody = '') {
  if (statusCode !== 400) return false;
  const s = String(errBody || '');
  return /Invalid JSON payload received/i.test(s)
    && /(exclusiveMinimum|propertyNames|function_declarations)/i.test(s);
}


// 路由层判断:该 GetChatMessage 是否应转发到第三方 provider。

// 命中普通 BYOK 映射或模型槽位管理项才接管;否则原样透传给 Codeium。
export function shouldIntercept(body, headers) {
  const modelId = extractModelId(body, headers);
  const slot = getSlot(modelId);
  if (slot) return true;
  if (getInjectedByUid(modelId)) return true;
  return getRuntimeModelSlotStatus(modelId)?.status === 'unconfigured';
}


// ─── Main handler ──────────────────────────────────────────

export function handleGetChatMessage(req, res, body) {
  let { systemPrompt, messages, tools, toolChoice, requestedModel, initiator } =
    parseGetChatMessageRequest(body, req.headers);

  const messageId = crypto.randomUUID();
  let slot = getSlot(requestedModel);
  const injected = slot ? null : getInjectedByUid(requestedModel);
  const runtimeSlot = slot || injected ? null : getRuntimeModelSlotStatus(requestedModel);

  if (injected && injected.status !== 'configured') {
    const label = injected.label || requestedModel;
    const msg = `模型槽位「${label}」已解锁但尚未配置 BYOK 映射。请在「模型槽位管理」中选择供应商并填写 model 字段。`;
    console.warn(`  ⚠️  ${msg}`);
    recordError({ provider: 'model-slot', message: msg });
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  if (runtimeSlot && runtimeSlot.status === 'unconfigured') {
    const label = runtimeSlot.label || requestedModel;
    const msg = `模型槽位「${label}」已解锁但尚未配置 BYOK 映射。请在「模型槽位管理」中选择供应商并填写 model 字段。`;
    console.warn(`  ⚠️  ${msg}`);
    recordError({ provider: 'model-slot', message: msg });
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  if (injected) {
    slot = {
      modelUid: injected.modelUid,
      displayName: injected.label,
      supportsImages: injected.supportsImages !== false,
      targets: [{
        providerId: injected.providerId,
        model: injected.model,
        apiFormat: injected.apiFormat,
        apiPath: injected.apiPath,
        unlock: injected.unlock,
      }],
      routeKind: 'injected',
    };
  }

  // shouldIntercept 已保证命中槽位才进来；防御性兜底:无槽位/无 targets → 清晰报错。
  if (!slot || !slot.targets || slot.targets.length === 0) {
    const label = slot?.displayName || requestedModel;
    const msg = `模型映射「${label}」已启用但尚未配置目标供应商。请在「模型映射」中编辑该行并添加供应商/model。`;
    console.warn(`  ⚠️  ${msg}`);
    recordError({ provider: 'model-slot', message: msg });
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  const providers = loadProviders();
  const modelMapConfig = loadModelMapConfig();
  const enhancement = modelMapConfig?.enhancement || {};
  const searchModels = modelMapConfig?.searchModels || {};
  const autoRoutingEnabled = enhancement.autoRouting !== false;
  const retryPolicy = retryPolicyFromEnhancement(enhancement);
  const serviceTier = getServiceTier(requestedModel);

  systemPrompt = applySystemPromptEnhancement(systemPrompt, enhancement);
  const toolEnhancement = applyChatToolEnhancement(tools, toolChoice, enhancement);
  if (toolEnhancement.error) {
    console.warn(`  ⚠️  ${toolEnhancement.error}`);
    sendTerminalError(res, messageId, toolEnhancement.error, 'invalid_argument');
    return;
  }
  tools = toolEnhancement.tools;
  toolChoice = toolEnhancement.toolChoice;

  if (enhancement.rateLimitEnabled === true && enhancement.rateLimitRpm > 0) {
    const allowed = checkChatRateLimit(requestedModel, enhancement.rateLimitRpm);
    if (!allowed) {
      const msg = `请求频率超限：${enhancement.rateLimitRpm} RPM`;
      console.warn(`  ⚠️  ${msg}`);
      recordError({ provider: 'rate-limit', message: msg });
      sendTerminalError(res, messageId, msg, 'resource_exhausted');
      return;
    }
  }
  if (enhancement.requestLogging === true) {
    logEnhancedChatRequest({
      phase: 'request',
      model: requestedModel,
      systemChars: systemPrompt.length,
      messageCount: messages.length,
      toolCount: Array.isArray(tools) ? tools.length : 0,
    });
  }

  const routeLabel = slot.routeKind === 'injected' ? 'Managed slot' : 'Slot';
  console.log(`  🧠 ${routeLabel}: ${requestedModel} (${slot.displayName || '原名'}) → ${slot.targets.length} target(s)`);
  console.log(`  📝 System: ${systemPrompt.length} chars  💬 Messages: ${messages.length}${tools ? `  🔧 Tools: ${tools.length}` : ''}`);

  const hasImages = messages.some(messageHasImage);
  const routingTargets = autoRoutingEnabled ? [...slot.targets] : [slot.targets[0]];
  if (!autoRoutingEnabled && slot.targets.length > 1) {
    console.log(`  🧭 模型自动路由已关闭：只使用第 1 个目标，忽略其余 ${slot.targets.length - 1} 个备用目标`);
  }
  if (hasImages) {
    const imgCount = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0), 0);
    const sampleBlock = messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
    const sampleImg = sampleBlock ? sampleBlock.content.find(b => b.type === 'image') : null;
    const dataLen = sampleImg?.source?.data?.length || 0;
    const mediaType = sampleImg?.source?.media_type || 'unknown';
    console.log(`  🖼️  Image request detected: ${imgCount} image(s), data_len=${dataLen}, media_type=${mediaType}`);
  }

  // 自动路由开启时按 targets 顺序逐个尝试；关闭或单目标时失败即暴露错误。
  let idx = 0;
  const errors = [];
  const failures = [];
  function rememberFailure(failure) {
    failures.push(failure);
    errors.push(failureLogLine(failure));
  }
  // 当前活跃的上游请求。客户端断开时只销毁它（避免给每个 target 重复注册 close 监听器泄漏）。
  let currentApiReq = null;
  let retryTimer = null;
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = !res.writableEnded;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (clientClosed && currentApiReq && !currentApiReq.destroyed) {
      console.log(`  🔌 客户端断开，中止上游请求`);
      currentApiReq.destroy();
    }
  });

  function attemptNext() {
    if (clientClosed || res.writableEnded) return;
    if (idx >= routingTargets.length) {
      const label = routingTargets.length > 1 ? `所有 ${routingTargets.length} 个目标均失败` : '目标失败';
      console.error(`  ❌ ${label}: ${errors.join(' | ')}`);
      recordError({ provider: 'failover', message: errors.join(' | ') });
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, providerFailureMessage(failures), connectCodeForFailures(failures));
      }
      return;
    }

    const target = routingTargets[idx];
    const conn = resolveTarget(target, providers);
    idx++;

    if (conn.error) {
      const hasNextTarget = idx < routingTargets.length;
      console.warn(`  ⚠️  目标#${idx} ${target.providerId} 跳过: ${conn.error}${hasNextTarget ? ' → 切换下一个' : ''}`);
      rememberFailure({
        providerId: target.providerId,
        model: target.model,
        reason: conn.error,
      });
      return attemptNext();
    }

    if (hasImages && conn.capabilities?.vision === false) {
      console.warn(`  ⚠️  目标#${idx} ${conn.providerName} 未标记支持 Vision，但仍尝试转发（探测可能误报）`);
    }

    const routeMode = conn.unlockKind
      ? `${conn.format}/${conn.unlockKind}`
      : (conn.routeSource && conn.routeSource !== 'target-apiFormat' ? `${conn.format}/${conn.routeSource}` : conn.format);
    console.log(`  ➡️  目标#${idx}: ${conn.providerName} (${routeMode}) → ${conn.model}${conn.capabilities?.gzip ? ' [gzip]' : ''}`);
    recordRequest({ provider: conn.providerName, requestedModel, resolvedModel: conn.model });

    const sys = systemPrompt;
    const targetStartedAt = Date.now();
    let retryCount = 0;
    // 多模态处理结果缓存（同目标重试时不重复转换）
    let mmProcessedMessages = null;
    let mmConversionCount = 0;

    const startTargetRequest = async () => {
      retryTimer = null;
      if (clientClosed || res.writableEnded) return;

      let effectiveMessages = messages;
      const imageFallbackEnabled = modelMapConfig?.enhancement?.imageFallback !== false;
      const configuredVisionModels = modelMapConfig?.visionModels?.imageModels || [];
      const thirdPartyVisionEnabled = hasImages
        && slot.useThirdPartyVision === true
        && imageFallbackEnabled;
      if (thirdPartyVisionEnabled) {
        if (configuredVisionModels.length === 0) {
          const msg = `槽位「${slot.displayName || requestedModel}」已启用第三方图片理解，但代理增强里没有配置图片理解模型。`;
          console.error(`  ❌ ${msg}`);
          recordError({ provider: 'vision-fallback', message: msg });
          sendTerminalError(res, messageId, msg, 'invalid_argument');
          return;
        }
        const targetMessages = mmProcessedMessages || messages;
        try {
          const result = await preprocessImagesWithThirdPartyVision(
            targetMessages,
            configuredVisionModels,
            providers,
            {
              requestId: messageId,
              requestedModel,
              slotModelUid: slot.modelUid || requestedModel,
              slotDisplayName: slot.displayName || requestedModel,
              visionOptions: {
                maxTokens: modelMapConfig?.enhancement?.visionMaxTokens,
                contextMode: modelMapConfig?.enhancement?.visionContextMode,
                contextMaxChars: modelMapConfig?.enhancement?.visionContextMaxChars,
                multiImageMode: modelMapConfig?.enhancement?.visionMultiImageMode,
                batchSize: modelMapConfig?.enhancement?.visionBatchSize,
              },
            },
          );
          if (result.conversions.length > 0) {
            effectiveMessages = result.messages;
            mmProcessedMessages = result.messages;
            mmConversionCount = result.conversions.length;
            const chain = result.conversions
              .map(c => `${c.providerName}/${c.model}`)
              .join(', ');
            console.log(`  👁️  第三方图片理解: ${mmConversionCount} 张图片 → 文本描述 (${chain})`);
          }
        } catch (e) {
          const msg = `第三方图片理解失败：${e.message}`;
          console.error(`  ❌ ${msg}`);
          recordError({ provider: 'vision-fallback', message: msg });
          sendTerminalError(res, messageId, msg, 'unavailable');
          return;
        }
      }

      const onFailover = (reason, meta = {}) => {
        if (clientClosed || res.writableEnded) return;
        const canRetry = retryPolicy.enabled
          && !res.headersSent
          && retryCount < retryPolicy.maxRetries
          && (retryCount === 0 || (Date.now() - targetStartedAt) < retryPolicy.totalMs)
          && isRetryableFailure(reason, meta);

        if (canRetry) {
          retryCount++;
          const delay = Math.round(retryDelayMs(retryCount, meta, retryPolicy));
          console.warn(`  ⏳ ${conn.providerName} 失败(${reason})，${delay}ms 后重试 ${retryCount}/${retryPolicy.maxRetries}`);
          retryTimer = setTimeout(() => startTargetRequest(), delay);
          return;
        }

        const hasNextTarget = idx < routingTargets.length;
        console.warn(`  ⚠️  ${conn.providerName} 失败(${reason})${hasNextTarget ? ' → 切换下一个' : ''}`);
        rememberFailure({
          providerId: conn.providerId,
          providerName: conn.providerName,
          model: conn.model,
          routeMode,
          apiPath: conn.apiPath,
          reason,
          statusCode: meta.statusCode,
          code: meta.code,
          body: meta.body,
        });
        attemptNext();
      };

      const toolInjection = applyChatToolInjection(tools, conn, enhancement, searchModels);
      if (toolInjection.searchInjection?.mode === 'missing-search-source'
          || toolInjection.searchInjection?.mode === 'unsupported-gemini-native'
          || toolInjection.searchInjection?.mode === 'unsupported-unlock') {
        const reason = toolInjection.searchInjection.reason || '当前目标不支持联网搜索';
        const hasNextTarget = idx < routingTargets.length;
        console.warn(`  ⚠️  ${conn.providerName} 跳过: ${reason}${hasNextTarget ? ' → 切换下一个' : ''}`);
        rememberFailure({
          providerId: conn.providerId,
          providerName: conn.providerName,
          model: conn.model,
          routeMode,
          apiPath: conn.apiPath,
          reason,
        });
        attemptNext();
        return;
      }
      const targetTools = toolInjection.tools;

      const opts = {
        systemPrompt: sys,
        messages: effectiveMessages,
        tools: targetTools,
        toolChoice,
        resolvedModel: conn.model,
        requestedModel,
        serviceTier,
        messageId,
        conn,
        enhancement,
        onFailover,
        schemaCompatRetry: false,
        bindActiveReq: (r) => { currentApiReq = r; },
        searchModels,
        searchInjection: toolInjection.searchInjection,
      };

      if (toolInjection.searchInjection?.mode === 'generic') {
        await streamSearchAgentLoop(req, res, opts);
      } else {
        currentApiReq = conn.format === 'openai'
          ? streamOpenAI(req, res, opts)
          : streamAnthropic(req, res, opts);
      }
    };

    startTargetRequest().catch(err => {
      console.error(`  ❌ startTargetRequest 异常: ${err.message}`);
      if (res.headersSent) return;
      rememberFailure({
        providerId: conn.providerId,
        providerName: conn.providerName,
        model: conn.model,
        routeMode,
        apiPath: conn.apiPath,
        reason: `startTargetRequest 异常: ${err.message}`,
      });
      attemptNext();
    });
  }

  attemptNext();
}

// ─── Anthropic streaming ────────────────────────────────────

function anthropicAuthHeaders(conn) {
  const headers = {
    'anthropic-version': '2023-06-01',
  };
  if (conn.authScheme === 'bearer') {
    headers.authorization = `Bearer ${conn.apiKey}`;
  } else {
    headers['x-api-key'] = conn.apiKey;
  }
  return headers;
}

function flushBufferedStreamResult(res, result, { enhancement, conn, resolvedModel, messages, tools }) {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(200, { ...streamHeaders(), ...enhancementResponseHeaders(enhancement) });
  }
  for (const chunk of result.protoChunks || []) {
    res.write(wrapEnvelope(chunk));
  }
  res.write(endOfStreamEnvelope());
  res.end();
  recordStreamLatency(result.streamStartedAt);
  markModelSuccess(conn, resolvedModel, messages, tools);
  recordUsage(result.processor?.usage || {});
  logEnhancedChatResponse(enhancement, conn, resolvedModel, result.processor);
  mitmLog({
    direction: 'downstream',
    providerName: conn.providerName,
    model: resolvedModel,
    format: result.format,
    request: { method: 'POST', url: result.requestUrl },
    response: {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `[USAGE] ${JSON.stringify(result.processor?.usage || {})}\n\n${(result.rawOutput || []).join('\n\n')}`,
    },
  });
}

async function streamSearchAgentLoop(req, res, opts) {
  const {
    conn,
    enhancement = {},
    messageId,
    searchInjection = {},
    searchModels = {},
    onFailover,
    resolvedModel,
    tools,
  } = opts;
  const toolName = searchInjection.toolName || 'web_search';
  const sources = enabledSearchSources(searchModels);
  if (sources.length === 0) {
    sendTerminalError(res, messageId, '联网搜索已开启，但没有启用的搜索源。请先在代理增强中添加搜索源。', 'invalid_argument');
    return;
  }

  let loopMessages = opts.messages;
  let searchRounds = 0;
  const maxRounds = positiveInt(enhancement.webSearchMaxRounds, 3, 1);
  const maxResults = positiveInt(enhancement.webSearchMaxResults, 5, 1);

  while (!res.writableEnded) {
    const result = conn.format === 'openai'
      ? await requestOpenAIBuffered(req, res, { ...opts, messages: loopMessages })
      : await requestAnthropicBuffered(req, res, { ...opts, messages: loopMessages });

    if (!result) return;
    if (result.kind === 'failover') {
      onFailover(result.reason, result.meta || {});
      return;
    }
    if (result.kind === 'terminal-error') {
      sendTerminalError(res, messageId, result.message, result.code || 'unavailable');
      return;
    }
    if (result.kind !== 'success') {
      sendTerminalError(res, messageId, `联网搜索 agent loop 收到未知上游结果: ${result.kind || 'unknown'}`, 'unavailable');
      return;
    }

    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    const webSearchCalls = toolCalls.filter(call => call.name === toolName);
    const otherToolCalls = toolCalls.filter(call => call.name !== toolName);

    if (webSearchCalls.length === 0) {
      flushBufferedStreamResult(res, result, { enhancement, conn, resolvedModel, messages: loopMessages, tools });
      return;
    }

    if (otherToolCalls.length > 0) {
      const names = otherToolCalls.map(call => call.name || call.id || '(unknown)').join(', ');
      sendTerminalError(res, messageId, `模型同时请求联网搜索和客户端工具（${names}），AnyBridge 无法同时接管并透传，已中止以避免未处理的 web_search 泄漏。`, 'invalid_argument');
      return;
    }

    searchRounds += 1;
    if (searchRounds > maxRounds) {
      sendTerminalError(res, messageId, `联网搜索 agent loop 超过最大轮次 ${maxRounds}。模型仍在请求 web_search，已中止。`, 'resource_exhausted');
      return;
    }

    const toolResults = [];
    for (const call of webSearchCalls) {
      const query = searchQueryFromToolCall(call);
      if (!query) {
        toolResults.push({
          id: call.id,
          content: buildToolErrorContent(new Error('web_search 缺少 query 参数')),
        });
        continue;
      }
      try {
        console.log(`  🔎 web_search(${searchRounds}/${maxRounds}): ${clampText(query, 120)}`);
        const search = await executeSearchWithFailover(sources, query, maxResults);
        toolResults.push({
          id: call.id,
          content: buildToolResultContent(search.results),
        });
      } catch (e) {
        toolResults.push({
          id: call.id,
          content: buildToolErrorContent(e),
        });
      }
    }

    loopMessages = appendToolExchange(loopMessages, webSearchCalls, toolResults);
  }
}

function requestAnthropicBuffered(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId, conn, enhancement = {}, promptCacheRetry = false, bindActiveReq = null }) {
  return new Promise((resolve) => {
    const claudeCodeUnlock = claudeCodeUnlockForTarget(conn);
    if (claudeCodeUnlock) {
      resolve({
        kind: 'terminal-error',
        code: 'invalid_argument',
        message: 'Claude Code 解锁路径当前不支持 AnyBridge 通用联网搜索 agent loop。',
      });
      return;
    }

    const targetPath = conn.apiPath;
    const usePromptCache = shouldUseAnthropicPromptCache(conn, false, promptCacheRetry);
    const authHeaders = withAnthropicPromptCacheHeaders(anthropicAuthHeaders(conn), usePromptCache);
    const extraHeaders = enhancementRequestHeaders(enhancement);
    const sentTools = withAnthropicToolsCache(tools, usePromptCache);
    const apiPayload = {
      model: resolvedModel,
      system: withAnthropicSystemCache(systemPrompt, usePromptCache),
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
    };
    if (sentTools && sentTools.length > 0) {
      apiPayload.tools = sentTools;
      if (toolChoice) apiPayload.tool_choice = toolChoice;
    }
    applyPayloadParamOverrides(apiPayload, enhancement, 'max_tokens');

    const apiBody = JSON.stringify(apiPayload);
    const requestUrl = upstreamUrl(conn, targetPath);
    mitmLog({
      direction: 'upstream',
      providerName: conn.providerName,
      model: resolvedModel,
      format: 'anthropic',
      request: {
        method: 'POST',
        url: requestUrl,
        headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...authHeaders, ...extraHeaders },
        body: apiBody,
      },
    });

    const reqHeaders = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...authHeaders,
      ...extraHeaders,
      'content-length': Buffer.byteLength(apiBody),
    };
    const requestConfig = upstreamRequestOptions(conn, targetPath, reqHeaders);
    let failed = false;
    let streamStarted = false;
    const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
      let sseBuffer = '';

      if (apiRes.statusCode !== 200) {
        let errBody = '';
        apiRes.setEncoding('utf8');
        apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
        const fail = () => {
          if (failed) return;
          failed = true;
          mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'anthropic', request: { method: 'POST', url: requestUrl }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
          if (usePromptCache && !promptCacheRetry && isPromptCacheRejected(apiRes.statusCode, errBody)) {
            console.warn(`  ♻️  ${conn.providerName} / ${resolvedModel} 不接受 cache_control，本次移除后重试一次`);
            apiReq.destroy();
            requestAnthropicBuffered(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              messageId,
              conn,
              enhancement,
              promptCacheRetry: true,
              bindActiveReq,
            }).then(resolve);
            return;
          }
          apiReq.destroy();
          resolve({ kind: 'failover', reason: `HTTP ${apiRes.statusCode}`, meta: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
        };
        apiRes.on('end', fail);
        setTimeout(fail, 5000);
        return;
      }

      streamStarted = true;
      const processor = new AnthropicStreamProcessor(messageId, resolvedModel);
      const streamStartedAt = Date.now();
      const rawOutput = [];
      const protoChunks = [];
      apiRes.setEncoding('utf8');

      function processPart(part) {
        rawOutput.push(part);
        const events = parseSSEChunk(part + '\n\n');
        for (const evt of events) {
          protoChunks.push(...processor.processEvent(evt));
        }
      }

      apiRes.on('data', (chunk) => {
        sseBuffer += chunk;
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop();
        for (const part of parts) processPart(part);
      });

      apiRes.on('end', () => {
        if (failed) return;
        failed = true;
        if (sseBuffer.trim()) processPart(sseBuffer);
        resolve({
          kind: 'success',
          format: 'anthropic',
          requestUrl,
          streamStartedAt,
          rawOutput,
          protoChunks,
          processor,
          toolCalls: processor.toolCalls,
        });
      });

      apiRes.on('error', (err) => {
        if (failed) return;
        failed = true;
        resolve({
          kind: streamStarted ? 'terminal-error' : 'failover',
          reason: err.message,
          meta: { code: err.code },
          code: 'unavailable',
          message: `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`,
        });
      });
    });

    if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);
    apiReq.on('error', (err) => {
      if (failed) return;
      failed = true;
      resolve({
        kind: streamStarted ? 'terminal-error' : 'failover',
        reason: err.message,
        meta: { code: err.code },
        code: 'unavailable',
        message: `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`,
      });
    });
    apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      const err = new Error('upstream timeout');
      err.code = 'ETIMEDOUT';
      apiReq.destroy(err);
    });
    apiReq.end(apiBody);
  });
}

function requestOpenAIBuffered(req, res, opts) {
  if (isOpenAIChatCompletionsPath(opts.conn.apiPath)) {
    return requestOpenAIChatCompletionsBuffered(req, res, opts);
  }
  return requestOpenAIResponsesBuffered(req, res, opts);
}

function requestOpenAIResponsesBuffered(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, requestedModel, serviceTier, messageId, conn, enhancement = {}, schemaCompatRetry = false, bindActiveReq = null }) {
  return new Promise((resolve) => {
    const codexUnlock = codexUnlockForTarget(conn);
    if (codexUnlock) {
      resolve({
        kind: 'terminal-error',
        code: 'invalid_argument',
        message: 'Codex 解锁路径当前不支持 AnyBridge 通用联网搜索 agent loop。',
      });
      return;
    }

    const openaiMessages = toOpenAIMessages(systemPrompt, messages);
    const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';
    const apiPayload = {
      model: resolvedModel,
      input: openaiMessages,
      stream: true,
      max_output_tokens: MAX_TOKENS,
    };
    if (OPENAI_REASONING_EFFORT && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_EFFORT)) {
      apiPayload.reasoning = { effort: OPENAI_REASONING_EFFORT };
      if (OPENAI_REASONING_SUMMARY && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_SUMMARY)) {
        apiPayload.reasoning.summary = OPENAI_REASONING_SUMMARY;
      }
    }
    if (serviceTier) apiPayload.service_tier = serviceTier;
    if (tools && tools.length > 0) {
      const serializedTools = serializeOpenAITools(tools, { chatCompletions: false, resolvedModel, forceGeminiCompat });
      if (serializedTools.length > 0) apiPayload.tools = serializedTools;
      if (toolChoice) {
        if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
        else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
        else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', name: toolChoice.name };
      }
    }
    applyPayloadParamOverrides(apiPayload, enhancement, 'max_output_tokens');

    const apiBody = JSON.stringify(apiPayload);
    const authHeaders = { authorization: `Bearer ${conn.apiKey}` };
    const extraHeaders = enhancementRequestHeaders(enhancement);
    const requestUrl = upstreamUrl(conn, conn.apiPath);
    mitmLog({
      direction: 'upstream',
      providerName: conn.providerName,
      model: resolvedModel,
      format: 'openai-responses',
      request: { method: 'POST', url: requestUrl, headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...authHeaders, ...extraHeaders }, body: apiBody },
    });

    const useGzip = conn.capabilities?.gzip === true;
    const finalBody = useGzip ? gzipSync(Buffer.from(apiBody)) : Buffer.from(apiBody);
    const reqHeaders = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...authHeaders,
      ...extraHeaders,
      'content-length': finalBody.length,
    };
    if (useGzip) reqHeaders['content-encoding'] = 'gzip';

    const requestConfig = upstreamRequestOptions(conn, conn.apiPath, reqHeaders);
    let failed = false;
    let streamStarted = false;
    const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
      let sseBuffer = '';
      if (apiRes.statusCode !== 200) {
        let errBody = '';
        apiRes.setEncoding('utf8');
        apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
        const fail = () => {
          if (failed) return;
          failed = true;
          mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: requestUrl }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
          if (!schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(apiRes.statusCode, errBody) && tools && tools.length > 0) {
            const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
            if (remembered) console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
            console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
            apiReq.destroy();
            requestOpenAIResponsesBuffered(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              requestedModel,
              serviceTier,
              messageId,
              conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
              enhancement,
              schemaCompatRetry: true,
              bindActiveReq,
            }).then(resolve);
            return;
          }
          apiReq.destroy();
          resolve({ kind: 'failover', reason: `HTTP ${apiRes.statusCode}`, meta: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
        };
        apiRes.on('end', fail);
        setTimeout(fail, 5000);
        return;
      }

      streamStarted = true;
      const responseProcessor = new OpenAIStreamProcessor(messageId, resolvedModel);
      const chatFallbackProcessor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
      let processorMode = 'responses';
      const activeProcessor = () => processorMode === 'chat' ? chatFallbackProcessor : responseProcessor;
      const streamStartedAt = Date.now();
      const rawOutput = [];
      const protoChunks = [];
      apiRes.setEncoding('utf8');

      function processPart(part) {
        rawOutput.push(part);
        const events = parseOpenAISSEChunk(part + '\n');
        for (const evt of events) {
          if (processorMode === 'responses' && evt?.data?.choices) {
            processorMode = 'chat';
            console.warn(`  ⚠️  OpenAI endpoint returned chat.completion chunks; switching stream parser`);
          }
          protoChunks.push(...activeProcessor().processEvent(evt));
        }
      }

      apiRes.on('data', (chunk) => {
        sseBuffer += chunk;
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop();
        for (const part of parts) processPart(part);
      });

      apiRes.on('end', () => {
        if (failed) return;
        failed = true;
        if (sseBuffer.trim()) processPart(sseBuffer);
        const processor = activeProcessor();
        if (!processor.isDone) {
          protoChunks.push(...processor.processEvent({ done: true, type: 'done', data: null }));
        }
        resolve({
          kind: 'success',
          format: processorMode === 'chat' ? 'openai-chat' : 'openai-responses',
          requestUrl,
          streamStartedAt,
          rawOutput,
          protoChunks,
          processor,
          toolCalls: processor.toolCalls,
        });
      });

      apiRes.on('error', (err) => {
        if (failed) return;
        failed = true;
        resolve({
          kind: streamStarted ? 'terminal-error' : 'failover',
          reason: err.message,
          meta: { code: err.code },
          code: 'unavailable',
          message: `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`,
        });
      });
    });

    if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);
    apiReq.on('error', (err) => {
      if (failed) return;
      failed = true;
      resolve({
        kind: streamStarted ? 'terminal-error' : 'failover',
        reason: err.message,
        meta: { code: err.code },
        code: 'unavailable',
        message: `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`,
      });
    });
    apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      const err = new Error('upstream timeout');
      err.code = 'ETIMEDOUT';
      apiReq.destroy(err);
    });
    apiReq.end(finalBody);
  });
}

function requestOpenAIChatCompletionsBuffered(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId, conn, enhancement = {}, schemaCompatRetry = false, bindActiveReq = null }) {
  return new Promise((resolve) => {
    const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';
    const apiPayload = {
      model: resolvedModel,
      messages: toOpenAIChatMessages(systemPrompt, messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: MAX_TOKENS,
    };
    if (serviceTier) apiPayload.service_tier = serviceTier;
    if (tools && tools.length > 0) {
      const serializedTools = serializeOpenAITools(tools, { chatCompletions: true, resolvedModel, forceGeminiCompat });
      if (serializedTools.length > 0) apiPayload.tools = serializedTools;
      if (toolChoice) {
        if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
        else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
        else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', function: { name: toolChoice.name } };
      }
    }
    applyPayloadParamOverrides(apiPayload, enhancement, 'max_tokens');

    const apiBody = JSON.stringify(apiPayload);
    const extraHeaders = enhancementRequestHeaders(enhancement);
    const requestUrl = upstreamUrl(conn, conn.apiPath);
    mitmLog({
      direction: 'upstream',
      providerName: conn.providerName,
      model: resolvedModel,
      format: 'openai-chat',
      request: { method: 'POST', url: requestUrl, headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}`, ...extraHeaders }, body: apiBody },
    });

    const reqHeaders = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      authorization: `Bearer ${conn.apiKey}`,
      ...extraHeaders,
      'content-length': Buffer.byteLength(apiBody),
    };
    const requestConfig = upstreamRequestOptions(conn, conn.apiPath, reqHeaders);
    let failed = false;
    let streamStarted = false;
    const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
      let sseBuffer = '';
      if (apiRes.statusCode !== 200) {
        let errBody = '';
        apiRes.setEncoding('utf8');
        apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
        const fail = () => {
          if (failed) return;
          failed = true;
          mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: requestUrl }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
          if (!schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(apiRes.statusCode, errBody) && tools && tools.length > 0) {
            const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
            if (remembered) console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
            console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
            apiReq.destroy();
            requestOpenAIChatCompletionsBuffered(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              serviceTier,
              messageId,
              conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
              enhancement,
              schemaCompatRetry: true,
              bindActiveReq,
            }).then(resolve);
            return;
          }
          apiReq.destroy();
          resolve({ kind: 'failover', reason: `HTTP ${apiRes.statusCode}`, meta: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });
        };
        apiRes.on('end', fail);
        setTimeout(fail, 5000);
        return;
      }

      streamStarted = true;
      const processor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
      const streamStartedAt = Date.now();
      const rawOutput = [];
      const protoChunks = [];
      apiRes.setEncoding('utf8');

      function processPart(part) {
        rawOutput.push(part);
        const events = parseOpenAISSEChunk(part + '\n');
        for (const evt of events) {
          protoChunks.push(...processor.processEvent(evt));
        }
      }

      apiRes.on('data', (chunk) => {
        sseBuffer += chunk;
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop();
        for (const part of parts) processPart(part);
      });

      apiRes.on('end', () => {
        if (failed) return;
        failed = true;
        if (sseBuffer.trim()) processPart(sseBuffer);
        if (!processor.isDone) {
          protoChunks.push(...processor.processEvent({ done: true, type: 'done', data: null }));
        }
        resolve({
          kind: 'success',
          format: 'openai-chat',
          requestUrl,
          streamStartedAt,
          rawOutput,
          protoChunks,
          processor,
          toolCalls: processor.toolCalls,
        });
      });

      apiRes.on('error', (err) => {
        if (failed) return;
        failed = true;
        resolve({
          kind: streamStarted ? 'terminal-error' : 'failover',
          reason: err.message,
          meta: { code: err.code },
          code: 'unavailable',
          message: `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`,
        });
      });
    });

    if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);
    apiReq.on('error', (err) => {
      if (failed) return;
      failed = true;
      resolve({
        kind: streamStarted ? 'terminal-error' : 'failover',
        reason: err.message,
        meta: { code: err.code },
        code: 'unavailable',
        message: `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`,
      });
    });
    apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      const err = new Error('upstream timeout');
      err.code = 'ETIMEDOUT';
      apiReq.destroy(err);
    });
    apiReq.end(apiBody);
  });
}

function streamAnthropic(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId, conn, enhancement = {}, onFailover, promptCacheRetry = false, bindActiveReq = null }) {
  const claudeCodeUnlock = claudeCodeUnlockForTarget(conn);
  const targetPath = claudeCodeUnlock?.wireApi || conn.apiPath;
  const usePromptCache = shouldUseAnthropicPromptCache(conn, claudeCodeUnlock, promptCacheRetry);
  const authHeaders = withAnthropicPromptCacheHeaders(
    claudeCodeUnlock ? claudeCodeUnlockHeaders(conn) : anthropicAuthHeaders(conn),
    usePromptCache
  );
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const sentTools = claudeCodeUnlock ? undefined : withAnthropicToolsCache(tools, usePromptCache);
  const apiPayload = claudeCodeUnlock
    ? buildClaudeCodeUnlockPayload({ model: resolvedModel, messages, maxTokens: MAX_TOKENS })
    : {
        model: resolvedModel,
        system: withAnthropicSystemCache(systemPrompt, usePromptCache),
        messages,
        stream: true,
        max_tokens: MAX_TOKENS,
      };
  if (!claudeCodeUnlock && sentTools && sentTools.length > 0) {
    apiPayload.tools = sentTools;
    if (toolChoice) apiPayload.tool_choice = toolChoice;
  }
  applyPayloadParamOverrides(apiPayload, enhancement, 'max_tokens');
  const apiBody = JSON.stringify(apiPayload);
  const processor = new AnthropicStreamProcessor(messageId, resolvedModel);
  let failed = false; // 防止 error+statusCode 双触发 onFailover
  if (usePromptCache) {
    console.log(`  🧊 Anthropic prompt cache enabled: system${sentTools?.length ? ' + tools' : ''}`);
  }

  // ── MITM 日志：记录上游请求 ──
  const mitmReqId = crypto.randomUUID();
  const requestUrl = upstreamUrl(conn, targetPath);
  mitmLog({
    direction: 'upstream',
    providerName: conn.providerName,
    model: resolvedModel,
    format: 'anthropic',
    request: {
      method: 'POST',
      url: requestUrl,
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...authHeaders, ...extraHeaders },
      body: apiBody,
    },
  });

  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...authHeaders,
    ...extraHeaders,
    'content-length': Buffer.byteLength(apiBody),
  };
  const requestConfig = upstreamRequestOptions(conn, targetPath, reqHeaders);
  const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
      const fail = () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 300)}`);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'anthropic', request: { method: 'POST', url: requestUrl }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });

        if (usePromptCache && !promptCacheRetry && isPromptCacheRejected(apiRes.statusCode, errBody) && !res.headersSent) {
          console.warn(`  ♻️  ${conn.providerName} / ${resolvedModel} 不接受 cache_control，本次移除后重试一次`);
          apiReq.destroy();
          if (!failed) {
            failed = true;
            return streamAnthropic(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              messageId,
              conn,
              enhancement,
              onFailover,
              promptCacheRetry: true,
              bindActiveReq,
            });
          }
          return;
        }

        apiReq.destroy();
        if (!failed) { failed = true; onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody }); }
      };
      apiRes.on('end', fail);
      // 上游只发头不发 body 时 'end' 可能不来，加超时兜底避免请求挂死。
      setTimeout(() => { if (!failed) fail(); }, 5000);
      return;
    }

    // 收到 200 → 确定用这个供应商，此刻才向客户端发流头（之前都还能切换）。
    const streamStartedAt = Date.now();
    res.writeHead(200, { ...streamHeaders(), ...enhancementResponseHeaders(enhancement) });
    apiRes.setEncoding('utf8');
    const rawOutput = [];

    function processPart(part) {
      rawOutput.push(part);
      const events = parseSSEChunk(part + '\n\n');
      for (const evt of events) {
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
        if (processor.isDone && !res.writableEnded) {
          res.write(endOfStreamEnvelope());
          res.end();
          recordStreamLatency(streamStartedAt);
          markModelSuccess(conn, resolvedModel, messages, sentTools);
          recordUsage(processor.usage);
          logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
          mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'anthropic', request: { method: 'POST', url: requestUrl }, response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}` } });
          console.log(`  ✅ Stream done (stop: ${processor.stopReason})`);
        }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, sentTools);
        recordUsage(processor.usage);
        logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'anthropic', request: { method: 'POST', url: requestUrl }, response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}` } });
        console.log(`  ✅ Stream ended`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ Anthropic stream error: ${err.message}`);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);

  apiReq.on('error', (err) => {
    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    // 连接阶段失败（headersSent=false）→ 还能切换下一个供应商。
    if (!failed && !res.headersSent) { failed = true; onFailover(err.message, { code: err.code }); return; }
    if (!res.writableEnded) {
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  // 上游挂起防护：120s 无响应则断开（触发上面的 error handler 回写错误流或故障转移）。
  apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    const err = new Error('upstream timeout');
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  });

  apiReq.end(apiBody);
  return apiReq;
}

// ─── OpenAI Responses API streaming ─────────────────────────

function streamOpenAI(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, requestedModel, serviceTier, messageId, conn, enhancement = {}, onFailover, schemaCompatRetry = false, bindActiveReq = null }) {
  const codexUnlock = codexUnlockForTarget(conn);
  if (!codexUnlock && conn.apiPath.includes('/chat/completions')) {
    return streamOpenAIChatCompletions(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId, conn, enhancement, onFailover, schemaCompatRetry, bindActiveReq });
  }

  // Convert Anthropic-format messages to OpenAI format
  const openaiMessages = toOpenAIMessages(systemPrompt, messages);

  const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';

  // Responses API payload — uses `input` instead of `messages`
  const apiPayload = {
    model: resolvedModel,
    input: openaiMessages,
    stream: true,
  };

  if (!codexUnlock) {
    apiPayload.max_output_tokens = MAX_TOKENS;
  }

  if (!codexUnlock && OPENAI_REASONING_EFFORT && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_EFFORT)) {
    apiPayload.reasoning = { effort: OPENAI_REASONING_EFFORT };
    if (OPENAI_REASONING_SUMMARY && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_SUMMARY)) {
      apiPayload.reasoning.summary = OPENAI_REASONING_SUMMARY;
    }
  }

  if (serviceTier) apiPayload.service_tier = serviceTier;
  if (tools && tools.length > 0) {
    const serializedTools = serializeOpenAITools(tools, {
      chatCompletions: false,
      resolvedModel,
      forceGeminiCompat,
    });
    if (serializedTools.length > 0) apiPayload.tools = serializedTools;

    if (toolChoice) {
      if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
      else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
      else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', name: toolChoice.name };
    }
  }
  if (codexUnlock) {
    applyCodexUnlockRequiredFields(apiPayload, codexUnlock);
  }
  applyPayloadParamOverrides(apiPayload, enhancement, 'max_output_tokens');

  const targetPath = codexUnlock?.wireApi || conn.apiPath;
  const apiBody = JSON.stringify(apiPayload);
  const authHeaders = codexUnlock ? codexUnlockHeaders(conn) : { authorization: `Bearer ${conn.apiKey}` };
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const requestUrl = upstreamUrl(conn, targetPath);
  // MITM 日志：记录上游请求
  mitmLog({ direction: 'upstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: requestUrl, headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...authHeaders, ...extraHeaders }, body: apiBody } });
  // gzip 可选：供应商标记了 capabilities.gzip=true 才压缩。
  // 用于绕过中转站 Cloudflare WAF 对明文 body 的命令注入检测；
  // One-Hub 等不支持 gzip 的端点保持明文。
  const useGzip = conn.capabilities?.gzip === true;
  const finalBody = useGzip ? gzipSync(Buffer.from(apiBody)) : Buffer.from(apiBody);
  const responseProcessor = new OpenAIStreamProcessor(messageId, resolvedModel);
  const chatFallbackProcessor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
  let processorMode = 'responses';
  const activeProcessor = () => processorMode === 'chat' ? chatFallbackProcessor : responseProcessor;
  let failed = false;

  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...authHeaders,
    ...extraHeaders,
    'content-length': finalBody.length,
  };
  if (useGzip) reqHeaders['content-encoding'] = 'gzip';

  const requestConfig = upstreamRequestOptions(conn, targetPath, reqHeaders);
  const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
      const fail = () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 300)}`);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: requestUrl }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });

        if (!schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(apiRes.statusCode, errBody) && tools && tools.length > 0 && !res.headersSent) {
          const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
          if (remembered) {
            console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
          }
          console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
          apiReq.destroy();
          if (!failed) {
            failed = true;
            return streamOpenAI(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              requestedModel,
              serviceTier,
              messageId,
              conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
              enhancement,
              onFailover,
              schemaCompatRetry: true,
              bindActiveReq,
            });
          }
          return;
        }

        apiReq.destroy();
        if (!failed) { failed = true; onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody }); }
      };

    apiRes.on('end', fail);
    // 上游只发头不发 body 时 'end' 可能不来，加超时兜底避免请求挂死。
      setTimeout(() => { if (!failed) fail(); }, 5000);
      return;
    }

    const streamStartedAt = Date.now();
    res.writeHead(200, { ...streamHeaders(), ...enhancementResponseHeaders(enhancement) });
    apiRes.setEncoding('utf8');
    const rawOutput = [];

    function processPart(part) {
      rawOutput.push(part);
      const events = parseOpenAISSEChunk(part + '\n');
      for (const evt of events) {
        if (processorMode === 'responses' && evt?.data?.choices) {
          processorMode = 'chat';
          console.warn(`  ⚠️  OpenAI endpoint returned chat.completion chunks; switching stream parser`);
        }
        const processor = activeProcessor();
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      const processor = activeProcessor();
      if (processor.isDone && !res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: requestUrl }, response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}` } });
        console.log(`  ✅ OpenAI stream done (stop: ${processor.stopReason})`);
      }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      const processor = activeProcessor();
      // Force stop chunk if stream ended without response.completed
      if (!processor.isDone && !res.writableEnded) {
        const expectedDone = processorMode === 'chat' ? '[DONE]' : 'response.completed';
        console.log(`  ⚠️  OpenAI stream ended without ${expectedDone} — forcing stop`);
        const finalChunks = processor.processEvent({ done: true, type: 'done', data: null });
        for (const chunk of finalChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-responses', request: { method: 'POST', url: requestUrl }, response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}` } });
        console.log(`  ✅ OpenAI stream ended (stop: ${processor.stopReason})`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ OpenAI stream error: ${err.message}`);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);

  apiReq.on('error', (err) => {

    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    if (!failed && !res.headersSent) { failed = true; onFailover(err.message, { code: err.code }); return; }
    if (!res.writableEnded) {
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  // 上游挂起防护：120s 无响应则断开（触发上面的 error handler 回写错误流或故障转移）。
  apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    const err = new Error('upstream timeout');
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  });

  apiReq.end(finalBody);
  return apiReq;
}

// ─── OpenAI Chat Completions API streaming ──────────────────

function streamOpenAIChatCompletions(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId, conn, enhancement = {}, onFailover, schemaCompatRetry = false, bindActiveReq = null }) {
  const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';

  const apiPayload = {
    model: resolvedModel,
    messages: toOpenAIChatMessages(systemPrompt, messages),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
  };

  if (serviceTier) apiPayload.service_tier = serviceTier;
  if (tools && tools.length > 0) {
    const serializedTools = serializeOpenAITools(tools, {
      chatCompletions: true,
      resolvedModel,
      forceGeminiCompat,
    });
    if (serializedTools.length > 0) apiPayload.tools = serializedTools;

    if (toolChoice) {
      if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
      else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
      else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', function: { name: toolChoice.name } };
    }
  }
  applyPayloadParamOverrides(apiPayload, enhancement, 'max_tokens');
  const apiBody = JSON.stringify(apiPayload);
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const requestUrl = upstreamUrl(conn, conn.apiPath);
  // MITM 日志：记录上游请求
  mitmLog({ direction: 'upstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: requestUrl, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${conn.apiKey}`, ...extraHeaders }, body: apiBody } });
  const processor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
  let failed = false;

  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'authorization': `Bearer ${conn.apiKey}`,
    ...extraHeaders,
    'content-length': Buffer.byteLength(apiBody),
  };
  const requestConfig = upstreamRequestOptions(conn, conn.apiPath, reqHeaders);
  const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => { if (errBody.length < 2000) errBody += d.slice(0, 2000 - errBody.length); });
      const fail = () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 300)}`);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: requestUrl }, response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody } });

        if (!schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(apiRes.statusCode, errBody) && tools && tools.length > 0 && !res.headersSent) {
          const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
          if (remembered) {
            console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
          }
          console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
          apiReq.destroy();
          if (!failed) {
            failed = true;
            return streamOpenAIChatCompletions(req, res, {
              systemPrompt,
              messages,
              tools,
              toolChoice,
              resolvedModel,
              serviceTier,
              messageId,
              conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
              enhancement,
              onFailover,
              schemaCompatRetry: true,
              bindActiveReq,
            });
          }
          return;
        }

        apiReq.destroy();
        if (!failed) { failed = true; onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: errBody }); }
      };

      apiRes.on('end', fail);
      setTimeout(() => { if (!failed) fail(); }, 5000);
      return;
    }

    const streamStartedAt = Date.now();
    res.writeHead(200, { ...streamHeaders(), ...enhancementResponseHeaders(enhancement) });
    apiRes.setEncoding('utf8');
    const rawOutput = [];

    function processPart(part) {
      rawOutput.push(part);
      const events = parseOpenAISSEChunk(part + '\n');
      for (const evt of events) {
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (processor.isDone && !res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: requestUrl }, response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}` } });
        console.log(`  ✅ OpenAI chat stream done (stop: ${processor.stopReason})`);
      }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      if (!processor.isDone && !res.writableEnded) {
        const finalChunks = processor.processEvent({ done: true, type: 'done', data: null });
        for (const chunk of finalChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        recordStreamLatency(streamStartedAt);
        markModelSuccess(conn, resolvedModel, messages, tools);
        recordUsage(processor.usage);
        logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
        mitmLog({ direction: 'downstream', providerName: conn.providerName, model: resolvedModel, format: 'openai-chat', request: { method: 'POST', url: requestUrl }, response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}` } });
        console.log(`  ✅ OpenAI chat stream ended (stop: ${processor.stopReason})`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ OpenAI chat stream error: ${err.message}`);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);

  apiReq.on('error', (err) => {

    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    if (!failed && !res.headersSent) { failed = true; onFailover(err.message, { code: err.code }); return; }
    if (!res.writableEnded) {
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    const err = new Error('upstream timeout');
    err.code = 'ETIMEDOUT';
    apiReq.destroy(err);
  });

  apiReq.end(apiBody);
  return apiReq;
}

// ─── Anthropic → OpenAI Responses API input converter ───────
//
// Responses API uses a flat array of typed items instead of messages:
//   { role: "user"|"assistant"|"system"|"developer", content: "..." }
//   { type: "function_call", call_id, name, arguments }
//   { type: "function_call_output", call_id, output }

function toOpenAIMessages(systemPrompt, anthropicMessages) {
  const result = [];

  // System prompt → developer message (Responses API prefers "developer" over "system")
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
      // Text content → assistant message
      let textContent = '';
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
      if (textContent) {
        result.push({ role: 'assistant', content: textContent });
      }

      // Tool calls → function_call items (Responses API format)
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
          // Tool results → function_call_output items (Responses API format)
          result.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
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

function toOpenAIChatMessages(systemPrompt, anthropicMessages) {
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
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
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
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
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
