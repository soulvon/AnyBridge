#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const DEFAULT_SANDBOX_DIR = path.join(REPO_ROOT, 'tmp', 'ui-sandbox');

function dayKey(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildByokConfig(ports = {}) {
  const apiPort = Number(ports.apiPort) || 17450;
  const inferencePort = Number(ports.inferencePort) || 17451;
  const agHttpsPort = Number(ports.agHttpsPort) || 17452;
  return {
    values: {
      PROXY_PORT: String(apiPort),
      API_PORT: String(apiPort),
      INFERENCE_PORT: String(inferencePort),
      ANTIGRAVITY_HTTPS_PORT: String(agHttpsPort),
      LOCAL_PROXY_KEY: 'byok-sandbox-demo-key-2026',
      AUTO_START_PROXY: 'true',
      target_ide: 'windsurf',
      APP_LANGUAGE: 'zh-CN',
      THEME_MODE: 'system',
      PROXY_RETRY_ENABLED: 'true',
      PROXY_MAX_RETRIES: '2',
      PROXY_TIMEOUT_MS: '60000',
      SANDBOX_MODE: 'true',
    },
  };
}

function makeCatalog(items) {
  return items.map(([id, name, supportsToolCall, supportsImages, supportsReasoning, contextWindow]) => ({
    id, name, supportsToolCall, supportsImages, supportsReasoning, contextWindow,
    ownedBy: id.includes('/') ? id.split('/')[0] : 'sandbox',
  }));
}

function buildProvidersData(ports = {}) {
  const apiPort = Number(ports.apiPort) || 17450;
  const agHttpsPort = Number(ports.agHttpsPort) || 17452;
  const now = new Date().toISOString();
  const makeKeys = (pairs) => pairs.map(([id, label, key, enabled, weight]) => ({ id, label, key, enabled, weight, createdAt: now }));
  const makeUnlocks = (codex, claudeCode) => {
    const unlocks = {};
    if (codex) unlocks.codex = { enabled: true, unlockedAt: now, wireApi: '/responses' };
    if (claudeCode) unlocks.claudeCode = { enabled: true, unlockedAt: now, wireApi: '/messages' };
    return unlocks;
  };
  const makeProv = (spec) => ({
    ...spec,
    enabled: true,
    apiKey: spec.apiKeys[0].key,
    defaultModel: spec.models[0],
    createdAt: now,
    updatedAt: now,
  });

  const providers = [
    makeProv({
      id: 'prov-openai-direct', name: 'OpenAI 官方直连', apiFormat: 'openai',
      apiHost: 'https://api.openai.com', apiPath: '/v1/chat/completions', latencyMs: 186,
      apiKeys: makeKeys([['key-openai-1', '主力密钥', 'demo.openai.k01', true, 10], ['key-openai-2', '备用密钥', 'demo.openai.k02', true, 5]]),
      models: ['gpt-4.1', 'gpt-4o', 'o3', 'o4-mini'],
      modelCatalog: makeCatalog([['gpt-4.1', 'GPT-4.1', true, true, false, 1047576], ['gpt-4o', 'GPT-4o', true, true, false, 128000], ['o3', 'OpenAI o3', true, true, true, 200000], ['o4-mini', 'OpenAI o4-mini', true, true, true, 200000]]),
      balance: { ok: true, mode: 'usd', unit: 'USD', total: 120.0, used: 34.82, remaining: 85.18, unlimited: false, message: '$85.18 剩余' },
      unlocks: makeUnlocks(true, false),
    }),
    makeProv({
      id: 'prov-anthropic-claude', name: 'Anthropic Claude', apiFormat: 'anthropic',
      apiHost: 'https://api.anthropic.com', apiPath: '/v1/messages', latencyMs: 224,
      apiKeys: makeKeys([['key-claude-1', '生产环境', 'demo.claude.k01', true, 10], ['key-claude-2', '备援池', 'demo.claude.k02', true, 4]]),
      models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'],
      modelCatalog: makeCatalog([['claude-sonnet-4-20250514', 'Claude Sonnet 4', true, true, true, 200000], ['claude-opus-4-20250514', 'Claude Opus 4', true, true, true, 200000], ['claude-3-7-sonnet-20250219', 'Claude 3.7 Sonnet', true, true, true, 200000], ['claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', true, true, false, 200000]]),
      balance: { ok: true, mode: 'usd', unit: 'USD', total: 200.0, used: 62.45, remaining: 137.55, unlimited: false, message: '$137.55 剩余' },
      unlocks: makeUnlocks(false, true),
    }),
    makeProv({
      id: 'prov-google-vertex', name: 'Google Vertex Gemini', apiFormat: 'gemini',
      apiHost: 'https://generativelanguage.googleapis.com', apiPath: '/v1beta', latencyMs: 268,
      apiKeys: makeKeys([['key-vertex-1', '亚太配额', 'demo.vertex.k01', true, 10], ['key-vertex-2', '美西配额', 'demo.vertex.k02', false, 5]]),
      models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-thinking'],
      modelCatalog: makeCatalog([['gemini-2.5-pro', 'Gemini 2.5 Pro', true, true, true, 1000000], ['gemini-2.5-flash', 'Gemini 2.5 Flash', true, true, true, 1000000], ['gemini-2.0-flash-thinking', 'Gemini 2.0 Flash Thinking', true, true, true, 1000000]]),
      balance: { ok: true, mode: 'quota', unit: 'USD', total: 300.0, used: 41.1, remaining: 258.9, unlimited: false, message: '$258.90 赠金可用' },
      unlocks: makeUnlocks(false, false),
    }),
    makeProv({
      id: 'prov-deepseek-direct', name: 'DeepSeek 开放平台', apiFormat: 'openai',
      apiHost: 'https://api.deepseek.com', apiPath: '/v1/chat/completions', latencyMs: 142,
      apiKeys: makeKeys([['key-ds-1', '主账号', 'demo.deepseek.k01', true, 10], ['key-ds-2', '压测账号', 'demo.deepseek.k02', true, 3]]),
      models: ['deepseek-chat', 'deepseek-reasoner'],
      modelCatalog: makeCatalog([['deepseek-chat', 'DeepSeek V3 Chat', true, false, false, 128000], ['deepseek-reasoner', 'DeepSeek R1 Reasoner', true, false, true, 128000]]),
      balance: { ok: true, mode: 'cny', unit: 'CNY', total: 100.0, used: 18.6, remaining: 81.4, unlimited: false, message: '¥81.40 余额' },
      unlocks: makeUnlocks(true, true),
    }),
    makeProv({
      id: 'prov-openrouter-hub', name: 'OpenRouter 聚合路由', apiFormat: 'openai',
      apiHost: 'https://openrouter.ai/api', apiPath: '/v1/chat/completions', latencyMs: 312,
      apiKeys: makeKeys([['key-or-1', '聚合池 A', 'demo.openrouter.k01', true, 8]]),
      models: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1'],
      modelCatalog: makeCatalog([['anthropic/claude-sonnet-4', 'OR Claude Sonnet 4', true, true, true, 200000], ['openai/gpt-4.1', 'OR GPT-4.1', true, true, false, 1047576], ['google/gemini-2.5-pro', 'OR Gemini 2.5 Pro', true, true, true, 1000000], ['deepseek/deepseek-r1', 'OR DeepSeek R1', true, false, true, 128000]]),
      balance: { ok: true, mode: 'usd', unit: 'USD', total: 50.0, used: 12.35, remaining: 37.65, unlimited: false, message: '$37.65 Credits' },
      unlocks: makeUnlocks(true, true),
    }),
  ];

  return {
    providers,
    codexConfigs: [
      { id: 'codex-cfg-openai', name: 'Codex · OpenAI 主力', sourceProviderId: 'prov-openai-direct', model: 'o4-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'demo.openai.k01', reasoningEffort: 'high', approvalPolicy: 'on-request', sandboxMode: 'workspace-write', wireApi: 'responses' },
      { id: 'codex-cfg-deepseek', name: 'Codex · DeepSeek 推理', sourceProviderId: 'prov-deepseek-direct', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'demo.deepseek.k01', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandboxMode: 'workspace-write', wireApi: 'chat' },
    ],
    claudeCodeConfigs: [
      { id: 'cc-cfg-anthropic', name: 'Claude Code · 官方直连', sourceProviderId: 'prov-anthropic-claude', env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'demo.claude.k01', ANTHROPIC_MODEL: 'claude-sonnet-4-20250514', ANTHROPIC_SMALL_FAST_MODEL: 'claude-3-5-haiku-20241022' } },
      { id: 'cc-cfg-openrouter', name: 'Claude Code · 聚合备用', sourceProviderId: 'prov-openrouter-hub', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}/anthropic`, ANTHROPIC_AUTH_TOKEN: 'byok-sandbox-demo-key-2026', ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4', ANTHROPIC_SMALL_FAST_MODEL: 'openai/gpt-4.1' } },
    ],
    opencodeConfigs: [
      { id: 'oc-cfg-claude', name: 'OpenCode · Claude 工作流', sourceProviderId: 'prov-anthropic-claude', providerKey: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'demo.claude.k01', model: 'claude-sonnet-4-20250514' },
      { id: 'oc-cfg-deepseek', name: 'OpenCode · DeepSeek V3', sourceProviderId: 'prov-deepseek-direct', providerKey: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'demo.deepseek.k01', model: 'deepseek-chat' },
    ],
    antigravityConfigs: [
      { id: 'ag-cfg-vertex', name: 'Antigravity · Vertex Gemini', sourceProviderId: 'prov-google-vertex', endpoint: `http://127.0.0.1:${agHttpsPort}`, apiKey: 'demo.vertex.k01', model: 'gemini-2.5-pro' },
    ],
    grokConfigs: [
      { id: 'grok-cfg-openrouter', name: 'Grok CLI · 聚合通道', sourceProviderId: 'prov-openrouter-hub', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'demo.openrouter.k01', model: 'anthropic/claude-sonnet-4' },
    ],
    claudeDesktopConfigs: [
      { id: 'cd-cfg-claude', name: 'Claude Desktop · 网关接管', sourceProviderId: 'prov-anthropic-claude', apiFormat: 'anthropic', model: 'claude-sonnet-4-20250514' },
    ],
    antigravityMode: 'custom-gateway',
    platforms: {
      windsurf: { activeProviderId: 'prov-anthropic-claude' },
      cursor: { activeProviderId: 'prov-openai-direct' },
      codex: { activeProviderId: 'codex-cfg-openai' },
      'claude-code': { activeProviderId: 'cc-cfg-anthropic' },
      opencode: { activeProviderId: 'oc-cfg-claude' },
      'antigravity-ide': { activeProviderId: 'ag-cfg-vertex' },
    },
  };
}

function buildRoutesList() {
  const specs = [
    ['rt-claude-sonnet-4', 'claude-sonnet-4', 'Claude Sonnet 4', ['openai', 'anthropic'], { stream: true, tools: true, vision: true, reasoning: true }, 'prov-anthropic-claude', 'claude-sonnet-4-20250514'],
    ['rt-claude-opus-4', 'claude-opus-4', 'Claude Opus 4', ['openai', 'anthropic'], { stream: true, tools: true, vision: true, reasoning: true }, 'prov-anthropic-claude', 'claude-opus-4-20250514'],
    ['rt-gpt-4-1', 'gpt-4.1', 'GPT-4.1', ['openai'], { stream: true, tools: true, vision: true, reasoning: false }, 'prov-openai-direct', 'gpt-4.1'],
    ['rt-openai-o3', 'o3', 'OpenAI o3', ['openai'], { stream: true, tools: true, vision: true, reasoning: true }, 'prov-openai-direct', 'o3'],
    ['rt-openai-o4-mini', 'o4-mini', 'OpenAI o4-mini', ['openai'], { stream: true, tools: true, vision: true, reasoning: true }, 'prov-openai-direct', 'o4-mini'],
    ['rt-gemini-2-5-pro', 'gemini-2.5-pro', 'Gemini 2.5 Pro', ['openai', 'gemini'], { stream: true, tools: true, vision: true, reasoning: true }, 'prov-google-vertex', 'gemini-2.5-pro'],
    ['rt-deepseek-r1', 'deepseek-reasoner', 'DeepSeek R1', ['openai'], { stream: true, tools: true, vision: false, reasoning: true }, 'prov-deepseek-direct', 'deepseek-reasoner'],
    ['rt-or-sonnet', 'openrouter/claude-sonnet-4', 'OpenRouter Sonnet 4', ['openai', 'anthropic'], { stream: true, tools: true, vision: true, reasoning: true }, 'prov-openrouter-hub', 'anthropic/claude-sonnet-4'],
  ];
  return specs.map(([uid, id, displayName, exposedFormats, capabilities, providerId, model]) => ({
    uid, id, displayName, enabled: true, mode: 'auto', exposedFormats, capabilities,
    targets: [{ providerId, model, weight: 100, enabled: true }],
  }));
}

function buildModelMap() {
  return {
    slots: [
      { modelUid: 'MODEL_CLAUDE_4_OPUS', displayName: 'Claude Opus 4', enabled: true, supportsImages: true, useThirdPartyVision: false, contextWindow: 200000, targets: [{ providerId: 'prov-anthropic-claude', model: 'claude-opus-4-20250514', thinkingEffort: 'high' }] },
      { modelUid: 'MODEL_CLAUDE_3_7_SONNET', displayName: 'Claude 3.7 Sonnet', enabled: true, supportsImages: true, useThirdPartyVision: false, contextWindow: 200000, targets: [{ providerId: 'prov-anthropic-claude', model: 'claude-sonnet-4-20250514', thinkingEffort: 'medium' }] },
      { modelUid: 'MODEL_CLAUDE_3_5_SONNET', displayName: 'GPT-4.1 · Windsurf', enabled: true, supportsImages: true, useThirdPartyVision: false, contextWindow: 1047576, targets: [{ providerId: 'prov-openai-direct', model: 'gpt-4.1' }] },
      { modelUid: 'MODEL_PRIVATE_1', displayName: 'OpenAI o3 Reasoning', enabled: true, supportsImages: true, useThirdPartyVision: false, contextWindow: 200000, targets: [{ providerId: 'prov-openai-direct', model: 'o3', thinkingEffort: 'high' }] },
    ],
    injected: ['MODEL_CLAUDE_4_OPUS', 'MODEL_CLAUDE_3_7_SONNET', 'MODEL_CLAUDE_3_5_SONNET', 'MODEL_PRIVATE_1'],
    proxyRouteRenameRule: '{model}',
    enhancement: { thinkingInjection: true, streamFix: true, toolCallRepair: true },
    visionModels: ['gpt-4.1', 'claude-sonnet-4-20250514', 'gemini-2.5-pro'],
    searchModels: ['gemini-2.5-pro', 'o4-mini'],
    slotDisplayMode: 'compact', unlockScope: 'all', slotVisibilityMode: 'all', slotVisibility: {},
    namePrefix: '', labelTemplate: '', showSlotUid: true, showThinkingEffort: true, showContextWindow: true,
  };
}

function buildCursorModels(routes) {
  return {
    version: 1, revision: 'sandbox-rev-008', providerTagStyle: 'badge',
    providerBracketLeft: '[', providerBracketRight: ']', migrationVersion: 1, migrationNotice: null,
    models: routes.map((r, idx) => ({
      id: `cursor-${r.uid}`, routeUid: r.uid, displayName: r.displayName, exposedModelId: r.id,
      enabled: idx < 6, sortOrder: idx + 1, capabilityPolicy: 'auto', capabilityOverrides: {}, cursorOverrides: {},
      useThirdPartyVision: !r.capabilities.vision,
    })),
  };
}

function buildDailyHistory(daysCount = 30) {
  const models = [['claude-sonnet-4', 0.42], ['gpt-4.1', 0.24], ['gemini-2.5-pro', 0.16], ['deepseek-reasoner', 0.11], ['o4-mini', 0.07]];
  const days = [];
  for (let ago = daysCount - 1; ago >= 0; ago--) {
    const day = dayKey(ago);
    const wave = Math.sin((daysCount - ago) * 0.45) * 28 + Math.cos((daysCount - ago) * 0.2) * 14;
    const requests = Math.max(24, Math.round((86 + wave) * ((daysCount - ago) % 7 === 0 ? 0.72 : 1.05)));
    const errors = Math.max(0, Math.round(requests * (ago % 5 === 0 ? 0.04 : 0.015)));
    const inputTokens = requests * (1420 + (ago % 4) * 180);
    const outputTokens = requests * (580 + (ago % 3) * 95);
    const cachedTokens = Math.round(inputTokens * 0.34);
    const estCostUsd = Number(((inputTokens * 2.5 + outputTokens * 9.5) / 1_000_000).toFixed(4));
    const byModel = {};
    const byModelUsage = {};
    for (const [m, share] of models) {
      const mReq = Math.max(1, Math.round(requests * share));
      const mIn = Math.round(inputTokens * share);
      const mOut = Math.round(outputTokens * share);
      const mCache = Math.round(mIn * 0.3);
      byModel[m] = mReq;
      byModelUsage[m] = {
        requests: mReq, errors: m === 'deepseek-reasoner' && errors > 0 ? 1 : 0,
        input: mIn, output: mOut, cache_read: mCache, cache_write: Math.round(mCache * 0.15),
        inputTokens: mIn, outputTokens: mOut, cachedTokens: mCache, totalTokens: mIn + mOut,
        estCostUsd: Number((estCostUsd * share).toFixed(4)),
      };
    }
    days.push({
      day, date: day, requests, errors, inputTokens, outputTokens, cachedTokens,
      cacheCreationInputTokens: Math.round(cachedTokens * 0.18),
      totalTokens: inputTokens + outputTokens, estCostUsd, byModel, byModelUsage,
    });
  }
  return days;
}

function buildRecentEvents() {
  const templates = [
    ['claude-sonnet-4', 'Anthropic Claude', '/v1/messages', 200, 1240, 310, 2150, 780, 0, null],
    ['gpt-4.1', 'OpenAI 官方直连', '/v1/chat/completions', 200, 920, 220, 1840, 560, 0, null],
    ['gemini-2.5-pro', 'Google Vertex Gemini', '/v1beta/models/gemini-2.5-pro:streamGenerateContent', 200, 1580, 390, 3120, 940, 1, 'upstream 429 rate-limit'],
    ['deepseek-reasoner', 'DeepSeek 开放平台', '/v1/chat/completions', 200, 2680, 640, 1620, 1480, 0, null],
    ['o4-mini', 'OpenAI 官方直连', '/v1/responses', 200, 1340, 350, 1980, 720, 0, null],
    ['claude-opus-4', 'Anthropic Claude', '/v1/messages', 200, 1960, 420, 2890, 1120, 1, 'transient socket reset'],
    ['gpt-4.1', 'OpenAI 官方直连', '/v1/chat/completions', 502, 420, 0, 680, 0, 2, 'upstream 502 bad gateway'],
    ['openrouter/claude-sonnet-4', 'OpenRouter 聚合路由', '/v1/chat/completions', 200, 1480, 360, 2040, 810, 0, null],
    ['deepseek-reasoner', 'DeepSeek 开放平台', '/v1/chat/completions', 200, 2210, 520, 1510, 1290, 0, null],
  ];
  const now = Date.now();
  return Array.from({ length: 18 }, (_, i) => {
    const t = templates[i % templates.length];
    const ts = now - i * 48_000;
    const cacheRead = Math.round(t[6] * 0.35);
    const dur = t[4] + (i % 3) * 45;
    const type = t[3] >= 400 ? 'error' : (t[8] > 0 ? 'retry' : 'ok');
    return {
      id: `req-sb-${18 - i}`, ts, time: new Date(ts).toISOString(), type,
      model: t[0], resolvedModel: t[0], requestedModel: t[0], provider: t[1], path: t[2],
      status: t[3], ok: t[3] < 400, durationMs: dur, latencyMs: dur, ttftMs: t[5],
      inputTokens: t[6], outputTokens: t[7], cachedTokens: cacheRead,
      tokens: { input: t[6], output: t[7], cacheRead, cacheWrite: 0 },
      retries: t[8], count: t[8], reason: t[9], retryReason: t[9], message: t[9],
      error: t[3] >= 400 ? t[9] : null, visionFallback: i === 4,
    };
  });
}

function buildLocalUsage(days) {
  const splitSource = (list, factor, toolPrefix) => {
    const bucket = {};
    const summary = { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
    for (const d of list) {
      const requests = Math.max(1, Math.round(d.requests * factor));
      const input = Math.round(d.inputTokens * factor);
      const output = Math.round(d.outputTokens * factor);
      const cacheRead = Math.round(d.cachedTokens * factor);
      const cacheWrite = Math.round(cacheRead * 0.15);
      summary.requests += requests; summary.input += input; summary.output += output;
      summary.cache_read += cacheRead; summary.cache_write += cacheWrite;
      bucket[d.day] = { [`${toolPrefix}-default`]: { requests, input, output, cacheRead, cacheWrite, cache_read: cacheRead, cache_write: cacheWrite } };
    }
    return { bucket, summary };
  };
  const cc = splitSource(days, 0.38, 'claude-code');
  const cur = splitSource(days, 0.27, 'cursor');
  const cpa = splitSource(days, 0.16, 'cpa');
  const pi = splitSource(days.slice(-14), 0.08, 'pi');
  const zc = splitSource(days.slice(-14), 0.11, 'zcode');
  return {
    version: 2, scannedAt: Date.now(),
    days: cc.bucket, cursorDays: cur.bucket, cpaDays: cpa.bucket,
    cpaAccounts: [
      { account: 'sandbox-pro@demo.local', provider: 'antigravity', requests: 184, failed: 2, input: 428000, output: 194000, cacheRead: 98000, cacheWrite: 12000, cache_read: 98000, cache_write: 12000 },
      { account: 'sandbox-team@demo.local', provider: 'codex', requests: 96, failed: 1, input: 215000, output: 88000, cacheRead: 42000, cacheWrite: 6400, cache_read: 42000, cache_write: 6400 },
    ],
    piDays: pi.bucket, zcodeDays: zc.bucket, overlapped: 18, files: 42, errors: [],
    sources: { 'claude-code': cc.summary, cursor: cur.summary, cpa: cpa.summary, pi: pi.summary, zcode: zc.summary },
  };
}

function buildPlatformsMock(sandboxDir) {
  const now = new Date().toISOString();
  const rows = [
    ['antigravity-ide', 'Antigravity IDE', 'Google', 'gemini', true, 'antigravity/settings.json', 'ag-cfg-vertex', 'Antigravity · Vertex Gemini', '1.104.0', null, true],
    ['windsurf', 'Windsurf', 'Codeium', 'openai', true, 'windsurf/argv.json', 'prov-anthropic-claude', 'Anthropic Claude', '1.9.2', null, true],
    ['cursor', 'Cursor', 'Anysphere', 'openai', true, 'cursor/settings.json', 'prov-openai-direct', 'OpenAI 官方直连', '0.49.6', null, true],
    ['codex', 'OpenAI Codex CLI', 'OpenAI', 'openai', true, 'codex/config.toml', 'codex-cfg-openai', 'Codex · OpenAI 主力', '0.38.0', '@openai/codex', true],
    ['claude-code', 'Claude Code', 'Anthropic', 'anthropic', true, 'claude-code/settings.json', 'cc-cfg-anthropic', 'Claude Code · 官方直连', '1.0.32', '@anthropic-ai/claude-code', true],
    ['codebuddy', 'CodeBuddy', 'Tencent', 'openai', true, 'codebuddy/models.json', 'prov-deepseek-direct', 'DeepSeek 开放平台', '2.1.4', null, true],
    ['opencode', 'OpenCode', 'SST', 'openai', true, 'opencode/opencode.json', 'oc-cfg-claude', 'OpenCode · Claude 工作流', '0.4.12', 'opencode-ai', true],
    ['claude-desktop', 'Claude Desktop', 'Anthropic', 'anthropic', true, 'claude-desktop/claude_desktop_config.json', 'cd-cfg-claude', 'Claude Desktop · 网关接管', '0.9.3', null, false],
    ['pi', 'Pi Coding Agent', 'Pi', 'openai', true, 'pi/models.json', null, null, '0.19.1', '@mariozechner/pi-coding-agent', true],
    ['hermes', 'Hermes Agent', 'NousResearch', 'openai', false, 'hermes/config.yaml', null, null, null, null, true],
    ['deepseek-harness', 'DeepSeek Harness', 'DeepSeek', 'openai', true, 'dsh/settings.yaml', 'prov-deepseek-direct', 'DeepSeek 开放平台', '0.6.0', null, true],
    ['grok', 'Grok CLI', 'xAI', 'openai', false, 'grok/config.json', null, null, null, '@vibe-kit/grok-cli', true],
    ['gemini-cli', 'Gemini CLI', 'Google', 'gemini', true, 'gemini/settings.json', 'prov-google-vertex', 'Google Vertex Gemini', '0.5.2', '@google/gemini-cli', false],
  ];
  return rows.map(([id, displayName, vendor, requiredApiFormat, installed, sub, currentProviderId, currentProviderName, version, npmPackage, hasPage]) => ({
    id, displayName, vendor, requiredApiFormat, installed,
    configPath: path.join(sandboxDir, 'mock-platforms', sub),
    backupExists: Boolean(currentProviderId),
    currentProviderId, currentProviderName,
    managedByAnyBridge: Boolean(currentProviderId),
    appliedAt: currentProviderId ? now : null,
    liveProviderIds: currentProviderId ? [currentProviderId] : [],
    driftedFields: [], version, npm_package: npmPackage, hasPage,
  }));
}

function buildExtensionsMock(sandboxDir) {
  const cpaDir = path.join(sandboxDir, 'extensions', 'cpa-suite');
  return {
    cpaInstallDir: cpaDir, cpaAutoStart: false, cpaProxySettings: { mode: 'system', customUrl: '' },
    services: [{
      id: 'cpa-suite', name: 'CLIProxyAPI 扩展套件', status: 'running', installed: true, version: 'v6.8.14',
      installSource: 'managed', installDir: cpaDir,
      components: [
        { id: 'cli-proxy-api', name: 'CLIProxyAPI Core', status: 'running', port: 18317, version: 'v6.8.14', installDir: cpaDir, healthUrl: 'http://127.0.0.1:18317/health', httpStatus: 200, detail: '沙箱托管运行中' },
        { id: 'cpa-manager-plus', name: 'CPA Manager Plus', status: 'running', port: 18318, version: 'v2.4.0', installDir: cpaDir, healthUrl: 'http://127.0.0.1:18318/health', httpStatus: 200, detail: '管理面板就绪' },
      ],
      secrets: { apiKey: 'sb.cpa.k01', adminKey: 'sb.admin.k01', managementKey: 'sb.mgmt.k01' },
      notes: ['沙箱预设状态，可执行启停或版本切换操作'],
    }],
    mirrors: [
      { id: 'ghfast', name: 'GHFast 镜像', url: 'https://ghfast.top', enabled: true, latencyMs: 68 },
      { id: 'github', name: 'GitHub 直连', url: 'https://github.com', enabled: true, latencyMs: 245 },
    ],
    pluginRuntimeStates: {
      jimeng2api: { installed: true, running: true, port: 18401, version: '1.4.2', health: 'healthy', installDir: path.join(sandboxDir, 'plugins', 'jimeng2api') },
      aistudio2api: { installed: true, running: false, port: 18402, version: '1.2.0', health: 'stopped', installDir: path.join(sandboxDir, 'plugins', 'aistudio2api') },
      grok2api: { installed: false, running: false, port: 18403, version: '0.9.5', health: 'not_installed', installDir: path.join(sandboxDir, 'plugins', 'grok2api') },
    },
  };
}

function buildEvalReports() {
  const now = Date.now();
  return [
    {
      id: 'eval-sb-01', createdAt: new Date(now - 3600_000).toISOString(),
      providerId: 'prov-anthropic-claude', providerName: 'Anthropic Claude', apiFormat: 'anthropic',
      model: 'claude-sonnet-4-20250514', reportedModel: 'claude-sonnet-4-20250514', mode: 'full',
      score: 96, riskLevel: 'low', verdict: '真机直连特征一致，工具调用与视觉理解均通过', caps: [],
      probes: [
        { id: 'identity', name: '模型身份探针', status: 'pass', score: 100, weight: 30, latencyMs: 312, summary: '响应指纹与声明模型一致', evidence: 'model=claude-sonnet-4-20250514' },
        { id: 'tools', name: 'Function Calling', status: 'pass', score: 95, weight: 35, latencyMs: 418, summary: '准确触发工具参数 Schema', evidence: 'tool_use ok' },
      ],
      capabilityChecks: [
        { key: 'stream', label: 'SSE 流式输出', status: 'pass', detail: '首字延迟 310ms', evidence: 'chunks=24' },
        { key: 'vision', label: '多模态图像理解', status: 'pass', detail: '准确识别测试像素图', evidence: 'match=100%' },
      ],
      protocolChecks: [{ key: 'anthropic-v1', label: 'Anthropic Messages v1', status: 'pass', detail: 'usage 与 stop_reason 规范' }],
      usage: { requestCount: 5, inputTokens: 1480, outputTokens: 612 },
      metrics: { modelRelation: 'exact', ttftMs: 310, tokensPerSecond: 68.4, throughputTokens: 612, generationMs: 8940, streamChunkCount: 42, avgLatencyMs: 365, latencyCv: 0.12 },
      durationMs: 4280,
    },
    {
      id: 'eval-sb-02', createdAt: new Date(now - 86400_000).toISOString(),
      providerId: 'prov-openai-direct', providerName: 'OpenAI 官方直连', apiFormat: 'openai',
      model: 'gpt-4.1', reportedModel: 'gpt-4.1-2025-04-14', mode: 'quick',
      score: 94, riskLevel: 'low', verdict: 'OpenAI ChatCompletions 协议完整，吞吐稳定', caps: [],
      probes: [{ id: 'identity', name: '模型身份探针', status: 'pass', score: 96, weight: 50, latencyMs: 228, summary: '版本后缀校验通过', evidence: 'gpt-4.1-2025-04-14' }],
      capabilityChecks: [{ key: 'tools', label: 'Tool Calls', status: 'pass', detail: '支持严格模式 JSON', evidence: 'strict=true' }],
      protocolChecks: [], usage: { requestCount: 3, inputTokens: 890, outputTokens: 320 },
      metrics: { modelRelation: 'exact', ttftMs: 220, tokensPerSecond: 82.1, throughputTokens: 320, generationMs: 3890, streamChunkCount: 28, avgLatencyMs: 254, latencyCv: 0.09 },
      durationMs: 2950,
    },
  ];
}

function buildHourlyToday() {
  return Array.from({ length: 24 }, (_, h) => {
    const req = h >= 8 && h <= 23 ? Math.round(6 + Math.sin((h - 8) * 0.42) * 8 + (h % 3) * 2) : (h % 2) + 1;
    return { hour: `${String(h).padStart(2, '0')}:00`, requests: req, errors: h === 14 ? 1 : 0, tokens: req * 1950 };
  });
}

function writeJson(filePath, data, force) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!force && fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
}

export function seedSandbox({ sandboxDir = DEFAULT_SANDBOX_DIR, reseed = false, ports = {} } = {}) {
  const absSandbox = path.resolve(sandboxDir);
  const configDir = path.join(absSandbox, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const resolvedPorts = {
    apiPort: Number(ports.apiPort) || 17450,
    inferencePort: Number(ports.inferencePort) || 17451,
    agHttpsPort: Number(ports.agHttpsPort) || 17452,
  };

  const providersData = buildProvidersData(resolvedPorts);
  const routes = buildRoutesList();
  const dailyHistory = buildDailyHistory(30);
  const recent = buildRecentEvents();
  const localUsage = buildLocalUsage(dailyHistory);
  const hourly = buildHourlyToday();
  const todayStats = dailyHistory[dailyHistory.length - 1];

  const sandboxMockState = {
    version: 1, seededAt: new Date().toISOString(),
    proxy: {
      running: true,
      target_ide: 'windsurf',
      api_port: resolvedPorts.apiPort,
      inference_port: resolvedPorts.inferencePort,
      https_port: resolvedPorts.agHttpsPort,
    },
    stats: {
      startedAt: Date.now() - 14400_000, uptimeSec: 14400,
      requests: todayStats.requests, errors: todayStats.errors,
      inputTokens: todayStats.inputTokens, outputTokens: todayStats.outputTokens,
      cachedTokens: todayStats.cachedTokens, cacheCreationInputTokens: todayStats.cacheCreationInputTokens,
      totalTokens: todayStats.totalTokens, estCostUsd: todayStats.estCostUsd,
      lastProvider: 'Anthropic Claude', lastModel: 'claude-sonnet-4', lastError: null,
      byModel: todayStats.byModel, byModelUsage: todayStats.byModelUsage, recent,
      retries: 4, lastRetries: 1, lastRetryReason: 'upstream 429 rate-limit (recovered)',
      upstreamAttempts: todayStats.requests + 4,
      visionFallback: { images: 14, apiCalls: 5, cacheHits: 9, failures: 0 },
      daily: dailyHistory, hourly,
      rate: { rpm: 6.4, tpm: 13840, avgLatencyMs: 1180, errorRate: 0.016, windowRequests: 19, windowErrors: 0, cachedTokens: todayStats.cachedTokens },
    },
    dailyHistory, hourlyToday: hourly, recentEvents: recent,
    platforms: buildPlatformsMock(absSandbox),
    extensions: buildExtensionsMock(absSandbox),
    evalReports: buildEvalReports(),
    statsSettings: { disabledSources: [], availableSources: ['gateway', 'claude-code', 'cursor', 'cpa', 'pi', 'zcode'] },
    managedModels: {
      codebuddy: { models: [{ id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'DeepSeek 开放平台', enabled: true }, { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'Anthropic Claude', enabled: true }], availableModels: ['deepseek-chat', 'deepseek-reasoner', 'claude-sonnet-4', 'gpt-4.1'], _configPath: path.join(absSandbox, 'mock-platforms', 'codebuddy', 'models.json'), _configScope: 'user' },
      pi: { models: [{ id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI 官方直连', enabled: true }], availableModels: ['gpt-4.1', 'o4-mini', 'claude-sonnet-4'], _configPath: path.join(absSandbox, 'mock-platforms', 'pi', 'models.json'), _configScope: 'user' },
      hermes: { models: [{ id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'DeepSeek 开放平台', enabled: true }], availableModels: ['deepseek-reasoner', 'deepseek-chat'], _configPath: path.join(absSandbox, 'mock-platforms', 'hermes', 'config.yaml'), _configScope: 'user' },
      'deepseek-harness': { models: [{ id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'DeepSeek 开放平台', enabled: true }], availableModels: ['deepseek-chat', 'deepseek-reasoner'], _configPath: path.join(absSandbox, 'mock-platforms', 'dsh', 'settings.yaml'), _configScope: 'user' },
    },
    cursor: { running: true, controlPort: 17650, healthUrl: 'http://127.0.0.1:17650/health', certificateReady: true, certificateMessage: '沙箱根证书已受信任 (Local Dev CA)' },
    claudeDesktop: {
      supported: true, installed: true, managedByAnyBridge: true, deploymentMode: 'gateway',
      gatewayUrl: `http://127.0.0.1:${resolvedPorts.apiPort}/anthropic`, hasGatewayKey: true,
      normalConfigPath: path.join(absSandbox, 'mock-platforms', 'claude-desktop', 'claude_desktop_config.json'),
      threepConfigPath: path.join(absSandbox, 'mock-platforms', 'claude-desktop', 'claude_desktop_3p.json'),
      profilePath: path.join(absSandbox, 'mock-platforms', 'claude-desktop', 'profile.json'),
      metaPath: path.join(absSandbox, 'mock-platforms', 'claude-desktop', 'meta.json'),
      appliedProfileId: 'cd-cfg-claude', currentProviderId: 'prov-anthropic-claude',
      bindings: [{ slot: 'default', providerId: 'prov-anthropic-claude', model: 'claude-sonnet-4-20250514' }],
      proxyRunning: true,
    },
    localization: { antigravityApplied: false, appApplied: true, cdpApplied: false, latestVersion: '1.104.0' },
    certs: { installed: true, trusted: true, legacyCount: 0, certDir: path.join(absSandbox, 'certs') },
  };

  const files = {
    'byok-config.json': buildByokConfig(resolvedPorts),
    'providers.json': providersData,
    'proxy-routes.json': { version: 2, defaultModelId: 'claude-sonnet-4', routes, claudeDesktop: { enabled: true } },
    'codex-proxy-routes.json': { version: 2, defaultModelId: 'o4-mini', routes },
    'model-map.json': buildModelMap(),
    'cursor-models.json': buildCursorModels(routes),
    'ide-models.json': {
      source: 'captured', captured_at: Date.now() - 120_000,
      account: { email: 'sandbox-demo@anybridge.local', plan_name: 'Pro Sandbox', teams_tier: 'pro', daily_remaining: 480, weekly_remaining: 2400, overage_balance_micros: 0 },
      models: [
        { id: 'MODEL_CLAUDE_4_OPUS', name: 'Claude Opus 4', provider: 'Anthropic', common: true, origin: 'official', api_id: 'claude-opus-4' },
        { id: 'MODEL_CLAUDE_3_7_SONNET', name: 'Claude 3.7 Sonnet', provider: 'Anthropic', common: true, origin: 'official', api_id: 'claude-sonnet-4' },
        { id: 'MODEL_CLAUDE_3_5_SONNET', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', common: true, origin: 'official', api_id: 'gpt-4.1' },
        { id: 'MODEL_PRIVATE_1', name: 'Claude 4.5 Opus', provider: 'Private', common: true, origin: 'byok', api_id: 'o3' },
        { id: 'MODEL_PRIVATE_11', name: 'Claude Haiku 4.5', provider: 'Private', common: false, origin: 'byok', api_id: 'gemini-2.5-pro' },
      ],
    },
    'usage-local.json': localUsage,
    'anybridge-takeover-state.json': { proxyStartedAt: Date.now() - 3600_000, lastIdeRequestAt: Date.now() - 25_000, lastCaptureAt: Date.now() - 120_000, captureSource: 'windsurf-sandbox', captureHost: `127.0.0.1:${resolvedPorts.agHttpsPort}` },
    'update_settings.json': { autoCheck: false, channel: 'stable', ignoredVersion: null, lastCheckAt: null },
    'sandbox-mock-state.json': sandboxMockState,
  };

  let written = 0;
  for (const [name, payload] of Object.entries(files)) {
    if (writeJson(path.join(configDir, name), payload, reseed)) written++;
  }
  return { sandboxDir: absSandbox, configDir, written, fileCount: Object.keys(files).length };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  const args = process.argv.slice(2);
  let sandboxDir = DEFAULT_SANDBOX_DIR;
  const reseed = args.includes('--reseed');
  const idx = args.indexOf('--sandbox-dir');
  if (idx >= 0 && args[idx + 1]) sandboxDir = path.resolve(args[idx + 1]);
  const res = seedSandbox({ sandboxDir, reseed });
  console.log(`[seed-sandbox] dir=${res.configDir} total=${res.fileCount} written=${res.written} reseed=${reseed}`);
}
