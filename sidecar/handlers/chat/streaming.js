// handlers/chat/streaming.js — 统一流式转发与缓冲请求核心引擎

import { endOfStreamEnvelope, streamHeaders, wrapEnvelope } from '../../connect.js';
import {
  healGemini400Payload,
  redactGeminiCredential,
} from '../../lib/google-gemini.js';
import { createSSEParser } from '../../lib/sse-parser.js';
import { rememberProviderToolSchemaCompat } from '../../provider-pool.js';
import { mitmLog } from '../../mitm-logger.js';
import {
  attachUpstreamWatchdog,
  providerGateKey,
  providerInflightGate,
  ttfbMsFromEnhancement,
} from '../../lib/upstream-watchdog.js';
import {
  buildAnthropicUpstreamSpec,
  buildGeminiUpstreamSpec,
  buildOpenAIChatUpstreamSpec,
  buildOpenAIResponsesUpstreamSpec,
  selectOpenAISpecBuilder,
} from './upstream-builders.js';
import {
  clampText,
  enhancementResponseHeaders,
  isPromptCacheRejected,
  isThinkingParamRejected,
  logEnhancedChatResponse,
  markModelSuccess,
  sendTerminalError,
  shouldAutoEnableGeminiSchemaCompat,
  trackerOf,
  upstreamRequestOptions,
} from './utils.js';

function readBoundedUtf8ErrorBody(apiRes, onDone, maxBytes = 4096) {
  const chunks = [];
  let totalBytes = 0;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(failTimer);
    onDone(Buffer.concat(chunks).toString('utf8'));
  };
  apiRes.on('data', (d) => {
    if (settled || totalBytes >= maxBytes) return;
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
    const remain = maxBytes - totalBytes;
    const slice = buf.length > remain ? buf.subarray(0, remain) : buf;
    chunks.push(slice);
    totalBytes += slice.length;
  });
  apiRes.on('end', finish);
  const failTimer = setTimeout(finish, 5000);
  apiRes.on('close', finish);
}

function finishStreamingResponse(res, session, spec, opts, streamStartedAt, rawOutput) {
  if (res.writableEnded) return;
  const { conn, resolvedModel, messages, enhancement = {} } = opts;
  const processor = session.activeProcessor();
  res.write(endOfStreamEnvelope());
  res.end();
  trackerOf(res).endAttempt({ status: 'ok', statusCode: 200, ms: Date.now() - streamStartedAt, usage: processor.usage });
  markModelSuccess(conn, resolvedModel, messages, spec.markSuccessTools);
  trackerOf(res).finish();
  logEnhancedChatResponse(enhancement, conn, resolvedModel, processor);
  mitmLog({
    direction: 'downstream',
    providerName: conn.providerName,
    model: resolvedModel,
    format: spec.doneFormat ? spec.doneFormat() : spec.format,
    request: { method: 'POST', url: spec.requestUrl },
    response: {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `[USAGE] ${JSON.stringify(processor.usage)}\n\n${rawOutput.join('\n\n')}`,
    },
  });
}

