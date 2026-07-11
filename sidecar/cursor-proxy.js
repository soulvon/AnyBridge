// cursor-proxy.js - Experimental Cursor MITM handlers.
//
// This module implements Cursor's BYOK path: synthetic model picker responses,
// BidiAppend session capture, RunSSE replies through AnyBridge's existing local
// proxy execution path, and a focused Cursor Agent tool bridge.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { endOfStreamEnvelope, endOfStreamErrorEnvelope, wrapEnvelope } from './connect.js';
import { getProxyRoutes } from './config-cache.js';
import { execute as executeLocalProxy } from './local-proxy.js';
import { recordUsage } from './stats.js';
import {
  fieldToInt,
  fieldToString,
  getAllFields,
  getField,
  parseFields,
  writeFixed64Field,
  writeMessageField,
  writeStringField,
  writeVarintField,
} from './proto.js';

const API2_HOSTS = new Set(['api2.cursor.sh']);
const AUTH_HOSTS = new Set([
  'authentication.cursor.sh',
  'prod.authentication.cursor.sh',
]);
const CURSOR_HOSTS = new Set([...API2_HOSTS, ...AUTH_HOSTS]);

const PATHS = {
  availableModels: '/aiserver.v1.AiService/AvailableModels',
  defaultModelNudge: '/aiserver.v1.AiService/GetDefaultModelNudgeData',
  bidiAppend: '/aiserver.v1.BidiService/BidiAppend',
  runSSE: '/agent.v1.AgentService/RunSSE',
  writeGitCommitMessage: '/aiserver.v1.AiService/WriteGitCommitMessage',
  streamBugBotAgenticSSE: '/aiserver.v1.AiService/StreamBugBotAgenticSSE',
  backgroundAddFollowup: '/aiserver.v1.BackgroundComposerService/AddAsyncFollowupBackgroundComposer',
  backgroundStatus: '/aiserver.v1.BackgroundComposerService/GetBackgroundComposerStatus',
  backgroundAttach: '/aiserver.v1.BackgroundComposerService/AttachBackgroundComposer',
  backgroundInteractionUpdates: '/aiserver.v1.BackgroundComposerService/StreamInteractionUpdatesSSE',
};

const sessionsByRequest = new Map();
const sessionsByConversation = new Map();
const droppedRequestConversation = new Map();
const historyByConversation = new Map();
const backgroundComposers = new Map();
const planByConversation = new Map();
const planEmittedByConversation = new Set();
const pendingToolResults = new Map();
const pendingInteractionResponses = new Map();
const execIDAliases = new Map();
const seqAliases = new Map();
const shellAccums = new Map();
let execSeqCounter = 0;
const RUNSSE_WAIT_TIMEOUT_MS = 5000;
const RUNSSE_KEEPALIVE_MS = 10000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const RECENT_SESSION_FALLBACK_MS = 2 * 60 * 1000;
const BACKGROUND_COMPOSER_TTL_MS = 30 * 60 * 1000;
const CURSOR_HISTORY_MAX_MESSAGES = 100;
const CURSOR_HISTORY_MAX_BYTES = 1024 * 1024;
const BACKGROUND_STATUS_RUNNING = 1;
const BACKGROUND_STATUS_FINISHED = 2;
const BACKGROUND_STATUS_ERROR = 3;
const BACKGROUND_STATUS_CREATING = 4;
const BUGBOT_STATUS_IN_PROGRESS = 1;
const BUGBOT_STATUS_IN_PROGRESS_ITERATIONS = 2;
const BUGBOT_STATUS_DONE = 3;
const BUGBOT_STATUS_ERROR = 4;
const BUGBOT_MAX_REPORTS = 20;
const BUGBOT_RESPONSE_PREVIEW_BYTES = 2000;
const CURSOR_TOOL_LOOP_MAX_ROUNDS = 20;
const CURSOR_TURN_MAX_MS = 5 * 60 * 1000;
const CURSOR_TOOL_RESULT_MAX_BYTES = 24 * 1024;
const CURSOR_INTERACTION_WAIT_MS = 45000;
const CURSOR_AGENT_SYSTEM = [
  'You are running inside Cursor through AnyBridge Cursor BYOK.',
  'Answer as a concise, practical coding assistant.',
  'The Cursor Read, Glob, Grep, Write, StrReplace, Delete, Shell, CreatePlan, AddTodo, UpdateTodo, SwitchMode, and MCP tools are bridged in this build when Cursor provides the corresponding tool metadata.',
  'Only claim you inspected or changed local files after using the corresponding Cursor tool, or when the user provided the content in chat.',
].join('\n');

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return process.env.APPDATA ? path.join(process.env.APPDATA, name) : path.join(os.homedir(), 'AppData', 'Roaming', name);
}

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function cursorHistoryDir() {
  return path.join(configDir(), 'cursor-history');
}

function conversationHistoryPath(conversationID) {
  const hash = crypto.createHash('sha256').update(String(conversationID || '')).digest('hex');
  return path.join(cursorHistoryDir(), `${hash}.json`);
}

function conversationArtifactDir(conversationID) {
  const hash = crypto.createHash('sha256').update(String(conversationID || '')).digest('hex');
  return path.join(cursorHistoryDir(), hash);
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
}

export function isCursorHost(value) {
  return CURSOR_HOSTS.has(normalizeHost(value));
}

function requestHost(req, upstreamHost = '') {
  if (upstreamHost) return normalizeHost(upstreamHost);
  try {
    if (/^https?:\/\//i.test(req.url || '')) {
      return normalizeHost(new URL(req.url).host);
    }
  } catch {}
  return normalizeHost(req.headers?.host);
}

function requestPath(req) {
  try {
    if (/^https?:\/\//i.test(req.url || '')) {
      return new URL(req.url).pathname;
    }
  } catch {}
  return String(req.url || '').split('?')[0] || '/';
}

function respond404(res) {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end('404 page not found\n');
}

function respondJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  });
  res.end(body);
}

function respondProto(res, body) {
  res.writeHead(200, {
    'content-type': 'application/proto',
    'content-length': String(body.length),
  });
  res.end(body);
}

function httpDecodedBody(body, headers = {}) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') {
    return zlib.gunzipSync(body);
  }
  return body;
}

function isConnectContent(headers = {}) {
  return String(headers['content-type'] || '').toLowerCase().includes('connect');
}

function decodeCursorPayloads(body, headers = {}) {
  const buf = httpDecodedBody(body, headers);
  if (!isConnectContent(headers) || buf.length < 5) return [buf];

  const frames = [];
  for (let offset = 0; offset + 5 <= buf.length;) {
    const flags = buf[offset];
    const length = buf.readUInt32BE(offset + 1);
    const end = offset + 5 + length;
    if (end > buf.length) break;
    let payload = buf.subarray(offset + 5, end);
    offset = end;
    if (flags & 0x02) continue;
    if (flags & 0x01) payload = zlib.gunzipSync(payload);
    frames.push(payload);
  }
  return frames.length ? frames : [buf];
}

function firstStringField(buf, fieldNum) {
  return fieldToString(getField(parseFields(buf), fieldNum, 2));
}

function parseModelDetails(buf) {
  const fields = parseFields(buf);
  return {
    modelId: fieldToString(getField(fields, 1, 2)),
    displayModelId: fieldToString(getField(fields, 3, 2)),
    displayName: fieldToString(getField(fields, 4, 2)),
    displayNameShort: fieldToString(getField(fields, 5, 2)),
  };
}

function parseRequestedModel(buf) {
  const fields = parseFields(buf);
  return {
    modelId: fieldToString(getField(fields, 1, 2)),
    maxMode: fieldToInt(getField(fields, 2, 0)) === 1,
  };
}

function parseAiserverModelDetails(buf) {
  const fields = parseFields(buf);
  const modelName = fieldToString(getField(fields, 1, 2));
  return {
    modelName,
    modelId: modelName,
    maxMode: fieldToInt(getField(fields, 8, 0)) === 1,
  };
}

function parseUserMessage(buf) {
  const fields = parseFields(buf);
  const mode = fieldToInt(getField(fields, 4, 0));
  return {
    text: fieldToString(getField(fields, 1, 2)),
    messageId: fieldToString(getField(fields, 2, 2)),
    mode,
    modeLabel: {
      1: 'agent',
      2: 'ask',
      3: 'plan',
      4: 'debug',
      5: 'triage',
      6: 'project',
    }[mode] || 'unspecified',
  };
}

function parseGoogleValue(buf) {
  const fields = parseFields(buf);
  if (getField(fields, 1, 0)) return null;
  const number = getField(fields, 2, 1);
  if (number?.value && Buffer.isBuffer(number.value) && number.value.length === 8) {
    return number.value.readDoubleLE(0);
  }
  const string = getField(fields, 3, 2);
  if (string) return fieldToString(string);
  const bool = getField(fields, 4, 0);
  if (bool) return fieldToInt(bool) === 1;
  const struct = getField(fields, 5, 2);
  if (struct) return parseGoogleStruct(struct.value);
  const list = getField(fields, 6, 2);
  if (list) return parseGoogleList(list.value);
  return {};
}

function parseGoogleStruct(buf) {
  const out = {};
  for (const field of getAllFields(parseFields(buf), 1).filter(item => item.wireType === 2)) {
    const entry = parseFields(field.value);
    const key = fieldToString(getField(entry, 1, 2));
    const value = getField(entry, 2, 2);
    if (key && value) out[key] = parseGoogleValue(value.value);
  }
  return out;
}

function parseGoogleList(buf) {
  return getAllFields(parseFields(buf), 1)
    .filter(field => field.wireType === 2)
    .map(field => parseGoogleValue(field.value));
}

function parseMcpToolDefinition(buf) {
  const fields = parseFields(buf);
  const schema = getField(fields, 3, 2);
  const providerIdentifier = fieldToString(getField(fields, 4, 2));
  const toolName = fieldToString(getField(fields, 5, 2));
  return {
    name: fieldToString(getField(fields, 1, 2)),
    description: fieldToString(getField(fields, 2, 2)),
    providerIdentifier,
    toolName: toolName || fieldToString(getField(fields, 1, 2)),
    inputSchema: schema ? parseGoogleValue(schema.value) : null,
  };
}

function parseMcpTools(buf) {
  return getAllFields(parseFields(buf), 1)
    .filter(field => field.wireType === 2)
    .map(field => parseMcpToolDefinition(field.value))
    .filter(tool => tool.toolName || tool.name);
}

function parseMcpToolDescriptor(buf) {
  const fields = parseFields(buf);
  return {
    toolName: fieldToString(getField(fields, 1, 2)),
    definitionPath: fieldToString(getField(fields, 2, 2)),
  };
}

function parseMcpDescriptor(buf) {
  const fields = parseFields(buf);
  return {
    serverName: fieldToString(getField(fields, 1, 2)),
    serverIdentifier: fieldToString(getField(fields, 2, 2)),
    folderPath: fieldToString(getField(fields, 3, 2)),
    serverUseInstructions: fieldToString(getField(fields, 4, 2)),
    tools: getAllFields(fields, 5)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpToolDescriptor(field.value))
      .filter(tool => tool.toolName),
  };
}

function parseMcpFileSystemOptions(buf) {
  const fields = parseFields(buf);
  return {
    enabled: fieldToInt(getField(fields, 1, 0)) === 1,
    workspaceProjectDir: fieldToString(getField(fields, 2, 2)),
    descriptors: getAllFields(fields, 3)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpDescriptor(field.value))
      .filter(desc => desc.serverIdentifier || desc.serverName),
  };
}

function parseMcpInstructions(buf) {
  const fields = parseFields(buf);
  return {
    serverName: fieldToString(getField(fields, 1, 2)),
    instructions: fieldToString(getField(fields, 2, 2)),
  };
}

function parseRequestContext(buf) {
  const fields = parseFields(buf);
  const fsOptions = getField(fields, 23, 2);
  return {
    tools: getAllFields(fields, 7)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpToolDefinition(field.value))
      .filter(tool => tool.toolName || tool.name),
    mcpInstructions: getAllFields(fields, 14)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpInstructions(field.value))
      .filter(item => item.serverName || item.instructions),
    mcpFileSystemOptions: fsOptions ? parseMcpFileSystemOptions(fsOptions.value) : null,
  };
}

function parseUserMessageAction(buf) {
  const fields = parseFields(buf);
  const userMessage = getField(fields, 1, 2);
  const requestContext = getField(fields, 2, 2);
  return {
    userMessage: userMessage ? parseUserMessage(userMessage.value) : null,
    requestContext: requestContext ? parseRequestContext(requestContext.value) : null,
  };
}

function parseConversationAction(buf) {
  const userAction = getField(parseFields(buf), 1, 2);
  if (!userAction) return {};
  const parsed = parseUserMessageAction(userAction.value);
  return {
    userMessage: parsed.userMessage,
    requestContext: parsed.requestContext,
  };
}

function parseAgentRunRequest(buf) {
  const fields = parseFields(buf);
  const action = getField(fields, 2, 2);
  const model = getField(fields, 3, 2);
  const mcpTools = getField(fields, 4, 2);
  const mcpFileSystemOptions = getField(fields, 6, 2);
  const requestedModel = getField(fields, 9, 2);
  return {
    conversationId: fieldToString(getField(fields, 5, 2)),
    action: action ? parseConversationAction(action.value) : {},
    modelDetails: model ? parseModelDetails(model.value) : {},
    requestedModel: requestedModel ? parseRequestedModel(requestedModel.value) : {},
    mcpTools: mcpTools ? parseMcpTools(mcpTools.value) : [],
    mcpFileSystemOptions: mcpFileSystemOptions ? parseMcpFileSystemOptions(mcpFileSystemOptions.value) : null,
  };
}

function parseSwitchModeRequestResponse(buf) {
  const fields = parseFields(buf);
  if (getField(fields, 1, 2)) return { kind: 'approved' };
  const rejected = getField(fields, 2, 2);
  if (rejected) {
    return {
      kind: 'rejected',
      reason: fieldToString(getField(parseFields(rejected.value), 1, 2)),
    };
  }
  return { kind: 'unknown' };
}

function parseInteractionResponse(buf) {
  const fields = parseFields(buf);
  const id = fieldToInt(getField(fields, 1, 0));
  const switchMode = getField(fields, 4, 2);
  if (switchMode) {
    return {
      id,
      type: 'switch_mode',
      switchMode: parseSwitchModeRequestResponse(switchMode.value),
    };
  }
  return { id, type: 'unknown' };
}

