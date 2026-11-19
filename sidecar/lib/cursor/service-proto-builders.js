// lib/cursor/service-proto-builders.js - Modular component split from cursor-proxy.js.

import path from "node:path";
import { writeMessageField, writeStringField, writeVarintField } from "../../proto.js";
import { BACKGROUND_STATUS_RUNNING, BUGBOT_MAX_REPORTS, BUGBOT_RESPONSE_PREVIEW_BYTES, concat, writeBoolField } from "./common.js";

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


export function buildAvailableModelsResponse(models) {
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


export function buildDefaultModelNudgeResponse(models) {
  if (!models.length) return Buffer.alloc(0);
  return concat([
    writeStringField(1, '0'),
    writeStringField(3, models[0].stableID),
  ]);
}


export function buildCommitMessagePrompt(commitReq) {
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


export function sanitizeCommitMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Cursor commit message generation returned empty text');
  return trimmed
    .replace(/^```(?:text|gitcommit)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}


export function buildWriteGitCommitMessageResponse(message) {
  return writeStringField(1, message);
}


export function backgroundPromptText(state) {
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


export function buildAttachBackgroundComposerResponse({ state, text = '', done = false, error = '', status = BACKGROUND_STATUS_RUNNING, includePrompt = false, statusMessage = '', complete = false } = {}) {
  return concat([
    writeMessageField(1, buildHeadlessResponse({ text, done, error, statusMessage, complete })),
    includePrompt && state ? writeMessageField(2, buildHeadlessPrompt(state)) : null,
    writeVarintField(6, status),
  ]);
}


export function buildGetBackgroundComposerStatusResponse(status, unread = false) {
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


export function buildBugBotResponse({ reports = [], status, message = '', summary = '', numTurns = 0, iterationsCompleted = 0, totalIterations = 0 } = {}) {
  return concat([
    reports.length ? writeMessageField(1, buildBugReports(reports)) : null,
    writeMessageField(2, buildBugBotStatus({ status, message, iterationsCompleted, totalIterations })),
    summary ? writeStringField(3, summary) : null,
    numTurns ? writeVarintField(5, numTurns) : null,
  ]);
}


export function buildBugBotServerMessage(response) {
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


export function parseBugBotModelResponse(text) {
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

