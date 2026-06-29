import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  getField,
  parseFields,
  writeMessageField,
  writeStringField,
  writeVarintField,
} from '../sidecar/proto.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-cursor-proxy-'));
process.env.BYOK_CONFIG_DIR = tmp;

function stableModelID(modelID) {
  return crypto.createHash('sha256').update(`byok|${modelID}`).digest('hex').slice(0, 16);
}

function writeProxyRoutes(routes = [{
  id: 'cursor-smoke-route',
  displayName: 'Cursor Smoke Model',
  enabled: true,
  exposedFormats: ['openai'],
  targets: [{
    providerId: 'smoke-provider',
    model: 'gpt-smoke',
  }],
}]) {
  fs.writeFileSync(path.join(tmp, 'proxy-routes.json'), JSON.stringify({
    version: 1,
    routes,
  }, null, 2));
}

function makeReq(host, url) {
  return { url, headers: { host } };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
    },
    body() {
      return Buffer.concat(this.chunks);
    },
  };
}

function readEnvelope(buf, offset = 0) {
  const flags = buf[offset];
  const length = buf.readUInt32BE(offset + 1);
  const rawPayload = buf.subarray(offset + 5, offset + 5 + length);
  const payload = (flags & 1) === 1 ? zlib.gunzipSync(rawPayload) : rawPayload;
  return { flags, length, payload, next: offset + 5 + length };
}

function protoConcat(parts) {
  return Buffer.concat(parts.filter(Boolean));
}