function parseAgentClientMessage(buf) {
  const fields = parseFields(buf);
  const run = getField(fields, 1, 2);
  if (run) return { type: 'run_request', run: parseAgentRunRequest(run.value) };
  const exec = getField(fields, 2, 2);
  if (exec) return { type: 'exec_client_message', execClientMessage: parseExecClientMessage(exec.value) };
  const interaction = getField(fields, 6, 2);
  if (interaction) return { type: 'interaction_response', interactionResponse: parseInteractionResponse(interaction.value) };
  if (getField(fields, 8, 2)) return { type: 'prewarm_request' };
  return { type: 'unknown' };
}

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

function parseReadResult(buf) {
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

function parseWriteResult(buf) {
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

function parseDeleteResult(buf) {
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

function parseShellStream(buf) {
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

function parseLsResult(buf) {
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

function parseGrepResult(buf) {
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

function parseMcpResult(buf) {
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

function parseListMcpResourcesResult(buf) {
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

function parseReadMcpResourceResult(buf) {
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

function parseExecClientMessage(buf) {
  const fields = parseFields(buf);
  const shellStream = getField(fields, 14, 2);
  const write = getField(fields, 3, 2);
  const del = getField(fields, 4, 2);
  const read = getField(fields, 7, 2);
  const grep = getField(fields, 5, 2);
  const ls = getField(fields, 8, 2);
  const mcp = getField(fields, 11, 2);
  const listMcpResources = getField(fields, 17, 2);
  const readMcpResource = getField(fields, 18, 2);
  const resultType = shellStream ? 'shell_stream'
    : write ? 'write'
      : del ? 'delete'
        : read ? 'read'
          : grep ? 'grep'
            : ls ? 'ls'
              : mcp ? 'mcp'
                : listMcpResources ? 'list_mcp_resources'
                  : readMcpResource ? 'read_mcp_resource'
                    : 'unknown';
  return {
    id: fieldToInt(getField(fields, 1, 0)),
    execID: fieldToString(getField(fields, 15, 2)),
    resultType,
    shellStream: shellStream ? parseShellStream(shellStream.value) : null,
    writeResult: write ? parseWriteResult(write.value) : null,
    writeResultRaw: write?.value || null,
    deleteResult: del ? parseDeleteResult(del.value) : null,
    deleteResultRaw: del?.value || null,
    readResult: read ? parseReadResult(read.value) : null,
    grepResult: grep ? parseGrepResult(grep.value) : null,
    grepResultRaw: grep?.value || null,
    lsResult: ls ? parseLsResult(ls.value) : null,
    mcpResult: mcp ? parseMcpResult(mcp.value) : null,
    mcpResultRaw: mcp?.value || null,
    listMcpResourcesResult: listMcpResources ? parseListMcpResourcesResult(listMcpResources.value) : null,
    listMcpResourcesResultRaw: listMcpResources?.value || null,
    readMcpResourceResult: readMcpResource ? parseReadMcpResourceResult(readMcpResource.value) : null,
    readMcpResourceResultRaw: readMcpResource?.value || null,
  };
}

function resultJSONFromExecClient(execMsg) {
  if (!execMsg || execMsg.resultType === 'unknown') {
    return JSON.stringify({ error: 'Unsupported Cursor exec result type' });
  }
  if (execMsg.resultType === 'shell_stream') {
    return JSON.stringify({
      event: execMsg.shellStream?.event || 'unknown',
      data: execMsg.shellStream?.data || '',
      code: execMsg.shellStream?.code ?? null,
      cwd: execMsg.shellStream?.cwd || '',
    });
  }
  if (execMsg.resultType === 'write') {
    const res = execMsg.writeResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        path: res.path,
        file_content_after_write: res.fileContentAfterWrite || '',
        lines_created: res.linesCreated || 0,
        file_size: res.fileSize || 0,
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.kind || 'Cursor Write tool failed',
      path: res.path || '',
      kind: res.kind || 'error',
    });
  }
  if (execMsg.resultType === 'delete') {
    const res = execMsg.deleteResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        path: res.path,
        deleted_file: res.deletedFile || '',
        file_size: res.fileSize || 0,
        prev_content: res.prevContent || '',
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.clientVisibleError || res.kind || 'Cursor Delete tool failed',
      path: res.path || '',
      kind: res.kind || 'error',
    });
  }
  if (execMsg.resultType === 'read') {
    const res = execMsg.readResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        path: res.path,
        content: res.content || (res.data ? res.data.toString('utf8') : ''),
        total_lines: res.totalLines || 0,
        file_size: res.fileSize || 0,
        truncated: res.truncated === true,
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.kind || 'Cursor Read tool failed',
      path: res.path || '',
      kind: res.kind || 'error',
    });
  }
  if (execMsg.resultType === 'grep') {
    const res = execMsg.grepResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        pattern: res.pattern || '',
        path: res.path || '',
        output_mode: res.outputMode || '',
        workspace_results: res.workspaceResults || {},
        active_editor_result: res.activeEditorResult || null,
      });
    }
    return JSON.stringify({
      error: res.error || res.kind || 'Cursor Grep tool failed',
      kind: res.kind || 'error',
    });
  }
  if (execMsg.resultType === 'ls') {
    const res = execMsg.lsResult || {};
    if (res.kind === 'success' || res.kind === 'timeout') {
      return JSON.stringify({
        kind: res.kind,
        directory_tree_root: res.directoryTreeRoot || null,
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.kind || 'Cursor Ls tool failed',
      path: res.path || '',
      kind: res.kind || 'error',
    });
  }
  if (execMsg.resultType === 'mcp') {
    const res = execMsg.mcpResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        content: res.content || [],
        is_error: res.isError === true,
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.kind || 'Cursor MCP tool failed',
      kind: res.kind || 'error',
      name: res.name || '',
      available_tools: res.availableTools || [],
    });
  }
  if (execMsg.resultType === 'list_mcp_resources') {
    const res = execMsg.listMcpResourcesResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        resources: res.resources || [],
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.kind || 'Cursor ListMcpResources failed',
      kind: res.kind || 'error',
    });
  }
  if (execMsg.resultType === 'read_mcp_resource') {
    const res = execMsg.readMcpResourceResult || {};
    if (res.kind === 'success') {
      return JSON.stringify({
        uri: res.uri || '',
        name: res.name || '',
        description: res.description || '',
        mime_type: res.mimeType || '',
        text: res.text || '',
        blob: res.blob || '',
        download_path: res.downloadPath || '',
      });
    }
    return JSON.stringify({
      error: res.error || res.reason || res.kind || 'Cursor FetchMcpResource failed',
      uri: res.uri || '',
      kind: res.kind || 'error',
    });
  }
  return JSON.stringify({ error: `Unsupported Cursor exec result type: ${execMsg.resultType}` });
}

function nextExecSeq() {
  execSeqCounter = (execSeqCounter + 1) >>> 0;
  if (execSeqCounter === 0) execSeqCounter = 1;
  return execSeqCounter;
}

