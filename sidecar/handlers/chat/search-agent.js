// handlers/chat/search-agent.js — web_search Agentic Loop 与缓冲结果下发

import { endOfStreamEnvelope, streamHeaders, wrapEnvelope } from '../../connect.js';
import { mitmLog } from '../../mitm-logger.js';
import {
  buildToolErrorContent,
  buildToolResultContent,
  enabledSearchSources,
  executeSearchWithFailover,
} from '../search-sources.js';
import { requestAnthropicBuffered, requestGeminiBuffered, requestOpenAIBuffered } from './streaming.js';
import {
  appendToolExchange,
  clampText,
  enhancementResponseHeaders,
  logEnhancedChatResponse,
  markModelSuccess,
  positiveInt,
  searchQueryFromToolCall,
  sendTerminalError,
  trackerOf,
} from './utils.js';

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
  trackerOf(res).endAttempt({ status: 'ok', statusCode: 200, ms: Date.now() - result.streamStartedAt, usage: result.processor?.usage || {} });
  markModelSuccess(conn, resolvedModel, messages, tools);
  trackerOf(res).finish();
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

export async function streamSearchAgentLoop(req, res, opts) {
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
    trackerOf(res).fail('search-config', 'no enabled search source');
    sendTerminalError(res, messageId, '联网搜索已开启，但没有启用的搜索源。请先在网关增强中添加搜索源。', 'invalid_argument');
    return;
  }

  let loopMessages = opts.messages;
  let searchRounds = 0;
  const maxRounds = positiveInt(enhancement.webSearchMaxRounds, 3, 1);
  const maxResults = positiveInt(enhancement.webSearchMaxResults, 5, 1);

  while (!res.writableEnded) {
    const result = conn.format === 'openai'
      ? await requestOpenAIBuffered(req, res, { ...opts, messages: loopMessages })
      : (conn.format === 'gemini'
        ? await requestGeminiBuffered(req, res, { ...opts, messages: loopMessages })
        : await requestAnthropicBuffered(req, res, { ...opts, messages: loopMessages }));

    if (!result) return;
    if (result.kind === 'failover') {
      onFailover(result.reason, result.meta || {});
      return;
    }
    if (result.kind === 'terminal-error') {
      trackerOf(res).fail('search', result.message);
      sendTerminalError(res, messageId, result.message, result.code || 'unavailable');
      return;
    }
    if (result.kind !== 'success') {
      trackerOf(res).fail('search', 'unknown upstream result');
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
      trackerOf(res).fail('search-conflict', 'web_search mixed with client tools');
      sendTerminalError(res, messageId, `模型同时请求联网搜索和客户端工具（${names}），AnyBridge 无法同时接管并透传，已中止以避免未处理的 web_search 泄漏。`, 'invalid_argument');
      return;
    }

    searchRounds += 1;
    if (searchRounds > maxRounds) {
      trackerOf(res).fail('search-exhausted', 'max rounds exceeded');
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
