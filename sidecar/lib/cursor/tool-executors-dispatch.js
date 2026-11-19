// lib/cursor/tool-executors-dispatch.js - Modular component split from cursor-proxy.js.

import path from "node:path";
import { cancelInteractionWait, nextExecSeq, registerExecIDAlias, registerInteractionWait, registerToolWait, rejectToolWait } from "./exec-waits.js";
import { buildCreatePlanInteractionQueryFrame, buildCreatePlanToolCall, buildExecServerFrame, buildListMcpResourcesExecServerMessage, buildListMcpResourcesToolCall, buildMcpExecServerMessage, buildMcpToolCall, buildReadMcpResourceExecServerMessage, buildReadMcpResourceToolCall, buildSwitchModeInteractionQueryFrame, buildSwitchModeToolCall, buildToolCallCompletedFrame, buildToolCallStartedFrame, buildUpdateTodosToolCall, cursorModeLabelFromPicker, cursorPickerModeID, interactionQueryID, newCursorExecID, writeRunFrame, writeToolCompleted, writeToolStarted } from "./tool-proto-builders.js";
import { executeDeleteCursorTool, executeGlobCursorTool, executeGrepCursorTool, executeReadCursorTool, executeShellCursorTool, executeStrReplaceCursorTool, executeWriteCursorTool, parseToolArguments } from "./tool-executors-fs.js";
import { appendTodo, hasEmittedPlan, markPlanEmitted, savePlanState, todosForJSON, updateTodoStatus } from "./stores.js";
import { cursorErrorMessage } from "./common.js";

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


export async function executeMcpCursorTool(res, sess, toolCall, { timeoutMs = 30000, execID, seq, modelCallID = '' } = {}) {
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


export async function executeLocalPlanTool(res, sess, toolCall) {
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
      cancelInteractionWait(queryID);
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
    if (!hasEmittedPlan(conversationID)) {
      if (!writeRunFrame(res, buildCreatePlanInteractionQueryFrame({ toolCallID, ...plan }))) {
        throw new Error(`Cursor CreatePlan tool call ${toolCallID} failed to write interaction query`);
      }
      markPlanEmitted(conversationID);
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


export async function executeCursorToolCall(res, toolCall, log, sess = null) {
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

