// handlers/chat/utils.js — GetChatMessage 共享配置、故障文案、请求增强与协议辅助

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../../lib/config-dir.js';
import { cleanupExpiredLogs } from '../../lib/log-cleanup.js';
import { buildErrorChunk } from '../build-response.js';
import { wrapEnvelope, endOfStreamEnvelope, endOfStreamErrorEnvelope, streamHeaders, unwrapRequest } from '../../connect.js';
import { updateModelCapabilities } from '../../provider-pool.js';
import { checkWindowRateLimit } from '../../lib/http-retry.js';
import {
  buildAttemptRetryPolicy,
  computeAttemptRetryDelay,
  isRetryableAttemptFailure,
} from '../../lib/attempt-runner.js';
import { sanitizeGeminiSchema } from '../../lib/gemini-schema.js';
import { SHARED_HTTP_AGENT, SHARED_HTTPS_AGENT, httpsAgentFor } from '../../system-proxy.js';
import { enabledSearchSources } from '../search-sources.js';
import { applyThinkingToPayload, serviceTierFromUid } from '../../lib/thinking-effort.js';

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

export const MAX_TOKENS = intEnv('MAX_TOKENS', 16384, 1);
export const RETRY_MAX = intEnv('BYOK_RETRY_MAX', 5, 0);
export const RETRY_BASE_MS = intEnv('BYOK_RETRY_BASE_MS', 600, 1);
export const RETRY_CAP_MS = intEnv('BYOK_RETRY_CAP_MS', 8000, 1);
export const RETRY_TOTAL_MS = intEnv('BYOK_RETRY_TOTAL_MS', 60000, 0);
export const NATIVE_STREAM_ERRORS = !/^(false|0|off)$/i.test(String(process.env.BYOK_NATIVE_ERRORS || 'true'));
export const OPENAI_REASONING_EFFORT = String(process.env.BYOK_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || '').trim();
export const OPENAI_REASONING_SUMMARY = String(process.env.BYOK_REASONING_SUMMARY || process.env.OPENAI_REASONING_SUMMARY || '').trim();
export const PROMPT_CACHE_ENABLED = !/^(false|0|off)$/i.test(String(process.env.BYOK_PROMPT_CACHE || 'true'));

export function isRetryableFailure(reason, meta = {}) {
  return isRetryableAttemptFailure({
    statusCode: meta.statusCode,
    code: meta.code,
    reason,
    matchReasonText: true,
  });
}

