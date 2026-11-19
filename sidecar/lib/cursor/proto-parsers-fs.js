// lib/cursor/proto-parsers-fs.js - Modular component split from cursor-proxy.js.

import path from "node:path";
import { fieldToInt, fieldToString, getAllFields, getField, parseFields } from "../../proto.js";

function parseReadSuccess(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'success',
    path: fieldToString(getField(fields, 1, 2)),
    content: fieldToString(getField(fields, 2, 2)),
    totalLines: fieldToInt(getField(fields, 3, 0)),
    fileSize: fieldToInt(getField(fields, 4, 0)),
    data: getField(fields, 5, 2)?.value || null,
    truncated: fieldToInt(getField(fields, 6, 0)) === 1,
  };
}


function parseReadErrorLike(buf, kind) {
  const fields = parseFields(buf);
  return {
    kind,
    path: fieldToString(getField(fields, 1, 2)),
    error: fieldToString(getField(fields, 2, 2)) || fieldToString(getField(fields, 2, 2)),
    reason: fieldToString(getField(fields, 2, 2)),
  };
}


export function parseReadResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) return parseReadSuccess(success.value);
  const error = getField(fields, 2, 2);
  if (error) return parseReadErrorLike(error.value, 'error');
  const rejected = getField(fields, 3, 2);
  if (rejected) return parseReadErrorLike(rejected.value, 'rejected');
  const notFound = getField(fields, 4, 2);
  if (notFound) return parseReadErrorLike(notFound.value, 'file_not_found');
  const denied = getField(fields, 5, 2);
  if (denied) return parseReadErrorLike(denied.value, 'permission_denied');
  const invalid = getField(fields, 6, 2);
  if (invalid) return parseReadErrorLike(invalid.value, 'invalid_file');
  return { kind: 'unknown' };
}


function parseWriteSuccess(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'success',
    path: fieldToString(getField(fields, 1, 2)),
    linesCreated: fieldToInt(getField(fields, 2, 0)),
    fileSize: fieldToInt(getField(fields, 3, 0)),
    fileContentAfterWrite: fieldToString(getField(fields, 4, 2)),
  };
}


function parseWritePermissionDenied(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'permission_denied',
    path: fieldToString(getField(fields, 1, 2)),
    directory: fieldToString(getField(fields, 2, 2)),
    operation: fieldToString(getField(fields, 3, 2)),
    error: fieldToString(getField(fields, 4, 2)),
    isReadonly: fieldToInt(getField(fields, 5, 0)) === 1,
  };
}


function parseWritePathError(buf, kind) {
  const fields = parseFields(buf);
  return {
    kind,
    path: fieldToString(getField(fields, 1, 2)),
    error: fieldToString(getField(fields, 2, 2)),
    reason: fieldToString(getField(fields, 2, 2)),
  };
}


export function parseWriteResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) return parseWriteSuccess(success.value);
  const permissionDenied = getField(fields, 3, 2);
  if (permissionDenied) return parseWritePermissionDenied(permissionDenied.value);
  const noSpace = getField(fields, 4, 2);
  if (noSpace) return parseWritePathError(noSpace.value, 'no_space');
  const error = getField(fields, 5, 2);
  if (error) return parseWritePathError(error.value, 'error');
  const rejected = getField(fields, 6, 2);
  if (rejected) return parseWritePathError(rejected.value, 'rejected');
  return { kind: 'unknown' };
}


function parseDeleteSuccess(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'success',
    path: fieldToString(getField(fields, 1, 2)),
    deletedFile: fieldToString(getField(fields, 2, 2)),
    fileSize: fieldToInt(getField(fields, 3, 0)),
    prevContent: fieldToString(getField(fields, 4, 2)),
  };
}


function parseDeletePathError(buf, kind) {
  const fields = parseFields(buf);
  return {
    kind,
    path: fieldToString(getField(fields, 1, 2)),
    error: fieldToString(getField(fields, 2, 2)),
    reason: fieldToString(getField(fields, 2, 2)),
    actualType: fieldToString(getField(fields, 2, 2)),
    clientVisibleError: fieldToString(getField(fields, 2, 2)),
    isReadonly: fieldToInt(getField(fields, 3, 0)) === 1,
  };
}


