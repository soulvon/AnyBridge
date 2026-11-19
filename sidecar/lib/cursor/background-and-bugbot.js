// sidecar/lib/cursor/background-and-bugbot.js — Cursor BackgroundComposer 与 BugBot Agentic SSE 处理器

import { endOfStreamEnvelope } from '../../connect.js';
import { execute as executeLocalProxy } from '../../local-proxy.js';
import {
  BACKGROUND_STATUS_CREATING,
  BACKGROUND_STATUS_ERROR,
  BACKGROUND_STATUS_FINISHED,
  BACKGROUND_STATUS_RUNNING,
  BUGBOT_STATUS_DONE,
  BUGBOT_STATUS_ERROR,
  BUGBOT_STATUS_IN_PROGRESS,
  BUGBOT_STATUS_IN_PROGRESS_ITERATIONS,
  CURSOR_TOOL_LOOP_MAX_ROUNDS,
  CURSOR_TURN_MAX_MS,
  RUNSSE_KEEPALIVE_MS,
  cursorErrorMessage,
  decodeCursorPayloads,
  mergeUsage,
  respondProto,
  responseObjToolCalls,
  textChunks,
} from './common.js';
import {
  parseAddBackgroundComposerRequest,
  parseAttachBackgroundComposerRequest,
  parseBidiRequestID,
  parseGetBackgroundComposerStatusRequest,
} from './proto-parsers.js';
import {
  backgroundPromptText,
  buildAttachBackgroundComposerResponse,
  buildBugBotResponse,
  buildBugBotServerMessage,
  buildGetBackgroundComposerStatusResponse,
  parseBugBotModelResponse,
} from './service-proto-builders.js';
import {
  dropSession,
  getBackgroundComposer,
  persistCursorTurnArtifacts,
  recordConversationTurn,
  resolveCursorAdapter,
  saveBackgroundComposer,
  selectedModelFromSession,
  textPart,
  waitForSession,
} from './stores.js';
import {
  buildAssistantInputItem,
  buildFunctionCallInputItem,
  buildFunctionCallOutputInputItem,
  buildLocalProxyContext,
  consumeCursorUpstreamStream,
  prepareToolOutputForModel,
  writeBackgroundFrame,
} from './streaming.js';
import { executeCursorToolCall } from './tool-executors-dispatch.js';
import {
  buildBackgroundInteractionHeartbeatFrame,
  startRunSseResponse,
  writeRunFrame,
} from './tool-proto-builders.js';

export function handleBackgroundAddFollowup(req, res, body, log) {
  const payloads = decodeCursorPayloads(body, req.headers);
  const state = parseAddBackgroundComposerRequest(payloads[0] || Buffer.alloc(0));
  state.status = BACKGROUND_STATUS_CREATING;
  state.createdAt = Date.now();
  state.updates = [];
  state.streamDone = false;
  state.streaming = false;
  saveBackgroundComposer(state);
  log(`Cursor BackgroundComposer add bc_id=${state.bcID} model=${state.modelDetails?.modelName || '(default)'}`);
  respondProto(res, Buffer.alloc(0));
}

export function handleBackgroundStatus(req, res, body, log) {
  const payloads = decodeCursorPayloads(body, req.headers);
  const statusReq = parseGetBackgroundComposerStatusRequest(payloads[0] || Buffer.alloc(0));
  const state = getBackgroundComposer(statusReq.bcID);
  const status = state?.status || 0;
  log(`Cursor BackgroundComposer status bc_id=${statusReq.bcID || '(missing)'} status=${status}`);
  respondProto(res, buildGetBackgroundComposerStatusResponse(status));
}

export async function writeBackgroundStreamingResult(res, state, result) {
  const emitChunk = (text) => {
    const frame = buildAttachBackgroundComposerResponse({
      state,
      text,
      status: BACKGROUND_STATUS_RUNNING,
    });
    return writeBackgroundFrame(res, state, frame);
  };
  return consumeCursorUpstreamStream(res, result, {
    onThinking: emitChunk,
    onText: emitChunk,
  });
}

