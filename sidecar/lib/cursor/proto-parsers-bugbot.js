// sidecar/lib/cursor/proto-parsers-bugbot.js — Cursor BugBot 请求解析与 Diff 提示词构造

import { fieldToInt, fieldToString, getAllFields, getField, parseFields } from '../../proto.js';

export function parseAiserverModelDetails(buf) {
  const fields = parseFields(buf);
  const modelName = fieldToString(getField(fields, 1, 2));
  return {
    modelName,
    modelId: modelName,
    maxMode: fieldToInt(getField(fields, 8, 0)) === 1,
  };
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

export function parseStreamBugBotRequest(buf) {
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

export function parseBugBotClientMessage(buf) {
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

export function buildBugBotPrompt(req) {
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