export function parseDeleteResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) return parseDeleteSuccess(success.value);
  const fileNotFound = getField(fields, 2, 2);
  if (fileNotFound) return parseDeletePathError(fileNotFound.value, 'file_not_found');
  const notFile = getField(fields, 3, 2);
  if (notFile) return parseDeletePathError(notFile.value, 'not_file');
  const permissionDenied = getField(fields, 4, 2);
  if (permissionDenied) return parseDeletePathError(permissionDenied.value, 'permission_denied');
  const fileBusy = getField(fields, 5, 2);
  if (fileBusy) return parseDeletePathError(fileBusy.value, 'file_busy');
  const rejected = getField(fields, 6, 2);
  if (rejected) return parseDeletePathError(rejected.value, 'rejected');
  const error = getField(fields, 7, 2);
  if (error) return parseDeletePathError(error.value, 'error');
  return { kind: 'unknown' };
}


function parseShellCommandErrorLike(buf, kind) {
  const fields = parseFields(buf);
  return {
    event: kind,
    command: fieldToString(getField(fields, 1, 2)),
    workingDirectory: fieldToString(getField(fields, 2, 2)),
    error: fieldToString(getField(fields, 3, 2)),
    reason: fieldToString(getField(fields, 3, 2)),
    isReadonly: fieldToInt(getField(fields, 4, 0)) === 1,
  };
}


export function parseShellStream(buf) {
  const fields = parseFields(buf);
  const stdout = getField(fields, 1, 2);
  if (stdout) {
    return {
      event: 'stdout',
      data: fieldToString(getField(parseFields(stdout.value), 1, 2)),
    };
  }
  const stderr = getField(fields, 2, 2);
  if (stderr) {
    return {
      event: 'stderr',
      data: fieldToString(getField(parseFields(stderr.value), 1, 2)),
    };
  }
  const exit = getField(fields, 3, 2);
  if (exit) {
    const exitFields = parseFields(exit.value);
    return {
      event: 'exit',
      code: fieldToInt(getField(exitFields, 1, 0)),
      cwd: fieldToString(getField(exitFields, 2, 2)),
      aborted: fieldToInt(getField(exitFields, 4, 0)) === 1,
      abortReason: fieldToInt(getField(exitFields, 5, 0)),
    };
  }
  if (getField(fields, 4, 2)) return { event: 'start' };
  const rejected = getField(fields, 5, 2);
  if (rejected) return parseShellCommandErrorLike(rejected.value, 'rejected');
  const permissionDenied = getField(fields, 6, 2);
  if (permissionDenied) return parseShellCommandErrorLike(permissionDenied.value, 'permission_denied');
  const backgrounded = getField(fields, 7, 2);
  if (backgrounded) {
    const bgFields = parseFields(backgrounded.value);
    return {
      event: 'backgrounded',
      shellID: fieldToInt(getField(bgFields, 1, 0)),
      command: fieldToString(getField(bgFields, 2, 2)),
      workingDirectory: fieldToString(getField(bgFields, 3, 2)),
      pid: fieldToInt(getField(bgFields, 4, 0)),
      msToWait: fieldToInt(getField(bgFields, 5, 0)),
    };
  }
  return { event: 'unknown' };
}


function parseLsDirectoryTreeFile(buf) {
  const fields = parseFields(buf);
  return {
    name: fieldToString(getField(fields, 1, 2)),
  };
}


function parseLsDirectoryTreeNode(buf) {
  const fields = parseFields(buf);
  return {
    absPath: fieldToString(getField(fields, 1, 2)),
    childrenDirs: getAllFields(fields, 2)
      .filter(field => field.wireType === 2)
      .map(field => parseLsDirectoryTreeNode(field.value)),
    childrenFiles: getAllFields(fields, 3)
      .filter(field => field.wireType === 2)
      .map(field => parseLsDirectoryTreeFile(field.value)),
    childrenWereProcessed: fieldToInt(getField(fields, 4, 0)) === 1,
    numFiles: fieldToInt(getField(fields, 6, 0)),
  };
}


function parseLsErrorLike(buf, kind) {
  const fields = parseFields(buf);
  return {
    kind,
    path: fieldToString(getField(fields, 1, 2)),
    error: fieldToString(getField(fields, 2, 2)),
    reason: fieldToString(getField(fields, 2, 2)),
  };
}


function parseLsTreeContainer(buf, kind) {
  const root = getField(parseFields(buf), 1, 2);
  return {
    kind,
    directoryTreeRoot: root ? parseLsDirectoryTreeNode(root.value) : null,
  };
}