async function runBackgroundComposer(state, res, log) {
  state.streaming = true;
  state.status = BACKGROUND_STATUS_RUNNING;
  saveBackgroundComposer(state);
  const startFrame = buildAttachBackgroundComposerResponse({
    state,
    status: BACKGROUND_STATUS_RUNNING,
    includePrompt: true,
  });
  if (!writeBackgroundFrame(res, state, startFrame)) return;

  try {
    const adapter = resolveCursorAdapter(state.modelDetails?.modelName || '');
    const prompt = backgroundPromptText(state);
    log(`Cursor BackgroundComposer attach bc_id=${state.bcID} route=${adapter.id}`);
    const sess = {
      requestID: state.bcID,
      conversationID: state.bcID,
      userText: prompt,
      mode: 'agent',
      modelDetails: state.modelDetails || {},
      requestedModel: { modelId: state.modelDetails?.modelName || '' },
    };
    const inputItems = [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    }];
    let completed = false;
    let text = '';
    let usage = null;
    const allToolCalls = [];
    const requestBodies = [];
    const startedAt = Date.now();
    for (let round = 0; round < CURSOR_TOOL_LOOP_MAX_ROUNDS; round++) {
      if (Date.now() - startedAt > CURSOR_TURN_MAX_MS) {
        throw new Error(`Cursor BackgroundComposer exceeded turn time limit (${CURSOR_TURN_MAX_MS}ms)`);
      }
      const ctx = buildLocalProxyContext(sess, adapter, inputItems);
      requestBodies.push(ctx.rawBody);
      const result = await executeLocalProxy(ctx);
      let roundText = '';
      let roundUsage = null;
      let toolCalls = [];
      if (result?.stream === true) {
        const streamed = await writeBackgroundStreamingResult(res, state, result);
        if (streamed.disconnected) return;
        roundText = streamed.assistantText;
        roundUsage = streamed.usage;
        toolCalls = streamed.toolCalls || [];
      } else {
        roundText = String(result?.text || '');
        roundUsage = result?.usage || null;
        toolCalls = responseObjToolCalls(result?.responseObj);
        for (const chunk of textChunks(roundText)) {
          const frame = buildAttachBackgroundComposerResponse({
            state,
            text: chunk,
            status: BACKGROUND_STATUS_RUNNING,
          });
          if (!writeBackgroundFrame(res, state, frame)) return;
        }
      }
      text += roundText;
      usage = mergeUsage(usage, roundUsage);
      state.lastText = text;
      if (roundText) inputItems.push(buildAssistantInputItem(roundText));
      if (!toolCalls.length) {
        completed = true;
        break;
      }
      allToolCalls.push(...toolCalls);
      log(`Cursor BackgroundComposer bc_id=${state.bcID} route=${adapter.id} round=${round + 1} tool_calls=${toolCalls.map(tc => tc.name).join(',')}`);
      for (const tc of toolCalls) {
        inputItems.push(buildFunctionCallInputItem(tc));
      }
      for (const tc of toolCalls) {
        const notice = buildAttachBackgroundComposerResponse({
          state,
          text: `\n\nRunning ${tc.name}...\n`,
          status: BACKGROUND_STATUS_RUNNING,
        });
        if (!writeBackgroundFrame(res, state, notice)) return;
        const output = prepareToolOutputForModel(tc, await executeCursorToolCall(res, tc, log, sess));
        inputItems.push(buildFunctionCallOutputInputItem(tc, output));
      }
    }
    if (!completed) {
      throw new Error(`Cursor BackgroundComposer exceeded tool loop limit (${CURSOR_TOOL_LOOP_MAX_ROUNDS})`);
    }
    state.status = BACKGROUND_STATUS_FINISHED;
    state.streamDone = true;
    recordConversationTurn(sess, text || '[background composer completed]');
    persistCursorTurnArtifacts(sess, {
      kind: 'background_composer',
      assistantText: text || '[background composer completed]',
      usage,
      model: adapter.id,
      startedAt,
      finishedAt: Date.now(),
      toolCalls: allToolCalls,
      requestBodies,
    });
    saveBackgroundComposer(state);
    const doneFrame = buildAttachBackgroundComposerResponse({
      state,
      done: true,
      status: BACKGROUND_STATUS_FINISHED,
      statusMessage: 'Completed',
      complete: true,
    });
    writeBackgroundFrame(res, state, doneFrame);
    if (!res.destroyed && !res.writableEnded) res.end(endOfStreamEnvelope());
  } catch (err) {
    state.status = BACKGROUND_STATUS_ERROR;
    state.lastError = cursorErrorMessage(err);
    state.streamDone = true;
    saveBackgroundComposer(state);
    const errorFrame = buildAttachBackgroundComposerResponse({
      state,
      error: state.lastError,
      done: true,
      status: BACKGROUND_STATUS_ERROR,
    });
    writeBackgroundFrame(res, state, errorFrame);
    if (!res.destroyed && !res.writableEnded) res.end(endOfStreamEnvelope());
  }
}

export async function handleBackgroundAttach(req, res, body, log) {
  startRunSseResponse(res);
  const payloads = decodeCursorPayloads(body, req.headers);
  const attachReq = parseAttachBackgroundComposerRequest(payloads[0] || Buffer.alloc(0));
  const state = getBackgroundComposer(attachReq.bcID);
  if (!state) {
    const frame = buildAttachBackgroundComposerResponse({
      error: `unknown background composer: ${attachReq.bcID || '(missing)'}`,
      done: true,
      status: BACKGROUND_STATUS_ERROR,
    });
    writeRunFrame(res, frame);
    res.end(endOfStreamEnvelope());
    return;
  }

  const start = Math.max(0, Number(attachReq.startingIndex) || 0);
  if (start > 0 || state.streaming) {
    for (const frame of state.updates.slice(start)) {
      if (!writeRunFrame(res, frame)) return;
    }
    if (!res.destroyed && !res.writableEnded) {
      res.end(endOfStreamEnvelope());
    }
    return;
  }

  await runBackgroundComposer(state, res, log);
}

