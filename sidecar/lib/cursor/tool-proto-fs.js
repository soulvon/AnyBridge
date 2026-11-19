// sidecar/lib/cursor/tool-proto-fs.js — Cursor 文件读写、Shell、Glob/Ls 与 Grep 工具协议构造器

import { writeMessageField, writeStringField, writeVarintField } from '../../proto.js';
import { concat, writeBoolField } from './common.js';
import { nextExecSeq } from './exec-waits.js';

export function buildReadToolResult(readResult) {
  if (!readResult) return null;
  if (readResult.kind === 'success') {
    const content = readResult.content || (readResult.data ? readResult.data.toString('utf8') : '');
    const success = concat([
      content ? writeStringField(1, content) : null,
      writeBoolField(2, content.length === 0),
      writeBoolField(3, readResult.truncated === true),
      writeVarintField(4, Math.max(0, Number(readResult.totalLines) || 0)),
      writeVarintField(5, Math.max(0, Number(readResult.fileSize) || 0)),
      readResult.path ? writeStringField(7, readResult.path) : null,
    ]);
    return writeMessageField(1, success);
  }
  const message = readResult.error || readResult.reason || readResult.kind || 'Cursor Read tool failed';
  return writeMessageField(2, writeStringField(1, message));
}

export function buildReadToolCall({ path, offset, limit, includeLineNumbers, readResult } = {}) {
  const args = concat([
    writeStringField(1, String(path || '')),
    offset !== undefined && offset !== null ? writeVarintField(2, Number(offset) || 0) : null,
    limit !== undefined && limit !== null ? writeVarintField(3, Number(limit) || 0) : null,
    includeLineNumbers !== undefined && includeLineNumbers !== null
      ? writeBoolField(5, includeLineNumbers === true)
      : null,
  ]);
  return writeMessageField(8, concat([
    writeMessageField(1, args),
    readResult ? writeMessageField(2, buildReadToolResult(readResult)) : null,
  ]));
}