function resolveSelfHealRetryOpts(spec, opts, statusCode, errBody) {
  const { conn, resolvedModel, tools, thinking = null, schemaCompatRetry = false } = opts;
  if (spec.supportsGeminiThinkingHeal && statusCode === 400 && spec.apiPayload) {
    const healState = {
      minimalDowngraded: Boolean(opts.geminiMinimalToLow),
      thinkingHealed: Boolean(opts.geminiThinkingDisabled),
      signatureHealed: Boolean(opts.geminiSkipThoughtSignature),
    };
    const healed = healGemini400Payload(spec.apiPayload, errBody, healState);
    if (healed) {
      console.warn(`  ♻️  ${conn.providerName} / ${resolvedModel} triggered ${healed.kind}, retrying`);
      return {
        ...opts,
        geminiMinimalToLow: healState.minimalDowngraded,
        geminiThinkingDisabled: healState.thinkingHealed,
        geminiSkipThoughtSignature: healState.signatureHealed,
      };
    }
  }
  if (thinking && isThinkingParamRejected(statusCode, errBody)) {
    console.warn(`  ♻️  ${conn.providerName} / ${resolvedModel} 不接受思考档位参数，本次移除后重试一次`);
    return { ...opts, thinking: null };
  }
  if (spec.usePromptCache && !spec.promptCacheRetry && isPromptCacheRejected(statusCode, errBody)) {
    console.warn(`  ♻️  ${conn.providerName} / ${resolvedModel} 不接受 cache_control，本次移除后重试一次`);
    return { ...opts, promptCacheRetry: true };
  }
  if (spec.supportsSchemaCompatRetry && !schemaCompatRetry && shouldAutoEnableGeminiSchemaCompat(statusCode, errBody) && tools && tools.length > 0) {
    const remembered = rememberProviderToolSchemaCompat(conn.providerId, 'gemini');
    if (remembered) console.log(`  🧠 已记住 ${conn.providerName} 的工具 Schema 兼容模式: gemini`);
    console.warn(`  ♻️  检测到工具 Schema 不兼容，自动启用兼容模式并重试一次`);
    return {
      ...opts,
      schemaCompatRetry: true,
      conn: { ...conn, capabilities: { ...(conn.capabilities || {}), toolSchemaCompat: 'gemini' } },
    };
  }
  return null;
}

