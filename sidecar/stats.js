// stats.js — In-memory runtime statistics for the BYOK dashboard.
// Reset on each proxy restart (daily counters keyed by date).

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const state = {
  startedAt: Date.now(),
  day: todayKey(),
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastProvider: null,
  lastModel: null,
  lastError: null,
  byModel: {},
  recent: [],
};

function rollDayIfNeeded() {
  const t = todayKey();
  if (t !== state.day) {
    state.day = t;
    state.requests = 0;
    state.errors = 0;
    state.inputTokens = 0;
    state.outputTokens = 0;
    state.byModel = {};
    state.recent = [];
    state.lastError = null;
  }
}

function pushRecent(entry) {
  state.recent.unshift({ ts: Date.now(), ...entry });
  if (state.recent.length > 20) state.recent.length = 20;
}

export function recordRequest({ provider, requestedModel, resolvedModel }) {
  rollDayIfNeeded();
  state.requests += 1;
  state.lastProvider = provider;
  state.lastModel = resolvedModel;
  const k = resolvedModel || 'unknown';
  state.byModel[k] = (state.byModel[k] || 0) + 1;
  pushRecent({ type: 'request', provider, requestedModel, resolvedModel });
}

export function recordUsage({ inputTokens = 0, outputTokens = 0 }) {
  rollDayIfNeeded();
  state.inputTokens += inputTokens;
  state.outputTokens += outputTokens;
}

export function recordError({ provider, message }) {
  rollDayIfNeeded();
  state.errors += 1;
  state.lastError = message;
  pushRecent({ type: 'error', provider, message });
}

export function snapshot() {
  rollDayIfNeeded();
  const totalTokens = state.inputTokens + state.outputTokens;
  // Rough cost estimate (USD): Anthropic Sonnet-ish blended rate.
  const estCost = (state.inputTokens * 3 + state.outputTokens * 15) / 1_000_000;
  return {
    startedAt: state.startedAt,
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    requests: state.requests,
    errors: state.errors,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens,
    estCostUsd: Number(estCost.toFixed(4)),
    lastProvider: state.lastProvider,
    lastModel: state.lastModel,
    lastError: state.lastError,
    byModel: state.byModel,
    recent: state.recent,
  };
}
