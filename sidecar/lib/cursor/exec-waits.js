// lib/cursor/exec-waits.js - Modular component split from cursor-proxy.js.

import { CURSOR_INTERACTION_WAIT_MS } from "./common.js";
import { resultJSONFromExecClient } from "./proto-parsers.js";

const pendingToolResults = new Map();
const pendingInteractionResponses = new Map();
const execIDAliases = new Map();
const seqAliases = new Map();
const shellAccums = new Map();
let execSeqCounter = 0;

export function nextExecSeq() {
  execSeqCounter = (execSeqCounter + 1) >>> 0;
  if (execSeqCounter === 0) execSeqCounter = 1;
  return execSeqCounter;
}


export function registerExecIDAlias(execID, seq, toolCallID) {
  if (!toolCallID) throw new Error('Cannot register Cursor exec alias without tool_call_id');
  if (execID) execIDAliases.set(execID, toolCallID);
  if (seq) seqAliases.set(Number(seq), toolCallID);
}


function unregisterToolAliases(toolCallID) {
  for (const [execID, mapped] of execIDAliases) {
    if (mapped === toolCallID) execIDAliases.delete(execID);
  }
  for (const [seq, mapped] of seqAliases) {
    if (mapped === toolCallID) seqAliases.delete(seq);
  }
}


export function registerToolWait(toolCallID, timeoutMs = 30000) {
  if (!toolCallID) throw new Error('Cannot wait for Cursor tool result without tool_call_id');
  if (pendingToolResults.has(toolCallID)) {
    throw new Error(`Cursor tool wait already registered for tool_call_id=${toolCallID}`);
  }
  let timer = null;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      pendingToolResults.delete(toolCallID);
      unregisterToolAliases(toolCallID);
      reject(new Error(`Timed out waiting for Cursor tool result: ${toolCallID}`));
    }, Math.max(1, Number(timeoutMs) || 30000));
    if (typeof timer.unref === 'function') timer.unref();
    pendingToolResults.set(toolCallID, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
  return promise;
}


export function rejectToolWait(toolCallID, err) {
  const pending = pendingToolResults.get(toolCallID);
  pendingToolResults.delete(toolCallID);
  unregisterToolAliases(toolCallID);
  if (pending) {
    pending.reject(err instanceof Error ? err : new Error(String(err || 'Cursor tool wait cancelled')));
  }
}


export function registerInteractionWait(queryID, timeoutMs = CURSOR_INTERACTION_WAIT_MS) {
  const id = Number(queryID) || 0;
  if (!id) throw new Error('Cannot wait for Cursor interaction without query id');
  if (pendingInteractionResponses.has(id)) {
    throw new Error(`Cursor interaction wait already registered for id=${id}`);
  }
  let timer = null;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      pendingInteractionResponses.delete(id);
      reject(new Error(`Timed out waiting for Cursor interaction response: ${id}`));
    }, Math.max(1, Number(timeoutMs) || CURSOR_INTERACTION_WAIT_MS));
    if (typeof timer.unref === 'function') timer.unref();
    pendingInteractionResponses.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
  return promise;
}


export function deliverInteractionResponse(response) {
  const id = Number(response?.id) || 0;
  if (!id) return false;
  const pending = pendingInteractionResponses.get(id);
  if (!pending) return false;
  pendingInteractionResponses.delete(id);
  pending.resolve(response);
  return true;
}


export function cancelInteractionWait(queryID) {
  const id = Number(queryID) || 0;
  if (!id) return false;
  return pendingInteractionResponses.delete(id);
}

export function resetInteractionWaitsForTest() {
  for (const [, pending] of pendingInteractionResponses) {
    pending.reject(new Error('Cursor interaction waits reset'));
  }
  pendingInteractionResponses.clear();
}


