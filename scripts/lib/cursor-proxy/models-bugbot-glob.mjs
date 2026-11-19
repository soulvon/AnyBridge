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
export async function runModelsBugbotGlobChecks({ markProxyRoutesDirty, __cursorProxyTest, handleCursorRequest, isCursorHost }) {
  assert.equal(isCursorHost('api2.cursor.sh:443'), true);
  assert.equal(isCursorHost('example.com'), false);

  const noModels = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.AiService/AvailableModels'),
    noModels,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  assert.equal(noModels.statusCode, 503);
  assert.equal(JSON.parse(noModels.body().toString('utf8')).error, 'no_cursor_models');

  writeProxyRoutes();
  markProxyRoutesDirty();

  const available = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.AiService/AvailableModels'),
    available,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  assert.equal(available.statusCode, 200);
  assert.equal(available.headers['content-type'], 'application/proto');
  assert.equal(available.body().includes(Buffer.from('Cursor Smoke Model')), true);
  assert.equal(available.body().includes(Buffer.from(stableModelID('cursor-smoke-route'))), true);

  const nudge = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.AiService/GetDefaultModelNudgeData'),
    nudge,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  assert.equal(nudge.statusCode, 200);
  assert.equal(nudge.headers['content-type'], 'application/proto');
  assert.equal(nudge.body().includes(Buffer.from(stableModelID('cursor-smoke-route'))), true);

  const auth = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('authentication.cursor.sh', '/api/auth/me'),
    auth,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  assert.equal(auth.statusCode, 404);

  const prodAuth = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('prod.authentication.cursor.sh', '/api/auth/me'),
    prodAuth,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  assert.equal(prodAuth.statusCode, 404);

  const unknownApi2 = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.UnknownService/UnknownMethod'),
    unknownApi2,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  assert.equal(unknownApi2.statusCode, 404);

  __cursorProxyTest.resetSessionStoreForTest();
  const bugbotChunk = writeStringField(1, '@@ -1 +1 @@\n-console.log("old")\n+console.log("new")\n');
  const bugbotFileDiff = Buffer.concat([
    writeStringField(1, 'src/app.js'),
    writeStringField(2, 'src/app.js'),
    writeMessageField(3, bugbotChunk),
    writeVarintField(4, 1),
    writeVarintField(5, 1),
  ]);
  const bugbotGitDiff = Buffer.concat([
    writeMessageField(1, bugbotFileDiff),
    writeVarintField(2, 1),
  ]);
  const bugbotRequest = Buffer.concat([
    writeMessageField(1, bugbotGitDiff),
    writeMessageField(2, writeStringField(1, stableModelID('cursor-smoke-route'))),
    writeStringField(3, 'focus on runtime regressions'),
  ]);
  const bugbotClientMessage = writeMessageField(1, bugbotRequest);
  const bugbotBidiBody = Buffer.concat([
    writeStringField(1, bugbotClientMessage.toString('hex')),
    writeMessageField(2, writeStringField(1, 'bugbot-req')),
  ]);
  const bugbotBidi = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    bugbotBidi,
    bugbotBidiBody,
    { log: () => {} },
  ), true);
  assert.equal(bugbotBidi.statusCode, 200);
  let bugbotHit = await __cursorProxyTest.waitForSession('bugbot-req', 0);
  assert.equal(bugbotHit.reason, 'exact');
  assert.equal(bugbotHit.session.sessionType, 'bugbot');
  assert.equal(bugbotHit.session.bugBotRequest.userInstructions, 'focus on runtime regressions');
  assert.equal(bugbotHit.session.bugBotRequest.gitDiff.diffs[0].from, 'src/app.js');
  assert.equal(bugbotHit.session.userText.includes('Git diff:'), true);

  const parsedBugbot = __cursorProxyTest.parseBugBotModelResponse(JSON.stringify({
    summary: 'Found 1 issue',
    bugs: [{
      title: 'Runtime regression',
      description: 'The changed call can throw.',
      severity: 'high',
      rationale: 'The new path removes validation.',
      file: 'src/app.js',
      start_line: 1,
      end_line: 1,
    }],
  }));
  assert.equal(parsedBugbot.reports.length, 1);
  const bugbotServer = parseFields(__cursorProxyTest.buildBugBotServerMessage(
    __cursorProxyTest.buildBugBotResponse({
      reports: parsedBugbot.reports,
      status: 3,
      message: 'Found 1 issue(s)',
      summary: parsedBugbot.summary,
      numTurns: 1,
      iterationsCompleted: 1,
      totalIterations: 1,
    }),
  ));
  const bugbotResponse = parseFields(getField(bugbotServer, 1, 2).value);
  const bugbotReports = parseFields(getField(bugbotResponse, 1, 2).value);
  const bugbotFirstReport = parseFields(getField(bugbotReports, 1, 2).value);
  assert.equal(getField(bugbotFirstReport, 7, 2).value.toString('utf8'), 'Runtime regression');
  assert.equal(getField(parseFields(getField(bugbotResponse, 2, 2).value), 1, 0).value, 3);

  const bugbot = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.AiService/StreamBugBotAgenticSSE'),
    bugbot,
    Buffer.alloc(0),
    { log: () => {} },
  ), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bugbot.statusCode, 200);
  assert.equal(bugbot.headers['content-type'], 'text/event-stream');
  const bugbotErrorFrame = readEnvelope(bugbot.body());
  assert.equal(bugbotErrorFrame.flags, 1);
  const bugbotErrorResponse = parseFields(getField(parseFields(bugbotErrorFrame.payload), 1, 2).value);
  const bugbotErrorStatus = parseFields(getField(bugbotErrorResponse, 2, 2).value);
  assert.equal(getField(bugbotErrorStatus, 1, 0).value, 4);
  const bugbotErrorEnd = readEnvelope(bugbot.body(), bugbotErrorFrame.next);
  assert.equal(bugbotErrorEnd.flags, 2);

  __cursorProxyTest.resetToolWaitsForTest();
  const readExecBody = __cursorProxyTest.buildReadExecServerMessage({
    seq: 42,
    execID: 'exec-read-smoke',
    path: 'src/app.js',
    toolCallID: 'tool-read-smoke',
  });
  const readExec = parseFields(readExecBody);
  assert.equal(getField(readExec, 1, 0).value, 42);
  assert.equal(getField(readExec, 15, 2).value.toString('utf8'), 'exec-read-smoke');
  const readExecArgs = parseFields(getField(readExec, 7, 2).value);
  assert.equal(getField(readExecArgs, 1, 2).value.toString('utf8'), 'src/app.js');
  assert.equal(getField(readExecArgs, 2, 2).value.toString('utf8'), 'tool-read-smoke');
  const readExecFrame = parseFields(__cursorProxyTest.buildExecServerFrame(readExecBody));
  assert.equal(getField(readExecFrame, 2, 2).value.length > 0, true);
  const readToolCall = parseFields(__cursorProxyTest.buildReadToolCall({
    path: 'src/app.js',
    offset: 2,
    limit: 10,
    includeLineNumbers: true,
  }));
  const readTool = parseFields(getField(readToolCall, 8, 2).value);
  const readToolArgs = parseFields(getField(readTool, 1, 2).value);
  assert.equal(getField(readToolArgs, 1, 2).value.toString('utf8'), 'src/app.js');
  assert.equal(getField(readToolArgs, 2, 0).value, 2);
  assert.equal(getField(readToolArgs, 3, 0).value, 10);
  assert.equal(getField(readToolArgs, 5, 0).value, 1);

  const toolWait = __cursorProxyTest.registerToolWait('tool-read-smoke', 1000);
  __cursorProxyTest.registerExecIDAlias('exec-read-smoke', 42, 'tool-read-smoke');
  const readSuccess = Buffer.concat([
    writeStringField(1, 'src/app.js'),
    writeStringField(2, 'console.log("new")\n'),
    writeVarintField(3, 1),
    writeVarintField(4, 19),
    writeVarintField(6, 0),
  ]);
  const readResult = writeMessageField(1, readSuccess);
  const execClient = Buffer.concat([
    writeVarintField(1, 42),
    writeMessageField(7, readResult),
    writeStringField(15, 'exec-read-smoke'),
  ]);
  const execAgentMessage = writeMessageField(2, execClient);
  const execBidiBody = Buffer.concat([
    writeStringField(1, execAgentMessage.toString('hex')),
    writeMessageField(2, writeStringField(1, 'tool-bidi-req')),
  ]);
  const execBidi = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    execBidi,
    execBidiBody,
    { log: () => {} },
  ), true);
  assert.equal(execBidi.statusCode, 200);
  const toolResult = await toolWait;
  assert.equal(toolResult.toolCallID, 'tool-read-smoke');
  assert.equal(toolResult.execID, 'exec-read-smoke');
  assert.equal(JSON.parse(toolResult.resultJSON).content, 'console.log("new")\n');
  __cursorProxyTest.resetToolWaitsForTest();

  const readRun = makeRes();
  const readRunPromise = __cursorProxyTest.executeReadCursorTool(readRun, {
    callID: 'tool-read-exec',
    path: 'src/app.js',
    execID: 'exec-read-exec',
    seq: 43,
    timeoutMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const startedEnvelope = readEnvelope(readRun.body());
  assert.equal(startedEnvelope.flags, 1);
  const startedAgent = parseFields(startedEnvelope.payload);
  const startedInteraction = parseFields(getField(startedAgent, 1, 2).value);
  const startedUpdate = parseFields(getField(startedInteraction, 2, 2).value);
  assert.equal(getField(startedUpdate, 1, 2).value.toString('utf8'), 'tool-read-exec');
  assert.equal(getField(parseFields(getField(startedUpdate, 2, 2).value), 8, 2).value.length > 0, true);
  const execEnvelope = readEnvelope(readRun.body(), startedEnvelope.next);
  const execAgent = parseFields(execEnvelope.payload);
  const execServer = parseFields(getField(execAgent, 2, 2).value);
  assert.equal(getField(execServer, 1, 0).value, 43);
  assert.equal(getField(execServer, 15, 2).value.toString('utf8'), 'exec-read-exec');

  const execClient2 = Buffer.concat([
    writeVarintField(1, 43),
    writeMessageField(7, readResult),
    writeStringField(15, 'exec-read-exec'),
  ]);
  const execBidiBody2 = Buffer.concat([
    writeStringField(1, writeMessageField(2, execClient2).toString('hex')),
    writeMessageField(2, writeStringField(1, 'tool-bidi-req-2')),
  ]);
  const execBidi2 = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    execBidi2,
    execBidiBody2,
    { log: () => {} },
  ), true);
  const readRunResult = await readRunPromise;
  assert.equal(JSON.parse(readRunResult.resultJSON).path, 'src/app.js');
  const completedEnvelope = readEnvelope(readRun.body(), execEnvelope.next);
  const completedAgent = parseFields(completedEnvelope.payload);
  const completedInteraction = parseFields(getField(completedAgent, 1, 2).value);
  const completedUpdate = parseFields(getField(completedInteraction, 3, 2).value);
  assert.equal(getField(completedUpdate, 1, 2).value.toString('utf8'), 'tool-read-exec');
  const completedToolCall = parseFields(getField(completedUpdate, 2, 2).value);
  const completedReadTool = parseFields(getField(completedToolCall, 8, 2).value);
  const completedReadResult = parseFields(getField(completedReadTool, 2, 2).value);
  const completedReadSuccess = parseFields(getField(completedReadResult, 1, 2).value);
  assert.equal(getField(completedReadSuccess, 1, 2).value.toString('utf8'), 'console.log("new")\n');
  __cursorProxyTest.resetToolWaitsForTest();

  const globToolCall = parseFields(__cursorProxyTest.buildGlobToolCall({
    globPattern: '*.js',
    targetDirectory: 'E:/repo',
  }));
  const globTool = parseFields(getField(globToolCall, 4, 2).value);
  const globArgs = parseFields(getField(globTool, 1, 2).value);
  assert.equal(getField(globArgs, 1, 2).value.toString('utf8'), 'E:/repo');
  assert.equal(getField(globArgs, 2, 2).value.toString('utf8'), '*.js');

  const lsExecBody = __cursorProxyTest.buildLsExecServerMessage({
    seq: 44,
    execID: 'exec-glob-smoke',
    path: 'E:/repo',
    toolCallID: 'tool-glob-smoke',
    timeoutMs: 30000,
  });
  const lsExec = parseFields(lsExecBody);
  assert.equal(getField(lsExec, 1, 0).value, 44);
  assert.equal(getField(lsExec, 15, 2).value.toString('utf8'), 'exec-glob-smoke');
  const lsArgs = parseFields(getField(lsExec, 8, 2).value);
  assert.equal(getField(lsArgs, 1, 2).value.toString('utf8'), 'E:/repo');
  assert.equal(getField(lsArgs, 3, 2).value.toString('utf8'), 'tool-glob-smoke');
  assert.equal(getField(lsArgs, 5, 0).value, 30000);

  function lsFile(name) {
    return writeStringField(1, name);
  }
  function lsDir(absPath, childrenDirs = [], childrenFiles = []) {
    return protoConcat([
      writeStringField(1, absPath),
      ...childrenDirs.map(child => writeMessageField(2, child)),
      ...childrenFiles.map(file => writeMessageField(3, file)),
      writeVarintField(4, 1),
      writeVarintField(6, childrenFiles.length),
    ]);
  }
  const lsRoot = lsDir('E:/repo', [
    lsDir('E:/repo/src', [], [lsFile('app.js'), lsFile('app.ts')]),
    lsDir('E:/repo/test', [], [lsFile('app.test.ts')]),
  ], [lsFile('README.md')]);
  const lsResult = writeMessageField(1, writeMessageField(1, lsRoot));

  const globRun = makeRes();
  const globRunPromise = __cursorProxyTest.executeGlobCursorTool(globRun, {
    callID: 'tool-glob-exec',
    globPattern: '*.js',
    targetDirectory: 'E:/repo',
    execID: 'exec-glob-exec',
    seq: 44,
    timeoutMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const globStartedEnvelope = readEnvelope(globRun.body());
  const globStartedUpdate = parseFields(getField(parseFields(getField(parseFields(globStartedEnvelope.payload), 1, 2).value), 2, 2).value);
  assert.equal(getField(globStartedUpdate, 1, 2).value.toString('utf8'), 'tool-glob-exec');
  assert.equal(getField(parseFields(getField(globStartedUpdate, 2, 2).value), 4, 2).value.length > 0, true);
  const globExecEnvelope = readEnvelope(globRun.body(), globStartedEnvelope.next);
  const globExecServer = parseFields(getField(parseFields(globExecEnvelope.payload), 2, 2).value);
  assert.equal(getField(globExecServer, 1, 0).value, 44);
  assert.equal(getField(globExecServer, 15, 2).value.toString('utf8'), 'exec-glob-exec');
  assert.equal(getField(parseFields(getField(globExecServer, 8, 2).value), 1, 2).value.toString('utf8'), 'E:/repo');

  const globExecClient = protoConcat([
    writeVarintField(1, 44),
    writeMessageField(8, lsResult),
    writeStringField(15, 'exec-glob-exec'),
  ]);
  const globBidiBody = protoConcat([
    writeStringField(1, writeMessageField(2, globExecClient).toString('hex')),
    writeMessageField(2, writeStringField(1, 'tool-bidi-glob')),
  ]);
  const globBidi = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    globBidi,
    globBidiBody,
    { log: () => {} },
  ), true);
  const globRunResult = await globRunPromise;
  const globJSON = JSON.parse(globRunResult.resultJSON);
  assert.deepEqual(globJSON.files, ['E:/repo/src/app.js']);
  assert.equal(globJSON.total_files, 1);
  const globCompletedEnvelope = readEnvelope(globRun.body(), globExecEnvelope.next);
  const globCompletedUpdate = parseFields(getField(parseFields(getField(parseFields(globCompletedEnvelope.payload), 1, 2).value), 3, 2).value);
  const completedGlobTool = parseFields(getField(parseFields(getField(globCompletedUpdate, 2, 2).value), 4, 2).value);
  const completedGlobResult = parseFields(getField(completedGlobTool, 2, 2).value);
  const completedGlobSuccess = parseFields(getField(completedGlobResult, 1, 2).value);
  assert.equal(getField(completedGlobSuccess, 3, 2).value.toString('utf8'), 'E:/repo/src/app.js');
  __cursorProxyTest.resetToolWaitsForTest();

}