try {
  writeProxyRoutes([]);
  const { markProxyRoutesDirty } = await import('../sidecar/config-cache.js');
  const { __cursorProxyTest, handleCursorRequest, isCursorHost } = await import('../sidecar/cursor-proxy.js');

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
  assert.equal(bugbotErrorEnd.flags, 3);

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

  const grepToolCall = parseFields(__cursorProxyTest.buildGrepToolCall({
    pattern: 'answer',
    path: 'src',
    glob: '*.js',
    outputMode: 'content',
    contextBefore: 1,
    contextAfter: 2,
    caseInsensitive: true,
    headLimit: 20,
    multiline: false,
    toolCallID: 'tool-grep-smoke',
  }));
  const grepTool = parseFields(getField(grepToolCall, 5, 2).value);
  const grepArgs = parseFields(getField(grepTool, 1, 2).value);
  assert.equal(getField(grepArgs, 1, 2).value.toString('utf8'), 'answer');
  assert.equal(getField(grepArgs, 2, 2).value.toString('utf8'), 'src');
  assert.equal(getField(grepArgs, 3, 2).value.toString('utf8'), '*.js');
  assert.equal(getField(grepArgs, 4, 2).value.toString('utf8'), 'content');
  assert.equal(getField(grepArgs, 5, 0).value, 1);
  assert.equal(getField(grepArgs, 6, 0).value, 2);
  assert.equal(getField(grepArgs, 8, 0).value, 1);
  assert.equal(getField(grepArgs, 10, 0).value, 20);
  assert.equal(getField(grepArgs, 14, 2).value.toString('utf8'), 'tool-grep-smoke');

  const grepExecBody = __cursorProxyTest.buildGrepExecServerMessage({
    seq: 45,
    execID: 'exec-grep-smoke',
    pattern: 'answer',
    outputMode: 'content',
    toolCallID: 'tool-grep-smoke',
  });
  const grepExec = parseFields(grepExecBody);
  assert.equal(getField(grepExec, 1, 0).value, 45);
  assert.equal(getField(grepExec, 15, 2).value.toString('utf8'), 'exec-grep-smoke');
  assert.equal(getField(parseFields(getField(grepExec, 5, 2).value), 1, 2).value.toString('utf8'), 'answer');

  const grepContentMatch = protoConcat([
    writeVarintField(1, 12),
    writeStringField(2, 'const answer = 42;'),
    writeVarintField(3, 0),
    writeVarintField(4, 0),
  ]);
  const grepFileMatch = protoConcat([
    writeStringField(1, 'src/app.js'),
    writeMessageField(2, grepContentMatch),
  ]);
  const grepContentResult = protoConcat([
    writeMessageField(1, grepFileMatch),
    writeVarintField(2, 1),
    writeVarintField(3, 1),
    writeVarintField(4, 0),
    writeVarintField(5, 0),
  ]);
  const grepUnion = writeMessageField(3, grepContentResult);
  const grepWorkspaceEntry = protoConcat([
    writeStringField(1, 'workspace'),
    writeMessageField(2, grepUnion),
  ]);
  const grepSuccess = protoConcat([
    writeStringField(1, 'answer'),
    writeStringField(2, 'src'),
    writeStringField(3, 'content'),
    writeMessageField(4, grepWorkspaceEntry),
  ]);
  const grepResult = writeMessageField(1, grepSuccess);

  const grepRun = makeRes();
  const grepRunPromise = __cursorProxyTest.executeGrepCursorTool(grepRun, {
    callID: 'tool-grep-exec',
    pattern: 'answer',
    path: 'src',
    outputMode: 'content',
    execID: 'exec-grep-exec',
    seq: 45,
    timeoutMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const grepStartedEnvelope = readEnvelope(grepRun.body());
  const grepStartedUpdate = parseFields(getField(parseFields(getField(parseFields(grepStartedEnvelope.payload), 1, 2).value), 2, 2).value);
  assert.equal(getField(grepStartedUpdate, 1, 2).value.toString('utf8'), 'tool-grep-exec');
  assert.equal(getField(parseFields(getField(grepStartedUpdate, 2, 2).value), 5, 2).value.length > 0, true);
  const grepExecEnvelope = readEnvelope(grepRun.body(), grepStartedEnvelope.next);
  const grepExecServer = parseFields(getField(parseFields(grepExecEnvelope.payload), 2, 2).value);
  assert.equal(getField(grepExecServer, 1, 0).value, 45);
  assert.equal(getField(parseFields(getField(grepExecServer, 5, 2).value), 14, 2).value.toString('utf8'), 'tool-grep-exec');

  const grepExecClient = protoConcat([
    writeVarintField(1, 45),
    writeMessageField(5, grepResult),
    writeStringField(15, 'exec-grep-exec'),
  ]);
  const grepBidiBody = protoConcat([
    writeStringField(1, writeMessageField(2, grepExecClient).toString('hex')),
    writeMessageField(2, writeStringField(1, 'tool-bidi-grep')),
  ]);
  const grepBidi = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    grepBidi,
    grepBidiBody,
    { log: () => {} },
  ), true);
  const grepRunResult = await grepRunPromise;
  const grepJSON = JSON.parse(grepRunResult.resultJSON);
  assert.equal(grepJSON.workspace_results.workspace.kind, 'content');
  assert.equal(grepJSON.workspace_results.workspace.matches[0].file, 'src/app.js');
  assert.equal(grepJSON.workspace_results.workspace.matches[0].matches[0].lineNumber, 12);
  const grepCompletedEnvelope = readEnvelope(grepRun.body(), grepExecEnvelope.next);
  const grepCompletedUpdate = parseFields(getField(parseFields(getField(parseFields(grepCompletedEnvelope.payload), 1, 2).value), 3, 2).value);
  const completedGrepTool = parseFields(getField(parseFields(getField(grepCompletedUpdate, 2, 2).value), 5, 2).value);
  const completedGrepResult = parseFields(getField(completedGrepTool, 2, 2).value);
  assert.equal(getField(parseFields(getField(completedGrepResult, 1, 2).value), 1, 2).value.toString('utf8'), 'answer');
  __cursorProxyTest.resetToolWaitsForTest();

  const shellToolCall = parseFields(__cursorProxyTest.buildShellToolCall({
    command: 'npm test',
    workingDirectory: 'E:/repo',
    blockUntilMs: 45000,
    toolCallID: 'tool-shell-smoke',
  }));
  const shellTool = parseFields(getField(shellToolCall, 1, 2).value);
  const shellArgs = parseFields(getField(shellTool, 1, 2).value);
  assert.equal(getField(shellArgs, 1, 2).value.toString('utf8'), 'npm test');
  assert.equal(getField(shellArgs, 2, 2).value.toString('utf8'), 'E:/repo');
  assert.equal(getField(shellArgs, 3, 0).value, 45000);
  assert.equal(getField(shellArgs, 4, 2).value.toString('utf8'), 'tool-shell-smoke');

  const shellExecBody = __cursorProxyTest.buildShellExecServerMessage({
    seq: 46,
    execID: 'exec-shell-smoke',
    command: 'npm test',
    workingDirectory: 'E:/repo',
    blockUntilMs: 45000,
    toolCallID: 'tool-shell-smoke',
  });
  const shellExec = parseFields(shellExecBody);
  assert.equal(getField(shellExec, 1, 0).value, 46);
  assert.equal(getField(shellExec, 15, 2).value.toString('utf8'), 'exec-shell-smoke');
  assert.equal(getField(parseFields(getField(shellExec, 14, 2).value), 1, 2).value.toString('utf8'), 'npm test');

  function sendExecClient(execClient, requestID) {
    const bidiBody = protoConcat([
      writeStringField(1, writeMessageField(2, execClient).toString('hex')),
      writeMessageField(2, writeStringField(1, requestID)),
    ]);
    const bidi = makeRes();
    assert.equal(handleCursorRequest(
      makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
      bidi,
      bidiBody,
      { log: () => {} },
    ), true);
    assert.equal(bidi.statusCode, 200);
  }

  const shellRun = makeRes();
  const shellRunPromise = __cursorProxyTest.executeShellCursorTool(shellRun, {
    callID: 'tool-shell-exec',
    command: 'npm test',
    workingDirectory: 'E:/repo',
    blockUntilMs: 45000,
    execID: 'exec-shell-exec',
    seq: 46,
    timeoutMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const shellStartedEnvelope = readEnvelope(shellRun.body());
  const shellStartedUpdate = parseFields(getField(parseFields(getField(parseFields(shellStartedEnvelope.payload), 1, 2).value), 2, 2).value);
  assert.equal(getField(shellStartedUpdate, 1, 2).value.toString('utf8'), 'tool-shell-exec');
  assert.equal(getField(parseFields(getField(shellStartedUpdate, 2, 2).value), 1, 2).value.length > 0, true);
  const shellExecEnvelope = readEnvelope(shellRun.body(), shellStartedEnvelope.next);
  const shellExecServer = parseFields(getField(parseFields(shellExecEnvelope.payload), 2, 2).value);
  assert.equal(getField(shellExecServer, 1, 0).value, 46);
  assert.equal(getField(parseFields(getField(shellExecServer, 14, 2).value), 4, 2).value.toString('utf8'), 'tool-shell-exec');

  for (const [stream, reqID] of [
    [writeMessageField(4, Buffer.alloc(0)), 'tool-bidi-shell-start'],
    [writeMessageField(1, writeStringField(1, 'hello\n')), 'tool-bidi-shell-stdout'],
    [writeMessageField(2, writeStringField(1, 'warn\n')), 'tool-bidi-shell-stderr'],
  ]) {
    sendExecClient(protoConcat([
      writeVarintField(1, 46),
      writeMessageField(14, stream),
      writeStringField(15, 'exec-shell-exec'),
    ]), reqID);
  }
  assert.equal(shellRun.body().length, shellExecEnvelope.next);
  sendExecClient(protoConcat([
    writeVarintField(1, 46),
    writeMessageField(14, writeMessageField(3, protoConcat([
      writeVarintField(1, 0),
      writeStringField(2, 'E:/repo'),
    ]))),
    writeStringField(15, 'exec-shell-exec'),
  ]), 'tool-bidi-shell-exit');
  const shellRunResult = await shellRunPromise;
  const shellJSON = JSON.parse(shellRunResult.resultJSON);
  assert.equal(shellJSON.exit_code, 0);
  assert.equal(shellJSON.stdout, 'hello\n');
  assert.equal(shellJSON.stderr, 'warn\n');
  const shellCompletedEnvelope = readEnvelope(shellRun.body(), shellExecEnvelope.next);
  const shellCompletedUpdate = parseFields(getField(parseFields(getField(parseFields(shellCompletedEnvelope.payload), 1, 2).value), 3, 2).value);
  const completedShellTool = parseFields(getField(parseFields(getField(shellCompletedUpdate, 2, 2).value), 1, 2).value);
  const completedShellResult = parseFields(getField(completedShellTool, 2, 2).value);
  const completedShellSuccess = parseFields(getField(completedShellResult, 1, 2).value);
  assert.equal(getField(completedShellSuccess, 5, 2).value.toString('utf8'), 'hello\n');
  assert.equal(getField(completedShellSuccess, 6, 2).value.toString('utf8'), 'warn\n');
  __cursorProxyTest.resetToolWaitsForTest();

  const editToolCall = parseFields(__cursorProxyTest.buildEditToolCall({
    path: 'src/app.js',
    streamContent: 'const answer = 43;\n',
  }));
  const editTool = parseFields(getField(editToolCall, 12, 2).value);
  const editArgs = parseFields(getField(editTool, 1, 2).value);
  assert.equal(getField(editArgs, 1, 2).value.toString('utf8'), 'src/app.js');
  assert.equal(getField(editArgs, 6, 2).value.toString('utf8'), 'const answer = 43;\n');

  const writeExecBody = __cursorProxyTest.buildWriteExecServerMessage({
    seq: 46,
    execID: 'exec-write-smoke',
    path: 'src/app.js',
    fileText: 'const answer = 43;\n',
    toolCallID: 'tool-write-smoke',
  });
  const writeExec = parseFields(writeExecBody);
  assert.equal(getField(writeExec, 1, 0).value, 46);
  assert.equal(getField(writeExec, 15, 2).value.toString('utf8'), 'exec-write-smoke');
  const writeArgs = parseFields(getField(writeExec, 3, 2).value);
  assert.equal(getField(writeArgs, 1, 2).value.toString('utf8'), 'src/app.js');
  assert.equal(getField(writeArgs, 2, 2).value.toString('utf8'), 'const answer = 43;\n');
  assert.equal(getField(writeArgs, 3, 2).value.toString('utf8'), 'tool-write-smoke');
  assert.equal(getField(writeArgs, 4, 0).value, 1);

  const writeSuccess = protoConcat([
    writeStringField(1, 'src/app.js'),
    writeVarintField(2, 1),
    writeVarintField(3, 19),
    writeStringField(4, 'const answer = 43;\n'),
  ]);
  const writeResult = writeMessageField(1, writeSuccess);
  const writeRun = makeRes();
  const writeRunPromise = __cursorProxyTest.executeWriteCursorTool(writeRun, {
    callID: 'tool-write-exec',
    path: 'src/app.js',
    contents: 'const answer = 43;\n',
    execID: 'exec-write-exec',
    seq: 46,
    timeoutMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const writeStartedEnvelope = readEnvelope(writeRun.body());
  const writeStartedUpdate = parseFields(getField(parseFields(getField(parseFields(writeStartedEnvelope.payload), 1, 2).value), 2, 2).value);
  assert.equal(getField(writeStartedUpdate, 1, 2).value.toString('utf8'), 'tool-write-exec');
  assert.equal(getField(parseFields(getField(writeStartedUpdate, 2, 2).value), 12, 2).value.length > 0, true);
  const writeExecEnvelope = readEnvelope(writeRun.body(), writeStartedEnvelope.next);
  const writeExecServer = parseFields(getField(parseFields(writeExecEnvelope.payload), 2, 2).value);
  assert.equal(getField(writeExecServer, 1, 0).value, 46);
  assert.equal(getField(parseFields(getField(writeExecServer, 3, 2).value), 3, 2).value.toString('utf8'), 'tool-write-exec');

  const writeExecClient = protoConcat([
    writeVarintField(1, 46),
    writeMessageField(3, writeResult),
    writeStringField(15, 'exec-write-exec'),
  ]);
  const writeBidiBody = protoConcat([
    writeStringField(1, writeMessageField(2, writeExecClient).toString('hex')),
    writeMessageField(2, writeStringField(1, 'tool-bidi-write')),
  ]);
  const writeBidi = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    writeBidi,
    writeBidiBody,
    { log: () => {} },
  ), true);
  const writeRunResult = await writeRunPromise;
  const writeJSON = JSON.parse(writeRunResult.resultJSON);
  assert.equal(writeJSON.path, 'src/app.js');
  assert.equal(writeJSON.file_content_after_write, 'const answer = 43;\n');
  const writeCompletedEnvelope = readEnvelope(writeRun.body(), writeExecEnvelope.next);
  const writeCompletedUpdate = parseFields(getField(parseFields(getField(parseFields(writeCompletedEnvelope.payload), 1, 2).value), 3, 2).value);
  const completedEditTool = parseFields(getField(parseFields(getField(writeCompletedUpdate, 2, 2).value), 12, 2).value);
  const completedEditResult = parseFields(getField(completedEditTool, 2, 2).value);
  const completedEditSuccess = parseFields(getField(completedEditResult, 1, 2).value);
  assert.equal(getField(completedEditSuccess, 7, 2).value.toString('utf8'), 'const answer = 43;\n');
  __cursorProxyTest.resetToolWaitsForTest();

  const deleteToolCall = parseFields(__cursorProxyTest.buildDeleteToolCall({
    path: 'src/old.js',
    toolCallID: 'tool-delete-smoke',
  }));
  const deleteTool = parseFields(getField(deleteToolCall, 3, 2).value);
  const deleteArgs = parseFields(getField(deleteTool, 1, 2).value);
  assert.equal(getField(deleteArgs, 1, 2).value.toString('utf8'), 'src/old.js');
  assert.equal(getField(deleteArgs, 2, 2).value.toString('utf8'), 'tool-delete-smoke');

  const deleteExecBody = __cursorProxyTest.buildDeleteExecServerMessage({
    seq: 47,
    execID: 'exec-delete-smoke',
    path: 'src/old.js',
    toolCallID: 'tool-delete-smoke',
  });
  const deleteExec = parseFields(deleteExecBody);
  assert.equal(getField(deleteExec, 1, 0).value, 47);
  assert.equal(getField(deleteExec, 15, 2).value.toString('utf8'), 'exec-delete-smoke');
  assert.equal(getField(parseFields(getField(deleteExec, 4, 2).value), 2, 2).value.toString('utf8'), 'tool-delete-smoke');

  const deleteSuccess = protoConcat([
    writeStringField(1, 'src/old.js'),
    writeStringField(2, 'src/old.js'),
    writeVarintField(3, 18),
    writeStringField(4, 'console.log(1);\n'),
  ]);
  const deleteResult = writeMessageField(1, deleteSuccess);
  const deleteRun = makeRes();
  const deleteRunPromise = __cursorProxyTest.executeDeleteCursorTool(deleteRun, {
    callID: 'tool-delete-exec',
    path: 'src/old.js',
    execID: 'exec-delete-exec',
    seq: 47,
    timeoutMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const deleteStartedEnvelope = readEnvelope(deleteRun.body());
  const deleteExecEnvelope = readEnvelope(deleteRun.body(), deleteStartedEnvelope.next);
  const deleteExecServer = parseFields(getField(parseFields(deleteExecEnvelope.payload), 2, 2).value);
  assert.equal(getField(deleteExecServer, 1, 0).value, 47);
  assert.equal(getField(parseFields(getField(deleteExecServer, 4, 2).value), 1, 2).value.toString('utf8'), 'src/old.js');

  const deleteExecClient = protoConcat([
    writeVarintField(1, 47),
    writeMessageField(4, deleteResult),
    writeStringField(15, 'exec-delete-exec'),
  ]);
  const deleteBidiBody = protoConcat([
    writeStringField(1, writeMessageField(2, deleteExecClient).toString('hex')),
    writeMessageField(2, writeStringField(1, 'tool-bidi-delete')),
  ]);
  const deleteBidi = makeRes();
  assert.equal(handleCursorRequest(
    makeReq('api2.cursor.sh', '/aiserver.v1.BidiService/BidiAppend'),
    deleteBidi,
    deleteBidiBody,
    { log: () => {} },
  ), true);
  const deleteRunResult = await deleteRunPromise;
  const deleteJSON = JSON.parse(deleteRunResult.resultJSON);
  assert.equal(deleteJSON.deleted_file, 'src/old.js');
  const deleteCompletedEnvelope = readEnvelope(deleteRun.body(), deleteExecEnvelope.next);
  const deleteCompletedUpdate = parseFields(getField(parseFields(getField(parseFields(deleteCompletedEnvelope.payload), 1, 2).value), 3, 2).value);
  const completedDeleteTool = parseFields(getField(parseFields(getField(deleteCompletedUpdate, 2, 2).value), 3, 2).value);
  const completedDeleteResult = parseFields(getField(completedDeleteTool, 2, 2).value);
  assert.equal(getField(parseFields(getField(completedDeleteResult, 1, 2).value), 2, 2).value.toString('utf8'), 'src/old.js');
  __cursorProxyTest.resetToolWaitsForTest();

  const strReplacePath = path.join(tmp, 'replace.txt');
  fs.writeFileSync(strReplacePath, 'alpha\r\nbeta\r\n', 'utf8');
  assert.equal(
    __cursorProxyTest.applyStrReplaceToFile(strReplacePath, 'alpha\nbeta', 'gamma\nbeta', false),
    'gamma\r\nbeta\r\n',
  );
  fs.writeFileSync(strReplacePath, 'x\nx\n', 'utf8');
  assert.throws(
    () => __cursorProxyTest.applyStrReplaceToFile(strReplacePath, 'x', 'y', false),
    /matches multiple locations/,
  );
  assert.equal(__cursorProxyTest.applyStrReplaceToFile(strReplacePath, 'x', 'y', true), 'y\ny\n');

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
  assert.equal(heartbeatEnd.flags, 3);
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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