export function buildReadExecServerMessage({ seq, execID, path, toolCallID } = {}) {
  const id = Number(seq) || nextExecSeq();
  const callID = String(toolCallID || '');
  const readArgs = concat([
    writeStringField(1, String(path || '')),
    callID ? writeStringField(2, callID) : null,
  ]);
  return concat([
    writeVarintField(1, id),
    writeMessageField(7, readArgs),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildShellParsingResult(command) {
  const text = String(command || '');
  const executable = concat([
    writeStringField(1, text),
    writeStringField(3, text),
  ]);
  return concat([
    writeBoolField(1, false),
    text ? writeMessageField(2, executable) : null,
    writeBoolField(3, false),
    writeBoolField(4, false),
  ]);
}

function buildShellArgs({ command, workingDirectory, blockUntilMs, toolCallID } = {}) {
  const timeout = blockUntilMs === undefined || blockUntilMs === null
    ? 30000
    : Math.max(0, Number(blockUntilMs) || 0);
  const hardTimeout = Math.max(timeout, 86400000);
  return concat([
    writeStringField(1, String(command || '')),
    workingDirectory ? writeStringField(2, String(workingDirectory)) : null,
    writeVarintField(3, timeout),
    toolCallID ? writeStringField(4, String(toolCallID)) : null,
    command ? writeStringField(5, String(command)) : null,
    writeBoolField(6, false),
    writeBoolField(7, false),
    writeMessageField(8, buildShellParsingResult(command)),
    writeVarintField(10, 40000),
    writeBoolField(12, true),
    writeVarintField(13, 2),
    writeVarintField(14, hardTimeout),
  ]);
}

export function buildShellResult(shellResult, fallback = {}) {
  if (!shellResult) return null;
  const command = shellResult.command || fallback.command || '';
  const workingDirectory = shellResult.workingDirectory || shellResult.cwd || fallback.workingDirectory || '';
  if (shellResult.error) {
    if (shellResult.kind === 'rejected') {
      return writeMessageField(4, concat([
        command ? writeStringField(1, command) : null,
        workingDirectory ? writeStringField(2, workingDirectory) : null,
        writeStringField(3, shellResult.error),
        writeBoolField(4, shellResult.isReadonly === true),
      ]));
    }
    if (shellResult.kind === 'permission_denied') {
      return writeMessageField(7, concat([
        command ? writeStringField(1, command) : null,
        workingDirectory ? writeStringField(2, workingDirectory) : null,
        writeStringField(3, shellResult.error),
        writeBoolField(4, shellResult.isReadonly === true),
      ]));
    }
    return writeMessageField(5, concat([
      command ? writeStringField(1, command) : null,
      workingDirectory ? writeStringField(2, workingDirectory) : null,
      writeStringField(3, shellResult.error),
    ]));
  }
  const success = concat([
    command ? writeStringField(1, command) : null,
    workingDirectory ? writeStringField(2, workingDirectory) : null,
    writeVarintField(3, Number.isFinite(Number(shellResult.exitCode)) ? Number(shellResult.exitCode) : 0),
    writeStringField(5, shellResult.stdout || ''),
    writeStringField(6, shellResult.stderr || ''),
    shellResult.shellID ? writeVarintField(9, shellResult.shellID) : null,
    shellResult.pid ? writeVarintField(11, shellResult.pid) : null,
    shellResult.msToWait ? writeVarintField(12, shellResult.msToWait) : null,
  ]);
  return concat([
    writeMessageField(1, success),
    shellResult.backgrounded === true ? writeBoolField(102, true) : null,
    shellResult.pid ? writeVarintField(104, shellResult.pid) : null,
  ]);
}

export function buildShellToolCall({ command, workingDirectory, blockUntilMs, toolCallID, shellResult } = {}) {
  const args = buildShellArgs({ command, workingDirectory, blockUntilMs, toolCallID });
  return writeMessageField(1, concat([
    writeMessageField(1, args),
    shellResult ? writeMessageField(2, buildShellResult(shellResult, { command, workingDirectory })) : null,
  ]));
}

export function buildShellExecServerMessage({ seq, execID, command, workingDirectory, blockUntilMs, toolCallID } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(14, buildShellArgs({ command, workingDirectory, blockUntilMs, toolCallID })),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function countTextLines(text) {
  const value = String(text || '');
  if (!value) return 0;
  let count = 1;
  for (const char of value) {
    if (char === '\n') count += 1;
  }
  if (value.endsWith('\n')) count -= 1;
  return Math.max(0, count);
}

function buildEditResultFromWrite(writeResult, fallbackPath = '', fallbackContent = '') {
  if (!writeResult) {
    return writeMessageField(7, concat([
      fallbackPath ? writeStringField(1, fallbackPath) : null,
      writeStringField(2, 'Cursor Write tool result was missing write_result'),
    ]));
  }
  const pathValue = writeResult.path || fallbackPath || '';
  if (writeResult.kind === 'success') {
    const content = writeResult.fileContentAfterWrite || fallbackContent || '';
    const success = concat([
      pathValue ? writeStringField(1, pathValue) : null,
      writeVarintField(3, countTextLines(content)),
      writeStringField(7, content),
    ]);
    return writeMessageField(1, success);
  }
  if (writeResult.kind === 'permission_denied') {
    return writeMessageField(4, concat([
      pathValue ? writeStringField(1, pathValue) : null,
      writeStringField(2, writeResult.error || 'Permission denied'),
      writeBoolField(3, writeResult.isReadonly === true),
    ]));
  }
  if (writeResult.kind === 'rejected') {
    return writeMessageField(6, concat([
      pathValue ? writeStringField(1, pathValue) : null,
      writeStringField(2, writeResult.reason || 'Rejected'),
    ]));
  }
  return writeMessageField(7, concat([
    pathValue ? writeStringField(1, pathValue) : null,
    writeStringField(2, writeResult.error || writeResult.reason || writeResult.kind || 'Cursor Write tool failed'),
  ]));
}

export function buildEditToolCall({ path: editPath, streamContent, writeResult } = {}) {
  const args = concat([
    writeStringField(1, String(editPath || '')),
    streamContent !== undefined && streamContent !== null
      ? writeStringField(6, String(streamContent))
      : null,
  ]);
  return writeMessageField(12, concat([
    writeMessageField(1, args),
    writeResult ? writeMessageField(2, buildEditResultFromWrite(writeResult, editPath, streamContent)) : null,
  ]));
}

export function buildWriteExecServerMessage({ seq, execID, path: writePath, fileText, toolCallID, returnFileContentAfterWrite = true } = {}) {
  const id = Number(seq) || nextExecSeq();
  const callID = String(toolCallID || '');
  const writeArgs = concat([
    writeStringField(1, String(writePath || '')),
    writeStringField(2, String(fileText || '')),
    callID ? writeStringField(3, callID) : null,
    writeBoolField(4, returnFileContentAfterWrite === true),
  ]);
  return concat([
    writeVarintField(1, id),
    writeMessageField(3, writeArgs),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildDeleteToolResult({ deleteResultRaw, deleteResult } = {}) {
  if (Buffer.isBuffer(deleteResultRaw)) return deleteResultRaw;
  if (!deleteResult) {
    return writeMessageField(7, writeStringField(2, 'Cursor Delete tool result was missing delete_result'));
  }
  const pathValue = deleteResult.path || '';
  if (deleteResult.kind === 'success') {
    return writeMessageField(1, concat([
      pathValue ? writeStringField(1, pathValue) : null,
      deleteResult.deletedFile ? writeStringField(2, deleteResult.deletedFile) : null,
      writeVarintField(3, Math.max(0, Number(deleteResult.fileSize) || 0)),
      deleteResult.prevContent ? writeStringField(4, deleteResult.prevContent) : null,
    ]));
  }
  if (deleteResult.kind === 'file_not_found') return writeMessageField(2, writeStringField(1, pathValue));
  if (deleteResult.kind === 'not_file') {
    return writeMessageField(3, concat([
      pathValue ? writeStringField(1, pathValue) : null,
      deleteResult.actualType ? writeStringField(2, deleteResult.actualType) : null,
    ]));
  }
  if (deleteResult.kind === 'permission_denied') {
    return writeMessageField(4, concat([
      pathValue ? writeStringField(1, pathValue) : null,
      writeStringField(2, deleteResult.clientVisibleError || deleteResult.error || 'Permission denied'),
      writeBoolField(3, deleteResult.isReadonly === true),
    ]));
  }
  if (deleteResult.kind === 'file_busy') return writeMessageField(5, writeStringField(1, pathValue));
  if (deleteResult.kind === 'rejected') {
    return writeMessageField(6, concat([
      pathValue ? writeStringField(1, pathValue) : null,
      writeStringField(2, deleteResult.reason || 'Rejected'),
    ]));
  }
  return writeMessageField(7, concat([
    pathValue ? writeStringField(1, pathValue) : null,
    writeStringField(2, deleteResult.error || deleteResult.reason || deleteResult.kind || 'Cursor Delete tool failed'),
  ]));
}

export function buildDeleteToolCall({ path: deletePath, toolCallID, deleteResultRaw, deleteResult } = {}) {
  const args = concat([
    writeStringField(1, String(deletePath || '')),
    toolCallID ? writeStringField(2, String(toolCallID)) : null,
  ]);
  return writeMessageField(3, concat([
    writeMessageField(1, args),
    (deleteResultRaw || deleteResult) ? writeMessageField(2, buildDeleteToolResult({ deleteResultRaw, deleteResult })) : null,
  ]));
}

export function buildDeleteExecServerMessage({ seq, execID, path: deletePath, toolCallID } = {}) {
  const id = Number(seq) || nextExecSeq();
  const args = concat([
    writeStringField(1, String(deletePath || '')),
    toolCallID ? writeStringField(2, String(toolCallID)) : null,
  ]);
  return concat([
    writeVarintField(1, id),
    writeMessageField(4, args),
    execID ? writeStringField(15, execID) : null,
  ]);
}

export function buildGlobToolResult(globResult) {
  if (!globResult) return null;
  if (globResult.kind === 'success') {
    const success = concat([
      writeStringField(1, String(globResult.pattern || '')),
      writeStringField(2, String(globResult.path || '')),
      ...(globResult.files || []).map(file => writeStringField(3, String(file || ''))),
      writeVarintField(4, Math.max(0, Number(globResult.totalFiles ?? globResult.files?.length) || 0)),
      writeBoolField(5, globResult.clientTruncated === true),
      writeBoolField(6, globResult.ripgrepTruncated === true),
    ]);
    return writeMessageField(1, success);
  }
  return writeMessageField(2, writeStringField(1, globResult.error || 'Cursor Glob tool failed'));
}

export function buildGlobToolCall({ globPattern, targetDirectory, globResult } = {}) {
  const args = concat([
    targetDirectory ? writeStringField(1, String(targetDirectory)) : null,
    writeStringField(2, String(globPattern || '')),
  ]);
  return writeMessageField(4, concat([
    writeMessageField(1, args),
    globResult ? writeMessageField(2, buildGlobToolResult(globResult)) : null,
  ]));
}

export function buildLsExecServerMessage({ seq, execID, path: lsPath, toolCallID, timeoutMs } = {}) {
  const id = Number(seq) || nextExecSeq();
  const callID = String(toolCallID || '');
  const args = concat([
    writeStringField(1, String(lsPath || '.')),
    callID ? writeStringField(3, callID) : null,
    timeoutMs !== undefined && timeoutMs !== null
      ? writeVarintField(5, Math.max(1, Number(timeoutMs) || 1))
      : null,
  ]);
  return concat([
    writeVarintField(1, id),
    writeMessageField(8, args),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildGrepArgs({
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
} = {}) {
  return concat([
    writeStringField(1, String(pattern || '')),
    grepPath ? writeStringField(2, String(grepPath)) : null,
    glob ? writeStringField(3, String(glob)) : null,
    outputMode ? writeStringField(4, String(outputMode)) : null,
    contextBefore !== undefined && contextBefore !== null ? writeVarintField(5, Number(contextBefore) || 0) : null,
    contextAfter !== undefined && contextAfter !== null ? writeVarintField(6, Number(contextAfter) || 0) : null,
    context !== undefined && context !== null ? writeVarintField(7, Number(context) || 0) : null,
    caseInsensitive !== undefined && caseInsensitive !== null ? writeBoolField(8, caseInsensitive === true) : null,
    type ? writeStringField(9, String(type)) : null,
    headLimit !== undefined && headLimit !== null ? writeVarintField(10, Math.max(0, Number(headLimit) || 0)) : null,
    multiline !== undefined && multiline !== null ? writeBoolField(11, multiline === true) : null,
    sort ? writeStringField(12, String(sort)) : null,
    sortAscending !== undefined && sortAscending !== null ? writeBoolField(13, sortAscending === true) : null,
    toolCallID ? writeStringField(14, String(toolCallID)) : null,
  ]);
}

function buildGrepToolResult({ grepResultRaw, error } = {}) {
  if (Buffer.isBuffer(grepResultRaw)) return grepResultRaw;
  return writeMessageField(2, writeStringField(1, error || 'Cursor Grep tool failed'));
}

export function buildGrepToolCall({ grepResultRaw, error, ...args } = {}) {
  return writeMessageField(5, concat([
    writeMessageField(1, buildGrepArgs(args)),
    (grepResultRaw || error) ? writeMessageField(2, buildGrepToolResult({ grepResultRaw, error })) : null,
  ]));
}

export function buildGrepExecServerMessage({ seq, execID, ...args } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(5, buildGrepArgs(args)),
    execID ? writeStringField(15, execID) : null,
  ]);
}
