// handlers/chat/upstream-builders.js — 统一构建 Anthropic / OpenAI Responses / OpenAI Chat 上游请求契约

import {
  applyCodexUnlockRequiredFields,
  buildClaudeCodeUnlockPayload,
  claudeCodeUnlockForTarget,
  claudeCodeUnlockHeaders,
  codexUnlockForTarget,
  codexUnlockHeaders,
} from '../../lib/codex-unlock.js';
import { gzipSync } from '../../connect.js';
import { createAnthropicSSEFromGemini } from '../../lib/gemini-sse-transform.js';
import { parseSSEText } from '../../lib/sse-parser.js';
import {
  applyGeminiSkipThoughtSignatureValidator,
  normalizeGeminiThinkingConfig,
  redactGeminiCredential,
  resolveGeminiAuthHeader,
} from '../../lib/google-gemini.js';
import {
  buildGeminiChatPayload,
  geminiStreamApiPath,
} from '../../lib/local-proxy/upstream-payload.js';
import { AnthropicStreamProcessor, parseSSEChunk } from '../anthropic-stream.js';
import { OpenAIChatCompletionsStreamProcessor, OpenAIStreamProcessor, parseOpenAISSEChunk } from '../openai-stream.js';
import { toOpenAIChatMessages, toOpenAIMessages } from './to-openai-messages.js';
import {
  MAX_TOKENS,
  OPENAI_REASONING_EFFORT,
  OPENAI_REASONING_SUMMARY,
  anthropicAuthHeaders,
  applyPayloadParamOverrides,
  enhancementRequestHeaders,
  injectThinking,
  isOpenAIChatCompletionsPath,
  serializeOpenAITools,
  shouldUseAnthropicPromptCache,
  upstreamUrl,
  withAnthropicPromptCacheHeaders,
  withAnthropicSystemCache,
  withAnthropicToolsCache,
} from './utils.js';