function registerExecIDAlias(execID, seq, toolCallID) {
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

function registerToolWait(toolCallID, timeoutMs = 30000) {
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

function rejectToolWait(toolCallID, err) {
  const pending = pendingToolResults.get(toolCallID);
  pendingToolResults.delete(toolCallID);
  unregisterToolAliases(toolCallID);
  if (pending) {
    pending.reject(err instanceof Error ? err : new Error(String(err || 'Cursor tool wait cancelled')));
  }
}

function registerInteractionWait(queryID, timeoutMs = CURSOR_INTERACTION_WAIT_MS) {
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

function deliverInteractionResponse(response) {
  const id = Number(response?.id) || 0;
  if (!id) return false;
  const pending = pendingInteractionResponses.get(id);
  if (!pending) return false;
  pendingInteractionResponses.delete(id);
  pending.resolve(response);
  return true;
}

function resetInteractionWaitsForTest() {
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

function deliverToolResult(execMsg) {
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

function resetToolWaitsForTest() {
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

function buildReadToolResult(readResult) {
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

function buildReadToolCall({ path, offset, limit, includeLineNumbers, readResult } = {}) {
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

function buildReadExecServerMessage({ seq, execID, path, toolCallID } = {}) {
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

function buildShellResult(shellResult, fallback = {}) {
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

function buildShellToolCall({ command, workingDirectory, blockUntilMs, toolCallID, shellResult } = {}) {
  const args = buildShellArgs({ command, workingDirectory, blockUntilMs, toolCallID });
  return writeMessageField(1, concat([
    writeMessageField(1, args),
    shellResult ? writeMessageField(2, buildShellResult(shellResult, { command, workingDirectory })) : null,
  ]));
}

function buildShellExecServerMessage({ seq, execID, command, workingDirectory, blockUntilMs, toolCallID } = {}) {
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

function buildEditToolCall({ path: editPath, streamContent, writeResult } = {}) {
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

function buildWriteExecServerMessage({ seq, execID, path: writePath, fileText, toolCallID, returnFileContentAfterWrite = true } = {}) {
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

function buildDeleteToolCall({ path: deletePath, toolCallID, deleteResultRaw, deleteResult } = {}) {
  const args = concat([
    writeStringField(1, String(deletePath || '')),
    toolCallID ? writeStringField(2, String(toolCallID)) : null,
  ]);
  return writeMessageField(3, concat([
    writeMessageField(1, args),
    (deleteResultRaw || deleteResult) ? writeMessageField(2, buildDeleteToolResult({ deleteResultRaw, deleteResult })) : null,
  ]));
}

function buildDeleteExecServerMessage({ seq, execID, path: deletePath, toolCallID } = {}) {
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

function buildGlobToolResult(globResult) {
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

function buildGlobToolCall({ globPattern, targetDirectory, globResult } = {}) {
  const args = concat([
    targetDirectory ? writeStringField(1, String(targetDirectory)) : null,
    writeStringField(2, String(globPattern || '')),
  ]);
  return writeMessageField(4, concat([
    writeMessageField(1, args),
    globResult ? writeMessageField(2, buildGlobToolResult(globResult)) : null,
  ]));
}

function buildLsExecServerMessage({ seq, execID, path: lsPath, toolCallID, timeoutMs } = {}) {
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

function buildGrepToolCall({ grepResultRaw, error, ...args } = {}) {
  return writeMessageField(5, concat([
    writeMessageField(1, buildGrepArgs(args)),
    (grepResultRaw || error) ? writeMessageField(2, buildGrepToolResult({ grepResultRaw, error })) : null,
  ]));
}

function buildGrepExecServerMessage({ seq, execID, ...args } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(5, buildGrepArgs(args)),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildExecServerFrame(execServerMessage) {
  return writeMessageField(2, execServerMessage);
}

function buildToolCallUpdateFrame(updateField, callID, toolCall, modelCallID = '') {
  return buildInteractionUpdateFrame(updateField, concat([
    writeStringField(1, String(callID || '')),
    writeMessageField(2, toolCall),
    modelCallID ? writeStringField(3, modelCallID) : null,
  ]));
}

function buildToolCallStartedFrame(callID, toolCall, modelCallID = '') {
  return buildToolCallUpdateFrame(2, callID, toolCall, modelCallID);
}

function buildToolCallCompletedFrame(callID, toolCall, modelCallID = '') {
  return buildToolCallUpdateFrame(3, callID, toolCall, modelCallID);
}

function newCursorExecID(kind = 'tool') {
  return `exec-${String(kind || 'tool').toLowerCase()}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function executeReadCursorTool(res, { callID, path: readPath, offset, limit, includeLineNumbers, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
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

async function executeShellCursorTool(res, { callID, command, workingDirectory, blockUntilMs, timeoutMs, execID, seq, modelCallID = '' } = {}) {
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

async function executeWriteCursorTool(res, { callID, path: writePath, contents, timeoutMs = 30000, execID, seq, modelCallID = '', skipStarted = false } = {}) {
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

function applyStrReplaceToFile(filePath, oldString, newString, replaceAll = false) {
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

async function executeStrReplaceCursorTool(res, { callID, path: editPath, oldString, newString, replaceAll, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
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

async function executeDeleteCursorTool(res, { callID, path: deletePath, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
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

function globToRegex(pattern) {
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

function collectGlobMatches(root, rootPath, pattern) {
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

function globResultFromLsResult(lsResult, rootPath, pattern) {
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

async function executeGlobCursorTool(res, { callID, globPattern, targetDirectory, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
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

async function executeGrepCursorTool(res, { callID, pattern, path: grepPath, glob, outputMode, contextBefore, contextAfter, context, caseInsensitive, type, headLimit, multiline, sort, sortAscending, timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
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

function mcpCallFromTool(sess, toolCall, args) {
  const name = String(toolCall?.name || '');
  const toolCallID = String(toolCall?.id || '');
  if (name.startsWith('mcp_')) {
    const ref = sess?.mcpMap?.[name];
    if (!ref) throw new Error(`Unknown Cursor MCP tool function: ${name}`);
    const qualifiedName = ref.serverID && !String(ref.toolName).startsWith(`${ref.serverID}-`)
      ? `${ref.serverID}-${ref.toolName}`
      : ref.toolName;
    return {
      kind: 'mcp',
      displayName: name,
      name: qualifiedName,
      providerIdentifier: ref.serverID,
      toolName: ref.toolName,
      args,
      toolCallID,
    };
  }
  if (name === 'CallMcpTool') {
    const server = String(args.server || '').trim();
    const toolName = String(args.toolName || args.tool_name || '').trim();
    if (!server) throw new Error('Cursor CallMcpTool requires server');
    if (!toolName) throw new Error('Cursor CallMcpTool requires toolName');
    return {
      kind: 'mcp',
      displayName: name,
      name: server,
      providerIdentifier: server,
      toolName,
      args: args.arguments || {},
      toolCallID,
    };
  }
  if (name === 'ListMcpResources') {
    return {
      kind: 'list_mcp_resources',
      displayName: name,
      server: args.server || '',
      toolCallID,
    };
  }
  if (name === 'FetchMcpResource') {
    const server = String(args.server || '').trim();
    const uri = String(args.uri || '').trim();
    if (!server) throw new Error('Cursor FetchMcpResource requires server');
    if (!uri) throw new Error('Cursor FetchMcpResource requires uri');
    return {
      kind: 'read_mcp_resource',
      displayName: name,
      server,
      uri,
      downloadPath: args.downloadPath || args.download_path || '',
      toolCallID,
    };
  }
  throw new Error(`Cursor MCP tool is not implemented: ${name}`);
}

async function executeMcpCursorTool(res, sess, toolCall, { timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
  const toolCallID = String(toolCall?.id || '');
  if (!toolCallID) throw new Error('Cursor MCP tool call is missing call_id');
  const args = parseToolArguments(toolCall);
  const call = mcpCallFromTool(sess, toolCall, args);
  const actualSeq = Number(seq) || nextExecSeq();
  const actualExecID = execID || newCursorExecID(call.kind);
  let startTool;
  let execMessage;
  if (call.kind === 'mcp') {
    startTool = buildMcpToolCall(call);
    execMessage = buildMcpExecServerMessage({ seq: actualSeq, execID: actualExecID, ...call });
  } else if (call.kind === 'list_mcp_resources') {
    startTool = buildListMcpResourcesToolCall({ server: call.server });
    execMessage = buildListMcpResourcesExecServerMessage({ seq: actualSeq, execID: actualExecID, server: call.server });
  } else {
    startTool = buildReadMcpResourceToolCall({
      server: call.server,
      uri: call.uri,
      downloadPath: call.downloadPath,
    });
    execMessage = buildReadMcpResourceExecServerMessage({
      seq: actualSeq,
      execID: actualExecID,
      server: call.server,
      uri: call.uri,
      downloadPath: call.downloadPath,
    });
  }
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, startTool, modelCallID))) {
    throw new Error(`Cursor ${call.displayName} tool call ${toolCallID} failed to write started frame`);
  }
  const wait = registerToolWait(toolCallID, timeoutMs);
  registerExecIDAlias(actualExecID, actualSeq, toolCallID);
  if (!writeRunFrame(res, buildExecServerFrame(execMessage))) {
    const err = new Error(`Cursor ${call.displayName} tool call ${toolCallID} failed to write exec frame`);
    rejectToolWait(toolCallID, err);
    throw err;
  }
  try {
    const result = await wait;
    let completedTool;
    if (call.kind === 'mcp') {
      completedTool = buildMcpToolCall({
        ...call,
        mcpResult: {
          ...(result.execClientMessage?.mcpResult || { kind: 'error', error: 'Cursor MCP tool result was missing mcp_result' }),
          raw: result.execClientMessage?.mcpResultRaw,
        },
      });
    } else if (call.kind === 'list_mcp_resources') {
      completedTool = buildListMcpResourcesToolCall({
        server: call.server,
        resultRaw: result.execClientMessage?.listMcpResourcesResultRaw,
      });
    } else {
      completedTool = buildReadMcpResourceToolCall({
        server: call.server,
        uri: call.uri,
        downloadPath: call.downloadPath,
        resultRaw: result.execClientMessage?.readMcpResourceResultRaw,
      });
    }
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    return result;
  } catch (err) {
    let completedTool;
    if (call.kind === 'mcp') {
      completedTool = buildMcpToolCall({
        ...call,
        mcpResult: { kind: 'error', error: err.message || String(err) },
      });
    } else if (call.kind === 'list_mcp_resources') {
      completedTool = buildListMcpResourcesToolCall({ server: call.server });
    } else {
      completedTool = buildReadMcpResourceToolCall({
        server: call.server,
        uri: call.uri,
        downloadPath: call.downloadPath,
      });
    }
    writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, completedTool, modelCallID));
    throw err;
  }
}

function parseFileDiffChunk(buf) {
  const fields = parseFields(buf);
  const lines = getAllFields(fields, 2)
    .filter(field => field.wireType === 2)
    .map(field => field.value.toString('utf8'));
  return {
    content: fieldToString(getField(fields, 1, 2)) || lines.join('\n'),
    oldStart: fieldToInt(getField(fields, 3, 0)),
    oldLines: fieldToInt(getField(fields, 4, 0)),
    newStart: fieldToInt(getField(fields, 5, 0)),
    newLines: fieldToInt(getField(fields, 6, 0)),
  };
}

function parseFileDiff(buf) {
  const fields = parseFields(buf);
  return {
    from: fieldToString(getField(fields, 1, 2)),
    to: fieldToString(getField(fields, 2, 2)),
    chunks: getAllFields(fields, 3)
      .filter(field => field.wireType === 2)
      .map(field => parseFileDiffChunk(field.value)),
    added: fieldToInt(getField(fields, 4, 0)),
    removed: fieldToInt(getField(fields, 5, 0)),
    beforeFileContents: fieldToString(getField(fields, 6, 2)),
    afterFileContents: fieldToString(getField(fields, 7, 2)),
    isGenerated: fieldToInt(getField(fields, 8, 0)) === 1,
  };
}

function parseGitDiff(buf) {
  const fields = parseFields(buf);
  return {
    diffs: getAllFields(fields, 1)
      .filter(field => field.wireType === 2)
      .map(field => parseFileDiff(field.value)),
    diffType: fieldToInt(getField(fields, 2, 0)),
  };
}

function parseCodeBlock(buf) {
  const fields = parseFields(buf);
  return {
    relativeWorkspacePath: fieldToString(getField(fields, 1, 2)),
    fileContents: fieldToString(getField(fields, 2, 2)),
    contents: fieldToString(getField(fields, 4, 2)),
    overrideContents: fieldToString(getField(fields, 6, 2)),
    originalContents: fieldToString(getField(fields, 7, 2)),
  };
}

function parseStreamBugBotRequest(buf) {
  const fields = parseFields(buf);
  const gitDiff = getField(fields, 1, 2);
  const model = getField(fields, 2, 2);
  const range = getField(fields, 11, 2);
  return {
    gitDiff: gitDiff ? parseGitDiff(gitDiff.value) : { diffs: [], diffType: 0 },
    modelDetails: model ? parseAiserverModelDetails(model.value) : {},
    userInstructions: fieldToString(getField(fields, 3, 2)),
    bugDetectionGuidelines: fieldToString(getField(fields, 4, 2)),
    iterations: fieldToInt(getField(fields, 5, 0)),
    inBackgroundSubsidized: fieldToInt(getField(fields, 6, 0)) === 1,
    sessionID: fieldToString(getField(fields, 7, 2)),
    constrainToFile: fieldToString(getField(fields, 10, 2)),
    constrainToRange: range ? {
      startLine: fieldToInt(getField(parseFields(range.value), 1, 0)),
      endLineInclusive: fieldToInt(getField(parseFields(range.value), 2, 0)),
    } : null,
    unifiedContextLines: fieldToInt(getField(fields, 12, 0)),
    contextFiles: getAllFields(fields, 13)
      .filter(field => field.wireType === 2)
      .map(field => parseCodeBlock(field.value)),
    deepReview: fieldToInt(getField(fields, 14, 0)) === 1,
  };
}

function bugBotRequestHasDiff(req) {
  return (req?.gitDiff?.diffs || []).some(file => {
    if (file.from || file.to || file.beforeFileContents || file.afterFileContents) return true;
    return (file.chunks || []).some(chunk => String(chunk.content || '').trim());
  });
}

function parseBugBotClientMessage(buf) {
  const fields = parseFields(buf);
  const start = getField(fields, 1, 2);
  if (start) {
    const request = parseStreamBugBotRequest(start.value);
    if (bugBotRequestHasDiff(request)) {
      return { type: 'bugbot_start', request };
    }
  }
  if (getField(fields, 2, 2)) return { type: 'bugbot_exec_client_message' };
  if (getField(fields, 3, 2)) return { type: 'bugbot_exec_client_control_message' };
  return null;
}

function renderBugBotDiff(diff) {
  const files = diff?.diffs || [];
  if (!files.length) return '<empty diff>';
  const parts = [];
  for (const file of files) {
    if (!file || file.isGenerated) continue;
    const from = file.from || '/dev/null';
    const to = file.to || '/dev/null';
    const chunks = (file.chunks || [])
      .map(chunk => String(chunk.content || '').trimEnd())
      .filter(Boolean)
      .join('\n');
    const body = chunks
      || [
        file.beforeFileContents ? `--- before ---\n${file.beforeFileContents}` : '',
        file.afterFileContents ? `--- after ---\n${file.afterFileContents}` : '',
      ].filter(Boolean).join('\n');
    parts.push(`diff --git a/${from} b/${to}${body ? `\n${body}` : ''}`);
  }
  return parts.length ? parts.join('\n\n') : '<empty diff>';
}

function buildBugBotPrompt(req) {
  const out = [];
  out.push('Review the provided git diff and find concrete bugs, regressions, or correctness issues.');
  out.push('Focus only on actionable findings with file and line references.');
  if (req.userInstructions) out.push(`User instructions:\n${req.userInstructions}`);
  if (req.bugDetectionGuidelines) out.push(`Bug detection guidelines:\n${req.bugDetectionGuidelines}`);
  if (req.constrainToFile) {
    const range = req.constrainToRange
      ? `:${req.constrainToRange.startLine || 1}-${req.constrainToRange.endLineInclusive || req.constrainToRange.startLine || 1}`
      : '';
    out.push(`Constrain review to: ${req.constrainToFile}${range}`);
  }
  out.push(`Git diff:\n${renderBugBotDiff(req.gitDiff)}`);
  const context = (req.contextFiles || [])
    .map(file => {
      const name = file.relativeWorkspacePath || '(unnamed file)';
      const contents = file.overrideContents || file.contents || file.fileContents || file.originalContents || '';
      return contents.trim() ? `File: ${name}\n${contents}` : '';
    })
    .filter(Boolean);
  if (context.length) out.push(`Context files:\n${context.join('\n\n')}`);
  return out.join('\n\n');
}

function parseBidiAppend(payload) {
  const fields = parseFields(payload);
  const requestIDField = getField(fields, 2, 2);
  const requestID = requestIDField ? firstStringField(requestIDField.value, 1) : '';
  const data = fieldToString(getField(fields, 1, 2));
  const appendSeqno = fieldToInt(getField(fields, 3, 0));
  const out = { requestID, appendSeqno, dataBytes: data.length ? data.length / 2 : 0 };
  if (!data) return out;
  const raw = decodeHexProto(data);
  const existing = requestID ? sessionsByRequest.get(requestID) : null;
  const agent = parseAgentClientMessage(raw);
  if (agent.run) {
    const user = agent.run.action?.userMessage || {};
    const hasAgentSignal = Boolean(
      user.text
      || agent.run.conversationId
      || agent.run.modelDetails?.modelId
      || agent.run.modelDetails?.displayModelId
      || agent.run.requestedModel?.modelId
    );
    if (hasAgentSignal) {
      out.agentMessageType = agent.type;
      out.conversationID = agent.run.conversationId || '';
      out.userText = user.text || '';
      out.mode = user.modeLabel || 'unspecified';
      out.modelDetails = agent.run.modelDetails || {};
      out.requestedModel = agent.run.requestedModel || {};
      out.mcpTools = agent.run.mcpTools || [];
      out.mcpFileSystemOptions = agent.run.mcpFileSystemOptions || null;
      out.requestContext = agent.run.action?.requestContext || null;
      return out;
    }
  }
  const bugbot = parseBugBotClientMessage(raw);
  if (bugbot?.type === 'bugbot_start') {
    const prompt = buildBugBotPrompt(bugbot.request);
    out.agentMessageType = bugbot.type;
    out.sessionType = 'bugbot';
    out.bugBotRequest = bugbot.request;
    out.conversationID = `bugbot:${requestID || bugbot.request.sessionID || crypto.randomUUID()}`;
    out.userText = prompt;
    out.mode = 'bugbot';
    out.modelDetails = {
      modelId: bugbot.request.modelDetails?.modelName || '',
      displayModelId: bugbot.request.modelDetails?.modelName || '',
      displayName: bugbot.request.modelDetails?.modelName || '',
    };
    return out;
  }
  if (existing?.sessionType === 'bugbot' && bugbot?.type) {
    out.agentMessageType = bugbot.type;
    out.sessionType = 'bugbot';
    out.conversationID = existing.conversationID;
    return out;
  }
  out.agentMessageType = agent.type;
  if (agent.execClientMessage) {
    out.execClientMessage = agent.execClientMessage;
  }
  if (agent.interactionResponse) {
    out.interactionResponse = agent.interactionResponse;
  }
  if (agent.run) {
    const user = agent.run.action?.userMessage || {};
    out.conversationID = agent.run.conversationId || '';
    out.userText = user.text || '';
    out.mode = user.modeLabel || 'unspecified';
    out.modelDetails = agent.run.modelDetails || {};
    out.requestedModel = agent.run.requestedModel || {};
    out.mcpTools = agent.run.mcpTools || [];
    out.mcpFileSystemOptions = agent.run.mcpFileSystemOptions || null;
    out.requestContext = agent.run.action?.requestContext || null;
  }
  return out;
}

function parseBidiRequestID(payload) {
  return firstStringField(payload, 1);
}

function decodeHexProto(value) {
  const hex = String(value || '').trim();
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error('Cursor BidiAppend data is not valid even-length hex');
  }
  return Buffer.from(hex, 'hex');
}

function cursorAdapters() {
  const store = getProxyRoutes();
  if (store?.loadError) {
    throw new Error(`Cursor model list read failed: ${store.loadError}`);
  }
  const routes = Array.isArray(store?.routes) ? store.routes : [];
  return routes
    .filter(route => route && route.enabled !== false)
    .filter(route => Array.isArray(route.targets) && route.targets.length > 0)
    .filter(route => {
      const formats = Array.isArray(route.exposedFormats) && route.exposedFormats.length
        ? route.exposedFormats
        : ['openai'];
      return formats.includes('openai');
    })
    .map(route => ({
      id: route.id,
      displayName: route.displayName || route.id,
      stableID: stableModelID(route.id),
    }));
}

function resolveCursorAdapter(selectedModel) {
  const adapters = cursorAdapters();
  if (!adapters.length) {
    throw new Error('No enabled OpenAI-format proxy routes are configured for Cursor.');
  }
  const selected = String(selectedModel || '').trim();
  if (!selected) return adapters[0];
  const wanted = selected.toLowerCase();
  const found = adapters.find(model => {
    return [model.stableID, model.id, model.displayName]
      .filter(Boolean)
      .some(value => String(value).toLowerCase() === wanted);
  });
  if (!found) {
    throw new Error(`Cursor selected model is not in AnyBridge proxy routes: ${selected}`);
  }
  return found;
}

function stableModelID(modelID) {
  return crypto.createHash('sha256')
    .update(`byok|${modelID}`)
    .digest('hex')
    .slice(0, 16);
}

function concat(parts) {
  return Buffer.concat(parts.filter(Boolean));
}

function writeBoolField(field, value) {
  return writeVarintField(field, value ? 1 : 0);
}

function normalizeTodoStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['pending', 'in_progress', 'completed', 'cancelled'].includes(value)) return value;
  return '';
}

function todoStatusCode(status) {
  switch (normalizeTodoStatus(status)) {
    case 'in_progress': return 2;
    case 'completed': return 3;
    case 'cancelled': return 4;
    default: return 1;
  }
}

function cloneTodos(todos = []) {
  return todos.map(todo => ({
    id: String(todo?.id || ''),
    content: String(todo?.content || ''),
    status: normalizeTodoStatus(todo?.status) || 'pending',
  }));
}

function planStateFor(conversationID) {
  const key = String(conversationID || '');
  if (!key) return null;
  const plan = planByConversation.get(key);
  if (!plan) return null;
  return {
    name: plan.name,
    overview: plan.overview,
    todos: cloneTodos(plan.todos),
  };
}

function savePlanState(conversationID, name, overview, todos) {
  const key = String(conversationID || '');
  if (!key) throw new Error('Cursor CreatePlan requires a conversation_id');
  const plan = {
    name: String(name || '').trim(),
    overview: String(overview || '').trim(),
    todos: cloneTodos(todos),
  };
  planByConversation.set(key, plan);
  return planStateFor(key);
}

function appendTodo(conversationID, content) {
  const key = String(conversationID || '');
  const plan = planByConversation.get(key);
  if (!plan) return null;
  const text = String(content || '').trim();
  if (!text) throw new Error('Cursor AddTodo requires content');
  plan.todos.push({
    id: `t${plan.todos.length + 1}`,
    content: text,
    status: 'pending',
  });
  return planStateFor(key);
}

function updateTodoStatus(conversationID, { id, content, status } = {}) {
  const key = String(conversationID || '');
  const plan = planByConversation.get(key);
  if (!plan) return { plan: null, matchedID: '' };
  const nextStatus = normalizeTodoStatus(status);
  if (!nextStatus) {
    throw new Error('Cursor UpdateTodo status must be one of: pending, in_progress, completed, cancelled');
  }
  const wantedID = String(id || '').trim();
  const wantedContent = String(content || '').trim().toLowerCase();
  let target = null;
  if (wantedID) {
    target = plan.todos.find(todo => todo.id === wantedID) || null;
  }
  if (!target && wantedContent) {
    target = plan.todos.find(todo => todo.content.toLowerCase().startsWith(wantedContent)) || null;
  }
  if (!target) return { plan: planStateFor(key), matchedID: '' };
  target.status = nextStatus;
  return { plan: planStateFor(key), matchedID: target.id };
}

function todosForJSON(todos = []) {
  return cloneTodos(todos).map(todo => ({
    id: todo.id,
    status: todo.status,
    content: todo.content,
  }));
}

function activePlanPrompt(conversationID) {
  const plan = planStateFor(conversationID);
  if (!plan) return '';
  const lines = [
    '',
    '<active_plan>',
    `Name: ${plan.name || '(untitled)'}`,
    plan.overview ? `Overview: ${plan.overview}` : '',
    'Todos:',
    ...plan.todos.map(todo => `- [${todo.status}] ${todo.id}: ${todo.content}`),
    '</active_plan>',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildTodoItem(todo) {
  const now = Date.now();
  return concat([
    writeStringField(1, String(todo?.id || '')),
    writeStringField(2, String(todo?.content || '')),
    writeVarintField(3, todoStatusCode(todo?.status)),
    writeVarintField(4, now),
    writeVarintField(5, now),
  ]);
}

function buildCreatePlanArgs({ name, overview, todos } = {}) {
  const items = cloneTodos(todos);
  return concat([
    overview ? writeStringField(3, String(overview)) : null,
    name ? writeStringField(4, String(name)) : null,
    ...items.map(todo => writeMessageField(2, buildTodoItem(todo))),
  ]);
}

function buildCreatePlanToolCall({ name, overview, todos, includeResult = false } = {}) {
  const body = concat([
    writeMessageField(1, buildCreatePlanArgs({ name, overview, todos })),
    includeResult ? writeMessageField(2, writeMessageField(1, Buffer.alloc(0))) : null,
  ]);
  return writeMessageField(17, body);
}

function buildUpdateTodosArgs(todos, merge = false) {
  const items = cloneTodos(todos);
  return concat([
    ...items.map(todo => writeMessageField(1, buildTodoItem(todo))),
    writeBoolField(2, merge === true),
  ]);
}

function buildUpdateTodosResult(todos, merge = false) {
  const items = cloneTodos(todos);
  const success = concat([
    ...items.map(todo => writeMessageField(1, buildTodoItem(todo))),
    writeVarintField(2, items.length),
    writeBoolField(3, merge === true),
  ]);
  return writeMessageField(1, success);
}

function buildUpdateTodosToolCall({ todos, merge = false, includeResult = false } = {}) {
  const items = cloneTodos(todos);
  return writeMessageField(9, concat([
    writeMessageField(1, buildUpdateTodosArgs(items, merge)),
    includeResult ? writeMessageField(2, buildUpdateTodosResult(items, merge)) : null,
  ]));
}

function interactionQueryID(toolCallID) {
  const hash = crypto.createHash('sha256').update(String(toolCallID || '')).digest();
  const id = hash.readUInt32BE(0);
  return id || 1;
}

function cursorPickerModeID(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'ask' || value === 'chat') return 'chat';
  if (value === 'plan') return 'plan';
  if (value === 'debug') return 'debug';
  if (value === 'agent') return 'agent';
  return '';
}

function cursorModeLabelFromPicker(mode) {
  const value = cursorPickerModeID(mode);
  if (value === 'chat') return 'ask';
  return value || 'unspecified';
}

function buildSwitchModeArgs({ targetModeID, explanation, toolCallID } = {}) {
  return concat([
    writeStringField(1, String(targetModeID || '')),
    explanation ? writeStringField(2, String(explanation)) : null,
    toolCallID ? writeStringField(3, String(toolCallID)) : null,
  ]);
}

function buildSwitchModeResult({ fromModeID, toModeID, rejectedReason, error } = {}) {
  if (rejectedReason) {
    return writeMessageField(3, writeStringField(1, String(rejectedReason)));
  }
  if (error) {
    return writeMessageField(2, writeStringField(1, String(error)));
  }
  return writeMessageField(1, concat([
    fromModeID ? writeStringField(1, String(fromModeID)) : null,
    toModeID ? writeStringField(2, String(toModeID)) : null,
  ]));
}

function buildSwitchModeToolCall({ targetModeID, explanation, toolCallID, result } = {}) {
  return writeMessageField(25, concat([
    writeMessageField(1, buildSwitchModeArgs({ targetModeID, explanation, toolCallID })),
    result ? writeMessageField(2, buildSwitchModeResult(result)) : null,
  ]));
}

function buildSwitchModeInteractionQueryFrame({ queryID, targetModeID, explanation, toolCallID } = {}) {
  const switchModeQuery = writeMessageField(1, buildSwitchModeArgs({ targetModeID, explanation, toolCallID }));
  const interactionQuery = concat([
    writeVarintField(1, Number(queryID) || interactionQueryID(toolCallID)),
    writeMessageField(4, switchModeQuery),
  ]);
  return writeMessageField(7, interactionQuery);
}

function encodeGoogleValue(value) {
  if (value === null || value === undefined) return writeVarintField(1, 0);
  if (typeof value === 'number') {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(Number.isFinite(value) ? value : 0, 0);
    return writeFixed64Field(2, buf);
  }
  if (typeof value === 'string') return writeStringField(3, value);
  if (typeof value === 'boolean') return writeBoolField(4, value);
  if (Array.isArray(value)) {
    return writeMessageField(6, concat(value.map(item => writeMessageField(1, encodeGoogleValue(item)))));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => writeMessageField(1, concat([
      writeStringField(1, key),
      writeMessageField(2, encodeGoogleValue(item)),
    ])));
    return writeMessageField(5, concat(entries));
  }
  return writeStringField(3, String(value));
}

function buildMcpArgs({ name, args, toolCallID, providerIdentifier, toolName } = {}) {
  const argEntries = Object.entries(args || {}).map(([key, value]) => writeMessageField(2, concat([
    writeStringField(1, key),
    writeMessageField(2, encodeGoogleValue(value)),
  ])));
  return concat([
    writeStringField(1, String(name || '')),
    ...argEntries,
    toolCallID ? writeStringField(3, String(toolCallID)) : null,
    providerIdentifier ? writeStringField(4, String(providerIdentifier)) : null,
    toolName ? writeStringField(5, String(toolName)) : null,
  ]);
}

function buildMcpToolResult(mcpResult) {
  if (!mcpResult) return null;
  if (Buffer.isBuffer(mcpResult.raw)) return mcpResult.raw;
  if (mcpResult.kind === 'success') {
    const content = (mcpResult.content || []).map(item => {
      if (item.type === 'image') {
        return writeMessageField(2, concat([
          item.data ? writeStringField(1, item.data) : null,
          item.mimeType ? writeStringField(2, item.mimeType) : null,
        ]));
      }
      return writeMessageField(1, writeStringField(1, String(item.text || '')));
    });
    return writeMessageField(1, concat([
      ...content.map(item => writeMessageField(1, item)),
      writeBoolField(2, mcpResult.isError === true),
    ]));
  }
  if (mcpResult.kind === 'rejected') {
    return writeMessageField(3, concat([
      writeStringField(1, mcpResult.reason || 'Rejected'),
      writeBoolField(2, mcpResult.isReadonly === true),
    ]));
  }
  if (mcpResult.kind === 'permission_denied') {
    return writeMessageField(4, concat([
      writeStringField(1, mcpResult.error || 'Permission denied'),
      writeBoolField(2, mcpResult.isReadonly === true),
    ]));
  }
  return writeMessageField(2, concat([
    writeStringField(1, mcpResult.error || mcpResult.kind || 'Cursor MCP tool failed'),
    mcpResult.readToolDefReminder ? writeStringField(2, mcpResult.readToolDefReminder) : null,
  ]));
}

function buildMcpToolCall({ name, args, toolCallID, providerIdentifier, toolName, mcpResult } = {}) {
  return writeMessageField(15, concat([
    writeMessageField(1, buildMcpArgs({ name, args, toolCallID, providerIdentifier, toolName })),
    mcpResult ? writeMessageField(2, buildMcpToolResult(mcpResult)) : null,
  ]));
}

function buildMcpExecServerMessage({ seq, execID, name, args, toolCallID, providerIdentifier, toolName } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(11, buildMcpArgs({ name, args, toolCallID, providerIdentifier, toolName })),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildListMcpResourcesArgs({ server } = {}) {
  return server ? writeStringField(1, String(server)) : Buffer.alloc(0);
}

function buildListMcpResourcesToolCall({ server, resultRaw } = {}) {
  return writeMessageField(20, concat([
    writeMessageField(1, buildListMcpResourcesArgs({ server })),
    resultRaw ? writeMessageField(2, resultRaw) : null,
  ]));
}

function buildListMcpResourcesExecServerMessage({ seq, execID, server } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(17, buildListMcpResourcesArgs({ server })),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildReadMcpResourceArgs({ server, uri, downloadPath } = {}) {
  return concat([
    writeStringField(1, String(server || '')),
    writeStringField(2, String(uri || '')),
    downloadPath ? writeStringField(3, String(downloadPath)) : null,
  ]);
}

function buildReadMcpResourceToolCall({ server, uri, downloadPath, resultRaw } = {}) {
  return writeMessageField(21, concat([
    writeMessageField(1, buildReadMcpResourceArgs({ server, uri, downloadPath })),
    resultRaw ? writeMessageField(2, resultRaw) : null,
  ]));
}

function buildReadMcpResourceExecServerMessage({ seq, execID, server, uri, downloadPath } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(18, buildReadMcpResourceArgs({ server, uri, downloadPath })),
    execID ? writeStringField(15, execID) : null,
  ]);
}

function buildCreatePlanInteractionQueryFrame({ toolCallID, name, overview, todos } = {}) {
  const queryID = interactionQueryID(toolCallID);
  const createPlanQuery = concat([
    writeMessageField(1, buildCreatePlanArgs({ name, overview, todos })),
    toolCallID ? writeStringField(2, String(toolCallID)) : null,
  ]);
  const interactionQuery = concat([
    writeVarintField(1, queryID),
    writeMessageField(7, createPlanQuery),
  ]);
  return writeMessageField(7, interactionQuery);
}

function buildAvailableModel(model) {
  const tooltip = writeStringField(7, 'Notes');
  return concat([
    writeStringField(1, model.stableID),
    writeBoolField(2, true),
    writeBoolField(5, true),
    writeVarintField(6, 0),
    writeMessageField(8, tooltip),
    writeBoolField(9, true),
    writeBoolField(10, true),
    writeBoolField(14, true),
    writeStringField(17, model.displayName),
    writeStringField(18, model.stableID),
    writeBoolField(19, true),
    writeMessageField(20, tooltip),
    writeBoolField(21, false),
    writeBoolField(22, true),
    writeStringField(24, model.displayName),
    writeBoolField(25, true),
    writeBoolField(38, true),
  ]);
}

function buildFeatureConfig(field, stableID, withFallback, withBestOfN) {
  const cfg = concat([
    writeStringField(1, stableID),
    withFallback ? writeStringField(2, stableID) : null,
    withBestOfN ? writeStringField(3, stableID) : null,
  ]);
  return writeMessageField(field, cfg);
}

function buildAvailableModelsResponse(models) {
  const first = models[0]?.stableID || '';
  return concat([
    ...models.map(model => writeMessageField(2, buildAvailableModel(model))),
    first ? buildFeatureConfig(4, first, true, true) : null,
    first ? buildFeatureConfig(5, first, true, false) : null,
    first ? buildFeatureConfig(6, first, true, true) : null,
    first ? buildFeatureConfig(7, first, true, false) : null,
    first ? buildFeatureConfig(8, first, false, false) : null,
    first ? buildFeatureConfig(9, first, false, false) : null,
    first ? buildFeatureConfig(10, first, false, false) : null,
    first ? writeVarintField(12, 2400000) : null,
    first ? writeVarintField(13, 2) : null,
  ]);
}

function buildDefaultModelNudgeResponse(models) {
  if (!models.length) return Buffer.alloc(0);
  return concat([
    writeStringField(1, '0'),
    writeStringField(3, models[0].stableID),
  ]);
}

function stringFields(fields, fieldNum) {
  return getAllFields(fields, fieldNum)
    .filter(field => field.wireType === 2)
    .map(field => field.value.toString('utf8'))
    .filter(value => value.trim());
}

function parseExplicitContext(buf) {
  const fields = parseFields(buf);
  return {
    context: fieldToString(getField(fields, 1, 2)),
    repoContext: fieldToString(getField(fields, 2, 2)),
    modeSpecificContext: fieldToString(getField(fields, 4, 2)),
  };
}

function parseWriteGitCommitMessageRequest(payload) {
  const fields = parseFields(payload);
  const explicit = getField(fields, 3, 2);
  return {
    diffs: stringFields(fields, 1),
    previousCommitMessages: stringFields(fields, 2),
    explicitContext: explicit ? parseExplicitContext(explicit.value) : {},
  };
}

function buildCommitMessagePrompt(commitReq) {
  const out = [];
  out.push('Write a conventional commit message for these changes. Prefer `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, or `chore:` as appropriate. Focus on intent and user-visible impact, not a file-by-file changelog.');
  if (commitReq.previousCommitMessages.length) {
    out.push([
      'Match this style:',
      ...commitReq.previousCommitMessages.map(message => `- ${message.trim()}`).filter(line => line !== '-'),
    ].join('\n'));
  }
  const explicit = commitReq.explicitContext || {};
  if (explicit.context) out.push(`Explicit context:\n${explicit.context}`);
  if (explicit.repoContext) out.push(`Repository context:\n${explicit.repoContext}`);
  if (explicit.modeSpecificContext) out.push(`Mode-specific context:\n${explicit.modeSpecificContext}`);
  if (!commitReq.diffs.length) {
    throw new Error('Cursor WriteGitCommitMessage request contains no diffs');
  }
  out.push(`Diffs:\n${commitReq.diffs.join('\n\n')}`);
  return out.join('\n\n');
}

function sanitizeCommitMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Cursor commit message generation returned empty text');
  return trimmed
    .replace(/^```(?:text|gitcommit)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildWriteGitCommitMessageResponse(message) {
  return writeStringField(1, message);
}

function parseBackgroundComposerModelDetails(buf) {
  return parseAiserverModelDetails(buf);
}

function parseAddBackgroundComposerRequest(payload) {
  const fields = parseFields(payload);
  const model = getField(fields, 6, 2);
  const bcID = fieldToString(getField(fields, 1, 2));
  return {
    bcID: bcID || `bc-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    followup: fieldToString(getField(fields, 2, 2)),
    richFollowup: fieldToString(getField(fields, 4, 2)),
    modelDetails: model ? parseBackgroundComposerModelDetails(model.value) : {},
  };
}

function parseGetBackgroundComposerStatusRequest(payload) {
  return { bcID: firstStringField(payload, 1) };
}

function parseAttachBackgroundComposerRequest(payload) {
  const fields = parseFields(payload);
  return {
    bcID: fieldToString(getField(fields, 1, 2)),
    startingIndex: fieldToInt(getField(fields, 2, 0)),
  };
}

function backgroundPromptText(state) {
  const text = String(state?.richFollowup || state?.followup || '').trim();
  return text || 'Continue the background task.';
}

function buildHeadlessPrompt(state) {
  const text = String(state?.followup || '').trim();
  const rich = String(state?.richFollowup || '').trim();
  return concat([
    text ? writeStringField(1, text) : null,
    rich ? writeStringField(6, rich) : null,
  ]);
}

function buildHeadlessStatus(type, message, complete) {
  return concat([
    writeVarintField(1, type),
    message ? writeStringField(2, message) : null,
    writeBoolField(3, complete === true),
  ]);
}

function buildHeadlessResponse({ text = '', done = false, error = '', statusMessage = '', complete = false } = {}) {
  const errorBody = error ? writeStringField(1, error) : null;
  const statusBody = statusMessage ? buildHeadlessStatus(2, statusMessage, complete) : null;
  return concat([
    text ? writeStringField(1, text) : null,
    writeBoolField(5, done === true),
    errorBody ? writeMessageField(7, errorBody) : null,
    statusBody ? writeMessageField(11, statusBody) : null,
  ]);
}

function buildAttachBackgroundComposerResponse({ state, text = '', done = false, error = '', status = BACKGROUND_STATUS_RUNNING, includePrompt = false, statusMessage = '', complete = false } = {}) {
  return concat([
    writeMessageField(1, buildHeadlessResponse({ text, done, error, statusMessage, complete })),
    includePrompt && state ? writeMessageField(2, buildHeadlessPrompt(state)) : null,
    writeVarintField(6, status),
  ]);
}

function buildGetBackgroundComposerStatusResponse(status, unread = false) {
  return concat([
    writeVarintField(1, status),
    writeBoolField(2, unread === true),
  ]);
}

function buildBugBotStatus({ status, message = '', iterationsCompleted = 0, totalIterations = 0 } = {}) {
  return concat([
    writeVarintField(1, status || 0),
    message ? writeStringField(2, message) : null,
    iterationsCompleted ? writeVarintField(3, iterationsCompleted) : null,
    totalIterations ? writeVarintField(4, totalIterations) : null,
  ]);
}

function buildBugLocation(location = {}) {
  return concat([
    location.file ? writeStringField(1, location.file) : null,
    writeVarintField(2, Math.max(1, Number(location.startLine) || 1)),
    writeVarintField(3, Math.max(1, Number(location.endLine || location.startLine) || 1)),
  ]);
}

function buildBugReport(report = {}, index = 0) {
  const locations = Array.isArray(report.locations) ? report.locations : [];
  return concat([
    ...locations.map(location => writeMessageField(1, buildBugLocation(location))),
    writeStringField(2, report.id || `bug-${index + 1}`),
    writeStringField(3, report.description || report.title || 'Potential issue'),
    report.category ? writeStringField(5, report.category) : null,
    writeStringField(6, report.severity || 'medium'),
    report.title ? writeStringField(7, report.title) : null,
    report.rationale ? writeStringField(9, report.rationale) : null,
  ]);
}

function buildBugReports(reports = []) {
  return concat(reports.map((report, index) => writeMessageField(1, buildBugReport(report, index))));
}

function buildBugBotResponse({ reports = [], status, message = '', summary = '', numTurns = 0, iterationsCompleted = 0, totalIterations = 0 } = {}) {
  return concat([
    reports.length ? writeMessageField(1, buildBugReports(reports)) : null,
    writeMessageField(2, buildBugBotStatus({ status, message, iterationsCompleted, totalIterations })),
    summary ? writeStringField(3, summary) : null,
    numTurns ? writeVarintField(5, numTurns) : null,
  ]);
}

function buildBugBotServerMessage(response) {
  return writeMessageField(1, response);
}

function stripCodeFence(text) {
  let value = String(text || '').trim();
  if (!value.startsWith('```')) return value;
  const lines = value.split(/\r?\n/);
  if (lines[0]?.startsWith('```')) lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  value = lines.join('\n').trim();
  return value;
}

function extractJsonCandidate(text, open, close) {
  const value = stripCodeFence(text);
  const start = value.indexOf(open);
  const end = value.lastIndexOf(close);
  if (start >= 0 && end > start) return value.slice(start, end + 1);
  return value;
}

function normalizeBugBotReport(item, index) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title || item.summary || '').trim();
  const description = String(item.description || item.rationale || title || '').trim();
  if (!title && !description) return null;
  const file = String(item.file || item.path || item.relative_workspace_path || '').trim();
  const startLine = Number(item.start_line ?? item.startLine ?? item.line ?? 1) || 1;
  const endLine = Number(item.end_line ?? item.endLine ?? item.line ?? startLine) || startLine;
  return {
    id: String(item.id || `bug-${index + 1}`),
    title: title || description.slice(0, 120),
    description,
    severity: String(item.severity || 'medium'),
    category: item.category ? String(item.category) : '',
    rationale: item.rationale ? String(item.rationale) : '',
    locations: file ? [{ file, startLine, endLine }] : [],
  };
}

function parseBugBotModelResponse(text) {
  const trimmed = stripCodeFence(text);
  if (!trimmed) throw new Error('Cursor BugBot model response was empty');
  if (/^NO_ISSUES$/i.test(trimmed)) {
    return { reports: [], summary: 'No issues found' };
  }

  let parsed;
  const objectFirst = trimmed.trimStart().startsWith('{');
  const attempts = objectFirst
    ? [() => extractJsonCandidate(trimmed, '{', '}'), () => extractJsonCandidate(trimmed, '[', ']')]
    : [() => extractJsonCandidate(trimmed, '[', ']'), () => extractJsonCandidate(trimmed, '{', '}')];
  for (const attempt of attempts) {
    try {
      parsed = JSON.parse(attempt());
      break;
    } catch {}
  }
  if (parsed === undefined) {
    throw new Error(`Cursor BugBot model response was not JSON or NO_ISSUES: ${trimmed.slice(0, BUGBOT_RESPONSE_PREVIEW_BYTES)}`);
  }

  let items = [];
  let summary = '';
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object') {
    summary = String(parsed.summary || '').trim();
    items = parsed.bugs || parsed.issues || parsed.reports || [];
  }
  if (!Array.isArray(items)) {
    throw new Error('Cursor BugBot JSON response must contain a bug report array');
  }
  const reports = items
    .slice(0, BUGBOT_MAX_REPORTS)
    .map(normalizeBugBotReport)
    .filter(Boolean);
  if (!reports.length) {
    return { reports: [], summary: summary || 'No issues found' };
  }
  return { reports, summary: summary || `Found ${reports.length} issue(s)` };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupSessionStore(now = Date.now()) {
  for (const [requestID, sess] of sessionsByRequest) {
    if (!sess?.updatedAt || now - sess.updatedAt > SESSION_TTL_MS) {
      sessionsByRequest.delete(requestID);
    }
  }
  for (const [conversationID, sess] of sessionsByConversation) {
    if (!sess?.updatedAt || now - sess.updatedAt > SESSION_TTL_MS) {
      sessionsByConversation.delete(conversationID);
    }
  }
  for (const [requestID, entry] of droppedRequestConversation) {
    if (!entry?.updatedAt || now - entry.updatedAt > SESSION_TTL_MS) {
      droppedRequestConversation.delete(requestID);
    }
  }
}

function cloneSessionForRequest(sess, requestID) {
  if (!sess) return null;
  return {
    ...sess,
    requestID,
    fallbackFromRequestID: sess.requestID || '',
    updatedAt: Date.now(),
  };
}

function recentTextSessionFallback(now = Date.now()) {
  let candidate = null;
  for (const sess of sessionsByConversation.values()) {
    if (!sess?.userText || !sess.conversationID) continue;
    if (sess.sessionType === 'bugbot') continue;
    if (!sess.updatedAt || now - sess.updatedAt > RECENT_SESSION_FALLBACK_MS) continue;
    if (candidate && candidate.conversationID !== sess.conversationID) {
      return null;
    }
    candidate = sess;
  }
  return candidate;
}

function rememberSession(msg) {
  cleanupSessionStore();
  if (!msg.requestID) return msg;
  const existing = sessionsByRequest.get(msg.requestID) || {};
  const next = { ...existing, ...msg, updatedAt: Date.now() };
  sessionsByRequest.set(msg.requestID, next);
  if (next.conversationID && next.userText) {
    sessionsByConversation.set(next.conversationID, next);
  }
  return next;
}

async function waitForSession(requestID, timeoutMs = RUNSSE_WAIT_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    cleanupSessionStore();
    const sess = sessionsByRequest.get(requestID);
    if (sess?.userText) return { session: sess, reason: 'exact' };
    if (sess?.conversationID) {
      const byConv = sessionsByConversation.get(sess.conversationID);
      if (byConv?.userText) {
        const clone = cloneSessionForRequest(byConv, requestID);
        sessionsByRequest.set(requestID, clone);
        return { session: clone, reason: 'conversation' };
      }
    }
    const dropped = droppedRequestConversation.get(requestID);
    if (dropped?.conversationID) {
      const byConv = sessionsByConversation.get(dropped.conversationID);
      if (byConv?.userText) {
        const clone = cloneSessionForRequest(byConv, requestID);
        sessionsByRequest.set(requestID, clone);
        return { session: clone, reason: 'dropped-request' };
      }
    }
    await sleep(100);
  }
  const exact = sessionsByRequest.get(requestID);
  if (exact?.userText) return { session: exact, reason: 'exact-after-timeout' };
  const recent = recentTextSessionFallback();
  if (recent?.userText) {
    const clone = cloneSessionForRequest(recent, requestID);
    sessionsByRequest.set(requestID, clone);
    return { session: clone, reason: 'recent-single-conversation' };
  }
  return exact ? { session: exact, reason: 'empty' } : null;
}

function dropSession(requestID) {
  if (!requestID) return;
  const sess = sessionsByRequest.get(requestID);
  if (sess?.conversationID) {
    droppedRequestConversation.set(requestID, {
      conversationID: sess.conversationID,
      updatedAt: Date.now(),
    });
  }
  sessionsByRequest.delete(requestID);
  cleanupSessionStore();
}

function resetSessionStoreForTest() {
  sessionsByRequest.clear();
  sessionsByConversation.clear();
  droppedRequestConversation.clear();
}

function resetHistoryStoreForTest() {
  historyByConversation.clear();
}

function resetPlanStoreForTest() {
  planByConversation.clear();
  planEmittedByConversation.clear();
}

function cleanupBackgroundComposers(now = Date.now()) {
  for (const [id, state] of backgroundComposers) {
    if (!state?.updatedAt || now - state.updatedAt > BACKGROUND_COMPOSER_TTL_MS) {
      backgroundComposers.delete(id);
    }
  }
}

function saveBackgroundComposer(state) {
  cleanupBackgroundComposers();
  state.updatedAt = Date.now();
  backgroundComposers.set(state.bcID, state);
  return state;
}

function getBackgroundComposer(bcID) {
  cleanupBackgroundComposers();
  return backgroundComposers.get(String(bcID || '')) || null;
}

function appendBackgroundUpdate(state, frame) {
  if (!state || !frame) return;
  state.updates.push(frame);
  state.updatedAt = Date.now();
}

function resetBackgroundComposersForTest() {
  backgroundComposers.clear();
}

function selectedModelFromSession(sess) {
  return sess?.requestedModel?.modelId
    || sess?.modelDetails?.modelId
    || sess?.modelDetails?.displayModelId
    || sess?.modelDetails?.displayName
    || '';
}

function textPart(text) {
  return { type: 'text', text: String(text || '') };
}

function normalizeHistoryMessage(message) {
  const role = message?.role === 'assistant' ? 'assistant' : 'user';
  const content = Array.isArray(message?.content)
    ? message.content
    : [{ type: 'text', text: String(message?.content || '') }];
  const text = content
    .filter(part => part?.type === 'text')
    .map(part => String(part.text || ''))
    .join('\n');
  return { role, content: [textPart(text)] };
}

function loadConversationHistory(conversationID) {
  if (!conversationID) return [];
  if (historyByConversation.has(conversationID)) return historyByConversation.get(conversationID);
  const file = conversationHistoryPath(conversationID);
  if (!fs.existsSync(file)) {
    historyByConversation.set(conversationID, []);
    return historyByConversation.get(conversationID);
  }
  const stat = fs.statSync(file);
  if (stat.size > CURSOR_HISTORY_MAX_BYTES) {
    throw new Error(`Cursor conversation history is too large: ${file}`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  if (!json || json.version !== 1 || !Array.isArray(json.messages)) {
    throw new Error(`Cursor conversation history has invalid format: ${file}`);
  }
  const messages = json.messages
    .map(normalizeHistoryMessage)
    .filter(message => message.content.some(part => part.text))
    .slice(-CURSOR_HISTORY_MAX_MESSAGES);
  historyByConversation.set(conversationID, messages);
  return messages;
}

function persistConversationHistory(conversationID, history) {
  if (!conversationID) return;
  const messages = (history || [])
    .map(normalizeHistoryMessage)
    .filter(message => message.content.some(part => part.text))
    .slice(-CURSOR_HISTORY_MAX_MESSAGES);
  const dir = cursorHistoryDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = conversationHistoryPath(conversationID);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({
    version: 1,
    conversationID,
    updatedAt: new Date().toISOString(),
    messages,
  }, null, 2);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function readCursorArtifactConversation(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Cursor artifact conversation has invalid format: ${file}`);
  }
  return parsed;
}

function writeJsonAtomically(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function nextCursorTurnIndex(turnsDir) {
  if (!fs.existsSync(turnsDir)) return 0;
  const indexes = fs.readdirSync(turnsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{6}$/.test(entry.name))
    .map(entry => Number(entry.name))
    .filter(value => Number.isInteger(value) && value >= 0);
  return indexes.length ? Math.max(...indexes) + 1 : 0;
}

function usageNumber(usage, keys) {
  for (const key of keys) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function summarizeCursorToolCalls(toolCalls = []) {
  return toolCalls.map((tc, index) => ({
    index,
    id: String(tc?.id || ''),
    name: String(tc?.name || ''),
    arguments_bytes: Buffer.byteLength(String(tc?.arguments || ''), 'utf8'),
  })).filter(tc => tc.name);
}

function persistCursorTurnArtifacts(sess, {
  kind = 'runsse',
  assistantText = '',
  usage = null,
  model = '',
  provider = 'anybridge',
  startedAt = Date.now(),
  finishedAt = Date.now(),
  toolCalls = [],
  requestBodies = [],
} = {}) {
  const conversationID = sess?.conversationID || sess?.requestID || '';
  if (!conversationID) return null;
  const userText = String(sess?.userText || '');
  const dir = conversationArtifactDir(conversationID);
  const conversationFile = path.join(dir, 'conversation.json');
  const nowIso = new Date(finishedAt).toISOString();
  const existing = readCursorArtifactConversation(conversationFile);
  const conversation = existing || {
    version: 1,
    conversation_id: conversationID,
    root_conversation_id: conversationID,
    parent_conversation_id: '',
    parent_tool_call_id: '',
    mode: sess?.mode || 'agent',
    token_details_used_tokens: 0,
    token_details_max_tokens: 200000,
    created_at: new Date(startedAt).toISOString(),
    updated_at: nowIso,
    next_turn_seq: 1,
    next_entry_seq: 1,
    entries: [],
  };
  conversation.mode = sess?.mode || conversation.mode || 'agent';
  const turnSeq = Number(conversation.next_turn_seq) || 1;
  let entrySeq = Number(conversation.next_entry_seq) || 1;
  if (userText) {
    conversation.entries.push({
      seq: entrySeq++,
      turn_seq: turnSeq,
      request_id: String(sess?.requestID || ''),
      role: 'user',
      kind: 'user_message',
      payload: { text: userText },
      created_at: new Date(startedAt).toISOString(),
    });
  }
  if (assistantText) {
    conversation.entries.push({
      seq: entrySeq++,
      turn_seq: turnSeq,
      request_id: String(sess?.requestID || ''),
      role: 'assistant',
      kind: 'assistant_text',
      payload: { text: String(assistantText) },
      created_at: nowIso,
    });
  }

  const promptTokens = usageNumber(usage, ['inputTokens', 'input_tokens', 'prompt_tokens']);
  const completionTokens = usageNumber(usage, ['outputTokens', 'output_tokens', 'completion_tokens']);
  const cachedTokens = usageNumber(usage, ['cachedTokens', 'cached_tokens']);
  const explicitTotal = usageNumber(usage, ['totalTokens', 'total_tokens', 'total']);
  const estimatedTotal = usageTokens(usage, assistantText);
  const totalTokens = explicitTotal || (promptTokens + completionTokens) || estimatedTotal;

  conversation.token_details_used_tokens = (Number(conversation.token_details_used_tokens) || 0) + totalTokens;
  conversation.next_turn_seq = turnSeq + 1;
  conversation.next_entry_seq = entrySeq;
  conversation.updated_at = nowIso;
  writeJsonAtomically(conversationFile, conversation);

  const turnsDir = path.join(dir, 'turns');
  const turnIndex = nextCursorTurnIndex(turnsDir);
  const turnDir = path.join(turnsDir, String(turnIndex).padStart(6, '0'));
  fs.mkdirSync(turnsDir, { recursive: true });
  fs.mkdirSync(turnDir, { recursive: false });
  if (requestBodies.length) {
    writeJsonAtomically(path.join(turnDir, 'request.json'), {
      version: 1,
      requests: requestBodies,
    });
  }
  const summary = {
    version: 1,
    kind,
    conversation_id: conversationID,
    request_id: String(sess?.requestID || ''),
    model: String(model || selectedModelFromSession(sess) || ''),
    provider,
    mode: conversation.mode,
    started_at: new Date(startedAt).toISOString(),
    finished_at: nowIso,
    duration_ms: Math.max(0, Number(finishedAt) - Number(startedAt)),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    total_tokens: totalTokens,
    total_tokens_estimated: !(explicitTotal || promptTokens || completionTokens),
    assistant_text_bytes: Buffer.byteLength(String(assistantText || ''), 'utf8'),
    tool_calls: summarizeCursorToolCalls(toolCalls),
  };
  writeJsonAtomically(path.join(turnDir, 'summary.json'), summary);
  return { dir, turnDir, summary };
}

function cursorModePrompt(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'ask') return 'Current Cursor mode: Ask. Prefer explanation and guidance.';
  if (normalized === 'plan') return 'Current Cursor mode: Plan. Prefer a short, actionable plan before implementation details.';
  if (normalized === 'debug') return 'Current Cursor mode: Debug. Focus on root cause, evidence, and concrete checks.';
  return 'Current Cursor mode: Agent. Be direct and useful.';
}

function sanitizeMcpFunctionName(value) {
  const cleaned = String(value || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return cleaned || 'tool';
}

function loadMcpDefinition(definitionPath) {
  const file = String(definitionPath || '').trim();
  if (!file) return { description: '', inputSchema: null };
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const inputSchema = parsed.arguments
    || parsed.inputSchema
    || parsed.input_schema
    || parsed.schema
    || parsed.parameters
    || null;
  return {
    description: String(parsed.description || '').trim(),
    inputSchema,
  };
}

function normalizeMcpSchema(schema) {
  const fallback = { type: 'object', properties: {}, additionalProperties: true };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return fallback;
  let obj = { ...schema };
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(obj[key])) {
      const branch = obj[key].find(item => item && typeof item === 'object' && !Array.isArray(item));
      if (branch) obj = { ...branch };
      break;
    }
  }
  if (obj.type !== 'object') obj.type = 'object';
  if (!obj.properties || typeof obj.properties !== 'object' || Array.isArray(obj.properties)) {
    obj.properties = {};
  }
  if (obj.additionalProperties === undefined) obj.additionalProperties = true;
  return obj;
}

function mcpEntriesForSession(sess) {
  if (!sess) return [];
  const entries = [];
  const seen = new Set();
  const add = ({ serverName, serverID, toolName, description, inputSchema }) => {
    const realToolName = String(toolName || '').trim();
    let providerID = String(serverID || serverName || '').trim();
    let displayServerName = String(serverName || providerID || '').trim();
    if (!realToolName || (!providerID && !displayServerName)) return;
    if (!providerID) providerID = displayServerName;
    if (!displayServerName) displayServerName = providerID;
    const key = `${providerID}\0${realToolName}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      serverName: displayServerName,
      serverID: providerID,
      toolName: realToolName,
      description: String(description || '').trim(),
      inputSchema: normalizeMcpSchema(inputSchema),
    });
  };

  for (const tool of [
    ...(sess.mcpTools || []),
    ...(sess.requestContext?.tools || []),
  ]) {
    add({
      serverName: tool.providerIdentifier || tool.provider_identifier || tool.name,
      serverID: tool.providerIdentifier || tool.provider_identifier || tool.name,
      toolName: tool.toolName || tool.tool_name || tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || tool.input_schema,
    });
  }

  const descriptors = [
    ...(sess.mcpFileSystemOptions?.descriptors || []),
    ...(sess.requestContext?.mcpFileSystemOptions?.descriptors || []),
  ];
  for (const desc of descriptors) {
    for (const tool of desc.tools || []) {
      let loaded = { description: '', inputSchema: null };
      if (tool.definitionPath) {
        loaded = loadMcpDefinition(tool.definitionPath);
      }
      add({
        serverName: desc.serverName,
        serverID: desc.serverIdentifier,
        toolName: tool.toolName,
        description: loaded.description || desc.serverUseInstructions,
        inputSchema: loaded.inputSchema,
      });
    }
  }
  return entries;
}

function cursorMcpToolDefinitions(sess) {
  const entries = mcpEntriesForSession(sess);
  if (!sess) return [];
  sess.mcpMap = {};
  const out = [];
  entries.forEach((entry, index) => {
    const name = `mcp_${index}__${sanitizeMcpFunctionName(entry.toolName)}`;
    sess.mcpMap[name] = {
      serverName: entry.serverName,
      serverID: entry.serverID,
      toolName: entry.toolName,
    };
    out.push({
      type: 'function',
      function: {
        name,
        description: [
          `[MCP server: ${entry.serverName} (id: ${entry.serverID}) | real tool: ${entry.toolName}]`,
          entry.description || `MCP tool "${entry.toolName}" on server "${entry.serverName}".`,
        ].join('\n'),
        parameters: entry.inputSchema,
      },
    });
  });
  return out;
}

function mcpToolsPrompt(sess) {
  const map = sess?.mcpMap || {};
  const names = Object.keys(map);
  if (!names.length) return '';
  const rows = names.map(name => {
    const ref = map[name];
    return `- ${name}: ${ref.serverName} (${ref.serverID}) -> ${ref.toolName}`;
  });
  return [
    '',
    '<mcp_tools>',
    'Each MCP tool is exposed as its own OpenAI function. Call the exact function name shown here; do not invent composite server-tool names.',
    ...rows,
    '</mcp_tools>',
  ].join('\n');
}

function cursorReadToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a UTF-8 text file from the current Cursor workspace. Use this before discussing local file contents that were not provided in chat.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative or absolute file path to read.',
          },
          offset: {
            type: 'integer',
            description: 'Optional 1-based starting line.',
          },
          limit: {
            type: 'integer',
            description: 'Optional maximum number of lines to read.',
          },
          include_line_numbers: {
            type: 'boolean',
            description: 'Whether Cursor should include line numbers in the returned content.',
          },
        },
        required: ['path'],
      },
    },
  };
}

function cursorGlobToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Glob',
      description: [
        'Search for files matching a glob pattern in the current Cursor workspace.',
        'Use this when you need to find files by name patterns before reading them.',
        'Patterns not starting with **/ are matched recursively from the workspace root.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          glob_pattern: {
            type: 'string',
            description: 'Glob pattern to match files against, for example *.js or **/test/**/*.ts.',
          },
          target_directory: {
            type: 'string',
            description: 'Optional workspace-relative or absolute directory to search. Defaults to the Cursor workspace root.',
          },
        },
        required: ['glob_pattern'],
      },
    },
  };
}

function cursorGrepToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Grep',
      description: [
        'Search file contents with ripgrep-compatible regular expressions.',
        'Use this for exact symbols, strings, or regex patterns; use Glob for file-name patterns.',
        'Output modes are content, files_with_matches, and count.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for.',
          },
          path: {
            type: 'string',
            description: 'Optional file or directory to search. Defaults to the Cursor workspace root.',
          },
          glob: {
            type: 'string',
            description: 'Optional glob filter passed to ripgrep.',
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'Result format. Defaults to content.',
          },
          '-A': {
            type: 'integer',
            description: 'Number of lines to show after each match in content mode.',
          },
          '-B': {
            type: 'integer',
            description: 'Number of lines to show before each match in content mode.',
          },
          '-C': {
            type: 'integer',
            description: 'Number of context lines to show before and after each match in content mode.',
          },
          '-i': {
            type: 'boolean',
            description: 'Case-insensitive search.',
          },
          type: {
            type: 'string',
            description: 'Optional ripgrep file type such as js, py, rust, go, or java.',
          },
          head_limit: {
            type: 'integer',
            minimum: 0,
            description: 'Limit result size.',
          },
          multiline: {
            type: 'boolean',
            description: 'Enable multiline search.',
          },
        },
        required: ['pattern'],
      },
    },
  };
}

function cursorShellToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Shell',
      description: [
        'Execute a terminal command in the current Cursor workspace.',
        'Use this for build, test, package manager, git, and other terminal operations.',
        'Use Read, Glob, Grep, Write, StrReplace, and Delete for file operations instead of shell commands.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            description: 'Command to execute.',
          },
          working_directory: {
            type: 'string',
            description: 'Optional absolute working directory. Defaults to Cursor workspace root.',
          },
          block_until_ms: {
            type: 'integer',
            minimum: 0,
            description: 'Milliseconds to wait before Cursor backgrounds the command. Defaults to 30000. Set 0 for immediate background.',
          },
          description: {
            type: 'string',
            description: 'Short 5-10 word description of what this command does.',
          },
        },
        required: ['command'],
      },
    },
  };
}

function cursorWriteToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Write',
      description: [
        'Write complete UTF-8 text contents to a file in the current Cursor workspace.',
        'This overwrites the existing file if it exists; prefer StrReplace for targeted edits to existing files.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative or absolute path to write.',
          },
          contents: {
            type: 'string',
            description: 'Complete file contents to write.',
          },
        },
        required: ['path', 'contents'],
      },
    },
  };
}

function cursorStrReplaceToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'StrReplace',
      description: [
        'Perform an exact string replacement in an existing UTF-8 text file.',
        'The old_string must match the current file contents exactly; use replace_all only when every occurrence should change.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to modify.',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to replace.',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text. Empty string deletes the matched text.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence of old_string. Defaults to false.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  };
}

function cursorDeleteToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Delete',
      description: 'Delete a file from the current Cursor workspace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative or absolute file path to delete.',
          },
        },
        required: ['path'],
      },
    },
  };
}

function cursorCreatePlanToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'CreatePlan',
      description: 'Create a structured plan for a multi-step Cursor task. Pass short TODO items; use AddTodo and UpdateTodo later to keep the plan current.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'Short plan title.',
          },
          overview: {
            type: 'string',
            description: 'One-paragraph approach summary.',
          },
          todos: {
            type: 'array',
            description: 'Initial TODO items in execution order.',
            items: { type: 'string' },
          },
        },
        required: ['name', 'overview', 'todos'],
      },
    },
  };
}

function cursorAddTodoToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'AddTodo',
      description: 'Append one TODO item to the active Cursor plan. If no plan exists, call CreatePlan first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: {
            type: 'string',
            description: 'Short imperative TODO item.',
          },
        },
        required: ['content'],
      },
    },
  };
}

function cursorUpdateTodoToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'UpdateTodo',
      description: 'Update a TODO status on the active Cursor plan. Use id when known, or content as a prefix match.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: 'TODO id from the active plan.',
          },
          content: {
            type: 'string',
            description: 'Alternative prefix match on TODO content.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'New TODO status.',
          },
        },
        required: ['status'],
      },
    },
  };
}

function cursorSwitchModeToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'SwitchMode',
      description: 'Switch the active Cursor interaction mode when the task is better suited to agent, ask, plan, or debug. Continue after the user approves or rejects the switch.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_mode_id: {
            type: 'string',
            enum: ['agent', 'ask', 'plan', 'debug'],
            description: 'Target mode.',
          },
          explanation: {
            type: 'string',
            description: 'Short reason shown to the user.',
          },
        },
        required: ['target_mode_id', 'explanation'],
      },
    },
  };
}

function cursorListMcpResourcesToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'ListMcpResources',
      description: 'List MCP resources advertised by connected Cursor MCP servers. Resources are not tools; use mcp_* functions for MCP tool calls.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            description: 'Optional MCP server identifier.',
          },
        },
        required: [],
      },
    },
  };
}

function cursorFetchMcpResourceToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'FetchMcpResource',
      description: 'Read a specific MCP resource from a connected Cursor MCP server.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            description: 'MCP server identifier.',
          },
          uri: {
            type: 'string',
            description: 'Resource URI.',
          },
          downloadPath: {
            type: 'string',
            description: 'Optional workspace-relative path where Cursor should save the resource.',
          },
        },
        required: ['server', 'uri'],
      },
    },
  };
}

function cursorCallMcpToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'CallMcpTool',
      description: 'Call an MCP tool by server identifier and tool name. Prefer the specific mcp_* functions when they are available.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            description: 'MCP server identifier.',
          },
          toolName: {
            type: 'string',
            description: 'MCP tool name.',
          },
          arguments: {
            type: 'object',
            description: 'Arguments for the MCP tool.',
            additionalProperties: true,
          },
        },
        required: ['server', 'toolName', 'arguments'],
      },
    },
  };
}