export function parseLsResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) return parseLsTreeContainer(success.value, 'success');
  const error = getField(fields, 2, 2);
  if (error) return parseLsErrorLike(error.value, 'error');
  const rejected = getField(fields, 3, 2);
  if (rejected) return parseLsErrorLike(rejected.value, 'rejected');
  const timeout = getField(fields, 4, 2);
  if (timeout) return parseLsTreeContainer(timeout.value, 'timeout');
  return { kind: 'unknown' };
}


function parseGrepContentMatch(buf) {
  const fields = parseFields(buf);
  return {
    lineNumber: fieldToInt(getField(fields, 1, 0)),
    content: fieldToString(getField(fields, 2, 2)),
    contentTruncated: fieldToInt(getField(fields, 3, 0)) === 1,
    isContextLine: fieldToInt(getField(fields, 4, 0)) === 1,
  };
}


function parseGrepFileMatch(buf) {
  const fields = parseFields(buf);
  return {
    file: fieldToString(getField(fields, 1, 2)),
    matches: getAllFields(fields, 2)
      .filter(field => field.wireType === 2)
      .map(field => parseGrepContentMatch(field.value)),
  };
}


function parseGrepContentResult(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'content',
    matches: getAllFields(fields, 1)
      .filter(field => field.wireType === 2)
      .map(field => parseGrepFileMatch(field.value)),
    totalLines: fieldToInt(getField(fields, 2, 0)),
    totalMatchedLines: fieldToInt(getField(fields, 3, 0)),
    clientTruncated: fieldToInt(getField(fields, 4, 0)) === 1,
    ripgrepTruncated: fieldToInt(getField(fields, 5, 0)) === 1,
  };
}


function parseGrepFileCount(buf) {
  const fields = parseFields(buf);
  return {
    file: fieldToString(getField(fields, 1, 2)),
    count: fieldToInt(getField(fields, 2, 0)),
  };
}


function parseGrepCountResult(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'count',
    counts: getAllFields(fields, 1)
      .filter(field => field.wireType === 2)
      .map(field => parseGrepFileCount(field.value)),
    totalFiles: fieldToInt(getField(fields, 2, 0)),
    totalMatches: fieldToInt(getField(fields, 3, 0)),
    clientTruncated: fieldToInt(getField(fields, 4, 0)) === 1,
    ripgrepTruncated: fieldToInt(getField(fields, 5, 0)) === 1,
  };
}


function parseGrepFilesResult(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'files',
    files: getAllFields(fields, 1)
      .filter(field => field.wireType === 2)
      .map(field => field.value.toString('utf8')),
    totalFiles: fieldToInt(getField(fields, 2, 0)),
    clientTruncated: fieldToInt(getField(fields, 3, 0)) === 1,
    ripgrepTruncated: fieldToInt(getField(fields, 4, 0)) === 1,
  };
}


function parseGrepUnionResult(buf) {
  const fields = parseFields(buf);
  const count = getField(fields, 1, 2);
  if (count) return parseGrepCountResult(count.value);
  const files = getField(fields, 2, 2);
  if (files) return parseGrepFilesResult(files.value);
  const content = getField(fields, 3, 2);
  if (content) return parseGrepContentResult(content.value);
  return { kind: 'unknown' };
}


function parseGrepWorkspaceEntry(buf) {
  const fields = parseFields(buf);
  const key = fieldToString(getField(fields, 1, 2));
  const value = getField(fields, 2, 2);
  return {
    key,
    value: value ? parseGrepUnionResult(value.value) : { kind: 'unknown' },
  };
}


function parseGrepSuccess(buf) {
  const fields = parseFields(buf);
  const workspaceResults = {};
  for (const field of getAllFields(fields, 4).filter(item => item.wireType === 2)) {
    const entry = parseGrepWorkspaceEntry(field.value);
    if (entry.key) workspaceResults[entry.key] = entry.value;
  }
  const active = getField(fields, 5, 2);
  return {
    kind: 'success',
    pattern: fieldToString(getField(fields, 1, 2)),
    path: fieldToString(getField(fields, 2, 2)),
    outputMode: fieldToString(getField(fields, 3, 2)),
    workspaceResults,
    activeEditorResult: active ? parseGrepUnionResult(active.value) : null,
  };
}