async function runStreamingUpstream(req, res, opts, buildSpec) {
  const { conn, resolvedModel, messageId, enhancement = {}, onFailover, bindActiveReq = null } = opts;
  const freeSlot = await providerInflightGate.acquire(providerGateKey(conn));
  let slotFreed = false;
  const freeOnce = () => {
    if (slotFreed) return;
    slotFreed = true;
    freeSlot();
  };

  let spec;
  try {
    spec = await buildSpec(opts, { buffered: false });
  } catch (err) {
    freeOnce();
    const safeMsg = conn.format === 'gemini' ? redactGeminiCredential(err?.message || String(err), conn.apiKey) : (err?.message || String(err));
    onFailover(safeMsg, { code: err?.code });
    return null;
  }
  if (typeof spec.onBeforeSend === 'function') spec.onBeforeSend();

  const session = spec.createSession();
  let failed = false;

  mitmLog({
    direction: 'upstream',
    providerName: conn.providerName,
    model: resolvedModel,
    format: spec.format,
    request: { method: 'POST', url: spec.requestUrl, headers: spec.logHeaders, body: spec.apiBody },
  });

  const requestConfig = upstreamRequestOptions(conn, spec.targetPath, spec.reqHeaders);
  let watchdog = null;
  let activeRes = null;
  let sseParser = null;
  const cleanupOnTerminal = () => {
    freeOnce();
    watchdog?.clear();
  };
  const onClientClose = () => {
    if (!res.writableEnded && !failed) {
      failed = true;
      cleanupOnTerminal();
      try { activeRes?.destroy(); } catch {}
      try { apiReq.destroy(); } catch {}
    }
  };
  res.once('close', onClientClose);

  const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
    activeRes = apiRes;
    watchdog?.markResponse(apiRes);
    apiRes.on('end', cleanupOnTerminal);
    apiRes.on('close', cleanupOnTerminal);
    apiRes.on('error', cleanupOnTerminal);

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ ${conn.providerName} 返回 ${apiRes.statusCode}`);
      readBoundedUtf8ErrorBody(apiRes, (errBody) => {
        const safeErrBody = conn.format === 'gemini' ? redactGeminiCredential(errBody, conn.apiKey) : errBody;
        console.error(`  ❌ Body: ${safeErrBody.slice(0, 300)}`);
        mitmLog({
          direction: 'downstream',
          providerName: conn.providerName,
          model: resolvedModel,
          format: spec.format,
          request: { method: 'POST', url: spec.requestUrl },
          response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: safeErrBody },
        });
        const retryOpts = !res.headersSent ? resolveSelfHealRetryOpts(spec, opts, apiRes.statusCode, safeErrBody) : null;
        cleanupOnTerminal();
        res.off('close', onClientClose);
        apiReq.destroy();
        if (retryOpts) {
          if (!failed) {
            failed = true;
            return runStreamingUpstream(req, res, retryOpts, buildSpec);
          }
          return;
        }
        if (!failed) {
          failed = true;
          onFailover(`HTTP ${apiRes.statusCode}`, { statusCode: apiRes.statusCode, headers: apiRes.headers, body: safeErrBody });
        }
      });
      return;
    }

    const streamStartedAt = Date.now();
    res.writeHead(200, { ...streamHeaders(), ...enhancementResponseHeaders(enhancement) });
    sseParser = createSSEParser({ parseJson: true });
    const rawOutput = [];

    function handleSSEEvent(sseEvt) {
      if (failed || res.writableEnded) return;
      if (sseEvt.rawData) rawOutput.push(sseEvt.rawData);
      let protoChunks;
      try {
        protoChunks = session.consumeSSEEvent
          ? session.consumeSSEEvent(sseEvt)
          : session.processEvent(sseEvt);
      } catch (err) {
        failed = true;
        cleanupOnTerminal();
        res.off('close', onClientClose);
        apiReq.destroy();
        const rawMsg = err?.message || String(err);
        const safeMsg = conn.format === 'gemini' ? redactGeminiCredential(rawMsg, conn.apiKey) : rawMsg;
        trackerOf(res).fail('upstream-stream', safeMsg);
        sendTerminalError(res, messageId, `BYOK 上游流错误：${conn.providerName} / ${resolvedModel}（${clampText(safeMsg, 140)}）。`, 'unavailable');
        return;
      }
      for (const chunk of protoChunks) {
        res.write(wrapEnvelope(chunk));
      }
      const processor = session.activeProcessor();
      if (processor.isDone && !res.writableEnded) {
        res.off('close', onClientClose);
        finishStreamingResponse(res, session, spec, opts, streamStartedAt, rawOutput);
        console.log(`  ✅ ${spec.format} stream done (stop: ${processor.stopReason})`);
      }
    }

    apiRes.on('data', (chunk) => {
      if (failed) return;
      for (const sseEvt of sseParser.push(chunk)) {
        handleSSEEvent(sseEvt);
        if (failed) break;
      }
    });

    apiRes.on('end', () => {
      res.off('close', onClientClose);
      if (failed) return;
      for (const sseEvt of sseParser.flush()) {
        handleSSEEvent(sseEvt);
        if (failed) return;
      }
      const processor = session.activeProcessor();
      if (!processor.isDone && !res.writableEnded) {
        if (session.canFlushOnEof?.()) {
          for (const chunk of session.processEvent(session.finishPayload())) {
            res.write(wrapEnvelope(chunk));
          }
          finishStreamingResponse(res, session, spec, opts, streamStartedAt, rawOutput);
          console.log(`  ✅ ${spec.format} stream ended (stop: ${session.forcedStopReason()})`);
          return;
        }
        const reason = `upstream stream ended before ${session.doneExpectedMessage()}`;
        console.warn(`  ⚠️  ${spec.format} ${reason} — aborting without ok settlement`);
        trackerOf(res).endAttempt({
          status: 'failed',
          statusCode: 200,
          ms: Date.now() - streamStartedAt,
          error: reason,
          usage: processor.usage,
        });
        trackerOf(res).fail('upstream-stream', reason);
        sendTerminalError(res, messageId, `BYOK 上游流提前中断：${conn.providerName} / ${resolvedModel}（未收到结束标志 ${session.doneExpectedMessage()}）。`, 'unavailable');
        return;
      }
      if (!res.writableEnded) {
        finishStreamingResponse(res, session, spec, opts, streamStartedAt, rawOutput);
        console.log(`  ✅ ${spec.format} stream ended (stop: ${session.forcedStopReason()})`);
      }
    });

    apiRes.on('error', (err) => {
      res.off('close', onClientClose);
      cleanupOnTerminal();
      if (failed) return;
      failed = true;
      console.error(`  ❌ ${spec.format} stream error: ${err.message}`);
      trackerOf(res).fail('upstream-stream', err.message);
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, `BYOK 上游流中断：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请稍后重试或切换备用供应商。`, 'unavailable');
      }
    });
  });

  if (typeof bindActiveReq === 'function') bindActiveReq(apiReq);

  apiReq.on('error', (err) => {
    res.off('close', onClientClose);
    freeOnce();
    watchdog?.clear();
    console.error(`  ❌ ${conn.providerName} 连接错误: ${err.message}`);
    if (!failed && !res.headersSent) {
      failed = true;
      onFailover(err.message, { code: err.code });
      return;
    }
    if (!res.writableEnded) {
      trackerOf(res).fail('network', err.message);
      sendTerminalError(res, messageId, `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`, 'unavailable');
    }
  });

  watchdog = attachUpstreamWatchdog(apiReq, { label: spec.watchdogLabel, ttfbMs: ttfbMsFromEnhancement(enhancement) });
  apiReq.end(spec.finalBody);
  return apiReq;
}

export function runBufferedUpstream(req, res, opts, buildSpec) {
  const { conn, resolvedModel, enhancement = {}, bindActiveReq = null } = opts;
  return providerInflightGate.run(providerGateKey(conn), async () => {
    let spec;
    try {
      spec = await buildSpec(opts, { buffered: true });
    } catch (err) {
      const safeMsg = conn.format === 'gemini' ? redactGeminiCredential(err?.message || String(err), conn.apiKey) : (err?.message || String(err));
      return { kind: 'failover', reason: safeMsg, meta: { code: err?.code } };
    }
    return new Promise((resolve) => {
      const session = spec.createSession();

      mitmLog({
        direction: 'upstream',
        providerName: conn.providerName,
        model: resolvedModel,
        format: spec.format,
        request: { method: 'POST', url: spec.requestUrl, headers: spec.logHeaders, body: spec.apiBody },
      });

      const requestConfig = upstreamRequestOptions(conn, spec.targetPath, spec.reqHeaders);
      let failed = false;
      let streamStarted = false;
      let watchdog = null;
      const onClientClose = () => {
        if (!res.writableEnded && !failed) {
          failed = true;
          watchdog?.clear();
          try { apiReq.destroy(); } catch {}
          resolve({ kind: 'aborted', reason: 'client disconnected' });
        }
      };
      res.once('close', onClientClose);

      const apiReq = requestConfig.module.request(requestConfig.options, (apiRes) => {
        watchdog?.markResponse(apiRes);

        if (apiRes.statusCode !== 200) {
          readBoundedUtf8ErrorBody(apiRes, (errBody) => {
            if (failed) return;
            failed = true;
            res.off('close', onClientClose);
            watchdog?.clear();
            const safeErrBody = conn.format === 'gemini' ? redactGeminiCredential(errBody, conn.apiKey) : errBody;
            mitmLog({
              direction: 'downstream',
              providerName: conn.providerName,
              model: resolvedModel,
              format: spec.format,
              request: { method: 'POST', url: spec.requestUrl },
              response: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: safeErrBody },
            });
            const retryOpts = resolveSelfHealRetryOpts(spec, opts, apiRes.statusCode, safeErrBody);
            apiReq.destroy();
            if (retryOpts) {
              runBufferedUpstream(req, res, retryOpts, buildSpec).then(resolve);
              return;
            }
            resolve({ kind: 'failover', reason: `HTTP ${apiRes.statusCode}`, meta: { statusCode: apiRes.statusCode, headers: apiRes.headers, body: safeErrBody } });
          });
          return;
        }

        streamStarted = true;
        const streamStartedAt = Date.now();
        const rawOutput = [];
        const protoChunks = [];
        const sseParser = createSSEParser({ parseJson: true });

        function handleSSEEvent(sseEvt) {
          if (failed) return;
          if (sseEvt.rawData) rawOutput.push(sseEvt.rawData);
          let chunks;
          try {
            chunks = session.consumeSSEEvent
              ? session.consumeSSEEvent(sseEvt)
              : session.processEvent(sseEvt);
          } catch (err) {
            failed = true;
            res.off('close', onClientClose);
            watchdog?.clear();
            apiReq.destroy();
            const rawMsg = err?.message || String(err);
            const safeMsg = conn.format === 'gemini' ? redactGeminiCredential(rawMsg, conn.apiKey) : rawMsg;
            resolve({ kind: 'terminal-error', reason: safeMsg, code: 'unavailable', message: `BYOK 上游流错误：${conn.providerName} / ${resolvedModel}（${clampText(safeMsg, 120)}）。` });
            return;
          }
          protoChunks.push(...chunks);
        }

        apiRes.on('data', (chunk) => {
          if (failed) return;
          for (const sseEvt of sseParser.push(chunk)) {
            handleSSEEvent(sseEvt);
            if (failed) break;
          }
        });

        apiRes.on('end', () => {
          res.off('close', onClientClose);
          if (failed) return;
          for (const sseEvt of sseParser.flush()) {
            handleSSEEvent(sseEvt);
            if (failed) return;
          }
          failed = true;
          watchdog?.clear();
          const processor = session.activeProcessor();
          if (!processor.isDone) {
            if (session.canFlushOnEof?.()) {
              protoChunks.push(...session.processEvent(session.finishPayload()));
            } else {
              const reason = `upstream stream ended before ${session.doneExpectedMessage()}`;
              resolve({
                kind: 'terminal-error',
                reason,
                code: 'unavailable',
                message: `BYOK 上游流提前中断：${conn.providerName} / ${resolvedModel}（未收到结束标志 ${session.doneExpectedMessage()}）。`,
              });
              return;
            }
          }
          resolve({
            kind: 'success',
            format: session.doneFormat(),
            requestUrl: spec.requestUrl,
            streamStartedAt,
            rawOutput,
            protoChunks,
            processor,
            toolCalls: processor.toolCalls,
          });
        });

        apiRes.on('error', (err) => {
          res.off('close', onClientClose);
          if (failed) return;
          failed = true;
          watchdog?.clear();
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
        res.off('close', onClientClose);
        if (failed) return;
        failed = true;
        watchdog?.clear();
        resolve({
          kind: streamStarted ? 'terminal-error' : 'failover',
          reason: err.message,
          meta: { code: err.code },
          code: 'unavailable',
          message: `BYOK 连接上游失败：${conn.providerName} / ${resolvedModel}（${clampText(err.message, 120)}）。请检查网络、代理和 API Host。`,
        });
      });

      watchdog = attachUpstreamWatchdog(apiReq, { label: spec.watchdogLabel, ttfbMs: ttfbMsFromEnhancement(enhancement) });
      apiReq.end(spec.finalBody);
    });
  });
}

export function requestAnthropicBuffered(req, res, opts) {
  return runBufferedUpstream(req, res, opts, buildAnthropicUpstreamSpec);
}

export function requestGeminiBuffered(req, res, opts) {
  return runBufferedUpstream(req, res, opts, buildGeminiUpstreamSpec);
}

export function requestOpenAIBuffered(req, res, opts) {
  return runBufferedUpstream(req, res, opts, selectOpenAISpecBuilder(opts.conn, true));
}

export async function streamAnthropic(req, res, opts) {
  return runStreamingUpstream(req, res, opts, buildAnthropicUpstreamSpec);
}

export async function streamGemini(req, res, opts) {
  return runStreamingUpstream(req, res, opts, buildGeminiUpstreamSpec);
}

export async function streamOpenAI(req, res, opts) {
  return runStreamingUpstream(req, res, opts, selectOpenAISpecBuilder(opts.conn, false));
}

export async function streamOpenAIChatCompletions(req, res, opts) {
  return runStreamingUpstream(req, res, opts, buildOpenAIChatUpstreamSpec);
}

export function requestOpenAIResponsesBuffered(req, res, opts) {
  return runBufferedUpstream(req, res, opts, buildOpenAIResponsesUpstreamSpec);
}

export function requestOpenAIChatCompletionsBuffered(req, res, opts) {
  return runBufferedUpstream(req, res, opts, buildOpenAIChatUpstreamSpec);
}