export function handleBackgroundInteractionUpdates(req, res, body, log) {
  startRunSseResponse(res);
  log('Cursor BackgroundComposer interaction updates heartbeat stream');
  writeRunFrame(res, buildBackgroundInteractionHeartbeatFrame());
  if (!res.destroyed && !res.writableEnded) {
    res.end(endOfStreamEnvelope());
  }
}

export function writeBugBotFrame(res, response) {
  return writeRunFrame(res, buildBugBotServerMessage(response));
}

export function buildBugBotErrorResponse(message) {
  const text = String(message || 'Cursor BugBot failed');
  return buildBugBotResponse({
    status: BUGBOT_STATUS_ERROR,
    message: text,
    summary: text,
  });
}

export async function handleBugBotRunSSE(req, res, body, log) {
  startRunSseResponse(res);
  let keepalive = null;
  let requestID = '';
  try {
    const payloads = decodeCursorPayloads(body, req.headers);
    requestID = payloads.length ? parseBidiRequestID(payloads[0]) : '';
    if (!requestID) throw new Error('Cursor BugBot request is missing request_id');

    const sessionHit = await waitForSession(requestID);
    const sess = sessionHit?.session || null;
    if (!sess?.bugBotRequest || sess.sessionType !== 'bugbot') {
      throw new Error(`No Cursor BugBot BidiAppend session for request_id=${requestID}`);
    }

    keepalive = setInterval(() => {
      try {
        writeBugBotFrame(res, buildBugBotResponse({
          status: BUGBOT_STATUS_IN_PROGRESS,
          message: 'Review in progress',
        }));
      } catch (err) {
        log(`Cursor BugBot keepalive failed: ${err.message || String(err)}`);
        clearInterval(keepalive);
      }
    }, RUNSSE_KEEPALIVE_MS);
    if (typeof keepalive.unref === 'function') keepalive.unref();

    const selectedModel = selectedModelFromSession(sess);
    const adapter = resolveCursorAdapter(selectedModel);
    log(`Cursor BugBot request_id=${requestID} route=${adapter.id} files=${sess.bugBotRequest.gitDiff?.diffs?.length || 0}`);

    writeBugBotFrame(res, buildBugBotResponse({
      status: BUGBOT_STATUS_IN_PROGRESS_ITERATIONS,
      message: 'Review iteration 1',
      iterationsCompleted: 1,
      totalIterations: 1,
      numTurns: 1,
    }));

    const result = await executeLocalProxy({
      client: 'cursor',
      kind: 'openai',
      model: adapter.id,
      system: [
        'You are Cursor BugBot running through AnyBridge Cursor BYOK.',
        'Find only real bugs, regressions, or correctness issues in the provided diff.',
        'Native Cursor tools are not bridged in this build; do not claim file reads, edits, commands, or MCP calls.',
        'Return exactly NO_ISSUES when there are no concrete issues.',
        'Otherwise return JSON only: {"summary":"...","bugs":[{"title":"...","description":"...","severity":"low|medium|high|critical","rationale":"...","file":"path","start_line":1,"end_line":1}]}',
      ].join('\n'),
      messages: [{ role: 'user', content: [textPart(sess.userText)] }],
      tools: [],
      toolChoice: null,
      stream: false,
      maxTokens: 4096,
      rawBody: null,
    });
    const text = String(result?.text || '').trim();
    const parsed = parseBugBotModelResponse(text);
    const message = parsed.reports.length ? `Found ${parsed.reports.length} issue(s)` : 'No issues found';
    writeBugBotFrame(res, buildBugBotResponse({
      reports: parsed.reports,
      status: BUGBOT_STATUS_DONE,
      message,
      summary: parsed.summary,
      iterationsCompleted: 1,
      totalIterations: 1,
      numTurns: 1,
    }));
    if (!res.destroyed && !res.writableEnded) res.end(endOfStreamEnvelope());
  } catch (err) {
    log(`Cursor BugBot request_id=${requestID || '(missing)'} failed: ${err.stack || err.message}`);
    if (!res.destroyed && !res.writableEnded) {
      writeBugBotFrame(res, buildBugBotErrorResponse(cursorErrorMessage(err)));
      res.end(endOfStreamEnvelope());
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    if (requestID) dropSession(requestID);
  }
}
