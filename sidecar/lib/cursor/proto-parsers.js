// lib/cursor/proto-parsers.js — Cursor Agent / BidiAppend / Exec 结果 / BackgroundComposer 请求解析器
// （文件系统工具解析在 ./proto-parsers-fs.js，MCP 与 Google Struct 解析在 ./proto-parsers-mcp.js，BugBot 解析在 ./proto-parsers-bugbot.js）

import crypto from 'node:crypto';
import { fieldToInt, fieldToString, getAllFields, getField, parseFields } from '../../proto.js';
import { decodeHexProto } from './common.js';
import { buildBugBotPrompt, parseAiserverModelDetails, parseBugBotClientMessage, parseStreamBugBotRequest } from './proto-parsers-bugbot.js';
import { parseDeleteResult, parseGrepResult, parseListMcpResourcesResult, parseLsResult, parseMcpResult, parseReadMcpResourceResult, parseReadResult, parseShellStream, parseWriteResult } from './proto-parsers-fs.js';
import { parseMcpFileSystemOptions, parseMcpInstructions, parseMcpToolDefinition, parseMcpTools } from './proto-parsers-mcp.js';
import { getSessionForRequest } from './stores.js';

export { buildBugBotPrompt, parseStreamBugBotRequest };

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

export function parseRequestedModel(buf) {
  const fields = parseFields(buf);
  // parameters (field 3) 携带用户在 Cursor 界面选的思考档位（effort/thinking/fast/context）。
  const parameters = {};
  for (const field of getAllFields(fields, 3)) {
    if (field.wireType !== 2) continue;
    const paramFields = parseFields(field.value);
    const id = fieldToString(getField(paramFields, 1, 2));
    const value = fieldToString(getField(paramFields, 2, 2));
    if (id) parameters[id] = value;
  }
  return {
    modelId: fieldToString(getField(fields, 1, 2)),
    maxMode: fieldToInt(getField(fields, 2, 0)) === 1,
    parameters,
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

export function parseInteractionResponse(buf) {
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

export function parseExecClientMessage(buf) {
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

export function resultJSONFromExecClient(execMsg) {
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

export function parseBidiAppend(payload) {
  const fields = parseFields(payload);
  const requestIDField = getField(fields, 2, 2);
  const requestID = requestIDField ? firstStringField(requestIDField.value, 1) : '';
  const data = fieldToString(getField(fields, 1, 2));
  const appendSeqno = fieldToInt(getField(fields, 3, 0));
  const out = { requestID, appendSeqno, dataBytes: data.length ? data.length / 2 : 0 };
  if (!data) return out;
  const raw = decodeHexProto(data);
  const existing = getSessionForRequest(requestID);
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

export function parseBidiRequestID(payload) {
  return firstStringField(payload, 1);
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

export function parseWriteGitCommitMessageRequest(payload) {
  const fields = parseFields(payload);
  const explicit = getField(fields, 3, 2);
  return {
    diffs: stringFields(fields, 1),
    previousCommitMessages: stringFields(fields, 2),
    explicitContext: explicit ? parseExplicitContext(explicit.value) : {},
  };
}

export function parseAddBackgroundComposerRequest(payload) {
  const fields = parseFields(payload);
  const model = getField(fields, 6, 2);
  const bcID = fieldToString(getField(fields, 1, 2));
  return {
    bcID: bcID || `bc-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    followup: fieldToString(getField(fields, 2, 2)),
    richFollowup: fieldToString(getField(fields, 4, 2)),
    modelDetails: model ? parseAiserverModelDetails(model.value) : {},
  };
}

export function parseGetBackgroundComposerStatusRequest(payload) {
  return { bcID: firstStringField(payload, 1) };
}

export function parseAttachBackgroundComposerRequest(payload) {
  const fields = parseFields(payload);
  return {
    bcID: fieldToString(getField(fields, 1, 2)),
    startingIndex: fieldToInt(getField(fields, 2, 0)),
  };
}
