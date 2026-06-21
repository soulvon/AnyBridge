// config-cache.js — 进程内缓存 providers.json / model-map.json，消除同步读盘抖动
//
// 设计目标：
//   1. loadProviders() / loadSlots() 在每个 GetChatMessage 上被多次调用，
//      原实现每次 readFileSync + JSON.parse，Windows 上单次 1-5ms，
//      高并发下直接成为瓶颈。
//   2. 文件变更时（GUI 改了配置）需要能感知。使用 mtime 检测，TTL 兜底。
//   3. 同时提供"轻量 invalidate"接口供写入方主动通知。
//
// 接口：
//   getProviders()  -> Map<id, provider>
//   getSlots()      -> Map<modelUid, {kind, data}>
//   getProxyRoutes()-> { fileExists, defaultModelId, routes }
//   invalidate('providers' | 'slots' | 'all')
//   markProvidersDirty()  // 写入方调用

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(os.homedir(), 'AppData', 'Roaming', name);
}

function positiveInt(value, fallback, min = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const PROVIDERS_PATH = () => path.join(configDir(), 'providers.json');
const SLOTS_PATH = () => path.join(configDir(), 'model-map.json');
const PROXY_ROUTES_PATH = () => path.join(configDir(), 'proxy-routes.json');

const TTL_MS = 2000; // 兜底 TTL：2s 内不重新读盘（即便 mtime 变化）

const cache = {
  providers: { mtimeMs: 0, data: null, loadedAt: 0, dirty: true },
  slots:     { mtimeMs: 0, data: null, loadedAt: 0, dirty: true },
  modelMap:  { mtimeMs: 0, data: null, loadedAt: 0, dirty: true },
  proxyRoutes: { mtimeMs: 0, data: null, loadedAt: 0, dirty: true },
};

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    return { stat, json: JSON.parse(raw) };
  } catch (e) {
    console.error(`[config-cache] failed to read ${file}: ${e.message}`);
    return null;
  }
}

function loadEntry(entry, file, transform) {
  const now = Date.now();
  if (!entry.dirty && (now - entry.loadedAt) < TTL_MS && entry.data) return entry.data;
  const r = readJsonSafe(file);
  if (!r) {
    entry.mtimeMs = 0;
    entry.loadedAt = now;
    entry.data = transform ? transform(null) : null;
    entry.dirty = false;
    return entry.data;
  }
  // mtime 命中 + 未过期 → 跳过 parse
  if (entry.data && r.stat.mtimeMs === entry.mtimeMs) {
    entry.loadedAt = now;
    entry.dirty = false;
    return entry.data;
  }
  entry.mtimeMs = r.stat.mtimeMs;
  entry.loadedAt = now;
  entry.data = transform ? transform(r.json) : r.json;
  entry.dirty = false;
  return entry.data;
}

function loadProxyRoutesEntry() {
  const entry = cache.proxyRoutes;
  const file = PROXY_ROUTES_PATH();
  const now = Date.now();
  if (!fs.existsSync(file)) {
    if (entry.mtimeMs !== 0 && entry.data?.fileExists) {
      console.info('[config-cache] proxy routes reloaded: file removed');
    }
    entry.mtimeMs = 0;
    entry.loadedAt = now;
    entry.data = transformProxyRoutes(null);
    entry.dirty = false;
    return entry.data;
  }
  try {
    const stat = fs.statSync(file);
    if (entry.data && stat.mtimeMs === entry.mtimeMs) {
      entry.loadedAt = now;
      entry.dirty = false;
      return entry.data;
    }
    const previousMtime = entry.mtimeMs;
    const raw = fs.readFileSync(file, 'utf8');
    entry.mtimeMs = stat.mtimeMs;
    entry.loadedAt = now;
    entry.data = transformProxyRoutes(JSON.parse(raw));
    entry.dirty = false;
    if (previousMtime !== stat.mtimeMs) {
      console.info('[config-cache] proxy routes reloaded');
    }
    return entry.data;
  } catch (e) {
    console.error(`[config-cache] failed to read ${file}: ${e.message}`);
    entry.loadedAt = now;
    entry.data = { fileExists: true, loadError: e.message || String(e), version: 1, defaultModelId: '', routes: [] };
    entry.dirty = false;
    return entry.data;
  }
}

function transformProviders(json) {
  const list = (json && Array.isArray(json.providers)) ? json.providers : [];
  const m = new Map();
  for (const p of list) {
    if (p && p.id) m.set(p.id, p);
  }
  return m;
}

function transformSlots(json) {
  const slots = (json && Array.isArray(json.slots)) ? json.slots : [];
  const injected = (json && Array.isArray(json.injected)) ? json.injected : [];
  const m = new Map();
  for (const s of slots) {
    if (s && s.modelUid) m.set(s.modelUid, { kind: 'slot', data: s });
  }
  for (const i of injected) {
    if (i && i.modelUid) m.set(i.modelUid, { kind: 'injected', data: i });
  }
  return m;
}

