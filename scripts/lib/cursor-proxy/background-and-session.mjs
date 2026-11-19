import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getField,
  parseFields,
  writeMessageField,
  writeStringField,
  writeVarintField,
} from '../../../sidecar/proto.js';
import {
  makeReq,
  makeRes,
  protoConcat,
  readEnvelope,
  stableModelID,
  writeProxyRoutes,
} from './harness.mjs';
export async function runBackgroundAndSessionChecks({ tmp, __cursorProxyTest, handleCursorRequest }) {
  __cursorProxyTest.resetBackgroundComposersForTest();
  const addBackgroundBody = Buffer.concat([
    writeStringField(1, 'bc-smoke'),
    writeStringField(2, 'continue smoke task'),
    writeStringField(4, '<p>continue smoke task</p>'),
    writeMessageField(6, writeStringField(1, stableModelID('cursor-smoke-route'))),
  ]);
  const addBackground = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BackgroundComposerService/AddAsyncFollowupBackgroundComposer'),
    addBackground,
    addBackgroundBody,
    { log: () => {} },
  ), true);
  assert.equal(addBackground.statusCode, 200);
  assert.equal(addBackground.headers['content-type'], 'application/proto');
  assert.equal(addBackground.body().length, 0);

  const backgroundStatus = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BackgroundComposerService/GetBackgroundComposerStatus'),
    backgroundStatus,
    writeStringField(1, 'bc-smoke'),
    { log: () => {} },
  ), true);
  assert.equal(backgroundStatus.statusCode, 200);
  assert.equal(getField(parseFields(backgroundStatus.body()), 1, 0).value, 4);

  const backgroundReq = __cursorProxyTest.parseAddBackgroundComposerRequest(addBackgroundBody);
  assert.equal(backgroundReq.bcID, 'bc-smoke');
  assert.equal(backgroundReq.followup, 'continue smoke task');
  assert.equal(backgroundReq.richFollowup, '<p>continue smoke task</p>');
  assert.equal(backgroundReq.modelDetails.modelName, stableModelID('cursor-smoke-route'));

  const attachReq = __cursorProxyTest.parseAttachBackgroundComposerRequest(Buffer.concat([
    writeStringField(1, 'bc-smoke'),
  ]));
  assert.equal(attachReq.bcID, 'bc-smoke');

  const attachFrame = parseFields(__cursorProxyTest.buildAttachBackgroundComposerResponse({
    state: backgroundReq,
    text: 'background text',
    done: true,
    status: 2,
    includePrompt: true,
    statusMessage: 'Completed',
    complete: true,
  }));
  assert.equal(getField(attachFrame, 6, 0).value, 2);
  const headless = parseFields(getField(attachFrame, 1, 2).value);
  assert.equal(getField(headless, 1, 2).value.toString('utf8'), 'background text');
  assert.equal(getField(headless, 5, 0).value, 1);
  const prompt = parseFields(getField(attachFrame, 2, 2).value);
  assert.equal(getField(prompt, 1, 2).value.toString('utf8'), 'continue smoke task');

  const explicitContext = Buffer.concat([
    writeStringField(1, 'Use imperative mood.'),
    writeStringField(2, 'AnyBridge desktop app'),
    writeStringField(4, 'Commit from Source Control panel'),
  ]);
  const commitReqBody = Buffer.concat([
    writeStringField(1, 'diff --git a/a.txt b/a.txt\n+hello cursor\n'),
    writeStringField(2, 'fix: keep proxy stable'),
    writeMessageField(3, explicitContext),
  ]);
  const commitReq = __cursorProxyTest.parseWriteGitCommitMessageRequest(commitReqBody);
  assert.deepEqual(commitReq.diffs, ['diff --git a/a.txt b/a.txt\n+hello cursor\n']);
  assert.deepEqual(commitReq.previousCommitMessages, ['fix: keep proxy stable']);
  assert.equal(commitReq.explicitContext.context, 'Use imperative mood.');
  assert.equal(commitReq.explicitContext.repoContext, 'AnyBridge desktop app');
  assert.equal(commitReq.explicitContext.modeSpecificContext, 'Commit from Source Control panel');

  const commitResp = parseFields(__cursorProxyTest.buildWriteGitCommitMessageResponse('fix: support cursor byok'));
  assert.equal(getField(commitResp, 1, 2).value.toString('utf8'), 'fix: support cursor byok');

  function interactionUpdate(frame) {
    const agent = parseFields(frame);
    return parseFields(getField(agent, 1, 2).value);
  }

  const textUpdate = interactionUpdate(__cursorProxyTest.buildTextDeltaFrame('hello'));
  assert.equal(getField(parseFields(getField(textUpdate, 1, 2).value), 1, 2).value.toString('utf8'), 'hello');

  const thinkingUpdate = interactionUpdate(__cursorProxyTest.buildThinkingDeltaFrame('plan'));
  assert.equal(getField(parseFields(getField(thinkingUpdate, 4, 2).value), 1, 2).value.toString('utf8'), 'plan');

  const tokenUpdate = interactionUpdate(__cursorProxyTest.buildTokenDeltaFrame(7));
  assert.equal(getField(parseFields(getField(tokenUpdate, 8, 2).value), 1, 0).value, 7);

  const turnEndedUpdate = interactionUpdate(__cursorProxyTest.buildTurnEndedFrame());
  assert.equal(getField(turnEndedUpdate, 14, 2).value.length, 0);

  __cursorProxyTest.resetPlanStoreForTest();
  const planSession = {
    requestID: 'plan-req',
    conversationID: 'plan-conv',
    userText: 'make a plan',
    mode: 'plan',
  };
  const planRes = makeRes();
  const planOutput = JSON.parse(await __cursorProxyTest.executeLocalPlanTool(planRes, planSession, {
    id: 'call-plan-1',
    name: 'CreatePlan',
    arguments: JSON.stringify({
      name: 'Cursor smoke plan',
      overview: 'Verify local plan tools.',
      todos: ['Inspect protocol', 'Patch proxy'],
    }),
  }));
  assert.equal(planOutput.result, 'ok');
  assert.equal(planOutput.todos[0].id, 't1');
  let planEnv = readEnvelope(planRes.body());
  let planUpdate = interactionUpdate(planEnv.payload);
  let planStarted = parseFields(getField(planUpdate, 2, 2).value);
  let createPlanTool = parseFields(getField(planStarted, 2, 2).value);
  assert.ok(getField(createPlanTool, 17, 2));
  planEnv = readEnvelope(planRes.body(), planEnv.next);
  const planQuery = parseFields(getField(parseFields(planEnv.payload), 7, 2).value);
  const createPlanQuery = parseFields(getField(planQuery, 7, 2).value);
  assert.equal(getField(createPlanQuery, 2, 2).value.toString('utf8'), 'call-plan-1');
  planEnv = readEnvelope(planRes.body(), planEnv.next);
  planUpdate = interactionUpdate(planEnv.payload);
  const planCompleted = parseFields(getField(planUpdate, 3, 2).value);
  createPlanTool = parseFields(getField(planCompleted, 2, 2).value);
  const completedCreatePlan = parseFields(getField(createPlanTool, 17, 2).value);
  assert.ok(getField(completedCreatePlan, 2, 2));
  assert.equal(planEnv.next, planRes.body().length);

  const addRes = makeRes();
  const addOutput = JSON.parse(await __cursorProxyTest.executeLocalPlanTool(addRes, planSession, {
    id: 'call-add-1',
    name: 'AddTodo',
    arguments: JSON.stringify({ content: 'Run smoke tests' }),
  }));
  assert.equal(addOutput.id, 't3');
  assert.equal(__cursorProxyTest.planStateFor('plan-conv').todos.length, 3);
  const addStarted = interactionUpdate(readEnvelope(addRes.body()).payload);
  assert.ok(getField(parseFields(getField(addStarted, 2, 2).value), 2, 2));

  const updateRes = makeRes();
  const updateOutput = JSON.parse(await __cursorProxyTest.executeLocalPlanTool(updateRes, planSession, {
    id: 'call-update-1',
    name: 'UpdateTodo',
    arguments: JSON.stringify({ id: 't1', status: 'completed' }),
  }));
  assert.equal(updateOutput.id, 't1');
  assert.equal(__cursorProxyTest.planStateFor('plan-conv').todos[0].status, 'completed');

  const switchRes = makeRes();
  const switchPromise = __cursorProxyTest.executeCursorToolCall(switchRes, {
    id: 'call-switch-1',
    name: 'SwitchMode',
    arguments: JSON.stringify({ target_mode_id: 'debug', explanation: 'Investigate a failure.' }),
  }, () => {}, planSession);
  let switchEnv = readEnvelope(switchRes.body());
  let switchUpdate = interactionUpdate(switchEnv.payload);
  let switchStarted = parseFields(getField(switchUpdate, 2, 2).value);
  let switchTool = parseFields(getField(switchStarted, 2, 2).value);
  assert.ok(getField(switchTool, 25, 2));
  switchEnv = readEnvelope(switchRes.body(), switchEnv.next);
  const switchQuery = parseFields(getField(parseFields(switchEnv.payload), 7, 2).value);
  const switchQueryID = getField(switchQuery, 1, 0).value;
  assert.ok(getField(switchQuery, 4, 2));
  assert.equal(__cursorProxyTest.deliverInteractionResponse({
    id: switchQueryID,
    type: 'switch_mode',
    switchMode: { kind: 'approved' },
  }), true);
  const switchOutput = JSON.parse(await switchPromise);
  assert.equal(switchOutput.result, 'approved');
  assert.equal(switchOutput.mode, 'debug');
  assert.equal(planSession.mode, 'debug');
  switchEnv = readEnvelope(switchRes.body(), switchEnv.next);
  switchUpdate = interactionUpdate(switchEnv.payload);
  const switchCompleted = parseFields(getField(switchUpdate, 3, 2).value);
  switchTool = parseFields(getField(switchCompleted, 2, 2).value);
  assert.ok(getField(parseFields(getField(switchTool, 25, 2).value), 2, 2));
  assert.equal(switchEnv.next, switchRes.body().length);

  const localCtx = __cursorProxyTest.buildLocalProxyContext({
    requestID: 'ctx-req',
    conversationID: 'plan-conv',
    userText: 'read a file',
    mode: 'agent',
  }, { id: 'cursor-smoke-route' });
  assert.deepEqual(localCtx.rawBody.tools.map(tool => tool.function.name), [
    'Read',
    'Glob',
    'Grep',
    'Shell',
    'Write',
    'StrReplace',
    'Delete',
    'CreatePlan',
    'AddTodo',
    'UpdateTodo',
    'SwitchMode',
  ]);
  assert.equal(localCtx.rawBody.tool_choice, 'auto');
  assert.match(localCtx.rawBody.instructions, /<active_plan>/);
  assert.match(localCtx.rawBody.instructions, /\[completed\] t1: Inspect protocol/);

  const mcpDefPath = path.join(tmp, 'mcp-search-definition.json');
  fs.writeFileSync(mcpDefPath, JSON.stringify({
    description: 'Search project documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  }));
  const mcpSession = {
    requestID: 'mcp-req',
    conversationID: 'mcp-conv',
    userText: 'use mcp',
    mode: 'agent',
    mcpFileSystemOptions: {
      descriptors: [{
        serverName: 'docs',
        serverIdentifier: 'plugin-docs',
        serverUseInstructions: 'Use docs for project context.',
        tools: [{ toolName: 'search', definitionPath: mcpDefPath }],
      }],
    },
  };
  const mcpCtx = __cursorProxyTest.buildLocalProxyContext(mcpSession, { id: 'cursor-smoke-route' });
  assert.deepEqual(mcpCtx.rawBody.tools.map(tool => tool.function.name).slice(-4), [
    'ListMcpResources',
    'FetchMcpResource',
    'CallMcpTool',
    'mcp_0__search',
  ]);
  assert.match(mcpCtx.rawBody.instructions, /mcp_0__search: docs \(plugin-docs\) -> search/);

  function mcpTextResultRaw(text) {
    return writeMessageField(1, writeMessageField(1, writeMessageField(1, writeStringField(1, text))));
  }

  const mcpRes = makeRes();
  const mcpPromise = __cursorProxyTest.executeCursorToolCall(mcpRes, {
    id: 'call-mcp-1',
    name: 'mcp_0__search',
    arguments: JSON.stringify({ query: 'cursor byok' }),
  }, () => {}, mcpSession);
  let mcpEnv = readEnvelope(mcpRes.body());
  let mcpUpdate = interactionUpdate(mcpEnv.payload);
  const mcpStarted = parseFields(getField(mcpUpdate, 2, 2).value);
  assert.ok(getField(parseFields(getField(mcpStarted, 2, 2).value), 15, 2));
  mcpEnv = readEnvelope(mcpRes.body(), mcpEnv.next);
  const mcpServer = parseFields(getField(parseFields(mcpEnv.payload), 2, 2).value);
  const mcpSeq = getField(mcpServer, 1, 0).value;
  const mcpExecID = getField(mcpServer, 15, 2).value.toString('utf8');
  const mcpArgs = parseFields(getField(mcpServer, 11, 2).value);
  assert.equal(getField(mcpArgs, 1, 2).value.toString('utf8'), 'plugin-docs-search');
  assert.equal(getField(mcpArgs, 4, 2).value.toString('utf8'), 'plugin-docs');
  assert.equal(getField(mcpArgs, 5, 2).value.toString('utf8'), 'search');
  const mcpResultRaw = mcpTextResultRaw('found cursor docs');
  const mcpExecClient = __cursorProxyTest.parseExecClientMessage(protoConcat([
    writeVarintField(1, mcpSeq),
    writeMessageField(11, mcpResultRaw),
    writeStringField(15, mcpExecID),
  ]));
  assert.equal(mcpExecClient.resultType, 'mcp');
  assert.equal(mcpExecClient.mcpResult.content[0].text, 'found cursor docs');
  assert.equal(__cursorProxyTest.deliverToolResult(mcpExecClient), true);
  const mcpOutput = JSON.parse(await mcpPromise);
  assert.equal(mcpOutput.content[0].text, 'found cursor docs');
  mcpEnv = readEnvelope(mcpRes.body(), mcpEnv.next);
  mcpUpdate = interactionUpdate(mcpEnv.payload);
  const mcpCompleted = parseFields(getField(mcpUpdate, 3, 2).value);
  const mcpCompletedTool = parseFields(getField(mcpCompleted, 2, 2).value);
  assert.ok(getField(parseFields(getField(mcpCompletedTool, 15, 2).value), 2, 2));
  assert.equal(mcpEnv.next, mcpRes.body().length);

  const listRes = makeRes();
  const listPromise = __cursorProxyTest.executeCursorToolCall(listRes, {
    id: 'call-list-mcp-1',
    name: 'ListMcpResources',
    arguments: JSON.stringify({ server: 'docs' }),
  }, () => {}, mcpSession);
  let listEnv = readEnvelope(listRes.body());
  listEnv = readEnvelope(listRes.body(), listEnv.next);
  const listServer = parseFields(getField(parseFields(listEnv.payload), 2, 2).value);
  assert.ok(getField(listServer, 17, 2));
  const listResultRaw = writeMessageField(1, writeMessageField(1, protoConcat([
    writeStringField(1, 'docs://intro'),
    writeStringField(2, 'Intro'),
    writeStringField(3, 'Documentation intro'),
    writeStringField(4, 'text/plain'),
    writeStringField(5, 'docs'),
  ])));
  assert.equal(__cursorProxyTest.deliverToolResult(__cursorProxyTest.parseExecClientMessage(protoConcat([
    writeVarintField(1, getField(listServer, 1, 0).value),
    writeMessageField(17, listResultRaw),
    writeStringField(15, getField(listServer, 15, 2).value.toString('utf8')),
  ]))), true);
  const listOutput = JSON.parse(await listPromise);
  assert.equal(listOutput.resources[0].uri, 'docs://intro');

  const fetchRes = makeRes();
  const fetchPromise = __cursorProxyTest.executeCursorToolCall(fetchRes, {
    id: 'call-fetch-mcp-1',
    name: 'FetchMcpResource',
    arguments: JSON.stringify({ server: 'docs', uri: 'docs://intro' }),
  }, () => {}, mcpSession);
  let fetchEnv = readEnvelope(fetchRes.body());
  fetchEnv = readEnvelope(fetchRes.body(), fetchEnv.next);
  const fetchServer = parseFields(getField(parseFields(fetchEnv.payload), 2, 2).value);
  assert.ok(getField(fetchServer, 18, 2));
  const fetchResultRaw = writeMessageField(1, protoConcat([
    writeStringField(1, 'docs://intro'),
    writeStringField(2, 'Intro'),
    writeStringField(3, 'Documentation intro'),
    writeStringField(4, 'text/plain'),
    writeStringField(5, 'Hello MCP resource'),
  ]));
  assert.equal(__cursorProxyTest.deliverToolResult(__cursorProxyTest.parseExecClientMessage(protoConcat([
    writeVarintField(1, getField(fetchServer, 1, 0).value),
    writeMessageField(18, fetchResultRaw),
    writeStringField(15, getField(fetchServer, 15, 2).value.toString('utf8')),
  ]))), true);
  const fetchOutput = JSON.parse(await fetchPromise);
  assert.equal(fetchOutput.text, 'Hello MCP resource');

  async function* fakeToolCallSSE() {
    yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'I will inspect it. ' } }] })}\n\n`);
    yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read-1', type: 'function', function: { name: 'Read', arguments: '{"path":"' } }] } }] })}\n\n`);
    yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'src/app.js"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
    yield Buffer.from('data: [DONE]\n\n');
  }
  const streamToolRes = makeRes();
  const streamedTool = await __cursorProxyTest.writeStreamingResult(streamToolRes, {
    upstreamResponse: fakeToolCallSSE(),
  });
  assert.equal(streamedTool.assistantText, 'I will inspect it. ');
  assert.equal(streamedTool.toolCalls.length, 1);
  assert.equal(streamedTool.toolCalls[0].id, 'call-read-1');
  assert.equal(streamedTool.toolCalls[0].name, 'Read');
  assert.equal(streamedTool.toolCalls[0].arguments, '{"path":"src/app.js"}');

  const bigToolOutput = __cursorProxyTest.prepareToolOutputForModel(
    { name: 'Shell' },
    'x'.repeat(30 * 1024),
  );
  assert.match(bigToolOutput, /\[truncated: Cursor Shell tool output exceeded/);
  assert.ok(Buffer.byteLength(bigToolOutput, 'utf8') < 26 * 1024);

  const backgroundStreamState = __cursorProxyTest.parseAddBackgroundComposerRequest(addBackgroundBody);
  backgroundStreamState.updates = [];
  const backgroundStreamRes = makeRes();
  const backgroundStreamed = await __cursorProxyTest.writeBackgroundStreamingResult(backgroundStreamRes, backgroundStreamState, {
    upstreamResponse: fakeToolCallSSE(),
  });
  assert.equal(backgroundStreamed.assistantText, 'I will inspect it. ');
  assert.equal(backgroundStreamed.toolCalls[0].name, 'Read');
  const backgroundTextEnv = readEnvelope(backgroundStreamRes.body());
  const backgroundAttach = parseFields(backgroundTextEnv.payload);
  const backgroundHeadless = parseFields(getField(backgroundAttach, 1, 2).value);
  assert.equal(getField(backgroundHeadless, 1, 2).value.toString('utf8'), 'I will inspect it. ');
  assert.equal(backgroundStreamState.updates.length, 1);

  const heartbeatFrame = parseFields(__cursorProxyTest.buildBackgroundInteractionHeartbeatFrame());
  assert.equal(getField(heartbeatFrame, 13, 2).value.length, 0);

  const backgroundInteraction = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BackgroundComposerService/StreamInteractionUpdatesSSE'),
    backgroundInteraction,
    writeStringField(1, 'bc-smoke'),
    { log: () => {} },
  ), true);
  assert.equal(backgroundInteraction.statusCode, 200);
  assert.equal(backgroundInteraction.headers['content-type'], 'text/event-stream');
  const heartbeatEnvelope = readEnvelope(backgroundInteraction.body());
  assert.equal(heartbeatEnvelope.flags, 1);
  assert.equal(getField(parseFields(heartbeatEnvelope.payload), 13, 2).value.length, 0);
  const heartbeatEnd = readEnvelope(backgroundInteraction.body(), heartbeatEnvelope.next);
  assert.equal(heartbeatEnd.flags, 2);
  assert.deepEqual(JSON.parse(heartbeatEnd.payload.toString('utf8')), {});
  assert.equal(heartbeatEnd.next, backgroundInteraction.body().length);

  __cursorProxyTest.resetSessionStoreForTest();
  __cursorProxyTest.rememberSession({
    requestID: 'bidi-1',
    conversationID: 'conv-1',
    userText: 'hello from cursor',
    mode: 'agent',
  });
  let hit = await __cursorProxyTest.waitForSession('bidi-1', 0);
  assert.equal(hit.reason, 'exact');
  assert.equal(hit.session.userText, 'hello from cursor');

  hit = await __cursorProxyTest.waitForSession('runsse-mismatch-1', 0);
  assert.equal(hit.reason, 'recent-single-conversation');
  assert.equal(hit.session.requestID, 'runsse-mismatch-1');
  assert.equal(hit.session.fallbackFromRequestID, 'bidi-1');
  assert.equal(hit.session.userText, 'hello from cursor');

  __cursorProxyTest.dropSession('bidi-1');
  hit = await __cursorProxyTest.waitForSession('bidi-1', 0);
  assert.equal(hit.reason, 'dropped-request');
  assert.equal(hit.session.conversationID, 'conv-1');

  __cursorProxyTest.resetSessionStoreForTest();
  __cursorProxyTest.rememberSession({ requestID: 'bidi-a', conversationID: 'conv-a', userText: 'a' });
  __cursorProxyTest.rememberSession({ requestID: 'bidi-b', conversationID: 'conv-b', userText: 'b' });
  hit = await __cursorProxyTest.waitForSession('unknown-multi-conv', 0);
  assert.equal(hit, null);
  __cursorProxyTest.resetSessionStoreForTest();

  const persistedConv = 'persisted-conversation';
  __cursorProxyTest.resetHistoryStoreForTest();
  __cursorProxyTest.recordConversationTurn({
    requestID: 'persist-req-1',
    conversationID: persistedConv,
    userText: 'remember this cursor turn',
  }, 'remembered response');
  const historyFile = __cursorProxyTest.conversationHistoryPath(persistedConv);
  assert.equal(fs.existsSync(historyFile), true);
  __cursorProxyTest.resetHistoryStoreForTest();
  const persistedHistory = __cursorProxyTest.loadConversationHistory(persistedConv);
  assert.equal(persistedHistory.length, 2);
  assert.equal(persistedHistory[0].role, 'user');
  assert.equal(persistedHistory[0].content[0].text, 'remember this cursor turn');
  assert.equal(persistedHistory[1].role, 'assistant');
  assert.equal(persistedHistory[1].content[0].text, 'remembered response');

  const artifact = __cursorProxyTest.persistCursorTurnArtifacts({
    requestID: 'artifact-req-1',
    conversationID: 'artifact-conv-1',
    userText: 'inspect artifact persistence',
    mode: 'agent',
    requestedModel: { modelId: 'cursor-model' },
  }, {
    kind: 'runsse',
    assistantText: 'artifact response',
    usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 3 },
    model: 'route-openai',
    startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    finishedAt: Date.UTC(2026, 0, 1, 0, 0, 2),
    toolCalls: [{ id: 'call-read-1', name: 'Read', arguments: '{"path":"src/app.js"}' }],
    requestBodies: [{ model: 'route-openai', input: [{ role: 'user' }] }],
  });
  assert.ok(artifact.turnDir.endsWith(path.join('turns', '000000')));
  const artifactDir = __cursorProxyTest.conversationArtifactDir('artifact-conv-1');
  assert.equal(fs.existsSync(path.join(artifactDir, 'conversation.json')), true);
  assert.equal(fs.existsSync(path.join(artifact.turnDir, 'request.json')), true);
  assert.equal(fs.existsSync(path.join(artifact.turnDir, 'summary.json')), true);
  const artifactConversation = JSON.parse(fs.readFileSync(path.join(artifactDir, 'conversation.json'), 'utf8'));
  assert.equal(artifactConversation.entries.length, 2);
  assert.equal(artifactConversation.entries[0].kind, 'user_message');
  assert.equal(artifactConversation.entries[1].kind, 'assistant_text');
  assert.equal(artifactConversation.token_details_used_tokens, 18);
  const artifactSummary = JSON.parse(fs.readFileSync(path.join(artifact.turnDir, 'summary.json'), 'utf8'));
  assert.equal(artifactSummary.kind, 'runsse');
  assert.equal(artifactSummary.model, 'route-openai');
  assert.equal(artifactSummary.prompt_tokens, 11);
  assert.equal(artifactSummary.completion_tokens, 7);
  assert.equal(artifactSummary.cached_tokens, 3);
  assert.equal(artifactSummary.total_tokens, 18);
  assert.equal(artifactSummary.total_tokens_estimated, false);
  assert.equal(artifactSummary.tool_calls[0].name, 'Read');
  const artifactRequest = JSON.parse(fs.readFileSync(path.join(artifact.turnDir, 'request.json'), 'utf8'));
  assert.equal(artifactRequest.requests[0].model, 'route-openai');

  console.log('Cursor proxy smoke check passed.');
}
