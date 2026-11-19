// cursor-proxy.js - Experimental Cursor MITM handlers (entry & route orchestrator).

import { endOfStreamEnvelope, endOfStreamErrorEnvelope } from './connect.js';
import { execute as executeLocalProxy } from './local-proxy.js';
import {
  buildBugBotErrorResponse,
  handleBackgroundAddFollowup,
  handleBackgroundAttach,
  handleBackgroundInteractionUpdates,
  handleBackgroundStatus,
  handleBugBotRunSSE,
  writeBugBotFrame,
} from './lib/cursor/background-and-bugbot.js';
import {
  API2_HOSTS,
  AUTH_HOSTS,
  CURSOR_TOOL_LOOP_MAX_ROUNDS,
  CURSOR_TURN_MAX_MS,
  PATHS,
  RUNSSE_KEEPALIVE_MS,
  cursorErrorMessage,
  decodeCursorPayloads,
  isCursorHost,
  mergeUsage,
  requestHost,
  requestPath,
  respond404,
  respondJson,
  respondProto,
  responseObjToolCalls,
  textChunks,
  usageTokens,
} from './lib/cursor/common.js';
import { deliverInteractionResponse, deliverToolResult } from './lib/cursor/exec-waits.js';
import { parseBidiAppend, parseBidiRequestID, parseWriteGitCommitMessageRequest } from './lib/cursor/proto-parsers.js';
import {
  buildAvailableModelsResponse,
  buildCommitMessagePrompt,
  buildDefaultModelNudgeResponse,
  buildWriteGitCommitMessageResponse,
  sanitizeCommitMessage,
} from './lib/cursor/service-proto-builders.js';
import {
  cursorAdapters,
  dropSession,
  persistCursorTurnArtifacts,
  recordConversationTurn,
  rememberSession,
  resolveCursorAdapter,
  selectedModelFromSession,
  textPart,
  waitForSession,
} from './lib/cursor/stores.js';
import {
  buildAssistantInputItem,
  buildCursorInitialInput,
  buildFunctionCallInputItem,
  buildFunctionCallOutputInputItem,
  buildLocalProxyContext,
  prepareToolOutputForModel,
  writeStreamingResult,
} from './lib/cursor/streaming.js';
import { buildCursorProxyTestExports } from './lib/cursor/test-bridge.js';
import { executeCursorToolCall } from './lib/cursor/tool-executors-dispatch.js';
import {
  buildTextDeltaFrame,
  buildTokenDeltaFrame,
  buildTurnEndedFrame,
  startRunSseResponse,
  writeRunFrame,
} from './lib/cursor/tool-proto-builders.js';

export { isCursorHost };

function handleAvailableModels(res) {
  const models = cursorAdapters();
  if (!models.length) {
    respondJson(res, 503, {
      error: 'no_cursor_models',
      message: 'No enabled OpenAI-format proxy routes are configured for Cursor.',
    });
    return;
  }
  respondProto(res, buildAvailableModelsResponse(models));
}

function handleDefaultModelNudge(res) {
  const models = cursorAdapters();
  if (!models.length) {
    respondJson(res, 503, {
      error: 'no_cursor_models',
      message: 'No enabled OpenAI-format proxy routes are configured for Cursor.',
    });
    return;
  }
  respondProto(res, buildDefaultModelNudgeResponse(models));
}

function handleBidiAppend(req, res, body, log) {
  const messages = decodeCursorPayloads(body, req.headers).map(parseBidiAppend);
  for (const msg of messages) {
    if (msg.requestID) rememberSession(msg);
    if (msg.userText) {
      log(`Cursor BidiAppend request_id=${msg.requestID || '(missing)'} mode=${msg.mode} model=${selectedModelFromSession(msg) || '(none)'} text=${JSON.stringify(msg.userText.slice(0, 160))}`);
    } else if (msg.execClientMessage) {
      const delivered = deliverToolResult(msg.execClientMessage);
      log(`Cursor BidiAppend request_id=${msg.requestID || '(missing)'} exec_result type=${msg.execClientMessage.resultType} exec_id=${msg.execClientMessage.execID || '(none)'} seq=${msg.execClientMessage.id || 0} delivered=${delivered}`);
    } else if (msg.interactionResponse) {
      const delivered = deliverInteractionResponse(msg.interactionResponse);
      log(`Cursor BidiAppend request_id=${msg.requestID || '(missing)'} interaction_response type=${msg.interactionResponse.type || 'unknown'} id=${msg.interactionResponse.id || 0} delivered=${delivered}`);
    } else {
      log(`Cursor BidiAppend request_id=${msg.requestID || '(missing)'} type=${msg.agentMessageType || 'empty'} bytes=${msg.dataBytes || 0}`);
    }
  }
  respondProto(res, Buffer.alloc(0));
}