function transformModelMap(json) {
  const enhancement = (json && json.enhancement && typeof json.enhancement === 'object')
    ? json.enhancement
    : {};
  const visionModels = (json && json.visionModels && typeof json.visionModels === 'object')
    ? json.visionModels
    : {};
  return {
    enhancement: {
      retry: enhancement.retry !== false,
      retryMaxRetries: positiveInt(enhancement.retryMaxRetries, 5, 0),
      retryBaseMs: positiveInt(enhancement.retryBaseMs, 600, 1),
      retryCapMs: positiveInt(enhancement.retryCapMs, 8000, 1),
      retryTotalSeconds: positiveInt(enhancement.retryTotalSeconds, 60, 1),
      imageFallback: enhancement.imageFallback !== false,
      autoRouting: enhancement.autoRouting !== false,
      unlockModels: enhancement.unlockModels !== false,
    },
    visionModels: {
      imageModels: Array.isArray(visionModels.imageModels) ? visionModels.imageModels : [],
    },
  };
}

function normalizeProxyRouteTarget(target) {
  return {
    providerId: String(target?.providerId || target?.provider_id || '').trim(),
    model: String(target?.model || '').trim(),
    apiFormat: String(target?.apiFormat || target?.api_format || '').trim(),
    apiPath: String(target?.apiPath || target?.api_path || '').trim(),
    unlock: String(target?.unlock || '').trim(),
  };
}

function validateProxyRoutes(routes, defaultModelId) {
  const seen = new Set();
  for (const route of routes) {
    if (!route.id) throw new Error('本地代理模型路由 ID 不能为空');
    if (seen.has(route.id)) throw new Error(`本地代理模型路由 ID 重复: ${route.id}`);
    seen.add(route.id);
    if (!route.exposedFormats.length) throw new Error(`模型路由 ${route.id} 至少需要暴露一个入口`);
    for (const fmt of route.exposedFormats) {
      if (fmt !== 'openai' && fmt !== 'anthropic') {
        throw new Error(`模型路由 ${route.id} 的暴露入口必须是 openai 或 anthropic`);
      }
    }
    if (route.enabled !== false && !route.targets.length) {
      throw new Error(`模型路由 ${route.id} 已启用但没有目标`);
    }
    for (const target of route.targets) {
      if (!target.providerId) throw new Error(`模型路由 ${route.id} 的目标供应商不能为空`);
      if (!target.model) throw new Error(`模型路由 ${route.id} 的目标模型不能为空`);
      if (target.apiFormat !== 'openai' && target.apiFormat !== 'anthropic') {
        throw new Error(`模型路由 ${route.id} 的目标 apiFormat 必须是 openai 或 anthropic`);
      }
    }
  }
  if (defaultModelId && !routes.some(route => route.id === defaultModelId && route.enabled !== false)) {
    throw new Error(`默认模型路由不存在或未启用: ${defaultModelId}`);
  }
}

function transformProxyRoutes(json) {
  if (!json || typeof json !== 'object') {
    return { fileExists: false, version: 1, defaultModelId: '', routes: [] };
  }
  const defaultModelId = String(json.defaultModelId || '').trim();
  const routes = Array.isArray(json.routes) ? json.routes : [];
  const normalizedRoutes = routes.map(route => ({
    id: String(route?.id || '').trim(),
    displayName: String(route?.displayName || route?.display_name || '').trim(),
    enabled: route?.enabled !== false,
    exposedFormats: Array.isArray(route?.exposedFormats)
      ? route.exposedFormats.map(x => String(x || '').trim()).filter(Boolean)
      : ['openai', 'anthropic'],
    source: String(route?.source || 'manual').trim() || 'manual',
    capabilities: route?.capabilities && typeof route.capabilities === 'object' ? route.capabilities : {},
    enhancement: route?.enhancement && typeof route.enhancement === 'object' ? route.enhancement : {},
    targets: Array.isArray(route?.targets) ? route.targets.map(normalizeProxyRouteTarget) : [],
  }));
  validateProxyRoutes(normalizedRoutes, defaultModelId);
  return {
    fileExists: true,
    version: Number(json.version) || 1,
    defaultModelId,
    routes: normalizedRoutes,
  };
}

export function getProviders() {
  return loadEntry(cache.providers, PROVIDERS_PATH(), transformProviders);
}

export function getSlots() {
  return loadEntry(cache.slots, SLOTS_PATH(), transformSlots);
}

export function getModelMapConfig() {
  return loadEntry(cache.modelMap, SLOTS_PATH(), transformModelMap);
}

export function getProxyRoutes() {
  return loadProxyRoutesEntry();
}

export function invalidate(what = 'all') {
  if (what === 'all' || what === 'providers') cache.providers.dirty = true;
  if (what === 'all' || what === 'slots') {
    cache.slots.dirty = true;
    cache.modelMap.dirty = true;
  }
  if (what === 'all' || what === 'proxyRoutes') cache.proxyRoutes.dirty = true;
}

export function markProvidersDirty() { cache.providers.dirty = true; }
export function markSlotsDirty() {
  cache.slots.dirty = true;
  cache.modelMap.dirty = true;
}
export function markProxyRoutesDirty() { cache.proxyRoutes.dirty = true; }