function cursorReadTools(sess = null) {
  const base = [
    cursorReadToolDefinition(),
    cursorGlobToolDefinition(),
    cursorGrepToolDefinition(),
    cursorShellToolDefinition(),
    cursorWriteToolDefinition(),
    cursorStrReplaceToolDefinition(),
    cursorDeleteToolDefinition(),
    cursorCreatePlanToolDefinition(),
    cursorAddTodoToolDefinition(),
    cursorUpdateTodoToolDefinition(),
    cursorSwitchModeToolDefinition(),
  ];
  const mcpTools = cursorMcpToolDefinitions(sess);
  if (mcpTools.length) {
    base.push(cursorListMcpResourcesToolDefinition());
    base.push(cursorFetchMcpResourceToolDefinition());
    base.push(cursorCallMcpToolDefinition());
    base.push(...mcpTools);
  }
  return base;
}

function responsesInputFromMessages(messages) {
  return messages.map(message => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const text = (message.content || [])
      .filter(part => part?.type === 'text' && part.text)
      .map(part => String(part.text))
      .join('\n');
    return {
      type: 'message',
      role,
      content: [{
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text,
      }],
    };
  });
}

function buildCursorInitialInput(sess) {
  const conversationID = sess.conversationID || sess.requestID || '';
  const history = conversationID ? loadConversationHistory(conversationID) : [];
  const messages = [
    ...history,
    { role: 'user', content: [textPart(sess.userText)] },
  ];
  return { conversationID, messages, input: responsesInputFromMessages(messages) };
}

function buildAssistantInputItem(text) {
  const value = String(text || '');
  return {
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: value,
    }],
  };
}

function buildFunctionCallInputItem(toolCall) {
  return {
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments || '{}',
  };
}

function buildFunctionCallOutputInputItem(toolCall, output) {
  return {
    type: 'function_call_output',
    call_id: toolCall.id,
    output: String(output || ''),
  };
}

function limitUtf8Bytes(text, maxBytes) {
  const value = String(text || '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end = Math.max(0, end - Math.ceil((end || 1) / 8));
  }
  while (end < value.length && Buffer.byteLength(value.slice(0, end + 1), 'utf8') <= maxBytes) {
    end += 1;
  }
  return value.slice(0, end);
}

function prepareToolOutputForModel(toolCall, output) {
  const value = output === undefined || output === null || output === ''
    ? '{"result":"ok"}'
    : String(output);
  if (Buffer.byteLength(value, 'utf8') <= CURSOR_TOOL_RESULT_MAX_BYTES) return value;
  const toolName = String(toolCall?.name || 'tool');
  const marker = `\n[truncated: Cursor ${toolName} tool output exceeded ${CURSOR_TOOL_RESULT_MAX_BYTES} bytes; rerun with a narrower scope or read a specific file/range for the rest.]`;
  return `${limitUtf8Bytes(value, CURSOR_TOOL_RESULT_MAX_BYTES)}${marker}`;
}

function buildLocalProxyContext(sess, adapter, inputItems = null) {
  const initial = inputItems ? null : buildCursorInitialInput(sess);
  const tools = cursorReadTools(sess);
  const system = [
    CURSOR_AGENT_SYSTEM,
    cursorModePrompt(sess.mode),
    activePlanPrompt(sess.conversationID || sess.requestID || ''),
    mcpToolsPrompt(sess),
  ].filter(Boolean).join('\n');
  const input = inputItems || initial.input;
  return {
    kind: 'responses',
    model: adapter.id,
    system,
    messages: initial?.messages || [],
    tools,
    toolChoice: 'auto',
    stream: true,
    maxTokens: 4096,
    rawBody: {
      model: adapter.id,
      instructions: system,
      input,
      stream: true,
      max_output_tokens: 4096,
      tools,
      tool_choice: 'auto',
    },
  };
}

function recordConversationTurn(sess, assistantText) {
  const conversationID = sess.conversationID || sess.requestID || '';
  if (!conversationID || !sess.userText) return;
  const history = loadConversationHistory(conversationID);
  history.push({ role: 'user', content: [textPart(sess.userText)] });
  history.push({ role: 'assistant', content: [textPart(assistantText)] });
  while (history.length > CURSOR_HISTORY_MAX_MESSAGES) history.shift();
  historyByConversation.set(conversationID, history);
  persistConversationHistory(conversationID, history);
}

function buildInteractionUpdateFrame(updateField, updateBody) {
  return writeMessageField(1, writeMessageField(updateField, updateBody));
}

function buildTextDeltaFrame(text) {
  return buildInteractionUpdateFrame(1, writeStringField(1, text));
}

function buildThinkingDeltaFrame(text) {
  return buildInteractionUpdateFrame(4, writeStringField(1, text));
}

function buildTokenDeltaFrame(tokens) {
  return buildInteractionUpdateFrame(8, writeVarintField(1, Math.max(0, Number(tokens) || 0)));
}

function buildTurnEndedFrame() {
  return buildInteractionUpdateFrame(14, Buffer.alloc(0));
}

function buildBackgroundInteractionHeartbeatFrame() {
  return writeMessageField(13, Buffer.alloc(0));
}

function writeRunFrame(res, protoBody) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(wrapEnvelope(protoBody, true));
  if (typeof res.flush === 'function') res.flush();
  return true;
}

function startRunSseResponse(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connect-content-encoding': 'gzip',
    'connect-accept-encoding': 'gzip',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function writeToolStarted(res, toolCallID, toolProto, modelCallID = '') {
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, toolProto, modelCallID))) {
    throw new Error(`Cursor tool call ${toolCallID} failed to write started frame`);
  }
}

function writeToolCompleted(res, toolCallID, toolProto, modelCallID = '') {
  if (!writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, toolProto, modelCallID))) {
    throw new Error(`Cursor tool call ${toolCallID} failed to write completed frame`);
  }
}

async function executeLocalPlanTool(res, sess, toolCall) {
  const toolCallID = String(toolCall?.id || '');
  if (!toolCallID) throw new Error(`Cursor ${toolCall?.name || 'plan'} tool call is missing call_id`);
  const conversationID = sess?.conversationID || sess?.requestID || '';
  if (!conversationID) throw new Error(`Cursor ${toolCall.name} requires a conversation_id`);
  const args = parseToolArguments(toolCall);

  if (toolCall.name === 'SwitchMode') {
    const targetModeID = cursorPickerModeID(args.target_mode_id ?? args.targetModeId);
    const explanation = String(args.explanation || '').trim();
    if (!targetModeID) throw new Error('Cursor SwitchMode target_mode_id must be one of: agent, ask, plan, debug');
    if (!explanation) throw new Error('Cursor SwitchMode requires explanation');
    const fromModeID = cursorPickerModeID(sess?.mode) || 'agent';
    const queryID = interactionQueryID(toolCallID);
    const startTool = buildSwitchModeToolCall({ targetModeID, explanation, toolCallID });
    writeToolStarted(res, toolCallID, startTool);
    const wait = registerInteractionWait(queryID);
    if (!writeRunFrame(res, buildSwitchModeInteractionQueryFrame({ queryID, targetModeID, explanation, toolCallID }))) {
      pendingInteractionResponses.delete(queryID);
      throw new Error(`Cursor SwitchMode tool call ${toolCallID} failed to write interaction query`);
    }
    let response;
    try {
      response = await wait;
    } catch (err) {
      const message = err?.message || String(err);
      writeToolCompleted(res, toolCallID, buildSwitchModeToolCall({
        targetModeID,
        explanation,
        toolCallID,
        result: { error: message },
      }));
      return JSON.stringify({
        result: 'timeout',
        mode: cursorModeLabelFromPicker(fromModeID),
        error: message,
        note: 'User did not respond to the Cursor mode switch prompt in time. Continue in the previous mode.',
      });
    }
    const verdict = response?.switchMode || {};
    if (verdict.kind === 'rejected') {
      writeToolCompleted(res, toolCallID, buildSwitchModeToolCall({
        targetModeID,
        explanation,
        toolCallID,
        result: { rejectedReason: verdict.reason || 'Rejected' },
      }));
      return JSON.stringify({
        result: 'rejected',
        mode: cursorModeLabelFromPicker(fromModeID),
        reason: verdict.reason || 'Rejected',
        note: 'User rejected the mode switch. Continue in the previous mode.',
      });
    }
    sess.mode = cursorModeLabelFromPicker(targetModeID);
    writeToolCompleted(res, toolCallID, buildSwitchModeToolCall({
      targetModeID,
      explanation,
      toolCallID,
      result: { fromModeID, toModeID: targetModeID },
    }));
    return JSON.stringify({
      result: 'approved',
      mode: cursorModeLabelFromPicker(targetModeID),
      note: 'User approved the mode switch. Continue in the new mode.',
    });
  }

  if (toolCall.name === 'CreatePlan') {
    const name = String(args.name || '').trim();
    const overview = String(args.overview || '').trim();
    if (!name) throw new Error('Cursor CreatePlan requires name');
    if (!overview) throw new Error('Cursor CreatePlan requires overview');
    if (!Array.isArray(args.todos)) throw new Error('Cursor CreatePlan requires todos array');
    const todos = args.todos.map((item, index) => {
      const content = String(item || '').trim();
      if (!content) throw new Error(`Cursor CreatePlan todos[${index}] is empty`);
      return { id: `t${index + 1}`, content, status: 'pending' };
    });
    const plan = savePlanState(conversationID, name, overview, todos);
    writeToolStarted(res, toolCallID, buildCreatePlanToolCall(plan));
    if (!planEmittedByConversation.has(conversationID)) {
      if (!writeRunFrame(res, buildCreatePlanInteractionQueryFrame({ toolCallID, ...plan }))) {
        throw new Error(`Cursor CreatePlan tool call ${toolCallID} failed to write interaction query`);
      }
      planEmittedByConversation.add(conversationID);
    }
    writeToolCompleted(res, toolCallID, buildCreatePlanToolCall({ ...plan, includeResult: true }));
    return JSON.stringify({
      result: 'ok',
      name: plan.name,
      overview: plan.overview,
      todos: todosForJSON(plan.todos),
      note: 'Plan created. Continue work; use UpdateTodo as items progress. Do not call CreatePlan again for the same task unless replacing the plan is intentional.',
    });
  }

  if (toolCall.name === 'AddTodo') {
    const plan = appendTodo(conversationID, args.content);
    if (!plan) throw new Error('no active plan - call CreatePlan first');
    writeToolStarted(res, toolCallID, buildUpdateTodosToolCall({ todos: plan.todos }));
    writeToolCompleted(res, toolCallID, buildUpdateTodosToolCall({ todos: plan.todos, includeResult: true }));
    const last = plan.todos[plan.todos.length - 1] || {};
    return JSON.stringify({
      result: 'ok',
      id: last.id || '',
      todos: todosForJSON(plan.todos),
    });
  }

  if (toolCall.name === 'UpdateTodo') {
    const updated = updateTodoStatus(conversationID, args);
    if (!updated.plan) throw new Error('no active plan - call CreatePlan first');
    if (!updated.matchedID) throw new Error('todo not found - pass id or a content prefix');
    writeToolStarted(res, toolCallID, buildUpdateTodosToolCall({ todos: updated.plan.todos }));
    writeToolCompleted(res, toolCallID, buildUpdateTodosToolCall({ todos: updated.plan.todos, includeResult: true }));
    return JSON.stringify({
      result: 'ok',
      id: updated.matchedID,
      todos: todosForJSON(updated.plan.todos),
    });
  }

  throw new Error(`Cursor local plan tool is not implemented: ${toolCall.name}`);
}

function writeBackgroundFrame(res, state, frame) {
  appendBackgroundUpdate(state, frame);
  return writeRunFrame(res, frame);
}

function textChunks(text, size = 800) {
  const value = String(text || '');
  if (!value) return [];
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function usageTokens(usage, fallbackText = '') {
  const explicit = Number(usage?.totalTokens);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const input = Number(usage?.inputTokens) || Number(usage?.input_tokens) || Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.outputTokens) || Number(usage?.output_tokens) || Number(usage?.completion_tokens) || 0;
  const total = input + output;
  return total > 0 ? total : estimateTokens(fallbackText);
}

