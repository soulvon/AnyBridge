// lib/cursor/tool-proto-builders.js — Cursor 计划/模式切换/MCP/流式帧协议构建器（FS/Shell 构造器见 ./tool-proto-fs.js）

import crypto from 'node:crypto';
import { wrapEnvelope } from '../../connect.js';
import { writeFixed64Field, writeMessageField, writeStringField, writeVarintField } from '../../proto.js';
import { cloneTodos, concat, todoStatusCode, writeBoolField } from './common.js';
import { nextExecSeq } from './exec-waits.js';
import {
  buildDeleteExecServerMessage,
  buildDeleteToolCall,
  buildEditToolCall,
  buildGlobToolCall,
  buildGlobToolResult,
  buildGrepExecServerMessage,
  buildGrepToolCall,
  buildLsExecServerMessage,
  buildReadExecServerMessage,
  buildReadToolCall,
  buildReadToolResult,
  buildShellExecServerMessage,
  buildShellResult,
  buildShellToolCall,
  buildWriteExecServerMessage,
} from './tool-proto-fs.js';

export {
  buildDeleteExecServerMessage,
  buildDeleteToolCall,
  buildEditToolCall,
  buildGlobToolCall,
  buildGlobToolResult,
  buildGrepExecServerMessage,
  buildGrepToolCall,
  buildLsExecServerMessage,
  buildReadExecServerMessage,
  buildReadToolCall,
  buildReadToolResult,
  buildShellExecServerMessage,
  buildShellResult,
  buildShellToolCall,
  buildWriteExecServerMessage,
};

export function buildExecServerFrame(execServerMessage) {
  return writeMessageField(2, execServerMessage);
}

function buildToolCallUpdateFrame(updateField, callID, toolCall, modelCallID = '') {
  return buildInteractionUpdateFrame(updateField, concat([
    writeStringField(1, String(callID || '')),
    writeMessageField(2, toolCall),
    modelCallID ? writeStringField(3, modelCallID) : null,
  ]));
}

export function buildToolCallStartedFrame(callID, toolCall, modelCallID = '') {
  return buildToolCallUpdateFrame(2, callID, toolCall, modelCallID);
}

export function buildToolCallCompletedFrame(callID, toolCall, modelCallID = '') {
  return buildToolCallUpdateFrame(3, callID, toolCall, modelCallID);
}

export function newCursorExecID(kind = 'tool') {
  return `exec-${String(kind || 'tool').toLowerCase()}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
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

export function buildCreatePlanToolCall({ name, overview, todos, includeResult = false } = {}) {
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

export function buildUpdateTodosToolCall({ todos, merge = false, includeResult = false } = {}) {
  const items = cloneTodos(todos);
  return writeMessageField(9, concat([
    writeMessageField(1, buildUpdateTodosArgs(items, merge)),
    includeResult ? writeMessageField(2, buildUpdateTodosResult(items, merge)) : null,
  ]));
}

export function interactionQueryID(toolCallID) {
  const hash = crypto.createHash('sha256').update(String(toolCallID || '')).digest();
  const id = hash.readUInt32BE(0);
  return id || 1;
}

export function cursorPickerModeID(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'ask' || value === 'chat') return 'chat';
  if (value === 'plan') return 'plan';
  if (value === 'debug') return 'debug';
  if (value === 'agent') return 'agent';
  return '';
}

export function cursorModeLabelFromPicker(mode) {
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

export function buildSwitchModeToolCall({ targetModeID, explanation, toolCallID, result } = {}) {
  return writeMessageField(25, concat([
    writeMessageField(1, buildSwitchModeArgs({ targetModeID, explanation, toolCallID })),
    result ? writeMessageField(2, buildSwitchModeResult(result)) : null,
  ]));
}

export function buildSwitchModeInteractionQueryFrame({ queryID, targetModeID, explanation, toolCallID } = {}) {
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

export function buildMcpToolCall({ name, args, toolCallID, providerIdentifier, toolName, mcpResult } = {}) {
  return writeMessageField(15, concat([
    writeMessageField(1, buildMcpArgs({ name, args, toolCallID, providerIdentifier, toolName })),
    mcpResult ? writeMessageField(2, buildMcpToolResult(mcpResult)) : null,
  ]));
}

export function buildMcpExecServerMessage({ seq, execID, name, args, toolCallID, providerIdentifier, toolName } = {}) {
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

export function buildListMcpResourcesToolCall({ server, resultRaw } = {}) {
  return writeMessageField(20, concat([
    writeMessageField(1, buildListMcpResourcesArgs({ server })),
    resultRaw ? writeMessageField(2, resultRaw) : null,
  ]));
}

export function buildListMcpResourcesExecServerMessage({ seq, execID, server } = {}) {
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

export function buildReadMcpResourceToolCall({ server, uri, downloadPath, resultRaw } = {}) {
  return writeMessageField(21, concat([
    writeMessageField(1, buildReadMcpResourceArgs({ server, uri, downloadPath })),
    resultRaw ? writeMessageField(2, resultRaw) : null,
  ]));
}

export function buildReadMcpResourceExecServerMessage({ seq, execID, server, uri, downloadPath } = {}) {
  const id = Number(seq) || nextExecSeq();
  return concat([
    writeVarintField(1, id),
    writeMessageField(18, buildReadMcpResourceArgs({ server, uri, downloadPath })),
    execID ? writeStringField(15, execID) : null,
  ]);
}

export function buildCreatePlanInteractionQueryFrame({ toolCallID, name, overview, todos } = {}) {
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

function buildInteractionUpdateFrame(updateField, updateBody) {
  return writeMessageField(1, writeMessageField(updateField, updateBody));
}

export function buildTextDeltaFrame(text) {
  return buildInteractionUpdateFrame(1, writeStringField(1, text));
}

export function buildThinkingDeltaFrame(text) {
  return buildInteractionUpdateFrame(4, writeStringField(1, text));
}

export function buildTokenDeltaFrame(tokens) {
  return buildInteractionUpdateFrame(8, writeVarintField(1, Math.max(0, Number(tokens) || 0)));
}

export function buildTurnEndedFrame() {
  return buildInteractionUpdateFrame(14, Buffer.alloc(0));
}

export function buildBackgroundInteractionHeartbeatFrame() {
  return writeMessageField(13, Buffer.alloc(0));
}

export function writeRunFrame(res, protoBody) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(wrapEnvelope(protoBody, true));
  if (typeof res.flush === 'function') res.flush();
  return true;
}

export function startRunSseResponse(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connect-content-encoding': 'gzip',
    'connect-accept-encoding': 'gzip',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function writeToolStarted(res, toolCallID, toolProto, modelCallID = '') {
  if (!writeRunFrame(res, buildToolCallStartedFrame(toolCallID, toolProto, modelCallID))) {
    throw new Error(`Cursor tool call ${toolCallID} failed to write started frame`);
  }
}

export function writeToolCompleted(res, toolCallID, toolProto, modelCallID = '') {
  if (!writeRunFrame(res, buildToolCallCompletedFrame(toolCallID, toolProto, modelCallID))) {
    throw new Error(`Cursor tool call ${toolCallID} failed to write completed frame`);
  }
}