export function positiveInt(value, fallback, min = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function retryPolicyFromEnhancement(enhancement = {}) {
  return buildAttemptRetryPolicy(enhancement, {
    maxRetries: RETRY_MAX,
    baseMs: RETRY_BASE_MS,
    capMs: RETRY_CAP_MS,
    totalMs: RETRY_TOTAL_MS,
  });
}

export function retryDelayMs(attempt, meta = {}, policy = retryPolicyFromEnhancement()) {
  return computeAttemptRetryDelay(attempt, policy, meta.headers, 0, {
    capToRemaining: false,
    capMsOverride: RETRY_CAP_MS,
  });
}

export function clampText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function upstreamUrl(conn, apiPath) {
  const protocol = conn.protocol === 'http' ? 'http' : 'https';
  const hostname = conn.hostname || conn.host;
  const defaultPort = protocol === 'http' ? 80 : 443;
  const port = Number(conn.port || defaultPort);
  const portPart = port && port !== defaultPort ? `:${port}` : '';
  return `${protocol}://${hostname}${portPart}${apiPath}`;
}

export function upstreamRequestOptions(conn, apiPath, headers) {
  const protocol = conn.protocol === 'http' ? 'http' : 'https';
  const defaultPort = protocol === 'http' ? 80 : 443;
  return {
    module: protocol === 'http' ? http : https,
    options: {
      agent: protocol === 'http' ? SHARED_HTTP_AGENT : httpsAgentFor(SHARED_HTTPS_AGENT),
      hostname: conn.hostname || conn.host,
      port: Number(conn.port || defaultPort),
      path: apiPath,
      method: 'POST',
      headers,
    },
  };
}

function looksLikeHtml(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /<!DOCTYPE\s+html/i.test(s)
    || /<\/?html[\s>]/i.test(s)
    || /<div[^>]*\bid=["']?cf-wrapper/i.test(s)
    || (/<(?:head|body|title|meta|style)[\s>]/i.test(s) && /cloudflare|cf-error|attention required/i.test(s));
}

function summarizeHtmlError(text) {
  const raw = String(text || '');
  const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const ray = raw.match(/Cloudflare Ray ID[^0-9A-Za-z]*([0-9a-f]+)/i)?.[1]
    || raw.match(/cf-ray["'=:\s]+([0-9a-f-]+)/i)?.[1];
  const code = raw.match(/Error code\s*(\d{3})/i)?.[1]
    || raw.match(/\b(520|521|522|523|524|525|526|530)\b/)?.[1];
  const parts = ['上游返回 HTML 错误页'];
  if (code) parts.push(`HTTP/CF ${code}`);
  if (title) parts.push(title.replace(/\s+/g, ' '));
  if (ray) parts.push(`Ray ${ray}`);
  return clampText(parts.join(' · '));
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
    if (msg) {
      const text = String(msg).replace(/\s*\(request id:[^)]+\)/ig, '');
      if (looksLikeHtml(text)) return summarizeHtmlError(text);
      return clampText(text);
    }
  } catch {
    // Non-JSON provider bodies may be useful if short and non-HTML.
  }
  if (looksLikeHtml(raw)) return summarizeHtmlError(raw);
  if (raw.length > 400 || /[<>]{2,}|\{[\s\S]{200,}/.test(raw)) {
    return '';
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

export function failureLogLine(failure = {}) {
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

export function connectCodeForFailures(failures = []) {
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

export function providerFailureMessage(failures = []) {
  if (failures.length === 0) {
    return 'BYOK 暂时无法连接模型：没有可用的供应商目标。请检查模型映射，或添加备用目标。';
  }
  const summaries = failures.map(failureSummary);
  const head = failures.length === 1
    ? `BYOK 暂时无法连接模型：${summaries[0]}。`
    : `BYOK 暂时无法连接模型，${failures.length} 个备用目标都不可用：${summaries.join('；')}。`;
  return clampText(`${head}${failureHint(failures)}`, 520);
}

export function trackerOf(res) {
  const tracker = res && res.__byokTracker;
  if (!tracker) throw new Error('[chat] request tracker missing on response');
  return tracker;
}

export function sendTerminalError(res, messageId, message, code = 'unavailable') {
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(200, streamHeaders());
  if (NATIVE_STREAM_ERRORS) {
    res.write(endOfStreamErrorEnvelope({ code, message }));
  } else {
    res.write(wrapEnvelope(buildErrorChunk(messageId, message)));
    res.write(endOfStreamEnvelope());
  }
  res.end();
  trackerOf(res).finish();
}

export function getServiceTier(requestedModel) {
  return serviceTierFromUid(requestedModel);
}

export function extractModelId(body, headers) {
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

export function messageHasImage(msg) {
  if (!msg || typeof msg.content === 'string') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(block => block && block.type === 'image');
}

export function markModelSuccess(conn, model, messages, tools) {
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

export function enhancementRequestHeaders(enhancement = {}) {
  return enhancementHeaders(enhancement, 'customHeaders');
}

export function enhancementResponseHeaders(enhancement = {}) {
  return enhancementHeaders(enhancement, 'responseHeaders');
}

export function applySystemPromptEnhancement(systemPrompt, enhancement = {}) {
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

export function applyChatToolEnhancement(tools, toolChoice, enhancement = {}) {
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

function isOpenAIResponsesPath(apiPath = '') {
  return /\/responses(?:$|\?)/i.test(String(apiPath || ''));
}

export function isOpenAIChatCompletionsPath(apiPath = '') {
  return /\/chat\/completions(?:$|\?)/i.test(String(apiPath || ''));
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

export function applyChatToolInjection(tools, conn, enhancement = {}, searchModels = {}) {
  const nextTools = Array.isArray(tools) ? [...tools] : [];
  if (enhancement.webSearchEnabled !== true) {
    return { tools: nextTools, searchInjection: { mode: 'off' } };
  }
  const existingNames = new Set(nextTools.map(chatToolName).filter(Boolean));
  if (existingNames.has('web_search')) {
    return {
      tools: nextTools,
      searchInjection: { mode: 'client-owned-web-search', reason: 'existing web_search tool' },
    };
  }
  if (conn.format === 'gemini' && nextTools.length === 0) {
    console.log(`  🔎 检测到 ${conn.providerName} 原生搜索，注入 google_search 工具`);
    nextTools.push({ google_search: {} });
    return {
      tools: nextTools,
      searchInjection: { mode: 'builtin', nativeTool: { google_search: {} }, provider: conn.providerId },
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
  if (tool.google_search && typeof tool.google_search === 'object') return { google_search: tool.google_search };
  if (tool.type === 'web_search') return { type: 'web_search' };
  if (tool.type === 'web_search_preview') return chatCompletions ? null : { type: 'web_search_preview' };
  if (typeof tool.type === 'string' && tool.type && tool.type !== 'function' && !tool.name && !tool.function) {
    return { ...tool };
  }
  return null;
}

function isGeminiModel(model = '') {
  return /gemini/i.test(String(model));
}

function normalizeToolSchema(inputSchema, model, forceGeminiCompat = false) {
  const raw = typeof inputSchema === 'string' ? JSON.parse(inputSchema) : (inputSchema || {});
  return (forceGeminiCompat || isGeminiModel(model)) ? sanitizeGeminiSchema(raw) : raw;
}

export function shouldAutoEnableGeminiSchemaCompat(statusCode, errBody = '') {
  if (statusCode !== 400) return false;
  const s = String(errBody || '');
  return /Invalid JSON payload received/i.test(s)
    && /(exclusiveMinimum|propertyNames|function_declarations|\$schema|additionalProperties)/i.test(s);
}

export function serializeOpenAITools(tools, { chatCompletions = false, resolvedModel, forceGeminiCompat = false } = {}) {
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

export function searchQueryFromToolCall(call) {
  const input = parseToolArguments(call.arguments_json || call.arguments || '');
  return String(input.query || input.q || input.search || '').trim();
}

export function appendToolExchange(messages, toolCalls, toolResults) {
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

export function applyPayloadParamOverrides(payload, enhancement = {}, tokenKey = 'max_tokens') {
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
export function checkChatRateLimit(model, rpm) {
  return checkWindowRateLimit(chatRateLimitBuckets, model, rpm, 2000);
}

export function logEnhancedChatRequest(entry) {
  try {
    const dir = path.join(configDir(), 'proxy-logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cleanupExpiredLogs();
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

export function logEnhancedChatResponse(enhancement, conn, resolvedModel, processor) {
  if (enhancement.requestLogging !== true) return;
  logEnhancedChatRequest({
    phase: 'response',
    provider: conn.providerName,
    model: resolvedModel,
    statusCode: 200,
    usage: processor?.usage || {},
  });
}

export function shouldUseAnthropicPromptCache(conn, claudeCodeUnlock, promptCacheRetry = false) {
  if (!PROMPT_CACHE_ENABLED || promptCacheRetry || claudeCodeUnlock) return false;
  return conn?.format === 'anthropic';
}

function cacheControl() {
  return { type: 'ephemeral' };
}

export function withAnthropicSystemCache(systemPrompt, enabled) {
  if (!systemPrompt) return undefined;
  if (!enabled) return systemPrompt;
  return [{ type: 'text', text: systemPrompt, cache_control: cacheControl() }];
}

export function withAnthropicToolsCache(tools, enabled) {
  if (!enabled || !Array.isArray(tools) || tools.length === 0) return tools;
  return tools.map((tool, idx) => {
    if (idx !== tools.length - 1 || !tool || typeof tool !== 'object') return tool;
    return { ...tool, cache_control: cacheControl() };
  });
}

export function withAnthropicPromptCacheHeaders(headers, enabled) {
  if (!enabled) return headers;
  const out = { ...headers };
  const beta = 'prompt-caching-2024-07-31';
  const existing = String(out['anthropic-beta'] || '').trim();
  out['anthropic-beta'] = existing
    ? (existing.split(',').map(x => x.trim()).includes(beta) ? existing : `${existing},${beta}`)
    : beta;
  return out;
}

export function isPromptCacheRejected(statusCode, body = '') {
  if (![400, 422].includes(statusCode)) return false;
  return /cache[_ -]?control|prompt[_ -]?cache|prompt caching|anthropic-beta|unknown field|extra_forbidden|unrecognized|unsupported/i.test(String(body || ''));
}

export function envReasoningEffort() {
  if (!OPENAI_REASONING_EFFORT || /^(off|none|false|0)$/i.test(OPENAI_REASONING_EFFORT)) return '';
  return OPENAI_REASONING_EFFORT;
}

export function isThinkingParamRejected(statusCode, body = '') {
  if (![400, 422].includes(statusCode)) return false;
  return /thinking|output[_-]?config|reasoning|effort/i.test(String(body || ''));
}

export function injectThinking(apiPayload, conn, thinking) {
  let t = thinking;
  if (t?.mode === 'off' && conn?.unlockKind === 'claudeCode') t = { ...t, mode: 'level', level: 'low' };
  applyThinkingToPayload(apiPayload, conn, t);
}

export function anthropicAuthHeaders(conn) {
  const headers = { 'anthropic-version': '2023-06-01' };
  if (conn.authScheme === 'bearer') headers.authorization = `Bearer ${conn.apiKey}`;
  else headers['x-api-key'] = conn.apiKey;
  return headers;
}