function mergeUsage(left, right) {
  if (!right) return left || null;
  const out = { ...(left || {}) };
  for (const [target, keys] of [
    ['inputTokens', ['inputTokens', 'input_tokens', 'prompt_tokens']],
    ['outputTokens', ['outputTokens', 'output_tokens', 'completion_tokens']],
    ['cachedTokens', ['cachedTokens', 'cached_tokens']],
    ['totalTokens', ['totalTokens', 'total_tokens', 'total']],
  ]) {
    const value = keys.map(key => Number(right?.[key]) || 0).find(v => v > 0) || 0;
    out[target] = (Number(out[target]) || 0) + value;
  }
  return out;
}

function openAIUsageFromStream(usage = {}) {
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens) || 0;
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens) || 0;
  return { inputTokens, outputTokens, cachedTokens };
}

async function* parseUpstreamSSE(response) {
  if (!response || typeof response[Symbol.asyncIterator] !== 'function') {
    throw new Error('Cursor RunSSE streaming requested but upstream response is not a readable stream');
  }
  let buffer = '';
  for await (const chunk of response) {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trimStart();
      if (data === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        throw new Error(`Cursor RunSSE upstream stream contained invalid JSON data: ${data.slice(0, 500)}`);
      }
      if (parsed?.error) {
        const message = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error);
        throw new Error(`Cursor RunSSE upstream stream error: ${message}`);
      }
      yield parsed;
    }
  }
  const trimmed = buffer.trim();
  if (trimmed.startsWith('data:')) {
    const data = trimmed.slice(5).trimStart();
    if (data && data !== '[DONE]') {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new Error(`Cursor RunSSE upstream stream contained invalid trailing JSON data: ${data.slice(0, 500)}`);
      }
      if (parsed?.error) {
        const message = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error);
        throw new Error(`Cursor RunSSE upstream stream error: ${message}`);
      }
      yield parsed;
    }
  } else if (trimmed) {
    throw new Error(`Cursor RunSSE upstream stream ended with non-SSE trailing data: ${trimmed.slice(0, 500)}`);
  }
}

function chatStreamDeltas(chunk) {
  let text = '';
  let thinking = '';
  for (const choice of chunk?.choices || []) {
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string') text += delta.content;
    if (Array.isArray(delta.content)) {
      text += delta.content.map(part => part?.text || '').filter(Boolean).join('');
    }
    if (typeof delta.reasoning_content === 'string') thinking += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') thinking += delta.reasoning;
  }
  return { text, thinking };
}

function accumulateChatToolCalls(chunk, accs) {
  for (const choice of chunk?.choices || []) {
    const sources = [];
    if (choice?.message && Array.isArray(choice.message.tool_calls)) sources.push(choice.message.tool_calls);
    if (choice?.delta && Array.isArray(choice.delta.tool_calls)) sources.push(choice.delta.tool_calls);
    for (const toolCalls of sources) {
      for (const tc of toolCalls) {
        const index = Number.isFinite(Number(tc.index)) ? Number(tc.index) : 0;
        if (!accs[index]) {
          accs[index] = { id: '', name: '', arguments: '' };
        }
        if (tc.id) accs[index].id = String(tc.id);
        if (tc.function?.name) accs[index].name = String(tc.function.name);
        if (typeof tc.function?.arguments === 'string') {
          accs[index].arguments += tc.function.arguments;
        }
      }
    }
  }
}

function finalizeToolCalls(accs) {
  return accs
    .filter(Boolean)
    .map((tc, index) => ({
      id: tc.id || `call_${crypto.createHash('sha256').update(`${tc.name}|${tc.arguments}|${index}`).digest('hex').slice(0, 24)}`,
      name: tc.name,
      arguments: tc.arguments || '{}',
    }))
    .filter(tc => tc.name);
}

function responseObjToolCalls(responseObj) {
  const out = [];
  for (const item of responseObj?.output || []) {
    if (item?.type !== 'function_call') continue;
    out.push({
      id: item.call_id || item.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: item.name || '',
      arguments: String(item.arguments || '{}'),
    });
  }
  return out.filter(tc => tc.name);
}

async function writeStreamingResult(res, result) {
  let assistantText = '';
  let usage = null;
  const toolAccs = [];
  let finishReason = '';
  for await (const chunk of parseUpstreamSSE(result.upstreamResponse)) {
    if (chunk?.usage) usage = openAIUsageFromStream(chunk.usage);
    accumulateChatToolCalls(chunk, toolAccs);
    for (const choice of chunk?.choices || []) {
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    const delta = chatStreamDeltas(chunk);
    if (delta.thinking && !writeRunFrame(res, buildThinkingDeltaFrame(delta.thinking))) {
      return { assistantText, usage, toolCalls: finalizeToolCalls(toolAccs), finishReason, disconnected: true };
    }
    if (delta.text) {
      assistantText += delta.text;
      if (!writeRunFrame(res, buildTextDeltaFrame(delta.text))) {
        return { assistantText, usage, toolCalls: finalizeToolCalls(toolAccs), finishReason, disconnected: true };
      }
    }
  }
  if (usage && (usage.inputTokens || usage.outputTokens || usage.cachedTokens)) {
    recordUsage(usage);
  }
  return { assistantText, usage, toolCalls: finalizeToolCalls(toolAccs), finishReason, disconnected: false };
}

function parseToolArguments(toolCall) {
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

async function executeCursorToolCall(res, toolCall, log, sess = null) {
  if (['CreatePlan', 'AddTodo', 'UpdateTodo', 'SwitchMode'].includes(toolCall.name)) {
    try {
      return await executeLocalPlanTool(res, sess, toolCall);
    } catch (err) {
      const message = cursorErrorMessage(err);
      log(`Cursor ${toolCall.name} tool failed call_id=${toolCall.id}: ${message}`);
      return JSON.stringify({ error: message });
    }
  }
  if (toolCall.name?.startsWith('mcp_') || ['CallMcpTool', 'ListMcpResources', 'FetchMcpResource'].includes(toolCall.name)) {
    try {
      const result = await executeMcpCursorTool(res, sess, toolCall);
      return result.resultJSON;
    } catch (err) {
      const message = cursorErrorMessage(err);
      log(`Cursor ${toolCall.name} tool failed call_id=${toolCall.id}: ${message}`);
      return JSON.stringify({ error: message });
    }
  }
  if (!['Read', 'Glob', 'Grep', 'Shell', 'Write', 'StrReplace', 'Delete'].includes(toolCall.name)) {
    const message = `Cursor tool is not implemented in AnyBridge Cursor BYOK yet: ${toolCall.name}`;
    log(message);
    return JSON.stringify({ error: message });
  }
  let args;
  try {
    args = parseToolArguments(toolCall);
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
  try {
    let result;
    if (toolCall.name === 'Read') {
      result = await executeReadCursorTool(res, {
        callID: toolCall.id,
        path: args.path,
        offset: args.offset,
        limit: args.limit,
        includeLineNumbers: args.include_line_numbers ?? args.includeLineNumbers,
      });
    } else if (toolCall.name === 'Glob') {
      result = await executeGlobCursorTool(res, {
        callID: toolCall.id,
        globPattern: args.glob_pattern ?? args.globPattern,
        targetDirectory: args.target_directory ?? args.targetDirectory,
      });
    } else if (toolCall.name === 'Grep') {
      result = await executeGrepCursorTool(res, {
        callID: toolCall.id,
        pattern: args.pattern,
        path: args.path,
        glob: args.glob,
        outputMode: args.output_mode ?? args.outputMode,
        contextBefore: args['-B'] ?? args.context_before ?? args.contextBefore,
        contextAfter: args['-A'] ?? args.context_after ?? args.contextAfter,
        context: args['-C'] ?? args.context,
        caseInsensitive: args['-i'] ?? args.case_insensitive ?? args.caseInsensitive,
        type: args.type,
        headLimit: args.head_limit ?? args.headLimit,
        multiline: args.multiline,
        sort: args.sort,
        sortAscending: args.sort_ascending ?? args.sortAscending,
      });
    } else if (toolCall.name === 'Shell') {
      result = await executeShellCursorTool(res, {
        callID: toolCall.id,
        command: args.command,
        workingDirectory: args.working_directory ?? args.workingDirectory,
        blockUntilMs: args.block_until_ms ?? args.blockUntilMs,
      });
    } else if (toolCall.name === 'Write') {
      result = await executeWriteCursorTool(res, {
        callID: toolCall.id,
        path: args.path,
        contents: args.contents ?? args.content,
      });
    } else if (toolCall.name === 'StrReplace') {
      result = await executeStrReplaceCursorTool(res, {
        callID: toolCall.id,
        path: args.path,
        oldString: args.old_string ?? args.oldString,
        newString: args.new_string ?? args.newString,
        replaceAll: args.replace_all ?? args.replaceAll,
      });
    } else {
      result = await executeDeleteCursorTool(res, {
        callID: toolCall.id,
        path: args.path,
      });
    }
    return result.resultJSON;
  } catch (err) {
    const message = cursorErrorMessage(err);
    log(`Cursor ${toolCall.name} tool failed call_id=${toolCall.id}: ${message}`);
    return JSON.stringify({ error: message });
  }
}

function cursorErrorMessage(err) {
  const base = err?.message || String(err);
  const upstreamBody = err?.upstreamResponse?.body;
  if (!upstreamBody) return base;
  const preview = String(upstreamBody).slice(0, 1000);
  return `${base}: ${preview}`;
}

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

function handleBackgroundAddFollowup(req, res, body, log) {
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

function handleBackgroundStatus(req, res, body, log) {
  const payloads = decodeCursorPayloads(body, req.headers);
  const statusReq = parseGetBackgroundComposerStatusRequest(payloads[0] || Buffer.alloc(0));
  const state = getBackgroundComposer(statusReq.bcID);
  const status = state?.status || 0;
  log(`Cursor BackgroundComposer status bc_id=${statusReq.bcID || '(missing)'} status=${status}`);
  respondProto(res, buildGetBackgroundComposerStatusResponse(status));
}

async function writeBackgroundStreamingResult(res, state, result) {
  let assistantText = '';
  let usage = null;
  const toolAccs = [];
  let finishReason = '';
  for await (const chunk of parseUpstreamSSE(result.upstreamResponse)) {
    if (chunk?.usage) usage = openAIUsageFromStream(chunk.usage);
    accumulateChatToolCalls(chunk, toolAccs);
    for (const choice of chunk?.choices || []) {
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    const delta = chatStreamDeltas(chunk);
    const text = delta.text || delta.thinking;
    if (!text) continue;
    assistantText += delta.text || '';
    const frame = buildAttachBackgroundComposerResponse({
      state,
      text,
      status: BACKGROUND_STATUS_RUNNING,
    });
    if (!writeBackgroundFrame(res, state, frame)) {
      return { assistantText, usage, toolCalls: finalizeToolCalls(toolAccs), finishReason, disconnected: true };
    }
  }
  if (usage && (usage.inputTokens || usage.outputTokens || usage.cachedTokens)) {
    recordUsage(usage);
  }
  return { assistantText, usage, toolCalls: finalizeToolCalls(toolAccs), finishReason, disconnected: false };
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

async function handleBackgroundAttach(req, res, body, log) {
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

function writeBugBotFrame(res, response) {
  return writeRunFrame(res, buildBugBotServerMessage(response));
}

function buildBugBotErrorResponse(message) {
  const text = String(message || 'Cursor BugBot failed');
  return buildBugBotResponse({
    status: BUGBOT_STATUS_ERROR,
    message: text,
    summary: text,
  });
}

async function handleBugBotRunSSE(req, res, body, log) {
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

function handleBackgroundInteractionUpdates(req, res, body, log) {
  startRunSseResponse(res);
  log(`Cursor BackgroundComposer interaction updates heartbeat stream`);
  writeRunFrame(res, buildBackgroundInteractionHeartbeatFrame());
  if (!res.destroyed && !res.writableEnded) {
    res.end(endOfStreamEnvelope());
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

export const __cursorProxyTest = {
  stableModelID,
  parseBidiAppend,
  parseStreamBugBotRequest,
  buildBugBotPrompt,
  buildBugBotResponse,
  buildBugBotServerMessage,
  parseBugBotModelResponse,
  cursorReadTools,
  buildCursorInitialInput,
  buildLocalProxyContext,
  prepareToolOutputForModel,
  writeStreamingResult,
  writeBackgroundStreamingResult,
  responseObjToolCalls,
  parseExecClientMessage,
  buildReadToolResult,
  buildReadToolCall,
  buildReadExecServerMessage,
  buildShellToolCall,
  buildShellExecServerMessage,
  buildShellResult,
  buildEditToolCall,
  buildWriteExecServerMessage,
  buildDeleteToolCall,
  buildDeleteExecServerMessage,
  buildGlobToolResult,
  buildGlobToolCall,
  buildLsExecServerMessage,
  buildGrepToolCall,
  buildGrepExecServerMessage,
  buildCreatePlanToolCall,
  buildUpdateTodosToolCall,
  buildCreatePlanInteractionQueryFrame,
  buildSwitchModeToolCall,
  buildSwitchModeInteractionQueryFrame,
  buildMcpToolCall,
  buildMcpExecServerMessage,
  buildListMcpResourcesToolCall,
  buildListMcpResourcesExecServerMessage,
  buildReadMcpResourceToolCall,
  buildReadMcpResourceExecServerMessage,
  parseMcpResult,
  executeLocalPlanTool,
  executeCursorToolCall,
  executeMcpCursorTool,
  planStateFor,
  globToRegex,
  collectGlobMatches,
  globResultFromLsResult,
  buildExecServerFrame,
  buildToolCallStartedFrame,
  buildToolCallCompletedFrame,
  executeReadCursorTool,
  executeShellCursorTool,
  executeWriteCursorTool,
  executeStrReplaceCursorTool,
  executeDeleteCursorTool,
  executeGlobCursorTool,
  executeGrepCursorTool,
  applyStrReplaceToFile,
  registerExecIDAlias,
  registerToolWait,
  deliverToolResult,
  parseInteractionResponse,
  deliverInteractionResponse,
  resetToolWaitsForTest,
  resetInteractionWaitsForTest,
  parseWriteGitCommitMessageRequest,
  buildWriteGitCommitMessageResponse,
  parseAddBackgroundComposerRequest,
  parseGetBackgroundComposerStatusRequest,
  parseAttachBackgroundComposerRequest,
  buildAttachBackgroundComposerResponse,
  buildGetBackgroundComposerStatusResponse,
  buildTextDeltaFrame,
  buildThinkingDeltaFrame,
  buildTokenDeltaFrame,
  buildTurnEndedFrame,
  buildBackgroundInteractionHeartbeatFrame,
  rememberSession,
  waitForSession,
  dropSession,
  resetSessionStoreForTest,
  resetHistoryStoreForTest,
  resetPlanStoreForTest,
  loadConversationHistory,
  recordConversationTurn,
  conversationHistoryPath,
  conversationArtifactDir,
  persistCursorTurnArtifacts,
  resetBackgroundComposersForTest,
};