export function buildAnthropicUpstreamSpec(opts, { buffered = false } = {}) {
  const {
    systemPrompt, messages, tools, toolChoice, resolvedModel, messageId,
    conn, enhancement = {}, thinking = null, promptCacheRetry = false,
  } = opts;
  const claudeCodeUnlock = claudeCodeUnlockForTarget(conn);
  const targetPath = claudeCodeUnlock?.wireApi || conn.apiPath;
  const usePromptCache = shouldUseAnthropicPromptCache(conn, claudeCodeUnlock, promptCacheRetry);
  const authHeaders = withAnthropicPromptCacheHeaders(
    claudeCodeUnlock ? claudeCodeUnlockHeaders(conn) : anthropicAuthHeaders(conn),
    usePromptCache
  );
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const sentTools = (buffered || !claudeCodeUnlock) ? withAnthropicToolsCache(tools, usePromptCache) : tools;

  let apiPayload;
  if (claudeCodeUnlock) {
    apiPayload = buildClaudeCodeUnlockPayload({
      model: resolvedModel,
      system: systemPrompt,
      messages,
      maxTokens: MAX_TOKENS,
      ...(buffered ? { stream: true } : {}),
      tools: sentTools,
    });
    if (!buffered && sentTools && sentTools.length > 0 && toolChoice) {
      apiPayload.tool_choice = toolChoice;
    }
  } else {
    apiPayload = {
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
  }
  injectThinking(apiPayload, conn, thinking);
  applyPayloadParamOverrides(apiPayload, enhancement, 'max_tokens');

  const apiBody = JSON.stringify(apiPayload);
  const finalBody = Buffer.from(apiBody);
  const requestUrl = upstreamUrl(conn, targetPath);
  const logHeaders = { 'content-type': 'application/json', 'accept': 'text/event-stream', ...authHeaders, ...extraHeaders };
  const reqHeaders = { ...logHeaders, 'content-length': finalBody.length };

  const processor = new AnthropicStreamProcessor(messageId, resolvedModel);
  return {
    format: 'anthropic',
    watchdogLabel: `${conn.providerName}/${resolvedModel} ${buffered ? 'anthropic-buffered' : 'anthropic'}`,
    targetPath,
    requestUrl,
    apiBody,
    finalBody,
    logHeaders,
    reqHeaders,
    markSuccessTools: sentTools,
    usePromptCache,
    promptCacheRetry,
    createSession() {
      const toProto = (evt) => {
        if (!evt || evt.done) return [];
        const eventName = !evt.hasExplicitEvent && typeof evt.data?.type === 'string'
          ? evt.data.type
          : evt.event;
        return processor.processEvent({ event: eventName, data: evt.data });
      };
      return {
        parseEvents: (part) => parseSSEChunk(`${part}\n\n`),
        consumeSSEEvent: toProto,
        processEvent: (evt) => processor.processEvent(evt),
        activeProcessor: () => processor,
        finishPayload: () => ({ event: 'message_stop', data: {} }),
        canFlushOnEof: () => false,
        forcedStopReason: () => processor.stopReason || 'forced',
        doneFormat: () => 'anthropic',
        doneExpectedMessage: () => 'message_stop',
      };
    },
    onBeforeSend() {
      if (!buffered && usePromptCache) {
        console.log(`  🧊 Anthropic prompt cache enabled: system${sentTools?.length ? ' + tools' : ''}`);
      }
    },
  };
}

export function buildOpenAIResponsesUpstreamSpec(opts, { buffered = false } = {}) {
  const {
    systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId,
    conn, enhancement = {}, thinking = null, schemaCompatRetry = false,
  } = opts;
  const codexUnlock = codexUnlockForTarget(conn);
  const targetPath = codexUnlock?.wireApi || conn.apiPath;
  const openaiMessages = toOpenAIMessages(systemPrompt, messages);
  const forceGeminiCompat = schemaCompatRetry || conn.capabilities?.toolSchemaCompat === 'gemini';

  const apiPayload = {
    model: resolvedModel,
    input: openaiMessages,
    stream: true,
  };
  if (buffered || !codexUnlock) {
    apiPayload.max_output_tokens = MAX_TOKENS;
  }
  if ((buffered || !codexUnlock) && OPENAI_REASONING_EFFORT && !/^(off|none|false|0)$/i.test(OPENAI_REASONING_EFFORT)) {
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
  if (codexUnlock) {
    applyCodexUnlockRequiredFields(apiPayload, codexUnlock);
  }
  injectThinking(apiPayload, conn, thinking);
  applyPayloadParamOverrides(apiPayload, enhancement, 'max_output_tokens');

  const apiBody = JSON.stringify(apiPayload);
  const authHeaders = codexUnlock ? codexUnlockHeaders(conn, apiPayload.prompt_cache_key) : { authorization: `Bearer ${conn.apiKey}` };
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const requestUrl = upstreamUrl(conn, targetPath);
  const useGzip = conn.capabilities?.gzip === true;
  const finalBody = useGzip ? gzipSync(Buffer.from(apiBody)) : Buffer.from(apiBody);
  const logHeaders = { 'content-type': 'application/json', 'accept': 'text/event-stream', ...authHeaders, ...extraHeaders };
  const reqHeaders = { ...logHeaders, 'content-length': finalBody.length };
  if (useGzip) reqHeaders['content-encoding'] = 'gzip';

  const responseProcessor = new OpenAIStreamProcessor(messageId, resolvedModel);
  const chatFallbackProcessor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
  let processorMode = 'responses';

  return {
    format: 'openai-responses',
    watchdogLabel: `${conn.providerName}/${resolvedModel} ${buffered ? 'openai-responses-buffered' : 'openai-responses'}`,
    targetPath,
    requestUrl,
    apiBody,
    finalBody,
    logHeaders,
    reqHeaders,
    markSuccessTools: tools,
    supportsSchemaCompatRetry: true,
    createSession() {
      const handleEvt = (evt) => {
        if (processorMode === 'responses' && evt?.data?.choices) {
          processorMode = 'chat';
          console.warn(`  ⚠️  OpenAI endpoint returned chat.completion chunks; switching stream parser`);
        }
        return (processorMode === 'chat' ? chatFallbackProcessor : responseProcessor).processEvent(evt);
      };
      return {
        parseEvents: (part) => parseOpenAISSEChunk(`${part}\n`),
        consumeSSEEvent: (sseEvt) => {
          if (!sseEvt) return [];
          if (sseEvt.done) return handleEvt({ done: true, type: 'done', data: null });
          if (sseEvt.jsonError || !sseEvt.data || typeof sseEvt.data !== 'object') return [];
          return handleEvt({ done: false, type: sseEvt.data.type || '', data: sseEvt.data });
        },
        processEvent: handleEvt,
        activeProcessor: () => (processorMode === 'chat' ? chatFallbackProcessor : responseProcessor),
        finishPayload: () => ({ done: true, type: 'done', data: null }),
        canFlushOnEof: () => false,
        forcedStopReason: () => (processorMode === 'chat' ? chatFallbackProcessor : responseProcessor).stopReason,
        doneFormat: () => (buffered && processorMode === 'chat' ? 'openai-chat' : 'openai-responses'),
        doneExpectedMessage: () => (processorMode === 'chat' ? '[DONE]' : 'response.completed'),
      };
    },
  };
}

export function buildOpenAIChatUpstreamSpec(opts, { buffered = false } = {}) {
  const {
    systemPrompt, messages, tools, toolChoice, resolvedModel, serviceTier, messageId,
    conn, enhancement = {}, thinking = null, schemaCompatRetry = false,
  } = opts;
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
  injectThinking(apiPayload, conn, thinking);
  applyPayloadParamOverrides(apiPayload, enhancement, 'max_tokens');

  const apiBody = JSON.stringify(apiPayload);
  const finalBody = Buffer.from(apiBody);
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const requestUrl = upstreamUrl(conn, conn.apiPath);
  const logHeaders = { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}`, ...extraHeaders };
  const reqHeaders = { 'content-type': 'application/json', 'accept': 'text/event-stream', authorization: `Bearer ${conn.apiKey}`, ...extraHeaders, 'content-length': finalBody.length };

  const processor = new OpenAIChatCompletionsStreamProcessor(messageId, resolvedModel);
  return {
    format: 'openai-chat',
    watchdogLabel: `${conn.providerName}/${resolvedModel} ${buffered ? 'openai-chat-buffered' : 'openai-chat'}`,
    targetPath: conn.apiPath,
    requestUrl,
    apiBody,
    finalBody,
    logHeaders,
    reqHeaders,
    markSuccessTools: tools,
    supportsSchemaCompatRetry: true,
    createSession() {
      return {
        parseEvents: (part) => parseOpenAISSEChunk(`${part}\n`),
        consumeSSEEvent: (sseEvt) => {
          if (!sseEvt) return [];
          if (sseEvt.done) return processor.processEvent({ done: true, type: 'done', data: null });
          if (sseEvt.jsonError || !sseEvt.data || typeof sseEvt.data !== 'object') return [];
          return processor.processEvent({ done: false, type: sseEvt.data.type || '', data: sseEvt.data });
        },
        processEvent: (evt) => processor.processEvent(evt),
        activeProcessor: () => processor,
        finishPayload: () => ({ done: true, type: 'done', data: null }),
        canFlushOnEof: () => false,
        forcedStopReason: () => processor.stopReason,
        doneFormat: () => 'openai-chat',
        doneExpectedMessage: () => '[DONE]',
      };
    },
  };
}

export function selectOpenAISpecBuilder(conn, buffered = false) {
  if (codexUnlockForTarget(conn)) return (opts) => buildOpenAIResponsesUpstreamSpec(opts, { buffered });
  if (isOpenAIChatCompletionsPath(conn.apiPath)) return (opts) => buildOpenAIChatUpstreamSpec(opts, { buffered });
  return (opts) => buildOpenAIResponsesUpstreamSpec(opts, { buffered });
}

function parseGeminiSseFrames(part) {
  const frames = [];
  for (const evt of parseSSEText(part, { flush: true })) {
    if (evt.done || evt.jsonError || !evt.data || typeof evt.data !== 'object') continue;
    frames.push(evt.data);
  }
  return frames;
}

export async function buildGeminiUpstreamSpec(opts, { buffered = false } = {}) {
  const {
    systemPrompt, messages, tools, toolChoice, resolvedModel, messageId,
    conn, enhancement = {}, thinking = null, geminiMinimalToLow = false,
    geminiThinkingDisabled = false, geminiSkipThoughtSignature = false,
  } = opts;

  let apiPayload = buildGeminiChatPayload({
    conn,
    system: systemPrompt,
    messages,
    tools,
    toolChoice,
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  });
  if (geminiSkipThoughtSignature) {
    apiPayload = applyGeminiSkipThoughtSignatureValidator(apiPayload);
  }
  if (!geminiThinkingDisabled && thinking) {
    const effectiveThinking = (geminiMinimalToLow && thinking.level === 'minimal')
      ? { ...thinking, level: 'low' }
      : thinking;
    injectThinking(apiPayload, conn, effectiveThinking);
    apiPayload = normalizeGeminiThinkingConfig(apiPayload, conn);
  } else if (geminiThinkingDisabled && apiPayload.generationConfig) {
    delete apiPayload.generationConfig.thinkingConfig;
  }

  applyPayloadParamOverrides(apiPayload, enhancement, 'maxOutputTokens');
  if (apiPayload.maxOutputTokens !== undefined) {
    apiPayload.generationConfig = {
      ...(apiPayload.generationConfig || {}),
      maxOutputTokens: apiPayload.maxOutputTokens,
    };
    delete apiPayload.maxOutputTokens;
  }

  let resolvedAuth;
  try {
    resolvedAuth = await resolveGeminiAuthHeader(conn.apiKey);
  } catch (e) {
    throw new Error(redactGeminiCredential(e?.message || String(e), conn.apiKey));
  }

  const targetPath = geminiStreamApiPath(conn);
  const requestUrl = upstreamUrl(conn, targetPath);
  const extraHeaders = enhancementRequestHeaders(enhancement);
  const apiBody = JSON.stringify(apiPayload);
  const finalBody = Buffer.from(apiBody);
  const logAuthHeaders = {};
  for (const [k, v] of Object.entries(resolvedAuth.headers || {})) {
    logAuthHeaders[k] = redactGeminiCredential(String(v || ''), conn.apiKey);
  }
  const logHeaders = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...logAuthHeaders,
    ...extraHeaders,
  };
  const reqHeaders = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...resolvedAuth.headers,
    ...extraHeaders,
    'content-length': finalBody.length,
  };

  const toAnthropic = createAnthropicSSEFromGemini(resolvedModel);
  const processor = new AnthropicStreamProcessor(messageId, resolvedModel);

  return {
    format: 'gemini',
    isGemini: true,
    watchdogLabel: `${conn.providerName}/${resolvedModel} ${buffered ? 'gemini-buffered' : 'gemini'}`,
    targetPath,
    requestUrl,
    apiPayload,
    apiBody,
    finalBody,
    logHeaders,
    reqHeaders,
    markSuccessTools: tools,
    supportsGeminiThinkingHeal: true,
    createSession() {
      let sawFinishReason = false;
      const emitFrame = (frame) => {
        if (frame?.candidates?.[0]?.finishReason) sawFinishReason = true;
        const out = [];
        for (const ev of toAnthropic.write(frame)) {
          out.push(...processor.processEvent(ev));
        }
        return out;
      };
      return {
        parseEvents: (part) => {
          const out = [];
          for (const frame of parseGeminiSseFrames(part)) {
            out.push(...toAnthropic.write(frame));
          }
          return out;
        },
        consumeSSEEvent: (sseEvt) => {
          if (!sseEvt || sseEvt.done || sseEvt.jsonError || !sseEvt.data || typeof sseEvt.data !== 'object') {
            return [];
          }
          return emitFrame(sseEvt.data);
        },
        processEvent: (evt) => {
          if (evt && evt.__geminiFlush) {
            const out = [];
            for (const ev of toAnthropic.flush()) {
              out.push(...processor.processEvent(ev));
            }
            return out;
          }
          return processor.processEvent(evt);
        },
        activeProcessor: () => processor,
        finishPayload: () => ({ __geminiFlush: true }),
        canFlushOnEof: () => sawFinishReason,
        forcedStopReason: () => processor.stopReason,
        doneFormat: () => 'gemini',
        doneExpectedMessage: () => 'finishReason / message_stop',
      };
    },
  };
}