export function parseGrepResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) return parseGrepSuccess(success.value);
  const error = getField(fields, 2, 2);
  if (error) {
    return {
      kind: 'error',
      error: fieldToString(getField(parseFields(error.value), 1, 2)),
    };
  }
  return { kind: 'unknown' };
}


function parseMcpToolResultContentItem(buf) {
  const fields = parseFields(buf);
  const text = getField(fields, 1, 2);
  if (text) {
    return {
      type: 'text',
      text: fieldToString(getField(parseFields(text.value), 1, 2)),
    };
  }
  const image = getField(fields, 2, 2);
  if (image) {
    const imageFields = parseFields(image.value);
    const data = getField(imageFields, 1, 2)?.value || Buffer.alloc(0);
    return {
      type: 'image',
      data: data.toString('base64'),
      mimeType: fieldToString(getField(imageFields, 2, 2)),
    };
  }
  return { type: 'unknown' };
}


function parseMcpSuccess(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'success',
    content: getAllFields(fields, 1)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpToolResultContentItem(field.value)),
    isError: fieldToInt(getField(fields, 2, 0)) === 1,
  };
}


function parseMcpErrorLike(buf, kind) {
  const fields = parseFields(buf);
  return {
    kind,
    error: fieldToString(getField(fields, 1, 2)),
    reason: fieldToString(getField(fields, 1, 2)),
    readToolDefReminder: fieldToString(getField(fields, 2, 2)),
    isReadonly: fieldToInt(getField(fields, 2, 0)) === 1,
  };
}


function parseMcpToolNotFound(buf) {
  const fields = parseFields(buf);
  return {
    kind: 'tool_not_found',
    name: fieldToString(getField(fields, 1, 2)),
    availableTools: getAllFields(fields, 2)
      .filter(field => field.wireType === 2)
      .map(field => fieldToString(field)),
  };
}


export function parseMcpResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) return parseMcpSuccess(success.value);
  const error = getField(fields, 2, 2);
  if (error) return parseMcpErrorLike(error.value, 'error');
  const rejected = getField(fields, 3, 2);
  if (rejected) return parseMcpErrorLike(rejected.value, 'rejected');
  const denied = getField(fields, 4, 2);
  if (denied) return parseMcpErrorLike(denied.value, 'permission_denied');
  const notFound = getField(fields, 5, 2);
  if (notFound) return parseMcpToolNotFound(notFound.value);
  return { kind: 'unknown' };
}


export function parseListMcpResourcesResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) {
    const resources = getAllFields(parseFields(success.value), 1)
      .filter(field => field.wireType === 2)
      .map(field => {
        const resourceFields = parseFields(field.value);
        return {
          uri: fieldToString(getField(resourceFields, 1, 2)),
          name: fieldToString(getField(resourceFields, 2, 2)),
          description: fieldToString(getField(resourceFields, 3, 2)),
          mimeType: fieldToString(getField(resourceFields, 4, 2)),
        };
      });
    return { kind: 'success', resources };
  }
  const error = getField(fields, 2, 2);
  if (error) return parseMcpErrorLike(error.value, 'error');
  const rejected = getField(fields, 3, 2);
  if (rejected) return parseMcpErrorLike(rejected.value, 'rejected');
  return { kind: 'unknown' };
}


export function parseReadMcpResourceResult(buf) {
  const fields = parseFields(buf);
  const success = getField(fields, 1, 2);
  if (success) {
    const successFields = parseFields(success.value);
    const blob = getField(successFields, 6, 2)?.value || null;
    return {
      kind: 'success',
      uri: fieldToString(getField(successFields, 1, 2)),
      name: fieldToString(getField(successFields, 2, 2)),
      description: fieldToString(getField(successFields, 3, 2)),
      mimeType: fieldToString(getField(successFields, 4, 2)),
      text: fieldToString(getField(successFields, 5, 2)),
      blob: blob ? blob.toString('base64') : '',
      downloadPath: fieldToString(getField(successFields, 8, 2)),
    };
  }
  const error = getField(fields, 2, 2);
  if (error) return parseMcpErrorLike(error.value, 'error');
  const rejected = getField(fields, 3, 2);
  if (rejected) return parseMcpErrorLike(rejected.value, 'rejected');
  const notFound = getField(fields, 4, 2);
  if (notFound) return parseMcpErrorLike(notFound.value, 'not_found');
  return { kind: 'unknown' };
}

