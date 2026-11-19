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
export async function runGrepAndEditToolChecks({ tmp, __cursorProxyTest, handleCursorRequest }) {
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

}