async function handleWriteGitCommitMessage(req, res, body, log) {
  const payloads = decodeCursorPayloads(body, req.headers);
  const payload = payloads[0] || Buffer.alloc(0);
  const commitReq = parseWriteGitCommitMessageRequest(payload);
  const adapter = resolveCursorAdapter('');
  log(`Cursor WriteGitCommitMessage route=${adapter.id} diffs=${commitReq.diffs.length} previous=${commitReq.previousCommitMessages.length}`);
  const prompt = buildCommitMessagePrompt(commitReq);
  const result = await executeLocalProxy({
    client: 'cursor',
    kind: 'openai',
    model: adapter.id,
    system: [
      'Write a concise conventional commit message.',
      'Default to a single subject line in the form type: summary, where type is usually feat, fix, refactor, docs, chore, or test.',
      'Add a body only if absolutely necessary.',
      'Return only the commit message text.',
    ].join('\n'),
    messages: [{ role: 'user', content: [textPart(prompt)] }],
    tools: [],
    toolChoice: null,
    stream: false,
    maxTokens: 120,
    rawBody: null,
  });
  const message = sanitizeCommitMessage(result?.text);
  respondProto(res, buildWriteGitCommitMessageResponse(message));
}

async function handleRunSSE(req, res, body, log) {
  startRunSseResponse(res);
  let keepalive = null;
  let requestID = '';
  try {
    const payloads = decodeCursorPayloads(body, req.headers);
    requestID = payloads.length ? parseBidiRequestID(payloads[0]) : '';
    if (!requestID) throw new Error('Cursor RunSSE request is missing request_id');

    keepalive = setInterval(() => {
      try {
        writeRunFrame(res, buildTokenDeltaFrame(0));
      } catch (err) {
        log(`Cursor RunSSE keepalive failed: ${err.message || String(err)}`);
        clearInterval(keepalive);
      }
    }, RUNSSE_KEEPALIVE_MS);
    if (typeof keepalive.unref === 'function') keepalive.unref();

    const sessionHit = await waitForSession(requestID);
    const sess = sessionHit?.session || null;
    if (!sess?.userText) {
      throw new Error(`No Cursor BidiAppend session/user text for request_id=${requestID}`);
    }
    if (sess.sessionType === 'bugbot') {
      throw new Error(`Cursor RunSSE received BugBot session for request_id=${requestID}; expected StreamBugBotAgenticSSE`);
    }
    if (sessionHit.reason && sessionHit.reason !== 'exact') {
      log(`Cursor RunSSE request_id=${requestID} using session fallback=${sessionHit.reason} conversation=${sess.conversationID || '(none)'} from=${sess.fallbackFromRequestID || '(none)'}`);
    }

    const selectedModel = selectedModelFromSession(sess);
    const adapter = resolveCursorAdapter(selectedModel);
    log(`Cursor RunSSE request_id=${requestID} session=found cursor_model=${selectedModel || '(default)'} route=${adapter.id}`);

    const initial = buildCursorInitialInput(sess);
    const inputItems = [...initial.input];
    let text = '';
    let usage = null;
    let completed = false;
    const startedAt = Date.now();
    const allToolCalls = [];
    const requestBodies = [];
    for (let round = 0; round < CURSOR_TOOL_LOOP_MAX_ROUNDS; round++) {
      if (Date.now() - startedAt > CURSOR_TURN_MAX_MS) {
        throw new Error(`Cursor RunSSE exceeded turn time limit (${CURSOR_TURN_MAX_MS}ms)`);
      }
      const ctx = buildLocalProxyContext(sess, adapter, inputItems);
      requestBodies.push(ctx.rawBody);
      const result = await executeLocalProxy(ctx);
      let roundText = '';
      let roundUsage = null;
      let toolCalls = [];
      if (result?.stream === true) {
        log(`Cursor RunSSE request_id=${requestID} route=${adapter.id} round=${round + 1} streaming upstream response`);
        const streamed = await writeStreamingResult(res, result);
        if (streamed.disconnected) return;
        roundText = streamed.assistantText;
        roundUsage = streamed.usage;
        toolCalls = streamed.toolCalls || [];
      } else {
        log(`Cursor RunSSE request_id=${requestID} route=${adapter.id} round=${round + 1} upstream stream unavailable; writing complete text response`);
        roundText = String(result?.text || '');
        roundUsage = result?.usage || null;
        toolCalls = responseObjToolCalls(result?.responseObj);
        for (const chunk of textChunks(roundText)) {
          if (!writeRunFrame(res, buildTextDeltaFrame(chunk))) return;
        }
      }
      text += roundText;
      usage = mergeUsage(usage, roundUsage);
      if (!toolCalls.length) {
        completed = true;
        break;
      }

      log(`Cursor RunSSE request_id=${requestID} route=${adapter.id} round=${round + 1} tool_calls=${toolCalls.map(tc => tc.name).join(',')}`);
      allToolCalls.push(...toolCalls);
      if (roundText) inputItems.push(buildAssistantInputItem(roundText));
      for (const tc of toolCalls) {
        inputItems.push(buildFunctionCallInputItem(tc));
      }
      for (const tc of toolCalls) {
        const output = prepareToolOutputForModel(tc, await executeCursorToolCall(res, tc, log, sess));
        inputItems.push(buildFunctionCallOutputInputItem(tc, output));
      }
    }
    if (!completed) {
      throw new Error(`Cursor RunSSE exceeded tool loop limit (${CURSOR_TOOL_LOOP_MAX_ROUNDS})`);
    }
    writeRunFrame(res, buildTokenDeltaFrame(usageTokens(usage, text)));
    writeRunFrame(res, buildTurnEndedFrame());
    recordConversationTurn(sess, text);
    persistCursorTurnArtifacts(sess, {
      kind: 'runsse',
      assistantText: text,
      usage,
      model: adapter.id,
      startedAt,
      finishedAt: Date.now(),
      toolCalls: allToolCalls,
      requestBodies,
    });
    if (!res.destroyed && !res.writableEnded) {
      res.end(endOfStreamEnvelope());
    }
  } catch (err) {
    log(`Cursor RunSSE request_id=${requestID || '(missing)'} failed: ${err.stack || err.message}`);
    if (!res.destroyed && !res.writableEnded) {
      res.end(endOfStreamErrorEnvelope({
        code: 'internal',
        message: cursorErrorMessage(err),
      }));
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    if (requestID) dropSession(requestID);
  }
}

export function handleCursorRequest(req, res, body, opts = {}) {
  const host = requestHost(req, opts.upstreamHost);
  if (!isCursorHost(host)) return false;

  const path = requestPath(req);
  const log = typeof opts.log === 'function'
    ? opts.log
    : (line) => console.log(`[cursor] ${line}`);

  if (AUTH_HOSTS.has(host)) {
    log(`${opts.source || 'proxy'} ${host}${path} -> 404`);
    respond404(res);
    return true;
  }

  if (!API2_HOSTS.has(host)) return false;

  try {
    switch (path) {
      case PATHS.availableModels:
        log(`${opts.source || 'proxy'} ${path} -> synthetic AvailableModels`);
        handleAvailableModels(res);
        return true;
      case PATHS.defaultModelNudge:
        log(`${opts.source || 'proxy'} ${path} -> synthetic default model`);
        handleDefaultModelNudge(res);
        return true;
      case PATHS.bidiAppend:
        handleBidiAppend(req, res, body, log);
        return true;
      case PATHS.writeGitCommitMessage:
        handleWriteGitCommitMessage(req, res, body, log).catch(err => {
          log(`Cursor WriteGitCommitMessage async failure: ${err.stack || err.message}`);
          if (!res.destroyed && !res.writableEnded) {
            respondJson(res, 500, {
              error: 'cursor_commit_message_error',
              message: cursorErrorMessage(err),
            });
          }
        });
        return true;
      case PATHS.streamBugBotAgenticSSE:
        handleBugBotRunSSE(req, res, body, log).catch(err => {
          log(`Cursor BugBot async failure: ${err.stack || err.message}`);
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) startRunSseResponse(res);
            writeBugBotFrame(res, buildBugBotErrorResponse(cursorErrorMessage(err)));
            res.end(endOfStreamEnvelope());
          }
        });
        return true;
      case PATHS.backgroundAddFollowup:
        handleBackgroundAddFollowup(req, res, body, log);
        return true;
      case PATHS.backgroundStatus:
        handleBackgroundStatus(req, res, body, log);
        return true;
      case PATHS.backgroundAttach:
        handleBackgroundAttach(req, res, body, log).catch(err => {
          log(`Cursor BackgroundComposer attach async failure: ${err.stack || err.message}`);
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) startRunSseResponse(res);
            res.end(endOfStreamErrorEnvelope({
              code: 'internal',
              message: cursorErrorMessage(err),
            }));
          }
        });
        return true;
      case PATHS.backgroundInteractionUpdates:
        handleBackgroundInteractionUpdates(req, res, body, log);
        return true;
      case PATHS.runSSE:
        handleRunSSE(req, res, body, log).catch(err => {
          log(`Cursor RunSSE async failure: ${err.stack || err.message}`);
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) startRunSseResponse(res);
            res.end(endOfStreamErrorEnvelope({
              code: 'internal',
              message: cursorErrorMessage(err),
            }));
          }
        });
        return true;
      default:
        log(`${opts.source || 'proxy'} ${path} -> 404`);
        respond404(res);
        return true;
    }
  } catch (err) {
    log(`${path} failed: ${err.stack || err.message}`);
    respondJson(res, 500, {
      error: 'cursor_proxy_error',
      message: err.message || String(err),
    });
    return true;
  }
}

export const __cursorProxyTest = buildCursorProxyTestExports();
