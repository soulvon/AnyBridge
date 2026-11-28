// antigravity-handler.js — Google Antigravity (v1internal) 专有协议适配器
//
// 核心设计与防卡死架构：
// 1. 100% 对齐 Antigravity Protobuf JSON 规范（FetchAvailableModelsResponse）；
// 2. 彻底移除伪造的 cloudaicompanionProject，提供合规稳定的握手响应；
// 3. Singleflight 防抖缓存机制 + 按 Authorization 凭据分桶（防多账号串号）；
// 4. 官方转发逻辑下沉 ./antigravity/official-forwarder.js，目录组装下沉 ./antigravity/catalog-models.js。

import crypto from 'node:crypto';
import { configDir } from './config-dir.js';
import { boundedMapSet } from './http-retry.js';
import {
  buildAntigravityModelsListWithSlots,
  cleanAntigravityModelId,
  defaultOfficialModelsResponse,
  mergeAntigravityModelsResponseWithSlots,
  resolveAntigravityCustomModelWithSlots,
} from './antigravity/catalog-models.js';
import {
  OFFICIAL_ANTIGRAVITY_HOST,
  OFFICIAL_ANTIGRAVITY_HOSTS,
  OFFICIAL_ATTEMPT_TIMEOUT_MS,
  forwardToOfficialAntigravity,
  handshakeRetryDelay,
  normalizeOfficialRequestPayload,
  officialRequestOnce,
  parseOfficialModelsAttemptResult,
} from './antigravity/official-forwarder.js';
import {
  ensureAntigravityAdminControls,
  ensureAntigravityExperiments,
  ensureAntigravityTier,
  fetchOfficialAntigravityJsonImpl,
  fetchOfficialAntigravityRawImpl,
  isAntigravityBypassMetricsPath,
  mockAntigravityAdminControls,
  mockAntigravityListExperiments,
  mockAntigravityUserInfo,
  mockAntigravityUserQuotaSummary,
  mockAntigravityUserSettings,
  resolveAntigravityQuotaPolicy,
} from './antigravity/mocks-and-handshake.js';

export {
  OFFICIAL_ANTIGRAVITY_HOST,
  OFFICIAL_ANTIGRAVITY_HOSTS,
  OFFICIAL_ATTEMPT_TIMEOUT_MS,
  cleanAntigravityModelId,
  defaultOfficialModelsResponse,
  ensureAntigravityAdminControls,
  ensureAntigravityExperiments,
  ensureAntigravityTier,
  forwardToOfficialAntigravity,
  isAntigravityBypassMetricsPath,
  mockAntigravityAdminControls,
  mockAntigravityListExperiments,
  mockAntigravityUserInfo,
  mockAntigravityUserQuotaSummary,
  mockAntigravityUserSettings,
  resolveAntigravityQuotaPolicy,
};

// Singleflight 状态管理与平滑短效缓存（杜绝 IDE 启动阶段的请求风暴与重复探测）
const inFlightPromises = new Map();
const responseSnapshotCache = new Map();

/**
 * 为 Antigravity 网关短效缓存生成账号/凭证分桶键：
 * 多账号切号（如 Kite）后必须按 Authorization 凭据隔离模型目录快照，
 * 禁止把上一个账号的 15~30s 缓存吐给新账号；统一取 sha256 短指纹不留明文。
 */
export function antigravityAuthScopeKey(req) {
  const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const normalized = typeof val === 'string' ? val.trim() : '';
  if (!normalized) return 'anon';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

const MAX_SNAPSHOT_CACHE_ENTRIES = 256;

export async function singleflight(key, ttlMs, taskFn) {
  const now = Date.now();
  const cached = responseSnapshotCache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }
  if (inFlightPromises.has(key)) {
    return inFlightPromises.get(key);
  }
  const promise = (async () => {
    try {
      const data = await taskFn();
      if (data !== undefined && data !== null) {
        if (responseSnapshotCache.size >= MAX_SNAPSHOT_CACHE_ENTRIES) {
          const ts = Date.now();
          for (const [k, v] of responseSnapshotCache) {
            if (ts >= v.expiresAt) responseSnapshotCache.delete(k);
          }
        }
        boundedMapSet(responseSnapshotCache, key, { data, expiresAt: Date.now() + ttlMs }, MAX_SNAPSHOT_CACHE_ENTRIES);
      }
      return data;
    } finally {
      inFlightPromises.delete(key);
    }
  })();
  inFlightPromises.set(key, promise);
  return promise;
}

export function clearAntigravityCache() {
  responseSnapshotCache.clear();
  inFlightPromises.clear();
}

export function isAntigravityPath(pathname) {
  const p = String(pathname || '');
  return p.startsWith('/v1internal:')
    || p.startsWith('/v1internal/')
    || p.startsWith('/antigravity/v1internal:')
    || p.startsWith('/antigravity/v1internal/')
    || p === '/antigravity'
    || p.startsWith('/antigravity/');
}