function shellResultJSON(state) {
  if (state.error) {
    return JSON.stringify({
      error: state.error,
      kind: state.kind || 'error',
      command: state.command || '',
      working_directory: state.workingDirectory || '',
      stdout: state.stdout || '',
      stderr: state.stderr || '',
    });
  }
  return JSON.stringify({
    exit_code: Number.isFinite(Number(state.exitCode)) ? Number(state.exitCode) : null,
    cwd: state.cwd || state.workingDirectory || '',
    stdout: state.stdout || '',
    stderr: state.stderr || '',
    backgrounded: state.backgrounded === true,
    shell_id: state.shellID || 0,
    pid: state.pid || 0,
    aborted: state.aborted === true,
  });
}


function deliverShellStreamResult(toolCallID, execMsg) {
  const pending = pendingToolResults.get(toolCallID);
  if (!pending) return false;
  const event = execMsg.shellStream || { event: 'unknown' };
  const state = shellAccums.get(toolCallID) || {
    stdout: '',
    stderr: '',
    started: false,
    exitCode: null,
    cwd: '',
    command: '',
    workingDirectory: '',
  };
  shellAccums.set(toolCallID, state);

  if (event.event === 'stdout') {
    state.stdout += event.data || '';
    return true;
  }
  if (event.event === 'stderr') {
    state.stderr += event.data || '';
    return true;
  }
  if (event.event === 'start') {
    state.started = true;
    return true;
  }
  if (event.event === 'exit') {
    state.exitCode = Number(event.code) || 0;
    state.cwd = event.cwd || state.cwd || '';
    state.aborted = event.aborted === true;
  } else if (event.event === 'backgrounded') {
    state.backgrounded = true;
    state.command = event.command || state.command || '';
    state.workingDirectory = event.workingDirectory || state.workingDirectory || '';
    state.shellID = event.shellID || 0;
    state.pid = event.pid || 0;
    state.msToWait = event.msToWait || 0;
  } else if (event.event === 'rejected' || event.event === 'permission_denied') {
    state.kind = event.event;
    state.error = event.reason || event.error || event.event;
    state.command = event.command || state.command || '';
    state.workingDirectory = event.workingDirectory || state.workingDirectory || '';
    state.isReadonly = event.isReadonly === true;
  } else {
    state.kind = 'unknown';
    state.error = `Unsupported Cursor shell stream event: ${event.event || 'unknown'}`;
  }

  pendingToolResults.delete(toolCallID);
  unregisterToolAliases(toolCallID);
  shellAccums.delete(toolCallID);
  pending.resolve({
    toolCallID,
    execID: execMsg.execID || '',
    seq: execMsg.id || 0,
    execClientMessage: execMsg,
    shellResult: state,
    resultJSON: shellResultJSON(state),
  });
  return true;
}


export function deliverToolResult(execMsg) {
  if (!execMsg) return false;
  const toolCallID = execMsg.execID && execIDAliases.get(execMsg.execID)
    ? execIDAliases.get(execMsg.execID)
    : seqAliases.get(Number(execMsg.id));
  if (!toolCallID) return false;
  if (execMsg.resultType === 'shell_stream') {
    return deliverShellStreamResult(toolCallID, execMsg);
  }
  const pending = pendingToolResults.get(toolCallID);
  if (!pending) return false;
  pendingToolResults.delete(toolCallID);
  if (execMsg.execID) execIDAliases.delete(execMsg.execID);
  if (execMsg.id) seqAliases.delete(Number(execMsg.id));
  unregisterToolAliases(toolCallID);
  pending.resolve({
    toolCallID,
    execID: execMsg.execID || '',
    seq: execMsg.id || 0,
    execClientMessage: execMsg,
    resultJSON: resultJSONFromExecClient(execMsg),
  });
  return true;
}


export function resetToolWaitsForTest() {
  for (const [, pending] of pendingToolResults) {
    pending.reject(new Error('Cursor tool waits reset'));
  }
  pendingToolResults.clear();
  resetInteractionWaitsForTest();
  execIDAliases.clear();
  seqAliases.clear();
  shellAccums.clear();
  execSeqCounter = 0;
}

