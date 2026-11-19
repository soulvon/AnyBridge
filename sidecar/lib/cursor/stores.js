// lib/cursor/stores.js - Modular component split from cursor-proxy.js.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config-dir.js";
import { getProxyRoutes } from "../../config-cache.js";
import { boundedMapSet, boundedSetAdd } from "../http-retry.js";
import { BACKGROUND_COMPOSER_TTL_MS, CURSOR_HISTORY_MAX_BYTES, CURSOR_HISTORY_MAX_MESSAGES, RECENT_SESSION_FALLBACK_MS, RUNSSE_WAIT_TIMEOUT_MS, SESSION_TTL_MS, cloneTodos, conversationArtifactDir, conversationHistoryPath, cursorHistoryDir, normalizeTodoStatus, sleep, usageTokens } from "./common.js";

const MAX_CURSOR_STORE_ENTRIES = 500;
const sessionsByRequest = new Map();
const sessionsByConversation = new Map();
const droppedRequestConversation = new Map();
const historyByConversation = new Map();
const backgroundComposers = new Map();
const planByConversation = new Map();
const planEmittedByConversation = new Set();

function getCursorModelsStore() {
  try {
    const file = path.join(configDir(), 'cursor-models.json');
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {}
  return null;
}


export function cursorAdapters() {
  const store = getProxyRoutes();
  if (store?.loadError) {
    throw new Error(`Cursor model list read failed: ${store.loadError}`);
  }
  const routes = Array.isArray(store?.routes) ? store.routes : [];
  const cursorStore = getCursorModelsStore();
  const tagStyle = String(cursorStore?.providerTagStyle || 'badge').trim().toLowerCase();
  const bLeft = cursorStore?.providerBracketLeft ?? '[';
  const bRight = cursorStore?.providerBracketRight ?? ']';

  return routes
    .filter(route => route && route.enabled !== false)
    .filter(route => Array.isArray(route.targets) && route.targets.length > 0)
    .filter(route => {
      const formats = Array.isArray(route.exposedFormats) && route.exposedFormats.length
        ? route.exposedFormats
        : ['openai'];
      return formats.includes('openai');
    })
    .map(route => {
      let displayName = route.displayName || route.id;
      const target = route.targets?.[0];
      const providerId = target?.providerId || '';
      if (providerId) {
        const tagged = `${bLeft}${providerId}${bRight}`;
        if (tagStyle === 'prefix') {
          displayName = `${tagged} ${displayName}`;
        } else if (tagStyle === 'suffix') {
          displayName = `${displayName} ${tagged}`;
        }
      }
      return {
        id: route.id,
        displayName,
        stableID: stableModelID(route.id),
      };
    });
}


export function resolveCursorAdapter(selectedModel) {
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


export function stableModelID(modelID) {
  return crypto.createHash('sha256')
    .update(`byok|${modelID}`)
    .digest('hex')
    .slice(0, 16);
}


export function planStateFor(conversationID) {
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


export function savePlanState(conversationID, name, overview, todos) {
  const key = String(conversationID || '');
  if (!key) throw new Error('Cursor CreatePlan requires a conversation_id');
  const plan = {
    name: String(name || '').trim(),
    overview: String(overview || '').trim(),
    todos: cloneTodos(todos),
  };
  boundedMapSet(planByConversation, key, plan, MAX_CURSOR_STORE_ENTRIES);
  return planStateFor(key);
}


export function appendTodo(conversationID, content) {
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


export function updateTodoStatus(conversationID, { id, content, status } = {}) {
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


export function todosForJSON(todos = []) {
  return cloneTodos(todos).map(todo => ({
    id: todo.id,
    status: todo.status,
    content: todo.content,
  }));
}


export function activePlanPrompt(conversationID) {
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


export function rememberSession(msg) {
  cleanupSessionStore();
  if (!msg.requestID) return msg;
  const existing = sessionsByRequest.get(msg.requestID) || {};
  const next = { ...existing, ...msg, updatedAt: Date.now() };
  boundedMapSet(sessionsByRequest, msg.requestID, next, MAX_CURSOR_STORE_ENTRIES);
  if (next.conversationID && next.userText) {
    boundedMapSet(sessionsByConversation, next.conversationID, next, MAX_CURSOR_STORE_ENTRIES);
  }
  return next;
}


export async function waitForSession(requestID, timeoutMs = RUNSSE_WAIT_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    cleanupSessionStore();
    const sess = sessionsByRequest.get(requestID);
    if (sess?.userText) return { session: sess, reason: 'exact' };
    if (sess?.conversationID) {
      const byConv = sessionsByConversation.get(sess.conversationID);
      if (byConv?.userText) {
        const clone = cloneSessionForRequest(byConv, requestID);
        boundedMapSet(sessionsByRequest, requestID, clone, MAX_CURSOR_STORE_ENTRIES);
        return { session: clone, reason: 'conversation' };
      }
    }
    const dropped = droppedRequestConversation.get(requestID);
    if (dropped?.conversationID) {
      const byConv = sessionsByConversation.get(dropped.conversationID);
      if (byConv?.userText) {
        const clone = cloneSessionForRequest(byConv, requestID);
        boundedMapSet(sessionsByRequest, requestID, clone, MAX_CURSOR_STORE_ENTRIES);
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
    boundedMapSet(sessionsByRequest, requestID, clone, MAX_CURSOR_STORE_ENTRIES);
    return { session: clone, reason: 'recent-single-conversation' };
  }
  return exact ? { session: exact, reason: 'empty' } : null;
}


export function dropSession(requestID) {
  if (!requestID) return;
  const sess = sessionsByRequest.get(requestID);
  if (sess?.conversationID) {
    boundedMapSet(droppedRequestConversation, requestID, {
      conversationID: sess.conversationID,
      updatedAt: Date.now(),
    }, MAX_CURSOR_STORE_ENTRIES);
  }
  sessionsByRequest.delete(requestID);
  cleanupSessionStore();
}


export function resetSessionStoreForTest() {
  sessionsByRequest.clear();
  sessionsByConversation.clear();
  droppedRequestConversation.clear();
}


export function resetHistoryStoreForTest() {
  historyByConversation.clear();
}


export function getSessionForRequest(requestID) {
  if (!requestID) return null;
  return sessionsByRequest.get(requestID) || null;
}

export function hasEmittedPlan(conversationID) {
  return planEmittedByConversation.has(conversationID);
}

export function markPlanEmitted(conversationID) {
  boundedSetAdd(planEmittedByConversation, conversationID, MAX_CURSOR_STORE_ENTRIES);
}

export function resetPlanStoreForTest() {
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


export function saveBackgroundComposer(state) {
  cleanupBackgroundComposers();
  state.updatedAt = Date.now();
  boundedMapSet(backgroundComposers, state.bcID, state, MAX_CURSOR_STORE_ENTRIES);
  return state;
}


export function getBackgroundComposer(bcID) {
  cleanupBackgroundComposers();
  return backgroundComposers.get(String(bcID || '')) || null;
}


export function appendBackgroundUpdate(state, frame) {
  if (!state || !frame) return;
  state.updates.push(frame);
  state.updatedAt = Date.now();
}


export function resetBackgroundComposersForTest() {
  backgroundComposers.clear();
}


export function selectedModelFromSession(sess) {
  return sess?.requestedModel?.modelId
    || sess?.modelDetails?.modelId
    || sess?.modelDetails?.displayModelId
    || sess?.modelDetails?.displayName
    || '';
}


export function textPart(text) {
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


export function loadConversationHistory(conversationID) {
  if (!conversationID) return [];
  if (historyByConversation.has(conversationID)) return historyByConversation.get(conversationID);
  const file = conversationHistoryPath(conversationID);
  if (!fs.existsSync(file)) {
    const empty = [];
    boundedMapSet(historyByConversation, conversationID, empty, MAX_CURSOR_STORE_ENTRIES);
    return empty;
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
  boundedMapSet(historyByConversation, conversationID, messages, MAX_CURSOR_STORE_ENTRIES);
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
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (i < 2) { const t = Date.now() + 100; while (Date.now() < t) {} }
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw lastErr;
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


export function persistCursorTurnArtifacts(sess, {
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


export function recordConversationTurn(sess, assistantText) {
  const conversationID = sess.conversationID || sess.requestID || '';
  if (!conversationID || !sess.userText) return;
  const history = loadConversationHistory(conversationID);
  history.push({ role: 'user', content: [textPart(sess.userText)] });
  history.push({ role: 'assistant', content: [textPart(assistantText)] });
  while (history.length > CURSOR_HISTORY_MAX_MESSAGES) history.shift();
  boundedMapSet(historyByConversation, conversationID, history, MAX_CURSOR_STORE_ENTRIES);
  persistConversationHistory(conversationID, history);
}

