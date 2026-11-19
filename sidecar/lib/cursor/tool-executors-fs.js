// lib/cursor/tool-executors-fs.js - Modular component split from cursor-proxy.js.

import fs from "node:fs";
import path from "node:path";
import { nextExecSeq, registerExecIDAlias, registerToolWait, rejectToolWait } from "./exec-waits.js";
import { buildDeleteExecServerMessage, buildDeleteToolCall, buildEditToolCall, buildExecServerFrame, buildGlobToolCall, buildGrepExecServerMessage, buildGrepToolCall, buildLsExecServerMessage, buildReadExecServerMessage, buildReadToolCall, buildShellExecServerMessage, buildShellToolCall, buildToolCallCompletedFrame, buildToolCallStartedFrame, buildWriteExecServerMessage, newCursorExecID, writeRunFrame } from "./tool-proto-builders.js";

export async function executeReadCursorTool(res, { callID, path: readPath, offset, limit, includeLineNumbers, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor Read tool call is missing call_id');
  if (!readPath) throw new Error(`Cursor Read tool call ${toolCallID} is missing path`);
  const startTool = buildReadToolCall({ path: readPath, offset, limit, includeLineNumbers });
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor Read tool call ${toolCallID} failed to write started frame`);
  }
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID('read');
  const wait = registerToolWait(toolCallID, timeoutMs);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  const execFrame = buildExecServerFrame(buildReadExecServerMessage({
    seq: actualSeq,
    execID: actualExecID,
    path: readPath,
    toolCallID,
  }));
  if (!writeRunFrame(res, execFrame)) {
    const err = new Error(`Cursor Read tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    const completedTool = buildReadToolCall({
      path: readPath,
      offset,
      limit,
      includeLineNumbers,
      readResult: result.execClientMessage?.readResult || {
        kind: 'error',
        error: 'Cursor Read tool result was missing read_result',
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return result;
  } catch (err) {
    const completedTool = buildReadToolCall({
      path: readPath,
      offset,
      limit,
      includeLineNumbers,
      readResult: {
        kind: 'error',
        error: err.message || String(err),
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}


export async function executeShellCursorTool(res, { callID, command, workingDirectory, blockUntilMs, timeoutMs, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor Shell tool call is missing call_id');
  if (!command) throw new Error(`Cursor Shell tool call ${toolCallID} is missing command`);
  const waitTimeout = timeoutMs || Math.max(30000, (Number(blockUntilMs) || 30000) + 30000);
  const startTool = buildShellToolCall({ command, workingDirectory, blockUntilMs, toolCallID });
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor Shell tool call ${toolCallID} failed to write started frame`);
  }
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID('shell');
  const wait = registerToolWait(toolCallID, waitTimeout);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  const execFrame = buildExecServerFrame(buildShellExecServerMessage({
    seq: actualSeq,
    execID: actualExecID,
    command,
    workingDirectory,
    blockUntilMs,
    toolCallID,
  }));
  if (!writeRunFrame(res, execFrame)) {
    const err = new Error(`Cursor Shell tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    const completedTool = buildShellToolCall({
      command,
      workingDirectory,
      blockUntilMs,
      toolCallID,
      shellResult: result.shellResult || {
        command,
        workingDirectory,
        error: 'Cursor Shell tool result was missing shell_stream exit/backgrounded event',
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return result;
  } catch (err) {
    const completedTool = buildShellToolCall({
      command,
      workingDirectory,
      blockUntilMs,
      toolCallID,
      shellResult: {
        command,
        workingDirectory,
        error: err.message || String(err),
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}


export async function executeWriteCursorTool(res, { callID, path: writePath, contents, timeoutMs = 30000, execID, seq, modelCallID = '', skipStarted = false } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor Write tool call is missing call_id');
  if (!writePath) throw new Error(`Cursor Write tool call ${toolCallID} is missing path`);
  if (contents === undefined || contents === null) throw new Error(`Cursor Write tool call ${toolCallID} is missing contents`);
  const fileText = String(contents);
  if (!skipStarted) {
    const startTool = buildEditToolCall({ path: writePath, streamContent: fileText });
    if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
      throw new Error(`Cursor Write tool call ${toolCallID} failed to write started frame`);
    }
  }
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID('write');
  const wait = registerToolWait(toolCallID, timeoutMs);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  const execFrame = buildExecServerFrame(buildWriteExecServerMessage({
    seq: actualSeq,
    execID: actualExecID,
    path: writePath,
    fileText,
    toolCallID,
  }));
  if (!writeRunFrame(res, execFrame)) {
    const err = new Error(`Cursor Write tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    const missingResultError = result.execClientMessage?.writeResult
      ? ''
      : 'Cursor Write tool result was missing write_result';
    const writeResult = result.execClientMessage?.writeResult || {
      kind: 'error',
      path: writePath,
      error: missingResultError,
    };
    const completedTool = buildEditToolCall({ path: writePath, streamContent: fileText, writeResult });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return missingResultError
      ? { ...result, resultJSON: JSON.stringify({ error: missingResultError, path: writePath }) }
      : result;
  } catch (err) {
    const completedTool = buildEditToolCall({
      path: writePath,
      streamContent: fileText,
      writeResult: {
        kind: 'error',
        path: writePath,
        error: err.message || String(err),
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}


export function applyStrReplaceToFile(filePath, oldString, newString, replaceAll = false) {
  if (!filePath) throw new Error('StrReplace path is required');
  if (oldString === undefined || oldString === null || String(oldString) === '') {
    throw new Error('StrReplace old_string is required and cannot be empty');
  }
  if (newString === undefined || newString === null) {
    throw new Error('StrReplace new_string is required');
  }
  const before = fs.readFileSync(filePath, 'utf8');
  const oldValue = String(oldString);
  const newValue = String(newString);
  if (before.includes(oldValue)) {
    const count = before.split(oldValue).length - 1;
    if (!replaceAll && count > 1) {
      throw new Error('StrReplace old_string matches multiple locations; use replace_all or provide more context');
    }
    return replaceAll ? before.split(oldValue).join(newValue) : before.replace(oldValue, newValue);
  }
  const normalizedBefore = before.replace(/\r\n/g, '\n');
  const normalizedOld = oldValue.replace(/\r\n/g, '\n');
  if (!normalizedBefore.includes(normalizedOld)) {
    throw new Error(`StrReplace old_string not found in ${filePath}`);
  }
  const count = normalizedBefore.split(normalizedOld).length - 1;
  if (!replaceAll && count > 1) {
    throw new Error('StrReplace old_string matches multiple locations; use replace_all or provide more context');
  }
  const normalizedNew = newValue.replace(/\r\n/g, '\n');
  const normalizedAfter = replaceAll
    ? normalizedBefore.split(normalizedOld).join(normalizedNew)
    : normalizedBefore.replace(normalizedOld, normalizedNew);
  return before.includes('\r\n') ? normalizedAfter.replace(/\n/g, '\r\n') : normalizedAfter;
}


export async function executeStrReplaceCursorTool(res, { callID, path: editPath, oldString, newString, replaceAll, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor StrReplace tool call is missing call_id');
  if (!editPath) throw new Error(`Cursor StrReplace tool call ${toolCallID} is missing path`);
  const startTool = buildEditToolCall({ path: editPath });
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor StrReplace tool call ${toolCallID} failed to write started frame`);
  }
  let contents;
  try {
    contents = applyStrReplaceToFile(editPath, oldString, newString, replaceAll === true);
  } catch (err) {
    const message = err.message || String(err);
    const completedTool = buildEditToolCall({
      path: editPath,
      writeResult: {
        kind: 'error',
        path: editPath,
        error: message,
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return {
      resultJSON: JSON.stringify({
        error: message,
        path: editPath || '',
        kind: 'error',
      }),
    };
  }
  return executeWriteCursorTool(res, {
    callID,
    path: editPath,
    contents,
    timeoutMs,
    execID,
    seq,
    modelCallID,
    skipStarted: true,
  });
}


export async function executeDeleteCursorTool(res, { callID, path: deletePath, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor Delete tool call is missing call_id');
  if (!deletePath) throw new Error(`Cursor Delete tool call ${toolCallID} is missing path`);
  const startTool = buildDeleteToolCall({ path: deletePath, toolCallID });
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor Delete tool call ${toolCallID} failed to write started frame`);
  }
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID('delete');
  const wait = registerToolWait(toolCallID, timeoutMs);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  const execFrame = buildExecServerFrame(buildDeleteExecServerMessage({
    seq: actualSeq,
    execID: actualExecID,
    path: deletePath,
    toolCallID,
  }));
  if (!writeRunFrame(res, execFrame)) {
    const err = new Error(`Cursor Delete tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    const missingResultError = result.execClientMessage?.deleteResultRaw
      ? ''
      : 'Cursor Delete tool result was missing delete_result';
    const completedTool = buildDeleteToolCall({
      path: deletePath,
      toolCallID,
      deleteResultRaw: result.execClientMessage?.deleteResultRaw,
      deleteResult: result.execClientMessage?.deleteResult || {
        kind: 'error',
        path: deletePath,
        error: missingResultError,
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return missingResultError
      ? { ...result, resultJSON: JSON.stringify({ error: missingResultError, path: deletePath }) }
      : result;
  } catch (err) {
    const completedTool = buildDeleteToolCall({
      path: deletePath,
      toolCallID,
      deleteResult: {
        kind: 'error',
        path: deletePath,
        error: err.message || String(err),
      },
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}


function normalizeCursorPathForMatch(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}


function joinCursorPath(left, right) {
  const base = String(left || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const name = String(right || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!base) return name;
  if (!name) return base;
  return `${base}/${name}`;
}


function normalizeGlobPattern(pattern) {
  const value = String(pattern || '').trim().replace(/\\/g, '/');
  if (!value) return '';
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return value;
  return value.startsWith('**/') ? value : `**/${value}`;
}


function escapeRegexChar(char) {
  return /[.+()|^${}[\]\\]/.test(char) ? `\\${char}` : char;
}


export function globToRegex(pattern) {
  const normalized = normalizeGlobPattern(pattern);
  if (!normalized) return null;
  let body = '';
  for (let i = 0; i < normalized.length;) {
    if (normalized.slice(i, i + 3) === '**/') {
      body += '(?:.*[/\\\\])?';
      i += 3;
      continue;
    }
    if (normalized.slice(i, i + 2) === '**') {
      body += '.*';
      i += 2;
      continue;
    }
    const char = normalized[i];
    if (char === '*') {
      body += '[^/\\\\]*';
    } else if (char === '?') {
      body += '[^/\\\\]';
    } else if (char === '/') {
      body += '[/\\\\]';
    } else {
      body += escapeRegexChar(char);
    }
    i += 1;
  }
  return new RegExp(`^${body}$`);
}


function relativeCursorPath(fullPath, rootPath) {
  const full = normalizeCursorPathForMatch(fullPath);
  const root = normalizeCursorPathForMatch(rootPath);
  if (!root || root === '.') return full;
  const fullLower = full.toLowerCase();
  const rootLower = root.toLowerCase();
  if (fullLower === rootLower) return '';
  if (fullLower.startsWith(`${rootLower}/`)) return full.slice(root.length + 1);
  return full;
}


export function collectGlobMatches(root, rootPath, pattern) {
  if (!root) return [];
  const re = globToRegex(pattern);
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const base = node.absPath || rootPath || '';
    for (const file of node.childrenFiles || []) {
      const full = joinCursorPath(base, file.name);
      const rel = relativeCursorPath(full, rootPath);
      if (!re || re.test(rel) || re.test(normalizeCursorPathForMatch(full))) {
        out.push(full);
      }
    }
    for (const child of node.childrenDirs || []) walk(child);
  };
  walk(root);
  return out;
}


export function globResultFromLsResult(lsResult, rootPath, pattern) {
  const pathValue = rootPath || '.';
  if (!lsResult) {
    return { kind: 'error', error: 'Cursor Glob tool result was missing ls_result', pattern, path: pathValue };
  }
  if (lsResult.kind === 'success' || lsResult.kind === 'timeout') {
    const files = collectGlobMatches(lsResult.directoryTreeRoot, pathValue, pattern);
    return {
      kind: 'success',
      pattern,
      path: pathValue,
      files,
      totalFiles: files.length,
      clientTruncated: lsResult.kind === 'timeout',
      ripgrepTruncated: false,
    };
  }
  return {
    kind: 'error',
    pattern,
    path: lsResult.path || pathValue,
    error: lsResult.error || lsResult.reason || lsResult.kind || 'Cursor Glob tool failed',
  };
}


function globResultJSON(globResult) {
  if (globResult?.kind === 'success') {
    return JSON.stringify({
      pattern: globResult.pattern || '',
      path: globResult.path || '',
      files: globResult.files || [],
      total_files: globResult.totalFiles || 0,
      client_truncated: globResult.clientTruncated === true,
      ripgrep_truncated: globResult.ripgrepTruncated === true,
    });
  }
  return JSON.stringify({
    error: globResult?.error || 'Cursor Glob tool failed',
    path: globResult?.path || '',
    pattern: globResult?.pattern || '',
    kind: globResult?.kind || 'error',
  });
}


export async function executeGlobCursorTool(res, { callID, globPattern, targetDirectory, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor Glob tool call is missing call_id');
  if (!globPattern) throw new Error(`Cursor Glob tool call ${toolCallID} is missing glob_pattern`);
  const lsPath = targetDirectory || '.';
  const startTool = buildGlobToolCall({ globPattern, targetDirectory });
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor Glob tool call ${toolCallID} failed to write started frame`);
  }
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID('glob');
  const wait = registerToolWait(toolCallID, timeoutMs);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  const execFrame = buildExecServerFrame(buildLsExecServerMessage({
    seq: actualSeq,
    execID: actualExecID,
    path: lsPath,
    toolCallID,
    timeoutMs,
  }));
  if (!writeRunFrame(res, execFrame)) {
    const err = new Error(`Cursor Glob tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    const globResult = globResultFromLsResult(result.execClientMessage?.lsResult, lsPath, globPattern);
    const completedTool = buildGlobToolCall({ globPattern, targetDirectory, globResult });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return { ...result, resultJSON: globResultJSON(globResult), globResult };
  } catch (err) {
    const globResult = {
      kind: 'error',
      pattern: globPattern,
      path: lsPath,
      error: err.message || String(err),
    };
    const completedTool = buildGlobToolCall({ globPattern, targetDirectory, globResult });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}


export async function executeGrepCursorTool(res, { callID, pattern, path: grepPath, glob, outputMode, contextBefore, contextAfter, context, caseInsensitive, type, headLimit, multiline, sort, sortAscending, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(callID || '');
  if (!toolCallID) throw new Error('Cursor Grep tool call is missing call_id');
  if (!pattern) throw new Error(`Cursor Grep tool call ${toolCallID} is missing pattern`);
  const args = {
    pattern,
    path: grepPath,
    glob,
    outputMode,
    contextBefore,
    contextAfter,
    context,
    caseInsensitive,
    type,
    headLimit,
    multiline,
    sort,
    sortAscending,
    toolCallID,
  };
  const startTool = buildGrepToolCall(args);
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor Grep tool call ${toolCallID} failed to write started frame`);
  }
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID('grep');
  const wait = registerToolWait(toolCallID, timeoutMs);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  const execFrame = buildExecServerFrame(buildGrepExecServerMessage({
    seq: actualSeq,
    execID: actualExecID,
    ...args,
  }));
  if (!writeRunFrame(res, execFrame)) {
    const err = new Error(`Cursor Grep tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    const missingResultError = result.execClientMessage?.grepResultRaw
      ? ''
      : 'Cursor Grep tool result was missing grep_result';
    const completedTool = buildGrepToolCall({
      ...args,
      grepResultRaw: result.execClientMessage?.grepResultRaw,
      error: missingResultError,
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return missingResultError
      ? { ...result, resultJSON: JSON.stringify({ error: missingResultError }) }
      : result;
  } catch (err) {
    const completedTool = buildGrepToolCall({
      ...args,
      error: err.message || String(err),
    });
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}


export function parseToolArguments(toolCall) {
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Cursor tool ${toolCall.name} has invalid JSON arguments: ${err.message || String(err)}`);
  }
}