export function getAntigravityMethod(pathname) {
  const p = String(pathname || '');
  const colonIndex = p.lastIndexOf(':');
  if (colonIndex !== -1) {
    const afterColon = p.slice(colonIndex + 1).split(/[?#/]/)[0];
    if (afterColon) return afterColon;
  }
  const m = p.match(/v1internal[:/]([^?#/]+)/);
  return m ? m[1] : '';
}

// BYOK 自定义模型可占用的运行枚举槽位。
// 槽位数必须 >= 用户配置的模型数，且全部存在于前端 Model enum 与 Go LS 中。
export const ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS = [
  'MODEL_CLAUDE_4_SONNET',
  'MODEL_CLAUDE_4_SONNET_THINKING',
  'MODEL_CLAUDE_4_OPUS',
  'MODEL_CLAUDE_4_OPUS_THINKING',
  'MODEL_CLAUDE_4_5_SONNET',
  'MODEL_CLAUDE_4_5_SONNET_THINKING',
  'MODEL_CLAUDE_4_5_HAIKU',
  'MODEL_CLAUDE_4_5_HAIKU_THINKING',
  'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
  'MODEL_GOOGLE_GEMINI_HORIZONDAWN',
  'MODEL_GOOGLE_GEMINI_PUREPRISM',
  'MODEL_GOOGLE_GEMINI_GENTLEISLAND',
  'MODEL_GOOGLE_GEMINI_RAINSONG',
  'MODEL_GOOGLE_GEMINI_ORIONFIRE',
  'MODEL_GOOGLE_GEMINI_COSMICFORGE',
  'MODEL_GOOGLE_GEMINI_RIFTRUNNER',
  'MODEL_GOOGLE_GEMINI_INFINITYJET',
  'MODEL_GOOGLE_GEMINI_INFINITYBLOOM',
];

export function resolveAntigravityCustomModel(modelId, providersJson = {}) {
  return resolveAntigravityCustomModelWithSlots(modelId, providersJson, ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS);
}

export function isAntigravityCustomModel(modelId, providersJson = {}) {
  return resolveAntigravityCustomModel(modelId, providersJson) !== null;
}

export function mergeAntigravityModelsResponse(officialResponse = {}, providersJson = {}) {
  return mergeAntigravityModelsResponseWithSlots(officialResponse, providersJson, ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS);
}

export function buildAntigravityModelsList(providersJson = {}) {
  return buildAntigravityModelsListWithSlots(providersJson, ANTIGRAVITY_SUPPORTED_RUNTIME_MODELS);
}

export function mergeAntigravityModelsList(baseModels = [], providersJson = {}) {
  return buildAntigravityModelsList(providersJson);
}

/**
 * 探测并拉取 Google 官方模型列表（带超时保护与单飞缓存）
 */
export async function fetchOfficialAntigravityModels(req, body) {
  return singleflight(`official_models_response:${antigravityAuthScopeKey(req)}`, 30000, async () => {
    const url = new URL(req.url, 'http://localhost');
    const payload = normalizeOfficialRequestPayload(body);
    const attempt = () => Promise.all(
      OFFICIAL_ANTIGRAVITY_HOSTS.map(host =>
        officialRequestOnce(host, req, payload, '/v1internal:fetchAvailableModels', url.search, 15000)
      )
    );
    const first = parseOfficialModelsAttemptResult(await attempt());
    if (first) return first;
    // 模型列表是 LS 启动的关键输入：瞬时抖动下补一轮，避免下拉空窗与模型丢失
    await handshakeRetryDelay();
    return parseOfficialModelsAttemptResult(await attempt());
  });
}

/**
 * 极其合规的 Mock 配额及服务能力（彻底移除毒丸项目字段，秒级返回，杜绝重试风暴）
 */
export function mockAntigravityLoadCodeAssist() {
  return {
    currentTier: {
      id: 'free-tier',
      name: 'Antigravity',
      isDefault: false,
    },
    paidTier: {
      id: 'free-tier',
      name: 'Antigravity',
      availableCredits: [
        {
          creditType: 'GOOGLE_ONE_AI',
          creditAmount: 1000000,
          minimumCreditAmountForUsage: 0,
        },
      ],
    },
    allowedTiers: [
      {
        id: 'free-tier',
        name: 'Free Tier',
        isDefault: true,
      },
      {
        id: 'free-tier',
        name: 'Antigravity',
      },
      {
        id: 'g1-ultra-tier',
        name: 'Antigravity',
      },
    ],
    cloudaicompanionProject: '',
  };
}

export async function fetchOfficialAntigravityRaw(req, body, pathname) {
  return fetchOfficialAntigravityRawImpl({
    req,
    body,
    pathname,
    officialHosts: OFFICIAL_ANTIGRAVITY_HOSTS,
    officialRequestOnce,
    handshakeRetryDelay,
    configDir,
  });
}

export async function fetchOfficialAntigravityJson(req, body, pathname) {
  return fetchOfficialAntigravityJsonImpl({
    req,
    body,
    pathname,
    officialHosts: OFFICIAL_ANTIGRAVITY_HOSTS,
    officialRequestOnce,
    handshakeRetryDelay,
  });
}
